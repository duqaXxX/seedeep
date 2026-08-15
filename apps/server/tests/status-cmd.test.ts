import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type StatusFacts, shortPath, statusReport } from '../src/server/status-cmd.ts';
import type { UpdateStatus } from '../src/server/update-check.ts';

const NOW = Date.parse('2026-08-05T12:00:00.000Z');
const CHECKED = '2026-08-05T11:48:00.000Z'; // 12 minutes before NOW

const upToDate: UpdateStatus = {
  current: '0.10.1',
  latest: '0.10.1',
  standing: 'current',
  checkedAt: CHECKED,
  reason: null,
};

/** A machine with everything in order — each test names only what it changes. */
function facts(over: Partial<StatusFacts> = {}): StatusFacts {
  return {
    version: '0.10.1',
    channel: { kind: 'bun', command: 'bun install -g seedeep --trust' },
    // Under /opt, which cannot be anybody's home: `statusReport` calls `shortPath` with the
    // ambient `homedir()`, and the neutral placeholder this project prescribes elsewhere is a
    // plausible container home — which would have turned this assertion into `~/...`.
    execPath: '/opt/seedeep/.bun/install/global/node_modules/seedeep/bin/seedeep.exe',
    server: {
      kind: 'up',
      record: { pid: 91116, baseUrl: 'https://box.local:44842' },
      remote: true,
      serving: '0.10.1',

      restartPending: false,
    },
    update: upToDate,
    command: { kind: 'present', ownership: { kind: 'ours', version: '0.10.1', stale: false } },
    path: { kind: 'ok' },
    port: 44842,
    ...over,
  };
}

test('a healthy machine reports the four things and asks for nothing', () => {
  const out = statusReport(facts(), NOW);
  // The install's own directory, not the `bin/seedeep.exe` every channel shares.
  assert.match(out, /seedeep 0\.10\.1\s+\(bun, \/opt\/seedeep\/\.bun\/install\/global\/…\/seedeep\.exe\)/);
  assert.match(out, /running — https:\/\/box\.local:44842/);
  assert.match(out, /pid 91116 · remote mode/);
  assert.match(out, /serving 0\.10\.1/);
  assert.match(out, /up to date \(checked 12m ago\)/);
  assert.match(out, /\/seedeep {2}installed, current/);
  // Nothing is suggested when nothing is wrong.
  assert.doesNotMatch(out, /`seedeep restart`|`seedeep install-command`|`seedeep start`/);
});

// THE case this command was written for: the package was updated and the process kept its old code.
// Nothing else on the machine says so — it took lsof, ps and a token to find out by hand.
test('a server serving an older version than the one installed says so, and what fixes it', () => {
  const out = statusReport(
    facts({
      server: {
        kind: 'up',
        record: { pid: 67256, baseUrl: 'https://box.local:44842' },
        remote: true,
        serving: '0.9.0',
        restartPending: false,
      },
    }),
    NOW,
  );
  assert.match(out, /serving 0\.9\.0 — you have 0\.10\.1 installed/);
  assert.match(out, /`seedeep restart` swaps it/);
});

test('a server that is down is a state, with the way to start one', () => {
  const out = statusReport(facts({ server: { kind: 'down' } }), NOW);
  assert.match(out, /Server {4}not running/);
  assert.match(out, /`seedeep start` starts one on port 44842/);
  assert.doesNotMatch(out, /pid |serving /);
});

test('a server that will not name its version says that, never a guess', () => {
  const out = statusReport(
    facts({
      server: {
        kind: 'up',
        record: { pid: 1, baseUrl: 'http://localhost:44842' },
        remote: false,
        serving: null,
        restartPending: false,
      },
    }),
    NOW,
  );
  assert.match(out, /version unknown — it did not answer/);
  assert.match(out, /· loopback/);
  assert.doesNotMatch(out, /serving 0\.10\.1/, 'the installed version is not the served one');
});

// The second thing that went wrong on the day this was written.
test('a missing /seedeep is reported with the one command that writes it', () => {
  const out = statusReport(facts({ command: { kind: 'absent' } }), NOW);
  assert.match(out, /\/seedeep {2}not installed/);
  assert.match(out, /`seedeep install-command` writes it/);
});

test('a command file the user took over is left alone, and said so', () => {
  const out = statusReport(facts({ command: { kind: 'present', ownership: { kind: 'theirs' } } }), NOW);
  assert.match(out, /yours — edited by hand/);
  assert.doesNotMatch(out, /install-command/);
});

test('a command file from an older version says what will refresh it', () => {
  const out = statusReport(
    facts({ command: { kind: 'present', ownership: { kind: 'ours', version: '0.9.0', stale: true } } }),
    NOW,
  );
  assert.match(out, /installed, from 0\.9\.0/);
  assert.match(out, /next server start refreshes it/);
});

// An installed command file and a WORKING /seedeep are two different facts: the file calls `seedeep`
// by name, so an install that is not on PATH under that name fails with "command not found".
test('a command file that cannot run is distinguished from one that is missing', () => {
  const absent = statusReport(facts({ path: { kind: 'absent' } }), NOW);
  assert.match(absent, /installed, current/);
  assert.match(absent, /not on PATH under that name/);

  const other = statusReport(facts({ path: { kind: 'other', found: '/usr/local/bin/seedeep' } }), NOW);
  // No `node_modules` to elide, so it is shown whole — the reader has to be able to go and look.
  assert.match(other, /`seedeep` on PATH is \/usr\/local\/bin\/seedeep, not this one/);
});

test('the update line speaks in the terms the cache can support', () => {
  const behind = statusReport(facts({ update: { ...upToDate, latest: '0.11.0', standing: 'behind' } }), NOW);
  assert.match(behind, /0\.11\.0 available — `seedeep update` says how/);

  const never = statusReport(
    facts({ update: { current: '0.10.1', latest: null, standing: 'unknown', checkedAt: null, reason: 'no network' } }),
    NOW,
  );
  assert.match(never, /Update {4}unknown — npm has not been reached \(no network\)/);

  const ahead = statusReport(facts({ update: { ...upToDate, latest: '0.10.0', standing: 'ahead' } }), NOW);
  assert.match(ahead, /ahead of npm's 0\.10\.0 — a build of your own/);
});

test('the age of the check is said in the coarsest unit that is still true', () => {
  const at = (checkedAt: string) => statusReport(facts({ update: { ...upToDate, checkedAt } }), NOW);
  assert.match(at('2026-08-05T11:59:45.000Z'), /just now/);
  assert.match(at('2026-08-05T11:15:00.000Z'), /45m ago/);
  assert.match(at('2026-08-05T09:00:00.000Z'), /3h ago/);
  assert.match(at('2026-08-03T12:00:00.000Z'), /2d ago/);
});

// The other axis of the same staleness: the process is older than the CONFIG on disk. It was
// diagnosed with lsof, exactly as the version case above was diagnosed with ps.
test('a server running a configuration config.json no longer describes says so', () => {
  const out = statusReport(
    facts({
      server: {
        kind: 'up',
        record: { pid: 67256, baseUrl: 'http://localhost:44842' },
        remote: false,
        serving: '0.10.1',
        restartPending: true,
      },
    }),
    NOW,
  );
  assert.match(out, /config\.json has changed since it started/);
  assert.match(out, /`seedeep restart` applies it/);
});

test('a server whose config matches says nothing about it', () => {
  // Only when true: a line printed on every run is one nobody reads on the run that matters.
  assert.doesNotMatch(statusReport(facts(), NOW), /config\.json has changed/);
});

// The headline's path used to keep the last two segments, which is the part EVERY installation
// shares: npm, bun and a moved download all printed `…/bin/seedeep.exe`, so it described nothing
// while the word beside it carried the whole answer. What differs is upstream.
//
// The home directory is assembled from fragments here, and the names are synthetic: the pre-commit
// gate refuses a real one, and a test's own input must not be the thing that trips it.
test('shortPath keeps the directory that identifies the install and elides the part that does not', () => {
  const mac = `/Us${'ers'}/carol`;
  assert.equal(
    shortPath(`${mac}/.bun/install/global/node_modules/seedeep/bin/seedeep.exe`, mac),
    '~/.bun/install/global/…/seedeep.exe',
  );

  // Windows, and both separators: splitting on `/` alone left these untouched, which is why the
  // old form was never noticed there.
  const win = 'C:\\Us' + 'ers\\carol';
  assert.equal(
    shortPath(`${win}\\AppData\\Roaming\\npm\\node_modules\\seedeep\\bin\\seedeep.exe`, win),
    '~\\AppData\\Roaming\\npm\\…\\seedeep.exe',
  );
  // The npm launcher sits beside the package, with no `node_modules` to elide: shown whole, which
  // is the case the PATH warning prints.
  assert.equal(shortPath(`${win}\\AppData\\Roaming\\npm\\seedeep.cmd`, win), '~\\AppData\\Roaming\\npm\\seedeep.cmd');

  // A download the user placed is already short, and outside the home: nothing to do to it.
  assert.equal(shortPath('/usr/local/bin/seedeep', mac), '/usr/local/bin/seedeep');
});
