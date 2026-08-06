// The tab workspace, across a page refresh. A refresh used to reset it: tabs opened from
// the picker vanished and the active one was whatever the roster happened to list last.
//
// Two things are saved, and they answer different questions. `ids` is which tabs EXIST —
// restored verbatim, so a tab you closed stays closed. `known` is which sessions have
// already been OFFERED one, which is what stops the auto-open rule from handing back the
// tab you just closed (the session is still live, so nothing else could tell them apart).
//
// `load()` therefore distinguishes "never saved" (null → the caller opens the live
// sessions, the first-visit behaviour) from "saved, and it was empty" ([] → open nothing).
// Collapsing the two would resurrect every tab you deliberately closed, on every refresh.
//
// Storage is best-effort by construction: reading `localStorage` THROWS outright in a
// browser with storage disabled, and `setItem` throws on quota. Neither is a reason to
// break the app, so every access is guarded and a dead storage simply degrades to opening
// the live sessions.

const KEY = 'seedeep.tabs.v1';

// `known` may never be pruned by liveness — a session blinking out of the PID scan for one
// poll would take its entry with it and the rule would re-offer a closed tab (see
// sessionsToAutoOpen). So growth is bounded HERE, where dropping an id cannot resurrect
// anything: only the most recent are kept, and the ids that fall off the end are the oldest
// — long-dead sessions that the rule ignores anyway, since it only ever offers live ones.
const MAX_KNOWN = 500;

export interface TabState {
  /** Open tabs, left-to-right — the strip's order is part of the workspace. */
  ids: string[];
  /** The tab that was in front, or null. */
  activeId: string | null;
  /**
   * Sessions seedeep has already offered a tab for, oldest first. A live session that is NOT
   * here gets one by itself; closing that tab removes it from `ids` but never from here,
   * which is what makes "offer it once" different from "reopen what I closed on every poll".
   * Only the newest {@link MAX_KNOWN} survive a save.
   */
  known: string[];
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface TabStore {
  /** The saved workspace, or null when nothing was ever saved / it cannot be trusted. */
  load(): TabState | null;
  /** Persist the workspace. Never throws — a failed write just means no restore. */
  save(state: TabState): void;
}

/**
 * The tab workspace's persistence: `{ids, activeId, known}` (see {@link TabState}). Pass
 * `null` (or a storage that throws) and it becomes a no-op that always reports "nothing
 * saved", so the caller falls back to opening the live sessions.
 *
 * `load()` returns null for anything it cannot vouch for — absent key, unparseable JSON, or
 * an `ids` that is not a string array — never a half-read workspace. `known` is the one
 * field that degrades instead of voiding the entry: absent (a workspace saved before it
 * existed) or malformed, it falls back to `ids`, since the tabs on screen have certainly
 * been offered. `save()` caps `known` at {@link MAX_KNOWN}, newest kept.
 */
export function createTabStore(storage: StorageLike | null | undefined): TabStore {
  return {
    load(): TabState | null {
      try {
        const raw = storage?.getItem(KEY);
        if (raw == null) return null;
        const v = JSON.parse(raw) as unknown;
        if (!v || typeof v !== 'object') return null;
        const { ids, activeId, known } = v as { ids?: unknown; activeId?: unknown; known?: unknown };
        // A malformed entry is treated as no entry: restoring half of it would open an
        // arbitrary subset of tabs, which is worse than honestly starting from scratch.
        if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string')) return null;
        // `known` arrived after `ids`, so a workspace saved by an older build has none.
        // Falling back to `ids` is the honest reading — we have certainly offered the
        // sessions we are showing — and it beats `[]`, which would re-offer them all.
        const knownOk = Array.isArray(known) && known.every((x) => typeof x === 'string');
        return {
          ids: ids as string[],
          activeId: typeof activeId === 'string' ? activeId : null,
          known: knownOk ? (known as string[]) : (ids as string[]),
        };
      } catch {
        return null;
      }
    },
    save(state: TabState): void {
      try {
        storage?.setItem(
          KEY,
          JSON.stringify({
            ids: [...state.ids],
            activeId: state.activeId ?? null,
            known: state.known.slice(-MAX_KNOWN), // newest kept; the oldest are long-dead ids
          }),
        );
      } catch {
        // storage disabled or full — the workspace just won't survive the refresh
      }
    },
  };
}
