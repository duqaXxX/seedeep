import { callWeight } from './token-weight.ts';
import type { BackgroundAuthor, NormalizedEvent, SubagentReturned, TaskRef } from './types.ts';
import { SPAWN_TOOL_NAMES } from './types.ts';

// Re-exported for the view, which must mark a spawn row exactly as the reducer counts one.
// A second list in the view is how `Task` came to launch a subagent the tree knew about and
// the feed drew as an ordinary tool.
export { SPAWN_TOOL_NAMES };

// No per-tool token count: the jsonl tool_result block carries no token field
// (verified), so a tool node has only a name, a derived duration, and (from the
// tool_use input / tool_result) a human-meaningful arg + output size.
// `id` is the tool_use_id: the key that lets a view holding only an id (the live-activity
// ring keeps ids, not tool state) resolve back to this node instead of keeping its own copy.
export interface ToolNode {
  id: string;
  name: string;
  ms: number | null;
  arg: string | null;
  ctx: number;
  turnIndex: number | null;
  error?: true;
  // A background command's fate in Claude Code's own words ("Background command "Start seedeep
  // server" failed with exit code 144"). Present only on a Bash that launched one, and only once
  // its notification has arrived — the tool_result was just a launch receipt, so until then this
  // row has no outcome to state. `error` is set alongside for anything but a clean exit.
  outcome?: string;
  /** The notification's raw `<status>` (`completed` | `failed` | `killed` | `stopped`). Carried
   * beside the sentence so a surface can classify the fate without parsing English — the sentence
   * is for the reader, this is for the code. */
  outcomeStatus?: string | null;
  /** When the notification arrived. The command's REAL duration is `outcomeTs - startedTs`: `ms`
   * measures the launch receipt, which closes in milliseconds and says nothing about the command. */
  outcomeTs?: string;
  /** Where Claude Code wrote the command's output. Only its notification names it, so a command
   * still running has none — and neither has one whose notification never came. */
  outputFile?: string;
  /** When the liveness probe found no process holding this command's output file open any more.
   * Set ONLY on a launch the transcript never closed, and deliberately not an `outcome`: nobody
   * ever said what became of it, so every surface must read it as `unknown`, never as an end. */
  vanishedTs?: string;
  /** The last probe that still found it alive — the lower bound of how long it ran. Absent when
   * seedeep started watching after it was already gone, in which case there is no bound to state. */
  lastSeenAliveTs?: string;
  /** The launch's own `description` — the name Claude Code quotes back in the notification, and
   * the only human-readable label a background command has. Absent when the launch carried none. */
  description?: string;
  /** This call LAUNCHED a background command. Present on the launch, whatever became of it —
   * `outcome` is what says it ended, so `background && !outcome` is one still running. */
  background?: true;
  /** Claude Code's own id for the command (`backgroundTaskId`). Carried because it is what names
   * the command's output file on disk, which is the only thing that can be asked whether the
   * process is still alive — see `command-liveness.ts`. */
  backgroundTaskId?: string;
  /** Who put the command in the background. Only on a background launch, and always set there. */
  backgroundBy?: BackgroundAuthor;
  /** When the launch happened, for the age a running command is shown with. Only on a background
   * launch: the whole ledger carrying a timestamp it has no use for would be paid on every tool. */
  startedTs?: string;
  /** How many events this task has forwarded while running — a `Monitor`'s only visible output.
   * Absent on a background command that reports nothing, which is every Bash: the count is a
   * property of a stream, and a row shows it only when there is one. */
  events?: number;
  /** The most recent of those events, verbatim. The row shows this one and no more: a stream can
   * forward hundreds, and the history of them is not what a "what is still running" list is for. */
  lastEvent?: string;
  /** What a hook had to say about THIS call — today, almost always the security plugin warning
   * about what was just written. Absent on the great majority of calls, which is the point: a
   * marked row means someone flagged it. */
  notes?: { source: string | null; hook: string | null; text: string }[];
}
// One `file-history-delta`: a single change to one file, attributed to the turn it happened in.
// Kept as one node per delta rather than pre-aggregated, so `scopeToTurn` can filter by turnIndex
// exactly as it does for tools; `changedFiles` collapses them to the distinct paths it displays.
export interface FileChangeNode {
  path: string;
  turnIndex: number | null;
  ts: string;
}
export interface AgentNode {
  // A `Workflow` launch is not a subagent — it is a script that spawns its own. It takes one
  // aggregate row (`workflow` set) instead of listing its ~100 subagents.
  // INVARIANT: `kind === 'workflow'` ⟺ `workflow !== null`. Both are derived from the same
  // value in snapshot() so they cannot disagree — when they could, the view's workflow
  // renderer dereferenced a null `workflow` and took the whole render down with it.
  kind: 'subagent' | 'workflow';
  workflow: {
    name: string | null;
    runId: string;
    agents: number; // subagents the run spawned (members ∪ journal-started)
    running: number; // started, not yet returned (from journal.jsonl)
    volume: number; // Σ tokens over the run's subagents — a true per-call sum, never estimated
    /** Σ WEIGHT over the run's subagents. A run takes ONE row instead of its ~100 children, so
     * without this their weight would exist in no node at all and any total summed from the nodes
     * would silently miss it (measured: 2 of 284 real sessions, one off by 27.6%). */
    weighted: number;
    breakdown: { input: number; output: number; cacheRead: number; cacheCreation: number };
    models: { model: string; agents: number }[]; // a run mixes models per stage — never one value
    // `models` counts AGENTS per model; this splits the run's `volume` by the model of each
    // call. The two rank differently — a fleet of cheap agents can outnumber the ones that
    // burn the tokens — so neither substitutes for the other.
    tokensByModel: { model: string; tokens: number }[];
    // Epoch ms of the last line ANY of the run's subagents wrote, or null if none yet. The
    // view needs it because a KILLED workflow leaves no trace at all: Claude Code writes a
    // `<status>killed</status>` notification for a subagent but NOTHING for a workflow
    // (verified: 0 notifications for a killed run, empty task output file, journal keeps only
    // its `started` lines). Silence is then the only evidence the run is over.
    lastActivityAt: number | null;
    /** One entry per member agent, for the workflow drawer. */
    members: {
      agentId: string;
      agentType: string | null;
      model: string | null;
      volume: number;
      fill: number;
      window: number;
      returned: boolean;
      durationMs: number | null;
      outLen: number;
      efforts: string[];
      toolCount: number;
    }[];
  } | null;
  agentId: string;
  agentType: string | null;
  model: string | null;
  // What this subagent was launched TO DO, resolved once here so every surface agrees:
  // the spawn's `description` ("Review Task 5"), else the prompt's first line, else the
  // type, else the id. A fan-out of eight rows all reading `general-purpose` names none
  // of them — measured, that is 455 of 690 real spawns. Same chain the Trace uses.
  title: string;
  /** Distinct reasoning efforts this subagent's own calls reported; empty when none did. */
  efforts: string[];
  fill: number;
  window: number;
  pct: number;
  estimated: boolean;
  // `running` = launched, no terminal signal yet. The view turns it into `unknown` when the
  // session is closed: only the view knows that, and only then does "no signal" stop meaning
  // "still working". `failed`/`killed` come from the task-notification's status.
  state: 'running' | 'done' | 'failed' | 'killed';
  startedAt: string | null;
  durationMs: number | null;
  tools: ToolNode[];
  // tool_use_id of the parent `Agent` spawn — the only handle a spawn event has on this
  // agent, since its agentId is only learned later (from `subagent-meta`).
  toolUseId: string | null;
  // From the parent `Agent` spawn/result (linked by toolUseId): the launch prompt and
  // the verbatim output returned to main.
  prompt: string | null;
  outputFull: string | null;
  outLen: number;
  // Cumulative tokens the subagent consumed (Σ input+output+cache over its calls), so it is
  // comparable to the main Token usage. `volumeEstimated` = the child jsonl carried no per-call
  // usage (a background subagent), so this is the parent-reported total ≈ its final context,
  // NOT a true sum. Distinct from `fill`, which is only the last call's context.
  volume: number;
  volumeEstimated: boolean;
  /** This subagent's WEIGHT (see `src/core/token-weight.ts`) — the weighted mirror of `volume`, and
   * the per-agent figure a turn-scoped snapshot sums instead of the session's `weightedSubagents`.
   * 0 for a background subagent that reported only a total: a weight needs the token TYPES. */
  weighted: number;
  // `volume` split by the model of each call, summing to it exactly. An estimated volume has no
  // per-call detail, so it lands wholly on the agent's own model — the total stays right and the
  // card's `~` already says the figure is approximate. `model: null` only when nothing named a
  // model at all; those tokens are still listed rather than dropped.
  volumeByModel: { model: string | null; tokens: number }[];
  // The four usage-block categories behind `volume`, for the drawer — null when estimated (a
  // parent-reported total has no per-category split). Mirrors the main Token usage categories.
  volumeBreakdown: { input: number; output: number; cacheRead: number; cacheCreation: number } | null;
  turnIndex: number | null; // turn in which this agent was spawned
}
/**
 * Whether an agent has given ANY sign of itself: a type from its sidecar, tokens billed to it,
 * a tool it ran, or text it returned. Any one of them is a line Claude Code wrote about this
 * agent, so the test is deliberately generous — it takes one fact to pass.
 *
 * Measured 2026-07-29 over 1171 real spawns: a subagent's first trace lands **0.07s** after its
 * launch (p90 0.08s, max 0.30s, 100% under a second), so with a 300ms watcher tick nothing real
 * can sit traceless for more than about half a second. That is what makes "no trace" a fact
 * about the launch rather than a race against a young agent — and it is the whole reason this is
 * not a timeout: nothing here measures how LONG anything took.
 */
export function hasStarted(a: AgentNode): boolean {
  return a.agentType !== null || a.fill > 0 || a.tools.length > 0 || a.outputFull !== null;
}

export interface CompactionNode {
  pre: number | null;
  post: number | null;
  delta: number | null;
  ms: number | null;
}
// turns = assistant lines this skill drove (attributionSkill); invokes = explicit
// Skill tool calls. NO token field: a turn's tokens are the whole cumulative
// context, not one skill's — per-skill token attribution would be a fabricated number.
export interface SkillNode {
  name: string;
  turns: number;
  invokes: number;
}
export interface CommandNode {
  name: string;
  count: number;
}

/**
 * What a timeline entry turned out to BE — decided by what it cost, not by its name:
 * - `work`    a round that consumed tokens (a typed prompt, or a slash command that ran
 *             the model: /paste-image, /code-review…). Also the still-open entry, until
 *             it closes without having cost anything.
 * - `local`   sent, but closed without burning a single token and without an Esc: the
 *             local built-ins (/model, /effort, /usage). No list of them is kept anywhere —
 *             the token count is the proof, and it cannot go stale.
 * - `context` /clear and /compact: the two commands whose job IS to move the context
 *             window. A closed, intrinsic pair — not an open-ended list of "commands that
 *             run the model", which is exactly what would rot.
 */
export type TurnKind = 'work' | 'local' | 'context';
// The commands that exist to mutate the context window. /compact costs real tokens (it
// summarizes) and /clear costs none — cost cannot separate them from a normal turn, only
// intent can, so these two are named here and nowhere else.
const CONTEXT_COMMANDS = new Set(['clear', 'compact']);

export interface TurnNode {
  index: number;
  prompt: string;
  command: string | null; // the slash command that opened it, or null when typed
  kind: TurnKind;
  startedAt: string | null;
  // `live` means WORKING, not merely open: an entry only goes live once it has consumed a
  // token. Otherwise a /model — which opens an entry and never calls the model — would sit
  // there pulsing green until the next prompt.
  state: 'done' | 'interrupted' | 'live';
  durationMs: number | null;
  messageCount: number | null;
  apiCalls: number;
  /** Models this turn's own calls ran on, first-seen order. Empty when it made no call. */
  models: string[];
  /** Reasoning efforts this turn's calls reported; empty when none did — the 98% case. */
  efforts: string[];
  deltaFill: number; // fill added by this turn (negative = compaction freed context)
  fillEnd: number; // absolute fill at the end of the turn
  breakdown: { input: number; cacheRead: number; cacheCreation: number };
  cacheTotals: CacheTotals; // summed over the turn's calls — see the type
  inputTotal: number; // input_tokens summed over the turn (Token usage card)
  out: number; // output tokens produced in this turn
  /** This turn's MAIN-thread weight — see {@link callWeight}. Excludes its subagents, whose
   * weight is a fact about the child (and reaches the session total via `weightedSubagents`). */
  weighted: number;
  agentIds: string[]; // agentIds of subagents spawned in this turn
  // Skills/commands carry TURN-LOCAL counts, not the session's: a widget scoped to a
  // turn must not show how often a command was typed across the whole session.
  skills: SkillNode[]; // skills active in this turn, with this turn's counts
  commands: CommandNode[]; // slash commands used in this turn, with this turn's counts
  compaction: boolean; // whether a context compaction occurred in this turn
  // The turn's FIRST API call: how much of its prompt it had to RE-CREATE (`cacheCreation`) and
  // how big that prompt was (`fill`). Kept as the pair, not a ratio: the verdict's resume rule
  // needs both — a 95% rebuild of a 3k context is not the same event as a 95% rebuild of 200k —
  // and no other field can stand in, since `cacheTotals.created` sums the WHOLE turn and
  // `breakdown` holds the LAST call. Null when the turn made no call carrying a context.
  firstCall: { cacheCreation: number; fill: number } | null;
  // A rebuilt context is EXPECTED on this turn's first call: it is the session's first call
  // (the window has to be built once), or a compaction reset the window since the previous
  // turn's first call. Both re-create the prompt by design, so the resume detector must not
  // read them as waste. Measured: they are 32% of the turns whose first call rebuilds.
  rebuildExpected: boolean;
  result: string | null; // null when interrupted — the signal
  // The live intent panel (V1): the model's latest mid-turn narration this turn — the current
  // stated intent (last wins), shown until the turn's final output takes over.
  lastNarration: NarrationEntry | null;
  // What the agent has DONE since it last said anything (see ActivityGroup). Null when it has
  // spoken more recently than it acted, which is when the narration alone is still current.
  activity: ActivityGroup | null;
  // WHEN the turn last spoke — the later of its last narration and its final output. The view
  // needs the instant, not just the text: a word that has just landed keeps the panel for as long
  // as it takes to read (see `narrationHoldMs`) before the activity group takes over.
  lastWordTs: string | null;
}

/** One mid-turn narration: the model's stated intent and when it said it. */
export interface NarrationEntry {
  ts: string;
  text: string;
}

/**
 * The turn's tool calls SINCE its last word — the group the NOW panel narrates while the agent
 * works in silence. Measured on real sessions: a narration stands for a median of 24s (p90 100s)
 * while ~8 calls run under it, so the panel would otherwise state an intent the agent has left
 * behind. Derived from the tool ledger on every snapshot, never accumulated: a re-sent line
 * rewrites the same ledger entry, so no count can drift.
 *
 * `counts` is per tool NAME (the view maps names to words); `open` are the calls with no result
 * yet, each with its start, so the view can decide when a call has run long enough to be worth
 * a present tense. Main session only: a subagent's calls are its own lane's business.
 */
export interface ActivityGroup {
  counts: Record<string, number>;
  startedTs: string; // the group's first call — its age
  open: { name: string; startedTs: string }[]; // still running, newest last
}

/**
 * Cache tokens SUMMED over a scope (the session, or one turn) — distinct from `breakdown`,
 * which is the last call's absolute prompt composition.
 *
 * The two answer different questions and must not be conflated (they were). `breakdown`
 * answers "what is the window made of right now", so it can only ever be the latest call.
 * Cache efficiency asks "how much did I re-read vs re-create", which is a SUM over every call
 * in the scope. Reading it off the last call instead put a green 99% badge on turns that had
 * re-created hundreds of thousands of tokens — because a turn's last call is its final answer,
 * which adds almost nothing new and is therefore structurally its cheapest.
 */
export interface CacheTotals {
  read: number;
  created: number;
}

export interface TreeSnapshot {
  // `model` is the one in force NOW (the window's denominator); `models` is every model the
  // session has run on, in order, so a mid-session switch stays visible instead of silent.
  main: {
    fill: number;
    window: number;
    pct: number;
    estimated: boolean;
    model: string | null;
    models: string[];
    regions: string[];
    breakdown: { input: number; cacheRead: number; cacheCreation: number };
    cacheTotals: CacheTotals;
    inputTotal: number;
    outputTotal: number;
    weighted: number;
    /** `weighted` split by the model of the call, MAIN THREAD ONLY, weight descending. Distinct from
     * the session-level `weightedByModel`, which folds the subagents in. */
    weightedByModel: { model: string; weight: number }[];
  };
  mainTools: ToolNode[];
  // Files changed in scope, one node per change event (CC's file-history ledger). Flat like
  // mainTools so scopeToTurn filters by turnIndex; the widget aggregates by path.
  filesChanged: FileChangeNode[];
  subagents: AgentNode[];
  // Whole-session subagent tokens (sum of each subagent's cumulative `volume`) — the same
  // metric the main Token usage card sums, so the two are comparable. Shown as a separate row,
  // never folded into the four main categories: a subagent's tokens are billed under its own
  // context, not the main window's.
  subagentsTotal: number;
  // True when at least one subagent's volume is estimated (a background subagent with no per-call
  // usage), so `subagentsTotal` is a blend of exact sums and last-call approximations — the card
  // marks it (a `~`) instead of presenting the blend as one exact figure.
  subagentsEstimated: boolean;
  // `subagentsTotal` split by model, summing to it exactly — the per-model detail behind the
  // card's single Subagents figure. Main-thread tokens are NEVER in here: the two live on
  // opposite sides of the reducer's `owner === null` branch. Sorted by tokens desc.
  subagentTokensByModel: { model: string | null; tokens: number }[];
  /** Whole-session subagent WEIGHT (Σ over the children's calls) — the weighted mirror of
   * `subagentsTotal`. A background subagent reporting only one `totalTokens` and no per-call usage
   * contributes 0: `subagentsTotal` can approximate from a last call, a weight cannot (it needs the
   * token TYPES). Kept apart from `main.weighted` so a session total is one deliberate sum. */
  weightedSubagents: number;
  /** `main.weighted + weightedSubagents` split by the model of the call, weight descending. Sums
   * to that total exactly; a call whose model has no known weight contributes to neither. */
  weightedByModel: { model: string; weight: number }[];
  compactions: CompactionNode[];
  skills: SkillNode[];
  commands: CommandNode[]; // slash commands the user typed, by frequency
  turns: number; // rounds of WORK (kind 'work'); the timeline holds more than these
  apiCalls: number; // main-session model calls — distinct message.ids, NOT usage lines
  seq: number;
  turnList: TurnNode[]; // per-turn breakdown; use scopeToTurn() to filter the snapshot
  /**
   * The newest main-session tool call that started and never returned — what the session is
   * doing right now, and (when it is blocked) what it is stopped on: Claude Code writes the
   * `tool_use` line BEFORE raising the approval dialog, so the call is already on record.
   * Null when nothing is open. Subagent calls are excluded: they are their own lane's business.
   *
   * Session-scoped by nature, so `scopeToTurn` passes it through unchanged — it describes the
   * live head of the session, never the turn a scoped snapshot is about.
   */
  openCall: { name: string; arg: string | null; startedTs: string } | null;
  /**
   * The session's last model call FAILED, and nothing has succeeded since. Null otherwise.
   *
   * Set by any call flagged `isApiErrorMessage` — the MAIN thread's or a subagent's (`agentId`
   * names which). A subagent's failure is the session's: measured over 1830 real transcripts, 8
   * of 47 errors were a child's, 7 of them rate limits a fan-out hit while the main thread still
   * looked healthy. Cleared only by a call that reached a model; another `<synthetic>` line is
   * not a recovery (Claude Code writes "No response requested." with no model), and neither is
   * time passing.
   *
   * A STATE, not an event, because that is what the data says: of those 47 errors, 39 were the
   * last model line of their transcript — the session died there — and no recovery arrived
   * within 10 s (p50 5.7 min, i.e. a human retried). Claude Code's own in-flight retries are
   * never written; what lands on disk is the final error the user was shown. Two errors in one
   * file are 125 s apart at the closest, so a surface keyed on this cannot flicker.
   *
   * Session-scoped like `openCall`, so `scopeToTurn` passes it through unchanged.
   */
  error: { at: number | null; status: string | null; message: string; agentId: string | null } | null;
  /**
   * The instant the session has arranged to wake itself at (a self-paced `/loop`), or null when it
   * has arranged none — never armed, or the loop was stopped.
   *
   * Last-wins, and that is the whole rule: a dynamic loop re-arms every turn, so only the newest
   * arming is what the session is waiting for. Says nothing about whether it FIRED — no line in
   * the transcript does, so a surface shows this while the instant is still ahead and then stops
   * showing it, which is the honest shape of what seedeep knows.
   *
   * Session-scoped like `openCall`, so `scopeToTurn` passes it through unchanged.
   */
  wakeup: { toolUseId: string; at: string; turnIndex: number | null } | null;
  /**
   * Text something attached to the SESSION rather than to a call — today only the background
   * security review, which runs with no tool call of its own and reports what it found.
   *
   * Carries WHEN and in which turn, because the complete-history surface shows it in order among
   * the calls: a note with no instant could only ever be appended at the end, next to work it has
   * nothing to do with. Session-scoped like `openCall`, so `scopeToTurn` passes it through — the
   * surface filters by `turnIndex` itself.
   */
  notes: { source: string | null; hook: string | null; text: string; at: string; turnIndex: number | null }[];
}

type WindowFor = (model: string | null) => { window: number; estimated: boolean };

/** What the reducer knows about an event that the event itself does not carry. */
export interface EventContext {
  /** Turn the event belongs to — for a subagent event, the turn that spawned it. */
  turnIndex: number | null;
  /**
   * The event's display label for the live feed. For a `tool-start`: `arg` for most tools,
   * but for the Task family the RESOLVED reference (a todo's subject, a subagent's type) —
   * which only the reducer's cross-event state can produce. For a `usage` event (an API call):
   * the INPUT that triggered the call — the prompt for a turn's first call, the preceding
   * tool_result preview for the rest. Null when the event has no label (a non-first-block
   * usage line, most other event types, or a genuinely argument-less tool like `TaskList`).
   */
  label: string | null;
  /**
   * True on the FIRST line of a NEW API call (a `usage` event whose callId the reducer had not
   * folded yet). A call is written one line per content block, all repeating the usage, so the
   * feed pushes one API-call row only when this is set. Undefined for non-usage events.
   */
  newCall?: boolean;
  /**
   * A new call's latency in ms: its response time minus the last activity that fed it (a
   * tool-end, or the prompt). Null when that anchor is unknown (a subagent's first call).
   * Set only alongside `newCall`; undefined for non-usage events.
   */
  callMs?: number | null;
}

interface ToolAcc {
  name: string;
  startTs: string | null;
  endTs: string | null;
  ownerAgentId: string | null;
  arg: string | null;
  ctx: number;
  error: boolean; // the tool_result came back a real failure (refusals excluded)
  backgroundTaskId: string | null; // set by the launch receipt of a background command (Bash only)
  backgroundBy: BackgroundAuthor | null; // who put it there; set by the same receipt
  outcome: string | null; // a background command's fate, in Claude Code's own words
  outcomeStatus: string | null; // the same fate as a status code, so nothing has to parse English
  outcomeTs: string | null; // when the notification landed — with startTs, the command's real duration
  outputFile: string | null; // where the command's output went; only the notification names it
  vanishedTs: string | null; // the probe found nothing holding its output file open (never an outcome)
  lastSeenAliveTs: string | null; // the last probe that DID — the lower bound of how long it ran
  launchPrompt: string | null; // Agent spawn only
  spawnModel: string | null; // Agent spawn only — model fallback (see snapshot)
  returned: SubagentReturned | null; // Agent result only
  taskRef: TaskRef | null; // Task-family tools only — resolved into a label (see toolLabel)
  subagentType: string | null; // Agent spawn only — the type it was launched as
  description: string | null; // an Agent spawn's intent, or a Bash's own name for what it runs
  turnIndex: number | null; // which turn this tool belongs to (null for subagent tools)
  notes: { source: string | null; hook: string | null; text: string }[] | null; // what a hook said about this call
}

interface TurnAcc {
  index: number;
  prompt: string;
  command: string | null;
  startedAt: string | null;
  state: 'done' | 'interrupted' | 'live';
  durationMs: number | null;
  messageCount: number | null;
  apiCalls: number;
  fillEnd: number; // updated on each main-session usage event
  breakdown: { input: number; cacheRead: number; cacheCreation: number };
  cacheTotals: CacheTotals;
  inputTotal: number; // input_tokens SUMMED over the turn (breakdown.input is the last call)
  out: number;
  weighted: number; // main-thread weight of this turn's calls (see TurnNode.weighted)
  skillTurns: Map<string, number>; // same two counters as the session, scoped to this turn
  skillInvokes: Map<string, number>;
  commandCounts: Map<string, number>;
  // What this turn's own calls ran on. Sets, because a turn CAN mix (a /model mid-turn) even
  // though 99.7% of real turns carry exactly one model and 98% carry no effort at all.
  models: Set<string>;
  efforts: Set<string>;
  compaction: boolean;
  firstCall: { cacheCreation: number; fill: number } | null;
  rebuildExpected: boolean;
  result: string | null;
  // live intent panel — the model's latest mid-turn narration (see TurnNode).
  lastNarration: NarrationEntry | null;
  // WHEN the turn last spoke — the later of its final output and its last narration. It cuts the
  // activity group (see ActivityGroup): calls before the turn's last word belong to what it has
  // already accounted for. Kept apart from `result`/`lastNarration` because the group needs the
  // instant, and a `turn-result` carries no narration event to read it from.
  lastWordTs: string | null;
}
/**
 * A subagent as the SESSION launched it — keyed by the spawn's tool_use id, created the
 * moment the `Agent` tool_use is seen. This, not the child file, is what makes a subagent
 * exist: the child jsonl only enriches it (model, usage, output, real duration), and may
 * arrive late or never. Keying the list on the child instead is what let a whole class of
 * launches (a Workflow run's subagents) stay invisible.
 */
/** A Workflow run: its subagents are aggregated into one row, never listed individually. */
interface RunAcc {
  runId: string;
  members: Set<string>; // agentIds whose transcript we tail (their usage folds in as usual)
  started: Set<string>; // from journal.jsonl — the only record of a workflow subagent's life
  finished: Set<string>;
}
interface SpawnAcc {
  toolUseId: string;
  agentId: string | null; // the child's id — from the launch receipt (+0.07s) or the sidecar
  runId: string | null; // set on a Workflow launch: names its transcript dir
  workflowName: string | null;
  // Its tool_result was a launch RECEIPT (`status: "async_launched"`), so that result says
  // nothing about completion. The distinction is the whole fix: for a foreground spawn the
  // result IS the completion, for a background one the completion is a later `agent-end`.
  launchedAsync: boolean;
  ended: boolean; // a terminal signal arrived (never latched — a resume clears it)
  endStatus: string | null; // completed | failed | killed | stopped | null (absent in ~33 real cases)
}
interface AgentAcc {
  agentId: string;
  agentType: string | null;
  model: string | null;
  fill: number;
  toolUseId: string | null;
  outputFull: string | null;
  outLen: number; // from the child's end_turn line (last wins)
  firstMs: number | null;
  lastMs: number | null; // parsed child line timestamps → real duration
  // Cumulative consumption by the four usage-block categories (Σ over the child's calls) — the
  // per-subagent mirror of the main sums. `volume` is their total; the split feeds the drawer.
  volIn: number;
  volOut: number;
  volCacheRead: number;
  volCacheCreation: number;
  // Same total as the four sums above, split by the model of the CALL that produced it — not by
  // `model`, which subagent-meta reports once per agent. Measured on real logs: 2.1% of subagent
  // transcripts (37 of 1741) carry more than one model family, and charging their whole volume to
  // the agent's single model misplaces 1.19% of subagent tokens overall — 7% inside one real
  // 130-subagent session. Keyed by model id; the view groups families.
  volByModel: Map<string, number>;
  /** This subagent's weight (see {@link callWeight}), charged per call to the model that made it —
   * the same reason `volByModel` exists rather than one weight for the agent's declared model. */
  weighted: number;
  appliedVolumeKeys: Set<string>; // per-agent call dedup for the volume sums (see main appliedUsageKeys)
  // Efforts its OWN calls reported. A set, not a value: nothing proves a subagent keeps one
  // effort for its whole life, and the sample that could settle it is a single child file.
  // If it only ever reports one, the view shows one — no assumption is baked in.
  efforts: Set<string>;
  /** What it was launched to do, when the launch is not an `Agent` spawn: a forked skill's own
   * record (`agent-launch`, else its sidecar). Null for an ordinary subagent, whose spawn already
   * carries the description and stays authoritative. */
  description: string | null;
  /** Epoch-free launch timestamp for an agent with no spawn tool to take one from. */
  launchedAt: string | null;
  /** The turn that launched it, same case: a spawn's own tool node answers this for everyone else. */
  turnIndex: number | null;
}

/**
 * Sums subagents' per-model volumes into one list, tokens descending. Shared by `snapshot()`
 * and `scopeToTurn` so a scoped total and a whole-session one can never be built differently.
 * The result sums to Σ`volume` over the same agents — i.e. to `subagentsTotal`.
 */
export function sumTokensByModel(subagents: readonly AgentNode[]): { model: string | null; tokens: number }[] {
  const byModel = new Map<string | null, number>();
  for (const a of subagents)
    for (const v of a.volumeByModel) byModel.set(v.model, (byModel.get(v.model) ?? 0) + v.tokens);
  return [...byModel.entries()]
    .filter(([, tokens]) => tokens > 0)
    .map(([model, tokens]) => ({ model, tokens }))
    .sort((x, y) => y.tokens - x.tokens);
}

/**
 * Resolves a subagent's per-call `volByModel` map into its `volumeByModel` list, tokens
 * descending. `volByModel` keys the empty-model calls under '' (a synthetic / API-error line
 * carries usage but no model); they belong to the agent's own model, resolved via `fallback`.
 * Merges AFTER resolving, so an agent that has both real-model calls and empty-model ones does
 * NOT emit two entries for the same model. Total is unchanged (it only groups differently).
 */
function resolveVolByModel(
  volByModel: Map<string, number>,
  fallback: string | null,
): { model: string | null; tokens: number }[] {
  const merged = new Map<string | null, number>();
  for (const [m, t] of volByModel) {
    const key = m || fallback;
    merged.set(key, (merged.get(key) ?? 0) + t);
  }
  return [...merged.entries()].map(([model, tokens]) => ({ model, tokens })).sort((x, y) => y.tokens - x.tokens);
}

/**
 * Stateful reducer that folds normalized events into a session tree: main fill +
 * breakdown, per-subagent fill/model/state, tool nodes with durations, and
 * compaction nodes. Tool durations are matched by tool_use_id. Subagent
 * running/done is derived from the parent's tool-end for the subagent's spawning
 * toolUseId (learned from a `subagent-meta` event; agentId ≠ toolUseId, so the
 * mapping is required). `mainModel` only SEEDS the main window: the session's real model is
 * whatever its latest call reported, because `/model` moves it mid-session and the window
 * moves with it. The seed covers the gap before the first call — a session opened right
 * after /clear has no assistant line yet, so discovery can only report null.
 */
export function createSessionTree(opts: { windowFor: WindowFor; mainModel?: string | null }) {
  const windowFor = opts.windowFor;
  // The model in force NOW — the denominator of the context window. Seeded from the session
  // head, then owned by the calls.
  let mainModel: string | null = opts.mainModel ?? null;
  // Every model the main session has run on, in first-seen order. A session that switched
  // must be able to say what it WAS: showing only the current one hides that it changed,
  // showing only the first is the bug this replaced.
  const mainModels: string[] = [];
  if (mainModel) mainModels.push(mainModel);
  let mainFill = 0;
  // Token usage SUMMED over the whole session, by the four API usage-block categories.
  // cacheTotals below already sums cache read/write; these add the input/output sums so the
  // Token usage card has all four. Distinct from mainOut, which is the LAST call's output.
  let usageInput = 0,
    usageOutput = 0;
  // Whole-session MAIN-thread weight. Subagent weight is summed from the agents, so
  // the two never double-count: they are the two sides of the reducer's `owner === null` branch.
  let weightedMain = 0;
  // Session weight split by the model of the CALL, main thread AND subagents together — the mix
  // behind one session's single weight figure (the Compare row's bar). Deliberately combined:
  // a row compares SESSIONS, and a subagent's model is part of what that session ran on.
  const weightedByModel = new Map<string, number>();
  // MAIN-thread only, kept apart from the combined split above: "what model did this session run
  // on" is a fact about the main thread, and folding its subagents in would answer something else
  // (a Haiku explorer does not make an Opus session a Haiku one).
  const mainWeightedByModel = new Map<string, number>();
  const breakdown = { input: 0, cacheRead: 0, cacheCreation: 0 };
  const cacheTotals: CacheTotals = { read: 0, created: 0 };
  // Outcomes of background commands whose launching call is not on the ledger yet — Claude Code can
  // write the end before the launch (see `agent-end`). Keyed by tool-use id; drained by the receipt.
  const pendingBgOutcome = new Map<
    string,
    { summary: string | null; status: string | null; ts: string | null; outputFile: string | null }
  >();
  // Background launches by TASK id. A `<task-notification>` names the launching call, but a
  // `TaskStop` names only the task — and for a Monitor that stop is the only end ever written.
  const bgByTaskId = new Map<string, ToolAcc>();
  // What a still-running background task has REPORTED, keyed by its task id — the only link a
  // progress notification carries. Keyed on the task and not parked against a call on purpose: an
  // event can arrive before the launch receipt is written, and a map the snapshot reads at the end
  // is order-free, where parking would need a drain on every path that could close the row.
  const bgEvents = new Map<string, { count: number; last: string }>();
  // The appointment the session has made with itself, or null when it has none. One slot, not a
  // list: a dynamic loop re-arms every turn, and the older instants are not things it is still
  // waiting for.
  let wakeup: { toolUseId: string; at: string } | null = null;
  // Notes whose call is not on the ledger yet. Same reason as `pendingBgOutcome`: the line order
  // is not guaranteed, and a note is the only copy of what the hook said.
  const pendingNotes = new Map<string, { source: string | null; hook: string | null; text: string }[]>();
  // Notes about the SESSION rather than about a call: work that ran with no tool call of its own
  // (the background security review) and reported what it found.
  const sessionNotes: {
    source: string | null;
    hook: string | null;
    text: string;
    at: string;
    turnIndex: number | null;
  }[] = [];
  const regions = new Set<string>();
  const skillTurns = new Map<string, number>(); // skill name → assistant lines it drove
  const skillInvokes = new Map<string, number>(); // skill name → explicit Skill tool calls
  const commandCounts = new Map<string, number>(); // slash command name → times the user typed it
  // Every timeline entry the user sent (prompts AND slash commands) gets an index; how many
  // of them are real work turns is a property of the built list, not of this counter.
  let entries = 0;
  let apiCalls = 0; // main-session assistant lines (usage events)
  // Whether the session has had a call that actually carried a context. Distinct from
  // `apiCalls > 0` on purpose — see where it is consumed.
  let sessionHadRealCall = false;
  // The session's last model call FAILED and nothing has succeeded since — see `TreeSnapshot.error`.
  let sessionError: TreeSnapshot['error'] = null;
  const tools = new Map<string, ToolAcc>(); // key = tool_use id
  // Main-session tool ids with no result yet — the ledger's open head, kept as a set rather
  // than rescanned per snapshot: `tools` holds every call the session ever made (1521 on the
  // largest real one) and the open ones are a handful.
  const openMainCalls = new Set<string>();
  const agents = new Map<string, AgentAcc>(); // key = agentId (child-file id)
  const spawns = new Map<string, SpawnAcc>(); // key = the spawn's tool_use id — the subagent list
  const spawnByAgentId = new Map<string, string>(); // agentId → spawn toolUseId (the late link)
  // The reverse link, held for spawns that do not exist YET. Live, a child writes its
  // meta.json before the parent's assistant line carrying the spawn tool_use reaches
  // disk, so linkSpawn routinely runs with no SpawnAcc to write to; tool-start drains
  // this so the spawn is born already linked. Replay never needs it (parent to EOF first).
  const agentIdByPendingSpawn = new Map<string, string>(); // spawn toolUseId → agentId
  // Todo number → subject, from each TaskCreate's result: the only line that states the
  // number, and what turns a later TaskUpdate's bare "1" into something readable.
  const taskSubjects = new Map<string, string>();
  const runs = new Map<string, RunAcc>(); // key = runId — Workflow runs, aggregated not listed
  const runByAgentId = new Map<string, string>(); // agentId → runId: keeps a run's members off the list
  const endedToolUseIds = new Set<string>(); // toolUseIds whose parent tool-end arrived
  // agentIds a notification ended without naming a spawn we hold → status. A MAP, not a flag on
  // the agent: replay reads the parent file whole before any child, so the end routinely
  // arrives before that agent exists. An id naming no agent is never looked up, which is what
  // makes the background-task and workflow-run notifications inert here.
  const endedAgentIds = new Map<string, string | null>();
  // The activity group (see ActivityGroup) per turn, memoised. Walking the whole tool ledger on
  // every snapshot cost +35% on the replay of the largest real session (1521 calls × 11.6k
  // snapshots), so a turn's group is rebuilt only when something that feeds it moved: one of its
  // own calls started or ended, or the turn spoke. Everything else reuses the last value.
  const toolIdsByTurn = new Map<number, Set<string>>(); // turnIndex → its main-session call ids
  const groupCache = new Map<number, ActivityGroup | null>();
  const dirtyGroups = new Set<number>();
  const compactions: CompactionNode[] = [];
  // Seqs of the APPEND-shaped events already folded, so a reconnect's re-send of the
  // high-water line cannot duplicate them. Everything else in this reducer is set/last-wins
  // and therefore idempotent by construction.
  const compactionSeqs = new Set<number>();
  const appliedLineSeqs = new Set<number>(); // user-turn (opens an entry)
  // `promptId:command` for every command that has already opened a turn. One invocation can be
  // written TWICE — the plain text the user typed and the `<command-name>` expansion, sharing the
  // promptId (15 of 19 real plain-text lines) — and both are real lines, so seq cannot fold them.
  // Keyed by the command NAME too, never by the id alone: a prompt queued while a command ran
  // carries that command's promptId (measured once on a real `/compact`), and deduping on the id
  // would swallow a human turn to save a duplicate one.
  const appliedCommandKeys = new Set<string>();
  const appliedCommandSeqs = new Set<number>(); // command (bumps a counter)
  // A skill attribution is one-per-line, so its turn counter dedups by seq (like a command).
  const appliedSkillTurnSeqs = new Set<number>();
  // A Skill tool_use bumps the invoke counter; keyed by tool_use id (unique, and a line can
  // carry several tool_use blocks that share a seq — so seq would wrongly drop the others).
  const countedSkillInvokeIds = new Set<string>();
  // Main usage (sums cache tokens, out, apiCalls). Keyed by the API CALL, not by the line: one
  // call is written as one line PER CONTENT BLOCK, each repeating the same usage. Falls back to
  // the seq when a line carries no message.id, which also covers the stream's high-water re-send.
  const appliedUsageKeys = new Set<string>();
  // The latest input seen per owner (null = main, agentId = a subagent), so a new API call's
  // feed row can show what triggered it: a user-turn sets it to the prompt, a tool-end to its
  // result preview. LIMIT: a subagent's FIRST call has no preceding tool-end, so it gets no
  // hint (null) — its launch prompt lives in the drawer, not the row.
  const lastInputHint = new Map<string | null, string>();
  // The timestamp (epoch ms) of the last activity before a call, per owner: a user-turn or a
  // tool-end. A new call's latency is its response time minus this — the wait from "the input
  // was ready" to "the model answered". Same owners/spots as lastInputHint.
  const lastActivityMs = new Map<string | null, number>();
  // A compaction rewrites the window on purpose, so the next call re-creates the prompt BY
  // DESIGN. The flag names the gap between two turns' first calls (a compaction can land in
  // either turn — mid-turn, or as the `/compact` entry between them), and the call that reads
  // it clears it.
  let compactionSinceLastFirstCall = false;
  let seq = -1;
  let currentTurn: TurnAcc | null = null;
  const completedTurns: TurnAcc[] = [];
  // One entry per file-history-delta (main session), attributed to the open turn. The push is an
  // append, so — like user-turn/command — it is guarded by seq against the reconnect re-send of
  // the high-water line (stream.ts, `seq <`), which would otherwise double-count a change.
  const fileChanges: FileChangeNode[] = [];
  const appliedFileChangeSeqs = new Set<number>();
  const listeners = new Set<() => void>();
  // per-event (for toasts + the activity feed), distinct from snapshot listeners. The
  // turn a raw event belongs to is knowledge only the reducer has (events carry no turn),
  // so it is handed to the listener alongside the event rather than re-derived downstream.
  const eventListeners = new Set<(e: NormalizedEvent, ctx: EventContext) => void>();

  // Accepts the absent timestamp because callers really do have one (a spawn whose tool is
  // not in the map yet): an unparseable or missing stamp is the same answer, null. The
  // narrower `string` signature only made one call site a type error while behaving
  // correctly at runtime — Date.parse(undefined) is already NaN.
  function tsMs(t: string | null | undefined): number | null {
    const n = Date.parse(t ?? '');
    return Number.isFinite(n) ? n : null;
  }
  function bump(m: Map<string, number>, key: string): void {
    m.set(key, (m.get(key) ?? 0) + 1);
  }

  /**
   * The turn an event belongs to. A subagent's events belong to the turn that SPAWNED it
   * (learned from its spawn tool), not to whatever turn happens to be open when a
   * background subagent's line lands — which is the whole point for an async subagent
   * that outlives its turn. Falls back to the open turn while the spawn link is unknown.
   */
  // LIMIT: a background subagent whose tool events arrive BEFORE its spawn link
  // (agentId → toolUseId, from subagent-meta) is known falls back to the open turn; a feed
  // item's turnIndex is fixed at push time and never corrected, so those early tools can show
  // under the wrong turn's scoped feed. Covered in practice because the meta lands first in
  // both replay and live ticks.
  function turnIndexOf(owner: string | null): number | null {
    if (owner === null) return currentTurn?.index ?? null;
    const a = agents.get(owner);
    const spawnTool = a?.toolUseId ? tools.get(a.toolUseId) : null;
    return spawnTool?.turnIndex ?? currentTurn?.index ?? null;
  }

  /** Tie a child (agentId) to the spawn that launched it. Both ends learn the link. */
  function linkSpawn(toolUseId: string, agentId: string): void {
    spawnByAgentId.set(agentId, toolUseId);
    const sp = spawns.get(toolUseId);
    if (sp) sp.agentId = agentId;
    else agentIdByPendingSpawn.set(toolUseId, agentId); // spawn not born yet — tool-start drains this
  }

  function agentFor(id: string): AgentAcc {
    let a = agents.get(id);
    if (!a) {
      a = {
        agentId: id,
        agentType: null,
        model: null,
        fill: 0,
        toolUseId: null,
        outputFull: null,
        outLen: 0,
        firstMs: null,
        lastMs: null,
        volIn: 0,
        volOut: 0,
        volCacheRead: 0,
        volCacheCreation: 0,
        volByModel: new Map(),
        weighted: 0,
        appliedVolumeKeys: new Set(),
        efforts: new Set(),
        description: null,
        launchedAt: null,
        turnIndex: null,
      };
      agents.set(id, a);
    }
    return a;
  }

  function apply(e: NormalizedEvent): void {
    if (e.seq > seq) seq = e.seq;
    const owner = e.agentId ?? null;
    // Set on the first line of a new API call below; handed to the feed via ctx.newCall.
    let usageNewCall = false;
    let usageCallMs: number | null = null; // that call's latency (input-ready → response)

    // Track a child's min/max line timestamp → real subagent duration. Min/max
    // (not first-seen/last-seen) so an out-of-order line can't corrupt the span.
    // Only file-tailed child events (seq >= 0) carry a position in time; the
    // out-of-band subagent-meta (seq -1, empty timestamp) must not move the window.
    if (owner !== null && e.seq >= 0 && e.timestamp) {
      const ms = tsMs(e.timestamp);
      if (ms !== null) {
        const a = agentFor(owner);
        if (a.firstMs === null || ms < a.firstMs) a.firstMs = ms;
        if (a.lastMs === null || ms > a.lastMs) a.lastMs = ms;
      }
    }

    if (e.type === 'usage') {
      // Failed / recovered is ONE rule for both owners, so it sits above the split — a subagent's
      // failed call fails the session too (see `TreeSnapshot.error`). Set-shaped like `mainFill`,
      // therefore idempotent under a re-sent line, and deliberately outside the `usageNewCall`
      // guard below: that guard exists to keep the SUMS from counting one call once per content
      // block, and last-write-wins state needs no such protection.
      if (e.apiError) {
        sessionError = {
          at: tsMs(e.timestamp),
          status: e.apiError.status,
          message: e.apiError.message,
          agentId: owner,
        };
      } else if (e.model) sessionError = null;
      if (owner === null) {
        // Last-call state: set-shaped, therefore idempotent — a re-sent line rewrites the same
        // values. `breakdown` is the window's composition RIGHT NOW, so the last call is exactly
        // what it must hold; do not turn it into a sum (see CacheTotals).
        mainFill = e.fill;
        breakdown.input = e.delta.input;
        breakdown.cacheRead = e.delta.cacheRead;
        breakdown.cacheCreation = e.delta.cacheCreation;
        // The model is last-call state like the fill above, and for the same reason: it is
        // what the window is measured against RIGHT NOW. Idempotent — a re-sent line rewrites
        // the same value and `mainModels` refuses the duplicate.
        if (e.model) {
          mainModel = e.model;
          if (!mainModels.includes(e.model)) mainModels.push(e.model);
        }
        if (currentTurn) {
          currentTurn.fillEnd = e.fill;
          currentTurn.breakdown = {
            input: e.delta.input,
            cacheRead: e.delta.cacheRead,
            cacheCreation: e.delta.cacheCreation,
          };
          if (e.model) currentTurn.models.add(e.model);
          if (e.effort) currentTurn.efforts.add(e.effort);
        }
        // Everything SUMMED below is NOT idempotent, and the same usage arrives more than once
        // for two independent reasons: a call is written one line per content block (all
        // repeating its usage), and the stream re-sends the high-water line after a reconnect
        // (stream.ts guards with `seq <`). Keying on the call id folds both away; the seq
        // fallback keeps synthetic lines (no message.id) counted once each.
        const key = e.callId ?? `seq:${e.seq}`;
        usageNewCall = !appliedUsageKeys.has(key);
        if (usageNewCall) {
          appliedUsageKeys.add(key);
          apiCalls++;
          // The re-entry cost of a turn lives on its first call — what it had to re-create
          // before doing anything. A call with neither context nor rebuild says nothing about
          // re-entry (an api-error `<synthetic>` line carries an all-zero usage block, and 16
          // real turns open on one), so it must not be taken as the first call and hide the
          // real one behind it.
          if (currentTurn && currentTurn.firstCall === null && (e.delta.cacheCreation > 0 || e.fill > 0)) {
            currentTurn.firstCall = { cacheCreation: e.delta.cacheCreation, fill: e.fill };
            // `sessionHadRealCall`, NOT `apiCalls === 0`: an all-zero line bumps `apiCalls`
            // (it IS an API call, and the session's call count must include it) but must not
            // consume the session's first-call slot. It did: one api-error line before the very
            // first real call flipped `rebuildExpected` to false and charged the boot — 175k in
            // the reproduction — to the user as a cold resume.
            currentTurn.rebuildExpected = !sessionHadRealCall || compactionSinceLastFirstCall;
            sessionHadRealCall = true;
            compactionSinceLastFirstCall = false;
          }
          usageInput += e.delta.input;
          usageOutput += e.delta.output;
          cacheTotals.read += e.delta.cacheRead;
          cacheTotals.created += e.delta.cacheCreation;
          // Charged to the model of THIS call, inside the same per-call guard as the sums above:
          // a weight applied per usage LINE would multiply by the call's content-block count.
          const w = callWeight(e.model, e.delta);
          weightedMain += w;
          if (w > 0 && e.model) {
            weightedByModel.set(e.model, (weightedByModel.get(e.model) ?? 0) + w);
            mainWeightedByModel.set(e.model, (mainWeightedByModel.get(e.model) ?? 0) + w);
          }
          if (currentTurn) {
            currentTurn.inputTotal += e.delta.input;
            currentTurn.out += e.delta.output;
            currentTurn.apiCalls++;
            currentTurn.cacheTotals.read += e.delta.cacheRead;
            currentTurn.cacheTotals.created += e.delta.cacheCreation;
            currentTurn.weighted += w;
          }
        }
      } else {
        // A subagent's own usage. `fill` is its LAST call's context (feeds the context bar);
        // `volume` is the cumulative consumption — the subagent-side mirror of the main sums
        // above, so the two are comparable. Same per-call dedup as the main branch: one call is
        // written one line per content block, and the stream re-sends the high-water on reconnect.
        const a = agentFor(owner);
        a.fill = e.fill;
        if (e.effort) a.efforts.add(e.effort);
        const key = e.callId ?? `seq:${e.seq}`;
        usageNewCall = !a.appliedVolumeKeys.has(key);
        if (usageNewCall) {
          a.appliedVolumeKeys.add(key);
          a.volIn += e.delta.input;
          a.volOut += e.delta.output;
          a.volCacheRead += e.delta.cacheRead;
          a.volCacheCreation += e.delta.cacheCreation;
          // Charge the call to the model that MADE it. `e.model` is absent only on a line that
          // reported usage without naming a model; those tokens are resolved to the agent's own
          // model in snapshot() rather than dropped, so the split always totals `volume`.
          const mk = e.model ?? '';
          a.volByModel.set(
            mk,
            (a.volByModel.get(mk) ?? 0) + e.delta.input + e.delta.output + e.delta.cacheRead + e.delta.cacheCreation,
          );
          // Weight uses `e.model` only — never the agent's declared model. A call whose line named
          // no model contributes 0 rather than an invented weight, which is why the agent's weight
          // can be lower than its volume implies; the volume split resolves those, a weight cannot.
          const aw = callWeight(e.model, e.delta);
          a.weighted += aw;
          if (aw > 0 && e.model) weightedByModel.set(e.model, (weightedByModel.get(e.model) ?? 0) + aw);
        }
      }
      // On the first line of a new call, its latency = this response's time minus the last
      // activity that fed it (a tool-end or the prompt). Null when that anchor is unknown (a
      // subagent's very first call has no preceding tool-end in its own stream).
      if (usageNewCall) {
        const anchor = lastActivityMs.get(owner);
        const now = tsMs(e.timestamp);
        // now < anchor (clock skew / out-of-order lines) is not a real latency — report null
        // rather than a negative duration on the row.
        usageCallMs = anchor != null && now != null && now >= anchor ? now - anchor : null;
      }
    } else if (e.type === 'user-turn') {
      // Opening a turn is an APPEND, so it is not idempotent — and the stream layer
      // deliberately lets the line sitting exactly at its seq high-water through again after
      // a reconnect (see stream.ts: the guard is `seq <` because one line emits several
      // events). Re-applying it would fork a duplicate entry with the same prompt and steer
      // the real turn's usage onto it. Keyed by seq, like compaction — the one other append.
      const twinKey = e.command && e.promptId ? e.promptId + ':' + e.command : null;
      if (owner === null && !appliedLineSeqs.has(e.seq) && !(twinKey && appliedCommandKeys.has(twinKey))) {
        appliedLineSeqs.add(e.seq);
        if (twinKey) appliedCommandKeys.add(twinKey);
        entries++;
        if (currentTurn) {
          // A new prompt supersedes the previous turn. Normally a `turn_duration` already closed
          // it; if it did NOT — the turn was cut off / auto-continued, leaving no end marker and
          // no Esc `interruptedMessageId` (Claude Code writes a synthetic "No response requested."
          // line instead) — it would stay `live` forever and be mis-picked as the current turn
          // (a frozen intent panel). A superseded turn that did real work WAS interrupted; one
          // that made no call (e.g. `/model`) is left for the 0-call → done presentation rule.
          if (currentTurn.state === 'live' && currentTurn.apiCalls > 0) currentTurn.state = 'interrupted';
          completedTurns.push(currentTurn);
        }
        currentTurn = {
          index: entries,
          prompt: e.prompt ?? '',
          command: e.command ?? null,
          startedAt: e.timestamp || null,
          state: 'live',
          durationMs: null,
          messageCount: null,
          apiCalls: 0,
          fillEnd: mainFill,
          breakdown: { ...breakdown },
          cacheTotals: { read: 0, created: 0 },
          inputTotal: 0,
          out: 0,
          weighted: 0,
          skillTurns: new Map(),
          skillInvokes: new Map(),
          commandCounts: new Map(),
          models: new Set(),
          efforts: new Set(),
          compaction: false,
          firstCall: null,
          rebuildExpected: false,
          result: null,
          lastNarration: null,
          lastWordTs: null,
        };
        // The prompt is the input that feeds this turn's first API call (bounded, like the
        // tool-result hint below — the feed row slices it further); its time anchors that
        // call's latency.
        lastInputHint.set(null, (e.prompt ?? '').slice(0, 200));
        const pt = tsMs(e.timestamp);
        if (pt !== null) lastActivityMs.set(null, pt);
      }
    } else if (e.type === 'turn-end') {
      if (owner === null && currentTurn) {
        currentTurn.durationMs = e.durationMs;
        currentTurn.messageCount = e.messageCount;
        currentTurn.state = 'done';
      }
    } else if (e.type === 'turn-interrupted') {
      if (owner === null && currentTurn) currentTurn.state = 'interrupted';
    } else if (e.type === 'turn-result') {
      if (owner === null && currentTurn) {
        currentTurn.result = e.outputFull; // last wins
        currentTurn.lastWordTs = e.timestamp;
        dirtyGroups.add(currentTurn.index); // the cutoff moved: the group starts over
      }
    } else if (e.type === 'turn-narration') {
      // V1 shows only the CURRENT intent, so the latest narration wins — no history is kept.
      if (owner === null && currentTurn) {
        currentTurn.lastNarration = { ts: e.timestamp, text: e.text };
        currentTurn.lastWordTs = e.timestamp;
        dirtyGroups.add(currentTurn.index); // the cutoff moved: the group starts over
      }
    } else if (e.type === 'command') {
      // Counting is an append too: same re-application hazard as `user-turn` above. A command
      // shares its line (and seq) with the turn it opens, so a separate set is needed.
      if (owner === null && !appliedCommandSeqs.has(e.seq)) {
        appliedCommandSeqs.add(e.seq);
        bump(commandCounts, e.name);
        if (currentTurn) bump(currentTurn.commandCounts, e.name);
      }
    } else if (e.type === 'file-change') {
      // CC's file-history ledger, attributed to the open turn (deltas are written interleaved
      // with the turn that caused them — verified positionally). Main session only; a subagent's
      // edits, if ever tracked in a child file, are out of scope for now.
      if (owner === null && !appliedFileChangeSeqs.has(e.seq)) {
        appliedFileChangeSeqs.add(e.seq);
        fileChanges.push({ path: e.path, turnIndex: currentTurn?.index ?? null, ts: e.timestamp });
      }
    } else if (e.type === 'attribution') {
      // Only the MAIN session's skills count as turns (a subagent's skills are its own).
      if (owner === null) {
        regions.add(e.name);
        // Counting a skill's turns is an append, so — like `command`/`user-turn` — it must be
        // guarded against the reconnect re-send of the high-water line (stream.ts, `seq <`).
        if (e.kind === 'skill' && !appliedSkillTurnSeqs.has(e.seq)) {
          appliedSkillTurnSeqs.add(e.seq);
          bump(skillTurns, e.name);
          if (currentTurn) bump(currentTurn.skillTurns, e.name);
        }
      }
    } else if (e.type === 'subagent-meta') {
      // Non-destructive merge: a subagent can get two meta events (sidecar link,
      // then model from its jsonl), each carrying only its own fields — never let a
      // later null clobber a value an earlier event already set.
      if (e.agentId) {
        const a = agentFor(e.agentId);
        if (e.toolUseId) {
          a.toolUseId = e.toolUseId;
          linkSpawn(e.toolUseId, e.agentId);
        }
        if (e.model) a.model = e.model;
        if (e.agentType) a.agentType = e.agentType;
        if (e.description) a.description = e.description;
      }
    } else if (e.type === 'agent-launch') {
      // A forked skill's only launch record. It gives the agent what a spawn would have given it:
      // the instant it started, the turn that asked for it, and a name a human recognises.
      const a = agentFor(e.launchedAgentId);
      a.launchedAt = e.timestamp || null;
      if (e.description) a.description = e.description;
      if (owner === null && currentTurn) a.turnIndex = currentTurn.index;
    } else if (e.type === 'subagent-output') {
      // The child's end_turn text = its returned output. Last one wins (a child can
      // emit several end_turn lines over its life; the final is the real answer).
      if (e.agentId) {
        const a = agentFor(e.agentId);
        a.outputFull = e.outputFull;
        a.outLen = e.outLen;
      }
    } else if (e.type === 'tool-start') {
      tools.set(e.id, {
        name: e.name,
        startTs: e.timestamp,
        endTs: null,
        ownerAgentId: owner,
        arg: e.arg ?? null,
        ctx: 0,
        error: false,
        backgroundTaskId: null,
        backgroundBy: null,
        outcome: null,
        outcomeStatus: null,
        outcomeTs: null,
        outputFile: null,
        vanishedTs: null,
        lastSeenAliveTs: null,
        launchPrompt: e.launchPrompt ?? null,
        spawnModel: e.spawnModel ?? null,
        returned: null,
        taskRef: e.taskRef ?? null,
        subagentType: e.subagentType ?? null,
        description: e.description ?? null,
        turnIndex: owner === null ? (currentTurn?.index ?? null) : null,
        // Kept if a note arrived FIRST: a hook writes its line right after the tool_result, but
        // the tailer promises no order, and dropping it here would lose the only copy there is.
        notes: pendingNotes.get(e.id) ?? null,
      });
      pendingNotes.delete(e.id);
      // A re-sent line re-adds the same id, so this cannot drift; a start arriving after its
      // own end (never observed, but the tailer promises no order) is corrected below.
      if (owner === null) {
        if (endedToolUseIds.has(e.id)) openMainCalls.delete(e.id);
        else openMainCalls.add(e.id);
      }
      if (owner === null && currentTurn) {
        const ids = toolIdsByTurn.get(currentTurn.index) ?? new Set<string>();
        ids.add(e.id); // a re-sent line re-adds the same id, so no drift
        toolIdsByTurn.set(currentTurn.index, ids);
        dirtyGroups.add(currentTurn.index);
      }
      // The launch IS the subagent's birth: it goes on the list here, before any child file
      // exists. Only a main-session spawn — a nested one is the child's own business.
      if (owner === null && (SPAWN_TOOL_NAMES.has(e.name) || e.name === 'Workflow') && !spawns.has(e.id)) {
        // Its child may already have introduced itself (live ordering) — adopt that link,
        // or the spawn becomes a second, permanently unlinked row for a subagent
        // already on the list.
        spawns.set(e.id, {
          toolUseId: e.id,
          agentId: agentIdByPendingSpawn.get(e.id) ?? null,
          runId: null,
          workflowName: null,
          launchedAsync: false,
          ended: false,
          endStatus: null,
        });
        agentIdByPendingSpawn.delete(e.id);
      }
      // A resume: SendMessage puts an already-stopped agent back to work (its `to` is the
      // agentId — verified on every real SendMessage line). Without this, the notification
      // that fired when it first stopped would keep it `done` while it works again.
      if (owner === null && e.name === 'SendMessage' && e.arg) {
        const sp = spawns.get(spawnByAgentId.get(e.arg) ?? '');
        if (sp) {
          sp.ended = false;
          sp.endStatus = null;
        }
      }
      // an explicit main-session Skill call: arg holds the skill name (from argOf). Counting the
      // invoke is an append; dedup by the tool_use id so the reconnect re-send folds once and a
      // multi-tool line never drops a distinct Skill call.
      if (owner === null && e.name === 'Skill' && e.arg && !countedSkillInvokeIds.has(e.id)) {
        countedSkillInvokeIds.add(e.id);
        bump(skillInvokes, e.arg);
        if (currentTurn) bump(currentTurn.skillInvokes, e.arg);
      }
    } else if (e.type === 'tool-end') {
      const t = tools.get(e.toolUseId);
      if (t) {
        // a call closing changes its turn's group: it stops being one of the OPEN ones
        if (t.turnIndex != null) dirtyGroups.add(t.turnIndex);
        t.endTs = e.timestamp;
        if (e.outputSize !== undefined) t.ctx = e.outputSize;
        if (e.error) t.error = true;
        if (e.returned) t.returned = e.returned;
        // A background command's receipt closes the row on time (the launch IS what this call
        // did) but not on outcome — remember the id so the later notification finds it.
        // Whatever this call was, its parked outcome (if any) is settled here: applied when the
        // call turns out to be a background launch, dropped otherwise. Draining unconditionally is
        // what keeps the map from growing for the life of the session — a notification naming a
        // subagent's spawn parks too, and nothing else would ever come for it.
        const parked = pendingBgOutcome.get(e.toolUseId);
        if (parked) pendingBgOutcome.delete(e.toolUseId);
        if (e.background) {
          t.backgroundTaskId = e.background.taskId;
          t.backgroundBy = e.background.by;
          // The task id is the only name a `TaskStop` gives what it stopped, so the launch has to
          // be findable by it — see the `agent-end` branch.
          bgByTaskId.set(e.background.taskId, t);
          if (parked) {
            t.outcome = parked.summary;
            t.outcomeStatus = parked.status;
            t.outcomeTs = parked.ts;
            t.outputFile = parked.outputFile;
            t.error = parked.status !== null && parked.status !== 'completed' && parked.status !== 'stopped';
          }
        }
      }
      // This result is the input the NEXT API call (in the same owner) will be fed — remember it
      // for that call's feed row, and its time anchors that call's latency. Newest wins, so a
      // parallel batch shows its last result and measures from the last tool to finish.
      if (e.outputPreview) lastInputHint.set(owner, e.outputPreview);
      const teMs = tsMs(e.timestamp);
      if (teMs !== null) lastActivityMs.set(owner, teMs);
      if (e.taskCreated) taskSubjects.set(e.taskCreated.id, e.taskCreated.subject);
      endedToolUseIds.add(e.toolUseId);
      openMainCalls.delete(e.toolUseId);
      const sp = spawns.get(e.toolUseId);
      if (sp) {
        if (e.launched) {
          // A launch receipt: the subagent has just STARTED. Reading this as completion is
          // the bug — it lands ~0.07s after the spawn while the work runs for minutes.
          sp.launchedAsync = true;
          if (e.launched.agentId) {
            linkSpawn(e.toolUseId, e.launched.agentId);
            // Seed the subagent's first API call with the launch prompt and a latency anchor
            // so the feed shows something useful instead of — for both content and duration.
            // The guard prevents clobbering if a child file event arrived first (live ordering).
            const aid = e.launched.agentId;
            if (!lastInputHint.has(aid) && t?.launchPrompt) lastInputHint.set(aid, t.launchPrompt.slice(0, 200));
            const spawnMs = tsMs(t?.startTs ?? null);
            if (!lastActivityMs.has(aid) && spawnMs !== null) lastActivityMs.set(aid, spawnMs);
          }
          if (e.workflow?.runId) {
            sp.runId = e.workflow.runId;
            sp.workflowName = e.workflow.name;
          }
        } else {
          // A foreground result: it only arrives once the subagent is finished, so it IS the
          // completion. Unchanged from before — this is what keeps every foreground subagent
          // behaving exactly as it did (they never get an `agent-end`; measured 0 of 864).
          sp.ended = true;
          sp.endStatus = e.returned?.status ?? null;
        }
      }
    } else if (e.type === 'workflow-agent') {
      let r = runs.get(e.runId);
      if (!r) {
        r = { runId: e.runId, members: new Set(), started: new Set(), finished: new Set() };
        runs.set(e.runId, r);
      }
      if (e.agentId) {
        runByAgentId.set(e.agentId, e.runId);
        r.members.add(e.agentId);
        if (e.phase === 'started') r.started.add(e.agentId);
        if (e.phase === 'result') r.finished.add(e.agentId);
      }
    } else if (e.type === 'agent-end') {
      // The real end of a background subagent. Last-wins, never a latch: a resumed agent is
      // stopped and restarted several times, and each stop writes one of these.
      // The id is NOT always the spawn's: when the agent was resumed, Claude Code keys the
      // notification on the SendMessage call instead (26 of 655 real notifications), which
      // names no spawn — so the agent would never stop again. `task-id` is the child's
      // agentId in BOTH shapes, and it is the same link the resume path above already
      // trusts. Fallback, not replacement: the direct hit stays the primary route, and the
      // notifications that name no subagent at all (background Bash/Monitor tasks, a
      // Workflow run, a nested spawn) still resolve to nothing, exactly as before.
      const sp =
        (e.toolUseId ? spawns.get(e.toolUseId) : undefined) ??
        (e.taskId ? spawns.get(spawnByAgentId.get(e.taskId) ?? '') : undefined);
      // No spawn to hang it on — a forked skill has none by construction — so the end is
      // recorded against the agent the notification names. Only then: a spawn that resolves
      // stays the primary route, unchanged.
      if (!sp && e.taskId) endedAgentIds.set(e.taskId, e.status);
      // ...or the notification is not about an agent at all: it is the outcome of a background
      // COMMAND, and the tool it names ran it. The gate is the receipt's `backgroundTaskId`,
      // never the id's shape: `Monitor` gets a `b`-prefixed notification too, and a resumed
      // subagent's notification names the SendMessage call — marking either row failed would
      // state something about a tool that launched nothing.
      // ...and the notification may name the TASK instead of the call: a `TaskStop` says which task
      // it stopped and nothing about the call that launched it, and for a Monitor that sentence is
      // the only end that will ever be written (no `<task-notification>`, and no file held open for
      // the liveness probe to ask about). The launch's own id stays the primary route.
      const bg = sp
        ? undefined
        : ((e.toolUseId ? tools.get(e.toolUseId) : undefined) ?? bgByTaskId.get(e.taskId ?? ''));
      // The end can be written BEFORE the launch: Claude Code appends an assistant line when its
      // block CLOSES, so a command that finishes in seconds reports back while the `tool_use` that
      // started it is still unwritten (verified on a real session: notification at line 1853, its
      // launch at 1857). Read in file order the outcome had nothing to attach to, and the command
      // showed as running for the rest of the session. Parked, it is applied by the receipt.
      if (!sp && e.toolUseId && !bg?.backgroundTaskId) {
        pendingBgOutcome.set(e.toolUseId, {
          summary: e.summary,
          status: e.status,
          ts: e.timestamp || null,
          outputFile: e.outputFile ?? null,
        });
      }
      // A notification ENDS a command only when it carries a `<status>`. The same line type is
      // also written for PROGRESS (`event` + `summary`, no status), and treating one as the end
      // would mark a command `done` minutes early, drop it out of everything that asks what is
      // still running, and compute its duration to the wrong instant. Measured 2026-08-08 over the
      // local corpus: 54 progress notifications, and NONE of them carries a `<tool-use-id>`, so
      // none can reach a background launch today — this is the guard that keeps a schema change
      // from making it possible without anyone noticing.
      if (bg?.backgroundTaskId && e.status !== null) {
        // Verbatim, per the product decision: seedeep reports what Claude Code reported. When CC
        // calls a deliberate `pkill` a failure (exit 144 — 28 of 29 real failures), the two
        // surfaces agree rather than seedeep inventing a semantics the logs do not carry.
        bg.outcome = e.summary;
        bg.outcomeStatus = e.status;
        // FIRST terminal notification only, and this is a duration bug, not a preference. Claude
        // Code writes the same notification TWICE (`enqueue`, then `remove` when the queue drains)
        // and last-wins was taking the DRAIN's timestamp as the moment the command ended. Measured
        // 2026-08-08 over every local transcript: 281 of 611 notifications are written more than
        // once, and the spread between first and last is p50 3.9 s, p90 30.9 s, max 76 MINUTES —
        // a `sleep 3` was shown as having run 22.6 s. The end instant is the first time anything
        // said so; the status and the sentence stay last-wins, where a repeat is genuinely inert.
        if (bg.outcomeTs === null) bg.outcomeTs = e.timestamp || null;
        if (e.outputFile) bg.outputFile = e.outputFile;
        // Last-wins, never a latch: `remove` repeats `enqueue`'s payload, and a status can only
        // be superseded by a later one about the same command.
        bg.error = e.status !== null && e.status !== 'completed' && e.status !== 'stopped';
      }
      if (sp) {
        sp.ended = true;
        sp.endStatus = e.status;
        // For a subagent the notification's task-id IS its agentId. For a WORKFLOW it is the
        // run's task id (`wwiusew0x`), which names no child file — linking it would put a
        // meaningless id where the row's identity goes.
        // Link the SPAWN's id, not the event's: on the resumed shape they differ, and linking
        // the SendMessage's would repoint the child at a tool call that spawned nothing.
        if (e.taskId && sp.runId === null) linkSpawn(sp.toolUseId, e.taskId);
      }
    } else if (e.type === 'note') {
      // Appended, never replaced: two writers can speak about the same call, and the second is not
      // a correction of the first. Deduped on the text, because a re-read line must not double it.
      const note = { source: e.source, hook: e.hook, text: e.text };
      // No call named: it is about the SESSION (a background review reporting what it found), and
      // there is nothing to anchor it to — inventing an owner would put it on whichever call
      // happened to be open.
      if (e.toolUseId === null) {
        if (!sessionNotes.some((n) => n.text === note.text)) {
          sessionNotes.push({ ...note, at: e.timestamp, turnIndex: currentTurn?.index ?? null });
        }
      } else {
        const t = tools.get(e.toolUseId);
        const list = t ? (t.notes ??= []) : (pendingNotes.get(e.toolUseId) ?? []);
        if (!list.some((n) => n.text === note.text)) list.push(note);
        if (!t) pendingNotes.set(e.toolUseId, list);
      }
    } else if (e.type === 'wakeup') {
      // `at: null` is the stop receipt — the loop was called off, so there is nothing to wait for.
      // Anything else replaces what was there: the newest arming is the appointment.
      wakeup = e.at === null ? null : { toolUseId: e.toolUseId, at: new Date(e.at).toISOString() };
    } else if (e.type === 'background-event') {
      // Progress, not an end: the task keeps running and the row keeps saying so. Counted and
      // kept as "the latest", which is the whole of what a row can show for a stream that may
      // forward hundreds of lines — the feed deliberately gets none of them (a monitor watching a
      // build wrote 74 events in one session, and 13 feed rows would have held nothing else).
      const seen = bgEvents.get(e.taskId);
      bgEvents.set(e.taskId, { count: (seen?.count ?? 0) + 1, last: e.event });
    } else if (e.type === 'command-vanished') {
      const bg = tools.get(e.toolUseId);
      // Three guards, and each one is the difference between a fact and a guess. It must be a
      // BACKGROUND launch (nothing else has an output file to be held open); it must still have
      // NO outcome, so a probe can never contradict or pre-empt what Claude Code itself said —
      // the notification is the authority and it can still arrive after this; and the mark is
      // idempotent, because an out-of-band event carries no position and may be re-delivered.
      if (bg?.backgroundTaskId && bg.outcomeStatus === null) {
        bg.vanishedTs = e.timestamp;
        bg.lastSeenAliveTs = e.lastSeenAlive;
      }
    } else if (e.type === 'compaction') {
      // Keyed by seq so a line re-processed after a reconnect does not duplicate the
      // node (compaction is the one append; the rest of the state is set/Set-based).
      if (!compactionSeqs.has(e.seq)) {
        compactionSeqs.add(e.seq);
        const delta = e.preTokens !== null && e.postTokens !== null ? e.preTokens - e.postTokens : null;
        compactions.push({ pre: e.preTokens, post: e.postTokens, delta, ms: e.durationMs });
        if (owner === null) {
          // isSummary is the user line that restores context; the boundary line has the
          // real token counts. Guard the bump so one compaction = one chip count.
          if (!e.isSummary) {
            bump(commandCounts, 'compact');
            if (currentTurn) bump(currentTurn.commandCounts, 'compact');
          }
          if (currentTurn) currentTurn.compaction = true;
          compactionSinceLastFirstCall = true;
        }
      }
    }

    // Per-event listeners (toasts, feed) fire for every event, cheaply — no snapshot.
    if (eventListeners.size > 0) {
      // The label is resolved HERE, not by the listener: by now the referent is in state (a
      // TaskCreate result precedes the TaskUpdate that names it; a spawn precedes its
      // TaskOutput), and the listener has no access to the maps that hold it.
      const ctx: EventContext = {
        turnIndex: turnIndexOf(owner),
        label:
          e.type === 'tool-start'
            ? toolLabel({ arg: e.arg ?? null, taskRef: e.taskRef ?? null })
            : e.type === 'usage'
              ? (lastInputHint.get(owner) ?? null)
              : null,
        newCall: e.type === 'usage' ? usageNewCall : undefined,
        callMs: e.type === 'usage' ? usageCallMs : undefined,
      };
      for (const cb of eventListeners) cb(e, ctx);
    }

    // Signal the change; do NOT build the snapshot. The view is subscribed for the whole
    // initial replay (it mounts before it), and it coalesces its paints — so a snapshot
    // built per event is thrown away by the very listener it was built for. Building it
    // here made the reducer O(n²) in the session's length (buildTurnList is O(turns ×
    // agents)): 23k events of a real large session cost 14s, against 5ms once pulled.
    // Every listener calls snapshot() itself, when it is actually about to paint.
    for (const cb of listeners) cb();
  }

  /**
   * A tool's display label: `arg` for most tools, the RESOLVED reference for the Task family.
   * The single source for both the snapshot and the live feed — two implementations would let
   * the same call read one way in the feed and another in the drawer.
   *
   * Resolution is by REFERENCE, not by string: `TaskUpdate`'s "1" is a todo row (named by the
   * TaskCreate result), `TaskOutput`/`TaskStop`'s hex is a subagent's agentId (named by the
   * spawn that launched it). Both degrade to something still readable when the referent is
   * unknown — a session opened mid-flight never saw the TaskCreate that named row #4.
   */
  function toolLabel(t: { arg: string | null; taskRef: TaskRef | null }): string | null {
    const ref = t.taskRef;
    if (!ref) return t.arg;
    if (ref.kind === 'todo') {
      const subject = taskSubjects.get(ref.id);
      const head = subject ? `#${ref.id} ${subject}` : `#${ref.id}`;
      return ref.status ? `${head} → ${ref.status}` : head;
    }
    return agentLabel(ref.id) ?? `${ref.id.slice(0, 8)}…`;
  }

  /**
   * What to call the subagent with this agentId: the type from its own transcript, else the
   * type its spawn was launched with (the only source for a background subagent, which writes
   * no child jsonl). Null when nothing names it.
   */
  function agentLabel(agentId: string): string | null {
    const own = agents.get(agentId)?.agentType;
    if (own) return own;
    const spawnId = spawnByAgentId.get(agentId);
    return (spawnId ? tools.get(spawnId)?.subagentType : null) ?? null;
  }

  /**
   * The row's headline: what this subagent was launched to DO, best source first —
   * the spawn's `description`, else the prompt's first line, else the type, else the id.
   * The intent comes from the SPAWN, so it is known immediately; the type arrives later
   * with the child's sidecar. Measured on 690 real spawns: description 99.4%, type 77.7%.
   */
  function agentTitle(spawn: ToolAcc | null, a: AgentAcc | null, agentId: string): string {
    const first = spawn?.launchPrompt ? spawn.launchPrompt.split('\n', 1)[0]!.trim() : '';
    // `a.description` sits right behind the spawn's: it is the same fact from the agent's own side
    // (its launch line or its sidecar), and it is the ONLY one a forked skill has — without it
    // `/code-review del diff` reads as `general-purpose`, which names no launch at all.
    return (
      spawn?.description ||
      a?.description ||
      (first.length > 0 ? first : null) ||
      a?.agentType ||
      spawn?.subagentType ||
      agentId
    );
  }

  function toolNode(id: string, t: ToolAcc): ToolNode {
    const a = t.startTs ? tsMs(t.startTs) : null;
    const b = t.endTs ? tsMs(t.endTs) : null;
    const node: ToolNode = {
      id,
      name: t.name,
      ms: a !== null && b !== null ? b - a : null,
      arg: toolLabel(t),
      ctx: t.ctx,
      turnIndex: t.turnIndex,
    };
    if (t.error) node.error = true;
    if (t.outcome) node.outcome = t.outcome;
    // Outside the background branch below: any call can be spoken about, and the ones that are
    // are Write and Edit, which never launch anything.
    if (t.notes?.length) node.notes = t.notes.map((n) => ({ ...n }));
    // Only a background launch carries these two, and only because something downstream must be
    // able to ask "is it still running, and since when" (`runningBackground`). The call itself
    // closed in milliseconds — the receipt is not the command — so `ms` cannot answer either.
    if (t.backgroundTaskId) {
      node.background = true;
      node.backgroundTaskId = t.backgroundTaskId;
      node.backgroundBy = t.backgroundBy ?? 'agent';
      if (t.startTs) node.startedTs = t.startTs;
      // Only a background launch carries the rest: they exist to answer "what became of it, how
      // long did it really take, and where is what it printed" — questions no other tool has.
      if (t.outcomeStatus !== null) node.outcomeStatus = t.outcomeStatus;
      if (t.outcomeTs) node.outcomeTs = t.outcomeTs;
      if (t.outputFile) node.outputFile = t.outputFile;
      if (t.description) node.description = t.description;
      if (t.vanishedTs) node.vanishedTs = t.vanishedTs;
      if (t.lastSeenAliveTs) node.lastSeenAliveTs = t.lastSeenAliveTs;
      // What the task has reported so far. Read from the task-id map rather than accumulated on
      // the row, so an event that arrived before the receipt still counts.
      const ev = bgEvents.get(t.backgroundTaskId);
      if (ev) {
        node.events = ev.count;
        node.lastEvent = ev.last;
      }
    }
    return node;
  }

  // Skill/command nodes are built the same way for the session and for a single turn —
  // only the counter maps differ — so the shape and ordering can never drift between the
  // whole-session view and the turn-scoped one.
  function skillNodes(turnsMap: Map<string, number>, invokesMap: Map<string, number>): SkillNode[] {
    return (
      [...new Set([...turnsMap.keys(), ...invokesMap.keys()])]
        .map((name) => ({ name, turns: turnsMap.get(name) ?? 0, invokes: invokesMap.get(name) ?? 0 }))
        // sort by explicit invocations (the widget's primary number), then by turns
        .sort((a, b) => b.invokes - a.invokes || b.turns - a.turns || a.name.localeCompare(b.name))
    );
  }
  function commandNodes(counts: Map<string, number>): CommandNode[] {
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  /** What an entry turned out to be, from what it cost (see {@link TurnKind}). `delegated` is
   * whether the turn ever LAUNCHED an agent — the fact, not the transient "one is running now":
   * a `/code-review` interrupted halfway still ran the model, just not on this thread. */
  function kindOf(t: TurnAcc, delegated: boolean): TurnKind {
    if (t.command && CONTEXT_COMMANDS.has(t.command)) return 'context';
    // Only a COMMAND can be local: a typed prompt that has not burnt a token yet is a work
    // turn that just started, not a local built-in. And the rule holds for the open entry
    // too — exempting it would leave a session that ENDS on /model showing it as a work
    // turn forever, which is the longer-lived lie of the two.
    // Cost through an AGENT is cost: a forked skill makes no call on this thread, so on
    // `apiCalls` alone `/code-review` was filed beside `/model` — uncounted in `turns`, unjudged
    // by the verdict, collapsed to an idle line in the Trace. A /model launches nothing.
    if (t.command && t.apiCalls === 0 && !delegated && t.state !== 'interrupted') return 'local';
    return 'work';
  }

  function buildTurnList(subagents: readonly AgentNode[]): TurnNode[] {
    const all = [...completedTurns, ...(currentTurn ? [currentTurn] : [])];
    // Group the agents by their spawning turn ONCE. Doing it per turn made this O(turns ×
    // agents), and snapshot() runs on every event: a 150-turn session with dozens of
    // subagents paid that on each of ~10k replayed lines.
    const agentsByTurn = new Map<number, string[]>();
    for (const a of agents.values()) {
      const spawnTool = a.toolUseId !== null ? tools.get(a.toolUseId) : null;
      // Same fallback as the agent NODE's own `turnIndex`, and for the same reason: a forked skill
      // has no spawning tool at all, so the turn it belongs to is the one its `agent-launch` line
      // landed in. Without it a `/code-review` round owned no agent while its agent ran.
      const idx = spawnTool?.turnIndex ?? a.turnIndex;
      if (idx == null) continue;
      const bucket = agentsByTurn.get(idx);
      if (bucket) bucket.push(a.agentId);
      else agentsByTurn.set(idx, [a.agentId]);
    }
    // Which turns have an agent still going — all this reducer needs to know: an entry whose work
    // is running elsewhere is WORKING, whatever this thread is doing. WHAT to say about it is
    // `delegatedWork` (core/graph-derive.ts), where the same `displayState` the Subagents card
    // uses also lives — one rule, so the panel and the card cannot contradict each other.
    // `hasStarted` is what makes this the SAME question `displayState` answers for the view: a
    // launch that has left no trace of itself is not work in progress, it is a launch nobody has a
    // record of. Without it the two diverged and the panel announced the turn as started (it being
    // live) while the Subagents card called the same launch `unknown`.
    // The one part the reducer cannot know is whether the SESSION is over — both surfaces already
    // gate on that themselves before they draw a NOW.
    const delegating = new Set<number>();
    for (const a of subagents) {
      if (a.state === 'running' && hasStarted(a) && a.turnIndex != null) delegating.add(a.turnIndex);
    }
    // The activity group of every turn whose inputs moved since the last snapshot (see the
    // groupCache declaration for why this is not a plain pass over the ledger). A call counts
    // only if it started after its turn's last word — a turn that has not spoken yet counts
    // everything it has run.
    for (const idx of dirtyGroups) {
      // Almost always the open turn (it is the one accumulating calls); scanning `all` for it is
      // the O(turns × dirty) shape a previous perf fix removed from this very function.
      const turn = currentTurn?.index === idx ? currentTurn : all.find((t) => t.index === idx);
      const cutoff = turn?.lastWordTs ? (tsMs(turn.lastWordTs) ?? -Infinity) : -Infinity;
      let g: ActivityGroup | null = null;
      for (const id of toolIdsByTurn.get(idx) ?? []) {
        const tool = tools.get(id);
        // A call with no timestamp cannot be placed against the turn's last word, so it stays out
        // rather than being counted at an invented moment.
        if (!tool || tool.startTs === null) continue;
        const startTs = tool.startTs;
        const startMs = tsMs(startTs);
        if (startMs === null || startMs < cutoff) continue;
        if (!g) g = { counts: {}, startedTs: startTs, open: [] };
        g.counts[tool.name] = (g.counts[tool.name] ?? 0) + 1;
        if ((tsMs(g.startedTs) ?? Infinity) > startMs) g.startedTs = startTs;
        if (tool.endTs === null) g.open.push({ name: tool.name, startedTs: startTs });
      }
      if (g) g.open.sort((a, b) => (tsMs(a.startedTs) ?? 0) - (tsMs(b.startedTs) ?? 0));
      groupCache.set(idx, g);
    }
    dirtyGroups.clear();
    return all.map((t, i) => {
      const prevFill = i === 0 ? 0 : all[i - 1]!.fillEnd;
      const agentIds = agentsByTurn.get(t.index) ?? [];
      // live means WORKING: open AND already burning tokens. Without the apiCalls guard a
      // /model (which opens an entry and never calls the model, so no turn_duration ever
      // closes it) would pulse green forever.
      // Tokens burnt by an AGENT this turn launched count: a `/code-review` hands everything to a
      // forked skill and makes no call of its own, so on the guard alone it read as a closed local
      // command for the entire 9m53s its review ran (measured on the real session). A /model still
      // cannot qualify — it launches nothing.
      const state = t.state === 'live' && t.apiCalls === 0 && !delegating.has(t.index) ? 'done' : t.state;
      return {
        index: t.index,
        prompt: t.prompt,
        command: t.command,
        kind: kindOf(t, agentsByTurn.has(t.index)),
        startedAt: t.startedAt,
        state,
        durationMs: t.durationMs,
        messageCount: t.messageCount,
        apiCalls: t.apiCalls,
        deltaFill: t.fillEnd - prevFill,
        fillEnd: t.fillEnd,
        breakdown: { ...t.breakdown },
        cacheTotals: { ...t.cacheTotals },
        inputTotal: t.inputTotal,
        out: t.out,
        weighted: t.weighted,
        models: [...t.models],
        efforts: [...t.efforts],
        agentIds,
        skills: skillNodes(t.skillTurns, t.skillInvokes),
        commands: commandNodes(t.commandCounts),
        compaction: t.compaction,
        firstCall: t.firstCall ? { ...t.firstCall } : null,
        rebuildExpected: t.rebuildExpected,
        result: t.result,
        lastNarration: t.lastNarration ? { ...t.lastNarration } : null,
        activity: groupCache.get(t.index) ?? null,
        lastWordTs: t.lastWordTs,
      };
    });
  }

  /**
   * What the session has SEEN about a subagent's fate — never a guess.
   *
   * Three routes end a subagent, checked in this order: a notification that named no spawn
   * (`endedAgentIds` — the ONLY route for an agent that has no spawn at all), the spawn's own
   * end, and a nested subagent's tool-end.
   *
   * `running` means "launched, and no terminal signal has arrived". In a live session that is
   * the truth. In a session that has ENDED it means seedeep never learned how it finished
   * — the view, which is the only layer that knows the session is closed, renders that as
   * `unknown`. Deciding it here would make the reducer invent a fact it cannot have.
   *
   * Measured 2026-07-29 by replaying 910 ended sessions through this reducer: 3 of 1327
   * subagents (0.2%) end up here, in 3 of the 137 sessions that spawn any. All three had NO
   * agentType, NO tool ever run and NO returned text — launches with nothing behind them, not
   * agents whose ending was lost, which is what 92.8% of the ones that do end look like (they
   * carry their own final text). An earlier ~4.5% is not comparable: it predates the
   * end-routing rework and half its corpus has since been deleted by Claude Code.
   */
  function stateOf(sp: SpawnAcc | null, toolUseId: string | null, acc: AgentAcc | null): AgentNode['state'] {
    // A notification ended it while naming no spawn. This is the ONLY route for a subagent
    // that has no spawn at all (a skill forked into the background), and it is checked before
    // the tool-end below because it is a direct statement about the agent, not an inference.
    if (acc && endedAgentIds.has(acc.agentId)) {
      const st = endedAgentIds.get(acc.agentId);
      return st === 'failed' ? 'failed' : st === 'killed' ? 'killed' : 'done';
    }
    // A nested subagent (no spawn on record): its tool-end is the only thing we ever see.
    // LIMIT: a nested subagent that was itself launched in the BACKGROUND is notified in its
    // PARENT SUBAGENT's file, not in this session's, so no `agent-end` ever reaches this
    // reducer and it can only end via its tool-end. Not verified against real data — no
    // nested background launch has been observed yet.
    if (!sp) return toolUseId !== null && endedToolUseIds.has(toolUseId) ? 'done' : 'running';
    if (!sp.ended) return 'running';
    if (sp.endStatus === 'failed') return 'failed';
    if (sp.endStatus === 'killed') return 'killed';
    // completed, stopped, or no status at all (absent in 33 real notifications): a clean end.
    return 'done';
  }

  /**
   * A Workflow run collapsed into one row's worth of facts: how many subagents it spawned,
   * how many are still working, what it consumed, and on which models.
   *
   * `running` comes from the journal (started minus returned) because nothing in a workflow
   * subagent's transcript says whether it is done. Models are a BREAKDOWN, never one value: a
   * run deliberately mixes them per stage (measured on a real run: opus 386 calls + haiku 231).
   */
  function workflowAgg(
    runId: string,
    name: string | null,
    r: RunAcc | null,
    byAgent: Map<string, unknown[]>,
  ): NonNullable<AgentNode['workflow']> {
    const models = new Map<string, number>();
    const tokens = new Map<string, number>();
    const bd = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    let weighted = 0;
    let lastActivityAt: number | null = null;
    for (const id of r?.members ?? []) {
      const a = agents.get(id);
      if (!a) continue;
      weighted += a.weighted;
      bd.input += a.volIn;
      bd.output += a.volOut;
      bd.cacheRead += a.volCacheRead;
      bd.cacheCreation += a.volCacheCreation;
      for (const [m, t] of a.volByModel) tokens.set(m || (a.model ?? ''), (tokens.get(m || (a.model ?? '')) ?? 0) + t);
      if (a.model) bump(models, a.model);
      if (a.lastMs !== null && (lastActivityAt === null || a.lastMs > lastActivityAt)) lastActivityAt = a.lastMs;
    }
    // started-without-result. A run that ENDED still leaves some here (4 of 101 on the real
    // run): the journal never recorded their return. Same shape as a background subagent with
    // no notification — the view calls that `unknown` once the session is closed.
    let running = 0;
    for (const id of r?.started ?? []) if (!r!.finished.has(id)) running++;
    // UNION, not `members.size || started.size`: the journal records an agent as `started`
    // before its transcript file exists, so members can lag started and the row would claim
    // "5 of 3 running" — more running than exist, and a >100% bar.
    const all = new Set([...(r?.members ?? []), ...(r?.started ?? [])]);
    const memberList = [...all].map((id) => {
      const a = agents.get(id);
      const vol = a ? a.volIn + a.volOut + a.volCacheRead + a.volCacheCreation : 0;
      const dur = a?.firstMs != null && a?.lastMs != null ? a.lastMs - a.firstMs : null;
      const aw = windowFor(a?.model ?? null);
      return {
        agentId: id,
        agentType: a?.agentType ?? null,
        model: a?.model ?? null,
        volume: vol,
        fill: a?.fill ?? 0,
        window: aw.window,
        returned: r?.finished.has(id) ?? false,
        durationMs: dur,
        outLen: a?.outLen ?? 0,
        efforts: a ? [...a.efforts] : [],
        toolCount: byAgent.get(id)?.length ?? 0,
      };
    });
    return {
      name,
      runId,
      agents: all.size,
      running,
      volume: bd.input + bd.output + bd.cacheRead + bd.cacheCreation,
      breakdown: { ...bd },
      weighted,
      models: [...models.entries()].map(([model, agents]) => ({ model, agents })).sort((x, y) => y.agents - x.agents),
      tokensByModel: [...tokens.entries()]
        .map(([model, tokens]) => ({ model, tokens }))
        .sort((x, y) => y.tokens - x.tokens),
      lastActivityAt,
      members: memberList,
    };
  }

  function snapshot(): TreeSnapshot {
    const w = windowFor(mainModel);
    const mainTools: ToolNode[] = [];
    const byAgent = new Map<string, ToolNode[]>();
    for (const [id, t] of tools.entries()) {
      const node = toolNode(id, t);
      if (t.ownerAgentId === null) {
        mainTools.push(node);
        continue;
      }
      let bucket = byAgent.get(t.ownerAgentId);
      if (!bucket) {
        bucket = [];
        byAgent.set(t.ownerAgentId, bucket);
      }
      bucket.push(node);
    }
    // One row per LAUNCH, plus any child that no launch on record accounts for. The list is
    // the set of subagents this session started — a subagent appears the instant it is
    // spawned, not whenever its child file happens to show up.
    const claimed = new Set<string>();
    const rows: Array<{ sp: SpawnAcc | null; a: AgentAcc | null }> = [];
    for (const sp of spawns.values()) {
      const a = sp.agentId !== null ? (agents.get(sp.agentId) ?? null) : null;
      if (a) claimed.add(a.agentId);
      rows.push({ sp, a });
    }
    // A child with no spawn here: a NESTED subagent (its spawn lives in its parent
    // subagent's file, not in this one). Keep it listed — the list must never lose one.
    // A Workflow run's members are the exception: they belong to their run's single row.
    for (const a of agents.values())
      if (!claimed.has(a.agentId) && !runByAgentId.has(a.agentId)) rows.push({ sp: null, a });

    const subagents: AgentNode[] = rows.map(({ sp, a }) => {
      // launch/duration come from the spawn-tool (the parent `Agent` tool_use).
      const toolUseId = sp?.toolUseId ?? a?.toolUseId ?? null;
      const spawnTool = toolUseId !== null ? (tools.get(toolUseId) ?? null) : null;
      // Model: the child's own jsonl is authoritative (folded into a.model via
      // subagent-meta), but it may not have written a line yet — fall back to the model the
      // spawn was launched with. Resolved BEFORE windowFor so the subagent's context%
      // denominator is right even when only the spawn model is known.
      const model = a?.model ?? spawnTool?.spawnModel ?? null;
      const aw = windowFor(model);
      const state = stateOf(sp, toolUseId, a ?? null);
      // The spawn tool is the launch for everyone who has one; a forked skill has none, and its
      // `agent-launch` line is the only thing that knows when it started.
      const startedAt = spawnTool?.startTs ?? a?.launchedAt ?? null;
      const returned = spawnTool?.returned ?? null;
      // Returned output: the child's end_turn text is authoritative (covers sync AND
      // background — the background parent tool_result has none). Fall back to the
      // parent's inline returned only if the child produced nothing yet.
      const outputFull = a?.outputFull ?? returned?.outputFull ?? null;
      const outLen = a?.outLen || returned?.outLen || 0;
      // Duration: prefer the child's own span (first↔last line), then the parent's
      // totalDurationMs, then the spawn↔result delta. The spawn delta is only the
      // launch round-trip — ~0.07s for a background subagent, so it is not just a last
      // resort but a WRONG number there; a launch receipt never times the work.
      const childSpan =
        a && a.firstMs !== null && a.lastMs !== null && a.lastMs > a.firstMs ? a.lastMs - a.firstMs : null;
      const startMs = spawnTool?.startTs ? tsMs(spawnTool.startTs) : null;
      const endMs = spawnTool?.endTs ? tsMs(spawnTool.endTs) : null;
      const spawnDelta = sp?.launchedAsync ? null : startMs !== null && endMs !== null ? endMs - startMs : null;
      const durationMs = childSpan ?? returned?.totalDurationMs ?? spawnDelta;
      // Cumulative consumption. The child jsonl gives per-call usage → a true sum (volSum>0).
      // A background subagent writes no child usage; fall back to the parent-reported total
      // (≈ its final context) and flag it estimated, so the number is never silently wrong.
      const volSum = a ? a.volIn + a.volOut + a.volCacheRead + a.volCacheCreation : 0;
      const hasVolume = volSum > 0;
      // No per-call usage → the parent-reported total (≈ final context), or 0 if even that is
      // absent. `a.fill` is NOT a fallback here: it is set from the same usage events that feed
      // volSum, so whenever volSum is 0, a.fill is 0 too.
      // A workflow row is BUILT the moment its launch receipt names a runId — the run's dir is
      // scanned a tick or more later, so `runs` may not know it yet. workflowAgg therefore
      // tolerates a missing RunAcc and returns a zero fleet: `kind` and `workflow` are derived
      // from this ONE value below, so a workflow-kind row always carries a workflow object.
      const wf = sp?.runId ? workflowAgg(sp.runId, sp.workflowName, runs.get(sp.runId) ?? null, byAgent) : null;
      // A run's tokens are a true per-call sum over its subagents' own transcripts (the same
      // deduped usage every other subagent reports), so they belong in the session's Subagents
      // total and must NOT be flagged estimated. Reading them off the row's absent AgentAcc
      // instead reported 0 while the row itself displayed 10.7M, and flipped the whole total to
      // "~" on any session that ran a workflow.
      const volume = wf ? wf.volume : hasVolume ? volSum : (returned?.totalTokens ?? 0);
      const volumeBreakdown = wf
        ? { ...wf.breakdown }
        : hasVolume && a
          ? { input: a.volIn, output: a.volOut, cacheRead: a.volCacheRead, cacheCreation: a.volCacheCreation }
          : null;
      // Same three cases as `volume` above, in the same order, so the split can never disagree
      // with the total it splits: a workflow sums its members' per-call maps, a subagent with
      // per-call usage its own, and an estimated volume is charged whole to `model`.
      const volumeByModel: AgentNode['volumeByModel'] = wf
        ? wf.tokensByModel.map((x) => ({ model: x.model || null, tokens: x.tokens }))
        : hasVolume && a
          ? resolveVolByModel(a.volByModel, model)
          : volume > 0
            ? [{ model, tokens: volume }]
            : [];
      const fill = a?.fill ?? 0;
      return {
        kind: wf ? ('workflow' as const) : ('subagent' as const),
        workflow: wf,
        // A just-launched subagent has no child id yet: the spawn is its identity until the
        // receipt or the sidecar names it.
        agentId: a?.agentId ?? sp?.agentId ?? toolUseId ?? '',
        agentType: a?.agentType ?? null,
        title: agentTitle(spawnTool, a ?? null, a?.agentId ?? sp?.agentId ?? toolUseId ?? ''),
        efforts: a ? [...a.efforts] : [],
        model,
        fill,
        window: aw.window,
        pct: aw.window > 0 ? Math.round((fill / aw.window) * 100) : 0,
        estimated: aw.estimated,
        state,
        startedAt,
        durationMs,
        tools: (a ? byAgent.get(a.agentId) : undefined) ?? [],
        toolUseId,
        prompt: spawnTool?.launchPrompt ?? null,
        outputFull,
        outLen,
        volume,
        volumeEstimated: wf ? false : !hasVolume,
        volumeBreakdown,
        volumeByModel,
        // A workflow row stands in for its members, so it carries THEIR weight; an ordinary
        // subagent carries its own. Summing the nodes then equals summing the accumulators.
        weighted: wf ? wf.weighted : (a?.weighted ?? 0),
        // Same fallback as `startedAt`, for the same reason: a forked skill has no spawn tool, so
        // the turn it belongs to is the one its `agent-launch` line landed in.
        turnIndex: spawnTool?.turnIndex ?? a?.turnIndex ?? null,
      };
    });
    const skills = skillNodes(skillTurns, skillInvokes);
    const commands = commandNodes(commandCounts);
    const turnList = buildTurnList(subagents);
    const subagentsTotal = subagents.reduce((n, a) => n + a.volume, 0);
    const subagentsEstimated = subagents.some((a) => a.volumeEstimated);
    const subagentTokensByModel = sumTokensByModel(subagents);
    // NEWEST wins: a parallel batch is several open calls at once, and the one the session is
    // stopped on is the last to have started. A call whose line carried no timestamp cannot be
    // ordered against the others, so it is not a candidate rather than being placed at an
    // invented moment (the same rule the activity group applies).
    let openCall: TreeSnapshot['openCall'] = null;
    let openCallMs = -Infinity;
    for (const id of openMainCalls) {
      const t = tools.get(id);
      if (!t || t.startTs === null) continue;
      const ms = tsMs(t.startTs);
      if (ms === null || ms < openCallMs) continue;
      openCallMs = ms;
      openCall = { name: t.name, arg: t.arg, startedTs: t.startTs };
    }
    return {
      main: {
        fill: mainFill,
        window: w.window,
        pct: w.window > 0 ? Math.round((mainFill / w.window) * 100) : 0,
        estimated: w.estimated,
        model: mainModel,
        models: [...mainModels],
        regions: [...regions],
        breakdown: { ...breakdown },
        cacheTotals: { ...cacheTotals },
        inputTotal: usageInput,
        outputTotal: usageOutput,
        weighted: weightedMain,
        weightedByModel: [...mainWeightedByModel]
          .map(([model, weight]) => ({ model, weight }))
          .sort((a, b) => b.weight - a.weight),
      },
      mainTools,
      filesChanged: [...fileChanges],
      subagents,
      subagentsTotal,
      subagentsEstimated,
      subagentTokensByModel,
      compactions: [...compactions],
      skills,
      commands,
      // Summed over the NODES, not the raw accumulators, so a turn-scoped snapshot recomputes it
      // the same way from its own subset (see `scopeToTurn`) and the two can never diverge.
      weightedSubagents: subagents.reduce((n, a) => n + a.weighted, 0),
      weightedByModel: [...weightedByModel]
        .map(([model, weight]) => ({ model, weight }))
        .sort((x, y) => y.weight - x.weight),
      // `turns` stays what it has always meant — ROUNDS OF WORK. The timeline (turnList) also
      // carries local commands and context events, but counting those would quietly turn this
      // number into "things you typed".
      turns: turnList.filter((t) => t.kind === 'work').length,
      apiCalls,
      seq,
      turnList,
      openCall,
      error: sessionError && { ...sessionError },
      // The turn is read off the launch call, not stored with the appointment: the tool node
      // already knows which turn it belongs to, and a second copy could only disagree with it.
      wakeup: wakeup && { ...wakeup, turnIndex: tools.get(wakeup.toolUseId)?.turnIndex ?? null },
      notes: sessionNotes.map((n) => ({ ...n })),
    };
  }

  /** Notified (with no payload) after every applied event; pull the state with snapshot(). */
  function onChange(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }
  function onEvent(cb: (e: NormalizedEvent, ctx: EventContext) => void): () => void {
    eventListeners.add(cb);
    return () => eventListeners.delete(cb);
  }

  /**
   * The same fact `snapshot().error` carries, read in O(1).
   *
   * Not a shortcut for convenience: `snapshot()` walks every tool and agent the session ever had
   * (1521 tools on the largest real one), so a surface that needs ONLY this — the tab strip —
   * cannot afford to build one per event. Coalescing into a frame is not an option either: a
   * BACKGROUNDED tab gets no animation frames, and a tab you are not looking at is exactly the
   * one that must still turn red. One variable, two readers, no rule to keep in sync.
   */
  const currentError = () => sessionError && { ...sessionError };

  /**
   * The background commands still waiting for a fate — launched, no status, no verdict yet.
   *
   * A narrow accessor for the same reason {@link currentError} is one: the liveness probe needs
   * two strings per pending command, and `snapshot()` would rebuild every tool node of the session
   * (1521 on the largest real one) every 15 s, on every watched session, including the great
   * majority that never launch a command at all.
   *
   * The end test is `outcomeStatus`, never the summary: a notification carrying a `<status>` and
   * no `<summary>` leaves `outcome` unset, and probing a command Claude Code has already reported
   * on could only produce a verdict about something that is finished.
   */
  const pendingBackground = (): { toolUseId: string; taskId: string }[] => {
    const out: { toolUseId: string; taskId: string }[] = [];
    for (const [id, t] of tools) {
      if (!t.backgroundTaskId || t.outcomeStatus !== null || t.vanishedTs !== null) continue;
      // A `Monitor` is excluded, and this is a fact about the machine rather than a preference:
      // the probe answers "does any process still hold this command's output file open", and a
      // monitor NEVER holds it — measured 2026-08-10 on a monitor that was demonstrably alive
      // (its `sleep 90` in the process table, its output file 13 bytes long): `held: false`. A
      // background Bash keeps the file open, which is what the whole mechanism was measured on.
      // Asking anyway would report a working monitor as gone two probes after its first event.
      if (t.name === 'Monitor') continue;
      out.push({ toolUseId: id, taskId: t.backgroundTaskId });
    }
    return out;
  };

  return { apply, snapshot, onChange, onEvent, currentError, pendingBackground };
}
