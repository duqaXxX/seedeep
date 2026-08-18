import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { NormalizedEvent, SessionRecord } from '../src/core/types.ts';
import { Watcher, type WatcherOptions } from '../src/server/watcher.ts';

/**
 * A watcher over `recs`, with the open-process mechanism reporting exactly the records the test
 * declared open. The watcher reads the live SET from the process files and a transcript's
 * LOCATION from discovery, so a test has to state both; `isOpen` is the test's own declaration
 * of "this process is alive", translated here into the shape that mechanism returns.
 */
function watcherOver(recs: SessionRecord[], opts: WatcherOptions = {}): Watcher {
  return new Watcher({
    discover: async () => recs,
    openSessions: async () =>
      recs
        .filter((r) => r.isOpen)
        .map((r) => ({
          pid: 1,
          sessionId: r.sessionId,
          cwd: '/w',
          status: r.status,
          waitingFor: null,
          waitingSince: null,
          // The mechanism answered for this session, whatever the test declared its state to be.
          publishesStatus: true,
        })),
    ...opts,
  });
}

function usageLine(fill: number): string {
  return (
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-11T00:00:00.000Z',
      message: {
        role: 'assistant',
        model: 'm',
        usage: { input_tokens: fill, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    }) + '\n'
  );
}

test('tick emits usage events tagged by sessionId from two sessions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-watch-'));
  const a = join(dir, 'a.jsonl');
  const b = join(dir, 'b.jsonl');
  writeFileSync(a, usageLine(100));
  writeFileSync(b, usageLine(200));
  const recs: SessionRecord[] = [
    {
      sessionId: 'A',
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
      path: a,
    },
    {
      sessionId: 'B',
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
      path: b,
    },
  ];
  const w = watcherOver(recs);
  const got: NormalizedEvent[] = [];
  w.on('event', (e: NormalizedEvent) => got.push(e));
  await w.tick();
  const byId = Object.fromEntries(got.filter((e) => e.type === 'usage').map((e) => [e.sessionId, (e as any).fill]));
  assert.deepEqual(byId, { A: 100, B: 200 });
});

test('a second tick reads only appended lines', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-watch2-'));
  const a = join(dir, 'a.jsonl');
  writeFileSync(a, usageLine(100));
  const recs: SessionRecord[] = [
    {
      sessionId: 'A',
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
      path: a,
    },
  ];
  const w = watcherOver(recs);
  const fills: number[] = [];
  w.on('event', (e: NormalizedEvent) => {
    if (e.type === 'usage') fills.push(e.fill);
  });
  await w.tick();
  appendFileSync(a, usageLine(300));
  await w.tick();
  assert.deepEqual(fills, [100, 300]);
});

test('emitted events carry a per-file seq that increases across ticks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-watch3-'));
  const a = join(dir, 'a.jsonl');
  writeFileSync(a, usageLine(1) + usageLine(2));
  const recs: SessionRecord[] = [
    {
      sessionId: 'A',
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
      path: a,
    },
  ];
  const w = watcherOver(recs);
  const seqs: number[] = [];
  w.on('event', (e: NormalizedEvent) => {
    if (e.type === 'usage') seqs.push(e.seq);
  });
  await w.tick();
  appendFileSync(a, usageLine(3));
  await w.tick();
  assert.deepEqual(seqs, [0, 1, 2]);
});

// `seq` is not a counter, it is the line's POSITION in the file — both client
// guards (stream.ts `seq < prev`, replay.ts `seq <= maxReplayed`) compare it against a
// high-water and silently drop anything below. The tick was scheduled by setInterval with
// no in-flight guard, so a slow tick (the first one reads every live file whole) was joined
// by the next: two pumps read from the same offset and each advanced `tracked.seq` over the
// same lines. Measured on a real instance: seq 1585 for an 808-line file. After any restart
// the file can never climb back to that high-water, so the page received events and dropped
// every one of them — frozen for good, with the connection healthy.
test('overlapping ticks never pump the same file twice — seq stays the line index', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-overlap-'));
  const a = join(dir, 'a.jsonl');
  writeFileSync(a, usageLine(1) + usageLine(2) + usageLine(3));
  const recs: SessionRecord[] = [
    {
      sessionId: 'A',
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
      path: a,
    },
  ];
  const w = watcherOver(recs);
  const seqs: number[] = [];
  w.on('event', (e: NormalizedEvent) => {
    if (e.type === 'usage') seqs.push(e.seq);
  });
  // Two ticks in flight at once — exactly what the 300ms interval does to a tick that has
  // not finished. Each line must still be emitted once, numbered by its position.
  await Promise.all([w.tick(), w.tick()]);
  assert.deepEqual(seqs, [0, 1, 2]);
});

test('a tick skipped for overlap is not lost — the next one still reads what landed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-overlap2-'));
  const a = join(dir, 'a.jsonl');
  writeFileSync(a, usageLine(1));
  const recs: SessionRecord[] = [
    {
      sessionId: 'A',
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
      path: a,
    },
  ];
  const w = watcherOver(recs);
  const fills: number[] = [];
  w.on('event', (e: NormalizedEvent) => {
    if (e.type === 'usage') fills.push(e.fill);
  });
  await Promise.all([w.tick(), w.tick()]);
  appendFileSync(a, usageLine(2));
  await w.tick();
  assert.deepEqual(fills, [1, 2]); // dropping the overlapping tick must not drop its lines
});

// The tailer already restarts from offset 0 when the file shrinks; the numbering has to
// restart WITH it, because `seq` is that offset expressed in lines. Left to run on, the
// re-read arrives numbered ABOVE the consumers' high-water: every guard lets it through
// and usage — which is SUMMED — is counted twice, silently.
test('a truncated file restarts the numbering with the offset', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-trunc-'));
  const a = join(dir, 'a.jsonl');
  writeFileSync(a, usageLine(1) + usageLine(2) + usageLine(3));
  const recs: SessionRecord[] = [
    {
      sessionId: 'A',
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
      path: a,
    },
  ];
  const w = watcherOver(recs);
  const seqs: number[] = [];
  w.on('event', (e: NormalizedEvent) => {
    if (e.type === 'usage') seqs.push(e.seq);
  });
  await w.tick();
  assert.deepEqual(seqs, [0, 1, 2]);
  seqs.length = 0;
  writeFileSync(a, usageLine(9)); // rewritten smaller — the tailer re-reads from 0
  await w.tick();
  assert.deepEqual(seqs, [0], 'the re-read is a re-delivery from 0, which every consumer guard already handles');
});

test('a subagent child file tags events with agentId and does not corrupt parent fill', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-sub-'));
  const parent = join(dir, 'P.jsonl');
  writeFileSync(parent, usageLine(500));
  // Real layout: children live under <dir>/<uuid>/subagents/, not <dir>/subagents/.
  const subDir = join(dir, 'P', 'subagents');
  mkdirSync(subDir, { recursive: true });
  writeFileSync(join(subDir, 'agent-XYZ.jsonl'), usageLine(30));
  writeFileSync(
    join(subDir, 'agent-XYZ.meta.json'),
    JSON.stringify({ agentType: 'explore', toolUseId: 'toolu_1', spawnDepth: 1 }),
  );
  const recs: SessionRecord[] = [
    {
      sessionId: 'P',
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
      path: parent,
    },
  ];
  const w = watcherOver(recs);
  const usages: Array<{ agentId: string | null; fill: number }> = [];
  const metas: Array<{ agentId: string | null | undefined; toolUseId: string | null; model: string | null }> = [];
  w.on('event', (e: NormalizedEvent) => {
    if (e.type === 'usage') usages.push({ agentId: e.agentId ?? null, fill: e.fill });
    if (e.type === 'subagent-meta') metas.push({ agentId: e.agentId, toolUseId: e.toolUseId, model: e.model });
  });
  await w.tick();
  const parentUsage = usages.find((u) => u.agentId === null);
  const subUsage = usages.find((u) => u.agentId === 'XYZ');
  assert.equal(parentUsage?.fill, 500);
  assert.equal(subUsage?.fill, 30);
  // Two subagent-meta events: the sidecar link (toolUseId) and the model from the
  // child jsonl (usageLine writes model 'm'). They arrive as separate events that
  // the reducer merges — assert both facts are present across them.
  assert.ok(
    metas.some((m) => m.agentId === 'XYZ' && m.toolUseId === 'toolu_1'),
    'sidecar link emitted',
  );
  assert.ok(
    metas.some((m) => m.agentId === 'XYZ' && m.model === 'm'),
    'model emitted',
  );
});

// The gate used to be `isActive` alone — the parent jsonl's mtime window. A session waiting
// on a background subagent writes NOTHING to its parent file for the whole run (measured on
// real logs: a 22.5-min parent silence while the child kept writing), so the tick dropped the
// session and with it its children: the live feed froze for as long as the subagent worked,
// then caught up in a burst. A live process is the authoritative signal — mtime is only the
// fallback for a Claude Code without `~/.claude/sessions/`.
test('a session with a live process keeps tailing its children while the parent file is silent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-idle-'));
  const parent = join(dir, 'P.jsonl');
  writeFileSync(parent, usageLine(500));
  const subDir = join(dir, 'P', 'subagents');
  mkdirSync(subDir, { recursive: true });
  writeFileSync(join(subDir, 'agent-BG.jsonl'), usageLine(10));
  // Process alive, parent untouched past ACTIVE_WINDOW_MS — the reported shape exactly.
  const recs: SessionRecord[] = [
    {
      sessionId: 'P',
      project: 'p',
      model: 'm',
      lastActivity: Date.now() - 20 * 60_000,
      isActive: false,
      isOpen: true,
      status: 'busy',
      waitingFor: null,
      waitingSince: null,
      statusDerived: false,
      subject: null,
      entrypoint: 'cli',
      root: 'cli',
      path: parent,
    },
  ];
  const w = watcherOver(recs);
  const fills: Array<{ agentId: string | null; fill: number }> = [];
  w.on('event', (e: NormalizedEvent) => {
    if (e.type === 'usage') fills.push({ agentId: e.agentId ?? null, fill: e.fill });
  });
  await w.tick();
  appendFileSync(join(subDir, 'agent-BG.jsonl'), usageLine(20)); // the subagent works on
  await w.tick();
  assert.deepEqual(
    fills.filter((f) => f.agentId === 'BG').map((f) => f.fill),
    [10, 20],
  );
});

// The other half of the gate: no live process and nothing written for ages — a closed
// session must stay closed, or every jsonl on disk gets polled forever.
test('a session with no live process and a cold file is not tailed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-cold-'));
  const parent = join(dir, 'P.jsonl');
  writeFileSync(parent, usageLine(500));
  const recs: SessionRecord[] = [
    {
      sessionId: 'P',
      project: 'p',
      model: 'm',
      lastActivity: Date.now() - 20 * 60_000,
      isActive: false,
      isOpen: false,
      status: null,
      waitingFor: null,
      waitingSince: null,
      statusDerived: false,
      subject: null,
      entrypoint: 'cli',
      root: 'cli',
      path: parent,
    },
  ];
  const w = watcherOver(recs);
  const got: NormalizedEvent[] = [];
  w.on('event', (e: NormalizedEvent) => got.push(e));
  await w.tick();
  assert.deepEqual(got, []);
});

test('subagent-meta is not re-emitted every tick once resolved', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-sub2-'));
  const parent = join(dir, 'P.jsonl');
  writeFileSync(parent, usageLine(500));
  const subDir = join(dir, 'P', 'subagents');
  mkdirSync(subDir, { recursive: true });
  writeFileSync(join(subDir, 'agent-XYZ.jsonl'), usageLine(30));
  // No meta.json sidecar on purpose: the model-only meta must still be emitted,
  // exactly once, and must NOT cause a full child re-read every tick.
  const recs: SessionRecord[] = [
    {
      sessionId: 'P',
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
      path: parent,
    },
  ];
  const w = watcherOver(recs);
  let metaCount = 0;
  w.on('event', (e: NormalizedEvent) => {
    if (e.type === 'subagent-meta') metaCount++;
  });
  await w.tick();
  await w.tick();
  await w.tick();
  assert.equal(metaCount, 1); // model-only meta emitted once despite the missing sidecar
});

// ── the idle cost: a tick must not scan a corpus it has no reason to look at ──

/** A record on disk, live only if `isOpen`. */
function rec(sessionId: string, path: string, isOpen: boolean): SessionRecord {
  return {
    sessionId,
    project: 'p',
    model: 'm',
    lastActivity: Date.now(),
    isActive: true,
    isOpen,
    status: null,
    waitingFor: null,
    waitingSince: null,
    statusDerived: false,
    subject: null,
    entrypoint: null,
    root: 'cli',
    path,
  };
}

test('nothing open: no tick ever scans the corpus', async () => {
  // The defect this closes: discovery ran first and `isLive` filtered afterwards, so a machine
  // with a thousand cold sessions and no Claude Code running paid a full scan 3.3 times a second.
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-idle0-'));
  const cold = Array.from({ length: 50 }, (_, i) => {
    const p = join(dir, `c${i}.jsonl`);
    writeFileSync(p, usageLine(1));
    return rec(`C${i}`, p, false);
  });
  let scans = 0;
  const w = new Watcher({
    discover: async () => {
      scans++;
      return cold;
    },
    openSessions: async () => [],
  });
  const got: NormalizedEvent[] = [];
  w.on('event', (e: NormalizedEvent) => got.push(e));
  await w.tick();
  await w.tick();
  await w.tick();
  assert.equal(scans, 0, 'the corpus was scanned with nothing to find in it');
  assert.deepEqual(got, [], 'and nothing cold was tailed');
});

test('an open session is located once, not on every tick', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-locate-'));
  const p = join(dir, 'P.jsonl');
  writeFileSync(p, usageLine(100));
  let scans = 0;
  const w = new Watcher({
    discover: async () => {
      scans++;
      return [rec('P', p, true)];
    },
    openSessions: async () => [
      { pid: 1, sessionId: 'P', cwd: '/w', status: null, waitingFor: null, waitingSince: null, publishesStatus: true },
    ],
  });
  const fills: number[] = [];
  w.on('event', (e: NormalizedEvent) => {
    if (e.type === 'usage') fills.push(e.fill);
  });
  await w.tick();
  appendFileSync(p, usageLine(200));
  await w.tick();
  await w.tick();
  assert.equal(scans, 1, 'a path does not move — one scan places it for good');
  assert.deepEqual(fills, [100, 200], 'and the session is still tailed from the cached location');
});

test('an open session with no transcript yet does not rescan every tick', async () => {
  // Claude Code writes the process file when the window opens but the transcript only when the
  // conversation does. Without the throttle this exact state — an open window nobody has typed
  // into — would scan the whole corpus 3.3 times a second, which is the cost being removed.
  let scans = 0;
  const w = new Watcher({
    discover: async () => {
      scans++;
      return [];
    }, // the id is nowhere on disk
    openSessions: async () => [
      {
        pid: 1,
        sessionId: 'GHOST',
        cwd: '/w',
        status: null,
        waitingFor: null,
        waitingSince: null,
        publishesStatus: true,
      },
    ],
  });
  await w.tick();
  await w.tick();
  await w.tick();
  await w.tick();
  assert.equal(scans, 1, 'four ticks, one scan');
});

test('no open-session mechanism: the mtime window still decides, as it did before', async () => {
  // `~/.claude/sessions/` is an undocumented Claude Code internal. If a release drops it,
  // `isActive` is the only answer there is and the watcher must degrade to the old behaviour
  // rather than going blind and tailing nothing.
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-nomech-'));
  const warm = join(dir, 'W.jsonl');
  writeFileSync(warm, usageLine(7));
  const stale = join(dir, 'S.jsonl');
  writeFileSync(stale, usageLine(9));
  const recs: SessionRecord[] = [
    { ...rec('W', warm, false), isOpen: null, isActive: true },
    { ...rec('S', stale, false), isOpen: null, isActive: false },
  ];
  const w = new Watcher({ discover: async () => recs, openSessions: async () => null });
  const seen: string[] = [];
  w.on('event', (e: NormalizedEvent) => {
    if (e.type === 'usage') seen.push(e.sessionId);
  });
  await w.tick();
  assert.deepEqual(seen, ['W'], 'the recently-written session is tailed, the cold one is not');
});
