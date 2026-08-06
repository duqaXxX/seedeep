import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEndGuard } from '../src/client/end-guard.ts';

// Manual scheduler: the test decides when the confirmation window elapses.
function manual() {
  const queued: Array<{ fn: () => void; cancelled: boolean }> = [];
  return {
    schedule: (fn: () => void) => {
      const entry = { fn, cancelled: false };
      queued.push(entry);
      return {
        cancel() {
          entry.cancelled = true;
        },
      };
    },
    elapse: () => {
      for (const e of queued.splice(0)) if (!e.cancelled) e.fn();
    },
    pending: () => queued.filter((e) => !e.cancelled).length,
  };
}

function guard(stillGone: (id: string) => boolean, reading?: () => number) {
  const sched = manual();
  const ended: string[] = [];
  let n = 0; // by default every call is a fresh reading, which is the healthy case
  const g = createEndGuard({
    delayMs: 1,
    schedule: sched.schedule as any,
    reading: reading ?? (() => ++n),
    stillGone,
    end: (id) => ended.push(id),
  });
  return { g, sched, ended };
}

// Latent: `isOpen` is read from a PID file that Claude Code REWRITES on every
// status change, and a read caught mid-rewrite yields no entry for that session — so a
// running session can look gone for exactly one poll. The tab acted on that single reading,
// set `ended` (one-way, by design), dropped its live subscription and never took it back:
// a healthy session frozen into history until the page was reloaded.
test('a session gone for one reading only is never ended', () => {
  const { g, sched, ended } = guard(() => false); // by confirmation time it is back
  g.gone('A');
  assert.deepEqual(ended, [], 'nothing is committed before the window elapses');
  sched.elapse();
  assert.deepEqual(ended, []);
});

test('a session still gone at confirmation is ended', () => {
  const { g, sched, ended } = guard(() => true);
  g.gone('A');
  sched.elapse();
  assert.deepEqual(ended, ['A']);
});

test('coming back cancels a pending confirmation', () => {
  const { g, sched, ended } = guard(() => true); // would end if the timer ever fired
  g.gone('A');
  g.cancel('A');
  sched.elapse();
  assert.deepEqual(ended, [], 'the session returned before the window closed');
});

test('repeated sightings do not stack confirmations', () => {
  const { g, sched, ended } = guard(() => true);
  g.gone('A');
  g.gone('A');
  g.gone('A');
  assert.equal(sched.pending(), 1, 'one window per session, not one per poll');
  sched.elapse();
  assert.deepEqual(ended, ['A'], 'and it commits exactly once');
});

test('each session is confirmed on its own', () => {
  const { g, sched, ended } = guard((id) => id === 'B');
  g.gone('A');
  g.gone('B');
  sched.elapse();
  assert.deepEqual(ended, ['B']);
});

test('a stale reading cannot confirm itself — the window re-arms until a fresh one lands', () => {
  // The confirmation reads `roster.current()`, and `roster.refresh()` returns early leaving
  // `rows` untouched when its fetch fails. So one blink of the PID file plus one failed poll
  // and the guard re-reads the SAME snapshot that opened the window: a healthy session ended
  // one-way on a single reading, which is exactly what the guard exists to prevent.
  // Bailing out is not enough either — `gone` fires from a roster identity CHANGE, so a window
  // dropped unconfirmed is never re-opened and a session that really ended would stay live for
  // the life of the page. It has to wait, not give up.
  let readings = 0;
  const { g, sched, ended } = guard(
    () => true,
    () => readings,
  );
  g.gone('A');
  sched.elapse();
  assert.deepEqual(ended, [], 'the reading that opened the window is not a second opinion');
  assert.equal(sched.pending(), 1, 'and the window stays armed rather than dropping the question');
  readings++; // a poll finally succeeds
  sched.elapse();
  assert.deepEqual(ended, ['A']);
});

test('after ending, a later sighting can open a new window', () => {
  // Nothing here knows whether the caller acted; the guard must stay usable for the id.
  const { g, sched, ended } = guard(() => true);
  g.gone('A');
  sched.elapse();
  g.gone('A');
  sched.elapse();
  assert.deepEqual(ended, ['A', 'A']);
});
