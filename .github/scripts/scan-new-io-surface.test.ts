import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';

// This gate is only worth having if it is quiet. A scan that flags RegExp.prototype.exec, or a
// change to a file that has legitimately talked to the network since it was written, is a scan
// somebody disables on a deadline. So it is tested in both directions: it must fire on a genuinely
// new surface AND stay silent on the shapes that merely resemble one.

const SCRIPT = join(import.meta.dirname, 'scan-new-io-surface.sh');

/** Run the scan over one added/removed line attributed to `path`; returns its exit code. */
function scan(path: string, body: string): number {
  const diff = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${body}\n`;
  return spawnSync('bash', [SCRIPT], { input: diff, encoding: 'utf8' }).status ?? -1;
}

const SRC = 'apps/server/src/server/parse-grok.ts';

test('an ordinary added line passes', () => {
  assert.equal(scan(SRC, '+  const total = events.length;'), 0);
});

test('a new fetch in a file that had none is blocked', () => {
  assert.equal(scan(SRC, '+  const r = await fetch(url);'), 1);
});

test('the same call in a file that already holds one is allowed', () => {
  assert.equal(scan('apps/server/src/server/server.ts', '+  const r = await fetch(url);'), 0);
  assert.equal(scan('apps/server/src/client/auth.ts', '+  const r = await fetch(url);'), 0);
});

test('spawning a process is blocked', () => {
  assert.equal(scan(SRC, "+import { execFile } from 'node:child_process';"), 1);
  assert.equal(scan(SRC, '+  const p = Bun.spawn([bin]);'), 1);
});

test('dynamic evaluation is blocked', () => {
  assert.equal(scan(SRC, '+  return eval(' + 'src);'), 1);
  assert.equal(scan(SRC, '+  const f = new Function("return 1");'), 1);
});

// The false positive that would have retired the gate within a week: 37 call sites in this
// codebase are RegExp.prototype.exec, which has nothing to do with running a program.
test('RegExp.prototype.exec is not a process', () => {
  assert.equal(scan(SRC, '+  const m = RE.exec(line);'), 0);
  assert.equal(scan(SRC, '+  while ((m = re.exec(text)) !== null) {'), 0);
});

test('only apps/server/src is in scope', () => {
  assert.equal(scan('apps/server/tests/sources.test.ts', '+  const r = await fetch(url);'), 0);
  assert.equal(scan('apps/server/scripts/live-check.ts', '+  const r = await fetch(url);'), 0);
  assert.equal(scan('apps/tray/ui/src/main.ts', '+  const r = await fetch(url);'), 0);
});

test('a REMOVED call is not a new surface', () => {
  assert.equal(scan(SRC, '-  const r = await fetch(url);'), 0);
});

test('a finding is attributed to the file it is in, not the previous one', () => {
  const allowed = 'apps/server/src/server/server.ts';
  const diff =
    `diff --git a/${allowed} b/${allowed}\n--- a/${allowed}\n+++ b/${allowed}\n@@ -1 +1 @@\n` +
    `+  const a = await fetch(one);\n` +
    `diff --git a/${SRC} b/${SRC}\n--- a/${SRC}\n+++ b/${SRC}\n@@ -1 +1 @@\n` +
    `+  const b = await fetch(two);\n`;
  const r = spawnSync('bash', [SCRIPT], { input: diff, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /parse-grok\.ts/);
  assert.doesNotMatch(r.stderr, /server\.ts/);
});

test('a deleted file does not carry its lines into the next diff', () => {
  const diff =
    `diff --git a/${SRC} b/${SRC}\n--- a/${SRC}\n+++ /dev/null\n@@ -1 +0 @@\n` + `+  const r = await fetch(url);\n`;
  assert.equal(spawnSync('bash', [SCRIPT], { input: diff, encoding: 'utf8' }).status, 0);
});
