import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  activityBucket,
  activityLine,
  HOLD_MIN_MS,
  MAX_FAMILIES,
  type NowInput,
  narrationHoldMs,
  nowLine,
  outcomeLine,
  READING_CHARS_PER_S,
  RUNNING_AFTER_MS,
  runningSince,
  VISIBLE_CHARS,
  WORD_ARRIVES_LIVE_MS,
} from '../src/core/activity-line.ts';

// The words NOW uses while the agent works in silence, and which call its age chip times. Worth
// testing because the line is the whole feature: the counts come from the reducer (covered by the
// golden transcript), but a wrong plural, an unstable order, or a chip that times the wrong call
// is what would make the panel read as machine-made.

const NOW = Date.parse('2026-07-14T10:00:30.000Z');
const at = (name: string, iso: string) => ({ name, startedTs: iso });
const ago = (ms: number) => new Date(NOW - ms).toISOString();

test('one call reads in the singular, several in the plural', () => {
  assert.equal(activityLine({ Bash: 1 }), 'Ran 1 shell command');
  assert.equal(activityLine({ Bash: 4 }), 'Ran 4 shell commands');
  // the plurals no rule gets right
  assert.equal(activityLine({ LS: 1 }), 'Listed 1 directory');
  assert.equal(activityLine({ LS: 3 }), 'Listed 3 directories');
  assert.equal(activityLine({ WebSearch: 2 }), 'Searched 2 queries');
  // Without its own words this said "2 Artifact calls" — the generic phrase for a tool nobody
  // has mapped, on a turn that published something.
  assert.equal(activityLine({ Artifact: 2 }), 'Published 2 artifacts');
});

test('the busiest tool leads, ties break by name so the line never jitters', () => {
  assert.equal(activityLine({ Read: 2, Bash: 17, Write: 6 }), 'Ran 17 shell commands, wrote 6 files, read 2 files');
  // a tie is resolved deterministically, not by object key order
  assert.equal(activityLine({ Write: 2, Read: 2 }), 'Read 2 files, wrote 2 files');
  assert.equal(activityLine({ Read: 2, Write: 2 }), 'Read 2 files, wrote 2 files');
});

test('the line names at most three families and trails off for the rest', () => {
  assert.equal(MAX_FAMILIES, 3);
  // five families: the two smallest become an ellipsis, and the count stays exact for the three named
  const five = { Bash: 17, Write: 6, WebFetch: 5, Read: 2, ToolSearch: 1 };
  assert.equal(activityLine(five), 'Ran 17 shell commands, wrote 6 files, fetched 5 pages…');
  // exactly three: no ellipsis — nothing is being hidden
  assert.equal(activityLine({ Bash: 3, Write: 2, Read: 1 }), 'Ran 3 shell commands, wrote 2 files, read 1 file');
});

test('MCP tools are summed per server, not per tool name', () => {
  assert.equal(activityBucket('mcp__linear__get_issue'), 'mcp:linear');
  assert.equal(activityBucket('Bash'), 'Bash');
  // two different Linear tools read as one count, so they take ONE of the three slots
  assert.equal(
    activityLine({ mcp__linear__get_issue: 2, mcp__linear__list_comments: 2, Bash: 1 }),
    '4 linear calls, ran 1 shell command',
  );
  assert.equal(activityLine({ mcp__linear__get_issue: 1 }), '1 linear call');
});

test('a tool with no word of its own is named and counted, never given an invented verb', () => {
  assert.equal(activityLine({ ReportFindings: 2 }), '2 ReportFindings calls');
});

test('nothing done yet says nothing at all, so the panel keeps quoting the agent', () => {
  assert.equal(activityLine({}), '');
});

test('the age chip times the oldest call that has been running a full second', () => {
  // nothing open, or open too briefly → no age at all (78.6% of a group's life)
  assert.equal(runningSince([], NOW), null);
  assert.equal(runningSince([at('Bash', ago(RUNNING_AFTER_MS - 1))], NOW), null);

  // the OLDEST qualifying call is the one timed: it answers "how long has this been going"
  const old = ago(30_000),
    recent = ago(3_000);
  assert.equal(runningSince([at('Bash', recent), at('WebFetch', old)], NOW), Date.parse(old));
  // a call too young to count does not shadow an older one
  assert.equal(runningSince([at('Bash', old), at('Read', ago(200))], NOW), Date.parse(old));
});

test('an unparseable start is ignored rather than timed from an invented moment', () => {
  assert.equal(runningSince([at('Bash', 'not-a-date')], NOW), null);
  const good = ago(5_000);
  assert.equal(runningSince([at('Bash', 'not-a-date'), at('Read', good)], NOW), Date.parse(good));
});

// How long the agent's last word keeps the panel. Worth testing because it used to be one flat
// number for every narration, which on the real corpus (9020 narrations) was too long for 60% and
// too short for the rest — the panel either sat on a three-word line or cut off a full one.
const chars = (n: number) => 'x'.repeat(n);

test('the hold is the time it takes to read the narration, not a fixed number', () => {
  // A word twice as long is held twice as long — the whole point of the change.
  const short = narrationHoldMs(chars(85)); // ~5s of reading
  const long = narrationHoldMs(chars(170)); // ~10s
  assert.equal(short, (85 / READING_CHARS_PER_S) * 1000);
  assert.equal(long, (170 / READING_CHARS_PER_S) * 1000);
  assert.ok(long > short);
});

test('the hold never exceeds the time to read what the panel can actually SHOW', () => {
  // The panel is clamped to two lines: past VISIBLE_CHARS the rest is behind `more`, so holding
  // longer buys the reader nothing and only keeps the activity group waiting.
  const ceiling = (VISIBLE_CHARS / READING_CHARS_PER_S) * 1000;
  assert.equal(narrationHoldMs(chars(VISIBLE_CHARS)), ceiling);
  assert.equal(narrationHoldMs(chars(VISIBLE_CHARS * 4)), ceiling);
  assert.equal(narrationHoldMs(chars(20_000)), ceiling);
});

test('a very short word still gets a glance, never a flash', () => {
  // 'Ok.' is 0.2s of reading; without a floor the panel would swap before the eye lands on it.
  assert.equal(narrationHoldMs('Ok.'), HOLD_MIN_MS);
  assert.equal(narrationHoldMs(chars(1)), HOLD_MIN_MS);
  // the floor stops binding exactly where reading time overtakes it
  assert.equal(narrationHoldMs(chars((HOLD_MIN_MS / 1000) * READING_CHARS_PER_S + 17)), 4000);
});

test('no word means no hold at all — there is nothing to read', () => {
  assert.equal(narrationHoldMs(''), 0);
});

// nowLine — the rule BOTH surfaces show. Worth testing at this level and not through either of
// them: a browser test proves the panel drew something, and the tray cannot be driven at all from
// here. What must hold is the precedence itself, on the awkward cases (a stopped session, a word
// nobody was there to see, a turn that is over).

const WORD = '2026-07-14T10:00:00.000Z';
const input = (over: Partial<NowInput> = {}): NowInput => ({
  waiting: null,
  pendingTool: null,
  waitingSince: null,
  live: true,
  result: null,
  narration: { ts: WORD, text: 'Reading the parser' },
  wordTs: WORD,
  wordSeenAt: Date.parse(WORD),
  activity: null,
  delegated: null,
  returned: null,
  apiCalls: 1,
  startedAt: Date.parse(WORD),
  ...over,
});

test('nowLine: a block on the user outranks everything the turn has to say', () => {
  const state = nowLine(
    input({
      waiting: 'permission',
      pendingTool: { name: 'Bash', arg: 'rm -rf build' },
      waitingSince: NOW - 5000,
      activity: { counts: { Read: 4 }, open: [] },
    }),
    NOW,
  );
  assert.deepEqual(state, {
    kind: 'waiting',
    label: 'waiting for you',
    text: 'Waiting for your approval — Bash · rm -rf build',
    ageFrom: NOW - 5000,
  });
  // An unnamed call still states the block: the transcript not naming it is not a reason to say
  // nothing, which is what the row is for.
  assert.equal(
    nowLine(input({ waiting: 'input', pendingTool: null }), NOW)?.text,
    'Waiting for your answer in the terminal',
  );
});

test('nowLine: the last word holds NOW for as long as it takes to READ, then the count takes over', () => {
  const activity = { counts: { Read: 4 }, open: [] };
  // Seen just now: the word is still the thing to show, even though work has happened since.
  const fresh = nowLine(input({ activity, wordSeenAt: NOW - 1000 }), NOW);
  assert.equal(fresh?.kind, 'intent');
  assert.equal(fresh?.label, 'now');
  // Past the hold for that particular text (19 chars ≈ the 3s floor), the count wins.
  const stale = nowLine(input({ activity, wordSeenAt: NOW - HOLD_MIN_MS - 1 }), NOW);
  assert.equal(stale?.kind, 'activity');
  assert.equal(stale?.text, 'Read 4 files');
});

test('nowLine: a word first seen long after it was written earns no hold at all', () => {
  // Opening seedeep on a session whose agent spoke five minutes ago must show what it is DOING,
  // not replay an old line as if it were news.
  const state = nowLine(
    input({
      activity: { counts: { Bash: 2 }, open: [] },
      wordSeenAt: Date.parse(WORD) + WORD_ARRIVES_LIVE_MS + 1,
    }),
    NOW,
  );
  assert.equal(state?.kind, 'activity');
  // Never seen at all (a client that has only ever polled) is the same case, not a crash.
  assert.equal(
    nowLine(input({ activity: { counts: { Bash: 2 }, open: [] }, wordSeenAt: null }), NOW)?.kind,
    'activity',
  );
});

test('nowLine: the final answer takes over from the narration, and says so', () => {
  const state = nowLine(input({ result: 'Done — three files changed', live: false }), NOW);
  assert.equal(state?.kind, 'output');
  assert.equal(state?.label, 'output');
  assert.equal(state?.text, 'Done — three files changed');
  assert.equal(state?.ageFrom, null, 'a final answer is not something still running');
  // The same narration reads `now` on a live turn and `intent` on one that was stopped: a row must
  // not look busy while its session is not.
  assert.equal(nowLine(input(), NOW)?.label, 'now');
  assert.equal(nowLine(input({ live: false }), NOW)?.label, 'intent');
});

test('nowLine: the age times the running call, and only while the turn is live', () => {
  const activity = { counts: { Bash: 1 }, open: [at('Bash', ago(9000))] };
  const live = nowLine(input({ activity, wordSeenAt: null }), NOW);
  assert.equal(live?.ageFrom, NOW - 9000);
  const settled = nowLine(input({ activity, wordSeenAt: null, live: false }), NOW);
  assert.equal(settled?.ageFrom, null, 'nothing is still going on a turn that has stopped');
});

// The one honest silence, and the only one left: a turn that is not RUNNING. A local built-in
// (`/clear`, `/model` — 361 of 3064 measured turns, all closing in 0s) never called the model, and
// a settled turn is not a "now" at all. A turn that IS running always has something to say — see
// the `working` cases below, which is what this test used to assert the opposite of.
test('nowLine: a turn that is not running means no NOW at all, never a placeholder', () => {
  assert.equal(
    nowLine(input({ narration: null, wordTs: null, wordSeenAt: null, live: false, apiCalls: 0 }), NOW),
    null,
  );
});

test('outcomeLine: the fate leads, so the ellipsis cannot eat it', () => {
  assert.equal(
    outcomeLine('Background command "Start seedeep server" failed with exit code 144'),
    'failed with exit code 144 · Background command "Start seedeep server"',
  );
  assert.equal(
    outcomeLine('Background command "Relaunch the tray" was stopped'),
    'was stopped · Background command "Relaunch the tray"',
  );
});

// A launch with no `description` is named by Claude Code after the COMMAND itself — measured on
// 4 of 120 real launches. That name is multi-line and carries its own quotes, which defeated a
// regex anchored `^…$` with a `[^"]*` name: the row then showed the blob whole and the fate fell
// past the column's clip, leaving only the red border to say anything.
test('outcomeLine: the fate still leads when the name is multi-line and holds quotes', () => {
  const summary =
    'Background command "cd /home/dev/app && python3 - <<\'PY\'\ns = s.replace(\n"""import os"""\n)\nPY" failed with exit code 1';
  const out = outcomeLine(summary);
  assert.ok(out.startsWith('failed with exit code 1 · Background command "cd /home/dev/app'), out.slice(0, 80));
  assert.ok(out.endsWith('PY"'), out.slice(-40));
});

// Claude Code HTML-escapes the command it quotes (`&amp;&amp;`, `&lt;&lt;`), and every surface
// prints this line as text — so the escaped entities reached the screen verbatim.
test('outcomeLine: Claude Code’s HTML entities are decoded, never shown raw', () => {
  assert.equal(
    outcomeLine('Background command "a &amp;&amp; b &lt;&lt;&#39;PY&#39;" failed with exit code 1'),
    'failed with exit code 1 · Background command "a && b <<\'PY\'"',
  );
  // &amp;amp; is a literal "&amp;" in the command: one decoding pass, never two.
  assert.equal(
    outcomeLine('Background command "x &amp;amp; y" was stopped'),
    'was stopped · Background command "x &amp; y"',
  );
});

// Claude Code owns this sentence and may reword it. A summary shown whole beats one mangled by a
// regex that no longer matches, so anything unrecognised passes through untouched.
test('outcomeLine: an unknown shape passes through unchanged', () => {
  assert.equal(outcomeLine('Something else entirely happened'), 'Something else entirely happened');
  assert.equal(outcomeLine('Background command with no quotes failed'), 'Background command with no quotes failed');
  assert.equal(outcomeLine(''), '');
});

// ── A turn is never mute ───────────────────────────────────────────────────────
// Measured over 3064 real turns: 12.3% run the model and produce NOTHING but the final answer
// (median 22.1s, p90 46.9s of an empty panel), every turn is silent for a median 9.6s before its
// first narration or tool call, and a turn that delegates to a forked skill (`/code-review`) can
// stay silent for 12 minutes while its agent burns six figures of tokens. `nowLine` returned null
// for all three, and null means "draw no NOW at all" — so the surface that exists to say what is
// happening said nothing exactly while something was.

test('nowLine: a turn whose work is delegated says so, and times the agent', () => {
  const state = nowLine(
    input({
      narration: null,
      wordTs: null,
      wordSeenAt: null,
      apiCalls: 0,
      startedAt: NOW - 600_000,
      delegated: { label: '/code-review', since: NOW - 341_000, count: 1 },
    }),
    NOW,
  );
  assert.deepEqual(state, {
    kind: 'working',
    label: 'now',
    text: '/code-review is running in the background',
    // The age is the AGENT's, not the turn's: what the reader wants timed is the work that is
    // actually running, and the turn started long before it.
    ageFrom: NOW - 341_000,
  });
  // More than one, and the line counts them rather than naming a winner.
  assert.equal(
    nowLine(input({ narration: null, wordTs: null, delegated: { label: '/code-review', since: null, count: 3 } }), NOW)
      ?.text,
    '3 agents running in the background',
  );
});

test('nowLine: a turn that only ever produces its final answer still says it is answering', () => {
  const state = nowLine(
    input({ narration: null, wordTs: null, wordSeenAt: null, apiCalls: 2, startedAt: NOW - 22_000 }),
    NOW,
  );
  assert.deepEqual(state, {
    kind: 'working',
    label: 'now',
    text: 'Answering — no tools used, nothing said yet',
    ageFrom: NOW - 22_000,
  });
});

test('nowLine: before the first API call the panel states the round started, not nothing', () => {
  const state = nowLine(
    input({ narration: null, wordTs: null, wordSeenAt: null, apiCalls: 0, startedAt: NOW - 8_000 }),
    NOW,
  );
  assert.deepEqual(state, {
    kind: 'working',
    label: 'now',
    text: 'Started — no output yet',
    ageFrom: NOW - 8_000,
  });
});

// Precedence: the new branch is the LAST resort. A turn that has spoken, or that has run a tool,
// still shows its own words / its own count — the delegated line must not shout over them.
test('nowLine: words and tool counts still outrank the working line', () => {
  const delegated = { label: '/code-review', since: NOW - 1000, count: 1 };
  assert.equal(nowLine(input({ delegated }), NOW)?.kind, 'intent');
  assert.equal(
    nowLine(input({ delegated, narration: null, wordTs: null, activity: { counts: { Read: 2 }, open: [] } }), NOW)
      ?.kind,
    'activity',
  );
  assert.equal(nowLine(input({ delegated, narration: null, wordTs: null, result: 'Done.' }), NOW)?.kind, 'output');
});

// The window AFTER a background agent returns. Claude Code flushes a thinking block only
// when it closes, so the parent transcript says nothing for a median 11s (p90 33.1s, max 4m 5s,
// measured over 321 real returns) while the session visibly works on the result. Drawn from the
// transcript alone the panel vanished and everything read as finished.
test('nowLine: an agent that has returned keeps the panel while the turn digests it', () => {
  const state = nowLine(
    input({
      narration: null,
      wordTs: null,
      wordSeenAt: null,
      apiCalls: 0,
      returned: { label: '/code-review diff', at: NOW - 50_000 },
    }),
    NOW,
  );
  assert.deepEqual(state, {
    kind: 'working',
    label: 'now',
    text: '/code-review diff returned — working on the result',
    ageFrom: NOW - 50_000,
  });
});

test('nowLine: one still running outranks one that returned — what is happening beats what happened', () => {
  const both = nowLine(
    input({
      narration: null,
      wordTs: null,
      delegated: { label: '/second-review', since: NOW - 10_000, count: 1 },
      returned: { label: '/code-review', at: NOW - 50_000 },
    }),
    NOW,
  );
  assert.equal(both?.text, '/second-review is running in the background');
});
