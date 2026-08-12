import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultConfig } from '../src/server/config.ts';
import { authFor } from '../src/server/own-server.ts';
import { type RestartDeps, runRestart } from '../src/server/restart-cmd.ts';
import type { RunningServerRecord } from '../src/server/run-state.ts';

const rec = (port: number, pid = port, host = 'localhost', scheme = 'http'): RunningServerRecord => ({
  pid,
  baseUrl: `${scheme}://${host}:${port}`,
});

function deps(over: Partial<RestartDeps> = {}) {
  const logged: string[] = [];
  const errored: string[] = [];
  const posted: { url: string; token: string | null }[] = [];
  const base: RestartDeps = {
    config: defaultConfig('/home/dev'),
    servers: async () => [rec(44842)],
    startServer: () => ({ hasExited: () => false }),
    log: (l) => logged.push(l),
    error: (l) => errored.push(l),
    sleep: async () => {},
    logPath: '/home/dev/.seedeep/server.log',
    timeoutMs: 600,
    post: async (url, token) => {
      posted.push({ url, token });
      return { kind: 'answered', status: 200 };
    },
    ...over,
  };
  return { base, logged, errored, posted };
}

test('a loopback server needs no token; a remote one is sent the config token', () => {
  const config = { ...defaultConfig('/home/dev'), auth: { token: 'secret' } };
  assert.equal(authFor(rec(44842), config), null);
  assert.equal(authFor(rec(44842, 1, 'box.local', 'https'), config), 'secret');
});

test('the running server is asked to restart, and the new pid is reported', async () => {
  let swapped = false;
  const asked: string[] = [];
  const { base, logged } = deps({
    servers: async () => [swapped ? rec(44842, 999) : rec(44842, 100)],
    post: async (url) => {
      asked.push(url);
      swapped = true;
      return { kind: 'answered', status: 200 };
    },
  });
  assert.equal(await runRestart(44842, base), 0);
  assert.equal(asked[0], 'http://localhost:44842/api/restart');
  assert.match(logged[0] ?? '', /restarted.*100 → 999/);
});

// A server asked to exit can drop the connection before answering: that is one of its normal
// endings, so the record — not the transport — decides whether the restart happened.
test('a lost connection is not a failure when the replacement comes up', async () => {
  let swapped = false;
  const { base, logged } = deps({
    servers: async () => [swapped ? rec(44842, 999) : rec(44842, 100)],
    post: async () => {
      swapped = true;
      return { kind: 'disconnected' };
    },
  });
  assert.equal(await runRestart(44842, base), 0);
  assert.match(logged[0] ?? '', /restarted/);
});

test('a server that ANSWERS and refuses is reported with its status', async () => {
  const { base, errored } = deps({ post: async () => ({ kind: 'answered', status: 401 }) });
  assert.equal(await runRestart(44842, base), 1);
  assert.match(errored[0] ?? '', /refused the restart \(HTTP 401\)/);
});

// The old server DID go (its record is gone) and nothing took its place — the handover started and
// never finished. Distinct from the old server outliving the request, which is the test below and
// used to be reported with this same sentence.
test('a replacement that never announces itself is a failure, not a silent success', async () => {
  let asked = false;
  const { base, errored } = deps({
    servers: async () => (asked ? [] : [rec(44842, 100)]),
    post: async () => {
      asked = true;
      return { kind: 'disconnected' };
    },
  });
  assert.equal(await runRestart(44842, base), 1);
  assert.match(errored[0] ?? '', /the old server stopped, but no replacement/);
});

// the maintainer's call (2026-08-05): nothing to restart means start one — and NOT open a browser.
test('nothing running starts a server', async () => {
  let started = false;
  const { base, logged } = deps({
    servers: async () => (started ? [rec(44842, 7)] : []),
    startServer: () => {
      started = true;
      return { hasExited: () => false };
    },
    post: async () => {
      throw new Error('no server should have been asked to restart');
    },
  });
  assert.equal(await runRestart(44842, base), 0);
  assert.match(logged[0] ?? '', /was not running — started/);
});

test('a server on another port is reported, never restarted in place of the one asked for', async () => {
  const { base, errored, posted } = deps({ servers: async () => [rec(9000)] });
  assert.equal(await runRestart(44842, base), 1);
  assert.deepEqual(posted, []);
  assert.match(errored[0] ?? '', /9000/);
});

// Regression, measured on a real remote server (2026-08-05). `post` returned a bare number, so a
// connection that was NEVER ESTABLISHED and one dropped mid-handover were both `0` — and `0` is
// treated as the normal ending. `fetch` refuses a self-signed certificate
// (`DEPTH_ZERO_SELF_SIGNED_CERT`, measured), so on a remote server the POST never arrived, the old
// server kept running, the replacement could not bind, and the command blamed the replacement.
test('a POST that never reached the server is a failure, not the normal ending', async () => {
  const { base, errored, logged } = deps({
    servers: async () => [rec(44842, 67256, 'box.local', 'https')],
    post: async () => ({ kind: 'unreachable' as const, reason: 'self signed certificate' }),
  });

  assert.equal(await runRestart(44842, base), 1);
  assert.deepEqual(logged, [], 'nothing may report success');
  assert.match(errored[0] ?? '', /self signed certificate/);
  // The old server is untouched, so saying it was "asked to stop" would be false.
  assert.doesNotMatch(errored[0] ?? '', /asked to stop/);
});

// The other half: when the request DID land and the old server simply did not go away, the message
// must name that — not the replacement, which was never the problem.
test('an old server that outlives the request is named as such', async () => {
  const { base, errored } = deps({
    servers: async () => [rec(44842, 67256)],
    post: async () => ({ kind: 'disconnected' as const }),
  });

  assert.equal(await runRestart(44842, base), 1);
  assert.match(errored[0] ?? '', /pid 67256/);
  assert.match(errored[0] ?? '', /still running|did not stop/);
});
