import type { NormalizedEvent } from '../core/types.ts';
import { HEARTBEAT_EVENT } from '../core/wire.ts';
import { EVENT_TYPES } from './event-types.ts';

export interface EventSourceLike {
  addEventListener(type: string, cb: (ev: { data: string }) => void): void;
  close(): void;
  /** 0 CONNECTING, 1 OPEN, 2 CLOSED — absent on a test double that does not model it. */
  readonly readyState?: number;
}

/** Whether the live feed is currently arriving. `lost` covers both dropped and reconnecting. */
export type StreamStatus = 'open' | 'lost';

const CLOSED = 2;
const RETRY_MS = 3000;
/**
 * Silence after which a connection is treated as dead, however healthy the browser believes it is.
 *
 * Three missed heartbeats: the server writes one every `HEARTBEAT_MS` (15s), and this MUST stay
 * comfortably above that — a client stricter than the server's own cadence declares a perfectly
 * healthy connection lost, closes it and resyncs every tab, forever. The two constants live in
 * different layers, so `apps/server/tests/clients.test.ts` asserts the relation rather than
 * trusting this sentence.
 *
 * The verdict lands between `STALE_MS` and `STALE_MS + checkMs` — the check is periodic, not an
 * alarm set on the last frame.
 */
export const STALE_MS = 45_000;

/**
 * Subscribe to the server's single multiplexed SSE stream and fan events out per session.
 * Attaches one listener per {@link EVENT_TYPES} entry, drops events already applied
 * (per `sessionId`+`agentId` seq high-water mark, so a re-send on ONE connection is
 * idempotent), and dispatches the rest to the callbacks registered for that session.
 *
 * Owns its connection: it reports every transition through `onStatus`, rebuilds the EventSource
 * when the browser has given up (readyState CLOSED), and — because the browser does not always
 * give up — rebuilds it when nothing has arrived for `staleMs`. Returns
 * `{ subscribe(sessionId, cb), onStatus(cb), close() }`; both registrations return their own
 * unsubscribe.
 */
export function createStream(opts: {
  url?: string;
  EventSourceImpl: new (url: string) => EventSourceLike;
  /** Delay before rebuilding a connection the browser has abandoned. */
  retryMs?: number;
  /** Silence after which an apparently-open connection is declared dead. Defaults to {@link STALE_MS}. */
  staleMs?: number;
  /** How often that silence is checked. Defaults to a third of `staleMs`. */
  checkMs?: number;
  /** Clock for the staleness decision — injected so a test can age the stream without waiting. */
  now?: () => number;
}) {
  const url = opts.url ?? '/api/stream';
  const retryMs = opts.retryMs ?? RETRY_MS;
  const staleMs = opts.staleMs ?? STALE_MS;
  const checkMs = opts.checkMs ?? Math.max(1, Math.round(staleMs / 3));
  const now = opts.now ?? (() => Date.now());
  const handlers = new Map<string, Set<(e: NormalizedEvent) => void>>();
  const statusListeners = new Set<(s: StreamStatus) => void>();
  const lastSeq = new Map<string, number>(); // `${sessionId}\0${agentId ?? ''}` → highest seq applied
  let es: EventSourceLike | null = null;
  // 'init' is neither of the reported states: it makes the FIRST outcome a transition, so a
  // page whose very first connection fails says so instead of looking quietly healthy.
  let status: StreamStatus | 'init' = 'init';
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  // When the connection last proved it exists. Every frame counts, heartbeat or data.
  let lastFrameAt = now();

  // Dedup is a monotonic high-water mark PER STREAM, where a stream is one file:
  // the parent (agentId null) and each subagent child each have their OWN seq
  // counter starting at 0 (watcher.ts pump: a fresh `tracked.seq` per file). Keying
  // the high-water by (sessionId, agentId) is right — a child's seq 0 must not be
  // dropped just because the parent already reached seq 500.
  //
  // Crucially the guard is `seq < prev`, NOT `<=`: seq identifies a LINE, not an
  // event, and ONE assistant line emits several events sharing that seq (usage +
  // attribution + tool-start). `<=` would pass only the first and drop the rest —
  // the bug that left tools/regions/subagent-state empty live. `<` lets every event
  // of a line through, and still drops a whole line redelivered on this connection
  // (seq < max). The line sitting exactly at the high-water may be re-processed once;
  // that is safe because the reducer is idempotent on it (fill = last absolute;
  // regions/subagents are Sets; tools keyed by id; compaction dedup below).
  //
  // The mark is scoped to ONE CONNECTION and cleared on reconnect (see connect()): across a
  // break it describes a stream that no longer exists, and a mark left standing silently
  // discarded every real event — measured, a page holding 1585 threw away seq 808..811 and
  // stayed frozen for good while its connection looked healthy. What the page
  // missed during the break is recovered by rebuilding the tab from the file, not from here.
  function onFrame(ev: { data: string }): void {
    let e: NormalizedEvent;
    try {
      e = JSON.parse(ev.data);
    } catch {
      return;
    }
    // Dedup applies ONLY to file-tailed events (seq >= 0, strictly increasing).
    // Out-of-band events (seq < 0, e.g. subagent-meta read from meta.json — no
    // line position) carry no seq ordering and must never be dropped by the
    // high-water mark; the reducer merges them idempotently.
    if (e.seq >= 0) {
      const streamKey = e.sessionId + '\0' + (e.agentId ?? ''); // one high-water per file (parent + each child)
      const prev = lastSeq.get(streamKey);
      if (prev !== undefined && e.seq < prev) return; // a fully-seen earlier line (redelivery) → drop
      lastSeq.set(streamKey, e.seq);
    }
    const set = handlers.get(e.sessionId);
    if (set) for (const h of set) h(e);
  }

  function setStatus(next: StreamStatus): void {
    if (next === status) return;
    status = next;
    for (const cb of statusListeners) cb(next);
  }

  function connect(): void {
    if (stopped) return;
    const src = new opts.EventSourceImpl(url);
    es = src;
    // One gate for every frame this connection delivers. The `es !== src` check is what makes a
    // frame EVIDENCE: a connection already given up on can still deliver something queued before
    // its close, and letting that refresh the clock would be proof of life from a corpse.
    const arrived = (ev: { data: string }): void => {
      if (es !== src) return;
      lastFrameAt = now();
      onFrame(ev);
    };
    for (const type of EVENT_TYPES) src.addEventListener(type, arrived);
    // Deliberately NOT in EVENT_TYPES: that list is exhaustive over NormalizedEvent by
    // construction, and a heartbeat is a control frame (like session-added/replay-end), not data.
    // It carries nothing to parse — arriving IS the message, so it stops at the gate above.
    src.addEventListener(HEARTBEAT_EVENT, () => {
      if (es !== src) return;
      lastFrameAt = now();
    });
    src.addEventListener('open', () => {
      if (es !== src) return;
      lastFrameAt = now();
      // On EVERY open, including the ones EventSource performs by itself without going
      // back through connect(). Nothing the previous connection saw carries over: the next
      // one may be served by a restarted watcher whose per-file seq counts from zero again.
      lastSeq.clear();
      setStatus('open');
    });
    src.addEventListener('error', () => {
      if (es !== src) return; // a superseded connection's death is not news
      setStatus('lost');
      // EventSource retries on its own only while it is still CONNECTING. A fatal error —
      // a non-2xx, a wrong content-type — leaves it CLOSED, and then nobody ever reconnects:
      // the page waits on a dead stream until it is reloaded by hand. So own the retry.
      if (src.readyState === CLOSED) scheduleReconnect();
    });
  }

  function scheduleReconnect(): void {
    if (stopped || retryTimer !== null) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, retryMs);
  }

  // The other way a stream dies, and the one no listener can catch: the path drops without a FIN
  // or an RST. An SSE connection only ever RECEIVES, so its TCP has nothing to retransmit and
  // never learns the peer is gone — the browser holds it at readyState OPEN and fires no `error`,
  // ever (measured: 90s of silence, six missed heartbeats, the page still calling itself
  // connected, and no recovery even once the network came back). Elapsed silence is the only
  // evidence available, which is why the heartbeat had to become an audible event.
  //
  // A backgrounded tab throttles this timer to about once a minute and freezes it outright after
  // a few minutes. That delays the verdict and cannot corrupt it — the test is against the clock,
  // not against a number of ticks — and `onVisible` below makes coming back immediate.
  //
  // It deliberately does NOT skip a connection that is merely CONNECTING. `EventSource` retries by
  // itself only AFTER an error, and a socket that completed its handshake and then never received
  // a response never errors either: the request bytes were acknowledged, so TCP has nothing to
  // retransmit and waits forever. That is the same freeze one state earlier, and the only thing
  // that can see it is the same clock.
  function watchSilence(): void {
    if (stopped) return;
    if (now() - lastFrameAt < staleMs) return;
    setStatus('lost'); // idempotent, and it also covers a FIRST connection that never opened
    lastFrameAt = now(); // spaces the next attempt a full window away, so this cannot become a storm
    if (retryTimer !== null) {
      clearTimeout(retryTimer); // we are rebuilding now; a queued retry would open a second stream
      retryTimer = null;
    }
    es?.close(); // closing ourselves fires no `error`, so the reconnect has to be explicit
    es = null;
    connect(); // immediately — the waiting already happened, in silence
  }

  // Timers do not run in a frozen tab, so the answer on return can be minutes old. Re-asking on
  // the way back costs one comparison and cannot produce a false positive: same clock, same test.
  const onVisible = (): void => {
    if (document.visibilityState === 'visible') watchSilence();
  };
  const hasDocument = typeof document !== 'undefined';
  if (hasDocument) document.addEventListener('visibilitychange', onVisible);

  connect();
  const watchdog = setInterval(watchSilence, checkMs);
  // A timer that keeps a process alive is a Node/Bun concern (tests, the compiled binary);
  // browsers have no unref and ignore this.
  (watchdog as unknown as { unref?: () => void }).unref?.();

  function subscribe(sessionId: string, handler: (e: NormalizedEvent) => void): () => void {
    let set = handlers.get(sessionId);
    if (!set) {
      set = new Set();
      handlers.set(sessionId, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
      if (set!.size === 0) handlers.delete(sessionId);
    };
  }

  /** Called on every change of the live feed's health, never on a repeat of the same state. */
  function onStatus(cb: (s: StreamStatus) => void): () => void {
    statusListeners.add(cb);
    return () => statusListeners.delete(cb);
  }

  return {
    subscribe,
    onStatus,
    close: () => {
      stopped = true;
      clearInterval(watchdog); // `stopped` already makes it a no-op; this stops it burning a tick
      if (hasDocument) document.removeEventListener('visibilitychange', onVisible);
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      es?.close();
    },
  };
}
