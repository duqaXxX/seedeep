import type { EventEmitter } from 'node:events';
import type { SessionRecord } from '../core/types.ts';
import { type CliOptions, parseArgs } from './args.ts';
import { openBrowser } from './browser.ts';
import { planClaudeCommand } from './claude-command.ts';
import { readConfig, resolveConfig, type SeedDeepConfig } from './config.ts';
import { discoverSessions } from './discovery.ts';
import { usage, versionLine } from './help.ts';
import { refreshOwnedCommandFile, runInstallCommand, staleCommandNotice } from './install-command.ts';
import { openCommand, startCommand } from './open-cmd.ts';
import { latestSessionInProject, runReport } from './report.ts';
import { restartCommand } from './restart-cmd.ts';
import { announce, withdraw } from './run-state.ts';
import { runSelfUpdatePreview, selfUpdateCommand } from './self-update-cmd.ts';
import { startServer } from './server.ts';
import { runStatus } from './status-cmd.ts';
import { stopCommand } from './stop-cmd.ts';
import { updateStatus } from './update-check.ts';
import { runUpdate } from './update-cmd.ts';
import { Watcher } from './watcher.ts';

export interface MainDeps {
  watcher: Pick<EventEmitter, 'on' | 'off'> & { start(): void; stop(): void };
  startServer: typeof startServer;
  discover: () => Promise<SessionRecord[]>;
  openBrowser: (url: string) => void;
  /**
   * Pre-resolved config. When provided, the CLI flags are still applied on top but
   * `readConfig` + `resolveConfig` are skipped (lets tests inject known state).
   */
  config?: SeedDeepConfig;
}

/** Apply only the CLI layer on top of a known config (used when deps.config is injected). */
function applyCliFlags(config: SeedDeepConfig, opts: ReturnType<typeof parseArgs>): SeedDeepConfig {
  const out = { ...config, auth: { ...config.auth }, tls: { ...config.tls } };
  if (opts.port !== undefined) out.port = opts.port;
  if (opts.host !== undefined) out.host = opts.host;
  if (opts.open !== undefined) out.open = opts.open;
  return out;
}

/**
 * Wire the app together and start it. Parses `argv`, resolves config (file → env → CLI),
 * starts the server and watcher, and (unless `open` is false) opens the browser. All
 * collaborators are injected via `deps` so tests can drive it without real I/O. Returns a
 * `stop()` that tears the watcher and server back down.
 */
export async function run(argv: string[], deps: MainDeps): Promise<{ stop(): void }> {
  const opts = parseArgs(argv);
  const config = deps.config
    ? applyCliFlags(deps.config, opts)
    : await resolveConfig(opts, process.env as Record<string, string | undefined>, await readConfig());

  const server = await deps.startServer({
    watcher: deps.watcher as unknown as EventEmitter,
    discover: deps.discover,
    port: config.port,
    host: config.host,
    config,
  });
  deps.watcher.start();
  // After the bind, never before: the record carries the address this server actually answers on,
  // and a port that was taken is a server that never existed. Not awaited — announcing is a
  // courtesy to the tray, and nothing about serving should wait on a file.
  void announce({ pid: process.pid, baseUrl: server.url });
  console.log(`seedeep watching — ${server.openUrl}`);
  // Said BEFORE the fingerprint, so the value below reads as the new one. A replacement is the
  // only moment a pinned client is silently broken, and the user cannot infer it from a
  // fingerprint they have no old value to compare against.
  if (server.tlsCertOrigin === 'replaced') {
    console.log(
      `seedeep TLS: the stored certificate did not cover "${config.tls.commonName}" — ` +
        'a new one was generated. Any client pinned to the previous fingerprint must be re-pinned.',
    );
  }
  // Every start, not just the one that generated the cert: this is the value a non-browser
  // client pins, and it is only checkable if the user can read it when they set that client up.
  if (server.tlsFingerprint) {
    console.log(`seedeep TLS cert fingerprint: ${server.tlsFingerprint}`);
  }
  if (config.open) deps.openBrowser(server.openUrl);
  return {
    stop() {
      deps.watcher.stop();
      server.stop();
      // Synchronous, unlike the announce: `process.exit(0)` follows this call, and a record that
      // outlived its process can be pointed at whatever the OS gives that pid next.
      withdraw();
    },
  };
}

/**
 * Dispatch a subcommand that is not `serve`. Returns the exit code, or `null` when `argv` asks
 * for the server — the case `main()` goes on to handle.
 */
async function runSubcommand(argv: string[]): Promise<number | null> {
  const opts = parseArgs(argv);
  switch (opts.command) {
    case 'serve':
      return null;
    case 'help':
      console.log(usage());
      return 0;
    case 'version':
      console.log(versionLine());
      return 0;
    case 'install-command':
      return runInstallCommand({ force: opts.force });
    case 'status':
      return withConfig(opts, (port, config) => runStatus(port, config));
    case 'update':
      return runUpdate({ offline: opts.offline });
    case 'self-update':
      return withConfig(opts, selfUpdateCommand);
    case 'report':
      return reportHere(opts);
    case 'open':
      return withConfig(opts, openCommand);
    case 'start':
      return withConfig(opts, startCommand);
    case 'stop':
      return withConfig(opts, (port) => stopCommand(port));
    case 'restart':
      return withConfig(opts, restartCommand);
    case 'claude-code':
      return runClaudeCommand(opts);
    default: {
      // Exhaustive by TYPE, not by a fallback: the tail used to be `… : openCommand`, so a
      // subcommand added to the union and forgotten here would silently START A SERVER and open a
      // browser. Now it fails to compile instead.
      const never: never = opts.command;
      throw new Error(`unhandled subcommand ${String(never)}`);
    }
  }
}

/**
 * `seedeep report` from a console, where no session id is at hand: without `--session`, the newest
 * session of the project this directory belongs to. Said on stderr, so the report itself stays the
 * only thing on stdout.
 */
async function reportHere(opts: CliOptions): Promise<number> {
  if (opts.session) return runReport(opts.session, { full: opts.full });
  const found = await latestSessionInProject(process.cwd());
  if (!found) {
    console.error(
      `seedeep: no --session given, and ${process.cwd()} has no Claude Code sessions. ` +
        'Run it from a directory you have used Claude Code in, or pass `--session <id>`.',
    );
    return 1;
  }
  console.error('seedeep: no --session given — reporting the newest session of this directory.');
  return runReport(found, { full: opts.full });
}

/** The `/seedeep` entry point: one word decides, and an unknown one has already been refused. */
async function runClaudeCommand(opts: CliOptions): Promise<number> {
  const plan = planClaudeCommand(opts.rest ?? []);
  if (plan.kind === 'error') {
    console.error(plan.message);
    return 1;
  }
  // Before the command's own output, so what the user asked for stays the last thing said — and so
  // a report's closing "this cost ~N tokens" is not pushed off the end by a notice.
  const stale = await staleCommandNotice();
  if (stale) console.error(stale);
  switch (plan.kind) {
    case 'report':
      return runReport(plan.sessionId, { full: plan.full });
    case 'status':
      return withConfig(opts, (port, config) => runStatus(port, config));
    case 'update':
      return runUpdate();
    // The PREVIEW, never the install: this runs inside Claude Code's preprocessing, which blocks the
    // turn and pastes whatever it prints. The install is the `seedeep self-update` the model then
    // runs as a Bash call — pre-approved by the command file's `Bash(seedeep:*)`.
    case 'self-update':
      return runSelfUpdatePreview();
    case 'stop':
      return withConfig(opts, (port) => stopCommand(port));
    case 'start':
      return withConfig(opts, startCommand);
    case 'restart':
      return withConfig(opts, restartCommand);
    case 'open':
      return withConfig(opts, openCommand);
  }
}

/** Resolve the config (file → env → CLI) and hand the subcommand the port it should act on. */
async function withConfig(
  opts: CliOptions,
  run: (port: number, config: SeedDeepConfig) => Promise<number>,
): Promise<number> {
  const config = await resolveConfig(opts, process.env as Record<string, string | undefined>, await readConfig());
  return run(opts.port ?? config.port, config);
}

function main(): void {
  runSubcommand(process.argv.slice(2))
    .then((code) => {
      if (code !== null) process.exit(code);
      serve();
    })
    .catch((err: Error) => {
      console.error(`seedeep: ${err.message}`);
      process.exit(1);
    });
}

function serve(): void {
  run(process.argv.slice(2), {
    watcher: new Watcher(),
    startServer,
    discover: () => discoverSessions(),
    openBrowser,
    // no `config` → reads from disk
  })
    .then((handle) => {
      // HERE and not in `run()`: `run()` is what the tests drive, and a refresh there would reach
      // into the developer's real `~/.claude` and rewrite their command file as a side effect of
      // `bun run test`. Never awaited and never fatal — serving must not wait on, or be stopped by,
      // another tool's directory — so the rejection is caught rather than left to the runtime.
      refreshOwnedCommandFile()
        .then((line) => {
          if (line) console.log(line);
        })
        .catch(() => {});
      // Warm the update cache, for the same reason and in the same way: HERE rather than in `run()`,
      // so `bun run test` never reaches the registry. It is what makes the line after `open` and
      // `start` reachable AT ALL for someone who uses neither the portal nor the tray — those two
      // are otherwise the only things that ever refresh the cache, and a CLI-only user would keep an
      // empty one forever. Not awaited: nothing about serving should wait on npm, and the TTL means
      // a restart costs a request only once an hour.
      updateStatus().catch(() => {});
      const shutdown = () => {
        handle.stop();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    })
    .catch((err: Error) => {
      console.error('seedeep failed to start:', err.message);
      process.exit(1);
    });
}

// Run only when executed directly (not when imported by tests).
if (import.meta.main) main();
