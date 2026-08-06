/**
 * `seedeep report` — what a session cost and where the tokens went, as text a console or a Claude
 * Code session can read.
 *
 * It computes NOTHING of its own: `summarizeTree` over the real parser + reducer + verdict is the
 * same path the aggregate cache and the GUI take, so a number here and the same number in the
 * browser cannot disagree. No server has to be running — the transcript on disk is the source.
 *
 * The shape is fixed by what it costs. This output lands in the CONTEXT of the session it
 * describes, so a tool that exists to show how the context fills would otherwise fill it in
 * silence: the two standing blocks are constant-size whatever the session's length, the per-turn
 * prompts are opt-in (`--full`, the only part that grows), and the last line states the report's
 * own size.
 */

import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { windowFor } from '../core/context-windows.ts';
import { createSessionTree } from '../core/session-tree.ts';
import type { Root, TurnSummary } from '../core/types.ts';
import { type SessionSummary, summarizeTree } from './aggregate-cache.ts';
import { launchedCount } from './digest.ts';
import { streamReplay } from './replay.ts';
import { cliRoot, slugToProject } from './roots.ts';

/** How many of the costliest turns the report names. Small and fixed: the block exists to point
 * at the outliers, and a list that grows with the session is the thing this format rules out. */
const TOP_TURNS = 3;
/** Same reasoning for the tool list; the rest are counted, not named. */
const TOP_TOOLS = 6;
/** Prompt heads in `--full` are cut here — enough to recognise a turn, not to re-read it. */
const PROMPT_HEAD = 90;

/** A session file found on disk, with the project it belongs to. */
export interface FoundSession {
  path: string;
  project: string;
  root: Root;
}

/**
 * Locate `<sessionId>.jsonl` under `~/.claude/projects/*`. Returns null when no such file exists.
 *
 * A targeted lookup rather than `discoverSessions()`: that reads the head of every transcript in
 * the corpus to build a roster, and the report needs one known id — the file is named after it.
 *
 * Through {@link cliRoot}, so `CLAUDE_CONFIG_DIR` moves this exactly as it moves the command file:
 * a user who set it would otherwise be told there is no transcript for any session they have.
 */
export async function findSession(
  sessionId: string,
  home = homedir(),
  env?: Record<string, string | undefined>,
): Promise<FoundSession | null> {
  const root = cliRoot(home, env);
  let slugs: string[];
  try {
    slugs = await readdir(root);
  } catch {
    return null;
  }
  for (const slug of slugs) {
    const path = join(root, slug, `${sessionId}.jsonl`);
    try {
      const file = Bun.file(path);
      if (await file.exists()) return { path, project: slugToProject(slug), root: 'cli' };
    } catch {
      /* not a readable directory — not this one */
    }
  }
  return null;
}

/**
 * The newest session of the project the caller is standing in, or null when this directory is not
 * one Claude Code has sessions for.
 *
 * A default is safe HERE and nowhere else in this CLI: the report names its own subject on its
 * first line, so a wrong pick is visible immediately, and reading a transcript changes nothing.
 * That is the property `open` lacks — opening the wrong server looks exactly like success.
 *
 * **Never a session from another project.** A directory with no sessions gets an error, not the
 * newest transcript on the machine: that is the one way to be wrong that the first line would not
 * make obvious, because the id means nothing to the reader either way.
 *
 * The project directory is the cwd with its separators turned into dashes — verified against all 16
 * project directories on this machine, each compared with the `cwd` its own transcript recorded.
 * LIMIT: none of them contains a dot, so a path like `/home/dev/my.project` is unverified. The
 * failure is safe by construction — an unmatched directory finds nothing and reports that, rather
 * than resolving to a different project.
 */
export async function latestSessionInProject(
  cwd: string,
  home = homedir(),
  env?: Record<string, string | undefined>,
): Promise<string | null> {
  const dir = join(cliRoot(home, env), cwd.split(sep).join('-'));
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.jsonl'));
  } catch {
    return null;
  }
  let newest: { id: string; at: number } | null = null;
  for (const name of names) {
    try {
      const at = (await stat(join(dir, name))).mtimeMs;
      if (!newest || at > newest.at) newest = { id: name.slice(0, -'.jsonl'.length), at };
    } catch {
      /* vanished between the listing and the stat — not a session to report on */
    }
  }
  return newest?.id ?? null;
}

/**
 * A session's numbers plus the per-turn prompts, from ONE replay of the transcript and its
 * subagents — the file is read once, whatever the report will show. The prompts are collected
 * whether or not `--full` asked for them: the replay is the cost, not the strings.
 *
 * `entries` is aligned with `summary.turns` **by position**, because `TurnSummary` carries no id —
 * so the filter below has to be the one `summarizeTree` applies, and a test asserts the two lengths
 * agree rather than trusting that they still do.
 */
export async function readSession(
  found: FoundSession,
  sessionId: string,
): Promise<{ summary: SessionSummary; entries: TurnEntry[]; launched: number }> {
  const tree = createSessionTree({ windowFor });
  for await (const e of streamReplay(found.path, { sessionId, root: found.root })) tree.apply(e);
  const summary = summarizeTree(tree);
  const snap = tree.snapshot();
  const entries = snap.turnList
    .filter((t) => t.state !== 'live' && t.kind === 'work')
    .map((t) => ({ index: t.index, prompt: t.prompt }));
  // `launchedCount` and not `subagents.length`: how many agents a session STARTED is a fact with
  // rules (a Workflow run counts its members; a launch with no trace of itself does not count),
  // and the digest already owns them. Two implementations would be two answers.
  return { summary, entries, launched: launchedCount(snap.subagents) };
}

/** A closed work turn's identity, paired positionally with the same turn's {@link TurnSummary}. */
export interface TurnEntry {
  index: number;
  prompt: string;
}

/** `1.2M`, `812k`, `430` — a token count at a glance, never more than four characters of number. */
export function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/** `2h 14m`, `12m`, `48s` — null when the session reported no working time at all. */
export function duration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** A rough token count for the report itself — chars/4, the usual English approximation. It is
 * labelled `~` on screen for that reason: an exact count would need the tokenizer that produced
 * the session, which is not on this machine. */
export function approxTokens(text: string): number {
  return Math.round(text.length / 4);
}

function turnLine(t: TurnSummary, index: number): string {
  const flags = [
    t.esc ? 'esc' : '',
    t.context ? 'full' : '',
    t.compaction ? 'compacted' : '',
    t.subWaste ? 'sub-dump' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `  #${String(index).padEnd(4)} ${tokens(t.billable).padStart(6)}  ${t.model}${flags ? `  ${flags}` : ''}`;
}

/**
 * Render the report. Pure: every number comes from `summary`, so this is testable without a
 * transcript, and the same input always produces the same text.
 */
export function formatReport(input: {
  sessionId: string;
  project: string;
  summary: SessionSummary;
  entries: TurnEntry[];
  launched: number;
  full: boolean;
}): string {
  const { summary: s } = input;
  const turns = s.turns;
  const working = turns.reduce((a, t) => a + (t.durationMs ?? 0), 0);
  const billable = turns.reduce((a, t) => a + t.billable, 0);
  const resume = turns.reduce((a, t) => a + t.resumeCost, 0);
  const abandoned = turns.filter((t) => t.esc).reduce((a, t) => a + t.billable, 0);
  const counts = {
    esc: turns.filter((t) => t.esc).length,
    full: turns.filter((t) => t.context).length,
    compaction: turns.filter((t) => t.compaction).length,
    subWaste: turns.filter((t) => t.subWaste).length,
    exploration: turns.filter((t) => t.exploration).length,
    unverified: turns.filter((t) => t.unverifiedShip).length,
  };
  const models =
    s.mainModels > 1 ? `${s.mainModel ?? 'unknown'} (+${s.mainModels - 1} more)` : (s.mainModel ?? 'unknown');
  const toolNames = Object.entries(s.tools).sort((a, b) => b[1] - a[1]);
  const shownTools = toolNames.slice(0, TOP_TOOLS).map(([n, c]) => `${n} ${c}`);
  const restTools = toolNames.length - shownTools.length;

  const severity = {
    crit: turns.filter((t) => t.severity === 'crit').length,
    warn: turns.filter((t) => t.severity === 'warn').length,
  };
  const lines: string[] = [
    `seedeep report — ${input.sessionId}`,
    `${input.project} · ${turns.length} closed turns · ${duration(working)} working · ${s.apiCalls} API calls`,
    `${tokens(s.tokensComplete)} tokens processed · ${tokens(billable)} new · weight ${tokens(s.weightedMain + s.weightedSubagents)}`,
    `model ${models} · ${input.launched} subagents (${tokens(s.weightedSubagents)} weight) · ${severity.crit} crit, ${severity.warn} warn turns`,
    '',
    'where the tokens went',
  ];
  const spent: string[] = [];
  if (resume > 0) {
    const share = billable > 0 ? Math.round((resume / billable) * 100) : 0;
    spent.push(`  cold resumes      ${tokens(resume)} of new tokens (${share}%) re-creating context`);
  }
  if (counts.compaction) spent.push(`  compactions       ${counts.compaction} mid-turn`);
  if (counts.esc) spent.push(`  abandoned to Esc  ${tokens(abandoned)} across ${counts.esc} turns`);
  if (counts.full) spent.push(`  context ≥70%      ${counts.full} turns ended nearly full`);
  if (counts.subWaste) spent.push(`  subagent dumps    ${counts.subWaste} turns`);
  if (counts.exploration) spent.push(`  exploration       ${counts.exploration} turns read a lot, changed nothing`);
  if (counts.unverified) spent.push(`  unverified ship   ${counts.unverified} turns committed with no check run`);
  lines.push(...(spent.length ? spent : ['  nothing flagged']));

  // Paired by position before sorting — a `TurnSummary` has no id of its own, so its number comes
  // from the entry that shares its place in the list.
  const costliest = turns
    .map((t, i) => ({ t, index: input.entries[i]?.index ?? i + 1 }))
    .sort((a, b) => b.t.billable - a.t.billable)
    .slice(0, TOP_TURNS);
  if (costliest.length) {
    lines.push('', 'costliest turns');
    lines.push(...costliest.map(({ t, index }) => turnLine(t, index)));
  }
  if (shownTools.length) {
    lines.push('', `tools: ${shownTools.join(' · ')}${restTools > 0 ? ` · +${restTools} more` : ''}`);
  }

  if (input.full) {
    lines.push('', 'turns');
    for (const e of input.entries) {
      const head = e.prompt.replace(/\s+/g, ' ').trim().slice(0, PROMPT_HEAD);
      lines.push(`  #${String(e.index).padEnd(4)} ${head}`);
    }
  }

  const body = `${lines.join('\n')}\n`;
  return `${body}\nthis report cost ~${approxTokens(body)} tokens\n`;
}

/** Run `seedeep report`. Returns the process exit code. */
export async function runReport(
  sessionId: string,
  opts: { full?: boolean; home?: string } = {},
  out: { log: (s: string) => void; error: (s: string) => void } = { log: console.log, error: console.error },
): Promise<number> {
  const found = await findSession(sessionId, opts.home);
  if (!found) {
    out.error(`seedeep: no transcript for session ${sessionId} under ~/.claude/projects.`);
    return 1;
  }
  const { summary, entries, launched } = await readSession(found, sessionId);
  out.log(formatReport({ sessionId, project: found.project, summary, entries, launched, full: opts.full ?? false }));
  return 0;
}
