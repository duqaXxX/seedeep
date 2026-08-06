import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Root, Surface } from '../ui/surface.ts';

/** A container that remembers every node it was given, and how many times. */
function stub() {
  const drawn: unknown[] = [];
  const root: Root = { replaceChildren: (node) => void drawn.push(node) };
  return { root, drawn };
}

// The property that matters is not "it drew fewer times" — it is that the node on screen is the
// SAME OBJECT. A user's half-typed URL lives in that node and nowhere else; a fresh element with
// identical markup loses it just as completely as a blank screen would.
test('an unchanged status leaves the node that is on screen alone', () => {
  const { root, drawn } = stub();
  const surface = new Surface(root);
  let built = 0;

  surface.putIfChanged('needsUrl', () => ({ id: ++built }));
  const first = drawn[0];
  for (let tick = 0; tick < 5; tick++) surface.putIfChanged('needsUrl', () => ({ id: ++built }));

  assert.equal(drawn.length, 1, 'five identical readings redrew the screen');
  assert.equal(built, 1, 'the screen was rebuilt even though nothing was drawn');
  assert.equal(drawn[0], first);
});

test('a status that really changed is drawn', () => {
  const { root, drawn } = stub();
  const surface = new Surface(root);

  surface.putIfChanged('needsUrl', () => 'form');
  surface.putIfChanged('offline', () => 'offline');
  surface.putIfChanged('offline', () => 'offline');

  assert.deepEqual(drawn, ['form', 'offline']);
});

// The trap this class exists to make impossible. "Connecting…" is drawn outside the keyed path, so
// without forgetting the key, a connect that FAILS — landing back on the very status that was on
// screen when the button was pressed — would be skipped, and the panel would sit on "Connecting…"
// with no way out.
test('after something unkeyed is drawn, the same status is drawn again', () => {
  const { root, drawn } = stub();
  const surface = new Surface(root);

  surface.putIfChanged('needsUrl', () => 'form');
  surface.put('Connecting…');
  surface.putIfChanged('needsUrl', () => 'form again');

  assert.deepEqual(drawn, ['form', 'Connecting…', 'form again']);
});
