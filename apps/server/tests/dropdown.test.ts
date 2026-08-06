import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDropdown } from '../src/client/dropdown.ts';
import type { SessionRecord } from '../src/core/types.ts';
import { fakeDoc, findByClass } from './fake-dom.ts';
import { rec } from './session-record.ts';

// Build the REAL dropdown against a fake DOM, feed rows, open it (list renders lazily on
// open, on the Human tab by default), and hand back the pieces a test drives.
function mountPicker(rows: SessionRecord[]) {
  const doc: any = fakeDoc();
  (globalThis as any).document = doc;
  const mount = doc.createElement('div');
  const opened: string[] = [];
  const dd = createDropdown(mount, { onOpen: (id: string) => opened.push(id) });
  dd.update(rows);
  mount.children[0].onclick(); // the trigger → open → render the list
  return { mount, opened, doc, dd };
}
const text = (n: any) => n.textContent;
const clickTab = (mount: any, i: number) => findByClass(mount, 'pk-tab')[i].onclick(); // 0=Human, 1=Automated

test('opens on the Human tab; automated is hidden until you switch tabs', () => {
  const { mount } = mountPicker([
    rec({ sessionId: 'h1', isActive: true, subject: 'human work' }),
    rec({ sessionId: 'a1', isActive: true, entrypoint: 'sdk-cli', subject: 'You are a gate' }),
  ]);
  assert.deepEqual(findByClass(mount, 'pk-prompt').map(text), ['human work']); // Human tab only
  assert.deepEqual(findByClass(mount, 'pk-count').map(text), ['1', '1']); // both counts shown
  clickTab(mount, 1);
  assert.deepEqual(findByClass(mount, 'pk-prompt').map(text), ['You are a gate']); // Automated tab
});

// The picker lists every session, including the ones already showing in a tab —
// picking one of those only switches to it. The pin says which those are.
test('pin marks exactly the sessions that already have a tab', () => {
  const { mount, dd } = mountPicker([
    rec({ sessionId: 'h1', isActive: true, subject: 'has a tab' }),
    rec({ sessionId: 'h2', isActive: true, subject: 'no tab' }),
  ]);
  assert.equal(findByClass(mount, 'pin').length, 0, 'no tabs open yet → no pins');
  dd.setOpenTabs(['h1']);
  const pinned = findByClass(mount, 'pk-row').filter((r: any) => findByClass(r, 'pin').length);
  assert.equal(pinned.length, 1);
  assert.equal(text(findByClass(pinned[0], 'pk-prompt')[0]), 'has a tab');
});

test('pin follows the tabs, not the roster: closing a tab clears it, opening another moves it', () => {
  // The roster only re-renders when its identity set changes (sessions.ts rosterKey), so a
  // pin driven by roster.onChange would freeze the moment a tab opened. It must redraw here.
  const { mount, dd } = mountPicker([
    rec({ sessionId: 'h1', isActive: true, subject: 'first' }),
    rec({ sessionId: 'h2', isActive: true, subject: 'second' }),
  ]);
  const pinnedSubjects = () =>
    findByClass(mount, 'pk-row')
      .filter((r: any) => findByClass(r, 'pin').length)
      .map((r: any) => text(findByClass(r, 'pk-prompt')[0]));
  dd.setOpenTabs(['h1', 'h2']);
  assert.deepEqual(pinnedSubjects(), ['first', 'second']);
  dd.setOpenTabs(['h2']);
  assert.deepEqual(pinnedSubjects(), ['second'], 'a closed tab drops its pin');
  dd.setOpenTabs([]);
  assert.deepEqual(pinnedSubjects(), []);
});

test('an automated session shows its real prompt and no per-row chip', () => {
  const { mount } = mountPicker([
    rec({ sessionId: 'h', isActive: true, subject: 'human work' }),
    rec({
      sessionId: 'a',
      isActive: true,
      entrypoint: 'sdk-cli',
      model: 'claude-haiku-4-5-20251001',
      subject: 'You are a documentation-freshness gate',
    }),
  ]);
  clickTab(mount, 1);
  assert.equal(text(findByClass(mount, 'pk-prompt')[0]), 'You are a documentation-freshness gate');
  assert.equal(findByClass(mount, 'pk-badge').length, 0); // no type chip
});

test('within a tab, sessions group under Live / Inactive headers', () => {
  const { mount } = mountPicker([
    rec({ sessionId: 'a', isOpen: true, isActive: true, subject: 'live' }),
    rec({ sessionId: 'b', isOpen: false, isActive: false, subject: 'old' }),
  ]);
  assert.deepEqual(findByClass(mount, 'pk-ghead').map(text), ['Live', 'Inactive']);
  assert.equal(findByClass(mount, 'pk-row').length, 2);
});

// A session whose process is alive but whose parent jsonl has been silent past the mtime
// window (it is waiting on a background subagent, which writes to a SEPARATE file) is LIVE.
// Grouping it under Inactive contradicted the tab strip, which reads the same session as
// open — one UI, two liveness rules. Measured: 21% of sessions with subagents hit this.
test('a session with a live process groups under Live even past the mtime window', () => {
  const { mount } = mountPicker([
    rec({ sessionId: 'a', isOpen: true, isActive: false, subject: 'waiting on a background subagent' }),
    rec({ sessionId: 'b', isOpen: false, isActive: false, subject: 'old' }),
  ]);
  assert.deepEqual(findByClass(mount, 'pk-ghead').map(text), ['Live', 'Inactive']);
  assert.deepEqual(findByClass(mount, 'pk-prompt').map(text), ['waiting on a background subagent', 'old']);
  assert.ok(findByClass(mount, 'pk-row')[0].className.includes('active')); // and its dot says so
});

test('a human row shows its subject and model chip, and no type chip', () => {
  const { mount } = mountPicker([rec({ isActive: true, subject: 'refactor the reducer', model: 'claude-opus-4-8' })]);
  assert.equal(text(findByClass(mount, 'pk-prompt')[0]), 'refactor the reducer');
  assert.equal(text(findByClass(mount, 'pk-mchip')[0]), 'Opus');
  assert.equal(findByClass(mount, 'pk-badge').length, 0);
});

test('the search box filters the active tab', () => {
  const { mount } = mountPicker([
    rec({ sessionId: 'a', isActive: true, subject: 'fix the toast bug' }),
    rec({ sessionId: 'b', isActive: true, subject: 'refactor the reducer' }),
  ]);
  const input = findByClass(mount, 'pk-input')[0];
  input.value = 'toast';
  input.oninput();
  assert.deepEqual(findByClass(mount, 'pk-prompt').map(text), ['fix the toast bug']);
});

test('a row\u2019s id is the shared chip: the prefix here, the whole uuid on the clipboard', async () => {
  // The picker row is narrow, so it keeps showing 8 characters \u2014 but the id stopped being dead
  // text: it is the same component the Search row uses, and it copies the id `claude --resume`
  // needs. A regression that drops the chip, or that switches this surface to the full uuid, is
  // what this catches.
  const copied: string[] = [];
  (globalThis as any).navigator = {
    clipboard: {
      writeText: async (v: string) => {
        copied.push(v);
      },
    },
  };
  const id = 'aaaaaaaa-1111-2222-3333-444444444444';
  const { mount, opened } = mountPicker([rec({ sessionId: id, isActive: true })]);
  const chip = findByClass(mount, 'idchip')[0];
  assert.equal(text(chip), 'aaaaaaaa');
  chip.onclick({ stopPropagation() {} });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(copied, [id], 'the WHOLE uuid, not the eight it shows');
  assert.deepEqual(opened, [], 'copying an id is not picking the session');
});

test('clicking a row opens that session and closes the popover', () => {
  const { mount, opened } = mountPicker([rec({ sessionId: 'pick-me', isActive: true })]);
  assert.ok(mount.classList.contains('open'));
  findByClass(mount, 'pk-row')[0].onclick();
  assert.deepEqual(opened, ['pick-me']);
  assert.ok(!mount.classList.contains('open'));
});

test('while closed the list is empty — it renders lazily on open', () => {
  const doc: any = fakeDoc();
  (globalThis as any).document = doc;
  const mount = doc.createElement('div');
  createDropdown(mount, { onOpen() {} }).update([rec({ isActive: true }), rec({ isActive: true })]);
  assert.equal(findByClass(mount, 'pk-row').length, 0);
});

// --- interactions (document-level handlers, dispatched via the fake DOM) ----------

test('Escape closes the popover', () => {
  const { mount, doc } = mountPicker([rec({ isActive: true })]);
  assert.ok(mount.classList.contains('open'));
  doc._fire('keydown', { key: 'Escape', preventDefault() {} });
  assert.ok(!mount.classList.contains('open'));
});

test('a click outside closes; a click inside keeps it open', () => {
  const { mount, doc } = mountPicker([rec({ isActive: true })]);
  doc._fire('click', { target: doc.createElement('div') });
  assert.ok(!mount.classList.contains('open'), 'outside click closes');
  mount.children[0].onclick(); // reopen
  doc._fire('click', { target: findByClass(mount, 'pk-row')[0] });
  assert.ok(mount.classList.contains('open'), 'inside click keeps it open');
});

test('ArrowDown moves the highlight and Enter opens the highlighted row', () => {
  const { mount, doc, opened } = mountPicker([
    rec({ sessionId: 'r1', isActive: true, subject: 'first' }),
    rec({ sessionId: 'r2', isActive: true, subject: 'second' }),
  ]);
  const rows = findByClass(mount, 'pk-row');
  assert.ok(rows[0].classList.contains('hl'), 'first row is pre-highlighted');
  doc._fire('keydown', { key: 'ArrowDown', preventDefault() {} });
  assert.ok(rows[1].classList.contains('hl') && !rows[0].classList.contains('hl'), 'highlight moved down');
  doc._fire('keydown', { key: 'Enter', preventDefault() {} });
  assert.deepEqual(opened, ['r2']);
});

test('a background roster refresh keeps the highlight on its session, not its index', () => {
  const { mount, doc, dd } = mountPicker([
    rec({ sessionId: 'r1', isActive: true, subject: 'first' }),
    rec({ sessionId: 'r2', isActive: true, subject: 'second' }),
  ]);
  doc._fire('keydown', { key: 'ArrowDown', preventDefault() {} }); // highlight r2 (index 1)
  // roster refresh (still open) prepends a new active session, pushing r2 to index 2
  dd.update([
    rec({ sessionId: 'r0', isActive: true, subject: 'zero' }),
    rec({ sessionId: 'r1', isActive: true, subject: 'first' }),
    rec({ sessionId: 'r2', isActive: true, subject: 'second' }),
  ]);
  const rows = findByClass(mount, 'pk-row');
  assert.equal(text(findByClass(rows[2], 'pk-prompt')[0]), 'second');
  assert.ok(rows[2].classList.contains('hl'), 'highlight follows r2 to its new position');
  assert.ok(!rows[0].classList.contains('hl'));
});
