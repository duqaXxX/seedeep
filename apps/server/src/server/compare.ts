import type { CompareRow, CompareWindow, Comparison, SessionRecord } from '../core/types.ts';
import { COMPARE_TOP_N } from '../core/types.ts';
import type { SessionWeight } from './aggregate-cache.ts';

// Builds the cross-session comparison from two things the server already has: the
// roster (who each session is) and the aggregate cache's per-path weight facts (how heavy it is).
// Pure — the clock is a parameter — so the windows are testable without waiting for a day to pass.

const DAY_MS = 24 * 3600 * 1000;

/**
 * A session enters a window by its LAST ACTIVITY, and enters it whole.
 *
 * Not by filtering its turns: the row compares SESSIONS, and half a session shown as if it were
 * the whole one is a wrong number, not a partial one. It is also nearly moot — 93% of local
 * sessions span under an hour and 5 of 996 exceed a day (measured 2026-07-28) — so the two rules
 * disagree about a handful of sessions and only the whole-session one is honest about what it
 * shows. It is what lets a subagent's weight count at all: that weight is a per-file total, with
 * no turn to attribute it to.
 */
function inWindow(row: CompareRow, now: number, days: number | null): boolean {
  return days === null || row.lastTs >= now - days * DAY_MS;
}

/** Rank rows by weight and by unweighted tokens, then take the heaviest {@link COMPARE_TOP_N}. */
function windowOf(rows: CompareRow[]): CompareWindow {
  const byWeight = [...rows].sort((a, b) => b.weight - a.weight);
  // Ranks are assigned over the WHOLE window before the cut, and re-derived per window: a
  // session's rank is a fact about the window it is shown in, not about the corpus.
  //
  // The unweighted rank is by `tokensComplete` — the very number the row prints beside the call
  // count — and by nothing else. It used to come from the cache's turns-only total, which made the
  // `▲N vs unweighted` chip measure three things at once (the weighting, whether subagents counted,
  // and whether the last turn had closed) while claiming to measure one: 75.4% of compared sessions
  // were tied at 0 there, and 42% of the rest disagreed with the figure on screen by over 5%.
  // Ranking on the displayed number makes the chip mean exactly what it says.
  const rawRank = new Map(
    [...rows].sort((a, b) => b.tokensComplete - a.tokensComplete).map((r, i) => [r.sessionId, i + 1]),
  );
  // `rawRank.get` cannot miss — every row was just ranked — so no fallback is needed; a `?? 0`
  // here used to declare an absent session FIRST rather than abstain.
  const ranked = byWeight.map((r, i) => ({ ...r, rank: i + 1, rawRank: rawRank.get(r.sessionId)! }));
  const weight = ranked.reduce((n, r) => n + r.weight, 0);
  const subagentWeight = ranked.reduce((n, r) => n + r.subagentWeight, 0);
  const byModel = new Map<string, number>();
  for (const r of ranked) for (const m of r.byModel) byModel.set(m.model, (byModel.get(m.model) ?? 0) + m.weight);
  const top = ranked.slice(0, COMPARE_TOP_N);
  const rest = ranked.slice(COMPARE_TOP_N);
  return {
    sessions: ranked.length,
    weight,
    subagentWeight,
    byModel: [...byModel].map(([model, w]) => ({ model, weight: w })).sort((a, b) => b.weight - a.weight),
    top,
    restSessions: rest.length,
    restWeight: rest.reduce((n, r) => n + r.weight, 0),
  };
}

/**
 * Assemble the comparison: join the roster with the cache's weight facts, drop sessions with no
 * weight at all (a content-less session has nothing to compare), and cut the three windows.
 */
export function buildComparison(
  roster: readonly SessionRecord[],
  weights: ReadonlyMap<string, SessionWeight>,
  now: number,
): Comparison {
  const rows: CompareRow[] = [];
  for (const r of roster) {
    const w = weights.get(r.path);
    if (!w || w.weight <= 0) continue;
    rows.push({
      sessionId: r.sessionId,
      project: r.project,
      subject: r.subject,
      entrypoint: r.entrypoint,
      weight: w.weight,
      subagentWeight: w.subagentWeight,
      byModel: w.byModel,
      tokensComplete: w.tokensComplete,
      mainModel: w.mainModel,
      mainModels: w.mainModels,
      turns: w.turns,
      apiCalls: w.apiCalls,
      // The file's mtime is the fallback, not the first choice: a session whose turns carry no
      // timestamp still happened, and dropping it from every window would hide weight.
      lastTs: w.lastTs ?? r.lastActivity,
      rank: 0,
      rawRank: 0,
    });
  }
  return {
    generatedAt: now,
    windows: {
      all: windowOf(rows.filter((r) => inWindow(r, now, null))),
      d30: windowOf(rows.filter((r) => inWindow(r, now, 30))),
      d7: windowOf(rows.filter((r) => inWindow(r, now, 7))),
    },
  };
}
