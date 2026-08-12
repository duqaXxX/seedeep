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

test('the one platform the os×cpu cross product admits is refused by the postinstall', () => {
  // `os` and `cpu` are two independent lists, so npm reads them as every combination of the two —
  // and that admits Windows on arm64, which Bun has no target for. npm lets such an install begin;
  // what stops it is the postinstall finding no package of that name to install, and the name it
  // computes has to be the one that is genuinely absent for the guard to fire.
  const orphan = install.platformPackage('win32', 'arm64');
  assert.equal(orphan, 'seedeep-windows-arm64');
  assert.ok(!(orphan in (wrapper.optionalDependencies as Record<string, string>)));
  assert.ok((wrapper.os as string[]).includes('win32') && (wrapper.cpu as string[]).includes('arm64'));
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
