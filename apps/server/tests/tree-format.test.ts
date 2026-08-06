import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  formatDuration,
  formatLaunchTime,
  formatOffset,
  formatToolMs,
  modelFamily,
  promptLine,
  stripMarkdown,
  summarizeTools,
  tabLabel,
} from '../src/core/tree-format.ts';

test('promptLine: collapses a multi-line prompt into one line', () => {
  assert.equal(promptLine('fix the bug\n\nmore   details\nhere'), 'fix the bug more details here');
});
test('promptLine: cuts at the cap with an ellipsis, leaves a short prompt intact', () => {
  assert.equal(promptLine('abcdefghij', 5), 'abcde…');
  assert.equal(promptLine('short', 200), 'short');
});
test('promptLine: empty/absent prompt is an empty string', () => {
  assert.equal(promptLine(''), '');
  assert.equal(promptLine(null), '');
  assert.equal(promptLine(undefined), '');
});

// tabLabel — the tab strip used to show the project alone, so two sessions of one
// project were two identical tabs. The subject is what tells them apart.
const s = (over: Partial<{ project: string; subject: string | null; sessionId: string }> = {}) => ({
  project: 'seedeep',
  subject: 'fix the login redirect',
  sessionId: '4f3a1c22-dead-beef-0000-000000000001',
  ...over,
});

test('tabLabel: project + subject', () => {
  assert.equal(tabLabel(s()), 'seedeep · fix the login redirect');
});
test('tabLabel: two sessions of the SAME project read apart', () => {
  const a = tabLabel(s({ subject: 'fix the login redirect' }));
  const b = tabLabel(s({ subject: 'write the changelog' }));
  assert.notEqual(a, b);
});
test('tabLabel: the subject is cut at 30 chars — a tab is not a paragraph', () => {
  assert.equal(tabLabel(s({ subject: 'a'.repeat(40) })), 'seedeep · ' + 'a'.repeat(30) + '…');
  assert.equal(
    tabLabel(s({ subject: 'a'.repeat(30) })),
    'seedeep · ' + 'a'.repeat(30),
    'exactly at the cap: no ellipsis',
  );
});
test('tabLabel: a multi-line subject collapses to one line', () => {
  assert.equal(tabLabel(s({ subject: 'fix the\n\nlogin   bug' })), 'seedeep · fix the login bug');
});
test('tabLabel: no subject falls back to the short id, so subject-less tabs still differ', () => {
  const a = tabLabel(s({ subject: null }));
  const b = tabLabel(s({ subject: '   ', sessionId: '99887766-dead-beef-0000-000000000002' }));
  assert.equal(a, 'seedeep · 4f3a1c22');
  assert.equal(b, 'seedeep · 99887766', 'a blank subject is no subject');
  assert.notEqual(a, b);
});

test('formatDuration: null is running', () => {
  assert.equal(formatDuration(null), 'running…');
});
test('formatDuration: sub-second', () => {
  assert.equal(formatDuration(120), '<1s');
  assert.equal(formatDuration(999), '<1s');
});
test('formatDuration: seconds only', () => {
  assert.equal(formatDuration(1000), '1s');
  assert.equal(formatDuration(48000), '48s');
});
test('formatDuration: minutes and seconds', () => {
  assert.equal(formatDuration(108000), '1m 48s'); // 1*60000 + 48*1000
  assert.equal(formatDuration(120000), '2m'); // exact minute → no seconds
});
test('formatToolMs: null and undefined are running', () => {
  assert.equal(formatToolMs(null), 'running…');
  assert.equal(formatToolMs(undefined), 'running…');
});
test('formatToolMs: sub-second keeps raw ms (the useful precision for one tool)', () => {
  assert.equal(formatToolMs(0), '0ms');
  assert.equal(formatToolMs(134), '134ms');
  assert.equal(formatToolMs(999), '999ms');
});
test('formatToolMs: sub-minute keeps one decimal, truncated (never rounds into 60.0s)', () => {
  assert.equal(formatToolMs(1000), '1.0s');
  assert.equal(formatToolMs(18138), '18.1s');
  assert.equal(formatToolMs(59949), '59.9s');
  assert.equal(formatToolMs(59999), '59.9s'); // rounding would show the impossible '60.0s'
});
test('formatToolMs: a minute and beyond matches formatDuration', () => {
  assert.equal(formatToolMs(60000), '1m');
  assert.equal(formatToolMs(134000), '2m 14s');
});

test('formatLaunchTime: null is empty', () => {
  assert.equal(formatLaunchTime(null), '');
});
test('formatLaunchTime: absolute, deterministic for a fixed instant', () => {
  // Assert format shape, not an exact clock value (local tz varies): 3 letters, day, HH:MM:SS.
  const out = formatLaunchTime('2026-07-12T14:32:07.000Z');
  assert.match(out, /^[A-Z][a-z]{2} \d{2} \d{2}:\d{2}:\d{2}$/);
});
test('summarizeTools: count + breakdown sorted by frequency desc then name asc', () => {
  const tools = [
    { name: 'Read', ms: 10 },
    { name: 'Read', ms: 10 },
    { name: 'Read', ms: 10 },
    { name: 'Bash', ms: 5 },
    { name: 'Grep', ms: 5 },
    { name: 'Bash', ms: 5 },
  ];
  assert.deepEqual(summarizeTools(tools), {
    count: 6,
    breakdown: [
      { name: 'Read', n: 3 },
      { name: 'Bash', n: 2 },
      { name: 'Grep', n: 1 },
    ],
  });
});
test('summarizeTools: empty', () => {
  assert.deepEqual(summarizeTools([]), { count: 0, breakdown: [] });
});
test('modelFamily: extracts the family from a full model id, case-insensitive', () => {
  assert.equal(modelFamily('claude-opus-4-8'), 'opus');
  assert.equal(modelFamily('claude-haiku-4-5-20251001'), 'haiku');
  assert.equal(modelFamily('Claude-Fable-5'), 'fable');
});
test('modelFamily: null for unset or unknown-family ids', () => {
  assert.equal(modelFamily(null), null);
  assert.equal(modelFamily(undefined), null);
  assert.equal(modelFamily(''), null);
  assert.equal(modelFamily('gpt-9'), null);
});

// A session's working time reaches hours (measured: 18h on one real session), where
// minutes stop being readable — "1080m" is a number you have to do arithmetic on.
test('formatDuration: hours, with minutes and without', () => {
  assert.equal(formatDuration(3_600_000), '1h');
  assert.equal(formatDuration(3_639_000), '1h'); // 1h 0m 39s — seconds are noise here
  assert.equal(formatDuration(3_900_000), '1h 5m');
  assert.equal(formatDuration(64_800_000), '18h');
  assert.equal(formatDuration(65_100_000), '18h 5m');
});

// The scales below the hour must not move: they are what every subagent and tool row shows.
test('formatDuration: sub-hour scales are unchanged', () => {
  assert.equal(formatDuration(59_000), '59s');
  assert.equal(formatDuration(60_000), '1m');
  assert.equal(formatDuration(3_599_000), '59m 59s');
});

test('formatOffset: coarse by design — a position in the turn, not a duration', () => {
  assert.equal(formatOffset(0), '+0s');
  // Sub-second offsets all read '+0s': at this scale the millisecond is noise, and the
  // first row of a list must anchor at +0s even when it is a few ms after the turn's t0.
  assert.equal(formatOffset(999), '+0s');
  assert.equal(formatOffset(1_000), '+1s');
  assert.equal(formatOffset(42_400), '+42s');
  assert.equal(formatOffset(60_000), '+1m00');
  assert.equal(formatOffset(372_000), '+6m12');
  // A row before the anchor cannot render as a negative position.
  assert.equal(formatOffset(-5_000), '+0s');
});

test('stripMarkdown: unwraps bold/code/links and collapses whitespace for the glance surface', () => {
  assert.equal(stripMarkdown('the **bold** part'), 'the bold part');
  assert.equal(stripMarkdown('run `bun test` now'), 'run bun test now');
  assert.equal(stripMarkdown('see [the docs](https://x.example/y)'), 'see the docs');
  assert.equal(
    stripMarkdown('# Heading\n- one\n- two'),
    'Heading one two',
    'heading/list MARKERS gone (text kept), newlines collapsed',
  );
  assert.equal(stripMarkdown('```\ncode\n```after'), 'after', 'a fenced block is dropped');
  assert.equal(stripMarkdown('line one\n\n\nline two'), 'line one line two');
});

test('stripMarkdown: leaves code-ish text untouched (no false emphasis)', () => {
  // snake_case, a lone asterisk, and a glob must survive — only unambiguous **bold** is unwrapped.
  assert.equal(stripMarkdown('rename src/foo_bar_baz.ts'), 'rename src/foo_bar_baz.ts');
  assert.equal(stripMarkdown('the product a*b matters'), 'the product a*b matters');
  assert.equal(stripMarkdown('match *.ts files'), 'match *.ts files');
});
