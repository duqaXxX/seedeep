import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentNode, ToolNode, TreeSnapshot, TurnNode } from '../src/core/session-tree.ts';
import {
  bucketFor,
  compactionCost,
  compactionTail,
  computeVerdict,
  computeVerdicts,
  turnFillShare,
  turnResumeCost,
  turnWork,
} from '../src/core/verdict.ts';

// Minimal factories — the verdict reads only a handful of fields; cast the rest.
const mkTurn = (o: Partial<TurnNode> = {}): TurnNode =>
  ({
    index: 1,
    prompt: '',
    command: null,
    kind: 'work',
    startedAt: null,
    state: 'done',
    durationMs: null,
    messageCount: null,
    apiCalls: 1,
    models: [],
    efforts: [],
    deltaFill: 0,
    fillEnd: 0,
    breakdown: { input: 0, cacheRead: 0, cacheCreation: 0 },
    cacheTotals: { read: 0, created: 0 },
    inputTotal: 0,
    out: 0,
    agentIds: [],
    skills: [],
    commands: [],
    compaction: false,
    firstCall: null,
    rebuildExpected: false,
    result: '',
    lastNarration: null,
    ...o,
  }) as TurnNode;

/** A turn whose first call re-created `created` of a `fill`-sized prompt. */
const opened = (created: number, fill: number, o: Partial<TurnNode> = {}): TurnNode =>
  mkTurn({ firstCall: { cacheCreation: created, fill }, cacheTotals: { read: 0, created }, ...o });

const tool = (turnIndex: number, name: string, arg: string): ToolNode =>
  ({ id: name + arg + turnIndex, name, ms: 1, arg, ctx: 0, turnIndex }) as ToolNode;
const read = (turnIndex: number, arg: string): ToolNode => tool(turnIndex, 'Read', arg);
const sub = (turnIndex: number, outLen: number, volume = 0, title = 'explore the tree'): AgentNode =>
  ({ agentId: 'a', agentType: 'explore', title, outLen, volume, turnIndex }) as AgentNode;

// `turnList` is part of the snapshot the verdict reads (the neighbour facts), so a fixture that
// omits it is not a snapshot. Tests that need a neighbour pass their own list.
const snap = (o: { mainTools?: ToolNode[]; subagents?: AgentNode[]; turnList?: TurnNode[] }): TreeSnapshot =>
  ({ mainTools: o.mainTools ?? [], subagents: o.subagents ?? [], turnList: o.turnList ?? [] }) as TreeSnapshot;

test('wasted subagent: large returned output → crit', () => {
  const v = computeVerdict(mkTurn(), snap({ subagents: [sub(1, 18000, 120000)] }));
  assert.equal(v.severity, 'crit');
  assert.equal(v.findings[0]!.kind, 'wasted-subagent');
});

test('compaction on a WORK turn → crit (involuntary overflow)', () => {
  assert.equal(computeVerdict(mkTurn({ compaction: true, kind: 'work' }), snap({})).severity, 'crit');
});

test('compaction on a /compact context turn → good (deliberate reset, not waste)', () => {
  // Regression: a user-typed /compact is kind 'context' with compaction:true; it must NOT fire crit.
  assert.equal(
    computeVerdict(mkTurn({ compaction: true, kind: 'context', command: 'compact' }), snap({})).severity,
    'good',
  );
});

// ─── compaction cost: the turn's own rebuild PLUS the tail the next turn pays ──
// Measured over 61 real compaction turns: median 49 577 inside the turn and 28 121 on the next
// turn's first call, against 119 on an ordinary turn. Before this the tail was attributed to
// nobody, and the finding printed no cost at all.

test("compaction cost = own cache_creation + the NEXT work turn's first-call rebuild", () => {
  const t1 = mkTurn({ index: 1, compaction: true, cacheTotals: { read: 0, created: 50_000 } });
  const t2 = mkTurn({ index: 2, firstCall: { cacheCreation: 28_000, fill: 60_000 } });
  assert.equal(compactionCost(t1, t2), 78_000);
  assert.equal(compactionTail(t1, t2), 28_000);
});

test('compaction: `cost` carries only what THIS turn paid; the tail is named in the text', () => {
  // The share card divides `cost` by the turn's own billable, so a cross-turn total there
  // printed "> 100% of the turn" on 39 of 60 real compaction turns.
  const t1 = mkTurn({ index: 1, compaction: true, cacheTotals: { read: 0, created: 50_000 } });
  const t2 = mkTurn({ index: 2, firstCall: { cacheCreation: 28_000, fill: 60_000 } });
  const f = computeVerdicts(snap({ turnList: [t1, t2] })).get(1)!.findings[0]!;
  assert.equal(f.kind, 'compaction');
  assert.equal(f.cost, '50.0k');
  assert.match(f.text, /\+28\.0k on the next turn/);
});

test('compaction cost: a session that ENDS on the compaction reports only its own term', () => {
  const t1 = mkTurn({ index: 1, compaction: true, cacheTotals: { read: 0, created: 50_000 } });
  assert.equal(compactionCost(t1, null), 50_000);
  const f = computeVerdicts(snap({ turnList: [t1] })).get(1)!.findings[0]!;
  assert.equal(f.cost, '50.0k');
  assert.doesNotMatch(f.text, /next turn/, 'no tail to name');
});

test('compaction tail: the next turn is the IMMEDIATE one, live included', () => {
  // It is the live turn that pays an open session's compaction tail. Filtering live turns out
  // made `next` the turn after it, so the cost quoted a different cache miss entirely.
  const t1 = mkTurn({ index: 1, compaction: true, cacheTotals: { read: 0, created: 50_000 } });
  const live = mkTurn({ index: 2, state: 'live', firstCall: { cacheCreation: 28_000, fill: 60_000 } });
  const t3 = mkTurn({ index: 3, firstCall: { cacheCreation: 999_000, fill: 1_000_000 } });
  const f = computeVerdicts(snap({ turnList: [t1, live, t3] })).get(1)!.findings[0]!;
  assert.match(f.text, /\+28\.0k on the next turn/, 'the live turn, not the one after it');
});

test("compaction tail is NOT removed from the next turn's work", () => {
  // A product decision (2026-07-27): the tail is REPORTED as the compaction's cost, not
  // subtracted from the turn that pays it, unlike a resume. Flipping this would silently move
  // 2.2% of the corpus billable out of what counts as work.
  const t2 = mkTurn({ index: 2, firstCall: { cacheCreation: 28_000, fill: 60_000 }, inputTotal: 28_000 });
  assert.equal(turnWork(t2), 28_000);
});

// ─── esc: a lone one is the recommended behaviour, a streak is the anti-pattern ─
// "Course-correct early and often" vs "If you've corrected Claude more than twice on the same
// issue in one session, the context is cluttered with failed approaches." Measured: 127 of 176
// interrupted turns are lone, so flagging all of them penalised correct usage on 72% of hits.

test('esc: a LONE interruption is not a finding', () => {
  const t = mkTurn({ index: 1, state: 'interrupted', inputTotal: 5000, out: 100 });
  const v = computeVerdicts(snap({ turnList: [t] })).get(1)!;
  assert.equal(v.severity, 'good');
  assert.equal(v.findings.length, 0);
});

test('esc: the SECOND interruption in a row → warn, and only the second one', () => {
  const t1 = mkTurn({ index: 1, state: 'interrupted' });
  const t2 = mkTurn({ index: 2, state: 'interrupted', inputTotal: 5000 });
  const all = computeVerdicts(snap({ turnList: [t1, t2] }));
  assert.equal(all.get(1)!.severity, 'good', 'the first of a streak IS a lone Esc when it closes');
  assert.equal(all.get(2)!.severity, 'warn');
  assert.equal(all.get(2)!.findings[0]!.kind, 'esc');
  assert.match(all.get(2)!.findings[0]!.text, /second correction in a row/);
});

test('esc: a completed turn between two interruptions breaks the streak', () => {
  const list = [
    mkTurn({ index: 1, state: 'interrupted' }),
    mkTurn({ index: 2, state: 'done' }),
    mkTurn({ index: 3, state: 'interrupted' }),
  ];
  const all = computeVerdicts(snap({ turnList: list }));
  assert.deepEqual(
    [1, 2, 3].map((i) => all.get(i)!.severity),
    ['good', 'good', 'good'],
  );
});

test('esc: only closed WORK turns count as the previous turn', () => {
  // A /clear typed between two Esc is kind 'context' — it is not a correction, so it must not
  // make the second interruption look consecutive... it must not break the streak either: the
  // neighbour list is work turns only, so #1 and #3 stay adjacent.
  const list = [
    mkTurn({ index: 1, state: 'interrupted' }),
    mkTurn({ index: 2, kind: 'context', command: 'clear' }),
    mkTurn({ index: 3, state: 'interrupted' }),
  ];
  assert.equal(computeVerdicts(snap({ turnList: list })).get(3)!.severity, 'warn');
});

// ─── context fill ─────────────────────────────────────────────────────────────
// "The context window is the most important resource to manage… performance degrades as it fills."

test('context: ≥70% of a MAPPED window → warn', () => {
  const t = mkTurn({ index: 1, models: ['claude-sonnet-4-6'], fillEnd: 150_000 }); // 75% of 200k
  const v = computeVerdicts(snap({ turnList: [t] })).get(1)!;
  assert.equal(v.severity, 'warn');
  assert.equal(v.findings[0]!.kind, 'context');
  assert.match(v.findings[0]!.text, /context 75% full at the end of the turn \(150\.0k\)/);
  // No `cost`: it means "tokens this finding accounts for", and a fill is state, not spend.
  // Summed as spend by the share card it printed a 122 097% "of the turn" on a real session.
  assert.equal(v.findings[0]!.cost, undefined);
});

test('context: below the threshold → nothing', () => {
  const t = mkTurn({ index: 1, models: ['claude-sonnet-4-6'], fillEnd: 139_000 }); // 69.5%
  assert.equal(computeVerdicts(snap({ turnList: [t] })).get(1)!.severity, 'good');
});

test('context: an UNMAPPED model is skipped, never guessed', () => {
  // The failure this prevents: a fallback 200k denominator printed "170% full" on a session
  // actually running at 1M. A fabricated denominator is worse than no finding.
  const t = mkTurn({ index: 1, models: ['claude-nextgen-9'], fillEnd: 340_000 });
  assert.equal(turnFillShare(t), null);
  assert.equal(computeVerdicts(snap({ turnList: [t] })).get(1)!.severity, 'good');
  assert.equal(turnFillShare(mkTurn({ models: [], fillEnd: 900_000 })), null, 'no model at all is also a guess');
});

test('worst-of: esc streak (warn) + wasted subagent (crit) → crit, both findings present', () => {
  const list = [mkTurn({ index: 1, state: 'interrupted' }), mkTurn({ index: 2, state: 'interrupted' })];
  const v = computeVerdicts(snap({ turnList: list, subagents: [sub(2, 18_000)] })).get(2)!;
  assert.equal(v.severity, 'crit');
  assert.deepEqual(v.findings.map((f) => f.kind).sort(), ['esc', 'wasted-subagent']);
});

// ─── positives: the verdict's second face ─────────────────────────────────────
// Anchored, and deliberately narrow. A positive must never move a severity.

test('positive: ran a check before committing — anchored on the SHIP', () => {
  const t = mkTurn({ index: 1 });
  const v = computeVerdicts(
    snap({
      turnList: [t],
      mainTools: [tool(1, 'Edit', '~/p/src/a.ts'), tool(1, 'Bash', 'bun test'), tool(1, 'Bash', 'git commit -m x')],
    }),
  ).get(1)!;
  assert.equal(v.severity, 'good');
  assert.deepEqual(
    v.positives.map((p) => p.kind),
    ['verified'],
  );
});

test('positive: a check on a SCRATCHPAD file is not a ship', () => {
  // The false-positive class that killed the loose rule: a prototype written to a scratchpad is
  // not code being shipped. 4 of 8 hand-read hits of the loose rule were exactly this.
  // The path is the shape `anon` really produces for a scratchpad — the earlier fixture used
  // `/tmp/scratchpad/…`, which the live pipeline never emits, so it proved nothing about it.
  const t = mkTurn({ index: 1 });
  const v = computeVerdicts(
    snap({
      turnList: [t],
      mainTools: [
        tool(1, 'Write', '~scratch/p/proto.ts'),
        tool(1, 'Bash', 'bun test'),
        tool(1, 'Bash', 'git commit -m x'),
      ],
    }),
  ).get(1)!;
  assert.deepEqual(v.positives, []);
});

test('positive: project code merely NAMED like a throwaway still ships', () => {
  // What the word match got wrong: `src/prototypes/…` is a real directory in a real repo, and
  // excluding it withheld the positive from a turn that did check before committing. Only the
  // session scratchpad is a throwaway; the name of a project folder says nothing.
  const t = mkTurn({ index: 1 });
  const v = computeVerdicts(
    snap({
      turnList: [t],
      mainTools: [
        tool(1, 'Write', 'src/prototypes/flow.ts'),
        tool(1, 'Bash', 'bun test'),
        tool(1, 'Bash', 'git commit -m x'),
      ],
    }),
  ).get(1)!;
  assert.deepEqual(
    v.positives.map((p) => p.kind),
    ['verified'],
  );
});

test('positive: committing WITHOUT a check earns nothing', () => {
  const t = mkTurn({ index: 1 });
  const v = computeVerdicts(
    snap({
      turnList: [t],
      mainTools: [tool(1, 'Edit', '~/p/src/a.ts'), tool(1, 'Bash', 'git commit -m x')],
    }),
  ).get(1)!;
  assert.deepEqual(v.positives, []);
});

test('positive: delegated the exploration — a subagent and almost no reads in main', () => {
  const t = mkTurn({ index: 1 });
  const v = computeVerdicts(snap({ turnList: [t], subagents: [sub(1, 100)], mainTools: [read(1, 'a.ts')] })).get(1)!;
  assert.deepEqual(
    v.positives.map((p) => p.kind),
    ['delegated'],
  );
});

test('positive: reading the tree in main yourself is not delegation, even with a subagent', () => {
  const t = mkTurn({ index: 1 });
  const reads = ['a', 'b', 'c', 'd'].map((f) => read(1, f + '.ts'));
  const v = computeVerdicts(snap({ turnList: [t], subagents: [sub(1, 100)], mainTools: reads })).get(1)!;
  assert.deepEqual(
    v.positives.map((p) => p.kind),
    [],
  );
});

test("positive: had its work reviewed — matched on the subagent's resolved title", () => {
  const t = mkTurn({ index: 1 });
  const reads = ['a', 'b', 'c', 'd'].map((f) => read(1, f + '.ts')); // rules out `delegated`
  const v = computeVerdicts(
    snap({
      turnList: [t],
      mainTools: reads,
      subagents: [sub(1, 100, 0, 'Review the branch diff')],
    }),
  ).get(1)!;
  assert.deepEqual(
    v.positives.map((p) => p.kind),
    ['reviewed'],
  );
});

test('positive: a lookup subagent does NOT earn the review credit', () => {
  // Measured: a bare `check` in the title credited 14 of 151 turns whose subagent was a lookup
  // ("Check the docs index headings", "Check latest Claude Code version on npm"), not a review.
  const t = mkTurn({ index: 1 });
  const reads = ['a', 'b', 'c', 'd'].map((f) => read(1, f + '.ts'));
  const v = computeVerdicts(
    snap({
      turnList: [t],
      mainTools: reads,
      subagents: [sub(1, 100, 0, 'Check the docs index headings')],
    }),
  ).get(1)!;
  assert.deepEqual(v.positives, []);
});

test('positives never change a severity', () => {
  const t = mkTurn({ index: 1, compaction: true });
  const v = computeVerdicts(
    snap({
      turnList: [t],
      mainTools: [tool(1, 'Edit', '~/p/src/a.ts'), tool(1, 'Bash', 'bun test'), tool(1, 'Bash', 'git commit -m x')],
    }),
  ).get(1)!;
  assert.equal(v.severity, 'crit', 'the compaction still decides');
  assert.deepEqual(
    v.positives.map((p) => p.kind),
    ['verified'],
  );
});

// ─── computeVerdicts: the whole snapshot in one pass ──────────────────────────
// The view computes every turn's verdict once per render and shares that map. It must agree
// with the single-turn function turn by turn, or two surfaces would disagree about a severity.

test('computeVerdicts agrees with computeVerdict on every turn, in one pass', () => {
  const turns = [
    mkTurn({ index: 1, models: ['claude-sonnet-4-6'], fillEnd: 180_000 }),
    mkTurn({ index: 2, state: 'interrupted' }),
    mkTurn({ index: 3, compaction: true }),
    mkTurn({ index: 4 }),
  ];
  const s = snap({
    mainTools: [read(1, 'a.ts'), read(4, 'x.ts'), read(1, 'a.ts'), read(4, 'y.ts')],
    subagents: [sub(2, 9000, 42_000)],
    turnList: turns,
  });

  const all = computeVerdicts(s);
  assert.deepEqual([...all.keys()], [1, 2, 3, 4]);
  for (const t of turns) assert.deepEqual(all.get(t.index), computeVerdict(t, s), 'turn #' + t.index);
  assert.equal(all.get(1)!.severity, 'warn', 'context 90% full');
  assert.equal(all.get(2)!.severity, 'crit', 'a big subagent output (the lone Esc is not a finding)');
  assert.equal(all.get(3)!.severity, 'crit', 'compaction');
  assert.equal(all.get(4)!.severity, 'good');
});

test('computeVerdicts: a tool or subagent with no turn is attributed to none', () => {
  const orphanRead = { ...read(1, 'a.ts'), turnIndex: null } as ToolNode;
  const s = snap({
    mainTools: [orphanRead, orphanRead, orphanRead],
    subagents: [{ ...sub(1, 9000), turnIndex: null } as AgentNode],
    turnList: [mkTurn({ index: 1 })],
  });
  assert.equal(computeVerdicts(s).get(1)!.severity, 'good');
});

// ─── resume: re-entry cost, split out of the turn's work ──────────────────────
// Both bounds are measured, not chosen: over 2788 real closed work turns the first call's
// cache_creation is bimodal (median 168 tokens, median 143 891 on the turns that rebuild), so
// the SHARE separates the populations and the token floor only keeps a tiny rebuild out.

test('resume: a first call that re-created ~all of a large prompt → warn, and it is not work', () => {
  const t = opened(173_867, 177_769, { inputTotal: 2, out: 714 });
  assert.equal(turnResumeCost(t), 173_867);
  assert.equal(turnWork(t), 173_867 + 2 + 714 - 173_867);
  const v = computeVerdict(t, snap({}));
  assert.equal(v.severity, 'warn');
  assert.equal(v.findings[0]!.kind, 'resume');
  assert.equal(v.findings[0]!.cost, '100% of the turn');
});

test('resume: below either bound it does not fire', () => {
  assert.equal(turnResumeCost(opened(49_999, 50_000)), 0, 'under the token floor');
  assert.equal(turnResumeCost(opened(60_000, 100_000)), 0, 'a 60% rebuild is context GROWTH, not re-entry');
  assert.equal(turnResumeCost(opened(80_000, 100_000)), 80_000, 'exactly at the share bound');
});

test('resume: never fires when the reducer says a rebuild was expected', () => {
  // The session's first call and the call after a compaction both re-create the prompt by
  // design. Measured: they are 32% of the turns whose first call rebuilds — calling them waste
  // would have made a quarter of the finding false.
  assert.equal(turnResumeCost(opened(200_000, 210_000, { rebuildExpected: true })), 0);
});

// ─── the `cost` invariant, enforced across every detector ─────────────────────
// An absolute cost must be a PORTION of the turn's billable, because the share card sums the
// absolute costs and divides by exactly that. Three detectors broke it in three different ways
// (a context SIZE, a subagent's own volume, a cross-turn tail) and together made 54% of real
// flagged turns print over 100%. This is the guard, not a re-test of the three fixes.

test('cost invariant: no turn can attribute more tokens to its findings than it spent', () => {
  const ABSOLUTE = /^~?([\d.]+)([kM]?)$/; // the share card's own parser
  const sum = (fs: readonly { cost?: string }[]) =>
    fs.reduce((a, f) => {
      const m = ABSOLUTE.exec((f.cost ?? '').trim());
      return a + (m ? parseFloat(m[1]!) * (m[2] === 'k' ? 1e3 : m[2] === 'M' ? 1e6 : 1) : 0);
    }, 0);

  // One turn built to trip EVERY detector at once: interrupted twice, compacted mid-turn, a
  // subagent that returned a huge payload after burning far more in its own window, a context
  // at 90%, a cold resume, and enough work to pass p95.
  const prev = mkTurn({ index: 1, state: 'interrupted' });
  const worst = mkTurn({
    index: 2,
    state: 'interrupted',
    compaction: true,
    models: ['claude-sonnet-4-6'],
    fillEnd: 180_000,
    firstCall: { cacheCreation: 200_000, fill: 210_000 },
    cacheTotals: { read: 0, created: 260_000 },
    inputTotal: 40_000,
    out: 5_000,
  });
  const next = mkTurn({ index: 3, firstCall: { cacheCreation: 90_000, fill: 100_000 } });
  const v = computeVerdicts(
    snap({
      turnList: [prev, worst, next],
      subagents: [sub(2, 40_000, 3_000_000, 'explore everything')], // 3M in ITS window, not ours
    }),
  ).get(2)!;

  assert.ok(v.findings.length >= 5, 'the fixture must trip most detectors, or it proves nothing');
  const billable = worst.inputTotal + worst.out + worst.cacheTotals.created;
  assert.ok(
    sum(v.findings) <= billable,
    `attributed ${sum(v.findings)} must not exceed the turn's ${billable} — findings: ` +
      v.findings.map((f) => `${f.kind}=${f.cost ?? '-'}`).join(', '),
  );
});

// `/api/baseline` is a network answer, and this function is what a share card runs it through. It
// used to reach straight into `.byEffort`, so anything that was not a baseline threw a TypeError —
// which the Share button catches and discards, leaving no card and no message. That is not a
// hypothetical: a test fake answering `ok` to every URL put a session ROSTER in there, and because
// the value is memoised for the life of the page, every later share was silently dead. A shape it
// cannot read is the same situation as no baseline at all, and that case already has an answer.
test('bucketFor: an answer that is not a baseline is no baseline, never a throw', () => {
  const good = { byEffort: { high: { p50: 10, p90: 20, p95: 30, count: 50 } } } as any;
  assert.deepEqual(bucketFor(good, 'high'), { p50: 10, p90: 20, p95: 30, count: 50 });

  // The roster shape that actually caused it, plus the neighbours of the same mistake.
  for (const notABaseline of [[], [{ sessionId: 'a', project: 'p' }], {}, { byEffort: null }, 'nope', 7]) {
    assert.equal(
      bucketFor(notABaseline as any, 'high'),
      null,
      `bucketFor(${JSON.stringify(notABaseline)}) must be null`,
    );
  }
});
