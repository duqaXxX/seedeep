import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTabStore, type StorageLike } from '../src/client/tab-store.ts';

// A storage faithful to the ways a real one misbehaves: it can be absent, it can hold
// junk written by an older build, and it can throw on write (quota / disabled).
function fakeStorage(seed: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...seed };
  return {
    data,
    getItem: (k) => (k in data ? data[k]! : null),
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}
const KEY = 'seedeep.tabs.v1';

test('save → load round-trips the tab set, the active tab and the offered set', () => {
  const s = fakeStorage();
  const store = createTabStore(s);
  store.save({ ids: ['a', 'b', 'c'], activeId: 'b', known: ['a', 'b', 'c', 'closed-one'] });
  assert.deepEqual(createTabStore(s).load(), {
    ids: ['a', 'b', 'c'],
    activeId: 'b',
    known: ['a', 'b', 'c', 'closed-one'],
  });
});

test('known outlives its tab: a session closed by hand must not be re-offered after a refresh', () => {
  const s = fakeStorage();
  createTabStore(s).save({ ids: ['a'], activeId: 'a', known: ['a', 'b'] });
  assert.ok(createTabStore(s).load()!.known.includes('b'), 'b has no tab, but seedeep has already offered it');
});

test('order is preserved — the strip order is part of the workspace', () => {
  const s = fakeStorage();
  createTabStore(s).save({ ids: ['c', 'a', 'b'], activeId: null, known: [] });
  assert.deepEqual(createTabStore(s).load()!.ids, ['c', 'a', 'b']);
});

test('a workspace saved before `known` existed falls back to its tabs, not to empty', () => {
  // `[]` would re-offer every session that already has a tab; `ids` is the honest reading.
  const store = createTabStore(fakeStorage({ [KEY]: '{"ids":["a","b"],"activeId":"a"}' }));
  assert.deepEqual(store.load(), { ids: ['a', 'b'], activeId: 'a', known: ['a', 'b'] });
});

test('a junk `known` degrades to the tab set rather than poisoning the restore', () => {
  const store = createTabStore(fakeStorage({ [KEY]: '{"ids":["a"],"activeId":null,"known":[7]}' }));
  assert.deepEqual(store.load(), { ids: ['a'], activeId: null, known: ['a'] });
});

test('known is capped at save time, keeping the NEWEST — dropping the oldest cannot resurrect a tab', () => {
  // Growth has to be bounded somewhere, and it must not be by liveness: a session blinking
  // out of the PID scan would take its entry with it and its closed tab would come back.
  // Capping here is safe — what falls off the end is the oldest, long-dead ids, and the rule
  // only ever offers LIVE sessions.
  const s = fakeStorage();
  const many = Array.from({ length: 640 }, (_, i) => `s${i}`);
  createTabStore(s).save({ ids: ['s639'], activeId: 's639', known: many });
  const back = createTabStore(s).load()!;
  assert.equal(back.known.length, 500);
  assert.equal(back.known[0], 's140', 'the oldest fell off');
  assert.equal(back.known.at(-1), 's639', 'the newest survived');
  assert.deepEqual(back.ids, ['s639'], 'the tabs themselves are never capped');
});

test('never saved → null, which is NOT the same as saved-and-empty', () => {
  // The distinction is the whole feature: null means "first visit, auto-open the live
  // sessions"; [] means "you closed them all, and that must survive a refresh".
  const s = fakeStorage();
  assert.equal(createTabStore(s).load(), null);
  createTabStore(s).save({ ids: [], activeId: null, known: ['a'] });
  assert.deepEqual(
    createTabStore(s).load(),
    { ids: [], activeId: null, known: ['a'] },
    'an empty workspace is a real workspace — and it still remembers what it already offered',
  );
});

test('unreadable entries are treated as nothing saved, never as a half workspace', () => {
  for (const raw of ['not json', '{"ids":"a"}', '{"ids":[1,2]}', '[]', 'null', '{"activeId":"a"}']) {
    assert.equal(createTabStore(fakeStorage({ [KEY]: raw })).load(), null, `junk: ${raw}`);
  }
});

test('a non-string activeId degrades to null instead of poisoning the restore', () => {
  const store = createTabStore(fakeStorage({ [KEY]: '{"ids":["a"],"activeId":7}' }));
  assert.deepEqual(store.load(), { ids: ['a'], activeId: null, known: ['a'] });
});

test('no storage at all: load reports nothing saved, save is a silent no-op', () => {
  const store = createTabStore(null);
  assert.equal(store.load(), null);
  assert.doesNotThrow(() => store.save({ ids: ['a'], activeId: 'a', known: ['a'] }));
});

test('a storage that throws never breaks the app — it only loses the restore', () => {
  const hostile: StorageLike = {
    getItem() {
      throw new Error('storage disabled');
    },
    setItem() {
      throw new Error('quota exceeded');
    },
  };
  const store = createTabStore(hostile);
  assert.equal(store.load(), null);
  assert.doesNotThrow(() => store.save({ ids: ['a'], activeId: 'a', known: ['a'] }));
});
