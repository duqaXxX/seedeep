import {
  type Attribution,
  attributeCommits,
  type CommitCall,
  type SessionCommit,
  type SessionCommits,
  WINDOW_MS,
} from '../core/commit-attribution.ts';
import type { SessionRecord } from '../core/types.ts';
import {
  commitUrl,
  type RepoRef,
  readCommit,
  readCommits,
  remoteBase,
  repoFor,
  unpushedHashes,
  whyNoRepo,
} from './git.ts';
import { type Scan, scanSession } from './transcript-scan.ts';

/**
 * The commits a session produced — joined from its transcript (who) and git (what exists).
 *
 * Reading order matters for cost: a session that never ran `git commit` returns immediately,
 * having touched no repository at all. Measured on this corpus, that is 639 of 783 sessions.
 */

/** Every repo this session touched, keyed by `--git-common-dir` so worktrees collapse to one. */
async function reposOf(scan: Scan): Promise<Map<string, RepoRef>> {
  const repos = new Map<string, RepoRef>();
  for (const cwd of scan.cwds) {
    const repo = await repoFor(cwd);
    if (repo && !repos.has(repo.commonDir)) repos.set(repo.commonDir, repo);
  }
  return repos;
}

/**
 * `{ denied: true }` when any of the session's directories exists but cannot be entered, `{}`
 * otherwise — the shape a caller can spread into its answer.
 *
 * The distinction the card needs: an empty list means "no commits" only if seedeep was actually
 * allowed to look. On macOS it often was not — `~/Documents`, `~/Desktop` and `~/Downloads` are
 * gated, and until the user answers a system dialog every repository under them is invisible.
 */
async function deniedAnyCwd(scan: Scan): Promise<{ denied?: true }> {
  for (const cwd of scan.cwds) {
    if ((await whyNoRepo(cwd)) === 'denied') return { denied: true };
  }
  return {};
}

/** First `cwd` in a transcript — enough to find its repo, without reading the whole file. */
const cwdCache = new Map<string, string | null>();

async function firstCwd(path: string): Promise<string | null> {
  const hit = cwdCache.get(path);
  if (hit !== undefined) return hit;
  let cwd: string | null = null;
  try {
    // The head of the file: `cwd` is on the very first lines, and reading 64KB of a 50MB
    // transcript is the difference between a search that answers and one that stalls.
    const head = await Bun.file(path).slice(0, 65536).text();
    for (const line of head.split('\n').slice(0, 8)) {
      try {
        const v = (JSON.parse(line) as { cwd?: unknown }).cwd;
        if (typeof v === 'string' && v) {
          cwd = v;
          break;
        }
      } catch {
        // a truncated last line in the slice — keep looking
      }
    }
  } catch {
    cwd = null;
  }
  cwdCache.set(path, cwd);
  return cwd;
}

/**
 * The sessions that produced commit `hash`, by the same evidence `/api/commits` uses.
 *
 * The inverse lookup: a hash arrives with no repo attached, so every repo the corpus knows is
 * asked whether it has that object (measured: 3 distinct repos over 713 sessions, 37 ms to ask
 * them all). Once one answers, only the sessions whose activity brackets that commit are read.
 *
 * Returns session ids, empty when no repo has the hash or nothing can be attributed — never a
 * guess: this feeds a search result, and a wrong session there is worse than no row.
 */
export async function sessionsForCommit(hash: string, records: readonly SessionRecord[]): Promise<string[]> {
  const repos = new Map<string, RepoRef>();
  for (const rec of records) {
    const cwd = await firstCwd(rec.path);
    if (!cwd) continue;
    const repo = await repoFor(cwd);
    if (repo && !repos.has(repo.commonDir)) repos.set(repo.commonDir, repo);
  }
  for (const repo of repos.values()) {
    const commit = await readCommit(repo, hash);
    if (!commit) continue;
    const from = commit.authoredAt - WINDOW_MS;
    const to = commit.authoredAt + WINDOW_MS;
    const day = 86_400_000;
    const calls: Array<{ sessionId: string; calls: CommitCall[] }> = [];
    for (const rec of records) {
      // The session must have been alive around the commit; its own calls are filtered by the
      // attribution itself, so this bound only keeps the scan small.
      if (rec.lastActivity < from - day || rec.lastActivity > to + day) continue;
      const scan = await scanSession(rec.path);
      if (!scan.commits.length) continue;
      calls.push({ sessionId: rec.sessionId, calls: scan.commits });
    }
    const attributed = attributeCommits([commit], calls);
    if (attributed.length) return attributed.map((a) => a.sessionId);
  }
  return [];
}

/**
 * The commits `rec` produced, newest first.
 *
 * `others` must be every known session, so the ones sharing a repo and a time window can be
 * scanned too: attribution is exclusive ACROSS sessions, and computing it for one session in
 * isolation is what would put the same commit in two lists.
 *
 * LIMIT: a sibling is considered when its `lastActivity` falls within a day of this session's
 * span. A session left open for a week after committing inside the window is therefore missed,
 * and its commit could be attributed here by testimony (never by proof).
 */
export async function commitsForSession(rec: SessionRecord, others: readonly SessionRecord[]): Promise<SessionCommits> {
  const scan = await scanSession(rec.path);
  if (!scan.commits.length) return { commits: [], remote: null };

  const callTimes = scan.commits.map((c) => c.at);
  const from = Math.min(scan.firstAt, ...callTimes) - WINDOW_MS;
  const to = Math.max(scan.lastAt, ...callTimes) + WINDOW_MS;
  const repos = await reposOf(scan);
  // A session that RAN `git commit` and whose repository cannot be found is the one case worth
  // explaining: either the directory has gone, or seedeep was refused it. Asked only here, so the
  // ordinary path — a repo that resolved — costs nothing.
  if (!repos.size) return { commits: [], remote: null, ...(await deniedAnyCwd(scan)) };

  const day = 86_400_000;
  const siblings: Array<{ sessionId: string; scan: Scan }> = [];
  for (const other of others) {
    if (other.sessionId === rec.sessionId) continue;
    const last = other.lastActivity;
    if (!Number.isFinite(last) || last < from - day || last > to + day) continue;
    const s = await scanSession(other.path);
    if (!s.commits.length) continue;
    const theirs = await reposOf(s);
    if (![...theirs.keys()].some((k) => repos.has(k))) continue;
    siblings.push({ sessionId: other.sessionId, scan: s });
  }

  const out: SessionCommit[] = [];
  let remote: string | null = null;
  for (const repo of repos.values()) {
    const commits = await readCommits(repo, from, to);
    if (!commits.length) continue;
    const attributed: Attribution[] = attributeCommits(commits, [
      { sessionId: rec.sessionId, calls: scan.commits },
      ...siblings.map((s) => ({ sessionId: s.sessionId, calls: s.scan.commits })),
    ]);
    const mine = attributed.filter((a) => a.sessionId === rec.sessionId);
    if (!mine.length) continue;
    const base = await remoteBase(repo);
    remote ??= base;
    const unpushed = await unpushedHashes(repo);
    const byHash = new Map(commits.map((c) => [c.hash, c]));
    for (const a of mine) {
      const c = byHash.get(a.hash);
      if (!c) continue;
      out.push({
        hash: c.hash,
        short: c.hash.slice(0, 7),
        subject: c.subject,
        at: c.authoredAt,
        evidence: a.evidence,
        // An unpushed commit has no page yet: a link would 404, so it gets none.
        url: unpushed.has(c.hash) ? null : commitUrl(base, c.hash),
      });
    }
  }
  out.sort((a, b) => b.at - a.at);
  return { commits: out, remote };
}
