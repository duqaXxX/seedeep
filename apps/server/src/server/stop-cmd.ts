/**
 * `seedeep stop` — end the server on this machine the way a terminal's Ctrl-C would.
 *
 * By SIGNAL and not by an endpoint, unlike `restart`: there is no `/api/stop`, and the reason not
 * to add one is that a running server is already addressable by pid through its own record. The
 * signal is **SIGTERM, never SIGKILL** — the server's handler stops the watcher, closes the
 * listener and withdraws its record synchronously, while a killed one leaves that record behind for
 * a recycled pid to inherit, which is the single thing the record's design set out to prevent. The
 * tray reached the same conclusion for its Stop button; this is that rule in TypeScript.
 *
 * It then WAITS for the record to go, so "stopped" is something observed rather than assumed.
 */

import { type OpenDeps, portOf } from './open-cmd.ts';
import { type RunningServerRecord, runningServers } from './run-state.ts';

/** How long the server has to withdraw its record after being asked to stop. */
const STOP_TIMEOUT_MS = 5000;
const STEP_MS = 150;

/** What {@link runStop} needs: the process table, and a way to signal one of its members. */
export interface StopDeps extends Pick<OpenDeps, 'servers' | 'log' | 'error' | 'sleep'> {
  /** Send SIGTERM. Returns false when the process could not be signalled at all. */
  signal: (pid: number) => boolean;
  timeoutMs?: number;
}

/** Run `seedeep stop`. Returns the process exit code. */
export async function runStop(port: number, deps: StopDeps): Promise<number> {
  const servers = await deps.servers();
  const target = servers.find((s: RunningServerRecord) => portOf(s.baseUrl) === port);

  if (!target) {
    if (servers.length === 0) {
      deps.log('seedeep is not running.');
      return 0; // asking for a state that already holds is not a failure
    }
    deps.error(
      `seedeep: no server on port ${port}, and these are running:\n` +
        servers.map((s) => `  ${s.baseUrl}  (pid ${s.pid})`).join('\n') +
        `\nStop one of them with \`seedeep stop --port <port>\`.`,
    );
    return 1;
  }

  if (!deps.signal(target.pid)) {
    deps.error(`seedeep: could not signal pid ${target.pid} — it may belong to another user.`);
    return 1;
  }

  const ticks = (deps.timeoutMs ?? STOP_TIMEOUT_MS) / STEP_MS;
  for (let i = 0; i < ticks; i++) {
    await deps.sleep(STEP_MS);
    if (!(await deps.servers()).some((s) => s.pid === target.pid)) {
      deps.log(`seedeep stopped — ${target.baseUrl} (pid ${target.pid}).`);
      return 0;
    }
  }
  // Reported, never escalated to SIGKILL: a server that ignored SIGTERM is a bug worth seeing, and
  // killing it would leave behind exactly the record its shutdown exists to withdraw.
  deps.error(`seedeep: pid ${target.pid} was asked to stop and is still running.`);
  return 1;
}

/** Wire {@link runStop} to the real process table. */
export async function stopCommand(port: number): Promise<number> {
  return runStop(port, {
    servers: () => runningServers(),
    log: (line) => console.log(line),
    error: (line) => console.error(line),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    // LIMIT: on Windows there is no SIGTERM — the runtime terminates the process instead, so the
    // shutdown handler never runs and the record is left for the next start's sweep to clear. The
    // tray documents the same limit for its `taskkill /F`.
    signal: (pid) => {
      try {
        process.kill(pid, 'SIGTERM');
        return true;
      } catch {
        return false;
      }
    },
  });
}
