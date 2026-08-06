import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { listOpenSessions } from '../src/server/open-sessions.ts';

function sessionsHome(files: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), 'seedeep-open-'));
  const dir = join(home, '.claude', 'sessions');
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return home;
}

test('listOpenSessions returns alive sessions, skips dead and malformed', async () => {
  const home = sessionsHome({
    '100.json': { pid: 100, sessionId: 'sid-open', cwd: '/home/dev/p', status: 'busy' },
    '200.json': { pid: 200, sessionId: 'sid-dead', cwd: '/home/dev/p', status: 'idle' },
    '300.json': '{ not json',
  });
  const alive = new Set([100]);
  const open = (await listOpenSessions({ home, isAlive: (pid) => alive.has(pid) })) ?? [];
  assert.equal(open.length, 1);
  assert.equal(open[0]?.sessionId, 'sid-open');
  assert.equal(open[0]?.status, 'busy');
});

test('listOpenSessions carries the waiting status and what it waits for', async () => {
  const home = sessionsHome({
    '100.json': {
      pid: 100,
      sessionId: 'sid-wait',
      cwd: '/home/dev/p',
      status: 'waiting',
      waitingFor: 'permission prompt',
    },
    // `shell` was in this test from the start as the example of "a status we have no meaning for",
    // and it was dropped to null. It turns out to have a very specific meaning: Claude Code writes
    // it while a command the session launched in the background is still running and the turn is
    // over (measured by sampling the file every 2 s across a 240-second command). Dropped, the
    // session read as Idle on every surface. It is now carried, and `isWorking` is what reads it.
    '101.json': { pid: 101, sessionId: 'sid-shell', cwd: '/home/dev/p', status: 'shell' },
    // A value nobody has seen yet still becomes null — the vocabulary is Claude Code's, and it has
    // already grown once. Guessing at a new one is how `shell` would have been read as "waiting".
    '102.json': { pid: 102, sessionId: 'sid-odd', cwd: '/home/dev/p', status: 'compacting' },
  });
  const open = (await listOpenSessions({ home, isAlive: () => true })) ?? [];
  const wait = open.find((s) => s.sessionId === 'sid-wait');
  assert.equal(wait?.status, 'waiting');
  assert.equal(wait?.waitingFor, 'permission prompt');
  const shell = open.find((s) => s.sessionId === 'sid-shell');
  assert.equal(shell?.status, 'shell');
  assert.equal(shell?.waitingFor, null, 'only a wait names what it waits for');
  assert.equal(open.find((s) => s.sessionId === 'sid-odd')?.status, null);
});

test('listOpenSessions drops waitingFor when the status is not waiting', async () => {
  // A stale waitingFor left next to a busy status would light the badge forever.
  const home = sessionsHome({
    '100.json': { pid: 100, sessionId: 'sid', cwd: '/home/dev/p', status: 'busy', waitingFor: 'permission prompt' },
  });
  const open = (await listOpenSessions({ home, isAlive: () => true })) ?? [];
  assert.equal(open[0]?.status, 'busy');
  assert.equal(open[0]?.waitingFor, null);
});

// null, not []: "the mechanism is gone" and "nothing is open" must stay distinguishable, or
// the mtime fallback can never know it is needed (see the JSDoc).
// The only guard that covers a VALUE, and the one thing that would have caught `shell` on the day
// it appeared: the radar watches field NAMES in transcripts, and this is a value in the PID file.
// It must say it ONCE — this runs on every roster poll, so a line per poll would be a log nobody
// reads, which is the same as no guard at all.
test('an unknown status is reported once, and never twice', async () => {
  const said: string[] = [];
  const warn = console.warn;
  console.warn = (m: unknown) => said.push(String(m));
  try {
    const home = sessionsHome({
      '100.json': { pid: 100, sessionId: 's1', cwd: '/home/dev/p', status: 'hypnotising' },
      '101.json': { pid: 101, sessionId: 's2', cwd: '/home/dev/p', status: 'hypnotising' },
      '102.json': { pid: 102, sessionId: 's3', cwd: '/home/dev/p', status: 'busy' },
    });
    await listOpenSessions({ home, isAlive: () => true });
    await listOpenSessions({ home, isAlive: () => true }); // a second poll, same values
    const mine = said.filter((m) => m.includes('hypnotising'));
    assert.equal(mine.length, 1, 'said once for the value, not once per file and not once per poll');
    assert.match(mine[0]!, /unknown session status/);
    assert.equal(said.filter((m) => m.includes('busy')).length, 0, 'a known value says nothing');
  } finally {
    console.warn = warn;
  }
});

test('listOpenSessions returns null when the sessions dir is absent', async () => {
  const home = mkdtempSync(join(tmpdir(), 'seedeep-noopen-'));
  assert.equal(await listOpenSessions({ home, isAlive: () => true }), null);
});

test('listOpenSessions returns [] when the dir exists but nothing is open', async () => {
  const home = sessionsHome({});
  assert.deepEqual(await listOpenSessions({ home, isAlive: () => true }), []);
});

test('listOpenSessions reads the sessions dir CLAUDE_CONFIG_DIR points at, not ~/.claude', async () => {
  // Regression: the path was hardcoded to `home/.claude/sessions`, so with CLAUDE_CONFIG_DIR set
  // seedeep read TRANSCRIPTS from the configured profile and asked the DEFAULT one which sessions
  // were open. Every session in a configured profile came back closed, `isLive` never reached its
  // mtime fallback, and a transcript being appended to right then rendered as ENDED.
  const home = mkdtempSync(join(tmpdir(), 'seedeep-open-home-'));
  const cfg = mkdtempSync(join(tmpdir(), 'seedeep-open-cfg-'));
  mkdirSync(join(cfg, 'sessions'), { recursive: true });
  writeFileSync(
    join(cfg, 'sessions', '100.json'),
    JSON.stringify({ pid: 100, sessionId: 'sid-in-cfg', cwd: '/home/dev/p', status: 'busy' }),
  );
  // `home/.claude/sessions` deliberately does NOT exist: reading it returns null, which is what the
  // bug did and what this asserts against.
  const prev = process.env['CLAUDE_CONFIG_DIR'];
  process.env['CLAUDE_CONFIG_DIR'] = cfg;
  try {
    const open = await listOpenSessions({ home, isAlive: () => true });
    assert.notEqual(open, null, 'the configured profile has a sessions dir, so this is never null');
    assert.equal(open?.length, 1);
    assert.equal(open?.[0]?.sessionId, 'sid-in-cfg');
  } finally {
    if (prev === undefined) delete process.env['CLAUDE_CONFIG_DIR'];
    else process.env['CLAUDE_CONFIG_DIR'] = prev;
  }
});
