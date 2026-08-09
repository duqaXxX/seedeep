/**
 * `seedeep --help` and `seedeep --version`.
 *
 * The first thing anyone types at a downloaded executable is `--help`, and until now the answer was
 * `unknown option "--help" for "serve"` — an error naming a subcommand the user had not typed. The
 * text below is the only place the CLI's surface is described in one piece, so it is kept beside
 * the parser that enforces it: a flag added there without a line here is a flag nobody can find.
 */

import { VERSION } from './version.ts';

/** One line per subcommand: what it does, and what it needs. */
const COMMANDS: [string, string][] = [
  ['seedeep', 'watch, serve, and open the browser — stays in the foreground'],
  ['seedeep open', 'open the GUI, starting the server first if it is down'],
  ['seedeep start', 'start the server detached, without opening a browser'],
  ['seedeep stop', 'stop the running server'],
  ['seedeep restart', 'replace the running server with a fresh one'],
  ['seedeep status', 'what state this machine is in — server, version, update, /seedeep'],
  ['seedeep report', 'what a session cost and where its tokens went — the newest of this directory'],
  ['seedeep update', 'say how THIS installation is updated — prints the command, never runs it'],
  ['seedeep self-update', 'install the new version through that command, then restart the server'],
  ['seedeep install-command', 'write the /seedeep slash command into Claude Code (--force to replace)'],
];

/** The flags, grouped by the commands that accept them. */
const FLAGS: [string, string][] = [
  ['--port <n>', 'serve, open, start, stop, restart, status, self-update — the port (default 44842)'],
  ['--host <addr>', 'serve — the bind address; anything but loopback turns on TLS and a token'],
  ['--no-open', 'serve — do not open the browser'],
  ['--session <id>', "report — a session other than this directory's newest"],
  ['--full', 'report — add one line per turn'],
  ['--offline', 'update — skip the version check, the one network call seedeep makes'],
  ['--force', 'install-command — replace a command file you edited'],
];

const pad = (rows: [string, string][]): string[] => {
  const width = Math.max(...rows.map(([left]) => left.length));
  return rows.map(([left, right]) => `  ${left.padEnd(width)}  ${right}`);
};

/** The whole `--help` text. */
export function usage(version = VERSION): string {
  return [
    `seedeep ${version} — see deep into your agent's context.`,
    '',
    'Commands',
    ...pad(COMMANDS),
    '',
    'Flags',
    ...pad(FLAGS),
    '',
    'Inside Claude Code, `seedeep install-command` gives you /seedeep, which carries the same',
    'words: /seedeep open, start, stop, restart, status, report [full], update, self-update.',
    '',
  ].join('\n');
}

/** The whole `--version` output: the number and nothing else, so a script can read it. */
export function versionLine(version = VERSION): string {
  return version;
}
