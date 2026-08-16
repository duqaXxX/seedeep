import type { NormalizedEvent } from '../core/types.ts';
import { EVENT_TYPES } from './event-types.ts';
import type { EventSourceLike } from './stream.ts';

/**
 * Silence after which a replay read is treated as dead and handed off.
 *
 * On SILENCE, never on duration: a big session legitimately takes a long time to replay, but it
 * is never QUIET while it does — the endpoint is pull-based, one frame per `pull()`, so frames
 * arrive as fast as the consumer takes them. Measured on the largest session on a real machine
 * (30.8 MB, 446 chunks): gap p50 0ms, p99 3ms, worst 6ms. 30s is ~5000x that worst case, so it
 * cannot fire on a slow machine — and it bounds at 30s a freeze that used to have no end.
 */
const REPLAY_STALE_MS = 30_000;

/** First wait before reopening a read that was cut — the stream's own reconnect delay. */
const RETRY_MS = 3_000;
/**
 * Ceiling for the wait, which then repeats at that rate rather than backing off further. A path
 * that is merely down costs one request every 30s per open tab — the live stream already
 * reconnects at 3s.
 */
const MAX_RETRY_MS = 30_000;

/**
 * Consecutive reopens that gain NOTHING before the read gives up.
 *
 * Not a cap on attempts — a cap on futility. A read that advances resets it, so a slow or flaky
 * path is never penalised however many rounds it takes; only a read that dies at the same point
 * every time counts against it, and that one is not coming back: a server-side throw on one line,
 * a proxy cutting at a fixed byte count, a child file that will not open. Left looping, it holds
 * the buffer and the loader for the life of the page while the buffer grows with every live event
 * — the freeze this whole mechanism exists to end, arrived at from the other side.
 */
const MAX_STALE_REOPENS = 3;

// Drive one session's replay, then hand off to the live feed without losing or
// doubling an event. For an ACTIVE session (deps.stream given): subscribe to
// live FIRST and buffer it, replay history, then flush the buffered live events
// the replay did not already emit — deduped on (agentId, seq) — and go live. For
// an INACTIVE session (no stream): just forward replay events and freeze at the end.
//
// The handoff is finalized by `finish()`, which runs exactly once on ANY end of
// the replay connection — the normal `replay-end` frame, a connection `error`,
// an explicit `stop()`, or `staleMs` of SILENCE. That fourth one is what makes the
// guarantee real: the first three all require the connection to SAY something, and a
// path that drops without a FIN says nothing at all. Without it the tab stayed stuck
// buffering, silently swallowing every live event, exactly as it did when the replay
// died early before any of this existed.
//
// `resync()` repeats the same dance for a live stream that broke and came back. Nothing
// re-sends what was emitted while the connection was down, so the tab would keep painting
// silently short of the truth; the file is the only source with no hole in it. It asks for
// the TAIL only (`from=`, built from the marks below) and folds it into the existing reducer —
// rebuilding the tab also worked, but at one interruption every couple of minutes it re-read
// the whole session and visibly re-drew the dashboard.
//
// Dedup is per FILE ('' = parent, else agentId) because the seq spaces are independent — each
// child file starts at 0. A line is NOT one event: it emits several sharing its seq (usage +
// attribution + tool-start), so no single number can say where the tab is. Three do:
//   `covered`  the highest line a REPLAY delivered, i.e. delivered with ALL of its events at
//              once. A live event at or below it is a re-delivery: drop on `<=`.
//   `liveMax`  the frontier of the live feed — a line possibly delivered only in PART, since
//              each of its events is its own SSE frame and a connection can die between two.
//              Live drops only on `<`: `<=` would keep the first event of the frontier line
//              and silently discard the rest, a bug that already shipped once and left tools
//              and subagent state empty live.
//   `liveSeen` how many events of `liveMax` did arrive. Without it the frontier line can only
//              be re-read whole (doubling an applied head — usage is SUMMED, so the totals
//              corrupt) or skipped whole (losing its tail for good). Both are silent.
// So the tab's position is a line AND an offset into it: `whole()` is the last line it holds
// complete — what `from=` carries — and `liveSeen` is what the re-read of the next line skips.
// This is also what protects the tab when the watcher restarts and re-sends the file from seq 0
// down the LIVE path: `stream.ts` clears its own mark on reconnect, so this survives.
export function startReplay(
  sessionId: string,
  handler: (e: NormalizedEvent) => void,
  deps: {
    stream?: { subscribe(id: string, h: (e: NormalizedEvent) => void): () => void };
    EventSourceImpl: new (url: string) => EventSourceLike;
    replayUrl?: (id: string, from?: string) => string;
    onLive?: () => void; // called once at the handoff (replay-end / error / stop / silence)
    /** Silence after which a read is treated as dead. Defaults to {@link REPLAY_STALE_MS}. */
    staleMs?: number;
    /** How often that silence is checked. Defaults to a third of `staleMs`. */
    checkMs?: number;
    /** Clock for the staleness decision — injected so a test can age a read without waiting. */
    now?: () => number;
    /** First wait before reopening a read that was cut. Doubles up to {@link MAX_RETRY_MS}. */
    retryMs?: number;
    /**
     * Whether the session still exists, asked before each reopen. A deleted session answers 404
     * forever and an `EventSource` cannot read a status, so this is the only way to tell a
     * permanent absence from a dropped path. Omitted → the reopen never gives up.
     */
    stillExists?: () => boolean;
  },
): { stop(): void; resync(): void } {
  const covered = new Map<string, number>(); // highest line a replay delivered whole
  const liveMax = new Map<string, number>(); // frontier of the live feed — maybe delivered in part
  const liveSeen = new Map<string, number>(); // events of that frontier line already applied
  let buffering = true;
  let handedOff = false; // onLive has fired: the view is painting, and says so only once
  let inFlight = true; // a replay connection is open and its events are still history
  let stopped = false; // the tab is gone: nothing may reopen a connection
  let resyncPending = false; // a resync was raised mid-read and still owes its tail
  // Whether the CURRENT connection reached the end of the history. The only thing that separates
  // a read that is done from a read that was cut, and the two are indistinguishable on screen.
  let sawEnd = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const baseRetryMs = deps.retryMs ?? RETRY_MS;
  let nextRetryMs = baseRetryMs; // grows per consecutive cut, reset by a read that completes
  /** Whether the CURRENT read has advanced any file's `covered` — see {@link MAX_STALE_REOPENS}. */
  let progressed = false;
  let staleReopens = 0;
  /**
   * Whether any read has ever reached `replay-end`. Until one has, the tab's history may have a
   * HOLE in it, and the live frontier is then proof of nothing: `whole()` must not read it as
   * "every line below this is held". Latched true on the first complete read and left there — a
   * later resync starts from a history that WAS complete, so the frontier means what it says again.
   */
  let historyComplete = false;
  /**
   * The line each file's CURRENT read is on — delivered, but not yet known to be whole: a line is
   * several events sharing one seq, and the read can die between two of them. It becomes `covered`
   * only when a higher seq arrives (nothing more of it can be coming) or the read reaches
   * `replay-end`. Without this a read cut mid-line counted that line as held, and the reopen — which
   * asks strictly PAST what is held — dropped its remaining events for good.
   */
  const frontier = new Map<string, number>();
  /** Events of each line the CURRENT read has processed, per file — counted whether they were
   * applied or skipped, since what it must answer is "how far into this line am I". Per read. */
  const readSeen = new Map<string, Map<number, number>>();
  // What the tab held when the CURRENT connection was opened. A snapshot, because `covered`
  // advances as this very replay streams: measuring against a moving mark drops every event of
  // a line after its first. Empty for the initial replay, which holds nothing.
  let floor = new Map<string, number>();
  /**
   * How many events of each line the tab HOLDS, for lines above the mark it would resume from:
   * file → line seq → count. `floor` cannot express this — it is a single boundary, and what has to
   * be skipped is a scatter of lines above it: the head of the line a read died on, and, once the
   * reopen has given up and released the buffer, every live line applied over the hole.
   *
   * A record of what is HELD, not a budget to spend: a read that skips a line still holds it, and
   * the next read has to skip it again. Getting that backwards made the same line apply on every
   * other round.
   *
   * It exists because re-delivery is not harmless. The reducer is idempotent on it — which is as
   * far as this had been checked — but the FEED appends a second row (and re-points `byId`, so the
   * first never gets its duration), the Trace opens a duplicate span stuck on `running`, and the
   * toast rail, armed at the handoff, announces tools that ran minutes ago.
   */
  const applied = new Map<string, Map<number, number>>();
  /** Count one more event of `seq` in `map` for `key`, and answer the new total. */
  function bump(map: Map<string, Map<number, number>>, key: string, seq: number, n = 1): number {
    let byLine = map.get(key);
    if (!byLine) map.set(key, (byLine = new Map()));
    const next = (byLine.get(seq) ?? 0) + n;
    byLine.set(seq, next);
    return next;
  }
  /** Record that at least `n` events of `seq` are held — for a debt stated by a running total
   * (`liveSeen`) rather than event by event. Never lowers one, and never doubles it when the same
   * resync is asked twice without the line coming back. */
  function holdApplied(key: string, seq: number, n: number): void {
    if (n <= 0) return;
    let byLine = applied.get(key);
    if (!byLine) applied.set(key, (byLine = new Map()));
    byLine.set(seq, Math.max(byLine.get(seq) ?? 0, n));
  }
  const buffer: NormalizedEvent[] = [];
  let unsubscribe: (() => void) | null = null;
  let es: EventSourceLike | null = null;
  const staleMs = deps.staleMs ?? REPLAY_STALE_MS;
  const checkMs = deps.checkMs ?? Math.max(1, Math.round(staleMs / 3));
  const now = deps.now ?? (() => Date.now());
  let lastFrameAt = now(); // when the current read last proved it is still a read

  const keyOf = (e: NormalizedEvent) => e.agentId ?? '';

  /**
   * The last line of one file this tab holds COMPLETE — what a resync must ask past. The live
   * frontier does not count as complete: only the line before it is, since the feed can have
   * died between two events of the frontier itself.
   */
  function whole(key: string): number | undefined {
    const c = covered.get(key);
    // A history that has never been read to the end may have a hole in the middle, and a live line
    // proves only itself. Answering `liveMax - 1` there asks the server to start past everything
    // the read never delivered — the gap is then permanent, and the reopen that fills it reaches
    // `replay-end` and calls the tab complete.
    if (!historyComplete) return c;
    const l = liveMax.get(key);
    const lw = l === undefined ? undefined : l - 1;
    if (c === undefined) return lw;
    if (lw === undefined) return c;
    return Math.max(c, lw);
  }

  function deliver(e: NormalizedEvent, source: 'replay' | 'live'): void {
    if (e.seq >= 0) {
      const key = keyOf(e);
      if (source === 'replay') {
        const f = floor.get(key);
        if (f !== undefined && e.seq <= f) return; // held complete before this read opened
        // How far into this line THIS read has come, against how much of it the tab already holds:
        // the server re-sends a line from its top, so the head is skipped by count (see `applied`).
        if (bump(readSeen, key, e.seq) <= (applied.get(key)?.get(e.seq) ?? 0)) return;
        bump(applied, key, e.seq); // held from now on, for whatever read comes next
        const at = frontier.get(key);
        // A higher seq proves the line below it is complete — nothing more of it can arrive.
        if (at === undefined || e.seq > at) {
          if (at !== undefined && at > (covered.get(key) ?? -1)) {
            covered.set(key, at);
            progressed = true; // this read gained ground; it has earned another reopen
          }
          frontier.set(key, e.seq);
        }
      } else {
        const c = covered.get(key);
        if (c !== undefined && e.seq <= c) return; // a replay already delivered this line whole
        const l = liveMax.get(key);
        if (l !== undefined && e.seq < l) return; // an earlier line, re-sent
        if (l === e.seq) liveSeen.set(key, (liveSeen.get(key) ?? 0) + 1);
        else {
          liveMax.set(key, e.seq);
          liveSeen.set(key, 1);
        }
        // Applied over a HOLE: the mark this tab will resume from sits below this line, so the
        // re-read is going to send it again. Only while the history is incomplete — once a read has
        // reached the end, `whole()` answers from the live frontier and the ordinary one-line
        // handover below covers it, which is what keeps this map from growing with the session.
        if (!historyComplete) bump(applied, key, e.seq);
      }
    }
    handler(e);
  }

  // 1. Subscribe to live FIRST (active session), buffering until the replay ends.
  if (deps.stream) {
    unsubscribe = deps.stream.subscribe(sessionId, (e) => {
      if (buffering) buffer.push(e);
      else deliver(e, 'live');
    });
  }

  const urlFor =
    deps.replayUrl ??
    ((id: string, from?: string) =>
      `/api/replay?sessionId=${encodeURIComponent(id)}` + (from ? `&from=${encodeURIComponent(from)}` : ''));

  // 2. Open a replay connection — the whole session, or (on a resync) only the tail.
  function open(from?: string): void {
    buffering = true;
    inFlight = true;
    sawEnd = false;
    progressed = false;
    // Per READ, not per tab: it holds the line THIS connection is on. Carried over, a reopen that
    // re-reads the line the last one died on would see its own seq as "not higher" and never
    // promote it to `covered`, so the read could gain ground without ever being able to say so.
    frontier.clear();
    readSeen.clear();
    lastFrameAt = now(); // a fresh read starts its own window; the previous one's silence is spent
    const src = new deps.EventSourceImpl(urlFor(sessionId, from));
    es = src;
    for (const type of EVENT_TYPES) {
      src.addEventListener(type, (raw) => {
        // A connection this read has moved on from is not evidence of anything. The dedup would
        // drop its events anyway, but `lastFrameAt` is the point: a frame queued before the old
        // socket closed would otherwise vouch for the NEW read's liveness (same guard as
        // stream.ts).
        if (es !== src) return;
        lastFrameAt = now();
        let e: NormalizedEvent;
        try {
          e = JSON.parse(raw.data);
        } catch {
          return;
        }
        deliver(e, 'replay');
      });
    }
    // Both carry the same `es !== src` gate as the data listeners above, and for a reason that only
    // exists now that a cut read reopens: a socket already given up on can still dispatch what was
    // queued before its close, and `inFlight` is true again by then. Ungated, a stale `replay-end`
    // closed the NEW read and marked its half-history complete — with the retry disarmed, since the
    // read had "ended".
    src.addEventListener('replay-end', () => {
      if (es !== src) return;
      // Recorded BEFORE the handoff, because it is what `finish()` decides on: the one frame that
      // says the history is all here. Every line this read delivered is now known whole.
      sawEnd = true;
      for (const [key, seq] of frontier) covered.set(key, Math.max(covered.get(key) ?? -1, seq));
      // Nothing is owed any more: this read went to the end, so every line the tab holds is either
      // under `covered` or is the live tail the ordinary handover covers.
      applied.clear();
      finish();
    });
    src.addEventListener('error', () => {
      if (es !== src) return;
      finish(); // the connection died before replay-end → the history is short, so reopen
    });
  }

  // The third way a read ends, and the only one a silently cut path produces: it just stops.
  // `replay-end` and `error` both require the connection to SAY something, and a peer that
  // vanished without a FIN says nothing — an SSE connection only receives, so nothing on this
  // side ever fails. Without this the read would sit `inFlight` for good, and nothing would ever
  // reopen it: the tab freezes behind a stream that still looks healthy.
  //
  // At 30s against a measured worst gap of 6ms it cannot fire on a read that is merely slow.
  function watchSilence(): void {
    if (stopped || !inFlight) return;
    if (now() - lastFrameAt < staleMs) return;
    finish();
  }

  // 3. End the current read. Idempotent per connection — the first of replay-end / error / stop /
  //    silence wins. Whether it is also the end of the HISTORY is a different question, and the
  //    whole of what this decides: a read that reached `replay-end` hands off, a read that was CUT
  //    reopens instead.
  function finish(): void {
    if (!inFlight) return;
    inFlight = false;
    es?.close();
    es = null;
    // A cut read holds a PARTIAL history, and until the rest of it arrives the tab must not be told
    // anything is live. Keeping the buffer shut is not a detail — it is what makes the reopen
    // sound. Applying those events would set the live frontier, and `whole()` reads that frontier
    // as proof the tab holds every line below it: a tab holding lines 0..2 and a stray line 500
    // would resume `from=:499` and lose the middle for good, then reach `replay-end` and call
    // itself complete. The reader sees the loader a while longer, which is the truth.
    //
    // `stopped` flushes anyway: the tab is closing and there is no later read to wait for.
    if (sawEnd) historyComplete = true;
    // An ask from outside is owed its read NOW, and it is also the retry — consumed here rather
    // than after the retry branch, where it survived to open a second, redundant read of the same
    // tail once that retry finished.
    if (!stopped && resyncPending) {
      resyncPending = false;
      askedFromOutside();
      if (sawEnd) handOff(); // a complete read releases first; a cut one still owes its history
      doResync();
      return;
    }
    if (!sawEnd && !stopped) {
      staleReopens = progressed ? 0 : staleReopens + 1;
      // Futility, not attempts (see MAX_STALE_REOPENS): a read that will never get further is not
      // worth another round, and holding the buffer for it is the freeze this replaced.
      if (staleReopens < MAX_STALE_REOPENS) {
        scheduleRetry();
        return;
      }
    }
    handOff();
    if (stopped) return;
    nextRetryMs = baseRetryMs; // the path works; the next cut starts its backoff over
  }

  /**
   * Release what the tab holds: flush the live events held back during the read, then let live
   * through directly. Called once the history is complete — or once nothing more of it is coming.
   */
  function handOff(): void {
    buffering = false;
    for (const e of buffer) deliver(e, 'live');
    buffer.length = 0;
    if (!handedOff) {
      handedOff = true;
      deps.onLive?.(); // history is done; the consumer may now treat events as live
    }
  }

  /**
   * An ask from OUTSIDE — the live stream recovering, or the session being resumed — is new
   * information, not another of this reader's own attempts, so it starts over: the backoff goes
   * back to its first wait and the futility budget is refilled. Carrying the spent budget made the
   * recovery path `app.ts` provides a dead letter: the ask opened one read and abandoned it on the
   * first cut, with no retry at all.
   */
  function askedFromOutside(): void {
    nextRetryMs = baseRetryMs;
    staleReopens = 0;
  }

  /** Reopen a cut read after a growing wait. One pending at a time; `stop()` cancels it. */
  function scheduleRetry(): void {
    if (stopped || retryTimer !== null) return;
    const wait = nextRetryMs;
    nextRetryMs = Math.min(nextRetryMs * 2, MAX_RETRY_MS);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      // `inFlight` guards the race with an outside `resync()` that opened a read meanwhile: two
      // concurrent connections would each answer from the same marks and double-deliver the tail.
      if (stopped || inFlight) return;
      // A session that is GONE answers 404 forever, and an EventSource cannot see a status code —
      // it fires the same contentless `error` a dropped path does. The caller knows the difference
      // (it holds the roster), so it is asked. Giving up hands off what the tab has: holding the
      // loader for a history that is never coming is the one thing worse than showing it short.
      // LIMIT: whichever way it gives up, the tab is left holding a history that is SHORT, with
      // nothing on screen saying so — the state this mechanism exists to end, kept only for the
      // case where no read can end it. What fills it afterwards is an ask from outside (a live
      // stream recovering, a session resumed); failing that, the gap lasts until the tab is
      // reopened. Saying so on screen is a product decision, deliberately not taken here.
      if (deps.stillExists && !deps.stillExists()) {
        handOff();
        return;
      }
      doResync();
    }, wait);
    // A timer that keeps a process alive is a Node/Bun concern (tests, the compiled binary);
    // browsers have no unref and ignore this.
    (retryTimer as unknown as { unref?: () => void }).unref?.();
  }

  // Ask for the tail of every file the tab has seen, from the last line it holds COMPLETE.
  function doResync(): void {
    // Whoever gets here is opening the read a queued retry was going to open. Leaving it armed
    // would open a second one over the same marks.
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    floor = new Map();
    // LIMIT: one `key:seq` pair per file the tab has seen, which for a Workflow run of ~100
    // subagents is ~1.4 KB of query string. Well inside any URL limit, but it does grow with
    // the run — a session with thousands of children would need a different carrier.
    const pairs: string[] = [];
    // `applied` keys too: a file the tab knows ONLY from the live feed — a subagent born after the
    // reopen gave up — has no `covered` and no mark, so the server replays it whole (its contract:
    // "a file absent from the map is replayed whole"). It must still be in this loop, or the lines
    // it already holds of that child come back and are applied a second time.
    for (const key of new Set([...covered.keys(), ...liveMax.keys(), ...applied.keys()])) {
      const w = whole(key);
      if (w === undefined) continue;
      floor.set(key, w);
      // The live frontier's own head, for a tab whose history IS complete: below, the same debt is
      // recorded event by event as it is applied, so recording it again here would double it.
      const l = liveMax.get(key);
      if (historyComplete && l !== undefined && l > w) holdApplied(key, l, liveSeen.get(key) ?? 0);
      if (w >= 0) pairs.push(`${key}:${w}`); // nothing complete yet → let the server send it whole
    }
    open(pairs.join(',') || undefined);
  }

  open();
  const watchdog = setInterval(watchSilence, checkMs);
  // A timer that keeps a process alive is a Node/Bun concern (tests, the compiled binary);
  // browsers have no unref and ignore this.
  (watchdog as unknown as { unref?: () => void }).unref?.();

  return {
    stop() {
      stopped = true; // before finish(), which would otherwise run a deferred resync or a retry
      clearInterval(watchdog);
      if (retryTimer !== null) {
        clearTimeout(retryTimer); // a reopen armed by an earlier cut must not outlive the tab
        retryTimer = null;
      }
      // `finish()` returns at once when nothing is in flight, which is exactly what a pending
      // reopen leaves behind — so a tab closed between two attempts released nothing and never
      // told the view. A closing tab hands over what it holds either way.
      if (inFlight) finish();
      else handOff();
      if (unsubscribe) unsubscribe();
    },
    /**
     * The live stream broke and came back: pull the lines this tab missed. While a read is
     * already in flight the resync is DEFERRED, not dropped — that read reached the file's end
     * when it was requested, i.e. before the outage, so it does not cover the hole. Nothing
     * else would re-arm it (`app.ts` clears `feedWasLost` before the loop), and the tab would
     * paint short of the truth until it was closed.
     */
    resync() {
      // Same rule `finish()` applies to a DEFERRED resync: a closed tab must not resurrect its
      // feed. It was stated there and not here, so a call landing after stop() opened a read
      // anyway — and one nothing watches, since stop() has already cleared the watchdog.
      if (stopped) return;
      askedFromOutside();
      if (inFlight) {
        resyncPending = true;
        return;
      }
      doResync();
    },
  };
}
