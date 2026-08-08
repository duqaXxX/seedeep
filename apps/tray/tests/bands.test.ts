import assert from 'node:assert/strict';
import { after, test } from 'node:test';
// The rule for what counts as a wait on the human lives on the server; the tray owns a copy of it
// because it cannot import one. This test is what keeps the copy honest.
import { isWorking, pendingInput } from '../../server/src/client/sessions.ts';
// Type-only, and only in the test: the tray links no seedeep code, so its copy of the digest's
// shape can drift from the server's without anything noticing. The assignment below is what makes
// a renamed or removed field fail the typecheck instead of the panel.
import type { DigestEntry as ServerEntry } from '../../server/src/server/digest.ts';
// Borrowed, like the connection screen's test: a TEST harness, never shipped code. A second
// faithful fake DOM would be a second one to keep true.
import { fakeDoc, findByClass, textOf } from '../../server/tests/fake-dom.ts';
import {
  type BandActions,
  bandOf,
  type DigestEntry,
  fold,
  quiet,
  type Row,
  renderLive,
  retain,
  stopwatch,
} from '../ui/bands.ts';
import type { Status } from '../ui/connection.ts';

const prevDoc = (globalThis as { document?: unknown }).document;
after(() => {
  (globalThis as { document?: unknown }).document = prevDoc;
});

// The whole reason the tray can declare its own interface: if the server's entry stops being
// assignable to it, this line stops compiling.
const SHAPES_AGREE: DigestEntry = {} as ServerEntry;
void SHAPES_AGREE;

const CONNECTED = {
  kind: 'connected',
  baseUrl: 'https://box.local:44842',
  fingerprint: 'AA:BB',
} satisfies Extract<Status, { kind: 'connected' }>;

/** A digest entry with everything at rest, so each test states only the field it is about. */
function entry(over: Partial<DigestEntry> = {}): DigestEntry {
  return {
    sessionId: 's-1',
    project: 'atlas',
    subject: 'add a retry to the uploader',
    status: 'busy',
    waitingFor: null,
    waitingSince: null,
    lastActivity: Date.now(),
    pendingTool: null,
    main: { fill: 48_000, window: 200_000, pct: 24, estimated: false, model: 'claude-opus-5' },
    turn: {
      state: 'live',
      prompt: 'add a retry to the uploader',
      efforts: ['high'],
      now: null,
    },
    error: null,
    subagents: { running: 0, launched: 0, list: [] },
    background: [],
    backgroundLaunched: 0,
    ...over,
  };
}

/** A turn at rest, so a test states only the field it is about. */
function turn(over: Partial<NonNullable<DigestEntry['turn']>> = {}): DigestEntry['turn'] {
  return { ...entry().turn!, ...over };
}

/** The main block at rest, for the tests that are about the context figure. */
function main(over: Partial<DigestEntry['main']> = {}): DigestEntry['main'] {
  return { ...entry().main, ...over };
}

const live = (entries: DigestEntry[]): Row[] => entries.map((e) => ({ entry: e, ended: false }));

/** Render rows and record every session a click handed over, and whether settings was asked for. */
function mount(rows: readonly Row[], error?: string, now?: number) {
  (globalThis as { document?: unknown }).document = fakeDoc();
  const opened: string[] = [];
  const asked = { settings: 0 };
  const actions: BandActions = {
    open: (id) => opened.push(id),
    settings: () => (asked.settings += 1),
  };
  return { node: renderLive(rows, CONNECTED, actions, error, now) as unknown, opened, asked };
}

const find = (node: unknown, cls: string) => findByClass(node, cls);
const text = (node: unknown) => textOf(node);

// The rule is the server's `pendingInput`, and the tray holds a copy because it cannot import one.
// Claude Code writes `status: 'waiting'` for EVERY open dialog — the model picker included — so a
// band taken from the status alone would file "the user opened a menu" under Needs you, and the
// icon would go amber with it (`poll.rs` holds the third copy, with its own test).
test('the waiting band is the server’s rule, label for label', () => {
  for (const waitingFor of [
    'permission prompt',
    'input needed',
    'dialog open',
    'sandbox request',
    'worker request',
    null,
  ]) {
    const e = entry({ status: 'waiting', waitingFor });
    const server = pendingInput({ status: 'waiting', waitingFor }) !== null;
    assert.equal(
      bandOf(e) === 'waiting',
      server,
      `${waitingFor}: the tray and the server disagree about whether this waits on the user`,
    );
  }
  assert.equal(bandOf(entry({ status: 'busy' })), 'working');
  assert.equal(bandOf(entry({ status: 'idle' })), 'idle');
  // No status at all is the case where Claude Code's process file is unavailable. Idle, not
  // working: a band is a claim, and there is nothing here to base the louder one on.
  assert.equal(bandOf(entry({ status: null })), 'idle');
});

// `shell` is what Claude Code writes while a command the session launched in the background is
// still running and the turn is over. Read as "not busy" it dropped the row to Idle and let it jump
// back to Working when the command ended — the bug this pins. The server's own predicate is the
// reference, so the two cannot drift apart.
test('a session running a background command is working, on both the tray’s rule and the server’s', () => {
  for (const status of ['busy', 'shell', 'idle', 'waiting', null] as const) {
    assert.equal(
      bandOf(entry({ status, waitingFor: null })) === 'working',
      isWorking({ status }),
      `${status}: the tray and the server disagree about whether this session is working`,
    );
  }
});

// The locked rule, and the reason the accordion layout was rejected: rows that reshuffle under the
// cursor make a click land on a session the user was not looking at. The payload's own order is the
// roster's, which re-sorts as sessions work.
test('a session keeps its place however the payload is ordered', () => {
  const a = entry({ sessionId: 'a', project: 'atlas' });
  const b = entry({ sessionId: 'b', project: 'borealis' });
  const c = entry({ sessionId: 'c', project: 'cinder' });

  const first = retain([], [a, b, c]);
  const reordered = retain(first, [c, a, b]);

  assert.deepEqual(
    reordered.map((row) => row.entry.sessionId),
    ['a', 'b', 'c'],
  );
  // And a session that appears later joins the end rather than pushing the list around.
  const d = entry({ sessionId: 'd', project: 'delta' });
  assert.deepEqual(
    retain(reordered, [d, b, a, c]).map((row) => row.entry.sessionId),
    ['a', 'b', 'c', 'd'],
  );
});

// The server drops a session from the digest the moment it stops being live. A row vanishing while
// someone is reading it reads as a bug, so the client remembers — and it keeps the session's own
// last entry, which is also what keeps it in the band it was in.
test('a session that ends is kept, marked, and does not move', () => {
  const working = entry({ sessionId: 'a', status: 'busy' });
  const other = entry({ sessionId: 'b', status: 'idle' });

  const rows = retain(retain([], [working, other]), [other]);

  assert.deepEqual(
    rows.map((r) => [r.entry.sessionId, r.ended]),
    [
      ['a', true],
      ['b', false],
    ],
  );
  assert.equal(bandOf(rows[0]!.entry), 'working', 'an ended session must not jump bands');
  const { node } = mount(rows);
  assert.equal(text(find(node, 'row-ended')[0]), 'ended', 'nothing says it ended');
  assert.equal(find(node, 'row--ended').length, 1);

  // A session that comes back is not history any more — the same id returning must clear the mark.
  assert.deepEqual(
    retain(rows, [working, other]).map((r) => r.ended),
    [false, false],
  );
});

// The promise is made to somebody LOOKING at the screen. With the popover closed there is nobody, and
// honouring it anyway leaves a session that ended overnight sitting there marked `ended` the next
// time the panel is opened — which is not the rule but its shadow. The webview cannot answer "am I
// visible" (it keeps running while the window is hidden), so the flag comes from Rust.
test('a session that ends while nobody is looking is not kept', () => {
  const a = entry({ sessionId: 'a' });
  const b = entry({ sessionId: 'b' });
  const watching = fold([], { entries: [a, b], open: true });

  // It ends while the panel is open: kept, and still there on the next tick.
  const kept = fold(watching, { entries: [b], open: true });
  assert.deepEqual(
    kept.map((r) => [r.entry.sessionId, r.ended]),
    [
      ['a', true],
      ['b', false],
    ],
  );

  // The panel closes, and the ticks keep coming: nothing is kept, and the mark does not survive to
  // the next open either.
  const closed = fold(kept, { entries: [b], open: false });
  assert.deepEqual(
    closed.map((r) => r.entry.sessionId),
    ['b'],
  );
  assert.deepEqual(
    fold(closed, { entries: [b], open: true }).map((r) => r.ended),
    [false],
  );
});

test('a reading that could not be made draws no rows at all', () => {
  const shown = fold([], { entries: [entry()], open: true });

  assert.deepEqual(fold(shown, { entries: null, open: true }), []);
});

// This band exists so the user can answer without going to the terminal first, and "a tool is
// waiting" does not tell them whether to say yes. The command is capped at 200 characters by the
// server, so it is printed whole.
test('the needs-you row prints the request verbatim', () => {
  const command = 'git push --force-with-lease origin main # after rewriting the last 3 commits';
  const { node } = mount(
    live([
      entry({
        status: 'waiting',
        waitingFor: 'permission prompt',
        waitingSince: Date.now() - 134_000,
        pendingTool: { name: 'Bash', arg: command },
      }),
    ]),
  );

  assert.equal(text(find(node, 'row-arg')[0]), command);
  assert.match(text(find(node, 'row-ask')[0]), /^Waiting for your approval — Bash$/);
  // The seconds are the point: two minutes of waiting is a different fact from thirty.
  assert.equal(text(find(node, 'row-age')[0]), 'Stopped 2m 14s ago');
});

// The portal's own words for the same event (`graph.ts`), because two surfaces of one product
// describing the same thing differently is how a user learns to trust neither.
test('a question is not called an approval', () => {
  const { node } = mount(
    live([
      entry({
        status: 'waiting',
        waitingFor: 'input needed',
        pendingTool: { name: 'AskUserQuestion', arg: 'Which layout?' },
      }),
    ]),
  );

  assert.match(text(find(node, 'row-ask')[0]), /Waiting for your answer/);

  // And when the transcript has not named the call, the row says where to look instead of naming
  // a tool it does not know.
  const blind = mount(live([entry({ status: 'waiting', waitingFor: 'permission prompt', pendingTool: null })]));
  assert.equal(text(find(blind.node, 'row-ask')[0]), 'Waiting for your approval in the terminal');
  assert.equal(find(blind.node, 'row-arg').length, 0);
});

// The master-detail layout was rejected because a collapsed session showed nothing at all. Every
// row, in every band, has to say which session it is.
test('no row is collapsed to nothing', () => {
  const rows = live([
    entry({ sessionId: 'a', project: 'atlas', status: 'waiting', waitingFor: 'permission prompt' }),
    entry({ sessionId: 'b', project: 'borealis', status: 'busy' }),
    // The awkward one: idle, no subject, nothing running, no activity — the entry with the least
    // in it, which is exactly the row a layout is most likely to draw empty.
    entry({ sessionId: 'c', project: 'cinder', status: 'idle', subject: null, turn: null }),
  ]);

  const { node } = mount(rows);
  const drawn = find(node, 'row');
  assert.equal(drawn.length, 3);
  for (const [i, row] of drawn.entries()) {
    const shown = text(row);
    assert.ok(shown.trim().length > 0, `row ${i} drew nothing`);
    assert.match(shown, /atlas|borealis|cinder/, `row ${i} does not name its project`);
  }
});

// The idle pill was locked to a duration and REFUSED to say where the session stopped; that rule was
// revoked after using it — a project name, a duration and a bare percentage answered nothing.
// What it says now is the agent's own last words, which is the fact a settled session has: its
// activity line is null in 12 real sessions out of 13, because a turn's last word IS its answer.
test('an idle row says where the session stopped, in the agent’s own words', () => {
  const { node } = mount(
    live([
      entry({
        status: 'idle',
        project: 'atlas',
        subject: 'rewrite the parser',
        lastActivity: Date.now() - 14 * 60_000,
        turn: turn({
          state: 'done',
          prompt: 'rewrite the parser',
          now: { kind: 'output', label: 'output', text: 'Pushed 00cbf9b..35b1f46.', ageFrom: null },
        }),
        main: main({ fill: 124_000, pct: 62 }),
      }),
    ]),
  );

  assert.equal(text(find(node, 'row-project')[0]), 'atlas');
  // The project used to be alone on its line, which is what made it read as an unexplained label.
  assert.equal(text(find(node, 'row-subject')[0]), 'rewrite the parser');
  assert.equal(text(find(node, 'row-quiet')[0]), '14m');
  // Labelled `output`, and the label is part of the line: the working row carries a quote of its
  // own (the prompt), and two unlabelled italic blocks read as one paragraph.
  assert.equal(text(find(node, 'row-say')[0]), 'outputPushed 00cbf9b..35b1f46.');
  assert.equal(text(find(node, 'say-lbl')[0]), 'output');
  assert.equal(find(node, 'row-say--out').length, 1, 'a settled turn’s words are the settled voice');
  assert.equal(text(find(node, 'ctx-num')[0]), '124.0k / 200.0k');
});

// The row draws what `turn.now` says and does not second-guess it: the precedence and the labels
// are the server's `nowLine`, the same function the portal's panel calls. What the row still owns is
// the VOICE — a settled turn's words must not be drawn in the live colour.
test('a row draws the NOW it was given, in the voice the turn’s state calls for', () => {
  const working = mount(
    live([
      entry({
        turn: turn({ now: { kind: 'intent', label: 'now', text: 'Reading the release workflow', ageFrom: null } }),
      }),
    ]),
  );
  assert.equal(text(find(working.node, 'say-lbl')[0]), 'now');
  assert.equal(text(find(working.node, 'row-say')[0]), 'nowReading the release workflow');
  assert.equal(find(working.node, 'row-say--out').length, 0);

  const answered = mount(
    live([
      entry({
        status: 'idle',
        turn: turn({ state: 'done', now: { kind: 'output', label: 'output', text: 'Pushed it.', ageFrom: null } }),
      }),
    ]),
  );
  assert.equal(text(find(answered.node, 'row-say')[0]), 'outputPushed it.', 'the answer takes over');
  assert.equal(find(answered.node, 'row-say--out').length, 1, 'a settled turn’s words are the settled voice');
});

// seedeep's own count is not the agent talking, so it does not wear the agent's italic — the same
// distinction the portal makes with `.nowtext.plain`. The row it replaced (the itemised call line)
// was not italic either, so keeping the voice would have made the swap read as a quote.
test('the count of what a turn did is drawn in seedeep’s voice, not the agent’s', () => {
  const { node } = mount(
    live([
      entry({
        turn: turn({
          now: { kind: 'activity', label: 'now', text: 'Read 12 files, ran 3 shell commands', ageFrom: null },
        }),
      }),
    ]),
  );

  assert.equal(text(find(node, 'row-say')[0]), 'nowRead 12 files, ran 3 shell commands');
  assert.equal(find(node, 'row-say--plain').length, 1);
});

// The same rule for the state that says a turn is working with nothing of its own to quote. It is
// the case that broke the old test: `plain` enumerated seedeep's kinds, so a kind added to nowLine
// defaulted into the AGENT's italic — the tray attributing to Claude a sentence seedeep wrote.
test('a delegated turn’s line is seedeep’s voice too, never the agent’s italic', () => {
  const { node } = mount(
    live([
      entry({
        turn: turn({
          now: { kind: 'working', label: 'now', text: '/code-review is running in the background', ageFrom: null },
        }),
      }),
    ]),
  );

  assert.equal(text(find(node, 'row-say')[0]), 'now/code-review is running in the background');
  assert.equal(find(node, 'row-say--plain').length, 1, 'seedeep counting is never the agent talking');
});

// A row cannot look busy while its session is not — the promise `now()` documents. `turn.state`
// alone does not keep it: a turn whose end marker never came stays `live` forever (measured: 1 of
// 247 settled sessions), and such a session sits in *Idle* with an active-coloured NOW line.
test('an Idle session’s NOW line is the settled voice, whatever its last turn still claims', () => {
  const stuck = entry({
    status: 'idle',
    turn: turn({ state: 'live', now: { kind: 'activity', label: 'now', text: 'Read 3 files', ageFrom: null } }),
  });
  const { node } = mount(live([stuck]));
  assert.equal(find(node, 'row-say--out').length, 1, 'an idle session cannot draw a live NOW');
});

// The age is the portal's chip: it times the call that is running, and the server sends the instant
// rather than the age itself, which would expire in flight.
test('a NOW with an age shows it, ticking from the instant the server sent', () => {
  const now = 1_000_000;
  const { node } = mount(
    live([
      entry({
        turn: turn({ now: { kind: 'activity', label: 'now', text: 'Ran 1 shell command', ageFrom: now - 12_000 } }),
      }),
    ]),
    undefined,
    now,
  );
  assert.deepEqual(find(node, 'say-age').map(text), ['12s']);

  // Null for 78.6% of a group's life — Claude Code writes a call's line ~3.6s after it starts, so
  // most calls are never observed in flight. Nothing to measure, nothing said.
  const untimed = mount(
    live([
      entry({ turn: turn({ now: { kind: 'activity', label: 'now', text: 'Ran 1 shell command', ageFrom: null } }) }),
    ]),
  );
  assert.equal(find(untimed.node, 'say-age').length, 0);
});

// A turn that has neither narrated nor answered nor done anything has nothing to say, and an empty
// labelled line would state that the agent said nothing — not the same as not having spoken yet.
test('a turn with no NOW draws no line for it', () => {
  const { node } = mount(live([entry({ turn: turn({ now: null }) })]));

  assert.equal(find(node, 'row-say').length, 0);
  assert.equal(find(node, 'row-ctx').length, 1, 'the context block is not what went away');
});

// A turn that was interrupted has no result, and the row must then say nothing rather than quote
// an empty string — an empty quote reads as an agent that answered with silence.
test('an idle row with no final answer quotes nothing', () => {
  const { node } = mount(live([entry({ status: 'idle', turn: turn({ now: null }) })]));

  assert.equal(find(node, 'row-line').length, 0);
  assert.equal(find(node, 'row-ctx').length, 1, 'the context block is not the thing that went away');
});

// The tray's differentiator against every other menu-bar client, so it is drawn as a proportion and
// not only as a number — and it says when the window it is measured against is a guess.
test('the fill is a bar, a figure, and honest about an estimate', () => {
  const { node } = mount(live([entry({ main: main({ pct: 24 }) })]));
  assert.equal(find(node, 'fill-in')[0].style.width, '24%');
  assert.equal(text(find(node, 'row-pct')[0]), '24%');

  const guessed = mount(live([entry({ main: main({ pct: 8, estimated: true }) })]));
  assert.equal(text(find(guessed.node, 'row-pct')[0]), '~8%');

  // A session can outgrow the window it was measured against; a bar drawn past its own track reads
  // as a rendering fault rather than as a full context.
  const over = mount(live([entry({ main: main({ pct: 140 }) })]));
  assert.equal(find(over.node, 'fill-in')[0].style.width, '100%');
  assert.equal(text(find(over.node, 'row-pct')[0]), '140%');
});

// A bare `34%` shipped for two releases and never said what it measured. The figure and
// its units are the portal's Context card's, so the two surfaces state one fact one way.
test('the context block names itself and spells out the figure', () => {
  const { node } = mount(live([entry({ main: main({ fill: 343_021, window: 1_000_000, pct: 34 }) })]));

  assert.equal(text(find(node, 'ctx-lbl')[0]), 'Context');
  assert.equal(text(find(node, 'ctx-num')[0]), '343.0k / 1.0M');
  assert.equal(text(find(node, 'row-pct')[0]), '34%');
});

// Which model, at which effort — the two facts the row could not answer before.
test('a row names its model and its effort, and asserts neither when the log is silent', () => {
  const { node } = mount(live([entry()]));
  assert.equal(text(find(node, 'meta-model')[0]), 'Opus 5');
  assert.equal(text(find(node, 'meta-effort')[0]), 'high');

  // Claude Code wrote no `effort` before 2.1.212, and a model may have none to configure. An empty
  // list means "the transcript does not say", which is not ours to render as a dash.
  const silent = mount(live([entry({ turn: turn({ efforts: [] }) })]));
  assert.equal(find(silent.node, 'meta-effort').length, 0);
  assert.equal(text(find(silent.node, 'meta-model')[0]), 'Opus 5');

  // An id seedeep does not recognise is shown as written rather than mangled into a label.
  const odd = mount(live([entry({ main: main({ model: '<synthetic>' }) })]));
  assert.equal(text(find(odd.node, 'meta-model')[0]), 'synthetic');
});

// The row's answer to "this session has stopped talking — is it done?". Asserted in ALL THREE
// bands, because each has its own row builder and the three drifted once already: the waiting row
// was written without this line, and the browser's chip had no such exception — two surfaces
// describing one session differently, at the moment the user is deciding something.
test('a row says which background commands it is still waiting on, in any band', () => {
  const now = 1_000_000;
  const bg = [
    { toolUseId: 't1', command: 'bun run dev --watch', since: now - 252_000 },
    { toolUseId: 't2', command: 'tail -f logs/app.log', since: now - 9_000 },
  ];

  const working = mount(live([entry({ background: bg })]), undefined, now);
  assert.deepEqual(find(working.node, 'bg-cmd').map(text), ['bun run dev --watch', 'tail -f logs/app.log']);
  assert.deepEqual(find(working.node, 'bg-age').map(text), ['4m 12s', '9s']);

  // Idle: nothing else on that row would say the session is not done.
  const idle = mount(live([entry({ status: 'idle', background: bg.slice(0, 1) })]), undefined, now);
  assert.deepEqual(find(idle.node, 'bg-cmd').map(text), ['bun run dev --watch']);

  // Needs you: the row is about the question, and this is what the answer may depend on.
  const waiting = mount(
    live([entry({ status: 'waiting', waitingFor: 'permission prompt', background: bg.slice(0, 1) })]),
    undefined,
    now,
  );
  assert.equal(find(waiting.node, 'row--wait').length, 1, 'this really is the Needs-you row');
  assert.deepEqual(find(waiting.node, 'bg-cmd').map(text), ['bun run dev --watch']);

  // Nothing running, nothing said — never an empty line claiming something is.
  assert.equal(find(mount(live([entry()])).node, 'row-bg').length, 0);
});

// The other half of the same question, answered the other way (Davide, 2026-08-08): what a command
// that ENDED did is the portal's, and the tray says only how many there have been. The count is
// what makes that honest — without it a session that ran four commands and was told about all four
// would show nothing at all, which is the disappearance this whole finding started from.
test('a session that has launched commands says how many, whatever is still running', () => {
  const now = 1_000_000;
  const bg = [{ toolUseId: 't1', command: 'bun run dev', since: now - 9_000 }];
  const working = mount(live([entry({ backgroundLaunched: 4, background: bg })]), undefined, now);
  assert.equal(text(find(working.node, 'row-cmds')[0]), 'Commands4 launched');
  assert.deepEqual(find(working.node, 'bg-cmd').map(text), ['bun run dev'], 'the running one is still its own row');

  // The point of the count: every command is over, and the row still says the session ran some.
  const idle = mount(live([entry({ status: 'idle', backgroundLaunched: 4, background: [] })]), undefined, now);
  assert.equal(text(find(idle.node, 'row-cmds')[0]), 'Commands4 launched');
  assert.equal(find(idle.node, 'row-bg').length, 0, 'and draws no row for a command that is over');

  // A session that never launched one is not told what it is not.
  assert.equal(find(mount(live([entry()]), undefined, now).node, 'row-cmds').length, 0);
});

// An older server still sends the ended ones. Drawn, they would wear the at-work dot and tick a
// stopwatch on something that is dead — the one claim this row must never make.
test('an ended command from an older server is dropped, not drawn as running', () => {
  const now = 1_000_000;
  const { node } = mount(
    live([
      entry({
        status: 'idle',
        backgroundLaunched: 2,
        background: [
          { toolUseId: 't1', command: 'Tail the transcript', since: now - 252_000 },
          { toolUseId: 't2', command: 'Run the capture', since: now - 900_000, state: 'failed' as const },
        ],
      }),
    ]),
    undefined,
    now,
  );

  assert.deepEqual(find(node, 'bg-cmd').map(text), ['Tail the transcript']);
  assert.deepEqual(find(node, 'bg-age').map(text), ['4m 12s']);
});

test('a working row names the agents at work, and says nothing when none are', () => {
  const { node } = mount(
    live([
      entry({
        subagents: {
          running: 2,
          launched: 2,
          list: [
            { title: 'Review: bugs in the new code', model: 'claude-sonnet-4-6', pct: 62, runId: null },
            { title: 'Run tests and typecheck', model: 'claude-haiku-4-5-20251001', pct: 12, runId: null },
          ],
        },
      }),
    ]),
  );

  assert.deepEqual(find(node, 'agent-title').map(text), ['Review: bugs in the new code', 'Run tests and typecheck']);
  assert.deepEqual(find(node, 'agent-model').map(text), ['Sonnet 4.6', 'Haiku 4.5']);
  assert.deepEqual(find(node, 'agent-pct').map(text), ['62%', '12%']);

  assert.equal(find(mount(live([entry()])).node, 'agent').length, 0, 'nothing running, nothing said');
});

// With only the running list, a session's subagent use vanished the moment the last one
// returned — an idle row said nothing at all about the twelve agents that had just run.
test('the launched count is drawn on Working and on Idle, and survives the last return', () => {
  const done = { subagents: { running: 0, launched: 12, list: [] } } satisfies Partial<DigestEntry>;

  const working = mount(live([entry({ ...done, status: 'busy' })]));
  assert.deepEqual(find(working.node, 'subs-num').map(text), ['12 launched']);
  assert.equal(find(working.node, 'agent').length, 0, 'they are all back — the figure is the only trace left');

  const idle = mount(live([entry({ ...done, status: 'idle' })]));
  assert.equal(find(idle.node, 'row--idle').length, 1, 'this really is the Idle row');
  assert.deepEqual(find(idle.node, 'subs-num').map(text), ['12 launched']);

  // A session that never spawned one gets no line: on 84% of real sessions (measured over 721
  // transcripts) a `Subagents 0` would be a row telling every session what it is not.
  assert.equal(find(mount(live([entry()])).node, 'row-subs').length, 0);
  assert.equal(find(mount(live([entry({ status: 'idle' })])).node, 'row-subs').length, 0);
});

// A Workflow run takes ONE line however many agents it is running — the same rule the browser's
// Graph applies. ~100 member rows would be the whole panel, and the count still says how many work.
test('a workflow run is one line, whatever it is running', () => {
  const member = (i: number) => ({ title: `agent ${i}`, model: 'claude-haiku-4-5-20251001', pct: 4, runId: 'wf_1' });
  const { node } = mount(
    live([
      entry({
        subagents: {
          running: 17,
          launched: 17,
          list: [
            ...Array.from({ length: 16 }, (_, i) => member(i)),
            { title: 'Review the parser', model: 'claude-sonnet-4-6', pct: 40, runId: null },
          ],
        },
      }),
    ]),
  );

  assert.equal(find(node, 'agent').length, 2, 'the run was expanded into its members');
  assert.deepEqual(find(node, 'agent-title').map(text), ['Review the parser', 'Workflow']);
  assert.deepEqual(find(node, 'agent-model').map(text), ['Sonnet 4.6', '16 agents']);
});

// NOW says what the agent is DOING, never what it was asked to do. A row that answered only the
// first would leave the user reading a count with no idea why any of it is running.
test('a working row keeps the turn’s prompt beside what it is doing', () => {
  const { node } = mount(
    live([
      entry({
        turn: turn({
          prompt: 'add a retry to the uploader',
          now: { kind: 'activity', label: 'now', text: 'Read 1 file', ageFrom: null },
        }),
      }),
    ]),
  );

  assert.equal(text(find(node, 'row-line')[0]), '“add a retry to the uploader”');
  assert.equal(find(node, 'row-line--quote').length, 1, 'the agent’s own words must not read as ours');
  assert.equal(find(node, 'row-say').length, 1, 'the prompt did not replace what it is doing');
});

// No cap anywhere: one sized from a single machine's logs would hide sessions rather than bound
// anything, and the bands scroll.
test('every live session is drawn', () => {
  const many = Array.from({ length: 60 }, (_, i) =>
    entry({ sessionId: `s-${i}`, project: `p-${i}`, status: i % 3 === 0 ? 'idle' : 'busy' }),
  );

  const { node } = mount(live(many));

  assert.equal(find(node, 'row').length, 60);
});

// Bands are drawn in one order, always, and an empty one is not drawn at all: three headings over
// one row would spend a 560px popover on labels.
test('the bands keep their order and empty ones are absent', () => {
  const { node } = mount(
    live([
      entry({ sessionId: 'a', status: 'idle' }),
      entry({ sessionId: 'b', status: 'waiting', waitingFor: 'permission prompt' }),
    ]),
  );

  assert.deepEqual(
    find(node, 'band-head').map(text),
    ['Needs you', 'Idle'],
    'the urgent band comes first, and Working is not announced empty',
  );
});

test('clicking a row hands that session to the portal', () => {
  const { node, opened } = mount(live([entry({ sessionId: 'a' }), entry({ sessionId: 'b', status: 'idle' })]));

  for (const row of find(node, 'row')) (row as { onclick: () => void }).onclick();

  assert.deepEqual(opened, ['a', 'b']);
});

// Connected with nothing running is a real state, and it has to say so rather than draw a bare
// panel that reads as a failure to load.
test('nothing live says so, over the server it asked', () => {
  const { node } = mount([]);

  assert.match(text(find(node, 'bands-empty')[0]), /No session is running/);
  assert.equal(text(find(node, 'conn-host')[0]), 'box.local:44842');
});

// The footer is the only part of this surface that is not a session, which is why the way into the
// settings is there — and it has to be there even with nothing running, since the notification
// toggle is the one setting that matters when the machine is quiet.
test('the footer is the way into the settings, sessions or not', () => {
  for (const rows of [live([entry()]), []]) {
    const { node, asked } = mount(rows);
    const gear = find(node, 'conn-gear')[0] as { onclick: () => void; title: string } | undefined;
    assert.ok(gear, 'the gear is on the footer');

    gear.onclick();

    assert.equal(asked.settings, 1);
    assert.equal(gear.title, 'Settings', 'a lone glyph needs a name');
  }
});

// A session that is gone must stop counting. "Stopped 6m 20s ago" about a process that no longer
// exists is the panel asserting something it cannot know — and the Needs-you band is exactly where
// someone is watching when a session ends.
test('an ended row’s durations freeze at the moment it ended', () => {
  const waitingSince = 1_000_000;
  const stopped = entry({ sessionId: 'a', status: 'waiting', waitingFor: 'permission prompt', waitingSince });
  const quietOne = entry({ sessionId: 'b', status: 'idle', lastActivity: waitingSince });

  const endedAt = waitingSince + 134_000;
  const rows = retain(retain([], [stopped, quietOne], endedAt - 1000), [], endedAt);
  // A later tick must not move it on: the stamp is taken once and kept.
  const later = retain(rows, [], endedAt + 600_000);

  const age = (r: readonly Row[]) => text(find(mount(r).node, 'row-age')[0]);
  assert.equal(age(rows), 'Stopped 2m 14s ago');
  assert.equal(age(later), 'Stopped 2m 14s ago', 'the counter kept running after the session ended');
  assert.equal(text(find(mount(later).node, 'row-quiet')[0]), '2m');
});

// The panel is 392px wide and the bands scroll: a message about the click that just failed, appended
// after an uncapped list, would land below the fold.
test('a failure is shown above the bands, and the bands stay', () => {
  const { node } = mount(live([entry()]), 'There is no connection to open that session on.');

  const bands = find(node, 'bands')[0] as { children: { className: string }[] };
  assert.equal(bands.children[0]?.className, 'conn-error', 'the message is not the first thing shown');
  assert.match(text(find(node, 'conn-error')[0]), /no connection/);
  assert.equal(find(node, 'row').length, 1, 'the rows survived the message');
});

test('a duration is read as a stopwatch when it is urgent and roughly when it is not', () => {
  assert.equal(stopwatch(0), '0s');
  assert.equal(stopwatch(45_000), '45s');
  assert.equal(stopwatch(134_000), '2m 14s');
  assert.equal(stopwatch(3_601_000), '1h 00m');
  assert.equal(stopwatch(3_960_000), '1h 06m');

  assert.equal(quiet(45_000), '45s');
  assert.equal(quiet(14 * 60_000), '14m');
  assert.equal(quiet(3 * 3_600_000), '3h');
  assert.equal(quiet(50 * 3_600_000), '2d');
  // A clock a second ahead of the server's is the ordinary case, not an error to show as one.
  assert.equal(quiet(-2_000), '0s');
});

// The one band that is NOT a rule the tray holds: the server derives `error` and this reads the
// answer, which is what stops the icon, the panel and the portal's tab strip from disagreeing about
// whether a session is broken.
test('a session whose call failed is Broken, above every other band', () => {
  const err = { at: 1_700_000_000_000, status: '429', message: 'API Error: 429 rate limit', agentId: null };
  assert.equal(bandOf(entry({ error: err })), 'failed');
  // Whatever else it is doing: a broken session that is ALSO stopped on an approval is filed under
  // the answer the user has to act on first, exactly as the icon reads it.
  assert.equal(bandOf(entry({ error: err, status: 'waiting', waitingFor: 'permission prompt' })), 'failed');
  assert.equal(bandOf(entry({ error: err, status: 'busy' })), 'failed');
  // An entry with no error at all is untouched — a payload from an older server must not turn the
  // whole panel red.
  assert.equal(bandOf(entry({ error: null, status: 'busy' })), 'working');
});

test('the Broken row says whose call failed, in Claude Code’s own words', () => {
  const { node } = mount(
    live([
      entry({
        error: { at: 1_700_000_000_000, status: null, message: 'Not logged in · Please run /login', agentId: null },
      }),
    ]),
  );

  assert.equal(text(find(node, 'band-head')[0]), 'Broken'); // uppercased by the CSS, not the DOM
  assert.equal(text(find(node, 'row-ask')[0]), 'The last API call failed');
  // The message is the CLI's, verbatim: it is what tells the user this needs a /login rather than a
  // wait, and a category of our own would send them to the terminal to find out.
  assert.equal(text(find(node, 'row-arg')[0]), 'Not logged in · Please run /login');
});

test('a subagent’s failure is not reported as the session’s own call', () => {
  // The two call for different reactions — one is a fan-out that lost a worker, the other is the
  // session itself stopping — so the row must not describe them with one sentence.
  const { node } = mount(
    live([
      entry({
        error: { at: 1_700_000_000_000, status: '429', message: 'API Error: 429 rate limit', agentId: 'ag1' },
      }),
    ]),
  );

  assert.equal(text(find(node, 'row-ask')[0]), "A subagent's API call failed");
});

test('the Broken band is drawn above Needs you', () => {
  const { node } = mount(
    live([
      entry({ sessionId: 's-wait', status: 'waiting', waitingFor: 'permission prompt' }),
      entry({
        sessionId: 's-fail',
        error: { at: 1_700_000_000_000, status: null, message: 'boom', agentId: null },
      }),
    ]),
  );

  const heads = find(node, 'band-head').map((h) => text(h));
  assert.deepEqual(heads, ['Broken', 'Needs you'], 'the panel order must be the icon’s precedence');
});
