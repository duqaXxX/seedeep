import { expect, test } from 'bun:test';
import { activityMatches, flattenActivity } from '../src/core/activity-list.ts';
import { windowFor } from '../src/core/context-windows.ts';
import { createSessionTree } from '../src/core/session-tree.ts';
import { createSpanStore } from '../src/core/span-store.ts';
import type { NormalizedEvent } from '../src/core/types.ts';
import { parseLine } from '../src/server/parser.ts';

// Line builders — exact shapes verified in tests/golden-transcript.test.ts.
// Content is synthetic; only the shape is real.

const typed = (uuid: string, text: string, ts: string) =>
  JSON.stringify({
    type: 'user',
    uuid,
    timestamp: ts,
    origin: { kind: 'human' },
    promptSource: 'typed',
    message: { role: 'user', content: text },
  });

const toolUse = (uuid: string, id: string, name: string, ts: string) =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: ts,
    message: {
      role: 'assistant',
      model: 'claude-opus-4-8',
      content: [{ type: 'tool_use', id, name, input: { file_path: '/home/dev/x.ts' } }],
    },
  });

const toolResult = (uuid: string, toolUseId: string, ts: string) =>
  JSON.stringify({
    type: 'user',
    uuid,
    timestamp: ts,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] },
  });

// stop_reason 'end_turn' is what makes a text block the turn's RESULT rather than narration.
const finalText = (uuid: string, text: string, ts: string) =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: ts,
    message: {
      role: 'assistant',
      model: 'claude-opus-4-8',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text }],
    },
  });

/**
 * A session with one main-thread tool plus a Task spawn whose subagent runs two tools,
 * closed by a turn result and followed by a second prompt — the exact shape that put a
 * `done` and a next-turn prompt into the list.
 */
function buildStore() {
  const tree = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  const store = createSpanStore();
  tree.onEvent((e, ctx) => store.apply(e, ctx));

  let seq = 0;
  const feed = (line: string) => {
    for (const e of parseLine(line, {
      sessionId: 's1',
      root: 'cli' as const,
      seq: seq++,
      agentId: null,
    }) as NormalizedEvent[])
      tree.apply(e);
  };
  // Events whose agentId cannot be expressed as raw jsonl in this context go in directly.
  const applyEv = (e: object) => tree.apply({ ...e, seq: seq++ } as unknown as NormalizedEvent);

  feed(typed('u1', 'harden the retry path', '2026-07-14T10:00:00.000Z'));
  feed(toolUse('a1', 'tool_grep', 'Grep', '2026-07-14T10:00:01.000Z'));
  feed(toolResult('u2', 'tool_grep', '2026-07-14T10:00:03.000Z'));

  applyEv({
    type: 'tool-start',
    sessionId: 's1',
    root: 'cli',
    timestamp: '2026-07-14T10:00:04.000Z',
    id: 'task_001',
    name: 'Task',
    agentId: null,
  });
  applyEv({
    type: 'subagent-meta',
    sessionId: 's1',
    root: 'cli',
    timestamp: '2026-07-14T10:00:05.000Z',
    toolUseId: 'task_001',
    agentId: 'agent_abc',
    agentType: 'Explore',
    model: 'claude-sonnet-5',
  });
  applyEv({
    type: 'tool-start',
    sessionId: 's1',
    root: 'cli',
    timestamp: '2026-07-14T10:00:06.000Z',
    id: 'sub_read',
    name: 'Read',
    agentId: 'agent_abc',
  });
  applyEv({
    type: 'tool-end',
    sessionId: 's1',
    root: 'cli',
    timestamp: '2026-07-14T10:00:08.000Z',
    toolUseId: 'sub_read',
    agentId: 'agent_abc',
  });
  // Left open on purpose: a still-running subagent tool must survive the flatten.
  applyEv({
    type: 'tool-start',
    sessionId: 's1',
    root: 'cli',
    timestamp: '2026-07-14T10:00:09.000Z',
    id: 'sub_glob',
    name: 'Glob',
    agentId: 'agent_abc',
  });

  feed(finalText('a2', 'retries now back off', '2026-07-14T10:00:10.000Z'));
  feed(typed('u3', 'now add the jitter', '2026-07-14T10:05:00.000Z'));

  return store;
}

test('activity-list: subagent spans reach the list — they live only in spawn lanes', () => {
  const rows = flattenActivity(buildStore().snapshot());
  // The defect this guards: building the list from turn.spans alone drops every
  // subagent row silently, and the list still looks plausible.
  const sub = rows.filter((r) => r.lane > 0);
  expect(sub.map((r) => r.name).sort()).toEqual(['Glob', 'Read']);
  // ...and the main thread is still there alongside them.
  expect(rows.some((r) => r.name === 'Grep' && r.lane === 0)).toBe(true);
  expect(rows.some((r) => r.type === 'spawn' && r.lane === 0)).toBe(true);
});

test('activity-list: the list holds only what the live card shows — no prompt, no result', () => {
  const store = buildStore();
  // The subject must exist, or the assertions below pass vacuously: the store DOES keep
  // both spans (the Trace draws them) — it is the list that must not carry them.
  const mainSpans = store.snapshot().turns.flatMap((t) => t.spans);
  expect(mainSpans.some((s) => s.type === 'prompt')).toBe(true);
  expect(mainSpans.some((s) => s.type === 'result')).toBe(true);

  // The defect: the list is the Live activity card's `Expand all`, but it was
  // flattened from EVERY span, so a turn's prompt and its `done` showed up as activities
  // that were never in the feed — the next turn's prompt among them.
  // Spelled out, not read from the module's own constant: a test that asserts against the
  // set under test would go green again the moment someone widened that set.
  const rows = flattenActivity(store.snapshot());
  for (const r of rows) expect(['api', 'tool', 'subspan', 'spawn']).toContain(r.type);
  expect(rows.length).toBeGreaterThan(0);
});

test('activity-list: rows are chronological and a spawn precedes the children it created', () => {
  const rows = flattenActivity(buildStore().snapshot());
  for (let i = 1; i < rows.length; i++) expect(rows[i]!.t0).toBeGreaterThanOrEqual(rows[i - 1]!.t0);

  const spawnAt = rows.findIndex((r) => r.type === 'spawn');
  const firstChildAt = rows.findIndex((r) => r.lane > 0);
  expect(spawnAt).toBeGreaterThanOrEqual(0);
  expect(firstChildAt).toBeGreaterThan(spawnAt);
});

test('activity-list: a running span has no duration, a closed one has its real one', () => {
  const rows = flattenActivity(buildStore().snapshot());
  const read = rows.find((r) => r.name === 'Read')!;
  const glob = rows.find((r) => r.name === 'Glob')!;
  expect(read.status).toBe('ok');
  expect(read.ms).toBe(2000); // 10:00:06 → 10:00:08
  expect(glob.status).toBe('running');
  expect(glob.ms).toBeNull(); // t1 === t0 is "not closed", not a 0ms span
});

test('activity-list: the agent badge drops the model parenthetical, main rows carry none', () => {
  const rows = flattenActivity(buildStore().snapshot());
  expect(rows.find((r) => r.name === 'Read')!.agent).toBe('Explore');
  expect(rows.find((r) => r.name === 'Grep')!.agent).toBeNull();
});

test('activity-list: every row keeps a drawer handle, so no click is a dead end', () => {
  const rows = flattenActivity(buildStore().snapshot());
  const tools = rows.filter((r) => r.type === 'tool' || r.type === 'subspan' || r.type === 'spawn');
  expect(tools.length).toBeGreaterThan(0);
  for (const r of tools) expect(r.handle).toBeTruthy();
});

test('activity-list: the filter matches on name and on detail', () => {
  const rows = flattenActivity(buildStore().snapshot());
  const read = rows.find((r) => r.name === 'Read')!;
  expect(activityMatches(read, 'rea')).toBe(true); // name, case-insensitive
  expect(activityMatches(read, 'nomatch')).toBe(false);
  const withDetail = rows.find((r) => r.detail);
  if (withDetail) expect(activityMatches(withDetail, withDetail.detail!.slice(0, 4).toLowerCase())).toBe(true);
});
