/**
 * Run one request under a deadline: on expiry it is ABORTED and the promise rejects, so the
 * caller takes its existing failure path instead of waiting forever.
 *
 * It exists because `fetch` has no timeout of its own and a request sent down a half-open
 * connection settles NEVER — the browser has nothing to retransmit, so it waits for an answer
 * that cannot come. Anything whose next step is chained to that settling (a poll that re-arms
 * itself, a memoised promise every later caller awaits) is then dead for the life of the page.
 *
 * Aborting matters as much as rejecting: during an outage a caller that retries would otherwise
 * pile up sockets nobody will ever answer.
 *
 * The deadline covers exactly what `read`'s promise covers, which is a trap worth stating: `fetch`
 * resolves on the response HEADERS, so `withDeadline(s => fetch(u, {signal})).then(r => r.json())`
 * leaves the BODY unguarded — by then this has already cleared its timer and the signal will never
 * fire again. Read the body INSIDE `read`.
 */
export function withDeadline<T>(read: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const ctrl = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      ctrl.abort();
      reject(new Error('seedeep: the request timed out'));
    }, ms);
    // `read` is a caller's function and may throw BEFORE returning a promise. Uncaught, that
    // escapes the executor and rejects this promise while leaving the timer armed and
    // unreachable — it would still fire, minutes later, into something already settled.
    let p: Promise<T>;
    try {
      p = read(ctrl.signal);
    } catch (e) {
      clearTimeout(t);
      reject(e);
      return;
    }
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
