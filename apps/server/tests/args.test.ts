import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseArgs } from '../src/server/args.ts';

test('no args: serve, with the built-in defaults applied later by resolveConfig', () => {
  assert.deepEqual(parseArgs([]), { command: 'serve' });
});

test('--port overrides the port', () => {
  assert.deepEqual(parseArgs(['--port', '9000']), { command: 'serve', port: 9000 });
});

test('--no-open suppresses auto-open', () => {
  assert.deepEqual(parseArgs(['--no-open']), { command: 'serve', open: false });
});

test('--host sets the bind address', () => {
  assert.deepEqual(parseArgs(['--host', '0.0.0.0']), { command: 'serve', host: '0.0.0.0' });
});

test('flags combine regardless of order', () => {
  assert.deepEqual(parseArgs(['--no-open', '--port', '3000', '--host', '192.168.1.1']), {
    command: 'serve',
    port: 3000,
    open: false,
    host: '192.168.1.1',
  });
});

test('a non-numeric --port throws a clear error', () => {
  assert.throws(() => parseArgs(['--port', 'abc']), /--port expects a number/);
});

test('--host without a value throws a clear error', () => {
  assert.throws(() => parseArgs(['--host']), /--host expects a value/);
});

test('open and start take --port', () => {
  assert.deepEqual(parseArgs(['open', '--port', '9000']), { command: 'open', port: 9000 });
  assert.deepEqual(parseArgs(['start', '--port', '9000']), { command: 'start', port: 9000 });
});

test('install-command takes --force', () => {
  assert.deepEqual(parseArgs(['install-command', '--force']), { command: 'install-command', force: true });
});

test('report takes --session and --full', () => {
  assert.deepEqual(parseArgs(['report', '--session', 'abc', '--full']), {
    command: 'report',
    session: 'abc',
    full: true,
  });
  assert.throws(() => parseArgs(['report', '--session']), /--session expects a session id/);
});

test('update takes no flags at all', () => {
  assert.deepEqual(parseArgs(['update']), { command: 'update' });
  assert.throws(() => parseArgs(['update', '--port', '1']), /unknown option "--port" for "update"/);
});

test('restart and stop take --port', () => {
  assert.deepEqual(parseArgs(['restart', '--port', '9000']), { command: 'restart', port: 9000 });
  assert.deepEqual(parseArgs(['stop', '--port', '9000']), { command: 'stop', port: 9000 });
});

// The one subcommand with positional arguments: Claude Code substitutes both, and whatever the
// user typed after /seedeep arrives verbatim. Validating it is `planClaudeCommand`'s job.
test('claude-code keeps its positional arguments intact', () => {
  assert.deepEqual(parseArgs(['claude-code', 'sess-1', 'report', 'full']), {
    command: 'claude-code',
    rest: ['sess-1', 'report', 'full'],
  });
  assert.deepEqual(parseArgs(['claude-code']), { command: 'claude-code', rest: [] });
});

// The whole reason the parser stopped ignoring what it does not know: a build without `open`
// used to accept the word and start a SERVER in the foreground, attached to the caller's shell.
test('an unknown subcommand throws instead of starting the server', () => {
  assert.throws(() => parseArgs(['opne']), /unknown command "opne"/);
});

// `'constructor' in FLAGS` is true, so an inherited key used to pass as a subcommand — and the
// dispatch's fallback then STARTED A SERVER. Measured before the fix.
test('a key inherited from Object.prototype is not a subcommand', () => {
  for (const word of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
    assert.throws(() => parseArgs([word]), /unknown command/, `"${word}" must not parse as a command`);
  }
});

test('an unknown flag throws', () => {
  assert.throws(() => parseArgs(['--unknown']), /unknown option "--unknown"/);
});

test('a flag belonging to another subcommand throws rather than being ignored', () => {
  assert.throws(() => parseArgs(['open', '--no-open']), /unknown option "--no-open" for "open"/);
  assert.throws(() => parseArgs(['install-command', '--port', '1']), /unknown option "--port"/);
});

test('self-update takes the port it will restart, and nothing else', () => {
  assert.deepEqual(parseArgs(['self-update']), { command: 'self-update' });
  assert.deepEqual(parseArgs(['self-update', '--port', '9000']), { command: 'self-update', port: 9000 });
  // No `--offline`: installing without knowing what is out there is not a mode of this command.
  assert.throws(() => parseArgs(['self-update', '--offline']), /unknown option "--offline"/);
});
