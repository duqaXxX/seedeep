import { windowFor } from './context-windows.ts';
import type { AgentNode, TreeSnapshot, TurnNode } from './session-tree.ts';
import { isScratchPath } from './text.ts';
import type { Baseline, Bucket } from './types.ts';

// The post-turn verdict: DETERMINISTIC detectors (zero LLM) run over one turn's data (already in
// the snapshot) and produce a worst-of severity + a list of findings, plus the POSITIVES — what
// the turn did that a public Anthropic source prescribes. The severity drives the Timeline column
// marker + the crit toast; findings and positives fill the Verdict lens.
//
// Every detector below carries a quote from code.claude.com/docs. A rule defensible only by one
// user's private CLAUDE.md is a rule written for one user, and seedeep ships to other people.
//
// A turn's tokens are split before they are judged: what it spent RE-ENTERING its context
// (`turnResumeCost`) is not what it spent working (`turnWork`).
//
// No detector compares a turn to the user's OTHER turns. One did until 2026-07-27 and was removed
// (see {@link bucketFor}): a percentile over a single user's history reports how BIG a turn was,
// and size is not waste. That also fixes the validation trap it created — a rule justified by how
// often it fires on one corpus is a rule fitted to one person. What justifies a detector here is
// the anchor; what the corpus can prove is only that a rule fires correctly and stays silent on
// correct behaviour. When the corpus contains no instance of the anti-pattern at all — which is
// the normal case for a disciplined user — a synthetic fixture carries that proof instead.

export type Severity = 'good' | 'warn' | 'crit';
export type Detector =
  | 'wasted-subagent'
  | 'compaction'
  | 'esc'
  | 'resume'
  | 'context'
  | 'exploration'
  | 'unverified-ship';
/** What a turn did RIGHT — the verdict's second face. Never changes a severity. */
export type Practice = 'verified' | 'delegated' | 'reviewed';

export interface Finding {
  kind: Detector;
  severity: 'warn' | 'crit';
  /** One-line, human-readable (English UI). */
  text: string;
  /**
   * Optional cost hint, e.g. "17.0k" or "3.1×".
   *
   * INVARIANT: when it is an ABSOLUTE token amount, it must be a PORTION of this turn's
   * `turnBillable` — the share card sums the absolute costs and divides by that billable, so
   * anything else prints a nonsense percentage. Measured before the rule existed: 54% of flagged
   * turns printed over 100% of the turn, up to 122 097%. A figure that is not this turn's spend
   * (a context SIZE, a subagent's own volume, a cross-turn tail) belongs in {@link text}; a
   * relative figure ("3.1×", "77% of the turn") is fine, the card's parser skips it.
   */
  cost?: string;
}
export interface Positive {
  kind: Practice;
  /** One-line, human-readable (English UI). */
  text: string;
}
export interface TurnVerdict {
  severity: Severity;
  findings: Finding[];
  /** Documented practices this turn followed. Empty is the common case; never affects severity. */
  positives: Positive[];
}

const WASTED_OUTLEN = 5000; // chars a subagent dumped back into main (heuristic — see LIMIT below).
// Reads that make a no-edit turn an "infinite exploration". Measured over 2864 real turns, Read
// calls per turn run p50=0, p90=5, p95=8, p99=21 — so 8 is the tail, not a cliff, and the docs'
// own "hundreds of files" never happens locally (max 55). 8/10/15 flag 15/10/3 turns once the
// no-edit condition is applied; the set barely moves, so the threshold is not load-bearing.
const EXPLORE_READS = 8;
// A cold resume: the turn's first call had to RE-CREATE nearly the whole prompt it ran on.
// Both bounds matter and neither is arbitrary — measured over 2788 real closed work turns
// (2026-07-25): the first call's cache_creation is bimodal, median 168 tokens against a median
// of 143 891 on the turns that rebuild, so the SHARE separates the two populations and the token
// floor only keeps "rebuilt a tiny context" out. Between the 50k floor and a 20k one the hit set
// moves by 27 turns; between share 0.8 and 0.9 by 29. The rule is not sitting on a cliff.
const RESUME_MIN_TOKENS = 50_000;
const RESUME_MIN_SHARE = 0.8;
// "Most best practices are based on one constraint: Claude's context window fills up fast, and
// performance degrades as it fills. […] The context window is the most important resource to
// manage." — code.claude.com/docs/en/best-practices. 70% is where the guide's own remedies start
// ("/clear between unrelated tasks", "delegate large reads"); measured, 60/70/80% flag
// 11.9/5.8/1.8% of turns, so 70 is the knee, not a cliff.
const CONTEXT_FILL_WARN = 0.7;

// A check Claude can read the result of. The list is the source's own: "a test suite, a build exit
// code, a linter, a script that diffs output against a fixture, or a browser screenshot compared
// against a design" — code.claude.com/docs/en/best-practices.
const VERIFY_RE =
  /\b(test|pytest|jest|vitest|bun test|npm test|go test|cargo test|tsc|typecheck|lint|eslint|ruff|mypy|make |gradle|mvn |build|playwright|curl -s?I?\s|screenshot)\b/i;
const COMMIT_RE = /\bgit\s+(commit|push)\b/;
const CODE_RE = /\.(ts|tsx|js|jsx|py|go|rs|java|rb|php|c|h|cpp|sh|sql|css|vue|svelte)$/i;
// A prototype written to a scratchpad is not code being shipped — reading 8 hits of the loose
// "changed files, no check" rule left 1 standing, and throwaway files were half the false ones.
// That exclusion used to be a word match (`scratch|prototypes?|/tmp/`) over the tool arg, which
// also caught project code merely NAMED like a throwaway (`src/prototypes/`). It now asks
// `isScratchPath`, the same predicate the Changed files widget uses, so one definition answers
// "is this a temporary?" everywhere. Measured before switching: of 4743 real Write/Edit calls on
// code files, the word match excluded 289 and the token match 263 — the 26 it stops excluding are
// all `prototypes/` paths, and re-running the real pipeline over all 34 sessions that touch such a
// path produced the SAME 43 `verified` positives over 588 turns. Zero visible change.
// LIMIT: matched against the subagent's resolved title, i.e. free text. It is the ONLY
// language-matched rule in this file, and it is deliberately confined to a POSITIVE: the
// structural alternatives have no coverage (`agentType` is null on every spawn measured, and a
// review asked for in prose records no `command`), and a 10% over-credit on a positive is cheap
// where the same fuzziness on a penalty would not be.
// `check` is deliberately NOT here: measured, it credited 14 of 151 turns whose subagent was a
// lookup, not a review ("Check the docs index headings", "Check latest Claude Code version on
// npm"). `verif` stays unbounded because this user's spawns are often Italian ("Verifica …").
const REVIEW_RE = /review|verif|audit/i;

/** Tokens a turn spent that were NOT cheap cache re-reads: input + output + cache_creation. */
export function turnBillable(t: TurnNode): number {
  return t.inputTotal + t.out + t.cacheTotals.created;
}

/**
 * Tokens the turn spent RE-ENTERING its own context instead of working: its first call's
 * `cache_creation`, when that call rebuilt at least {@link RESUME_MIN_SHARE} of the prompt it ran
 * on and the rebuild was at least {@link RESUME_MIN_TOKENS}. 0 when nothing was re-created, or
 * when the reducer says a rebuild was expected (session's first call, or a compaction reset the
 * window — both re-create the prompt by design).
 *
 * Anchor: "your first message after a break longer than the cache lifetime misses the cache and
 * reprocesses your full context" — code.claude.com/docs/en/costs.
 *
 * Measured on the local corpus: this fires on 4.9% of closed work turns and accounts for 27% of
 * all billable tokens — the median hit re-creates 143k tokens, which is 92% of that turn's own
 * cost. It is what makes a two-command turn cost 450k.
 */
export function turnResumeCost(t: TurnNode): number {
  const c = t.firstCall;
  if (!c || t.rebuildExpected || c.fill <= 0) return 0;
  if (c.cacheCreation < RESUME_MIN_TOKENS) return 0;
  return c.cacheCreation / c.fill >= RESUME_MIN_SHARE ? c.cacheCreation : 0;
}

/**
 * Tokens a turn spent on WORK: {@link turnBillable} minus what it paid to re-enter its context.
 * This — not the raw billable — is what the personal baseline is built from, because a resume
 * cost inflates BOTH sides: it makes a turn of 6 tool calls look like heavy work, and it lifts
 * the percentile the others are placed against.
 *
 * A compaction's tail (the next turn's rebuild, see {@link compactionCost}) is deliberately NOT
 * subtracted here: it is reported as the compaction's cost, not removed from the turn that pays
 * it. That is a product decision, taken 2026-07-27.
 */
export function turnWork(t: TurnNode): number {
  return turnBillable(t) - turnResumeCost(t);
}

/**
 * What a mid-turn compaction really cost: the tokens it re-created inside its own turn PLUS the
 * rebuild the FOLLOWING turn pays on its first call, since compaction "invalidates the
 * conversation layer" and the next request no longer shares a prefix
 * (code.claude.com/docs/en/prompt-caching). `next` is the next closed work turn, or null when the
 * session ended on the compaction — then only the first term is known.
 *
 * Measured over 61 real compaction turns: median 49 577 in the turn, 28 121 on the next turn's
 * first call, against 119 on an ordinary turn. The tail is 36% of the total and, before this,
 * nothing attributed it.
 */
export function compactionCost(turn: TurnNode, next: TurnNode | null): number {
  return turn.cacheTotals.created + compactionTail(turn, next);
}

/**
 * Only the SECOND half of {@link compactionCost}: the rebuild the next turn pays. Split out
 * because the two halves are billed to different turns, and a surface that expresses a cost as a
 * share of ONE turn (the share card) must not divide a cross-turn total by a single turn's
 * billable — measured, that printed "> 100% of the turn" on 39 of 60 real compaction turns.
 */
export function compactionTail(turn: TurnNode, next: TurnNode | null): number {
  return turn.compaction ? (next?.firstCall?.cacheCreation ?? 0) : 0;
}

function kTok(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
}

const MIN_BASELINE = 20; // a percentile from fewer turns than this is noise; report no bucket then.

/**
 * The baseline bucket for a turn's effort, or null when there is no usable one.
 *
 * NO DETECTOR READS THIS. The verdict judged a turn's tokens against this bucket until
 * 2026-07-27, when measuring showed the rule reported SIZE, not waste: flagged turns did ~13× the
 * tokens because they did ~13× the actions (median 38 tool calls against 3), their tokens-per-tool
 * -call was ordinary, and 55% of a turn's token variance is explained by its call count alone. It
 * was also the only detector with no anchor in the public docs, and it had no remedy to offer.
 * The bucket survives as DESCRIPTIVE context — the share card prints p50/p90/p95 so a turn can be
 * placed against the user's own history without being judged for it.
 */
export function bucketFor(baseline: Baseline | null, effort: string): Bucket | null {
  // The argument arrives from `/api/baseline` and is typed, not validated. Reaching straight into
  // `.byEffort` made anything else a TypeError, and the only caller is the Share button, whose
  // catch discards it: no card, no message, and — because the value is memoised for the life of
  // the page — every later share dead too. A shape this cannot read is the case it already
  // handles, which is having no baseline: the card simply omits its scale bar.
  if (!baseline?.byEffort) return null;
  // Compare a turn only against its OWN effort bucket — a `high` turn placed against the overall
  // baseline (98% `unknown`) would read as far larger than it is. Too few turns → no bucket.
  const b = baseline.byEffort[effort];
  return b && b.count >= MIN_BASELINE ? b : null;
}

/**
 * The turn's context fill as a share of its model's window, or null when the window would be a
 * GUESS. Returning null rather than a fallback percentage is the point: 20 turns in the local
 * corpus run on an unmapped model, and a "170% of 200k" on a session actually running at 1M is a
 * fabricated finding, not a conservative one.
 */
export function turnFillShare(t: TurnNode): number | null {
  const { window, estimated } = windowFor(t.models.at(-1) ?? null);
  if (estimated || !window) return null;
  return t.fillEnd / window;
}

/** Per-turn slice of the snapshot the detectors need — built once, not re-scanned per turn. */
interface TurnEvidence {
  /** The first subagent of this turn whose returned output crossed the threshold. */
  bigSub: AgentNode | null;
  /** The first subagent of this turn whose title names a review/verification role. */
  reviewSub: AgentNode | null;
  subs: number;
  reads: number;
  /** Edits/writes of ANY file, scratchpad included — what tells exploring apart from working. */
  edits: number;
  /** The turn committed or pushed. */
  committed: boolean;
  /** The turn ran a check whose result Claude could read. */
  checked: boolean;
  /** The turn edited ≥1 real code file (a scratchpad prototype is not code being shipped). */
  shippedCode: boolean;
}

const EMPTY_EVIDENCE: TurnEvidence = {
  bigSub: null,
  reviewSub: null,
  subs: 0,
  reads: 0,
  edits: 0,
  committed: false,
  checked: false,
  shippedCode: false,
};

/**
 * Index the whole snapshot's tools + subagents by turn in ONE pass.
 * The alternative — every turn filtering `mainTools`/`subagents` itself — is O(turns × tools) and
 * runs on every render while the Timeline strip is open, which at real scale (150 turns, thousands
 * of tools) is the dominant cost of the strip.
 */
function indexEvidence(snap: TreeSnapshot): Map<number, TurnEvidence> {
  const byTurn = new Map<number, TurnEvidence>();
  const slot = (i: number): TurnEvidence => {
    let e = byTurn.get(i);
    if (!e) {
      e = { ...EMPTY_EVIDENCE };
      byTurn.set(i, e);
    }
    return e;
  };
  for (const t of snap.mainTools) {
    if (t.turnIndex === null) continue;
    const e = slot(t.turnIndex);
    if (t.name === 'Read') e.reads++;
    else if (t.name === 'Bash' && t.arg) {
      if (COMMIT_RE.test(t.arg)) e.committed = true;
      if (VERIFY_RE.test(t.arg)) e.checked = true;
    } else if (t.name === 'Edit' || t.name === 'Write' || t.name === 'NotebookEdit') {
      // `edits` counts EVERY write, `shippedCode` only real code: a turn that wrote a scratchpad
      // prototype was not exploring (so #6 must stay quiet) but is not shipping either (so #7
      // must too). One counter cannot answer both questions.
      e.edits++;
      if ((t.name === 'Edit' || t.name === 'Write') && t.arg && CODE_RE.test(t.arg) && !isScratchPath(t.arg))
        e.shippedCode = true;
    }
  }
  for (const a of snap.subagents) {
    if (a.turnIndex === null) continue;
    const e = slot(a.turnIndex);
    e.subs++;
    if (!e.bigSub && a.outLen >= WASTED_OUTLEN) e.bigSub = a; // one is enough to flag the turn
    if (!e.reviewSub && REVIEW_RE.test(`${a.agentType ?? ''} ${a.title ?? ''}`)) e.reviewSub = a;
  }
  return byTurn;
}

/** What the turn's NEIGHBOURS say — the facts a single turn cannot know about itself. */
interface TurnContext {
  /** The previous work turn was also interrupted. */
  prevInterrupted: boolean;
  /** The IMMEDIATELY following work turn — live included, since it is the one that pays a
   * compaction's tail. Skipping it charged the rebuild of a later turn instead, for as long as
   * the session stayed open. */
  next: TurnNode | null;
  /** Any EARLIER work turn in this session ran a check. Only looks backward: a commit is
   * unverified at the moment it happens, and a check run afterwards cannot un-ship it. */
  checkedBefore: boolean;
}
const NO_CONTEXT: TurnContext = { prevInterrupted: false, next: null, checkedBefore: false };

/** The verdict of one turn against evidence already sliced for it. */
function verdictFrom(turn: TurnNode, ev: TurnEvidence, ctx: TurnContext): TurnVerdict {
  const findings: Finding[] = [];

  // 1. Wasted subagent: a subagent returned a large output into main.
  // "Use one when a side task would flood your main conversation with search results, logs, or
  // file contents you won't reference again: the subagent does that work in its own context and
  // returns only the summary." — code.claude.com/docs/en/sub-agents
  // LIMIT: outLen>=5k flags a big returned payload; it cannot prove main never used it. A precise
  // "returned vs actually cited" needs child-file linkage — a v2. This is a deliberate lower bound.
  if (ev.bigSub) {
    const a = ev.bigSub;
    // No `cost`: `a.volume` is what the SUBAGENT burned in its own context window, not what this
    // turn paid, so summing it against the parent's billable printed over 100% on 50 real turns.
    // It stays in the text, where it is a fact rather than an attribution.
    findings.push({
      kind: 'wasted-subagent',
      severity: 'crit',
      text: `subagent ${a.agentType ?? 'agent'}: ${kTok(a.outLen)} chars returned to main${a.volume ? ` (${kTok(a.volume)} tokens in its own context)` : ''}`,
    });
  }

  // 2. Compaction mid-turn — only on a WORK turn (involuntary overflow). A `/compact` the user
  // typed is a deliberate context reset (kind 'context'), not waste, so it must not fire crit.
  // "run `/compact` at a natural break in your work […] instead of waiting for auto-compaction to
  // trigger mid-task" — code.claude.com/docs/en/prompt-caching. The cost carries the tail the next
  // turn pays; see {@link compactionCost}.
  // LIMIT: `cacheTotals.created` sums the WHOLE turn, so a turn that worked before overflowing
  // has its pre-compaction creation folded into this figure. Separating the two needs a per-call
  // split the reducer does not keep; the number is an upper bound on the compaction's own cost.
  if (turn.compaction && turn.kind === 'work') {
    const tail = compactionTail(turn, ctx.next);
    // `cost` carries only what THIS turn paid — the tail is named in the text instead, because a
    // surface that reads `cost` as a share of the turn cannot divide a cross-turn total by it.
    findings.push({
      kind: 'compaction',
      severity: 'crit',
      text: `compaction mid-turn — cache rebuilt${tail > 0 ? `, +${kTok(tail)} on the next turn` : ''}`,
      cost: kTok(turn.cacheTotals.created),
    });
  }

  // 3. Esc — only the SECOND consecutive interruption, never a lone one.
  // "Course-correct early and often. […] correcting it quickly generally produces better solutions
  // faster." A lone Esc is the RECOMMENDED behaviour; the named anti-pattern is the streak:
  // "If you've corrected Claude more than twice on the same issue in one session, the context is
  // cluttered with failed approaches. Run `/clear` and start fresh."
  // — code.claude.com/docs/en/best-practices. Measured: 127 of 176 interrupted turns are lone, so
  // the old rule penalised correct usage on 72% of its own hits. Looking only BACKWARD is
  // deliberate: a turn that is the first of a streak IS a lone Esc at the moment it closes, and a
  // forward-looking rule would make a finding appear retroactively on a turn already rendered.
  if (turn.state === 'interrupted' && ctx.prevInterrupted) {
    // No `cost` either, for the opposite reason: the abandoned tokens ARE the whole turn, not a
    // portion of it, so adding them to any other finding's cost double-counts the same spend.
    findings.push({
      kind: 'esc',
      severity: 'warn',
      text: `interrupted again — second correction in a row, ${kTok(turnBillable(turn))} abandoned`,
    });
  }

  // 4. Cold resume — the turn re-created its context before doing anything.
  const resume = turnResumeCost(turn);
  if (resume > 0) {
    const share = Math.round((100 * resume) / Math.max(1, turnBillable(turn)));
    findings.push({
      kind: 'resume',
      severity: 'warn',
      text: `resumed cold — ${kTok(resume)} tokens re-created before any work`,
      cost: `${share}% of the turn`,
    });
  }

  // 5. Context fill — "performance degrades as it fills". Skipped entirely when the window would
  // be a guess: a fabricated denominator is worse than no finding.
  // The window's SIZE goes in the text, never in `cost`: `cost` means "tokens this finding
  // accounts for", and the share card sums it against the turn's billable. A fill is state, not
  // spend — summed as spend it printed a 122 097% "of the turn" on a real session.
  const fill = turnFillShare(turn);
  if (fill !== null && fill >= CONTEXT_FILL_WARN) {
    findings.push({
      kind: 'context',
      severity: 'warn',
      text: `context ${Math.round(100 * fill)}% full at the end of the turn (${kTok(turn.fillEnd)})`,
    });
  }

  // 6. Infinite exploration — the turn read many files in the main context and shipped nothing.
  // "**The infinite exploration.** You ask Claude to 'investigate' something without scoping it.
  // Claude reads hundreds of files, filling the context. > **Fix**: Scope investigations narrowly
  // or use subagents so the exploration doesn't consume your main context."
  // — code.claude.com/docs/en/best-practices
  // The two conditions are what separate exploring from implementing: a turn that reads a lot
  // WHILE editing is doing the work, not filling the context blindly. Measured over 2872 real
  // turns: `reads >= 8 && subs === 0` alone catches 127 turns with a median of 14 edits
  // (implementation), while adding `edits === 0` leaves 13 (0.5%) — exploration that paid a real
  // cost and delegated none of it.
  // `subs` counts the turn's subagents from the snapshot, NOT `TurnNode.agentIds`: the latter is
  // filled from the agentId→toolUseId link a child's `meta.json` carries, so it is complete only
  // once the children have been replayed (96.6% of turns with a subagent, sampled) — the
  // snapshot's own subagents come from the parent's spawn alone and are there from the first pass.
  // The silence on correct behaviour IS backed by real data: 234 turns delegated without editing,
  // 2 of them also reading ≥8 files — the exact shape the rule must not flag — and it flags none.
  if (ev.reads >= EXPLORE_READS && ev.edits === 0 && ev.subs === 0) {
    findings.push({
      kind: 'exploration',
      severity: 'warn',
      text: `read ${ev.reads} files into the main context and changed nothing — no subagent`,
    });
  }

  // 7. Trust-then-verify gap — the turn shipped real code and NOTHING in the session had run a
  // check the model could read.
  // "**The trust-then-verify gap.** Claude produces a plausible-looking implementation that
  // doesn't handle edge cases. > **Fix**: Always provide verification (tests, scripts,
  // screenshots). If you can't verify it, don't ship it." — code.claude.com/docs/en/best-practices
  // The window is the SESSION, not the turn, and that is the whole rule: measured over 206 real
  // ship events, a per-turn window flagged 14 — and every one of them had run a check in an
  // earlier turn (6 of them in the immediately preceding one). Running the suite and committing
  // in the next turn is correct practice; a per-turn rule punishes it 100% of the time.
  if (ev.committed && ev.shippedCode && !ctx.checkedBefore && !ev.checked) {
    findings.push({
      kind: 'unverified-ship',
      severity: 'crit',
      text: 'committed code with no check run anywhere in this session',
    });
  }

  const severity: Severity = findings.some((f) => f.severity === 'crit') ? 'crit' : findings.length ? 'warn' : 'good';
  return { severity, findings, positives: positivesFrom(ev) };
}

/**
 * The practices a turn followed. Anchored, and deliberately narrow — a positive that fires on
 * everything says nothing. Measured: 6.4% / 11.1% / 5.4% of closed work turns.
 */
function positivesFrom(ev: TurnEvidence): Positive[] {
  const out: Positive[] = [];
  // "Always provide verification (tests, scripts, screenshots). If you can't verify it, don't ship
  // it." — anchored on the SHIP, which is what removes the false positives: nobody commits a
  // scratchpad prototype, and the loose "changed a file without a check" rule read 8 hits and left
  // one standing.
  if (ev.committed && ev.shippedCode && ev.checked)
    out.push({ kind: 'verified', text: 'ran a check before committing' });
  // "Since context is your fundamental constraint, subagents are one of the most powerful tools
  // available. […] Subagents run in separate context windows and report back summaries."
  if (ev.subs >= 1 && ev.reads <= 3) out.push({ kind: 'delegated', text: 'delegated the exploration to a subagent' });
  // "Before treating a task as done, have a subagent review the diff in a fresh context and report
  // gaps." — code.claude.com/docs/en/best-practices
  if (ev.reviewSub)
    out.push({ kind: 'reviewed', text: `had its work reviewed by ${ev.reviewSub.agentType ?? 'a subagent'}` });
  return out;
}

/** Neighbour facts for every closed WORK turn, in one ordered pass over the turn list. */
function contexts(snap: TreeSnapshot, evidence: Map<number, TurnEvidence>): Map<number, TurnContext> {
  // Live turns are KEPT: only the last entry can be live, it can never be `interrupted` (so it
  // cannot fake an Esc streak), and it is exactly the turn that pays an open session's compaction
  // tail. Filtering it out made `next` the turn AFTER it.
  const work = snap.turnList.filter((t) => t.kind === 'work');
  const out = new Map<number, TurnContext>();
  let checkedBefore = false;
  for (let i = 0; i < work.length; i++) {
    out.set(work[i]!.index, {
      prevInterrupted: work[i - 1]?.state === 'interrupted',
      next: work[i + 1] ?? null,
      checkedBefore,
    });
    if (evidence.get(work[i]!.index)?.checked) checkedBefore = true;
  }
  return out;
}

/**
 * Compute a turn's verdict from the snapshot (per-turn tools/subagents). Reads only
 * `snap.mainTools`, `snap.subagents` and `snap.turnList` plus the turn's own fields — never
 * mutates. Takes NO baseline: every detector is now self-contained, judging what the turn did
 * rather than how it compares to the user's other turns (see {@link bucketFor}).
 * For more than one turn use {@link computeVerdicts}: this one re-scans the whole snapshot.
 */
export function computeVerdict(turn: TurnNode, snap: TreeSnapshot): TurnVerdict {
  const evidence = indexEvidence(snap);
  return verdictFrom(
    turn,
    evidence.get(turn.index) ?? EMPTY_EVIDENCE,
    contexts(snap, evidence).get(turn.index) ?? NO_CONTEXT,
  );
}

/**
 * Every turn's verdict, keyed by `turn.index`, from ONE pass over the snapshot. This is the
 * single computation the whole view shares (Verdict lens, flagged columns, scope banner, share
 * card) so no two surfaces can disagree about a turn's severity.
 */
export function computeVerdicts(snap: TreeSnapshot): Map<number, TurnVerdict> {
  const evidence = indexEvidence(snap);
  const ctxs = contexts(snap, evidence);
  const out = new Map<number, TurnVerdict>();
  for (const t of snap.turnList)
    out.set(t.index, verdictFrom(t, evidence.get(t.index) ?? EMPTY_EVIDENCE, ctxs.get(t.index) ?? NO_CONTEXT));
  return out;
}
