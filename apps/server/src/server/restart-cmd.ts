/**
 * `seedeep restart` — replace the running server with a fresh one, and wait until the replacement
 * says it is serving.
 *
 * It asks the server to do it (`POST /api/restart`), rather than killing a pid and spawning:
 * the server already knows how to hand over — it spawns its successor detached and exits — and a
 * second implementation of that would be a second thing to keep true.
 *
 * **The wait is the point.** The new server gets a NEW pid, so returning as soon as the POST is
 * answered would report a restart that may never have completed. It waits for a record that is
 * neither the old pid nor absent, exactly as `seedeep open` waits for a first start.
 *
 * Nothing running is not an error: it starts one (the maintainer's call, 2026-08-05). The browser is NOT
 * opened — this subcommand is about the process; the window is what `open` is for.
 */

import type { SeedDeepConfig } from './config.ts';
import { type OpenDeps, portOf, type StartedServer, serverLogPath, spawnDetachedServer } from './open-cmd.ts';
import { authFor, trustOwnCert } from './own-server.ts';
import { type RunningServerRecord, runningServers } from './run-state.ts';

/** How long the replacement has to announce itself. Same budget as a cold start, for the same
 * reason: it IS a cold start, with a shutdown in front of it. */
const RESTART_TIMEOUT_MS = 15_000;
const STEP_MS = 150;

/**
 * What asking for the swap produced. Three outcomes, not one number, because two of them used to be
 * the same `0`: a connection dropped mid-handover is this request's NORMAL ending — it asks a
 * process to exit — while a connection that was never established means the server never heard the
 * request at all. Treating the second as the first made the command spawn a replacement against a
 * server that was still running, and then blame the replacement.
 */
export type PostOutcome =
  | { kind: 'answered'; status: number }
  | { kind: 'disconnected' }
  | { kind: 'unreachable'; reason: string };

/** What {@link runRestart} needs beyond {@link OpenDeps} — the HTTP call that asks for the swap. */
export interface RestartDeps extends Omit<OpenDeps, 'openBrowser'> {
  post: (url: string, token: string | null) => Promise<PostOutcome>;
  timeoutMs?: number;
}

/** Wait until a record on `port` exists whose pid is not `was`. Returns it, or null on timeout. */
async function awaitServer(
  port: number,
  was: number | null,
  deps: RestartDeps,
  child: StartedServer | null,
): Promise<RunningServerRecord | null> {
  const ticks = (deps.timeoutMs ?? RESTART_TIMEOUT_MS) / STEP_MS;
  for (let i = 0; i < ticks; i++) {
    await deps.sleep(STEP_MS);
    const found = (await deps.servers()).find((s) => portOf(s.baseUrl) === port && s.pid !== was);
    if (found) return found;
    if (child?.hasExited()) return null;
  }
  return null;
}

/** Run `seedeep restart`. Returns the process exit code. */
export async function runRestart(port: number, deps: RestartDeps): Promise<number> {
  const servers = await deps.servers();
  const current = servers.find((s) => portOf(s.baseUrl) === port);

  if (!current) {
    if (servers.length > 0) {
      deps.error(
        `seedeep: no server on port ${port}, and these are running:\n` +
          servers.map((s) => `  ${s.baseUrl}  (pid ${s.pid})`).join('\n') +
          `\nRestart one of them with \`seedeep restart --port <port>\`.`,
      );
      return 1;
    }
    const child = deps.startServer(port);
    const started = await awaitServer(port, null, deps, child);
    if (!started) {
      deps.error(`seedeep was not running and the one just started did not come up. See ${deps.logPath}`);
      return 1;
    }
    deps.log(`seedeep was not running — started ${started.baseUrl}`);
    return 0;
  }

  const outcome = await deps.post(`${current.baseUrl}/api/restart`, authFor(current, deps.config));
  // Nothing was asked of anybody: say so, and stop. Spawning a replacement here is what put a second
  // server against a first that was still holding the port.
  if (outcome.kind === 'unreachable') {
    deps.error(
      `seedeep: could not reach the server on port ${port} to ask it to restart — ${outcome.reason}. ` +
        `It is still running (pid ${current.pid}); \`seedeep stop\` then \`seedeep start\` does not use the network.`,
    );
    return 1;
  }
  // A server that ANSWERED and said no is a refusal — most usefully 401, a token that does not match.
  if (outcome.kind === 'answered' && outcome.status !== 200) {
    deps.error(`seedeep: the server on port ${port} refused the restart (HTTP ${outcome.status}).`);
    return 1;
  }
  const replacement = await awaitServer(port, current.pid, deps, null);
  if (!replacement) {
    // WHICH half failed is the whole value of this message. The old server still holding its record
    // is a different fault from a handover that started and never finished, and the first one used
    // to be reported as the second.
    const stillThere = (await deps.servers()).some((s) => s.pid === current.pid);
    deps.error(
      stillThere
        ? `seedeep: the server on port ${port} took the request but did not stop — pid ${current.pid} is still running. See ${deps.logPath}`
        : `seedeep: the old server stopped, but no replacement announced itself. See ${deps.logPath}`,
    );
    return 1;
  }
  deps.log(`seedeep restarted — ${replacement.baseUrl} (pid ${current.pid} → ${replacement.pid})`);
  return 0;
}

/**
 * Error codes that mean the request never reached anything — measured on this platform:
 * `ConnectionRefused` for a closed port, `DEPTH_ZERO_SELF_SIGNED_CERT` for an untrusted certificate.
 * The `CERT`/`_SSL_` families are included because every one of them fails the handshake, which is
 * before any byte of the request is sent.
 */
const NEVER_CONNECTED = /^(ConnectionRefused|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT)$|CERT|_SSL_/;

/** Wire {@link runRestart} to the real process table and network. */
export async function restartCommand(port: number, config: SeedDeepConfig): Promise<number> {
  const logPath = serverLogPath();
  return runRestart(port, {
    config,
    servers: () => runningServers(),
    startServer: (p) => spawnDetachedServer(p, logPath),
    log: (line) => console.log(line),
    error: (line) => console.error(line),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    logPath,
    post: async (url, token) => {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: token ? { authorization: `Bearer ${token}` } : {},
          // In remote mode seedeep serves its OWN self-signed certificate, which `fetch` rejects —
          // measured: `DEPTH_ZERO_SELF_SIGNED_CERT`, so the request never left this process and the
          // server never heard it. The answer is to trust THAT certificate, the one this machine
          // generated and holds on disk, rather than to stop verifying: `rejectUnauthorized: false`
          // would accept any certificate at all, on the one request that can stop a server.
          tls: await trustOwnCert(url, config),
        });
        return { kind: 'answered', status: res.status };
      } catch (err) {
        // Classifies the MESSAGE, never the outcome: whether the restart worked is decided by the
        // records, below. This only separates "never connected" from "connection dropped after it
        // was established", which for this request is the normal ending.
        const code = (err as { code?: string }).code ?? '';
        return NEVER_CONNECTED.test(code)
          ? { kind: 'unreachable', reason: (err as Error).message }
          : { kind: 'disconnected' };
      }
    },
  });
}
