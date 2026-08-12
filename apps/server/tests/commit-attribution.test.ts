import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  attributeCommits,
  type CommitCall,
  harvestHashes,
  isGitCommit,
  looksLikeCommitHash,
  type RepoCommit,
} from '../src/core/commit-attribution.ts';

const T = 1_700_000_000_000;
const commit = (hash: string, atOffsetSec: number, subject: string): RepoCommit => ({
  hash,
  authoredAt: T + atOffsetSec * 1000,
  subject,
});
const call = (atOffsetSec: number, command: string, outputHashes: string[] = []): CommitCall => ({
  at: T + atOffsetSec * 1000,
  command,
  outputHashes,
});

test('isGitCommit survives the forms real transcripts carry', () => {
  assert.ok(isGitCommit('git commit -m "x"'));
  assert.ok(isGitCommit('git -C /repo commit -m "x"'), 'git -C <path> commit');
  assert.ok(isGitCommit('git -c user.name=x commit -m "y"'), 'git -c k=v commit');
  assert.ok(isGitCommit('git add -A && git commit -q -F -'), 'second in a chain');
  assert.ok(!isGitCommit('git log --oneline'));
  assert.ok(!isGitCommit('echo "commit"'));
  assert.ok(isGitCommit('git --git-dir=/r/.git --work-tree=/r commit'), 'flags carrying no value');
});

test('a git command that never reaches `commit` is rejected without backtracking', () => {
  // The shape CodeQL named (`js/redos`, high): a long run of flags, and no `commit` to end on. The
  // regex that shipped explored every way of pairing them — 685ms at 40, and nothing bounds a
  // transcript's `command` field. The margin here is four orders of magnitude, so the threshold
  // says nothing about how fast the machine is.
  const pathological = `git${' -a'.repeat(40)} X`;
  const started = performance.now();
  assert.equal(isGitCommit(pathological), false);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 200, `took ${elapsed.toFixed(0)}ms — the match is backtracking again`);
});

test('harvestHashes takes hex tokens of git length only', () => {
  assert.deepEqual(harvestHashes('[main 0d702a0] Repo layout'), ['0d702a0']);
  assert.deepEqual(harvestHashes('abc 12345 deadbeef'), ['deadbeef'], 'shorter than 7 is not a hash');
});

test('the hash in the call output proves it, with no time window and no subject', () => {
  const c = commit('0d702a0f11223344556677889900aabbccddeeff', 0, 'Repo layout: move the server');
  const sessions = [{ sessionId: 'A', calls: [call(1, 'git commit -q -F -', ['0d702a0'])] }];
  assert.deepEqual(attributeCommits([c], sessions), [{ hash: c.hash, sessionId: 'A', evidence: 'proof' }]);
});

test("two sessions committing at the same second do not steal each other's commit", () => {
  const mine = commit('aaaaaaa1111111111111111111111111111111111', 0, 'Mine');
  const theirs = commit('bbbbbbb2222222222222222222222222222222222', 1, 'Theirs');
  const sessions = [
    { sessionId: 'A', calls: [call(2, 'git commit -q -F -', ['aaaaaaa'])] },
    { sessionId: 'B', calls: [call(2, 'git commit -q -F -', ['bbbbbbb'])] },
  ];
  const got = attributeCommits([mine, theirs], sessions);
  assert.deepEqual(
    got.map((a) => [a.hash.slice(0, 7), a.sessionId]),
    [
      ['aaaaaaa', 'A'],
      ['bbbbbbb', 'B'],
    ],
  );
});

test('a call that PRINTS older commits does not claim them', () => {
  // `git commit && git log --oneline -3`: the output names three hashes, two of them older and
  // made by another session. Only the one authored after this session's previous call is proven.
  const old1 = commit('1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', -600, 'Older, someone else');
  const old2 = commit('2222222aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', -300, 'Also older');
  const fresh = commit('3333333aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 10, 'Just made');
  const sessions = [
    {
      sessionId: 'A',
      calls: [
        call(-60, 'git commit -q -m "earlier"', []),
        call(12, 'git commit -q && git log --oneline -3', ['3333333', '2222222', '1111111']),
      ],
    },
  ];
  const got = attributeCommits([old1, old2, fresh], sessions);
  assert.deepEqual(got, [{ hash: fresh.hash, sessionId: 'A', evidence: 'proof' }]);
});

test('with no hash in the output, the subject in the command carries it — once', () => {
  const c = commit('cccccccdddddddddddddddddddddddddddddddddd', 0, 'Restart the numbering when the transcript does');
  const sessions = [
    { sessionId: 'A', calls: [call(5, 'git commit -q -m "Restart the numbering when the transcript does"')] },
    { sessionId: 'B', calls: [call(5, 'git commit -q -m "Something entirely different"')] },
  ];
  assert.deepEqual(attributeCommits([c], sessions), [{ hash: c.hash, sessionId: 'A', evidence: 'testimony' }]);
});

test('two sessions with the same subject in the window leave the commit unattributed', () => {
  const c = commit('eeeeeee999999999999999999999999999999999', 0, 'Format three files Biome was already flagging');
  const cmd = 'git commit -q -m "Format three files Biome was already flagging"';
  const sessions = [
    { sessionId: 'A', calls: [call(3, cmd)] },
    { sessionId: 'B', calls: [call(4, cmd)] },
  ];
  assert.deepEqual(attributeCommits([c], sessions), [], 'never handed to the nearest one');
});

test('proof outranks a competing testimony', () => {
  const c = commit('fffffff888888888888888888888888888888888', 0, 'Ship the thing');
  const sessions = [
    { sessionId: 'A', calls: [call(2, 'git commit -q -F -', ['fffffff'])] },
    { sessionId: 'B', calls: [call(2, 'git commit -m "Ship the thing"')] },
  ];
  assert.deepEqual(attributeCommits([c], sessions), [{ hash: c.hash, sessionId: 'A', evidence: 'proof' }]);
});

test('a commit nobody committed near stays unattributed', () => {
  const c = commit('0000000777777777777777777777777777777777', 0, 'Made by hand in a terminal');
  const sessions = [{ sessionId: 'A', calls: [call(1000, 'git commit -m "unrelated"')] }];
  assert.deepEqual(attributeCommits([c], sessions), []);
});

test('looksLikeCommitHash accepts what git abbreviates to, and nothing else', () => {
  assert.ok(looksLikeCommitHash('0f72393'), 'the short form git prints');
  assert.ok(looksLikeCommitHash('0f723935a3d905cd1f5a969a295070c70b7b0f8e'), 'the full 40');
  assert.ok(looksLikeCommitHash('  0F72393 '), 'trimmed and case-folded');
  assert.ok(!looksLikeCommitHash('0f7239'), 'six is below git’s own floor');
  assert.ok(!looksLikeCommitHash('0f72393 tray'), 'a hash plus a word is a text query');
  assert.ok(!looksLikeCommitHash('deadbeefz'), 'not hex');
  assert.ok(!looksLikeCommitHash(''), 'empty');
});
