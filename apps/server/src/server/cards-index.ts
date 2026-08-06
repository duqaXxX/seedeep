import type { Stats } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SessionCard } from '../core/tracker-cards.ts';
import type { SessionRecord } from '../core/types.ts';
import { seedDeepDir } from './config.ts';
import { cardsForSession } from './session-cards.ts';

// Which sessions worked on a tracker card, without reading the corpus to answer.
//
// The commit-hash inverse next door needs no index because git IS one: it asks three subprocesses
// which repository holds the object, then opens only the sessions bracketing that commit — 183 ms
// cold, 8 ms warm over 716 sessions. Nothing indexes a tracker id, so the first implementation read
// every transcript on every query: 2.9 s cold and 2.2 s WARM, peaking near 1 GB of RSS. A cache the
// query cannot use is not a cache.
//
// Same shape as `search-index.ts`, deliberately: own file (different consumer, different
// lifecycle), header + one line per session, a `(size, mtime)` staleness stamp, incremental
// refresh, atomic rename. Unlike that one it goes through `cardsForSession`, so subagent sidecars
// are covered — a subagent's card is its parent's card.

/** The index format. Bumping it discards the file and rebuilds from the transcripts, which own
 *  every byte here — nothing in it is unrecomputable. */
const INDEX_VERSION = 1;

/** What the index holds per session file. */
interface IndexEntry {
  mtime: number;
  size: number;
  cards: SessionCard[];
}

// Every field a stored card must carry. `satisfies` proves each name exists on SessionCard, and the
// `Missing` alias fails the BUILD if a field is added to the type without being listed here — the
// forcing function `search-index.ts` and `aggregate-cache.ts` both use, for the reason recorded
// there: the version number is a promise a human has to remember. A renamed field would load cards
// whose id is `undefined`, i.e. an index that silently matches nothing.
const CARD_KEYS = [
  'key',
  'id',
  'title',
  'url',
  'evidence',
  'source',
  'at',
  'touches',
] as const satisfies readonly (keyof SessionCard)[];
type MissingCardKey = Exclude<keyof SessionCard, (typeof CARD_KEYS)[number]>;
const _allCardKeysListed: [MissingCardKey] extends [never] ? true : never = true;
void _allCardKeysListed;

/** True when a stored card carries every field {@link SessionCard} declares, with its own type. */
function hasCardShape(c: unknown): c is SessionCard {
  if (!c || typeof c !== 'object') return false;
  const o = c as Record<string, unknown>;
  return (
    typeof o.key === 'string' &&
    typeof o.id === 'string' &&
    (o.title === null || typeof o.title === 'string') &&
    (o.url === null || typeof o.url === 'string') &&
    (o.evidence === 'wrote' || o.evidence === 'read') &&
    (o.source === 'mcp' || o.source === 'cli') &&
    typeof o.at === 'number' &&
    typeof o.touches === 'number'
  );
}

export interface CardsIndexOptions {
  /** Where the index is persisted. */
  indexFile: string;
  /** Injectable reader of one session's cards (tests). Defaults to {@link cardsForSession}. */
  load?: (rec: SessionRecord) => Promise<{ cards: SessionCard[] }>;
}

export interface CardsIndex {
  /** Incrementally re-read the changed sessions, persist, and drop the ones that vanished. */
  refresh(records: readonly SessionRecord[]): Promise<void>;
  /**
   * The sessions that acted on `query` (`ABC-12` or `#42`), newest touch first, answered from the
   * in-memory index alone. `records` maps paths back to session ids.
   */
  sessionsFor(query: string, records: readonly SessionRecord[]): string[];
}

/** The default on-disk location of the cards index: `<seedDeepDir>/cards-index.jsonl`. */
export function defaultCardsIndexFile(home: string = homedir()): string {
  return join(seedDeepDir(home), 'cards-index.jsonl');
}

/**
 * A persisted card-id index over the session corpus.
 *
 * `refresh` is incremental and serialized: a session whose `(size, mtime)` is unchanged is never
 * re-read, so the steady state is one `stat` per session and a parse of only what actually changed.
 *
 * LIMIT: staleness is stamped from the PARENT transcript. A subagent sidecar that grows without its
 * parent being written would not re-index — in practice the parent carries the spawn and the
 * result, so it moves too.
 */
export function createCardsIndex(opts: CardsIndexOptions): CardsIndex {
  const load = opts.load ?? cardsForSession;
  let entries: Map<string, IndexEntry> | null = null; // lazy-loaded on first refresh
  let queue: Promise<unknown> = Promise.resolve();

  async function loadFile(): Promise<Map<string, IndexEntry>> {
    if (entries) return entries;
    entries = new Map();
    try {
      const lines = (await readFile(opts.indexFile, 'utf8')).split('\n');
      const header = JSON.parse(lines[0] ?? '{}');
      if (header?.index === 'seedeep-cards' && header.version === INDEX_VERSION) {
        for (const line of lines.slice(1)) {
          if (!line) continue;
          const e = JSON.parse(line);
          if (
            e &&
            typeof e.path === 'string' &&
            typeof e.mtime === 'number' &&
            typeof e.size === 'number' &&
            Array.isArray(e.cards) &&
            e.cards.every(hasCardShape)
          ) {
            entries.set(e.path, { mtime: e.mtime, size: e.size, cards: e.cards });
          }
        }
      }
    } catch {
      /* missing/corrupt/older version → empty, rebuilt on this refresh */
    }
    return entries;
  }

  async function persist(map: Map<string, IndexEntry>): Promise<void> {
    const out = [JSON.stringify({ index: 'seedeep-cards', version: INDEX_VERSION })];
    for (const [path, e] of map) out.push(JSON.stringify({ path, ...e }));
    try {
      await mkdir(dirname(opts.indexFile), { recursive: true });
      const tmp = `${opts.indexFile}.tmp`; // refreshes are serialized, so one temp name is safe
      await writeFile(tmp, out.join('\n'));
      await rename(tmp, opts.indexFile); // atomic swap — a crash never leaves a half-written index
    } catch {
      /* an index we cannot persist is one we rebuild — never fatal */
    }
  }

  async function doRefresh(records: readonly SessionRecord[]): Promise<void> {
    const map = await loadFile();
    const next = new Map<string, IndexEntry>();
    for (const rec of records) {
      let st: Stats;
      try {
        st = await stat(rec.path);
      } catch {
        continue; // vanished/unreadable → drop from the index
      }
      const hit = map.get(rec.path);
      if (hit && hit.size === st.size && hit.mtime === st.mtimeMs) {
        next.set(rec.path, hit);
        continue;
      }
      let cards: SessionCard[];
      try {
        cards = (await load(rec)).cards;
      } catch {
        continue;
      }
      // A session with no cards is still tracked, so its unchanged stamp keeps it from being
      // re-read on every search — the majority of sessions, and the whole point of the stamp.
      next.set(rec.path, { mtime: st.mtimeMs, size: st.size, cards });
    }
    entries = next;
    await persist(next);
  }

  return {
    refresh(records: readonly SessionRecord[]): Promise<void> {
      const run = queue.then(() => doRefresh(records));
      queue = run.catch(() => {}); // keep the chain alive even if one refresh rejects
      return run;
    },

    sessionsFor(query: string, records: readonly SessionRecord[]): string[] {
      const q = query.trim().toUpperCase();
      if (!entries) return [];
      const byPath = new Map(records.map((r) => [r.path, r.sessionId]));
      const hits: Array<{ sessionId: string; at: number }> = [];
      for (const [path, e] of entries) {
        const sessionId = byPath.get(path);
        if (!sessionId) continue;
        // `key` as well as `id`: an id is what the user types (`#42`), a key is what makes two
        // repositories' `#42` different cards.
        const card = e.cards.find((c) => c.id.toUpperCase() === q || c.key.toUpperCase() === q);
        if (card) hits.push({ sessionId, at: card.at });
      }
      hits.sort((a, b) => b.at - a.at);
      return hits.map((h) => h.sessionId);
    },
  };
}
