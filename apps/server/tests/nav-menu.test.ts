import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { COMPARE_ID, createNavMenu, HOME_ID, SEARCH_ID } from '../src/client/nav-menu.ts';
import { fakeDoc, findByClass, textOf } from './fake-dom.ts';

// mountMenu swaps the global document per test; put the original back once the file is done.
const prevDoc = (globalThis as any).document;
after(() => {
  (globalThis as any).document = prevDoc;
});

const ITEMS = [
  { id: HOME_ID, label: 'Home', hint: 'retrospective' },
  { id: COMPARE_ID, label: 'Compare', hint: 'sessions' },
  { id: SEARCH_ID, label: 'Search', hint: 'dialogue' },
];

function mountMenu() {
  const doc: any = fakeDoc();
  (globalThis as any).document = doc;
  const mount = doc.createElement('div');
  const switched: string[] = [];
  const menu = createNavMenu(mount, { items: ITEMS, onSwitch: (id) => switched.push(id) });
  const btn = findByClass(mount, 'nav-btn')[0];
  const cur = findByClass(mount, 'nav-cur')[0];
  const rows = findByClass(mount, 'nav-item');
  return { doc, mount, menu, switched, btn, cur, rows };
}

test('the three fixed surfaces are menu items, and picking one switches to it and closes', () => {
  const { mount, switched, btn, rows } = mountMenu();
  assert.deepEqual(
    rows.map((r: any) => textOf(r)),
    ['✦Homeretrospective', '✦Comparesessions', '✦Searchdialogue'],
  );
  assert.equal(mount.classList.contains('open'), false, 'the menu starts closed');
  btn.onclick();
  assert.equal(mount.classList.contains('open'), true);
  assert.equal(btn.getAttribute('aria-expanded'), 'true');
  rows[1].onclick();
  assert.deepEqual(switched, [COMPARE_ID]);
  assert.equal(mount.classList.contains('open'), false, 'picking closes the menu');
});

// The whole reason the trigger carries a label: with the pinned pills gone from the strip,
// NO tab is active while a fixed surface is on screen, so the button is the only thing left
// that can say where you are.
test('setActive: the trigger adopts the surface name, and drops it for a session', () => {
  const { menu, btn, cur, rows } = mountMenu();
  menu.setActive(HOME_ID);
  assert.equal(cur.textContent, 'Home');
  assert.equal(btn.classList.contains('on'), true);
  assert.equal(rows[0].classList.contains('active'), true);
  assert.equal(rows[0].getAttribute('aria-current'), 'page');

  menu.setActive('7f3c1a2e-0000-4000-8000-000000000001'); // a session id, not a fixed surface
  assert.equal(cur.textContent, '', 'nothing to name — the strip carries the active session');
  assert.equal(btn.classList.contains('on'), false);
  assert.equal(rows[0].classList.contains('active'), false);
  assert.equal(btn.title, 'Menu');
});

test('click outside and Escape close the menu; a click inside does not', () => {
  const { doc, mount, btn, rows } = mountMenu();
  btn.onclick();
  doc._fire('click', { target: rows[0] });
  assert.equal(mount.classList.contains('open'), true, 'a click on a menu row is not "outside"');
  doc._fire('click', { target: doc.createElement('div') });
  assert.equal(mount.classList.contains('open'), false);

  btn.onclick();
  doc._fire('keydown', { key: 'Escape' });
  assert.equal(mount.classList.contains('open'), false);
  assert.equal(btn.getAttribute('aria-expanded'), 'false');
});

test('arrows walk the items only while the menu is open', () => {
  const { doc, mount, btn, rows } = mountMenu();
  const focused: string[] = [];
  for (const r of rows) r.focus = () => focused.push(textOf(r));
  doc._fire('keydown', { key: 'ArrowDown', preventDefault() {} });
  assert.deepEqual(focused, [], 'a closed menu ignores the keyboard');

  btn.onclick();
  doc._fire('keydown', { key: 'ArrowDown', preventDefault() {} });
  doc._fire('keydown', { key: 'ArrowDown', preventDefault() {} });
  doc._fire('keydown', { key: 'ArrowUp', preventDefault() {} });
  assert.deepEqual(focused, ['✦Homeretrospective', '✦Comparesessions', '✦Homeretrospective']);
  assert.equal(mount.classList.contains('open'), true);
});
