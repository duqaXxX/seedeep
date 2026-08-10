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

/** The webhook channel: the same switches, plus where and how to POST. */
export interface NotifyWebhook extends NotifyChannelSwitches {
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
      webhook: { needsYou: true, fails: true, finishes: false, updates: false, url: '', headers: {}, template: '' },
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
  const filePath = path ?? configFilePath(home);
  const defs = defaultConfig(home);
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (e) {
    // ENOENT is normal on first run — no warning needed.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`seedeep: could not read config (${(e as Error).message}) — using defaults`);
    }
    return defs;
  }
  try {
    const p: unknown = JSON.parse(raw);
    if (!p || typeof p !== 'object') {
      console.warn(`seedeep: config is not a JSON object — using defaults`);
      return defs;
    }
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
  } catch {
    console.warn(`seedeep: config has invalid JSON — using defaults`);
    return defs;
  }
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
 * Apply the precedence chain: CLI flags → env vars → `fileConfig` → built-in defaults.
 * Generates a random `auth.token` when absent and persists it to `configPath` (non-fatal on
 * write failure — the token is regenerated on the next start rather than crashing this one).
 */
export async function resolveConfig(
  cliFlags: Partial<Pick<SeedDeepConfig, 'port' | 'host' | 'open'>>,
  env: Record<string, string | undefined>,
  fileConfig: SeedDeepConfig,
  configPath?: string,
): Promise<SeedDeepConfig> {
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
    if (absent || !fileConfig.auth.token) {
      try {
        await writeConfig(resolved, configPath);
      } catch {
        /* next start regenerates */
      }
    }
  }
  return resolved;
}
