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

// Wait for a condition the app reaches through its OWN timers, instead of sleeping for a
// guessed duration: the sequence under test (roster poll → end-guard window → poll) is three
// timers deep, and a fixed sleep would either be flaky or the slowest test in the suite.
async function until(what: string, cond: () => boolean, budgetMs = 2000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`app-shell: timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

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
  const prev = {
    document: g.document,
    EventSource: g.EventSource,
    fetch: g.fetch,
    setTimeout: g.setTimeout,
  };
  // The two multi-second waits this test has to live through are the roster poll (3s) and the
  // end-of-session confirmation window (poll + 1s) — neither is injectable, since app.ts IS the
  // composition root and owns both. So the clock is shortened for that band only: everything
  // outside it (the stream's 45s staleness verdict, the replay's 30s one, the 60s commits
  // refresh) keeps its real value, because a stream that declares itself dead every few
  // milliseconds is a different test than this one, running by accident.
  g.setTimeout = ((fn: any, ms?: number, ...rest: any[]) =>
    prev.setTimeout(fn, typeof ms === 'number' && ms >= 2500 && ms <= 5000 ? 5 : ms, ...rest)) as any;
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
  // The roster endpoints answer 500 while `rosterFails` is set, and — deliberately — with a
  // PARSEABLE body saying zero sessions. That is what a scan which could not be made would look
  // like to a client that reads the body without looking at the status, and it is the only way
  // this test can tell a reading that was checked from one that merely failed to parse.
  let rosterFails = false;
  // The reading LANDS and is short: what a scan that could not read one project directory looks
  // like. `readRoster` cannot save the sweep here — the response is a clean 200 — so only the
  // payload's own `complete` can.
  let rosterPartial = false;
  let liveReadings = 0;
  const failed = (body: unknown) => ({ ok: false, status: 500, json: () => Promise.resolve(body) });
  g.fetch = (input: any) => {
    const url = String(input);
    if (url.startsWith('/api/commits'))
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ commits: [], remote: null }) });
    if (url === '/api/live') {
      liveReadings++;
      return Promise.resolve(
        rosterFails
          ? failed(liveOf([]))
          : { ok: true, json: () => Promise.resolve(liveOf(rosterPartial ? [] : roster, !rosterPartial)) },
      );
    }
    if (url === '/api/sessions')
      return Promise.resolve(
        rosterFails ? failed([]) : { ok: true, json: () => Promise.resolve(roster.map(toCatalogue)) },
      );
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

    // Dropdown: picking the CLOSED session opens a second tab, ended. It replays its file like any
    // other and — unlike before — subscribes to the live stream too, which is what lets it come
    // back if that session is ever resumed (see `revive`); nothing is delivered for a session no
    // watcher is tailing, so the subscription is inert until then.
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
      'the ended session is read from its file',
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
    resync.fire('replay-end'); // that read lands — a later resync is DEFERRED while one is in flight
    assert.equal(connEl.textContent, 'Reconnected — re-reading');
    assert.equal(findByClass(tabsEl, 'tab').length, 2, 'rebuilding keeps the strip as it was');

    // You quit Claude Code and come back with `--resume`. That is the SAME session id — the
    // transcript is appended to, same file, same inode (measured) — so the tab it froze is the
    // only tab that session will ever get: nothing auto-opens it (`known` + `openIds` both hold
    // it) and picking it from the dropdown only switches to it. Before this, the tab stayed
    // frozen for the life of the page while Claude Code worked on, and only a browser refresh
    // brought it back.
    const liveTab = () => findByClass(tabsEl, 'tab')[0];
    const live = roster[0]!;
    live.isOpen = false; // its PID file is gone: Claude Code exited
    live.status = null;
    await until('the tab to be marked ended', () => liveTab().classList.contains('ended'));
    const replaysBeforeResume = replaysOf(openId);

    live.isOpen = true; // `claude --resume <id>`: same session, new process
    live.status = 'busy';
    await until('the tab to come back to life', () => !liveTab().classList.contains('ended'));
    assert.equal(liveTab().title, 'projA · live work', 'the hover text stops saying ended too');
    assert.equal(replaysOf(openId), replaysBeforeResume + 1, 'it goes back for what was written meanwhile');
    const revived = sources.filter((s) => s.url.includes(openId)).at(-1)!;
    assert.match(revived.url, /[?&]from=/, 'the TAIL, from the last line the tab holds whole');
    revived.fire('replay-end'); // the read lands: buffered live events are flushed and the feed is through

    // The invariant the frozen tab broke: an event arriving now REACHES this tab. A failed API
    // call is the one the strip must repaint for, and it is driven by the reducer, so the assert
    // proves the whole chain — live subscription → reducer → strip — and not just a class.
    liveES.emit('usage', {
      type: 'usage',
      sessionId: openId,
      root: 'cli',
      timestamp: '2026-01-01T00:05:00.000Z',
      seq: 50,
      agentId: null,
      delta: { input: 1, output: 0, cacheRead: 0, cacheCreation: 0 },
      fill: 200,
      apiError: { status: 529, message: 'overloaded' },
    });
    await until('the resumed session to reach the strip', () => liveTab().children[0].classList.contains('err'));

    // The other way a session stops being live, and the one no reading of `isOpen` can express:
    // its FILE is gone, so it leaves the roster entirely rather than turning up not-live in it.
    // A throwaway cwd cleaned up under a driven session does exactly this. `roster.onChange`
    // walks the rows it was handed, so this tab was never offered to the end guard at all and
    // kept its live chrome for the life of the page — a turn clock still ticking on a session
    // that had ended, and a pending-approval banner nothing could ever clear.
    // Before that: the roster endpoint FAILING must not be read as the same thing. A scan that
    // could not be made answers 500, and a client that took the body at face value would see zero
    // sessions — the sweep below would then end every tab on the page while the sessions behind
    // them were still running. Several failed readings, over more than the confirmation window,
    // and the live tab is untouched.
    rosterFails = true;
    const readingsAtFailure = liveReadings;
    await until('the roster to have failed several readings', () => liveReadings >= readingsAtFailure + 4);
    assert.equal(liveTab().classList.contains('ended'), false, 'a failed reading is not an empty roster');
    rosterFails = false;

    // And the reading that LANDS but is short: one project directory that would not be read. The
    // response is a clean 200 listing zero sessions, so nothing about the transport can tell this
    // from an empty machine — only the payload saying it is partial can, and the sweep is the one
    // consumer that has to ask, since it acts on absence rather than on presence.
    rosterPartial = true;
    const readingsAtPartial = liveReadings;
    await until('the partial roster to have been read several times', () => liveReadings >= readingsAtPartial + 4);
    assert.equal(liveTab().classList.contains('ended'), false, 'a partial scan is not an empty roster either');
    rosterPartial = false;
    await until('the tab to survive the partial readings', () => liveReadings >= readingsAtPartial + 6);
    assert.equal(liveTab().classList.contains('ended'), false, 'and it is still live once the scan heals');

    roster.splice(0, 1);
    await until('the vanished session to end its tab', () => liveTab().classList.contains('ended'));

    // Close both via ×: panels and tabs drop with them.
    for (const t of [...tabs]) t.children[2].onclick({ stopPropagation: () => {} });
    assert.equal(findByClass(tabsEl, 'tab').length, 0);
    assert.equal(findByClass(panelsEl, 'panel').length, 0);
  } finally {
    g.document = prev.document;
    g.EventSource = prev.EventSource;
    // Before the fetch shim, and for the same reason it exists: the leaked poll re-arms itself
    // through the GLOBAL setTimeout on every tick, so leaving the shortened clock in place would
    // hand the rest of the suite a roster polling every 5 ms.
    g.setTimeout = prev.setTimeout;
    // app.js exposes no way to stop its 3s roster poll, and the leaked timer chain reads the
    // GLOBAL fetch on every tick: restoring the real fetch outright would hand later tests
    // phantom '/api/sessions' calls. Scoped shim instead — and it REFUSES rather than answers,
    // because an answer is what repaints: `refresh()` bails on the catch it already has (keeping
    // its last good roster, notifying nobody), while an empty roster read as a change, refreshed
    // Home, and threw from inside a surface whose fake DOM this block had just taken away.
    g.fetch = (input: any, ...rest: any[]) => {
      if (String(input).startsWith('/api/')) return Promise.reject(new Error('app-shell: the page is gone'));
      return prev.fetch(input, ...rest);
    };
  }
});
