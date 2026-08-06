import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import type { RepoCommit } from '../core/commit-attribution.ts';

/**
 * The read-only git side of seedeep — the commits card and the changed-files card.
 *
 * seedeep otherwise reads only `~/.claude/projects`; this module is the one place it touches the
 * user's repository, and it only ever READS: `rev-parse`, `log`, `diff-tree`, `remote get-url`,
 * `rev-list`.
 *
 * **`--no-optional-locks` on every call**, so the invariant is structural instead of a promise
 * about which subcommands happen to be safe. Some porcelain refreshes the index as a side effect
 * and takes `.git/index.lock` to do it — measured on git 2.50.1, `git status` rewrote `.git/index`
 * (its checksum changed) while the same command under this flag left it byte-identical. seedeep
 * polls the repository of a session that is actively committing; taking that lock, even for a
 * millisecond, can fail the user's own `git add`/`commit`. Reading must never be able to do that.
 *
 * Every call goes through `git()` with an argv array — never a shell string — so a path or a
 * branch name can carry any character without becoming a command.
 */

const TIMEOUT_MS = 5000;

/** Run git in `cwd` and resolve its stdout, or null on any non-zero exit / missing binary. */
function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (v: string | null) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('git', ['--no-optional-locks', ...args], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return finish(null);
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null);
    }, TIMEOUT_MS);
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish(code === 0 ? out : null);
    });
  });
}

export interface RepoRef {
  /** The working tree root — where `git log` runs. */
  toplevel: string;
  /**
   * `--git-common-dir`, the repo's IDENTITY. Two worktrees of one repo report DIFFERENT
   * toplevels but the same common dir, and `git log --all` from either sees both their commits —
   * so sessions working in parallel worktrees must collapse to one reader, not N.
   */
  commonDir: string;
}

/**
 * Resolve the repository containing `cwd` (walking up, so a session sitting in a subdirectory
 * still finds it). Null when `cwd` is not inside a repo — the common case for seedeep itself,
 * whose sessions run one level above the workspace.
 */
export async function resolveRepo(cwd: string): Promise<RepoRef | null> {
  const out = await git(cwd, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir']);
  if (!out) return null;
  const [toplevel, commonDir] = out.trim().split('\n');
  if (!toplevel || !commonDir) return null;
  return { toplevel, commonDir };
}

const repoCache = new Map<string, RepoRef | null>();

/** `resolveRepo`, remembered per directory: the lookup is a subprocess, and a repo never moves. */
export async function repoFor(cwd: string): Promise<RepoRef | null> {
  const hit = repoCache.get(cwd);
  if (hit !== undefined) return hit;
  const repo = await resolveRepo(cwd);
  repoCache.set(cwd, repo);
  return repo;
}

/**
 * Why {@link repoFor} found nothing: the directory is genuinely not in a repository, or seedeep
 * could not so much as enter it.
 *
 * The two are indistinguishable from the result — `git()` swallows every failure into `null` — and
 * that silence is what shipped a card reading *"No commits in scope yet."* to a user whose repository
 * seedeep had simply been refused. On macOS the refusal is TCC: the Documents, Desktop and Downloads
 * folders are gated, and a session working in one of them is the ordinary case, not an exotic one.
 *
 * Called ONLY when there is no repo, so the common path pays nothing. Both `EACCES` (a directory
 * whose mode forbids it, measured) and `EPERM` (what a macOS privacy gate answers) count as refused;
 * `ENOENT` does NOT — a project directory that has been moved or deleted is a different fact, and
 * telling the user to grant a permission would be advice for a problem they do not have.
 */
export async function whyNoRepo(cwd: string): Promise<'none' | 'denied'> {
  try {
    await access(cwd, constants.R_OK | constants.X_OK);
    return 'none';
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'EACCES' || code === 'EPERM' ? 'denied' : 'none';
  }
}

const LOG_FORMAT = '%H%x09%at%x09%s';

/**
 * Commits authored in [fromMs, toMs], across ALL refs (a commit may sit on a branch that is not
 * checked out). `--since/--until` filter on the COMMITTER date, so the range handed to git is
 * widened by a day and the author date is filtered here — the two differ on a rebased commit,
 * and the author date is the one that matches when the session ran.
 */
export async function readCommits(repo: RepoRef, fromMs: number, toMs: number): Promise<RepoCommit[]> {
  const pad = 86_400_000;
  const out = await git(repo.toplevel, [
    'log',
    '--all',
    '--no-decorate',
    `--since=${Math.floor((fromMs - pad) / 1000)}`,
    `--until=${Math.floor((toMs + pad) / 1000)}`,
    `--format=${LOG_FORMAT}`,
  ]);
  if (!out) return [];
  const commits: RepoCommit[] = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [hash, at, ...rest] = line.split('\t');
    const authoredAt = Number(at) * 1000;
    if (!hash || !Number.isFinite(authoredAt)) continue;
    if (authoredAt < fromMs || authoredAt > toMs) continue;
    commits.push({ hash, authoredAt, subject: rest.join('\t') });
  }
  return commits;
}

/**
 * One commit by hash, or null when this repo does not have it. `--no-walk` stops git from
 * listing the ancestry, and `--` ends the revision list so a hash that happens to name a file
 * cannot turn into a path argument.
 */
export async function readCommit(repo: RepoRef, hash: string): Promise<RepoCommit | null> {
  const out = await git(repo.toplevel, ['log', '--no-walk', `--format=${LOG_FORMAT}`, hash, '--']);
  const line = out?.trim().split('\n')[0];
  if (!line) return null;
  const [full, at, ...rest] = line.split('\t');
  const authoredAt = Number(at) * 1000;
  if (!full || !Number.isFinite(authoredAt)) return null;
  return { hash: full, authoredAt, subject: rest.join('\t') };
}

// A commit's file list never changes, so it is remembered per (repo, hash). Without this the
// changed-files endpoint spawns one git per commit on every poll — and it polls every 1.5s while a
// turn is writing files.
const commitFilesCache = new Map<string, string[]>();

/**
 * The files a commit touched, as absolute paths, or null when git could not answer.
 *
 * `-z` is not optional: `--name-only` C-quotes any path outside ASCII (`core.quotePath` defaults to
 * true), so `src/caf\u00e9.ts` comes back as a `"src/caf\\303\\251.ts"` literal — a string that matches
 * nothing else, defeats the root-prefix strip, and shows a reader an escape blob. `--root` so the
 * first commit of a repo lists its files instead of nothing, and `--` so a hash that also names a
 * file cannot be read as a path.
 *
 * Null and empty are different answers: empty means the commit touched nothing this can see (a
 * merge — see below), null means git failed, and the caller must not report either as "no files".
 *
 * LIMIT: a MERGE commit lists no files here (git would need `-m`, which then reports the same file
 * once per parent). Merges are not where a session's own work lands, and inflating a card with a
 * merge's whole diff would be worse than the gap.
 */
export async function readCommitFiles(repo: RepoRef, hash: string): Promise<string[] | null> {
  const key = `${repo.commonDir}\u0000${hash}`;
  const hit = commitFilesCache.get(key);
  if (hit) return hit;
  const out = await git(repo.toplevel, [
    'diff-tree',
    '--no-commit-id',
    '--name-only',
    '-r',
    '-z',
    '--root',
    hash,
    '--',
  ]);
  if (out === null) return null;
  const root = repo.toplevel.replace(/\/$/, '');
  const paths = out
    .split('\0')
    .filter(Boolean)
    .map((p) => `${root}/${p}`);
  commitFilesCache.set(key, paths);
  return paths;
}

/** Hashes reachable from no remote — i.e. NOT pushed, so they have no page on the forge yet. */
export async function unpushedHashes(repo: RepoRef): Promise<Set<string>> {
  const out = await git(repo.toplevel, ['rev-list', '--all', '--not', '--remotes']);
  return new Set(out ? out.split('\n').filter(Boolean) : []);
}

/**
 * `origin`'s URL as a browsable https base (`https://host/owner/repo`), or null when the repo has
 * no origin. Normalises the three shapes git stores: `git@host:owner/repo.git`,
 * `ssh://git@host/owner/repo.git`, `https://host/owner/repo.git`.
 *
 * LIMIT: userinfo already present in an https remote is kept, so an Azure DevOps remote of the
 * form `https://<user>@dev.azure.com/…` yields a link carrying that username.
 */
export async function remoteBase(repo: RepoRef): Promise<string | null> {
  const raw = (await git(repo.toplevel, ['remote', 'get-url', 'origin']))?.trim();
  if (!raw) return null;
  const scp = raw.match(/^[\w.-]+@([^:]+):(.+)$/);
  const url = scp ? `https://${scp[1]}/${scp[2]}` : raw.replace(/^ssh:\/\/[^@]+@/, 'https://');
  if (!url.startsWith('https://') && !url.startsWith('http://')) return null;
  return url.replace(/\.git$/, '').replace(/\/+$/, '');
}

/**
 * The commit's page on the forge. GitLab nests it under `/-/`; GitHub, Gitea and Codeberg take the
 * plain `/commit/<hash>`. Returns null without a remote — a commit with no origin has nowhere to
 * link to.
 *
 * The hostname test is a heuristic and it deliberately does NOT have to be exhaustive: measured
 * against gitlab.com on 2026-08-01, `/commit/<sha>` answers `301 → /-/commit/<sha>`, so a
 * self-hosted GitLab on an arbitrary domain (`git.company.it`) still resolves. Matching `gitlab.`
 * only saves the redirect.
 *
 * LIMIT: Bitbucket serves `/commits/<hash>` (plural) and whether it redirects the singular form is
 * UNVERIFIED; Azure DevOps uses a different shape altogether. Covering either needs an explicit
 * per-forge map, not one more hostname guess. See `docs/commits.md`.
 */
export function commitUrl(base: string | null, hash: string): string | null {
  if (!base) return null;
  const sep = /(^|\/\/|\.)gitlab\./.test(base) ? '/-/commit/' : '/commit/';
  return `${base}${sep}${hash}`;
}

/**
 * The issue's page on the forge — the same shape rule as `commitUrl`, GitLab nesting it under
 * `/-/`. Unlike a tracker card, whose url is read back from the tool that touched it, an issue
 * number has no result to carry one (`gh issue close` prints none), so here it is built.
 */
export function issueUrl(base: string | null, number: number): string | null {
  if (!base) return null;
  const sep = /(^|\/\/|\.)gitlab\./.test(base) ? '/-/issues/' : '/issues/';
  return `${base}${sep}${number}`;
}

/**
 * A repository's IDENTITY, for keying an issue number that is unique only inside it:
 * `host/owner/repo`.
 *
 * The host belongs in it — `github.com/a/b` and `gitlab.com/a/b` are different repositories, and
 * their `#42` are different issues. This is also the ONE definition of that identity: a scope
 * derived from a command's own `--repo` must produce the same string, or a single issue touched
 * both ways renders as two rows. Which is exactly what a live test found.
 */
export function repoSlug(base: string | null): string | null {
  if (!base) return null;
  const m = base.match(/^https?:\/\/([^/]+)\/(.+?)\/*$/);
  return m ? `${m[1]}/${m[2]}` : null;
}
