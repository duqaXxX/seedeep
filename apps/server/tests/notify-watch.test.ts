import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DigestEntry } from '../src/server/digest.ts';
import { createNotifyWatch } from '../src/server/notify-watch.ts';

/**
 * A digest entry with only the fields the detector reads. Field names are taken from
 * `DigestEntry` — a fixture whose names were guessed would test nothing.
 */
function entry(o: {
  id?: string;
  status: DigestEntry['status'];
  waitingFor?: string | null;
  pendingTool?: { name: string; arg: string | null } | null;
  error?: { agentId: string | null; message: string } | null;
  turnState?: string;
  nowText?: string;
}): DigestEntry {
  return {
    sessionId: o.id as string,
    project: 'atlas',
    subject: 'add a retry to the uploader',
    status: o.status,
    waitingFor: o.waitingFor ?? null,
    pendingTool: o.pendingTool ?? null,
    error: o.error ?? null,
    turn: { state: o.turnState ?? 'done', now: { text: o.nowText ?? '' } },
  } as unknown as DigestEntry;
}

test('the first reading seeds and announces nothing', () => {
  const w = createNotifyWatch();
  assert.deepEqual(w.step([entry({ id: 'a', status: 'waiting', waitingFor: 'permission prompt' })]), []);
});

test('a failed reading re-seeds, so a reconnect does not replay', () => {
  const w = createNotifyWatch();
  w.step([entry({ id: 'a', status: 'busy' })]);
  w.step(null);
  assert.deepEqual(w.step([entry({ id: 'a', status: 'idle' })]), []);
});

test('two sessions changing in one interval both announce', () => {
  // Sessions are remembered by id, never counted: a count would stay at one while one was answered
  // and another stopped, which is exactly the moment worth an interruption.
  const w = createNotifyWatch();
  // Both start at work: only a session that WAS working can have finished, so a seed of `waiting`
  // would be testing a transition that does not exist.
  w.step([entry({ id: 'a', status: 'busy' }), entry({ id: 'b', status: 'busy' })]);
  const out = w.step([
    entry({ id: 'a', status: 'idle' }),
    entry({ id: 'b', status: 'waiting', waitingFor: 'permission prompt' }),
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((a) => a.kind).sort(), ['finishes', 'needsYou']);
});

test('busy to waiting is a wait, never also a finish', () => {
  const w = createNotifyWatch();
  w.step([entry({ id: 'a', status: 'busy' })]);
  const out = w.step([entry({ id: 'a', status: 'waiting', waitingFor: 'permission prompt' })]);
  assert.equal(out.length, 1, 'one moment must not raise two banners');
  assert.equal(out[0]!.kind, 'needsYou');
});

test('shell is still working, so no finish until the command dies', () => {
  const w = createNotifyWatch();
  w.step([entry({ id: 'a', status: 'busy' })]);
  assert.deepEqual(w.step([entry({ id: 'a', status: 'shell' })]), [], 'a background command is still going');
  assert.equal(w.step([entry({ id: 'a', status: 'idle' })])[0]!.kind, 'finishes');
});

test('an interrupted turn is never announced', () => {
  const w = createNotifyWatch();
  w.step([entry({ id: 'a', status: 'busy' })]);
  assert.deepEqual(w.step([entry({ id: 'a', status: 'idle', turnState: 'interrupted' })]), []);
});

test('a waiting status seedeep does not recognise is not a wait', () => {
  // Claude Code writes `waiting` for EVERY open dialog, the model picker included. An icon that
  // cries wolf gets ignored on the day it is right.
  const w = createNotifyWatch();
  w.step([entry({ id: 'a', status: 'busy' })]);
  assert.deepEqual(w.step([entry({ id: 'a', status: 'waiting', waitingFor: 'model picker' })]), []);
});

test('a persistent failure announces once, and again only after it clears', () => {
  const w = createNotifyWatch();
  const failing = () =>
    entry({ id: 'a', status: 'idle', error: { agentId: null, message: 'API Error: 529 Overloaded' } });
  w.step([entry({ id: 'a', status: 'busy' })]);
  assert.equal(w.step([failing()]).length, 1);
  assert.deepEqual(w.step([failing()]), [], 'the set is what makes this a transition');
  w.step([entry({ id: 'a', status: 'idle' })]);
  assert.equal(w.step([failing()]).length, 1, 'a recovered session can fail again');
});

test('a failure is read before a wait: one moment, the more serious banner', () => {
  const w = createNotifyWatch();
  w.step([entry({ id: 'a', status: 'busy' })]);
  const out = w.step([
    entry({ id: 'a', status: 'waiting', waitingFor: 'permission prompt', error: { agentId: null, message: 'boom' } }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.kind, 'fails');
});

test('an entry with no session id is skipped, not announced', () => {
  // It cannot be remembered, so it would be new again on every single tick.
  const w = createNotifyWatch();
  w.step([]);
  assert.deepEqual(w.step([entry({ id: undefined, status: 'idle' })]), []);
});

test('the words match the panel, because two wordings teach the user to trust neither', () => {
  const w = createNotifyWatch();
  w.step([entry({ id: 'a', status: 'busy' })]);
  const [wait] = w.step([
    entry({
      id: 'a',
      status: 'waiting',
      waitingFor: 'permission prompt',
      pendingTool: { name: 'Bash', arg: 'rm -rf build' },
    }),
  ]);
  assert.equal(wait!.title, 'atlas — add a retry to the uploader');
  assert.equal(wait!.body, 'Waiting for your approval — Bash\nrm -rf build');

  const w2 = createNotifyWatch();
  w2.step([entry({ id: 'b', status: 'busy' })]);
  const [named] = w2.step([entry({ id: 'b', status: 'waiting', waitingFor: 'input needed' })]);
  assert.equal(named!.body, 'Waiting for your answer in the terminal');

  const w3 = createNotifyWatch();
  w3.step([entry({ id: 'c', status: 'busy' })]);
  const [failed] = w3.step([
    entry({ id: 'c', status: 'idle', error: { agentId: 'sub-1', message: 'API Error: 529 Overloaded' } }),
  ]);
  assert.equal(failed!.body, "A subagent's API call failed\nAPI Error: 529 Overloaded");
});

test('a finished turn says Turn finished, with the agent last words when there are any', () => {
  // `Finished` said the session had ended; it had not. The turn closed and the session became the
  // user's again, which is the event — and in the one case where this line is ALL the notification
  // carries, the word is the whole message.
  const w = createNotifyWatch();
  w.step([entry({ id: 'a', status: 'busy' })]);
  const [a] = w.step([entry({ id: 'a', status: 'idle', nowText: 'Added the retry and ran the tests.' })]);
  assert.equal(a!.body, 'Turn finished\nAdded the retry and ran the tests.');
});

test('a finished turn with nothing on record still says Turn finished', () => {
  const w = createNotifyWatch();
  w.step([entry({ id: 'a', status: 'busy' })]);
  assert.equal(w.step([entry({ id: 'a', status: 'idle', nowText: '' })])[0]!.body, 'Turn finished');
});
