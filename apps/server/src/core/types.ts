// Only Claude Code (CLI) sessions are observable: they are the sole source that
// writes per-API-call logs to disk. Claude Chat persists no session log locally
// (only editor drafts + UI state), and the current Cowork runs the session
// remotely — neither leaves anything to read. Kept as a named type so the data
// model still carries an explicit source tag.
export type Root = 'cli';

// Personal baseline types — defined here (no node deps) so both the corpus scanner
// (`baseline.ts`) and the verdict (`core/verdict.ts`) can share the shape.
export interface Bucket {
  /** How many turns fell in this bucket. A percentile from <20 turns is noise — callers check. */
  count: number;
  p50: number;
  p90: number;
  p95: number;
}
export interface Baseline {
  overall: Bucket;
  /** Keyed by the turn's reported effort ('unknown' when none — the 98% case). */
  byEffort: Record<string, Bucket>;
  turnsScanned: number;
  sessionsScanned: number;
}

// The minute-zero retrospective: corpus-wide aggregates shown at launch (Home tab),
// assembled from the persistent incremental aggregate cache. Defined here (no node deps)
// so the client can `import type` it without pulling in the server scanner.

/** One work turn's facts, including the severity the verdict gave it. Everything here is
 * file-local — a session is one file — which is what lets each file be summarized and cached on
 * its own, and it is why `severity` can be STORED rather than recomputed at aggregation time. */
export interface TurnSummary {
  /** input + output + cache_creation — the NEW tokens this turn spent (excludes cheap cache reads). */
  billable: number;
  /** cache_read tokens this turn — cheap re-reads of context. billable + cacheRead = the COMPLETE
   * tokens processed, the honest "total spent" (cache reads are billed too, just discounted). */
  cacheRead: number;
  /** This turn's MAIN-thread WEIGHT: every call's tokens scaled by kind and by the model that made
   * it (see `src/core/token-weight.ts`). Still a token count — a heavier model counts for more,
   * never a cost in dollars. Excludes the turn's subagents, which are a per-file total
   * (`SessionSummary.weightedSubagents`) because charging a child's calls to the turn that spawned
   * it is a further claim than the data supports. */
  weighted: number;
  effort: string;
  /** The model this turn's calls ran on ('unknown' when it made no model call). */
  model: string;
  /**
   * This turn's SUBAGENT tokens, split by the model that actually spent them, tokens descending.
   *
   * Charged to the turn that SPAWNED them, which the data supports: an agent carries the
   * `turnIndex` it was launched from and `scopeToTurn` already narrows the Trace that way. That is
   * a weaker claim than the one `weighted` refuses to make above — this is an unweighted token
   * count, not an attribution of cost to a model's price.
   *
   * Unweighted and COMPLETE (new + cache reads), matching the unit the retrospective's by-model
   * card prints beside itself. Kept apart from `billable` and `cacheRead`, which stay main-thread
   * only, so a consumer can never double-count by summing both.
   */
  subagentTokensByModel: { model: string; tokens: number }[];
  /**
   * Of the subagent tokens above, the NEW part (input + output + cache_creation).
   *
   * Separate because the KPI tile states "N new · rest cache", and folding an agent's whole volume
   * into the total while leaving `new` untouched would silently file every subagent token as a
   * cache read. Zero for an agent whose per-call breakdown is missing (an estimated volume): its
   * tokens still count in the total, they just make no claim about which half they came from.
   */
  subagentNew: number;
  /** Main-session API calls in this turn (distinct message.ids). */
  apiCalls: number;
  /** Of `billable`, the part spent RE-CREATING the context on the turn's first call instead of
   * working (0 when the turn did not resume cold). Stored, not derived at aggregation time,
   * because it comes from the turn's first call — a fact only the reducer holds. `billable`
   * stays the full amount: the totals must not shrink, only what is attributed to work. */
  resumeCost: number;
  esc: boolean; // interrupted (Esc) — the raw state, kept for the abandoned-token total
  /** Interrupted AND the previous work turn was too — the only Esc the verdict flags, since a
   * lone one is the behaviour the guide recommends ("course-correct early and often"). */
  escStreak: boolean;
  context: boolean; // context ≥70% full at the end of the turn (mapped window only)
  compaction: boolean; // involuntary mid-turn compaction (work turn)
  subWaste: boolean; // a subagent dumped a large output into main
  exploration: boolean; // read many files into main, changed nothing, delegated nothing
  /** Committed real code with no check run anywhere earlier in the session. Session-scoped, but
   * still cacheable per file: the session IS the file. */
  unverifiedShip: boolean;
  /** The turn's start, epoch ms (null when the line carried no timestamp) — for time windows. */
  ts: number | null;
  /** The turn's working time in ms (null when unknown) — summed into "spent working". */
  durationMs: number | null;
  /** The verdict's worst-of severity, as {@link computeVerdict} computed it — STORED, not
   * re-derived. It was recomputed at aggregation for as long as one detector compared a turn to
   * the GLOBAL baseline (it would have gone stale whenever any file changed). Since that detector
   * was removed on 2026-07-27 every detector is file-local, so the severity is a fact about this
   * file and storing it removes the cache's second implementation of the worst-of rule. */
  severity: 'good' | 'warn' | 'crit';
}

/** The fixed turn-size histogram bins (billable tokens per turn), shared server↔client so the
 * x-axis labels and the counts stay aligned. `max` is exclusive; the last bin is open-ended. */
export const HIST_BINS: ReadonlyArray<{ label: string; min: number; max: number }> = [
  { label: '<1k', min: 0, max: 1e3 },
  { label: '1–3k', min: 1e3, max: 3e3 },
  { label: '3–10k', min: 3e3, max: 1e4 },
  { label: '10–30k', min: 1e4, max: 3e4 },
  { label: '30–100k', min: 3e4, max: 1e5 },
  { label: '100–300k', min: 1e5, max: 3e5 },
  { label: '300k+', min: 3e5, max: Infinity },
];

/** One time window's aggregates. Percentiles here are WINDOWED (the KPI + histogram markers). */
export interface RetroWindow {
  turns: number;
  p50: number;
  p90: number;
  p95: number;
  /** COMPLETE tokens processed in the window (new + cache reads) — the honest "total spent". */
  totalTokens: number;
  /** NEW tokens only (input + output + cache_creation) — the analytic "work" figure. */
  newTokens: number;
  /** Main-session API calls across the window. */
  apiCalls: number;
  /** Total tokens (new + cache reads) per model, descending — the by-model split (cool palette, not severity). */
  byModel: { model: string; tokens: number }[];
  /** Interrupted turns and the tokens abandoned to Esc — the raw state, not the finding. */
  esc: { turns: number; tokens: number };
  /** Interruptions the verdict actually flags: the second in a row and beyond. */
  escStreak: number;
  /** Turns that ended with the context ≥70% full (mapped windows only). */
  context: number;
  subWaste: number;
  compaction: number;
  /** Turns that resumed cold, and the tokens they spent re-creating context instead of working.
   * A session-level reading the per-turn verdict cannot give: measured over the local corpus,
   * this is a quarter of every token spent. */
  resume: { turns: number; tokens: number };
  /** Turns that read many files into main, changed nothing and delegated nothing. */
  exploration: number;
  /** Turns that committed code with no check anywhere earlier in the session. */
  unverifiedShip: number;
  /** Severity split (good = turns - crit - warn). */
  crit: number;
  warn: number;
  /** Total working time in ms across the window's turns. */
  workMs: number;
  /** Counts per {@link HIST_BINS} bin — window-reactive. */
  hist: number[];
  /** Median COMPLETE tokens per turn (new + cache reads) — the KPI tile. Matches the
   * `totalTokens` definition so all token figures in the dashboard share one scale.
   * Kept separate from `p50` (new-tokens only) so the histogram markers stay aligned. */
  p50Complete: number;
  /** p95 COMPLETE tokens per turn — shown beside `p50Complete` in the KPI hint. */
  p95Complete: number;
}

export interface Retrospective {
  /** All-time session count (the header shows it only for the all-time window). */
  sessions: number;
  /** Sessions that spent 10% or more of their billable tokens re-entering their own context
   * instead of working. 10% is not our number: it is the share at which Claude Code's own
   * `/usage` breakdown "flags behaviors […] such as long context or cache misses"
   * (code.claude.com/docs/en/costs). Measured locally: 59 of 231 sessions (25.5%). */
  reentrySessions: number;
  /** Corpus age in days — used to size the activity axis to the real span. */
  spanDays: number;
  /** The personal baseline (overall + per-effort percentiles), all-time — the same shape
   * `/api/baseline` serves. DESCRIPTIVE only: no detector reads it (see `bucketFor`). */
  baseline: Baseline;
  /** All-time weekly cadence, index 0 = the CALENDAR week containing `now` (Monday-anchored,
   * local time), back to the corpus start. Calendar — not rolling — so the bars don't shift
   * under the reader between two refreshes. Each week carries the three ways to read the work
   * done: turns (severity split), `tokens` (COMPLETE, incl. cache reads) and `workMs`.
   * Not windowed: it is the whole history's rhythm, which a window would defeat. */
  weeks: { crit: number; warn: number; good: number; tokens: number; workMs: number }[];
  /** Last 7 calendar days, index 0 = today (local midnight-anchored), index 1 = yesterday, …
   * Always 7 slots (empty buckets for days with no activity). Same shape as one `weeks` entry
   * so the activity chart can reuse the same renderer for the 7-day window. */
  days: { crit: number; warn: number; good: number; tokens: number; workMs: number }[];
  /** All-time tool-call counts by tool name, descending — "how you use the agent". Not windowed
   * (a per-turn tool breakdown would bloat the cache; the all-time picture is what's useful). */
  tools: { name: string; count: number }[];
  /** The three selectable windows; the client switches between them with no refetch. */
  windows: { all: RetroWindow; d30: RetroWindow; d7: RetroWindow };
}

export interface SessionRecord {
  sessionId: string;
  project: string;
  model: string | null;
  lastActivity: number; // epoch ms (file mtime)
  isActive: boolean; // mtime-window fallback openness proxy
  // Has a live ~/.claude/sessions/<PID>.json. `null` = that mechanism is unavailable (the dir
  // is absent — an undocumented CC internal that a release may drop), which is the ONLY case
  // where `isActive` gets to answer instead. Read it through {@link isLive}.
  isOpen: boolean | null;
  // from the open session file — `shell` while a background command it launched is still running
  // (see OpenSession). Raw: each surface decides what claim it makes on screen.
  status: 'busy' | 'idle' | 'waiting' | 'shell' | null;
  // Set only while `status` is 'waiting': Claude Code's own label for what the session is
  // blocked on (see OpenSession), and the instant it stopped there. The GUI turns the pair
  // into the pending-approval signal and its ticking age.
  waitingFor: string | null;
  waitingSince: number | null;
  // The session's first substantive human intent (typed prompt or non-control
  // slash command, or an SDK prompt for headless runs), anonymized + capped — the
  // one human-readable label that lets the picker be read at a glance. Null when
  // no such line was found in the scanned head (e.g. an aborted session).
  subject: string | null;
  // How the session was launched: 'cli' = interactive TUI; 'sdk-cli'/'sdk-py' =
  // headless/programmatic (git-hook `claude -p`, scripts). Lets the GUI badge the
  // non-interactive ones instead of passing them off as normal sessions.
  entrypoint: string | null;
  root: Root;
  path: string;
}

/**
 * The session is live: a running Claude Code process (`isOpen`), with the mtime window
 * (`isActive`) as the fallback for a server that predates `isOpen` or a Claude Code without
 * `~/.claude/sessions/`.
 *
 * Lives here, beside the record, because BOTH sides must answer it the same way: the watcher
 * decides from it whether to keep tailing, the picker decides from it what to file under
 * Live. Split in two, they disagree exactly when it matters — a session waiting on a
 * background subagent writes nothing to its own jsonl, so `isActive` goes false while the
 * process is very much alive and its children are still writing.
 */
export function isLive(s: Pick<SessionRecord, 'isOpen' | 'isActive'>): boolean {
  return s.isOpen ?? s.isActive;
}

/**
 * The session is DOING something — which is not the same as "its agent is thinking".
 *
 * `busy` is the agent at work. `shell` is Claude Code's own word for a turn that is OVER while a
 * command it launched in the background is still running, and it is the whole reason this predicate
 * exists: read as "not busy", such a session was filed under Idle and then jumped back to Working
 * when the command finished — reported from a real session, then reproduced by sampling CC's
 * process file every 2 s across a 240-second background command.
 *
 * Here, beside {@link isLive}, because every surface must answer it the same way: the browser's tab
 * badge, the tray's band, and the tray's Rust icon (which holds its own copy — see `poll.rs` — with
 * a test pinning it to this one).
 */
export function isWorking(s: Pick<SessionRecord, 'status'>): boolean {
  return s.status === 'busy' || s.status === 'shell';
}

/**
 * The MODEL is running right now — `busy` and nothing else.
 *
 * Deliberately not {@link isWorking}: that one counts `shell`, which is Claude Code's word for a
 * turn that is OVER while a command it launched keeps running. A session is still "working" then
 * (the tab dot, the tray's band), but its TURN has finished — so anything asking "is this turn
 * still going" must ask this instead, or every background command marks the closed turn live and
 * takes the session's Result button away with it.
 */
export function isModelBusy(s: Pick<SessionRecord, 'status'>): boolean {
  return s.status === 'busy';
}

/** What a blocked session is waiting for, when it is the HUMAN it waits on. */
export type PendingKind = 'permission' | 'input';

/**
 * The session is blocked on the user, and on what: 'permission' (a tool or plan approval),
 * 'input' (AskUserQuestion, MCP elicitation). Null when it is running, or when the dialog
 * on screen is one the user opened themselves.
 *
 * The distinction cannot come from `status` — Claude Code writes 'waiting' for EVERY open
 * dialog, including the model picker — so it is read off `waitingFor`, whose labels were
 * measured on a real session. An unknown label (a newer release) is deliberately NOT
 * treated as an approval: a badge that cries wolf is worse than a badge that stays dark.
 *
 * Here rather than in the client for the same reason as {@link isLive}: the NOW state both
 * surfaces show is computed from it (`nowLine`), so the browser and the digest must not
 * each decide for themselves what counts as blocked.
 */
export function pendingInput(s: Pick<SessionRecord, 'status' | 'waitingFor'>): PendingKind | null {
  if (s.status !== 'waiting') return null;
  if (s.waitingFor === 'permission prompt') return 'permission';
  if (s.waitingFor === 'input needed') return 'input';
  return null;
}

// A FALLBACK openness proxy (mtime window) for when ~/.claude/sessions is
// unavailable. Widened from 60s — too short: an open-but-idle session (the user
// reading output, the model thinking) has no recent write and looked dead.
// Lives here rather than in roots.ts because `isActive` is a pure function of `lastActivity`
// and this window, and BOTH sides compute it: discovery from the file's mtime, the client
// when it rebuilds a row from the split roster payloads (see roster.ts).
export const ACTIVE_WINDOW_MS = 300_000; // 5 min

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

interface EventBase {
  sessionId: string;
  root: Root;
  timestamp: string;
  seq: number; // monotonic per-file line number, assigned by the line reader
  agentId?: string | null; // subagent id for child-file events; null/undefined = main session
}

export interface UsageEvent extends EventBase {
  type: 'usage';
  delta: TokenCounts;
  fill: number; // last absolute input + cacheRead + cacheCreation
  /**
   * Reasoning effort this call ran at, from the assistant line's ROOT `effort` (not inside
   * `message`). Null when the line does not carry it — which is not "no effort": Claude Code
   * only began writing it in 2.1.212, and models without a configurable effort never do.
   * Per CALL, not per turn: no turn-level line carries it, and a subagent writes its own.
   */
  effort?: string | null;
  /**
   * Model this call ran on (`message.model`). Per CALL, because that is what it is: `/model`
   * mid-session moves it, and the context window moves with it (opus 1M → sonnet 200k). The
   * session head only says what the session STARTED on, which is a different question.
   * Null when the line carries none (`<synthetic>` API-error lines).
   */
  model?: string | null;
  /**
   * The API call this usage belongs to (`message.id`). Claude Code writes ONE LINE PER CONTENT
   * BLOCK — thinking, each tool_use, text — and every line repeats the SAME usage block, so a
   * line is NOT a call. Anything summed over calls (cache totals, apiCalls, output tokens) must
   * fold once per callId; without it a 4-block answer counts four times. Null when the line
   * carries no id (`<synthetic>` API-error lines), where the reducer falls back to the seq.
   */
  callId: string | null;
  /**
   * The call FAILED: Claude Code wrote it as an assistant line flagged `isApiErrorMessage`
   * (rate limit, auth, overloaded, prompt too long, connection dropped). Absent on a normal
   * call. Keyed on that flag and NOT on `apiErrorStatus`, which only 27 of 63 real error
   * lines carry — the statusless ones ("Not logged in", "Prompt is too long", "Connection
   * closed mid-response") are the ones a user most needs to see. `message.model` on these
   * lines is always `<synthetic>`, but the reverse does not hold: synthetic lines that are
   * NOT errors exist (76 measured), so the model can never stand in for the flag.
   */
  apiError?: { status: string | null; message: string };
}

export interface AttributionEvent extends EventBase {
  type: 'attribution';
  kind: 'skill' | 'mcpServer' | 'mcpTool';
  name: string;
}

// A real user prompt that starts a round (a text user line — NOT a tool_result and
// NOT a slash-command expansion). Counting these gives the session's "turns".
export interface UserTurnEvent extends EventBase {
  type: 'user-turn';
  prompt: string; // the whole anonymized prompt (a command's args, when it came from one)
  // The slash command that opened this turn ('paste-image', 'clear'…), or null when typed.
  // Whether the command COST anything is not knowable here — the reducer decides that.
  command: string | null;
  // Claude Code's id for the invocation this line belongs to. Carried for ONE reason: a command
  // can be written twice — once as the plain text the user typed, once expanded with
  // `<command-name>` — and the two lines share it (measured on 15 of 19 real plain-text lines).
  // The reducer folds that pair into one turn. NOT a general identity: a prompt QUEUED while a
  // command ran carries the command's id too (measured once, real), which is why the reducer
  // only ever dedups two lines naming the SAME command.
  promptId?: string | null;
}

// system/turn_duration: Claude Code writes this at the end of every non-interrupted turn.
export interface TurnEndEvent extends EventBase {
  type: 'turn-end';
  durationMs: number | null;
  messageCount: number | null;
}

// A user row carrying `interruptedMessageId`: the turn that preceded it was Esc'd. The id
// itself is NOT carried: it points at a message uuid that does not exist in the file
// (verified across real sessions), so it can link nothing — only its PRESENCE is the signal.
export interface TurnInterruptedEvent extends EventBase {
  type: 'turn-interrupted';
}

// Main-session assistant line with stop_reason "end_turn": the turn's conclusion.
// Mirrors SubagentOutputEvent; anonymized + length-capped; last event wins.
export interface TurnResultEvent extends EventBase {
  type: 'turn-result';
  outputFull: string;
  outLen: number;
}

// A main-session assistant line that carries a text block but is NOT the turn's end
// (stop_reason !== "end_turn" — measured `tool_use` on 79% of text-bearing lines, 2026-07-20):
// the model narrating mid-turn what it is about to do. This is the live intent panel's datum.
// Emitted for the MAIN session only — a subagent's narration has no consumer (see parser).
// Anonymized + length-capped; the reducer accumulates these per turn (not last-wins).
export interface TurnNarrationEvent extends EventBase {
  type: 'turn-narration';
  text: string;
  // The API call this narration belongs to (`message.id`), which is also the call whose tools
  // form the Trace's round — so the Trace can name a round with the intent that opened it.
  // The span it names always exists by the time this arrives: the api span is created by the
  // usage of the call's FIRST line, which is this same line when the text block leads, and an
  // earlier one (`thinking`) otherwise — and within a line, `usage` is emitted before the
  // content blocks. Null on a line carrying no `message.id`.
  callId: string | null;
}

// A slash command the user typed (`<command-name>/paste-image</command-name>`).
export interface CommandEvent extends EventBase {
  type: 'command';
  name: string; // e.g. "paste-image" (leading slash stripped)
}

// A `file-history-delta` line: Claude Code backed up one file it just changed — this is CC's
// OWN change ledger (the source behind /rewind), written interleaved with the turn that caused
// the change (verified positionally). One delta = one change event; the reducer counts them per
// path and attributes each to the open turn, like a tool. The sibling `file-history-snapshot`
// (the baseline) is deliberately IGNORED: it adds nothing once we only count changes.
// LIMIT: the ledger is NOT origin-agnostic. Provoked on 2.1.218 in a driven session: a file
// written ONLY by Bash (`sed -i`, `echo >`, `cp`) emits no delta and never enters a snapshot's
// `trackedFileBackups` either, while an Edit on a sibling file in the same session does — so a
// shell-only change is invisible here, by CC's design, not by a parser gap. A file outside the
// tracked workspace is never in the ledger either. Main session only — a subagent's edits are
// not attributed here.
export interface FileChangeEvent extends EventBase {
  type: 'file-change';
  path: string; // anonymized trackingPath (repo-relative)
}

export interface CompactionEvent extends EventBase {
  type: 'compaction';
  isSummary: boolean;
  preTokens: number | null; // from compactMetadata.preTokens
  postTokens: number | null; // from compactMetadata.postTokens
  durationMs: number | null; // from compactMetadata.durationMs
}

// NOTE: there is deliberately no "a subagent was born" event. A subagent's existence is
// proven by any event carrying its `agentId` (its own file produced a line), so a
// dedicated birth event would duplicate what the stream already says — and, having no
// producer, would silently never fire.

export interface ToolStartEvent extends EventBase {
  type: 'tool-start';
  id: string; // tool_use block id
  name: string; // tool name (e.g. "Agent", "Grep")
  arg?: string; // human-meaningful input (anonymized): file path / command / skill
  // Present only for an `Agent` spawn: the prompt the subagent was launched with
  // (anonymized), its type, and the model it was launched with (from the spawn's
  // `.input.model`). The model is a FALLBACK: a subagent's own jsonl is authoritative,
  // but async subagents (Task tool) write no child jsonl, so the spawn is the only
  // source. Absent (undefined) for every other tool.
  launchPrompt?: string;
  subagentType?: string;
  spawnModel?: string;
  // The spawn's `input.description` ("Finder A: line-by-line scan") — the human
  // intent of the launch, far more telling than the generic subagentType.
  description?: string;
  // The Task family takes a REFERENCE, not an argument: `TaskUpdate` names a todo row by its
  // number, `TaskOutput`/`TaskStop`/`TaskGet` name a background task by an id that IS the
  // subagent's agentId (52 of 62 real task_ids matched a launch receipt). Neither is worth
  // showing raw — only the reducer, which holds the cross-event state, can turn one into a
  // label. Absent for every tool outside the family.
  taskRef?: TaskRef;
}

/**
 * Tool names that launch a subagent. `Task` is the older name for `Agent` (its result reads
 * "Async agent launched successfully. agentId: …") and takes the same input keys. Lives here,
 * on the shared contract, because BOTH sides must agree: the parser extracts the spawn's
 * prompt/type from it, and the reducer puts the spawn on the subagent list — a second copy in
 * either would let one recognise a spawn the other silently ignores.
 */
export const SPAWN_TOOL_NAMES = new Set(['Agent', 'Task']);

/** What a Task-family tool points AT. `kind` says which map resolves it. */
export interface TaskRef {
  id: string; // TaskUpdate: the todo number ("1"); TaskOutput/Stop/Get: the agentId
  kind: 'todo' | 'agent';
  status?: string; // TaskUpdate only: the status it is moving the row to
}

// The verbatim text a subagent returned to the main session, plus its own totals.
// Extracted from the parent's `Agent` tool_result (`.toolUseResult`), which is the
// only place the full returned output lives — no child-file read is needed.
export interface SubagentReturned {
  outputFull: string; // anonymized, length-capped verbatim output
  outLen: number; // outputFull.length
  totalTokens: number | null; // .toolUseResult.totalTokens
  totalDurationMs: number | null; // .toolUseResult.totalDurationMs (the real subagent runtime)
  status: string | null; // .toolUseResult.status (e.g. "completed")
}

export interface ToolEndEvent extends EventBase {
  type: 'tool-end';
  toolUseId: string; // matches a ToolStartEvent.id
  // The tool FAILED. Set only for a real failure: a result the USER refused (Esc on the
  // permission prompt, or a deny rule) also carries `is_error: true`, and is deliberately
  // NOT flagged — that is the user steering, not the agent hitting a wall. See toolOutcome
  // in src/failure.ts for the classification and the measurements behind it.
  error?: true;
  outputSize?: number; // rendered tool_result char length (the "context hog" metric)
  // A short anonymized slice of the tool_result — the INPUT the NEXT API call was fed. Only
  // this preview is kept (never the whole result: that is served on demand, see tool-output.ts);
  // the reducer holds the latest one so an API-call feed row can show what triggered it. Absent
  // when the result rendered empty.
  outputPreview?: string;
  // Present only when the ended tool is an `Agent` result (a subagent finished).
  returned?: SubagentReturned;
  // A `TaskCreate` result — the ONLY place a todo's number is stated (the input has no id).
  // Read here because the reducer never sees tool_result text: the output is served on demand
  // and deliberately not held in memory, so a ~40-char reference is extracted at parse time.
  taskCreated?: { id: string; subject: string };
  // An `Agent` result whose status is "async_launched": a LAUNCH RECEIPT, not a completion.
  // It arrives ~0.07s after the spawn and only says the subagent started, so it must never
  // end the subagent — its real end comes later, as an `agent-end`. Carries the child's
  // agentId, which the receipt knows immediately (the sidecar link may still be minutes away).
  launched?: { agentId: string | null };
  // A `Workflow` launch receipt. A workflow is not a subagent: it is a script that spawns its
  // OWN subagents (~100 of them) into a nested dir, and is shown as one aggregate row.
  // `runId` names that dir (verified: runId === basename(transcriptDir)).
  workflow?: { runId: string | null; name: string | null };
  // A BACKGROUND COMMAND's launch receipt (a Bash, not a subagent): the tool returned in ~74ms
  // having only STARTED the command, whose real outcome arrives later as an `agent-end` naming
  // the same tool_use id. `backgroundTaskId` is the only reliable marker — a foreground command
  // PROMOTED to the background by the 120s timeout carries no `run_in_background` input (11 of
  // 43 measured), and a `Monitor` call gets a `b`-prefixed notification but never this field.
  // Consumers key on its PRESENCE to know a later notification is about a command they ran.
  background?: { taskId: string };
}

/**
 * One subagent of a Workflow run, seen either in its transcript dir or in the run's
 * journal. These are real subagents (`agentType: "workflow-subagent"`) but they have no
 * spawn in this session's log — the workflow script spawned them — so they are aggregated
 * into their run's single row instead of being listed one by one.
 */
export interface WorkflowAgentEvent extends EventBase {
  type: 'workflow-agent';
  runId: string;
  // 'seen'    — a transcript file exists for it (membership; its usage/model flow in as
  //             ordinary agent-tagged events).
  // 'started' — the journal recorded it starting.
  // 'result'  — the journal recorded its return value. started-without-result = still running.
  phase: 'seen' | 'started' | 'result';
}

/**
 * A background subagent — or a background COMMAND — actually finished. Parsed from the
 * `queue-operation` line whose content is a `<task-notification>`: the ONLY outcome signal
 * either one has in the parent jsonl (its tool_result was just the launch receipt). Fires on
 * every stop, so a resumed agent produces several: the LAST one wins, never a latch.
 */
export interface AgentEndEvent extends EventBase {
  type: 'agent-end';
  // <tool-use-id> — links back to the spawn. NULL when the notification carries none: a skill
  // forked into the background has no spawning tool call, so `taskId` is its only name.
  toolUseId: string | null;
  taskId: string | null; // <task-id> (the child's agentId)
  status: string | null; // <status>: completed | failed | killed | stopped, or null when absent
  // <summary> — Claude Code's own sentence about the outcome ("Background command "Start
  // seedeep server" failed with exit code 144"). Kept because for a background COMMAND it is
  // the only human-readable statement of what happened: the exit code lives nowhere else in
  // the transcript. Anonymized, since a summary sometimes quotes the command verbatim.
  summary: string | null;
  // <output-file> — where the command's output was written. Only the notification carries it: a
  // background launch's receipt has an empty stdout, so this is the ONLY pointer to what the
  // command actually printed. Anonymized (it sits under the scratchpad root, which encodes the
  // uid and the home). Null on a notification that carries none — a subagent's, for one.
  outputFile?: string | null;
}

export interface SubagentOutputEvent extends EventBase {
  // A child (subagent) assistant line with stop_reason "end_turn": its text is the
  // subagent's final returned output. agentId (on EventBase) identifies the child.
  // The reducer keeps the LAST such event per agentId (covers sync AND background —
  // the background parent tool_result carries no output). Anonymized + length-capped.
  type: 'subagent-output';
  outputFull: string;
  outLen: number;
}

export interface SubagentMetaEvent extends EventBase {
  // agentId is on EventBase (the child's id). toolUseId links this subagent to the
  // parent tool_use that spawned it — the key to deriving running/done in the reducer.
  // model is the child's own model, so the subagent gets its real % denominator.
  type: 'subagent-meta';
  toolUseId: string | null;
  agentType: string | null;
  spawnDepth: number | null;
  model: string | null;
  // What the subagent was launched to do, as the sidecar records it. Normally the same string the
  // parent's `Agent` spawn carries — but a FORKED SKILL has no spawn at all, and this is the only
  // place its launch is named ("/code-review del diff"); without it the row reads `general-purpose`.
  description?: string | null;
}

// A forked skill's launch, read off the parent's `local_command` line (`<forked-skill-launch>`).
// It is NOT a tool_use: `/code-review` and friends run as a background agent with no `Agent` block
// anywhere, so this is the only record of WHEN the agent started and which turn asked for it.
export interface AgentLaunchEvent extends EventBase {
  type: 'agent-launch';
  // On EventBase, `agentId` is the id of the agent whose transcript a line came FROM. Here it is
  // the id of the agent being launched, which is why the parser emits it with agentId null on the
  // event base and names the launched agent in this field instead.
  launchedAgentId: string;
  skillName: string;
  description: string | null;
}

export type NormalizedEvent =
  | UsageEvent
  | AttributionEvent
  | CompactionEvent
  | ToolStartEvent
  | ToolEndEvent
  | AgentEndEvent
  | AgentLaunchEvent
  | WorkflowAgentEvent
  | SubagentMetaEvent
  | SubagentOutputEvent
  | UserTurnEvent
  | CommandEvent
  | FileChangeEvent
  | TurnEndEvent
  | TurnInterruptedEvent
  | TurnResultEvent
  | TurnNarrationEvent;

// ── Cross-session comparison ─────────────────────────────────────────────────────────────────
// "Across these N days, which session weighed the most." The unit is a token count weighted by
// the kind of token and by the model that spent it (see `src/core/token-weight.ts`) — never a cost
// in dollars. Defined here (no node deps) so the client can `import type` it.

/** One session in the comparison. `weight` covers the main thread AND its subagents. */
export interface CompareRow {
  sessionId: string;
  project: string;
  /** The session's first task-bearing prompt, anonymized; null when it has none (an sdk run). */
  subject: string | null;
  entrypoint: string | null;
  weight: number;
  /** Of `weight`, the part its subagents spent. */
  subagentWeight: number;
  /** `weight` split by the model of the call, weight descending. Sums to `weight`. */
  byModel: { model: string; weight: number }[];
  /** The session's COMPLETE unweighted token total: input + output + cache_creation + cache_read,
   * every model, main thread plus subagents. Shown beside the weight so the row states both what
   * it actually processed and what that cost in weighted terms. */
  tokensComplete: number;
  /** The model the session's MAIN thread mostly ran on — subagents excluded, since a Haiku explorer
   * does not make an Opus session a Haiku one. Null when it made no weighable call. */
  mainModel: string | null;
  /** How many distinct models the main thread used; >1 means a mid-session `/model`. */
  mainModels: number;
  turns: number;
  apiCalls: number;
  /** Last activity: the session's last work-turn timestamp, else its file mtime (epoch ms). */
  lastTs: number;
  /** Rank in this window by weight, and by UNWEIGHTED billable tokens — the pair is what lets a
   * row state how far the weighting moved it. Both are 1-based over EVERY session in the window,
   * not over the returned rows, so the figure survives the top-N cut. */
  rank: number;
  rawRank: number;
}

/** One time window of the comparison: its totals, its heaviest sessions, and what the cut left. */
export interface CompareWindow {
  sessions: number;
  weight: number;
  /** Of `weight`, the part spent by subagents across the whole window. */
  subagentWeight: number;
  byModel: { model: string; weight: number }[];
  /** The heaviest sessions, weight descending — at most {@link COMPARE_TOP_N}. */
  top: CompareRow[];
  /** What `top` leaves out. Rendered, never silent: a truncated leaderboard that says nothing
   * reads as "this is all of it". */
  restSessions: number;
  restWeight: number;
}

/** The comparison payload: one response carries all three windows, switched client-side. */
export interface Comparison {
  generatedAt: number;
  windows: { all: CompareWindow; d30: CompareWindow; d7: CompareWindow };
}

/** How many sessions a window returns. The remainder is reported as an aggregate, so raising this
 * changes how much detail is shown, never whether the total is complete. */
export const COMPARE_TOP_N = 20;

// --- session search ---------------------------------------------------------------------
// "Which session talked about these words." The corpus is the DIALOGUE — what the user typed
// and what the assistant answered in prose — never the raw transcript: injected instructions,
// system reminders and tool results match roughly twice as often and say nothing about what the
// session was for (measured 2026-07-29: `subagent` 706 raw vs 350 in dialogue).

/** Who said a snippet. The row states it, so a match in your own words never reads as Claude's. */
export type DialogueSpeaker = 'you' | 'claude';

/** A passage of a session that carries the query terms, as the row displays it. */
export interface SearchSnippet {
  who: DialogueSpeaker;
  /** Ellipsized around the match; whitespace collapsed. Raw text — the client never builds HTML
   * from it (see `search-view.ts`). */
  text: string;
}

/** One session matching a query: who it is (from the roster) and how well it matches. */
export interface SearchRow {
  sessionId: string;
  project: string;
  /** The session's first task-bearing prompt, anonymized; null when it has none (an sdk run). */
  subject: string | null;
  /** `sdk-*` marks an automated run. The client splits Human/Automated on it, with the same
   * predicate the picker uses — one definition, or a run is filed differently in two places. */
  entrypoint: string | null;
  /** File mtime (epoch ms) — the roster's own last-activity signal. */
  lastActivity: number;
  /** Total occurrences of every term over the session's dialogue. */
  hits: number;
  /** Characters of dialogue in the session — the denominator of the density the row shows. */
  chars: number;
  /** At most two passages, the ones where the most DISTINCT terms cluster. */
  snippets: SearchSnippet[];
}

/** The search payload. Every match is returned — no top-N cut: the client splits Human from
 * Automated and orders by the number it prints. */
export interface SearchResponse {
  /** The query split into AND terms, echoed so the client can highlight exactly what matched. */
  terms: string[];
  rows: SearchRow[];
  /** How long the match itself took, ms — shown so a slow corpus is visible, not guessed at. */
  ms: number;
}
