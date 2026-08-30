import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionRecord } from '../src/core/types.ts';
import { isReachable, resolveRepo } from '../src/server/git.ts';
import { commitsForSession } from '../src/server/session-commits.ts';

/**
 * Against a REAL repository, because what is under test is git's own notion of reachability and
 * not our idea of it: `git log --all` walks refs, so a commit whose branch was deleted after a
 * squash merge stops being listed while the object stays readable. A fixture would encode the
 * belief that produced the bug — the card said "Nothing committed in this session" on a session
 * that had committed three times and shipped them.
 */

/** A repo with one commit on `main` and two on a feature branch, as a session would leave it. */
function repoWithBranch(): {
  dir: string;
  git: (...a: string[]) => string;
  hashes: string[];
  authoredAt: number[];
} {
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-squash-'));
  const git = (...args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' }).stdout.trim();
  git('init', '-q', '-b', 'main', '.');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  writeFileSync(join(dir, 'a.ts'), 'one\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  git('checkout', '-q', '-b', 'feature');
  const hashes: string[] = [];
  const authoredAt: number[] = [];
  const files: ReadonlyArray<readonly [string, string]> = [
    ['b.ts', 'add the second file'],
    ['c.ts', 'add the third file'],
  ];
  for (const [file, subject] of files) {
    writeFileSync(join(dir, file), 'x\n');
    git('add', '-A');
    git('commit', '-qm', subject);
    hashes.push(git('rev-parse', '--short', 'HEAD'));
    authoredAt.push(Number(git('log', '-1', '--format=%ct')) * 1000);
  }
  return { dir, git, hashes, authoredAt };
}

/**
 * A transcript that RAN those commits: one Bash tool_use per commit, and git's own reply.
 *
 * The call times come from the commits themselves, because attribution is a statement about
 * ORDER: a call proves a commit only when it was authored after the session's previous commit
 * call, which is what stops `git commit && git log -5` from claiming four older commits. A
 * fixture with invented times is claimed by nobody and the card photographs empty.
 */
function transcript(
  dir: string,
  sessionId: string,
  hashes: readonly string[],
  subjects: readonly string[],
  authoredAt: readonly number[],
): string {
  const lines: string[] = [];
  hashes.forEach((h, i) => {
    const id = `toolu_${i}`;
    // The call is the thing that made the commit, so it lands a moment after it.
    const t = authoredAt[i]! + 1_000;
    lines.push(
      JSON.stringify({
        type: 'assistant',
        sessionId,
        cwd: dir,
        timestamp: new Date(t).toISOString(),
        message: {
          role: 'assistant',
          id: `msg_${i}`,
          model: 'claude-opus-4-8',
          content: [{ type: 'tool_use', id, name: 'Bash', input: { command: `git commit -qm '${subjects[i]}'` } }],
        },
      }),
    );
    lines.push(
      JSON.stringify({
        type: 'user',
        sessionId,
        cwd: dir,
        timestamp: new Date(t + 500).toISOString(),
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: id, content: `[feature ${h}] ${subjects[i]}\n 1 file changed` },
          ],
        },
      }),
    );
  });
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(path, `${lines.join('\n')}\n`);
  return path;
}

const record = (path: string, sessionId: string): SessionRecord =>
  ({ sessionId, path, project: 'p', lastActivity: Date.now() }) as SessionRecord;

test('a squash merge does not erase the session that made the commits', async () => {
  const { dir, git, hashes, authoredAt } = repoWithBranch();
  const subjects = ['add the second file', 'add the third file'];
  const path = transcript(dir, 'aaaaaaaa-0000-0000-0000-000000000001', hashes, subjects, authoredAt);

  // While the branch is still there, this already worked — the assertion is here so a failure
  // below can be read as "the squash broke it" rather than "the fixture never worked".
  const before = await commitsForSession(record(path, 'aaaaaaaa-0000-0000-0000-000000000001'), []);
  expect(before.commits.map((c) => c.short).sort()).toEqual([...hashes].sort());
  expect(before.commits.every((c) => c.reachable)).toBe(true);

  // The squash, exactly as `gh pr merge --squash --delete-branch` leaves the repository: one new
  // commit on main carrying the same tree, and the branch gone.
  git('checkout', '-q', 'main');
  git('merge', '-q', '--squash', 'feature');
  git('commit', '-qm', 'the two files (#1)');
  git('branch', '-qD', 'feature');

  const repo = await resolveRepo(dir);
  expect(repo).not.toBeNull();
  for (const h of hashes) expect(await isReachable(repo!, h)).toBe(false);
  expect(await isReachable(repo!, git('rev-parse', 'HEAD'))).toBe(true);

  const after = await commitsForSession(record(path, 'aaaaaaaa-0000-0000-0000-000000000001'), []);
  expect(after.commits.map((c) => c.short).sort()).toEqual([...hashes].sort());
  expect(after.commits.every((c) => c.reachable)).toBe(false);
  // No ref leads to them, so the forge has no page: a link would 404.
  expect(after.commits.every((c) => c.url === null)).toBe(true);
  expect(after.commits.every((c) => c.evidence === 'proof')).toBe(true);
  expect(after.commits.map((c) => c.subject).sort()).toEqual([...subjects].sort());

  rmSync(dir, { recursive: true, force: true });
});

test('a detached HEAD is not a superseded commit', async () => {
  // `for-each-ref` walks refs/ alone while `git log --all` also honours HEAD, so asking only the
  // first would call a checked-out commit superseded — on a bisect, or any detached checkout.
  const { dir, git, hashes } = repoWithBranch();
  git('checkout', '-q', '--detach', 'HEAD');
  git('branch', '-qD', 'feature');
  const repo = await resolveRepo(dir);
  expect(await isReachable(repo!, hashes[1]!)).toBe(true);
  rmSync(dir, { recursive: true, force: true });
});
