/**
 * How a running server says so, for anything that is not a browser.
 *
 * The tray has to answer two questions no HTTP request can: is a server RUNNING here (as opposed to
 * "nothing answered", which a wedged process and an unconfigured port produce alike), and what
 * process is it, so it can be stopped. So each server writes a small record while it runs and takes
 * it back when it exits — `docs/architecture.md`, *Announcing a running server*.
 *
 * ONE FILE PER PROCESS, named after its pid, the way Claude Code itself registers its open sessions
 * in `~/.claude/sessions/<pid>.json` — which `open-sessions.ts` already reads. A single shared file
 * would be overwritten by the second server on the machine (`--port 9000` beside the default one is
 * in the README), and the reader would then hand out one server's address with another's pid: a
 * "stop" that kills the wrong process. That is not a limitation worth documenting, so the shape
 * rules it out instead.
 *
 * Liveness is never taken from the file. A process killed with SIGKILL, or lost to a crash, leaves
 * its record behind; `process.kill(pid, 0)` is what says whether anything is still there.
 */

import { rmSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { seedDeepDir } from './config.ts';
import { isAlive } from './open-sessions.ts';

/** A server that is up: which process it is, and where it answers. */
export interface RunningServerRecord {
  pid: number;
  /** Scheme, host and port — never the token: this file is read to CONNECT, not to authorise. */
  baseUrl: string;
}

/** The directory the records live in — under {@link seedDeepDir}, so `SEEDEEP_HOME` moves it too. */
export function runStateDir(home = homedir()): string {
  return join(seedDeepDir(home), 'servers');
}

/**
 * Publish this process as a running server, and clear away the records of processes that are gone.
 *
 * The sweep happens HERE rather than in {@link runningServers} because a read that deletes is a
 * surprise for its caller, and a start is the moment where the cost is already paid. Never throws:
 * a server that could not announce itself is still a server, and failing to start over it would
 * turn a convenience into a dependency.
 */
export async function announce(record: RunningServerRecord, home = homedir()): Promise<void> {
  const dir = runStateDir(home);
  try {
    await mkdir(dir, { recursive: true });
    await Promise.all(
      (await readdir(dir)).map(async (name) => {
        const pid = Number.parseInt(name, 10);
        if (Number.isFinite(pid) && !isAlive(pid)) await rm(join(dir, name), { force: true });
      }),
    );
    await writeFile(join(dir, `${record.pid}.json`), JSON.stringify(record));
  } catch {
    /* the tray loses a shortcut, not the server */
  }
}

/**
 * Take this process's record back. Called on the way out; a crash leaves it to the next sweep.
 *
 * SYNCHRONOUS, and that is the whole point: the shutdown path is `stop(); process.exit(0)`, so an
 * awaited unlink would lose the race and every clean exit would leave a record behind. A lingering
 * record is not merely untidy — an OS that recycles the pid makes it describe an unrelated process,
 * and this file exists so that something can be stopped by pid.
 */
export function withdraw(pid = process.pid, home = homedir()): void {
  try {
    rmSync(join(runStateDir(home), `${pid}.json`), { force: true });
  } catch {
    /* nothing to take back */
  }
}

/**
 * Every server currently running on this machine, dead records excluded.
 *
 * A record whose process is gone is not reported and not repaired: this is the read path, and the
 * next {@link announce} sweeps. An unreadable or malformed file is simply not a server.
 */
export async function runningServers(home = homedir()): Promise<RunningServerRecord[]> {
  const dir = runStateDir(home);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: RunningServerRecord[] = [];
  for (const name of names) {
    const pid = Number.parseInt(name, 10);
    if (!Number.isFinite(pid) || !isAlive(pid)) continue;
    try {
      const parsed: unknown = JSON.parse(await readFile(join(dir, name), 'utf8'));
      const rec = parsed as Partial<RunningServerRecord>;
      // The pid in the NAME is the one that was proven alive; a file claiming a different one is
      // either hand-edited or a leftover from a recycled pid, and neither is a server to stop.
      if (rec?.pid === pid && typeof rec.baseUrl === 'string' && rec.baseUrl) {
        out.push({ pid, baseUrl: rec.baseUrl });
      }
    } catch {
      /* not a record */
    }
  }
  return out;
}
