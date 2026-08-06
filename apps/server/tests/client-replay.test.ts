import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startReplay } from '../src/client/replay.ts';

class FakeES {
  static last: FakeES | null = null;
  listeners = new Map<string, (ev: any) => void>();
  closed = false;
  constructor(public url: string) {
    FakeES.last = this;
  }
  addEventListener(type: string, cb: (ev: any) => void) {
    this.listeners.set(type, cb);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data: unknown) {
    this.listeners.get(type)?.({ data: JSON.stringify(data) });
  }
  emitError() {
    this.listeners.get('error')?.({});
  } // a connection error carries no data
}
// A replay connection dies the way a live one does — silently, with no `error` to catch — and
// this one has more to lose: while a read is in flight every live event goes into `buffer` and
// nothing comes out, so the tab freezes behind a stream that still looks healthy. `finish()` was
// reachable only from `replay-end`, `error` and `stop()`, none of which a silently cut path
// produces. It matters more since the live watchdog started asking for a resync on every recovery.
test('a replay that goes quiet hands off instead of buffering live events forever', async () => {
  let clock = 0;
  let pushLive: ((e: any) => void) | null = null;
  const got: number[] = [];
  const r = startReplay('A', (e) => got.push(e.seq), {
    stream: {
      subscribe: (_id, h) => {
        pushLive = h;
        return () => {};
      },
    },
    EventSourceImpl: FakeES as never,
    staleMs: 30_000,
    checkMs: 5,
    now: () => clock,
  });
  pushLive!({ type: 'usage', sessionId: 'A', root: 'cli', timestamp: 't', seq: 7, delta: {}, fill: 1 });
  assert.deepEqual(got, [], 'live is held back while the read is in flight');
  clock = 31_000; // the replay connection has delivered nothing at all, and never errored
  await new Promise((res) => setTimeout(res, 40));
  assert.deepEqual(got, [7], 'the buffered live event is flushed and the tab goes live');
  assert.equal(FakeES.last!.closed, true, 'and the dead connection is released');
  r.stop();
});

// The counterpart, and the reason the deadline is on SILENCE and not on duration: a big session
// legitimately takes a long time to replay, but it is never quiet while it does (measured worst
// gap between two frames on a 30.8 MB session: 6ms).
test('a replay that keeps delivering is never cut short', async () => {
  let clock = 0;
  const got: number[] = [];
  const r = startReplay('A', (e) => got.push(e.seq), {
    EventSourceImpl: FakeES as never,
    staleMs: 30_000,
    checkMs: 5,
    now: () => clock,
  });
  for (let i = 1; i <= 4; i++) {
    clock += 20_000; // slower than any real replay, but never silent for a whole window
    FakeES.last!.emit('usage', {
      type: 'usage',
      sessionId: 'A',
      root: 'cli',
      timestamp: 't',
      seq: i,
      delta: {},
      fill: 1,
    });
    await new Promise((res) => setTimeout(res, 20));
  }
  assert.deepEqual(got, [1, 2, 3, 4], 'every frame was delivered as replay history');
  assert.equal(FakeES.last!.closed, false, 'and the connection was left alone');
  r.stop();
});

// `finish()` already refuses to run a deferred resync once stopped — "a closed tab must not
// resurrect its feed" — but the exported `resync()` never checked, so a call that lands after
// stop() opened a connection anyway. It now also opens one nothing watches: stop() clears the
// watchdog, so that read has no staleness bound and, on a silently cut path, buffers forever.
test('resync() after stop() opens nothing', () => {
  const built: string[] = [];
  const r = startReplay('A', () => {}, {
    EventSourceImpl: class extends FakeES {
      constructor(url: string) {
        super(url);
        built.push(url);
      }
    } as never,
  });
  FakeES.last!.emit('replay-end', { sessionId: 'A' }); // the initial read completes
  const afterFirst = built.length;
  r.stop();
  r.resync();
  assert.equal(built.length, afterFirst, 'a stopped tab must not open another read');
});

const ev = (seq: number, fill: number) => ({
  type: 'usage',
  sessionId: 'A',
  root: 'cli',
  timestamp: 't',
  seq,
  delta: {},
  fill,
});
// ONE source line, as the parser really renders it: several events sharing that line's seq.
// Every dedup rule in replay.ts has to be stated against this shape, not against `ev` alone.
const line = (seq: number): Array<[string, any]> => [
  ['usage', { type: 'usage', sessionId: 'A', root: 'cli', timestamp: 't', seq, delta: {}, fill: 1 }],
  ['attribution', { type: 'attribution', sessionId: 'A', root: 'cli', timestamp: 't', seq, kind: 'skill', name: 'x' }],
  [
    'tool-start',
    {
      type: 'tool-start',
      sessionId: 'A',
      root: 'cli',
      timestamp: 't',
      seq,
      agentId: null,
      id: `t${seq}`,
      name: 'Read',
    },
  ],
];
const tag = (e: any) => `${e.type}@${e.seq}`;

// A fake stream that lets the test push "live" events to whatever handler is subscribed.
function fakeStream() {
  let sub: ((e: any) => void) | null = null;
  return {
    subscribe(_id: string, h: (e: any) => void) {
      sub = h;
      return () => {
        sub = null;
      };
    },
    push(e: any) {
      sub?.(e);
    },
  };
}

test('onLive fires exactly once at the replay→live handoff (replay-end)', () => {
  let liveCalls = 0;
  startReplay('A', () => {}, {
    EventSourceImpl: FakeES as any,
    onLive: () => {
      liveCalls++;
    },
  });
  FakeES.last!.emit('usage', ev(0, 10));
  assert.equal(liveCalls, 0, 'not called during replay');
  FakeES.last!.emit('replay-end', { sessionId: 'A' });
  assert.equal(liveCalls, 1, 'called at replay-end');
  FakeES.last!.emit('replay-end', { sessionId: 'A' }); // idempotent
  assert.equal(liveCalls, 1, 'not called again');
});

test('onLive still fires when the replay connection errors before replay-end', () => {
  let liveCalls = 0;
  startReplay('A', () => {}, {
    EventSourceImpl: FakeES as any,
    onLive: () => {
      liveCalls++;
    },
  });
  FakeES.last!.emitError();
  assert.equal(liveCalls, 1, 'error path also hands off to live');
});

test('replay forwards EVERY event type — a new type (subagent-output) is not silently dropped', () => {
  // Regression: replay.ts kept its own EVENT_TYPES list; a type added to the wire
  // but missing here (subagent-output) was dropped, so the subagent drawer showed
  // "0 chars" live while direct replay worked. Both paths now share one list.
  const got: any[] = [];
  startReplay('A', (e) => got.push(e), { EventSourceImpl: FakeES as any });
  FakeES.last!.emit('subagent-output', {
    type: 'subagent-output',
    sessionId: 'A',
    root: 'cli',
    timestamp: 't',
    seq: 5,
    agentId: 'child_X',
    outputFull: 'the answer',
    outLen: 10,
  });
  assert.equal(got.length, 1, 'subagent-output was forwarded, not dropped');
  assert.equal(got[0].type, 'subagent-output');
  assert.equal(got[0].outLen, 10);
});

test('active handoff: live during replay is buffered, then flushed without re-doubling replayed seqs', () => {
  const stream = fakeStream();
  const got: any[] = [];
  startReplay('A', (e) => got.push(e), { stream, EventSourceImpl: FakeES as any });
  // replay emits historical seq 0,1
  FakeES.last!.emit('usage', ev(0, 10));
  FakeES.last!.emit('usage', ev(1, 20));
  // meanwhile a live event seq 2 arrives — must be buffered, not yet delivered
  stream.push(ev(2, 30));
  assert.deepEqual(
    got.map((e) => e.seq),
    [0, 1],
  );
  // replay-end → flush buffered live (seq 2), skipping any seq already replayed
  FakeES.last!.emit('replay-end', { sessionId: 'A' });
  assert.deepEqual(
    got.map((e) => e.seq),
    [0, 1, 2],
  );
  // subsequent live flows straight through
  stream.push(ev(3, 40));
  assert.deepEqual(
    got.map((e) => e.seq),
    [0, 1, 2, 3],
  );
});

test('active handoff: a live event whose seq the replay already emitted is dropped on flush', () => {
  const stream = fakeStream();
  const got: any[] = [];
  startReplay('A', (e) => got.push(e), { stream, EventSourceImpl: FakeES as any });
  FakeES.last!.emit('usage', ev(0, 10));
  stream.push(ev(0, 10)); // duplicate of a replayed seq, buffered
  FakeES.last!.emit('replay-end', { sessionId: 'A' });
  assert.deepEqual(
    got.map((e) => e.seq),
    [0],
  ); // the dup is dropped
});

test('inactive replay: no stream → events forwarded, stops at replay-end', () => {
  const got: any[] = [];
  const r = startReplay('A', (e) => got.push(e), { EventSourceImpl: FakeES as any });
  FakeES.last!.emit('usage', ev(0, 10));
  FakeES.last!.emit('replay-end', { sessionId: 'A' });
  assert.deepEqual(
    got.map((e) => e.seq),
    [0],
  );
  assert.equal(FakeES.last!.closed, true);
  r.stop();
});

test('active handoff: replay connection error before replay-end flushes buffer and goes live', () => {
  const stream = fakeStream();
  const got: any[] = [];
  startReplay('A', (e) => got.push(e), { stream, EventSourceImpl: FakeES as any });
  FakeES.last!.emit('usage', ev(0, 10)); // partial history
  stream.push(ev(1, 20)); // live buffered during replay
  FakeES.last!.emitError(); // connection dies before replay-end
  // buffered live is flushed (not stuck), and subsequent live flows straight through
  assert.deepEqual(
    got.map((e) => e.seq),
    [0, 1],
  );
  stream.push(ev(2, 30));
  assert.deepEqual(
    got.map((e) => e.seq),
    [0, 1, 2],
  );
  assert.equal(FakeES.last!.closed, true); // replay ES closed on error
});

test('active handoff: stop() before replay-end flushes buffered live, never leaves it stuck', () => {
  const stream = fakeStream();
  const got: any[] = [];
  const r = startReplay('A', (e) => got.push(e), { stream, EventSourceImpl: FakeES as any });
  FakeES.last!.emit('usage', ev(0, 10));
  stream.push(ev(1, 20)); // buffered
  r.stop(); // abort mid-replay
  // stop() unsubscribes live, so nothing arrives after — but the already-buffered
  // event 1 must not be silently lost: it is flushed on stop.
  assert.deepEqual(
    got.map((e) => e.seq),
    [0, 1],
  );
  assert.equal(FakeES.last!.closed, true);
});

test('post-finish: watcher re-delivers historical seqs after replay-end — they are deduped', () => {
  // Bug: watcher starts at offset=0 and re-reads all existing lines on every
  // server restart. Those events arrive ~300ms later, AFTER buffering=false, so
  // the old buffer-flush dedup never saw them. They went straight to the handler
  // and doubled every historical turn.
  const stream = fakeStream();
  const got: any[] = [];
  startReplay('A', (e) => got.push(e), { stream, EventSourceImpl: FakeES as any });
  FakeES.last!.emit('usage', ev(0, 10));
  FakeES.last!.emit('usage', ev(1, 20));
  FakeES.last!.emit('replay-end', { sessionId: 'A' }); // buffering=false
  // watcher's first tick fires ~300ms later and re-delivers the whole file
  stream.push(ev(0, 10)); // historical dup — must be filtered
  stream.push(ev(1, 20)); // historical dup — must be filtered
  stream.push(ev(2, 30)); // genuinely new — must pass through
  assert.deepEqual(
    got.map((e) => e.seq),
    [0, 1, 2],
  );
});

test('post-finish dedup is per-(agentId,seq): child file seq=0 is not filtered by main seq=0', () => {
  // Per-file seq spaces are independent (each child starts at seq=0). A global
  // seq Set would wrongly block child events that share a seq with the main file.
  const stream = fakeStream();
  const got: any[] = [];
  startReplay('A', (e) => got.push(e), { stream, EventSourceImpl: FakeES as any });
  FakeES.last!.emit('usage', ev(0, 10)); // main seq=0
  FakeES.last!.emit('usage', { ...ev(0, 5), agentId: 'child1' }); // child seq=0 (independent)
  FakeES.last!.emit('replay-end', { sessionId: 'A' });
  // watcher re-delivers child seq=0 — must be filtered (it's already in replay)
  stream.push({ ...ev(0, 5), agentId: 'child1' });
  // watcher delivers child seq=1 (new) — must pass through
  stream.push({ ...ev(1, 8), agentId: 'child1' });
  // main seq=0 from another file should not affect child dedup boundary
  stream.push(ev(0, 10)); // main historical dup — must be filtered
  assert.deepEqual(
    got.map((e) => `${e.agentId ?? 'main'}:${e.seq}`),
    ['main:0', 'child1:0', 'child1:1'],
  );
});

test('replay delivers tool/subagent-meta event types (not only usage/attribution/compaction/subagent)', () => {
  // Same class of bug as stream.ts had: an incomplete EVENT_TYPES list silently
  // drops tool timing + subagent-meta in replay, so the enriched subagent fields
  // and collapsed main tools never appear when replaying a session.
  const got: any[] = [];
  startReplay('A', (e) => got.push(e.type), { EventSourceImpl: FakeES as any });
  FakeES.last!.emit('tool-start', {
    type: 'tool-start',
    sessionId: 'A',
    root: 'cli',
    timestamp: 't',
    seq: 0,
    agentId: null,
    id: 'x',
    name: 'Agent',
  });
  FakeES.last!.emit('tool-end', {
    type: 'tool-end',
    sessionId: 'A',
    root: 'cli',
    timestamp: 't',
    seq: 1,
    agentId: null,
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
    agentType: 'general-purpose',
    spawnDepth: 1,
    model: 'claude-sonnet-4-6',
  });
  FakeES.last!.emit('replay-end', { sessionId: 'A' });
  assert.deepEqual(got, ['tool-start', 'tool-end', 'subagent-meta']);
});

// A reconnect used to rebuild the whole tab — correct, but at one
// interruption every couple of minutes it re-read the session and visibly re-drew the
// dashboard. The client knows how far it got per file, so it asks for the tail instead and
// folds it into the reducer it already has: no teardown, nothing to look at.
test('resync asks only for what the tab is missing, per file', () => {
  const stream = fakeStream();
  const r = startReplay('A', () => {}, { stream: stream as any, EventSourceImpl: FakeES as any });
  FakeES.last!.emit('usage', ev(7, 10));
  FakeES.last!.emit('usage', { ...ev(2, 5), agentId: 'child1' });
  FakeES.last!.emit('replay-end', { sessionId: 'A' });
  r.resync();
  const url = FakeES.last!.url;
  assert.match(url, /from=/);
  const from = decodeURIComponent(new URL(url, 'http://x').searchParams.get('from')!);
  assert.equal(new Set(from.split(',')).size, 2);
  assert.ok(from.split(',').includes(':7'), `parent mark missing in ${from}`);
  assert.ok(from.split(',').includes('child1:2'), `child mark missing in ${from}`);
});

test('resync applies the tail and never re-applies what is already in', () => {
  const stream = fakeStream();
  const got: number[] = [];
  const r = startReplay('A', (e) => got.push(e.seq), { stream: stream as any, EventSourceImpl: FakeES as any });
  FakeES.last!.emit('usage', ev(0, 1));
  FakeES.last!.emit('usage', ev(1, 2));
  FakeES.last!.emit('replay-end', { sessionId: 'A' });
  r.resync();
  FakeES.last!.emit('usage', ev(1, 2)); // a line the server re-sent anyway
  FakeES.last!.emit('usage', ev(2, 3)); // the one thing that was missed
  FakeES.last!.emit('replay-end', { sessionId: 'A' });
  assert.deepEqual(got, [0, 1, 2]);
});

test('resync does not hand off to live a second time', () => {
  const stream = fakeStream();
  let liveCalls = 0;
  const r = startReplay('A', () => {}, {
    stream: stream as any,
    EventSourceImpl: FakeES as any,
    onLive: () => {
      liveCalls++;
    },
  });
  FakeES.last!.emit('replay-end', { sessionId: 'A' });
  r.resync();
  FakeES.last!.emit('replay-end', { sessionId: 'A' });
  assert.equal(liveCalls, 1, 'the view is already live — announcing it again would re-arm toasts');
});

test('live events that arrive during a resync are held, then applied in order', () => {
  const stream = fakeStream();
  const got: number[] = [];
  const r = startReplay('A', (e) => got.push(e.seq), { stream: stream as any, EventSourceImpl: FakeES as any });
  FakeES.last!.emit('usage', ev(0, 1));
  FakeES.last!.emit('replay-end', { sessionId: 'A' });
  r.resync();
  stream.push(ev(5, 9)); // live, mid-resync: must not overtake the tail
  assert.deepEqual(got, [0]);
  FakeES.last!.emit('usage', ev(1, 2));
  FakeES.last!.emit('replay-end', { sessionId: 'A' });
  assert.deepEqual(got, [0, 1, 5]);
});

// The dedup rules are stated per LINE, but a line is not one event. These three tests fix
// that: each drives a whole line through a different path (replay, live-cut→resync, deferred
// resync), and each failed before the fix in a way no seq-per-event test could see.
test('a replay delivers EVERY event of a line, not only its first', () => {
  // The replay branch measured each event against a mark IT had just advanced: the first
  // event of line N set the high-water to N, and every further event of the same line read
  // as "already in". Silent on a live session (the live branch carries them) and total on
  // history: no attribution, no tool ever replayed.
  const got: string[] = [];
  startReplay('A', (e) => got.push(tag(e)), { EventSourceImpl: FakeES as any });
  for (const [type, e] of line(0)) FakeES.last!.emit(type, e);
  for (const [type, e] of line(1)) FakeES.last!.emit(type, e);
  FakeES.last!.emit('replay-end', { sessionId: 'A' });
  assert.deepEqual(got, ['usage@0', 'attribution@0', 'tool-start@0', 'usage@1', 'attribution@1', 'tool-start@1']);
});

test('a line cut in half by the outage is re-read whole, and its applied head is not doubled', () => {
  // `liveMax` is a frontier, not a completed line: the connection can die between two events
  // of the SAME line. Asking the resync to start past it drops that line's tail for good;
  // asking to start before it re-delivers the head that was already applied — and usage is
  // summed, so a doubled head is a corrupted total. The tab's position is therefore the line
  // AND how far into it: ask from the last WHOLE line, skip what was already applied.
  const stream = fakeStream();
  const got: string[] = [];
  const r = startReplay('A', (e) => got.push(tag(e)), { stream: stream as any, EventSourceImpl: FakeES as any });
  FakeES.last!.emit('replay-end', { sessionId: 'A' }); // nothing on disk yet: straight to live
  const l5 = line(5);
  stream.push(l5[0]![1]); // usage@5 applied live…
  stream.push(l5[1]![1]); // …attribution@5 too, then the feed dies before tool-start@5
  assert.deepEqual(got, ['usage@5', 'attribution@5']);

  r.resync();
  const from = decodeURIComponent(new URL(FakeES.last!.url, 'http://x').searchParams.get('from')!);
  assert.ok(from.split(',').includes(':4'), `must ask from the last WHOLE line, got ${from}`);
  for (const [type, e] of l5) FakeES.last!.emit(type, e); // the server re-sends line 5 entire
  FakeES.last!.emit('replay-end', { sessionId: 'A' });
  assert.deepEqual(
    got,
    ['usage@5', 'attribution@5', 'tool-start@5'],
    'the missing tail arrived exactly once, and the applied head was not re-applied',
  );
});

test('a resync raised while a replay is reading is deferred, never dropped', () => {
  // The read in flight reached the file's end when it was REQUESTED — before the outage.
  // Returning silently left the tab permanently short, and nothing re-armed: `feedWasLost`
  // is cleared before the loop, so no later reconnect asks again.
  const stream = fakeStream();
  const r = startReplay('A', () => {}, { stream: stream as any, EventSourceImpl: FakeES as any });
  const first = FakeES.last!;
  r.resync();
  assert.equal(FakeES.last, first, 'no second connection while one is still reading');
  first.emit('usage', ev(0, 1));
  first.emit('replay-end', { sessionId: 'A' });
  assert.notEqual(FakeES.last, first, 'the deferred resync opens once the replay lands');
  assert.match(FakeES.last!.url, /from=/);
});

test('stop() cancels a deferred resync instead of reopening a connection', () => {
  const stream = fakeStream();
  const r = startReplay('A', () => {}, { stream: stream as any, EventSourceImpl: FakeES as any });
  const first = FakeES.last!;
  r.resync();
  r.stop();
  assert.equal(FakeES.last, first, 'a closed tab must not resurrect its feed');
});

test('a live redelivery below the mark is dropped after a resync', () => {
  // The stream clears its own high-water on reconnect, so this is the guard that survives:
  // a restarted watcher re-sends the file from seq 0 down the LIVE path.
  const stream = fakeStream();
  const got: number[] = [];
  startReplay('A', (e) => got.push(e.seq), { stream: stream as any, EventSourceImpl: FakeES as any });
  FakeES.last!.emit('usage', ev(4, 1));
  FakeES.last!.emit('replay-end', { sessionId: 'A' });
  stream.push(ev(0, 1)); // re-delivered history
  stream.push(ev(5, 2)); // genuinely new
  assert.deepEqual(got, [4, 5]);
});
