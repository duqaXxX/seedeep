import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  scanAgySessions,
  scanCodexSessions,
  scanGeminiSessions,
  scanGrokSessions,
} from '../src/server/discover-extra.ts';
import { listGrokOpenSessions } from '../src/server/open-sessions.ts';
import { parseLine } from '../src/server/parser.ts';

const grokCtx = { sessionId: 'g1', root: 'grok' as const, seq: 3 };
const codexCtx = { sessionId: 'c1', root: 'codex' as const, seq: 3 };
const geminiCtx = { sessionId: 'm1', root: 'gemini' as const, seq: 3 };

test('grok user_message_chunk is a user-turn', () => {
  const line = JSON.stringify({
    timestamp: 1789662982,
    method: 'session/update',
    params: {
      sessionId: 'g1',
      update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'fix the parser' } },
    },
  });
  const evs = parseLine(line, grokCtx);
  assert.equal(evs.length, 1);
  const ev = evs[0]!;
  assert.equal(ev.type, 'user-turn');
  if (ev.type === 'user-turn') assert.equal(ev.prompt, 'fix the parser');
});

test('grok tool_call and completed tool_call_update pair', () => {
  const start = parseLine(
    JSON.stringify({
      timestamp: 1789662982,
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'call-1',
          title: 'read_file',
          rawInput: { target_file: '/home/dev/project/a.ts' },
          _meta: { 'x.ai/tool': { name: 'read_file' } },
        },
      },
    }),
    grokCtx,
  );
  assert.equal(start[0]?.type, 'tool-start');
  if (start[0]?.type === 'tool-start') {
    assert.equal(start[0].id, 'call-1');
    assert.equal(start[0].name, 'read_file');
    assert.ok(start[0].arg?.includes('a.ts'));
  }
  const end = parseLine(
    JSON.stringify({
      timestamp: 1789662983,
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-1',
          status: 'completed',
          rawOutput: 'ok',
          _meta: { 'x.ai/tool': { name: 'read_file' } },
        },
      },
    }),
    grokCtx,
  );
  assert.equal(end[0]?.type, 'tool-end');
  if (end[0]?.type === 'tool-end') assert.equal(end[0].toolUseId, 'call-1');
});

test('grok turn_completed emits usage + turn-end', () => {
  const evs = parseLine(
    JSON.stringify({
      timestamp: 1789663000,
      method: '_x.ai/session/update',
      params: {
        update: {
          sessionUpdate: 'turn_completed',
          prompt_id: 'p1',
          elapsed_ms: 1200,
          usage: {
            inputTokens: 1000,
            outputTokens: 50,
            cachedReadTokens: 400,
            cacheCreationTokens: 0,
            reasoningTokens: 20,
            modelUsage: { 'grok-4.6': {} },
          },
        },
      },
    }),
    grokCtx,
  );
  const usage = evs.find((e) => e.type === 'usage');
  const end = evs.find((e) => e.type === 'turn-end');
  assert.ok(usage && usage.type === 'usage');
  assert.deepEqual(usage.delta, { input: 600, output: 50, cacheRead: 400, cacheCreation: 0 });
  assert.equal(usage.fill, 1000);
  assert.equal(usage.thinking, 20);
  assert.equal(usage.model, 'grok-4.6');
  assert.ok(end && end.type === 'turn-end');
  if (end.type === 'turn-end') assert.equal(end.durationMs, 1200);
});

test('grok spawn_subagent completion is a launch receipt, not a finish', () => {
  const evs = parseLine(
    JSON.stringify({
      timestamp: 1,
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-spawn',
          status: 'completed',
          _meta: { 'x.ai/tool': { name: 'spawn_subagent' } },
        },
      },
    }),
    grokCtx,
  );
  assert.equal(evs[0]?.type, 'tool-end');
  if (evs[0]?.type === 'tool-end') assert.deepEqual(evs[0].launched, { agentId: null });
});

test('codex token_usage_record is a usage event', () => {
  const evs = parseLine(
    JSON.stringify({
      timestamp: '2026-09-16T18:02:03.448Z',
      type: 'token_usage_record',
      payload: {
        response_id: 'resp_1',
        usage: {
          input_tokens: 29553,
          cached_input_tokens: 12672,
          cache_write_input_tokens: 0,
          output_tokens: 211,
          reasoning_output_tokens: 40,
        },
      },
    }),
    codexCtx,
  );
  const usage = evs.find((e) => e.type === 'usage');
  assert.ok(usage && usage.type === 'usage');
  assert.deepEqual(usage.delta, { input: 16881, output: 211, cacheRead: 12672, cacheCreation: 0 });
  assert.equal(usage.fill, 29553);
  assert.equal(usage.thinking, 40);
  assert.equal(usage.callId, 'resp_1');
});

test('codex function_call / output pair', () => {
  const start = parseLine(
    JSON.stringify({
      timestamp: '2026-09-16T18:02:03.448Z',
      type: 'response_item',
      payload: { type: 'function_call', call_id: 'call_abc', name: 'exec', arguments: '{"cmd":"ls"}' },
    }),
    codexCtx,
  );
  assert.equal(start[0]?.type, 'tool-start');
  const end = parseLine(
    JSON.stringify({
      timestamp: '2026-09-16T18:02:04.448Z',
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'call_abc', output: 'ok' },
    }),
    codexCtx,
  );
  assert.equal(end[0]?.type, 'tool-end');
});

test('gemini user + model line with tokens and toolCalls', () => {
  const user = parseLine(
    JSON.stringify({
      id: 'u1',
      timestamp: '2026-04-27T06:34:14.385Z',
      type: 'user',
      content: [{ text: 'grade the folder' }],
    }),
    geminiCtx,
  );
  assert.equal(user[0]?.type, 'user-turn');
  const model = parseLine(
    JSON.stringify({
      id: 'a1',
      timestamp: '2026-04-27T06:34:56.172Z',
      type: 'gemini',
      model: 'gemini-3.1-pro-preview',
      tokens: { input: 35117, output: 32, cached: 0, thoughts: 764, total: 35913 },
      toolCalls: [{ id: 't1', name: 'listAllFolders', args: {}, status: 'error', resultDisplay: 'denied' }],
      content: 'I will list folders.',
    }),
    geminiCtx,
  );
  assert.ok(model.some((e) => e.type === 'usage'));
  assert.ok(model.some((e) => e.type === 'tool-start'));
  assert.ok(model.some((e) => e.type === 'tool-end' && e.type === 'tool-end' && e.error));
  assert.ok(model.some((e) => e.type === 'turn-result'));
});

test('claude parseLine is unchanged when root is cli', () => {
  const evs = parseLine(
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-11T17:37:37.566Z',
      message: {
        model: 'claude-opus-4-8',
        usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }),
    { sessionId: 's1', root: 'cli', seq: 1 },
  );
  assert.ok(evs.some((e) => e.type === 'usage'));
});

test('scanGrokSessions reads summary.json and prefers updates.jsonl', async () => {
  const home = mkdtempSync(join(tmpdir(), 'seedeep-grok-'));
  const dir = join(home, '.grok', 'sessions', encodeURIComponent('/home/dev/app'), 'sid-1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'summary.json'),
    JSON.stringify({
      info: { id: 'sid-1', cwd: '/home/dev/app' },
      generated_title: 'wire the adapter',
      current_model_id: 'grok-4.6',
      last_active_at: new Date().toISOString(),
    }),
  );
  writeFileSync(join(dir, 'updates.jsonl'), '{}\n');
  const { sessions } = await scanGrokSessions(home, Date.now(), null);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]!.sessionId, 'sid-1');
  assert.equal(sessions[0]!.root, 'grok');
  assert.equal(sessions[0]!.model, 'grok-4.6');
  assert.ok(sessions[0]!.path.endsWith('updates.jsonl'));
});

test('scanCodexSessions lists rollout jsonl files', async () => {
  const home = mkdtempSync(join(tmpdir(), 'seedeep-codex-'));
  const dir = join(home, '.codex', 'sessions', '2026', '09', '16');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'rollout-2026-09-16T13-02-02-sidcodex.jsonl');
  writeFileSync(
    path,
    JSON.stringify({
      timestamp: '2026-09-16T18:02:03.448Z',
      type: 'session_meta',
      payload: { session_id: 'sidcodex', cwd: '/home/dev/app' },
    }) + '\n',
  );
  const { sessions } = await scanCodexSessions(home, Date.now());
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]!.sessionId, 'sidcodex');
  assert.equal(sessions[0]!.root, 'codex');
  assert.equal(sessions[0]!.project, 'app');
});

test('scanGeminiSessions lists session jsonl under tmp/<project>/chats', async () => {
  const home = mkdtempSync(join(tmpdir(), 'seedeep-gem-'));
  const dir = join(home, '.gemini', 'tmp', 'app', 'chats');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'session-2026-04-27T06-33-abc.jsonl'),
    JSON.stringify({ sessionId: 'abc-1', kind: 'main' }) +
      '\n' +
      JSON.stringify({ type: 'user', content: 'hello there', timestamp: '2026-04-27T06:34:14.385Z' }) +
      '\n',
  );
  const { sessions } = await scanGeminiSessions(home, Date.now());
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]!.sessionId, 'abc-1');
  assert.equal(sessions[0]!.root, 'gemini');
});

test('scanAgySessions is empty when no brain transcripts exist', async () => {
  const home = mkdtempSync(join(tmpdir(), 'seedeep-agy-'));
  const { sessions } = await scanAgySessions(home, Date.now());
  assert.equal(sessions.length, 0);
});

test('listGrokOpenSessions reads active_sessions.json and checks pid liveness', async () => {
  const home = mkdtempSync(join(tmpdir(), 'seedeep-gopen-'));
  mkdirSync(join(home, '.grok'), { recursive: true });
  writeFileSync(
    join(home, '.grok', 'active_sessions.json'),
    JSON.stringify([{ session_id: 'live-1', pid: 4242, cwd: '/home/dev/app' }]),
  );
  const rows = await listGrokOpenSessions({ home, isAlive: (pid) => pid === 4242 });
  assert.ok(rows);
  assert.equal(rows!.length, 1);
  assert.equal(rows![0]!.sessionId, 'live-1');
  assert.equal(rows![0]!.status, 'busy');
});
