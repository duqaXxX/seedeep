import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { BIN_PATH, npmManifests, WRAPPER } from '../scripts/npm-manifests.ts';
import { TARGETS } from '../scripts/targets.ts';

// The npm channel has two halves that must agree and are written in different languages: the
// packager decides what each package is CALLED and what is inside it, and `install.cjs` — running
// on someone else's machine, months later — recomputes both from `process.platform`. Nothing at
// build time connects them, so a rename on one side strands every install with a `seedeep` command
// that cannot find its own binary. These tests are that connection.

const NPM_SRC = resolve(import.meta.dirname, '..', 'npm');
const install = createRequire(import.meta.url)(join(NPM_SRC, 'install.cjs'));
const { wrapper, platforms } = npmManifests('9.9.9');

test('install.cjs names the package the packager publishes, for every platform', () => {
  for (const target of TARGETS) {
    const computed = install.platformPackage(target.os, target.cpu);
    assert.equal(computed, `${WRAPPER}-${target.npm}`);
    assert.ok(
      computed in (wrapper.optionalDependencies as Record<string, string>),
      `${computed} is not among the wrapper's optionalDependencies`,
    );
  }
});

test('install.cjs writes the binary where the bin field points', () => {
  assert.deepEqual((install.BIN_PATH as string).split(sep), BIN_PATH.split('/'));
  assert.equal((wrapper.bin as Record<string, string>)[WRAPPER], BIN_PATH);
});

test('a platform package is resolvable only on its own platform', () => {
  for (const { target, manifest } of platforms) {
    assert.deepEqual(manifest.os, [target.os]);
    assert.deepEqual(manifest.cpu, [target.cpu]);
    // The name is what a human reads in an install log; the fields are what npm obeys. They are
    // written from the same row, and this is what keeps a copy-pasted row from claiming otherwise.
    assert.equal(manifest.name, `${WRAPPER}-${install.OS_NAMES[target.os]}-${target.cpu}`);
  }
});

test('every platform the os×cpu cross product admits has a package behind it', () => {
  // `os` and `cpu` are two independent lists and npm reads them as every combination of the two, so
  // a pair present in one and unbuilt in the other is an install that BEGINS and cannot finish.
  // That pair was Windows on arm64: a Snapdragon laptop with the native Node from winget hit
  // `no build for win32 arm64` on the very command the README puts first, and nothing in the suite
  // could see it — the old test asserted the hole instead, as a thing that was meant to be there.
  const deps = wrapper.optionalDependencies as Record<string, string>;
  for (const os of wrapper.os as string[]) {
    for (const cpu of wrapper.cpu as string[]) {
      const name = install.platformPackage(os, cpu);
      assert.ok(name && name in deps, `npm admits ${os} ${cpu} and no package carries it`);
    }
  }
});

test('the postinstall refuses a platform seedeep names no package for', () => {
  // The guard in `install.cjs` has no reachable case left, and one nothing exercises is one that
  // rots. FreeBSD never gets that far — npm's own `os` refuses it first — so what this pins is the
  // postinstall's answer on a platform it does not know, which is the shape of the next hole.
  assert.equal(install.platformPackage('freebsd', 'x64'), null);
});

test('the wrapper pins its binaries to its own exact version', () => {
  const deps = wrapper.optionalDependencies as Record<string, string>;
  assert.equal(Object.keys(deps).length, TARGETS.length);
  for (const [name, range] of Object.entries(deps)) {
    assert.equal(range, '9.9.9', `${name} is not pinned to the wrapper's version`);
  }
});

test('the placeholder carries no shebang', () => {
  // Load-bearing, and invisible when broken: npm generates the Windows `.cmd` shim from this file
  // BEFORE the postinstall replaces it, and cmd-shim only execs the target directly when it finds
  // no shebang (npm 10.9, `cmd-shim/lib/index.js`). A `#!` line here would make every Windows
  // install run the native executable through an interpreter that cannot read it.
  const stub = readFileSync(join(NPM_SRC, 'stub.sh'), 'utf8');
  assert.ok(!stub.startsWith('#!'), 'stub.sh must not start with a shebang');
});

test("the README's figure survives leaving the repository", () => {
  // npm renders this file as GFM with no repository behind it, so a relative path resolves against
  // nothing and the figure is simply missing — and the packager substitutes exactly one token, so a
  // second one ships verbatim into the URL. Both failures are invisible until the page is public.
  const readme = readFileSync(join(NPM_SRC, 'README.md'), 'utf8');
  assert.deepEqual([...new Set(readme.match(/{{\w+}}/g) ?? [])], ['{{VERSION}}']);
  for (const match of readme.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
    const url = match[1] ?? '';
    assert.match(url, /^https:\/\/raw\.githubusercontent\.com\/\S+\/v{{VERSION}}\//, url);
  }
});
