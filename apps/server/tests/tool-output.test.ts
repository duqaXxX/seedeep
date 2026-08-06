import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { SessionRecord } from '../src/core/types.ts';
import { startServer } from '../src/server/server.ts';
import { readToolOutput } from '../src/server/tool-output.ts';

// A session on disk, in the layout Claude Code really writes: `<dir>/<uuid>.jsonl` for the
// main session, and its children under `<dir>/<uuid>/subagents/agent-<id>.jsonl`. A
// subagent's tools report in ITS file — reading only the parent would never find them.
function writeSession(mainLines: string[], childLines: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-tool-'));
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
const result = (toolUseId: string, content: unknown) =>
  JSON.stringify({
    type: 'user',
    timestamp: '2026-07-14T10:00:00.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] },
  });
const noise = () =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'thinking' }] } });
const roster = (path: string): SessionRecord[] => [
  {
    sessionId: 'sess-1',
    project: 'demo',
    model: 'claude-sonnet-5',
    lastActivity: 1,
    isActive: false,
    isOpen: false,
    status: null,
    waitingFor: null,
    waitingSince: null,
    subject: null,
    entrypoint: null,
    root: 'cli',
    path,
  },
];

test('readToolOutput returns the verbatim result of a main-session tool', async () => {
  const path = writeSession([noise(), result('toolu_1', 'line one\n  line two'), result('toolu_2', 'other')]);
  const out = await readToolOutput(path, 'toolu_1');
  assert.equal(out?.text, 'line one\n  line two', 'the text is returned as it was, indentation included');
  assert.equal(out?.len, 19);
  assert.equal(out?.truncated, false);
});

test('readToolOutput finds a SUBAGENT tool: its result is in the child file, not the parent', async () => {
  const path = writeSession([noise()], [result('toolu_9', 'what the subagent read')]);
  const out = await readToolOutput(path, 'toolu_9');
  assert.equal(out?.text, 'what the subagent read');
});

test('readToolOutput renders the array form of content (Agent/MCP/some Read)', async () => {
  const path = writeSession([result('toolu_1', [{ type: 'text', text: 'array-shaped output' }])]);
  assert.equal((await readToolOutput(path, 'toolu_1'))?.text, 'array-shaped output');
});

test('readToolOutput caps the text but reports the TRUE length', async () => {
  const path = writeSession([result('toolu_1', 'x'.repeat(5000))]);
  const out = await readToolOutput(path, 'toolu_1', 1000);
  assert.equal(out?.text.length, 1000, 'the text is bounded');
  assert.equal(out?.len, 5000, 'the size reported is the real one, not the capped one');
  assert.equal(out?.truncated, true);
});

test('readToolOutput anonymizes: a real home path never leaves the process', async () => {
  const home = '/Us' + 'ers/carol/secret/app.ts'; // assembled: a literal home path is a commit gate
  const path = writeSession([result('toolu_1', 'read ' + home)]);
  const out = await readToolOutput(path, 'toolu_1');
  assert.equal(out?.text, 'read ~/secret/app.ts');
});

test('readToolOutput: an unknown id, and a tool that has not reported yet, are null', async () => {
  const path = writeSession([result('toolu_1', 'x')]);
  assert.equal(await readToolOutput(path, 'toolu_missing'), null);
});

test('readToolOutput survives a malformed line before the tool it is looking for', async () => {
  const path = writeSession(['{not json', result('toolu_1', 'still found')]);
  assert.equal((await readToolOutput(path, 'toolu_1'))?.text, 'still found');
});

test('GET /api/tool-output returns the tool result; unknown session or tool → 404', async () => {
  const path = writeSession([result('toolu_1', 'the output')]);
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => roster(path),
    port: 0,
  });
  try {
    const res = await fetch(`${srv.url}/api/tool-output?sessionId=sess-1&toolUseId=toolu_1`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { toolUseId: 'toolu_1', text: 'the output', len: 10, truncated: false });

    assert.equal((await fetch(`${srv.url}/api/tool-output?sessionId=nope&toolUseId=toolu_1`)).status, 404);
    assert.equal((await fetch(`${srv.url}/api/tool-output?sessionId=sess-1&toolUseId=nope`)).status, 404);
    assert.equal(
      (await fetch(`${srv.url}/api/tool-output?sessionId=sess-1`)).status,
      404,
      'no tool id is not a request for "some tool"',
    );
  } finally {
    srv.stop();
  }
});
