import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { mergeRoster } from '../src/core/roster.ts';
import type { SessionRecord } from '../src/core/types.ts';
import { defaultConfig } from '../src/server/config.ts';
import { isLoopback, parseMarks, startServer } from '../src/server/server.ts';
import type { Channel } from '../src/server/update-cmd.ts';
import { VERSION } from '../src/server/version.ts';

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
    config: cfg,
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
    config: cfg,
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
    config: cfg,
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
    config: cfg,
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
    config: cfg,
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
    config: cfg,
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
    config: defaultConfig(),
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
    config: cfg,
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
    config: defaultConfig(),
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
    config: cfg,
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
    config: defaultConfig(),
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
    config: cfg,
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

test('POST /api/config: host change is reported as restart_required', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-cfg-host-'));
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [],
    port: 0,
    config: { ...defaultConfig(), auth: { token: '' } },
    configPath: join(dir, 'config.json'),
  });
  try {
    const res = await fetch(`${srv.url}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: '0.0.0.0' }),
    });
    const body = await res.json();
    assert.equal(body.restart_required, true, 'changing host requires restart');
  } finally {
    srv.stop();
  }
});

test('POST /api/config: open-only change does NOT set restart_required', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-cfg-open-'));
  const srv = await startServer({
    watcher: new EventEmitter(),
    discover: async () => [],
    port: 0,
    config: { ...defaultConfig(), auth: { token: '' } },
    configPath: join(dir, 'config.json'),
  });
  try {
    const res = await fetch(`${srv.url}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ open: false }),
    });
    const body = await res.json();
    assert.ok(!body.restart_required, 'open-only change should not set restart_required');
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
