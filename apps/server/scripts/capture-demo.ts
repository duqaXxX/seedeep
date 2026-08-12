/**
 * Produce the README's demo assets from a SYNTHETIC Claude Code session.
 *
 * Two phases, deliberately separate:
 *
 *   record  drives a real `cli` session on a fictional project and saves its transcript bundle.
 *           Costs tokens. Run it once.
 *   shoot   replays that bundle into an isolated config dir AT ITS ORIGINAL PACE while seedeep
 *           watches, so the live surfaces animate exactly as they did. Free, repeatable.
 *
 * The split is what makes the capture reviewable: the transcript sits on disk between the two
 * phases, so it can be read before a single frame is drawn. It is also why re-cutting a GIF costs
 * nothing — the expensive half already happened.
 *
 * A `cli` session and not `claude -p`: headless sessions are a different species (no `origin`, no
 * `turn_duration`), so a demo built on `-p` would show surfaces the real product never renders.
 */

import { rmSync } from 'node:fs';
import { appendFile, cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { openProbeSession, type ProbeSession, slugFor } from '../probe/driver.ts';
import { cliRoot } from '../src/server/roots.ts';
import { VERSION } from '../src/server/version.ts';
import { SCENES as DOC_SCENES, materialiseRepo, substituteHashes, writeScene } from './doc-scenes.ts';
import { type DocShot, readManifest, verifyVerdicts } from './doc-shots-check.ts';

/**
 * Where the session runs. It is the project name on screen — Claude Code slugifies the cwd and
 * seedeep shows the slug's LAST hyphen segment — so it is chosen, never incidental.
 */
const DEMO_CWD = '/tmp/orbit';
/**
 * Where the recorded bundle is KEPT — and the one thing about it that matters is that it is not
 * under `/tmp`, which is where it used to be. The OS cleans that directory, and it did: the
 * bundle vanished, `bun run doc-shots` stopped working, and re-making it means driving real
 * sessions and burning tokens for figures the manifest promises are free to re-cut. A cache the
 * documentation depends on cannot live somewhere the OS is entitled to empty.
 *
 * The REAL home, never `SEEDEEP_HOME`: a dev run points that at `.seedeep-dev` INSIDE the
 * repository, and a directory of recorded session transcripts must not sit in a git tree even
 * when it is ignored. `SEEDEEP_DEMO_OUT` still overrides it for a one-off.
 */
const OUT = process.env['SEEDEEP_DEMO_OUT'] ?? join(homedir(), '.seedeep', 'demo');

/** Deterministic pseudo-random, so a re-record produces the same fictional log. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000;
}

/** ~450 KB of fictional access log — the cheap way to make a context bar actually fill. */
function accessLog(): string {
  const rnd = lcg(20260806);
  const routes = ['/v1/orbits', '/v1/orbits/:id', '/v1/telemetry', '/v1/passes', '/v1/health', '/v1/keys'];
  const verbs = ['GET', 'POST', 'PUT', 'DELETE'];
  const codes = [200, 200, 200, 201, 204, 400, 401, 404, 429, 500, 503];
  const out: string[] = [];
  for (let i = 0; i < LOG_LINES; i++) {
    const t = new Date(Date.UTC(2026, 6, 14, 0, 0, 0) + i * 17_000).toISOString();
    const route = routes[Math.floor(rnd() * routes.length)]!;
    const verb = verbs[Math.floor(rnd() * verbs.length)]!;
    // /v1/passes is the planted culprit: it fails far more than anything else, so the session has
    // a real finding to reach instead of a vague summary.
    const code = route === '/v1/passes' && rnd() < 0.42 ? 503 : codes[Math.floor(rnd() * codes.length)]!;
    const ms = Math.floor(rnd() * (code >= 500 ? 4000 : 180)) + 3;
    const ip = `10.${Math.floor(rnd() * 200)}.${Math.floor(rnd() * 250)}.${Math.floor(rnd() * 250)}`;
    out.push(`${t} ${ip} ${verb} ${route} ${code} ${ms}ms ua=orbit-client/2.${Math.floor(rnd() * 9)}`);
  }
  return `${out.join('\n')}\n`;
}

/** The fictional codebase the session works on. No real product, company or path appears in it. */
function projectFiles(): Record<string, string> {
  return {
    'README.md': `# orbit

A small HTTP gateway for satellite pass scheduling. Toy project — every number in it is invented.

- \`src/server.ts\` — the listener
- \`src/routes.ts\` — the route table
- \`src/rate-limit.ts\` — per-key token bucket
- \`logs/access.log\` — one day of traffic
`,
    'src/server.ts': `import { routes } from './routes.ts';
import { allow } from './rate-limit.ts';

const PORT = Number(process.env.PORT ?? 8080);

Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);
    const key = req.headers.get('x-api-key') ?? 'anonymous';
    if (!allow(key)) return new Response('rate limited', { status: 429 });
    const handler = routes[url.pathname];
    if (!handler) return new Response('not found', { status: 404 });
    return handler(req);
  },
});

console.log(\`orbit listening on \${PORT}\`);
`,
    'src/routes.ts': `type Handler = (req: Request) => Response | Promise<Response>;

const passes = new Map<string, { window: string; elevation: number }>();

export const routes: Record<string, Handler> = {
  '/v1/health': () => new Response('ok'),
  '/v1/orbits': () => Response.json({ orbits: [] }),
  '/v1/passes': async (req) => {
    const body = await req.json();
    // No validation on body.id: a missing id writes an "undefined" key that never expires.
    passes.set(body.id, { window: body.window, elevation: body.elevation });
    return Response.json({ ok: true });
  },
  '/v1/telemetry': () => Response.json({ samples: [] }),
};
`,
    'src/rate-limit.ts': `const CAPACITY = 60;
const REFILL_PER_SEC = 1;

const buckets = new Map<string, { tokens: number; last: number }>();

export function allow(key: string): boolean {
  const now = Date.now() / 1000;
  const b = buckets.get(key) ?? { tokens: CAPACITY, last: now };
  b.tokens = Math.min(CAPACITY, b.tokens + (now - b.last) * REFILL_PER_SEC);
  b.last = now;
  buckets.set(key, b);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}
`,
    'logs/access.log': accessLog(),
  };
}

/**
 * The ordered scenes. Each one exists to put a specific surface on screen:
 * a big read fills the context bar, a fan-out populates the subagent monitor, an edit gives the
 * Trace a write to show.
 */
/**
 * Log lines per Read call. MEASURED, not estimated: 420 lines came back as 37,913 characters
 * ≈ 9.5K tokens, so a line is ~23 tokens and the tool's 25K ceiling sits around 1100 lines. The
 * earlier value of 420 came from the model's own guess of "~37k tokens" for 700 lines, which was
 * wrong by more than 2× — and left the bar at 28% when the point was to fill it.
 */
const CHUNK_LINES = 1000;
const CHUNK_COUNT = 4;
/** Enough lines to feed every chunk, with a margin so the last Read is not a short one. */
const LOG_LINES = CHUNK_LINES * CHUNK_COUNT + 400;

/**
 * ONE turn, doing everything the hero has to show.
 *
 * It used to be six: an orientation, four chunked reads, a fan-out. That made a hero stitched out
 * of separate turns, where the context climbed in one and the subagents appeared in another — and
 * cutting it anywhere left the seam visible. A single turn that reads the log AND dispatches the
 * agents is one continuous shot: the window fills while the work happens, and the fan-out lands
 * inside the same turn rather than after it.
 *
 * Everything the earlier version learned still applies and is why this prompt looks the way it
 * does: the offsets are spelled out (a generic "read the log" stops as soon as the model can
 * answer, leaving the bar at 16%), the chunks are 1000 lines (the Read tool refuses a result over
 * ~25K tokens, and a line is ~23), the models are named (three agents "in parallel" produced two on
 * one run and none on the next), and shell is ruled out (one command Claude Code flags as risky
 * opens an approval dialog an unattended recording can never answer).
 */
const SCENES: Array<{ name: string; prompt: string }> = [
  {
    name: 'one-turn',
    prompt: [
      'Work through this in one go, no shell commands — files and agents only.',
      `First read logs/access.log in ${CHUNK_COUNT} passes with the Read tool:`,
      Array.from({ length: CHUNK_COUNT }, (_, i) => `offset ${i * CHUNK_LINES + 1} limit ${CHUNK_LINES}`).join(', '),
      '— actually read each slice rather than grepping it, and after each one tell me the dominant status code.',
      'Then, in the same reply, split the follow-up across three agents running in parallel, all three at once:',
      'sonnet checks src/routes.ts for missing input validation,',
      'haiku hunts off-by-one and unbounded growth in src/rate-limit.ts,',
      'opus turns the log finding into a one-paragraph incident note.',
    ].join(' '),
  },
];

/**
 * Short sessions on other fictional projects.
 *
 * Home and Search are archive surfaces: with one session behind them the first capture read
 * "1 turns across 1 sessions", a histogram with a single bar and six counters at zero, and a search
 * that finds only itself. These exist to give those two surfaces something to be about. They are
 * deliberately cheap — two turns, small files, no context filling.
 */
const EXTRAS: Array<{ cwd: string; files: Record<string, string>; scenes: string[] }> = [
  {
    cwd: '/tmp/ledger',
    files: {
      'README.md': '# ledger\n\nA tiny double-entry accounting CLI. Toy project.\n',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: this string IS the fixture's source
      // code — the `${}` belongs to the template literal the fake project contains, not to this one.
      'src/summary.ts':
        "export function summary(rows: Array<{ account: string; cents: number }>) {\n  const byAccount = new Map<string, number>();\n  for (const r of rows) byAccount.set(r.account, (byAccount.get(r.account) ?? 0) + r.cents);\n  return [...byAccount].map(([account, cents]) => `${account}: ${(cents / 100).toFixed(2)}`).join('\\n');\n}\n",
    },
    scenes: [
      'Read src/summary.ts and tell me in two sentences what it does.',
      "Add a --json flag to the summary output, and say what you changed. Edit the file only — don't run anything.",
    ],
  },
  {
    cwd: '/tmp/tiles',
    files: {
      'README.md': '# tiles\n\nAn LRU cache for map tiles. Toy project.\n',
      'src/cache.ts':
        'const MAX = 256;\nconst store = new Map<string, Uint8Array>();\n\nexport function put(key: string, tile: Uint8Array): void {\n  if (store.size >= MAX) store.delete(store.keys().next().value!);\n  store.set(key, tile);\n}\n\nexport function get(key: string): Uint8Array | undefined {\n  return store.get(key);\n}\n',
    },
    // Deliberately read-only: it explores and changes nothing, which is one of the patterns the
    // Home retrospective flags. With every session ending in an edit, that card is a column of
    // zeros and says nothing about what seedeep is for.
    scenes: [
      'Read src/cache.ts. Why would this cache have a worse hit rate than a real LRU?',
      "Don't change anything yet — just tell me what a correct fix would have to do, in two sentences.",
    ],
  },
  {
    cwd: '/tmp/pager',
    files: {
      'README.md': '# pager\n\nOn-call rotation maths. Toy project.\n',
      'src/rotation.ts':
        'export function onCall(people: string[], weeksFromStart: number): string {\n  // Off by one when the rotation wraps: the last person is skipped every cycle.\n  return people[weeksFromStart % (people.length - 1)]!;\n}\n',
    },
    scenes: [
      'Read src/rotation.ts and find the bug in the wrap-around.',
      "Fix it and write a one-line test that would have caught it — write it, don't run it.",
    ],
  },
];

/**
 * A config dir holding nothing but the credentials: no CLAUDE.md, no hooks, no plugins.
 *
 * The first recording ran against the real profile and was useless. That profile's CLAUDE.md says
 * "never Read a file over ~200 lines" and "never delegate a glance-verifiable task to a subagent",
 * so the session analysed the log with `awk` (peak 41K tokens, a bar that never fills) and spawned
 * no agent at all. A demo has to look like a fresh install, because that is what its reader has.
 */
async function cleanProfile(): Promise<string> {
  // Under tmpdir, never under OUT: the profile is ephemeral and carries a live credential for the
  // length of one recording, while OUT is where the bundle is KEPT. Keeping the two apart also
  // means a bundle directory can be synced or inspected without a token having ever been in it.
  const dir = join(tmpdir(), 'seedeep-demo-profile');
  // A `finally` only runs when the process is allowed to finish. Killing a recording mid-scene
  // skipped it and left the credentials copy sitting in /tmp — measured, not hypothetical. These
  // handlers make the copy's lifetime survive an interrupt, which is the only case that matters.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.once(sig, () => {
      try {
        rmSync(join(dir, '.credentials.json'), { force: true });
        rmSync(join(dir, '.claude.json'), { force: true });
      } finally {
        process.exit(130);
      }
    });
  }
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  // From the KEYCHAIN, not from `~/.claude/.credentials.json`. That file is a residue: measured
  // 2026-08-06, its access token had expired hours earlier while `claude` kept working perfectly,
  // because the DEFAULT profile authenticates from the keychain and never rewrites the file. A
  // profile under CLAUDE_CONFIG_DIR does the opposite — it reads only its own file and does not
  // consult the keychain (an onboarded profile without one reports "Not logged in") — so copying
  // the file produced sessions that died on "Login expired" with no other symptom.
  //
  // The value is piped straight into the profile and never rendered: it is deleted the moment the
  // recording ends, including on a signal (see the handlers above).
  const kc = Bun.spawn(['security', 'find-generic-password', '-w', '-s', 'Claude Code-credentials'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const secret = await new Response(kc.stdout).text();
  if ((await kc.exited) !== 0 || secret.trim().length === 0)
    throw new Error('no Claude Code credential in the keychain — a recording cannot authenticate');
  await writeFile(join(dir, '.credentials.json'), secret, { mode: 0o600 });
  // Credentials alone are not enough: they land on the "Select login method" screen, because
  // Claude Code keeps the onboarding state in `.claude.json` — a SIBLING of `~/.claude`, which
  // CLAUDE_CONFIG_DIR relocates INSIDE the profile dir. Measured 2026-08-06: with both files the
  // session runs; with only the credentials it never gets past the login menu.
  const real = JSON.parse(await readFile(join(homedir(), '.claude.json'), 'utf8')) as Record<string, unknown>;
  // Only the onboarding state and whose account it is. Never `projects` (every path ever opened),
  // `mcpServers`, or any cache: the demo profile has no business carrying them, and the smaller the
  // copy, the smaller the thing that has to be deleted afterwards.
  const minimal = {
    hasCompletedOnboarding: true,
    lastOnboardingVersion: real['lastOnboardingVersion'],
    installMethod: real['installMethod'],
    autoUpdates: false,
    numStartups: 20,
    firstStartTime: real['firstStartTime'],
    hasAvailableSubscription: real['hasAvailableSubscription'],
    oauthAccount: real['oauthAccount'],
  };
  await writeFile(join(dir, '.claude.json'), JSON.stringify(minimal, null, 2));
  return dir;
}

/** The transcript's non-empty lines, or none if it does not exist yet. */
async function transcriptLines(s: ProbeSession): Promise<string[]> {
  const raw = await s.transcript();
  return raw ? raw.split('\n').filter((l) => l.trim()) : [];
}

/**
 * Block until the turn that started after line `from` has ENDED, keyed on the `system` line with
 * `subtype: turn_duration` — Claude Code's own end-of-turn marker.
 *
 * Transcript quiescence is not a turn boundary and pretending otherwise cost a whole recording: a
 * long turn goes silent for longer than any sane quiet window, so the next prompt was typed while
 * the session was still working and the TUI ENQUEUED it. The run reported ten scenes "settled",
 * the transcript held five prompts and ten `queue-operation` lines, and the fan-out — the reason
 * the scene exists — never ran. Waiting for the real marker means a prompt is never typed into a
 * busy session, so no queue forms at all.
 */
async function waitForTurnEnd(s: ProbeSession, from: number, scene: string, timeoutMs = 420_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    for (const l of (await transcriptLines(s)).slice(from)) {
      try {
        const o = JSON.parse(l) as { type?: string; subtype?: string };
        if (o.type === 'system' && o.subtype === 'turn_duration') return;
      } catch {
        /* a half-written line: it will parse on the next poll */
      }
    }
    // An approval dialog is a STOP, not slowness: nobody is going to answer it. Detected on the
    // screen because it never reaches the transcript, and detected fast — waiting the full timeout
    // for it cost 7 minutes per scene, twice, and reported "no turn_duration" as if the model had
    // simply been slow.
    if (/requiresapproval|Doyouwanttoproceed/i.test(s.screen().replace(/\s+/g, ''))) {
      throw new Error(`scene ${scene}: blocked on a permission prompt. Screen tail:\n${s.screen().slice(-700)}`);
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`scene ${scene}: no turn_duration within ${timeoutMs}ms. Screen tail:\n${s.screen().slice(-1200)}`);
}

async function record(): Promise<void> {
  const home = homedir();
  const bundle = join(OUT, 'session');
  await rm(bundle, { recursive: true, force: true });
  await mkdir(bundle, { recursive: true });

  const cfgRecord = await cleanProfile();
  console.log(`[record] cwd=${DEMO_CWD} profile=${cfgRecord} out=${bundle}`);
  // acceptEdits, because the clean profile grants nothing: the `edit` scene consumed its prompt and
  // then sat for 420s on an approval dialog, which is a hang with no error and no turn_duration.
  const s = await openProbeSession({
    files: projectFiles(),
    cwd: DEMO_CWD,
    home,
    configDir: cfgRecord,
    permissionMode: 'acceptEdits',
  });
  const projectDir = join(cliRoot(home, { CLAUDE_CONFIG_DIR: cfgRecord }), slugFor(s.cwd));
  console.log(`[record] project dir: ${projectDir}`);

  let ok = false;
  try {
    // No trust-gate handling here on purpose: openProbeSession already clears it and waits for
    // TUI_READY before returning. A second Enter would land in the session as an empty prompt.
    for (const scene of SCENES) {
      console.log(`[record] scene: ${scene.name}`);
      const from = (await transcriptLines(s)).length;
      await s.typeLine(scene.prompt);
      await waitForTurnEnd(s, from, scene.name);
      console.log('[record]   turn ended');
      console.log(
        '[record]   SCREEN>>>',
        s
          .screen()
          .slice(-900)
          .replace(/\n{2,}/g, '\n'),
        '<<<',
      );
    }
    const parent = await s.transcript();
    const children = await s.childTranscripts();
    console.log(`[record] transcript ${parent ? `${parent.length} bytes` : 'MISSING'}, ${children.length} subagents`);
    // Copy the whole project dir, not just the parent jsonl: the subagent transcripts live in a
    // `<uuid>/subagents/` subtree beside it, and without them the monitor has nothing to show.
    await cp(projectDir, join(bundle, slugFor(s.cwd)), { recursive: true });
    await writeFile(
      join(bundle, 'meta.json'),
      `${JSON.stringify({ cwd: s.cwd, slug: slugFor(s.cwd), subagents: children.length, scenes: SCENES.map((x) => x.name) }, null, 2)}\n`,
    );
    ok = true;
  } finally {
    // Copy BEFORE close(), which removes the project dir: on a failed run that transcript is the
    // only thing that can say why, and the first attempt at keeping evidence kept an empty profile
    // because close() had already deleted it. Best-effort — a run that died early has nothing.
    await cp(projectDir, join(bundle, slugFor(s.cwd)), { recursive: true }).catch(() => {});
    // close() deletes the session from the isolated profile — the copy above is the only
    // thing that survives, which is the point: no demo run pollutes the real session list.
    await s.close();
    // The credentials copy exists for exactly one recording, and goes away even if a scene threw.
    await rm(join(cfgRecord, '.credentials.json'), { force: true });
    // The REST of the profile survives a failure on purpose: the first time a scene timed out, this
    // line deleted the transcript that would have said why, and the only evidence left was a screen
    // the TUI had already redrawn. On success there is nothing to keep.
    if (ok) await rm(cfgRecord, { recursive: true, force: true });
    else console.error(`[record] FAILED — profile kept for inspection (credentials removed): ${cfgRecord}`);
  }
  console.log(`[record] done → ${bundle}`);
}

const PORT = Number(process.env['SEEDEEP_DEMO_PORT'] ?? 45999);
/**
 * How much faster than real time the transcript is re-written. A hero GIF nobody watches to the end
 * proves nothing, and a real session's dead air is the first thing to cut.
 */
const SPEED = Number(process.env['SEEDEEP_DEMO_SPEED'] ?? 20);

interface TimedLine {
  at: number;
  rel: string;
  obj: Record<string, unknown>;
}

/**
 * Strip anything that identifies the machine the recording was made on.
 *
 * A synthetic project is not enough. The recorded session ran `ls -la`, and the listing carries the
 * FILE OWNER — the real OS username, eight times, headed for the Trace on a published frame. The
 * cwd was clean and the project fictional; the leak came in through a tool's output, which no
 * choice of project name can control.
 */
function scrub(s: string): string {
  const user = basename(homedir());
  return s.split(homedir()).join('/home/dev').split(user).join('dev');
}

/** The identifier that survived scrubbing, or null. Presence is a hard stop, never a warning. */
function leakIn(s: string): string | null {
  for (const needle of [homedir(), basename(homedir())]) if (s.includes(needle)) return needle;
  return null;
}

/** Every jsonl under `dir`, as paths relative to it. */
async function jsonlFiles(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await jsonlFiles(full, base)));
    else if (e.name.endsWith('.jsonl')) out.push(full.slice(base.length + 1));
  }
  return out;
}

/**
 * Flatten the bundle into ONE timestamp-ordered stream — parent and subagent lines interleaved.
 *
 * Interleaved and not file-by-file: a subagent's lines are written while the parent is mid-turn, and
 * replaying each file to completion in turn would show three agents that start only once the parent
 * has finished, which is the opposite of what the monitor exists to show.
 */
async function timeline(slugDir: string): Promise<TimedLine[]> {
  const lines: TimedLine[] = [];
  for (const rel of await jsonlFiles(slugDir)) {
    let last = 0;
    for (const raw of (await readFile(join(slugDir, rel), 'utf8')).split('\n')) {
      if (!raw.trim()) continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(scrub(raw));
      } catch {
        continue;
      }
      const ts = typeof obj['timestamp'] === 'string' ? Date.parse(obj['timestamp']) : Number.NaN;
      // A line with no timestamp of its own belongs to the moment of the line before it, never to
      // the epoch: sorting it to the front would open the session with its own tail.
      last = Number.isFinite(ts) ? ts : last;
      lines.push({ at: last, rel, obj });
    }
  }
  // The FIRST lines of a file can precede any timestamp at all, and `last` was still 0 for them.
  // Left alone they sort to 1970 and the replay computes a span of 1.78 BILLION seconds — measured,
  // not hypothetical. They belong to the first real moment the session has.
  const firstReal = lines.reduce((m, l) => (l.at > 0 && l.at < m ? l.at : m), Number.POSITIVE_INFINITY);
  if (Number.isFinite(firstReal)) for (const l of lines) if (l.at === 0) l.at = firstReal;
  return lines.sort((a, b) => a.at - b.at);
}

/**
 * The URL the server prints once it is listening, rewritten to the loopback address.
 *
 * Three things the server does that a naive `fetch('http://127.0.0.1:PORT/')` gets wrong: it speaks
 * HTTPS with a self-signed certificate, it refuses a request without the `token` it mints at
 * startup, and it announces itself under the machine's HOSTNAME — which on this machine carries the
 * real username. Reading the banner covers all three, and 127.0.0.1 keeps the hostname out of the
 * address bar even though the recorded video only frames the viewport.
 */
/** Add `session=<id>` to a URL that may or may not already carry a token query. */
function withSession(url: string, sessionId: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}session=${sessionId}`;
}

async function serverUrl(
  proc: { stdout: ReadableStream<Uint8Array> },
  port: number,
  timeoutMs = 30_000,
): Promise<string> {
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const end = Date.now() + timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    while (Date.now() < end) {
      // RACED against the clock, because the clock in the `while` above cannot fire on its own: a
      // server that never writes leaves `read()` pending forever, and the loop never comes back
      // round to notice the deadline. Measured — a run whose port was still held by the previous
      // group's server sat here for an hour and printed nothing, which reads exactly like a slow
      // capture and is in fact a dead one.
      const chunk = await Promise.race([
        reader.read(),
        new Promise<'timeout'>((r) => {
          timer = setTimeout(() => r('timeout'), Math.max(0, end - Date.now()));
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (chunk === 'timeout') break;
      const { value, done } = chunk;
      if (done) break;
      buf += dec.decode(value, { stream: true });
      // Both postures, because both happen: a server on a NAMED host announces an https URL with a
      // token, and one on plain loopback announces http with none — there is no network to
      // authenticate against. Matching only the token form is what made the isolated
      // `SEEDEEP_HOME` (a fresh config = default loopback) wait 30s for a URL that never comes.
      const m = /(https?):\/\/\S+/.exec(buf);
      if (m) {
        const token = /\?token=([A-Za-z0-9_-]+)/.exec(m[0]);
        return `${m[1]}://127.0.0.1:${port}/${token ? `?token=${token[1]}` : ''}`;
      }
    }
  } finally {
    reader.releaseLock();
  }
  throw new Error(`server never announced a URL. Output so far:\n${buf.slice(-500)}`);
}

/**
 * Open a nav destination: the hamburger, then the item whose label contains `needle`.
 *
 * Both selectors were read off the live DOM (`button.nav-btn[aria-label="Menu"]`, `button.nav-item`)
 * and not inferred from a screenshot. The previous version guessed, and its fallback — "click the
 * first button on the page" — killed the browser mid-capture.
 */
async function openNamed(page: import('playwright-core').Page, needle: string): Promise<boolean> {
  await page
    .locator('button.nav-btn[aria-label="Menu"]')
    .click()
    .catch(() => {});
  await page.waitForTimeout(700);
  const item = page.locator('button.nav-item', { hasText: needle }).first();
  if (!(await item.isVisible().catch(() => false))) {
    console.log(`[shoot] nav item "${needle}" not reachable`);
    return false;
  }
  await item.click();
  return true;
}

/** The session the bundle belongs to, read from the first line that names one. */
function sessionIdOf(stream: TimedLine[]): string | null {
  for (const l of stream) {
    const id = (l.obj as { sessionId?: unknown }).sessionId;
    if (typeof id === 'string' && id) return id;
  }
  return null;
}

/** True when the line spawns a subagent — the moment the hero GIF is cut around. */
function isAgentSpawn(obj: Record<string, unknown>): boolean {
  const content = (obj['message'] as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return false;
  return content.some(
    (c) => (c as { type?: string; name?: string }).type === 'tool_use' && (c as { name?: string }).name === 'Agent',
  );
}

/** Directories already created during this replay — `mkdir` per line made the replay I/O-bound. */
const madeDirs = new Set<string>();
/** Child transcripts whose `.meta.json` has already been placed, so it is copied once each. */
const linkedChildren = new Set<string>();

/**
 * Append one replayed line, with its timestamp rewritten to NOW so the session reads as live.
 *
 * The `mkdir` is cached because it used to run for EVERY line: a 154-second session paced at 20×
 * should replay in 8 seconds and took 28, which threw off everything timed against the schedule.
 */
async function writeLine(cfg: string, slug: string, l: TimedLine, srcDir?: string, stampAt?: number): Promise<void> {
  // `stampAt` is the session's OWN interval, moved to now — and where it is given, two cuts of the
  // same code produce the same pixels. Reading the wall clock instead stamps every line with the
  // scheduler's jitter, so every duration on screen (an API call's latency, a subagent's runtime)
  // came out a few milliseconds different each run: four figures differed between two identical
  // cuts, and the pre-push comparison reported a change nobody had made. The GIFs keep the clock:
  // their pace is deliberately not the session's, and nothing compares them.
  const obj = { ...l.obj, timestamp: new Date(stampAt ?? Date.now()).toISOString() };
  const dest = join(cfg, 'projects', slug, l.rel);
  const dir = join(dest, '..');
  if (!madeDirs.has(dir)) {
    await mkdir(dir, { recursive: true });
    madeDirs.add(dir);
  }
  // The `.meta.json` beside a child transcript is the ONLY thing linking it to the `Agent` tool_use
  // that spawned it, and the timeline carries `.jsonl` alone — so without this the three subagents
  // replayed as orphans: the Trace read "3 subagents · no child data yet", their tool calls counted
  // 0, and Expand all had nothing to indent. Every figure of a fan-out was a picture of a state the
  // recorded session never had. Placed just BEFORE the child's first line, so the link exists the
  // moment the watcher sees the file, and never earlier than the spawn it belongs to.
  if (srcDir && l.rel.includes('/subagents/') && !linkedChildren.has(l.rel)) {
    linkedChildren.add(l.rel);
    const rel = l.rel.replace(/\.jsonl$/, '.meta.json');
    const raw = await readFile(join(srcDir, rel), 'utf8').catch(() => null);
    // Scrubbed and leak-checked like every replayed line: this one is copied rather than parsed, so
    // it would otherwise be the one path into the capture that nothing inspects.
    if (raw !== null) {
      const clean = scrub(raw);
      const leak = leakIn(clean);
      if (leak) throw new Error(`${rel} still carries ${leak} after scrubbing — refusing to capture`);
      await writeFile(join(cfg, 'projects', slug, rel), clean);
    }
  }
  await appendFile(dest, `${JSON.stringify(obj)}\n`);
}

/**
 * Seconds of MOTIONLESS tail in a segment — measured on the context card, not the whole frame.
 *
 * The card is what the hero is about, and it stops moving well before the recording does: the feed
 * keeps scrolling behind it, so a whole-frame detector sees motion and reports nothing. The tail is
 * not free either, which is the reason to cut it — 1.6 motionless seconds cost 323 KB, 15.6% of the
 * file, because `--lossy` leaves neighbouring frames slightly different rather than identical and
 * the encoder cannot collapse them. (`du -h` rounded both to "2.0M" and hid it.)
 *
 * The crop is in VIDEO coordinates (1440x900), over the context card at the top left.
 */
async function staticTail(webm: string, startS: number, durS: number): Promise<number> {
  const p = Bun.spawn(
    [
      'ffmpeg',
      '-hide_banner',
      '-ss',
      String(startS),
      '-t',
      String(durS),
      '-i',
      webm,
      '-vf',
      'crop=450:180:30:135,freezedetect=n=-55dB:d=1.0',
      '-map',
      '0:v',
      '-f',
      'null',
      '-',
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const log = await new Response(p.stderr).text();
  await p.exited;
  const ev = [...log.matchAll(/freeze_(start|duration): ([0-9.]+)/g)].map((m) => [m[1]!, Number(m[2])] as const);
  let tailStart: number | null = null;
  for (let i = 0; i < ev.length; i++) {
    if (ev[i]![0] !== 'start') continue;
    const dur = ev[i + 1]?.[0] === 'duration' ? ev[i + 1]![1] : null;
    tailStart = dur === null || ev[i]![1] + dur >= durS - 0.25 ? ev[i]![1] : null;
  }
  return tailStart === null ? 0 : Math.max(0, durS - tailStart);
}

/** One GIF from a segment of the recording, two-pass palette so a dark UI keeps its gradients. */
async function toGif(webm: string, gif: string, startS: number, durS: number): Promise<void> {
  // Every parameter here was measured against the alternatives on a real capture, because the
  // obvious settings produce a 9 MB hero:
  //   - `dither=none`, not bayer. Dithering scatters noise across flat UI panels and destroys the
  //     inter-frame compression a GIF depends on. It is also IRREVERSIBLE: re-encoding an already
  //     dithered GIF made it BIGGER (9.1 → 9.8 MB), and rescaling it bigger still (11 MB).
  //   - `stats_mode=full`, not diff. `diff` weights the pixels that CHANGE — the text — so the
  //     accent colours, which are small and still, get no palette entries: at 64 colours the
  //     context donut rendered grey.
  //   - 128 colours and 6 fps: the point where the same frame is indistinguishable from the 256
  //     colour original.
  const vf =
    'fps=6,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=full[p];[b][p]paletteuse=dither=none';
  const p = Bun.spawn(
    ['ffmpeg', '-y', '-ss', String(startS), '-t', String(durS), '-i', webm, '-vf', vf, '-loop', '0', gif],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  if ((await p.exited) !== 0) throw new Error(`ffmpeg failed: ${await new Response(p.stderr).text()}`);
  // gifsicle halves it again, and it is the only tool that attacks what ffmpeg cannot: near-identical
  // pixels ACROSS frames. `--lossy=30` is indistinguishable from the source here; at 100 the flat
  // dark panels speckle. Skipped without complaint if it is not installed — it is an optimisation,
  // not a dependency.
  if (Bun.which('gifsicle')) {
    const g = Bun.spawn(['gifsicle', '-O3', '--lossy=30', gif, '-o', `${gif}.opt`], { stdout: 'pipe', stderr: 'pipe' });
    if ((await g.exited) === 0) await rename(`${gif}.opt`, gif);
  }
}

/**
 * Write the short archive sessions into the demo profile as HISTORY, spread over recent days.
 *
 * Spread, not stamped at once: Home buckets by time, and four sessions landing in the same second
 * produce one bar and a "7 days" window that says nothing. Each bundle keeps its own internal
 * spacing and is rebased onto a different day.
 */
async function seedExtras(cfg: string): Promise<number> {
  const root = join(OUT, 'extras');
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return 0;
  }
  let seeded = 0;
  for (const [i, name] of names.entries()) {
    const dir = join(root, name);
    let slugs: string[];
    try {
      slugs = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      continue;
    }
    for (const slug of slugs) {
      const lines = await timeline(join(dir, slug));
      if (lines.length === 0) continue;
      // The same hard stop the main replay gets: scrubbing is applied at parse, and this proves it.
      const bad = lines.map((l) => leakIn(JSON.stringify(l.obj))).find(Boolean);
      if (bad) throw new Error(`archive session ${name} still carries ${bad} after scrubbing`);
      const base = lines[0]!.at;
      // 1, 2, 3 … days back, plus a couple of hours so they do not all sit at the same clock time.
      const anchor = Date.now() - (i + 1) * 24 * 3_600_000 - (i + 1) * 5 * 60_000;
      for (const l of lines) {
        const at = new Date(anchor + (l.at - base)).toISOString();
        const dest = join(cfg, 'projects', slug, l.rel);
        await mkdir(join(dest, '..'), { recursive: true });
        await appendFile(dest, `${JSON.stringify({ ...l.obj, timestamp: at })}\n`);
      }
      seeded++;
    }
  }
  return seeded;
}

/**
 * Write an open-session record for the replayed session, so it reads as WORKING and not merely
 * recent.
 *
 * seedeep takes liveness from the process (`isOpen ?? isActive`) and the busy state only from this
 * file. Without it the replay is "active by mtime": the header says LIVE but the tab's dot never
 * goes green, because nothing claims the session is doing anything. The record reconstructs what
 * WAS true while the transcript was being written — it does not invent a state the session never
 * had — and it names this process's own pid, because seedeep checks the pid is alive.
 */
async function writeOpenRecord(
  cfg: string,
  sessionId: string,
  cwd: string,
  status: string,
  waitingFor?: string,
): Promise<void> {
  const dir = join(cfg, 'sessions');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId, cwd, status, waitingFor, statusUpdatedAt: Date.now() }),
  );
}

async function shoot(): Promise<void> {
  const bundle = join(OUT, 'session');
  const meta = JSON.parse(await readFile(join(bundle, 'meta.json'), 'utf8')) as { slug: string; cwd: string };
  const slugDir = join(bundle, meta.slug);
  const stream = await timeline(slugDir);
  if (stream.length === 0) throw new Error(`no transcript lines in ${slugDir} — run \`record\` first`);
  // BEFORE the browser opens, not after: a leak found once frames exist is a leak that was drawn.
  const leaks = stream.map((l) => leakIn(JSON.stringify(l.obj))).filter(Boolean);
  if (leaks.length > 0)
    throw new Error(`${leaks.length} lines still carry ${leaks[0]} after scrubbing — refusing to capture`);
  const spanS = (stream[stream.length - 1]!.at - stream[0]!.at) / 1000;
  console.log(`[shoot] ${stream.length} lines over ${spanS.toFixed(0)}s real → ${(spanS / SPEED).toFixed(0)}s replay`);

  const cfg = join(OUT, 'cfg');
  await mkdir(join(OUT, 'assets'), { recursive: true });
  await rm(cfg, { recursive: true, force: true });
  await mkdir(join(cfg, 'projects', meta.slug), { recursive: true });

  const sessionId = sessionIdOf(stream);
  if (!sessionId) throw new Error('no sessionId in the bundle — cannot open the session view');

  // Seed up to the first turn boundary so the page has a session to show, and ONLY that session:
  // the archive sessions are seeded later, after the hero is in the can. Seeding them first opened
  // four tabs, and a hero frame with four tabs is a screenshot of somebody else's workspace.
  // Enough for the session to EXIST and be openable by id, and not one line more.
  //
  // This used to seed everything up to the first `turn_duration`, which was fine while the
  // recording had six turns and fatal the moment it had one: in a single-turn session that
  // boundary is the LAST line, so the whole thing was seeded, the replay had nothing left to play,
  // and the hero came out a still image of the finished state.
  const firstBoundary = stream.findIndex((l) => {
    const o = l.obj as { type?: string; subtype?: string };
    return o.type === 'system' && o.subtype === 'turn_duration';
  });
  const SEED_MAX = 6;
  const seed = stream.slice(0, Math.min(firstBoundary > 0 ? firstBoundary + 1 : SEED_MAX, SEED_MAX));
  for (const l of seed) await writeLine(cfg, meta.slug, l, slugDir);
  await writeOpenRecord(cfg, sessionId, meta.cwd, 'busy');
  await new Promise((r) => setTimeout(r, 4_000));

  // The COMPILED binary, not `bun run main.ts`. `FROM_SOURCE` is `Bun.embeddedFiles.length === 0`,
  // so a server started from the checkout brands the portal "seedeep DEV" — a badge that says
  // "this is somebody's working copy" in the middle of the product's own screenshot. Built by
  // `bun run build:server`, which also embeds the freshly built client bundle.
  const bin = join(process.cwd(), 'dist', `seedeep-server_${VERSION}_macos-arm64`);
  const useBin = await Bun.file(bin).exists();
  if (!useBin) console.log('[shoot] no compiled binary — falling back to source, the portal will show DEV');
  const server = Bun.spawn(
    useBin
      ? [bin, 'serve', '--no-open', '--port', String(PORT)]
      : ['bun', 'run', 'apps/server/src/server/main.ts', '--port', String(PORT)],
    {
      env: { ...process.env, CLAUDE_CONFIG_DIR: cfg },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  try {
    const url = await serverUrl(server as { stdout: ReadableStream<Uint8Array> }, PORT);
    console.log(`[shoot] server up on ${PORT} against ${cfg}`);

    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({ channel: 'chrome' });
    const videoDir = join(OUT, 'video');
    await rm(videoDir, { recursive: true, force: true });
    const ctx = await browser.newContext({
      // The certificate is self-signed by design — this is a local server, not a public host.
      ignoreHTTPSErrors: true,
      viewport: { width: 1440, height: 900 },
      recordVideo: { dir: videoDir, size: { width: 1440, height: 900 } },
      colorScheme: 'dark',
    });
    const page = await ctx.newPage();
    // The video's OWN zero. Recording starts when the page is created, several seconds before the
    // replay's `t0` (page load, then the settle waits), so marks measured from `t0` cut the video
    // that much too EARLY — which is why home.gif and trace.gif opened on the previous screen for
    // a beat before the view they exist to show.
    const vt0 = Date.now();
    const mark = () => (Date.now() - vt0) / 1000;
    // NOT `networkidle`: the GUI holds an SSE stream open for as long as it is watching, so the
    // network is never idle and goto times out after 30s on a page that had already rendered.
    await page.goto(withSession(url, sessionId), { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4_000);

    // The replay runs as its own task so the UI can be driven WHILE lines keep landing. Opening the
    // Trace inside the write loop would stall the replay for the whole dwell and then burst every
    // held line at once — which is exactly what made the first Trace clip a still image.
    const t0 = Date.now();
    // Where the hero begins. Everything before this is page load and settle waits, during which the
    // session reads 0 / 0% / "no activity yet" — five seconds of an empty product at the top of the
    // README. Trimming it afterwards is not equivalent: GIF frames are deltas, so cutting into the
    // middle needs an unoptimise/re-optimise round that ends up LARGER (1.7 → 2.0 MB) than encoding
    // the right range once.
    const replayAt = mark();
    let agentAt: number | null = null;
    let written = 0;
    const turnEnds: number[] = [];
    const base = stream[seed.length]?.at ?? stream[0]!.at;
    const replayTask = (async () => {
      for (const l of stream.slice(seed.length)) {
        const due = t0 + (l.at - base) / SPEED;
        const wait = due - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        await writeLine(cfg, meta.slug, l, slugDir);
        written++;
        const o = l.obj as { type?: string; subtype?: string };
        if (o.type === 'system' && o.subtype === 'turn_duration') turnEnds.push((Date.now() - t0) / 1000);
        if (agentAt === null && isAgentSpawn(l.obj)) {
          agentAt = mark();
          console.log(`[shoot] first subagent spawn at ${agentAt.toFixed(1)}s`);
        }
      }
    })();

    // Wait for the fan-out to be on screen, then let it breathe: the hero ends here, so it carries
    // the context filling AND the subagents running — one clip, not two.
    // Hold until the fan-out is on screen AND the replay is nearly over. The hero ends where the
    // Trace opens, so opening it nine seconds after the spawn cut the hero at 15s of a 29s replay —
    // the window was still filling when the clip stopped. Waiting for `spanS/SPEED - 8` instead
    // gives the hero the whole fill plus the subagents, and still leaves lines landing behind the
    // Trace so it is seen changing rather than posed.
    // Keyed on the replay's own PROGRESS, not on a duration computed from the timestamps: the
    // writes do not keep to that schedule, so a session whose lines span 154 seconds replayed in 28
    // rather than 8 and every deadline derived from the span fired far too early.
    while (agentAt === null && (Date.now() - t0) / 1000 < 300) await new Promise((r) => setTimeout(r, 250));
    // AND twelve seconds past the fan-out. The line count alone opened the Trace 4s after the
    // spawn, so the hero ended while three subagents had only just appeared — their cards had not
    // had time to run, finish, or move a single context bar, which is the half of the story the
    // fan-out exists to start.
    const settleUntil = (agentAt ?? 0) + 12;
    while ((written < stream.length * 0.95 || (Date.now() - t0) / 1000 < settleUntil) && (Date.now() - t0) / 1000 < 300)
      await new Promise((r) => setTimeout(r, 250));

    const trace = page.getByRole('button', { name: 'Trace', exact: true }).first();
    let traceOpened = false;
    let traceAt = 0;
    if (await trace.isVisible().catch(() => false)) {
      await trace.click();
      // Marked AFTER the click and after the overlay has painted, never before it with a guessed
      // margin: the clip has to open ON the Trace, not on the frame it replaced.
      await page.waitForTimeout(900);
      traceAt = mark();
      traceOpened = true;
      // Held open WHILE the replay keeps writing, which is the only way the Trace is seen changing
      // rather than posed. A Trace opened after the last line is a static list.
      await page.waitForTimeout(14_000);
      console.log(`[shoot] trace held open from ${traceAt.toFixed(1)}s`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(1_200);
    } else {
      console.log('[shoot] NO Trace button found');
    }

    await replayTask;
    const replayS = (Date.now() - t0) / 1000;
    console.log(`[shoot] replay done in ${replayS.toFixed(1)}s`);
    await writeOpenRecord(cfg, sessionId, meta.cwd, 'idle');
    await page.waitForTimeout(2_000);
    await page.screenshot({ path: join(OUT, 'assets', 'frame-session.png') });

    // Only now the archive lands, so Home and Search have something to be about while the hero
    // above was shot on a single tab.
    const extras = await seedExtras(cfg);
    console.log(`[shoot] seeded ${extras} archive sessions`);
    await page.waitForTimeout(3_000);

    await openNamed(page, 'Home');
    // Marked AFTER the view has settled, so the cut opens on Home instead of on the two seconds of
    // menu and previous screen that preceded it.
    await page.waitForTimeout(3_500);
    const homeAt = mark();
    await page.waitForTimeout(8_000);
    await page.screenshot({ path: join(OUT, 'assets', 'frame-home.png') });

    let searchAt = 0;
    if (await openNamed(page, 'Search')) {
      await page.waitForTimeout(1_500);
      searchAt = mark();
      // By PLACEHOLDER, not by `input[type=text]`: that selector needs the attribute to be literally
      // present, and this input has none — so the locator matched nothing and the query was never
      // typed, leaving a clip of an empty state that looked like a broken feature.
      const box = page.getByPlaceholder('words you remember', { exact: false }).first();
      if (await box.isVisible().catch(() => false)) {
        await box.click();
        await box.type('rate limit', { delay: 120 });
        await page.waitForTimeout(4_000);
      }
      await page.screenshot({ path: join(OUT, 'assets', 'frame-search.png') });
    }
    await page.waitForTimeout(1_500);

    // The video is only flushed to disk when the context closes, so nothing may be captured after.
    await ctx.close();
    await browser.close();

    const webm = join(videoDir, (await readdir(videoDir)).find((f) => f.endsWith('.webm'))!);
    const assets = join(OUT, 'assets');
    // +0.9s on the replay's start: the watcher and the SSE stream take about that long to put the
    // first lines on screen, and cutting at `replayAt` opened on "0 / 200.0k · no activity yet".
    // Not more, either — at +1.6 the window was already at 11%, so the climb from nothing, which is
    // the thing being demonstrated, had happened off-camera.
    const heroStart = replayAt + 0.9;
    const heroRaw = Math.min(30, (traceOpened ? traceAt - 2.5 : mark()) - heroStart);
    const heroDur = heroRaw - (await staticTail(webm, heroStart, heroRaw));

    const cuts: Array<[string, number, number]> = [
      // Ends BEFORE the Trace click, not 0.5s before the mark: `traceAt` is taken after the click
      // AND after the overlay has painted, so half a second of margin still let four frames of the
      // Trace into the hero's tail. Capped at 30s as well — the story (window filling, then the
      // fan-out) is complete by then, and the last 9 seconds cost a third of the file for a
      // subagent list that has stopped changing.
      // +1.6s on the replay's start, not the start itself: the watcher polls and the page renders
      // through an SSE stream, so the first written lines are not on screen for well over a second.
      // Measured — a hero cut at `replayAt` still opened on "0 / 200.0k · no activity yet".
      ['hero.gif', heroStart, heroDur],
      ...(traceOpened ? ([['trace.gif', traceAt, 13]] as Array<[string, number, number]>) : []),
      ['home.gif', homeAt, 8],
      ...(searchAt ? ([['search.gif', searchAt, 12]] as Array<[string, number, number]>) : []),
    ];
    for (const [name, start, dur] of cuts) {
      await toGif(webm, join(assets, name), start, dur);
      const kb = Math.round(Bun.file(join(assets, name)).size / 1024);
      console.log(`[shoot] wrote ${name} (${start.toFixed(1)}s +${dur.toFixed(1)}s, ${kb} KB)`);
    }
  } finally {
    server.kill();
    await server.exited;
  }
}

/**
 * The tray the notification figure photographs: the INSTALLED app, never a dev build.
 *
 * A banner is drawn by macOS from the bundle that sent it, so what the figure shows is the shipped
 * client or it is nothing. It also has to be the installed one for a duller reason: notification
 * permission is granted per bundle, seedeep ships unsigned, and macOS re-asks on every build — a
 * freshly compiled tray is a tray whose banners silently go nowhere.
 */
const TRAY_APP = process.env['SEEDEEP_TRAY_APP'] ?? '/Applications/seedeep-tray.app';

/** The notification capture's own port, so it can run beside a `shoot` and beside a real seedeep. */
const NOTIF_PORT = Number(process.env['SEEDEEP_NOTIF_PORT'] ?? 45998);

/** Pixels between two banners in the montage, matching the figure this replaces. */
const BANNER_GAP = 18;

/**
 * A frame as 8-bit luminance, for comparing two of them without decoding a PNG.
 *
 * Raw gray rather than an image format on purpose: the only questions asked of these frames are
 * "which pixels changed" and "how much", and both are one subtraction over a byte array. Pulling in
 * a PNG decoder to answer them would be the dependency this whole script does without.
 */
async function grayFrame(mp4: string, atS: number): Promise<Uint8Array> {
  const p = Bun.spawn(
    [
      'ffmpeg',
      '-v',
      'error',
      '-ss',
      atS.toFixed(3),
      '-i',
      mp4,
      '-vframes',
      '1',
      '-pix_fmt',
      'gray',
      '-f',
      'rawvideo',
      '-',
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const buf = new Uint8Array(await new Response(p.stdout).arrayBuffer());
  await p.exited;
  if (buf.length === 0) throw new Error(`no frame at ${atS.toFixed(1)}s in ${mp4}`);
  return buf;
}

/** A recording's frame size, which every crop below is expressed in. */
async function videoSize(mp4: string): Promise<{ w: number; h: number }> {
  const p = Bun.spawn(
    ['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', mp4],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const [w, h] = (await new Response(p.stdout).text()).trim().split(',').map(Number);
  await p.exited;
  if (!w || !h) throw new Error(`could not read the frame size of ${mp4}`);
  return { w, h };
}

/** Where a banner is drawn, and how much of it there is: the top-right quadrant, below the menu bar. */
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The corner of the screen a banner is looked for in: below the menu bar, right of the middle. */
interface Region {
  x0: number;
  y0: number;
  y1: number;
}

/** A luminance delta that counts as "something is here that was not": presence, and movement. */
const CHANGED = 16;

/**
 * The delta the banner's EDGES are read at, which is much smaller than the one its text is read at.
 *
 * Measured on a take: over a flat backdrop the banner's text runs to 219 while its body sits around
 * 37 against a backdrop of 51 — a step of 14, where the lettering is a step of 180. At 16 the box
 * collapsed onto the text and cut three figures with their second line sliced in half.
 *
 * The value is the one every backdrop agrees on. Over the flat desktop, thresholds 3 to 12 returned
 * the same rectangle to the pixel; over the black window, whose title bar sits under the top of the
 * banner at a step of only 3, thresholds 2 to 6 returned that same rectangle again. 4 is inside
 * both, and the row and column minimums below are what keep a threshold this low from being moved
 * by compression noise.
 */
const EDGE = 4;

/**
 * Where the black backdrop starts, which is where the search for a banner starts.
 *
 * The menu bar is the one strip the backdrop window cannot cover, and it sits in the very corner the
 * banner is drawn in. Two takes measured the banner as `500x72 at 1404,14` and cut three figures
 * with a slice of menu bar across the top of each.
 *
 * It is found by BRIGHTNESS, in a frame with no banner on it: the menu bar carries a clock and a row
 * of icons, and below it there is nothing but the backdrop until a banner lands. Neither of the two
 * things tried first survives contact — darkness cannot find it, because a dark-mode menu bar over a
 * black window is black too, and movement cannot either, because a menu bar whose icons happen to
 * hold still for the two frames compared reads as backdrop and lets 1806 lit pixels into the region.
 * A constant is worse than both: a menu bar's height is a function of the display.
 */
function backdropTop(ref: Uint8Array, w: number, h: number): number {
  const x0 = Math.floor(w / 2);
  // The top fifth: enough to hold any menu bar, and it stops short of the rest of the screen, where
  // something bright would mean the backdrop is not covering and is the next check's business.
  const scan = Math.floor(h / 5);
  let last = -1;
  for (let y = 0; y < scan; y++) for (let x = x0; x < w; x++) if ((ref[y * w + x] ?? 0) > 100) last = y;
  return last + 1;
}

/**
 * The rectangle a banner occupies, found by subtracting a frame that has none.
 *
 * Located rather than hardcoded because a rectangle in screen coordinates is a claim about the
 * machine that took the picture — screen size, scale factor, menu-bar height, the OS's own banner
 * geometry — and every one of those is a way for a later run to cut a figure of the wrong thing
 * while reporting success.
 *
 * A row or column counts only when many of its pixels changed, so that the odd stray pixel cannot
 * stretch the box; over a black backdrop the banner's own background is the step that defines its
 * edges, and there is nothing else in the region to find.
 */
function bannerRect(ref: Uint8Array, shot: Uint8Array, w: number, r: Region): Rect | null {
  const ROW_MIN = 60; // a banner is ~350px wide, so a row of one is nowhere near this thin
  const COL_MIN = 12;
  const rows = new Int32Array(r.y1);
  const cols = new Int32Array(w);
  for (let y = r.y0; y < r.y1; y++) {
    for (let x = r.x0; x < w; x++) {
      const i = y * w + x;
      if (Math.abs((ref[i] ?? 0) - (shot[i] ?? 0)) < EDGE) continue;
      rows[y]!++;
      cols[x]!++;
    }
  }
  let top = -1;
  let bottom = -1;
  for (let y = r.y0; y < r.y1; y++) {
    if (rows[y]! < ROW_MIN) continue;
    if (top === -1) top = y;
    bottom = y;
  }
  if (top === -1) return null;
  let left = -1;
  let right = -1;
  for (let x = r.x0; x < w; x++) {
    if (cols[x]! < COL_MIN) continue;
    if (left === -1) left = x;
    right = x;
  }
  if (left === -1) return null;
  // Even width and height: a crop with an odd dimension is rejected by some encoders, and there is
  // no reason for the figure to be the one that finds out.
  const rect = { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
  rect.w -= rect.w % 2;
  rect.h -= rect.h % 2;
  return rect;
}

/** How many pixels differ between two frames, over the corner a banner appears in. */
function changeScore(a: Uint8Array, b: Uint8Array, w: number, r: Region): number {
  let n = 0;
  for (let y = r.y0; y < r.y1; y++)
    for (let x = r.x0; x < w; x++) {
      const i = y * w + x;
      if (Math.abs((a[i] ?? 0) - (b[i] ?? 0)) >= CHANGED) n++;
    }
  return n;
}

/**
 * The instant a banner is SETTLED on screen, within a window after the event that raised it.
 *
 * The exact moment cannot be computed: between writing a transcript line and a banner finishing its
 * slide-in sit the server's one-second sweep, its coalescing timer, an SSE hop and macOS's own
 * animation. So the window is sampled.
 *
 * The BUSIEST frame is the wrong one to take, and that is what this measures its way around: a
 * half-slid banner is drawn offset and translucent and covers MORE changed pixels than the settled
 * one (6706 against 5023 on one take), so "most different from the empty screen" picks the frame
 * mid-flight — twice, in two takes, one figure each time. What identifies the settled banner is
 * that it is not moving: among the frames where something is clearly on screen, the one that
 * differs least from the frame before it. A banner that never arrived is quiet too, so the caller
 * still checks the score.
 */
async function peakFrame(
  mp4: string,
  ref: Uint8Array,
  fromS: number,
  toS: number,
  w: number,
  r: Region,
): Promise<{ at: number; score: number }> {
  const samples: Array<{ at: number; score: number; motion: number }> = [];
  let prev: Uint8Array | null = null;
  for (let t = fromS; t <= toS; t += 0.25) {
    const g = await grayFrame(mp4, t);
    samples.push({
      at: t,
      score: changeScore(ref, g, w, r),
      motion: prev === null ? Number.POSITIVE_INFINITY : changeScore(prev, g, w, r),
    });
    prev = g;
  }
  const top = Math.max(...samples.map((s) => s.score));
  const shown = samples.filter((s) => s.score >= top * 0.6);
  const still = shown.reduce((a, b) => (b.motion < a.motion ? b : a), shown[0]!);
  return { at: still.at, score: top };
}

/** One banner, cut from the recording at `atS` and saved. */
async function cropBanner(mp4: string, atS: number, rect: Rect, out: string): Promise<void> {
  const p = Bun.spawn(
    [
      'ffmpeg',
      '-v',
      'error',
      '-y',
      '-ss',
      atS.toFixed(3),
      '-i',
      mp4,
      '-vframes',
      '1',
      '-vf',
      `crop=${rect.w}:${rect.h}:${rect.x}:${rect.y}`,
      out,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  await p.exited;
  if (p.exitCode !== 0) throw new Error(`could not cut a banner at ${atS.toFixed(1)}s`);
}

/** The three banners stacked into the one figure the README shows, gaps between them. */
async function stackBanners(shots: string[], out: string): Promise<void> {
  const pad = shots.map((_, i) =>
    i === shots.length - 1 ? `[${i}]null[s${i}]` : `[${i}]pad=iw:ih+${BANNER_GAP}:0:0:black[s${i}]`,
  );
  const chain = `${pad.join(';')};${shots.map((_, i) => `[s${i}]`).join('')}vstack=inputs=${shots.length}`;
  const p = Bun.spawn(
    ['ffmpeg', '-v', 'error', '-y', ...shots.flatMap((s) => ['-i', s]), '-filter_complex', chain, out],
    {
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  await p.exited;
  if (p.exitCode !== 0) throw new Error(`could not stack the banners into ${out}`);
}

/**
 * Cuts `docs/assets/notifications.png` — the one figure that is not a build output of the browser.
 *
 * Three REAL macOS banners, raised by the installed tray against a synthetic session, filmed off the
 * screen. Nothing here can be replayed into a headless browser: what the figure documents IS the
 * platform's own rendering, and a mock-up of it would be a drawing of a banner rather than a banner.
 *
 * Everything else about it is the same contract as the other figures. The session is synthetic
 * (`orbit`, under a tmp path) and leak-checked before a single frame is filmed. The server and the
 * tray share one throwaway `SEEDEEP_HOME`, so the tray adopts THIS server by discovery and the
 * developer's own tray, its connection and its token are never touched — the two files that matter
 * live under `<home>/tray`, and a run leaves the installed app's copies alone.
 *
 * The three states are driven, not waited for: `~/.claude/sessions/` decides `needsYou` and
 * `finishes` (the transcript says nothing while a session sits on an approval), so the open record
 * is rewritten at each step and the transcript is appended to underneath it.
 *
 * It takes over the screen for about a minute, and the screen has to be still: the banner is located
 * by subtracting a frame of the desktop from a frame with a banner on it.
 */
async function notif(): Promise<void> {
  const bundle = join(OUT, 'notif-session');
  const meta = JSON.parse(await readFile(join(bundle, 'meta.json'), 'utf8')) as { slug: string; cwd: string };
  const stream = await timeline(join(bundle, meta.slug));
  if (stream.length === 0) throw new Error(`no transcript lines in ${join(bundle, meta.slug)}`);
  const leak = stream.map((l) => leakIn(JSON.stringify(l.obj))).filter(Boolean)[0];
  if (leak) throw new Error(`the notification bundle still carries ${leak} — refusing to film it`);

  const trayBin = join(TRAY_APP, 'Contents', 'MacOS', 'seedeep-tray');
  if (!(await Bun.file(trayBin).exists()))
    throw new Error(
      `no tray at ${TRAY_APP} — install the release build first; a figure of a dev tray is a figure of nothing`,
    );
  const plist = Bun.spawn(
    ['/usr/libexec/PlistBuddy', '-c', 'Print :CFBundleShortVersionString', join(TRAY_APP, 'Contents', 'Info.plist')],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const trayVersion = (await new Response(plist.stdout).text()).trim();
  await plist.exited;
  if (trayVersion !== VERSION)
    throw new Error(
      `the installed tray is ${trayVersion} and this checkout is ${VERSION} — install the matching build`,
    );

  // The pending tool is the last `tool_use` the session wrote: its result is what the user is being
  // asked to approve. Found rather than indexed, so re-recording the bundle does not silently move
  // the capture to a different line.
  const askAt = stream.reduce((found, l, i) => {
    const c = (l.obj as { message?: { content?: Array<{ type?: string }> } }).message?.content;
    return Array.isArray(c) && c.some((b) => b.type === 'tool_use') ? i : found;
  }, -1);
  if (askAt === -1) throw new Error('no tool_use in the notification bundle — nothing to wait for approval on');
  const askTool = ((
    stream[askAt]!.obj as { message: { content: Array<{ type?: string; name?: string }> } }
  ).message.content.find((b) => b.type === 'tool_use')?.name ?? '') as string;
  const endAt = stream.findIndex((l) => {
    const o = l.obj as { type?: string; subtype?: string };
    return o.type === 'system' && o.subtype === 'turn_duration';
  });
  if (endAt === -1) throw new Error('no turn_duration in the notification bundle — the turn never finishes');
  // The API failure is CLONED from the session's own last assistant line, so every field around it
  // (cwd, version, model, the usage block) is the shape Claude Code really writes. Only the two
  // markers the parser keys on are added — inventing the whole line is how a fixture ends up
  // testing a belief instead of the format.
  const template = stream[endAt - 1]!;
  const failure = {
    ...template,
    obj: {
      ...(template.obj as Record<string, unknown>),
      uuid: crypto.randomUUID(),
      isApiErrorMessage: true,
      apiErrorStatus: 529,
      message: {
        ...((template.obj as { message: Record<string, unknown> }).message ?? {}),
        content: [
          {
            type: 'text',
            text: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
          },
        ],
      },
    },
  };

  const cfg = join(OUT, 'cfg-notif');
  const home = join(OUT, 'seedeep-home-notif');
  for (const d of [cfg, home]) await rm(d, { recursive: true, force: true });
  await mkdir(join(cfg, 'projects', meta.slug), { recursive: true });
  await mkdir(join(home, 'tray'), { recursive: true });
  // `Turn finished` ships OFF, so the figure that shows all three has to turn it on. The update
  // check is turned off for the opposite reason: a "seedeep 0.x is out" banner landing mid-take is
  // a banner about the tool rather than about a session.
  //
  // In the SERVER's config, which is the switch that decides — the first take turned it on in the
  // tray's own `settings.json` and filmed two banners out of three, because the tray's file is the
  // panel's mirror of a setting the server holds (`notify-engine` reads `currentConfig`). Both are
  // written, and they agree.
  await writeFile(
    join(home, 'config.json'),
    JSON.stringify({
      notifications: { tray: { needsYou: true, fails: true, finishes: true, updates: false } },
    }),
  );
  await writeFile(
    join(home, 'tray', 'settings.json'),
    JSON.stringify({ notify: true, notifyFinished: true, notifyFailed: true, notifyUpdate: false }),
  );

  const sessionId = sessionIdOf(stream);
  if (!sessionId) throw new Error('no sessionId in the notification bundle');
  for (const l of stream.slice(0, askAt)) await writeLine(cfg, meta.slug, l);
  await writeOpenRecord(cfg, sessionId, meta.cwd, 'busy');

  const bin = join(process.cwd(), 'dist', `seedeep-server_${VERSION}_macos-arm64`);
  if (!(await Bun.file(bin).exists())) throw new Error(`missing ${bin} — run \`bun run build:server\` first`);
  const server = Bun.spawn([bin, 'serve', '--no-open', '--port', String(NOTIF_PORT)], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: cfg, SEEDEEP_HOME: home },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let tray: ReturnType<typeof Bun.spawn> | null = null;
  let rec: ReturnType<typeof Bun.spawn> | null = null;
  let backdrop: ReturnType<typeof Bun.spawn> | null = null;
  const mp4 = join(OUT, 'notif-screen.mp4');
  try {
    await serverUrl(server as { stdout: ReadableStream<Uint8Array> }, NOTIF_PORT);
    console.log(`[notif] server up on ${NOTIF_PORT} against ${cfg}`);

    // Its own SEEDEEP_HOME is the whole isolation: the tray keeps `connection.json` under
    // `<home>/tray`, and the server announced itself under `<home>/servers`, so this one adopts
    // this one and the installed tray's pairing is not read, rewritten or disturbed.
    tray = Bun.spawn([trayBin], { env: { ...process.env, SEEDEEP_HOME: home }, stdout: 'pipe', stderr: 'pipe' });
    for (let i = 0; i < 40 && !(await Bun.file(join(home, 'tray', 'connection.json')).exists()); i++)
      await new Promise((r) => setTimeout(r, 500));
    console.log('[notif] tray up — the banners are about to take over the screen');

    // A black screen behind the banners, and it is not cosmetic — it is what makes the figure both
    // cuttable and publishable.
    //
    // CUTTABLE: the banner is located by subtracting a frame of the screen from a frame with a
    // banner on it, and macOS draws its banner from a translucent material. Over a busy desktop the
    // subtraction finds the TEXT and not the banner — the first take cut a 432x40 strip through the
    // middle of it. Over one flat colour, the banner's own body is a clean step all the way to its
    // rounded corners.
    //
    // PUBLISHABLE: a crop is a rectangle and a banner has rounded corners, so whatever is on the
    // desktop shows through at all four of them. On a real machine that is a sliver of somebody's
    // window in a public figure. Black corners are also what the montage's gaps are, so the stack
    // has no seams.
    //
    // An ordinary window, and NEVER a fullscreen one. Measured 2026-08-12, twice: with a fullscreen
    // app frontmost, macOS delivers the notification — the tray's own probe returns `Ok(())` — and
    // draws NO banner. A whole take came back with not one pixel changed in fifty seconds. That is
    // also a fact about the product: a user working fullscreen sees none of these.
    //
    // Chrome is launched DIRECTLY rather than through playwright, because `--app` and
    // `--window-size` are what make this work and playwright manages the window itself: under it the
    // flags were dropped and the take filmed a titled window with an infobar, sitting nowhere near
    // the corner the banners are drawn in.
    //
    // What it cannot cover is the ~30px of its own title bar, which lands under the top of the
    // banner. That costs nothing: the strip is a flat 27 against the content's 0, both static, and
    // {@link EDGE} reads the banner's edges off either.
    const black = join(OUT, 'black.html');
    await writeFile(black, '<body style="margin:0;background:#000">');
    backdrop = Bun.spawn(
      [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        `--user-data-dir=${join(OUT, 'black-profile')}`,
        `--app=file://${black}`,
        '--window-position=0,0',
        '--window-size=4000,3000',
        '--no-first-run',
        '--no-default-browser-check',
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    // Long enough for the window to be up and still: a reference frame of a screen that is still
    // moving is a reference frame that subtracts to noise.
    await new Promise((r) => setTimeout(r, 5_000));

    rec = Bun.spawn(
      [
        'ffmpeg',
        '-v',
        'error',
        '-y',
        '-f',
        'avfoundation',
        '-capture_cursor',
        '0',
        '-framerate',
        '4',
        '-i',
        '0:none',
        '-t',
        '150',
        mp4,
      ],
      { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    );
    const filmedAt = Date.now();
    const at = () => (Date.now() - filmedAt) / 1000;
    // A stretch of untouched desktop first: it is what every banner is subtracted from.
    await new Promise((r) => setTimeout(r, 5_000));

    const marks: Array<{ id: string; at: number }> = [];
    const provoke = async (id: string, body: () => Promise<void>) => {
      await body();
      marks.push({ id, at: at() });
      // Long enough for the sweep to see it, macOS to draw it, and the banner to be gone again
      // before the next one is provoked — two banners on screen at once stack, and a stack is not
      // what any of the three figures is of.
      await new Promise((r) => setTimeout(r, 14_000));
    };

    await provoke('waiting', async () => {
      await writeLine(cfg, meta.slug, stream[askAt]!);
      // The call has to be ON THE TREE before the session says it is waiting, or the banner names
      // no tool. `pendingTool` is the JOIN of the roster's `waitingFor` with the open call, and
      // writing both in the same breath let the digest be built from a record that had already
      // flipped and a transcript that had not been read yet — the first take said "Waiting for your
      // approval in the terminal", which is the fallback for a wait whose tool is unknown. It is
      // also the real order: Claude Code writes the `tool_use`, and the prompt comes after it.
      await new Promise((r) => setTimeout(r, 2_500));
      await writeOpenRecord(cfg, sessionId, meta.cwd, 'waiting', 'permission prompt');
    });
    await provoke('failed', async () => {
      // Approved, running again — and then the call fails. Back to busy first, because a session
      // that goes straight from waiting to broken never shows the state the second banner is about.
      for (const l of stream.slice(askAt + 1, endAt - 1)) await writeLine(cfg, meta.slug, l);
      await writeOpenRecord(cfg, sessionId, meta.cwd, 'busy');
      await new Promise((r) => setTimeout(r, 2_500));
      await writeLine(cfg, meta.slug, failure);
    });
    await provoke('finished', async () => {
      for (const l of stream.slice(endAt - 1)) await writeLine(cfg, meta.slug, l);
      await writeOpenRecord(cfg, sessionId, meta.cwd, 'idle');
    });

    rec.kill('SIGINT');
    await rec.exited;
    rec = null;
    console.log(`[notif] filmed ${at().toFixed(0)}s → ${mp4}`);

    const { w, h } = await videoSize(mp4);
    const ref = await grayFrame(mp4, 2.5);
    const region: Region = {
      x0: Math.floor(w / 2),
      y0: backdropTop(ref, w, h),
      y1: Math.floor(h / 2),
    };
    // The backdrop is BEHIND the banners or the figure is of something else. A window that opened
    // where the banners are not is the failure this catches: one take was cut against the grey of a
    // Chrome toolbar and looked plausible, and nothing but a check on the pixels can tell the two
    // apart. Flat and dark, both — a bright backdrop would put a white halo in every rounded corner.
    // Lit pixels with lit neighbours, and a share of the corner rather than its brightest pixel.
    // Both relaxations are things the backdrop itself put there: a 6x6 recording indicator that macOS
    // keeps in the menu bar failed a test on the peak, and the window's own one-pixel border — its
    // top edge and its right edge — failed a test on the count, at 1461 pixels of nothing. Neither is
    // content. What the check is for is a strip of toolbar or a desktop icon across the corner, and
    // those are thousands of pixels thick in both directions.
    let lit = 0;
    for (let y = region.y0 + 1; y < region.y1 - 1; y++)
      for (let x = region.x0 + 1; x < w - 1; x++) {
        const on = (i: number) => (ref[i] ?? 0) > 40;
        const i = y * w + x;
        if (on(i) && on(i - 1) && on(i + 1) && on(i - w) && on(i + w)) lit++;
      }
    const area = (region.y1 - region.y0) * (w - region.x0);
    if (lit > area * 0.002)
      throw new Error(
        `the corner where banners are drawn is not black (${lit} lit pixels of ${area}) — ` +
          'the backdrop window did not cover it, so the crop would carry whatever is on the desktop',
      );
    const peaks: Array<{ id: string; at: number; score: number }> = [];
    for (const m of marks) {
      const p = await peakFrame(mp4, ref, m.at + 0.5, m.at + 6, w, region);
      if (p.score < 2_000)
        throw new Error(
          `no banner after the ${m.id} transition (${p.score} px changed at its busiest). ` +
            'Notifications are off for the tray, or the session did not reach that state.',
        );
      peaks.push({ id: m.id, ...p });
    }
    // ONE rectangle for all three: the banners are the same size and macOS draws them in the same
    // place, and three separately measured crops would differ by a pixel or two and read as a
    // wobbling stack.
    const rect = bannerRect(ref, await grayFrame(mp4, peaks[0]!.at), w, region);
    if (rect === null) throw new Error('a banner was on screen but its edges could not be found');
    console.log(`[notif] banner ${rect.w}x${rect.h} at ${rect.x},${rect.y} in a ${w}x${h} screen`);

    const cut: string[] = [];
    for (const [i, p] of peaks.entries()) {
      const out = join(OUT, `b${i + 1}.png`);
      await cropBanner(mp4, p.at, rect, out);
      console.log(`[notif] b${i + 1} — ${p.id} at ${p.at.toFixed(1)}s (${p.score} px)`);
      cut.push(out);
    }
    const figure = join(process.cwd(), 'docs', 'assets', 'notifications.png');
    await stackBanners(cut, figure);
    console.log(`[notif] wrote ${figure} — ${askTool} approval, failure, finish`);
  } finally {
    if (rec) {
      rec.kill('SIGINT');
      await rec.exited;
    }
    backdrop?.kill();
    tray?.kill();
    server.kill();
    await server.exited;
  }
}

/**
 * Cuts the cropped stills `docs/features.md` uses, from the same bundle `shoot` replays — so a
 * figure is a build output, not a screenshot somebody took. Free, like `shoot`: the transcript is
 * already on disk and nothing calls the model.
 *
 * Every shot is DECLARED in `apps/server/data/doc-shots.json`, which is also what
 * `doc-shots:check` reads to name the figures a code change has invalidated. Adding a figure to
 * the docs means adding it there, never dropping a PNG into `docs/assets/`.
 *
 * Cropped to the widget, and never the whole window: a 1440-wide frame makes the card being
 * explained a sixth of the picture, and the reader has to be told where to look. A selector that
 * stops matching FAILS the run, which is the point — a figure that can no longer be cut is a figure
 * that had stopped being true.
 */
/**
 * The compiled server, against one config dir. Never `bun run main.ts`: that brands the portal DEV.
 *
 * `SEEDEEP_HOME` points into the bundle, so the capture never reads or writes the real
 * `~/.seedeep/`: the port, the token and the certificate on screen are a throwaway set, which is
 * both what makes a settings figure publishable and what keeps a doc build off the developer's own
 * state.
 */
function spawnDocServer(cfg: string, posture?: DocShot['server']) {
  const bin = join(process.cwd(), 'dist', `seedeep-server_${VERSION}_macos-arm64`);
  // A posture gets its OWN home: the remote one writes a certificate and turns the token on, and
  // sharing that state with the loopback figures would change what they show.
  const home = join(OUT, posture ? `seedeep-home-${posture.commonName}` : 'seedeep-home');
  return Bun.spawn([bin, 'serve', '--no-open', '--port', String(PORT), ...(posture ? ['--host', posture.host] : [])], {
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: cfg,
      SEEDEEP_HOME: home,
      ...(posture ? { SEEDEEP_TLS_CN: posture.commonName } : {}),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

/** A page against a config dir, torn down with its server whatever happens. */
async function withDocPage(
  cfg: string,
  body: (page: import('playwright-core').Page, url: string) => Promise<void>,
  posture?: DocShot['server'],
): Promise<void> {
  const bin = join(process.cwd(), 'dist', `seedeep-server_${VERSION}_macos-arm64`);
  if (!(await Bun.file(bin).exists()))
    throw new Error(`missing ${bin} — run \`bun run build:server\` first, or the figures carry the DEV badge`);
  const server = spawnDocServer(cfg, posture);
  try {
    const url = await serverUrl(server as { stdout: ReadableStream<Uint8Array> }, PORT);
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({ channel: 'chrome' });
    // No video: a still needs no recording, and the webm is what makes `shoot` slow.
    const ctx = await browser.newContext({
      ignoreHTTPSErrors: true,
      // Taller than the app's own 900: a crop can only contain what the viewport rendered, and at
      // 900 the Verdict lens cut its most important row — the `crit` one — in half.
      viewport: { width: 1440, height: 1150 },
      colorScheme: 'dark',
      deviceScaleFactor: 2, // a figure is read at 100%, so the crop is cut at 2× and shown at half
    });
    const page = await ctx.newPage();
    await body(page, url);
    // BOUNDED, because both of these hung: the page holds an SSE stream open for as long as it is
    // watching, and a run that had already written every figure sat in teardown until it was killed
    // by hand. The shots are on disk by now — a slow goodbye must not be indistinguishable from a
    // crash.
    await bounded(ctx.close(), 10_000, 'context close');
    await bounded(browser.close(), 10_000, 'browser close');
  } finally {
    server.kill();
    await bounded(server.exited, 5_000, 'server exit');
    // Still up after the polite ask: the NEXT group spawns its own server on the same port, gets
    // nothing, and waits. The port is the shared resource here, so leaving one holder behind is
    // worse than an abrupt exit — nothing in this process has state to flush.
    if (server.exitCode === null) server.kill('SIGKILL');
  }
}

/**
 * Await a promise, but never forever: on timeout it says so and carries on. Only for TEARDOWN, where
 * the work is already done and the alternative is a run that looks hung.
 */
async function bounded<T>(p: Promise<T>, ms: number, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((r) => {
    timer = setTimeout(() => r('timeout'), ms);
  });
  const outcome = await Promise.race([p.then(() => 'done' as const).catch(() => 'failed' as const), timeout]);
  if (timer) clearTimeout(timer);
  if (outcome !== 'done') console.log(`[doc-shots] ${label}: ${outcome} after ${ms / 1000}s — continuing`);
}

/**
 * Take one declared shot: its clicks, its typing, then the crop into `<outDir>/<id>.png`.
 *
 * Every failure here is loud rather than skipped, with one exception: a control that is not on the
 * page at all (a widget behind a feature that this scene does not exercise).
 */
function makeTake(
  page: import('playwright-core').Page,
  outDir: string,
  cut: string[],
): (shot: DocShot) => Promise<void> {
  const takeOne = async (shot: DocShot): Promise<void> => {
    for (const step of shot.click ?? []) {
      const target = page.locator(step).filter({ visible: true }).first();
      if (!(await target.isVisible().catch(() => false))) {
        console.log(`[doc-shots] SKIP ${shot.id} — its control (${step}) is not on the page`);
        return;
      }
      await target.click();
      await page.waitForTimeout(1_200);
    }
    if (shot.type) {
      const box = page.locator(shot.type.selector).filter({ visible: true }).first();
      if (!(await box.isVisible().catch(() => false))) {
        console.log(`[doc-shots] SKIP ${shot.id} — nowhere to type (${shot.type.selector})`);
        return;
      }
      await box.click();
      await box.type(shot.type.text, { delay: 45 });
      await page.waitForTimeout(2_500);
    }
    if (shot.scrollTo) {
      const target = page.locator(shot.scrollTo).filter({ visible: true }).first();
      if (!(await target.isVisible().catch(() => false))) {
        console.log(`[doc-shots] SKIP ${shot.id} — nothing to scroll to (${shot.scrollTo})`);
        return;
      }
      await target.scrollIntoViewIfNeeded();
      await page.waitForTimeout(600);
    }
    if (shot.waitFor) {
      // LOUD when it never comes true, because the alternative is what this cost once: `Expand all`
      // waited on subagent rows the recording contains none of, the wait quietly expired, and the
      // figure was published showing a list without the very thing its caption promised. A `waitFor`
      // states what the figure must contain — an unmet one is a wrong figure, not a slow one.
      await page
        .locator(shot.waitFor)
        .filter({ visible: true })
        .first()
        .waitFor({ state: 'visible', timeout: 15_000 })
        .catch(() => {
          throw new Error(
            `${shot.id}: waitFor ${shot.waitFor} never became visible — the state this figure claims did not happen`,
          );
        });
      await page.waitForTimeout(600);
    }
    // The VISIBLE match, never simply the first: the shell keeps a second copy of a session's
    // widgets mounted and hidden, so `.first()` cropped the invisible twin and every shot failed
    // on a page that was rendering correctly.
    const el = page.locator(shot.selector).filter({ visible: true }).first();
    if (!(await el.isVisible().catch(() => false))) {
      const cards = await page.locator('.card').count();
      const shown = await page.locator('.card:visible').count();
      const here = await page.locator(shot.selector).count();
      // A picture of the page it failed on, into the private bundle — never the repo. Counts alone
      // cannot tell "the widget was renamed" from "the view never became visible", and those two
      // need opposite fixes.
      const dump = join(OUT, 'assets', `failed-${shot.id}.png`);
      await page.screenshot({ path: dump, fullPage: true }).catch(() => {});
      throw new Error(
        `${shot.id}: ${shot.selector} matched ${here} element(s), none visible — renamed widget, or a view that never mounted\n` +
          `  page: ${await page.title()} · ${cards} .card of which ${shown} visible\n  dump: ${dump}`,
      );
    }
    // A crop this small is a widget that rendered its empty state, or a selector that caught a
    // wrapper instead of the card: either way the figure would show nothing while the caption
    // promises something. Loud, because a picture of nothing is the one failure a reader cannot
    // detect. (Floor in CSS px, so it holds whatever the scale factor is.)
    const box = await el.boundingBox();
    const MIN = { w: 200, h: 60 };
    if (!box || box.width < MIN.w || box.height < MIN.h)
      throw new Error(
        `${shot.id}: ${shot.selector} is ${box ? `${Math.round(box.width)}×${Math.round(box.height)}` : 'unmeasurable'}` +
          ` — under ${MIN.w}×${MIN.h}, so the figure would be empty`,
      );
    // A pane can be the right size and say NOTHING: the settings drawer rendered its frame and its
    // close button while its content was still being fetched, and 500x1100 of empty panel passed the
    // size floor without trouble. Text is the only thing that separates a figure from a backdrop.
    const text = ((await el.innerText().catch(() => '')) ?? '').trim();
    if (text.length < 24)
      throw new Error(
        `${shot.id}: ${shot.selector} holds ${text.length} characters of text — a figure of nothing.` +
          ` Give the shot a \`waitFor\` for something its content renders.`,
      );
    const path = join(outDir, `${shot.id}.png`);
    // Animations FROZEN at their first frame: a live surface pulses (the LIVE dot, the running
    // spinner), and a screenshot otherwise catches whatever phase it happened to be in — two cuts
    // of the same code differed by a handful of pixels nobody can see and every byte comparison
    // can. It also makes the figure show the state, not a moment of its animation.
    await el.screenshot({ path, animations: 'disabled' });
    const kb = Math.round(Bun.file(path).size / 1024);
    console.log(`[doc-shots] ${shot.id}.png (${kb} KB) — ${shot.subject}`);
    cut.push(shot.id);
  };

  // A shot that declares its own height gets it for its own duration and gives it straight back:
  // the runs take several shots against one page, and a viewport left short would silently crop the
  // next one — the failure that looks like a widget having moved.
  //
  // CAPPED, because every wait inside `takeOne` has a deadline and the run still hung twice, for an
  // hour each time, on the same shot that had just succeeded on its own — intermittently, somewhere
  // under the browser, printing nothing. The cause is not established and the cap does not need it:
  // a capture that stops must SAY so, and 3 minutes is far past the slowest shot ever measured
  // (~20s). Losing one figure to a spurious timeout is recoverable; a run nobody can tell from a
  // slow one is what cost the two hours.
  return async (shot: DocShot): Promise<void> => {
    const shared = page.viewportSize();
    if (shot.viewportHeight && shared) await page.setViewportSize({ ...shared, height: shot.viewportHeight });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        takeOne(shot),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${shot.id}: no verdict after 180s — the capture stopped`)),
            180_000,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (shot.viewportHeight && shared) await page.setViewportSize(shared).catch(() => {});
    }
  };
}

/**
 * One git command in a scene's fixture repository, with the fixed identity and clock the scene
 * hands it. Throws on failure: a half-built repository would photograph as an empty card, which is
 * the silent wrong picture this whole path exists to avoid.
 */
async function git(args: string[], cwd: string, env: Record<string, string>): Promise<string> {
  const p = Bun.spawn(['git', ...args], { cwd, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${err.trim() || out.trim()}`);
  return out;
}

/**
 * Cut the shots of one SYNTHETIC scene: write the transcript Claude Code would have written, open
 * the session, take the crops. No pacing — every state a scene exists for is a settled one, so the
 * whole transcript lands at once and the page is photographed after it.
 */
async function shootScene(
  sceneId: string,
  shots: DocShot[],
  outDir: string,
  cut: string[],
  posture?: DocShot['server'],
): Promise<void> {
  const build = DOC_SCENES[sceneId];
  if (!build) throw new Error(`unknown scene '${sceneId}' — add it to scripts/doc-scenes.ts`);
  const scene = build();
  // The same leak guard the recorded path runs. A generator cannot leak a real path by accident
  // today, and this is what keeps that true tomorrow.
  const leak = scene.lines.map(leakIn).find(Boolean);
  if (leak) throw new Error(`scene ${sceneId} carries ${leak} — refusing to capture`);

  const cfg = join(OUT, `cfg-${sceneId}${posture ? `-${posture.commonName}` : ''}`);
  await rm(cfg, { recursive: true, force: true });
  await mkdir(cfg, { recursive: true });
  // A scene whose cards read GIT needs the repository before the transcript, because the transcript
  // has to name the hashes it produced. Built fresh every run: a leftover from a previous cut would
  // carry commits this session never made, and the card would attribute them to nobody.
  if (scene.repo) {
    if (!scene.cwd.startsWith('/tmp/')) throw new Error(`scene ${sceneId} builds a repo outside /tmp — refusing`);
    await rm(scene.cwd, { recursive: true, force: true });
    const hashes = await materialiseRepo(scene, { mkdir, writeFile, run: git }, join);
    scene.lines = substituteHashes(scene.lines, hashes);
    console.log(`[doc-shots] scene ${sceneId}: repo at ${scene.cwd} — ${hashes.join(' ')}`);
  }
  const { sessionId, cwd } = await writeScene(cfg, scene, { mkdir, writeFile }, join);
  if (scene.status) await writeOpenRecord(cfg, sessionId, cwd, scene.status);
  console.log(`[doc-shots] scene ${sceneId}: ${scene.lines.length} lines, ${shots.length} shot(s)`);

  try {
    await shootSceneShots(scene, sessionId, shots, outDir, cut, cfg, posture);
  } finally {
    // The fixture repository does not outlive the shot: it sits at a path any other run would
    // reuse, and a stale one is worse than none — its commits belong to no session.
    if (scene.repo) await rm(scene.cwd, { recursive: true, force: true });
  }
}

/** The page half of {@link shootScene}, split out so the repository can be cleaned up around it. */
async function shootSceneShots(
  scene: Scene,
  sessionId: string,
  shots: DocShot[],
  outDir: string,
  cut: string[],
  cfg: string,
  posture?: DocShot['server'],
): Promise<void> {
  await withDocPage(
    cfg,
    async (page, url) => {
      // Freeze the page's clock at the scene's own "now". A synthetic transcript is written at a
      // FIXED date so the same code produces the same pixels — but anything the page derives from
      // the wall clock (a running command's age) is then measured against today, which made a row
      // read `3823h 19m` and grow by 24h every day the figure was re-cut. With the clock pinned,
      // those ages are as reproducible as the rest of the picture.
      if (scene.now) await page.clock.setFixedTime(new Date(scene.now));
      await page.goto(withSession(url, sessionId), { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(5_000);
      const take = makeTake(page, outDir, cut);
      for (const [i, shot] of shots.entries()) {
        // Every shot starts from a RELOADED page, not from whatever the previous one left behind.
        // Escape was not enough: the timeline strip stays open, so the next shot's click on the same
        // control TOGGLED it shut and its chips were "not on the page" — a skip that looked like a
        // renamed widget. A shot must not depend on the order it happens to sit in.
        if (i > 0) {
          await page.reload({ waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(4_000);
        }
        await take(shot);
      }
    },
    posture,
  );
}

/**
 * Cut the figures of `docs/features.md`.
 *
 * `--only <scene|shot-id>` narrows the run to one scene or one shot. It exists because the two
 * halves have very different prerequisites: a SCENE is generated from `doc-scenes.ts` and costs
 * nothing, while the recorded shots need the bundle a `record` run leaves in a temp directory —
 * which the OS eventually deletes, and re-making it drives real sessions and burns tokens. Without
 * the flag, a missing bundle blocks even the figures that need no recording at all.
 *
 * The bare command is unchanged, and still FAILS when the bundle is gone: a figure that cannot be
 * cut must not pass quietly, or a widget that moved becomes a picture that lies.
 */
async function docShots(only?: string, opts: { out?: string; ids?: string[] } = {}): Promise<void> {
  const manifest = await readManifest();
  // `resolve`, not `join`: the verifier passes an ABSOLUTE temp dir, and joining that onto the cwd
  // built `<repo>/var/folders/…` — a directory of PNGs inside the git tree, and a verification that
  // then found nothing where it looked and called every figure unverified.
  const outDirAll = resolve(process.cwd(), opts.out ?? manifest.outDir);
  await mkdir(outDirAll, { recursive: true });
  const cutAll: string[] = [];
  const wanted = opts.ids
    ? manifest.shots.filter((s) => opts.ids!.includes(s.id))
    : only
      ? manifest.shots.filter((s) => s.id === only || s.scene === only)
      : manifest.shots;
  if (only && wanted.length === 0) throw new Error(`--only ${only}: no shot or scene by that name in the manifest`);
  if (opts.ids && wanted.length === 0) throw new Error(`--ids: none of those ids are in the manifest`);
  // The recorded half replays one bundle through one server, so a posture there would apply to
  // every figure in it. Loud rather than silently ignored — a shot photographed in the wrong
  // posture is a picture that lies about what the product is doing.
  const strayPosture = wanted.find((s) => !s.scene && s.server);
  if (strayPosture) throw new Error(`${strayPosture.id}: a "server" posture needs a scene of its own`);
  // Grouped by scene AND posture: a group is one server and one page, so two shots of the same
  // scene that need the server bound differently cannot share it.
  const groups = new Map<string, DocShot[]>();
  for (const shot of wanted) {
    const key = `${shot.scene ?? 'recorded'} ${shot.server ? `${shot.server.host}|${shot.server.commonName}` : ''}`;
    groups.set(key, [...(groups.get(key) ?? []), shot]);
  }
  if (wanted.some((s) => !s.scene))
    await shootRecorded(
      wanted.filter((s) => !s.scene),
      outDirAll,
      cutAll,
    );
  for (const [key, shots] of groups) {
    const [id] = key.split(' ');
    if (id === 'recorded') continue;
    await shootScene(id!, shots, outDirAll, cutAll, shots[0]!.server);
  }

  const missing = wanted.filter((s) => !cutAll.includes(s.id)).map((s) => s.id);
  console.log(`[doc-shots] ${cutAll.length}/${wanted.length} cut → ${manifest.outDir}`);
  if (missing.length > 0) console.log(`[doc-shots] not cut: ${missing.join(', ')}`);
}

/**
 * Re-cut these shots into a temp directory and say, for each, whether the PICTURE actually
 * changed. Prints one line per shot: `SAME <id>`, `DIFFERS <id>`, `VOLATILE <id>`, `UNCUT <id>`.
 *
 * This exists because the manifest's dependency map answers a coarser question than the one worth
 * asking. Every figure declares `client/graph.ts`, so ANY edit to that file flags all fourteen —
 * measured on a real change that could only alter one of them. A warning that fires when nothing
 * is wrong is one people learn to scroll past, which is the same as not having it.
 *
 * The comparison is EXACT — no tolerance, no threshold. A figure that cannot be compared exactly
 * is one whose content moves on its own, and the manifest marks those `volatile`: the NOW panel
 * prints an age relative to the clock, so its figure differs on every cut (`4444m ago` became
 * `4775m ago` between two runs of the same code). Those are reported as unverifiable rather than
 * quietly passed — a threshold big enough to absorb a ticking number is big enough to hide a
 * label, and guessing which is which is exactly what this is meant to stop doing.
 */
async function docShotsVerify(ids: string[]): Promise<void> {
  const manifest = await readManifest();
  const wanted = manifest.shots.filter((s) => ids.length === 0 || ids.includes(s.id));
  const tmp = join(tmpdir(), `seedeep-shot-verify-${process.pid}`);
  try {
    const { lines, errors } = await verifyVerdicts(wanted, tmp, join(process.cwd(), manifest.outDir), {
      cut: (only, out) => docShots(undefined, { out, ids: only }),
      bytes: async (path) => {
        const f = Bun.file(path);
        return (await f.exists()) ? await f.bytes() : null;
      },
    });
    for (const line of lines) console.log(line);
    for (const e of errors) console.error(`[doc-shots-verify] ${e}`);
  } catch (e) {
    // Nothing could be read at all: every comparable shot is unverified, and saying so is the whole
    // point — an unverifiable figure must never read as a verified one.
    for (const s of wanted.filter((x) => !x.volatile)) console.log(`UNCUT ${s.id}`);
    console.error(`[doc-shots-verify] ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * The stills replay at REAL time, where the GIFs are compressed 20×.
 *
 * Not for the durations — those are stamped from the session's own intervals now, so they are right
 * at any pace. For the LIVE states: a fan-out that ran 9 seconds passes in under half a second at
 * 20×, and that is not a window anything can be photographed inside. The live monitor was caught
 * after it every time, showing "0 running" for three subagents that had just been spawned.
 *
 * A GIF has the opposite need — nobody watches four minutes of a window filling — so `shoot` keeps
 * its own pace. Overridable for a one-off, but the default is the honest one.
 */
const STILL_SPEED = Number(process.env['SEEDEEP_STILL_SPEED'] ?? 1);

/**
 * The wall-clock instant the replayed session is pinned to for STILLS — a constant, so a figure cut
 * today and the same figure cut in a year hold the same pixels.
 *
 * Two cards print an absolute launch time (`Aug 09 17:54:12`), so anchoring the session to `now`
 * puts the clock inside the PNG: two cuts minutes apart differ, and the pre-push comparison reports
 * a change nobody made. Nothing else in a still is relative to today — the live surfaces take
 * liveness from the open-session record, which this replay writes with the real pid and the real
 * clock, so the session still reads as working.
 */
const STILL_ANCHOR: number | null = Date.parse('2026-08-09T09:00:00Z');

/** Cut the shots that come from the RECORDED session: replayed at its original pace. */
async function shootRecorded(shots: DocShot[], outDir: string, cut: string[]): Promise<void> {
  const bundle = join(OUT, 'session');
  const meta = JSON.parse(await readFile(join(bundle, 'meta.json'), 'utf8')) as { slug: string; cwd: string };
  const slugDir = join(bundle, meta.slug);
  const stream = await timeline(slugDir);
  if (stream.length === 0) throw new Error(`no transcript lines in ${slugDir} — run \`record\` first`);
  // BEFORE the browser opens, exactly as in `shoot`: a leak found once a frame exists is a leak
  // that was drawn, and these frames are committed to a public repo.
  const leaks = stream.map((l) => leakIn(JSON.stringify(l.obj))).filter(Boolean);
  if (leaks.length > 0)
    throw new Error(`${leaks.length} lines still carry ${leaks[0]} after scrubbing — refusing to capture`);

  const cfg = join(OUT, 'cfg');
  await rm(cfg, { recursive: true, force: true });
  await mkdir(join(cfg, 'projects', meta.slug), { recursive: true });

  const sessionId = sessionIdOf(stream);
  if (!sessionId) throw new Error('no sessionId in the bundle — cannot open the session view');

  const SEED_MAX = 6;
  const seed = stream.slice(0, SEED_MAX);
  // ONE anchor for the whole replay, fixed before the first line and never re-read: it is what makes
  // two cuts of the same code identical. Everything is stamped `anchor + (line - base)`, so the
  // session's intervals survive exactly and nothing carries a clock reading. Fixed HERE rather than
  // at the replay's t0 so no line is ever stamped in the future — the seed is written some seconds
  // earlier, and the whole session simply sits that much behind the wall clock, which costs a
  // relative age and no duration at all.
  const base = stream[seed.length]?.at ?? stream[0]!.at;
  const anchor = STILL_ANCHOR ?? Date.now();
  const stampOf = (l: TimedLine): number => anchor + (l.at - base);
  for (const l of seed) await writeLine(cfg, meta.slug, l, slugDir, stampOf(l));
  // Left `busy` for the whole run, unlike `shoot`, which flips to idle before its Home and Search
  // frames: every figure here is of a LIVE surface, and an ended session collapses the monitor to a
  // one-line summary — the shot would show the thing the text is not describing.
  await writeOpenRecord(cfg, sessionId, meta.cwd, 'busy');
  await new Promise((r) => setTimeout(r, 4_000));

  await withDocPage(cfg, async (page, url) => {
    await page.goto(withSession(url, sessionId), { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4_000);
    const take = makeTake(page, outDir, cut);
    const byCue = (cue: string): DocShot[] => shots.filter((s) => s.cue === cue);

    const t0 = Date.now();
    let agentAt: number | null = null;
    let written = 0;
    const replayTask = (async () => {
      for (const l of stream.slice(seed.length)) {
        const due = t0 + (l.at - base) / STILL_SPEED;
        const wait = due - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        await writeLine(cfg, meta.slug, l, slugDir, stampOf(l));
        written++;
        if (agentAt === null && isAgentSpawn(l.obj)) agentAt = (Date.now() - t0) / 1000;
      }
    })();

    // The fan-out shots can only be taken WHILE the subagents run, so they come first and the
    // replay keeps writing behind them. Twelve seconds past the spawn, the same margin the hero
    // needs: at four the three cards exist but no context bar has moved, which is the half of the
    // picture the figure is for.
    while (agentAt === null && (Date.now() - t0) / 1000 < 300) await new Promise((r) => setTimeout(r, 250));
    if (agentAt !== null) {
      const settleUntil = agentAt + 12;
      while ((Date.now() - t0) / 1000 < settleUntil) await new Promise((r) => setTimeout(r, 250));
      for (const shot of byCue('fanout')) await take(shot);
    } else {
      console.log('[doc-shots] no subagent spawn in this bundle — fan-out shots not cut');
    }

    await replayTask;
    console.log(`[doc-shots] replay done: ${written} lines in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    await page.waitForTimeout(2_500);
    // The replay is over by now, so a reload costs nothing but determinism — and it is the only way
    // a shot cannot inherit the previous one's UI. Escape was not enough: the settings drawer stayed
    // open and the Trace button underneath it became "not visible", which reads as a renamed widget.
    for (const [i, shot] of byCue('end').entries()) {
      if (i > 0) {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3_500);
      }
      await take(shot);
    }
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3_500);

    for (const shot of byCue('trace')) {
      await take(shot);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(800);
    }

    // The amber state does not live in the transcript at all: Claude Code writes it into the
    // per-session PID file, which this replay is already the author of (it writes `busy` there from
    // the first line). So writing `waiting` is the same scaffolding one value further, not a
    // fabricated session — and it is the only way to photograph a state that leaves no log.
    const waiting = byCue('waiting');
    if (waiting.length > 0) {
      await writeOpenRecord(cfg, sessionId, meta.cwd, 'waiting', 'permission prompt');
      await page.waitForTimeout(5_000); // the roster is polled, not pushed
      for (const shot of waiting) await take(shot);
      await writeOpenRecord(cfg, sessionId, meta.cwd, 'busy');
    }

    for (const shot of byCue('verdict')) await take(shot);
  });
}

/** Record the short archive sessions, each into its own bundle under `<OUT>/extras/<name>`. */
async function recordExtras(): Promise<void> {
  const home = homedir();
  for (const extra of EXTRAS) {
    const name = extra.cwd.split('/').pop()!;
    const bundle = join(OUT, 'extras', name);
    await rm(bundle, { recursive: true, force: true });
    await mkdir(bundle, { recursive: true });
    const cfgRecord = await cleanProfile();
    console.log(`[extras] ${name}: recording`);
    const s = await openProbeSession({
      files: extra.files,
      cwd: extra.cwd,
      home,
      configDir: cfgRecord,
      permissionMode: 'acceptEdits',
    });
    const projectDir = join(cliRoot(home, { CLAUDE_CONFIG_DIR: cfgRecord }), slugFor(s.cwd));
    try {
      for (const [i, prompt] of extra.scenes.entries()) {
        const from = (await transcriptLines(s)).length;
        await s.typeLine(prompt);
        await waitForTurnEnd(s, from, `${name}-${i + 1}`);
      }
      const parent = await s.transcript();
      console.log(`[extras] ${name}: ${parent ? `${parent.length} bytes` : 'MISSING'}`);
    } finally {
      await cp(projectDir, join(bundle, slugFor(s.cwd)), { recursive: true }).catch(() => {});
      await s.close();
      await rm(cfgRecord, { recursive: true, force: true });
    }
  }
  console.log(`[extras] done → ${join(OUT, 'extras')}`);
}

const cmd = process.argv[2];
if (cmd === 'record') await record();
else if (cmd === 'record-extras') await recordExtras();
else if (cmd === 'shoot') await shoot();
else if (cmd === 'notif') await notif();
else if (cmd === 'doc-shots') {
  const arg = (flag: string) => {
    const i = process.argv.indexOf(flag);
    return i === -1 ? undefined : process.argv[i + 1];
  };
  const ids = arg('--ids');
  await docShots(arg('--only'), { out: arg('--out'), ids: ids ? ids.split(',').filter(Boolean) : undefined });
} else if (cmd === 'doc-shots-verify') await docShotsVerify((process.argv[3] ?? '').split(',').filter(Boolean));
else {
  console.error(
    'usage: capture-demo.ts record | record-extras | shoot | notif | doc-shots [--only <scene|shot-id>] [--ids a,b] [--out <dir>] | doc-shots-verify <id,id>',
  );
  process.exit(1);
}
