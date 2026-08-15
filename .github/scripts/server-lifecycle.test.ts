import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// The lifecycle script is the only thing that exercises the DETACHED path in CI, and every defect
// that path has had was found by hand on a VM. So it is tested by the failures it exists to catch,
// each one a fake that breaks exactly one verb — including the real one: a `restart` that kills the
// old server and leaves no replacement running.
//
// The fake is a Bun CLI wearing the real one's interface: `serve`, `start`, `status`, `restart`,
// `stop`, a run-state record per pid under `$SEEDEEP_HOME/servers/`. That interface is the contract
// the script depends on, so a fake that drifts from it is itself the warning.

const SCRIPT = join(import.meta.dirname, 'server-lifecycle.sh');

const FAKE_CLI = `
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = Bun.argv.slice(2);
const verb = argv[0];
const port = Number(argv[argv.indexOf('--port') + 1]);
const broken = Bun.env.FAKE_BREAK ?? '';
const records = join(Bun.env.SEEDEEP_HOME ?? '', 'servers');

const recordedPids = () =>
  existsSync(records)
    ? readdirSync(records).map((n) => Number(n.replace('.json', ''))).filter(Number.isFinite)
    : [];

const answering = async () => {
  try {
    return (await fetch('http://127.0.0.1:' + port + '/api/config')).ok;
  } catch {
    return false;
  }
};

const waitUntilUp = async () => {
  for (let i = 0; i < 100; i++) {
    if (await answering()) return true;
    await Bun.sleep(50);
  }
  return false;
};

const killRecorded = () => {
  for (const pid of recordedPids()) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
    rmSync(join(records, pid + '.json'), { force: true });
  }
};

const spawnServer = () => {
  Bun.spawn([process.execPath, Bun.main, 'serve', '--port', String(port), '--no-open'], {
    stdio: ['ignore', 'ignore', 'ignore'],
    // Detached, like the real one: the parent exits and the server has to outlive it.
    env: Bun.env,
  }).unref();
};

if (verb === 'serve') {
  Bun.serve({ port, fetch: () => new Response('{"port":' + port + '}') });
  mkdirSync(records, { recursive: true });
  writeFileSync(join(records, process.pid + '.json'), JSON.stringify({ pid: process.pid, baseUrl: 'http://127.0.0.1:' + port }));
  const bye = () => {
    rmSync(join(records, process.pid + '.json'), { force: true });
    process.exit(0);
  };
  process.on('SIGTERM', bye);
  process.on('SIGINT', bye);
  setInterval(() => {}, 1000);
} else if (verb === 'start') {
  spawnServer();
  process.exit((await waitUntilUp()) ? 0 : 1);
} else if (verb === 'status') {
  // Always 0, like the real one: a server that is down is an answer.
  process.exit(0);
} else if (verb === 'restart') {
  if (broken === 'restart-nothing') process.exit(0);
  killRecorded();
  if (broken !== 'restart-no-replacement') {
    spawnServer();
    process.exit((await waitUntilUp()) ? 0 : 1);
  }
  process.exit(0);
} else if (verb === 'stop') {
  if (broken === 'stop-keeps-serving') {
    for (const pid of recordedPids()) rmSync(join(records, pid + '.json'), { force: true });
    process.exit(0);
  }
  for (const pid of recordedPids()) {
    try {
      // SIGKILL for the broken case, so the server never runs the handler that takes its own record
      // back: that is how a record outlives its process in the real world too.
      process.kill(pid, broken === 'stop-leaves-record' ? 'SIGKILL' : 'SIGTERM');
    } catch {}
    if (broken !== 'stop-leaves-record') rmSync(join(records, pid + '.json'), { force: true });
  }
  process.exit(0);
} else {
  process.exit(1);
}
`;

/** A port nothing is listening on, from the OS rather than from a guess — see `smoke-server.test.ts`. */
async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response('') });
  const { port } = probe;
  await probe.stop(true);
  return port;
}

async function runLifecycle(broken = ''): Promise<{ status: number | null; output: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-lifecycle-'));
  try {
    const cliPath = join(dir, 'fake-cli.ts');
    writeFileSync(cliPath, FAKE_CLI);
    const binPath = join(dir, 'fake-seedeep');
    writeFileSync(binPath, `#!/usr/bin/env bash\nexec bun "${cliPath}" "$@"\n`);
    chmodSync(binPath, 0o755);

    const port = String(await freePort());
    const res = spawnSync('bash', [SCRIPT, binPath, port], {
      encoding: 'utf8',
      env: { ...process.env, LIFECYCLE_TIMEOUT_S: '10', FAKE_BREAK: broken },
    });
    return { status: res.status, output: `${res.stdout}${res.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('passes when start, status, restart and stop all behave', { timeout: 30_000 }, async () => {
  const { status, output } = await runLifecycle();
  assert.equal(status, 0, output);
  assert.match(output, /lifecycle: OK/);
});

// The defect this step was written for, reproduced: `restart` exits 0 having killed the old server
// and bound nothing. Measured by hand on Windows before it was fixed; nothing in CI could see it.
test('fails when restart leaves no replacement running', { timeout: 30_000 }, async () => {
  const { status, output } = await runLifecycle('restart-no-replacement');
  assert.notEqual(status, 0);
  assert.match(output, /left NO replacement answering/);
});

// The other way a restart can lie: it exits 0 without replacing anything at all, so the server that
// answers is the OLD process — indistinguishable from success unless the pid is checked.
test('fails when restart never replaces the process', { timeout: 30_000 }, async () => {
  const { status, output } = await runLifecycle('restart-nothing');
  assert.notEqual(status, 0);
  assert.match(output, /no replacement was spawned/);
});

test('fails when stop leaves its run-state record behind', { timeout: 30_000 }, async () => {
  const { status, output } = await runLifecycle('stop-leaves-record');
  assert.notEqual(status, 0);
  assert.match(output, /a run-state record is still there/);
});

test('fails when stop exits 0 and the server keeps answering', { timeout: 30_000 }, async () => {
  const { status, output } = await runLifecycle('stop-keeps-serving');
  assert.notEqual(status, 0);
  assert.match(output, /the server still answers/);
});
