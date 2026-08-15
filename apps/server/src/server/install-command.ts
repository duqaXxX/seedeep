/**
 * `seedeep install-command` — write the `/seedeep` slash command into Claude Code's own
 * directory, so the GUI is one word away from any session.
 *
 * The binary writes it rather than an installer or a `postinstall`, because the binary is the only
 * artifact every distribution channel delivers (bare download, npm, the one the tray finds), and
 * because the command file and the `seedeep open` it calls then always ship as one version.
 *
 * The file it writes is a PROMPT, not a script — that is what a file under `commands/` is. The
 * shell runs only through the `` !`…` `` form, which Claude Code executes before the model sees
 * anything and replaces with its output. Everything the command needs to decide lives in
 * `seedeep open`; this file is the way to call it without leaving the session.
 */

import { realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, win32 } from 'node:path';
import { claudeDir } from './roots.ts';
import { type Channel, detectChannel } from './update-cmd.ts';
import { FROM_SOURCE, VERSION } from './version.ts';

/** What an install attempt did, or refused to do. */
export type InstallOutcome =
  | { kind: 'written'; path: string }
  /** Replaced a file an older seedeep wrote — the upgrade path. */
  | { kind: 'updated'; path: string; from: string }
  | { kind: 'unchanged'; path: string }
  | { kind: 'differs'; path: string }
  | { kind: 'failed'; path: string; reason: string };

/** Where Claude Code keeps its user commands — {@link claudeDir} plus `commands`, so the command
 * file and the transcripts can never be looked for in two different places. */
export function claudeCommandsDir(home = homedir(), env?: Record<string, string | undefined>): string {
  return join(claudeDir(home, env), 'commands');
}

/** Full path of the command file this writes. */
export function commandFilePath(home = homedir(), env?: Record<string, string | undefined>): string {
  return join(claudeCommandsDir(home, env), 'seedeep.md');
}

/**
 * The exact bytes of the `/seedeep` command.
 *
 * `disable-model-invocation` because a command that STARTS A SERVER is one the user triggers, never
 * one Claude reaches for on its own. The closing instruction is not decoration either: the body of
 * a slash command is a prompt, so without it the model is free to read `seedeep open`'s output as a
 * task — see an error, try to repair it, start processes nobody asked for.
 */
export function commandFileContents(version = VERSION): string {
  const body = commandFileBody();
  return `${body}\n<!-- seedeep ${version} ${digestOf(body)} — \`seedeep install-command\` keeps this file current; edit it and it becomes yours -->\n`;
}

/**
 * How the file says who wrote it: its last line names the version and carries a digest of
 * everything above it.
 *
 * In the FILE and not in a record beside it, because the question it answers — "is this still the
 * file seedeep wrote, or did someone change it?" — has to survive a deleted `~/.seedeep`, a copied
 * dotfile, a machine that is not the one that installed it. The digest is what separates *written
 * by an older seedeep* (safe to replace) from *edited by the user* (never touched), a distinction
 * the first version of this could not make: it saw only that the bytes differed and refused both.
 *
 * The cost is honest and small: this line is part of the prompt, so it is ~25 tokens on every
 * `/seedeep`.
 */
const MARKER = /^<!-- seedeep (\S+) (\S+) —.*-->$/;

/** A non-cryptographic digest is enough: it answers "did these bytes change", not "who changed
 * them" — nothing here is defended against someone who can already write the file. */
function digestOf(body: string): string {
  return Bun.hash(body).toString(36);
}

/** What the file on disk is, as far as ownership goes. */
export type Ownership =
  | { kind: 'ours'; version: string; stale: boolean }
  /** No marker, or a digest that no longer matches: the user's file now, whoever wrote it first. */
  | { kind: 'theirs' };

/** Read a command file's marker and re-check its digest. */
export function ownershipOf(text: string, version = VERSION): Ownership {
  const lines = text.replace(/\n+$/, '').split('\n');
  const marker = MARKER.exec(lines[lines.length - 1] ?? '');
  if (!marker) return { kind: 'theirs' };
  const body = `${lines.slice(0, -1).join('\n').replace(/\n+$/, '')}\n`;
  if (digestOf(body) !== marker[2]) return { kind: 'theirs' };
  return { kind: 'ours', version: marker[1] as string, stale: marker[1] !== version };
}

function commandFileBody(): string {
  return `---
description: Open seedeep's GUI, check its status, report on this session, or restart/stop the server
argument-hint: [open|start|stop|restart|status|report|report full|update|self-update]
disable-model-invocation: true
allowed-tools: Bash(seedeep:*)
---

!\`seedeep claude-code \${CLAUDE_SESSION_ID} $ARGUMENTS\`

The block above is seedeep's output.

- \`open\` / no argument, \`start\`, \`stop\` and \`restart\`: report it in ONE line and stop.
- \`report\`: present it as it is — it is already formatted. Add at most two sentences saying what
  stands out. Never re-total the numbers and never guess at one that is not there.
- \`status\`: present it as it is — it is already formatted, and every line that needs an action
  already names the command for it. Do NOT run any of them: a status that reports a problem is
  still only a report, and acting on it is the user's to decide.
- \`update\`: show the command it printed, verbatim. Do NOT run it — updating is the user's to do,
  in their own terminal, where they can see it happen.
- \`self-update\`: the block above says only what WOULD happen; nothing is installed yet. If it ends
  with "Nothing to run", report that in one line and stop. Otherwise run \`seedeep self-update\` with
  Bash and report its last line. That one command does all of it — it installs, checks the executable
  really changed, and restarts the server. Never run the package manager yourself, and never stop or
  start the server around it.

In every case: do nothing else. Do not start processes, do not investigate, do not try to fix
anything you see in the output. The single exception is the \`seedeep self-update\` above, and only
for that word.
`;
}

/**
 * Write the command file, or bring it up to date, or leave it alone.
 *
 * The three cases are told apart by the marker, never by "the bytes differ": a file an OLDER
 * seedeep wrote is updated in place — that is what makes an upgrade a no-op the user does not have
 * to think about — while a file with no marker, or one whose digest no longer matches its body, is
 * the user's and is never touched without `force`.
 */
export async function installCommand(
  opts: { force?: boolean; home?: string; env?: Record<string, string | undefined> } = {},
): Promise<InstallOutcome> {
  const path = commandFilePath(opts.home, opts.env);
  const contents = commandFileContents();
  let existing: string | null = null;
  try {
    existing = await readFile(path, 'utf8');
  } catch {
    /* not there yet, which is the ordinary case */
  }
  if (existing !== null) {
    if (existing === contents) return { kind: 'unchanged', path };
    const owner = ownershipOf(existing);
    if (owner.kind === 'theirs' && !opts.force) return { kind: 'differs', path };
    if (owner.kind === 'ours' && !opts.force) {
      return write(path, contents, { kind: 'updated', path, from: owner.version });
    }
  }
  return write(path, contents, { kind: 'written', path });
}

async function write(path: string, contents: string, ok: InstallOutcome): Promise<InstallOutcome> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
    return ok;
  } catch (err) {
    return { kind: 'failed', path, reason: (err as Error).message };
  }
}

/**
 * Whether `/seedeep` will actually run: the command file calls `seedeep` BY NAME, so the binary has
 * to be on PATH under that name and it has to be this one.
 *
 * Checked because the failure it prevents is silent and misleading: `install-command` succeeds,
 * says the file is written, and `/seedeep` then dies with *command not found* — the ordinary state
 * of the downloaded executable, which installs nothing and puts nothing on PATH.
 */
export type PathState =
  | { kind: 'ok' }
  | { kind: 'absent' }
  /** On PATH, but resolving to a different file than the one running this. */
  | { kind: 'other'; found: string }
  /** Running from a checkout: there is no released binary here to be on PATH in the first place. */
  | { kind: 'from-source' };

/**
 * Resolve `seedeep` on PATH and compare it with the executable running this command.
 *
 * Both sides are resolved through symlinks first, and that is the whole difficulty: a package
 * manager puts a LINK on the PATH — measured, `~/.bun/bin/seedeep` →
 * `~/.bun/install/global/node_modules/seedeep/bin/seedeep.exe` — while `process.execPath` is
 * already the target. Comparing the two spellings reported "that is a different executable" for
 * every npm and bun install there is, which is the normal case and the one this must stay quiet on.
 */
export function pathState(
  deps: {
    which?: (cmd: string) => string | null;
    execPath?: string;
    fromSource?: boolean;
    realpath?: (p: string) => string;
    platform?: string;
  } = {},
): PathState {
  const {
    which = (cmd: string) => Bun.which(cmd),
    execPath = process.execPath,
    fromSource = FROM_SOURCE,
    platform = process.platform,
  } = deps;
  const realpath =
    deps.realpath ??
    ((p: string) => {
      try {
        return realpathSync(p);
      } catch {
        return p; // a path that cannot be resolved is compared as written — never a crash
      }
    });
  if (fromSource) return { kind: 'from-source' };
  const found = which('seedeep');
  if (!found) return { kind: 'absent' };
  const [realFound, realExec] = [realpath(found), realpath(execPath)];
  if (realFound === realExec) return { kind: 'ok' };
  // Resolved on both sides here too: `Bun.which` can answer through a directory junction or an 8.3
  // short name while `process.execPath` is the long form, and a prefix test on the two spellings
  // would then miss. The message still names what the user would type — `found`, not its target.
  return isNpmWindowsLauncher(realFound, realExec, platform) ? { kind: 'ok' } : { kind: 'other', found };
}

/**
 * True when what is on the PATH is the npm-on-Windows LAUNCHER for `execPath`, not another seedeep.
 *
 * Windows has no symlink for `realpath` to follow: npm writes a `.cmd` (and a `.ps1`, and an
 * extensionless script for Git Bash) into its global bin directory and lets it exec the binary that
 * lives under that directory's `node_modules`. The comparison above therefore never matched, and
 * every npm install on Windows was told its own launcher was a different executable — measured
 * 2026-08-14 on Windows 11: `…\npm\seedeep.cmd` on the PATH against
 * `…\npm\node_modules\seedeep\bin\seedeep.exe` running, which is one install and not two.
 *
 * The package's OWN directory is required, not merely a `node_modules` under the launcher: a
 * looser prefix would let `…\npm\node_modules\some-other-package\bin\seedeep.exe` vouch for the
 * PATH entry, and at a drive root it degenerates to `c:\node_modules\` — the very case a bare
 * ancestor test was supposed to rule out. Case-insensitive because the filesystem is.
 *
 * `path.win32` and not the default export: the default follows the HOST, and this reasons about a
 * Windows path wherever it runs. The `win32` variant is host-independent — verified on darwin,
 * `win32.dirname('C:\\…\\npm\\seedeep.cmd')` answers `C:\…\npm` — which an earlier version of this
 * comment denied while hand-rolling eight lines to work around a problem that does not exist.
 *
 * LIMIT: npm only. Bun's global layout on Windows has not been measured — on POSIX it is a symlink
 * (`~/.bun/bin/seedeep` → `~/.bun/install/global/node_modules/…`), which `realpath` already
 * resolves, and what it writes on Windows is a guess this refuses to make. A bun install there keeps
 * the false warning until somebody looks.
 */
export function isNpmWindowsLauncher(found: string, execPath: string, platform: string): boolean {
  if (platform !== 'win32') return false;
  const ext = win32.extname(found).toLowerCase();
  // `''` covers the extensionless script npm also writes, for Git Bash.
  if (ext !== '.cmd' && ext !== '.bat' && ext !== '.ps1' && ext !== '') return false;
  const pkg = win32.join(win32.dirname(found), 'node_modules', 'seedeep', win32.sep);
  return execPath.toLowerCase().replace(/\//g, '\\').startsWith(pkg.toLowerCase().replace(/\//g, '\\'));
}

/**
 * The one line to print about the PATH, or null when there is nothing worth saying.
 *
 * The `absent` case is answered PER CHANNEL, because the fix is a different thing in each: a
 * downloaded executable is a file nobody put on the PATH, and moving it is the answer; a package
 * manager already put it there, so its absence means the manager's own global bin directory is
 * missing from the PATH — and telling that user to `mv` a file out of `node_modules` would break
 * their next update.
 */
export function pathNotice(state: PathState, execPath = process.execPath, channel?: Channel): string | null {
  switch (state.kind) {
    case 'ok':
      return null;
    case 'from-source':
      return `seedeep: running from a checkout — /seedeep will call whatever \`seedeep\` is on your PATH, not this one.`;
    case 'absent': {
      const head = `seedeep: \`seedeep\` is not on your PATH, so /seedeep will fail with "command not found". `;
      if (channel?.kind === 'bun') {
        return `${head}This copy was installed with bun, which puts it in \`bun pm bin -g\` — add that directory to your PATH.`;
      }
      if (channel?.kind === 'npm') {
        return `${head}This copy was installed with npm, which puts it in \`npm prefix -g\`/bin — add that directory to your PATH.`;
      }
      return `${head}Move this executable onto it:  mv ${execPath} /usr/local/bin/seedeep`;
    }
    case 'other':
      return (
        `seedeep: \`seedeep\` on your PATH is ${state.found}, not this executable (${execPath}) — ` +
        `/seedeep will run that one.`
      );
  }
}

/**
 * The line to print when the installed `/seedeep` predates the binary answering it — or null when
 * there is nothing to say.
 *
 * Said HERE, on every `/seedeep`, because no distribution channel offers a hook that covers the
 * others: npm's `postinstall` would reach one user in two and write into `~/.claude` unasked, and a
 * downloaded executable the user replaced by hand has no install step at all. The invocation is the
 * one moment seedeep is certainly running, in every channel — so the check rides on it.
 *
 * A file that is the user's (edited, or never written by seedeep) says nothing: they own it.
 */
export async function staleCommandNotice(
  home?: string,
  env?: Record<string, string | undefined>,
): Promise<string | null> {
  let text: string;
  try {
    text = await readFile(commandFilePath(home, env), 'utf8');
  } catch {
    return null; // nothing installed — `/seedeep` is not what is running, so this is not its business
  }
  const owner = ownershipOf(text);
  if (owner.kind !== 'ours' || !owner.stale) return null;
  return `seedeep: this /seedeep command was written by seedeep ${owner.version}, and you are running ${VERSION} — \`seedeep install-command\` updates it.`;
}

/**
 * Bring an ALREADY-INSTALLED `/seedeep` up to date, silently unless something happened. Returns the
 * line to log, or null when there was nothing to do. Called on every server start.
 *
 * The rule this does not break: seedeep never writes into `~/.claude` unasked. **It never creates
 * the file** — running `install-command` once is the permission, and this only keeps current a file
 * that permission already produced. And it only touches a file whose marker AND digest still say
 * seedeep wrote it: a file the user edited is theirs, and stays untouched here as everywhere else.
 *
 * It exists because the notice on `/seedeep` reaches only the user who runs `/seedeep` again — and
 * the one who does not is exactly the one who would go on using a command file older than the
 * binary answering it. The two are complementary: this covers the server being restarted, the
 * notice covers a stale file on a machine where no server ever runs (`report` needs none).
 */
export async function refreshOwnedCommandFile(
  home?: string,
  env?: Record<string, string | undefined>,
): Promise<string | null> {
  const path = commandFilePath(home, env);
  let existing: string;
  try {
    existing = await readFile(path, 'utf8');
  } catch {
    return null; // never installed — creating it here would be the thing this must not do
  }
  const owner = ownershipOf(existing);
  if (owner.kind !== 'ours' || !owner.stale) return null;
  const result = await write(path, commandFileContents(), { kind: 'updated', path, from: owner.version });
  return result.kind === 'updated'
    ? `seedeep: updated the /seedeep command in ${path} — it was written by seedeep ${owner.version}.`
    : null; // a failure here is not worth a word: nothing the user asked for depends on it
}

/** Run the subcommand and print its outcome. Returns the process exit code. */
export async function runInstallCommand(
  opts: { force?: boolean } = {},
  out: { log: (s: string) => void; error: (s: string) => void } = { log: console.log, error: console.error },
): Promise<number> {
  const result = await installCommand(opts);
  // The channel decides what the PATH advice even IS, so it is resolved here rather than assumed.
  const real = (() => {
    try {
      return realpathSync(process.execPath);
    } catch {
      return process.execPath;
    }
  })();
  const notice = pathNotice(pathState(), real, detectChannel(real));
  if (notice && result.kind !== 'failed') out.error(notice);
  switch (result.kind) {
    case 'written':
      out.log(`seedeep: wrote ${result.path} — type /seedeep in Claude Code to open the GUI.`);
      return 0;
    case 'updated':
      out.log(`seedeep: updated ${result.path} — it was written by seedeep ${result.from}, now ${VERSION}.`);
      return 0;
    case 'unchanged':
      out.log(`seedeep: ${result.path} is already the current command. Nothing to do.`);
      return 0;
    case 'differs':
      out.error(
        `seedeep: ${result.path} was edited after seedeep wrote it, so it is yours now. Left ` +
          `untouched; \`seedeep install-command --force\` replaces it with the current command.`,
      );
      return 1;
    case 'failed':
      out.error(`seedeep: could not write ${result.path}: ${result.reason}`);
      return 1;
  }
}
