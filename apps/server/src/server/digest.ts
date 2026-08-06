import { type NowKind, nowLine } from '../core/activity-line.ts';
import { windowFor } from '../core/context-windows.ts';
import { delegatedWork, returnedWork, turnIsWorking } from '../core/graph-derive.ts';
import { runningBackground } from '../core/selectors.ts';
import { type AgentNode, hasStarted, type TreeSnapshot, type TurnNode } from '../core/session-tree.ts';
import { stripMarkdown } from '../core/tree-format.ts';
import { isLive, isModelBusy, pendingInput, type SessionRecord } from '../core/types.ts';

/**
 * Cap on the prompt a digest entry carries. The SAME cap `discovery.ts` applies to a session's
 * `subject` (`anon(text, 200)`), because it answers the same question — one human-readable
 * label for what this session is about. The reducer keeps the prompt up to 20 000 chars, which
 * a payload polled every second must not carry.
 */
export const PROMPT_HEAD = 200;

/** One running agent, as a thin client needs it. */
export interface DigestSubagent {
  agentId: string;
  agentType: string | null;
  /** The resolved launch label — the spawn's description, else the prompt's first line, else
   * the type. Carried because `agentType` names nothing on a fan-out: measured, 455 of 690 real
   * spawns report `general-purpose`, so eight rows would read identically. */
  title: string;
  model: string | null;
  fill: number;
  window: number;
  pct: number;
  estimated: boolean;
  toolCount: number;
  /** Null for a Workflow run's members: the journal records that one started, not when. */
  startedAt: string | null;
  /** The run this agent belongs to, or null for a directly-spawned subagent. */
  runId: string | null;
}

/**
 * What NOW says about the turn, decided by `nowLine` — the browser's NOW panel and this field are
 * the same function called from two places, so the two surfaces cannot describe one turn
 * differently. Null when there is nothing to say, which a client draws as no NOW at all.
 */
export interface DigestNow {
  /** Which voice is speaking: `waiting`/`activity` is seedeep counting, `intent`/`output` are the
   * agent's own words. A client that styles the agent's voice differently reads this. */
  kind: NowKind;
  /** `waiting for you` / `now` / `intent` / `output` — the portal's own labels. */
  label: string;
  /** Cut to {@link PROMPT_HEAD}, markdown already stripped: every consumer of this payload is a
   * glance surface with no modal to open the full text in. */
  text: string;
  /** Epoch ms an age counts from — the running call for `activity`, the narration for `intent`,
   * the block for `waiting` — or null when the state carries no age. The client turns it into a
   * ticking age; sending the age itself would expire in flight. */
  ageFrom: number | null;
}

/** The turn in progress (or the last one), reduced to what a status row shows. */
export interface DigestTurn {
  index: number;
  state: 'done' | 'interrupted' | 'live';
  startedAt: string | null;
  prompt: string;
  /** Reasoning efforts this turn's calls reported, first-seen order; empty when none did.
   * Claude Code only began writing the field in 2.1.212 — since then it is on 97–99% of assistant
   * lines (measured 2026-07-30 over 28 313), so a client that names it will nearly always have one,
   * and an empty array is "the transcript does not say", never "no effort". */
  efforts: string[];
  /** The one thing to say about this turn right now — see {@link DigestNow}. */
  now: DigestNow | null;
}

/** A background command the session is still waiting on, as a status row names it. */
export interface DigestCommand {
  /** The launch call — a client that can open a drawer opens THAT one. */
  toolUseId: string;
  command: string;
  /** Epoch ms of the launch. The age is the client's to compute; an age sent over a poll would
   * expire in flight, exactly like `now.ageFrom`. */
  since: number;
}

/** One live session, whole, in one entry — a client never joins two payloads to draw a row. */
export interface DigestEntry {
  sessionId: string;
  project: string;
  subject: string | null;
  /**
   * How the session was launched — `cli` for an interactive one, `sdk-cli`/`sdk-py` for a
   * headless run, null when the transcript does not say. The FACT, not the verdict: a client
   * that shows only interactive sessions (the tray does) applies the same `sdk` rule the
   * browser's picker does, and nothing here decides for it.
   */
  entrypoint: string | null;
  /**
   * The highest line number applied on ANY of the session's files. NOT a change sentinel: each
   * file has its own seq space starting at 0, so a burst that only moved a subagent's transcript
   * leaves this untouched while the state changes. The ETag is what says "nothing changed".
   */
  seq: number;
  status: SessionRecord['status'];
  waitingFor: string | null;
  waitingSince: number | null;
  /** Epoch ms of the transcript's last write. What an IDLE session has instead of activity —
   * a client turns it into "quiet for 12m". Live sessions all have one; it is the roster's
   * `lastActivity`, not a second reading of the file. */
  lastActivity: number;
  /**
   * The call the session is BLOCKED on, named — `Bash` + the command, so a status row can say
   * what it is being asked to approve instead of only that something is pending.
   *
   * Null unless the session is actually waiting: this is the JOIN of the roster's `waitingFor`
   * with the tree's open call, and outside a wait the same call is just work in progress, which
   * `turn.now` already counts.
   *
   * Null too whenever the transcript does not carry the call — which is NOT DETERMINISTIC and is
   * not a short window. Measured 2026-07-30 at 5Hz on real `Bash` approvals: every wait began
   * with zero open calls on disk; one saw the line land 0.2s in, another never saw it at all
   * across 46.5s, a third was still missing it 2.9s after its own timestamp. So a null here is
   * usually the truth about the file, not a miss, and no amount of waiting reliably fixes it.
   * A plan approval has no call behind it at all.
   *
   * Naming a gated call reliably needs a source that is not the transcript — a `PreToolUse` hook,
   * which fires before the dialog and carries `tool_input.command`. Not built yet; until then the
   * client falls back to naming no tool, and never to guessing one.
   */
  pendingTool: { name: string; arg: string | null } | null;
  main: { fill: number; window: number; pct: number; estimated: boolean; model: string | null };
  totals: {
    turns: number;
    apiCalls: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
    /** Σ over the session's subagents — billed against their own contexts, never the main
     * window's, which is why it is a figure of its own and not folded into the four above. */
    subagents: number;
  };
  turn: DigestTurn | null;
  /**
   * Non-null while the session's last model call is a FAILED one — the reducer's
   * `TreeSnapshot.error`, passed through, which is why the tray and the browser's tab strip
   * cannot disagree about whether a session is broken.
   *
   * Cleared by the next call that reaches a model, never by time: measured over 1830 real
   * transcripts, 39 of 47 errors were the last model line of their session, and no recovery came
   * within 10 s. `agentId` names a subagent whose call failed (8 of those 47), null for the main
   * thread. `message` is the text the user was shown, already `anon()`-capped by the parser.
   */
  error: { at: number | null; status: string | null; message: string; agentId: string | null } | null;
  /**
   * Every agent still working. `running` always equals `list.length`, so a count and its rows can
   * never disagree. `launched` is the session's whole history — see {@link launchedCount}.
   *
   * The list is in EVERY entry, not only the single-session one it used to be gated behind: the
   * tray draws the agents themselves and polls only the array form, so gating it there meant the
   * fact simply did not exist for the client that needed it. What that gate bought — a bounded
   * entry — is bounded by the work instead: the list holds only agents that are RUNNING, which is
   * nothing at all for most of a session's life.
   */
  subagents: { running: number; launched: number; list: DigestSubagent[] };
  /**
   * The background commands the session launched and has not been told the fate of — what makes a
   * session that has stopped talking still be waiting on something. Same derivation the browser
   * reads (`runningBackground`), so the two surfaces cannot disagree about what is still running.
   */
  background: DigestCommand[];
}

/**
 * Every agent still working, including the members of a running Workflow run. A run takes ONE
 * row in the browser because expanding ~100 children would flood the list; a COUNT is not a
 * list, and answering "16 agents are working" with `1` would be false. The members carry the
 * same fields as a direct spawn (`workflow.members`), so nothing is invented to include them.
 */
function runningAgents(subagents: readonly AgentNode[]): DigestSubagent[] {
  const out: DigestSubagent[] = [];
  for (const a of subagents) {
    // ONE rule for both shapes: a node that is not running contributes nothing. A run whose
    // spawn ended still lists members with `returned: false` — the journal never recorded their
    // return (measured: 4 of 101 on a real run) — and counting those would print agents at work
    // for a workflow that finished.
    if (a.state !== 'running') continue;
    // The same rule the Graph applies (`hasStarted`), for the same reason and from the same
    // definition: a launch that has given no sign of itself is not an agent at work, and this
    // count is the one a status row prints as a number nobody can check. A run is exempt — its
    // members are what work, and their own `returned` flags decide below.
    if (!a.workflow && !hasStarted(a)) continue;
    if (a.workflow) {
      for (const m of a.workflow.members) {
        if (m.returned) continue;
        // `pct` is the reducer's scale (0–100, `Math.round((fill/window)*100)`), not a ratio:
        // one field cannot carry two scales. `estimated` is not in `members`, so it is resolved
        // from the SAME table the reducer used — a member whose model is not yet known is shown
        // against the fallback window, and must say so.
        const w = windowFor(m.model);
        out.push({
          agentId: m.agentId,
          agentType: m.agentType,
          title: m.agentType ?? m.agentId,
          model: m.model,
          fill: m.fill,
          window: m.window,
          pct: m.window > 0 ? Math.round((m.fill / m.window) * 100) : 0,
          estimated: w.estimated,
          toolCount: m.toolCount,
          startedAt: null,
          runId: a.workflow.runId,
        });
      }
      continue;
    }
    out.push({
      agentId: a.agentId,
      agentType: a.agentType,
      title: a.title,
      model: a.model,
      fill: a.fill,
      window: a.window,
      pct: a.pct,
      estimated: a.estimated,
      toolCount: a.tools.length,
      startedAt: a.startedAt,
      runId: null,
    });
  }
  return out;
}

/**
 * How many subagents the session has LAUNCHED, over its whole life — `running` answers what is at
 * work this second, and once the last one returns that figure is 0 with nothing left to say that
 * the session used any.
 *
 * A Workflow run contributes its MEMBERS (`workflow.agents`), not the one row it takes in the
 * browser: the question is how many agents were started, and a run of 100 answering `1` would be
 * false — the same reason {@link runningAgents} counts members rather than runs.
 *
 * A launch still `running` with no sign of itself (`hasStarted`) is not counted, exactly as the
 * running list does not list it: measured 2026-07-29, that is what all 3 never-ended subagents in
 * 910 ended sessions look like, and a real one leaves its first trace within 0.30s. A launch that
 * has REACHED a terminal state is counted whatever it left behind — its outcome is the record that
 * it ran, and requiring a second one would undercount finished work.
 */
export function launchedCount(subagents: readonly AgentNode[]): number {
  let n = 0;
  for (const a of subagents) {
    if (a.workflow) {
      n += a.workflow.agents;
      continue;
    }
    if (a.state === 'running' && !hasStarted(a)) continue;
    n++;
  }
  return n;
}

/**
 * Project one live session into its digest entry: the roster record's liveness joined with the
 * live tree's derived state. A JOIN, not a derivation — every field is read from one source, so
 * no fact can be computed one way here and another way in the browser.
 *
 * Lives beside `roster.ts` rather than in `core/` on purpose: this is a WIRE FORMAT, the shape
 * one client needs in one poll, not a meaning. `core/` answers what a session IS; letting a
 * payload shape in there invites the next endpoint to add its own.
 */
export function digestEntry(
  rec: SessionRecord,
  snap: TreeSnapshot,
  opts: { now: number; wordSeenAt: number | null },
): DigestEntry {
  // The turn in view is the last one: turns are appended in order, so the live turn — when
  // there is one — is always at the end. Same choice the browser's NOW panel makes.
  const turn = snap.turnList.at(-1) ?? null;
  const agents = runningAgents(snap.subagents);
  const pendingTool =
    rec.waitingFor === null || snap.openCall === null ? null : { name: snap.openCall.name, arg: snap.openCall.arg };
  return {
    sessionId: rec.sessionId,
    project: rec.project,
    subject: rec.subject,
    entrypoint: rec.entrypoint,
    seq: snap.seq,
    status: rec.status,
    waitingFor: rec.waitingFor,
    waitingSince: rec.waitingSince,
    lastActivity: rec.lastActivity,
    pendingTool,
    main: {
      fill: snap.main.fill,
      window: snap.main.window,
      pct: snap.main.pct,
      estimated: snap.main.estimated,
      model: snap.main.model,
    },
    totals: {
      turns: snap.turns,
      apiCalls: snap.apiCalls,
      input: snap.main.inputTotal,
      output: snap.main.outputTotal,
      cacheRead: snap.main.cacheTotals.read,
      cacheCreation: snap.main.cacheTotals.created,
      subagents: snap.subagentsTotal,
    },
    turn:
      turn === null
        ? null
        : {
            index: turn.index,
            // The same answer `now` is computed from: a turn whose file has gone quiet while the
            // process works is WORKING, and a payload that said `done` beside a live NOW made the
            // tray draw the settled voice on a session that had not settled. `interrupted` is
            // never overwritten — that one IS a fact about the transcript.
            state:
              turn.state !== 'interrupted' && turnIsWorking(turn, true, { ended: !isLive(rec), busy: isModelBusy(rec) })
                ? 'live'
                : turn.state,
            startedAt: turn.startedAt,
            prompt: turn.prompt.slice(0, PROMPT_HEAD),
            efforts: turn.efforts,
            // `delegated` comes from the same rule the browser's panel and the Subagents card
            // use — see delegatedWork.
            now: digestNow(
              rec,
              turn,
              pendingTool,
              delegatedWork(turn.index, snap.subagents, !isLive(rec), opts.now),
              returnedWork(turn.index, snap.subagents, !isLive(rec), opts.now),
              opts,
            ),
          },
    error: snap.error && { ...snap.error },
    subagents: { running: agents.length, launched: launchedCount(snap.subagents), list: agents },
    background: runningBackground(snap.mainTools).map((c) => ({
      toolUseId: c.toolUseId,
      command: c.command,
      since: Date.parse(c.since),
    })),
  };
}

/**
 * The turn's NOW, as the wire carries it: `nowLine`'s answer with its text reduced to a glance.
 *
 * Every input is read straight from the record or the reducer — nothing here decides anything the
 * browser decides for itself. `wordSeenAt` is the exception that proves it: only an observer knows
 * when a word reached it, so the server passes its OWN sighting (`live-trees.ts`) into the same
 * rule the browser feeds with the browser's.
 */
function digestNow(
  rec: SessionRecord,
  turn: TurnNode,
  pendingTool: { name: string; arg: string | null } | null,
  delegated: { label: string; since: number | null; count: number } | null,
  returned: { label: string; at: number | null } | null,
  opts: { now: number; wordSeenAt: number | null },
): DigestNow | null {
  const state = nowLine(
    {
      waiting: pendingInput(rec),
      pendingTool,
      waitingSince: rec.waitingSince,
      // A turn is only live while its SESSION is: a transcript whose process is gone keeps its last
      // turn marked `live`, and a row that read that alone said `now` about a session that stopped.
      // The turn in view is always the LAST one here (see digestEntry), and the process is the
      // authority on "right now" — see turnIsWorking.
      live: turnIsWorking(turn, true, { ended: !isLive(rec), busy: isModelBusy(rec) }),
      result: turn.result,
      narration: turn.lastNarration,
      wordTs: turn.lastWordTs,
      wordSeenAt: opts.wordSeenAt,
      activity: turn.activity,
      delegated,
      returned,
      apiCalls: turn.apiCalls,
      startedAt: turn.startedAt ? Date.parse(turn.startedAt) || null : null,
    },
    opts.now,
  );
  if (state === null) return null;
  const text = glance(state.text);
  return text === null ? null : { kind: state.kind, label: state.label, text, ageFrom: state.ageFrom };
}

/**
 * One of the agent's own utterances, as a glance surface needs it: markdown stripped, then cut to
 * {@link PROMPT_HEAD}.
 *
 * In that order, and both here rather than in the client. Stripping first spends the 200 characters
 * on words instead of on `**` and backticks — and the cut has to happen after, or a head taken
 * mid-marker leaves a dangling one. Here rather than in the client because this is the only form
 * these two fields are wanted in: the digest exists for clients that cannot render markdown and
 * have no modal to open the full text in, which is exactly why the tray was showing
 * `**Il job \`publish\`**` verbatim. The browser does not read the digest, and keeps the raw
 * markdown it needs from the reducer.
 */
function glance(text: string | null): string | null {
  if (text === null) return null;
  const plain = stripMarkdown(text).slice(0, PROMPT_HEAD);
  // A narration that was nothing but markers is not a thing to show.
  return plain === '' ? null : plain;
}
