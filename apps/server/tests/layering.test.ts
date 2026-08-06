import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

// `src/` is three layers and they are not interchangeable: `server/` opens files and sockets,
// `client/` runs in a browser, `core/` is the pure derivation both of them share. Nothing in the
// toolchain enforces that. The type-checker hands the client the node types, and
// `bun build --target browser` does not fail on a node: builtin — it substitutes a POLYFILL that
// throws, so a client file importing the watcher compiles clean and breaks in the browser as a
// blank page (measured before this test existed).
//
// Both rules below are followed through the import GRAPH, not the directory listing: a server-only
// module pulled in three hops down is just as fatal as a direct import.
const SRC = resolve(import.meta.dirname, '..', 'src');

/** Every import specifier named in `file`, relative ones and bare/`node:` ones alike. */
function importsOf(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  return [...src.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
}

/**
 * Walk the relative-import graph from `entry` and return one chain (entry first) per import that
 * breaks `forbid` — the chain is the point, since the offending import is rarely a direct one.
 */
function violationsFrom(entry: string, forbid: (spec: string, from: string) => boolean): string[][] {
  const out: string[][] = [];
  const seen = new Set<string>();
  const walk = (file: string, chain: string[]): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const here = [...chain, relative(SRC, file)];
    for (const spec of importsOf(file)) {
      if (forbid(spec, file)) {
        out.push([...here, spec]);
        continue;
      }
      // A bare package name is the bundler's problem; a .json import is a leaf.
      if (!spec.startsWith('.') || spec.endsWith('.json')) continue;
      walk(resolve(dirname(file), spec), here);
    }
  };
  walk(entry, []);
  return out;
}

const asText = (chains: string[][]) => chains.map((c) => c.join(' -> '));

test('nothing reachable from the client entry imports a node: builtin', () => {
  const chains = violationsFrom(join(SRC, 'client', 'app.ts'), (spec) => spec.startsWith('node:'));
  assert.deepEqual(asText(chains), [], 'server-only code is reachable from src/client/app.ts');
});

test('core/ stays pure — no node: builtin, and nothing from server/ or client/', () => {
  const forbid = (spec: string, from: string): boolean => {
    if (spec.startsWith('node:') || spec === 'bun') return true;
    if (!spec.startsWith('.')) return false;
    const target = relative(SRC, resolve(dirname(from), spec));
    return target.startsWith('server/') || target.startsWith('client/');
  };
  const chains = readdirSync(join(SRC, 'core'))
    .filter((f) => f.endsWith('.ts'))
    .flatMap((f) => violationsFrom(join(SRC, 'core', f), forbid));
  // Deduplicated: every core file is walked as its own entry, so a shared dependency repeats.
  assert.deepEqual([...new Set(asText(chains))].sort(), [], 'core/ is no longer runtime-agnostic');
});
