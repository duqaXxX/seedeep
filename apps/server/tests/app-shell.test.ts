import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveOf, toCatalogue } from '../src/core/roster.ts';
import { fakeDoc, findByClass, textOf } from './fake-dom.ts';
import { rec } from './session-record.ts';

// Boot the REAL app.js (the composition root: roster → tab bar / dropdown / view /
// replay wiring) against a fake DOM, a fake fetch and a fake EventSource. app.js runs
// its side effects at import time and a module imports once per process, so this file
// holds ONE smoke test driving the whole boot sequence end to end.

class FakeES {
  url: string;
  listeners: Record<string, Array<(ev: { data: string }) => void>> = {};
  constructor(url: string) {
    this.url = url;
    sources.push(this);
  }
  addEventListener(type: string, fn: (ev: { data: string }) => void) {
    (this.listeners[type] ||= []).push(fn);
  }
  close() {}
  fire(type: string) {
    for (const fn of this.listeners[type] ?? []) fn({ data: '{}' });
  }
  emit(type: string, data: unknown) {
    for (const fn of this.listeners[type] ?? []) fn({ data: JSON.stringify(data) });
  }
}
const sources: FakeES[] = [];

const openId = 'aaaaaaaa-1111-2222-3333-000000000001';
const closedId = 'bbbbbbbb-1111-2222-3333-000000000002';
const roster = [
  rec({ sessionId: openId, project: 'projA', isOpen: true, isActive: true, status: 'busy', subject: 'live work' }),
  rec({ sessionId: closedId, project: 'projB', subject: 'old work' }),
];

test('app boot: auto-opens open sessions, opens ended tabs from the dropdown, closes tabs', async () => {
  const g = globalThis as any;
  // Restore the real globals afterwards — the suite shares one process, and a leaked
  // fake fetch breaks every later test that talks to a real local server.
  const prev = { document: g.document, EventSource: g.EventSource, fetch: g.fetch };
  const doc: any = fakeDoc();
  g.document = doc;
  g.EventSource = FakeES;
  // Served the way the server serves it: the shell must boot from the two halves, not from a
  // whole roster no endpoint returns any more — and ONLY from those, everything else 404.
  // Answering the roster to every unrecognised URL is what made the share-card test flaky: the
  // shell reaches further than its own boot, a graph asked for `/api/baseline`, got a list of
  // sessions with an `ok` on it, and stored it in a module-level memo shared by the whole process
  // — so Share threw in every later test in every later file, silently, on whichever machine won
  // that race. A fake that says `ok` to an endpoint it knows nothing about is not a stub, it is a
  // wrong answer with a stub's confidence.
  g.fetch = (input: any) => {
    const url = String(input);
    if (url.startsWith('/api/commits'))
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ commits: [], remote: null }) });
    if (url === '/api/live') return Promise.resolve({ ok: true, json: () => Promise.resolve(liveOf(roster)) });
    if (url === '/api/sessions')
      return Promise.resolve({ ok: true, json: () => Promise.resolve(roster.map(toCatalogue)) });
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.reject(new Error(`no fake for ${url}`)) });
  };
  try {
    await import('../src/client/app.ts');
    await new Promise((r) => setTimeout(r, 0)); // let roster.start() → fetch → openTab settle

    // Boot: exactly the OPEN session got a tab, marked busy, with a live panel behind it.
    const tabsEl = doc.getElementById('tabs');
    const panelsEl = doc.getElementById('panels');
    let tabs = findByClass(tabsEl, 'tab');
    assert.equal(tabs.length, 1, 'one tab per open session at launch');
    assert.equal(tabs[0].children[1].textContent, 'projA · live work');
    assert.ok(tabs[0].children[0].classList.contains('on'), 'busy roster status lights the dot');
    assert.equal(findByClass(panelsEl, 'panel').length, 1);
    assert.equal(panelsEl.querySelector('.empty-hint'), null, 'no hint when a tab auto-opened');

    // The fixed surfaces are in the header menu, never in the strip: the strip's whole width
    // belongs to the sessions. With a live session the menu trigger stays bare — the active tab
    // is what says where you are.
    const navEl = doc.getElementById('nav');
    assert.deepEqual(
      findByClass(navEl, 'nav-item').map((r: any) => textOf(r)),
      ['✦Homeretrospective', '✦Comparesessions', '✦Searchdialogue'],
    );
    assert.equal(tabsEl.children[0], tabs[0], 'the session tab is leftmost — nothing precedes it');
    const navBtn = findByClass(navEl, 'nav-btn')[0];
    assert.equal(navBtn.classList.contains('on'), false, 'a live session wins the landing, not Home');
    assert.equal(findByClass(navEl, 'nav-cur')[0].textContent, '', 'no surface to name at boot');
    assert.ok(tabs[0].classList.contains('active'), 'the live session is the active tab');

    // The open tab drove one live stream plus one replay connection for its session.
    const replayES = sources.find((s) => s.url.includes(openId));
    assert.ok(
      sources.some((s) => s.url === '/api/stream'),
      'multiplexed live stream opened',
    );
    assert.ok(replayES, 'replay opened for the auto-opened session');
    // One real line of history, so the tab has a POSITION in the file — that is what a resync
    // asks past. (A tab that has applied nothing must ask for everything, and does.)
    replayES!.emit('usage', {
      type: 'usage',
      sessionId: openId,
      root: 'cli',
      timestamp: '2026-01-01T00:00:00.000Z',
      seq: 3,
      agentId: null,
      delta: { input: 1, output: 0, cacheRead: 0, cacheCreation: 0 },
      fill: 100,
    });
    replayES!.fire('replay-end'); // history handed off to live — must not throw

    // Dropdown: picking the CLOSED session opens a second, ended tab with no live stream.
    const dropdownEl = doc.getElementById('dropdown');
    dropdownEl.children[0].onclick(); // trigger → open → render rows
    const row = findByClass(dropdownEl, 'pk-row').find((r: any) => textOf(r).includes('old work'));
    assert.ok(row, 'closed session listed in the picker');
    row.onclick();
    tabs = findByClass(tabsEl, 'tab');
    assert.equal(tabs.length, 2);
    assert.equal(tabs[1].children[1].textContent, 'projB · old work');
    assert.ok(tabs[1].classList.contains('ended'), 'ended is the tab going quiet, not a word in the label');
    assert.ok(
      sources.some((s) => s.url.includes(closedId)),
      'pure replay opened for the ended session',
    );

    // The stream breaks and comes back. Nothing re-sends what was emitted while it
    // was down, so a tab that kept its reducer would stay silently short of the truth — the
    // measured freeze. Every LIVE tab must re-read its file; an ended one has nothing to
    // catch up on and must be left alone.
    const liveES = sources.find((s) => s.url === '/api/stream')!;
    const replaysOf = (id: string) => sources.filter((s) => s.url.includes(id)).length;
    const liveReplays = replaysOf(openId);
    const endedReplays = replaysOf(closedId);
    const connEl = doc.getElementById('conn');
    liveES.fire('open'); // the connection the page has been running on all along
    assert.equal(connEl.textContent, '', 'a healthy feed says nothing');
    liveES.fire('error');
    assert.equal(connEl.textContent, 'Live feed lost — reconnecting…', 'the break is said out loud');
    liveES.fire('open');
    assert.equal(replaysOf(openId), liveReplays + 1, 'the live tab went back for what it missed');
    const resync = sources.filter((s) => s.url.includes(openId)).at(-1)!;
    assert.match(resync.url, /[?&]from=/, 'it asks for the TAIL, not the whole session again');
    assert.equal(replaysOf(closedId), endedReplays, 'an ended tab has no hole to close');
    assert.equal(connEl.textContent, 'Reconnected — re-reading');
    assert.equal(findByClass(tabsEl, 'tab').length, 2, 'rebuilding keeps the strip as it was');

    // Close both via ×: panels and tabs drop with them.
    for (const t of [...tabs]) t.children[2].onclick({ stopPropagation: () => {} });
    assert.equal(findByClass(tabsEl, 'tab').length, 0);
    assert.equal(findByClass(panelsEl, 'panel').length, 0);
  } finally {
    g.document = prev.document;
    g.EventSource = prev.EventSource;
    // app.js exposes no way to stop its 3s roster poll, and the leaked timer chain
    // reads the GLOBAL fetch on every tick: restoring the real fetch outright would
    // hand later tests phantom '/api/sessions' calls. Scoped shim instead — empty
    // roster for the leaked poll, the real fetch for everything else.
    g.fetch = (input: any, ...rest: any[]) => {
      if (input === '/api/sessions') return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      if (input === '/api/live')
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ total: 0, sessions: [], pidVisible: true }) });
      return prev.fetch(input, ...rest);
    };
  }
});
