import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createIdChip } from '../src/client/id-chip.ts';
import { fakeDoc } from './fake-dom.ts';

// The chip exists for one reason: `claude --resume` needs the WHOLE uuid, and the GUI only ever
// showed eight characters of it. A chip that copies what it displays is the bug, not the feature.

const UUID = 'ede0fc1a-73d6-4af4-b8d4-8f1b34c122d0';

function mount(clipboard?: { writeText: (s: string) => Promise<void> }, full = false) {
  const doc: any = fakeDoc();
  (globalThis as any).document = doc;
  (globalThis as any).navigator = clipboard ? { clipboard } : {};
  return createIdChip(UUID, full ? { full: true } : {});
}

test('the chip shows the short id and copies the FULL uuid', async () => {
  const copied: string[] = [];
  const chip: any = mount({
    writeText: async (s) => {
      copied.push(s);
    },
  });
  assert.equal(chip.textContent, 'ede0fc1a');
  assert.ok(chip.title.includes(UUID), 'the whole id is reachable without clicking, too');
  chip.onclick({ stopPropagation() {} });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(copied, [UUID]);
  assert.equal(chip.textContent, 'copied');
  assert.ok(chip.className.includes('copied'));
});

test('the click never reaches the row behind it — copying an id is not opening a session', () => {
  let stopped = false;
  const chip: any = mount({ writeText: async () => {} });
  chip.onclick({
    stopPropagation() {
      stopped = true;
    },
  });
  assert.equal(stopped, true);
});

test('a refused copy leaves the chip telling the truth', async () => {
  const chip: any = mount({ writeText: () => Promise.reject(new Error('denied')) });
  chip.onclick({ stopPropagation() {} });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(chip.textContent, 'ede0fc1a', 'never claims a copy the browser refused');
  assert.ok(!chip.className.includes('copied'));
});

test('a browser without a clipboard API does not throw', () => {
  const chip: any = mount(); // navigator.clipboard undefined
  assert.doesNotThrow(() => chip.onclick({ stopPropagation() {} }));
  assert.equal(chip.textContent, 'ede0fc1a');
});

test('`full` shows the whole uuid — the id you paste into `claude --resume`, readable without a click', async () => {
  const copied: string[] = [];
  const chip: any = mount(
    {
      writeText: async (s) => {
        copied.push(s);
      },
    },
    true,
  );
  assert.equal(chip.textContent, UUID);
  chip.onclick({ stopPropagation() {} });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(copied, [UUID]);
  await new Promise((r) => setTimeout(r, 1700));
  assert.equal(chip.textContent, UUID, 'and it comes back whole after confirming, not truncated');
});
