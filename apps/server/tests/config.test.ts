import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { defaultCacheFile } from '../src/server/aggregate-cache.ts';
import { defaultCardsIndexFile } from '../src/server/cards-index.ts';
import {
  applyPrecedence,
  configFilePath,
  defaultConfig,
  overriddenFields,
  readConfig,
  resolveConfig,
  restartPending,
  savePending,
  seedDeepDir,
  writeConfig,
} from '../src/server/config.ts';
import { defaultIndexFile } from '../src/server/search-index.ts';

// All paths in this file use mkdtempSync-generated directories — never real home paths —
// so the pre-commit hook cannot match them.

// This file asserts the DEFAULT layout, so it must not inherit a real override: a contributor who
// exported SEEDEEP_HOME to run a dev server beside an installed one would otherwise watch the suite
// go red for a reason that has nothing to do with their change.
delete process.env['SEEDEEP_HOME'];

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), 'seedeep-cfg-'));
}

// ── defaultConfig ────────────────────────────────────────────────────────────

test('defaultConfig uses port 44842, host 127.0.0.1, open true', () => {
  const cfg = defaultConfig('/tmp/alice');
  assert.equal(cfg.port, 44842);
  assert.equal(cfg.host, '127.0.0.1');
  assert.equal(cfg.open, true);
});

test('defaultConfig places cert and key under seedDeepDir', () => {
  const home = '/tmp/carol';
  const cfg = defaultConfig(home);
  assert.equal(cfg.tls.cert, join(seedDeepDir(home), 'cert.pem'));
  assert.equal(cfg.tls.key, join(seedDeepDir(home), 'key.pem'));
});

test('seedDeepDir returns ~/.seedeep/', () => {
  assert.equal(seedDeepDir('/tmp/bob'), '/tmp/bob/.seedeep');
});

test('configFilePath returns ~/.seedeep/config.json', () => {
  assert.equal(configFilePath('/tmp/bob'), '/tmp/bob/.seedeep/config.json');
});

// ── SEEDEEP_HOME ─────────────────────────────────────────────────────────────

// What the variable is FOR: a checkout running beside an installed release. Half a relocation would
// be worse than none — a dev run whose config moved but whose caches did not would still rewrite
// the installed server's index, and the symptom (a corpus rebuilt on every start) names nothing.
test('SEEDEEP_HOME moves everything seedeep owns, not only the config', () => {
  const home = '/tmp/bob';
  const dev = '/tmp/alice/dev-state';
  process.env['SEEDEEP_HOME'] = dev;
  try {
    assert.equal(seedDeepDir(home), dev);
    assert.equal(configFilePath(home), join(dev, 'config.json'));
    assert.equal(defaultConfig(home).tls.cert, join(dev, 'cert.pem'));
    assert.equal(defaultConfig(home).tls.key, join(dev, 'key.pem'));
    assert.equal(defaultCacheFile(home), join(dev, 'aggregates.json'));
    assert.equal(defaultIndexFile(home), join(dev, 'search-index.jsonl'));
    assert.equal(defaultCardsIndexFile(home), join(dev, 'cards-index.jsonl'));
  } finally {
    delete process.env['SEEDEEP_HOME'];
  }
});

// A dev script points it inside the checkout, and the server's cwd is not the shell's — a relative
// value read literally would scatter state wherever the process happened to start.
test('a relative SEEDEEP_HOME becomes an absolute path', () => {
  assert.equal(seedDeepDir('/tmp/bob', { SEEDEEP_HOME: '.seedeep-dev' }), resolve('.seedeep-dev'));
});

// The invariant behind the test above, stated where it can catch the NEXT cache: `seedDeepDir` is
// the only code that knows the directory's name, so relocating it cannot be done by halves.
test('only config.ts names the directory', () => {
  const dir = fileURLToPath(new URL('../src/server/', import.meta.url));
  const offenders = readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && f !== 'config.ts')
    .filter((f) => readFileSync(join(dir, f), 'utf8').includes("'.seedeep'"));
  assert.deepEqual(offenders, [], 'these build the path themselves instead of calling seedDeepDir');
});

// ── readConfig ───────────────────────────────────────────────────────────────

test('readConfig: missing file returns built-in defaults (no crash)', async () => {
  const home = tmpHome();
  const cfg = await readConfig(join(home, '.seedeep', 'config.json'), home);
  assert.deepEqual(cfg, defaultConfig(home));
});

test('readConfig: malformed JSON returns defaults without crashing or rewriting', async () => {
  const home = tmpHome();
  const path = configFilePath(home);
  mkdtempSync(join(tmpdir(), 'x')); // ensure tmpdir is writable
  const dir = join(home, '.seedeep');
  require('node:fs').mkdirSync(dir, { recursive: true });
  writeFileSync(path, '{ invalid json !!!');
  const cfg = await readConfig(path, home);
  assert.deepEqual(cfg, defaultConfig(home));
  // The file must NOT have been rewritten (fall-back is silent, not a reset).
  assert.equal(readFileSync(path, 'utf8'), '{ invalid json !!!');
});

test('readConfig: unknown keys from a newer version are preserved', async () => {
  const home = tmpHome();
  const path = configFilePath(home);
  require('node:fs').mkdirSync(join(home, '.seedeep'), { recursive: true });
  writeFileSync(path, JSON.stringify({ port: 9000, futureField: 'preserved', nested: { x: 1 } }));
  const cfg = await (readConfig(path, home) as unknown as Promise<Record<string, unknown>>);
  assert.equal((cfg as { port: number }).port, 9000);
  assert.equal((cfg as { futureField: string }).futureField, 'preserved');
  assert.deepEqual((cfg as { nested: object }).nested, { x: 1 });
});

test('readConfig + writeConfig round-trip: values survive the cycle', async () => {
  const home = tmpHome();
  const path = configFilePath(home);
  const original = {
    ...defaultConfig(home),
    port: 8080,
    host: '0.0.0.0',
    open: false,
    auth: { token: 'round-trip-token' },
    tls: { ...defaultConfig(home).tls, commonName: 'test.local' },
  };
  await writeConfig(original, path);
  const restored = await readConfig(path, home);
  assert.equal(restored.port, 8080);
  assert.equal(restored.host, '0.0.0.0');
  assert.equal(restored.open, false);
  assert.equal(restored.auth.token, 'round-trip-token');
  assert.equal(restored.tls.commonName, 'test.local');
});

// ── writeConfig ──────────────────────────────────────────────────────────────

test('writeConfig sets permissions to 0600', async () => {
  const home = tmpHome();
  const path = configFilePath(home);
  await writeConfig(defaultConfig(home), path);
  const mode = statSync(path).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('writeConfig creates parent directory if absent', async () => {
  const home = tmpHome();
  const path = configFilePath(home);
  assert.ok(!existsSync(join(home, '.seedeep')), 'pre-condition: dir absent');
  await writeConfig(defaultConfig(home), path);
  assert.ok(existsSync(path));
});

test('writeConfig is atomic: temp file + rename (no half-written file on crash)', async () => {
  // We cannot simulate a mid-write crash, but we can verify no .tmp file is left.
  const home = tmpHome();
  const path = configFilePath(home);
  await writeConfig(defaultConfig(home), path);
  assert.ok(!existsSync(`${path}.tmp`), 'temp file must not remain after write');
});

// ── resolveConfig ────────────────────────────────────────────────────────────

test('resolveConfig: built-in defaults apply when nothing else is set', async () => {
  const home = tmpHome();
  const defs = defaultConfig(home);
  defs.auth.token = 'preset-token'; // avoid triggering token generation + file write
  const cfg = await resolveConfig({}, {}, defs);
  assert.equal(cfg.port, 44842);
  assert.equal(cfg.host, '127.0.0.1');
  assert.equal(cfg.open, true);
});

test('resolveConfig: file values override built-in defaults', async () => {
  const home = tmpHome();
  const fileConfig = { ...defaultConfig(home), port: 9090, host: '10.0.0.1', auth: { token: 'file-tok' } };
  const cfg = await resolveConfig({}, {}, fileConfig);
  assert.equal(cfg.port, 9090);
  assert.equal(cfg.host, '10.0.0.1');
});

test('resolveConfig: env vars override file values', async () => {
  const home = tmpHome();
  const fileConfig = { ...defaultConfig(home), port: 9090, auth: { token: 'file-tok' } };
  const cfg = await resolveConfig({}, { SEEDEEP_PORT: '7070', SEEDEEP_HOST: '172.16.0.1' }, fileConfig);
  assert.equal(cfg.port, 7070);
  assert.equal(cfg.host, '172.16.0.1');
});

test('resolveConfig: CLI flags override env vars', async () => {
  const home = tmpHome();
  const fileConfig = { ...defaultConfig(home), auth: { token: 'tok' } };
  const cfg = await resolveConfig(
    { port: 5555, host: '192.168.1.1' },
    { SEEDEEP_PORT: '7070', SEEDEEP_HOST: '172.16.0.1' },
    fileConfig,
  );
  assert.equal(cfg.port, 5555);
  assert.equal(cfg.host, '192.168.1.1');
});

test('resolveConfig: SEEDEEP_OPEN=false disables open', async () => {
  const home = tmpHome();
  const fileConfig = { ...defaultConfig(home), auth: { token: 'tok' } };
  const cfg = await resolveConfig({}, { SEEDEEP_OPEN: 'false' }, fileConfig);
  assert.equal(cfg.open, false);
});

test('resolveConfig: CLI open:false overrides env SEEDEEP_OPEN=1', async () => {
  const home = tmpHome();
  const fileConfig = { ...defaultConfig(home), auth: { token: 'tok' } };
  const cfg = await resolveConfig({ open: false }, { SEEDEEP_OPEN: '1' }, fileConfig);
  assert.equal(cfg.open, false);
});

test('resolveConfig: generates a token when absent and writes it', async () => {
  const home = tmpHome();
  const path = configFilePath(home);
  const fileConfig = defaultConfig(home); // auth.token is ''
  const cfg = await resolveConfig({}, {}, fileConfig, path);
  assert.ok(cfg.auth.token.length > 0, 'token must be generated');
  // Verify the token was written to the config file.
  assert.ok(existsSync(path), 'config file must exist after token generation');
  const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { auth: { token: string } };
  assert.equal(onDisk.auth.token, cfg.auth.token, 'persisted token must match resolved token');
});

test('resolveConfig: does not regenerate a non-empty token', async () => {
  const home = tmpHome();
  const fileConfig = { ...defaultConfig(home), auth: { token: 'already-set' } };
  const cfg = await resolveConfig({}, {}, fileConfig);
  assert.equal(cfg.auth.token, 'already-set');
});

test('resolveConfig: SEEDEEP_TLS_CN sets tls.commonName', async () => {
  const home = tmpHome();
  const fileConfig = { ...defaultConfig(home), auth: { token: 'tok' } };
  const cfg = await resolveConfig({}, { SEEDEEP_TLS_CN: 'my.server.local' }, fileConfig);
  assert.equal(cfg.tls.commonName, 'my.server.local');
});

test('defaultConfig ships notifications with the webhook off', () => {
  const c = defaultConfig(tmpHome());
  // These mirror what the tray shipped when the switches were local state. Changing a default
  // changes what the user sees, which is not this change's to make.
  assert.deepEqual(c.notifications.tray, { needsYou: true, fails: true, finishes: false, updates: true });
  assert.equal(c.notifications.webhook.url, '');
  assert.deepEqual(c.notifications.webhook.headers, {});
});

test('readConfig fills notifications when the file predates them', async () => {
  const home = tmpHome();
  const path = join(home, 'config.json');
  writeFileSync(path, JSON.stringify({ port: 4571, host: '127.0.0.1' }));
  const c = await readConfig(path, home);
  assert.equal(c.notifications.tray.needsYou, true);
  assert.equal(c.notifications.webhook.url, '');
});

test('readConfig merges notifications per key, so a partial file keeps the other defaults', async () => {
  const home = tmpHome();
  const path = join(home, 'config.json');
  // A user who set only the webhook URL must not lose their tray switches — the failure the
  // whole-object replace would cause, and the reason `auth` and `tls` are merged the same way.
  writeFileSync(path, JSON.stringify({ notifications: { webhook: { url: 'https://example.test/hook' } } }));
  const c = await readConfig(path, home);
  assert.equal(c.notifications.webhook.url, 'https://example.test/hook');
  assert.equal(c.notifications.webhook.needsYou, true, 'a webhook switch kept its default');
  assert.equal(c.notifications.tray.needsYou, true, 'the tray channel survived a webhook-only file');
  assert.deepEqual(c.notifications.webhook.headers, {});
});

// ── applyPrecedence / restartPending ─────────────────────────────────────────

test('applyPrecedence neither generates a token nor writes the file', async () => {
  const home = tmpHome();
  const path = configFilePath(home);
  const fileConfig = defaultConfig(home); // auth.token is ''
  const cfg = applyPrecedence({}, {}, fileConfig);
  // A GET that asks "what would a start resolve to?" must be free of every side effect a start
  // has — otherwise reading the pending state would itself rewrite config.json.
  assert.equal(cfg.auth.token, '', 'no token generated');
  assert.ok(!existsSync(path), 'no file written');
});

test('restartPending: a port, host or common-name difference is pending', () => {
  const home = tmpHome();
  const base = { ...defaultConfig(home), auth: { token: 'tok' } };
  assert.equal(restartPending(base, { ...base, port: 9090 }), true, 'port');
  assert.equal(restartPending(base, { ...base, host: '0.0.0.0' }), true, 'host');
  assert.equal(restartPending(base, { ...base, tls: { ...base.tls, commonName: 'box.local' } }), true, 'common name');
});

test('restartPending: open and the cert paths are not pending', () => {
  const home = tmpHome();
  const base = { ...defaultConfig(home), auth: { token: 'tok' } };
  // A running process can honour both without being replaced, and announcing them would train the
  // user to ignore the announcement. The token is NOT among them — see the token test below.
  assert.equal(restartPending(base, { ...base, open: !base.open }), false, 'open');
  assert.equal(
    restartPending(base, { ...base, tls: { ...base.tls, cert: '/elsewhere/cert.pem' } }),
    false,
    'cert path',
  );
});

test('restartPending: an absent common name equals an empty one', () => {
  const home = tmpHome();
  const base = { ...defaultConfig(home), auth: { token: 'tok' } };
  const empty = { ...base, tls: { ...base.tls, commonName: '' } };
  assert.equal(restartPending(base, empty), false, 'neither can go in a certificate');
});

test('restartPending: a CLI flag the restart would keep is NOT pending', () => {
  // The regression this whole comparison exists for. A server started with `--port 5555` against
  // a file that says 9090 is not stale: `POST /api/restart` respawns with argv intact, so the
  // flag wins again and the file never applies. Comparing the running port against the FILE
  // would light a pending state that no button on any surface could ever clear.
  const home = tmpHome();
  const file = { ...defaultConfig(home), port: 9090, auth: { token: 'tok' } };
  const running = applyPrecedence({ port: 5555 }, {}, file);
  assert.equal(running.port, 5555);
  assert.equal(restartPending(running, applyPrecedence({ port: 5555 }, {}, file)), false);
});

test('restartPending: an env var the restart would keep is NOT pending', () => {
  const home = tmpHome();
  const env = { SEEDEEP_HOST: '10.0.0.9' };
  const file = { ...defaultConfig(home), host: '0.0.0.0', auth: { token: 'tok' } };
  const running = applyPrecedence({}, env, file);
  assert.equal(running.host, '10.0.0.9');
  assert.equal(restartPending(running, applyPrecedence({}, env, file)), false);
});

test('restartPending: a hand edit to a field no flag covers IS pending', () => {
  // The incident: config.json edited to 0.0.0.0 while the process kept answering on loopback.
  const home = tmpHome();
  const file = { ...defaultConfig(home), auth: { token: 'tok' } };
  const running = applyPrecedence({ port: 5555 }, {}, file);
  // Only the host differs: the port is pinned by the same flag on both sides, so a difference
  // here can come from nothing but the edit.
  const edited = { ...file, host: '0.0.0.0' };
  assert.equal(restartPending(running, applyPrecedence({ port: 5555 }, {}, edited)), true);
});

// ── savePending / overriddenFields ───────────────────────────────────────────

test('savePending: a switch the process has not taken up', () => {
  const home = tmpHome();
  const running = { ...defaultConfig(home), auth: { token: 'old' } };
  // The token is deliberately NOT here: the panel reads it redacted, so a save cannot carry one
  // edited into the file. That is `restartPending`'s.
  assert.equal(savePending(running, { ...running, auth: { token: 'new' } }), false, 'token');
  const switched = {
    ...running,
    notifications: { ...running.notifications, tray: { ...running.notifications.tray, finishes: true } },
  };
  assert.equal(savePending(running, switched), true, 'a notification switch');
  assert.equal(savePending(running, { ...running }), false, 'nothing to apply');
});

test('savePending: the fields a restart cures are not its business', () => {
  // The two states name different cures, and naming the wrong one is worse than naming none.
  const home = tmpHome();
  const running = { ...defaultConfig(home), auth: { token: 'tok' } };
  assert.equal(savePending(running, { ...running, port: 9090, host: '0.0.0.0' }), false);
});

test('overriddenFields: only what a flag or a variable actually changes', () => {
  const home = tmpHome();
  const file = { ...defaultConfig(home), port: 9090, host: '10.0.0.1', auth: { token: 'tok' } };
  assert.deepEqual(overriddenFields({ port: 5555 }, {}, file), { port: 'flag' });
  assert.deepEqual(overriddenFields({}, { SEEDEEP_HOST: '0.0.0.0' }, file), { host: 'env' });
  // A flag that repeats the file overrides nothing anyone can observe, so it is not reported.
  assert.deepEqual(overriddenFields({ port: 9090 }, {}, file), {});
  assert.deepEqual(overriddenFields({}, {}, file), {});
});

test('overriddenFields: a flag wins over a variable in what it reports', () => {
  const home = tmpHome();
  const file = { ...defaultConfig(home), port: 9090, auth: { token: 'tok' } };
  assert.deepEqual(overriddenFields({ port: 5555 }, { SEEDEEP_PORT: '7070' }, file), { port: 'flag' });
});

test('restartPending: an empty desired token is not a change', () => {
  // A missing config.json reads as "no token configured, one will be generated" — never as a
  // request to replace the one in use. Compared literally it pinned a restart nobody could clear.
  const home = tmpHome();
  const running = { ...defaultConfig(home), auth: { token: 'generated-at-start' } };
  assert.equal(restartPending(running, { ...running, auth: { token: '' } }), false);
  assert.equal(restartPending(running, { ...running, auth: { token: 'written-by-hand' } }), true);
});
