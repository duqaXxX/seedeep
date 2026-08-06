import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ASSETS, assetPath } from '../src/server/assets.ts';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

/** Every file under `public/`, as the URL path a browser would ask for it by. */
function urlsOnDisk(dir = PUBLIC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? urlsOnDisk(full) : [`/${relative(PUBLIC, full).split(/[\\/]/).join('/')}`];
  });
}

// The whole reason `assets.ts` is a hand-written list: nothing imports the GUI's files, so
// `bun build --compile` cannot find them on its own, and a file added to `public/` without a line
// there is served in dev and 404s in the executable — a difference nobody meets until a release.
test('every file in public/ is embedded, and nothing is embedded that is not there', () => {
  assert.deepEqual([...ASSETS.keys()].sort(), urlsOnDisk().sort());
});

test('/ is the index page, and an unmapped path is nothing at all', () => {
  assert.equal(assetPath('/'), ASSETS.get('/index.html'));
  assert.equal(assetPath('/css/trace.css'), ASSETS.get('/css/trace.css'));
  assert.equal(assetPath('/nope.css'), null);
});

// The traversal guard this map replaced is gone rather than reimplemented, so the claim that made
// it unnecessary is the one under test: an escape is not a key.
test('a path-traversal attempt is simply not a key', () => {
  for (const attempt of ['/../etc/passwd', '/css/../../etc/passwd', '//etc/passwd', '/./index.html']) {
    assert.equal(assetPath(attempt), null, attempt);
  }
});
