import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStream, STALE_MS } from '../src/client/stream.ts';
import { ClientRegistry, type SseSink } from '../src/server/clients.ts';
import { HEARTBEAT_MS } from '../src/server/server.ts';

function fakeSink() {
  const chunks: string[] = [];
  const dec = new TextDecoder();
  const sink: SseSink = { enqueue: (c) => chunks.push(dec.decode(c)) };
  return { sink, chunks };
}

test('broadcast reaches every registered client', () => {
  const reg = new ClientRegistry();
  const a = fakeSink();
  const b = fakeSink();
  reg.add(a.sink);
  reg.add(b.sink);
  reg.broadcast('usage', { sessionId: 'A', fill: 10 });
  assert.match(a.chunks[0]!, /event: usage/);
  assert.match(b.chunks[0]!, /"sessionId":"A"/);
});

test('a removed client stops receiving', () => {
  const reg = new ClientRegistry();
  const a = fakeSink();
  const b = fakeSink();
  reg.add(a.sink);
  reg.add(b.sink);
  reg.remove(a.sink);
  reg.broadcast('usage', { sessionId: 'A', fill: 1 });
  assert.equal(a.chunks.length, 0);
  assert.equal(b.chunks.length, 1);
});

test('a throwing sink is dropped and does not break the broadcast', () => {
  const reg = new ClientRegistry();
  const dead: SseSink = {
    enqueue: () => {
      throw new Error('closed');
    },
  };
  const live = fakeSink();
  reg.add(dead);
  reg.add(live.sink);
  reg.broadcast('usage', { sessionId: 'A', fill: 1 });
  assert.equal(live.chunks.length, 1); // live still got it
  assert.equal(reg.size(), 1); // dead was evicted
});

// Evicting a dead sink is only half the job. The browser is never told, so its
// EventSource sits at readyState OPEN waiting on a connection nobody writes to any more —
// no error, no reconnect, a page frozen until it is reloaded by hand. Closing the stream
// is what turns a silent orphan into a disconnection the browser can act on.
test('a sink that fails is CLOSED, not merely forgotten', () => {
  const reg = new ClientRegistry();
  let closed = 0;
  const dead: SseSink = {
    enqueue: () => {
      throw new Error('closed');
    },
    close: () => {
      closed++;
    },
  };
  reg.add(dead);
  reg.broadcast('usage', { fill: 1 });
  assert.equal(closed, 1);
  assert.equal(reg.size(), 0);
});

test('a sink whose close() also throws is still evicted', () => {
  const reg = new ClientRegistry();
  const dead: SseSink = {
    enqueue: () => {
      throw new Error('closed');
    },
    close: () => {
      throw new Error('already closed');
    },
  };
  const live = fakeSink();
  reg.add(dead);
  reg.add(live.sink);
  reg.broadcast('usage', { fill: 1 }); // must not throw out of the broadcast
  assert.equal(reg.size(), 1);
  assert.equal(live.chunks.length, 1);
});

// Without traffic neither end can tell a quiet stream from a dead one: an idle SSE
// connection is exactly what a network path drops in silence. The heartbeat makes the write
// fail on THIS side, so the sink is closed and evicted.
//
// It was a comment (`: ping`), which covered only that half. The browser cannot hear a comment —
// the EventSource API exposes no hook for one — so the page had nothing to measure and sat at
// readyState OPEN through a 90s silence. A named event costs the same bytes and is audible to
// both ends.
test('the heartbeat is an EVENT, so the page can hear it', () => {
  const reg = new ClientRegistry();
  const a = fakeSink();
  reg.add(a.sink);
  reg.ping();
  assert.equal(a.chunks[0], 'event: heartbeat\ndata: {}\n\n');
});

test('ping evicts a client that has gone away', () => {
  const reg = new ClientRegistry();
  const dead: SseSink = {
    enqueue: () => {
      throw new Error('closed');
    },
  };
  reg.add(dead);
  reg.ping();
  assert.equal(reg.size(), 0);
});

// It carries no `id:` line at all: an id is a POSITION in the stream, and a heartbeat is not one.
test('the heartbeat does not consume an event id', () => {
  const reg = new ClientRegistry();
  const a = fakeSink();
  reg.add(a.sink);
  reg.ping();
  reg.broadcast('usage', { fill: 1 });
  assert.match(a.chunks[1]!, /^id: 1\n/); // the heartbeat must not shift the numbering
});

// The heartbeat is a WIRE CONTRACT with no type behind it: the server writes a name into a frame,
// the browser attaches a listener to a string. Every other test in this file and in
// client-stream.test.ts asserts its OWN hand-written literal, so renaming one side alone passes
// all of them while leaving the page deaf on a quiet stream — which is the watchdog's only input.
// This one reads the name the server really writes and asserts the client really listens for it.
test('the heartbeat name the server writes is one the client listens for', () => {
  const reg = new ClientRegistry();
  const a = fakeSink();
  reg.add(a.sink);
  reg.ping();
  const written = /^event: (.+)$/m.exec(a.chunks[0]!)?.[1];

  const listened: string[] = [];
  class Probe {
    constructor(public url: string) {}
    addEventListener(type: string) {
      listened.push(type);
    }
    close() {}
  }
  createStream({ EventSourceImpl: Probe as never }).close();

  assert.ok(written, 'the heartbeat frame names no event at all');
  assert.ok(
    listened.includes(written),
    `the server writes "${written}"; the client listens for ${listened.join(', ')}`,
  );
});

// The client's silence window and the server's heartbeat cadence are one calibration split across
// two layers. A client stricter than the server's own rhythm declares a healthy connection lost,
// closes it and resyncs every open tab — on a cadence, forever. Prose in both files cannot enforce
// that; a future edit to either constant will see this.
test('the silence window leaves room for missed heartbeats', () => {
  assert.ok(
    STALE_MS >= HEARTBEAT_MS * 2,
    `a ${STALE_MS}ms window against a ${HEARTBEAT_MS}ms heartbeat leaves no slack for a late one`,
  );
});

test('ids are monotonic across broadcasts', () => {
  const reg = new ClientRegistry();
  const a = fakeSink();
  reg.add(a.sink);
  reg.broadcast('usage', { fill: 1 });
  reg.broadcast('usage', { fill: 2 });
  assert.match(a.chunks[0]!, /^id: 1\n/);
  assert.match(a.chunks[1]!, /^id: 2\n/);
});
