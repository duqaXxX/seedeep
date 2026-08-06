import { expect, test } from 'bun:test';
import { binComposition, createTrace } from '../src/client/trace.ts';
import type { TraceSnapshot, TraceSpan } from '../src/core/span-store.ts';
import { fakeDoc, findByClass, textOf } from './fake-dom.ts';

/** Minimal TraceSnapshot: 2 turns, turn 0 has a tool span with a handle. */
function snap2(): TraceSnapshot {
  return {
    t0: 0,
    t1: 100,
    seq: 1,
    turns: [
      {
        index: 0,
        title: 'fix the bug',
        kind: 'work',
        t0: 0,
        t1: 50,
        state: 'done',
        spans: [
          {
            id: 'p0',
            type: 'prompt',
            label: 'fix the bug',
            detail: null,
            t0: 0,
            t1: 0,
            turnIndex: 0,
            lane: 0,
            parentId: null,
            agent: null,
            status: 'ok',
            handle: null,
          },
          {
            id: 't0',
            type: 'tool',
            label: 'Read',
            detail: 'a.ts',
            t0: 5,
            t1: 9,
            turnIndex: 0,
            lane: 0,
            parentId: null,
            agent: null,
            status: 'ok',
            handle: { kind: 'tool', toolUseId: 'tu0' },
          },
          {
            id: 'r0',
            type: 'result',
            label: 'done',
            detail: null,
            t0: 49,
            t1: 50,
            turnIndex: 0,
            lane: 0,
            parentId: null,
            agent: null,
            status: 'ok',
            handle: null,
          },
        ],
        spawns: [],
      },
      {
        index: 1,
        title: 'add tests',
        kind: 'work',
        t0: 60,
        t1: 100,
        state: 'done',
        spans: [],
        spawns: [],
      },
    ],
  };
}

test('trace render: open builds a spine with one thead per turn', () => {
  const g = globalThis as any;
  const prev = g.document;
  g.document = fakeDoc();

  const container = g.document.createElement();
  const blocks: any[] = [];
  const trace = createTrace(container, { onBlock: (h: any) => blocks.push(h) });

  trace.open(snap2(), null);

  expect(trace.isOpen()).toBe(true);
  // One thead node per turn (2 turns → 2 theads).
  const theads = findByClass(container, 'thead');
  expect(theads.length).toBe(2);

  trace.close();
  expect(trace.isOpen()).toBe(false);

  g.document = prev;
});

test('trace render: clicking a tool snode fires onBlock with its handle', () => {
  const g = globalThis as any;
  const prev = g.document;
  g.document = fakeDoc();

  const container = g.document.createElement();
  const blocks: any[] = [];
  const trace = createTrace(container, { onBlock: (h: any) => blocks.push(h) });

  trace.open(snap2(), null);

  // Auto-follow means turn 1 (last) is expanded; turn 0 (the one with the tool span) is
  // collapsed. Expand turn 0 explicitly via its header click.
  const theads = findByClass(container, 'thead');
  theads[0].onclick?.(); // toggle turn 0 open

  // Turn 0 path = [prompt, tool, result] → grouped as prompt / round#1 / result:
  // the tool sits inside the round group and appears after expanding it.
  let snodes = findByClass(container, 'snode');
  expect(snodes.length).toBe(2); // prompt, result — the tool is folded
  const round = findByClass(container, 'gnode')[0];
  expect(round).toBeTruthy();
  round.onclick?.({ stopPropagation() {} });

  snodes = findByClass(container, 'snode');
  expect(snodes.length).toBe(3); // prompt, tool (now visible), result
  const toolNode = snodes.find((n: any) => n.className === 'snode');
  expect(toolNode).toBeTruthy();
  // prompt and result have handle=null → no onclick assigned
  expect(snodes[0].onclick).toBeNull();

  // Simulate the click
  toolNode.onclick?.();
  expect(blocks).toHaveLength(1);
  expect(blocks[0]).toEqual({ kind: 'tool', toolUseId: 'tu0' });

  g.document = prev;
});

test('trace render: a failed tool reddens the collapsed round (block + preview dot) and the expanded step', () => {
  const g = globalThis as any;
  const prev = g.document;
  g.document = fakeDoc();

  const container = g.document.createElement();
  const trace = createTrace(container, {});
  const s = snap2();
  s.turns[0]!.spans[1]!.status = 'error'; // the Read tool failed
  trace.open(s, null);

  findByClass(container, 'thead')[0].onclick?.(); // expand turn 0
  // Collapsed round: the block carries the err accent AND its preview shows a red dot at the
  // failing step's position — a failure is visible without opening the group.
  const round = findByClass(container, 'gnode')[0];
  expect(round.className.includes('err')).toBe(true);
  const redDots = findByClass(round, 'gdots')[0] ? findByClass(findByClass(round, 'gdots')[0], 'err') : [];
  expect(redDots.length).toBe(1);

  round.onclick?.({ stopPropagation() {} }); // expand the round
  const errNodes = findByClass(container, 'snode').filter((n: any) => n.className.includes('err'));
  expect(errNodes.length).toBe(1); // the failed tool step is red too
  expect(textOf(errNodes[0]).includes('Read')).toBe(true);

  g.close?.();
  g.document = prev;
});

// A background launch closes in ~100ms and looks like any other quick Bash, while the command it
// started runs for minutes (p50 2.9m over 120 real launches) — and when the outcome finally lands,
// the sub-line stops naming the command and starts quoting Claude Code. The chip is the one part
// of the row that is true in every one of those states.
test('trace render: a background launch carries the bg chip; an ordinary tool does not', () => {
  const g = globalThis as any;
  const prev = g.document;
  g.document = fakeDoc();

  const container = g.document.createElement();
  const trace = createTrace(container, {});
  const s = snap2();
  s.turns[0]!.spans[1]!.background = true;
  trace.open(s, null);

  findByClass(container, 'thead')[0].onclick?.(); // expand turn 0
  findByClass(container, 'gnode')[0].onclick?.({ stopPropagation() {} }); // expand the round
  const chips = findByClass(container, 'sbg');
  expect(chips.length).toBe(1);
  expect(textOf(chips[0])).toBe('bg');
  // It marks the tool block itself, not some sibling: the block it sits in is the Read step.
  const marked = findByClass(container, 'snode').filter((n: any) => findByClass(n, 'sbg').length > 0);
  expect(marked.length).toBe(1);
  expect(textOf(marked[0]).includes('Read')).toBe(true);

  // The same snapshot WITHOUT the flag: a chip that renders either way marks nothing.
  const c2 = g.document.createElement();
  const plain = createTrace(c2, {});
  plain.open(snap2(), null);
  findByClass(c2, 'thead')[0].onclick?.();
  findByClass(c2, 'gnode')[0]?.onclick?.({ stopPropagation() {} });
  expect(findByClass(c2, 'sbg').length).toBe(0);

  g.document = prev;
});

test('trace render: whole-session open expands the LAST turn, not turn 0', () => {
  const g = globalThis as any;
  const prev = g.document;
  g.document = fakeDoc();

  const container = g.document.createElement();
  const trace = createTrace(container, {});
  trace.open(snap2(), null); // snap2 has 2 turns; last model index = 1

  const segs = findByClass(container, 'tseg');
  expect(segs.length).toBe(2);
  expect(segs[1].classList.contains('open')).toBe(true); // last turn = expanded
  expect(segs[0].classList.contains('open')).toBe(false); // first turn = collapsed

  g.document = prev;
});

/** One turn with 12 rounds (api+tool each) — enough to fold a chapter. */
function bigTurnSnap(state: 'done' | 'live' = 'done'): TraceSnapshot {
  const spans: TraceSpan[] = [
    {
      id: 'p',
      type: 'prompt',
      label: 'go',
      detail: null,
      t0: 0,
      t1: 0,
      turnIndex: 1,
      lane: 0,
      parentId: null,
      agent: null,
      status: 'ok',
      handle: null,
    },
  ];
  for (let i = 0; i < 12; i++) {
    spans.push({
      id: 'a' + i,
      type: 'api',
      label: 'API call',
      detail: null,
      t0: 0,
      t1: 1000,
      turnIndex: 1,
      lane: 0,
      parentId: null,
      agent: null,
      status: 'ok',
      handle: { kind: 'call', callId: 'c' + i },
    });
    spans.push({
      id: 't' + i,
      type: 'tool',
      label: 'Bash',
      detail: 'x',
      t0: 0,
      t1: 100,
      turnIndex: 1,
      lane: 0,
      parentId: null,
      agent: null,
      status: 'ok',
      handle: { kind: 'tool', toolUseId: 't' + i },
    });
  }
  return {
    turns: [{ index: 1, title: 'big', kind: 'work', t0: 0, t1: 1, state, spans, spawns: [] }],
    t0: 0,
    t1: 1,
    seq: 1,
  };
}

test('grouped strip: 12 rounds render as one chapter + two rounds, not 25 blocks', () => {
  const g = globalThis as any;
  const prev = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const trace = createTrace(container, {});
  trace.open(bigTurnSnap(), null);

  const gnodes = findByClass(container, 'gnode');
  expect(gnodes.length).toBe(2); // chapter R1–10 + trailing chapter R11–12
  expect(textOf(gnodes[0])).toContain('R1–10');
  expect(textOf(gnodes[1])).toContain('R11–12');
  expect(findByClass(container, 'snode').length).toBeLessThan(6); // steps stay folded

  g.document = prev;
});

test('grouped strip: clicking a group expands it in place and survives update()', () => {
  const g = globalThis as any;
  const prev = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const trace = createTrace(container, {});
  trace.open(bigTurnSnap(), null);

  const chapter = findByClass(container, 'gnode')[0];
  chapter.onclick?.({ stopPropagation() {} });
  expect(findByClass(container, 'gframe').length).toBe(1);

  trace.update(bigTurnSnap());
  expect(findByClass(container, 'gframe').length).toBe(1); // pinned survived the re-render

  g.document = prev;
});

test('grouped strip: live turn keeps the tail round raw', () => {
  const g = globalThis as any;
  const prev = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const trace = createTrace(container, {});
  trace.open(bigTurnSnap('live'), null);

  // tail round (api #12 + its tool) stays raw: prompt + 2 tail steps = 3 snodes
  const snodes = findByClass(container, 'snode');
  expect(snodes.length).toBe(3);
  expect(findByClass(container, 'gnode').length).toBe(2); // R1–10 + #11
  // the newest block of the live tail glows ('tail', not 'live' — see trace-css-scope)
  expect(snodes[snodes.length - 1].className).toContain('tail');

  g.document = prev;
});

test('a result with spans after it renders as dashed "reply", the final as "done"', () => {
  const g = globalThis as any;
  const prev = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const spans: TraceSpan[] = [
    {
      id: 'p',
      type: 'prompt',
      label: 'go',
      detail: null,
      t0: 0,
      t1: 0,
      turnIndex: 1,
      lane: 0,
      parentId: null,
      agent: null,
      status: 'ok',
      handle: null,
    },
    {
      id: 'r1',
      type: 'result',
      label: 'done',
      detail: 'first answer',
      t0: 0,
      t1: 0,
      turnIndex: 1,
      lane: 0,
      parentId: null,
      agent: null,
      status: 'ok',
      handle: null,
    },
    {
      id: 'a1',
      type: 'api',
      label: 'API call',
      detail: null,
      t0: 0,
      t1: 1,
      turnIndex: 1,
      lane: 0,
      parentId: null,
      agent: null,
      status: 'ok',
      handle: null,
    },
    {
      id: 'r2',
      type: 'result',
      label: 'done',
      detail: 'real end',
      t0: 0,
      t1: 0,
      turnIndex: 1,
      lane: 0,
      parentId: null,
      agent: null,
      status: 'ok',
      handle: null,
    },
  ];
  const snap: TraceSnapshot = {
    turns: [{ index: 1, title: 't', kind: 'work', t0: 0, t1: 1, state: 'done', spans, spawns: [] }],
    t0: 0,
    t1: 1,
    seq: 1,
  };
  const trace = createTrace(container, {});
  trace.open(snap, null);

  const ends = findByClass(container, 'snode').filter((n: any) => n.className.includes('end'));
  expect(ends.length).toBe(2);
  expect(ends[0].className).toContain('mid');
  expect(textOf(ends[0])).toContain('reply');
  expect(ends[1].className).not.toContain('mid');
  expect(textOf(ends[1])).toContain('done');

  g.document = prev;
});

/** One turn with a spawn whose lane carries child spans (api + tool). */
function spawnSnap(): TraceSnapshot {
  const laneSpans: TraceSpan[] = [
    {
      id: 'la',
      type: 'api',
      label: 'API call',
      detail: null,
      t0: 0,
      t1: 1000,
      turnIndex: 1,
      lane: 1,
      parentId: 'sw1',
      agent: 'gp',
      status: 'ok',
      handle: { kind: 'call', callId: 'lc1' },
    },
    {
      id: 'lt',
      type: 'subspan',
      label: 'Bash',
      detail: 'x',
      t0: 0,
      t1: 100,
      turnIndex: 1,
      lane: 1,
      parentId: 'sw1',
      agent: 'gp',
      status: 'ok',
      handle: { kind: 'tool', toolUseId: 'lt1' },
    },
  ];
  const spans: TraceSpan[] = [
    {
      id: 'p',
      type: 'prompt',
      label: 'go',
      detail: null,
      t0: 0,
      t1: 0,
      turnIndex: 1,
      lane: 0,
      parentId: null,
      agent: null,
      status: 'ok',
      handle: null,
    },
    {
      id: 'sw1',
      type: 'spawn',
      label: 'Agent',
      detail: 'review the diff',
      t0: 0,
      t1: 75,
      turnIndex: 1,
      lane: 0,
      parentId: null,
      agent: null,
      status: 'ok',
      handle: { kind: 'tool', toolUseId: 'sw1' },
    },
    {
      id: 'r',
      type: 'result',
      label: 'done',
      detail: null,
      t0: 100,
      t1: 100,
      turnIndex: 1,
      lane: 0,
      parentId: null,
      agent: null,
      status: 'ok',
      handle: null,
    },
  ];
  const spawns = [
    {
      spawnId: 'sw1',
      label: 'Agent',
      kind: 'Agent',
      lanes: [{ agentId: 'ag1', label: 'general-purpose (fable)', status: 'ok', spans: laneSpans }],
    },
  ];
  return {
    turns: [{ index: 1, title: 't', kind: 'work', t0: 0, t1: 100, state: 'done', spans, spawns }],
    t0: 0,
    t1: 100,
    seq: 1,
  };
}

test('merged spawn: block carries the SUBAGENT facts, never the launch ms; no fork/branch exist', () => {
  const g = globalThis as any;
  const prev = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const trace = createTrace(container, {});
  trace.open(spawnSnap(), null);

  expect(findByClass(container, 'fork').length).toBe(0);
  expect(findByClass(container, 'branch').length).toBe(0);
  const spawn = findByClass(container, 'snode').find((n: any) => n.className.includes('spawn'));
  const txt = textOf(spawn);
  expect(txt).toContain('review the diff');
  expect(txt).toContain('general-purpose (fable)');
  expect(txt).toContain('1 tool');
  expect(txt).not.toContain('75ms');

  g.document = prev;
});

test('merged spawn: click toggles the child lane with the lane spans grouped', () => {
  const g = globalThis as any;
  const prev = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const trace = createTrace(container, {});
  trace.open(spawnSnap(), null);

  const spawn = findByClass(container, 'snode').find((n: any) => n.className.includes('spawn'));
  spawn.onclick?.({ stopPropagation() {} });
  const strip = findByClass(container, 'lane-strip')[0];
  expect(strip).toBeTruthy();
  expect(findByClass(strip, 'gnode').length + findByClass(strip, 'snode').length).toBeGreaterThan(0);
  // toggle back off: the strip disappears
  spawn.onclick?.({ stopPropagation() {} });
  expect(findByClass(container, 'lane-strip').length).toBe(0);

  g.document = prev;
});

test('merged spawn: the info affordance fires onBlock with agentId AND the spawn toolUseId', () => {
  const g = globalThis as any;
  const prev = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const blocks: any[] = [];
  const trace = createTrace(container, { onBlock: (h: any) => blocks.push(h) });
  trace.open(spawnSnap(), null);

  const gi = findByClass(container, 'gi')[0];
  expect(gi).toBeTruthy();
  gi.onclick?.({ stopPropagation() {} });
  expect(blocks[0]).toEqual({ kind: 'subagent', agentId: 'ag1', toolUseId: 'sw1' });

  g.document = prev;
});

test('follow button appears when auto-follow is released and re-engages on click', () => {
  const g = globalThis as any;
  const prev = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const trace = createTrace(container, {});
  trace.open(bigTurnSnap('live'), null);

  const btn = findByClass(container, 'trace-follow')[0];
  expect(btn).toBeTruthy();
  expect(btn.className).toContain('hidden'); // following → hidden
  (trace as any)._releaseFollow(); // TEST-ONLY hook, mirrors a manual pan
  expect(btn.className).not.toContain('hidden');
  btn.onclick?.();
  expect(btn.className).toContain('hidden'); // re-engaged

  g.document = prev;
});

test('follow stays hidden on a finished session — it would only duplicate Last turn', () => {
  const g = globalThis as any;
  const prev = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const trace = createTrace(container, {});

  // Auto-follow acts only through update(), which a finished session never calls: the
  // button would jump to the last turn once, which is Last turn's job (and it also opens it).
  trace.open(bigTurnSnap('done'), null);
  const btn = findByClass(container, 'trace-follow')[0];
  expect(btn.className).toContain('hidden');
  (trace as any)._releaseFollow(); // as a manual scroll would
  expect(btn.className).toContain('hidden'); // …still nothing to follow

  // A finished session still reports state 'live' on every turn it never closed — 16 of
  // 144 in one measured session, all of them empty. Trusting the flag alone would bring
  // the button back on exactly those sessions.
  const ghost = g.document.createElement();
  const t3 = createTrace(ghost, {});
  t3.open(
    {
      t0: 0,
      t1: 1,
      seq: 1,
      turns: [
        { index: 1, title: 'never closed', kind: 'work', t0: 0, t1: 0, state: 'live', spans: [], spawns: [] },
        { index: 2, title: 'also never closed', kind: 'local', t0: 0, t1: 0, state: 'live', spans: [], spawns: [] },
      ],
    },
    null,
  );
  (t3 as any)._releaseFollow();
  expect(findByClass(ghost, 'trace-follow')[0].className).toContain('hidden');

  // The same release on a session that is really WORKING does surface it.
  const live = g.document.createElement();
  const t2 = createTrace(live, {});
  t2.open(bigTurnSnap('live'), null);
  (t2 as any)._releaseFollow();
  expect(findByClass(live, 'trace-follow')[0].className).not.toContain('hidden');

  g.document = prev;
});

test('a session that ENDS while the Trace is open loses the follow button', () => {
  const g = globalThis as any;
  const prev = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const trace = createTrace(container, {});

  trace.open(bigTurnSnap('live'), null);
  (trace as any)._releaseFollow();
  const btn = findByClass(container, 'trace-follow')[0];
  expect(btn.className).not.toContain('hidden');

  // The turn closes; the visibility is derived from the model, so update() must re-derive it.
  trace.update(bigTurnSnap('done'));
  expect(btn.className).toContain('hidden');

  g.document = prev;
});

test('the header names the object each control acts on', () => {
  const g = globalThis as any;
  const prev = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const trace = createTrace(container, {});
  trace.open(bigTurnSnap(), null);

  const labels = findByClass(container, 'trace-zbtn').map((b: any) => b.textContent);
  // "Collapse all" collided with the `collapse` each open turn carries for its GROUPS:
  // one verb, two levels, two different objects.
  expect(labels).toEqual(['Compact', 'Close turns', 'Last turn']);
  const inTurn = findByClass(container, 'tctl')[0].children.map((a: any) => a.textContent);
  expect(inTurn).toEqual(['expand', 'collapse']);
  // Compact is the one whose name does not say its object, so it must say it itself.
  const compact = findByClass(container, 'trace-zbtn')[0];
  expect(compact.title).toContain('not which turns are open');

  g.document = prev;
});

test('lane-group pins do NOT collide with same-id main-strip groups (namespaced keys)', () => {
  const g = globalThis as any;
  const prev = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  // Main strip has round #1 (api+tool); the spawn's lane ALSO groups into round #1.
  const laneSpans: TraceSpan[] = [
    {
      id: 'la',
      type: 'api',
      label: 'API call',
      detail: null,
      t0: 0,
      t1: 1000,
      turnIndex: 1,
      lane: 1,
      parentId: 'sw1',
      agent: 'gp',
      status: 'ok',
      handle: null,
    },
    {
      id: 'lt',
      type: 'subspan',
      label: 'Bash',
      detail: 'x',
      t0: 0,
      t1: 100,
      turnIndex: 1,
      lane: 1,
      parentId: 'sw1',
      agent: 'gp',
      status: 'ok',
      handle: null,
    },
  ];
  const spans: TraceSpan[] = [
    {
      id: 'p',
      type: 'prompt',
      label: 'go',
      detail: null,
      t0: 0,
      t1: 0,
      turnIndex: 1,
      lane: 0,
      parentId: null,
      agent: null,
      status: 'ok',
      handle: null,
    },
    {
      id: 'a1',
      type: 'api',
      label: 'API call',
      detail: null,
      t0: 0,
      t1: 1,
      turnIndex: 1,
      lane: 0,
      parentId: null,
      agent: null,
      status: 'ok',
      handle: null,
    },
    {
      id: 't1',
      type: 'tool',
      label: 'Read',
      detail: 'f',
      t0: 0,
      t1: 1,
      turnIndex: 1,
      lane: 0,
      parentId: null,
      agent: null,
      status: 'ok',
      handle: { kind: 'tool', toolUseId: 't1' },
    },
    {
      id: 'sw1',
      type: 'spawn',
      label: 'Agent',
      detail: 'do it',
      t0: 0,
      t1: 75,
      turnIndex: 1,
      lane: 0,
      parentId: null,
      agent: null,
      status: 'ok',
      handle: { kind: 'tool', toolUseId: 'sw1' },
    },
    {
      id: 'r',
      type: 'result',
      label: 'done',
      detail: null,
      t0: 9,
      t1: 9,
      turnIndex: 1,
      lane: 0,
      parentId: null,
      agent: null,
      status: 'ok',
      handle: null,
    },
  ];
  const spawns = [
    {
      spawnId: 'sw1',
      label: 'Agent',
      kind: 'Agent',
      lanes: [{ agentId: 'ag1', label: 'gp', status: 'ok', spans: laneSpans }],
    },
  ];
  const snap = (): TraceSnapshot => ({
    turns: [{ index: 1, title: 't', kind: 'work', t0: 0, t1: 9, state: 'done', spans, spawns }],
    t0: 0,
    t1: 9,
    seq: 1,
  });
  const trace = createTrace(container, {});
  trace.open(snap(), null);

  // open the lane, then expand ONLY the lane's round group
  const spawn = findByClass(container, 'snode').find((n: any) => n.className.includes('spawn'));
  spawn.onclick?.({ stopPropagation() {} });
  const laneStrip = findByClass(container, 'lane-strip')[0];
  const laneRound = findByClass(laneStrip, 'gnode')[0];
  laneRound.onclick?.({ stopPropagation() {} });
  expect(findByClass(laneStrip, 'gframe').length).toBe(1);

  // after a live re-render, the MAIN strip's round #1 must stay collapsed
  trace.update(snap());
  const dflowFrames = findByClass(container, 'gframe').filter(
    (f: any) => !findByClass(container, 'lane-strip').some((s: any) => s.contains(f)),
  );
  const laneFrames = findByClass(container, 'lane-strip').flatMap((s: any) => findByClass(s, 'gframe'));
  expect(laneFrames.length).toBe(1); // lane pin survived
  expect(dflowFrames.length).toBe(0); // main-strip round NOT contaminated

  g.document = prev;
});

test('an open lane keeps its .on ring and fold hint across a live re-render', () => {
  const g = globalThis as any;
  const prev = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const trace = createTrace(container, {});
  const snap = spawnSnap();
  trace.open(snap, null);

  const spawn = findByClass(container, 'snode').find((n: any) => n.className.includes('spawn'));
  spawn.onclick?.({ stopPropagation() {} });
  expect(spawn.className).toContain('on');
  expect(textOf(spawn)).toContain('▾ fold');

  trace.update(spawnSnap());
  const spawn2 = findByClass(container, 'snode').find((n: any) => n.className.includes('spawn'));
  expect(spawn2.className).toContain('on'); // derived from openLanes
  expect(textOf(spawn2)).toContain('▾ fold'); // hint too
  expect(findByClass(container, 'lane-strip').length).toBe(1);

  g.document = prev;
});

test('expand all opens every nesting level in one click', () => {
  const g = globalThis as any;
  const prev = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const trace = createTrace(container, {});
  trace.open(bigTurnSnap(), null);

  const links = findByClass(container, 'tctl')[0].children;
  links[0].onclick?.({ stopPropagation() {} }); // expand all
  // chapter R1–10 (1 frame) + its 10 rounds + trailing chapter R11–12 + its 2 rounds
  expect(findByClass(container, 'gframe').length).toBe(14);

  links[1].onclick?.({ stopPropagation() {} }); // collapse all
  expect(findByClass(container, 'gframe').length).toBe(0);

  g.document = prev;
});

test('a fan-out spawn renders EVERY lane, not just the first', () => {
  const g = globalThis as any;
  const prev = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const mkLane = (aid: string) => ({
    agentId: aid,
    label: 'gp-' + aid,
    status: 'ok',
    spans: [
      {
        id: 'la' + aid,
        type: 'api',
        label: 'API call',
        detail: null,
        t0: 0,
        t1: 500,
        turnIndex: 1,
        lane: 1,
        parentId: 'sw1',
        agent: aid,
        status: 'ok',
        handle: null,
      },
      {
        id: 'lt' + aid,
        type: 'subspan',
        label: 'Bash',
        detail: 'x',
        t0: 0,
        t1: 100,
        turnIndex: 1,
        lane: 1,
        parentId: 'sw1',
        agent: aid,
        status: 'ok',
        handle: null,
      },
    ] as TraceSpan[],
  });
  const spans: TraceSpan[] = [
    {
      id: 'p',
      type: 'prompt',
      label: 'go',
      detail: null,
      t0: 0,
      t1: 0,
      turnIndex: 1,
      lane: 0,
      parentId: null,
      agent: null,
      status: 'ok',
      handle: null,
    },
    {
      id: 'sw1',
      type: 'spawn',
      label: 'Agent',
      detail: 'fan out',
      t0: 0,
      t1: 75,
      turnIndex: 1,
      lane: 0,
      parentId: null,
      agent: null,
      status: 'ok',
      handle: { kind: 'tool', toolUseId: 'sw1' },
    },
  ];
  const spawns = [{ spawnId: 'sw1', label: 'Agent', kind: 'Agent', lanes: [mkLane('a'), mkLane('b')] }];
  const snap: TraceSnapshot = {
    turns: [{ index: 1, title: 't', kind: 'work', t0: 0, t1: 9, state: 'done', spans, spawns }],
    t0: 0,
    t1: 9,
    seq: 1,
  };
  const trace = createTrace(container, {});
  trace.open(snap, null);

  const spawn = findByClass(container, 'snode').find((n: any) => n.className.includes('spawn'));
  expect(textOf(spawn)).toContain('2 subagents');
  spawn.onclick?.({ stopPropagation() {} });
  expect(findByClass(container, 'lane-strip').length).toBe(2); // one strip per lane
  expect(findByClass(container, 'lane-name').length).toBe(2); // each named

  g.document = prev;
});

test('a RUNNING subagent lane keeps a raw glowing tail, like the main strip', () => {
  const g = globalThis as any;
  const prev = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const laneSpans: TraceSpan[] = [
    {
      id: 'la',
      type: 'api',
      label: 'API call',
      detail: null,
      t0: 0,
      t1: 1000,
      turnIndex: 1,
      lane: 1,
      parentId: 'sw1',
      agent: 'gp',
      status: 'ok',
      handle: null,
    },
    {
      id: 'lt',
      type: 'subspan',
      label: 'Bash',
      detail: 'x',
      t0: 0,
      t1: 100,
      turnIndex: 1,
      lane: 1,
      parentId: 'sw1',
      agent: 'gp',
      status: 'running',
      handle: null,
    },
  ];
  const spans: TraceSpan[] = [
    {
      id: 'p',
      type: 'prompt',
      label: 'go',
      detail: null,
      t0: 0,
      t1: 0,
      turnIndex: 1,
      lane: 0,
      parentId: null,
      agent: null,
      status: 'ok',
      handle: null,
    },
    {
      id: 'sw1',
      type: 'spawn',
      label: 'Agent',
      detail: 'scan the repo',
      t0: 0,
      t1: 75,
      turnIndex: 1,
      lane: 0,
      parentId: null,
      agent: null,
      status: 'running',
      handle: { kind: 'tool', toolUseId: 'sw1' },
    },
  ];
  // lane.status '' = no agent-end yet → the subagent is still RUNNING.
  const spawns = [
    {
      spawnId: 'sw1',
      label: 'Agent',
      kind: 'Agent',
      lanes: [{ agentId: 'ag1', label: 'gp', status: '', spans: laneSpans }],
    },
  ];
  const snap: TraceSnapshot = {
    turns: [{ index: 1, title: 't', kind: 'work', t0: 0, t1: 9, state: 'live', spans, spawns }],
    t0: 0,
    t1: 9,
    seq: 1,
  };
  const trace = createTrace(container, {});
  trace.open(snap, null);

  const spawn = findByClass(container, 'snode').find((n: any) => n.className.includes('spawn'));
  spawn.onclick?.({ stopPropagation() {} });
  const strip = findByClass(container, 'lane-strip')[0];
  const laneBlocks = findByClass(strip, 'snode');
  expect(laneBlocks.length).toBe(2); // raw tail, not folded
  expect(laneBlocks[laneBlocks.length - 1].className).toContain('tail'); // glowing

  g.document = prev;
});

test('a COLLAPSED turn declares a failure that lives only inside a subagent lane', () => {
  const g = globalThis as any;
  const prev = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const trace = createTrace(container, {});

  // The parent's own spans are all clean — only the child transcript holds the failure.
  // This is the shape that made a red turn look green: measured on a real code-review
  // fan-out where 8 finders ran and the parent reported nothing.
  const snap = spawnSnap();
  const lane = snap.turns[0]!.spawns[0]!.lanes[0]!;
  lane.spans[1]!.status = 'error';
  // Two turns so the failing one stays COLLAPSED (a whole-session open expands the last).
  snap.turns.push({ index: 2, title: 'after', kind: 'work', t0: 200, t1: 300, state: 'done', spans: [], spawns: [] });
  trace.open(snap, null);

  const seg = findByClass(container, 'tseg')[0];
  expect(seg.classList.contains('open')).toBe(false); // still shut …
  expect(seg.className).toContain('has-err'); // … and still says so
  const badge = findByClass(seg, 'terr')[0];
  expect(badge).toBeTruthy();
  // The COUNT is the point: a bare "failed" reads as "the turn failed", when the turn
  // carried on and n of its steps did not.
  expect(textOf(badge)).toBe('1 failed step');
  expect(badge.title).toContain('The turn itself did not fail');

  g.document = prev;
});

test('the failure badge counts the failed steps, singular at one', () => {
  const g = globalThis as any;
  const prev = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const trace = createTrace(container, {});

  // Two failures in the main strip, one more inside the child lane — the count has to
  // cross into the lanes, or a fan-out's failures are undercounted.
  const snap = spawnRunSnap(1);
  snap.turns[0]!.spans[0]!.status = 'error';
  snap.turns[0]!.spans[1]!.status = 'error';
  snap.turns[0]!.spawns[0]!.lanes[0]!.spans[0]!.status = 'error';
  snap.turns.push({ index: 2, title: 'tail', kind: 'work', t0: 0, t1: 1, state: 'done', spans: [], spawns: [] });
  trace.open(snap, null);

  expect(textOf(findByClass(container, 'terr')[0])).toBe('3 failed steps');

  g.document = prev;
});

test("the first and last block open the turn's own text; a mid-turn reply does not", () => {
  const g = globalThis as any;
  const prev = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const blocks: any[] = [];
  const trace = createTrace(container, { onBlock: (h: any) => blocks.push(h) });

  // prompt … reply (a result with work after it) … done — the two ends are the
  // conversation itself, and a click did nothing on either.
  const spans: TraceSpan[] = [
    {
      id: 'p',
      type: 'prompt',
      label: 'go',
      detail: null,
      t0: 0,
      t1: 0,
      turnIndex: 7,
      lane: 0,
      parentId: null,
      agent: null,
      status: 'ok',
      handle: { kind: 'turn-text', turnIndex: 7, which: 'prompt' },
    },
    {
      id: 'r1',
      type: 'result',
      label: 'done',
      detail: 'first',
      t0: 1,
      t1: 1,
      turnIndex: 7,
      lane: 0,
      parentId: null,
      agent: null,
      status: 'ok',
      handle: { kind: 'turn-text', turnIndex: 7, which: 'result' },
    },
    {
      id: 'a',
      type: 'api',
      label: 'API call',
      detail: null,
      t0: 2,
      t1: 3,
      turnIndex: 7,
      lane: 0,
      parentId: null,
      agent: null,
      status: 'ok',
      handle: null,
    },
    {
      id: 'r2',
      type: 'result',
      label: 'done',
      detail: 'real end',
      t0: 4,
      t1: 4,
      turnIndex: 7,
      lane: 0,
      parentId: null,
      agent: null,
      status: 'ok',
      handle: { kind: 'turn-text', turnIndex: 7, which: 'result' },
    },
  ];
  trace.open(
    {
      t0: 0,
      t1: 4,
      seq: 1,
      turns: [{ index: 7, title: 'go', kind: 'work', t0: 0, t1: 4, state: 'done', spans, spawns: [] }],
    },
    null,
  );

  const nodes = findByClass(container, 'snode');
  const promptNode = nodes.find((n: any) => n.className.includes('start'));
  const ends = nodes.filter((n: any) => n.className.includes('end'));

  promptNode.onclick?.();
  expect(blocks[0]).toEqual({ kind: 'turn-text', turnIndex: 7, which: 'prompt' });

  // The mid-turn reply stays inert: the reducer keeps only the turn's LAST answer, so
  // opening an earlier one would show text the block does not claim.
  const mid = ends.find((n: any) => n.className.includes('mid'));
  expect(mid.onclick).toBeNull();

  const done = ends.find((n: any) => !n.className.includes('mid'));
  done.onclick?.();
  expect(blocks[1]).toEqual({ kind: 'turn-text', turnIndex: 7, which: 'result' });

  g.document = prev;
});

test('clicking the badge opens the groups hiding a failure and lands on the step', () => {
  const g = globalThis as any;
  const prev = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const trace = createTrace(container, {});

  // 12 rounds fold into a chapter + a trailing chapter: the failure is two levels down,
  // which is what made the count a dead end (7 clicks by hand on a measured turn).
  const snap = bigTurnSnap();
  snap.turns[0]!.spans[6]!.status = 'error'; // a tool inside round #3
  snap.turns.push({ index: 2, title: 'tail', kind: 'work', t0: 0, t1: 1, state: 'done', spans: [], spawns: [] });
  trace.open(snap, null);

  const seg = findByClass(container, 'tseg')[0];
  expect(seg.classList.contains('open')).toBe(false);
  expect(findByClass(container, 'snode').filter((n: any) => n.className.includes('err')).length).toBe(0);

  findByClass(container, 'terr')[0].onclick?.({ stopPropagation() {} });

  // The turn opened, the chapter AND its round expanded, and the failed step is on screen
  // and marked — one click instead of the walk.
  const hit = findByClass(container, 'snode').filter((n: any) => n.className.includes('hit'));
  expect(hit.length).toBe(1);
  expect(hit[0].className).toContain('err');
  expect(textOf(hit[0])).toContain('Bash');

  g.document = prev;
});

test('repeated badge clicks cycle through every failure, lanes included', () => {
  const g = globalThis as any;
  const prev = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const trace = createTrace(container, {});

  // One failure in the main strip, one inside the subagent's lane — the lane one is the
  // hardest to reach by hand, and the badge counts it, so the jump must reach it too.
  const snap = spawnRunSnap(1);
  snap.turns[0]!.spans[0]!.status = 'error';
  snap.turns[0]!.spawns[0]!.lanes[0]!.spans[0]!.status = 'error';
  snap.turns.push({ index: 2, title: 'tail', kind: 'work', t0: 0, t1: 1, state: 'done', spans: [], spawns: [] });
  trace.open(snap, null);

  const badge = () => findByClass(container, 'terr')[0];
  const hitId = () => {
    const h = findByClass(container, 'snode').filter((n: any) => n.className.includes('hit'));
    return h.length === 1 ? textOf(h[0]) : null;
  };

  badge().onclick?.({ stopPropagation() {} });
  const first = hitId();
  expect(first).toBeTruthy();

  badge().onclick?.({ stopPropagation() {} });
  const second = hitId();
  expect(second).toBeTruthy();
  expect(second).not.toBe(first); // moved on to the next failure…
  // …and the second one lives in a lane, so the lane had to be unfolded to reach it.
  expect(findByClass(container, 'lane-strip').length).toBe(1);

  badge().onclick?.({ stopPropagation() {} });
  expect(hitId()).toBe(first); // wraps around

  g.document = prev;
});

test('duration numbers share a fixed column, so the bars line up', () => {
  const g = globalThis as any;
  const prev = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const trace = createTrace(container, {});

  // "60s" and "76m 4s" are very different widths; sized to their text, every bar slid.
  trace.open(
    {
      t0: 0,
      t1: 4_564_000,
      seq: 1,
      turns: [
        {
          index: 1,
          title: 'short',
          kind: 'work',
          t0: 0,
          t1: 60_000,
          state: 'done',
          spawns: [],
          spans: [
            {
              id: 'a',
              type: 'api',
              label: 'API call',
              detail: null,
              t0: 0,
              t1: 60_000,
              turnIndex: 1,
              lane: 0,
              parentId: null,
              agent: null,
              status: 'ok',
              handle: null,
            },
          ],
        },
        {
          index: 2,
          title: 'long',
          kind: 'work',
          t0: 0,
          t1: 4_564_000,
          state: 'done',
          spawns: [],
          spans: [
            {
              id: 'b',
              type: 'api',
              label: 'API call',
              detail: null,
              t0: 0,
              t1: 4_564_000,
              turnIndex: 2,
              lane: 0,
              parentId: null,
              agent: null,
              status: 'ok',
              handle: null,
            },
          ],
        },
      ],
    },
    null,
  );

  const durs = findByClass(container, 'tdur');
  expect(durs.length).toBe(2);
  // NOTE: the alignment itself is a LAYOUT fact — the number's fixed column lives in CSS,
  // and a fake DOM computes nothing, so asserting it here would pass either way. It is
  // checked in the browser instead (scripts/live-check driven run). What IS checkable
  // here: the number sits in its own cell, which is what the fixed column applies to.
  expect(durs.every((d: any) => findByClass(d, 'tbar').length === 1 && d.children.length === 2)).toBe(true);
  // The shorter turn's fill is a real share of the longest, not a fixed mark.
  const fills = durs.map((d: any) => findByClass(d, 'tbar')[0].children[0].style.width);
  expect(fills[1]).toBe('100%');
  expect(parseInt(fills[0]!, 10)).toBeLessThan(10);
  // The bar carries what it measures: it has no axis and no label of its own.
  expect(durs[0].title).toContain('of the longest turn');

  g.document = prev;
});

test('the header names the session after its first WORKING turn, not a control command', () => {
  const g = globalThis as any;
  const prev = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const trace = createTrace(container, {});

  // 88% of real sessions open on `/clear` or `/model`, which carry no api and no tool.
  const snap: TraceSnapshot = {
    t0: 0,
    t1: 100,
    seq: 1,
    turns: [
      { index: 1, title: '/clear', kind: 'local', t0: 0, t1: 0, state: 'done', spans: [], spawns: [] },
      {
        index: 2,
        title: 'refactor the parser',
        kind: 'work',
        t0: 1,
        t1: 100,
        state: 'done',
        spawns: [],
        spans: [
          {
            id: 'a',
            type: 'api',
            label: 'API call',
            detail: null,
            t0: 1,
            t1: 90,
            turnIndex: 2,
            lane: 0,
            parentId: null,
            agent: null,
            status: 'ok',
            handle: null,
          },
        ],
      },
    ],
  };
  trace.open(snap, null);

  expect(textOf(findByClass(container, 'trace-hsubj')[0])).toBe('refactor the parser');

  g.document = prev;
});

test('a control command with no work collapses to one line; an INTERRUPTED work turn does not', () => {
  const g = globalThis as any;
  const prev = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const trace = createTrace(container, {});

  // Both turns ran zero api and zero tool. Only the control command is noise: a `work`
  // turn with no calls was interrupted (Esc), and that is worth a full row.
  const snap: TraceSnapshot = {
    t0: 0,
    t1: 10,
    seq: 1,
    turns: [
      { index: 1, title: '/model', kind: 'local', t0: 0, t1: 0, state: 'done', spans: [], spawns: [] },
      { index: 2, title: 'do the thing', kind: 'work', t0: 1, t1: 2, state: 'live', spans: [], spawns: [] },
      { index: 3, title: 'tail', kind: 'work', t0: 3, t1: 10, state: 'done', spans: [], spawns: [] },
    ],
  };
  trace.open(snap, null);

  const segs = findByClass(container, 'tseg');
  expect(segs[0].className).toContain('is-idle');
  expect(segs[1].className).not.toContain('is-idle');
  // …and a turn a finished session never closed still reports state 'live' (16 of 144
  // turns in one real session). With no work in it, the live rule must not fire.
  expect(segs[1].className).not.toContain('is-live');

  g.document = prev;
});

test('the strip and its open lanes live in ONE horizontal scroller, so the anchor holds', () => {
  const g = globalThis as any;
  const prev = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const trace = createTrace(container, {});
  trace.open(spawnSnap(), null);

  const spawn = findByClass(container, 'snode').find((n: any) => n.className.includes('spawn'));
  spawn.onclick?.({ stopPropagation() {} });

  // Split across two scrollers, the lane's offsetLeft anchor would point at the wrong
  // block the moment either one scrolled.
  const roll = findByClass(container, 'striproll')[0];
  expect(roll).toBeTruthy();
  expect(findByClass(roll, 'dflow').length).toBe(1);
  expect(findByClass(roll, 'lanes').length).toBe(1);
  expect(findByClass(findByClass(roll, 'lanes')[0], 'lane-strip').length).toBe(1);

  g.document = prev;
});

test('block sub-lines drop the meaningless zero duration, and counts read singular at 1', () => {
  const g = globalThis as any;
  const prev = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const trace = createTrace(container, {});
  trace.open(snap2(), null);
  findByClass(container, 'thead')[0].onclick?.(); // expand turn 0

  const nodes = findByClass(container, 'snode');
  const promptNode = nodes.find((n: any) => n.className.includes('start'));
  const resultNode = nodes.find((n: any) => n.className.includes('end'));
  // A prompt and a result have no duration; "· 0ms" put a meaningless number on the
  // first and last block of every turn.
  expect(textOf(promptNode)).not.toContain('0ms');
  expect(textOf(resultNode)).not.toContain('0ms');

  // snap2's turn 0 holds a single tool → one round of one step.
  const round = findByClass(container, 'gnode')[0];
  expect(textOf(round)).toContain('1 step');
  expect(textOf(round)).not.toContain('1 steps');

  g.document = prev;
});

test('a duration bar is a SHARE of the widest block in its strip, not a fixed mark', () => {
  const g = globalThis as any;
  const prev = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const trace = createTrace(container, {});

  // One 10s round and one 1s round: without a proportional bar both blocks look
  // identical, and the strip encodes sequence while saying nothing about time.
  const spans: TraceSpan[] = [
    {
      id: 'a1',
      type: 'api',
      label: 'API call',
      detail: null,
      t0: 0,
      t1: 10_000,
      turnIndex: 1,
      lane: 0,
      parentId: null,
      agent: null,
      status: 'ok',
      handle: null,
    },
    {
      id: 'k',
      type: 'tool',
      label: 'Skill',
      detail: 'x',
      t0: 10_000,
      t1: 10_001,
      turnIndex: 1,
      lane: 0,
      parentId: null,
      agent: null,
      status: 'ok',
      handle: { kind: 'tool', toolUseId: 'k' },
    },
    {
      id: 'a2',
      type: 'api',
      label: 'API call',
      detail: null,
      t0: 10_001,
      t1: 11_001,
      turnIndex: 1,
      lane: 0,
      parentId: null,
      agent: null,
      status: 'ok',
      handle: null,
    },
  ];
  trace.open(
    {
      t0: 0,
      t1: 11_001,
      seq: 1,
      turns: [{ index: 1, title: 't', kind: 'work', t0: 0, t1: 11_001, state: 'done', spans, spawns: [] }],
    },
    null,
  );

  const bars = findByClass(container, 'dbar').map((b: any) => b.children[0].style.width);
  // Round #1 is 10s (the widest → 100%); the Skill landmark is 1ms; round #2 is 1s (10%).
  expect(bars[0]).toBe('100%');
  expect(bars[bars.length - 1]).toBe('10%');
  expect(bars.every((w: string) => parseInt(w, 10) > 0)).toBe(true);

  g.document = prev;
});

/** A turn launching `n` spawns, optionally with a tool between each pair. */
function spawnRunSnap(n: number, separated = false): TraceSnapshot {
  const spans: TraceSpan[] = [
    {
      id: 'p',
      type: 'prompt',
      label: 'go',
      detail: null,
      t0: 0,
      t1: 0,
      turnIndex: 1,
      lane: 0,
      parentId: null,
      agent: null,
      status: 'ok',
      handle: null,
    },
  ];
  const spawns: any[] = [];
  for (let i = 0; i < n; i++) {
    if (separated && i > 0) {
      spans.push({
        id: 'sep' + i,
        type: 'api',
        label: 'API call',
        detail: null,
        t0: 10 * i,
        t1: 10 * i + 5,
        turnIndex: 1,
        lane: 0,
        parentId: null,
        agent: null,
        status: 'ok',
        handle: null,
      });
    }
    spans.push({
      id: 'sw' + i,
      type: 'spawn',
      label: 'Agent',
      detail: 'finder ' + i,
      t0: i,
      t1: i + 1,
      turnIndex: 1,
      lane: 0,
      parentId: null,
      agent: null,
      status: 'ok',
      handle: { kind: 'tool', toolUseId: 'sw' + i },
    });
    spawns.push({
      spawnId: 'sw' + i,
      label: 'Agent',
      kind: 'Agent',
      lanes: [
        {
          agentId: 'ag' + i,
          label: 'gp' + i,
          status: 'ok',
          spans: [
            {
              id: 'ls' + i,
              type: 'subspan',
              label: 'Bash',
              detail: 'x',
              t0: 0,
              t1: 1000,
              turnIndex: 1,
              lane: i + 1,
              parentId: 'sw' + i,
              agent: 'gp' + i,
              status: i === 1 ? 'error' : 'ok',
              handle: null,
            },
          ],
        },
      ],
    });
  }
  return {
    turns: [{ index: 1, title: 't', kind: 'work', t0: 0, t1: 100, state: 'done', spans, spawns }],
    t0: 0,
    t1: 100,
    seq: 1,
  };
}

test('spawns ADJACENT in the strip merge into one parallel block; separated ones do not', () => {
  const g = globalThis as any;
  const prev = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();

  const trace = createTrace(container, {});
  trace.open(spawnRunSnap(4), null);
  const par = findByClass(container, 'snode').filter((n: any) => n.className.includes('par'));
  expect(par.length).toBe(1); // four spawns → ONE block
  expect(textOf(par[0])).toContain('4 in parallel');
  expect(textOf(par[0])).toContain('4 subagents');
  // One rule per subagent, and the failing one is marked — a merged label would hide both.
  const rules = findByClass(findByClass(par[0], 'pk')[0], 'err');
  expect(findByClass(par[0], 'pk')[0].children.length).toBe(4);
  expect(rules.length).toBe(1);

  // With work between them they are separate launches, not a fan-out: 45 such pairs
  // exist in the measured corpus and merging them would invent a fan-out.
  const c2 = g.document.createElement();
  createTrace(c2, {}).open(spawnRunSnap(4, true), null);
  expect(findByClass(c2, 'snode').filter((n: any) => n.className.includes('par')).length).toBe(0);
  expect(findByClass(c2, 'snode').filter((n: any) => n.className.includes('spawn')).length).toBe(4);

  g.document = prev;
});

test('the parallel block opens EVERY lane of the run at once', () => {
  const g = globalThis as any;
  const prev = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const trace = createTrace(container, {});
  trace.open(spawnRunSnap(3), null);

  const par = findByClass(container, 'snode').filter((n: any) => n.className.includes('par'))[0];
  expect(findByClass(container, 'lane-strip').length).toBe(0);
  par.onclick?.({ stopPropagation() {} });
  // It is drawn as one block, so it must open as one: three lanes, not the first only.
  expect(findByClass(container, 'lane-strip').length).toBe(3);
  expect(par.className).toContain('on');
  expect(textOf(par)).toContain('▾ fold');

  par.onclick?.({ stopPropagation() {} });
  expect(findByClass(container, 'lane-strip').length).toBe(0);

  g.document = prev;
});

test('a collapsed row carries a sparkline of the turn shape, capped and error-marked', () => {
  const g = globalThis as any;
  const prev = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const trace = createTrace(container, {});

  const snap = bigTurnSnap(); // 1 prompt + 12 api + 12 tool = 25 steps
  snap.turns[0]!.spans[4]!.status = 'error';
  snap.turns.push({ index: 2, title: 'tail', kind: 'work', t0: 0, t1: 1, state: 'done', spans: [], spawns: [] });
  trace.open(snap, null);

  const spark = findByClass(container, 'tspark')[0];
  expect(spark).toBeTruthy();
  expect(findByClass(container, 'chips').length).toBe(0); // it REPLACES the counts
  const bins = findByClass(spark, 'bins')[0];
  expect(bins.children.length).toBe(25); // one bin per step, under the cap
  expect(findByClass(bins, 'err').length).toBeGreaterThan(0);
  expect(textOf(spark)).toContain('25 steps');

  g.document = prev;
});

test('a sparkline bin declares EVERY type it holds, never a single winner', () => {
  const g = globalThis as any;
  const prev = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const trace = createTrace(container, {});

  // Every round is one api plus its tools, so a majority vote hands api most bins — it
  // painted 30 of 30 blue on a real 179-step turn, which is to say it said nothing.
  // 30 rounds → 60 steps over 30 bins, so EVERY bin holds one api and one tool and the
  // tie-break is what decides its colour. (Fewer steps than bins gives one span per bin
  // and tests nothing.)
  const spans: TraceSpan[] = [];
  for (let i = 0; i < 30; i++) {
    spans.push({
      id: 'a' + i,
      type: 'api',
      label: 'API call',
      detail: null,
      t0: i,
      t1: i,
      turnIndex: 1,
      lane: 0,
      parentId: null,
      agent: null,
      status: 'ok',
      handle: null,
    });
    spans.push({
      id: 't' + i,
      type: 'tool',
      label: 'Bash',
      detail: 'x',
      t0: i,
      t1: i,
      turnIndex: 1,
      lane: 0,
      parentId: null,
      agent: null,
      status: 'ok',
      handle: null,
    });
  }
  trace.open(
    {
      t0: 0,
      t1: 10,
      seq: 1,
      turns: [
        { index: 1, title: 'work', kind: 'work', t0: 0, t1: 10, state: 'done', spans, spawns: [] },
        { index: 2, title: 'tail', kind: 'work', t0: 0, t1: 1, state: 'done', spans: [], spawns: [] },
      ],
    },
    null,
  );

  const bins = findByClass(findByClass(container, 'tspark')[0], 'bins')[0].children;
  const kinds = new Set(bins.map((b: any) => b.className));
  // Every bin holds an api AND a tool, so every bin must SAY both — one winner per bin
  // cannot describe a mixture, and whichever type wins paints the whole row that colour.
  expect([...kinds]).toEqual(['t-tool t-api']);

  g.document = prev;
});

test('the sparkline is capped, so a huge turn stays the same width as a small one', () => {
  const g = globalThis as any;
  const prev = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const trace = createTrace(container, {});

  // p99 is 220 steps: one mark per step would make the row's bar unbounded.
  const spans: TraceSpan[] = [];
  for (let i = 0; i < 300; i++) {
    spans.push({
      id: 's' + i,
      type: i % 2 ? 'tool' : 'api',
      label: 'x',
      detail: null,
      t0: i,
      t1: i + 1,
      turnIndex: 1,
      lane: 0,
      parentId: null,
      agent: null,
      status: 'ok',
      handle: null,
    });
  }
  trace.open(
    {
      t0: 0,
      t1: 300,
      seq: 1,
      turns: [
        { index: 1, title: 'huge', kind: 'work', t0: 0, t1: 300, state: 'done', spans, spawns: [] },
        { index: 2, title: 'tail', kind: 'work', t0: 0, t1: 1, state: 'done', spans: [], spawns: [] },
      ],
    },
    null,
  );

  const bins = findByClass(findByClass(container, 'tspark')[0], 'bins')[0];
  expect(bins.children.length).toBe(30);
  expect(textOf(findByClass(container, 'tspark')[0])).toContain('300 steps');

  g.document = prev;
});

test('trace render: update preserves expanded turns and scroll state', () => {
  const g = globalThis as any;
  const prev = g.document;
  g.document = fakeDoc();

  const container = g.document.createElement();
  const trace = createTrace(container, {});

  trace.open(snap2(), null);
  // Turn 0 is open; turn 1 is collapsed. Expand turn 1 via header click.
  const theads = findByClass(container, 'thead');
  theads[1].onclick?.(); // expand turn 1

  // After update with 2 turns, both turns should still be in the spine.
  trace.update(snap2());
  const theadsAfter = findByClass(container, 'thead');
  expect(theadsAfter.length).toBe(2);

  g.document = prev;
});

/** One span of a given type, for the bin-composition unit tests. */
function binSpan(type: TraceSpan['type'], status: TraceSpan['status'] = 'ok'): TraceSpan {
  return {
    id: type + status,
    type,
    label: type,
    detail: null,
    t0: 0,
    t1: 0,
    turnIndex: 1,
    lane: 0,
    parentId: null,
    agent: null,
    status,
    handle: null,
  };
}

test('a sparkline bin closes at 100%, so its bands ARE the proportions', () => {
  // A linear-gradient holds its last colour past the last stop: a composition that stops
  // short is not a shorter bar, it is the LAST type quietly taking the remainder. Three
  // equal types drew 33 / 22 / 44 and closed at 77.8% — because the error band's weight
  // was subtracted from every type instead of once, and after the first push `parts[0]`
  // was no longer the error band but that first type.
  const even = binComposition([binSpan('spawn'), binSpan('tool'), binSpan('api')]);
  expect(even.map((p) => p.key)).toEqual(['spawn', 'tool', 'api']); // SPARK_RANK order
  for (const p of even) expect(p.weight).toBeCloseTo(1 / 3, 6);
  expect(even.reduce((n, p) => n + p.weight, 0)).toBeCloseTo(1, 6);

  // With a failure the red band comes first and never drops below a third of the bin;
  // the successful types share exactly what is left.
  const withErr = binComposition([binSpan('tool', 'error'), binSpan('tool'), binSpan('api')]);
  expect(withErr[0]!.key).toBe('err');
  expect(withErr[0]!.weight).toBeCloseTo(0.34, 6); // floor, not 1/3
  expect(withErr.reduce((n, p) => n + p.weight, 0)).toBeCloseTo(1, 6);

  // A bin of one type is that type, whole.
  expect(binComposition([binSpan('api'), binSpan('api')])).toEqual([{ key: 'api', weight: 1 }]);
});

test('the badge jump releases auto-follow, and its marker survives the next live event', () => {
  const g = globalThis as any;
  const prev = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const trace = createTrace(container, {});

  // A live session: auto-follow is engaged, so every event re-parks the view on the last
  // turn. Measured before this: the jump landed, and ~1s later the failure was off screen
  // and the marker gone — on the one session where finding a failure fast matters most.
  const live = () => {
    const s = bigTurnSnap('live');
    s.turns[0]!.spans[6]!.status = 'error';
    return s;
  };
  trace.open(live(), null);

  const btn = findByClass(container, 'trace-follow')[0];
  expect(btn.className).toContain('hidden'); // following: nothing to re-engage
  findByClass(container, 'terr')[0].onclick?.({ stopPropagation() {} });
  // Jumping is navigation, as deliberate as a scroll — and a scroll releases follow.
  expect(btn.className).not.toContain('hidden');

  const hit = () => findByClass(container, 'snode').filter((n: any) => n.className.includes('hit'));
  expect(hit().length).toBe(1);
  expect(textOf(hit()[0])).toContain('Bash');

  trace.update(live()); // one live event rebuilds the whole spine
  expect(hit().length).toBe(1);
  expect(textOf(hit()[0])).toContain('Bash');

  // …and it also survives the turn being shut and re-opened by hand, which rebuilds the
  // body outside build(): the marker is state, so every path that redraws a block re-derives it.
  const head = findByClass(container, 'thead')[0];
  head.onclick?.();
  head.onclick?.();
  expect(hit().length).toBe(1);

  g.document = prev;
});

test('a failure inside a Workflow lane is reachable: the jump marks the agent tile', () => {
  const g = globalThis as any;
  const prev = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const trace = createTrace(container, {});

  // A Workflow unfolds a GRID of agent tiles, not a strip of blocks, so its lane spans
  // have no block of their own — the badge counted a failure the click could never reach.
  const spans: TraceSpan[] = [
    {
      id: 'p',
      type: 'prompt',
      label: 'go',
      detail: null,
      t0: 0,
      t1: 0,
      turnIndex: 1,
      lane: 0,
      parentId: null,
      agent: null,
      status: 'ok',
      handle: null,
    },
    {
      id: 'sw',
      type: 'spawn',
      label: 'Workflow',
      detail: 'run the sweep',
      t0: 1,
      t1: 9,
      turnIndex: 1,
      lane: 0,
      parentId: null,
      agent: null,
      status: 'ok',
      handle: { kind: 'tool', toolUseId: 'sw' },
    },
  ];
  const spawns = [
    {
      spawnId: 'sw',
      label: 'Workflow',
      kind: 'Workflow',
      lanes: [
        {
          agentId: 'ag0',
          label: 'finder',
          status: 'ok',
          spans: [
            {
              id: 'lf',
              type: 'subspan' as const,
              label: 'Bash',
              detail: 'x',
              t0: 2,
              t1: 5,
              turnIndex: 1,
              lane: 1,
              parentId: 'sw',
              agent: 'finder',
              status: 'error' as const,
              handle: null,
            },
          ],
        },
      ],
    },
  ];
  trace.open(
    {
      t0: 0,
      t1: 11,
      seq: 1,
      turns: [
        { index: 1, title: 'wf', kind: 'work', t0: 0, t1: 10, state: 'done', spans, spawns },
        { index: 2, title: 'tail', kind: 'work', t0: 10, t1: 11, state: 'done', spans: [], spawns: [] },
      ],
    },
    null,
  );

  expect(textOf(findByClass(container, 'terr')[0])).toBe('1 failed step');
  findByClass(container, 'terr')[0].onclick?.({ stopPropagation() {} });

  expect(findByClass(container, 'wf-grid').length).toBe(1);
  const tiles = findByClass(container, 'amini').filter((n: any) => n.className.includes('hit'));
  expect(tiles.length).toBe(1);

  g.document = prev;
});

test('a jump into ONE lane of a merged run opens the whole block', () => {
  const g = globalThis as any;
  const prev = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const trace = createTrace(container, {});

  // spawnRunSnap puts the failure in the SECOND spawn's lane. The three spawns are drawn
  // as one block, so unfolding one of them left a lane hanging under a block that still
  // read "▸ expand flow" — and whose next click opened the run instead of closing it.
  const snap = spawnRunSnap(3);
  snap.turns.push({ index: 2, title: 'tail', kind: 'work', t0: 10, t1: 11, state: 'done', spans: [], spawns: [] });
  trace.open(snap, null);

  findByClass(container, 'terr')[0].onclick?.({ stopPropagation() {} });

  const par = findByClass(container, 'snode').filter((n: any) => n.className.includes('par'))[0];
  expect(par.className).toContain('on');
  expect(textOf(par)).toContain('▾ fold');
  expect(findByClass(container, 'lane-strip').length).toBe(3);

  g.document = prev;
});

test('a live event does not send an open strip back to its first block', () => {
  const g = globalThis as any;
  const prev = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const trace = createTrace(container, {});

  // Turn 1 is a finished big turn the user is reading; turn 2 is what the session is
  // working on. The strip is a separate scroller from the stage, and update() restored
  // only the stage: measured at 8,974px wide against 1,288px visible, so every event
  // threw the reader back seven screens.
  const snap = () => {
    const s = bigTurnSnap('done');
    s.turns.push({
      index: 2,
      title: 'working',
      kind: 'work',
      t0: 10,
      t1: 20,
      state: 'live',
      spawns: [],
      spans: [
        {
          id: 'la',
          type: 'api',
          label: 'API call',
          detail: null,
          t0: 10,
          t1: 20,
          turnIndex: 2,
          lane: 0,
          parentId: null,
          agent: null,
          status: 'ok',
          handle: null,
        },
      ],
    });
    return s;
  };
  trace.open(snap(), null);
  findByClass(container, 'thead')[0].onclick?.(); // open turn 1 by hand

  findByClass(container, 'striproll')[0].scrollLeft = 640;
  trace.update(snap());
  expect(findByClass(container, 'striproll')[0].scrollLeft).toBe(640);

  g.document = prev;
});

// ── what a named round and a chapter holding intents actually render ────────

/** A snapshot whose turn 0 holds `n` rounds, the ones listed in `spoke` carrying an intent. */
function snapRounds(n: number, spoke: Record<number, string>): TraceSnapshot {
  const spans: TraceSpan[] = [];
  const base = (id: string, type: TraceSpan['type'], label: string, t0: number): TraceSpan => ({
    id,
    type,
    label,
    detail: null,
    t0,
    t1: t0 + 4,
    turnIndex: 0,
    lane: 0,
    parentId: null,
    agent: null,
    status: 'ok',
    handle: null,
  });
  for (let i = 0; i < n; i++) {
    const api = base('a' + i, 'api', 'API call', 10 * i);
    if (spoke[i]) api.narration = spoke[i];
    spans.push(api, base('t' + i, 'tool', 'Read', 10 * i + 5));
  }
  return {
    t0: 0,
    t1: 10 * n,
    seq: 1,
    turns: [{ index: 0, title: 'fix it', kind: 'work', t0: 0, t1: 10 * n, state: 'done', spans, spawns: [] }],
  };
}

test('trace render: a round wears its intent as its name, the number moves to the sub-line', () => {
  const g = globalThis as any;
  const prev = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  createTrace(container, {}).open(
    snapRounds(1, { 0: 'Checking whether the parser drops the line.\nThen I fix the branch.' }),
    null,
  );

  const round = findByClass(container, 'gnode')[0];
  // Only the FIRST line: an intent's body is markdown, and the block is 172px wide.
  expect(textOf(findByClass(round, 'gl')[0])).toBe('Checking whether the parser drops the line.');
  // The number is not lost — it moves where it weighs the same as "2 steps".
  expect(textOf(findByClass(round, 'gs')[0])).toContain('#1');
  // The two-line clamp is a class, so the CSS (not the renderer) decides how much shows.
  expect(round.className.includes('gnamed')).toBe(true);
  // The full text — body included — is what a hover has to give.
  expect(round.title).toContain('Then I fix the branch.');
  g.document = prev;
});

test('trace render: a silent round keeps its number and gains no intent affordance', () => {
  const g = globalThis as any;
  const prev = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  createTrace(container, {}).open(snapRounds(1, {}), null);

  const round = findByClass(container, 'gnode')[0];
  expect(textOf(findByClass(round, 'gl')[0])).toBe('#1 round');
  expect(round.className.includes('gnamed')).toBe(false);
  expect(round.title).toBeFalsy();
  g.document = prev;
});

test('trace render: a chapter COUNTS the intents it folds and keeps its range', () => {
  // D2, and the reason for it: the first intent of ten rounds describes one of them. The block
  // says there is a story inside without claiming to be it.
  const g = globalThis as any;
  const prev = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  createTrace(container, {}).open(snapRounds(3, { 0: 'First move.', 2: 'Second move.' }), null);

  const chapter = findByClass(container, 'gnode')[0];
  expect(textOf(findByClass(chapter, 'gl')[0])).toBe('R1–3');
  // The WHOLE sub-line, not a substring: `toContain('2 intent')` also passes on '2 intents',
  // which is the bug it was meant to catch — every other count in the strip is pluralised.
  // `steps` gives up its slot: with all four facts the sub-line wrapped and grew the block.
  expect(textOf(findByClass(chapter, 'gs')[0])).toBe('3 rounds · 2 intents · 24ms');
  expect(chapter.title).toBe('First move.\nSecond move.');
  g.document = prev;
});

test('trace render: a chapter with no intents is untouched', () => {
  const g = globalThis as any;
  const prev = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  createTrace(container, {}).open(snapRounds(3, {}), null);

  const chapter = findByClass(container, 'gnode')[0];
  expect(textOf(findByClass(chapter, 'gs')[0])).toContain('step');
  expect(chapter.title).toBeFalsy();
  g.document = prev;
});

// ── The final result ──────────────────────────────────────────────────────────
// The document used to END on the words `▲ FINAL RESULT` with nothing under them: every row's
// title is a PROMPT, so the session's answer appeared nowhere in the spine — it lived at the far
// right of an expanded turn's strip, three interactions away. These fix the label to its content.

/** snap2 with a real closing answer on the LAST turn, plus an earlier one to be ignored. */
function snapWithFinal(lastResult: string | null): TraceSnapshot {
  const s = snap2();
  s.turns[0]!.spans[2]!.detail = 'an earlier answer';
  s.turns[0]!.spans[2]!.handle = { kind: 'turn-text', turnIndex: 0, which: 'result' };
  if (lastResult !== null) {
    s.turns[1]!.spans = [
      {
        id: 'r1',
        type: 'result',
        label: 'done',
        detail: lastResult,
        t0: 99,
        t1: 100,
        turnIndex: 1,
        lane: 0,
        parentId: null,
        agent: null,
        status: 'ok',
        handle: { kind: 'turn-text', turnIndex: 1, which: 'result' },
      },
    ];
  }
  return s;
}

test("trace render: the FINAL RESULT cap carries the session's closing answer, and opens it", () => {
  const g = globalThis as any;
  const prev = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const blocks: any[] = [];
  const trace = createTrace(container, { onBlock: (h: any) => blocks.push(h) });

  // Real answers open in markdown (measured: `**…**` and backticks on the first line of the
  // one this was built against), and this block renders prose, not a step label.
  trace.open(snapWithFinal('**Shipped**: the parser now reads `both` shapes.'), null);

  const fin = findByClass(container, 'finres')[0];
  expect(fin).toBeTruthy();
  // The LAST turn's answer, not the first one it finds — and stripped to plain.
  expect(textOf(fin)).toContain('Shipped: the parser now reads both shapes.');
  // It names the turn it came from: a live session's last turn may not be the one that spoke.
  expect(textOf(fin)).toContain('T1');
  // Same drawer as the `done` block, through the handle the span already carries — the text is
  // never copied here, it is read off the reducer at click time.
  fin.onclick?.({ stopPropagation() {} });
  expect(blocks).toEqual([{ kind: 'turn-text', turnIndex: 1, which: 'result' }]);

  g.document = prev;
});

test('trace render: a session that has not answered yet says so, and opens nothing', () => {
  const g = globalThis as any;
  const prev = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const blocks: any[] = [];
  const trace = createTrace(container, { onBlock: (h: any) => blocks.push(h) });

  // No result span anywhere: an interrupted session, or one still on its first turn.
  const s = snapWithFinal(null);
  s.turns[0]!.spans = s.turns[0]!.spans.filter((sp) => sp.type !== 'result');
  trace.open(s, null);

  const fin = findByClass(container, 'finres')[0];
  expect(fin).toBeTruthy(); // the empty state is drawn, not omitted
  expect(fin.className).toContain('empty');
  expect(textOf(fin)).toBe('No final answer yet');
  fin.onclick?.({ stopPropagation() {} });
  expect(blocks).toEqual([]);

  g.document = prev;
});
