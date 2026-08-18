import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { SessionRecord } from '../src/core/types.ts';
import { readCallIO } from '../src/server/call-io.ts';
import { startServer } from '../src/server/server.ts';

// An API call is a message.id spread over one line per content block. readCallIO reads its INPUT
// (the user content just before the call's first line — a prompt, or the tool_results fed back)
// and its OUTPUT (that call's text / thinking / tool_use), from the session's own files. Content
// is synthetic; only the SHAPE is real (assistant line carries message.{id,model,usage,content};
// a tool_result's text lives under block.content, not block.text).

function writeSession(mainLines: string[], childLines: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-call-'));
  const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const path = join(dir, `${uuid}.jsonl`);
  writeFileSync(path, mainLines.join('\n') + '\n');
  if (childLines.length) {
    const subDir = join(dir, uuid, 'subagents');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, 'agent-ag1.jsonl'), childLines.join('\n') + '\n');
  }
  return path;
}

const usage = { input_tokens: 10, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 };
const prompt = (text: string) =>
  JSON.stringify({
    type: 'user',
    timestamp: '2026-07-14T10:00:00.000Z',
    origin: { kind: 'human' },
    promptSource: 'typed',
    message: { role: 'user', content: text },
  });
const toolResult = (toolUseId: string, content: unknown) =>
  JSON.stringify({
    type: 'user',
    timestamp: '2026-07-14T10:00:03.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] },
  });
const call = (id: string, content: unknown[], u = usage) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-14T10:00:02.000Z',
    message: { role: 'assistant', id, model: 'claude-opus-4-8', usage: u, content },
  });

test("readCallIO returns a call's input (the prompt) and output (text/thinking/tools)", async () => {
  const path = writeSession([
    prompt('do the thing'),
    call('msg_1', [
      { type: 'thinking', thinking: 'let me think' },
      { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/home/dev/x.ts' } },
      { type: 'tool_use', id: 'toolu_2', name: 'TaskList', input: {} },
    ]),
  ]);
  const io = await readCallIO(path, 'msg_1');
  assert.equal(io?.input.text, 'do the thing');
  assert.equal(
    io?.output.text,
    'let me think\n→ Read {"file_path":"~/x.ts"}\n→ TaskList',
    'output = thinking, the tool the model called WITH its args (anonymized), and a no-arg tool by name',
  );
  assert.equal(io?.outputHasTools, true, 'the output contains a tool_use → viewer renders it verbatim, not markdown');
  assert.equal(io?.model, 'claude-opus-4-8');
  assert.deepEqual(io?.usage, { input: 10, output: 50, cacheRead: 1000, cacheCreation: 200 });
});

test('readCallIO folds a call spread over several lines into one output', async () => {
  const path = writeSession([
    prompt('go'),
    call('msg_1', [{ type: 'thinking', thinking: 'a' }]),
    call('msg_1', [{ type: 'text', text: 'the answer' }]), // same id, next content block
  ]);
  const io = await readCallIO(path, 'msg_1');
  assert.equal(io?.output.text, 'a\nthe answer', 'both blocks of the one call are joined');
  assert.equal(io?.outputHasTools, false, 'a pure-text output has no tools → markdown-rendered');
});

test('readCallIO: an injected (isMeta) user line is skipped when finding the input', async () => {
  const metaLine = JSON.stringify({
    type: 'user',
    timestamp: '2026-07-14T10:00:01.000Z',
    isMeta: true,
    message: { role: 'user', content: [{ type: 'text', text: 'injected skill body — not the trigger' }] },
  });
  const path = writeSession([prompt('the real prompt'), metaLine, call('msg_1', [{ type: 'text', text: 'done' }])]);
  const io = await readCallIO(path, 'msg_1');
  assert.equal(io?.input.text, 'the real prompt', 'the isMeta line is not the input; the real prompt before it is');
});

test("readCallIO: a mid-turn call's input is the tool_result that fed it (dug from block.content)", async () => {
  const path = writeSession([
    prompt('start'),
    call('msg_1', [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }]),
    toolResult('toolu_1', 'the file contents'), // text lives under content, not .text
    call('msg_2', [{ type: 'text', text: 'done' }]),
  ]);
  const io = await readCallIO(path, 'msg_2');
  assert.equal(io?.input.text, 'the file contents', 'the input is the result the previous tool returned');
});

test('readCallIO finds a SUBAGENT call in the child file, not the parent', async () => {
  const path = writeSession(
    [prompt('spawn it')],
    [prompt('sub input'), call('msg_sub', [{ type: 'text', text: 'sub output' }])],
  );
  const io = await readCallIO(path, 'msg_sub');
  assert.equal(io?.input.text, 'sub input');
  assert.equal(io?.output.text, 'sub output');
});

test('readCallIO anonymizes: a real home path never leaves the process', async () => {
  const home = '/Us' + 'ers/carol/secret/app.ts'; // assembled: a literal home path is a commit gate
  const path = writeSession([prompt('go'), call('msg_1', [{ type: 'text', text: 'wrote ' + home }])]);
  const io = await readCallIO(path, 'msg_1');
  assert.equal(io?.output.text, 'wrote ~/secret/app.ts');
});

test('readCallIO caps each side but reports the TRUE length', async () => {
  const path = writeSession([prompt('go'), call('msg_1', [{ type: 'text', text: 'x'.repeat(5000) }])]);
  const io = await readCallIO(path, 'msg_1', 1000);
  assert.equal(io?.output.text.length, 1000, 'the text is bounded');
  assert.equal(io?.output.len, 5000, 'the size reported is the real one');
  assert.equal(io?.output.truncated, true);
});

test('readCallIO: an unknown call id is null', async () => {
  const path = writeSession([prompt('go'), call('msg_1', [{ type: 'text', text: 'hi' }])]);
  assert.equal(await readCallIO(path, 'msg_missing'), null);
});
const roster = (path: string): SessionRecord[] => [
  {
    sessionId: 'sess-1',
    project: 'demo',
    model: 'claude-opus-4-8',
    lastActivity: 1,
    isActive: false,
    isOpen: false,
    status: null,
    waitingFor: null,
    waitingSince: null,
    statusDerived: false,
    subject: null,
    entrypoint: null,
    root: 'cli',
    path,
  },
];

test('GET /api/call-io returns the call I/O; unknown session or call → 404', async () => {
  const path = writeSession([prompt('the input'), call('msg_1', [{ type: 'text', text: 'the output' }])]);
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => roster(path),
    port: 0,
  });
  try {
    const res = await fetch(`${srv.url}/api/call-io?sessionId=sess-1&callId=msg_1`);
    assert.equal(res.status, 200);
    const io = (await res.json()) as any;
    assert.equal(io.input.text, 'the input');
    assert.equal(io.output.text, 'the output');
    assert.equal(io.model, 'claude-opus-4-8');

    assert.equal((await fetch(`${srv.url}/api/call-io?sessionId=nope&callId=msg_1`)).status, 404);
    assert.equal((await fetch(`${srv.url}/api/call-io?sessionId=sess-1&callId=nope`)).status, 404);
    assert.equal(
      (await fetch(`${srv.url}/api/call-io?sessionId=sess-1`)).status,
      404,
      'no call id is not a request for "some call"',
    );
  } finally {
    srv.stop();
  }
});

// `effort` is a REAL field Claude Code started writing in 2.1.212 (measured: 0 of 26,874
// assistant lines before that version carry it, 362 of 388 after). It sits at the line's
// ROOT — not inside `message`, which is where one would guess — and haiku never writes it.
// Absence is therefore not "no effort", so it must come back as null and never as a value.
test('readCallIO reads root-level effort, and reports null when the line has none', async () => {
  const withEffort = JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-14T10:00:02.000Z',
    version: '2.1.214',
    effort: 'high',
    message: {
      role: 'assistant',
      id: 'msg_eff',
      model: 'claude-opus-4-8',
      usage,
      content: [{ type: 'text', text: 'ok' }],
    },
  });
  // Same shape, one version older: the field simply is not there.
  const without = JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-14T10:00:04.000Z',
    version: '2.1.211',
    message: {
      role: 'assistant',
      id: 'msg_old',
      model: 'claude-opus-4-8',
      usage,
      content: [{ type: 'text', text: 'ok' }],
    },
  });
  const path = writeSession([prompt('hi'), withEffort, prompt('hi again'), without]);

  const a = await readCallIO(path, 'msg_eff');
  assert.equal(a?.effort, 'high');
  const b = await readCallIO(path, 'msg_old');
  assert.equal(b?.effort, null, 'a line without the field reports null, never a made-up default');
});

// The field is NOT under message — reading it there would silently always yield null.
test('effort is not read from inside message', async () => {
  const misplaced = JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-14T10:00:02.000Z',
    message: {
      role: 'assistant',
      id: 'msg_x',
      model: 'claude-opus-4-8',
      usage,
      effort: 'max',
      content: [{ type: 'text', text: 'ok' }],
    },
  });
  const path = writeSession([prompt('hi'), misplaced]);
  assert.equal((await readCallIO(path, 'msg_x'))?.effort, null);
});

// ── the call's INTENT, split out of the output it is buried in ──────────────
// The mid-turn text is already inside `output`, but a call with tools renders verbatim (its
// args are code), so the one thing in the drawer meant to be read as prose was read as a dump.

/** An assistant line with an explicit stop_reason — what tells an intent from the turn's answer. */
const callStop = (id: string, stop: string, content: unknown[]) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-14T10:00:02.000Z',
    message: { role: 'assistant', id, model: 'claude-opus-4-8', stop_reason: stop, usage, content },
  });

test('readCallIO: a mid-turn text is the call INTENT, and stays in the output too', async () => {
  const path = writeSession([
    prompt('why is the line dropped?'),
    callStop('msg_1', 'tool_use', [{ type: 'text', text: 'Reading the parser first.' }]),
    callStop('msg_1', 'tool_use', [
      { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/home/dev/parser.ts' } },
    ]),
  ]);
  const io = await readCallIO(path, 'msg_1');
  assert.equal(io?.narration, 'Reading the parser first.', 'the intent is available on its own');
  assert.ok(io?.output.text.startsWith('Reading the parser first.'), 'and is still part of the raw output');
  assert.equal(io?.outputHasTools, true);
});

test('readCallIO: the call that CLOSES the turn states no intent', async () => {
  // Its text is the answer, which the turn's own final-answer drawer already owns. Labelling it
  // "what the model was about to do" would put the conclusion where the plan belongs.
  const path = writeSession([
    prompt('go'),
    callStop('msg_1', 'end_turn', [{ type: 'text', text: 'Done — the branch required `origin`.' }]),
  ]);
  const io = await readCallIO(path, 'msg_1');
  assert.equal(io?.narration, null);
  assert.equal(io?.output.text, 'Done — the branch required `origin`.', 'the answer is still the output');
});

test('readCallIO: a silent call has no intent at all', async () => {
  const path = writeSession([
    prompt('go'),
    call('msg_1', [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }]),
  ]);
  assert.equal((await readCallIO(path, 'msg_1'))?.narration, null);
});
