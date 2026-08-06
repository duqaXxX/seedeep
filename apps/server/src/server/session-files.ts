import { type FilesOrigin, mergeFiles, type SessionFiles, scratchFiles } from '../core/file-attribution.ts';
import { anon } from '../core/text.ts';
import type { SessionRecord } from '../core/types.ts';
import { type RepoRef, readCommitFiles, repoFor } from './git.ts';
import { commitsForSession } from './session-commits.ts';
import { type Scan, scanSession } from './transcript-scan.ts';

/**
 * The files a session changed, read from the commits it produced (see `docs/changed-files.md`).
 *
 * Every number is one a reader can reproduce with `git show --stat`. Nothing is inferred: a file
 * written by a shell command carries no record of WHICH session wrote it, and the working tree
 * cannot stand in for that — `git status` describes the repository, not a session.
 */

const EMPTY: SessionFiles = { files: [], scratch: [], roots: [], origin: { kind: 'no-repo' } };

/**
 * Every repo a session's cwds resolve to, keyed by TOPLEVEL rather than `--git-common-dir`.
 *
 * The commits feature collapses linked worktrees by common dir, because they share one commit
 * history. Here the path matters as much as the history: a file of a commit made in worktree B
 * lives under B's toplevel, and prefixing it with A's would name a file that is not there.
 */
async function reposOf(scan: Scan): Promise<RepoRef[]> {
  const repos = new Map<string, RepoRef>();
  for (const cwd of scan.cwds) {
    const repo = await repoFor(cwd);
    if (repo && !repos.has(repo.toplevel)) repos.set(repo.toplevel, repo);
  }
  return [...repos.values()];
}

/**
 * The files `rec` delivered, newest first, each carrying the commit that delivered it.
 *
 * `others` must be every known session: `commitsForSession` needs them to keep a commit exclusive
 * to the session that made it (attribution by proof, `docs/commits.md`).
 */
export async function filesForSession(rec: SessionRecord, others: readonly SessionRecord[]): Promise<SessionFiles> {
  const scan = await scanSession(rec.path);
  // Anonymized FIRST: `isScratchPath` classifies on the `~scratch` token `anon` produces, never on
  // the raw path — the scratchpad root is spelled three ways across platforms, and testing the raw
  // form silently classified every temporary as a repo file.
  const scratch = scratchFiles(scan.deltas.map((d) => ({ ...d, path: anon(d.path, 200) })));
  const repos = await reposOf(scan);
  if (!repos.length) return { ...EMPTY, scratch };

  const { commits } = await commitsForSession(rec, others);
  const found: Array<{ path: string; at: number; commit: string }> = [];
  let failed = false;
  for (const c of commits) {
    for (const r of repos) {
      const paths = await readCommitFiles(r, c.hash);
      // null is git FAILING, not a commit without files: the difference is what decides whether the
      // card may claim "nothing committed" at all.
      if (paths === null) {
        failed = true;
        continue;
      }
      if (!paths.length) continue;
      for (const p of paths) found.push({ path: p, at: c.at, commit: c.short });
      break; // the repo that has the object is the one that answered
    }
  }

  const files = mergeFiles(found).map((f) => ({ ...f, path: anon(f.path, 200) }));
  const origin: FilesOrigin = files.length
    ? { kind: 'commits', commits: commits.length }
    : failed
      ? { kind: 'unknown' }
      : { kind: 'none' };

  return { files, scratch, roots: repos.map((r) => anon(r.toplevel, 200)), origin };
}
