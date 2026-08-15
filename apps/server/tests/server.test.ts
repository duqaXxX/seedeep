import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { mergeRoster } from '../src/core/roster.ts';
import type { SessionRecord } from '../src/core/types.ts';
import { defaultConfig, type SeedDeepConfig } from '../src/server/config.ts';
import { isLoopback, parseMarks, selfSpawnPlan, startServer } from '../src/server/server.ts';
import type { Channel } from '../src/server/update-cmd.ts';
import { VERSION } from '../src/server/version.ts';

/**
 * A config both injected AND written to a temp `config.json`, as `startServer` fields.
 *
 * `GET /api/config` answers with the FILE — the panel edits the configuration, not the copy the
 * process is holding — so a test that only injects is asserting against whatever `config.json` the
 * machine running the suite happens to have. Left out, that is the contributor's own: the token
 * test passed while never reading the token it claimed to redact.
 */
function onDisk(cfg: SeedDeepConfig): { config: SeedDeepConfig; configPath: string } {
  const configPath = join(mkdtempSync(join(tmpdir(), 'seedeep-cfg-')), 'config.json');
  writeFileSync(configPath, JSON.stringify(cfg));
  return { config: cfg, configPath };
}

const roster: SessionRecord[] = [
  {
    sessionId: 'A',
    project: 'p',
    model: 'm',
    lastActivity: 1,
    isActive: true,
    isOpen: true,
    status: null,
    waitingFor: null,
    waitingSince: null,
    subject: null,
    entrypoint: null,
    root: 'cli',
    path: '/x/a.jsonl',
  },
];

test('the two halves served over HTTP rebuild the injected roster', async () => {
  // The split is only sound if what the wire carries reassembles into what discovery said.
  // Asserting it here, through real requests, is what makes /api/live safe to poll alone.
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => roster,
    port: 0,
  });
  try {
    const res = await fetch(`${srv.url}/api/sessions`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    const catalogue = await res.json();
    const live = await (await fetch(`${srv.url}/api/live`)).json();
    assert.deepEqual(live.sessions, roster, 'the one live session travels whole');
    assert.equal(live.total, roster.length);
    assert.deepEqual(mergeRoster(catalogue, live), roster);
  } finally {
    srv.stop();
  }
});

test('the catalogue drops the volatile fields — that is the whole point of splitting it', async () => {
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => roster,
    port: 0,
  });
  try {
    const [row] = await (await fetch(`${srv.url}/api/sessions`)).json();
    for (const k of ['isActive', 'isOpen', 'status', 'waitingFor', 'waitingSince']) {
      assert.ok(!(k in row), `${k} must not ride the catalogue`);
    }
    assert.equal(row.lastActivity, null, 'null while live: the poll owns it');
  } finally {
    srv.stop();
  }
});

test('an unchanged catalogue is revalidated, not resent', async () => {
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => roster,
    port: 0,
  });
  try {
    const first = await fetch(`${srv.url}/api/sessions`);
    const etag = first.headers.get('etag');
    assert.ok(etag, 'no ETag, no conditional GET');
    assert.equal(first.headers.get('cache-control'), 'no-cache');
    const second = await fetch(`${srv.url}/api/sessions`, { headers: { 'if-none-match': etag! } });
    assert.equal(second.status, 304);
    assert.equal((await second.arrayBuffer()).byteLength, 0);
  } finally {
    srv.stop();
  }
});

test('a body worth compressing is gzipped; a small one is not', async () => {
  // 400 sessions is a small real corpus (measured: 1086 on one machine) and the reason the
  // catalogue must not travel raw.
  // …and all but one are CLOSED, which is the real shape: 2 live out of 1086 on that machine.
  const big = Array.from({ length: 400 }, (_, i) => ({
    ...roster[0]!,
    sessionId: `s${i}`,
    path: `/x/${i}.jsonl`,
    subject: 'a plausible first prompt line',
    isActive: i === 0,
    isOpen: i === 0,
  }));
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => big,
    port: 0,
  });
  try {
    const res = await fetch(`${srv.url}/api/sessions`, { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(res.headers.get('content-encoding'), 'gzip');
    assert.equal(res.headers.get('vary'), 'accept-encoding');
    assert.equal((await res.json()).length, 400, 'and it still decodes to the same JSON');
    // The live poll is deliberately below the threshold: compressing ~1 KB is not worth it.
    const live = await fetch(`${srv.url}/api/live`, { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(live.headers.get('content-encoding'), null);
  } finally {
    srv.stop();
  }
});

test('the ETag names the representation, so an identity client cannot be handed the gzip entry', async () => {
  // Two encodings are two different sets of bytes. `vary` only helps if every cache in the path
  // honours it; a strong validator shared between them is what lets one answer for the other.
  const big = Array.from({ length: 400 }, (_, i) => ({
    ...roster[0]!,
    sessionId: `s${i}`,
    path: `/x/${i}.jsonl`,
    isActive: false,
    isOpen: false,
  }));
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => big,
    port: 0,
  });
  try {
    const gz = await fetch(`${srv.url}/api/sessions`, { headers: { 'accept-encoding': 'gzip' } });
    const plain = await fetch(`${srv.url}/api/sessions`, { headers: { 'accept-encoding': 'identity' } });
    const gzTag = gz.headers.get('etag')!;
    assert.notEqual(gzTag, plain.headers.get('etag'), 'one tag for two representations');
    const crossed = await fetch(`${srv.url}/api/sessions`, {
      headers: { 'accept-encoding': 'identity', 'if-none-match': gzTag },
    });
    assert.equal(crossed.status, 200, 'the compressed tag must not validate an identity request');
  } finally {
    srv.stop();
  }
});

test('a static file is revalidated with an ETag instead of being re-sent whole', async () => {
  // It was `no-store`: every reload paid for the 230 KB bundle again. `no-cache` still
  // revalidates every time — a rebuilt bundle can never be served stale — but costs a 304.
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [],
    port: 0,
  });
  try {
    const first = await fetch(`${srv.url}/`);
    assert.equal(first.headers.get('cache-control'), 'no-cache');
    const etag = first.headers.get('etag')!;
    const second = await fetch(`${srv.url}/`, { headers: { 'if-none-match': etag } });
    assert.equal(second.status, 304);
  } finally {
    srv.stop();
  }
});

test('GET / serves the static index page', async () => {
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [],
    port: 0,
  });
  try {
    const res = await fetch(`${srv.url}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /seedeep/);
  } finally {
    srv.stop();
  }
});

test('unknown route → 404, non-GET → 405', async () => {
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [],
    port: 0,
  });
  try {
    assert.equal((await fetch(`${srv.url}/nope`)).status, 404);
    assert.equal((await fetch(`${srv.url}/api/sessions`, { method: 'POST' })).status, 405);
  } finally {
    srv.stop();
  }
});

test('GET /api/retro and /api/baseline serve the aggregate from a real temp corpus', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-corpus-'));
  // one closed work turn — faithful cli shape (typed prompt, usage, turn_duration).
  const lines = [
    JSON.stringify({
      type: 'user',
      uuid: 'u1',
      timestamp: '2026-07-14T10:00:00.000Z',
      origin: { kind: 'human' },
      promptSource: 'typed',
      message: { role: 'user', content: 'hi' },
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: 'a1',
      timestamp: '2026-07-14T10:00:05.000Z',
      message: {
        role: 'assistant',
        model: 'claude-opus-4-8',
        usage: { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 50 },
      },
    }),
    JSON.stringify({
      type: 'system',
      subtype: 'turn_duration',
      uuid: 'd1',
      timestamp: '2026-07-14T10:00:09.000Z',
      durationMs: 9000,
      messageCount: 3,
    }),
  ];
  const sessionPath = join(dir, 's.jsonl');
  // Trailing newline, because every one of 1054 real transcripts has one (measured 2026-07-28):
  // the retro now reads sessions through the tailer, which withholds an unterminated final line —
  // correct for a file still being written, and a fixture without it is a shape CC never writes.
  writeFileSync(sessionPath, lines.join('\n') + '\n');
  const corpus: SessionRecord[] = [
    {
      sessionId: 's',
      project: 'p',
      model: 'm',
      lastActivity: 1,
      isActive: false,
      isOpen: false,
      status: null,
      waitingFor: null,
      waitingSince: null,
      subject: null,
      entrypoint: null,
      root: 'cli',
      path: sessionPath,
    },
  ];
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => corpus,
    port: 0,
    cacheFile: join(dir, 'aggregates.json'),
  });
  try {
    const retro = await (await fetch(`${srv.url}/api/retro`)).json();
    assert.equal(retro.windows.all.turns, 1);
    assert.equal(retro.sessions, 1);
    assert.equal(retro.baseline.overall.p50, 160); // 10 + 100 + 50
    // /api/baseline serves exactly retro.baseline — one scanner, one number, two endpoints.
    assert.deepEqual(await (await fetch(`${srv.url}/api/baseline`)).json(), retro.baseline);
  } finally {
    srv.stop();
  }
});

// An idle SSE connection sends nothing, so a path that has quietly dropped it looks
// exactly like a session with nothing to say — for as long as the page stays open. The
// heartbeat is the only thing that puts bytes on a quiet stream, which is what lets a dead
// one fail and be closed instead of hanging forever. It is a named EVENT, not a comment,
// because the browser's silence watchdog has to be able to HEAR it.
test('a quiet stream still receives a heartbeat', async () => {
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [],
    port: 0,
    heartbeatMs: 40,
  });
  try {
    const res = await fetch(`${srv.url}/api/stream`);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    await reader.read(); // the opening ': connected' comment
    const { value } = await reader.read(); // nothing was emitted — only the heartbeat can arrive
    assert.equal(dec.decode(value), 'event: heartbeat\ndata: {}\n\n');
    await reader.cancel();
  } finally {
    srv.stop();
  }
});

test('stop() stops the heartbeat', async () => {
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [],
    port: 0,
    heartbeatMs: 10,
  });
  const res = await fetch(`${srv.url}/api/stream`);
  const reader = res.body!.getReader();
  await reader.read();
  srv.stop();
  // The registry is emptied with the server; a heartbeat firing after stop would throw into
  // a closed controller, which is the failure this asserts is gone.
  await new Promise((r) => setTimeout(r, 60));
  await reader.cancel().catch(() => {});
});

test('a Watcher event is streamed to a connected SSE client', async () => {
  const watcher = new EventEmitter();
  const srv = await startServer({ watcher, discover: async () => [], port: 0 });
  try {
    const res = await fetch(`${srv.url}/api/stream`);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    // The stream opens with a ': connected' comment; drain until the usage frame.
    await reader.read(); // the opening comment
    watcher.emit('event', { type: 'usage', sessionId: 'A', root: 'cli', timestamp: 't', delta: {}, fill: 42 });
    const { value } = await reader.read();
    const chunk = dec.decode(value);
    assert.match(chunk, /event: usage/);
    assert.match(chunk, /"fill":42/);
    await reader.cancel();
  } finally {
    srv.stop();
  }
});

// The whole contract of this parser is to FAIL OPEN: a mark it cannot understand must replay
// the file whole, because withholding history on a guess is the failure it exists to repair.
// `Number` is too generous to express that — it reads '' as 0, i.e. "the caller already has
// line 0", which withholds a line on the strength of an empty string.
test('parseMarks: a seq that is not a plain number is no mark at all', () => {
  assert.equal(parseMarks(':'), undefined, 'an empty seq is not a mark of 0');
  assert.equal(parseMarks('ag-7:'), undefined);
  assert.equal(parseMarks(': 5'), undefined, 'whitespace is not a number here, whatever Number says');
  assert.equal(parseMarks(':0x10'), undefined);
  assert.equal(parseMarks(':-1'), undefined);
  assert.deepEqual([...parseMarks(':5,ag-7:')!], [['', 5]], 'a bad pair costs only its own file');
  assert.deepEqual(
    [...parseMarks(':5,ag:3')!],
    [
      ['', 5],
      ['ag', 3],
    ],
  );
  assert.deepEqual([...parseMarks('run:a:2')!], [['run:a', 2]], 'an agentId may contain a colon');
});

// ── isLoopback ──────────────────────────────────────────────────────────────

test('isLoopback: true for 127.0.0.1, ::1, localhost', () => {
  assert.equal(isLoopback('127.0.0.1'), true);
  assert.equal(isLoopback('::1'), true);
  assert.equal(isLoopback('localhost'), true);
});

test('isLoopback: false for 0.0.0.0 and LAN addresses', () => {
  assert.equal(isLoopback('0.0.0.0'), false);
  assert.equal(isLoopback('192.168.1.1'), false);
  assert.equal(isLoopback('10.0.0.1'), false);
});

// ── host is passed to Bun.serve and the socket binds there ──────────────────

test('host 0.0.0.0 is passed to Bun.serve and the socket accepts connections', async () => {
  // Binding to 0.0.0.0 without TLS normally requires auth; _skipTls disables TLS for the test
  // while keeping the server logic intact. We verify with a real connection to 127.0.0.1.
  const cfg = { ...defaultConfig(), auth: { token: 'test-token-abc' } };
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [],
    port: 0,
    host: '0.0.0.0',
    ...onDisk(cfg),
    _skipTls: true,
  });
  try {
    // GET /api/config is auth-exempt — proves the socket is reachable on 127.0.0.1.
    const res = await fetch(`${srv.url}/api/config`);
    assert.equal(res.status, 200, 'server bound to 0.0.0.0 accepts connections via 127.0.0.1');
  } finally {
    srv.stop();
  }
});

// ── auth middleware ──────────────────────────────────────────────────────────

test('remote host: missing token → 401', async () => {
  const cfg = { ...defaultConfig(), auth: { token: 'correct-token-xyz' } };
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [],
    port: 0,
    host: '0.0.0.0',
    ...onDisk(cfg),
    _skipTls: true,
  });
  try {
    const res = await fetch(`${srv.url}/api/sessions`);
    assert.equal(res.status, 401);
  } finally {
    srv.stop();
  }
});

test('remote host: wrong token → 401', async () => {
  const cfg = { ...defaultConfig(), auth: { token: 'correct-token-xyz' } };
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [],
    port: 0,
    host: '0.0.0.0',
    ...onDisk(cfg),
    _skipTls: true,
  });
  try {
    const res = await fetch(`${srv.url}/api/sessions`, {
      headers: { authorization: 'Bearer wrong-token' },
    });
    assert.equal(res.status, 401);
  } finally {
    srv.stop();
  }
});

test('remote host: correct token → 200', async () => {
  const cfg = { ...defaultConfig(), auth: { token: 'correct-token-xyz' } };
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [],
    port: 0,
    host: '0.0.0.0',
    ...onDisk(cfg),
    _skipTls: true,
  });
  try {
    const res = await fetch(`${srv.url}/api/sessions`, {
      headers: { authorization: 'Bearer correct-token-xyz' },
    });
    assert.equal(res.status, 200);
  } finally {
    srv.stop();
  }
});

test('remote host: GET /api/config is exempt from auth (no token needed)', async () => {
  const cfg = { ...defaultConfig(), auth: { token: 'secret-token-abc' } };
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [],
    port: 0,
    host: '0.0.0.0',
    ...onDisk(cfg),
    _skipTls: true,
  });
  try {
    // No Authorization header — still 200.
    const res = await fetch(`${srv.url}/api/config`);
    assert.equal(res.status, 200, 'GET /api/config is exempt from auth');
  } finally {
    srv.stop();
  }
});

// The exemption above was granted for ONE reason — the version has to be readable before a token
// exists — and it must not quietly become a way to read everything else. `dev` says the operator is
// serving from a checkout, which is the only field here a stranger could not already know: host and
// port are what they used to arrive. The portal reads this through `authFetch`, so the chip is
// unaffected either way.
test('remote host: GET /api/config tells an anonymous caller nothing about the build', async () => {
  const cfg = { ...defaultConfig(), auth: { token: 'secret-token-abc' } };
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [],
    port: 0,
    host: '0.0.0.0',
    ...onDisk(cfg),
    _skipTls: true,
  });
  try {
    const anonymous = await (await fetch(`${srv.url}/api/config`)).json();
    assert.equal(anonymous.version, VERSION, 'the version is what the exemption is for');
    assert.ok(!('dev' in anonymous), 'the build must not be readable without the token');

    const authed = await (
      await fetch(`${srv.url}/api/config`, { headers: { authorization: 'Bearer secret-token-abc' } })
    ).json();
    // Presence is the property, not the value: the suite itself runs from source, so what `dev`
    // says here is a fact about how the tests were launched.
    assert.equal(typeof authed.dev, 'boolean', 'the token buys the mark the portal draws');
  } finally {
    srv.stop();
  }
});

// Loopback has no token to present and nothing to prove, so the mark is simply there — this is the
// path the portal takes on every ordinary run.
test('loopback: GET /api/config carries the build mark', async () => {
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [],
    port: 0,
    ...onDisk(defaultConfig()),
  });
  try {
    const body = await (await fetch(`${srv.url}/api/config`)).json();
    assert.equal(typeof body.dev, 'boolean', 'the portal needs it to mark itself');
  } finally {
    srv.stop();
  }
});

// ── GET /api/config does not leak the token ──────────────────────────────────

test('GET /api/config: token is redacted as "***"', async () => {
  const cfg = { ...defaultConfig(), auth: { token: 'my-real-token' } };
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [],
    port: 0,
    ...onDisk(cfg),
  });
  try {
    const body = await (await fetch(`${srv.url}/api/config`)).json();
    assert.equal(body.auth.token, '***', 'token must be redacted');
    // Verify the raw token is not anywhere in the serialised response.
    const raw = JSON.stringify(body);
    assert.ok(!raw.includes('my-real-token'), 'real token must not appear anywhere in the response');
  } finally {
    srv.stop();
  }
});

// Asserted against the manifest rather than a literal: a hardcoded "0.1.1" here would go
// stale at the next release and be corrected by editing the test, which is how a version check stops
// checking anything. What must hold is that the endpoint reports the version this build IS.
test('GET /api/config carries the running server’s version', async () => {
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [],
    port: 0,
    ...onDisk(defaultConfig()),
  });
  try {
    const body = await (await fetch(`${srv.url}/api/config`)).json();
    assert.equal(body.version, VERSION);
    assert.match(body.version, /^\d+\.\d+\.\d+/, 'a semver, not a path to a manifest');
  } finally {
    srv.stop();
  }
});

test('GET /api/config: tls.cert and tls.key paths are omitted', async () => {
  const cfg = { ...defaultConfig(), tls: { cert: '/home/dev/.seedeep/cert.pem', key: '/home/dev/.seedeep/key.pem' } };
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [],
    port: 0,
    ...onDisk(cfg),
  });
  try {
    const body = await (await fetch(`${srv.url}/api/config`)).json();
    assert.ok(!('cert' in body.tls), 'tls.cert must be omitted');
    assert.ok(!('key' in body.tls), 'tls.key must be omitted');
  } finally {
    srv.stop();
  }
});

// ── the certificate fingerprint a non-browser client pins (TOFU) ─────────────

/**
 * A remote server with a REAL self-signed cert. Pass `certDir` to reuse an existing pair —
 * that is the day-two path every start after the first one takes.
 */
async function startTlsServer(configPath?: string, certDir = mkdtempSync(join(tmpdir(), 'seedeep-cert-'))) {
  const cfg = {
    ...defaultConfig(),
    auth: { token: 'tls-test-token' },
    tls: { commonName: 'seedeep-test.local', cert: join(certDir, 'cert.pem'), key: join(certDir, 'key.pem') },
  };
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [],
    port: 0,
    host: '0.0.0.0',
    config: cfg,
    configPath,
  });
  // `srv.url` names the CN, which does not resolve — connect to the loopback socket instead.
  // `rejectUnauthorized: false` is the client-side stand-in for the pinning this value enables.
  const base = `https://127.0.0.1:${new URL(srv.url).port}`;
  const get = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, { ...init, tls: { rejectUnauthorized: false } } as RequestInit);
  return { srv, get, certDir };
}

test('GET /api/config over real TLS carries the certificate fingerprint', async () => {
  const { srv, get } = await startTlsServer();
  try {
    assert.ok(srv.tlsFingerprint, 'a TLS server must report the certificate it presents');
    const body = await (await get('/api/config')).json();
    assert.equal(body.tls.fingerprint, srv.tlsFingerprint);
    // Exposing the fingerprint must not have widened what else the endpoint leaks.
    assert.ok(!('cert' in body.tls) && !('key' in body.tls), 'paths stay omitted');
    assert.equal(body.auth.token, '***');
  } finally {
    srv.stop();
  }
});

test('a restart on an existing certificate reports the same fingerprint', async () => {
  // Every start after the first takes the reuse branch, so this is the state a user is
  // actually in when they set a pinning client up — and the one the old code fell silent on.
  const first = await startTlsServer();
  let expected: string | null;
  try {
    expected = first.srv.tlsFingerprint;
  } finally {
    first.srv.stop();
  }

  const second = await startTlsServer(undefined, first.certDir);
  try {
    assert.equal(second.srv.tlsFingerprint, expected, 'same certificate, same value');
    const body = await (await second.get('/api/config')).json();
    assert.equal(body.tls.fingerprint, expected, 'and the endpoint still serves it');
  } finally {
    second.srv.stop();
  }
});

/**
 * The test the suite did not have, and the reason a broken SAN shipped: every TLS test above
 * connects with `rejectUnauthorized: false`, which switches off the exact check that was wrong.
 * This one completes a real handshake as a VALIDATING client — the server's own certificate as
 * the CA, so nothing but name validation can fail — against the name seedeep prints and copies.
 */
async function getValidating(certDir: string, serverName: string, port: string): Promise<Response> {
  const ca = readFileSync(join(certDir, 'cert.pem'), 'utf8');
  return fetch(`https://127.0.0.1:${port}/api/config`, { tls: { ca, serverName } } as RequestInit);
}

test('a validating client accepts the certificate by the configured name', async () => {
  const { srv, certDir } = await startTlsServer();
  const port = new URL(srv.url).port;
  try {
    const res = await getValidating(certDir, 'seedeep-test.local', port);
    assert.equal(res.status, 200, 'the configured name must validate — it is the URL seedeep hands out');

    // Negative control: without it, a `ca` that made everything pass would leave the assertion
    // above proving nothing at all.
    await assert.rejects(
      () => getValidating(certDir, 'not-in-the-cert.local', port),
      /ALTNAME|altname|certificate/i,
      'a name absent from the certificate must be refused',
    );
  } finally {
    srv.stop();
  }
});

test('changing the common name replaces the certificate, and says so', async () => {
  const first = await startTlsServer();
  let stale: string | null;
  try {
    stale = first.srv.tlsFingerprint;
  } finally {
    first.srv.stop();
  }

  // Same files, different name — the day a user fills the Settings panel's Common name in.
  const cfg = {
    ...defaultConfig(),
    auth: { token: 'tls-test-token' },
    tls: { commonName: 'renamed.local', cert: join(first.certDir, 'cert.pem'), key: join(first.certDir, 'key.pem') },
  };
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [],
    port: 0,
    host: '0.0.0.0',
    config: cfg,
  });
  try {
    assert.equal(srv.tlsCertOrigin, 'replaced');
    assert.notEqual(srv.tlsFingerprint, stale, 'a replacement a pin cannot see is not a replacement');
    const res = await getValidating(first.certDir, 'renamed.local', new URL(srv.url).port);
    assert.equal(res.status, 200, 'the new name validates against the certificate now being served');
  } finally {
    srv.stop();
  }
});

test('loopback mode reports no fingerprint — there is no certificate to pin', async () => {
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [],
    port: 0,
    ...onDisk(defaultConfig()),
  });
  try {
    assert.equal(srv.tlsFingerprint, null);
    const body = await (await fetch(`${srv.url}/api/config`)).json();
    // Asserted before the `in` check so a dropped `tls` key fails as itself, rather than as a
    // TypeError that sends the reader looking for a fingerprint bug.
    assert.ok(body.tls, 'the response still carries tls');
    assert.ok(!('fingerprint' in body.tls), 'absent, never an empty string');
  } finally {
    srv.stop();
  }
});

test('the fingerprint rides the response but is never written to config.json', async () => {
  // It describes the running process, not the user's settings. Persisting it would put a
  // derived value in the file that seeds the next start, where it could go stale unnoticed.
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-fpcfg-'));
  const configPath = join(dir, 'config.json');
  const { srv, get } = await startTlsServer(configPath);
  try {
    const res = await get('/api/config', {
      method: 'POST',
      // Only the GET is auth-exempt; the write is not.
      headers: { 'content-type': 'application/json', authorization: 'Bearer tls-test-token' },
      body: JSON.stringify({ open: false }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.tls.fingerprint, srv.tlsFingerprint, 'the POST answer carries it too');
    const onDisk = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.ok(!('fingerprint' in onDisk.tls), 'config.json must stay free of derived state');
  } finally {
    srv.stop();
  }
});

// ── POST /api/config Content-Type guard (CSRF protection) ────────────────────

test('POST /api/config without Content-Type: application/json → 415', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-ct-'));
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [],
    port: 0,
    config: { ...defaultConfig(), auth: { token: 'tok' } },
    cacheFile: join(dir, 'agg.json'),
  });
  try {
    // Missing Content-Type simulates a text/plain form-POST (CSRF vector).
    const res = await fetch(`${srv.url}/api/config`, {
      method: 'POST',
      body: JSON.stringify({ port: 9999 }),
    });
    assert.strictEqual(res.status, 415);
  } finally {
    srv.stop();
  }
});

// A name carrying a comma would add entries to a certificate the user believes covers one name.
// Refused BEFORE the merge, because a bad value reaching config.json makes the next start throw
// from ensureTlsCert with no way out but editing the file by hand.
test('POST /api/config with a commonName that is not a hostname → 400, nothing stored', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-cnbad-'));
  const configPath = join(dir, 'config.json');
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [],
    port: 0,
    config: { ...defaultConfig(), auth: { token: 'tok' } },
    configPath,
    cacheFile: join(dir, 'agg.json'),
  });
  try {
    const res = await fetch(`${srv.url}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ open: false, tls: { commonName: 'box.local,DNS:elsewhere.test' } }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /commonName/);

    // The whole request is refused, not partially applied: `open` rode along with the bad name.
    const after = await (await fetch(`${srv.url}/api/config`)).json();
    assert.equal(after.open, true, 'a refused request must not apply its other fields');
    assert.ok(!after.tls.commonName, 'and must not store the name it refused');
  } finally {
    srv.stop();
  }
});

// ── POST /api/config partial update ─────────────────────────────────────────

test('POST /api/config partial update: changed fields are reflected in GET /api/config', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-cfg-'));
  const configPath = join(dir, 'config.json');
  const cfg = { ...defaultConfig(), auth: { token: 'tok' } };
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [],
    port: 0,
    config: { ...cfg },
    cacheFile: join(dir, 'agg.json'),
    configPath,
  });
  try {
    const postRes = await fetch(`${srv.url}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ open: false }),
    });
    assert.equal(postRes.status, 200);
    const updated = await postRes.json();
    assert.equal(updated.open, false, 'open was updated');

    // A subsequent GET reflects the merged value.
    const getRes = await (await fetch(`${srv.url}/api/config`)).json();
    assert.equal(getRes.open, false);
  } finally {
    srv.stop();
  }
});

test('POST /api/config without token on remote host → 401', async () => {
  const cfg = { ...defaultConfig(), auth: { token: 'tok-abc' } };
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [],
    port: 0,
    host: '0.0.0.0',
    ...onDisk(cfg),
    _skipTls: true,
  });
  try {
    const res = await fetch(`${srv.url}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ open: false }),
    });
    assert.equal(res.status, 401);
  } finally {
    srv.stop();
  }
});

test('POST /api/config: host change is reported as restart_pending', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-cfg-host-'));
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [],
    port: 0,
    config: { ...defaultConfig(), auth: { token: '' } },
    configPath: join(dir, 'config.json'),
    env: {},
  });
  try {
    const res = await fetch(`${srv.url}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: '0.0.0.0' }),
    });
    const body = await res.json();
    assert.equal(body.restart_pending, true, 'changing host requires restart');
  } finally {
    srv.stop();
  }
});

test('POST /api/config: open-only change does NOT set restart_pending', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-cfg-open-'));
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [],
    port: 0,
    config: { ...defaultConfig(), auth: { token: '' } },
    configPath: join(dir, 'config.json'),
    env: {},
  });
  try {
    const res = await fetch(`${srv.url}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ open: false }),
    });
    const body = await res.json();
    assert.ok(!body.restart_pending, 'open-only change should not set restart_pending');
  } finally {
    srv.stop();
  }
});

test('GET /api/config: a pending restart outlives the request that caused it', async () => {
  // The bug: `Restart required` lived in the response to the Save and nowhere else, so closing
  // the drawer lost it while the process stayed stale.
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-cfg-outlives-'));
  const configPath = join(dir, 'config.json');
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [],
    port: 0,
    config: { ...defaultConfig(), auth: { token: 'tok' } },
    configPath,
    env: {},
  });
  try {
    assert.equal((await (await fetch(`${srv.url}/api/config`)).json()).restart_pending, false, 'fresh');
    await fetch(`${srv.url}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: '0.0.0.0' }),
    });
    const later = await (await fetch(`${srv.url}/api/config`)).json();
    assert.equal(later.restart_pending, true, 'still pending on a later, unrelated GET');
  } finally {
    srv.stop();
  }
});

test('GET /api/config: a config.json edited by hand is pending', async () => {
  // The incident this ticket came from: no Save, no POST, nothing but an editor.
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-cfg-hand-'));
  const configPath = join(dir, 'config.json');
  const cfg = { ...defaultConfig(), auth: { token: 'tok' } };
  writeFileSync(configPath, JSON.stringify(cfg));
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [],
    port: 0,
    config: cfg,
    configPath,
    env: {},
  });
  try {
    assert.equal((await (await fetch(`${srv.url}/api/config`)).json()).restart_pending, false, 'fresh');
    writeFileSync(configPath, JSON.stringify({ ...cfg, host: '0.0.0.0' }));
    const after = await (await fetch(`${srv.url}/api/config`)).json();
    assert.equal(after.restart_pending, true, 'the hand edit is seen without any request having made it');
  } finally {
    srv.stop();
  }
});

test('GET /api/config: a file a CLI flag overrides is NOT pending', async () => {
  // The false positive the comparison is built to avoid. `POST /api/restart` respawns with argv
  // intact, so `--port 5555` wins again and the file's 9090 never applies: a banner here would be
  // one no button could clear.
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-cfg-flag-'));
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ ...defaultConfig(), port: 9090, auth: { token: 'tok' } }));
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [],
    port: 0,
    config: { ...defaultConfig(), port: 5555, auth: { token: 'tok' } },
    cliFlags: { port: 5555 },
    configPath,
    env: {},
  });
  try {
    const body = await (await fetch(`${srv.url}/api/config`)).json();
    assert.equal(body.restart_pending, false, 'the flag survives the restart, so nothing is pending');
  } finally {
    srv.stop();
  }
});

// ── remote host without tls.commonName → startup throws ─────────────────────

test('non-loopback host without tls.commonName → startServer throws a clear error', async () => {
  const cfg = { ...defaultConfig() }; // tls.commonName is absent
  await assert.rejects(
    () =>
      startServer({
        watcher: new EventEmitter(),
        discover: async () => [],
        port: 0,
        host: '0.0.0.0',
        config: cfg,
        // _skipTls NOT set: this is the path that enforces the commonName requirement
      }),
    /tls\.commonName/,
    'error message must mention tls.commonName',
  );
});

// ── POST /api/restart ─────────────────────────────────────────────────────────

test('POST /api/restart: responds { ok: true }, spawns self, then calls exit(0)', async () => {
  let spawned = false;
  let exitCode: number | null = null;
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [],
    port: 0,
    spawnSelf: () => {
      spawned = true;
    },
    exit: (code) => {
      exitCode = code;
    },
  });
  try {
    const res = await fetch(`${srv.url}/api/restart`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    // Both callbacks are invoked via setTimeout(80ms) — wait for them.
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(spawned, true, 'spawnSelf must be called');
    assert.equal(exitCode, 0, 'exit must be called with code 0');
  } finally {
    srv.stop();
  }
});

// The test above injects `spawnSelf`, so it can never see HOW the real one spawns — which is where
// the defect was. Windows 11 arm64, 2026-08-14: `restart` left the old server stopped and no
// replacement running, because a non-detached child dies with its parent's job object.
test('the restart successor is detached on Windows, and on Windows only', () => {
  const argv = ['/opt/seedeep', 'B:/~BUN/root/main.ts', 'serve', '--no-open', '--port', '9000'];
  const at = (platform: string) =>
    selfSpawnPlan({ argv, execPath: '/opt/seedeep', main: 'B:/~BUN/root/main.ts', fromSource: false, platform });

  assert.equal(at('win32').options.detached, true, 'without this the successor dies with its parent');
  // `setsid()` on POSIX: it would take the successor out of the terminal's session, so Ctrl-C would
  // no longer reach it. Nothing there needs the flag, so fixing Windows must not change these.
  assert.equal(at('darwin').options.detached, undefined);
  assert.equal(at('linux').options.detached, undefined);
  assert.ok(!('detached' in at('darwin').options), 'absent, not merely false');
});

test('the restart successor re-execs this binary with the flags it was given', () => {
  // argv in the compiled binary: the executable, then the bunfs entry path, then what was typed.
  const compiled = selfSpawnPlan({
    argv: ['/opt/seedeep', 'B:/~BUN/root/main.ts', 'serve', '--no-open', '--port', '9000'],
    execPath: '/opt/seedeep',
    main: 'B:/~BUN/root/main.ts',
    fromSource: false,
    platform: 'linux',
  });
  assert.deepEqual(compiled.cmd, ['/opt/seedeep', 'serve', '--no-open', '--port', '9000'], 'never the bunfs path');

  // From source the entry path IS an argument the program can be given back, and must be kept.
  const fromSource = selfSpawnPlan({
    argv: ['bun', 'main.ts', 'serve', '--port', '9000'],
    execPath: 'bun',
    main: 'main.ts',
    fromSource: true,
    platform: 'linux',
  });
  assert.deepEqual(fromSource.cmd, ['bun', 'main.ts', 'serve', '--port', '9000']);
});

test('POST /api/restart: requires auth on non-loopback host', async () => {
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [],
    port: 0,
    host: '0.0.0.0',
    config: { ...defaultConfig(), auth: { token: 'tok' }, tls: { ...defaultConfig().tls, commonName: 'test' } },
    spawnSelf: () => {},
    exit: () => {},
    _skipTls: true,
  });
  try {
    const res = await fetch(`${srv.url}/api/restart`, { method: 'POST' });
    assert.equal(res.status, 401);
  } finally {
    srv.stop();
  }
});

test('GET /api/search returns the sessions whose DIALOGUE holds every term', async () => {
  // Through the real endpoint, from real files on disk: the wire shape is what the tab reads,
  // and the index only exists to answer this request.
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-search-'));
  const line = (o: unknown) => JSON.stringify(o);
  const typed = (text: string) =>
    line({
      type: 'user',
      message: { role: 'user', content: text },
      origin: { kind: 'human' },
      promptSource: 'typed',
      timestamp: '2026-07-29T10:00:00.000Z',
      uuid: 'u1',
    });
  const said = (text: string) =>
    line({
      type: 'assistant',
      message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text }] },
      timestamp: '2026-07-29T10:01:00.000Z',
      uuid: 'u2',
    });
  writeFileSync(join(dir, 'a.jsonl'), [typed('the toast rail freezes'), said('the eviction was FIFO')].join('\n'));
  writeFileSync(join(dir, 'b.jsonl'), [typed('unrelated work on the picker')].join('\n'));
  const sessions: SessionRecord[] = ['a', 'b'].map((id) => ({
    sessionId: id,
    project: 'p',
    model: null,
    lastActivity: 2,
    isActive: false,
    isOpen: false,
    status: null,
    waitingFor: null,
    waitingSince: null,
    subject: 'do ' + id,
    entrypoint: 'cli',
    root: 'cli',
    path: join(dir, id + '.jsonl'),
  }));
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => sessions,
    port: 0,
    indexFile: join(dir, 'index.jsonl'),
  });
  try {
    const hit = await (await fetch(`${srv.url}/api/search?q=toast%20eviction`)).json();
    assert.deepEqual(hit.terms, ['toast', 'eviction']);
    assert.equal(hit.rows.length, 1);
    assert.equal(hit.rows[0].sessionId, 'a');
    assert.equal(hit.rows[0].hits, 2);
    assert.ok(hit.rows[0].chars > 0, 'the density denominator travels with the row');
    assert.ok(hit.rows[0].snippets.length >= 1);

    // One term the session lacks, and it is not a result: AND, never OR.
    const miss = await (await fetch(`${srv.url}/api/search?q=toast%20lane`)).json();
    assert.deepEqual(miss.rows, []);

    // An empty query is answered without touching the corpus.
    const empty = await (await fetch(`${srv.url}/api/search?q=%20%20`)).json();
    assert.deepEqual(empty, { terms: [], rows: [], ms: 0 });
  } finally {
    srv.stop();
  }
});

test('GET /api/search requires auth on a non-loopback host', async () => {
  // It answers with the user's own prompts — the one endpoint where a leak is the content itself.
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [],
    port: 0,
    host: '0.0.0.0',
    config: { ...defaultConfig(), auth: { token: 'tok' }, tls: { ...defaultConfig().tls, commonName: 'test' } },
    _skipTls: true,
  });
  try {
    assert.equal((await fetch(`${srv.url}/api/search?q=toast`)).status, 401);
    const ok = await fetch(`${srv.url}/api/search?q=toast`, { headers: { authorization: 'Bearer tok' } });
    assert.equal(ok.status, 200);
  } finally {
    srv.stop();
  }
});

test('GET /api/update answers the cached check, and never asks the network itself', async () => {
  let asked = 0;
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [],
    port: 0,
    updateStatus: async () => {
      asked++;
      return {
        current: '1.0.0',
        latest: '1.2.0',
        standing: 'behind' as const,
        checkedAt: '2026-08-05T12:00:00.000Z',
        reason: null,
      };
    },
    // Injected: the real one reads the path of the running executable, which under `bun test` is
    // bun's own and would report whatever channel this machine happens to look like.
    channel: { kind: 'bun', command: 'bun install -g seedeep --trust' },
  });
  try {
    const body = await (await fetch(`${srv.url}/api/update`)).json();
    // The command travels WITH the version: how this server was installed is readable only here,
    // and a client told "update it" without it is left to guess between three package managers.
    assert.deepEqual(body, {
      current: '1.0.0',
      latest: '1.2.0',
      standing: 'behind',
      checkedAt: '2026-08-05T12:00:00.000Z',
      reason: null,
      channel: 'bun',
      command: 'bun install -g seedeep --trust',
    });
    // The endpoint is a reader of the cache — the cadence lives there, not in the number of clients.
    assert.equal(asked, 1);
  } finally {
    await srv.stop();
  }
});

// The two channels with no install command are not the same case, and a client that got `null` for
// both would tell a checkout to go and replace an executable.
test('a checkout is told to pull; a downloaded file is given no command at all', async () => {
  const answer = async (channel: Channel) => {
    const srv = await startServer({
      watcher: new EventEmitter(),
      discover: async () => [],
      port: 0,
      channel,
      updateStatus: async () => ({
        current: '1.0.0',
        latest: '1.2.0',
        standing: 'behind' as const,
        checkedAt: null,
        reason: null,
      }),
    });
    try {
      return (await (await fetch(`${srv.url}/api/update`)).json()) as { channel: string; command: string | null };
    } finally {
      await srv.stop();
    }
  };

  assert.deepEqual(await answer({ kind: 'checkout', command: null }), {
    ...(await answer({ kind: 'checkout', command: null })),
    channel: 'checkout',
    command: 'git pull',
  });
  const downloaded = await answer({ kind: 'download', command: null });
  assert.equal(downloaded.channel, 'download');
  assert.equal(downloaded.command, null, 'replacing a file by hand is not a command');
});

test('GET /api/config redacts webhook headers, which is where a service token lives', async () => {
  const home = mkdtempSync(join(tmpdir(), 'seedeep-hook-'));
  const configPath = join(home, 'config.json');
  const config = defaultConfig(home);
  config.notifications.webhook.url = 'https://example.test/hook';
  config.notifications.webhook.headers = { Authorization: 'Bearer real-secret', Title: 'seedeep' };
  // On disk as well as injected: the endpoint answers with the CONFIGURATION, which lives in the
  // file — a server whose file says something else is the case the pending signal is for, not the
  // case this test is about.
  writeFileSync(configPath, JSON.stringify(config));
  const srv = await startServer({ watcher: new EventEmitter(), discover: async () => [], port: 0, config, configPath });
  try {
    // This endpoint answers WITHOUT auth, by design — the version has to be readable before a token
    // exists. Anything secret behind it has to be redacted, exactly as `auth.token` already is.
    const body = (await (await fetch(`${srv.url}/api/config`)).json()) as {
      notifications: { webhook: { url: string; headers: Record<string, string> } };
    };
    // The URL IS a secret: for Slack, Discord and ntfy it is the whole credential, and this
    // endpoint answers without auth. It says only whether one is configured.
    assert.equal(body.notifications.webhook.url, '***');
    assert.deepEqual(body.notifications.webhook.headers, { Authorization: '***', Title: '***' });
  } finally {
    await srv.stop();
  }
});

test('POST /api/config keeps a stored header when the panel sends back the redacted value', async () => {
  const home = mkdtempSync(join(tmpdir(), 'seedeep-hook-'));
  const configPath = join(home, 'config.json');
  const config = defaultConfig(home);
  config.notifications.webhook.headers = { Authorization: 'Bearer real-secret' };
  // The file is what a save merges onto, so the secret has to be in it — that is where it lives on
  // a real machine, and where the panel read the `***` from.
  writeFileSync(configPath, JSON.stringify(config));
  const srv = await startServer({ watcher: new EventEmitter(), discover: async () => [], port: 0, config, configPath });
  try {
    // The panel GETs `***` and POSTs the whole object back. Taking that literally would erase the
    // secret on the first save the user makes for any other reason.
    await fetch(`${srv.url}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        notifications: { webhook: { headers: { Authorization: '***' }, url: 'https://new.test/h' } },
      }),
    });
    const written = JSON.parse(readFileSync(configPath, 'utf8')) as {
      notifications: { webhook: { url: string; headers: Record<string, string> } };
    };
    assert.equal(written.notifications.webhook.headers['Authorization'], 'Bearer real-secret');
    assert.equal(written.notifications.webhook.url, 'https://new.test/h', 'the rest of the POST still applied');
  } finally {
    await srv.stop();
  }
});

test('POST /api/config does not undo a hand edit it never mentioned', async () => {
  // Measured before the fix: a save of `open` alone put `host` back to what the process was bound
  // to, silently discarding an edit made in an editor. The panel is an editor of the FILE, so a
  // save merges onto the file — not onto the copy this process happens to be holding.
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-cfg-merge-'));
  const configPath = join(dir, 'config.json');
  const config = { ...defaultConfig(), auth: { token: 'tok' } };
  writeFileSync(configPath, JSON.stringify(config));
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [],
    port: 0,
    config,
    configPath,
    env: {},
  });
  try {
    writeFileSync(configPath, JSON.stringify({ ...config, host: '0.0.0.0' }));
    await fetch(`${srv.url}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ open: false }),
    });
    const written = JSON.parse(readFileSync(configPath, 'utf8')) as { host: string; open: boolean };
    assert.equal(written.host, '0.0.0.0', 'the hand edit survived a save that never mentioned host');
    assert.equal(written.open, false, 'and the save still applied');
  } finally {
    srv.stop();
  }
});

test('GET /api/config answers with the file, so the panel edits what it shows', async () => {
  // The other half of the same rule: showing the running value put a stale number in the field the
  // next save would write back.
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-cfg-shows-'));
  const configPath = join(dir, 'config.json');
  const config = { ...defaultConfig(), auth: { token: 'tok' } };
  writeFileSync(configPath, JSON.stringify(config));
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [],
    port: 0,
    config,
    configPath,
    env: {},
  });
  try {
    writeFileSync(configPath, JSON.stringify({ ...config, host: '0.0.0.0' }));
    const body = await (await fetch(`${srv.url}/api/config`)).json();
    assert.equal(body.host, '0.0.0.0', 'the field shows what a restart would apply');
    assert.equal(body.restart_pending, true, 'and says the process is not on it yet');
    assert.equal(body.version, VERSION, 'while the version stays the process’s own');
  } finally {
    srv.stop();
  }
});

test('GET /api/config: a CLI flag wins over the file in what the panel shows', async () => {
  // Never the raw file: a port pinned by `--port` is what the panel must show, because it is what
  // this server runs and what every restart will keep running. Showing 9090 there would offer an
  // edit to a value that has no effect.
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-cfg-flagshow-'));
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ ...defaultConfig(), port: 9090, auth: { token: 'tok' } }));
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [],
    port: 0,
    config: { ...defaultConfig(), port: 5555, auth: { token: 'tok' } },
    cliFlags: { port: 5555 },
    configPath,
    env: {},
  });
  try {
    const body = await (await fetch(`${srv.url}/api/config`)).json();
    assert.equal(body.port, 5555, 'the flag, not the file');
    assert.equal(body.restart_pending, false, 'and nothing pending, because a restart keeps it');
  } finally {
    srv.stop();
  }
});

test('POST /api/config repairs a malformed file instead of emptying it', async () => {
  // Found in review, reproduced against a real server: with the file merged onto BLINDLY, a stray
  // comma in config.json turned the next save — a toggle, made for another reason entirely — into
  // a rewrite with built-in defaults, discarding the auth token, the port and the certificate name.
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-cfg-broken-'));
  const configPath = join(dir, 'config.json');
  const config = {
    ...defaultConfig(),
    port: 9101,
    auth: { token: 'real-secret-token' },
    tls: { ...defaultConfig().tls, commonName: 'box.local' },
  };
  writeFileSync(configPath, JSON.stringify(config));
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [],
    port: 0,
    config,
    configPath,
    env: {},
  });
  try {
    writeFileSync(configPath, '{ "port": 9101, "host": "0.0.0.0",'); // an editor, mid-edit
    await fetch(`${srv.url}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ open: false }),
    });
    const written = JSON.parse(readFileSync(configPath, 'utf8')) as typeof config;
    assert.equal(written.auth.token, 'real-secret-token', 'the token survived');
    assert.equal(written.port, 9101, 'the port survived');
    assert.equal(written.tls.commonName, 'box.local', 'the certificate name survived');
    assert.equal(written.open, false, 'and the save applied');
  } finally {
    srv.stop();
  }
});

test('GET /api/config answers with what is running when the file cannot be read', async () => {
  // Never the defaults: they are settings nobody chose, and pairing them with a pending state
  // would invite a restart INTO them.
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-cfg-broken-get-'));
  const configPath = join(dir, 'config.json');
  const config = { ...defaultConfig(), port: 9101, auth: { token: 'tok' } };
  writeFileSync(configPath, JSON.stringify(config));
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [],
    port: 0,
    config,
    configPath,
    env: {},
  });
  try {
    writeFileSync(configPath, 'not json at all');
    const body = await (await fetch(`${srv.url}/api/config`)).json();
    assert.equal(body.port, 9101, 'what the process is running, not a built-in');
    assert.equal(body.restart_pending, false, 'and nothing to restart into');
  } finally {
    srv.stop();
  }
});

test('GET /api/config: a token edited by hand asks for a restart, not a save', async () => {
  // Found by driving the button, not by reading the code: a save cannot carry a token the panel
  // never sees — it reads it redacted — so `Apply now` left the state exactly where it was. A
  // restart is what applies a token written straight into the file.
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-cfg-savep-'));
  const configPath = join(dir, 'config.json');
  const config = { ...defaultConfig(), auth: { token: 'old-token' } };
  writeFileSync(configPath, JSON.stringify(config));
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [],
    port: 0,
    config,
    configPath,
    env: {},
  });
  try {
    writeFileSync(configPath, JSON.stringify({ ...config, auth: { token: 'rotated-by-hand' } }));
    const body = await (await fetch(`${srv.url}/api/config`)).json();
    assert.equal(body.restart_pending, true, 'a restart applies it');
    assert.equal(body.save_pending, false, 'and a save cannot');

    // A token the PANEL generates is adopted live, so it must NOT ask for a restart.
    await fetch(`${srv.url}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ auth: { token: 'rotated-by-panel' } }),
    });
    const after = await (await fetch(`${srv.url}/api/config`)).json();
    assert.equal(after.restart_pending, false, 'a rotation from the panel needs no restart');
  } finally {
    srv.stop();
  }
});

test('GET /api/config: notification switches edited by hand are save_pending', async () => {
  // The one kind of change the panel really can re-post: the switches are in the form.
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-cfg-switch-'));
  const configPath = join(dir, 'config.json');
  const config = { ...defaultConfig(), auth: { token: 'tok' } };
  writeFileSync(configPath, JSON.stringify(config));
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [],
    port: 0,
    config,
    configPath,
    env: {},
  });
  try {
    const edited = {
      ...config,
      notifications: { ...config.notifications, tray: { ...config.notifications.tray, finishes: true } },
    };
    writeFileSync(configPath, JSON.stringify(edited));
    const body = await (await fetch(`${srv.url}/api/config`)).json();
    assert.equal(body.save_pending, true, 'a save applies it');
    assert.equal(body.restart_pending, false, 'a restart is not the cure named');

    await fetch(`${srv.url}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ notifications: { tray: edited.notifications.tray } }),
    });
    assert.equal((await (await fetch(`${srv.url}/api/config`)).json()).save_pending, false, 'and clears it');
  } finally {
    srv.stop();
  }
});

test('GET /api/config names the fields a flag is overriding', async () => {
  // Without it, a user edits the port, sees "Saved", and watches the field snap back on the next
  // open with nothing on screen explaining why.
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-cfg-ov-'));
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ ...defaultConfig(), port: 9090, auth: { token: 'tok' } }));
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [],
    port: 0,
    config: { ...defaultConfig(), port: 5555, auth: { token: 'tok' } },
    cliFlags: { port: 5555 },
    configPath,
    env: {},
  });
  try {
    const body = await (await fetch(`${srv.url}/api/config`)).json();
    assert.deepEqual(body.overrides, { port: 'flag' });
  } finally {
    srv.stop();
  }
});

test('POST /api/config keeps the token and the webhook when config.json is MISSING', async () => {
  // Found in review, reproduced against a real server: deleting the file under a running server —
  // a plausible "reset my settings" — then toggling anything wrote `token: ""` and an empty
  // webhook. The next start would mint a new token and lock out every pinned client.
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-cfg-gone-'));
  const configPath = join(dir, 'config.json');
  const config = {
    ...defaultConfig(),
    auth: { token: 'real-token' },
    notifications: {
      ...defaultConfig().notifications,
      webhook: {
        ...defaultConfig().notifications.webhook,
        url: 'https://hooks.example.test/abc',
        headers: { Authorization: 'Bearer s3cret' },
      },
    },
  };
  writeFileSync(configPath, JSON.stringify(config));
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [],
    port: 0,
    config,
    configPath,
    env: {},
  });
  try {
    rmSync(configPath);
    await fetch(`${srv.url}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ open: false }),
    });
    const written = JSON.parse(readFileSync(configPath, 'utf8')) as typeof config;
    assert.equal(written.auth.token, 'real-token', 'the token survived');
    assert.equal(written.notifications.webhook.url, 'https://hooks.example.test/abc', 'the webhook survived');
    assert.deepEqual(written.notifications.webhook.headers, { Authorization: 'Bearer s3cret' }, 'and its headers');
  } finally {
    srv.stop();
  }
});

test('a hand-edited webhook URL asks for a restart, so the signal can be cleared', async () => {
  // It was `save_pending`, and the panel posts the URL redacted — so `Apply now` resolved `***`
  // back to the running value and left the two sides exactly as divergent. The banner and the
  // header dot stayed up with no action on any surface that could clear them.
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-cfg-hookurl-'));
  const configPath = join(dir, 'config.json');
  const config = {
    ...defaultConfig(),
    auth: { token: 'tok' },
    notifications: {
      ...defaultConfig().notifications,
      webhook: { ...defaultConfig().notifications.webhook, url: 'https://old.example.test/a' },
    },
  };
  writeFileSync(configPath, JSON.stringify(config));
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [],
    port: 0,
    config,
    configPath,
    env: {},
  });
  try {
    writeFileSync(
      configPath,
      JSON.stringify({
        ...config,
        notifications: {
          ...config.notifications,
          webhook: { ...config.notifications.webhook, url: 'https://new.example.test/b' },
        },
      }),
    );
    const body = await (await fetch(`${srv.url}/api/config`)).json();
    assert.equal(body.restart_pending, true, 'a restart applies it');
    assert.equal(body.save_pending, false, 'a save cannot, so it must not be named');
  } finally {
    srv.stop();
  }
});

// The successor's first act is to bind the port, and the handover used to spawn it while this
// process still held the socket — it won only by being slower to boot than the parent was to die.
// On Windows that margin is not there: measured 2026-08-15, the successor reached
// `Failed to start server. Is port 44842 in use?` and exited, so `restart` left the old server
// stopped and no new one. Asserted as the property rather than the call order: at the instant the
// successor is spawned, the port is free.
test('POST /api/restart frees the port before it spawns the successor', async () => {
  let rebound: boolean | null = null;
  let port = 0;
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [],
    port: 0,
    spawnSelf: () => {
      try {
        Bun.serve({ port, hostname: '127.0.0.1', fetch: () => new Response('') }).stop(true);
        rebound = true;
      } catch {
        rebound = false;
      }
    },
    exit: () => {},
  });
  port = Number(new URL(srv.url).port);
  try {
    assert.equal((await fetch(`${srv.url}/api/restart`, { method: 'POST' })).status, 200);
    // Both callbacks run on the same 80 ms timer the handler sets.
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(rebound, true, 'the successor could not have bound the port it was spawned for');
  } finally {
    srv.stop();
  }
});
