import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { defaultCacheFile } from '../src/server/aggregate-cache.ts';
import { defaultCardsIndexFile } from '../src/server/cards-index.ts';
import {
  configFilePath,
  defaultConfig,
  readConfig,
  resolveConfig,
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
