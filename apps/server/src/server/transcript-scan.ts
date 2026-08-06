import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { type CommitCall, harvestHashes, isGitCommit } from '../core/commit-attribution.ts';
import { ledgerPath } from '../core/file-attribution.ts';
import {
  type CardEvidence,
  type CardSource,
  cardIdFromInput,
  closingRefs,
  isTrackerTool,
  parseGhIssues,
  trackerEvidence,
} from '../core/tracker-cards.ts';
import { initTailState, readNewLines } from './tailer.ts';

/**
 * One pass over a transcript, for every consumer that needs its tool calls.
 *
 * Commits and tracker cards ask different questions of the same lines, and a transcript is the
 * expensive thing here — up to tens of MB. Scanning once, cached against the file's size+mtime,
 * is what lets the Cards card cost nothing on top of the Commits card that already ran.
 */

/** One tracker-relevant call: an MCP issue tool, or a `gh issue` invocation. */
export interface TrackerCall {
  /** When the call's result landed, ms since epoch. */
  at: number;
  source: CardSource;
  evidence: CardEvidence;
  /** MCP card id from the call's own id field; null when the call creates the card. */
  id: string | null;
  /** GitHub issue number; null for an MCP call, or for `gh issue create`. */
  number: number | null;
  /** `[host/]owner/repo` when the command named one — the issue's repository is not always the
   *  session's. Null for an MCP call, or when the command left it implicit. */
  repo: string | null;
  /** The call's result text — a creation's new id, and the title, live only here. */
  result: string;
  /** The cwd of the line that ran it, which scopes an issue number to a repository. */
  cwd: string | null;
}

/** One transcript's tool-call slice, cached against the file's size+mtime. */
export interface Scan {
  commits: CommitCall[];
  tracker: TrackerCall[];
  /** `file-history-delta` paths, absolute — CC's proof that its own tools wrote this file. */
  deltas: LedgerDelta[];
  cwds: string[];
  firstAt: number;
  lastAt: number;
}

/** One backed-up file: the absolute path, and when Claude Code wrote it. */
export interface LedgerDelta {
  path: string;
  at: number;
}

const scanCache = new Map<string, { key: string; scan: Scan }>();

/**
 * `cd <path>` / `git -C <path>` targets — the repo when the session's own cwd is not one.
 *
 * Both absolute and relative, resolved against the cwd of the line that ran them: measured, the
 * commands say `cd seedeep-workspace` far more often than they spell the path out, and a session
 * whose cwd is the PARENT of the repo (git walks up, never down) is found only this way. Dropping
 * relative targets silently lost every commit of one 21-commit session.
 */
const PATH_ARGS = /(?:\bcd\s+|\bgit\s+-C\s+)("[^"]+"|'[^']+'|[^\s;&|]+)/g;

function collectPaths(command: string, cwd: string | null, into: Set<string>): void {
  for (const m of command.matchAll(PATH_ARGS)) {
    const raw = m[1]?.replace(/^["']|["']$/g, '');
    if (!raw || raw === '-' || raw.startsWith('$')) continue; // `cd -`, `cd $VAR`: unresolvable
    if (raw.startsWith('/')) into.add(raw);
    else if (cwd) into.add(resolve(cwd, raw));
  }
}

/** The text of a tool_result, whose content is either a string or a list of text parts. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) => (typeof p === 'object' && p && 'text' in p ? String((p as { text: unknown }).text) : ''))
    .join('');
}

/** Parse one transcript for `git commit` and tracker calls, their output, and the cwds it ran in. */
export function scanLines(lines: readonly string[]): Scan {
  const commits: CommitCall[] = [];
  const tracker: TrackerCall[] = [];
  const deltas: LedgerDelta[] = [];
  const cwds = new Set<string>();
  const pendingCommit = new Map<string, string>(); // tool_use id -> command
  const pendingTracker = new Map<string, Array<Omit<TrackerCall, 'at' | 'result'>>>();
  let cwd: string | null = null; // the cwd of the line being read, for relative `cd` targets
  let firstAt = Infinity;
  let lastAt = -Infinity;
  for (const raw of lines) {
    if (!raw) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(raw);
    } catch {
      continue;
    }
    const ts = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
    if (Number.isFinite(ts)) {
      if (ts < firstAt) firstAt = ts;
      if (ts > lastAt) lastAt = ts;
    }
    if (typeof o.cwd === 'string' && o.cwd) {
      cwd = o.cwd;
      cwds.add(o.cwd);
    }
    // The ledger line. It carries no `cwd` of its own, so the last one seen resolves it — the
    // lines are read in file order, which is the order Claude Code wrote them.
    if (o.type === 'file-history-delta' && typeof o.trackingPath === 'string' && o.trackingPath) {
      const parent = (o.backup as { realParentDir?: unknown } | undefined)?.realParentDir;
      deltas.push({
        path: ledgerPath(o.trackingPath, typeof parent === 'string' ? parent : null, cwd),
        at: Number.isFinite(ts) ? ts : 0,
      });
      continue;
    }
    const msg = o.message as { content?: unknown } | undefined;
    const content = msg?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content as Array<Record<string, unknown>>) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_use') {
        if (typeof b.id !== 'string') continue;
        const name = typeof b.name === 'string' ? b.name : '';
        const cmd = (b.input as { command?: unknown } | undefined)?.command;
        if (typeof cmd === 'string' && isGitCommit(cmd)) {
          pendingCommit.set(b.id, cmd);
          collectPaths(cmd, cwd, cwds);
          // A closing keyword needs no result: the issue it names is changed by the commit itself,
          // so the touch is complete at the moment the command runs.
          for (const n of closingRefs(cmd)) {
            tracker.push({
              at: Number.isFinite(ts) ? ts : 0,
              source: 'cli',
              evidence: 'wrote',
              id: null,
              number: n,
              repo: null,
              result: '',
              cwd,
            });
          }
        }
        if (typeof cmd === 'string' && cmd.includes('gh issue')) {
          // One Bash call routinely chains several commands (`gh issue comment 2 …; gh issue close
          // 2`), and each issue it names is a touch — keeping only the first lost the rest, since
          // they never appear on a line of their own.
          const issues = parseGhIssues(cmd);
          if (issues.length) {
            pendingTracker.set(
              b.id,
              issues.map((i) => ({
                source: 'cli' as const,
                evidence: i.evidence,
                id: null,
                number: i.number,
                repo: i.repo,
                cwd,
              })),
            );
            collectPaths(cmd, cwd, cwds);
          }
        } else if (isTrackerTool(name)) {
          pendingTracker.set(b.id, [
            {
              source: 'mcp',
              evidence: trackerEvidence(name),
              id: cardIdFromInput(b.input),
              number: null,
              repo: null,
              cwd,
            },
          ]);
        }
      } else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        const command = pendingCommit.get(b.tool_use_id);
        if (command !== undefined) {
          pendingCommit.delete(b.tool_use_id);
          commits.push({
            at: Number.isFinite(ts) ? ts : 0,
            command,
            outputHashes: harvestHashes(resultText(b.content)),
          });
        }
        const metas = pendingTracker.get(b.tool_use_id);
        if (metas !== undefined) {
          pendingTracker.delete(b.tool_use_id);
          const text = resultText(b.content);
          // The result is shared by every command in the call, and only a creation reads it. With
          // more than one creation in a single call there is no telling which number is whose, so
          // none of them takes it — a missing row beats a wrong one.
          const creations = metas.filter((m) => m.number === null && m.id === null).length;
          for (const meta of metas) {
            const own = meta.number === null && meta.id === null && creations > 1 ? '' : text;
            tracker.push({ ...meta, at: Number.isFinite(ts) ? ts : 0, result: own });
          }
        }
      }
    }
  }
  // A call whose result never landed (the session was killed mid-commit) still testifies.
  for (const [, command] of pendingCommit) {
    commits.push({ at: Number.isFinite(lastAt) ? lastAt : 0, command, outputHashes: [] });
  }
  // A tracker call with no result keeps its id — the action happened; only the title is lost. One
  // that was CREATING a card is dropped: without the result there is no card to name.
  for (const [, metas] of pendingTracker) {
    for (const meta of metas) {
      if (meta.id === null && meta.number === null) continue;
      tracker.push({ ...meta, at: Number.isFinite(lastAt) ? lastAt : 0, result: '' });
    }
  }
  commits.sort((a, b) => a.at - b.at);
  tracker.sort((a, b) => a.at - b.at);
  return { commits, tracker, deltas, cwds: [...cwds], firstAt, lastAt };
}

/** Scan a transcript and its subagent sidecars — a subagent's work belongs to its parent. */
export async function scanSession(path: string): Promise<Scan> {
  let key = '';
  try {
    const st = await stat(path);
    key = `${st.size}:${st.mtimeMs}`;
    const hit = scanCache.get(path);
    if (hit && hit.key === key) return hit.scan;
  } catch {
    return { commits: [], tracker: [], deltas: [], cwds: [], firstAt: Infinity, lastAt: -Infinity };
  }
  const { lines } = await readNewLines(path, initTailState());
  const scan = scanLines(lines);
  // Subagents commit and file cards too: 1228 of ~2000 local transcripts are sidecars, and their
  // work is the parent session's work. Same layout call-io reads.
  const subDir = join(dirname(path), basename(path, '.jsonl'), 'subagents');
  try {
    for (const child of await readdir(subDir)) {
      if (!/^agent-.+\.jsonl$/.test(child)) continue;
      const { lines: childLines } = await readNewLines(join(subDir, child), initTailState());
      const sub = scanLines(childLines);
      scan.commits.push(...sub.commits);
      scan.tracker.push(...sub.tracker);
      // A subagent's writes are the parent session's work — measured 0 sidecar deltas locally, but
      // reading them costs nothing and the day CC starts writing them the card is already right.
      scan.deltas.push(...sub.deltas);
      for (const c of sub.cwds) if (!scan.cwds.includes(c)) scan.cwds.push(c);
    }
    scan.commits.sort((a, b) => a.at - b.at);
    scan.tracker.sort((a, b) => a.at - b.at);
  } catch {
    // no sidecars — the common case
  }
  scanCache.set(path, { key, scan });
  return scan;
}
