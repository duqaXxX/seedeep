import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { SessionRecord } from '../src/core/types.ts';
import { type DigestEntry, PROMPT_HEAD } from '../src/server/digest.ts';
import { parseLine } from '../src/server/parser.ts';
import { startServer } from '../src/server/server.ts';

// The digest is the payload a client that does NOT own the reducer polls. What these tests
// pin is the contract that makes it worth existing: liveness and meaning arrive JOINED in one
// entry, an entry is WHOLE (the two routes differ only in how many sessions they answer for —
// the subagent list used to be gated behind ?sessionId= and is not any more), and nothing
// survives its session going non-live. Sessions are written to disk and read through the real
// replay + reducer — a hand-built snapshot would assert the shape I believed, not the one the
// pipeline produces.

const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const AGENT = 'ag1';

const typed = (uuid: string, text: string, ts: string) =>
  JSON.stringify({
    type: 'user',
    uuid,
    timestamp: ts,
    origin: { kind: 'human' },
    promptSource: 'typed',
    message: { role: 'user', content: text },
  });
const assistant = (uuid: string, fill: number, ts: string) =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: ts,
    message: {
      role: 'assistant',
      model: 'claude-opus-4-8',
      usage: {
        input_tokens: 10,
        output_tokens: 100,
        cache_read_input_tokens: fill - 10,
        cache_creation_input_tokens: 0,
      },
    },
  });
const spawn = (uuid: string, id: string, ts: string) =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: ts,
    message: {
      role: 'assistant',
      model: 'claude-opus-4-8',
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 500, cache_creation_input_tokens: 0 },
      content: [{ type: 'tool_use', id, name: 'Agent', input: { description: 'Review the parser', prompt: 'go' } }],
    },
  });
const turnDuration = (uuid: string, ts: string) =>
  JSON.stringify({
    type: 'system',
    subtype: 'turn_duration',
    uuid,
    timestamp: ts,
    durationMs: 5000,
    messageCount: 2,
  });
// Shapes taken from `golden-transcript.test.ts`, which took them from real transcripts. `toolUse`
// is declared further down, beside the blocked-session tests that first needed it.
const toolResult = (uuid: string, toolUseId: string, text: string, ts: string) =>
  JSON.stringify({
    type: 'user',
    uuid,
    timestamp: ts,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] },
  });
// The turn's final answer — `stop_reason: 'end_turn'`, which is what separates it from a mid-turn
// narration. `effort` sits at the line's ROOT, not inside `message`: Claude Code has written it
// there since 2.1.212, and it is on 97–99% of assistant lines since (measured 2026-07-30).
const finalAnswer = (uuid: string, text: string, ts: string) =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: ts,
    effort: 'high',
    message: {
      role: 'assistant',
      model: 'claude-opus-4-8',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 1190, cache_creation_input_tokens: 0 },
    },
  });

// A mid-turn narration: a text block on an assistant line that is NOT the turn's end. This is the
// live intent panel's datum (`stop_reason` absent, measured as `tool_use` on 79% of text-bearing
// lines), and the shape is the reducer's, not one invented here.
const narration = (uuid: string, text: string, ts: string) =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: ts,
    message: {
      role: 'assistant',
      model: 'claude-opus-4-8',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 10, output_tokens: 30, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 },
    },
  });

/** A timestamp `ms` ago on the REAL clock — for the cases whose answer depends on the word having
 * arrived while somebody was watching (see `nowLine`'s hold). */
const justNow = (ms: number) => new Date(Date.now() - ms).toISOString();

/** A session on disk: parent transcript, plus a subagent child + sidecar when asked. */
function writeSession(parent: string[], child?: { lines: string[]; toolUseId: string }): string {
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-digest-'));
  const path = join(dir, `${SID}.jsonl`);
  writeFileSync(path, parent.map((l) => l + '\n').join(''));
  if (child) {
    const subs = join(dir, SID, 'subagents');
    mkdirSync(subs, { recursive: true });
    writeFileSync(join(subs, `agent-${AGENT}.jsonl`), child.lines.map((l) => l + '\n').join(''));
    writeFileSync(
      join(subs, `agent-${AGENT}.meta.json`),
      JSON.stringify({ toolUseId: child.toolUseId, agentType: 'code-reviewer', spawnDepth: 1 }),
    );
  }
  return path;
}

function record(path: string, over: Partial<SessionRecord> = {}): SessionRecord {
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
    subject: 'first prompt',
    entrypoint: 'cli',
    root: 'cli',
    path,
    ...over,
  };
}

const QUIET = [
  typed('u1', 'first prompt', '2026-07-14T10:00:00.000Z'),
  assistant('a1', 1200, '2026-07-14T10:00:01.000Z'),
  turnDuration('s1', '2026-07-14T10:00:02.000Z'),
];

test('GET /api/digest joins the roster liveness with the tree meaning, one entry per live session', async () => {
  const path = writeSession(QUIET);
  const roster = [
    record(path, { status: 'waiting', waitingFor: 'Bash(rm -rf build)', waitingSince: 1_700_000_000_000 }),
  ];
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => roster,
    port: 0,
  });
  try {
    const entries = (await (await fetch(`${srv.url}/api/digest`)).json()) as DigestEntry[];
    assert.equal(entries.length, 1);
    const e = entries[0]!;

    // From the ROSTER — the Needs-you band prints these verbatim, and a client must not have
    // to fetch /api/live to get them.
    assert.equal(e.sessionId, SID);
    assert.equal(e.project, 'demo');
    assert.equal(e.subject, 'first prompt');
    assert.equal(e.status, 'waiting');
    assert.equal(e.waitingFor, 'Bash(rm -rf build)');
    assert.equal(e.waitingSince, 1_700_000_000_000);

    // From the TREE — meaning nothing but the reducer can produce.
    assert.equal(e.main.fill, 1200);
    assert.ok(e.main.window > 0);
    assert.equal(e.main.model, 'claude-opus-4-8');
    assert.equal(e.totals.turns, 1);
    assert.equal(e.totals.apiCalls, 1);
    assert.equal(e.totals.output, 100);
    assert.equal(e.turn?.index, 1); // the reducer numbers turns from 1
    assert.equal(e.turn?.prompt, 'first prompt');
    assert.equal(e.turn?.state, 'done');

    // The list is in the array form too — the tray draws the agents themselves and polls nothing
    // else. What used to bound the entry (gating the list behind ?sessionId=) is bounded by the
    // work instead: only RUNNING agents are in it, which is none of them here.
    assert.deepEqual(e.subagents.list, []);
    assert.equal(e.subagents.running, 0);
  } finally {
    srv.stop();
  }
});

// What NOW says, for a client that has no reducer — `nowLine`'s answer, the same function the
// browser's panel calls. The markdown is the other half of the test: the tray has no renderer and
// no modal, so a raw `**` reaches the user as two asterisks, which is what the card that asked for
// this field showed on screen.
//
// The word has to ARRIVE while the server is watching — that is the whole rule, and it cannot be
// staged by writing it to the file first: what is already on disk when the tree is built is history
// the reader has already seen, and history earns no hold. So the session is seeded WITHOUT the
// narration, and the narration is then emitted the way the watcher emits one.
test('an entry’s NOW is the agent’s own words while they are still fresh, as plain text', async () => {
  const path = writeSession([
    typed('u1', 'fix the publish job', justNow(3000)),
    toolUse('a2', 'toolu_01', 'Read', { file_path: '/w/release.yml' }, justNow(1000)),
  ]);
  const watcher = new EventEmitter();
  const srv = await startServer({
    watcher,
    discover: async () => [record(path)],
    port: 0,
  });
  try {
    // Seeds the tree, and states the before: what the turn has DONE, because nothing was said.
    const [before] = (await (await fetch(`${srv.url}/api/digest`)).json()) as DigestEntry[];
    assert.equal(before!.turn?.now?.kind, 'activity');

    const line = narration('a3', 'Reading **the workflow** and the `matrix` it declares', justNow(0));
    for (const ev of parseLine(line, { sessionId: SID, root: 'cli', seq: 9, agentId: null })) watcher.emit('event', ev);

    const [e] = (await (await fetch(`${srv.url}/api/digest`)).json()) as DigestEntry[];
    assert.equal(e!.turn?.now?.kind, 'intent');
    assert.equal(e!.turn?.now?.label, 'now');
    assert.equal(e!.turn?.now?.text, 'Reading the workflow and the matrix it declares');
  } finally {
    srv.stop();
  }
});

// The same session with one thing changed — the word is old, so nobody saw it arrive. What the turn
// has DONE takes the line: the browser's rule, now stated once for both surfaces.
test('a word nobody was there to see earns no hold: NOW counts the work instead', async () => {
  const path = writeSession([
    typed('u1', 'fix the publish job', '2026-07-14T10:00:00.000Z'),
    narration('a1', 'Reading the workflow', '2026-07-14T10:00:01.000Z'),
    toolUse('a2', 'toolu_01', 'Read', { file_path: '/w/release.yml' }, '2026-07-14T10:00:02.000Z'),
  ]);
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [record(path)],
    port: 0,
  });
  try {
    const [e] = (await (await fetch(`${srv.url}/api/digest`)).json()) as DigestEntry[];

    assert.equal(e!.turn?.now?.kind, 'activity');
    assert.equal(e!.turn?.now?.text, 'Read 1 file');
  } finally {
    srv.stop();
  }
});

// The final answer replaces the intent once it lands, and gets the same cleaning. Both halves
// matter: a finished session that still showed its last narration would report an intent the agent
// has already carried out.
test('the final answer takes over from the intent, and is plain text too', async () => {
  const path = writeSession([
    typed('u1', 'fix the publish job', '2026-07-14T10:00:00.000Z'),
    narration('a1', 'Reading the workflow', '2026-07-14T10:00:01.000Z'),
    finalAnswer('a2', 'Done. **The job `publish`** is separate from the matrix.', '2026-07-14T10:00:03.000Z'),
    turnDuration('s1', '2026-07-14T10:00:04.000Z'),
  ]);
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [record(path, { status: 'idle' })],
    port: 0,
  });
  try {
    const [e] = (await (await fetch(`${srv.url}/api/digest`)).json()) as DigestEntry[];

    assert.equal(e!.turn?.now?.kind, 'output');
    assert.equal(e!.turn?.now?.label, 'output');
    assert.equal(e!.turn?.now?.text, 'Done. The job publish is separate from the matrix.');
    assert.equal(e!.turn?.now?.ageFrom, null, 'a final answer is not something still running');
  } finally {
    srv.stop();
  }
});

// The tray shows only the sessions a person is sitting at, and it links no seedeep code — so the
// FACT it splits on has to be in the payload. Both species are asserted: an entry that always said
// `cli` would pass a test written on one of them and hide every headless run from nobody.
test('an entry names how the session was launched, for a client that shows only interactive ones', async () => {
  const path = writeSession(QUIET);
  const roster = [record(path), record(path, { sessionId: 'gate-0001', entrypoint: 'sdk-cli', subject: null })];
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => roster,
    port: 0,
  });
  try {
    const entries = (await (await fetch(`${srv.url}/api/digest`)).json()) as DigestEntry[];

    assert.deepEqual(
      entries.map((e) => [e.sessionId, e.entrypoint]),
      [
        [SID, 'cli'],
        ['gate-0001', 'sdk-cli'],
      ],
    );
  } finally {
    srv.stop();
  }
});

// The tray's rows say what the session is running on, at what effort, and where it stopped. None of
// that reached a polled client before.
test('an entry carries the model, the effort, and where the session stopped', async () => {
  const path = writeSession([
    typed('u1', 'first prompt', '2026-07-14T10:00:00.000Z'),
    toolUse('a1', 'toolu_01', 'Bash', { command: 'bun test' }, '2026-07-14T10:00:01.000Z'),
    toolResult('u2', 'toolu_01', 'ok', '2026-07-14T10:00:02.000Z'),
    finalAnswer('a2', 'Pushed 00cbf9b..35b1f46.', '2026-07-14T10:00:03.000Z'),
  ]);
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [record(path)],
    port: 0,
  });
  try {
    const [e] = (await (await fetch(`${srv.url}/api/digest`)).json()) as DigestEntry[];

    assert.equal(e!.main.model, 'claude-opus-4-8');
    // Claude Code writes `effort` on the assistant line's ROOT (not inside `message`) since
    // 2.1.212 — the fixture carries one, so the entry must too.
    assert.deepEqual(e!.turn?.efforts, ['high']);
    // Where a settled session stopped: the agent's last word, which is what an idle row shows —
    // and it outranks the Bash call, which happened BEFORE that word rather than since.
    assert.equal(e!.turn?.now?.kind, 'output');
    assert.equal(e!.turn?.now?.text, 'Pushed 00cbf9b..35b1f46.');
  } finally {
    srv.stop();
  }
});

// A turn's final answer can run to thousands of characters; the same cap the prompt gets applies,
// for the same reason — this payload is polled every second.
test('a long final answer is cut to its head', async () => {
  const path = writeSession([
    typed('u1', 'first prompt', '2026-07-14T10:00:00.000Z'),
    finalAnswer('a1', 'y'.repeat(5_000), '2026-07-14T10:00:01.000Z'),
  ]);
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [record(path)],
    port: 0,
  });
  try {
    const [e] = (await (await fetch(`${srv.url}/api/digest`)).json()) as DigestEntry[];
    assert.equal(e!.turn?.now?.text.length, PROMPT_HEAD);
  } finally {
    srv.stop();
  }
});

// The 13th session: a settled turn that DID something after its last word. Both surfaces now read
// the count there, where the tray used to go on showing the answer — Davide's call, which is why
// this test exists rather than an assertion that a settled turn always shows its output.
test('a settled turn that worked after its last word reads the count, not the answer', async () => {
  const path = writeSession([
    typed('u1', 'first prompt', '2026-07-14T10:00:00.000Z'),
    finalAnswer('a1', 'Done.', '2026-07-14T10:00:01.000Z'),
    toolUse('a2', 'toolu_01', 'Bash', { command: 'bun test' }, '2026-07-14T10:00:02.000Z'),
    toolResult('u2', 'toolu_01', 'ok', '2026-07-14T10:00:03.000Z'),
  ]);
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [record(path, { status: 'idle' })],
    port: 0,
  });
  try {
    const [e] = (await (await fetch(`${srv.url}/api/digest`)).json()) as DigestEntry[];

    assert.equal(e!.turn?.now?.kind, 'activity');
    assert.equal(e!.turn?.now?.text, 'Ran 1 shell command');
  } finally {
    srv.stop();
  }
});

test('a long prompt is cut to its head — an entry polled every second cannot carry 20 000 chars', async () => {
  const long = 'x'.repeat(5_000);
  const path = writeSession([
    typed('u1', long, '2026-07-14T10:00:00.000Z'),
    assistant('a1', 1200, '2026-07-14T10:00:01.000Z'),
  ]);
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [record(path)],
    port: 0,
  });
  try {
    const [e] = (await (await fetch(`${srv.url}/api/digest`)).json()) as DigestEntry[];
    // The reducer keeps the prompt whole (up to 20 000 chars) — the cut has to happen here, and
    // nothing else in the suite would notice if it stopped happening.
    assert.equal(e!.turn?.prompt.length, PROMPT_HEAD);
  } finally {
    srv.stop();
  }
});

test('a session that is not live is absent — the digest serves live sessions and nothing else', async () => {
  const path = writeSession(QUIET);
  const roster = [record(path, { isOpen: false, isActive: false })];
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => roster,
    port: 0,
  });
  try {
    assert.deepEqual(await (await fetch(`${srv.url}/api/digest`)).json(), []);
    // And asking for it by id says so, rather than serving a session that has stopped.
    assert.equal((await fetch(`${srv.url}/api/digest?sessionId=${SID}`)).status, 404);
  } finally {
    srv.stop();
  }
});

test('GET /api/digest?sessionId= adds the running-subagent list, and the count matches it', async () => {
  const path = writeSession(
    [typed('u1', 'review this', '2026-07-14T10:00:00.000Z'), spawn('a1', 'toolu_a', '2026-07-14T10:00:01.000Z')],
    { lines: [assistant('c1', 800, '2026-07-14T10:00:02.000Z')], toolUseId: 'toolu_a' },
  );
  const roster = [record(path)];
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => roster,
    port: 0,
  });
  try {
    const [listed] = (await (await fetch(`${srv.url}/api/digest`)).json()) as DigestEntry[];
    const one = (await (await fetch(`${srv.url}/api/digest?sessionId=${SID}`)).json()) as DigestEntry;

    // The two depths must agree on the count — a client prints it from the array form and the
    // rows from this one; if they could differ, opening a session would change its own number.
    assert.equal(one.subagents.running, listed!.subagents.running);
    assert.equal(one.subagents.running, 1);
    assert.equal(one.subagents.list?.length, 1);

    const a = one.subagents.list![0]!;
    assert.equal(a.agentId, AGENT);
    assert.equal(a.agentType, 'code-reviewer');
    // The launch description, not the type: a fan-out of eight `general-purpose` rows names
    // none of them.
    assert.equal(a.title, 'Review the parser');
    assert.equal(a.fill, 800);
    assert.equal(a.runId, null);
  } finally {
    srv.stop();
  }
});

// A Workflow run is the shape with the most room to go wrong: it takes ONE node in the tree
// while representing many agents, and its members carry a different field set from a direct
// spawn. Layout (Claude Code's own, read off real runs — same as tests/replay.test.ts):
// `<sid>/subagents/workflows/<runId>/` with a journal.jsonl and one transcript per agent.
function writeWorkflowSession(opts: { ended: boolean }): string {
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-digest-wf-'));
  const path = join(dir, `${SID}.jsonl`);
  const parent = [
    typed('u1', 'research this', '2026-07-14T10:00:00.000Z'),
    JSON.stringify({
      type: 'assistant',
      uuid: 'a1',
      timestamp: '2026-07-14T10:00:01.000Z',
      message: {
        role: 'assistant',
        model: 'claude-opus-4-8',
        usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 500, cache_creation_input_tokens: 0 },
        content: [
          { type: 'tool_use', id: 'toolu_w', name: 'Workflow', input: { name: 'deep-research', args: 'a question' } },
        ],
      },
    }),
    // The launch receipt is what carries the runId: without it the reducer cannot link the
    // spawn to its run, and the row stays an ordinary subagent. Shape from span-store.test.ts.
    JSON.stringify({
      type: 'user',
      uuid: 'u2',
      timestamp: '2026-07-14T10:00:02.000Z',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_w', content: [{ type: 'text', text: 'Workflow launched' }] },
        ],
      },
      toolUseResult: {
        status: 'async_launched',
        taskId: 'wf1',
        taskType: 'local_workflow',
        workflowName: 'deep-research',
        runId: 'wf1',
        summary: 'Deep research harness',
        transcriptDir: `/home/dev/session/subagents/workflows/wf1`,
      },
    }),
  ];
  if (opts.ended) {
    parent.push(
      JSON.stringify({
        type: 'queue-operation',
        operation: 'enqueue',
        sessionId: SID,
        timestamp: '2026-07-14T10:09:00.000Z',
        content: `<task-notification>\n<task-id>wf1</task-id>\n<tool-use-id>toolu_w</tool-use-id>\n<status>completed</status>\n<summary>run finished</summary>\n`,
      }),
    );
  }
  writeFileSync(path, parent.map((l) => l + '\n').join(''));

  const runDir = join(dir, SID, 'subagents', 'workflows', 'wf1');
  mkdirSync(runDir, { recursive: true });
  // w2 returned, w1 did not — the run's own record of who is still working.
  writeFileSync(
    join(runDir, 'journal.jsonl'),
    [
      JSON.stringify({ type: 'started', agentId: 'w1' }),
      JSON.stringify({ type: 'started', agentId: 'w2' }),
      JSON.stringify({ type: 'result', agentId: 'w2' }),
    ].join('\n') + '\n',
  );
  writeFileSync(join(runDir, 'agent-w1.jsonl'), assistant('x1', 200_000, '2026-07-14T10:00:03.000Z') + '\n');
  writeFileSync(join(runDir, 'agent-w2.jsonl'), assistant('x2', 5_000, '2026-07-14T10:00:04.000Z') + '\n');
  return path;
}

test('a running Workflow lists its still-working members, on the reducer scale', async () => {
  const path = writeWorkflowSession({ ended: false });
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [record(path)],
    port: 0,
  });
  try {
    const one = (await (await fetch(`${srv.url}/api/digest?sessionId=${SID}`)).json()) as DigestEntry;
    // A run is one ROW in the browser, but a count is not a list: the agents at work are the
    // members the journal has not seen return.
    assert.equal(one.subagents.running, 1);
    // The run's MEMBERS, not the one row it takes: `1` would be false about a fan-out.
    assert.equal(one.subagents.launched, 2);
    const a = one.subagents.list![0]!;
    assert.equal(a.agentId, 'w1');
    assert.equal(a.runId, 'wf1', 'a member must stay attributable to its run');
    // `pct` is the reducer's 0-100 integer, NOT a 0..1 ratio — one field cannot carry two
    // scales, and a client drawing a bar would read 0.2 as "0%" instead of 20%.
    assert.equal(a.pct, Math.round((a.fill / a.window) * 100));
    assert.ok(a.pct > 1, 'a member at 200k of its window is not sub-1%');
  } finally {
    srv.stop();
  }
});

test('a Workflow that ENDED reports nobody running, even with members the journal never closed', async () => {
  // Measured on a real run: 4 of 101 members never got their `result` line. Counting those
  // after the run is over prints agents at work for a workflow that finished.
  const path = writeWorkflowSession({ ended: true });
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [record(path)],
    port: 0,
  });
  try {
    const one = (await (await fetch(`${srv.url}/api/digest?sessionId=${SID}`)).json()) as DigestEntry;
    assert.equal(one.subagents.running, 0);
    assert.deepEqual(one.subagents.list, []);
    // ...and the run's agents are still on the session's record. This is the whole reason
    // `launched` exists: `running` says a finished run used nobody.
    assert.equal(one.subagents.launched, 2, 'a run that ended still spawned the agents it spawned');
  } finally {
    srv.stop();
  }
});

test('a subagent that RETURNED is still counted as launched', async () => {
  // The gap this closes: once the last agent comes back, `running` is 0 and the list is
  // empty, so a client reading only those says the session used no subagents at all.
  const path = writeSession(
    [
      typed('u1', 'review this', '2026-07-14T10:00:00.000Z'),
      spawn('a1', 'toolu_a', '2026-07-14T10:00:01.000Z'),
      toolResult('r1', 'toolu_a', 'the review', '2026-07-14T10:00:05.000Z'),
      finalAnswer('a2', 'reviewed', '2026-07-14T10:00:06.000Z'),
    ],
    { lines: [assistant('c1', 800, '2026-07-14T10:00:02.000Z')], toolUseId: 'toolu_a' },
  );
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [record(path)],
    port: 0,
  });
  try {
    const one = (await (await fetch(`${srv.url}/api/digest?sessionId=${SID}`)).json()) as DigestEntry;
    assert.equal(one.subagents.running, 0, 'it came back');
    assert.deepEqual(one.subagents.list, []);
    assert.equal(one.subagents.launched, 1);
    // Both depths carry it: the tray polls the ARRAY form and draws the figure from it, so a
    // count that only existed on the single-session route would not exist for the client that
    // needs it (the same mistake the subagent list was gated behind).
    const [listed] = (await (await fetch(`${srv.url}/api/digest`)).json()) as DigestEntry[];
    assert.equal(listed!.subagents.launched, 1);
  } finally {
    srv.stop();
  }
});

test('an unchanged digest costs a 304 — the poll a tray repeats every second', async () => {
  const path = writeSession(QUIET);
  const roster = [record(path)];
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => roster,
    port: 0,
  });
  try {
    const first = await fetch(`${srv.url}/api/digest`);
    const etag = first.headers.get('etag');
    assert.ok(etag, 'the digest must be conditionally cacheable, or a 1s poll re-sends it all');
    const second = await fetch(`${srv.url}/api/digest`, { headers: { 'if-none-match': etag! } });
    assert.equal(second.status, 304);
    assert.equal((await second.text()).length, 0);
  } finally {
    srv.stop();
  }
});

test('a session going non-live DROPS its tree — what comes back is re-seeded, not remembered', async () => {
  const path = writeSession(QUIET);
  let live = true;
  const roster = () => [record(path, live ? {} : { isOpen: false, isActive: false })];
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => roster(),
    port: 0,
  });
  try {
    const [first] = (await (await fetch(`${srv.url}/api/digest`)).json()) as DigestEntry[];
    assert.equal(first!.main.fill, 1200);

    live = false;
    assert.deepEqual(await (await fetch(`${srv.url}/api/digest`)).json(), []);

    // The file moves on while nothing is watching, and the watcher here feeds nothing. So the
    // fill below can ONLY be right if the tree was dropped and seeded again from the file: a
    // retained tree would still be reporting 1200, and a client would be reading a session
    // that stopped existing minutes ago. This is what makes the eviction observable.
    appendFileSync(
      path,
      [typed('u2', 'second prompt', '2026-07-14T10:05:00.000Z'), assistant('a2', 3000, '2026-07-14T10:05:01.000Z')]
        .map((l) => l + '\n')
        .join(''),
    );

    live = true;
    const back = (await (await fetch(`${srv.url}/api/digest`)).json()) as DigestEntry[];
    assert.equal(back.length, 1);
    assert.equal(back[0]!.main.fill, 3000);
    assert.equal(back[0]!.totals.turns, 2);
  } finally {
    srv.stop();
  }
});

test('a launch with nothing behind it is neither counted nor listed', async () => {
  // The spawn is on record but no child transcript ever appeared, so nothing — no type, no
  // tokens, no tool, no text — says an agent is at work. Measured 2026-07-29: this is exactly
  // what all 3 never-ended subagents in 910 ended sessions look like, and a real one leaves its
  // first trace within 0.30s of launch. `running` is the number a status row prints as fact.
  const path = writeSession([
    typed('u1', 'review this', '2026-07-14T10:00:00.000Z'),
    spawn('a1', 'toolu_a', '2026-07-14T10:00:01.000Z'),
  ]);
  const roster = [record(path)];
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => roster,
    port: 0,
  });
  try {
    const one = (await (await fetch(`${srv.url}/api/digest?sessionId=${SID}`)).json()) as DigestEntry;
    assert.equal(one.subagents.running, 0, 'a launch nobody has a record of is not an agent at work');
    assert.deepEqual(one.subagents.list, [], 'and it is not listed either');
    // Nor is it counted as one that ran: the same evidence bar, or the figure on an idle row
    // would claim a subagent the session has nothing to show for.
    assert.equal(one.subagents.launched, 0);
  } finally {
    srv.stop();
  }
});

// ── What the session is stopped on ──────────────────────────────────────────────────────
// `waitingFor` is Claude Code's own label and it is generic — measured, the PID file writes
// 'permission prompt' and nothing about WHICH tool. The band that prints the request verbatim
// needs the call, and only the reducer has it.
const toolUse = (uuid: string, id: string, name: string, input: unknown, ts: string) =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: ts,
    message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'tool_use', id, name, input }] },
  });

const BLOCKED = [
  typed('u1', 'clean the build dir', '2026-07-14T10:00:00.000Z'),
  assistant('a1', 1200, '2026-07-14T10:00:01.000Z'),
  toolUse('a2', 'toolu_b1', 'Bash', { command: 'rm -rf build' }, '2026-07-14T10:00:02.000Z'),
];

test('a blocked session names the call it is stopped on, and carries its own last activity', async () => {
  const path = writeSession(BLOCKED);
  const mtime = Date.parse('2026-07-14T10:00:02.000Z');
  const roster = [
    record(path, {
      status: 'waiting',
      waitingFor: 'permission prompt',
      waitingSince: 1_700_000_000_000,
      lastActivity: mtime,
    }),
  ];
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => roster,
    port: 0,
  });
  try {
    const [e] = (await (await fetch(`${srv.url}/api/digest`)).json()) as DigestEntry[];
    assert.deepEqual(e!.pendingTool, { name: 'Bash', arg: 'rm -rf build' });
    // The Idle band's whole content: a session with no activity has this and nothing else.
    assert.equal(e!.lastActivity, mtime);
  } finally {
    srv.stop();
  }
});

test('the same open call on a session that is NOT blocked is not a pending request', async () => {
  const path = writeSession(BLOCKED);
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [record(path)],
    port: 0,
  });
  try {
    const [e] = (await (await fetch(`${srv.url}/api/digest`)).json()) as DigestEntry[];
    // Same transcript, same open Bash — but the session is working, and a tool running is what
    // `turn.activity` already says. A field named `pendingTool` that fills up whenever anything
    // runs would make the amber band fire on ordinary work.
    assert.equal(e!.status, 'busy');
    assert.equal(e!.pendingTool, null);
  } finally {
    srv.stop();
  }
});

test('waiting on something the transcript does not carry names no tool, rather than the wrong one', async () => {
  // A plan approval raises the dialog with no `tool_use` behind it. The client falls back to
  // "waiting for you" — it must never be handed the last tool that happened to run.
  const path = writeSession(QUIET);
  const roster = [record(path, { status: 'waiting', waitingFor: 'permission prompt', waitingSince: 1 })];
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => roster,
    port: 0,
  });
  try {
    const [e] = (await (await fetch(`${srv.url}/api/digest`)).json()) as DigestEntry[];
    assert.equal(e!.waitingFor, 'permission prompt');
    assert.equal(e!.pendingTool, null);
  } finally {
    srv.stop();
  }
});

// A failed call, shaped as Claude Code writes it: `isApiErrorMessage`, a `<synthetic>` model, an
// all-zero usage block, an `error` category, and `content` as an ARRAY of text blocks — which is
// what all 47 real error lines carry. Only 18 of them carry `apiErrorStatus`.
const apiError = (uuid: string, text: string, ts: string) =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: ts,
    isApiErrorMessage: true,
    error: 'rate_limit',
    apiErrorStatus: 429,
    message: {
      role: 'assistant',
      model: '<synthetic>',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  });

test('an entry says the session is BROKEN, so the tray needs no reducer of its own', async () => {
  const path = writeSession([...QUIET, apiError('e1', 'API Error: 429 rate limit', '2026-07-14T10:00:03.000Z')]);
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [record(path)],
    port: 0,
  });
  try {
    const e = ((await (await fetch(`${srv.url}/api/digest`)).json()) as DigestEntry[])[0]!;
    assert.equal(e.error?.message, 'API Error: 429 rate limit');
    assert.equal(e.error?.status, '429');
    assert.equal(e.error?.agentId, null);
    assert.equal(e.error?.at, Date.parse('2026-07-14T10:00:03.000Z'));
  } finally {
    srv.stop();
  }
});

test('a session whose last call succeeded carries no error at all', async () => {
  // The clear is the whole reason the field can drive a red icon: a session that recovered must
  // stop being red without anyone acknowledging anything.
  const path = writeSession([
    ...QUIET,
    apiError('e1', 'API Error: 429 rate limit', '2026-07-14T10:00:03.000Z'),
    assistant('a2', 1400, '2026-07-14T10:00:04.000Z'),
  ]);
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [record(path)],
    port: 0,
  });
  try {
    const e = ((await (await fetch(`${srv.url}/api/digest`)).json()) as DigestEntry[])[0]!;
    assert.equal(e.error, null);
  } finally {
    srv.stop();
  }
});

// ── Background commands ─────────────────────────────────────────────────────────────────
// The two lines a background command writes, both taken from a real transcript: the RECEIPT (a
// tool_result whose `toolUseResult` carries `backgroundTaskId` — the only reliable marker) and, if
// its fate is ever told, a `queue-operation` whose content is a `<task-notification>` block. The
// prose in the receipt is Claude Code's, verbatim in shape; only the paths and ids are synthetic.
const bgLaunch = (uuid: string, toolUseId: string, taskId: string, ts: string) =>
  JSON.stringify({
    type: 'user',
    uuid,
    timestamp: ts,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: `Command running in background with ID: ${taskId}. Output is being written to: /tmp/seedeep-test/tasks/${taskId}.output. You will be notified when it completes.`,
        },
      ],
    },
    toolUseResult: { stdout: '', stderr: '', interrupted: false, isImage: false, backgroundTaskId: taskId },
  });
const bgNotification = (toolUseId: string, taskId: string, status: string, summary: string, ts: string) =>
  JSON.stringify({
    type: 'queue-operation',
    operation: 'enqueue',
    timestamp: ts,
    sessionId: SID,
    content: `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<output-file>/tmp/seedeep-test/tasks/${taskId}.output</output-file>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`,
  });

// Davide's rule, 2026-08-08: the tray is a glance surface, so it is told what is RUNNING and how
// many there have been — never a command that ended. What that one did is the portal's, one click
// away on the row. The count is what keeps the silence honest: without it, a session that ran two
// commands and was told about both would say nothing at all about either.
test('the digest sends the running commands and how many were launched, never one that ended', async () => {
  const path = writeSession([
    typed('u1', 'watch the build', '2026-07-14T10:00:00.000Z'),
    assistant('a1', 1200, '2026-07-14T10:00:01.000Z'),
    toolUse(
      'a2',
      'toolu_bg1',
      'Bash',
      { command: 'bun run build --watch', description: 'Watch the build' },
      '2026-07-14T10:00:02.000Z',
    ),
    bgLaunch('u2', 'toolu_bg1', 'bt1', '2026-07-14T10:00:02.500Z'),
    toolUse(
      'a3',
      'toolu_bg2',
      'Bash',
      { command: 'bun test --watch', description: 'Watch the tests' },
      '2026-07-14T10:00:03.000Z',
    ),
    bgLaunch('u3', 'toolu_bg2', 'bt2', '2026-07-14T10:00:03.500Z'),
    bgNotification(
      'toolu_bg2',
      'bt2',
      'failed',
      'Background command "Watch the tests" failed with exit code 7',
      '2026-07-14T10:05:00.000Z',
    ),
  ]);
  const srv = await startServer({ watcher: new EventEmitter(), discover: async () => [record(path)], port: 0 });
  try {
    const e = ((await (await fetch(`${srv.url}/api/digest`)).json()) as DigestEntry[])[0]!;
    assert.deepEqual(
      e.background.map((c) => c.command),
      ['Watch the build'],
      'the one that failed is not on the list a glance surface draws',
    );
    assert.equal(e.background[0]!.toolUseId, 'toolu_bg1', 'and the row can open its launch in the portal');
    assert.equal(e.background[0]!.since, Date.parse('2026-07-14T10:00:02.000Z'), 'the age ticks from the LAUNCH');
    // Both of them: the figure is the session's whole history, exactly like the subagent count.
    assert.equal(e.backgroundLaunched, 2);
  } finally {
    srv.stop();
  }
});

// A launch whose fate is never written stays `running` for as long as the session stays open —
// measured at 23 of 198 launches locally, and seen live as two rows counting past 40 minutes with
// nothing of either alive. The probe is the only thing that can close them, so what this pins is
// the WIRING: a verdict reaches the server's own tree by the one path every client already uses,
// and the row leaves the running list without ever acquiring a fate nobody stated.
test('a command the probe finds gone stops being one of the running, and is still counted', async () => {
  const path = writeSession([
    typed('u1', 'start the watcher', '2026-07-14T10:00:00.000Z'),
    assistant('a1', 1200, '2026-07-14T10:00:01.000Z'),
    toolUse(
      'a2',
      'toolu_bg9',
      'Bash',
      { command: 'bun run dev', description: 'Start the dev server' },
      '2026-07-14T10:00:02.000Z',
    ),
    bgLaunch('u2', 'toolu_bg9', 'bt9', '2026-07-14T10:00:02.500Z'),
  ]);
  const asked: string[] = [];
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [record(path)],
    port: 0,
    livenessMs: 20,
    // The machine's answer, decided by the test: the real prober would be asking THIS box's
    // process table about a task id that never ran on it.
    prober: {
      probe: async (pending) => {
        asked.push(...pending.map((p) => p.taskId));
        return pending.map((p) => ({ ...p, lastSeenAlive: '2026-07-14T10:04:02.500Z' }));
      },
    },
  });
  try {
    const read = async () => ((await (await fetch(`${srv.url}/api/digest`)).json()) as DigestEntry[])[0]!;
    // The first read is what CREATES the tree — nothing is probed for a session nobody asked
    // about, which is what keeps an idle process idle.
    const before = await read();
    assert.deepEqual(
      before.background.map((c) => c.command),
      ['Start the dev server'],
    );

    let after = before;
    for (let i = 0; i < 100 && after.background.length; i++) {
      await new Promise((r) => setTimeout(r, 20));
      after = await read();
    }
    assert.deepEqual(after.background, [], 'the probe answered, so it is no longer RUNNING');
    assert.equal(after.backgroundLaunched, 1, 'and it is still one of the commands this session ran');
    assert.ok(asked.includes('bt9'), 'the probe was asked about the task id, which is what names the file');

    // The half a live browser found missing: a client that seeds AFTER the verdict replays the
    // file, which will never carry it, and drew the row as running again — this feature's own bug
    // coming back through the one door nobody was watching. The replay has to hand it over.
    const replay = await (await fetch(`${srv.url}/api/replay?sessionId=${SID}`)).text();
    assert.ok(replay.includes('command-vanished'), 'a fresh replay carries the verdict');
    assert.ok(
      replay.indexOf('command-vanished') < replay.indexOf('replay-end'),
      'and before the end, so it lands on a tree that already holds the launch',
    );
    assert.ok(replay.includes('"lastSeenAlive":"2026-07-14T10:04:02.500Z"'), 'with the bound it was seen at');
  } finally {
    srv.stop();
  }
});
