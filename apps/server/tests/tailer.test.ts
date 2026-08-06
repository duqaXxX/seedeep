import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { initTailState, readNewLines } from '../src/server/tailer.ts';

function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-tail-'));
  return join(dir, 'session.jsonl');
}

test('reads only new complete lines from the offset', async () => {
  const p = tmpFile();
  writeFileSync(p, 'a\nb\n');
  const s = initTailState();
  let r = await readNewLines(p, s);
  assert.deepEqual(r.lines, ['a', 'b']);
  appendFileSync(p, 'c\n');
  r = await readNewLines(p, r.state);
  assert.deepEqual(r.lines, ['c']);
});

test('skips when nothing changed (mtime+size)', async () => {
  const p = tmpFile();
  writeFileSync(p, 'a\n');
  let r = await readNewLines(p, initTailState());
  assert.deepEqual(r.lines, ['a']);
  r = await readNewLines(p, r.state);
  assert.deepEqual(r.lines, []); // unchanged
});

test('holds a trailing partial line until it completes', async () => {
  const p = tmpFile();
  writeFileSync(p, 'comp\npar'); // "par" has no newline yet
  let r = await readNewLines(p, initTailState());
  assert.deepEqual(r.lines, ['comp']); // partial withheld
  appendFileSync(p, 'tial\n');
  r = await readNewLines(p, r.state);
  assert.deepEqual(r.lines, ['partial']); // rejoined
});

test('resets to start when the file shrinks', async () => {
  const p = tmpFile();
  writeFileSync(p, 'x\ny\nz\n');
  let r = await readNewLines(p, initTailState());
  assert.equal(r.lines.length, 3);
  writeFileSync(p, 'new\n'); // rewritten smaller
  r = await readNewLines(p, r.state);
  assert.deepEqual(r.lines, ['new']);
});

test('a shrink is REPORTED, not just absorbed', async () => {
  const p = tmpFile();
  writeFileSync(p, 'x\ny\nz\n');
  let r = await readNewLines(p, initTailState());
  assert.equal(r.restarted, false, 'a first read is not a restart');
  writeFileSync(p, 'new\n');
  r = await readNewLines(p, r.state);
  // The caller owns a number derived from the offset (the watcher's `seq`); it can
  // only reset it in step if this call SAYS it started over.
  assert.equal(r.restarted, true);
  assert.deepEqual(r.lines, ['new']);
  r = await readNewLines(p, r.state);
  assert.equal(r.restarted, false, 'the restart is reported once, not latched');
});

test('a file emptied to zero bytes leaves a state that points at zero', async () => {
  const p = tmpFile();
  writeFileSync(p, 'x\ny\nz\n');
  let r = await readNewLines(p, initTailState());
  writeFileSync(p, '');
  r = await readNewLines(p, r.state);
  assert.deepEqual(r.lines, []);
  assert.equal(r.restarted, true);
  // Not the stale pre-truncation offset: a caller that trusts `state.offset` as a
  // position would otherwise carry a number the file cannot justify.
  assert.equal(r.state.offset, 0);
});

test('missing file yields no lines and does not throw', async () => {
  const r = await readNewLines('/no/such/seedeep/file.jsonl', initTailState());
  assert.deepEqual(r.lines, []);
});
