import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { SessionRecord } from '../src/core/types.ts';
import {
  buildSearchRows,
  createSearchIndex,
  defaultIndexFile,
  extractDialogue,
  matchDialogue,
  queryTerms,
  subjectOf,
} from '../src/server/search-index.ts';

// Every fixture below is a RAW jsonl line in the shape Claude Code really writes (field names
// verified against live transcripts 2026-07-29), synthetic in content. A fixture whose shape was
// guessed tests the guess, not the parser.

const L = {
  typed: (text: string) =>
    JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      promptId: 'p1',
      type: 'user',
      message: { role: 'user', content: text },
      uuid: 'u1',
      timestamp: '2026-07-29T10:00:00.000Z',
      permissionMode: 'default',
      origin: { kind: 'human' },
      promptSource: 'typed',
      userType: 'external',
      entrypoint: 'cli',
      cwd: '/home/dev/proj',
      sessionId: 's1',
      version: '2.1.220',
    }),
  command: (name: string, args: string) =>
    JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      type: 'user',
      message: {
        role: 'user',
        content: `<command-name>/${name}</command-name>\n            <command-message>${name}</command-message>\n            <command-args>${args}</command-args>`,
      },
      uuid: 'u2',
      timestamp: '2026-07-29T10:01:00.000Z',
      userType: 'external',
      entrypoint: 'cli',
      cwd: '/home/dev/proj',
      sessionId: 's1',
      version: '2.1.220',
    }),
  assistant: (text: string) =>
    JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      type: 'assistant',
      requestId: 'req_1',
      message: { id: 'msg_1', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text }] },
      uuid: 'u3',
      timestamp: '2026-07-29T10:02:00.000Z',
      userType: 'external',
      entrypoint: 'cli',
      cwd: '/home/dev/proj',
      sessionId: 's1',
      version: '2.1.220',
    }),
  toolResult: (text: string) =>
    JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      promptId: 'p1',
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: text }] },
      uuid: 'u4',
      timestamp: '2026-07-29T10:03:00.000Z',
      toolUseResult: { stdout: text },
      userType: 'external',
      entrypoint: 'cli',
      cwd: '/home/dev/proj',
      sessionId: 's1',
      version: '2.1.220',
    }),
  taskNotification: (text: string) =>
    JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      promptId: 'p1',
      type: 'user',
      message: { role: 'user', content: `<task-notification>\n<task-id>a1</task-id>\n${text}\n</task-notification>` },
      uuid: 'u5',
      timestamp: '2026-07-29T10:04:00.000Z',
      origin: { kind: 'task-notification' },
      promptSource: 'system',
      userType: 'external',
      entrypoint: 'cli',
      cwd: '/home/dev/proj',
      sessionId: 's1',
      version: '2.1.220',
    }),
  meta: (text: string) =>
    JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      type: 'user',
      isMeta: true,
      message: { role: 'user', content: text },
      uuid: 'u6',
      timestamp: '2026-07-29T10:05:00.000Z',
      userType: 'external',
      entrypoint: 'cli',
      cwd: '/home/dev/proj',
      sessionId: 's1',
      version: '2.1.220',
    }),
};

const dialogue = (...lines: string[]) => extractDialogue(lines.join('\n'));

// --- what the dialogue IS -----------------------------------------------------------------

test('the dialogue is the prompts and the assistant prose, in file order, with the speaker', () => {
  const segs = dialogue(
    L.typed('fix the toast eviction'),
    L.assistant('the rail evicts the oldest toast first'),
    L.typed('verify it'),
  );
  assert.deepEqual(segs, [
    { who: 'you', text: 'fix the toast eviction' },
    { who: 'claude', text: 'the rail evicts the oldest toast first' },
    { who: 'you', text: 'verify it' },
  ]);
});

test('a slash command contributes its ARGUMENTS, never its <command-name> wrapper', () => {
  const segs = dialogue(L.command('review', 'check the eviction order'));
  assert.deepEqual(segs, [{ who: 'you', text: 'check the eviction order' }]);
  // The wrapper leaking into the corpus is not cosmetic: it made `clear` match every session
  // that ever ran /clear, i.e. nearly all of them.
  const hay = segs
    .map((s) => s.text)
    .join('\n')
    .toLowerCase();
  assert.ok(!hay.includes('command-name'));
  assert.ok(!hay.includes('review'), 'the command NAME is not part of what the user said');
});

test('an argument-less command contributes its own name, not an empty segment', () => {
  assert.deepEqual(dialogue(L.command('clear', '')), [{ who: 'you', text: '/clear' }]);
});

test('tool results, task notifications and meta injections are not dialogue', () => {
  const segs = dialogue(
    L.toolResult('span-store.ts: 400 lines'),
    L.taskNotification('agent finished span-store work'),
    L.meta('injected skill body about span-store'),
    L.typed('what did the agent do?'),
  );
  assert.deepEqual(segs, [{ who: 'you', text: 'what did the agent do?' }]);
});

test('a truncated final line does not lose the lines before it', () => {
  const raw = [L.typed('first'), L.assistant('second'), '{"type":"user","mess'].join('\n');
  assert.equal(extractDialogue(raw).length, 2);
});

// --- the subject --------------------------------------------------------------------------

test('the subject skips CONTROL commands and names the session by its task', () => {
  const raw = [L.command('clear', ''), L.command('model', 'opus'), L.typed('build the search tab')].join('\n');
  assert.equal(subjectOf(raw), 'build the search tab');
});

test('a NON-control command is a task, so it is the subject', () => {
  assert.equal(subjectOf(L.command('review', 'the eviction order')), 'the eviction order');
});

test('a session with nothing but control commands has no subject', () => {
  assert.equal(subjectOf([L.command('clear', ''), L.command('cost', '')].join('\n')), null);
});

// --- matching -----------------------------------------------------------------------------

test('every word is an AND term — a missing one drops the session', () => {
  const segs = dialogue(L.typed('the toast rail freezes'));
  const hay = segs
    .map((s) => s.text)
    .join('\n')
    .toLowerCase();
  assert.ok(matchDialogue(segs, hay, ['toast', 'rail']));
  assert.equal(matchDialogue(segs, hay, ['toast', 'eviction']), null);
});

test('adding a term can never widen the result set', () => {
  const corpus = [
    dialogue(L.typed('toast eviction in the rail')),
    dialogue(L.typed('toast only')),
    dialogue(L.assistant('eviction only')),
  ];
  const hit = (terms: string[]) =>
    corpus.filter((segs) =>
      matchDialogue(
        segs,
        segs
          .map((s) => s.text)
          .join('\n')
          .toLowerCase(),
        terms,
      ),
    ).length;
  assert.equal(hit(['toast']), 2);
  assert.equal(hit(['toast', 'eviction']), 1, 'the second word drops the session that lacks it');
});

test('hits counts every occurrence of every term, and chars is the dialogue ITSELF', () => {
  const segs = dialogue(L.typed('toast toast'), L.assistant('a toast and an eviction'));
  const hay = segs
    .map((s) => s.text)
    .join('\n')
    .toLowerCase();
  const m = matchDialogue(segs, hay, ['toast', 'eviction'])!;
  assert.equal(m.hits, 4); // three `toast` + one `eviction`
  // The denominator of the density is what was SAID — not the separators the matcher joins the
  // utterances with. Counting those inflated short sessions by up to 12.5% (measured over 895 real
  // sessions; 303 of them by more than 1%), and density is the order the tab opens on, decided
  // precisely on the short rows.
  assert.equal(
    m.chars,
    segs.reduce((n, seg) => n + seg.text.length, 0),
  );
  assert.equal(m.chars, hay.length - 1, 'one separator between two segments, not counted');
});

test('an empty query matches nothing — it is not "everything"', () => {
  const segs = dialogue(L.typed('anything'));
  assert.equal(matchDialogue(segs, 'anything', []), null);
  assert.deepEqual(queryTerms('   '), []);
});

test('the query is split into terms and lowercased', () => {
  assert.deepEqual(queryTerms('  Toast   Eviction '), ['toast', 'eviction']);
});

// --- snippets -----------------------------------------------------------------------------

test('the snippet prefers the passage where the most DISTINCT terms cluster', () => {
  const segs = dialogue(
    L.typed('toast. '.repeat(20)), // one term, many times
    L.assistant('here the toast eviction is decided together'), // both terms, once
  );
  const hay = segs
    .map((s) => s.text)
    .join('\n')
    .toLowerCase();
  const m = matchDialogue(segs, hay, ['toast', 'eviction'])!;
  assert.ok(m.snippets.length >= 1);
  assert.equal(m.snippets[0]!.who, 'claude');
  assert.ok(m.snippets[0]!.text.includes('eviction'));
});

test('a snippet carries who said it, and at most two are returned', () => {
  const segs = dialogue(
    L.typed('toast one'),
    L.assistant('toast two'),
    L.typed('toast three'),
    L.assistant('toast four'),
  );
  const hay = segs
    .map((s) => s.text)
    .join('\n')
    .toLowerCase();
  const m = matchDialogue(segs, hay, ['toast'])!;
  assert.equal(m.snippets.length, 2);
  for (const s of m.snippets) assert.ok(s.who === 'you' || s.who === 'claude');
});

// --- the join with the roster --------------------------------------------------------------

function rec(id: string, over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: id,
    project: 'proj',
    model: null,
    lastActivity: 1_700_000_000_000,
    isActive: false,
    isOpen: false,
    status: null,
    waitingFor: null,
    waitingSince: null,
    subject: 'do ' + id,
    entrypoint: 'cli',
    root: 'cli',
    path: '/home/dev/.claude/projects/p/' + id + '.jsonl',
    ...over,
  };
}

test('a row takes its identity from the roster and its score from the index', () => {
  const roster = [rec('alpha'), rec('beta', { entrypoint: 'sdk-cli', subject: null })];
  const rows = buildSearchRows(roster, [
    { path: roster[0]!.path, hits: 3, chars: 300, snippets: [{ who: 'you', text: 'x' }] },
    { path: roster[1]!.path, hits: 9, chars: 90_000, snippets: [] },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.sessionId, 'alpha');
  assert.equal(rows[0]!.subject, 'do alpha');
  assert.equal(rows[1]!.entrypoint, 'sdk-cli', 'the species travels with the row — the client splits on it');
  // Density is the ratio the client ranks on: the small session is denser despite fewer hits.
  assert.ok(rows[0]!.hits / rows[0]!.chars > rows[1]!.hits / rows[1]!.chars);
});

test('a match whose session left the roster is dropped — a row that cannot be opened is not a result', () => {
  const rows = buildSearchRows([rec('alpha')], [{ path: '/home/dev/gone.jsonl', hits: 5, chars: 100, snippets: [] }]);
  assert.deepEqual(rows, []);
});

// --- the persistent incremental index ------------------------------------------------------

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'seedeep-search-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('the index finds a session, and reads each file once until it changes', async () => {
  await withTmp(async (dir) => {
    const a = join(dir, 'a.jsonl');
    await writeFile(a, [L.typed('the toast rail freezes'), L.assistant('fixed the eviction')].join('\n'));
    const reads: string[] = [];
    const index = createSearchIndex({
      indexFile: join(dir, 'index.jsonl'),
      read: (p) => {
        reads.push(p);
        return readFile(p, 'utf8');
      },
    });

    await index.refresh([a]);
    assert.deepEqual(reads, [a]);
    const first = index.search('toast eviction');
    assert.deepEqual(first.terms, ['toast', 'eviction']);
    assert.equal(first.matches.length, 1);
    assert.equal(first.matches[0]!.hits, 2);

    // Unchanged (size, mtime) → not re-read. The whole point of the file.
    await index.refresh([a]);
    assert.deepEqual(reads, [a], 'an unchanged session is not read a second time');

    // Changed → re-read, and the new words are searchable.
    await writeFile(a, [L.typed('the toast rail freezes'), L.assistant('now the lane is wrong')].join('\n'));
    await utimes(a, new Date(), new Date(Date.now() + 1000));
    await index.refresh([a]);
    assert.equal(reads.length, 2);
    assert.equal(index.search('lane').matches.length, 1);
    assert.equal(index.search('eviction').matches.length, 0, 'the stale dialogue is gone, not merged');
  });
});

test('a session that vanished leaves the index', async () => {
  await withTmp(async (dir) => {
    const a = join(dir, 'a.jsonl');
    await writeFile(a, L.typed('toast'));
    const index = createSearchIndex({ indexFile: join(dir, 'index.jsonl') });
    await index.refresh([a]);
    assert.equal(index.search('toast').matches.length, 1);
    await rm(a);
    await index.refresh([a]);
    assert.equal(index.search('toast').matches.length, 0);
  });
});

test('the index survives a restart without re-reading the corpus', async () => {
  await withTmp(async (dir) => {
    const a = join(dir, 'a.jsonl');
    const indexFile = join(dir, 'index.jsonl');
    await writeFile(a, [L.typed('the toast rail'), L.assistant('the eviction is FIFO')].join('\n'));
    await createSearchIndex({ indexFile }).refresh([a]);

    const reads: string[] = [];
    const revived = createSearchIndex({
      indexFile,
      read: (p) => {
        reads.push(p);
        return readFile(p, 'utf8');
      },
    });
    await revived.refresh([a]);
    assert.deepEqual(reads, [], 'a persisted, unchanged session is never re-read');
    const m = revived.search('toast eviction');
    assert.equal(m.matches.length, 1);
    assert.equal(m.matches[0]!.snippets.length, 2, 'the speakers survived the round trip');
  });
});

test('an entry whose segments no longer have the current shape is re-read, not loaded', async () => {
  // A renamed field on DialogueSegment without an INDEX_VERSION bump would otherwise load segments
  // whose text is `undefined` — a corpus that silently matches nothing. `aggregate-cache.ts` paid
  // for exactly this once (v6 reused for two shapes), so the guard is the same one.
  //
  // The stored stamp must MATCH the file on disk, or staleness alone would force the re-read and
  // the shape check would never be the thing under test.
  await withTmp(async (dir) => {
    const a = join(dir, 'a.jsonl');
    const indexFile = join(dir, 'index.jsonl');
    await writeFile(a, L.typed('the toast rail'));
    const st = await stat(a);
    // An entry written by a future shape: the text lives under `body`, not `text`.
    await writeFile(
      indexFile,
      [
        JSON.stringify({ index: 'seedeep-search', version: 1 }),
        JSON.stringify({ path: a, mtime: st.mtimeMs, size: st.size, segs: [{ who: 'you', body: 'the toast rail' }] }),
      ].join('\n'),
    );

    const reads: string[] = [];
    const index = createSearchIndex({
      indexFile,
      read: (p) => {
        reads.push(p);
        return readFile(p, 'utf8');
      },
    });
    await index.refresh([a]);
    assert.deepEqual(reads, [a], 'the unreadable shape is discarded and the session re-read');
    assert.equal(index.search('toast').matches.length, 1, 'and its dialogue is searchable again');
  });
});

test('a corrupt or foreign index file is rebuilt, not trusted', async () => {
  await withTmp(async (dir) => {
    const a = join(dir, 'a.jsonl');
    const indexFile = join(dir, 'index.jsonl');
    await writeFile(a, L.typed('toast'));
    await writeFile(indexFile, '{"index":"something-else","version":99}\n{"path":"/gone","segs":[]}');
    const index = createSearchIndex({ indexFile });
    await index.refresh([a]);
    const m = index.search('toast');
    assert.equal(m.matches.length, 1);
    assert.equal(m.matches[0]!.path, a, 'the foreign entry never entered the index');
  });
});

test('a search that lands DURING a refresh must not leave a stale haystack behind', async () => {
  // The lowercased dialogue is derived, and a derived value keyed by PATH has to be invalidated by
  // hand — which is a promise about ordering. It was broken: the invalidation ran inside the
  // refresh loop while the live map still held the OLD entry, so a search landing between the two
  // (two files change; the second one's read is where a concurrent request gets in) re-derived the
  // haystack from the text being replaced, and that stale copy then outlived the swap. The session
  // stayed findable by words it no longer contained and invisible by the ones it had just gained,
  // until it changed again. Keying the derivation on the ENTRY makes the state unreachable.
  await withTmp(async (dir) => {
    const a = join(dir, 'a.jsonl');
    const b = join(dir, 'b.jsonl');
    await writeFile(a, L.typed('the OLDWORD rail'));
    await writeFile(b, L.typed('unrelated'));

    let index: ReturnType<typeof createSearchIndex>;
    let raced = false;
    index = createSearchIndex({
      indexFile: join(dir, 'index.jsonl'),
      read: async (p) => {
        if (p === b && !raced) {
          raced = true;
          index.search('oldword');
        } // a request, mid-refresh
        return readFile(p, 'utf8');
      },
    });

    await index.refresh([a, b]);
    index.search('oldword'); // warms the derivation for `a`
    await writeFile(a, L.typed('the NEWWORD rail'));
    await utimes(a, new Date(), new Date(Date.now() + 2000));
    await writeFile(b, L.typed('also changed'));
    await utimes(b, new Date(), new Date(Date.now() + 2000));
    raced = false;
    await index.refresh([a, b]);

    assert.equal(index.search('newword').matches.length, 1, 'the words it just gained are findable');
    assert.equal(index.search('oldword').matches.length, 0, 'the words it lost are gone');
  });
});

test('searching before any refresh answers empty rather than throwing', () => {
  const index = createSearchIndex({ indexFile: join(tmpdir(), 'seedeep-never-written.jsonl') });
  assert.deepEqual(index.search('toast').matches, []);
});

test('the index lives beside the aggregate cache, in seedeep’s own directory', () => {
  // The default layout, so an exported SEEDEEP_HOME must not decide it — see config.test.ts.
  delete process.env['SEEDEEP_HOME'];
  assert.equal(defaultIndexFile('/home/dev'), '/home/dev/.seedeep/search-index.jsonl');
});
