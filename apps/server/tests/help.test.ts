import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseArgs } from '../src/server/args.ts';
import { usage, versionLine } from '../src/server/help.ts';

test('every spelling of help and version is recognised, and none of them acts', () => {
  for (const word of ['--help', '-h', 'help']) {
    assert.deepEqual(parseArgs([word]), { command: 'help' }, `"${word}" should ask for help`);
  }
  for (const word of ['--version', '-v', 'version']) {
    assert.deepEqual(parseArgs([word]), { command: 'version' }, `"${word}" should ask for the version`);
  }
});

// Asking what the program is must never run it: `seedeep open --help` explains, and does NOT
// start a server and open a browser on the way.
test('help wins wherever it appears, and over version', () => {
  assert.deepEqual(parseArgs(['open', '--help']), { command: 'help' });
  assert.deepEqual(parseArgs(['report', '--session', 'x', '-h']), { command: 'help' });
  assert.deepEqual(parseArgs(['--help', '--version']), { command: 'help' });
});

// The help text is the only place the CLI's surface is written down in one piece; a command or
// flag the parser accepts and the text omits is one nobody can find.
test('the help text names every subcommand the parser accepts', () => {
  const text = usage('1.0.0');
  for (const command of ['open', 'start', 'stop', 'restart', 'report', 'update', 'install-command']) {
    assert.match(text, new RegExp(`seedeep ${command}\\b`), `"${command}" is missing from --help`);
  }
  for (const flag of ['--port', '--host', '--no-open', '--session', '--full', '--offline', '--force']) {
    assert.match(text, new RegExp(flag.replace('-', '\\-')), `"${flag}" is missing from --help`);
  }
  // `claude-code` is deliberately absent: it exists for the command file, not for a person.
  assert.doesNotMatch(text, /seedeep claude-code/);
});

test('--version prints the number and nothing else, so a script can read it', () => {
  assert.equal(versionLine('1.2.3'), '1.2.3');
});

test('an unknown command points at --help rather than listing internals', () => {
  assert.throws(() => parseArgs(['nope']), /try `seedeep --help`/);
  assert.throws(() => parseArgs(['open', '--nope']), /try `seedeep --help`/);
});
