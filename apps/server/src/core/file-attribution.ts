/**
 * The files a session changed — counted from its commits, and from nothing else.
 *
 * Claude Code's rewind ledger records only what CC's own file-writing tools wrote: on a real commit
 * of 16 files, 8 had been written with a `python3` heredoc or `cat >>` and the ledger knew nothing
 * of them. And WHICH session wrote a file by shell is recorded nowhere at all — with two sessions
 * working the same repo, no source on disk tells them apart. Any attribution built on timing would
 * be a guess, and a count that is a guess is worse than no count.
 *
 * The working tree was tried as a second source and REMOVED for exactly that reason: `git status`
 * describes the repository now, not what one session did, so two live sessions in one repo would
 * each claim the whole dirty tree — the very inference this module refuses for commits. What
 * remains is the one thing that is both complete and provably a session's own: the files of the
 * commits attributed to it (`docs/commits.md`), which include shell writes and build output
 * because a commit carries what changed, not how it was written.
 *
 * The ledger survives for the ONE thing git cannot see: the session scratchpad, which lives
 * outside the repository.
 */

import type { SessionArtifact } from './session-artifacts.ts';
import { isScratchPath } from './text.ts';

export interface SessionFile {
  /** Absolute path, anonymized. */
  path: string;
  /** When the change was delivered: the commit's instant, or the ledger's for a scratchpad file. */
  at: number;
  /** Short hash of the commit that carries it; null for a scratchpad file, which is in none. */
  commit: string | null;
}

/**
 * Which verifiable set the count came from — the card's description, and the reason a reader can
 * check it. Deliberately carries NO second count: two numbers on one card invite a subtraction,
 * and the moment they fail to add up the card reads as broken.
 *
 * `unknown` is not `none`: git failed (missing binary, timeout, unreadable repo), and claiming
 * "nothing was committed" from a failed read would be the card asserting something it never
 * learned.
 */
export type FilesOrigin =
  | { kind: 'commits'; commits: number }
  | { kind: 'none' }
  | { kind: 'no-repo' }
  | { kind: 'unknown' };

/** What `GET /api/files` answers for one session. */
export interface SessionFiles {
  /** Repo files this session's commits delivered, deduped, newest first. */
  files: SessionFile[];
  /** Scratchpad files it wrote — the ledger's one exclusive, kept off the main count. */
  scratch: SessionFile[];
  /** Pages it published online, newest first — off the main count for the same reason: an artifact
   *  is not a file this session changed, it is a page it put somewhere else (`session-artifacts.ts`). */
  artifacts: SessionArtifact[];
  /** Every repo root the paths sit under, anonymized; a row inside one is shown relative to it. */
  roots: string[];
  origin: FilesOrigin;
}

/** One row as the card and the drawer show it: the path split for display. */
export interface DisplayFile {
  path: string;
  base: string;
  /** Directory, relative to its repo root when the file is inside one — the form git uses. */
  dir: string;
  at: number;
  commit: string | null;
  /** True for a scratchpad temporary: counted apart from the project everywhere. */
  scratch: boolean;
}

/**
 * Dedupe the commits' files into one list, newest first.
 *
 * A path delivered by several commits keeps the LATEST one — that is the commit a reader would
 * open to see its current state — and counts once, so the hero can never exceed the distinct files
 * the commits carry.
 */
export function mergeFiles(files: ReadonlyArray<{ path: string; at: number; commit: string }>): SessionFile[] {
  const by = new Map<string, SessionFile>();
  for (const f of files) {
    const prev = by.get(f.path);
    if (!prev || f.at > prev.at) by.set(f.path, { path: f.path, at: f.at, commit: f.commit });
  }
  return [...by.values()].sort((a, b) => b.at - a.at || a.path.localeCompare(b.path));
}

/** The scratchpad paths a session's ledger holds, deduped, newest first. */
export function scratchFiles(deltas: ReadonlyArray<{ path: string; at: number }>): SessionFile[] {
  const by = new Map<string, number>();
  for (const d of deltas) {
    if (!isScratchPath(d.path)) continue;
    const prev = by.get(d.path);
    if (prev === undefined || d.at > prev) by.set(d.path, d.at);
  }
  return [...by.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([path, at]) => ({ path, at, commit: null }));
}

/**
 * Split each file for display, shortening a path that sits under one of the repo roots.
 *
 * `roots` is every repository the session touched, not just the first: a session that moves
 * between two repos would otherwise show one set of rows relative and the other as full absolute
 * paths. The longest matching root wins, so nested repos shorten against the inner one.
 */
export function displayFiles(files: readonly SessionFile[], roots: readonly string[], scratch = false): DisplayFile[] {
  const prefixes = [...roots].map((r) => r.replace(/\/$/, '') + '/').sort((a, b) => b.length - a.length);
  return files.map((f) => {
    const prefix = prefixes.find((p) => f.path.startsWith(p));
    const shown = prefix ? f.path.slice(prefix.length) : f.path;
    const slash = shown.lastIndexOf('/');
    return {
      path: f.path,
      base: shown.slice(slash + 1),
      dir: slash >= 0 ? shown.slice(0, slash + 1) : '',
      at: f.at,
      commit: f.commit,
      scratch,
    };
  });
}

/**
 * The absolute path a `file-history-delta` names.
 *
 * `trackingPath` has TWO shapes: measured over every local delta (2026-08-03), 609 of 1765 are
 * absolute and 1156 relative to the session's cwd. `backup.realParentDir` (present on 1192) names
 * the directory the file really sits in, and beats the cwd — a subagent or a `cd` moves the cwd,
 * the parent dir cannot lie. With neither, the path is returned untouched: an unresolvable path is
 * still the best label, and inventing a prefix would name the wrong file.
 */
export function ledgerPath(trackingPath: string, realParentDir: string | null, cwd: string | null): string {
  if (/^(?:\/|[A-Za-z]:[\\/])/.test(trackingPath)) return trackingPath;
  const slash = Math.max(trackingPath.lastIndexOf('/'), trackingPath.lastIndexOf('\\'));
  const base = trackingPath.slice(slash + 1);
  if (realParentDir) return `${realParentDir.replace(/[/\\]$/, '')}/${base}`;
  if (cwd) return `${cwd.replace(/[/\\]$/, '')}/${trackingPath}`;
  return trackingPath;
}
