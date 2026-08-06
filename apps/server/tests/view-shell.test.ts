import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createView } from '../src/client/view.ts';
import type { TreeSnapshot } from '../src/core/session-tree.ts';
import { fakeDoc, findByClass } from './fake-dom.ts';

// A tab opens on a session whose history has not been read yet: `startReplay` streams
// the whole file through the reducer first. For a large session that takes seconds — during
// which the user must see a loader, not a dashboard drawing itself card by card. The loader
// goes away at the replay→live handoff (`onReplayEnd`), which `startReplay` guarantees to fire
// exactly once (replay-end, connection error, or stop), so it can never hang forever.

// Typed as the reducer's own `TreeSnapshot`, not as whatever these two tests happen to read:
// an empty session is a real shape, and a field the reducer adds must break this file rather
// than let the stub drift into something the view never receives.
function stubs() {
  const empty: TreeSnapshot = {
    main: {
      fill: 0,
      window: 1000,
      pct: 0,
      estimated: false,
      model: 'm',
      models: ['m'],
      regions: [],
      breakdown: { input: 0, cacheRead: 0, cacheCreation: 0 },
      cacheTotals: { read: 0, created: 0 },
      inputTotal: 0,
      outputTotal: 0,
      weighted: 0,
      weightedByModel: [],
    },
    mainTools: [],
    filesChanged: [],
    subagents: [],
    subagentsTotal: 0,
    subagentsEstimated: false,
    subagentTokensByModel: [],
    weightedSubagents: 0,
    weightedByModel: [],
    compactions: [],
    skills: [],
    commands: [],
    turns: 0,
    apiCalls: 0,
    seq: 0,
    turnList: [],
    openCall: null,
    error: null,
  };
  const treeState = {
    snapshot: () => empty,
    onChange: () => () => {},
    onEvent: () => () => {},
  };
  return { treeState };
}

test('the tab shows a loader until the replay ends, then the view', () => {
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const { treeState } = stubs();

  const view = createView(container, treeState);
  const loader = findByClass(container, 'skeleton')[0];
  assert.ok(loader, 'a loading skeleton is mounted while the session is being read');
  assert.notEqual(loader.style.display, 'none', 'loader visible during the replay');
  // The bento exists (the graph must see the replayed events to build its feed) but is hidden.
  const body = container.children[1];
  assert.equal(body.style.display, 'none', 'the view stays hidden until the history is in');

  view.onReplayEnd();
  assert.equal(loader.style.display, 'none', 'loader gone once the replay hands off to live');
  assert.notEqual(body.style.display, 'none', 'the view is shown');

  view.destroy();
  g.document = prevDoc;
});

test('a session that ended can never be left showing a pending prompt', async () => {
  // The PID file is gone, so nothing will ever clear the flag: an amber panel on a dead
  // tab would keep claiming a prompt that no longer exists.
  const g = globalThis as any;
  const prevDoc = g.document;
  g.document = fakeDoc();
  const container = g.document.createElement();
  const { treeState } = stubs();

  const view = createView(container, treeState);
  view.onReplayEnd();
  view.setEnded();
  view.setWaiting('permission', null);
  await new Promise((r) => setTimeout(r, 1));
  assert.equal(findByClass(container, 'nowpanel')[0].classList.contains('waiting'), false);

  view.destroy();
  g.document = prevDoc;
});
