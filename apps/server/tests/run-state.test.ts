import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { announce, runningServers, runStateDir, withdraw } from '../src/server/run-state.ts';

// The records live under seedDeepDir, which honours SEEDEEP_HOME — an exported one would send these
// writes into a real directory instead of the temp home each test makes.
delete process.env['SEEDEEP_HOME'];

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), 'seedeep-run-'));
}

/** A pid that cannot be alive: 2^31-1 is above every system's pid_max. */
const DEAD = 2147483647;

test('a running server can be found, with the address it answers on', async () => {
  const home = tmpHome();
  await announce({ pid: process.pid, baseUrl: 'http://127.0.0.1:44842' }, home);

  assert.deepEqual(await runningServers(home), [{ pid: process.pid, baseUrl: 'http://127.0.0.1:44842' }]);
});

// The whole reason this is not one shared file: the README documents running a second server on
// another port, and a reader that handed out one server's address with another's pid would make
// "stop" kill the wrong process.
test('two servers on one machine are two records', async () => {
  const home = tmpHome();
  await announce({ pid: process.pid, baseUrl: 'http://127.0.0.1:44842' }, home);
  mkdirSync(runStateDir(home), { recursive: true });
  writeFileSync(
    join(runStateDir(home), `${process.ppid}.json`),
    JSON.stringify({ pid: process.ppid, baseUrl: 'http://127.0.0.1:9000' }),
  );

  const found = await runningServers(home);

  assert.equal(found.length, 2, JSON.stringify(found));
  assert.deepEqual(found.map((r) => r.baseUrl).sort(), ['http://127.0.0.1:44842', 'http://127.0.0.1:9000']);
});

// A SIGKILL leaves the record behind. Liveness comes from the process, never from the file — this
// is the claim the tray's whole "running / stopped" reading rests on.
test('a record whose process is gone is not a running server', async () => {
  const home = tmpHome();
  mkdirSync(runStateDir(home), { recursive: true });
  writeFileSync(
    join(runStateDir(home), `${DEAD}.json`),
    JSON.stringify({ pid: DEAD, baseUrl: 'http://127.0.0.1:44842' }),
  );

  assert.deepEqual(await runningServers(home), []);
});

test('starting a server clears the records of processes that are gone', async () => {
  const home = tmpHome();
  mkdirSync(runStateDir(home), { recursive: true });
  writeFileSync(join(runStateDir(home), `${DEAD}.json`), '{}');

  await announce({ pid: process.pid, baseUrl: 'http://127.0.0.1:44842' }, home);

  assert.deepEqual(readdirSync(runStateDir(home)), [`${process.pid}.json`]);
});

test('a server that exits is no longer running', async () => {
  const home = tmpHome();
  await announce({ pid: process.pid, baseUrl: 'http://127.0.0.1:44842' }, home);

  withdraw(process.pid, home);

  assert.deepEqual(await runningServers(home), []);
  withdraw(process.pid, home); // twice: a record that is already gone is not an error
});

// Hand-edited, half-written, or a pid recycled by the OS since the file was named. None of them is
// a server to connect to, and none of them may become one to stop.
test('a record that does not agree with its own filename is not a server', async () => {
  const home = tmpHome();
  mkdirSync(runStateDir(home), { recursive: true });
  const dir = runStateDir(home);
  writeFileSync(join(dir, `${process.pid}.json`), JSON.stringify({ pid: DEAD, baseUrl: 'http://127.0.0.1:1' }));

  assert.deepEqual(await runningServers(home), []);

  writeFileSync(join(dir, `${process.pid}.json`), '{ not json');
  assert.deepEqual(await runningServers(home), []);

  writeFileSync(join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, baseUrl: '' }));
  assert.deepEqual(await runningServers(home), [], 'a server with no address is nothing to connect to');
});

test('no directory at all is no servers, not an error', async () => {
  assert.deepEqual(await runningServers(tmpHome()), []);
});
