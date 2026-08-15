//! Is a background command still alive? The one question the transcript can never answer.
//!
//! A launch whose shell dies with nobody left to report it gets no `<task-notification>` ever —
//! 23 of 198 launches in the local corpus (11.6%), across 11 sessions — and `background &&
//! !outcome` then reads "still running" for as long as the session stays open. Seen live: two rows
//! counting past 40 minutes with nothing of either alive on the machine.
//!
//! Two other sources were measured and rejected before this one (see the card's proposal):
//!
//! - **Claude Code's own registry of background shells does not exist on disk.** The task id
//!   appears nowhere in `~/.claude` outside the transcript, and `~/.claude/sessions/<pid>.json`
//!   carries the session's pid, not its shells'.
//! - **The output file's mtime or size is refuted by the very commands that get stuck**: four
//!   healthy `until … sleep 20` waiters had written 0 bytes after tens of minutes ALIVE. A rule
//!   keyed on the bytes would have declared all four dead within seconds of launch.
//! - **Matching `ps` on the command TEXT does not work either**: the harness re-quotes what it
//!   runs (`sh -c 'x'` reaches the process table as `eval 'sh -c '"'"'x'"'"''`), so the string
//!   seedeep holds is not the string `ps` prints, and two identical commands are indistinguishable
//!   anyway.
//!
//! What DOES answer it is who holds the command's output file OPEN. Measured 2026-08-08 on real
//! launches: the whole chain holds it (the harness's `zsh` wrapper, the command's own shell and the
//! leaf), `claude` itself does not, a command that ends or is killed releases it while the file
//! stays on disk, and a file that has been deleted errors distinguishably from one nobody holds.
//! 33–35 ms per call, the same for one file as for six, with 691 processes on the box.

import { execFile } from 'node:child_process';
import { readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';

/** Where Claude Code puts a session's working files: `/tmp/claude-<uid>`, `/private`-prefixed or
 * not depending on who resolved the path. `anon()` masks the same two shapes, and this is the same
 * undocumented convention read from the other end. */
const SCRATCH_ROOTS = ['/private/tmp', '/tmp'];

/** How long a probe may take before it is abandoned. A liveness check that hangs must degrade to
 * "no verdict", never delay the poll it rides on. */
const PROBE_TIMEOUT_MS = 4_000;

/** Probes with no holder before a command tips to `unknown`. One is enough to be right and not
 * enough to be safe: a second costs one interval and removes every transient.
 *
 * Two is also enough against the one case that could be mistaken for a silent death — a command
 * that finished CLEANLY releases the file at the same instant, and its notification has to arrive
 * before the second strike. Measured 2026-08-08 over every local transcript, on commands that
 * state their own duration: the notification is written **0.0 s** after the process exits (11
 * samples, min −0.0 s, max 0.0 s). The margin is two full intervals against a latency of zero. */
export const STRIKES = 2;

/** How many probes may look for a command's output file before it is left unanswerable. The
 * failures are permanent by nature — a transcript from another machine, a cleaned `/tmp`, a layout
 * Claude Code moved — so retrying for the life of the session buys nothing and walks the scratch
 * root every interval. Four covers the only transient case (the file appearing a beat after the
 * launch line) many times over. */
export const RESOLVE_TRIES = 4;

/** What a probe learned about one command. `null` means NO VERDICT — not "dead". */
export type Verdict = boolean | null;

/**
 * Resolve a background command's output file from its task id, without the transcript's help.
 *
 * The path the receipt prints is `<root>/<project-slug>/<harness-session-uuid>/tasks/<taskId>.output`,
 * and `anon()` masks the uuid before it can reach an event — so the parsed value cannot be used to
 * open anything, and the id is what is left to search by. Two `readdir`s under the scratch root,
 * and the id is unique, so the first hit is the file.
 *
 * Returns null when nothing matches: a session from another machine, a root that was cleaned, or a
 * layout Claude Code has since changed. Every one of those must read as "cannot answer".
 */
export async function resolveOutputFile(
  taskId: string,
  uid: number,
  roots: readonly string[] = SCRATCH_ROOTS,
): Promise<string | null> {
  for (const base of roots) {
    const root = join(base, `claude-${uid}`);
    let slugs: string[];
    try {
      slugs = await readdir(root);
    } catch {
      continue;
    }
    for (const slug of slugs) {
      let sessions: string[];
      try {
        sessions = await readdir(join(root, slug));
      } catch {
        continue;
      }
      for (const s of sessions) {
        const path = join(root, slug, s, 'tasks', `${taskId}.output`);
        try {
          const stat = await Bun.file(path).exists();
          if (stat) return path;
        } catch {
          // Unreadable is not absent, but it is equally unanswerable — keep looking.
        }
      }
    }
  }
  return null;
}

/**
 * Which of these files a process still holds open, in ONE `lsof`.
 *
 * `-F pn` is the parsable form: `p<pid>` records, each followed by the `n<path>` lines of that
 * process's matching descriptors. A path that appears is held; one that does not is not — unless
 * the call itself failed, which is a different answer and is returned as `null` for everything.
 *
 * LIMIT: `lsof` only. Linux without it (a slim container) gets no verdict rather than a
 * `/proc/<pid>/fd` sweep, which is thousands of `readlink`s per probe where this is one process;
 * Windows has neither and is out of scope. A missing prober must never read as "the command died".
 */
export async function heldOpen(
  paths: readonly string[],
  run: (targets: readonly string[]) => Promise<string | null> = lsof,
): Promise<Map<string, Verdict>> {
  const out = new Map<string, Verdict>();
  if (!paths.length) return out;
  // Two things happen here, and BOTH exist because getting them wrong says "dead" about something
  // alive. lsof prints the REAL path, so `/tmp/x` asked about comes back as `/private/tmp/x` on
  // macOS and matches nothing — measured, and it made a file this very process was holding open
  // read as held by nobody. And a path that cannot be resolved AT ALL is not a dead command: the
  // scratch root is under /tmp, which the OS cleans, so a long-running command can outlive its own
  // output file. That is unanswerable, never a death.
  const real = new Map<string, string | null>();
  for (const p of paths) {
    try {
      real.set(p, await realpath(p));
    } catch {
      real.set(p, null);
      out.set(p, null);
    }
  }
  const targets = [...new Set([...real.values()].filter((v): v is string => v !== null))];
  if (!targets.length) return out;
  const raw = await run(targets);
  if (raw === null) {
    for (const p of paths) out.set(p, null);
    return out;
  }
  const held = new Set<string>();
  for (const line of raw.split('\n')) if (line.startsWith('n')) held.add(line.slice(1));
  for (const p of paths) {
    const r = real.get(p);
    if (r !== null && r !== undefined) out.set(p, held.has(r));
  }
  return out;
}

/**
 * What one `lsof` run means: its output, or `null` for NO VERDICT.
 *
 * **stderr is the discriminator, never the exit code**, and this is the rule the whole feature's
 * safety rests on. Measured on lsof 4.91: a file simply held by nobody — an ANSWER — exits **1**
 * with stdout AND stderr both empty, while a rejected invocation (`-ZZZ`) exits **1** with an
 * empty stdout and 573 bytes of stderr. Reading that empty stdout as an answer marked every
 * background command of every watched session as vanished, at once and in silence, on any lsof
 * this code cannot drive — the exact direction the module header says must never happen.
 *
 * Its own function because it is the one thing here a test can hold: the flags cannot be varied
 * from outside, so a test that could not feed these three shapes could not check the rule at all.
 */
export function lsofVerdict(err: unknown, stdout: string | undefined, stderr: string | undefined): string | null {
  const e = err as (NodeJS.ErrnoException & { killed?: boolean }) | null;
  if (e && (e.code === 'ENOENT' || e.killed)) return null;
  if (!stdout && stderr?.trim()) return null;
  return stdout ?? '';
}

/** `lsof -F pn` over the paths, or null when the tool is absent, errored, or took too long. */
function lsof(paths: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    // `execFile` with an argv array, never `exec`: no shell is involved, so a path is passed to
    // lsof as one argument whatever it contains. These paths are session-derived — a project
    // directory named `; rm -rf ~` is a legal directory name.
    const child = execFile(
      'lsof',
      ['-F', 'pn', '--', ...paths],
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: 1_000_000, windowsHide: true },
      (err, stdout, stderr) => resolve(lsofVerdict(err, stdout, stderr)),
    );
    child.on('error', () => resolve(null));
  });
}

/** One background command as the prober tracks it, across polls. */
interface Tracked {
  /** The resolved output file, or null while unresolved. Resolution is retried across probes
   * because a file appears a moment after the launch line does — but only {@link RESOLVE_TRIES}
   * times: the cases the JSDoc names (another machine, a cleaned root, a layout that moved) are
   * PERMANENT, and re-walking the scratch root for them every 15 s for the life of the session is
   * work that can never produce an answer. */
  path: string | null;
  /** Resolution attempts spent. At {@link RESOLVE_TRIES} the command is left unanswerable. */
  tries: number;
  /** Consecutive probes that found the file present and held by nobody. */
  strikes: number;
  /** The last probe that found it held, as an ISO timestamp. */
  lastSeenAlive: string | null;
  /** Already reported — the event is emitted once, and the reducer's mark is idempotent anyway. */
  reported: boolean;
}

/** What the prober needs to know about one command still waiting for its fate. */
export interface PendingCommand {
  sessionId: string;
  toolUseId: string;
  taskId: string;
}

/** A `command-vanished` worth emitting: this command's process is gone. */
export interface Vanished {
  sessionId: string;
  toolUseId: string;
  lastSeenAlive: string | null;
}

/**
 * The liveness prober: give it every background command still waiting for its fate, get back the
 * ones whose process is gone.
 *
 * Stateful across calls on purpose — {@link STRIKES} consecutive empty probes are what separate a
 * verdict from a blink, and `lastSeenAlive` is the only record of when a command was last known to
 * be running. Commands that disappear from the input (their notification finally arrived, or the
 * session closed) are forgotten, so the map cannot grow with the session.
 *
 * Never throws: every failure mode inside is a missing verdict, and a missing verdict leaves the
 * row exactly as it is today.
 */
export function createProber(
  deps: {
    uid?: number;
    now?: () => Date;
    /** Injectable IO, so a test can decide what the machine would have said. Both default to the
     * real thing; a test that stubbed neither would be asserting this box's process table. */
    resolve?: (taskId: string, uid: number) => Promise<string | null>;
    held?: (paths: readonly string[]) => Promise<Map<string, Verdict>>;
  } = {},
) {
  const uid = deps.uid ?? process.getuid?.() ?? 0;
  const now = deps.now ?? (() => new Date());
  const resolve = deps.resolve ?? resolveOutputFile;
  const held0 = deps.held ?? heldOpen;
  const tracked = new Map<string, Tracked>();
  const key = (c: PendingCommand) => `${c.sessionId} ${c.toolUseId}`;

  return {
    /** One round: resolve what is unresolved, probe what is resolved, return what has vanished. */
    async probe(pending: readonly PendingCommand[]): Promise<Vanished[]> {
      const live = new Set(pending.map(key));
      for (const k of [...tracked.keys()]) if (!live.has(k)) tracked.delete(k);

      // Resolutions in parallel, and bounded: each one walks the scratch root, and a command whose
      // file will never be found must not pay for that walk on every probe for ever.
      await Promise.all(
        pending.map(async (c) => {
          const k = key(c);
          let t = tracked.get(k);
          if (!t) {
            t = { path: null, tries: 0, strikes: 0, lastSeenAlive: null, reported: false };
            tracked.set(k, t);
          }
          if (t.path !== null || t.tries >= RESOLVE_TRIES) return;
          t.tries += 1;
          t.path = await resolve(c.taskId, uid);
        }),
      );

      const paths = [...new Set(pending.map((c) => tracked.get(key(c))?.path).filter((p): p is string => !!p))];
      const held = await held0(paths);

      const out: Vanished[] = [];
      const at = now().toISOString();
      for (const c of pending) {
        const t = tracked.get(key(c));
        // No path resolved is not a dead command: it is a command seedeep cannot look at.
        if (!t || t.path === null || t.reported) continue;
        const verdict = held.get(t.path);
        if (verdict === null || verdict === undefined) continue; // no verdict — leave the row alone
        if (verdict) {
          t.strikes = 0;
          t.lastSeenAlive = at;
          continue;
        }
        t.strikes += 1;
        if (t.strikes < STRIKES) continue;
        t.reported = true;
        out.push({ sessionId: c.sessionId, toolUseId: c.toolUseId, lastSeenAlive: t.lastSeenAlive });
      }
      return out;
    },
    /** How many commands are being tracked — for the test that asserts the map does not grow. */
    get size(): number {
      return tracked.size;
    },
  };
}
