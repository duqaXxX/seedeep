import { expect, test } from 'bun:test';
import { windowFor } from '../src/core/context-windows.ts';
import { createSessionTree } from '../src/core/session-tree.ts';
import { createSpanStore } from '../src/core/span-store.ts';
import type { NormalizedEvent } from '../src/core/types.ts';
import { parseLine } from '../src/server/parser.ts';

// Line builders — exact shapes verified in tests/golden-transcript.test.ts.
// Content is synthetic; only the shape is real.

const ctx = { sessionId: 's1', root: 'cli' as const, agentId: null };

const typed = (uuid: string, text: string, ts = '2026-07-14T10:00:00.000Z') =>
  JSON.stringify({
    type: 'user',
    uuid,
    timestamp: ts,
    origin: { kind: 'human' },
    promptSource: 'typed',
    message: { role: 'user', content: text },
  });

// One API call: a single content block (no repeat), with a distinct message.id.
const call = (uuid: string, id: string, ts = '2026-07-14T10:00:02.000Z') =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: ts,
    message: {
      role: 'assistant',
      id,
      model: 'claude-opus-4-8',
      usage: { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 5_000, cache_creation_input_tokens: 0 },
    },
  });

const toolUse = (uuid: string, id: string, name: string, ts = '2026-07-14T10:00:03.000Z') =>
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

const toolResult = (uuid: string, toolUseId: string, text: string, ts = '2026-07-14T10:00:04.000Z') =>
  JSON.stringify({
    type: 'user',
    uuid,
    timestamp: ts,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] },
  });

const turnDuration = (uuid: string, ts = '2026-07-14T10:00:09.000Z') =>
  JSON.stringify({
    type: 'system',
    subtype: 'turn_duration',
    uuid,
    timestamp: ts,
    durationMs: 9000,
    messageCount: 3,
  });

// An assistant end_turn line that produces a turn-result event only.
// No usage block: the parser emits usage only when message.usage is present, so omitting
// it prevents a second api span from appearing after the tool.
const endTurn = (uuid: string, text: string, ts = '2026-07-14T10:00:08.000Z') =>
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

/** Drive raw lines through the REAL reducer; forward its onEvent(e, ctx) into the store. */
function storeOf(lines: string[]) {
  const tree = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  const store = createSpanStore();
  tree.onEvent((e, ctx) => store.apply(e, ctx));
  let seq = 0;
  for (const l of lines) {
    for (const e of parseLine(l, { ...ctx, seq: seq++ }) as NormalizedEvent[]) tree.apply(e);
  }
  return store;
}

test('span-store: a work turn yields prompt → api → tool → result in order', () => {
  const lines = [
    typed('u1', 'fix the bug', '2026-07-14T10:00:00.000Z'),
    call('a1', 'msg_001', '2026-07-14T10:00:02.000Z'),
    toolUse('a2', 'toolu_01', 'Read', '2026-07-14T10:00:03.000Z'),
    toolResult('u2', 'toolu_01', 'file contents', '2026-07-14T10:00:04.000Z'),
    endTurn('a3', 'Done.', '2026-07-14T10:00:08.000Z'),
    turnDuration('t1', '2026-07-14T10:00:09.000Z'),
  ];
  const snap = storeOf(lines).snapshot();

  expect(snap.turns.length).toBe(1);
  const types = snap.turns[0]!.spans.map((s) => s.type);
  expect(types).toEqual(['prompt', 'api', 'tool', 'result']);
  expect(snap.turns[0]!.spans.find((s) => s.type === 'tool')!.label).toBe('Read');
  expect(snap.turns[0]!.spans.find((s) => s.type === 'tool')!.handle).toEqual({
    kind: 'tool',
    toolUseId: expect.any(String),
  });
});

test('span-store: turn state transitions from live to done', () => {
  const lines = [
    typed('u1', 'do it', '2026-07-14T10:00:00.000Z'),
    call('a1', 'msg_002', '2026-07-14T10:00:02.000Z'),
    turnDuration('t1', '2026-07-14T10:00:09.000Z'),
  ];
  const snap = storeOf(lines).snapshot();

  expect(snap.turns.length).toBe(1);
  expect(snap.turns[0]!.state).toBe('done');
  expect(snap.turns[0]!.kind).toBe('work');
});

test('span-store: scopeTurn filters to that turn only', () => {
  const lines = [
    typed('u1', 'first', '2026-07-14T10:00:00.000Z'),
    call('a1', 'msg_003', '2026-07-14T10:00:02.000Z'),
    turnDuration('t1', '2026-07-14T10:00:05.000Z'),
    typed('u2', 'second', '2026-07-14T10:01:00.000Z'),
    call('a2', 'msg_004', '2026-07-14T10:01:02.000Z'),
    turnDuration('t2', '2026-07-14T10:01:05.000Z'),
  ];
  const store = storeOf(lines);
  const all = store.snapshot();
  const scoped = store.snapshot(1);

  expect(all.turns.length).toBe(2);
  expect(scoped.turns.length).toBe(1);
  expect(scoped.turns[0]!.title).toBe('first');
});

test('span-store: seq increments on every apply', () => {
  const tree = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  const store = createSpanStore();
  tree.onEvent((e, ctx) => store.apply(e, ctx));

  const before = store.snapshot().seq;
  let seq = 0;
  for (const e of parseLine(typed('u1', 'go'), { ...ctx, seq: seq++ }) as NormalizedEvent[]) tree.apply(e);
  const after = store.snapshot().seq;

  expect(after).toBeGreaterThan(before);
});

test('span-store: onChange fires after each apply that mutates state', () => {
  const tree = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  const store = createSpanStore();
  tree.onEvent((e, ctx) => store.apply(e, ctx));

  let fires = 0;
  const unsub = store.onChange(() => {
    fires++;
  });

  let seq = 0;
  for (const e of parseLine(typed('u1', 'go'), { ...ctx, seq: seq++ }) as NormalizedEvent[]) tree.apply(e);
  unsub();

  expect(fires).toBeGreaterThan(0);
});

// An Esc: the NEXT user line carries interruptedMessageId (verified shape from golden-transcript.test.ts).
const typedAfterEsc = (uuid: string, text: string, interrupted: string, ts = '2026-07-14T10:00:20.000Z') =>
  JSON.stringify({
    type: 'user',
    uuid,
    timestamp: ts,
    origin: { kind: 'human' },
    promptSource: 'typed',
    interruptedMessageId: interrupted,
    message: { role: 'user', content: text },
  });

test('span-store: an interrupted turn has state "interrupted"', () => {
  const lines = [
    typed('u1', 'do the thing', '2026-07-14T10:00:00.000Z'),
    call('a1', 'msg_006', '2026-07-14T10:00:02.000Z'),
    // The NEXT typed line carries interruptedMessageId — this is the Esc signal.
    typedAfterEsc('u2', 'no, stop', 'u1', '2026-07-14T10:00:05.000Z'),
    call('a2', 'msg_007', '2026-07-14T10:00:07.000Z'),
    turnDuration('t1', '2026-07-14T10:00:09.000Z'),
  ];
  const snap = storeOf(lines).snapshot();

  expect(snap.turns.length).toBe(2);
  expect(snap.turns[0]!.state).toBe('interrupted');
  // The second turn (the recovery prompt) is still live or done — not interrupted.
  expect(snap.turns[1]!.state).not.toBe('interrupted');
});

test('span-store: a Task spawn produces a spawn span and one subagent lane with its spans', () => {
  const tree = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  const store = createSpanStore();
  tree.onEvent((e, ctx) => store.apply(e, ctx));

  let seq = 0;
  // Inject a pre-built event directly into the tree (bypasses the parser).
  // Used for events whose agentId or payload cannot be expressed as raw jsonl in this test context.
  // Cast via unknown because NormalizedEvent is a discriminated union; TypeScript cannot widen
  // an object literal to the union automatically, but the runtime shape is correct.
  const applyEv = (e: object) => tree.apply({ ...e, seq: seq++ } as unknown as NormalizedEvent);

  // Turn 1: a typed prompt
  for (const e of parseLine(typed('u1', 'run task', '2026-07-14T10:00:00.000Z'), {
    sessionId: 's1',
    root: 'cli' as const,
    seq: seq++,
    agentId: null,
  }) as NormalizedEvent[])
    tree.apply(e);

  // Spawn: Task tool-start on the main session
  applyEv({
    type: 'tool-start',
    sessionId: 's1',
    root: 'cli',
    timestamp: '2026-07-14T10:00:01.000Z',
    id: 'task_001',
    name: 'Task',
    agentId: null,
  });

  // Child tool-start (agentId set) — arrives BEFORE agent-end — must be buffered, then flushed
  applyEv({
    type: 'tool-start',
    sessionId: 's1',
    root: 'cli',
    timestamp: '2026-07-14T10:00:02.000Z',
    id: 'sub_read_1',
    name: 'Read',
    agentId: 'agent_abc',
  });

  // Agent-end: establishes the agentId → spawnId link, creates the lane, flushes the buffer
  applyEv({
    type: 'agent-end',
    sessionId: 's1',
    root: 'cli',
    timestamp: '2026-07-14T10:00:10.000Z',
    toolUseId: 'task_001',
    taskId: 'agent_abc',
    status: 'completed',
  });

  const snap = store.snapshot();
  const turn = snap.turns.find((t) => t.spawns.length > 0)!;
  expect(turn.spawns.length).toBe(1);
  expect(turn.spawns[0]!.kind).toBe('Task');
  expect(turn.spawns[0]!.lanes.length).toBe(1);
  expect(turn.spawns[0]!.lanes[0]!.spans.length).toBeGreaterThan(0);
  // the subagent's own tool block still carries a drawer handle
  expect(turn.spawns[0]!.lanes[0]!.spans[0]!.handle).toBeTruthy();
});

test('span-store: subagent-meta via toolUseId enriches the lane label', () => {
  const tree = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  const store = createSpanStore();
  tree.onEvent((e, ctx) => store.apply(e, ctx));

  let seq = 0;
  const applyEv = (e: object) => tree.apply({ ...e, seq: seq++ } as unknown as NormalizedEvent);

  // Main session prompt
  for (const e of parseLine(typed('u1', 'run task', '2026-07-14T10:00:00.000Z'), {
    sessionId: 's1',
    root: 'cli' as const,
    seq: seq++,
    agentId: null,
  }) as NormalizedEvent[])
    tree.apply(e);

  // Spawn
  applyEv({
    type: 'tool-start',
    sessionId: 's1',
    root: 'cli',
    timestamp: '2026-07-14T10:00:01.000Z',
    id: 'task_002',
    name: 'Task',
    agentId: null,
  });

  // subagent-meta: arrives BEFORE agent-end (common for async subagents).
  // toolUseId is the canonical link; agentId identifies the child lane.
  applyEv({
    type: 'subagent-meta',
    sessionId: 's1',
    root: 'cli',
    timestamp: '2026-07-14T10:00:02.000Z',
    agentId: 'agent_xyz',
    toolUseId: 'task_002',
    agentType: 'general-purpose',
    model: 'claude-haiku-4-5',
    spawnDepth: 1,
  });

  // agent-end: fires after meta in this scenario
  applyEv({
    type: 'agent-end',
    sessionId: 's1',
    root: 'cli',
    timestamp: '2026-07-14T10:00:10.000Z',
    toolUseId: 'task_002',
    taskId: 'agent_xyz',
    status: 'completed',
  });

  const snap = store.snapshot();
  const turn = snap.turns.find((t) => t.spawns.length > 0)!;
  expect(turn.spawns[0]!.lanes.length).toBe(1);
  expect(turn.spawns[0]!.lanes[0]!.label).toContain('general-purpose');
  expect(turn.spawns[0]!.lanes[0]!.label).toContain('claude-haiku-4-5');
});

// A resumed subagent's notification is keyed on the SendMessage call, which is no spawn:
// routed by toolUseId alone the lane keeps its pre-resume status forever.
test('span-store: a resumed subagent lane takes the status of a SendMessage-keyed agent-end', () => {
  const tree = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  const store = createSpanStore();
  tree.onEvent((e, ctx) => store.apply(e, ctx));

  let seq = 0;
  const applyEv = (e: object) => tree.apply({ ...e, seq: seq++ } as unknown as NormalizedEvent);

  for (const e of parseLine(typed('u1', 'run task', '2026-07-14T10:00:00.000Z'), {
    sessionId: 's1',
    root: 'cli' as const,
    seq: seq++,
    agentId: null,
  }) as NormalizedEvent[])
    tree.apply(e);

  applyEv({
    type: 'tool-start',
    sessionId: 's1',
    root: 'cli',
    timestamp: '2026-07-14T10:00:01.000Z',
    id: 'task_003',
    name: 'Task',
    agentId: null,
  });
  applyEv({
    type: 'agent-end',
    sessionId: 's1',
    root: 'cli',
    timestamp: '2026-07-14T10:00:10.000Z',
    toolUseId: 'task_003',
    taskId: 'agent_res',
    status: 'completed',
  });
  // The resume, then the second stop — keyed on the SendMessage, not on the spawn.
  applyEv({
    type: 'tool-start',
    sessionId: 's1',
    root: 'cli',
    timestamp: '2026-07-14T10:00:20.000Z',
    id: 'toolu_send',
    name: 'SendMessage',
    arg: 'agent_res',
    agentId: null,
  });
  applyEv({
    type: 'agent-end',
    sessionId: 's1',
    root: 'cli',
    timestamp: '2026-07-14T10:00:30.000Z',
    toolUseId: 'toolu_send',
    taskId: 'agent_res',
    status: 'failed',
  });

  const turn = store.snapshot().turns.find((t) => t.spawns.length > 0)!;
  const lanes = turn.spawns.flatMap((s) => s.lanes).filter((l) => l.agentId === 'agent_res');
  expect(lanes.length).toBe(1);
  expect(lanes[0]!.status).toBe('failed');
});

// A slash command as it really appears: no origin, no promptSource.
// Shape taken verbatim from golden-transcript.test.ts — the same file that proved the parser
// was dropping these lines entirely (the original silent-drop bug).
const slash = (uuid: string, name: string, args = '') =>
  JSON.stringify({
    type: 'user',
    uuid,
    timestamp: '2026-07-14T10:00:00.000Z',
    message: {
      role: 'user',
      content: `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>\n<command-args>${args}</command-args>`,
    },
  });

test('span-store: an argument-less slash command turn has kind "local"', () => {
  // A slash command with no args has no origin.kind:'human', no promptSource.
  // The span-store maps any command turn (e.command != null) to kind:'local' because
  // it cannot receive the reducer's context/local distinction — that distinction lives only
  // in the session-tree reducer and is not forwarded as a span event. The invariant here is
  // that a slash command is NEVER classified as 'work'.
  const snap = storeOf([slash('u1', 'clear')]).snapshot();

  expect(snap.turns.length).toBe(1);
  expect(snap.turns[0]!.kind).toBe('local');
});

// A Workflow tool-use line and its async launch receipt — shapes from golden-transcript.test.ts.
const workflowToolUse = (uuid: string, id: string) =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: '2026-07-14T10:00:01.000Z',
    message: {
      role: 'assistant',
      model: 'claude-opus-4-8',
      content: [{ type: 'tool_use', id, name: 'Workflow', input: { name: 'deep-research', args: 'a question' } }],
    },
  });
const workflowLaunchReceipt = (uuid: string, toolUseId: string, runId: string) =>
  JSON.stringify({
    type: 'user',
    uuid,
    timestamp: '2026-07-14T10:00:02.070Z',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'text', text: 'Workflow launched' }] },
      ],
    },
    toolUseResult: {
      status: 'async_launched',
      taskId: 'w7yw10hxn',
      taskType: 'local_workflow',
      workflowName: 'deep-research',
      runId,
      summary: 'Deep research harness',
      transcriptDir: `/home/dev/session/subagents/workflows/${runId}`,
    },
  });

test('span-store: a Workflow tool-end with workflow.runId sets the spawn kind to "Workflow"', () => {
  // The parser reads toolUseResult.runId and attaches ev.workflow = { runId, name }; span-store
  // picks that up in the tool-end branch and upgrades the TraceSpawn.kind from the raw tool name
  // to 'Workflow', which the renderer uses to choose the Workflow icon/label.
  const lines = [
    typed('u1', 'research this', '2026-07-14T10:00:00.000Z'),
    workflowToolUse('a1', 'toolu_wf01'),
    workflowLaunchReceipt('u2', 'toolu_wf01', 'wf_test001'),
  ];
  const snap = storeOf(lines).snapshot();

  const turn = snap.turns.find((t) => t.spawns.length > 0);
  expect(turn).toBeDefined();
  expect(turn!.spawns[0]!.kind).toBe('Workflow');
});

test('span-store: tool span is closed (t1 > t0, status ok) after its tool-end', () => {
  const lines = [
    typed('u1', 'fix the bug', '2026-07-14T10:00:00.000Z'),
    call('a1', 'msg_005', '2026-07-14T10:00:02.000Z'),
    toolUse('a2', 'toolu_02', 'Read', '2026-07-14T10:00:03.000Z'),
    toolResult('u2', 'toolu_02', 'file contents', '2026-07-14T10:00:04.000Z'),
    turnDuration('t1', '2026-07-14T10:00:09.000Z'),
  ];
  const snap = storeOf(lines).snapshot();
  const toolSpan = snap.turns[0]!.spans.find((s) => s.type === 'tool')!;

  expect(toolSpan.status).toBe('ok');
  expect(toolSpan.t1).toBeGreaterThan(toolSpan.t0);
});

test('span-store: LIVE ordering — meta and child events BEFORE the spawn tool-start still build the lane', () => {
  // Live, the watcher sees the child jsonl + meta.json as soon as the agent starts,
  // but the parent's assistant line (with the Agent tool_use) is only written when
  // the API response COMPLETES — so subagent-meta and child events arrive FIRST.
  // Reproduces the live-session symptom: every spawn showed "no child data yet"
  // while its agent was visibly running.
  const tree = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  const store = createSpanStore();
  tree.onEvent((e, ctx) => store.apply(e, ctx));

  let seq = 0;
  const applyEv = (e: object) => tree.apply({ ...e, seq: seq++ } as unknown as NormalizedEvent);

  for (const e of parseLine(typed('u1', 'fan out', '2026-07-14T10:00:00.000Z'), {
    sessionId: 's1',
    root: 'cli' as const,
    seq: seq++,
    agentId: null,
  }) as NormalizedEvent[])
    tree.apply(e);

  // 1. child tool-start arrives first (watcher pumps the child file immediately)
  applyEv({
    type: 'tool-start',
    sessionId: 's1',
    root: 'cli',
    timestamp: '2026-07-14T10:00:01.000Z',
    id: 'sub_read_1',
    name: 'Read',
    agentId: 'agent_live',
  });
  // 2. subagent-meta arrives next (meta.json read on the same scan) — spawn NOT yet known
  applyEv({
    type: 'subagent-meta',
    sessionId: 's1',
    root: 'cli',
    timestamp: '2026-07-14T10:00:01.500Z',
    agentId: 'agent_live',
    toolUseId: 'task_live',
    agentType: 'general-purpose',
    model: 'claude-haiku-4-5',
    spawnDepth: 1,
  });
  // 3. the parent's spawn tool-start lands only now (assistant line written at response end)
  applyEv({
    type: 'tool-start',
    sessionId: 's1',
    root: 'cli',
    timestamp: '2026-07-14T10:00:12.000Z',
    id: 'task_live',
    name: 'Agent',
    agentId: null,
  });
  // 4. more child events keep streaming — the agent has NOT ended yet
  applyEv({
    type: 'tool-start',
    sessionId: 's1',
    root: 'cli',
    timestamp: '2026-07-14T10:00:13.000Z',
    id: 'sub_bash_1',
    name: 'Bash',
    agentId: 'agent_live',
  });

  const snap = store.snapshot();
  const turn = snap.turns.find((t) => t.spawns.length > 0)!;
  expect(turn).toBeTruthy();
  const lanes = turn.spawns[0]!.lanes;
  expect(lanes.length).toBe(1); // lane exists while the agent RUNS
  expect(lanes[0]!.label).toContain('general-purpose');
  expect(lanes[0]!.spans.length).toBe(2); // both child tools routed (1 pre-spawn buffered + 1 post)
});

test('span-store: a spawn span prefers the launch DESCRIPTION over prompt/subagentType', () => {
  // Shape verified on a real agent-*.meta.json + the Agent tool_use input:
  // description is the 3-5 word human intent of the launch.
  const spawnLine = JSON.stringify({
    type: 'assistant',
    uuid: 'a9',
    timestamp: '2026-07-14T10:00:03.000Z',
    message: {
      role: 'assistant',
      model: 'claude-opus-4-8',
      content: [
        {
          type: 'tool_use',
          id: 'ag_1',
          name: 'Agent',
          input: {
            prompt: 'You are a finder agent. Read the diff...',
            subagent_type: 'general-purpose',
            description: 'Finder A: line-by-line scan',
          },
        },
      ],
    },
  });
  const snap = storeOf([typed('u1', 'review this'), spawnLine]).snapshot();
  const spawn = snap.turns[0]!.spans.find((s) => s.type === 'spawn')!;
  expect(spawn.detail).toBe('Finder A: line-by-line scan');
});

// A background command's outcome arrives long after its span closed, on a `queue-operation`
// line. Without routing it, a command that exited 144 leaves a clean 70ms tool span — which is
// what made a real failure invisible in both the Trace and the all-activity list.
const bashBackground = (uuid: string, id: string, command: string, ts = '2026-07-14T10:00:03.000Z') =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: ts,
    message: {
      role: 'assistant',
      model: 'claude-opus-4-8',
      content: [
        {
          type: 'tool_use',
          id,
          name: 'Bash',
          input: { command, description: 'Start the server', run_in_background: true },
        },
      ],
    },
  });
const backgroundReceipt = (uuid: string, toolUseId: string, taskId: string, ts = '2026-07-14T10:00:03.074Z') =>
  JSON.stringify({
    type: 'user',
    uuid,
    timestamp: ts,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: '' }] },
    toolUseResult: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: taskId },
  });
const backgroundNotification = (
  toolUseId: string,
  taskId: string,
  status: string,
  summary: string,
  ts = '2026-07-14T10:30:00.000Z',
) =>
  JSON.stringify({
    type: 'queue-operation',
    operation: 'enqueue',
    sessionId: 's1',
    timestamp: ts,
    content: `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`,
  });

test('span-store: a failed background command colours its span and states why', () => {
  const summary = 'Background command "Start the server" failed with exit code 144';
  const snap = storeOf([
    typed('u1', 'start the server'),
    bashBackground('a2', 'toolu_b1', 'bun run main.ts'),
    backgroundReceipt('u2', 'toolu_b1', 'b0cm7fbxc'),
    backgroundNotification('toolu_b1', 'b0cm7fbxc', 'failed', summary),
  ]).snapshot();
  const span = snap.turns[0]!.spans.find((s) => s.type === 'tool')!;
  expect(span.status).toBe('error');
  // Claude Code's words, reordered so the fate survives the column's right-hand truncation.
  expect(span.detail).toBe('failed with exit code 144 · Background command "Start the server"');
  // The span still measures the LAUNCH, not the command's lifetime: 74ms, not 30 minutes.
  expect(span.t1 - span.t0).toBe(74);
  // …which is exactly why the span says it was a background launch: the mark is what stops that
  // 74ms being read as the command's duration.
  expect(span.background).toBe(true);
});

test('span-store: a background command that completes stays a clean row showing its command', () => {
  const snap = storeOf([
    typed('u1', 'build it'),
    bashBackground('a2', 'toolu_b1', 'bun run build.ts'),
    backgroundReceipt('u2', 'toolu_b1', 'bdfgju7ns'),
    backgroundNotification(
      'toolu_b1',
      'bdfgju7ns',
      'completed',
      'Background command "Start the server" completed (exit code 0)',
    ),
  ]).snapshot();
  const span = snap.turns[0]!.spans.find((s) => s.type === 'tool')!;
  expect(span.status).toBe('ok');
  expect(span.detail).toBe('bun run build.ts');
  // The mark is on the LAUNCH, whatever became of the command — a clean row is the case where
  // nothing else on it says the command ever left this call.
  expect(span.background).toBe(true);
});

// The gate is the launch receipt, not the notification's id. A notification naming a tool that
// launched no background command must leave that row untouched.
test('span-store: a notification for a non-background tool changes nothing', () => {
  const snap = storeOf([
    typed('u1', 'read it'),
    toolUse('a2', 'toolu_01', 'Read'),
    toolResult('u2', 'toolu_01', 'file contents'),
    backgroundNotification(
      'toolu_01',
      'b0cm7fbxc',
      'failed',
      'Background command "something else" failed with exit code 144',
    ),
  ]).snapshot();
  const span = snap.turns[0]!.spans.find((s) => s.type === 'tool')!;
  expect(span.status).toBe('ok');
  expect(span.detail).toBe('~/x.ts'); // the label the tool already had, anonymized as always
  expect(span.background).toBeUndefined();
});

// ── the intent that opened a round names it ─────────────────────────────────
// A response is written as SEVERAL jsonl lines sharing one `message.id`: the text block (the
// model saying what it is about to do) and each tool_use. The Trace's round is that same call
// plus its tools, so the intent belongs to the round's api span — joined on the id, never on
// "the last api span", or a late line names whatever round happens to be open.

/** The narration line of a call: a text block with stop_reason "tool_use", carrying its id. */
const narrationOf = (uuid: string, id: string, text: string, ts = '2026-07-14T10:00:02.000Z') =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: ts,
    message: {
      role: 'assistant',
      id,
      model: 'claude-opus-4-8',
      stop_reason: 'tool_use',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 5_000, cache_creation_input_tokens: 0 },
    },
  });

test('span-store: an intent lands on the api span of its OWN call', () => {
  const snap = storeOf([
    typed('u1', 'find the bug', '2026-07-14T10:00:00.000Z'),
    // Call one speaks, then acts. The narration line carries the call's usage, so it is also
    // what CREATES the api span: the parser emits `usage` before the text block of the same line.
    narrationOf('a1', 'msg_001', 'Checking the parser first.', '2026-07-14T10:00:02.000Z'),
    toolUse('a2', 'toolu_01', 'Read', '2026-07-14T10:00:03.000Z'),
    toolResult('u2', 'toolu_01', 'file contents', '2026-07-14T10:00:04.000Z'),
    // Call two acts in silence — the common case: 60% of real rounds state no intent.
    call('a3', 'msg_002', '2026-07-14T10:00:05.000Z'),
    toolUse('a4', 'toolu_02', 'Bash', '2026-07-14T10:00:06.000Z'),
    toolResult('u3', 'toolu_02', 'ok', '2026-07-14T10:00:07.000Z'),
    endTurn('a5', 'Done.', '2026-07-14T10:00:08.000Z'),
    turnDuration('t1', '2026-07-14T10:00:09.000Z'),
  ]).snapshot();

  const apis = snap.turns[0]!.spans.filter((s) => s.type === 'api');
  expect(apis.length).toBe(2);
  expect(apis[0]!.narration).toBe('Checking the parser first.');
  expect(apis[1]!.narration).toBeUndefined();
});

test('span-store: a narration arriving after the NEXT call still names its own round', () => {
  // The failure this guards: a block's line is appended when the block CLOSES, so a slow text
  // block can land after the following call's lines. Anchored on "the last api span" it would
  // name the wrong round — the one the model had already moved on to.
  const snap = storeOf([
    typed('u1', 'do it', '2026-07-14T10:00:00.000Z'),
    call('a1', 'msg_001', '2026-07-14T10:00:02.000Z'),
    call('a2', 'msg_002', '2026-07-14T10:00:05.000Z'),
    narrationOf('a3', 'msg_001', 'This belongs to the FIRST call.', '2026-07-14T10:00:06.000Z'),
    turnDuration('t1', '2026-07-14T10:00:09.000Z'),
  ]).snapshot();

  const apis = snap.turns[0]!.spans.filter((s) => s.type === 'api');
  expect(apis.length).toBe(2);
  expect(apis[0]!.narration).toBe('This belongs to the FIRST call.');
  expect(apis[1]!.narration).toBeUndefined();
});

/** An end_turn line carrying a call id — the shape that makes the stop_reason gate falsifiable. */
const endTurnOf = (uuid: string, id: string, text: string, ts = '2026-07-14T10:00:08.000Z') =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: ts,
    message: {
      role: 'assistant',
      id,
      model: 'claude-opus-4-8',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text }],
    },
  });

test('span-store: the turn RESULT is not an intent, even sharing the call id', () => {
  // The stop_reason gate, seen from the Trace: an end_turn text is the answer, and naming the
  // round with it would put the conclusion on the block that led to it. The id MUST match the
  // api span, or the test proves nothing: without it the answer's event carries `callId: null`,
  // which the store ignores anyway — the assertion then passes with the gate removed too.
  const snap = storeOf([
    typed('u1', 'do it', '2026-07-14T10:00:00.000Z'),
    call('a1', 'msg_001', '2026-07-14T10:00:02.000Z'),
    endTurnOf('a2', 'msg_001', 'Done — the parser dropped the line.'),
    turnDuration('t1', '2026-07-14T10:00:09.000Z'),
  ]).snapshot();

  expect(snap.turns[0]!.spans.find((s) => s.type === 'api')!.narration).toBeUndefined();
});

// A forked skill (`/code-review`) has no `Agent` tool_use, so the Trace saw a round that
// did nothing at all — one collapsed idle line while its agent worked for ten minutes. Its launch
// line is the only record, and it has no toolUseId, so its block is keyed by the agent id.
test('span-store: a forked skill’s launch is a spawn block, and its child routes into it', () => {
  const bare = (uuid: string, text: string, ts: string) =>
    JSON.stringify({ type: 'user', uuid, timestamp: ts, promptId: 'p-1', message: { role: 'user', content: text } });
  const launch = (uuid: string, agentId: string, skill: string, desc: string, ts: string) =>
    JSON.stringify({
      type: 'system',
      subtype: 'local_command',
      uuid,
      timestamp: ts,
      content: `<forked-skill-launch>${JSON.stringify({ agentId, skillName: skill, description: desc })}</forked-skill-launch>`,
    });

  const store = storeOf([
    bare('u1', '/code-review', '2026-07-14T10:00:00.000Z'),
    launch('s1', 'a96ede12', 'code-review', '/code-review diff', '2026-07-14T10:00:01.000Z'),
  ]);
  // The sidecar names the child; with no toolUseId the agent id is the key.
  store.apply(
    {
      type: 'subagent-meta',
      sessionId: 's1',
      root: 'cli',
      timestamp: '2026-07-14T10:00:01.500Z',
      seq: 99,
      agentId: 'a96ede12',
      toolUseId: null,
      agentType: 'general-purpose',
      spawnDepth: 1,
      model: 'claude-opus-4-8',
    } as NormalizedEvent,
    { turnIndex: 1 } as never,
  );
  const turn = store.snapshot().turns[0]!;
  expect(turn.spans.map((s) => s.type)).toEqual(['prompt', 'spawn']);
  // Same call the reducer's `kindOf` makes: delegating IS running the model. The kind is a guess
  // when the turn opens (a `user-turn` carries only its command name); the launch answers it.
  expect(turn.kind).toBe('work');
  expect(turn.spawns.length).toBe(1);
  expect(turn.spawns[0]!.label).toBe('/code-review');
  expect(turn.spawns[0]!.spawnId).toBe('a96ede12');
  expect(turn.spawns[0]!.lanes.map((l) => l.agentId)).toEqual(['a96ede12']);
  // The Trace links a spawn SPAN to its block through handle.toolUseId and nothing else, so a
  // handle without it drew the block with "no child events" while the lane sat in the store.
  expect(turn.spans.find((s) => s.type === 'spawn')!.handle).toEqual({
    kind: 'subagent',
    agentId: 'a96ede12',
    toolUseId: 'a96ede12',
  });
  const h = turn.spans.find((s) => s.type === 'spawn')!.handle!;
  expect('toolUseId' in h ? h.toolUseId : null).toBe(turn.spawns[0]!.spawnId);
});

// Same ordering as the reducer's golden case: Claude Code writes the end before the launch when a
// background command finishes inside the assistant block that started it. The Trace's row was left
// `running`, with no outcome, for the rest of the session.
test('span-store: a background command that reported before its launch still gets its outcome', () => {
  const notify = JSON.stringify({
    type: 'queue-operation',
    operation: 'enqueue',
    uuid: 'q1',
    timestamp: '2026-07-14T10:00:04.000Z',
    content:
      '<task-notification>\n<task-id>bkg1</task-id>\n<tool-use-id>toolu_bg</tool-use-id>\n<status>failed</status>\n<summary>Background command "sample" failed with exit code 1</summary>\n</task-notification>',
  });
  const launch = JSON.stringify({
    type: 'assistant',
    uuid: 'a1',
    timestamp: '2026-07-14T10:00:02.000Z',
    message: {
      role: 'assistant',
      id: 'msg_bg',
      model: 'claude-opus-4-8',
      content: [
        { type: 'tool_use', id: 'toolu_bg', name: 'Bash', input: { command: './s.sh', run_in_background: true } },
      ],
      usage: { input_tokens: 4, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
    },
  });
  const receipt = JSON.stringify({
    type: 'user',
    uuid: 'u2',
    timestamp: '2026-07-14T10:00:05.000Z',
    toolUseResult: { backgroundTaskId: 'bkg1' },
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_bg', content: 'Command running in background with ID: bkg1' },
      ],
    },
  });

  const snap = storeOf([typed('u1', 'run it', '2026-07-14T10:00:00.000Z'), notify, launch, receipt]).snapshot();
  const span = snap.turns[0]!.spans.find((s) => s.type === 'tool')!;
  expect(span.status).toBe('error');
  expect(span.detail).toContain('failed with exit code 1');
});

// A command's arguments ARE its prompt, so a `/code-review del diff` round was titled
// `del diff` — the command, the only part that names what ran, dropped. The Graph's rows had the
// rule (`entryLabel`); the Trace had its own (`prompt || command`), which is how they diverged.
test('span-store: a command round is titled by the command AND its arguments', () => {
  const cmd = (uuid: string, name: string, args: string, ts: string) =>
    JSON.stringify({
      type: 'user',
      uuid,
      timestamp: ts,
      message: {
        role: 'user',
        content: `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>\n<command-args>${args}</command-args>`,
      },
    });
  const snap = storeOf([cmd('u1', 'code-review', 'del diff', '2026-07-14T10:00:00.000Z')]).snapshot();
  expect(snap.turns[0]!.title).toBe('/code-review del diff');
  // An argument-less command still names itself, and is not prefixed twice.
  const bare = storeOf([cmd('u2', 'compact', '', '2026-07-14T10:00:00.000Z')]).snapshot();
  expect(bare.turns[0]!.title).toBe('/compact');
});

// The review's HIGH finding, reproduced as a test: a child writes its first lines BEFORE the
// parent's launch line lands (measured elsewhere: a subagent's first trace is 0.07s after launch,
// while an assistant line waits for its block to close). Linking agentId→spawn at the launch made
// the routing stop buffering while no lane existed yet, and the flush then dropped what it could
// not apply — the child's early events vanished from the Trace.
test('span-store: a forked skill’s child events survive arriving before its lane exists', () => {
  const store = createSpanStore();
  const ctx = { turnIndex: 1 } as never;
  const at = (n: number) => `2026-07-14T10:00:0${n}.000Z`;
  store.apply(
    {
      type: 'user-turn',
      sessionId: 's1',
      root: 'cli',
      timestamp: at(0),
      seq: 0,
      agentId: null,
      prompt: '/code-review',
      command: 'code-review',
    } as NormalizedEvent,
    ctx,
  );
  // The child runs first…
  store.apply(
    {
      type: 'tool-start',
      sessionId: 's1',
      root: 'cli',
      timestamp: at(1),
      seq: 1,
      agentId: 'ag1',
      id: 'toolu_c1',
      name: 'Grep',
      arg: 'needle',
    } as NormalizedEvent,
    ctx,
  );
  // …then the launch line lands, then the sidecar that names the child.
  store.apply(
    {
      type: 'agent-launch',
      sessionId: 's1',
      root: 'cli',
      timestamp: at(2),
      seq: 2,
      agentId: null,
      launchedAgentId: 'ag1',
      skillName: 'code-review',
      description: '/code-review',
    } as NormalizedEvent,
    ctx,
  );
  store.apply(
    {
      type: 'subagent-meta',
      sessionId: 's1',
      root: 'cli',
      timestamp: at(3),
      seq: 3,
      agentId: 'ag1',
      toolUseId: null,
      agentType: 'general-purpose',
      spawnDepth: 1,
      model: 'claude-opus-4-8',
    } as NormalizedEvent,
    ctx,
  );
  store.apply(
    {
      type: 'tool-start',
      sessionId: 's1',
      root: 'cli',
      timestamp: at(4),
      seq: 4,
      agentId: 'ag1',
      id: 'toolu_c2',
      name: 'Read',
      arg: 'file.ts',
    } as NormalizedEvent,
    ctx,
  );

  const lane = store.snapshot().turns[0]!.spawns[0]!.lanes[0]!;
  expect(lane.spans.map((s) => s.label)).toEqual(['Grep', 'Read']);
});

// The review's #8: every other span-creating branch propagates t1 to its turn. Without it a
// ten-minute `/code-review` measured ~1s, and the Trace's duration bar is a share of the longest
// turn — so the round that ran longest read as the shortest thing on screen.
test('span-store: a delegated round lasts as long as the work it handed off', () => {
  const store = createSpanStore();
  const ctx = { turnIndex: 1 } as never;
  const ev = (o: object) =>
    store.apply({ sessionId: 's1', root: 'cli', seq: 0, agentId: null, ...o } as NormalizedEvent, ctx);
  ev({ type: 'user-turn', timestamp: '2026-07-14T10:00:00.000Z', prompt: '/code-review', command: 'code-review' });
  ev({
    type: 'agent-launch',
    timestamp: '2026-07-14T10:00:01.000Z',
    launchedAgentId: 'ag1',
    skillName: 'code-review',
    description: '/code-review',
  });
  const afterLaunch = store.snapshot().turns[0]!;
  expect(afterLaunch.t1).toBeGreaterThanOrEqual(Date.parse('2026-07-14T10:00:01.000Z'));
  ev({
    type: 'agent-end',
    timestamp: '2026-07-14T10:10:00.000Z',
    toolUseId: null,
    taskId: 'ag1',
    status: 'completed',
    summary: null,
  });
  const done = store.snapshot().turns[0]!;
  // and so does its return — ten minutes, not one second
  expect(done.t1).toBe(Date.parse('2026-07-14T10:10:00.000Z'));
});
