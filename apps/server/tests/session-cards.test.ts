import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { SessionRecord } from '../src/core/types.ts';
import { repoSlug } from '../src/server/git.ts';
import { startServer } from '../src/server/server.ts';
import { cardsForSession, namedScope } from '../src/server/session-cards.ts';

// From RAW jsonl through the real scanner, not from touches built by hand: a fixture assembled
// from what I believe the lines look like cannot discover that the parser drops a whole class of
// them. The SHAPE below is copied from a real transcript — a tool_use block carries
// {type,id,name,input}; a tool_result's text lives in content[].text, holding the tool's JSON as a
// string. The CONTENT is synthetic (fake tracker, fake host, fake keys).
//
// What a plausible bug here looks like: a key-shaped string in a call's body becoming a card, a
// subagent's card never reaching its parent, a creation lost because its input names nothing, or a
// `gh issue` command silently ignored.

const ts = (n: number) => new Date(Date.UTC(2026, 7, 2, 10, n)).toISOString();

const toolUse = (minute: number, id: string, name: string, input: unknown) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: ts(minute),
    cwd: '/home/dev/project',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  });

const toolResult = (minute: number, toolUseId: string, text: string) =>
  JSON.stringify({
    type: 'user',
    timestamp: ts(minute),
    cwd: '/home/dev/project',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'text', text }] }],
    },
  });

const card = (id: string, title: string) =>
  JSON.stringify({
    id,
    title,
    description: 'body',
    url: `https://tracker.example.com/t/issue/${id}/${title.toLowerCase()}`,
  });

function writeSession(mainLines: string[], childLines: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-cards-'));
  const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const path = join(dir, `${uuid}.jsonl`);
  writeFileSync(path, mainLines.join('\n') + '\n');
  if (childLines.length) {
    const subDir = join(dir, uuid, 'subagents');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, 'agent-ag1.jsonl'), childLines.join('\n') + '\n');
  }
  return path;
}

const record = (path: string, sessionId = 'sess-1'): SessionRecord => ({
  sessionId,
  project: 'demo',
  model: null,
  lastActivity: 1,
  isActive: false,
  isOpen: false,
  status: null,
  waitingFor: null,
  waitingSince: null,
  subject: null,
  entrypoint: null,
  root: 'cli',
  path,
});

/** A session that touches cards every way the corpus does. */
function fullSession(): string {
  return writeSession(
    [
      // read, then write, the same card: one row, `wrote`, two touches
      toolUse(1, 'tu-1', 'mcp__linear__get_issue', { id: 'ABC-12' }),
      toolResult(2, 'tu-1', card('ABC-12', 'First')),
      toolUse(3, 'tu-2', 'mcp__linear__save_issue', { id: 'ABC-12', title: 'Renamed' }),
      toolResult(4, 'tu-2', card('ABC-12', 'Renamed')),
      // a comment: its result names no card, so this row survives on its id alone
      toolUse(5, 'tu-3', 'mcp__linear__save_comment', { issueId: 'ABC-99', body: 'note' }),
      toolResult(6, 'tu-3', JSON.stringify({ success: true })),
      // a creation: the input names nothing, the result does
      toolUse(7, 'tu-4', 'mcp__linear__save_issue', { title: 'Brand new' }),
      toolResult(8, 'tu-4', card('ABC-40', 'Brandnew')),
      // a key-shaped string that is not a card, in a call's body
      toolUse(9, 'tu-5', 'mcp__linear__save_issue', { id: 'ABC-12', description: 'uses SHA-256 and RSA-2048' }),
      toolResult(10, 'tu-5', card('ABC-12', 'Renamed')),
      // ...and a call whose body is ONLY key-shaped strings, with no id field to fall back on:
      // this is the exact shape that put `SHA-256` among the top four "cards" when the id was read
      // from the body instead of the field.
      toolUse(17, 'tu-9', 'mcp__linear__list_comments', { query: 'about SHA-256, RSA-2048 and UTF-8' }),
      toolResult(18, 'tu-9', JSON.stringify({ comments: [] })),
      // the forge's CLI, and a commit that closes an issue
      toolUse(11, 'tu-6', 'Bash', { command: 'gh issue close 42' }),
      toolResult(12, 'tu-6', 'Closed issue #42\n'),
      toolUse(13, 'tu-7', 'Bash', { command: 'git commit -m "feat: thing\n\nCloses #7"' }),
      toolResult(14, 'tu-7', '[main abc1234] feat: thing\n'),
    ],
    // a subagent's card belongs to the parent session
    [toolUse(15, 'tu-8', 'mcp__linear__get_issue', { id: 'ABC-77' }), toolResult(16, 'tu-8', card('ABC-77', 'Childs'))],
  );
}

test('every way a card is touched reaches the row, and nothing else does', async () => {
  const { cards } = await cardsForSession(record(fullSession()));
  const ids = cards.map((c) => c.id).sort();
  assert.deepEqual(ids, ['#42', '#7', 'ABC-12', 'ABC-40', 'ABC-77', 'ABC-99']);
  // The body's key-shaped strings never became cards.
  assert.ok(!ids.includes('SHA-256'), 'a string in the body is not a card');
  assert.ok(!ids.includes('RSA-2048'));

  const abc12 = cards.find((c) => c.id === 'ABC-12');
  assert.ok(abc12);
  assert.equal(abc12.evidence, 'wrote', 'read then written is written');
  assert.equal(abc12.touches, 3);
  assert.equal(abc12.title, 'Renamed');
  assert.equal(abc12.url, 'https://tracker.example.com/t/issue/ABC-12/renamed');

  const comment = cards.find((c) => c.id === 'ABC-99');
  assert.ok(comment);
  assert.equal(comment.evidence, 'wrote');
  assert.equal(comment.title, null, 'a comment result carries no title — the row says so');
  assert.equal(comment.url, null);

  const created = cards.find((c) => c.id === 'ABC-40');
  assert.ok(created, 'a creation names its card only in the result');
  assert.equal(created.evidence, 'wrote');

  const child = cards.find((c) => c.id === 'ABC-77');
  assert.ok(child, "a subagent's card is its parent's card");

  const closed = cards.find((c) => c.id === '#42');
  assert.ok(closed);
  assert.equal(closed.evidence, 'wrote');
  assert.equal(closed.source, 'cli');
  const viaCommit = cards.find((c) => c.id === '#7');
  assert.ok(viaCommit, 'a closing keyword in a commit message changes the issue');
  assert.equal(viaCommit.evidence, 'wrote');
});

// Found by opening a real issue and touching it both ways: `gh issue create --repo owner/name`
// keyed it one way and `gh issue view 2` (scoped through the session's cwd) another, so ONE issue
// rendered as two rows. A repository has one identity, whoever names it.
test('the same repository keys identically whether the command named it or the cwd did', () => {
  // No host in the command means gh's default, which is github.com — the case the real test hit.
  assert.equal(namedScope('owner/name').slug, repoSlug('https://github.com/owner/name'));
  assert.equal(namedScope('forge.example.com/owner/name').slug, repoSlug('https://forge.example.com/owner/name'));
});

// One Bash call often chains several commands, and a live test did exactly that: `gh issue comment
// 2 …; gh issue close 2` counted as ONE touch. Every issue a command names is a touch.
test('every issue named by a chained command is counted, not just the first', async () => {
  const path = writeSession([
    toolUse(1, 'tu-1', 'Bash', { command: 'gh issue comment 5 --body x; gh issue close 6' }),
    toolResult(2, 'tu-1', 'done\n'),
  ]);
  const { cards } = await cardsForSession(record(path));
  assert.deepEqual(cards.map((c) => c.id).sort(), ['#5', '#6']);
});

test('a session that touched no tracker returns nothing, without reading a repository', async () => {
  const path = writeSession([toolUse(1, 'tu-1', 'Bash', { command: 'ls -la' }), toolResult(2, 'tu-1', 'a\nb\n')]);
  assert.deepEqual((await cardsForSession(record(path))).cards, []);
});

test('a `gh issue view` is a read, not a claim that the session worked on it', async () => {
  const path = writeSession([
    toolUse(1, 'tu-1', 'Bash', { command: 'gh issue view 13 --json title' }),
    toolResult(2, 'tu-1', '{"title":"Someone else\'s issue"}'),
  ]);
  const { cards } = await cardsForSession(record(path));
  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.evidence, 'read');
  assert.equal(cards[0]?.title, "Someone else's issue");
});

test('a created issue is recovered from the url gh prints, since the command names no number', async () => {
  const path = writeSession([
    toolUse(1, 'tu-1', 'Bash', { command: 'gh issue create --title "New" --body x' }),
    toolResult(2, 'tu-1', 'Creating issue in owner/repo\n\nhttps://forge.example.com/owner/repo/issues/128\n'),
  ]);
  const { cards } = await cardsForSession(record(path));
  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.id, '#128');
  assert.equal(cards[0]?.evidence, 'wrote');
  // The link comes from what gh printed, not from a template built here.
  assert.equal(cards[0]?.url, 'https://forge.example.com/owner/repo/issues/128');
});

test('GET /api/search finds the session by the card it worked on, with an honest zero', async () => {
  const path = fullSession();
  const root = mkdtempSync(join(tmpdir(), 'seedeep-idx-'));
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [record(path)],
    port: 0,
    // Both indexes go to a temp dir: a test that writes the user's real index is a test that
    // corrupts their search results.
    indexFile: join(root, 'search.jsonl'),
    cardsIndexFile: join(root, 'cards.jsonl'),
  });
  try {
    const res = await fetch(`${srv.url}/api/search?q=ABC-12`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { rows: Array<{ sessionId: string; hits: number }> };
    const row = body.rows.find((r) => r.sessionId === 'sess-1');
    assert.ok(row, 'the session that acted on the card is returned');
    assert.equal(row.hits, 0, 'it never said the id, and the row says so rather than inventing a count');
    // A key-shaped query naming no card costs a lookup and returns nothing.
    const none = (await (await fetch(`${srv.url}/api/search?q=GPT-4`)).json()) as { rows: unknown[] };
    assert.deepEqual(none.rows, []);
  } finally {
    srv.stop();
  }
});

test('GET /api/cards returns the session cards; an unknown session is a 404', async () => {
  const path = fullSession();
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [record(path)],
    port: 0,
  });
  try {
    const res = await fetch(`${srv.url}/api/cards?sessionId=sess-1`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { cards: Array<{ id: string }> };
    assert.ok(body.cards.some((c) => c.id === 'ABC-12'));
    assert.equal((await fetch(`${srv.url}/api/cards?sessionId=nope`)).status, 404);
  } finally {
    srv.stop();
  }
});
