/**
 * The three bands — the panel's whole surface once a server answers.
 *
 * Free of Tauri, like `connection.ts`: rows in, DOM out. Everything drawn here comes from one
 * `/api/digest` payload, so the tray parses no transcript and owns no reducer. What it does derive
 * is presentation only: which band a session belongs in, and how long it has been there.
 */
import { renderError, renderFooter, type Status } from './connection.ts';

/**
 * The digest fields the bands read — declared here rather than imported, because the tray links no
 * seedeep code (`CLAUDE.md`: a pure HTTP client of the server's API). The two shapes are held
 * together by a test that assigns a real `DigestEntry` to this type, so a field the server renames
 * fails the typecheck instead of the panel.
 */
export interface DigestEntry {
  sessionId: string;
  project: string;
  subject: string | null;
  /** Claude Code's own word. `shell` = the turn is over but a command it launched in the background
   * is still running — see {@link bandOf}. */
  status: 'busy' | 'idle' | 'waiting' | 'shell' | null;
  /** That status was DERIVED from the transcript, because this session's host publishes none —
   * the desktop app's Code tab, any headless run. Optional: a server older than this field
   * simply omits it, and an absent flag must read as "published", never as a marked row. */
  statusDerived?: boolean;
  waitingFor: string | null;
  waitingSince: number | null;
  lastActivity: number;
  pendingTool: { name: string; arg: string | null } | null;
  main: { fill: number; window: number; pct: number; estimated: boolean; model: string | null };
  turn: {
    /** Live, finished, or stopped by the user. */
    state: 'done' | 'interrupted' | 'live';
    prompt: string;
    efforts: string[];
    /** The one thing to say about the turn right now, decided by the server's `nowLine` — the same
     * function, on the same inputs, that the browser's NOW panel calls. See {@link now}. */
    now: {
      kind: 'waiting' | 'activity' | 'intent' | 'output' | 'working';
      label: string;
      text: string;
      ageFrom: number | null;
    } | null;
  } | null;
  /** Non-null while the session's last model call FAILED and nothing has succeeded since — the
   * server's `TreeSnapshot.error`, so the panel, the icon and the portal's tab strip all read one
   * derivation. `agentId` names a subagent whose call failed. See {@link bandOf}. */
  error: { at: number | null; status: string | null; message: string; agentId: string | null } | null;
  /** `running` is what is at work this second; `launched` is the session's whole history, which is
   * the only trace a session that used subagents leaves once the last one has returned. See
   * {@link launched}. */
  subagents: {
    running: number;
    launched: number;
    list: { title: string; model: string | null; pct: number; runId: string | null }[];
  };
  /** Background commands the session launched and has not been told the fate of — the reason a
   * session that has stopped talking can still be waiting on something. See {@link commands}. */
  background: {
    toolUseId: string;
    command: string;
    since: number;
    /** Absent from a server that speaks this version: it sends the running ones and nothing else.
     * Read only to DROP an ended command an older server still sends — drawn, it would wear the
     * at-work dot and tick a stopwatch on something that is dead, which is the one lie this row
     * must never tell. */
    state?: 'running' | 'failed';
  }[];
  /** How many background commands the session has launched over its whole life. See
   * {@link commandsLaunched}.
   *
   * OPTIONAL for the same reason `state` above is: an older server does not send it. That case is
   * the worst one this pair has — such a server still sends its last three FAILURES, which
   * `commands` now drops, and with no count either the failure would leave the tray entirely.
   * Typed so the compiler shows the case rather than letting it read as impossible. */
  backgroundLaunched?: number;
}

/**
 * One session as the panel holds it: the last entry the server sent, plus whether the server has
 * since stopped sending it. An `ended` row is kept until the panel closes — see {@link retain}.
 */
export interface Row {
  entry: DigestEntry;
  ended: boolean;
  /**
   * When the tray noticed it had ended, epoch ms. Every duration on an ended row is measured to this
   * instead of to now, or a session that is gone would go on counting — "stopped 6m 20s ago" about a
   * process that no longer exists is the panel asserting something it cannot know.
   */
  endedAt?: number;
}

/**
 * What the live surface can ask the app to do: hand a session to the browser portal, hand it the
 * portal itself, or show the settings. The last two are the footer's, not a row's — the footer is
 * the only part of this surface that is not a session.
 */
export interface BandActions {
  open(sessionId: string): void;
  /** Open the portal's home — from the footer's address, and from the empty state. */
  portal(): void;
  settings(): void;
}

/** The four bands, in the order they are drawn. Urgency descending — the whole point of the shape. */
export type Band = 'failed' | 'waiting' | 'working' | 'idle';

const BAND_TITLE: Record<Band, string> = {
  failed: 'Broken',
  waiting: 'Needs you',
  working: 'Working',
  idle: 'Idle',
};

/**
 * Which band a session belongs in, from `status` + `waitingFor`.
 *
 * The waiting rule is the server's `pendingInput`, not `status === 'waiting'`: Claude Code writes
 * 'waiting' for EVERY open dialog, the model picker included, so the raw status would file a
 * session the user opened a menu in under *Needs you*. An unrecognised label is deliberately not
 * treated as a wait on the human — a band that cries wolf is worse than one that stays empty.
 *
 * **`shell` counts as working**, and that is the whole of SEE's background-command finding: Claude
 * Code writes it while a command the session launched in the background is still running and the
 * turn is over. Read as "not busy", such a session dropped to *Idle* and jumped back to *Working*
 * when the command ended — reported from a real session, then reproduced by sampling CC's process
 * file every 2 s across a 240-second command. The server's `isWorking` is the same rule.
 *
 * The rule is duplicated in Rust (`poll.rs`, for the icon's counts) because the tray links
 * no seedeep code and Rust cannot ask the panel. Both copies are pinned to the server's own
 * function by tests that enumerate every label Claude Code writes.
 *
 * **Broken is read first**, and it is the one band that is not a rule here at all: the server
 * derives `error` and this reads the answer. It outranks the wait for the reason the icon does — a
 * session stopped on an approval resumes the moment it is answered, one whose call failed does not
 * resume at all — and the panel's order has to be the icon's, or the red icon sends you to a panel
 * where the broken session is filed under Idle.
 */
export function bandOf(entry: DigestEntry): Band {
  if (entry.error) return 'failed';
  if (entry.status === 'waiting') {
    if (entry.waitingFor === 'permission prompt' || entry.waitingFor === 'input needed') {
      return 'waiting';
    }
  }
  return entry.status === 'busy' || entry.status === 'shell' ? 'working' : 'idle';
}

/**
 * Fold a fresh digest into what the panel is already showing, and return the rows to draw.
 *
 * Two locked rules, and one function is enough for both:
 * - **The session list must never move.** Rows keep the order they were first seen in; a new
 *   session is appended. The payload's own order is the roster's, which re-sorts as sessions work,
 *   and rows that reshuffle under the cursor make a click land on the wrong session.
 * - **A session that ends while the panel is open stays, marked ended**, until the panel closes.
 *   The server drops it from the digest the moment it is no longer live; a row vanishing while
 *   someone is looking at it reads as a bug. It keeps its own last entry, so it also keeps its
 *   band — moving it to *Idle* on its way out would be the list moving.
 *
 * `seen` is what the panel last drew, and the caller clears it when the panel hides. `now` stamps a
 * row the first time it goes missing, and is kept from then on so its durations stop moving.
 */
export function retain(seen: readonly Row[], incoming: readonly DigestEntry[], now: number = Date.now()): Row[] {
  const fresh = new Map(incoming.map((e) => [e.sessionId, e]));
  const rows: Row[] = [];
  for (const row of seen) {
    const still = fresh.get(row.entry.sessionId);
    // Deleted as it is consumed, so what is left over is exactly what is new.
    if (still) fresh.delete(row.entry.sessionId);
    // LIMIT: a session the SERVER skipped this tick (an unreadable transcript — it logs
    // "digest skipped") is indistinguishable here from one that ended, so it shows `ended` for the
    // one poll before the retry puts it back. Self-healing, and the alternative is a grace period
    // that would delay every real ending.
    rows.push(still ? { entry: still, ended: false } : { entry: row.entry, ended: true, endedAt: row.endedAt ?? now });
  }
  for (const entry of fresh.values()) rows.push({ entry, ended: false });
  return rows;
}

/** One reading, as Rust reports it — see `poll.rs`. */
export interface Reading {
  entries: DigestEntry[] | null;
  /** Whether the popover is on screen. Rust's answer, because the webview has no reliable one of
   * its own: it keeps running while the window is hidden (measured), so "I am executing" is not
   * "somebody is looking". */
  open: boolean;
}

/**
 * The rows to draw for a reading — the whole state transition, in one place.
 *
 * **While nobody is looking, the panel is a mirror.** Both of `retain`'s promises are made to
 * somebody watching the screen: keeping a session that ended, and keeping the order stable. With the
 * popover closed neither means anything, and honouring them anyway had a visible cost — a session
 * that ended overnight would be waiting there, marked `ended`, the next time the panel was opened,
 * which is not the rule ("ends WHILE the panel is open") but its shadow.
 *
 * Entries of `null` mean the tray could not read: no rows at all, because the ones it has can no
 * longer be vouched for.
 */
export function fold(seen: readonly Row[], reading: Reading, now?: number): Row[] {
  if (reading.entries === null) return [];
  return retain(reading.open ? seen : [], reading.entries, now);
}

/**
 * How long, as a stopwatch: `45s`, `2m 14s`, `1h 04m`. For a session stopped on a question, where
 * the seconds are the point — five minutes of waiting is a different fact from thirty.
 */
export function stopwatch(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  if (m < 60) return `${m}m ${String(total % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/**
 * How long, roughly: `14m`, `3h`, `2d`. For an idle session, where the seconds are noise — the
 * question a pill answers is "recent or forgotten", and a ticking figure asks to be watched.
 */
export function quiet(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

/** The fill figure, `~` when the window it is measured against is a guess and not the model's. */
function pctOf(entry: DigestEntry): string {
  return `${entry.main.estimated ? '~' : ''}${entry.main.pct}%`;
}

/**
 * A token count as the portal writes it — `343.0k`, `1.0M`. The tray links no seedeep code, so
 * this is a copy of the browser's `k()`; the two must agree, because the figure the tray shows and
 * the figure the Context card shows are the same fact about the same session.
 */
export function tokens(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

/**
 * A model id as a person names it: `claude-opus-5` → `Opus 5`. Copy of the portal's `modelLabel`,
 * for the same reason as {@link tokens}. Anything that is not a `claude-family-version` id is
 * shown as written, minus the `<synthetic>` brackets — inventing a label for an id we do not
 * recognise is how a wrong name gets asserted confidently.
 */
export function modelLabel(id: string | null): string {
  if (!id) return '';
  const m = /^claude-([a-z]+)-(.+)$/.exec(id);
  if (!m) return id.replace(/^<|>$/g, '');
  const family = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1);
  const ver = m[2]!.split('-').filter((part) => /^\d{1,2}$/.test(part)); // version parts, not a date
  return ver.length ? `${family} ${ver.join('.')}` : family;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Project and subject — what identifies the session, on one line, in every band.
 *
 * The Idle band used to show the project ALONE, which is what made a row read as an unexplained
 * label rather than as a session — reported as *"I don't understand that seedeep label"*, which was
 * the project name, unaccompanied. `trailing` is what a band pins to the right of that line.
 */
function head(row: Row, trailing?: HTMLElement): HTMLElement {
  const wrap = el('div', 'row-head');
  wrap.append(el('span', 'row-project', row.entry.project));
  if (row.entry.subject) wrap.append(el('span', 'row-subject', row.entry.subject));
  // Said, not merely dimmed: a greyed row is indistinguishable from a row the theme greys.
  if (row.ended) wrap.append(el('span', 'row-ended', 'ended'));
  // The band this row sits in was decided from a DERIVED state: its host publishes none. Marked
  // here, where the band's word applies to one session, and nowhere else — the menu-bar icon
  // carries a single claim for the whole machine and cannot hold the qualifier.
  if (row.entry.statusDerived) {
    const mark = el('span', 'row-derived', 'derived');
    mark.title = 'State derived from the transcript: this session publishes none';
    wrap.append(mark);
  }
  if (trailing) wrap.append(trailing);
  return wrap;
}

/**
 * The context block: the tray's differentiator against every other menu-bar client.
 *
 * Named, and with the figure spelled out — `Context  343.0k / 1.0M   34%`. A bare `34%` was on
 * screen for two releases and did not say what it measured; the wording and the number
 * format are the portal's Context card, so the two surfaces state the same fact the same way.
 * What the card also shows and this cannot is the SPLIT of the fill: measured on a real session,
 * cache-read is 99.9% of it, so a three-colour bar at this width is a monochrome bar plus a legend.
 */
function fill(entry: DigestEntry): HTMLElement {
  const wrap = el('div', 'row-ctx');
  const line = el('div', 'ctx-line');
  // A text node rather than `textContent` + a child: mixing the two is the one DOM idiom this
  // codebase avoids everywhere (the portal's own Context card builds the figure the same way).
  const num = el('span', 'ctx-num');
  num.append(document.createTextNode(tokens(entry.main.fill)));
  num.append(el('small', undefined, ` / ${tokens(entry.main.window)}`));
  line.append(el('span', 'ctx-lbl', 'Context'), num);
  const chips = meta(entry);
  if (chips) line.append(chips);
  line.append(el('span', 'row-pct', pctOf(entry)));
  const bar = el('div', 'fill');
  const inner = el('i', 'fill-in');
  // Clamped: the reducer's pct can exceed 100 when a session outgrows the window it was measured
  // against, and a bar drawn past its track looks like a rendering fault rather than a full context.
  inner.style.width = `${Math.min(100, Math.max(0, entry.main.pct))}%`;
  bar.append(inner);
  wrap.append(line, bar);
  return wrap;
}

/**
 * Model and effort, as chips that ride on the CONTEXT line rather than on a line of their own.
 *
 * the maintainer's call, and the measurement behind it is that they FIT: at 392 px
 * `Context 232.5k / 1.0M · Opus 5 · high · 23%` sits on one line with room to spare, and the line
 * it used to occupy is ~28 px per row on the surface with the least height to spend. They belong
 * there for a reason beyond the space, too: the window in the denominator is the model's, so the
 * model is what that figure is measured against.
 *
 * Both are stated only when the transcript carries them: a session whose calls reported no effort
 * gets no effort chip, never a dash — "the log does not say" and "it ran at no effort" are
 * different claims, and only one of them is ours to make.
 *
 * A turn that changed model is not shown as two chips here as the portal does: `main.model` is the
 * one in force NOW, which is the one the window's denominator belongs to, and a row this size
 * cannot carry the history as well.
 */
function meta(entry: DigestEntry): HTMLElement | null {
  const model = modelLabel(entry.main.model);
  const efforts = entry.turn?.efforts ?? [];
  if (!model && !efforts.length) return null;
  // A wrapper rather than two loose chips, so ONE rule pushes the pair to the right whichever of
  // the two is present — the effort alone must float exactly where the model would have.
  const wrap = el('span', 'ctx-meta');
  if (model) wrap.append(el('span', 'meta-model', model));
  if (efforts.length) wrap.append(el('span', 'meta-effort', efforts.join(' · ')));
  return wrap;
}

/**
 * The one thing NOW says about the turn — the agent's own words (`intent`/`output`) or seedeep's
 * own (`activity`: what it has done since it last spoke; `working`: it is running with nothing to
 * quote, its work delegated to a background agent or its answer still being composed).
 *
 * The row does not choose between them and does not phrase them: `turn.now` is `nowLine`'s answer,
 * the same function the browser's NOW panel calls, so a change to the rule reaches both surfaces or
 * neither. What stays here is the drawing — the label, the voice, and the age.
 *
 * The label matters because the row above already carries a quote (the prompt): two paragraphs with
 * nothing between them read as one, which is what the rendered candidate showed. Only a LIVE turn's
 * words are drawn in the active colour; anything settled is the muted voice, so a row cannot look
 * busy while its session is not. seedeep's own voice (`activity`) is never the agent's italic.
 */
function now(entry: DigestEntry, at: number): HTMLElement | null {
  const state = entry.turn?.now ?? null;
  if (state === null) return null;
  // WORKING, not merely "the turn never closed": a turn whose end marker never arrived stays `live`
  // for good (measured, 1 of 247 settled sessions), and reading that alone drew an active-coloured
  // line inside the *Idle* band — the row looking busy while its session is not, which is the one
  // thing this row promises. The band is the session's own answer, so it is the one that decides.
  const live = entry.turn?.state === 'live' && bandOf(entry) === 'working';
  // The AGENT's voice is a closed set of two; everything else is seedeep. Written this way round
  // because the enumeration of seedeep's kinds silently mis-drew the next one added to `nowLine`:
  // `working` arrived and the row put seedeep's own sentence in the agent's italic.
  const plain = state.kind !== 'intent' && state.kind !== 'output';
  const node = el('div', `row-say${live ? '' : ' row-say--out'}${plain ? ' row-say--plain' : ''}`);
  node.append(el('span', 'say-lbl', state.label));
  node.append(document.createTextNode(state.text));
  // The age is the portal's chip, on the portal's terms: it is there only when the state has one to
  // give — a running call for an activity, the narration for a live intent — and never on a settled
  // turn, where nothing is still going to be timed.
  if (state.ageFrom !== null) node.append(el('span', 'say-age', stopwatch(Math.max(0, at - state.ageFrom))));
  return node;
}

/**
 * The background commands the session is waiting on, one line each — the running ones ONLY.
 *
 * A command that has ENDED is not on this list, whatever its fate: the count above it says the
 * session ran some, and what each one did is the portal's, one click away on the row. That is the
 * rule {@link commandsLaunched} already applies to subagents, and the tray keeps one rule for both
 * kinds of background work rather than a second one for commands (the maintainer's call, 2026-08-08,
 * revising the failed rows that shipped the same day).
 *
 * Below NOW and above the context block, where the agents at work already live — the row's band for
 * things that are running but are not the turn. A command has no model and no context of its own,
 * so it gets none of what an agent's line carries; what it gets is the age, because between its
 * launch and its notification that is the only thing about it that changes.
 *
 * Drawn in EVERY band, the *Needs you* row included — the one place its spare layout gains a line.
 * A command outlives the turn that launched it, which is the whole point: an *Idle* row with one of
 * these is a session that has stopped talking and is still waiting on something.
 *
 * The waiting row was built without it and the maintainer chose to add it, from the two rendered at 392 px:
 * it costs 24 px on a row that only exists while you are blocked, against two surfaces contradicting
 * each other at the exact moment you are deciding something — the browser's chip has no such
 * exception. And it can change the answer: someone about to refuse a command *because the server is
 * surely already up* is reading the line that says whether it is.
 */
function commands(entry: DigestEntry, at: number): HTMLElement | null {
  const list = (entry.background ?? []).filter((c) => c.state !== 'failed');
  if (!list.length) return null;
  const wrap = el('div', 'row-bgs');
  for (const c of list) {
    const line = el('div', 'row-bg');
    line.append(el('span', 'bgdot'));
    line.append(el('span', 'bg-cmd', c.command));
    line.append(el('span', 'bg-age', stopwatch(Math.max(0, at - c.since))));
    wrap.append(line);
  }
  return wrap;
}

/**
 * How many background commands the session has launched, over its whole life — one number, next to
 * the running ones, exactly as {@link launched} does it for subagents: same shape, same wording,
 * and the same two bands (*Working* and *Idle*). The spare bands draw the running rows without it —
 * *Needs you* is about the question being asked, and a total is not part of the answer.
 *
 * The count the server sends, never the length of the list beside it: {@link commands} draws what
 * is running THIS SECOND, so a session that fired four commands and was told about all four showed
 * nothing at all. This line is what survives the last one ending, and it is the whole of what the
 * tray says about a command that is over — the exit code, the output file and how long it ran are
 * the portal's, one click away on the row.
 */
function commandsLaunched(entry: DigestEntry): HTMLElement | null {
  // The extra class is what lets anything name just this line; the shared ones are what keep the
  // two totals from drifting apart visually.
  return countRow('Commands', entry.backgroundLaunched ?? 0, 'row-cmds');
}

/**
 * `<label>  <n> launched` — the shape both totals use, written once.
 *
 * Never a zero: on the 84% of real sessions that never spawn a subagent (measured over 721
 * transcripts) a `Subagents 0` line would spend a row telling every session what it is not, and
 * the same holds for commands. `launched` is not decoration — the line sits directly above the
 * rows of what is still at work, and a bare `12` over three rows reads as *12 running*.
 */
function countRow(label: string, n: number, extraClass?: string): HTMLElement | null {
  if (!n) return null;
  const node = el('div', extraClass ? `row-subs ${extraClass}` : 'row-subs');
  const num = el('span', 'subs-num');
  num.append(document.createTextNode(String(n)));
  num.append(el('small', undefined, ' launched'));
  node.append(el('span', 'ctx-lbl', label), num);
  return node;
}

/**
 * The agents at work, one line each: what it was launched to do, on which model, how full it is.
 *
 * A Workflow run collapses to ONE line however many agents it is running — the same rule the
 * browser's Graph applies, and for the same reason: a run of ~100 members would be the whole panel.
 * The count beside it is the members', so the line says how many are working without listing them.
 */
function agents(entry: DigestEntry): HTMLElement | null {
  const list = entry.subagents.list;
  if (!list.length) return null;
  const wrap = el('div', 'row-agents');
  const runs = new Map<string, number>();
  for (const a of list) {
    if (a.runId === null) {
      const line = el('div', 'agent');
      line.append(el('span', 'agent-title', a.title));
      const model = modelLabel(a.model);
      if (model) line.append(el('span', 'agent-model', model));
      line.append(el('span', 'agent-pct', `${a.pct}%`));
      wrap.append(line);
    } else runs.set(a.runId, (runs.get(a.runId) ?? 0) + 1);
  }
  for (const n of runs.values()) {
    const line = el('div', 'agent');
    line.append(el('span', 'agent-title', 'Workflow'), el('span', 'agent-model', `${n} agents`));
    wrap.append(line);
  }
  return wrap;
}

/**
 * How many subagents the session has launched, over its whole life — one number, on *Working* and
 * on *Idle* (the maintainer's call).
 *
 * The count the server sends, never a length of the list beside it: {@link agents} draws what is at
 * work THIS SECOND, so a session that fanned out twelve agents and got them all back showed nothing
 * at all — the tray's only trace of subagent use disappeared with the last return. `launched`
 * survives the return, which is the whole point of the row on *Idle*.
 *
 * Just the figure: what each one was, what it cost, how long it took is the portal's, one click
 * away on the row itself. See {@link countRow} for the shape, which the command total shares — one
 * function rather than two copies, so the two lines cannot drift apart in code either.
 */
function launched(entry: DigestEntry): HTMLElement | null {
  return countRow('Subagents', entry.subagents.launched);
}

/**
 * The row for a session stopped on the human. The verbatim request, because this is the one band
 * whose whole purpose is to let the user answer without going to the terminal first — and "a tool
 * is waiting" does not tell them whether to say yes.
 *
 * The wording is the portal's, deliberately: `Waiting for your approval` / `for your answer`, and
 * `in the terminal` when the transcript has not named the call. Two surfaces of the same product
 * describing the same event in different words is how a user learns to distrust both.
 */
function waitingRow(row: Row, actions: BandActions, now: number): HTMLElement {
  const { entry } = row;
  const node = rowButton(row, actions, 'row--wait');
  const what = entry.waitingFor === 'input needed' ? 'Waiting for your answer' : 'Waiting for your approval';
  const tool = entry.pendingTool;
  node.append(head(row), el('div', 'row-ask', tool ? `${what} — ${tool.name}` : `${what} in the terminal`));
  // Its own line, monospace: this is a command someone is about to authorise, and a shell line
  // folded into prose is one whose end nobody reads.
  if (tool?.arg) node.append(el('code', 'row-arg', tool.arg));
  if (entry.waitingSince !== null) {
    const age = (row.endedAt ?? now) - entry.waitingSince;
    node.append(el('div', 'row-age', `Stopped ${stopwatch(age)} ago`));
  }
  // Last, under the question: what the session is still waiting on that is NOT you.
  const cmds = commands(entry, now);
  if (cmds) node.append(cmds);
  return node;
}

/**
 * A working session: who it is, what it was ASKED, what NOW says about it, how many subagents it
 * has launched and which of them are at it, how full it is — and what it is running on, on the
 * context line.
 *
 * The prompt quote is kept and the NOW line is drawn under it, which is the shape the maintainer chose from
 * four rendered at 392 px. They answer different questions and neither replaces the other: the
 * prompt is why this session exists, NOW is what it is doing about it this minute, and a row with
 * only the first leaves the user reading a label with no idea what is happening.
 *
 * The itemised call line is GONE (the maintainer's call): it was a second, lower-resolution answer to the
 * question NOW already answers, and it was the tray's own — the portal never had it, so the two
 * surfaces disagreed about what "what it is doing" means.
 */
function workingRow(row: Row, actions: BandActions, at: number): HTMLElement {
  const { entry } = row;
  const node = rowButton(row, actions, 'row--work');
  node.append(head(row));
  if (entry.turn) node.append(el('div', 'row-line row-line--quote', `“${entry.turn.prompt}”`));
  const words = now(entry, at);
  if (words) node.append(words);
  // Each kind of background work reads the same way: the count first, what is still at it under
  // the count. The line says what the session has spent on commands (or on subagents), and the
  // rows below say which part of it is still running.
  const cmdTotal = commandsLaunched(entry);
  if (cmdTotal) node.append(cmdTotal);
  const cmds = commands(entry, at);
  if (cmds) node.append(cmds);
  const total = launched(entry);
  if (total) node.append(total);
  const ags = agents(entry);
  if (ags) node.append(ags);
  node.append(fill(entry));
  return node;
}

/**
 * An idle session: who it is, how long it has been quiet, what it ran on, WHERE IT STOPPED, how
 * many subagents it launched ({@link launched}), and how full it is.
 *
 * "Where it stopped" is normally the agent's own last words (`output`), not a summary of what it
 * did: a settled turn's activity is null in 12 real sessions out of 13, because a turn's last word
 * is always its answer and nothing has happened since. It comes from the same {@link now} the
 * working row uses — so the agent's voice is marked as the agent's on every band, and neither
 * surface has its own idea of what a turn last said.
 *
 * On the 13th, where the turn DID do something after its last word, the row now reads that count
 * instead of the words. The maintainer's call, taken with the number in hand: one rule on every surface is
 * worth more than a band keeping its own.
 *
 * This revokes the earlier *duration only, not where it stopped* rule — the maintainer's own
 * decision, revised by him after using it: a project name, a duration and a bare
 * percentage answered nothing worth opening the panel for.
 */
function idleRow(row: Row, actions: BandActions, at: number): HTMLElement {
  const { entry } = row;
  const node = rowButton(row, actions, 'row--idle');
  node.append(head(row, el('span', 'row-quiet', quiet((row.endedAt ?? at) - entry.lastActivity))));
  const words = now(entry, at);
  if (words) node.append(words);
  const cmdTotal = commandsLaunched(entry);
  if (cmdTotal) node.append(cmdTotal);
  const cmds = commands(entry, at);
  if (cmds) node.append(cmds);
  const total = launched(entry);
  if (total) node.append(total);
  node.append(fill(entry));
  return node;
}

/**
 * A broken session: who it is, that a call failed, the message Claude Code showed, and how long it
 * has been sitting there.
 *
 * The message is Claude Code's own words, not ours — "Not logged in · Please run /login" tells the
 * user what to do, where a category would send them to the terminal to find out. Monospace and its
 * own line, for the reason the pending command has one: this is the text they have to act on.
 *
 * The quiet time is the same reading the Idle band prints, because it answers the question the red
 * band raises — how long has this been broken without me noticing.
 */
function failedRow(row: Row, actions: BandActions, at: number): HTMLElement {
  const { entry } = row;
  const node = rowButton(row, actions, 'row--fail');
  node.append(head(row, el('span', 'row-quiet', quiet((row.endedAt ?? at) - entry.lastActivity))));
  const error = entry.error;
  if (error) {
    // Whose call failed. A subagent's failure and the session's own call for different reactions,
    // and a row that said only "API call failed" would leave the user hunting for which.
    node.append(el('div', 'row-ask', error.agentId ? "A subagent's API call failed" : 'The last API call failed'));
    if (error.message) node.append(el('code', 'row-arg', error.message));
  }
  node.append(fill(entry));
  return node;
}

/**
 * Every row is a button: clicking a session opens it in the browser portal, which is where anything
 * the tray cannot say at a glance lives. `onclick`, not addEventListener — the codebase's client
 * idiom, and the one the view-level tests can invoke.
 */
function rowButton(row: Row, actions: BandActions, variant: string): HTMLElement {
  const node = el('button', `row ${variant}${row.ended ? ' row--ended' : ''}`);
  node.type = 'button';
  node.onclick = () => actions.open(row.entry.sessionId);
  return node;
}

function bandNode(band: Band, rows: readonly Row[], actions: BandActions, now: number): HTMLElement {
  const node = el('section', `band band--${band}`);
  node.append(el('h2', 'band-head', BAND_TITLE[band]));
  for (const row of rows) {
    node.append(
      band === 'failed'
        ? failedRow(row, actions, now)
        : band === 'waiting'
          ? waitingRow(row, actions, now)
          : band === 'working'
            ? workingRow(row, actions, now)
            : idleRow(row, actions, now),
    );
  }
  return node;
}

/** The empty state's one control: the portal, whole, in the browser. */
function openPortalButton(actions: BandActions): HTMLElement {
  const go = el('button', 'bands-open', 'Open seedeep in the browser');
  go.type = 'button';
  go.onclick = () => actions.portal();
  return go;
}

/**
 * The panel with data in it: the bands, scrolling, over the footer that names the server.
 *
 * A band with no sessions is not drawn — three headings over one row would spend a 560px popover
 * on labels. The order of the ones that are drawn never changes, so a session appearing in *Needs
 * you* pushes the others down rather than landing somewhere new.
 *
 * No cap: every live session is drawn and the list scrolls. A cap sized on one machine's logs would
 * hide sessions instead of bounding anything.
 */
export function renderLive(
  rows: readonly Row[],
  status: Extract<Status, { kind: 'connected' }>,
  actions: BandActions,
  error?: string,
  /**
   * The instant the whole render is measured against. ONE clock for the pass: a waiting age, a
   * quiet time and a running call's age all appear in the same panel, and reading `Date.now()`
   * once per row would let them disagree about when "now" was.
   */
  now: number = Date.now(),
  /**
   * The server is bound to a configuration `config.json` no longer describes — its own verdict,
   * read when the popover opens. Defaults to false, so a caller that cannot ask says nothing.
   */
  restartPending = false,
): HTMLElement {
  const root = el('div', 'conn conn--live');
  const bands = el('div', 'bands');
  // First, not appended at the end: the bands scroll and an uncapped list would put a message about
  // the click that just failed somewhere below the fold.
  if (error) bands.append(renderError(error));
  // Above the sessions and below an error, because it is neither: the sessions are what the server
  // is doing, the error is what a click did not do, and this is what the server itself is not
  // honouring. It is NOT a band — a band is a session, and this is a property of the process.
  if (restartPending) {
    bands.append(
      el(
        'p',
        'bands-stale',
        'This server started before config.json was last changed. Restart it to serve the new port, host or certificate name.',
      ),
    );
  }
  const byBand = new Map<Band, Row[]>();
  for (const row of rows) {
    const band = bandOf(row.entry);
    const list = byBand.get(band);
    if (list) list.push(row);
    else byBand.set(band, [row]);
  }
  const drawn: Band[] = ['failed', 'waiting', 'working', 'idle'];
  for (const band of drawn) {
    const list = byBand.get(band);
    if (list?.length) bands.append(bandNode(band, list, actions, now));
  }
  if (!rows.length) {
    bands.append(
      el('p', 'bands-empty', 'No session is running. The tray shows them as Claude Code starts them.'),
      // The one screen with room for it and nothing else to do: everything this panel is for is
      // elsewhere until Claude Code starts something, and the portal is where the sessions that
      // already ran can still be read. The footer's address opens the same page on every screen —
      // this is the invitation, not the only way in.
      openPortalButton(actions),
    );
  }
  root.append(bands, renderFooter(status, actions));
  return root;
}
