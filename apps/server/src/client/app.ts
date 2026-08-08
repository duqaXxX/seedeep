import type { SessionCommits } from '../core/commit-attribution.ts';
import { windowFor } from '../core/context-windows.ts';
import type { SessionFiles } from '../core/file-attribution.ts';
import { createSessionTree } from '../core/session-tree.ts';
import type { SessionCards } from '../core/tracker-cards.ts';
import { tabLabel } from '../core/tree-format.ts';
import type { Comparison, Retrospective, SearchResponse, SessionRecord } from '../core/types.ts';
import { AuthEventSource, type AuthState, authFetch, currentAuthState, initAuth, onAuthState } from './auth.ts';
import { markDevBuild } from './build-mark.ts';
import { createCompareView } from './compare-view.ts';
import { createDropdown } from './dropdown.ts';
import { createEndGuard } from './end-guard.ts';
import type { CallIOResult, ToolOutputResult } from './graph.ts';
import { createHomeView } from './home-view.ts';
import { COMPARE_ID, createNavMenu, HOME_ID, SEARCH_ID } from './nav-menu.ts';
import { startReplay } from './replay.ts';
import { createSearchView } from './search-view.ts';
import {
  createRoster,
  isLive,
  isModelBusy,
  isWorking,
  pendingInput,
  requestedSession,
  sessionsToAutoOpen,
} from './sessions.ts';
import { createSettingsPanel } from './settings.ts';
import { createStream } from './stream.ts';
import { createTabBar } from './tab-bar.ts';
import { createTabStore } from './tab-store.ts';
import { createView } from './view.ts';

initAuth();

// One request at load, and the only reason it is not folded into another: nothing else the client
// fetches is about the SERVER, and a field about the build smuggled into a digest would be read by
// every tick forever. Failures are silent — an unmarked portal is the released one, which is the
// safe way to be wrong about a badge.
void authFetch('/api/config')
  .then((r) => r.json() as Promise<{ dev?: boolean }>)
  .then((cfg) => markDevBuild(cfg.dev === true, document.querySelector('header > strong')))
  .catch(() => {
    /* an unmarked page rather than a wrong one */
  });
const stream = createStream({ EventSourceImpl: AuthEventSource });
// The roots index.html ships. A missing one means the page and this bundle have
// drifted apart — unrecoverable at runtime, so it fails HERE, naming the id, instead of
// surfacing later as "Cannot read properties of null" from inside whichever tab happened
// to touch it first. Asserting them non-null would keep that late, unreadable failure.
function rootEl(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`seedeep: #${id} is missing from index.html`);
  return el;
}
const navEl = rootEl('nav');
const tabsEl = rootEl('tabs');
const panelsEl = rootEl('panels');
const dropdownEl = rootEl('dropdown');
const connEl = rootEl('conn');

// Global settings panel — browser only. The app-shell test uses a fake DOM that doesn't
// support body.append or non-class querySelector selectors, so we skip it there.
if (typeof (document.body as unknown as Record<string, unknown>)['append'] === 'function') {
  createSettingsPanel(document.querySelector('header') as HTMLElement);
}

interface OpenTab {
  view: ReturnType<typeof createView>;
  panel: HTMLElement;
  stopReplay: ReturnType<typeof startReplay> | null;
  ended: boolean;
  label: string;
}
const openTabs = new Map<string, OpenTab>();
let activeId: string | null = null;
// Sessions seedeep has already handed a tab to. A live one that is not here gets a tab by
// itself; once offered it is never offered again, so a tab you close stays closed.
let known = new Set<string>();
// roster.onChange is registered before roster.start(), so the first poll's listeners run
// BEFORE the saved workspace is read. Auto-opening there would offer every live session
// with an empty `known` and persist that — undoing the restore it had not yet done.
let booted = false;
// Roster size at the last Home refresh; a change means a session was added/removed, i.e. the
// corpus retrospective moved. Guards the 3s poll from re-scanning the corpus on every tick.
let lastRosterLen = -1;

// Declared before the handlers that capture them so no call path hits a
// temporal-dead-zone ReferenceError, regardless of future call ordering.
const tabBar = createTabBar(tabsEl, { onSwitch: switchTo, onClose: closeTab });
// The fixed surfaces, in the header menu rather than the tab strip: the strip is where a
// SESSION is found, and three permanent pills there were spending its width on labels that
// never change. Declared once here — the menu owns the order they are read in.
const navMenu = createNavMenu(navEl, {
  items: [
    { id: HOME_ID, label: 'Home', hint: 'retrospective' },
    { id: COMPARE_ID, label: 'Compare', hint: 'sessions' },
    { id: SEARCH_ID, label: 'Search', hint: 'dialogue' },
  ],
  onSwitch: switchTo,
});
const dropdown = createDropdown(dropdownEl, { onOpen: openFromDropdown });
// Named here rather than left to createRoster's default because the end-of-session
// confirmation window below is defined RELATIVE to it: a confirmation that does not outlast
// one poll would re-read the very same reading it is meant to check.
const ROSTER_POLL_MS = 3000;
// Two halves, two cadences: the catalogue is refetched only when a session is born, the live
// payload is what the 3s poll actually carries (see createRoster).
const roster = createRoster({
  // The signal is the roster's deadline (see READING_TIMEOUT_MS): honouring it is what lets a
  // request the network will never answer be dropped instead of held open forever.
  fetchCatalogue: (signal) => authFetch('/api/sessions', { signal }).then((r) => r.json()),
  fetchLive: (signal) => authFetch('/api/live', { signal }).then((r) => r.json()),
  pollMs: ROSTER_POLL_MS,
});
// Committing "this session is over": one-way, so it happens only once a reading taken a full
// poll later still agrees. `stillGone` reads roster.current(), which is refreshed on EVERY
// poll (onChange fires only on identity change, so counting notifications would never confirm
// a session that really closed — its key stops moving after the first transition). What the
// guard counts instead is `readings()`: a poll whose fetch FAILED serves the previous rows
// unchanged, and re-reading those would let the reading under question confirm itself.
const endGuard = createEndGuard({
  delayMs: ROSTER_POLL_MS + 1000,
  reading: () => roster.readings(),
  stillGone: (sessionId) => {
    const row = roster.current().find((s) => s.sessionId === sessionId);
    return !row || !isLive(row); // gone from the roster entirely counts as gone
  },
  end: (sessionId) => {
    const t = openTabs.get(sessionId);
    if (!t || t.ended) return;
    t.ended = true;
    tabBar.setEnded(sessionId);
    t.view.setEnded(); // the graph freezes into its ended presentation
    if (t.stopReplay) {
      t.stopReplay.stop();
      t.stopReplay = null;
    }
  },
});

// Merely READING localStorage throws when storage is disabled, so the access is guarded
// here, not just its calls; the store then degrades to "nothing saved" (see tab-store.ts).
const tabStore = createTabStore(
  (() => {
    try {
      return globalThis.localStorage ?? null;
    } catch {
      return null;
    }
  })(),
);

// Home — the minute-zero retrospective, first item of the header menu. Its panel lives in
// `panels` alongside the session panels, shown/hidden by switchTo like any other. It replaces
// the old empty-hint — a fixed, always-reachable surface instead of a page that reads as broken
// when nothing is open.
const homePanel = document.createElement('div');
homePanel.className = 'home-panel';
homePanel.style.display = 'none';
panelsEl.append(homePanel);
const homeView = createHomeView(homePanel, {
  loadRetro: (): Promise<Retrospective | null> =>
    authFetch('/api/retro')
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
  onPickSession: () => dropdown.open(),
});

// The second fixed surface: the cross-session comparison. In the menu for the same reason Home
// is — a surface over the whole corpus, not a session — and under Home, since it answers the
// question Home raises ("where did all that weight go?").
const comparePanel = document.createElement('div');
// `home-panel` for the shared shell styling, plus its own class: the two panels are different
// surfaces, and both carry `rt-` cards, so a selector needs to be able to tell them apart.
comparePanel.className = 'home-panel compare-panel';
comparePanel.style.display = 'none';
panelsEl.append(comparePanel);
const compareView = createCompareView(comparePanel, {
  loadComparison: (): Promise<Comparison | null> =>
    authFetch('/api/compare')
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
  // Same path the picker takes, so a row and a pick cannot open a session two different ways.
  onOpenSession: openFromDropdown,
});

// The third fixed surface: full-text search over the sessions' dialogue. In the menu like the
// other two — a surface over the whole corpus, not a session — and it is how you reach one you can
// only half remember: the picker finds one by its FIRST prompt, which is one line of the many a
// session holds (p90 = 13 human prompts, measured 2026-07-29).
const searchPanel = document.createElement('div');
searchPanel.className = 'home-panel search-panel';
searchPanel.style.display = 'none';
panelsEl.append(searchPanel);
const searchView = createSearchView(searchPanel, {
  search: (q: string): Promise<SearchResponse | null> =>
    authFetch('/api/search?q=' + encodeURIComponent(q))
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
  // Same path the picker and the Compare row take, so a session never opens three different ways.
  onOpenSession: openFromDropdown,
});

// The open tabs and the active one, saved on every change so a refresh restores the
// workspace instead of resetting it. Order included: the strip's order is part of it.
function persist() {
  // A workspace derived from a roster that was never read is not a workspace. Since a reading now
  // fails on a deadline instead of hanging forever, the boot block runs even when the first one
  // never landed — with no rows, so nothing restores, and the first click would then save that
  // emptiness over the tabs the user actually had. `readings()` counts what LANDED, so this waits
  // for one real answer; the roster keeps polling and a later load restores everything.
  if (roster.readings() === 0) return;
  tabStore.save({ ids: [...openTabs.keys()], activeId, known: [...known] });
}

// A session that started while seedeep was running gets its own tab — once. It opens in the
// BACKGROUND: `openTab` would otherwise switch to it, yanking you off whatever you are
// reading the moment anything starts. The exception is when nothing is on screen, since a
// tab nobody is looking at would leave the page blank.
//
// Recording the offer is openTab's job, not this function's: that keeps the invariant where
// the tab is created, so every path (auto, picker, restore) records it, and nothing depends
// on this running afterwards.
function autoOpenNew(rows: SessionRecord[]) {
  for (const row of sessionsToAutoOpen(rows, known, new Set(openTabs.keys()))) {
    openTab(row, { activate: activeId === null });
  }
}

function switchTo(sessionId: string) {
  activeId = sessionId;
  for (const [id, t] of openTabs) t.panel.style.display = id === sessionId ? 'block' : 'none';
  homePanel.style.display = sessionId === HOME_ID ? 'block' : 'none';
  comparePanel.style.display = sessionId === COMPARE_ID ? 'block' : 'none';
  searchPanel.style.display = sessionId === SEARCH_ID ? 'block' : 'none';
  // Fetched on switch, not on mount: the comparison refreshes the whole corpus aggregate, and
  // paying for it at boot would slow a launch that lands on a session tab.
  if (sessionId === COMPARE_ID) void compareView.refresh();
  // Search fetches nothing on switch — it has no answer until there is a question. It only takes
  // the caret, so switching to it and typing is one gesture.
  if (sessionId === SEARCH_ID) searchView.focus();
  tabBar.setActive(sessionId);
  navMenu.setActive(sessionId); // names the trigger for a fixed surface, bare for a session
  persist();
}

// The picker pins the sessions that already have a tab. Called on every open/close: the
// roster cannot carry this, since opening a tab leaves its identity set untouched.
function syncPins() {
  dropdown.setOpenTabs(openTabs.keys());
}

function closeTab(sessionId: string) {
  const t = openTabs.get(sessionId);
  if (!t) return;
  endGuard.cancel(sessionId); // no tab left to end when its window would close
  if (t.stopReplay) t.stopReplay.stop(); // unsubscribes live + closes replay ES
  t.view.destroy();
  t.panel.remove();
  tabBar.remove(sessionId);
  openTabs.delete(sessionId);
  syncPins();
  if (activeId === sessionId) {
    const next = openTabs.keys().next();
    if (!next.done) switchTo(next.value);
    else switchTo(HOME_ID);
  }
  persist(); // also covers closing the LAST tab, where no switchTo runs to persist for us
}

// `activate: false` opens the tab in the background — it appears in the strip and starts
// reading, but does not pull you onto it (see autoOpenNew).
function openTab(record: SessionRecord, { activate = true }: { activate?: boolean } = {}) {
  const { sessionId } = record;
  // Already open: honour `activate` here too, or a background caller silently steals focus.
  if (openTabs.has(sessionId)) {
    if (activate) switchTo(sessionId);
    return;
  }
  const treeState = createSessionTree({ windowFor, mainModel: record.model });
  panelsEl.querySelector('.empty-hint')?.remove(); // clear the "pick one" hint once a tab opens
  const panel = document.createElement('div');
  panel.className = 'panel';
  // Hidden until switchTo says otherwise: a panel created with no inline display would
  // paint straight over the tab you are actually looking at.
  panel.style.display = 'none';
  panelsEl.append(panel);
  // A tool's output is read back from the session file when the drawer asks for it — the
  // client keeps only its SIZE (see src/tool-output.ts). Never rejects: the drawer renders
  // "not available" rather than breaking on a tool whose result the file no longer has.
  const loadToolOutput = (toolUseId: string): Promise<ToolOutputResult | null> =>
    authFetch(`/api/tool-output?sessionId=${encodeURIComponent(sessionId)}&toolUseId=${encodeURIComponent(toolUseId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  // The input + output of one API call, read back on click (never held in the client, like
  // tool output). Never rejects: the drawer renders "not available" instead of breaking.
  const loadCallIO = (callId: string): Promise<CallIOResult | null> =>
    authFetch(`/api/call-io?sessionId=${encodeURIComponent(sessionId)}&callId=${encodeURIComponent(callId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  const loadAgentPrompt = (agentId: string): Promise<{ text: string; truncated: boolean } | null> =>
    authFetch(`/api/agent-prompt?sessionId=${encodeURIComponent(sessionId)}&agentId=${encodeURIComponent(agentId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  // The session's commits, joined server-side from git and this transcript. Never rejects: the
  // card stays on its empty state rather than breaking the page when git or the repo is gone.
  const loadCommits = (): Promise<SessionCommits | null> =>
    authFetch(`/api/commits?sessionId=${encodeURIComponent(sessionId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  // The files this session changed, from the ledger + its commits + (live) the working tree.
  // Same posture as the commits fetch: never rejects, so a repo that has gone missing leaves the
  // card on the ledger it can still read.
  const loadFiles = (): Promise<SessionFiles | null> =>
    authFetch(`/api/files?sessionId=${encodeURIComponent(sessionId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  // The tracker cards this session worked on. Same posture as the commits fetch: never rejects,
  // so a tracker that answered nothing leaves the card on its empty state instead of the page.
  const loadCards = (): Promise<SessionCards | null> =>
    authFetch(`/api/cards?sessionId=${encodeURIComponent(sessionId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  const open = isLive(record); // the one predicate — an inline copy here would drift from it
  const view = createView(panel, treeState, {
    loadToolOutput,
    loadCallIO,
    loadAgentPrompt,
    loadCommits,
    loadFiles,
    loadCards,
    ended: !open,
    sessionId,
  });
  tabBar.add(sessionId, { label: tabLabel(record), ended: !open, busy: isWorking(record) });
  // Seed the pending-prompt state from the record, exactly like the busy dot above: the
  // roster only notifies on CHANGE, and a session that is already waiting when its tab opens
  // (a refresh, a restored workspace, a tab opened from the picker) changes nothing — so
  // without this the one surface meant for whoever arrives late is the one that stays blank.
  const waitingAtOpen = open ? pendingInput(record) : null;
  tabBar.setWaiting(sessionId, waitingAtOpen);
  view.setWaiting(waitingAtOpen, waitingAtOpen ? record.waitingSince : null);
  // Same seed, same reason, for the signal the NOW panel needs: a tab opened onto a session that
  // is ALREADY working changes nothing in the roster, so without this the panel waits for a status
  // change that may never come — and draws nothing while Claude Code thinks (see turnIsWorking).
  view.setBusy(open ? isModelBusy(record) : false);
  // The failed state comes from the REDUCER, not the roster: the roster never parses transcript
  // content, and this fact only exists downstream of the parser. Read on every applied event
  // (O(1), see `currentError`) rather than per frame — the tab that must turn red is usually a
  // background one, which gets no frames at all. The replay pass sets it for free: a session that
  // was already failing when its tab opened arrives red, like the pending-prompt seed above.
  treeState.onChange(() => tabBar.setFailed(sessionId, treeState.currentError() !== null));
  // Open: replay-from-start then live. Closed: pure replay (no live stream).
  const onLive = () => view.onReplayEnd(); // history is in: drop the loader, paint, arm toasts
  const stopReplay = startReplay(
    sessionId,
    (e) => treeState.apply(e),
    open ? { stream, EventSourceImpl: AuthEventSource, onLive } : { EventSourceImpl: AuthEventSource, onLive },
  );
  openTabs.set(sessionId, { view, panel, stopReplay, ended: !open, label: tabLabel(record) });
  // Handing out a tab IS the offer, whoever asked for it — auto, picker or restore. Recorded
  // here so the rule can never re-offer something the user has already seen and closed.
  known.add(sessionId);
  syncPins();
  // switchTo persists; a background tab has to do it itself, and nobody else will.
  if (activate) switchTo(sessionId);
  else persist();
}

function openFromDropdown(id: string) {
  const r = roster.current().find((s) => s.sessionId === id);
  if (r) openTab(r);
}

// The connection's health, and it is the ONLY thing on screen that speaks about it: the
// `live` badge on a card reports whether the SESSION is running, which stayed true and
// pulsing all through a dead stream. Silent while healthy — a permanent "connected" chip
// is noise that trains you to ignore the one state that matters.
let connHideTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * What to say when the server has refused this browser's token. It OUTRANKS every stream state,
 * because a reconnection cannot fix a 401: the old banner promised one anyway, forever, and sent
 * the reader looking for a network problem that was not there.
 *
 * `title` carries the rest — the pill has room for the fact, not for the instructions.
 */
const AUTH_PILL: Record<Exclude<AuthState, 'ok'>, { text: string; title: string }> = {
  missing: {
    text: 'No token for this address',
    title:
      'This server asks for a token and this browser has none for this address. A token is stored per address, and the PORT is part of it — the one you use on another port is not visible here. Open the URL seedeep printed at startup (it carries the token), or paste it in Settings.',
  },
  refused: {
    text: 'Token refused',
    title:
      'The token stored for this address is not the one the server accepts — it was regenerated, or it belongs to another seedeep. Open the URL seedeep printed at startup, or paste the current token in Settings.',
  },
};
function showConnection(state: 'ok' | 'lost' | 'resync') {
  if (connHideTimer !== null) {
    clearTimeout(connHideTimer);
    connHideTimer = null;
  }
  // Namespaced: a bare `conn` class is the Trace's connector element, and the header's rule
  // would reach every one of them (see chrome.css). Empty text is what hides the pill.
  const auth = currentAuthState();
  if (auth !== 'ok') {
    connEl.className = 'feed-auth';
    connEl.textContent = AUTH_PILL[auth].text;
    connEl.title = AUTH_PILL[auth].title;
    return;
  }
  connEl.title = '';
  connEl.className = state === 'ok' ? '' : 'feed-' + state;
  connEl.textContent =
    state === 'lost' ? 'Live feed lost — reconnecting…' : state === 'resync' ? 'Reconnected — re-reading' : '';
  // The recovery notice is an event, not a state: it says what just happened and goes.
  if (state === 'resync') connHideTimer = setTimeout(() => showConnection('ok'), 4000);
}

// Was the feed ever lost? Only then is a reconnect a resync — the first `open` of the page
// is just the stream starting, and must not rebuild tabs that have only just read the file.
let feedWasLost = false;
// The verdict can arrive at any poll, with no stream event to ride on — and it must repaint in
// both directions: the moment the token is fixed in Settings, the pill has to go on its own.
onAuthState(() => showConnection(feedWasLost ? 'lost' : 'ok'));
stream.onStatus((s) => {
  if (s === 'lost') {
    feedWasLost = true;
    showConnection('lost');
    return;
  }
  if (!feedWasLost) return; // first connection: nothing to recover
  feedWasLost = false;
  showConnection('resync');
  // Each live tab pulls the lines it missed while the feed was down — the tail only, folded
  // into the reducer it already has. Ended tabs hold history the stream cannot change, so
  // they have nothing to catch up on.
  for (const t of openTabs.values()) if (!t.ended) t.stopReplay?.resync();
});

roster.onChange((rows) => {
  dropdown.update(rows);
  for (const row of rows) {
    const t = openTabs.get(row.sessionId);
    if (!t) continue;
    const open = isLive(row);
    // An open tab whose session CLOSED (its PID file is gone): drop the live
    // subscription and freeze on the last state. Not a 60s silence timer — an
    // open-but-idle session stays live. A session that reopens is NOT re-opened
    // automatically; it reappears in the dropdown for the user to pick.
    //
    // Never on the FIRST reading, though: the PID file is rewritten on every status change
    // and a read that catches it mid-rewrite loses the session for one poll. Ending is
    // one-way, so it waits for a second, independent reading to agree (see end-guard.ts).
    if (!t.ended && !open) endGuard.gone(row.sessionId);
    if (open) endGuard.cancel(row.sessionId); // it is back — whatever we were about to believe, don't
    if (!t.ended) {
      // Two different questions, deliberately two readings: the tab dot means "this session is
      // busy" (`shell` included — a background command IS the session working), the panel means
      // "this TURN is still going", and `shell` is Claude Code's word for a turn that is over.
      tabBar.setBusy(row.sessionId, isWorking(row));
      t.view.setBusy(isModelBusy(row));
      // The pending-prompt signal, to both surfaces at once: the strip keeps saying it
      // (it survives a tab switch), the view announces it and shows what is being asked.
      const waiting = pendingInput(row);
      tabBar.setWaiting(row.sessionId, waiting);
      t.view.setWaiting(waiting, waiting ? row.waitingSince : null);
      // Subject arrives after the first user line is written — update the tab label so it
      // shows the prompt text without a refresh. rosterKey includes subject so this fires
      // exactly once per session (null → text; after that the subject is immutable).
      const newLabel = tabLabel(row);
      if (newLabel !== t.label) {
        t.label = newLabel;
        tabBar.setLabel(row.sessionId, newLabel);
      }
    }
  }
  if (booted) {
    autoOpenNew(rows); // a session that just started gets its tab, in the background
    // A NEW session landed (roster grew): the corpus retrospective on Home has moved, so
    // refresh it. Guarded by length so the 3s poll does not re-scan the corpus every tick.
    if (rows.length !== lastRosterLen) {
      lastRosterLen = rows.length;
      homeView.refresh();
    }
  }
});

roster.start().then(() => {
  const rows = roster.current();
  dropdown.update(rows);
  const saved = tabStore.load();
  if (saved) {
    // BEFORE the tabs: opening one calls switchTo → persist, which would write `known` back
    // out — as `[]` — and lose the record of every session the user had closed.
    known = new Set(saved.known);
    // The saved workspace decides which tabs EXIST: one you closed stays closed, and a
    // session whose file is gone is simply skipped (the next persist prunes it).
    const byId = new Map(rows.map((r) => [r.sessionId, r]));
    for (const id of saved.ids) {
      const r = byId.get(id);
      if (r) openTab(r);
    }
    // Home is not a session, so it lives outside openTabs — restore it by its reserved id.
    if (saved.activeId === HOME_ID) switchTo(HOME_ID);
    else if (saved.activeId === COMPARE_ID) switchTo(COMPARE_ID);
    else if (saved.activeId === SEARCH_ID) switchTo(SEARCH_ID);
    else if (saved.activeId && openTabs.has(saved.activeId)) switchTo(saved.activeId);
  }
  booted = true;
  lastRosterLen = rows.length; // Home already fetched on mount; don't re-scan on the first poll
  // One rule covers both the first visit and every session that starts later: a live human
  // session nobody has offered yet gets a tab. On a first visit `known` is empty, so this
  // is exactly the old "one tab per open session at launch" — not a second code path.
  autoOpenNew(rows);
  // A deep link — the tray handing over the session somebody just clicked (`docs/tray.md`). Applied
  // after the restore AND after the auto-open so that it wins the active tab: it is the only thing
  // on this page the user did a moment ago, which outranks both what they were last looking at and
  // a session that happened to start. An id no session answers to — one deleted between the click
  // and the load — opens nothing, because the alternative is a tab with no record behind it.
  const asked = takeDeepLink();
  if (asked) {
    const row = rows.find((r) => r.sessionId === asked);
    if (row) openTab(row);
  }
  // Launch rule: if a live session was auto-opened (or a saved tab restored as active) you land
  // there and Home is one click away; otherwise Home IS the landing surface. Either way Home
  // always exists, so an empty workspace never reads as a broken page (replaces the empty-hint).
  if (activeId === null) switchTo(HOME_ID);
});

/**
 * The session a deep link asks for, CONSUMED: the parameter is taken out of the URL as it is read,
 * for the same reason `initAuth` strips the token — a reload must not yank the tab back to wherever
 * one click sent it, possibly minutes later. Reading and clearing are one act so no caller can do
 * half of it.
 *
 * Returns null outside a real browser, where `location` does not exist (the shell's own boot test
 * runs there, and it caught exactly this).
 */
function takeDeepLink(): string | null {
  try {
    const params = new URLSearchParams(location.search);
    const asked = requestedSession(location.search);
    if (!asked) return null;
    params.delete('session');
    const search = params.toString();
    history.replaceState(null, '', location.pathname + (search ? '?' + search : '') + location.hash);
    return asked;
  } catch {
    return null; // not in a real browser
  }
}
