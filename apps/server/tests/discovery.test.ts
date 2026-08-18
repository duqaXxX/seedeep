import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isLive } from '../src/core/types.ts';
import { discoverSessions } from '../src/server/discovery.ts';

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'seedeep-disc-'));
  const slug = join(root, '-home-dev-project');
  mkdirSync(join(slug, 'subagents'), { recursive: true });
  const active = join(slug, 'aaaaaaaa-0000-0000-0000-000000000001.jsonl');
  const dead = join(slug, 'bbbbbbbb-0000-0000-0000-000000000002.jsonl');
  const line = (sid: string) =>
    JSON.stringify({
      type: 'assistant',
      sessionId: sid,
      cwd: '/home/dev/project',
      message: { model: 'claude-opus-4-8' },
    }) + '\n';
  writeFileSync(active, line('aaaaaaaa-0000-0000-0000-000000000001'));
  writeFileSync(dead, line('bbbbbbbb-0000-0000-0000-000000000002'));
  // child file that MUST NOT be enumerated as a top-level session
  writeFileSync(join(slug, 'subagents', 'agent-child.jsonl'), line('child'));
  // make dead file old
  const old = new Date(Date.now() - 3600_000);
  utimesSync(dead, old, old);
  return root;
}

test('enumerates top-level sessions, excludes subagents/, marks active', async () => {
  const root = makeRoot();
  const recs = await discoverSessions({ roots: [root], now: Date.now() });
  const ids = recs.map((r) => r.sessionId).sort();
  assert.deepEqual(ids, ['aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002']);
  const active = recs.find((r) => r.sessionId.endsWith('001'))!;
  const dead = recs.find((r) => r.sessionId.endsWith('002'))!;
  assert.equal(active.isActive, true);
  assert.equal(dead.isActive, false);
  assert.equal(active.model, 'claude-opus-4-8');
  assert.equal(active.project, 'project');
});

test('reads model from the first assistant line, not the first line', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seedeep-disc-model-'));
  const slug = join(root, '-home-dev-project');
  mkdirSync(slug, { recursive: true });
  const p = join(slug, 'cccccccc-0000-0000-0000-000000000003.jsonl');
  // Real sessions open with non-assistant lines that carry no model.
  const content =
    JSON.stringify({ type: 'mode', sessionId: 'cccccccc-0000-0000-0000-000000000003', cwd: '/home/dev/project' }) +
    '\n' +
    JSON.stringify({ type: 'user', sessionId: 'cccccccc-0000-0000-0000-000000000003' }) +
    '\n' +
    JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-8' } }) +
    '\n';
  writeFileSync(p, content);
  const recs = await discoverSessions({ roots: [root], now: Date.now() });
  const rec = recs.find((r) => r.sessionId.endsWith('003'))!;
  assert.equal(rec.model, 'claude-opus-4-8');
  assert.equal(rec.project, 'project');
});

test('a session in the open set is isOpen with its status; others are not', async () => {
  const root = makeRoot();
  const openId = 'aaaaaaaa-0000-0000-0000-000000000001';
  const recs = await discoverSessions({
    roots: [root],
    now: Date.now(),
    openSessions: [
      {
        pid: 1,
        sessionId: openId,
        cwd: '/home/dev/project',
        status: 'busy',
        waitingFor: null,
        waitingSince: null,
        publishesStatus: true,
      },
    ],
  });
  const open = recs.find((r) => r.sessionId === openId)!;
  const other = recs.find((r) => r.sessionId.endsWith('002'))!;
  assert.equal(open.isOpen, true);
  assert.equal(open.status, 'busy');
  assert.equal(other.isOpen, false);
  assert.equal(other.status, null);
});

// The PID mechanism itself missing (no ~/.claude/sessions/ — an undocumented CC internal a
// release may drop) is NOT "every session is closed": recorded as false, it would take the
// watcher's live gate down with it. null hands the answer to the mtime window instead.
test('no open-session mechanism at all yields isOpen null, not false', async () => {
  const root = makeRoot();
  const recs = await discoverSessions({ roots: [root], now: Date.now(), openSessions: null });
  assert.ok(recs.length > 0);
  assert.deepEqual([...new Set(recs.map((r) => r.isOpen))], [null]);
  assert.ok(
    recs.every((r) => isLive(r) === r.isActive),
    'liveness falls back to the mtime window',
  );
});

// --- Session subject (the readable dropdown label) ------------------------------
// Faithful line shapes (verified on real sessions 2026-07-16): a typed prompt carries
// `origin.kind:'human'` + `promptSource:'typed'` with a STRING content; a slash command
// carries neither and puts `<command-name>/x</command-name>` (with optional
// `<command-args>`) in the string content; a headless run carries `promptSource:'sdk'`.

const sid = (n: string) => `dddddddd-0000-0000-0000-00000000000${n}`;
const user = (content: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'user', ...extra, message: { content } });
const typed = (text: string, extra: Record<string, unknown> = {}) =>
  user(text, { origin: { kind: 'human' }, promptSource: 'typed', ...extra });
const asst = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'assistant', ...extra, message: { model: 'claude-opus-4-8' } });

// Write one session file whose lines all share sessionId/cwd, and discover it.
async function subjectOf(id: string, lines: string[], extraFirst: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'seedeep-subj-'));
  const slug = join(root, '-home-dev-project');
  mkdirSync(slug, { recursive: true });
  // stamp sessionId + cwd (+ any first-line extras like entrypoint/gitBranch) on the head line
  const head = JSON.stringify({ type: 'mode', sessionId: id, cwd: '/home/dev/project', ...extraFirst });
  writeFileSync(join(slug, `${id}.jsonl`), [head, ...lines].join('\n') + '\n');
  const recs = await discoverSessions({ roots: [root], now: Date.now() });
  return recs.find((r) => r.sessionId === id)!;
}

test('subject: a genuine typed prompt is the subject', async () => {
  const rec = await subjectOf(sid('1'), [typed('check the token widget'), asst()]);
  assert.equal(rec.subject, 'check the token widget');
});

test('subject: skips /clear and /effort, takes the first real prompt', async () => {
  const rec = await subjectOf(sid('2'), [
    user('<command-name>/clear</command-name>'),
    user('<command-name>/effort</command-name><command-args>xhigh</command-args>'),
    typed('refactor the reducer'),
    asst(),
  ]);
  assert.equal(rec.subject, 'refactor the reducer');
});

test('subject: a non-control command keeps its args as the subject', async () => {
  const rec = await subjectOf(sid('3'), [
    user('<command-name>/paste-image</command-name><command-args>fix the toast bug</command-args>'),
    asst(),
  ]);
  assert.equal(rec.subject, 'fix the toast bug');
});

test('subject: an argument-less non-control command falls back to /name', async () => {
  const rec = await subjectOf(sid('4'), [user('<command-name>/paste-image</command-name>'), asst()]);
  assert.equal(rec.subject, '/paste-image');
});

test('subject: a headless sdk prompt is kept (turn detection would drop it)', async () => {
  const rec = await subjectOf(
    sid('5'),
    [user('You are a documentation-freshness gate for the project.', { promptSource: 'sdk' }), asst()],
    { entrypoint: 'sdk-cli' },
  );
  assert.equal(rec.subject, 'You are a documentation-freshness gate for the project.');
  assert.equal(rec.entrypoint, 'sdk-cli');
});

test('subject: a headless prompt shaped like a command still names its session', async () => {
  // An sdk line carries no `origin` either — 0 of 5586 measured — so a shape-first reading would
  // file `claude -p "/review this"` as a slash command, and turn detection (which keeps a command
  // and drops an sdk prompt) would give a headless run a turn it never had. `golden-transcript`
  // owns that half; here the subject must still be readable, and it is the command's ARGUMENTS —
  // the same thing an interactive `/review …` names its session with.
  const rec = await subjectOf(
    sid('5b'),
    [user('/review the docs gate output and report', { promptSource: 'sdk' }), asst()],
    { entrypoint: 'sdk-cli' },
  );
  assert.equal(rec.subject, 'the docs gate output and report');
});

test('subject: tool_result and local-command-caveat lines carry no subject', async () => {
  const rec = await subjectOf(sid('6'), [
    user('<local-command-caveat>ignore me</local-command-caveat>'),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] } }),
    asst(),
  ]);
  assert.equal(rec.subject, null);
});

test('entrypoint is captured from the head', async () => {
  const rec = await subjectOf(sid('7'), [typed('do a thing'), asst()], { entrypoint: 'cli' });
  assert.equal(rec.entrypoint, 'cli');
});

test('subject: incremental scan reads a prompt sitting past the first 64KB chunk', async () => {
  // A huge early line (bigger than one 64KB read) once buried the real prompt beyond the
  // scan; the incremental read must keep going until the anchors are found.
  const hugeEarly = JSON.stringify({ type: 'attachment', pad: 'x'.repeat(80_000) });
  const rec = await subjectOf(sid('8'), [hugeEarly, typed('the task after the big line'), asst()]);
  assert.equal(rec.subject, 'the task after the big line');
});

test('subject: gives up gracefully (null) once the 1MB scan cap is exceeded', async () => {
  const overCap = JSON.stringify({ type: 'attachment', pad: 'x'.repeat(1_100_000) });
  const rec = await subjectOf(sid('9'), [overCap, typed('too late to be seen'), asst()]);
  assert.equal(rec.subject, null);
});

// --- Head-scan cache -------------------------------------------------------
// The watcher re-discovers every ~300ms; without a cache every tick re-opened and
// re-parsed the head of EVERY session file. A head's anchors are immutable once
// written, so a completed scan must be served from cache, while an incomplete one
// (young session, anchors not yet written) must be re-scanned as the file grows.

function cacheRoot(id: string, body: string): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'seedeep-cache-'));
  const slug = join(root, '-home-dev-project');
  mkdirSync(slug, { recursive: true });
  const path = join(slug, `${id}.jsonl`);
  writeFileSync(path, body);
  return { root, path };
}
const discover = (root: string) => discoverSessions({ roots: [root], now: Date.now() });

test('head cache: a completed head is not re-read on later discoveries', async () => {
  const id = 'eeeeeeee-0000-0000-0000-000000000001';
  const body = (model: string) =>
    JSON.stringify({ type: 'mode', sessionId: id, cwd: '/home/dev/project' }) +
    '\n' +
    typed('the real task') +
    '\n' +
    JSON.stringify({ type: 'assistant', message: { model } }) +
    '\n';
  const { root, path } = cacheRoot(id, body('claude-opus-4-8'));
  assert.equal((await discover(root))[0]!.model, 'claude-opus-4-8');
  // Same-length in-place rewrite: a re-scan would report the new model; the cache must not.
  writeFileSync(path, body('claude-opus-9-9'));
  assert.equal((await discover(root))[0]!.model, 'claude-opus-4-8');
});

test('head cache: a transient read failure serves the cached meta, not a blank record', async () => {
  // Filename and embedded sessionId differ on purpose: the filename is the fallback
  // identity, so serving it would prove the cached anchors were dropped.
  const embedded = 'ffffffff-0000-0000-0000-000000000003';
  const { root, path } = cacheRoot(
    'eeeeeeee-0000-0000-0000-000000000003',
    JSON.stringify({ type: 'mode', sessionId: embedded, cwd: '/home/dev/project' }) + '\n',
  );
  assert.equal((await discover(root))[0]!.sessionId, embedded); // incomplete head, now cached
  appendFileSync(path, asst() + '\n'); // grown → the next discovery must rescan…
  chmodSync(path, 0o000); // …but the read fails (transiently)
  try {
    assert.equal((await discover(root))[0]!.sessionId, embedded, 'cached anchors survive a failed rescan');
  } finally {
    chmodSync(path, 0o644);
  }
});

test('head cache: an incomplete head is re-scanned when the file grows', async () => {
  const id = 'eeeeeeee-0000-0000-0000-000000000002';
  const { root, path } = cacheRoot(
    id,
    JSON.stringify({ type: 'mode', sessionId: id, cwd: '/home/dev/project' }) + '\n',
  );
  const young = (await discover(root))[0]!;
  assert.equal(young.model, null);
  assert.equal(young.subject, null);
  // The session's first turn lands: the anchors must be picked up on the next tick.
  appendFileSync(path, typed('now the task exists') + '\n' + asst() + '\n');
  const grown = (await discover(root))[0]!;
  assert.equal(grown.model, 'claude-opus-4-8');
  assert.equal(grown.subject, 'now the task exists');
});
