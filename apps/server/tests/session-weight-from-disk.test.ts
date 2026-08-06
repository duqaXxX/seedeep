import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { callWeight } from '../src/core/token-weight.ts';
import { createAggregateCache, summarizeSession, summarizeSessionFromDisk } from '../src/server/aggregate-cache.ts';

// The bug this file exists for: the corpus aggregate read the PARENT transcript only, so 35.3% of
// the local corpus's billable tokens — everything a subagent spent, up to 91.9% of one session —
// was missing from every per-session figure. These tests start from raw jsonl ON DISK, in the real
// layout, and go through the real parser + reducer, so they can discover that a whole class of
// lines is being dropped. Hand-built summaries never could.

const T = '2026-07-14T10:00:0';

/** A faithful assistant line: `message.model` + a full usage block, as CC writes them. */
function assistant(
  uuid: string,
  model: string,
  u: { input: number; cw: number; cr: number; out: number },
  sec = 5,
): string {
  return JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: `${T}${sec}.000Z`,
    requestId: 'req_' + uuid,
    message: {
      id: 'msg_' + uuid,
      role: 'assistant',
      model,
      usage: {
        input_tokens: u.input,
        output_tokens: u.out,
        cache_creation_input_tokens: u.cw,
        cache_read_input_tokens: u.cr,
      },
    },
  });
}
const prompt = (uuid: string) =>
  JSON.stringify({
    type: 'user',
    uuid,
    timestamp: `${T}0.000Z`,
    origin: { kind: 'human' },
    promptSource: 'typed',
    message: { role: 'user', content: 'do the thing' },
  });
const closeTurn = () =>
  JSON.stringify({
    type: 'system',
    subtype: 'turn_duration',
    uuid: 'd1',
    timestamp: `${T}9.000Z`,
    durationMs: 9000,
    messageCount: 3,
  });

const MAIN = { input: 10, cw: 1000, cr: 20_000, out: 300 };
const CHILD = { input: 5, cw: 500, cr: 4000, out: 100 };
const MAIN_W = callWeight('claude-opus-4-8', {
  input: MAIN.input,
  cacheCreation: MAIN.cw,
  cacheRead: MAIN.cr,
  output: MAIN.out,
});
const CHILD_W = callWeight('claude-haiku-4-5-20251001', {
  input: CHILD.input,
  cacheCreation: CHILD.cw,
  cacheRead: CHILD.cr,
  output: CHILD.out,
});

/** A session on disk: parent transcript + one Haiku subagent, in CC's real layout. Every file ends
 * with a newline, as all 1054 real transcripts do (measured 2026-07-28) — the tailer withholds an
 * unterminated final line, so a fixture without one hides its own last event. */
function writeSession(prefix: string): { dir: string; parent: string } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const parent = join(dir, 'S.jsonl');
  writeFileSync(parent, [prompt('u1'), assistant('a1', 'claude-opus-4-8', MAIN), closeTurn()].join('\n') + '\n');
  const subDir = join(dir, 'S', 'subagents');
  mkdirSync(subDir, { recursive: true });
  writeFileSync(join(subDir, 'agent-AAA.jsonl'), assistant('c1', 'claude-haiku-4-5-20251001', CHILD, 6) + '\n');
  writeFileSync(
    join(subDir, 'agent-AAA.meta.json'),
    JSON.stringify({ agentType: 'explore', toolUseId: 'toolu_1', spawnDepth: 1 }),
  );
  return { dir, parent };
}

test('the disk summarizer counts the subagent transcript; the parent-only one cannot', async () => {
  const { parent } = writeSession('seedeep-weight-disk-');
  const fromDisk = await summarizeSessionFromDisk(parent, { sessionId: 'S', root: 'cli' });

  assert.equal(fromDisk.weightedMain, MAIN_W);
  assert.equal(fromDisk.weightedSubagents, CHILD_W, 'the child’s weight is counted');
  assert.ok(CHILD_W > 0, 'the fixture would prove nothing if the child weighed zero');

  // The old behaviour, kept as the contrast: reading the parent's lines alone sees no child at
  // all. This is the assertion that goes red if the summarizer ever stops walking `subagents/`.
  const parentOnly = summarizeSession([prompt('u1'), assistant('a1', 'claude-opus-4-8', MAIN), closeTurn()], {
    sessionId: 'S',
    root: 'cli',
  });
  assert.equal(parentOnly.weightedSubagents, 0);
  assert.equal(
    fromDisk.weightedMain + fromDisk.weightedSubagents,
    parentOnly.weightedMain + CHILD_W,
    'the two differ by exactly the child',
  );
});

test('per-model split covers main AND subagents, and sums to the session weight', async () => {
  const { parent } = writeSession('seedeep-weight-split-');
  const s = await summarizeSessionFromDisk(parent, { sessionId: 'S', root: 'cli' });
  assert.deepEqual(s.weightedByModel, { 'claude-opus-4-8': MAIN_W, 'claude-haiku-4-5-20251001': CHILD_W });
  const summed = Object.values(s.weightedByModel).reduce((a, b) => a + b, 0);
  assert.equal(summed, s.weightedMain + s.weightedSubagents);
});

test("a session's weight does not depend on its turns being CLOSED", async () => {
  // Σ turns[].weighted would be 0 here: no `turn_duration`, so nothing closed. Summing the turns
  // is what left 751 of 996 real sessions weighing zero.
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-weight-open-'));
  const parent = join(dir, 'S.jsonl');
  writeFileSync(parent, [prompt('u1'), assistant('a1', 'claude-opus-4-8', MAIN)].join('\n') + '\n');
  const s = await summarizeSessionFromDisk(parent, { sessionId: 'S', root: 'cli' });
  assert.equal(s.turns.length, 0, 'the fixture really has no closed turn');
  assert.equal(s.weightedMain, MAIN_W, 'the session still has its weight');
});

test("a session's call count does not depend on its turns being CLOSED either", async () => {
  // The same mistake as the weight, one field later: `Σ turns[].apiCalls` counts closed work turns
  // only, so a session whose last turn never closed rendered "0 calls" beside a non-zero weight.
  // Measured on 240 real sessions: 125 of them (52.1%) would have.
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-calls-open-'));
  const parent = join(dir, 'S.jsonl');
  writeFileSync(
    parent,
    [prompt('u1'), assistant('a1', 'claude-opus-4-8', MAIN), assistant('a2', 'claude-opus-4-8', MAIN, 7)].join('\n') +
      '\n',
  );
  const s = await summarizeSessionFromDisk(parent, { sessionId: 'S', root: 'cli' });
  assert.equal(s.turns.length, 0, 'the fixture really has no closed turn');
  assert.equal(s.apiCalls, 2, 'the session still knows it made two calls');
  assert.equal(
    s.turns.reduce((n, t) => n + t.apiCalls, 0),
    0,
    'and summing the turns would say zero',
  );
});

test('a call is weighed once however many content blocks it wrote', async () => {
  // CC appends one line per content block, each repeating the SAME usage block. Weighing per line
  // would multiply a call by its block count.
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-weight-dedup-'));
  const parent = join(dir, 'S.jsonl');
  const one = JSON.parse(assistant('a1', 'claude-opus-4-8', MAIN));
  const second = { ...one, uuid: 'a1b' }; // same message.id → the same call
  writeFileSync(parent, [prompt('u1'), JSON.stringify(one), JSON.stringify(second), closeTurn()].join('\n') + '\n');
  const s = await summarizeSessionFromDisk(parent, { sessionId: 'S', root: 'cli' });
  assert.equal(s.weightedMain, MAIN_W);
});

test('the cache re-parses when only a CHILD changed', async () => {
  // The parent's (size, mtime) cannot answer this: a subagent's transcript can be written when the
  // parent is not, and reusing the cached summary would serve a session missing that child.
  const { dir, parent } = writeSession('seedeep-weight-invalidate-');
  const cacheFile = join(dir, 'aggregates.json');
  const cache = createAggregateCache({ cacheFile });
  await cache.refresh([parent]);
  const before = cache.weightByPath().get(parent)!;
  assert.equal(before.subagentWeight, CHILD_W);

  // A second subagent appears. The parent file is not written at all, so its (size, mtime) is
  // untouched by construction — do NOT restore it with utimesSync, which truncates mtime to whole
  // milliseconds and re-parses for the wrong reason: with that call in place this test passed even
  // with the child stamp removed from the invalidation check, i.e. it proved nothing.
  const before_mtime = statSync(parent).mtimeMs;
  writeFileSync(
    join(dir, 'S', 'subagents', 'agent-BBB.jsonl'),
    assistant('c2', 'claude-haiku-4-5-20251001', CHILD, 7) + '\n',
  );
  assert.equal(statSync(parent).mtimeMs, before_mtime, 'the parent must look unchanged for this test to mean anything');

  await cache.refresh([parent]);
  const after = cache.weightByPath().get(parent)!;
  assert.equal(after.subagentWeight, CHILD_W * 2, 'the new child is counted');
  assert.equal(after.weight, MAIN_W + CHILD_W * 2);
});
