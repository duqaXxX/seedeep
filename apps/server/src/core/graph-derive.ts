// Pure derivation for the Graph: snapshot data in, a string or a classification out.
// Nothing here touches the DOM or createGraph's closure, which is the whole point —
// these carry rules that were expensive to establish (turn numbering, the workflow
// silence threshold, what "running" means on a dead session) and were previously
// reachable only by mounting the entire bento. They are unit-testable on their own.
//
// Session-dependent state that used to come from the closure (`ended`, the clock) is a
// PARAMETER here. That is what makes the rules testable without a live session.

import { type AgentNode, hasStarted, type TreeSnapshot, type TurnNode } from './session-tree.ts';
import { entryText, formatToolMs, modelFamily } from './tree-format.ts';

// How long a Workflow run may write NOTHING before it is reported `unknown` rather than
// `running`. Measured, not guessed: across 7 real runs the longest silence inside a live run
// is 113s (p99 gaps 2.7–16.7s), so this leaves ~2.7x headroom. See displayState() for why a
// run — unlike a subagent — has no terminal signal to wait for.
export const WF_SILENT_MS = 300_000;

/** A tool's duration; on an ended session a still-open tool reads "cut off", not blank. */
export function toolDuration(ms: number | null, ended: boolean): string {
  return ms == null && ended ? 'cut off' : formatToolMs(ms);
}

/**
 * What a subagent's state should SAY, which is not always what the reducer saw.
 *
 * The reducer reports what it SAW: `running` means "launched, no terminal signal". On a live
 * session that is the truth. On an ENDED one it means the signal never came (measured 2026-07-29:
 * 3 of 1327 subagents, 0.2%) — so it is not running, it is unknown, and saying
 * "running" about a dead session would be the same class of lie the old code told about
 * "done". Only the view layer knows the session is closed, which is why the mapping lives here.
 *
 * A KILLED workflow is the one case with NO terminal signal anywhere: Claude Code writes
 * `<status>killed</status>` for a subagent but nothing at all for a run (verified on a real
 * kill: no notification, empty task output, journal frozen on its `started` lines). Silence
 * is the only evidence left, so a run that has written nothing for WF_SILENT_MS is reported
 * as unknown — seedeep does not claim it died, it says it stopped hearing from it. It is
 * deliberately per-RUN: a single subagent can legitimately go quiet for 23min, but a run's
 * agents write as one merged stream. Derived, never latched — one new line and it is
 * `running` again, so a false unknown heals itself.
 */
export function displayState(a: AgentNode, ended: boolean, now: number = Date.now()): string {
  if (a.state !== 'running') return a.state;
  if (ended) return 'unknown';
  if (a.kind === 'workflow' && a.workflow?.lastActivityAt) {
    if (now - a.workflow.lastActivityAt > WF_SILENT_MS) return 'unknown';
  }
  // A launch with nothing behind it. Measured 2026-07-29 over 910 ended sessions, this is what
  // every one of the 3 never-ended subagents looks like — no type, no tool, no text — while
  // 92.8% of the ones that do end carry their own final text. Saying `running` about it claims
  // work nobody has any record of. Like the workflow rule above it is DERIVED, never latched:
  // one line from the agent and it is `running` again, so a false unknown heals itself.
  if (a.kind === 'subagent' && !hasStarted(a)) return 'unknown';
  return 'running';
}

/**
 * What a turn has running ELSEWHERE, for the NOW panel to say when the turn itself says nothing:
 * the agents it launched that are still running, named and timed by the FIRST of them. Null when
 * none is.
 *
 * Here, beside {@link displayState}, because it must answer with the very same rule the Subagents
 * card answers with — a panel claiming `/code-review is running` next to a card reading `0 running`
 * is one screen asserting both, and that is the bug this function's placement prevents. It is also
 * why the reducer does not compute it: only a view knows whether the session is over.
 */
export function delegatedWork(
  turnIndex: number,
  subs: readonly AgentNode[],
  ended: boolean,
  now: number = Date.now(),
): { label: string; since: number | null; count: number } | null {
  let out: { label: string; since: number | null; count: number } | null = null;
  for (const a of subs) {
    if (a.turnIndex !== turnIndex || displayState(a, ended, now) !== 'running') continue;
    const parsed = a.startedAt ? Date.parse(a.startedAt) : Number.NaN;
    const since = Number.isNaN(parsed) ? null : parsed;
    if (!out) out = { label: a.title, since, count: 1 };
    else {
      out.count++;
      // The one NAMED is the one that started first, so a second launch does not rename the line
      // under the reader mid-run.
      if (since !== null && (out.since === null || since < out.since)) {
        out.since = since;
        out.label = a.title;
      }
    }
  }
  return out;
}

/**
 * The turn is WORKING, which the transcript alone cannot answer.
 *
 * A turn is live in the reducer once it has burnt a token or delegated. Between those moments the
 * parent transcript says nothing at all — Claude Code flushes a thinking block only when it CLOSES
 * — and the two windows are not short: measured over 321 real agent returns, the parent stays
 * silent a median 11s and up to 4m 5s after a background agent comes back, and every turn is mute
 * for a median 10.2s before its first API call. Drawn from the transcript alone, seedeep called
 * that "finished" while Claude Code was visibly thinking.
 *
 * So the authority for "right now" is the PROCESS, not the file — the same source that already makes the
 * session's own liveness read from. `busy` is `isModelBusy(rec)` — `status === 'busy'` and NEVER
 * `shell`, which Claude Code writes for a turn that is already OVER while a command it launched
 * keeps running; counting it here marks every finished turn live. (The tab dot reads `isWorking`,
 * which does count `shell`: the SESSION is busy then, the turn is not.) It only ever applies to the LAST turn: an older
 * entry is history whatever the process is doing.
 */
export function turnIsWorking(
  turn: Pick<TurnNode, 'state'>,
  isLast: boolean,
  session: { ended: boolean; busy: boolean },
): boolean {
  if (session.ended) return false;
  // Esc is a fact about the transcript and outranks the process: a turn the user stopped is not
  // working, however busy the session looks while it starts on something else. Guarded HERE so
  // every surface agrees — the digest refused to overwrite `interrupted` on the state while its
  // own `now` still said "working" about the same turn.
  if (turn.state === 'interrupted') return false;
  return turn.state === 'live' || (isLast && session.busy);
}

/**
 * The agent this turn launched that has RETURNED most recently, for the window between its return
 * and the turn's first word of its own. Null when the turn launched none, or when one is still
 * running — that case is {@link delegatedWork}'s, and it outranks this one.
 */
export function returnedWork(
  turnIndex: number,
  subs: readonly AgentNode[],
  ended: boolean,
  now: number = Date.now(),
): { label: string; at: number | null } | null {
  let best: { label: string; at: number | null } | null = null;
  for (const a of subs) {
    if (a.turnIndex !== turnIndex) continue;
    // Only a TERMINAL state is a return. `unknown` is a launch nobody has a record of — a sidecar
    // not read yet, a workflow gone silent — and calling that "returned" announced the result of an
    // agent that had just started, for as long as it left no trace.
    const state = displayState(a, ended, now);
    if (state === 'running' || state === 'unknown') continue;
    // Its end is its start plus what it took — the only two facts recorded about a child's life.
    const started = a.startedAt ? Date.parse(a.startedAt) : Number.NaN;
    const at = !Number.isNaN(started) && a.durationMs != null ? started + a.durationMs : null;
    if (!best || (at !== null && (best.at === null || at > best.at))) best = { label: a.title, at };
  }
  return best;
}

/**
 * The timeline entry's modifier class: interrupted / compaction / local / live, else none.
 *
 * `working` is {@link turnIsWorking}'s answer for this entry — passed in rather than read off
 * `state`, because the transcript goes quiet while Claude Code thinks and the strip must not call
 * an entry finished while the panel above it says it is working.
 */
export function turnCls(t: TurnNode, working = t.state === 'live'): string {
  if (t.state === 'interrupted') return 'esc';
  if (t.kind === 'context' || t.compaction) return 'cmp';
  if (t.kind === 'local') return 'loc';
  if (working) return 'lv';
  return '';
}

/**
 * An entry that has moved the context by nothing — a /clear, a /model, or a prompt you just
 * sent whose first token hasn't landed yet — has a zero delta and would render as a
 * zero-height bar, i.e. as nothing at all. Marked so it can be drawn as a visible tick.
 */
export function isMarker(t: TurnNode): boolean {
  return t.deltaFill === 0;
}

/**
 * A command's arguments ARE its prompt, but on their own they are cryptic — "opus" tells
 * you nothing, "/model opus" tells you everything. Prefix the command that carried them
 * (unless the prompt already IS the command, as for an argument-less /clear).
 */
export function entryLabel(t: TurnNode, max = 200): string {
  return entryText(t.prompt, t.command, max);
}

/**
 * The timeline is indexed by ENTRY (everything you sent), but a work turn is numbered by
 * its position among work turns — otherwise "Turn 13 / 11" happens. One helper, so the
 * banner and the feed can never disagree about which turn you are looking at.
 */
export function workOrdinal(fullSnap: TreeSnapshot, turn: TurnNode): number {
  return fullSnap.turnList.filter((t) => t.kind === 'work').findIndex((t) => t.index === turn.index) + 1;
}

/** How a scoped entry names itself: "Turn 7" for work, "/model" for anything else. */
export function entryTitle(fullSnap: TreeSnapshot | null | undefined, turn: TurnNode | null | undefined): string {
  if (!turn || !fullSnap) return '';
  return turn.kind === 'work' ? 'Turn ' + workOrdinal(fullSnap, turn) : '/' + (turn.command ?? 'entry');
}

/**
 * The session's final answer: the LAST entry that produced one, or null when none did.
 *
 * Deliberately not `turnList.at(-1)?.result` — measured over 106 real sessions, 4 end on an
 * entry that answers nothing (a `/clear`, a compaction), and their final answer is the one
 * before it. 8 hold no result at all, which is the null: no answer, nothing to offer.
 */
export function finalResultTurn(fullSnap: TreeSnapshot | null | undefined): TurnNode | null {
  if (!fullSnap) return null;
  for (let i = fullSnap.turnList.length - 1; i >= 0; i--) {
    const t = fullSnap.turnList[i];
    if (t?.result) return t;
  }
  return null;
}

/** Long model id → its family ('Opus'), except fable ids which are shown verbatim. */
export function shortModel(m: string | null | undefined): string {
  if (!m) return '';
  const fam = modelFamily(m);
  return fam === 'fable' ? m : (fam ?? m);
}

/**
 * Model id for the surfaces that name the SESSION's or a TURN's model ('claude-opus-4-8'
 * → 'opus-4-8'). Deliberately NOT shortModel: the version is what decides the context
 * window (opus-4-8 is 1M, opus-4-5 is 200k), so collapsing it to the family would drop
 * the very digit that explains the denominator. '' for a null model, so a caller can
 * render nothing rather than a placeholder.
 */
export function modelLabel(m: string | null | undefined): string {
  return m ? m.replace(/^claude-/, '') : '';
}
