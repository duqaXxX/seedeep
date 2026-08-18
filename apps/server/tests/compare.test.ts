import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionRecord } from '../src/core/types.ts';
import { COMPARE_TOP_N } from '../src/core/types.ts';
import type { SessionWeight } from '../src/server/aggregate-cache.ts';
import { buildComparison } from '../src/server/compare.ts';

const NOW = Date.UTC(2026, 6, 28, 12);
const DAY = 864e5;

function rec(id: string, over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: id,
    project: 'proj',
    model: null,
    lastActivity: NOW,
    isActive: false,
    isOpen: false,
    status: null,
    waitingFor: null,
    waitingSince: null,
    statusDerived: false,
    subject: 'do ' + id,
    entrypoint: 'cli',
    root: 'cli',
    path: '/p/' + id + '.jsonl',
    ...over,
  };
}
function weight(over: Partial<SessionWeight> = {}): SessionWeight {
  return {
    weight: 1000,
    subagentWeight: 0,
    byModel: [{ model: 'claude-opus-4-8', weight: 1000 }],
    tokensComplete: 5000,
    mainModel: 'claude-opus-4-8',
    mainModels: 1,
    turns: 1,
    apiCalls: 1,
    firstTs: NOW,
    lastTs: NOW,
    ...over,
  };
}

test('a session enters a window by its last activity, and enters it WHOLE', () => {
  const roster = [rec('recent'), rec('old')];
  const weights = new Map<string, SessionWeight>([
    ['/p/recent.jsonl', weight({ weight: 100, lastTs: NOW - 2 * DAY })],
    // Started 40 days ago and ran for a month: its LAST activity is inside 7 days, so the whole
    // session is in the 7-day window — not the slice of it that falls after the cut.
    ['/p/old.jsonl', weight({ weight: 900, firstTs: NOW - 40 * DAY, lastTs: NOW - 1 * DAY })],
  ]);
  const c = buildComparison(roster, weights, NOW);
  assert.equal(c.windows.d7.sessions, 2);
  assert.equal(c.windows.d7.weight, 1000, 'the long session contributes all of its weight');
  assert.equal(c.windows.d7.top[0]!.sessionId, 'old');
});

test('a session whose last activity predates the window is out of it, but stays in the wider one', () => {
  const weights = new Map<string, SessionWeight>([['/p/a.jsonl', weight({ lastTs: NOW - 20 * DAY })]]);
  const c = buildComparison([rec('a')], weights, NOW);
  assert.equal(c.windows.d7.sessions, 0);
  assert.equal(c.windows.d7.weight, 0);
  assert.equal(c.windows.d30.sessions, 1);
  assert.equal(c.windows.all.sessions, 1);
});

test('a session with no weight is not compared at all', () => {
  // A content-less session (an sdk run that made no call) has nothing to rank; showing it as a
  // 0-weight row would put an empty bar at the bottom of every window.
  const weights = new Map<string, SessionWeight>([
    ['/p/empty.jsonl', weight({ weight: 0, byModel: [] })],
    ['/p/real.jsonl', weight()],
  ]);
  const c = buildComparison([rec('empty'), rec('real')], weights, NOW);
  assert.equal(c.windows.all.sessions, 1);
  assert.equal(c.windows.all.top[0]!.sessionId, 'real');
});

test('ranks are assigned over the WHOLE window, before the top-N cut', () => {
  // The rank pair is what the "▲N vs unweighted" chip reads. If either rank were derived from the
  // returned rows, the chip would understate every move — capped at the length of the list.
  const n = COMPARE_TOP_N + 5;
  const roster = Array.from({ length: n }, (_, i) => rec('s' + i));
  const weights = new Map<string, SessionWeight>();
  // The unweighted order is the exact REVERSE of the weighted one: the heaviest session by weight
  // processed the FEWEST tokens. `tokensComplete` is the unweighted rank's only input — it is the
  // number the row prints — so setting it here is what makes this test exercise the real mechanism.
  for (let i = 0; i < n; i++) {
    weights.set('/p/s' + i + '.jsonl', weight({ weight: (n - i) * 100, tokensComplete: (i + 1) * 1000 }));
  }
  const w = buildComparison(roster, weights, NOW).windows.all;

  assert.equal(w.sessions, n);
  assert.equal(w.top.length, COMPARE_TOP_N);
  assert.equal(w.top[0]!.rank, 1);
  assert.equal(w.top[0]!.rawRank, n, 'the heaviest by weight is LAST by raw tokens');
  assert.ok(w.top[0]!.rawRank > COMPARE_TOP_N, 'a rank beyond the cut is reachable — not clamped to the list length');
  assert.equal(w.restSessions, 5);
  assert.equal(
    w.restWeight,
    [1, 2, 3, 4, 5].reduce((a, i) => a + i * 100, 0),
  );
});

test("a window's weight, subagent share and by-model split all reconcile with its rows", () => {
  const weights = new Map<string, SessionWeight>([
    [
      '/p/a.jsonl',
      weight({
        weight: 600,
        subagentWeight: 200,
        byModel: [
          { model: 'claude-opus-4-8', weight: 400 },
          { model: 'claude-haiku-4-5-20251001', weight: 200 },
        ],
      }),
    ],
    ['/p/b.jsonl', weight({ weight: 400, subagentWeight: 0, byModel: [{ model: 'claude-opus-4-8', weight: 400 }] })],
  ]);
  const w = buildComparison([rec('a'), rec('b')], weights, NOW).windows.all;
  assert.equal(w.weight, 1000);
  assert.equal(w.subagentWeight, 200);
  assert.deepEqual(w.byModel, [
    { model: 'claude-opus-4-8', weight: 800 },
    { model: 'claude-haiku-4-5-20251001', weight: 200 },
  ]);
  assert.equal(
    w.byModel.reduce((n, m) => n + m.weight, 0),
    w.weight,
    'the split sums to the total',
  );
});

test('an undated session falls back to its file mtime rather than dropping out of every window', () => {
  const weights = new Map<string, SessionWeight>([['/p/a.jsonl', weight({ firstTs: null, lastTs: null })]]);
  const c = buildComparison([rec('a', { lastActivity: NOW - 3 * DAY })], weights, NOW);
  assert.equal(c.windows.d7.sessions, 1);
  assert.equal(c.windows.d7.top[0]!.lastTs, NOW - 3 * DAY);
});
