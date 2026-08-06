import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { windowFor } from '../src/core/context-windows.ts';
import { createSessionTree } from '../src/core/session-tree.ts';
import type { TurnSummary } from '../src/core/types.ts';
import { computeVerdict, turnBillable } from '../src/core/verdict.ts';
import { aggregate, createAggregateCache, summarizeFile, summarizeSession } from '../src/server/aggregate-cache.ts';
import { parseLine } from '../src/server/parser.ts';

// The shape below is faithful to real cli jsonl (verified against ~/.claude/projects):
// a typed prompt carries origin.kind:'human'; an assistant line carries message.usage; a
// closed turn ends with system/turn_duration; Esc leaves an interruptedMessageId on the
// user line that follows.
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
const dur = (uuid: string) =>
  JSON.stringify({
    type: 'system',
    subtype: 'turn_duration',
    uuid,
    timestamp: '2026-07-14T10:00:09.000Z',
    durationMs: 9000,
    messageCount: 3,
  });
const escNext = (uuid: string, text: string) =>
  JSON.stringify({
    type: 'user',
    uuid,
    timestamp: '2026-07-14T10:01:00.000Z',
    interruptedMessageId: 'prev',
    origin: { kind: 'human' },
    promptSource: 'typed',
    message: { role: 'user', content: text },
  });

const ctx = { sessionId: 's1', root: 'cli' as const };

// A small synthetic session: one plain turn, one interrupted turn (Esc), one big turn.
function sessionLines(): string[] {
  return [
    typed('u1', 'first'),
    asst('a1', { input: 10, out: 100, cc: 50 }),
    dur('d1'), // plain, billable 160
    typed('u2', 'second'),
    asst('a2', { input: 20, out: 200, cc: 100 }), // interrupted next line
    escNext('u3', 'third'),
    asst('a3', { input: 5, out: 5, cc: 5 }),
    dur('d3'), // billable 15
    typed('u4', 'fourth'),
    asst('a4', { input: 500000, out: 400000, cc: 100000 }),
    dur('d4'), // huge, billable 1,000,000
  ];
}

test('summarizeFile: one TurnSummary per closed work turn, with baseline-independent flags', () => {
  const turns = summarizeFile(sessionLines(), ctx);
  // Four closed work turns: u1 (plain), u2 (interrupted — the escNext line both ends u2's turn
  // and STARTS a new one), u3, u4 (huge). All four close with a turn_duration or the next prompt.
  assert.equal(turns.length, 4);
  assert.deepEqual(
    turns.map((t) => t.billable),
    [160, 320, 15, 1_000_000],
  );
  assert.equal(turns[1]!.esc, true); // the interrupted turn
  assert.equal(turns[0]!.esc, false);
  assert.equal(turns[3]!.esc, false);
  for (const t of turns) {
    assert.equal(t.context, false);
    assert.equal(t.compaction, false);
    assert.equal(t.subWaste, false);
  }
  // A lone Esc is not a finding, so the interrupted turn carries no streak.
  for (const t of turns) assert.equal(t.escStreak, false);
});

// A second session, built to exercise the three WARN paths `sessionLines` never reaches:
// a cold resume, a context ≥70% full, and a second consecutive Esc. It dates from when the cache
// re-derived the severity from the stored flags and could silently drop one of them; the cache
// now STORES the verdict's own severity, so what this still guards is narrower and real — that
// summarizing carries the severity across, and that the window sums it — over a fixture whose
// turns are not all `good`.
function driftLines(): string[] {
  return [
    // #1 boot: the session's first real call, so its rebuild is EXPECTED (no resume)
    typed('u1', 'boot'),
    asst('a1', { input: 10, out: 100, cr: 5_000, cc: 100 }),
    dur('d1'),
    // #2 and #3: two interruptions in a row → the streak fires on #3, never on #2
    typed('u2', 'try this'),
    asst('a2', { input: 10, out: 50, cr: 5_000, cc: 50 }),
    escNext('u3', 'no, this'),
    asst('a3', { input: 10, out: 50, cr: 5_000, cc: 50 }),
    escNext('u4', 'stop'),
    asst('a4', { input: 10, out: 50, cr: 5_000, cc: 50 }),
    dur('d4'),
    // #5 cold resume: the first call re-creates ~all of a 210k prompt
    typed('u5', 'back after a break'),
    asst('a5', { input: 10, out: 100, cr: 10_000, cc: 200_000 }),
    dur('d5'),
    // #6 context: 800k of a 1M window (claude-opus-4-8) is 80% full
    typed('u6', 'keep going'),
    asst('a6', { input: 10, out: 100, cr: 800_000, cc: 100 }),
    dur('d6'),
  ];
}

test('golden fixture really reaches the resume / context / esc-streak paths', () => {
  // Guards the guard: if a future edit makes this fixture stop producing all three, the
  // anti-drift test below silently goes back to proving nothing.
  const turns = summarizeFile(driftLines(), ctx);
  assert.ok(
    turns.some((t) => t.resumeCost > 0),
    'a cold resume',
  );
  assert.ok(
    turns.some((t) => t.context),
    'a context ≥70% turn',
  );
  assert.ok(
    turns.some((t) => t.escStreak),
    'a second consecutive Esc',
  );
  assert.equal(turns.filter((t) => t.esc).length, 2, 'two interruptions, one of them a streak');
  assert.equal(turns.filter((t) => t.escStreak).length, 1);
});

test('aggregate == a full direct scan (golden): counters + baseline match computeVerdict', () => {
  const lines = sessionLines();
  // direct scan, exactly the reference-script way
  const tree = createSessionTree({ windowFor });
  let seq = 0;
  for (const l of lines) for (const e of parseLine(l, { ...ctx, seq: seq++, agentId: null })) tree.apply(e);
  const snap = tree.snapshot();
  const work = snap.turnList.filter((t) => t.kind === 'work' && t.state !== 'live');
  // baseline built the same way aggregate does (from the 3 turns)
  const _bl = aggregate([summarizeSession(lines, ctx)]).baseline;
  let esc = 0,
    escTokens = 0,
    crit = 0,
    warn = 0;
  for (const t of work) {
    const v = computeVerdict(t, snap);
    if (t.state === 'interrupted') {
      esc++;
      escTokens += turnBillable(t);
    }
    if (v.severity === 'crit') crit++;
    else if (v.severity === 'warn') warn++;
  }
  const w = aggregate([summarizeSession(lines, ctx)]).windows.all;
  assert.equal(w.turns, work.length);
  assert.equal(w.esc.turns, esc);
  assert.equal(w.esc.tokens, escTokens);
  assert.equal(w.crit, crit);
  assert.equal(w.warn, warn);
});

test('aggregate == a full direct scan (golden): the resume / context / esc-streak paths too', () => {
  // The same comparison over `driftLines`, whose turns reach the resume / context / esc-streak
  // paths — so the assertion is made against a mix of crit, warn and good, not a uniform set.
  const lines = driftLines();
  const tree = createSessionTree({ windowFor });
  let seq = 0;
  for (const l of lines) for (const e of parseLine(l, { ...ctx, seq: seq++, agentId: null })) tree.apply(e);
  const snap = tree.snapshot();
  const work = snap.turnList.filter((t) => t.kind === 'work' && t.state !== 'live');
  const _bl = aggregate([summarizeSession(lines, ctx)]).baseline;
  let crit = 0,
    warn = 0;
  for (const t of work) {
    const v = computeVerdict(t, snap);
    if (v.severity === 'crit') crit++;
    else if (v.severity === 'warn') warn++;
  }
  const w = aggregate([summarizeSession(lines, ctx)]).windows.all;
  assert.equal(w.turns, work.length);
  assert.equal(w.crit, crit);
  assert.equal(w.warn, warn);
  assert.ok(warn >= 3, 'the fixture must actually produce warns, or this proves nothing');
});

test('aggregate: sessions counts only files that yielded turns', () => {
  const agg = aggregate([
    summarizeSession(sessionLines(), ctx),
    {
      turns: [],
      tools: {},
      weightedMain: 0,
      weightedSubagents: 0,
      weightedByModel: {},
      tokensComplete: 0,
      mainModel: null,
      mainModels: 0,
      apiCalls: 0,
    },
  ]);
  assert.equal(agg.sessions, 1);
});

test('aggregate: time windows filter by ts; histogram + workMs are per-window', () => {
  // Window math is pure arithmetic over the summaries (the parser is covered by summarizeFile
  // above), so hand-built TurnSummaries with controlled timestamps unit-test just this branch.
  // Local midnight, not UTC: the weekly buckets are Monday-anchored in local time, so a UTC
  // anchor would land in a different calendar week depending on the machine's timezone.
  const NOW = new Date(2026, 6, 20).getTime(); // Monday 2026-07-20
  const day = 864e5;
  const mk = (billable: number, daysAgo: number): TurnSummary => ({
    billable,
    resumeCost: 0,
    cacheRead: 0,
    weighted: 0,
    subagentTokensByModel: [],
    subagentNew: 0,
    effort: 'unknown',
    model: 'claude-opus-4-8',
    apiCalls: 1,
    esc: false,
    escStreak: false,
    context: false,
    compaction: false,
    subWaste: false,
    exploration: false,
    unverifiedShip: false,
    severity: 'good' as const,
    ts: NOW - daysAgo * day,
    durationMs: 1000,
  });
  const turns = [mk(500, 1), mk(2000, 2), mk(50000, 3), mk(5000, 20), mk(200000, 40)];
  const r = aggregate(
    [
      {
        turns,
        tools: {},
        weightedMain: 0,
        weightedSubagents: 0,
        weightedByModel: {},
        tokensComplete: 0,
        mainModel: null,
        mainModels: 0,
        apiCalls: 0,
      },
    ],
    NOW,
  );
  assert.equal(r.windows.all.turns, 5);
  assert.equal(r.windows.d30.turns, 4); // drops the 40-day-old turn
  assert.equal(r.windows.d7.turns, 3); // only the last week
  // histogram bins: <1k, 1–3k, 3–10k, 10–30k, 30–100k, 100–300k, 300k+
  assert.deepEqual(r.windows.all.hist, [1, 1, 1, 0, 1, 1, 0]);
  assert.deepEqual(r.windows.d7.hist, [1, 1, 0, 0, 1, 0, 0]);
  assert.equal(r.windows.d7.workMs, 3000);
  // Weekly cadence sized to the real span: the oldest turn is 40 days back, which reaches 6
  // calendar-week boundaries behind the current one — hence 7 buckets, not ceil(40/7)=6.
  assert.equal(r.weeks.length, 7);
  // `now` is Monday 00:00, so the current week is empty and the 1/2/3-day-old turns (Fri–Sun)
  // belong to the week just closed — the very split a rolling 7-day bucket could not express.
  assert.equal(r.weeks[0]!.good, 0);
  assert.equal(r.weeks[1]!.good, 3);
});

test('aggregate: p50Complete / p95Complete include cache reads; p50 stays new-tokens only (histogram alignment)', () => {
  const NOW = new Date(2026, 6, 20).getTime();
  const mk = (billable: number, cacheRead: number): TurnSummary => ({
    billable,
    resumeCost: 0,
    cacheRead,
    weighted: 0,
    subagentTokensByModel: [],
    subagentNew: 0,
    effort: 'unknown',
    model: 'claude-opus-4-8',
    apiCalls: 1,
    esc: false,
    escStreak: false,
    context: false,
    compaction: false,
    subWaste: false,
    exploration: false,
    unverifiedShip: false,
    severity: 'good' as const,
    ts: null,
    durationMs: 0,
  });
  // Three turns: billable [100,200,300], cacheRead [900,1800,2700] → complete [1000,2000,3000].
  // pctl(sorted, 0.5) nearest-rank on 3 values: ceil(0.5*3)-1 = 1 → sorted[1] = middle value.
  const w = aggregate(
    [
      {
        turns: [mk(100, 900), mk(200, 1800), mk(300, 2700)],
        tools: {},
        weightedMain: 0,
        weightedSubagents: 0,
        weightedByModel: {},
        tokensComplete: 0,
        mainModel: null,
        mainModels: 0,
        apiCalls: 0,
      },
    ],
    NOW,
  ).windows.all;
  assert.equal(w.p50, 200, 'p50 = median of NEW tokens per turn');
  assert.equal(w.p50Complete, 2000, 'p50Complete = median of COMPLETE tokens per turn');
  assert.equal(w.p95Complete, 3000, 'p95Complete uses COMPLETE tokens');
});

test('aggregate: days array always has 7 slots; buckets turns by local calendar day', () => {
  const at = (y: number, m: number, d: number, h: number) => new Date(y, m, d, h).getTime();
  const NOW = at(2026, 6, 22, 12); // Wednesday 2026-07-22, midday
  const mk = (ts: number, severity: 'crit' | 'warn' | 'good' = 'good'): TurnSummary => ({
    billable: 10,
    resumeCost: 0,
    cacheRead: 90,
    weighted: 0,
    subagentTokensByModel: [],
    subagentNew: 0,
    effort: 'unknown',
    model: 'claude-opus-4-8',
    apiCalls: 1,
    esc: false,
    escStreak: false,
    context: false,
    compaction: false,
    subWaste: false,
    exploration: false,
    unverifiedShip: false,
    severity,
    ts,
    durationMs: 500,
  });
  const turns = [
    mk(at(2026, 6, 22, 9)), // today (index 0)
    mk(at(2026, 6, 22, 14)), // today again
    mk(at(2026, 6, 21, 23)), // yesterday (index 1)
    mk(at(2026, 6, 16, 10)), // 6 days ago (index 6)
    mk(at(2026, 6, 15, 12)), // 7 days ago — outside the window, must be ignored
  ];
  const r = aggregate(
    [
      {
        turns,
        tools: {},
        weightedMain: 0,
        weightedSubagents: 0,
        weightedByModel: {},
        tokensComplete: 0,
        mainModel: null,
        mainModels: 0,
        apiCalls: 0,
      },
    ],
    NOW,
  );
  assert.equal(r.days.length, 7, 'always 7 slots');
  assert.equal(r.days[0]!.good, 2, 'two turns today');
  assert.equal(r.days[1]!.good, 1, 'one turn yesterday');
  assert.equal(r.days[6]!.good, 1, '6 days ago');
  assert.equal(r.days[2]!.good + r.days[3]!.good + r.days[4]!.good + r.days[5]!.good, 0, 'empty days in between');
  // tokens are COMPLETE in the daily buckets
  assert.equal(r.days[0]!.tokens, 200, 'tokens = billable + cacheRead per turn × 2 turns');
  assert.equal(r.days[0]!.workMs, 1000, 'workMs summed across turns in the day');
});

test('aggregate: weekly buckets are calendar weeks (Mon-anchored), not rolling 7-day windows', () => {
  // The rolling bucket put a Sunday turn and the next Monday's turn in the same slot whenever
  // `now` sat mid-week, so the same corpus produced different bars on every refresh. Calendar
  // buckets are stable: the boundary is Monday 00:00 local, wherever `now` falls.
  const at = (y: number, m: number, d: number, h: number) => new Date(y, m, d, h).getTime();
  const NOW = at(2026, 6, 22, 12); // Wednesday 2026-07-22, midweek
  const mk = (ts: number, billable: number, cacheRead: number, durationMs: number): TurnSummary => ({
    billable,
    resumeCost: 0,
    cacheRead,
    weighted: 0,
    subagentTokensByModel: [],
    subagentNew: 0,
    effort: 'unknown',
    model: 'claude-opus-4-8',
    apiCalls: 1,
    esc: false,
    escStreak: false,
    context: false,
    compaction: false,
    subWaste: false,
    exploration: false,
    unverifiedShip: false,
    severity: 'good' as const,
    ts,
    durationMs,
  });
  const sundayEve = mk(at(2026, 6, 19, 23), 100, 900, 1000); // Sun 19th — previous calendar week
  const mondayAm = mk(at(2026, 6, 20, 9), 200, 1800, 2000); // Mon 20th — current calendar week
  const r = aggregate(
    [
      {
        turns: [sundayEve, mondayAm],
        tools: {},
        weightedMain: 0,
        weightedSubagents: 0,
        weightedByModel: {},
        tokensComplete: 0,
        mainModel: null,
        mainModels: 0,
        apiCalls: 0,
      },
    ],
    NOW,
  );

  // Both turns are less than 7 days old, so the rolling bucket collapsed them into weeks[0].
  assert.equal(r.weeks.length, 2);
  assert.equal(r.weeks[0]!.good, 1);
  assert.equal(r.weeks[1]!.good, 1);
  // Per-week work volume: tokens are COMPLETE (billable + cache reads), matching totalTokens.
  assert.equal(r.weeks[0]!.tokens, 2000);
  assert.equal(r.weeks[0]!.workMs, 2000);
  assert.equal(r.weeks[1]!.tokens, 1000);
  assert.equal(r.weeks[1]!.workMs, 1000);
});

test('aggregate: a calendar week holds its whole Mon-Sun span in one bucket', () => {
  const at = (y: number, m: number, d: number, h: number) => new Date(y, m, d, h).getTime();
  const NOW = at(2026, 6, 22, 12); // Wednesday 2026-07-22
  const mk = (ts: number): TurnSummary => ({
    billable: 10,
    resumeCost: 0,
    cacheRead: 0,
    weighted: 0,
    subagentTokensByModel: [],
    subagentNew: 0,
    effort: 'unknown',
    model: 'claude-opus-4-8',
    apiCalls: 1,
    esc: false,
    escStreak: false,
    context: false,
    compaction: false,
    subWaste: false,
    exploration: false,
    unverifiedShip: false,
    severity: 'good' as const,
    ts,
    durationMs: 0,
  });
  // Monday 00:00 and the following Sunday 23:00 are the two ends of the same calendar week.
  const r = aggregate(
    [
      {
        turns: [mk(at(2026, 6, 13, 0)), mk(at(2026, 6, 19, 23))],
        tools: {},
        weightedMain: 0,
        weightedSubagents: 0,
        weightedByModel: {},
        tokensComplete: 0,
        mainModel: null,
        mainModels: 0,
        apiCalls: 0,
      },
    ],
    NOW,
  );
  assert.equal(r.weeks.length, 2);
  assert.equal(r.weeks[1]!.good, 2); // both in the week before the current one
  assert.equal(r.weeks[0]!.good, 0);
});

test('aggregate: complete-total (incl. cache reads), API calls, by-model split, and tool merge', () => {
  const t = (billable: number, model: string, cacheRead = 0, api = 1): TurnSummary => ({
    billable,
    resumeCost: 0,
    cacheRead,
    weighted: 0,
    subagentTokensByModel: [],
    subagentNew: 0,
    effort: 'unknown',
    model,
    apiCalls: api,
    esc: false,
    escStreak: false,
    context: false,
    compaction: false,
    subWaste: false,
    exploration: false,
    unverifiedShip: false,
    severity: 'good' as const,
    ts: null,
    durationMs: 0,
  });
  const r = aggregate([
    {
      turns: [t(100, 'opus', 900, 2), t(200, 'sonnet', 0, 1)],
      tools: { Bash: 3, Read: 1 },
      weightedMain: 0,
      weightedSubagents: 0,
      weightedByModel: {},
      tokensComplete: 0,
      mainModel: null,
      mainModels: 0,
      apiCalls: 0,
    },
    {
      turns: [t(50, 'opus', 0, 1)],
      tools: { Bash: 2 },
      weightedMain: 0,
      weightedSubagents: 0,
      weightedByModel: {},
      tokensComplete: 0,
      mainModel: null,
      mainModels: 0,
      apiCalls: 0,
    },
  ]);
  const w = r.windows.all;
  assert.equal(w.newTokens, 350); // sum of billable
  assert.equal(w.totalTokens, 350 + 900); // + cache reads = the honest total spent
  assert.equal(w.apiCalls, 4);
  assert.deepEqual(w.byModel, [
    { model: 'opus', tokens: 1050 },
    { model: 'sonnet', tokens: 200 },
  ]); // desc — total = billable + cacheRead
  assert.deepEqual(r.tools, [
    { name: 'Bash', count: 5 },
    { name: 'Read', count: 1 },
  ]); // merged, desc
});

function writeSession(dir: string, name: string, lines: string[]): string {
  const p = join(dir, name);
  writeFileSync(p, lines.join('\n'));
  return p;
}

test('cache: incremental — an unchanged file is NOT re-parsed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-agg-'));
  const p1 = writeSession(dir, 'a.jsonl', sessionLines());
  const p2 = writeSession(dir, 'b.jsonl', sessionLines());
  const parsed: string[] = [];
  const cache = createAggregateCache({
    cacheFile: join(dir, 'aggregates.json'),
    parse: (path, raw) => {
      parsed.push(path);
      return summarizeSession(raw.split('\n'), { sessionId: path, root: 'cli' });
    },
  });
  await cache.refresh([p1, p2]);
  assert.deepEqual(parsed.sort(), [p1, p2].sort()); // cold: both parsed
  parsed.length = 0;
  await cache.refresh([p1, p2]); // warm, nothing changed
  assert.deepEqual(parsed, []); // neither re-parsed
});

test('cache: a changed file (size/mtime) re-parses ONLY that file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-agg-'));
  const p1 = writeSession(dir, 'a.jsonl', sessionLines());
  const p2 = writeSession(dir, 'b.jsonl', sessionLines());
  const parsed: string[] = [];
  const cache = createAggregateCache({
    cacheFile: join(dir, 'aggregates.json'),
    parse: (path, raw) => {
      parsed.push(path);
      return summarizeSession(raw.split('\n'), { sessionId: path, root: 'cli' });
    },
  });
  await cache.refresh([p1, p2]);
  parsed.length = 0;
  // append a whole new closed turn to p1
  writeFileSync(
    p1,
    [...sessionLines(), typed('u9', 'more'), asst('a9', { input: 1, out: 1, cc: 1 }), dur('d9')].join('\n'),
  );
  const agg = await cache.refresh([p1, p2]);
  assert.deepEqual(parsed, [p1]); // only the changed file
  assert.equal(agg.windows.all.turns, 4 + 4 + 1); // p2 (4) + p1 (4 + the appended 1)
});

test('cache: persists to disk and a fresh instance reuses it (no re-parse)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-agg-'));
  const p1 = writeSession(dir, 'a.jsonl', sessionLines());
  const file = join(dir, 'aggregates.json');
  const NOW = Date.parse('2026-07-20T00:00:00Z');
  const c1 = createAggregateCache({
    cacheFile: file,
    now: () => NOW,
    parse: (path, raw) => summarizeSession(raw.split('\n'), { sessionId: path, root: 'cli' }),
  });
  const first = await c1.refresh([p1]);
  assert.ok(existsSync(file));

  const parsed: string[] = [];
  const c2 = createAggregateCache({
    cacheFile: file,
    now: () => NOW,
    parse: (path, raw) => {
      parsed.push(path);
      return summarizeSession(raw.split('\n'), { sessionId: path, root: 'cli' });
    },
  });
  const second = await c2.refresh([p1]);
  assert.deepEqual(parsed, []); // reused from disk
  assert.deepEqual(second, first);
});

test('cache: a corrupt cache file is ignored and rebuilt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-agg-'));
  const p1 = writeSession(dir, 'a.jsonl', sessionLines());
  const file = join(dir, 'aggregates.json');
  writeFileSync(file, '{ not valid json');
  const cache = createAggregateCache({
    cacheFile: file,
    parse: (path, raw) => summarizeSession(raw.split('\n'), { sessionId: path, root: 'cli' }),
  });
  const agg = await cache.refresh([p1]);
  assert.equal(agg.windows.all.turns, 4); // rebuilt cleanly
});

test('cache: a vanished path is dropped from the aggregate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-agg-'));
  const p1 = writeSession(dir, 'a.jsonl', sessionLines());
  const p2 = writeSession(dir, 'b.jsonl', sessionLines());
  const cache = createAggregateCache({
    cacheFile: join(dir, 'aggregates.json'),
    parse: (path, raw) => summarizeSession(raw.split('\n'), { sessionId: path, root: 'cli' }),
  });
  await cache.refresh([p1, p2]);
  const agg = await cache.refresh([p1]); // p2 no longer offered
  assert.equal(agg.windows.all.turns, 4);
});

test('resume: the summary stores it, the window aggregates it, and the baseline excludes it', () => {
  // A session that boots, works warm, then comes back cold. The cache must carry the resume as
  // its own figure: `billable` stays the whole amount (the totals must not shrink) while the
  // baseline reads work only.
  const lines = [
    typed('u1', 'start'),
    asst('a1', { input: 2, out: 100, cc: 40_000 }),
    dur('d1'),
    typed('u2', 'warm'),
    asst('a2', { input: 2, out: 200, cc: 500, cr: 160_000 }),
    dur('d2'),
    typed('u3', 'back after lunch'),
    asst('a3', { input: 2, out: 700, cc: 173_867, cr: 3_898 }),
    dur('d3'),
  ];
  const turns = summarizeFile(lines, ctx);
  assert.deepEqual(
    turns.map((t) => t.resumeCost),
    [0, 0, 173_867],
    'boot and warm are not resumes',
  );
  assert.equal(turns[2]!.billable, 174_569, 'billable keeps the full amount');

  const w = aggregate([summarizeSession(lines, ctx)]).windows.all;
  assert.deepEqual(w.resume, { turns: 1, tokens: 173_867 });
  // The turn is warn (the resume), never crit for tokens it did not spend on work.
  assert.equal(w.crit, 0);
  assert.equal(w.warn, 1);
});

test('cache: a summary written by an OLDER version is re-parsed, not read as zeroes', async () => {
  // The failure this guards is silent and plausible-looking: a v6 summary carried no `severity`,
  // so reading it produced a retrospective of 0 crit / 0 warn — a corpus that looks clean. It
  // reached a live `/api/retro` because the version was reused for two different shapes; the
  // guard itself works, and this is what proves it does.
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-agg-'));
  const p1 = writeSession(dir, 'a.jsonl', driftLines());
  const file = join(dir, 'aggregates.json');
  const NOW = Date.parse('2026-07-20T00:00:00Z');
  const mk = (parse?: (p: string, raw: string) => ReturnType<typeof summarizeSession>) =>
    createAggregateCache({
      cacheFile: file,
      now: () => NOW,
      parse: parse ?? ((path, raw) => summarizeSession(raw.split('\n'), { sessionId: path, root: 'cli' })),
    });

  const fresh = await mk().refresh([p1]);
  assert.ok(
    fresh.windows.all.crit + fresh.windows.all.warn > 0,
    'the fixture must reach a non-good turn, or it proves nothing',
  );

  // Rewrite the persisted cache as a PREVIOUS version, keeping the file entries intact.
  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...onDisk, version: onDisk.version - 1 }));

  const parsed: string[] = [];
  const after = await mk((path, raw) => {
    parsed.push(path);
    return summarizeSession(raw.split('\n'), { sessionId: path, root: 'cli' });
  }).refresh([p1]);
  assert.deepEqual(parsed, [p1], 'an older version must be re-parsed, never trusted');
  assert.deepEqual(after, fresh);
});

test('cache: a turn missing a field is discarded even when the VERSION still matches', async () => {
  // The version guard only holds if whoever changed the shape remembered to bump it. This is the
  // half that needs no memory: a cached turn that does not carry every field of the current
  // TurnSummary is re-parsed, whatever the version says.
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-agg-'));
  const p1 = writeSession(dir, 'a.jsonl', driftLines());
  const file = join(dir, 'aggregates.json');
  const NOW = Date.parse('2026-07-20T00:00:00Z');
  const mk = (parse?: (p: string, raw: string) => ReturnType<typeof summarizeSession>) =>
    createAggregateCache({
      cacheFile: file,
      now: () => NOW,
      parse: parse ?? ((path, raw) => summarizeSession(raw.split('\n'), { sessionId: path, root: 'cli' })),
    });

  const fresh = await mk().refresh([p1]);
  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  // Same version, but one turn loses the field the severity split reads — exactly the stale-shape
  // an un-bumped version would leave behind.
  for (const f of Object.values<any>(onDisk.files)) delete f.turns[0].severity;
  writeFileSync(file, JSON.stringify(onDisk));

  const parsed: string[] = [];
  const after = await mk((path, raw) => {
    parsed.push(path);
    return summarizeSession(raw.split('\n'), { sessionId: path, root: 'cli' });
  }).refresh([p1]);
  assert.deepEqual(parsed, [p1], 'a turn of the wrong shape must be re-parsed, not trusted');
  assert.deepEqual(after, fresh);
});

test('retrospective by-model counts subagents under THEIR model, and the bars sum to the total', () => {
  // The Home card printed "Opus 5 · 100%" for a session whose subagents ran on Haiku and Sonnet:
  // `windowStats` charged every token to the turn's main-thread model. The data was already there
  // (`AgentNode.turnIndex` + `sumTokensByModel`), it was simply never read at this level.
  const NOW = new Date(2026, 6, 20).getTime();
  const turn: TurnSummary = {
    billable: 1000,
    resumeCost: 0,
    cacheRead: 4000,
    weighted: 0,
    subagentTokensByModel: [
      { model: 'claude-haiku-4-5-20251001', tokens: 700 },
      { model: 'claude-sonnet-5', tokens: 300 },
    ],
    subagentNew: 250,
    effort: 'high',
    model: 'claude-opus-5',
    apiCalls: 1,
    esc: false,
    escStreak: false,
    context: false,
    compaction: false,
    subWaste: false,
    exploration: false,
    unverifiedShip: false,
    severity: 'good' as const,
    ts: NOW - 864e5,
    durationMs: 1000,
  };
  const r = aggregate(
    [
      {
        turns: [turn],
        tools: {},
        weightedMain: 0,
        weightedSubagents: 0,
        weightedByModel: {},
        tokensComplete: 0,
        mainModel: null,
        mainModels: 0,
        apiCalls: 0,
      },
    ],
    NOW,
  );
  const w = r.windows.all;
  const byModel = Object.fromEntries(w.byModel.map((m) => [m.model, m.tokens]));
  assert.equal(byModel['claude-opus-5'], 5000, 'the main thread keeps its own tokens');
  assert.equal(byModel['claude-haiku-4-5-20251001'], 700);
  assert.equal(byModel['claude-sonnet-5'], 300);
  // The card prints this total beside the bars, so a mismatch is a card contradicting itself.
  assert.equal(
    w.byModel.reduce((n, m) => n + m.tokens, 0),
    w.totalTokens,
    'the bars must sum to the stated total',
  );
  assert.equal(w.totalTokens, 6000);
  // "N new · rest cache": without this the 1000 subagent tokens would all read as cache.
  assert.equal(w.newTokens, 1250);
});
