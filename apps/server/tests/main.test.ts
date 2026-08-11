import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { defaultConfig, readConfigStrict, resolveConfig } from '../src/server/config.ts';
import { run } from '../src/server/main.ts';

function fakeDeps(overrides = {}) {
  const watcher = Object.assign(new EventEmitter(), {
    started: false,
    stopped: false,
    start() {
      this.started = true;
    },
    stop() {
      this.stopped = true;
    },
  });
  const opened: string[] = [];
  const deps = {
    watcher,
    startServer: async (_d: unknown) => ({
      url: 'http://localhost:44842',
      openUrl: 'http://localhost:44842',
      tlsFingerprint: null,
      tlsCertOrigin: null,
      stop() {
        (deps as Record<string, unknown>)['serverStopped'] = true;
      },
    }),
    discover: async () => [],
    openBrowser: (url: string) => opened.push(url),
    // Pre-resolved config: skips file I/O in run() and is immune to the real user's settings.
    config: defaultConfig(),
    ...overrides,
  };
  return { deps, watcher, opened };
}

test('run starts the watcher and opens the browser by default', async () => {
  const { deps, watcher, opened } = fakeDeps();
  const app = await run([], deps as Parameters<typeof run>[1]);
  assert.equal(watcher.started, true);
  assert.deepEqual(opened, ['http://localhost:44842']);
  app.stop();
  assert.equal(watcher.stopped, true);
});

test('--no-open does not open the browser', async () => {
  const { deps, opened } = fakeDeps();
  const app = await run(['--no-open'], deps as Parameters<typeof run>[1]);
  assert.deepEqual(opened, []);
  app.stop();
});

/** Run with `console.log` captured, so what the CLI actually tells the user can be asserted. */
async function linesPrintedBy(
  tlsFingerprint: string | null,
  tlsCertOrigin: 'reused' | 'created' | 'replaced' | null = tlsFingerprint ? 'reused' : null,
): Promise<string[]> {
  const base = defaultConfig();
  const { deps } = fakeDeps({
    config: { ...base, tls: { ...base.tls, commonName: 'printed-name.local' } },
    startServer: async (_d: unknown) => ({
      url: 'http://localhost:44842',
      openUrl: 'http://localhost:44842',
      tlsFingerprint,
      tlsCertOrigin,
      stop() {},
    }),
  });
  const lines: string[] = [];
  const real = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.join(' '));
  };
  try {
    const app = await run(['--no-open'], deps as Parameters<typeof run>[1]);
    app.stop();
  } finally {
    console.log = real;
  }
  return lines;
}

// The certificate a client pins is only checkable if the value is on screen when the client is
// set up — which is every start, not just the one that generated the file.
test('a TLS server prints its certificate fingerprint on start', async () => {
  const lines = await linesPrintedBy('AA:BB:CC');
  assert.ok(
    lines.some((l) => l.includes('AA:BB:CC')),
    `fingerprint not printed: ${lines.join(' | ')}`,
  );
});

test('a loopback server prints no fingerprint — it presents no certificate', async () => {
  const lines = await linesPrintedBy(null);
  assert.ok(!lines.some((l) => l.toLowerCase().includes('fingerprint')), lines.join(' | '));
});

// A replacement is the one moment a pinned client stops working, and the new fingerprint alone
// cannot say so — the user has no old value on screen to notice the difference against.
test('a replaced certificate is announced, and before the new fingerprint', async () => {
  const lines = await linesPrintedBy('AA:BB:CC', 'replaced');
  const warned = lines.findIndex((l) => l.includes('re-pinned'));
  const printed = lines.findIndex((l) => l.includes('AA:BB:CC'));
  assert.ok(warned >= 0, `no warning printed: ${lines.join(' | ')}`);
  assert.ok(warned < printed, 'the warning must precede the value it is about');
  // The name it did not cover, because "a certificate" is not actionable and the user may have
  // just mistyped the field.
  assert.match(lines[warned]!, /printed-name\.local/);
});

// Reuse is the normal case and says nothing extra: a warning on every start is a warning nobody
// reads by the third one.
test('a reused certificate is not announced as replaced', async () => {
  const lines = await linesPrintedBy('AA:BB:CC', 'reused');
  assert.ok(!lines.some((l) => l.includes('re-pinned')), lines.join(' | '));
});

test('a malformed config.json is never written over — not by a start, not by a subcommand', async () => {
  // The half the POST-side guard does not reach: `resolveConfig` generated a token and persisted
  // it, so a stray comma cost the port, the token and the certificate name before any request had
  // been made. Reproduced against a real start before the fix.
  const home = mkdtempSync(join(tmpdir(), 'seedeep-main-broken-'));
  const path = join(home, 'config.json');
  const broken = '{ "port": 9090, "auth": { "token": "real-token" },\n';
  writeFileSync(path, broken);
  const cfg = await readConfigStrict(path, home).then(
    () => null,
    (e: Error) => e,
  );
  assert.ok(cfg instanceof Error, 'pre-condition: strict reading rejects it');

  // `fileIsUsable: false` is what every entry point passes on that rejection.
  const resolved = await resolveConfig({}, {}, defaultConfig(home), path, false);
  assert.ok(resolved.auth.token.length > 0, 'this run still gets a token');
  assert.equal(readFileSync(path, 'utf8'), broken, 'and the file is exactly as the user left it');
});
