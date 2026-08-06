import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EVENT_TYPES } from '../src/client/event-types.ts';
import { createStream } from '../src/client/stream.ts';
import { windowFor } from '../src/core/context-windows.ts';
import { createSessionTree } from '../src/core/session-tree.ts';

// Fake EventSource: capture listeners, let the test emit frames synchronously.
// N listeners per type, like the real EventSource — a single-listener fake is itself
// a test artifact that can hide missed-listener bugs in the stream layer.
class FakeES {
  static last: FakeES | null = null;
  static built = 0;
  listeners = new Map<string, Array<(ev: { data: string }) => void>>();
  closed = false;
  readyState = 0;
  constructor(public url: string) {
    FakeES.last = this;
    FakeES.built++;
  }
  addEventListener(type: string, cb: (ev: { data: string }) => void) {
    const arr = this.listeners.get(type) ?? [];
    arr.push(cb);
    this.listeners.set(type, arr);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  emit(type: string, data: unknown) {
    for (const cb of this.listeners.get(type) ?? []) cb({ data: JSON.stringify(data) });
  }
  // The lifecycle events carry no data; EventSource delivers them to the same listener list.
  fire(type: 'open' | 'error') {
    this.readyState = type === 'open' ? 1 : this.readyState;
    for (const cb of this.listeners.get(type) ?? []) (cb as any)({});
  }
}

const usage = (sessionId: string, seq: number, fill: number) => ({
  type: 'usage',
  sessionId,
  root: 'cli',
  timestamp: 't',
  seq,
  delta: {},
  fill,
});

test('demux dispatches an event only to its sessionId subscribers', () => {
  const s = createStream({ EventSourceImpl: FakeES as any });
  const gotA: any[] = [],
    gotB: any[] = [];
  s.subscribe('A', (e) => gotA.push(e));
  s.subscribe('B', (e) => gotB.push(e));
  FakeES.last!.emit('usage', usage('A', 0, 10));
  assert.equal(gotA.length, 1);
  assert.equal(gotB.length, 0);
});

test('events of the same line (same seq) all pass; an earlier line (lower seq) is dropped', () => {
  const s = createStream({ EventSourceImpl: FakeES as any });
  const got: any[] = [];
  s.subscribe('A', (e) => got.push(e.type + ':' + e.seq));
  // one assistant line emits usage + attribution + tool-start, all at seq 5 — all pass
  FakeES.last!.emit('usage', usage('A', 5, 10));
  FakeES.last!.emit('attribution', {
    type: 'attribution',
    sessionId: 'A',
    root: 'cli',
    timestamp: 't',
    seq: 5,
    kind: 'skill',
    name: 'x',
  });
  FakeES.last!.emit('tool-start', {
    type: 'tool-start',
    sessionId: 'A',
    root: 'cli',
    timestamp: 't',
    seq: 5,
    id: 'a',
    name: 'Grep',
  });
  // a redelivered EARLIER line (seq 3 < high-water 5) is dropped
  FakeES.last!.emit('usage', usage('A', 3, 99));
  assert.deepEqual(got, ['usage:5', 'attribution:5', 'tool-start:5']);
});

test('unsubscribe removes only that handler', () => {
  const s = createStream({ EventSourceImpl: FakeES as any });
  const got: any[] = [];
  const off = s.subscribe('A', (e) => got.push(e));
  off();
  FakeES.last!.emit('usage', usage('A', 0, 10));
  assert.equal(got.length, 0);
});

test('delivers the tool/subagent-meta event types (not only usage/attribution)', () => {
  const s = createStream({ EventSourceImpl: FakeES as any });
  const got: any[] = [];
  s.subscribe('A', (e) => got.push(e.type));
  FakeES.last!.emit('tool-start', {
    type: 'tool-start',
    sessionId: 'A',
    root: 'cli',
    timestamp: 't',
    seq: 0,
    id: 'x',
    name: 'Grep',
  });
  FakeES.last!.emit('tool-end', {
    type: 'tool-end',
    sessionId: 'A',
    root: 'cli',
    timestamp: 't',
    seq: 1,
    toolUseId: 'x',
  });
  FakeES.last!.emit('subagent-meta', {
    type: 'subagent-meta',
    sessionId: 'A',
    root: 'cli',
    timestamp: '',
    seq: -1,
    agentId: 'c',
    toolUseId: 'x',
    agentType: null,
    spawnDepth: null,
    model: null,
  });
  assert.deepEqual(got, ['tool-start', 'tool-end', 'subagent-meta']);
});

test('a subagent stream has its own high-water (child seq starts at 0, not dropped by parent seq)', () => {
  const s = createStream({ EventSourceImpl: FakeES as any });
  const got: any[] = [];
  s.subscribe('A', (e) => got.push(e.type + ':' + (e.agentId ?? 'main') + ':' + e.seq));
  // parent stream advances to a high seq...
  FakeES.last!.emit('usage', {
    type: 'usage',
    sessionId: 'A',
    root: 'cli',
    timestamp: 't',
    seq: 500,
    agentId: null,
    delta: {},
    fill: 1,
  });
  // ...a child's events start at seq 0 — MUST NOT be dropped (different stream)
  FakeES.last!.emit('tool-start', {
    type: 'tool-start',
    sessionId: 'A',
    root: 'cli',
    timestamp: 't',
    seq: 0,
    agentId: 'child1',
    id: 'x',
    name: 'Grep',
  });
  FakeES.last!.emit('tool-end', {
    type: 'tool-end',
    sessionId: 'A',
    root: 'cli',
    timestamp: 't',
    seq: 1,
    agentId: 'child1',
    toolUseId: 'x',
  });
  // a redelivery of the child's seq 0 (reconnect) IS dropped
  FakeES.last!.emit('tool-start', {
    type: 'tool-start',
    sessionId: 'A',
    root: 'cli',
    timestamp: 't',
    seq: 0,
    agentId: 'child1',
    id: 'x',
    name: 'Grep',
  });
  assert.deepEqual(got, ['usage:main:500', 'tool-start:child1:0', 'tool-end:child1:1']);
});

test('subagent-meta (seq -1) is never dropped by the high-water dedup', () => {
  const s = createStream({ EventSourceImpl: FakeES as any });
  const got: any[] = [];
  s.subscribe('A', (e) => got.push(e.type));
  FakeES.last!.emit('usage', usage('A', 100, 10)); // raises the high-water to 100
  // out-of-band meta with seq -1 must still pass (it has no line position)
  FakeES.last!.emit('subagent-meta', {
    type: 'subagent-meta',
    sessionId: 'A',
    root: 'cli',
    timestamp: '',
    seq: -1,
    agentId: 'c',
    toolUseId: 'x',
    agentType: null,
    spawnDepth: null,
    model: null,
  });
  FakeES.last!.emit('subagent-meta', {
    type: 'subagent-meta',
    sessionId: 'A',
    root: 'cli',
    timestamp: '',
    seq: -1,
    agentId: 'd',
    toolUseId: 'y',
    agentType: null,
    spawnDepth: null,
    model: null,
  });
  assert.deepEqual(got, ['usage', 'subagent-meta', 'subagent-meta']);
});

test('live path (stream→reducer) yields the same enriched subagent snapshot as direct replay', () => {
  // The event script: an Agent tool spawns a subagent; meta links it; parent tool-end completes it.
  // Event order mirrors the real wire: the parent Agent tool-start, then the child's
  // own lines in file order (seq 0,1,… — monotonic), then the parent tool-end. No
  // spurious out-of-seq 'subagent' event (the parser never emits one).
  const events = [
    {
      type: 'tool-start',
      sessionId: 'A',
      root: 'cli',
      timestamp: '2026-07-12T14:32:07.000Z',
      seq: 0,
      agentId: null,
      id: 'toolu_AG',
      name: 'Agent',
      launchPrompt: 'inspect the thing',
      subagentType: 'general-purpose',
    },
    {
      type: 'subagent-meta',
      sessionId: 'A',
      root: 'cli',
      timestamp: '',
      seq: -1,
      agentId: 'child_L',
      toolUseId: 'toolu_AG',
      agentType: 'general-purpose',
      spawnDepth: 1,
      model: 'claude-haiku-4-5',
    },
    {
      type: 'usage',
      sessionId: 'A',
      root: 'cli',
      timestamp: '2026-07-12T14:32:08.000Z',
      seq: 0,
      agentId: 'child_L',
      delta: { input: 20000, output: 0, cacheRead: 0, cacheCreation: 0 },
      fill: 20000,
    },
    // the child's end_turn output — a NEW event type; must survive the stream layer.
    {
      type: 'subagent-output',
      sessionId: 'A',
      root: 'cli',
      timestamp: '2026-07-12T14:33:55.000Z',
      seq: 12,
      agentId: 'child_L',
      outputFull: 'the report',
      outLen: 10,
    },
    {
      type: 'tool-end',
      sessionId: 'A',
      root: 'cli',
      timestamp: '2026-07-12T14:33:55.000Z',
      seq: 3,
      agentId: null,
      toolUseId: 'toolu_AG',
      returned: {
        outputFull: 'ignored (child wins)',
        outLen: 20,
        totalTokens: 59715,
        totalDurationMs: 108000,
        status: 'completed',
      },
    },
  ];

  // Replay: fold directly into a reducer.
  const direct = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  for (const e of events) direct.apply(e as any);
  const replaySnap = direct.snapshot();

  // Live: same events through createStream (FakeES) → reducer via subscribe.
  const live = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  const s = createStream({ EventSourceImpl: FakeES as any });
  s.subscribe('A', (e) => live.apply(e as any));
  for (const e of events) FakeES.last!.emit(e.type, e);
  const liveSnap = live.snapshot();

  const rSub = replaySnap.subagents.find((a) => a.agentId === 'child_L');
  const lSub = liveSnap.subagents.find((a) => a.agentId === 'child_L');
  assert.ok(rSub && lSub);
  // The enriched fields match, and are the absolute/deterministic values (no "now").
  assert.equal(lSub!.agentType, 'general-purpose');
  assert.equal(lSub!.startedAt, '2026-07-12T14:32:07.000Z');
  // duration from the child's own span (usage 14:32:08 → output 14:33:55 = 107s)
  assert.equal(lSub!.durationMs, 107000);
  assert.equal(lSub!.state, 'done');
  // P1 enriched fields survive the stream layer, incl. the NEW subagent-output type:
  assert.equal(lSub!.prompt, 'inspect the thing');
  assert.equal(lSub!.outputFull, 'the report'); // child end_turn wins over parent inline
  assert.equal(lSub!.outLen, 10);
  // The child HAS per-call usage → volume is the true sum (parent's totalTokens is ignored).
  assert.equal(lSub!.volume, 20000);
  assert.equal(lSub!.volumeEstimated, false);
  assert.deepEqual(lSub!.volumeBreakdown, { input: 20000, output: 0, cacheRead: 0, cacheCreation: 0 });
  assert.deepEqual(lSub, rSub); // live == replay on the whole AgentNode
});

test('skills aggregate identically live (through stream) and via direct replay', () => {
  const events = [
    {
      type: 'attribution',
      sessionId: 'A',
      root: 'cli',
      timestamp: 't',
      seq: 0,
      agentId: null,
      kind: 'skill',
      name: 'code-review',
    },
    {
      type: 'attribution',
      sessionId: 'A',
      root: 'cli',
      timestamp: 't',
      seq: 1,
      agentId: null,
      kind: 'skill',
      name: 'code-review',
    },
    {
      type: 'attribution',
      sessionId: 'A',
      root: 'cli',
      timestamp: 't',
      seq: 2,
      agentId: null,
      kind: 'skill',
      name: 'brainstorming',
    },
    {
      type: 'tool-start',
      sessionId: 'A',
      root: 'cli',
      timestamp: 't',
      seq: 3,
      agentId: null,
      id: 'toolu_S',
      name: 'Skill',
      arg: 'code-review',
    },
  ];
  const direct = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  for (const e of events) direct.apply(e as any);
  const live = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  const s = createStream({ EventSourceImpl: FakeES as any });
  s.subscribe('A', (e) => live.apply(e as any));
  for (const e of events) FakeES.last!.emit(e.type, e);
  assert.deepEqual(live.snapshot().skills, direct.snapshot().skills);
  assert.deepEqual(live.snapshot().skills, [
    { name: 'code-review', turns: 2, invokes: 1 },
    { name: 'brainstorming', turns: 1, invokes: 0 },
  ]);
});

// A type that reaches the wire but has no listener is dropped SILENTLY — no error, no log,
// just a feature that works in replay and dies live. It has now happened three times (tool
// timing, subagent enrichment, and `agent-end`: background subagents never finished in the
// live view). The Record in event-types.ts makes it a compile error; this test makes the
// intent explicit and catches an entry deleted by hand.
test('every event the parser can emit has a live listener', () => {
  const emitted: string[] = [
    'usage',
    'attribution',
    'compaction',
    'tool-start',
    'tool-end',
    'agent-end',
    'workflow-agent',
    'subagent-meta',
    'subagent-output',
    'user-turn',
    'command',
    'turn-end',
    'turn-interrupted',
    'turn-result',
  ];
  for (const t of emitted) {
    assert.ok(EVENT_TYPES.includes(t as any), `${t} reaches the browser but nothing listens for it`);
  }
});

// A broken live stream must be a fact the page can act on, not a silence.
// The failure that shipped: the connection died, nothing listened for `error`, the UI kept
// its pulsing LIVE badge, and the page waited forever on a stream nobody was writing to.
test('the stream reports open and lost', () => {
  const s = createStream({ EventSourceImpl: FakeES as any });
  const seen: string[] = [];
  s.onStatus((st) => seen.push(st));
  FakeES.last!.fire('open');
  FakeES.last!.fire('error');
  FakeES.last!.fire('open');
  assert.deepEqual(seen, ['open', 'lost', 'open']);
});

test('a repeated status is not re-announced', () => {
  const s = createStream({ EventSourceImpl: FakeES as any });
  const seen: string[] = [];
  s.onStatus((st) => seen.push(st));
  FakeES.last!.fire('open');
  FakeES.last!.fire('open');
  assert.deepEqual(seen, ['open']);
});

// EventSource retries by itself only while it is still CONNECTING. A fatal error leaves it
// CLOSED for good — and then nothing in the page ever reconnects, which is indistinguishable
// from the freeze this whole change is about. The stream owns its own connection instead.
test('a stream left CLOSED is reconnected by the client', async () => {
  const before = FakeES.built;
  const s = createStream({ EventSourceImpl: FakeES as any, retryMs: 5 });
  FakeES.last!.fire('open');
  FakeES.last!.close(); // fatal: readyState 2, the browser will not retry
  FakeES.last!.fire('error');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(FakeES.built, before + 2, 'a fresh EventSource was built');
  s.close();
});

// The high-water exists to drop a line RE-DELIVERED on one connection. Across a reconnect it
// is a number about a stream that no longer exists — and the measured freeze was exactly a
// stale high-water (1585) discarding every real event (seq 808..811) for good. The tab
// rebuilds from the file after a reconnect, so nothing here is worth remembering.
// The freeze an `error` listener can never catch: the host went away without a FIN or an RST,
// so the browser had nothing to notice. An SSE connection only
// ever RECEIVES, so its TCP never retransmits, never times out, and never learns the peer is
// gone. Measured on a silently cut path: 90s, six missed heartbeats, `readyState` still 1 (OPEN),
// zero `error` events, the page reporting itself connected the whole time. Silence is therefore
// a verdict the client has to reach on its own.
test('a silent stream — no frames and no error — is declared lost and rebuilt', async () => {
  let clock = 0;
  const before = FakeES.built;
  const s = createStream({ EventSourceImpl: FakeES as any, staleMs: 45_000, checkMs: 5, now: () => clock });
  const seen: string[] = [];
  s.onStatus((st) => seen.push(st));
  FakeES.last!.fire('open');
  clock = 46_000; // the clock is injected, so the verdict never depends on how loaded the machine is
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(seen, ['open', 'lost']);
  assert.ok(FakeES.built > before + 1, 'the dead connection is replaced, not just reported');
  s.close();
});

// One state earlier, and the same blindness: a socket that completed its handshake and never
// received a response never errors either — its request bytes were acknowledged, so TCP has
// nothing to retransmit — and `EventSource` only retries AFTER an error. Skipping a connection
// that is merely CONNECTING would leave exactly that case with no owner.
test('a connection that never opens is replaced too', async () => {
  let clock = 0;
  const before = FakeES.built;
  const s = createStream({ EventSourceImpl: FakeES as any, staleMs: 45_000, checkMs: 5, now: () => clock });
  const seen: string[] = [];
  s.onStatus((st) => seen.push(st));
  clock = 46_000; // never opened, never errored: nothing to hear from either end
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(seen, ['lost'], 'a first connection that never answers is a loss, not a silence');
  assert.ok(FakeES.built > before + 1, 'and it is retried rather than waited on');
  s.close();
});

// The rebuild must not become its own storm: while the path stays down the watchdog is the only
// thing driving reconnection, and a window that is not restarted on each attempt would fire on
// every tick (5ms here, 15s in the browser) for as long as the outage lasts.
test('a stream that stays down is retried once per window, not once per tick', async () => {
  let clock = 0;
  const before = FakeES.built;
  const s = createStream({ EventSourceImpl: FakeES as any, staleMs: 45_000, checkMs: 5, now: () => clock });
  FakeES.last!.fire('open');
  clock = 46_000;
  await new Promise((r) => setTimeout(r, 60)); // ~12 ticks, one window
  assert.equal(FakeES.built, before + 2, 'one rebuild for one elapsed window');
  clock = 92_000;
  await new Promise((r) => setTimeout(r, 60)); // a second window elapses
  assert.equal(FakeES.built, before + 3);
  s.close();
});

// The counterpart, and the reason the verdict is time-based rather than traffic-based: an idle
// session is not a broken one. The heartbeat is what tells the two apart, so it has to be an
// EVENT — an SSE comment reaches the socket but never the page, and a page that cannot hear the
// only thing on a quiet wire has nothing to measure. The clock is injected so the decision is
// deterministic: only the ticks come from real time.
test('a heartbeat keeps a quiet stream alive; silence past the window does not', async () => {
  let clock = 0;
  const s = createStream({ EventSourceImpl: FakeES as any, staleMs: 45_000, checkMs: 5, now: () => clock });
  const seen: string[] = [];
  s.onStatus((st) => seen.push(st));
  FakeES.last!.fire('open');
  const es = FakeES.last!;
  clock = 44_000; // inside the window: nothing has arrived, but nothing is late either
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(seen, ['open']);
  es.emit('heartbeat', {}); // the wire is alive, and it says so at t=44s
  clock = 88_000; // 44s since that heartbeat — still inside the window
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(seen, ['open'], 'a heartbeat must restart the clock');
  clock = 134_000; // 46s of silence since the last heartbeat
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(seen, ['open', 'lost']);
  s.close();
});

// A data frame is proof of life too — the watchdog must not kill a stream that is busy delivering.
test('any frame restarts the clock, not just a heartbeat', async () => {
  let clock = 0;
  const s = createStream({ EventSourceImpl: FakeES as any, staleMs: 45_000, checkMs: 5, now: () => clock });
  const seen: string[] = [];
  s.onStatus((st) => seen.push(st));
  FakeES.last!.fire('open');
  clock = 44_000;
  FakeES.last!.emit('usage', usage('A', 1, 10));
  clock = 88_000;
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(seen, ['open']);
  s.close();
});

test('reconnecting forgets the per-session high-water', () => {
  const s = createStream({ EventSourceImpl: FakeES as any });
  const got: number[] = [];
  s.subscribe('A', (e) => got.push(e.seq));
  FakeES.last!.emit('usage', usage('A', 900, 10));
  FakeES.last!.emit('usage', usage('A', 5, 10)); // below the high-water on the same connection: dropped
  assert.deepEqual(got, [900]);
  FakeES.last!.fire('error');
  FakeES.last!.fire('open');
  FakeES.last!.emit('usage', usage('A', 5, 10)); // after a reconnect the same seq must pass
  assert.deepEqual(got, [900, 5]);
});
