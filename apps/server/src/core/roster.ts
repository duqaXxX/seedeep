import { ACTIVE_WINDOW_MS, isLive, type Root, type SessionRecord } from './types.ts';

/**
 * A session as the CATALOGUE knows it: everything that stops changing once the session's
 * file exists. This is what the picker needs to list a session and what the workspace needs
 * to restore a tab — and it is stable, so it can be fetched once instead of polled.
 *
 * The volatile half (`isActive`/`isOpen`/`status`/`waitingFor`/`waitingSince`) is deliberately
 * absent: it belongs to {@link LivePayload}, which is small enough to poll. `lastActivity` is
 * split between the two — final here for a session that is not live, null while it IS live,
 * because an mtime that moves on every write is exactly what made the whole roster
 * unpollable.
 */
export interface CatalogueRecord {
  sessionId: string;
  project: string;
  model: string | null;
  subject: string | null;
  entrypoint: string | null;
  root: Root;
  path: string;
  /** Final mtime (epoch ms). Null while the session is live — the live poll owns it then. */
  lastActivity: number | null;
}

/** What the 3s poll carries: the live sessions in full, plus the size of the catalogue. */
export interface LivePayload {
  /**
   * How many sessions the catalogue holds server-side. The client refetches the catalogue
   * when this stops matching what it has — the one cue that a session was born.
   */
  total: number;
  sessions: SessionRecord[];
  /**
   * Whether `~/.claude/sessions/` answered this scan. It is a property of the SCAN, not of a
   * session — discovery writes `isOpen: null` on every record when that dir is absent — so it
   * travels once per poll and lets the merge rebuild the tri-state instead of flattening it.
   */
  pidVisible: boolean;
}

/** Project a full record onto the catalogue half; `lastActivity` survives only if final. */
export function toCatalogue(s: SessionRecord): CatalogueRecord {
  return {
    sessionId: s.sessionId,
    project: s.project,
    model: s.model,
    subject: s.subject,
    entrypoint: s.entrypoint,
    root: s.root,
    path: s.path,
    lastActivity: isLive(s) ? null : s.lastActivity,
  };
}

/** Split a roster into what the poll sends: the live sessions, and how many exist in total. */
export function liveOf(roster: readonly SessionRecord[]): LivePayload {
  return {
    total: roster.length,
    sessions: roster.filter(isLive),
    // Vacuously true for an empty roster: there is nothing to rebuild the tri-state for.
    pidVisible: roster.every((r) => r.isOpen !== null),
  };
}

/**
 * Rebuild the full roster from its two halves. The result must equal what an undivided
 * `/api/sessions` would have returned — that equality is the contract, and the test that
 * pins it is the whole safety net of the split.
 *
 * The caller owes this function a catalogue that is not stale: a PROVISIONAL record (taken
 * while its session was live, so `lastActivity` is null) for a session the payload no longer
 * lists must be refetched BEFORE merging, or the merge serves a birth snapshot — see
 * `hasProvisional` in `client/sessions.ts`.
 *
 * A live session the catalogue does not know yet is appended, not dropped: it was born
 * after the last catalogue fetch, and it must be offered a tab now, not in three seconds.
 *
 * `now` is injectable so a test can state the instant instead of racing the clock across the
 * 5-minute `isActive` window.
 */
export function mergeRoster(
  catalogue: readonly CatalogueRecord[],
  live: LivePayload,
  now: number = Date.now(),
): SessionRecord[] {
  const liveById = new Map(live.sessions.map((s) => [s.sessionId, s]));
  const rows = catalogue.map((c) => liveById.get(c.sessionId) ?? ended(c, live.pidVisible, now));
  const known = new Set(catalogue.map((c) => c.sessionId));
  for (const s of live.sessions) if (!known.has(s.sessionId)) rows.push(s);
  // Most recent first — discovery's own order (discovery.ts), reapplied here because the
  // catalogue's order freezes at fetch time while `lastActivity` keeps moving under it.
  rows.sort((a, b) => b.lastActivity - a.lastActivity);
  return rows;
}

/**
 * A catalogue record the live payload did not claim, as a full record. Absence from the
 * payload IS the answer — the server filtered it with `isLive` — so the session is not live,
 * which is NOT the same as saying nothing was written recently: a session whose process just
 * exited keeps a fresh mtime, so `isActive` is recomputed, not zeroed. `isOpen` reports what
 * the scan could actually see: false when the PID dir answered, null when it did not.
 * Flattening that null to false would claim the mechanism said "no" when it was never asked.
 */
function ended(c: CatalogueRecord, pidVisible: boolean, now: number): SessionRecord {
  // LIMIT: `null` here means the caller merged a provisional record anyway, which only happens
  // when the catalogue is NEWER than the live payload — a session resumed, or born, between the
  // two requests. The row reads as the epoch for that one poll; the next one, whose payload has
  // caught up, either lists it live or refetches the catalogue for a final mtime.
  const lastActivity = c.lastActivity ?? 0;
  return {
    sessionId: c.sessionId,
    project: c.project,
    model: c.model,
    subject: c.subject,
    entrypoint: c.entrypoint,
    root: c.root,
    path: c.path,
    lastActivity,
    // NOT hardcoded false: `isActive` is a pure function of the mtime and the window, so the
    // client recomputes it from the same definition discovery uses instead of carrying it.
    // Hardcoding it would have the merged row claim "nothing written for 5 minutes" about a
    // file touched a second ago — the split must not invent facts it can derive.
    isActive: now - lastActivity <= ACTIVE_WINDOW_MS,
    isOpen: pidVisible ? false : null,
    status: null,
    waitingFor: null,
    waitingSince: null,
  };
}
