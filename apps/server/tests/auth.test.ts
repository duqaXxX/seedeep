/**
 * The server's verdict on this browser's token, which is a fact only a FETCH can learn: an
 * EventSource's `error` carries no status, so the stream can never tell a 401 from a dropped
 * connection. Until this existed, a missing token was announced as "Live feed lost —
 * reconnecting…" — a reconnection that could not possibly help, pointing the reader at a network
 * problem that was not there.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authFetch, currentAuthState, onAuthState, setToken } from '../src/client/auth.ts';

const g = globalThis as any;

// The suite shares ONE process, so a fake `fetch` left behind here breaks every later test that
// talks to a real local server — which is exactly what it did the first time this file ran.
// Every test restores what it replaced.
function withFakes<T>(run: () => Promise<T>): Promise<T> {
  const prev = { fetch: g.fetch, localStorage: g.localStorage };
  return run().finally(() => {
    g.fetch = prev.fetch;
    g.localStorage = prev.localStorage;
  });
}

/** A localStorage that is just a Map — the module only ever gets/sets one key. */
function fakeStorage(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

/** Answers every request with one status, and records what was asked. */
function fakeFetch(status: number) {
  const urls: string[] = [];
  g.fetch = (url: string) => {
    urls.push(String(url));
    return Promise.resolve({ status, ok: status >= 200 && status < 300 });
  };
  return urls;
}

test('a 401 with no token stored says the token is MISSING, not that the feed dropped', () =>
  withFakes(async () => {
    g.localStorage = fakeStorage();
    fakeFetch(401);
    const seen: string[] = [];
    const off = onAuthState((s) => seen.push(s));

    await authFetch('/api/live');

    assert.equal(currentAuthState(), 'missing', 'no token stored + refused = this browser has none');
    assert.deepEqual(seen, ['missing'], 'and it is announced once, not on every poll');
    off();
  }));

test('a 401 WITH a token stored says the token is refused — a different sentence, a different fix', () =>
  withFakes(async () => {
    g.localStorage = fakeStorage();
    setToken('a-token-the-server-does-not-accept');
    fakeFetch(401);

    await authFetch('/api/live');

    assert.equal(currentAuthState(), 'refused');
  }));

test('a later success clears it, so fixing the token in Settings heals the banner by itself', () =>
  withFakes(async () => {
    g.localStorage = fakeStorage();
    setToken('good');
    fakeFetch(401);
    await authFetch('/api/live');
    assert.equal(currentAuthState(), 'refused');

    fakeFetch(200);
    await authFetch('/api/live');

    assert.equal(currentAuthState(), 'ok', 'nothing to reset by hand — the next poll is the reset');
  }));

// `GET /api/config` is the one endpoint served WITHOUT a token: it is how a client discovers
// whether this server wants one at all. Clearing the verdict on it would wipe the 401 within a
// second of setting it, and the banner would flicker instead of stating a fact.
test('a 200 from /api/config proves nothing about our token, and must not clear the verdict', () =>
  withFakes(async () => {
    g.localStorage = fakeStorage();
    fakeFetch(401);
    await authFetch('/api/live');
    assert.equal(currentAuthState(), 'missing');

    fakeFetch(200);
    await authFetch('/api/config');

    assert.equal(currentAuthState(), 'missing', 'the exempt endpoint says nothing either way');
  }));

// An unreachable server is not a refused token. Reporting one as the other is exactly the
// confusion this module exists to end, so a rejected fetch must leave the verdict alone.
test('a network failure leaves the verdict where it was', () =>
  withFakes(async () => {
    g.localStorage = fakeStorage();
    fakeFetch(200);
    await authFetch('/api/live');
    assert.equal(currentAuthState(), 'ok');

    g.fetch = () => Promise.reject(new Error('connection refused'));
    await assert.rejects(() => authFetch('/api/live'));

    assert.equal(currentAuthState(), 'ok', 'seedeep being unreachable says nothing about the token');
  }));
