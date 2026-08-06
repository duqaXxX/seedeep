// Graph view — the bento layout replicated 1:1 from the design prototype (layout C).
// createGraph(container, state) BUILDS the whole bento inside `container` (widget
// hosts are local nodes, not looked up by id) and re-renders on state.onChange.
// DOM + textContent only — session-derived strings (model, tool arg, subagent
// prompt/output) can never inject markup. Data it does not have yet (returned
// output, tool arg/ctx, skill turns) is guarded and lands in later tasks (P1-P3).

import { type NowState, nowLine, outcomeLine, runningSince } from '../core/activity-line.ts';
import { activityMatches, flattenActivity } from '../core/activity-list.ts';
import type { SessionCommits } from '../core/commit-attribution.ts';
import type { FeedItem } from '../core/feed.ts';
import { createFeed, tsMs } from '../core/feed.ts';
import { type DisplayFile, displayFiles, type SessionFiles } from '../core/file-attribution.ts';
import {
  delegatedWork,
  displayState,
  entryLabel,
  entryTitle,
  finalResultTurn,
  isMarker,
  modelLabel,
  returnedWork,
  shortModel,
  toolDuration,
  turnCls,
  turnIsWorking,
  WF_SILENT_MS,
  workOrdinal,
} from '../core/graph-derive.ts';
import {
  contextFraction,
  contextHogs,
  maxReturnedLen,
  type RunningCommand,
  runningBackground,
  scopeToTurn,
  skillShare,
  subagentsChronological,
  tokenUsage,
  turnCostStats,
  workingMs,
} from '../core/selectors.ts';
import type {
  ActivityGroup,
  AgentNode,
  CommandNode,
  EventContext,
  SkillNode,
  ToolNode,
  TreeSnapshot,
  TurnNode,
} from '../core/session-tree.ts';
import { SPAWN_TOOL_NAMES } from '../core/session-tree.ts';
import type { DrawerHandle } from '../core/span-store.ts';
import { createSpanStore } from '../core/span-store.ts';
import type { SessionCards } from '../core/tracker-cards.ts';
import {
  formatDuration,
  formatLaunchTime,
  formatOffset,
  formatToolMs,
  modelFamily,
  promptLine,
  stripMarkdown,
  summarizeTools,
} from '../core/tree-format.ts';
import type { Baseline, NormalizedEvent } from '../core/types.ts';
import { bucketFor, computeVerdict, computeVerdicts, type TurnVerdict, turnBillable } from '../core/verdict.ts';
import { authFetch } from './auth.ts';
import { cardsList, renderCardsCard } from './cards-view.ts';
import { commitsList, renderCommitsCard } from './commits-view.ts';
import { withDeadline } from './deadline.ts';
import { renderMarkdown } from './markdown.ts';
import type { PendingKind } from './sessions.ts';
import { renderShareCardPng } from './share-card-png.ts';
import { createTrace } from './trace.ts';

// Personal baseline — fetched once and shared by every graph (it is per-user, not
// per-session). NO detector reads it: it is descriptive context for the share card, which places
// a turn against the user's own p50/p90/p95. Null until it arrives; a card built before then
// simply carries no scale bar.
let sharedBaseline: Baseline | null = null;
let baselineFetch: Promise<void> | null = null;
// ~100x the slowest reading measured on a real corpus (96ms cold, 46ms warm), so it cannot fire
// on a machine that is merely busy.
const BASELINE_TIMEOUT_MS = 10_000;
// Deliberately generous and NOT derived from a measurement. The render is local and takes
// milliseconds; the window exists to bound a FAILURE — an `img.onload` that never fires, leaving a
// button disabled for the life of the page — rather than to police a latency nobody has
// characterised.
const SHARE_CARD_TIMEOUT_MS = 30_000;
function ensureBaseline(onReady: () => void): void {
  if (sharedBaseline) return;
  if (!baselineFetch) {
    // Memoising a request that can never settle poisons the page permanently: `fetch` has no
    // timeout, a request on a half-open connection settles NEVER, and `if (!baselineFetch)` then
    // guarantees it is never retried — every later caller awaits the same dead promise, so the
    // scale bar is missing from every share card long after the network came back. The deadline
    // turns that into a failure, and the failure clears the memo so the next card asks again.
    // The BODY read is inside the deadline, not chained after it. `fetch` resolves on the response
    // HEADERS, so a deadline that ends there is already cancelled by the time the body is read — a
    // server that answers 200 and then stalls mid-body would hang `r.json()` forever, leaving this
    // memo pending and never retried, which is precisely the failure this guards against.
    baselineFetch = withDeadline(
      (signal) => authFetch('/api/baseline', { signal }).then((r) => (r.ok ? r.json() : null)),
      BASELINE_TIMEOUT_MS,
    )
      .then((b: Baseline | null) => {
        sharedBaseline = b;
      })
      .catch(() => {
        /* no baseline → the share card just omits its scale bar, and the next one retries */
        baselineFetch = null;
      });
  }
  void baselineFetch.then(() => {
    if (sharedBaseline) onReady();
  });
}

/** The session-tree state object createGraph consumes from its caller. */
/** The session-tree reducer surface the Graph consumes. */
export interface SessionTree {
  snapshot(): TreeSnapshot;
  onChange(cb: () => void): () => void;
  onEvent(cb: (e: NormalizedEvent, ctx: EventContext) => void): () => void;
}

/** Result of the /api/tool-output endpoint: the tool's returned text, its true length, and a
 * truncation flag (the server caps the text; len is the actual stored size). */
/** Payload of `GET /api/tool-output` — exported because it appears in `GraphOpts`. */
export interface ToolOutputResult {
  text: string;
  len: number;
  truncated: boolean;
}

/** Result of the /api/call-io endpoint: the API call's per-call facts, input, and output. */
/** Payload of `GET /api/call-io` — exported because it appears in `GraphOpts`. */
export interface CallIOResult {
  model: string | null;
  effort?: string | null;
  usage?: { input?: number; output?: number; cacheRead?: number; cacheCreation?: number } | null;
  input?: ToolOutputResult | null;
  output?: ToolOutputResult | null;
  outputHasTools?: boolean;
  /** The call's mid-turn text — the intent that names its round in the Trace. Null on the
   * call that closed the turn, whose text is the answer, not a statement of what comes next. */
  narration?: string | null;
}

/** Options accepted by createGraph. */
/** Options accepted by `createGraph`; `createView` forwards a subset of these. */
export interface GraphOpts {
  ended?: boolean;
  loading?: boolean;
  loadToolOutput?: ((id: string) => Promise<ToolOutputResult | null>) | null;
  loadCallIO?: ((callId: string) => Promise<CallIOResult | null>) | null;
  loadAgentPrompt?: ((agentId: string) => Promise<{ text: string; truncated: boolean } | null>) | null;
  /** The session's commits, read back from git + this transcript on demand (see session-commits). */
  loadCommits?: (() => Promise<SessionCommits | null>) | null;
  /** The files this session changed, joined server-side from its three witnesses (see
   *  session-files). Absent → the card falls back to the ledger reducer alone. */
  loadFiles?: (() => Promise<SessionFiles | null>) | null;
  /** The tracker cards this session worked on, read back from its own tool calls (see
   *  session-cards). */
  loadCards?: (() => Promise<SessionCards | null>) | null;
  // Declared because view.ts passes it, not because anything here reads it (see the note at
  // the opts site below). Typing only what is read would make every caller fail to compile,
  // which is a change to the callers dressed up as a type.
  sessionId?: string;
}

/** An HTMLElement with a _dismissed flag written by dismiss(). */
type ToastNode = HTMLElement & { _dismissed?: boolean };

// Short numbers roll up through k → M → B so a 30M token total reads "32.4M", not "32444.5k".
// k/kd keep one decimal; kc (counts) rounds. All three share the same tier boundaries.
function k(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}
function kc(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return Math.round(n / 1e9) + 'B';
  if (a >= 1e6) return Math.round(n / 1e6) + 'M';
  if (a >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(n);
}
function kd(n: number): string {
  const s = n < 0 ? '-' : '+';
  const a = Math.abs(n);
  if (a >= 1e9) return s + (a / 1e9).toFixed(1) + 'B';
  if (a >= 1e6) return s + (a / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return s + (a / 1e3).toFixed(1) + 'k';
  return s + a;
}
// Generic over the tag so the caller gets the ELEMENT's type, not the base one: `E('button')`
// is an HTMLButtonElement and `.disabled` type-checks. A widened `HTMLElement` return made every
// tag-specific property a cast at the call site, which is how one of them silently stopped
// existing.
function E<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string | null,
  text?: string | null,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
// "15 turns" / "1 turn" — one place, so no widget can ever show "1 turns" again.
// turnsWord exists separately for the Session footer, whose count sits in its own <b>.
function turnsWord(n: number): string {
  return n === 1 ? 'turn' : 'turns';
}
function nTurns(n: number): string {
  return n + ' ' + turnsWord(n);
}
// One legend-entry builder (.lg swatch + label) shared by the Context segbar legend
// and the timeline strip legend, so the two can't drift apart.
function legendItem(color: string, txt: string): HTMLElement {
  const g = E('span', 'lg');
  const sw = E('span', 'sw');
  sw.style.background = color;
  g.append(sw, document.createTextNode(txt));
  return g;
}

// Page scroll-lock, ref-counted across ALL Graph instances (one per open tab).
// openDrawer/closeDrawer are per-tab, but the page is shared, so a naive toggle
// would unlock when one tab's drawer closes while another's is still open. Counting
// open overlays keeps the page locked until the last closes.
// Both <html> AND <body> get overflow:hidden: locking <html> alone still lets the
// viewport scroll (and lets wheel scroll-chain out of the fixed drawer into the
// page) when <body> is taller than the viewport — verified live in Chromium.
let scrollLocks = 0;
function lockPageScroll() {
  if (scrollLocks++ === 0) {
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
  }
}
function unlockPageScroll() {
  if (scrollLocks > 0 && --scrollLocks === 0) {
    document.documentElement.style.overflow = '';
    document.body.style.overflow = '';
  }
}

/**
 * Mount the bento Graph view into `container`, driven by a session-tree `state`
 * ({@link createSessionTree}: snapshot() + onChange() + onEvent()). Appends the
 * widget tree AND the fixed-position overlays (scrim/drawer/output-modal/toasts)
 * to `container`, and registers a document-level `keydown` listener for Escape.
 * While the drawer is open it locks page (body) scroll via a ref-counted lock
 * shared across all instances, so the page underneath can't scroll behind it.
 * Returns `{ destroy() }`, which unsubscribes, clears timers/listener, releases the
 * scroll-lock if still held, and empties `container`. Call `goLive()` once the initial
 * replay has ended: it paints the finished session and arms live-only toasts, so neither
 * fires for replayed history. Pass `{ loading: true }` when the session's history has NOT
 * been replayed yet (the tab is showing its loader) — the graph then stays dark until
 * `goLive()`; the default paints immediately, for a graph built over a state that is
 * already whole. DOM + textContent only (no innerHTML).
 */
export function createGraph(
  container: HTMLElement,
  state: SessionTree,
  opts: GraphOpts = {},
): {
  goLive(): void;
  setEnded(): void;
  setWaiting(kind: PendingKind | null, since: number | null): void;
  setBusy(working: boolean): void;
  destroy(): void;
  _openBlock(handle: DrawerHandle): void;
} {
  // --- build the bento skeleton once; widgets replaceChildren on each render ---
  const root = E('div', 'graph-root');

  // Ended = the session's process is gone (its PID file dropped), so nothing here can
  // ever grow again: the subagent monitor collapses, the LIVE badge yields to "ended",
  // and the feed is height-capped (all via renders/CSS keyed on this flag). One-way:
  // a session that reopens comes back as a NEW tab (see app.ts), never by un-ending.
  let ended = opts.ended ?? false;
  // Whether Claude Code's own process says it is working RIGHT NOW (`isModelBusy` — `busy` only,
  // never `shell`, which names a turn that is already over; fed from the
  // roster like `waiting`). The transcript cannot answer that during a thinking block — see
  // turnIsWorking — and without it the panel called a working session finished.
  let busy = false;
  /** Is THIS entry working — the panel's rule (turnIsWorking), for every surface that shows it. */
  const working = (t: TurnNode | null | undefined, s: TreeSnapshot | null = lastSnap): boolean =>
    !!t && turnIsWorking(t, s?.turnList.at(-1)?.index === t.index, { ended, busy });
  if (ended) root.classList.add('ended');

  // The session is stopped at a dialog only the user can clear (see sessions.ts
  // `pendingInput`). It comes from the roster poll, NOT from the event stream: nothing is
  // written to the transcript while a prompt is pending, so this is the one live signal
  // seedeep holds that no event can carry. `waitingSince` is Claude Code's own
  // statusUpdatedAt — the instant it started waiting, not the instant we noticed.
  let waiting: PendingKind | null = null;
  let waitingSince: number | null = null;

  // top row: insight widgets stacked left, live feed filling the right.
  // Top cockpit: the two live signals side by side — Context (the main session's window)
  // and the live subagent monitor stacked on the left, the live activity feed on the right.
  const toprow = E('div', 'toprow');
  const stack = E('div', 'stack');
  const ctxCard = E('div', 'card');
  // Live subagent monitor: running subagents surfaced (context filling live + current
  // action). The full per-subagent detail cards live at the bottom of the page (subsCard);
  // this widget is the at-a-glance tree. renderSubLive owns ALL the card's children — on
  // an ended session it swaps the whole card for a one-line summary.
  // Survives the card's rebuild on every render — see renderSubLive.
  let liveScrollTop = 0;
  const subLiveCard = E('div', 'card sublivecard');
  stack.append(ctxCard, subLiveCard);
  const liveCard = E('div', 'card livecard');
  const liveHead = E('div');
  liveHead.style.display = 'flex';
  liveHead.style.flexDirection = 'column';
  liveHead.style.gap = '5px';
  const liveTitle = E('div', 'wtitle', 'Live activity');
  const liveBadge = E('span', 'live');
  liveBadge.append(E('span', 'pulse'), document.createTextNode('live'));
  // its quiet counterpart for an ended session — a pulsing LIVE on a dead session is a lie
  const endBadge = E('span', 'endbadge hidden');
  endBadge.append(E('span', 'edot'), document.createTextNode('ended'));
  const traceBtn = E('button', 'tracebtn', 'Trace');
  // The feed ring keeps only the last FEED_CAP activities per turn (measured: that is the
  // MEDIAN turn, so roughly half of all turns lose rows to it). This opens the complete
  // list, read from the span store, which drops nothing.
  const liveExpand = E('button', 'xbtn', 'Expand all');
  // Title row: title + Trace button on the same line as the badge; description below.
  const liveTitleRow = E('div');
  liveTitleRow.style.display = 'flex';
  liveTitleRow.style.alignItems = 'center';
  liveTitleRow.style.justifyContent = 'space-between';
  const liveTitleLeft = E('div');
  liveTitleLeft.style.display = 'flex';
  liveTitleLeft.style.alignItems = 'center';
  liveTitleLeft.style.gap = '10px';
  liveTitleLeft.append(liveTitle, liveExpand);
  const liveBadgeWrap = E('div');
  liveBadgeWrap.style.display = 'flex';
  liveBadgeWrap.style.alignItems = 'center';
  liveBadgeWrap.style.gap = '6px';
  liveBadgeWrap.append(traceBtn, liveBadge, endBadge);
  liveTitleRow.append(liveTitleLeft, liveBadgeWrap);
  liveHead.append(liveTitleRow);
  // The NOW panel (V1): the glance surface between the header and the feed. It answers
  // "what is the agent doing / what did it conclude" — the live intent (or the turn's final
  // output once it lands) and its age. The text is clamped to two lines; when it overflows,
  // `nowMore` opens the full text in the output modal. renderNowPanel owns all its children.
  const nowPanel = E('div', 'nowpanel');
  const nowHead = E('div', 'nowhead');
  const nowLbl = E('span', 'nowlbl', 'now');
  const nowAge = E('span', 'nowage', '');
  nowHead.append(nowLbl, nowAge);
  // A detached node that exists only to give the shared ticker something to write to when what
  // must re-run each second is the panel's DECISION, not one label's text (see renderNowPanel).
  const nowTick = E('span');
  let nowTickArmed = false;
  const nowTextWrap = E('div', 'nowtextwrap');
  const nowText = E('div', 'nowtext');
  const nowMore = E('button', 'nowmore', 'more');
  nowTextWrap.append(nowText, nowMore);
  nowPanel.append(nowHead, nowTextWrap);
  const feedHost = E('div', 'feed');
  feedHost.style.marginTop = '.4rem';
  liveCard.append(liveHead, nowPanel, feedHost);
  toprow.append(stack, liveCard);

  // Stats strip — retrospective/aggregate widgets, all the same height: Session (tokens
  // by category + turn KPIs — the turn DISTRIBUTION lives only in the timeline strip),
  // Skills+Commands (merged into one card), and Main tools.
  const statsRow = E('div', 'statsrow');
  const usageCard = E('div', 'card statw burnw');
  // Skills and Commands share one card (each too small to stand alone); they render into
  // their own sub-nodes so renderSkills/renderCommands stay unchanged.
  const skillsCard = E('div', 'cpart');
  const commandsCard = E('div', 'cpart');
  const skCombo = E('div', 'card');
  const combo = E('div', 'combo');
  combo.append(skillsCard, commandsCard);
  skCombo.append(combo);
  const toolsCard = E('div', 'card');
  const toolsHead = E('div', 'whead');
  const toolsExpand = E('button', 'xbtn', 'Expand all');
  toolsHead.append(E('div', 'wtitle', 'Main tools'), toolsExpand);
  const toolsHost = E('div');
  toolsCard.append(
    toolsHead,
    E(
      'div',
      'wdesc',
      'Top context consumers first, then all tool types as counts. Click a type to browse its calls, or Expand all for the full list.',
    ),
    toolsHost,
  );
  // Files changed — Claude Code's file-history ledger. Hero total + a bar per file type;
  // the complete list lives in the drawer (Expand all). It sits third, immediately LEFT of Main
  // tools: statsRow is 22/22/22/34, so the three summary cards are equal and Main tools — the
  // only one holding full paths — keeps the widest column.
  // `statw burnw` only for the hero-number styling (`.statw .num`, `.burnw .num small`) it shares
  // with the Session card — the rest of those rules target descendants this card does not have.
  const filesCard = E('div', 'card statw burnw');
  const filesHead = E('div', 'whead');
  const filesExpand = E('button', 'xbtn', 'Expand all');
  filesHead.append(E('div', 'wtitle', 'Changed files'), filesExpand);
  const filesHost = E('div');
  // The description IS the caption: it names the set the number came from, so the card does not
  // need a trailing line for it. Rewritten on every render by `filesDescText`.
  const filesDesc = E('div', 'wdesc', 'How many project files changed in scope.');
  filesCard.append(filesHead, filesDesc, filesHost);
  // Three EQUAL summary cards; Main tools moves down to lead the output row, where it finally
  // stops truncating the paths it is the only card to carry.
  statsRow.append(usageCard, skCombo, filesCard);

  // Output row, in one line: Main tools (50%) · Commits (25%) · Cards (25%) — what the session ran,
  // what it shipped, and what it was working on. Main tools LEADS (Davide's call): it is the widest
  // card and the one with the most to read, so it takes the position the eye reaches first. All
  // three are ALWAYS there (also Davide's call): a widget that appears only once it has content
  // cannot say "this session shipped no commit", and its absence is indistinguishable from seedeep
  // not looking.
  const outRow = E('div', 'outrow triple');
  const commitsCard = E('div', 'card statw burnw');
  const commitsHead = E('div', 'whead');
  const commitsExpand = E('button', 'xbtn', 'Expand all');
  // Hidden until there is something to expand: the drawer it opens is built from the rows, so on
  // an empty card the button is a control that does nothing when clicked.
  commitsExpand.hidden = true;
  commitsHead.append(E('div', 'wtitle', 'Commits'), commitsExpand);
  const commitsHost = E('div');
  // The description lives in the renderer, not here: what the card may promise depends on
  // whether anything in it is actually openable.
  commitsCard.append(commitsHead, commitsHost);
  const cardsCard = E('div', 'card statw burnw');
  const cardsHead = E('div', 'whead');
  const cardsExpand = E('button', 'xbtn', 'Expand all');
  cardsExpand.hidden = true;
  cardsHead.append(E('div', 'wtitle', 'Cards'), cardsExpand);
  const cardsHost = E('div');
  cardsCard.append(cardsHead, cardsHost);
  // Fixed 50/25/25: the row never reshuffles, so nothing here has to detect a change in its
  // shape. The two trailing cards carry their own empty state, which is what a widget says when
  // the answer is "none" — the same thing Subagents and Skills have always done.
  outRow.append(toolsCard, commitsCard, cardsCard);

  // subagents grid — the full per-subagent detail cards, at the bottom.
  const subsCard = E('div', 'card');
  subsCard.append(
    E('div', 'wtitle', 'Subagents · in launch order'),
    E('div', 'wdesc', 'Each subagent that ran, in the order it was launched. Click for its full launch prompt.'),
  );
  const subsHost = E('div', 'subgrid');
  subsHost.style.marginTop = '.3rem';
  subsCard.append(subsHost);

  const turnExplorerDiv = E('div'); // full-width, below toprow, hidden until stripOpen
  const scopeBanner = E('div', 'scope-banner');
  scopeBanner.onclick = () => {
    stripOpen = !stripOpen;
    render();
  };
  root.append(scopeBanner, turnExplorerDiv, toprow, statsRow, outRow, subsCard);

  // overlays: scrim + drawer, output modal, toasts (single-overlay machinery)
  const scrim = E('div', 'scrim');
  const drawer = E('div', 'drawer');
  const dclose = E('button', 'close', '✕');
  const dbody = E('div');
  drawer.append(dclose, dbody);

  const omodal = E('div', 'omodal');
  const oscrim = E('div', 'oscrim');
  const obox = E('div', 'obox');
  const ohead = E('div', 'ohead');
  const otitleWrap = E('div');
  const otitle = E('h3', null, 'Output');
  const osub = E('div', 'osub');
  otitleWrap.append(otitle, osub);
  const oclose = E('button', 'oclose', '✕');
  ohead.append(otitleWrap, oclose);
  const obody = E('div', 'obody');
  obox.append(ohead, obody);
  omodal.append(oscrim, obox);

  // Share card preview modal: fetch PNG → show → user decides to download or not.
  const spmodal = E('div', 'spmodal');
  const spbox = E('div', 'spbox');
  const spimg = document.createElement('img');
  spimg.alt = 'Share card preview';
  const spfoot = E('div', 'spfoot');
  const sptitle = E('span', 'sptitle');
  const spactions = E('div', 'spactions');
  const spdlBtn = E('button', 'sbout sbout-share', '⬇ Download');
  const spcloseBtn = E('button', 'sbout', 'Close');
  spactions.append(spcloseBtn, spdlBtn);
  spfoot.append(sptitle, spactions);
  spbox.append(spimg, spfoot);
  spmodal.append(spbox);

  let sharePngUrl: string | null = null;
  let sharePngFile = 'seedeep-share.png';

  function openSharePreview(url: string, filename: string): void {
    if (sharePngUrl) URL.revokeObjectURL(sharePngUrl);
    sharePngUrl = url;
    sharePngFile = filename;
    spimg.src = url;
    sptitle.textContent = filename;
    spmodal.classList.add('on');
    lockPageScroll();
  }
  function closeSharePreview(): void {
    spmodal.classList.remove('on');
    unlockPageScroll();
    if (sharePngUrl) {
      URL.revokeObjectURL(sharePngUrl);
      sharePngUrl = null;
    }
    spimg.src = '';
  }
  spmodal.onclick = closeSharePreview;
  spbox.onclick = (e: MouseEvent) => e.stopPropagation();
  spcloseBtn.onclick = closeSharePreview;
  spdlBtn.onclick = () => {
    if (!sharePngUrl) return;
    const a = document.createElement('a');
    a.href = sharePngUrl;
    a.download = sharePngFile;
    a.click();
  };

  const toasts = E('div', 'toasts'); // top rail: tool toasts
  const subToasts = E('div', 'toasts bottom'); // bottom rail: subagent toasts

  // The overlays (scrim/drawer/omodal/toasts) are position:fixed but live INSIDE the
  // per-tab container. With multiple open sessions there is one overlay set per tab;
  // the inactive tab's panel is display:none, which correctly hides its whole subtree
  // (fixed children included), so only the active tab's overlays are ever visible.
  // LIMIT: the Escape keydown listener is document-global and per-instance, so every
  // mounted tab reacts to Escape — harmless (a hidden tab's closeDrawer is a no-op on
  // already-closed overlays), but a single shared controller would be cleaner if tab
  // count ever grows large.
  container.append(root, scrim, drawer, omodal, spmodal, toasts, subToasts);

  // Span-store: fed from onEvent; snapshot() scopes to a turn or returns whole-session.
  // createTrace is lazy (null until first click) — the modal DOM is built only when needed.
  const spanStore = createSpanStore();
  let trace: ReturnType<typeof createTrace> | null = null;
  let traceRafPending = false;

  // ---- turn view state: selectedTurn + strip toggle + active filter ----
  let selectedTurn: number | null = null,
    stripOpen = false,
    activeFilter = 'all';
  // Last snapshot rendered — the feed (driven by events, not by snapshots) needs the
  // selected turn's state to decide whether it is still live.
  let lastSnap: TreeSnapshot | null = null;
  // Every turn's verdict for `lastSnap`, computed ONCE per render (see render()) and shared by
  // the Verdict lens, the flagged columns and the scope banner — the three surfaces that must
  // never disagree about a turn's severity. Empty until the first render.
  let verdicts = new Map<number, TurnVerdict>();
  // Turn indices whose verdict has already been announced, so a second `turn-end` (a resumed
  // session, a repeated line) cannot toast the same turn twice.
  const announced = new Set<number>();

  // opts.sessionId: not read here yet — threaded forward for trace.ts direct-fetch (future).

  // Injected by the tab (app.ts): fetches what a tool returned, on click. Absent in a graph
  // built without it — the drawer then simply shows no output block.
  const loadToolOutput = opts.loadToolOutput ?? null;
  // Same shape for an API call: fetches its input + output + model + usage from the session
  // file on click (never held in the client, like tool output). Absent → no I/O block.
  const loadCallIO = opts.loadCallIO ?? null;
  const loadAgentPrompt = opts.loadAgentPrompt ?? null;
  const loadCommits = opts.loadCommits ?? null;
  const loadFiles = opts.loadFiles ?? null;
  const loadCards = opts.loadCards ?? null;

  // ---- overlay open/close (single overlay: drawer; modal only above it) ----
  function openDrawer() {
    // Spacer at the end of dbody so the last element is never clipped by the viewport edge.
    // Chrome ignores padding-bottom on overflow:auto containers, so a real child is the fix.
    const spacer = E('div', 'drawer-spacer');
    dbody.append(spacer);
    if (!drawer.classList.contains('on')) lockPageScroll();
    scrim.classList.add('on');
    drawer.classList.add('on');
    toasts.classList.add('shifted');
    subToasts.classList.add('shifted');
  }
  function closeDrawer() {
    if (drawer.classList.contains('on')) unlockPageScroll();
    scrim.classList.remove('on');
    drawer.classList.remove('on');
    toasts.classList.remove('shifted');
    subToasts.classList.remove('shifted');
  }
  scrim.onclick = closeDrawer;
  dclose.onclick = closeDrawer;

  // ---- drawer breadcrumb navigation ----
  type BackEntry = { label: string; open: () => void };
  const crumbs: BackEntry[] = [];
  function renderCrumbs(): void {
    if (!crumbs.length) return;
    const nav = E('nav', 'breadcrumb');
    crumbs.forEach((c, i) => {
      const lnk = E('span', 'crumb-link clk', c.label);
      lnk.onclick = () => {
        crumbs.splice(i);
        c.open();
      };
      nav.append(lnk, E('span', 'crumb-sep', ' ›'));
    });
    dbody.append(nav);
  }
  // Prompts and results ARE markdown (that is how Claude writes and how you type), so the
  // modal renders them as such. renderMarkdown builds DOM nodes, never innerHTML — the
  // content is untrusted session text and must not be able to inject markup.
  // A TOOL's output is not markdown, though — it is a file, a diff, a log — so it is shown
  // verbatim in a <pre> (`plain`), where markdown rendering would eat its indentation.
  function openOutput(title: string, sub: string, full: string, plain = false): void {
    otitle.textContent = title;
    osub.textContent = sub;
    obody.replaceChildren(...(plain ? [E('pre', 'opre', full)] : renderMarkdown(full)));
    omodal.classList.add('on');
  }
  function closeOutput() {
    omodal.classList.remove('on');
  }
  oscrim.onclick = closeOutput;
  oclose.onclick = closeOutput;
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    // Stop propagation so the trace.ts window-level Escape handler does not also fire
    // while a drawer/modal overlay is open — the drawer must close BEFORE the trace.
    // document handlers run before window handlers in bubble order, so stopPropagation
    // here reliably swallows the event from trace.ts's window listener.
    if (spmodal.classList.contains('on')) {
      closeSharePreview();
      e.stopPropagation();
      return;
    }
    if (omodal.classList.contains('on')) {
      closeOutput();
      e.stopPropagation();
      return;
    }
    if (drawer.classList.contains('on')) {
      closeDrawer();
      e.stopPropagation();
    }
  };
  document.addEventListener('keydown', onKey);

  function drow(kk: string, v: string): HTMLElement {
    const r = E('div', 'drow');
    r.append(E('span', 'dk', kk), E('span', 'dv', v));
    return r;
  }
  function block(label: string, node: HTMLElement): HTMLElement {
    const bl = E('div', 'block');
    bl.append(E('div', 'blabel', label), node);
    return bl;
  }
  // Like block(), but with a muted one-line subtitle between the (short) label and the content —
  // so an explanation lives in the subtitle instead of bloating the uppercase label into two lines.
  function blockD(label: string, desc: string | null, node: HTMLElement): HTMLElement {
    const bl = E('div', 'block');
    bl.append(E('div', 'blabel', label));
    if (desc) bl.append(E('div', 'wdesc', desc));
    bl.append(node);
    return bl;
  }

  // ---- drawer header / KPI / bar primitives (shared by every open* below) ----
  // Every drawer opens the same way: WHAT it is (chip), WHICH one (title), and the identity
  // line — type, model, owner. Identity only: a measurement belongs in a tile, never here.
  function dhead(kind: string, title: string, sub?: (string | null)[] | null): HTMLElement {
    const h = E('div', 'dhead');
    const eye = E('div', 'deyebrow');
    eye.append(E('span', 'dchip', kind));
    h.append(eye, E('h3', null, title));
    const parts = (sub || []).filter((s): s is string => Boolean(s));
    if (parts.length) {
      const d = E('div', 'dsub');
      parts.forEach((p, i) => {
        if (i) d.append(E('span', 'sep', '·'));
        d.append(document.createTextNode(p));
      });
      h.append(d);
    }
    return h;
  }
  // Replace a header's identity line (the API-call drawer learns its model only after the
  // fetch lands). Appends the line if the header was built without one.
  function setDSub(head: HTMLElement, parts: (string | null)[]): void {
    const kept = parts.filter((s): s is string => Boolean(s));
    let d = head.querySelector('.dsub') as HTMLElement | null;
    if (!d) {
      d = E('div', 'dsub');
      head.append(d);
    }
    d.replaceChildren();
    kept.forEach((p, i) => {
      if (i) d.append(E('span', 'sep', '·'));
      d.append(document.createTextNode(p));
    });
  }
  // A KPI tile. `unit` is rendered small and dim beside the value so "1k chars" reads as one
  // figure with a unit, not as two competing numbers.
  function kpi(label: string, value: string, unit?: string | null): HTMLElement {
    const t = E('div', 'kpi');
    const v = E('div', 'kv');
    // The value is a TEXT NODE, not the element's own textContent: the unit is a sibling
    // <small>, and mixing the two ways of holding text makes the element's readable content
    // depend on which was set last.
    v.append(document.createTextNode(value));
    if (unit) v.append(E('small', null, ' ' + unit));
    t.append(E('div', 'kl', label), v);
    return t;
  }
  // The tile row. Sets --n so 2 tiles split the width evenly instead of leaving a gap.
  function kpis(...tiles: HTMLElement[]): HTMLElement {
    const row = E('div', 'kpis');
    row.style.setProperty('--n', String(tiles.length));
    row.append(...tiles);
    return row;
  }
  // Replace a tile's value (async fills, e.g. the API-call drawer). Clears the `wait`
  // placeholder styling so a real figure never keeps the dim pending look.
  function setKV(tile: HTMLElement, value: string, unit?: string | null): void {
    const v = tile.children[1];
    if (!v) return;
    v.classList.remove('wait');
    v.replaceChildren(document.createTextNode(value), ...(unit ? [E('small', null, ' ' + unit)] : []));
  }
  // A tile whose value is not known yet.
  function kpiWait(label: string): HTMLElement {
    const t = kpi(label, '···');
    t.children[1]?.classList.add('wait');
    return t;
  }

  type Seg = { label: string; value: number; color: string; detail?: string | null };
  // A stacked proportion bar + legend: the ONLY honest way to show four categories whose
  // story is their ratio (a subagent's volume is ~96% cache re-reads). Zero-value segments
  // are dropped from the bar but kept in the legend — "output 71" is still a fact.
  function stackBlock(label: string, total: string, segs: Seg[]): HTMLElement {
    const bl = E('div');
    const head = E('div', 'chead');
    head.append(E('span', 'clbl', label), E('span', 'cval', total));
    const bar = E('div', 'dstack');
    const sum = segs.reduce((n, s) => n + s.value, 0);
    for (const s of segs) {
      if (sum <= 0 || s.value <= 0) continue;
      const i = E('i');
      i.style.width = (s.value / sum) * 100 + '%';
      i.style.background = s.color;
      bar.append(i);
    }
    const leg = E('div', 'legend');
    for (const s of segs) {
      const it = E('span');
      const sw = E('i');
      sw.style.background = s.color;
      it.append(sw, document.createTextNode(s.label + ' '), E('b', null, s.detail || ''));
      leg.append(it);
    }
    bl.append(head, bar, leg);
    return bl;
  }
  // A single-quantity fill bar, reusing the .crow primitive the Graph cards already use —
  // so a percentage looks the same everywhere in seedeep.
  function fillBar(label: string, caption: string, pct: number, grad: string): HTMLElement {
    const c = E('div', 'crow');
    const head = E('div', 'chead');
    head.append(E('span', 'clbl', label), E('span', 'cval', caption));
    const track = E('div', 'ctrack');
    const bar = E('div', 'cbar');
    const fill = E('i');
    fill.style.width = Math.max(0, Math.min(100, pct)) + '%';
    fill.style.background = grad;
    bar.append(fill);
    track.append(bar, E('span', 'cpct', Math.round(pct) + '%'));
    c.append(head, track);
    return c;
  }
  // The demoted bookkeeping list. Pairs with a null/'—' value are dropped: an empty row in a
  // "Details" block is pure noise.
  function metaBlock(pairs: [string, string | null][]): HTMLElement | null {
    const kept = pairs.filter(([, v]) => v && v !== '—');
    if (!kept.length) return null;
    const dl = E('dl', 'meta');
    for (const [kk, v] of kept) dl.append(E('dt', null, kk), E('dd', null, v as string));
    return block('Details', dl);
  }

  // ---- widget renderers (read only from the current snapshot) ----
  let toolChipsExpanded = false;
  // The single pending repaint that flips a silent workflow run to `unknown` (see renderSubLive).
  let wfStaleTimer: ReturnType<typeof setTimeout> | null = null;

  // A tool with no end-time is 'running…' on a live session — but on an ended one it
  // can't be: the session died mid-call, and a frozen 'running…' would be a lie.
  function renderCtx(m: TreeSnapshot['main']): void {
    ctxCard.replaceChildren();
    ctxCard.append(
      E('div', 'wtitle', 'Context'),
      E('div', 'wdesc', 'How full the window is right now, and what fills it.'),
    );
    const w = E('div', 'ctxw');
    const d = E('div', 'dial');
    d.style.setProperty('--p', String(m.pct));
    d.append(E('span', 'pv', `${m.pct}${m.estimated ? '~' : ''}%`));
    // Number, bar and legend all sit in the column BESIDE the dial, so the card is only as
    // tall as the dial itself (measured: 174px → 143px). Stacking them under it cost 31px of
    // the cockpit's most valuable space for no added meaning.
    const col = E('div', 'col');
    const big = E('div', 'big');
    big.append(document.createTextNode(k(m.fill)));
    big.append(E('small', null, ' / ' + k(m.window)));
    col.append(big);
    const seg = E('div', 'segbar');
    const parts: [string, number, string][] = [
      ['#38bdf8', m.breakdown.cacheRead, 'Cache read'],
      ['#a78bfa', m.breakdown.cacheCreation, 'Cache write'],
      ['#f472b6', m.breakdown.input, 'Input'],
    ];
    for (const [color, val] of parts) {
      if (m.window > 0 && val > 0) {
        const s = E('span');
        s.style.background = color;
        s.style.width = (val / m.window) * 100 + '%';
        seg.append(s);
      }
    }
    col.append(seg);
    // colour key for the segbar — without it the mapping only existed in the description text
    const legend = E('div', 'seglegend');
    for (const [color, , label] of parts) legend.append(legendItem(color, label));
    col.append(legend);
    w.append(d, col);
    ctxCard.append(w);
  }

  // Model swatch colours, keyed by FAMILY so one model keeps one colour across sessions and
  // across the two ids the same model arrives under: a spawn names it `haiku`, its own
  // transcript `claude-haiku-4-5-20251001`. Cool tones, off the severity palette — the Home
  // tab's model swatches follow the same rule (it assigns by rank, which cannot be stable here).
  const MODEL_TINT: Record<string, string> = {
    opus: '#a78bfa',
    sonnet: '#2dd4bf',
    haiku: '#f472b6',
    fable: '#818cf8',
  };
  const modelTint = (model: string | null): string => MODEL_TINT[modelFamily(model) ?? ''] ?? '#8593ad';

  /**
   * The Subagents row opened up: which models burned those tokens. Subagent tokens ONLY — the
   * main thread is never in here (the reducer keeps the two apart by `owner`), so the bar splits
   * exactly the figure on the row above it, not the hero. Renders nothing when no subagent ran,
   * because the row it explains is absent then too.
   * Grouped by family: `haiku` and `claude-haiku-4-5-20251001` are one model, and 2.1% of real
   * subagent transcripts carry more than one family, so the split is per CALL, not per agent.
   */
  function appendSubagentModels(host: HTMLElement, s: TreeSnapshot): void {
    const byFamily = new Map<string, number>();
    for (const { model, tokens } of s.subagentTokensByModel) {
      const key = shortModel(model) || 'unknown';
      byFamily.set(key, (byFamily.get(key) ?? 0) + tokens);
    }
    const rows = [...byFamily.entries()].sort((a, b) => b[1] - a[1]);
    const total = rows.reduce((n, [, t]) => n + t, 0);
    if (total <= 0) return;
    const wrap = E('div', 'submdl');
    wrap.append(E('div', 'submdlh', 'by model'));
    // Reuses the Context card's .segbar/.seglegend: same encoding, same reading.
    const bar = E('div', 'segbar');
    for (const [family, tokens] of rows) {
      const seg = E('span');
      seg.style.background = modelTint(family);
      seg.style.width = (tokens / total) * 100 + '%';
      bar.append(seg);
    }
    wrap.append(bar);
    const legend = E('div', 'seglegend');
    for (const [family, tokens] of rows) {
      legend.append(legendItem(modelTint(family), `${family} ${Math.round((tokens / total) * 100)}%`));
    }
    wrap.append(legend);
    host.append(wrap);
  }

  // Session: every token billed in the scope, as three additive rows — Cache read, New input
  // (cache-write + the tiny uncached input_tokens, so the misleadingly small raw "Input" is not
  // shown on its own), and Output — plus subagents as a separate row (a background subagent
  // reports one total, never a breakdown — so it cannot be folded in). Hero = the whole-session
  // total, subagents included. Volume, not cost.
  // The footer carries the turn KPIs and the timeline entry point (the former Turns card):
  // the turn DISTRIBUTION lives only in the strip, so the card never duplicates it. The
  // footer always reads the FULL snapshot — it is the navigator; a scoped turn's own
  // numbers live in the banner.
  function renderTokenUsage(s: TreeSnapshot, full: TreeSnapshot): void {
    const m = s.main;
    usageCard.replaceChildren();
    const where = selectedTurn !== null ? 'this turn' : 'this session';
    // The chip follows the SCOPE, like the ledger under it: with a turn selected the card
    // reads "Tokens billed this turn", so a chip naming the session's model there would
    // qualify one thing while the numbers beside it describe another.
    const title = E('div', 'wtitle', 'Session');
    const scopedTurn = selectedTurn !== null ? full.turnList.find((t) => t.index === selectedTurn) : null;
    appendModelChips(
      title,
      scopedTurn ? scopedTurn.models : full.main.models,
      scopedTurn ? scopedTurn.efforts : sessionEfforts(full),
    );
    usageCard.append(title, E('div', 'wdesc', 'Tokens billed ' + where + ', by category.'));
    const u = tokenUsage(m);
    const agents = s.subagentsTotal ?? 0;
    if (u.total + agents === 0) {
      usageCard.append(E('div', 'num', '—'), E('div', 'led'));
      usageCard.append(E('div', 'cap', 'no API call in this scope'));
    } else {
      const num = E('div', 'num');
      num.append(document.createTextNode(k(u.total + agents)));
      num.append(E('small', null, 'tokens'));
      usageCard.append(num);
      const rows: [string, number, boolean, boolean?][] = [
        ['Cache read', u.cacheRead, false],
        // "New input" = the content actually ADDED this session (prompts, tool outputs, images):
        // cache_creation (where it lands when first sent) + the tiny uncached input_tokens tail.
        // Raw input_tokens alone read as "all my input" but is ~2/call — the real input is here.
        ['New input', u.cacheWrite + u.input, false],
        ['Output', u.output, false],
      ];
      // true → divider above (different grouping); est → the total blends estimated subagent volumes.
      if (agents > 0) rows.push(['Subagents', agents, true, s.subagentsEstimated]);
      // The three rows above are the MAIN thread's categories; `Subagents` is a different axis
      // (an actor, not a category) that adds to the same hero. Unlabelled they read as four
      // items of one list, and the hero stops looking like their sum — so the main block says
      // whose tokens it is counting.
      usageCard.append(E('div', 'ledlbl', 'main session'));
      const led = E('div', 'led');
      for (const [label, val, sep, est] of rows) {
        led.append(
          E('div', 'lk' + (sep ? ' sep' : ''), label),
          E('div', 'ld' + (sep ? ' sep' : '')),
          E('div', 'lv' + (sep ? ' sep' : ''), (est ? '~' : '') + k(val)),
        );
      }
      usageCard.append(led);
      appendSubagentModels(usageCard, s);
    }
    // Unconditional single exit: the footer is the timeline's entry point and must
    // survive any future early-return added to the ledger above.
    usageCard.append(sessionFoot(full));
  }

  // The Session card's footer — whole-session numbers ONLY (turns, interruptions, API
  // calls) plus the Explore/Close toggle for the timeline strip. It stays global even
  // when the ledger above is scoped: it is the navigator, and a scoped turn's own
  // numbers already live in the banner.
  function sessionFoot(full: TreeSnapshot): HTMLElement {
    const foot = E('div', 'sessfoot');
    const tk = E('span', 'sfk');
    tk.append(E('b', null, String(full.turns)), document.createTextNode(' ' + turnsWord(full.turns)));
    foot.append(tk);
    const stats = turnCostStats(full);
    if (stats.escCount > 0) foot.append(E('span', 'sfk esc', stats.escCount + ' interrupted'));
    if (full.apiCalls > 0) foot.append(E('span', 'sfk', kc(full.apiCalls) + ' API calls'));
    if (full.turnList.length > 0) {
      // Plain event: no pointer-events:none trick — click target must be reliable in Safari.
      const ob = E('button', 'obtn', stripOpen ? 'Close' : 'Explore →');
      ob.onclick = (ev: MouseEvent) => {
        ev.stopPropagation();
        stripOpen = !stripOpen;
        render();
      };
      foot.append(ob);
    }
    return foot;
  }

  // The timeline shows EVERYTHING you sent, and the colour says what it turned out to be:
  // a work turn (cyan / green while burning tokens / red if you hit Esc), a context event
  // — /clear, /compact, or a compaction — that moved the window (violet), or a local command
  // that cost nothing (grey). Kind and state come from the reducer, which decides by cost.
  // The stub height for a zero-delta entry (see isMarker in graph-derive): invisible and
  // unclickable otherwise, even though you DID send it. So the moment you press enter
  // something appears, and nothing you sent is ever omitted.
  const MARKER_H = '20%';

  function selectTurn(idx: number): void {
    selectedTurn = selectedTurn === idx ? null : idx;
    render();
  }

  // "Whole session" is the way OUT of turn mode, so it also puts the explorer away — the
  // strip is the turn picker, and leaving it open after dropping the scope left the view
  // in a half-state that "Close" (the same strip, dismissed) did not.
  function clearScope() {
    selectedTurn = null;
    stripOpen = false;
    render();
  }

  /** A turn's severity from the shared map; 'good' for anything not computed (never throws). */
  function sevOf(t: TurnNode): 'good' | 'warn' | 'crit' {
    return verdicts.get(t.index)?.severity ?? 'good';
  }
  const isFlagged = (t: TurnNode) => sevOf(t) !== 'good';

  function filteredTurns(s: TreeSnapshot): TurnNode[] {
    const all = s.turnList;
    if (activeFilter === 'interrupted') return all.filter((t) => t.state === 'interrupted');
    if (activeFilter === 'top10')
      return [...all].sort((a, b) => Math.abs(b.deltaFill) - Math.abs(a.deltaFill)).slice(0, 10);
    if (activeFilter === 'subagents') return all.filter((t) => t.agentIds.length > 0);
    if (activeFilter === 'waste') return all.filter(isFlagged);
    return all;
  }

  function renderTurnExplorer(s: TreeSnapshot): void {
    // Always called with the full snapshot. Strip goes ABOVE the toprow.
    turnExplorerDiv.replaceChildren();
    if (!stripOpen || s.turnList.length === 0) return;

    const box = E('div', 'tstrip');

    // The verdicts come from render()'s single computation (`verdicts`), shared with the scope
    // banner — the Verdict chip, the flagged columns and the findings list read the same map, so
    // they can never disagree on a turn's severity.

    // header: title + filter chips
    const intCount = s.turnList.filter((t) => t.state === 'interrupted').length;
    const subCount = s.turnList.filter((t) => t.agentIds.length > 0).length;
    const wasteCount = s.turnList.filter(isFlagged).length;
    const filterDefs = [
      { key: 'all', label: 'All ' + s.turnList.length },
      { key: 'interrupted', label: 'Interrupted ' + intCount, esc: true },
      { key: 'top10', label: 'Top cost 10' },
      { key: 'subagents', label: 'With subagents ' + subCount },
      { key: 'waste', label: 'Verdict ' + wasteCount, waste: true },
    ];
    const chips = E('div', 'fchips');
    for (const f of filterDefs) {
      const on = activeFilter === f.key;
      const c = E(
        'span',
        'fchip' + (f.esc ? ' esc' : '') + ((f as { waste?: boolean }).waste ? ' waste' : '') + (on ? ' on' : ''),
        f.label,
      );
      c.onclick = () => {
        activeFilter = f.key;
        renderTurnExplorer(s);
      };
      chips.append(c);
    }
    // The strip counts ENTRIES (everything sent), the Session footer counts WORK turns.
    // Saying "Turns · 13" next to a counter reading 11 made them look like two broken
    // counters; naming each for what it actually counts makes the difference the information.
    const h = E('div', 'whead');
    h.append(E('div', 'wtitle', 'Timeline · ' + s.turnList.length + ' sent · ' + nTurns(s.turns)), chips);
    box.append(h);
    box.append(
      E(
        'div',
        'wdesc',
        'One column per thing you sent — height = context added, below the line = context freed. Grey = a local command (no tokens), violet = /clear or /compact. Click to scope every widget.',
      ),
    );

    // The Verdict chip is a LENS: when active it dims every non-flagged column (via the filter's
    // `shown` set) and reveals the verdict list below. In every other view the chart carries NO
    // verdict decoration — the bars keep their single meaning (context moved), by state colour.
    // The chip's number counts the FLAGGED turns (what to act on); the list below covers every
    // work turn, because the verdict has two faces and a clean turn is a result, not a blank.
    const wasteLens = activeFilter === 'waste';

    // bar chart: positive delta above baseline, compaction (negative) below
    const shown = new Set(filteredTurns(s).map((t) => t.index));
    const maxUp = Math.max(1, ...s.turnList.filter((t) => t.deltaFill > 0).map((t) => t.deltaFill));
    const maxDn = Math.max(1, ...s.turnList.filter((t) => t.deltaFill < 0).map((t) => -t.deltaFill));
    const bars = E('div', 'sbars');
    for (const t of s.turnList) {
      const dim = shown.has(t.index) ? '' : ' dim';
      const sel = t.index === selectedTurn ? ' sel' : '';
      const b = E('div', 'sb' + sel + dim);
      const up = E('div', 'up'),
        dn = E('div', 'dn');
      if (t.deltaFill > 0 || isMarker(t)) {
        const i = E('i');
        i.style.height = isMarker(t) ? MARKER_H : Math.max(4, (t.deltaFill / maxUp) * 100) + '%';
        const c = turnCls(t, working(t, s));
        if (c) i.className = c;
        up.append(i);
      }
      if (t.deltaFill < 0) {
        const i = E('i');
        i.style.height = Math.max(4, (-t.deltaFill / maxDn) * 100) + '%';
        const c = turnCls(t, working(t, s));
        if (c) i.className = c;
        dn.append(i);
      }
      b.append(up, E('div', 'base'), dn);
      // In the Verdict lens only, a flagged column gets an underline ATTACHED to it — one
      // unambiguous "this turn has a finding", not a detached dot and not a second bar colour.
      // Two tiers, because they are two different statements: rose = crit (waste that happened),
      // amber = warn (a cold resume, a context near its limit, a second correction in a row, or
      // a merely oversized turn). Measured over 2798 real turns: 9.4% crit, 13.9% warn — hiding
      // warn would discard three flagged turns in five.
      if (wasteLens && isFlagged(t)) b.append(E('span', 'wunder ' + sevOf(t)));
      b.title = '#' + t.index + ' · ' + entryLabel(t, 120) + ' · ' + kd(t.deltaFill);
      b.onclick = () => selectTurn(t.index);
      bars.append(b);
    }
    box.append(bars);

    // legend + Whole session button
    const mk = (color: string, txt: string) => {
      const g = E('div', 'lg');
      const sw = E('span', 'sw');
      sw.style.background = color;
      g.append(sw, document.createTextNode(txt));
      return g;
    };
    const lg = E('div', 'slegend');
    // State colours only — the verdict is a lens (the Verdict chip), not a permanent overlay.
    lg.append(
      mk('var(--cache)', 'context added'),
      mk('var(--good)', 'live (burning tokens)'),
      mk('var(--crit)', 'interrupted (Esc)'),
      mk('var(--create)', 'context event (/clear, /compact)'),
      mk('var(--lo)', 'local command (no tokens)'),
    );
    const clr = E('button', 'xbtn', 'Whole session');
    clr.style.marginLeft = 'auto';
    clr.onclick = () => clearScope();
    lg.append(clr);
    box.append(lg);

    if (wasteLens) {
      // The chip counts the FLAGGED turns, the list holds every work turn — a jump ("Verdict 3"
      // over 8 rows) that nothing on screen explained, so the clean rows read as a broken filter.
      const workCount = s.turnList.filter((t) => t.kind === 'work').length;
      const cnt = E(
        'div',
        'wdesc wcount',
        'Every work turn, judged: ' + wasteCount + ' flagged · ' + (workCount - wasteCount) + ' clean.',
      );
      box.append(cnt);

      // The Verdict lens payload: one expandable row per WORK turn — its worst finding (or the
      // practice it followed) as the headline, the full findings (what + cost) and the positives
      // on expand. This IS the verdict surface. Local commands (/model) and context commands
      // (/clear) are skipped: they run no model, so there is no turn to judge.
      const wl = E('div', 'wlist');
      for (const t of s.turnList) {
        if (t.kind !== 'work') continue;
        const v = verdicts.get(t.index)!;
        // The row of the turn you are scoped into is the OPEN one: the row IS the scope, so the
        // turn you read, the turn every widget shows and the turn Share sends are one turn.
        const row = E('div', 'wrow ' + v.severity + (t.index === selectedTurn ? ' open sel' : ''));
        const head = E('div', 'wrh');
        // A clean turn is not "clean": it is a turn that did something a documented practice
        // prescribes, or one with nothing to report. The word said neither.
        const lead = v.findings.find((f) => f.severity === 'crit') ?? v.findings[0] ?? null;
        const headText = verdictHeadline(v) || v.positives[0]?.text || 'nothing flagged';

        // Expanding must reveal something. The head already carries the lead finding (or the
        // first practice), so the body holds only what is left: the lead reappears solely to
        // state its cost, which the head has no room for.
        const body = E('div', 'wrb');
        for (const f of v.findings) {
          if (f === lead && !f.cost) continue;
          const fr = E('div', 'wfind');
          fr.append(E('span', 'wdot ' + f.severity), E('span', 'wwhat', f.text));
          if (f.cost) fr.append(E('span', 'wcost', f.cost));
          body.append(fr);
        }
        // The second face: what the turn did that a documented practice prescribes. Listed after
        // the findings so a flagged turn still leads with what went wrong. When there is no
        // finding the head is showing the first practice, so the body starts at the second.
        for (const p of lead ? v.positives : v.positives.slice(1)) {
          const pr = E('div', 'wfind good');
          pr.append(E('span', 'wtick', '✓'), E('span', 'wwhat', p.text));
          body.append(pr);
        }
        // No body, no chevron — but the row still scopes, so the empty column keeps its width
        // and the rows stay aligned.
        const hasBody = body.children.length > 0;
        head.append(
          E('span', 'wt', '#' + t.index),
          E('span', 'ws', headText),
          E('span', 'wc ' + v.severity, v.severity),
          shareButton(t, s, '⇪ Share'),
          E('span', 'wchev', hasBody ? '▸' : ''),
        );
        row.onclick = () => selectTurn(t.index);
        row.append(head);
        if (hasBody) row.append(body);
        wl.append(row);
      }
      if (!wl.children.length) wl.append(E('div', 'wdesc', 'No work turn in this session yet.'));
      box.append(wl);
    } else if (activeFilter !== 'all') {
      // The plain locate-a-turn list for the other filters (how you find a turn at 157).
      const fl = E('div', 'flist');
      for (const t of filteredTurns(s)) {
        const c = turnCls(t, working(t, s));
        const row = E('div', 'frow' + (t.index === selectedTurn ? ' sel' : ''));
        row.append(
          E('span', 'st' + (c ? ' ' + c : '')),
          E('span', 'id', '#' + t.index),
          E('span', 'pr', entryLabel(t, 160) || '(no text)'),
          E('span', 'dv', kd(t.deltaFill)),
        );
        row.onclick = () => selectTurn(t.index);
        fl.append(row);
      }
      box.append(fl);
    }

    turnExplorerDiv.append(box);
  }

  // Whether the one-line banner actually cuts the prompt is a LAYOUT fact, not a length
  // one (the ellipsis depends on the viewport), so it is measured, not guessed. A
  // ResizeObserver re-measures on resize AND when an inactive tab (display:none → zero
  // box) becomes visible again — a one-shot measurement would read 0 there and hide the
  // button forever on the tab you actually switch to.
  let promptRO: ResizeObserver | null = null;
  function watchPromptOverflow(promptEl: HTMLElement, btn: HTMLElement): void {
    stopWatchingPrompt();
    const sync = () => btn.classList.toggle('hidden', !(promptEl.scrollWidth > promptEl.clientWidth));
    sync();
    if (typeof ResizeObserver === 'function') {
      promptRO = new ResizeObserver(sync);
      promptRO.observe(promptEl);
    }
  }
  function stopWatchingPrompt(): void {
    if (promptRO) {
      promptRO.disconnect();
      promptRO = null;
    }
  }

  // Every effort the session's turns reported, in first-seen order. There is no session-level
  // effort in the data — it is written per call — so the session states what its calls carried.
  function sessionEfforts(s: TreeSnapshot): string[] {
    const out: string[] = [];
    for (const t of s.turnList) for (const e of t.efforts) if (!out.includes(e)) out.push(e);
    return out;
  }

  // The model (and effort, when the data has one) of whatever scope the banner is showing.
  // Measured on 2828 real turns: 99.7% carry exactly ONE model and 98% carry NO effort, so
  // the common case is a single chip and no effort chip at all — never a placeholder for
  // something the transcript does not contain.
  function appendModelChips(host: HTMLElement, models: string[], efforts: string[]): void {
    if (models.length) {
      // A scope that changed model shows the one in force NOW plus what it was, because
      // either half alone misleads: the last hides that it changed, and the first is the
      // stale-window bug itself. Order is first-seen, so the current model is last.
      const current = models[models.length - 1]!;
      const chip = E('span', 'sbmodel', modelLabel(current));
      if (models.length > 1) {
        chip.classList.add('mixed');
        chip.textContent = modelLabel(current) + ' · was ' + models.slice(0, -1).map(modelLabel).join(', ');
      }
      host.append(chip);
    }
    if (efforts.length) host.append(E('span', 'sbeffort', efforts.join(' · ')));
  }

  // The live counters the CURRENT render produced, each with the text it should show at a
  // given moment. Held as references rather than re-queried by selector: the renderer
  // already knows what it built, so the ticker needs no DOM query (and works under the
  // tests' fake DOM). `render` rather than a shared format because the two counters say
  // different things — one turn's elapsed, and the session's total working time.
  // Cleared at the top of every render — an element from the previous one is detached. The NOW
  // panel is the one exception: it re-renders ITSELF off the ticker (its narration-to-activity
  // handover is due at a moment no event announces), so its counters are tagged `owner: 'now'`
  // and it takes them back before pushing new ones. Without that, each tick left its previous
  // counters behind and the list grew by one or two entries per second between events — ~840 of
  // them across a 7-minute command, every one re-written on every tick.
  let liveCounters: Array<{ el: HTMLElement; render: () => string; owner?: 'now'; dead?: boolean }> = [];

  /** Drop the counters the NOW panel pushed on its last pass, so re-rendering it cannot pile up. */
  function dropNowCounters(): void {
    if (liveCounters.some((c) => c.owner === 'now')) {
      // `dead` first: the ticker is mid-iteration over the array this replaces, so filtering alone
      // still lets the old counter run — and it wrote the narration's age ("30s ago") over the
      // group's chip, where it then STAYED, because with no call open nothing writes that node again.
      for (const c of liveCounters) if (c.owner === 'now') c.dead = true;
      liveCounters = liveCounters.filter((c) => c.owner !== 'now');
    }
    nowTickArmed = false; // the tick entry is one of them: it must be re-armed, not assumed live
  }

  // Wall-clock elapsed for a turn that is STILL OPEN on a LIVE session. Both callers must
  // have already checked `!ended` — see the note at the turn-scope call site for why that
  // guard is not optional. A turn whose start time is unreadable keeps the old static
  // badge: a counter has to count from somewhere, and guessing "now" would read as 0s.
  function liveElapsed(turn: TurnNode): HTMLElement {
    const el = E('span', 'sblive');
    const since = turn.startedAt ? Date.parse(turn.startedAt) : NaN;
    if (Number.isNaN(since)) {
      el.textContent = '● running turn';
      return el;
    }
    const render = () => '● ' + formatDuration(Math.max(0, Date.now() - since)) + ' turn';
    el.textContent = render();
    liveCounters.push({ el, render });
    return el;
  }

  // How long the session has WORKED — the sum of its turns' own durations, so the total is
  // exactly the sum of the numbers each turn shows. An open turn has no duration yet, so
  // its live elapsed is added on top: without that the total would sit frozen for the whole
  // length of a turn and then jump. It only counts live under the same guard as the turn
  // counter — a live session with an open turn; otherwise it is the plain static sum.
  function sessionWorked(s: TreeSnapshot): HTMLElement {
    const el = E('span', 'sbstats');
    const base = workingMs(s);
    const open = ended ? undefined : s.turnList.find((t) => t.state === 'live');
    const since = open?.startedAt ? Date.parse(open.startedAt) : NaN;
    const render = () => formatDuration(base + (Number.isNaN(since) ? 0 : Math.max(0, Date.now() - since))) + ' total';
    el.textContent = render();
    if (!Number.isNaN(since)) liveCounters.push({ el, render });
    return el;
  }

  // One interval for the whole graph, not one per element. It exists only while a live
  // counter does, so an ended session or a replay never leaves a timer running — the
  // failure the wall-clock ban was written against (a dead session ticking for days).
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  function syncTicker(): void {
    if (!liveCounters.length) {
      stopTicker();
      return;
    }
    if (tickTimer !== null) return;
    tickTimer = setInterval(() => {
      if (!liveCounters.length) {
        stopTicker();
        return;
      }
      for (const c of liveCounters) {
        if (c.dead) continue;
        c.el.textContent = c.render();
      }
    }, 1000);
  }
  function stopTicker(): void {
    if (tickTimer !== null) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  }

  /**
   * The chip that says the session is still waiting on something it launched. On the banner, in
   * BOTH scopes, because that is the one line always on screen: put anywhere else it is gone the
   * moment a new prompt arrives and the turn takes the surfaces back — which is the case that
   * decided the placement.
   *
   * Ticks: the age is computed here from the launch instant, never stored, so it cannot go stale.
   */
  function backgroundChip(fullSnap: TreeSnapshot): HTMLElement | null {
    const running = runningBackground(fullSnap.mainTools);
    if (!running.length || ended) return null;
    const chip = E('span', 'sbbg');
    const oldest = Date.parse(running[0]!.since);
    const label = running.length === 1 ? '1 background command' : running.length + ' background commands';
    // formatDuration, not fmtAge: 'ago' is for something that HAPPENED, and this one is still
    // going — the live check read '1 background command · 1m ago', which says it ended.
    const renderAge = () =>
      label + (Number.isNaN(oldest) ? '' : ' · ' + formatDuration(Math.max(0, Date.now() - oldest)));
    chip.textContent = renderAge();
    // The oldest one's age, like the NOW panel's chip: with several running, a single number can
    // only honestly be "the longest anything has been going".
    // NO owner — like liveElapsed and sessionWorked, this node is rebuilt by the main render and
    // must survive dropNowCounters(), which runs AFTER this and takes back everything tagged 'now'.
    // Tagged 'now' (the first attempt) it was pushed and killed inside the same render, so the age
    // froze at whatever that render computed: invisible on a busy session, where every event
    // re-renders it, and permanent in the case this exists for — turn over, command still running,
    // nothing else happening.
    liveCounters.push({ el: chip, render: renderAge });
    chip.title = running.map((c) => c.command).join('\n');
    return chip;
  }

  function renderScopeBanner(fullSnap: TreeSnapshot): void {
    scopeBanner.replaceChildren();
    stopWatchingPrompt(); // the observed prompt node is gone on every re-render
    const bg = backgroundChip(fullSnap);
    if (selectedTurn === null) {
      scopeBanner.classList.add('on');
      scopeBanner.classList.remove('int');
      scopeBanner.append(E('span', 'sbprompt', 'Whole session'));
      if (bg) scopeBanner.append(bg);
      appendModelChips(scopeBanner, fullSnap.main.models, sessionEfforts(fullSnap));
      const cs = turnCostStats(fullSnap);
      if (cs.escCount > 0) scopeBanner.append(E('span', 'sbstats', cs.escCount + ' interrupted'));
      if (fullSnap.turns > 0) scopeBanner.append(E('span', 'sbnum', nTurns(fullSnap.turns)));
      // The live counter answers "how long has the current turn been running" — the only
      // live duration a whole-session scope has. Same guard as the turn scope below.
      const open = fullSnap.turnList.find((t) => working(t, fullSnap));
      if (open) scopeBanner.append(liveElapsed(open));
      // How long the whole session has worked. Not redundant with the counter beside it:
      // that one is THIS turn, this one is every turn summed. A session with no finished
      // turn yet has nothing to total.
      if (fullSnap.turnList.some((t) => t.durationMs !== null)) scopeBanner.append(sessionWorked(fullSnap));
      // The answer the session ended on. A scope selector promises that the same surface
      // answers the same questions at every scope: Result exists when a turn is selected, so
      // it exists when none is — reading it off the NOW panel instead is not the same thing,
      // and stops being possible the moment a new turn starts talking.
      //
      // NOT while a turn is running, though (same guard as the live counter above): the newest
      // answer then belongs to the PREVIOUS turn, and a `Result` offered under a whole-session
      // scope reads as what the session concluded — which is a claim nothing can make while the
      // session is mid-sentence. Naming the turn in the modal is not enough: the button is read
      // before the modal is opened.
      const finalTurn = open && !ended ? null : finalResultTurn(fullSnap);
      if (finalTurn) {
        const finBtn = E('button', 'sbout', 'Result');
        finBtn.onclick = (ev: MouseEvent) => {
          ev.stopPropagation();
          // finalTurn.result! proven by finalResultTurn, which returns a turn only when it has one.
          openOutput(entryTitle(fullSnap, finalTurn) + ' result', promptLine(finalTurn.prompt, 80), finalTurn.result!);
        };
        scopeBanner.append(finBtn);
      }
      // The whole banner is the timeline's click target — say so, or it reads as a
      // static label (the strip's other entry point is the Session card's Explore).
      if (fullSnap.turnList.length > 0)
        scopeBanner.append(E('span', 'sbhint', stripOpen ? 'Timeline ▴' : 'Timeline ▾'));
      return;
    }
    const turn = fullSnap.turnList.find((t) => t.index === selectedTurn);
    if (!turn) {
      scopeBanner.classList.remove('on', 'int');
      return;
    }

    scopeBanner.classList.add('on');
    scopeBanner.classList.toggle('int', turn.state === 'interrupted');

    // The index counts every entry you sent; the label must count only what it claims to.
    // "Turn 5 / 3" is what you get from mixing the two.
    if (turn.kind === 'work') {
      scopeBanner.append(E('span', 'sbnum', 'Turn ' + workOrdinal(fullSnap, turn) + ' / ' + fullSnap.turns));
    } else {
      scopeBanner.append(E('span', 'sbnum', turn.kind === 'context' ? 'Context event' : 'Local command'));
    }
    // A command outlives the turn that launched it, so the chip belongs to the SESSION and is drawn
    // in this scope too — a user reading turn 12 while something started in turn 9 still runs is
    // exactly who needs telling.
    if (bg) scopeBanner.append(bg);
    // The banner holds ONE line; the turn carries the whole prompt. Show the derived line,
    // keep the original for the Input modal. `line` (not the displayed label) is what the
    // Input button's check compares against — the "/model" prefix is decoration this view
    // added, not something missing from what you can read.
    const line = promptLine(turn.prompt);
    const promptEl = E('span', 'sbprompt', entryLabel(turn) || '(no text)');
    scopeBanner.append(promptEl);
    // "Whole session" is navigation (exit scope), so it lives next to what you're scoped into,
    // not at the far trailing edge where it reads as a final action.
    const wsBtn = E('button', 'xbtn', 'Whole session');
    wsBtn.onclick = (ev: MouseEvent) => {
      ev.stopPropagation();
      clearScope();
    };
    scopeBanner.append(wsBtn);
    appendModelChips(scopeBanner, turn.models, turn.efforts);

    const statParts = [];
    if (turn.deltaFill !== 0) statParts.push((turn.deltaFill >= 0 ? '+' : '') + kc(turn.deltaFill) + ' ctx');
    if (turn.durationMs !== null) statParts.push(formatDuration(turn.durationMs));
    if (turn.apiCalls > 0) statParts.push(turn.apiCalls + ' API');
    if (statParts.length) scopeBanner.append(E('span', 'sbstats', statParts.join(' · ')));

    // The verdict of the turn you are scoped into. Before this, a flagged turn said nothing here
    // and its findings were reachable only by discovering the Timeline's Verdict chip — the verdict
    // existed but nobody could find it. The chip is the entry point: it states the severity and
    // the worst finding, and opens the Verdict lens on THIS turn (the one findings surface).
    const v = verdicts.get(turn.index);
    if (v && v.severity !== 'good') {
      const chip = E('button', 'sbverdict ' + v.severity);
      chip.append(E('span', 'wdot ' + v.severity), document.createTextNode(verdictHeadline(v)));
      chip.title = v.findings.map((f) => f.text + (f.cost ? ' · ' + f.cost : '')).join('\n');
      chip.onclick = (ev: MouseEvent) => {
        ev.stopPropagation();
        stripOpen = true;
        activeFilter = 'waste';
        render();
      };
      scopeBanner.append(chip);
    }

    // A session killed mid-turn leaves that turn's state 'live' forever (no turn_duration
    // line ever lands) — on an ended session a running counter would tick upward forever
    // on a dead session, which is exactly what the wall-clock ban (see subActiveRow) exists
    // to prevent. Live session + open turn is the only case where it may run.
    if (turn.state === 'live' && !ended) scopeBanner.append(liveElapsed(turn));

    // Input: the prompt in full. Two different things can hide text from you, and both must
    // reveal the button: the DATA (a multi-line prompt collapsed to one line, or one longer
    // than promptLine's cap) and the LAYOUT (the line itself ellipsized by CSS at this
    // viewport). The first is known here; the second is measured (see watchPromptOverflow).
    if (turn.prompt) {
      // "What you see is not what you typed" — the line differs from the prompt whenever it
      // was cut OR its newlines were collapsed. Both are content you can't read from here.
      const shortened = line !== turn.prompt.trim();
      const inBtn = E('button', 'sbout' + (shortened ? '' : ' hidden'), 'Prompt');
      inBtn.onclick = (ev: MouseEvent) => {
        ev.stopPropagation();
        openOutput(entryTitle(fullSnap, turn) + ' prompt', turn.apiCalls + ' API calls', turn.prompt);
      };
      scopeBanner.append(inBtn);
      if (!shortened) watchPromptOverflow(promptEl, inBtn);
    }

    if (turn.result) {
      const outBtn = E('button', 'sbout', 'Result');
      // turn.result! proven by the `if (turn.result)` guard enclosing this block;
      // TS cannot narrow a property access through a closure, but the snapshot is immutable.
      outBtn.onclick = (ev: MouseEvent) => {
        ev.stopPropagation();
        openOutput(entryTitle(fullSnap, turn) + ' result', promptLine(turn.prompt, 80), turn.result!);
      };
      scopeBanner.append(outBtn);
    }

    if (turn.kind === 'work') scopeBanner.append(shareButton(turn, fullSnap, '⇪ Share'));
  }

  /**
   * A ⇪ Share button BOUND to one turn: it builds the card for `turn`, never for whatever the
   * view is scoped into. Both surfaces that offer Share (each verdict row, and the scope banner)
   * use this, so the turn you are reading is always the turn the card describes.
   */
  function shareButton(turn: TurnNode, fullSnap: TreeSnapshot, label: string): HTMLElement {
    const shareBtn = E('button', 'sbout sbout-share', label);
    shareBtn.onclick = async (ev: MouseEvent) => {
      // Without this the click also reaches the row (which scopes) or the banner (which
      // toggles the strip) — sharing must not navigate.
      ev.stopPropagation();
      shareBtn.textContent = '…';
      shareBtn.disabled = true;
      try {
        // The shared map already holds this turn's verdict; recomputing it here could only
        // produce a card that disagrees with the screen.
        const v = verdicts.get(turn.index) ?? computeVerdict(turn, fullSnap);
        const b = bucketFor(sharedBaseline, turn.efforts.at(-1) ?? 'unknown');
        const billable = turnBillable(turn);
        const effort = turn.efforts.at(-1) ?? null;
        const payload: import('../core/share-card.ts').ShareCardData = {
          turnIndex: turn.index,
          turnOrdinal: workOrdinal(fullSnap, turn),
          totalTurns: fullSnap.turns,
          durationMs: turn.durationMs,
          date: new Date().toISOString().slice(0, 10),
          severity: v.severity,
          mult: b && b.p50 > 0 ? (billable / b.p50).toFixed(1) : null,
          billable,
          p50: b?.p50 ?? null,
          p90: b?.p90 ?? null,
          p95: b?.p95 ?? null,
          findings: v.findings,
          // What the turn DID. A verdict with no activity behind it is unreadable to anyone
          // who was not in the session — and none of these can identify the project.
          stats: {
            apiCalls: turn.apiCalls,
            toolCalls: fullSnap.mainTools.filter((t) => t.turnIndex === turn.index).length,
            subagents: turn.agentIds.length,
            cacheRead: turn.cacheTotals.read,
            model: turn.models.at(-1) ?? null,
            effort,
          },
        };
        // The button is disabled for the length of this call, so a render that never settles locks
        // it for good. On a LIVE session the next event re-renders the banner and the button is a
        // fresh node; on an ENDED one nothing re-renders and only a reload frees it. Nothing here
        // touches the network any more — the deadline guards `img.onload`, which is a browser
        // callback that simply never fires when the SVG will not parse.
        const blob = await withDeadline(() => renderShareCardPng(payload), SHARE_CARD_TIMEOUT_MS);
        const url = URL.createObjectURL(blob);
        openSharePreview(url, `seedeep-turn-${turn.index}.png`);
        shareBtn.textContent = label;
        shareBtn.disabled = false;
      } catch {
        shareBtn.textContent = '✗ error';
        setTimeout(() => {
          shareBtn.textContent = label;
          shareBtn.disabled = false;
        }, 2000);
      }
    };
    return shareBtn;
  }

  function renderCommands(s: TreeSnapshot): void {
    commandsCard.replaceChildren();
    commandsCard.append(E('div', 'wtitle', 'Commands'), E('div', 'wdesc', 'Slash commands you typed.'));
    const chips = E('div', 'toolchips');
    chips.style.marginTop = '.2rem';
    const cmds = s.commands || [];
    if (cmds.length) {
      for (const c of cmds) {
        const chip = E('span', 'tchip clk');
        chip.append(document.createTextNode('/' + c.name + ' '), E('b', null, '×' + c.count));
        chip.onclick = () => openCommand(c);
        chips.append(chip);
      }
    } else {
      chips.append(E('span', 'wdesc', 'none yet'));
    }
    commandsCard.append(chips);
  }

  function renderSkills(s: TreeSnapshot): void {
    skillsCard.replaceChildren();
    skillsCard.append(E('div', 'wtitle', 'Skills used'), E('div', 'wdesc', 'Skills that drove the session.'));
    // We do NOT fall back to `main.regions`: that Set mixes skills with
    // mcpServer/mcpTool attributions (the parser adds all three), so rendering it
    // here would show MCP names ("get_issue", "linear") in a skills-only widget.
    const skills = s.skills; // undefined until the reducer has folded attribution/Skill events
    const chips = E('div', 'toolchips');
    chips.style.marginTop = '.2rem';
    if (Array.isArray(skills) && skills.length) {
      for (const sk of skills) {
        // Just the name — no count. Neither metric is intuitive as a bare number
        // (Skill tool_use misses user /commands; attribution turns are huge for a
        // long-lived skill); the drawer explains both. User /commands live in the
        // Commands widget instead.
        const c = E('span', 'tchip clk', sk.name.split(':').pop());
        c.onclick = () => openSkill(sk, skills);
        chips.append(c);
      }
    } else {
      chips.append(E('span', 'wdesc', 'no skills yet'));
    }
    skillsCard.append(chips);
  }

  // Shorten a model id to its family for the dense rows (claude-haiku-4-5-… → "haiku").
  // Product call (2026-07-16): fable ids stay VERBATIM here — the graph rows keep the
  // full id while the dropdown shows the capitalized family for every model.
  // One emphasized row for a RUNNING subagent — the live signal: context filling now,
  // elapsed, and current action. LIMIT: a background (async) subagent writes no per-call
  // usage while it runs, so its fill / tool list can be last-known rather than live.
  /**
   * Set --subrow-h on the live list to the tallest row's REAL height, so the panel's
   * `calc(3 * --subrow-h + ...)` covers exactly three rows in this browser. No-op where
   * layout is unavailable (the tests' fake DOM), which just leaves the css fallback.
   */
  function measureRowHeight(host: HTMLElement): void {
    const rows = host.children;
    if (!rows || !rows.length || typeof host.getBoundingClientRect !== 'function') return;
    let tallest = 0;
    for (const r of rows) {
      const h = typeof r.getBoundingClientRect === 'function' ? r.getBoundingClientRect().height : 0;
      if (h > tallest) tallest = h;
    }
    if (tallest > 0) host.style.setProperty('--subrow-h', Math.ceil(tallest) + 'px');
  }

  function subActiveRow(a: AgentNode): HTMLElement {
    const r = E('div', 'subrow act');
    r.onclick = () => openSub(a);
    const l1 = E('div', 'sl1');
    l1.append(E('span', 'sdot'), E('b', null, a.title));
    if (a.model) l1.append(E('span', 'schip', shortModel(a.model)));
    // Elapsed comes from the data (durationMs), never wall-clock: a running subagent has
    // durationMs=null → formatDuration renders "running…". Deriving it from Date.now() made a
    // stale 'running' subagent (a session interrupted mid-run) tick upward for days on replay.
    l1.append(E('span', 'sel', formatDuration(a.durationMs)));
    r.append(l1);
    // The type sits under the intent. Its line is ALWAYS rendered, even before the child's
    // sidecar names the type: reserving the space keeps the row from growing a few hundred
    // ms after it appears, which reads as the panel twitching.
    const type = E('div', 'stype');
    type.textContent = a.agentType && a.agentType !== a.title ? a.agentType : ' ';
    r.append(type);
    const l2 = E('div', 'sl2');
    const frac = contextFraction(a);
    const bar = E('div', 'scbar');
    const i = E('i');
    i.style.width = Math.max(2, Math.min(100, frac * 100)) + '%';
    bar.append(i);
    l2.append(
      E('span', 'sclbl', 'context'),
      bar,
      E('span', 'scnum', k(a.fill) + ' / ' + kc(a.window) + ' · ' + Math.round(frac * 100) + '%'),
    );
    const last = a.tools[a.tools.length - 1];
    const act = E('span', 'sact');
    act.textContent = last ? '→ ' + last.name + (last.arg ? ' ' + String(last.arg).slice(0, 36) : '') : '→ starting…';
    l2.append(act);
    r.append(l2);
    return r;
  }

  // The live counterpart of workflowCard: what a RUNNING fleet looks like. Its progress is
  // "how many of my subagents are still working" (from the run's journal), which is the one
  // number that actually moves while a run is alive.
  function wfActiveRow(a: AgentNode): HTMLElement {
    const w = a.workflow;
    const r = E('div', 'subrow act wfrow');
    r.onclick = () => subsCard.scrollIntoView({ behavior: 'smooth' });
    const l1 = E('div', 'sl1');
    l1.append(E('span', 'sdot'), E('b', null, w?.name || 'workflow'), E('span', 'schip', 'workflow run'));
    l1.append(E('span', 'sel', formatDuration(a.durationMs)));
    const l2 = E('div', 'sl2');
    if (w) {
      // Bar = the share of the fleet still working, so it drains as the run finishes.
      const frac = w.agents > 0 ? w.running / w.agents : 0;
      const bar = E('div', 'scbar');
      const i = E('i');
      i.style.width = Math.max(2, Math.min(100, frac * 100)) + '%';
      bar.append(i);
      l2.append(E('span', 'sclbl', 'subagents'), bar, E('span', 'scnum', `${w.running} of ${w.agents} running`));
      l2.append(E('span', 'sact', '→ ' + k(w.volume) + ' tokens'));
    }
    r.append(l1, l2);
    return r;
  }

  // Ended-session row: a finished subagent as a compact one line — the ended counterpart of
  // subActiveRow. No live context bar or current action (the run is over); the drawer holds the
  // full detail.
  function subFinishedRow(a: AgentNode): HTMLElement {
    const r = E('div', 'subrow done');
    r.onclick = () => openSub(a);
    r.append(E('span', 'sdot'));
    const mid = E('div', 'smid');
    mid.append(E('b', null, a.title));
    if (a.model) mid.append(E('span', 'schip', shortModel(a.model)));
    r.append(mid);
    // durationMs is null for a finished subagent whose timing never resolved (no child jsonl);
    // formatDuration(null) is "running…" — a lie on an ended session, so show a dash instead.
    r.append(E('span', 'sdur', a.durationMs != null ? formatDuration(a.durationMs) : '—'));
    return r;
  }

  // A finished workflow run in the ended list: named by the run, not a context bar it never had.
  function subFinishedWfRow(a: AgentNode): HTMLElement {
    const r = E('div', 'subrow done');
    r.onclick = () => subsCard.scrollIntoView({ behavior: 'smooth' });
    r.append(E('span', 'sdot'));
    const mid = E('div', 'smid');
    mid.append(E('b', null, a.workflow?.name || 'workflow'), E('span', 'schip', 'workflow'));
    r.append(mid);
    r.append(E('span', 'sdur', a.durationMs != null ? formatDuration(a.durationMs) : '—'));
    return r;
  }

  // Live subagent monitor — ONLY the running subagents, each with its context filling now and
  // current action. Finished subagents are not repeated here: the complete catalog is at the
  // bottom of the page (subsCard). When nothing is running (the common case), a centred
  // placeholder fills the card so it never reads as broken, and points to the catalog below.
  // On an ENDED session the monitor can never show a running subagent again, so instead it fills
  // the left column with the COMPLETE list of subagents that ran, scrolling inside the fixed
  // cockpit height — the ended counterpart of the monitor, which keeps the columns symmetric.
  function renderSubLive(s: TreeSnapshot, full: TreeSnapshot): void {
    subLiveCard.replaceChildren();
    // Reset the card's own classes/handler each render: the live and ended branches decorate it
    // differently, and a live→ended transition (setEnded) must not leave a stale class behind.
    subLiveCard.className = 'card sublivecard';
    subLiveCard.onclick = null;
    // The card is rebuilt on EVERY render (~every event), so the list the user scrolled is
    // thrown away and the new one starts at 0: measured live, a scroll to 78px snapped back
    // within ~1s, which made the list feel unscrollable and the "N more running" footer
    // pointless. The offset is carried across rebuilds instead.
    const subs = s.subagents || [];
    if (ended) {
      // Session-wide claim → reads the FULL snapshot (a scoped list would make "none ran this
      // session" a lie on a quiet turn). The card fills the column and its list scrolls.
      const all = full.subagents || [];
      subLiveCard.classList.add('fulllist');
      const slHead = E('div', 'slhead');
      const slTitleWrap = E('div');
      slTitleWrap.append(
        E('div', 'wtitle', 'Subagents'),
        E('div', 'wdesc slcount', (all.length ? all.length + ' ran' : 'none ran') + ' this session'),
      );
      slHead.append(slTitleWrap);
      subLiveCard.append(slHead);
      if (!all.length) {
        // Same centred placeholder as the live empty state, so the card still fills the column.
        const empty = E('div', 'slempty');
        empty.append(E('div', 'slempty-t', 'No subagents ran'), E('div', 'slempty-s', 'This session spawned none'));
        subLiveCard.append(empty);
        return;
      }
      const host = E('div', 'sublist');
      for (const a of subagentsChronological(all)) {
        host.append(a.kind === 'workflow' ? subFinishedWfRow(a) : subFinishedRow(a));
      }
      subLiveCard.append(host);
      return;
    }
    // displayState, NOT the raw state: a run that has gone silent is `unknown`, and the monitor
    // of what is WORKING must not keep counting it. Filtering on the raw state left a dead run
    // listed here with an `unknown` badge while the header called it running — the same screen
    // asserting both.
    const active = subs.filter((a) => displayState(a, ended) === 'running');
    const finished = subs.length - active.length;
    // displayState reads the clock, and nothing else repaints on its own: without this the
    // threshold would only fire if some unrelated event happened to trigger a render, so a
    // killed run in an idle session stayed `running` forever. One shot at the exact deadline,
    // not a poll — and exactly ONE pending, re-armed per render (this runs on every paint, so
    // scheduling without cancelling would pile up a 5-minute timer per render on a busy
    // session). `later` registers it for destroy(), so it cannot outlive the tab.
    if (wfStaleTimer !== null) {
      clearTimeout(wfStaleTimer);
      timers.delete(wfStaleTimer);
      wfStaleTimer = null;
    }
    if (!ended) {
      const deadlines = subs
        .filter((a) => a.kind === 'workflow' && a.state === 'running' && a.workflow?.lastActivityAt)
        // workflow and lastActivityAt proven non-null by the filter above (optional chaining there handles null, truthy handles 0/null).
        .map((a) => a.workflow!.lastActivityAt! + WF_SILENT_MS - Date.now())
        .filter((ms) => ms > 0);
      if (deadlines.length) {
        wfStaleTimer = later(
          () => {
            wfStaleTimer = null;
            scheduleRender();
          },
          Math.min(...deadlines) + 1000,
        );
      }
    }
    // Background commands are session-wide, like the subagent list on an ended session: one
    // launched in turn 9 is still running while you read turn 12, so scoping them to the turn in
    // view would hide exactly the case this card exists to show.
    const commands = ended ? [] : runningBackground(full.mainTools);
    const slHead = E('div', 'slhead');
    const slTitleWrap = E('div');
    // The card holds whatever is RUNNING, so it is named for that the moment it holds more than
    // subagents — a card called "Subagents" listing a shell command is a word that lies.
    const counted = [
      active.length + (active.length === 1 ? ' subagent' : ' subagents'),
      commands.length ? commands.length + (commands.length === 1 ? ' command' : ' commands') : '',
      finished ? finished + ' finished below' : '',
    ].filter(Boolean);
    slTitleWrap.append(
      E('div', 'wtitle', commands.length ? 'Running · live' : 'Subagents · live'),
      E(
        'div',
        'wdesc slcount',
        commands.length
          ? counted.join(' · ')
          : active.length + ' running' + (finished ? ' · ' + finished + ' finished below' : ''),
      ),
    );
    slHead.append(slTitleWrap);
    const subLiveHost = E('div', 'sublist');
    if (typeof subLiveHost.addEventListener === 'function') {
      subLiveHost.addEventListener('scroll', () => {
        liveScrollTop = subLiveHost.scrollTop;
      });
    }
    subLiveCard.append(slHead, subLiveHost);
    // Commands first: a subagent reports its own progress (context, current call), a command
    // reports nothing at all until it ends, so it is the one the reader can learn least about
    // anywhere else.
    for (const c of commands) subLiveHost.append(bgActiveRow(c));
    if (commands.length) {
      measureRowHeight(subLiveHost);
      if (liveScrollTop > 0) subLiveHost.scrollTop = liveScrollTop;
    }
    if (active.length) {
      // A workflow run must NOT go through subActiveRow: it has no context window and no
      // single current action, so that row rendered a raw tool_use id, a meaningless
      // "0 / 200k · 0%" bar and a frozen "→ starting…". A fleet is watched by how much of it
      // is still working, not by a context bar it does not have.
      for (const a of active) subLiveHost.append(a.kind === 'workflow' ? wfActiveRow(a) : subActiveRow(a));
      // Size the panel from the row as THIS browser rendered it, never from a constant. The
      // fallback 73px in the css is what one machine measured (72.703125px); a font or
      // rendering that puts the row a pixel higher overflows the panel by a pixel or two —
      // enough to raise a scrollbar with nothing to scroll, which is what Davide saw with
      // three subagents. Ceil, so the rows are always covered, never a fraction short.
      measureRowHeight(subLiveHost);
      // Restore where the user was. Assigning past the end is clamped by the browser, so a
      // list that shrank simply lands at its new bottom.
      if (liveScrollTop > 0) subLiveHost.scrollTop = liveScrollTop;
      return;
    }
    // With a command running the card is not empty, so the placeholder would be a card
    // contradicting its own contents.
    if (commands.length) return;
    const empty = E('div', 'slempty');
    empty.append(
      E('div', 'slempty-t', 'No subagents running'),
      E(
        'div',
        'slempty-s',
        finished
          ? finished + ' finished this session — see the full list below'
          : 'Spawned subagents will appear here live',
      ),
    );
    subLiveHost.append(empty);
  }

  /**
   * A background command as a live row: what runs, for how long, and where it came from.
   *
   * Shaped like a subagent's live row so the card reads as one list, minus what a command does not
   * have — no model, no context bar, and no "current action": a background command reports nothing
   * at all between its launch and its notification. The age is the one thing that moves, and it is
   * computed from the launch instant on the shared ticker rather than stored.
   */
  function bgActiveRow(c: RunningCommand): HTMLElement {
    const r = E('div', 'subrow act');
    r.onclick = () => openBlock({ kind: 'tool', toolUseId: c.toolUseId });
    const l1 = E('div', 'sl1');
    l1.append(E('span', 'sdot'), E('b', null, c.command));
    l1.append(E('span', 'schip', 'background'));
    const since = Date.parse(c.since);
    const age = E('span', 'sel');
    if (!Number.isNaN(since)) {
      const renderAge = () => formatDuration(Math.max(0, Date.now() - since));
      age.textContent = renderAge();
      liveCounters.push({ el: age, render: renderAge }); // no owner — see backgroundChip
    }
    l1.append(age);
    r.append(l1);
    r.append(
      E('div', 'stype', (c.turnIndex !== null ? 'launched in turn ' + c.turnIndex + ' · ' : '') + 'still running'),
    );
    return r;
  }

  function renderTools(s: TreeSnapshot): void {
    toolsHost.replaceChildren();
    const ranked = contextHogs(s.mainTools); // by output size desc; zero-output tools excluded
    // A 4th hog row when subagents ran, for the same height-parity reason as Changed files:
    // the Session card's by-model bar makes every stats-strip card taller. 96% of subagent
    // sessions have a 4th output tool to show, so the extra row is real data, not padding.
    const hogCap = s.subagentsTotal > 0 ? 4 : 3;
    for (const hg of ranked.slice(0, hogCap)) {
      const r = E('div', 'hogrow');
      r.onclick = () => openTool(hg, 'main session');
      const hl = E('div', 'hl');
      hl.append(E('span', 'hn', hg.name), E('span', 'harg', hg.arg || '—'));
      r.append(hl, E('span', 'hv', kc(hg.ctx) + ' ch'));
      toolsHost.append(r);
    }
    const { count, breakdown } = summarizeTools(s.mainTools);
    const chips = E('div', 'toolchips');
    chips.append(E('span', 'tcount', count + ' tools'));
    const shown = toolChipsExpanded ? breakdown : breakdown.slice(0, 12);
    for (const b of shown) {
      const c = E('span', 'tchip clk');
      c.append(document.createTextNode(b.name + ' '), E('b', null, String(b.n)));
      c.onclick = () => openToolType(b.name, s);
      chips.append(c);
    }
    // the "+N" chip is clickable: it reveals the remaining tool-type chips inline.
    if (!toolChipsExpanded && breakdown.length > 12) {
      const more = E('span', 'tchip clk', '+' + (breakdown.length - 12));
      more.onclick = () => {
        toolChipsExpanded = true;
        renderTools(s);
      };
      chips.append(more);
    }
    toolsHost.append(chips);
  }

  // Tint a filename by its KIND (from the extension) — a category class the CSS maps to a palette
  // var. Grouped into a handful of kinds (code/doc/markup/data/style/shell) rather than
  // per-extension, so the set stays small and strictly on-palette; an unknown extension gets no
  // class and stays the default ink. Used by both the widget rows and the drawer rows.
  const FILE_TINT: Record<string, string> = {
    ts: 'ft-code',
    tsx: 'ft-code',
    js: 'ft-code',
    jsx: 'ft-code',
    mjs: 'ft-code',
    cjs: 'ft-code',
    md: 'ft-doc',
    mdx: 'ft-doc',
    txt: 'ft-doc',
    html: 'ft-markup',
    htm: 'ft-markup',
    xml: 'ft-markup',
    svg: 'ft-markup',
    json: 'ft-data',
    yaml: 'ft-data',
    yml: 'ft-data',
    toml: 'ft-data',
    css: 'ft-style',
    scss: 'ft-style',
    sass: 'ft-style',
    sh: 'ft-shell',
    bash: 'ft-shell',
    zsh: 'ft-shell',
  };
  // A leading dot is part of the NAME, not an extension (`.env` is not an "env file"), hence dot > 0.
  const extOf = (base: string): string => {
    const dot = base.lastIndexOf('.');
    return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  };
  const tintOf = (ext: string): string => FILE_TINT[ext] ?? '';
  /** Changed files grouped by extension, ranked by count desc (ties by extension) — widget + drawer. */
  const extCounts = (files: ReadonlyArray<{ base: string }>): Array<[string, number]> => {
    const by = new Map<string, number>();
    for (const f of files) {
      const e = extOf(f.base);
      by.set(e, (by.get(e) ?? 0) + 1);
    }
    return [...by].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  };

  // The "Changed files" widget: the total, then one chip per file EXTENSION with its count —
  // the same shape as Main tools' type chips, so the two neighbours read as one system. A raw
  // list was tried and dropped: at session scope it truncated in 70% of real sessions (median 15
  // files changed), so five rows were a 33% sample answering nothing. The complete list lives in
  // the drawer. No chip cap: real sessions carry a median of 4 distinct extensions, max 8.
  function renderFiles(s: TreeSnapshot): void {
    filesHost.replaceChildren();
    maybeRefreshFiles();
    const all = filesInScope();
    const scratch = scratchInScope();
    filesDesc.textContent = filesDescText(all);
    if (!all.length) {
      appendScratchRow(scratch.length);
      return;
    }
    const num = E('div', 'num');
    num.append(document.createTextNode(String(all.length)), E('small', null, all.length === 1 ? 'file' : 'files'));
    filesHost.append(num);
    // A bar per extension, scaled to the LARGEST one (not to the total): the story the data tells
    // is "one kind dominates" — measured, the top kind is a median 72% of a session's files — and
    // a max-scaled bar shows that ratio at a glance where a bare number makes you compute it.
    // Only the top TYPES_CAP kinds get a bar. Measured: 73% of real sessions have ≤4 distinct
    // extensions (so the cap is invisible), and where it does bite the top 4 still cover a median
    // 100% of the files (min 86%). The remainder row below is NOT optional decoration: without it
    // the bars would silently stop summing to the hero total.
    // One extra bar when the session ran subagents: the Session card grows a by-model bar then,
    // and align-items:stretch hands this card the same extra height — a 5th type fills it with
    // real data instead of blank space (43% of subagent sessions have a 5th type to show; the
    // rest just render fewer, unchanged). See renderTokenUsage's appendSubagentModels.
    const TYPES_CAP = s.subagentsTotal > 0 ? 5 : 4;
    const ranked = extCounts(all);
    const max = ranked[0]?.[1] ?? 1;
    const bars = E('div', 'fchgbars');
    for (const [ext, n] of ranked.slice(0, TYPES_CAP)) {
      const t = tintOf(ext);
      const row = E('div', 'fchgbar');
      const track = E('div', 'fchgbt');
      const fill = E('i', t);
      fill.style.width = Math.max(6, (n / max) * 100) + '%'; // floor so a count of 1 stays visible
      track.append(fill);
      row.append(E('div', t ? 'fchgbn ' + t : 'fchgbn', ext || '—'), track, E('div', 'fchgbv', String(n)));
      bars.append(row);
    }
    filesHost.append(bars);
    if (ranked.length > TYPES_CAP) {
      const rest = ranked.length - TYPES_CAP;
      const more = E('div', 'fchgmore', `+${rest} more type${rest === 1 ? '' : 's'} — Expand all`);
      more.onclick = () => openAllFiles();
      filesHost.append(more);
    }
    appendScratchRow(scratch.length);
  }

  /**
   * The repo files in the current scope, from git via the server; empty until it answers.
   *
   * The ledger reducer is NOT a fallback here. It counts what Claude Code's own tools wrote, which
   * on a real commit was 8 files of 16 — showing it while waiting would put a number on screen
   * that the next render contradicts, and a card whose count moves for no visible reason is the
   * defect this rework exists to remove.
   */
  function filesInScope(): DisplayFile[] {
    if (!filesData) return [];
    return inScope(displayFiles(filesData.files, filesData.roots));
  }

  /** Scratchpad files in scope — the ledger's one exclusive, since git cannot see outside the repo. */
  function scratchInScope(): DisplayFile[] {
    if (!filesData) return [];
    return inScope(displayFiles(filesData.scratch, filesData.roots, true));
  }

  /** Narrow a file list to the selected turn by the instant it was delivered. */
  function inScope(rows: DisplayFile[]): DisplayFile[] {
    if (selectedTurn === null) return rows;
    const range = turnRangeMs(selectedTurn);
    if (!range) return [];
    return rows.filter((f) => f.at >= range[0] && f.at < range[1]);
  }

  /** [start, end) of a turn in epoch ms; the last turn runs to now. Null without a start. */
  function turnRangeMs(index: number): [number, number] | null {
    const list = lastSnap?.turnList ?? [];
    const i = list.findIndex((t) => t.index === index);
    if (i < 0) return null;
    const from = Date.parse(list[i]?.startedAt ?? '');
    if (!Number.isFinite(from)) return null;
    const next = Date.parse(list[i + 1]?.startedAt ?? '');
    return [from, Number.isFinite(next) ? next : Number.POSITIVE_INFINITY];
  }

  // The scratchpad tally, under the bars: ONE row, not a second set of bars. The card is the
  // narrowest column of statsRow and its height is shared with its siblings, so bars here would
  // come out of the project ones — and the question it answers ("how much of this was throwaway?")
  // is a single number. Silent when the session wrote no temporaries.
  function appendScratchRow(n: number): void {
    if (!n) return;
    const row = E('div', 'fchgscr', `+${n} scratchpad file${n === 1 ? '' : 's'} — Expand all`);
    row.onclick = () => openAllFiles();
    filesHost.append(row);
  }

  /**
   * The description, which doubles as the caption: WHICH set the number came from, so a reader can
   * reproduce it with `git show --stat`.
   *
   * It carries no second count on purpose. Two numbers on one card invite a subtraction, and the
   * first time they fail to add up the card reads as broken — which is exactly what "10 files
   * changed, 16 in the commit" did.
   *
   * At session scope the commit count is the server's; with a turn selected it is the distinct
   * commits among the rows on screen, counted by HASH — deriving it from timestamps would merge
   * two commits made in the same second, since git's author dates are whole seconds.
   */
  function filesDescText(rows: readonly DisplayFile[]): string {
    if (!filesData) return 'Reading the repository…';
    const o = filesData.origin;
    if (o.kind === 'no-repo') return 'This session is not inside a git repository.';
    if (o.kind === 'unknown') return 'The repository could not be read.';
    const commits = o.kind === 'commits' && selectedTurn === null ? o.commits : new Set(rows.map((f) => f.commit)).size;
    if (!commits) return `Nothing committed in ${selectedTurn === null ? 'this session' : 'this turn'}.`;
    return `Files in ${commits} commit${commits === 1 ? '' : 's'}.`;
  }

  // Compact "12s ago" / "3m ago" age for the intent panel's chips.
  function fmtAge(ms: number): string {
    return ms < 60_000 ? Math.round(ms / 1000) + 's ago' : Math.round(ms / 60_000) + 'm ago';
  }

  // Toggle the intent's `clamped` state (which reveals `more`) from the settled layout, once per
  // render at most. Reads the live node — whichever text a render left in it — so it is correct
  // regardless of which render scheduled it.
  // How many feed rows to draw given the intent/output panel: none → the full ring, 11 if the
  // panel occupies one line, 10 if it wraps to two. Without the subheader the freed space fits
  // 11 rows in the single-line case; the two-line panel is taller so only 10 fit cleanly.
  function feedCapForPanel(): number {
    if (nowPanel.classList.contains('hidden')) return FEED_CAP;
    // No layout to read (a fake DOM under test) → leave the cap unchanged.
    if (typeof getComputedStyle !== 'function') return feedVisibleCap;
    const lh = parseFloat(getComputedStyle(nowText).lineHeight);
    return nowText.clientHeight <= lh + 4 ? 11 : 10;
  }
  let clampScheduled = false;
  function scheduleNowMeasure(): void {
    if (clampScheduled) return;
    clampScheduled = true;
    setTimeout(() => {
      clampScheduled = false;
      const overflowing = !nowPanel.classList.contains('hidden') && nowText.scrollHeight > nowText.clientHeight + 1;
      nowTextWrap.classList.toggle('clamped', overflowing);
      // The row budget depends on the panel's line count, which only exists after layout — so it
      // is set here and the feed is redrawn when it changes (renderFeed is a no-op on the cap).
      const cap = feedCapForPanel();
      if (cap !== feedVisibleCap) {
        feedVisibleCap = cap;
        renderFeed();
      }
    }, 0);
  }

  // The tool the session is stopped on: the newest activity that started and never ended.
  // Claude Code writes the `tool_use` line BEFORE it raises the dialog (measured on a real
  // session), so the pending tool is already in the feed — the panel can name what it is
  // waiting to approve instead of just saying that it waits. Null when the feed has no
  // unfinished tool (a plan approval, or a prompt raised before its line landed).
  function pendingTool(): { name: string; arg: string | null } | null {
    const items = feed.items();
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]!;
      if (it.apiCall || it.sub || it.ms != null || !it.id) continue;
      return { name: it.name, arg: it.arg ?? null };
    }
    return null;
  }

  // The NOW panel when SEEDEEP is the one talking: the session blocked on the user, or a turn that
  // is working without a word of its own to quote (`working`). Same three nodes as the intent
  // (label / text / age), so the panel keeps ONE shape — what changes is what it is saying.
  // The words are `nowLine`'s, not this function's: the tray states the same block, and two
  // surfaces of one product describing the same event differently is how a user learns to
  // distrust both.
  function renderPlainPanel(state: NowState): void {
    dropNowCounters();
    nowPanel.classList.remove('hidden');
    // Only the block on the user wears the waiting treatment; `working` is an ordinary panel that
    // happens to be seedeep talking.
    nowPanel.classList.toggle('waiting', state.kind === 'waiting');
    nowLbl.textContent = state.label;
    // The quote marks the intent wears would be wrong here: this is seedeep speaking, not
    // the agent (see .nowtext.plain).
    nowText.classList.add('plain');
    nowText.textContent = state.text;
    nowMore.onclick = () => {};
    nowTextWrap.classList.remove('clamped');
    // How long it has been stopped, ticking. From Claude Code's own statusUpdatedAt, so it
    // counts from the prompt, not from the poll that first saw it (up to 3s later).
    nowAge.textContent = '';
    if (state.ageFrom !== null) {
      const renderAge = () => fmtAge(Math.max(0, Date.now() - state.ageFrom!));
      nowAge.textContent = renderAge();
      liveCounters.push({ el: nowAge, render: renderAge, owner: 'now' });
    }
    scheduleNowMeasure();
  }

  // How long the agent's own last word keeps the panel before the activity group takes over is
  // `narrationHoldMs` (src/core/activity-line.ts): the time it takes to READ that particular word,
  // not one number for every word. Counted from when the word became VISIBLE, not from its
  // timestamp: Claude Code stamps a text block with the moment it STARTED generating it but flushes
  // the line only once the block is written — measured 7-9s later. Counting from the stamp spent
  // most of the hold before the panel had anything to show: observed live, a narration held the
  // panel for 3s of its 12. `wordSeen` is that first sighting, per word.
  let wordSeen: { ts: string; at: number } | null = null;

  // The NOW panel while the agent is working without speaking: it counts, in one line, what the
  // turn has done since its last word. Same three nodes as the intent, and the same plain voice as
  // the waiting panel — seedeep is the one counting here, not the agent.
  function renderActivityPanel(state: NowState, g: ActivityGroup, isLive: boolean, turn: TurnNode | null): void {
    nowPanel.classList.remove('hidden');
    nowLbl.textContent = state.label;
    nowText.classList.add('plain');
    // The line is past tense only and does not move with the clock — what is running lives in the
    // age chip instead — so it needs no ticker entry of its own.
    const line = state.text;
    nowText.textContent = line;
    // The line names at most MAX_FAMILIES families, so it stays inside the two-line clamp in every
    // measured case. `more` still opens it in full: the deferred measure can add `clamped` after
    // this pass, and a button that shows must do something.
    nowMore.onclick = () => openOutput('Now', entryTitle(lastSnap, turn) || '', line);
    nowTextWrap.classList.remove('clamped');
    // The age times the CALL that is running, not the group: it answers "is something still going,
    // and for how long". It is therefore absent whenever nothing has been open for a full second
    // (measured: 78.6% of a group's life) — the panel then shows the count with no number. Same
    // unit as the feed rows below, so the two read as one card.
    // LIMIT: Claude Code writes a call's `tool_use` line ~3.6s AFTER the call starts (measured from
    // inside a running call), so a call shorter than roughly five seconds is never seen in flight
    // at all — the chip can only ever time the slow ones. Verified live: at t+18s of a 24s command
    // the chip read 17.8s, at t+24s it read 23.8s.
    const renderAge = () => {
      const since = runningSince(g.open, Date.now());
      return since === null ? '' : formatToolMs(Math.max(0, Date.now() - since));
    };
    nowAge.textContent = isLive ? renderAge() : '';
    // A call already open crosses the one-second mark at a moment no event announces, so the chip
    // has to appear on the ticker rather than on the next line of jsonl.
    if (isLive && g.open.length) liveCounters.push({ el: nowAge, render: renderAge, owner: 'now' });
    scheduleNowMeasure();
  }

  // The NOW panel (V1). Reads the turn in view — the selected turn when scoped, else the
  // live turn (or the last one) — and shows its latest narration as the current intent (or the
  // turn's final output once it lands) and a ticking age. Hidden when there is nothing to say:
  // a turn that has narrated nothing, has no output, and is not itself live. Owns every child of
  // nowPanel.
  function renderNowPanel(): void {
    dropNowCounters(); // this function is re-entered from the ticker, not only from render()
    // A pending prompt outranks the intent, and `nowLine` says so — but WHICH turn is on screen is
    // this panel's own business: a user who scoped the view to an older turn asked to look at that
    // turn, and the tab badge still says the session is blocked.
    const blocked = waiting && !ended && selectedTurn === null ? waiting : null;
    nowText.classList.remove('plain');
    const list = lastSnap?.turnList ?? [];
    const panelTurn =
      selectedTurn !== null
        ? (list.find((t) => t.index === selectedTurn) ?? null)
        : (list.find((t) => t.state === 'live') ?? list[list.length - 1] ?? null);
    const isLive = working(panelTurn);
    const group = panelTurn?.activity ?? null;
    const wordTs = panelTurn?.lastWordTs ?? null;
    const narr = panelTurn?.lastNarration ?? null;
    const result = panelTurn?.result ?? null;
    // First sighting of THIS word (the ticker re-enters this function, so only a change resets it).
    // The panel's own clock, not the line's: Claude Code stamps a text block with the moment it
    // STARTED generating it but flushes the line only once the block is written — measured 7-9s
    // later. Counting the hold from the stamp spent most of it before there was anything to show.
    if (wordTs !== null && wordSeen?.ts !== wordTs) wordSeen = { ts: wordTs, at: Date.now() };
    // Every rule about WHAT now says — the precedence, the hold, the labels — is `nowLine`'s, so
    // the tray states the same thing from the digest. What stays here is the DRAWING: which nodes,
    // which formatter, and which age ticks.
    const state = nowLine(
      {
        waiting: blocked,
        pendingTool: blocked ? pendingTool() : null,
        waitingSince,
        live: isLive,
        result,
        narration: narr,
        wordTs,
        wordSeenAt: wordSeen?.at ?? null,
        activity: group,
        // Same rule as the Subagents card, from the same function — see delegatedWork.
        delegated: panelTurn && lastSnap ? delegatedWork(panelTurn.index, lastSnap.subagents, ended) : null,
        returned: panelTurn && lastSnap ? returnedWork(panelTurn.index, lastSnap.subagents, ended) : null,
        apiCalls: panelTurn?.apiCalls ?? 0,
        startedAt: panelTurn?.startedAt ? tsMs(panelTurn.startedAt) : null,
      },
      Date.now(),
    );
    if (state?.kind === 'waiting') {
      renderPlainPanel(state);
      return;
    }
    nowPanel.classList.remove('waiting');
    if (state?.kind === 'activity') {
      renderActivityPanel(state, group!, isLive, panelTurn);
      return;
    }
    // A turn that is running but has neither spoken nor called a tool — its work is delegated to a
    // background agent, or the model is still composing its one and only answer. Measured over 3064
    // real turns: 12.3% never say anything but their final output, and the panel was blank for a
    // median 22.1s of each. seedeep's own voice, so the same node as the waiting line.
    if (state?.kind === 'working') {
      renderPlainPanel(state);
      return;
    }
    // While the word is still fresh AND work is already running, the switch is due at a moment no
    // event will announce — the shared ticker re-runs this pass so it happens on time.
    if (group && isLive && !nowTickArmed) {
      nowTickArmed = true;
      liveCounters.push({
        el: nowTick,
        render: () => {
          renderNowPanel();
          return '';
        },
        owner: 'now',
      });
    }
    // No intent and no output yet → the panel is absent (not a placeholder), so the feed reclaims
    // the full budget. The cap update must run on this path too, so it schedules before returning.
    if (state === null) {
      nowPanel.classList.add('hidden');
      scheduleNowMeasure();
      return;
    }
    nowPanel.classList.remove('hidden');
    const showingResult = state.kind === 'output';

    nowLbl.textContent = state.label;
    // Inline is a glance surface that renders text, so the markdown is stripped to plain — the
    // raw `**`/backticks would read as literal noise. The modal (via `more`) keeps `state.text`,
    // the untouched markdown, rendered.
    nowText.textContent = stripMarkdown(state.text);

    // Clamped to two lines: when the text overflows, `more` opens the full text (rendered) in the
    // output modal. Overflow can only be read once layout settles — measuring here, mid-render,
    // sees a stale width and misses it — so the measurement is deferred (setTimeout, not rAF: rAF
    // is paused in a backgrounded tab, where seedeep lives). A fake DOM reports 0/0, so `more`
    // simply never shows there.
    scheduleNowMeasure();
    nowMore.onclick = () =>
      openOutput(showingResult ? 'Output' : 'Intent', entryTitle(lastSnap, panelTurn) || '', state.text);

    // Age chip: meaningful only for the LIVE intent (a narration), never a final output — which is
    // what `ageFrom` already answers. Ticks via the shared liveCounters (render() clears them each
    // pass, syncTicker runs the single interval).
    nowAge.textContent = '';
    const since = state.ageFrom;
    if (since !== null) {
      const renderAge = () => fmtAge(Math.max(0, Date.now() - since));
      nowAge.textContent = renderAge();
      liveCounters.push({ el: nowAge, render: renderAge, owner: 'now' });
    }
  }

  // The activity ring (ordering/eviction live in lib/feed.js; this file only draws it).
  // It retains the last FEED_CAP activities PER TURN, so selecting any turn — not just the
  // last — scopes this widget to that turn's tools instead of leaving it session-wide.
  // The ring retains the MAX we might show (13); how many are actually DRAWN is `feedVisibleCap`,
  // which trades feed rows for the intent panel: 13 when the panel is absent, 11 one-line, 10 two-line.
  // Set from feedCapForPanel, which is why it is a `let` the deferred pass updates.
  const FEED_CAP = 13;
  let feedVisibleCap = FEED_CAP;
  const feed = createFeed(FEED_CAP);
  function renderFeed() {
    const turn = selectedTurn !== null && lastSnap ? lastSnap.turnList.find((t) => t.index === selectedTurn) : null;
    const scoped = selectedTurn !== null;
    // Named by the same helper as the banner: the feed cannot say "Turn 2" while the banner
    // says "/model" — they are looking at the same entry.
    liveTitle.textContent = scoped ? (entryTitle(lastSnap, turn) || 'Entry') + ' activity' : 'Live activity';
    // The badge means "this list is still growing": true for an OPEN session, but for a
    // turn only while that turn is running. An ended session shows the quiet "ended"
    // badge instead (only unscoped — a scoped dead turn already reads as history).
    liveBadge.classList.toggle('hidden', ended || (scoped && turn?.state !== 'live'));
    endBadge.classList.toggle('hidden', !ended || scoped);

    feedHost.replaceChildren();
    // Show only the newest `feedVisibleCap` of the retained ring — the panel above takes the rest
    // of the budget (see feedCapForPanel). The ring still keeps up to FEED_CAP for the drawer.
    const ring = (scoped ? feed.items(selectedTurn) : feed.items()).slice(-feedVisibleCap);
    if (!ring.length) {
      // A local command or a /clear ran no tools BY NATURE — say that, instead of leaving the
      // user to wonder whether the data is missing.
      const why = !scoped
        ? 'no activity yet'
        : turn && turn.kind !== 'work'
          ? 'nothing ran — ' + entryTitle(lastSnap, turn) + ' never called the model'
          : 'no tool activity in this turn';
      feedHost.append(E('div', 'wdesc', why));
      return;
    }
    // newest first: iterate the ring in reverse so the latest event is on top
    for (let i = ring.length - 1; i >= 0; i--) {
      const it = ring[i]!; // i is always < ring.length (loop invariant), so never undefined
      // An API-call row: "API call", the input that triggered it, and the call's latency in the
      // third column. The drawer holds the full input/output.
      if (it.apiCall) {
        const r = E('div', 'fev api' + (it.error ? ' err' : ''));
        r.onclick = () => openFeedItem(it);
        // On a failed call the arg column carries the error message the user was shown
        // ("You've hit your session limit") — far more useful there than the input hint.
        r.append(E('span', 'fn', 'API call'), E('span', 'fa', (it.error && it.errorMessage) || it.arg || '—'));
        const t = E('span', 'ft');
        if (it.sub) t.append(E('span', 'fagent', 'subagent'));
        // A failed call shows its status ('429', 'auth', or a plain 'error') instead of a latency
        // it never produced; a normal call shows its latency ('—' when unmeasurable).
        if (it.error) t.append(E('span', 'ferr', 'error'));
        else t.append(document.createTextNode(it.ms != null ? formatToolMs(it.ms) : '—'));
        r.append(t);
        feedHost.append(r);
        continue;
      }
      const r = E('div', 'fev' + (it.error ? ' err' : ''));
      r.onclick = () => openFeedItem(it);
      // an `Agent` tool-start is a subagent spawn — show it as "spawn <type>".
      const label = it.spawn ? 'spawn' : it.name;
      // A background command that ended badly shows Claude Code's own sentence instead of the
      // command — the same substitution a failed API call already makes with its error message.
      // It is the only place the exit code exists, and the command itself is still in the drawer.
      const spawnLabel = it.spawn
        ? it.subagentType || 'subagent'
        : (it.background && it.error && it.errorMessage) || it.arg || '—';
      const spawnHint =
        it.spawn && it.launchPrompt
          ? ' · ' + it.launchPrompt.slice(0, 60) + (it.launchPrompt.length > 60 ? '…' : '')
          : '';
      // A long tool name (e.g. an MCP tool) ellipsizes in the fixed name column — keep the full
      // name on hover so nothing is lost to the alignment.
      const fnEl = E('span', 'fn', label);
      fnEl.title = label;
      r.append(fnEl, E('span', 'fa', spawnLabel + spawnHint));
      // third column = duration; a subagent's tool also gets a small 'subagent' tag
      // before it. formatToolMs keeps raw ms below 1s (the useful precision for a single
      // tool), humanizes above it ('18.1s', '2m 14s' — never '32888ms'), and renders
      // 'running…' for a still-running row — one format across feed, drawer and cards.
      // On an ended session a row with no tool-end can't be running: it was cut off.
      const t = E('span', 'ft');
      if (it.sub) t.append(E('span', 'fagent', 'subagent'));
      if (it.error) t.append(E('span', 'ferr', 'error'));
      t.append(document.createTextNode(toolDuration(it.ms, ended)));
      r.append(t);
      feedHost.append(r);
    }
  }

  // A workflow run is a different animal from a subagent, so it reads as a different row: it
  // has no context window of its own, no single model, and no returned output — it has a fleet.
  // Its subagents are deliberately NOT listed (a real run spawns ~100); the numbers stand in.
  function workflowCard(a: AgentNode): HTMLElement {
    // a.workflow! proven non-null: workflowCard is only called when a.kind === 'workflow', and
    // the AgentNode invariant guarantees kind === 'workflow' ⟺ workflow !== null.
    const w = a.workflow!;
    const c = E('div', 'subcard wfcard');
    c.onclick = () => openWorkflow(a);
    const top = E('div', 'top');
    const topRow = E('div', 'top-row');
    const st = displayState(a, ended);
    topRow.append(E('span', 'atype', w.name || 'workflow'), E('span', `badge b-${st}`, st));
    top.append(topRow, E('span', 'wfkind', 'workflow run'));
    c.append(top);
    const bars = E('div', 'bars');
    const line = (lbl: string, val: string) => {
      const row = E('div', 'crow');
      const head = E('div', 'chead');
      head.append(E('span', 'clbl', lbl), E('span', 'cval', val));
      row.append(head);
      return row;
    };
    // running comes from the run's journal — nothing in a workflow subagent's transcript says
    // whether it is still working. On a non-running run these agents never returned; calling them
    // "running" would contradict the state badge on the same card.
    const unreturned = st !== 'running' ? 'never returned' : 'running';
    bars.append(line('subagents', w.running ? `${w.agents} · ${w.running} ${unreturned}` : `${w.agents}`));
    bars.append(line('volume', k(w.volume) + ' tokens'));
    c.append(bars);
    // Models are a BREAKDOWN by design: a run routes stages to different models, so a single
    // "model" field would have to pick one and lie about the rest.
    if (w.models.length) {
      const chips = E('div', 'wfmodels');
      for (const m of w.models) {
        const chip = E('span', 'amodel-chip');
        chip.append(E('span', null, m.model), E('span', 'wfcalls', ` ${m.agents}`));
        chips.append(chip);
      }
      c.append(chips);
    }
    return c;
  }

  function renderSubs(s: TreeSnapshot): void {
    subsHost.replaceChildren();
    // Empty scope: say so (the other widgets do — "no skills yet"), never a bare title.
    // Tense follows the session: an ended one can't grow a subagent anymore.
    if (!s.subagents.length) {
      subsHost.append(
        E(
          'div',
          'wdesc',
          selectedTurn !== null
            ? 'no subagents in this entry'
            : ended
              ? 'no subagents ran in this session'
              : 'no subagents yet',
        ),
      );
      return;
    }
    const sorted = subagentsChronological(s.subagents); // launch order; untimestamped last
    const maxReturned = maxReturnedLen(s.subagents);
    for (const a of sorted) {
      if (a.kind === 'workflow') {
        subsHost.append(workflowCard(a));
        continue;
      }
      const c = E('div', 'subcard');
      c.onclick = () => openSub(a);
      const top = E('div', 'top');
      const topRow = E('div', 'top-row');
      const st = displayState(a, ended);
      // Same chain as the live row: the card is named by the WORK, since the type names
      // nothing (455 of 690 real spawns are `general-purpose` — a page of cards all titled
      // the same). Type and model are technical attributes of the same order, so they sit
      // together as chips underneath.
      topRow.append(E('span', 'atype', a.title), E('span', `badge b-${st}`, st));
      top.append(topRow);
      const chips = E('div', 'chips');
      if (a.agentType) chips.append(E('span', 'atype-chip', a.agentType));
      if (a.model) chips.append(E('span', 'amodel-chip', a.model));
      if (chips.children.length) top.append(chips);
      c.append(top);
      // No launch prompt here: the title already states the intent, and the two visible
      // lines were almost always the prompt's boilerplate preamble. The full text stays one
      // click away, in the drawer's `Launch prompt` block.
      // pctStr is shown only for CONSUMED — the % of the window is the one number
      // that ranks a subagent's weight; RETURNED is normalized against peers, so a
      // percentage there would be misleading.
      const barLine = (lbl: string, valStr: string, frac: number, color: string, pctStr: string | null) => {
        const row = E('div', 'crow');
        const head = E('div', 'chead');
        head.append(E('span', 'clbl', lbl), E('span', 'cval', valStr));
        const bar = E('div', 'cbar');
        const i = E('i');
        i.style.width = Math.max(2, Math.min(100, frac * 100)) + '%';
        i.style.background = color;
        bar.append(i);
        const track = E('div', 'ctrack');
        track.append(bar);
        if (pctStr) track.append(E('span', 'cpct', pctStr));
        row.append(head, track);
        return row;
      };
      // A bar-less line: a cumulative volume has no window to fill, so it shows a value only.
      const valLine = (lbl: string, valStr: string, estimated: boolean) => {
        const row = E('div', 'crow');
        const head = E('div', 'chead');
        head.append(E('span', 'clbl', lbl), E('span', 'cval', valStr));
        if (estimated)
          row.title =
            'Estimated: this background subagent wrote no per-call usage, so this is the reported total (≈ its final context), not a true sum.';
        row.append(head);
        return row;
      };
      const bars = E('div', 'bars');
      // VOLUME = cumulative consumption (comparable to the main Token usage); no window frame — a
      // volume can exceed the window. CONTEXT = how full the subagent's own window got.
      bars.append(valLine('volume', (a.volumeEstimated ? '~' : '') + k(a.volume) + ' tokens', a.volumeEstimated));
      const ctxFrac = contextFraction(a);
      bars.append(
        barLine('context', k(a.fill) + ' / ' + kc(a.window), ctxFrac, 'var(--create)', Math.round(ctxFrac * 100) + '%'),
      );
      // returned bar is always shown — empty while running, fills when done
      const hasOut = typeof a.outLen === 'number' && a.outLen > 0;
      bars.append(
        barLine(
          'returned',
          hasOut ? kc(a.outLen) + 'ch' : '—',
          hasOut ? a.outLen / maxReturned : 0,
          'var(--crit)',
          null,
        ),
      );
      c.append(bars);
      const foot = E('div', 'foot');
      const launchStr = formatLaunchTime(a.startedAt) || '—';
      // Launch time stays left; tool count + duration are pushed right as one group
      // (the card is clickable on its own, so it carries no explicit affordance text).
      const footRight = E('span', 'footright');
      footRight.append(E('span', null, a.tools.length + ' tools'), E('span', null, formatDuration(a.durationMs)));
      foot.append(E('span', null, launchStr), footRight);
      c.append(foot);
      subsHost.append(c);
    }
  }

  // ---- drawers ----
  // A subagent's own tool calls, sorted by output size desc: first 5 inline, the
  // rest behind a "show N more" toggle (no nested scrollbox — the drawer scrolls).
  function toolListBlock(
    label: string,
    list: readonly ToolNode[],
    owner: string | null,
    back?: BackEntry,
  ): HTMLElement {
    const box = E('div');
    const sorted = [...list].sort((x, y) => (y.ctx ?? 0) - (x.ctx ?? 0));
    const trow = (t: ToolNode) => {
      const r = E('div', 'ttrow');
      r.onclick = () => openTool(t, owner, back);
      const nm = E('div', 'tn');
      nm.append(document.createTextNode(t.name + '  '));
      const arg = E('span', 'targ');
      arg.textContent = t.arg || '';
      nm.append(arg);
      r.append(
        nm,
        E('div', 'tv', t.ms != null ? formatToolMs(t.ms) : '—'),
        E('div', 'tv', typeof t.ctx === 'number' ? kc(t.ctx) + 'ch' : '—'),
      );
      return r;
    };
    for (const t of sorted.slice(0, 5)) box.append(trow(t));
    const rest = sorted.slice(5);
    if (rest.length) {
      const restBox = E('div');
      restBox.style.display = 'none';
      for (const t of rest) restBox.append(trow(t));
      const more = E('div', 'morerow', 'show ' + rest.length + ' more ▾');
      let open = false;
      more.onclick = () => {
        open = !open;
        restBox.style.display = open ? 'block' : 'none';
        more.textContent = open ? 'show less ▴' : 'show ' + rest.length + ' more ▾';
      };
      box.append(restBox, more);
    }
    return block(label, box);
  }

  function openSub(a: AgentNode, back?: BackEntry): void {
    if (back) crumbs.push(back);
    else crumbs.length = 0;
    dbody.replaceChildren();
    renderCrumbs();
    // Headed by the work, like the row and the card that open it — clicking "Review Task 5"
    // and landing on a panel titled "general-purpose" broke the thread. Type and model
    // IDENTIFY the subagent rather than measure it, so they ride in the subtitle; the full
    // model id (too long for a header line) stays in Details.
    // Effort is per CALL and a subagent makes many, so show what its calls actually reported
    // — joined if they differ — and nothing at all when none did (a model without a
    // configurable effort, or a transcript written before Claude Code 2.1.212).
    dbody.append(
      dhead('subagent', a.title, [
        a.agentType,
        shortModel(a.model),
        a.efforts && a.efforts.length ? 'effort ' + a.efforts.join('/') : null,
      ]),
    );
    // The three questions a subagent actually raises: how long, how much did it do, what came
    // back. Everything else is either a proportion (bars below) or bookkeeping (Details).
    dbody.append(
      kpis(
        kpi('Duration', formatDuration(a.durationMs)),
        kpi('Tool calls', String(a.tools.length)),
        kpi(
          'Returned',
          typeof a.outLen === 'number' ? kc(a.outLen) : '—',
          typeof a.outLen === 'number' ? 'chars' : null,
        ),
      ),
    );
    const bars = E('div', 'block');
    bars.append(
      fillBar(
        'Context',
        k(a.fill) + ' / ' + k(a.window),
        a.window > 0 ? (a.fill / a.window) * 100 : 0,
        'linear-gradient(90deg,var(--cache),var(--agent))',
      ),
    );
    // The four usage-block categories as ONE stacked bar: their story is the ratio — a
    // subagent's volume is almost all cache re-reads — which two pipe-separated text rows
    // could state but never show. The share is printed only where it rounds to a meaningful
    // ≥1% (output/input are a rounding sliver). Absent for an estimated (async) volume.
    const b = a.volumeBreakdown;
    if (b) {
      const detail = (v: number) => {
        const pct = a.volume > 0 ? Math.round((v / a.volume) * 100) : 0;
        return k(v) + (pct >= 1 ? ' · ' + pct + '%' : '');
      };
      const vol = stackBlock('Volume', (a.volumeEstimated ? '~' : '') + k(a.volume) + ' tokens', [
        { label: 'cache read', value: b.cacheRead, color: 'var(--cache)', detail: detail(b.cacheRead) },
        { label: 'cache write', value: b.cacheCreation, color: 'var(--create)', detail: detail(b.cacheCreation) },
        { label: 'output', value: b.output, color: 'var(--good)', detail: detail(b.output) },
        { label: 'input', value: b.input, color: 'var(--input)', detail: detail(b.input) },
      ]);
      vol.style.marginTop = '1rem';
      bars.append(vol);
    } else {
      // No breakdown (estimated volume): the total is still a fact worth stating.
      const row = drow('Volume', (a.volumeEstimated ? '~' : '') + k(a.volume) + ' tokens');
      row.style.marginTop = '1rem';
      bars.append(row);
    }
    dbody.append(bars);
    // Section order (from the prototype): 1) launch prompt, 2) tools it called, 3) returned output.
    // Launch prompt is truncated + "show full" → modal, symmetric with the returned-output
    // block below, so neither <pre> is tall enough to grow its own nested scrollbar.
    if (a.prompt) {
      const prompt = a.prompt; // string — narrowed by the if (a.prompt) guard; captured to survive the closure
      const pre = E('pre');
      pre.textContent = prompt.slice(0, 500) + (prompt.length > 500 ? ' …' : '');
      const bl = block('Launch prompt (what spawned it)', pre);
      if (prompt.length > 500) {
        const more = E('button', 'morebtn', 'show full ▾');
        more.onclick = () =>
          openOutput('Launch prompt', (a.agentType || a.agentId) + ' · ' + kc(prompt.length) + ' chars', prompt);
        bl.append(more);
      }
      dbody.append(bl);
    }
    if (a.tools.length)
      dbody.append(
        toolListBlock('Tools it called (' + a.tools.length + ')', a.tools, a.agentType || a.agentId, {
          label: a.title,
          open: () => openSub(a),
        }),
      );
    if (typeof a.outLen === 'number' && a.outLen > 0 && a.outputFull) {
      const outputFull = a.outputFull; // string — narrowed by the if (a.outputFull) guard; captured to survive the closure
      const pre = E('pre');
      pre.textContent = outputFull.slice(0, 500) + (a.outLen > 500 ? ' …' : '');
      const bl = block('Returned to main (' + kc(a.outLen) + ' chars)', pre);
      const more = E('button', 'morebtn', 'show full ▾');
      more.onclick = () =>
        openOutput('Output returned to main', (a.agentType || a.agentId) + ' · ' + kc(a.outLen) + ' chars', outputFull);
      bl.append(more);
      dbody.append(bl);
    }
    // Bookkeeping last: the full model id (the subtitle carries only the family), when it ran,
    // and which turn spawned it — facts you look up, not facts you scan.
    const meta = metaBlock([
      ['Model', a.model],
      ['Launched at', formatLaunchTime(a.startedAt)],
      ['Spawned in turn', a.turnIndex != null ? String(a.turnIndex + 1) : null],
    ]);
    if (meta) dbody.append(meta);
    openDrawer();
  }

  function openWorkflow(a: AgentNode): void {
    crumbs.length = 0;
    dbody.replaceChildren();
    renderCrumbs();
    const w = a.workflow!;
    const st = displayState(a, ended);
    dbody.append(dhead('workflow run', w.name || 'workflow', [st, w.runId.slice(0, 16)]));
    dbody.append(kpis(kpi('Subagents', String(w.agents)), kpi('Volume', k(w.volume), 'tokens')));
    // Launch prompt = the workflow script the caller passed to the Workflow() tool.
    if (a.prompt) {
      const prompt = a.prompt;
      const pre = E('pre');
      pre.textContent = prompt.slice(0, 500) + (prompt.length > 500 ? ' …' : '');
      const bl = block('Workflow script', pre);
      if (prompt.length > 500) {
        const more = E('button', 'morebtn', 'show full ▾');
        more.onclick = () => openOutput('Workflow script', w.name || w.runId, prompt);
        bl.append(more);
      }
      dbody.append(bl);
    }
    // Per-member cards: 2-per-row grid with all available AgentAcc data.
    if (w.members.length) {
      const grid = E('div', 'wf-members');
      const unreturned = st !== 'running';
      for (const m of w.members) {
        const card = E('div', 'wf-mcard');
        card.append(E('div', 'wfmc-id', m.agentId));
        const typeLine = E('div', 'wfmc-type');
        typeLine.append(
          document.createTextNode(m.agentType || 'subagent'),
          E('span', null, ' · '),
          E('b', null, m.model ? shortModel(m.model) : '—'),
        );
        card.append(typeLine);
        const krow = E('div', 'wfmc-kpis');
        const mkpi = (lbl: string, val: string) => {
          const t = E('div', 'wfmc-kpi');
          t.append(E('span', null, lbl), E('span', null, val));
          return t;
        };
        if (m.volume > 0) krow.append(mkpi('Volume', k(m.volume) + ' tok'));
        if (m.window > 0) krow.append(mkpi('Fill', (m.window > 0 ? Math.round((m.fill / m.window) * 100) : 0) + '%'));
        if (m.durationMs != null) krow.append(mkpi('Time', formatDuration(m.durationMs)));
        if (m.toolCount > 0) krow.append(mkpi('Tools', String(m.toolCount)));
        if (krow.children.length) card.append(krow);
        const meta: string[] = [];
        if (m.outLen > 0) meta.push('→ ' + kc(m.outLen) + ' chars');
        if (m.efforts.length) meta.push('effort ' + m.efforts.join('/'));
        if (meta.length) {
          const md = E('div', 'wfmc-meta');
          meta.forEach((s) => md.append(E('span', null, s)));
          card.append(md);
        }
        const badgeCls = m.returned ? 'ret' : unreturned ? 'miss' : 'live';
        card.append(
          E('span', 'wfmc-badge ' + badgeCls, m.returned ? 'returned' : unreturned ? 'never returned' : 'running'),
        );
        // Prompt: fetch on click — the child jsonl is read once per click, never cached.
        if (loadAgentPrompt) {
          const agentId = m.agentId;
          const btn = E('button', 'morebtn wfmc-prompt-btn', 'prompt ▾');
          btn.onclick = (e) => {
            e.stopPropagation();
            btn.textContent = 'loading…';
            btn.disabled = true;
            loadAgentPrompt(agentId)
              .then((res) => {
                if (!res) {
                  btn.textContent = 'prompt unavailable';
                  return;
                }
                btn.remove();
                const pre = E('pre', 'wfmc-prompt');
                pre.textContent = res.text + (res.truncated ? ' …' : '');
                card.append(pre);
              })
              .catch(() => {
                btn.textContent = 'error loading';
              });
          };
          card.append(btn);
        }
        grid.append(card);
      }
      dbody.append(block('Agents (' + w.members.length + ')', grid));
    }
    openDrawer();
  }

  function openTool(
    t: {
      id: string;
      name: string;
      ms: number | null;
      arg: string | null;
      ctx: number | null;
      turnIndex?: number | null;
      error?: true;
      background?: true;
      outcome?: string;
    },
    owner: string | null,
    back?: BackEntry,
  ): void {
    if (back) crumbs.push(back);
    else crumbs.length = 0;
    dbody.replaceChildren();
    renderCrumbs();
    // Who ran it and when identify the call; how long and how much it returned measure it.
    const th = dhead('tool call', t.name, [
      owner || 'main session',
      t.turnIndex != null ? 'turn ' + (t.turnIndex + 1) : null,
    ]);
    // A failed tool gets a red chip beside the 'tool call' eyebrow — the drawer's own badge,
    // matching the feed row and the Trace span. The output block below already shows the error
    // text itself (it is the tool_result), so the chip only has to flag it.
    if (t.error) th.querySelector('.deyebrow')?.append(E('span', 'dchip err', 'failed'));
    // The same marker the Trace block carries, for the same reason: everything below measures the
    // LAUNCH, while the command it started outlives this call — by 2.8 minutes at the median, and
    // by hours at the tail (measured over 120 real launches).
    if (t.background) th.querySelector('.deyebrow')?.append(E('span', 'dchip bg', 'background'));
    dbody.append(th);
    // A tool opened from the live feed can still be RUNNING: toolDuration's null case says
    // "running…", the same wording the feed row and the cards use — never a bare '—', which
    // reads as "unknown" when the truth is "not finished".
    dbody.append(
      kpis(
        // A background launch's ms is the receipt, not the command's life: naming the tile
        // `Duration` printed 99ms for a command that ran eight seconds and exited 7.
        kpi(t.background ? 'Launch' : 'Duration', toolDuration(t.ms, ended)),
        kpi('Output size', t.ctx ? kc(t.ctx) : '—', t.ctx ? 'chars' : null),
      ),
    );
    // The drawer said FAILED and then showed the launch receipt — «Command running in background…
    // you will be notified» — so the surface you open to learn WHY said less than the row you
    // opened it from. The outcome is Claude Code's own sentence, and the only place the exit code
    // exists; until it lands, the command is genuinely still running and the drawer says so.
    if (t.background) {
      dbody.append(
        blockD(
          'Outcome',
          t.outcome ? null : 'Claude Code reports a background command only when it ends.',
          E('pre', null, t.outcome ? outcomeLine(t.outcome) : 'still running'),
        ),
      );
    }
    dbody.append(block('Operated on', E('pre', null, t.arg || '—')));
    // What the tool PUT IN THE CONTEXT — the point of the whole tool. Only its size is held
    // in the client (a session's tool outputs together are far too big to keep), so the text
    // is fetched from the session file now, and only for the tool actually opened.
    if (t.ctx !== null && t.ctx > 0 && loadToolOutput) dbody.append(toolOutputBlock(t, loadToolOutput));
    openDrawer();
  }

  // The output block starts as a placeholder and fills in when the fetch lands. It needs no
  // staleness guard: opening another entity calls dbody.replaceChildren, which DETACHES this
  // block — a late response then fills a node that is no longer in the page.
  function toolOutputBlock(
    t: { id: string; name: string; ctx: number | null },
    fetcher: (id: string) => Promise<ToolOutputResult | null>,
  ): HTMLElement {
    const pre = E('pre', null, 'loading…');
    // t.ctx is always a positive number here (caller guards with ctx !== null && ctx > 0).
    const bl = block('Output returned (' + kc(t.ctx ?? 0) + ' chars)', pre);
    fetcher(t.id).then((res) => {
      if (!res) {
        pre.textContent = 'output not available';
        return;
      }
      pre.textContent = res.text.slice(0, 500) + (res.text.length > 500 || res.truncated ? ' …' : '');
      // The published page, as a link, ABOVE the raw output it was read from. Inserted here rather
      // than built by openTool because only the fetch knows the URL — and inserting through the
      // block's own parent is what makes it safe: a drawer that has since been replaced was
      // detached by dbody.replaceChildren, so `parentElement` is null and this is a no-op.
      const url = publishedUrl(t.name, res.text);
      if (url) bl.parentElement?.insertBefore(publishedBlock(url), bl);
      if (res.text.length > 500 || res.truncated) {
        const more = E('button', 'morebtn', 'show full ▾');
        // `len` is the TRUE size; `text` is capped by the server — say so rather than
        // implying the modal holds all of a 200k-char output.
        const sub =
          t.name + ' · ' + kc(res.len) + ' chars' + (res.truncated ? ' (first ' + kc(res.text.length) + ' shown)' : '');
        more.onclick = () => openOutput('Tool output', sub, res.text, true);
        bl.append(more);
      }
    });
    return bl;
  }

  // The page an `Artifact` publish put online, named in its own result: `Published <file> at
  // <url>`. One shape in the whole local corpus (35 occurrences, all `claude.ai/code/artifact/`),
  // and the first match wins — a result that names its URL twice is naming one page.
  //
  // Gated on the TOOL as well as the URL, because the block claims something: only an `Artifact`
  // call published anything, and a `Bash` that happened to print an artifact link (a `cat` of a
  // log) did not. The `action: "list"` form returns no URL, so it correctly gets no block.
  //
  // LIMIT: the host is matched literally. If it ever changes, this degrades to what the drawer did
  // before — the URL still readable in the output below, just not clickable.
  const ARTIFACT_URL = /https:\/\/claude\.ai\/code\/artifact\/[\w-]+/;

  /** The artifact URL an `Artifact` call's output reports, or null when there is none to link. */
  function publishedUrl(name: string, text: string): string | null {
    if (name !== 'Artifact') return null;
    return ARTIFACT_URL.exec(text)?.[0] ?? null;
  }

  /** The `Published at` block: the URL as a real link, built as DOM nodes. Never innerHTML — a
   * tool's output is arbitrary text a command printed, and the one safe way to put it on the page
   * is to never let it be parsed as markup. */
  function publishedBlock(url: string): HTMLElement {
    const a = E('a', 'dlink', url) as HTMLAnchorElement;
    a.href = url;
    a.target = '_blank';
    a.rel = 'noreferrer';
    return block('Published at', a);
  }

  // The drawer for an API call. Facts FIRST (model + token breakdown), like a tool's drawer,
  // then the call's input and output — the FULL text fetched from the session file on click,
  // never held in the client. Until the fetch lands the input already shows the short hint the
  // row carried, so the drawer is never blank.
  function openCall(
    it: {
      callId?: string | null;
      sub?: boolean;
      arg?: string | null;
      turnIndex?: number | null;
      error?: boolean;
      errorMessage?: string | null;
    },
    back?: BackEntry,
  ): void {
    if (back) crumbs.push(back);
    else crumbs.length = 0;
    dbody.replaceChildren();
    renderCrumbs();
    const wired = Boolean(it.callId && loadCallIO);
    // Model and effort are only known once the fetch lands, so the identity line starts as a
    // pending hint and is rewritten in place — never left saying "loading…" forever.
    const turnPart = it.turnIndex != null ? 'turn ' + (it.turnIndex + 1) : null;
    const head = dhead('API call' + (it.sub ? ' · subagent' : ''), it.callId || 'API call', [
      wired ? 'loading…' : null,
      turnPart,
    ]);
    // A failed call: red chip beside the eyebrow, and the message Claude Code showed the user
    // spelled out — a rate limit or auth failure is the whole story of the call, above its tokens.
    if (it.error) {
      head.querySelector('.deyebrow')?.append(E('span', 'dchip err', 'error'));
      dbody.append(head, block('Error', E('pre', null, it.errorMessage || 'API call failed')));
    } else {
      dbody.append(head);
    }
    // Input reframed as "cached context + new this call": the raw `input_tokens` is only the
    // UNCACHED tail (often ~2), NOT the size of what was added — that lives in cache_creation.
    const inTile = wired ? kpiWait('Input') : kpi('Input', '—');
    const newTile = wired ? kpiWait('New this call') : kpi('New this call', '—');
    const outTile = wired ? kpiWait('Output') : kpi('Output', '—');
    dbody.append(kpis(inTile, newTile, outTile));
    // The three raw usage figures become this bar's legend: uncached / cache write / cache
    // read only mean something as a ratio — 97% of a call's input is context re-read from
    // cache, which the old text row stated but never showed. Filled when the fetch lands.
    const compBlock = E('div', 'block');
    dbody.append(compBlock);
    // Input block: the delta this call ADDED (its size is the "new this call" figure above); the
    // bulk of the input was the prior context, re-read from cache.
    const inPre = E('pre', null, it.arg || '—');
    const inBl = E('div', 'block');
    inBl.append(
      E('div', 'blabel', 'Input'),
      E(
        'div',
        'wdesc',
        'What this call ADDED to the context — a prompt, or the tool results just returned. The bulk of the input (above) was the prior context, re-read from cache.',
      ),
      inPre,
    );
    // The call's own words come FIRST — they are the only prose in this drawer, and the thing
    // the Trace names the round with. They are inside `Output` too, but there a call with tools
    // renders verbatim (its args are code), so the one sentence meant to be read as prose was
    // read as a dump. Hidden until the fetch says there is one: 60% of calls state nothing.
    const intentPre = E('pre', null, '—');
    const intentBl = blockD(
      'Intent',
      'What the model said it was about to do, before running this call’s tools.',
      intentPre,
    );
    intentBl.className = 'block hidden';
    const outPre = E('pre', null, wired ? 'loading…' : '—');
    const outBl = blockD(
      'Output',
      'What the model produced: its reply text, and any tools it decided to call.',
      outPre,
    );
    dbody.append(intentBl, inBl, outBl);
    if (wired) {
      // No staleness guard: opening another entity calls dbody.replaceChildren, detaching these
      // nodes, so a late response fills orphans.
      // wired = Boolean(it.callId && loadCallIO), so both are non-null here.
      const fetchIO = loadCallIO!;
      const callId = it.callId as string;
      fetchIO(callId).then((res: CallIOResult | null) => {
        if (!res) {
          // Not found in the session file — usually a server started before this endpoint
          // existed (restart seedeep), or a call belonging to another session.
          setDSub(head, ['not found — restart seedeep if this persists', turnPart]);
          setKV(inTile, '—');
          setKV(newTile, '—');
          setKV(outTile, '—');
          outPre.textContent = '—';
          return;
        }
        // Effort is named ONLY when the call reported one. A dash would assert "no effort",
        // which is never what the absence means: Claude Code started writing the field in
        // 2.1.212, and haiku never writes it. Ordered as the call itself reads: which model,
        // at what effort.
        setDSub(head, [res.model || null, res.effort ? 'effort ' + res.effort : null, turnPart]);
        const u = res.usage || {};
        // total input = uncached + cache-read + cache-created; "new this call" = what was ADDED
        // (uncached + newly cached) — where a prompt/tool-result actually lands. The raw
        // `input_tokens` alone is only the uncached tail, which is why it looks tiny.
        const totalIn = (u.input || 0) + (u.cacheRead || 0) + (u.cacheCreation || 0);
        const newThis = (u.input || 0) + (u.cacheCreation || 0);
        setKV(inTile, kc(totalIn));
        setKV(newTile, kc(newThis));
        setKV(outTile, kc(u.output || 0));
        compBlock.replaceChildren(
          stackBlock('Input composition', kc(totalIn) + ' total', [
            { label: 'cached', value: u.cacheRead || 0, color: 'var(--cache)', detail: kc(u.cacheRead || 0) },
            {
              label: 'cache write',
              value: u.cacheCreation || 0,
              color: 'var(--create)',
              detail: kc(u.cacheCreation || 0),
            },
            { label: 'uncached', value: u.input || 0, color: 'var(--input)', detail: kc(u.input || 0) },
          ]),
        );
        // The intent is markdown the model wrote, so `plain: false` — the same treatment the
        // final answer gets, never the verbatim one `Output` is forced into by its tool args.
        if (res.narration) {
          intentBl.className = 'block';
          fillIO(
            intentPre,
            intentBl,
            { text: res.narration, len: res.narration.length, truncated: false },
            'Intent',
            callId,
            null,
            false,
          );
        }
        fillIO(inPre, inBl, res.input, 'Call input', callId, it.arg, true); // input: raw tool results/delta → plain
        // Output: markdown for a prose answer, but VERBATIM when it contains a tool_use — its
        // args (a Write/Edit new_string) are code that markdown would garble.
        fillIO(outPre, outBl, res.output, 'Call output', callId, '—', Boolean(res.outputHasTools));
      });
    }
    openDrawer();
  }
  // Fill one I/O <pre>: truncate inline, "show full" → modal. `plain` picks the modal's view:
  // true = verbatim <pre> (raw tool results / delta), false = rendered markdown (the model's
  // own text, which is written as markdown — same as a subagent's returned output). Falls back
  // to `fallback` (the row hint for input, '—' for output) when the fetched side is empty.
  function fillIO(
    pre: HTMLElement,
    bl: HTMLElement,
    io: ToolOutputResult | null | undefined,
    title: string,
    callId: string | null | undefined,
    fallback: string | null | undefined,
    plain: boolean,
  ): void {
    if (!io || !io.text) {
      pre.textContent = fallback || '—';
      return;
    }
    pre.textContent = io.text.slice(0, 500) + (io.text.length > 500 || io.truncated ? ' …' : '');
    if (io.text.length > 500 || io.truncated) {
      const more = E('button', 'morebtn', 'show full ▾');
      const sub =
        (callId || 'call') +
        ' · ' +
        kc(io.len) +
        ' chars' +
        (io.truncated ? ' (first ' + kc(io.text.length) + ' shown)' : '');
      more.onclick = () => openOutput(title, sub, io.text, plain);
      bl.append(more);
    }
  }

  // Route a Trace block click to the appropriate existing drawer — reuses the same open*
  // functions the feed uses, so the drawer content is always consistent.
  // `back` is the surface the click came FROM, when that surface is itself a drawer and is
  // therefore replaced by this one (the all-activity list). Callers that stay visible behind
  // the drawer — the Trace modal, a feed row — pass nothing: they are still there to return to.
  function openBlock(handle: DrawerHandle, back?: BackEntry): void {
    if (handle.kind === 'call') {
      openCall({ callId: handle.callId }, back);
      return;
    }
    if (handle.kind === 'turn-text') {
      // The first and last block of every turn ARE the conversation, and they were the
      // only two a click did nothing on. The text is read from the reducer at click
      // time — the span store never holds a second copy of it.
      const t = state.snapshot().turnList.find((x) => x.index === handle.turnIndex);
      if (!t) return;
      const isPrompt = handle.which === 'prompt';
      const full = isPrompt ? t.prompt : t.result;
      const title = isPrompt ? 'Prompt · T' + t.index : 'Final answer · T' + t.index;
      const sub = isPrompt
        ? t.command
          ? 'slash command ' + t.command
          : 'typed prompt'
        : t.state === 'interrupted'
          ? 'the turn was interrupted'
          : 'model output, verbatim';
      // An interrupted turn has no result: say so rather than opening an empty drawer.
      openOutput(title, sub, full || (isPrompt ? '(no prompt text)' : '(no final answer — the turn did not close)'));
      return;
    }
    if (handle.kind === 'tool') {
      // Look up the real tool node from the snapshot for accurate name/ms/ctx/arg — same
      // pattern as openFeedItem, which already owns this lookup.
      const s = state.snapshot();
      const own = s.mainTools.find((t) => t.id === handle.toolUseId);
      if (own) {
        openTool(own, 'main session', back);
        return;
      }
      for (const a of s.subagents) {
        const t = a.tools.find((t) => t.id === handle.toolUseId);
        if (t) {
          openTool(t, a.agentType || a.agentId, back);
          return;
        }
      }
      // Span exists but tool not yet in snapshot (still running) — open with minimal shape.
      openTool({ id: handle.toolUseId, name: '', ms: null, ctx: null, arg: null }, null, back);
      return;
    }
    if (handle.kind === 'subagent') {
      const s = state.snapshot();
      const a = s.subagents.find((ag) => ag.agentId === handle.agentId);
      if (a) {
        openSub(a, back);
        return;
      }
      // Agent not in the snapshot yet (still running, or no subagent-meta): fall
      // back to the spawn TOOL drawer — launch prompt and timing always exist
      // there. A click must never be a silent no-op.
      if (handle.toolUseId) {
        const own = s.mainTools.find((t) => t.id === handle.toolUseId);
        openTool(own ?? { id: handle.toolUseId, name: 'Agent', ms: null, ctx: null, arg: null }, null, back);
      }
    }
  }

  // Trace button wiring — lazy: the modal is created on first click to keep the DOM lean.
  traceBtn.onclick = () => {
    if (!trace) trace = createTrace(container, { onBlock: openBlock });
    trace.open(spanStore.snapshot(selectedTurn), selectedTurn, ended);
  };

  // A feed row carries only a tool_use_id — the tool's real state (duration, output size,
  // owner) lives in the snapshot, which is the single source of truth. Rebuild it FRESH at
  // click time: a tool that ended after the last paint then opens with its true numbers,
  // and the ring never needs a second copy of state it would let drift.
  function openFeedItem(it: FeedItem): void {
    if (it.apiCall) {
      openCall(it);
      return;
    }
    if (!it.id) return;
    const s = state.snapshot();
    // A spawn row IS its subagent — open that (richer) drawer. The link is the spawn's
    // tool_use_id, because the agentId is only learned later, from `subagent-meta`; an async
    // subagent that has not produced one yet simply falls through to its `Agent` tool below.
    const agent = s.subagents.find((a) => a.toolUseId === it.id);
    if (agent) {
      openSub(agent);
      return;
    }
    const own = s.mainTools.find((t) => t.id === it.id);
    if (own) {
      openTool(own, 'main session');
      return;
    }
    for (const a of s.subagents) {
      const t = a.tools.find((t) => t.id === it.id);
      if (t) {
        openTool(t, a.agentType || a.agentId);
        return;
      }
    }
  }

  function openToolType(name: string, s: TreeSnapshot, back?: BackEntry): void {
    if (back) crumbs.push(back);
    else crumbs.length = 0;
    const list = [...s.mainTools.filter((t) => t.name === name)].sort((a, b) => (b.ctx ?? 0) - (a.ctx ?? 0));
    dbody.replaceChildren();
    renderCrumbs();
    dbody.append(dhead('tool type', name, ['main session']));
    const totalCtx = list.reduce((n, t) => n + (t.ctx ?? 0), 0);
    const totalMs = list.reduce((n, t) => n + (t.ms ?? 0), 0);
    const hasTiming = list.some((t) => t.ms !== null);
    // Total time only when at least one call reported a duration — a "0s" total would assert
    // instant, when the truth is "not measured".
    const tiles = [kpi('Calls', String(list.length)), kpi('Total output', kc(totalCtx), 'chars')];
    if (hasTiming) tiles.push(kpi('Total time', formatToolMs(totalMs)));
    dbody.append(kpis(...tiles));
    const backToType: BackEntry = { label: name, open: () => openToolType(name, s) };

    const filterInput = E('input', 'tfilter') as HTMLInputElement;
    filterInput.placeholder = 'filter by path or argument';
    const filterBar = E('div', 'tfilterbar');
    filterBar.append(filterInput);
    const countEl = E('div', 'tcount2', '');
    const box = E('div');

    const renderRows = () => {
      const q = filterInput.value.toLowerCase();
      const filtered = q ? list.filter((t) => (t.arg || '').toLowerCase().includes(q)) : list;
      countEl.textContent = q ? `${filtered.length} of ${list.length} calls` : `${list.length} calls`;
      box.replaceChildren();
      for (const t of filtered) {
        const r = E('div', 'ttrow' + (t.error ? ' err' : ''));
        r.onclick = () => openTool(t, 'main session', backToType);
        const nm = E('div', 'tn');
        nm.append(document.createTextNode(t.name + '  '));
        if (t.error) nm.append(E('span', 'terr', 'error'));
        const arg = E('span', 'targ');
        arg.textContent = t.arg || '';
        nm.append(arg);
        r.append(
          nm,
          E('div', 'tv', t.ms != null ? formatToolMs(t.ms) : '—'),
          E('div', 'tv', typeof t.ctx === 'number' ? kc(t.ctx) + 'ch' : '—'),
        );
        box.append(r);
      }
      if (!filtered.length) box.append(E('div', 'wdesc', 'No calls match the filter.'));
    };

    filterInput.oninput = renderRows;
    renderRows();
    dbody.append(filterBar, countEl, block('All ' + name + ' calls', box));
    openDrawer();
  }

  function openSkill(sk: SkillNode, skills: SkillNode[], back?: BackEntry): void {
    if (back) crumbs.push(back);
    else crumbs.length = 0;
    dbody.replaceChildren();
    renderCrumbs();
    dbody.append(dhead('skill', sk.name, ['invoked by the model']));
    const share = skillShare(sk, skills);
    dbody.append(kpis(kpi('Model invocations', String(sk.invokes)), kpi('Active for', String(sk.turns), 'API turns')));
    // The share is a proportion, so it gets the same bar the Graph cards use. Absent when it
    // cannot be computed — a 0% bar would claim the skill was never active.
    if (share != null) {
      const bl = E('div', 'block');
      bl.append(
        fillBar('Share of turns', sk.turns + ' turns', share, 'linear-gradient(90deg,var(--good),var(--cache))'),
      );
      dbody.append(bl);
    }
    dbody.append(
      block(
        'What these mean',
        Object.assign(E('div', 'wdesc'), {
          textContent:
            'Model invocations = times the model called the Skill tool for this skill (not user-typed /commands — those appear in the Commands widget). API turns = assistant lines where this skill was the last one active — a long-lived skill stays "active" for many turns after a single invocation, so that count is much larger.',
        }),
      ),
    );
    openDrawer();
  }

  function openCommand(cmd: CommandNode, back?: BackEntry): void {
    if (back) crumbs.push(back);
    else crumbs.length = 0;
    dbody.replaceChildren();
    renderCrumbs();
    // A command carries a single fact, so it rides in the subtitle: one lone KPI tile would
    // read as a dashboard with a missing half.
    dbody.append(dhead('command', '/' + cmd.name, ['used ' + cmd.count + (cmd.count === 1 ? ' time' : ' times')]));
    // Use the full (unscoped) snapshot so all turns appear regardless of current scope.
    const full = state.snapshot();
    const turnsWithCmd = full.turnList.filter((t) => t.commands.some((c) => c.name === cmd.name));
    if (turnsWithCmd.length) {
      const box = E('div');
      for (const turn of turnsWithCmd) {
        const turnCount = turn.commands.find((c) => c.name === cmd.name)!.count;
        const label = entryTitle(full, turn) || entryLabel(turn);
        const r = E('div', 'ttrow');
        // Click scopes the whole view to this turn and closes the drawer.
        r.onclick = () => {
          closeDrawer();
          selectTurn(turn.index);
        };
        const nm = E('div', 'tn');
        nm.textContent = label;
        r.append(nm, E('div', 'tv', turnCount > 1 ? '×' + turnCount : ''));
        box.append(r);
      }
      dbody.append(block('Used in', box));
    }
    openDrawer();
  }

  function openAllTools(s: TreeSnapshot): void {
    crumbs.length = 0;
    dbody.replaceChildren();
    renderCrumbs();
    dbody.append(dhead('tools', 'main session', [s.mainTools.length + ' calls']));
    const totalCtx = s.mainTools.reduce((n, t) => n + (t.ctx ?? 0), 0);
    const hasTiming = s.mainTools.some((t) => t.ms !== null);
    const totalMs = s.mainTools.reduce((n, t) => n + (t.ms ?? 0), 0);
    const tiles = [kpi('Calls', String(s.mainTools.length)), kpi('Total output', kc(totalCtx), 'chars')];
    if (hasTiming) tiles.push(kpi('Total time', formatToolMs(totalMs)));
    dbody.append(kpis(...tiles));

    let sortByTime = false;
    const sortBtn = E('button', 'tsort', 'size ↓');
    const filterInput = E('input', 'tfilter') as HTMLInputElement;
    filterInput.placeholder = 'filter by name or path';
    const filterBar = E('div', 'tfilterbar');
    filterBar.append(filterInput, sortBtn);
    const countEl = E('div', 'tcount2', '');
    const box = E('div');

    const backToAll: BackEntry = { label: 'all tools', open: () => openAllTools(s) };

    const renderRows = () => {
      const q = filterInput.value.toLowerCase();
      const source = sortByTime
        ? [...s.mainTools].sort((a, b) => (b.ms ?? -1) - (a.ms ?? -1))
        : [...s.mainTools].sort((a, b) => (b.ctx ?? 0) - (a.ctx ?? 0));
      const filtered = q
        ? source.filter((t) => t.name.toLowerCase().includes(q) || (t.arg || '').toLowerCase().includes(q))
        : source;
      countEl.textContent = q ? `${filtered.length} of ${source.length} calls` : `${source.length} calls`;
      box.replaceChildren();
      if (!filtered.length) {
        box.append(E('div', 'wdesc', q ? 'No tools match the filter.' : 'No tool output available yet.'));
      } else {
        for (const t of filtered) {
          const r = E('div', 'ttrow' + (t.error ? ' err' : ''));
          r.onclick = () => openTool(t, 'main session', backToAll);
          const nm = E('div', 'tn');
          nm.append(document.createTextNode(t.name + '  '));
          if (t.error) nm.append(E('span', 'terr', 'error'));
          const arg = E('span', 'targ');
          arg.textContent = t.arg || '';
          nm.append(arg);
          r.append(
            nm,
            E('div', 'tv', t.ms != null ? formatToolMs(t.ms) : '—'),
            E('div', 'tv', typeof t.ctx === 'number' ? kc(t.ctx) + 'ch' : '—'),
          );
          box.append(r);
        }
      }
    };

    filterInput.oninput = renderRows;
    sortBtn.onclick = () => {
      sortByTime = !sortByTime;
      sortBtn.textContent = sortByTime ? 'time ↓' : 'size ↓';
      renderRows();
    };

    renderRows();
    dbody.append(filterBar, countEl, block('All calls', box));
    openDrawer();
  }

  // The full changed-file list for the current scope, opened by the widget's Expand all
  // or its "+N more" row. Mirrors openAllTools' furniture (dhead → kpis → filter → rows) and
  // reuses its row classes so the two drawers read as one system. Rows are inert for now — the
  // per-file diff is a later card.
  function openAllFiles(): void {
    crumbs.length = 0;
    dbody.replaceChildren();
    renderCrumbs();
    // Both lists, from the same source as the card: repo files from git, scratchpad from the
    // ledger — the drawer is where "what did it change, and where" is the whole question.
    // Before the first answer there is nothing to list, and an empty list under a filter box reads
    // as "your filter matched nothing" — blaming a filter the user never set.
    if (!filesData) {
      dbody.append(dhead('files changed', 'main session', ['reading the repository…']));
      dbody.append(E('div', 'wdesc', 'Waiting for the repository to answer.'));
      openDrawer();
      return;
    }
    const repoFiles = filesInScope();
    const scratchList = scratchInScope();
    const files = [...repoFiles, ...scratchList];
    const scratchTotal = scratchList.length;
    const projectTotal = repoFiles.length;
    // Same split as the card, and for the same reason — but here EVERY group is listed: the
    // drawer is where "what did it write, and where" is the question. Project first.
    dbody.append(
      dhead('files changed', 'main session', [
        projectTotal + (projectTotal === 1 ? ' project file' : ' project files'),
        scratchTotal ? scratchTotal + ' scratchpad' : null,
      ]),
    );
    dbody.append(kpis(kpi('Project', String(projectTotal)), kpi('Scratchpad', String(scratchTotal))));

    const filterInput = E('input', 'tfilter') as HTMLInputElement;
    filterInput.placeholder = 'filter by path';
    const filterBar = E('div', 'tfilterbar');
    filterBar.append(filterInput);
    const countEl = E('div', 'tcount2', '');
    const box = E('div');

    // Type filter: one toggle chip per extension, ANDed with the text filter. Single-select —
    // clicking the active chip clears it — because the question is "show me just the X files",
    // not "compose a set". Same chip vocabulary as the widget, so the two read alike.
    let typeFilter: string | null = null;
    const typeBar = E('div', 'toolchips fchgtypes');
    const chipEls = new Map<string | null, HTMLElement>();
    const mkChip = (ext: string | null, label: string, n: number) => {
      const t = ext === null ? '' : tintOf(ext);
      const c = E('span', 'tchip clk' + (t ? ' ' + t : ''));
      c.append(document.createTextNode(label + ' '), E('b', null, String(n)));
      c.onclick = () => {
        typeFilter = typeFilter === ext ? null : ext;
        paintChips();
        renderRows();
      };
      chipEls.set(ext, c);
      typeBar.append(c);
    };
    const paintChips = () => {
      for (const [ext, el] of chipEls)
        el.classList.toggle('on', typeFilter === ext || (typeFilter === null && ext === null));
    };

    const renderRows = () => {
      const q = filterInput.value.toLowerCase();
      const filtered = files.filter(
        (f) => (typeFilter === null || extOf(f.base) === typeFilter) && (!q || f.path.toLowerCase().includes(q)),
      );
      const narrowed = q !== '' || typeFilter !== null;
      countEl.textContent = narrowed ? `${filtered.length} of ${files.length} files` : `${files.length} files`;
      box.replaceChildren();
      if (!filtered.length) {
        box.append(E('div', 'wdesc', 'No files match the filters.'));
        return;
      }
      // Grouped, project first. The headings track what is DISPLAYED, not what the session
      // contains: they name a separation, so a view holding only one group — a session whose
      // every change was a temporary, or a type filter that hid the other side — gets none.
      const groups = [
        ['Project', filtered.filter((f) => !f.scratch)],
        ['Scratchpad', filtered.filter((f) => f.scratch)],
      ] as const;
      // A heading names a SEPARATION, so it appears only when more than one group is on screen —
      // `every` would have been right with two groups and silently wrong with three (an empty
      // Outside group would have removed the Project/Scratchpad headings that do separate).
      const separated = groups.filter(([, list]) => list.length).length > 1;
      for (const [label, list] of groups) {
        if (!list.length) continue;
        if (separated) box.append(E('div', 'fchggrp', `${label} · ${list.length}`));
        for (const f of list) {
          const r = E('div', 'ttrow');
          const nm = E('div', 'tn');
          nm.append(E('span', tintOf(extOf(f.base)), f.base), document.createTextNode('  '));
          const dir = E('span', 'targ');
          dir.textContent = f.dir || '·';
          nm.append(dir);
          r.append(nm);
          box.append(r);
        }
      }
    };
    filterInput.oninput = renderRows;
    mkChip(null, 'all', files.length);
    for (const [ext, n] of extCounts(files)) mkChip(ext, ext || '—', n);
    paintChips();
    renderRows();
    // Provenance belongs HERE and not on the card: the ledger only ever sees what CC's own
    // file-writing tools touched (measured — a Bash-only write emits no delta), so the list can
    // under-report. On the card that caveat would sit under the hero total in every session,
    // including the ones with no shell write at all; the drawer is where the list itself is the
    // question being asked.
    dbody.append(
      filterBar,
      typeBar,
      countEl,
      blockD(
        'All changed files',
        "Project files come from git — the commits this session made, plus what is still uncommitted while it runs — so they include shell writes and build output. Scratchpad files are this session's temporaries, outside the repo, and only Claude Code's own ledger sees them.",
        box,
      ),
    );
    openDrawer();
  }

  // The complete activity list for the current scope, chronological. Mirrors openAllTools'
  // furniture (dhead → kpis → filter → rows) because it answers the same shape of question;
  // what differs is the SOURCE: the span store, which keeps every activity, where the feed
  // ring keeps only the last FEED_CAP per turn. Subagent rows are included — they live only
  // in the spawn lanes, so flattenActivity is what makes them reachable at all.
  function openAllActivity(): void {
    crumbs.length = 0;
    dbody.replaceChildren();
    renderCrumbs();

    const rows = flattenActivity(spanStore.snapshot(selectedTurn));
    const scopedTurn =
      selectedTurn !== null && lastSnap ? lastSnap.turnList.find((t) => t.index === selectedTurn) : null;
    const title = selectedTurn !== null ? entryTitle(lastSnap, scopedTurn) || 'Entry' : 'Session';
    dbody.append(dhead('activity', title, [rows.length + ' activities', selectedTurn === null ? 'all turns' : null]));

    // Build a stable chronological number for every row. The number is keyed by span id and
    // never changes when the user re-sorts or filters — "activity #42" stays #42.
    const activityIndex = new Map(rows.map((r, i) => [r.id, i + 1]));

    // Build turn label map for the turn separators. Prefer the TreeSnapshot's formatted label
    // ("Turn 7", "/compact") because it uses the correct work-ordinal; fall back to the span
    // store's title string for any turn not yet in the TreeSnapshot.
    const turnLabelMap = new Map<number, string>();
    if (lastSnap) {
      for (const t of lastSnap.turnList) {
        turnLabelMap.set(t.index, entryTitle(lastSnap, t) || entryLabel(t));
      }
    }

    const tools = rows.filter((r) => r.type === 'tool' || r.type === 'subspan').length;
    const calls = rows.filter((r) => r.type === 'api').length;
    const elapsed = rows.length ? rows[rows.length - 1]!.t0 - rows[0]!.t0 : 0;
    dbody.append(
      kpis(
        kpi('Activities', String(rows.length)),
        kpi('Tool calls', String(tools)),
        kpi('API calls', String(calls)),
        kpi('Elapsed', formatToolMs(elapsed)),
      ),
    );

    // Oldest-first by default: this is a chronological reading of what happened, not the
    // feed's "what just changed" — the latter is what the card itself already shows.
    let oldestFirst = true;
    const sortBtn = E('button', 'tsort', 'oldest ↓');
    const filterInput = E('input', 'tfilter') as HTMLInputElement;
    filterInput.placeholder = 'filter by name or argument';
    const filterBar = E('div', 'tfilterbar');
    filterBar.append(filterInput, sortBtn);
    const countEl = E('div', 'tcount2', '');
    const box = E('div');

    const backToList: BackEntry = { label: 'all activity', open: () => openAllActivity() };

    const renderRows = () => {
      const q = filterInput.value.toLowerCase();
      const ordered = oldestFirst ? rows : [...rows].reverse();
      const filtered = q ? ordered.filter((r) => activityMatches(r, q)) : ordered;
      countEl.textContent = q ? `${filtered.length} of ${rows.length} activities` : `${rows.length} activities`;
      box.replaceChildren();
      if (!filtered.length) {
        box.append(E('div', 'wdesc', q ? 'No activity matches the filter.' : 'No activity in this scope yet.'));
        return;
      }
      const t0 = rows.length ? rows[0]!.t0 : 0;
      // Turn separators: track the last seen turnIndex and emit a divider on change.
      // Skipped when scoped to one turn (all rows share the same index, so no boundary fires).
      let lastTurnIdx: number | null = null;
      for (const r of filtered) {
        if (selectedTurn === null && r.turnIndex !== lastTurnIdx) {
          lastTurnIdx = r.turnIndex;
          const label = turnLabelMap.get(r.turnIndex) ?? 'Entry ' + r.turnIndex;
          box.append(E('div', 'turn-sep', label));
        }
        const row = E('div', `ttrow t-${r.type}` + (r.lane > 0 ? ' lane' : '') + (r.status === 'error' ? ' err' : ''));
        const nm = E('div', 'tn');
        nm.append(E('span', 'tnum', '#' + (activityIndex.get(r.id) ?? 0)));
        nm.append(document.createTextNode(r.name));
        if (r.status === 'error') nm.append(E('span', 'terr', 'error'));
        if (r.agent) nm.append(E('span', 'aagent', r.agent));
        if (r.detail) nm.append(E('span', 'targ', r.detail));
        // 'running…' is reserved for spans that ARE running. A span closed within the same
        // millisecond it opened has no duration to report and shows '—' instead: rendering
        // that as running is a lie the fixtures never showed, carrying only timed tool spans.
        const dur = E('div', 'tv');
        const durText = r.status === 'running' ? toolDuration(null, ended) : r.ms != null ? formatToolMs(r.ms) : '—';
        dur.append(E('span', r.status === 'running' ? 'run' : null, durText));
        row.append(nm, dur, E('div', 'tv', formatOffset(r.t0 - t0)));
        // Same router the Trace uses, so a row here opens exactly the drawer its span does.
        // Unlike the Trace, this list IS the drawer and is replaced by the drill-down, so it
        // hands over a way back — otherwise the user has to reopen it and re-find their place.
        if (r.handle) {
          const h = r.handle;
          row.onclick = () => openBlock(h, backToList);
        }
        box.append(row);
      }
    };

    filterInput.oninput = renderRows;
    sortBtn.onclick = () => {
      oldestFirst = !oldestFirst;
      sortBtn.textContent = oldestFirst ? 'oldest ↓' : 'newest ↓';
      renderRows();
    };

    renderRows();
    dbody.append(filterBar, countEl, block('All activity', box));
    openDrawer();
  }

  // ---- expand toggles ----
  liveExpand.onclick = openAllActivity;
  toolsExpand.onclick = () => {
    const full = state.snapshot();
    openAllTools(selectedTurn !== null ? scopeToTurn(full, selectedTurn) : full);
  };
  // No snapshot needed: the list comes from the server's answer, which is already scoped by the
  // selected turn inside filesInScope.
  filesExpand.onclick = () => openAllFiles();

  // ---- Commits: the session's own commits, joined server-side from git + this transcript ----
  // Session-scoped, NOT turn-scoped: a commit is attributed to the session, and the turn it
  // landed in is not something the attribution establishes.
  let commitsData: SessionCommits | null = null;
  function openAllCommits(): void {
    if (!commitsData?.commits.length) return;
    crumbs.length = 0;
    dbody.replaceChildren();
    renderCrumbs();
    dbody.append(
      dhead('commits', 'main session', [
        commitsData.commits.length + (commitsData.commits.length === 1 ? ' commit' : ' commits'),
        commitsData.remote ? commitsData.remote.replace(/^https:\/\//, '') : 'no remote',
      ]),
    );
    dbody.append(commitsList(commitsData.commits));
    openDrawer();
  }
  commitsExpand.onclick = openAllCommits;

  /**
   * Fetch the commits and show or hide the card accordingly. Called once the replay has handed
   * off, then every REFRESH_MS while the session is live and once when it ends — a commit is a
   * rare event, so polling this slowly costs nothing and keeps the card true without an event
   * the transcript does not carry.
   */
  function refreshCommits(): void {
    if (!loadCommits) return;
    loadCommits().then((data) => {
      // Shape-checked, not just null-checked: a proxy or a stale server can answer 200 with
      // something else, and the page must not break over a card. `destroyed` first — see it.
      if (destroyed || !data || !Array.isArray(data.commits)) return;
      commitsData = data;
      commitsExpand.hidden = data.commits.length === 0;
      renderCommitsCard(commitsHost, data, openAllCommits);
    });
  }

  // ---- Cards: the tracker cards this session worked on, from its own tool calls ----
  // Session-scoped like Commits, and for the same reason: a card is worked on across a session,
  // not inside one turn. Unlike a commit it is NOT exclusive — several sessions may share it.
  let cardsData: SessionCards | null = null;
  function openAllCards(): void {
    if (!cardsData?.cards.length) return;
    crumbs.length = 0;
    dbody.replaceChildren();
    renderCrumbs();
    const wrote = cardsData.cards.filter((c) => c.evidence === 'wrote').length;
    dbody.append(
      dhead('cards', 'main session', [
        cardsData.cards.length + (cardsData.cards.length === 1 ? ' card' : ' cards'),
        `${wrote} changed`,
      ]),
    );
    dbody.append(cardsList(cardsData.cards));
    openDrawer();
  }
  cardsExpand.onclick = openAllCards;

  function refreshCards(): void {
    if (!loadCards) return;
    loadCards().then((data) => {
      if (destroyed || !data || !Array.isArray(data.cards)) return;
      cardsData = data;
      cardsExpand.hidden = data.cards.length === 0;
      renderCardsCard(cardsHost, data, openAllCards);
    });
  }

  // ---- Changed files: the three witnesses, joined server-side (see docs/changed-files.md) ----
  let filesData: SessionFiles | null = null;
  // What the ledger held when the last fetch went out. A delta is the only on-transcript signal
  // that the file set moved, so it is what asks for a fresh answer — the commit and worktree
  // witnesses have no event at all and would otherwise wait for the 60s beat.
  let filesFetchedAt = -1;

  function refreshFiles(): void {
    if (!loadFiles) return;
    filesFetchedAt = lastSnap?.filesChanged.length ?? 0;
    loadFiles().then((data) => {
      if (destroyed || !data || !Array.isArray(data.files)) return;
      filesData = data;
      // scheduleRender, never render(): a direct paint bypasses the `live` guard and would draw the
      // whole bento mid-replay, which is the freeze that guard exists to prevent.
      scheduleRender();
    });
  }

  /**
   * Ask for a fresh answer when the ledger moved since the last one — debounced, because a turn
   * writes its deltas in a burst and each of them would otherwise cost a scan plus a `git status`.
   * The 60s beat still covers the witnesses no transcript event announces (a commit, a shell write
   * in a live session); this only makes the common case feel immediate.
   */
  let filesDebounce: ReturnType<typeof later> | null = null;
  function maybeRefreshFiles(): void {
    if (!loadFiles || !live || filesDebounce) return;
    if ((lastSnap?.filesChanged.length ?? 0) === filesFetchedAt) return;
    // `later`, not a raw setTimeout: it registers the timer for destroy(). A stray one fires on a
    // torn-down graph, and its render() restarts the 1s ticker that stopTicker() had just cleared —
    // a permanent tick over detached DOM, one per tab closed inside the window.
    filesDebounce = later(() => {
      filesDebounce = null;
      refreshFiles();
    }, 1500);
  }

  /**
   * Set by `destroy()`, and the reason the three card fetches above check it.
   *
   * Cancelling the timers is not enough: a request already in flight has no timer to cancel, so
   * its `.then()` runs whenever the network answers — after the tab was closed, after `destroy()`
   * emptied the container. Each of those three continuations BUILDS a card
   * (`document.createElement`), so it is not the harmless orphan-filling the drawer's fetches
   * deliberately allow: it renders a whole card into a host nothing owns any more.
   *
   * It surfaced as a test that failed only in CI — the async render outliving the harness that had
   * taken the document away — but the leak is the page's, not the test's.
   */
  let destroyed = false;

  /** Both are read on the same beat: one card is rare, both together are rarer still. */
  function refreshOutput(): void {
    refreshCommits();
    refreshCards();
    refreshFiles();
  }
  const COMMITS_REFRESH_MS = 60_000;
  let commitsTimer: ReturnType<typeof setInterval> | null = null;

  // ---- toasts: one per new tool / subagent, cyan (subagent icon purple),
  //      auto-dismiss 5s, max 5 stacked. Shift left when the drawer is open. ----
  // Subagent toasts linger (5s) — a spawn is the signal worth reading (agentType + model).
  // Tool toasts are transient (1.5s): high-frequency, low individual value.
  const MAX_SUB_TOASTS = 5,
    MAX_TOOL_TOASTS = 5,
    TOAST_SUB_MS = 5000,
    TOAST_TOOL_MS = 1500;
  // The announce layer (a crit verdict, a pending approval): it must linger long enough to
  // READ, unlike a tool toast that just flickers what is happening now.
  const TOAST_ANNOUNCE_MS = 8000;
  // ROUTING, not suppression: `Agent` IS a subagent spawn and already gets the richer
  // subagent toast on the bottom rail (type + model), so a bare "Agent" toast up here
  // would be a dup. That is the ONLY reason a tool is excluded — every other tool toasts.
  // Six bookkeeping tools used to sit here as "high-frequency, fires in bursts". Measured
  // over the real logs, that was true of ONE (TaskCreate: 58% of gaps <2s) and false of the
  // rest — ToolSearch and TaskList are ~1 call per session, TaskGet and TodoWrite are never
  // called at all. The list had been written by name analogy, not from data — so it went
  // (2026-07-16), and a bookkeeping tool now toasts like any other.
  const TOAST_NOISE = new Set(['Agent']);
  // Subagent toasts still on screen whose model was unknown at spawn, by agentId. Entries are
  // dropped in dismiss(), so a model landing after the toast has gone touches nothing.
  const subToastModels = new Map<string, { node: ToastNode; line: HTMLElement }>();
  // Timers are tracked so destroy() can cancel the pending ones — so each must drop itself
  // from the set once it has fired, or the set grows for the whole life of the tab.
  const timers = new Set<ReturnType<typeof setTimeout>>();
  function later(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
    return t;
  }
  function pushToast(ev: {
    sub?: boolean;
    name: string;
    arg?: string | null;
    sev?: 'warn' | 'crit';
    kind?: string;
    agentId?: string;
    model?: string | null;
  }): void {
    const t = E('div', 'toast' + (ev.sub ? ' sub' : '') + (ev.sev ? ' v-' + ev.sev : ''));
    const icon = E('div', 'ticon', ev.sub ? '⑃' : ev.sev ? '⚠' : '›');
    const main = E('div', 'tmain');
    main.append(E('div', 'tname', ev.name));
    if (!ev.sub && ev.arg) {
      main.append(E('div', 'targ2', ev.arg));
    }
    // Which model a spawn runs on is the one thing a type-only toast cannot say, and it is
    // NOT inferable from the session's model: measured over ~1600 real subagents, 74.6% run
    // on a different family than their parent. The line is ALWAYS rendered on a subagent
    // toast, even before the model is known, so filling it later cannot resize the toast.
    if (ev.sub) {
      const mdl = E('div', 'tmodel', shortModel(ev.model) || ' ');
      main.append(mdl);
      // 30.1% of spawns declare no model — it is knowable only once the child writes its
      // first line (p50 3.2s, inside the toast's 5s life), so the live toast is kept
      // addressable by agentId and filled by syncSubToastModels on the next render.
      if (ev.agentId && !ev.model) subToastModels.set(ev.agentId, { node: t as ToastNode, line: mdl });
    }
    t.append(icon, main, E('div', 'tkind', ev.kind ?? (ev.sub ? 'agent' : ev.sev ? 'verdict' : 'tool')));
    // Two rails: subagents on the bottom horizontal row, tools + verdicts on the top column.
    const rail = ev.sub ? subToasts : toasts;
    // The oldest toast is firstChild in BOTH rails: `row-reverse` on the bottom rail flips
    // the visual order (newest rightmost), not the DOM order. Evicting lastChild there was
    // dropping the toast just appended — past 5 concurrent spawns, no toast appeared at all.
    rail.append(t);
    const max = ev.sub ? MAX_SUB_TOASTS : MAX_TOOL_TOASTS;
    while (rail.children.length > max) dismiss(rail.firstChild as ToastNode | null, true);
    later(() => dismiss(t as ToastNode, false), ev.sev ? TOAST_ANNOUNCE_MS : ev.sub ? TOAST_SUB_MS : TOAST_TOOL_MS);
  }
  // The crit verdict's one-line announce — the worst finding, plus a count of the rest.
  function verdictHeadline(v: TurnVerdict): string {
    const lead = v.findings.find((f) => f.severity === 'crit') ?? v.findings[0];
    if (!lead) return '';
    return v.findings.length > 1 ? `${lead.text}  (+${v.findings.length - 1} more)` : lead.text;
  }
  /**
   * Fill the model line of every live subagent toast whose model has since been resolved.
   * Reads the FULL snapshot: a toast belongs to the spawn, not to the turn being viewed.
   */
  function syncSubToastModels(full: TreeSnapshot): void {
    if (!subToastModels.size) return;
    for (const a of full.subagents || []) {
      const slot = a.agentId ? subToastModels.get(a.agentId) : undefined;
      if (!slot || !a.model) continue;
      slot.line.textContent = shortModel(a.model);
      subToastModels.delete(a.agentId);
    }
  }
  function dropToastSlot(node: ToastNode): void {
    for (const [agentId, slot] of subToastModels) if (slot.node === node) subToastModels.delete(agentId);
  }
  function dismiss(node: ToastNode | null, now: boolean): void {
    if (!node) return;
    dropToastSlot(node);
    // A forced eviction must remove the node even mid-fade. Bailing out on `_dismissed`
    // here froze the tab: a toast fading out is still a child for 320ms, so the eviction
    // loop kept picking it, never removing it, and `children.length` never fell below the cap.
    if (now) {
      node.remove();
      return;
    }
    if (node._dismissed) return;
    node._dismissed = true;
    node.classList.add('out');
    later(() => node.remove(), 320);
  }

  // Toasts must fire only for LIVE events, never for the replay flood that rebuilds
  // history on mount. `goLive()` is called by the caller at the real replay-end
  // handoff (not a wall-clock guess, which floods when a large session's replay runs
  // long). A closed session never replays-to-live, so it never arms → never toasts.
  // `seenSubagents` de-dupes the per-line subagent-meta events.
  let toastsArmed = false;
  // Painting is off until the session's history is in `state` (see goLive()).
  let live = !opts.loading;
  const seenSubagents = new Set<string>();
  const offEvent = state.onEvent((e: NormalizedEvent, ctx: EventContext) => {
    // A subagent's first meta event (de-duped: meta fires twice per child). Used for
    // the toast only — NOT the feed: the spawn is already in the feed as the parent's
    // `Agent` tool-start (which carries a real timestamp), whereas subagent-meta is
    // out-of-band (seq -1, empty timestamp) and would sort to a wrong time.
    // Fire on any new agentId, not only when agentType is truthy — if the sidecar
    // meta.json is absent, agentType is null, but the agent still deserves a toast.
    const isFirstSpawn = e.type === 'subagent-meta' && e.agentId != null && !seenSubagents.has(e.agentId);
    // The redundant e.agentId != null lets TypeScript narrow agentId to string (isFirstSpawn already implies this).
    if (isFirstSpawn && e.agentId != null) seenSubagents.add(e.agentId);

    // Feed the span-store so the Trace modal has up-to-date data on every event.
    spanStore.apply(e, ctx);
    // If the modal is open, coalesce updates into one rAF so event bursts don't thrash the
    // render. One pending rAF at a time — the flag is cleared by the scheduled callback.
    if (trace && trace.isOpen()) {
      if (!traceRafPending) {
        traceRafPending = true;
        const _trace = trace; // capture: trace is checked non-null above; closures don't narrow mutable vars
        requestAnimationFrame(() => {
          traceRafPending = false;
          _trace.update(spanStore.snapshot(selectedTurn), ended);
        });
      }
    }

    // The live feed keeps the 10 most-recent-BY-TIMESTAMP tool activities (main +
    // subagent), so on load it shows the session's genuinely latest events and new
    // live ones sort in by time. A tool row's duration fills at its tool-end. An
    // `Agent` tool-start IS the spawn — labelled below, with its real timestamp.
    if (e.type === 'usage' && ctx?.newCall) {
      const evTs = tsMs(e.timestamp);
      // One row per API call (ctx.newCall folds the per-content-block repeat), emitted before
      // the tools that call decided — its usage line precedes them, so timestamp order gives
      // the call→tools shape. `arg` is the reducer-resolved input hint; the drawer fetches the
      // full input/output/model/usage on click. A row with no callId (synthetic error line)
      // still shows, but its drawer has nothing to fetch.
      feed.push({
        apiCall: true,
        callId: e.callId ?? null,
        name: 'API call',
        arg: ctx?.label ?? null,
        sub: e.agentId != null,
        turnIndex: ctx?.turnIndex ?? null,
        ts: evTs ?? 0,
        startMs: evTs,
        ms: ctx?.callMs ?? null,
        error: Boolean(e.apiError),
        errorMessage: e.apiError?.message ?? null,
      });
      if (live) renderFeed();
    } else if (e.type === 'tool-start') {
      const evTs = tsMs(e.timestamp);
      // turnIndex comes from the reducer (the event itself carries no turn): for a
      // subagent's tool it is the turn that SPAWNED the subagent, so an async subagent's
      // work stays attributed to the turn that asked for it.
      feed.push({
        id: e.id,
        name: e.name,
        arg: ctx?.label ?? null,
        sub: e.agentId != null,
        spawn: SPAWN_TOOL_NAMES.has(e.name),
        subagentType: e.subagentType,
        launchPrompt: e.launchPrompt ?? null,
        turnIndex: ctx?.turnIndex ?? null,
        ts: evTs ?? 0,
        startMs: evTs,
        ms: null,
      });
      // The ring still absorbs the replay (so the feed opens with the session's real tail),
      // but it is not drawn until we go live — see the `live` guard on scheduleRender.
      if (live) renderFeed();
    } else if (e.type === 'tool-end') {
      const changed = feed.end(e.toolUseId, e.timestamp, e.error);
      // A background launch receipt: mark the row so its notification, which may be a turn or
      // two away, can be recognised as this command's outcome. Nothing to repaint for — the row
      // looks the same until that outcome lands.
      if (e.background) feed.mark(e.toolUseId);
      if (changed && live) renderFeed();
    } else if (e.type === 'agent-end' && e.toolUseId) {
      // The outcome of a background command. Rows are retained PER TURN, so the launch row is
      // usually still in the ring even though the notification lands in a later turn.
      const clean = e.status === null || e.status === 'completed' || e.status === 'stopped';
      const line = e.summary === null ? null : outcomeLine(e.summary);
      if (feed.outcome(e.toolUseId, !clean, line) && live) renderFeed();
    }

    // Toasts fire only once live (after replay-end), and only for meaningful tools.
    if (!toastsArmed) return;
    if (e.type === 'tool-start' && e.agentId == null && !TOAST_NOISE.has(e.name))
      pushToast({ name: e.name, arg: ctx?.label ?? null });
    else if (isFirstSpawn && e.type === 'subagent-meta') {
      // agentType is known at the birth event (it comes from the sidecar meta), so the
      // toast fires immediately — no deferral needed. The redundant type check lets TS narrow e.
      // The model comes from the reducer, not from the event: it resolves the child's own model
      // against the spawn's declared one, which is where 69.9% of spawns already have it. When
      // neither is known yet, the toast still fires now and fills in (syncSubToastModels) —
      // waiting for it was tried in 2026-07 and removed, because the wait cost real latency.
      // `lastSnap` is the last PAINTED snapshot, and the spawn being announced is by definition
      // newer than it — so when it comes up empty, ask the reducer for its current state. That
      // is one snapshot per spawn (measured: 773 spawns across 400 real sessions, and only on
      // the branch that needs it), against a blank line on a model that was already known.
      // Whether it helps is a race, measured on the real stream: Claude Code writes the child's
      // sidecar BEFORE the parent's assistant line, so the meta event usually arrives 0.6-2.7s
      // ahead of the tool-start that carries `spawnModel` (4 of 6 spawns) and nothing can name
      // the model yet. In the other 2 the tool-start landed first and this fills at birth.
      const known =
        e.model ??
        (lastSnap?.subagents || []).find((a) => a.agentId === e.agentId)?.model ??
        (state.snapshot().subagents || []).find((a) => a.agentId === e.agentId)?.model ??
        null;
      pushToast({ sub: true, name: e.agentType ?? 'agent', agentId: e.agentId ?? undefined, model: known });
    } else if (e.type === 'turn-end' && e.agentId == null) {
      // Announce: the verdict of the turn that just closed. CRIT only — warn stays silent
      // in the toast and lives on the Timeline (Verdict lens); good is silent. Measured over 2798
      // real turns, crit is 9.4% — about 1 in 11, which is why this is a non-blocking toast,
      // never a modal.
      //
      // The turn that ended is the LAST non-live one, whatever its kind. Asking for the last
      // non-live *work* turn was wrong: a `/clear` (kind 'context') or a `/model` (kind 'local')
      // writes its own `system/turn_duration` — measured on the real corpus — so those turn-ends
      // skipped past themselves and re-announced the previous work turn. `announced` is the
      // second half of the guard: an announce belongs to a turn index, once.
      const snap = state.snapshot();
      const ended = snap.turnList.filter((t) => t.state !== 'live').at(-1);
      if (ended && ended.kind === 'work' && !announced.has(ended.index)) {
        const v = computeVerdict(ended, snap);
        announced.add(ended.index);
        if (v.severity === 'crit')
          pushToast({ name: 'Verdict · turn #' + ended.index, arg: verdictHeadline(v), sev: 'crit' });
      }
    }
  });

  // Kick the personal-baseline fetch (shared across graphs). The re-render is for the surfaces
  // that show the baseline itself (the share card's p50/p90/p95 scale) — no verdict depends on
  // it, so nothing here changes severity.
  ensureBaseline(() => render());

  // `onChange` already hands us the snapshot it just built; rebuilding it here would run
  // buildTurnList() (O(turns × agents)) a second time for every single event.
  function render(full: TreeSnapshot = state.snapshot()): void {
    lastSnap = full;
    // ONE verdict pass per render, for every turn. Recomputing per surface was O(turns × tools)
    // on each event; `computeVerdicts` indexes the snapshot once and is what every surface reads.
    verdicts = computeVerdicts(full);
    liveCounters = []; // the previous render's counters are about to be replaced
    nowTickArmed = false;
    const s = selectedTurn !== null ? scopeToTurn(full, selectedTurn) : full;
    // The Session card's footer always uses the full snapshot — it is the turn navigator.
    renderCtx(s.main);
    renderTokenUsage(s, full);
    renderSkills(s);
    renderCommands(s);
    renderSubLive(s, full);
    renderTools(s);
    renderFiles(s);
    renderSubs(s);
    syncSubToastModels(full);
    renderTurnExplorer(full);
    renderScopeBanner(full);
    // The feed's ROWS come from its own ring (onEvent), but its scope and header follow
    // the selection, so it must redraw here too — not only when an event arrives.
    renderFeed();
    // The intent panel rides the full render (not the cheap onEvent feed refresh) so its age
    // counter is pushed after liveCounters was cleared and before syncTicker reads it.
    renderNowPanel();
    // After the DOM exists: the ticker runs only while this render left a live counter in it.
    syncTicker();
  }
  // The view mounts BEFORE the replay runs, so it is subscribed for the whole flood: a large
  // session replays ~10k events, and redrawing the entire bento (one DOM bar per timeline
  // entry, one card per subagent) on each of them froze the tab exactly at open — the moment
  // the product is judged. Two guards, and BOTH are needed:
  //   `live` — during the initial replay we paint NOTHING. The tab shows its loader instead;
  //            a bento assembling itself card by card for seconds is not a load, it's a lie.
  //   coalescing — once live, many events still collapse into one paint. setTimeout and not
  //            rAF, because rAF is paused in a backgrounded tab, which is where seedeep lives.
  let renderScheduled = false;
  function scheduleRender() {
    if (!live || renderScheduled) return;
    renderScheduled = true;
    later(() => {
      renderScheduled = false;
      render();
    }, 0);
  }
  const off = state.onChange(scheduleRender);
  if (live) render();

  return {
    // Called once the initial replay has ended (the replay→live handoff): paints the
    // finished session in ONE pass and arms live-only toasts. The feed is NOT cleared:
    // it keeps the session's last events (from the replay tail) so a refresh shows recent
    // history, with new live events pushing in on top.
    goLive() {
      toastsArmed = true;
      if (live) return;
      live = true;
      render();
      refreshOutput();
      if (!ended && !commitsTimer) commitsTimer = setInterval(refreshOutput, COMMITS_REFRESH_MS);
    },
    /**
     * The session is (or is no longer) stopped on a prompt only the user can clear —
     * app.ts reads it off the roster poll. Announces the transition ONCE with a toast, and
     * keeps saying it in the NOW panel for as long as it lasts: the toast is for whoever is
     * looking now, the panel for whoever arrives later (a tab switch outlives any toast).
     */
    setWaiting(kind: PendingKind | null, since: number | null) {
      if (kind === waiting) return;
      const entering = kind !== null && waiting === null;
      waiting = kind;
      waitingSince = kind === null ? null : since;
      if (entering && toastsArmed && !ended) {
        const tool = pendingTool();
        pushToast({
          name: kind === 'permission' ? 'Waiting for your approval' : 'Waiting for your answer',
          arg: tool ? `${tool.name}${tool.arg ? ' · ' + tool.arg : ''}` : null,
          sev: 'warn',
          kind: 'pending',
        });
      }
      scheduleRender();
    },
    // The session's process is gone (app.ts watches the roster): freeze into the ended
    // presentation. One-way by design — a reopened session arrives as a new tab.
    setBusy(working: boolean) {
      if (working === busy) return;
      busy = working;
      // A FULL render, like setWaiting: `busy` feeds the strip's `lv` class and the banner's live
      // counter as well as the panel. Redrawing only the panel left an idle session's bar green
      // and its counter ticking forever — an idle session writes no further event to correct it.
      scheduleRender();
    },
    setEnded() {
      if (ended) return;
      ended = true;
      root.classList.add('ended');
      scheduleRender(); // coalesces with any state events landing in the same tick
      // One last read: the final commits of a session usually land in its last minute.
      if (commitsTimer) {
        clearInterval(commitsTimer);
        commitsTimer = null;
      }
      refreshOutput();
    },
    destroy() {
      // FIRST, before anything is unwired: what cannot be cancelled has to be told to do nothing.
      destroyed = true;
      off();
      offEvent();
      if (commitsTimer) clearInterval(commitsTimer);
      for (const t of timers) clearTimeout(t);
      stopTicker();
      stopWatchingPrompt();
      document.removeEventListener('keydown', onKey);
      // Release the page scroll-lock if this tab is torn down with its drawer open,
      // so the shared counter never leaks (which would freeze the page permanently).
      if (drawer.classList.contains('on')) unlockPageScroll();
      // Remove trace's window listeners; each tab creates its own controller so they
      // must be torn down with the tab, not left as permanent page-level listeners.
      if (trace) trace.destroy();
      container.replaceChildren();
    },
    // TEST-ONLY: direct entry-point for openBlock so unit tests can assert subagent/call
    // routing without wiring up full trace-DOM click paths. Not part of the public API.
    _openBlock: openBlock,
  };
}
