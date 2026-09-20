import { readlink, realpath } from 'node:fs/promises';

/**
 * Is this live session being DRIVEN by a program, rather than typed into by a person?
 *
 * Claude Code cannot answer it: a session opened in a pty by a script writes the same
 * `entrypoint: "cli"`, the same `kind: "interactive"` and the same session file as one somebody
 * opened by hand (measured 2026-09-20 by driving a real session and diffing the two files field
 * by field; `claude agents --json` carries nothing more). So `isAutomated`, which reads
 * `entrypoint`, sees a headless `claude -p` and nothing else — and a probe run, or any pty
 * driver, announced a finished turn to nobody.
 *
 * What DOES separate them is the working directory, because a child inherits it: a person types
 * `claude` in the shell they are already sitting in, so the two directories match, while a driver
 * has to put the session somewhere else for the run to mean anything. Measured the same day: all
 * 8 sessions open on this machine matched their parent, and the probe's did not.
 *
 * Deliberately NOT a fact about the process tree. Reading the parent's NAME would mean keeping a
 * list of runtimes (`bun`, `node`, `python`), and reading the tty would file a terminal that
 * launches `claude` directly — `alacritty -e claude` — as a driver, because opening a pty for a
 * child is exactly what a driver does too. The cwd is the one thing a person cannot help sharing
 * with the process they typed into.
 */

/** Resolve a path for comparison, or null if it cannot be read (a deleted dir, a permission blip). */
async function resolved(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

/** The parent process id of `pid`, or null when the process is gone or `ps` cannot answer. */
async function parentPid(pid: number): Promise<number | null> {
  try {
    const proc = Bun.spawn(['ps', '-o', 'ppid=', '-p', String(pid)], {
      stdout: 'pipe',
      stderr: 'ignore',
      windowsHide: true,
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const ppid = Number.parseInt(out.trim(), 10);
    // A reparented orphan sits under pid 1, whose cwd is `/` and says nothing about who started
    // the session, so it is not an answer.
    return Number.isFinite(ppid) && ppid > 1 ? ppid : null;
  } catch {
    return null;
  }
}

/**
 * The working directory of a running process, or null when it cannot be read.
 *
 * Linux answers from `/proc`, which costs a readlink. macOS has no such file, so it pays for an
 * `lsof`; every other platform — Windows above all — has neither, and null there means the caller
 * keeps whatever it does when nothing is known.
 */
export async function cwdOf(pid: number): Promise<string | null> {
  if (process.platform === 'linux') {
    try {
      return await readlink(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  }
  if (process.platform !== 'darwin') return null;
  try {
    const proc = Bun.spawn(['lsof', '-a', '-d', 'cwd', '-p', String(pid), '-Fn'], {
      stdout: 'pipe',
      stderr: 'ignore',
      windowsHide: true,
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    // -Fn prints one field per line, each tagged by its first character; the cwd is the `n` line.
    const line = out.split('\n').find((l) => l.startsWith('n'));
    return line ? line.slice(1) : null;
  } catch {
    return null;
  }
}

// A KNOWN answer is kept for the life of the process: the pair it compares cannot change while the
// session runs. A shell blocked on `claude` cannot cd, and the launch directory is read from a
// transcript line that was written once (`/cd` rewrites the session FILE and moves the transcript,
// but never that first line — measured 2026-09-20).
// LIMIT: entries for sessions that have ended are never pruned, at a few dozen bytes each, the
// same trade the head cache in discovery.ts makes.
const settled = new Map<string, boolean>();

// An UNKNOWN answer is not one, so it is never kept the same way: seedeep meets a session the
// instant its file appears, and the first line carrying a cwd may not be written yet. Caching that
// froze the session as unknown for the life of the server — found by a live run, where the driven
// session seedeep was meant to silence came back `null` and stayed there. Retried, but no more
// often than this, or a session nothing can answer for would cost an `lsof` on every 300ms tick.
export const RETRY_UNKNOWN_MS = 3_000;
const retryAfter = new Map<string, number>();

/**
 * Whether `sessionId` is driven by a program: its launch directory differs from the working
 * directory of the process that started it.
 *
 * `null` means unknown, never "no": an unreadable parent, a platform without the mechanism, or a
 * session whose launch directory was never found. Callers must treat unknown as they treat a
 * person, because the cost of being wrong is not symmetric — one notification too many is noise,
 * while one too few is the approval nobody comes back to answer.
 *
 * `launchCwd` must be the directory the session STARTED in, which is the FIRST transcript line
 * carrying one (`discovery.ts` keeps it as `meta.cwd`), never the session file's `cwd` or a later
 * line: both of those move. A `cd` in a Bash call rewrites the transcript's later lines, and a
 * `/cd` rewrites the session file and moves the transcript to another project directory, while
 * that first line stays what it was — all three measured 2026-09-20.
 */
export async function isDrivenSession(
  sessionId: string,
  pid: number,
  launchCwd: string | null,
): Promise<boolean | null> {
  const hit = settled.get(sessionId);
  if (hit !== undefined) return hit;
  const notBefore = retryAfter.get(sessionId);
  if (notBefore !== undefined && Date.now() < notBefore) return null;
  const answer = await compare(pid, launchCwd);
  if (answer === null) retryAfter.set(sessionId, Date.now() + RETRY_UNKNOWN_MS);
  else settled.set(sessionId, answer);
  return answer;
}

async function compare(pid: number, launchCwd: string | null): Promise<boolean | null> {
  if (launchCwd === null) return null;
  const ppid = await parentPid(pid);
  if (ppid === null) return null;
  const parent = await cwdOf(ppid);
  if (parent === null) return null;
  // Both sides are resolved before comparing: macOS hands out `/tmp` and `/private/tmp` for the
  // same directory, and an unresolved pair would read as "different" and silence a real person.
  const [a, b] = await Promise.all([resolved(launchCwd), resolved(parent)]);
  return a === null || b === null ? null : a !== b;
}

/** Drop a session's cached answer. Exported for tests, which must not inherit each other's state. */
export function forgetDrivenSession(sessionId: string): void {
  settled.delete(sessionId);
  retryAfter.delete(sessionId);
}
