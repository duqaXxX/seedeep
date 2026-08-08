/**
 * Client-side Bearer token management for non-loopback mode.
 *
 * On startup, seedeep prints a URL with `?token=<token>`. The browser opens it once;
 * this module extracts the token, persists it to localStorage, and cleans the URL.
 * Subsequent page loads (and other browsers) read the token from localStorage.
 *
 * In loopback mode no token is set, so `authFetch` behaves identically to plain `fetch`.
 */

import type { EventSourceLike } from './stream.ts';

const STORAGE_KEY = 'seedeep-token';

/**
 * What the server thinks of this browser's credentials.
 *
 * `missing` — nothing is stored for this ORIGIN, and the server wants one. The port is part of an
 * origin, so a second seedeep on the same host is a different one: the token stored for `:44842`
 * is not visible to `:44843`, which is exactly how a working setup looks broken.
 * `refused` — a token IS stored and the server rejected it (regenerated since, or the wrong one).
 */
export type AuthState = 'ok' | 'missing' | 'refused';

// Only a fetch can learn this. An EventSource's `error` carries no status at all, so the stream
// itself can never tell a 401 from a dropped connection — which is why a missing token used to be
// announced as "Live feed lost — reconnecting…", a reconnection that could not possibly help.
let authState: AuthState = 'ok';
const authListeners = new Set<(s: AuthState) => void>();

/** The last verdict the server gave on this browser's token. */
export function currentAuthState(): AuthState {
  return authState;
}

/** Subscribe to changes of {@link currentAuthState}. Returns an unsubscribe. */
export function onAuthState(cb: (s: AuthState) => void): () => void {
  authListeners.add(cb);
  return () => authListeners.delete(cb);
}

function setAuthState(next: AuthState): void {
  if (next === authState) return;
  authState = next;
  for (const cb of authListeners) cb(next);
}

// `GET /api/config` is the ONE endpoint served without a token — it is what a client reads to
// discover whether this server wants one. A 200 from it therefore proves nothing about our
// credentials, and clearing the verdict on it would wipe the 401 the very next poll. The METHOD is
// part of the rule: `POST /api/config` (saving settings) IS checked, so its success does prove the
// token is good — matching the path alone threw that proof away.
function provesTheToken(url: string, method: string): boolean {
  return !(method.toUpperCase() === 'GET' && url.split('?')[0]!.endsWith('/api/config'));
}

function store(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/**
 * Must be called once, early in page init (before any API call).
 * Reads `?token=` from the URL, saves it to localStorage, and removes it from the URL
 * so the token does not appear in browser history or Referer headers on subsequent navigations.
 * No-ops when called outside a real browser (test environments, SSR).
 */
export function initAuth(): void {
  const s = store();
  if (!s) return;
  try {
    const params = new URLSearchParams(location.search);
    const urlToken = params.get('token');
    if (urlToken) {
      s.setItem(STORAGE_KEY, urlToken);
      params.delete('token');
      const search = params.toString();
      history.replaceState(null, '', location.pathname + (search ? '?' + search : '') + location.hash);
    }
  } catch {
    /* not in a real browser */
  }
}

/** Returns the stored Bearer token, or an empty string in loopback mode or test environments. */
export function getToken(): string {
  return store()?.getItem(STORAGE_KEY) ?? '';
}

/**
 * Update the stored token after a successful Regen+Save so that subsequent `authFetch`
 * calls use the new token immediately (the server adopts it without a restart).
 */
export function setToken(token: string): void {
  store()?.setItem(STORAGE_KEY, token);
}

/**
 * Drop-in replacement for `fetch` that injects `Authorization: Bearer <token>` when a
 * token is stored. In loopback mode (no token) this is identical to plain `fetch`.
 */
export function authFetch(url: string, init?: RequestInit): Promise<Response> {
  const token = getToken();
  const method = init?.method ?? 'GET';
  if (!token) return observe(fetch(url, init), url, method, '');
  const merged: RequestInit = {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...((init?.headers as Record<string, string> | undefined) ?? {}),
    },
  };
  return observe(fetch(url, merged), url, method, token);
}

/**
 * Read the server's verdict off a response without changing it: a 401 sets the state, and any
 * successful answer from an endpoint that DOES check the token clears it — so fixing the token in
 * the settings panel heals the banner on the next poll, with nothing to reset by hand.
 *
 * A network failure is left alone on purpose: an unreachable server says nothing about whether our
 * token is good, and reporting one as the other is the mistake this whole change exists to undo.
 */
function observe(res: Promise<Response>, url: string, method: string, token: string): Promise<Response> {
  return res.then((r) => {
    // A 401 about a token we no longer use says nothing about the one we do. Without this, a
    // request still in flight when the user opens the startup URL comes back and overwrites the
    // `ok` that the first request with the NEW token had just established — the banner returns
    // seconds after the fix, with nothing on screen to explain it.
    if (r.status === 401 && token === getToken()) setAuthState(token ? 'refused' : 'missing');
    else if (r.ok && provesTheToken(url, method)) setAuthState('ok');
    return r;
  });
}

/**
 * EventSource wrapper that appends `?token=<token>` to the URL.
 * Browsers cannot set custom headers on EventSource connections, so the query param
 * is the only way to authenticate SSE streams from a browser.
 */
export class AuthEventSource implements EventSourceLike {
  private readonly inner: EventSource;

  constructor(url: string) {
    const token = getToken();
    if (token) {
      const u = new URL(url, location.origin);
      u.searchParams.set('token', token);
      this.inner = new EventSource(u.toString());
    } else {
      this.inner = new EventSource(url);
    }
  }

  addEventListener(type: string, cb: (ev: { data: string }) => void): void {
    // The DOM's listener signature is `(ev: Event)`, which carries no `data`, so casting the
    // callback itself is unsound and TS rejects it. Narrow the event instead: an EventSource
    // only ever delivers MessageEvents, and its `data` is the frame payload.
    this.inner.addEventListener(type, (ev: Event) => cb(ev as MessageEvent<string>));
  }

  close(): void {
    this.inner.close();
  }

  get readyState(): number {
    return this.inner.readyState;
  }
}
