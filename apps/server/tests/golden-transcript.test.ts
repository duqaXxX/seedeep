import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nowLine } from '../src/core/activity-line.ts';
import { windowFor } from '../src/core/context-windows.ts';
import { delegatedWork } from '../src/core/graph-derive.ts';
import { backgroundCommands, changedFiles, runningBackground, scopeToTurn, tokenUsage } from '../src/core/selectors.ts';
import { createSessionTree } from '../src/core/session-tree.ts';
import { createSpanStore } from '../src/core/span-store.ts';
import { groupTurnSpans } from '../src/core/trace-group.ts';
import type { NormalizedEvent } from '../src/core/types.ts';
import { computeVerdict, turnBillable, turnResumeCost, turnWork } from '../src/core/verdict.ts';
import { parseLine } from '../src/server/parser.ts';

// THE test the codebase was missing. Every other test feeds the reducer events built BY HAND
// — which means it encodes the same beliefs as the code, and can never falsify them. This one
// starts from raw JSONL lines shaped exactly like Claude Code writes them (verified against
// real sessions: a typed prompt carries `origin.kind: 'human'` + `promptSource`, a slash
// command carries NEITHER and puts the user's text in <command-args>), runs them through the
// real parser and the real reducer, and asserts the timeline that comes out.
//
// The bug it exists to catch: slash commands were dropped by the parser, so a `/paste-image …`
// round produced no turn at all — no live bar while Claude worked, and its turn_duration
// landed on the previous turn. Content is synthetic; only the SHAPE is real.

const ctx = { sessionId: 's1', root: 'cli' as const, agentId: null };

const typed = (uuid: string, text: string) =>
  JSON.stringify({
    type: 'user',
    uuid,
    timestamp: '2026-07-14T10:00:00.000Z',
    origin: { kind: 'human' },
    promptSource: 'typed',
    message: { role: 'user', content: text },
  });
// A slash command as it really appears: no origin, no promptSource, args carry the prompt.
const slash = (uuid: string, name: string, args = '', promptId?: string) =>
  JSON.stringify({
    type: 'user',
    uuid,
    timestamp: '2026-07-14T10:00:00.000Z',
    ...(promptId ? { promptId } : {}),
    message: {
      role: 'user',
      content: `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>\n<command-args>${args}</command-args>`,
    },
  });
// The OTHER shape of the same thing: the command as the user typed it, in plain text, with no
// origin, no promptSource and no tags at all. Measured 2026-08-02 over 721 real transcripts —
// 19 lines, all of them `/compact` or `/code-review`, on versions 2.1.200 → 2.1.220. Read as a
// non-prompt it dropped the whole round: no turn, and its work credited to the previous one.
const bareSlash = (uuid: string, text: string, promptId: string, ts = '2026-07-14T10:00:00.000Z') =>
  JSON.stringify({
    type: 'user',
    uuid,
    timestamp: ts,
    promptId,
    message: { role: 'user', content: text },
  });
// What a forked skill (`/code-review`, run in the background) leaves in the PARENT transcript
// instead of an `Agent` tool_use: a local_command line carrying the launch as JSON.
const forkedLaunch = (uuid: string, agentId: string, skillName: string, description: string) =>
  JSON.stringify({
    type: 'system',
    subtype: 'local_command',
    uuid,
    timestamp: '2026-07-14T10:00:01.000Z',
    isMeta: false,
    content:
      `<local-command-stdout>Running in the background as @${skillName}</local-command-stdout>\n` +
      `<forked-skill-launch>${JSON.stringify({ agentId, skillName, description })}</forked-skill-launch>`,
  });
// The skill body Claude Code injects after a skill command — not something the user sent.
const skillBody = (uuid: string) =>
  JSON.stringify({
    type: 'user',
    uuid,
    isMeta: true,
    timestamp: '2026-07-14T10:00:01.000Z',
    message: { role: 'user', content: [{ type: 'text', text: 'Fetch the screenshot and display it.' }] },
  });
// What a local command leaves behind: its own stdout, and nothing else.
const localStdout = (uuid: string) =>
  JSON.stringify({
    type: 'user',
    uuid,
    timestamp: '2026-07-14T10:00:01.000Z',
    message: { role: 'user', content: '<local-command-stdout>Set model to Opus</local-command-stdout>' },
  });
const assistant = (uuid: string, fill: number, out = 100) =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: '2026-07-14T10:00:05.000Z',
    message: {
      role: 'assistant',
      model: 'claude-opus-4-8',
      usage: {
        input_tokens: 10,
        output_tokens: out,
        cache_read_input_tokens: fill - 10,
        cache_creation_input_tokens: 0,
      },
    },
  });
// Field names taken from a real line: {type:'system', subtype:'turn_duration', durationMs, messageCount}
const turnDuration = (uuid: string) =>
  JSON.stringify({
    type: 'system',
    subtype: 'turn_duration',
    uuid,
    timestamp: '2026-07-14T10:00:09.000Z',
    durationMs: 9000,
    messageCount: 3,
  });
// An Esc: the NEXT user line carries interruptedMessageId.
const typedAfterEsc = (uuid: string, text: string, interrupted: string) =>
  JSON.stringify({
    type: 'user',
    uuid,
    timestamp: '2026-07-14T10:00:20.000Z',
    origin: { kind: 'human' },
    promptSource: 'typed',
    interruptedMessageId: interrupted,
    message: { role: 'user', content: text },
  });

// A synthetic assistant line as Claude Code writes it when a turn produced NO model response
// (an auto-continue "No response requested.", or an API error): message.model is '<synthetic>'
// and the usage block is all zeros. It carries no turn_duration and no Esc marker.
const synthetic = (uuid: string, _text: string) =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: '2026-07-14T10:00:07.000Z',
    isApiErrorMessage: false,
    message: {
      role: 'assistant',
      model: '<synthetic>',
      stop_reason: 'stop_sequence',
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  });
// A `file-history-delta` shaped exactly like Claude Code writes it (verified on real sessions):
// CC backed up one file it changed. `trackingPath` is the file (repo-relative); the baseline
// `file-history-snapshot` is a separate line that must stay ignored.
const fileDelta = (uuid: string, path: string, ts = '2026-07-14T10:00:06.000Z') =>
  JSON.stringify({
    type: 'file-history-delta',
    messageId: uuid,
    snapshotMessageId: 'snap-' + uuid,
    trackingPath: path,
    backup: { backupFileName: uuid + '@v1', version: 1, backupTime: ts },
    timestamp: ts,
  });
// The baseline line — must produce NOTHING (it stays in the parser's IGNORED set).
const fileSnapshot = (uuid: string) =>
  JSON.stringify({
    type: 'file-history-snapshot',
    messageId: uuid,
    snapshot: { messageId: uuid, trackedFileBackups: {}, timestamp: '2026-07-14T10:00:06.000Z' },
    isSnapshotUpdate: false,
  });

/** Run raw lines through parser → reducer, exactly as the live pipeline does. */
function timelineOf(lines: string[]) {
  const tree = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  let seq = 0;
  for (const l of lines) {
    for (const e of parseLine(l, { ...ctx, seq: seq++ }) as NormalizedEvent[]) tree.apply(e);
  }
  return tree.snapshot();
}

test('golden transcript: a turn cut off (synthetic, no turn_duration) is interrupted, not stuck live', () => {
  // The real freeze: turn A worked, then was auto-continued — a synthetic "No response requested."
  // line, NO turn_duration, NO Esc marker. Turn B then opens. Without closing A on the new prompt,
  // A stays `live` forever: two live turns, and the intent panel (find first live) freezes on A's
  // "No response requested."; the `<synthetic>` model also poisons the model list.
  const snap = timelineOf([
    typed('u1', 'first request'),
    assistant('a1', 5000), // turn A did real work (a call)
    synthetic('s1', 'No response requested.'), // cut off — no turn_duration, no Esc
    typed('u2', 'second request'), // a new prompt supersedes A
    assistant('a2', 6000), // turn B, still working (no turn_duration → live)
  ]);
  const turns = snap.turnList;
  assert.equal(turns.length, 2);
  assert.equal(turns[0]!.state, 'interrupted', 'the cut-off turn is closed as interrupted, not left live');
  assert.equal(turns[1]!.state, 'live', 'only the newest turn is live');
  assert.equal(turns.filter((t) => t.state === 'live').length, 1, 'never two live turns');
  // <synthetic> never enters the model list, so the chip reads the real model, not "<synthetic>".
  assert.deepEqual(snap.main.models, ['claude-opus-4-8']);
});

test('golden transcript: every line the user sent becomes a timeline entry, typed for kind', () => {
  const snap = timelineOf([
    slash('u1', 'clear'), // context event, costs nothing
    slash('u2', 'model', 'opus'), // local command
    localStdout('u3'),
    typed('u4', 'fix the failing test'), // work turn
    assistant('a1', 50_000),
    turnDuration('t1'),
    slash('u5', 'paste-image', 'look at this and fix it'), // work turn — a command that RUNS
    skillBody('u6'),
    assistant('a2', 90_000),
    turnDuration('t2'),
  ]);

  assert.deepEqual(
    snap.turnList.map((t) => [t.command, t.kind, t.state]),
    [
      ['clear', 'context', 'done'],
      ['model', 'local', 'done'],
      [null, 'work', 'done'],
      ['paste-image', 'work', 'done'],
    ],
  );
  // the prompt of a slash command is what the user typed AFTER it
  assert.equal(snap.turnList[3]!.prompt, 'look at this and fix it');
  assert.equal(snap.turnList[0]!.prompt, '/clear', 'a command with no args is its own prompt');
  // `turns` counts ROUNDS OF WORK — not the things you typed
  assert.equal(snap.turns, 2, '/clear and /model are not work turns');
  // the injected skill body is NOT a user line and must not create an entry
  assert.equal(snap.turnList.length, 4);
});

test('golden transcript: a slash command that runs the model IS the live turn while it works', () => {
  // The exact regression: while a `/paste-image` round was running, no bar was green — the
  // strip claimed nothing was happening while Claude was working.
  const snap = timelineOf([
    typed('u1', 'first prompt'),
    assistant('a1', 40_000),
    turnDuration('t1'),
    slash('u2', 'paste-image', 'why is this broken'),
    skillBody('u3'),
    assistant('a2', 70_000), // tokens burnt: the round is really running
  ]);

  const live = snap.turnList.filter((t) => t.state === 'live');
  assert.equal(live.length, 1, 'exactly one live entry while the session works');
  assert.equal(live[0]!.command, 'paste-image');
  assert.equal(live[0]!.kind, 'work');
  assert.equal(snap.turnList[0]!.state, 'done', 'the finished turn is not live');
});

// ── The command Claude Code writes as plain text ────────────────────────────────────────────
// The bug: `/code-review del diff` produced NO turn at all, so the whole iteration was invisible
// and its work landed on the previous turn. The line has no `origin`, no `promptSource` and no
// `<command-name>` — every door the parser was checking.

test('golden transcript: a command written as plain text opens its turn', () => {
  const snap = timelineOf([
    typed('u1', 'first prompt'),
    assistant('a1', 40_000),
    turnDuration('t1'),
    bareSlash('u2', '/code-review del diff', 'p-2'),
    assistant('a2', 70_000), // the round really runs
  ]);

  assert.equal(snap.turnList.length, 2, 'the command opened a turn of its own');
  const last = snap.turnList[1]!;
  assert.equal(last.command, 'code-review');
  assert.equal(last.prompt, 'del diff', 'the args are the prompt, as they are for the tagged shape');
  assert.equal(last.state, 'live');
  // And it reaches the Commands widget, which reads the same event.
  assert.ok(
    snap.commands.some((c) => c.name === 'code-review'),
    'the command is counted',
  );
});

test('golden transcript: an argument-less plain-text command reads as its own name', () => {
  const snap = timelineOf([typed('u1', 'first prompt'), turnDuration('t1'), bareSlash('u2', '/compact', 'p-2')]);
  assert.equal(snap.turnList[1]!.prompt, '/compact');
  assert.equal(snap.turnList[1]!.command, 'compact');
});

test('golden transcript: one invocation written in BOTH shapes is ONE turn', () => {
  // `/compact` writes the plain-text line AND the tagged one, sharing a `promptId` — measured on
  // 15 of the 19 real plain-text lines. Counting both would invent a turn rather than restore one.
  const snap = timelineOf([
    typed('u1', 'first prompt'),
    turnDuration('t1'),
    bareSlash('u2', '/compact', 'p-2'),
    slash('u3', 'compact', '', 'p-2'),
  ]);
  assert.equal(snap.turnList.length, 2, 'the twin lines are one invocation, not two');
  assert.equal(snap.turnList[1]!.command, 'compact');
});

test('golden transcript: a queued prompt sharing a command’s promptId still opens its own turn', () => {
  // A real collision (2026-07-10): a prompt typed WHILE `/compact` ran was written with
  // `promptSource: 'queued'` and the compaction's own `promptId`. Deduping on the id alone would
  // swallow a human turn — so the dedup is only ever between two COMMAND lines naming the same
  // command.
  const queued = JSON.stringify({
    type: 'user',
    uuid: 'u4',
    timestamp: '2026-07-14T10:00:02.000Z',
    promptId: 'p-2',
    origin: { kind: 'human' },
    promptSource: 'queued',
    message: { role: 'user', content: 'and while you are at it, check the tests' },
  });
  const snap = timelineOf([bareSlash('u2', '/compact', 'p-2'), slash('u3', 'compact', '', 'p-2'), queued]);
  assert.equal(snap.turnList.length, 2, 'the human prompt is a turn of its own');
  assert.equal(snap.turnList[1]!.prompt, 'and while you are at it, check the tests');
});

test('golden transcript: a headless prompt shaped like a command opens NO turn', () => {
  // A `claude -p` line carries no `origin` either, so reading the shape first would file
  // `/review this` — in EITHER shape — as a slash command, and a headless run would grow a turn it
  // never had. Asserted here, on raw lines through the real parser, because this is the file that
  // owns turn detection: a subject test cannot see a phantom turn.
  const sdkPrompt = (uuid: string, content: string) =>
    JSON.stringify({
      type: 'user',
      uuid,
      timestamp: '2026-07-14T10:00:00.000Z',
      promptSource: 'sdk',
      entrypoint: 'sdk-cli',
      message: { role: 'user', content },
    });

  const snap = timelineOf([
    sdkPrompt('u1', '/review the changed files and report'),
    sdkPrompt('u2', '<command-name>/review</command-name>\n<command-args>the changed files</command-args>'),
    assistant('a1', 5_000),
  ]);

  assert.equal(snap.turnList.length, 0, 'a headless prompt is not a round in this session');
  assert.deepEqual(snap.commands, [], 'and it is not a command the user typed here either');
});

test('golden transcript: a forked skill’s agent belongs to the turn that launched it', () => {
  // A forked skill has no `Agent` tool_use, so before this the agent existed with no turn and no
  // name — it read `general-purpose` and vanished the moment the view was scoped to a turn.
  const snap = timelineOf([
    typed('u1', 'first prompt'),
    turnDuration('t1'),
    bareSlash('u2', '/code-review del diff', 'p-2'),
    forkedLaunch('s1', 'a96ede12', 'code-review', '/code-review del diff'),
  ]);

  const agent = snap.subagents.find((a) => a.agentId === 'a96ede12');
  assert.ok(agent, 'the launch puts the agent on the list');
  assert.equal(agent!.title, '/code-review del diff', 'named by what was launched, not by its type');
  assert.equal(agent!.turnIndex, snap.turnList[1]!.index, 'it belongs to the turn whose command started it');
  assert.equal(agent!.startedAt, '2026-07-14T10:00:01.000Z', 'the launch line is when it started');
});

test('golden transcript: a turn that delegates everything still has something to say', () => {
  // From the real session this was reported on: `/code-review` writes ONE line into the
  // parent transcript (its launch) and then nothing at all for as long as the review runs —
  // measured 9m53s, while its agent burnt 118.5k tokens. With liveness read off the main thread's
  // own API calls, the round presented as a CLOSED LOCAL COMMAND (kind 'local', state 'done',
  // excluded from `snapshot.turns`) and NOW had nothing to show, for the entire window seedeep
  // exists to show. Asserted from raw jsonl through the real parser, reducer and `nowLine`.
  const tree = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  let seq = 0;
  for (const l of [
    typed('u1', 'first prompt'),
    turnDuration('t1'),
    bareSlash('u2', '/code-review', 'p-2'),
    forkedLaunch('s1', 'a96ede12', 'code-review', '/code-review'),
  ]) {
    for (const e of parseLine(l, { ...ctx, seq: seq++ }) as NormalizedEvent[]) tree.apply(e);
  }
  // The sidecar Claude Code writes for the child. Not decoration: `displayState` calls a launch
  // with NO trace of its own `unknown`, not `running` — measured, a real agent's first trace lands
  // 0.07s after its launch — and the panel must not claim work the Subagents card does not see.
  tree.apply({
    type: 'subagent-meta',
    sessionId: 's1',
    root: 'cli',
    timestamp: '',
    seq: seq++,
    agentId: 'a96ede12',
    toolUseId: null,
    agentType: 'general-purpose',
    spawnDepth: 1,
    model: 'claude-opus-4-8',
  } as NormalizedEvent);
  const snap = tree.snapshot();

  const turn = snap.turnList[1]!;
  assert.equal(turn.command, 'code-review');
  assert.deepEqual(turn.agentIds, ['a96ede12'], 'the turn owns the agent its command launched');
  const delegated = delegatedWork(turn.index, snap.subagents, false, Date.parse('2026-07-14T10:05:42.000Z'));
  assert.deepEqual(
    delegated,
    { label: '/code-review', since: Date.parse('2026-07-14T10:00:01.000Z'), count: 1 },
    'and knows the work is happening there — by the same rule the Subagents card uses',
  );
  assert.equal(turn.state, 'live', 'a turn burning tokens through an agent is working, not done');
  assert.equal(turn.kind, 'work', 'and it is a round that ran the model, not a /model-style built-in');
  assert.equal(snap.turns, 2, 'so the header counts it');

  // The panel, through the rule both surfaces share.
  const now = Date.parse('2026-07-14T10:05:42.000Z');
  const state = nowLine(
    {
      waiting: null,
      pendingTool: null,
      waitingSince: null,
      live: turn.state === 'live',
      result: turn.result,
      narration: turn.lastNarration,
      wordTs: turn.lastWordTs,
      wordSeenAt: null,
      activity: turn.activity,
      delegated,
      returned: null,
      apiCalls: turn.apiCalls,
      startedAt: Date.parse(turn.startedAt!),
    },
    now,
  );
  assert.deepEqual(state, {
    kind: 'working',
    label: 'now',
    text: '/code-review is running in the background',
    ageFrom: Date.parse('2026-07-14T10:00:01.000Z'),
  });
});

// Cache accounting needs a call whose read/created are BOTH set — the `assistant` helper
// above hardcodes created=0, the one shape that cannot expose the bug below.
// `id` is the API call's message id: Claude Code writes ONE LINE PER CONTENT BLOCK, and every
// one of those lines repeats the SAME usage block (verified on real sessions: 192 assistant
// lines carrying only 110 distinct message.ids, one id spanning up to 4 lines).
const call = (uuid: string, read: number, created: number, id = 'msg_' + uuid) =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: '2026-07-14T10:00:05.000Z',
    message: {
      role: 'assistant',
      id,
      model: 'claude-opus-4-8',
      usage: {
        input_tokens: 4,
        output_tokens: 50,
        cache_read_input_tokens: read,
        cache_creation_input_tokens: created,
      },
    },
  });

test('golden transcript: one API call spread over several lines is counted ONCE', () => {
  // The real shape: an assistant turn with thinking + two tool_uses is FOUR lines, each
  // repeating the same usage. Summing per LINE inflated every cache total by ~2x (and
  // apiCalls with it); the fold must key on the API call, not on the line.
  const snap = timelineOf([
    typed('u1', 'run the tools'),
    call('a1', 80_000, 20_000, 'msg_same'), // thinking
    call('a2', 80_000, 20_000, 'msg_same'), // tool_use   — same API call
    call('a3', 80_000, 20_000, 'msg_same'), // tool_use   — same API call
    call('a4', 100_000, 5_000, 'msg_next'), // the next real call
    turnDuration('t1'),
  ]);

  assert.deepEqual(
    snap.main.cacheTotals,
    { read: 180_000, created: 25_000 },
    "the repeated lines carry one call's usage, not three calls worth",
  );
  assert.equal(snap.apiCalls, 2, 'two API calls were made, whatever the line count');
  assert.equal(snap.turnList[0]!.apiCalls, 2);
  assert.equal(snap.turnList[0]!.out, 100, 'output tokens are per call, not per line');
  // The Token usage sums fold on the same per-call key: input must not be tripled either.
  assert.equal(tokenUsage(snap.main).input, 8, 'two calls × input 4 — not six lines × 4');
  // The WEIGHT folds on that same key. Weighing per line would multiply this call by
  // its content-block count — the arithmetic here is the two calls, at Opus's ×5:
  //   (4 + 2×20_000 + 0.1×80_000 + 5×50) + (4 + 2×5_000 + 0.1×100_000 + 5×50) = 68_508
  assert.equal(snap.main.weighted, 5 * 68_508, 'the weight is per CALL, not per line');
  assert.equal(snap.turnList[0]!.weighted, snap.main.weighted, 'one turn holds the whole session weight');
  assert.equal(snap.weightedSubagents, 0, 'no subagent ran, so none is charged');
});

test('golden transcript: Token usage sums every call in the scope, by API category', () => {
  // The Token usage card totals must equal the hand-summed usage blocks — not the last call.
  // Same 4-call fixture as the cache accounting: a turn that re-created 187k of cache and
  // re-read 445k, whose LAST call (the final answer) adds almost nothing.
  const lines = [
    typed('u1', 'refactor the parser'),
    call('a1', 0, 100_000), // building the cache
    call('a2', 100_000, 60_000),
    call('a3', 160_000, 25_000),
    call('a4', 185_000, 2_203),
    turnDuration('t1'),
  ];
  const snap = timelineOf(lines);

  // input 4×4, output 50×4, cacheRead 0+100k+160k+185k, cacheWrite 100k+60k+25k+2203.
  assert.deepEqual(tokenUsage(snap.main), {
    input: 16,
    output: 200,
    cacheRead: 445_000,
    cacheWrite: 187_203,
    total: 632_419,
  });
  assert.deepEqual(snap.main.cacheTotals, { read: 445_000, created: 187_203 });

  // Scoping to the turn must report that same turn-wide truth, not the last call again.
  const scoped = scopeToTurn(snap, 1);
  assert.deepEqual(tokenUsage(scoped.main), {
    input: 16,
    output: 200,
    cacheRead: 445_000,
    cacheWrite: 187_203,
    total: 632_419,
  });

  // The Context bar is a different question — what the window is made of RIGHT NOW — and it
  // must keep reading the last call. Accumulating it would be the mirror-image bug.
  assert.deepEqual(snap.main.breakdown, { input: 4, cacheRead: 185_000, cacheCreation: 2_203 });
});

test('golden transcript: a re-sent line after a reconnect does not double-count the cache', () => {
  // Accumulation is not idempotent, and stream.ts deliberately lets the line sitting at the
  // seq high-water through again on reconnect (its guard is `seq <`). Without a per-seq
  // guard the fix above would silently double the totals of the last call.
  const tree = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  const lines = [typed('u1', 'go'), call('a1', 0, 50_000), call('a2', 50_000, 10_000)];
  let seq = 0;
  for (const l of lines) for (const e of parseLine(l, { ...ctx, seq: seq++ }) as NormalizedEvent[]) tree.apply(e);
  // the reconnect re-sends the high-water line (seq 2) verbatim
  for (const e of parseLine(lines[2]!, { ...ctx, seq: 2 }) as NormalizedEvent[]) tree.apply(e);

  const snap = tree.snapshot();
  assert.deepEqual(snap.main.cacheTotals, { read: 50_000, created: 60_000 }, 'the re-sent call is folded once');
  assert.equal(snap.apiCalls, 2, 'and it is not counted as a third API call');
});

// An assistant line that BOTH attributes to a skill (top-level attributionSkill) AND makes an
// explicit Skill tool_use — the shape that exposed the idempotency hole. cacheTotals/apiCalls
// were already guarded; the skill turn/invoke counters were not.
const skillLine = (uuid: string, skill: string, id = 'msg_' + uuid) =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: '2026-07-14T10:00:05.000Z',
    attributionSkill: skill,
    message: {
      role: 'assistant',
      id,
      model: 'claude-opus-4-8',
      usage: { input_tokens: 4, output_tokens: 50, cache_read_input_tokens: 60_000, cache_creation_input_tokens: 0 },
      content: [{ type: 'tool_use', id: 'toolu_' + uuid, name: 'Skill', input: { skill } }],
    },
  });

test('golden transcript: a re-sent skill line after a reconnect does not double-count skills', () => {
  // The reducer guards cacheTotals/apiCalls/user-turn/command against the reconnect re-send of
  // the high-water line, but the skill turn/invoke counters were missed — so a restart while a
  // skill was active inflated the Skills widget by one.
  const tree = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  const lines = [typed('u1', 'use a skill'), skillLine('a1', 'brainstorming')];
  let seq = 0;
  for (const l of lines) for (const e of parseLine(l, { ...ctx, seq: seq++ }) as NormalizedEvent[]) tree.apply(e);
  // the reconnect re-sends the high-water line (seq 1) verbatim
  for (const e of parseLine(lines[1]!, { ...ctx, seq: 1 }) as NormalizedEvent[]) tree.apply(e);

  const snap = tree.snapshot();
  assert.deepEqual(
    snap.skills.map((s) => [s.name, s.turns, s.invokes]),
    [['brainstorming', 1, 1]],
    'the re-sent line folds once: skill turns and invokes stay at 1',
  );
  assert.deepEqual(
    snap.turnList[0]!.skills.map((s) => [s.name, s.turns, s.invokes]),
    [['brainstorming', 1, 1]],
    'the turn-scoped skill counts stay at 1 too',
  );
});

test('golden transcript: a local command never goes live, even though nothing closes it', () => {
  // /model gets no turn_duration — nothing ever "ends" it. Keying `live` on the open turn
  // (instead of on tokens burnt) left it pulsing green forever.
  const snap = timelineOf([slash('u1', 'model', 'opus'), localStdout('u2')]);
  assert.equal(snap.turnList.length, 1);
  assert.equal(snap.turnList[0]!.state, 'done');
  assert.equal(snap.turnList[0]!.kind, 'local');
  assert.equal(snap.turns, 0, 'no work happened');
});

test('golden transcript: turn_duration closes the turn it belongs to, not the one before', () => {
  // With slash commands dropped, the /paste-image round's turn_duration landed on the
  // previous turn and overwrote its duration.
  const snap = timelineOf([
    typed('u1', 'first prompt'),
    assistant('a1', 40_000),
    turnDuration('t1'),
    slash('u2', 'paste-image', 'and now this'),
    assistant('a2', 70_000),
    turnDuration('t2'),
  ]);
  assert.equal(snap.turnList.length, 2);
  assert.equal(snap.turnList[0]!.durationMs, 9000);
  assert.equal(snap.turnList[1]!.durationMs, 9000, 'the second duration went to the second turn');
  assert.equal(snap.turnList[1]!.apiCalls, 1);
});

test('golden transcript: an interrupted turn stays a work turn even with tokens burnt', () => {
  const snap = timelineOf([
    typed('u1', 'do the thing'),
    assistant('a1', 30_000),
    typedAfterEsc('u2', 'no, stop — do this instead', 'u1'),
    assistant('a2', 55_000),
    turnDuration('t1'),
  ]);
  assert.equal(snap.turnList[0]!.state, 'interrupted');
  assert.equal(snap.turnList[0]!.kind, 'work');
  assert.equal(snap.turnList[0]!.result, null, 'interrupted → no answer');
  assert.equal(snap.turns, 2);
});

test('golden transcript: a typed prompt that QUOTES a command tag is still a typed prompt', () => {
  // seedeep's own sessions paste parser code and log lines into prompts, so a human prompt
  // containing the literal `<command-name>` is routine. Testing for the tag before checking
  // origin turned that prompt into a phantom command: the entry was labelled /clear, counted
  // as a command that never ran, classified as a context event — and the real text was LOST,
  // not merely truncated. `origin.kind: 'human'` is the authoritative signal and wins.
  const quoted = 'why does <command-name>/clear</command-name> not show up in the widget?';
  const snap = timelineOf([typed('u1', quoted), assistant('a1', 20_000), turnDuration('t1')]);

  assert.equal(snap.turnList.length, 1);
  assert.equal(snap.turnList[0]!.command, null, 'not a command — a human typed it');
  assert.equal(snap.turnList[0]!.kind, 'work');
  assert.equal(snap.turnList[0]!.prompt, quoted, 'the prompt survives verbatim');
  assert.deepEqual(snap.commands, [], 'no phantom /clear was ever run');
});

test('golden transcript: re-applying the high-water line after a reconnect does not fork a turn', () => {
  // stream.ts drops `seq < high-water`, NOT `<=` (one line emits several events), so the line
  // sitting exactly at the mark is re-applied once on reconnect. Opening a turn is an append:
  // without a guard it forked a duplicate entry with the same prompt, double-counted its
  // command, and steered the real turn's usage onto the copy.
  const tree = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  const apply = (line: string, seq: number) => {
    for (const e of parseLine(line, { ...ctx, seq }) as NormalizedEvent[]) tree.apply(e);
  };
  apply(slash('u1', 'paste-image', 'look at this'), 7);
  apply(slash('u1', 'paste-image', 'look at this'), 7); // the reconnect re-send of the same line
  apply(assistant('a1', 30_000), 8);

  const snap = tree.snapshot();
  assert.equal(snap.turnList.length, 1, 'one line, one entry — however many times it arrives');
  assert.equal(snap.turnList[0]!.apiCalls, 1, 'the usage landed on the real turn, not a duplicate');
  assert.deepEqual(
    snap.commands.map((c) => [c.name, c.count]),
    [['paste-image', 1]],
    'counted once',
  );
});

test('golden transcript: a command counts against the turn it OPENED, not the previous one', () => {
  // The parser emitted `command` before `user-turn`, so the reducer credited it to whatever
  // turn was still open: scoping to the /model entry showed an empty Commands widget, while
  // the unrelated turn before it claimed to have run /model.
  const snap = timelineOf([
    typed('u1', 'first prompt'),
    assistant('a1', 40_000),
    turnDuration('t1'),
    slash('u2', 'model', 'opus'),
    localStdout('u3'),
  ]);
  assert.deepEqual(snap.turnList[0]!.commands, [], 'the typed turn ran no command');
  assert.deepEqual(
    snap.turnList[1]!.commands.map((c) => [c.name, c.count]),
    [['model', 1]],
    'the /model entry carries its own command',
  );
});

test('golden transcript: the Commands widget finally sees the commands (it was always empty)', () => {
  // Slash-command lines carry no `origin`, so the old human-origin gate dropped them — which
  // is why the Commands widget never showed a single command in a real session.
  const snap = timelineOf([
    slash('u1', 'paste-image', 'a'),
    assistant('a1', 10_000),
    slash('u2', 'paste-image', 'b'),
    assistant('a2', 20_000),
    slash('u3', 'model', 'opus'),
  ]);
  assert.deepEqual(
    snap.commands.map((c) => [c.name, c.count]),
    [
      ['paste-image', 2],
      ['model', 1],
    ],
  );
});

// ---- the tool_use_id survives into the snapshot ----

// A tool call as an assistant line really carries it: a `tool_use` block whose `id` IS the
// tool_use_id. That id is the only handle a view holding an event (the live-activity ring)
// has back to the tool — if the snapshot drops it, such a view must keep its own copy of the
// tool's state, and the copies drift.
const toolUse = (uuid: string, id: string, name: string, input: unknown, ts = '2026-07-14T10:00:02.000Z') =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: ts,
    message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'tool_use', id, name, input }] },
  });
const toolResult = (uuid: string, toolUseId: string, text: string, ts = '2026-07-14T10:00:04.000Z') =>
  JSON.stringify({
    type: 'user',
    uuid,
    timestamp: ts,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] },
  });
// Mid-turn NARRATION as it really appears (verified 2026-07-20): an assistant line with a text
// block and stop_reason "tool_use" (NOT "end_turn"), carrying its own usage.
const narration = (uuid: string, text: string, ts = '2026-07-14T10:00:03.000Z') =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: ts,
    message: {
      role: 'assistant',
      model: 'claude-opus-4-8',
      stop_reason: 'tool_use',
      content: [{ type: 'text', text }],
      usage: {
        input_tokens: 5,
        output_tokens: 40,
        cache_read_input_tokens: 50_000,
        cache_creation_input_tokens: 1_000,
      },
    },
  });
// The turn's final answer: same text-block shape but stop_reason "end_turn" — the turn RESULT,
// which must never be read as a narration.
const finalAnswer = (uuid: string, text: string) =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: '2026-07-14T10:00:08.000Z',
    message: {
      role: 'assistant',
      model: 'claude-opus-4-8',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 5, output_tokens: 40, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 0 },
    },
  });

test('golden transcript: a tool node keeps its tool_use_id, and a subagent keeps its spawn id', () => {
  const tree = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  let seq = 0;
  const lines = [
    typed('u1', 'find the bug'),
    toolUse('a1', 'toolu_01', 'Read', { file_path: '/home/dev/app/main.ts' }),
    toolResult('u2', 'toolu_01', 'file contents'),
    toolUse('a2', 'toolu_02', 'Agent', { prompt: 'search the repo', subagent_type: 'general-purpose' }),
  ];
  for (const l of lines) for (const e of parseLine(l, { ...ctx, seq: seq++ }) as NormalizedEvent[]) tree.apply(e);
  // The sidecar link (agentId → toolUseId) arrives out-of-band, exactly as the watcher emits
  // it: seq -1, no timestamp. It is the ONLY thing that ties a child agent to its spawn.
  tree.apply({
    type: 'subagent-meta',
    sessionId: 's1',
    root: 'cli',
    timestamp: '',
    seq: -1,
    agentId: 'ag1',
    toolUseId: 'toolu_02',
    agentType: 'general-purpose',
    spawnDepth: 1,
    model: 'claude-sonnet-5',
  } as NormalizedEvent);

  const snap = tree.snapshot();
  assert.deepEqual(
    snap.mainTools.map((t) => [t.id, t.name]),
    [
      ['toolu_01', 'Read'],
      ['toolu_02', 'Agent'],
    ],
    'every tool node carries the id it was launched with',
  );
  assert.equal(
    snap.subagents[0]!.toolUseId,
    'toolu_02',
    'the subagent knows the spawn that created it — a spawn event can find it by that id alone',
  );
  // A still-running tool must not be given a fake duration; a finished one must have its own.
  assert.equal(snap.mainTools.find((t) => t.id === 'toolu_01')!.ms, 2000);
  assert.equal(snap.mainTools.find((t) => t.id === 'toolu_02')!.ms, null, 'the Agent spawn has not returned');
});

// The exact bug this file exists to catch: a subagent's token number was the LAST call's context
// (≈ toolUseResult.totalTokens), which undercounts a multi-call subagent by up to ~22x. VOLUME
// must sum every call, exactly as the main Token usage card does — and fold the per-block repeat.
test('golden transcript: a subagent VOLUME sums every call, fill stays the last call', () => {
  const tree = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  let seq = 0;
  const main = [
    typed('u1', 'find the bug'),
    toolUse('a2', 'toolu_02', 'Agent', { prompt: 'search the repo', subagent_type: 'general-purpose' }),
  ];
  for (const l of main) for (const e of parseLine(l, { ...ctx, seq: seq++ }) as NormalizedEvent[]) tree.apply(e);
  // The child jsonl is tailed with agentId set — that is the ONLY thing marking a line as the
  // subagent's. A real child assistant line carries message.id (the call id).
  const childCall = (uuid: string, id: string, inp: number, out: number, cr: number, cc: number) =>
    JSON.stringify({
      type: 'assistant',
      uuid,
      timestamp: '2026-07-14T10:00:06.000Z',
      message: {
        role: 'assistant',
        id,
        model: 'claude-sonnet-5',
        usage: { input_tokens: inp, output_tokens: out, cache_read_input_tokens: cr, cache_creation_input_tokens: cc },
      },
    });
  const childCtx = { sessionId: 's1', root: 'cli' as const, agentId: 'ag1' };
  const child = [
    childCall('c1', 'm1', 5, 200, 10_000, 500),
    childCall('c1b', 'm1', 5, 200, 10_000, 500), // SAME call, second content block — must fold, not double
    childCall('c2', 'm2', 5, 300, 30_000, 200),
    childCall('c3', 'm3', 5, 400, 60_000, 0), // last call → context fill = 5 + 60_000 + 0
  ];
  for (const l of child) for (const e of parseLine(l, { ...childCtx, seq: seq++ }) as NormalizedEvent[]) tree.apply(e);
  tree.apply({
    type: 'subagent-meta',
    sessionId: 's1',
    root: 'cli',
    timestamp: '',
    seq: -1,
    agentId: 'ag1',
    toolUseId: 'toolu_02',
    agentType: 'general-purpose',
    spawnDepth: 1,
    model: 'claude-sonnet-5',
  } as NormalizedEvent);

  const snap = tree.snapshot();
  const sub = snap.subagents[0]!;
  const c1 = 5 + 200 + 10_000 + 500,
    c2 = 5 + 300 + 30_000 + 200,
    c3 = 5 + 400 + 60_000 + 0;
  assert.equal(sub.volume, c1 + c2 + c3, 'VOLUME sums the 3 distinct calls, the repeated block folded');
  assert.equal(sub.volumeEstimated, false, 'per-call usage was present, so the volume is a true sum');
  assert.equal(sub.fill, 5 + 60_000 + 0, 'context fill is the LAST call, not the cumulative sum');
  assert.equal(snap.subagentsTotal, c1 + c2 + c3, 'the Token usage Subagents row is the same cumulative metric');
  assert.equal(snap.subagentsEstimated, false, 'a true per-call sum is not flagged estimated');
  // The drawer breakdown sums each category over the same deduped calls (block repeat folded).
  assert.deepEqual(
    sub.volumeBreakdown,
    {
      input: 5 + 5 + 5,
      output: 200 + 300 + 400,
      cacheRead: 10_000 + 30_000 + 60_000,
      cacheCreation: 500 + 200 + 0,
    },
    'the four categories sum per-call, and add up to VOLUME',
  );
  const bd = sub.volumeBreakdown!;
  assert.equal(bd.input + bd.output + bd.cacheRead + bd.cacheCreation, sub.volume, 'breakdown reconciles with VOLUME');
});

// Two facts the Subagents-by-model bar stands on, and neither is safe to assume.
// (1) A subagent's tokens are charged to the model of the CALL. `subagent-meta` names ONE model
// per agent, but measured on real logs 2.1% of subagent transcripts (37 of 1741) carry more than
// one family — charging the whole volume to the declared model misplaces 1.19% of subagent tokens
// overall, and 7% inside one real 130-subagent session.
// (2) Main-thread tokens are NEVER in the split: it explains the Subagents ROW, not the hero.
test('golden transcript: subagent tokens split by the model of each call, main thread excluded', () => {
  const tree = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  let seq = 0;
  const main = [
    typed('u1', 'find the bug'),
    // A main-thread call on opus — its tokens must not reach the subagent split.
    JSON.stringify({
      type: 'assistant',
      uuid: 'a1',
      timestamp: '2026-07-14T10:00:01.000Z',
      message: {
        role: 'assistant',
        id: 'main1',
        model: 'claude-opus-4-8',
        usage: {
          input_tokens: 7,
          output_tokens: 90,
          cache_read_input_tokens: 400_000,
          cache_creation_input_tokens: 300,
        },
      },
    }),
    toolUse('a2', 'toolu_02', 'Agent', {
      prompt: 'search the repo',
      subagent_type: 'general-purpose',
      model: 'sonnet',
    }),
  ];
  for (const l of main) for (const e of parseLine(l, { ...ctx, seq: seq++ }) as NormalizedEvent[]) tree.apply(e);

  const childCall = (uuid: string, id: string, model: string, inp: number, out: number, cr: number, cc: number) =>
    JSON.stringify({
      type: 'assistant',
      uuid,
      timestamp: '2026-07-14T10:00:06.000Z',
      message: {
        role: 'assistant',
        id,
        model,
        usage: { input_tokens: inp, output_tokens: out, cache_read_input_tokens: cr, cache_creation_input_tokens: cc },
      },
    });
  const childCtx = { sessionId: 's1', root: 'cli' as const, agentId: 'ag1' };
  // The awkward shape: this ONE subagent ran on two models. Its meta declares only sonnet.
  const child = [
    childCall('c1', 'm1', 'claude-sonnet-4-6', 5, 200, 10_000, 500),
    childCall('c2', 'm2', 'claude-haiku-4-5-20251001', 5, 300, 30_000, 200),
  ];
  for (const l of child) for (const e of parseLine(l, { ...childCtx, seq: seq++ }) as NormalizedEvent[]) tree.apply(e);
  tree.apply({
    type: 'subagent-meta',
    sessionId: 's1',
    root: 'cli',
    timestamp: '',
    seq: -1,
    agentId: 'ag1',
    toolUseId: 'toolu_02',
    agentType: 'general-purpose',
    spawnDepth: 1,
    model: 'claude-sonnet-4-6',
  } as NormalizedEvent);

  const snap = tree.snapshot();
  const sonnet = 5 + 200 + 10_000 + 500,
    haiku = 5 + 300 + 30_000 + 200;
  assert.deepEqual(
    snap.subagentTokensByModel,
    [
      { model: 'claude-haiku-4-5-20251001', tokens: haiku },
      { model: 'claude-sonnet-4-6', tokens: sonnet },
    ],
    'each call is charged to ITS model, not to the one subagent-meta declared, and the bigger share leads',
  );
  assert.equal(
    snap.subagentTokensByModel.reduce((n, x) => n + x.tokens, 0),
    snap.subagentsTotal,
    'the split sums to the Subagents row exactly — the bar can never disagree with the number above it',
  );
  assert.equal(
    snap.subagentTokensByModel.some((x) => x.model === 'claude-opus-4-8'),
    false,
    'the main thread ran on opus and contributed 400k tokens: none of it is in the subagent split',
  );
  assert.ok(
    snap.subagentsTotal < snap.main.cacheTotals.read + snap.subagentsTotal,
    'the subagent total is a strict part of the session hero, never the whole of it',
  );
});

// A subagent's calls are not all model-bearing: a synthetic / API-error line (rate limit,
// "No response requested.") still carries a usage block, but the parser strips its
// `<synthetic>` model to null. Those tokens must fold into the agent's OWN model, and the
// per-agent split must stay ONE entry per model — not a real-model entry plus a resolved-null
// one for the same model. (The session-level bar re-merges either way; this guards the
// per-agent structure a future subagent drawer would render.)
test('golden transcript: an API-error call folds into the agent model, no duplicate split entry', () => {
  const tree = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  let seq = 0;
  const main = [
    typed('u1', 'go'),
    toolUse('a2', 'toolu_02', 'Agent', { prompt: 'work', subagent_type: 'general-purpose', model: 'sonnet' }),
  ];
  for (const l of main) for (const e of parseLine(l, { ...ctx, seq: seq++ }) as NormalizedEvent[]) tree.apply(e);
  const childCtx = { sessionId: 's1', root: 'cli' as const, agentId: 'ag1' };
  // A real sonnet call, then a rate-limit line: model '<synthetic>' (→ null), usage present.
  const realCall = JSON.stringify({
    type: 'assistant',
    uuid: 'c1',
    timestamp: '2026-07-14T10:00:05.000Z',
    message: {
      role: 'assistant',
      id: 'm1',
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: 5, output_tokens: 200, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 },
    },
  });
  const errCall = JSON.stringify({
    type: 'assistant',
    uuid: 'c2',
    timestamp: '2026-07-14T10:00:06.000Z',
    isApiErrorMessage: true,
    apiErrorStatus: 429,
    message: {
      role: 'assistant',
      id: 'm2',
      model: '<synthetic>',
      content: [{ type: 'text', text: "You've hit your limit" }],
      usage: { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 500, cache_creation_input_tokens: 0 },
    },
  });
  for (const l of [realCall, errCall])
    for (const e of parseLine(l, { ...childCtx, seq: seq++ }) as NormalizedEvent[]) tree.apply(e);
  tree.apply({
    type: 'subagent-meta',
    sessionId: 's1',
    root: 'cli',
    timestamp: '',
    seq: seq++,
    agentId: 'ag1',
    toolUseId: 'toolu_02',
    agentType: 'general-purpose',
    spawnDepth: 1,
    model: 'claude-sonnet-4-6',
  } as NormalizedEvent);

  const snap = tree.snapshot();
  const real = 5 + 200 + 1000 + 0,
    err = 5 + 0 + 500 + 0;
  const sub = snap.subagents[0]!;
  assert.deepEqual(
    sub.volumeByModel,
    [{ model: 'claude-sonnet-4-6', tokens: real + err }],
    'both calls fold into sonnet as ONE entry — not sonnet twice (real call + resolved error call)',
  );
  assert.equal(
    sub.volumeByModel.length,
    new Set(sub.volumeByModel.map((x) => x.model)).size,
    'no duplicate model key in the per-agent split',
  );
  assert.equal(
    sub.volumeByModel.reduce((n, x) => n + x.tokens, 0),
    sub.volume,
    'the split still totals the volume',
  );
  assert.deepEqual(
    snap.subagentTokensByModel,
    [{ model: 'claude-sonnet-4-6', tokens: real + err }],
    'and the session bar shows the one merged model',
  );
});

test('golden transcript: a subagent with no per-call usage puts its estimated volume on its own model', () => {
  const tree = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  let seq = 0;
  const main = [
    typed('u1', 'run it in the background'),
    toolUse('a2', 'toolu_02', 'Agent', { prompt: 'long job', subagent_type: 'general-purpose', model: 'haiku' }),
    // A background subagent writes no child transcript; the parent reports one total on the
    // tool result, so the volume is estimated and has no per-call model of its own.
    JSON.stringify({
      type: 'user',
      uuid: 'u2',
      timestamp: '2026-07-14T10:05:00.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_02', content: 'done' }] },
      // A foreground Agent result carries totals on a `content`-array toolUseResult (parser.ts:271).
      toolUseResult: {
        content: [{ type: 'text', text: 'done' }],
        totalTokens: 12_345,
        totalDurationMs: 4000,
        status: 'completed',
      },
    }),
  ];
  for (const l of main) for (const e of parseLine(l, { ...ctx, seq: seq++ }) as NormalizedEvent[]) tree.apply(e);
  tree.apply({
    type: 'subagent-meta',
    sessionId: 's1',
    root: 'cli',
    timestamp: '',
    seq: -1,
    agentId: 'ag1',
    toolUseId: 'toolu_02',
    agentType: 'general-purpose',
    spawnDepth: 1,
    model: 'haiku',
  } as NormalizedEvent);

  const snap = tree.snapshot();
  assert.equal(snap.subagentsEstimated, true, 'no per-call usage → the total is a parent-reported estimate');
  assert.equal(
    snap.subagentTokensByModel.reduce((n, x) => n + x.tokens, 0),
    snap.subagentsTotal,
    'an estimated volume is still fully attributed — the split never loses tokens the row counts',
  );
  assert.deepEqual(
    snap.subagentTokensByModel.map((x) => x.model),
    ['haiku'],
    'with no per-call detail the whole volume lands on the model the spawn asked for',
  );
});

// ── Background subagents ────────────────────────────────────────────────────────
// The bug these exist to catch: `done` was derived from the spawn's tool_result, which for a
// BACKGROUND subagent is only a launch receipt arriving ~0.07s in. The subagent was born done
// and the live panel (which renders only state==='running') never showed it — for the whole
// several-minute life of the real work. Background is not exotic: Claude Code runs subagents
// in the background BY DEFAULT since v2.1.198 (official sub-agents.md), measured at 92% of
// launches on v2.1.208.
//
// Shapes below are taken from real lines, not imagined:
//  - the async receipt puts NO `content` array on toolUseResult, only
//    {isAsync, status:'async_launched', agentId, outputFile, canReadOutputFile, prompt, …};
//  - completion arrives much later as a SEPARATE line, `type:'queue-operation'`, whose
//    `content` is an XML-ish string with <task-id>/<tool-use-id>/<status>. It carries no uuid,
//    and the same payload appears twice (operation 'enqueue' then 'remove').

/** The launch receipt of a background subagent: returns in ~0.07s, proves nothing finished. */
const asyncLaunchReceipt = (uuid: string, toolUseId: string, agentId: string) =>
  JSON.stringify({
    type: 'user',
    uuid,
    timestamp: '2026-07-14T10:00:02.070Z',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: [{ type: 'text', text: `Async agent launched successfully.\nagentId: ${agentId}` }],
        },
      ],
    },
    toolUseResult: {
      isAsync: true,
      status: 'async_launched',
      agentId,
      description: 'Review angle: reuse',
      prompt: 'You are a code-review finder agent.',
      outputFile: `/home/dev/tasks/${agentId}.output`,
      canReadOutputFile: true,
      resolvedModel: 'claude-sonnet-5',
    },
  });
/** The real completion signal, minutes later, on its own line type. */
const taskNotification = (toolUseId: string, agentId: string, status: string, operation = 'enqueue') =>
  JSON.stringify({
    type: 'queue-operation',
    operation,
    sessionId: 's1',
    timestamp: '2026-07-14T10:04:12.000Z',
    content: `<task-notification>\n<task-id>${agentId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<output-file>/home/dev/tasks/${agentId}.output</output-file>\n<status>${status}</status>\n<summary>Agent "Review angle: reuse" finished</summary>\n`,
  });
/** A FOREGROUND result: arrives only when the work is done, and carries the real totals. */
const syncAgentResult = (uuid: string, toolUseId: string, agentId: string) =>
  JSON.stringify({
    type: 'user',
    uuid,
    timestamp: '2026-07-14T10:02:30.000Z',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'text', text: 'found it in main.ts' }] },
      ],
    },
    toolUseResult: {
      status: 'completed',
      agentId,
      totalDurationMs: 148_233,
      totalTokens: 85_511,
      content: [{ type: 'text', text: 'found it in main.ts' }],
    },
  });
const spawn = (uuid: string, id: string) =>
  toolUse(uuid, id, 'Agent', { prompt: 'review the diff', subagent_type: 'general-purpose' });
const metaLink = (agentId: string, toolUseId: string): NormalizedEvent =>
  ({
    type: 'subagent-meta',
    sessionId: 's1',
    root: 'cli',
    timestamp: '',
    seq: -1,
    agentId,
    toolUseId,
    agentType: 'general-purpose',
    spawnDepth: 1,
    model: 'claude-sonnet-5',
  }) as NormalizedEvent;

function runLines(lines: (string | NormalizedEvent)[]) {
  const tree = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  let seq = 0;
  for (const l of lines) {
    if (typeof l !== 'string') {
      tree.apply(l);
      continue;
    }
    for (const e of parseLine(l, { ...ctx, seq: seq++ }) as NormalizedEvent[]) tree.apply(e);
  }
  return tree.snapshot();
}

test('golden transcript: a background subagent stays RUNNING until its task-notification', () => {
  const before = runLines([
    typed('u1', 'review the diff'),
    spawn('a1', 'toolu_01'),
    asyncLaunchReceipt('u2', 'toolu_01', 'ag1'), // +0.07s — a receipt, NOT a completion
    metaLink('ag1', 'toolu_01'),
  ]);
  assert.equal(before.subagents.length, 1, 'the spawn alone puts the subagent on the list');
  assert.equal(
    before.subagents[0]!.state,
    'running',
    'the launch receipt says "launched", not "finished" — the subagent is still working',
  );

  const after = runLines([
    typed('u1', 'review the diff'),
    spawn('a1', 'toolu_01'),
    asyncLaunchReceipt('u2', 'toolu_01', 'ag1'),
    metaLink('ag1', 'toolu_01'),
    taskNotification('toolu_01', 'ag1', 'completed'),
  ]);
  assert.equal(after.subagents[0]!.state, 'done', 'the notification is what ends a background subagent');
});

// The 864-subagent guarantee: every foreground result in the real logs carries
// status 'completed' and NEVER gets a task-notification. If the notification became the
// terminal signal for everything, all of them would hang as running forever.
test('golden transcript: a foreground subagent still ends at its tool_result, with no notification', () => {
  const snap = runLines([
    typed('u1', 'find the bug'),
    spawn('a1', 'toolu_01'),
    syncAgentResult('u2', 'toolu_01', 'ag1'), // arrives 148s in, when the work is done
    metaLink('ag1', 'toolu_01'),
  ]);
  assert.equal(
    snap.subagents[0]!.state,
    'done',
    'a foreground result IS the completion — no notification exists for it, and none is needed',
  );
});

// A notification fires each time the agent STOPS; SendMessage can restart it on the same
// tool-use-id (50 such cases in the real logs). Latching `done` on the first one would show a
// working agent as finished.
test('golden transcript: a resumed background subagent goes back to RUNNING (done is not a latch)', () => {
  const snap = runLines([
    typed('u1', 'review the diff'),
    spawn('a1', 'toolu_01'),
    asyncLaunchReceipt('u2', 'toolu_01', 'ag1'),
    metaLink('ag1', 'toolu_01'),
    taskNotification('toolu_01', 'ag1', 'completed'),
    // SendMessage puts the same agent back to work; the next notification comes later.
    toolUse('a2', 'toolu_02', 'SendMessage', { to: 'ag1', summary: 'keep digging' }),
  ]);
  assert.equal(
    snap.subagents[0]!.state,
    'running',
    'the agent was sent more work — the earlier notification no longer describes it',
  );
});

// When the agent stops AGAIN, Claude Code keys that notification on the SendMessage call
// rather than on the spawn (measured: 26 of 655 real notifications, and 4 of 11 resumed
// background subagents were left running forever by it). The <task-id> is the child's
// agentId in both shapes, which is what makes the resumed agent findable at all.
test('golden transcript: a notification keyed on the SendMessage still ends the agent it resumed', () => {
  const snap = runLines([
    typed('u1', 'review the diff'),
    spawn('a1', 'toolu_01'),
    asyncLaunchReceipt('u2', 'toolu_01', 'ag1'),
    metaLink('ag1', 'toolu_01'),
    taskNotification('toolu_01', 'ag1', 'completed'),
    toolUse('a2', 'toolu_02', 'SendMessage', { to: 'ag1', summary: 'keep digging' }),
    // The second stop: <tool-use-id> names the RESUME, not the spawn — nothing to key on.
    taskNotification('toolu_02', 'ag1', 'completed'),
  ]);
  assert.equal(snap.subagents.length, 1, 'the resume is not a second subagent');
  assert.equal(
    snap.subagents[0]!.state,
    'done',
    'the notification names the agent by task-id — keying only on the spawn leaves it running forever',
  );
});

test('golden transcript: failed and killed are distinct terminal states, absent status is done', () => {
  const mk = (status: string) =>
    runLines([
      typed('u1', 'review the diff'),
      spawn('a1', 'toolu_01'),
      asyncLaunchReceipt('u2', 'toolu_01', 'ag1'),
      metaLink('ag1', 'toolu_01'),
      taskNotification('toolu_01', 'ag1', status),
    ]).subagents[0]!.state;
  assert.equal(mk('failed'), 'failed');
  assert.equal(mk('killed'), 'killed');
  assert.equal(mk('stopped'), 'done', 'stopped is a clean end, like completed');
});

// A background COMMAND (a Bash, not a subagent). Its receipt is not an `async_launched` status
// but a `backgroundTaskId` — the only reliable marker, since a foreground command PROMOTED to
// the background by the 120s timeout carries no `run_in_background` input at all.
const backgroundLaunchReceipt = (uuid: string, toolUseId: string, taskId: string) =>
  JSON.stringify({
    type: 'user',
    uuid,
    timestamp: '2026-07-14T10:00:02.070Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: '' }] },
    toolUseResult: {
      stdout: '',
      stderr: '',
      interrupted: false,
      isImage: false,
      noOutputExpected: false,
      backgroundTaskId: taskId,
    },
  });
// The command's fate, minutes or hours later. The `<summary>` is the ONLY place the outcome is
// stated — the receipt above returned clean, so without this line a failure looks like a
// successful call that took 70ms.
const backgroundNotification = (
  toolUseId: string,
  taskId: string,
  status: string,
  summary: string,
  operation = 'enqueue',
) =>
  JSON.stringify({
    type: 'queue-operation',
    operation,
    sessionId: 's1',
    timestamp: '2026-07-14T10:40:47.845Z',
    content: `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<output-file>/home/dev/tasks/${taskId}.output</output-file>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`,
  });
const bashLaunch = (uuid: string, id: string, description: string) =>
  toolUse(uuid, id, 'Bash', {
    command: 'bun run apps/server/src/server/main.ts',
    description,
    run_in_background: true,
  });

const FAILED_SUMMARY = 'Background command "Start seedeep server" failed with exit code 144';

test('golden transcript: a failed background command carries CC’s own words onto its Bash row', () => {
  const before = runLines([
    typed('u1', 'start the server'),
    bashLaunch('a1', 'toolu_b1', 'Start seedeep server'),
    backgroundLaunchReceipt('u2', 'toolu_b1', 'b0cm7fbxc'),
  ]);
  const launched = before.mainTools.find((t) => t.id === 'toolu_b1');
  assert.ok(launched, 'the launch alone puts the Bash row on the list');
  assert.equal(launched.error, undefined, 'the receipt is clean — nothing has failed yet');
  // The two marks every "is it still running" surface stands on, asserted HERE because this is the
  // only path that proves the reducer sets them from a real line: a hand-built node with
  // `background: true` already on it can only test the selector's arithmetic, never its premise.
  assert.equal(launched.background, true, 'the receipt is what says this Bash launched a command');
  assert.ok(launched.startedTs, 'and when — the receipt closed in ms, so the call cannot say');
  assert.deepEqual(
    runningBackground(before.mainTools).map((c: { toolUseId: string }) => c.toolUseId),
    ['toolu_b1'],
    'launched and not yet told its fate = still running',
  );

  const after = runLines([
    typed('u1', 'start the server'),
    bashLaunch('a1', 'toolu_b1', 'Start seedeep server'),
    backgroundLaunchReceipt('u2', 'toolu_b1', 'b0cm7fbxc'),
    backgroundNotification('toolu_b1', 'b0cm7fbxc', 'failed', FAILED_SUMMARY),
  ]);
  const row = after.mainTools.find((t) => t.id === 'toolu_b1');
  assert.ok(row, 'the notification must not create a second row');
  assert.equal(row.error, true, 'the notification is the only statement that this command failed');
  assert.equal(row.outcome, FAILED_SUMMARY, 'the row reports what Claude Code reported, verbatim');
  // …and it is no longer running. A failure is an outcome: the surfaces that say "still waiting on
  // something" must stop saying it, whatever the fate turned out to be.
  assert.deepEqual(runningBackground(after.mainTools), [], 'the notification is what ends it');
});

test('golden transcript: a background command that completes is not an error', () => {
  const summary = 'Background command "Build the macOS bundle" completed (exit code 0)';
  const snap = runLines([
    typed('u1', 'build it'),
    bashLaunch('a1', 'toolu_b1', 'Build the macOS bundle'),
    backgroundLaunchReceipt('u2', 'toolu_b1', 'bdfgju7ns'),
    backgroundNotification('toolu_b1', 'bdfgju7ns', 'completed', summary),
  ]);
  const row = snap.mainTools.find((t) => t.id === 'toolu_b1')!;
  assert.equal(row.error, undefined, 'a clean exit stays a clean row');
  assert.equal(row.outcome, summary, 'the outcome is still stated — it is what closed the row');
});

// `killed` is CC's word for a command it stopped ("was stopped"), and it is NOT the same event
// as a failure. Both are non-clean, so both colour the row; the words tell them apart.
test('golden transcript: a killed background command reports being stopped', () => {
  const summary = 'Background command "Relaunch the tray" was stopped';
  const snap = runLines([
    typed('u1', 'relaunch it'),
    bashLaunch('a1', 'toolu_b1', 'Relaunch the tray'),
    backgroundLaunchReceipt('u2', 'toolu_b1', 'b68j7igzh'),
    backgroundNotification('toolu_b1', 'b68j7igzh', 'killed', summary),
  ]);
  const row = snap.mainTools.find((t) => t.id === 'toolu_b1')!;
  assert.equal(row.error, true, 'stopped is not a clean end');
  assert.equal(row.outcome, summary);
});

// The catalogue the card is built on. Asserted from raw lines and not from hand-built nodes,
// because the bug it exists to prevent lives in the PARSER and the reducer: a failed command used
// to be dropped from every list by the very act of acquiring an outcome, and the two facts a row
// needs — the notification's status and the file it names — were not read at all.
test('golden transcript: the catalogue holds every background command, with its fate', () => {
  const done = 'Background command "Build the macOS bundle" completed (exit code 0)';
  const snap = runLines([
    typed('u1', 'do the three things'),
    bashLaunch('a1', 'toolu_b1', 'Start seedeep server'),
    backgroundLaunchReceipt('u2', 'toolu_b1', 'b0cm7fbxc'),
    bashLaunch('a2', 'toolu_b2', 'Build the macOS bundle'),
    backgroundLaunchReceipt('u3', 'toolu_b2', 'bdfgju7ns'),
    bashLaunch('a3', 'toolu_b3', 'Tail the transcript'),
    backgroundLaunchReceipt('u4', 'toolu_b3', 'b68j7igzh'),
    backgroundNotification('toolu_b1', 'b0cm7fbxc', 'failed', FAILED_SUMMARY),
    backgroundNotification('toolu_b2', 'bdfgju7ns', 'completed', done),
  ]);

  const live = backgroundCommands(snap.mainTools, { ended: false });
  assert.deepEqual(
    live.map((c) => [c.label, c.state]),
    [
      ['Start seedeep server', 'failed'],
      ['Build the macOS bundle', 'done'],
      ['Tail the transcript', 'running'],
    ],
    'all three, in launch order, each with what became of it — the failed one INCLUDED',
  );
  // The one the old list could still show is the only one it did show.
  assert.deepEqual(
    runningBackground(snap.mainTools).map((c) => c.toolUseId),
    ['toolu_b3'],
    'the running-only derivation is unchanged — it is this list, filtered',
  );

  const failedRow = live[0]!;
  assert.equal(failedRow.sentence, FAILED_SUMMARY, "Claude Code's words, verbatim");
  // Masked on the way through, like every other displayed path: the real one sits under the
  // scratchpad root, whose name carries the uid and the slug-encoded home.
  assert.equal(failedRow.outputFile, '~/tasks/b0cm7fbxc.output', 'the notification names the output file');
  // The launch receipt closes in ~70ms; the command ran for 40 minutes. A row reporting the
  // receipt's duration would say a ten-minute timeout took a tenth of a second.
  assert.equal(failedRow.ranMs, 40 * 60_000 + 45_845, 'the duration is launch → notification, not the receipt');
  assert.equal(live[2]!.ranMs, null, 'nothing has ended it, so it has no duration to report');
  assert.equal(live[2]!.outputFile, null, 'and no output file — only a notification names one');
});

// `running` and `unknown` are the same silence. What tells them apart is whether the session can
// still break it — the rule a subagent whose end never came already follows.
test('golden transcript: on an ended session an unreported command is unknown, not running', () => {
  const lines = [
    typed('u1', 'tail it'),
    bashLaunch('a1', 'toolu_b1', 'Tail the transcript'),
    backgroundLaunchReceipt('u2', 'toolu_b1', 'b68j7igzh'),
  ];
  const snap = runLines(lines);
  assert.equal(backgroundCommands(snap.mainTools, { ended: false })[0]!.state, 'running');
  assert.equal(backgroundCommands(snap.mainTools, { ended: true })[0]!.state, 'unknown');
});

// Claude Code can write the end BEFORE the launch (its lines are appended when a block closes).
// The parked outcome must carry everything the notification stated, not just its sentence.
test('golden transcript: an outcome written before its launch still brings status and output file', () => {
  const snap = runLines([
    typed('u1', 'start it'),
    backgroundNotification('toolu_b1', 'b0cm7fbxc', 'failed', FAILED_SUMMARY),
    bashLaunch('a1', 'toolu_b1', 'Start seedeep server'),
    backgroundLaunchReceipt('u2', 'toolu_b1', 'b0cm7fbxc'),
  ]);
  const row = backgroundCommands(snap.mainTools, { ended: false })[0]!;
  assert.equal(row.state, 'failed', 'the parked status classifies it, not the English sentence');
  assert.equal(row.outputFile, '~/tasks/b0cm7fbxc.output');
  assert.equal(row.sentence, FAILED_SUMMARY);
});

// A launch with no `description` is not a row with no name: the command itself is the fallback,
// which is exactly what Claude Code does in its own sentence.
test('golden transcript: a background launch without a description is named by its command', () => {
  const snap = runLines([
    typed('u1', 'run it'),
    toolUse('a1', 'toolu_b1', 'Bash', { command: 'bun run build:client', run_in_background: true }),
    backgroundLaunchReceipt('u2', 'toolu_b1', 'b0cm7fbxc'),
  ]);
  const row = backgroundCommands(snap.mainTools, { ended: false })[0]!;
  assert.equal(row.label, 'bun run build:client');
  assert.equal(row.command, 'bun run build:client');
});

// The routing must key on the RECEIPT, not on the notification's id shape. A `Monitor` call gets
// a `b`-prefixed notification too but never a `backgroundTaskId`, and a resumed subagent's
// notification names the SendMessage tool call — marking either row failed would be a lie about
// a tool that never ran a background command.
test('golden transcript: a notification for a tool that never launched a background leaves it alone', () => {
  const snap = runLines([
    typed('u1', 'review the diff'),
    spawn('a1', 'toolu_01'),
    asyncLaunchReceipt('u2', 'toolu_01', 'ag1'),
    metaLink('ag1', 'toolu_01'),
    taskNotification('toolu_01', 'ag1', 'completed'),
    toolUse('a2', 'toolu_02', 'SendMessage', { to: 'ag1', summary: 'keep digging' }),
    toolResult('u3', 'toolu_02', 'sent'),
    // The second stop names the RESUME call, which is a SendMessage — not a background command.
    taskNotification('toolu_02', 'ag1', 'failed'),
  ]);
  const sendMessage = snap.mainTools.find((t) => t.id === 'toolu_02')!;
  assert.equal(sendMessage.error, undefined, 'the SendMessage call itself did not fail');
  assert.equal(sendMessage.outcome, undefined, 'and it has no background outcome to report');
  assert.equal(snap.subagents[0]!.state, 'failed', 'the status still belongs to the agent it resumed');
});

// The same payload is written twice (enqueue then remove): 662 + 78 in the real logs.
// A Workflow run is NOT a subagent: it is a script that spawns its own (101 on a real
// deep-research run), into a nested dir the watcher used to skip entirely — so they were
// invisible. Decision: one aggregate row, never 101 rows. The journal is the only record of
// whether a workflow subagent is still working; nothing in its transcript says so.
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
const wfAgent = (runId: string, agentId: string, phase: 'seen' | 'started' | 'result'): NormalizedEvent =>
  ({
    type: 'workflow-agent',
    sessionId: 's1',
    root: 'cli',
    timestamp: '',
    seq: -1,
    agentId,
    runId,
    phase,
  }) as NormalizedEvent;
// Exactly what the watcher/replay emit per workflow subagent: the model rides a
// subagent-meta (read from the child's own lines), the tokens ride its usage lines.
const wfUsage = (agentId: string, model: string, tokens: number): NormalizedEvent[] => [
  {
    type: 'subagent-meta',
    sessionId: 's1',
    root: 'cli',
    timestamp: '',
    seq: -1,
    agentId,
    toolUseId: null,
    agentType: null,
    spawnDepth: null,
    model,
  } as NormalizedEvent,
  ...(parseLine(
    JSON.stringify({
      type: 'assistant',
      uuid: `x-${agentId}`,
      timestamp: '2026-07-14T10:01:00.000Z',
      message: {
        role: 'assistant',
        id: `msg-${agentId}`,
        model,
        usage: { input_tokens: tokens, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }),
    { sessionId: 's1', root: 'cli', seq: 1, agentId },
  ) as NormalizedEvent[]),
];

test('golden transcript: a Workflow run is ONE row that aggregates its subagents', () => {
  const snap = runLines([
    typed('u1', 'research this'),
    toolUse('a1', 'toolu_01', 'Workflow', { name: 'deep-research', args: 'a question' }),
    workflowLaunchReceipt('u2', 'toolu_01', 'wf_33e24169'),
    wfAgent('wf_33e24169', 'wa1', 'seen'),
    wfAgent('wf_33e24169', 'wa1', 'started'),
    wfAgent('wf_33e24169', 'wa1', 'result'),
    wfAgent('wf_33e24169', 'wa2', 'seen'),
    wfAgent('wf_33e24169', 'wa2', 'started'),
    ...wfUsage('wa1', 'claude-opus-4-8', 1000),
    ...wfUsage('wa2', 'claude-haiku-4-5-20251001', 500),
  ]);

  assert.equal(snap.subagents.length, 1, 'the run takes ONE row — its subagents are not listed');
  const row = snap.subagents[0]!;
  assert.equal(row.kind, 'workflow');
  assert.equal(row.state, 'running', 'the launch receipt does not end a workflow either');
  const wf = row.workflow!;
  assert.equal(wf.name, 'deep-research');
  assert.equal(wf.agents, 2, 'both subagents counted');
  assert.equal(wf.running, 1, 'started minus returned — wa2 has no result yet');
  assert.equal(wf.volume, 1500, 'tokens sum across the run subagents');
  assert.deepEqual(
    wf.models,
    [
      { model: 'claude-opus-4-8', agents: 1 },
      { model: 'claude-haiku-4-5-20251001', agents: 1 },
    ],
    'models are a BREAKDOWN: a run mixes them per stage, so one value would be a lie',
  );
});

test('golden transcript: the duplicated notification line does not double-count', () => {
  const snap = runLines([
    typed('u1', 'review the diff'),
    spawn('a1', 'toolu_01'),
    asyncLaunchReceipt('u2', 'toolu_01', 'ag1'),
    metaLink('ag1', 'toolu_01'),
    taskNotification('toolu_01', 'ag1', 'completed', 'enqueue'),
    taskNotification('toolu_01', 'ag1', 'completed', 'remove'),
  ]);
  assert.equal(snap.subagents.length, 1, 'one subagent, not two');
  assert.equal(snap.subagents[0]!.state, 'done');
});

// Review finding: a workflow-kind row carried `workflow: null` for the whole window between
// the launch receipt and the first scan of the run dir, and the view's workflow renderer
// dereferenced it — a TypeError that took the entire Graph render down, on EVERY launch.
// Both fields now come from one value, so the invariant cannot be broken again.
test('golden transcript: a workflow row is complete from its receipt, before the run dir exists', () => {
  const snap = runLines([
    typed('u1', 'research this'),
    toolUse('a1', 'toolu_01', 'Workflow', { name: 'deep-research' }),
    workflowLaunchReceipt('u2', 'toolu_01', 'wf_33e24169'),
    // NO workflow-agent events: the watcher has not walked the run dir yet.
  ]);
  const row = snap.subagents[0]!;
  assert.equal(row.kind, 'workflow');
  assert.ok(row.workflow, 'kind === workflow implies workflow !== null — the view may rely on it');
  assert.equal(row.workflow!.agents, 0, 'an empty fleet, not a crash');
  assert.equal(row.workflow!.running, 0);
  assert.equal(row.workflow!.lastActivityAt, null);
  assert.equal(row.state, 'running');
});

// Review finding: the run's tokens are a true per-call sum over its subagents' transcripts, but
// the row reported 0 (its own AgentAcc does not exist) AND volumeEstimated:true — so a session
// with a workflow both LOST the run's tokens from the Subagents total and stamped a false "~"
// on it.
test("golden transcript: a workflow run's tokens count in the session total, exactly", () => {
  const snap = runLines([
    typed('u1', 'research this'),
    toolUse('a1', 'toolu_01', 'Workflow', { name: 'deep-research' }),
    workflowLaunchReceipt('u2', 'toolu_01', 'wf_33e24169'),
    wfAgent('wf_33e24169', 'wa1', 'seen'),
    wfAgent('wf_33e24169', 'wa1', 'started'),
    wfAgent('wf_33e24169', 'wa2', 'seen'),
    wfAgent('wf_33e24169', 'wa2', 'started'),
    ...wfUsage('wa1', 'claude-opus-4-8', 1000),
    ...wfUsage('wa2', 'claude-haiku-4-5-20251001', 500),
  ]);
  const row = snap.subagents[0]!;
  assert.equal(row.volume, 1500, "the row carries the run's real tokens, not 0");
  assert.equal(row.volumeEstimated, false, 'a per-call sum is exact — never flag it estimated');
  assert.equal(snap.subagentsTotal, 1500, 'and the session Subagents total includes them');
  assert.equal(snap.subagentsEstimated, false, 'so no false "~" on an exact total');
  assert.deepEqual(
    row.volumeBreakdown,
    { input: 1500, output: 0, cacheRead: 0, cacheCreation: 0 },
    'not-estimated implies a breakdown is available',
  );
});

// Review finding: `members.size || started.size` could report fewer agents than are running —
// the journal records `started` before the agent's transcript file exists.
test('golden transcript: a run counted from the journal never reports more running than it has', () => {
  const snap = runLines([
    typed('u1', 'research this'),
    toolUse('a1', 'toolu_01', 'Workflow', { name: 'deep-research' }),
    workflowLaunchReceipt('u2', 'toolu_01', 'wf_33e24169'),
    // Two agents are in the journal; only ONE has written a transcript file so far.
    wfAgent('wf_33e24169', 'wa1', 'seen'),
    wfAgent('wf_33e24169', 'wa1', 'started'),
    wfAgent('wf_33e24169', 'wa2', 'started'),
  ]);
  const w = snap.subagents[0]!.workflow!;
  assert.equal(w.agents, 2, 'members ∪ started — the file-less agent still exists');
  assert.equal(w.running, 2);
  assert.ok(w.running <= w.agents, '"2 of 1 running" is not a thing (and drew a >100% bar)');
});

// ── The Task family ────────────────────────────────────────────────────────────
// Shapes verified against real sessions (2026-07-16, counted over ~/.claude/projects):
//   TaskCreate 585×  {subject, description, activeForm}   → result "Task #N created successfully: <subject>" (584/584 successes)
//   TaskUpdate 1119× {taskId, status}                     → result "Updated task #N status"
//   TaskList      7× {}                                   → NO input at all, by design
//   TaskOutput   47× {task_id, block, timeout}            → task_id IS a subagent's agentId (52/62 matched a launch receipt)
//   TaskStop     17× {task_id}
// argOf's generic "first string in the input" therefore labelled 1183 of those calls with an
// opaque id ("1", "a1aae5a4…"). These tools do not take arguments — they take REFERENCES.
const taskUpdateResult = (uuid: string, toolUseId: string) => toolResult(uuid, toolUseId, 'Updated task #1 status');

/** Feed/toast labels come from the reducer's EventContext, not from the snapshot — assert both. */
function labelsOf(lines: (string | NormalizedEvent)[]) {
  const tree = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  const live: Array<[string, string | null]> = [];
  tree.onEvent((e, c) => {
    if (e.type === 'tool-start') live.push([e.name, c.label]);
  });
  let seq = 0;
  for (const l of lines) {
    if (typeof l !== 'string') {
      tree.apply(l);
      continue;
    }
    for (const e of parseLine(l, { ...ctx, seq: seq++ }) as NormalizedEvent[]) tree.apply(e);
  }
  return { live, snap: tree.snapshot() };
}

test('golden transcript: TaskUpdate is labelled by what changed, not by the row id', () => {
  const { live, snap } = labelsOf([
    typed('u1', 'ship the parser fix'),
    toolUse('a1', 'toolu_01', 'TaskCreate', {
      subject: 'Write the red test',
      description: 'cover the Task family',
      activeForm: 'Writing the red test',
    }),
    toolResult('u2', 'toolu_01', 'Task #1 created successfully: Write the red test'),
    toolUse('a2', 'toolu_02', 'TaskUpdate', { taskId: '1', status: 'in_progress' }),
    taskUpdateResult('u3', 'toolu_02'),
  ]);
  const upd = snap.mainTools.find((t) => t.id === 'toolu_02')!;
  assert.equal(
    upd.arg,
    '#1 Write the red test → in_progress',
    'the taskId is resolved to the subject the TaskCreate result named',
  );
  assert.deepEqual(
    live.find(([n]) => n === 'TaskUpdate'),
    ['TaskUpdate', '#1 Write the red test → in_progress'],
    'the LIVE feed gets the same resolved label — resolving only in the snapshot leaves the feed showing "1"',
  );
  assert.equal(
    snap.mainTools.find((t) => t.id === 'toolu_01')!.arg,
    'Write the red test',
    'TaskCreate is labelled by its subject explicitly, not by whichever string came first',
  );
});

test('golden transcript: a TaskUpdate whose TaskCreate was never seen still says what changed', () => {
  const { snap } = labelsOf([
    typed('u1', 'continue'),
    toolUse('a1', 'toolu_01', 'TaskUpdate', { taskId: '4', status: 'completed' }),
  ]);
  assert.equal(
    snap.mainTools[0]!.arg,
    '#4 → completed',
    'an unresolvable ref degrades to the status — never to a bare "4"',
  );
});

test('golden transcript: TaskCreate is labelled by subject even when description comes first', () => {
  // 584/585 real calls put `subject` first, so the generic first-string fallback passed by
  // luck. Key order is not a contract: assert the field, not the ordering.
  const { snap } = labelsOf([
    typed('u1', 'plan it'),
    toolUse('a1', 'toolu_01', 'TaskCreate', {
      description: 'a long description that is not the label',
      subject: 'Fix the labels',
    }),
  ]);
  assert.equal(snap.mainTools[0]!.arg, 'Fix the labels');
});

test('golden transcript: TaskOutput/TaskStop name the subagent, not its hex id', () => {
  const { live, snap } = labelsOf([
    typed('u1', 'research this'),
    toolUse('a1', 'toolu_01', 'Agent', { prompt: 'read the docs', subagent_type: 'docs-researcher' }),
    asyncLaunchReceipt('u2', 'toolu_01', 'ab12cd34ef567890a'),
    toolUse('a2', 'toolu_02', 'TaskOutput', { task_id: 'ab12cd34ef567890a', block: true, timeout: 120000 }),
    toolUse('a3', 'toolu_03', 'TaskStop', { task_id: 'ab12cd34ef567890a' }),
  ]);
  assert.equal(
    snap.mainTools.find((t) => t.id === 'toolu_02')!.arg,
    'docs-researcher',
    'task_id is the agentId of the subagent the spawn already named',
  );
  assert.equal(snap.mainTools.find((t) => t.id === 'toolu_03')!.arg, 'docs-researcher');
  assert.deepEqual(
    live.find(([n]) => n === 'TaskOutput'),
    ['TaskOutput', 'docs-researcher'],
    'the live feed resolves it too',
  );
});

test('golden transcript: a TaskOutput for an unknown task keeps a short id, never a raw hex wall', () => {
  const { snap } = labelsOf([
    typed('u1', 'check it'),
    toolUse('a1', 'toolu_01', 'TaskOutput', { task_id: 'ab12cd34ef567890a', block: true, timeout: 120000 }),
  ]);
  assert.equal(snap.mainTools[0]!.arg, 'ab12cd34…', 'unresolved: a short id, not the full opaque hex');
});

test('golden transcript: TaskList has no argument, and gets no invented one', () => {
  const { live, snap } = labelsOf([
    typed('u1', 'what is left?'),
    toolUse('a1', 'toolu_01', 'TaskList', {}),
    toolResult('u2', 'toolu_01', 'No tasks found'),
  ]);
  assert.equal(snap.mainTools[0]!.arg, null, 'its input is {} — an argument here would be fiction');
  assert.deepEqual(
    live.find(([n]) => n === 'TaskList'),
    ['TaskList', null],
  );
});

// The legacy `Task` tool IS an async Agent launch (its result: "Async agent launched
// successfully. agentId: …"), but parser.ts special-cased only the name `Agent`, so the
// subagent it spawned never entered the tree.
test('golden transcript: the legacy Task tool spawns a subagent like Agent does', () => {
  const { snap } = labelsOf([
    typed('u1', 'investigate'),
    toolUse('a1', 'toolu_01', 'Task', {
      description: 'Inspect workflow node types',
      prompt: 'map the node-type system',
      subagent_type: 'general-purpose',
    }),
    asyncLaunchReceipt('u2', 'toolu_01', 'bc98fe76dc543210b'),
  ]);
  assert.equal(snap.subagents.length, 1, 'a Task launch is a subagent — it belongs on the list');
  assert.equal(snap.subagents[0]!.prompt, 'map the node-type system', 'and carries the prompt it was launched with');
  assert.equal(snap.subagents[0]!.state, 'running', 'a launch receipt is not a completion');
});

// TaskGet appears in no historical log (0 occurrences), so its shape was taken from the tool's
// schema and then CONFIRMED by calling it: the line reads {"taskId":"1"} — the TODO id, like
// TaskUpdate — NOT the `task_id` its TaskOutput/TaskStop neighbours take. Assuming the latter
// by analogy left it with no label at all: the very bug this issue is about, reintroduced.
test('golden transcript: TaskGet reads a todo id (taskId), not a background task_id', () => {
  const { snap } = labelsOf([
    typed('u1', 'what is task 2 about?'),
    toolUse('a1', 'toolu_01', 'TaskCreate', { subject: 'Ship the fix', description: 'land it' }),
    toolResult('u2', 'toolu_01', 'Task #1 created successfully: Ship the fix'),
    toolUse('a2', 'toolu_02', 'TaskGet', { taskId: '1' }),
  ]);
  assert.equal(
    snap.mainTools.find((t) => t.id === 'toolu_02')!.arg,
    '#1 Ship the fix',
    'a read of todo #1 is labelled by that todo — and has no status to state',
  );
});

// ── API calls in the live feed ───────────────────────────────────────────────────
// Each API call (message.id) becomes ONE feed row, in timeline order, before the tools it
// decided. The reducer flags the first line of a call (ctx.newCall — one call is written one
// line per content block, all repeating the usage) and hands the row the INPUT that triggered
// it: the prompt for a turn's first call, the preceding tool_result for the rest. The stream
// the feed consumes is asserted here, exactly like the tool-label feed above.
function callRowsOf(lines: (string | NormalizedEvent)[]) {
  const tree = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  const rows: Array<{ callId: string | null; label: string | null; sub: boolean }> = [];
  tree.onEvent((e, c) => {
    if (e.type === 'usage' && c.newCall) rows.push({ callId: e.callId, label: c.label, sub: e.agentId != null });
  });
  let seq = 0;
  for (const l of lines) {
    if (typeof l !== 'string') {
      tree.apply(l);
      continue;
    }
    for (const e of parseLine(l, { ...ctx, seq: seq++ }) as NormalizedEvent[]) tree.apply(e);
  }
  return rows;
}

test('golden transcript: each API call enters the feed once, labelled by the input that triggered it', () => {
  const rows = callRowsOf([
    typed('u1', 'analyze the parser'),
    call('a1', 80_000, 20_000, 'msg_1'), // thinking line of the first call
    call('a1b', 80_000, 20_000, 'msg_1'), // SAME call, another block — no second row
    toolUse('a2', 'toolu_1', 'Read', { file_path: '/home/dev/app/parser.ts' }),
    toolResult('u2', 'toolu_1', 'export const parseLine = () => {}'),
    call('a3', 90_000, 5_000, 'msg_2'), // mid-turn call: its input is that tool result
  ]);
  assert.deepEqual(
    rows,
    [
      { callId: 'msg_1', label: 'analyze the parser', sub: false },
      { callId: 'msg_2', label: 'export const parseLine = () => {}', sub: false },
    ],
    'one row per call; the first shows the prompt, the next shows the tool result that fed it',
  );
});

test('golden transcript: a subagent API call is flagged as a subagent feed row', () => {
  const childCall = (uuid: string, id: string) =>
    JSON.stringify({
      type: 'assistant',
      uuid,
      timestamp: '2026-07-14T10:00:06.000Z',
      message: {
        role: 'assistant',
        id,
        model: 'claude-sonnet-5',
        usage: { input_tokens: 5, output_tokens: 200, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 0 },
      },
    });
  const childCtx = { sessionId: 's1', root: 'cli' as const, agentId: 'ag1' };
  const tree = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  const rows: Array<{ sub: boolean; callId: string | null }> = [];
  tree.onEvent((e, c) => {
    if (e.type === 'usage' && c.newCall) rows.push({ sub: e.agentId != null, callId: e.callId });
  });
  let seq = 0;
  const feedIt = (line: string, c: typeof ctx | typeof childCtx) => {
    for (const e of parseLine(line, { ...c, seq: seq++ }) as NormalizedEvent[]) tree.apply(e);
  };
  feedIt(typed('u1', 'go'), ctx);
  feedIt(call('a1', 50_000, 0, 'm_main'), ctx);
  feedIt(childCall('c1', 'm_sub'), childCtx);
  assert.deepEqual(
    rows,
    [
      { sub: false, callId: 'm_main' },
      { sub: true, callId: 'm_sub' },
    ],
    'the subagent call carries agentId, so the feed can tag it SUBAGENT',
  );
});

test('golden transcript: an API-call row carries its latency (input-ready → response)', () => {
  const callAt = (ts: string, id: string) =>
    JSON.stringify({
      type: 'assistant',
      uuid: id,
      timestamp: ts,
      message: {
        role: 'assistant',
        id,
        model: 'claude-opus-4-8',
        usage: { input_tokens: 4, output_tokens: 50, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
      },
    });
  const promptAt = (ts: string) =>
    JSON.stringify({
      type: 'user',
      uuid: 'u',
      timestamp: ts,
      origin: { kind: 'human' },
      promptSource: 'typed',
      message: { role: 'user', content: 'go' },
    });
  const resultAt = (ts: string, toolUseId: string) =>
    JSON.stringify({
      type: 'user',
      uuid: 'r',
      timestamp: ts,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'done' }] },
    });
  const tree = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  const durs: Array<number | null | undefined> = [];
  tree.onEvent((e, c) => {
    if (e.type === 'usage' && c.newCall) durs.push(c.callMs);
  });
  let seq = 0;
  const feed = (l: string) => {
    for (const e of parseLine(l, { ...ctx, seq: seq++ }) as NormalizedEvent[]) tree.apply(e);
  };
  feed(promptAt('2026-07-14T10:00:00.000Z'));
  feed(callAt('2026-07-14T10:00:03.000Z', 'msg_1')); // 3s after the prompt
  feed(toolUse('a2', 'toolu_1', 'Read', { file_path: '/home/dev/x.ts' })); // a tool-start does not anchor
  feed(resultAt('2026-07-14T10:00:05.000Z', 'toolu_1')); // the tool FINISHED at :05
  feed(callAt('2026-07-14T10:00:08.000Z', 'msg_2')); // 3s after that result
  assert.deepEqual(
    durs,
    [3000, 3000],
    'first call measures from the prompt, a later call from the tool result that fed it',
  );
});

test('golden transcript: a call with no measurable anchor reports null latency, not a bogus number', () => {
  // A subagent's very first call has no preceding tool-end in its own stream → no anchor.
  const childCall = JSON.stringify({
    type: 'assistant',
    uuid: 'c',
    timestamp: '2026-07-14T10:00:06.000Z',
    message: {
      role: 'assistant',
      id: 'm_sub',
      model: 'claude-sonnet-5',
      usage: { input_tokens: 5, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  });
  const tree = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  let dur: number | null | undefined = 'unset' as unknown as number;
  tree.onEvent((e, c) => {
    if (e.type === 'usage' && c.newCall) dur = c.callMs;
  });
  for (const e of parseLine(childCall, { sessionId: 's1', root: 'cli', seq: 0, agentId: 'ag1' }) as NormalizedEvent[])
    tree.apply(e);
  assert.equal(dur, null, 'no anchor → null, never a bogus 0 or a huge number');
});

test('golden transcript: a background subagent first call shows launch prompt and spawn-to-response latency', () => {
  // When an async_launched receipt arrives the reducer seeds lastInputHint + lastActivityMs
  // for the child's agentId, so its first API call shows the launch prompt (not —) and a
  // real latency measured from the spawn start (not null).
  const agentId = 'ag2';
  const toolUseId = 'toolu_bg';
  const childCtx = { sessionId: 's1', root: 'cli' as const, agentId };
  const childCall = JSON.stringify({
    type: 'assistant',
    uuid: 'c1',
    timestamp: '2026-07-14T10:00:05.000Z', // 3s after spawn at :02
    message: {
      role: 'assistant',
      id: 'm_bg',
      model: 'claude-sonnet-5',
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  });
  const tree = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  let gotLabel: string | null | undefined;
  let gotCallMs: number | null | undefined;
  tree.onEvent((e, c) => {
    if (e.type === 'usage' && c.newCall && e.agentId === agentId) {
      gotLabel = c.label;
      gotCallMs = c.callMs;
    }
  });
  let seq = 0;
  const feedMain = (l: string) => {
    for (const e of parseLine(l, { ...ctx, seq: seq++ }) as NormalizedEvent[]) tree.apply(e);
  };
  const feedChild = (l: string) => {
    for (const e of parseLine(l, { ...childCtx, seq: seq++ }) as NormalizedEvent[]) tree.apply(e);
  };
  feedMain(typed('u1', 'go'));
  // spawn at T=:02.000 — toolUse fixture timestamp
  feedMain(
    toolUse('a1', toolUseId, 'Agent', { prompt: 'analyze the codebase for bugs', subagent_type: 'general-purpose' }),
  );
  feedMain(asyncLaunchReceipt('u2', toolUseId, agentId)); // receipt at :02.070 — seeds the maps
  feedChild(childCall); // first child call at :05 — 3s after spawn
  assert.equal(gotLabel, 'analyze the codebase for bugs', 'launch prompt becomes the label for the first call');
  assert.equal(gotCallMs, 3000, 'latency is spawn-start (:02) to first response (:05)');
});

test('golden transcript: a call whose response predates its anchor reports null, not a negative latency', () => {
  const at = (ts: string, id: string) =>
    JSON.stringify({
      type: 'assistant',
      uuid: id,
      timestamp: ts,
      message: {
        role: 'assistant',
        id,
        model: 'claude-opus-4-8',
        usage: { input_tokens: 4, output_tokens: 50, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
      },
    });
  const promptAt = (ts: string) =>
    JSON.stringify({
      type: 'user',
      uuid: 'u',
      timestamp: ts,
      origin: { kind: 'human' },
      promptSource: 'typed',
      message: { role: 'user', content: 'go' },
    });
  const tree = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  let dur: number | null | undefined = 'unset' as unknown as number;
  tree.onEvent((e, c) => {
    if (e.type === 'usage' && c.newCall) dur = c.callMs;
  });
  let seq = 0;
  const feed = (l: string) => {
    for (const e of parseLine(l, { ...ctx, seq: seq++ }) as NormalizedEvent[]) tree.apply(e);
  };
  feed(promptAt('2026-07-14T10:00:05.000Z')); // anchor at :05
  feed(at('2026-07-14T10:00:02.000Z', 'msg_1')); // response timestamped BEFORE the anchor
  assert.equal(dur, null, 'now < anchor → null, never a negative duration');
});

// ---- Mid-turn end_turn replies (trace grouping: reply vs done) -----------------
// A turn can contain MORE than one end_turn assistant line: the model closes its
// turn and is re-woken without a new user prompt (e.g. a background task
// notification). Shape verified against parser.ts:205 — an end_turn line carries
// `stop_reason: 'end_turn'` and text content.

const assistantDone = (uuid: string, text: string) =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: '2026-07-14T10:00:06.000Z',
    message: {
      role: 'assistant',
      model: 'claude-opus-4-8',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 10, output_tokens: 50, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
    },
  });

test('golden: two end_turn replies yield two result spans; grouping marks the first as reply', () => {
  const tree = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  const store = createSpanStore();
  tree.onEvent((e, c) => store.apply(e, c));
  let seq = 0;
  for (const l of [
    typed('u1', 'do the thing'),
    assistant('a1', 50_000),
    assistantDone('a2', 'first answer'), // model closes...
    assistant('a3', 60_000), // ...re-woken (e.g. background notification)
    assistantDone('a4', 'the real end'),
    turnDuration('t1'),
  ])
    for (const e of parseLine(l, { ...ctx, seq: seq++ }) as NormalizedEvent[]) {
      tree.apply(e);
    }

  const turn = store.snapshot().turns[0]!;
  const results = turn.spans.filter((s) => s.lane === 0 && s.type === 'result');
  assert.equal(results.length, 2, 'each end_turn text line becomes one result span');

  const items = groupTurnSpans(turn.spans.filter((s) => s.lane === 0));
  const resultItems = items.filter((i) => i.kind === 'step' && (i as any).span.type === 'result') as any[];
  assert.equal(resultItems[0].midResult, true, 'the mid-turn reply is marked');
  assert.equal(resultItems[1].midResult, undefined, 'the final result is not');
});

// `effort` is written by Claude Code from 2.1.212, at the ROOT of the assistant line — not
// inside `message`, where the other per-call facts (model, usage) live. It is per CALL, so a
// subagent's own child lines carry their own; the subagent drawer reports what its calls
// really said, and says nothing when they said nothing (haiku, or a pre-2.1.212 transcript).
test('golden: a subagent reports the efforts its own calls carried, and none when they carry none', () => {
  const spawn = (uuid: string, toolUseId: string) =>
    JSON.stringify({
      type: 'assistant',
      uuid,
      timestamp: '2026-07-14T10:00:02.000Z',
      message: {
        role: 'assistant',
        id: 'msg_spawn',
        model: 'claude-opus-4-8',
        usage: { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
        content: [
          {
            type: 'tool_use',
            id: toolUseId,
            name: 'Agent',
            input: { prompt: 'read the parser', subagent_type: 'general-purpose', description: 'Read the parser' },
          },
        ],
      },
    });
  // A child's own call line, with and without the field.
  const childCall = (id: string, effort: string | null) => {
    const line: Record<string, unknown> = {
      type: 'assistant',
      uuid: 'c-' + id,
      timestamp: '2026-07-14T10:00:06.000Z',
      version: '2.1.214',
      message: {
        role: 'assistant',
        id,
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 3, output_tokens: 40, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 },
      },
    };
    if (effort !== null) line.effort = effort;
    return JSON.stringify(line);
  };

  const tree = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  let seq = 0;
  const apply = (line: string, agentId: string | null) => {
    for (const e of parseLine(line, { ...ctx, agentId, seq: seq++ }) as NormalizedEvent[]) tree.apply(e);
  };
  apply(typed('u1', 'read it'), null);
  apply(spawn('a1', 'toolu_AG'), null);
  tree.apply({
    type: 'subagent-meta',
    sessionId: 's1',
    root: 'cli',
    seq: -1,
    agentId: 'child_1',
    toolUseId: 'toolu_AG',
    agentType: 'general-purpose',
    spawnDepth: 1,
    model: 'claude-sonnet-4-6',
  } as NormalizedEvent);
  apply(childCall('msg_c1', 'high'), 'child_1');
  apply(childCall('msg_c2', 'high'), 'child_1'); // same value twice → still one entry

  const sub = tree.snapshot().subagents.find((s) => s.agentId === 'child_1');
  assert.deepEqual(sub?.efforts, ['high'], 'distinct values, not one per call');

  // A second subagent whose calls carry nothing reports nothing — never a default.
  apply(spawn('a2', 'toolu_AG2'), null);
  tree.apply({
    type: 'subagent-meta',
    sessionId: 's1',
    root: 'cli',
    seq: -1,
    agentId: 'child_2',
    toolUseId: 'toolu_AG2',
    agentType: 'general-purpose',
    spawnDepth: 1,
    model: 'claude-haiku-4-5',
  } as NormalizedEvent);
  apply(childCall('msg_c3', null), 'child_2');
  assert.deepEqual(tree.snapshot().subagents.find((s) => s.agentId === 'child_2')?.efforts, []);
});

// ── Tool & API failures ─────────────────────────────────────────────────────────
// Every shape below is REAL, measured over 3269 session files: is_error lives INSIDE the
// tool_result block; a refusal carries the same flag but is CC-authored text (or a
// toolDenialKind); an API error is an assistant line flagged isApiErrorMessage. Built from
// raw lines through the real parser + reducer + span-store — the only test that could catch
// the parser silently dropping the flag.

/** A failed tool_result: is_error true, an ordinary failure body (no refusal marker). */
const toolResultError = (uuid: string, toolUseId: string, text: string, denialKind?: string) =>
  JSON.stringify({
    type: 'user',
    uuid,
    timestamp: '2026-07-14T10:00:04.000Z',
    ...(denialKind ? { toolDenialKind: denialKind } : {}),
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: true, content: text }],
    },
  });
/** An API-error line as CC writes it: assistant, isApiErrorMessage, synthetic model, a usage block. */
const apiErrorLine = (uuid: string, status: number | null, text: string) =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: '2026-07-14T10:00:05.000Z',
    isApiErrorMessage: true,
    ...(status !== null ? { apiErrorStatus: status } : {}),
    message: {
      role: 'assistant',
      id: 'msg_' + uuid,
      model: '<synthetic>',
      stop_reason: 'stop_sequence',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 4, output_tokens: 0, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
    },
  });

test('golden: a failed tool is flagged, a user refusal is NOT', () => {
  const tree = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  const store = createSpanStore();
  tree.onEvent((e, c) => store.apply(e, c));
  let seq = 0;
  for (const l of [
    typed('u1', 'edit the files'),
    toolUse('a1', 'toolu_ok', 'Read', { file_path: '/home/dev/app/main.ts' }),
    toolResult('u2', 'toolu_ok', 'file contents'),
    toolUse('a2', 'toolu_fail', 'Edit', { file_path: '/home/dev/app/x.ts' }),
    toolResultError(
      'u3',
      'toolu_fail',
      '<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>',
    ),
    toolUse('a3', 'toolu_deny', 'Bash', { command: 'rm -rf build' }),
    toolResultError(
      'u4',
      'toolu_deny',
      "The user doesn't want to proceed with this tool use. The tool use was rejected.",
    ),
  ])
    for (const e of parseLine(l, { ...ctx, seq: seq++ }) as NormalizedEvent[]) tree.apply(e);

  const snap = tree.snapshot();
  const byId = new Map(snap.mainTools.map((t) => [t.id, t]));
  assert.equal(byId.get('toolu_ok')!.error, undefined, 'a successful tool carries no error flag');
  assert.equal(byId.get('toolu_fail')!.error, true, 'the real failure is flagged');
  assert.equal(byId.get('toolu_deny')!.error, undefined, 'a user refusal is not a failure — never flagged');

  // The Trace span colours only the real failure.
  const spans = store.snapshot().turns[0]!.spans.filter((s) => s.type === 'tool');
  const statusOf = (_label: string, id: string) => spans.find((s) => (s.handle as any)?.toolUseId === id)?.status;
  assert.equal(statusOf('fail', 'toolu_fail'), 'error', 'the failed tool span is error');
  assert.equal(statusOf('deny', 'toolu_deny'), 'ok', 'the refused tool span stays ok');
  assert.equal(statusOf('ok', 'toolu_ok'), 'ok');
});

test('golden: toolDenialKind marks a refusal even with a non-refusal body', () => {
  // A permission-rule denial whose body is nothing like the canonical refusal text: only the
  // field says it is a denial, and that must be enough (the field is the authoritative signal).
  const tree = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  let seq = 0;
  for (const l of [
    typed('u1', 'run it'),
    toolUse('a1', 'toolu_p', 'Bash', { command: 'curl example.com' }),
    toolResultError('u2', 'toolu_p', 'blocked by an allow-list rule', 'permission-rule'),
  ])
    for (const e of parseLine(l, { ...ctx, seq: seq++ }) as NormalizedEvent[]) tree.apply(e);
  assert.equal(tree.snapshot().mainTools[0]!.error, undefined, 'toolDenialKind overrides the body — not a failure');
});

test('golden: a failure inside a subagent is flagged on the subagent lane', () => {
  // 56% of real tool failures happen inside a subagent — a main-thread-only badge misses them.
  const tree = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  const store = createSpanStore();
  tree.onEvent((e, c) => store.apply(e, c));
  let seq = 0;
  const apply = (line: string, agentId: string | null) => {
    for (const e of parseLine(line, { ...ctx, agentId, seq: seq++ }) as NormalizedEvent[]) tree.apply(e);
  };
  apply(typed('u1', 'search'), null);
  apply(toolUse('a1', 'toolu_AG', 'Agent', { prompt: 'search', subagent_type: 'general-purpose' }), null);
  tree.apply({
    type: 'subagent-meta',
    sessionId: 's1',
    root: 'cli',
    timestamp: '',
    seq: -1,
    agentId: 'ag1',
    toolUseId: 'toolu_AG',
    agentType: 'general-purpose',
    spawnDepth: 1,
    model: 'claude-sonnet-5',
  } as NormalizedEvent);
  apply(toolUse('c1', 'toolu_child', 'Read', { file_path: '/home/dev/missing.ts' }), 'ag1');
  apply(toolResultError('c2', 'toolu_child', 'File does not exist.'), 'ag1');

  const sub = tree.snapshot().subagents.find((s) => s.agentId === 'ag1')!;
  assert.equal(sub.tools.find((t) => t.id === 'toolu_child')!.error, true, 'the child tool is flagged');
  // A subagent's spans live under the spawn's lanes, not on the turn's main-thread list.
  const laneSpans = store.snapshot().turns[0]!.spawns.flatMap((sp) => sp.lanes.flatMap((l) => l.spans));
  const childSpan = laneSpans.find((s) => (s.handle as any)?.toolUseId === 'toolu_child');
  assert.equal(childSpan!.status, 'error', 'the subagent lane span is error');
});

test('golden: an API error line becomes a usage event carrying the error, and a red call span', () => {
  const tree = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  const store = createSpanStore();
  const usages: NormalizedEvent[] = [];
  tree.onEvent((e, c) => {
    store.apply(e, c);
    if (e.type === 'usage') usages.push(e);
  });
  let seq = 0;
  for (const l of [
    typed('u1', 'go'),
    apiErrorLine('a1', 429, "You've hit your session limit · resets 2:50am"),
    turnDuration('t1'),
  ])
    for (const e of parseLine(l, { ...ctx, seq: seq++ }) as NormalizedEvent[]) tree.apply(e);

  const errUsage = usages.find((e) => e.type === 'usage' && e.apiError) as
    | (NormalizedEvent & { type: 'usage' })
    | undefined;
  assert.ok(errUsage, 'the flagged line still flows as a usage event');
  assert.equal(errUsage!.apiError!.status, '429');
  assert.match(errUsage!.apiError!.message, /session limit/);
  const apiSpan = store.snapshot().turns[0]!.spans.find((s) => s.type === 'api');
  assert.equal(apiSpan!.status, 'error', 'the failed call span is red');
});

// A statusless API error (22 of 63 real ones: "Not logged in", "Prompt is too long") is the
// one a user most needs — keyed on the flag, never on apiErrorStatus.
test('golden: an API error with no status is still flagged, from apiError or the flag alone', () => {
  const events = parseLine(apiErrorLine('a1', null, 'Prompt is too long'), { ...ctx, seq: 0 }) as NormalizedEvent[];
  const u = events.find((e) => e.type === 'usage') as NormalizedEvent & { type: 'usage' };
  assert.equal(u.apiError!.status, null, 'no status, but still an error');
  assert.match(u.apiError!.message, /too long/);
});

// ---- From raw lines: the window follows the model the CALLS report ----

// Same shape as `assistant` above, with the model as a parameter — the field that decides
// the context window's denominator (opus 1M vs sonnet 200k).
const assistantOn = (uuid: string, model: string, fill: number) =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: '2026-07-14T10:00:05.000Z',
    message: {
      role: 'assistant',
      model,
      id: 'msg_' + uuid,
      usage: {
        input_tokens: 10,
        output_tokens: 50,
        cache_read_input_tokens: fill - 10,
        cache_creation_input_tokens: 0,
      },
    },
  });

/** Same pipeline as timelineOf, but seeded like discovery would seed a given session. */
function snapshotSeeded(seed: string | null, lines: string[]) {
  const tree = createSessionTree({ windowFor, mainModel: seed });
  let seq = 0;
  for (const l of lines) {
    for (const e of parseLine(l, { ...ctx, seq: seq++ }) as NormalizedEvent[]) tree.apply(e);
  }
  return tree.snapshot();
}

// Right after /clear the file has no assistant line yet, so discovery can only
// report model=null and the window falls back to 200k. The first real call must fix it —
// reloading the page was the only thing that did, because the seed was read once.
test('golden transcript: a session that starts with no known model corrects its window on the first call', () => {
  const before = snapshotSeeded(null, [typed('u1', 'add pagination to the results list')]);
  assert.equal(before.main.window, 200_000, 'no call yet: the fallback window, flagged estimated');
  assert.equal(before.main.estimated, true);

  const after = snapshotSeeded(null, [
    typed('u1', 'add pagination to the results list'),
    assistantOn('a1', 'claude-opus-4-8', 50_000),
  ]);
  assert.equal(after.main.model, 'claude-opus-4-8');
  assert.equal(after.main.window, 1_000_000);
  assert.equal(after.main.estimated, false);
});

// /model mid-session, exactly as one real session in 1197 does it. The same 188k
// reads as 19% of an opus window and 94% of a sonnet one — the fill was never the lie.
test('golden transcript: a mid-session model change moves the window, and the session remembers both', () => {
  const s = snapshotSeeded('claude-opus-4-8', [
    typed('u1', 'add pagination to the results list'),
    assistantOn('a1', 'claude-opus-4-8', 120_000),
    turnDuration('t1'),
    slash('u2', 'model', 'sonnet'),
    localStdout('u3'),
    typed('u4', 'now fix the failing snapshot test'),
    assistantOn('a2', 'claude-sonnet-4-6', 188_000),
  ]);
  assert.equal(s.main.model, 'claude-sonnet-4-6', 'the model in force now');
  assert.equal(s.main.window, 200_000);
  assert.equal(s.main.pct, 94, 'the same fill that read 19% against the opus window');
  assert.deepEqual(s.main.models, ['claude-opus-4-8', 'claude-sonnet-4-6']);

  // Each turn keeps the model ITS calls ran on, so scoping to the first turn still says opus.
  const first = s.turnList.find((t) => t.prompt.includes('pagination'));
  assert.deepEqual(first?.models, ['claude-opus-4-8']);
  const last = s.turnList.find((t) => t.prompt.includes('snapshot'));
  assert.deepEqual(last?.models, ['claude-sonnet-4-6']);
});

// ---- the live intent panel reads mid-turn narration + mechanical flags ----

test('golden transcript: the latest mid-turn narration is the current intent; the end_turn answer is not', () => {
  const snap = timelineOf([
    typed('u1', 'fix the frozen toast rail'),
    narration('a1', 'Reproducing the bug: I replay the session and watch the toast rail.'),
    toolUse('a2', 'toolu_1', 'Bash', { command: "pkill -f 'src/main.ts'" }),
    toolResult('u2', 'toolu_1', 'ok'),
    narration('a3', 'The freeze only happens with the tab backgrounded: rAF is suspended.'),
    finalAnswer('a4', 'Done — fix applied and the regression test passes.'),
  ]);
  const live = snap.turnList[snap.turnList.length - 1]!;
  // V1 keeps only the CURRENT intent: the latest mid-turn narration wins.
  assert.equal(
    live.lastNarration?.text,
    'The freeze only happens with the tab backgrounded: rAF is suspended.',
    'the latest mid-turn narration is the intent',
  );
  // The end_turn text is the turn RESULT, never a narration — the whole point of the stop_reason gate.
  assert.equal(live.result, 'Done — fix applied and the regression test passes.');
  assert.notEqual(live.lastNarration?.text, live.result, 'the final answer is not the narration');
});

test('golden transcript: a subagent narrates without polluting the main turn panel', () => {
  const tree = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  let seq = 0;
  const feed = (l: string, agentId: string | null) => {
    for (const e of parseLine(l, { ...ctx, agentId, seq: seq++ }) as NormalizedEvent[]) tree.apply(e);
  };
  feed(typed('u1', 'delegate the search'), null);
  feed(narration('a1', 'Main session: I dispatch a finder and wait.'), null);
  // A child-file line carries the subagent's agentId — its narration must not reach the main turn.
  feed(narration('c1', 'Subagent: scanning the repo line by line.'), 'ag1');
  const snap = tree.snapshot();
  const main = snap.turnList[snap.turnList.length - 1]!;
  assert.equal(
    main.lastNarration?.text,
    'Main session: I dispatch a finder and wait.',
    'only the main session narration reaches the main turn',
  );
});

// Verdict: driven from RAW jsonl through the real parser+reducer, then computeVerdict —
// so it can falsify "the reducer doesn't populate the fields the detectors read".

test('golden verdict: a turn ending with the context ≥70% full → warn context, from raw jsonl', () => {
  // `assistant` reports claude-opus-4-8, a 1M window in the table, so 800k of context is 80%.
  // Driven from raw lines because the detector reads `models` + `fillEnd`, both reducer-derived:
  // a hand-built TurnNode cannot falsify "the reducer names the model the calls reported".
  const snap = timelineOf([typed('u1', 'keep going'), assistant('a1', 800_000), turnDuration('d1')]);
  const v = computeVerdict(snap.turnList.at(-1)!, snap);
  assert.equal(v.severity, 'warn');
  assert.equal(v.findings[0]!.kind, 'context');
  assert.match(v.findings[0]!.text, /context 80% full/);
});

test('golden verdict: an api-error opener does not turn the session BOOT into a cold resume', () => {
  // The bug: `apiCalls++` ran on every usage line, including an all-zero `<synthetic>` one, so a
  // single api-error line before the very first real call consumed the session's first-call slot.
  // The boot's own rebuild then looked like a cold resume — 175k charged to the user on turn one.
  // Driven from raw jsonl because the fact lives in the reducer, not in any node the verdict sees.
  const withOpener = timelineOf([
    typed('u1', 'go'),
    synthetic('a0', 'API error'),
    call('a1', 5_000, 175_000),
    turnDuration('d1'),
  ]);
  const clean = timelineOf([typed('u1', 'go'), call('a1', 5_000, 175_000), turnDuration('d1')]);
  for (const [name, snap] of [
    ['clean', clean],
    ['with an api-error opener', withOpener],
  ] as const) {
    const t = snap.turnList.at(-1)!;
    assert.equal(t.rebuildExpected, true, `${name}: a boot rebuild is expected by design`);
    assert.equal(computeVerdict(t, snap).severity, 'good', name);
  }
  // …and the all-zero line is still COUNTED as an API call: it is one.
  assert.equal(withOpener.turnList.at(-1)!.apiCalls, clean.turnList.at(-1)!.apiCalls + 1);
});

test('golden verdict: a LONE interruption is not a finding, from raw jsonl', () => {
  // The regression this locks: Esc used to be scored as waste, while the guide prescribes it
  // ("course-correct early and often"). Measured, 127 of 176 real interrupted turns are lone.
  const snap = timelineOf([
    typed('u1', 'do the thing'),
    assistant('a1', 5000),
    typedAfterEsc('u2', 'stop, do this instead', 'a1'),
    assistant('a2', 5100),
    turnDuration('d2'),
  ]);
  const escTurn = snap.turnList.find((t) => t.state === 'interrupted')!;
  assert.equal(computeVerdict(escTurn, snap).severity, 'good');
});

test('golden verdict: two interruptions in a row → warn esc on the SECOND, from raw jsonl', () => {
  const snap = timelineOf([
    typed('u1', 'do the thing'),
    assistant('a1', 5000),
    typedAfterEsc('u2', 'no, like this', 'a1'),
    assistant('a2', 5100),
    typedAfterEsc('u3', 'still wrong, stop', 'a2'),
    assistant('a3', 5200),
    turnDuration('d3'),
  ]);
  const esc = snap.turnList.filter((t) => t.state === 'interrupted');
  assert.equal(esc.length, 2, 'the reducer marks both turns interrupted');
  assert.equal(computeVerdict(esc[0]!, snap).severity, 'good', 'the first is a lone Esc when it closes');
  const second = computeVerdict(esc[1]!, snap);
  assert.equal(second.severity, 'warn');
  assert.equal(second.findings[0]!.kind, 'esc');
});

test('golden verdict: an ordinary turn → good (no false positives)', () => {
  const snap = timelineOf([typed('u1', 'small task'), assistant('a1', 3000), turnDuration('d1')]);
  assert.equal(computeVerdict(snap.turnList.at(-1)!, snap).severity, 'good');
});

// ---- file-history-delta → the "Changed files" widget data ----

test('golden transcript: file-history-delta lines become filesChanged, deduped by path, no count', () => {
  // The bug this guards: file-history-delta is a line type the parser did not read, so the
  // widget would show nothing. cart.ts changes twice (deduped to one row, no count — CC writes one
  // delta per file so a count is meaningless), orders.ts once; the baseline snapshot must be ignored.
  const snap = timelineOf([
    typed('u1', 'edit checkout'),
    assistant('a1', 5000),
    fileSnapshot('snap1'), // baseline — must be ignored
    fileDelta('d1', 'src/checkout/cart.ts', '2026-07-14T10:00:06.000Z'),
    fileDelta('d2', 'src/api/orders.ts', '2026-07-14T10:00:07.000Z'),
    fileDelta('d3', 'src/checkout/cart.ts', '2026-07-14T10:00:08.000Z'), // cart changed again (latest)
    turnDuration('t1'),
  ]);
  assert.equal(snap.filesChanged.length, 3, 'three change events, snapshot contributes none');
  const files = changedFiles(snap.filesChanged);
  // deduped to two files, most-recently-changed first: cart.ts (last at :08) before orders.ts (:07)
  assert.deepEqual(
    files.map((f) => f.path),
    ['src/checkout/cart.ts', 'src/api/orders.ts'],
  );
  assert.deepEqual(
    files.map((f) => [f.dir, f.base]),
    [
      ['src/checkout/', 'cart.ts'],
      ['src/api/', 'orders.ts'],
    ],
  );
  assert.equal((files[0] as unknown as Record<string, unknown>).count, undefined, 'no change-count is exposed');
});

test('golden transcript: a scratchpad delta is classified apart, in both real path shapes', () => {
  // The defect this guards: measured on local logs, 250 of 1015 real file-history deltas (24.6%)
  // point at Claude Code's per-session scratchpad, and the widget counted them as project work.
  // BOTH observed shapes must classify: macOS resolves the dir as /private/tmp/claude-<uid>, but
  // 1358 local occurrences name the same dir without the /private prefix.
  const scratch = '/private/tmp/claude-501/-home-dev-demo/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/scratchpad/proto.ts';
  const scratchShort = '/tmp/claude-501/-home-dev-demo/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/scratchpad/probe.mjs';
  const snap = timelineOf([
    typed('u1', 'prototype the bar'),
    assistant('a1', 5000),
    fileDelta('d1', 'src/widget.ts', '2026-07-14T10:00:06.000Z'),
    fileDelta('d2', scratch, '2026-07-14T10:00:07.000Z'),
    fileDelta('d3', scratchShort, '2026-07-14T10:00:08.000Z'),
    turnDuration('t1'),
  ]);
  const files = changedFiles(snap.filesChanged);
  assert.deepEqual(
    files.filter((f) => !f.scratch).map((f) => f.path),
    ['src/widget.ts'],
    'only the repo file counts as project work',
  );
  assert.equal(files.filter((f) => f.scratch).length, 2, 'both scratchpad shapes are classified');
  for (const f of files.filter((f) => f.scratch)) {
    assert.ok(f.path.startsWith('~scratch'), `scratchpad root anonymized, got ${f.path}`);
    assert.ok(!/claude-\d+/.test(f.path), `no claude-<uid> left in ${f.path}`);
  }
});

test('golden transcript: filesChanged is attributed to the turn it happened in (scopeToTurn)', () => {
  const snap = timelineOf([
    typed('u1', 'turn one'),
    assistant('a1', 5000),
    fileDelta('d1', 'src/a.ts'),
    turnDuration('t1'),
    typed('u2', 'turn two'),
    assistant('a2', 6000),
    fileDelta('d2', 'src/b.ts'),
    fileDelta('d3', 'src/b.ts'),
  ]);
  assert.equal(snap.filesChanged.length, 3);
  const t1 = scopeToTurn(snap, snap.turnList[0]!.index);
  const t2 = scopeToTurn(snap, snap.turnList[1]!.index);
  assert.deepEqual(
    changedFiles(t1.filesChanged).map((f) => f.path),
    ['src/a.ts'],
  );
  assert.deepEqual(
    changedFiles(t2.filesChanged).map((f) => f.path),
    ['src/b.ts'],
  ); // b.ts deduped from 2 → 1
});

test('golden transcript: a re-sent file-history-delta after a reconnect is not counted twice', () => {
  // Same hazard as the cache/skill/command counters: pushing a change node is an append, and
  // stream.ts lets the line sitting at the seq high-water through again on reconnect (its guard
  // is `seq <`). Without the per-seq guard the widget would show the same file twice after every
  // reconnect. Deleting `appliedFileChangeSeqs` must turn THIS test red — nothing else covers it.
  const tree = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  const lines = [typed('u1', 'edit'), assistant('a1', 5000), fileDelta('d1', 'src/a.ts')];
  let seq = 0;
  for (const l of lines) for (const e of parseLine(l, { ...ctx, seq: seq++ }) as NormalizedEvent[]) tree.apply(e);
  // the reconnect re-sends the high-water line (seq 2, the delta) verbatim
  for (const e of parseLine(lines[2]!, { ...ctx, seq: 2 }) as NormalizedEvent[]) tree.apply(e);

  const snap = tree.snapshot();
  assert.equal(snap.filesChanged.length, 1, 'the re-sent delta is folded once');
  assert.deepEqual(
    changedFiles(snap.filesChanged).map((f) => f.path),
    ['src/a.ts'],
  );
});

// ─── Re-entry cost: what a turn paid before doing anything ────────────────────
// Measured on the real corpus (2026-07-25): 7.0% of closed work turns open on a call that
// re-creates ≥80% of its own prompt, and those rebuilds are 30.9% of every billable token.
// The verdict read that as WORK, so a two-command turn was announced as "452k tokens, past
// your p95". These start from raw lines shaped like the real ones — verified against a session:
// `usage: {input_tokens: 2, cache_creation_input_tokens: 173867, cache_read_input_tokens: 3898}`.

const compactLine = (uuid: string, pre: number, post: number) =>
  JSON.stringify({
    type: 'system',
    uuid,
    timestamp: '2026-07-14T10:00:30.000Z',
    compactMetadata: { preTokens: pre, postTokens: post, durationMs: 150 },
  });

test('golden transcript: a cold resume is charged as re-entry, not as work', () => {
  const snap = timelineOf([
    typed('u1', 'first prompt'),
    call('a1', 0, 40_000),
    turnDuration('t1'), // boot
    typed('u2', 'warm follow-up'),
    call('a2', 160_000, 700),
    turnDuration('t2'), // cache hot
    typed('u3', 'back after lunch'),
    call('a3', 3_898, 173_867),
    turnDuration('t3'),
  ]);
  const [boot, warm, cold] = snap.turnList;

  // The reducer states the fact: what the FIRST call re-created, and the prompt it ran on.
  assert.deepEqual(cold!.firstCall, { cacheCreation: 173_867, fill: 177_769 });
  assert.equal(cold!.rebuildExpected, false);
  assert.deepEqual(warm!.firstCall, { cacheCreation: 700, fill: 160_704 });

  // The verdict splits it: the resume is not work, and it says so.
  assert.equal(turnResumeCost(cold!), 173_867);
  assert.equal(turnWork(cold!), turnBillable(cold!) - 173_867);
  assert.equal(turnResumeCost(warm!), 0, 'a hot cache re-creates almost nothing');
  assert.equal(turnResumeCost(boot!), 0, 'building the window once is not a resume');

  const v = computeVerdict(cold!, snap);
  assert.equal(v.severity, 'warn');
  assert.equal(v.findings[0]!.kind, 'resume');
  assert.match(v.findings[0]!.text, /173\.9k tokens re-created/);
});

test('golden transcript: a cold resume reports ONLY the resume, from raw jsonl', () => {
  // A 174k rebuild followed by ~750 tokens of actual work. The turn is expensive on the raw
  // billable and trivial on `turnWork`, and only the resume has anything to say about it — no
  // other detector may pile on a turn whose whole cost was re-entering its own context.
  const snap = timelineOf([
    typed('u1', 'first'),
    call('a1', 0, 40_000),
    turnDuration('t1'),
    typed('u2', 'back after lunch'),
    call('a2', 3_898, 173_867),
    turnDuration('t2'),
  ]);
  const v = computeVerdict(snap.turnList[1]!, snap);
  assert.deepEqual(
    v.findings.map((f) => f.kind),
    ['resume'],
  );
  assert.equal(v.severity, 'warn');
});

test('golden transcript: a rebuild right after a compaction is expected, not a resume', () => {
  // /compact rewrites the window on purpose, so the next call re-creates it BY DESIGN. Measured:
  // this and the session's first call are 32% of the turns whose first call rebuilds.
  const snap = timelineOf([
    typed('u1', 'work'),
    call('a1', 0, 40_000),
    turnDuration('t1'),
    compactLine('c1', 400_000, 12_000),
    typed('u2', 'carry on'),
    call('a2', 2_000, 120_000),
    turnDuration('t2'),
  ]);
  const after = snap.turnList.at(-1)!;
  assert.equal(after.rebuildExpected, true);
  assert.equal(turnResumeCost(after), 0);
  assert.equal(computeVerdict(after, snap).findings.length, 0);
});

test("golden transcript: an api-error opener does not hide the turn's real first call", () => {
  // A `<synthetic>` api-error line carries an all-zero usage block; taking it as the first call
  // would freeze firstCall at {0,0} and make every resume behind it invisible. 16 real turns open
  // exactly like this.
  const snap = timelineOf([
    typed('u1', 'first'),
    call('a1', 0, 30_000),
    turnDuration('t1'),
    typed('u2', 'retry after the error'),
    synthetic('a2', 'API Error'),
    call('a3', 3_000, 150_000),
    turnDuration('t2'),
  ]);
  const t = snap.turnList.at(-1)!;
  assert.deepEqual(t.firstCall, { cacheCreation: 150_000, fill: 153_004 });
  assert.equal(turnResumeCost(t), 150_000);
});

// ---- The activity group: what the turn did SINCE ITS LAST WORD -----------------
// The gap this closes, measured on real sessions: a narration stands unchanged for a median of
// 24s (p90 100s, worst observed 22 minutes) while ~8 tool calls run under it, so the NOW panel
// spent that time stating an intent the agent had already left behind. These lines are built at
// explicit timestamps because the ORDER of word-vs-call is the whole contract.
const atToolUse = (uuid: string, id: string, name: string, ts: string) =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: ts,
    message: {
      role: 'assistant',
      model: 'claude-opus-4-8',
      content: [{ type: 'tool_use', id, name, input: { command: 'x' } }],
    },
  });
const atToolResult = (uuid: string, toolUseId: string, ts: string) =>
  JSON.stringify({
    type: 'user',
    uuid,
    timestamp: ts,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] },
  });
const atFinalAnswer = (uuid: string, text: string, ts: string) =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: ts,
    message: {
      role: 'assistant',
      model: 'claude-opus-4-8',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 5, output_tokens: 40, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 0 },
    },
  });

test('golden transcript: the activity group counts the calls made after the turn last spoke', () => {
  const snap = runLines([
    typed('u1', 'verify both tickets'),
    narration('a1', 'Parto dai dati reali.', '2026-07-14T10:00:03.000Z'),
    atToolUse('a2', 'toolu_01', 'Bash', '2026-07-14T10:00:05.000Z'),
    atToolUse('a3', 'toolu_02', 'Read', '2026-07-14T10:00:06.000Z'),
    atToolResult('u2', 'toolu_01', '2026-07-14T10:00:07.000Z'),
  ]);
  const t = snap.turnList[0]!;
  assert.deepEqual(t.activity?.counts, { Bash: 1, Read: 1 });
  // the group's age starts at its FIRST call, not at the turn or the narration
  assert.equal(t.activity?.startedTs, '2026-07-14T10:00:05.000Z');
  // only the call with no result yet is still open
  assert.deepEqual(
    t.activity?.open.map((o) => o.name),
    ['Read'],
  );
  // and the narration is still there — the panel chooses, the reducer does not throw it away
  assert.equal(t.lastNarration?.text, 'Parto dai dati reali.');
});

test('golden transcript: a new narration empties the group, the final answer closes it', () => {
  const upTo = (lines: string[]) => runLines(lines).turnList[0]!;
  const base = [
    typed('u1', 'verify both tickets'),
    atToolUse('a2', 'toolu_01', 'Bash', '2026-07-14T10:00:05.000Z'),
    atToolResult('u2', 'toolu_01', '2026-07-14T10:00:06.000Z'),
  ];
  assert.deepEqual(upTo(base).activity?.counts, { Bash: 1 });

  // the agent speaks again: it has accounted for that work itself, so the group is gone
  const spoken = [...base, narration('a3', 'Dato chiave emerso.', '2026-07-14T10:00:07.000Z')];
  assert.equal(upTo(spoken).activity, null);

  // it goes back to work: a NEW group, counting only what came after the second word
  const again = [...spoken, atToolUse('a4', 'toolu_02', 'Write', '2026-07-14T10:00:08.000Z')];
  assert.deepEqual(upTo(again).activity?.counts, { Write: 1 });
  assert.equal(upTo(again).activity?.startedTs, '2026-07-14T10:00:08.000Z');

  // the turn's final answer is a word too: it closes the group, so a finished turn reads its
  // output instead of a frozen tally of what it ran
  const finished = [...again, atFinalAnswer('a5', 'Ecco i risultati.', '2026-07-14T10:00:09.000Z')];
  assert.equal(upTo(finished).activity, null);
  assert.equal(upTo(finished).result, 'Ecco i risultati.');
});

test("golden transcript: a subagent's own calls never enter the main activity group", () => {
  const tree = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  const childCtx = { sessionId: 's1', root: 'cli' as const, agentId: 'ag1' };
  let seq = 0;
  const main = [
    typed('u1', 'review the diff'),
    narration('a1', 'Delego.', '2026-07-14T10:00:01.000Z'),
    atToolUse('a2', 'toolu_01', 'Agent', '2026-07-14T10:00:02.000Z'),
  ];
  for (const l of main) for (const e of parseLine(l, { ...ctx, seq: seq++ }) as NormalizedEvent[]) tree.apply(e);
  // the child runs three tools of its own, in ITS file
  for (const l of [
    atToolUse('c1', 'toolu_c1', 'Bash', '2026-07-14T10:00:03.000Z'),
    atToolUse('c2', 'toolu_c2', 'Bash', '2026-07-14T10:00:04.000Z'),
    atToolUse('c3', 'toolu_c3', 'Read', '2026-07-14T10:00:05.000Z'),
  ])
    for (const e of parseLine(l, { ...childCtx, seq: seq++ }) as NormalizedEvent[]) tree.apply(e);

  const t = tree.snapshot().turnList[0]!;
  // the spawn itself is main-session work and counts; the subagent's three calls do not
  assert.deepEqual(t.activity?.counts, { Agent: 1 });
});

test('golden transcript: the group is right after EVERY event, not only at the end', () => {
  // The GUI snapshots on every event, and the group is memoised per turn. A test that snapshots
  // only once (like the ones above) cannot see a cache that went stale — this one asks for the
  // group after each line, which is the sequence the panel actually renders.
  const tree = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  let seq = 0;
  const step = (line: string) => {
    for (const e of parseLine(line, { ...ctx, seq: seq++ }) as NormalizedEvent[]) tree.apply(e);
    const t = tree.snapshot().turnList[0];
    return t?.activity ? { counts: t.activity.counts, open: t.activity.open.map((o) => o.name) } : null;
  };

  assert.equal(step(typed('u1', 'verify both tickets')), null, 'a fresh turn has done nothing yet');
  assert.deepEqual(
    step(atToolUse('a1', 'toolu_01', 'Bash', '2026-07-14T10:00:01.000Z')),
    { counts: { Bash: 1 }, open: ['Bash'] },
    'the first call opens the group',
  );
  assert.deepEqual(
    step(atToolUse('a2', 'toolu_02', 'Read', '2026-07-14T10:00:02.000Z')),
    { counts: { Bash: 1, Read: 1 }, open: ['Bash', 'Read'] },
    'a second call joins it',
  );
  assert.deepEqual(
    step(atToolResult('u2', 'toolu_01', '2026-07-14T10:00:03.000Z')),
    { counts: { Bash: 1, Read: 1 }, open: ['Read'] },
    'a result closes one call but keeps its count',
  );
  assert.equal(
    step(narration('a3', 'ecco cosa ho trovato', '2026-07-14T10:00:04.000Z')),
    null,
    'the agent speaking empties the group, even with a call still open',
  );
  assert.deepEqual(
    step(atToolUse('a4', 'toolu_03', 'Write', '2026-07-14T10:00:05.000Z')),
    { counts: { Write: 1 }, open: ['Write'] },
    'work after the word starts a new group',
  );
  assert.equal(
    step(atFinalAnswer('a5', 'fatto.', '2026-07-14T10:00:06.000Z')),
    null,
    'the final answer closes it for good',
  );
});

test("golden transcript: the turn's two end blocks carry a handle onto its own text", () => {
  // Built from raw jsonl through the real parser, not a hand-made span: the prompt and
  // the final answer are the conversation itself, and both were unclickable — the only
  // two blocks in the Trace where a click did nothing.
  const tree = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  const store = createSpanStore();
  tree.onEvent((e, c) => store.apply(e, c));
  let seq = 0;
  for (const l of [
    typed('u1', 'fix the parser'),
    assistant('a1', 50_000),
    atFinalAnswer('a2', 'done — the parser now handles the empty case.', '2026-07-14T10:00:06.000Z'),
    turnDuration('t1'),
  ])
    for (const e of parseLine(l, { ...ctx, seq: seq++ }) as NormalizedEvent[]) tree.apply(e);

  const turn = store.snapshot().turns[0]!;
  const idx = turn.index;
  const prompt = turn.spans.find((s) => s.type === 'prompt')!;
  const result = turn.spans.find((s) => s.type === 'result')!;
  assert.deepEqual(prompt.handle, { kind: 'turn-text', turnIndex: idx, which: 'prompt' });
  assert.deepEqual(result.handle, { kind: 'turn-text', turnIndex: idx, which: 'result' });

  // …and the text those handles resolve to is on the reducer, so the store keeps no copy.
  const node = tree.snapshot().turnList.find((t) => t.index === idx)!;
  assert.equal(node.prompt, 'fix the parser');
  assert.match(String(node.result), /the parser now handles the empty case/);
});

// A skill forked into the background is a subagent with NO spawning tool call: nothing in the
// parent says "Agent(…)", and its `meta.json` carries no toolUseId. Its whole existence is its
// own child transcript plus one `queue-operation` line — and that line names it by `task-id`
// only. seedeep required `tool-use-id`, so the single end signal such an agent ever gets was
// dropped and it pulsed `running` for the life of the page. Shape taken from a real line;
// content synthetic.
const forkedSkillEnd = (taskId: string) =>
  JSON.stringify({
    type: 'queue-operation',
    operation: 'enqueue',
    timestamp: '2026-07-14T10:00:30.000Z',
    content: `[SYSTEM NOTIFICATION - NOT USER INPUT]\n<task-notification>\n<task-id>${taskId}</task-id>\n<output-file>/tmp/out</output-file>\n<status>completed</status>\n<summary>Agent finished</summary>\n</task-notification>`,
  });
// A child's own line, as the tailer produces it: same parser, agentId set from the file name.
const childAssistant = (uuid: string) =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: '2026-07-14T10:00:25.000Z',
    message: {
      role: 'assistant',
      model: 'claude-opus-4-8',
      usage: { input_tokens: 10, output_tokens: 40, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 },
    },
  });

test('golden transcript: a forked-skill subagent ends on a notification that names no spawn', () => {
  const tree = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  let seq = 0;
  // Parent file FIRST, whole, then the child — the order replay really uses, which is why the
  // end arrives before the agent exists.
  for (const l of [typed('u1', 'run the review'), assistant('a1', 5000), forkedSkillEnd('a49c476')]) {
    for (const e of parseLine(l, { ...ctx, seq: seq++ }) as NormalizedEvent[]) tree.apply(e);
  }
  for (const e of parseLine(childAssistant('c1'), { ...ctx, agentId: 'a49c476', seq: 0 }) as NormalizedEvent[])
    tree.apply(e);

  const sub = tree.snapshot().subagents.find((a) => a.agentId === 'a49c476');
  assert.ok(sub, 'the child transcript alone makes the subagent known');
  assert.equal(sub!.toolUseId, null, 'no spawn exists — that is the whole point');
  assert.equal(sub!.state, 'done');
});

// The two detectors anchored to the docs' named failure patterns. Both are proven HERE and only
// here: the local corpus contains ZERO instances of either anti-pattern (measured 2026-07-27 —
// this user always runs a check before shipping, and never delegates a pure exploration), so no
// real session can show that the rules fire correctly. A synthetic transcript that CONTAINS the
// anti-pattern is the only evidence available; the corpus proves the other half, that they stay
// silent on correct behaviour.
const vTool = (uuid: string, name: string, input: Record<string, unknown>) =>
  toolUse(uuid, 'toolu_' + uuid, name, input);
const reads = (n: number) =>
  Array.from({ length: n }, (_, i) => vTool('r' + i, 'Read', { file_path: `/home/dev/app/src/mod${i}.ts` }));

test('golden verdict: reading many files and changing nothing → warn exploration, from raw jsonl', () => {
  const snap = timelineOf([
    typed('u1', 'investigate how sessions work'),
    ...reads(9),
    assistant('a1', 5_000),
    turnDuration('d1'),
  ]);
  const v = computeVerdict(snap.turnList.at(-1)!, snap);
  assert.equal(v.severity, 'warn');
  assert.deepEqual(
    v.findings.map((f) => f.kind),
    ['exploration'],
  );
  assert.match(v.findings[0]!.text, /read 9 files/);
});

test('golden verdict: the same reads WITH an edit are implementation, not exploration', () => {
  // The rule that separates the two. Without it the detector caught turns with a median of 20
  // edits — heavy implementation reported as aimless reading.
  const snap = timelineOf([
    typed('u1', 'refactor the parser'),
    ...reads(9),
    vTool('e1', 'Edit', { file_path: '/home/dev/app/src/parser.ts' }),
    assistant('a1', 5_000),
    turnDuration('d1'),
  ]);
  assert.deepEqual(
    computeVerdict(snap.turnList.at(-1)!, snap).findings.map((f) => f.kind),
    [],
  );
});

test('golden verdict: a scratchpad write still counts as changing something', () => {
  // `edits` counts EVERY write, `shippedCode` only real code — a prototype is not exploration.
  const snap = timelineOf([
    typed('u1', 'try an approach'),
    ...reads(9),
    vTool('e1', 'Write', { file_path: '/tmp/claude-501/proj/sess/scratchpad/proto.ts' }),
    assistant('a1', 5_000),
    turnDuration('d1'),
  ]);
  assert.deepEqual(
    computeVerdict(snap.turnList.at(-1)!, snap).findings.map((f) => f.kind),
    [],
  );
});

test('golden verdict: committing code with no check anywhere in the session → crit, from raw jsonl', () => {
  const snap = timelineOf([
    typed('u1', 'add the endpoint and commit'),
    vTool('e1', 'Edit', { file_path: '/home/dev/app/src/server.ts' }),
    vTool('b1', 'Bash', { command: 'git commit -m "add endpoint"' }),
    assistant('a1', 5_000),
    turnDuration('d1'),
  ]);
  const v = computeVerdict(snap.turnList.at(-1)!, snap);
  assert.equal(v.severity, 'crit');
  assert.deepEqual(
    v.findings.map((f) => f.kind),
    ['unverified-ship'],
  );
});

test('golden verdict: a check run in an EARLIER turn clears the ship — the window is the session', () => {
  // The measured defect of the per-turn window: over 206 real ship events it flagged 14, and all
  // 14 had run a check in an earlier turn. Running the suite, then committing next turn, is
  // correct practice — this asserts the rule no longer punishes it.
  const snap = timelineOf([
    typed('u1', 'run the tests'),
    vTool('b0', 'Bash', { command: 'bun test' }),
    assistant('a0', 5_000),
    turnDuration('d0'),
    typed('u2', 'now commit'),
    vTool('e1', 'Edit', { file_path: '/home/dev/app/src/server.ts' }),
    vTool('b1', 'Bash', { command: 'git commit -m "add endpoint"' }),
    assistant('a1', 5_000),
    turnDuration('d1'),
  ]);
  const t = snap.turnList.at(-1)!;
  assert.deepEqual(
    computeVerdict(t, snap).findings.map((f) => f.kind),
    [],
    'the session verified before it shipped',
  );
});

test('golden verdict: a check run only AFTER the commit does not clear it — the window looks backward', () => {
  const snap = timelineOf([
    typed('u1', 'commit it'),
    vTool('e1', 'Edit', { file_path: '/home/dev/app/src/server.ts' }),
    vTool('b1', 'Bash', { command: 'git commit -m "add endpoint"' }),
    assistant('a1', 5_000),
    turnDuration('d1'),
    typed('u2', 'run the tests now'),
    vTool('b2', 'Bash', { command: 'bun test' }),
    assistant('a2', 5_000),
    turnDuration('d2'),
  ]);
  const shipTurn = snap.turnList.find((t) => t.index === 1)!;
  assert.deepEqual(
    computeVerdict(shipTurn, snap).findings.map((f) => f.kind),
    ['unverified-ship'],
  );
});

test('golden verdict: committing a SCRATCHPAD file is not shipping code', () => {
  const snap = timelineOf([
    typed('u1', 'commit the prototype'),
    vTool('e1', 'Write', { file_path: '/tmp/claude-501/proj/sess/scratchpad/proto.ts' }),
    vTool('b1', 'Bash', { command: 'git commit -m "wip"' }),
    assistant('a1', 5_000),
    turnDuration('d1'),
  ]);
  assert.deepEqual(
    computeVerdict(snap.turnList.at(-1)!, snap).findings.map((f) => f.kind),
    [],
  );
});

// ── The open call: what the session is doing, and what it is stopped on ──────────────────
// It exists so a client that does NOT own the reducer (the tray) can name the tool a pending
// approval is about. Claude Code writes the `tool_use` line BEFORE raising the dialog, so the
// call is already on record — which is the only reason naming it is a fact rather than a guess.

const openAt = (uuid: string, name: string, input: unknown, ts: string) =>
  toolUse(uuid, 'toolu_' + uuid, name, input, ts);

test('golden: the open call is the NEWEST main tool with no result yet', () => {
  const lines = [
    typed('u1', 'run the suite'),
    openAt('b1', 'Bash', { command: 'bun test' }, '2026-07-14T10:00:02.000Z'),
    openAt('r1', 'Read', { file_path: '/home/dev/app/src/server.ts' }, '2026-07-14T10:00:03.000Z'),
  ];
  // Nothing open before the first call.
  assert.equal(timelineOf(lines.slice(0, 1)).openCall, null);
  assert.deepEqual(timelineOf(lines.slice(0, 2)).openCall, {
    name: 'Bash',
    arg: 'bun test',
    startedTs: '2026-07-14T10:00:02.000Z',
  });
  // A parallel batch leaves several open at once: the newest is the one the dialog is about.
  assert.equal(timelineOf(lines).openCall?.name, 'Read');
  // The newest returning falls back to the one still running — not to null.
  assert.equal(
    timelineOf([...lines, toolResult('t1', 'toolu_r1', 'ok', '2026-07-14T10:00:05.000Z')]).openCall?.name,
    'Bash',
  );
  assert.equal(
    timelineOf([
      ...lines,
      toolResult('t1', 'toolu_r1', 'ok', '2026-07-14T10:00:05.000Z'),
      toolResult('t2', 'toolu_b1', '55 pass', '2026-07-14T10:00:06.000Z'),
    ]).openCall,
    null,
    'every call returned — nothing is open',
  );
});

test("golden: a SUBAGENT's open call is never the session's", () => {
  // The bug this forbids has a precedent in this codebase: a reducer once reported a subagent's
  // fill as the main session's. A child's Bash must not surface as what the parent is waiting on.
  const tree = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  const childCtx = { sessionId: 's1', root: 'cli' as const, agentId: 'ag1' };
  let seq = 0;
  const feed = (line: string, c: typeof ctx | typeof childCtx) => {
    for (const e of parseLine(line, { ...c, seq: seq++ }) as NormalizedEvent[]) tree.apply(e);
  };
  feed(typed('u1', 'review it'), ctx);
  feed(openAt('c1', 'Bash', { command: 'rm -rf build' }, '2026-07-14T10:00:03.000Z'), childCtx);
  assert.equal(tree.snapshot().openCall, null, 'the child is working, the parent is not');
  feed(openAt('m1', 'Read', { file_path: '/home/dev/app/src/server.ts' }, '2026-07-14T10:00:02.000Z'), ctx);
  // Older than the child's call, and still the answer: the child is not a candidate at all.
  assert.equal(tree.snapshot().openCall?.name, 'Read');
});

// A FAILED call, shaped exactly as Claude Code writes it (verified over 1830 real transcripts):
// an assistant line with `isApiErrorMessage: true`, `message.model: '<synthetic>'`, an all-zero
// usage block, an `error` CATEGORY, and — on only 18 of 47 real ones — `apiErrorStatus`. The
// user-facing text is `content`, which on ALL 47 real error lines is an ARRAY of text blocks and
// never a bare string: `renderedText` accepts both, so a string fixture would pass while testing a
// shape Claude Code does not write.
const apiError = (
  uuid: string,
  text: string,
  {
    category = 'server_error',
    status,
    ts = '2026-07-14T10:00:06.000Z',
  }: { category?: string; status?: number; ts?: string } = {},
) =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: ts,
    isApiErrorMessage: true,
    error: category,
    ...(status === undefined ? {} : { apiErrorStatus: status }),
    message: {
      role: 'assistant',
      model: '<synthetic>',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  });

test('golden: a failed call puts the session in error, and only a real call clears it', () => {
  const failed = timelineOf([typed('u1', 'go'), apiError('e1', 'API Error: 529 Overloaded.', { status: 529 })]);
  assert.equal(failed.error?.message, 'API Error: 529 Overloaded.', 'the state carries the text the user was shown');
  assert.equal(failed.error?.status, '529');
  assert.equal(failed.error?.agentId, null, 'a main-thread failure names no agent');
  assert.equal(failed.error?.at, Date.parse('2026-07-14T10:00:06.000Z'));

  // The status is absent on most real errors — the state must still exist, keyed on the flag.
  assert.equal(
    timelineOf([
      typed('u1', 'go'),
      apiError('e1', 'Not logged in · Please run /login', { category: 'authentication_failed' }),
    ]).error?.status,
    null,
    'no apiErrorStatus is not "no error"',
  );

  // Another `<synthetic>` line is NOT a recovery: Claude Code writes "No response requested." with
  // no model at all, and a session that only produced one has not made a successful call since.
  assert.ok(
    timelineOf([
      typed('u1', 'go'),
      apiError('e1', 'API Error: 529 Overloaded.'),
      synthetic('s1', 'No response requested.'),
    ]).error,
    'a synthetic line does not clear the error',
  );
  // A call that reached a model does.
  assert.equal(
    timelineOf([typed('u1', 'go'), apiError('e1', 'API Error: 529 Overloaded.'), assistant('a1', 5000)]).error,
    null,
    'the next successful call clears it',
  );
  // …and a later failure sets it again — the state is the LAST call's fate, not a latch.
  assert.equal(
    timelineOf([
      typed('u1', 'go'),
      apiError('e1', 'API Error: 529 Overloaded.'),
      assistant('a1', 5000),
      apiError('e2', 'You have hit your session limit', { category: 'rate_limit', ts: '2026-07-14T10:00:08.000Z' }),
    ]).error?.message,
    'You have hit your session limit',
  );
});

test('golden: the SAME error line re-sent leaves the state untouched (replay idempotence)', () => {
  // The stream re-sends the high-water line after a reconnect, and one call is written one line
  // per content block. Set-shaped state must survive both without changing.
  const once = timelineOf([typed('u1', 'go'), apiError('e1', 'API Error: 529 Overloaded.', { status: 529 })]);
  const twice = timelineOf([
    typed('u1', 'go'),
    apiError('e1', 'API Error: 529 Overloaded.', { status: 529 }),
    apiError('e1', 'API Error: 529 Overloaded.', { status: 529 }),
  ]);
  assert.ok(once.error, 'guard: two nulls would compare equal and prove nothing');
  assert.deepEqual(twice.error, once.error);
});

test("golden: a SUBAGENT's failed call fails the session, and names the agent", () => {
  // Measured: 8 of 47 real errors carry an agentId and ALL are sidechain lines — 7 of them rate
  // limits a fan-out hit while the main thread still looked healthy. A session whose children are
  // failing is failing, which is the whole reason the rule sits above the owner split.
  const tree = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  const childCtx = { sessionId: 's1', root: 'cli' as const, agentId: 'ag1' };
  let seq = 0;
  const feed = (line: string, c: typeof ctx | typeof childCtx) => {
    for (const e of parseLine(line, { ...c, seq: seq++ }) as NormalizedEvent[]) tree.apply(e);
  };
  feed(typed('u1', 'fan out'), ctx);
  feed(apiError('e1', 'API Error: 429 rate limit', { category: 'rate_limit', status: 429 }), childCtx);
  assert.equal(tree.snapshot().error?.agentId, 'ag1', "the child's failure is the session's, and says whose it is");
  feed(assistant('a1', 5000), ctx);
  assert.equal(tree.snapshot().error, null, 'a successful main call clears a child-borne error');
});

// ── the intent that opened a round names it, from raw lines to the strip ────
// The join is the API call: one response is written as several jsonl lines — the text block
// (what the model says it is about to do) and each tool_use — all sharing one `message.id`,
// which is exactly the call whose tools form the Trace's round. A hand-built event could not
// discover that the parser must carry the id onto the narration; this starts from the lines.

/** A call's narration line: text block, stop_reason "tool_use", carrying the call's id + usage. */
const intentLine = (uuid: string, id: string, text: string, ts: string) =>
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
      usage: { input_tokens: 10, output_tokens: 60, cache_read_input_tokens: 5_000, cache_creation_input_tokens: 0 },
    },
  });

/** The turn's answer, written on a given call: `end_turn` text, carrying that call's id. */
const answerOfCall = (uuid: string, id: string, text: string) =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: '2026-07-14T10:00:08.000Z',
    message: {
      role: 'assistant',
      id,
      model: 'claude-opus-4-8',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text }],
    },
  });

/** A tool_use line of a given call: same `message.id`, and the SAME usage block repeated —
 * which is what Claude Code really writes on every line of one call, and what the per-call
 * fold exists to survive. */
const toolOfCall = (uuid: string, id: string, toolUseId: string, name: string, ts: string) =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: ts,
    message: {
      role: 'assistant',
      id,
      model: 'claude-opus-4-8',
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: toolUseId, name, input: { file_path: '/home/dev/parser.ts' } }],
      usage: { input_tokens: 10, output_tokens: 60, cache_read_input_tokens: 5_000, cache_creation_input_tokens: 0 },
    },
  });

test('golden: a round is named by the intent of its own call; a silent round keeps its number', () => {
  const tree = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  const store = createSpanStore();
  tree.onEvent((e, c) => store.apply(e, c));
  let seq = 0;
  const feed = (l: string) => {
    for (const e of parseLine(l, { ...ctx, seq: seq++ }) as NormalizedEvent[]) tree.apply(e);
  };
  for (const l of [
    typed('u1', 'why is the line dropped?'),
    // Call one: speaks, then acts — two lines, one id.
    intentLine('a1', 'msg_r1', 'Reading the parser to see which branch drops the line.', '2026-07-14T10:00:02.000Z'),
    toolOfCall('a2', 'msg_r1', 'toolu_01', 'Read', '2026-07-14T10:00:03.000Z'),
    toolResult('u2', 'toolu_01', 'const out = []'),
    // Call two: acts in silence, the common case (60% of real rounds).
    call('a3', 100_000, 0, 'msg_r2'),
    toolOfCall('a4', 'msg_r2', 'toolu_02', 'Grep', '2026-07-14T10:00:05.000Z'),
    toolResult('u3', 'toolu_02', '3 matches'),
    // The answer SHARES the silent call's id on purpose: it is what makes the stop_reason gate
    // falsifiable here. With no id its event carries `callId: null`, which the store ignores
    // anyway — the "never a round name" assertion below would then pass with the gate removed.
    answerOfCall('a5', 'msg_r2', 'The branch requires `origin`, which a slash command has not.'),
    turnDuration('t1'),
  ])
    feed(l);

  const turn = store.snapshot().turns[0]!;
  const items = groupTurnSpans(turn.spans.filter((s) => s.lane === 0));
  // Two adjacent rounds are already a chapter — which is the level the user sees first, and
  // the reason the chapter has to say something about the intents it hides.
  const chapter = items.find((i) => i.kind === 'group' && i.rounds > 1) as Extract<
    (typeof items)[number],
    { kind: 'group' }
  >;
  assert.ok(chapter, 'the two rounds fold into one chapter');
  assert.equal(chapter.label, 'R1–2', 'the chapter keeps its RANGE as its name');
  assert.deepEqual(
    chapter.intents,
    ['Reading the parser to see which branch drops the line.'],
    'the chapter counts the intents it folds, first to last',
  );

  const rounds = chapter.items.filter((i) => i.kind === 'group') as Array<
    Extract<(typeof items)[number], { kind: 'group' }>
  >;
  assert.equal(rounds.length, 2, 'two api calls, two rounds — the answer rides the second one');
  assert.deepEqual(
    rounds[0]!.intents,
    ['Reading the parser to see which branch drops the line.'],
    "the round carries its own call's intent",
  );
  assert.deepEqual(rounds[1]!.intents, [], 'a silent round states nothing — its number stays its name');
  // The turn's final answer is the RESULT, never an intent: naming the last round with it would
  // put the conclusion on the block that led to it.
  assert.equal(
    rounds.some((r) => r.intents.some((t) => t.startsWith('The branch requires'))),
    false,
    'the end_turn answer never becomes a round name',
  );
});

test('golden transcript: a background command whose notification lands BEFORE its launch is not left running', () => {
  // The order really is this, on disk, verified on a real session: the notification (queue-operation)
  // at line 1853 and the assistant `tool_use` that launched it at 1857. Claude Code appends an
  // assistant line when its block CLOSES, so a command that finishes in a few seconds reports back
  // before the line that launched it exists. Reading them in file order, the outcome had nothing to
  // attach to and the command showed as "still running" for the rest of the session.
  const bgNotify = (uuid: string, toolUseId: string, taskId: string) =>
    JSON.stringify({
      type: 'queue-operation',
      operation: 'enqueue',
      uuid,
      timestamp: '2026-07-14T10:00:04.000Z',
      content: `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>completed</status>\n<summary>Background command "sample" completed (exit code 0)</summary>\n</task-notification>`,
    });
  const bgLaunch = (uuid: string, id: string) =>
    JSON.stringify({
      type: 'assistant',
      uuid,
      timestamp: '2026-07-14T10:00:02.000Z',
      message: {
        role: 'assistant',
        id: 'msg_bg',
        model: 'claude-opus-4-8',
        content: [{ type: 'tool_use', id, name: 'Bash', input: { command: './sample.sh', run_in_background: true } }],
        usage: { input_tokens: 4, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
      },
    });
  const bgReceipt = (uuid: string, id: string, taskId: string) =>
    JSON.stringify({
      type: 'user',
      uuid,
      timestamp: '2026-07-14T10:00:05.000Z',
      toolUseResult: { backgroundTaskId: taskId },
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: id, content: `Command running in background with ID: ${taskId}` },
        ],
      },
    });

  const snap = timelineOf([
    typed('u1', 'sample the status'),
    bgNotify('q1', 'toolu_bg', 'brtkoc5pk'), // ← the end, written first
    bgLaunch('a1', 'toolu_bg'),
    bgReceipt('u2', 'toolu_bg', 'brtkoc5pk'),
  ]);

  assert.deepEqual(
    runningBackground(snap.mainTools).map((c) => c.toolUseId),
    [],
    'the command reported its own end — nothing is still running',
  );
  const tool = snap.mainTools.find((t) => t.id === 'toolu_bg')!;
  assert.ok(tool.outcome, 'and the row carries the outcome Claude Code reported');
});
