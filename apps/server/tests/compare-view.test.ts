import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createCompareView } from '../src/client/compare-view.ts';
import type { CompareRow, Comparison } from '../src/core/types.ts';
import { fakeDoc, findByClass, textOf } from './fake-dom.ts';

// A row carries TWO lines: the subject and the meta line under it (project · when · calls ·
// subagent share · how far the weighting moved it). The first live render dropped the meta line
// entirely — the whole suite was green and the invariants passed, because nothing asserted that a
// row says WHICH session it is. That is what these tests are for.

const prevDoc = (globalThis as any).document;
after(() => {
  (globalThis as any).document = prevDoc;
});

function mount() {
  const doc: any = fakeDoc();
  (globalThis as any).document = doc;
  return doc.createElement('div');
}
const tick = () => new Promise((r) => setTimeout(r, 0));

const NOW = Date.UTC(2026, 6, 28, 12);

function row(over: Partial<CompareRow> = {}): CompareRow {
  return {
    sessionId: 'aaaaaaaa-1111',
    project: 'demo-app',
    subject: 'review the weighting rules',
    entrypoint: 'cli',
    weight: 1000,
    subagentWeight: 0,
    byModel: [{ model: 'claude-opus-4-8', weight: 1000 }],
    tokensComplete: 1_240_000,
    mainModel: 'claude-opus-4-8',
    mainModels: 1,
    turns: 4,
    apiCalls: 42,
    lastTs: NOW - 3600e3,
    rank: 1,
    rawRank: 1,
    ...over,
  };
}

function payload(rows: CompareRow[], over: Partial<Comparison['windows']['d7']> = {}): Comparison {
  const w = {
    sessions: rows.length,
    weight: rows.reduce((n, r) => n + r.weight, 0),
    subagentWeight: rows.reduce((n, r) => n + r.subagentWeight, 0),
    byModel: [{ model: 'claude-opus-4-8', weight: rows.reduce((n, r) => n + r.weight, 0) }],
    top: rows,
    restSessions: 0,
    restWeight: 0,
    ...over,
  };
  return { generatedAt: NOW, windows: { all: w, d30: w, d7: w } };
}

async function view(data: Comparison) {
  const host = mount();
  const opened: string[] = [];
  const v = createCompareView(host, { loadComparison: async () => data, onOpenSession: (id) => opened.push(id) });
  await v.refresh();
  await tick();
  return { host, v, opened };
}

test('a row is three stacked lines: the prompt, every chip, the bar', async () => {
  const { host } = await view(payload([row({ project: 'widgetco', apiCalls: 561 })]));
  const rows = findByClass(host, 'cmp-row');
  assert.equal(rows.length, 1);
  assert.equal(textOf(findByClass(rows[0], 'cmp-subj')[0]), 'review the weighting rules');

  // ONE meta line now, holding everything: the bar moved to a line of its own, so the chips no
  // longer compete with it for width. Two lines was the workaround for that competition.
  const meta = findByClass(rows[0], 'cmp-meta');
  assert.equal(meta.length, 1, 'one meta line — the bar is no longer beside it');
  const text = meta[0].children.map((c: any) => textOf(c)).join(' ');
  for (const expected of ['widgetco', 'Opus 4.8', 'ago', '561 calls', '1.2M tokens']) {
    assert.ok(text.includes(expected), `states ${expected}: ${text}`);
  }

  // The bar and its number are on the third line, not beside the text.
  assert.equal(findByClass(rows[0], 'cmp-track').length, 1);
  assert.equal(textOf(findByClass(rows[0], 'cmp-val')[0]), '1k');
});

test('the row names the model the MAIN thread ran on, and says when it used more than one', async () => {
  // Subagents are excluded on purpose: a Haiku explorer does not make an Opus session a Haiku one.
  const one = await view(payload([row({ mainModel: 'claude-opus-4-8', mainModels: 1 })]));
  const label = findByClass(one.host, 'cmp-model')[0];
  assert.equal(textOf(label), 'Opus 4.8');
  assert.ok(/subagents excluded/.test(label.title), label.title);

  // A mid-session /model: the dominant one is shown, but not as the whole truth.
  const two = await view(payload([row({ mainModel: 'claude-sonnet-4-6', mainModels: 3 })]));
  assert.equal(textOf(findByClass(two.host, 'cmp-model')[0]), 'Sonnet 4.6 +2');

  // A dated id keeps its family and drops the date part rather than printing it.
  const haiku = await view(payload([row({ mainModel: 'claude-haiku-4-5-20251001', mainModels: 1 })]));
  assert.equal(textOf(findByClass(haiku.host, 'cmp-model')[0]), 'Haiku 4.5');

  // A session that made no weighable call simply carries no model chip.
  const none = await view(payload([row({ mainModel: null, mainModels: 0 })]));
  assert.equal(findByClass(none.host, 'cmp-model').length, 0);
});

test('the default window is `all` — the widest one, not a 7-day slice', async () => {
  // Starting on 7d hid the sessions the surface exists to surface. The segmented control shows
  // which window is active, so the default has to be observable, not just a variable.
  const { host } = await view({
    generatedAt: NOW,
    windows: {
      all: {
        sessions: 3,
        weight: 300,
        subagentWeight: 0,
        byModel: [],
        top: [row({ sessionId: 'wide' })],
        restSessions: 2,
        restWeight: 200,
      },
      d30: {
        sessions: 2,
        weight: 200,
        subagentWeight: 0,
        byModel: [],
        top: [row({ sessionId: 'mid' })],
        restSessions: 1,
        restWeight: 100,
      },
      d7: {
        sessions: 1,
        weight: 100,
        subagentWeight: 0,
        byModel: [],
        top: [row({ sessionId: 'narrow' })],
        restSessions: 0,
        restWeight: 0,
      },
    },
  });
  assert.ok(textOf(findByClass(host, 'rt-scope')[0]).startsWith('3 sessions in window'));
  const on = findByClass(host, 'rt-seg')[0].children.filter((b: any) => b.className.includes('on'));
  assert.equal(on.length, 1);
  assert.equal(textOf(on[0]), 'all');
});

test('the token figure is the complete count, cache reads included, and says so on hover', async () => {
  // The row carries two numbers in the same unit — this one raw, the right-hand one weighted — so
  // the raw one has to say which it is somewhere other than in the docs.
  const { host } = await view(payload([row({ tokensComplete: 656_500_000 })]));
  const tok = findByClass(host, 'cmp-tok')[0];
  assert.equal(textOf(tok), '656.5M tokens');
  assert.ok(/cache read/.test(tok.title), tok.title);
  assert.ok(/every model/.test(tok.title), tok.title);
});

test('the ▲N chip appears only when the weighting really moved the session', async () => {
  const shifted = await view(payload([row({ rank: 1, rawRank: 49 })]));
  assert.equal(findByClass(shifted.host, 'cmp-shift').length, 1);
  assert.ok(textOf(findByClass(shifted.host, 'cmp-shift')[0]).includes('▲48'));

  // A ±1 shuffle is noise; a chip on every row would stop meaning anything.
  const nudged = await view(payload([row({ rank: 2, rawRank: 3 })]));
  assert.equal(findByClass(nudged.host, 'cmp-shift').length, 0);

  // Moved DOWN by the weighting: same chip, muted, pointing the other way.
  const down = await view(payload([row({ rank: 9, rawRank: 4 })]));
  const chip = findByClass(down.host, 'cmp-shift')[0];
  assert.ok(textOf(chip).includes('▼5'));
  assert.ok(chip.className.includes('cmp-down'));
});

test('a subagent share is stated whenever there is one — at no threshold', async () => {
  // It is a fact about the session, not a judgement about what deserves the space: a 5% cut used to
  // hide it, and "2% subagents" is as true as 24%.
  const small = await view(payload([row({ weight: 1000, subagentWeight: 20 })]));
  assert.equal(textOf(findByClass(small.host, 'cmp-sub')[0]), '2% subagents');
  const loud = await view(payload([row({ weight: 1000, subagentWeight: 240 })]));
  assert.equal(textOf(findByClass(loud.host, 'cmp-sub')[0]), '24% subagents');
  // Only a session that launched none says nothing.
  const none = await view(payload([row({ weight: 1000, subagentWeight: 0 })]));
  assert.equal(findByClass(none.host, 'cmp-sub').length, 0);
});

test('the bar is the weight and its segments are the model mix', async () => {
  const { host } = await view(
    payload([
      row({
        weight: 1000,
        byModel: [
          { model: 'claude-opus-4-8', weight: 750 },
          { model: 'claude-haiku-4-5-20251001', weight: 250 },
        ],
      }),
      row({ sessionId: 'bbbb', weight: 250, rank: 2, rawRank: 2, byModel: [{ model: 'claude-fable-5', weight: 250 }] }),
    ]),
  );
  const fills = findByClass(host, 'cmp-fill');
  assert.equal(fills[0].style.width, '100%', 'the heaviest row fills the track');
  assert.equal(fills[1].style.width, '25%', 'a quarter of the weight is a quarter of the track');
  // Segments are ordered Fable → Opus → Sonnet → Haiku, so the bar reads the same way every time.
  assert.deepEqual(
    fills[0].children.map((c: any) => c.style.width),
    ['75%', '25%'],
  );
  assert.equal(fills[1].children.length, 1);
});

test('a session with no subject is labelled, never blank', async () => {
  const { host } = await view(payload([row({ subject: null, entrypoint: 'sdk-cli' })]));
  const subj = findByClass(host, 'cmp-subj')[0];
  assert.equal(textOf(subj), 'Automated run · sdk-cli');
  assert.ok(subj.className.includes('cmp-unnamed'));
});

test('what the top-N cut left out is always stated', async () => {
  const { host } = await view(payload([row()], { sessions: 958, restSessions: 957, restWeight: 3800 }));
  const note = findByClass(host, 'rt-note')
    .map((n: any) => textOf(n))
    .join(' ');
  assert.ok(note.includes('957 lighter sessions'), note);
  assert.ok(note.includes('3.8k'), note);
});

test('the explanation of the number is always on screen, and never names an equivalence unit', async () => {
  const { host } = await view(payload([row()]));
  assert.equal(findByClass(host, 'cmp-expl').length, 1);
  const chips = findByClass(host, 'cmp-chip').map((c: any) => textOf(c));
  assert.deepEqual(chips, ['Haiku ×1', 'Sonnet ×2–3', 'Opus ×5', 'Fable ×10']);
  const all = findByClass(host, 'cmp-lede')
    .map((n: any) => textOf(n))
    .join(' ');
  assert.ok(/never a cost in dollars/i.test(all), all);
  assert.ok(!/equivalent/i.test(all), 'no "opus-equivalent" wording: the description replaces the unit label');
});

test('an empty window says so instead of drawing an empty leaderboard', async () => {
  const { host } = await view(payload([], { sessions: 0, weight: 0, byModel: [] }));
  assert.equal(findByClass(host, 'cmp-row').length, 0);
  assert.equal(findByClass(host, 'rt-empty').length, 1);
});

test('a failed fetch leaves the surface saying so, not crashing', async () => {
  const host = mount();
  const v = createCompareView(host, { loadComparison: async () => null, onOpenSession: () => {} });
  await v.refresh();
  await tick();
  assert.equal(findByClass(host, 'rt-empty').length, 1);
});

test('a row opens the session it describes — by click and by keyboard', async () => {
  const { host, opened } = await view(
    payload([
      row({ sessionId: 'first-session' }),
      row({ sessionId: 'second-session', rank: 2, rawRank: 2, weight: 500 }),
    ]),
  );
  const rows = findByClass(host, 'cmp-row');
  rows[1].onclick();
  assert.deepEqual(opened, ['second-session'], 'the row opens ITS session, not the first one');

  // A div that only answers the mouse is a button nobody can tab to.
  assert.equal(rows[0].tabIndex, 0);
  assert.equal(rows[0].getAttribute('role'), 'button', 'announced as a button to assistive tech');
  rows[0].onkeydown({ key: 'Enter', preventDefault() {} });
  rows[0].onkeydown({ key: 'x', preventDefault() {} });
  assert.deepEqual(opened, ['second-session', 'first-session'], 'Enter opens, an unrelated key does not');
});

test('the KPI tiles are gone: the leaderboard is the surface', async () => {
  // Removed on request (Davide, 2026-07-28). Asserted so they do not creep back in with a later
  // edit — and because the shell they used (`rt-kpi`) still exists for Home.
  const { host } = await view(payload([row()]));
  assert.equal(findByClass(host, 'rt-kpi').length, 0);
});
