import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createRoster,
  isAutomated,
  isLive,
  pendingInput,
  requestedSession,
  sessionsToAutoOpen,
} from '../src/client/sessions.ts';
import { liveOf, toCatalogue } from '../src/core/roster.ts';
import type { SessionRecord } from '../src/core/types.ts';

const rec = (id: string, isActive: boolean, over: Partial<SessionRecord> = {}): SessionRecord => ({
  sessionId: id,
  project: 'p',
  model: 'm',
  lastActivity: 1,
  isActive,
  isOpen: isActive,
  status: null,
  waitingFor: null,
  waitingSince: null,
  statusDerived: false,
  subject: null,
  entrypoint: null,
  root: 'cli',
  path: `/x/${id}.jsonl`,
  ...over,
});

// Serve a roster the way the server now does: through the real catalogue/live projection.
// The tests keep saying what the roster IS, and every one of them exercises the split on the
// way in — a merge that stops reproducing the whole breaks them all, which is the point.
const serve = (rowsOf: () => SessionRecord[]) => ({
  fetchCatalogue: async () => rowsOf().map(toCatalogue),
  fetchLive: async () => liveOf(rowsOf()),
});

// Manual scheduler: the test decides when a poll fires.
function manualSchedule() {
  const queued: Array<() => void> = [];
  return {
    schedule: (fn: () => void) => {
      queued.push(fn);
      return { cancel() {} };
    },
    // A poll can now await TWO fetches (live, then the catalogue when it is stale), so let the
    // whole microtask chain drain rather than a single turn.
    tick: async () => {
      const fn = queued.shift();
      if (fn) {
        fn();
        await new Promise((r) => setTimeout(r, 0));
      }
    },
  };
}

test('start fetches once and current() reflects it', async () => {
  const r = createRoster(serve(() => [rec('A', true)]));
  await r.start();
  assert.deepEqual(
    r.current().map((s) => s.sessionId),
    ['A'],
  );
  r.stop();
});

test('onChange fires when a new session appears, not when identical', async () => {
  const sched = manualSchedule();
  let rows = [rec('A', true)];
  const r = createRoster({ ...serve(() => rows), schedule: sched.schedule as any });
  let changes = 0;
  r.onChange(() => {
    changes++;
  });
  await r.start(); // initial → change 1
  await sched.tick(); // same roster → no change
  rows = [rec('A', true), rec('B', true)];
  await sched.tick(); // B appeared → change 2
  assert.equal(changes, 2);
  r.stop();
});

test('onChange fires when isActive flips (active→ended)', async () => {
  const sched = manualSchedule();
  let rows = [rec('A', true)];
  const r = createRoster({ ...serve(() => rows), schedule: sched.schedule as any });
  let last: SessionRecord[] = [];
  r.onChange((rs) => {
    last = rs;
  });
  await r.start();
  rows = [rec('A', false)];
  await sched.tick();
  assert.ok(last[0]);
  assert.equal(last[0].isActive, false);
  r.stop();
});

// Whatever a listener can SEE must be in the identity key, or the change never
// reaches it. The tab bar's busy dot reads `status`; live-vs-replay reads `isOpen`. With
// both outside the key, the dot was frozen at whatever it was when its tab was created.
test('onChange fires when only status changes (idle→busy→idle)', async () => {
  const sched = manualSchedule();
  let status: SessionRecord['status'] = 'idle';
  const r = createRoster({ ...serve(() => [rec('A', true, { status })]), schedule: sched.schedule as any });
  const seen: Array<SessionRecord['status']> = [];
  r.onChange((rs) => seen.push(rs[0]!.status));
  await r.start();
  status = 'busy'; // the session starts generating
  await sched.tick();
  status = 'idle'; // and stops
  await sched.tick();
  assert.deepEqual(seen, ['idle', 'busy', 'idle']);
  r.stop();
});

test('current() serves the new status, not the one from the last identity change', async () => {
  // rows was only reassigned on a key change, so an unchanged key left current() stale —
  // and openFromDropdown builds a tab out of current().
  const sched = manualSchedule();
  let status: SessionRecord['status'] = 'idle';
  const r = createRoster({ ...serve(() => [rec('A', true, { status })]), schedule: sched.schedule as any });
  await r.start();
  status = 'busy';
  await sched.tick();
  assert.equal(r.current()[0]!.status, 'busy');
  r.stop();
});

test('onChange fires when a session closes, without waiting for isActive to lapse', async () => {
  // isOpen (the PID file) drops the moment the session exits; isActive is an mtime window
  // that can stay true for another 60s. Keying on isActive alone delayed `setEnded` that long.
  const sched = manualSchedule();
  let isOpen = true;
  const r = createRoster({ ...serve(() => [rec('A', true, { isOpen })]), schedule: sched.schedule as any });
  const seen: Array<boolean | null> = [];
  r.onChange((rs) => seen.push(rs[0]!.isOpen));
  await r.start();
  isOpen = false; // process gone, mtime still fresh → isActive unchanged
  await sched.tick();
  assert.deepEqual(seen, [true, false]);
  r.stop();
});

test('a poll that changes nothing still does not notify', async () => {
  // The key exists to stop pointless re-renders: the picker redraws on every onChange.
  const sched = manualSchedule();
  const r = createRoster({ ...serve(() => [rec('A', true, { status: 'busy' })]), schedule: sched.schedule as any });
  let changes = 0;
  r.onChange(() => {
    changes++;
  });
  await r.start();
  await sched.tick();
  await sched.tick();
  assert.equal(changes, 1, 'only the initial fetch notified');
  r.stop();
});

test('subject IS identity: onChange fires once when subject goes from null to text, not again', async () => {
  // A session opens before the user types (subject=null → label = uuid fallback). When the
  // first message arrives, the head-scan picks up the subject and the roster fires onChange
  // so the tab label can update — without a page refresh.
  // After that subject is immutable, so onChange must NOT fire again on subsequent polls.
  const sched = manualSchedule();
  let subject: string | null = null;
  const r = createRoster({ ...serve(() => [rec('A', true, { subject })]), schedule: sched.schedule as any });
  const seen: Array<string | null> = [];
  r.onChange((rs) => seen.push(rs[0]!.subject));
  await r.start(); // initial → null
  await sched.tick(); // same → no change
  subject = 'fix the login redirect'; // first user message written
  await sched.tick(); // subject arrived → fires
  await sched.tick(); // unchanged → no change
  assert.deepEqual(seen, [null, 'fix the login redirect']);
  r.stop();
});

test('lastActivity is NOT identity: a live session writing constantly must not re-notify', async () => {
  // mtime moves on every write. In the key it would fire onChange on every 3s poll of any
  // live session, redrawing the picker forever — the reason it stays out.
  const sched = manualSchedule();
  let lastActivity = 1;
  const r = createRoster({ ...serve(() => [rec('A', true, { lastActivity })]), schedule: sched.schedule as any });
  let changes = 0;
  r.onChange(() => {
    changes++;
  });
  await r.start();
  lastActivity = 2;
  await sched.tick();
  lastActivity = 3;
  await sched.tick();
  assert.equal(changes, 1);
  r.stop();
});

// A session that starts while seedeep is running should get a tab by itself — but exactly
// once. `known` is what separates "offer it once" from "keep reopening what I closed".
const none = new Set<string>();

test('a new live human session is offered a tab', () => {
  const rows = [rec('A', true, { entrypoint: 'cli' })];
  assert.deepEqual(
    sessionsToAutoOpen(rows, none, none).map((s) => s.sessionId),
    ['A'],
  );
});

test('a tab the user CLOSED is never reopened', () => {
  // The session is still live and still in the roster; only `known` remembers we offered it.
  const rows = [rec('A', true, { entrypoint: 'cli' })];
  assert.deepEqual(sessionsToAutoOpen(rows, new Set(['A']), none), [], 'closed stays closed');
});

test('a session already on screen is not re-offered (it would steal focus)', () => {
  // openTab() switches to a session it already has, so re-offering an open tab would yank
  // the user onto it — on every poll.
  const rows = [rec('A', true, { entrypoint: 'cli' })];
  assert.deepEqual(sessionsToAutoOpen(rows, none, new Set(['A'])), []);
});

// The tray hands a session over through the URL rather than replicating the portal, so this is the
// seam between the two frontends: what it returns is compared against roster ids and, when one
// matches, put on screen.
test('a deep link names the session the tray clicked', () => {
  assert.equal(requestedSession('?session=abc-123'), 'abc-123');
  // Beside the token, which `initAuth` strips first — the tray's URL carries both.
  assert.equal(requestedSession('?token=t&session=abc-123'), 'abc-123');
  assert.equal(requestedSession('?session=%20abc-123%20'), 'abc-123', 'a padded value is still an id');

  for (const search of ['', '?', '?session=', '?session=%20%20', '?other=1']) {
    assert.equal(requestedSession(search), null, `${search} names no session`);
  }
  // Bounded, because the value reaches the screen. Not checked against a UUID shape: the id format
  // is Claude Code's to change, and a client that only accepted today's would break the day it does.
  assert.equal(requestedSession(`?session=${'x'.repeat(201)}`), null);
  assert.equal(requestedSession(`?session=${'x'.repeat(200)}`), 'x'.repeat(200));
});

test('an automated run is NEVER offered a tab, even while live', () => {
  // Measured 2026-07-17: a headless `claude -p` registers in ~/.claude/sessions for the
  // length of its run, so it IS live. Without this, every git push would pop a tab.
  const rows = [rec('gate', true, { entrypoint: 'sdk-cli' }), rec('py', true, { entrypoint: 'sdk-py' })];
  assert.deepEqual(sessionsToAutoOpen(rows, none, none), []);
});

test('a dead session is not offered, however new it looks', () => {
  const rows = [rec('A', false, { entrypoint: 'cli', isOpen: false })];
  assert.deepEqual(sessionsToAutoOpen(rows, none, none), []);
});

test('isAutomated / isLive: the two predicates the rule is built from', () => {
  assert.equal(isAutomated({ entrypoint: 'sdk-cli' }), true);
  assert.equal(isAutomated({ entrypoint: 'sdk-py' }), true);
  assert.equal(isAutomated({ entrypoint: 'cli' }), false);
  assert.equal(isAutomated({ entrypoint: null }), false, 'unknown entrypoint is not automated');
  assert.equal(isLive({ isOpen: true, isActive: false }), true, 'isOpen wins');
  assert.equal(isLive({ isOpen: undefined as any, isActive: true }), true, 'falls back for an older server');
});

test('a session that blinks out of the PID scan for one poll must NOT be re-offered', () => {
  // `listOpenSessions` yields fewer entries on any transient error (a session file parsed
  // mid-rewrite, a readdir hiccup), so isOpen can read false for one poll and true the next.
  // `known` used to be pruned by liveness, and that blink dropped the entry — handing back
  // the very tab the user had closed. Nothing removes from `known` now; the poll where the
  // session looks dead simply offers nothing, and the next one still finds it known.
  const known = new Set(['A']);
  const blink = [rec('A', false, { entrypoint: 'cli', isOpen: false })]; // A blinked out
  assert.deepEqual(sessionsToAutoOpen(blink, known, none), [], 'nothing offered while it looks dead');
  const back = [rec('A', true, { entrypoint: 'cli' })]; // A is back, tab still closed
  assert.deepEqual(sessionsToAutoOpen(back, known, none), [], 'and still not re-offered when it returns');
});

test('pendingInput: only what actually blocks on the human counts', () => {
  // Measured on a real cli session (2.1.218): a tool approval writes "permission prompt",
  // an AskUserQuestion / MCP elicitation writes "input needed". Everything else is a
  // dialog the user opened themselves — the agent is not waiting on anyone.
  assert.equal(pendingInput({ status: 'waiting', waitingFor: 'permission prompt' }), 'permission');
  assert.equal(pendingInput({ status: 'waiting', waitingFor: 'input needed' }), 'input');
  assert.equal(pendingInput({ status: 'waiting', waitingFor: 'dialog open' }), null);
  assert.equal(pendingInput({ status: 'waiting', waitingFor: 'sandbox request' }), null);
  // An unknown label from a newer Claude Code: unreadable, so not claimed as an approval.
  assert.equal(pendingInput({ status: 'waiting', waitingFor: 'something new' }), null);
  assert.equal(pendingInput({ status: 'waiting', waitingFor: null }), null);
  assert.equal(pendingInput({ status: 'busy', waitingFor: null }), null);
});

test('onChange fires when only waitingFor changes (the status stays "waiting")', async () => {
  // A picker the user opened, then a real approval: `status` alone cannot tell them apart,
  // so a key without waitingFor would never light the badge.
  const sched = manualSchedule();
  let rows = [rec('A', true, { status: 'waiting', waitingFor: 'dialog open' })];
  const r = createRoster({ ...serve(() => rows), schedule: sched.schedule as any });
  let changes = 0;
  r.onChange(() => {
    changes++;
  });
  await r.start();
  rows = [rec('A', true, { status: 'waiting', waitingFor: 'permission prompt' })];
  await sched.tick();
  assert.equal(changes, 2);
  assert.equal(r.current()[0]?.waitingFor, 'permission prompt');
  r.stop();
});

// A catalogue record taken while a session was LIVE is PROVISIONAL: the head scan had not yet
// found the first prompt (`subject: null`), no model had been reported, and the mtime was still
// moving. Nothing about the count changes when that session later ends — the file stays on disk
// — so without a rule keyed on provisionality the client keeps serving the birth snapshot for as
// long as the page is open.
test('a session that ends keeps the subject it earned, not the one the catalogue was born with', async () => {
  const sched = manualSchedule();
  let server = [rec('A', true, { subject: null, model: null })]; // born: no prompt written yet
  const r = createRoster({ ...serve(() => server), schedule: sched.schedule as any });
  await r.start();
  server = [rec('A', true, { subject: 'fix the login redirect', model: 'claude-opus-5' })];
  await sched.tick(); // live payload carries the truth
  assert.equal(r.current()[0]?.subject, 'fix the login redirect');
  server = [rec('A', false, { subject: 'fix the login redirect', model: 'claude-opus-5', isOpen: false })];
  await sched.tick(); // …and it ends
  assert.equal(r.current()[0]?.subject, 'fix the login redirect', 'the picker must not revert to the id');
  assert.equal(r.current()[0]?.model, 'claude-opus-5');
  r.stop();
});

test('a provisional record for a session that is not live is refreshed, not carried forever', async () => {
  // The boot race: the session was born between the live fetch and the catalogue fetch, so it
  // entered the catalogue as provisional and never appeared in a live payload. The count cannot
  // notice — the wrong row must be repaired by the next poll, not survive until a page reload.
  const sched = manualSchedule();
  let calls = 0;
  const bornLive = toCatalogue(rec('B', true)); // caught live → lastActivity null
  const settled = toCatalogue(rec('B', false, { lastActivity: 777 }));
  const r = createRoster({
    fetchCatalogue: async () => [calls++ === 0 ? bornLive : settled],
    fetchLive: async () => ({ total: 1, sessions: [], pidVisible: true }),
    schedule: sched.schedule as any,
  });
  await r.start();
  await sched.tick();
  assert.equal(calls, 2, 'the provisional record must trigger exactly one refetch');
  assert.equal(r.current()[0]?.lastActivity, 777, 'and never stay at the epoch');
  r.stop();
});

test('a failed fetch keeps the last good roster', async () => {
  const sched = manualSchedule();
  let fail = false;
  const r = createRoster({
    fetchCatalogue: async () => [rec('A', true)].map(toCatalogue),
    fetchLive: async () => {
      if (fail) throw new Error('net');
      return liveOf([rec('A', true)]);
    },
    schedule: sched.schedule as any,
  });
  await r.start();
  fail = true;
  await sched.tick();
  assert.deepEqual(
    r.current().map((s) => s.sessionId),
    ['A'],
  );
  r.stop();
});

test('readings() counts what actually landed, not polls attempted', async () => {
  // Serving the last good roster is right, but it makes `current()` ambiguous: a caller cannot
  // tell a fresh answer from a repeat of the one it already saw. end-guard.ts spends a one-way
  // decision on that difference, so the count must move only when the rows really were re-read.
  const sched = manualSchedule();
  let fail = false;
  const r = createRoster({
    fetchCatalogue: async () => [rec('A', true)].map(toCatalogue),
    fetchLive: async () => {
      if (fail) throw new Error('net');
      return liveOf([rec('A', true)]);
    },
    schedule: sched.schedule as any,
  });
  await r.start();
  assert.equal(r.readings(), 1);
  fail = true;
  await sched.tick();
  assert.equal(r.readings(), 1, 'a failed poll is not a reading');
  fail = false;
  await sched.tick();
  assert.equal(r.readings(), 2);
  r.stop();
});

// Latent, found while tracing the freeze: the poll re-arms itself with
// `refresh().then(arm)`. Only the two fetches were guarded — the merge, the key and the
// LISTENERS were not, so one throwing listener rejected the promise, `arm` never ran and the
// roster poll died for the life of the page: no picker updates, no busy dot, no
// ended-detection, no auto-open. Silently, like every other failure in this bug.
test('a throwing listener does not kill the poll', async () => {
  const sched = manualSchedule();
  let rows = [rec('A', true)];
  const r = createRoster({ ...serve(() => rows), schedule: sched.schedule as any });
  r.onChange(() => {
    throw new Error('a listener blew up');
  });
  let seen = 0;
  r.onChange(() => {
    seen++;
  });
  await r.start();
  rows = [rec('A', true), rec('B', true)];
  await sched.tick();
  assert.equal(seen, 2, 'the poll kept running and kept notifying');
  assert.deepEqual(
    r.current().map((s) => s.sessionId),
    ['A', 'B'],
  );
  r.stop();
});

test('a throwing listener does not starve the listeners after it', async () => {
  const r = createRoster(serve(() => [rec('A', true)]));
  let reached = false;
  r.onChange(() => {
    throw new Error('first one throws');
  });
  r.onChange(() => {
    reached = true;
  });
  await r.start();
  assert.equal(reached, true);
  r.stop();
});

// A FAILED reading is handled (above); a reading that never comes back at all was not. The poll
// re-arms off refresh() settling, and a fetch on a half-open connection settles never — the
// browser has nothing to retransmit, so it waits for an answer that cannot arrive. Measured on a
// silently cut network: 12 readings started, 11 settled, and no 13th ever — the poll stayed dead
// through the outage AND for the whole minute after the network came back. Every surface fed by
// the roster (the picker, the busy dot, ended-detection, auto-open) is frozen with it.
test('a reading that never answers does not kill the poll', async () => {
  let started = 0;
  const r = createRoster({
    fetchCatalogue: async () => [],
    fetchLive: () => {
      started++;
      return new Promise<never>(() => {}); // the network took the request and said nothing
    },
    pollMs: 5,
    timeoutMs: 20,
  });
  void r.start(); // never awaited: without the deadline this promise is the one that never settles
  await new Promise((res) => setTimeout(res, 250));
  r.stop();
  assert.ok(started >= 3, `the poll must outlive a hung reading — it only ever started ${started}`);
});

// The deadline exists to unblock the LOOP, but it must also let go of the request: during an
// outage the poll fires every 3s, and a pile of sockets nobody will ever answer is its own bug.
test('a timed-out reading is aborted, not merely abandoned', async () => {
  let aborted = 0;
  const r = createRoster({
    fetchCatalogue: async () => [],
    fetchLive: (signal) =>
      new Promise<never>((_res, rej) => {
        signal.addEventListener('abort', () => {
          aborted++;
          rej(new Error('aborted'));
        });
      }),
    pollMs: 5,
    timeoutMs: 20,
  });
  void r.start();
  await new Promise((res) => setTimeout(res, 120));
  r.stop();
  assert.ok(aborted >= 2, `each hung reading must be aborted — ${aborted} were`);
});
