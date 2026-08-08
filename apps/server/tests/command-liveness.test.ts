import assert from 'node:assert/strict';
import { closeSync, mkdirSync, mkdtempSync, openSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createProber, heldOpen, type PendingCommand, type Verdict } from '../src/server/command-liveness.ts';

// The probe answers a question no line in the transcript can, so its failure mode is the one that
// matters: saying a LIVE command is gone. Everything below is about that direction — how many
// empty probes it takes, what resets them, and every way of not knowing being kept apart from
// knowing it is dead.

const cmd = (toolUseId: string, taskId = 't-' + toolUseId): PendingCommand => ({
  sessionId: 's1',
  toolUseId,
  taskId,
});

const T0 = 1_700_000_000_000;

/** A prober whose IO is scripted: one verdict per ROUND, and a clock that advances with it — so
 * `lastSeenAlive` can be asserted as the round it was seen in, not as whenever the box got here. */
function scripted(rounds: (boolean | null)[], path: string | null = '/x/tasks/t.output') {
  let round = 0;
  const prober = createProber({
    uid: 0,
    now: () => new Date(T0 + round * 15_000),
    resolve: async () => path,
    held: async (paths) => new Map(paths.map((p) => [p, rounds[Math.min(round, rounds.length - 1)] as Verdict])),
  });
  return {
    async probe(cmds: PendingCommand[]) {
      const out = await prober.probe(cmds);
      round += 1;
      return out;
    },
    get size() {
      return prober.size;
    },
  };
}

test('one empty probe is not a verdict — it takes two in a row', async () => {
  const p = scripted([false, false]);
  assert.deepEqual(await p.probe([cmd('a')]), [], 'one strike says nothing');
  const out = await p.probe([cmd('a')]);
  assert.deepEqual(
    out.map((v) => v.toolUseId),
    ['a'],
  );
});

test('a command seen alive resets the count, and its last sighting is what bounds the duration', async () => {
  // gone, ALIVE, gone, gone — the sighting in the middle must throw the first strike away, and
  // the bound reported at the end must be that sighting, not the launch and not the verdict.
  const p = scripted([false, true, false, false]);
  await p.probe([cmd('a')]);
  await p.probe([cmd('a')]);
  assert.deepEqual(await p.probe([cmd('a')]), [], 'the sighting reset it, so this is strike one');
  const [v] = await p.probe([cmd('a')]);
  assert.equal(v?.toolUseId, 'a');
  assert.equal(v?.lastSeenAlive, new Date(T0 + 15_000).toISOString());
});

test('no verdict is not a death: an unanswerable probe leaves the row alone, for ever', async () => {
  const p = scripted([null, null, null, null]);
  for (let i = 0; i < 4; i++) assert.deepEqual(await p.probe([cmd('a')]), [], `round ${i}`);
});

test('a command whose output file cannot be found is never judged', async () => {
  // The file is how the question is asked. Not finding it — another machine, a cleaned tmp, a
  // layout Claude Code changed — has to read as "cannot answer", never as "the process is gone".
  const p = scripted([false, false, false, false], null);
  for (let i = 0; i < 4; i++) assert.deepEqual(await p.probe([cmd('a')]), [], `round ${i}`);
});

test('it is reported once, and a command that leaves the list is forgotten', async () => {
  const p = scripted([false, false, false, false]);
  await p.probe([cmd('a'), cmd('b')]);
  assert.equal((await p.probe([cmd('a'), cmd('b')])).length, 2, 'both tip on the second strike');
  assert.deepEqual(await p.probe([cmd('a'), cmd('b')]), [], 'and neither is announced twice');
  assert.equal(p.size, 2);
  // Its notification finally arrived, or the session closed: the caller stops sending it, and the
  // map must not keep it — this runs for the life of the process.
  await p.probe([cmd('a')]);
  assert.equal(p.size, 1);
});

// The one test that runs the REAL primitive. Everything above scripts the IO, so none of it can
// tell whether `lsof -F pn` was read correctly — and that parse is the whole mechanism.
test('heldOpen tells a file this process holds open from one it does not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-liveness-'));
  mkdirSync(join(dir, 'tasks'), { recursive: true });
  const open = join(dir, 'tasks', 'open.output');
  const closed = join(dir, 'tasks', 'closed.output');
  writeFileSync(open, '');
  writeFileSync(closed, '');
  const fd = openSync(open, 'r');
  try {
    const held = await heldOpen([open, closed]);
    // Skipped rather than failed where the tool is absent: the code's own answer there is "no
    // verdict", and a red test on a machine without lsof would be asserting the box, not the code.
    if (held.get(open) === null) return;
    assert.equal(held.get(open), true, 'this very process is holding it');
    assert.equal(held.get(closed), false, 'and nothing is holding the other');
  } finally {
    closeSync(fd);
  }
});
