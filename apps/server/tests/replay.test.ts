import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { NormalizedEvent } from '../src/core/types.ts';
import { streamReplay } from '../src/server/replay.ts';

function usageLine(fill: number): string {
  return (
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-11T00:00:00.000Z',
      message: {
        role: 'assistant',
        model: 'm',
        usage: { input_tokens: fill, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    }) + '\n'
  );
}

test('replay reads the parent AND its subagent children + meta', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-replay-'));
  const parent = join(dir, 'P.jsonl');
  writeFileSync(parent, usageLine(500));
  // Real layout: children live under <dir>/<uuid>/subagents/, not <dir>/subagents/.
  const subDir = join(dir, 'P', 'subagents');
  mkdirSync(subDir, { recursive: true });
  writeFileSync(join(subDir, 'agent-XYZ.jsonl'), usageLine(30));
  writeFileSync(
    join(subDir, 'agent-XYZ.meta.json'),
    JSON.stringify({ agentType: 'explore', toolUseId: 'toolu_1', spawnDepth: 1 }),
  );

  const got: NormalizedEvent[] = [];
  for await (const e of streamReplay(parent, { sessionId: 'P', root: 'cli' })) got.push(e);

  const mainUsage = got.find((e) => e.type === 'usage' && (e.agentId ?? null) === null);
  const subUsage = got.find((e) => e.type === 'usage' && e.agentId === 'XYZ');
  const meta = got.find((e) => e.type === 'subagent-meta' && e.agentId === 'XYZ');
  assert.equal((mainUsage as any)?.fill, 500);
  assert.equal((subUsage as any)?.fill, 30);
  assert.equal((meta as any)?.toolUseId, 'toolu_1');
  assert.equal((meta as any)?.model, 'm'); // extracted from the child jsonl
});

test("a forked skill's sidecar names what it was launched to do", async () => {
  // A forked skill (`/code-review`) has no `Agent` spawn anywhere, so the parent transcript carries
  // no description for it. Its sidecar does — the real one reads
  // {"agentType":"general-purpose","description":"/code-review del diff","name":"code-review"} —
  // and reading only `agentType` is what left the row saying `general-purpose`.
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-replay-'));
  const parent = join(dir, 'P.jsonl');
  writeFileSync(parent, usageLine(500));
  const subDir = join(dir, 'P', 'subagents');
  mkdirSync(subDir, { recursive: true });
  writeFileSync(join(subDir, 'agent-FK.jsonl'), usageLine(30));
  writeFileSync(
    join(subDir, 'agent-FK.meta.json'),
    JSON.stringify({ agentType: 'general-purpose', description: '/code-review del diff', name: 'code-review' }),
  );

  const got: NormalizedEvent[] = [];
  for await (const e of streamReplay(parent, { sessionId: 'P', root: 'cli' })) got.push(e);

  const meta = got.find((e) => e.type === 'subagent-meta' && e.agentId === 'FK');
  assert.equal((meta as any)?.description, '/code-review del diff');
  assert.equal((meta as any)?.agentType, 'general-purpose', 'the type is still reported — it is a different fact');
});

test('a workflow run with only a journal still reports its lifecycle', async () => {
  // A run writes its journal — the only record that a workflow subagent started or stopped — before
  // its agents' transcripts exist. Deriving the run list from the transcripts found inside it made
  // the run invisible for exactly that window, and its start/stop events were never emitted.
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-replay-journal-'));
  const parent = join(dir, 'P.jsonl');
  writeFileSync(parent, usageLine(10));
  const runDir = join(dir, 'P', 'subagents', 'workflows', 'run9');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, 'journal.jsonl'),
    JSON.stringify({ type: 'started', agentId: 'w1', key: 'k' }) +
      '\n' +
      JSON.stringify({ type: 'result', agentId: 'w1', key: 'k' }) +
      '\n',
  );

  const got: NormalizedEvent[] = [];
  for await (const e of streamReplay(parent, { sessionId: 'P', root: 'cli' })) got.push(e);
  const wf = got.filter((e) => e.type === 'workflow-agent') as any[];
  assert.deepEqual(
    wf.map((e) => [e.agentId, e.phase]),
    [
      ['w1', 'started'],
      ['w1', 'result'],
    ],
  );
  assert.equal(wf[0]!.runId, 'run9');
});

test('replay of a session with no children still works (parent only)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-replay-nochild-'));
  const parent = join(dir, 'P.jsonl');
  writeFileSync(parent, usageLine(100));
  const got: NormalizedEvent[] = [];
  for await (const e of streamReplay(parent, { sessionId: 'P', root: 'cli' })) got.push(e);
  assert.equal(got.filter((e) => e.type === 'usage').length, 1);
});

// A reconnect leaves a hole (nothing re-sends what was emitted while the connection
// was down). Re-reading the WHOLE file to close it costs a rebuild of the tab; the client
// knows exactly how far it got per file — `seq` is the line's POSITION — so it asks for the
// tail only. What must not change is the NUMBERING: a skipped line still consumes its index,
// or the tail arrives mislabelled and the client's high-water stops meaning anything.
test('a resync from a per-file mark emits only the tail, still numbered by line index', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-resync-'));
  const p = join(dir, 'S.jsonl');
  writeFileSync(p, [usageLine(1), usageLine(2), usageLine(3), usageLine(4)].join(''));
  const got: Array<{ seq: number; fill: number }> = [];
  for await (const e of streamReplay(p, { sessionId: 'S', root: 'cli' }, new Map([['', 1]]))) {
    if (e.type === 'usage') got.push({ seq: e.seq, fill: e.fill });
  } // the client already applied lines 0 and 1
  assert.deepEqual(got, [
    { seq: 2, fill: 3 },
    { seq: 3, fill: 4 },
  ]);
});

test('a resync with no mark for a file replays that file whole', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-resync2-'));
  const p = join(dir, 'S.jsonl');
  writeFileSync(p, [usageLine(1), usageLine(2)].join(''));
  const got: number[] = [];
  // A mark for some OTHER file must not silence this one — a subagent born during the
  // outage is exactly what the client has never seen.
  for await (const e of streamReplay(p, { sessionId: 'S', root: 'cli' }, new Map([['someChild', 5]]))) {
    if (e.type === 'usage') got.push(e.seq);
  }
  assert.deepEqual(got, [0, 1]);
});

// A mark says "I have this file's LINES up to here". It says nothing about the out-of-band
// events (seq -1), which no high-water can filter and which the live path emits from other
// sources entirely. Suppressing those on a resync is what turned an outage into a permanent
// wrong state: the two tests below each pin one of them.
test("a resync re-sends a known child's meta — the live path emits it in halves, either can be lost", async () => {
  // Live emits this meta TWICE and from two sources: the sidecar link (retried tick after
  // tick until the file exists) and the model (the first tick a model appears). A sidecar
  // that lands during the outage is emitted into a dead connection; skipping it on the
  // resync leaves `toolUseId` null for good, so `linkSpawn` never runs and that subagent
  // stays detached from its Agent spawn. The reducer merges non-destructively, so re-sending
  // is idempotent — cheaper than a hole that never closes.
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-resync-meta-'));
  const parent = join(dir, 'S.jsonl');
  writeFileSync(parent, usageLine(1));
  const subDir = join(dir, 'S', 'subagents');
  mkdirSync(subDir, { recursive: true });
  writeFileSync(join(subDir, 'agent-XYZ.jsonl'), [usageLine(2), usageLine(3)].join(''));
  writeFileSync(
    join(subDir, 'agent-XYZ.meta.json'),
    JSON.stringify({ agentType: 'explore', toolUseId: 'toolu_9', spawnDepth: 1 }),
  );

  const got: NormalizedEvent[] = [];
  for await (const e of streamReplay(
    parent,
    { sessionId: 'S', root: 'cli' },
    new Map([
      ['', 0],
      ['XYZ', 0],
    ]),
  ))
    got.push(e);

  const meta = got.find((e) => e.type === 'subagent-meta' && e.agentId === 'XYZ') as any;
  assert.ok(meta, 'the meta of a child the caller already has lines from is still sent');
  assert.equal(meta.toolUseId, 'toolu_9');
  assert.equal(meta.model, 'm');
  assert.deepEqual(
    got.filter((e) => e.type === 'usage' && e.agentId === 'XYZ').map((e) => e.seq),
    [1],
    'its LINES are still filtered by the mark — only the out-of-band meta is exempt',
  );
});

test("a resync re-sends a workflow agent's result, but not its start", async () => {
  // `started` is an immutable fact the caller already holds; `result` is the ONLY record that
  // says a workflow subagent stopped working, and it can be written DURING the outage. Filtering
  // both by the same mark left that agent running forever in the tab.
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-resync-wf-'));
  const parent = join(dir, 'S.jsonl');
  writeFileSync(parent, usageLine(1));
  const runDir = join(dir, 'S', 'subagents', 'workflows', 'run7');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, 'journal.jsonl'),
    [JSON.stringify({ type: 'started', agentId: 'w1' }), JSON.stringify({ type: 'result', agentId: 'w1' })].join('\n') +
      '\n',
  );
  writeFileSync(join(runDir, 'agent-w1.jsonl'), usageLine(4));

  const got: NormalizedEvent[] = [];
  for await (const e of streamReplay(
    parent,
    { sessionId: 'S', root: 'cli' },
    new Map([
      ['', 0],
      ['w1', 0],
    ]),
  ))
    got.push(e);

  const phases = got.filter((e) => e.type === 'workflow-agent' && e.agentId === 'w1').map((e: any) => e.phase);
  assert.deepEqual(phases, ['result'], 'the end is news; the start and the membership are not');
});

test('a full replay (no marks) is unchanged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-resync3-'));
  const p = join(dir, 'S.jsonl');
  writeFileSync(p, [usageLine(1), usageLine(2)].join(''));
  const got: number[] = [];
  for await (const e of streamReplay(p, { sessionId: 'S', root: 'cli' })) {
    if (e.type === 'usage') got.push(e.seq);
  }
  assert.deepEqual(got, [0, 1]);
});
