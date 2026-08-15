/**
 * `seedeep self-update` — install the newer version through the channel this copy came from, then
 * put the running server back on the new code.
 *
 * **It is a seedeep verb, not a package-manager command typed by an agent**, and that is the whole
 * design. Inside Claude Code the `/seedeep` command file pre-approves `Bash(seedeep:*)` and nothing
 * else, so this is a call the model can already make, while `bun install -g …` would be a package
 * install asking for a permission of its own. The order — install, verify, only then restart — lives
 * here in tested code rather than in a prompt that has to remember it.
 *
 * **What it refuses is as important as what it does.** A downloaded executable and a checkout are
 * not installed by a package manager at all, and on Windows a running `.exe` cannot be replaced
 * while it runs. Each of those gets the sentence that actually resolves it, never an install that
 * half-happens. Being AHEAD of npm is refused too: that is a build of your own, and "update" would
 * mean overwriting it with an older one.
 *
 * **The install's exit code is not the evidence.** Under bun, a missing `--trust` blocks the script
 * that puts the binary in place and the install still reports success, so the version the binary on
 * disk reports afterwards is what decides — and the server is restarted only once that changed.
 */

import { spawn } from 'node:child_process';
import type { SeedDeepConfig } from './config.ts';
import { portOf } from './open-cmd.ts';
import { restartCommand } from './restart-cmd.ts';
import { type RunningServerRecord, runningServers } from './run-state.ts';
import { type UpdateStatus, updateStatus } from './update-check.ts';
import { type Channel, detectChannel, ownExecPath, planSelfUpdate, type SelfUpdatePlan } from './update-cmd.ts';

/** What {@link runSelfUpdate} needs: the plan's inputs, the install, and the two things it checks. */
export interface SelfUpdateDeps {
  channel: Channel;
  platform: NodeJS.Platform;
  status: () => Promise<UpdateStatus>;
  /** Run the channel's command with its output going straight to the user. Returns its exit code. */
  install: (argv: string[]) => Promise<number>;
  /** What the binary on disk reports NOW — `null` when it could not be asked. */
  installedVersion: () => Promise<string | null>;
  servers: () => Promise<RunningServerRecord[]>;
  /** Replace the running server. Returns its exit code. */
  restart: () => Promise<number>;
  log: (line: string) => void;
  error: (line: string) => void;
}

/**
 * Run `seedeep self-update`: refuse, or install and then restart. Returns the process exit code.
 *
 * The server is left running across the install — a failed one then changes nothing at all — and is
 * restarted only after the binary on disk is confirmed to have changed.
 */
export async function runSelfUpdate(port: number, deps: SelfUpdateDeps): Promise<number> {
  const plan = planSelfUpdate(deps.channel, deps.platform);
  if (plan.kind === 'refused') {
    deps.error(`seedeep: ${plan.reason}`);
    return 1;
  }

  const status = await deps.status();
  if (status.standing === 'current') {
    deps.log(`seedeep ${status.current} is the current version — nothing to install.`);
    return 0;
  }
  if (status.standing === 'ahead') {
    // Refused, not merely skipped: installing npm's version here would REPLACE a newer build with an
    // older one, which is the opposite of what the word "update" promises.
    deps.error(
      `seedeep: you are running ${status.current}, ahead of npm's ${status.latest} — ` +
        `installing would downgrade it. \`${plan.command}\` does it anyway, if that is what you want.`,
    );
    return 1;
  }

  deps.log(
    status.latest
      ? `seedeep ${status.current} → ${status.latest}, running \`${plan.command}\``
      : `seedeep ${status.current}, running \`${plan.command}\` (npm could not be asked which version is current)`,
  );
  const code = await deps.install(plan.argv);
  if (code !== 0) {
    deps.error(
      `seedeep: \`${plan.command}\` failed (exit ${code}) — nothing was replaced, and the server was not touched.`,
    );
    return 1;
  }

  const now = await deps.installedVersion();
  if (now === null) {
    deps.error(
      'seedeep: the install reported success, but the new executable could not be asked for its version — ' +
        'the server was left alone. `seedeep status` says what is running.',
    );
    return 1;
  }
  if (now === status.current) {
    // The bun failure mode this check exists for: without `--trust` the postinstall that puts the
    // binary in place never runs, and the install still exits 0.
    deps.error(
      `seedeep: \`${plan.command}\` reported success but the executable still reports ${now} — ` +
        'nothing was replaced. Run it in your terminal to see what it did.',
    );
    return 1;
  }
  if (status.latest && now !== status.latest) {
    deps.log(`seedeep: installed ${now}, though npm reported ${status.latest} as current.`);
  }

  const running = (await deps.servers()).some((s) => portOf(s.baseUrl) === port);
  if (!running) {
    deps.log(
      `seedeep ${now} installed. No server was running on port ${port} — the next \`seedeep open\` is the new code.`,
    );
    return 0;
  }
  deps.log(`seedeep ${now} installed — restarting the server so it runs the new code.`);
  return deps.restart();
}

/**
 * What `/seedeep self-update` prints BEFORE anything is installed.
 *
 * The slash command's `` !`…` `` block is preprocessing — it runs before Claude Code sees a word, it
 * blocks the turn, and its output is pasted into the session whole. A package install there would be
 * tens of seconds of silence followed by a wall of log, which is why the install is left to a Bash
 * call the model makes with the output where a tool result belongs. This says what that call would
 * do, so a refusal or an already-current install ends the turn without running anything.
 */
export function selfUpdatePreview(plan: SelfUpdatePlan, status: UpdateStatus, execPath: string): string {
  const lines = [`seedeep ${status.current} — ${execPath}`];
  if (plan.kind === 'refused') {
    lines.push(`seedeep cannot update itself here: ${plan.reason}`, 'Nothing to run.');
    return `${lines.join('\n')}\n`;
  }
  if (status.standing === 'current') {
    lines.push(`${status.current} is the current version — nothing to install. Nothing to run.`);
    return `${lines.join('\n')}\n`;
  }
  if (status.standing === 'ahead') {
    lines.push(
      `you are running ${status.current}, ahead of npm's ${status.latest} — a build of your own, and`,
      'installing would downgrade it. Nothing to run.',
    );
    return `${lines.join('\n')}\n`;
  }
  lines.push(
    status.latest
      ? `npm has ${status.latest}. This install can update itself:`
      : `npm could not be asked which version is current. This install can still update itself:`,
    '',
    `  seedeep self-update`,
    '',
    `It runs \`${plan.command}\`, checks that the executable really changed, and only then restarts`,
    'the running server so it serves the new code.',
  );
  return `${lines.join('\n')}\n`;
}

/** Print {@link selfUpdatePreview} for the real installation. Always 0 — it installs nothing. */
export async function runSelfUpdatePreview(
  out: { log: (s: string) => void } = { log: console.log },
  platform: NodeJS.Platform = process.platform,
): Promise<number> {
  const exe = ownExecPath();
  // Typed by a user, so it asks npm rather than the hour-old cache: this preview is what decides
  // whether the turn ends with "nothing to run".
  const status = await updateStatus({ force: true });
  out.log(selfUpdatePreview(planSelfUpdate(detectChannel(exe), platform), status, exe));
  return 0;
}

/**
 * Spawn a command with its output going to this process's stdout/stderr. Resolves to its exit code,
 * and never rejects: a package manager that cannot be started is a failed install to report, not an
 * exception thrown at a user mid-update.
 */
export function runToCompletion(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv as [string, ...string[]];
  return new Promise((resolve) => {
    const child = spawn(cmd, rest, { stdio: 'inherit', windowsHide: true });
    // A package manager that is not on PATH is a failed install, not a crash of this process: 127 is
    // what a shell reports for it, and the caller already prints the command that failed.
    child.on('error', () => resolve(127));
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

/** Ask the executable on disk which version it is. `null` when it could not be run or did not answer. */
async function askInstalledVersion(): Promise<string | null> {
  // Re-resolved HERE, after the install: a package manager replaces the whole `node_modules/seedeep`
  // directory, so a path resolved before it ran can name an inode that no longer exists.
  const exe = ownExecPath();
  return new Promise((resolve) => {
    const child = spawn(exe, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.on('error', () => resolve(null));
    child.on('exit', (code) => resolve(code === 0 && out.trim() ? out.trim() : null));
  });
}

/** Wire {@link runSelfUpdate} to the real channel, package manager, process table and restart. */
export async function selfUpdateCommand(port: number, config: SeedDeepConfig): Promise<number> {
  return runSelfUpdate(port, {
    channel: detectChannel(ownExecPath()),
    platform: process.platform,
    status: () => updateStatus({ force: true }),
    install: runToCompletion,
    installedVersion: askInstalledVersion,
    servers: () => runningServers(),
    restart: () => restartCommand(port, config),
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  });
}
