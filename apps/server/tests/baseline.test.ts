import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aggregateBaseline, extractTurns } from '../src/server/baseline.ts';

// aggregateBaseline is the pure percentile + per-effort split; extractTurns runs the REAL
// parser + reducer so it can falsify "I read the wrong field for billable".

const ctx = { sessionId: 's1', root: 'cli' as const };

const typed = (uuid: string, text: string) =>
  JSON.stringify({
    type: 'user',
    uuid,
    timestamp: '2026-07-14T10:00:00.000Z',
    origin: { kind: 'human' },
    promptSource: 'typed',
    message: { role: 'user', content: text },
  });
const asst = (uuid: string, o: { input?: number; out?: number; cc?: number; cr?: number; effort?: string }) =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: '2026-07-14T10:00:05.000Z',
    ...(o.effort ? { effort: o.effort } : {}),
    message: {
      role: 'assistant',
      model: 'claude-opus-4-8',
      usage: {
        input_tokens: o.input ?? 10,
        output_tokens: o.out ?? 100,
        cache_read_input_tokens: o.cr ?? 0,
        cache_creation_input_tokens: o.cc ?? 0,
      },
    },
  });
const turnDuration = (uuid: string) =>
  JSON.stringify({
    type: 'system',
    subtype: 'turn_duration',
    uuid,
    timestamp: '2026-07-14T10:00:09.000Z',
    durationMs: 9000,
    messageCount: 3,
  });

test('aggregateBaseline: overall percentiles (nearest-rank, ceil)', () => {
  const turns = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000].map((work) => ({ work, effort: 'unknown' }));
  const b = aggregateBaseline(turns, 1);
  assert.equal(b.overall.count, 10);
  assert.equal(b.overall.p50, 500); // ceil(.5*10)-1 = idx4
  assert.equal(b.overall.p90, 900); // ceil(.9*10)-1 = idx8
  assert.equal(b.overall.p95, 1000); // ceil(.95*10)-1 = idx9
  assert.equal(b.turnsScanned, 10);
  assert.equal(b.sessionsScanned, 1);
});

test('aggregateBaseline: per-effort split is independent', () => {
  const turns = [
    { work: 1000, effort: 'high' },
    { work: 2000, effort: 'high' },
    { work: 10, effort: 'unknown' },
    { work: 20, effort: 'unknown' },
    { work: 30, effort: 'unknown' },
  ];
  const b = aggregateBaseline(turns, 2);
  assert.equal(b.byEffort.high!.count, 2);
  assert.equal(b.byEffort.high!.p50, 1000);
  assert.equal(b.byEffort.unknown!.count, 3);
  assert.equal(b.byEffort.unknown!.p95, 30);
  assert.equal(b.overall.count, 5);
});

test('extractTurns: work = input+output+cache_creation, effort carried, live turn excluded', () => {
  const lines = [
    typed('u1', 'first'),
    asst('a1', { input: 10, out: 100, cc: 50 }),
    turnDuration('d1'), // billable 160, unknown
    typed('u2', 'second'),
    asst('a2', { input: 20, out: 200, cc: 100, effort: 'high' }),
    turnDuration('d2'), // billable 320, high
    typed('u3', 'third'),
    asst('a3', { input: 5, out: 5, cc: 5 }), // live: no turn_duration → excluded
  ];
  const turns = extractTurns(lines, ctx);
  assert.deepEqual(turns, [
    { work: 160, effort: 'unknown' },
    { work: 320, effort: 'high' },
  ]);
});

test('extractTurns: a cold resume is NOT baseline work — it would raise the bar for everyone', () => {
  // The baseline is what the share card places a turn against, so a resume left inside it moves
  // the percentiles for every other turn: measured, resumes are 25.7% of every billable token in
  // the corpus.
  const lines = [
    typed('u1', 'first'),
    asst('a1', { input: 2, out: 100, cc: 40_000 }),
    turnDuration('d1'), // boot
    typed('u2', 'back later'),
    asst('a2', { input: 2, out: 700, cc: 173_867, cr: 3_898 }),
    turnDuration('d2'),
  ];
  const turns = extractTurns(lines, ctx);
  assert.equal(turns.length, 2);
  assert.equal(turns[0]!.work, 40_102, 'the session boot is not a resume — it stays whole');
  assert.equal(turns[1]!.work, 702, 'only what the turn actually produced');
});

test('extractTurns: cache_read does NOT inflate the work figure', () => {
  const lines = [typed('u1', 'x'), asst('a1', { input: 10, out: 10, cc: 0, cr: 999999 }), turnDuration('d1')];
  assert.deepEqual(extractTurns(lines, ctx), [{ work: 20, effort: 'unknown' }]);
});
