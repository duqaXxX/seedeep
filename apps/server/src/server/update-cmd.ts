/**
 * `seedeep update` — say which version is out there, how THIS installation is updated, and stop.
 *
 * **It asks npm, and leaves the answer in the cache every other surface reads**
 * ({@link updateStatus} with `force`): the reason to type this is usually having just heard there
 * is a new version, and an answer from earlier in the hour would say you are current when you are
 * not. The fresh answer replaces the cache, so the tray and the portal do not re-ask after it.
 * `--offline` skips the check entirely, and a registry that answered yesterday but not today still
 * gets its version reported — the advice never depends on the network being up right now.
 *
 * **It does not run the install**, and that is a separate decision from the network one. Under
 * `/seedeep` the shell runs inside Claude Code's preprocessing, which blocks the turn and captures
 * the output: a global install of a ~60MB package would hang the turn for tens of seconds with no
 * sign of progress and then paste the package manager's whole log into the session. The failure
 * modes are ones seedeep does not control either — bun blocks the postinstall unless `--trust`,
 * npm may ask to allow scripts — and they would arrive as that same wall of text, after the fact,
 * with `seedeep` possibly half-replaced.
 *
 * The CHANNEL, unlike the version, needs no network: it is read from where the executable lives.
 */

import { realpathSync } from 'node:fs';
import { type UpdateStatus, updateStatus } from './update-check.ts';
import { FROM_SOURCE, VERSION } from './version.ts';

/** How this copy of seedeep got here, and the one command that updates it. */
export type Channel =
  | { kind: 'bun'; command: string }
  | { kind: 'npm'; command: string }
  /** An executable downloaded from a release: updating it is replacing the file. */
  | { kind: 'download'; command: null }
  /** Running from source — the checkout is the thing to update, and git owns that. */
  | { kind: 'checkout'; command: null };

/**
 * Read the channel off the resolved path of the running executable.
 *
 * A package manager installs into `node_modules/seedeep/`, and bun's global root is
 * `$BUN_INSTALL/install/global` (measured 2026-08-09, bun 1.3.13, against both the default prefix
 * and a custom `BUN_INSTALL`: the `install/global/node_modules/` LAYOUT is bun's, while the prefix
 * NAME is the user's — so the layout is what is matched, and `.bun/` only as an older-install
 * fallback). npm cannot produce that segment: its own layout puts `lib/` in between,
 * `<prefix>/lib/node_modules/seedeep/`. Anything outside a `node_modules` is a file the user put
 * where it is — which is exactly what a downloaded release asset is.
 *
 * Reading the path, rather than asking bun for its global root, keeps this synchronous and pure:
 * an npm-installed seedeep has no reason to have bun on PATH, and the subprocess would decide the
 * channel on whether an unrelated tool happens to be installed.
 */
// LIMIT: only bun and npm are told apart. A global install by pnpm or yarn also lands in a
// `node_modules/seedeep/`, so it is reported as npm and shown npm's command — which for pnpm is the
// wrong manager. Their global layouts are not verified here (neither is installed on the machine
// this was written on), and guessing a path would be the same mistake in the other direction.
// Windows is unverified too: bun's layout there is assumed to be the same segment with backslashes,
// and the cost of being wrong is only a printed sentence, since `planSelfUpdate` refuses on win32.
export function detectChannel(realExecPath: string, fromSource = FROM_SOURCE): Channel {
  if (fromSource) return { kind: 'checkout', command: null };
  if (realExecPath.includes('/node_modules/seedeep/') || realExecPath.includes('\\node_modules\\seedeep\\')) {
    const bunLayout =
      realExecPath.includes('/install/global/node_modules/') ||
      realExecPath.includes('\\install\\global\\node_modules\\') ||
      realExecPath.includes('/.bun/') ||
      realExecPath.includes('\\.bun\\');
    return bunLayout
      ? { kind: 'bun', command: 'bun install -g seedeep --trust' }
      : { kind: 'npm', command: 'npm i -g seedeep@latest' };
  }
  return { kind: 'download', command: null };
}

/** Whether this installation can replace itself, and with which command. */
export type SelfUpdatePlan =
  | { kind: 'install'; command: string; argv: string[] }
  /** Nothing will be run: `reason` is the sentence that resolves it instead. */
  | { kind: 'refused'; reason: string };

/**
 * Decide whether `seedeep self-update` can run here, from the channel and the platform. It lives
 * beside {@link detectChannel} because it is a fact about the CHANNEL — what this installation is
 * able to do to itself — while running it is another file's job.
 *
 * The channel is asked first: `git pull` is the answer for a checkout on every platform, so
 * reporting Windows' limitation there would name the wrong obstacle.
 *
 * The argv is the command split on spaces, which is exact here and only here: these strings are this
 * file's own literals, with no quoting and no argument containing a space.
 */
export function planSelfUpdate(channel: Channel, platform: NodeJS.Platform): SelfUpdatePlan {
  switch (channel.kind) {
    case 'download':
      return {
        kind: 'refused',
        reason:
          'this seedeep is an executable you downloaded, not a package-manager install — updating it is ' +
          'replacing the file with the one from https://github.com/duqaXxX/seedeep/releases/latest',
      };
    case 'checkout':
      return {
        kind: 'refused',
        reason: 'this seedeep runs from a checkout — `git pull`, and the next `bun start` is the new code.',
      };
    case 'bun':
    case 'npm':
      // LIMIT: Windows locks a running executable against being replaced, so the package manager
      // would fail against the very binary it is installing over. Doing it anyway would need a
      // detached helper that outlives this process — not written, and not guessed at here.
      if (platform === 'win32') {
        return {
          kind: 'refused',
          reason:
            'on Windows a running executable cannot be replaced, so seedeep cannot update itself. Run ' +
            `\`seedeep stop\`, then \`${channel.command}\`, then \`seedeep start\`.`,
        };
      }
      return { kind: 'install', command: channel.command, argv: channel.command.split(' ') };
  }
}

/**
 * The line the check earns, said in the terms it can support.
 *
 * A known version wins over a failed attempt: with yesterday's `latest` in hand there is a real
 * answer to give, and reporting the outage instead would withhold it for no gain.
 */
function checkLine(status: UpdateStatus, offline: boolean): string {
  const { current, latest, standing, reason } = status;
  if (offline) return 'not checked for a newer version (--offline).';
  if (!latest) {
    return `could not ask npm which version is current — ${reason ?? 'no answer'}. What follows still holds.`;
  }
  switch (standing) {
    case 'behind':
      return `npm has ${latest}. To move from ${current} to it:`;
    case 'current':
      return `${current} is the current version — nothing to update. For reference:`;
    case 'ahead':
      return `you are running ${current}, ahead of npm's ${latest} — a build of your own.`;
    case 'unknown':
      return `could not ask npm which version is current — ${reason ?? 'no answer'}. What follows still holds.`;
  }
}

/**
 * The whole text `seedeep update` prints. Pure, so the advice for every channel and every outcome
 * of the check is testable without being installed through it and without a network.
 */
export function updateAdvice(
  channel: Channel,
  execPath: string,
  status: UpdateStatus = { current: VERSION, latest: null, standing: 'unknown', checkedAt: null, reason: null },
  offline = false,
  platform: NodeJS.Platform = process.platform,
): string {
  const lines = [`seedeep ${status.current} — ${execPath}`, checkLine(status, offline)];
  switch (channel.kind) {
    case 'bun':
      lines.push(
        'installed with bun. To update:',
        '',
        `  ${channel.command}`,
        '',
        '`--trust` is not optional under bun: it blocks the install script that puts the binary in place.',
      );
      break;
    case 'npm':
      // No `--trust` note here, and no release link either: this install is npm's, and telling it
      // about another channel's caveats is how a user ends up running the wrong command.
      lines.push('installed with npm. To update:', '', `  ${channel.command}`);
      break;
    case 'download':
      lines.push(
        'a downloaded executable — updating it is replacing this file with the new one:',
        '',
        '  https://github.com/duqaXxX/seedeep/releases/latest',
        '',
        'Keep the same path and name, and `/seedeep` keeps working.',
      );
      break;
    case 'checkout':
      lines.push('running from a checkout — `git pull`, and the next `bun start` is the new code.');
      break;
  }
  // Named only where it would actually work: `planSelfUpdate` refuses a download, a checkout and
  // Windows, and pointing at a command that answers "I cannot do that here" is worse than silence.
  if (planSelfUpdate(channel, platform).kind === 'install') {
    lines.push('', 'Or `seedeep self-update`, which runs that command here and restarts the server for you.');
  }
  lines.push(
    '',
    'Asking npm is the only thing seedeep asks the network. A verb you type asks it now; every',
    'other surface reads the answer it leaves behind, at most once an hour.',
    'A running server keeps the old code until `seedeep restart`.',
  );
  return `${lines.join('\n')}\n`;
}

/**
 * The resolved path of the running executable — where every channel decision starts. Falls back to
 * the unresolved path, which is still a better answer than none: only the `/node_modules/` test
 * depends on the resolution, and a link that cannot be read is not a package-manager install.
 */
export function ownExecPath(execPath = process.execPath): string {
  try {
    return realpathSync(execPath);
  } catch {
    return execPath;
  }
}

/** Run `seedeep update`. Always 0: telling the user how to update cannot fail. */
export async function runUpdate(
  opts: { offline?: boolean } = {},
  out: { log: (s: string) => void } = { log: console.log },
  execPath = process.execPath,
): Promise<number> {
  const real = ownExecPath(execPath);
  // `force` for the same reason `self-update` does it: this verb exists to answer "is there a newer
  // one", and an hour-old cache can answer it wrong. `offline` still wins — it is the flag that says
  // do not go to the network at all.
  const status = await updateStatus({ offline: opts.offline, force: true });
  out.log(updateAdvice(detectChannel(real), real, status, opts.offline ?? false));
  return 0;
}
