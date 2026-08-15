import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asciiFallback, type ConsoleLike, useAsciiConsole } from '../src/server/console-encoding.ts';
import { usage } from '../src/server/help.ts';

/** A stand-in for the global console: records what each method actually received. */
function fakeConsole(): ConsoleLike & { said: unknown[] } {
  const said: unknown[] = [];
  return {
    said,
    log: (...a: unknown[]) => said.push(...a),
    error: (...a: unknown[]) => said.push(...a),
    warn: (...a: unknown[]) => said.push(...a),
  };
}

/** Every character a legacy Windows console cannot show, or an empty string. */
const nonAscii = (s: string) => [...s].filter((c) => c.charCodeAt(0) > 127).join('');

test('asciiFallback: the five measured characters, every occurrence', () => {
  assert.equal(asciiFallback('a — b'), 'a - b');
  assert.equal(asciiFallback('/very/long/…/path'), '/very/long/.../path');
  assert.equal(asciiFallback('pid 8064 · loopback'), 'pid 8064 - loopback');
  assert.equal(asciiFallback('pid 7 → 9'), 'pid 7 -> 9');
  assert.equal(asciiFallback('≥ 3 turns'), '>= 3 turns');
  assert.equal(asciiFallback('a — b — c'), 'a - b - c', 'every occurrence, not the first');
  assert.equal(asciiFallback('plain ascii'), 'plain ascii');
});

// The first attempt wrapped `process.stdout.write`, which in Bun `console.log` does not go through:
// it translated nothing while its test, which only wrote to a fake stream, passed. seedeep prints
// through these three methods and through nothing else.
test('useAsciiConsole: log, error and warn are all translated on Windows', () => {
  const fake = fakeConsole();
  assert.equal(useAsciiConsole(fake, 'win32', true), true);
  fake.log('seedeep watching — url');
  fake.error('seedeep: pid 7 → 9');
  fake.warn('a … b');
  assert.deepEqual(fake.said, ['seedeep watching - url', 'seedeep: pid 7 -> 9', 'a ... b']);
});

// A console that renders these correctly gets them. Nothing is wrapped at all, so this cannot cost
// anything on the platform seedeep is used on every day.
test('useAsciiConsole: off Windows it does not even wrap', () => {
  for (const platform of ['darwin', 'linux']) {
    const fake = fakeConsole();
    assert.equal(useAsciiConsole(fake, platform, true), false, platform);
    fake.log('seedeep watching — url');
    assert.deepEqual(fake.said, ['seedeep watching — url'], platform);
  }
});

// The tray starts the server with its output going to `server.log`, and `seedeep start` does the
// same. Those are UTF-8 files no code page touches, so degrading them would be this module doing to
// a file exactly what it exists to prevent on a terminal.
test('useAsciiConsole: a redirect is left alone, console or not', () => {
  const fake = fakeConsole();
  assert.equal(useAsciiConsole(fake, 'win32', false), false);
  fake.log('seedeep watching — url');
  assert.deepEqual(fake.said, ['seedeep watching — url']);
});

// An encoder that rewrites what it did not encode is a corruption. Only strings are translated.
test('useAsciiConsole: a non-string argument passes through untouched', () => {
  const fake = fakeConsole();
  useAsciiConsole(fake, 'win32', true);
  const obj = { dash: '—' };
  fake.log(obj, 42);
  assert.deepEqual(fake.said, [obj, 42]);
});

// The end-to-end check the first attempt lacked: a REAL string seedeep prints, through the REAL
// wrapper, asserted to carry nothing a legacy console cannot show. `usage()` is the longest single
// block the CLI emits and the one with the most separators in it.
test('the help screen comes out pure ASCII on Windows', () => {
  assert.notEqual(nonAscii(usage()), '', 'the source text must contain some, or this proves nothing');
  const fake = fakeConsole();
  useAsciiConsole(fake, 'win32', true);
  fake.log(usage());
  assert.equal(nonAscii(String(fake.said[0])), '');
});
