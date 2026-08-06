import type { CompareRow, CompareWindow, Comparison } from '../core/types.ts';
import { COMPARE_TOP_N } from '../core/types.ts';

// The Compare tab: which session weighed the most in a time window. The unit is a token
// count weighted by the kind of token and by the model that spent it — NEVER a cost in dollars,
// and never named as an "equivalent" of some model (Davide, 2026-07-28): the "how this is
// computed" block carries the explanation instead of a unit label.
//
// Built with DOM nodes + textContent only (never innerHTML), like home-view.ts, so a
// corpus-derived string — a session's own prompt — can never inject markup. Every class is
// `cmp-`-prefixed; the shell reuses Home's `rt-` cards, since the two are the same kind of page.

type WinKey = 'all' | 'd30' | 'd7';

const WINDOWS: { key: WinKey; label: string }[] = [
  { key: 'd7', label: '7 days' },
  { key: 'd30', label: '30 days' },
  { key: 'all', label: 'all' },
];

// Cool tones only, matching home-view's by-model palette: a model must never read as a severity.
const MODEL_COLORS: Record<string, string> = {
  Opus: '#a78bfa',
  Sonnet: '#2dd4bf',
  Haiku: '#f472b6',
  Fable: '#818cf8',
  other: '#8593ad',
};
const FAMILY_ORDER = ['Fable', 'Opus', 'Sonnet', 'Haiku', 'other'];

/** The per-model factors, spelled out in the explainer in the order the price list ranks them. */
const MODEL_FACTORS: { family: string; factor: string }[] = [
  { family: 'Haiku', factor: '×1' },
  { family: 'Sonnet', factor: '×2–3' },
  { family: 'Opus', factor: '×5' },
  { family: 'Fable', factor: '×10' },
];

/** Compact count: 11k, 6.2M, 1.4B — the same rule as home-view.ts, so two surfaces never print
 * the same number differently. */
function fmt(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(Math.round(n));
}
const pct = (part: number, whole: number): string => (whole ? Math.round((100 * part) / whole) : 0) + '%';

/** `claude-opus-4-8` → `Opus`. The bars group by FAMILY: five slivers of the same colour would
 * say nothing, and the factor that matters (×5) is the family's. */
function familyOf(model: string): string {
  const m = /^claude-([a-z]+)/.exec(model);
  if (!m) return 'other';
  const f = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1);
  return FAMILY_ORDER.includes(f) ? f : 'other';
}

/** `claude-opus-4-8` → `Opus 4.8`; keeps an unusual id readable rather than dropping it. The same
 * rule home-view.ts uses, so one model never appears under two names across the app. */
function modelLabel(id: string): string {
  const m = /^claude-([a-z]+)-(.+)$/.exec(id);
  if (!m) return id.replace(/^<|>$/g, '');
  const family = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1);
  const ver = m[2]!.split('-').filter((part) => /^\d{1,2}$/.test(part)); // version parts, not a date suffix
  return ver.length ? `${family} ${ver.join('.')}` : family;
}

function ago(ts: number, now: number): string {
  const mins = Math.round((now - ts) / 6e4);
  if (mins < 60) return Math.max(0, mins) + 'm ago';
  const h = Math.round(mins / 60);
  return h < 24 ? h + 'h ago' : Math.round(h / 24) + 'd ago';
}

function el(tag: string, className?: string, text?: string): HTMLElement {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

/** A session's label: its first task-bearing prompt on one line, or what it is when it has none
 * (95 of 996 local sessions have no subject — an sdk run such as the docs gate). */
function labelOf(row: CompareRow): string {
  if (row.subject) return row.subject.replace(/\s+/g, ' ').trim();
  if (row.entrypoint && row.entrypoint.startsWith('sdk')) return 'Automated run · ' + row.entrypoint;
  return 'Session ' + row.sessionId.slice(0, 8);
}

/** A row's weight by family, weight descending within FAMILY_ORDER for a stable bar. */
function familyMix(row: CompareRow): { family: string; share: number }[] {
  const by = new Map<string, number>();
  for (const m of row.byModel) by.set(familyOf(m.model), (by.get(familyOf(m.model)) ?? 0) + m.weight);
  return FAMILY_ORDER.filter((f) => (by.get(f) ?? 0) > 0).map((family) => ({
    family,
    share: (by.get(family) ?? 0) / row.weight,
  }));
}

export interface CompareViewDeps {
  /** Fetches the comparison; null when the request failed (the view then says so). */
  loadComparison: () => Promise<Comparison | null>;
  /** Opens a session's own tab. The leaderboard is where you find the session worth looking at,
   * so the row has to be the way in — reading it and then hunting the same name in the picker is
   * the step the surface exists to remove. */
  onOpenSession: (sessionId: string) => void;
}

export interface CompareView {
  /** Re-fetch and re-render. Called on mount and whenever the corpus may have moved. */
  refresh: () => Promise<void>;
}

/** Mount the Compare tab into `host`. Fetches on `refresh()`; owns its window selection. */
export function createCompareView(host: HTMLElement, deps: CompareViewDeps): CompareView {
  let data: Comparison | null = null;
  // `all` by default (Davide, 2026-07-28): the question the surface answers is "which session
  // weighed the most", and starting on a 7-day slice hides the sessions that actually did.
  let win: WinKey = 'all';

  function row(r: CompareRow, max: number, now: number, isTop: boolean): HTMLElement {
    const n = el('div', 'cmp-row' + (isTop ? ' cmp-top' : ''));
    // A row opens the session it describes. Keyboard-reachable, because a div that only answers
    // the mouse is a button nobody can tab to.
    n.onclick = () => deps.onOpenSession(r.sessionId);
    n.tabIndex = 0;
    n.setAttribute('role', 'button');
    n.onkeydown = (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        deps.onOpenSession(r.sessionId);
      }
    };
    n.append(el('div', 'cmp-rank', String(r.rank)));

    const id = el('div', 'cmp-id');
    const label = labelOf(r);
    const subj = el('div', 'cmp-subj' + (r.subject ? '' : ' cmp-unnamed'), label);
    subj.title = label; // subjects run to 200 chars; the clamp must not lose the text
    id.append(subj);
    // ONE meta line holding everything. It fits again because the bar moved to a line of its own:
    // the chips no longer compete with it for width (they need ~660px of the ~1300 a full row has),
    // which is what three earlier column rebalances were fighting over.
    const meta = el('div', 'cmp-meta');
    const add = (text: string, cls?: string, title?: string) => {
      const span = el('span', cls, text);
      if (title) span.title = title;
      if (meta.children.length > 0) meta.append(el('span', 'cmp-sep', '·'));
      meta.append(span);
    };

    add(r.project, 'cmp-proj');
    // The MAIN thread's model belongs next to the project: both say what this session IS. `+N` when
    // it used more than one, so the dominant model is never presented as the whole truth.
    if (r.mainModel) {
      add(
        modelLabel(r.mainModel) + (r.mainModels > 1 ? ' +' + (r.mainModels - 1) : ''),
        'cmp-model',
        r.mainModels > 1
          ? 'the main thread\u2019s dominant model, of ' + r.mainModels + ' it used — subagents excluded'
          : 'the model the main thread ran on — subagents excluded',
      );
    }
    add(ago(r.lastTs, now));
    add(r.apiCalls + ' calls');
    // The UNWEIGHTED count, next to the calls that produced it: what the session actually put
    // through the model. The title spells out that it is the complete figure, since the row's
    // right-hand number is the weighted one and the two must not be confused.
    add(
      fmt(r.tokensComplete) + ' tokens',
      'cmp-tok',
      'complete tokens processed: input + cache write + cache read + output, every model, subagents included',
    );
    // Shown whenever there IS one, at no threshold: a subagent share is a fact about the session,
    // not a judgement about what deserves screen space, and "2% subagents" is as true as 24%.
    if (r.subagentWeight > 0) add(pct(r.subagentWeight, r.weight) + ' subagents', 'cmp-sub');
    // How far the weighting moved this session, from 3 places up. The cut is measured, not felt:
    // in the only window where it decides anything (7d, where nearly every session ran the same
    // model, so weighting multiplies them all alike) shifts of ±1 are 11 of the 14 rows that would
    // carry a chip — two sessions of near-identical weight trading places, which says nothing about
    // the weighting. At 30d and all, 12-13 rows clear 3 anyway. Approved by Davide 2026-07-28.
    const shift = r.rawRank - r.rank;
    if (Math.abs(shift) >= 3) {
      add((shift > 0 ? '▲' : '▼') + Math.abs(shift) + ' vs unweighted', 'cmp-shift' + (shift > 0 ? '' : ' cmp-down'));
    }
    // Clips with an ellipsis rather than wrapping, so every row is the same height. The full text
    // stays reachable on hover.
    meta.title = [
      r.project,
      r.mainModel ? modelLabel(r.mainModel) : null,
      ago(r.lastTs, now),
      r.apiCalls + ' calls',
      fmt(r.tokensComplete) + ' tokens',
    ]
      .filter((x): x is string => x !== null)
      .join(' · ');
    id.append(meta);
    n.append(id);

    const track = el('div', 'cmp-track');
    const fill = el('div', 'cmp-fill');
    fill.style.width = Math.max(1.5, (100 * r.weight) / max) + '%';
    for (const m of familyMix(r)) {
      if (m.share <= 0.004) continue; // a sliver under half a percent is a smudge, not information
      const seg = el('i');
      seg.style.width = m.share * 100 + '%';
      seg.style.background = MODEL_COLORS[m.family] ?? MODEL_COLORS.other!;
      seg.title = m.family + ' ' + pct(m.share, 1);
      fill.append(seg);
    }
    track.append(fill);
    n.append(track, el('div', 'cmp-val', fmt(r.weight)));
    return n;
  }

  /** The explanation that replaces a unit label: what the number is, and whose each factor is. */
  function explainer(): HTMLElement {
    const box = el('div', 'cmp-src');
    box.append(el('div', 'cmp-src-h', 'how this is computed'));
    box.append(
      el(
        'p',
        'cmp-lede',
        'Each API call is counted once, weighted twice — by the kind of token it spent and by the ' +
          'model that spent it — then summed over the session and every subagent it launched.',
      ),
    );

    const grid = el('div', 'cmp-expl');
    grid.append(el('div', 'cmp-el', 'per token type'));
    const typeRow = el('div', 'cmp-ev');
    typeRow.append(el('code', undefined, 'cache read ×0.1 · cache write ×2 · input ×1 · output ×5'));
    const cite = el('a', 'cmp-cite', 'Anthropic burndown rates') as HTMLAnchorElement;
    cite.href = 'https://platform.claude.com/docs/en/api/service-tiers';
    cite.target = '_blank';
    cite.rel = 'noreferrer';
    typeRow.append(cite);
    grid.append(typeRow);

    grid.append(el('div', 'cmp-el', 'per model'));
    const modelRow = el('div', 'cmp-ev');
    const chips = el('span', 'cmp-chips');
    for (const f of MODEL_FACTORS) {
      const chip = el('span', 'cmp-chip');
      const k = el('span', 'cmp-k');
      k.style.background = MODEL_COLORS[f.family] ?? MODEL_COLORS.other!;
      chip.append(k, document.createTextNode(f.family + ' ' + f.factor));
      chips.append(chip);
    }
    modelRow.append(chips, el('span', 'cmp-cite cmp-ours', 'seedeep’s own, from the price list'));
    grid.append(modelRow);
    box.append(grid);

    box.append(
      el(
        'p',
        'cmp-lede cmp-last',
        'The result stays a token count — a heavier model simply counts for more. It is never a cost ' +
          'in dollars, and Anthropic publishes no official ratio between models.',
      ),
    );
    return box;
  }

  function segmented(): HTMLElement {
    const box = el('div', 'rt-seg');
    for (const w of WINDOWS) {
      const b = el('button', w.key === win ? 'on' : '', w.label);
      b.onclick = () => {
        win = w.key;
        render();
      };
      box.append(b);
    }
    return box;
  }

  function render(): void {
    // `replaceChildren`, never `textContent = ''`: the same idiom as home-view, and the only one
    // that actually swaps a subtree in one call (a cleared-then-appended host renders twice).
    if (!data) {
      host.replaceChildren(el('div', 'rt-empty', 'No comparison yet — seedeep is reading your sessions.'));
      return;
    }
    const w: CompareWindow = data.windows[win];
    const now = data.generatedAt;
    const root = el('div', 'cmp-root rt-root');

    const head = el('div', 'rt-head');
    const left = el('div');
    left.append(el('div', 'rt-kick', 'compare sessions'));
    const title = el('h1', 'rt-title');
    title.append(document.createTextNode('Which session weighed '), el('b', undefined, 'the most'));
    left.append(title);
    left.append(
      el(
        'div',
        'rt-scope',
        w.sessions +
          ' session' +
          (w.sessions === 1 ? '' : 's') +
          ' in window · tokens weighted by model · main + subagents',
      ),
    );
    head.append(left);
    const filter = el('div', 'rt-filter');
    filter.append(el('span', 'rt-seglbl', 'window'), segmented());
    head.append(filter);
    root.append(head);

    const grid = el('div', 'rt-grid');
    if (w.sessions === 0) {
      grid.append(el('div', 'rt-empty', 'No session in this window.'));
      root.append(grid);
      host.replaceChildren(root);
      return;
    }
    const card = el('div', 'rt-card cmp-rank-card');
    const ctitle = el('div', 'rt-ctitle');
    ctitle.append(el('span', undefined, 'weight by session'));
    const legend = el('div', 'cmp-legend');
    const famTotal = new Map<string, number>();
    for (const m of w.byModel) famTotal.set(familyOf(m.model), (famTotal.get(familyOf(m.model)) ?? 0) + m.weight);
    for (const family of FAMILY_ORDER) {
      const weight = famTotal.get(family) ?? 0;
      if (weight <= 0) continue;
      const item = el('span');
      const k = el('span', 'cmp-k');
      k.style.background = MODEL_COLORS[family] ?? MODEL_COLORS.other!;
      // never "0%" for a family that IS present — a rounded-away share is "<1%"
      item.append(
        k,
        el('b', undefined, family),
        document.createTextNode(' ' + (weight / w.weight < 0.005 ? '<1%' : pct(weight, w.weight))),
      );
      legend.append(item);
    }
    ctitle.append(legend);
    card.append(ctitle);

    const list = el('div');
    list.style.marginTop = '.85rem';
    const max = w.top[0]?.weight ?? 1;
    w.top.forEach((r, i) => list.append(row(r, max, now, i === 0)));
    card.append(list);
    // What the top-N cut left out, always stated: a truncated leaderboard that says nothing
    // reads as "this is all of it".
    if (w.restSessions > 0) {
      const note = el(
        'div',
        'rt-note',
        '+ ' +
          w.restSessions +
          ' lighter session' +
          (w.restSessions === 1 ? '' : 's') +
          ', ' +
          fmt(w.restWeight) +
          ' together (' +
          pct(w.restWeight, w.weight) +
          ')',
      );
      note.style.marginTop = '.7rem';
      card.append(note);
    }
    card.append(explainer());
    grid.append(card);
    root.append(grid);
    host.replaceChildren(root);
  }

  async function refresh(): Promise<void> {
    const next = await deps.loadComparison();
    if (next) data = next;
    render();
  }

  render();
  return { refresh };
}

/** Re-exported so a caller can state how many rows a window carries without importing types.ts. */
export { COMPARE_TOP_N };
