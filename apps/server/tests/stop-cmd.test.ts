import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RunningServerRecord } from '../src/server/run-state.ts';
import { runStop, type StopDeps } from '../src/server/stop-cmd.ts';

const rec = (port: number, pid = port): RunningServerRecord => ({ pid, baseUrl: `http://localhost:${port}` });

function deps(over: Partial<StopDeps> = {}) {
  const logged: string[] = [];
  const errored: string[] = [];
  const signalled: number[] = [];
  const base: StopDeps = {
    servers: async () => [rec(44842)],
    log: (l) => logged.push(l),
    error: (l) => errored.push(l),
    sleep: async () => {},
    signal: (pid) => {
      signalled.push(pid);
      return true;
    },
    timeoutMs: 600,
    ...over,
  };
  return { base, logged, errored, signalled };
}

test('the server on the configured port is signalled, and the stop is then OBSERVED', async () => {
  let gone = false;
  const signalled: number[] = [];
  const { base, logged } = deps({
    servers: async () => (gone ? [] : [rec(44842, 321)]),
    signal: (pid) => {
      signalled.push(pid);
      gone = true;
      return true;
    },
  });
  assert.equal(await runStop(44842, base), 0);
  assert.deepEqual(signalled, [321]);
  assert.match(logged[0] ?? '', /stopped.*pid 321/);
});

// Asking for a state that already holds is not a failure — `/seedeep stop` twice must not turn the
// second one into an error the user has to read.
test('nothing running is reported and succeeds', async () => {
  const { base, logged, errored, signalled } = deps({ servers: async () => [] });
  assert.equal(await runStop(44842, base), 0);
  assert.deepEqual(signalled, []);
  assert.deepEqual(errored, []);
  assert.match(logged[0] ?? '', /not running/);
});

test('a server on another port is listed, never stopped in place of the one asked for', async () => {
  const { base, errored, signalled } = deps({ servers: async () => [rec(9000)] });
  assert.equal(await runStop(44842, base), 1);
  assert.deepEqual(signalled, []);
  assert.match(errored[0] ?? '', /9000/);
});

test('a pid that cannot be signalled says so rather than claiming it stopped', async () => {
  const { base, errored } = deps({ signal: () => false });
  assert.equal(await runStop(44842, base), 1);
  assert.match(errored[0] ?? '', /could not signal/);
});

// Never escalated to SIGKILL: a killed server leaves the record its shutdown exists to withdraw,
// and a recycled pid then inherits it — the exact failure the record's design rules out.
test('a server that ignores SIGTERM is reported, not killed', async () => {
  const { base, errored, signalled } = deps({ servers: async () => [rec(44842, 7)] });
  assert.equal(await runStop(44842, base), 1);
  assert.deepEqual(signalled, [7], 'signalled once, and only once');
  assert.match(errored[0] ?? '', /still running/);
});
