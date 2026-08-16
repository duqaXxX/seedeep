import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Standing, UpdateStatus } from '../src/server/update-check.ts';
import { type Channel, detectChannel, updateAdvice } from '../src/server/update-cmd.ts';

/** A check result, as `updateStatus` would have returned it. */
const status = (
  current: string,
  latest: string | null,
  standing: Standing,
  reason: string | null = null,
): UpdateStatus => ({
  current,
  latest,
  standing,
  checkedAt: latest ? '2026-08-05T12:00:00.000Z' : null,
  reason,
});

const at = (current: string) => status(current, current, 'current');

// Measured on this machine: `~/.bun/bin/seedeep` is a symlink into the global node_modules, so the
// channel is read from the RESOLVED path — the link's own spelling says nothing about the channel.
test('the channel comes from where the executable actually lives', () => {
  assert.equal(detectChannel('/home/dev/.bun/install/global/node_modules/seedeep/bin/seedeep.exe', false).kind, 'bun');
  assert.equal(detectChannel('/opt/homebrew/lib/node_modules/seedeep/bin/seedeep.exe', false).kind, 'npm');
  assert.equal(detectChannel('/home/dev/Downloads/seedeep-server_1.0.0_macos-arm64', false).kind, 'download');
  assert.equal(detectChannel('/home/dev/.bun/bin/bun', true).kind, 'checkout');
});

// Measured 2026-08-09 (bun 1.3.13): `BUN_INSTALL=<prefix> bun install -g` writes to
// `<prefix>/install/global/node_modules/<pkg>` — the LAYOUT is bun's, the directory NAME is the
// user's. Matching `.bun/` alone handed a bun install npm's command, which `seedeep self-update`
// then RUNS. npm cannot produce this segment: its own layout is `<prefix>/lib/node_modules/<pkg>`.
test("bun's global layout is the test, not the default prefix name", () => {
  const custom = '/home/dev/tools/bun-prefix/install/global/node_modules/seedeep/bin/seedeep.exe';
  assert.equal(detectChannel(custom, false).kind, 'bun');
  assert.equal(detectChannel(custom, false).command, 'bun install -g seedeep --trust');
  assert.equal(
    detectChannel('C:\\Users\\dev\\tools\\bunp\\install\\global\\node_modules\\seedeep\\bin\\seedeep.exe', false).kind,
    'bun',
  );
  // The npm prefix a name-based test would trip on: `lib/` sits between it and the packages.
  assert.equal(detectChannel('/opt/install/global/lib/node_modules/seedeep/bin/seedeep.exe', false).kind, 'npm');
});

test('a package-manager install prints one command to run', () => {
  const bun = detectChannel('/home/dev/.bun/install/global/node_modules/seedeep/bin/seedeep.exe', false);
  const npm = detectChannel('/usr/lib/node_modules/seedeep/bin/seedeep.exe', false);
  assert.equal(bun.command, 'bun install -g seedeep --trust');
  assert.equal(npm.command, 'npm i -g seedeep@latest');
});

test('a downloaded executable is updated by replacing the file, and says where from', () => {
  const advice = updateAdvice({ kind: 'download', command: null }, '/home/dev/bin/seedeep', at('1.0.0'));
  assert.match(advice, /releases\/latest/);
  assert.match(advice, /replacing this file/);
});

// Each channel hears about its own channel and no other: an npm user pointed at the release page
// would download a standalone binary beside the one npm manages, and `--trust` is bun's caveat.
test('no channel is told about another channel', () => {
  const bun = updateAdvice(
    { kind: 'bun', command: 'bun install -g seedeep --trust' },
    '/home/dev/.bun/install/global/node_modules/seedeep/bin/seedeep.exe',
    at('1.0.0'),
  );
  assert.match(bun, /--trust` is not optional/);
  assert.doesNotMatch(bun, /releases\/latest/);
  assert.doesNotMatch(bun, /npm i -g/);

  const npm = updateAdvice(
    { kind: 'npm', command: 'npm i -g seedeep@latest' },
    '/usr/lib/node_modules/seedeep/bin/seedeep.exe',
    at('1.0.0'),
  );
  assert.match(npm, /npm i -g seedeep@latest/);
  assert.doesNotMatch(npm, /releases\/latest/);
  assert.doesNotMatch(npm, /--trust/);

  const file = updateAdvice({ kind: 'download', command: null }, '/home/dev/bin/seedeep', at('1.0.0'));
  assert.doesNotMatch(file, /npm i -g|bun install -g|--trust/);
});

test('the standing becomes the line the user reads', () => {
  const channel: Channel = { kind: 'checkout', command: null };
  assert.match(updateAdvice(channel, '/bin/x', status('1.0.0', '1.2.0', 'behind')), /npm has 1\.2\.0/);
  assert.match(updateAdvice(channel, '/bin/x', status('1.2.0', '1.2.0', 'current')), /nothing to update/);
  assert.match(updateAdvice(channel, '/bin/x', status('1.3.0', '1.2.0', 'ahead')), /a build of your own/);
});

// A machine with no network still deserves to be told how it would update — the check is a
// convenience, and must never be what makes the command look broken.
test('an unreachable registry is an outcome, never an error', () => {
  const advice = updateAdvice(
    { kind: 'download', command: null },
    '/bin/seedeep',
    status('1.0.0', null, 'unknown', 'no network'),
  );
  assert.match(advice, /still holds/);
  assert.match(advice, /no network/);
});

// The cache keeps the last known version across an outage, so the advice stays useful offline.
test('yesterday’s answer wins over today’s outage', () => {
  const advice = updateAdvice(
    { kind: 'npm', command: 'npm i -g seedeep@latest' },
    '/usr/lib/node_modules/seedeep/bin/seedeep.exe',
    status('1.0.0', '1.2.0', 'behind', 'no network'),
  );
  assert.match(advice, /npm has 1\.2\.0/);
  assert.doesNotMatch(advice, /still holds/);
});

test('every channel says how often the network is asked, and that a restart is needed', () => {
  const channels: Channel[] = [
    { kind: 'bun', command: 'bun install -g seedeep --trust' },
    { kind: 'npm', command: 'npm i -g seedeep@latest' },
    { kind: 'download', command: null },
    { kind: 'checkout', command: null },
  ];
  for (const c of channels) {
    const advice = updateAdvice(c, '/home/dev/bin/seedeep', at('1.0.0'));
    // The sentence has to match what `runUpdate` DOES: it passes `force`, so a typed verb asks the
    // registry every time. The advice used to say "at most once an hour", which is the cache's rule
    // for every OTHER surface and the opposite of this one's.
    assert.match(advice, /only thing seedeep asks the network/);
    assert.match(advice, /A verb you type asks it now/);
    assert.match(advice, /at most once an hour/);
    assert.match(advice, /keeps the old code until `seedeep restart`/);
  }
});

// The pointer is named only where it works. `planSelfUpdate` refuses a download, a checkout and
// Windows, and an advice line pointing at a command that answers "I cannot do that here" is worse
// than saying nothing.
test('self-update is offered exactly where it can run', () => {
  const bun: Channel = { kind: 'bun', command: 'bun install -g seedeep --trust' };
  assert.match(updateAdvice(bun, '/x', at('1.0.0'), false, 'darwin'), /seedeep self-update/);
  assert.match(
    updateAdvice({ kind: 'npm', command: 'npm i -g seedeep@latest' }, '/x', at('1.0.0'), false, 'linux'),
    /seedeep self-update/,
  );
  assert.doesNotMatch(updateAdvice(bun, '/x', at('1.0.0'), false, 'win32'), /seedeep self-update/);
  assert.doesNotMatch(
    updateAdvice({ kind: 'download', command: null }, '/x', at('1.0.0'), false, 'darwin'),
    /seedeep self-update/,
  );
  assert.doesNotMatch(
    updateAdvice({ kind: 'checkout', command: null }, '/x', at('1.0.0'), false, 'darwin'),
    /seedeep self-update/,
  );
});

test('--offline says so rather than pretending it checked', () => {
  const channel: Channel = { kind: 'checkout', command: null };
  assert.match(updateAdvice(channel, '/bin/x', status('1.0.0', '1.2.0', 'behind'), true), /--offline/);
  assert.match(updateAdvice(channel, '/bin/x', status('1.0.0', '1.2.0', 'behind'), false), /npm has 1\.2\.0/);
});
