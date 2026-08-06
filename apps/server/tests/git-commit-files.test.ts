import { afterAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCommitFiles, resolveRepo, whyNoRepo } from '../src/server/git.ts';

/**
 * Against a REAL repository, because the defect these guard lives in git's output format, not in
 * our parsing of an imagined one: `--name-only` C-quotes any path outside ASCII (`core.quotePath`
 * defaults to true), so a hand-written fixture would encode the belief that produced the bug.
 */

const repo = mkdtempSync(join(tmpdir(), 'seedeep-git-'));
const git = (...args: string[]) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });

afterAll(() => rmSync(repo, { recursive: true, force: true }));

git('init', '-q', '.');
git('config', 'user.email', 'test@example.com');
git('config', 'user.name', 'test');
writeFileSync(join(repo, 'café.ts'), 'x\n'); // non-ASCII: the quoting case
writeFileSync(join(repo, 'plain.ts'), 'y\n');
git('add', '-A');
git('commit', '-qm', 'first');
const head = git('rev-parse', 'HEAD').stdout.trim();

test('a non-ASCII path comes back as itself, not as a C-quoted escape blob', async () => {
  const ref = await resolveRepo(repo);
  expect(ref).not.toBeNull();
  const files = await readCommitFiles(ref!, head);
  expect(files).not.toBeNull();
  const bases = files!.map((f) => f.slice(f.lastIndexOf('/') + 1)).sort();
  expect(bases).toEqual(['café.ts', 'plain.ts']);
  // The shape of the bug: quoted, the same file would never match the ledger's or another
  // commit's spelling of it, and would count twice.
  expect(files!.some((f) => f.includes('\\303'))).toBe(false);
});

test('an unknown hash answers null — git failing is not "the commit had no files"', async () => {
  const ref = await resolveRepo(repo);
  const files = await readCommitFiles(ref!, '0000000000000000000000000000000000000000');
  expect(files).toBeNull();
});

test('reading the repository never writes to it', async () => {
  const ref = await resolveRepo(repo);
  const before = spawnSync('shasum', [join(repo, '.git/index')], { encoding: 'utf8' }).stdout;
  await readCommitFiles(ref!, head);
  const after = spawnSync('shasum', [join(repo, '.git/index')], { encoding: 'utf8' }).stdout;
  expect(after).toBe(before);
});

/**
 * A directory that cannot be entered is not a directory without commits, and only one of the two is
 * the user's to act on. Measured rather than imagined: `access` answers EACCES for a mode-000
 * directory and ENOENT for one that is not there, and `Bun.spawn` with that cwd throws EACCES —
 * which is exactly how `git()` fails today, silently, into `null`.
 *
 * macOS answers its privacy gates with EPERM instead, which cannot be provoked from a test process;
 * it is accepted alongside EACCES for that reason, and this covers the half that can be provoked.
 */
test('a folder seedeep cannot enter is reported as refused, never as "no commits"', async () => {
  const locked = mkdtempSync(join(tmpdir(), 'seedeep-locked-'));
  const inner = join(locked, 'project');
  mkdirSync(inner);
  chmodSync(inner, 0o000);
  try {
    expect(await whyNoRepo(inner)).toBe('denied');
    // A path that simply is not there must NOT be reported as refused: telling somebody to grant a
    // permission is advice for a problem they do not have.
    expect(await whyNoRepo(join(locked, 'never-existed'))).toBe('none');
    // And a directory that is readable and simply is not a repository.
    expect(await whyNoRepo(locked)).toBe('none');
  } finally {
    chmodSync(inner, 0o755);
    rmSync(locked, { recursive: true, force: true });
  }
});
