import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

// A source is not a parser. seedeep reads logs it does not own, and the half that turns a line into
// state is only proven for a root once a real line of that root has travelled the whole way: raw
// jsonl -> the real `parseLine` -> the real reducer -> an asserted snapshot. Hand-built events
// cannot discover that the parser drops a whole class of lines, which is the failure this repo has
// already paid for three times (`.claude/rules/testing.md` keeps the list).
//
// So declaring a new `Root` is the moment `golden-transcript.test.ts` has to grow, and this test is
// what makes that non-optional. It reads the union from its DECLARATION rather than from a runtime
// list, because the declaration is what the rest of the code believes: a variant added there and
// nowhere else is exactly the gap worth catching.

const TYPES = join(import.meta.dirname, '../src/core/types.ts');
const GOLDEN = join(import.meta.dirname, 'golden-transcript.test.ts');

/** The variants of the `Root` union, read from its declaration in `core/types.ts`. */
function declaredRoots(): string[] {
  const m = readFileSync(TYPES, 'utf8').match(/^export type Root = ([^;]+);/m);
  assert.ok(m, 'core/types.ts no longer declares `export type Root` as a one-line union; update this test with it');
  const roots = [...m[1]!.matchAll(/'([a-z-]+)'/g)].map((x) => x[1]!);
  assert.ok(roots.length > 0, `no variants parsed out of: ${m[1]}`);
  return roots;
}

test('every declared Root has a case in the golden transcript', () => {
  const golden = readFileSync(GOLDEN, 'utf8');
  // `root: '<x>'` is how the golden transcript builds a parse context, so its presence is the
  // cheapest honest proxy for "a line of this root reached the reducer here".
  const uncovered = declaredRoots().filter((r) => !golden.includes(`root: '${r}'`));
  assert.deepEqual(
    uncovered,
    [],
    `These session sources have no golden-transcript case: ${uncovered.join(', ')}.\n` +
      `A new source needs raw jsonl lines driven through parseLine and the reducer in\n` +
      `apps/server/tests/golden-transcript.test.ts, not only an adapter unit test. Fixtures are\n` +
      `synthetic in content and faithful in shape: read a real session file of that CLI first.`,
  );
});
