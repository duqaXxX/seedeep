import type { EventEmitter } from 'node:events';
import { windowFor } from '../core/context-windows.ts';
import { createSessionTree } from '../core/session-tree.ts';
import type { NormalizedEvent, SessionRecord } from '../core/types.ts';
import { streamReplay } from './replay.ts';

type Tree = ReturnType<typeof createSessionTree>;
type Replay = typeof streamReplay;

interface Entry {
  tree: Tree;
  /**
   * While seeding: the live events that arrived meanwhile. `null` once the handoff is done,
   * which is also the flag that says the listener may apply straight to the tree.
   */
  buffer: NormalizedEvent[] | null;
  /**
   * Highest `seq` the SEED applied, per file (`''` = parent, else `agentId`). Frozen at the
   * handoff and never advanced again — see {@link applyLive} for why that is the whole guard.
   */
  mark: Map<string, number>;
  ready: Promise<Tree>;
  /**
   * The turn's last word and the instant THIS process saw it. The server's own sighting, because
   * the line's timestamp cannot stand in for it: Claude Code stamps a text block with the moment it
   * started generating it and flushes the line 7-9s later, so a hold counted from the stamp is
   * already half spent when the word first becomes readable. `null` until a word arrives.
   */
  word: { ts: string; at: number } | null;
}

/**
 * Live session trees held by the server: one per live session, created on demand, seeded from
 * the file and advanced by the watcher. Read-only — it only folds events the watcher emits.
 */
export interface LiveTrees {
  /** The tree for a live session, seeding it on first ask. Concurrent calls share one seed. */
  ensure(rec: SessionRecord): Promise<Tree>;
  /** The tree if it is already seeded, else `undefined`. Never starts a seed. */
  get(sessionId: string): Tree | undefined;
  /** When this process first saw the session's last word, for `nowLine`'s hold. */
  wordSeenAt(sessionId: string): number | null;
  /** Drop every tree whose session is not in `liveIds` — the caller owns the live set. */
  retain(liveIds: Iterable<string>): void;
  /** How many trees are held (seeding included). */
  readonly size: number;
  /** Release the watcher subscription and drop every tree. */
  stop(): void;
}

/**
 * Hold one session tree per live session, seeded by {@link streamReplay} and advanced by the
 * watcher's `event`. The tree a session produces this way is IDENTICAL to the one its file
 * produces when replayed whole — that equality is the contract, and the reason the handoff
 * below is deliberately minimal rather than a copy of the browser's.
 *
 * Nothing here polls: `ensure` is called by whoever already holds a live {@link SessionRecord},
 * and `retain` evicts from a live set the caller already has. A tree nobody asked for is never
 * built, and the process gains no second always-on cost.
 */
export function createLiveTrees(deps: { watcher: EventEmitter; replay?: Replay }): LiveTrees {
  const replay = deps.replay ?? streamReplay;
  const entries = new Map<string, Entry>();

  // ONE listener for every session, dispatching by sessionId. One per tree would trip
  // EventEmitter's max-listeners warning at 10 live sessions and leak a listener per eviction.
  const onEvent = (e: NormalizedEvent): void => {
    const entry = entries.get(e.sessionId);
    if (!entry) return;
    if (entry.buffer) entry.buffer.push(e);
    else applyLive(entry, e);
  };
  deps.watcher.on('event', onEvent);

  /**
   * A live event, deduped against what the SEED already holds. The mark is frozen, and that is
   * the entire guard — three facts make it sufficient, none of which the browser can rely on:
   *
   * 1. The watcher emits every event of a line in one synchronous loop, so a line arrives whole
   *    (in the buffer or after it), never split. The browser's SSE frames can be cut mid-line,
   *    which is what forces its `liveMax`/`liveSeen` pair; in-process that case cannot happen.
   * 2. A file's history can be re-delivered exactly ONCE — the watcher's first pump of a file
   *    starts at offset 0, and a session that went live between the watcher's last discovery
   *    and this seed gets pumped from the top afterwards. Everything the seed read is at or
   *    below the mark, so that pump is dropped; every later pump only appends.
   * 3. Because the mark never advances, the sibling events of a line beyond it are never
   *    dropped. A mark that tracked the live frontier would keep a line's first event and
   *    silently discard the rest — the bug that already shipped once in the browser.
   *
   * Out-of-band events (`seq: -1` — `subagent-meta`, `workflow-agent`) carry no position and
   * are always applied: the reducer merges them idempotently, which is what makes the replay
   * path's own re-sends safe.
   */
  function applyLive(entry: Entry, e: NormalizedEvent): void {
    if (e.seq >= 0) {
      const mark = entry.mark.get(e.agentId ?? '');
      if (mark !== undefined && e.seq <= mark) return;
    }
    entry.tree.apply(e);
    noteWord(entry, e);
  }

  /**
   * Stamp the sighting of a main-thread word — the instant `nowLine` measures its hold from.
   *
   * **Only a word that ARRIVED while this process was watching gets one.** The seed is deliberately
   * not a sighting: it replays what is already on disk, which the reader has already had on screen.
   * Stamping it made every restart hand the line back to a narration that had been read and already
   * replaced by the count — observed live twice, by restarting the server mid-turn and watching the
   * row jump back to the same intent. The 60-second `arrivedLive` guard does not cover it: the word
   * in question is seconds old, which is precisely the case that matters.
   *
   * A word with no sighting simply earns no hold, so NOW says what the turn has DONE — which is the
   * browser's rule for opening a session mid-turn, now reached the same way on both sides.
   *
   * A subagent's narration is not the session's word: the tray's row speaks for the main thread.
   */
  function noteWord(entry: Entry, e: NormalizedEvent): void {
    if (e.agentId) return;
    if (e.type !== 'turn-narration' && e.type !== 'turn-result') return;
    if (entry.word?.ts !== e.timestamp) entry.word = { ts: e.timestamp, at: Date.now() };
  }

  async function seed(entry: Entry, rec: SessionRecord): Promise<Tree> {
    try {
      for await (const e of replay(rec.path, { sessionId: rec.sessionId, root: rec.root })) {
        if (e.seq >= 0) {
          const key = e.agentId ?? '';
          const at = entry.mark.get(key);
          // Monotone by construction: the replay walks each file once, in order.
          if (at === undefined || e.seq > at) entry.mark.set(key, e.seq);
        }
        entry.tree.apply(e);
      }
    } catch (err) {
      // A half-seeded tree is worse than none: it would serve a session missing its history
      // with no way to tell. Drop it so the next ask starts clean — but only if the map still
      // holds THIS entry. A `retain` during the seed, followed by a fresh `ensure`, puts a
      // healthy entry under the same key, and deleting that one would leave its awaiter holding
      // a tree the listener no longer feeds.
      if (entries.get(rec.sessionId) === entry) entries.delete(rec.sessionId);
      throw err;
    }
    // The handoff. Clearing the buffer FIRST is what makes it a handoff and not a second
    // buffer: from here the listener applies directly. Nothing can interleave — the flush is
    // synchronous and so is the watcher's emit.
    const buffered = entry.buffer ?? [];
    entry.buffer = null;
    for (const e of buffered) applyLive(entry, e);
    return entry.tree;
  }

  return {
    ensure(rec: SessionRecord): Promise<Tree> {
      const existing = entries.get(rec.sessionId);
      if (existing) return existing.ready;
      // The model the record reports seeds the window denominator, exactly as the browser does
      // (`app.ts`): the same session must not report a different fill to two clients.
      const entry: Entry = {
        tree: createSessionTree({ windowFor, mainModel: rec.model }),
        buffer: [],
        mark: new Map(),
        ready: undefined as unknown as Promise<Tree>,
        word: null,
      };
      entries.set(rec.sessionId, entry);
      // Assigned after registration so a second `ensure` in the same tick finds the entry and
      // awaits THIS seed instead of starting a second one over the same file.
      entry.ready = seed(entry, rec);
      return entry.ready;
    },

    get(sessionId: string): Tree | undefined {
      const entry = entries.get(sessionId);
      // A tree still seeding holds only part of its history: handing it out would answer with
      // a session that looks emptier than it is.
      return entry && entry.buffer === null ? entry.tree : undefined;
    },

    wordSeenAt(sessionId: string): number | null {
      return entries.get(sessionId)?.word?.at ?? null;
    },

    retain(liveIds: Iterable<string>): void {
      const keep = new Set(liveIds);
      for (const id of entries.keys()) if (!keep.has(id)) entries.delete(id);
    },

    get size(): number {
      return entries.size;
    },

    stop(): void {
      deps.watcher.off('event', onEvent);
      entries.clear();
    },
  };
}
