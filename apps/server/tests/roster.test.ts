import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type CatalogueRecord, liveOf, mergeRoster, toCatalogue } from '../src/core/roster.ts';
import { ACTIVE_WINDOW_MS, isLive, type SessionRecord } from '../src/core/types.ts';
import { discoverSessions } from '../src/server/discovery.ts';

const NOW = 1_800_000_000_000; // a fixed instant, so the 5-minute isActive window is not a race
const ago = (ms: number) => NOW - ms;

// `isActive` is not free: discovery derives it from the mtime, so a record claiming a fresh
// write and a 1970 mtime is a shape that cannot exist, and a fixture built that way would
// only test my own belief.
const rec = (id: string, over: Partial<SessionRecord> & { lastActivity: number }): SessionRecord => ({
  sessionId: id,
  project: 'p',
  model: 'm',
  isActive: NOW - over.lastActivity <= ACTIVE_WINDOW_MS,
  isOpen: false,
  status: null,
  waitingFor: null,
  waitingSince: null,
  subject: null,
  entrypoint: 'cli',
  root: 'cli',
  path: `/x/${id}.jsonl`,
  ...over,
});

const split = (roster: SessionRecord[]) => ({ catalogue: roster.map(toCatalogue), live: liveOf(roster) });

// THE contract. Everything else in the split is an optimisation of these two payloads; if the
// halves stop rebuilding the whole, every consumer above createRoster is served a lie.
test('split → merge reproduces the roster exactly', () => {
  const roster = [
    rec('live-busy', { lastActivity: ago(1_000), isOpen: true, status: 'busy', subject: 'fix the redirect' }),
    rec('live-waiting', {
      lastActivity: ago(2_000),
      isOpen: true,
      status: 'waiting',
      waitingFor: 'permission prompt',
      waitingSince: ago(2_500),
    }),
    rec('just-closed', { lastActivity: ago(3_000), isOpen: false }), // written seconds ago, process gone: isOpen wins, NOT live
    rec('dead', { lastActivity: ago(86_400_000) }),
    rec('automated', { lastActivity: ago(90_000_000), entrypoint: 'sdk-cli' }),
  ];
  const { catalogue, live } = split(roster);
  assert.deepEqual(mergeRoster(catalogue, live, NOW), roster);
});

test('the poll carries only the live sessions, and it is a fraction of the catalogue', () => {
  const roster = [
    rec('a', { lastActivity: ago(1_000), isOpen: true }),
    ...Array.from({ length: 200 }, (_, i) => rec(`d${i}`, { lastActivity: ago(86_400_000 + i) })),
  ];
  const { catalogue, live } = split(roster);
  assert.deepEqual(
    live.sessions.map((s) => s.sessionId),
    ['a'],
  );
  assert.equal(live.total, 201);
  assert.ok(
    JSON.stringify(live).length * 20 < JSON.stringify(catalogue).length,
    'a poll must be at least 20x lighter than the catalogue it replaces',
  );
});

test('a session that ends drops out of the live payload and its tab can see it end', () => {
  // Absence from the payload is the whole signal: a 3s poll gives nothing else. The caller has
  // already refetched the catalogue by here (the record stopped being provisional), so the
  // merge reads a settled record and only has to strip the liveness.
  const settled = [rec('a', { lastActivity: ago(1_000), isOpen: false, status: null })];
  const { catalogue } = split(settled);
  const after = mergeRoster(catalogue, { total: 1, sessions: [], pidVisible: true }, NOW);
  assert.equal(isLive(after[0]!), false, 'the tab must be able to end');
  assert.equal(after[0]!.status, null);
  assert.equal(after[0]!.lastActivity, ago(1_000));
});

test('isOpen stays null when the PID mechanism itself is unavailable', () => {
  // `isOpen: null` is not "closed", it is "nobody asked" — discovery writes it on EVERY record
  // when ~/.claude/sessions is absent, and then isActive decides. Flattening it to false would
  // claim a mechanism answered when it never ran.
  const roster = [rec('a', { lastActivity: ago(86_400_000), isOpen: null })];
  const { catalogue, live } = split(roster);
  assert.equal(live.pidVisible, false);
  assert.equal(mergeRoster(catalogue, live, NOW)[0]!.isOpen, null);
  // …and with the dir present, a non-live session is genuinely closed.
  const seen = split([rec('a', { lastActivity: ago(86_400_000), isOpen: false })]);
  assert.equal(seen.live.pidVisible, true);
  assert.equal(mergeRoster(seen.catalogue, seen.live, NOW)[0]!.isOpen, false);
});

test('a session born after the catalogue is still offered now, not in three seconds', () => {
  const catalogue: CatalogueRecord[] = [toCatalogue(rec('old', { lastActivity: ago(86_400_000) }))];
  const born = rec('new', { lastActivity: ago(500), isOpen: true });
  const rows = mergeRoster(catalogue, { total: 2, sessions: [born], pidVisible: true }, NOW);
  assert.deepEqual(
    rows.map((s) => s.sessionId),
    ['new', 'old'],
    'present, and sorted most-recent-first',
  );
});

test('merged order follows lastActivity, not the order the catalogue froze', () => {
  // The catalogue's order is a snapshot; a live session keeps writing under it. Without the
  // re-sort the picker would show a session that has been busy for an hour below one that
  // stopped yesterday.
  const catalogue = [
    toCatalogue(rec('fresh-then', { lastActivity: ago(60_000) })),
    toCatalogue(rec('live', { lastActivity: ago(120_000), isOpen: true })),
  ];
  const live = { total: 2, sessions: [rec('live', { lastActivity: ago(200), isOpen: true })], pidVisible: true };
  assert.deepEqual(
    mergeRoster(catalogue, live, NOW).map((s) => s.sessionId),
    ['live', 'fresh-then'],
  );
});

// A fixture is what I believed; the disk is what is true. If discovery grows a field and the
// catalogue projection does not, this is what notices.
test('split → merge reproduces a REAL roster from this machine', async () => {
  const roster = await discoverSessions();
  const now = Date.now(); // the instant discovery derived isActive at, to within milliseconds
  if (roster.length === 0) {
    // Not `t.skip()`: Bun's node:test shim throws NotImplementedError on it, so the guard meant to
    // spare a machine without sessions FAILED the run on CI instead. Returning is the portable
    // form — and it is announced, because a test that verified nothing must not read as a pass.
    console.error('roster: no sessions on this machine — the real-data check verified nothing');
    return;
  }
  const { catalogue, live } = split(roster);
  assert.deepEqual(mergeRoster(catalogue, live, now), roster);
  assert.ok(
    JSON.stringify(live).length < JSON.stringify(catalogue).length,
    `poll ${JSON.stringify(live).length}B vs catalogue ${JSON.stringify(catalogue).length}B`,
  );
});
