// Derivations over a TreeSnapshot: the numbers a view shows, computed once here.
// They live outside the renderer so every surface reads the SAME derived values instead
// of each recomputing them — the drift that produced two different "running" labels for
// one state came from exactly that.
// Pure functions, no DOM: unit-testable without a browser.
import type { AgentNode, FileChangeNode, ToolNode, TreeSnapshot } from './session-tree.ts';
import { sumTokensByModel } from './session-tree.ts';
import { isScratchPath } from './text.ts';

/** A background command the session launched and has not been told the fate of. */
export interface RunningCommand {
  /** The launch call, so a surface can open its drawer rather than restating what it knows. */
  toolUseId: string;
  /** The command, as the launch row already labels it. */
  command: string;
  /** When it was launched — the age is computed by the surface, because sending an age would
   * expire in flight (the same rule as `ageFrom` in the digest). */
  since: string;
  turnIndex: number | null;
}

/**
 * The background commands still running: launched (`background`) and not yet told what became of
 * them (`outcome`), oldest first.
 *
 * The one derivation both surfaces read — the browser's cockpit and the tray, through the digest —
 * because "is this session still waiting on something it started" must not be answered two ways.
 *
 * **What ends one is its NOTIFICATION, and nothing else.** Measured over every local session, 9 of
 * 107 launches (8.4%) never reported at all — killed, or the session closed under them — so an
 * entry can outlive the command it names, for as long as the session lives. The alternative is a
 * timeout, which would be a number invented here and would then claim a command had ended when
 * nothing said so.
 */
export function runningBackground(tools: readonly ToolNode[]): RunningCommand[] {
  return tools
    .filter((t) => t.background && !t.outcome && t.startedTs)
    .map((t) => ({
      toolUseId: t.id,
      command: t.arg ?? t.name,
      since: t.startedTs!,
      turnIndex: t.turnIndex,
    }))
    .sort((a, b) => a.since.localeCompare(b.since));
}

/**
 * One changed file: its path split for the two-line row (basename + folder), and whether it lives
 * in the session scratchpad rather than in the project. Derived from the path, never stored on the
 * reducer's nodes: it is a function of the path, so keeping it as state could only let the two
 * disagree.
 */
export interface ChangedFile {
  path: string;
  base: string;
  dir: string;
  scratch: boolean;
}

/**
 * Files changed in scope, deduped by path and ordered most-recently-changed first (by the delta's
 * timestamp), ties broken by path for a stable order. `base`/`dir` split the path for the row; a
 * root-level file (no slash) gets an empty `dir`, which the widget renders as "·". Each file is
 * flagged `scratch` when it lives in the session scratchpad; callers separate the two rather than
 * filtering here, because the drawer lists both.
 *
 * No change-COUNT is exposed: every delta observed locally was the file's first and only one
 * (642/642, `version` always 1), so a per-file count would read a constant ×1. The dedupe is
 * therefore DEFENSIVE, not decorative — it is what makes the display correct if Claude Code ever
 * starts writing a second delta for the same file.
 */
export function changedFiles(nodes: readonly FileChangeNode[]): ChangedFile[] {
  const lastTs = new Map<string, string>();
  for (const n of nodes) {
    const prev = lastTs.get(n.path);
    if (prev === undefined || n.ts > prev) lastTs.set(n.path, n.ts);
  }
  return [...lastTs.entries()]
    .sort((a, b) => b[1].localeCompare(a[1]) || a[0].localeCompare(b[0]))
    .map(([path]) => {
      const slash = path.lastIndexOf('/');
      return {
        path,
        base: path.slice(slash + 1),
        dir: slash >= 0 ? path.slice(0, slash + 1) : '',
        scratch: isScratchPath(path),
      };
    });
}

/**
 * The four API usage-block token categories SUMMED over a scope, plus their total, for the
 * Token usage card. Cache read/write come from `cacheTotals` (already summed); input/output
 * from the reducer's per-scope sums. Names match Anthropic's usage-block fields.
 */
export function tokenUsage(m: TreeSnapshot['main']): {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  total: number;
} {
  const input = m.inputTotal,
    cacheWrite = m.cacheTotals.created,
    cacheRead = m.cacheTotals.read,
    output = m.outputTotal;
  return { input, cacheWrite, cacheRead, output, total: input + cacheWrite + cacheRead + output };
}

/** Subagents ranked by tool count (desc) — the "output size" order. Does not mutate the input. */
export function subagentsByWeight(subagents: readonly AgentNode[]): AgentNode[] {
  return [...subagents].sort((a, b) => b.tools.length - a.tools.length);
}

/**
 * Subagents in launch order (oldest first); those with no `startedAt` sort last,
 * since a spawn we never timestamped cannot be placed on the timeline.
 */
export function subagentsChronological(subagents: readonly AgentNode[]): AgentNode[] {
  return [...subagents].sort((a, b) => {
    if (!a.startedAt && !b.startedAt) return 0;
    if (!a.startedAt) return 1;
    if (!b.startedAt) return -1;
    return a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0;
  });
}

/** Largest tool-count across main + every subagent, floored at 1 so it is always a safe bar denominator. */
export function maxToolCount(s: Pick<TreeSnapshot, 'mainTools' | 'subagents'>): number {
  return Math.max(s.mainTools.length, ...s.subagents.map((a) => a.tools.length), 1);
}

/** Largest returned-output length across subagents, floored at 1 (safe bar denominator). */
export function maxReturnedLen(subagents: readonly AgentNode[]): number {
  return Math.max(1, ...subagents.map((a) => a.outLen ?? 0));
}

/**
 * Main-session tools ranked by output size (desc). Only tools that actually produced
 * output qualify: `ctx` is 0 until the tool-end arrives, and a 0-byte tool is not a hog.
 */
export function contextHogs(mainTools: readonly ToolNode[]): ToolNode[] {
  return mainTools.filter((t) => t.ctx > 0).sort((a, b) => b.ctx - a.ctx);
}

/**
 * A subagent's FINAL context fill as a 0-1 fraction of its window (0 when the window is unknown).
 * This is the context bar — how full the subagent's own window got — NOT its consumption, which
 * is `volume` (a cumulative sum that can exceed the window and so has no window fraction).
 */
export function contextFraction(a: Pick<AgentNode, 'fill' | 'window'>): number {
  return a.window > 0 ? a.fill / a.window : 0;
}

/** A skill's share of all skill-attributed API turns, 0-100; null when no turns are attributed yet. */
export function skillShare(skill: { turns: number }, skills: ReadonlyArray<{ turns: number }>): number | null {
  const total = skills.reduce((n, x) => n + x.turns, 0);
  return total > 0 ? (skill.turns / total) * 100 : null;
}

/**
 * Project a session snapshot onto a single turn, returning the same shape.
 * Every existing widget renderer works unchanged — it never learns whether it is
 * drawing a session or a turn. Falls back to the whole session for an unknown index.
 * Skills and commands come from the turn's OWN nodes (turn-local counts), never from
 * the session's — filtering the session list would keep session-wide counts and show,
 * say, `/clear ×3` on a turn that used it once.
 */
export function scopeToTurn(s: TreeSnapshot, turnIndex: number): TreeSnapshot {
  const turn = s.turnList.find((t) => t.index === turnIndex);
  if (!turn) return s;
  const mainTools = s.mainTools.filter((t) => t.turnIndex === turnIndex);
  const filesChanged = s.filesChanged.filter((f) => f.turnIndex === turnIndex);
  const subagents = s.subagents.filter((a) => a.turnIndex === turnIndex);
  const skills = [...turn.skills];
  const commands = [...turn.commands];
  const w = s.main.window;
  return {
    ...s,
    main: {
      ...s.main,
      fill: turn.fillEnd,
      pct: w > 0 ? Math.round((turn.fillEnd / w) * 100) : 0,
      breakdown: { ...turn.breakdown },
      cacheTotals: { ...turn.cacheTotals },
      inputTotal: turn.inputTotal,
      outputTotal: turn.out,
      weighted: turn.weighted,
      // LIMIT: a turn carries its total weight but no per-model split of it, so the scoped view
      // reports none rather than handing back the SESSION's split — an empty list renders as
      // absent, a session-wide one would render as this turn's and be silently wrong.
      weightedByModel: [],
    },
    mainTools,
    filesChanged,
    subagents,
    subagentsTotal: subagents.reduce((n, a) => n + a.volume, 0),
    subagentsEstimated: subagents.some((a) => a.volumeEstimated),
    subagentTokensByModel: sumTokensByModel(subagents),
    // Same rule as `subagentsTotal` above: summed over the scoped agents, never inherited.
    weightedSubagents: subagents.reduce((n, a) => n + a.weighted, 0),
    weightedByModel: [], // LIMIT: as `main.weightedByModel` — a turn stores no per-model split
    skills,
    commands,
    turns: 1,
    apiCalls: turn.apiCalls,
  };
}

/** Interrupted-turn count for the Session footer and the scope banner. */
export function turnCostStats(s: TreeSnapshot): { escCount: number } {
  return { escCount: s.turnList.filter((t) => t.state === 'interrupted').length };
}

/**
 * How long the session actually WORKED: the sum of its turns' own durations, not the
 * wall-clock span. The two are far apart — measured over 202 real sessions the working
 * time is a median 33% of the wall span (p10 8%), so a 22-hour session can hold 30
 * minutes of work. This sums exactly the same `turn_duration` values the per-turn
 * durations show, so the total can never disagree with its parts.
 *
 * An OPEN turn contributes nothing here: it has no `turn_duration` yet. The caller adds
 * its live elapsed, so the total keeps counting while the session works.
 */
export function workingMs(s: TreeSnapshot): number {
  let total = 0;
  for (const t of s.turnList) if (t.durationMs !== null) total += t.durationMs;
  return total;
}
