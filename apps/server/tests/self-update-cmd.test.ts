import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  runSelfUpdate,
  runToCompletion,
  type SelfUpdateDeps,
  selfUpdatePreview,
} from '../src/server/self-update-cmd.ts';
import type { Standing, UpdateStatus } from '../src/server/update-check.ts';
import { type Channel, planSelfUpdate } from '../src/server/update-cmd.ts';

const BUN: Channel = { kind: 'bun', command: 'bun install -g seedeep --trust' };
const NPM: Channel = { kind: 'npm', command: 'npm i -g seedeep@latest' };

const status = (current: string, latest: string | null, standing: Standing): UpdateStatus => ({
  current,
  latest,
  standing,
  checkedAt: latest ? '2026-08-09T12:00:00.000Z' : null,
  reason: null,
});

/**
 * A self-update that would succeed: behind by one version, bun on macOS, one server running, and an
 * install that really replaces the executable. Each test breaks exactly one of those.
 */
function deps(over: Partial<SelfUpdateDeps> = {}) {
  const logged: string[] = [];
  const errored: string[] = [];
  const installed: string[][] = [];
  let restarts = 0;
  const base: SelfUpdateDeps = {
    channel: BUN,
    platform: 'darwin',
    status: async () => status('1.0.0', '1.1.0', 'behind'),
    install: async (argv) => {
      installed.push(argv);
      return 0;
    },
    installedVersion: async () => '1.1.0',
    servers: async () => [{ pid: 100, baseUrl: 'http://localhost:44842' }],
    restart: async () => {
      restarts++;
      return 0;
    },
    log: (l) => logged.push(l),
    error: (l) => errored.push(l),
    ...over,
  };
  return { base, logged, errored, installed, restarts: () => restarts };
}

test('a package-manager install on macOS or Linux runs the channel’s own command, split as argv', () => {
  const bun = planSelfUpdate(BUN, 'darwin');
  const npm = planSelfUpdate(NPM, 'linux');
  assert.deepEqual(bun.kind === 'install' ? bun.argv : null, ['bun', 'install', '-g', 'seedeep', '--trust']);
  assert.deepEqual(npm.kind === 'install' ? npm.argv : null, ['npm', 'i', '-g', 'seedeep@latest']);
});

// Davide's scope (2026-08-09): macOS and Linux only. The reason is the platform's, not seedeep's,
// so the refusal hands back the three commands that do work there.
test('Windows is refused, with the sequence that works there instead', () => {
  const plan = planSelfUpdate(BUN, 'win32');
  assert.equal(plan.kind, 'refused');
  const reason = plan.kind === 'refused' ? plan.reason : '';
  assert.match(reason, /running executable cannot be replaced/);
  assert.match(reason, /seedeep stop/);
  assert.match(reason, /bun install -g seedeep --trust/);
  assert.match(reason, /seedeep start/);
});

// The channel is the first question: `git pull` is the answer for a checkout on Windows too, and
// naming the platform there would send the user after the wrong obstacle.
test('a channel with no install command is refused by its channel, on every platform', () => {
  for (const platform of ['darwin', 'win32'] as NodeJS.Platform[]) {
    const checkout = planSelfUpdate({ kind: 'checkout', command: null }, platform);
    assert.match(checkout.kind === 'refused' ? checkout.reason : '', /git pull/);
    const download = planSelfUpdate({ kind: 'download', command: null }, platform);
    assert.match(download.kind === 'refused' ? download.reason : '', /releases\/latest/);
  }
});

test('a refusal installs nothing and restarts nothing', async () => {
  const { base, installed, errored, restarts } = deps({ channel: { kind: 'download', command: null } });
  assert.equal(await runSelfUpdate(44842, base), 1);
  assert.deepEqual(installed, []);
  assert.equal(restarts(), 0);
  assert.match(errored[0] ?? '', /releases\/latest/);
});

test('the current version installs nothing', async () => {
  const { base, installed, logged, restarts } = deps({ status: async () => status('1.1.0', '1.1.0', 'current') });
  assert.equal(await runSelfUpdate(44842, base), 0);
  assert.deepEqual(installed, []);
  assert.equal(restarts(), 0);
  assert.match(logged[0] ?? '', /nothing to install/);
});

// A version ahead of npm is a build of your own, and "update" would REPLACE it with an older one.
test('running ahead of npm is refused rather than downgraded', async () => {
  const { base, installed, errored } = deps({ status: async () => status('1.2.0', '1.1.0', 'ahead') });
  assert.equal(await runSelfUpdate(44842, base), 1);
  assert.deepEqual(installed, []);
  assert.match(errored[0] ?? '', /would downgrade/);
});

test('behind: it installs, then restarts the server on that port', async () => {
  const { base, installed, logged, restarts } = deps();
  assert.equal(await runSelfUpdate(44842, base), 0);
  assert.deepEqual(installed, [['bun', 'install', '-g', 'seedeep', '--trust']]);
  assert.equal(restarts(), 1);
  assert.match(logged.join('\n'), /1\.0\.0 → 1\.1\.0/);
  assert.match(logged.join('\n'), /restarting the server/);
});

test('an install that fails leaves the running server alone', async () => {
  const { base, errored, restarts } = deps({ install: async () => 1 });
  assert.equal(await runSelfUpdate(44842, base), 1);
  assert.equal(restarts(), 0);
  assert.match(errored[0] ?? '', /failed \(exit 1\)/);
});

// THE reason the version is re-read at all: under bun a missing `--trust` blocks the script that
// puts the binary in place, and the install still exits 0. Restarting there would report a
// successful update of code that never arrived.
test('an install that exits 0 without replacing the executable is a failure, not a restart', async () => {
  const { base, errored, restarts } = deps({ installedVersion: async () => '1.0.0' });
  assert.equal(await runSelfUpdate(44842, base), 1);
  assert.equal(restarts(), 0);
  assert.match(errored[0] ?? '', /still reports 1\.0\.0/);
});

test('an executable that cannot be asked its version is not treated as updated', async () => {
  const { base, errored, restarts } = deps({ installedVersion: async () => null });
  assert.equal(await runSelfUpdate(44842, base), 1);
  assert.equal(restarts(), 0);
  assert.match(errored[0] ?? '', /could not be asked for its version/);
});

// `restart` would START one (Davide's call, 2026-08-05), and a self-update that leaves a server
// running where the user had none has done something they did not ask for.
test('no server on that port means no restart, and no server started', async () => {
  const { base, logged, restarts } = deps({ servers: async () => [{ pid: 7, baseUrl: 'http://localhost:9000' }] });
  assert.equal(await runSelfUpdate(44842, base), 0);
  assert.equal(restarts(), 0);
  assert.match(logged.join('\n'), /No server was running on port 44842/);
});

test('the restart’s exit code is the command’s', async () => {
  const { base } = deps({ restart: async () => 1 });
  assert.equal(await runSelfUpdate(44842, base), 1);
});

// The preview runs inside Claude Code's preprocessing, which blocks the turn: it must be able to
// end one without anything being installed.
test('the preview says "Nothing to run" for every case that would install nothing', () => {
  const at = (v: string) => status(v, v, 'current');
  const refused = selfUpdatePreview(
    planSelfUpdate({ kind: 'checkout', command: null }, 'darwin'),
    at('1.0.0'),
    '/bin/x',
  );
  assert.match(refused, /Nothing to run/);
  assert.match(refused, /git pull/);

  const current = selfUpdatePreview(planSelfUpdate(BUN, 'darwin'), at('1.1.0'), '/bin/x');
  assert.match(current, /Nothing to run/);

  const ahead = selfUpdatePreview(planSelfUpdate(BUN, 'darwin'), status('1.2.0', '1.1.0', 'ahead'), '/bin/x');
  assert.match(ahead, /Nothing to run/);
});

test('the preview names the one command to run, and never the package manager’s', () => {
  const preview = selfUpdatePreview(planSelfUpdate(BUN, 'darwin'), status('1.0.0', '1.1.0', 'behind'), '/bin/x');
  assert.match(preview, /\n {2}seedeep self-update\n/);
  assert.doesNotMatch(preview, /Nothing to run/);
  // The command it WILL run is quoted as description, never on a line of its own that reads as an
  // instruction: the model is told to run `seedeep self-update`, and nothing else.
  assert.doesNotMatch(preview, /\n {2}bun install/);
});

// The one branch the injected `install` cannot cover, and it is the one that decides whether a
// missing package manager is a reported failure or an unhandled `spawn` error taking the process
// down mid-update.
test('the real spawn reports an exit code, and a command that cannot start is 127', async () => {
  assert.equal(await runToCompletion(['bun', '--version']), 0);
  assert.equal(await runToCompletion(['seedeep-no-such-package-manager', 'install']), 127);
});
