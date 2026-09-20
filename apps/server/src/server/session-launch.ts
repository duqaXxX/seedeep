import { spawn } from 'node:child_process';
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
 * Both sides are read from the PROCESSES, never from the transcript. The transcript's first line
 * carries the directory the session was first launched in, which is a different fact: `--resume`
 * appends to that same file from wherever you run it, so a session resumed one directory down
 * compared its original directory against the new shell's and read as driven, silencing a person
 * (found in review, 2026-09-21). Reading both sides the same way, at the same instant, also keeps
 * the mechanism off a jsonl field Anthropic may rename.
 *
 * Deliberately NOT a fact about the process tree. Reading the parent's NAME would mean keeping a
 * list of runtimes (`bun`, `node`, `python`), and reading the tty would file a terminal that
 * launches `claude` directly — `alacritty -e claude` — as a driver, because opening a pty for a
 * child is exactly what a driver does too. The cwd is the one thing a person cannot help sharing
 * with the process they typed into.
 *
 * LIMIT: `/cd` moves the session's process for real (`chdir`, measured 2026-09-21), so a person
 * who runs it lands in a directory their shell is not in. The cached answer covers the common
 * case, having been settled when the session was first seen, which is before any `/cd` could run;
 * a session already moved when seedeep first meets it reads as driven and stays quiet. Measured
 * over every session on this machine, `/cd` had been used zero times.
 */

/** The mechanism exists on these two platforms only; everywhere else the answer is unknown. */
const SUPPORTED = process.platform === 'darwin' || process.platform === 'linux';

/** Kill a subprocess that has not answered by then. `lsof` hangs on an unresponsive network mount,
 * and this one runs inside the discovery pass: without a bound, one dead NFS mount stops the scan
 * and, with it, every notification for the life of the process. Same bound `git.ts` uses. */
const TIMEOUT_MS = 5000;

// One warning per failure kind, not per call: this runs on every discovery tick, and a broken
// `lsof` would otherwise fill the log with the same line forever. Silence was the first version,
// and it made "the feature stopped working" indistinguishable from "no session is driven".
const warned = new Set<string>();
function warnOnce(what: string, err: unknown): void {
  const key = `${what}:${(err as { code?: string })?.code ?? String(err).slice(0, 40)}`;
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`seedeep: ${what} failed, so seedeep cannot tell driven sessions apart —`, err);
}

/**
 * Run a command and resolve its stdout, or null on a non-zero exit, a missing binary or a timeout.
 *
 * Argv array, never a shell string, so a path can carry any character without becoming a command.
 */
function run(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (v: string | null) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    let child: ReturnType<typeof spawn>;
    try {
      // `windowsHide`, like every subprocess this server starts: a detached server has no console,
      // and Windows would give a new one to each console child.
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch (e) {
      warnOnce(cmd, e);
      return finish(null);
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      warnOnce(cmd, new Error(`no answer in ${TIMEOUT_MS}ms`));
      finish(null);
    }, TIMEOUT_MS);
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      // ENOENT here is the binary missing, which is worth saying once: on a box without `lsof`
      // every session reads as unknown and the feature is silently off.
      warnOnce(cmd, e);
      finish(null);
    });
    // A non-zero exit is not an answer: `ps` and `lsof` both exit non-zero for a process that is
    // gone, which is expected and quiet, and partial output from a failed run must not be parsed.
    child.on('close', (code) => {
      clearTimeout(timer);
      finish(code === 0 ? out : null);
    });
  });
}

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
  if (!SUPPORTED) return null;
  const out = await run('ps', ['-o', 'ppid=', '-p', String(pid)]);
  if (out === null) return null;
  const ppid = Number.parseInt(out.trim(), 10);
  // A reparented orphan sits under pid 1, whose cwd is `/` and says nothing about who started
  // the session, so it is not an answer.
  return Number.isFinite(ppid) && ppid > 1 ? ppid : null;
}

/**
 * The working directory of a running process, or null when it cannot be read.
 *
 * Linux answers from `/proc`, which costs a readlink. macOS has no such file, so it pays for an
 * `lsof`; every other platform — Windows above all — has neither, and null there means the caller
 * keeps whatever it does when nothing is known.
 *
 * Exported for the tests, which prove the operating system really answers this; nothing in the
 * server calls it directly.
 */
export async function cwdOf(pid: number): Promise<string | null> {
  if (process.platform === 'linux') {
    try {
      return await readlink(`/proc/${pid}/cwd`);
    } catch (e) {
      // ESRCH/ENOENT is the process having exited, which is ordinary and quiet.
      if ((e as { code?: string })?.code !== 'ENOENT') warnOnce('/proc read', e);
      return null;
    }
  }
  if (process.platform !== 'darwin') return null;
  const out = await run('lsof', ['-a', '-d', 'cwd', '-p', String(pid), '-Fn']);
  if (out === null) return null;
  // -Fn prints one field per line, each tagged by its first character; the cwd is the `n` line.
  const line = out.split('\n').find((l) => l.startsWith('n'));
  return line ? line.slice(1) : null;
}

/**
 * What is known about one session, and nothing more: a settled answer OR a retry deadline, never
 * both. Two maps held that invariant by convention; one map holds it by construction.
 *
 * A settled answer is kept for the life of the process, because the pair it compares cannot change
 * under a session that is running. An unknown one is NOT an answer and is retried: seedeep meets a
 * session the instant its file appears, when its process may not be readable yet, and caching that
 * froze the session as unknown for the life of the server — found by a live run, where the driven
 * session seedeep was meant to silence came back `null` and stayed there.
 *
 * LIMIT: entries for sessions that have ended are never pruned, at a few dozen bytes each, the
 * same trade the head cache in discovery.ts makes.
 */
type Known = { settled: boolean } | { retryAfter: number };
const known = new Map<string, Known>();

/** How long an unknown answer is left alone before it is asked again. A session nothing can answer
 * for would otherwise cost two subprocesses on every discovery tick (300ms by default). */
export const RETRY_UNKNOWN_MS = 3_000;

// One comparison per session at a time. The roster poll and the notification sweep both run
// discovery, and without this they start the same two subprocesses twice over.
const inFlight = new Map<string, Promise<boolean | null>>();

let started = 0;
/** How many comparisons have actually been run. TEST ONLY: it is how the de-duplication above can
 * be observed at all, since an `async` function hands every caller a fresh promise either way. */
export function drivenComparisonsStarted(): number {
  return started;
}

/**
 * Whether `sessionId`, running as `pid`, is driven by a program: the session's process works in a
 * directory other than the one its parent process works in.
 *
 * `null` means unknown, never "no": an unreadable parent, a platform without the mechanism, a
 * process that has exited. Callers must treat unknown as they treat a person, because the cost of
 * being wrong is not symmetric — one notification too many is noise, while one too few is the
 * approval nobody comes back to answer. {@link isDriven} in `core/types.ts` is that rule.
 */
export async function isDrivenSession(sessionId: string, pid: number): Promise<boolean | null> {
  const hit = known.get(sessionId);
  if (hit && 'settled' in hit) return hit.settled;
  if (hit && Date.now() < hit.retryAfter) return null;
  const running = inFlight.get(sessionId);
  if (running) return running;
  // Never throws by contract, and the contract is enforced here rather than trusted: an exception
  // escaping this call would leave `recordFor` rejecting, and the scan drops EVERY session on a
  // rejection it cannot classify.
  const answer = compare(pid)
    .catch(() => null)
    .then((v) => {
      known.set(sessionId, v === null ? { retryAfter: Date.now() + RETRY_UNKNOWN_MS } : { settled: v });
      return v;
    })
    .finally(() => inFlight.delete(sessionId));
  inFlight.set(sessionId, answer);
  return answer;
}

async function compare(pid: number): Promise<boolean | null> {
  started++;
  if (!SUPPORTED) return null;
  const ppid = await parentPid(pid);
  if (ppid === null) return null;
  const [own, parent] = await Promise.all([cwdOf(pid), cwdOf(ppid)]);
  if (own === null || parent === null) return null;
  // Both sides are resolved before comparing: macOS hands out `/tmp` and `/private/tmp` for the
  // same directory, and an unresolved pair would read as "different" and silence a real person.
  const [a, b] = await Promise.all([resolved(own), resolved(parent)]);
  return a === null || b === null ? null : a !== b;
}

/**
 * Drop a session's cached answer and its retry deadline.
 *
 * TEST ONLY: nothing in the server calls it. Tests share this module's state and must not inherit
 * each other's.
 */
export function forgetDrivenSession(sessionId: string): void {
  known.delete(sessionId);
  inFlight.delete(sessionId);
}
