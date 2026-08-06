import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

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
  const writers = [...WORKFLOW.matchAll(/gh release (create|upload|edit)/g)].map((m) => m[1]).sort();
  assert.deepEqual(writers, ['create', 'edit', 'upload', 'upload'], 'the draft, both halves, the flip');
  // One `if:` on the ref type per writing site — the count is what makes a new, ungated upload fail
  // here rather than on the day someone runs the workflow by hand. Counted with the npm job removed:
  // it writes to a place GitHub knows nothing about, is gated once for the whole job, and has its
  // own test below.
  const gates = WORKFLOW.replace(job('npm'), '').match(/if: github\.ref_type == 'tag'/g);
  assert.equal(gates?.length, writers.length);
});

// The registry is the second thing in this repo that cannot be taken back — more absolutely than a
// release, since npm restricts unpublishing after 72 hours. So the gate is doubled: the tag, and a
// repository variable that has to be set deliberately.
test('publishing to npm needs a tag AND a switch', () => {
  const npm = job('npm');
  assert.match(npm, /if: github\.ref_type == 'tag' && vars\.SEEDEEP_NPM_PUBLISH == 'true'/);
  // The wrapper names its binaries at an exact version: on the registry ahead of them, it is an
  // install that ends in a command which cannot run.
  const platforms = npm.indexOf('npm publish "$dir"');
  const wrapper = npm.indexOf('npm publish dist/npm/seedeep\n');
  assert.ok(platforms !== -1 && wrapper > platforms, 'the wrapper is published after its binaries');
  // OIDC is the credential. A token in this workflow would mean a long-lived secret in the repo.
  assert.match(npm, /id-token: write/);
  assert.doesNotMatch(npm, /NODE_AUTH_TOKEN|NPM_TOKEN/);
  // The environment is part of the OIDC claim, and npmjs.com's six trusted publishers are set to
  // require this exact name. Renaming it here is not a local change: it rejects every publish until
  // the registry side is edited to match, six packages at a time.
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
// build AND the server's job succeeded, so a Windows failure leaves a draft instead of putting half
// a download page in front of people; and it runs once where the builds run per platform.
test('the release is published only after both halves built', () => {
  const publish = job('publish');
  assert.match(publish, /needs: \[tray, server\]/);
  assert.match(publish, /if: github\.ref_type == 'tag'/);
  assert.match(publish, /gh release edit .*--draft=false/);
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
