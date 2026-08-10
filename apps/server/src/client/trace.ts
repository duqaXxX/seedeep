/**
 * Trace render module — near-fullscreen modal + flow diagram.
 *
 * Browser ES module, bundled from src/client into public/lib/app.js. Imported by graph.ts.
 * Reads a TraceSnapshot produced by span-store.ts; renders a vertically scrolled spine of
 * turn rows, each expanding in place into its own horizontally scrolled strip, grouped by
 * the hybrid rule (rounds → capped chapters, landmarks visible), with merged spawn blocks
 * and parallel child lanes sharing the strip's scroller.
 *
 * The spine is a DOCUMENT, not a 2D canvas: the turn rows are a list, and a list that
 * scrolls natively gets a scrollbar, the wheel, the keyboard and the browser's own find
 * for free. The canvas cost all four (the wheel was bound to zoom, so a two-finger scroll
 * zoomed and a horizontal swipe zoomed OUT), and bought only the freedom to place a turn's
 * strip to the RIGHT of its header — which then forced the connector to the next turn to
 * travel back across the whole canvas as a diagonal up to ~1400px long. Putting the strip
 * BELOW its header removes the diagonals by construction: the next row is always at x=0.
 *
 * @module trace
 */

import type {
  DrawerHandle,
  SpanType,
  TraceLane,
  TraceSnapshot,
  TraceSpan,
  TraceSpawn,
  TraceTurn,
} from '../core/span-store.ts';
import type { GroupItem } from '../core/trace-group.ts';
import { groupPathToSpan, groupTurnSpans, itemMs, leafSpans } from '../core/trace-group.ts';
import { stripMarkdown } from '../core/tree-format.ts';

// ── Internal model types ──────────────────────────────────────────────────────

/** Rendered lane entry built by adaptSnapshot from a TraceLane. */
type LaneEntry = {
  subspan: {
    id: string;
    type: 'subspan';
    label: string;
    agent: string;
    agentId: string | null | undefined;
    status: string;
    t0: number;
    t1: number;
    lane: number;
  };
  spans: TraceSpan[];
  toolCount: number;
};

/** One spawn-group within a TurnModel: the spawn span + its optional store entry + rendered lanes. */
type SpawnGroup = {
  spawnSpan: TraceSpan;
  spawnGroup: TraceSpawn | null;
  lanes: LaneEntry[];
};

/** Per-turn render model, output of adaptSnapshot. */
type TurnModel = {
  turn: TraceTurn;
  api: number;
  tool: number;
  skill: number;
  /** True when the turn or ANY of its child lanes holds a failed span. */
  hasError: boolean;
  /** How many spans failed, main strip and child lanes together. */
  failed: number;
  /** A control command that ran no work (`/clear`, `/model`) — rendered as one line. */
  isIdle: boolean;
  /**
   * Working right now. `state === 'live'` alone is not enough: a finished session still
   * reports it on every turn it never closed (16 of 144 in one measured session), all of
   * them empty — so real work has to be present too.
   */
  isLive: boolean;
  ms: number;
  spawnGroups: SpawnGroup[];
  path: TraceSpan[];
};

/** Per-segment DOM record held in _segs. Built in build(); extended in buildBody(). */
type SegRecord = {
  seg: HTMLElement;
  thead: HTMLElement;
  tbody: HTMLElement;
  built: boolean;
  m: TurnModel;
  i: number;
  dflow?: HTMLElement;
  /** The per-turn horizontal scroller holding both the strip and its open lanes. */
  scroller?: HTMLElement;
  lanesBox?: HTMLElement;
  _spawnEls?: Map<string, HTMLElement>;
  /** span id → its rendered block, main strip and lanes alike; used to jump to a failure. */
  _stepEls?: Map<string, HTMLElement>;
  _laneWraps?: Array<{ spawnEl: HTMLElement; wrap: HTMLElement }>;
};

/** Where one failed span lives, and what has to be opened to reveal it. */
type FailTarget = {
  spanId: string;
  /** Namespace of its strip: '' for the main one, `lane:<spawnId>:<agentId>:` for a lane. */
  ns: string;
  /** Set when the failure is inside a child lane — that spawn must be unfolded first. */
  spawnSpanId: string | null;
};

/** Opts accepted by createTrace. */
type TraceOpts = { onBlock?: (handle: DrawerHandle) => void };

/** HTMLSpanElement extended with the expand/collapse callback written by renderItem(). */
type TraceHolder = HTMLSpanElement & { _traceSetOpen?: (want: boolean) => void };

/** HTMLDivElement extended with in-place state for the spawn sub-line sync in toggleLane(). */
type TraceSpawnEl = HTMLDivElement & {
  _traceSsBase?: string | null;
  _traceHints?: { openHint: string; closedHint: string };
};

// Maps SpanType → CSS custom-property name for the span category colour.
const CATV = {
  prompt: '--sp-prompt',
  api: '--sp-api',
  tool: '--sp-tool',
  skill: '--sp-skill',
  spawn: '--sp-spawn',
  subspan: '--sp-spawn',
  result: '--sp-result',
};

// A turn's left rule carries its STATE, not its index. The previous golden-ratio hue
// cycle spent the scarcest signal on information already spelled out ("T7"), and landed
// on the error colour twice: thColor(0) is hsl(0) and thColor(13) is hsl(348), against
// --sp-error at hsl(351) — two turns per cycle wore "failed" as decoration.

// Theme variables are constants for the page's lifetime; memoized because cssv
// is hit once per block/dot on every rebuild (~300+ getComputedStyle calls per
// live event batch on a big turn without the cache).
const _cssCache = new Map<string, string>();
function cssv(n: string): string {
  if (_cssCache.has(n)) return _cssCache.get(n)!; // ! proven: .has(n) === true
  let v = '';
  if (typeof getComputedStyle !== 'undefined' && typeof document !== 'undefined') {
    try {
      v = getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    } catch {
      v = '';
    }
  }
  _cssCache.set(n, v);
  return v;
}

function fmtDur(ms: number): string {
  if (ms < 1000) return ms + 'ms';
  const s = ms / 1000;
  if (s < 60) return (s < 10 ? s.toFixed(1) : Math.round(s)) + 's';
  const m = Math.floor(s / 60),
    r = Math.round(s % 60);
  return m + 'm' + (r ? ' ' + r + 's' : '');
}

function short(s: string | null | undefined, n: number): string {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** First non-empty line of a string — an intent's opening sentence, without its markdown body. */
function firstLine(s: string): string {
  for (const line of s.split('\n')) {
    const t = line.trim();
    if (t) return t;
  }
  return '';
}

// The strip prints these counts on every group block, so "1 steps" was visible hundreds
// of times per session.
const plural = (n: number, w: string): string => n + ' ' + w + (n === 1 ? '' : 's');

// Slots in a collapsed row's sparkline. Fixed, so every row's bar is comparable.
const SPARK_BINS = 30;

// Which type a bin shows when it holds several. Ordered by how much the reader learns
// from it: a spawn or a skill is a landmark of that stretch, a tool is the work itself,
// and an api call is the connective tissue between them — present in every round by
// construction, so it only wins a bin that holds nothing else.
const SPARK_RANK = ['spawn', 'skill', 'tool', 'result', 'prompt', 'api'] as const;

/**
 * One sparkline bin's stacked composition, in draw order: the error band first, then every
 * type present, weighted by its share of the bin's SUCCESSFUL steps.
 *
 * The weights sum to 1, and that is the contract, not a detail. A linear-gradient holds its
 * last colour past its last stop, so a composition that closes early is not a shorter bar —
 * it is the LAST type silently absorbing the remainder, invisibly. Subtracting the error
 * band from each type in turn (rather than once) did exactly that: three equal types drew
 * 33 / 22 / 44 and stopped at 77.8%.
 *
 * A failing bin's red band never drops below a third: one bad step among six must still show.
 *
 * @param slice - the bin's spans, in strip order
 * @returns `{key, weight}` per band; `key` is `'err'` or the span type; weights total 1
 *   (empty when the bin holds nothing)
 */
export function binComposition(slice: TraceSpan[]): Array<{ key: 'err' | SpanType; weight: number }> {
  const failed = slice.filter((s) => s.status === 'error').length;
  const errW = failed ? Math.max(0.34, failed / slice.length) : 0;
  const out: Array<{ key: 'err' | SpanType; weight: number }> = failed ? [{ key: 'err', weight: errW }] : [];
  const okTotal = slice.length - failed;
  if (okTotal > 0) {
    for (const t of SPARK_RANK) {
      const n = slice.filter((s) => s.type === t && s.status !== 'error').length;
      if (n > 0) out.push({ key: t, weight: (n / okTotal) * (1 - errW) });
    }
  }
  return out;
}

// Guard requestAnimationFrame; fall back to direct call (fake-dom / SSR / tests).
function raf(fn: () => void): void {
  if (typeof requestAnimationFrame !== 'undefined') requestAnimationFrame(fn);
  else fn();
}

// ── Adapter ─────────────────────────────────────────────────────────────────────
// Converts a TraceSnapshot (span-store shape) into the prototype's internal model
// array. The prototype assumed one spawn per turn; this handles 0, 1, or many.

/**
 * Build the render model from a TraceSnapshot.
 *
 * @param {object} snap - TraceSnapshot from span-store.ts
 * @param {number|null} scopeTurn - when set, include only that turn index
 * @returns {Array} model entries, one per turn
 */
function adaptSnapshot(snap: TraceSnapshot, scopeTurn: number | null): TurnModel[] {
  const turns = scopeTurn != null ? snap.turns.filter((t) => t.index === scopeTurn) : snap.turns;

  return turns.map((turn: TraceTurn): TurnModel => {
    // Main lane only (lane 0). Spans are already appended in event order by the store.
    const mainSpans = turn.spans.filter((s) => s.lane === 0);
    const cnt = (type: SpanType) => mainSpans.filter((s) => s.type === type).length;

    // Build a group for every spawn span in the main lane.
    const spawnGroups: SpawnGroup[] = [];
    for (const spawnSpan of mainSpans.filter((s) => s.type === 'spawn')) {
      // Link via toolUseId — the store sets spawnId === the spawn tool-use event id,
      // and the spawn span's handle.toolUseId is that same value.
      const spawnToolUseId =
        spawnSpan.handle && 'toolUseId' in spawnSpan.handle ? spawnSpan.handle.toolUseId : undefined;
      const traceSpawn = turn.spawns.find((sp: TraceSpawn) => sp.spawnId === spawnToolUseId);
      if (!traceSpawn) {
        spawnGroups.push({ spawnSpan, spawnGroup: null, lanes: [] });
        continue;
      }

      const lanes: LaneEntry[] = traceSpawn.lanes.map((lane: TraceLane, laneIdx: number): LaneEntry => {
        const laneSpans = lane.spans;
        // t0/t1: measured from lane spans; fall back to the turn envelope when empty
        // (background subagents that produce no child events still have timing).
        const t0 = laneSpans.length ? Math.min(...laneSpans.map((s) => s.t0)) : turn.t0;
        const t1 = laneSpans.length ? Math.max(...laneSpans.map((s) => s.t1)) : turn.t1;
        return {
          subspan: {
            id: lane.agentId ?? `lane-${laneIdx}`,
            type: 'subspan',
            label: lane.label,
            agent: lane.label,
            agentId: lane.agentId,
            status: lane.status || 'ok',
            t0,
            t1,
            lane: laneIdx,
          },
          // ALL child spans (api + subspan) plus the derived tool count — named
          // honestly so no consumer ever reads spans.length as "tools ran".
          spans: laneSpans,
          toolCount: laneSpans.filter((s) => s.type === 'subspan').length,
        };
      });

      // spawnGroup keeps the raw TraceSpawn: the renderer needs kind ('Workflow')
      // and the lanes' ordered child spans for the parallel lane strip.
      spawnGroups.push({ spawnSpan, spawnGroup: traceSpawn, lanes });
    }

    const api = cnt('api'),
      tool = cnt('tool');
    // The failure must reach the COLLAPSED row. Measured over 1209 real turns, 16.3% hold
    // a failed span and 39 of 40 sessions hold at least one — and a lane-only failure (a
    // subagent that died while the parent looks clean) is invisible without this walk.
    const failed =
      mainSpans.filter((s) => s.status === 'error').length +
      turn.spawns.reduce(
        (n, sp) => n + sp.lanes.reduce((k, ln) => k + ln.spans.filter((s) => s.status === 'error').length, 0),
        0,
      );

    return {
      turn,
      api,
      tool,
      skill: cnt('skill'),
      hasError: failed > 0,
      failed,
      // Only a CONTROL command collapses to one line. A `work` turn with no api/tool was
      // interrupted (Esc) — that is information, so it keeps a full row.
      // A round that DELEGATED is never idle: `/code-review` runs no call of its own, so on
      // api/tool alone it collapsed to one line while its agent worked for ten minutes.
      isIdle: turn.kind === 'local' && !api && !tool && turn.spawns.length === 0,
      // Same reasoning as isIdle above: a round that delegated runs no call of its own, so on
      // api/tool alone it was drawn as concluded for the whole time its agent worked.
      isLive: turn.state === 'live' && (api > 0 || tool > 0 || turn.spawns.length > 0),
      ms: Math.max(0, turn.t1 - turn.t0),
      spawnGroups,
      path: mainSpans, // prompt … [api/tool/spawn]* … result, in store order
    };
  });
}

// ── Controller ────────────────────────────────────────────────────────────────

/**
 * Create a trace render controller attached to `container`.
 *
 * The controller renders a near-fullscreen modal with a vertical flow diagram.
 * Turn headers expand in-place; spawn blocks toggle their child lane below.
 * Pan (drag), zoom (wheel / buttons), and Escape/scrim close are wired up.
 *
 * @param {HTMLElement} container - receives the modal + scrim as direct children
 * @param {{ onBlock?: (handle: object) => void }} [opts]
 *   - `onBlock(handle)` fires when a step block or the spawn ⓘ is clicked.
 *     `handle` is a `DrawerHandle` from span-store.ts; the subagent variant is
 *     `{kind:'subagent', agentId: string|null, toolUseId?: string}` (toolUseId
 *     lets the router fall back to the spawn tool drawer when agentId is
 *     unknown). Spans with `handle === null` (prompt, result) do not fire it.
 * @returns {{ open(snapshot, scopeTurn): void, update(snapshot): void, close(): void,
 *   isOpen(): boolean, destroy(): void }} plus `_releaseFollow()` (TEST-ONLY:
 *   fake-dom cannot deliver the pan gesture that releases auto-follow).
 */
export function createTrace(container: HTMLElement, opts: TraceOpts = {}) {
  const onBlock: (handle: DrawerHandle) => void = opts.onBlock ?? (() => {});

  // ── Persistent controller state (survives update(), reset on open()) ──────────
  const openTurns = new Set<number>([0]); // model indices of expanded turn rows
  const openLanes = new Set<string>(); // spawnSpan.id values whose child lane is unfolded
  // "<turnIndex>:<groupId>" of groups the user expanded in place — survives
  // update() re-renders (live), reset on open().
  const pinnedGroups = new Set<string>();
  // When true, update() keeps the newest turn expanded and in view.
  // Cleared on a manual scroll so the user's chosen position sticks.
  let _following = false;
  // Whether the SESSION has ended. A killed round keeps `state: 'live'` for good, so without this
  // the suppression below would hide the final answer permanently on a session that is over.
  let _ended = false;
  let _dense = false;
  // Per-turn cursor over that turn's failures, so repeated badge clicks cycle them.
  const _failCursor = new Map<number, number>();
  // The span the last jump landed on. Held as STATE, not as a class written once: build()
  // replaces every node, so a marker applied after a jump vanished at the next live event
  // — the one moment the user is looking at it. Re-derived by applyHit() on every rebuild,
  // exactly like a spawn block's open ring is re-derived from openLanes.
  let _hitSpanId: string | null = null;
  // The scrollTop the controller last set itself. The listener compares POSITION rather
  // than trusting a time window: a boolean cleared on the next frame looked equivalent,
  // but on a busy live session focusLastTurn runs on every event, so the flag was up
  // whenever the user happened to scroll — and their scroll was swallowed as our own,
  // leaving auto-follow engaged and yanking them back on the next event.
  let _expectedTop: number | null = null;

  // ── Render state ──────────────────────────────────────────────────────────────
  let _snap: TraceSnapshot | null = null;
  let _scopeTurn: number | null = null;
  let _model: TurnModel[] = [];
  let _segs: SegRecord[] = [];

  // ── Modal DOM refs (created once in ensureModal()) ────────────────────────────
  let scrimEl: HTMLElement | null = null,
    modalEl: HTMLElement | null = null;
  let stageEl: HTMLElement | null = null,
    canvasEl: HTMLElement | null = null;
  let spineEl: HTMLElement | null = null,
    hsubjEl: HTMLElement | null = null;
  let followBtn: HTMLElement | null = null,
    denseBtn: HTMLElement | null = null;

  let _isOpen = false;

  // Named listener references; set in ensureModal(), used by destroy().
  let onWinKeyDown: ((e: KeyboardEvent) => void) | null = null;
  let onStageScroll: (() => void) | null = null;

  // ── Modal construction ───────────────────────────────────────────────────────

  function ensureModal() {
    if (modalEl) return;
    const doc = document;

    scrimEl = doc.createElement('div');
    scrimEl.className = 'trace-scrim';
    scrimEl.onclick = () => close();

    modalEl = doc.createElement('div');
    modalEl.className = 'trace-modal';

    // Header bar
    const hdr = doc.createElement('div');
    hdr.className = 'trace-hdr';

    const htitle = doc.createElement('span');
    htitle.className = 'trace-htitle';
    htitle.textContent = 'Trace';

    hsubjEl = doc.createElement('span');
    hsubjEl.className = 'trace-hsubj';

    const spacer = doc.createElement('span');
    spacer.className = 'trace-hspacer';

    // View controls. Zoom and Fit are gone: neither navigated anything — Fit scaled the
    // whole spine to 0.54 on a 14-turn session (text ~7px) and would reach ~0.13 at p90,
    // and the zoom buttons only made a document smaller. Density, collapse and jump-to
    // are what a document actually needs.
    const zoom = doc.createElement('div');
    zoom.className = 'trace-zoom';

    denseBtn = doc.createElement('button');
    denseBtn.className = 'trace-zbtn';
    denseBtn.textContent = 'Compact';
    // The only one of the three whose name does not say its object, so it says it here.
    denseBtn.title =
      'Smaller blocks, sub-lines hidden. Changes how the steps are drawn, ' + 'not which turns are open.';
    denseBtn.onclick = () => {
      _dense = !_dense;
      if (modalEl) modalEl.classList.toggle('dense', _dense);
      denseBtn!.classList.toggle('on', _dense); // ! proven: assigned directly above
    };

    const collapseBtn = doc.createElement('button');
    // "Close turns", not "Collapse all": each open turn ALSO carries `expand`/`collapse`
    // for its groups, so the same verb at two levels named two different objects.
    collapseBtn.className = 'trace-zbtn';
    collapseBtn.textContent = 'Close turns';
    collapseBtn.title = 'Shut every open turn. The groups inside a turn have their own ' + 'expand / collapse.';
    collapseBtn.onclick = () => collapseAllTurns();

    const lastBtn = doc.createElement('button');
    lastBtn.className = 'trace-zbtn';
    lastBtn.textContent = 'Last turn';
    lastBtn.title = 'Open the newest turn and scroll to it.';
    lastBtn.onclick = () => {
      openLastTurn();
      raf(focusLastTurn);
    };

    zoom.append(denseBtn, collapseBtn, lastBtn);

    const closeBtn = doc.createElement('button');
    closeBtn.className = 'trace-close';
    closeBtn.textContent = '✕';
    closeBtn.onclick = () => close();

    // Visible only while a whole-session open has been un-followed by a manual
    // scroll — clicking it re-engages auto-follow (there was no way back before).
    followBtn = doc.createElement('button');
    followBtn.className = 'trace-follow hidden';
    followBtn.textContent = 'follow';
    followBtn.onclick = () => {
      _following = true;
      syncFollowBtn();
      raf(focusLastTurn);
    };

    hdr.append(htitle, hsubjEl, spacer, followBtn, zoom, closeBtn);

    // Stage (the scroll container) / canvas / spine. No SVG layer: with each strip under
    // its own header there is no inter-turn edge left to measure and draw.
    stageEl = doc.createElement('div');
    stageEl.className = 'trace-stage';

    canvasEl = doc.createElement('div');
    canvasEl.className = 'trace-canvas';

    spineEl = doc.createElement('div');
    spineEl.className = 'trace-spine';

    canvasEl.append(spineEl);
    stageEl.append(canvasEl);
    modalEl.append(hdr, stageEl);
    container.append(scrimEl, modalEl);

    // A manual scroll releases auto-follow, exactly as a manual pan used to — but the
    // controller scrolls the same element to follow, so its own scrolls must not count.
    onStageScroll = () => {
      // Within a couple of pixels of where we put it → this is the scroll we caused.
      if (_expectedTop != null && stageEl && Math.abs(stageEl.scrollTop - _expectedTop) <= 2) return;
      _expectedTop = null;
      _following = false;
      syncFollowBtn();
    };
    if (stageEl.addEventListener) stageEl.addEventListener('scroll', onStageScroll, { passive: true });

    // Named handler reference is required for removeEventListener in destroy().
    onWinKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && _isOpen) close();
    };
    if (typeof window !== 'undefined') window.addEventListener('keydown', onWinKeyDown);
  }

  // ── Scrolling ─────────────────────────────────────────────────────────────────

  /**
   * Scroll the stage and record where we landed, so the listener can recognise the
   * resulting event as ours. Reading scrollTop back is what makes this exact: the browser
   * clamps the request, and the listener compares against the clamped value.
   */
  function setScrollTop(top: number): void {
    if (!stageEl) return;
    stageEl.scrollTop = Math.max(0, top);
    _expectedTop = stageEl.scrollTop;
  }

  /**
   * Bring the newest work into view. The last turn's header is parked ≈20% down the
   * stage so its body has room below; a live turn additionally scrolls its own strip
   * fully right, because the strip grows rightward and the tail is where the work is.
   * No-op under fake-dom (offsetTop absent → 0 → harmless).
   */
  function focusLastTurn(): void {
    if (!_segs.length || !stageEl) return;
    const last = _segs[_segs.length - 1]!; // ! proven: _segs.length > 0 (checked above)
    const vh = stageEl.clientHeight || 0;
    const top = typeof last.seg.offsetTop === 'number' ? last.seg.offsetTop : 0;
    setScrollTop(top - Math.round(vh * 0.2));

    if (last.m.turn.state === 'live' && last.scroller) {
      const s = last.scroller;
      if (typeof s.scrollWidth === 'number') s.scrollLeft = s.scrollWidth;
    }
  }

  /**
   * Re-anchor every open lane under its spawn block. An in-place group expansion
   * shifts the spawn's x, and the margin set at render time goes stale — the lane and
   * its spawn now share one horizontal scroller, so the offset stays true while scrolling.
   */
  function anchorLanes(): void {
    for (const rec of _segs) {
      if (!openTurns.has(rec.i) || !rec._laneWraps) continue;
      for (const { spawnEl, wrap } of rec._laneWraps) {
        const left = spawnEl && typeof spawnEl.offsetLeft === 'number' ? spawnEl.offsetLeft : 0;
        wrap.style.marginLeft = Math.max(0, left - 8) + 'px';
      }
    }
  }

  // Coalesce anchor passes: restoring N pinned groups during one rebuild (or an
  // expand-all click) would otherwise queue N passes in the same frame.
  let _anchorQueued = false;
  function scheduleAnchor(): void {
    if (_anchorQueued) return;
    _anchorQueued = true;
    raf(() => {
      _anchorQueued = false;
      anchorLanes();
    });
  }

  // Walk a fake/real DOM subtree collecting nodes matching a class (string) or
  // any of a Set of classes — ONE walker for every traversal in this file (the
  // previous pair of hand-rolled walkers is how the HTMLCollection.find crash
  // shipped: a fix applied to one and not the other).
  function walkClass(root: Element, cls: string | Set<string>): HTMLElement[] {
    const wanted: Set<string> | null = typeof cls === 'string' ? null : cls;
    const acc: HTMLElement[] = [];
    function walk(n: Element | null | undefined): void {
      if (!n || !n.children) return;
      for (const child of n.children) {
        // Cast to HTMLElement: callers only pass HTML roots; SVG elements are skipped
        // by the typeof check (SVGAnimatedString is not a string).
        const c = child as HTMLElement;
        if (typeof c.className === 'string') {
          const list = c.className.split(' ');
          // When wanted is null, cls is a string — invariant from the ternary above.
          if (wanted !== null ? list.some((x) => wanted.has(x)) : typeof cls === 'string' && list.includes(cls))
            acc.push(c);
        }
        walk(child as Element);
      }
    }
    walk(root);
    return acc;
  }

  // ── Build ─────────────────────────────────────────────────────────────────────

  function build(): void {
    spineEl!.replaceChildren(); // ! proven: build() only called after ensureModal() sets spineEl
    _segs = [];

    const startCap = document.createElement('div');
    startCap.className = 'cap start';
    startCap.textContent = '▼ INITIAL PROMPT';
    spineEl!.append(startCap);

    // Every turn's bar is a share of the longest turn, so the rows are comparable at a
    // glance — the number alone requires reading and converting each one.
    const maxTurnMs = Math.max(1, ..._model.map((m) => m.ms));

    _model.forEach((m, i) => {
      const isOpen = openTurns.has(i);
      const seg = document.createElement('div');
      // A `live` state also sticks to turns a finished session never closed (measured:
      // 16 of 144, all of them empty), so the live rule must see real work too.
      // The model's own answer, not a second copy of it: recomputed here it missed the delegated
      // round (no call of its own) that `adaptSnapshot` had already accounted for.
      const isLive = m.isLive;
      seg.className =
        'tseg' +
        (isOpen ? ' open' : '') +
        (m.hasError ? ' has-err' : '') +
        (isLive ? ' is-live' : '') +
        (m.isIdle ? ' is-idle' : '');

      const th = document.createElement('div');
      th.className = 'thead';

      const hdDiv = document.createElement('div');
      hdDiv.className = 'hd';

      const idEl = document.createElement('span');
      idEl.className = 'id';
      const chev = document.createElement('span');
      chev.className = 'chev';
      chev.textContent = '▸';
      idEl.append(chev, document.createTextNode(' T' + m.turn.index + ' · ' + m.turn.kind));

      const ttl = document.createElement('div');
      ttl.className = 'ttl';
      // The row is now full-width, so the title gets the room the 214px card denied it.
      ttl.textContent = short(m.turn.title, 200);

      hdDiv.append(idEl, ttl);

      if (!m.isIdle) {
        hdDiv.append(sparkline(m.path));

        // Each slot is emitted even when empty: on a 144-turn session the metrics must
        // line up in columns, or comparing two rows means re-reading both.
        const fk = document.createElement('div');
        fk.className = 'fk';
        const subagentTotal = m.spawnGroups.reduce((n, sg) => n + sg.lanes.length, 0);
        if (subagentTotal > 0) fk.textContent = '⑃ ×' + subagentTotal;
        hdDiv.append(fk);

        const errSlot = document.createElement('span');
        errSlot.className = 'errslot';
        if (m.failed > 0) {
          const badge = document.createElement('button');
          badge.className = 'terr';
          // The COUNT is what disambiguates: a bare "failed" reads as "this turn
          // failed", when what failed is n of its steps — the turn itself carried on.
          badge.textContent = plural(m.failed, 'failed step');
          badge.title =
            m.failed +
            " of this turn's steps failed (a tool error, or an API " +
            'call Claude Code flagged). The turn itself did not fail.' +
            '\nClick to jump to ' +
            (m.failed === 1 ? 'it' : 'each of them in turn') +
            '.';
          // stopPropagation: the badge sits inside the header, whose own click toggles
          // the turn — which would fight the jump's expansion.
          badge.onclick = (e) => {
            if (e && e.stopPropagation) e.stopPropagation();
            const cur = _segs[i];
            if (cur) jumpToFailure(cur);
          };
          errSlot.append(badge);
        }
        hdDiv.append(errSlot);

        const dur = document.createElement('div');
        dur.className = 'tdur';
        const bar = document.createElement('div');
        bar.className = 'tbar';
        const fill = document.createElement('i');
        const share = Math.round((100 * m.ms) / maxTurnMs);
        fill.style.width = Math.max(2, share) + '%';
        bar.append(fill);
        const durTxt = document.createElement('b');
        durTxt.textContent = fmtDur(m.ms);
        // The bar has no label and no axis, so it has to say what it measures. It stays
        // neutral in colour: tinting it red duplicated a signal the left rule, the badge
        // and the sparkline already carry, and only raised the question "why is it red?".
        dur.title = fmtDur(m.ms) + ' — ' + share + '% of the longest turn in this session (' + fmtDur(maxTurnMs) + ')';
        dur.append(bar, durTxt);
        hdDiv.append(dur);
      }

      th.append(hdDiv);
      th.onclick = () => toggleTurn(i);

      const tb = document.createElement('div');
      tb.className = 'tbody';

      // Expand/collapse every group of this turn at once; stopPropagation keeps
      // the header's own turn-toggle out of it. It lives in the BODY, not the header:
      // a full-width header is a column grid, and two links inside it break the columns.
      const ctl = document.createElement('div');
      ctl.className = 'tctl';
      // "expand" / "collapse": the "all" was redundant — the pair sits inside one turn
      // and can only ever act on that turn's groups.
      for (const [label, want] of [
        ['expand', true],
        ['collapse', false],
      ] as [string, boolean][]) {
        const a = document.createElement('a');
        a.textContent = label;
        a.onclick = (e) => {
          if (e && e.stopPropagation) e.stopPropagation();
          if (want) {
            // Expanding creates NEW nested holders — iterate to a fixpoint so
            // one click opens every level, not just the outermost.
            let prev = -1,
              holders = walkClass(tb, 'gholder');
            while (holders.length !== prev) {
              holders.forEach((h) => (h as TraceHolder)._traceSetOpen && (h as TraceHolder)._traceSetOpen!(true));
              prev = holders.length;
              holders = walkClass(tb, 'gholder');
            }
          } else {
            walkClass(tb, 'gholder').forEach(
              (h) => (h as TraceHolder)._traceSetOpen && (h as TraceHolder)._traceSetOpen!(false),
            );
          }
        };
        ctl.append(a);
      }
      tb.append(ctl);

      seg.append(th, tb);
      spineEl!.append(seg); // ! proven: build() only called after ensureModal()

      const rec = { seg, thead: th, tbody: tb, built: false, m, i };
      _segs.push(rec);

      if (isOpen) buildBody(rec);
    });

    // Nothing is FINAL while a turn is still working: the last answer on record belongs to a
    // PREVIOUS round, and presenting it under that cap says the session has concluded when it has
    // not. The cap comes back the moment the live round produces its own answer.
    // On an ENDED session nothing is still working, whatever a round that was never closed says.
    if (_ended || !_model.some((m) => m.isLive)) {
      const endCap = document.createElement('div');
      endCap.className = 'cap end';
      endCap.textContent = '▲ FINAL RESULT';
      spineEl!.append(endCap, finalResultNode()); // ! proven: build() only called after ensureModal()
    }

    scheduleAnchor();
  }

  /**
   * The block the `▲ FINAL RESULT` cap names: the session's closing answer, or the empty state
   * when it has not produced one yet.
   *
   * The cap used to be the last node of the spine, with nothing under it — and nothing else in
   * the document carried an answer either, since every row's title is its PROMPT. The answer was
   * only ever the last block of an expanded turn's strip, past a horizontal scroll.
   *
   * It reads the LAST `result` span of the last turn that holds one — the same span the `done`
   * block renders, so the two can never disagree — and reuses its `turn-text` handle rather than
   * copying the text: the drawer reads the full answer off the reducer at click time.
   */
  function finalResultNode(): HTMLElement {
    let span: TraceSpan | null = null;
    let turn: TraceTurn | null = null;
    for (let i = _model.length - 1; i >= 0 && !span; i--) {
      const m = _model[i]!;
      for (let j = m.path.length - 1; j >= 0; j--) {
        const s = m.path[j]!;
        if (s.type === 'result') {
          span = s;
          turn = m.turn;
          break;
        }
      }
    }

    const fin = document.createElement('div');
    if (!span || !turn) {
      fin.className = 'finres empty';
      fin.textContent = 'No final answer yet';
      return fin;
    }
    fin.className = 'finres';

    const id = document.createElement('span');
    id.className = 'fnid';
    // Which turn spoke it. On a live session the last turn may still be working while the
    // answer on screen belongs to the one before — unnamed, that block would lie by position.
    id.textContent = 'T' + turn.index;

    const txt = document.createElement('div');
    txt.className = 'fntext';
    // The span's own first line, exactly what the `done` block shows; the rest is in the drawer.
    // Stripped to plain, like the NOW panel's inline line: this block RENDERS prose rather than
    // labelling a step, so the raw `**` and backticks would reach the eye as literal noise.
    // The emptiness that matters is the STRIPPED text, not the raw detail: markers-only markdown is
    // a non-empty detail that leaves nothing to show, and testing the raw one drew a blank line.
    txt.textContent = (span.detail ? stripMarkdown(span.detail) : '') || '(no text)';

    fin.append(id, txt);
    const h = span.handle;
    if (h != null) fin.onclick = () => onBlock(h);
    return fin;
  }

  /**
   * Re-mark the step the last jump landed on. Called from renderLanes(), which every path
   * that replaces a block goes through — a live rebuild, a turn re-opened by hand, a lane
   * folded and unfolded. The marker is derived from _hitSpanId, never from the node that
   * happened to carry the class before: build() replaces every node, so a class written
   * once vanished at the next live event.
   */
  function applyHit(): void {
    if (!_hitSpanId) return;
    for (const rec of _segs) {
      const el = rec._stepEls ? rec._stepEls.get(_hitSpanId) : null;
      if (el && el.classList) el.classList.add('hit');
    }
  }

  /** Build a connector arrow SVG node using createElementNS (no innerHTML). */
  function makeConnSVG(col: string): Element {
    // In fake-dom createElementNS is absent; return a plain div placeholder.
    if (typeof document.createElementNS !== 'function') {
      const d = document.createElement('div');
      return d;
    }
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', '38');
    svg.setAttribute('height', '44');
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', '2');
    line.setAttribute('y1', '22');
    line.setAttribute('x2', '28');
    line.setAttribute('y2', '22');
    line.setAttribute('stroke', col);
    line.setAttribute('stroke-width', '2');
    const arrow = document.createElementNS(ns, 'path');
    arrow.setAttribute('d', 'M26,16 L34,22 L26,28');
    arrow.setAttribute('fill', 'none');
    arrow.setAttribute('stroke', col);
    arrow.setAttribute('stroke-width', '2');
    svg.append(line, arrow);
    return svg;
  }

  /**
   * The turn's steps, in order, binned into fixed slots and coloured by each bin's
   * dominant type; a bin holding a failure goes red. Replaces the per-type counts:
   * `82 api  99 tool` says how MUCH a turn did and never what it looked like, so two
   * turns with the same counts but opposite shapes (one long tool burst vs alternating
   * api/tool cycles) read identically. A turn is p50 11 steps but p99 220, so the bar
   * has to be a projection rather than one mark per step; the total stays as a number.
   */
  function sparkline(spans: TraceSpan[]): HTMLElement {
    const box = document.createElement('div');
    box.className = 'tspark';
    const bins = document.createElement('div');
    bins.className = 'bins';
    const n = Math.min(SPARK_BINS, Math.max(1, spans.length));
    for (let b = 0; b < n; b++) {
      const from = Math.floor((b * spans.length) / n);
      const to = Math.max(from + 1, Math.floor(((b + 1) * spans.length) / n));
      const slice = spans.slice(from, to);
      // Each bin STACKS the types it holds, in a fixed order, proportionally. One winner
      // per bin cannot describe a mixture: a majority vote painted 30 bins of 30 blue on
      // a real 179-step turn (every round is one api plus its tools, so api tied or won
      // nearly all of them), and ranking tools above api merely turned the same wall
      // green. Stacked, that turn reads as what it is — api and tool interleaved — and
      // the row finally agrees with the strip underneath it.
      const i = document.createElement('i');
      const present = SPARK_RANK.filter((t) => slice.some((s) => s.type === t));
      const failed = slice.filter((s) => s.status === 'error').length;
      // The type is also a class: the colour comes from getComputedStyle, which does not
      // exist under a fake DOM, so without this the composition is untestable there.
      i.className = [...(failed ? ['err'] : []), ...present.map((t) => 't-' + t)].join(' ');

      const parts = binComposition(slice).map((p) => ({
        colour: p.key === 'err' ? cssv('--sp-error') || '#fb7185' : cssv(CATV[p.key]) || '',
        weight: p.weight,
      }));
      const usable = parts.filter((p) => p.colour);
      if (usable.length === 1) i.style.background = usable[0]!.colour;
      else if (usable.length > 1) {
        let at = 0;
        const stops = usable.map((p) => {
          const from = at;
          at = Math.min(100, at + p.weight * 100);
          return `${p.colour} ${from.toFixed(1)}% ${at.toFixed(1)}%`;
        });
        i.style.background = `linear-gradient(to bottom, ${stops.join(', ')})`;
      }
      bins.append(i);
    }
    const num = document.createElement('span');
    num.className = 'n';
    num.textContent = plural(spans.length, 'step');
    box.append(bins, num);
    return box;
  }

  /** Type-composition preview for a collapsed group: one dot per leaf span. */
  function typeDots(spans: TraceSpan[], max = 14): HTMLSpanElement {
    const box = document.createElement('span');
    box.className = 'gdots';
    spans.slice(0, max).forEach((s) => {
      const i = document.createElement('i');
      // A failed leaf's dot goes red — the preview shows WHERE (and how many) failures a
      // collapsed group holds, at the exact position of the failing step.
      if (s.status === 'error') {
        i.className = 'err';
      } else {
        const cv = cssv(CATV[s.type]);
        if (cv) i.style.background = cv;
      }
      box.append(i);
    });
    if (spans.length > max) {
      const m = document.createElement('span');
      m.className = 'more';
      m.textContent = '+' + (spans.length - max);
      box.append(m);
    }
    return box;
  }

  /**
   * A block's share of the widest block in its strip, as a 2px rule under the label.
   * Linear on purpose: a 96ms Skill beside a 5m chapter SHOULD read as nothing. Without
   * it the strip encodes sequence only, and every block is the same width whether it
   * took 96ms or six minutes.
   */
  function durBar(ms: number, max: number): HTMLDivElement {
    const b = document.createElement('div');
    b.className = 'dbar';
    const i = document.createElement('i');
    i.style.width = Math.max(2, Math.round((100 * ms) / Math.max(1, max))) + '%';
    b.append(i);
    return b;
  }

  /** One raw step block (the pre-grouping .snode, unchanged rendering). */
  function makeStepNode(item: Extract<GroupItem, { kind: 'step' }>, rec: SegRecord, max: number): HTMLDivElement {
    const m = rec.m;
    const s = item.span;
    const isSpawn = s.type === 'spawn';

    // Mid-turn result = the model closed its turn and was re-woken (e.g. a
    // background notification): rendered "reply", dashed — only the last is "done".
    const isMid = item.midResult === true;

    const sn = document.createElement('div');
    const cls = [
      'snode',
      s.type === 'prompt' ? 'start' : '',
      s.type === 'result' ? 'end' + (isMid ? ' mid' : '') : '',
      // The open ring is DERIVED from openLanes so a live rebuild cannot desync
      // the block's visual state from its rendered lane.
      isSpawn ? 'spawn' + (openLanes.has(s.id) ? ' on' : '') : '',
      s.status === 'error' ? 'err' : '',
    ]
      .filter(Boolean)
      .join(' ');
    sn.className = cls;

    if (!isSpawn && s.type !== 'prompt' && s.type !== 'result') {
      const cv = cssv(CATV[s.type as keyof typeof CATV]);
      if (cv) sn.style.setProperty('--c', cv);
    }

    const slDiv = document.createElement('div');
    slDiv.className = 'sl';
    const dot = document.createElement('i');
    // Spawn label = the launch intent (subagentType / prompt first line), not "Agent".
    const stepLabel = s.type === 'result' ? (isMid ? 'reply' : 'done') : isSpawn ? s.detail || s.label : s.label;
    // The label lives in its own ellipsized span so every block title is ONE
    // line — a long spawn intent must not wrap into a taller, odd-looking block.
    const st = document.createElement('span');
    st.className = 'st';
    st.textContent = (isSpawn ? '⑃ ' : '') + short(stepLabel.replace(/ · (fan-out|background)/, ''), 20);
    slDiv.append(dot, st);
    // A background launch is otherwise indistinguishable from any other Bash — and its sub-line
    // SWITCHES identity when the outcome lands (the command is replaced by Claude Code's sentence,
    // which names the command by its `description`). The chip is what stays put across both, and
    // it is also what says the block's duration is the launch, not the command.
    if (s.background) {
      const bg = document.createElement('span');
      bg.className = 'sbg';
      bg.textContent = 'bg';
      bg.title =
        'Launched in the background. The duration is the LAUNCH; the command itself may still be ' +
        'running — Claude Code reports it only when it ends.';
      slDiv.append(bg);
    }
    // A hook flagged this call. Only the mark is here: the note itself can be a paragraph, and the
    // block is one line — clicking it opens the drawer, which is where the text is.
    if (s.flagged) {
      const fl = document.createElement('span');
      fl.className = 'sflag';
      fl.textContent = '⚑';
      fl.title = 'A hook attached a note to this call — open it to read what it said.';
      slDiv.append(fl);
    }

    const ssDiv = document.createElement('div');
    ssDiv.className = 'ss';

    if (isSpawn) {
      // The spawn block IS the subagent: its sub-line carries the SUBAGENT's
      // facts (who, how much, how long) — never the spawn-call ms, which is a
      // launch receipt and reads as the subagent's duration.
      const sg = m.spawnGroups.find((g) => g.spawnSpan.id === s.id);
      const lanes: LaneEntry[] = sg ? sg.lanes : [];
      // ! proven: lanes.length > 0 in truthy branch of ternary
      const lane: LaneEntry | null = lanes.length ? lanes[0]! : null;
      const isWf = Boolean(sg && sg.spawnGroup && sg.spawnGroup.kind === 'Workflow');
      const toolWord = (n: number) => n + (n === 1 ? ' tool' : ' tools');
      let base: string | null;
      if (isWf) {
        // ! proven: isWf is true only when sg && sg.spawnGroup are both non-null
        base = plural(sg!.spawnGroup!.lanes.length, 'agent');
      } else if (lanes.length > 1) {
        // A fan-out spawn: every lane is rendered below; the block aggregates.
        const total = lanes.reduce((n, ln) => n + ln.toolCount, 0);
        const ms = Math.max(...lanes.map((ln) => ln.subspan.t1 - ln.subspan.t0));
        base = lanes.length + ' subagents · ' + toolWord(total) + ' · ' + fmtDur(ms);
      } else if (lane) {
        base =
          short(lane.subspan.agent || '', 24) +
          ' · ' +
          toolWord(lane.toolCount) +
          ' · ' +
          fmtDur(lane.subspan.t1 - lane.subspan.t0);
      } else {
        base = null;
      }
      const openHint = ' · ▾ fold',
        closedHint = isWf ? ' · ▸ expand' : ' · ▸ expand flow';
      ssDiv.textContent = base == null ? 'no child data yet' : base + (openLanes.has(s.id) ? openHint : closedHint);
      // toggleLane flips the hint in place without a rebuild.
      const snSpawn = sn as TraceSpawnEl;
      snSpawn._traceSsBase = base;
      snSpawn._traceHints = { openHint, closedHint };

      // ⓘ opens the drawer (subagent when known, spawn tool otherwise — the
      // routing lives in graph.ts openBlock); the block itself toggles the lane.
      const gi = document.createElement('span');
      gi.className = 'gi';
      gi.textContent = 'ⓘ';
      gi.onclick = (e) => {
        if (e && e.stopPropagation) e.stopPropagation();
        const toolUseId = s.handle && 'toolUseId' in s.handle ? s.handle.toolUseId : undefined;
        onBlock({ kind: 'subagent', agentId: lane ? (lane.subspan.agentId ?? null) : null, toolUseId });
      };
      slDiv.append(gi);

      sn.append(slDiv, ssDiv);
      sn.onclick = (e) => {
        if (e && e.stopPropagation) e.stopPropagation();
        toggleLane(rec, s.id, sn);
      };
      // renderLanes/anchorLanes find this block by id, never by DOM position.
      if (rec._spawnEls) rec._spawnEls.set(s.id, sn);
    } else {
      // An api span's detail is the TURN's own label, so every api block in a turn
      // repeated the same string; a prompt/result span has no duration, and printing
      // "· 0ms" on both put a meaningless number on the first and last block of
      // every turn in the session.
      const ms = s.t1 - s.t0;
      const detail = s.type === 'api' ? '' : s.detail || '';
      const parts = [detail, ms > 0 ? fmtDur(ms) : ''].filter(Boolean);
      ssDiv.textContent = parts.join(' · ');
      sn.append(slDiv, ssDiv);
      if (ms > 0) sn.append(durBar(ms, max));
      // A MID-turn result is one of several the turn produced, and the reducer keeps
      // only the last ("last wins") — opening it would show a later answer than the
      // block claims. Only the closing `done` carries the turn's text.
      const suppress = isMid && s.type === 'result';
      if (s.handle != null && !suppress) {
        const h = s.handle; // capture non-null handle: proven by if-guard above
        sn.onclick = () => onBlock(h);
      }
    }
    // Indexed by span id so the failure jump can find this block after a rebuild,
    // wherever it ended up — main strip or a child lane.
    if (rec._stepEls) rec._stepEls.set(s.id, sn);
    return sn;
  }

  /**
   * One block for a run of spawns that ran in parallel. It aggregates like a fan-out
   * spawn (subagents · tools · longest lane) and carries one rule per subagent, so the
   * block still shows how many ran and which of them failed — a single merged label
   * would hide both. Clicking it unfolds EVERY lane of EVERY spawn in the run.
   */
  function makeParallelNode(item: Extract<GroupItem, { kind: 'parallel' }>, rec: SegRecord): HTMLDivElement {
    const groups = item.spans
      .map((s) => rec.m.spawnGroups.find((g) => g.spawnSpan.id === s.id))
      .filter(Boolean) as SpawnGroup[];
    const lanes = groups.flatMap((g) => g.lanes);
    const tools = lanes.reduce((n, ln) => n + ln.toolCount, 0);
    const ms = lanes.length ? Math.max(...lanes.map((ln) => ln.subspan.t1 - ln.subspan.t0)) : 0;

    const sn = document.createElement('div') as TraceSpawnEl;
    const open = item.spans.every((s) => openLanes.has(s.id));
    sn.className = 'snode spawn par' + (open ? ' on' : '');

    const slDiv = document.createElement('div');
    slDiv.className = 'sl';
    const st = document.createElement('span');
    st.className = 'st';
    st.textContent = '⑃ ' + item.spans.length + ' in parallel';
    slDiv.append(document.createElement('i'), st);

    const ssDiv = document.createElement('div');
    ssDiv.className = 'ss';
    const base = lanes.length
      ? plural(lanes.length, 'subagent') + ' · ' + plural(tools, 'tool') + ' · ' + fmtDur(ms)
      : plural(item.spans.length, 'subagent') + ' · no child data yet';
    const openHint = ' · ▾ fold',
      closedHint = ' · ▸ expand flow';
    ssDiv.textContent = base + (open ? openHint : closedHint);
    sn._traceSsBase = base;
    sn._traceHints = { openHint, closedHint };

    // One rule per subagent, in launch order; a failed lane's rule goes red.
    const pk = document.createElement('div');
    pk.className = 'pk';
    for (const ln of lanes) {
      const i = document.createElement('i');
      if (ln.spans.some((s) => s.status === 'error') || ln.subspan.status === 'error') i.className = 'err';
      pk.append(i);
    }
    sn.append(slDiv, ssDiv, pk);

    sn.onclick = (e) => {
      if (e && e.stopPropagation) e.stopPropagation();
      // The whole run toggles together: it is drawn as one block, so it must open as one.
      const wantOpen = !item.spans.every((s) => openLanes.has(s.id));
      for (const s of item.spans) {
        if (wantOpen) openLanes.add(s.id);
        else openLanes.delete(s.id);
      }
      if (sn.classList) sn.classList.toggle('on', wantOpen);
      const ss = walkClass(sn, 'ss')[0];
      if (ss) ss.textContent = base + (wantOpen ? openHint : closedHint);
      renderLanes(rec);
      scheduleAnchor();
    };
    // Every spawn in the run anchors its lanes to this one block.
    if (rec._spawnEls) for (const s of item.spans) rec._spawnEls.set(s.id, sn);
    return sn;
  }

  /** Render one GroupItem: a step block, or a collapsible group that expands
      IN PLACE (gnode ⇄ gframe), pinned by "<turnIndex>:<ns><groupId>". `ns`
      namespaces the key: group ids restart at r1 in every grouping pass, so the
      main strip and each child lane need distinct key spaces. */
  function renderItem(parent: HTMLElement, item: GroupItem, rec: SegRecord, ns: string, max: number): void {
    if (item.kind === 'step') {
      parent.append(makeStepNode(item, rec, max));
      return;
    }
    if (item.kind === 'parallel') {
      parent.append(makeParallelNode(item, rec));
      return;
    }
    const key = rec.m.turn.index + ':' + (ns || '') + item.id;

    // Rounds and chapters carry distinct hues so the three block families —
    // steps (per-type colors), rounds, chapters — read apart at a glance.
    const tint = cssv(item.rounds > 1 ? '--sp-chapter' : '--sp-round');

    // A group that folds a failure carries a red accent, so a scan of the collapsed strip
    // catches it without opening every block. Set on both faces (collapsed gnode + expanded
    // gcap) so the signal survives expansion.
    const err = item.hasError;
    // A ROUND takes the intent of its own api call as its name (`#3 round` is a counter, the
    // intent is what the round IS); a CHAPTER keeps its range and only says how many intents it
    // folds — the first of ten does not describe the other nine. 60% of real rounds state no
    // intent, so the number stays their label: the fallback is the common case, not the edge.
    const isRound = item.rounds === 1;
    const intent = isRound ? (item.intents[0] ?? null) : null;
    const g = document.createElement('div');
    g.className = 'gnode' + (err ? ' err' : '') + (intent ? ' gnamed' : '');
    if (tint) g.style.setProperty('--g', tint);
    const gl = document.createElement('div');
    gl.className = 'gl';
    // Two clamped lines, not the whole intent: the block is 172px wide, and a first line is a
    // measured p50 129 chars — no geometry shows the sentence, so the block carries the opening
    // of it and `title` carries the rest.
    gl.textContent = intent ? firstLine(intent) : item.label;
    const gs = document.createElement('div');
    gs.className = 'gs';
    // A named round prints its number here, where "#3" weighs the same as "2 steps"; a chapter
    // drops `steps` when it has an intent count to carry, or the four facts wrap to a second
    // line and grow the block.
    gs.textContent = intent
      ? item.label.replace(' round', '') + ' · ' + plural(item.steps, 'step') + ' · ' + fmtDur(item.ms)
      : !isRound && item.intents.length > 0
        ? plural(item.rounds, 'round') + ' · ' + plural(item.intents.length, 'intent') + ' · ' + fmtDur(item.ms)
        : (item.rounds > 1 ? plural(item.rounds, 'round') + ' · ' : '') +
          plural(item.steps, 'step') +
          ' · ' +
          fmtDur(item.ms);
    // The full text a block cannot hold: the round's own intent, or every intent a chapter folds.
    if (intent) g.title = intent;
    else if (item.intents.length > 0) g.title = item.intents.map(firstLine).join('\n');
    const gx = document.createElement('div');
    gx.className = 'gx';
    gx.textContent = '▸ expand';
    g.append(gl, gs, typeDots(leafSpans(item)), gx, durBar(item.ms, max));

    const frame = document.createElement('div');
    frame.className = 'gframe';
    if (tint) frame.style.setProperty('--g', tint);
    const cap = document.createElement('button');
    cap.className = 'gcap' + (err ? ' err' : '');
    cap.textContent = '▾ ' + item.label;
    const inner = document.createElement('div');
    inner.className = 'ginner';
    frame.append(cap, inner);
    let built = false;

    const holder = document.createElement('span') as TraceHolder;
    holder.className = 'gholder';
    holder.append(g);
    const setOpen = (want: boolean) => {
      // The children are normalised against the WIDEST child, not the parent's scale:
      // inside a group every bar would otherwise be a sliver of the group's own total.
      if (want && !built) {
        const inMax = stripMax(item.items);
        renderItems(inner, item.items, rec, ns, inMax);
        built = true;
      }
      if (want) pinnedGroups.add(key);
      else pinnedGroups.delete(key);
      holder.replaceChildren(want ? frame : g);
      scheduleAnchor();
    };
    g.onclick = (e) => {
      if (e && e.stopPropagation) e.stopPropagation();
      setOpen(true);
    };
    cap.onclick = (e) => {
      if (e && e.stopPropagation) e.stopPropagation();
      setOpen(false);
    };
    holder._traceSetOpen = setOpen; // expand all / collapse all
    parent.append(holder);
    if (pinnedGroups.has(key)) setOpen(true);
  }

  function renderItems(parent: HTMLElement, items: GroupItem[], rec: SegRecord, ns: string, max: number): void {
    const col = cssv('--border2') || '#2b3242';
    items.forEach((item, i) => {
      if (i > 0) {
        const conn = document.createElement('div');
        conn.className = 'conn';
        conn.append(makeConnSVG(col));
        parent.append(conn);
      }
      renderItem(parent, item, rec, ns, max);
    });
  }

  /** Longest item in a strip — the denominator every duration bar in it is drawn against. */
  const stripMax = (items: GroupItem[]): number => Math.max(1, ...items.map(itemMs));

  // First/last visible block of a body for arrow endpoints — a group block is as
  // valid an endpoint as a step block.
  const BLOCK_CLASSES = new Set<string>(['snode', 'gnode']);
  const walkBlocks = (root: HTMLElement): HTMLElement[] => walkClass(root, BLOCK_CLASSES);

  /** Glow the newest raw step of a live flow — main strip or a running lane. */
  function markLiveTail(container: HTMLElement): void {
    const blocks = walkBlocks(container);
    // noUncheckedIndexedAccess: blocks[last] is HTMLElement|undefined; guarded by && tail
    const tail = blocks[blocks.length - 1];
    // 'tail', NOT 'live': `.live` is the Live-activity BADGE's global class
    // (display:inline-flex, text-transform:uppercase, letter-spacing) and it is not
    // scoped, so it landed on this block — uppercasing its label and pushing the text
    // 11px out of its own box. Covered by tests/trace-css-scope.test.ts.
    if (tail && tail.classList && tail.className.includes('snode')) tail.classList.add('tail');
  }

  function buildBody(rec: SegRecord): void {
    if (rec.built) return;
    const m = rec.m;

    const dflow = document.createElement('div');
    dflow.className = 'dflow';
    rec.dflow = dflow; // main-strip root
    rec._spawnEls = new Map(); // spawnSpan.id → block element (filled by makeStepNode)
    rec._stepEls = new Map(); // span id → block element, for jumpToFailure
    const live = m.turn.state === 'live';
    const items = groupTurnSpans(m.path, { liveTail: live });
    renderItems(dflow, items, rec, '', stripMax(items));
    // The newest block of a live turn's raw tail glows — the "it is happening
    // here" marker while update() streams new spans in.
    if (live) markLiveTail(dflow);

    const lanesBox = document.createElement('div');
    lanesBox.className = 'lanes';
    rec.lanesBox = lanesBox;

    // The strip and its lanes share ONE horizontal scroller, so a lane stays under its
    // spawn at every scroll offset. Two scrollers would drift apart the moment the user
    // scrolled the strip, and the offsetLeft anchor would point at the wrong block.
    const scroller = document.createElement('div');
    scroller.className = 'striproll';
    scroller.append(dflow, lanesBox);
    rec.scroller = scroller;
    rec.tbody.append(scroller);
    renderLanes(rec); // …which re-applies the jump marker

    rec.built = true;
  }

  function toggleLane(rec: SegRecord, spawnId: string, spawnEl: HTMLElement): void {
    if (openLanes.has(spawnId)) openLanes.delete(spawnId);
    else openLanes.add(spawnId);
    const open = openLanes.has(spawnId);
    // In-place sync of the state a rebuild would derive from openLanes.
    if (spawnEl && spawnEl.classList) spawnEl.classList.toggle('on', open);
    const spawnNode = spawnEl as TraceSpawnEl;
    if (spawnNode._traceSsBase != null) {
      const ss = walkClass(spawnEl, 'ss')[0];
      // ! proven: _traceHints is always set alongside _traceSsBase in makeStepNode
      if (ss)
        ss.textContent =
          spawnNode._traceSsBase + (open ? spawnNode._traceHints!.openHint : spawnNode._traceHints!.closedHint);
    }
    renderLanes(rec);
    scheduleAnchor();
  }

  /**
   * Render the open child lanes of a turn: one wrap per open spawn (holding one
   * strip per lane — a fan-out spawn shows EVERY lane), anchored under its spawn
   * block (offsetLeft; 0 under fake-dom, re-derived by anchorLanes). A
   * Task-style lane shows the child's own flow grouped with the SAME rule as the
   * main strip; a Workflow shows the bundle grid. The spawnEl↔wrap pairing is
   * recorded on rec._laneWraps so anchorLanes can re-derive the offset.
   */
  function renderLanes(rec: SegRecord): void {
    const lanesBox = rec.lanesBox;
    if (!lanesBox) return;
    lanesBox.replaceChildren();
    rec._laneWraps = [];
    rec.m.spawnGroups.forEach((sg) => {
      if (!openLanes.has(sg.spawnSpan.id)) return;
      const spawnEl = rec._spawnEls ? rec._spawnEls.get(sg.spawnSpan.id) : null;
      if (!spawnEl) return;
      const wrap = document.createElement('div');
      const rawLanes: TraceLane[] = sg.spawnGroup ? sg.spawnGroup.lanes : [];
      if (sg.spawnGroup && sg.spawnGroup.kind === 'Workflow') {
        const grid = document.createElement('div');
        grid.className = 'wf-grid';
        rawLanes.forEach((ln: TraceLane, k: number) => {
          const mini = document.createElement('div');
          mini.className = 'amini' + (ln.status === 'error' ? ' err' : '');
          mini.textContent = String(k);
          const spawnToolUseId =
            sg.spawnSpan.handle && 'toolUseId' in sg.spawnSpan.handle ? sg.spawnSpan.handle.toolUseId : undefined;
          mini.onclick = () => onBlock({ kind: 'subagent', agentId: ln.agentId ?? null, toolUseId: spawnToolUseId });
          // A Workflow lane draws a tile, not a strip, so its spans have no block of their
          // own — the tile IS what stands for them. Registering it keeps the failure badge
          // honest: it counts lane failures, and a count that cannot be reached is a dead
          // end (the click did nothing at all before this).
          if (rec._stepEls) for (const s of ln.spans) rec._stepEls.set(s.id, mini);
          grid.append(mini);
        });
        wrap.append(grid);
      } else if (rawLanes.length === 0 || rawLanes.every((ln) => !ln.spans.length)) {
        const strip = document.createElement('div');
        strip.className = 'lane-strip';
        const note = document.createElement('div');
        note.className = 'lane-empty';
        // LIMIT: async/background subagents write no child jsonl — only the
        // parent-side summary exists (see span-store applyChildEvent).
        note.textContent = 'no child events (background agent)';
        strip.append(note);
        wrap.append(strip);
      } else {
        // A merged parallel block stacks the lanes of SEVERAL spawns under one block, so
        // every lane must be named even when its own spawn has just one — otherwise eight
        // identical strips appear with nothing to tell them apart.
        const merged = spawnEl.className.includes('par');
        // One strip per lane: a fan-out spawn renders every subagent's flow.
        rawLanes.forEach((ln: TraceLane) => {
          if (rawLanes.length > 1 || merged) {
            const name = document.createElement('div');
            name.className = 'lane-name';
            // Under a merged block the lane's own label repeats across the run, so the
            // launch intent is what actually distinguishes them.
            const intent = merged ? short(sg.spawnSpan.detail || sg.spawnSpan.label, 40) : '';
            name.textContent = '⑃ ' + (merged && intent ? intent + ' — ' : '') + (ln.label || 'subagent');
            const spToolUseId =
              sg.spawnSpan.handle && 'toolUseId' in sg.spawnSpan.handle ? sg.spawnSpan.handle.toolUseId : undefined;
            name.onclick = () => onBlock({ kind: 'subagent', agentId: ln.agentId ?? null, toolUseId: spToolUseId });
            wrap.append(name);
          }
          const strip = document.createElement('div');
          strip.className = 'lane-strip';
          if (ln.spans.length) {
            // The child's own flow, grouped with the SAME rule as the main strip;
            // keys are namespaced per lane so pins never collide across strips.
            // While the subagent RUNS (turn live, no agent-end status yet) the
            // lane keeps its tail raw and glowing, like the main strip.
            const running = rec.m.turn.state === 'live' && !ln.status;
            const laneSpans: TraceSpan[] = ln.spans.map((x) =>
              x.type === 'subspan' ? { ...x, type: 'tool' as const } : x,
            );
            const laneItems = groupTurnSpans(laneSpans, { liveTail: running });
            renderItems(
              strip,
              laneItems,
              rec,
              'lane:' + sg.spawnSpan.id + ':' + (ln.agentId ?? '') + ':',
              stripMax(laneItems),
            );
            if (running) markLiveTail(strip);
          } else {
            const note = document.createElement('div');
            note.className = 'lane-empty';
            note.textContent = 'no child events (background agent)';
            strip.append(note);
          }
          wrap.append(strip);
        });
      }
      // Anchor under the spawn block; anchorLanes re-derives this whenever an
      // in-place expansion shifts the strip.
      const left = typeof spawnEl.offsetLeft === 'number' ? spawnEl.offsetLeft : 0;
      wrap.style.marginLeft = Math.max(0, left - 8) + 'px';
      lanesBox.append(wrap);
      rec._laneWraps!.push({ spawnEl, wrap }); // ! proven: rec._laneWraps = [] assigned above
    });
    applyHit();
  }

  function toggleTurn(i: number): void {
    const rec = _segs[i];
    if (!rec) return;
    if (openTurns.has(i)) {
      openTurns.delete(i);
      rec.seg.classList.remove('open');
    } else {
      openTurns.add(i);
      if (!rec.built) buildBody(rec);
      rec.seg.classList.add('open');
    }
    scheduleAnchor();
  }

  /**
   * Every failed span of a turn, in strip order: main strip first, then each lane.
   * The lane entries carry what has to be unfolded to reach them, which is why a
   * failure inside a subagent — the kind that is hardest to find by hand — is reachable.
   */
  function failTargets(m: TurnModel): FailTarget[] {
    const out: FailTarget[] = m.path
      .filter((s) => s.status === 'error')
      .map((s) => ({ spanId: s.id, ns: '', spawnSpanId: null }));
    for (const sg of m.spawnGroups) {
      for (const lane of sg.lanes) {
        for (const s of lane.spans) {
          if (s.status !== 'error') continue;
          out.push({
            spanId: s.id,
            ns: 'lane:' + sg.spawnSpan.id + ':' + (lane.subspan.agentId ?? '') + ':',
            spawnSpanId: sg.spawnSpan.id,
          });
        }
      }
    }
    return out;
  }

  /**
   * Open everything needed to put one failed step on screen, then highlight it.
   *
   * The count alone made the badge a dead end: reaching a failure by hand took 7 clicks
   * on a measured turn (chapter → round → step, once per failure), and the `expand`
   * alternative left a 33,000px strip to scan. Repeated clicks cycle through the turn's
   * failures, so the badge answers "which ones?" as well as "how many?".
   */
  function jumpToFailure(rec: SegRecord): void {
    const targets = failTargets(rec.m);
    if (!targets.length) return;
    const cursor = (_failCursor.get(rec.i) ?? -1) + 1;
    _failCursor.set(rec.i, cursor % targets.length);
    const t = targets[cursor % targets.length]!; // ! proven: modulo of a non-empty array

    const mainItems = groupTurnSpans(rec.m.path, { liveTail: rec.m.turn.state === 'live' });

    // Pin the groups that hide it BEFORE rebuilding: pinnedGroups is what survives a
    // rebuild, so writing the path there is what makes the block exist afterwards.
    if (t.spawnSpanId) {
      // A merged run is ONE block on screen, and it opens as one: unfolding a single
      // spawn of it left the lane hanging under a block still reading "▸ expand flow",
      // whose next click then opened the whole run instead of closing it.
      const run = mainItems.find((it) => it.kind === 'parallel' && it.spans.some((s) => s.id === t.spawnSpanId));
      if (run && run.kind === 'parallel') for (const s of run.spans) openLanes.add(s.id);
      else openLanes.add(t.spawnSpanId);
    }
    const strip = t.ns
      ? (() => {
          const sg = rec.m.spawnGroups.find((g) => g.spawnSpan.id === t.spawnSpanId);
          const lane = sg?.lanes.find((l) => l.spans.some((s) => s.id === t.spanId));
          const spans = (lane?.spans ?? []).map((x) => (x.type === 'subspan' ? { ...x, type: 'tool' as const } : x));
          return groupTurnSpans(spans, { liveTail: rec.m.turn.state === 'live' && !lane?.subspan.status });
        })()
      : mainItems;
    for (const id of groupPathToSpan(strip, t.spanId) ?? []) {
      pinnedGroups.add(rec.m.turn.index + ':' + t.ns + id);
    }

    if (!openTurns.has(rec.i)) openTurns.add(rec.i);
    // Jumping is navigation, as deliberate as a scroll: auto-follow has to let go, or the
    // next live event scrolls the failure the user just asked for straight off the screen
    // (measured: back to the last turn ~1s later, on a session emitting an event a second).
    _following = false;
    syncFollowBtn();
    _hitSpanId = t.spanId;
    build(); // rebuild with the pins applied; _segs is replaced, applyHit() re-marks

    const fresh = _segs[rec.i];
    const el = fresh && fresh._stepEls ? fresh._stepEls.get(t.spanId) : null;
    if (!el) return;
    // scrollIntoView moves the stage; record where it landed so the resulting scroll
    // event is recognised as ours (follow is already released, but _expectedTop must
    // keep naming the controller's own last scroll).
    if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center', inline: 'center' });
    if (stageEl) _expectedTop = stageEl.scrollTop;
  }

  /** Collapse every open turn — the only useful bulk action on a long session. */
  function collapseAllTurns(): void {
    for (const rec of [..._segs]) if (openTurns.has(rec.i)) toggleTurn(rec.i);
  }

  /** Expand the newest turn if it is closed (idempotent). */
  function openLastTurn(): void {
    if (!_segs.length) return;
    const last = _segs[_segs.length - 1]!; // ! proven: _segs.length > 0 (checked above)
    if (!openTurns.has(last.i)) toggleTurn(last.i);
  }

  /**
   * Show `follow` only when it has something to do: a whole-session open, not currently
   * following, on a session that is still WORKING.
   *
   * Auto-follow only ever acts through update(), which a finished session never calls —
   * so on one, the button did nothing but jump to the last turn, duplicating `Last turn`
   * (which also opens it). A control that does another control's job is worse than absent.
   */
  function syncFollowBtn() {
    if (!followBtn) return;
    const live = _model.some((m) => m.isLive);
    followBtn.classList.toggle('hidden', _following || _scopeTurn != null || !live);
  }

  /**
   * Name the session by its first turn that did WORK. `turns[0].title` named 88% of
   * sessions (53 of 60 measured) after a control command — the header read "/clear" or
   * "opus" while the picker, reading the same session, showed its real subject.
   * A scoped open has exactly one turn, which is the right title by construction.
   */
  function setSubject(snap: TraceSnapshot): void {
    if (!hsubjEl) return;
    const named = snap.turns.find((t) => t.spans.some((s) => s.lane === 0 && (s.type === 'api' || s.type === 'tool')));
    hsubjEl.textContent = short((named ?? snap.turns[0])?.title ?? 'session', 90);
  }

  // ── Controller API ────────────────────────────────────────────────────────────

  /**
   * Open (or re-open with a new session). Resets expanded turns, forks and scroll,
   * then builds the diagram. If scopeTurn is set, only that turn is shown (no auto-follow).
   * For whole-session opens (scopeTurn == null), the LAST turn is expanded and focused,
   * and _following is enabled so update() tracks the newest turn live.
   */
  function open(snap: TraceSnapshot, scopeTurn: number | null | undefined, ended = false): void {
    _snap = snap;
    _ended = ended;
    _scopeTurn = scopeTurn ?? null;

    _model = adaptSnapshot(snap, _scopeTurn);

    // Reset per-session state. The failure cursor and the jump marker belong to the
    // session too: keyed by MODEL index, they name a different turn after a re-open
    // (a scoped open makes index 0 some other turn), so the first badge click would
    // start mid-cycle and an old marker could reappear on an unrelated span.
    openTurns.clear();
    openLanes.clear();
    pinnedGroups.clear();
    _failCursor.clear();
    _hitSpanId = null;

    if (_scopeTurn == null) {
      // Whole-session: focus the newest turn and enable auto-follow.
      const lastIdx = _model.length > 0 ? _model.length - 1 : 0;
      openTurns.add(lastIdx);
      _following = true;
    } else {
      // Scoped to a single turn: show turn 0, no follow.
      openTurns.add(0);
      _following = false;
    }

    ensureModal();
    // ! proven: ensureModal() assigns scrimEl and modalEl unconditionally
    scrimEl!.classList.add('on');
    modalEl!.classList.add('on');
    _isOpen = true;

    setSubject(snap);
    syncFollowBtn();
    if (modalEl) modalEl.classList.toggle('dense', _dense);
    build();
    setScrollTop(0);
    if (_following) raf(focusLastTurn);
  }

  /**
   * Re-render with an updated snapshot, preserving the expanded turn set, the fork-open
   * set and the scroll position. Called during live session updates.
   *
   * Scope note: _scopeTurn is fixed at open() time; the snapshot graph.ts passes is
   * already scoped by spanStore.snapshot(selectedTurn), so the internal re-filter below
   * is a defensive no-op that costs nothing but prevents a stale scope from slipping through.
   */
  function update(snap: TraceSnapshot, ended = false): void {
    if (!_isOpen) return;
    _snap = snap;
    _ended = ended;
    _model = adaptSnapshot(snap, _scopeTurn);
    // While following (whole-session, no manual scroll), keep the newest turn expanded and in view.
    if (_following && _scopeTurn == null && _model.length > 0) {
      openTurns.add(_model.length - 1);
    }
    // build() replaces the spine, which resets scrollTop; restore it so a user reading a
    // turn halfway up the session is not thrown back to the top by every live event.
    const keepTop = stageEl ? stageEl.scrollTop : 0;
    // …and the same for each open turn's strip, which is a SEPARATE scroller and was not
    // restored: a strip is p50 far wider than the stage (measured 8,974px against 1,288px
    // visible), so every live event sent a user reading its tail back to its first block.
    const keepLeft = new Map<number, number>();
    for (const rec of _segs) {
      const left = rec.scroller ? rec.scroller.scrollLeft : 0;
      if (typeof left === 'number' && left > 0) keepLeft.set(rec.i, left);
    }
    // The follow button's visibility depends on the model — a session that ENDS while the
    // Trace is open must lose it, since auto-follow acts only through this very function.
    syncFollowBtn();
    build(); // openTurns / openLanes / pinnedGroups are preserved
    // Before focusLastTurn, which deliberately overrides the live turn's own strip by
    // scrolling it fully right — the tail is where a live turn's work is.
    for (const rec of _segs) {
      const left = keepLeft.get(rec.i);
      if (left != null && rec.scroller) rec.scroller.scrollLeft = left;
    }
    if (_following && _scopeTurn == null) raf(focusLastTurn);
    else if (keepTop) setScrollTop(keepTop);
  }

  /** Close the modal. isOpen() returns false immediately. */
  function close(): void {
    if (!modalEl) return;
    // scrimEl is always set with modalEl (proven by ensureModal co-assignment)
    scrimEl!.classList.remove('on');
    modalEl.classList.remove('on');
    _isOpen = false;
  }

  /**
   * Remove the listeners registered in ensureModal() and mark the controller as closed.
   * Call from the owning graph.ts tab's destroy() to prevent listener leaks when tabs
   * are torn down (each tab creates its own controller).
   */
  function destroy() {
    if (typeof window !== 'undefined' && onWinKeyDown) window.removeEventListener('keydown', onWinKeyDown);
    if (stageEl && onStageScroll && stageEl.removeEventListener) stageEl.removeEventListener('scroll', onStageScroll);
    _isOpen = false;
  }

  // _releaseFollow is TEST-ONLY: fake-dom cannot deliver a real scroll gesture.
  return {
    open,
    update,
    close,
    isOpen: () => _isOpen,
    destroy,
    _releaseFollow: () => {
      _following = false;
      syncFollowBtn();
    },
  };
}
