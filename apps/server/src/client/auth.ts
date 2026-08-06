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
  if (!token) return fetch(url, init);
  const merged: RequestInit = {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...((init?.headers as Record<string, string> | undefined) ?? {}),
    },
  };
  return fetch(url, merged);
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
