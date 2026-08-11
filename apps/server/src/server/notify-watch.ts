import { isWorking, pendingInput } from '../core/types.ts';
import type { DigestEntry } from './digest.ts';

/** Which switch an announcement answers to. */
export type NotifyKind = 'needsYou' | 'fails' | 'finishes';

/**
 * What one notification says: which session, and what happened. Nothing else.
 *
 * **A notification answers "do I get up", not "what do I do"** (Davide's call, 2026-08-11). The
 * bodies used to carry a second line — the command awaiting approval, the API error verbatim, the
 * turn's NOW line — and it was the wrong place for all three. You cannot act on any of them from a
 * banner: approving still means going back to the terminal, and everything the second line said is
 * one click away in the panel, which is where the detail belongs and where it is not truncated.
 *
 * The webhook settled it. It exists to reach a phone, and it is the one channel whose payload
 * LEAVES the machine — so a body carrying shell commands and error text was shipping the contents
 * of a work session to a third-party service to say something the first line already said.
 *
 * The two channels are deliberately identical now, so there is one thing to reason about.
 */
export interface Announcement {
  kind: NotifyKind;
  sessionId: string;
  project: string;
  subject: string | null;
  /** `project — subject`, or the project alone when the session has no subject yet. */
  title: string;
  /** One line: the event, and for an approval the tool it is about. Never the detail. */
  body: string;
}

/** What the sessions were doing last time we could see them. */
interface Seen {
  waiting: Set<string>;
  working: Set<string>;
  failed: Set<string>;
}

/** Whether a digest entry is a session waiting on its user, by the server's own rule. */
function needsYou(e: DigestEntry): boolean {
  return pendingInput(e) !== null;
}

/**
 * Whether the session's last model call failed and nothing has recovered from it.
 *
 * A missing key reads as healthy: an older client shape that does not carry the field must not
 * make every session look broken.
 */
function hasFailed(e: DigestEntry): boolean {
  return e.error != null;
}

/**
 * Which session a banner is about: `project — subject`, or the project alone.
 *
 * The banner already carries the app's name, so the title is spent on the one thing the user has
 * to know first — which of their projects this is.
 */
function sessionTitle(e: DigestEntry): string {
  return e.subject ? `${e.project} — ${e.subject}` : e.project;
}

/** The ids of the entries a predicate holds for. */
function ids(entries: DigestEntry[], is: (e: DigestEntry) => boolean): Set<string> {
  return new Set(entries.filter(is).map((e) => e.sessionId));
}

/**
 * The words one waiting session gets.
 *
 * The phrasing is the portal's and the panel's — `Waiting for your approval` / `for your answer`,
 * `in the terminal` when the transcript has not named the call — because a notification that
 * describes the same event in different words from the panel it belongs to teaches the user to
 * trust neither. Now that the body IS that one line, the two cannot drift at all.
 *
 * The tool's NAME stays and its ARGUMENT does not, which is the whole rule in miniature: `Bash`
 * says whether something is about to run or a question is waiting, and that changes how fast you
 * get up. The command itself is what you go and read.
 */
function waitingAnnouncement(e: DigestEntry): Announcement {
  const what = pendingInput(e) === 'input' ? 'Waiting for your answer' : 'Waiting for your approval';
  const tool = e.pendingTool;
  const body = tool?.name ? `${what} — ${tool.name}` : `${what} in the terminal`;
  return {
    kind: 'needsYou',
    sessionId: e.sessionId,
    project: e.project,
    subject: e.subject,
    title: sessionTitle(e),
    body,
  };
}

/**
 * The words one failed session gets.
 *
 * A subagent's failure says so, because "a subagent failed" and "your session failed" call for
 * different reactions — and that distinction is the one thing here that changes what you do next.
 * Claude Code's own message is NOT carried: it is the longest and least summarisable text in the
 * whole feed, it is what a banner truncates first, and reading it is what the panel is for.
 */
function failedAnnouncement(e: DigestEntry): Announcement {
  const error = e.error!;
  const body = error.agentId == null ? 'The last API call failed' : "A subagent's API call failed";
  return {
    kind: 'fails',
    sessionId: e.sessionId,
    project: e.project,
    subject: e.subject,
    title: sessionTitle(e),
    body,
  };
}

/**
 * The words one finished turn gets, or `null` when the turn is one the user ended themselves.
 *
 * **An interrupted turn is not news**: pressing Esc is the user standing at that terminal, and
 * telling them what they just did is the definition of a banner that gets muted. What the turn
 * actually did is not carried either — the event IS the session becoming yours again, and the
 * account of it is the Idle band's, three words away in the panel.
 */
function finishedAnnouncement(e: DigestEntry): Announcement | null {
  if (e.turn?.state === 'interrupted') return null;
  // `Turn finished`, and both words earn their place. `Finished` alone read as the SESSION having
  // ended, which it has not; `Back to you` said the right thing and nobody could tell what it meant
  // out of context. Naming the turn is what makes it unambiguous.
  const body = 'Turn finished';
  return {
    kind: 'finishes',
    sessionId: e.sessionId,
    project: e.project,
    subject: e.subject,
    title: sessionTitle(e),
    body,
  };
}

/**
 * The transition detector: fold one reading in and return what the user should be told about.
 *
 * Ported from the tray, which owned it while it was the only thing that notified. Four rules travel
 * with it, and each exists because something went wrong once:
 *
 * - **Seeding.** `null` until a reading has actually been made, and back to `null` after any reading
 *   that could not be. A session already waiting when this starts — or when it restarts — is not
 *   something that just happened, and saying so would misdate it.
 * - **Per session, never counts.** Sessions are remembered by id: a count would stay at one while
 *   one prompt was answered and another raised, which is precisely the event worth an interruption.
 * - **`busy → waiting` is not a finish.** That is a session stopped on the user, and the wait is
 *   what that event is called. `shell` is excluded from the other side for the mirror reason: the
 *   turn is over but a command it launched is still running.
 * - **Failure is read first.** A session that just broke is the more serious of the two, and one
 *   moment must not raise two banners.
 *
 * LIMIT: a session that enters a wait — or finishes — during a stretch that could not be read is
 * never announced; on the next reading it is part of the seed. That is the honest choice: there is
 * no way to know when it happened, and a state with no time behind it is what the panel is for.
 */
export function createNotifyWatch(): { step(entries: DigestEntry[] | null): Announcement[] } {
  let seen: Seen | null = null;
  return {
    step(entries) {
      if (entries === null) {
        seen = null;
        return [];
      }
      // An entry with no id is skipped entirely rather than announced: it cannot be remembered, so
      // it would be new again on every single tick.
      const identified = entries.filter((e) => typeof e.sessionId === 'string' && e.sessionId.length > 0);
      const before = seen;
      seen = {
        waiting: ids(identified, needsYou),
        working: ids(identified, isWorking),
        failed: ids(identified, hasFailed),
      };
      if (before === null) return [];
      const out: Announcement[] = [];
      for (const e of identified) {
        if (hasFailed(e) && !before.failed.has(e.sessionId)) {
          out.push(failedAnnouncement(e));
          continue;
        }
        if (needsYou(e) && !before.waiting.has(e.sessionId)) {
          out.push(waitingAnnouncement(e));
          continue;
        }
        // A session that has STOPPED working, which is not the same as one that is no longer busy.
        if (e.status === 'idle' && before.working.has(e.sessionId)) {
          const a = finishedAnnouncement(e);
          if (a) out.push(a);
        }
      }
      return out;
    },
  };
}
