import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { NormalizedEvent, SessionRecord } from '../src/core/types.ts';
import { streamReplay } from '../src/server/replay.ts';
import { startServer } from '../src/server/server.ts';
import { Watcher } from '../src/server/watcher.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'replay-sample.jsonl');

test('streamReplay emits usage/attribution/compaction from the fixture with seq per source line', async () => {
  const out: NormalizedEvent[] = [];
  for await (const e of streamReplay(FIXTURE, { sessionId: 'synthetic-1', root: 'cli' })) out.push(e);
  const types = out.map((e) => e.type);
  assert.ok(types.includes('usage'));
  assert.ok(types.includes('attribution'));
  assert.ok(types.includes('compaction'));
  // seq counts non-blank source lines (matching the tailer): line 0 = mode
  // (0 events, seq 0), line 1 = usage → seq 1, line 2 = attribution+usage → seq 2,
  // line 3 = compaction → seq 3. The fixture has no blank interior lines.
  const firstUsage = out.find((e) => e.type === 'usage')!;
  assert.equal(firstUsage.seq, 1);
  const compaction = out.find((e) => e.type === 'compaction')!;
  assert.equal(compaction.seq, 3);
});

test('streamReplay on a missing file emits nothing and does not throw', async () => {
  const out: NormalizedEvent[] = [];
  for await (const e of streamReplay('/no/such/seedeep/replay.jsonl', { sessionId: 'x', root: 'cli' })) out.push(e);
  assert.deepEqual(out, []);
});

// The seq of an event MUST be identical whether it came from the live watcher or
// from replay, so (sessionId, seq) dedup works during the handoff. The watcher's
// tailer skips blank lines, so replay must skip them too (not consume a seq slot).
test('replay and watcher assign the SAME seq to the same line, across a blank line', async () => {
  const usageLine = (fill: number) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: 't',
      message: {
        role: 'assistant',
        model: 'm',
        usage: { input_tokens: fill, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    });
  // A file with a BLANK line in the middle — the case that desyncs naive indexing.
  const content = usageLine(10) + '\n\n' + usageLine(20) + '\n';
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-seq-'));
  const p = join(dir, 's.jsonl');
  writeFileSync(p, content);

  // Live path (watcher over the same file).
  const rec: SessionRecord = {
    sessionId: 'S',
    project: 'p',
    model: 'm',
    lastActivity: Date.now(),
    isActive: true,
    isOpen: true,
    status: null,
    waitingFor: null,
    waitingSince: null,
    statusDerived: false,
    subject: null,
    entrypoint: null,
    root: 'cli',
    path: p,
  };
  const live: Array<{ fill: number; seq: number }> = [];
  const w = new Watcher({
    discover: async () => [rec],
    openSessions: async () => [
      {
        pid: 1,
        sessionId: rec.sessionId,
        cwd: '/w',
        status: null,
        waitingFor: null,
        waitingSince: null,
        publishesStatus: true,
      },
    ],
  });
  w.on('event', (e: NormalizedEvent) => {
    if (e.type === 'usage') live.push({ fill: e.fill, seq: e.seq });
  });
  await w.tick();
  w.stop();

  // Replay path.
  const replay: Array<{ fill: number; seq: number }> = [];
  for await (const e of streamReplay(p, { sessionId: 'S', root: 'cli' })) {
    if (e.type === 'usage') replay.push({ fill: e.fill, seq: e.seq });
  }

  assert.deepEqual(replay, live); // same fill AND same seq for each line
});

test('GET /api/replay streams the session events then replay-end', async () => {
  const roster: SessionRecord[] = [
    {
      sessionId: 'synthetic-1',
      project: 'demo',
      model: 'claude-sonnet-5',
      lastActivity: 1,
      isActive: false,
      isOpen: false,
      status: null,
      waitingFor: null,
      waitingSince: null,
      statusDerived: false,
      subject: null,
      entrypoint: null,
      root: 'cli',
      path: FIXTURE,
    },
  ];
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => roster,
    port: 0,
  });
  try {
    const res = await fetch(`${srv.url}/api/replay?sessionId=synthetic-1`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    const body = await res.text(); // finite stream — closes at EOF, so text() resolves
    assert.match(body, /event: usage/);
    assert.match(body, /event: attribution/);
    assert.match(body, /event: compaction/);
    assert.match(body, /event: replay-end/);
  } finally {
    srv.stop();
  }
});

test('GET /api/replay with unknown sessionId → 404', async () => {
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [],
    port: 0,
  });
  try {
    assert.equal((await fetch(`${srv.url}/api/replay?sessionId=nope`)).status, 404);
  } finally {
    srv.stop();
  }
});

// The resync half of /api/replay. `from` is what the caller already holds, per file,
// so a reconnect costs the tail instead of the whole session — and, above all, costs no
// rebuild of the tab it is repairing.
test('GET /api/replay?from= streams only what the caller is missing', async () => {
  const roster: SessionRecord[] = [
    {
      sessionId: 'synthetic-1',
      project: 'demo',
      model: 'claude-sonnet-5',
      lastActivity: 1,
      isActive: false,
      isOpen: false,
      status: null,
      waitingFor: null,
      waitingSince: null,
      statusDerived: false,
      subject: null,
      entrypoint: null,
      root: 'cli',
      path: FIXTURE,
    },
  ];
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => roster,
    port: 0,
  });
  try {
    const seqOf = (body: string) => [...body.matchAll(/"seq":(-?\d+)/g)].map((m) => Number(m[1])).filter((n) => n >= 0);
    const whole = seqOf(await (await fetch(`${srv.url}/api/replay?sessionId=synthetic-1`)).text());
    const max = Math.max(...whole);
    const tail = seqOf(
      await (
        await fetch(`${srv.url}/api/replay?sessionId=synthetic-1&from=${encodeURIComponent(':' + (max - 1))}`)
      ).text(),
    );
    assert.ok(whole.length > tail.length, 'the resync is smaller than the whole session');
    assert.deepEqual([...new Set(tail)], [max], 'and carries exactly the lines past the mark');
  } finally {
    srv.stop();
  }
});

test('GET /api/replay with a malformed from= replays the session whole', async () => {
  // A mark that cannot be read is not a licence to send less: silently withholding history
  // is the failure mode this whole endpoint exists to repair.
  const roster: SessionRecord[] = [
    {
      sessionId: 'synthetic-1',
      project: 'demo',
      model: 'claude-sonnet-5',
      lastActivity: 1,
      isActive: false,
      isOpen: false,
      status: null,
      waitingFor: null,
      waitingSince: null,
      statusDerived: false,
      subject: null,
      entrypoint: null,
      root: 'cli',
      path: FIXTURE,
    },
  ];
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => roster,
    port: 0,
  });
  try {
    const whole = await (await fetch(`${srv.url}/api/replay?sessionId=synthetic-1`)).text();
    const garbled = await (
      await fetch(`${srv.url}/api/replay?sessionId=synthetic-1&from=${encodeURIComponent('garbage!!')}`)
    ).text();
    assert.equal(garbled, whole, 'an unreadable mark yields exactly the full replay');
  } finally {
    srv.stop();
  }
});
