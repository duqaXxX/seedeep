import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  backgroundCommands,
  contextFraction,
  contextHogs,
  maxReturnedLen,
  maxToolCount,
  runningBackground,
  scopeToTurn,
  skillShare,
  subagentsByWeight,
  subagentsChronological,
  tokenUsage,
  turnCostStats,
} from '../src/core/selectors.ts';

const agent = (over: Record<string, unknown> = {}): any => ({
  agentId: 'a',
  agentType: 'general',
  model: null,
  fill: 0,
  window: 200_000,
  pct: 0,
  estimated: false,
  state: 'done',
  startedAt: null,
  durationMs: null,
  tools: [],
  prompt: null,
  outputFull: null,
  outLen: null,
  volume: 0,
  volumeEstimated: false,
  volumeBreakdown: null,
  volumeByModel: [],
  ...over,
});
const tool = (over: Record<string, unknown> = {}): any => ({ name: 'Read', arg: null, ctx: 0, ms: null, ...over });

// What makes a session still be waiting on something after it has stopped talking. The launch
// receipt closes in milliseconds — the receipt is not the command — so nothing but `background`
// paired with a MISSING `outcome` can answer it.
test('runningBackground: launched and not yet told what became of it, oldest first', () => {
  const at = (s: number) => '2026-07-14T10:00:0' + s + '.000Z';
  const running = runningBackground([
    tool({ id: 't1', name: 'Bash', arg: 'bun run dev', background: true, startedTs: at(3), turnIndex: 2 }),
    tool({ id: 't2', name: 'Bash', arg: 'bun test', background: true, startedTs: at(1), turnIndex: 1 }),
    // Reported its fate: no longer running, whatever that fate was.
    tool({
      id: 't3',
      name: 'Bash',
      arg: 'ls',
      background: true,
      startedTs: at(0),
      // Both fields, because the reducer only ever sets them together — the notification that
      // carries the sentence is the one that carries the status. A node with the sentence alone
      // is a shape no real session produces, and `state` keys on the STATUS.
      outcome: 'completed (exit code 0)',
      outcomeStatus: 'completed',
    }),
    // A failure is an outcome too — the row goes red, but nothing is still going.
    tool({
      id: 't4',
      name: 'Bash',
      arg: 'boom',
      background: true,
      startedTs: at(0),
      outcome: 'failed',
      outcomeStatus: 'failed',
      error: true,
    }),
    // An ordinary call, however long it took: it did not launch anything.
    tool({ id: 't5', name: 'Bash', arg: 'sleep 1', ms: 1000 }),
  ]);

  assert.deepEqual(
    running.map((c) => [c.toolUseId, c.command, c.turnIndex]),
    [
      ['t2', 'bun test', 1],
      ['t1', 'bun run dev', 2],
    ],
  );
  assert.equal(running[0]?.since, at(1), 'the launch INSTANT travels, never an age');
  assert.deepEqual(runningBackground([]), []);
});

test('tokenUsage: the four API categories and their total, from the scope sums', () => {
  // cacheRead/cacheWrite come from cacheTotals (summed); input/output from the scope sums.
  // breakdown is the LAST call and must NOT leak in — it is a different question.
  const m = {
    breakdown: { input: 4, cacheRead: 199_000, cacheCreation: 1_000 },
    cacheTotals: { read: 400_000, created: 200_000 },
    inputTotal: 12_000,
    outputTotal: 3_000,
    weighted: 0,
    weightedByModel: [],
  } as any;
  assert.deepEqual(tokenUsage(m), {
    input: 12_000,
    cacheWrite: 200_000,
    cacheRead: 400_000,
    output: 3_000,
    total: 615_000,
  });
});

test('tokenUsage: an empty scope is all zeros, total zero', () => {
  const m = {
    cacheTotals: { read: 0, created: 0 },
    inputTotal: 0,
    outputTotal: 0,
    weighted: 0,
    weightedByModel: [],
  } as any;
  assert.deepEqual(tokenUsage(m), { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, total: 0 });
});

test('subagentsByWeight: ranks by tool count desc, without mutating the input', () => {
  const input = [
    agent({ agentId: 'few', tools: [tool()] }),
    agent({ agentId: 'many', tools: [tool(), tool(), tool()] }),
  ];
  assert.deepEqual(
    subagentsByWeight(input).map((a) => a.agentId),
    ['many', 'few'],
  );
  assert.deepEqual(
    input.map((a) => a.agentId),
    ['few', 'many'],
    'input must not be reordered',
  );
});

test('subagentsChronological: launch order, untimestamped spawns last', () => {
  const out = subagentsChronological([
    agent({ agentId: 'no-ts', startedAt: null }),
    agent({ agentId: 'later', startedAt: '2026-07-12T10:05:00Z' }),
    agent({ agentId: 'earlier', startedAt: '2026-07-12T10:00:00Z' }),
  ]);
  assert.deepEqual(
    out.map((a) => a.agentId),
    ['earlier', 'later', 'no-ts'],
  );
});

test('maxToolCount / maxReturnedLen: floor at 1 so they are safe bar denominators', () => {
  assert.equal(maxToolCount({ mainTools: [], subagents: [] } as any), 1);
  assert.equal(maxReturnedLen([]), 1);
  assert.equal(maxToolCount({ mainTools: [tool()], subagents: [agent({ tools: [tool(), tool()] })] } as any), 2);
  assert.equal(maxReturnedLen([agent({ outLen: 42 }), agent({ outLen: null })]), 42);
});

test('contextHogs: ranks by output size, excluding tools that produced nothing', () => {
  const hogs = contextHogs([
    tool({ name: 'small', ctx: 10 }),
    tool({ name: 'pending', ctx: 0 }), // tool-end not in yet — not a hog
    tool({ name: 'big', ctx: 500 }),
  ]);
  assert.deepEqual(
    hogs.map((t) => t.name),
    ['big', 'small'],
  );
});

test('contextFraction: final fill over window; 0 when the window is unknown, never Infinity', () => {
  // The bar is CONTEXT fill, not consumption — a cumulative volume larger than the window must
  // never leak into this fraction (that was the old consumedFraction bug: >100% bars).
  assert.equal(contextFraction({ fill: 50_000, window: 200_000 }), 0.25);
  assert.equal(contextFraction({ fill: 50_000, window: 0 }), 0);
});

test('skillShare: percentage of attributed turns; null when nothing is attributed', () => {
  const skills = [{ turns: 30 }, { turns: 10 }];
  assert.equal(skillShare(skills[0]!, skills), 75);
  assert.equal(skillShare({ turns: 0 }, [{ turns: 0 }]), null);
});

// --- turn scoping selectors ---

function makeSnapshot(over: Record<string, unknown> = {}): any {
  const base = {
    main: {
      fill: 50000,
      window: 1000000,
      pct: 5,
      estimated: false,
      model: 'm',
      models: ['m'],
      regions: [],
      breakdown: { input: 100, cacheRead: 49800, cacheCreation: 100 },
    },
    mainTools: [
      { name: 'Read', ms: 50, turnIndex: 1 },
      { name: 'Bash', ms: 80, turnIndex: 2 },
    ],
    filesChanged: [
      { path: 'src/a.ts', turnIndex: 1, ts: 't1' },
      { path: 'src/a.ts', turnIndex: 1, ts: 't2' },
      { path: 'src/b.ts', turnIndex: 2, ts: 't3' },
    ],
    subagents: [
      // via the helper, not a literal: a node spelled out by hand goes stale the moment
      // AgentNode grows a field, and the reducer's own nodes always carry all of them.
      agent({ agentId: 'ag1', agentType: 'general-purpose', turnIndex: 1, fill: 10000, pct: 5 }),
    ],
    // session-wide counts: /paste-image typed twice across the session, tdd invoked twice
    skills: [
      { name: 'tdd', turns: 4, invokes: 2 },
      { name: 'brainstorm', turns: 1, invokes: 0 },
    ],
    commands: [{ name: 'paste-image', count: 2 }],
    turnList: [
      {
        index: 1,
        prompt: 'fix bug',
        startedAt: null,
        state: 'done',
        durationMs: 5000,
        messageCount: 3,
        apiCalls: 2,
        deltaFill: 30000,
        fillEnd: 30000,
        breakdown: { input: 50, cacheRead: 29900, cacheCreation: 50 },
        inputTotal: 100,
        out: 150,
        agentIds: ['ag1'],
        skills: [{ name: 'tdd', turns: 3, invokes: 1 }],
        commands: [],
        compaction: false,
        result: 'patch applied',
      },
      {
        index: 2,
        prompt: 'review',
        startedAt: null,
        state: 'interrupted',
        durationMs: null,
        messageCount: null,
        apiCalls: 3,
        deltaFill: 20000,
        fillEnd: 50000,
        breakdown: { input: 100, cacheRead: 49800, cacheCreation: 100 },
        inputTotal: 200,
        out: 200,
        agentIds: [],
        skills: [{ name: 'brainstorm', turns: 1, invokes: 0 }],
        commands: [{ name: 'paste-image', count: 1 }],
        compaction: false,
        result: null,
      },
    ],
    turns: 2,
    apiCalls: 5,
    compactions: [],
    seq: 10,
  };
  return { ...base, ...over };
}

test('scopeToTurn: unknown index returns snapshot unchanged', () => {
  const s = makeSnapshot();
  const r = scopeToTurn(s, 99);
  assert.equal(r, s, 'same reference returned for unknown index');
});

test('scopeToTurn: filters mainTools and subagents to the requested turn', () => {
  const s = makeSnapshot();
  const r = scopeToTurn(s, 1);
  assert.equal(r.mainTools.length, 1, 'only Read belongs to turn 1');
  assert.equal(r.mainTools[0]!.name, 'Read');
  assert.equal(r.subagents.length, 1, 'ag1 spawned in turn 1');
  assert.equal(r.subagents[0]!.agentId, 'ag1');
  assert.equal(
    r.mainTools.find((t: any) => t.name === 'Bash'),
    undefined,
    'Bash from turn 2 excluded',
  );
});

test("scopeToTurn: skills and commands are the turn's own, with TURN-LOCAL counts", () => {
  const s = makeSnapshot();
  const r1 = scopeToTurn(s, 1);
  assert.deepEqual(
    r1.skills.map((x: any) => x.name),
    ['tdd'],
  );
  assert.deepEqual(r1.commands, [], 'turn 1 had no commands');
  // the session says tdd was invoked 2× / active for 4 turns; turn 1 saw 1× / 3
  assert.equal(r1.skills[0]!.invokes, 1, "invokes are the turn's, not the session's");
  assert.equal(r1.skills[0]!.turns, 3, "turns are the turn's, not the session's");

  const r2 = scopeToTurn(s, 2);
  assert.deepEqual(
    r2.skills.map((x: any) => x.name),
    ['brainstorm'],
  );
  assert.deepEqual(
    r2.commands.map((x: any) => x.name),
    ['paste-image'],
  );
  // the session counted /paste-image twice; this turn used it once — the widget must say ×1
  assert.equal(r2.commands[0]!.count, 1, "command count is the turn's, not the session's");
});

test('scopeToTurn: main context stats reflect the selected turn (fillEnd, output, breakdown)', () => {
  const s = makeSnapshot();
  const r = scopeToTurn(s, 1);
  assert.equal(r.main.fill, 30000, 'fill = turn 1 fillEnd');
  assert.equal(r.main.pct, 3, 'pct = round(30000/1000000*100)');
  assert.equal(r.main.outputTotal, 150);
  assert.deepEqual(r.main.breakdown, { input: 50, cacheRead: 29900, cacheCreation: 50 });
  assert.equal(r.turns, 1);
  assert.equal(r.apiCalls, 2, 'apiCalls from turn');
});

test('turnCostStats: counts interrupted turns', () => {
  const s = makeSnapshot();
  assert.equal(turnCostStats(s).escCount, 1, 'one interrupted turn');
});

test('turnCostStats: no interrupted turns → escCount 0', () => {
  const s = makeSnapshot();
  s.turnList[1].state = 'done';
  assert.equal(turnCostStats(s).escCount, 0);
});

test('turnCostStats: empty turnList returns zero', () => {
  const s = makeSnapshot({ turnList: [] });
  assert.deepEqual(turnCostStats(s), { escCount: 0 });
});

// The probe's half of the same question. `vanishedTs` is what an OPEN session has instead of
// `opts.ended`: nobody ever said what became of the command, so it can only ever read `unknown` —
// and the figure beside it is the last instant it was SEEN, which is a BOUND, not a duration.
test('backgroundCommands: a command the probe found gone reads unknown, with its duration as a bound', () => {
  const base = {
    name: 'Bash',
    arg: 'bun run dev',
    background: true as const,
    backgroundTaskId: 'bt1',
    startedTs: '2026-07-14T10:00:00.000Z',
  };
  const [gone] = backgroundCommands(
    [tool({ ...base, id: 't1', vanishedTs: '2026-07-14T10:05:00.000Z', lastSeenAliveTs: '2026-07-14T10:04:20.000Z' })],
    { ended: false },
  );
  assert.equal(gone?.state, 'unknown', 'the session is open and the transcript still says nothing');
  assert.equal(gone?.ranMs, 260_000, 'launch → last sighting, never launch → verdict');
  assert.equal(gone?.ranAtLeast, true, 'and the surface must say so rather than print it as measured');

  // Seen gone before it was ever seen alive — seedeep started watching too late. There is no bound
  // to state, and inventing one from the launch would be a duration nobody measured.
  const [never] = backgroundCommands([tool({ ...base, id: 't2', vanishedTs: '2026-07-14T10:05:00.000Z' })], {
    ended: false,
  });
  assert.equal(never?.state, 'unknown');
  assert.equal(never?.ranMs, null);
  assert.equal(never?.ranAtLeast, false);

  // And the probe never outranks the transcript: a fate arrived, so the fate is what shows.
  const [told] = backgroundCommands(
    [
      tool({
        ...base,
        id: 't3',
        vanishedTs: '2026-07-14T10:05:00.000Z',
        lastSeenAliveTs: '2026-07-14T10:04:20.000Z',
        outcome: 'Background command "dev" failed with exit code 7',
        outcomeStatus: 'failed',
        outcomeTs: '2026-07-14T10:06:00.000Z',
      }),
    ],
    { ended: false },
  );
  assert.equal(told?.state, 'failed');
  assert.equal(told?.ranMs, 360_000, 'measured to the notification, and no longer a bound');
  assert.equal(told?.ranAtLeast, false);
});
