import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createSearchView } from '../src/client/search-view.ts';
import type { SearchResponse, SearchRow } from '../src/core/types.ts';
import { fakeDoc, findByClass, textOf } from './fake-dom.ts';

// What a plausible bug here looks like: the list ranked on a number other than the one it prints,
// the automated runs quietly mixed in (91 of 104 matches on one measured query), or a highlighted
// snippet built from an HTML string — the corpus is the user's own prompts.

const prevDoc = (globalThis as any).document;
after(() => {
  (globalThis as any).document = prevDoc;
});

const NOW = Date.UTC(2026, 6, 29, 12);
const tick = () => new Promise((r) => setTimeout(r, 0));

function mount(res: SearchResponse | null) {
  const doc: any = fakeDoc();
  (globalThis as any).document = doc;
  const host = doc.createElement('div');
  const opened: string[] = [];
  const queries: string[] = [];
  const view = createSearchView(host, {
    search: async (q) => {
      queries.push(q);
      return res;
    },
    onOpenSession: (id) => opened.push(id),
    now: () => NOW,
  });
  return { host, opened, queries, view };
}

function row(over: Partial<SearchRow> = {}): SearchRow {
  return {
    sessionId: 'aaaaaaaa-1111-2222-3333-444444444444',
    project: 'demo-app',
    subject: 'fix the toast eviction',
    entrypoint: 'cli',
    lastActivity: NOW - 3600e3,
    hits: 4,
    chars: 4000,
    snippets: [{ who: 'you', text: 'the toast rail freezes' }],
    ...over,
  };
}

/** Type into the real input and let the debounce fire. */
async function search(host: any, q: string) {
  const input = findByClass(host, 'sr-input')[0];
  input.value = q;
  input.oninput();
  await new Promise((r) => setTimeout(r, 220));
  await tick();
}

test('a row states which session it is, how well it matches, and what matched', async () => {
  const { host } = mount({ terms: ['toast'], ms: 12, rows: [row()] });
  await search(host, 'toast');
  const rows = findByClass(host, 'sr-row');
  assert.equal(rows.length, 1);
  assert.equal(textOf(findByClass(rows[0], 'sr-subj')[0]), 'fix the toast eviction');
  assert.ok(textOf(findByClass(rows[0], 'sr-meta')[0]).includes('demo-app'), 'the project is on the row');
  assert.equal(findByClass(rows[0], 'sr-snip').length, 1, 'the passage that matched is shown');
  assert.equal(findByClass(rows[0], 'sr-who')[0].textContent, 'you', 'and who said it');
});

test('a search row shows the WHOLE session id, and copies it', async () => {
  // The prefix is enough to tell two rows apart and useless for what you do next: a resume takes
  // the whole uuid. Truncating it here is the regression this guards.
  const copied: string[] = [];
  (globalThis as any).navigator = {
    clipboard: {
      writeText: async (s: string) => {
        copied.push(s);
      },
    },
  };
  const { host } = mount({ terms: ['toast'], ms: 5, rows: [row()] });
  await search(host, 'toast');
  const chip = findByClass(host, 'idchip')[0];
  assert.equal(chip.textContent, 'aaaaaaaa-1111-2222-3333-444444444444');
  chip.onclick({ stopPropagation() {} });
  await tick();
  assert.deepEqual(copied, ['aaaaaaaa-1111-2222-3333-444444444444']);
});

test('the list is ranked by the number it PRINTS, and the control changes both', async () => {
  // `dense` matches four times in a small session; `long` matches ten times in a huge one.
  // By occurrences `long` wins; by density `dense` does — the very inversion measured on the
  // real corpus, and the reason density is the default.
  const dense = row({ sessionId: 'dense-1111-2222-3333-444444444444', subject: 'dense', hits: 4, chars: 4_000 });
  const long = row({ sessionId: 'long-1111-2222-3333-4444444444444', subject: 'long', hits: 10, chars: 400_000 });
  const { host } = mount({ terms: ['toast'], ms: 5, rows: [long, dense] });
  await search(host, 'toast');

  const subjects = () => findByClass(host, 'sr-row').map((r: any) => textOf(findByClass(r, 'sr-subj')[0]));
  const scores = () =>
    findByClass(host, 'sr-row').map((r: any) => Number(findByClass(r, 'sr-score')[0].children[0].textContent));
  assert.deepEqual(subjects(), ['dense', 'long'], 'density is the default order');
  assert.deepEqual(scores(), [1, 0], 'and the printed number IS that order (per 1k)');

  const seg = findByClass(host, 'rt-seg')[0];
  seg.children[1].onclick(); // occurrences
  assert.deepEqual(subjects(), ['long', 'dense'], 'switching the key reorders the list');
  assert.deepEqual(scores(), [10, 4], 'and the printed number follows it');

  // Recency too, and this is the one the box used to lie about: it kept printing the density
  // while the list was ordered by date — a number that ranks nothing, in the slot that ranks.
  seg.children[2].onclick();
  const units = () =>
    findByClass(host, 'sr-row').map((r: any) => findByClass(r, 'sr-score')[0].children[1].textContent);
  const values = () =>
    findByClass(host, 'sr-row').map((r: any) => findByClass(r, 'sr-score')[0].children[0].textContent);
  assert.deepEqual(units(), ['last run', 'last run'], 'the box names what it is showing');
  assert.deepEqual(values(), ['today', 'today'], 'and shows the age, not a density nobody sorted by');
});

test('automated runs are kept aside until asked for, and the button says how many', async () => {
  const mine = row({ subject: 'my session' });
  const auto = row({ sessionId: 'bbbbbbbb-1111-2222-3333-444444444444', subject: null, entrypoint: 'sdk-cli' });
  const { host } = mount({ terms: ['toast'], ms: 5, rows: [mine, auto] });
  await search(host, 'toast');

  assert.equal(findByClass(host, 'sr-row').length, 1, 'only the human session is listed');
  const more = findByClass(host, 'sr-more')[0];
  assert.ok(more, 'nothing is hidden in silence');
  assert.ok(more.textContent.includes('1 automated run'), more.textContent);
  more.onclick();
  assert.equal(findByClass(host, 'sr-row').length, 2, 'and clicking shows exactly those');
  assert.equal(findByClass(host, 'sr-badge').length, 1, 'the revealed row says what it is');
});

test('the matched words are highlighted as NODES — never as markup from the corpus', async () => {
  const hostile = '<img src=x onerror=alert(1)> the toast eviction';
  const { host } = mount({
    terms: ['toast', 'eviction'],
    ms: 5,
    rows: [row({ snippets: [{ who: 'claude', text: hostile }] })],
  });
  await search(host, 'toast eviction');
  const snip = findByClass(host, 'sr-snip')[0];
  // Both terms are wrapped in real <mark> ELEMENTS…
  const marks = snip.children.filter((c: any) => c.tag === 'mark');
  assert.equal(marks.length, 2);
  assert.deepEqual(
    marks.map((m: any) => m.textContent),
    ['toast', 'eviction'],
  );
  // …and the markup in the corpus survives as characters, never as an element.
  assert.ok(textOf(snip).includes('<img src=x onerror=alert(1)>'), 'the text is shown, not interpreted');
  assert.equal(snip.children.filter((c: any) => c.tag === 'img').length, 0);
});

test('a term that is the PREFIX of another does not truncate its highlight', async () => {
  // "toast toasting" over "toasting bread": both terms match at offset 0, and the shorter one used
  // to win by insertion order — leaving `toast` marked and `ing bread` bare, i.e. the word that
  // brought the session up not shown as a match.
  const { host } = mount({
    terms: ['toast', 'toasting'],
    ms: 5,
    rows: [row({ snippets: [{ who: 'you', text: 'toasting bread' }] })],
  });
  await search(host, 'toast toasting');
  const snip = findByClass(host, 'sr-snip')[0];
  const marks = snip.children.filter((c: any) => c.tag === 'mark');
  assert.deepEqual(
    marks.map((m: any) => m.textContent),
    ['toasting'],
  );
  assert.ok(textOf(snip).includes('toasting bread'), 'and the text is still whole');
});

test('a row is the way into the session — click and keyboard both open it', async () => {
  const { host, opened } = mount({ terms: ['toast'], ms: 5, rows: [row()] });
  await search(host, 'toast');
  const r = findByClass(host, 'sr-row')[0];
  r.onclick();
  assert.deepEqual(opened, ['aaaaaaaa-1111-2222-3333-444444444444']);
  r.onkeydown({ key: 'Enter', preventDefault() {} });
  assert.equal(opened.length, 2);
});

test('no query, no result, and a failed request each say so — never a stale list', async () => {
  const { host } = mount({ terms: ['toast'], ms: 5, rows: [row()] });
  assert.ok(textOf(findByClass(host, 'rt-empty')[0]).includes('Type two or three words'));
  await search(host, 'toast');
  assert.equal(findByClass(host, 'sr-row').length, 1);
  await search(host, '   ');
  assert.equal(findByClass(host, 'sr-row').length, 0, 'clearing the query clears the answer');
  assert.ok(textOf(findByClass(host, 'rt-empty')[0]).includes('Type two or three words'));

  const empty = mount({ terms: ['nope'], ms: 5, rows: [] });
  await search(empty.host, 'nope');
  assert.ok(textOf(findByClass(empty.host, 'rt-empty')[0]).includes('No session contains'));

  const broken = mount(null);
  await search(broken.host, 'toast');
  assert.ok(textOf(findByClass(broken.host, 'rt-empty')[0]).includes('could not run'));
});

test('while a re-search is in flight the count never states the PREVIOUS query\u2019s answer', async () => {
  const doc: any = fakeDoc();
  (globalThis as any).document = doc;
  const host = doc.createElement('div');
  let release: (v: SearchResponse) => void = () => {};
  const view = createSearchView(host, {
    search: () =>
      new Promise<SearchResponse>((r) => {
        release = r;
      }),
    onOpenSession: () => {},
    now: () => NOW,
  });
  void view;
  const input = findByClass(host, 'sr-input')[0];
  input.value = 'toast';
  input.oninput();
  await new Promise((r) => setTimeout(r, 220));
  release({ terms: ['toast'], ms: 5, rows: [row(), row({ sessionId: 'b-1111-2222-3333-444444444444' })] });
  await tick();
  assert.ok(textOf(findByClass(host, 'sr-hint')[0]).includes('2 of your sessions'));

  input.value = 'toast eviction';
  input.oninput(); // a second query, still in flight
  await new Promise((r) => setTimeout(r, 220));
  const hint = textOf(findByClass(host, 'sr-hint')[0]);
  assert.ok(hint.includes('searching'), hint);
  assert.ok(!hint.includes('2 of your sessions'), 'the old count is not passed off as this one\u2019s');
});

test('the query is debounced — typing a word is one search, not five', async () => {
  const { host, queries } = mount({ terms: ['toast'], ms: 5, rows: [row()] });
  const input = findByClass(host, 'sr-input')[0];
  for (const q of ['t', 'to', 'toa', 'toas', 'toast']) {
    input.value = q;
    input.oninput();
  }
  await new Promise((r) => setTimeout(r, 260));
  assert.deepEqual(queries, ['toast']);
});
