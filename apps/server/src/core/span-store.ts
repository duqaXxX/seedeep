import { outcomeLine } from './activity-line.ts';
import type { EventContext } from './session-tree.ts';
import { entryText } from './tree-format.ts';
import type { NormalizedEvent } from './types.ts';
import { SPAWN_TOOL_NAMES } from './types.ts';

// ── Public types ──────────────────────────────────────────────────────────────

export type SpanType = 'prompt' | 'api' | 'tool' | 'skill' | 'spawn' | 'subspan' | 'result';

/** Identifies the drawer content for a span. The subagent handle also carries the
 * spawn's toolUseId so the drawer router can fall back to the spawn TOOL drawer
 * when the agent is not in the snapshot yet (never a silent no-op). */
export type DrawerHandle =
  | { kind: 'tool'; toolUseId: string }
  | { kind: 'call'; callId: string }
  | { kind: 'subagent'; agentId: string | null; toolUseId?: string }
  // The turn's own text — what the user asked, and what the model finally answered.
  // Carries only the index: the text itself lives on the reducer's TurnNode, and the
  // router reads it there at click time rather than the store holding a second copy.
  | { kind: 'turn-text'; turnIndex: number; which: 'prompt' | 'result' };

export interface TraceSpan {
  id: string;
  type: SpanType;
  label: string;
  detail: string | null;
  t0: number;
  t1: number; // epoch ms; t1 === t0 until closed
  turnIndex: number;
  lane: number; // lane 0 = main thread; subagent lanes >= 1
  parentId: string | null;
  agent: string | null;
  status: 'ok' | 'error' | 'running';
  handle: DrawerHandle | null;
  /** This tool LAUNCHED a background command, so `t1 - t0` measures the launch and not the
   * command — which may still be running, or have died hours later. Set from the receipt's
   * `backgroundTaskId`; the row is marked so its duration is not read as the command's. */
  background?: true;
  /** `api` spans only: the mid-turn text of THIS call — the model saying what it is about to do.
   * It names the round the call opens (round = api + its tools). 40.2% of real rounds carry one
   * (measured over 235 transcripts), so the number stays the label of the other 60%. */
  narration?: string;
}

export interface TraceTurn {
  index: number;
  title: string;
  kind: 'work' | 'local' | 'context';
  t0: number;
  t1: number;
  state: 'live' | 'done' | 'interrupted';
  spans: TraceSpan[];
  spawns: TraceSpawn[];
}

export interface TraceSpawn {
  spawnId: string;
  label: string;
  kind: string;
  lanes: TraceLane[];
}
export interface TraceLane {
  agentId: string | null;
  label: string;
  spans: TraceSpan[];
  status: string;
}

export interface TraceSnapshot {
  turns: TraceTurn[];
  t0: number;
  t1: number;
  seq: number;
}

export interface SpanStore {
  apply(e: NormalizedEvent, ctx: EventContext): void;
  /** Return the store's current state. When `scopeTurn` is provided, only that turn is included. */
  snapshot(scopeTurn?: number | null): TraceSnapshot;
  /** Subscribe to state changes; returns an unsubscribe function. Fires after each apply that mutated state. */
  onChange(cb: () => void): () => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

let _nextId = 0;
function nextId(): string {
  return `sp-${_nextId++}`;
}

/** First non-empty line of a string, or null when the string is empty. */
function firstLine(s: string | null | undefined): string | null {
  if (!s) return null;
  const line = s.split('\n')[0]?.trim();
  return line?.length ? line : null;
}

/**
 * Parse an ISO timestamp to epoch ms; returns the fallback on NaN so the caller
 * always has a valid time anchor.
 */
function tsOrFallback(ts: string | null | undefined, fallback: number): number {
  const n = Date.parse(ts ?? '');
  return Number.isFinite(n) ? n : fallback;
}

// ── Implementation ────────────────────────────────────────────────────────────

/**
 * In-memory store that consumes the reducer's `onEvent(e, ctx)` stream and produces an
 * ordered per-turn span structure for both the main thread (Task 1) and subagent lanes
 * (Task 2). `snapshot()` is always consistent — it returns a plain object snapshot of
 * internal state, safe to hand to any renderer without further transformation.
 */
export function createSpanStore(): SpanStore {
  // Keyed by turn index (1-based, matching the reducer's TurnAcc.index).
  const turns = new Map<number, TraceTurn>();
  // Open tool spans awaiting a tool-end, keyed by toolUseId.
  const openToolSpans = new Map<string, TraceSpan>();
  // Spans of tool calls that LAUNCHED a background command, kept after they close because their
  // outcome arrives later (p50 2.9m, p90 32m, max 8.8h — re-measured 2026-08-02 over 731 local
  // transcripts: 120 launches, 114 of them notified) as an `agent-end`. Only these are retained —
  // holding every closed tool span would grow with the session (23k events on a real one) to serve
  // a case that is ~120 rows per corpus.
  const backgroundSpans = new Map<string, TraceSpan>();
  // Outcomes whose launching call has not been seen yet (the end can be written first).
  const pendingBgOutcome = new Map<string, { clean: boolean; summary: string | null }>();

  // All spawns indexed by spawnId (= toolUseId of the spawn tool-start). Persists after
  // the spawn span closes so late-arriving subagent-meta/child events can still find it.
  const spawnById = new Map<string, { turnIdx: number; spawn: TraceSpawn; span: TraceSpan }>();
  // Set of spawnIds whose span has not yet been closed by a tool-end.
  const openSpawnIds = new Set<string>();

  // agentId → spawnId, established when agent-end arrives with taskId.
  const agentSpawnMap = new Map<string, string>();
  // Child events that arrived before the agentId → spawnId link was established.
  const childBuffer = new Map<string, Array<{ e: NormalizedEvent; ctx: EventContext }>>();
  // subagent-meta events that arrived BEFORE their spawn tool-start. Live, the
  // watcher reads the child's meta.json as soon as the agent starts writing, but
  // the parent's assistant line (carrying the spawn tool_use) is only written
  // when the API response completes — so the meta routinely arrives first and
  // must wait for the spawn instead of being dropped.
  const metaBuffer = new Map<string, NormalizedEvent>();
  // Open child tool spans awaiting a child tool-end, keyed by toolUseId.
  const openChildToolSpans = new Map<string, TraceSpan>();

  let latestTs = 0; // last valid timestamp seen, used as NaN fallback
  let _seq = 0;
  const listeners = new Set<() => void>();

  // ── Child event routing ────────────────────────────────────────────────────

  /**
   * Route one child-file event into the correct subagent lane. Called either directly
   * (when the agentId → spawnId link is already known) or from the buffer flush when
   * agent-end arrives. Returns true when state was mutated.
   */
  function applyChildEvent(e: NormalizedEvent, ctx: EventContext): boolean {
    if (e.agentId == null) return false;
    const spawnId = agentSpawnMap.get(e.agentId);
    if (spawnId == null) return false;
    const entry = spawnById.get(spawnId);
    if (!entry) return false;
    const { spawn, turnIdx } = entry;
    const ts = tsOrFallback(e.timestamp, latestTs);

    const lane = spawn.lanes.find((l) => l.agentId === e.agentId);
    if (!lane) return false;
    // Subagent lanes are 1-based; lane 0 is reserved for the main thread.
    const laneIdx = spawn.lanes.indexOf(lane) + 1;

    // LIMIT: async/background subagents (Task tool) may produce no child jsonl; their
    // tool-starts and usage events never arrive here. Returned output comes from
    // SubagentReturned in the parent tool_result, not inline child events.
    if (e.type === 'tool-start' && !SPAWN_TOOL_NAMES.has(e.name) && e.name !== 'Workflow') {
      const subspan: TraceSpan = {
        id: nextId(),
        type: 'subspan',
        label: e.name,
        detail: ctx.label ?? null,
        t0: ts,
        t1: ts,
        turnIndex: turnIdx,
        lane: laneIdx,
        parentId: spawnId,
        agent: lane.label,
        status: 'running',
        handle: { kind: 'tool', toolUseId: e.id },
      };
      lane.spans.push(subspan);
      openChildToolSpans.set(e.id, subspan);
      return true;
    }

    if (e.type === 'tool-end') {
      const subspan = openChildToolSpans.get(e.toolUseId);
      if (subspan) {
        subspan.t1 = ts;
        // 56% of real tool failures happen inside a subagent — a main-thread-only badge would
        // miss most of them, so the lane span carries the error too.
        subspan.status = e.error ? 'error' : 'ok';
        openChildToolSpans.delete(e.toolUseId);
        return true;
      }
      return false;
    }

    if (e.type === 'usage' && ctx.newCall === true) {
      const t1 = ts + (ctx.callMs ?? 0);
      const subspan: TraceSpan = {
        id: nextId(),
        type: 'api',
        label: 'API call',
        detail: ctx.label ?? null,
        t0: ts,
        t1,
        turnIndex: turnIdx,
        lane: laneIdx,
        parentId: spawnId,
        agent: lane.label,
        status: e.apiError ? 'error' : 'ok',
        handle: e.callId ? { kind: 'call', callId: e.callId } : null,
      };
      lane.spans.push(subspan);
      return true;
    }

    return false;
  }

  /** Flush child events parked for `agentId` now that its lane/link exists. */
  function flushChildBuffer(agentId: string): void {
    const buf = childBuffer.get(agentId);
    if (!buf) return;
    childBuffer.delete(agentId);
    for (const { e: be, ctx: bc } of buf) applyChildEvent(be, bc);
  }

  /**
   * Apply a subagent-meta whose spawn IS known: create/enrich the lane, establish
   * the agentId → spawnId link, and flush any parked child events. Returns true
   * when state was mutated.
   */
  function applyMeta(e: NormalizedEvent & { type: 'subagent-meta' }): boolean {
    if (e.agentId == null || e.agentType == null) return false;
    // A forked skill has no spawning tool at all, so its block is keyed by the AGENT — the only
    // name its launch ever gives it (see the `agent-launch` branch).
    const key = e.toolUseId ?? e.agentId;
    const entry = spawnById.get(key);
    if (!entry) return false;
    const { spawn } = entry;
    let lane = spawn.lanes.find((l) => l.agentId === e.agentId);
    if (!lane) {
      // Lane may not exist yet (agent-end can arrive much later for async
      // subagents). Create it now so child events route while the agent RUNS.
      lane = { agentId: e.agentId, label: e.agentId, spans: [], status: '' };
      spawn.lanes.push(lane);
    }
    agentSpawnMap.set(e.agentId, key);
    lane.label = e.model ? `${e.agentType} (${e.model})` : e.agentType;
    // Child events may have been buffering since before the link existed.
    flushChildBuffer(e.agentId);
    return true;
  }

  // ── Event → span mapping ───────────────────────────────────────────────────

  function apply(e: NormalizedEvent, ctx: EventContext): void {
    const ts = tsOrFallback(e.timestamp, latestTs);
    if (ts > latestTs) latestTs = ts;

    let mutated = false;

    // ── subagent-meta: canonical route is toolUseId → spawn ─────────────────
    // subagent-meta carries both toolUseId (the parent spawn) and agentId (the child).
    // toolUseId is the authoritative link — agentId→spawnId (via agentSpawnMap) is only
    // established here or at agent-end.
    // A forked skill's sidecar carries NO toolUseId — its block is keyed by the agent instead, so
    // the key here is the same `toolUseId ?? agentId` applyMeta resolves.
    const metaKey = e.type === 'subagent-meta' ? (e.toolUseId ?? e.agentId) : null;
    if (e.type === 'subagent-meta' && metaKey != null) {
      if (spawnById.has(metaKey)) {
        mutated = applyMeta(e);
      } else {
        // Spawn not seen yet (live ordering): park the meta until the spawn
        // tool-start arrives, instead of dropping it (see the LIVE-ordering test).
        metaBuffer.set(metaKey, e);
      }
      if (mutated) {
        _seq++;
        for (const cb of listeners) cb();
      }
      return;
    }

    // ── Child-file events (agentId set) ──────────────────────────────────────
    if (e.agentId != null) {
      const spawnId = agentSpawnMap.get(e.agentId);
      if (spawnId == null) {
        // Spawn linkage not yet established — buffer until agent-end fires.
        // Mutations fire when the buffer is flushed, not here.
        let buf = childBuffer.get(e.agentId);
        if (!buf) {
          buf = [];
          childBuffer.set(e.agentId, buf);
        }
        buf.push({ e, ctx });
      } else {
        mutated = applyChildEvent(e, ctx);
      }
      if (mutated) {
        _seq++;
        for (const cb of listeners) cb();
      }
      return;
    }

    // ── Main-session events (agentId null) ───────────────────────────────────

    if (e.type === 'user-turn' && e.agentId == null) {
      // Open a new turn and push a prompt span onto it.
      const idx = ctx.turnIndex ?? 1;
      // The SAME rule the Graph's rows use (`entryLabel`): a command's arguments are its prompt,
      // and alone they name nothing — this row read `del diff` for a `/code-review del diff`.
      const title = entryText(e.prompt, e.command ?? null) || '(prompt)';
      // kind: infer from the event because TurnKind is not on the event itself.
      // - a command with a specific name that manages context → 'context' (deferred; /clear and
      //   /compact are context turns, but we cannot distinguish them here without the full list)
      // - a command with any name → 'local' for now; the reducer's kindOf() is the authority, but
      //   we only have the event — this approximation is corrected by turn-end / usage arriving later
      // - no command → 'work'
      const kind: TraceTurn['kind'] = e.command != null ? 'local' : 'work';

      const promptSpan: TraceSpan = {
        id: nextId(),
        type: 'prompt',
        label: title,
        detail: null,
        t0: ts,
        t1: ts,
        turnIndex: idx,
        lane: 0,
        parentId: null,
        agent: null,
        status: 'ok',
        handle: { kind: 'turn-text', turnIndex: idx, which: 'prompt' },
      };
      const turn: TraceTurn = {
        index: idx,
        title,
        kind,
        t0: ts,
        t1: ts,
        state: 'live',
        spans: [promptSpan],
        spawns: [],
      };
      turns.set(idx, turn);
      mutated = true;
    } else if (e.type === 'usage' && ctx.newCall === true && e.agentId == null) {
      // Push one api span per NEW main-session API call.
      const idx = ctx.turnIndex;
      if (idx != null) {
        const turn = turns.get(idx);
        if (turn) {
          const t1 = ts + (ctx.callMs ?? 0);
          const span: TraceSpan = {
            id: nextId(),
            type: 'api',
            label: 'API call',
            detail: ctx.label ?? null,
            t0: ts,
            t1,
            turnIndex: idx,
            lane: 0,
            parentId: null,
            agent: null,
            status: e.apiError ? 'error' : 'ok',
            handle: e.callId ? { kind: 'call', callId: e.callId } : null,
          };
          turn.spans.push(span);
          if (t1 > turn.t1) turn.t1 = t1;
          mutated = true;
        }
      }
    } else if (e.type === 'turn-narration' && e.agentId == null && e.callId) {
      // The intent names the round its own call opened. It is anchored on `callId`, never on
      // "the last api span": one response is written as several jsonl lines (thinking, text,
      // each tool_use), so a slow line must not name whatever round happens to be open. The
      // span is already there because the call's FIRST line created it — this same line when
      // the text block leads (a line emits `usage` before its content blocks), an earlier
      // `thinking` line otherwise.
      // The reducer deliberately keeps only the LAST narration (the live NOW panel's datum);
      // the history the Trace needs lives here, one intent per span.
      const idx = ctx.turnIndex;
      const turn = idx != null ? turns.get(idx) : undefined;
      if (turn) {
        // Backwards: the call that just spoke is the most recent api span, not the turn's first.
        for (let i = turn.spans.length - 1; i >= 0; i--) {
          const s = turn.spans[i]!; // ! proven: i < spans.length
          if (s.type === 'api' && s.handle?.kind === 'call' && s.handle.callId === e.callId) {
            s.narration = e.text;
            mutated = true;
            break;
          }
        }
      }
    } else if (e.type === 'agent-launch') {
      // A forked skill (`/code-review`) has NO `Agent` tool_use: this line is the only record that
      // the round handed its work to an agent. Without it the Trace showed the round as an idle
      // one-liner for as long as the skill ran — the turn's own thread having done nothing.
      // Keyed by the agent id, which is the only name the launch gives it; every later child event
      // routes through `agentSpawnMap` exactly as a spawned subagent's does.
      const idx = ctx.turnIndex;
      const turn = idx == null ? null : turns.get(idx);
      if (turn && !spawnById.has(e.launchedAgentId)) {
        const label = e.skillName ? '/' + e.skillName : 'Agent';
        const span: TraceSpan = {
          id: nextId(),
          type: 'spawn',
          label,
          detail: e.description ?? null,
          t0: ts,
          t1: ts,
          turnIndex: idx!,
          lane: 0,
          parentId: null,
          agent: null,
          status: 'running',
          // `toolUseId` carries the same id as `spawnId`: the Trace links a spawn span to its
          // block through THIS field alone (adaptSnapshot), so a handle without it drew the block
          // with "no child events" while the lane existed in the store — the block present and
          // empty, which is the same invisibility with an extra step.
          handle: { kind: 'subagent', agentId: e.launchedAgentId, toolUseId: e.launchedAgentId },
        };
        const spawn: TraceSpawn = { spawnId: e.launchedAgentId, label, kind: label, lanes: [] };
        turn.spans.push(span);
        turn.spawns.push(spawn);
        // A round that launched an agent RAN THE MODEL, just not on this thread — the same call the
        // reducer's `kindOf` makes. The kind is guessed from the event when the turn opens (all a
        // `user-turn` carries is its command name), and this is the moment that guess is answered:
        // `/code-review` read `local`, beside `/model`, while its agent worked for ten minutes.
        if (turn.kind === 'local') turn.kind = 'work';
        spawnById.set(e.launchedAgentId, { turnIdx: idx!, spawn, span });
        openSpawnIds.add(e.launchedAgentId);
        // The round's envelope has to cover its delegated work: every other span-creating branch
        // propagates t1, and without it a ten-minute `/code-review` measured ~1s — a duration bar
        // that is a share of the longest turn, so the round read as the shortest thing on screen.
        if (ts > turn.t1) turn.t1 = ts;
        // Deliberately NOT `agentSpawnMap.set` / `flushChildBuffer` here — the same invariant the
        // ordinary spawn path keeps: the link is established only where a LANE exists to receive
        // the events (`applyMeta`, `agent-end`). Linking at the launch made the routing stop
        // buffering while there was still nowhere to route to, and the flush then dropped the
        // buffer it could not apply — every child event before the sidecar was lost.
        const parked = metaBuffer.get(e.launchedAgentId);
        if (parked) {
          metaBuffer.delete(e.launchedAgentId);
          applyMeta(parked as NormalizedEvent & { type: 'subagent-meta' });
        }
        mutated = true;
      }
    } else if (
      e.type === 'tool-start' &&
      e.agentId == null &&
      (SPAWN_TOOL_NAMES.has(e.name) || e.name === 'Workflow')
    ) {
      // Spawn tool (Agent/Task/Workflow): push a spawn span and register a TraceSpawn on the turn.
      const idx = ctx.turnIndex;
      if (idx != null) {
        const turn = turns.get(idx);
        if (turn) {
          const span: TraceSpan = {
            id: nextId(),
            type: 'spawn',
            label: e.name,
            // The launch INTENT, best first: the human description ("Finder A:
            // line-by-line scan") beats the prompt's first line, which beats the
            // generic subagentType — a fan-out of eight spawns all reading
            // "general-purpose" is indistinguishable.
            detail: e.description ?? (e.launchPrompt ? firstLine(e.launchPrompt) : null) ?? e.subagentType ?? null,
            t0: ts,
            t1: ts,
            turnIndex: idx,
            lane: 0,
            parentId: null,
            agent: null,
            status: 'running',
            handle: { kind: 'tool', toolUseId: e.id },
          };
          const spawn: TraceSpawn = { spawnId: e.id, label: e.name, kind: e.name, lanes: [] };
          turn.spans.push(span);
          turn.spawns.push(spawn);
          spawnById.set(e.id, { turnIdx: idx, spawn, span });
          openSpawnIds.add(e.id);
          // Live ordering: a subagent-meta for this spawn may already be parked
          // (the child starts writing before the parent's line lands) — apply it
          // now so the lane exists and its buffered child events flush.
          const parked = metaBuffer.get(e.id);
          if (parked) {
            metaBuffer.delete(e.id);
            applyMeta(parked as NormalizedEvent & { type: 'subagent-meta' });
          }
          mutated = true;
        }
      }
    } else if (e.type === 'tool-start' && e.agentId == null && !SPAWN_TOOL_NAMES.has(e.name) && e.name !== 'Workflow') {
      // LIMIT: skills are not yet ordered spans (attribution is not a per-event signal);
      // shown as turn chips in a follow-up.
      const idx = ctx.turnIndex;
      if (idx != null) {
        const turn = turns.get(idx);
        if (turn) {
          const span: TraceSpan = {
            id: nextId(),
            type: 'tool',
            label: e.name,
            detail: ctx.label ?? null,
            t0: ts,
            t1: ts,
            turnIndex: idx,
            lane: 0,
            parentId: null,
            agent: null,
            status: 'running',
            handle: { kind: 'tool', toolUseId: e.id },
          };
          turn.spans.push(span);
          openToolSpans.set(e.id, span);
          mutated = true;
        }
      }
    } else if (e.type === 'tool-end' && e.agentId == null) {
      const span = openToolSpans.get(e.toolUseId);
      if (span) {
        // A real tool failure (not a user refusal — the parser already excluded those) colours
        // the span; everything else closes 'ok'.
        span.t1 = ts;
        span.status = e.error ? 'error' : 'ok';
        openToolSpans.delete(e.toolUseId);
        // The span closes here either way: this call's WORK was launching the command, and how
        // long the command then ran is not this row's duration. Only its outcome is still owed.
        // Settled here for every call, applied only if it turns out to be a background launch —
        // the drain is unconditional so the map cannot grow for the session's life.
        const parked = pendingBgOutcome.get(e.toolUseId);
        if (parked) pendingBgOutcome.delete(e.toolUseId);
        if (e.background) {
          backgroundSpans.set(e.toolUseId, span);
          span.background = true;
          // Its outcome can have arrived ALREADY: Claude Code appends an assistant line when its
          // block closes, so a short command reports back before the call that launched it is
          // written (verified on a real session). Parked at `agent-end`, applied here.
          if (parked) {
            span.status = parked.clean ? 'ok' : 'error';
            if (!parked.clean && parked.summary) span.detail = outcomeLine(parked.summary);
          }
        }
        // Propagate t1 to the parent turn.
        const turn = turns.get(span.turnIndex);
        if (turn && ts > turn.t1) turn.t1 = ts;
        mutated = true;
      } else if (openSpawnIds.has(e.toolUseId)) {
        // Close the spawn span.
        const entry = spawnById.get(e.toolUseId);
        if (entry) {
          entry.span.t1 = ts;
          entry.span.status = 'ok';
          // A Workflow result carries runId; upgrade kind so the renderer can distinguish it.
          if (e.workflow?.runId) entry.spawn.kind = 'Workflow';
          openSpawnIds.delete(e.toolUseId);
          const turn = turns.get(entry.turnIdx);
          if (turn && ts > turn.t1) turn.t1 = ts;
          mutated = true;
        }
      }
    } else if (e.type === 'agent-end') {
      // Not every notification is about an agent: one naming a tool that launched a background
      // COMMAND is that command's outcome, and this is the only line that states it. The gate is
      // the launch receipt (`backgroundSpans`), never the id's shape — a resumed subagent's
      // notification names its SendMessage call, which launched nothing.
      const bgSpan = e.toolUseId ? backgroundSpans.get(e.toolUseId) : undefined;
      // Never for a call that IS a spawn: that notification is the agent's, and stamping its status
      // on the spawn row would say something about a tool that launched no command.
      if (!bgSpan && e.toolUseId && !spawnById.has(e.toolUseId)) {
        // The launch is not on the store yet — see the note where it is drained.
        pendingBgOutcome.set(e.toolUseId, {
          clean: e.status === null || e.status === 'completed' || e.status === 'stopped',
          summary: e.summary,
        });
      }
      if (bgSpan) {
        const clean = e.status === null || e.status === 'completed' || e.status === 'stopped';
        bgSpan.status = clean ? 'ok' : 'error';
        // Claude Code's own sentence replaces the command on the row, exactly as a failed API
        // call shows its error message instead of its input — reordered so the fate leads, since
        // the column truncates on the right (see outcomeLine). Only when the news is bad: a clean
        // exit has nothing to report that the row does not already say, and rewriting those rows
        // would churn the display for every `bun run` that simply finished.
        if (!clean && e.summary) bgSpan.detail = outcomeLine(e.summary);
        mutated = true;
      }
      // e.toolUseId identifies the spawn; e.taskId is the child's agentId.
      // agent-end is the definitive link: it establishes agentId → spawnId and flushes
      // any child events that arrived before the link was known.
      // After a resume the id names the SendMessage call instead of the spawn, so fall back
      // to the agentId→spawn link (same rule as the reducer) — otherwise the resumed agent's
      // lane keeps the status it had before the resume, forever.
      if (e.taskId != null) {
        // A notification can carry no spawn name at all (a forked skill has no spawning tool
        // call). Lanes hang off spawns here, so such an agent has no lane to update — it is
        // absent from the Trace rather than stuck in it, which is a separate gap.
        const entry =
          (e.toolUseId ? spawnById.get(e.toolUseId) : undefined) ??
          spawnById.get(agentSpawnMap.get(e.taskId) ?? '') ??
          // A forked skill's block is keyed by the AGENT itself, and `agentSpawnMap` is only
          // written where a lane exists — so on a skill whose sidecar never landed this is the
          // only route left to its own end.
          spawnById.get(e.taskId);
        if (entry) {
          const { spawn, span } = entry;
          // A forked skill has no `tool-end`, so this is the ONLY thing that can close its spawn
          // span: without it the block stayed `running` with a zero duration for good, on a skill
          // that had finished and a session that had closed.
          if (openSpawnIds.has(spawn.spawnId) && spawn.spawnId === e.taskId) {
            openSpawnIds.delete(spawn.spawnId);
            span.status = e.status === null || e.status === 'completed' || e.status === 'stopped' ? 'ok' : 'error';
            if (ts > span.t1) span.t1 = ts;
            // Same reason as at the launch: the round lasted as long as the work it delegated.
            const t = turns.get(span.turnIndex);
            if (t && ts > t.t1) t.t1 = ts;
          }
          let lane = spawn.lanes.find((l) => l.agentId === e.taskId);
          if (!lane) {
            lane = { agentId: e.taskId, label: e.taskId, spans: [], status: e.status ?? '' };
            spawn.lanes.push(lane);
          } else {
            lane.status = e.status ?? '';
          }
          agentSpawnMap.set(e.taskId, spawn.spawnId);
          // Flush buffered child events now that the lane exists.
          flushChildBuffer(e.taskId);
          mutated = true;
        }
      }
    } else if (e.type === 'turn-result' && e.agentId == null) {
      const idx = ctx.turnIndex;
      if (idx != null) {
        const turn = turns.get(idx);
        if (turn) {
          const span: TraceSpan = {
            id: nextId(),
            type: 'result',
            label: 'done',
            detail: firstLine(e.outputFull),
            t0: ts,
            t1: ts,
            turnIndex: idx,
            lane: 0,
            parentId: null,
            agent: null,
            status: 'ok',
            handle: { kind: 'turn-text', turnIndex: idx, which: 'result' },
          };
          turn.spans.push(span);
          if (ts > turn.t1) turn.t1 = ts;
          mutated = true;
        }
      }
    } else if (e.type === 'turn-end' && e.agentId == null) {
      const idx = ctx.turnIndex;
      if (idx != null) {
        const turn = turns.get(idx);
        if (turn) {
          turn.t1 = ts;
          turn.state = 'done';
          mutated = true;
        }
      }
    } else if (e.type === 'turn-interrupted' && e.agentId == null) {
      // Mark the currently open turn as interrupted. turnIndex from ctx is the open turn.
      const idx = ctx.turnIndex;
      if (idx != null) {
        const turn = turns.get(idx);
        if (turn) {
          turn.state = 'interrupted';
          mutated = true;
        }
      }
    }

    if (mutated) {
      _seq++;
      for (const cb of listeners) cb();
    }
  }

  // ── Snapshot ───────────────────────────────────────────────────────────────

  function snapshot(scopeTurn?: number | null): TraceSnapshot {
    let included: TraceTurn[];
    if (scopeTurn != null) {
      const t = turns.get(scopeTurn);
      included = t ? [t] : [];
    } else {
      included = [...turns.values()].sort((a, b) => a.index - b.index);
    }

    // Compute global t0 / t1 from spans in the included turns.
    let t0 = Infinity,
      t1 = -Infinity;
    for (const turn of included) {
      for (const span of turn.spans) {
        if (span.t0 < t0) t0 = span.t0;
        if (span.t1 > t1) t1 = span.t1;
      }
      // Also factor in the turn's own t0/t1 (open turns with no spans yet).
      if (turn.t0 < t0) t0 = turn.t0;
      if (turn.t1 > t1) t1 = turn.t1;
    }
    if (!Number.isFinite(t0)) t0 = 0;
    if (!Number.isFinite(t1)) t1 = 0;

    return { turns: included, t0, t1, seq: _seq };
  }

  function onChange(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }

  return { apply, snapshot, onChange };
}
