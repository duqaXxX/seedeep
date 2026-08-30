import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGraph, type ToolOutputResult } from '../src/client/graph.ts';
import type { TurnNode } from '../src/core/session-tree.ts';
import { fakeDoc, findByClass, textOf } from './fake-dom.ts';

function baseSnapshot() {
  return {
    main: {
      fill: 611788,
      window: 1000000,
      pct: 61,
      estimated: false,
      model: 'claude-sonnet-4-6',
      models: ['claude-sonnet-4-6'],
      out: 2426,
      regions: [] as string[],
      breakdown: { input: 2, cacheRead: 611076, cacheCreation: 710 },
      // Summed over the session's calls — the Cache widget reads THIS, while `breakdown` (the
      // last call) stays behind the Context bar. Deliberately not a multiple of `breakdown`:
      // a fixture where they agree could not catch the widget reading the wrong one.
      cacheTotals: { read: 4_120_000, created: 380_000 },
      inputTotal: 90_000,
      outputTotal: 60_000,
      thinkingTotal: null as number | null,
      weighted: 0,
      weightedByModel: [],
    },
    // Full ToolNode shape, not the three fields the widgets happen to read: the reducer
    // never emits a tool without id/arg/ctx, so a fixture missing them exercises a state
    // that cannot occur — and would hide a widget reading a field the real data always has.
    mainTools: [
      { id: 'toolu_base1', name: 'Read', ms: 95, arg: 'src/app.ts', ctx: 4200, turnIndex: null },
      { id: 'toolu_base2', name: 'Bash', ms: 189, arg: 'bun test', ctx: 0, turnIndex: null },
    ],
    filesChanged: [
      { path: 'src/app.ts', turnIndex: null, ts: '2026-07-23T10:00:00.000Z' },
      { path: 'src/app.ts', turnIndex: null, ts: '2026-07-23T10:01:00.000Z' },
      { path: 'README.md', turnIndex: null, ts: '2026-07-23T10:02:00.000Z' },
    ],
    subagents: [] as any[],
    subagentsTotal: 0,
    subagentsEstimated: false,
    subagentTokensByModel: [] as any[],
    weightedSubagents: 0,
    weightedByModel: [] as any[],
    compactions: [] as any[],
    seq: 1,
    turns: 3,
    apiCalls: 12,
    skills: [] as any[],
    commands: [] as any[],
    turnList: [] as any[],
    openCall: null,
    wakeup: null,
    notes: [],
    error: null,
  };
}

test('bento shell mounts and builds the widget scaffold, destroy clears it', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const state = { snapshot: baseSnapshot, onChange: () => () => {}, onEvent: () => () => {} };

  const view = createGraph(container, state);
  assert.ok(container.children.length > 0, 'container populated with the bento scaffold');

  view.destroy();
  assert.equal(container.children.length, 0, 'destroy clears the container');
  g.document = prevDoc;
});

// Commits and Cards used to JOIN the output row only once they had content, so a session
// with neither showed no such widget at all — there was nothing on screen to say the session had
// shipped no commit, as against seedeep not looking. They are now always there, on their own empty
// state, like every other widget.
test('the output row always holds Commits and Cards, even with nothing in them', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const state = { snapshot: baseSnapshot, onChange: () => () => {}, onEvent: () => () => {} };

  // No loaders at all — the hardest case: nothing will ever answer, and the cards must still be
  // there rather than waiting for a fetch that is not coming.
  const view = createGraph(container, state);

  const titles = findByClass(container, 'wtitle').map((t: any) => t.textContent);
  assert.ok(titles.includes('Commits'), 'the Commits widget is on the page');
  assert.ok(titles.includes('Cards'), 'the Cards widget is on the page');
  const row = findByClass(container, 'outrow')[0];
  assert.equal(row.children.length, 3);
  assert.ok(row.className.includes('triple'), 'and the row is laid out for three');
  // Main tools LEADS the row (the maintainer's call) — the widest card and the one read most, so it sits
  // where the eye lands first.
  assert.deepEqual(
    row.children.map((c: any) => findByClass(c, 'wtitle')[0]?.textContent),
    ['Main tools', 'Commits', 'Cards'],
  );
  // A button that cannot expand anything must not offer to: with no rows, the drawer it opens
  // would be empty. Scoped to the two trailing cards — Main tools has an expander of its own,
  // which has plenty to show.
  for (const card of [row.children[1], row.children[2]]) {
    const expand = findByClass(card, 'xbtn').find((b: any) => b.textContent === 'Expand all');
    assert.equal(expand?.hidden, true, 'nothing to expand, nothing offered');
  }

  view.destroy();
  g.document = prevDoc;
});

// A scope-banner button, picked by its label (Input and Output share the .sbout class).
function bannerBtn(banner: any, label: string): any {
  return findByClass(banner, 'sbout').find((b: any) => b.textContent === label);
}

test('bento shell renders a subagent card per subagent (consumed bar from existing fill)', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = baseSnapshot();
  snap.subagents = [
    {
      agentId: 'ag1',
      agentType: 'general-purpose',
      model: 'claude-sonnet-4-6',
      title: 'Review the reducer diff',
      fill: 59700,
      window: 200000,
      pct: 30,
      estimated: false,
      state: 'done',
      startedAt: '2026-07-12T00:00:00Z',
      durationMs: 383000,
      tools: [{ name: 'Bash', ms: 100 }],
    },
  ];
  const state = { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} };

  const view = createGraph(container, state);
  const cards = findByClass(container, 'subcard');
  assert.equal(cards.length, 1, 'one subagent card rendered');
  // The card is named by the WORK, with the type demoted to a chip — same rule as the
  // live row, so the two surfaces cannot disagree about what a subagent is called.
  assert.equal(findByClass(container, 'atype')[0].textContent, 'Review the reducer diff');
  assert.equal(findByClass(container, 'atype-chip')[0].textContent, 'general-purpose');
  view.destroy();
  g.document = prevDoc;
});

// On an ended session the subagent card must fill the left column with the COMPLETE list (a
// scrolling .sublist of one row per subagent), NOT collapse to a one-line summary — the collapse
// left the left column short while the feed ran tall, breaking the portal symmetry.
test('ended session: the subagent card fills the column with the full list, not a one-line collapse', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = baseSnapshot();
  snap.subagents = [
    {
      agentId: 'a1',
      agentType: 'general-purpose',
      model: 'claude-opus-4-8',
      title: 'Probe the schema guard',
      fill: 40000,
      window: 200000,
      pct: 20,
      estimated: false,
      state: 'done',
      startedAt: '2026-07-12T00:00:00Z',
      durationMs: 42000,
      tools: [],
    },
    {
      agentId: 'a2',
      agentType: 'general-purpose',
      model: 'claude-haiku-4-5',
      title: 'Read the runtime logs',
      fill: 10000,
      window: 200000,
      pct: 5,
      estimated: false,
      state: 'done',
      startedAt: '2026-07-12T00:01:00Z',
      durationMs: 8000,
      tools: [],
    },
    {
      agentId: 'a3',
      agentType: 'code-explorer',
      model: 'claude-sonnet-4-6',
      title: 'Trace the toprow grid',
      fill: 70000,
      window: 200000,
      pct: 35,
      estimated: false,
      state: 'done',
      startedAt: '2026-07-12T00:02:00Z',
      durationMs: 72000,
      tools: [],
    },
  ] as any[];
  const state = { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} };

  const view = createGraph(container, state, { ended: true });
  const card = findByClass(container, 'sublivecard')[0];
  assert.ok(
    card.className.split(' ').includes('fulllist'),
    'the ended card fills the column (.fulllist), not collapsed',
  );
  assert.equal(findByClass(container, 'slsum').length, 0, 'no one-line collapsed summary is rendered');
  const list = findByClass(card, 'sublist')[0];
  assert.ok(list, 'the ended card holds a scrolling .sublist');
  assert.equal(findByClass(list, 'subrow').length, 3, 'one row per subagent that ran');
  // Row named by the WORK (launch order), model demoted to a chip — same rule as the catalog.
  assert.equal(findByClass(list, 'smid')[0].children[0].textContent, 'Probe the schema guard');
  view.destroy();
  g.document = prevDoc;
});

// A finished subagent can carry durationMs=null (its timing never resolved). formatDuration(null)
// is "running…", which on an ended session is a lie — the row must show a dash instead.
test('ended session: a finished subagent with unknown duration shows a dash, not "running…"', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = baseSnapshot();
  snap.subagents = [
    {
      agentId: 'a1',
      agentType: 'general-purpose',
      model: 'claude-opus-4-8',
      title: 'Background probe',
      fill: 40000,
      window: 200000,
      pct: 20,
      estimated: false,
      state: 'done',
      startedAt: '2026-07-12T00:00:00Z',
      durationMs: null,
      tools: [],
    },
  ] as any[];
  const state = { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} };

  const view = createGraph(container, state, { ended: true });
  const dur = findByClass(container, 'sdur')[0];
  assert.equal(dur.textContent, '—', 'unknown duration renders a dash, not "running…"');
  view.destroy();
  g.document = prevDoc;
});

// Snapshot with one subagent card so clicking it opens the drawer.
function snapWithSubagent() {
  const snap = baseSnapshot();
  snap.subagents = [
    {
      agentId: 'ag1',
      agentType: 'general-purpose',
      model: 'claude-sonnet-4-6',
      title: 'Review the reducer diff',
      fill: 59700,
      window: 200000,
      pct: 30,
      estimated: false,
      state: 'done',
      startedAt: '2026-07-12T00:00:00Z',
      durationMs: 383000,
      tools: [{ name: 'Bash', ms: 100 }],
    },
  ];
  return snap;
}

// One subagent, one name: the row, the card and the drawer they open must all say the
// same thing. The drawer used to be titled by the type, so clicking "Review the reducer
// diff" landed on a panel headed "general-purpose". The type is not lost — it identifies
// the agent, so it sits in the header's identity line under the title.
test('the subagent drawer is headed by the work, and keeps the type in its identity line', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const view = createGraph(container, {
    snapshot: () => snapWithSubagent(),
    onChange: () => () => {},
    onEvent: () => () => {},
  });

  findByClass(container, 'subcard')[0].onclick();
  const body = findByClass(container, 'dbody')[0] ?? findByClass(container, 'drawer')[0];
  const text = textOf(body);
  assert.ok(text.includes('Review the reducer diff'), 'the drawer is headed by the work: ' + text.slice(0, 160));
  const d = drawerOf(container);
  assert.equal(d.title, 'Review the reducer diff', 'the <h3> itself is the work, not the type');
  assert.ok(d.sub?.includes('general-purpose'), 'the type survives in the identity line: ' + d.sub);

  view.destroy();
  g.document = prevDoc;
});

// The stacked bar replaced two pipe-separated text rows ("read 2.0M 96% | write 78.7k 4%").
// Text cannot lie about a ratio; a bar can — so the widths are what this asserts. The
// dropped-vs-kept rule is the other half: a zero segment must vanish from the BAR (a 0-width
// slice is a rendering artefact) while staying in the LEGEND, because "output 71" is a fact.
test('the subagent drawer draws its volume as a proportion, and keeps zero categories in the legend', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = snapWithSubagent();
  // 96% / 4% / 0 / a sliver — the real shape of a subagent's usage block.
  snap.subagents[0].volume = 2_100_000;
  snap.subagents[0].volumeBreakdown = { cacheRead: 2_016_000, cacheCreation: 84_000, output: 0, input: 290 };
  const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });

  findByClass(container, 'subcard')[0].onclick();
  const bar = findByClass(container, 'dstack')[0];
  const widths = bar.children.map((c: any) => c.style.width);
  assert.equal(widths.length, 3, 'the zero-value category gets no slice: ' + JSON.stringify(widths));
  const sum = widths.reduce((n: number, w: string) => n + parseFloat(w), 0);
  assert.ok(Math.abs(sum - 100) < 0.01, 'the slices are shares of the whole, summing to 100%: ' + sum);
  assert.ok(parseFloat(widths[0]) > 95, 'cache read dominates — the point the two text rows could not show');

  const d = drawerOf(container);
  assert.ok(d.legend?.includes('output'), 'the zero category survives in the legend: ' + d.legend);
  // Bookkeeping is demoted, not deleted.
  assert.equal(d.meta('Model'), 'claude-sonnet-4-6', 'the full model id lands in Details');
  assert.equal(d.meta('Spawned in turn'), undefined, 'a fact the snapshot does not carry gets no empty row');

  view.destroy();
  g.document = prevDoc;
});

test('opening the drawer locks page scroll; closing it restores scroll', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = snapWithSubagent();
  const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });

  assert.equal(g.document.documentElement.style.overflow, '', 'page scrolls before any drawer opens');
  findByClass(container, 'subcard')[0].onclick();
  assert.equal(g.document.documentElement.style.overflow, 'hidden', 'drawer open locks page scroll');
  findByClass(container, 'close')[0].onclick(); // drawer ✕
  assert.equal(g.document.documentElement.style.overflow, '', 'closing the drawer restores page scroll');

  view.destroy();
  g.document = prevDoc;
});

test('scroll-lock is ref-counted across tabs: last-closed unlocks, destroy releases', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc(); // one shared document (== one shared documentElement) for both tabs
  const snap = snapWithSubagent();
  const mk = () => {
    const c = g.document.createElement();
    return { c, view: createGraph(c, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} }) };
  };
  const a = mk(),
    b = mk();

  findByClass(a.c, 'subcard')[0].onclick(); // tab A drawer open
  findByClass(b.c, 'subcard')[0].onclick(); // tab B drawer open
  assert.equal(g.document.documentElement.style.overflow, 'hidden', 'two drawers open → locked');

  findByClass(a.c, 'close')[0].onclick(); // close A while B still open
  assert.equal(g.document.documentElement.style.overflow, 'hidden', 'still locked while B open');

  b.view.destroy(); // tear down B with its drawer still open
  assert.equal(g.document.documentElement.style.overflow, '', 'last holder gone → unlocked');

  a.view.destroy();
  g.document = prevDoc;
});

// Collect every node in the tree whose tagName matches (fake nodes carry no tagName,
// so we tag via className instead where needed). Here we walk for <pre> and buttons.
function findAll(root: any, pred: (n: any) => boolean, acc: any[] = []): any[] {
  for (const c of root.children ?? []) {
    if (pred(c)) acc.push(c);
    findAll(c, pred, acc);
  }
  return acc;
}

test('long launch prompt is truncated in the drawer and "show full" opens the modal with the full text', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const longPrompt = 'X'.repeat(1200); // > 500 → must truncate + offer "show full"
  const snap = snapWithSubagent();
  snap.subagents[0].prompt = longPrompt;
  const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });

  findByClass(container, 'subcard')[0].onclick(); // open drawer

  // the launch-prompt <pre> shows the truncated text with an ellipsis, not the full 1200 chars
  const pres = findAll(
    container,
    (n) => typeof n.textContent === 'string' && n.textContent.startsWith('X') && n.textContent.includes('…'),
  );
  assert.equal(pres.length, 1, 'one truncated prompt pre');
  assert.ok(pres[0].textContent.length < longPrompt.length, 'prompt is truncated');

  // the omodal is not open yet
  const omodal = findByClass(container, 'omodal')[0];
  assert.ok(!omodal.classList.contains('on'), 'modal closed before clicking show full');

  // clicking "show full ▾" opens the modal with the FULL prompt text
  const btn = findByClass(container, 'morebtn')[0];
  assert.ok(btn, 'show-full button rendered for a long prompt');
  btn.onclick();
  assert.ok(omodal.classList.contains('on'), 'modal opened');
  const obody = findByClass(container, 'obody')[0];
  assert.equal(textOf(obody), longPrompt, 'modal shows the full untruncated prompt');

  view.destroy();
  g.document = prevDoc;
});

test('graph: Live activity has a Trace button that opens the trace modal', () => {
  const g = globalThis as any;
  const prev = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = baseSnapshot(); // has >=1 turn in turnList
  const state = { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} };
  const view = createGraph(container, state, { sessionId: 's1' });
  const btns = findByClass(container, 'tracebtn');
  assert.ok(btns.length > 0, 'tracebtn exists in the Live activity card');
  btns[0].onclick();
  assert.ok(findByClass(container, 'trace-modal').length > 0, 'trace modal opened after clicking Trace');
  view.destroy();
  g.document = prev;
});

test('short launch prompt shows no "show full" button (already fully visible)', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = snapWithSubagent();
  snap.subagents[0].prompt = 'short prompt'; // < 500 → no button
  const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });

  findByClass(container, 'subcard')[0].onclick();
  assert.equal(findByClass(container, 'morebtn').length, 0, 'no show-full button for a short prompt');

  view.destroy();
  g.document = prevDoc;
});

// ---- scope banner: single-row layout + Output button ----

// Typed as TurnNode, not `any`: a field the reducer adds must break this file at compile
// time. As `any` it did not — 29 tests blew up at RUNTIME instead, when `models` and
// `efforts` were added and every fixture silently lacked them.
function makeTurn(index: number, opts: Partial<TurnNode> = {}): TurnNode {
  return {
    index,
    prompt: 'Turn ' + index + ' prompt',
    thinking: null,
    startedAt: '2026-07-14T10:00:00Z',
    kind: opts.kind ?? 'work',
    command: opts.command ?? null,
    state: opts.state ?? 'done',
    cutoff: opts.cutoff ?? false,
    durationMs: 60000,
    messageCount: 3,
    apiCalls: 5,
    deltaFill: opts.deltaFill ?? 10000,
    fillEnd: index * 10000,
    breakdown: { input: 100, cacheRead: 9800, cacheCreation: 100 },
    cacheTotals: { read: 40_000, created: 12_000 },
    inputTotal: 8_000,
    out: 500,
    weighted: opts.weighted ?? 0,
    agentIds: [],
    skills: [],
    commands: [],
    models: opts.models ?? ['claude-opus-4-8'],
    efforts: opts.efforts ?? [],
    // The reducer always emits these (empty when the turn made no call / reported no
    // effort), so a fixture without them is a shape the code never actually sees.

    compaction: opts.compaction ?? false,
    result: opts.result !== undefined ? opts.result : 'The answer for turn ' + index,
    firstCall: opts.firstCall ?? null,
    rebuildExpected: opts.rebuildExpected ?? false,
    lastNarration: opts.lastNarration ?? null,
    activity: opts.activity ?? null,
    lastWordTs: opts.lastWordTs ?? null,
  };
}

function snapWithTurns(turns: any[]): any {
  const snap = baseSnapshot();
  snap.turns = turns.length;
  snap.turnList = turns;
  return snap;
}

test('scope banner: whole-session mode shows "Whole session", no Prompt button, no Whole-session nav', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = snapWithTurns([makeTurn(1), makeTurn(2)]);
  const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });

  const banner = findByClass(container, 'scope-banner')[0];
  // whole-session: has 'on', no 'int'
  assert.ok(banner.classList.contains('on'), 'banner is visible in whole-session mode');
  assert.ok(!banner.classList.contains('int'), 'banner has no int class in whole-session mode');
  // sbprompt should read "Whole session"
  const prompt = findByClass(banner, 'sbprompt')[0];
  assert.equal(prompt?.textContent, 'Whole session');
  // A session has no single prompt to show, and no scope to exit — but it DOES have a final
  // answer, which is why Result is the one .sbout this scope carries (asserted below).
  assert.equal(bannerBtn(banner, 'Prompt'), undefined, 'no Prompt button in whole-session mode');
  assert.equal(findByClass(banner, 'xbtn').length, 0, 'no Whole-session button in session mode');

  view.destroy();
  g.document = prevDoc;
});

test('scope banner: whole session carries Result — the LAST answer the session produced', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  // The last ENTRY is a local command with no answer: the session's final answer is turn 2's,
  // and the button must not vanish because the last thing sent was `/clear` (4 of 106 real
  // sessions end that way).
  const snap = snapWithTurns([
    makeTurn(1, { result: 'first answer' }),
    makeTurn(2, { result: 'the last real answer' }),
    makeTurn(3, { kind: 'local', command: 'clear', result: null }),
  ]);
  const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });

  const banner = findByClass(container, 'scope-banner')[0];
  const outBtn = bannerBtn(banner, 'Result');
  assert.ok(outBtn, 'Result button present in whole-session mode');

  const omodal = findByClass(container, 'omodal')[0];
  outBtn.onclick({ stopPropagation: () => {} });
  assert.ok(omodal.classList.contains('on'), 'modal opened after clicking Result');
  assert.equal(textOf(findByClass(container, 'obody')[0]), 'the last real answer');
  // It names the turn it came from — in whole session nothing else says which answer this is.
  assert.match(textOf(findByClass(container, 'ohead')[0]), /^Turn 2 result/);

  view.destroy();
  g.document = prevDoc;
});

test('scope banner: whole session drops Result while a turn is RUNNING', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  // Turn 2 is working: the newest answer is turn 1's, and offering it as the session's Result
  // would claim a conclusion the session has not reached.
  const running = snapWithTurns([
    makeTurn(1, { result: 'the previous answer' }),
    makeTurn(2, { state: 'live', result: null }),
  ]);
  const view = createGraph(container, { snapshot: () => running, onChange: () => () => {}, onEvent: () => () => {} });
  assert.equal(
    bannerBtn(findByClass(container, 'scope-banner')[0], 'Result'),
    undefined,
    'no Result while a turn runs',
  );
  view.destroy();

  // The same session with nothing running gets it back — the guard is the RUNNING turn, not
  // the presence of an older answer.
  const container2 = g.document.createElement();
  const settled = snapWithTurns([
    makeTurn(1, { result: 'the previous answer' }),
    makeTurn(2, { result: 'the newest' }),
  ]);
  const view2 = createGraph(container2, {
    snapshot: () => settled,
    onChange: () => () => {},
    onEvent: () => () => {},
  });
  assert.ok(bannerBtn(findByClass(container2, 'scope-banner')[0], 'Result'), 'Result returns once the turn closes');

  view2.destroy();
  g.document = prevDoc;
});

test('scope banner: whole session with no answer anywhere carries no Result', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  // 8 of 106 real sessions hold no result at all (interrupted throughout, or nothing but
  // local commands). Same guard as the turn scope: no answer, no button.
  const snap = snapWithTurns([makeTurn(1, { state: 'interrupted', result: null })]);
  const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });

  const banner = findByClass(container, 'scope-banner')[0];
  assert.equal(bannerBtn(banner, 'Result'), undefined, 'no Result button without an answer');

  view.destroy();
  g.document = prevDoc;
});

// Helpers: Explore TOGGLES the strip, so it is opened once; bars are re-queried on every
// click because each selection re-renders them.
function openStrip(container: any): void {
  findByClass(container, 'obtn')[0].onclick({ stopPropagation: () => {} });
}
function clickBar(container: any, barIndex: number): void {
  findByClass(container, 'sb')[barIndex].onclick();
}
function selectTurnViaStrip(container: any, barIndex = 0): void {
  openStrip(container);
  clickBar(container, barIndex);
}

test('scope banner: selecting a turn via the strip shows single row — no sbresult child', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = snapWithTurns([makeTurn(1, { result: 'Good answer' }), makeTurn(2)]);
  const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });

  selectTurnViaStrip(container, 0); // select turn 1

  const banner = findByClass(container, 'scope-banner')[0];
  const num = findByClass(banner, 'sbnum')[0];
  assert.equal(num?.textContent, 'Turn 1 / 2', 'sbnum shows turn index / total');
  const prompt = findByClass(banner, 'sbprompt')[0];
  assert.equal(prompt?.textContent, 'Turn 1 prompt');
  assert.equal(findByClass(banner, 'xbtn').length, 1, 'Whole-session button present in turn mode');
  // no second-row sbresult — the old layout that caused the layout shift
  assert.equal(findByClass(banner, 'sbresult').length, 0, 'no sbresult second row');

  view.destroy();
  g.document = prevDoc;
});

test('scope banner: Result button shown for done turn with result, opens modal on click', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = snapWithTurns([makeTurn(1, { result: 'The full answer text' })]);
  const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });

  selectTurnViaStrip(container, 0); // select turn 1
  const banner = findByClass(container, 'scope-banner')[0];
  const outBtn = bannerBtn(banner, 'Result');
  assert.ok(outBtn, 'Result button present for a turn with result');

  const omodal = findByClass(container, 'omodal')[0];
  assert.ok(!omodal.classList.contains('on'), 'modal closed before click');
  outBtn.onclick({ stopPropagation: () => {} });
  assert.ok(omodal.classList.contains('on'), 'modal opened after clicking Result');
  const obody = findByClass(container, 'obody')[0];
  assert.equal(textOf(obody), 'The full answer text', 'modal body has the full result');

  view.destroy();
  g.document = prevDoc;
});

test('scope banner: no Output button for interrupted turn (no result), banner has int class', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = snapWithTurns([makeTurn(1, { state: 'interrupted', result: null })]);
  const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });

  selectTurnViaStrip(container, 0);
  const banner = findByClass(container, 'scope-banner')[0];
  assert.ok(banner.classList.contains('int'), 'banner has int class for interrupted turn');
  assert.equal(bannerBtn(banner, 'Result'), undefined, 'no Result button for interrupted turn');

  view.destroy();
  g.document = prevDoc;
});

test('scope banner: clicking Whole-session button deselects the turn', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = snapWithTurns([makeTurn(1), makeTurn(2)]);
  const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });

  selectTurnViaStrip(container, 0); // select turn 1
  const banner = findByClass(container, 'scope-banner')[0];
  assert.ok(
    findByClass(banner, 'sbnum').some((n: any) => n.textContent?.startsWith('Turn')),
    'turn selected',
  );

  findByClass(banner, 'xbtn')[0].onclick({ stopPropagation: () => {} });

  const bannerAfter = findByClass(container, 'scope-banner')[0];
  const prompt = findByClass(bannerAfter, 'sbprompt')[0];
  assert.equal(prompt?.textContent, 'Whole session', 'back to whole-session mode');

  view.destroy();
  g.document = prevDoc;
});

test('live turn: strip bar gets lv class (the strip is the only turn chart)', () => {
  // A single live turn — the common case: user just sent a prompt, Claude is still running.
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = snapWithTurns([makeTurn(1, { state: 'live', result: null, deltaFill: 8000 })]);
  const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });

  // The inner <i> inside .sb .up (positive deltaFill → up zone) must have class 'lv'.
  // Search INSIDE the strip: 'lv' is also the Session ledger's value class.
  function findLvInner(root: any, acc: any[] = []): any[] {
    for (const c of root.children ?? []) {
      if (typeof c.className === 'string' && c.className.split(' ').includes('lv')) acc.push(c);
      findLvInner(c, acc);
    }
    return acc;
  }
  // The mini sparkline is gone (the Session card carries only KPIs): closed strip = no chart.
  assert.equal(findByClass(container, 'tstrip').length, 0, 'no turn chart is rendered while the strip is closed');

  // Open strip and check the strip bar has an inner element with lv class
  findByClass(container, 'obtn')[0].onclick({ stopPropagation: () => {} });
  const strip = findByClass(container, 'tstrip')[0];
  assert.ok(strip, 'the strip opened');
  assert.ok(findLvInner(strip).length > 0, 'strip bar inner element has lv class for live turn');

  view.destroy();
  g.document = prevDoc;
});

test('live turn: scope banner shows sblive indicator when live turn selected', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = snapWithTurns([makeTurn(1, { state: 'live', result: null, deltaFill: 5000 })]);
  const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });

  selectTurnViaStrip(container, 0); // select the live turn
  const banner = findByClass(container, 'scope-banner')[0];
  const live = findByClass(banner, 'sblive')[0];
  assert.ok(live, 'sblive indicator present when live turn is selected');
  assert.ok(live.textContent?.startsWith('●'), 'sblive keeps the running dot');

  view.destroy();
  g.document = prevDoc;
});

// The counter must count from the turn's OWN start, not from when the page
// happened to open: a tab opened 3 minutes into a turn has to say 3 minutes.
test('live turn: the banner counts elapsed from the turn start, and ticks', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const startedAt = new Date(Date.now() - 65_000).toISOString(); // 1m 5s ago
  const snap = snapWithTurns([makeTurn(1, { state: 'live', result: null, deltaFill: 5000 })]);
  snap.turnList[0].startedAt = startedAt;
  const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });

  selectTurnViaStrip(container, 0);
  const live = findByClass(findByClass(container, 'scope-banner')[0], 'sblive')[0];
  assert.match(live.textContent ?? '', /^● 1m [45]s turn$/, 'elapsed measured from startedAt, not from now');

  // A tick repaints in place — the same node, a fresh value.
  snap.turnList[0].startedAt = new Date(Date.now() - 130_000).toISOString();
  view.destroy();
  g.document = prevDoc;
});

// The invariant the wall-clock ban exists for: a session that died mid-turn leaves that
// turn 'live' forever, and a counter there would tick upward on a dead session for as long
// as the tab stayed open. Ended ⇒ no counter, and therefore no timer.
test('ended session: a live turn shows no running counter', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = snapWithTurns([makeTurn(1, { state: 'live', result: null, deltaFill: 5000 })]);
  snap.turnList[0].startedAt = new Date(Date.now() - 65_000).toISOString();
  const view = createGraph(
    container,
    { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} },
    { ended: true },
  );

  selectTurnViaStrip(container, 0);
  assert.equal(
    findByClass(findByClass(container, 'scope-banner')[0], 'sblive').length,
    0,
    'no live counter on a session that has ended',
  );

  view.destroy();
  g.document = prevDoc;
});

// A turn with no readable start time cannot be counted from anywhere — it keeps the old
// static badge rather than counting from "now", which would falsely read 0s.
test('live turn with no startedAt keeps the static running badge', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = snapWithTurns([makeTurn(1, { state: 'live', result: null, deltaFill: 5000 })]);
  snap.turnList[0].startedAt = null;
  const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });

  selectTurnViaStrip(container, 0);
  const live = findByClass(findByClass(container, 'scope-banner')[0], 'sblive')[0];
  assert.equal(live.textContent, '● running turn');

  view.destroy();
  g.document = prevDoc;
});

test('done turn: no sblive indicator in scope banner', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = snapWithTurns([makeTurn(1, { state: 'done', result: 'answer' })]);
  const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });

  selectTurnViaStrip(container, 0);
  const banner = findByClass(container, 'scope-banner')[0];
  assert.equal(findByClass(banner, 'sblive').length, 0, 'no sblive for done turn');

  view.destroy();
  g.document = prevDoc;
});

// ---- the activity feed follows the selected turn ----

// A state whose events can be driven by the test, as the reducer drives them live:
// onEvent(e, ctx) — ctx.turnIndex is what the reducer knows and the event does not.
// `change()` fires the snapshot listener, exactly as the reducer does after folding.
function drivableState(snap: any) {
  let onEv: any = null,
    onCh: any = null;
  return {
    snapshot: () => snap,
    // Replace what the reducer would return NOW, without painting: the real gap between
    // reducer state and last-painted snapshot, which a single shared object cannot express.
    setSnapshot: (s: any) => {
      snap = s;
    },
    onChange: (cb: any) => {
      onCh = cb;
      return () => {
        onCh = null;
      };
    },
    onEvent: (cb: any) => {
      onEv = cb;
      return () => {
        onEv = null;
      };
    },
    emit: (e: any, turnIndex: number | null = null) => onEv?.(e, { turnIndex }),
    // Full ctx (turnIndex + label + newCall) — what a `usage` event needs to become one feed row.
    emitCtx: (e: any, ctx: any) => onEv?.(e, ctx),
    change: () => onCh?.(snap),
  };
}
const toolStart = (id: string, name: string, ts: string) => ({
  type: 'tool-start',
  id,
  name,
  arg: null,
  timestamp: ts,
  agentId: null,
});
// The feed rows: .fev, each carrying the tool name in .fn.
const feedNames = (container: any) =>
  findByClass(container, 'fev').map((r: any) => findByClass(r, 'fn')[0]?.textContent);

test("feed: whole session shows every turn's activity; selecting a turn scopes it to that turn", () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = snapWithTurns([makeTurn(1), makeTurn(2)]);
  const state = drivableState(snap);
  const view = createGraph(container, state);

  state.emit(toolStart('t1', 'Read', '2026-07-14T10:00:00Z'), 1);
  state.emit(toolStart('t2', 'Grep', '2026-07-14T10:00:01Z'), 1);
  state.emit(toolStart('t3', 'Bash', '2026-07-14T10:00:02Z'), 2);
  assert.deepEqual(feedNames(container), ['Bash', 'Grep', 'Read'], 'whole session: newest first, all turns');

  openStrip(container);
  clickBar(container, 0); // turn 1
  assert.deepEqual(feedNames(container), ['Grep', 'Read'], 'scoped to turn 1 — Bash (turn 2) is gone');

  clickBar(container, 1); // turn 2
  assert.deepEqual(feedNames(container), ['Bash'], 'scoped to turn 2');

  view.destroy();
  g.document = prevDoc;
});

test("feed: a turn with no tools reads empty, not the session's events", () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = snapWithTurns([makeTurn(1), makeTurn(2)]);
  const state = drivableState(snap);
  const view = createGraph(container, state);

  state.emit(toolStart('t1', 'Read', '2026-07-14T10:00:00Z'), 1);
  selectTurnViaStrip(container, 1); // turn 2 ran no tools
  assert.deepEqual(feedNames(container), [], 'no rows from turn 1 leak into turn 2');

  view.destroy();
  g.document = prevDoc;
});

// ---- API-call rows in the feed ----

const usageEvt = (callId: string | null, ts: string, agentId: string | null = null) => ({
  type: 'usage',
  callId,
  timestamp: ts,
  agentId,
  delta: { input: 1, output: 1, cacheRead: 1, cacheCreation: 1 },
  fill: 3,
});

test('feed: an API-call event is one "API call" row, before the tools it decided; the block repeat folds', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const state = drivableState(snapWithTurns([makeTurn(1)]));
  const view = createGraph(container, state);

  state.emitCtx(usageEvt('msg_1', '2026-07-14T10:00:00Z'), {
    turnIndex: 1,
    label: 'analyze this',
    newCall: true,
    callMs: 3200,
  });
  state.emitCtx(usageEvt('msg_1', '2026-07-14T10:00:00Z'), { turnIndex: 1, label: 'analyze this', newCall: false }); // same call, next block
  state.emit(toolStart('t1', 'Read', '2026-07-14T10:00:01Z'), 1);
  assert.deepEqual(
    feedNames(container),
    ['Read', 'API call'],
    'one call row (repeat folded), and the tool it decided sits above it',
  );

  const rows = findByClass(container, 'fev');
  const callRow = rows.find((r: any) => findByClass(r, 'fn')[0]?.textContent === 'API call');
  assert.ok(callRow.className.includes('api'), 'the call row carries the api class');
  assert.equal(findByClass(callRow, 'fa')[0]?.textContent, 'analyze this', 'and shows the input that triggered it');
  assert.equal(textOf(findByClass(callRow, 'ft')[0]).trim(), '3.2s', 'and its latency in the duration column');

  view.destroy();
  g.document = prevDoc;
});

test('feed: a subagent API call is tagged SUBAGENT, like its tools', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const state = drivableState(snapWithTurns([makeTurn(1)]));
  const view = createGraph(container, state);

  state.emitCtx(usageEvt('m_sub', '2026-07-14T10:00:00Z', 'ag1'), { turnIndex: 1, label: null, newCall: true });
  const callRow = findByClass(container, 'fev')[0];
  assert.ok(findByClass(callRow, 'fagent').length > 0, 'a subagent call row carries the SUBAGENT tag');

  view.destroy();
  g.document = prevDoc;
});

test('feed: clicking an API-call row opens the call drawer with its input', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const state = drivableState(snapWithTurns([makeTurn(1)]));
  const view = createGraph(container, state);

  state.emitCtx(usageEvt('msg_1', '2026-07-14T10:00:00Z'), { turnIndex: 1, label: 'analyze this', newCall: true });
  feedRow(container, 0).onclick();
  const d = drawerOf(container);
  assert.ok(d.open, 'the call row opens the drawer');
  assert.equal(d.type, 'API call');
  assert.equal(d.title, 'msg_1', 'titled by the call id');
  // Facts first, like a tool's drawer: the token tiles at the top (— with no loadCallIO
  // wired, since nothing can be fetched). Input is reframed as cached-context + new-this-call,
  // not the raw "N in"; the model rides in the identity line, filled when the fetch lands.
  assert.equal(d.kpi('Input'), '—', 'an Input tile leads the drawer');
  assert.equal(d.kpi('New this call'), '—', 'with the delta this call added');
  assert.equal(d.kpi('Output'), '—', 'and an Output tile');
  // Then the input (showing the row hint until a fetch lands) and output blocks — short labels
  // now, with the explanation in a subtitle rather than a two-line uppercase heading.
  const labels = findByClass(container, 'blabel').map((b: any) => b.textContent);
  assert.ok(labels.includes('Input'), 'the drawer shows the call input block');
  assert.ok(labels.includes('Output'), 'and the call output block');
  const drawerNode = findByClass(container, 'drawer')[0];
  assert.ok(
    textOf(drawerNode).includes('analyze this'),
    'the input shows the hint the row carried, until the full fetch lands',
  );

  view.destroy();
  g.document = prevDoc;
});

// ---- the feed rows open the drawer ----

// What the drawer is showing: its kind ('tool call' / 'subagent'), its title, its identity
// line, and its facts — which live in three places since the layout rework: KPI tiles for the
// headline numbers, a `Details` <dl> for demoted bookkeeping, and the surviving .drow rows.
// The fake DOM carries no tag names, so the <h3> title is found by position: inside .dhead it
// is appended right after the .deyebrow that holds the chip.
function drawerOf(container: any) {
  const d = findByClass(container, 'drawer')[0];
  const head = findByClass(d, 'dhead')[0];
  const eyebrow = findByClass(d, 'deyebrow')[0];
  const rows = findByClass(d, 'drow').map((r: any) => [
    findByClass(r, 'dk')[0]?.textContent,
    findByClass(r, 'dv')[0]?.textContent,
  ]);
  // A tile's value is a text node plus an optional <small> unit, so it must be read with
  // textOf — .textContent would see only whichever part is a leaf.
  const tiles = findByClass(d, 'kpi').map((t: any) => [
    findByClass(t, 'kl')[0]?.textContent,
    textOf(findByClass(t, 'kv')[0]),
  ]);
  // A <dl> renders as flat dt,dd,dt,dd children — pair them back up.
  const dl = findByClass(d, 'meta')[0];
  const meta: any[] = [];
  for (let i = 0; dl && i + 1 < dl.children.length; i += 2)
    meta.push([dl.children[i].textContent, dl.children[i + 1].textContent]);
  return {
    open: d.classList.contains('on'),
    type: findByClass(d, 'dchip')[0]?.textContent,
    title: head?.children[head.children.indexOf(eyebrow) + 1]?.textContent,
    sub: findByClass(d, 'dsub')[0] ? textOf(findByClass(d, 'dsub')[0]) : null,
    row: (k: string) => (rows.find((r: any) => r[0] === k) ?? [])[1],
    kpi: (k: string) => (tiles.find((t: any) => t[0] === k) ?? [])[1],
    meta: (k: string) => (meta.find((m: any) => m[0] === k) ?? [])[1],
    legend: findByClass(d, 'legend')[0] ? textOf(findByClass(d, 'legend')[0]) : null,
  };
}
const feedRow = (container: any, i: number) => findByClass(container, 'fev')[i];

// A snapshot whose tools carry their tool_use_id — the join the feed rows rely on.
function snapWithTools() {
  const snap = snapWithTurns([makeTurn(1)]);
  snap.mainTools = [{ id: 'toolu_1', name: 'Read', ms: 95, arg: 'src/app.ts', ctx: 4200, turnIndex: 1 }];
  snap.subagents = [
    {
      agentId: 'ag1',
      agentType: 'general-purpose',
      model: 'claude-sonnet-5',
      toolUseId: 'toolu_2',
      // title is what the reducer resolves from the spawn (description → prompt's first line
      // → type); here the spawn carries only a prompt, so it is that.
      title: 'search the repo',
      fill: 59700,
      window: 200000,
      pct: 30,
      estimated: false,
      state: 'running',
      startedAt: '2026-07-14T10:00:00Z',
      durationMs: null,
      prompt: 'search the repo',
      outLen: 0,
      turnIndex: 1,
      tools: [{ id: 'toolu_3', name: 'Grep', ms: 40, arg: 'needle', ctx: 900, turnIndex: null }],
    },
  ];
  return snap;
}

// A command launched in the background is the one thing running that NOTHING else on the cockpit
// says: its launch row closed in milliseconds, the turn it belonged to may be long over, and NOW is
// taken by whatever the session is doing since. Both surfaces are asserted together because they
// answer different questions — the chip says "still waiting on something" at a glance, the card
// says what.
test('a running background command is stated on the banner and in the live card', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = snapWithTools();
  snap.subagents = [];
  snap.mainTools = [
    { id: 'toolu_1', name: 'Read', ms: 95, arg: 'src/app.ts', ctx: 4200, turnIndex: 1 },
    {
      id: 'toolu_bg',
      name: 'Bash',
      ms: 74,
      arg: 'bun run dev --watch',
      ctx: 60,
      turnIndex: 1,
      background: true,
      startedTs: new Date(Date.now() - 4 * 60_000).toISOString(),
    },
  ];
  const state = drivableState(snap);
  const view = createGraph(container, state);
  state.emit({ type: 'tool-start', id: 'toolu_1', name: 'Read', arg: 'x', timestamp: 'T', agentId: null }, 1);

  const chip = findByClass(container, 'sbbg')[0];
  assert.ok(chip, 'the banner says nothing about a session still waiting on a command');
  assert.match(textOf(chip), /^1 background command · /, 'it names what it is and how long it has been');
  // The card is renamed only when it holds more than subagents — otherwise it would claim a
  // breadth it does not have.
  const card = findByClass(container, 'sublivecard')[0];
  assert.equal(textOf(findByClass(card, 'wtitle')[0]), 'Running · live');
  assert.match(textOf(findByClass(container, 'slcount')[0]), /0 subagents · 1 command running/);
  const row = findByClass(container, 'subrow')[0];
  assert.match(textOf(row), /bun run dev --watch/);
  assert.match(textOf(row), /still running/);
  // …and the placeholder that would contradict it is gone.
  assert.equal(findByClass(container, 'slempty').length, 0);

  view.destroy();
  g.document = prevDoc;
});

// A background command's age has to TICK, and the case that proves it is the one the feature exists
// for: the turn is over, the command is not, and nothing else is happening — so no event will
// re-render the cockpit and recompute the age. Caught in review: both counters were tagged
// `owner: 'now'`, which `dropNowCounters()` takes back — and it runs AFTER the banner and the card
// have pushed theirs, so they were killed inside the same render and the age froze. Invisible on a
// busy session, where every event repaints it, which is exactly why the live check missed it.
test('a running command’s age is driven by the shared ticker, not by the next event', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  const prevSetInterval = g.setInterval;
  const prevNow = Date.now;
  g.document = fakeDoc();
  const ticker: { fn: (() => void) | null } = { fn: null };
  g.setInterval = (fn: () => void) => {
    ticker.fn = fn;
    return 1 as any;
  };
  try {
    const container = g.document.createElement();
    const snap = snapWithTools();
    snap.subagents = [];
    snap.mainTools = [
      {
        id: 'toolu_bg',
        name: 'Bash',
        ms: 74,
        arg: 'bun run dev --watch',
        ctx: 60,
        turnIndex: 1,
        background: true,
        startedTs: new Date(Date.now() - 60_000).toISOString(),
      },
    ];
    const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });

    const chip = findByClass(container, 'sbbg')[0];
    const age = findByClass(findByClass(container, 'sublivecard')[1] ?? container, 'sel')[0];
    assert.match(textOf(chip), /1m$/, 'the age it opens with');
    assert.ok(ticker.fn, 'a running command must arm the ticker — with nothing else to repaint it');

    const t0 = Date.now();
    Date.now = () => t0 + 121_000; // two minutes later, and not one event in between
    ticker.fn!();

    assert.match(textOf(chip), /3m/, 'the chip moved on its own');
    if (age) assert.match(textOf(age), /3m/, 'and so did the row');

    view.destroy();
  } finally {
    g.document = prevDoc;
    g.setInterval = prevSetInterval;
    Date.now = prevNow;
  }
});

// The notification is what ends one. Until it lands the command is running; once it lands the row
// has an outcome and nothing on the cockpit may go on claiming it is still going.
test('a background command that reported its fate is no longer running', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = snapWithTools();
  snap.subagents = [];
  snap.mainTools = [
    {
      id: 'toolu_bg',
      name: 'Bash',
      ms: 74,
      arg: 'bun run dev --watch',
      ctx: 60,
      turnIndex: 1,
      background: true,
      startedTs: new Date(Date.now() - 4 * 60_000).toISOString(),
      outcome: 'Background command "dev" completed (exit code 0)',
      outcomeStatus: 'completed',
    },
  ];
  const state = drivableState(snap);
  const view = createGraph(container, state);
  state.emit({ type: 'tool-start', id: 'toolu_bg', name: 'Bash', arg: 'x', timestamp: 'T', agentId: null }, 1);

  assert.equal(findByClass(container, 'sbbg').length, 0);
  const card = findByClass(container, 'sublivecard')[0];
  assert.equal(textOf(findByClass(card, 'wtitle')[0]), 'Subagents · live', 'the card takes its own name back');

  view.destroy();
  g.document = prevDoc;
});

// --- the bottom catalogue: one card, two tabs -------------------------------------------------
// The rules the maintainer approved, pinned here because each of them is a product decision and not a
// detail: the tab bar exists only when both lists have something in them, the default never moves,
// and the closed tab states its failures. Drop the last one and this design hides exactly what it
// was built to reveal.

/** A background command node as the reducer projects one, with its fate already known. */
const bgTool = (id: string, label: string, status: string | null, sentence: string | null) => ({
  id,
  name: 'Bash',
  ms: 70,
  arg: 'bun run something',
  ctx: 0,
  turnIndex: 1,
  background: true as const,
  startedTs: '2026-07-14T10:00:00.000Z',
  description: label,
  ...(sentence ? { outcome: sentence, outcomeTs: '2026-07-14T10:10:00.000Z' } : {}),
  ...(status ? { outcomeStatus: status } : {}),
  ...(status && status !== 'completed' && status !== 'stopped' ? { error: true as const } : {}),
});

const bottomCard = (container: any) => findByClass(container, 'card').at(-1);

test('bottom card: with subagents AND commands it grows two tabs, opening on the subagents', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = snapWithTools();
  snap.mainTools = [
    ...snap.mainTools,
    bgTool('toolu_b1', 'Run the capture', 'failed', 'Background command "Run the capture" failed with exit code 144'),
    bgTool(
      'toolu_b2',
      'Build the bundle',
      'completed',
      'Background command "Build the bundle" completed (exit code 0)',
    ),
  ];
  const view = createGraph(container, drivableState(snap));

  const card = bottomCard(container);
  const tabs = findByClass(card, 'xbtn');
  assert.equal(tabs.length, 2, 'both lists have something, so the switch exists');
  assert.match(textOf(tabs[0]), /^Subagents 1/);
  assert.match(textOf(tabs[1]), /^Background commands 2/);
  // The whole safety of the design: the side you are not looking at says what is wrong on it.
  assert.match(textOf(tabs[1]), /1 failed/, 'the closed tab carries its failures');
  assert.equal(textOf(findByClass(card, 'wtitle')[0]), 'Subagents · in launch order', 'the default never moves');
  assert.equal(findByClass(card, 'subcard').length, 1, 'and it is the subagents that are drawn');
  assert.equal(findByClass(card, 'subrow').length, 0, 'no command row is built while its tab is closed');

  tabs[1].onclick();
  const after = bottomCard(container);
  assert.equal(textOf(findByClass(after, 'wtitle')[0]), 'Background commands · in launch order');
  assert.equal(findByClass(after, 'subrow').length, 2, 'both commands, the failed one included');
  assert.equal(findByClass(after, 'subcard').length, 0, 'and the subagents leave the card');
  assert.equal(findByClass(after, 'b-failed').length, 2, 'the row badge, and the badge on the tab');

  view.destroy();
  g.document = prevDoc;
});

test('bottom card: with only one of the two there is no tab bar', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();

  // Subagents only — the card is exactly what it has always been.
  const onlySubs = snapWithTools();
  const v1 = createGraph(container, drivableState(onlySubs));
  assert.equal(
    findByClass(bottomCard(container), 'xbtn').length,
    0,
    'a switch with an empty side is a control that does nothing',
  );
  assert.equal(textOf(findByClass(bottomCard(container), 'wtitle')[0]), 'Subagents · in launch order');
  v1.destroy();

  // Commands only — the card IS the commands, with no tab to press.
  const container2 = g.document.createElement();
  const onlyCmds = snapWithTools();
  onlyCmds.subagents = [];
  onlyCmds.mainTools = [bgTool('toolu_b1', 'Tail the transcript', null, null)];
  const v2 = createGraph(container2, drivableState(onlyCmds));
  const card = bottomCard(container2);
  assert.equal(findByClass(card, 'xbtn').length, 0);
  assert.equal(textOf(findByClass(card, 'wtitle')[0]), 'Background commands · in launch order');
  assert.equal(findByClass(card, 'subrow').length, 1);
  v2.destroy();

  g.document = prevDoc;
});

test('live card: a failed command is counted, never drawn — a LIVE card lists only live things', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = snapWithTools();
  snap.subagents = [];
  snap.mainTools = [
    bgTool('toolu_b1', 'Run the capture', 'failed', 'Background command "Run the capture" failed with exit code 144'),
  ];
  const view = createGraph(container, drivableState(snap));

  const card = findByClass(container, 'sublivecard')[0];
  // Rows were tried here and refused: on a session whose commands had all ended, the card read
  // "Background commands · live" over two corpses. Dead things do not belong under a LIVE heading.
  assert.equal(findByClass(card, 'subrow').length, 0, 'nothing is running, so nothing is drawn');
  assert.equal(textOf(findByClass(card, 'wtitle')[0]), 'Subagents · live', 'and the card is not renamed for them');
  // But it must not vanish in silence either — that was the original bug. The count points at the
  // catalogue, exactly as this card already does for a finished subagent.
  assert.match(textOf(findByClass(card, 'slcount')[0]), /1 command failed below/);
  assert.equal(findByClass(card, 'slempty').length, 1, 'the empty state is honest: nothing IS running');

  view.destroy();
  g.document = prevDoc;
});

test('feed: clicking a tool row opens that tool in the drawer, with the owner it really had', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const state = drivableState(snapWithTools());
  const view = createGraph(container, state);

  state.emit(
    {
      type: 'tool-start',
      id: 'toolu_1',
      name: 'Read',
      arg: 'src/app.ts',
      timestamp: '2026-07-14T10:00:00Z',
      agentId: null,
    },
    1,
  );
  state.emit(
    {
      type: 'tool-start',
      id: 'toolu_3',
      name: 'Grep',
      arg: 'needle',
      timestamp: '2026-07-14T10:00:01Z',
      agentId: 'ag1',
    },
    1,
  );

  feedRow(container, 1).onclick(); // rows are newest-first → [1] is the main Read
  let d = drawerOf(container);
  assert.ok(d.open, 'the drawer opens from the feed');
  assert.equal(d.type, 'tool call');
  assert.equal(d.title, 'Read');
  assert.ok(d.sub?.includes('main session'), 'the identity line names who ran it');
  assert.equal(d.kpi('Output size'), '4k chars', 'the output size comes from the snapshot — the feed item has none');

  findByClass(container, 'close')[0].onclick();
  feedRow(container, 0).onclick(); // the subagent's Grep
  d = drawerOf(container);
  assert.equal(d.title, 'Grep');
  assert.ok(d.sub?.includes('general-purpose'), 'a subagent tool names the subagent that ran it');

  view.destroy();
  g.document = prevDoc;
});

test('feed: clicking a spawn row opens the SUBAGENT it launched, not the bare Agent tool', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const state = drivableState(snapWithTools());
  const view = createGraph(container, state);

  state.emit(
    {
      type: 'tool-start',
      id: 'toolu_2',
      name: 'Agent',
      arg: null,
      subagentType: 'general-purpose',
      launchPrompt: 'search the repo',
      timestamp: '2026-07-14T10:00:02Z',
      agentId: null,
    },
    1,
  );

  feedRow(container, 0).onclick();
  const d = drawerOf(container);
  assert.equal(d.type, 'subagent', 'the spawn resolves to its agent — the richer drawer');
  // No `description` on this spawn, so the title falls to the prompt's first line; the
  // type is still there, now as a row rather than the heading.
  assert.equal(d.title, 'search the repo');
  assert.ok(d.sub?.includes('general-purpose'), 'the identity line names the agent type');
  assert.equal(d.kpi('Duration'), 'running…', 'a running subagent is not given a fake duration');

  view.destroy();
  g.document = prevDoc;
});

test('feed: a spawn whose subagent is not known yet falls back to its Agent tool', () => {
  // An async subagent writes no child jsonl and gets no `subagent-meta` until it reports —
  // so the snapshot has no AgentNode for it. The row must still open something true.
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = snapWithTools();
  snap.subagents = []; // meta not in yet
  snap.mainTools.push({ id: 'toolu_2', name: 'Agent', ms: null, arg: 'general-purpose', ctx: 0, turnIndex: 1 });
  const state = drivableState(snap);
  const view = createGraph(container, state);

  state.emit(
    {
      type: 'tool-start',
      id: 'toolu_2',
      name: 'Agent',
      arg: 'general-purpose',
      subagentType: 'general-purpose',
      timestamp: '2026-07-14T10:00:02Z',
      agentId: null,
    },
    1,
  );

  feedRow(container, 0).onclick();
  const d = drawerOf(container);
  assert.ok(d.open, 'the row still opens the drawer');
  assert.equal(d.type, 'tool call');
  assert.equal(d.title, 'Agent');
  assert.equal(d.kpi('Duration'), 'running…');

  view.destroy();
  g.document = prevDoc;
});

test('feed: the drawer reads a FRESH snapshot — a tool that ended after the paint shows its real numbers', () => {
  // The bug this forbids: copying duration/output into the feed item at render time. The row
  // is drawn while the tool runs; by the time it is clicked the tool has ended, and a copy
  // would still say "running…" forever.
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = snapWithTools();
  snap.mainTools = [{ id: 'toolu_1', name: 'Bash', ms: null, arg: 'bun test', ctx: 0, turnIndex: 1 }]; // still running
  snap.subagents = [];
  const state = drivableState(snap);
  const view = createGraph(container, state);

  state.emit(
    {
      type: 'tool-start',
      id: 'toolu_1',
      name: 'Bash',
      arg: 'bun test',
      timestamp: '2026-07-14T10:00:00Z',
      agentId: null,
    },
    1,
  );
  assert.equal(
    findByClass(feedRow(container, 0), 'ft')[0].children[0]?.textContent,
    'running…',
    'the row is drawn while the tool is still running',
  );

  snap.mainTools[0].ms = 5300;
  snap.mainTools[0].ctx = 12000; // the tool ends, no repaint
  feedRow(container, 0).onclick();
  const d = drawerOf(container);
  assert.equal(d.kpi('Duration'), '5.3s', 'the drawer shows the tool as it is NOW, not as the row was drawn');
  assert.equal(d.kpi('Output size'), '12k chars');

  view.destroy();
  g.document = prevDoc;
});

// ---- the tool drawer shows what the tool RETURNED (fetched on click, never held) ----

// The <pre> blocks in the drawer, in order: 'Operated on', then the output (once it lands).
const drawerPres = (container: any) =>
  findAll(
    findByClass(container, 'drawer')[0],
    (n: any) => n.children?.length === 0 && typeof n.textContent === 'string' && n.textContent !== '' && !n.className,
  );

test('tool drawer: the output is fetched on click and shown truncated, "show full" opens it verbatim', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = snapWithTools();
  const long = 'L'.repeat(900);
  const asked: string[] = [];
  let resolve: (v: any) => void = () => {};
  const loadToolOutput = (id: string) => {
    asked.push(id);
    return new Promise<ToolOutputResult | null>((r) => {
      resolve = r;
    });
  };
  const state = drivableState(snap);
  const view = createGraph(container, state, { loadToolOutput });

  state.emit(
    {
      type: 'tool-start',
      id: 'toolu_1',
      name: 'Read',
      arg: 'src/app.ts',
      timestamp: '2026-07-14T10:00:00Z',
      agentId: null,
    },
    1,
  );
  feedRow(container, 0).onclick();
  assert.deepEqual(asked, ['toolu_1'], 'the drawer asks the server for THAT tool only');
  assert.ok(
    drawerPres(container).some((p: any) => p.textContent === 'loading…'),
    'a placeholder while it loads',
  );

  resolve({ toolUseId: 'toolu_1', text: long, len: 900, truncated: false });
  return Promise.resolve().then(() => {
    const shown = drawerPres(container).find((p: any) => p.textContent.startsWith('L'))!;
    assert.ok(shown.textContent.length < long.length, 'the drawer shows a truncated preview');

    findByClass(container, 'morebtn')[0].onclick();
    assert.ok(findByClass(container, 'omodal')[0].classList.contains('on'), 'the modal opened');
    // Raw output is NOT markdown: it must reach the modal verbatim, in one <pre>.
    const obody = findByClass(container, 'obody')[0];
    assert.equal(obody.children.length, 1);
    assert.equal(obody.children[0].className, 'opre');
    assert.equal(obody.children[0].textContent, long);

    view.destroy();
    g.document = prevDoc;
  });
});

// A published page is the one thing a session produces that does not live on this machine, and its
// address is stated once, inside the result text. The block is what makes it clickable instead of
// something to read off and retype — and it is claimed only for the tool that actually published.
// The drawer is where you go to learn WHY a row failed, and for a background command it was the
// one place that could not say: the chip read FAILED while the only text under it was the launch
// receipt — «Command running in background… you will be notified» — which is the opposite claim.
// The exit code exists nowhere else in the logs, so it has to be here.
test('tool drawer: a background command states its fate, and its ms is called a launch', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = snapWithTools();
  snap.subagents = [];
  snap.mainTools = [
    {
      id: 'toolu_1',
      name: 'Bash',
      ms: 99,
      arg: 'sleep 8; exit 7',
      ctx: 298,
      turnIndex: 1,
      background: true,
      error: true,
      outcome: 'Background command "Deliberate failure" failed with exit code 7',
      outcomeStatus: 'failed',
    },
  ];
  const state = drivableState(snap);
  const view = createGraph(container, state);
  state.emit(
    { type: 'tool-start', id: 'toolu_1', name: 'Bash', arg: 'sleep 8; exit 7', timestamp: 'T', agentId: null },
    1,
  );
  feedRow(container, 0).onclick();

  const chips = findByClass(container, 'dchip').map((c: any) => c.textContent);
  assert.deepEqual(chips, ['tool call', 'failed', 'background']);
  // 99ms is what the LAUNCH took; the command it started ran eight seconds and died.
  assert.equal(drawerOf(container).kpi('Launch'), '99ms');
  // The fate comes FIRST, above the command: it is the news, and the receipt below it is not.
  const labels = findByClass(container, 'blabel').map((n: any) => n.textContent);
  // `Output file` follows the fate: it is where the command's output went, and this node carries
  // none — the block says so rather than being absent, since "not reported yet" IS the state of a
  // command whose notification named no file.
  assert.deepEqual(labels, ['Outcome', 'Output file', 'Operated on']); // no output block: this view has no loader
  // Claude Code's words, in the order every other surface uses — fate first.
  assert.match(textOf(findByClass(container, 'block')[0]), /failed with exit code 7 · Background command/);

  view.destroy();
  g.document = prevDoc;
});

// Until the notification lands the command is genuinely still running — 6 of 120 real launches
// never got one. Saying nothing there would leave the same silence the receipt used to fill.
test('tool drawer: a background command with no outcome yet says it is still running', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = snapWithTools();
  snap.subagents = [];
  snap.mainTools = [
    { id: 'toolu_1', name: 'Bash', ms: 74, arg: 'bun run dev --watch', ctx: 60, turnIndex: 1, background: true },
  ];
  const state = drivableState(snap);
  const view = createGraph(container, state);
  state.emit(
    { type: 'tool-start', id: 'toolu_1', name: 'Bash', arg: 'bun run dev --watch', timestamp: 'T', agentId: null },
    1,
  );
  feedRow(container, 0).onclick();

  assert.match(textOf(findByClass(container, 'block')[0]), /still running/);
  assert.equal(
    findByClass(container, 'dchip')
      .map((c: any) => c.textContent)
      .includes('failed'),
    false,
  );

  view.destroy();
  g.document = prevDoc;
});

test('tool drawer: an Artifact publish links the page it put online', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = snapWithTools();
  snap.mainTools = [
    { id: 'toolu_1', name: 'Artifact', ms: 2400, arg: '~scratch/x/report.html', ctx: 116, turnIndex: 1 },
  ];
  snap.subagents = [];
  let resolve: (v: any) => void = () => {};
  const state = drivableState(snap);
  const view = createGraph(container, state, {
    loadToolOutput: () =>
      new Promise<ToolOutputResult | null>((r) => {
        resolve = r;
      }),
  });

  state.emit(
    {
      type: 'tool-start',
      id: 'toolu_1',
      name: 'Artifact',
      arg: '~scratch/x/report.html',
      timestamp: 'T',
      agentId: null,
    },
    1,
  );
  feedRow(container, 0).onclick();
  assert.equal(findByClass(container, 'dlink').length, 0, 'nothing is claimed before the output lands');

  const url = 'https://claude.ai/code/artifact/b830fa94-60be-4c86-9faa-af976df638a8';
  resolve({ toolUseId: 'toolu_1', text: `Published ~scratch/x/report.html at ${url}`, len: 116, truncated: false });
  return Promise.resolve().then(() => {
    const link = findByClass(container, 'dlink')[0];
    assert.equal(link.tag, 'a', 'a real anchor, not text styled to look like one');
    assert.equal(link.href, url);
    assert.equal(link.textContent, url);
    // Above the output it was read from: the block states the fact, the output stays the evidence.
    const labels = findByClass(container, 'blabel').map((n: any) => n.textContent);
    assert.deepEqual(labels, ['Operated on', 'Published at', 'Output returned (116 chars)']);

    view.destroy();
    g.document = prevDoc;
  });
});

// The block claims a publish. Two calls must NOT get one: the `action: "list"` form, which returns
// no URL, and any other tool whose output happens to quote an artifact link (a `cat` of a log).
test('tool drawer: nothing is called published unless an Artifact call says so', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  const url = 'https://claude.ai/code/artifact/b830fa94-60be-4c86-9faa-af976df638a8';

  const run = (name: string, text: string) => {
    g.document = fakeDoc();
    const container = g.document.createElement();
    const snap = snapWithTools();
    snap.mainTools = [{ id: 'toolu_1', name, ms: 90, arg: 'x', ctx: 60, turnIndex: 1 }];
    snap.subagents = [];
    let resolve: (v: any) => void = () => {};
    const state = drivableState(snap);
    const view = createGraph(container, state, {
      loadToolOutput: () =>
        new Promise<ToolOutputResult | null>((r) => {
          resolve = r;
        }),
    });
    state.emit({ type: 'tool-start', id: 'toolu_1', name, arg: 'x', timestamp: 'T', agentId: null }, 1);
    feedRow(container, 0).onclick();
    resolve({ toolUseId: 'toolu_1', text, len: text.length, truncated: false });
    return Promise.resolve().then(() => {
      const n = findByClass(container, 'dlink').length;
      view.destroy();
      return n;
    });
  };

  return run('Artifact', '{"artifacts":[{"title":"A report"}],"truncated":false}')
    .then((n) => assert.equal(n, 0, 'a list returns no URL, so there is nothing to link'))
    .then(() => run('Bash', `grep found: ${url}`))
    .then((n) => assert.equal(n, 0, 'another tool quoting the link did not publish it'))
    .then(() => {
      g.document = prevDoc;
    });
});

test('tool drawer: a slow fetch never paints into the drawer that replaced it', () => {
  // Click tool A, then B before A's response lands. Without a generation guard, A's output
  // would appear under B's title — the drawer would be describing two different tools at once.
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = snapWithTools();
  snap.mainTools.push({ id: 'toolu_4', name: 'Bash', ms: 20, arg: 'bun test', ctx: 700, turnIndex: 1 });
  const pending = new Map<string, (v: any) => void>();
  const loadToolOutput = (id: string) => new Promise<ToolOutputResult | null>((r) => pending.set(id, r));
  const state = drivableState(snap);
  const view = createGraph(container, state, { loadToolOutput });

  state.emit(
    {
      type: 'tool-start',
      id: 'toolu_1',
      name: 'Read',
      arg: 'src/app.ts',
      timestamp: '2026-07-14T10:00:00Z',
      agentId: null,
    },
    1,
  );
  state.emit(
    {
      type: 'tool-start',
      id: 'toolu_4',
      name: 'Bash',
      arg: 'bun test',
      timestamp: '2026-07-14T10:00:01Z',
      agentId: null,
    },
    1,
  );

  feedRow(container, 1).onclick(); // Read (older row)
  feedRow(container, 0).onclick(); // Bash — the drawer now shows this one
  pending.get('toolu_1')!({ toolUseId: 'toolu_1', text: 'READ OUTPUT', len: 11, truncated: false });
  pending.get('toolu_4')!({ toolUseId: 'toolu_4', text: 'BASH OUTPUT', len: 11, truncated: false });

  return Promise.resolve()
    .then(() => Promise.resolve())
    .then(() => {
      const texts = drawerPres(container).map((p: any) => p.textContent);
      assert.equal(drawerOf(container).title, 'Bash');
      assert.ok(
        texts.some((t: string) => t.startsWith('BASH OUTPUT')),
        'the open tool got its own output',
      );
      assert.ok(!texts.some((t: string) => t.startsWith('READ OUTPUT')), 'the abandoned fetch painted nothing');

      view.destroy();
      g.document = prevDoc;
    });
});

test('tool drawer: a tool that returned nothing asks for no output, and a failed fetch says so', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = snapWithTools();
  snap.mainTools = [{ id: 'toolu_1', name: 'Bash', ms: 5, arg: 'true', ctx: 0, turnIndex: 1 }]; // no output at all
  snap.subagents = [];
  const asked: string[] = [];
  const state = drivableState(snap);
  const view = createGraph(container, state, {
    loadToolOutput: (id: string) => {
      asked.push(id);
      return Promise.resolve(null);
    },
  });

  state.emit(
    { type: 'tool-start', id: 'toolu_1', name: 'Bash', arg: 'true', timestamp: '2026-07-14T10:00:00Z', agentId: null },
    1,
  );
  feedRow(container, 0).onclick();
  assert.deepEqual(asked, [], 'a tool with a zero-length result is not worth a round trip');

  // now a tool whose output the file no longer has: the fetch resolves null
  snap.mainTools[0].ctx = 500;
  feedRow(container, 0).onclick();
  assert.deepEqual(asked, ['toolu_1']);
  return Promise.resolve().then(() => {
    assert.ok(
      drawerPres(container).some((p: any) => p.textContent === 'output not available'),
      'an unavailable output says so — it does not sit on "loading…" forever',
    );
    view.destroy();
    g.document = prevDoc;
  });
});

// ---- Input button: the full prompt, when the banner truncates it ----

test('scope banner: the Prompt button appears only once the prompt overflows, and opens it in full', () => {
  const g = globalThis as any;
  const prevDoc = g.document,
    prevRO = g.ResizeObserver;
  g.document = fakeDoc();
  // Stand-in for the browser's ResizeObserver: capture the callback so the test can
  // re-run the measurement after giving the prompt node a size, exactly as a real
  // layout (or a tab becoming visible) would.
  let roCb: any = null;
  g.ResizeObserver = class {
    constructor(cb: any) {
      roCb = cb;
    }
    observe() {}
    disconnect() {}
  };

  const container = g.document.createElement();
  const snap = snapWithTurns([makeTurn(1)]);
  const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });

  selectTurnViaStrip(container, 0);
  const banner = findByClass(container, 'scope-banner')[0];
  const inBtn = bannerBtn(banner, 'Prompt');
  assert.ok(inBtn, 'Prompt button exists in the DOM');
  assert.ok(inBtn.classList.contains('hidden'), 'hidden while the prompt fits (nothing to reveal)');

  // the prompt no longer fits the one-line banner → the button must appear
  const promptEl = findByClass(banner, 'sbprompt')[0];
  promptEl.scrollWidth = 900;
  promptEl.clientWidth = 300;
  roCb();
  assert.equal(inBtn.classList.contains('hidden'), false, 'revealed once the prompt is truncated');

  inBtn.onclick({ stopPropagation: () => {} });
  const omodal = findByClass(container, 'omodal')[0];
  assert.ok(omodal.classList.contains('on'), 'modal opened');
  assert.equal(textOf(findByClass(container, 'obody')[0]), 'Turn 1 prompt', 'modal shows the full prompt');

  view.destroy();
  g.document = prevDoc;
  g.ResizeObserver = prevRO;
});

test('scope banner: a prompt shortened by the DATA shows Prompt immediately (no layout needed)', () => {
  // The miss this guards: the button was revealed only by a CSS-overflow measurement, but a
  // multi-line prompt is collapsed to one line BEFORE it reaches the DOM — nothing overflows,
  // so the button never appeared even though most of the prompt was unreadable.
  const g = globalThis as any;
  const prevDoc = g.document,
    prevRO = g.ResizeObserver;
  g.document = fakeDoc();
  g.ResizeObserver = undefined; // no layout engine at all — the data alone must decide
  const container = g.document.createElement();
  const snap = snapWithTurns([makeTurn(1)]);
  snap.turnList[0].prompt = 'first line of the prompt\nsecond line the banner cannot show';
  const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });

  selectTurnViaStrip(container, 0);
  const banner = findByClass(container, 'scope-banner')[0];
  const inBtn = bannerBtn(banner, 'Prompt');
  assert.ok(inBtn, 'Prompt button rendered');
  assert.equal(inBtn.classList.contains('hidden'), false, 'visible: the prompt has more than the banner shows');
  assert.equal(
    findByClass(banner, 'sbprompt')[0].textContent,
    'first line of the prompt second line the banner cannot show'.slice(0, 200),
    'the banner shows the one-line summary',
  );

  inBtn.onclick({ stopPropagation: () => {} });
  assert.equal(
    textOf(findByClass(container, 'obody')[0]),
    'first line of the prompt\nsecond line the banner cannot show',
    'the modal has the prompt in full',
  );

  view.destroy();
  g.document = prevDoc;
  g.ResizeObserver = prevRO;
});

test('"Whole session" drops the scope AND closes the turn strip (like Close)', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = snapWithTurns([makeTurn(1), makeTurn(2)]);
  const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });

  selectTurnViaStrip(container, 0);
  assert.equal(findByClass(container, 'tstrip').length, 1, 'strip open while exploring');

  // the banner's button
  findByClass(findByClass(container, 'scope-banner')[0], 'xbtn')[0].onclick({ stopPropagation: () => {} });
  assert.equal(
    findByClass(container, 'scope-banner')[0] &&
      findByClass(findByClass(container, 'scope-banner')[0], 'sbprompt')[0].textContent,
    'Whole session',
  );
  assert.equal(findByClass(container, 'tstrip').length, 0, 'strip closed too');

  // the strip's own legend button does the same
  selectTurnViaStrip(container, 1);
  assert.equal(findByClass(container, 'tstrip').length, 1);
  const legendBtn = findByClass(findByClass(container, 'tstrip')[0], 'xbtn')[0];
  legendBtn.onclick();
  assert.equal(findByClass(container, 'tstrip').length, 0, 'legend "Whole session" closes the strip as well');

  view.destroy();
  g.document = prevDoc;
});

// ---- the timeline shows everything the user sent, coloured by what it turned out to be ----

test('timeline: a zero-cost entry still gets a visible bar, coloured by kind', () => {
  // /clear and /model move the context by nothing, so their bar has zero height — without a
  // stub they would be invisible AND unclickable, i.e. silently dropped from the timeline.
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = snapWithTurns([
    makeTurn(1, { kind: 'context', command: 'clear', deltaFill: 0 }),
    makeTurn(2, { kind: 'local', command: 'model', deltaFill: 0 }),
    makeTurn(3, { kind: 'work', deltaFill: 40000, state: 'live' }),
  ]);
  const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });

  openStrip(container);
  const bars = findByClass(container, 'sb');
  const inner = (bar: any) => findByClass(bar, 'up')[0].children[0];
  assert.ok(inner(bars[0]), '/clear has a bar');
  assert.equal(inner(bars[0]).className, 'cmp', 'context event → the compaction colour');
  assert.equal(inner(bars[1]).className, 'loc', 'local command → the neutral colour');
  assert.equal(inner(bars[2]).className, 'lv', 'a work turn burning tokens → live');

  view.destroy();
  g.document = prevDoc;
});

test('timeline: the banner does not call "Turn N" something that is not a turn', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = snapWithTurns([
    makeTurn(1, { kind: 'context', command: 'clear', deltaFill: 0 }),
    makeTurn(2, { kind: 'work' }),
  ]);
  snap.turns = 1; // only entry #2 is a round of work
  const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });

  selectTurnViaStrip(container, 0); // the /clear entry
  let banner = findByClass(container, 'scope-banner')[0];
  assert.equal(findByClass(banner, 'sbnum')[0].textContent, 'Context event');

  clickBar(container, 1); // the work turn
  banner = findByClass(container, 'scope-banner')[0];
  assert.equal(
    findByClass(banner, 'sbnum')[0].textContent,
    'Turn 1 / 1',
    'the ordinal counts work turns, not entries — never "Turn 2 / 1"',
  );

  view.destroy();
  g.document = prevDoc;
});

test('timeline: the feed and the banner name the same entry the same way', () => {
  // They disagreed: the banner read "Local command /model opus" while the feed above it
  // read "Turn 2 activity" — two labels for one selection.
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = snapWithTurns([
    makeTurn(1, { kind: 'local', command: 'model', deltaFill: 0 }),
    makeTurn(2, { kind: 'work' }),
  ]);
  snap.turns = 1;
  const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });

  selectTurnViaStrip(container, 0); // the /model entry
  assert.equal(
    findByClass(container, 'wtitle').find((t: any) => t.textContent.endsWith('activity'))?.textContent,
    '/model activity',
    'the feed names it by its command, not "Turn N"',
  );

  clickBar(container, 1); // the work turn
  assert.equal(
    findByClass(container, 'wtitle').find((t: any) => t.textContent.endsWith('activity'))?.textContent,
    'Turn 1 activity',
    'and a work turn by its ordinal among work turns',
  );

  view.destroy();
  g.document = prevDoc;
});

test('token usage widget: no API call in scope reads "—", not a bare 0', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = snapWithTurns([makeTurn(1, { kind: 'local', command: 'model', deltaFill: 0 })]);
  // A /model entry that called the model zero times has no tokens to report.
  snap.turnList[0].breakdown = { input: 0, cacheRead: 0, cacheCreation: 0 };
  snap.turnList[0].cacheTotals = { read: 0, created: 0 };
  snap.turnList[0].inputTotal = 0;
  snap.turnList[0].out = 0;
  snap.turnList[0].apiCalls = 0;
  const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });

  selectTurnViaStrip(container, 0);
  const num = findByClass(container, 'num')[0];
  assert.equal(num.textContent, '—', 'nothing was measured — do not report it as 0 tokens');

  view.destroy();
  g.document = prevDoc;
});

// ---- toasts ----

const rails = (container: any) => {
  const all = findByClass(container, 'toasts');
  return {
    tools: all.find((r: any) => r.className === 'toasts'),
    subs: all.find((r: any) => r.className === 'toasts bottom'),
  };
};
// each toast's headline (.tname): the tool name, or the subagent type
const toastNames = (rail: any) => rail.children.map((t: any) => findByClass(t, 'tname')[0]?.textContent);

test('toasts: a full rail evicts the OLDEST toast and keeps the newest', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const state = drivableState(baseSnapshot());
  const view = createGraph(container, state);
  view.goLive(); // replay is over — live toasts may fire

  for (const name of ['Read', 'Bash', 'Grep', 'Edit', 'Write', 'Glob']) {
    state.emit({ type: 'tool-start', id: name, name, arg: null, timestamp: '2026-07-14T10:00:00Z', agentId: null });
  }
  const rail = rails(container).tools;
  assert.equal(rail.children.length, 5, 'rail capped at 5');
  assert.deepEqual(
    toastNames(rail),
    ['Bash', 'Grep', 'Edit', 'Write', 'Glob'],
    'oldest (Read) evicted, newest (Glob) kept',
  );

  view.destroy();
  g.document = prevDoc;
});

test('toasts: eviction terminates when the oldest toast is mid-fade (no main-thread freeze)', () => {
  // The regression: a toast that has begun fading out is still a child for 320ms. Eviction
  // used to bail out on it without removing it, so the loop spun forever and froze the tab.
  // If this ever comes back, this test HANGS rather than failing — which is the honest signal.
  const g = globalThis as any;
  const prevDoc = g.document,
    prevSetTimeout = g.setTimeout;
  g.document = fakeDoc();
  const scheduled: Array<() => void> = [];
  g.setTimeout = ((fn: () => void) => {
    scheduled.push(fn);
    return scheduled.length;
  }) as any;

  const container = g.document.createElement();
  const state = drivableState(baseSnapshot());
  const view = createGraph(container, state);
  view.goLive();

  for (const name of ['Read', 'Bash', 'Grep', 'Edit', 'Write']) {
    state.emit({ type: 'tool-start', id: name, name, arg: null, timestamp: '2026-07-14T10:00:00Z', agentId: null });
  }
  const rail = rails(container).tools;
  assert.equal(rail.children.length, 5);

  scheduled[0]!(); // the oldest toast's auto-dismiss fires: it starts fading, still in the DOM
  assert.equal(rail.children.length, 5, 'a fading toast is still a child');

  state.emit({
    type: 'tool-start',
    id: 'x',
    name: 'Glob',
    arg: null,
    timestamp: '2026-07-14T10:00:00Z',
    agentId: null,
  });
  assert.equal(rail.children.length, 5, 'the fading toast was force-evicted, not skipped');
  assert.deepEqual(toastNames(rail), ['Bash', 'Grep', 'Edit', 'Write', 'Glob']);

  view.destroy();
  g.document = prevDoc;
  g.setTimeout = prevSetTimeout;
});

test('toasts: past 5 concurrent spawns the NEWEST subagent toast still appears', () => {
  // The regression: the bottom rail evicted lastChild — the toast just appended — because
  // `row-reverse` was mistaken for DOM order. A 6+ agent fan-out then showed no toast at all.
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = snapWithTurns([makeTurn(1), makeTurn(2)]);
  snap.subagents = Array.from({ length: 6 }, (_, i) => ({
    agentId: 'ag' + i,
    agentType: 'agent-' + i,
    model: 'claude-haiku-4-5',
    prompt: 'do ' + i,
    fill: 10,
    window: 100,
    pct: 10,
    estimated: false,
    state: 'running',
    startedAt: null,
    durationMs: null,
    tools: [],
    turnIndex: 2,
  }));
  const state = drivableState(snap);
  const view = createGraph(container, state);
  view.goLive();

  for (let i = 0; i < 6; i++) {
    state.emit({
      type: 'subagent-meta',
      agentId: 'ag' + i,
      agentType: 'agent-' + i,
      model: null,
      toolUseId: 't' + i,
      timestamp: '',
      seq: -1,
    });
  }
  // Scope to turn 1, which contains NONE of these subagents: a queued toast must still
  // resolve — it belongs to the subagent that spawned it, not to the turn being viewed.
  selectTurnViaStrip(container, 0);
  state.change(); // reducer folded something → render() drains the queue

  const rail = rails(container).subs;
  assert.equal(rail.children.length, 5, 'bottom rail capped at 5');
  assert.deepEqual(
    toastNames(rail),
    ['agent-1', 'agent-2', 'agent-3', 'agent-4', 'agent-5'],
    'the oldest spawn was evicted and the newest (agent-5) is present',
  );

  view.destroy();
  g.document = prevDoc;
});

// A subagent toast's model line (.tmodel) — ' ' while the model is still unknown.
const toastModels = (rail: any) => rail.children.map((t: any) => findByClass(t, 'tmodel')[0]?.textContent);
// One running subagent, model optionally unknown — the shape a spawn has at birth.
const runningAgent = (agentId: string, model: string | null) => ({
  agentId,
  agentType: 'general-purpose',
  title: 'do the thing',
  model,
  prompt: 'do the thing',
  fill: 10,
  window: 100,
  pct: 10,
  estimated: false,
  state: 'running',
  startedAt: null,
  durationMs: null,
  tools: [],
  turnIndex: null,
});

test('toasts: a spawn names the model it runs on, when the model is known at birth', () => {
  // 69.9% of spawns declare `model:` in the Agent input, and whether its `tool-start` beats
  // the meta event that fires the toast is a race: measured on the real SSE stream, 2 of 6
  // spawns had the tool-start arrive first (0-1ms), the other 4 had it 0.6-2.7s LATER. When
  // it wins, the model IS in the reducer but NOT yet in the last painted snapshot — the spawn
  // is what is being announced. Reading only the painted one blanked a model already known.
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const state = drivableState(baseSnapshot());
  const view = createGraph(container, state);
  view.goLive(); // paints: the last snapshot has NO subagents

  const withSpawn = baseSnapshot() as any;
  withSpawn.subagents = [runningAgent('ag1', 'claude-haiku-4-5-20251001')];
  state.setSnapshot(withSpawn); // the reducer folded the spawn; no paint has happened since
  state.emit({
    type: 'subagent-meta',
    agentId: 'ag1',
    agentType: 'general-purpose',
    model: null,
    toolUseId: 't1',
    timestamp: '',
    seq: -1,
  });
  assert.deepEqual(toastModels(rails(container).subs), ['haiku'], 'the toast names the model at birth');

  view.destroy();
  g.document = prevDoc;
});

test('toasts: a model that lands after the spawn fills the toast already on screen', async () => {
  // The other 30.1%: the spawn declares no model, so it is knowable only from the child's
  // first assistant line — p50 3.2s after the spawn, inside the toast's 5s life. Deferring
  // the toast until then was tried and removed (it cost latency); the toast fills instead.
  // This is the fable case that prompted it: 28 of 28 fable subagents were spawned with
  // no declared model, so at birth seedeep cannot know what they run on.
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = baseSnapshot() as any;
  snap.subagents = [runningAgent('ag1', null)];
  const state = drivableState(snap);
  const view = createGraph(container, state);
  view.goLive();

  state.emit({
    type: 'subagent-meta',
    agentId: 'ag1',
    agentType: 'general-purpose',
    model: null,
    toolUseId: 't1',
    timestamp: '',
    seq: -1,
  });
  const rail = rails(container).subs;
  assert.equal(rail.children.length, 1, 'the toast fires immediately, model or not');
  assert.deepEqual(toastModels(rail), [' '], 'no model to name yet — the line is reserved, not filled');

  // The child wrote its first line: the reducer folds the model in and re-renders. The paint
  // is coalesced through a 0ms timer (see scheduleRender), so the fill lands on the next tick.
  snap.subagents = [runningAgent('ag1', 'claude-fable-5')];
  state.change();
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(toastModels(rail), ['claude-fable-5'], 'the live toast now names the model');

  view.destroy();
  g.document = prevDoc;
});

test('toasts: a dismissed toast is dropped, so a late model cannot touch a removed node', () => {
  const g = globalThis as any;
  const prevDoc = g.document,
    prevSetTimeout = g.setTimeout;
  g.document = fakeDoc();
  const scheduled: Array<() => void> = [];
  g.setTimeout = ((fn: () => void) => {
    scheduled.push(fn);
    return scheduled.length;
  }) as any;

  const container = g.document.createElement();
  const snap = baseSnapshot() as any;
  snap.subagents = [runningAgent('ag1', null)];
  const state = drivableState(snap);
  const view = createGraph(container, state);
  view.goLive();

  state.emit({
    type: 'subagent-meta',
    agentId: 'ag1',
    agentType: 'general-purpose',
    model: null,
    toolUseId: 't1',
    timestamp: '',
    seq: -1,
  });
  const rail = rails(container).subs;
  const toast = rail.children[0];
  // Drain by index, not forEach: the fade schedules its own removal timer mid-drain.
  for (let i = 0; i < scheduled.length; i++) scheduled[i]!();

  assert.equal(rail.children.length, 0, 'the toast is gone');
  snap.subagents = [runningAgent('ag1', 'claude-fable-5')];
  state.change();
  for (let i = 0; i < scheduled.length; i++) scheduled[i]!(); // the coalesced render runs
  assert.deepEqual(toastModels(rail), [], 'nothing on screen to fill');
  assert.equal(findByClass(toast, 'tmodel')[0]?.textContent, ' ', 'the detached node was left alone');

  view.destroy();
  g.document = prevDoc;
  g.setTimeout = prevSetTimeout;
});

test('toasts: nothing fires during replay (before goLive)', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const state = drivableState(baseSnapshot());
  const view = createGraph(container, state); // NOT armed — this is the replay flood

  state.emit({
    type: 'tool-start',
    id: 'a',
    name: 'Read',
    arg: null,
    timestamp: '2026-07-14T10:00:00Z',
    agentId: null,
  });
  assert.equal(rails(container).tools.children.length, 0, 'replayed history must not toast');

  view.destroy();
  g.document = prevDoc;
});

// ---- Live subagent monitor: only running subagents; finished live in the bottom catalog ----

test('subagent monitor: shows only running subagents, finished only in the catalog', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = baseSnapshot();
  snap.subagents = [
    {
      agentId: 'run1',
      agentType: 'code-reviewer',
      model: 'claude-sonnet-5',
      fill: 42000,
      window: 200000,
      pct: 21,
      estimated: false,
      state: 'running',
      startedAt: null,
      durationMs: null,
      outLen: 0,
      tools: [{ name: 'Read', ms: 1, arg: 'session-tree.ts' }],
    },
    {
      agentId: 'd1',
      agentType: 'test-runner',
      model: 'claude-haiku-4-5',
      fill: 15000,
      window: 200000,
      pct: 8,
      estimated: false,
      state: 'done',
      startedAt: null,
      durationMs: 2000,
      outLen: 170,
      tools: [{ name: 'Bash', ms: 1 }],
    },
    {
      agentId: 'd2',
      agentType: 'test-runner',
      model: 'claude-haiku-4-5',
      fill: 15000,
      window: 200000,
      pct: 8,
      estimated: false,
      state: 'done',
      startedAt: null,
      durationMs: 3000,
      outLen: 46,
      tools: [{ name: 'Bash', ms: 1 }],
    },
  ];
  const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });

  // the live monitor shows ONLY the running subagent — no finished rows (they'd duplicate the catalog).
  assert.equal(findByClass(container, 'subrow').length, 1, 'only the running subagent in the live monitor');
  assert.equal(findByClass(container, 'act').length, 1, 'and it renders as the active row');
  // all three still render as full cards in the bottom catalog.
  assert.equal(findByClass(container, 'subcard').length, 3, 'every subagent is in the bottom catalog');
  // the count line points to the catalog for the finished ones.
  const count = findByClass(container, 'slcount')[0].textContent;
  assert.ok(
    count.includes('1 running') && count.includes('2 finished'),
    `count summarises running + finished-below (got "${count}")`,
  );
  // the active row renders its live content: context %, current action, and a running elapsed.
  assert.match(findByClass(container, 'scnum')[0].textContent, /21%/, 'live context fill % shown');
  assert.equal(findByClass(container, 'sact')[0].textContent, '→ Read session-tree.ts', 'current action shown');
  assert.match(
    findByClass(container, 'sel')[0].textContent,
    /running/,
    'running placeholder (data-driven, not wall-clock)',
  );

  view.destroy();
  g.document = prevDoc;
});

test('subagent monitor: centred placeholder when nothing is running', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = baseSnapshot();
  snap.subagents = [
    {
      agentId: 'd1',
      agentType: 'test-runner',
      model: 'claude-haiku-4-5',
      fill: 15000,
      window: 200000,
      pct: 8,
      estimated: false,
      state: 'done',
      startedAt: null,
      durationMs: 2000,
      outLen: 170,
      tools: [{ name: 'Bash', ms: 1 }],
    },
  ];
  const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });

  assert.equal(findByClass(container, 'subrow').length, 0, 'no monitor rows when nothing runs');
  assert.equal(findByClass(container, 'slempty').length, 1, 'a placeholder fills the card instead');
  assert.equal(findByClass(container, 'subcard').length, 1, 'the finished subagent is still in the catalog');

  view.destroy();
  g.document = prevDoc;
});

// The tab mounts BEFORE the session's history is read: the replay then floods the
// reducer with every line of the file. A graph that paints through that flood rebuilds the
// whole bento per coalesced tick — seconds of a half-built dashboard assembling itself, which
// is what a user saw on every refresh of a large session. In `loading` mode it must paint
// NOTHING (not even pull a snapshot — building one is the expensive part) until goLive().
test('loading graph paints nothing during the replay flood, and exactly once at goLive', async () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = baseSnapshot();
  let snapshots = 0; // a paint is the only thing that pulls the snapshot
  let notify: () => void = () => {};
  const state = {
    snapshot: () => {
      snapshots++;
      return snap;
    },
    onChange: (cb: () => void) => {
      notify = cb;
      return () => {};
    },
    onEvent: () => () => {},
  };

  const view = createGraph(container, state, { loading: true });
  assert.equal(snapshots, 0, 'no paint on mount while the history is still replaying');

  for (let i = 0; i < 500; i++) notify(); // the replay flood
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(snapshots, 0, '500 replayed events paint nothing');
  assert.equal(findByClass(container, 'subcard').length, 0, 'and draw no widgets');

  view.goLive(); // replay → live handoff
  assert.equal(snapshots, 1, 'exactly one paint for the whole replayed history');

  for (let i = 0; i < 20; i++) notify(); // live events, coalesced into one paint
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(snapshots, 2, 'live events coalesce into a single further paint');

  view.destroy();
  g.document = prevDoc;
});

test('a graph built over an already-replayed session paints immediately (no loading flag)', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = baseSnapshot();
  let snapshots = 0;
  const view = createGraph(container, {
    snapshot: () => {
      snapshots++;
      return snap;
    },
    onChange: () => () => {},
    onEvent: () => () => {},
  });
  assert.equal(snapshots, 1, 'paints on mount — its state is already whole (no loading flag)');
  view.destroy();
  g.document = prevDoc;
});

// ---- ended sessions: the live chrome must yield to the ended presentation ----

test('ended session: subagent card fills the column with the full list, LIVE badge yields to ended', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = baseSnapshot();
  snap.subagents = [
    {
      agentId: 'ag1',
      agentType: 'Explore',
      model: 'claude-opus-4-8',
      fill: 59700,
      window: 200000,
      pct: 30,
      estimated: false,
      state: 'done',
      startedAt: '2026-07-12T00:00:00Z',
      durationMs: 383000,
      tools: [],
    },
  ];
  const view = createGraph(
    container,
    { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} },
    { ended: true },
  );

  const monitor = findByClass(container, 'sublivecard')[0];
  assert.ok(monitor.className.split(' ').includes('fulllist'), 'card fills the column on an ended session');
  assert.equal(findByClass(monitor, 'slsum').length, 0, 'no one-line collapsed summary');
  assert.equal(findByClass(monitor, 'sublist').length, 1, 'the full list is rendered');
  assert.equal(findByClass(monitor, 'subrow').length, 1, 'one row per subagent that ran');

  const liveBadge = findByClass(container, 'live')[0];
  const endBadge = findByClass(container, 'endbadge')[0];
  assert.ok(liveBadge.classList.contains('hidden'), 'LIVE badge hidden on an ended session');
  assert.ok(!endBadge.classList.contains('hidden'), 'ended badge shown instead');

  view.destroy();
  g.document = prevDoc;
});

test('ended session: the full list stays session-wide when a turn is scoped', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = snapWithTurns([makeTurn(1)]); // turn 1 spawned NO subagents
  snap.subagents = [
    {
      agentId: 'ag1',
      agentType: 'Explore',
      model: 'claude-opus-4-8',
      fill: 59700,
      window: 200000,
      pct: 30,
      estimated: false,
      state: 'done',
      startedAt: '2026-07-12T00:00:00Z',
      durationMs: 383000,
      tools: [],
      turnIndex: 99,
    },
  ];
  const view = createGraph(
    container,
    { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} },
    { ended: true },
  );

  // scope to turn 1 via the strip (open it from the Session footer)
  findByClass(container, 'obtn')[0].onclick({ stopPropagation: () => {} });
  findByClass(container, 'sb')[0].onclick();

  const monitor = findByClass(container, 'sublivecard')[0];
  assert.equal(findByClass(monitor, 'subrow').length, 1, 'the session-wide list must not shrink to the scoped turn');
  assert.equal(
    findByClass(monitor, 'slcount')[0]?.textContent,
    '1 ran this session',
    'the count is the session-wide claim, not the scoped turn',
  );

  view.destroy();
  g.document = prevDoc;
});

test('setEnded flips a live graph into the ended presentation', async () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = baseSnapshot();
  const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });

  let monitor = findByClass(container, 'sublivecard')[0];
  assert.ok(!monitor.className.split(' ').includes('fulllist'), 'open session: live monitor, not the ended full list');
  assert.ok(!findByClass(container, 'live')[0].classList.contains('hidden'), 'open session: LIVE badge visible');

  view.setEnded();
  await new Promise((r) => setTimeout(r, 1)); // the repaint is coalesced (scheduleRender)
  monitor = findByClass(container, 'sublivecard')[0];
  assert.ok(monitor.className.split(' ').includes('fulllist'), 'after setEnded: card fills the column');
  assert.ok(findByClass(container, 'live')[0].classList.contains('hidden'), 'after setEnded: LIVE badge hidden');
  assert.equal(findByClass(monitor, 'slcount')[0]?.textContent, 'none ran this session');

  view.destroy();
  g.document = prevDoc;
});

test('setLive flips an ended graph back — a resumed session is not a new session', async () => {
  // `claude --resume` continues the SAME session id, so the ended presentation must be
  // reversible: the tab it froze is the only tab that session will ever get.
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = baseSnapshot();
  const view = createGraph(
    container,
    { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} },
    { ended: true },
  );
  assert.ok(container.children[0].classList.contains('ended'), 'built ended: the root carries the flag');

  view.setLive();
  await new Promise((r) => setTimeout(r, 1)); // the repaint is coalesced (scheduleRender)
  assert.equal(container.children[0].classList.contains('ended'), false, 'the root flag is gone');
  const monitor = findByClass(container, 'sublivecard')[0];
  assert.ok(!monitor.className.split(' ').includes('fulllist'), 'the subagent monitor is a live monitor again');
  assert.ok(!findByClass(container, 'live')[0].classList.contains('hidden'), 'the LIVE badge is back');

  view.destroy();
  g.document = prevDoc;
});

test('Session card: footer carries whole-session turn KPIs and the Explore toggle', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = baseSnapshot();
  const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });

  const foot = findByClass(container, 'sessfoot')[0];
  assert.ok(foot, 'the Session card has a footer');
  const kpis = findByClass(foot, 'sfk').map((n: any) => textOf(n));
  assert.ok(
    kpis.some((t: string) => t.includes('3 turns')),
    'turn count in the footer: ' + JSON.stringify(kpis),
  );
  assert.ok(
    kpis.some((t: string) => t.includes('12 API calls')),
    'API calls in the footer',
  );
  // No turnList → nothing to explore → no Explore button.
  assert.equal(findByClass(foot, 'obtn').length, 0, 'no Explore button without timeline entries');

  view.destroy();
  g.document = prevDoc;
});

test('Session card: the Output row carries the thinking split, and only when there is one', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();

  // Reported: the bar is drawn, inside the ledger, so it lines up with the row it splits.
  const withSplit = g.document.createElement();
  const snap = baseSnapshot();
  snap.main.outputTotal = 1_000;
  snap.main.thinkingTotal = 390;
  const a = createGraph(withSplit, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });
  const led = findByClass(findByClass(withSplit, 'burnw')[0], 'led')[0];
  const split = findByClass(led, 'tsplit')[0];
  assert.ok(split, 'the split is drawn inside the ledger, not appended after it');
  assert.match(textOf(split), /thinking/, 'and it names which half is which');
  a.destroy();

  // Not reported: nothing is drawn. A `0 / 0` bar would state a fact Claude Code never gave.
  const without = g.document.createElement();
  const snap2 = baseSnapshot();
  snap2.main.outputTotal = 1_000;
  snap2.main.thinkingTotal = null;
  const b = createGraph(without, { snapshot: () => snap2, onChange: () => () => {}, onEvent: () => () => {} });
  assert.equal(findByClass(without, 'tsplit').length, 0, 'no split when the scope reported none');
  b.destroy();

  g.document = prevDoc;
});

test('Session card: the three category rows are labelled "main session", the hero is not', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = baseSnapshot();
  snap.main.inputTotal = 100;
  snap.main.outputTotal = 150;
  snap.main.cacheTotals = { read: 10_000, created: 200 };
  const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });

  const usageCard = findByClass(container, 'burnw')[0];
  const label = findByClass(usageCard, 'ledlbl')[0];
  assert.ok(
    label && textOf(label) === 'main session',
    'the category ledger is headed "main session", so the hero above it is not read as their sum',
  );
  // The label sits ABOVE the ledger, not below or elsewhere.
  const kids = usageCard.children;
  assert.ok(
    kids.indexOf(label) < kids.indexOf(findByClass(usageCard, 'led')[0]),
    'the label precedes the ledger it names',
  );

  view.destroy();
  g.document = prevDoc;
});

test('Session card: the Subagents row opens into a per-model bar; absent when no subagent ran', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();

  // No subagents → no Subagents row → no bar. The bar must not exist without the row it explains.
  const bare = baseSnapshot();
  let view = createGraph(container, { snapshot: () => bare, onChange: () => () => {}, onEvent: () => () => {} });
  assert.equal(findByClass(container, 'submdl').length, 0, 'no subagent → no per-model bar');
  view.destroy();

  // With subagents on two families the bar carries one segment each, biggest share first,
  // and the legend names the FAMILY (sonnet), not the dated id.
  const snap = baseSnapshot();
  snap.subagentsTotal = 30_000;
  snap.subagentTokensByModel = [
    { model: 'claude-sonnet-4-6', tokens: 24_000 },
    { model: 'claude-haiku-4-5-20251001', tokens: 6_000 },
  ];
  const c2 = g.document.createElement();
  view = createGraph(c2, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });
  const bar = findByClass(c2, 'submdl')[0];
  assert.ok(bar, 'a per-model bar appears under the Subagents row');
  assert.equal(findByClass(bar, 'segbar')[0].children.length, 2, 'one segment per model family');
  const legend = textOf(findByClass(bar, 'seglegend')[0]);
  assert.ok(legend.includes('sonnet') && legend.includes('haiku'), 'the legend names both families: ' + legend);
  assert.ok(
    !legend.includes('claude-') && !legend.includes('4-6'),
    'families, not dated ids — sonnet, not claude-sonnet-4-6: ' + legend,
  );
  assert.ok(legend.includes('80%') && legend.includes('20%'), 'shares are the token proportions: ' + legend);
  view.destroy();

  g.document = prevDoc;
});

// A Workflow run is not a subagent: it spawns its own fleet (101 on a real deep-research run)
// into a nested dir. Decision: ONE aggregate row, never 101 rows.
test('a workflow run renders as ONE aggregate row, with a model breakdown', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = baseSnapshot();
  snap.subagents = [
    {
      kind: 'workflow',
      agentId: 'toolu_01',
      agentType: null,
      model: null,
      fill: 0,
      window: 200000,
      pct: 0,
      estimated: false,
      state: 'running',
      startedAt: '2026-07-12T00:00:00Z',
      durationMs: null,
      tools: [],
      toolUseId: 'toolu_01',
      prompt: null,
      outputFull: null,
      outLen: 0,
      volume: 0,
      volumeEstimated: false,
      weighted: 0,
      volumeBreakdown: null,
      turnIndex: null,
      workflow: {
        name: 'deep-research',
        runId: 'wf_33e24169',
        agents: 101,
        running: 4,
        volume: 10_758_494,
        models: [
          { model: 'claude-opus-4-8', agents: 77 },
          { model: 'claude-haiku-4-5-20251001', agents: 24 },
        ],
      },
    },
  ];
  const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });

  const wf = findByClass(container, 'wfcard');
  assert.equal(wf.length, 1, 'one row for the run, not one per subagent');
  const txt = textOf(wf[0]);
  assert.ok(txt.includes('deep-research'), 'the run is named: ' + txt);
  assert.ok(txt.includes('workflow run'), 'it declares it is not a subagent');
  assert.ok(txt.includes('101') && txt.includes('4 running'), 'fleet size + how many still work: ' + txt);
  // Both models must appear: a run mixes them per stage, so showing one would be a lie.
  assert.ok(
    txt.includes('claude-opus-4-8') && txt.includes('claude-haiku-4-5-20251001'),
    'the model BREAKDOWN, not a single model: ' + txt,
  );
  view.destroy();
  g.document = prevDoc;
});

// When a workflow run is done (or unknown/failed), agents that never sent a result are labelled
// "never returned", not "running" — the journal proves they didn't come back, not that they work.
test('a workflow run that is done labels unreturned agents as "never returned", not "running"', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const mk = (state: string, ended: boolean) => {
    const container = g.document.createElement();
    const snap = baseSnapshot();
    snap.subagents = [
      {
        kind: 'workflow',
        agentId: 'toolu_01',
        agentType: null,
        model: null,
        fill: 0,
        window: 200000,
        pct: 0,
        estimated: false,
        state: state as any,
        startedAt: '2026-07-12T00:00:00Z',
        durationMs: 60000,
        tools: [],
        toolUseId: 'toolu_01',
        prompt: null,
        outputFull: null,
        outLen: 0,
        volume: 0,
        volumeEstimated: false,
        weighted: 0,
        volumeBreakdown: null,
        turnIndex: null,
        workflow: {
          name: 'deep-research',
          runId: 'wf_29b9fbfd',
          agents: 5,
          running: 5,
          volume: 0,
          models: [],
        },
      },
    ];
    const view = createGraph(
      container,
      { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} },
      { ended },
    );
    const txt = textOf(findByClass(container, 'wfcard')[0] ?? container);
    view.destroy();
    return txt;
  };
  // A running workflow correctly shows "running"
  assert.ok(mk('running', false).includes('5 running'), 'live run still says running');
  // A done workflow must NOT say "running" — contradicts the state badge
  const doneTxt = mk('done', true);
  assert.ok(!doneTxt.includes('running'), 'done run must not say "running": ' + doneTxt);
  assert.ok(doneTxt.includes('never returned'), 'done run labels them "never returned": ' + doneTxt);
  g.document = prevDoc;
});

// `running` on a session that is over means the completion signal never arrived (~4.5% of
// background subagents) — not that it is still working. Only the view knows the session ended.
test('a still-running subagent on an ENDED session reads unknown, not running', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const mk = (ended: boolean) => {
    const container = g.document.createElement();
    const snap = baseSnapshot();
    snap.subagents = [
      {
        kind: 'subagent',
        agentId: 'ag1',
        agentType: 'general-purpose',
        model: 'claude-sonnet-4-6',
        fill: 100,
        window: 200000,
        pct: 0,
        estimated: false,
        state: 'running',
        startedAt: '2026-07-12T00:00:00Z',
        durationMs: null,
        tools: [],
        toolUseId: 'toolu_01',
        prompt: null,
        outputFull: null,
        outLen: 0,
        volume: 0,
        volumeEstimated: false,
        weighted: 0,
        volumeBreakdown: null,
        turnIndex: null,
        workflow: null,
      },
    ];
    const view = createGraph(
      container,
      { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} },
      { ended },
    );
    const badge = findByClass(container, 'badge').map((n: any) => textOf(n));
    view.destroy();
    return badge;
  };
  assert.ok(mk(true).includes('unknown'), 'an ended session cannot have a running subagent');
  assert.ok(mk(false).includes('running'), 'a live session shows it running — that is the truth there');
  g.document = prevDoc;
});

// The live row is headed by what the subagent was launched to DO, with the type demoted
// under it — eight rows reading `general-purpose` name none of them. The type's line is
// rendered even while the type is unknown (the child's sidecar lands after the spawn), so
// the row does not grow under the user's eyes a moment after appearing.
test('a live subagent row leads with its intent and always reserves the type line', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = baseSnapshot();
  const row = (over: Record<string, unknown>) => ({
    kind: 'subagent',
    agentId: 'child_1',
    agentType: 'general-purpose',
    model: 'claude-sonnet-4-6',
    title: 'Review Task 5 (spec + quality)',
    fill: 48_900,
    window: 200_000,
    pct: 24,
    estimated: false,
    state: 'running',
    startedAt: '2026-07-19T00:00:00Z',
    durationMs: null,
    tools: [],
    toolUseId: 'toolu_A',
    prompt: null,
    outputFull: null,
    outLen: 0,
    volume: 0,
    volumeEstimated: false,
    weighted: 0,
    volumeBreakdown: null,
    turnIndex: null,
    workflow: null,
    ...over,
  });
  // Second row: the spawn is known, its child has not named the type yet.
  snap.subagents = [
    row({}),
    row({ agentId: 'child_2', toolUseId: 'toolu_B', agentType: null, title: 'Implement Task 6' }),
  ];
  const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });

  const rows = findByClass(container, 'subrow');
  assert.equal(rows.length, 2);
  assert.ok(textOf(rows[0]).includes('Review Task 5'), 'the intent heads the row: ' + textOf(rows[0]));
  assert.ok(textOf(rows[0]).includes('general-purpose'), 'the type is still shown, demoted');
  // Both rows carry the type line — the second one empty, holding its height.
  assert.equal(findByClass(container, 'stype').length, 2, 'the type line is reserved on every row');
  assert.ok(!textOf(rows[1]).includes('toolu_'), 'a raw tool_use id is never the headline: ' + textOf(rows[1]));
  view.destroy();
  g.document = prevDoc;
});

// Caught by the maintainer on a REAL live run, not by any test: a running workflow went through
// subActiveRow (the subagent renderer) and painted a raw `toolu_…` id, a "0 / 200k · 0%"
// context bar for a thing that HAS no context window, and a frozen "→ starting…".
// The workflow branch existed only in the catalog; the live monitor never got one.
test('a RUNNING workflow in the live monitor shows the fleet, not a fake context bar', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = baseSnapshot();
  snap.subagents = [
    {
      kind: 'workflow',
      agentId: 'toolu_01',
      agentType: null,
      model: null,
      fill: 0,
      window: 200000,
      pct: 0,
      estimated: false,
      state: 'running',
      startedAt: '2026-07-16T00:00:00Z',
      durationMs: null,
      tools: [],
      toolUseId: 'toolu_01',
      prompt: null,
      outputFull: null,
      outLen: 0,
      volume: 137_678,
      volumeEstimated: false,
      volumeBreakdown: null,
      turnIndex: null,
      workflow: {
        name: 'seedeep-live-check',
        runId: 'wf_db4f0d0b',
        agents: 4,
        running: 3,
        volume: 137_678,
        models: [
          { model: 'claude-haiku-4-5-20251001', agents: 3 },
          { model: 'claude-sonnet-4-6', agents: 1 },
        ],
      },
    },
  ];
  const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });

  const rows = findByClass(container, 'subrow');
  assert.equal(rows.length, 1, 'the running workflow is in the live monitor');
  const txt = textOf(rows[0]);
  assert.ok(txt.includes('seedeep-live-check'), 'named by the run, never by a raw tool_use id: ' + txt);
  assert.ok(!txt.includes('toolu_'), 'a raw tool_use id is not a name: ' + txt);
  assert.ok(txt.includes('3 of 4 running'), 'the fleet is the progress: ' + txt);
  assert.ok(!txt.includes('200k'), 'a workflow has no context window — no fake bar: ' + txt);
  view.destroy();
  g.document = prevDoc;
});

// Killing a workflow leaves NO terminal signal anywhere — verified on a real kill: no
// task-notification (a killed SUBAGENT gets one, a killed run does not), an empty task output
// file, and a journal frozen on its `started` lines. The maintainer watched a dead run sit at
// "running · 5 of 5" indefinitely. Silence is the only evidence, so it is used — but only for
// a RUN, and only while the session is live.
function wfSnap(lastActivityAt: number | null, running = 5) {
  const snap = baseSnapshot();
  snap.subagents = [
    {
      kind: 'workflow',
      agentId: 'toolu_01',
      agentType: null,
      model: null,
      fill: 0,
      window: 200000,
      pct: 0,
      estimated: false,
      state: 'running',
      startedAt: '2026-07-16T00:00:00Z',
      durationMs: null,
      tools: [],
      toolUseId: 'toolu_01',
      prompt: null,
      outputFull: null,
      outLen: 0,
      volume: 1_100_000,
      volumeEstimated: false,
      volumeBreakdown: null,
      turnIndex: null,
      workflow: {
        name: 'seedeep-live-check-slow',
        runId: 'wf_29b9fbfd',
        agents: 5,
        running,
        volume: 1_100_000,
        models: [{ model: 'claude-haiku-4-5-20251001', agents: 5 }],
        lastActivityAt,
      },
    },
  ];
  return snap;
}
function badgesFor(snap: any, ended: boolean): string[] {
  const g = globalThis as any;
  const container = g.document.createElement();
  const view = createGraph(
    container,
    { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} },
    { ended },
  );
  const out = findByClass(container, 'badge').map((n: any) => textOf(n));
  view.destroy();
  return out;
}

test('a workflow run gone silent reads unknown; one that just wrote stays running', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const now = Date.now();

  assert.ok(
    badgesFor(wfSnap(now - 6 * 60_000), false).includes('unknown'),
    'silent for 6min on a LIVE session: seedeep stopped hearing from it — a killed run leaves no other trace',
  );
  assert.ok(
    badgesFor(wfSnap(now - 30_000), false).includes('running'),
    'wrote 30s ago: alive. The longest silence ever measured inside a live run is 113s',
  );
  // Self-healing: the state is derived from the latest activity, never latched.
  assert.ok(
    badgesFor(wfSnap(now - 1_000), false).includes('running'),
    'a run that writes again is running again — a false unknown must heal itself',
  );
  // Never invent a verdict with no evidence to date it.
  assert.ok(
    badgesFor(wfSnap(null), false).includes('running'),
    'no activity timestamp yet (just launched): stays running, never guessed dead',
  );

  g.document = prevDoc;
});

// Review finding: the live monitor filtered on the RAW state, so a run the threshold had
// already declared silent stayed listed there and counted in "N running" — the header and the
// row's own badge asserting opposite things about the same run.
test('a silent workflow leaves the live monitor, not just the catalog badge', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const now = Date.now();

  const live = (lastActivityAt: number) => {
    const container = g.document.createElement();
    const view = createGraph(
      container,
      { snapshot: () => wfSnap(lastActivityAt), onChange: () => () => {}, onEvent: () => () => {} },
      { ended: false },
    );
    const txt = (n: any) => textOf(n);
    const out = {
      header: findByClass(container, 'slcount').map(txt).join(''),
      liveRows: findByClass(container, 'subrow').length,
    };
    view.destroy();
    return out;
  };

  const fresh = live(now - 30_000);
  assert.equal(fresh.liveRows, 1, 'a working run belongs in the live monitor');
  assert.ok(fresh.header.includes('1 running'), 'and is counted: ' + fresh.header);

  const silent = live(now - 6 * 60_000);
  assert.equal(silent.liveRows, 0, 'a run gone silent is not "what is working now"');
  assert.ok(silent.header.includes('0 running'), 'and must not be counted running: ' + silent.header);
  assert.ok(silent.header.includes('1 finished below'), 'it moves to the catalog: ' + silent.header);

  g.document = prevDoc;
});

// Review finding: displayState reads the clock but onChange was the ONLY render trigger, so in
// an idle session the threshold never fired. A repaint is now armed for the exact deadline —
// and exactly one, re-armed per render, or a busy session would pile up a 5min timer per paint.
test('a live workflow arms exactly one repaint for its silence deadline, and destroy clears it', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  g.document = fakeDoc();
  const armed: number[] = [];
  const cleared: any[] = [];
  let id = 100;
  (globalThis as any).setTimeout = (_fn: any, ms: number) => {
    armed.push(ms);
    return ++id;
  };
  (globalThis as any).clearTimeout = (t: any) => {
    cleared.push(t);
  };
  try {
    const container = g.document.createElement();
    const view = createGraph(
      container,
      { snapshot: () => wfSnap(Date.now() - 60_000), onChange: () => () => {}, onEvent: () => () => {} },
      { ended: false },
    );
    // 5min threshold, 60s already elapsed → ~4min out (plus the 1s cushion).
    const long = armed.filter((ms) => ms > 200_000);
    assert.equal(long.length, 1, 'exactly one staleness repaint armed, not one per widget: ' + JSON.stringify(armed));
    assert.ok(long[0]! > 230_000 && long[0]! < 250_000, 'armed for the real deadline (~4min): ' + long[0]);
    view.destroy();
    assert.ok(cleared.length > 0, 'destroy() cancels it — a pending 5min timer must not outlive the tab');
  } finally {
    (globalThis as any).setTimeout = realSetTimeout;
    (globalThis as any).clearTimeout = realClearTimeout;
    g.document = prevDoc;
  }
});

// The dense-row chip shortens known families but must keep a fable id VERBATIM — a
// product call (2026-07-16): fable rows read as the full id, only the dropdown families.
test('a running subagent chip keeps a fable model id verbatim, shortens other families', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = baseSnapshot();
  snap.subagents = [
    {
      agentId: 'f1',
      agentType: 'claude',
      model: 'claude-fable-5',
      state: 'running',
      fill: 1000,
      window: 200000,
      pct: 1,
      estimated: false,
      durationMs: null,
      tools: [],
    },
    {
      agentId: 'o1',
      agentType: 'claude',
      model: 'claude-opus-4-8',
      state: 'running',
      fill: 1000,
      window: 200000,
      pct: 1,
      estimated: false,
      durationMs: null,
      tools: [],
    },
  ];
  const state = { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} };
  const view = createGraph(container, state);
  assert.deepEqual(
    findByClass(container, 'schip').map((n: any) => n.textContent),
    ['claude-fable-5', 'opus'],
  );
  view.destroy();
  g.document = prevDoc;
});

// ---- Trace → drawer routing (Task 5) ----

test('graph: clicking a tool block in the trace opens the existing drawer', () => {
  const g = globalThis as any;
  const prev = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = baseSnapshot();
  // id + ctx > 0 so openBlock finds the real node and triggers loadToolOutput.
  (snap as any).mainTools = [{ id: 'tu0', name: 'Read', ms: 95, ctx: 100, arg: 'some/file.ts', turnIndex: 1 }];
  let fetched: string | null = null;
  let eventCallback: any = null;
  const state = {
    snapshot: () => snap,
    onChange: () => () => {},
    // Capture the callback so we can inject events into the span store.
    onEvent: (cb: any) => {
      eventCallback = cb;
      return () => {};
    },
  };
  const view = createGraph(container, state, {
    sessionId: 's1',
    loadToolOutput: (id: string) => {
      fetched = id;
      return Promise.resolve(null);
    },
  });

  // Populate the span store: one turn (index=1) + one tool span (id='tu0').
  // The turn must exist before the tool-start, exactly as the live parser emits them.
  const now = new Date().toISOString();
  eventCallback({ type: 'user-turn', agentId: null, prompt: 'hello', timestamp: now }, { turnIndex: 1 });
  eventCallback(
    { type: 'tool-start', id: 'tu0', name: 'Read', agentId: null, timestamp: now },
    { turnIndex: 1, label: 'some/file.ts' },
  );

  // Open the trace. trace.js always pre-expands segment 0 (openTurns.add(0)), so
  // buildBody runs immediately and snode elements are present in the container.
  findByClass(container, 'tracebtn')[0].onclick();

  // The first non-prompt/result/spawn snode with an onclick is the tool block.
  const snodes = findByClass(container, 'snode');
  const toolNode = snodes.find(
    (n: any) =>
      typeof n.onclick === 'function' &&
      !n.className.includes('start') &&
      !n.className.includes('end') &&
      !n.className.includes('spawn'),
  );
  assert.ok(toolNode, 'tool snode with onclick found in the trace DOM');
  toolNode.onclick();

  // Invariant: onBlock({kind:'tool',toolUseId:'tu0'}) → openTool → loadToolOutput('tu0') → drawer.on
  assert.ok(findByClass(container, 'drawer')[0].classList.contains('on'), 'drawer opened from trace block click');
  assert.equal(fetched, 'tu0', 'loadToolOutput called with the correct toolUseId');

  view.destroy();
  g.document = prev;
});

// ---- Escape-gating: first Escape closes drawer, NOT the trace ----

test('graph: Escape closes the drawer but stops propagation so the trace stays open', () => {
  const g = globalThis as any;
  const prev = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = baseSnapshot();
  (snap as any).mainTools = [{ id: 'tu0', name: 'Read', ms: 95, ctx: 0, arg: null, turnIndex: 1 }];
  let eventCallback: any = null;
  const state = {
    snapshot: () => snap,
    onChange: () => () => {},
    onEvent: (cb: any) => {
      eventCallback = cb;
      return () => {};
    },
  };
  const view = createGraph(container, state, { sessionId: 's1' });

  // Populate span store → trace has a turn with a tool block
  const now = new Date().toISOString();
  eventCallback({ type: 'user-turn', agentId: null, prompt: 'hello', timestamp: now }, { turnIndex: 1 });
  eventCallback({ type: 'tool-start', id: 'tu0', name: 'Read', agentId: null, timestamp: now }, { turnIndex: 1 });

  // Open trace then click the tool block to open the drawer
  findByClass(container, 'tracebtn')[0].onclick();
  const toolNode = findByClass(container, 'snode').find(
    (n: any) =>
      typeof n.onclick === 'function' &&
      !n.className.includes('start') &&
      !n.className.includes('end') &&
      !n.className.includes('spawn'),
  );
  assert.ok(toolNode, 'tool snode found');
  toolNode.onclick();
  assert.ok(findByClass(container, 'drawer')[0].classList.contains('on'), 'drawer open before Escape');

  // Verify the trace modal is present
  const traceModal = findByClass(container, 'trace-modal')[0];
  assert.ok(traceModal, 'trace-modal present before Escape');
  assert.ok(traceModal.classList.contains('on'), 'trace-modal is on before Escape');

  // Fire Escape at the document (reaches graph.js's onKey handler via _fire).
  // Spy on stopPropagation — without the Task-5 fix (stopPropagation added) this spy
  // is never called, making the test RED. With the fix it is called exactly once.
  let stopPropagationCalled = false;
  g.document._fire('keydown', {
    key: 'Escape',
    stopPropagation: () => {
      stopPropagationCalled = true;
    },
  });

  // The drawer must close on the first Escape.
  assert.ok(!findByClass(container, 'drawer')[0].classList.contains('on'), 'drawer closed after first Escape');
  // stopPropagation must have been called to prevent the trace from also closing.
  // Without the Task-5 change this assertion FAILS (old handler had no stopPropagation).
  assert.ok(stopPropagationCalled, 'stopPropagation called so the trace window-listener is silenced');
  // The trace-modal must still be on after the first Escape (the Escape was consumed by the drawer).
  // In the fake-DOM the window-level listener is not wired so this guards against regressions
  // in the document-level handler itself (e.g. graph.js accidentally calling trace.close()).
  assert.ok(traceModal.classList.contains('on'), 'trace-modal still on after first Escape (not closed)');

  view.destroy();
  g.document = prev;
});

// ---- Subagent block routing via openBlock (Task-5 new branch) ----

test('graph: openBlock({kind:subagent}) opens the drawer when the agent is in the snapshot', () => {
  const g = globalThis as any;
  const prev = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = snapWithSubagent(); // provides subagents[0].agentId = 'ag1'
  const state = { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} };
  const view = createGraph(container, state) as any;

  // Positive: matching agentId → openSub → drawer opens.
  // RED without the Task-5 subagent branch (old LIMIT comment fell through, drawer stayed closed).
  view._openBlock({ kind: 'subagent', agentId: 'ag1' });
  assert.ok(findByClass(container, 'drawer')[0].classList.contains('on'), 'drawer opens for a known subagent');

  // Close the drawer before testing the no-op path.
  findByClass(container, 'close')[0].onclick();
  assert.ok(!findByClass(container, 'drawer')[0].classList.contains('on'), 'drawer closed again');

  // Unknown agentId WITHOUT a toolUseId: nothing to route to — drawer stays closed.
  view._openBlock({ kind: 'subagent', agentId: 'unknown-agent' });
  assert.ok(
    !findByClass(container, 'drawer')[0].classList.contains('on'),
    'drawer stays closed without a toolUseId to fall back to',
  );

  // Unknown agentId WITH the spawn toolUseId: falls back to the spawn TOOL drawer
  // (launch prompt/timing always exist there) — never a silent no-op.
  view._openBlock({ kind: 'subagent', agentId: 'unknown-agent', toolUseId: 'sw9' });
  const drawer = findByClass(container, 'drawer')[0];
  assert.ok(drawer.classList.contains('on'), 'drawer opens via the spawn-tool fallback');
  assert.ok(textOf(drawer).includes('Agent'), 'fallback drawer shows the spawn tool');

  view.destroy();
  g.document = prev;
});

// ---- The model is named wherever a scope is named ----

function withDoc<T>(fn: (doc: any, container: any) => T): T {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  try {
    return fn(g.document, g.document.createElement());
  } finally {
    g.document = prevDoc;
  }
}

test('scope banner: a selected turn names the model its own calls ran on', () => {
  withDoc((_doc, container) => {
    const snap = snapWithTurns([makeTurn(1, { models: ['claude-opus-4-8'], efforts: ['xhigh'] })]);
    const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });
    selectTurnViaStrip(container, 0);
    const banner = findByClass(container, 'scope-banner')[0];
    assert.equal(
      findByClass(banner, 'sbmodel')[0]?.textContent,
      'opus-4-8',
      'the version is kept — it is what decides the 1M vs 200k window',
    );
    assert.equal(findByClass(banner, 'sbeffort')[0]?.textContent, 'xhigh');
    view.destroy();
  });
});

// 98% of real turns carry no effort. An empty chip there would be noise on almost every turn.
test('scope banner: a turn with no effort renders no effort chip at all', () => {
  withDoc((_doc, container) => {
    const snap = snapWithTurns([makeTurn(1, { models: ['claude-sonnet-4-6'], efforts: [] })]);
    const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });
    selectTurnViaStrip(container, 0);
    const banner = findByClass(container, 'scope-banner')[0];
    assert.equal(findByClass(banner, 'sbmodel')[0]?.textContent, 'sonnet-4-6');
    assert.equal(findByClass(banner, 'sbeffort').length, 0);
    view.destroy();
  });
});

test('scope banner: whole session names the session model', () => {
  withDoc((_doc, container) => {
    const snap = snapWithTurns([makeTurn(1)]);
    snap.main.models = ['claude-opus-4-8'];
    const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });
    const banner = findByClass(container, 'scope-banner')[0];
    const chip = findByClass(banner, 'sbmodel')[0];
    assert.equal(chip?.textContent, 'opus-4-8');
    assert.ok(!chip.className.includes('mixed'), 'one model is not a change');
    view.destroy();
  });
});

// The mid-session switch. Showing only the current model would hide that it changed;
// showing only the first IS the bug that made the window wrong by 5×.
test('scope banner: a session that changed model shows the current one and what it was', () => {
  withDoc((_doc, container) => {
    const snap = snapWithTurns([makeTurn(1)]);
    snap.main.models = ['claude-opus-4-8', 'claude-sonnet-4-6'];
    const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });
    const chip = findByClass(findByClass(container, 'scope-banner')[0], 'sbmodel')[0];
    assert.equal(chip?.textContent, 'sonnet-4-6 · was opus-4-8');
    assert.ok(chip.className.includes('mixed'), 'a changed model is marked, not stated quietly');
    view.destroy();
  });
});

// B2, and the reason the chip follows the scope: with a turn selected the card reads
// "Tokens billed this turn", so a chip naming the SESSION's model would qualify one thing
// while the numbers beside it describe another.
test('Session card: the model chip follows the scope, like the ledger under it', () => {
  withDoc((_doc, container) => {
    const snap = snapWithTurns([
      makeTurn(1, { models: ['claude-opus-4-8'] }),
      makeTurn(2, { models: ['claude-sonnet-4-6'] }),
    ]);
    snap.main.models = ['claude-opus-4-8', 'claude-sonnet-4-6'];
    const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });

    const titleChip = () => {
      const titles = findByClass(container, 'wtitle').filter((t: any) => (t.textContent ?? '').startsWith('Session'));
      return findByClass(titles[0], 'sbmodel')[0]?.textContent;
    };
    assert.equal(titleChip(), 'sonnet-4-6 · was opus-4-8', 'whole session: the session model');

    selectTurnViaStrip(container, 0); // first turn — an opus turn
    assert.equal(titleChip(), 'opus-4-8', 'scoped to a turn: that turn model');
    view.destroy();
  });
});

// ---- Session working time: the sum of the turns' own durations ----

// Wall-clock and working time are far apart (median 33% across 202 real sessions), so the
// total must be the SUM OF THE PARTS — the same turn_duration values each turn shows.
test('whole session: the banner totals the time the session actually worked', () => {
  withDoc((_doc, container) => {
    const snap = snapWithTurns([makeTurn(1), makeTurn(2), makeTurn(3)]); // 60s each
    const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });
    const texts = findByClass(findByClass(container, 'scope-banner')[0], 'sbstats').map((e: any) => e.textContent);
    assert.ok(texts.includes('3m total'), `expected the 3×60s total, got ${JSON.stringify(texts)}`);
    view.destroy();
  });
});

// An open turn has no turn_duration yet. Without adding its elapsed the total would sit
// frozen for the whole length of a turn and then jump by minutes at once.
test('whole session: the total includes the open turn elapsed, so it keeps moving', () => {
  withDoc((_doc, container) => {
    const snap = snapWithTurns([makeTurn(1), makeTurn(2, { state: 'live', result: null })]);
    snap.turnList[1].durationMs = null; // open: not yet counted
    snap.turnList[1].startedAt = new Date(Date.now() - 30_000).toISOString();
    const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });
    const texts = findByClass(findByClass(container, 'scope-banner')[0], 'sbstats').map((e: any) => e.textContent);
    assert.ok(texts.includes('1m 30s total'), `60s done + 30s open, got ${JSON.stringify(texts)}`);
    view.destroy();
  });
});

// On an ended session the open turn contributes nothing: it never finished, and a total
// that kept counting would grow for as long as the tab stayed open on a dead session.
test('ended session: the total is the finished turns only, and does not count', () => {
  withDoc((_doc, container) => {
    const snap = snapWithTurns([makeTurn(1), makeTurn(2, { state: 'live', result: null })]);
    snap.turnList[1].durationMs = null;
    snap.turnList[1].startedAt = new Date(Date.now() - 30_000).toISOString();
    const view = createGraph(
      container,
      { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} },
      { ended: true },
    );
    const texts = findByClass(findByClass(container, 'scope-banner')[0], 'sbstats').map((e: any) => e.textContent);
    assert.ok(texts.includes('1m total'), `only the finished 60s, got ${JSON.stringify(texts)}`);
    view.destroy();
  });
});

// A session whose first turn is still running has no finished turn to total.
test('whole session: no total before the first turn finishes', () => {
  withDoc((_doc, container) => {
    const snap = snapWithTurns([makeTurn(1, { state: 'live', result: null })]);
    snap.turnList[0].durationMs = null;
    const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });
    const texts = findByClass(findByClass(container, 'scope-banner')[0], 'sbstats').map((e: any) => e.textContent);
    assert.ok(!texts.some((t: string) => t?.includes('total')), `got ${JSON.stringify(texts)}`);
    view.destroy();
  });
});

// ---- the all-activity drawer (Live activity → Expand all) ----

// The Expand all button lives in the Live activity card's header, beside Trace.
const liveExpandBtn = (container: any) => findByClass(findByClass(container, 'livecard')[0], 'xbtn')[0];
// Rows of the all-activity list, by the name in their .tn column.
// Strip the '#N' chronological number prefix so callers can assert on tool names alone.
const activityNames = (container: any) =>
  findByClass(findByClass(container, 'drawer')[0], 'ttrow').map((r: any) =>
    textOf(findByClass(r, 'tn')[0]).replace(/^#\d+/, '').trim(),
  );
// The turn groups of an Expand-all drawer (both of them build the same furniture). `rows` counts
// what is RENDERED inside: a collapsed group builds none, which is what keeps the drawer readable.
const turnGroupsOf = (container: any) =>
  findByClass(findByClass(container, 'drawer')[0], 'tgroup').map((g: any) => ({
    label: textOf(findByClass(g, 'tglabel')[0]),
    meta: textOf(findByClass(g, 'tgmeta')[0]),
    open: g.className.split(' ').includes('open'),
    rows: findByClass(g, 'ttrow').length,
    toggle: () => findByClass(g, 'tghead')[0].onclick(),
  }));

test('all-activity drawer: shows the activities the 13-row feed ring had to drop', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const state = drivableState(snapWithTurns([makeTurn(1)]));
  const view = createGraph(container, state);

  // The span store opens a turn on the prompt — without it every later span is dropped.
  state.emit(
    {
      type: 'user-turn',
      prompt: 'harden the retry path',
      command: null,
      timestamp: '2026-07-14T09:59:59Z',
      agentId: null,
    },
    1,
  );

  // 15 tools in one turn — past FEED_CAP (13), so the ring evicts the oldest and the drawer
  // still holds them all. The displayed count is the ring's 13 here: the dynamic feed cap only
  // shrinks after the panel is measured post-layout, which a fake DOM never does.
  for (let i = 0; i < 15; i++) {
    state.emit(toolStart(`t${i}`, `Tool${i}`, `2026-07-14T10:00:${String(i).padStart(2, '0')}Z`), 1);
  }
  assert.equal(findByClass(container, 'fev').length, 13, 'the card still shows only the ring');

  liveExpandBtn(container).onclick();
  const names = activityNames(container);
  // Exactly the 15 tools: the prompt that opened the turn is turn structure, not activity —
  // the card never shows it, so its Expand all must not either.
  assert.equal(names.length, 15, 'the drawer shows every activity, including the 3 the ring evicted');
  assert.ok(
    names.some((n: string) => n.includes('Tool0')),
    'the oldest activity — evicted from the ring — is present',
  );
  assert.ok(findByClass(container, 'drawer')[0].classList.contains('on'), 'the drawer is open');

  view.destroy();
  g.document = prevDoc;
});

test('all-activity drawer: subagent rows appear, badged and lane-marked', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const state = drivableState(snapWithTurns([makeTurn(1)]));
  const view = createGraph(container, state);

  // The span store opens a turn on the prompt — without it every later span is dropped.
  state.emit(
    {
      type: 'user-turn',
      prompt: 'harden the retry path',
      command: null,
      timestamp: '2026-07-14T09:59:59Z',
      agentId: null,
    },
    1,
  );

  state.emit(
    { type: 'tool-start', id: 'task_1', name: 'Task', arg: null, timestamp: '2026-07-14T10:00:00Z', agentId: null },
    1,
  );
  state.emit(
    {
      type: 'subagent-meta',
      toolUseId: 'task_1',
      agentId: 'ag_1',
      agentType: 'Explore',
      model: 'claude-sonnet-5',
      timestamp: '2026-07-14T10:00:01Z',
    },
    1,
  );
  state.emit(
    { type: 'tool-start', id: 'sub_1', name: 'Read', arg: null, timestamp: '2026-07-14T10:00:02Z', agentId: 'ag_1' },
    1,
  );

  liveExpandBtn(container).onclick();
  const drawer = findByClass(container, 'drawer')[0];
  // The defect this guards: subagent spans live ONLY in the spawn lanes, so a list built
  // from the turn's own spans drops them silently and still looks plausible.
  const lanes = findByClass(drawer, 'lane');
  assert.equal(lanes.length, 1, 'the subagent row is in the list');
  assert.equal(findByClass(lanes[0], 'aagent')[0].textContent, 'Explore', 'badged with its agent, model stripped');
  assert.ok(
    activityNames(container).some((n: string) => n.includes('Read')),
    'the subagent tool is named',
  );

  view.destroy();
  g.document = prevDoc;
});

test('all-activity drawer: a failed tool is badged, a successful one is not', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const state = drivableState(snapWithTurns([makeTurn(1)]));
  const view = createGraph(container, state);

  state.emit(
    { type: 'user-turn', prompt: 'edit the files', command: null, timestamp: '2026-07-14T09:59:59Z', agentId: null },
    1,
  );
  state.emit(toolStart('t_ok', 'Read', '2026-07-14T10:00:00Z'), 1);
  state.emit({ type: 'tool-end', toolUseId: 't_ok', timestamp: '2026-07-14T10:00:01Z', agentId: null }, 1);
  state.emit(toolStart('t_bad', 'Edit', '2026-07-14T10:00:02Z'), 1);
  // The failed tool-end carries error: true — the parser sets it only for a real failure.
  state.emit(
    { type: 'tool-end', toolUseId: 't_bad', error: true, timestamp: '2026-07-14T10:00:03Z', agentId: null },
    1,
  );

  liveExpandBtn(container).onclick();
  const drawer = findByClass(container, 'drawer')[0];
  const errRows = findByClass(drawer, 'ttrow').filter((r: any) => r.classList.contains('err'));
  assert.equal(errRows.length, 1, 'exactly the failed tool row is marked err');
  assert.ok(textOf(findByClass(errRows[0], 'tn')[0]).includes('Edit'), 'and it is the Edit');
  assert.equal(findByClass(errRows[0], 'terr').length, 1, 'the row carries the error badge');
  // The successful Read must not be reddened.
  const readRow = findByClass(drawer, 'ttrow').find((r: any) => textOf(findByClass(r, 'tn')[0]).includes('Read'));
  assert.ok(readRow && !readRow.classList.contains('err'), 'the successful tool is not badged');

  view.destroy();
  g.document = prevDoc;
});

// When a session ran subagents the Session card grows a by-model bar, and the stats strip hands
// its neighbour cards the same extra height (align-items:stretch). Changed files and Main tools
// spend it on one more row of real data — a 4th tool hog, a 5th file-type bar — gated on the SAME
// `subagentsTotal > 0` that controls the bar. (Skills/Commands split their card 50/50 in CSS,
// independent of subagents — not asserted here since fake-dom does not compute flex.)
test('stats strip: one extra item per card when subagents ran, none when they did not', async () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const build = (withSubs: boolean) => {
    const snap = snapWithTurns([makeTurn(1)]);
    // Five distinct file types and five output tools available — enough to hit either cap.
    snap.mainTools = [
      { id: 't1', name: 'Read', ms: 9, arg: 'a', ctx: 5000, turnIndex: 1 },
      { id: 't2', name: 'Bash', ms: 9, arg: 'b', ctx: 4000, turnIndex: 1 },
      { id: 't3', name: 'Edit', ms: 9, arg: 'c', ctx: 3000, turnIndex: 1 },
      { id: 't4', name: 'Grep', ms: 9, arg: 'd', ctx: 2000, turnIndex: 1 },
      { id: 't5', name: 'Glob', ms: 9, arg: 'e', ctx: 1000, turnIndex: 1 },
    ];
    // Six distinct types, from git via the server — the reducer's ledger no longer feeds the card.
    if (withSubs) {
      snap.subagentsTotal = 30_000;
      snap.subagentTokensByModel = [{ model: 'claude-sonnet-4-6', tokens: 30_000 }];
    }
    return snap;
  };
  const cardBy = (container: any, title: string) =>
    findByClass(container, 'card').find((c: any) =>
      findByClass(c, 'wtitle').some((t: any) => (t.textContent ?? '').startsWith(title)),
    );

  const sixTypes = {
    roots: ['~/proj'],
    origin: { kind: 'commits' as const, commits: 1 },
    scratch: [],
    artifacts: [],
    files: ['a.ts', 'b.js', 'c.md', 'd.json', 'e.css', 'f.sh'].map((p, i) => ({
      path: `~/proj/${p}`,
      at: 1000 + i,
      commit: 'aaa1111',
    })),
  };
  const mount = async (container: any, snap: any) => {
    const v = createGraph(container, drivableState(snap), { loading: true, loadFiles: async () => sixTypes });
    v.goLive();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    return v;
  };

  // With subagents: 4 tool rows, 5 file bars, Skills marked grow.
  const cWith = g.document.createElement();
  const vWith = await mount(cWith, build(true));
  assert.equal(findByClass(cardBy(cWith, 'Main tools'), 'hogrow').length, 4, 'a 4th tool hog when subagents ran');
  assert.equal(
    findByClass(cardBy(cWith, 'Changed files'), 'fchgbar').length,
    5,
    'a 5th file-type bar when subagents ran',
  );
  vWith.destroy();

  // Without subagents: the measured baselines — 3 tool rows, 4 file bars, no grow.
  const cNo = g.document.createElement();
  const vNo = await mount(cNo, build(false));
  assert.equal(
    findByClass(cardBy(cNo, 'Main tools'), 'hogrow').length,
    3,
    'the baseline 3 tool hogs without subagents',
  );
  assert.equal(
    findByClass(cardBy(cNo, 'Changed files'), 'fchgbar').length,
    4,
    'the baseline 4 file bars without subagents',
  );
  vNo.destroy();

  g.document = prevDoc;
});

test('Changed files: the hero counts repo files only, scratchpad gets its own row', async () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const cardBy = (container: any, title: string) =>
    findByClass(container, 'card').find((c: any) =>
      findByClass(c, 'wtitle').some((t: any) => (t.textContent ?? '').startsWith(title)),
    );
  const mount = async (files: string[], scratch: string[]) => {
    const container = g.document.createElement();
    const view = createGraph(container, drivableState(snapWithTurns([makeTurn(1)])), {
      loading: true,
      loadFiles: async () => ({
        roots: ['~/proj'],
        origin: { kind: 'commits' as const, commits: 1 },
        files: files.map((p, i) => ({ path: `~/proj/${p}`, at: 1000 + i, commit: 'aaa1111' })),
        scratch: scratch.map((p, i) => ({ path: p, at: 2000 + i, commit: null })),
        artifacts: [],
      }),
    });
    view.goLive();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    return { card: cardBy(container, 'Changed files'), view };
  };

  // Mixed: two repo files, three scratchpad temporaries. The hero says 2, never 5 — a scratchpad
  // prototype is not work on the project, and a mixed total is the defect this fixes.
  const mix = await mount(
    ['src/a.ts', 'src/b.ts'],
    ['~scratch/p/proto.ts', '~scratch/p/probe.mjs', '~scratch/p/out.log'],
  );
  assert.equal(textOf(findByClass(mix.card, 'num')[0]).replace(/\s/g, ''), '2files', 'hero excludes the scratchpad');
  assert.equal(findByClass(mix.card, 'fchgbar').length, 1, 'bars describe repo files only (one .ts kind)');
  const scr = findByClass(mix.card, 'fchgscr');
  assert.equal(scr.length, 1, 'one scratchpad row');
  assert.ok(textOf(scr[0]).includes('3'), `the row names the count, got: ${textOf(scr[0])}`);
  mix.view.destroy();

  // Scratchpad ONLY — measured on real sessions as the max case (100% of a card's files). The card
  // must not claim "no file changes": there were changes, none of them to the repo.
  const only = await mount([], ['~scratch/p/proto.ts']);
  assert.equal(findByClass(only.card, 'num').length, 0, 'no hero when git has nothing to show');
  assert.equal(findByClass(only.card, 'fchgscr').length, 1, 'the scratchpad row still shows');
  assert.equal(findByClass(only.card, 'fchgbar').length, 0, 'no repo bars');
  only.view.destroy();

  g.document = prevDoc;
});

test('Changed files drawer: group headings appear only when both groups are on screen', async () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const cardBy = (container: any, title: string) =>
    findByClass(container, 'card').find((c: any) =>
      findByClass(c, 'wtitle').some((t: any) => (t.textContent ?? '').startsWith(title)),
    );
  const openDrawerFor = async (files: string[], scratch: string[]) => {
    const container = g.document.createElement();
    const view = createGraph(container, drivableState(snapWithTurns([makeTurn(1)])), {
      loading: true,
      loadFiles: async () => ({
        roots: ['~/proj'],
        origin: { kind: 'commits' as const, commits: 1 },
        files: files.map((p, i) => ({ path: `~/proj/${p}`, at: 1000 + i, commit: 'aaa1111' })),
        scratch: scratch.map((p, i) => ({ path: p, at: 2000 + i, commit: null })),
        artifacts: [],
      }),
    });
    view.goLive();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    findByClass(cardBy(container, 'Changed files'), 'xbtn')[0].onclick();
    return { container, view, drawer: findByClass(container, 'drawer')[0] };
  };

  // Both groups present: one heading each, project first.
  const mix = await openDrawerFor(['src/a.ts'], ['~scratch/p/proto.log']);
  assert.deepEqual(
    findByClass(mix.drawer, 'fchggrp').map((h: any) => textOf(h)),
    ['Project · 1', 'Scratchpad · 1'],
  );

  // A type filter that leaves only one group on screen: a lone heading names a separation that
  // is not there. The headings track what is DISPLAYED, not what the session contains.
  const chips = findByClass(mix.drawer, 'tchip');
  const logChip = chips.find((c: any) => textOf(c).startsWith('log'));
  assert.ok(logChip, 'the drawer offers a .log type chip');
  logChip.onclick();
  assert.equal(findByClass(mix.drawer, 'fchggrp').length, 0, 'filtered down to scratchpad alone: no heading');
  mix.view.destroy();
  g.document = prevDoc;
});

test('Changed files: published pages get their own row, and their links in the drawer', async () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const cardBy = (container: any, title: string) =>
    findByClass(container, 'card').find((c: any) =>
      findByClass(c, 'wtitle').some((t: any) => (t.textContent ?? '').startsWith(title)),
    );
  const PAGE = 'https://claude.ai/code/artifact/11111111-2222-4333-8444-555555555555';
  const OTHER = 'https://claude.ai/code/artifact/99999999-8888-4777-8666-555555555555';
  const mount = async (artifacts: any[], files: string[] = ['src/a.ts'], scratch = ['~scratch/p/proto.html']) => {
    const container = g.document.createElement();
    const view = createGraph(container, drivableState(snapWithTurns([makeTurn(1)])), {
      loading: true,
      loadFiles: async () => ({
        roots: ['~/proj'],
        // Faithful to what the server builds: `commits` origin only when a commit delivered a file.
        origin: files.length ? ({ kind: 'commits', commits: 1 } as const) : ({ kind: 'none' } as const),
        files: files.map((p, i) => ({ path: `~/proj/${p}`, at: 1000 + i, commit: 'aaa1111' })),
        scratch: scratch.map((p, i) => ({ path: p, at: 2000 + i, commit: null })),
        artifacts,
      }),
    });
    view.goLive();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    return { container, view, card: cardBy(container, 'Changed files') };
  };

  // The hero stays the repo files: a page put online is not a file this session changed. The two
  // pages get a row of their own, under the scratchpad one.
  const two = await mount([
    { url: PAGE, label: 'Where should a session note live?', path: '~scratch/p/proto.html', at: 3000 },
    { url: OTHER, label: 'NOW — the four states', path: '~scratch/p/now.html', at: 2500 },
  ]);
  assert.equal(textOf(findByClass(two.card, 'num')[0]).replace(/\s/g, ''), '1file', 'the hero ignores the pages');
  const row = findByClass(two.card, 'fchgart');
  assert.equal(row.length, 1, 'one published-artifacts row');
  assert.ok(textOf(row[0]).includes('2 published artifacts'), `row names the count, got: ${textOf(row[0])}`);

  // The drawer carries the URL as a real link — the whole point of keeping the row: the HTML it was
  // built from is a temporary, the link is what still answers a month later.
  findByClass(two.card, 'xbtn')[0].onclick();
  const drawer = findByClass(two.container, 'drawer')[0];
  const links = findByClass(drawer, 'fchgaurl');
  assert.deepEqual(
    links.map((a: any) => a.href),
    [PAGE, OTHER],
    'both pages linked, newest first',
  );
  assert.ok(
    findByClass(drawer, 'fchgalbl').some((l: any) => textOf(l) === 'Where should a session note live?'),
    'the row is named by the publish description',
  );
  two.view.destroy();

  // A session whose ONLY delivery is a page: the file list is empty because there are no files,
  // not because a filter hid them. Saying "No files match the filters" there blames a filter the
  // reader never set — the defect the waiting state already exists to avoid.
  const pageOnly = await mount(
    [{ url: PAGE, label: 'A page and nothing else', path: '~scratch/p/proto.html', at: 3000 }],
    [],
    [],
  );
  findByClass(pageOnly.card, 'fchgart')[0].onclick();
  const pageDrawer = findByClass(pageOnly.container, 'drawer')[0];
  const empty = findByClass(pageDrawer, 'wdesc').map((d: any) => textOf(d));
  assert.ok(!empty.includes('No files match the filters.'), `no filter was set, got: ${empty.join(' | ')}`);
  assert.ok(
    empty.includes('Nothing committed in this session.'),
    `expected the set to be named, got: ${empty.join(' | ')}`,
  );
  assert.equal(findByClass(pageDrawer, 'fchgaurl').length, 1, 'the page is still listed');
  pageOnly.view.destroy();

  // A session that published nothing says nothing: no row, no third KPI tile.
  const none = await mount([]);
  assert.equal(findByClass(none.card, 'fchgart').length, 0, 'silent without a publish');
  findByClass(none.card, 'xbtn')[0].onclick();
  const bare = findByClass(none.container, 'drawer')[0];
  assert.equal(findByClass(bare, 'fchgaurl').length, 0, 'no links in the drawer either');
  assert.equal(findByClass(bare, 'kpi').length, 2, 'the KPI row keeps its two tiles');
  none.view.destroy();

  g.document = prevDoc;
});

test('Main tools Expand all: a failed tool row is badged', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = snapWithTurns([makeTurn(1)]);
  snap.mainTools = [
    { id: 'toolu_1', name: 'Read', ms: 90, arg: 'src/app.ts', ctx: 4200, turnIndex: 1 },
    { id: 'toolu_2', name: 'Edit', ms: 12, arg: 'src/x.ts', ctx: 80, turnIndex: 1, error: true },
  ];
  const state = drivableState(snap);
  const view = createGraph(container, state);

  // The tools card's own Expand all (its xbtn), not the Live activity one.
  const toolsCard = findByClass(container, 'card').find((c: any) =>
    findByClass(c, 'wtitle').some((t: any) => t.textContent === 'Main tools'),
  );
  findByClass(toolsCard, 'xbtn')[0].onclick();

  const drawer = findByClass(container, 'drawer')[0];
  const errRows = findByClass(drawer, 'ttrow').filter((r: any) => r.classList.contains('err'));
  assert.equal(errRows.length, 1, 'the failed Edit is the only err row');
  assert.ok(textOf(findByClass(errRows[0], 'tn')[0]).includes('Edit'));
  assert.equal(findByClass(errRows[0], 'terr').length, 1, 'the row carries the error badge');

  view.destroy();
  g.document = prevDoc;
});

// The tools card's own Expand all (its xbtn), not the Live activity one.
const toolsExpandBtn = (container: any) => {
  const card = findByClass(container, 'card').find((c: any) =>
    findByClass(c, 'wtitle').some((t: any) => t.textContent === 'Main tools'),
  );
  return findByClass(card, 'xbtn')[0];
};

test('Main tools Expand all: rows carry a dense #N fixed in call order, not the sort order', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = snapWithTurns([makeTurn(1)]);
  // Appearance order, deliberately NOT size order: a number taken after the sort would read 1,2,3
  // top-down whatever the list did, which is exactly the bug that cannot be caught by a fixture
  // where the two orders agree.
  snap.mainTools = [
    { id: 'toolu_1', name: 'Read', ms: 90, arg: 'a.ts', ctx: 100, turnIndex: 1 },
    { id: 'toolu_2', name: 'Grep', ms: 10, arg: 'b.ts', ctx: 9000, turnIndex: 1 },
    { id: 'toolu_3', name: 'Bash', ms: 50, arg: 'bun test', ctx: 500, turnIndex: 1 },
  ];
  const view = createGraph(container, drivableState(snap));
  toolsExpandBtn(container).onclick();

  const drawer = findByClass(container, 'drawer')[0];
  const named = () =>
    findByClass(drawer, 'ttrow').map((r: any) => [
      textOf(findByClass(r, 'tnum')[0]),
      textOf(findByClass(r, 'tn')[0]).replace(/^#\d+/, '').trim().split(' ')[0],
    ]);

  // Default sort is by size: Grep (9000) first, but it is still the SECOND call made.
  assert.deepEqual(
    named(),
    [
      ['#2', 'Grep'],
      ['#3', 'Bash'],
      ['#1', 'Read'],
    ],
    'numbers follow the order the calls happened, the rows follow the size ranking',
  );

  // Re-sorting by time reorders the rows and moves no number.
  findByClass(drawer, 'tsort')[0].onclick();
  assert.deepEqual(
    named(),
    [
      ['#1', 'Read'],
      ['#3', 'Bash'],
      ['#2', 'Grep'],
    ],
    'time ↓ reorders the rows; #N is unchanged',
  );

  view.destroy();
  g.document = prevDoc;
});

test('Main tools Expand all: turn groups keep the size ranking inside, and total the turn', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = snapWithTurns([makeTurn(1), makeTurn(2)]);
  snap.mainTools = [
    { id: 'toolu_1', name: 'Read', ms: 90, arg: 'a.ts', ctx: 1000, turnIndex: 1 },
    { id: 'toolu_2', name: 'Grep', ms: 10, arg: 'b.ts', ctx: 3000, turnIndex: 1 },
    { id: 'toolu_3', name: 'Bash', ms: 50, arg: 'bun test', ctx: 500, turnIndex: 2 },
  ];
  const view = createGraph(container, drivableState(snap));
  toolsExpandBtn(container).onclick();
  const drawer = findByClass(container, 'drawer')[0];

  assert.deepEqual(
    turnGroupsOf(container).map((x: any) => [x.label, x.meta, x.open, x.rows]),
    [
      ['Turn 1', '2 calls · 4kch', false, 0],
      ['Turn 2', '1 call · 500ch', true, 1],
    ],
    'a group per turn, each carrying its own call count and output total',
  );

  // Inside the group the ranking survives — that is what this drawer is for.
  turnGroupsOf(container)[0]!.toggle();
  const firstGroup = findByClass(drawer, 'tgroup')[0];
  assert.deepEqual(
    findByClass(firstGroup, 'ttrow').map(
      (r: any) => textOf(findByClass(r, 'tn')[0]).replace(/^#\d+/, '').trim().split(' ')[0],
    ),
    ['Grep', 'Read'],
    'biggest first within the turn',
  );

  // A tool call the transcript could not attribute to a turn still has to be reachable.
  view.destroy();
  g.document = prevDoc;
});

test('Main tools Expand all: a call with no turn groups on its own, ahead of turn 1', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = snapWithTurns([makeTurn(1)]);
  snap.mainTools = [
    { id: 'toolu_0', name: 'Read', ms: 5, arg: 'early.ts', ctx: 10, turnIndex: null },
    { id: 'toolu_1', name: 'Bash', ms: 90, arg: 'bun test', ctx: 200, turnIndex: 1 },
  ];
  const view = createGraph(container, drivableState(snap));
  toolsExpandBtn(container).onclick();

  const groups = turnGroupsOf(container);
  assert.deepEqual(
    groups.map((x: any) => x.label),
    ['Before the first entry', 'Turn 1'],
    'the unattributed call gets its own group, before the first turn',
  );
  groups[0]!.toggle();
  assert.equal(findByClass(findByClass(container, 'drawer')[0], 'tgroup')[0].children.length, 2, 'its row is built');

  view.destroy();
  g.document = prevDoc;
});

test('all-activity drawer: the filter narrows the list and reports the count', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const state = drivableState(snapWithTurns([makeTurn(1)]));
  const view = createGraph(container, state);

  // The span store opens a turn on the prompt — without it every later span is dropped.
  state.emit(
    {
      type: 'user-turn',
      prompt: 'harden the retry path',
      command: null,
      timestamp: '2026-07-14T09:59:59Z',
      agentId: null,
    },
    1,
  );

  state.emit(toolStart('t1', 'Read', '2026-07-14T10:00:00Z'), 1);
  state.emit(toolStart('t2', 'Grep', '2026-07-14T10:00:01Z'), 1);
  state.emit(toolStart('t3', 'Bash', '2026-07-14T10:00:02Z'), 1);

  liveExpandBtn(container).onclick();
  const drawer = findByClass(container, 'drawer')[0];
  const input = findByClass(drawer, 'tfilter')[0];
  input.value = 'gre';
  input.oninput();
  assert.deepEqual(
    activityNames(container).map((n: string) => n.trim()),
    ['Grep'],
    'only the matching row survives',
  );
  assert.equal(findByClass(drawer, 'tcount2')[0].textContent, '1 of 3 activities');

  input.value = 'nothing-matches';
  input.oninput();
  assert.equal(findByClass(drawer, 'ttrow').length, 0, 'no rows');
  assert.ok(
    findByClass(drawer, 'wdesc').some((d: any) => d.textContent.includes('No activity matches')),
    'empty state explains why',
  );

  view.destroy();
  g.document = prevDoc;
});

test('all-activity drawer: a span with no duration reads "—", never "running…"', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const state = drivableState(snapWithTurns([makeTurn(1)]));
  const view = createGraph(container, state);

  state.emit(
    {
      type: 'user-turn',
      prompt: 'harden the retry path',
      command: null,
      timestamp: '2026-07-14T09:59:59Z',
      agentId: null,
    },
    1,
  );
  // An API call whose latency could not be measured closes at its own t0 (t1 === t0) with
  // status 'ok'. It has no duration to report — but "no duration" is not "still running",
  // and reading the one as the other made finished rows claim to be in flight.
  state.emitCtx(usageEvt('msg_1', '2026-07-14T10:00:00Z'), { turnIndex: 1, label: 'analyze this', newCall: true });

  liveExpandBtn(container).onclick();
  const callRow = findByClass(findByClass(container, 'drawer')[0], 't-api')[0];
  assert.ok(callRow, 'the API-call row is in the list');
  const dur = textOf(findByClass(callRow, 'tv')[0]);
  assert.ok(!dur.includes('running'), `a finished call must not read as running (got "${dur}")`);
  assert.equal(dur.trim(), '—');

  view.destroy();
  g.document = prevDoc;
});

test('all-activity drawer: selecting a turn scopes the list to that turn', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const state = drivableState(snapWithTurns([makeTurn(1), makeTurn(2)]));
  const view = createGraph(container, state);

  state.emit(
    { type: 'user-turn', prompt: 'first ask', command: null, timestamp: '2026-07-14T10:00:00Z', agentId: null },
    1,
  );
  state.emit(toolStart('t1', 'Read', '2026-07-14T10:00:01Z'), 1);
  state.emit(
    { type: 'user-turn', prompt: 'second ask', command: null, timestamp: '2026-07-14T10:01:00Z', agentId: null },
    2,
  );
  state.emit(toolStart('t2', 'Bash', '2026-07-14T10:01:01Z'), 2);
  state.emit(toolStart('t3', 'Grep', '2026-07-14T10:01:02Z'), 2);

  liveExpandBtn(container).onclick();
  // Unscoped the list is grouped by turn and only the latest group is open, so turn 1's tool has
  // to be expanded before it can be counted.
  turnGroupsOf(container)[0]!.toggle();
  assert.equal(activityNames(container).length, 3, "unscoped: both turns' tools, no prompt rows");
  findByClass(container, 'close')[0].onclick();

  selectTurnViaStrip(container, 1); // turn 2
  liveExpandBtn(container).onclick();
  const names = activityNames(container).map((n: string) => n.trim());
  assert.equal(names.length, 2, 'scoped to turn 2: its two tools');
  assert.ok(
    names.some((n: string) => n.includes('Bash')) && names.some((n: string) => n.includes('Grep')),
    'turn 2 activities present',
  );
  assert.ok(!names.some((n: string) => n.includes('Read')), 'turn 1 activity does not leak in');

  view.destroy();
  g.document = prevDoc;
});

test('all-activity drawer: drilling into a row leaves a breadcrumb back to the list', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const state = drivableState(snapWithTurns([makeTurn(1)]));
  const view = createGraph(container, state);

  state.emit(
    { type: 'user-turn', prompt: 'first ask', command: null, timestamp: '2026-07-14T10:00:00Z', agentId: null },
    1,
  );
  state.emit(toolStart('t1', 'Read', '2026-07-14T10:00:01Z'), 1);

  liveExpandBtn(container).onclick();
  const drawer = findByClass(container, 'drawer')[0];
  // The list REPLACES the drawer's content, so a drill-down with no way back strands the
  // user: they must reopen the list and re-find their place. Same contract as 'all tools'.
  findByClass(drawer, 't-tool')[0].onclick();
  const crumb = findByClass(drawer, 'crumb-link')[0];
  assert.ok(crumb, 'a breadcrumb is rendered after drilling into a row');
  assert.equal(crumb.textContent, 'all activity');

  crumb.onclick();
  assert.ok(findByClass(drawer, 'ttrow').length > 0, 'clicking the crumb returns to the list');

  view.destroy();
  g.document = prevDoc;
});

test('all-activity drawer: each row shows a chronological #N number, stable across sort', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const state = drivableState(snapWithTurns([makeTurn(1)]));
  createGraph(container, state);

  state.emit(
    { type: 'user-turn', prompt: 'first ask', command: null, timestamp: '2026-07-14T10:00:00Z', agentId: null },
    1,
  );
  state.emit(toolStart('t1', 'Read', '2026-07-14T10:00:01Z'), 1);
  state.emit(toolStart('t2', 'Grep', '2026-07-14T10:00:02Z'), 1);
  state.emit(toolStart('t3', 'Bash', '2026-07-14T10:00:03Z'), 1);

  liveExpandBtn(container).onclick();
  const drawer = findByClass(container, 'drawer')[0];

  const nums = (c: any) => findByClass(c, 'ttrow').map((r: any) => findByClass(r, 'tnum')[0]?.textContent ?? '');

  // Oldest-first: #1 Read, #2 Grep, #3 Bash.
  assert.deepEqual(nums(drawer), ['#1', '#2', '#3'], 'sequential numbers oldest-first');

  // After sorting newest-first the visible order reverses but the numbers stay chronological.
  findByClass(drawer, 'tsort')[0].onclick();
  assert.deepEqual(nums(drawer), ['#3', '#2', '#1'], 'numbers stay chronological in newest-first order');

  g.document = prevDoc;
});

test('all-activity drawer: one collapsible group per turn, only the latest open, none when scoped', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const state = drivableState(snapWithTurns([makeTurn(1), makeTurn(2)]));
  createGraph(container, state);

  state.emit(
    { type: 'user-turn', prompt: 'first ask', command: null, timestamp: '2026-07-14T10:00:00Z', agentId: null },
    1,
  );
  state.emit(toolStart('t1', 'Read', '2026-07-14T10:00:01Z'), 1);
  state.emit(
    { type: 'user-turn', prompt: 'second ask', command: null, timestamp: '2026-07-14T10:01:00Z', agentId: null },
    2,
  );
  state.emit(toolStart('t2', 'Bash', '2026-07-14T10:01:01Z'), 2);

  // Unscoped: two turns → two groups, labelled by work ordinal, each stating what it holds.
  liveExpandBtn(container).onclick();
  const drawer = findByClass(container, 'drawer')[0];
  assert.deepEqual(
    turnGroupsOf(container).map((x: any) => [x.label, x.meta, x.open, x.rows]),
    [
      ['Turn 1', '1 activity', false, 0],
      ['Turn 2', '1 activity', true, 1],
    ],
    'one group per turn; only the most recent starts open, and a collapsed one renders no rows',
  );

  // Toggling is what the header is FOR: it must both open a collapsed group and close an open one.
  turnGroupsOf(container)[0]!.toggle();
  assert.deepEqual(
    turnGroupsOf(container).map((x: any) => x.rows),
    [1, 1],
    'expanding turn 1 builds its row',
  );
  turnGroupsOf(container)[1]!.toggle();
  assert.deepEqual(
    turnGroupsOf(container).map((x: any) => [x.open, x.rows]),
    [
      [true, 1],
      [false, 0],
    ],
    'collapsing turn 2 throws its rows away again',
  );

  // Close and scope to turn 2 — a single group holding everything says nothing, so: no groups.
  findByClass(container, 'close')[0].onclick();
  selectTurnViaStrip(container, 1); // turn 2
  liveExpandBtn(container).onclick();
  assert.equal(findByClass(drawer, 'tgroup').length, 0, 'no groups when scoped to a single turn');
  assert.deepEqual(activityNames(container), ['Bash'], 'the scoped list is flat');

  g.document = prevDoc;
});

// Two turns, one tool each, and a third row back in turn 1 — so `t0` order is 1,2,1 and the naive
// "consecutive runs" grouping renders turn 1 twice. A subagent lane outliving its turn does this.
function twoTurnsInterleaved(container: any) {
  const state = drivableState(snapWithTurns([makeTurn(1), makeTurn(2)]));
  createGraph(container, state);
  state.emit(
    { type: 'user-turn', prompt: 'first ask', command: null, timestamp: '2026-07-14T10:00:00Z', agentId: null },
    1,
  );
  state.emit(toolStart('t1', 'Read', '2026-07-14T10:00:01Z'), 1);
  state.emit(
    { type: 'user-turn', prompt: 'second ask', command: null, timestamp: '2026-07-14T10:01:00Z', agentId: null },
    2,
  );
  state.emit(toolStart('t2', 'Bash', '2026-07-14T10:01:01Z'), 2);
  state.emit(toolStart('t3', 'Grep', '2026-07-14T10:02:00Z'), 1);
  return state;
}

test('all-activity drawer: a turn interleaved in time is ONE group, not two sharing a state', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  twoTurnsInterleaved(container);

  liveExpandBtn(container).onclick();
  assert.deepEqual(
    turnGroupsOf(container).map((x: any) => [x.label, x.meta]),
    [
      ['Turn 1', '2 activities'],
      ['Turn 2', '1 activity'],
    ],
    "turn 1's two rows land in one group, ordered by where the turn first appears",
  );

  // The bug this guards: two groups keyed by the same turn, where collapsing the second closes
  // the first on the next rebuild.
  turnGroupsOf(container)[0]!.toggle();
  findByClass(findByClass(container, 'drawer')[0], 'tsort')[0].onclick();
  // Newest-first leads with turn 1, whose Grep is the most recent row of all — the groups follow
  // the list's order, which is the whole point of ordering them by first appearance.
  assert.deepEqual(
    turnGroupsOf(container).map((x: any) => [x.label, x.open]),
    [
      ['Turn 1', true],
      ['Turn 2', true],
    ],
    'both stay open across the re-sort — one key, one group',
  );

  g.document = prevDoc;
});

test('all-activity drawer: opening while scoped to a turn does not seed the reader’s choice', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  twoTurnsInterleaved(container);

  // The drawer's FIRST open happens while scoped — the case that could seed the state with a turn
  // the reader never chose. Explore TOGGLES the strip, so it is opened once and the two selections
  // click a bar directly.
  openStrip(container);

  // Scope to turn 1 and open: the list is flat, so the reader has expressed nothing.
  clickBar(container, 0);
  liveExpandBtn(container).onclick();
  assert.equal(findByClass(findByClass(container, 'drawer')[0], 'tgroup').length, 0, 'scoped: no groups');
  findByClass(container, 'close')[0].onclick();

  // Back to the whole session: the default must still be "the most recent turn", not turn 1.
  clickBar(container, 0); // clicking the selected turn again clears the scope
  liveExpandBtn(container).onclick();
  assert.deepEqual(
    turnGroupsOf(container).map((x: any) => [x.label, x.open]),
    [
      ['Turn 1', false],
      ['Turn 2', true],
    ],
    'the scoped open left no trace: the latest turn is the open one',
  );

  g.document = prevDoc;
});

test('all-activity drawer: the default follows the latest turn until the reader touches a header', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const state = twoTurnsInterleaved(container);

  liveExpandBtn(container).onclick();
  assert.deepEqual(
    turnGroupsOf(container).map((x: any) => x.open),
    [false, true],
    'turn 2 is the open one',
  );
  findByClass(container, 'close')[0].onclick();

  // The session grows. Nobody has touched a header, so the newest turn must be the open one —
  // a default frozen at the first open would leave the live turn collapsed forever.
  state.emit(
    { type: 'user-turn', prompt: 'third ask', command: null, timestamp: '2026-07-14T10:03:00Z', agentId: null },
    3,
  );
  state.emit(toolStart('t4', 'Edit', '2026-07-14T10:03:01Z'), 3);
  liveExpandBtn(container).onclick();
  assert.deepEqual(
    turnGroupsOf(container).map((x: any) => [x.label, x.open]),
    [
      ['Turn 1', false],
      ['Turn 2', false],
      ['Entry 3', true],
    ],
    'the newest turn is open, the previously-open one is not',
  );

  g.document = prevDoc;
});

test('all-activity drawer: collapsing a group while filtering is not remembered', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  twoTurnsInterleaved(container);

  liveExpandBtn(container).onclick();
  const drawer = findByClass(container, 'drawer')[0];
  const filter = findByClass(drawer, 'tfilter')[0];

  // Filtering force-opens every group that matches; collapsing one there is about the filtered
  // list, not about the list underneath.
  filter.value = 'a'; // Read (turn 1) and Bash (turn 2), one match in each group
  filter.oninput();
  assert.deepEqual(
    turnGroupsOf(container).map((x: any) => x.open),
    [true, true],
    'a filter opens every matching group',
  );
  turnGroupsOf(container)[1]!.toggle(); // collapse turn 2 while filtering

  filter.value = '';
  filter.oninput();
  assert.deepEqual(
    turnGroupsOf(container).map((x: any) => [x.label, x.open]),
    [
      ['Turn 1', false],
      ['Turn 2', true],
    ],
    'clearing the filter restores the state the reader actually chose',
  );

  g.document = prevDoc;
});

test('all-activity drawer: a group the reader opened survives the drill-down and the crumb back', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const state = drivableState(snapWithTurns([makeTurn(1), makeTurn(2)]));
  createGraph(container, state);

  state.emit(
    { type: 'user-turn', prompt: 'first ask', command: null, timestamp: '2026-07-14T10:00:00Z', agentId: null },
    1,
  );
  state.emit(toolStart('t1', 'Read', '2026-07-14T10:00:01Z'), 1);
  state.emit(
    { type: 'user-turn', prompt: 'second ask', command: null, timestamp: '2026-07-14T10:01:00Z', agentId: null },
    2,
  );
  state.emit(toolStart('t2', 'Bash', '2026-07-14T10:01:01Z'), 2);

  liveExpandBtn(container).onclick();
  // Open turn 1, which is NOT the one open by default.
  turnGroupsOf(container)[0]!.toggle();
  assert.deepEqual(
    turnGroupsOf(container).map((x: any) => x.open),
    [true, true],
    'both groups are open before the drill-down',
  );

  // Drill into the row, then come back the way the drawer offers: the crumb.
  findByClass(findByClass(container, 'drawer')[0], 'ttrow')[0].onclick();
  const crumb = findByClass(container, 'crumb-link')[0];
  assert.equal(textOf(crumb), 'all activity', 'the drill-down offers the way back');
  crumb.onclick();

  // Rebuilding the list must not close what the reader opened — on a real session that means
  // hunting for the group again among dozens.
  assert.deepEqual(
    turnGroupsOf(container).map((x: any) => [x.label, x.open]),
    [
      ['Turn 1', true],
      ['Turn 2', true],
    ],
    'the expansion survives the round trip',
  );

  g.document = prevDoc;
});

test('all-activity drawer: the group states survive a re-sort, and filtering opens every match', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const state = drivableState(snapWithTurns([makeTurn(1), makeTurn(2)]));
  createGraph(container, state);

  state.emit(
    { type: 'user-turn', prompt: 'first ask', command: null, timestamp: '2026-07-14T10:00:00Z', agentId: null },
    1,
  );
  state.emit(toolStart('t1', 'Read', '2026-07-14T10:00:01Z'), 1);
  state.emit(
    { type: 'user-turn', prompt: 'second ask', command: null, timestamp: '2026-07-14T10:01:00Z', agentId: null },
    2,
  );
  state.emit(toolStart('t2', 'Bash', '2026-07-14T10:01:01Z'), 2);

  liveExpandBtn(container).onclick();
  const drawer = findByClass(container, 'drawer')[0];

  // Re-sorting rebuilds the list: the groups must follow the new ORDER and keep who was open.
  findByClass(drawer, 'tsort')[0].onclick();
  assert.deepEqual(
    turnGroupsOf(container).map((x: any) => [x.label, x.open]),
    [
      ['Turn 2', true],
      ['Turn 1', false],
    ],
    'newest-first puts the latest turn first and keeps its open state',
  );

  // A match inside a collapsed group would read as no match at all.
  const filter = findByClass(drawer, 'tfilter')[0];
  filter.value = 'read';
  filter.oninput();
  assert.deepEqual(
    turnGroupsOf(container).map((x: any) => [x.label, x.open, x.rows]),
    [['Turn 1', true, 1]],
    'only the matching turn survives the filter, and it is open',
  );

  g.document = prevDoc;
});

// ---- the live intent (NOW) panel ----

const narr = (text: string, ts = '2026-07-21T10:00:00.000Z') => ({ ts, text });

test('now panel: a live turn shows the latest intent, no stream (V1)', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = snapWithTurns([
    makeTurn(1, {
      state: 'live',
      result: null,
      lastNarration: narr('doing the fourth thing now'),
    }),
  ]);
  const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });

  const panel = findByClass(container, 'nowpanel')[0];
  assert.ok(panel && !panel.classList.contains('hidden'), 'panel is visible on a live turn with narration');
  assert.equal(textOf(findByClass(container, 'nowlbl')[0]), 'now', 'the live label reads "now"');
  assert.equal(
    textOf(findByClass(container, 'nowtext')[0]),
    'doing the fourth thing now',
    'latest narration is the current intent',
  );

  // V1: no stream of previous intents.
  assert.equal(findByClass(container, 'nowprev').length, 0, 'V1 renders no stream container');
  assert.equal(findByClass(container, 'np').length, 0, 'V1 renders no previous-intent rows');

  view.destroy();
  g.document = prevDoc;
});

test('now panel: a turn that has narrated nothing, has no output, and is not live is hidden', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = snapWithTurns([makeTurn(1, { state: 'done', lastNarration: null, result: null })]);
  const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });

  const panel = findByClass(container, 'nowpanel')[0];
  assert.ok(panel.classList.contains('hidden'), 'no narration + no output + not live → panel hidden');

  view.destroy();
  g.document = prevDoc;
});

test('now panel: a finished turn shows its final OUTPUT (over the last narration), labelled output', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  // Both a narration and a final result are present: the output wins.
  const snap = snapWithTurns([
    makeTurn(1, {
      state: 'done',
      lastNarration: narr('the last thing it was doing'),
      result: 'Done — the retry path backs off and the suite is green.',
    }),
  ]);
  const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });

  assert.equal(textOf(findByClass(container, 'nowlbl')[0]), 'output', 'a turn with a final answer reads "output"');
  assert.equal(
    textOf(findByClass(container, 'nowtext')[0]),
    'Done — the retry path backs off and the suite is green.',
    'the final output is shown, not the penultimate narration',
  );

  view.destroy();
  g.document = prevDoc;
});

test('now panel: an interrupted turn (no output) falls back to its last intent, labelled intent', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = snapWithTurns([
    makeTurn(1, { state: 'interrupted', result: null, lastNarration: narr('the last thing it said') }),
  ]);
  const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });

  const panel = findByClass(container, 'nowpanel')[0];
  assert.ok(!panel.classList.contains('hidden'), 'panel visible for a past turn with a narration and no output');
  assert.equal(textOf(findByClass(container, 'nowlbl')[0]), 'intent', 'no output + not live reads "intent"');
  assert.equal(textOf(findByClass(container, 'nowtext')[0]), 'the last thing it said');

  view.destroy();
  g.document = prevDoc;
});

// ---- pending prompt: the session is stopped on the user ----
// The signal comes from the roster poll, not the event stream — nothing is written to the
// transcript while a prompt is pending — so these drive setWaiting() directly, as app.ts does.
// The panel repaint is coalesced (scheduleRender), so the assertions wait one tick for it.
const repaint = () => new Promise((r) => setTimeout(r, 1));

test('waiting: the NOW panel names the tool the session is stopped on, and ages it', async () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = snapWithTurns([makeTurn(1, { state: 'live', result: null, lastNarration: narr('checking the site') })]);
  const state = drivableState(snap);
  const view = createGraph(container, state);
  view.goLive();
  // The tool_use line lands BEFORE the dialog is raised, so the pending tool is in the feed.
  state.emitCtx(
    { type: 'tool-start', id: 'tu1', name: 'Bash', timestamp: '2026-07-14T10:00:00Z', agentId: null },
    { turnIndex: 1, label: 'curl https://example.com' },
  );

  view.setWaiting('permission', Date.now() - 65_000);
  await repaint();
  const panel = findByClass(container, 'nowpanel')[0];
  assert.equal(panel.classList.contains('waiting'), true, 'the panel goes amber');
  assert.equal(textOf(findByClass(container, 'nowlbl')[0]), 'waiting for you');
  assert.equal(
    textOf(findByClass(container, 'nowtext')[0]),
    'Waiting for your approval — Bash · curl https://example.com',
    'it says what it is waiting to approve, not just that it waits',
  );
  assert.match(
    textOf(findByClass(container, 'nowage')[0]),
    /1m/,
    'ages from when it stopped, not from when we noticed',
  );

  // Answered: the panel goes back to reporting the agent, on its own.
  view.setWaiting(null, null);
  await repaint();
  assert.equal(findByClass(container, 'nowpanel')[0].classList.contains('waiting'), false);
  assert.equal(textOf(findByClass(container, 'nowtext')[0]), 'checking the site');

  view.destroy();
  g.document = prevDoc;
});

test('waiting: an AskUserQuestion-style block asks for an answer, not an approval', async () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const view = createGraph(container, drivableState(baseSnapshot()));
  view.goLive();
  view.setWaiting('input', null);
  await repaint();
  assert.equal(
    textOf(findByClass(container, 'nowtext')[0]),
    'Waiting for your answer in the terminal',
    'no pending tool in the feed → it still says what it needs',
  );
  assert.equal(textOf(findByClass(container, 'nowage')[0]), '', 'no start instant → no invented age');
  view.destroy();
  g.document = prevDoc;
});

test('waiting: the toast announces the transition ONCE, however often the poll repeats it', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const state = drivableState(baseSnapshot());
  const view = createGraph(container, state);
  view.goLive();
  state.emitCtx(
    { type: 'tool-start', id: 'tu1', name: 'Bash', timestamp: '2026-07-14T10:00:00Z', agentId: null },
    { turnIndex: null, label: 'rm -rf build' },
  );

  view.setWaiting('permission', null);
  view.setWaiting('permission', null); // the 3s poll says the same thing again
  const rail = rails(container).tools;
  const pending = rail.children.filter((t: any) => findByClass(t, 'tkind')[0]?.textContent === 'pending');
  assert.equal(pending.length, 1, 'one announce, not one per poll');
  assert.equal(findByClass(pending[0], 'tname')[0].textContent, 'Waiting for your approval');
  assert.equal(findByClass(pending[0], 'targ2')[0].textContent, 'Bash · rm -rf build');
  assert.equal(pending[0].classList.contains('v-warn'), true, 'amber, like every announce that is not critical');

  view.destroy();
  g.document = prevDoc;
});

test('waiting: nothing is announced before the replay hands off to live', () => {
  // A tab opened on a session that is ALREADY waiting replays its history first. Toasting
  // there would fire into a loader the user is still staring at.
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const view = createGraph(container, drivableState(baseSnapshot()), { loading: true });
  view.setWaiting('permission', null);
  assert.equal(rails(container).tools.children.length, 0, 'no toast during replay');
  view.destroy();
  g.document = prevDoc;
});

test('waiting: a turn the user selected is not hijacked by a live prompt', async () => {
  // The badge on the tab still says the session is blocked; the panel keeps showing the
  // turn that was asked for.
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = snapWithTurns([
    makeTurn(1, { state: 'done', result: 'the first answer', lastNarration: null }),
    makeTurn(2, { state: 'live', result: null, lastNarration: narr('working') }),
  ]);
  const view = createGraph(container, drivableState(snap));
  view.goLive();
  selectTurnViaStrip(container, 0);
  view.setWaiting('permission', null);
  await repaint();
  assert.equal(findByClass(container, 'nowpanel')[0].classList.contains('waiting'), false);
  assert.equal(textOf(findByClass(container, 'nowtext')[0]), 'the first answer');
  view.destroy();
  g.document = prevDoc;
});

test('now panel: an answer that is only a fence keeps its text; markers-only says (no text)', async () => {
  // The bug this covers reached the screen: a pasted `/seedeep status` — one fence, nothing else —
  // left the panel drawing its two quote marks around an empty string.
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = snapWithTurns([
    makeTurn(1, { state: 'done', result: '```\nseedeep 0.13.0\nServer  running\n```', lastNarration: null }),
    makeTurn(2, { state: 'done', result: '```\n\n```', lastNarration: null }),
  ]);
  const view = createGraph(container, drivableState(snap));
  view.goLive();
  const nowtext = () => findByClass(container, 'nowtext')[0];

  // The strip is opened ONCE — Explore toggles it, so a second call would close it again.
  selectTurnViaStrip(container, 0);
  await repaint();
  assert.equal(textOf(nowtext()), 'seedeep 0.13.0 Server running');
  assert.equal(nowtext().classList.contains('empty'), false, 'there is something to quote');

  // An EMPTY fence really has nothing in it — the panel names that instead of showing a blank box,
  // and `.empty` is what takes the quote marks away.
  clickBar(container, 1);
  await repaint();
  assert.equal(textOf(nowtext()), '(no text)');
  assert.ok(nowtext().classList.contains('empty'), 'the class the stylesheet keeps for it');
  view.destroy();
  g.document = prevDoc;
});

// ─── the post-turn verdict announce ─────────────────────────────────────
// A crit turn is announced when it CLOSES. Two ways that used to go wrong: the announce
// read "the last non-live WORK turn" instead of the turn that just ended, and nothing
// remembered what had already been announced.

const verdictToasts = (container: any) =>
  rails(container).tools.children.filter((t: any) => findByClass(t, 'tkind')[0]?.textContent === 'verdict');

test('verdict announce: a crit turn is announced once, and a later command turn does not re-announce it', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  // Turn 1 is crit (compaction on a work turn). Turn 2 is a /clear — kind 'context', which
  // DOES write a system/turn_duration line of its own (measured on the real corpus).
  const t1 = makeTurn(1, { compaction: true } as any);
  const t2 = makeTurn(2, { kind: 'context', command: 'clear' } as any);
  const state = drivableState(snapWithTurns([t1]));
  const view = createGraph(container, state);
  view.goLive();

  state.emit({ type: 'turn-end', agentId: null, timestamp: '2026-07-14T10:01:00Z', durationMs: 1000, messageCount: 3 });
  assert.equal(verdictToasts(container).length, 1, 'the crit turn announces once when it closes');
  assert.match(findByClass(verdictToasts(container)[0], 'tname')[0].textContent, /#1/);

  state.setSnapshot(snapWithTurns([t1, t2]));
  state.emit({ type: 'turn-end', agentId: null, timestamp: '2026-07-14T10:02:00Z', durationMs: 500, messageCount: 1 });
  assert.equal(
    verdictToasts(container).length,
    1,
    'the /clear turn is not a work turn — turn #1 is not announced twice',
  );

  view.destroy();
  g.document = prevDoc;
});

test('verdict announce: a clean turn closing after a crit one announces nothing', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const t1 = makeTurn(1, { compaction: true } as any);
  const t2 = makeTurn(2);
  const state = drivableState(snapWithTurns([t1, t2]));
  const view = createGraph(container, state);
  view.goLive();

  state.emit({ type: 'turn-end', agentId: null, timestamp: '2026-07-14T10:02:00Z', durationMs: 500, messageCount: 1 });
  assert.equal(verdictToasts(container).length, 0, 'the turn that just ended is clean — the older crit one is history');

  view.destroy();
  g.document = prevDoc;
});

// ─── the verdict on the Timeline and in the scope banner ───────────────
// Before this, a flagged turn's findings were reachable ONLY by discovering the Waste chip
// inside the strip, and `warn` had no surface at all — it was computed and thrown away.

test('verdict: the scoped turn carries its verdict, and the chip opens the Verdict lens on it', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = snapWithTurns([makeTurn(1, { compaction: true } as any), makeTurn(2)]);
  const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });

  selectTurnViaStrip(container, 1); // a clean turn says nothing
  assert.equal(findByClass(container, 'sbverdict').length, 0, 'no chip on a turn with no finding');

  clickBar(container, 0); // the crit turn
  const chip = findByClass(container, 'sbverdict')[0];
  assert.ok(chip, 'the flagged turn states its verdict in the banner');
  assert.match(textOf(chip), /compaction mid-turn/);
  assert.equal(chip.classList.contains('crit'), true);

  chip.onclick({ stopPropagation: () => {} });
  const rows = findByClass(container, 'wrow');
  assert.equal(rows.length, 2, 'the lens covers every work turn, not only the flagged ones');
  assert.equal(rows[0].classList.contains('open'), true, 'the scoped turn arrives already expanded');
  assert.match(textOf(findByClass(rows[0], 'wwhat')[0]), /compaction mid-turn/);
  assert.equal(rows[1].classList.contains('good'), true, 'a clean turn is a result, not a blank');
  assert.match(textOf(findByClass(rows[1], 'ws')[0]), /nothing flagged/);

  view.destroy();
  g.document = prevDoc;
});

test('verdict: a clean turn states the practice it followed, and does not repeat it on expand', () => {
  // The second face. Before this the lens listed flagged turns only, so a turn that did the
  // documented thing — ran a check before committing, delegated the exploration, had its work
  // reviewed — was indistinguishable from one that did nothing. It now leads the row; a body
  // that echoed the same sentence made expanding the row mean nothing.
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = snapWithTurns([makeTurn(1)]);
  snap.mainTools = [
    { id: 'e1', name: 'Edit', ms: 1, arg: '/repo/src/a.ts', ctx: 0, turnIndex: 1 },
    { id: 'b1', name: 'Bash', ms: 1, arg: 'bun test', ctx: 0, turnIndex: 1 },
    { id: 'b2', name: 'Bash', ms: 1, arg: 'git commit -m done', ctx: 0, turnIndex: 1 },
  ];
  const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });
  openStrip(container);
  findByClass(container, 'fchip')
    .find((c: any) => textOf(c).startsWith('Verdict'))!
    .onclick();

  const row = findByClass(container, 'wrow')[0];
  assert.equal(row.classList.contains('good'), true);
  assert.match(textOf(findByClass(row, 'ws')[0]), /check before committing/, 'the practice leads the row');
  assert.equal(findByClass(row, 'wfind').length, 0, 'nothing left to expand — the head already said it');
  assert.equal(textOf(findByClass(row, 'wchev')[0]), '', 'so the row does not offer a chevron');

  view.destroy();
  g.document = prevDoc;
});

test('verdict: the body holds only what the head does not already say', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  // #1 clean with nothing at all; #2 crit whose lead finding carries a cost (the body must keep
  // it — the cost is what the head cannot show); #3 clean with a second positive to expand.
  const snap = snapWithTurns([makeTurn(1), makeTurn(2, { compaction: true } as any), makeTurn(3)]);
  snap.mainTools = [
    { id: 'e3', name: 'Edit', ms: 1, arg: '/repo/src/a.ts', ctx: 0, turnIndex: 3 },
    { id: 'x3', name: 'Bash', ms: 1, arg: 'bun test', ctx: 0, turnIndex: 3 },
    { id: 'c3', name: 'Bash', ms: 1, arg: 'git commit -m done', ctx: 0, turnIndex: 3 },
  ];
  (snap.turnList[2] as any).agentIds = ['a1'];
  snap.subagents = [
    {
      agentId: 'a1',
      agentType: 'code-reviewer',
      model: 'claude-sonnet-4-6',
      title: 'review the diff',
      turnIndex: 3,
      outLen: 100,
      volume: 1000,
      fill: 1000,
      window: 200000,
      pct: 1,
      estimated: false,
      state: 'done',
      startedAt: '2026-07-14T10:00:00Z',
      durationMs: 1000,
      tools: [],
    },
  ];
  const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });
  const rows = verdictRows(container);

  assert.equal(findByClass(rows[0], 'wfind').length, 0, 'a turn with nothing to report has no body');
  const critBody = findByClass(rows[1], 'wfind');
  assert.equal(critBody.length, 1, 'the lead finding stays: it carries the cost');
  assert.ok(findByClass(critBody[0], 'wcost')[0], 'and that is the cost');
  const cleanBody = findByClass(rows[2], 'wfind');
  assert.ok(cleanBody.length >= 1, 'the second practice is what expanding shows');
  for (const f of cleanBody)
    assert.notEqual(
      textOf(findByClass(f, 'wwhat')[0]),
      textOf(findByClass(rows[2], 'ws')[0]),
      'never the head sentence again',
    );

  view.destroy();
  g.document = prevDoc;
});

test('verdict: the lens shows warn turns too, tiered — not only crit', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  // #1 crit (compaction), #2 warn (a cold resume), #3 clean. Measured over 1950 real turns:
  // 15.3% crit, 7.9% warn — dropping warn hid one flagged turn in three.
  const snap = snapWithTurns([
    makeTurn(1, { compaction: true } as any),
    makeTurn(2, { firstCall: { cacheCreation: 200_000, fill: 210_000 } } as any),
    makeTurn(3),
  ]);
  const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });
  openStrip(container);

  const wasteChip = findByClass(container, 'fchip').find((c: any) => textOf(c).startsWith('Verdict'));
  assert.equal(textOf(wasteChip), 'Verdict 2', 'the chip counts the FLAGGED turns, crit and warn');
  wasteChip.onclick();

  const rows = findByClass(container, 'wrow');
  assert.equal(rows.length, 3, 'the list covers every work turn');
  assert.equal(rows[0].classList.contains('crit'), true);
  assert.equal(rows[1].classList.contains('warn'), true);
  assert.equal(rows[2].classList.contains('good'), true);
  assert.equal(textOf(findByClass(rows[1], 'wc')[0]), 'warn', 'the row states its own tier');
  // The underline follows the tier, so the chart cannot say "waste" about an Esc.
  const unders = findByClass(container, 'wunder');
  assert.equal(unders.length, 2);
  assert.equal(unders[1].classList.contains('warn'), true);

  view.destroy();
  g.document = prevDoc;
});

// Opens the Verdict lens and returns its rows, in turn order.
function verdictRows(container: any): any[] {
  openStrip(container);
  findByClass(container, 'fchip')
    .find((c: any) => textOf(c).startsWith('Verdict'))!
    .onclick();
  return findByClass(container, 'wrow');
}

test('verdict: a row shares ITS turn, whatever the banner is scoped into', async () => {
  // The defect this closes: Share lived only in the scope banner, so the turn you were READING
  // in the list and the turn the card was built for could be two different turns.
  const g = globalThis as any;
  const prevDoc = g.document,
    prevFetch = g.fetch;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = snapWithTurns([makeTurn(1, { compaction: true } as any), makeTurn(2), makeTurn(3)]);
  const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });

  verdictRows(container);
  clickBar(container, 0); // scope turn #1, the flagged one
  const rows = findByClass(container, 'wrow');
  assert.equal(rows.length, 3);
  for (const r of rows) assert.equal(findByClass(r, 'sbout-share').length, 1, 'every row carries its own Share');

  // The card is drawn by the page now, so what it was built FOR is read off the SVG the renderer
  // loads — which is stronger than the payload this used to intercept: it asserts what the image
  // ends up SAYING, not what a field held on the way there.
  let cardSvg = '';
  const prevImage = g.Image,
    realCreate = g.document.createElement;
  g.Image = class {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(v: string) {
      cardSvg = decodeURIComponent(v.replace(/^data:image\/svg\+xml;charset=utf-8,/, ''));
      queueMicrotask(() => this.onload?.());
    }
  };
  g.document.createElement = (tag = '') =>
    tag === 'canvas'
      ? {
          width: 0,
          height: 0,
          getContext: () => ({ scale() {}, drawImage() {} }),
          toBlob: (cb: (b: unknown) => void) => cb(new Blob([], { type: 'image/png' })),
        }
      : realCreate(tag);

  let stopped = false;
  await findByClass(rows[2], 'sbout-share')[0].onclick({
    stopPropagation: () => {
      stopped = true;
    },
  });
  g.Image = prevImage;
  g.document.createElement = realCreate;

  assert.match(cardSvg, /3 of 3/, 'the card is built for the row clicked, not for the scoped turn');
  assert.doesNotMatch(cardSvg, /1 of 3/);
  assert.equal(stopped, true, 'Share must not fall through to the row (which would move the scope)');
  assert.match(textOf(findByClass(container, 'sbnum')[0]), /Turn 1/, 'the scope did not move');

  view.destroy();
  g.document = prevDoc;
  g.fetch = prevFetch;
});

test('verdict: clicking a row scopes that turn, one row open at a time', () => {
  // The list is the verdict surface; the row you open is the turn every other widget shows.
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = snapWithTurns([makeTurn(1), makeTurn(2), makeTurn(3)]);
  const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });

  verdictRows(container)[2].onclick();
  let rows = findByClass(container, 'wrow');
  assert.match(textOf(findByClass(container, 'sbnum')[0]), /Turn 3/, 'the banner follows the row');
  assert.equal(rows[2].classList.contains('sel'), true, 'the row shows it is the scoped one');
  assert.equal(rows.filter((r: any) => r.classList.contains('open')).length, 1);

  rows[0].onclick();
  rows = findByClass(container, 'wrow');
  assert.equal(rows.filter((r: any) => r.classList.contains('open')).length, 1, 'opening one closes the other');
  assert.equal(rows[0].classList.contains('open'), true);

  rows[0].onclick(); // clicking the scoped row again leaves the scope
  assert.equal(findByClass(container, 'sbprompt')[0].textContent, 'Whole session');

  view.destroy();
  g.document = prevDoc;
});

test('verdict: a clean row says what the turn did, and the list states how many it judged', () => {
  // "clean" is not a finding, it is the absence of one — and it left five rows in a row saying
  // a word that carries nothing, under a chip announcing a count they did not match.
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = snapWithTurns([makeTurn(1, { compaction: true } as any), makeTurn(2), makeTurn(3)]);
  snap.mainTools = [
    { id: 'e1', name: 'Edit', ms: 1, arg: '/repo/src/a.ts', ctx: 0, turnIndex: 2 },
    { id: 'b1', name: 'Bash', ms: 1, arg: 'bun test', ctx: 0, turnIndex: 2 },
    { id: 'b2', name: 'Bash', ms: 1, arg: 'git commit -m done', ctx: 0, turnIndex: 2 },
  ];
  const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });

  const rows = verdictRows(container);
  assert.match(textOf(findByClass(rows[1], 'ws')[0]), /check before committing/, 'the practice it followed');
  assert.match(textOf(findByClass(rows[2], 'ws')[0]), /nothing flagged/, 'and nothing invented when there is none');
  assert.match(textOf(findByClass(container, 'wcount')[0]), /1 flagged · 2 clean/, 'the list says what it holds');

  view.destroy();
  g.document = prevDoc;
});

// ---- the NOW panel while the agent works in silence (activity group) ----

test('now panel: the activity group takes over from a narration the agent has left behind', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  // the shape the reducer emits when calls have run since the turn's last word
  const snap = snapWithTurns([
    makeTurn(1, {
      state: 'live',
      result: null,
      // said 90s ago: well past the hold, so the words are no longer what is happening
      lastNarration: narr('verifico ora la struttura di NOW', new Date(Date.now() - 90_000).toISOString()),
      lastWordTs: new Date(Date.now() - 90_000).toISOString(),
      activity: {
        counts: { Bash: 17, Write: 6, WebFetch: 5, Read: 2 },
        startedTs: new Date(Date.now() - 90_000).toISOString(),
        open: [{ name: 'Bash', startedTs: new Date(Date.now() - 30_000).toISOString() }],
      },
    }),
  ]);
  const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });

  const panel = findByClass(container, 'nowpanel')[0];
  assert.ok(panel && !panel.classList.contains('hidden'), 'the panel stays visible');
  assert.equal(textOf(findByClass(container, 'nowlbl')[0]), 'now', 'the label still reads "now"');
  const text = findByClass(container, 'nowtext')[0];
  // four families, so the fourth becomes an ellipsis; nothing about "running" is in the line
  assert.equal(
    textOf(text),
    'Ran 17 shell commands, wrote 6 files, fetched 5 pages…',
    'the group is counted, capped at three families',
  );
  // seedeep is counting here, not the agent: the quote marks the intent wears would be a lie
  assert.ok(text.classList.contains('plain'), 'the group line is not dressed as a quote');
  // the chip times the call that is RUNNING (open 30s), not the group (started 90s ago)
  assert.equal(textOf(findByClass(container, 'nowage')[0]), '30.0s', "the age is the running call's");

  view.destroy();
  g.document = prevDoc;
});

test('now panel: with nothing done since the last word, the agent keeps the floor', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = snapWithTurns([
    makeTurn(1, {
      state: 'live',
      result: null,
      lastNarration: narr('parto dai dati reali'),
      activity: null, // the agent spoke more recently than it acted
    }),
  ]);
  const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });

  const text = findByClass(container, 'nowtext')[0];
  assert.equal(textOf(text), 'parto dai dati reali', 'the narration is what the panel says');
  assert.ok(!text.classList.contains('plain'), 'and it is presented as the agent speaking');

  view.destroy();
  g.document = prevDoc;
});

test('now panel: a word just spoken keeps the panel even while calls are already running', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  // The regression this exists to prevent: a narration is the newest event for a median of 2.6s
  // while its text is a median 186 characters, so handing the panel straight to the group made
  // every narration unreadable — the agent's words never had time to be read.
  const justNow = new Date(Date.now() - 500).toISOString();
  const snap = snapWithTurns([
    makeTurn(1, {
      state: 'live',
      result: null,
      lastNarration: narr('correggo il difetto e poi lancio la review', justNow),
      lastWordTs: justNow,
      activity: { counts: { Bash: 2 }, startedTs: justNow, open: [] }, // work already under way
    }),
  ]);
  const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });

  const text = findByClass(container, 'nowtext')[0];
  assert.equal(textOf(text), 'correggo il difetto e poi lancio la review', 'the fresh word still holds the panel');
  assert.ok(!text.classList.contains('plain'), 'and it is the agent speaking, quotes and all');

  view.destroy();
  g.document = prevDoc;
});

// The two cases that tell the proportional hold apart from the flat 12s it replaced. Every other
// now-panel test sits far from the boundary (500ms, 90s) and passes under either rule, so without
// these the change would be untested. The hold runs from FIRST SIGHTING, so a single render can
// never observe it: the word is always zero seconds old there. Both drive the panel's own ticker
// with the clock moved on, which is exactly how the handover happens live.
function holdAt(elapsedMs: number, text: string): { line: string; asAgent: boolean } {
  const g = globalThis as any;
  const prevDoc = g.document,
    prevSetInterval = g.setInterval,
    prevNow = Date.now;
  g.document = fakeDoc();
  const ticker: { fn: (() => void) | null } = { fn: null };
  g.setInterval = (fn: () => void) => {
    ticker.fn = fn;
    return 1 as any;
  };
  try {
    const container = g.document.createElement();
    const spoke = new Date(Date.now() - 200).toISOString();
    const snap = snapWithTurns([
      makeTurn(1, {
        state: 'live',
        result: null,
        lastNarration: narr(text, spoke),
        lastWordTs: spoke,
        activity: { counts: { Bash: 2 }, startedTs: spoke, open: [] }, // work already under way
      }),
    ]);
    const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });
    assert.ok(ticker.fn, 'a fresh word with work running arms the ticker');
    const t0 = Date.now();
    Date.now = () => t0 + elapsedMs;
    ticker.fn!();
    const node = findByClass(container, 'nowtext')[0]!;
    const out = { line: textOf(node), asAgent: !node.classList.contains('plain') };
    view.destroy();
    return out;
  } finally {
    g.document = prevDoc;
    g.setInterval = prevSetInterval;
    Date.now = prevNow;
  }
}

test('now panel: a SHORT word hands over as soon as it has been read, not at a fixed 12s', () => {
  // Ten characters — well under a second of reading, so the 3s floor is the whole hold. At 6s the
  // flat 12s was still sitting on it while the agent had already run two commands.
  const r = holdAt(6_000, 'ora provo.');
  assert.equal(r.line, 'Ran 2 shell commands', 'a word already read gives the panel to the work');
  assert.equal(r.asAgent, false, 'and it is seedeep counting, not the agent speaking');
});

test('now panel: a LONG word keeps the panel past 12s, up to what fits on screen', () => {
  // A narration that overflows the two visible lines: ~14s to read, so at 13s it is still being
  // read. The flat 12s cut this one off mid-line — and 34% of real narrations are this long.
  const long =
    'sto misurando la catena reale dal log al browser prima di toccare qualsiasi cosa, ' +
    'perche una spiegazione senza numeri qui vale meno di niente, e il difetto potrebbe benissimo ' +
    'essere altrove: prima i dati, poi la diagnosi, e solo alla fine una riga di codice';
  assert.ok(long.length >= 240, 'the fixture must actually overflow the two-line clamp');
  const r = holdAt(13_000, long);
  assert.equal(r.line, long, 'the long word still holds the panel at 13s');
  assert.equal(r.asAgent, true, 'and it is presented as the agent speaking');
});

test('now panel: a word first seen long after it was stamped gets no hold', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  // Opening seedeep on a session whose agent last spoke minutes ago: the word is NEW to this page
  // but old to the world, so it must not hold the panel — what matters is what is happening.
  const longAgo = new Date(Date.now() - 5 * 60_000).toISOString();
  const snap = snapWithTurns([
    makeTurn(1, {
      state: 'live',
      result: null,
      lastNarration: narr('parto dai dati reali', longAgo),
      lastWordTs: longAgo,
      activity: { counts: { Bash: 3 }, startedTs: new Date(Date.now() - 4 * 60_000).toISOString(), open: [] },
    }),
  ]);
  const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });

  const text = findByClass(container, 'nowtext')[0];
  assert.equal(textOf(text), 'Ran 3 shell commands', 'the group speaks, not the stale word');
  assert.ok(text.classList.contains('plain'));
  // nothing is running, so there is no age to show — the panel is the count alone
  assert.equal(textOf(findByClass(container, 'nowage')[0]), '', 'no running call, no number');

  view.destroy();
  g.document = prevDoc;
});

test('now panel: re-rendering itself off the ticker does not pile up live counters', () => {
  // The panel re-renders ITSELF each second (its narration-to-activity handover is due at a moment
  // no event announces), and liveCounters is only cleared by a full render. Found in review: every
  // tick left the previous counters behind, so the list — and the DOM writes per tick — grew by
  // one or two per second between events, ~840 across a 7-minute command.
  const g = globalThis as any;
  const prevDoc = g.document;
  const prevSetInterval = g.setInterval;
  g.document = fakeDoc();
  // capture the ticker instead of letting it run: we drive it by hand
  // held in a property, not a local: TypeScript narrows a local assigned only inside a callback
  const ticker: { fn: (() => void) | null } = { fn: null };
  g.setInterval = (fn: () => void) => {
    ticker.fn = fn;
    return 1 as any;
  };

  const container = g.document.createElement();
  const justNow = new Date(Date.now() - 200).toISOString();
  const snap = snapWithTurns([
    makeTurn(1, {
      state: 'live',
      result: null,
      lastNarration: narr('parto dai dati reali', justNow),
      lastWordTs: justNow,
      // a call open past the one-second mark: that is what arms the age chip's ticker entry
      activity: {
        counts: { Bash: 1 },
        startedTs: justNow,
        open: [{ name: 'Bash', startedTs: new Date(Date.now() - 8_000).toISOString() }],
      },
    }),
  ]);
  const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });

  assert.ok(ticker.fn, 'the panel armed the ticker (a fresh word with work already running)');
  // count DOM writes per tick on the age node — proportional to the number of counters
  const age = findByClass(container, 'nowage')[0]!;
  let writes = 0;
  let held = age.textContent;
  Object.defineProperty(age, 'textContent', {
    get: () => held,
    set: (v: string) => {
      writes++;
      held = v;
    },
    configurable: true,
  });

  ticker.fn!();
  const first = writes;
  writes = 0;
  ticker.fn!();
  const second = writes;
  writes = 0;
  ticker.fn!();
  const third = writes;
  assert.ok(first > 0, 'the ticker does write the age');
  assert.equal(second, first, 'a second tick writes no more than the first');
  assert.equal(third, first, 'nor does a third — the counter list is not growing');

  view.destroy();
  g.document = prevDoc;
  g.setInterval = prevSetInterval;
});

test("now panel: at the handover the chip does not keep the narration's age", () => {
  // Seen live: at the switch from word to group the chip read "30s ago" — the narration's age, in
  // the narration's format — because the ticker was mid-iteration over the array dropNowCounters
  // had already replaced, so the reclaimed counter still ran and wrote LAST. With no call open,
  // nothing writes that node again, so the wrong value stayed on screen.
  const g = globalThis as any;
  const prevDoc = g.document;
  const prevSetInterval = g.setInterval;
  const realNow = Date.now;
  g.document = fakeDoc();
  const ticker: { fn: (() => void) | null } = { fn: null };
  g.setInterval = (fn: () => void) => {
    ticker.fn = fn;
    return 1 as any;
  };
  // The hold counts from when the panel FIRST SAW the word, so only a fake clock can expire it —
  // waiting it out for real would put 12 seconds into the suite. (bun has no mock.timers.)
  let clock = 1_800_000_000_000;
  (Date as any).now = () => clock;

  try {
    const container = g.document.createElement();
    const spoke = new Date(clock - 2_000).toISOString();
    const snap = snapWithTurns([
      makeTurn(1, {
        state: 'live',
        result: null,
        lastNarration: narr('verifico i tre punti', spoke),
        lastWordTs: spoke,
        activity: { counts: { Bash: 2 }, startedTs: spoke, open: [] }, // nothing running
      }),
    ]);
    const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });

    const age = findByClass(container, 'nowage')[0]!;
    assert.match(textOf(age), /ago$/, 'while the word holds the panel, the chip is its age');
    assert.ok(ticker.fn, 'the ticker is armed for the handover');

    clock += 13_000; // past the hold
    ticker.fn!(); // the tick that performs the handover

    assert.equal(textOf(findByClass(container, 'nowtext')[0]), 'Ran 2 shell commands', 'the group has the panel');
    assert.equal(textOf(age), '', 'and the chip is empty — nothing is running, so there is no age');
    view.destroy();
  } finally {
    (Date as any).now = realNow;
    g.document = prevDoc;
    g.setInterval = prevSetInterval;
  }
});

// ---- the call's intent, shown as prose instead of buried in the output dump ----

test('call drawer: an intent gets its own block, above the input', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const state = drivableState(snapWithTurns([makeTurn(1)]));
  const loadCallIO = () =>
    Promise.resolve({
      model: 'claude-opus-4-8',
      usage: { input: 4, output: 50, cacheRead: 100, cacheCreation: 0 },
      input: { text: 'the tool results', len: 16, truncated: false },
      output: { text: 'Reading the parser first.\n→ Read {"file_path":"~/parser.ts"}', len: 60, truncated: false },
      outputHasTools: true,
      narration: 'Reading the parser first.',
    });
  const view = createGraph(container, state, { loadCallIO } as any);

  state.emitCtx(usageEvt('msg_1', '2026-07-14T10:00:00Z'), { turnIndex: 1, label: 'analyze', newCall: true });
  feedRow(container, 0).onclick();

  return Promise.resolve()
    .then(() => Promise.resolve())
    .then(() => {
      const labels = findByClass(container, 'blabel').map((b: any) => b.textContent);
      // Order matters: the intent is the only prose here, and it explains the rest.
      assert.ok(labels.indexOf('Intent') < labels.indexOf('Input'), 'the intent comes first');
      const intentBl = findByClass(container, 'block').find(
        (b: any) => findByClass(b, 'blabel')[0]?.textContent === 'Intent',
      );
      // The block is always in the DOM, so its VISIBILITY is the assertion — checking the label
      // exists, or that the drawer contains the text, passes with the feature off too: the same
      // sentence is inside `Output`. That version of this test was decoration.
      assert.ok(!intentBl.className.includes('hidden'), 'the block is shown when the call spoke');
      const intentPre = findAll(
        intentBl,
        (n: any) => n.children?.length === 0 && typeof n.textContent === 'string' && !n.className,
      );
      assert.equal(
        intentPre[0]?.textContent,
        'Reading the parser first.',
        'and it holds the intent itself, not the output dump it was buried in',
      );
      view.destroy();
      g.document = prevDoc;
    });
});

test('call drawer: a silent call shows no Intent block at all', () => {
  // 60% of real calls state nothing. An empty block would claim the model said something.
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const state = drivableState(snapWithTurns([makeTurn(1)]));
  const loadCallIO = () =>
    Promise.resolve({
      model: 'claude-opus-4-8',
      usage: { input: 4, output: 50, cacheRead: 100, cacheCreation: 0 },
      input: { text: 'the tool results', len: 16, truncated: false },
      output: { text: '→ Bash {"command":"ls"}', len: 23, truncated: false },
      outputHasTools: true,
      narration: null,
    });
  const view = createGraph(container, state, { loadCallIO } as any);

  state.emitCtx(usageEvt('msg_2', '2026-07-14T10:00:00Z'), { turnIndex: 1, label: 'analyze', newCall: true });
  feedRow(container, 0).onclick();

  return Promise.resolve()
    .then(() => Promise.resolve())
    .then(() => {
      const intentBl = findByClass(container, 'block').find(
        (b: any) => findByClass(b, 'blabel')[0]?.textContent === 'Intent',
      );
      assert.ok(intentBl, 'the block exists in the DOM (declarative render)');
      assert.ok(intentBl.className.includes('hidden'), 'but it is hidden when the call said nothing');
      view.destroy();
      g.document = prevDoc;
    });
});

// The defect this card was rebuilt for: it counted Claude Code's rewind ledger, which sees only
// what CC's own file-writing tools wrote. On a real 16-file commit the ledger knew 8 — the rest
// were `python3` heredocs, `cat >>` and the build. The count now comes from git, and every number
// on the card is reproducible with `git show --stat` / `git status`.
test("Changed files: the count is git's, and the caption says which set it came from", async () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const cardBy = (container: any, title: string) =>
    findByClass(container, 'card').find((c: any) =>
      findByClass(c, 'wtitle').some((t: any) => (t.textContent ?? '').startsWith(title)),
    );

  const snap = snapWithTurns([makeTurn(1)]);
  // The ledger holds ONE repo file and one temporary. Neither may reach the hero: the repo count
  // is git's, and the scratchpad has its own row.
  snap.filesChanged = [{ path: 'apps/a.ts', turnIndex: 1, ts: '2026-08-03T10:00:00.000Z' }];
  const container = g.document.createElement();
  const view = createGraph(container, drivableState(snap), {
    loading: true, // as the real view mounts it: painting starts at goLive(), which also fetches
    loadFiles: async () => ({
      roots: ['~/proj'],
      origin: { kind: 'commits' as const, commits: 1 },
      files: [
        { path: '~/proj/apps/a.ts', at: 1, commit: 'aaa1111' },
        { path: '~/proj/apps/built.js', at: 1, commit: 'aaa1111' }, // written by the build
        { path: '~/proj/docs/CHANGELOG.md', at: 1, commit: 'aaa1111' }, // written by `cat >>`
      ],
      scratch: [{ path: '~scratch/x/probe.ts', at: 2, commit: null }],
      artifacts: [],
    }),
  });
  view.goLive();
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));

  const card = cardBy(container, 'Changed files');
  assert.equal(
    textOf(findByClass(card, 'num')[0]).replace(/\s/g, ''),
    '3files',
    "the hero is the commit's file count, shell writes included",
  );
  const aside = findByClass(card, 'fchgscr').map((r: any) => textOf(r));
  assert.equal(aside.length, 1, `only the scratchpad row, got: ${aside.join(' | ')}`);
  assert.ok(aside[0]?.includes('scratchpad'), aside[0] ?? 'no scratchpad row at all');
  assert.equal(textOf(findByClass(card, 'wdesc')[0]), 'Files in 1 commit.');

  // One number on the card: the caption names the set, and never carries a second count that a
  // reader could subtract from the hero.
  assert.equal(findByClass(card, 'num').length, 1);
  view.destroy();
  g.document = prevDoc;
});

test('Changed files: a session that never committed says so, instead of showing a number it cannot verify', async () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const cardBy = (container: any, title: string) =>
    findByClass(container, 'card').find((c: any) =>
      findByClass(c, 'wtitle').some((t: any) => (t.textContent ?? '').startsWith(title)),
    );
  const snap = snapWithTurns([makeTurn(1)]);
  // The ledger has a file. It still shows no number: which session wrote a file is not something
  // any source on disk records once a shell command is involved.
  snap.filesChanged = [{ path: 'apps/a.ts', turnIndex: 1, ts: '2026-08-03T10:00:00.000Z' }];
  const container = g.document.createElement();
  const view = createGraph(container, drivableState(snap), {
    loading: true,
    loadFiles: async () => ({
      roots: ['~/proj'],
      origin: { kind: 'none' as const },
      files: [],
      scratch: [{ path: '~scratch/x/probe.ts', at: 2, commit: null }],
      artifacts: [],
    }),
  });
  view.goLive();
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  const card = cardBy(container, 'Changed files');
  assert.equal(findByClass(card, 'num').length, 0, 'no hero without a verifiable set');
  assert.equal(textOf(findByClass(card, 'wdesc')[0]), 'Nothing committed in this session.');
  assert.ok(
    findByClass(card, 'fchgscr').some((r: any) => textOf(r).includes('scratchpad')),
    'the scratchpad tally survives — the ledger is the only thing that sees it',
  );
  view.destroy();
  g.document = prevDoc;
});

// The description is the caption now, so every state has to name its set in one line. The two the
// other tests do not reach: git failing (which must NOT be reported as "nothing committed"), and a
// session outside a repository.
test('Changed files: the description names the set in every state', async () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const descFor = async (payload: any) => {
    const container = g.document.createElement();
    const view = createGraph(container, drivableState(snapWithTurns([makeTurn(1)])), {
      loading: true,
      loadFiles: async () => payload,
    });
    view.goLive();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const card = findByClass(container, 'card').find((c: any) =>
      findByClass(c, 'wtitle').some((t: any) => (t.textContent ?? '').startsWith('Changed files')),
    );
    const out = { desc: textOf(findByClass(card, 'wdesc')[0]), hero: findByClass(card, 'num').length };
    view.destroy();
    return out;
  };

  // git could not answer. Saying "nothing committed" here would be the card asserting something it
  // never learned — the exact failure this rework exists to remove.
  const unknown = await descFor({
    roots: ['~/proj'],
    origin: { kind: 'unknown' as const },
    files: [],
    scratch: [],
    artifacts: [],
  });
  assert.equal(unknown.desc, 'The repository could not be read.');
  assert.equal(unknown.hero, 0);

  const noRepo = await descFor({
    roots: [],
    origin: { kind: 'no-repo' as const },
    files: [],
    scratch: [{ path: '~scratch/x/probe.ts', at: 1, commit: null }],
    artifacts: [],
  });
  assert.equal(noRepo.desc, 'This session is not inside a git repository.');

  const many = await descFor({
    roots: ['~/proj'],
    origin: { kind: 'commits' as const, commits: 2 },
    files: [
      { path: '~/proj/a.ts', at: 10, commit: 'aaa1111' },
      { path: '~/proj/b.ts', at: 20, commit: 'bbb2222' },
    ],
    scratch: [],
    artifacts: [],
  });
  assert.equal(many.desc, 'Files in 2 commits.');

  g.document = prevDoc;
});

test('Changed files drawer: before the repository answers it says so, instead of blaming a filter', async () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  // A loader that never resolves: the drawer must be honest about that, not render "0 files" with
  // an empty filter box and "No files match the filters."
  const view = createGraph(container, drivableState(snapWithTurns([makeTurn(1)])), {
    loading: true,
    loadFiles: () => new Promise(() => {}),
  });
  view.goLive();
  await new Promise((r) => setTimeout(r, 0));
  const card = findByClass(container, 'card').find((c: any) =>
    findByClass(c, 'wtitle').some((t: any) => (t.textContent ?? '').startsWith('Changed files')),
  );
  findByClass(card, 'xbtn')[0].onclick();
  const drawer = findByClass(container, 'drawer')[0];
  const text = textOf(drawer);
  assert.ok(text.includes('reading the repository'), `expected a waiting state, got: ${text.slice(0, 160)}`);
  assert.ok(!text.includes('No files match the filters'), 'must not blame a filter nobody set');
  assert.equal(findByClass(drawer, 'tfilter').length, 0, 'no filter box until there is a list');
  view.destroy();
  g.document = prevDoc;
});

test('Changed files: a pending refresh dies with the tab', async () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  let fetches = 0;
  const snap = snapWithTurns([makeTurn(1)]);
  const state = drivableState(snap);
  const view = createGraph(container, state, {
    loading: true,
    loadFiles: async () => {
      fetches++;
      return { roots: ['~/proj'], origin: { kind: 'none' as const }, files: [], scratch: [], artifacts: [] };
    },
  });
  view.goLive();
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  const afterMount = fetches;

  // A delta arrives (the ledger grew), arming the 1.5s debounce; the tab is closed inside it. A
  // timer that survives destroy() re-renders a torn-down graph and restarts its 1s ticker forever.
  snap.filesChanged = [{ path: 'a.ts', turnIndex: 1, ts: '2026-08-03T10:00:00.000Z' }];
  state.change();
  await new Promise((r) => setTimeout(r, 0));
  view.destroy();
  await new Promise((r) => setTimeout(r, 1700));
  assert.equal(fetches, afterMount, 'no fetch after destroy — the debounce was cancelled with the tab');
  g.document = prevDoc;
});

// `destroy()` cancels timers, but a request already in flight has no timer to cancel: its `.then()`
// runs whenever the network answers, which may be long after the tab was closed. The three
// session-scoped cards BUILD their content in that continuation, so an unguarded one renders a
// whole card into a host nothing owns any more — and, when the page around it is gone, reaches for
// a `document` that is not there. That is how it surfaced: a test green on this machine and red in
// CI, where the file order let the answer land after the harness had put the document back.
//
// Measured as elements CREATED after the tab closed, because the container is already empty by then
// and could not tell the two outcomes apart.
test('a card fetch still in flight when the tab closes builds nothing', async () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  let answer: (v: any) => void = () => {};
  const view = createGraph(container, drivableState(snapWithTurns([makeTurn(1)])), {
    loading: true,
    loadCommits: () =>
      new Promise((r) => {
        answer = r;
      }),
  });
  view.goLive();
  await new Promise((r) => setTimeout(r, 0));

  view.destroy();

  const build = g.document.createElement;
  let built = 0;
  g.document.createElement = (tag: string) => {
    built++;
    return build(tag);
  };
  answer({ commits: [{ hash: 'abc1234', subject: 'a commit', at: 0, url: null }], remote: null });
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(built, 0, 'the closed tab rendered a card anyway');
  g.document = prevDoc;
});

// A scheduled wakeup is drawn in the same band as the running commands — it answers the same
// question, what is this session still waiting on. The invariant that matters is the OTHER half:
// Claude Code writes nothing when a wakeup fires, so the row must stop being drawn once its
// instant has passed, rather than sit there counting into the negative.
test('a scheduled wakeup is drawn while it is ahead, and not once it is behind', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const rowsFor = (at: string) => {
    const container = g.document.createElement();
    const snap = baseSnapshot();
    (snap as any).wakeup = { toolUseId: 'toolu_w1', at, turnIndex: 4 };
    const state = { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} };
    const view = createGraph(container, state);
    const rows = findByClass(container, 'wake');
    view.destroy();
    return rows;
  };
  const ahead = rowsFor(new Date(Date.now() + 20 * 60_000).toISOString());
  assert.equal(ahead.length, 1, 'a wakeup still ahead is what the session is waiting for');
  assert.match(textOf(ahead[0]), /Scheduled wakeup/);
  assert.match(textOf(ahead[0]), /armed in turn 4/);
  // Passed: seedeep never learns whether it fired, so the honest thing is to stop claiming a wait.
  assert.equal(rowsFor(new Date(Date.now() - 60_000).toISOString()).length, 0, 'a passed wakeup is not a wait');
  g.document = prevDoc;
});

// A note that names NO call has nowhere to be anchored, so the feed is the only surface that can
// carry it. Driven through the real event path (`onEvent`), because the row is not built from the
// snapshot at all — a fixture that only set snapshot state could not tell whether it appears.
test('a note about the session becomes a feed row', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const text = 'Background security review found 2 issues: XSS in row.ts; path traversal in read.ts';
  let emit: ((e: any, ctx: any) => void) | null = null;
  const state = {
    snapshot: baseSnapshot,
    onChange: () => () => {},
    onEvent: (cb: (e: any, ctx: any) => void) => {
      emit = cb;
      return () => {};
    },
  };
  const view = createGraph(container, state);
  emit!(
    {
      type: 'note',
      sessionId: 's1',
      root: 'cli',
      timestamp: '2026-07-23T10:05:00.000Z',
      seq: 1,
      agentId: null,
      toolUseId: null,
      hook: null,
      source: null,
      text,
    },
    { turnIndex: null, label: null },
  );
  const rows = findByClass(container, 'fev').map((r: any) => textOf(r));
  assert.ok(
    rows.some((r: string) => r.includes(text)),
    'the review reported findings and nothing else could show them: ' + JSON.stringify(rows),
  );
  view.destroy();
  g.document = prevDoc;
});

// Expand all is the COMPLETE history of the turn, and it is the only surface with no cap — which
// is what makes it the home of a note nothing can be anchored to. Two things must hold: the note
// is there, in time order among the calls; and a call somebody warned about carries the same mark
// the Trace block does, instead of reading as an ordinary call.
test('the complete history holds the session note, in order, and marks a flagged call', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = baseSnapshot();
  const text = 'Background security review found 2 issues: XSS in row.ts; path traversal in read.ts';
  (snap as any).notes = [{ source: null, hook: null, text, at: '2026-07-23T10:00:30.000Z', turnIndex: 1 }];
  let emit: ((e: any, ctx: any) => void) | null = null;
  const state = {
    snapshot: () => snap,
    onChange: () => () => {},
    onEvent: (cb: (e: any, ctx: any) => void) => {
      emit = cb;
      return () => {};
    },
  };
  const view = createGraph(container, state);
  const base = { sessionId: 's1', root: 'cli', agentId: null };
  // A turn with one call, one flagged Write and one plain Read — driven through the real event
  // path, because the span store is what Expand all reads and only events fill it.
  emit!(
    { ...base, type: 'user-turn', timestamp: '2026-07-23T10:00:00.000Z', seq: 1, text: 'go', command: null },
    { turnIndex: 1 },
  );
  emit!(
    { ...base, type: 'tool-start', timestamp: '2026-07-23T10:00:10.000Z', seq: 2, id: 'toolu_w', name: 'Write' },
    { turnIndex: 1, label: 'row.ts' },
  );
  emit!(
    { ...base, type: 'tool-end', timestamp: '2026-07-23T10:00:11.000Z', seq: 3, toolUseId: 'toolu_w' },
    { turnIndex: 1 },
  );
  emit!(
    {
      ...base,
      type: 'note',
      timestamp: '2026-07-23T10:00:12.000Z',
      seq: 4,
      toolUseId: 'toolu_w',
      hook: 'PostToolUse:Write',
      source: 'sec',
      text: 'careful',
    },
    { turnIndex: 1 },
  );
  emit!(
    { ...base, type: 'tool-start', timestamp: '2026-07-23T10:00:40.000Z', seq: 5, id: 'toolu_r', name: 'Read' },
    { turnIndex: 1, label: 'app.ts' },
  );
  emit!(
    { ...base, type: 'tool-end', timestamp: '2026-07-23T10:00:41.000Z', seq: 6, toolUseId: 'toolu_r' },
    { turnIndex: 1 },
  );

  findByClass(container, 'xbtn')
    .find((b: any) => textOf(b).includes('Expand all'))
    ?.onclick?.();
  const rows = findByClass(container, 'ttrow').map((r: any) => textOf(r));
  const noteAt = rows.findIndex((r: string) => r.includes('security review'));
  const writeAt = rows.findIndex((r: string) => r.includes('row.ts'));
  const readAt = rows.findIndex((r: string) => r.includes('app.ts'));
  assert.ok(noteAt >= 0, 'the note is in the complete history: ' + JSON.stringify(rows));
  // 10:00:30 sits between the Write (10:00:10) and the Read (10:00:40) — appending it at the end
  // would put a finding about the Write next to work it has nothing to do with.
  assert.ok(writeAt < noteAt && noteAt < readAt, 'in time order, not appended: ' + JSON.stringify(rows));
  assert.ok(rows[writeAt]!.includes('⚑'), 'the warned call carries the mark here too');
  assert.ok(!rows[readAt]!.includes('⚑'), 'and the call nobody warned about does not');
  view.destroy();
  g.document = prevDoc;
});

// Reported as "there is no summary of API calls and tool calls" — the counts existed, both of them,
// but at the BOTTOM of two different cards (under the token ledger, and under four long file paths
// in Main tools). Neither needed expanding and neither was findable, which is a placement bug, not
// a missing figure. The banner is where "how much work" is already asked, beside the turn count.
test('scope banner: the whole-session summary carries the call and tool counts', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = snapWithTurns([makeTurn(1), makeTurn(2)]);
  snap.apiCalls = 403;
  snap.mainTools = [
    { id: 't1', name: 'Bash', turnIndex: 1 },
    { id: 't2', name: 'Edit', turnIndex: 1 },
    { id: 't3', name: 'Read', turnIndex: 2 },
  ];
  const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });

  const banner = findByClass(container, 'scope-banner')[0];
  const nums = findByClass(banner, 'sbnum').map((n: any) => n.textContent);
  // ONE element, not three side by side: `2 turns 403 API calls 3 tools` reads as a single number
  // with stray words in it — same colour, same weight, no separator. The separators are the point.
  assert.ok(
    nums.includes('2 turns · 403 API calls · 3 tools'),
    `the three counts are one group with separators — got ${JSON.stringify(nums)}`,
  );
  // The hover is the only place that can say what a number leaves OUT, and it has to line up with
  // the parts that are actually shown — one gloss per count, in the same order.
  assert.equal(
    findByClass(banner, 'sbnum')[0].title,
    'rounds of work · model calls on the main thread, subagents excluded · tool uses',
    'each count is glossed, in the order they appear',
  );

  view.destroy();
  g.document = prevDoc;
});

// Scope consistency: a figure offered for the session must be offered for a turn, or the reader is
// taught where it lives and then finds it missing at the scope they moved into.
test('scope banner: a selected turn carries the same two counts, scoped to it', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const snap = snapWithTurns([makeTurn(1), makeTurn(2)]);
  snap.mainTools = [
    { id: 't1', name: 'Bash', turnIndex: 1 },
    { id: 't2', name: 'Edit', turnIndex: 1 },
    { id: 't3', name: 'Read', turnIndex: 2 },
  ];
  const view = createGraph(container, { snapshot: () => snap, onChange: () => () => {}, onEvent: () => () => {} });

  selectTurnViaStrip(container, 0); // turn 1 — two of the three tools are its

  const stats = textOf(findByClass(findByClass(container, 'scope-banner')[0], 'sbstats')[0]);
  assert.match(stats, /5 API/, "the turn's own call count");
  assert.match(stats, /2 tools/, 'and only the tools that turn ran');

  view.destroy();
  g.document = prevDoc;
});

// The durations are the banner's second group, and they are joined by an ELEMENT rather than by a
// string: both tick on their own live counter, so neither can be folded into one piece of text.
test('scope banner: the two durations are separated, and only when both are there', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();

  // A live turn beside a finished one: the running counter AND the session total.
  const both = snapWithTurns([makeTurn(1), makeTurn(2, { state: 'live', durationMs: null })]);
  const live = createGraph(container, { snapshot: () => both, onChange: () => () => {}, onEvent: () => () => {} });
  const seps = findByClass(findByClass(container, 'scope-banner')[0], 'sbsep');
  // Two separators, two jobs: a bar closing the counts, a dot between the two durations. Same
  // character for both and the grouping dissolves — which is the whole reason there are two.
  assert.equal(seps.length, 2, 'the group bar and the duration dot');
  assert.equal(seps.filter((n: any) => n.className?.includes('group')).length, 1, 'exactly one group bar');
  live.destroy();

  // Nothing running: one duration, so nothing to separate — a dangling `·` is worse than none.
  const container2 = g.document.createElement();
  const settled = createGraph(container2, {
    snapshot: () => snapWithTurns([makeTurn(1), makeTurn(2)]),
    onChange: () => () => {},
    onEvent: () => () => {},
  });
  // The counts are still there, so the group bar is; the durations are one, so no dot joins them.
  const settledSeps = findByClass(findByClass(container2, 'scope-banner')[0], 'sbsep');
  assert.equal(settledSeps.length, 1, 'the group bar alone');
  assert.ok(settledSeps[0].className?.includes('group'), 'and it is the group one, not a lone dot');
  settled.destroy();

  g.document = prevDoc;
});
