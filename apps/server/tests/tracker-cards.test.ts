import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cardFromResult,
  cardIdFromInput,
  closingRefs,
  ghIssueFromResult,
  ghTitleFromResult,
  isTrackerTool,
  looksLikeCardId,
  mergeTouches,
  parseGhIssues,
  trackerEvidence,
} from '../src/core/tracker-cards.ts';

// What a plausible bug here looks like: a card id read out of the call's BODY rather than its id
// field (a first measurement over the real corpus put `SHA-256` among the top four "cards"), a url
// lifted from a description instead of the card's own page, or a write demoted to a read — which
// would turn "this session did the work" into "this session glanced at it".

test('a card id comes from the id field, not from anywhere else', () => {
  assert.equal(cardIdFromInput({ id: 'ABC-12' }), 'ABC-12');
  assert.equal(cardIdFromInput({ issueId: 'proj-7' }), 'PROJ-7');
  // The body is full of key-shaped strings that name no card; none of them may reach a row.
  assert.equal(cardIdFromInput({ description: 'uses SHA-256 and RSA-2048 over UTF-8' }), null);
  assert.equal(cardIdFromInput({ id: 'not a key' }), null);
  assert.equal(cardIdFromInput(null), null);
});

test('a tracker tool is recognised by shape, and its verb decides the evidence', () => {
  assert.ok(isTrackerTool('mcp__linear__save_issue'));
  assert.ok(isTrackerTool('mcp__jira__get_issue'));
  assert.ok(isTrackerTool('mcp__whatever__list_comments'));
  // Not MCP: a shell command mentioning an issue is not a tracker call.
  assert.ok(!isTrackerTool('Bash'));
  assert.ok(!isTrackerTool('mcp__linear__list_teams'));

  assert.equal(trackerEvidence('mcp__linear__save_issue'), 'wrote');
  assert.equal(trackerEvidence('mcp__linear__create_issue'), 'wrote');
  assert.equal(trackerEvidence('mcp__linear__save_comment'), 'wrote');
  assert.equal(trackerEvidence('mcp__linear__get_issue'), 'read');
  assert.equal(trackerEvidence('mcp__linear__list_comments'), 'read');
});

test('title and url are read back from the result, and the url must name its own card', () => {
  // Shape copied from a real result: the tool returns JSON as the text of one content part.
  const body = JSON.stringify({
    id: 'ABC-12',
    title: 'Session view: the thing',
    description: 'See https://tracker.example.com/team/issue/ABC-99/other-card for context',
    url: 'https://tracker.example.com/team/issue/ABC-12/session-view-the-thing',
  });
  const got = cardFromResult(body, 'ABC-12');
  assert.equal(got.title, 'Session view: the thing');
  // The description's link points at ANOTHER card and must not be taken for this one's page.
  assert.equal(got.url, 'https://tracker.example.com/team/issue/ABC-12/session-view-the-thing');
});

test('a creation is recovered from its result, because its input names no card', () => {
  const body = JSON.stringify({
    id: 'ABC-40',
    title: 'Just filed',
    url: 'https://tracker.example.com/t/issue/ABC-40/just-filed',
  });
  const got = cardFromResult(body, null);
  assert.equal(got.id, 'ABC-40');
  assert.equal(got.title, 'Just filed');
  assert.equal(got.url, 'https://tracker.example.com/t/issue/ABC-40/just-filed');
});

test('a result with no url leaves the row linkless rather than inventing a page', () => {
  const got = cardFromResult(JSON.stringify({ success: true }), 'ABC-12');
  assert.equal(got.url, null);
  assert.equal(got.title, null);
});

test('gh issue: action subcommands write, view reads, list names nothing', () => {
  assert.deepEqual(parseGhIssues('gh issue close 42'), [{ number: 42, evidence: 'wrote', repo: null }]);
  assert.deepEqual(parseGhIssues('gh issue comment 7 --body "done"'), [{ number: 7, evidence: 'wrote', repo: null }]);
  assert.deepEqual(parseGhIssues('gh issue view 13 --json title,state'), [
    { number: 13, evidence: 'read', repo: null },
  ]);
  // `list` asks for all of them: no issue is named, so no card may be claimed.
  assert.deepEqual(parseGhIssues('gh issue list --state open'), []);
  // A creation carries no number — the forge assigns it.
  assert.deepEqual(parseGhIssues('gh issue create --title x'), [{ number: null, evidence: 'wrote', repo: null }]);
  // Behind a `cd`, which is how half the commands in a real transcript are written.
  assert.deepEqual(parseGhIssues('cd repo && gh issue reopen 5'), [{ number: 5, evidence: 'wrote', repo: null }]);
  assert.deepEqual(parseGhIssues('ls -la'), []);
});

test('a flag value is never mistaken for an issue number', () => {
  assert.deepEqual(parseGhIssues('gh issue view -R owner/repo 88'), [
    { number: 88, evidence: 'read', repo: 'owner/repo' },
  ]);
});

test('an issue given as a url is the same issue', () => {
  assert.deepEqual(parseGhIssues('gh issue view https://forge.example.com/owner/repo/issues/123'), [
    { number: 123, evidence: 'read', repo: 'forge.example.com/owner/repo' },
  ]);
});

// Found on real data, not in a fixture: a command that merely CONTAINS the words was read as an
// invocation, and filed issue #19 under a session that never touched one. Any word passed for a
// subcommand, and the number was taken from anywhere after it.
test('prose containing the words is not an invocation', () => {
  assert.deepEqual(parseGhIssues('echo "sessions w/ gh issue: $(grep -rl \'gh issue\' $P | wc -l)"'), []);
  assert.deepEqual(parseGhIssues("write('the corpus gh issue has 19 calls, all reads')"), []);
  assert.deepEqual(parseGhIssues('gh issue status'), [], 'status names no issue');
  // Also from real data: a heredoc where the phrase ends a line and a shell loop follows. The
  // arguments of a command stop at its line — they do not run on into the next one.
  assert.deepEqual(parseGhIssues('# Correct format for gh issue view\nfor n in 6235 18435; do echo $n; done'), []);
  // And from this very branch: a heredoc that WRITES a command as data. A command starts after a
  // separator, never in the middle of a quoted string.
  assert.deepEqual(parseGhIssues(`python3 - <<'PY'\ns = "expect(parse('gh issue comment 7 --body x'))"\nPY`), []);
});

test('a command still counts wherever a shell would really start one', () => {
  const ok = (cmd: string) => parseGhIssues(cmd).length === 1;
  assert.ok(ok('gh issue view 1'));
  assert.ok(ok('cd repo && gh issue view 1'));
  assert.ok(ok('cd repo; gh issue view 1'));
  assert.ok(ok('N=$(gh issue view 1 --json number)'));
  assert.ok(ok('  gh issue view 1'));
  assert.ok(ok('true\ngh issue view 1'));
});

// `gh` takes the issue's repository as a flag, and most reads in this corpus use it: they are
// issues of OTHER projects, read as documentation. Scoping them to the session's own repo would
// key them wrongly and link to a page that does not exist.
test("an explicit --repo is the issue's repository, not the session's", () => {
  assert.deepEqual(parseGhIssues('gh issue view 42 --repo owner/other'), [
    { number: 42, evidence: 'read', repo: 'owner/other' },
  ]);
  assert.deepEqual(parseGhIssues('gh issue view 42 --repo=owner/other'), [
    { number: 42, evidence: 'read', repo: 'owner/other' },
  ]);
  assert.deepEqual(parseGhIssues('gh issue close 7 -R forge.example.com/owner/other'), [
    { number: 7, evidence: 'wrote', repo: 'forge.example.com/owner/other' },
  ]);
  assert.deepEqual(parseGhIssues('gh issue close 7'), [{ number: 7, evidence: 'wrote', repo: null }]);
});

test('closing keywords in a commit message name the issues it changes', () => {
  assert.deepEqual(closingRefs('git commit -m "feat: thing\n\nCloses #42, fixes #7"'), [42, 7]);
  assert.deepEqual(closingRefs('git commit -m "mentions #9 but closes nothing"'), []);
});

test('gh output gives back the issue it created and the title it viewed', () => {
  assert.deepEqual(ghIssueFromResult('https://forge.example.com/owner/repo/issues/128\n'), {
    number: 128,
    url: 'https://forge.example.com/owner/repo/issues/128',
  });
  assert.equal(ghIssueFromResult('nothing here'), null);
  assert.equal(ghTitleFromResult('title:\tFix the thing\nstate:\tOPEN'), 'Fix the thing');
  assert.equal(ghTitleFromResult('{"title":"Fix the thing"}'), 'Fix the thing');
  assert.equal(ghTitleFromResult('no title at all'), null);
});

// Every one of these was copied from a real run, not imagined. The last two are why a title is
// worth looking for beyond `view`: closing an issue yields one without asking, and a wrapper that
// reformats gh's output would otherwise cost the row its title.
test('a title is taken from whichever shape the forge printed', () => {
  assert.equal(
    ghTitleFromResult('✓ Closed issue owner/repo#2 (Fix the thing)'),
    'Fix the thing',
    "gh's own close confirmation carries it",
  );
  assert.equal(ghTitleFromResult('✓ Reopened issue owner/repo#2 (Fix the thing)'), 'Fix the thing');
  assert.equal(
    ghTitleFromResult('[open] Issue #2: Fix the thing\n  Author: @someone\n  Status: OPEN'),
    'Fix the thing',
    'a reformatted output still names the issue and its title',
  );
  // A comment's output is a url and nothing else: no title to find, and none invented.
  assert.equal(ghTitleFromResult('https://forge.example.com/owner/repo/issues/2#issuecomment-1'), null);
});

test('touches merge per card: a write anywhere wins, the last title stays, count is kept', () => {
  const t = (over: Partial<Parameters<typeof mergeTouches>[0][number]>) => ({
    key: 'ABC-12',
    id: 'ABC-12',
    title: null,
    url: null,
    evidence: 'read' as const,
    source: 'mcp' as const,
    at: 1000,
    ...over,
  });
  const merged = mergeTouches([
    t({ at: 3000, title: 'Renamed', evidence: 'read' }),
    t({ at: 1000, title: 'Original', url: 'https://tracker.example.com/t/issue/ABC-12/original', evidence: 'wrote' }),
    t({ at: 2000, key: 'ABC-99', id: 'ABC-99', title: 'Other' }),
  ]);
  assert.equal(merged.length, 2);
  // Newest touch first.
  assert.deepEqual(
    merged.map((c) => c.id),
    ['ABC-12', 'ABC-99'],
  );
  const first = merged[0];
  assert.ok(first);
  assert.equal(first.evidence, 'wrote', 'a session that wrote once did not merely read');
  assert.equal(first.title, 'Renamed', 'the name the session left behind, not the one it found');
  assert.equal(
    first.url,
    'https://tracker.example.com/t/issue/ABC-12/original',
    'a url survives a touch that had none',
  );
  assert.equal(first.touches, 2);
  assert.equal(first.at, 3000);
});

test('a comment-only card keeps its id even with nothing else to show', () => {
  const merged = mergeTouches([
    { key: 'ABC-5', id: 'ABC-5', title: null, url: null, evidence: 'wrote', source: 'mcp', at: 1 },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.title, null);
});

test('the search query test admits keys, and costs nothing when they name no card', () => {
  assert.ok(looksLikeCardId('ABC-12'));
  assert.ok(looksLikeCardId('#42'));
  // Junk keys DO pass the shape test on purpose — the lookup answers from ids observed in tool
  // calls, so being strict here would only lose real trackers.
  assert.ok(looksLikeCardId('GPT-4'));
  assert.ok(!looksLikeCardId('a whole sentence'));
  assert.ok(!looksLikeCardId(''));
});
