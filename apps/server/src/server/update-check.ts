/**
 * The one place seedeep asks npm which version is current, and the cache that keeps it to once an
 * hour (Davide's call, 2026-08-05, superseding the same day's "only when you type it": the check is
 * periodic, and every surface that shows a version reads THIS).
 *
 * **The clock is the cache, not a timer.** Nothing schedules anything: an answer older than
 * {@link TTL_MS} is refetched by whoever asks next, and a server nobody talks to asks nothing. A
 * timer would have to be created, cleared at shutdown, and would keep fetching for a portal that
 * was closed a week ago — while ten clients in one hour still cost exactly one request this way.
 *
 * **Only `latest` and its timestamp are stored.** The STANDING is derived on every read against the
 * version doing the reading, because the cache outlives the binary that wrote it: a file saying
 * `behind` from yesterday would still say it to the executable that has since been updated. It also
 * means one cache serves a tray and a server on different versions — which in remote mode they are.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { seedDeepDir } from './config.ts';
import { VERSION } from './version.ts';

/**
 * Where "the latest version" is asked. npm's dist-tags endpoint answers in 18 bytes
 * (`{"latest":"0.9.0"}`, measured) and — this is why one endpoint serves every channel — the npm
 * package and the release binaries ship from the SAME tag, so what npm calls latest is also the
 * newest downloadable executable.
 */
const DIST_TAGS = 'https://registry.npmjs.org/-/package/seedeep/dist-tags';
/** A version check is a convenience; it must never be what makes a command feel broken. */
const CHECK_TIMEOUT_MS = 3000;

/**
 * Once an hour, the cadence Davide asked for (2026-08-05, raised from a day). The whole cost of the
 * change is 24 requests of 18 bytes a day instead of one; what it buys is learning about a release
 * within the hour instead of within the day. It does NOT make the tray noisier: that banner fires
 * once per released version however often the check runs.
 */
export const TTL_MS = 60 * 60 * 1000;
/**
 * How long a FAILED check is left alone. Without it an offline machine would go to the network on
 * every single request — the cache would hold nothing to expire, so every caller would be the one
 * that retries. Deliberately SHORTER than {@link TTL_MS}: a failure has no answer to preserve, so
 * the only thing waiting costs is how long a laptop back on wifi keeps reporting nothing.
 */
export const RETRY_AFTER_FAILURE_MS = 15 * 60 * 1000;

/** Where the answer lives — under {@link seedDeepDir}, so `SEEDEEP_HOME` moves it with the rest. */
export function updateCheckFile(home = homedir()): string {
  return join(seedDeepDir(home), 'update-check.json');
}

/** What is on disk between checks. `failedAt` alone means "asked, got nothing" — see the retry rule. */
interface CachedCheck {
  latest?: string;
  /** ISO 8601, when the registry last ANSWERED. */
  checkedAt?: string;
  /** ISO 8601, when it last did not. */
  failedAt?: string;
  /** Why it did not — kept so `seedeep update` can say it hours later, from the cooldown. */
  failedReason?: string;
}

/**
 * Compare two versions by their numeric parts. Anything after a `-` is dropped: a prerelease is
 * not something this has to order, and pretending to would be a rule nobody asked for.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => (v.split('-')[0] ?? '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** One request to npm. Never throws: an unreachable registry is a value, not an error. */
async function fetchLatest(
  fetchImpl: typeof fetch,
  timeoutMs = CHECK_TIMEOUT_MS,
): Promise<{ latest: string } | { reason: string }> {
  try {
    const res = await fetchImpl(DIST_TAGS, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { reason: `the registry answered ${res.status}` };
    const latest = ((await res.json()) as { latest?: unknown }).latest;
    if (typeof latest !== 'string' || !latest) return { reason: 'the registry named no version' };
    return { latest };
  } catch (err) {
    return { reason: (err as Error).name === 'TimeoutError' ? 'it did not answer' : 'no network' };
  }
}

/** Where a version stands against the newest published one. `unknown` = never got an answer. */
export type Standing = 'behind' | 'current' | 'ahead' | 'unknown';

/** The answer every surface renders: the tray, the portal, `seedeep update`, `open` and `start`. */
export interface UpdateStatus {
  /** The version asking — the caller's own, so a remote tray is not told the server's standing. */
  current: string;
  /** npm's `latest`, or null when it has never been reachable. */
  latest: string | null;
  standing: Standing;
  /** ISO 8601 of the answer being reported, or null when there has never been one. */
  checkedAt: string | null;
  /** Why the LAST attempt got nothing, or null when it succeeded. Set even when `latest` is known
   * from an earlier day — the two are independent facts. */
  reason: string | null;
}

/** Derive the standing of `current` against a cached `latest`. */
function standingOf(current: string, latest: string | null): Standing {
  if (!latest) return 'unknown';
  const d = compareVersions(current, latest);
  return d < 0 ? 'behind' : d > 0 ? 'ahead' : 'current';
}

async function read(file: string): Promise<CachedCheck> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as CachedCheck;
  } catch {
    // A missing or corrupt cache is an empty one: this file is a convenience, never a dependency.
    return {};
  }
}

/**
 * Whether `cache` still answers for `now`, under the TTL and the failure cooldown.
 *
 * Decided by the most recent ATTEMPT, never by the most recent success. The two timestamps coexist —
 * a failure preserves the `checkedAt` of the answer it could not replace — and a failure is only
 * reachable once that answer is already past the TTL. Reading `checkedAt ?? failedAt` therefore
 * always found a stale success and never consulted the cooldown at all, so every caller after the
 * first failure went back to the network: an offline machine paying the whole timeout, every time.
 */
function isFresh(cache: CachedCheck, now: number): boolean {
  const attempts: Array<{ at: number; ttl: number }> = [];
  if (cache.checkedAt) attempts.push({ at: Date.parse(cache.checkedAt), ttl: TTL_MS });
  if (cache.failedAt) attempts.push({ at: Date.parse(cache.failedAt), ttl: RETRY_AFTER_FAILURE_MS });
  const last = attempts.filter((a) => Number.isFinite(a.at)).sort((a, b) => b.at - a.at)[0];
  if (!last) return false;
  const age = now - last.at;
  // A clock moved backwards leaves an age below zero, which is not freshness — refetch rather than
  // trust a future timestamp.
  if (age < 0) return false;
  return age < last.ttl;
}

/**
 * One fetch at a time per cache file. Two clients polling the same server would otherwise both find
 * the cache stale and both go to npm — the cadence is a property of the cache, and a race is how it
 * stops being one. Keyed by file rather than global so a caller pointed at another cache (a test,
 * a second `SEEDEEP_HOME`) is not handed the first one's answer.
 */
const inFlight = new Map<string, Promise<CachedCheck>>();

async function refresh(file: string, fetchImpl: typeof fetch, nowIso: string): Promise<CachedCheck> {
  const result = await fetchLatest(fetchImpl);
  let next: CachedCheck;
  if ('latest' in result) {
    next = { latest: result.latest, checkedAt: nowIso };
  } else {
    // A failure keeps the last KNOWN version: an unreachable registry is not evidence that
    // yesterday's answer is wrong, and dropping it would turn one offline hour into "unknown".
    const previous = await read(file);
    next = { failedAt: nowIso, failedReason: result.reason };
    if (previous.latest && previous.checkedAt) {
      next.latest = previous.latest;
      next.checkedAt = previous.checkedAt;
    }
  }
  try {
    await writeFile(file, JSON.stringify(next));
  } catch {
    /* an un-writable cache costs a request a day, not the answer */
  }
  return next;
}

/**
 * The current update status, from cache when it is fresh and from npm when it is not. Never throws:
 * an unreachable registry is a `standing: 'unknown'`, because no surface should break over it.
 *
 * `offline` returns what is already known without touching the network at all.
 */
export async function updateStatus(
  opts: {
    version?: string;
    home?: string;
    fetchImpl?: typeof fetch;
    now?: number;
    offline?: boolean;
    file?: string;
  } = {},
): Promise<UpdateStatus> {
  const {
    version = VERSION,
    home = homedir(),
    fetchImpl = fetch,
    now = Date.now(),
    offline = false,
    file = updateCheckFile(home),
  } = opts;

  let cache = await read(file);
  if (!offline && !isFresh(cache, now)) {
    let pending = inFlight.get(file);
    if (!pending) {
      pending = refresh(file, fetchImpl, new Date(now).toISOString()).finally(() => inFlight.delete(file));
      inFlight.set(file, pending);
    }
    cache = await pending;
  }
  const latest = cache.latest ?? null;
  return {
    current: version,
    latest,
    standing: standingOf(version, latest),
    checkedAt: cache.checkedAt ?? null,
    reason: cache.failedReason ?? null,
  };
}

/** One line for a terminal, or null when there is nothing worth interrupting the output for. */
export function updateNotice(status: UpdateStatus): string | null {
  if (status.standing !== 'behind' || !status.latest) return null;
  return `seedeep ${status.latest} is available (you have ${status.current}) — run \`seedeep update\` to see how.`;
}
