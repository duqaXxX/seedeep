import type { Retrospective, RetroWindow } from '../core/types.ts';
import { HIST_BINS } from '../core/types.ts';

// The minute-zero retrospective, rendered into the pinned Home tab as a dashboard: KPI tiles,
// the turn-size distribution (the hero — the shape of how you spend NEW tokens), weekly activity,
// where the waste comes from, tokens by model, tool calls by type, and the verdict split. A time
// filter (7d / 30d / all) switches window client-side — all three windows ride in one
// `/api/retro` response, no refetch. Built with DOM nodes + textContent only (never innerHTML),
// so a corpus-derived number can never inject markup. Every class is `rt-`-prefixed: index.html
// has no CSS scoping and its graph/drawer rules reuse generic names that would otherwise collide.
//
// Colour discipline (a past confusion): severity means ONE thing everywhere — crit=red, warn=amber,
// clean=blue. The histogram is single-colour (a distribution is not a severity). The by-model split
// uses a deliberately COOL palette (violet/teal/pink…), never the severity colours.

type WinKey = 'all' | 'd30' | 'd7';
type MetricKey = 'tokens' | 'turns' | 'hours';

type Week = Retrospective['weeks'][number];

/** The three readings of a week's work, switched by the tabs in the activity card's title.
 * `stacked` splits the bar by severity (turns only — tokens and hours are not severities). */
const WEEK_METRICS: {
  key: MetricKey;
  label: string;
  hint: (g: 'day' | 'week') => string;
  stacked: boolean;
  value: (w: Week) => number;
  show: (w: Week) => string;
}[] = [
  {
    key: 'tokens',
    label: 'tokens',
    hint: (g) => `tokens / ${g} · incl. cache`,
    stacked: false,
    value: (w) => w.tokens,
    show: (w) => fmt(w.tokens),
  },
  {
    key: 'turns',
    label: 'turns',
    hint: (g) => `turns / ${g}`,
    stacked: true,
    value: (w) => w.crit + w.warn + w.good,
    show: (w) => String(w.crit + w.warn + w.good),
  },
  {
    key: 'hours',
    label: 'hours',
    hint: (g) => `working time / ${g}`,
    stacked: false,
    value: (w) => w.workMs,
    show: (w) => dur(w.workMs),
  },
];

// Model swatch colours — cool tones, kept off the severity palette so a model can't read as crit.
const MODEL_COLORS = ['#a78bfa', '#2dd4bf', '#f472b6', '#818cf8', '#8593ad'];

/** Compact token count: 11k, 6.2M, 1.4B. */
function fmt(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(Math.round(n));
}
/** Working time: hours once past an hour, else minutes. */
function dur(ms: number): string {
  return ms >= 36e5 ? Math.round(ms / 36e5) + 'h' : Math.round(ms / 6e4) + 'm';
}
const pct = (part: number, whole: number): string => (whole ? Math.round((100 * part) / whole) : 0) + '%';

/** A raw model id → a short label: claude-opus-4-8 → "Opus 4.8"; keeps unusual ids readable. */
function modelLabel(id: string): string {
  if (!id || id === 'unknown') return 'unknown';
  const m = id.match(/^claude-([a-z]+)-(.+)$/);
  if (!m) return id.replace(/^<|>$/g, ''); // e.g. "<synthetic>" → "synthetic"
  const family = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1);
  const ver = m[2]!.split('-').filter((p) => /^\d{1,2}$/.test(p)); // version parts, not a date suffix
  return ver.length ? `${family} ${ver.join('.')}` : family;
}

function el(tag: string, className?: string, text?: string): HTMLElement {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

/**
 * The WORD only — the number is rendered separately, in its own element and its own colour.
 *
 * Local rather than shared: the two other spellings of this in the client (`turnsWord` in graph.ts,
 * `plural` in trace.ts) sit in modules this one has no reason to import, and three lines beat the
 * dependency. It exists because the title read `1 turns across 1 sessions` — worst on the corpus a
 * newcomer has, which is exactly one session.
 */
function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}

/** True when the payload is a real Retrospective with at least one finished turn. */
function hasCorpus(r: Retrospective | null): r is Retrospective {
  return !!r && !!r.windows?.all && r.windows.all.turns > 0 && !!r.baseline?.overall;
}

// Log position (0–100%) of a token count across the histogram's bins — for the p50/p95 markers.
function histPos(x: number): number {
  for (let i = 0; i < HIST_BINS.length; i++) {
    const b = HIST_BINS[i]!;
    if (x >= b.min && x < b.max) {
      const hi = b.max === Infinity ? b.min * 3 : b.max;
      const f = (Math.log(Math.max(1, x)) - Math.log(b.min || 1)) / (Math.log(hi) - Math.log(b.min || 1) || 1);
      return ((i + Math.max(0, Math.min(1, f))) / HIST_BINS.length) * 100;
    }
  }
  return 99;
}

/** One KPI tile. `variant` is an extra rt-class (rt-accent / rt-crit). */
function kpi(variant: string, num: string, label: string, sub: string): HTMLElement {
  const cardEl = el('div', 'rt-card rt-kpi' + (variant ? ' ' + variant : ''));
  cardEl.append(el('div', 'rt-num', num), el('div', 'rt-lbl', label), el('div', 'rt-sub', sub));
  return cardEl;
}

/** A card with a mono eyebrow title + a right-aligned hint. `cls` is the layout rt-class. */
function card(cls: string, title: string, hint: string): HTMLElement {
  const c = el('div', 'rt-card ' + cls);
  const t = el('div', 'rt-ctitle');
  t.append(el('span', undefined, title), el('span', 'rt-hint', hint));
  c.append(t);
  return c;
}

/** One labelled horizontal bar row (waste / tools). `fill` tints the bar (rt-fill-*). */
function barRow(label: string, n: number, max: number, fill: string): HTMLElement {
  const row = el('div', 'rt-brow');
  const track = el('span', 'rt-btrack');
  const i = el('i', fill);
  i.style.width = Math.round((100 * n) / max) + '%';
  track.append(i);
  row.append(el('span', 'rt-bn', label), track, el('span', 'rt-bv', fmt(n)));
  return row;
}

/** A severity legend row (crit/warn/clean), optionally with values. */
function legend(items: { cls: string; label: string; value?: string }[]): HTMLElement {
  const l = el('div', 'rt-legend');
  for (const it of items) {
    const s = el('span');
    s.append(el('span', 'rt-k ' + it.cls));
    s.append(el('span', undefined, it.label + (it.value ? ' ' : '')));
    if (it.value) s.append(el('b', undefined, it.value));
    l.append(s);
  }
  return l;
}

export interface HomeViewOpts {
  /** Fetch the corpus retrospective. Returns null on any failure (never throws). */
  loadRetro: () => Promise<Retrospective | null>;
  /** The "Pick a session" CTA — opens the session picker. */
  onPickSession?: () => void;
  /**
   * How many sessions this machine HAS, from the roster — not from the retrospective.
   *
   * The two disagree by design, and the empty state is the one place where the difference is
   * visible to a reader: `Retrospective.sessions` counts only sessions that produced a finished
   * turn (`aggregate()` filters on `turns.length > 0`), so a transcript that exists but has not
   * closed a turn is 0 there and 1 in the picker directly above this box. Measured on a truncated
   * transcript: roster 1, retro 0. Reading the retro here would print "there is none on this
   * machine" over a picker showing one.
   *
   * Omitted (or 0) means "nothing known" and the box says only what it can defend.
   */
  sessionsOnDisk?: () => number;
}

export interface HomeView {
  /** Re-fetch and repaint. Called on mount and when new sessions land. */
  refresh(): void;
  /**
   * Repaint from what is already held — no fetch.
   *
   * The empty box reads the roster (see {@link HomeViewOpts.sessionsOnDisk}), and the roster
   * answers AFTER the first paint: on a machine with one unfinished session the box would
   * otherwise keep saying "there is none on this machine" for the life of the tab, over a picker
   * listing it. Separate from `refresh()` because that one re-scans the corpus, which is the
   * expensive thing the roster's poll is deliberately not allowed to trigger.
   */
  repaint(): void;
}

/**
 * Mount the retrospective dashboard into `container`. Fetches once on mount; `refresh()`
 * re-fetches. Renders an empty state (never a broken-looking blank) when the corpus has no
 * finished turns yet, or when the fetch fails.
 */
export function createHomeView(container: HTMLElement, opts: HomeViewOpts): HomeView {
  let data: Retrospective | null = null;
  let win: WinKey = 'all';
  let metric: MetricKey = 'tokens';

  // Stop the opening click from bubbling to the picker's document-level click-outside handler,
  // which would otherwise see a click outside the picker and close it on the same tick.
  const pick = (e?: Event) => {
    e?.stopPropagation?.();
    opts.onPickSession?.();
  };

  /**
   * The empty box, which opens with the REASON the page is empty rather than with the pitch.
   *
   * It has to be true in three situations that reach the same branch, and the old single sentence
   * ("No finished turns yet — run a Claude Code session…") was only true in one of them:
   *
   * - nothing on disk at all: the requirement is stated as the requirement;
   * - sessions ARE there but no turn has finished (`hasCorpus` wants `turns > 0`): saying "there is
   *   no session" would be a lie told to someone watching one run, so this branch says where that
   *   session is already watchable instead;
   * - the payload has not arrived, or failed: the same lead WITHOUT the claim about the machine —
   *   nothing has been read, so nothing can be asserted about what is on it.
   *
   * Which branch is taken comes from the ROSTER, never from the retrospective — see
   * {@link HomeViewOpts.sessionsOnDisk} for the measurement that forced that.
   *
   * The count is deliberately not printed: a number here is a fact about the corpus that the reader
   * has no use for, and it would be the third different way this page states one.
   */
  function emptyBox(): HTMLElement {
    const box = el('div', 'rt-empty');
    const known = opts.sessionsOnDisk?.() ?? 0;
    // "Read" means something answered: either the roster knows of sessions, or the retro payload
    // arrived. Both silent = nothing to describe.
    const read = known > 0 || !!data;
    const hasSessions = known > 0;

    const lead = el('div', 'rt-empty-lead');
    lead.textContent = hasSessions
      ? 'There are sessions here, none with a finished turn yet.'
      : read
        ? 'seedeep needs a Claude Code session. There is none on this machine yet.'
        : 'seedeep needs a Claude Code session.';

    const then = el('div', 'rt-empty-then');
    if (hasSessions) {
      then.append(
        document.createTextNode('A turn lands here the moment it ends — and the session itself is watchable '),
        el('b', undefined, 'now'),
        document.createTextNode(', from '),
        el('span', 'rt-strong', 'Open a session…'),
        document.createTextNode(' above.'),
      );
    } else {
      then.append(
        document.createTextNode('Run '),
        el('code', undefined, 'claude'),
        document.createTextNode(' in any project and leave this tab open: it fills in '),
        el('b', undefined, 'while'),
        document.createTextNode(' the turn runs, not after it ends.'),
      );
    }

    // The privacy line is attached to the thing that makes it checkable — the directory being
    // watched — rather than standing alone as a promise.
    const watch = el('div', 'rt-empty-watch');
    watch.append(
      el('span', 'rt-dot'),
      document.createTextNode('Watching '),
      el('code', undefined, '~/.claude/projects'),
      document.createTextNode(' · it reads the logs Claude Code writes there, and nothing leaves this machine.'),
    );

    box.append(lead, then, watch);
    return box;
  }

  function empty(): void {
    const root = el('div', 'rt-root');
    const head = el('div', 'rt-head');
    const h = el('div');
    h.append(el('div', 'rt-kick', 'seedeep · your Claude Code, so far'), el('div', 'rt-title', 'Your retrospective'));
    head.append(h);
    root.append(head, emptyBox());
    const foot = el('div', 'rt-foot');
    const cta = el('button', 'rt-cta', 'Pick a session →');
    cta.onclick = pick;
    foot.append(cta);
    root.append(foot);
    container.replaceChildren(root);
  }

  function paint(): void {
    if (!hasCorpus(data)) {
      empty();
      return;
    }
    const r = data;
    const w: RetroWindow = r.windows[win];
    const root = el('div', 'rt-root');

    // --- header: title, scope, time filter ---
    const head = el('div', 'rt-head');
    const htext = el('div');
    htext.append(el('div', 'rt-kick', 'seedeep · your Claude Code, so far'));
    const title = el('div', 'rt-title');
    title.append(
      el('b', undefined, w.turns.toLocaleString()),
      el(
        'span',
        undefined,
        win === 'all'
          ? ` ${plural(w.turns, 'turn')} across ${r.sessions.toLocaleString()} ${plural(r.sessions, 'session')}`
          : ` ${plural(w.turns, 'turn')}`,
      ),
    );
    const scopeLabel =
      win === 'd7' ? 'last 7 days' : win === 'd30' ? 'last 30 days' : `all-time · ${r.spanDays}d on disk`;
    htext.append(title, el('div', 'rt-scope', `${scopeLabel} · ${dur(w.workMs)} working`));
    const filter = el('div', 'rt-filter');
    filter.append(el('span', 'rt-seglbl', 'window'));
    const seg = el('div', 'rt-seg');
    for (const [key, label] of [
      ['d7', '7 days'],
      ['d30', '30 days'],
      ['all', 'All-time'],
    ] as const) {
      const b = el('button', key === win ? 'on' : undefined, label);
      b.setAttribute('data-w', key);
      b.onclick = () => {
        win = key;
        paint();
      };
      seg.append(b);
    }
    filter.append(seg);
    head.append(htext, filter);
    root.append(head);

    const grid = el('div', 'rt-grid');

    // KPI strip (6): median · tokens spent (complete) · API calls · wasteful % · esc · working
    grid.append(
      kpi('rt-accent', fmt(w.p50Complete), 'median turn', `complete · p95 ${fmt(w.p95Complete)}`),
      kpi('rt-accent', fmt(w.totalTokens), 'tokens spent', `${fmt(w.newTokens)} new · rest cache`),
      kpi('', fmt(w.apiCalls), 'API calls', `${fmt(toolTotal(r))} tool calls`),
      kpi(
        'rt-crit',
        pct(w.crit, w.turns),
        'turns wasted tokens',
        `${w.crit.toLocaleString()} of ${w.turns.toLocaleString()}`,
      ),
      kpi('rt-crit', fmt(w.esc.tokens), 'abandoned to Esc', `${w.esc.turns.toLocaleString()} interrupted`),
      kpi('', dur(w.workMs), 'spent working', `${w.turns.toLocaleString()} ${plural(w.turns, 'turn')}`),
    );

    // Hero: turn-size distribution (new tokens; single colour — not a severity)
    const hero = card('rt-hero', 'turn-size distribution', 'new tokens / turn · excl. cache reads');
    hero.append(histChart(w));
    grid.append(hero);

    // Activity cadence: one bar per day (7d window) or per calendar week (30d / all-time).
    const gran: 'day' | 'week' = win === 'd7' ? 'day' : 'week';
    const periods = win === 'd7' ? r.days : win === 'd30' ? r.weeks.slice(0, 5) : r.weeks;
    const act = el('div', 'rt-card rt-activity');
    const actTitle = el('div', 'rt-ctitle');
    const tabs = el('div', 'rt-mtabs');
    for (const m of WEEK_METRICS) {
      const b = el('button', m.key === metric ? 'on' : undefined, m.label);
      b.setAttribute('data-m', m.key);
      b.onclick = () => {
        metric = m.key;
        paint();
      };
      tabs.append(b);
    }
    actTitle.append(el('span', undefined, 'activity'), tabs);
    act.append(actTitle, weekChart(periods, metric, gran));
    const wl = el('div', 'rt-wklbl');
    if (gran === 'day') {
      wl.append(el('span', undefined, '6d ago'), el('span', undefined, 'today'));
    } else {
      wl.append(el('span', undefined, `${periods.length}w ago`), el('span', undefined, 'this week'));
    }
    act.append(wl);
    const mActive = WEEK_METRICS.find((m) => m.key === metric)!;
    act.append(
      mActive.stacked
        ? legend([
            { cls: 'rt-crit', label: 'crit' },
            { cls: 'rt-warn', label: 'warn' },
            { cls: 'rt-good', label: 'clean' },
          ])
        : legend([{ cls: 'rt-solid', label: mActive.hint(gran) }]),
    );
    grid.append(act);

    // Where the waste comes from. The hint carries the ONE reading a per-turn verdict cannot
    // give: how many tokens the corpus spent re-entering its own sessions rather than working,
    // and — the number Claude Code's own `/usage` flags at — how many sessions crossed 10%.
    const waste = card(
      'rt-third-wide',
      'where the waste comes from',
      w.resume.tokens > 0
        ? `${fmt(w.resume.tokens)} re-entering · ${r.reentrySessions} of ${r.sessions} ${plural(r.sessions, 'session')} over 10%`
        : 'turns flagged',
    );
    const wr = [
      { k: 'committed without tests', n: w.unverifiedShip, f: 'rt-fill-crit' },
      { k: 'context ≥70%', n: w.context, f: 'rt-fill-warn' },
      { k: 'explored, changed nothing', n: w.exploration, f: 'rt-fill-warn' },
      { k: 'resumed cold', n: w.resume.turns, f: 'rt-fill-warn' },
      // Interruptions the verdict flags — the SECOND in a row and beyond. A lone Esc is the
      // recommended course-correction, so counting all 176 here would contradict the lens.
      { k: 'corrected twice', n: w.escStreak, f: 'rt-fill-warn' },
      { k: 'big subagent', n: w.subWaste, f: 'rt-fill-crit' },
      { k: 'compaction', n: w.compaction, f: 'rt-fill-crit' },
    ];
    const wmax = Math.max(1, ...wr.map((x) => x.n));
    for (const x of wr) waste.append(barRow(x.k, x.n, wmax, x.f));
    grid.append(waste);

    // Tokens by model (cool palette, new tokens)
    grid.append(modelCard(w));

    // Tool calls by type (all-time)
    const toolsCard = card('rt-third-narrow', 'tool calls by type', `${fmt(toolTotal(r))} calls`);
    const shownTools = foldTop(
      r.tools.map((t) => ({ label: t.name, value: t.count })),
      7,
    );
    const tmax = Math.max(1, ...shownTools.map((t) => t.value));
    for (const t of shownTools) toolsCard.append(barRow(t.label, t.value, tmax, 'rt-fill-tool'));
    grid.append(toolsCard);

    // Verdict split + footer
    const verdict = card('rt-verdict', 'verdict split', `${w.turns.toLocaleString()} ${plural(w.turns, 'turn')}`);
    const good = Math.max(0, w.turns - w.crit - w.warn);
    const bar = el('div', 'rt-rbar');
    const seg2 = (n: number, cls: string) => {
      const i = el('i', cls);
      i.style.width = pct(n, w.turns);
      return i;
    };
    bar.append(seg2(w.crit, 'rt-crit'), seg2(w.warn, 'rt-warn'), seg2(good, 'rt-good'));
    verdict.append(
      bar,
      legend([
        { cls: 'rt-crit', label: 'crit', value: pct(w.crit, w.turns) },
        { cls: 'rt-warn', label: 'warn', value: pct(w.warn, w.turns) },
        { cls: 'rt-good', label: 'clean', value: pct(good, w.turns) },
      ]),
    );
    grid.append(verdict);

    const foot = el('div', 'rt-foot');
    const cta = el('button', 'rt-cta', 'Pick a session →');
    cta.onclick = pick;
    foot.append(el('span', 'rt-note', 'updates as new sessions land'), cta);
    grid.append(foot);

    root.append(grid);
    container.replaceChildren(root);
  }

  function refresh(): void {
    opts
      .loadRetro()
      .then((r) => {
        data = r;
        paint();
      })
      .catch(() => {
        data = null;
        paint();
      });
  }
  paint(); // immediate empty frame so the tab is never blank before the fetch resolves
  refresh();
  return { refresh, repaint: paint };
}

/** Total tool calls across the corpus (all-time). */
function toolTotal(r: Retrospective): number {
  return r.tools.reduce((s, t) => s + t.count, 0);
}

/** Keep the top `n` rows; fold the rest into one "other" row. */
function foldTop(rows: { label: string; value: number }[], n: number): { label: string; value: number }[] {
  if (rows.length <= n + 1) return rows;
  const top = rows.slice(0, n);
  const rest = rows.slice(n).reduce((s, x) => s + x.value, 0);
  return rest > 0 ? [...top, { label: 'other', value: rest }] : top;
}

function histChart(w: RetroWindow): HTMLElement {
  const host = el('div', 'rt-hist');
  const max = Math.max(1, ...w.hist);
  HIST_BINS.forEach((b, i) => {
    const n = w.hist[i] ?? 0;
    const bar = el('div', 'rt-hbar');
    bar.append(el('span', 'rt-hv', String(n)));
    const fill = el('i');
    fill.style.height = Math.round((100 * n) / max) + '%';
    bar.append(fill, el('span', 'rt-hl', b.label));
    host.append(bar);
  });
  for (const [p, x, cls] of [
    ['p50', w.p50, ''],
    ['p95', w.p95, 'rt-p95'],
  ] as const) {
    if (!x) continue;
    const m = el('div', 'rt-pmark ' + cls);
    m.style.left = histPos(x).toFixed(1) + '%';
    m.append(el('span', undefined, `${p} ${fmt(x)}`));
    host.append(m);
  }
  return host;
}

function weekChart(weeks: Week[], metric: MetricKey, granularity: 'day' | 'week'): HTMLElement {
  const m = WEEK_METRICS.find((x) => x.key === metric)!;
  const host = el('div', 'rt-weeks');
  const max = Math.max(1, ...weeks.map(m.value));
  const tipSuffix = (i: number) =>
    granularity === 'day' ? (i === 0 ? 'today' : i + 'd ago') : i === 0 ? 'this week' : i + 'w ago';
  for (let i = weeks.length - 1; i >= 0; i--) {
    // oldest left, newest right
    const wk = weeks[i]!;
    // The value rides in its own element above the bar: .rt-wk clips its stack, so a label
    // placed inside it would be cut off.
    const colWrap = el('div', 'rt-wkcol');
    colWrap.title = `${m.show(wk)} · ${tipSuffix(i)}`;
    const col = el('div', 'rt-wk');
    col.style.height = Math.round((100 * m.value(wk)) / max) + '%';
    if (m.stacked) {
      const t = wk.crit + wk.warn + wk.good;
      const stack = (n: number, cls: string) => {
        const s = el('i', cls);
        s.style.height = t ? (100 * n) / t + '%' : '0';
        return s;
      };
      col.append(stack(wk.good, 'rt-good'), stack(wk.warn, 'rt-warn'), stack(wk.crit, 'rt-crit'));
    } else {
      const fill = el('i', 'rt-solid');
      fill.style.height = '100%';
      col.append(fill);
    }
    colWrap.append(el('span', 'rt-wkv', m.show(wk)), col);
    host.append(colWrap);
  }
  return host;
}

function modelCard(w: RetroWindow): HTMLElement {
  const c = card('rt-third-narrow rt-model', 'tokens by model', `${fmt(w.totalTokens)} total · incl. cache`);
  const rows = foldTop(
    w.byModel.filter((m) => m.tokens > 0).map((m) => ({ label: modelLabel(m.model), value: m.tokens })),
    4,
  );
  const total = Math.max(
    1,
    rows.reduce((s, m) => s + m.value, 0),
  );
  const colorFor = (i: number, label: string) =>
    label === 'other' ? 'var(--lo)' : MODEL_COLORS[i % MODEL_COLORS.length]!;
  const bar = el('div', 'rt-mbar');
  rows.forEach((m, i) => {
    const seg = el('i');
    seg.style.width = (100 * m.value) / total + '%';
    seg.style.background = colorFor(i, m.label);
    bar.append(seg);
  });
  c.append(bar);
  const leg = el('div', 'rt-mleg');
  rows.forEach((m, i) => {
    const row = el('div', 'rt-mrow');
    const k = el('span', 'rt-k');
    k.style.background = colorFor(i, m.label);
    row.append(
      k,
      el('span', 'rt-mn', m.label),
      el('span', 'rt-mv', `${fmt(m.value)} · ${Math.round((100 * m.value) / total)}%`),
    );
    leg.append(row);
  });
  c.append(leg);
  return c;
}
