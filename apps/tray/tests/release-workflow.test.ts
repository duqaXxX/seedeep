import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { TARGETS } from '../../server/scripts/targets.ts';

// The release workflow is the only file in the repo that can take an irreversible action - it
// publishes. Nothing else checks it: it runs on GitHub's machines, so a change that looks fine is
// only discovered by a release that should not have happened, or by a DMG that will not build.
// These lines are the decisions `docs/tray.md` states; each was reasoned about, and each can be
// deleted in a moment of tidying without anything going red.
const WORKFLOW = readFileSync(
  fileURLToPath(new URL('../../../.github/workflows/release.yml', import.meta.url)),
  'utf8',
);

/** One job's block, from its key to the next job's — so a rule cannot be satisfied by another job. */
function job(name: string): string {
  const start = WORKFLOW.indexOf(`\n  ${name}:`);
  assert.notEqual(start, -1, `no ${name} job at all`);
  const next = WORKFLOW.slice(start + 1).search(/\n {2}[a-z]+:\n/);
  return next === -1 ? WORKFLOW.slice(start) : WORKFLOW.slice(start, start + 1 + next);
}

// Everything that writes to the repository is gated on the ref TYPE, and that is what keeps a
// manual run a rehearsal: it builds the same artifacts and attaches them to the workflow run.
test('only a tag can write to the repository', () => {
  // Comments stripped first: a writing site is a COMMAND, and this counted prose too — a comment
  // that merely names `gh release upload` while explaining why a tag run must not be cancelled was
  // enough to fail it, which is a false red about a file that writes exactly as much as before.
  const commands = WORKFLOW.split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  const writers = [...commands.matchAll(/gh release (create|upload|edit)/g)].map((m) => m[1]).sort();
  assert.deepEqual(writers, ['create', 'edit', 'upload', 'upload'], 'the draft, both halves, the flip');
  // Each writing site carries the gate on its own step, or on the job around it — `publish` is
  // gated once for the whole job, and the npm job likewise. This used to count the gates in the
  // file instead and require one per writer, which said something weaker than it looked: a new
  // writer could inherit a gate written for something else, and any gated step that writes NOTHING
  // broke it (the attestation steps did exactly that). The count of sites is still asserted, so a
  // writer appearing in a fifth job fails here rather than on the day someone runs this by hand.
  const GATE = /if: github\.ref_type == 'tag'/;
  const WRITES = /gh release (?:create|upload|edit)/;
  let gated = 0;
  for (const name of ['draft', 'tray', 'server', 'publish']) {
    const block = job(name);
    const header = block.split('\n    steps:')[0] ?? '';
    for (const step of block.split(/\n {6}- /).slice(1)) {
      if (!WRITES.test(step)) continue;
      assert.ok(GATE.test(header) || GATE.test(step), `an ungated writer in the ${name} job`);
      gated++;
    }
  }
  assert.equal(gated, writers.length, 'a writing site outside the four jobs allowed to write');
});

// The registry is the second thing in this repo that cannot be taken back — more absolutely than a
// release, since npm restricts unpublishing after 72 hours. So the gate is doubled: the tag, and a
// repository variable that has to be set deliberately.
test('publishing to npm needs a tag AND a switch', () => {
  const npm = job('npm');
  assert.match(npm, /if: github\.ref_type == 'tag' && vars\.SEEDEEP_NPM_PUBLISH == 'true'/);
  // The wrapper names its binaries at an exact version: on the registry ahead of them, it is an
  // install that ends in a command which cannot run. One `for` list holds the order now — the glob
  // expands before the literal — so the list itself is what has to be right.
  assert.equal(
    npm.match(/for dir in (.+); do/)?.[1],
    'dist/npm/seedeep-* dist/npm/seedeep',
    'the wrapper is published after its binaries',
  );
  // Re-runnable: a version already there is skipped rather than retried, since npm refuses to
  // publish over one and a half-finished run would otherwise be unrecoverable.
  assert.match(npm, /npm view "\$spec" version/);
  // OIDC is the credential. A token in this workflow would mean a long-lived secret in the repo.
  assert.match(npm, /id-token: write/);
  assert.doesNotMatch(npm, /NODE_AUTH_TOKEN|NPM_TOKEN/);
  // The environment is part of the OIDC claim, and npmjs.com's seven trusted publishers are set to
  // require this exact name. Renaming it here is not a local change: it rejects every publish until
  // the registry side is edited to match, seven packages at a time.
  assert.match(npm, /\n {4}environment: npm-publish\n/);
});

// The tray job is the only one that runs on Windows, where the default shell is PowerShell — and a
// `run:` written for bash does not fail there, it MISBEHAVES: `"$TAG"` is an unassigned PowerShell
// variable, so it expands to the empty string and `gh` reports "release not found" while the
// installer it should have uploaded sits finished on disk. That cost the v0.6.0 release two runs.
test('every tray-job script that reads a shell variable declares bash', () => {
  const steps = job('tray')
    .split(/\n {6}- /)
    .filter((step) => /(^|\n) *run: /.test(step));
  assert.ok(steps.length >= 3, 'the tray job should still have its install, rename and upload steps');
  for (const step of steps) {
    // `$` in a `run:` means the SHELL is expected to expand it. PowerShell will not — it reads
    // `$TAG` as one of its own variables, unassigned, and hands over an empty string in silence.
    if (!step.includes('$')) continue;
    assert.match(step, /\n {8}shell: bash\n/, `a tray step expands a variable without bash:\n${step}`);
  }
});

// The draft is an intermediate state: the builds land in it and the `publish` job flips it. It also
// has to survive a re-run of the same tag, which is a thing that happens after a flaky runner.
test('the release is created as a draft, and creating it twice is not an error', () => {
  const draft = job('draft');
  assert.match(draft, /gh release create .*--draft/);
  assert.match(draft, /gh release view .* \|\|/, 'a re-run must not fail on the existing release');
});

// A draft job that skipped on a manual run would take both build jobs with it — `needs` treats a
// skipped dependency as a reason to skip — and a manual run exists precisely to keep building.
test('the draft job itself always runs; only the step that writes is conditional', () => {
  const draft = job('draft');
  assert.doesNotMatch(draft.split('steps:')[0] ?? '', /if:/, 'the JOB must not be gated');
  assert.match(draft, /- if: github\.ref_type == 'tag'/);
});

// The whole point of publishing from a separate job. `needs` will not start it unless every matrix
// build, the server's job AND the smoke run succeeded, so a Windows failure leaves a draft instead
// of putting half a download page in front of people; and it runs once where the builds run per
// platform.
test('the release is published only after both halves built', () => {
  const publish = job('publish');
  assert.match(publish, /needs: \[tray, server, smoke, windows\]/);
  assert.match(publish, /if: github\.ref_type == 'tag'/);
  assert.match(publish, /gh release edit .*--draft=false/);
});

// The gate that 0.6.0 was missing: six binaries cross-compiled on one runner, none of them ever
// executed. Both exits from the pipeline wait for it — the release page and the registry — and npm
// is the one that cannot be taken back.
test('nothing reaches a stranger until the binaries have been RUN', () => {
  assert.match(job('publish'), /needs: \[tray, server, smoke, windows\]/);
  assert.match(job('npm'), /needs: \[server, smoke, windows\]/);
});

// The experiment `windows` exists for only works if it is ONE binary on TWO machines: the x64 build
// on x64 silicon, and the same file under Prism. A leg that quietly switched to the arm64 asset
// would still be green and would prove nothing about the death it was written to explain.
test('the windows job runs the x64 binary on both runners', () => {
  const windows = job('windows');
  const runners = [...windows.matchAll(/runner: (\S+)/g)].map((m) => m[1]).sort();
  assert.deepEqual(runners, ['windows-11-arm', 'windows-latest']);
  const assets = [...windows.matchAll(/seedeep-server_\$\{VERSION\}_(\S+?)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(assets)], ['windows-x64.exe'], 'both legs run the SAME x64 binary');
  assert.match(windows, /idle-survival\.sh .* 10 40/, 'ten starts, 40s idle — the arm64 protocol');
  assert.match(windows, /server-lifecycle\.sh/);
});

// Starting was never the claim worth making: a binary that passes the smoke check and then dies
// unattended reached the release page on every platform alike. So both scripts run on all six
// targets, with the CHEAP protocol — the expensive one answers a measured death and belongs to the
// one job that has one.
test('every target is survived and driven, not merely started', () => {
  const smoke = job('smoke');
  assert.match(
    smoke,
    /idle-survival\.sh "bin\/seedeep-server_\$\{VERSION\}_\$\{ASSET\}" 3 20/,
    'three starts, 20s idle — the regression, not the experiment',
  );
  assert.match(smoke, /server-lifecycle\.sh "bin\/seedeep-server_\$\{VERSION\}_\$\{ASSET\}"/);
});

// Emulating an architecture the binary was not built for is an experiment, not a promise: a death
// under Prism must report and never hold back a release. On the STEPS and never on the job — a step
// whose `continue-on-error` fired concludes success, so the lifecycle after it still runs in exactly
// the scenario this job predicts, and the gate stops depending on what a job-level
// `continue-on-error` means to a `needs` that lists it.
test('only the emulated leg is allowed to fail, and only its steps say so', () => {
  const windows = job('windows');
  assert.doesNotMatch(
    windows.split('steps:')[0] ?? '',
    /continue-on-error/,
    'on the JOB it would ungate the native leg too, and skip the lifecycle after a death',
  );
  assert.match(windows, /continue-on-error: \$\{\{ matrix\.runner == 'windows-11-arm' \}\}/);
});

// A tag cannot be moved or deleted, so a gate that first runs AFTER the tag spends a version number
// every time it catches something — v0.28.0 was exactly that: the gate held the release in a draft,
// nobody could download anything, and the number was burnt anyway. The rehearsal has to be
// automatic, because the one that depended on remembering a manual dispatch is the one that was
// skipped.
test('the release gates rehearse on the pull request that bumps the version', () => {
  const triggers = WORKFLOW.slice(0, WORKFLOW.indexOf('\njobs:'));
  const paths = /pull_request:\n\s+paths: \[(.+)\]/.exec(triggers)?.[1] ?? '';
  // The version's own file, and the machinery that gates it — the v0.28.0 defect was in a script,
  // and a script change merged after the bump's run would otherwise reach the tag unrehearsed.
  for (const p of ['package.json', 'release.yml', '.github/scripts']) {
    assert.ok(paths.includes(p), `the rehearsal does not fire on ${p}: ${paths}`);
  }
  // A pull request run must be cancellable and a tag run must NOT: cancelling a tag halfway through
  // `gh release upload` leaves a half-populated draft.
  assert.match(triggers, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
});

// A rehearsal must stay a rehearsal: an attestation records, in a PUBLIC transparency log, that a
// file was built from a commit — doing that for a build nobody ships publishes provenance for an
// artifact that never existed. Walked per step rather than matched as one regex, for the reason the
// gate-counting test above gives: a `name:` or a compound condition must not turn this red while the
// gate is still right.
test('provenance is attested only on a tag', () => {
  const steps = WORKFLOW.split(/\n {6}- /).filter((s) => s.includes('attest-build-provenance'));
  assert.equal(steps.length, 2, 'the server binaries and the tray installers');
  for (const step of steps) {
    assert.match(step, /if: github\.ref_type == 'tag'/, `an attestation runs off a tag:\n${step}`);
  }
});

// The step after a failure is where the second finding lives: a binary that dies on its own is worth
// driving through the four verbs anyway, in the same run.
test('a failed survival step does not skip the lifecycle that follows it', () => {
  assert.match(job('smoke'), /- if: \$\{\{ !cancelled\(\) \}\}\n\s+shell: bash\n\s+env:[\s\S]*?server-lifecycle\.sh/);
});

// A target that is built and not smoke-tested is exactly the hole this closes, and it reopens
// silently the day someone adds a platform to `targets.ts` — the one list both the compiler and
// the npm packager read.
test('the smoke matrix covers every target the server is built for', () => {
  const smoke = job('smoke');
  const tested = [...smoke.matchAll(/asset: (\S+)/g)].map((m) => m[1]).sort();
  assert.deepEqual(tested, TARGETS.map((t) => t.asset).sort());
});

/**
 * Which runner builds the tray for which Windows architecture. The tray matrix names runners and
 * never architectures, so this is the only place the two vocabularies meet — the mapping the test
 * below needs, and the thing to extend the day a third Windows architecture exists.
 */
const WINDOWS_TRAY_RUNNER: Record<string, string> = {
  x64: 'windows-latest',
  arm64: 'windows-11-arm',
};

// The tray follows the server onto a platform, or the machine gets a server it can run beside an
// installer it cannot: a Snapdragon laptop is exactly that case. Nothing else in the repo states
// that rule, and the tray matrix cannot be derived from `targets.ts` the way the smoke matrix
// above is - so it is asserted here, and adding a Windows target without its tray leg fails.
test('every Windows platform the server ships has a tray installer of its own', () => {
  const legs = [...job('tray').matchAll(/- runner: (\S+)/g)].map((m) => m[1]);
  for (const target of TARGETS.filter((t) => t.os === 'win32')) {
    const runner = WINDOWS_TRAY_RUNNER[target.cpu];
    assert.ok(runner, `the server ships Windows ${target.cpu} and no runner here builds the tray for it`);
    assert.ok(legs.includes(runner), `no tray leg runs on ${runner}, so Windows ${target.cpu} gets no installer`);
  }
});

// One shell on five platforms. v0.6.0 uploaded no Windows installer because `"$TAG"` in PowerShell
// is an unassigned variable that expands to nothing, and `windows-latest` defaults to PowerShell:
// a `run:` here without `shell: bash` is that bug waiting to happen again.
test('every command the Windows-bearing jobs run is bash, Windows included', () => {
  // `windows` runs on nothing BUT Windows, so the rule matters there even more than in `smoke`.
  for (const [name, expected] of [
    ['smoke', 5],
    ['windows', 4],
  ] as const) {
    const steps = job(name)
      .split(/\n {6}- /)
      .filter((s) => /(^|\n)\s*run:/.test(s));
    assert.equal(steps.length, expected, `${name}: the version, the tag download, and the scripts`);
    for (const step of steps) {
      assert.match(step, /shell: bash/, `${name}: a step runs outside bash:\n${step}`);
    }
  }
});

// The rule is about the DOWNLOAD PAGE: two macOS files sharing one prefix say nothing about which
// of them reads your sessions. It used to be kept by renaming on the way out, because both apps
// were called `seedeep`; `productName` is `seedeep-tray` now, so the bundler writes the right name
// itself and the step only collects. Asserted on the glob, which is the thing that would silently
// stop matching if either name moved again.
test('every asset carries the name of the app it belongs to', () => {
  const tray = job('tray');
  assert.match(tray, /tagName: ''/, 'tauri-action must not upload the bundler-named files');
  assert.match(tray, /uploadWorkflowArtifacts: false/);
  assert.match(tray, /-name 'seedeep-tray_\*\.dmg'/);
  assert.match(tray, /-name 'seedeep-tray_\*-setup\.exe'/);
  // A glob that matched nothing would upload a release with no installers in it.
  assert.match(tray, /no bundle matched/);
  assert.match(job('server'), /gh release upload "\$TAG" dist\/\*/);
});

// The glob above is only true while the bundler agrees with it, and the bundler reads this.
test('the tray names itself apart from the server', () => {
  const conf = JSON.parse(
    readFileSync(fileURLToPath(new URL('../src-tauri/tauri.conf.json', import.meta.url)), 'utf8'),
  );
  assert.equal(conf.productName, 'seedeep-tray');
  // The IDENTIFIER must not follow it: the config directory, the Windows uninstall key and any
  // permission macOS has already granted all hang off this string, and moving it strands them.
  assert.equal(conf.identifier, 'app.seedeep.tray');
});

// "Re-run all jobs" is the standard gesture after a flaky runner, and an upload that refuses to
// replace its own first run's assets turns it into a release nobody can publish without deleting
// files by hand. The draft's creation was made idempotent from the start; these are the other half.
test('an upload can be repeated', () => {
  const uploads = [...WORKFLOW.matchAll(/gh release upload [^\n]*/g)].map((m) => m[0]);
  assert.equal(uploads.length, 2);
  for (const cmd of uploads) assert.match(cmd, /--clobber/, cmd);
});

// The server's executables are the OTHER half of a release, and the reason one tag can carry both
// without a compatibility matrix. Built through the script, never through a bare `bun build
// --compile`, which would embed whatever client bundle the checkout happened to contain.
test('a release also carries the server, built through the script that rebuilds the GUI', () => {
  assert.match(job('server'), /bun run build:server:all/);
});

// The note a stranger reads before running an unsigned binary. Both systems interrupt the first
// launch, and a note that does not say so lets the interruption read as a broken download — so the
// gesture that gets past each one is part of the release, not only of the README.
test('the release note says how to get past each system’s first-launch refusal', () => {
  assert.match(WORKFLOW, /Open Anyway/, 'the macOS gesture');
  assert.match(WORKFLOW, /Run anyway/, 'the Windows gesture');
});

test('the DMG is bundled without the Finder AppleScript', () => {
  // tauri-action defaults this to 'true', which turns the AppleScript back ON under CI. That step
  // needs an automatable Finder, it failed when this DMG was first built locally, and it styles a
  // window this app does not configure - so it can only cost a release.
  assert.match(WORKFLOW, /TAURI_BUNDLER_DMG_IGNORE_CI: 'false'/);
});
