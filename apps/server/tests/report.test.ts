import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TurnSummary } from '../src/core/types.ts';
import type { SessionSummary } from '../src/server/aggregate-cache.ts';
import {
  approxTokens,
  duration,
  findSession,
  formatReport,
  latestSessionInProject,
  readSession,
  tokens,
} from '../src/server/report.ts';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'turns-sample.jsonl');
const FIXTURE_ID = 'sess-turns-sample';

function turn(over: Partial<TurnSummary> = {}): TurnSummary {
  return {
    billable: 1000,
    cacheRead: 0,
    weighted: 1000,
    subagentTokensByModel: [],
    subagentNew: 0,
    effort: 'medium',
    model: 'claude-opus-5',
    apiCalls: 2,
    resumeCost: 0,
    esc: false,
    escStreak: false,
    context: false,
    compaction: false,
    subWaste: false,
    exploration: false,
    unverifiedShip: false,
    ts: 0,
    durationMs: 60_000,
    severity: 'good',
    ...over,
  };
}

function summary(turns: TurnSummary[], over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    turns,
    tools: { Bash: 12, Read: 4 },
    weightedMain: 5000,
    weightedSubagents: 0,
    weightedByModel: {},
    tokensComplete: 90_000,
    mainModel: 'claude-opus-5',
    mainModels: 1,
    apiCalls: 9,
    ...over,
  };
}

const render = (s: SessionSummary, full = false) =>
  formatReport({ sessionId: 'sess-1', project: 'demo', summary: s, entries: [], launched: 0, full });

test('tokens and duration stay short at every scale', () => {
  assert.equal(tokens(430), '430');
  assert.equal(tokens(12_400), '12k');
  assert.equal(tokens(1_240_000), '1.2M');
  assert.equal(duration(48_000), '48s');
  assert.equal(duration(12 * 60_000), '12m');
  assert.equal(duration(134 * 60_000), '2h 14m');
});

// The report is read INSIDE the session it describes, so its size is part of the contract.
test('the report states its own cost and stays small on a long session', () => {
  const long = render(summary(Array.from({ length: 200 }, () => turn())));
  assert.match(long, /this report cost ~\d+ tokens/);
  assert.ok(approxTokens(long) < 400, `a 200-turn report grew to ~${approxTokens(long)} tokens`);
});

test('a clean session says so rather than printing an empty block', () => {
  assert.match(render(summary([turn()])), /nothing flagged/);
});

test('each flagged behaviour gets its own line, and only when it happened', () => {
  const out = render(
    summary([
      turn({ resumeCost: 400, billable: 1000 }),
      turn({ esc: true, billable: 2000 }),
      turn({ compaction: true }),
      turn({ context: true }),
    ]),
  );
  assert.match(out, /cold resumes {6}400 of new tokens \(8%\)/);
  assert.match(out, /abandoned to Esc {2}2k across 1 turns/);
  assert.match(out, /compactions {7}1 mid-turn/);
  assert.match(out, /context ≥70% {6}1 turns/);
  assert.doesNotMatch(out, /subagent dumps/);
  assert.doesNotMatch(out, /exploration/);
});

test('the costliest turns carry their own numbers, not the list order', () => {
  const s = summary([turn({ billable: 10 }), turn({ billable: 900_000 }), turn({ billable: 500 })]);
  const out = formatReport({
    sessionId: 'sess-1',
    project: 'demo',
    summary: s,
    entries: [
      { index: 1, prompt: 'first' },
      { index: 2, prompt: 'second' },
      { index: 3, prompt: 'third' },
    ],
    launched: 0,
    full: false,
  });
  const costliest = out.split('costliest turns\n')[1]?.split('\n')[0] ?? '';
  assert.match(costliest, /#2 +900k/);
});

test('--full adds the prompts, and nothing else does', () => {
  const entries = [{ index: 1, prompt: 'refactor  the\nparser' }];
  const args = { sessionId: 'sess-1', project: 'demo', summary: summary([turn()]), entries, launched: 0 };
  assert.doesNotMatch(formatReport({ ...args, full: false }), /refactor/);
  assert.match(formatReport({ ...args, full: true }), /#1 {4}refactor the parser/);
});

// A default is safe here because the report names its own subject on the first line — and only
// within the caller's own project: a session from elsewhere would be wrong in the one way the
// first line cannot make obvious.
test('the newest session of THIS directory is the default, and never one from elsewhere', async () => {
  const home = mkdtempSync(join(tmpdir(), 'seedeep-latest-'));
  const cwd = '/home/dev/work';
  const mine = join(home, '.claude', 'projects', '-home-dev-work');
  const other = join(home, '.claude', 'projects', '-home-dev-elsewhere');
  mkdirSync(mine, { recursive: true });
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, 'ffffffff-ffff-ffff-ffff-ffffffffffff.jsonl'), '');

  assert.equal(await latestSessionInProject(cwd, home, {}), null, 'another project is never borrowed');

  const older = join(mine, '11111111-1111-1111-1111-111111111111.jsonl');
  const newer = join(mine, '22222222-2222-2222-2222-222222222222.jsonl');
  writeFileSync(older, '');
  writeFileSync(newer, '');
  utimesSync(older, new Date(1000), new Date(1000));
  utimesSync(newer, new Date(2000), new Date(2000));
  assert.equal(await latestSessionInProject(cwd, home, {}), '22222222-2222-2222-2222-222222222222');

  utimesSync(older, new Date(3000), new Date(3000));
  assert.equal(await latestSessionInProject(cwd, home, {}), '11111111-1111-1111-1111-111111111111');
});

test('a session id with no transcript is not found', async () => {
  const home = mkdtempSync(join(tmpdir(), 'seedeep-report-'));
  mkdirSync(join(home, '.claude', 'projects', 'a-project'), { recursive: true });
  assert.equal(await findSession('nope', home), null);
});

// Runs the REAL replay + reducer over raw jsonl, which is the only thing that can catch the
// positional pairing going wrong: a `TurnSummary` has no id, so `entries` must stay the same list
// `summarizeTree` filtered. A hand-built summary can never discover that.
test('the turn entries line up with the summarized turns, over real lines', async () => {
  const home = mkdtempSync(join(tmpdir(), 'seedeep-report-'));
  const dir = join(home, '.claude', 'projects', 'a-project');
  mkdirSync(dir, { recursive: true });
  copyFileSync(FIXTURE, join(dir, `${FIXTURE_ID}.jsonl`));

  const found = await findSession(FIXTURE_ID, home);
  assert.ok(found, 'the fixture should be found by its id');
  const { summary: s, entries } = await readSession(found, FIXTURE_ID);
  assert.ok(s.turns.length > 0, 'the fixture should produce closed work turns');
  assert.equal(entries.length, s.turns.length);
  assert.match(
    formatReport({ sessionId: FIXTURE_ID, project: 'a-project', summary: s, entries, launched: 0, full: true }),
    /turns\n/,
  );
});
