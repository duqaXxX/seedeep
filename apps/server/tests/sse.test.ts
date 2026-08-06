import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sseFrame } from '../src/server/sse.ts';

test('sseFrame emits id/event/data lines and a blank-line terminator', () => {
  const frame = sseFrame(7, 'usage', { sessionId: 'A', fill: 100 });
  assert.equal(frame, 'id: 7\nevent: usage\ndata: {"sessionId":"A","fill":100}\n\n');
});

test('sseFrame terminates every frame with exactly one blank line', () => {
  const frame = sseFrame(1, 'session-added', 'B');
  assert.ok(frame.endsWith('\n\n'));
  assert.ok(!frame.endsWith('\n\n\n'));
});

test('sseFrame strips CR/LF from the event name so it cannot split the frame', () => {
  const frame = sseFrame(3, 'usage\nevent: injected', { x: 1 });
  // exactly one `event:` line; no injected second field
  assert.equal(frame.match(/^event:/gm)?.length, 1);
  assert.equal(frame, 'id: 3\nevent: usageevent: injected\ndata: {"x":1}\n\n');
});
