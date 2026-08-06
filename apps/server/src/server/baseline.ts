import { readFile } from 'node:fs/promises';
import { windowFor } from '../core/context-windows.ts';
import { createSessionTree } from '../core/session-tree.ts';
import type { Baseline, Bucket, Root } from '../core/types.ts';
import { turnWork } from '../core/verdict.ts';
import { parseLine } from './parser.ts';

// The user's personal baseline, computed from the local session corpus. DESCRIPTIVE only — no
// detector reads it (the one that did was removed 2026-07-27, see `core/verdict.ts`). The share
// card uses it to place a turn against how big THIS user's turns usually are, split by effort so
// a `high`-effort turn is not placed against a `low` one.
// `Baseline`/`Bucket` live in types.ts so the client can `import type` them without pulling in
// this module's `node:fs` dependency.
export type { Baseline, Bucket } from '../core/types.ts';

export interface TurnStat {
  /** The turn's WORK tokens: input + output + cache_creation, minus what it spent re-entering its
   * own context ({@link turnResumeCost}). A resume inflates both a turn's number and the
   * percentile it is judged against, so the baseline must be built on work alone. */
  work: number;
  effort: string;
}

/** Nearest-rank percentile (p in [0,1]) over an already-SORTED ascending array; 0 when empty. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.max(0, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.min(sorted.length - 1, idx)]!;
}

/** Build a bucket from raw (unsorted) billable values. */
function bucket(values: number[]): Bucket {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    p95: percentile(sorted, 0.95),
  };
}

/** Aggregate per-turn stats into the overall + per-effort baseline. Pure. */
export function aggregateBaseline(turns: TurnStat[], sessionsScanned: number): Baseline {
  const byEffortValues = new Map<string, number[]>();
  for (const t of turns) {
    const arr = byEffortValues.get(t.effort) ?? [];
    arr.push(t.work);
    byEffortValues.set(t.effort, arr);
  }
  const byEffort: Record<string, Bucket> = {};
  for (const [effort, values] of byEffortValues) byEffort[effort] = bucket(values);
  return {
    overall: bucket(turns.map((t) => t.work)),
    byEffort,
    turnsScanned: turns.length,
    sessionsScanned,
  };
}

/**
 * Extract per-turn work tokens + effort from raw jsonl lines, through the REAL parser + reducer
 * (so turn segmentation matches the live pipeline). Live/unclosed turns are excluded — only a
 * turn that has ended contributes to the baseline.
 */
export function extractTurns(lines: string[], ctx: { sessionId: string; root: Root }): TurnStat[] {
  const tree = createSessionTree({ windowFor });
  let seq = 0;
  for (const line of lines) {
    for (const e of parseLine(line, { ...ctx, seq: seq++, agentId: null })) tree.apply(e);
  }
  return tree
    .snapshot()
    .turnList.filter((t) => t.state !== 'live' && t.kind === 'work')
    .map((t) => ({ work: turnWork(t), effort: t.efforts.at(-1) ?? 'unknown' }));
}

/** Read + scan one session file; returns [] on any read/parse failure (never throws). */
async function scanFile(path: string): Promise<TurnStat[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  return extractTurns(raw.split('\n'), { sessionId: path, root: 'cli' });
}

/** Compute the baseline across a list of session files. Files that yield no turns are skipped. */
export async function computeBaseline(files: string[]): Promise<Baseline> {
  const all: TurnStat[] = [];
  let sessionsScanned = 0;
  for (const f of files) {
    const stats = await scanFile(f);
    if (stats.length > 0) sessionsScanned++;
    all.push(...stats);
  }
  return aggregateBaseline(all, sessionsScanned);
}
