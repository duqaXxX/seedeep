import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

// Where a session's subagent transcripts live on disk, in ONE place. Replay walks them to emit
// their events; the aggregate cache stamps them to know when a cached summary went stale. Two
// consumers, one definition of the layout — a second copy is how the two would come to disagree
// about what belongs to a session.

/** One subagent transcript belonging to a session. `runId` is set only for a Workflow run's
 * children, which sit one level deeper and are aggregated into their run's row. */
export interface SubagentTranscript {
  path: string;
  agentId: string;
  runId: string | null;
}

/** The directory holding a session's subagent transcripts: `<slug>/<uuid>/subagents/`, a sibling
 * of the parent jsonl rather than next to it. */
export function subagentDir(sessionPath: string): string {
  return join(dirname(sessionPath), basename(sessionPath, '.jsonl'), 'subagents');
}

/**
 * The Workflow run ids of a session, from the directory itself — NOT derived from the transcripts
 * found inside them. A run writes its `journal.jsonl` before (and independently of) its agents'
 * transcripts, and the journal is the only thing that says a workflow subagent started or stopped:
 * a run listed only by its agent files disappears from replay in the window before the first one
 * exists, taking its lifecycle events with it.
 */
export async function listWorkflowRuns(sessionPath: string): Promise<string[]> {
  try {
    return await readdir(join(subagentDir(sessionPath), 'workflows'));
  } catch {
    return [];
  }
}

/**
 * Every subagent transcript of a session, in the order replay applies them: each Workflow run's
 * children first, then the session's own `agent-*.jsonl`. Returns `[]` when the session has none
 * (the 86% case) or the directory is unreadable — a missing child dir is not an error.
 */
export async function listSubagentTranscripts(sessionPath: string): Promise<SubagentTranscript[]> {
  const dir = subagentDir(sessionPath);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const out: SubagentTranscript[] = [];
  let runs: string[] = [];
  try {
    runs = await readdir(join(dir, 'workflows'));
  } catch {
    /* no workflows */
  }
  for (const runId of runs) {
    let files: string[];
    try {
      files = await readdir(join(dir, 'workflows', runId));
    } catch {
      continue;
    }
    for (const f of files) {
      const m = /^agent-(.+)\.jsonl$/.exec(f);
      if (m) out.push({ path: join(dir, 'workflows', runId, f), agentId: m[1]!, runId });
    }
  }
  for (const f of entries) {
    const m = /^agent-(.+)\.jsonl$/.exec(f);
    if (m) out.push({ path: join(dir, f), agentId: m[1]!, runId: null });
  }
  return out;
}

/**
 * A stamp that changes whenever a session's subagent transcripts do: count, total size and the
 * newest mtime. `'0'` when there are none. The parent file's own (size, mtime) cannot stand in —
 * a child can be written when the parent is not, which would serve a cached summary missing that
 * child's tokens.
 */
export async function subagentStamp(sessionPath: string): Promise<string> {
  const files = await listSubagentTranscripts(sessionPath);
  if (files.length === 0) return '0';
  let size = 0;
  let newest = 0;
  for (const f of files) {
    try {
      const st = await stat(f.path);
      size += st.size;
      if (st.mtimeMs > newest) newest = st.mtimeMs;
    } catch {
      /* vanished mid-scan: the next refresh sees a different stamp and re-parses */
    }
  }
  return `${files.length}:${size}:${newest}`;
}
