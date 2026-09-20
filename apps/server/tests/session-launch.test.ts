import assert from 'node:assert/strict';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cwdOf, forgetDrivenSession, isDrivenSession, RETRY_UNKNOWN_MS } from '../src/server/session-launch.ts';

// Real processes, never a stub: the whole claim is that the operating system answers this, and a
// stubbed `ps` would only test that the stub agrees with the code that calls it. The mechanism
// exists on macOS and Linux; elsewhere the module answers null by design, and so do these.
const HAS_MECHANISM = process.platform === 'darwin' || process.platform === 'linux';

/** A live child to interrogate, plus the teardown that must run even when an assertion throws. */
function child(cwd: string): { pid: number; stop: () => void } {
  const proc = Bun.spawn(['sleep', '30'], { cwd, stdout: 'ignore', stderr: 'ignore' });
  return { pid: proc.pid, stop: () => proc.kill() };
}

test('cwdOf reads a running process directory', { skip: !HAS_MECHANISM }, async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'seedeep-launch-')));
  const c = child(dir);
  try {
    const seen = await cwdOf(c.pid);
    assert.equal(seen === null ? null : await realpath(seen), dir);
  } finally {
    c.stop();
  }
});

test('cwdOf answers null for a pid nothing is running under', { skip: !HAS_MECHANISM }, async () => {
  // 2^22 is above every default pid_max, so nothing can be listening there. Null, not a throw:
  // a session whose process just exited must not take the discovery tick down with it.
  assert.equal(await cwdOf(4_194_304), null);
});

test('a session launched where its parent works is NOT driven', { skip: !HAS_MECHANISM }, async () => {
  // The shape of a person: they type `claude` in the directory their shell is already in, so the
  // launch directory and the parent's working directory are the same one. Here the test process
  // plays the shell, and the child plays the session.
  const c = child(process.cwd());
  try {
    forgetDrivenSession('human');
    assert.equal(await isDrivenSession('human', c.pid, process.cwd()), false);
  } finally {
    c.stop();
  }
});

test('a session launched somewhere else IS driven', { skip: !HAS_MECHANISM }, async () => {
  // The shape of a driver: the probe puts its session in a tmpdir while the process running it
  // sits in the repo. Nothing about the child differs — same binary, same parent — only where it
  // was told to work.
  const elsewhere = await realpath(await mkdtemp(join(tmpdir(), 'seedeep-launch-')));
  const c = child(elsewhere);
  try {
    forgetDrivenSession('driver');
    assert.equal(await isDrivenSession('driver', c.pid, elsewhere), true);
  } finally {
    c.stop();
  }
});

test('an unresolvable pair answers null, which callers must read as a person', async () => {
  // Three ways the comparison cannot be made, and none of them is a verdict: no launch directory
  // in the transcript, a process that is gone, a launch directory that no longer exists.
  forgetDrivenSession('n1');
  assert.equal(await isDrivenSession('n1', process.pid, null), null, 'no launch dir');
  forgetDrivenSession('n2');
  assert.equal(await isDrivenSession('n2', 4_194_304, process.cwd()), null, 'no such process');
  forgetDrivenSession('n3');
  assert.equal(await isDrivenSession('n3', process.pid, join(tmpdir(), 'seedeep-gone-for-good')), null, 'deleted dir');
});

test('the answer is cached per session, so the discovery tick pays once', { skip: !HAS_MECHANISM }, async () => {
  const c = child(process.cwd());
  try {
    forgetDrivenSession('cached');
    assert.equal(await isDrivenSession('cached', c.pid, process.cwd()), false);
    c.stop();
    // The process is gone, so a fresh comparison could only answer null. Still false: the pair it
    // compares cannot change while a session runs, and re-reading it every 300ms would cost an
    // `lsof` per tick for an answer that is already known.
    assert.equal(await isDrivenSession('cached', c.pid, process.cwd()), false);
  } finally {
    c.stop();
  }
});

test('an unknown answer is not remembered as if it were one', { skip: !HAS_MECHANISM }, async () => {
  // The bug a live run found: seedeep meets a session the instant its file appears, and the first
  // transcript line carrying a cwd may not be written yet. That answers null — not yet knowable —
  // and caching it froze the session as "unknown" for the life of the server, so the driven run it
  // was supposed to silence went on announcing.
  const elsewhere = await realpath(await mkdtemp(join(tmpdir(), 'seedeep-launch-')));
  const c = child(elsewhere);
  try {
    forgetDrivenSession('young');
    assert.equal(await isDrivenSession('young', c.pid, null), null, 'nothing to compare yet');
    // The retry window has to pass before the second question is asked at all; a null is allowed
    // to be cheap, it is just not allowed to be final.
    await new Promise((r) => setTimeout(r, RETRY_UNKNOWN_MS + 50));
    assert.equal(await isDrivenSession('young', c.pid, elsewhere), true, 'the answer arrived');
  } finally {
    c.stop();
  }
});
