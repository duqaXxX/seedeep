import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withDeadline } from '../src/client/deadline.ts';

// The hazard this exists for: `fetch` has no timeout, and a request sent down a half-open
// connection settles NEVER — the browser has nothing to retransmit, so it waits for an answer that
// cannot come. Anything chained to that settling (a poll that re-arms itself, a memoised promise
// every later caller awaits) is then dead for the life of the page.
test('a read that never answers is rejected once the deadline passes', async () => {
  const started = Date.now();
  await assert.rejects(
    withDeadline(() => new Promise<never>(() => {}), 20),
    /timed out/,
  );
  assert.ok(Date.now() - started >= 15, 'and not before it');
});

// Rejecting alone would leave the socket open: a caller that retries on a cadence would pile up
// requests nobody will ever answer, which is a second bug on top of the first.
test('the request is aborted, not merely abandoned', async () => {
  let aborted = false;
  await assert.rejects(
    withDeadline(
      (signal) =>
        new Promise<never>(() => {
          signal.addEventListener('abort', () => {
            aborted = true;
          });
        }),
      20,
    ),
    /timed out/,
  );
  assert.equal(aborted, true);
});

test('a read that answers in time passes its value through untouched', async () => {
  let aborted = false;
  const v = await withDeadline((signal) => {
    signal.addEventListener('abort', () => {
      aborted = true;
    });
    return Promise.resolve('ok');
  }, 10_000);
  assert.equal(v, 'ok');
  assert.equal(aborted, false, 'a settled read must not be aborted afterwards');
});

// `read` is a caller's function and may throw BEFORE returning a promise. Uncaught, that escapes
// the executor: the promise rejects, but the timer stays armed and unreachable — it fires minutes
// later into something already settled, and until then holds the whole closure alive.
test('a read that throws synchronously rejects with that error, and arms nothing', async () => {
  const boom = new Error('threw before returning a promise');
  await assert.rejects(
    withDeadline(() => {
      throw boom;
    }, 10_000),
    (e: Error) => e === boom,
  );
  // The proof that nothing is left armed: node exits this test without a pending 10s timer. A
  // timer that outlived the rejection would keep the loop alive and stall the run.
});
