import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseArgs, SUBCOMMANDS } from '../src/server/args.ts';
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
// Read from the PARSER, never from a second list here: the hand-written one silently stayed true
// while `self-update` was added and left undocumented — a list that cannot notice is not a test.
const UNDOCUMENTED = new Set(['serve', 'help', 'version', 'claude-code']);

test('the help text names every subcommand the parser accepts', () => {
  const text = usage('1.0.0');
  for (const command of SUBCOMMANDS.filter((c) => !UNDOCUMENTED.has(c))) {
    assert.match(text, new RegExp(`seedeep ${command}\\b`), `"${command}" is missing from --help`);
  }
  for (const flag of ['--port', '--host', '--no-open', '--session', '--full', '--offline', '--force']) {
    assert.match(text, new RegExp(flag.replace('-', '\\-')), `"${flag}" is missing from --help`);
  }
  // `claude-code` is deliberately absent: it exists for the command file, not for a person.
  assert.doesNotMatch(text, /seedeep claude-code/);
});

// `--help` is only found by someone who already has the program running. The public docs are what
// the other reader has, so the same list lives in `install.md` — and a second copy is worth having
// only if something notices when it stops matching the first.
const INSTALL_DOC = join(import.meta.dirname, '..', '..', '..', 'docs', 'install.md');

/** The body of one `## `-level section of a markdown file, heading excluded. */
function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(`\n## ${heading}\n`);
  assert.notEqual(start, -1, `install.md has no "## ${heading}" section`);
  const rest = markdown.slice(start + heading.length + 5);
  const end = rest.indexOf('\n## ');
  return end === -1 ? rest : rest.slice(0, end);
}

test('the commands section of install.md names every subcommand and flag', () => {
  const commands = section(readFileSync(INSTALL_DOC, 'utf8'), 'The commands');
  for (const command of SUBCOMMANDS.filter((c) => !UNDOCUMENTED.has(c))) {
    assert.match(commands, new RegExp(`\`seedeep ${command}\``), `"${command}" is missing from install.md`);
  }
  for (const flag of ['--port', '--host', '--no-open', '--session', '--full', '--offline', '--force']) {
    assert.match(commands, new RegExp(`\`${flag}`), `"${flag}" is missing from install.md`);
  }
  // The other direction, which is the one a rename breaks: a table row for a word the parser would
  // reject sends the reader to `unknown command`.
  for (const [, word] of commands.matchAll(/`seedeep ([a-z][a-z-]*)`/g)) {
    assert.ok(SUBCOMMANDS.includes(word!), `install.md documents "seedeep ${word}", which is not a subcommand`);
  }
});

test('--version prints the number and nothing else, so a script can read it', () => {
  assert.equal(versionLine('1.2.3'), '1.2.3');
});

test('an unknown command points at --help rather than listing internals', () => {
  assert.throws(() => parseArgs(['nope']), /try `seedeep --help`/);
  assert.throws(() => parseArgs(['open', '--nope']), /try `seedeep --help`/);
});
