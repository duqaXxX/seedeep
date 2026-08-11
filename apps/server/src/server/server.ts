import type { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { isValidCertName } from '../core/cert-name.ts';
import { looksLikeCommitHash } from '../core/commit-attribution.ts';
import { liveOf, toCatalogue } from '../core/roster.ts';
import { looksLikeCardId } from '../core/tracker-cards.ts';
import { type CommandVanishedEvent, isLive, type NormalizedEvent, type SessionRecord } from '../core/types.ts';
import { readAgentPrompt } from './agent-prompt.ts';
import { createAggregateCache, defaultCacheFile, maybeMigrateCache } from './aggregate-cache.ts';
import { selfInvocation } from './args.ts';
import { assetPath } from './assets.ts';
import { readCallIO } from './call-io.ts';
import { createCardsIndex, defaultCardsIndexFile } from './cards-index.ts';
import { ClientRegistry, type SseSink } from './clients.ts';
import { createProber, type PendingCommand, type Vanished } from './command-liveness.ts';
import { buildComparison } from './compare.ts';
import {
  applyPrecedence,
  defaultConfig,
  type NotifyConfig,
  readConfigStrict,
  restartPending,
  type SeedDeepConfig,
  writeConfig,
} from './config.ts';
import { type DigestEntry, digestEntry } from './digest.ts';
import { createLiveTrees } from './live-trees.ts';
import { createNotifyEngine } from './notify-engine.ts';
import { sendWebhook } from './notify-webhook.ts';
import { streamReplay } from './replay.ts';
import { buildSearchRows, createSearchIndex, defaultIndexFile } from './search-index.ts';
import { cardsForSession } from './session-cards.ts';
import { commitsForSession, sessionsForCommit } from './session-commits.ts';
import { filesForSession } from './session-files.ts';
import { sseFrame } from './sse.ts';
import { type CertOrigin, ensureTlsCert } from './tls.ts';
import { readToolOutput } from './tool-output.ts';
import { type UpdateStatus, updateStatus } from './update-check.ts';
import { type Channel, detectChannel, ownExecPath } from './update-cmd.ts';
import { FROM_SOURCE, VERSION } from './version.ts';

export interface ServerDeps {
  watcher: EventEmitter;
  discover: () => Promise<SessionRecord[]>;
  port: number;
  /** Bind address for the HTTP(S) server. Defaults to `'127.0.0.1'`. */
  host?: string;
  /** Full resolved config (for auth token and the `/api/config` endpoints). */
  config?: SeedDeepConfig;
  /** Where the aggregate cache is persisted. Defaults to {@link defaultCacheFile}. */
  cacheFile?: string;
  /** Where the session-search index is persisted. Defaults to {@link defaultIndexFile}. */
  indexFile?: string;
  /** Where the tracker-card index is persisted. Defaults to {@link defaultCardsIndexFile}. */
  cardsIndexFile?: string;
  /** How often the live stream sends a keepalive comment. Defaults to {@link HEARTBEAT_MS}. */
  heartbeatMs?: number;
  /** How often background commands with no fate are probed. Defaults to {@link LIVENESS_MS}. */
  livenessMs?: number;
  /** The liveness prober, injectable so a test can decide the verdict instead of the machine. */
  prober?: { probe: (pending: readonly PendingCommand[]) => Promise<Vanished[]> };
  /**
   * Injectable exit function for `POST /api/restart`. Defaults to `process.exit`.
   * Override in tests to capture the call without terminating the process.
   */
  exit?: (code: number) => void;
  /**
   * Injectable self-restart function for `POST /api/restart`. Defaults to spawning a
   * detached copy of the current process via `Bun.spawn` + `unref()`. Override in tests
   * to avoid actually spawning a child process.
   */
  spawnSelf?: () => void;
  /**
   * Where `POST /api/config` persists the config. Defaults to `~/.seedeep/config.json`.
   * Override in tests to prevent the handler from writing to the real user config.
   */
  configPath?: string;
  /**
   * The CLI flags and environment this process was STARTED with — the two layers above the file
   * in {@link applyPrecedence}. Held so the server can answer what a restart would resolve to,
   * which is the only honest way to say whether one is pending. Default to nothing and the real
   * environment; a test that cares passes `env: {}` so an exported `SEEDEEP_PORT` on the
   * contributor's machine cannot decide the verdict.
   */
  cliFlags?: Partial<Pick<SeedDeepConfig, 'port' | 'host' | 'open'>>;
  env?: Record<string, string | undefined>;
  /**
   * What `GET /api/update` answers. Defaults to the cached npm check. Override in tests — the
   * default is the one handler that can reach the network.
   */
  updateStatus?: () => Promise<UpdateStatus>;
  /**
   * How this server was installed, for `GET /api/update`. Defaults to reading the running
   * executable's path. Override in tests, where that path is bun's own.
   */
  channel?: Channel;
  /**
   * @internal Set to `true` in tests that exercise auth without a real TLS certificate.
   * Never set this in production — it disables TLS on non-loopback servers.
   */
  _skipTls?: boolean;
}

export interface RunningServer {
  /** Clean base URL, without auth token — safe for programmatic callers and tests. */
  url: string;
  /** URL to print/open in the browser: identical to `url` in loopback mode, appends
   * `?token=` in non-loopback mode so the browser can persist the token on first load. */
  openUrl: string;
  /**
   * SHA-256 fingerprint of the certificate this server presents, or null in loopback mode
   * (no TLS, nothing to pin). Exposed so the CLI can print it on every start — a value only
   * shown on the run that generated the cert is one a user cannot verify against later.
   */
  tlsFingerprint: string | null;
  /**
   * Where that certificate came from on this start, or null in loopback mode. `'replaced'` is
   * the one a caller must act on: the stored pair did not certify the configured name, so the
   * fingerprint above is NOT the one any existing client pinned.
   */
  tlsCertOrigin: CertOrigin | null;
  stop(): void;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

// ~one MTU. Below it a gzip stream's own header and trailer eat most of what it saves, and
// the CPU is spent for nothing — the live poll (~1 KB) deliberately falls under this.
const GZIP_MIN_BYTES = 1400;

/**
 * How often the live stream writes a keepalive frame. A session can be silent for minutes
 * (a background subagent writes only to its own file), and a connection carrying nothing is
 * indistinguishable from one that has died — the page then waits forever on a stream nobody
 * is writing to. 15s is below the idle window of the paths in between (proxies, NAT, a Wi-Fi
 * interface renegotiating) and costs 32 bytes a minute per client.
 *
 * The browser's silence watchdog (`client/stream.ts` STALE_MS) is calibrated against this, so the
 * two cannot be changed independently — raising this above that window makes every healthy client
 * declare itself lost on a cadence. Exported so a test can assert the relation.
 */
export const HEARTBEAT_MS = 15_000;

/**
 * How often the background commands with no fate yet are asked whether their process still exists.
 *
 * Deliberately its own clock and not the watcher's 300 ms tick: a probe spends a subprocess (~35 ms
 * with 691 processes on the box), and nothing about this question moves fast. Two probes are needed
 * before a row tips, so a command reads `unknown` about half a minute after it dies — against the
 * 40 minutes it used to keep counting.
 */
export const LIVENESS_MS = 15_000;

/**
 * How long the notification engine waits after a transcript event before reading the digest.
 *
 * A turn appends many lines in a burst — a thinking block, a text block, then each tool call — and
 * the digest is the same answer for all of them. Coalescing spends one reading instead of a dozen.
 * It is far below the tray's own 1s open / 5s closed poll, so nothing here is the slower of the two.
 */
const NOTIFY_COALESCE_MS = 300;

/**
 * How often the notification engine looks even when the transcript has said nothing.
 *
 * A session waiting on an approval is SILENT — it writes its next line only once the user answers —
 * so the state that matters changes with no event to hang an evaluation on. One second matches what
 * the tray's own poll spent while its panel was open, and it runs only while `wanted()`.
 */
const NOTIFY_SWEEP_MS = 1_000;

const encoder = new TextEncoder();

/**
 * True when `host` is a loopback address: `127.0.0.1`, `::1`, or `localhost`.
 * Loopback is trusted; non-loopback triggers Bearer auth + TLS.
 */
export function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

/**
 * Send `body` with conditional GET and compression negotiated: a strong ETag over the exact
 * bytes (a client that already has them gets 304 and no body) and gzip when the caller
 * accepts it and the body is big enough to be worth it.
 *
 * `cache-control: no-cache` means "revalidate every time", NOT "do not store": it is what
 * lets a reload cost one 304 instead of the whole bundle, while making it impossible to
 * serve a stale `public/lib/app.js` after a rebuild — the ETag changes with the bytes.
 */
export function sendCacheable(req: Request, body: Uint8Array<ArrayBuffer>, contentType: string): Response {
  const gzip = body.byteLength >= GZIP_MIN_BYTES && (req.headers.get('accept-encoding') ?? '').includes('gzip');
  // The tag names the REPRESENTATION, not the resource: gzipped and identity bodies are two
  // different sets of bytes, and a strong validator shared between them lets a cache answer an
  // identity revalidation with the compressed entry. `vary` alone relies on every cache in the
  // path honouring it.
  const etag = `"${Bun.hash(body).toString(36)}${gzip ? '-gz' : ''}"`;
  const headers: Record<string, string> = {
    'content-type': contentType,
    'cache-control': 'no-cache',
    etag,
    vary: 'accept-encoding',
  };
  if (req.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
  if (gzip) return new Response(Bun.gzipSync(body), { headers: { ...headers, 'content-encoding': 'gzip' } });
  return new Response(body, { headers });
}

/** JSON body, with the same conditional-GET + gzip treatment as any other response. */
function json(req: Request, value: unknown): Response {
  return sendCacheable(req, encoder.encode(JSON.stringify(value)), 'application/json;charset=utf-8');
}

/**
 * Read the replay's `from` parameter: `key:seq` pairs, comma-separated, where the key is a
 * subagent's `agentId` and an empty key is the parent transcript (`:1234,ag-7:12`). Returns
 * undefined for absent or unreadable input — a mark that cannot be understood must replay the
 * session WHOLE, since withholding history on a guess is the exact failure this repairs.
 * Pairs that do not parse are dropped individually, for the same reason.
 */
export function parseMarks(raw: string | null): Map<string, number> | undefined {
  if (!raw) return undefined;
  const marks = new Map<string, number>();
  for (const pair of raw.split(',')) {
    const at = pair.lastIndexOf(':'); // lastIndexOf: an agentId may itself contain a colon
    if (at < 0) continue;
    const seq = pair.slice(at + 1);
    // Digits only, NOT `Number`: it reads '' as 0, and a mark of 0 withholds that file's first
    // line on the strength of an empty string — the exact "silently send less" this refuses.
    // (It is also generous with ' 5' and '0x10', which no caller of ours writes.)
    if (!/^\d+$/.test(seq)) continue;
    marks.set(pair.slice(0, at), Number(seq));
  }
  return marks.size > 0 ? marks : undefined;
}

/**
 * Redact the config for the `/api/config` endpoint: token → `"***"`, cert/key paths omitted,
 * `version` added, and `tls.fingerprint` added when the server is actually serving TLS.
 *
 * Neither `version` nor the fingerprint is config: both are RUNTIME state describing the process
 * answering, and neither is ever written back to `config.json` (only `currentConfig` is). They ride
 * here because this is the endpoint that already answers "what is this server" — and the version has
 * to be readable before anything else is, which on a remote host means before a token exists.
 *
 * The fingerprint is safe on this unauthenticated endpoint because the certificate is already
 * presented in the clear on every handshake — it is a convenience for the client, not a channel of
 * trust. The version names a public release.
 *
 * `authed` is what the endpoint's exemption from auth does NOT extend to. That exemption was granted
 * for one reason — the version has to be readable before a token exists — and `dev` is not in that
 * class: nothing needs it before authenticating, and it is the one field here that tells a stranger
 * something about the operator's machine they could not already know (host and port are what they
 * used to arrive). The portal reads this through `authFetch`, so the mark works in both modes.
 */
/** What a secret reads as on the wire. One constant, so redaction and its inverse cannot drift. */
const REDACTED = '***';

/**
 * `base` with the fields a `POST /api/config` body carries written over it — each provided
 * top-level field overwrites, sub-objects are shallow-merged, absent fields are left alone.
 *
 * A function rather than the assignments it replaces because the merge now happens TWICE against
 * two different bases — the file, for what is written, and the running config, for what takes
 * effect without a restart — and two hand-written copies of it would be free to disagree about
 * which fields a save touches. Assumes the body has already been validated.
 */
function mergeConfigBody(base: SeedDeepConfig, body: Record<string, unknown>): SeedDeepConfig {
  const out: SeedDeepConfig = { ...base, auth: { ...base.auth }, tls: { ...base.tls } };
  if (body['port'] !== undefined) out.port = body['port'] as number;
  if (body['host'] !== undefined) out.host = body['host'] as string;
  if (body['open'] !== undefined) out.open = Boolean(body['open']);
  if (body['auth'] && typeof body['auth'] === 'object') {
    out.auth = { ...out.auth, ...(body['auth'] as Record<string, unknown>) } as SeedDeepConfig['auth'];
  }
  if (body['tls'] && typeof body['tls'] === 'object') {
    out.tls = { ...out.tls, ...(body['tls'] as Record<string, unknown>) } as SeedDeepConfig['tls'];
  }
  if (body['notifications'] && typeof body['notifications'] === 'object') {
    out.notifications = mergeNotificationsPost(out.notifications, body['notifications'] as Record<string, unknown>);
  }
  return out;
}

function redactConfig(cfg: SeedDeepConfig, fingerprint: string | null, authed: boolean): object {
  const { tls, auth, ...rest } = cfg;
  const { cert: _c, key: _k, ...tlsRest } = tls;
  return {
    ...rest,
    version: VERSION,
    // So the portal can mark itself. Two seedeeps on one machine watch the SAME sessions — the
    // transcripts are Claude Code's — so two browser tabs are otherwise the same page, and the one
    // you are reconfiguring is a coin toss.
    ...(authed ? { dev: FROM_SOURCE } : {}),
    auth: { token: '***' },
    tls: fingerprint === null ? tlsRest : { ...tlsRest, fingerprint },
    // A header value is where every notification service puts its token, and this endpoint answers
    // without auth. The panel is told a header EXISTS and never what it says — the same bargain
    // `auth.token` already makes, and `POST` puts the stored value back when it sees `***`.
    notifications: {
      ...rest.notifications,
      webhook: {
        ...rest.notifications.webhook,
        // The URL is a CREDENTIAL, not an address: for Slack, Discord and ntfy, whoever holds it can
        // post into the channel. This endpoint answers without auth even in remote mode, so it says
        // only whether one is configured.
        url: rest.notifications.webhook.url === '' ? '' : REDACTED,
        headers: Object.fromEntries(Object.keys(rest.notifications.webhook.headers).map((k) => [k, REDACTED])),
      },
    },
  };
}

/**
 * Merge a `POST /api/config` body's `notifications` onto the stored one, channel by channel.
 *
 * A header whose incoming value is exactly {@link REDACTED} keeps the value already stored: the
 * panel reads `***` and posts the whole object back, so taking it literally would erase the token
 * on the first save the user made for any other reason. A header the body omits is DELETED — that
 * is how the panel removes one, and it is why this is not a blanket merge.
 */
function mergeNotificationsPost(stored: NotifyConfig, given: Record<string, unknown>): NotifyConfig {
  const obj = (v: unknown): Record<string, unknown> =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const hook = obj(given['webhook']);
  // `***` means "keep what you have", for the URL exactly as for a header: the panel reads the
  // redaction and posts the whole object back, and taking it literally would store the mask.
  const url = hook['url'] === undefined || hook['url'] === REDACTED ? stored.webhook.url : String(hook['url']);
  const headers =
    hook['headers'] === undefined
      ? stored.webhook.headers
      : Object.fromEntries(
          Object.entries(obj(hook['headers'])).map(([k, v]) => [
            k,
            v === REDACTED ? (stored.webhook.headers[k] ?? '') : String(v),
          ]),
        );
  return {
    tray: { ...stored.tray, ...obj(given['tray']) } as NotifyConfig['tray'],
    webhook: { ...stored.webhook, ...hook, url, headers } as NotifyConfig['webhook'],
  };
}

/** Run the macOS `security add-generic-password` command and return the result. */
/**
 * Start the local HTTP(S) server. On a non-loopback `host`:
 * - Enforces `Authorization: Bearer <token>` on all routes except `GET /api/config`.
 * - Sets up a self-signed TLS cert (generated once with openssl, reused on every restart).
 * - Throws if `tls.commonName` is not set (caller must configure it before using a remote host).
 *
 * Serves the GUI's files from the map compiled into the binary ({@link assetPath}) and exposes
 * read-only endpoints — `/api/sessions`,
 * `/api/live`, `/api/stream`, `/api/replay`, `/api/tool-output`, `/api/call-io`,
 * `/api/session-stats`, `/api/baseline`, `/api/retro`, `/api/compare` — plus three config
 * management endpoints: `GET /api/config` and `POST /api/config`. Subscribes to `deps.watcher` on start;
 * call the returned `stop()` to unsubscribe and close.
 */
export async function startServer(deps: ServerDeps): Promise<RunningServer> {
  const host = deps.host ?? '127.0.0.1';
  const loopback = isLoopback(host);
  const exitFn = deps.exit ?? ((code: number) => process.exit(code));
  const spawnSelfFn =
    deps.spawnSelf ??
    (() => {
      // `selfInvocation` rather than `argv.slice(1)`: in the compiled binary that slice starts
      // with the bunfs entry path, which is not an argument the program can be given back.
      // Measured on the real binary — the restarted server refused it and never came up.
      const child = Bun.spawn([...selfInvocation(process.execPath, Bun.main, FROM_SOURCE), ...process.argv.slice(2)], {
        stdio: ['inherit', 'inherit', 'inherit'],
      });
      child.unref();
    });

  // Mutable config copy — updated by POST /api/config without touching the rest of the server.
  const currentConfig: SeedDeepConfig = {
    ...(deps.config ?? defaultConfig()),
    auth: { ...(deps.config ?? defaultConfig()).auth },
    tls: { ...(deps.config ?? defaultConfig()).tls },
  };

  // What this process actually came up with, frozen before anything can edit it. `currentConfig`
  // cannot answer for it: the first POST rewrites it, and from then on the server would be
  // comparing the desired state against itself and reporting a stale process as fresh.
  const startedWith: SeedDeepConfig = {
    ...currentConfig,
    auth: { ...currentConfig.auth },
    tls: { ...currentConfig.tls },
  };

  /**
   * The configuration a start would come up with RIGHT NOW: `config.json` as it stands, under the
   * flags and environment this process was given. Recomputed per request and never cached — a
   * cached answer is how a file edited by hand stays invisible, which is the failure this exists
   * to end.
   *
   * This, not the running copy, is what `GET /api/config` answers with: the panel is an editor of
   * the configuration, and showing values the process happens to hold made a save write them back
   * over an edit the user had made in a file. `version` and the fingerprint stay the process's own
   * — they describe what is answering, and no edit can change them.
   *
   * An unreadable file falls back to what is running: that reports nothing pending, rather than
   * sending the user to restart into exactly what they already have.
   */
  const desiredConfig = async (): Promise<SeedDeepConfig> => {
    try {
      return applyPrecedence(deps.cliFlags ?? {}, deps.env ?? process.env, await readConfigStrict(deps.configPath));
    } catch {
      // `readConfigStrict`, so this catch is REACHABLE: the lenient reader turns a malformed file
      // into the defaults, and answering with those would show settings nobody chose and invite a
      // restart into them. What is running is the honest answer, and it reports nothing pending.
      return currentConfig;
    }
  };

  // Non-loopback safety checks and TLS setup.
  // Bun.serve tls.cert/key must be PEM content (string/Buffer/BunFile), NOT a file path.
  // Bun.file() creates a lazy reference that Bun reads when the server starts.
  let tlsOpts: { cert: ReturnType<typeof Bun.file>; key: ReturnType<typeof Bun.file> } | undefined;
  // Null until TLS is actually set up. It stays null in loopback mode, where there is no
  // certificate at all — an absent fingerprint says "nothing to pin", never "unknown".
  let tlsFingerprint: string | null = null;
  let tlsCertOrigin: CertOrigin | null = null;
  if (!loopback && !deps._skipTls) {
    if (!currentConfig.tls.commonName) {
      throw new Error(
        'seedeep: binding to a non-loopback address requires tls.commonName.\n' +
          'Set it in ~/.seedeep/config.json or pass SEEDEEP_TLS_CN=<hostname>.',
      );
    }
    const {
      cert: certPath,
      key: keyPath,
      fingerprint,
      origin,
    } = await ensureTlsCert(currentConfig.tls.commonName, currentConfig.tls.cert, currentConfig.tls.key);
    tlsOpts = { cert: Bun.file(certPath), key: Bun.file(keyPath) };
    tlsFingerprint = fingerprint;
    tlsCertOrigin = origin;
  }

  // Migrate the cache from the old ~/.claude/.cache/seedeep/ location on first run.
  await maybeMigrateCache();

  const registry = new ClientRegistry();

  // ONE corpus scanner for both the minute-zero retrospective (`/api/retro`) and the personal
  // baseline the share card places a turn against (`/api/baseline`). The persistent incremental cache
  // re-parses only files that changed since last launch, so even a cold start is milliseconds —
  // no more full rescan on every roster-size change, no more stale entry when a session grows.
  const cache = createAggregateCache({ cacheFile: deps.cacheFile ?? defaultCacheFile() });
  const getRetro = async () => cache.refresh((await deps.discover()).map((r) => r.path));

  // The session-search corpus. Its own file, its own lifecycle: it holds the DIALOGUE (~20 MB on
  // a 1000-session corpus), which the retrospective never reads and would rewrite on every
  // refresh if the two shared a cache. Refreshed on demand, so it costs nothing until searched.
  const searchIndex = createSearchIndex({ indexFile: deps.indexFile ?? defaultIndexFile() });
  const cardsIndex = createCardsIndex({ indexFile: deps.cardsIndexFile ?? defaultCardsIndexFile() });

  // Live derived state for `/api/digest`. Holds nothing until a client asks: no tree is built
  // for a session nobody is watching, which is what keeps an idle process idle.
  const liveTrees = createLiveTrees({ watcher: deps.watcher });

  /**
   * Every live session's digest entry — what `/api/digest` answers with, and what the notification
   * engine reads. One session's failure must not answer for the others: a seed that throws would
   * otherwise reject the whole response, and a polling client would see the digest 500 until that
   * one file recovers.
   */
  const buildDigest = async (): Promise<DigestEntry[]> => {
    const live = (await deps.discover()).filter(isLive);
    liveTrees.retain(live.map((s) => s.sessionId));
    const built = await Promise.all(
      live.map(async (s) => {
        try {
          const snap = (await liveTrees.ensure(s)).snapshot();
          // After `ensure`: the sighting is stamped by the seed, so reading it first would report
          // "never seen" for every session the server has not held a tree for yet.
          return digestEntry(s, snap, { now: Date.now(), wordSeenAt: liveTrees.wordSeenAt(s.sessionId) });
        } catch (err) {
          console.error(`seedeep: digest skipped ${s.sessionId} —`, err);
          return null;
        }
      }),
    );
    return built.filter((e) => e !== null);
  };

  /**
   * Who decides an event is worth interrupting the user for, and on which channel.
   *
   * `hasListeners` is what keeps an unwatched process idle: the tray is worth evaluating only while
   * a client is subscribed — a closed tray has nobody to deliver to, and an open one is already
   * asking for the digest on its own clock. A configured webhook always is, because its destination
   * is not on this machine.
   */
  const notify = createNotifyEngine({
    config: () => currentConfig.notifications,
    deliver: (a, channel) => {
      if (channel === 'tray') {
        registry.broadcast('notification', a);
        return;
      }
      // Not awaited: the engine must not be held while a user's endpoint answers, or the next
      // event waits behind an address that may never answer at all. The outcome is logged once —
      // a webhook that is silently failing is a setting the user cannot debug.
      void sendWebhook(currentConfig.notifications.webhook, a).then((r) => {
        if (!r.ok) console.warn(`seedeep: webhook POST failed${r.status === null ? '' : ` (HTTP ${r.status})`}`);
      });
    },
    hasListeners: () => registry.size() > 0,
  });

  // Coalesced: a turn appends many lines in a burst and the digest is the same answer for all of
  // them.
  let notifyTimer: ReturnType<typeof setTimeout> | null = null;
  // One build at a time. The first is materially slower than the rest — `liveTrees.ensure` seeds
  // from disk on first sight — so two in flight would resolve out of order and rewind `seen` to an
  // older reading, announcing the same finish twice.
  let building = false;
  // Whether anyone was listening last time, so the loss of the last one can RE-SEED. Without this,
  // `seen` keeps a snapshot from whenever the tray was closed and the next reading announces a wait
  // that happened half an hour ago — the exact misdating the seed rule exists to prevent.
  let wasWanted = false;

  const evaluate = () => {
    const wanted = notify.wanted();
    if (wasWanted && !wanted) {
      // Nobody left to tell. Forget what was seen, so whoever arrives next starts from a seed.
      notify.feed(null);
    }
    wasWanted = wanted;
    if (notifyTimer !== null || building || !wanted) return;
    notifyTimer = setTimeout(() => {
      notifyTimer = null;
      building = true;
      // A reading that could not be made re-seeds rather than announcing a stale transition.
      buildDigest()
        .then(
          (entries) => notify.feed(entries),
          () => notify.feed(null),
        )
        .finally(() => {
          building = false;
        });
    }, NOTIFY_COALESCE_MS);
    (notifyTimer as { unref?: () => void }).unref?.();
  };

  /**
   * The heartbeat the transcript cannot provide.
   *
   * `needsYou` and `finishes` are decided by `status`, which lives in `~/.claude/sessions/` and NOT
   * in the transcript — and a session stopped on an approval writes nothing at all until the user
   * answers. An edge trigger on transcript events therefore misses precisely the event the feature
   * exists for. The tray's poll used to cover this; removing it without replacing it was the
   * regression. Runs only while there is somebody to tell, so an unwatched process is still idle.
   */
  const notifySweep = setInterval(() => evaluate(), NOTIFY_SWEEP_MS);
  (notifySweep as { unref?: () => void }).unref?.();

  const onEvent = (e: NormalizedEvent) => {
    registry.broadcast(e.type, e);
    evaluate();
  };
  const onAdded = (id: string) => {
    registry.broadcast('session-added', id);
    evaluate();
  };
  deps.watcher.on('event', onEvent);
  deps.watcher.on('session-added', onAdded);

  // Keeps quiet connections alive AND makes dead ones say so — see HEARTBEAT_MS. Unref'd so
  // it is the server, not this timer, that decides whether the process stays up.
  const heartbeat = setInterval(() => registry.ping(), deps.heartbeatMs ?? HEARTBEAT_MS);
  (heartbeat as { unref?: () => void }).unref?.();

  // Is a background command still alive? Only the machine can say, and only for a command the
  // transcript has stopped talking about — see `command-liveness.ts` for why this exists and what
  // was measured and rejected first. On its own clock, NOT the watcher's 300 ms tick: this spends
  // a process, and a row that is wrong for 15 s is not the bug — one that is wrong for 40 minutes
  // is. A verdict is emitted as an ordinary out-of-band event, so the server's own tree and every
  // browser learn it by the one path they already share.
  const prober = deps.prober ?? createProber();
  // Every verdict this process has reached, by session and launch. It is kept because THE FILE
  // WILL NEVER CARRY IT: a page opened after the probe answered seeds itself by replaying the
  // transcript, and would put the row straight back to `running` — which is the bug, returning
  // through the one door nobody was watching. Found by driving the real browser, not by a test.
  // Bounded by the trees: a session with no tree is a session nobody is watching.
  const vanished = new Map<string, Map<string, CommandVanishedEvent>>();
  // A round can outlive its interval (a slow scratch-root walk, an lsof near its timeout), and the
  // prober carries per-command state across calls: two overlapping rounds would both read the same
  // strike count, both increment it, and tip a command on ONE real interval instead of two — the
  // guarantee the two-strike rule exists to give.
  let probing = false;
  const liveness = setInterval(() => {
    if (probing) return;
    probing = true;
    void (async () => {
      try {
        const pending: PendingCommand[] = [];
        for (const sessionId of liveTrees.sessionIds()) {
          // Not `snapshot()`: that rebuilds every tool node of the session, and this tick runs on
          // every watched session whether or not it ever launched a command.
          for (const c of liveTrees.get(sessionId)?.pendingBackground() ?? []) {
            pending.push({ sessionId, toolUseId: c.toolUseId, taskId: c.taskId });
          }
        }
        // Forget the verdicts of sessions no tree is held for. Keyed on {@link LiveTrees.has},
        // which counts a tree still SEEDING: a session that re-seeds would otherwise lose its
        // verdicts to this prune and come back drawing the row as running — the regression the
        // map exists to prevent, through a door one interval wide.
        for (const id of vanished.keys()) if (!liveTrees.has(id)) vanished.delete(id);
        if (!pending.length) return;
        for (const v of await prober.probe(pending)) {
          const event = {
            type: 'command-vanished',
            sessionId: v.sessionId,
            root: 'cli', // `Root` has exactly one member; nothing reads it on an event
            timestamp: new Date().toISOString(),
            seq: -1, // out of band: it has no position in any file — see live-trees' applyLive
            toolUseId: v.toolUseId,
            lastSeenAlive: v.lastSeenAlive,
          } satisfies CommandVanishedEvent;
          let forSession = vanished.get(v.sessionId);
          if (!forSession) vanished.set(v.sessionId, (forSession = new Map()));
          forSession.set(v.toolUseId, event);
          deps.watcher.emit('event', event);
        }
      } catch {
        // A liveness round that throws must cost nothing but this round. Unhandled, it would be an
        // unhandled REJECTION on a background timer — no request to attribute it to, and the whole
        // process down. The digest handler wraps the same reads for the same reason.
      } finally {
        probing = false;
      }
    })();
  }, deps.livenessMs ?? LIVENESS_MS);
  (liveness as { unref?: () => void }).unref?.();

  const server = Bun.serve({
    port: deps.port,
    hostname: host,
    idleTimeout: 0, // SSE connections are long-lived; do not let Bun close them on idle.
    tls: tlsOpts,
    async fetch(req: Request) {
      const { pathname } = new URL(req.url);

      // Whether this caller has proven it may see everything. Loopback has no token to present and
      // nothing to prove; otherwise it is the Bearer header, or `?token=` for the EventSource routes
      // that cannot set headers, with the header winning when both are there.
      //
      // A function rather than the inline check it replaces, because GET /api/config is exempt from
      // the middleware yet still has to know the answer: the exemption exists so the VERSION is
      // readable before a token exists, and it must not become a way to read everything else.
      const authorised = (): boolean => {
        if (loopback) return true;
        const auth = req.headers.get('authorization');
        const urlToken = new URL(req.url).searchParams.get('token');
        const provided = auth?.startsWith('Bearer ') ? auth.slice(7) : urlToken;
        return provided !== null && provided !== undefined && provided === currentConfig.auth.token;
      };

      // Auth middleware: in non-loopback mode, all /api/* routes except GET /api/config
      // require a Bearer token. Static files (HTML, CSS, JS) are not protected — they carry
      // no session data.
      if (pathname.startsWith('/api/') && !(req.method === 'GET' && pathname === '/api/config') && !authorised()) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
          headers: { 'content-type': 'application/json;charset=utf-8' },
        });
      }

      // POST routes (config management)
      if (pathname === '/api/config' && req.method === 'POST') {
        // Require application/json to block the text/plain form-CSRF vector and force a CORS
        // preflight on cross-origin requests (browsers won't send application/json cross-origin
        // without a preflight, which we reject by not emitting CORS headers).
        const ct = req.headers.get('content-type') ?? '';
        if (!ct.includes('application/json')) {
          return new Response(JSON.stringify({ error: 'Content-Type must be application/json' }), {
            status: 415,
            headers: { 'content-type': 'application/json;charset=utf-8' },
          });
        }
        let body: Record<string, unknown>;
        try {
          body = (await req.json()) as Record<string, unknown>;
        } catch {
          return new Response(JSON.stringify({ error: 'invalid JSON' }), {
            status: 400,
            headers: { 'content-type': 'application/json;charset=utf-8' },
          });
        }
        if (body['port'] !== undefined && typeof body['port'] !== 'number') {
          return new Response(JSON.stringify({ error: 'port must be a number' }), {
            status: 400,
            headers: { 'content-type': 'application/json;charset=utf-8' },
          });
        }
        if (body['host'] !== undefined && typeof body['host'] !== 'string') {
          return new Response(JSON.stringify({ error: 'host must be a string' }), {
            status: 400,
            headers: { 'content-type': 'application/json;charset=utf-8' },
          });
        }
        // Refused BEFORE the merge, so a name that cannot go in a certificate never reaches
        // config.json — otherwise the next start throws from `ensureTlsCert` and the only way out
        // is to edit the file by hand.
        const cn = (body['tls'] as { commonName?: unknown } | undefined)?.commonName;
        if (cn !== undefined && (typeof cn !== 'string' || !isValidCertName(cn))) {
          return new Response(
            JSON.stringify({
              error: 'tls.commonName must be a hostname or an IPv4 address — letters, digits, hyphens and dots only',
            }),
            { status: 400, headers: { 'content-type': 'application/json;charset=utf-8' } },
          );
        }
        // The FILE is the base for what goes back to disk, re-read here rather than assumed: this
        // process's copy was taken at startup, and writing it back would delete every change made
        // in an editor since — measured, a save of `open` alone put `host` back to what the
        // process was bound to. What goes to disk is the file plus this request; what stays in
        // memory is what the process can honour without a restart.
        try {
          // A file that cannot be understood is NOT a config: falling back to the defaults here
          // would write built-ins over the user's token, port and certificate name on the first
          // save they make for any other reason. What is running is intact, so a save onto that
          // repairs the file instead of emptying it.
          const base = await readConfigStrict(deps.configPath).catch(() => currentConfig);
          await writeConfig(mergeConfigBody(base, body), deps.configPath);
        } catch {
          /* non-fatal: in-memory state below is still updated */
        }
        // Same merge, other base: the token is adopted live and the notification switches are read
        // from here on the next event, so the runtime copy has to carry them.
        Object.assign(currentConfig, mergeConfigBody(currentConfig, body));
        // Read back from disk rather than echoed from the request, and AFTER the write: the answer
        // is about the process and the file, never about this keystroke. Saving a value back to
        // what is already running reports nothing; a save landing on top of an earlier hand edit
        // keeps the signal up. The old diff-on-save could only describe the request that carried it.
        const desired = await desiredConfig();
        return json(req, {
          ...redactConfig(desired, tlsFingerprint, true),
          restart_pending: restartPending(startedWith, desired),
        });
      }

      if (pathname === '/api/restart' && req.method === 'POST') {
        // Spawn a detached copy of this process, then exit. The child inherits all argv
        // so flags like --no-open survive the restart. unref() detaches it from our
        // lifetime — it keeps running after process.exit(0).
        setTimeout(() => {
          spawnSelfFn();
          exitFn(0);
        }, 80);
        return json(req, { ok: true });
      }

      if (req.method !== 'GET') {
        return new Response('method not allowed', { status: 405 });
      }

      // GET /api/config — current config (redacted). No auth required even on remote hosts.
      // `restart_pending` rides this route because it is the same question the route already
      // answers — what is this process actually serving — and every surface that has to state it
      // (portal, tray, `seedeep status`) is already here for the version.
      if (pathname === '/api/config') {
        const desired = await desiredConfig();
        return json(req, {
          ...redactConfig(desired, tlsFingerprint, authorised()),
          restart_pending: restartPending(startedWith, desired),
        });
      }

      // GET /api/update — what npm says is current, from a cache that refreshes once an hour. The
      // ONE endpoint every surface reads, so the tray, the portal and the CLI can never disagree
      // about which version is out there; `current` is this SERVER's version, and a client on
      // another machine compares `latest` against its own.
      //
      // `command` is the half no client could work out: how THIS server was installed is readable
      // only from where its executable lives, and a tray saying "update it in a terminal" without
      // the command leaves the user to guess between bun, npm and a downloaded file.
      if (pathname === '/api/update') {
        const status = await (deps.updateStatus ?? updateStatus)();
        const channel = deps.channel ?? detectChannel(ownExecPath());
        // `git pull` where `Channel` carries null: that type answers "which install command does the
        // CLI print", and for a checkout the CLI writes a sentence instead. The question HERE is
        // narrower — "what does a client tell the user to run" — and a checkout has an answer.
        // `download` keeps null, because replacing a file by hand is not a command.
        const command = channel.command ?? (channel.kind === 'checkout' ? 'git pull' : null);
        return json(req, { ...status, channel: channel.kind, command });
      }

      // The CATALOGUE half of the roster: every session, but only the fields that stop
      // changing once its file exists. Stable, so the client fetches it once and revalidates
      // with an ETag instead of pulling the whole corpus every three seconds.
      if (pathname === '/api/sessions') {
        return json(req, (await deps.discover()).map(toCatalogue));
      }

      // The LIVE half: the handful of sessions that are actually running, in full. This is
      // the only thing the client polls, and it is ~1 KB against the catalogue's ~550 KB.
      if (pathname === '/api/live') {
        return json(req, liveOf(await deps.discover()));
      }

      // Live derived state for a client that does NOT own the reducer: the roster's liveness
      // joined with the live tree's meaning, one entry per live session. `/api/live` and
      // `/api/replay` stay exactly what they are — the first carries records, the second parsed
      // lines; neither carries meaning, which is why a thin client would otherwise have to
      // rebuild the reducer to get any.
      //
      // Two depths, mirroring what a status panel shows: every live session at once, and the
      // running-subagent LIST of the one session the user opened. The trees are seeded here, on
      // the first ask — nothing polls, and `retain` drops what the same discovery just said is
      // no longer live, so a tree never outlives its session.
      if (pathname === '/api/digest') {
        const one = new URL(req.url).searchParams.get('sessionId');
        if (one !== null) {
          const live = (await deps.discover()).filter(isLive);
          liveTrees.retain(live.map((s) => s.sessionId));
          const rec = live.find((s) => s.sessionId === one);
          // 404 also covers a session that has ENDED: the digest serves live sessions, and a
          // client holding a stale entry is the one that knows it was watching it.
          if (!rec) return new Response('unknown or ended session', { status: 404 });
          const tree = await liveTrees.ensure(rec);
          return json(
            req,
            digestEntry(rec, tree.snapshot(), { now: Date.now(), wordSeenAt: liveTrees.wordSeenAt(rec.sessionId) }),
          );
        }
        // The same builder the notification engine reads, so the two can never disagree about what
        // a session is doing. The failed entry is already dropped by `ensure`, so the next poll
        // retries it.
        return json(req, await buildDigest());
      }

      // Per-session turn count and total tokens from the aggregate cache — used by the session
      // picker to annotate each row. Triggers a cache refresh so the data is always current.
      if (pathname === '/api/session-stats') {
        const roster = await deps.discover();
        await getRetro();
        const byPath = cache.statsByPath();
        const result: Record<string, { turns: number; totalTokens: number }> = {};
        for (const r of roster) {
          const stats = byPath.get(r.path);
          if (stats) result[r.sessionId] = stats;
        }
        return json(req, result);
      }

      if (pathname === '/api/baseline') {
        return json(req, (await getRetro()).baseline);
      }

      // The minute-zero retrospective: corpus-wide aggregates (median turn, tokens abandoned to
      // Esc, wasteful turns, …) served from the same incremental cache, so the Home tab paints
      // at launch without waiting for a live turn.
      if (pathname === '/api/retro') {
        return json(req, await getRetro());
      }

      // The cross-session comparison: which session weighed the most in a time window. All three
      // windows ride in one response (the client switches without refetching), each cut to its
      // heaviest few plus the remainder as an aggregate. Same cache as the retrospective.
      if (pathname === '/api/compare') {
        const roster = await deps.discover();
        await getRetro();
        return json(req, buildComparison(roster, cache.weightByPath(), Date.now()));
      }

      // Full-text search over the sessions' DIALOGUE: which session talked about these words.
      // Every match is returned — the client splits Human from Automated and orders the rows;
      // a top-N cut here would read as "this is all of it" while hiding sessions.
      if (pathname === '/api/search') {
        const q = new URL(req.url).searchParams.get('q') ?? '';
        // An empty query costs nothing: no refresh, no corpus read. The tab opens on one.
        if (!q.trim()) return json(req, { terms: [], rows: [], ms: 0 });
        const roster = await deps.discover();
        await searchIndex.refresh(roster.map((r) => r.path));
        const { terms, matches, ms } = searchIndex.search(q);
        const rows = buildSearchRows(roster, matches);
        // Sessions found by ACTION rather than by dialogue. Zero hits, and honestly so: the session
        // did the work without ever naming it in what was said. `density()` already reads 0 chars
        // as 0, so these rows sort last rather than breaking the order.
        const addByAction = (ids: readonly string[]): void => {
          const have = new Set(rows.map((r) => r.sessionId));
          for (const id of ids) {
            if (have.has(id)) continue;
            const rec = roster.find((r) => r.sessionId === id);
            if (!rec) continue;
            rows.push({
              sessionId: rec.sessionId,
              project: rec.project,
              subject: rec.subject,
              entrypoint: rec.entrypoint,
              lastActivity: rec.lastActivity,
              hits: 0,
              chars: 0,
              snippets: [],
            });
          }
        };
        // A commit hash is asked of git as well as of the dialogue. The index holds only what was
        // SAID, and the hash of a commit usually appears only in the output of the command that
        // made it — so the session that did the work is exactly the one text search misses
        // (measured: 29% of commits). Same row shape, same ordering: only the set grows.
        if (looksLikeCommitHash(q)) addByAction(await sessionsForCommit(q.trim().toLowerCase(), roster));
        // A tracker id, likewise: the session that worked on a card names it in a tool call, and
        // often nowhere else. The dialogue index cannot see that call at all. Refreshed only on a
        // query shaped like an id — a text search must not pay for an index it cannot use.
        if (looksLikeCardId(q)) {
          await cardsIndex.refresh(roster);
          addByAction(cardsIndex.sessionsFor(q, roster));
        }
        return json(req, { terms, rows, ms });
      }

      if (pathname === '/api/stream') {
        let sink: SseSink;
        const stream = new ReadableStream({
          start(controller) {
            sink = controller;
            // Send a comment line immediately so the browser's EventSource opens
            // right away instead of blocking until the first real event.
            controller.enqueue(new TextEncoder().encode(': connected\n\n'));
            registry.add(sink);
          },
          cancel() {
            registry.remove(sink);
          },
        });
        return new Response(stream, {
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          },
        });
      }

      if (pathname === '/api/replay') {
        const params = new URL(req.url).searchParams;
        const sessionId = params.get('sessionId') ?? '';
        const marks = parseMarks(params.get('from'));
        const roster = await deps.discover();
        const rec = roster.find((s) => s.sessionId === sessionId);
        if (!rec) return new Response('unknown session', { status: 404 });
        const encoder = new TextEncoder();
        let id = 1;
        // Pull-based stream: the consumer controls the pace. pull() is called each time
        // the client has room for another chunk — at most one SSE frame is buffered at a
        // time, so a slow remote consumer cannot cause the server to pile up frames in
        // memory. cancel() terminates the generator so readline closes its file handle.
        let cancelled = false;
        const gen = streamReplay(rec.path, { sessionId: rec.sessionId, root: rec.root }, marks);
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(': connected\n\n'));
          },
          async pull(controller) {
            if (cancelled) return;
            let result: IteratorResult<NormalizedEvent>;
            try {
              result = await gen.next();
            } catch {
              // I/O error mid-replay — close cleanly rather than leaving the stream open.
              if (!cancelled) controller.close();
              return;
            }
            if (cancelled) return; // cancel() fired while we were awaiting gen.next()
            if (result.done) {
              // The one thing a replay of the FILE can never produce: what the liveness probe
              // learned about a command whose end Claude Code never wrote. Sent last, so it lands
              // on a tree that already holds the launch it refers to — a client that seeds after
              // the verdict would otherwise draw the row as running for ever, which is this
              // feature's own bug coming back through the door nobody was watching.
              for (const e of vanished.get(sessionId)?.values() ?? []) {
                controller.enqueue(encoder.encode(sseFrame(id++, e.type, e)));
              }
              controller.enqueue(encoder.encode(sseFrame(id++, 'replay-end', { sessionId })));
              controller.close();
              return;
            }
            controller.enqueue(encoder.encode(sseFrame(id++, result.value.type, result.value)));
          },
          cancel() {
            cancelled = true;
            gen.return(undefined);
          },
        });
        return new Response(stream, {
          headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' },
        });
      }

      // What one tool returned — read back from the session's jsonl on demand, so the
      // client never has to carry a whole session's tool output in memory.
      if (pathname === '/api/tool-output') {
        const params = new URL(req.url).searchParams;
        const sessionId = params.get('sessionId') ?? '';
        const toolUseId = params.get('toolUseId') ?? '';
        // The path comes from the roster, never from the query — the caller can only name a
        // session seedeep already discovered, not an arbitrary file.
        const rec = (await deps.discover()).find((s) => s.sessionId === sessionId);
        if (!rec) return new Response('unknown session', { status: 404 });
        const out = toolUseId ? await readToolOutput(rec.path, toolUseId) : null;
        // 404 also covers a tool that is still running: it has not reported a result yet.
        if (!out) return new Response('no output for that tool', { status: 404 });
        return json(req, out);
      }

      // The input + output of one API call — read back on demand, same guard and privacy as
      // tool-output: the client holds only the call's totals + a short hint, never its I/O.
      if (pathname === '/api/call-io') {
        const params = new URL(req.url).searchParams;
        const sessionId = params.get('sessionId') ?? '';
        const callId = params.get('callId') ?? '';
        const rec = (await deps.discover()).find((s) => s.sessionId === sessionId);
        if (!rec) return new Response('unknown session', { status: 404 });
        const io = callId ? await readCallIO(rec.path, callId) : null;
        if (!io) return new Response('no such API call', { status: 404 });
        return json(req, io);
      }

      // The commits this session produced. Read-only, and the only endpoint that touches the
      // user's repository — a session that never ran `git commit` returns without doing so.
      if (pathname === '/api/commits') {
        const sessionId = new URL(req.url).searchParams.get('sessionId') ?? '';
        const all = await deps.discover();
        const rec = all.find((s) => s.sessionId === sessionId);
        if (!rec) return new Response('unknown session', { status: 404 });
        return json(req, await commitsForSession(rec, all));
      }

      // The files this session changed, from all three witnesses (ledger, its commits, and — live
      // only — the working tree). Needs every session: the others' ledgers are what stop a shared
      // commit from crediting this one with their files.
      if (pathname === '/api/files') {
        const sessionId = new URL(req.url).searchParams.get('sessionId') ?? '';
        const all = await deps.discover();
        const rec = all.find((s) => s.sessionId === sessionId);
        if (!rec) return new Response('unknown session', { status: 404 });
        return json(req, await filesForSession(rec, all));
      }

      // The tracker cards this session worked on. Transcript-only for an MCP tracker; a forge issue
      // additionally resolves the session's repository, the same way the commits endpoint does.
      if (pathname === '/api/cards') {
        const sessionId = new URL(req.url).searchParams.get('sessionId') ?? '';
        const rec = (await deps.discover()).find((s) => s.sessionId === sessionId);
        if (!rec) return new Response('unknown session', { status: 404 });
        return json(req, await cardsForSession(rec));
      }

      if (pathname === '/api/agent-prompt') {
        const params = new URL(req.url).searchParams;
        const sessionId = params.get('sessionId') ?? '';
        const agentId = params.get('agentId') ?? '';
        const rec = (await deps.discover()).find((s) => s.sessionId === sessionId);
        if (!rec) return new Response('unknown session', { status: 404 });
        const result = agentId ? await readAgentPrompt(rec.path, agentId) : null;
        if (!result) return new Response('no prompt found', { status: 404 });
        return json(req, result);
      }

      // The GUI's own files, from the map compiled into this binary (`assets.ts`).
      const full = assetPath(pathname);
      if (full === null) {
        return new Response('not found', { status: 404 });
      }
      try {
        // Buffer is typed over ArrayBufferLike (it could sit on a SharedArrayBuffer); a file
        // read never does, and both Bun.gzipSync and Response want the narrower type.
        const body = (await readFile(full)) as Uint8Array<ArrayBuffer>;
        const ext = full.slice(full.lastIndexOf('.'));
        return sendCacheable(req, body, CONTENT_TYPES[ext] ?? 'application/octet-stream');
      } catch {
        return new Response('not found', { status: 404 });
      }
    },
  });

  // Construct a connectable URL: 0.0.0.0 and :: are bind addresses, not connect addresses.
  const connectHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const proto = tlsOpts ? 'https' : 'http';
  // For TLS (non-loopback), print the configured name: `ensureTlsCert` puts it in the SAN, so
  // this is the one address a client can validate the certificate against by name.
  const displayHost = isLoopback(host)
    ? 'localhost'
    : tlsOpts && currentConfig.tls.commonName
      ? currentConfig.tls.commonName
      : connectHost;
  const url = `${proto}://${displayHost}:${server.port}`;
  // In non-loopback mode, append the token so the browser can save it to localStorage on
  // first load. The client removes it from the URL immediately (history.replaceState) so
  // it does not persist in browser history or Referer headers after the first visit.
  // `url` stays clean (no token) for programmatic callers (tests, relay hooks, etc.).
  const openUrl = loopback ? url : `${url}/?token=${encodeURIComponent(currentConfig.auth.token)}`;

  return {
    url,
    openUrl,
    tlsFingerprint,
    tlsCertOrigin,
    stop() {
      clearInterval(heartbeat);
      clearInterval(notifySweep);
      clearInterval(liveness);
      liveTrees.stop();
      deps.watcher.off('event', onEvent);
      deps.watcher.off('session-added', onAdded);
      server.stop(true);
    },
  };
}
