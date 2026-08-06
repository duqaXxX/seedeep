import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openBrowser, openCommand } from '../src/server/browser.ts';

test('darwin uses `open`', () => {
  assert.deepEqual(openCommand('darwin', 'http://localhost:44842'), ['open', 'http://localhost:44842']);
});

test('linux uses `xdg-open`', () => {
  assert.deepEqual(openCommand('linux', 'http://x'), ['xdg-open', 'http://x']);
});

test('win32 uses cmd start', () => {
  assert.deepEqual(openCommand('win32', 'http://x'), ['cmd', '/c', 'start', '', 'http://x']);
});

test('openBrowser passes the resolved argv to the injected runner', () => {
  const calls: string[][] = [];
  openBrowser('http://localhost:44842', (argv) => {
    calls.push(argv);
  });
  assert.equal(calls.length, 1);
  const argv = calls[0]!;
  assert.equal(argv[argv.length - 1], 'http://localhost:44842');
});
