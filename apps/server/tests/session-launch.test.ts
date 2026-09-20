import assert from 'node:assert/strict';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  cwdOf,
  drivenComparisonsStarted,
  forgetDrivenSession,
  isDrivenSession,
  RETRY_UNKNOWN_MS,
} from '../src/server/session-launch.ts';

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

test('a session whose process works where its parent works is NOT driven', { skip: !HAS_MECHANISM }, async () => {
  // The shape of a person: they type `claude` in the directory their shell is already in, so the
  // session's process and its parent work in the same one. Here the test process plays the shell,
  // and the child plays the session.
  const c = child(process.cwd());
  try {
    forgetDrivenSession('human');
    assert.equal(await isDrivenSession('human', c.pid), false);
  } finally {
    c.stop();
  }
});

test('a session whose process works somewhere else IS driven', { skip: !HAS_MECHANISM }, async () => {
  // The shape of a driver: the probe puts its session in a tmpdir while the process running it
  // sits in the repo. Nothing about the child differs — same binary, same parent — only where it
  // was told to work.
  const elsewhere = await realpath(await mkdtemp(join(tmpdir(), 'seedeep-launch-')));
  const c = child(elsewhere);
  try {
    forgetDrivenSession('driver');
    assert.equal(await isDrivenSession('driver', c.pid), true);
  } finally {
    c.stop();
  }
});

test('both sides are read from the processes, so a resumed session is not mistaken for a driver', {
  skip: !HAS_MECHANISM,
}, async () => {
  // `claude --resume` appends to the transcript of a session first opened elsewhere, so the
  // transcript's first line names a directory this run was never launched in. Comparing THAT
  // against the new shell's directory read as driven and silenced a person. Reading the running
  // process instead answers about this run: same directory as its parent, so not driven — even
  // though a directory it once ran in is somewhere up the tree.
  const original = await realpath(await mkdtemp(join(tmpdir(), 'seedeep-launch-')));
  const c = child(process.cwd());
  try {
    forgetDrivenSession('resumed');
    assert.notEqual(original, process.cwd(), 'the old directory really is a different one');
    assert.equal(await isDrivenSession('resumed', c.pid), false);
  } finally {
    c.stop();
  }
});

test('an unresolvable pair answers null, which callers must read as a person', async () => {
  // Two ways the comparison cannot be made, and neither is a verdict: a process that is gone, and
  // a platform with no mechanism at all (where every pid answers the same way).
  forgetDrivenSession('n1');
  assert.equal(await isDrivenSession('n1', 4_194_304), null, 'no such process');
  forgetDrivenSession('n2');
  const answer = await isDrivenSession('n2', 1);
  assert.equal(answer, null, 'pid 1 has no parent worth reading');
});

test('the answer is cached per session, so the discovery tick pays once', { skip: !HAS_MECHANISM }, async () => {
  const c = child(process.cwd());
  try {
    forgetDrivenSession('cached');
    assert.equal(await isDrivenSession('cached', c.pid), false);
    c.stop();
    // The process is gone, so a fresh comparison could only answer null. Still false: the pair it
    // compares cannot change while a session runs, and re-reading it on every tick (300ms by default) would cost two
    // subprocesses for an answer that is already known.
    assert.equal(await isDrivenSession('cached', c.pid), false);
  } finally {
    c.stop();
  }
});

test('an unknown answer is not remembered as if it were one', { skip: !HAS_MECHANISM }, async () => {
  // The bug a live run found: seedeep meets a session the instant its file appears, when its
  // process may not be readable yet. Caching that froze the session as "unknown" for the life of
  // the server, so the driven run it was supposed to silence went on announcing.
  const gone = child(process.cwd());
  gone.stop();
  await new Promise((r) => setTimeout(r, 200));
  forgetDrivenSession('young');
  assert.equal(await isDrivenSession('young', gone.pid), null, 'nothing to compare yet');
  const live = child(process.cwd());
  try {
    // The retry window has to pass before the second question is asked at all; a null is allowed
    // to be cheap, it is just not allowed to be final.
    await new Promise((r) => setTimeout(r, RETRY_UNKNOWN_MS + 50));
    assert.equal(await isDrivenSession('young', live.pid), false, 'the answer arrived');
  } finally {
    live.stop();
  }
});

test('two callers asking at once start one comparison, not two', { skip: !HAS_MECHANISM }, async () => {
  // The roster poll and the notification sweep both run discovery, and they overlap. Without the
  // in-flight map they each start `ps` and `lsof` for the same session.
  const c = child(process.cwd());
  try {
    forgetDrivenSession('shared');
    const before = drivenComparisonsStarted();
    const both = await Promise.all([isDrivenSession('shared', c.pid), isDrivenSession('shared', c.pid)]);
    assert.deepEqual(both, [false, false]);
    assert.equal(drivenComparisonsStarted() - before, 1, 'the second caller joined the first run');
  } finally {
    c.stop();
  }
});
