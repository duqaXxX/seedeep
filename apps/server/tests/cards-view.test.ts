import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { CARD_ROWS, cardsList, renderCardsCard } from '../src/client/cards-view.ts';
import type { SessionCard } from '../src/core/tracker-cards.ts';
import { fakeDoc, findByClass, textOf } from './fake-dom.ts';

// What a plausible bug here looks like: the card inviting a click when no row can open (the exact
// failure the Commits card already had), the `read` chip missing so a card the session only looked
// at reads as work it did, or the "+N more" line disagreeing with the hero count — which would make
// the visible rows silently stop summing to it.

const prevDoc = (globalThis as any).document;
const prevWin = (globalThis as any).window;
after(() => {
  (globalThis as any).document = prevDoc;
  (globalThis as any).window = prevWin;
});

const card = (over: Partial<SessionCard> = {}): SessionCard => ({
  key: 'ABC-12',
  id: 'ABC-12',
  title: 'A readable title',
  url: 'https://tracker.example.com/t/issue/ABC-12/a-readable-title',
  evidence: 'wrote',
  source: 'mcp',
  at: Date.UTC(2026, 7, 2, 9, 5),
  touches: 1,
  ...over,
});

function mount(cards: SessionCard[] | null): { host: any; opened: string[]; expanded: number } {
  const doc: any = fakeDoc();
  (globalThis as any).document = doc;
  const opened: string[] = [];
  // A fixture may be synthetic in content and must be faithful in SHAPE, and a `window` is no
  // exception: this one is installed on the GLOBAL and only restored in `after()`, so for the whole
  // length of this file any other file's test that runs in between sees it. With `open` alone,
  // `trace.ts`'s `destroy()` — which calls `window.removeEventListener` — died with
  // "is not a function", nondeterministically, depending on where node:test happened to interleave
  // the two files. Green here, green on a pull request, red on main two minutes later.
  // These four members are the entire `window` contract `src/client` uses (measured); a fifth one
  // appearing there without appearing here is the same bug again.
  (globalThis as any).window = {
    open: (u: string) => opened.push(u),
    addEventListener: () => {},
    removeEventListener: () => {},
    location: { href: '' },
  };
  const host = doc.createElement('div');
  const state = { expanded: 0 };
  renderCardsCard(host, cards === null ? null : { cards }, () => {
    state.expanded++;
  });
  return {
    host,
    opened,
    get expanded() {
      return state.expanded;
    },
  };
}

test('before the answer lands the card says so, instead of claiming zero', () => {
  const { host } = mount(null);
  assert.match(textOf(host), /Reading the tracker calls/);
  assert.equal(findByClass(host, 'num').length, 0, 'no hero count until there is one');
});

test('the hero count and the rows agree, with the remainder deferred to the drawer', () => {
  const many = Array.from({ length: CARD_ROWS + 3 }, (_, i) => card({ key: `ABC-${i}`, id: `ABC-${i}`, at: 1000 - i }));
  const { host } = mount(many);
  assert.match(textOf(findByClass(host, 'num')[0]), new RegExp(String(many.length)));
  assert.equal(findByClass(host, 'crdrow').length, CARD_ROWS);
  const more = findByClass(host, 'crdmore')[0];
  assert.ok(more);
  assert.match(textOf(more), /\+ 3 more/, 'the remainder must sum with the visible rows to the hero');
});

test('a card with nowhere to open neither invites a click nor performs one', () => {
  const { host, opened } = mount([card({ url: null })]);
  const row = findByClass(host, 'crdrow')[0];
  assert.ok(row.className.includes('nolink'));
  assert.doesNotMatch(textOf(host), /Click one/, 'the description must not promise what no row can do');
  row.onclick?.();
  assert.deepEqual(opened, [], 'a linkless row opens nothing');
});

test('a clickable row opens its own card on the tracker', () => {
  const { host, opened } = mount([card()]);
  findByClass(host, 'crdrow')[0].onclick?.();
  assert.deepEqual(opened, ['https://tracker.example.com/t/issue/ABC-12/a-readable-title']);
});

test('a card the session only read is marked as such', () => {
  const { host } = mount([card({ evidence: 'read' }), card({ key: 'ABC-9', id: 'ABC-9' })]);
  const chips = findByClass(host, 'crdlvl');
  assert.equal(chips.length, 1, 'only the read row carries the chip');
  assert.equal(textOf(chips[0]), 'read');
  assert.match(textOf(host), /1 changed/, 'the description separates work from a look');
});

test('a card with no title renders as its id, not as a broken row', () => {
  const { host } = mount([card({ title: null })]);
  assert.equal(textOf(findByClass(host, 'crdid')[0]), 'ABC-12');
  assert.equal(textOf(findByClass(host, 'crdt')[0]), '—');
});

test('the drawer lists every card, and shows how many times each was touched', () => {
  const doc: any = fakeDoc();
  (globalThis as any).document = doc;
  const cards = [card({ touches: 3 }), card({ key: 'ABC-9', id: 'ABC-9', touches: 1 })];
  const list = cardsList(cards);
  assert.equal(findByClass(list, 'crddrow').length, 2);
  const counts = findByClass(list, 'crdn').map((n: any) => textOf(n));
  assert.deepEqual(counts, ['3 calls'], 'the count is spelled out, and a single touch needs none');
});
