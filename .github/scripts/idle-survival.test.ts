import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// The survival script exists to catch a process that dies AFTER the smoke gate has passed, so its
// whole value is in going red. It is tested by its failure paths, against fake executables that die
// in one specific way each — including the two the real deaths were split between, which is the
// distinction the script was written to make: dying while nothing had touched it, versus dying on
// the first request.
//
// The fakes are `bash` + `bun`, so this runs where the suite runs. The Windows half of the matrix is
// proven by the workflow, which is the only place a Windows binary exists.

const SCRIPT = join(import.meta.dirname, 'idle-survival.sh');

// Every case here spawns bash, spawns bun under it, and then WAITS OUT a window measured in whole
// seconds — the script's only unit. The runner's default allowance is five, and the slowest case
// measured 3.1s on an idle laptop, so a cold `ubuntu-24.04-arm` runner would turn this file red for
// reasons that have nothing to do with the script.
const TIMEOUT = { timeout: 30_000 };

/** A Bun server that can be told to exit at a chosen moment instead of serving. */
const FAKE_SERVER = `
const port = Number(Bun.argv[Bun.argv.indexOf('--port') + 1]);
const dieAfterMs = Number(Bun.env.FAKE_DIE_AFTER_MS ?? 0);
const dieOnRequest = Bun.env.FAKE_DIE_ON_REQUEST === '1';
const deaf = Bun.env.FAKE_DEAF === '1';

// Dying without ever binding is not the case under test: the deaths being reproduced happened to a
// server that was up. So it binds first, then dies on the clock.
if (!deaf) {
  Bun.serve({
    port,
    fetch() {
      if (dieOnRequest) process.exit(3);
      return new Response('{"port":' + port + '}');
    },
  });
}
if (dieAfterMs > 0) setTimeout(() => process.exit(5), dieAfterMs);
// Nothing else to do: an unreferenced timer would let Bun exit and every attempt would read as a
// death that the fake never meant.
setInterval(() => {}, 1000);
`;

async function runSurvival(opts: {
  attempts?: number;
  idleSeconds?: number;
  env?: Record<string, string>;
}): Promise<{ status: number | null; output: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-idle-'));
  try {
    const serverPath = join(dir, 'fake-server.ts');
    writeFileSync(serverPath, FAKE_SERVER);
    const binPath = join(dir, 'fake-seedeep');
    // `exec` so the fake replaces the shell — the script kills the pid it spawned, and a wrapper
    // left in front would survive that kill and hold the port for the next attempt.
    writeFileSync(binPath, `#!/usr/bin/env bash\nexec bun "${serverPath}" "$@"\n`);
    chmodSync(binPath, 0o755);

    const port = String(await freePort());
    const res = spawnSync('bash', [SCRIPT, binPath, String(opts.attempts ?? 1), String(opts.idleSeconds ?? 1), port], {
      encoding: 'utf8',
      // Seconds, everywhere: the script's unit is a second, and the runner kills a test at five.
      // So the windows here are the smallest ones that still exercise both phases.
      env: { ...process.env, IDLE_TIMEOUT_S: '2', IDLE_SETTLE_S: '0', ...opts.env },
    });
    return { status: res.status, output: `${res.stdout}${res.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A port nothing is listening on, from the OS rather than from a guess — see `smoke-server.test.ts`. */
async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response('') });
  const { port } = probe;
  await probe.stop(true);
  return port;
}

test('passes when every attempt survives the idle window and then answers', TIMEOUT, async () => {
  const { status, output } = await runSurvival({ attempts: 2 });
  assert.equal(status, 0, output);
  assert.match(output, /2\/2 survived/);
});

// The measured shape this script exists for: dead at ~t+11s with no request ever sent, which the
// smoke gate cannot see because it has already passed by then.
test('fails when the server dies during the idle window, before any request', TIMEOUT, async () => {
  const { status, output } = await runSurvival({
    idleSeconds: 3,
    env: { FAKE_DIE_AFTER_MS: '1000' },
  });
  assert.notEqual(status, 0);
  assert.match(output, /DIED WHILE IDLE/);
  assert.match(output, /0\/1 survived — 1 died idle/);
});

// The other story the same numbers fit, and the reason the idle window is there at all: telling the
// two apart is the finding, not the death itself.
test('fails when the server survives the idle window and dies on the first request', TIMEOUT, async () => {
  const { status, output } = await runSurvival({ env: { FAKE_DIE_ON_REQUEST: '1' } });
  assert.notEqual(status, 0);
  assert.match(output, /DIED ON THE FIRST REQUEST/);
  assert.match(output, /died on the first request/);
});

test('fails when the process is alive but never answers', TIMEOUT, async () => {
  const { status, output } = await runSurvival({ env: { FAKE_DEAF: '1' } });
  assert.notEqual(status, 0);
  assert.match(output, /never answered/);
});

test('counts the deaths instead of stopping at the first one', TIMEOUT, async () => {
  const { status, output } = await runSurvival({
    attempts: 2,
    idleSeconds: 3,
    env: { FAKE_DIE_AFTER_MS: '100' },
  });
  assert.notEqual(status, 0);
  assert.match(output, /0\/2 survived — 2 died idle/);
});
