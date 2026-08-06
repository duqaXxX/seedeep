import type { SearchResponse, SearchRow, SearchSnippet } from '../core/types.ts';
import { createIdChip } from './id-chip.ts';
import { isAutomated } from './sessions.ts';

// The Search tab: which session talked about these words. Every typed word is an AND term, and
// what is searched is the DIALOGUE — what you asked and what Claude answered — never the raw
// transcript (injected instructions and tool results match twice as often and mean nothing).
//
// Built with DOM nodes + textContent only (never innerHTML), like compare-view/home-view: a row
// here renders a REAL prompt, so markup in the corpus must be impossible to execute. The `<mark>`
// highlighting builds element nodes around matched ranges for the same reason.
//
// Every class is `sr-`-prefixed (the app has no CSS scoping); the shell reuses Home's `rt-` cards.

/** How the rows are ordered. Each key sorts by the number the row DISPLAYS — a list ranked on
 * something other than what it shows is a leaderboard nobody can check. */
type SortKey = 'density' | 'hits' | 'recent';

const SORTS: { key: SortKey; label: string; cmp: (a: SearchRow, b: SearchRow) => number }[] = [
  // Default, and it is not a preference: ordering by raw occurrences ranks session LENGTH.
  // Measured 2026-07-29 on the real corpus — for one query a 369k-char session (0.42 hits per 1k)
  // outranked the 9k-char session that was actually about it (2.60 per 1k), which sat 5th.
  { key: 'density', label: 'density', cmp: (a, b) => density(b) - density(a) || b.lastActivity - a.lastActivity },
  { key: 'hits', label: 'occurrences', cmp: (a, b) => b.hits - a.hits || b.lastActivity - a.lastActivity },
  { key: 'recent', label: 'recent', cmp: (a, b) => b.lastActivity - a.lastActivity },
];

/** Occurrences per 1k characters of dialogue — how much of the session is about the query.
 * `chars` IS 0 for a session matched by git rather than by text (it produced the commit whose
 * hash was searched, without ever naming it), and such a row reads 0 and sorts last. */
function density(r: SearchRow): number {
  return r.chars > 0 ? (1000 * r.hits) / r.chars : 0;
}

// LIMIT: a very short session mentioning a term once can top the density order on that one
// mention. The row prints its own numbers (`1× · 0k`), so the order stays explainable rather than
// mysterious, and no arbitrary minimum-length constant is invented to hide it.

function el(tag: string, className?: string, text?: string): HTMLElement {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

/** Relative age, one unit deep: the list is scanned top-down, so a compact stamp reads faster. */
function ago(ms: number, now: number): string {
  const days = Math.floor((now - ms) / 864e5);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return days + 'd ago';
  return new Date(ms).toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
}

/** `12345` → `12k`: the dialogue size behind the density, at a glance. */
function kchars(n: number): string {
  return n >= 1000 ? Math.round(n / 1000) + 'k' : String(n);
}

/** The same age as {@link ago}, without the trailing word — the score box supplies its own unit. */
function ageValue(ms: number, now: number): string {
  const days = Math.floor((now - ms) / 864e5);
  if (days <= 0) return 'today';
  if (days < 30) return days + 'd';
  return new Date(ms).toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
}

/**
 * What the score box prints, per key — the SAME quantity the list is sorted by. One table for both
 * halves of the promise: a key added without its readout does not compile, and the box can no
 * longer keep printing the density while the list is ordered by something else.
 */
const SCORE: Record<SortKey, (r: SearchRow, now: number) => { value: string; unit: string }> = {
  density: (r) => ({ value: density(r).toFixed(1), unit: 'per 1k' }),
  hits: (r) => ({ value: String(r.hits), unit: 'times' }),
  recent: (r, now) => ({ value: ageValue(r.lastActivity, now), unit: 'last run' }),
};

/**
 * Append `text` to `into`, wrapping every occurrence of every term in a `<mark>`. Ranges are
 * built from indices and emitted as TEXT nodes — never an HTML string, since `text` is a real
 * prompt. Overlapping matches keep the first one — the LONGEST when two start together — so
 * nesting is impossible and a term that contains another is not cut short.
 */
function appendHighlighted(into: HTMLElement, text: string, terms: readonly string[]): void {
  const low = text.toLowerCase();
  const ranges: [number, number][] = [];
  for (const t of terms) {
    for (let at = low.indexOf(t); at >= 0; at = low.indexOf(t, at + t.length)) ranges.push([at, at + t.length]);
  }
  // Longest first at a shared start: with `toast toasting` over "toasting bread", both terms match
  // at 0 and the shorter one won by insertion order — marking `toast` and leaving `ing bread` bare,
  // so the word that brought the session up did not read as a match.
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let cur = 0;
  for (const [from, to] of ranges) {
    if (from < cur) continue;
    if (from > cur) into.append(document.createTextNode(text.slice(cur, from)));
    into.append(el('mark', undefined, text.slice(from, to)));
    cur = to;
  }
  into.append(document.createTextNode(text.slice(cur)));
}

/** A session's label: its first task-bearing prompt, or what it is when it has none. */
function labelOf(r: SearchRow): string {
  if (r.subject && r.subject.trim()) return r.subject.replace(/\s+/g, ' ').trim();
  if (r.entrypoint && r.entrypoint.startsWith('sdk')) return 'Automated run · ' + r.entrypoint;
  return 'Session ' + r.sessionId.slice(0, 8);
}

export interface SearchViewDeps {
  /** Runs a query; null when the request failed (the view then says so). */
  search: (query: string) => Promise<SearchResponse | null>;
  /** Opens a session's own tab — the same path the picker takes. */
  onOpenSession: (sessionId: string) => void;
  /** Clock, injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
}

export interface SearchView {
  /** Focus the query box — what the tab does when you switch to it. */
  focus: () => void;
}

/** Mount the Search tab into `host`. Owns its query, its ordering and whether the automated
 * runs are shown; fetches on input (debounced). */
export function createSearchView(host: HTMLElement, deps: SearchViewDeps): SearchView {
  const now = deps.now ?? Date.now;
  let query = '';
  let terms: string[] = [];
  let data: SearchResponse | null = null;
  let sort: SortKey = 'density';
  let showAutomated = false;
  let pending = false;
  let failed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let seq = 0; // only the newest query may render — a slow one must not overwrite a fast one

  const input = document.createElement('input');
  input.type = 'search';
  input.className = 'sr-input';
  input.placeholder = 'words you remember…';
  input.setAttribute('aria-label', 'Search sessions');

  function row(r: SearchRow): HTMLElement {
    const n = el('div', 'sr-row');
    // The row IS the way into the session: reading it and then hunting the same session in the
    // picker is the step this surface exists to remove. Keyboard-reachable, like the Compare row.
    n.tabIndex = 0;
    n.setAttribute('role', 'button');
    n.onclick = () => deps.onOpenSession(r.sessionId);
    n.onkeydown = (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        deps.onOpenSession(r.sessionId);
      }
    };

    // The box states the CURRENT key, whichever it is — including recency, where it used to keep
    // printing the density: a big number that does not order the list is exactly the leaderboard
    // nobody can check.
    const score = el('div', 'sr-score');
    const shown = SCORE[sort](r, now());
    score.append(el('b', undefined, shown.value), el('span', undefined, shown.unit));
    score.title = `${r.hits} occurrence${r.hits === 1 ? '' : 's'} in ${kchars(r.chars)} characters of dialogue`;
    n.append(score);

    const body = el('div', 'sr-body');
    const label = labelOf(r);
    const subj = el('div', 'sr-subj' + (r.subject ? '' : ' sr-unnamed'), label);
    subj.title = label; // subjects run to 200 chars; the one-line clamp must not lose the text
    body.append(subj);

    const meta = el('div', 'sr-meta');
    meta.append(el('span', 'sr-proj', r.project));
    meta.append(el('span', 'sr-sep', '·'), el('span', undefined, ago(r.lastActivity, now())));
    meta.append(el('span', 'sr-sep', '·'), el('span', undefined, `${r.hits}× · ${kchars(r.chars)}`));
    if (isAutomated(r)) meta.append(el('span', 'sr-sep', '·'), el('span', 'sr-badge sr-auto', 'automated'));
    // The WHOLE uuid, on the row: this is the surface you reach for when the next thing you do is
    // `claude --resume <id>`, and a prefix you have to click to complete is not that. It lives on
    // the meta line — mono, and the only line with the ~230px an id needs — not in the actions
    // column, which would take that width from the snippets.
    meta.append(el('span', 'sr-sep', '·'), createIdChip(r.sessionId, { className: 'sr-uid', full: true }));
    body.append(meta);

    for (const s of r.snippets) body.append(snippet(s));
    n.append(body);

    const acts = el('div', 'sr-acts');
    const open = el('button', 'sr-open', 'Open in tab');
    open.onclick = (e: MouseEvent) => {
      e.stopPropagation();
      deps.onOpenSession(r.sessionId);
    };
    acts.append(open);
    n.append(acts);
    return n;
  }

  /** A matched passage, attributed: a hit in your own words is not a hit in Claude's. */
  function snippet(s: SearchSnippet): HTMLElement {
    const n = el('div', 'sr-snip');
    n.append(el('span', 'sr-who sr-' + s.who, s.who === 'you' ? 'you' : 'claude'));
    appendHighlighted(n, s.text, terms);
    return n;
  }

  function segmented(): HTMLElement {
    const box = el('div', 'rt-seg');
    for (const s of SORTS) {
      const b = el('button', s.key === sort ? 'on' : '', s.label);
      b.onclick = () => {
        sort = s.key;
        render();
      };
      box.append(b);
    }
    return box;
  }

  function results(): HTMLElement {
    const list = el('div', 'sr-list');
    if (failed) {
      list.append(el('div', 'rt-empty', 'The search could not run — seedeep could not reach its own server.'));
      return list;
    }
    if (!terms.length) {
      list.append(el('div', 'rt-empty', 'Type two or three words you remember from the session.'));
      return list;
    }
    if (!data) {
      list.append(el('div', 'rt-empty', 'Searching…'));
      return list;
    }
    // The split the picker makes, with the picker's own predicate: the automated runs (a docs
    // gate, a script) match the same words without being the session you are looking for — on one
    // measured query 91 of 104 matches were automated. Never dropped, just not in the way.
    const human = data.rows.filter((r) => !isAutomated(r));
    const automated = data.rows.filter((r) => isAutomated(r));
    if (!human.length && !automated.length) {
      list.append(el('div', 'rt-empty', 'No session contains all of these words.'));
      return list;
    }
    const cmp = SORTS.find((s) => s.key === sort)!.cmp;
    for (const r of [...human].sort(cmp)) list.append(row(r));
    if (!human.length) list.append(el('div', 'rt-empty', 'No session of your own — only automated runs.'));
    if (automated.length) {
      if (!showAutomated) {
        const more = el(
          'button',
          'sr-more',
          `+ ${automated.length} automated run${automated.length === 1 ? '' : 's'} (docs gate, scripts) contain the same words — show`,
        );
        more.onclick = () => {
          showAutomated = true;
          render();
        };
        list.append(more);
      } else {
        list.append(el('div', 'sr-autohead', 'automated runs'));
        for (const r of [...automated].sort(cmp)) list.append(row(r));
      }
    }
    return list;
  }

  function render(): void {
    const root = el('div', 'sr-root rt-root');

    const head = el('div', 'rt-head');
    const left = el('div');
    left.append(el('div', 'rt-kick', 'search sessions'));
    const title = el('h1', 'rt-title');
    title.append(document.createTextNode('Find the session that '), el('b', undefined, 'solved it'));
    left.append(title);
    left.append(
      el('div', 'rt-scope', 'every word narrows · your prompts and Claude’s answers · automated runs kept aside'),
    );
    head.append(left);
    const filter = el('div', 'rt-filter');
    filter.append(el('span', 'rt-seglbl', 'order by'), segmented());
    head.append(filter);
    root.append(head);

    const form = el('div', 'sr-form');
    form.append(el('span', 'sr-icon', '⌕'), input);
    if (terms.length) {
      const chips = el('div', 'sr-terms');
      for (const t of terms) chips.append(el('span', 'sr-term', t));
      form.append(chips);
      const clear = el('button', 'sr-clear', '×');
      clear.setAttribute('aria-label', 'Clear the search');
      clear.onclick = () => {
        input.value = '';
        run('');
      };
      form.append(clear);
    }
    root.append(form);

    const hint = el('div', 'sr-hint');
    // `pending` is checked FIRST: a re-search over an existing answer would otherwise keep printing
    // the PREVIOUS query's counts as if they were this one's, which is a wrong number on screen
    // however briefly it lasts.
    if (pending) {
      hint.append(el('b', undefined, 'searching…'));
    } else if (data && terms.length) {
      const human = data.rows.filter((r) => !isAutomated(r)).length;
      hint.append(el('b', undefined, `${human} of your sessions`));
      hint.append(
        document.createTextNode(
          ` · ${data.rows.length - human} automated · ${SORTS.find((s) => s.key === sort)!.label} · ${data.ms} ms`,
        ),
      );
    } else {
      hint.append(el('b', undefined, 'every word is an AND'));
      hint.append(
        document.createTextNode(pending ? ' · searching…' : ' · nothing is hidden, automated runs are just kept aside'),
      );
    }
    root.append(hint);
    root.append(results());

    host.replaceChildren(root);
    // The input is recreated into a fresh tree on every render; the caret must survive it, or
    // typing the second word moves the cursor home.
    if (document.activeElement !== input) {
      const end = input.value.length;
      input.focus?.();
      input.setSelectionRange?.(end, end);
    }
  }

  async function run(q: string): Promise<void> {
    query = q;
    showAutomated = false;
    const mine = ++seq;
    if (!q.trim()) {
      terms = [];
      data = null;
      pending = false;
      failed = false;
      render();
      return;
    }
    pending = true;
    failed = false;
    render();
    const res = await deps.search(q);
    if (mine !== seq) return; // a newer query already answered — never let a slow one win
    pending = false;
    failed = res === null;
    data = res;
    terms = res?.terms ?? [];
    render();
  }

  input.oninput = () => {
    if (timer !== null) clearTimeout(timer);
    // Debounced: a query is a corpus scan, and one per keystroke would run it five times a word.
    timer = setTimeout(() => {
      timer = null;
      void run(input.value);
    }, 180);
  };
  input.onkeydown = (e: KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    void run(input.value); // Enter searches now rather than waiting out the debounce
  };

  render();
  return {
    focus() {
      input.focus?.();
      const end = query.length;
      input.setSelectionRange?.(end, end);
    },
  };
}
