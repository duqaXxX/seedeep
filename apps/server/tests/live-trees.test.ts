import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { appendFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { windowFor } from '../src/core/context-windows.ts';
import type { TreeSnapshot } from '../src/core/session-tree.ts';
import { createSessionTree } from '../src/core/session-tree.ts';
import type { NormalizedEvent, SessionRecord } from '../src/core/types.ts';
import { createLiveTrees } from '../src/server/live-trees.ts';
import { parseLine } from '../src/server/parser.ts';
import { streamReplay } from '../src/server/replay.ts';
import { Watcher } from '../src/server/watcher.ts';

// The only assertion that can catch a broken replay→live handoff: a tree the server advanced
// LIVE must equal the tree the same session produces when replayed whole.
// Everything starts from raw jsonl through the real parser and the real reducer — an event
// built by hand would carry the belief that produced the bug.
//
// Line shapes are the ones verified in golden-transcript.test.ts / span-store.test.ts;
// content is synthetic. The assistant tool_use line deliberately carries `usage` too, because
// ONE line then emits SEVERAL events sharing a seq — the case a frontier-tracking guard
// silently truncates.

const SID = '11111111-2222-3333-4444-555555555555';
const AGENT = 'a1b2c3';

const typed = (uuid: string, text: string, ts: string) =>
  JSON.stringify({
    type: 'user',
    uuid,
    timestamp: ts,
    origin: { kind: 'human' },
    promptSource: 'typed',
    message: { role: 'user', content: text },
  });
const assistant = (uuid: string, fill: number, ts: string, out = 100) =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: ts,
    message: {
      role: 'assistant',
      model: 'claude-opus-4-8',
      usage: {
        input_tokens: 10,
        output_tokens: out,
        cache_read_input_tokens: fill - 10,
        cache_creation_input_tokens: 0,
      },
    },
  });
// Usage AND a tool_use on the same line — the multi-event line.
const toolUse = (uuid: string, id: string, name: string, fill: number, ts: string) =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: ts,
    message: {
      role: 'assistant',
      model: 'claude-opus-4-8',
      usage: {
        input_tokens: 10,
        output_tokens: 40,
        cache_read_input_tokens: fill - 10,
        cache_creation_input_tokens: 0,
      },
      content: [{ type: 'tool_use', id, name, input: { file_path: '/home/dev/x.ts' } }],
    },
  });
const toolResult = (uuid: string, toolUseId: string, ts: string) =>
  JSON.stringify({
    type: 'user',
    uuid,
    timestamp: ts,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] },
  });
const turnDuration = (uuid: string, ts: string) =>
  JSON.stringify({
    type: 'system',
    subtype: 'turn_duration',
    uuid,
    timestamp: ts,
    durationMs: 9000,
    messageCount: 3,
  });

const PARENT = [
  typed('u1', 'first prompt', '2026-07-14T10:00:00.000Z'),
  toolUse('a1', 'toolu_1', 'Read', 1000, '2026-07-14T10:00:01.000Z'),
  toolResult('u2', 'toolu_1', '2026-07-14T10:00:02.000Z'),
  assistant('a2', 1400, '2026-07-14T10:00:03.000Z'),
  turnDuration('s1', '2026-07-14T10:00:04.000Z'),
  typed('u3', 'second prompt', '2026-07-14T10:00:10.000Z'),
  toolUse('a3', 'toolu_2', 'Grep', 1800, '2026-07-14T10:00:11.000Z'),
  toolResult('u4', 'toolu_2', '2026-07-14T10:00:12.000Z'),
  assistant('a4', 2200, '2026-07-14T10:00:13.000Z'),
  turnDuration('s2', '2026-07-14T10:00:14.000Z'),
];

// The subagent's own transcript: its own file, so its own seq space starting at 0. A guard
// that used ONE counter for the whole session would drop these against the parent's marks.
const CHILD = [
  assistant('c1', 900, '2026-07-14T10:00:05.000Z', 60),
  toolUse('c2', 'toolu_c1', 'Glob', 1100, '2026-07-14T10:00:06.000Z'),
  assistant('c3', 1300, '2026-07-14T10:00:07.000Z', 80),
];

/** Write a session to a fresh dir: `<dir>/<sid>.jsonl` + `<dir>/<sid>/subagents/agent-<id>.jsonl`. */
async function writeSession(parent: string[], child: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'seedeep-live-trees-'));
  const path = join(dir, `${SID}.jsonl`);
  await writeFile(path, parent.map((l) => l + '\n').join(''));
  const subs = join(dir, SID, 'subagents');
  await mkdir(subs, { recursive: true });
  await writeFile(join(subs, `agent-${AGENT}.jsonl`), child.map((l) => l + '\n').join(''));
  return path;
}

function recordFor(path: string): SessionRecord {
  return {
    sessionId: SID,
    project: 'demo',
    model: 'claude-opus-4-8',
    lastActivity: Date.now(),
    isActive: true,
    isOpen: true,
    status: 'busy',
    waitingFor: null,
    waitingSince: null,
    statusDerived: false,
    subject: 'first prompt',
    entrypoint: 'cli',
    root: 'cli',
    path,
  };
}

/** The events the watcher emits for one line of one file — the real parser, the real seq. */
function eventsFor(line: string, seq: number, agentId: string | null): NormalizedEvent[] {
  return parseLine(line, { sessionId: SID, root: 'cli', seq, agentId }) as NormalizedEvent[];
}

/** Replay a whole session from disk, exactly as the corpus scan does. */
async function replayWhole(path: string): Promise<TreeSnapshot> {
  const tree = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  for await (const e of streamReplay(path, { sessionId: SID, root: 'cli' })) tree.apply(e);
  return tree.snapshot();
}

test('a line really does emit several events sharing one seq', () => {
  // The premise the guard depends on. Asserted rather than assumed: if a tool_use line ever
  // stopped carrying its usage as a separate event, the tests below would still pass while
  // testing nothing.
  assert.ok(eventsFor(PARENT[1]!, 1, null).length >= 2);
});

test('seed + live equals the whole file — the handoff neither drops nor doubles', async () => {
  const whole = await replayWhole(await writeSession(PARENT, CHILD));

  // The split: the file on disk holds only the head, the tail arrives as watcher events.
  const SPLIT = 4,
    CHILD_SPLIT = 1;
  const path = await writeSession(PARENT.slice(0, SPLIT), CHILD.slice(0, CHILD_SPLIT));
  const watcher = new EventEmitter();
  const trees = createLiveTrees({ watcher });

  const ready = trees.ensure(recordFor(path));
  // Emitted BEFORE the seed can finish, so they take the BUFFERED path. The last parent line is
  // held back deliberately — see below.
  assert.equal(trees.get(SID), undefined, 'a seeding tree is not handed out');
  for (let i = SPLIT; i < PARENT.length - 1; i++)
    for (const e of eventsFor(PARENT[i]!, i, null)) watcher.emit('event', e);
  for (let i = CHILD_SPLIT; i < CHILD.length; i++)
    for (const e of eventsFor(CHILD[i]!, i, AGENT)) watcher.emit('event', e);

  const tree = await ready;
  // The held-back line, now on the DIRECT path: both routes into the tree must be exercised, or
  // the equality below only ever proves the buffer works.
  const last = PARENT.length - 1;
  for (const e of eventsFor(PARENT[last]!, last, null)) watcher.emit('event', e);

  assert.deepEqual(tree.snapshot(), whole);
  assert.equal(trees.get(SID), tree);
  trees.stop();
});

test('the watcher pumping the file from offset 0 after the seed changes nothing', async () => {
  // The real race: a session that went live between the watcher's last discovery and this
  // seed gets pumped from the TOP afterwards, re-delivering every line the seed already read.
  const path = await writeSession(PARENT, CHILD);
  const whole = await replayWhole(path);
  const watcher = new EventEmitter();
  const trees = createLiveTrees({ watcher });
  const tree = await trees.ensure(recordFor(path));
  assert.deepEqual(tree.snapshot(), whole, 'the seed alone already equals the whole file');

  for (let i = 0; i < PARENT.length; i++) for (const e of eventsFor(PARENT[i]!, i, null)) watcher.emit('event', e);
  for (let i = 0; i < CHILD.length; i++) for (const e of eventsFor(CHILD[i]!, i, AGENT)) watcher.emit('event', e);

  assert.deepEqual(tree.snapshot(), whole);
  trees.stop();
});

// A word's SIGHTING is what `nowLine` measures its hold from, and only a word that arrived while
// this process was watching has one. Replayed history has not: it was already on disk, already on
// screen, already read. Stamping it at seed time made the count give the line back to a narration
// the user had finished with — observed live, twice, by restarting the server mid-turn: the row
// jumped back to the same intent it had already replaced.
test('a word read off the file has no sighting; one that arrives live does', async () => {
  const said = (uuid: string, text: string, ts: string) =>
    JSON.stringify({
      type: 'assistant',
      uuid,
      timestamp: ts,
      message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text }] },
    });
  const lines = [
    typed('u1', 'first prompt', '2026-07-14T10:00:00.000Z'),
    said('a1', 'Reading the release workflow', '2026-07-14T10:00:01.000Z'),
  ];
  const path = await writeSession(lines, []);
  const watcher = new EventEmitter();
  const trees = createLiveTrees({ watcher });

  await trees.ensure(recordFor(path));
  assert.equal(trees.wordSeenAt(SID), null, 'the seed replays history — nobody was watching it happen');

  // The same session, one word later, arriving the way a live one does.
  const before = Date.now();
  for (const e of eventsFor(said('a2', 'Now running the tests', '2026-07-14T10:00:20.000Z'), 7, null)) {
    watcher.emit('event', e);
  }
  const seen = trees.wordSeenAt(SID);
  assert.ok(seen !== null && seen >= before, 'a word that arrived while we watched is stamped when it did');

  // A subagent's narration is not the session's word: the row speaks for the main thread.
  const mine = trees.wordSeenAt(SID);
  for (const e of eventsFor(said('c9', 'child talking', '2026-07-14T10:00:30.000Z'), 3, AGENT)) {
    watcher.emit('event', e);
  }
  assert.equal(trees.wordSeenAt(SID), mine, 'a child’s words do not move the parent’s sighting');
  trees.stop();
});

test('concurrent asks share one seed, and retain evicts what is no longer live', async () => {
  const path = await writeSession(PARENT, CHILD);
  const watcher = new EventEmitter();
  const trees = createLiveTrees({ watcher });

  // Two consumers asking in the same tick must not each replay the file: a second seed would
  // fold every line into the tree twice.
  const [a, b] = await Promise.all([trees.ensure(recordFor(path)), trees.ensure(recordFor(path))]);
  assert.equal(a, b);
  assert.equal(trees.size, 1);
  assert.deepEqual(a.snapshot(), await replayWhole(path));

  trees.retain([SID]);
  assert.equal(trees.size, 1, 'a live session keeps its tree');
  trees.retain([]);
  assert.equal(trees.size, 0, 'a session that stopped being live drops its tree');
  assert.equal(trees.get(SID), undefined);

  // A dropped session must also stop being fed — otherwise the listener rebuilds state for a
  // tree nobody can reach.
  for (const e of eventsFor(PARENT[0]!, 0, null)) watcher.emit('event', e);
  assert.equal(trees.size, 0);
  trees.stop();
});

// Everything above drives a bare EventEmitter, which means it assumes what the REAL watcher
// does rather than observing it. The guard's correctness rests on one property of that
// watcher — it emits every event of a line in one synchronous loop — and an assumption no test
// exercises is an assumption that can be broken silently. This test runs the real Watcher over
// a file that GROWS, so the seed, the buffer, the handoff and the direct path all happen for
// real, on real seq numbers, including multi-event lines.
test('the REAL watcher advancing a growing file still equals the whole-file replay', async () => {
  const whole = await replayWhole(await writeSession(PARENT, CHILD));

  const SPLIT = 3;
  const path = await writeSession(PARENT.slice(0, SPLIT), CHILD);
  const rec = recordFor(path);
  const watcher = new Watcher({
    intervalMs: 10,
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
  const trees = createLiveTrees({ watcher });
  watcher.start();
  try {
    const tree = await trees.ensure(rec);
    // The tail lands on disk AFTER the seed: the watcher is what has to deliver it.
    appendFileSync(
      path,
      PARENT.slice(SPLIT)
        .map((l) => l + '\n')
        .join(''),
    );

    const deadline = Date.now() + 3_000;
    let snap = tree.snapshot();
    while (Date.now() < deadline && JSON.stringify(snap) !== JSON.stringify(whole)) {
      await new Promise((r) => setTimeout(r, 10));
      snap = tree.snapshot();
    }
    // Equality, not "it changed": a watcher that delivered a line in halves would leave the
    // tools or the usage short, and a re-pumped history would double them.
    assert.deepEqual(snap, whole);
  } finally {
    watcher.stop();
    trees.stop();
  }
});

// The eviction can land in the middle of a seed, which is the one moment the entry map and the
// in-flight promise disagree about what exists.
test('a seed evicted mid-flight finishes for its caller and never resurrects itself', async () => {
  const path = await writeSession(PARENT, CHILD);
  const whole = await replayWhole(path);
  const watcher = new EventEmitter();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });

  const trees = createLiveTrees({
    watcher,
    // The real event stream, paused halfway: the eviction happens while the seed is suspended.
    replay: async function* (p, ctx, marks) {
      let n = 0;
      for await (const e of streamReplay(p, ctx, marks)) {
        if (n++ === 4) await gate;
        yield e;
      }
    },
  });

  const ready = trees.ensure(recordFor(path));
  trees.retain([]); // the session stopped being live while its history was still being read
  assert.equal(trees.size, 0);
  release();

  // The caller still gets a complete, correct tree — the read it was owed finishes.
  const tree = await ready;
  assert.deepEqual(tree.snapshot(), whole);
  // But nothing hands it out again: it is not registered, so the next ask seeds a fresh one.
  assert.equal(trees.get(SID), undefined);
  assert.equal(trees.size, 0);
  const again = await trees.ensure(recordFor(path));
  assert.notEqual(again, tree, 'a re-ask must build a new tree, not revive the evicted one');
  trees.stop();
});

test('a seed that fails after its entry was replaced does not delete the replacement', async () => {
  // The dangerous half of the same race: entry A is evicted mid-seed, a fresh ensure puts a
  // healthy entry B under the same key, and only THEN does A's read throw. Deleting by key
  // would take B with it — leaving its awaiter holding a tree the listener no longer feeds.
  const path = await writeSession(PARENT, CHILD);
  const watcher = new EventEmitter();
  let boom!: () => void;
  const fuse = new Promise<void>((r) => {
    boom = r;
  });
  let first = true;

  const trees = createLiveTrees({
    watcher,
    replay: async function* (p, ctx, marks) {
      if (first) {
        first = false;
        await fuse;
        throw new Error('the first read died late');
      }
      yield* streamReplay(p, ctx, marks);
    },
  });

  const doomed = trees.ensure(recordFor(path));
  trees.retain([]);
  const healthy = await trees.ensure(recordFor(path)); // entry B, seeded from the real file
  boom();
  await assert.rejects(doomed, /died late/);

  assert.equal(trees.size, 1, 'B must still be registered');
  assert.equal(trees.get(SID), healthy);
  trees.stop();
});

test('a session whose file cannot be read does not leave a half-built tree', async () => {
  const watcher = new EventEmitter();
  const trees = createLiveTrees({
    watcher,
    // A replay that fails before its first line is the case under test, so this generator
    // never reaches a yield (see the useYield override in biome.jsonc).
    replay: async function* () {
      throw new Error('unreadable');
    },
  });
  await assert.rejects(trees.ensure(recordFor('/nonexistent/session.jsonl')), /unreadable/);
  assert.equal(trees.size, 0);
  trees.stop();
});
