/**
 * Talking to a seedeep server running on this machine — what such a request needs to be accepted,
 * in one place because two commands now make one (`restart` asks for a handover, `status` asks what
 * is being served) and the awkward parts are not obvious from either call site.
 *
 * Both parts exist because of REMOTE mode. On loopback a request needs nothing at all; the moment
 * the server binds anything else it demands a token AND serves its own self-signed certificate,
 * and a caller that forgets either gets a failure that looks like the server being down.
 */

import { readFile } from 'node:fs/promises';
import type { SeedDeepConfig } from './config.ts';
import type { RunningServerRecord } from './run-state.ts';
import { isLoopback } from './server.ts';

/**
 * The authorisation a request to `server` needs: the config's token when the server is not on
 * loopback, and nothing when it is — the same rule the server applies to the request itself.
 */
export function authFor(server: RunningServerRecord, config: SeedDeepConfig): string | null {
  try {
    return isLoopback(new URL(server.baseUrl).hostname) ? null : config.auth.token;
  } catch {
    return null;
  }
}

/**
 * The TLS options for talking to this machine's own server: its certificate as the only CA, when
 * the address is https and the file is readable.
 *
 * In remote mode seedeep serves a certificate it generated itself, which `fetch` rejects outright
 * (measured 2026-08-05: `DEPTH_ZERO_SELF_SIGNED_CERT`), so the request never leaves the process.
 * Trusting THAT certificate — the one this machine wrote and holds on disk — is the answer;
 * `rejectUnauthorized: false` is not, since it would accept any certificate at all.
 *
 * `undefined` for plain http, and for a certificate that cannot be read: a missing file must fail
 * as a failed request, never quietly become "verify nothing".
 */
export async function trustOwnCert(url: string, config: SeedDeepConfig): Promise<{ ca: Buffer } | undefined> {
  if (!url.startsWith('https:')) return undefined;
  try {
    return { ca: await readFile(config.tls.cert) };
  } catch {
    return undefined;
  }
}

/**
 * GET one JSON endpoint on a server of ours, or `null` when it could not be read for any reason —
 * down, refusing the token, or answering something that is not JSON.
 *
 * Null rather than a throw because every caller is asking a question about a server that may
 * legitimately be gone, and none of them can do anything with the distinction.
 */
export async function askServer<T>(
  server: RunningServerRecord,
  path: string,
  config: SeedDeepConfig,
  timeoutMs = 3000,
): Promise<T | null> {
  const url = `${server.baseUrl}${path}`;
  const token = authFor(server, config);
  try {
    const res = await fetch(url, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
      tls: await trustOwnCert(url, config),
    });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}
