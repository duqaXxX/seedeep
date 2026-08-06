import type { Stats } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DialogueSpeaker, SearchRow, SearchSnippet, SessionRecord } from '../core/types.ts';
import { seedDeepDir } from './config.ts';
import { CONTROL_COMMANDS, userLineIntent } from './parser.ts';

// The searchable corpus: what was SAID in a session — the user's prompts and the assistant's prose.
// Kept in its own file, NOT as a field on the aggregate cache, for two reasons that are not style:
// `aggregates.json` is rewritten whole on every retrospective refresh (20 MB of prose it never
// reads), and a new field there means CACHE_VERSION+1, i.e. re-parsing the corpus to gain text the
// retrospective does not look at. Different consumer, different lifecycle, different file.
//
// Extraction goes through the REAL parser (`userLineIntent`), never a second reader of the same
// lines: a hand-rolled one indexed the `<command-name>` wrapper Claude Code writes around a slash
// command — so `clear` matched every session — and labelled every session `/clear`.

/** The index format. Bumping it discards the file and re-reads the corpus (~0.8s, no data loss:
 * every byte is derived from transcripts seedeep does not own). */
const INDEX_VERSION = 1;

/** How much of a segment a snippet shows: enough for the sentence around the match to be readable
 * without turning a row into a paragraph. */
const SNIPPET_BEFORE = 70;
const SNIPPET_AFTER = 190;
/** At most two passages per session — the row is a way in, not the transcript. */
const SNIPPETS_PER_SESSION = 2;

/** One utterance of a session's dialogue. */
export interface DialogueSegment {
  who: DialogueSpeaker;
  text: string;
}

/** What the index holds per session file. `segs` is the whole searchable corpus of that session;
 * (`mtime`, `size`) is the staleness stamp, the same pair `aggregate-cache.ts` uses. */
interface IndexEntry {
  mtime: number;
  size: number;
  segs: DialogueSegment[];
}

// Every field a stored segment must carry. `satisfies` proves each name exists on DialogueSegment,
// and the `Missing` alias below fails the BUILD if a field is ever added to the type without being
// listed here — the same forcing function `aggregate-cache.ts` uses for its turn shape, for the
// reason recorded there: the version number is a promise a human has to remember, and forgetting it
// once already shipped an aggregate reading zeros off a stale cache. A renamed field here would
// load segments whose text is `undefined`, i.e. a corpus that silently matches nothing.
const SEG_KEYS = ['who', 'text'] as const satisfies readonly (keyof DialogueSegment)[];
type MissingSegKey = Exclude<keyof DialogueSegment, (typeof SEG_KEYS)[number]>;
const _allSegKeysListed: [MissingSegKey] extends [never] ? true : never = true;
void _allSegKeysListed;

/** True when a stored segment carries every field {@link DialogueSegment} declares, as a string. */
function hasSegShape(s: unknown): s is DialogueSegment {
  if (!s || typeof s !== 'object') return false;
  return SEG_KEYS.every((k) => typeof (s as Record<string, unknown>)[k] === 'string');
}

/** One session's match, before the roster says who it is. */
export interface SearchMatch {
  path: string;
  hits: number;
  chars: number;
  snippets: SearchSnippet[];
}

export interface SearchIndexOptions {
  /** Where the index is persisted. */
  indexFile: string;
  /** Injectable reader (tests). Defaults to reading the file from disk as utf8. */
  read?: (path: string) => Promise<string>;
}

export interface SearchIndex {
  /** Incrementally re-read the given session paths, persist, and drop the ones that vanished. */
  refresh(paths: readonly string[]): Promise<void>;
  /** Match a query against the current in-memory index. Empty query → no terms, no matches. */
  search(query: string): { terms: string[]; matches: SearchMatch[]; ms: number };
}

/** The default on-disk location of the search index: `<seedDeepDir>/search-index.jsonl`. */
export function defaultIndexFile(home: string = homedir()): string {
  return join(seedDeepDir(home), 'search-index.jsonl');
}

/**
 * The dialogue of one session file: the user's prompts (a slash command contributes its
 * ARGUMENTS, never its `<command-name>` wrapper) and the assistant's text blocks, in file order.
 *
 * Lines carrying no human intent are absent by construction — `userLineIntent` returns null for
 * `tool_result`s and for Claude Code's own injections. Measured on the real corpus (2026-07-29):
 * that rule drops 13.9% of user lines — 453 `<task-notification>`s, 63 compaction preambles,
 * probe artefacts — and not one human prompt.
 */
export function extractDialogue(raw: string): DialogueSegment[] {
  // LIMIT: one file only — a session's SUBAGENT transcripts (`<uuid>/subagents/`) are not indexed.
  // Their dialogue is machine-to-machine (an agent prompt Claude wrote, and its answer), so a word
  // said only there is unfindable. Deliberate, not an oversight: see docs/search.md.
  const segs: DialogueSegment[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    } // a truncated tail is not an error
    if (!d || typeof d !== 'object') continue;
    if (d.type === 'user' && !d.isMeta) {
      const intent = userLineIntent(d);
      if (intent && intent.text.trim()) segs.push({ who: 'you', text: intent.text });
    } else if (d.type === 'assistant' && Array.isArray(d.message?.content)) {
      for (const b of d.message.content) {
        if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim())
          segs.push({ who: 'claude', text: b.text });
      }
    }
  }
  return segs;
}

/**
 * The session's first task-bearing prompt, or null. The same rule `discovery.ts` applies to build
 * the picker's label — first intent that is not a CONTROL command — so a session that opens on
 * `/clear` is named by the task, not by the command.
 *
 * Not stored in the index: the roster already carries it. Exported because the extraction rule is
 * worth asserting on its own.
 */
export function subjectOf(raw: string): string | null {
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (!d || d.type !== 'user' || d.isMeta) continue;
    const intent = userLineIntent(d);
    if (!intent || !intent.text.trim()) continue;
    if (intent.command !== null && CONTROL_COMMANDS.has(intent.command)) continue;
    return intent.text.replace(/\s+/g, ' ').trim();
  }
  return null;
}

/** A query's AND terms: lowercased, whitespace-split, empties dropped. Every word narrows —
 * a single word is never enough (`toast` alone matched 90 of 988 local sessions). */
export function queryTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** How many times `term` occurs in `hay` (both already lowercased). */
function countOccurrences(hay: string, term: string): number {
  let n = 0;
  for (let at = hay.indexOf(term); at >= 0; at = hay.indexOf(term, at + term.length)) n++;
  return n;
}

/**
 * The passages to show for a match: for each segment, the window where the most DISTINCT terms
 * fall together; the best {@link SNIPPETS_PER_SESSION} of those, most-terms first.
 *
 * Distinct terms, not occurrences: a passage saying both words the user typed is the one that
 * proves the session is the right one — a passage repeating the first word ten times is not.
 */
function snippetsFor(segs: readonly DialogueSegment[], terms: readonly string[]): SearchSnippet[] {
  const scored: { who: DialogueSpeaker; text: string; score: number }[] = [];
  for (const seg of segs) {
    const low = seg.text.toLowerCase();
    let best = -1;
    let bestScore = 0;
    for (const t of terms) {
      for (let at = low.indexOf(t); at >= 0; at = low.indexOf(t, at + t.length)) {
        const window = low.slice(Math.max(0, at - SNIPPET_BEFORE), at + SNIPPET_AFTER);
        const score = terms.filter((x) => window.includes(x)).length;
        if (score > bestScore) {
          bestScore = score;
          best = at;
        }
      }
    }
    if (best < 0) continue;
    const from = Math.max(0, best - SNIPPET_BEFORE);
    const body = seg.text
      .slice(from, best + SNIPPET_AFTER)
      .replace(/\s+/g, ' ')
      .trim();
    scored.push({
      who: seg.who,
      text: (from > 0 ? '…' : '') + body + (best + SNIPPET_AFTER < seg.text.length ? '…' : ''),
      score: bestScore,
    });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, SNIPPETS_PER_SESSION)
    .map(({ who, text }) => ({ who, text }));
}

/**
 * Match one session's dialogue against already-lowercased `terms`, ANDed. Returns null when any
 * term is missing — the whole query must be in the session, or it is not the session.
 * `hay` is the lowercased dialogue, passed in so the caller can cache it.
 */
export function matchDialogue(
  segs: readonly DialogueSegment[],
  hay: string,
  terms: readonly string[],
): { hits: number; chars: number; snippets: SearchSnippet[] } | null {
  if (!terms.length) return null;
  let hits = 0;
  for (const t of terms) {
    const n = countOccurrences(hay, t);
    if (n === 0) return null;
    hits += n;
  }
  // `chars` counts what was SAID, not `hay.length` — the separators joining the utterances are the
  // matcher's business, and charging them to the density denominator inflated the shortest sessions
  // by up to 12.5% (measured over 895 real sessions; 303 over 1%). Density is the default order and
  // is decided precisely on those rows.
  const chars = segs.reduce((n, s) => n + s.text.length, 0);
  return { hits, chars, snippets: snippetsFor(segs, terms) };
}

/**
 * Join matches with the roster into the rows the GUI renders. The index knows how well a session
 * matches; only the roster knows WHO it is — the same division `compare.ts` makes. A match whose
 * path is no longer in the roster is dropped: a row that cannot be opened is not a result.
 */
export function buildSearchRows(roster: readonly SessionRecord[], matches: readonly SearchMatch[]): SearchRow[] {
  const byPath = new Map(roster.map((r) => [r.path, r]));
  const rows: SearchRow[] = [];
  for (const m of matches) {
    const r = byPath.get(m.path);
    if (!r) continue;
    rows.push({
      sessionId: r.sessionId,
      project: r.project,
      subject: r.subject,
      entrypoint: r.entrypoint,
      lastActivity: r.lastActivity,
      hits: m.hits,
      chars: m.chars,
      snippets: m.snippets,
    });
  }
  return rows;
}

/**
 * Build the persistent incremental search index. The file is loaded lazily on the first refresh;
 * each refresh stats every path, re-reads only those whose (size, mtime) moved, drops vanished
 * ones, and persists atomically (temp + rename). Concurrent refreshes are serialized. A missing,
 * corrupt or older-version file is treated as empty and rebuilt; one that cannot be written is
 * simply rebuilt next launch.
 *
 * Cost, measured on 988 real sessions / 702 MB (2026-07-29): a full build reads 19.5 MB of
 * dialogue in ~0.8s; a query over it takes 17–30 ms. Scanning the transcripts on demand instead
 * costs a 2.0s FLOOR per query — even for a query matching nothing — which is what this file buys
 * back. Do not add an inverted index; nothing measured asks for one.
 */
export function createSearchIndex(opts: SearchIndexOptions): SearchIndex {
  const read = opts.read ?? ((path: string) => readFile(path, 'utf8'));
  let entries: Map<string, IndexEntry> | null = null; // lazy-loaded on first refresh
  // The lowercased dialogue, derived once per entry and never persisted: it is a pure function of
  // `segs`, and storing it would double the file to hold text nothing can display.
  //
  // Keyed on the ENTRY, not on its path, and that is the whole invalidation strategy. Keyed by path
  // it had to be invalidated by hand, from inside the refresh loop — while the live map still held
  // the entry being replaced. A search landing in that window re-derived the haystack from the OLD
  // text, and the stale copy outlived the swap: the session stayed findable by words it no longer
  // contained. An entry's text cannot change (a changed file becomes a NEW entry), so keying on it
  // makes the stale state unreachable rather than merely unlikely. Weak, so a dropped entry's
  // derivation is collected with it.
  const hays = new WeakMap<IndexEntry, string>();
  let queue: Promise<unknown> = Promise.resolve();

  const hayOf = (e: IndexEntry): string => {
    let hay = hays.get(e);
    if (hay === undefined) {
      hay = e.segs
        .map((s) => s.text)
        .join('\n')
        .toLowerCase();
      hays.set(e, hay);
    }
    return hay;
  };

  async function load(): Promise<Map<string, IndexEntry>> {
    if (entries) return entries;
    entries = new Map();
    try {
      const lines = (await readFile(opts.indexFile, 'utf8')).split('\n');
      const header = JSON.parse(lines[0] ?? '{}');
      if (header?.index === 'seedeep-search' && header.version === INDEX_VERSION) {
        for (const line of lines.slice(1)) {
          if (!line) continue;
          const e = JSON.parse(line);
          if (
            e &&
            typeof e.path === 'string' &&
            typeof e.mtime === 'number' &&
            typeof e.size === 'number' &&
            Array.isArray(e.segs) &&
            e.segs.every(hasSegShape)
          ) {
            entries.set(e.path, { mtime: e.mtime, size: e.size, segs: e.segs });
          }
        }
      }
    } catch {
      /* missing/corrupt/older version → empty, rebuilt on this refresh */
    }
    return entries;
  }

  async function persist(map: Map<string, IndexEntry>): Promise<void> {
    const out = [JSON.stringify({ index: 'seedeep-search', version: INDEX_VERSION })];
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

  async function doRefresh(paths: readonly string[]): Promise<void> {
    const map = await load();
    const next = new Map<string, IndexEntry>();
    for (const path of paths) {
      let st: Stats;
      try {
        st = await stat(path);
      } catch {
        continue;
      } // vanished/unreadable → drop from the index
      const hit = map.get(path);
      if (hit && hit.size === st.size && hit.mtime === st.mtimeMs) {
        next.set(path, hit);
        continue;
      }
      let raw: string;
      try {
        raw = await read(path);
      } catch {
        continue;
      }
      const segs = extractDialogue(raw);
      // A session with no dialogue at all (an aborted launch) is still tracked, so its unchanged
      // stamp keeps it from being re-read on every search.
      next.set(path, { mtime: st.mtimeMs, size: st.size, segs });
    }
    entries = next;
    await persist(next);
  }

  return {
    refresh(paths: readonly string[]): Promise<void> {
      const run = queue.then(() => doRefresh(paths));
      queue = run.catch(() => {}); // keep the chain alive even if one refresh rejects
      return run;
    },

    search(query: string) {
      const terms = queryTerms(query);
      const started = performance.now();
      const matches: SearchMatch[] = [];
      if (terms.length && entries) {
        for (const [path, e] of entries) {
          if (!e.segs.length) continue;
          const m = matchDialogue(e.segs, hayOf(e), terms);
          if (m) matches.push({ path, ...m });
        }
      }
      return { terms, matches, ms: Math.round((performance.now() - started) * 10) / 10 };
    },
  };
}
