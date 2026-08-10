import type { DrawerHandle, SpanType, TraceSnapshot } from './span-store.ts';

/**
 * One row of the all-activity list: a span flattened out of the trace tree, with the
 * lane it came from resolved into a displayable agent name.
 */
export interface ActivityRow {
  /** The span's id — stable across snapshots, so it keys a row without re-deriving it. */
  id: string;
  type: SpanType;
  /** Tool name, 'API call', 'spawn' — whatever the span calls itself. */
  name: string;
  /** The span's own subtitle: a tool's argument, a spawn's launch intent. */
  detail: string | null;
  t0: number;
  /** Wall time, or null while the span is still running (t1 === t0 until closed). */
  ms: number | null;
  status: 'ok' | 'error' | 'running';
  /** Agent that ran this row, or null on the main thread. Model parenthetical stripped. */
  agent: string | null;
  /** 0 = main thread; >= 1 = a subagent lane, as numbered by the span store. */
  lane: number;
  handle: DrawerHandle | null;
  /** The session turn (1-based index) this activity belongs to. Subagent spans are attributed to the parent turn. */
  turnIndex: number;
  /** A hook attached a note to this call. The mark only — the text lives in the drawer. */
  flagged?: true;
}

/**
 * The span types that ARE activity — the same universe the Live activity card draws, whose
 * two `feed.push` sites emit exactly one row per API call (`usage` with `newCall`) and one per
 * `tool-start`, main thread or subagent. The span store also holds a turn's `prompt` and its
 * `result`; those are turn structure, not activity, and the card never shows them. This list is
 * that card's `Expand all`, so it must not invent rows the card cannot have — the Trace,
 * which draws the turn itself, keeps them.
 */
const ACTIVITY_TYPES: ReadonlySet<SpanType> = new Set<SpanType>(['api', 'tool', 'subspan', 'spawn']);

/** Strip the model parenthetical a lane label carries: "Explore (claude-sonnet-5)" → "Explore". */
function agentName(label: string | null): string | null {
  if (!label) return null;
  return label.replace(/\s*\(.*\)\s*$/, '') || label;
}

/**
 * Flatten a trace snapshot into one chronological list of activity rows — main-thread
 * spans AND subagent lane spans merged, oldest first, keeping only `ACTIVITY_TYPES`.
 *
 * Subagent spans live only inside `turn.spawns[].lanes[].spans`, never in `turn.spans`,
 * so a list built from `turn.spans` alone silently omits everything a subagent did.
 * Ties on `t0` put the main thread first, which keeps a spawn above the children it
 * created when their timestamps collide at the same millisecond.
 */
export function flattenActivity(snap: TraceSnapshot): ActivityRow[] {
  const rows: ActivityRow[] = [];
  const push = (
    s: {
      id: string;
      type: SpanType;
      label: string;
      detail: string | null;
      t0: number;
      t1: number;
      status: 'ok' | 'error' | 'running';
      agent: string | null;
      lane: number;
      handle: DrawerHandle | null;
      flagged?: true;
    },
    turnIdx: number,
  ): void => {
    if (!ACTIVITY_TYPES.has(s.type)) return;
    rows.push({
      id: s.id,
      type: s.type,
      name: s.label,
      detail: s.detail,
      t0: s.t0,
      // t1 === t0 is the span store's "not closed yet" marker, not a zero-length span.
      ms: s.status === 'running' || s.t1 <= s.t0 ? null : s.t1 - s.t0,
      status: s.status,
      agent: agentName(s.agent),
      lane: s.lane,
      handle: s.handle,
      turnIndex: turnIdx,
      // Carried so the complete list marks a flagged call the same way the Trace block does —
      // the two are the same history, and one of them staying silent is a disagreement.
      ...(s.flagged ? { flagged: true as const } : {}),
    });
  };

  for (const turn of snap.turns) {
    for (const span of turn.spans) push(span, turn.index);
    for (const spawn of turn.spawns) {
      for (const lane of spawn.lanes) {
        for (const span of lane.spans) push(span, turn.index);
      }
    }
  }

  // Stable sort (guaranteed since ES2019), so rows sharing a t0 keep the order above.
  rows.sort((a, b) => a.t0 - b.t0 || (a.lane === 0 ? -1 : 0) - (b.lane === 0 ? -1 : 0));
  return rows;
}

/** Case-insensitive match of a row against a filter query, over name and detail. */
export function activityMatches(row: ActivityRow, query: string): boolean {
  const q = query.toLowerCase();
  return row.name.toLowerCase().includes(q) || (row.detail ?? '').toLowerCase().includes(q);
}
