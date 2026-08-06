import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFeed, type FeedItem, tsMs } from '../src/core/feed.ts';

function item(over: Partial<FeedItem> & { ts: number }): FeedItem {
  return { name: 'Read', startMs: over.ts, ms: null, ...over };
}

test('tsMs: parses ISO, rejects absent/garbage', () => {
  assert.equal(tsMs('2026-07-12T14:32:07.000Z'), Date.parse('2026-07-12T14:32:07.000Z'));
  assert.equal(tsMs(null), null);
  assert.equal(tsMs(''), null);
  assert.equal(tsMs('not-a-date'), null);
});

test('push: orders by timestamp, not by arrival order', () => {
  const f = createFeed();
  // Replay emits the parent file whole, THEN each child whole: a child's OLD event
  // can arrive after a parent's NEW one. It must still sort to its true position.
  f.push(item({ ts: 300, name: 'late-arrival-old-event' }));
  f.push(item({ ts: 100, name: 'oldest' }));
  f.push(item({ ts: 200, name: 'middle' }));
  assert.deepEqual(
    f.items().map((i) => i.ts),
    [100, 200, 300],
  );
});

test('push: caps the ring, evicting the oldest by timestamp', () => {
  const f = createFeed(3);
  for (const ts of [10, 20, 30, 40]) f.push(item({ ts }));
  assert.deepEqual(
    f.items().map((i) => i.ts),
    [20, 30, 40],
  );
});

test('push: an out-of-order event older than everything is dropped once at cap', () => {
  const f = createFeed(2);
  f.push(item({ ts: 100 }));
  f.push(item({ ts: 200 }));
  f.push(item({ ts: 1, name: 'ancient' })); // sorts to the front, then evicts as oldest
  assert.deepEqual(
    f.items().map((i) => i.ts),
    [100, 200],
  );
});

test('end: fills the duration of the matching running item', () => {
  const f = createFeed();
  f.push(item({ id: 'tool-1', ts: 1000 }));
  const changed = f.end('tool-1', new Date(1500).toISOString());
  assert.equal(changed, true);
  assert.equal(f.items()[0]!.ms, 500);
});

test('end: unknown id, unparseable end, or unknown start leave the ring untouched', () => {
  const f = createFeed();
  f.push(item({ id: 'tool-1', ts: 1000 }));
  assert.equal(f.end('nope', new Date(1500).toISOString()), false);
  assert.equal(f.end('tool-1', 'garbage'), false);
  assert.equal(f.items()[0]!.ms, null);

  const g = createFeed();
  g.push({ name: 'Read', id: 'tool-2', ts: 0, startMs: null, ms: null }); // no start → no duration
  assert.equal(g.end('tool-2', new Date(500).toISOString()), false);
});

test('end: an evicted item can no longer be completed', () => {
  const f = createFeed(1);
  f.push(item({ id: 'old', ts: 100 }));
  f.push(item({ id: 'new', ts: 200 }));
  assert.equal(f.end('old', new Date(150).toISOString()), false); // 'old' is gone
  assert.equal(f.end('new', new Date(250).toISOString()), true);
});

test("items(turn): only that turn's activities, oldest first", () => {
  const f = createFeed();
  f.push(item({ ts: 100, name: 'a', turnIndex: 1 }));
  f.push(item({ ts: 200, name: 'b', turnIndex: 2 }));
  f.push(item({ ts: 300, name: 'c', turnIndex: 1 }));
  assert.deepEqual(
    f.items(1).map((i) => i.name),
    ['a', 'c'],
  );
  assert.deepEqual(
    f.items(2).map((i) => i.name),
    ['b'],
  );
  assert.deepEqual(
    f.items(9).map((i) => i.name),
    [],
    'a turn with no activity',
  );
});

test('retention is PER TURN: an old turn keeps its activities when later turns fill up', () => {
  // The regression this guards: with a global cap, selecting turn 1 after a busy turn 2
  // showed an empty feed, because turn 1's events had already been evicted.
  const f = createFeed(2);
  f.push(item({ ts: 10, name: 'a1', turnIndex: 1 }));
  f.push(item({ ts: 20, name: 'a2', turnIndex: 1 }));
  for (const ts of [30, 40, 50, 60]) f.push(item({ ts, name: 't2-' + ts, turnIndex: 2 }));

  assert.deepEqual(
    f.items(1).map((i) => i.name),
    ['a1', 'a2'],
    'turn 1 survives turn 2 filling up',
  );
  assert.deepEqual(
    f.items(2).map((i) => i.ts),
    [50, 60],
    'turn 2 itself is still capped at 2',
  );
  // the whole-session view stays bounded at the cap, showing the latest by timestamp
  assert.deepEqual(
    f.items().map((i) => i.ts),
    [50, 60],
  );
});

test('eviction does not unindex a live item that re-used the same tool_use_id', () => {
  const f = createFeed(1);
  f.push(item({ id: 'dup', ts: 100 }));
  f.push(item({ id: 'dup', ts: 200 })); // same id; the first is evicted by the cap
  // The index must still point at the SURVIVING item, so its tool-end lands.
  assert.equal(f.end('dup', new Date(700).toISOString()), true);
  assert.equal(f.items()[0]!.ms, 500);
});

// A background command's row closes at its launch receipt; the outcome lands a turn or more
// later. `outcome()` is what carries it back to the row that is still in the ring.
test('a background command row takes its outcome long after it closed', () => {
  const f = createFeed(10);
  f.push(item({ id: 'toolu_b1', name: 'Bash', arg: 'bun run main.ts', ts: 100, turnIndex: 1 }));
  assert.equal(f.mark('toolu_b1'), true);
  assert.equal(f.mark('toolu_b1'), false, 'marking twice is not a change');

  const summary = 'Background command "Start the server" failed with exit code 144';
  assert.equal(f.outcome('toolu_b1', true, summary), true);
  assert.equal(f.items()[0]!.error, true);
  assert.equal(f.items()[0]!.errorMessage, summary, 'the row can state what Claude Code stated');
  assert.equal(f.items()[0]!.arg, 'bun run main.ts', 'the command is not lost — the renderer picks');
});

test('a clean background outcome leaves no error on the row', () => {
  const f = createFeed(10);
  f.push(item({ id: 'toolu_b1', name: 'Bash', arg: 'bun run build.ts', ts: 100 }));
  f.mark('toolu_b1');
  assert.equal(f.outcome('toolu_b1', false, 'Background command "Build" completed (exit code 0)'), false);
  assert.equal(f.items()[0]!.error, undefined);
  assert.equal(f.items()[0]!.errorMessage, undefined, 'nothing to say that the row does not already say');
});

// The gate is the launch receipt. A notification naming a tool that launched no background
// command — a resumed subagent's SendMessage, a Monitor — must not paint that row failed.
test('an outcome for a row that launched no background command is ignored', () => {
  const f = createFeed(10);
  f.push(item({ id: 'toolu_02', name: 'SendMessage', arg: 'keep digging', ts: 100 }));
  assert.equal(f.outcome('toolu_02', true, 'Background command "x" failed with exit code 144'), false);
  assert.equal(f.items()[0]!.error, undefined);
  assert.equal(f.outcome('nope', true, 'unknown id'), false, 'an unknown id is inert');
});
