import { type CatalogueRecord, type LivePayload, mergeRoster } from '../core/roster.ts';
import {
  isAutomated,
  isLive,
  isModelBusy,
  isWorking,
  type PendingKind,
  pendingInput,
  type SessionRecord,
} from '../core/types.ts';
import { withDeadline } from './deadline.ts';

type Timer = { cancel(): void };

// `isAutomated`, `isLive`, `isWorking` and `pendingInput` all live in types.ts, beside
// SessionRecord: the watcher needs the same answer as the picker, the digest the same answer as
// the NOW panel, and the tray's band the same answer as the browser's tab badge (see their
// JSDoc). Re-exported here so the client keeps one import site for the session predicates.
export { isAutomated, isLive, isModelBusy, isWorking, type PendingKind, pendingInput };

/**
 * The sessions that should be handed a tab right now: live, interactive, never offered
 * before (`known`), and not already on screen (`openIds`).
 *
 * `known` is what makes "offer it once" different from "keep reopening it": a tab the user
 * closed is gone from `openIds` but stays in `known`, so it is never resurrected — not on
 * the next 3s poll, not after a refresh. Nothing may ever REMOVE an id from `known` for
 * being non-live: `isOpen` reads a PID file, and a mid-rewrite JSON parse yields fewer
 * entries for one poll (a readdir failure is different — it reports the whole mechanism as
 * unavailable, `isOpen: null`, and the mtime window answers), so a session can blink out for
 * one poll and back — and a set pruned on that blink re-offers exactly the tab the user
 * closed. The set is bounded when it is saved instead (see tab-store).
 *
 * Automated runs are excluded because a headless `claude -p` IS an open session while it
 * runs (see open-sessions.ts), so a git push would otherwise pop a tab.
 */
export function sessionsToAutoOpen(
  rows: readonly SessionRecord[],
  known: ReadonlySet<string>,
  openIds: ReadonlySet<string>,
): SessionRecord[] {
  return rows.filter((s) => isLive(s) && !isAutomated(s) && !known.has(s.sessionId) && !openIds.has(s.sessionId));
}

/**
 * The session a deep link asks the portal to show — `?session=<id>` — or null.
 *
 * Exists for the tray, which hands a session over rather than replicating it (`docs/tray.md`): with
 * one live session the portal would land on the right tab anyway, with five it would be a coin toss.
 *
 * Deliberately strict about what it accepts. The value ends up compared against ids from the roster
 * and, if the caller opens a tab for it, put on screen — so an empty or absurdly long value is
 * rejected here rather than handled by every caller. It is NOT checked against the real id format: a
 * session id is Claude Code's to choose, and a client that only accepted today's UUID shape would
 * break on the day that changes.
 */
export function requestedSession(search: string): string | null {
  try {
    const id = new URLSearchParams(search).get('session')?.trim();
    return id && id.length <= 200 ? id : null;
  } catch {
    return null;
  }
}

// What a listener can SEE has to be in the key, or the change never reaches it. This was
// `sessionId:isActive` alone, written when identity was all anyone read; `status` and
// `isOpen` were added to SessionRecord later and the key never caught up. The cost: the
// tab bar's busy dot (which reads `status`) was frozen at whatever it was when its tab was
// created, and `rows` — reassigned only on a key change — served `current()` stale records.
//
// `lastActivity` stays OUT on purpose: it moves on every write, so in the key it would
// notify on every poll of any live session and redraw the picker forever.
// `subject` IS included: it changes exactly once (null → first prompt text) when the head
// scan picks up the first user line, and after that it is immutable — so adding it causes
// one extra onChange notification (enough to update the tab label) and never re-fires.
function rosterKey(rows: SessionRecord[]): string {
  // Order-independent: sorted, so a reordered roster is not a change.
  return (
    rows
      // `waitingFor` is part of identity, not decoration: a session stays 'waiting' while the
      // dialog on screen changes from one the user opened to a real approval, so the status
      // alone would swallow exactly the transition the badge exists for.
      // `isOpen` is printed as-is (true/false/null): losing the null would hide the moment the
      // PID mechanism itself goes away, which flips every session onto the mtime fallback.
      .map(
        (s) =>
          `${s.sessionId}:${s.isActive ? 1 : 0}:${s.isOpen}:${s.status ?? ''}:${s.waitingFor ?? ''}:${s.subject ?? ''}`,
      )
      .sort()
      .join('|')
  );
}

/**
 * The roster, assembled from its two halves: a stable CATALOGUE fetched only when the number
 * of sessions changes, and the LIVE payload polled every `pollMs`. `current()`/`onChange()`
 * hand back exactly what an undivided roster did — the split is invisible above this line.
 *
 * Why it is split at all: the catalogue is ~550 KB and changes when a session is born; the
 * live half is ~1 KB and changes constantly. Sent together, the poll re-sent the whole corpus
 * every 3s to deliver one moved mtime (measured: 1 record of 1086), and it grew with every
 * session ever written.
 */
/**
 * Does the catalogue hold a record that was taken while its session was live (`lastActivity:
 * null`) for a session that is no longer live? Such a record is a birth snapshot and cannot be
 * trusted any more — it is the one form of staleness a size comparison can never see.
 */
function hasProvisional(cat: readonly CatalogueRecord[], liveIds: ReadonlySet<string>): boolean {
  return cat.some((c) => c.lastActivity === null && !liveIds.has(c.sessionId));
}

// How long a reading may take before the poll gives up on it. `fetch` has no timeout of its own,
// and a request sent down a half-open connection settles NEVER — the browser has nothing to
// retransmit, so it waits for an answer that cannot come. The poll re-arms off the reading
// settling, so that one request took the whole roster down with it: measured on a silently cut
// path, 12 readings started, 11 settled, and no 13th ever — not during the outage, and not in the
// minute after the network returned. Only a reload fixed it.
//
// 10s is ~270x the slowest reading measured on a real corpus (37ms, a cold catalogue of 1200+
// sessions) and three poll intervals, so it cannot fire on a machine that is merely busy.
// The deadline uses a raw `setTimeout` (see deadline.ts) and NOT the roster's injected
// `schedule`: that seam exists so a test can decide when a POLL fires, and a deadline a test can
// park is not a deadline.
const READING_TIMEOUT_MS = 10_000;

export function createRoster(deps: {
  fetchCatalogue: (signal: AbortSignal) => Promise<CatalogueRecord[]>;
  fetchLive: (signal: AbortSignal) => Promise<LivePayload>;
  schedule?: (fn: () => void, ms: number) => Timer;
  pollMs?: number;
  /** How long a single reading may take before it is abandoned. Defaults to {@link READING_TIMEOUT_MS}. */
  timeoutMs?: number;
}) {
  const pollMs = deps.pollMs ?? 3000;
  const timeoutMs = deps.timeoutMs ?? READING_TIMEOUT_MS;
  const schedule =
    deps.schedule ??
    ((fn, ms) => {
      const t = setTimeout(fn, ms);
      return { cancel: () => clearTimeout(t) };
    });
  let catalogue: CatalogueRecord[] = [];
  let rows: SessionRecord[] = [];
  let key = '';
  let timer: Timer | null = null;
  let stopped = false;
  let taken = 0; // readings actually completed — a failed poll serves the previous rows unchanged
  // Whether the LAST landed reading read everything it met. Starts false so a consumer asking
  // before the first reading cannot act on a list that does not exist yet.
  let complete = false;
  const listeners = new Set<(rows: SessionRecord[]) => void>();

  async function refresh(): Promise<void> {
    let live: LivePayload;
    try {
      live = await withDeadline(deps.fetchLive, timeoutMs);
    } catch {
      return;
    } // keep last good roster
    const liveIds = new Set(live.sessions.map((s) => s.sessionId));
    // Two things stale the catalogue, and BOTH have to be watched. A changed count means a
    // session was born (or this is the first poll after boot, the catalogue still empty). A
    // PROVISIONAL entry that has stopped being live means the record we hold is a birth
    // snapshot: taken while the session was running, so its `subject` can predate the first
    // prompt, its `model` the first API call, and its mtime is `null`. Nothing about the count
    // moves when a session ends — its file stays on disk — so keying on size alone served that
    // birth snapshot for as long as the page stayed open: the picker row reverted from the
    // prompt text to the session id the moment the session finished.
    // LIMIT: a session file deleted in the same interval as another is created leaves the
    // count intact, so that pair is picked up on the next size change. Session files are
    // append-only in practice, so this has no observed effect.
    if (live.total !== catalogue.length || hasProvisional(catalogue, liveIds)) {
      // A failed refetch keeps the LAST GOOD roster instead of merging a catalogue already
      // known to be stale — the promise a failed live fetch makes, and the next poll retries.
      try {
        catalogue = await withDeadline(deps.fetchCatalogue, timeoutMs);
      } catch {
        return;
      }
    }
    const next = mergeRoster(catalogue, live);
    // Serve the fresh rows ALWAYS, notify only on identity. The two are different questions:
    // `openFromDropdown` builds a tab out of `current()`, so a row parked behind an unchanged
    // key is a stale tab; while `onChange` redraws the picker, so firing it on every moved
    // mtime would redraw forever. Keying the assignment as well as the notification is what
    // left a repaired record — a refetched catalogue, a settled `lastActivity` — invisible.
    rows = next;
    taken++;
    complete = live.complete;
    const nextKey = rosterKey(next);
    if (nextKey !== key) {
      key = nextKey;
      // Isolated, and NOT because a listener is expected to throw: everything a listener
      // touches is the DOM, and one that does throw used to reject `refresh()` — which meant
      // `arm` never ran and the whole poll was dead for the life of the page (no picker, no
      // busy dot, no ended-detection, no auto-open), plus every listener after it was
      // starved. The poll's liveness must not depend on its subscribers behaving.
      for (const cb of listeners) {
        try {
          cb(rows);
        } catch (err) {
          console.error('seedeep: a roster listener threw', err);
        }
      }
    }
  }

  function arm(): void {
    if (stopped) return;
    // Re-arm on BOTH settlements. `.then(arm)` alone left one unguarded throw able to end the
    // poll permanently — the second belt to the try/catch above, since a future edit inside
    // refresh() must not be able to resurrect that failure mode.
    timer = schedule(() => {
      void refresh().then(arm, arm);
    }, pollMs);
  }

  return {
    async start(): Promise<void> {
      await refresh();
      arm();
    },
    current: () => rows,
    /**
     * How many readings actually landed. `current()` alone cannot tell a fresh answer from the
     * last good one — a failed fetch keeps the previous rows on purpose — so a consumer that
     * needs a SECOND, independent opinion (end-guard.ts) counts these instead of waiting.
     */
    readings: () => taken,
    /**
     * Whether the last landed reading read every directory it met. False means sessions this
     * machine has are MISSING from `current()`, so a consumer must not read a session's absence
     * as the session being over — see `LivePayload.complete`.
     */
    complete: () => complete,
    onChange(cb: (rows: SessionRecord[]) => void): () => void {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    stop(): void {
      stopped = true;
      if (timer) timer.cancel();
    },
  };
}
