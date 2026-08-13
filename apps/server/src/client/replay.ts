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
  // What the tab held when the CURRENT connection was opened. A snapshot, because `covered`
  // advances as this very replay streams: measuring against a moving mark drops every event of
  // a line after its first. Empty for the initial replay, which holds nothing.
  let floor = new Map<string, number>();
  // Head of the re-read frontier line already applied live, consumed as it comes back.
  let skip = new Map<string, { seq: number; n: number }>();
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
    const c = covered.get(key),
      l = liveMax.get(key);
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
        const s = skip.get(key);
        if (s !== undefined && s.n > 0 && e.seq === s.seq) {
          s.n--;
          return;
        } // already applied live
        covered.set(key, Math.max(covered.get(key) ?? -1, e.seq));
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
    src.addEventListener('replay-end', () => finish());
    src.addEventListener('error', () => finish()); // connection died before replay-end → still hand off
  }

  // The third way a read ends, and the only one a silently cut path produces: it just stops.
  // `replay-end` and `error` both require the connection to SAY something, and a peer that
  // vanished without a FIN says nothing — an SSE connection only receives, so nothing on this
  // side ever fails. Left alone, `inFlight` stays true, every live event goes into `buffer` and
  // none comes out, and `resync()` is a permanent no-op: the tab freezes behind a stream that
  // still looks healthy.
  //
  // LIMIT: handing off early leaves the tab's history SHORT, with nothing on screen saying so.
  // The next resync fills it from the mark this read did reach — for an ENDED session that is the
  // one `revive` performs if it is resumed (app.ts), and failing that the gap lasts until the tab
  // is reopened. It is still the cheaper wrong — buffering forever has no exit — and at 30s
  // against a measured worst gap of 6ms it should never trigger on a read that is merely slow.
  function watchSilence(): void {
    if (stopped || !inFlight) return;
    if (now() - lastFrameAt < staleMs) return;
    finish();
  }

  // 3. Finalize: flush what live sent while we were reading, then let live through directly.
  //    Idempotent per connection — the first of replay-end / error / stop / silence wins.
  function finish(): void {
    if (!inFlight) return;
    inFlight = false;
    buffering = false;
    for (const e of buffer) deliver(e, 'live');
    buffer.length = 0;
    es?.close();
    es = null;
    if (!handedOff) {
      handedOff = true;
      deps.onLive?.(); // history is done; the consumer may now treat events as live
    }
    // A resync raised while this read was in flight is owed its tail now — after the buffer
    // flush, so it asks from the tab's freshest position. Never once stopped: a closed tab
    // must not resurrect its feed.
    if (resyncPending && !stopped) {
      resyncPending = false;
      doResync();
    }
  }

  // Ask for the tail of every file the tab has seen, from the last line it holds COMPLETE,
  // and arm the skip for the frontier line that read will re-send.
  function doResync(): void {
    floor = new Map();
    skip = new Map();
    // LIMIT: one `key:seq` pair per file the tab has seen, which for a Workflow run of ~100
    // subagents is ~1.4 KB of query string. Well inside any URL limit, but it does grow with
    // the run — a session with thousands of children would need a different carrier.
    const pairs: string[] = [];
    for (const key of new Set([...covered.keys(), ...liveMax.keys()])) {
      const w = whole(key);
      if (w === undefined) continue;
      floor.set(key, w);
      const l = liveMax.get(key);
      if (l !== undefined && l > w) skip.set(key, { seq: l, n: liveSeen.get(key) ?? 0 });
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
      stopped = true; // before finish(), which would otherwise run a deferred resync
      clearInterval(watchdog);
      finish(); // flush what we have, then release the live subscription
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
      if (inFlight) {
        resyncPending = true;
        return;
      }
      doResync();
    },
  };
}
