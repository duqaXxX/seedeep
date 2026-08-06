import assert from 'node:assert/strict';
import { test } from 'node:test';
import { windowFor } from '../src/core/context-windows.ts';
import { createSessionTree } from '../src/core/session-tree.ts';
import type { NormalizedEvent } from '../src/core/types.ts';

const ev = (e: Partial<NormalizedEvent> & { type: NormalizedEvent['type'] }, seq: number): NormalizedEvent =>
  ({ sessionId: 's', root: 'cli', timestamp: '2026-07-11T00:00:00.000Z', seq, agentId: null, ...e }) as NormalizedEvent;

test('main fill and pct use the seeded model window', () => {
  const t = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' }); // 1M
  t.apply(
    ev(
      {
        type: 'usage',
        delta: { input: 100_000, output: 5_000, cacheRead: 400_000, cacheCreation: 0 },
        fill: 500_000,
      } as any,
      0,
    ),
  );
  const s = t.snapshot();
  assert.equal(s.main.fill, 500_000);
  assert.equal(s.main.window, 1_000_000);
  assert.equal(s.main.pct, 50);
  assert.equal(s.main.outputTotal, 5_000);
  assert.deepEqual(s.main.breakdown, { input: 100_000, cacheRead: 400_000, cacheCreation: 0 });
});

test('a subagent gets its own window from its own model', () => {
  const t = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  t.apply(
    ev(
      {
        type: 'usage',
        agentId: 'A',
        delta: { input: 20_000, output: 0, cacheRead: 0, cacheCreation: 0 },
        fill: 20_000,
      } as any,
      1,
    ),
  );
  const sub = t.snapshot().subagents.find((a) => a.agentId === 'A');
  assert.ok(sub);
  assert.equal(sub!.fill, 20_000);
});

test('tool duration = end - start, matched by tool_use_id (main-level tool)', () => {
  const t = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  t.apply({
    type: 'tool-start',
    sessionId: 's',
    root: 'cli',
    seq: 0,
    agentId: null,
    id: 'toolu_G',
    name: 'Grep',
    timestamp: '2026-07-11T00:00:00.000Z',
  } as NormalizedEvent);
  t.apply({
    type: 'tool-end',
    sessionId: 's',
    root: 'cli',
    seq: 1,
    agentId: null,
    toolUseId: 'toolu_G',
    timestamp: '2026-07-11T00:00:00.120Z',
  } as NormalizedEvent);
  // main-session tools (agentId null) live under the top-level mainTools bucket.
  const grep = t.snapshot().mainTools.find((x) => x.name === 'Grep');
  assert.equal(grep?.ms, 120);
});

test('subagent-meta links agentId->toolUseId; parent tool-end flips running->done', () => {
  const t = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  // agentId (child-file id) and its spawning toolUseId are DIFFERENT values.
  t.apply({
    type: 'tool-start',
    sessionId: 's',
    root: 'cli',
    seq: 0,
    agentId: null,
    id: 'toolu_AG',
    name: 'Agent',
    timestamp: 't0',
  } as NormalizedEvent);
  t.apply({
    type: 'subagent-meta',
    sessionId: 's',
    root: 'cli',
    seq: -1,
    agentId: 'child_XYZ',
    toolUseId: 'toolu_AG',
    agentType: 'explore',
    spawnDepth: 1,
    model: 'claude-haiku-4-5',
  } as NormalizedEvent);
  assert.equal(t.snapshot().subagents.find((a) => a.agentId === 'child_XYZ')?.state, 'running');
  t.apply({
    type: 'tool-end',
    sessionId: 's',
    root: 'cli',
    seq: 2,
    agentId: null,
    toolUseId: 'toolu_AG',
    timestamp: 't1',
  } as NormalizedEvent);
  assert.equal(t.snapshot().subagents.find((a) => a.agentId === 'child_XYZ')?.state, 'done');
});

// The LIVE order, and the one replay can never produce: a child writes its meta.json
// as soon as it starts, while the parent's assistant line carrying the spawn tool_use
// only lands when the streaming response reaches it. Measured on a real session: 2 of 3
// parallel foreground spawns arrive in this order. Getting it wrong splits one subagent
// into two rows — a ghost labelled with the raw tool_use id, stuck at 0% and running.
test('subagent-meta BEFORE its spawn still links (live ordering) — one row, not two', () => {
  const t = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  t.apply({
    type: 'subagent-meta',
    sessionId: 's',
    root: 'cli',
    seq: -1,
    agentId: 'child_EARLY',
    toolUseId: 'toolu_LATE',
    agentType: 'general-purpose',
    spawnDepth: 1,
    model: 'claude-haiku-4-5',
  } as NormalizedEvent);
  t.apply({
    type: 'tool-start',
    sessionId: 's',
    root: 'cli',
    seq: 0,
    agentId: null,
    id: 'toolu_LATE',
    name: 'Agent',
    subagentType: 'general-purpose',
    timestamp: 't0',
  } as NormalizedEvent);

  const subs = t.snapshot().subagents;
  assert.equal(subs.length, 1, 'one subagent must produce exactly one row');
  assert.equal(subs[0]!.agentId, 'child_EARLY');
  assert.equal(subs[0]!.agentType, 'general-purpose');
  assert.equal(subs[0]!.state, 'running');

  // The spawn's tool-end must still close THIS row (not a second, ghost one).
  t.apply({
    type: 'tool-end',
    sessionId: 's',
    root: 'cli',
    seq: 1,
    agentId: null,
    toolUseId: 'toolu_LATE',
    timestamp: 't1',
  } as NormalizedEvent);
  const after = t.snapshot().subagents;
  assert.equal(after.length, 1);
  assert.equal(after[0]!.state, 'done');
});

// The row's headline names the WORK, not the species: eight rows reading
// `general-purpose` name none of them. Sources best-first, and the winning one is
// known at spawn time — no waiting for the child.
test('subagent title: description > prompt first line > type > id', () => {
  const spawn = (id: string, input: Partial<NormalizedEvent>) =>
    ({
      type: 'tool-start',
      sessionId: 's',
      root: 'cli',
      seq: 0,
      agentId: null,
      id,
      name: 'Agent',
      timestamp: 't0',
      ...input,
    }) as NormalizedEvent;
  const titleOf = (e: NormalizedEvent) => {
    const t = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
    t.apply(e);
    return t.snapshot().subagents[0]!.title;
  };

  assert.equal(
    titleOf(
      spawn('toolu_1', {
        description: 'Review Task 5 (spec + quality)',
        launchPrompt: 'You are reviewing…',
        subagentType: 'general-purpose',
      }),
    ),
    'Review Task 5 (spec + quality)',
  );
  assert.equal(
    titleOf(spawn('toolu_2', { launchPrompt: 'Scan the docs tree\nthen report', subagentType: 'Explore' })),
    'Scan the docs tree',
  );
  assert.equal(titleOf(spawn('toolu_3', { subagentType: 'test-runner' })), 'test-runner');
  assert.equal(titleOf(spawn('toolu_4', {})), 'toolu_4'); // nothing names it: the id is the last resort
});

test('the child type wins the title only when the spawn states no intent', () => {
  const t = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  t.apply({
    type: 'tool-start',
    sessionId: 's',
    root: 'cli',
    seq: 0,
    agentId: null,
    id: 'toolu_D',
    name: 'Agent',
    description: 'Implement Task 3',
    timestamp: 't0',
  } as NormalizedEvent);
  t.apply({
    type: 'subagent-meta',
    sessionId: 's',
    root: 'cli',
    seq: -1,
    agentId: 'child_D',
    toolUseId: 'toolu_D',
    agentType: 'general-purpose',
    spawnDepth: 1,
    model: null,
  } as NormalizedEvent);
  const row = t.snapshot().subagents[0]!;
  // The intent stays the headline; the type is carried alongside for the view's second line.
  assert.equal(row.title, 'Implement Task 3');
  assert.equal(row.agentType, 'general-purpose');
});

test('subagent-meta model drives the subagent window (real, not estimated)', () => {
  const t = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  t.apply(
    ev(
      {
        type: 'usage',
        agentId: 'child_H',
        delta: { input: 100_000, output: 0, cacheRead: 0, cacheCreation: 0 },
        fill: 100_000,
      } as any,
      1,
    ),
  );
  // Before the meta arrives: unknown model → fallback 200k, estimated.
  let sub = t.snapshot().subagents.find((a) => a.agentId === 'child_H');
  assert.equal(sub?.estimated, true);
  // The meta carries the child's model → real window, not estimated.
  t.apply({
    type: 'subagent-meta',
    sessionId: 's',
    root: 'cli',
    seq: -1,
    agentId: 'child_H',
    toolUseId: null,
    agentType: null,
    spawnDepth: null,
    model: 'claude-haiku-4-5',
  } as NormalizedEvent);
  sub = t.snapshot().subagents.find((a) => a.agentId === 'child_H');
  assert.equal(sub?.window, 200_000);
  assert.equal(sub?.estimated, false);
  assert.equal(sub?.pct, 50);
});

test('subagent gains prompt + returned output + real duration via toolUseId link', () => {
  const t = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  t.apply({
    type: 'tool-start',
    sessionId: 's',
    root: 'cli',
    seq: 0,
    agentId: null,
    id: 'toolu_AG',
    name: 'Agent',
    timestamp: '2026-07-12T00:00:00.000Z',
    launchPrompt: 'do it',
    subagentType: 'general-purpose',
  } as NormalizedEvent);
  t.apply({
    type: 'subagent-meta',
    sessionId: 's',
    root: 'cli',
    seq: -1,
    agentId: 'child_R',
    toolUseId: 'toolu_AG',
    agentType: 'general-purpose',
    spawnDepth: 1,
    model: 'claude-sonnet-4-6',
  } as NormalizedEvent);
  // background subagent: the spawn tool_result returns almost immediately (0.1s),
  // but its real runtime is much longer (from toolUseResult.totalDurationMs).
  t.apply({
    type: 'tool-end',
    sessionId: 's',
    root: 'cli',
    seq: 2,
    agentId: null,
    toolUseId: 'toolu_AG',
    timestamp: '2026-07-12T00:00:00.100Z',
    returned: { outputFull: 'RESULT', outLen: 6, totalTokens: 59715, totalDurationMs: 383566, status: 'completed' },
  } as NormalizedEvent);
  const a = t.snapshot().subagents.find((x) => x.agentId === 'child_R');
  assert.ok(a);
  assert.equal(a!.state, 'done');
  assert.equal(a!.prompt, 'do it');
  assert.equal(a!.outputFull, 'RESULT');
  assert.equal(a!.outLen, 6);
  // A background subagent writes no child usage: volume falls back to the parent-reported total
  // and is flagged estimated, with no per-category breakdown.
  assert.equal(a!.volume, 59715);
  assert.equal(a!.volumeEstimated, true);
  assert.equal(a!.volumeBreakdown, null);
  // real runtime wins over the ~0.1s spawn round-trip
  assert.equal(a!.durationMs, 383566);
});

test('reducer counts turns (user prompts), apiCalls (usage lines), and commands', () => {
  const t = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  const base = { sessionId: 's', root: 'cli' as const, timestamp: 't', agentId: null };
  t.apply({ ...base, type: 'user-turn', seq: 0 } as NormalizedEvent);
  t.apply({
    ...base,
    type: 'usage',
    seq: 1,
    delta: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
    fill: 1,
  } as NormalizedEvent);
  t.apply({
    ...base,
    type: 'usage',
    seq: 2,
    delta: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
    fill: 2,
  } as NormalizedEvent);
  t.apply({ ...base, type: 'command', seq: 3, name: 'paste-image' } as NormalizedEvent);
  t.apply({ ...base, type: 'command', seq: 4, name: 'paste-image' } as NormalizedEvent);
  t.apply({ ...base, type: 'command', seq: 5, name: 'clear' } as NormalizedEvent);
  t.apply({ ...base, type: 'user-turn', seq: 6 } as NormalizedEvent);
  const s = t.snapshot();
  assert.equal(s.turns, 2, 'two user prompts');
  assert.equal(s.apiCalls, 2, 'two main usage lines');
  assert.deepEqual(s.commands, [
    { name: 'paste-image', count: 2 },
    { name: 'clear', count: 1 },
  ]);
});

test('a subagent usage line does not inflate main apiCalls; a subagent user-turn is ignored', () => {
  const t = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  t.apply({
    type: 'usage',
    sessionId: 's',
    root: 'cli',
    seq: 0,
    agentId: 'child_A',
    timestamp: 't',
    delta: { input: 1, output: 0, cacheRead: 0, cacheCreation: 0 },
    fill: 1,
  } as NormalizedEvent);
  t.apply({
    type: 'user-turn',
    sessionId: 's',
    root: 'cli',
    seq: 1,
    agentId: 'child_A',
    timestamp: 't',
  } as NormalizedEvent);
  const s = t.snapshot();
  assert.equal(s.apiCalls, 0);
  assert.equal(s.turns, 0);
});

test('onEvent fires once per applied event and unsubscribes cleanly', () => {
  const t = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  const seen: string[] = [];
  const off = t.onEvent((e) => seen.push(e.type));
  t.apply({
    type: 'tool-start',
    sessionId: 's',
    root: 'cli',
    seq: 0,
    agentId: null,
    id: 'x',
    name: 'Read',
    arg: '~/a',
    timestamp: 't',
  } as NormalizedEvent);
  off();
  t.apply({
    type: 'tool-start',
    sessionId: 's',
    root: 'cli',
    seq: 1,
    agentId: null,
    id: 'y',
    name: 'Bash',
    arg: 'ls',
    timestamp: 't',
  } as NormalizedEvent);
  assert.deepEqual(seen, ['tool-start']); // only the event before off()
});

test('skills aggregate turns (per attribution) + explicit invocations, sorted by invocations', () => {
  const t = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  const base = { sessionId: 's', root: 'cli' as const, timestamp: 't', agentId: null };
  t.apply({ ...base, type: 'attribution', seq: 0, kind: 'skill', name: 'code-review' } as NormalizedEvent);
  t.apply({ ...base, type: 'attribution', seq: 1, kind: 'skill', name: 'code-review' } as NormalizedEvent);
  t.apply({ ...base, type: 'attribution', seq: 2, kind: 'skill', name: 'brainstorming' } as NormalizedEvent);
  // an mcpServer attribution must NOT count as a skill
  t.apply({ ...base, type: 'attribution', seq: 3, kind: 'mcpServer', name: 'linear' } as NormalizedEvent);
  // explicit Skill invocation (tool-start name=Skill, arg=skill name)
  t.apply({ ...base, type: 'tool-start', seq: 4, id: 'toolu_S', name: 'Skill', arg: 'code-review' } as NormalizedEvent);
  const skills = t.snapshot().skills;
  assert.equal(skills.length, 2, 'only skills, not the mcpServer');
  const cr = skills.find((s) => s.name === 'code-review');
  const br = skills.find((s) => s.name === 'brainstorming');
  assert.equal(skills[0]!.name, 'code-review'); // sorted by invocations desc (1 > 0)
  assert.equal(cr!.turns, 2);
  assert.equal(cr!.invokes, 1);
  assert.equal(br!.turns, 1);
  assert.equal(br!.invokes, 0);
});

test('skills sort by invocations first, not turns (a long-active skill with 0 calls ranks below a called one)', () => {
  const t = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  const base = { sessionId: 's', root: 'cli' as const, timestamp: 't', agentId: null };
  // paste-image: many attribution turns but never explicitly invoked this session
  for (let i = 0; i < 400; i++)
    t.apply({ ...base, type: 'attribution', seq: i, kind: 'skill', name: 'paste-image' } as NormalizedEvent);
  // code-review: few turns, but one explicit invocation
  t.apply({ ...base, type: 'attribution', seq: 400, kind: 'skill', name: 'code-review' } as NormalizedEvent);
  t.apply({
    ...base,
    type: 'tool-start',
    seq: 401,
    id: 'toolu_S',
    name: 'Skill',
    arg: 'code-review',
  } as NormalizedEvent);
  const skills = t.snapshot().skills;
  assert.equal(skills[0]!.name, 'code-review'); // invokes 1 > paste-image invokes 0
  assert.equal(skills.find((s) => s.name === 'paste-image')!.turns, 400);
  assert.equal(skills.find((s) => s.name === 'paste-image')!.invokes, 0);
});

test('skill attribution from a subagent (agentId set) does not pollute main skills', () => {
  const t = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  t.apply({
    type: 'attribution',
    sessionId: 's',
    root: 'cli',
    seq: 0,
    agentId: 'child_X',
    timestamp: 't',
    kind: 'skill',
    name: 'child-only',
  } as NormalizedEvent);
  assert.equal(t.snapshot().skills.length, 0, 'a subagent skill is not a main-session turn');
});

test('tool node carries arg and ctx (output size); works for main and subagent tools', () => {
  const t = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  // main tool
  t.apply({
    type: 'tool-start',
    sessionId: 's',
    root: 'cli',
    seq: 0,
    agentId: null,
    id: 'toolu_R',
    name: 'Read',
    arg: '~/x.ts',
    timestamp: '2026-07-12T00:00:00.000Z',
  } as NormalizedEvent);
  t.apply({
    type: 'tool-end',
    sessionId: 's',
    root: 'cli',
    seq: 1,
    agentId: null,
    toolUseId: 'toolu_R',
    outputSize: 5300,
    timestamp: '2026-07-12T00:00:00.100Z',
  } as NormalizedEvent);
  // subagent tool (agentId set)
  t.apply({
    type: 'subagent-meta',
    sessionId: 's',
    root: 'cli',
    seq: -1,
    agentId: 'child_T',
    toolUseId: null,
    agentType: 'gp',
    spawnDepth: 1,
    model: 'claude-sonnet-4-6',
  } as NormalizedEvent);
  t.apply({
    type: 'tool-start',
    sessionId: 's',
    root: 'cli',
    seq: 0,
    agentId: 'child_T',
    id: 'toolu_B',
    name: 'Bash',
    arg: 'ls',
    timestamp: '2026-07-12T00:01:00.000Z',
  } as NormalizedEvent);
  t.apply({
    type: 'tool-end',
    sessionId: 's',
    root: 'cli',
    seq: 1,
    agentId: 'child_T',
    toolUseId: 'toolu_B',
    outputSize: 42,
    timestamp: '2026-07-12T00:01:00.050Z',
  } as NormalizedEvent);
  const main = t.snapshot().mainTools.find((x) => x.name === 'Read');
  assert.equal(main?.arg, '~/x.ts');
  assert.equal(main?.ctx, 5300);
  const sub = t.snapshot().subagents.find((a) => a.agentId === 'child_T');
  const btool = sub?.tools.find((x) => x.name === 'Bash');
  assert.equal(btool?.arg, 'ls');
  assert.equal(btool?.ctx, 42);
});

test('background subagent: returned output + duration come from the CHILD jsonl', () => {
  const t = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  // spawn: the parent Agent tool has a prompt but its result is a launch ACK (no returned).
  t.apply({
    type: 'tool-start',
    sessionId: 's',
    root: 'cli',
    seq: 0,
    agentId: null,
    id: 'toolu_AG',
    name: 'Agent',
    timestamp: '2026-07-12T12:11:08.420Z',
    launchPrompt: 'inspect jsonl',
  } as NormalizedEvent);
  // the child is created by its meta (out-of-band seq -1, does not enter the time window)
  t.apply({
    type: 'subagent-meta',
    sessionId: 's',
    root: 'cli',
    seq: -1,
    agentId: 'child_B',
    toolUseId: 'toolu_AG',
    agentType: 'general-purpose',
    spawnDepth: 1,
    model: 'claude-sonnet-4-6',
  } as NormalizedEvent);
  // parent tool-end is the launch ACK: returns immediately, NO returned payload.
  t.apply({
    type: 'tool-end',
    sessionId: 's',
    root: 'cli',
    seq: 2,
    agentId: null,
    toolUseId: 'toolu_AG',
    timestamp: '2026-07-12T12:11:08.529Z',
  } as NormalizedEvent);
  // CHILD lines span the real runtime; the last carries the end_turn output.
  t.apply({
    type: 'usage',
    sessionId: 's',
    root: 'cli',
    seq: 0,
    agentId: 'child_B',
    timestamp: '2026-07-12T12:11:08.495Z',
    delta: { input: 1, output: 0, cacheRead: 0, cacheCreation: 0 },
    fill: 1,
  } as NormalizedEvent);
  t.apply({
    type: 'subagent-output',
    sessionId: 's',
    root: 'cli',
    seq: 39,
    agentId: 'child_B',
    timestamp: '2026-07-12T12:14:20.328Z',
    outputFull: 'the report',
    outLen: 10,
  } as NormalizedEvent);
  const a = t.snapshot().subagents.find((x) => x.agentId === 'child_B');
  assert.ok(a);
  assert.equal(a!.outputFull, 'the report'); // from the child, not the parent
  assert.equal(a!.outLen, 10);
  // duration from child first↔last timestamp (~191.8s), NOT the 0.1s spawn round-trip
  assert.equal(a!.durationMs, 191833);
  assert.equal(a!.prompt, 'inspect jsonl'); // prompt still from the spawn tool
});

test('running subagent (no returned) keeps null duration, no prompt leak', () => {
  const t = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  t.apply({
    type: 'tool-start',
    sessionId: 's',
    root: 'cli',
    seq: 0,
    agentId: null,
    id: 'toolu_AG',
    name: 'Agent',
    timestamp: '2026-07-12T00:00:00.000Z',
    launchPrompt: 'work',
  } as NormalizedEvent);
  t.apply({
    type: 'subagent-meta',
    sessionId: 's',
    root: 'cli',
    seq: -1,
    agentId: 'child_L',
    toolUseId: 'toolu_AG',
    agentType: null,
    spawnDepth: 1,
    model: null,
  } as NormalizedEvent);
  const a = t.snapshot().subagents.find((x) => x.agentId === 'child_L');
  assert.equal(a!.state, 'running');
  assert.equal(a!.durationMs, null);
  assert.equal(a!.outLen, 0);
  assert.equal(a!.prompt, 'work');
});

test('a subagent with no meta link stays running even if some tool-end arrives', () => {
  const t = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  // A subagent exists because its own file produced a line — there is no "subagent born"
  // event on the wire, so this is how one really appears.
  t.apply(
    ev(
      {
        type: 'usage',
        agentId: 'child_NOLINK',
        delta: { input: 10, output: 0, cacheRead: 0, cacheCreation: 0 },
        fill: 10,
      } as any,
      0,
    ),
  );
  t.apply({
    type: 'tool-end',
    sessionId: 's',
    root: 'cli',
    seq: 1,
    agentId: null,
    toolUseId: 'toolu_other',
    timestamp: 't1',
  } as NormalizedEvent);
  assert.equal(t.snapshot().subagents.find((a) => a.agentId === 'child_NOLINK')?.state, 'running');
});

test('compaction node carries pre/post/delta/ms', () => {
  const t = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  t.apply(
    ev({ type: 'compaction', isSummary: false, preTokens: 423_000, postTokens: 12_000, durationMs: 150 } as any, 0),
  );
  assert.deepEqual(t.snapshot().compactions[0], { pre: 423_000, post: 12_000, delta: 411_000, ms: 150 });
});

test('auto-compaction appears as /compact chip in session Commands and in the turn it fired in', () => {
  const t = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  // open a turn, then fire a compaction inside it
  t.apply(turn(0));
  t.apply(usage(0, 200_000));
  // The compact_boundary system line emits isSummary=false (real token counts)
  t.apply(
    ev({ type: 'compaction', isSummary: false, preTokens: 200_000, postTokens: 10_000, durationMs: 200 } as any, 1),
  );
  // The user line with isCompactSummary=true follows immediately (same compaction, different seq)
  t.apply(ev({ type: 'compaction', isSummary: true, preTokens: null, postTokens: null, durationMs: null } as any, 2));

  const s = t.snapshot();
  // Session count must be 1, not 2 — the isSummary event must NOT bump the count
  const cmd = s.commands.find((c) => c.name === 'compact');
  assert.ok(cmd, '/compact chip must appear in session Commands');
  assert.equal(cmd!.count, 1, 'isSummary event must not double-count the chip');
  // The turn where the compaction occurred also shows /compact with count=1
  const t0 = s.turnList[0];
  assert.ok(t0, 'turn must exist');
  const turnCmd = t0!.commands.find((c) => c.name === 'compact');
  assert.ok(turnCmd, '/compact chip must appear in turn Commands');
  assert.equal(turnCmd!.count, 1, 'isSummary event must not double-count the turn chip');
});

test('unknown model flags estimated on the pct', () => {
  const t = createSessionTree({ windowFor, mainModel: 'mystery' });
  t.apply(
    ev(
      { type: 'usage', delta: { input: 100_000, output: 0, cacheRead: 0, cacheCreation: 0 }, fill: 100_000 } as any,
      0,
    ),
  );
  assert.equal(t.snapshot().main.estimated, true);
});

test('AgentNode carries agentType from subagent-meta, non-destructive', () => {
  const t = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  // first meta: only the tool link (agentType null) — must not later clobber a real type
  t.apply({
    type: 'subagent-meta',
    sessionId: 's',
    root: 'cli',
    seq: -1,
    agentId: 'child_T',
    toolUseId: 'toolu_X',
    agentType: 'general-purpose',
    spawnDepth: 1,
    model: null,
  } as NormalizedEvent);
  t.apply({
    type: 'subagent-meta',
    sessionId: 's',
    root: 'cli',
    seq: -1,
    agentId: 'child_T',
    toolUseId: null,
    agentType: null,
    spawnDepth: null,
    model: 'claude-haiku-4-5',
  } as NormalizedEvent);
  const sub = t.snapshot().subagents.find((a) => a.agentId === 'child_T');
  assert.equal(sub?.agentType, 'general-purpose'); // not nulled by the second meta
  assert.equal(sub?.model, 'claude-haiku-4-5');
});

test('AgentNode startedAt/durationMs derive from the spawning tool; null while running', () => {
  const t = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  t.apply({
    type: 'tool-start',
    sessionId: 's',
    root: 'cli',
    seq: 0,
    agentId: null,
    id: 'toolu_AG',
    name: 'Agent',
    timestamp: '2026-07-12T14:32:07.000Z',
  } as NormalizedEvent);
  t.apply({
    type: 'subagent-meta',
    sessionId: 's',
    root: 'cli',
    seq: -1,
    agentId: 'child_D',
    toolUseId: 'toolu_AG',
    agentType: 'explore',
    spawnDepth: 1,
    model: 'claude-haiku-4-5',
  } as NormalizedEvent);
  // running: startedAt known, duration null
  let sub = t.snapshot().subagents.find((a) => a.agentId === 'child_D');
  assert.equal(sub?.startedAt, '2026-07-12T14:32:07.000Z');
  assert.equal(sub?.durationMs, null);
  assert.equal(sub?.state, 'running');
  // parent tool-end 108s later → duration filled, state done
  t.apply({
    type: 'tool-end',
    sessionId: 's',
    root: 'cli',
    seq: 2,
    agentId: null,
    toolUseId: 'toolu_AG',
    timestamp: '2026-07-12T14:33:55.000Z',
  } as NormalizedEvent);
  sub = t.snapshot().subagents.find((a) => a.agentId === 'child_D');
  assert.equal(sub?.durationMs, 108000);
  assert.equal(sub?.state, 'done');
});

test('AgentNode startedAt is null when the spawning tool is unknown', () => {
  const t = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  t.apply(
    ev(
      {
        type: 'usage',
        agentId: 'child_U',
        delta: { input: 10, output: 0, cacheRead: 0, cacheCreation: 0 },
        fill: 10,
      } as any,
      0,
    ),
  );
  const sub = t.snapshot().subagents.find((a) => a.agentId === 'child_U');
  assert.equal(sub?.startedAt, null);
  assert.equal(sub?.durationMs, null);
  assert.equal(sub?.agentType, null);
});

// --- turn management ---

const base41 = { sessionId: 's', root: 'cli' as const, agentId: null };
function turn(seq: number, prompt = 'prompt ' + seq): NormalizedEvent {
  return {
    ...base41,
    type: 'user-turn',
    timestamp: '2026-07-13T00:0' + seq + ':00.000Z',
    seq,
    prompt,
    command: null,
  } as NormalizedEvent;
}
function usage(seq: number, fill: number, out = 100): NormalizedEvent {
  return {
    ...base41,
    type: 'usage',
    timestamp: '2026-07-13T00:0' + seq + ':10.000Z',
    seq,
    delta: { input: fill, output: out, cacheRead: 0, cacheCreation: 0 },
    fill,
  } as NormalizedEvent;
}
function turnEnd(seq: number, durationMs: number): NormalizedEvent {
  return {
    ...base41,
    type: 'turn-end',
    timestamp: '2026-07-13T00:0' + seq + ':59.000Z',
    seq,
    durationMs,
    messageCount: 5,
  } as NormalizedEvent;
}

test('turns: turnList is built correctly — three turns, deltaFill is correct', () => {
  const t = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  t.apply(turn(0));
  t.apply(usage(0, 10000));
  t.apply(turnEnd(0, 5000));
  t.apply(turn(1));
  t.apply(usage(1, 30000));
  t.apply(turnEnd(1, 8000));
  t.apply(turn(2));
  t.apply(usage(2, 50000));
  // turn 3 still open (live)
  const s = t.snapshot();
  assert.equal(s.turnList.length, 3, 'three turns');
  assert.equal(s.turnList[0]!.index, 1);
  assert.equal(s.turnList[0]!.deltaFill, 10000, 'first turn starts from 0');
  assert.equal(s.turnList[1]!.deltaFill, 20000, 'second turn delta = 30k - 10k');
  assert.equal(s.turnList[2]!.deltaFill, 20000, 'third turn delta = 50k - 30k');
  assert.equal(s.turnList[2]!.state, 'live', 'current open turn is live');
  assert.equal(s.turnList[0]!.state, 'done', 'first turn done');
  assert.equal(s.turnList[0]!.durationMs, 5000);
  assert.equal(s.turnList[0]!.apiCalls, 1, 'one usage event per turn');
  assert.equal(s.turnList[0]!.prompt, 'prompt 0');
});

test('turns: interrupted turn has state=interrupted, result=null, negative delta survives', () => {
  const t = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  t.apply(turn(0));
  t.apply(usage(0, 80000));
  // interrupted: no turn-end, instead a turn-interrupted fires before the next user-turn
  t.apply({
    ...base41,
    type: 'turn-interrupted',
    timestamp: '2026-07-13T00:01:00.000Z',
    seq: 1,
    interruptedMessageId: 'u0',
  } as NormalizedEvent);
  t.apply(turn(2)); // next turn opens
  t.apply(usage(2, 30000)); // fill dropped (compaction) — negative deltaFill
  const s = t.snapshot();
  assert.equal(s.turnList[0]!.state, 'interrupted', 'first turn interrupted');
  assert.equal(s.turnList[0]!.result, null, 'no result for interrupted turn');
  assert.equal(s.turnList[1]!.deltaFill, 30000 - 80000, 'negative deltaFill from compaction');
});

test('turns: turn-result sets result on currentTurn, last wins', () => {
  const t = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  t.apply(turn(0));
  t.apply({
    ...base41,
    type: 'turn-result',
    timestamp: 't',
    seq: 1,
    outputFull: 'first',
    outLen: 5,
  } as NormalizedEvent);
  t.apply({
    ...base41,
    type: 'turn-result',
    timestamp: 't',
    seq: 2,
    outputFull: 'final answer',
    outLen: 12,
  } as NormalizedEvent);
  const s = t.snapshot();
  assert.equal(s.turnList[0]!.result, 'final answer', 'last turn-result wins');
});

test('turns: tools and subagents are attributed to the correct turn via turnIndex', () => {
  const t = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  t.apply(turn(0));
  t.apply({ ...base41, type: 'tool-start', timestamp: 't1', seq: 1, id: 'toolu_T1', name: 'Read' } as NormalizedEvent);
  t.apply({
    ...base41,
    type: 'tool-start',
    timestamp: 't2',
    seq: 2,
    id: 'toolu_AG',
    name: 'Agent',
    launchPrompt: 'go',
    subagentType: 'general-purpose',
  } as NormalizedEvent);
  t.apply(turn(3)); // second turn
  t.apply({ ...base41, type: 'tool-start', timestamp: 't4', seq: 4, id: 'toolu_T2', name: 'Bash' } as NormalizedEvent);
  const snap = t.snapshot();
  const t1 = snap.mainTools.find((x) => x.name === 'Read');
  const t2 = snap.mainTools.find((x) => x.name === 'Bash');
  assert.equal(t1?.turnIndex, 1, 'Read belongs to turn 1');
  assert.equal(t2?.turnIndex, 2, 'Bash belongs to turn 2');
});

test('turns: skills and commands are attributed to the correct turn', () => {
  const t = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  t.apply(turn(0));
  t.apply({
    ...base41,
    type: 'attribution',
    timestamp: 't',
    seq: 1,
    kind: 'skill',
    name: 'brainstorming',
  } as NormalizedEvent);
  t.apply({ ...base41, type: 'command', timestamp: 't', seq: 2, name: 'paste-image' } as NormalizedEvent);
  t.apply(turn(3));
  t.apply({ ...base41, type: 'attribution', timestamp: 't', seq: 4, kind: 'skill', name: 'tdd' } as NormalizedEvent);
  const snap = t.snapshot();
  assert.deepEqual(
    snap.turnList[0]!.skills.map((s) => s.name),
    ['brainstorming'],
  );
  assert.deepEqual(
    snap.turnList[0]!.commands.map((c) => c.name),
    ['paste-image'],
  );
  assert.deepEqual(
    snap.turnList[1]!.skills.map((s) => s.name),
    ['tdd'],
  );
  assert.deepEqual(snap.turnList[1]!.commands, []);
});

test("turns: skill/command counts on a turn are the TURN's, not the session's", () => {
  // The bug this guards: a widget scoped to turn 2 showed "/paste-image ×3" (the session
  // total) for a turn that used it once.
  const t = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  const cmd = (seq: number) =>
    ({ ...base41, type: 'command', timestamp: 't', seq, name: 'paste-image' }) as NormalizedEvent;
  const skillCall = (seq: number) =>
    ({
      ...base41,
      type: 'tool-start',
      timestamp: 't',
      seq,
      id: 'toolu_' + seq,
      name: 'Skill',
      arg: 'tdd',
    }) as NormalizedEvent;
  const attr = (seq: number) =>
    ({ ...base41, type: 'attribution', timestamp: 't', seq, kind: 'skill', name: 'tdd' }) as NormalizedEvent;

  t.apply(turn(0));
  t.apply(cmd(1));
  t.apply(cmd(2)); // twice in turn 1
  t.apply(skillCall(3));
  t.apply(attr(4));
  t.apply(attr(5));
  t.apply(turn(6));
  t.apply(cmd(7)); // once in turn 2
  t.apply(skillCall(8));
  t.apply(attr(9));

  const snap = t.snapshot();
  assert.equal(snap.commands[0]!.count, 3, 'session total is 3');
  assert.equal(snap.skills[0]!.invokes, 2, 'session invokes = 2');
  assert.equal(snap.skills[0]!.turns, 3, 'session attributed turns = 3');

  assert.equal(snap.turnList[0]!.commands[0]!.count, 2, 'turn 1 typed it twice');
  assert.equal(snap.turnList[1]!.commands[0]!.count, 1, 'turn 2 typed it once');
  assert.equal(snap.turnList[1]!.skills[0]!.invokes, 1, 'turn 2 invoked the skill once');
  assert.equal(snap.turnList[1]!.skills[0]!.turns, 1, 'turn 2 attributed one API turn');
});

test('onEvent carries the turn an event belongs to; a subagent event gets its SPAWNING turn', () => {
  // The feed scopes by this: an async subagent's tools can land while a LATER turn is open,
  // and they must still belong to the turn that asked for them.
  const t = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  const seen: Array<{ type: string; turnIndex: number | null }> = [];
  t.onEvent((e, ctx) => seen.push({ type: e.type, turnIndex: ctx.turnIndex }));

  t.apply(turn(0)); // turn 1 opens
  t.apply({
    ...base41,
    type: 'tool-start',
    timestamp: 't1',
    seq: 1,
    id: 'toolu_AG',
    name: 'Agent',
    launchPrompt: 'go',
    subagentType: 'general-purpose',
  } as NormalizedEvent);
  t.apply({
    type: 'subagent-meta',
    sessionId: 's',
    root: 'cli',
    seq: -1,
    timestamp: '',
    agentId: 'child_A',
    toolUseId: 'toolu_AG',
    agentType: 'general-purpose',
  } as NormalizedEvent);
  t.apply(turn(3)); // turn 2 opens while the subagent still runs
  t.apply({
    type: 'tool-start',
    sessionId: 's',
    root: 'cli',
    seq: 4,
    agentId: 'child_A',
    id: 'toolu_C1',
    name: 'Grep',
    timestamp: 't4',
  } as NormalizedEvent);
  t.apply({ ...base41, type: 'tool-start', timestamp: 't5', seq: 5, id: 'toolu_M2', name: 'Bash' } as NormalizedEvent);

  const spawn = seen.find((x) => x.type === 'tool-start')!;
  assert.equal(spawn.turnIndex, 1, 'the Agent spawn belongs to turn 1');
  const childTool = seen.filter((x) => x.type === 'tool-start')[1]!;
  assert.equal(childTool.turnIndex, 1, "the subagent's own tool stays on its spawning turn, not the open one");
  const mainTool = seen.filter((x) => x.type === 'tool-start')[2]!;
  assert.equal(mainTool.turnIndex, 2, 'a main tool belongs to the open turn');
});

// ---- The session's model follows the calls, not the session head ----

// A session opened right after /clear has written no assistant line yet, so
// discovery reports model=null and the window falls back to 200k+estimated. The first
// call must correct it — without a page refresh, which is the only thing that fixed it.
test('a null seed model is corrected by the first call that reports one', () => {
  const t = createSessionTree({ windowFor, mainModel: null });
  assert.equal(t.snapshot().main.window, 200_000);
  assert.equal(t.snapshot().main.estimated, true);

  t.apply(
    ev(
      {
        type: 'usage',
        model: 'claude-opus-4-8',
        callId: 'c1',
        delta: { input: 10, output: 1, cacheRead: 0, cacheCreation: 0 },
        fill: 10,
      } as any,
      0,
    ),
  );

  const s = t.snapshot();
  assert.equal(s.main.model, 'claude-opus-4-8');
  assert.equal(s.main.window, 1_000_000);
  assert.equal(s.main.estimated, false);
});

// /model mid-session. The seed says opus (1M) but the calls have moved to sonnet
// (200k) — keeping the seed reports 188k as 19% full when it is really 94%.
test('a model change mid-session moves the window to the new model', () => {
  const t = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  t.apply(
    ev(
      {
        type: 'usage',
        model: 'claude-opus-4-8',
        callId: 'c1',
        delta: { input: 1000, output: 1, cacheRead: 0, cacheCreation: 0 },
        fill: 1000,
      } as any,
      0,
    ),
  );
  assert.equal(t.snapshot().main.window, 1_000_000);

  t.apply(
    ev(
      {
        type: 'usage',
        model: 'claude-sonnet-4-6',
        callId: 'c2',
        delta: { input: 188_000, output: 1, cacheRead: 0, cacheCreation: 0 },
        fill: 188_000,
      } as any,
      1,
    ),
  );

  const s = t.snapshot();
  assert.equal(s.main.model, 'claude-sonnet-4-6');
  assert.equal(s.main.window, 200_000);
  assert.equal(s.main.pct, 94);
  assert.deepEqual(
    s.main.models,
    ['claude-opus-4-8', 'claude-sonnet-4-6'],
    'the session keeps what it WAS, in order — showing only the last hides that anything changed',
  );
});

// A subagent's model must never be mistaken for the main session's: its calls carry
// haiku while the session runs opus, and the main window must not follow it.
test("a subagent's model never moves the main window", () => {
  const t = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  t.apply(
    ev(
      {
        type: 'usage',
        agentId: 'child_A',
        model: 'claude-haiku-4-5',
        callId: 'c1',
        delta: { input: 10, output: 1, cacheRead: 0, cacheCreation: 0 },
        fill: 10,
      } as any,
      0,
    ),
  );
  const s = t.snapshot();
  assert.equal(s.main.model, 'claude-opus-4-8');
  assert.equal(s.main.window, 1_000_000);
});

// Per-turn model/effort: 99.7% of real turns carry exactly one model and 98% carry no
// effort at all, so the turn must report what it HAS — never a placeholder.
test('a turn reports the models and efforts its own calls carried', () => {
  const t = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  t.apply(ev({ type: 'user-turn', prompt: 'do the thing', command: null } as any, 0));
  t.apply(
    ev(
      {
        type: 'usage',
        model: 'claude-opus-4-8',
        effort: 'xhigh',
        callId: 'c1',
        delta: { input: 10, output: 1, cacheRead: 0, cacheCreation: 0 },
        fill: 10,
      } as any,
      1,
    ),
  );
  t.apply(
    ev(
      {
        type: 'usage',
        model: 'claude-opus-4-8',
        effort: 'xhigh',
        callId: 'c2',
        delta: { input: 20, output: 1, cacheRead: 0, cacheCreation: 0 },
        fill: 30,
      } as any,
      2,
    ),
  );

  const turn = t.snapshot().turnList.at(-1)!;
  assert.deepEqual(turn.models, ['claude-opus-4-8'], 'one model, not one entry per call');
  assert.deepEqual(turn.efforts, ['xhigh']);
});

test('a turn whose calls carried no effort reports none', () => {
  const t = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  t.apply(ev({ type: 'user-turn', prompt: 'do the thing', command: null } as any, 0));
  t.apply(
    ev(
      {
        type: 'usage',
        model: 'claude-opus-4-8',
        callId: 'c1',
        delta: { input: 10, output: 1, cacheRead: 0, cacheCreation: 0 },
        fill: 10,
      } as any,
      1,
    ),
  );
  assert.deepEqual(t.snapshot().turnList.at(-1)!.efforts, []);
});

// The notification's subject is an AGENT, not a spawn. Treating `tool-use-id` as the KEY
// rather than as one of two names meant an agent with no spawn — a skill forked into the
// background has none — could never be told to stop: it pulsed `running` for the life of the
// page. Measured on the local corpus: 18 subagents left running that a notification had
// already ended.
test('a notification that names no spawn ends the agent it names', () => {
  const t = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  // Applied BEFORE that agent has written anything: replay reads the parent file WHOLE
  // before any child, so this is the normal order, not an edge case. Recording the end on
  // the agent OBJECT fails here — the object does not exist yet.
  t.apply(ev({ type: 'agent-end', toolUseId: null, taskId: 'a1', status: 'completed' } as any, 0));
  t.apply(
    ev(
      {
        type: 'usage',
        agentId: 'a1',
        delta: { input: 10, output: 1, cacheRead: 0, cacheCreation: 0 },
        fill: 1000,
      } as any,
      1,
    ),
  );
  const sub = t.snapshot().subagents.find((a) => a.agentId === 'a1');
  assert.ok(sub, 'the agent is known from its own lines');
  assert.equal(sub!.state, 'done');
});

test('a spawnless notification carries its status through: failed and killed are not "done"', () => {
  for (const [status, expected] of [
    ['failed', 'failed'],
    ['killed', 'killed'],
    [null, 'done'],
  ] as const) {
    const t = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
    t.apply(
      ev(
        {
          type: 'usage',
          agentId: 'a1',
          delta: { input: 10, output: 1, cacheRead: 0, cacheCreation: 0 },
          fill: 1,
        } as any,
        0,
      ),
    );
    t.apply(ev({ type: 'agent-end', toolUseId: null, taskId: 'a1', status } as any, 1));
    assert.equal(t.snapshot().subagents.find((a) => a.agentId === 'a1')!.state, expected);
  }
});

test('a notification naming nothing this session knows leaves every subagent alone', () => {
  // 111 of the local corpus's terminal notifications name a background shell task (`b…`) or
  // a workflow run (`w…`), never a subagent. They land in a map nobody looks up: inert.
  const t = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  t.apply(
    ev(
      { type: 'usage', agentId: 'a1', delta: { input: 10, output: 1, cacheRead: 0, cacheCreation: 0 }, fill: 1 } as any,
      0,
    ),
  );
  t.apply(ev({ type: 'agent-end', toolUseId: null, taskId: 'b90xzyexi', status: 'failed' } as any, 1));
  assert.equal(t.snapshot().subagents.find((a) => a.agentId === 'a1')!.state, 'running');
});
