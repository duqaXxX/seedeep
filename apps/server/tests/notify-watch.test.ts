import assert from 'node:assert/strict';
import { test } from 'node:test';
import { windowFor } from '../src/core/context-windows.ts';
import { createSessionTree } from '../src/core/session-tree.ts';
import type { DigestEntry } from '../src/server/digest.ts';
import { digestEntry } from '../src/server/digest.ts';
import { createNotifyWatch } from '../src/server/notify-watch.ts';
import { parseLine } from '../src/server/parser.ts';

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
  apiCalls?: number;
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
    // `apiCalls` defaults to 1 — a turn that ran. Zero is its own case (a turn that never called
    // the model is not a turn that finished), and a helper defaulting to zero would have made
    // every finish test pass for the wrong reason.
    turn: { state: o.turnState ?? 'done', apiCalls: o.apiCalls ?? 1, now: { text: o.nowText ?? '' } },
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
  // The tool's NAME, never its argument: a banner answers "do I get up", and the command is what
  // you go and read. It is also the text that would leave the machine on the webhook channel.
  assert.equal(wait!.body, 'Waiting for your approval — Bash');
  assert.ok(!wait!.body.includes('rm -rf build'), 'the command is not carried');
  assert.ok(!wait!.body.includes('\n'), 'one line');

  const w2 = createNotifyWatch();
  w2.step([entry({ id: 'b', status: 'busy' })]);
  const [named] = w2.step([entry({ id: 'b', status: 'waiting', waitingFor: 'input needed' })]);
  assert.equal(named!.body, 'Waiting for your answer in the terminal');

  const w3 = createNotifyWatch();
  w3.step([entry({ id: 'c', status: 'busy' })]);
  const [failed] = w3.step([
    entry({ id: 'c', status: 'idle', error: { agentId: 'sub-1', message: 'API Error: 529 Overloaded' } }),
  ]);
  assert.equal(failed!.body, "A subagent's API call failed");
  assert.ok(!failed!.body.includes('529'), "Claude Code's message is the panel's to show");
});

test('a finished turn says Turn finished, and not what the turn did', () => {
  // `Finished` said the session had ended; it had not. The turn closed and the session became the
  // user's again, which is the event — and the event is the whole message. What the turn actually
  // did is the Idle band's account, three words away in the panel.
  const w = createNotifyWatch();
  w.step([entry({ id: 'a', status: 'busy' })]);
  const [a] = w.step([entry({ id: 'a', status: 'idle', nowText: 'Added the retry and ran the tests.' })]);
  assert.equal(a!.body, 'Turn finished');
});

test('a finished turn with nothing on record says exactly the same thing', () => {
  const w = createNotifyWatch();
  w.step([entry({ id: 'a', status: 'busy' })]);
  assert.equal(w.step([entry({ id: 'a', status: 'idle', nowText: '' })])[0]!.body, 'Turn finished');
});

// The report that opened this: a banner saying only `Turn finished`, arriving long after the
// session had stopped. Esc pressed BEFORE the first reply leaves nothing in the transcript — no
// marker, no `interruptedMessageId`, no assistant line — so the turn is never marked interrupted,
// and the finish was announced when liveness read from the process finally said idle.
test('a turn that never called the model announces nothing', () => {
  const w = createNotifyWatch();
  w.step([entry({ id: 'a', status: 'busy' })]);
  assert.deepEqual(
    w.step([entry({ id: 'a', status: 'idle', apiCalls: 0 })]),
    [],
    'a turn that never started did not finish',
  );
});

test('one call is enough to have been a turn', () => {
  // The rule must not swallow a real, quiet turn: work with nothing said still ends with the
  // session becoming yours again, which is the event.
  const w = createNotifyWatch();
  w.step([entry({ id: 'a', status: 'busy' })]);
  const [a] = w.step([entry({ id: 'a', status: 'idle', apiCalls: 1, nowText: '' })]);
  assert.equal(a!.body, 'Turn finished');
});

test('a zero-call turn still reports what needs you and what failed', () => {
  // Only the FINISH is suppressed. A session stopped on a prompt, or one whose call failed, is
  // news whatever the turn did — and the failure case is the one that ships on for a reason.
  const w = createNotifyWatch();
  w.step([entry({ id: 'a', status: 'busy' })]);
  const [wait] = w.step([entry({ id: 'a', status: 'waiting', waitingFor: 'permission prompt', apiCalls: 0 })]);
  assert.equal(wait!.kind, 'needsYou');

  const w2 = createNotifyWatch();
  w2.step([entry({ id: 'b', status: 'busy' })]);
  const [failed] = w2.step([
    entry({ id: 'b', status: 'idle', apiCalls: 0, error: { agentId: null, message: 'API Error' } }),
  ]);
  assert.equal(failed!.kind, 'fails');
});

// ── from raw jsonl, through the real parser and reducer ──────────────────────

// The hand-built entries above can only ever test what we BELIEVE a session looks like. This one
// starts from the lines Claude Code actually writes, so a wrong belief about the transcript fails
// here instead of shipping. Both shapes of Esc are covered, because they are different on disk.
test('Esc produces no finish, in both shapes the transcript writes', () => {
  const ctx = { sessionId: 's1', root: 'cli' as const, agentId: null };
  const at = (n: number) => new Date(Date.UTC(2026, 7, 11, 21, n)).toISOString();
  const typed = (uuid: string, text: string, minute: number) =>
    JSON.stringify({
      type: 'user',
      uuid,
      timestamp: at(minute),
      origin: { kind: 'human' },
      promptSource: 'typed',
      message: { role: 'user', content: text },
      sessionId: 's1',
    });
  // Shaped as the real corpus writes it (measured 2026-08-11): content is an ARRAY carrying the
  // literal marker, there is no `origin`, and `interruptedMessageId` names the message cut off.
  const marker = (uuid: string, minute: number, cut: string) =>
    JSON.stringify({
      type: 'user',
      uuid,
      timestamp: at(minute),
      message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
      interruptedMessageId: cut,
      sessionId: 's1',
    });
  const assistant = (uuid: string, minute: number) =>
    JSON.stringify({
      type: 'assistant',
      uuid,
      timestamp: at(minute),
      requestId: `req-${uuid}`,
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        content: [{ type: 'text', text: 'working on it' }],
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
      sessionId: 's1',
    });

  const digest = (lines: string[], status: 'busy' | 'idle'): DigestEntry => {
    const tree = createSessionTree({ windowFor, mainModel: 'claude-opus-5' });
    let seq = 0;
    for (const l of lines) for (const e of parseLine(l, { ...ctx, seq: seq++ })) tree.apply(e);
    return digestEntry(
      {
        sessionId: 's1',
        project: 'atlas',
        model: 'claude-opus-5',
        lastActivity: Date.now(),
        isActive: true,
        isOpen: true,
        status,
        waitingFor: null,
        waitingSince: null,
        subject: 'add a retry to the uploader',
        entrypoint: null,
        root: 'cli',
        path: '/synthetic/s1.jsonl',
      },
      tree.snapshot(),
      { now: Date.now(), wordSeenAt: null },
    );
  };
  const announced = (lines: string[]): string[] => {
    const w = createNotifyWatch();
    w.step([digest(lines, 'busy')]);
    return w.step([digest(lines, 'idle')]).map((a) => a.kind);
  };

  // SILENT: Esc before the first reply. Claude Code writes NOTHING — this is the whole transcript.
  const silent = [typed('u1', 'first prompt', 3), typed('u2', 'first prompt', 6)];
  assert.deepEqual(announced(silent), [], 'the reported banner: a turn that never ran');
  assert.equal(digest(silent, 'idle').turn?.apiCalls, 0, 'and nothing on disk marks it interrupted');

  // MARKED: Esc after a reply. The marker line carries `interruptedMessageId`, which the parser
  // turns into `turn-interrupted` BEFORE the next turn opens.
  const markedLines = [
    typed('u1', 'first prompt', 3),
    assistant('a1', 4),
    marker('u2', 5, 'a1'),
    typed('u3', 'again', 6),
  ];
  assert.ok(!announced(markedLines).includes('finishes'), 'the shape that was already covered');

  // A real turn still announces — the rule must not swallow the event it exists for.
  assert.ok(announced([typed('u1', 'first prompt', 3), assistant('a1', 4)]).includes('finishes'));
});
