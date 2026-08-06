import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

// The anti-leak gate is the one check whose failure is irreversible — a secret pushed once lives
// in the history forever. So it gets tested in both directions: it must fire on real leaks AND
// stay quiet on the shapes that only look like them, or it becomes a gate people bypass.
//
// Every sample below is assembled from fragments ('/Us' + 'ers/...') for a reason: written whole,
// they would be leaks themselves and the author's own commit hook would block this file.
const SCRIPT = join(import.meta.dirname, 'scan-sensitive-diff.sh');

/** Run the scan over `diffBody` as if it were the added side of a diff; returns its exit code. */
function scan(diffBody: string): number {
  const diff = `--- a/f.ts\n+++ b/f.ts\n@@ -1 +1 @@\n${diffBody}\n`;
  return spawnSync('bash', [SCRIPT], { input: diff, encoding: 'utf8' }).status ?? -1;
}

test('an ordinary diff passes', () => {
  assert.equal(scan('+const total = calls.length;'), 0);
});

test('a real home path is blocked', () => {
  assert.equal(scan('+const p = "/Us' + 'ers/carol/Documents/notes";'), 1);
  assert.equal(scan('+const p = "/ho' + 'me/carol/notes";'), 1);
});

test('the neutral placeholder home is allowed', () => {
  assert.equal(scan('+const p = "/ho' + 'me/dev/seedeep";'), 0);
});

test('a personal email is blocked, a noreply address is not', () => {
  assert.equal(scan('+// contact carol' + '@' + 'gmail.com'), 1);
  assert.equal(scan('+  author = "1234+carol' + '@' + 'users.noreply.github.com"'), 0);
});

test('an asset filename that looks like an address is allowed', () => {
  assert.equal(scan('+  src: "icons/128x128' + '@' + '2x.png",'), 0);
});

test('secret markers are blocked', () => {
  assert.equal(scan('+const t = "ghp_' + 'a'.repeat(30) + '";'), 1);
  assert.equal(scan('+-----BEG' + 'IN RSA PRIVATE KEY-----'), 1);
});

test('an issue-tracker reference is blocked', () => {
  assert.equal(scan('+// fixes SE' + 'E-123'), 1);
  assert.equal(scan('+// see https://lin' + 'ear.app/x/issue/y'), 1);
});

test('only ADDED lines are scanned — a removed leak is not a new one', () => {
  assert.equal(scan('-const p = "/Us' + 'ers/carol/notes";'), 0);
});

test('the script does not match its own patterns', () => {
  // The patterns are bracketed (/[U]sers) precisely so that adding this script to the repo does
  // not trip the gate it implements. If someone "tidies" the brackets away, this goes red.
  const self = readFileSync(SCRIPT, 'utf8')
    .split('\n')
    .map((l) => '+' + l)
    .join('\n');
  assert.equal(scan(self), 0);
});
