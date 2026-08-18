import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isWorking, pendingInput } from '../src/core/types.ts';
import { deriveStatus } from '../src/server/derived-status.ts';
import { discoverSessions } from '../src/server/discovery.ts';

// Line shapes taken from a real transcript written by the desktop app's Code tab: every line of a
// call repeats that call's `stop_reason`, and the host writes `attachment` / `custom-title` lines
// around the turn. Content is synthetic; only the shape is real.
const assistant = (block: string, stopReason: string | null, uuid = 'a1') =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: '2026-07-14T10:00:05.000Z',
    isSidechain: false,
    message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: block }], stop_reason: stopReason },
  });
// A typed prompt as Claude Code really writes it: `origin.kind: 'human'` and `promptSource`, which
// is what tells it apart from the user lines nobody answers (a command's stdout, an injected body).
const user = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'user',
    uuid: 'u1',
    timestamp: '2026-07-14T10:00:00.000Z',
    isSidechain: false,
    origin: { kind: 'human' },
    promptSource: 'typed',
    message: { role: 'user', content: 'do the thing' },
    ...extra,
  });
const attachment = JSON.stringify({ type: 'attachment', uuid: 'at1', isSidechain: false, attachment: {} });
const customTitle = JSON.stringify({ type: 'custom-title', customTitle: 'a session' });

function transcript(lines: string[], name = 'x.jsonl'): string {
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-derived-'));
  const p = join(dir, name);
  writeFileSync(p, lines.join('\n') + '\n');
  return p;
}
const statusOf = async (lines: string[]) => {
  const p = transcript(lines);
  return (await deriveStatus(p, Buffer.byteLength(lines.join('\n') + '\n')))?.status ?? null;
};
/** The whole derived state, for the tests that are about more than the status word. */
const stateOf = async (lines: string[]) => {
  const p = transcript(lines);
  return deriveStatus(p, Buffer.byteLength(lines.join('\n') + '\n'));
};

test('a call that stopped for a tool is working', async () => {
  assert.equal(await statusOf([user(), assistant('tool_use', 'tool_use')]), 'busy');
});

test('a call that stopped for the user, its final text written, is idle', async () => {
  assert.equal(await statusOf([user(), assistant('text', 'end_turn')]), 'idle');
});

test('a thinking block already carrying end_turn is still working', async () => {
  // The whole reason the block type is read at all: every line of a call repeats the call's final
  // stop_reason, so `end_turn` appears on the thinking line while the answer is still streaming.
  // Measured over 15,070 calls in 250 sessions (2026-08-18), a call that ended for the user ALWAYS
  // ends on a `text` block — so a thinking line as the tail means the call is still in flight.
  assert.equal(await statusOf([user(), assistant('thinking', 'end_turn')]), 'busy');
});

test('a prompt with no answer yet is working, and the row an Esc writes is not', async () => {
  assert.equal(await statusOf([user()]), 'busy');
  assert.equal(await statusOf([assistant('text', 'end_turn'), user({ interruptedMessageId: 'a1' })]), 'idle');
});

// The `tool_use` block on its own line, as the host writes it — one block per line.
const toolCall = (name: string, uuid = 'a2', ts = '2026-07-14T10:00:07.000Z') =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: ts,
    isSidechain: false,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_' + uuid, name, input: {} }],
      stop_reason: 'tool_use',
    },
  });
const toolResult = (uuid: string) =>
  JSON.stringify({
    type: 'user',
    uuid: 'u2',
    timestamp: '2026-07-14T10:00:20.000Z',
    isSidechain: false,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_' + uuid, content: 'ok' }] },
  });

test('a question with no answer is a session stopped on the user, with the age of the question', async () => {
  // Measured 2026-08-18 on a real desktop session held at its dialog: the `AskUserQuestion`
  // tool_use sits there with no tool_result while the session file publishes nothing at all.
  // Read as an ordinary pending call it reported a blocked session as WORKING, in green.
  const state = await stateOf([user(), toolCall('AskUserQuestion')]);
  assert.equal(state?.status, 'waiting');
  assert.equal(state?.waitingFor, 'input needed');
  assert.equal(state?.waitingSince, Date.parse('2026-07-14T10:00:07.000Z'), 'the age counts from the question');
});

test('an answered question is the model working again', async () => {
  assert.equal(await statusOf([user(), toolCall('AskUserQuestion'), toolResult('a2')]), 'busy');
});

test('any other pending call is work, not a wait', async () => {
  // A Bash awaiting approval and a Bash that is running are the same two lines. Claiming a wait
  // here would put "needs you" on a session that is merely slow, which is the badge crying wolf.
  assert.equal(await statusOf([user(), toolCall('Bash')]), 'busy');
});

test('an interrupted call (no stop_reason) is idle', async () => {
  assert.equal(await statusOf([user(), assistant('text', null)]), 'idle');
});

test('the host’s own trailing lines say nothing, and the assistant below them decides', async () => {
  assert.equal(await statusOf([user(), assistant('tool_use', 'tool_use'), attachment, customTitle]), 'busy');
});

test('a subagent’s line is never read as the session’s own state', async () => {
  const child = JSON.stringify({
    type: 'assistant',
    uuid: 'c1',
    isSidechain: true,
    message: { role: 'assistant', content: [{ type: 'text' }], stop_reason: 'end_turn' },
  });
  assert.equal(await statusOf([user(), assistant('tool_use', 'tool_use'), child]), 'busy');
});

// A local command writes user lines nobody answers: the tagged `<command-name>` shape, the caveat
// Claude Code injects, and the command's own stdout. Shapes taken from real transcripts.
const localCommand = (name: string) =>
  JSON.stringify({
    type: 'user',
    uuid: 'u-cmd',
    timestamp: '2026-07-14T10:05:00.000Z',
    isSidechain: false,
    message: {
      role: 'user',
      content: `<command-name>/${name}</command-name>\n<command-message>${name}</command-message>`,
    },
  });
const localStdout = JSON.stringify({
  type: 'user',
  uuid: 'u-out',
  timestamp: '2026-07-14T10:05:01.000Z',
  isSidechain: false,
  isMeta: true,
  message: { role: 'user', content: '<local-command-stdout>Set model to Opus</local-command-stdout>' },
});

test('a session left on a local command is not working', async () => {
  // Measured over 300 real sessions: 4 end on one of these lines. Read as a prompt awaiting an
  // answer, such a session showed a lit dot and a Working band until its user typed again.
  assert.equal(await statusOf([user(), assistant('text', 'end_turn'), localCommand('model'), localStdout]), 'idle');
  assert.equal(await statusOf([user(), assistant('tool_use', 'tool_use'), localStdout]), 'busy');
});

test('a tail line too big for the first window is still read', async () => {
  // A tool result of a megabyte is an ordinary moment, not a pathology: 0.52% of real lines are
  // bigger than the first window, and answering "no claim" there dropped a working session into
  // Idle, which no surface tells apart from a real one.
  const huge = JSON.stringify({
    type: 'user',
    uuid: 'u-big',
    timestamp: '2026-07-14T10:00:00.000Z',
    isSidechain: false,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(200_000) }] },
  });
  assert.equal(await statusOf([user(), assistant('tool_use', 'tool_use'), huge]), 'busy');
});

test('a transcript with nothing decisive makes no claim', async () => {
  assert.equal(await statusOf([customTitle, attachment]), null);
  assert.equal(await deriveStatus(join(tmpdir(), 'seedeep-nope-' + Date.now() + '.jsonl'), 10), null);
});

test('an unchanged file is not re-read', async () => {
  // The watcher re-discovers every ~300ms; the tail can only change when the file grows, so the
  // size IS the cache key. Rewritten in place at the same size, the answer must not move.
  const lines = [user(), assistant('tool_use', 'tool_use')];
  const p = transcript(lines);
  const size = Buffer.byteLength(lines.join('\n') + '\n');
  assert.equal((await deriveStatus(p, size))?.status, 'busy');
  const swapped = [user(), assistant('text', 'end_turn', 'a2')];
  writeFileSync(p, swapped.join('\n') + '\n');
  assert.equal((await deriveStatus(p, size))?.status, 'busy', 'same size → the cached answer stands');
  assert.equal(
    (await deriveStatus(p, Buffer.byteLength(swapped.join('\n') + '\n')))?.status,
    'idle',
    'grown → re-read',
  );
});

// ── through discovery ────────────────────────────────────────────────────────────────────────

const SID = 'aaaaaaaa-0000-0000-0000-000000000001';
function rootWith(lines: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'seedeep-derived-disc-'));
  const slug = join(root, '-home-dev-project');
  mkdirSync(slug, { recursive: true });
  const head = JSON.stringify({
    type: 'assistant',
    sessionId: SID,
    cwd: '/home/dev/project',
    entrypoint: 'claude-desktop',
    message: { model: 'claude-opus-4-8' },
  });
  writeFileSync(join(slug, `${SID}.jsonl`), [head, ...lines].join('\n') + '\n');
  return root;
}
const openSession = (publishesStatus: boolean, status: 'busy' | 'idle' | null = null) => ({
  pid: 1,
  sessionId: SID,
  cwd: '/home/dev/project',
  status,
  waitingFor: null,
  waitingSince: null,
  publishesStatus,
});

test('a session whose host publishes no status gets one derived', async () => {
  const recs = await discoverSessions({
    roots: [rootWith([user(), assistant('tool_use', 'tool_use')])],
    now: Date.now(),
    openSessions: [openSession(false)],
  });
  const rec = recs.find((r) => r.sessionId === SID)!;
  assert.equal(rec.status, 'busy');
});

test('a derived wait reaches the record in Claude Code’s own words', async () => {
  const recs = await discoverSessions({
    roots: [rootWith([user(), toolCall('AskUserQuestion', 'a2', '2026-07-14T10:00:07.000Z')])],
    now: Date.now(),
    openSessions: [openSession(false)],
  });
  const rec = recs.find((r) => r.sessionId === SID)!;
  assert.equal(rec.status, 'waiting');
  assert.equal(rec.waitingFor, 'input needed');
  assert.equal(rec.waitingSince, Date.parse('2026-07-14T10:00:07.000Z'));
  // The point of using Claude Code's vocabulary: every surface downstream reads it unchanged.
  assert.equal(pendingInput(rec), 'input');
  assert.equal(isWorking(rec), false, 'a session stopped on you is not working');
});

test('a session that publishes its own status is never overridden', async () => {
  // The gate is `publishesStatus`, not `status`: a value seedeep does not recognise also reduces
  // to null, and deriving over THAT would put a guess on top of Claude Code's own word.
  const recs = await discoverSessions({
    roots: [rootWith([user(), assistant('tool_use', 'tool_use')])],
    now: Date.now(),
    openSessions: [openSession(true, 'idle')],
  });
  const rec = recs.find((r) => r.sessionId === SID)!;
  assert.equal(rec.status, 'idle', 'the session’s own word stands, even against a busy-looking tail');
});

test('an unrecognised published status stays "no claim" rather than becoming a derived one', async () => {
  const recs = await discoverSessions({
    roots: [rootWith([user(), assistant('tool_use', 'tool_use')])],
    now: Date.now(),
    openSessions: [openSession(true, null)],
  });
  const rec = recs.find((r) => r.sessionId === SID)!;
  assert.equal(rec.status, null);
});

test('a session nobody is running is never derived', async () => {
  const recs = await discoverSessions({
    roots: [rootWith([user(), assistant('tool_use', 'tool_use')])],
    now: Date.now(),
    openSessions: [],
  });
  const rec = recs.find((r) => r.sessionId === SID)!;
  assert.equal(rec.status, null);
});
