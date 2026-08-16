import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CLAIMS } from '../src/server/schema-contract.ts';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** `server/parser.ts:commandShape` → `{ path, symbol }`; a bare path has no symbol. */
function parseReader(part: string): { path: string; symbol: string | null } {
  const [path, symbol] = part.trim().split(':');
  return { path: path ?? '', symbol: symbol ?? null };
}

// A reader used to be `parser.ts:194`. Every sampled one had rotted into a `}`, a signature or a
// comment, because the parser changes far faster than the contract table and a line number is
// unfalsifiable: nothing can tell a right number from a wrong one. A path and a symbol can be
// checked, which is the whole point of the format — so the format itself is asserted first.
test('no claim points at a line number', () => {
  const numeric = CLAIMS.filter((c) => /:\d/.test(c.reader)).map((c) => `${c.id} → ${c.reader}`);
  assert.deepEqual(numeric, [], 'a reader must name a path and optionally a symbol, never a line');
});

test('every claim names a file that exists', () => {
  const missing: string[] = [];
  for (const claim of CLAIMS) {
    for (const part of claim.reader.split(',')) {
      const { path } = parseReader(part);
      if (!existsSync(join(SRC, path))) missing.push(`${claim.id} → ${path}`);
    }
  }
  assert.deepEqual(missing, [], 'these claims name a source file that is not there');
});

test('every symbol a claim names appears in the file it names', () => {
  const missing: string[] = [];
  for (const claim of CLAIMS) {
    for (const part of claim.reader.split(',')) {
      const { path, symbol } = parseReader(part);
      if (!symbol) continue;
      const file = join(SRC, path);
      if (!existsSync(file)) continue; // reported by the test above
      if (!new RegExp(`\\b${symbol}\\b`).test(readFileSync(file, 'utf8'))) {
        missing.push(`${claim.id} → ${path}:${symbol}`);
      }
    }
  }
  assert.deepEqual(missing, [], 'these claims name a symbol their file no longer defines');
});

test('every claim id is unique', () => {
  const ids = CLAIMS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate claim id in ${ids.join(', ')}`);
});
