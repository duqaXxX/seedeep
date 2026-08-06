// The NOW panel's rules that are pure enough to assert: what it says about an activity group,
// which open call its age chip times, and how long the agent's own last word keeps the panel.
// Kept apart from the panel because none of it needs a DOM — the panel only draws the answers.

/** A call must have been open this long to count as running on screen — below it, a chip would
 * appear and vanish within one tick (median real call: 157ms, 85% finish inside a second). */
export const RUNNING_AFTER_MS = 1000;

/** How many tool families the line names before it trails off. Measured: only 1.7% of real groups
 * touch more than three, so the ellipsis is rare — and it keeps the line short when it fires. */
export const MAX_FAMILIES = 3;

// One verb and one noun per tool. Explicit plurals: no rule gets `directory`/`queries` right,
// and a wrong plural is the kind of detail that makes a panel look machine-made.
const WORDS: Record<string, { past: string; one: string; many: string }> = {
  Read: { past: 'read', one: 'file', many: 'files' },
  Bash: { past: 'ran', one: 'shell command', many: 'shell commands' },
  Edit: { past: 'edited', one: 'file', many: 'files' },
  Write: { past: 'wrote', one: 'file', many: 'files' },
  NotebookEdit: { past: 'edited', one: 'notebook', many: 'notebooks' },
  Glob: { past: 'searched', one: 'pattern', many: 'patterns' },
  Grep: { past: 'searched', one: 'pattern', many: 'patterns' },
  LS: { past: 'listed', one: 'directory', many: 'directories' },
  WebFetch: { past: 'fetched', one: 'page', many: 'pages' },
  WebSearch: { past: 'searched', one: 'query', many: 'queries' },
  Agent: { past: 'ran', one: 'subagent', many: 'subagents' },
  Workflow: { past: 'ran', one: 'workflow', many: 'workflows' },
  Skill: { past: 'used', one: 'skill', many: 'skills' },
  ToolSearch: { past: 'loaded', one: 'tool', many: 'tools' },
  // LIMIT: a phrase is chosen from a COUNT, never from the call's input, so the rare
  // non-publishing form (`action: "list"` — 1 of 31 real calls) is still phrased as a publish.
  Artifact: { past: 'published', one: 'artifact', many: 'artifacts' },
};

/**
 * The bucket a tool name is counted under: an MCP tool counts as its SERVER, so `get_issue` plus
 * `list_comments` read as "2 linear calls" instead of two separate one-off phrases.
 */
export function activityBucket(name: string): string {
  if (!name.startsWith('mcp__')) return name;
  const server = name.split('__')[1];
  return server ? 'mcp:' + server : 'mcp';
}

function phrase(bucket: string, n: number): string {
  const w = WORDS[bucket];
  if (w) return `${w.past} ${n} ${n === 1 ? w.one : w.many}`;
  // Unmapped tool (an MCP server, or a tool seedeep has no word for): name it and count it,
  // rather than invent a verb for something whose semantics we do not know.
  const label = bucket.startsWith('mcp:') ? bucket.slice(4) : bucket;
  return `${n} ${label} call${n === 1 ? '' : 's'}`;
}

/**
 * The one line NOW shows while the agent works without speaking: what it has done since its last
 * word, past tense, biggest family first and at most {@link MAX_FAMILIES} of them (an ellipsis
 * stands for the rest). Returns '' when there is nothing to say, which the panel reads as "keep
 * quoting the agent". What is running RIGHT NOW is not in the line — it is the panel's age chip.
 */
export function activityLine(counts: Record<string, number>): string {
  const merged = new Map<string, number>();
  for (const [name, n] of Object.entries(counts)) {
    const b = activityBucket(name);
    merged.set(b, (merged.get(b) ?? 0) + n);
  }
  // Biggest first; ties by name so the line is stable across renders (a jittering order would
  // read as new activity when nothing changed).
  const ranked = [...merged.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (!ranked.length) return '';
  const shown = ranked.slice(0, MAX_FAMILIES);
  let s = shown.map(([b, n]) => phrase(b, n)).join(', ');
  s = s.charAt(0).toUpperCase() + s.slice(1);
  return ranked.length > shown.length ? s + '…' : s;
}

/** What the NOW state is saying, which is also which VOICE says it: `waiting`, `activity` and
 * `working` are seedeep counting, `intent` and `output` are the agent's own words. */
export type NowKind = 'waiting' | 'activity' | 'intent' | 'output' | 'working';

/** Everything the NOW state is decided from. The caller supplies `wordSeenAt` because only an
 * OBSERVER knows when a word reached it — the reducer has no clock, and the line's own timestamp
 * is 7-9s older than the moment the line becomes readable. */
export interface NowInput {
  /** What the session is blocked on, when it is the human it waits on — `pendingInput`. */
  waiting: 'permission' | 'input' | null;
  /** The call the approval is for, when the transcript names it. */
  pendingTool: { name: string; arg: string | null } | null;
  /** When the session stopped on the user (epoch ms), for the waiting age. */
  waitingSince: number | null;
  /** The turn is running AND its session is open — what makes a narration a `now` and not an
   * `intent`, and what makes an age worth ticking. */
  live: boolean;
  /** The turn's final answer, raw. Takes over from the narration the moment it exists. */
  result: string | null;
  /** The turn's latest mid-turn narration, raw. */
  narration: { ts: string; text: string } | null;
  /** Timestamp of the turn's last word — narration OR result, whichever came last. */
  wordTs: string | null;
  /** When THIS observer first saw {@link wordTs} (epoch ms), or null if it never has. */
  wordSeenAt: number | null;
  /** What the turn has done since its last word. */
  activity: { counts: Record<string, number>; open: { name: string; startedTs: string }[] } | null;
  /** Work this turn handed to an agent that is STILL running — a forked skill (`/code-review`) or
   * a background subagent. Its `since` is the agent's own launch, not the turn's. */
  delegated: { label: string; since: number | null; count: number } | null;
  /** An agent this turn launched that has already RETURNED, while the turn itself has still said
   * nothing. Measured over 321 real returns: the parent transcript then stays silent a median 11s
   * (p90 33.1s, max 4m 5s) while Claude Code works on the result — the window seedeep drew as
   * "everything finished". `at` is when it returned. */
  returned: { label: string; at: number | null } | null;
  /** API calls the turn has made. Only 0 vs >0 matters: it separates "the prompt has not reached
   * the model yet" from "the model is answering and has simply not said anything". */
  apiCalls: number;
  /** When the turn opened (epoch ms) — the age of a turn that has neither spoken nor acted. */
  startedAt: number | null;
}

/** The one thing NOW says, ready to draw: a label, a text, and the instant an age counts from
 * (null when the state carries no age). */
export interface NowState {
  kind: NowKind;
  label: string;
  text: string;
  ageFrom: number | null;
}

/** A word first seen this long after its own timestamp did not arrive while we were watching, so
 * it earns no hold: opening seedeep on a session whose agent last spoke five minutes ago must show
 * what it is DOING, not replay an old line as if it were news. */
export const WORD_ARRIVES_LIVE_MS = 60_000;

/**
 * What NOW says about a turn, for EVERY surface that shows it — the browser's panel and the tray's
 * row through the digest. Returns null when there is nothing to say (no word, nothing done), which
 * a surface reads as "draw no NOW at all" rather than as a placeholder.
 *
 * The precedence, in order:
 * 1. **waiting** — the agent is not doing anything, it is stopped on the user.
 * 2. **activity** — what the turn has DONE outranks what it SAID, but only once the words have had
 *    their moment: a narration holds NOW for as long as that particular word takes to READ
 *    ({@link narrationHoldMs}), counted from when it was SEEN.
 * 3. **output / intent** — the turn's final answer, or the latest narration standing in until it
 *    exists.
 *
 * It lives in `core/` because neither client can borrow the other's answer: the browser recomputes
 * NOW on its own ticker (the hold expires at an instant no event announces) and the tray links no
 * seedeep code at all, so it can only be TOLD. One function called from both sides is the only
 * shape in which changing the rule changes both surfaces — which is the whole point of it.
 */
export function nowLine(input: NowInput, nowMs: number): NowState | null {
  if (input.waiting !== null) {
    const what = input.waiting === 'permission' ? 'Waiting for your approval' : 'Waiting for your answer';
    const tool = input.pendingTool;
    return {
      kind: 'waiting',
      label: 'waiting for you',
      text: tool ? `${what} — ${tool.name}${tool.arg ? ' · ' + tool.arg : ''}` : `${what} in the terminal`,
      ageFrom: input.waitingSince,
    };
  }
  const full = input.result ?? input.narration?.text ?? null;
  const stamped = input.wordTs === null ? NaN : Date.parse(input.wordTs);
  const arrivedLive =
    input.wordSeenAt !== null && !Number.isNaN(stamped) && input.wordSeenAt - stamped < WORD_ARRIVES_LIVE_MS;
  // Measured on the RAW markdown, not on the stripped text a surface draws: the markers inflate it
  // by a character or two, which can only lengthen a short hold, and anything long is capped by the
  // two-line clamp anyway.
  const wordIsFresh = arrivedLive && nowMs - input.wordSeenAt! < narrationHoldMs(full ?? '');
  if (input.activity && !wordIsFresh) {
    return {
      kind: 'activity',
      label: 'now',
      text: activityLine(input.activity.counts),
      // The age times the CALL that is running, not the group: it answers "is something still
      // going, and for how long". Absent on a settled turn, where nothing is running to time.
      ageFrom: input.live ? runningSince(input.activity.open, nowMs) : null,
    };
  }
  if (full === null) return working(input);
  const showingResult = input.result !== null;
  return {
    kind: showingResult ? 'output' : 'intent',
    label: showingResult ? 'output' : input.live ? 'now' : 'intent',
    text: full,
    // Meaningful only for a LIVE narration: a final output is not something still going, and a
    // settled turn's words are history.
    ageFrom: input.live && !showingResult && input.narration ? tsOrNull(input.narration.ts) : null,
  };
}

/**
 * What NOW says about a turn that has said nothing and done nothing — seedeep's own voice, because
 * there are no words of the agent's to quote. The last resort of {@link nowLine}, and the reason a
 * working turn is never mute.
 *
 * Measured over 3064 real turns: 12.3% run the model and yield NOTHING but their final answer
 * (median 22.1s, p90 46.9s), every turn is silent for a median 9.6s before its first narration or
 * tool call, and a turn that delegates to a forked skill stays silent for as long as that skill
 * runs (12m 33s, worst measured). All three returned null, which every surface draws as no panel.
 *
 * Returns null for the one honest silence: a turn that is not running. A local built-in (`/clear`,
 * `/model` — 361 of those 3064, all closing in 0s) never called the model and has nothing
 * happening to report, and a settled turn is not a "now" at all.
 *
 * The `apiCalls === 0` line is the defence, not the common case: a caller reaches it only by
 * reporting a turn as live before its first call, which the reducer's presented state does not do
 * today. It once WAS reachable and wrong — the reducer counted a traceless launch as delegated
 * while `delegatedWork` (rightly) did not, and the panel announced a started round over a launch
 * the Subagents card called `unknown`. That is fixed where it belonged, in
 * the two definitions of "running", and this branch stays because the two surfaces compute `live`
 * separately: a line that is right only while a caller upholds an invariant it never states is the
 * coupling this file exists to avoid.
 *
 * LIMIT: nothing here fills the first ~10s of a turn (p50 10.2s to its first API call), because no
 * surface calls a turn live before then. Visible, but a tenth of the silences this closes.
 */
function working(input: NowInput): NowState | null {
  if (!input.live) return null;
  const r = input.returned;
  if (r && !input.delegated) {
    return {
      kind: 'working',
      label: 'now',
      // What is true and nothing more: the agent is back, the turn has not spoken. What the
      // session does with the result is not on disk yet — Claude Code writes a thinking block only
      // when it closes, which is the whole reason this window looks empty.
      text: `${r.label} returned — working on the result`,
      ageFrom: r.at,
    };
  }
  const d = input.delegated;
  if (d) {
    return {
      kind: 'working',
      label: 'now',
      // Named while there is one name to give; counted past that, rather than crowning one of
      // several as the thing that is happening.
      text: d.count > 1 ? `${d.count} agents running in the background` : `${d.label} is running in the background`,
      // The AGENT's age, not the turn's: the turn may have opened long before it delegated.
      ageFrom: d.since,
    };
  }
  return {
    kind: 'working',
    label: 'now',
    // "Waiting" is reserved for the OPPOSITE state — the session stopped on the user — so it
    // cannot also mean the agent is working (product call, 2026-08-03). This one states the fact
    // and takes no position on what the model is doing: seedeep does not read thinking blocks.
    text: input.apiCalls > 0 ? 'Answering — no tools used, nothing said yet' : 'Started — no output yet',
    ageFrom: input.startedAt,
  };
}

function tsOrNull(ts: string): number | null {
  const t = Date.parse(ts);
  return Number.isNaN(t) ? null : t;
}

/** Silent reading speed, characters per second. The rate the panel's own 12s constant already
 * implied (it called a 186-character narration "~11s of reading"), kept rather than re-derived. */
export const READING_CHARS_PER_S = 17;

/** How much of a narration the panel can show at once. Measured against the real CSS in Chrome at
 * a 1440px viewport: `.nowtext` is 828px wide at 14.72px type, ~6.89px per character of real prose
 * — ~120 characters a line, and `-webkit-line-clamp:2` allows two of them. Past this the text is
 * behind `more`, so no amount of holding lets the reader see it inline.
 * LIMIT: measured at ONE width. A narrower window fits fewer characters, so the ceiling over-holds
 * there; the panel would have to report its own measured width to fix that. */
export const VISIBLE_CHARS = 240;

/** Floor on the hold: a three-word narration reads in a fifth of a second, and without this the
 * panel would swap to the activity group before the eye had landed on it. Binds on 8.3% of real
 * narrations (measured over 9020). */
export const HOLD_MIN_MS = 3_000;

/**
 * How long the agent's last word keeps the NOW panel before the activity group may take over: the
 * time it takes to READ that word, floored at {@link HOLD_MIN_MS} and capped by the two-line clamp
 * ({@link VISIBLE_CHARS} — holding longer cannot reveal more). Returns 0 for no text: nothing to
 * read, nothing to hold.
 *
 * This replaced a flat 12s, which the corpus showed was wrong in both directions — 60% of real
 * narrations are read in less (median 6.1s of dead time, during which the panel was hiding work
 * already under way) and the rest were cut off mid-line.
 */
export function narrationHoldMs(text: string): number {
  if (!text) return 0;
  const readable = Math.min(text.length, VISIBLE_CHARS);
  return Math.max(HOLD_MIN_MS, (readable / READING_CHARS_PER_S) * 1000);
}

/**
 * The call the age chip should time: the OLDEST still-open call that has been running at least
 * {@link RUNNING_AFTER_MS}, or null when nothing qualifies (measured: 78.6% of a group's life) —
 * in which case the panel shows no age at all.
 */
export function runningSince(open: { name: string; startedTs: string }[], nowMs: number): number | null {
  let oldest: number | null = null;
  for (const c of open) {
    const t = Date.parse(c.startedTs);
    if (Number.isNaN(t) || nowMs - t < RUNNING_AFTER_MS) continue;
    if (oldest === null || t < oldest) oldest = t;
  }
  return oldest;
}

// Claude Code's sentence about a background command: `Background command "<description>" <fate>`,
// where the fate is the tail (`failed with exit code 144`, `was stopped`, `completed (exit code
// 0)`). Verified on 94 real notifications across 868 sessions — every one takes this shape.
//
// The NAME is not a safe field to parse: a launch with no `description` is named by the command
// itself (4 of 120 real launches), which brings its own quotes and newlines. So the anchor is the
// FATE — generated, single-line, and always last: `[\s\S]*` backtracks to the final `" <fate>` at
// the end of the string, which is the only position the sentence guarantees.
const BACKGROUND_SUMMARY_RE = /^(Background command\s+"[\s\S]*")\s+(\S[^\n]*)$/;

// Claude Code HTML-escapes the text it quotes (`&amp;&amp;`, `&lt;&lt;`) and every surface prints
// this line as TEXT, so the entities reached the screen verbatim. One pass, left to right: a
// literal `&` in the command arrives as `&amp;amp;` and must decode to `&amp;`, never to `&`.
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
const unescapeEntities = (s: string): string => s.replace(/&(amp|lt|gt|quot|apos|#39);/g, (m, k) => ENTITIES[k] ?? m);

/**
 * A background command's summary, reordered so its FATE leads.
 *
 * The words stay Claude Code's, verbatim; only the order changes, because the row that shows this
 * truncates on the right and the fate — the one thing the row cannot deduce, and the only place
 * the exit code exists — sits at the end of CC's sentence. Left as written, `failed with exit code
 * 144` is exactly what the ellipsis eats.
 *
 * Returns the summary unchanged (bar its entities) when it does not take the known shape: Claude
 * Code owns this text and may reword it, and a summary shown whole is always better than one
 * mangled by a stale regex.
 *
 * Entities are decoded AFTER the split, never before: `&quot;` would otherwise become a quote the
 * name/fate anchor could land on.
 */
export function outcomeLine(summary: string): string {
  const m = BACKGROUND_SUMMARY_RE.exec(summary.trim());
  return m ? `${unescapeEntities(m[2]!)} · ${unescapeEntities(m[1]!)}` : unescapeEntities(summary);
}
