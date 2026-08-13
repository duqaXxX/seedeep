type Timer = { cancel(): void };

export interface EndGuardDeps {
  /** How long to wait before believing it. Must exceed one roster poll, or nothing is re-read. */
  delayMs: number;
  /** Injected in tests so the confirmation window can be elapsed on demand. */
  schedule?: (fn: () => void, ms: number) => Timer;
  /**
   * How many independent readings the source has taken. The confirmation is only spent once
   * this has MOVED since the window opened — a roster whose poll failed serves the previous
   * snapshot unchanged, and re-reading it would confirm the very reading under question.
   */
  reading: () => number;
  /** Asked at confirmation time, against a roster that has polled again since. */
  stillGone: (sessionId: string) => boolean;
  /** Commit: the session really is over. Called at most once per confirmed window. */
  end: (sessionId: string) => void;
}

/**
 * Delays acting on "this session's process is gone" until a second, independent reading
 * agrees — independent meaning `reading()` has MOVED, not merely that time passed. Returns
 * `{ gone(id), cancel(id) }`: `gone` opens a confirmation window (one per session, repeat
 * calls do not stack), `cancel` closes it unfired.
 *
 * Why the wait exists: `isOpen` comes from a PID file Claude Code REWRITES on every status
 * change, and `listOpenSessions` skips a file it catches mid-rewrite — so a running session
 * can be absent from exactly one poll. Ending a tab freezes the graph into its ended
 * presentation, so a single reading is not enough evidence to spend it on: that blink froze
 * healthy sessions until the page was reloaded. The same JSDoc reasoning already protects
 * `known` in sessions.ts; this is the other consumer that had not caught up.
 *
 * The freeze is undone by `revive` (app.ts) when the session comes back, so a blink now costs a
 * few seconds of wrong presentation rather than the tab — but that is a repair, not a licence to
 * end on one reading: it happens seconds late, drops the live chrome in between, and sends the tab
 * back to the server for a tail it never lost.
 */
export function createEndGuard(deps: EndGuardDeps) {
  const schedule =
    deps.schedule ??
    ((fn, ms) => {
      const t = setTimeout(fn, ms);
      return { cancel: () => clearTimeout(t) };
    });
  const pending = new Map<string, Timer>();

  return {
    /** The roster says this session is not live. Start (or keep) its confirmation window. */
    gone(sessionId: string): void {
      if (pending.has(sessionId)) return; // already waiting — a second sighting is not new evidence
      const at = deps.reading();
      // Re-arms rather than gives up when no fresh reading arrived: `gone` is driven by a
      // roster identity CHANGE, so a window dropped unconfirmed would never be re-opened and a
      // session that really ended would stay live for the life of the page. Waiting costs one
      // timer and repairs itself the moment the source answers again.
      const arm = (): Timer =>
        schedule(() => {
          if (deps.reading() <= at) {
            pending.set(sessionId, arm());
            return;
          }
          pending.delete(sessionId);
          if (deps.stillGone(sessionId)) deps.end(sessionId);
        }, deps.delayMs);
      pending.set(sessionId, arm());
    },
    /** It came back, or the tab is gone: drop any window without firing it. */
    cancel(sessionId: string): void {
      pending.get(sessionId)?.cancel();
      pending.delete(sessionId);
    },
  };
}
