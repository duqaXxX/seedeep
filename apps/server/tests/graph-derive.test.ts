import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  delegatedWork,
  displayState,
  entryLabel,
  entryTitle,
  isMarker,
  returnedWork,
  toolDuration,
  turnCls,
  turnIsWorking,
  WF_SILENT_MS,
  workOrdinal,
} from '../src/core/graph-derive.ts';
import { type AgentNode, hasStarted, type TreeSnapshot, type TurnNode } from '../src/core/session-tree.ts';
import { isModelBusy, isWorking } from '../src/core/types.ts';

// Full nodes, not the fields each assertion happens to read: these are typed against the
// reducer's own interfaces, so a field the reducer adds or renames breaks this file rather
// than letting the fixtures drift into a shape the code never sees.
function turn(over: Partial<TurnNode> = {}): TurnNode {
  return {
    index: 1,
    prompt: 'do the thing',
    command: null,
    kind: 'work',
    startedAt: null,
    state: 'done',
    cutoff: false,
    durationMs: 1000,
    messageCount: 2,
    apiCalls: 3,
    deltaFill: 5000,
    fillEnd: 5000,
    breakdown: { input: 1, cacheRead: 2, cacheCreation: 3 },
    cacheTotals: { read: 2, created: 3 },
    inputTotal: 1,
    out: 10,
    weighted: 0,
    agentIds: [],
    firstCall: null,
    rebuildExpected: false,
    models: ['claude-opus-4-8'],
    efforts: [],
    skills: [],
    commands: [],
    compaction: false,
    result: 'done',
    lastNarration: null,
    activity: null,
    lastWordTs: null,
    ...over,
  };
}

function agent(over: Partial<AgentNode> = {}): AgentNode {
  return {
    kind: 'subagent',
    workflow: null,
    agentId: 'a1',
    agentType: 'general-purpose',
    model: 'claude-sonnet-5',
    title: 'Review task 5',
    efforts: [],
    fill: 100,
    window: 200000,
    pct: 0,
    estimated: false,
    state: 'running',
    startedAt: null,
    durationMs: null,
    tools: [],
    toolUseId: 'toolu_1',
    prompt: null,
    outputFull: null,
    outLen: 0,
    volume: 0,
    volumeEstimated: false,
    weighted: 0,
    volumeByModel: [],
    volumeBreakdown: null,
    turnIndex: 1,
    ...over,
  };
}

// Same rule as `agent()`: full node, typed against the reducer's own shape, so a field the
// workflow row gains lands here instead of drifting out of the fixtures.
function workflow(over: Partial<NonNullable<AgentNode['workflow']>> = {}): NonNullable<AgentNode['workflow']> {
  return {
    name: 'deep-research',
    runId: 'wf_1',
    agents: 8,
    running: 3,
    volume: 0,
    weighted: 0,
    breakdown: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    models: [],
    tokensByModel: [],
    lastActivityAt: null,
    members: [],
    ...over,
  };
}

const snapOf = (turns: TurnNode[]) => ({ turnList: turns }) as unknown as TreeSnapshot;

// ── Turn numbering: the "Turn 13 / 11" class of bug ──────────────────────────────────
// The timeline holds every entry, but a work turn is numbered among WORK turns only.

test('workOrdinal numbers among work turns, not among timeline entries', () => {
  const turns = [
    turn({ index: 1, kind: 'work' }),
    turn({ index: 2, kind: 'local', command: 'model' }),
    turn({ index: 3, kind: 'context', command: 'clear' }),
    turn({ index: 4, kind: 'work' }),
  ];
  const snap = snapOf(turns);
  assert.equal(workOrdinal(snap, turns[0]!), 1);
  // Entry 4 of 4, but only the SECOND work turn — numbering by entry index would say "4".
  assert.equal(workOrdinal(snap, turns[3]!), 2);
});

test('entryTitle names a work turn by ordinal and anything else by its command', () => {
  const turns = [turn({ index: 1, kind: 'work' }), turn({ index: 2, kind: 'local', command: 'model' })];
  const snap = snapOf(turns);
  assert.equal(entryTitle(snap, turns[0]!), 'Turn 1');
  assert.equal(entryTitle(snap, turns[1]!), '/model');
});

test('entryTitle is empty — never a partial title — when it has no snapshot or no turn', () => {
  const t = turn();
  assert.equal(entryTitle(null, t), '');
  assert.equal(entryTitle(snapOf([t]), null), '');
});

test('a command-less non-work entry falls back to /entry, never to "undefined"', () => {
  const t = turn({ kind: 'local', command: null });
  assert.equal(entryTitle(snapOf([t]), t), '/entry');
});

// ── Subagent state: what the view SAYS vs what the reducer SAW ────────────────────────

test('a running subagent on an ENDED session reads unknown, not running', () => {
  assert.equal(displayState(agent({ state: 'running' }), false), 'running');
  assert.equal(displayState(agent({ state: 'running' }), true), 'unknown');
});

test('a terminal state is reported as-is, ended or not', () => {
  for (const st of ['done', 'failed', 'killed'] as const) {
    assert.equal(displayState(agent({ state: st }), false), st);
    assert.equal(displayState(agent({ state: st }), true), st);
  }
});

test('a workflow silent past the threshold reads unknown; just under it still runs', () => {
  const now = 1_000_000_000;
  const wf = (lastActivityAt: number) =>
    agent({
      kind: 'workflow',
      state: 'running',
      workflow: workflow({ lastActivityAt }),
    });
  assert.equal(displayState(wf(now - WF_SILENT_MS - 1), false, now), 'unknown');
  assert.equal(displayState(wf(now - WF_SILENT_MS + 1), false, now), 'running');
});

test('the unknown verdict is derived, never latched: one fresh line and it runs again', () => {
  const now = 1_000_000_000;
  const mk = (lastActivityAt: number) =>
    agent({
      kind: 'workflow',
      state: 'running',
      workflow: workflow({ name: null, runId: 'wf_2', agents: 1, running: 1, lastActivityAt }),
    });
  const stale = mk(now - WF_SILENT_MS - 60_000);
  assert.equal(displayState(stale, false, now), 'unknown');
  // The same run after a subagent writes one line — no state is carried between calls.
  assert.equal(displayState(mk(now - 1000), false, now), 'running');
});

test('a plain subagent is NOT judged by silence — only a workflow run is', () => {
  const now = 1_000_000_000;
  // A single subagent may legitimately go quiet for far longer than a run's merged stream.
  assert.equal(displayState(agent({ state: 'running', kind: 'subagent' }), false, now), 'running');
});

// ── Small classifications ─────────────────────────────────────────────────────────────

test('toolDuration says "cut off" only for an unfinished tool on an ended session', () => {
  assert.equal(toolDuration(null, true), 'cut off');
  assert.notEqual(toolDuration(null, false), 'cut off');
  assert.notEqual(toolDuration(1200, true), 'cut off');
});

test('turnCls ranks interrupted over compaction over local over live', () => {
  assert.equal(turnCls(turn({ state: 'interrupted', compaction: true, kind: 'context' })), 'esc');
  assert.equal(turnCls(turn({ kind: 'context' })), 'cmp');
  assert.equal(turnCls(turn({ compaction: true })), 'cmp');
  assert.equal(turnCls(turn({ kind: 'local' })), 'loc');
  assert.equal(turnCls(turn({ state: 'live' })), 'lv');
  assert.equal(turnCls(turn()), '');
});

test('isMarker flags exactly the entries that would draw as nothing', () => {
  assert.equal(isMarker(turn({ deltaFill: 0 })), true);
  assert.equal(isMarker(turn({ deltaFill: -5000 })), false, 'a compaction freed context — still visible');
  assert.equal(isMarker(turn({ deltaFill: 1 })), false);
});

test('entryLabel prefixes the command that carried the args, and never doubles it', () => {
  assert.equal(entryLabel(turn({ prompt: 'opus', command: 'model' })), '/model opus');
  // Already a slash command: prefixing again would read "/clear /clear".
  assert.equal(entryLabel(turn({ prompt: '/clear', command: 'clear' })), '/clear');
  assert.equal(entryLabel(turn({ prompt: 'fix the bug', command: null })), 'fix the bug');
});

// ── A launch with nothing behind it ───────────────────────────────────────────────────
// Measured 2026-07-29: all 3 never-ended subagents in 910 ended sessions look exactly like
// this — no type, no tokens, no tool, no text — while 92.8% of the ones that end carry their
// own final text. A real agent leaves its first trace 0.07s after launch (max 0.30s over 1171
// spawns), so this cannot be a race against a young agent.

// Not `as const`: that makes `tools` a readonly tuple, which no longer fits Partial<AgentNode>.
const traceless: Partial<AgentNode> = { agentType: null, fill: 0, tools: [], outputFull: null };

test('hasStarted: any ONE sign of the agent is enough', () => {
  assert.equal(hasStarted(agent({ ...traceless })), false, 'no sign at all');
  assert.equal(hasStarted(agent({ ...traceless, agentType: 'explore' })), true, 'a type');
  assert.equal(hasStarted(agent({ ...traceless, fill: 1 })), true, 'tokens billed to it');
  assert.equal(hasStarted(agent({ ...traceless, tools: [{}] as never })), true, 'a tool it ran');
  assert.equal(hasStarted(agent({ ...traceless, outputFull: 'x' })), true, 'text it returned');
});

test('a traceless launch reads unknown even while the session is LIVE', () => {
  // The defect: nothing handled this on a live session, so it stayed "running" for as long as
  // the session stayed open, counted and listed the whole time.
  assert.equal(displayState(agent({ state: 'running', ...traceless }), false), 'unknown');
});

test('the unknown heals itself the moment the agent writes anything', () => {
  // Derived, never latched — the same property the workflow-silence rule has. Without it a
  // subagent seen in its first instants would be branded for the rest of the session.
  const young = agent({ state: 'running', ...traceless });
  assert.equal(displayState(young, false), 'unknown');
  assert.equal(displayState({ ...young, fill: 1 }, false), 'running', 'one usage line is enough');
});

test('a workflow row is exempt: its members are what work', () => {
  // A run's own node carries no type or tools by construction, so this rule would call every
  // live run unknown. The silence threshold above is the one that judges a run.
  const now = 1_000_000_000;
  const run = agent({ kind: 'workflow', state: 'running', ...traceless, workflow: workflow({ lastActivityAt: now }) });
  assert.equal(displayState(run, false, now), 'running');
});

// ── delegatedWork ──────────────────────────────────────────────────────────────
// The NOW panel's answer for a turn that says nothing because its work is elsewhere. It lives
// beside displayState for one reason, and this is the test of that reason: computed on the raw
// `state` instead (which is where it started), the panel said "/code-review is running in the
// background" while the Subagents card two inches away read "0 running" — one screen asserting
// both, on a synthetic session whose launch had left no trace. Caught in live verification.

const T0 = Date.parse('2026-08-03T10:00:00.000Z');
const NOW_MS = T0 + 341_000;

test('delegatedWork: the turn’s running agent, named and timed from its own launch', () => {
  const subs = [
    agent({ agentId: 'a1', title: '/code-review', turnIndex: 2, startedAt: new Date(T0).toISOString() }),
    agent({ agentId: 'a2', title: 'other turn', turnIndex: 1 }),
  ];
  assert.deepEqual(delegatedWork(2, subs, false, NOW_MS), { label: '/code-review', since: T0, count: 1 });
  assert.equal(delegatedWork(3, subs, false, NOW_MS), null, 'a turn that launched nothing has nothing running');
});

test('delegatedWork: it answers with displayState, so the panel cannot contradict the card', () => {
  // A launch with no trace of itself — no type, no tokens, no tool, no text — is `unknown`, not
  // running: the card does not list it, so the panel must not claim it either.
  const traceless = agent({ agentType: null, fill: 0, tools: [], outputFull: null, turnIndex: 2 });
  assert.equal(displayState(traceless, false, NOW_MS), 'unknown');
  assert.equal(delegatedWork(2, [traceless], false, NOW_MS), null);

  // And on an ENDED session `running` means the terminal signal never came, which is not work
  // still happening.
  const live = agent({ turnIndex: 2, startedAt: new Date(T0).toISOString() });
  assert.equal(delegatedWork(2, [live], false, NOW_MS)?.count, 1);
  assert.equal(delegatedWork(2, [live], true, NOW_MS), null);
});

test('delegatedWork: several agents are counted, and the FIRST one names the line', () => {
  const subs = [
    agent({ agentId: 'a1', title: 'second', turnIndex: 2, startedAt: new Date(T0 + 5_000).toISOString() }),
    agent({ agentId: 'a2', title: 'first', turnIndex: 2, startedAt: new Date(T0).toISOString() }),
    agent({ agentId: 'a3', title: 'done one', turnIndex: 2, state: 'done' }),
  ];
  assert.deepEqual(delegatedWork(2, subs, false, NOW_MS), { label: 'first', since: T0, count: 2 });
});

// ── turnIsWorking ─────────────────────────────────────────────────────────────
// The transcript cannot answer "is it working NOW". Claude Code writes a thinking block
// only when it closes, so after a background agent returns the parent file is silent for a median
// 11s (p90 33.1s, max 4m 5s over 321 real returns) — and seedeep drew that as finished while the
// terminal showed "Harmonizing… (50s · thinking)". The process is the authority, as it already is for the session itself.

test('turnIsWorking: the process answers for the last turn when the file has gone quiet', () => {
  const settled = { state: 'done' as const };
  assert.equal(turnIsWorking(settled, true, { ended: false, busy: true }), true, 'busy process, last turn');
  assert.equal(turnIsWorking(settled, true, { ended: false, busy: false }), false, 'idle process says nothing');
  // Only the LAST turn: an older entry is history whatever the process is doing.
  assert.equal(turnIsWorking(settled, false, { ended: false, busy: true }), false);
  // An ended session outranks everything: its process is gone, so nothing is happening.
  assert.equal(turnIsWorking({ state: 'live' }, true, { ended: true, busy: true }), false);
  // And the transcript still counts on its own — a live turn does not need the process to agree.
  assert.equal(turnIsWorking({ state: 'live' }, true, { ended: false, busy: false }), true);
});

test('returnedWork: the agent that came back last, and never one still running', () => {
  const started = '2026-08-03T10:00:00.000Z';
  const done = agent({
    agentId: 'a1',
    title: '/code-review',
    turnIndex: 2,
    state: 'done',
    startedAt: started,
    durationMs: 60_000,
  });
  assert.deepEqual(returnedWork(2, [done], false, NOW_MS), { label: '/code-review', at: Date.parse(started) + 60_000 });
  // Still running → not this function's case; delegatedWork owns it and outranks it.
  const running = agent({ agentId: 'a2', title: '/other', turnIndex: 2, startedAt: started });
  assert.equal(returnedWork(2, [running], false, NOW_MS), null);
  assert.equal(returnedWork(3, [done], false, NOW_MS), null, 'another turn’s agent is not this turn’s');
});

// The review's finding, and the reason `shell` cannot be read here: Claude Code writes it for a
// turn that is ALREADY OVER while a command it launched keeps running. Read as "working", every
// background command marked the closed turn live — and took the session's Result button with it.
test('turnIsWorking: a background command does not make the finished turn live', () => {
  assert.equal(isWorking({ status: 'shell' }), true, 'the SESSION is working — the tab dot is right');
  assert.equal(isModelBusy({ status: 'shell' }), false, 'the TURN is not — that is the difference');
  assert.equal(turnIsWorking({ state: 'done' }, true, { ended: false, busy: isModelBusy({ status: 'shell' }) }), false);
  assert.equal(turnIsWorking({ state: 'done' }, true, { ended: false, busy: isModelBusy({ status: 'busy' }) }), true);
});

// An `unknown` agent is one nobody has a record of — a sidecar not read yet, a workflow gone
// silent. Announcing its RESULT said an agent that had just started had already come back.
test('returnedWork: a traceless launch has not returned, it has barely started', () => {
  const traceless = agent({ agentType: null, fill: 0, tools: [], outputFull: null, turnIndex: 2, state: 'running' });
  assert.equal(displayState(traceless, false, NOW_MS), 'unknown');
  assert.equal(returnedWork(2, [traceless], false, NOW_MS), null);
  assert.equal(delegatedWork(2, [traceless], false, NOW_MS), null, 'and it is not running either — one story');
});

// The review's #6: Esc is a fact about the transcript and outranks the process. The digest already
// refused to overwrite `interrupted` on the state, while its own `now` said "working" about the
// same turn — one payload asserting both.
test('turnIsWorking: a turn the user interrupted is not working, however busy the session looks', () => {
  assert.equal(turnIsWorking({ state: 'interrupted' }, true, { ended: false, busy: true }), false);
  assert.equal(turnIsWorking({ state: 'interrupted' }, true, { ended: false, busy: false }), false);
});
