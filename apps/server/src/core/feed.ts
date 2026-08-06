// The live activity ring: the N most-recent-BY-TIMESTAMP activities across the whole
// session (API calls, main tools, subagent tools, subagent spawns). An API-call row is
// emitted before the tools that call decided, giving the timeline its call→tools shape.
//
// Ordering is by timestamp, NOT by arrival order, and that is the whole point: replay
// emits the entire parent file, THEN each child file whole, so arrival order would end
// on an old subagent's tail rather than the session's genuinely latest event.
//
// Retention is per TURN, not global: the view can scope every widget to one turn, and a
// globally-capped ring would have already evicted an older turn's events by the time it
// is selected, leaving that turn's feed permanently empty. Keeping the last `cap` items
// of each turn keeps the structure bounded (cap × turns) while making any turn scopable.
//
// A pure data structure, no DOM — the renderer reads `items()` and draws.
export interface FeedItem {
  /** tool_use_id — the key a later tool-end uses to fill in the duration. */
  id?: string | null;
  name: string;
  arg?: string | null;
  /** True for an API-call row (a `usage` event's first line) rather than a tool activity. */
  apiCall?: boolean;
  /** message.id of the API call — the handle the drawer fetches its I/O with. Null for a synthetic error line. */
  callId?: string | null;
  /** True when the tool ran, OR the API call was made, inside a subagent rather than the main session. */
  sub?: boolean;
  /** An `Agent` tool-start IS a subagent spawn. */
  spawn?: boolean;
  subagentType?: string | null;
  launchPrompt?: string | null;
  /** Turn this activity belongs to (a subagent's tools belong to its spawning turn); null when unknown. */
  turnIndex?: number | null;
  /** Sort key (epoch ms); 0 when the event carried no usable timestamp. */
  ts: number;
  /** Start instant, or null when unknown — a null start can never be given a duration. */
  startMs: number | null;
  /** Duration in ms, filled in by the matching tool-end; null while running. */
  ms: number | null;
  /**
   * This activity FAILED: a tool whose result came back a real error, or an API call Claude
   * Code flagged `isApiErrorMessage`. User refusals are excluded upstream (see toolOutcome).
   * A tool's flag is filled at its tool-end via `fail()`; a call's is set when it is pushed.
   */
  error?: boolean;
  /** For a failed API call, the message the user was shown ("You've hit your session limit"). */
  errorMessage?: string | null;
  /**
   * This row LAUNCHED a background command, so its tool-end was only a receipt: the outcome
   * arrives later, via `outcome()`. Set from the receipt's `backgroundTaskId` — the flag is what
   * keeps a later notification from being applied to a row that ran no command.
   */
  background?: boolean;
}

/** Epoch ms from an ISO timestamp, or null when it is absent/unparseable. */
export function tsMs(t: string | null | undefined): number | null {
  const n = Date.parse(t ?? '');
  return Number.isFinite(n) ? n : null;
}

export interface Feed {
  /** Insert an item, keeping the ring ordered by timestamp and capped per turn. */
  push(item: FeedItem): void;
  /**
   * Fill in a running item's duration from its tool-end (and mark it failed when the tool-end
   * says so). Returns true when something changed — including when only the error flag flipped,
   * so a zero-duration failure still repaints.
   */
  end(toolUseId: string, endTs: string | null | undefined, error?: boolean): boolean;
  /**
   * A background command's fate, arriving long after its row closed. Applies ONLY to a row that
   * launched one (`background`), so a notification naming some other tool — a resumed subagent's
   * SendMessage, a Monitor — changes nothing. `summary` is Claude Code's own sentence and is kept
   * only when the news is bad, since that is the case the row cannot otherwise state.
   * Returns true when something changed.
   */
  outcome(toolUseId: string, failed: boolean, summary: string | null): boolean;
  /** Record that this row launched a background command. Returns true when it was not already. */
  mark(toolUseId: string): boolean;
  /**
   * Oldest first (the caller renders newest-first by walking it in reverse).
   * No argument → the whole session's last `cap` activities. With a turn index →
   * that turn's activities (at most `cap`), which is what the turn-scoped view shows.
   */
  items(turnIndex?: number | null): readonly FeedItem[];
}

const DEFAULT_CAP = 10;

/**
 * Create the activity ring: timestamp-ascending, keeping at most `cap` items PER TURN
 * (so any turn stays scopable) and never more than `cap` in the whole-session view.
 */
export function createFeed(cap: number = DEFAULT_CAP): Feed {
  const ring: FeedItem[] = [];
  const byId = new Map<string, FeedItem>();
  const turnOf = (it: FeedItem): number | null => it.turnIndex ?? null;

  return {
    push(item) {
      // Linear scan from the tail: the ring is tiny, and this places an out-of-order
      // replay event at its true position instead of appending it as "latest".
      const ts = item.ts ?? 0;
      let i = ring.length;
      while (i > 0 && (ring[i - 1]!.ts ?? 0) > ts) i--;
      ring.splice(i, 0, item);
      if (item.id) byId.set(item.id, item);
      // Evict within this item's TURN only (oldest timestamp first) — a global cap would
      // silently empty the feed of every turn but the last, which is exactly what the
      // turn-scoped view needs to show.
      const turn = turnOf(item);
      let n = 0;
      for (const it of ring) if (turnOf(it) === turn) n++;
      while (n > cap) {
        const idx = ring.findIndex((it) => turnOf(it) === turn);
        const dropped = ring.splice(idx, 1)[0]!;
        // Only drop the index entry if it still points at THIS item: a re-used
        // tool_use_id would otherwise evict the live item along with the stale one.
        if (dropped.id && byId.get(dropped.id) === dropped) byId.delete(dropped.id);
        n--;
      }
    },

    end(toolUseId, endTs, error) {
      const it = byId.get(toolUseId);
      if (!it) return false;
      let changed = false;
      // The error verdict lands even when the duration cannot (unknown start): a failed tool
      // must still show its badge. A tool never un-fails, so this only ever sets the flag.
      if (error && !it.error) {
        it.error = true;
        changed = true;
      }
      if (it.startMs != null) {
        const e = tsMs(endTs);
        if (e != null && it.ms !== e - it.startMs) {
          it.ms = e - it.startMs;
          changed = true;
        }
      }
      return changed;
    },

    mark(toolUseId) {
      const it = byId.get(toolUseId);
      if (!it || it.background) return false;
      it.background = true;
      // Nothing VISIBLE changed — the row is unchanged until its outcome arrives — but the
      // caller folds this into its repaint decision, so report the state change honestly.
      return true;
    },

    outcome(toolUseId, failed, summary) {
      const it = byId.get(toolUseId);
      if (!it?.background) return false;
      // Not a latch, unlike `end()`'s error flag: a command's status is only ever superseded by
      // a later statement about that same command, and the last one is the true one.
      // Compared against the ABSENT state, not against `false`: an untouched row carries
      // undefined, and reading that as a difference repainted every clean outcome.
      const message = failed ? summary : null;
      if ((it.error ?? false) === failed && (it.errorMessage ?? null) === message) return false;
      it.error = failed;
      it.errorMessage = message;
      return true;
    },

    items(turnIndex) {
      if (turnIndex === undefined) return ring.slice(-cap);
      return ring.filter((it) => turnOf(it) === turnIndex);
    },
  };
}
