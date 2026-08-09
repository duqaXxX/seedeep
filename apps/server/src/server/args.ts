/**
 * How to invoke this same program again: the executable, plus the entry script when there is one.
 * Both callers that restart or respawn seedeep go through here — `POST /api/restart` and
 * `seedeep open`.
 *
 * The two shapes were MEASURED (bun 1.3.13, macOS arm64), because guessing them produced a server
 * that died at startup:
 *
 * - `bun run main.ts` → `execPath` is bun and `main` is the script, which must be passed on.
 * - compiled (`bun build --compile`) → `execPath` is the seedeep binary and `main` is a path
 *   inside bunfs, the embedded filesystem. Handing it back makes the child treat it as an
 *   argument it cannot honour.
 *
 * `process.argv[0]` is not usable for this: in the compiled binary it is the bare word `bun`,
 * which would resolve through PATH to a completely different program. Nor is the SPELLING of the
 * bunfs path — it is a Bun internal that differs on Windows, which is why the caller passes
 * `FROM_SOURCE` (`Bun.embeddedFiles`, Bun's own answer to the same question) instead.
 */
export function selfInvocation(execPath: string, main: string, fromSource: boolean): string[] {
  return fromSource ? [execPath, main] : [execPath];
}

/** What `seedeep` was asked to do. Bare `seedeep`, with or without flags, is `serve`. */
export type Subcommand =
  | 'serve'
  | 'open'
  | 'start'
  | 'report'
  | 'restart'
  | 'stop'
  | 'status'
  | 'update'
  | 'self-update'
  | 'install-command'
  | 'claude-code'
  | 'help'
  | 'version';

/** The flags each subcommand accepts. A flag outside its command's list is an error, not a
 * no-op: `seedeep open --no-open` states two opposite intentions and cannot be honoured. */
const FLAGS: Record<Subcommand, ReadonlySet<string>> = {
  serve: new Set(['--port', '--host', '--no-open']),
  open: new Set(['--port']),
  start: new Set(['--port']),
  report: new Set(['--session', '--full']),
  restart: new Set(['--port']),
  stop: new Set(['--port']),
  status: new Set(['--port']),
  update: new Set(['--offline']),
  // `--port`, like `restart`: the install is machine-wide, but the server put back on the new code
  // is one of them. No `--offline` — installing without knowing what is out there is not a mode.
  'self-update': new Set(['--port']),
  'install-command': new Set(['--force']),
  'claude-code': new Set([]),
  help: new Set([]),
  version: new Set([]),
};

/** Every subcommand the parser accepts, so `--help` can be checked against the parser rather than
 * against a second list somebody has to remember to extend. */
export const SUBCOMMANDS = Object.keys(FLAGS) as Subcommand[];

/** Asking what the program is never runs it, so these are recognised ANYWHERE in `argv` and win
 * over everything else: `seedeep report --help` explains rather than reporting, which is what a
 * user typing it wants and the one reading that is safe to assume. */
const HELP = new Set(['--help', '-h', 'help']);
const VERSION_FLAGS = new Set(['--version', '-v', 'version']);

/** The one subcommand that takes positional arguments — `<sessionId> [word…]`, straight from the
 * `/seedeep` command file, where Claude Code substitutes both. */
const POSITIONAL: Subcommand = 'claude-code';

/** CLI flags explicitly set by the user. Absent fields are resolved by {@link resolveConfig}
 * through env → config file → built-in default, so `undefined` means "not specified". */
export interface CliOptions {
  command: Subcommand;
  port?: number;
  host?: string;
  open?: boolean;
  /** `install-command` only: overwrite a command file seedeep did not write. */
  force?: boolean;
  /** `report` only: which session, and whether to include the per-turn prompts. */
  session?: string;
  full?: boolean;
  /** `update` only: skip the version check, the one network call seedeep makes. */
  offline?: boolean;
  /** `claude-code` only: the positional arguments, `<sessionId>` first. */
  rest?: string[];
}

/**
 * Parse `argv` into a subcommand and its flags. Only explicitly provided flags set a field;
 * everything absent is `undefined` and resolved later by the config layer.
 *
 * **Every unknown argument throws**, and that is the point rather than strictness for its own
 * sake: this parser used to ignore them, so `seedeep open` on a build without the subcommand
 * started a SERVER in the foreground — attached to whatever shell ran it, which for the
 * `/seedeep` command is the one Claude Code opens and closes. A version that cannot do what it
 * was asked has to say so.
 */
export function parseArgs(argv: string[]): CliOptions {
  if (argv.some((a) => HELP.has(a))) return { command: 'help' };
  if (argv.some((a) => VERSION_FLAGS.has(a))) return { command: 'version' };
  const opts: CliOptions = { command: 'serve' };
  let i = 0;
  const head = argv[0];
  if (head !== undefined && !head.startsWith('-')) {
    // `hasOwn`, never `in`: `'constructor' in FLAGS` is true, so `seedeep toString` passed this
    // check and ran the fallback branch of the dispatch — it STARTED A SERVER. Measured.
    if (!Object.hasOwn(FLAGS, head)) {
      throw new Error(`unknown command "${head}" — try \`seedeep --help\``);
    }
    opts.command = head as Subcommand;
    i = 1;
  }
  if (opts.command === POSITIONAL) {
    opts.rest = argv.slice(i);
    return opts;
  }
  const allowed = FLAGS[opts.command];
  for (; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!allowed.has(arg)) {
      throw new Error(`unknown option "${arg}" for "${opts.command}" — try \`seedeep --help\``);
    }
    if (arg === '--no-open') {
      opts.open = false;
    } else if (arg === '--force') {
      opts.force = true;
    } else if (arg === '--full') {
      opts.full = true;
    } else if (arg === '--offline') {
      opts.offline = true;
    } else if (arg === '--session') {
      const raw = argv[++i];
      if (!raw) throw new Error('--session expects a session id');
      opts.session = raw;
    } else if (arg === '--port') {
      const raw = argv[++i];
      const n = Number(raw);
      if (!raw || !Number.isFinite(n)) throw new Error('--port expects a number');
      opts.port = n;
    } else if (arg === '--host') {
      const raw = argv[++i];
      if (!raw) throw new Error('--host expects a value');
      opts.host = raw;
    }
  }
  return opts;
}
