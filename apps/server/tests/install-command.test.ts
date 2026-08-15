import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  claudeCommandsDir,
  commandFileContents,
  commandFilePath,
  installCommand,
  ownershipOf,
  pathNotice,
  pathState,
  refreshOwnedCommandFile,
  staleCommandNotice,
} from '../src/server/install-command.ts';

const home = () => mkdtempSync(join(tmpdir(), 'seedeep-install-'));

test("the command file goes under Claude Code's own directory", () => {
  assert.equal(claudeCommandsDir('/home/dev', {}), '/home/dev/.claude/commands');
  assert.equal(commandFilePath('/home/dev', {}), '/home/dev/.claude/commands/seedeep.md');
});

test('CLAUDE_CONFIG_DIR moves it', () => {
  assert.equal(claudeCommandsDir('/home/dev', { CLAUDE_CONFIG_DIR: '/elsewhere/cc' }), '/elsewhere/cc/commands');
});

// The file is a PROMPT: a fenced ```bash block would never run. Only the !`…` form does, and the
// frontmatter is what keeps the command manual and pre-approved.
test('the command dispatches through the shell-execution syntax, with both substitutions', () => {
  const body = commandFileContents();
  assert.match(body, /!`seedeep claude-code \$\{CLAUDE_SESSION_ID\} \$ARGUMENTS`/);
  assert.match(body, /^disable-model-invocation: true$/m);
  assert.match(body, /^allowed-tools: Bash\(seedeep:\*\)$/m);
  assert.doesNotMatch(body, /```bash/);
});

// A template cannot branch, so the file must not try: one fixed line, and seedeep decides.
test('the command file contains exactly one shell execution', () => {
  assert.equal(commandFileContents().match(/!`/g)?.length, 1);
});

test('a first install writes the file', async () => {
  const h = home();
  const result = await installCommand({ home: h, env: {} });
  assert.equal(result.kind, 'written');
  assert.equal(readFileSync(commandFilePath(h, {}), 'utf8'), commandFileContents());
});

test('installing again changes nothing and says so', async () => {
  const h = home();
  await installCommand({ home: h, env: {} });
  assert.equal((await installCommand({ home: h, env: {} })).kind, 'unchanged');
});

test('a file the user edited is never overwritten silently', async () => {
  const h = home();
  const path = commandFilePath(h, {});
  await mkdir(dirname(path), { recursive: true });
  writeFileSync(path, '# mine, hands off\n');
  assert.equal((await installCommand({ home: h, env: {} })).kind, 'differs');
  assert.equal(readFileSync(path, 'utf8'), '# mine, hands off\n');
});

// The distinction the first version of this could not make: it saw only that the bytes differed
// and refused both cases, so every upgrade needed --force.
test('a file an older seedeep wrote is recognised as ours, and updated in place', async () => {
  const h = home();
  const path = commandFilePath(h, {});
  await mkdir(dirname(path), { recursive: true });
  writeFileSync(path, commandFileContents('0.0.1'));

  const owner = ownershipOf(commandFileContents('0.0.1'));
  assert.deepEqual(owner, { kind: 'ours', version: '0.0.1', stale: true });

  const result = await installCommand({ home: h, env: {} });
  assert.equal(result.kind, 'updated');
  assert.equal(result.kind === 'updated' ? result.from : '', '0.0.1');
  assert.equal(readFileSync(path, 'utf8'), commandFileContents());
});

test('one edited character makes the file theirs, marker or not', () => {
  const edited = commandFileContents().replace('do nothing else', 'do whatever you like');
  assert.deepEqual(ownershipOf(edited), { kind: 'theirs' });
  assert.deepEqual(ownershipOf('# hand written\n'), { kind: 'theirs' });
  assert.equal(ownershipOf(commandFileContents()).kind, 'ours');
});

test('an old command file is announced on invocation; a current or foreign one is not', async () => {
  const h = home();
  const path = commandFilePath(h, {});
  assert.equal(await staleCommandNotice(h, {}), null, 'nothing installed says nothing');

  await mkdir(dirname(path), { recursive: true });
  writeFileSync(path, commandFileContents('0.0.1'));
  assert.match((await staleCommandNotice(h, {})) ?? '', /written by seedeep 0\.0\.1.*install-command/);

  writeFileSync(path, commandFileContents());
  assert.equal(await staleCommandNotice(h, {}), null);

  writeFileSync(path, '# mine\n');
  assert.equal(await staleCommandNotice(h, {}), null, "the user's file is not seedeep's business");
});

// `/seedeep` calls `seedeep` by name, so install-command succeeding proves nothing on its own.
test('the PATH is checked against the executable actually running', () => {
  const bin = '/usr/local/bin/seedeep';
  const same = (p: string) => p;
  assert.deepEqual(pathState({ which: () => bin, execPath: bin, fromSource: false, realpath: same }), { kind: 'ok' });
  assert.deepEqual(pathState({ which: () => null, execPath: bin, fromSource: false, realpath: same }), {
    kind: 'absent',
  });
  assert.deepEqual(pathState({ which: () => '/opt/other/seedeep', execPath: bin, fromSource: false, realpath: same }), {
    kind: 'other',
    found: '/opt/other/seedeep',
  });
  assert.deepEqual(pathState({ which: () => null, execPath: bin, fromSource: true, realpath: same }), {
    kind: 'from-source',
  });
});

// Windows has no symlink for `realpath` to follow: npm writes a `.cmd` beside the package and lets
// it exec the binary, so the comparison above always failed and EVERY npm install on Windows was
// told its own launcher was a different executable. Measured on Windows 11, 2026-08-14, with these
// two exact paths.
test('the npm launcher on Windows is this executable, not another seedeep', () => {
  const same = (p: string) => p;
  const shim = 'C:\\Users\\dev\\AppData\\Roaming\\npm\\seedeep.cmd';
  const exe = 'C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\seedeep\\bin\\seedeep.exe';
  const at = (found: string, execPath: string, platform: string) =>
    pathState({ which: () => found, execPath, fromSource: false, realpath: same, platform });

  assert.deepEqual(at(shim, exe, 'win32'), { kind: 'ok' });

  // The case the warning exists for survives: a downloaded binary run from elsewhere, with an npm
  // install on the PATH, really is two seedeeps.
  assert.deepEqual(at(shim, 'C:\\Users\\dev\\Downloads\\seedeep-server.exe', 'win32'), {
    kind: 'other',
    found: shim,
  });

  // The package's OWN directory is required. A looser `node_modules\` prefix would accept another
  // package's binary, and at a drive root it degenerates to `c:\node_modules\`.
  assert.deepEqual(at(shim, 'C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\other\\bin\\seedeep.exe', 'win32'), {
    kind: 'other',
    found: shim,
  });
  assert.deepEqual(at('C:\\seedeep.cmd', 'C:\\node_modules\\anything\\seedeep.exe', 'win32'), {
    kind: 'other',
    found: 'C:\\seedeep.cmd',
  });

  // A launcher at a drive root must not vouch for an executable elsewhere on the drive either.
  assert.deepEqual(at('C:\\seedeep.cmd', 'C:\\Users\\dev\\Downloads\\seedeep-server.exe', 'win32'), {
    kind: 'other',
    found: 'C:\\seedeep.cmd',
  });

  // Nothing about this is portable: the same shape on macOS is not a launcher and must still warn.
  assert.deepEqual(at(shim, exe, 'darwin'), { kind: 'other', found: shim });
});

// A package manager puts a LINK on the PATH, never the file: measured, `~/.bun/bin/seedeep` points
// into `~/.bun/install/global/node_modules/…`. Comparing the two spellings warned every npm and bun
// install that its own binary was "a different executable" — the normal case, and a false alarm.
test('a symlinked binary on PATH is recognised as this one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-path-'));
  const real = join(dir, 'seedeep-server_x_macos-arm64');
  const link = join(dir, 'seedeep');
  writeFileSync(real, '#!/bin/sh\n');
  symlinkSync(real, link);
  assert.deepEqual(pathState({ which: () => link, execPath: real, fromSource: false }), { kind: 'ok' });
});

test('the PATH notice says what to do, and says nothing when there is nothing to say', () => {
  const bin = '/home/dev/Downloads/seedeep-server';
  assert.equal(pathNotice({ kind: 'ok' }, bin), null);
  assert.match(pathNotice({ kind: 'absent' }, bin) ?? '', /command not found.*mv \/home\/dev\/Downloads/s);
  assert.match(pathNotice({ kind: 'other', found: '/x/seedeep' }, bin) ?? '', /\/x\/seedeep.*will run that one/s);
});

// The fix for "not on PATH" is a different thing per channel, and telling an npm user to `mv` a
// file out of node_modules would break their next update.
test('the PATH advice never crosses channels', () => {
  const inNpm = '/usr/lib/node_modules/seedeep/bin/seedeep.exe';
  const npm = pathNotice({ kind: 'absent' }, inNpm, { kind: 'npm', command: 'npm i -g seedeep@latest' }) ?? '';
  assert.match(npm, /npm prefix -g/);
  assert.doesNotMatch(npm, /\bmv\b/);

  const bun = pathNotice({ kind: 'absent' }, inNpm, { kind: 'bun', command: 'bun install -g seedeep --trust' }) ?? '';
  assert.match(bun, /bun pm bin -g/);
  assert.doesNotMatch(bun, /\bmv\b/);

  const file = pathNotice({ kind: 'absent' }, '/home/dev/bin/seedeep', { kind: 'download', command: null }) ?? '';
  assert.match(file, /mv \/home\/dev\/bin\/seedeep/);
  assert.doesNotMatch(file, /npm|bun/);
});

// The auto-refresh: it may update a file seedeep owns, and must never CREATE one — running
// install-command once is the permission, and this only keeps its result current.
test('the server start refreshes a stale command file, and only that', async () => {
  const h = home();
  const path = commandFilePath(h, {});
  assert.equal(await refreshOwnedCommandFile(h, {}), null, 'nothing installed stays nothing installed');
  assert.equal(existsSync(path), false, 'it must never create the file');

  await mkdir(dirname(path), { recursive: true });
  writeFileSync(path, commandFileContents('0.0.1'));
  assert.match((await refreshOwnedCommandFile(h, {})) ?? '', /updated the \/seedeep command/);
  assert.equal(readFileSync(path, 'utf8'), commandFileContents());

  assert.equal(await refreshOwnedCommandFile(h, {}), null, 'a current file is left alone, silently');

  writeFileSync(path, '# mine\n');
  assert.equal(await refreshOwnedCommandFile(h, {}), null);
  assert.equal(readFileSync(path, 'utf8'), '# mine\n', "a user's file is never rewritten");
});

test('--force is what replaces it', async () => {
  const h = home();
  const path = commandFilePath(h, {});
  await mkdir(dirname(path), { recursive: true });
  writeFileSync(path, '# mine, hands off\n');
  assert.equal((await installCommand({ home: h, force: true, env: {} })).kind, 'written');
  assert.equal(readFileSync(path, 'utf8'), commandFileContents());
});
