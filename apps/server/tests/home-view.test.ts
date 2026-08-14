import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createHomeView } from '../src/client/home-view.ts';
import type { Retrospective, RetroWindow } from '../src/core/types.ts';
import { fakeDoc, findByClass, textOf } from './fake-dom.ts';

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

const win = (o: Partial<RetroWindow>): RetroWindow => ({
  turns: 100,
  p50: 11000,
  p90: 100000,
  p95: 184000,
  p50Complete: 15000,
  p95Complete: 200000,
  totalTokens: 500e6,
  newTokens: 20e6,
  apiCalls: 1200,
  resume: { turns: 9, tokens: 1.4e6 },
  byModel: [
    { model: 'claude-opus-4-8', tokens: 15e6 },
    { model: 'claude-sonnet-4-6', tokens: 5e6 },
  ],
  esc: { turns: 10, tokens: 500000 },
  escStreak: 4,
  context: 20,
  subWaste: 5,
  compaction: 3,
  exploration: 15,
  unverifiedShip: 2,
  crit: 16,
  warn: 9,
  workMs: 40 * 36e5,
  hist: [10, 20, 30, 20, 10, 7, 3],
  ...o,
});
const emptyDay = { crit: 0, warn: 0, good: 0, tokens: 0, workMs: 0 };
const retro: Retrospective = {
  sessions: 42,
  reentrySessions: 11,
  spanDays: 30,
  baseline: {
    overall: { count: 100, p50: 11000, p90: 100000, p95: 184000 },
    byEffort: {},
    turnsScanned: 100,
    sessionsScanned: 42,
  },
  weeks: [
    { crit: 5, warn: 3, good: 20, tokens: 120e6, workMs: 9 * 36e5 },
    { crit: 2, warn: 1, good: 10, tokens: 60e6, workMs: 4 * 36e5 },
  ],
  days: [
    { crit: 1, warn: 0, good: 5, tokens: 10e6, workMs: 2 * 36e5 }, // today
    { crit: 0, warn: 1, good: 3, tokens: 8e6, workMs: 1 * 36e5 }, // yesterday
    emptyDay,
    emptyDay,
    emptyDay,
    emptyDay,
    emptyDay,
  ],
  tools: [
    { name: 'Bash', count: 120 },
    { name: 'Edit', count: 45 },
    { name: 'Read', count: 30 },
  ],
  windows: {
    all: win({}),
    d30: win({}),
    d7: win({ turns: 30, p50: 26000, p50Complete: 35000, p95Complete: 260000, crit: 6 }),
  },
};

test('home-view: renders KPI tiles + every chart from the retrospective', async () => {
  const container = mount();
  createHomeView(container, { loadRetro: async () => retro });
  await tick();
  assert.match(textOf(container), /100 turns across 42 sessions/);
  assert.equal(findByClass(container, 'rt-hbar').length, 7, 'one histogram bar per bin');
  assert.equal(findByClass(container, 'rt-wk').length, 2, 'one activity bar per week');
  // waste (7 causes, incl. cold resumes) + tools (3) share the bar-row class
  assert.equal(findByClass(container, 'rt-brow').length, 7 + 3);
  // The one session-level reading a per-turn verdict cannot give: tokens spent re-entering.
  assert.match(textOf(container), /re-entering/);
  const nums = findByClass(container, 'rt-num').map((n: any) => n.textContent);
  assert.equal(nums[0], '15k', 'median KPI uses complete tokens (p50Complete)');
  assert.equal(nums[1], '500M', 'tokens spent = COMPLETE total (incl. cache reads)');
  assert.equal(nums[2], '1.2k', 'API calls KPI');
  // by-model card: a stacked bar + one legend row per shown model
  assert.equal(findByClass(container, 'rt-mbar').length, 1);
  assert.equal(findByClass(container, 'rt-mrow').length, 2);
  assert.match(textOf(container), /Opus 4\.8/, 'model id rendered as a short label');
});

test('home-view: the activity tabs switch the unit AND the bar shape, without refetching', async () => {
  const container = mount();
  let fetches = 0;
  createHomeView(container, {
    loadRetro: async () => {
      fetches++;
      return retro;
    },
  });
  await tick();
  const tab = (label: string) =>
    findByClass(container, 'rt-mtabs')[0].children.find((b: any) => b.textContent === label);
  const values = () => findByClass(container, 'rt-wkv').map((n: any) => n.textContent);
  const stackSegments = () =>
    findByClass(container, 'rt-wk').flatMap((c: any) => c.children.map((i: any) => i.className));

  // default: tokens — a volume, so a single-colour bar (never the severity palette)
  assert.deepEqual(values(), ['60M', '120M'], 'oldest week left, current week right');
  assert.deepEqual(stackSegments(), ['rt-solid', 'rt-solid']);

  tab('turns').onclick();
  assert.deepEqual(values(), ['13', '28'], 'turn counts = crit + warn + good');
  assert.deepEqual(
    stackSegments(),
    ['rt-good', 'rt-warn', 'rt-crit', 'rt-good', 'rt-warn', 'rt-crit'],
    'severity stack',
  );

  tab('hours').onclick();
  assert.deepEqual(values(), ['4h', '9h']);
  assert.deepEqual(stackSegments(), ['rt-solid', 'rt-solid']);

  assert.equal(fetches, 1, 'switching metric repaints from the loaded retrospective');
});

test('home-view: the time filter switches window client-side (no refetch)', async () => {
  const container = mount();
  let fetches = 0;
  createHomeView(container, {
    loadRetro: async () => {
      fetches++;
      return retro;
    },
  });
  await tick();
  // switch to the 7-day window (fake-dom drops setAttribute, so match the button by its label)
  findByClass(container, 'rt-seg')[0]
    .children.find((b: any) => b.textContent === '7 days')
    .onclick();
  assert.match(textOf(container), /30 turns/, 'title reflects the 7-day window');
  assert.equal(findByClass(container, 'rt-num')[0].textContent, '35k', 'median updates to the window (p50Complete)');
  assert.equal(findByClass(container, 'rt-wk').length, 7, 'activity shows one bar per day in the 7d window');
  assert.equal(fetches, 1, 'all windows came in one response — no refetch on switch');
});

test('home-view: empty corpus shows the empty state, not broken-looking charts', async () => {
  const container = mount();
  createHomeView(container, {
    loadRetro: async () => ({ ...retro, windows: { ...retro.windows, all: win({ turns: 0 }) } }),
  });
  await tick();
  assert.equal(findByClass(container, 'rt-hbar').length, 0);
  assert.equal(findByClass(container, 'rt-empty').length, 1);
});

test('home-view: a failed fetch falls back to the empty state (never throws)', async () => {
  const container = mount();
  createHomeView(container, { loadRetro: async () => null });
  await tick();
  assert.equal(findByClass(container, 'rt-empty').length, 1);
});

const noTurns = (over: Partial<Retrospective> = {}): Retrospective => ({
  ...retro,
  ...over,
  windows: { ...retro.windows, all: win({ turns: 0 }) },
});

const leadOf = async (loadRetro: () => Promise<Retrospective | null>, sessionsOnDisk?: () => number) => {
  const container = mount();
  createHomeView(container, { loadRetro, sessionsOnDisk });
  await tick();
  return textOf(findByClass(container, 'rt-empty-lead')[0]);
};

// The three situations reach ONE branch, and the text has to be true in each. The old single
// sentence was true in one of them, which is the whole reason this is now three assertions.
test('home-view: the empty state says WHY it is empty, and never claims more than it read', async () => {
  // Nothing on disk: the requirement, stated as the requirement.
  assert.match(
    await leadOf(
      async () => noTurns({ sessions: 0 }),
      () => 0,
    ),
    /needs a Claude Code session\. There is none on this machine yet\./,
  );

  // Sessions ARE there, none finished: claiming "there is none" would be a lie told to someone
  // who is watching one run.
  assert.match(
    await leadOf(
      async () => noTurns(),
      () => 3,
    ),
    /There are sessions here, none with a finished turn yet\./,
  );

  // Nothing was read at all — so nothing may be asserted about the machine.
  const unread = await leadOf(async () => null);
  assert.match(unread, /needs a Claude Code session\./);
  assert.doesNotMatch(unread, /none on this machine/, 'a failed fetch must not describe the disk');
});

// The regression that produced `sessionsOnDisk`. `Retrospective.sessions` counts only sessions
// that closed a turn, so a transcript with none is 0 there and 1 in the picker directly above this
// box (measured on a truncated transcript: roster 1, retro 0). Reading the retro here printed
// "there is none on this machine" over a picker showing one.
test('home-view: a session with no finished turn is never called absent', async () => {
  assert.match(
    await leadOf(
      async () => noTurns({ sessions: 0 }),
      () => 1,
    ),
    /There are sessions here/,
    'the roster decides the branch, not the retrospective',
  );
});

// Found in the browser, not here: the box paints BEFORE the first roster reading lands, so a
// machine with one unfinished session kept reading "there is none on this machine" for the life of
// the tab. `repaint()` is what corrects it, and it must not re-fetch to do so.
test('home-view: the box corrects itself when the roster answers after the first paint', async () => {
  let known = 0;
  let fetches = 0;
  const container = mount();
  const view = createHomeView(container, {
    loadRetro: async () => {
      fetches++;
      return noTurns({ sessions: 0 });
    },
    sessionsOnDisk: () => known,
  });
  await tick();
  const lead = () => textOf(findByClass(container, 'rt-empty-lead')[0]);
  assert.match(lead(), /none on this machine/, 'nothing known yet');

  known = 1; // the roster answers
  view.repaint();
  assert.match(lead(), /There are sessions here/, 'the box follows the roster');
  assert.equal(fetches, 1, 'a repaint costs no corpus scan');
});

// A count here would be a third way of stating a corpus figure this page already states twice.
test('home-view: the empty state prints no session count', async () => {
  const container = mount();
  createHomeView(container, { loadRetro: async () => noTurns(), sessionsOnDisk: () => 3 });
  await tick();
  assert.doesNotMatch(textOf(findByClass(container, 'rt-empty')[0]), /\d/, 'no digit in the empty box');
});

test('home-view: the CTA opens the picker', async () => {
  const container = mount();
  let picked = 0;
  createHomeView(container, { loadRetro: async () => retro, onPickSession: () => picked++ });
  await tick();
  findByClass(container, 'rt-cta')[0].onclick();
  assert.equal(picked, 1);
});
