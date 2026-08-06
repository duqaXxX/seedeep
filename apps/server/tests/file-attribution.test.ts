import { expect, test } from 'bun:test';
import { displayFiles, ledgerPath, mergeFiles, scratchFiles } from '../src/core/file-attribution.ts';

// Measured over every local delta (2026-08-03): 1156 of 1765 `trackingPath` values are RELATIVE
// (65.5%), and `backup.realParentDir` carries the real directory on 1192. The scratchpad rows are
// read out of these paths, so resolving them is not cosmetic.
test('an absolute trackingPath is already the answer', () => {
  expect(ledgerPath('/repo/src/a.ts', '/elsewhere', '/cwd')).toBe('/repo/src/a.ts');
});

test('realParentDir resolves a relative trackingPath, and wins over the cwd', () => {
  expect(ledgerPath('workspace/src/a.ts', '/home/dev/proj/workspace/src', '/home/dev/other')).toBe(
    '/home/dev/proj/workspace/src/a.ts',
  );
});

test('without realParentDir the cwd resolves it', () => {
  expect(ledgerPath('workspace/src/a.ts', null, '/home/dev/proj')).toBe('/home/dev/proj/workspace/src/a.ts');
});

test('with neither, the path is left exactly as Claude Code wrote it — never guessed', () => {
  expect(ledgerPath('workspace/src/a.ts', null, null)).toBe('workspace/src/a.ts');
});

test('a Windows path counts as absolute', () => {
  expect(ledgerPath('C:\\proj\\a.ts', null, '/cwd')).toBe('C:\\proj\\a.ts');
});

// The count must be reproducible from a terminal, so it is `git show --stat` and nothing else.
// The working tree was tried as a second source and removed: `git status` describes the repo, not
// a session, so two live sessions in one repo would each claim the whole dirty tree.
test('a path delivered by several commits counts once, keeping the latest', () => {
  const out = mergeFiles([
    { path: '/repo/a.ts', at: 100, commit: 'aaa1111' },
    { path: '/repo/a.ts', at: 300, commit: 'bbb2222' },
    { path: '/repo/b.ts', at: 200, commit: 'bbb2222' },
  ]);
  expect(out).toEqual([
    { path: '/repo/a.ts', at: 300, commit: 'bbb2222' },
    { path: '/repo/b.ts', at: 200, commit: 'bbb2222' },
  ]);
});

// Scratchpad is the ledger's ONE exclusive: it lives outside the repo, where no git command sees
// it. Everything else the ledger holds is dropped — including CC's own memory notes, which are not
// work on the project and used to be counted as such.
test('scratchpad rows come from the ledger, and nothing else does', () => {
  const out = scratchFiles([
    { path: '~scratch/x/probe.ts', at: 10 },
    { path: '~scratch/x/probe.ts', at: 40 },
    { path: '/repo/src/a.ts', at: 20 },
    { path: '~/.claude/projects/<slug>/memory/note.md', at: 30 },
  ]);
  expect(out).toEqual([{ path: '~scratch/x/probe.ts', at: 40, commit: null }]);
});

// A session that moves between two repos: showing one set of rows relative and the other as full
// absolute paths would make the list unreadable, so every root shortens its own.
test('each row is shortened against its OWN repo root, longest match first', () => {
  const rows = displayFiles(
    [
      { path: '~/one/src/a.ts', at: 1, commit: 'aaa1111' },
      { path: '~/two/lib/b.ts', at: 2, commit: 'bbb2222' },
      { path: '~/one/nested/pkg/c.ts', at: 3, commit: 'ccc3333' },
      { path: '~/elsewhere/d.ts', at: 4, commit: 'ddd4444' },
    ],
    ['~/one', '~/two', '~/one/nested'],
  );
  expect(rows.map((r) => [r.base, r.dir])).toEqual([
    ['a.ts', 'src/'],
    ['b.ts', 'lib/'],
    ['c.ts', 'pkg/'],
    ['d.ts', '~/elsewhere/'],
  ]);
});

test('a scratchpad row is marked as such, so no surface can count it as project work', () => {
  const rows = displayFiles([{ path: '~scratch/x/probe.ts', at: 2, commit: null }], ['~/proj'], true);
  expect([rows[0]!.scratch, rows[0]!.dir]).toEqual([true, '~scratch/x/']);
});
