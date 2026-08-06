import type { TraceSpan } from './span-store.ts';

/** One node of the grouped strip: a raw step, a run of parallel spawns, or a collapsible group. */
export type GroupItem =
  | { kind: 'step'; span: TraceSpan; midResult?: boolean }
  | { kind: 'parallel'; spans: TraceSpan[] }
  | {
      kind: 'group';
      id: string;
      label: string;
      rounds: number;
      steps: number;
      ms: number;
      hasError: boolean;
      items: GroupItem[];
      /** A ROUND: the intent its api call stated, when it stated one — the round's real name.
       * A CHAPTER: every intent it folds, in order, so it can say how many it holds without
       * claiming that the first one describes all of them. Empty when nothing was said. */
      intents: string[];
    };

/** Chapters fold runs of completed rounds; a run longer than this folds even without a landmark. */
export const CHAPTER_CAP = 10;

// Tool spans that read as narrative landmarks — they break chapters and stay top-level.
// The set was approved via the design prototypes (see-73-trace-grouping).
const LANDMARK_TOOLS = new Set(['Skill', 'AskUserQuestion', 'ReportFindings']);

/** True for spans that must stay top-level: prompt/result/spawn, and landmark tools. */
export function isLandmark(s: TraceSpan): boolean {
  if (s.type === 'prompt' || s.type === 'result' || s.type === 'spawn') return true;
  return s.type === 'tool' && LANDMARK_TOOLS.has(s.label);
}

/** Flatten a group tree back to its spans, in strip order. */
export function leafSpans(item: GroupItem): TraceSpan[] {
  if (item.kind === 'step') return [item.span];
  if (item.kind === 'parallel') return item.spans;
  return item.items.flatMap(leafSpans);
}

/**
 * Collapse runs of spawn steps that are ADJACENT in the strip into one `parallel` item.
 *
 * Adjacency is the criterion, and it is the structural one: measured over 30 real
 * sessions, 92 of 93 adjacent spawn pairs (98.9%) have overlapping execution windows,
 * while 45 pairs overlap WITHOUT being adjacent — separate launches with work between
 * them, which must not merge. Time cannot be used: adjacent spawns are written p50 4.4s
 * apart (p90 11.3s, max 23s) because a `tool_use` line lands only when the streaming
 * response reaches it, so no threshold separates parallel from sequential.
 *
 * Drawing such spawns left-to-right with arrows between them asserts a sequence that
 * never happened. Runs of one are left as plain steps.
 */
export function mergeParallelSpawns(items: GroupItem[]): GroupItem[] {
  const isSpawn = (it: GroupItem | undefined): boolean => it != null && it.kind === 'step' && it.span.type === 'spawn';
  const out: GroupItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!; // ! proven: i < items.length
    if (!isSpawn(it)) {
      out.push(it);
      continue;
    }
    const run: TraceSpan[] = [(it as Extract<GroupItem, { kind: 'step' }>).span];
    while (isSpawn(items[i + 1])) run.push((items[++i] as Extract<GroupItem, { kind: 'step' }>).span);
    out.push(run.length === 1 ? it : { kind: 'parallel', spans: run });
  }
  return out;
}

const spanMs = (s: TraceSpan) => Math.max(0, s.t1 - s.t0);

/** True when any leaf under this item is a failed span — surfaces a failure a collapsed group hides. */
const anyError = (item: GroupItem): boolean => leafSpans(item).some((s) => s.status === 'error');

/**
 * The ids of the groups that must be expanded to reveal `spanId`, outermost first.
 * Returns [] when the span is already top-level, or null when it is not in this tree.
 *
 * A failure is typically two levels down (chapter → round → step), so a badge that only
 * counts failures leaves the user to open those levels by hand — measured at 7 clicks for
 * 3 failures in one real turn, or a 33,000px strip to scan after `expand`.
 */
export function groupPathToSpan(items: GroupItem[], spanId: string): string[] | null {
  for (const it of items) {
    if (it.kind === 'step') {
      if (it.span.id === spanId) return [];
      continue;
    }
    if (it.kind === 'parallel') {
      if (it.spans.some((s) => s.id === spanId)) return [];
      continue;
    }
    const inner = groupPathToSpan(it.items, spanId);
    if (inner) return [it.id, ...inner];
  }
  return null;
}

/** ms of an item, whatever its kind — the denominator a strip's duration bars share. */
export function itemMs(item: GroupItem): number {
  if (item.kind === 'group') return item.ms;
  if (item.kind === 'parallel') return Math.max(0, ...item.spans.map(spanMs));
  return spanMs(item.span);
}

/**
 * Group a turn's ordered main-lane spans with the hybrid rule:
 * round = api + its tools; chapters cap runs of rounds at `cap` and break at
 * landmarks; landmarks stay top-level; with `liveTail` the last round stays raw
 * (open blocks) so a live turn's newest work is always visible.
 * A `result` span with spans after it is marked `midResult` (rendered "reply").
 */
export function groupTurnSpans(spans: TraceSpan[], opts?: { cap?: number; liveTail?: boolean }): GroupItem[] {
  const cap = opts?.cap ?? CHAPTER_CAP;
  const lastIdx = spans.length - 1;

  // Pass 1: split into a flat sequence of steps (landmarks) and rounds.
  type Round = { spans: TraceSpan[] };
  const flat: Array<GroupItem | Round> = [];
  let cur: Round | null = null;
  const closeRound = () => {
    if (cur && cur.spans.length) flat.push(cur);
    cur = null;
  };
  spans.forEach((s, i) => {
    if (isLandmark(s)) {
      closeRound();
      const item: GroupItem = { kind: 'step', span: s };
      if (s.type === 'result' && i < lastIdx) item.midResult = true;
      flat.push(item);
      return;
    }
    if (s.type === 'api') {
      closeRound();
      cur = { spans: [s] };
      return;
    }
    (cur ??= { spans: [] }).spans.push(s);
  });
  closeRound();

  // Pass 2: fold runs of rounds into chapters (cap, landmark breaks, live tail).
  const out: GroupItem[] = [];
  let no = 0;
  let run: GroupItem[] = [];
  let runFrom = 0;
  const roundItem = (r: Round): GroupItem => {
    no++;
    return {
      kind: 'group',
      id: 'r' + no,
      label: '#' + no + ' round',
      rounds: 1,
      steps: r.spans.length,
      ms: r.spans.reduce((n, s) => n + spanMs(s), 0),
      hasError: r.spans.some((s) => s.status === 'error'),
      items: r.spans.map((span) => ({ kind: 'step', span }) as GroupItem),
      // At most one: a round is one api call, and the intent belongs to that call.
      intents: r.spans.flatMap((s) => (s.narration ? [s.narration] : [])),
    };
  };
  const flushRun = () => {
    if (!run.length) return;
    if (run.length === 1) {
      out.push(run[0]!);
      run = [];
      return;
    }
    const ss = run.flatMap(leafSpans);
    // Chapter id encodes only its START round: on a live turn the trailing
    // chapter's end grows with every completed round, and an id that embeds the
    // range would invalidate the user's pinned-open key on each update.
    out.push({
      kind: 'group',
      id: 'ch' + runFrom,
      label: 'R' + runFrom + '–' + no,
      rounds: run.length,
      steps: ss.length,
      ms: ss.reduce((n, s) => n + spanMs(s), 0),
      hasError: run.some(anyError),
      items: run,
      // A chapter keeps its round range as its NAME and only counts what it folds: naming it
      // after the first intent would describe one round out of up to ten as if it described
      // all of them. Read from the leaves, so a nested chapter still sees every intent.
      intents: ss.flatMap((s) => (s.narration ? [s.narration] : [])),
    });
    run = [];
  };
  flat.forEach((entry, i) => {
    if (!('spans' in entry)) {
      flushRun();
      out.push(entry);
      return;
    }
    const isLastEntry = i === flat.length - 1;
    if (isLastEntry && opts?.liveTail) {
      // Tail round of a live turn: raw open blocks, never folded.
      flushRun();
      for (const span of entry.spans) out.push({ kind: 'step', span });
      return;
    }
    if (!run.length) runFrom = no + 1;
    run.push(roundItem(entry));
    if (run.length === cap) flushRun();
  });
  flushRun();
  return mergeParallelSpawns(out);
}
