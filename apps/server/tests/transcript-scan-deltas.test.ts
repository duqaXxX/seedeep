import { expect, test } from 'bun:test';
import { scanLines } from '../src/server/transcript-scan.ts';

// Raw lines, in the shape Claude Code writes them — the point of this test is that a hand-built
// object would carry the shape I BELIEVE, and the belief is exactly what was wrong: `trackingPath`
// is relative on 65.5% of real deltas, and only `realParentDir` or the session's cwd resolves it.
const userLine = (cwd: string, ts: string) =>
  JSON.stringify({ type: 'user', cwd, timestamp: ts, message: { content: 'go' } });

const delta = (trackingPath: string, realParentDir: string | null, ts: string) =>
  JSON.stringify({
    type: 'file-history-delta',
    messageId: 'm1',
    trackingPath,
    backup: { backupFileName: null, version: 1, backupTime: ts, ...(realParentDir ? { realParentDir } : {}) },
    timestamp: ts,
  });

test('scanLines resolves every delta shape to an absolute path', () => {
  const scan = scanLines([
    userLine('/home/dev/proj', '2026-08-03T10:00:00.000Z'),
    delta('workspace/src/a.ts', '/home/dev/proj/workspace/src', '2026-08-03T10:00:01.000Z'),
    delta('workspace/src/b.ts', null, '2026-08-03T10:00:02.000Z'),
    delta('/other/place/c.ts', null, '2026-08-03T10:00:03.000Z'),
  ]);
  expect(scan.deltas.map((d) => d.path)).toEqual([
    '/home/dev/proj/workspace/src/a.ts',
    '/home/dev/proj/workspace/src/b.ts',
    '/other/place/c.ts',
  ]);
  expect(scan.deltas[0]!.at).toBe(Date.parse('2026-08-03T10:00:01.000Z'));
});

test('a delta line is not mistaken for a tool call, and carries no cwd of its own', () => {
  const scan = scanLines([delta('a.ts', null, '2026-08-03T10:00:01.000Z')]);
  expect(scan.commits).toEqual([]);
  expect(scan.cwds).toEqual([]);
  // Unresolvable: no cwd seen yet and no realParentDir. Left exactly as CC wrote it, never guessed.
  expect(scan.deltas[0]!.path).toBe('a.ts');
});
