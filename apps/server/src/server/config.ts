import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** Which events a single delivery channel is allowed to interrupt the user for. */
export interface NotifyChannelSwitches {
  needsYou: boolean;
  fails: boolean;
  finishes: boolean;
  updates: boolean;
}

/**
 * The webhook channel: the session switches, plus where and how to POST.
 *
 * `updates` is deliberately NOT here. A new-release banner is the tray telling you about the
 * machine you are sitting at; there is no announcement for it in the engine, so a switch would be
 * one the user turns on and that then says nothing at all.
 */
export interface NotifyWebhook extends Omit<NotifyChannelSwitches, 'updates'> {
  /** Empty means the channel is off — no URL, no delivery, nothing leaves the machine. */
  url: string;
  /** Sent verbatim on every POST. Where a service's auth token goes. */
  headers: Record<string, string>;
  /** Placeholders: `{{title}}` `{{body}}` `{{project}}` `{{subject}}` `{{kind}}`. */
  template: string;
}

/**
 * Per-CHANNEL switches, never one shared set: the same event can be worth a banner on the machine
 * you are sitting at and not worth a push to your phone, and a single set cannot express that.
 */
export interface NotifyConfig {
  tray: NotifyChannelSwitches;
  webhook: NotifyWebhook;
}

export interface SeedDeepConfig {
  port: number;
  host: string;
  open: boolean;
  auth: {
    /** 32-byte base64url token; applied only when `host` is not a loopback address. */
    token: string;
  };
  notifications: NotifyConfig;
  tls: {
    /** Certificate CN. Required when `host` is not loopback; has no built-in default. */
    commonName?: string;
    /** Path to the self-signed cert. Default `~/.seedeep/cert.pem`. */
    cert: string;
    /** Path to the private key. Default `~/.seedeep/key.pem`. */
    key: string;
  };
}

/**
 * The directory seedeep owns — config, certificate, and every cache and index it keeps.
 * `~/.seedeep/`, or `SEEDEEP_HOME` when it is set.
 *
 * The variable is what lets a checkout run beside an installed release. The damage it prevents is
 * not two processes fighting: it is one leaving state behind for the other, which happens whether
 * or not they ever run together — a dev run that changes the port from the settings panel rewrites
 * the config the installed server reads on ITS next start. A relative value is resolved against the
 * process's cwd, so a dev script can point it inside the checkout.
 *
 * Every path below this directory goes through here, so there is one place to relocate and no way
 * for a cache to be left behind in the real home while the config moved.
 */
export function seedDeepDir(home = homedir(), env: Record<string, string | undefined> = process.env): string {
  const override = env['SEEDEEP_HOME'];
  return override ? resolve(override) : join(home, '.seedeep');
}

/** Path to `config.json` inside {@link seedDeepDir} — so `SEEDEEP_HOME` moves it with the rest. */
export function configFilePath(home = homedir()): string {
  return join(seedDeepDir(home), 'config.json');
}

/** Built-in defaults. The `tls` paths sit in {@link seedDeepDir}, which is under `home` unless
 * `SEEDEEP_HOME` says otherwise. */
export function defaultConfig(home = homedir()): SeedDeepConfig {
  const dir = seedDeepDir(home);
  return {
    port: 44842,
    host: '127.0.0.1',
    open: true,
    auth: { token: '' },
    tls: { cert: join(dir, 'cert.pem'), key: join(dir, 'key.pem') },
    notifications: {
      // The tray's defaults are what it shipped while the switches were its own local state:
      // changing one changes what the user sees, and moving where a setting LIVES may not also
      // change what it says. The webhook ships off — nothing leaves the machine unasked.
      tray: { needsYou: true, fails: true, finishes: false, updates: true },
      webhook: { needsYou: true, fails: true, finishes: false, url: '', headers: {}, template: '' },
    },
  };
}

/** An object from the parsed file, or `{}` when the key is absent or not an object. */
function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * Merge a config file's `notifications` onto the defaults, one channel at a time.
 *
 * Per key rather than per object, at both levels: a file written before a switch existed, or one
 * that sets a single field, must come back with every other default intact.
 */
function mergeNotifications(defs: NotifyConfig, raw: unknown): NotifyConfig {
  const given = asObject(raw);
  return {
    tray: { ...defs.tray, ...asObject(given['tray']) } as NotifyChannelSwitches,
    webhook: { ...defs.webhook, ...asObject(given['webhook']) } as NotifyWebhook,
  };
}

/**
 * Read config from `path` (default `~/.seedeep/config.json`). A missing file returns the
 * built-in defaults. A malformed or unreadable file also falls back silently — it is never
 * rewritten on its own. Unknown keys from a newer version are preserved (not stripped).
 */
export async function readConfig(path?: string, home = homedir()): Promise<SeedDeepConfig> {
  try {
    return await readConfigStrict(path, home);
  } catch (e) {
    console.warn(`seedeep: ${(e as Error).message} — using defaults`);
    return defaultConfig(home);
  }
}

/**
 * {@link readConfig}, except that a file which exists and cannot be understood THROWS instead of
 * quietly becoming the defaults. A missing file still returns them — absent legitimately means
 * "every default", which a malformed one does not.
 *
 * The distinction is not academic: a caller that WRITES must never take the defaults for the user's
 * settings. It did, briefly, and one save after a stray comma in `config.json` replaced the auth
 * token, the port and the certificate name with built-ins — a running server repairs that file, it
 * does not overwrite it. Callers that only need a config to start with want {@link readConfig}.
 */
export async function readConfigStrict(path?: string, home = homedir()): Promise<SeedDeepConfig> {
  return (await readConfigFile(path, home)) ?? defaultConfig(home);
}

/**
 * The file as it stands: `null` when it does not exist, and a THROW when it exists and cannot be
 * understood.
 *
 * Three states, not two, because a caller that WRITES has to treat them differently. Absent is not
 * "every default" for such a caller either: merging onto the defaults wrote `token: ""` and an
 * empty webhook over a running server's real ones the moment anything was saved — measured, by
 * deleting `config.json` under a live server and toggling one switch. Only a reader can take the
 * defaults for a missing file; a writer has to fall back to what the process holds.
 */
export async function readConfigFile(path?: string, home = homedir()): Promise<SeedDeepConfig | null> {
  const filePath = path ?? configFilePath(home);
  const defs = defaultConfig(home);
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (e) {
    // ENOENT is normal on first run, and is the one read failure that is not a loss of information.
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`could not read config (${(e as Error).message})`);
  }
  let p: unknown;
  try {
    p = JSON.parse(raw);
  } catch {
    throw new Error('config has invalid JSON');
  }
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('config is not a JSON object');
  const parsed = p as Record<string, unknown>;
  return {
    ...defs,
    ...parsed,
    // Nested objects are merged, not replaced, so a file with only `auth.token` set
    // does not lose the built-in `tls` defaults.
    auth: {
      ...defs.auth,
      ...(parsed['auth'] && typeof parsed['auth'] === 'object' ? (parsed['auth'] as object) : {}),
    },
    tls: { ...defs.tls, ...(parsed['tls'] && typeof parsed['tls'] === 'object' ? (parsed['tls'] as object) : {}) },
    // One level deeper than `auth` and `tls`, because the channels are objects too: a file that
    // sets only `webhook.url` must keep every switch it never mentioned, on BOTH channels.
    notifications: mergeNotifications(defs.notifications, parsed['notifications']),
  };
}

/**
 * Atomically write `config` to `path` (default `~/.seedeep/config.json`).
 * Creates the parent directory if absent. Sets permissions to 0o600.
 */
export async function writeConfig(config: SeedDeepConfig, path?: string, home = homedir()): Promise<void> {
  const filePath = path ?? configFilePath(home);
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await writeFile(tmp, JSON.stringify(config, null, 2));
  await rename(tmp, filePath);
  await chmod(filePath, 0o600);
}

/**
 * Apply the precedence chain — CLI flags → env vars → `fileConfig` → built-in defaults — and
 * nothing else: no token, no write, no clock. Pure, so it can answer "what would a start resolve
 * to right now?" as often as a request asks (see {@link restartPending}) without a GET ever
 * rewriting `config.json`.
 *
 * It is the one place the chain is spelled out. A second copy is exactly how a stale-process
 * signal would come to disagree with the process it is describing.
 */
export function applyPrecedence(
  cliFlags: Partial<Pick<SeedDeepConfig, 'port' | 'host' | 'open'>>,
  env: Record<string, string | undefined>,
  fileConfig: SeedDeepConfig,
): SeedDeepConfig {
  const resolved: SeedDeepConfig = {
    ...fileConfig,
    // env layer
    port: env['SEEDEEP_PORT'] !== undefined ? Number(env['SEEDEEP_PORT']) : fileConfig.port,
    host: env['SEEDEEP_HOST'] ?? fileConfig.host,
    open:
      env['SEEDEEP_OPEN'] !== undefined
        ? env['SEEDEEP_OPEN'] !== '0' && env['SEEDEEP_OPEN'] !== 'false'
        : fileConfig.open,
    auth: { ...fileConfig.auth },
    tls: {
      ...fileConfig.tls,
      ...(env['SEEDEEP_TLS_CN'] !== undefined ? { commonName: env['SEEDEEP_TLS_CN'] } : {}),
    },
  };
  // CLI layer: only override when the flag was explicitly provided (not a default).
  if (cliFlags.port !== undefined) resolved.port = cliFlags.port;
  if (cliFlags.host !== undefined) resolved.host = cliFlags.host;
  if (cliFlags.open !== undefined) resolved.open = cliFlags.open;
  return resolved;
}

/**
 * Whether the process running `running` is serving a configuration a restart would replace —
 * `true` when a fresh start, resolved from the SAME flags and env against `config.json` as it
 * stands now, would come up differently.
 *
 * Two groups. Three fields are what a process BINDS at startup and cannot revisit — `port`, `host`
 * and the certificate's common name. The rest are the values the panel is shown REDACTED (the auth
 * token, the webhook's address and its headers): a save can change any of them, but only carrying a
 * value the panel HAS, and one edited straight into the file is never in a request — the panel
 * posts `***`, which resolves back to what was already there. A restart is what applies those,
 * which is why they are here and not in {@link savePending}: a pending state cleared by no button
 * at all is worse than no signal.
 *
 * `open` is in neither: it is spent the moment the browser opened, and announcing it would teach
 * the user to ignore the announcement — which is how a server left on loopback went unnoticed in
 * the first place.
 *
 * Both sides come through {@link applyPrecedence}, never from the file alone: a server started
 * with `--port 9000` is not stale because `config.json` says 44842. `POST /api/restart` respawns
 * with `process.argv.slice(2)` intact, so that flag survives the restart and the file would still
 * not win — a pending state the button cannot clear is worse than no signal at all.
 */
export function restartPending(running: SeedDeepConfig, wouldStart: SeedDeepConfig): boolean {
  return (
    // `Object.is`, not `!==`: a non-numeric `SEEDEEP_PORT` makes both sides NaN, and NaN differs
    // from itself — a pending state on both sides of a restart, which is the one thing this must
    // never produce.
    !Object.is(running.port, wouldStart.port) ||
    running.host !== wouldStart.host ||
    // Absent and empty are the same certificate name — neither can be put in one.
    (running.tls.commonName ?? '') !== (wouldStart.tls.commonName ?? '') ||
    // An EMPTY desired token is not a request to change anything: it means "none configured, one
    // will be generated on the next start", which is what a missing file says. Comparing it
    // literally reports a pending restart against a token nobody wrote. The webhook's fields carry
    // no such rule — an emptied URL is a channel deliberately switched off, which IS a change.
    (wouldStart.auth.token === '' ? false : running.auth.token !== wouldStart.auth.token) ||
    running.notifications.webhook.url !== wouldStart.notifications.webhook.url ||
    JSON.stringify(running.notifications.webhook.headers) !== JSON.stringify(wouldStart.notifications.webhook.headers)
  );
}

/**
 * Whether `config.json` holds notification settings the running process has not taken up — the one
 * kind of change a SAVE can apply and a restart is not needed for.
 *
 * The counterpart to {@link restartPending}, separate because the cure is different, and it holds
 * exactly what the panel can genuinely re-post: the switches are in the form, so pressing Apply
 * sends them. The TOKEN is deliberately NOT here, and that was found by driving the button: the
 * panel reads the token redacted, so a save cannot carry a value edited into the file — a restart
 * is what applies it, and {@link restartPending} is where it belongs.
 *
 * `open` is in neither: it is spent the moment the browser opened, so nothing can apply it.
 */
export function savePending(running: SeedDeepConfig, desired: SeedDeepConfig): boolean {
  return JSON.stringify(applicableBySave(running)) !== JSON.stringify(applicableBySave(desired));
}

/**
 * The notification settings the PANEL holds in clear, and can therefore post back unchanged: every
 * switch, and the webhook's template.
 *
 * The webhook's URL and its headers are excluded for the same reason the token is — the panel is
 * shown `***` and posts `***`, which the merge resolves back to what was already there. A pending
 * state raised on one of those could never be cleared by pressing the button that claims to clear
 * it, which is measurably worse than not raising it: the banner and the header dot simply stayed up
 * forever. They are covered by {@link restartPending} instead, which names a cure that works.
 */
function applicableBySave(c: SeedDeepConfig): unknown {
  const { url: _url, headers: _headers, ...webhook } = c.notifications.webhook;
  return { tray: c.notifications.tray, webhook };
}

/** Where a value that beats `config.json` came from. */
export type OverrideSource = 'flag' | 'env';

/**
 * The fields a CLI flag or an environment variable is overriding, keyed as the panel names them
 * (`port`, `host`, `open`, `tls.commonName`).
 *
 * Only fields whose override actually DIFFERS from the file: a flag repeating what the file says
 * overrides nothing anyone can observe, and saying so would be noise. What this is for is the one
 * thing the panel could not otherwise explain — a field the user edits, saves, and sees snap back,
 * because this process was started with a value that wins on every restart.
 */
export function overriddenFields(
  cliFlags: Partial<Pick<SeedDeepConfig, 'port' | 'host' | 'open'>>,
  env: Record<string, string | undefined>,
  fileConfig: SeedDeepConfig,
): Record<string, OverrideSource> {
  const resolved = applyPrecedence(cliFlags, env, fileConfig);
  const out: Record<string, OverrideSource> = {};
  const mark = (key: string, differs: boolean, byFlag: boolean, byEnv: boolean): void => {
    if (differs && (byFlag || byEnv)) out[key] = byFlag ? 'flag' : 'env';
  };
  mark(
    'port',
    !Object.is(resolved.port, fileConfig.port),
    cliFlags.port !== undefined,
    env['SEEDEEP_PORT'] !== undefined,
  );
  mark('host', resolved.host !== fileConfig.host, cliFlags.host !== undefined, env['SEEDEEP_HOST'] !== undefined);
  mark('open', resolved.open !== fileConfig.open, cliFlags.open !== undefined, env['SEEDEEP_OPEN'] !== undefined);
  mark(
    'tls.commonName',
    (resolved.tls.commonName ?? '') !== (fileConfig.tls.commonName ?? ''),
    false, // no CLI flag carries it
    env['SEEDEEP_TLS_CN'] !== undefined,
  );
  return out;
}

/**
 * {@link applyPrecedence}, plus the one thing a start does that a comparison must not: generate a
 * random `auth.token` when absent and persist it to `configPath` (non-fatal on write failure — the
 * token is regenerated on the next start rather than crashing this one).
 */
export async function resolveConfig(
  cliFlags: Partial<Pick<SeedDeepConfig, 'port' | 'host' | 'open'>>,
  env: Record<string, string | undefined>,
  fileConfig: SeedDeepConfig,
  configPath?: string,
  /**
   * Whether `fileConfig` really came from the file. `false` when it could not be parsed, and then
   * NOTHING is written: the token is generated for this run alone and the user's file is left for
   * them to repair. Writing it back is how a stray comma cost a token, a port and a certificate
   * name — at startup, before any request, which is the half the POST-side guard does not cover.
   */
  fileIsUsable = true,
): Promise<SeedDeepConfig> {
  const resolved = applyPrecedence(cliFlags, env, fileConfig);

  // Generate and persist `auth.token` when absent. Write back when the file was absent
  // (ENOENT) OR when it existed but carried no token — both cases mean the token we just
  // generated needs to land on disk so the next start uses the same one.
  // Guard: do NOT write when the file exists but could not be READ (non-ENOENT error) —
  // that would overwrite potentially-intact settings with bare defaults.
  if (!resolved.auth.token) {
    resolved.auth.token = randomBytes(32).toString('base64url');
    const absent = await readFile(configPath ?? configFilePath())
      .then(() => false)
      .catch((e) => (e as NodeJS.ErrnoException).code === 'ENOENT');
    // `fileIsUsable` first: a file we could not parse holds settings we would be erasing, and a
    // token regenerated on every start until the user repairs it is the smaller harm by far.
    if (fileIsUsable && (absent || !fileConfig.auth.token)) {
      try {
        await writeConfig(resolved, configPath);
      } catch {
        /* next start regenerates */
      }
    }
  }
  return resolved;
}
