import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { SessionCard } from '../src/core/tracker-cards.ts';
import type { SessionRecord } from '../src/core/types.ts';
import { createCardsIndex } from '../src/server/cards-index.ts';

// What a plausible bug here looks like — every one of these is a way an index lies rather than
// breaks: answering from a stale entry after the session changed, re-reading everything anyway (the
// defect this file exists to fix), keeping a session that vanished, or loading a file written by an
// older shape and silently matching nothing.

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'seedeep-cardidx-'));
}

const card = (over: Partial<SessionCard> = {}): SessionCard => ({
  key: 'ABC-12',
  id: 'ABC-12',
  title: 'A title',
  url: 'https://tracker.example.com/t/issue/ABC-12/a-title',
  evidence: 'wrote',
  source: 'mcp',
  at: 1000,
  touches: 1,
  ...over,
});

/** A session on disk, so the index has a real (size, mtime) to stamp. */
function session(root: string, name: string, body = 'x'): SessionRecord {
  const path = join(root, `${name}.jsonl`);
  writeFileSync(path, body);
  return {
    sessionId: name,
    project: 'demo',
    model: null,
    lastActivity: 1,
    isActive: false,
    isOpen: false,
    status: null,
    waitingFor: null,
    waitingSince: null,
    statusDerived: false,
    subject: null,
    entrypoint: null,
    root: 'cli',
    path,
  };
}

test('a card id finds the sessions that touched it, newest first', async () => {
  const root = dir();
  const a = session(root, 'sess-a');
  const b = session(root, 'sess-b');
  const c = session(root, 'sess-c');
  const idx = createCardsIndex({
    indexFile: join(root, 'idx.jsonl'),
    load: async (rec) =>
      rec.sessionId === 'sess-a'
        ? { cards: [card({ at: 100 })] }
        : rec.sessionId === 'sess-b'
          ? { cards: [card({ at: 900 }), card({ key: 'ABC-9', id: 'ABC-9' })] }
          : { cards: [] },
  });
  await idx.refresh([a, b, c]);
  assert.deepEqual(idx.sessionsFor('ABC-12', [a, b, c]), ['sess-b', 'sess-a'], 'newest touch first');
  assert.deepEqual(idx.sessionsFor('abc-12', [a, b, c]), ['sess-b', 'sess-a'], 'case does not matter');
  assert.deepEqual(idx.sessionsFor('ABC-9', [a, b, c]), ['sess-b']);
  assert.deepEqual(idx.sessionsFor('ABC-404', [a, b, c]), [], 'an id nothing touched finds nothing');
});

test('a forge issue is found by the id typed, and kept apart by its repository', async () => {
  const root = dir();
  const a = session(root, 'sess-a');
  const b = session(root, 'sess-b');
  const idx = createCardsIndex({
    indexFile: join(root, 'idx.jsonl'),
    load: async (rec) => ({
      cards: [
        card({
          key: rec.sessionId === 'sess-a' ? 'github.com/owner/one#42' : 'github.com/owner/two#42',
          id: '#42',
          source: 'cli',
          at: rec.sessionId === 'sess-a' ? 10 : 20,
        }),
      ],
    }),
  });
  await idx.refresh([a, b]);
  // The user types `#42` and means "wherever it lives" — both repositories answer.
  assert.deepEqual(idx.sessionsFor('#42', [a, b]), ['sess-b', 'sess-a']);
  // The key still separates them, so one repository's issue can be asked for on its own.
  assert.deepEqual(idx.sessionsFor('github.com/owner/one#42', [a, b]), ['sess-a']);
});

test('an unchanged session is never re-read, and a changed one always is', async () => {
  const root = dir();
  const a = session(root, 'sess-a');
  const b = session(root, 'sess-b');
  const reads: string[] = [];
  let title = 'First';
  const idx = createCardsIndex({
    indexFile: join(root, 'idx.jsonl'),
    load: async (rec) => {
      reads.push(rec.sessionId);
      return { cards: [card({ title })] };
    },
  });
  await idx.refresh([a, b]);
  assert.deepEqual(reads.sort(), ['sess-a', 'sess-b'], 'the first pass reads everything');

  reads.length = 0;
  await idx.refresh([a, b]);
  assert.deepEqual(reads, [], 'nothing changed, so nothing is read — this is the whole point');

  // Rewriting one session must invalidate that one and only that one.
  title = 'Second';
  writeFileSync(a.path, 'xx');
  reads.length = 0;
  await idx.refresh([a, b]);
  assert.deepEqual(reads, ['sess-a'], 'only the changed session is re-read');
});

test('a session that changed is answered from its NEW cards, not its old ones', async () => {
  const root = dir();
  const a = session(root, 'sess-a');
  let cards = [card({ key: 'ABC-1', id: 'ABC-1' })];
  const idx = createCardsIndex({ indexFile: join(root, 'idx.jsonl'), load: async () => ({ cards }) });
  await idx.refresh([a]);
  assert.deepEqual(idx.sessionsFor('ABC-1', [a]), ['sess-a']);

  cards = [card({ key: 'ABC-2', id: 'ABC-2' })];
  writeFileSync(a.path, 'changed');
  await idx.refresh([a]);
  assert.deepEqual(idx.sessionsFor('ABC-2', [a]), ['sess-a'], 'the new card is found');
  assert.deepEqual(idx.sessionsFor('ABC-1', [a]), [], 'the old one is gone, not merely outranked');
});

test('a session that vanished is dropped; one absent from the roster is not answered for', async () => {
  const root = dir();
  const a = session(root, 'sess-a');
  const b = session(root, 'sess-b');
  const idx = createCardsIndex({ indexFile: join(root, 'idx.jsonl'), load: async () => ({ cards: [card()] }) });
  await idx.refresh([a, b]);
  assert.deepEqual(idx.sessionsFor('ABC-12', [a, b]), ['sess-b', 'sess-a'].sort());

  // b is still indexed but no longer in the roster: there is no row to build, so no answer.
  assert.deepEqual(idx.sessionsFor('ABC-12', [a]), ['sess-a']);
  // ...and once it is gone from disk too, the next refresh forgets it.
  await idx.refresh([a]);
  const persisted = readFileSync(join(root, 'idx.jsonl'), 'utf8');
  assert.ok(!persisted.includes('sess-b'), 'a dropped session leaves the file');
});

test('the index survives a restart, and a file from another shape is rebuilt rather than trusted', async () => {
  const root = dir();
  const file = join(root, 'idx.jsonl');
  const a = session(root, 'sess-a');
  const first = createCardsIndex({ indexFile: file, load: async () => ({ cards: [card()] }) });
  await first.refresh([a]);

  // A fresh instance, as after a restart: it must answer from the file without re-reading.
  const reads: string[] = [];
  const second = createCardsIndex({
    indexFile: file,
    load: async (rec) => {
      reads.push(rec.sessionId);
      return { cards: [] };
    },
  });
  await second.refresh([a]);
  // `.length`, not deepEqual against []: the strict assert narrows its argument to the expected
  // type, and `reads` would be `never[]` for the closure below.
  assert.equal(reads.length, 0, 'a persisted, unchanged session is not re-read after a restart');
  assert.deepEqual(second.sessionsFor('ABC-12', [a]), ['sess-a']);

  // A header from another version must be discarded, not half-trusted.
  writeFileSync(file, `${JSON.stringify({ index: 'seedeep-cards', version: 99 })}\n`);
  const third = createCardsIndex({
    indexFile: file,
    load: async (rec) => {
      reads.push(rec.sessionId);
      return { cards: [card()] };
    },
  });
  await third.refresh([a]);
  assert.deepEqual(reads, ['sess-a'], 'an unknown version rebuilds');
});

test('a stored card missing a field is discarded, not loaded as undefined', async () => {
  const root = dir();
  const file = join(root, 'idx.jsonl');
  const a = session(root, 'sess-a');
  // `evidence` absent: the shape check must reject the whole entry rather than index a card whose
  // fields read `undefined` — an index that matches nothing while looking populated.
  // The stamp must be the file's REAL one: with a fake stamp the entry is re-read for being stale,
  // and the test would pass whether or not the shape was ever checked.
  const st = statSync(a.path);
  writeFileSync(
    file,
    `${JSON.stringify({ index: 'seedeep-cards', version: 1 })}\n${JSON.stringify({
      path: a.path,
      mtime: st.mtimeMs,
      size: st.size,
      cards: [{ key: 'ABC-12', id: 'ABC-12', title: null, url: null, source: 'mcp', at: 1, touches: 1 }],
    })}\n`,
  );
  const reads: string[] = [];
  const idx = createCardsIndex({
    indexFile: file,
    load: async (rec) => {
      reads.push(rec.sessionId);
      return { cards: [card()] };
    },
  });
  await idx.refresh([a]);
  assert.deepEqual(reads, ['sess-a'], 'the malformed entry was not trusted; the session was re-read');
  assert.deepEqual(idx.sessionsFor('ABC-12', [a]), ['sess-a']);
});

// Three searches typed in quick succession issue three refreshes. Serialized, the first one reads
// the sessions and the other two find every stamp unchanged. Run in parallel they all start before
// any of them has written an entry, so each re-reads the whole corpus — the cost this file exists
// to remove, reappearing exactly when someone is in a hurry.
test('concurrent refreshes read the corpus once, not once each', async () => {
  const root = dir();
  const a = session(root, 'sess-a');
  const b = session(root, 'sess-b');
  const reads: string[] = [];
  const idx = createCardsIndex({
    indexFile: join(root, 'idx.jsonl'),
    load: async (rec) => {
      reads.push(rec.sessionId);
      await new Promise((r) => setTimeout(r, rec.sessionId === 'sess-a' ? 20 : 1));
      return { cards: [card()] };
    },
  });
  await Promise.all([idx.refresh([a, b]), idx.refresh([a, b]), idx.refresh([a, b])]);
  assert.equal(reads.length, 2, `each session read once, got ${reads.length}`);
  assert.deepEqual(idx.sessionsFor('ABC-12', [a, b]).sort(), ['sess-a', 'sess-b']);
});
