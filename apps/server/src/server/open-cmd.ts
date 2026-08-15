/**
 * `seedeep open` — make the GUI visible from a console, whatever the server's state.
 *
 * Server up: open the browser on it. Server down: start one, wait until it says it is serving,
 * then open the browser. The two cases differ in how long they take and in nothing else, which is
 * what lets a one-line `/seedeep` command in Claude Code do the whole job.
 *
 * The start is DETACHED (`docs/architecture.md`, *Opening the GUI from a console*). A server
 * started as a child of the shell Claude Code opens dies when that session ends — the GUI would
 * close under the user for a reason nothing on screen explains. The tray reached the same
 * conclusion for its Start button, and this is the same algorithm in TypeScript: snapshot the
 * running pids, spawn, then wait for a record that was not there before.
 */

import { spawn } from 'node:child_process';
import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { selfInvocation } from './args.ts';
import { openBrowser } from './browser.ts';
import { type SeedDeepConfig, seedDeepDir } from './config.ts';
import { type RunningServerRecord, runningServers } from './run-state.ts';
import { isLoopback } from './server.ts';
import { updateNotice, updateStatus } from './update-check.ts';
import { FROM_SOURCE } from './version.ts';

/** How long a spawned server has to announce itself before the wait is called off. */
const START_TIMEOUT_MS = 15_000;
/** Gap between two reads of the run-state directory while waiting. */
const STEP_MS = 150;

/** What `seedeep open` should do about the servers it found. */
export type OpenPlan =
  | { kind: 'start' }
  | { kind: 'open'; server: RunningServerRecord }
  | { kind: 'ambiguous'; servers: RunningServerRecord[] };

/** The port a record answers on, from its `baseUrl`; `null` when the URL cannot be parsed. */
export function portOf(baseUrl: string): number | null {
  try {
    const u = new URL(baseUrl);
    return u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  } catch {
    return null;
  }
}

/**
 * Decide what to do, given every running server and the port the resolved config points at.
 *
 * Matching is by PORT alone: the config's `host` is a BIND address (`0.0.0.0` binds everything)
 * while a record carries a connect address, so comparing the two would report a mismatch for a
 * server that is exactly the right one.
 *
 * Nothing running means start. A record on the configured port is the server to open. Servers
 * running but none on that port is NOT a reason to start a second one silently: with two servers
 * up, opening the wrong one is indistinguishable from success — the GUI appears, sessions are
 * listed, and nothing says it is the other process. So it reports what is there and stops.
 */
export function planOpen(servers: RunningServerRecord[], port: number): OpenPlan {
  if (servers.length === 0) return { kind: 'start' };
  const matching = servers.filter((s) => portOf(s.baseUrl) === port);
  const only = matching[0];
  if (matching.length === 1 && only) return { kind: 'open', server: only };
  return { kind: 'ambiguous', servers };
}

/**
 * The URL to hand the browser for `server` — the token appended exactly as the server itself
 * would (`startServer`'s `openUrl`).
 *
 * A record deliberately holds no token: it is read to connect, not to authorise. So for a
 * non-loopback server the secret comes from the config file, which only something running on
 * this machine as this user can read — the reason this logic lives in the binary and not in the
 * `/seedeep` command file.
 */
export function openUrlFor(server: RunningServerRecord, config: SeedDeepConfig): string {
  let hostname: string;
  try {
    hostname = new URL(server.baseUrl).hostname;
  } catch {
    return server.baseUrl;
  }
  if (isLoopback(hostname)) return server.baseUrl;
  return `${server.baseUrl}/?token=${encodeURIComponent(config.auth.token)}`;
}

/** A spawned server, seen from the parent that has to decide whether it is coming up. */
export interface StartedServer {
  /** True once the process has exited — a start that failed, since a live server never exits. */
  hasExited(): boolean;
}

/** Everything {@link runOpen} touches outside itself, so a test can drive it without processes. */
export interface OpenDeps {
  config: SeedDeepConfig;
  servers: () => Promise<RunningServerRecord[]>;
  startServer: (port: number) => StartedServer;
  openBrowser: (url: string) => void;
  log: (line: string) => void;
  error: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  logPath: string;
  timeoutMs?: number;
  /**
   * The "a newer version exists" line, or null. Reads the CACHE and never the network — see
   * {@link liveDeps}.
   */
  notice?: () => Promise<string | null>;
}

/** A server known to be up, and whether this call is what started it. */
type Ensured = { ok: true; server: RunningServerRecord; started: boolean } | { ok: false };

/**
 * Get a server running on `port`, whatever state the machine was in, and report nothing on its
 * own except failures — the CALLER decides what to say, because `open` and `start` differ in
 * exactly that and in nothing else.
 */
async function ensureRunning(port: number, deps: OpenDeps, verb: 'open' | 'start'): Promise<Ensured> {
  const plan = planOpen(await deps.servers(), port);

  if (plan.kind === 'ambiguous') {
    deps.error(
      `seedeep: no server on port ${port}, and these are running:\n` +
        plan.servers.map((s) => `  ${s.baseUrl}  (pid ${s.pid})`).join('\n') +
        `\nUse \`seedeep ${verb} --port <port>\` for one of them, or stop it and start yours.`,
    );
    return { ok: false };
  }
  if (plan.kind === 'open') return { ok: true, server: plan.server, started: false };

  const child = deps.startServer(port);
  const deadline = (deps.timeoutMs ?? START_TIMEOUT_MS) / STEP_MS;
  for (let tick = 0; tick < deadline; tick++) {
    await deps.sleep(STEP_MS);
    const started = (await deps.servers()).find((s) => portOf(s.baseUrl) === port);
    if (started) return { ok: true, server: started, started: true };
    // Checked AFTER the record, never before: a server that announced itself and then exited did
    // start, and reporting the exit would contradict the thing that just happened.
    if (child.hasExited()) {
      deps.error(`seedeep exited while starting. What it printed is in ${deps.logPath}`);
      return { ok: false };
    }
  }
  deps.error(
    `seedeep did not announce itself within ${Math.round((deps.timeoutMs ?? START_TIMEOUT_MS) / 1000)}s. ` +
      `It may still be coming up; what it printed is in ${deps.logPath}`,
  );
  return { ok: false };
}

/**
 * Run `seedeep open`. Returns the process exit code: 0 when a browser was opened, 1 when it was
 * not, and the reason has already gone to {@link OpenDeps.error}.
 */
export async function runOpen(port: number, deps: OpenDeps): Promise<number> {
  const got = await ensureRunning(port, deps, 'open');
  if (!got.ok) return 1;
  deps.openBrowser(openUrlFor(got.server, deps.config));
  deps.log(`seedeep ${got.started ? 'started' : 'already running'} — ${got.server.baseUrl}`);
  await sayIfBehind(deps);
  return 0;
}

/**
 * Add the update line, when there is one. Last, so the address a user came for is the first thing
 * printed, and never fatal: a version check cannot be what makes `open` fail.
 */
async function sayIfBehind(deps: OpenDeps): Promise<void> {
  try {
    const line = await deps.notice?.();
    if (line) deps.log(line);
  } catch {
    /* an unreadable cache is not this command's problem */
  }
}

/**
 * Run `seedeep start` — the same as `open` without the browser, and the counterpart of
 * `seedeep stop`. A server already running is a success and says so: starting something that is
 * started is not a failure, exactly as stopping something already stopped is not.
 */
export async function runStart(port: number, deps: OpenDeps): Promise<number> {
  const got = await ensureRunning(port, deps, 'start');
  if (!got.ok) return 1;
  deps.log(`seedeep ${got.started ? 'started' : 'already running'} — ${got.server.baseUrl}`);
  await sayIfBehind(deps);
  return 0;
}

/** Where a server started by `seedeep open` sends its output — the file the tray also writes. */
export function serverLogPath(home = homedir()): string {
  return join(seedDeepDir(home), 'server.log');
}

/**
 * Spawn this same executable as a detached server and hand back a handle to watch it die.
 *
 * `detached: true` is `setsid` on POSIX (measured: the child's ppid becomes 1 and it gets its own
 * process group), so a Ctrl-C or a closing session in the parent's terminal does not take the
 * server with it. `stdio` goes to a file rather than a pipe for the same reason it must not be
 * inherited: the caller may be Claude Code's `` !`seedeep open` `` preprocessing, which reads the
 * output to completion — an inherited pipe held open by a server that never exits would hang it.
 *
 * The log is 0600 BOTH at creation and after: a non-loopback server prints a URL carrying the
 * token, and `mode` on open applies only when the file did not exist.
 */
export function spawnDetachedServer(
  port: number,
  logPath: string,
  invocation = selfInvocation(process.execPath, Bun.main, FROM_SOURCE),
): StartedServer {
  mkdirSync(dirname(logPath), { recursive: true });
  const fd = openSync(logPath, 'w', 0o600);
  chmodSync(logPath, 0o600);
  const [exe, ...entry] = invocation as [string, ...string[]];
  const child = spawn(exe, [...entry, 'serve', '--no-open', '--port', String(port)], {
    detached: true,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  });
  // The child holds its own duplicate; this process has no reason to keep the descriptor open.
  closeSync(fd);
  child.unref();
  let exited = false;
  child.on('exit', () => {
    exited = true;
  });
  child.on('error', () => {
    exited = true;
  });
  return { hasExited: () => exited };
}

/** The real filesystem, browser and process table, shared by `open` and `start`. */
function liveDeps(config: SeedDeepConfig): OpenDeps {
  const logPath = serverLogPath();
  return {
    config,
    servers: () => runningServers(),
    startServer: (p) => spawnDetachedServer(p, logPath),
    openBrowser,
    log: (line) => console.log(line),
    error: (line) => console.error(line),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    logPath,
    // `offline`, so the CACHE is read and the registry is never asked here. A first run with an
    // empty cache would otherwise pay up to the check's timeout before printing the address the
    // user actually ran this for — and under `/seedeep` that wait blocks Claude Code's turn. What
    // refreshes the cache is whatever has time to: the server answering `/api/update` for the
    // portal or the tray, and `seedeep update` itself.
    notice: async () => updateNotice(await updateStatus({ offline: true })),
  };
}

/** Wire {@link runOpen} to the real world. */
export async function openCommand(port: number, config: SeedDeepConfig): Promise<number> {
  return runOpen(port, liveDeps(config));
}

/** Wire {@link runStart} to the real world. */
export async function startCommand(port: number, config: SeedDeepConfig): Promise<number> {
  return runStart(port, liveDeps(config));
}
