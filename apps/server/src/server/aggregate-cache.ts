import type { Stats } from 'node:fs';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { windowFor } from '../core/context-windows.ts';
import { createSessionTree, sumTokensByModel } from '../core/session-tree.ts';
import type { Retrospective, RetroWindow, Root, TurnSummary } from '../core/types.ts';
import { HIST_BINS } from '../core/types.ts';
import { computeVerdicts, turnBillable, turnResumeCost } from '../core/verdict.ts';
import { aggregateBaseline } from './baseline.ts';
import { seedDeepDir } from './config.ts';
import { parseLine } from './parser.ts';
import { streamReplay } from './replay.ts';
import { subagentStamp } from './subagent-files.ts';

// The persistent, incremental aggregate cache behind the minute-zero retrospective (Home tab)
// and `/api/baseline`. It keeps a per-file summary of each session's work turns, keyed by path
// and invalidated by (size, mtime), so a launch re-parses only the files that changed and merges
// KB of cached summaries in milliseconds. It is the ONE corpus scanner: the crude roster-length
// baseline cache is gone.
//
// Read-only invariant: seedeep still never writes Anthropic session files. It DOES now write its
// OWN cache file (gitignored, outside the repo) — a new, self-owned kind of write. See
// docs/architecture.md.

// Bump when the summary SHAPE **or** the VALUES the summarizer produces change — an older cache
// is then ignored and rebuilt, never misread or served stale. Not just the shape: a parser change
// that alters stored values (e.g. no longer recording `<synthetic>` as a model) leaves the old
// values in the cache for unchanged files, so it must invalidate too.
//   v2: per-turn `ts` + `durationMs` (time windows + working time).
//   v3: per-turn `cacheRead` / `model` / `apiCalls` + per-file tool counts (total/by-model/tools),
//       AND the parser fix that stops recording `<synthetic>` as a model (drops a stale by-model slice).
//   v4: per-turn `resumeCost` — and with it the baseline, which is now built on WORK tokens, so
//       every cached summary's contribution to the percentiles changed even where its shape did not.
//   v5: `reread` dropped from the per-turn facts and `escStreak`/`context` added, so every cached
//       TurnSummary predates the fields the severity rule now reads.
//   v6: the anomaly detector removed and `exploration`/`unverifiedShip` added — a v5 summary
//       would keep a crit the verdict no longer gives and miss the two new flags.
//   v7: the worst-of `severity` STORED rather than recomputed at aggregation (it stopped
//       depending on the global baseline the moment the anomaly went). A v6 summary carries no
//       `severity` at all, and reading one produced a retrospective of 0 crit and 0 warn —
//       caught only by checking `/api/retro` live, since the tests always build the cache fresh.
//       ONE version per shape change: v6 was reused for two of them, which is what let a stale
//       summary pass the version guard.
//   v11: per-file `apiCalls` — the session's own call count. It was derived from Σ`turns[].apiCalls`,
//        which counts CLOSED work turns only: measured on 240 real sessions, 125 of them (52.1%)
//        would have rendered "0 calls" beside a non-zero weight. Same class of mistake as summing
//        the turns for the weight, one field later.
//   v10: per-file `mainModel` / `mainModels` — which model the MAIN thread ran on, shown on the
//        Compare row. A v9 summary has neither, and would leave every unchanged session unlabelled.
//   v9: per-file `tokensComplete` — the session's whole unweighted token total, shown next to the
//       weight on the Compare row. A v8 summary has no such field, and reading one would print 0
//       tokens for every unchanged session.
//   v8: per-turn `weighted` + per-file `weightedMain` / `weightedSubagents` / `weightedByModel`
//       AND the
//       summarizer now reads a session's SUBAGENT transcripts too, so every cached summary
//       predates 35% of the corpus's billable tokens — a value change, not only a shape one.
//   v12: a command Claude Code writes as PLAIN TEXT (`/compact`, `/code-review …`) now opens a
//        turn, as the tagged shape always did. A v11 summary of such a session is missing that
//        turn entirely and carries its work on the previous one — a value change, like v8, so an
//        unchanged file must not keep its old summary. 8 of 721 local sessions are affected; the
//        cost of the bump is one recomputation, since a vanished transcript is dropped from the
//        aggregate on every refresh anyway.
const CACHE_VERSION = 13;

const DAY_MS = 24 * 3600 * 1000;
// The share of a session's billable tokens spent re-entering its context at which Claude Code's
// own `/usage` breakdown flags the behaviour ("10% or more of your recent usage" —
// code.claude.com/docs/en/costs). Adopted rather than chosen: the local curve is flat from 10% to
// 25% (59 → 50 sessions), so the threshold buys defensibility, not a different population.
const REENTRY_FLAG_SHARE = 0.1;
const WEEK_MS = 7 * DAY_MS;
const MAX_WEEKS = 26; // cap the activity axis; a longer history still trims to its real span

interface FileSummary extends SessionSummary {
  mtime: number;
  size: number;
  /** {@link subagentStamp} of the session at parse time. A child can grow when the parent does
   * not, so (size, mtime) of the parent alone would serve a summary missing that child's tokens. */
  childStamp: string;
}

/** The default on-disk location of the aggregate cache: `<seedDeepDir>/aggregates.json`.
 * seedeep owns this file entirely; it is never a session file. */
export function defaultCacheFile(home: string = homedir()): string {
  return join(seedDeepDir(home), 'aggregates.json');
}

/**
 * One-time migration: if the old cache path (`~/.claude/.cache/seedeep/aggregates.json`)
 * exists and the new one (`~/.seedeep/aggregates.json`) does not, copy and delete the old
 * file. Silently no-ops when the migration is unnecessary or any I/O step fails — the cache
 * is simply rebuilt from scratch on the next refresh.
 */
export async function maybeMigrateCache(home: string = homedir()): Promise<void> {
  const oldPath = join(home, '.claude', '.cache', 'seedeep', 'aggregates.json');
  const newPath = defaultCacheFile(home);
  if (oldPath === newPath) return;
  try {
    await stat(oldPath);
  } catch {
    return;
  } // old absent — nothing to do
  try {
    await stat(newPath);
    return;
  } catch {
    /* new absent — proceed */
  }
  try {
    const data = await readFile(oldPath);
    await mkdir(dirname(newPath), { recursive: true });
    await writeFile(newPath, data);
    await unlink(oldPath);
  } catch {
    /* non-fatal: the cache rebuilds on next refresh */
  }
}

/**
 * Summarize one session file's closed work turns into their per-turn facts, through the REAL
 * parser + reducer + verdict. Every detector is file-local (a session is one file), which is what
 * makes each file cacheable on its own. Live/unclosed turns are excluded.
 */
/** One session's cached summary: its per-turn facts plus all-time tool-call counts by name. */
export interface SessionSummary {
  turns: TurnSummary[];
  tools: Record<string, number>;
  /** The session's MAIN-thread weight, whole-session — NOT Σ`turns[].weighted`. `turns` holds only
   * CLOSED WORK turns, which is right for a turn retrospective and wrong for a session total: an
   * unclosed final turn, or an sdk session (which never writes `turn_duration`), would contribute
   * nothing. Measured 2026-07-28: summing the turns left 751 of 996 sessions weighing zero. */
  weightedMain: number;
  /** The session's SUBAGENT weight (see `TreeSnapshot.weightedSubagents`). A per-file total, not
   * per-turn: charging a child's calls to the turn that spawned it is a further claim, and the
   * comparison this feeds comes out per session. `weightedMain` + this = the session's weight. */
  weightedSubagents: number;
  /** The session's whole weight split by the model of the call, main + subagents. */
  weightedByModel: Record<string, number>;
  /** The session's COMPLETE unweighted token total — `input + output + cache_creation + cache_read`
   * over the main thread plus every subagent's own consumption. The honest "tokens spent": cache
   * reads are billed too, just discounted, and they are ~97% of it. Whole-session for the same
   * reason `weightedMain` is (see above), and it includes a background subagent's estimated
   * `totalTokens`, exactly as the Token usage card does. */
  tokensComplete: number;
  /** The model the MAIN thread mostly ran on — the one holding the largest share of `weightedMain`,
   * subagents excluded. Null when it made no weighable call. Dominance, not first-seen: a session
   * that opens on one model and does its work on another ran on the second. */
  mainModel: string | null;
  /** How many distinct models the main thread used. >1 on ~5% of real sessions (a mid-session
   * `/model`), and the row says so rather than presenting the dominant one as the whole truth. */
  mainModels: number;
  /** The session's MAIN-thread API calls — distinct `message.id`s, whole-session. NOT Σ
   * `turns[].apiCalls`, which counts closed work turns only and reported 0 for every session whose
   * last turn had not closed (52.1% of the corpus, measured 2026-07-28). */
  apiCalls: number;
}

/**
 * Summarize one session file — its turns (through the real parser + reducer + verdict) plus
 * tool-call counts by name — in a single parse.
 * Live/unclosed turns are excluded.
 */
export function summarizeSession(lines: string[], ctx: { sessionId: string; root: Root }): SessionSummary {
  const tree = createSessionTree({ windowFor });
  let seq = 0;
  for (const line of lines) for (const e of parseLine(line, { ...ctx, seq: seq++, agentId: null })) tree.apply(e);
  return summarizeTree(tree);
}

/**
 * Summarize a session from DISK — the parent transcript AND its subagent children — through
 * {@link streamReplay}, i.e. the exact event stream the live watcher produces. This is what the
 * cache uses: reading the parent alone left 35.3% of the corpus's billable tokens out of every
 * aggregate (p90 24.4% of one session, max 91.9%), because a subagent writes its own transcript.
 */
export async function summarizeSessionFromDisk(
  path: string,
  ctx: { sessionId: string; root: Root },
): Promise<SessionSummary> {
  const tree = createSessionTree({ windowFor });
  for await (const e of streamReplay(path, ctx)) tree.apply(e);
  return summarizeTree(tree);
}

/** The tree → summary step, shared by every entry point so they cannot drift. Exported for
 * `seedeep report`, which needs the same numbers AND the tree's own snapshot from one pass. */
export function summarizeTree(tree: ReturnType<typeof createSessionTree>): SessionSummary {
  const snap = tree.snapshot();
  const tools: Record<string, number> = {};
  for (const t of snap.mainTools) tools[t.name] = (tools[t.name] ?? 0) + 1;
  // ONE pass over the snapshot for the whole file: `computeVerdict` re-indexes it per turn,
  // which is O(turns²) on a 157-turn session.
  const verdicts = computeVerdicts(snap);
  // The agents a turn spawned, by the `turnIndex` they carry — the same filter `scopeToTurn` uses.
  const agentsOf = (index: number) => snap.subagents.filter((a) => a.turnIndex === index);
  const turns = snap.turnList
    .filter((t) => t.state !== 'live' && t.kind === 'work')
    .map((t): TurnSummary => {
      const v = verdicts.get(t.index)!;
      const has = (k: string) => v.findings.some((f) => f.kind === k);
      return {
        billable: turnBillable(t),
        resumeCost: turnResumeCost(t),
        weighted: t.weighted,
        cacheRead: t.cacheTotals.read,
        effort: t.efforts.at(-1) ?? 'unknown',
        model: t.models.at(-1) ?? 'unknown',
        subagentTokensByModel: sumTokensByModel(agentsOf(t.index)).map((x) => ({
          model: x.model ?? 'unknown',
          tokens: x.tokens,
        })),
        subagentNew: agentsOf(t.index).reduce(
          (n, a) =>
            n +
            (a.volumeBreakdown
              ? a.volumeBreakdown.input + a.volumeBreakdown.output + a.volumeBreakdown.cacheCreation
              : 0),
          0,
        ),
        apiCalls: t.apiCalls,
        esc: t.state === 'interrupted',
        escStreak: has('esc'),
        context: has('context'),
        compaction: has('compaction'),
        subWaste: has('wasted-subagent'),
        exploration: has('exploration'),
        unverifiedShip: has('unverified-ship'),
        severity: v.severity,
        ts: t.startedAt ? Date.parse(t.startedAt) || null : null,
        durationMs: t.durationMs,
      };
    });
  const weightedByModel: Record<string, number> = {};
  for (const { model, weight } of snap.weightedByModel) weightedByModel[model] = weight;
  const m = snap.main;
  const tokensComplete =
    m.inputTotal + m.outputTotal + m.cacheTotals.read + m.cacheTotals.created + snap.subagentsTotal;
  return {
    turns,
    tools,
    weightedMain: snap.main.weighted,
    weightedSubagents: snap.weightedSubagents,
    weightedByModel,
    tokensComplete,
    mainModel: m.weightedByModel[0]?.model ?? null,
    mainModels: m.weightedByModel.length,
    apiCalls: snap.apiCalls,
  };
}

/** Turns-only view of {@link summarizeSession} — the shape the per-turn tests assert against. */
export function summarizeFile(lines: string[], ctx: { sessionId: string; root: Root }): TurnSummary[] {
  return summarizeSession(lines, ctx).turns;
}

/** Epoch ms of the Monday 00:00 (local) opening the calendar week that contains `ms`. */
function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function startOfWeek(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // getDay(): 0 = Sunday
  return d.getTime();
}

/** How many whole calendar weeks `ms` sits before the week opening at `anchor` (0 = same week).
 * Rounds because a DST shift makes the gap 167 or 169 hours, never exactly 7 days. */
function weeksBefore(ms: number, anchor: number): number {
  return Math.round((anchor - startOfWeek(ms)) / WEEK_MS);
}

/** Nearest-rank percentile over an already-sorted ascending array; 0 when empty. */
function pctl(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
}

/** Aggregate one time window's turns. `sinceMs` null = all-time; else keep turns within it. */
function windowStats(turns: TurnSummary[], now: number, sinceMs: number | null): RetroWindow {
  const w = sinceMs == null ? turns : turns.filter((t) => t.ts != null && now - t.ts <= sinceMs);
  const bills = w.map((t) => t.billable).sort((a, b) => a - b);
  const billsComplete = w.map((t) => t.billable + t.cacheRead).sort((a, b) => a - b);
  const hist = HIST_BINS.map(() => 0);
  const modelTokens = new Map<string, number>();
  let escTurns = 0,
    escTokens = 0,
    escStreak = 0,
    context = 0,
    subWaste = 0,
    compaction = 0,
    exploration = 0,
    unverifiedShip = 0,
    crit = 0,
    warn = 0,
    workMs = 0;
  let totalTokens = 0,
    newTokens = 0,
    apiCalls = 0,
    resumeTurns = 0,
    resumeTokens = 0;
  for (const t of w) {
    if (t.esc) {
      escTurns++;
      escTokens += t.billable;
    }
    if (t.escStreak) escStreak++;
    if (t.context) context++;
    if (t.subWaste) subWaste++;
    if (t.compaction) compaction++;
    if (t.resumeCost > 0) {
      resumeTurns++;
      resumeTokens += t.resumeCost;
    }
    if (t.exploration) exploration++;
    if (t.unverifiedShip) unverifiedShip++;
    if (t.severity === 'crit') crit++;
    else if (t.severity === 'warn') warn++;
    workMs += t.durationMs ?? 0;
    newTokens += t.billable;
    totalTokens += t.billable + t.cacheRead; // COMPLETE = new + cache reads
    apiCalls += t.apiCalls;
    modelTokens.set(t.model, (modelTokens.get(t.model) ?? 0) + t.billable + t.cacheRead);
    // Subagents count under THEIR OWN model, not the thread that spawned them: a Haiku explorer
    // inside an Opus session is Haiku tokens. Added to the totals as well, so the by-model bars
    // still sum to the figure printed beside them — a card whose parts contradict its own total is
    // the bug this feature would otherwise introduce.
    for (const sub of t.subagentTokensByModel) {
      modelTokens.set(sub.model, (modelTokens.get(sub.model) ?? 0) + sub.tokens);
      totalTokens += sub.tokens;
    }
    newTokens += t.subagentNew;
    for (let i = 0; i < HIST_BINS.length; i++)
      if (t.billable >= HIST_BINS[i]!.min && t.billable < HIST_BINS[i]!.max) {
        hist[i]!++;
        break;
      }
  }
  const byModel = [...modelTokens].map(([model, tokens]) => ({ model, tokens })).sort((a, b) => b.tokens - a.tokens);
  return {
    turns: w.length,
    p50: pctl(bills, 0.5),
    p90: pctl(bills, 0.9),
    p95: pctl(bills, 0.95),
    p50Complete: pctl(billsComplete, 0.5),
    p95Complete: pctl(billsComplete, 0.95),
    totalTokens,
    newTokens,
    apiCalls,
    byModel,
    esc: { turns: escTurns, tokens: escTokens },
    escStreak,
    context,
    subWaste,
    compaction,
    resume: { turns: resumeTurns, tokens: resumeTokens },
    exploration,
    unverifiedShip,
    crit,
    warn,
    workMs,
    hist,
  };
}

/**
 * Aggregate per-file turn summaries into the corpus retrospective. Pure (takes `now` so it is
 * deterministic and testable). Builds the personal baseline (DESCRIPTIVE — the share card places
 * a turn against it, no detector reads it), the all-time weekly cadence, and three time windows
 * (all / last 30d / last 7d). The crit/warn split just SUMS each turn's stored severity — the
 * verdict computed it once, at summarize time, so the cache holds no second copy of the rule.
 */
export function aggregate(files: SessionSummary[], now: number = Date.now()): Retrospective {
  const all = files.flatMap((f) => f.turns);
  const withTurns = files.filter((f) => f.turns.length > 0);
  const sessions = withTurns.length;
  // Sessions whose re-entry crosses the share Claude Code's own `/usage` flags at (10%). Computed
  // here and not in `windowStats` because it is a per-SESSION share: summing turns across the
  // corpus would answer a different question.
  const reentrySessions = withTurns.filter((f) => {
    const billable = f.turns.reduce((a, t) => a + t.billable, 0);
    const resume = f.turns.reduce((a, t) => a + t.resumeCost, 0);
    return billable > 0 && resume / billable >= REENTRY_FLAG_SHARE;
  }).length;
  const baseline = aggregateBaseline(
    all.map((t) => ({ work: t.billable - t.resumeCost, effort: t.effort })),
    sessions,
  );

  // All-time tool-call counts by name, descending.
  const toolCounts = new Map<string, number>();
  for (const f of files)
    for (const [name, n] of Object.entries(f.tools)) toolCounts.set(name, (toolCounts.get(name) ?? 0) + n);
  const tools = [...toolCounts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);

  // Weekly cadence over the whole history, index 0 = the calendar week holding `now`; sized to
  // the real span so the axis is not padded with empty weeks. Undated turns (no timestamp) sit
  // out the activity chart.
  const dated = all.filter((t) => t.ts != null);
  const oldest = dated.reduce((m, t) => Math.min(m, t.ts!), now);
  const spanDays = Math.max(1, Math.round((now - oldest) / DAY_MS));
  const thisWeek = startOfWeek(now);
  const nWeeks = Math.min(MAX_WEEKS, Math.max(1, weeksBefore(oldest, thisWeek) + 1));
  const weeks = Array.from({ length: nWeeks }, () => ({ crit: 0, warn: 0, good: 0, tokens: 0, workMs: 0 }));
  for (const t of dated) {
    const wk = weeksBefore(t.ts!, thisWeek);
    if (wk < 0 || wk >= nWeeks) continue;
    const bucket = weeks[wk]!;
    bucket[t.severity]++;
    bucket.tokens += t.billable + t.cacheRead; // COMPLETE, matching RetroWindow.totalTokens
    bucket.workMs += t.durationMs ?? 0;
  }

  // Daily cadence over the last 7 calendar days (index 0 = today). Uses Math.round to absorb
  // the ±1 h gap that DST transitions leave between two consecutive local midnights.
  const todayStart = startOfDay(now);
  const days = Array.from({ length: 7 }, () => ({ crit: 0, warn: 0, good: 0, tokens: 0, workMs: 0 }));
  for (const t of dated) {
    const d = Math.round((todayStart - startOfDay(t.ts!)) / DAY_MS);
    if (d < 0 || d >= 7) continue;
    const bucket = days[d]!;
    bucket[t.severity]++;
    bucket.tokens += t.billable + t.cacheRead;
    bucket.workMs += t.durationMs ?? 0;
  }

  return {
    sessions,
    reentrySessions,
    spanDays,
    baseline,
    weeks,
    days,
    tools,
    windows: {
      all: windowStats(all, now, null),
      d30: windowStats(all, now, 30 * DAY_MS),
      d7: windowStats(all, now, 7 * DAY_MS),
    },
  };
}

export interface AggregateCacheOptions {
  /** Where the summary map is persisted (gitignored, outside the repo). */
  cacheFile: string;
  /** Injectable summarizer over the PARENT transcript's lines (tests). When absent — the
   * production path — the cache uses {@link summarizeSessionFromDisk}, which also reads the
   * session's subagent transcripts; an injected `parse` sees only the lines it is given. */
  parse?: (path: string, raw: string) => SessionSummary;
  /** Clock for the time windows (tests). Defaults to `Date.now`. */
  now?: () => number;
}

export interface AggregateCache {
  /** Incrementally refresh over the given session paths and return the corpus retrospective. */
  refresh(paths: string[]): Promise<Retrospective>;
  /** Per-path weight facts behind the cross-session comparison: the session's whole weight
   * (main + subagents), its weight by model, and how much of it its subagents spent.
   * Empty before the first refresh. */
  weightByPath(): ReadonlyMap<string, SessionWeight>;
  /** Per-path turn count and total tokens (billable + cache_read) from the current in-memory cache.
   * Empty map before the first refresh; always reflects the state after the most recent refresh. */
  statsByPath(): ReadonlyMap<string, { turns: number; totalTokens: number }>;
}

// Every field a cached turn must carry. `satisfies` proves each name exists on TurnSummary, and
// the `Missing` alias below fails the BUILD if a field is ever added to the type without being
// listed here — which is the point: the version number is a promise a human has to remember, and
// forgetting it once already shipped a retrospective reading 0 crit / 0 warn off a stale cache
// (v6 was reused for two shapes). This check does not depend on remembering anything.
const TURN_KEYS = [
  'billable',
  'cacheRead',
  'effort',
  'model',
  'apiCalls',
  'resumeCost',
  'weighted',
  'esc',
  'escStreak',
  'context',
  'compaction',
  'subWaste',
  'exploration',
  'unverifiedShip',
  'ts',
  'durationMs',
  'severity',
  'subagentTokensByModel',
  'subagentNew',
] as const satisfies readonly (keyof TurnSummary)[];
type MissingTurnKey = Exclude<keyof TurnSummary, (typeof TURN_KEYS)[number]>;
// A compile-time assertion: resolves to `never` — and fails to typecheck — the moment a field is
// added to TurnSummary and not to TURN_KEYS.
const _allTurnKeysListed: [MissingTurnKey] extends [never] ? true : never = true;
void _allTurnKeysListed;

/** One session's weight facts, as {@link AggregateCache.weightByPath} reports them. */
export interface SessionWeight {
  /** Σ per-call weight over the main thread and every subagent. */
  weight: number;
  /** Of `weight`, the part spent by subagents. */
  subagentWeight: number;
  /** `weight` split by the model of the call, weight descending. Sums to `weight`. */
  byModel: { model: string; weight: number }[];
  /** The session's COMPLETE unweighted token total, cache reads included (see
   * {@link SessionSummary.tokensComplete}). */
  tokensComplete: number;
  /** The model the MAIN thread mostly ran on, and how many it used (see {@link SessionSummary}). */
  mainModel: string | null;
  mainModels: number;
  turns: number;
  apiCalls: number;
  /** First and last work turn timestamps in the session (epoch ms), or null when none is dated. */
  firstTs: number | null;
  lastTs: number | null;
}

/** True when a cached turn carries every field {@link TurnSummary} declares. A summary written by
 * an older shape is missing some, and reading one silently yields wrong aggregates rather than an
 * error — so a file holding one is discarded and re-parsed. */
function hasTurnShape(t: unknown): boolean {
  if (!t || typeof t !== 'object') return false;
  return TURN_KEYS.every((k) => k in (t as Record<string, unknown>));
}

/**
 * Build a persistent incremental aggregate cache. The map is loaded from disk lazily on the first
 * refresh; each refresh stats every path, re-parses only those whose (size, mtime) changed, drops
 * vanished ones, persists atomically (temp + rename), and returns the aggregate. Concurrent
 * callers are serialized so the persist never races. A missing or corrupt cache file is treated
 * as empty and rebuilt, as is any entry whose turns do not carry the current shape
 * ({@link hasTurnShape}); a cache that cannot be written is simply recomputed next time.
 */
export function createAggregateCache(opts: AggregateCacheOptions): AggregateCache {
  const parse = opts.parse;
  let entries: Map<string, FileSummary> | null = null; // lazy-loaded on first refresh
  let queue: Promise<unknown> = Promise.resolve();

  async function load(): Promise<Map<string, FileSummary>> {
    if (entries) return entries;
    entries = new Map();
    try {
      const data = JSON.parse(await readFile(opts.cacheFile, 'utf8'));
      if (data?.version === CACHE_VERSION && data.files) {
        for (const [path, fs] of Object.entries<any>(data.files)) {
          if (
            fs &&
            typeof fs.mtime === 'number' &&
            typeof fs.size === 'number' &&
            Array.isArray(fs.turns) &&
            typeof fs.childStamp === 'string' &&
            fs.turns.every(hasTurnShape)
          ) {
            entries.set(path, {
              ...fs,
              tools: fs.tools ?? {},
              weightedMain: fs.weightedMain ?? 0,
              weightedSubagents: fs.weightedSubagents ?? 0,
              weightedByModel: fs.weightedByModel ?? {},
              tokensComplete: fs.tokensComplete ?? 0,
              mainModel: fs.mainModel ?? null,
              mainModels: fs.mainModels ?? 0,
              apiCalls: fs.apiCalls ?? 0,
            } as FileSummary);
          }
        }
      }
    } catch {
      /* missing/corrupt/old-version → empty, rebuilt on this refresh */
    }
    return entries;
  }

  async function persist(map: Map<string, FileSummary>): Promise<void> {
    const files: Record<string, FileSummary> = {};
    for (const [k, v] of map) files[k] = v;
    const body = JSON.stringify({ version: CACHE_VERSION, files });
    try {
      await mkdir(dirname(opts.cacheFile), { recursive: true });
      const tmp = `${opts.cacheFile}.tmp`; // refreshes are serialized, so one temp name is safe
      await writeFile(tmp, body);
      await rename(tmp, opts.cacheFile); // atomic swap — a crash never leaves a half-written cache
    } catch {
      /* a cache we cannot persist is one we recompute — never fatal */
    }
  }

  async function doRefresh(paths: string[]): Promise<Retrospective> {
    const map = await load();
    const next = new Map<string, FileSummary>();
    for (const path of paths) {
      let st: Stats;
      try {
        st = await stat(path);
      } catch {
        continue;
      } // vanished/unreadable → drop from the aggregate
      const childStamp = await subagentStamp(path);
      const hit = map.get(path);
      // Unchanged means the parent AND its children are unchanged — a subagent's transcript is
      // part of what the summary counts.
      if (hit && hit.size === st.size && hit.mtime === st.mtimeMs && hit.childStamp === childStamp) {
        next.set(path, hit);
        continue;
      }
      const sessionId = basename(path, '.jsonl');
      let summary: SessionSummary;
      try {
        summary = parse
          ? parse(path, await readFile(path, 'utf8'))
          : await summarizeSessionFromDisk(path, { sessionId, root: 'cli' });
      } catch {
        continue;
      }
      next.set(path, { mtime: st.mtimeMs, size: st.size, childStamp, ...summary });
    }
    entries = next;
    await persist(next);
    return aggregate([...next.values()], opts.now?.());
  }

  function refresh(paths: string[]): Promise<Retrospective> {
    const run = queue.then(() => doRefresh(paths));
    queue = run.catch(() => {}); // keep the chain alive even if one refresh rejects
    return run;
  }

  function statsByPath(): ReadonlyMap<string, { turns: number; totalTokens: number }> {
    const out = new Map<string, { turns: number; totalTokens: number }>();
    if (!entries) return out;
    for (const [path, fs] of entries) {
      const turns = fs.turns.length;
      const totalTokens = fs.turns.reduce((s, t) => s + t.billable + t.cacheRead, 0);
      out.set(path, { turns, totalTokens });
    }
    return out;
  }

  function weightByPath(): ReadonlyMap<string, SessionWeight> {
    const out = new Map<string, SessionWeight>();
    if (!entries) return out;
    for (const [path, fs] of entries) {
      const dated = fs.turns.map((t) => t.ts).filter((t): t is number => t !== null);
      out.set(path, {
        weight: fs.weightedMain + fs.weightedSubagents,
        subagentWeight: fs.weightedSubagents,
        byModel: Object.entries(fs.weightedByModel)
          .map(([model, weight]) => ({ model, weight }))
          .sort((a, b) => b.weight - a.weight),
        tokensComplete: fs.tokensComplete,
        mainModel: fs.mainModel,
        mainModels: fs.mainModels,
        turns: fs.turns.length,
        apiCalls: fs.apiCalls,
        firstTs: dated.length ? Math.min(...dated) : null,
        lastTs: dated.length ? Math.max(...dated) : null,
      });
    }
    return out;
  }

  return { refresh, statsByPath, weightByPath };
}
