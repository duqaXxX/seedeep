import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selfInvocation } from '../src/server/args.ts';
import { defaultConfig } from '../src/server/config.ts';
import { type OpenDeps, openUrlFor, planOpen, portOf, runOpen, runStart } from '../src/server/open-cmd.ts';
import type { RunningServerRecord } from '../src/server/run-state.ts';

const rec = (port: number, pid = port, scheme = 'http', host = 'localhost'): RunningServerRecord => ({
  pid,
  baseUrl: `${scheme}://${host}:${port}`,
});

function deps(overrides: Partial<OpenDeps> = {}) {
  const opened: string[] = [];
  const logged: string[] = [];
  const errored: string[] = [];
  const base: OpenDeps = {
    config: defaultConfig('/home/dev'),
    servers: async () => [],
    startServer: () => ({ hasExited: () => false }),
    openBrowser: (url) => opened.push(url),
    log: (line) => logged.push(line),
    error: (line) => errored.push(line),
    sleep: async () => {},
    logPath: '/home/dev/.seedeep/server.log',
    timeoutMs: 600,
    ...overrides,
  };
  return { base, opened, logged, errored };
}

test('portOf reads the port from a record, defaulting by scheme', () => {
  assert.equal(portOf('http://localhost:44842'), 44842);
  assert.equal(portOf('https://box.local'), 443);
  assert.equal(portOf('not a url'), null);
});

// Both shapes measured on bun 1.3.13 (macOS arm64). The compiled one is not a hypothesis: passing
// the bunfs path back killed the spawned server with `Module not found "/$bunfs/root/…"`. The
// answer comes from FROM_SOURCE, never from the path's spelling — that differs on Windows.
test('the spawn omits the entry path in a compiled binary and keeps it in dev', () => {
  assert.deepEqual(selfInvocation('/home/dev/.bun/bin/bun', '/repo/apps/server/src/server/main.ts', true), [
    '/home/dev/.bun/bin/bun',
    '/repo/apps/server/src/server/main.ts',
  ]);
  assert.deepEqual(selfInvocation('/usr/local/bin/seedeep', '/$bunfs/root/seedeep-server_0.9.0_macos-arm64', false), [
    '/usr/local/bin/seedeep',
  ]);
});

test('nothing running means start', () => {
  assert.deepEqual(planOpen([], 44842), { kind: 'start' });
});

test('a server on the configured port is the one to open', () => {
  assert.deepEqual(planOpen([rec(44842)], 44842), { kind: 'open', server: rec(44842) });
});

// The approved rule: with servers up but none on the configured port, opening one anyway would be
// indistinguishable from success — the GUI appears and nothing says it is the wrong process.
test('servers running but none on the configured port is reported, never guessed', () => {
  const plan = planOpen([rec(9000)], 44842);
  assert.equal(plan.kind, 'ambiguous');
});

test('openUrlFor leaves a loopback URL alone and carries the token otherwise', () => {
  const config = { ...defaultConfig('/home/dev'), auth: { token: 'a b/c' } };
  assert.equal(openUrlFor(rec(44842), config), 'http://localhost:44842');
  assert.equal(openUrlFor(rec(44842, 1, 'https', 'box.local'), config), 'https://box.local:44842/?token=a%20b%2Fc');
});

// `start` is `open` minus the browser — the counterpart of `stop`, and idempotent for the same
// reason stop is: asking for a state that already holds is not a failure.
test('start brings a server up and never opens a browser', async () => {
  let ticks = 0;
  const { base, opened, logged } = deps({ servers: async () => (++ticks > 2 ? [rec(44842)] : []) });
  assert.equal(await runStart(44842, base), 0);
  assert.deepEqual(opened, []);
  assert.match(logged[0] ?? '', /started — http:\/\/localhost:44842/);
});

test('start on a server already up succeeds and says so', async () => {
  let started = false;
  const { base, opened, logged } = deps({
    servers: async () => [rec(44842)],
    startServer: () => {
      started = true;
      return { hasExited: () => false };
    },
  });
  assert.equal(await runStart(44842, base), 0);
  assert.equal(started, false, 'nothing is spawned beside a server that is already there');
  assert.deepEqual(opened, []);
  assert.match(logged[0] ?? '', /already running/);
});

test('an already-running server is opened without starting anything', async () => {
  let started = false;
  const { base, opened, errored } = deps({
    servers: async () => [rec(44842)],
    startServer: () => {
      started = true;
      return { hasExited: () => false };
    },
  });
  assert.equal(await runOpen(44842, base), 0);
  assert.deepEqual(opened, ['http://localhost:44842']);
  assert.equal(started, false);
  assert.deepEqual(errored, []);
});

test('a started server is opened as soon as it announces itself', async () => {
  let ticks = 0;
  const { base, opened } = deps({
    servers: async () => (++ticks > 2 ? [rec(44842)] : []),
  });
  assert.equal(await runOpen(44842, base), 0);
  assert.deepEqual(opened, ['http://localhost:44842']);
});

test('a server that dies while starting is reported, not waited out', async () => {
  let exited = false;
  const { base, opened, errored } = deps({
    startServer: () => ({ hasExited: () => exited }),
    servers: async () => {
      exited = true;
      return [];
    },
  });
  assert.equal(await runOpen(44842, base), 1);
  assert.deepEqual(opened, []);
  assert.match(errored[0] ?? '', /exited while starting.*server\.log/s);
});

test('a server that never announces itself times out with the log path', async () => {
  const { base, opened, errored } = deps();
  assert.equal(await runOpen(44842, base), 1);
  assert.deepEqual(opened, []);
  assert.match(errored[0] ?? '', /did not announce itself/);
});

test('the ambiguous case names every running server and how to pick one', async () => {
  const { base, opened, errored } = deps({ servers: async () => [rec(9000), rec(9100)] });
  assert.equal(await runOpen(44842, base), 1);
  assert.deepEqual(opened, []);
  assert.match(errored[0] ?? '', /9000/);
  assert.match(errored[0] ?? '', /9100/);
  assert.match(errored[0] ?? '', /--port/);
});

test('the update line comes after the address, on both open and start', async () => {
  const notice = async () => 'seedeep 1.2.0 is available (you have 1.0.0) — run `seedeep update` to see how.';

  for (const run of [runOpen, runStart]) {
    const { base, logged } = deps({ servers: async () => [rec(44842)], notice });
    assert.equal(await run(44842, base), 0);
    assert.match(logged[0] ?? '', /already running/);
    assert.match(logged[1] ?? '', /1\.2\.0 is available/);
  }
});

test('a version up to date, or a cache that cannot be read, adds no line at all', async () => {
  const silent = deps({ servers: async () => [rec(44842)], notice: async () => null });
  assert.equal(await runStart(44842, silent.base), 0);
  assert.equal(silent.logged.length, 1);

  // The check is a convenience: it must never be what makes `start` fail.
  const broken = deps({
    servers: async () => [rec(44842)],
    notice: async () => {
      throw new Error('unreadable cache');
    },
  });
  assert.equal(await runStart(44842, broken.base), 0);
  assert.equal(broken.logged.length, 1);
});
