import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { anon } from '../core/text.ts';
import type { NormalizedEvent, Root } from '../core/types.ts';
import { modelFromLines } from './model.ts';
import { parseLine } from './parser.ts';
import { listSubagentTranscripts, listWorkflowRuns, subagentDir } from './subagent-files.ts';
import { readLinesLazy } from './tailer.ts';

/**
 * How much of each file the caller already holds: key → highest `seq` applied, where the key
 * is a subagent's `agentId` and `''` is the parent transcript. A file named here is replayed
 * from the line AFTER its mark; a file absent from the map is replayed whole, which is what
 * makes a subagent born during an outage arrive complete.
 */
export type ReplayMarks = ReadonlyMap<string, number>;

/**
 * Replay a session: read its `.jsonl` from the start to EOF, then each
 * `subagents/agent-*.jsonl` child (events tagged with the child's agentId) and
 * each `agent-*.meta.json` sidecar (as a `subagent-meta` event), yielding every
 * normalized event in file order. Read-only. Produces the SAME event set as the
 * live watcher for the same session, so replay and live reconstruct an identical
 * tree. Per-file `seq` matches the watcher's, keeping (sessionId, seq) an exact
 * dedup key for the replay→live handoff.
 *
 * With `marks` it becomes a RESYNC: only what the caller is missing is yielded (see
 * {@link ReplayMarks}). Skipped lines still consume their index — `seq` is a position in the
 * file, and a tail numbered any other way would corrupt the very high-water it is answering.
 *
 * Reads the parent transcript lazily line by line so the whole file is never held in memory
 * at once, giving the consumer (the `/api/replay` pull-based stream) true backpressure: the
 * server reads the next line only when the client is ready.
 */
export async function* streamReplay(
  path: string,
  ctx: { sessionId: string; root: Root },
  marks?: ReplayMarks,
): AsyncGenerator<NormalizedEvent> {
  yield* replayFile(path, ctx.sessionId, null, ctx.root, markFor(marks, ''));

  // Where the children live is defined once, in subagent-files.ts. A Workflow run's subagents sit
  // one level deeper and are aggregated into their run's row; mirrors the watcher's live scan, so
  // replay and live agree.
  const subDir = subagentDir(path);
  const children = await listSubagentTranscripts(path);
  // Runs come from the DIRECTORY, not from `children`: a run's journal — the only record that a
  // workflow subagent started or stopped — exists before its agents' transcripts do, so deriving
  // the run list from the transcripts drops a run's lifecycle for as long as it has none.
  const runIds = await listWorkflowRuns(path);
  if (children.length === 0 && runIds.length === 0) return;
  for (const runId of runIds) yield* replayRun(join(subDir, 'workflows', runId), runId, ctx, marks);
  for (const child of children) {
    if (child.runId !== null) continue; // already replayed with its run, above
    const agentId = child.agentId;
    const mark = markFor(marks, agentId);
    // Collect the child's lines to extract the model — modelFromLines needs a full scan.
    // Child files are individual agent transcripts (much smaller than the parent); the
    // memory cost here is proportional to the child, not the whole session.
    const lines: string[] = [];
    for await (const line of readLinesLazy(child.path)) lines.push(line);
    // One subagent-meta carries the sidecar link + the child's model together —
    // in replay both are known up-front, so a single event suffices (the reducer
    // merges non-destructively, matching the live path's two-event merge).
    // Sent even to a caller that already has this child's lines, and a mark cannot say
    // otherwise: live emits this meta in two INDEPENDENT halves, the sidecar link (retried
    // until the file exists) and the model (the first tick one appears), so a half emitted
    // during an outage is lost with no second chance — a subagent left with `toolUseId` null
    // never links back to its Agent spawn. The merge makes the re-send idempotent.
    let toolUseId: string | null = null,
      agentType: string | null = null,
      spawnDepth: number | null = null,
      description: string | null = null;
    try {
      const d = JSON.parse(await readFile(join(subDir, `agent-${agentId}.meta.json`), 'utf8'));
      if (typeof d.toolUseId === 'string') toolUseId = d.toolUseId;
      if (typeof d.agentType === 'string') agentType = d.agentType;
      if (typeof d.spawnDepth === 'number') spawnDepth = d.spawnDepth;
      // The launch, as the agent's own sidecar records it. Redundant for a spawned subagent (the
      // parent's `Agent` block says the same and stays authoritative) and the ONLY name a forked
      // skill has when its launch line is not in view.
      if (typeof d.description === 'string') description = anon(d.description, 200);
    } catch {
      /* no sidecar — model-only meta still emitted below */
    }
    yield {
      type: 'subagent-meta',
      sessionId: ctx.sessionId,
      root: ctx.root,
      timestamp: '',
      seq: -1,
      agentId,
      toolUseId,
      agentType,
      spawnDepth,
      description,
      model: modelFromLines(lines),
    };
    let seq = 0;
    for (const line of lines) {
      if (mark !== null && seq <= mark) {
        seq++;
        continue;
      }
      for (const ev of parseLine(line, { sessionId: ctx.sessionId, root: ctx.root, seq, agentId })) yield ev;
      seq++;
    }
  }
}

/** The caller's high-water for one file, or null when it holds nothing of it. */
function markFor(marks: ReplayMarks | undefined, key: string): number | null {
  const m = marks?.get(key);
  return typeof m === 'number' ? m : null;
}

// One Workflow run: membership + the journal's start/return records, then each subagent's
// transcript (tagged with its agentId, so its usage folds into the run's aggregate).
async function* replayRun(
  runDir: string,
  runId: string,
  ctx: { sessionId: string; root: Root },
  marks?: ReplayMarks,
): AsyncGenerator<NormalizedEvent> {
  let files: string[] = [];
  try {
    files = await readdir(runDir);
  } catch {
    return;
  }
  const base = { sessionId: ctx.sessionId, root: ctx.root, timestamp: '', seq: -1 } as const;
  // The journal's records are out-of-band (seq -1), so no high-water can filter them and a
  // resync must decide per RECORD. `started` is an immutable fact a caller with lines already
  // holds — re-announcing it would re-play the run's lifecycle. `result` is not: the journal is
  // the only thing that says a workflow subagent stopped, and it can be written DURING the
  // outage, so suppressing it left that agent running forever in the tab. The reducer keeps
  // these in Sets, which makes the re-send idempotent. Read once, filtered per agent.
  for await (const line of readLinesLazy(join(runDir, 'journal.jsonl'))) {
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof d?.agentId !== 'string' || (d.type !== 'started' && d.type !== 'result')) continue;
    if (d.type === 'started' && markFor(marks, d.agentId) !== null) continue;
    yield { type: 'workflow-agent', ...base, agentId: d.agentId, runId, phase: d.type };
  }
  for (const f of files) {
    const m = /^agent-(.+)\.jsonl$/.exec(f);
    if (!m) continue;
    const agentId = m[1]!;
    const mark = markFor(marks, agentId);
    const lines: string[] = [];
    for await (const line of readLinesLazy(join(runDir, f))) lines.push(line);
    // Membership is immutable — a caller holding this child's lines was told it. Its model is
    // not: live emits that the first tick one appears, which can fall inside the outage.
    if (mark === null) yield { type: 'workflow-agent', ...base, agentId, runId, phase: 'seen' };
    yield {
      type: 'subagent-meta',
      ...base,
      agentId,
      toolUseId: null,
      agentType: null,
      spawnDepth: null,
      model: modelFromLines(lines),
    };
    let seq = 0;
    for (const line of lines) {
      if (mark !== null && seq <= mark) {
        seq++;
        continue;
      }
      for (const ev of parseLine(line, { sessionId: ctx.sessionId, root: ctx.root, seq, agentId })) yield ev;
      seq++;
    }
  }
}

async function* replayFile(
  path: string,
  sessionId: string,
  agentId: string | null,
  root: Root,
  mark: number | null,
): AsyncGenerator<NormalizedEvent> {
  let seq = 0;
  for await (const line of readLinesLazy(path)) {
    if (mark !== null && seq <= mark) {
      seq++;
      continue;
    }
    for (const ev of parseLine(line, { sessionId, root, seq, agentId })) yield ev;
    seq++;
  }
}
