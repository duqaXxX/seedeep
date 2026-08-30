import { EventEmitter } from 'node:events';
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { anon } from '../core/text.ts';
import { isLive, type SessionRecord } from '../core/types.ts';
import { discoverSessions } from './discovery.ts';
import { modelFromLines } from './model.ts';
import { listOpenSessions, type OpenSession } from './open-sessions.ts';
import { parseLine } from './parser.ts';
import { initTailState, readNewLines, type TailState } from './tailer.ts';

interface Tracked {
  sessionId: string;
  agentId: string | null; // null = the parent (main) session file
  root: SessionRecord['root'];
  state: TailState;
  seq: number; // next line number to assign for this file
}

export interface SubagentMeta {
  agentType: string | null;
  toolUseId: string | null;
  spawnDepth: number | null;
  /** What the agent was launched to do, per its own sidecar — the only name a forked skill
   * (`/code-review`) has, since no `Agent` spawn exists to carry one. */
  description: string | null;
}

export interface WatcherOptions {
  intervalMs?: number;
  discover?: () => Promise<SessionRecord[]>;
  /** The open-session mechanism, injectable for tests. `null` means it is unavailable. */
  openSessions?: () => Promise<OpenSession[] | null>;
}

/** Where a session's transcript lives — all a tick needs once it knows the session is live. */
interface Located {
  sessionId: string;
  path: string;
  root: SessionRecord['root'];
}

// How long a full discovery is withheld after one failed to place an open session. The case is
// real and would otherwise be the worst one: Claude Code writes `~/.claude/sessions/<PID>.json`
// when it starts but the transcript only when the conversation does, so a window sits open with
// nothing typed in it — an id that no scan can resolve, for as long as the user stays quiet.
// Without this the "idle" case would rescan 3.3×/s, which is the very cost this removes.
// A second costs one scan/s while that lasts, and delays a brand-new session's first line by at
// most that — against 300 ms before. Everything else is unaffected: an id already located is
// never rescanned, and a session that appears WITH a transcript resolves on the next tick.
const RESCAN_MS = 1000;

/**
 * Polls the active sessions on an interval and emits normalized events as new
 * lines land. Read-only. Emits `'session-added'` (sessionId) the first time a
 * parent file is seen and `'event'` (NormalizedEvent) per parsed line; also tails
 * each session's `subagents/` children, tagging their events with `agentId` so a
 * subagent's usage never overwrites the parent's fill. Reads each child's
 * `meta.json` once and emits a `subagent-meta` event linking agentId → toolUseId.
 * Assigns a per-file `seq` matching the replay numbering. Start with {@link start},
 * stop the timer with {@link stop}. Backed by {@link readNewLines}, so it never
 * double-emits a line split across polls.
 */
export class Watcher extends EventEmitter {
  private readonly intervalMs: number;
  private readonly discover: () => Promise<SessionRecord[]>;
  private readonly openSessions: () => Promise<OpenSession[] | null>;
  // sessionId → where its transcript is. A path does not move, so this is filled by the
  // discoveries that do run and read by every tick in between.
  private readonly located = new Map<string, Located>();
  // sessionId → when a full discovery last failed to place it. See RESCAN_MS.
  private readonly unplaced = new Map<string, number>();
  private readonly tailers = new Map<string, Tracked>(); // key = path
  private readonly fill = new Map<string, number>(); // key = `${sessionId} ${agentId ?? ''}` → last absolute fill
  private readonly meta = new Map<string, SubagentMeta>(); // key = `${sessionId} ${agentId}` → sidecar meta (once resolved)
  private readonly model = new Map<string, string>(); // key = `${sessionId} ${agentId}` → child model (once found)
  // Workflow journals tail like any file but carry the run's own records, not transcript
  // lines, so they get their own tail state rather than going through `tailers`/parseLine.
  private readonly journals = new Map<string, TailState>(); // key = journal path
  private readonly runMembers = new Set<string>(); // `${sessionId} ${runId} ${agentId}` already announced
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false; // a tick is walking the files; see the guard in tick()
  private passFailing = false; // a pass is failing and has already been logged; see tick()

  constructor(opts: WatcherOptions = {}) {
    super();
    this.intervalMs = opts.intervalMs ?? 300;
    this.discover = opts.discover ?? (() => discoverSessions());
    this.openSessions = opts.openSessions ?? (() => listOpenSessions());
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Metadata for a subagent (from its meta.json sidecar), or null if unseen. */
  getSubagentMeta(sessionId: string, agentId: string): SubagentMeta | null {
    return this.meta.get(sessionId + ' ' + agentId) ?? null;
  }

  /**
   * One pass over the live sessions. Re-entrant calls RETURN IMMEDIATELY: `seq` is a line's
   * POSITION in its file, not a counter, and two passes reading the same file from the same
   * offset would both walk the same lines and both advance `tracked.seq` — emitting every
   * line twice and lifting seq above the file's line count. That breaks the two client
   * guards, which drop anything below their high-water: measured on a real instance,
   * seq 1585 for an 808-line file, after which a restart's re-delivery (numbered from 0)
   * could never climb back over the mark and every event was discarded for good.
   * Skipping is safe because nothing is consumed: the tail offsets do not move, so the next
   * tick reads exactly what this one would have.
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.pass();
      this.passFailing = false;
    } catch (err) {
      // A pass reads the filesystem, so it CAN fail — `discoverSessions` throws when a root
      // exists but will not be read (see discovery.ts). The timer must survive it: the cause is
      // usually transient and the next tick is 300ms away, while an escaping rejection from
      // `void this.tick()` takes the process with it. Logged once per outage, not 3.3 times a
      // second, so a lasting failure is still visible in the console without burying it.
      if (!this.passFailing) {
        this.passFailing = true;
        console.error('seedeep: watcher pass failed —', err);
      }
    } finally {
      this.ticking = false;
    }
  }

  /**
   * The live sessions and where their transcripts are — the same set `discover().filter(isLive)`
   * returns, reached without scanning the whole corpus 3.3 times a second.
   *
   * `isLive` is `isOpen ?? isActive`, so when the open-session mechanism answers at all, the
   * live set is EXACTLY the sessions holding a live process file: `isActive` is unreachable and
   * the mtime window never decides anything. That is what makes this an index lookup rather than
   * a heuristic — the gate is unchanged, only the way the set is reached is.
   *
   * A full discovery still runs, but only to PLACE an id this has never seen (a new session),
   * throttled by {@link RESCAN_MS} so an open window with nothing typed in it cannot bring the
   * old cost back. When the mechanism is unavailable (`null` — `~/.claude/sessions/` is an
   * undocumented Claude Code internal a release may drop) the mtime window is the only answer
   * there is, and this degrades to exactly what it did before: a full scan per tick.
   */
  private async live(): Promise<Located[]> {
    const open = await this.openSessions();
    if (open === null) {
      return (await this.discover()).filter(isLive);
    }
    const ids = open.map((s) => s.sessionId);
    // Both maps are keyed by open sessions; drop what is no longer open so neither grows with
    // every session the machine has ever run.
    for (const id of this.unplaced.keys()) if (!ids.includes(id)) this.unplaced.delete(id);

    const now = Date.now();
    // An id never seen is scanned for at once — that is a new session, and delaying it would
    // delay its first line. One already known to be unplaceable waits out RESCAN_MS.
    const worthScanning = ids.some(
      (id) => !this.located.has(id) && now - (this.unplaced.get(id) ?? -Infinity) >= RESCAN_MS,
    );
    if (worthScanning) {
      for (const rec of await this.discover()) {
        this.located.set(rec.sessionId, { sessionId: rec.sessionId, path: rec.path, root: rec.root });
      }
      for (const id of ids) if (!this.located.has(id)) this.unplaced.set(id, now);
    }
    return ids.map((id) => this.located.get(id)).filter((l): l is Located => l !== undefined);
  }

  private async pass(): Promise<void> {
    // A LIVE PROCESS, not a recently-written file: the gate was `isActive` (the parent jsonl's
    // mtime window) and it dropped the whole session — children included — for as long as the
    // main agent had nothing to write. A background subagent writes only to its OWN file, so a
    // 20-minute subagent meant 20 minutes of frozen feed, then a burst when the parent spoke
    // again. Measured on real logs: 21% of the sessions with subagents hit that window.
    const sessions = await this.live();
    for (const s of sessions) {
      await this.pump(s.path, s.sessionId, null, s.root);
      // Subagent children live under a sibling dir named after the session uuid,
      // NOT next to the parent jsonl: `<slug>/<uuid>.jsonl` + `<slug>/<uuid>/subagents/`.
      const subDir = join(dirname(s.path), basename(s.path, '.jsonl'), 'subagents');
      let children: string[] = [];
      try {
        children = await readdir(subDir);
      } catch {
        /* none */
      }
      for (const c of children) {
        const m = /^agent-(.+)\.jsonl$/.exec(c);
        if (!m) continue;
        const agentId = m[1]!;
        await this.loadMeta(subDir, agentId, s.sessionId, s.root);
        await this.pump(join(subDir, c), s.sessionId, agentId, s.root);
      }
      // LIMIT: this layout (`subagents/workflows/wf_<runId>/` with per-agent transcripts and a
      // journal.jsonl) is Claude Code's own and is undocumented — it was read off real runs, so
      // a CC change can silently empty the workflow rows. `replay.ts` walks the same shape.
      // A Workflow run's subagents live one level deeper, in `subagents/workflows/wf_<runId>/`,
      // with the same file names. The scan above only reads `subagents/` itself, so a
      // deep-research run's ~100 subagents were invisible in full. They are tailed like any
      // child (their usage/model fold in normally) but reported as members of their RUN, so
      // they aggregate into one row instead of flooding the list.
      const wfRoot = join(subDir, 'workflows');
      let runs: string[] = [];
      try {
        runs = await readdir(wfRoot);
      } catch {
        /* no workflows */
      }
      for (const runId of runs) await this.pumpRun(join(wfRoot, runId), runId, s.sessionId, s.root);
    }
  }

  // One Workflow run: its journal (the authoritative per-agent start/end) plus each
  // subagent's transcript.
  private async pumpRun(runDir: string, runId: string, sessionId: string, root: SessionRecord['root']): Promise<void> {
    let files: string[] = [];
    try {
      files = await readdir(runDir);
    } catch {
      return;
    }
    for (const f of files) {
      const m = /^agent-(.+)\.jsonl$/.exec(f);
      if (!m) continue;
      const agentId = m[1]!;
      // Membership is a fact that never changes, so announce it ONCE. Without this guard the
      // tick re-emitted a `seen` per agent every second, forever — 101 events per tick on a
      // real deep-research run, pushed to every connected browser long after the run ended.
      const seenKey = sessionId + ' ' + runId + ' ' + agentId;
      if (!this.runMembers.has(seenKey)) {
        this.runMembers.add(seenKey);
        this.emit('event', {
          type: 'workflow-agent',
          sessionId,
          root,
          timestamp: '',
          seq: -1,
          agentId,
          runId,
          phase: 'seen',
        });
      }
      await this.pump(join(runDir, f), sessionId, agentId, root);
    }
    // journal.jsonl is the run's OWN record, not Claude Code transcript lines: one
    // {type:'started'|'result', agentId, key} per line. It is the only thing that says whether
    // a workflow subagent is still working — nothing in its transcript does.
    const jPath = join(runDir, 'journal.jsonl');
    let tracked = this.journals.get(jPath);
    if (!tracked) {
      tracked = initTailState();
    }
    const { lines, state } = await readNewLines(jPath, tracked);
    this.journals.set(jPath, state);
    for (const line of lines) {
      let d: any;
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof d?.agentId !== 'string') continue;
      if (d.type !== 'started' && d.type !== 'result') continue;
      this.emit('event', {
        type: 'workflow-agent',
        sessionId,
        root,
        timestamp: '',
        seq: -1,
        agentId: d.agentId,
        runId,
        phase: d.type,
      });
    }
  }

  // Read the subagent's meta.json sidecar (toolUseId link, agentType, spawnDepth)
  // once and emit a `subagent-meta`. The MODEL comes from the child jsonl instead,
  // emitted by pump() the first line a model appears, so a missing/late sidecar never
  // blocks the model (and vice versa). The sidecar DOES carry a `model` on 143 of 1742
  // real subagents (measured 2026-07-24) — deliberately not read: it is always the
  // family alias the spawn declared (`haiku`/`sonnet`/`opus`, never a full id), so it
  // only ever repeats what `spawnModel` already gives us at the same moment, and adding
  // a second source for one fact buys no coverage.
  private async loadMeta(
    subDir: string,
    agentId: string,
    sessionId: string,
    root: SessionRecord['root'],
  ): Promise<void> {
    const key = sessionId + ' ' + agentId;
    if (this.meta.has(key)) return;
    let d: any;
    try {
      d = JSON.parse(await readFile(join(subDir, `agent-${agentId}.meta.json`), 'utf8'));
    } catch {
      return; /* sidecar absent or unreadable — retry next tick */
    }
    const meta: SubagentMeta = {
      agentType: typeof d.agentType === 'string' ? d.agentType : null,
      // LIMIT: assumes d.toolUseId matches the block.id on the parent's Agent tool_use
      // (written by Claude Code). If they diverge, tools.get(toolUseId) returns undefined
      // and the reducer cannot link the spawn to its launchPrompt.
      toolUseId: typeof d.toolUseId === 'string' ? d.toolUseId : null,
      spawnDepth: typeof d.spawnDepth === 'number' ? d.spawnDepth : null,
      description: typeof d.description === 'string' ? anon(d.description, 200) : null,
    };
    this.meta.set(key, meta);
    this.emit('event', {
      type: 'subagent-meta',
      sessionId,
      root,
      timestamp: '',
      seq: -1,
      agentId,
      toolUseId: meta.toolUseId,
      agentType: meta.agentType,
      spawnDepth: meta.spawnDepth,
      description: meta.description,
      model: this.model.get(key) ?? null,
    });
  }

  private async pump(
    path: string,
    sessionId: string,
    agentId: string | null,
    root: SessionRecord['root'],
  ): Promise<void> {
    let tracked = this.tailers.get(path);
    if (!tracked) {
      tracked = { sessionId, agentId, root, state: initTailState(), seq: 0 };
      this.tailers.set(path, tracked);
      if (agentId === null) this.emit('session-added', sessionId);
    }
    const { lines, state, restarted } = await readNewLines(path, tracked.state);
    tracked.state = state;
    // The offset and the numbering are ONE fact: `seq` is that offset counted in lines.
    // The tailer restarts from 0 when the file shrinks, so the count restarts with it —
    // otherwise the re-read arrives numbered above every consumer's high-water, passes
    // each guard, and the usage it carries is summed a second time.
    if (restarted) tracked.seq = 0;
    // A subagent's model lives on its own assistant lines; emit it the first tick a
    // model appears (the child grows over time, so a read-once cache could miss it).
    if (agentId !== null) {
      const key = sessionId + ' ' + agentId;
      if (!this.model.has(key)) {
        const m = modelFromLines(lines);
        if (m) {
          this.model.set(key, m);
          this.emit('event', {
            type: 'subagent-meta',
            sessionId,
            root,
            timestamp: '',
            seq: -1,
            agentId,
            toolUseId: null,
            agentType: null,
            spawnDepth: null,
            model: m,
          });
        }
      }
    }
    for (const line of lines) {
      const seq = tracked.seq++;
      for (const ev of parseLine(line, { sessionId, root, seq, agentId })) {
        if (ev.type === 'usage') this.fill.set(sessionId + ' ' + (agentId ?? ''), ev.fill);
        this.emit('event', ev);
      }
    }
  }
}
