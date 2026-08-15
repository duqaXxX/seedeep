import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// The smoke script is the gate that decides whether a release is publishable, and a gate that
// cannot go red is worse than no gate: it would sign off the exact failure it was written for.
// So it is tested by its FAILURE paths, against fake executables that break one thing each. The
// green case is here too, for the same reason — a script that is red on everything proves nothing
// about the four that are red on purpose.
//
// The fakes are `bash` + `bun`, so this runs where the suite runs (Linux and macOS). The Windows
// half of the matrix is proven by the workflow itself, which is the only place a Windows binary
// exists.

const SCRIPT = join(import.meta.dirname, 'smoke-server.sh');

/** A Bun server standing in for the compiled executable: `--version`, then `serve --port <n>`. */
const FAKE_SERVER = `
const port = Number(Bun.argv[Bun.argv.indexOf('--port') + 1]);
const assets = Bun.env.FAKE_ASSETS ?? 'ok';
const body = Bun.env.FAKE_CONFIG_BODY ?? '{"port":' + port + '}';
Bun.serve({
  port,
  fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === '/api/config') return new Response(body);
    if (assets === '404') return new Response('nope', { status: 404 });
    return new Response('body');
  },
});
`;

/**
 * Run the smoke script against a fake executable.
 *
 * `serve` is what the fake does with anything that is not `--version`, which is exactly the shape
 * the real binary has — so a script that stops calling one of them is caught here.
 */
/**
 * A port nothing is listening on, from the OS rather than from a guess.
 *
 * Bound and released: the window between here and the fake server binding it is a race in theory,
 * and a far narrower one than choosing blind among 400 numbers on a machine that may already be
 * running seedeep.
 */
async function freePort(): Promise<number> {
  // Bound the way the fake server binds — no hostname, so every interface — or a port free on
  // loopback and taken on another one would be reported free and then fail to bind.
  const probe = Bun.serve({ port: 0, fetch: () => new Response('') });
  const { port } = probe;
  // AWAITED: `stop` answers with a promise, and a socket still closing is a socket the fake server
  // cannot bind — the EADDRINUSE this helper exists to prevent, one layer down.
  await probe.stop(true);
  return port;
}

async function runSmoke(opts: {
  version: string;
  expected: string;
  serves?: boolean;
  env?: Record<string, string>;
}): Promise<{ status: number | null; output: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-smoke-'));
  try {
    const serverPath = join(dir, 'fake-server.ts');
    writeFileSync(serverPath, FAKE_SERVER);
    const binPath = join(dir, 'fake-seedeep');
    // `exec` so the fake replaces the shell: the script kills the pid it spawned, and a wrapper
    // left in front of the server would survive that kill and hold the port.
    writeFileSync(
      binPath,
      `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "${opts.version}"; exit 0; fi
${opts.serves === false ? 'sleep 30' : `exec bun "${serverPath}" "$@"`}
`,
    );
    chmodSync(binPath, 0o755);

    // A port per run: these tests may share a machine with a seedeep someone is actually using.
    // ASKED for, not guessed: picking at random from a 400-wide range collides eventually, and it
    // did — a CI run went red on `Is port 45440 in use?` with nothing wrong in the change under it.
    const port = String(await freePort());
    const res = spawnSync('bash', [SCRIPT, binPath, opts.expected, port], {
      encoding: 'utf8',
      env: { ...process.env, SMOKE_TIMEOUT_S: '3', ...opts.env },
    });
    return { status: res.status, output: `${res.stdout}${res.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('passes when the binary reports its version, serves the API and carries the GUI', async () => {
  const { status, output } = await runSmoke({ version: '9.9.9', expected: '9.9.9' });
  assert.equal(status, 0, output);
  assert.match(output, /smoke: OK/);
});

test('fails when the binary reports a version other than the one being released', async () => {
  const { status, output } = await runSmoke({ version: '9.9.8', expected: '9.9.9' });
  assert.notEqual(status, 0);
  assert.match(output, /--version printed '9\.9\.8'/);
});

test('fails when the server never answers', async () => {
  const { status, output } = await runSmoke({ version: '9.9.9', expected: '9.9.9', serves: false });
  assert.notEqual(status, 0);
  assert.match(output, /no answer on/);
});

// The measured failure this script exists for, reproduced: the API is up and every static path is
// 404, because nothing imported the GUI's files into the executable.
test('fails when /api answers but the GUI is not embedded', async () => {
  const { status, output } = await runSmoke({
    version: '9.9.9',
    expected: '9.9.9',
    env: { FAKE_ASSETS: '404' },
  });
  assert.notEqual(status, 0);
  assert.match(output, /the browser GUI is not inside this executable/);
});

test('fails when /api/config answers 200 with something that is not the config', async () => {
  const { status, output } = await runSmoke({
    version: '9.9.9',
    expected: '9.9.9',
    env: { FAKE_CONFIG_BODY: '<html>a proxy sign-in page</html>' },
  });
  assert.notEqual(status, 0);
  assert.match(output, /is not the config/);
});
