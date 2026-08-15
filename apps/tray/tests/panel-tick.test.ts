// `mock.module` is the reason this file exists at all: `panel.ts` is the one UI module no view test
// could reach, because it talks to Rust at import time. Everything the tray learned about ticks
// wiping a surface was therefore tested on the RENDERERS, which cannot see a tick — and the URL
// field the user asks for by hand was overwritten a second later with nobody's test going red. The
// stub is Bun's rather than node:test's, which has no module registry; the toolchain is bun-only.
import { mock } from 'bun:test';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fakeDoc, fakeWindow, findByClass, textOf } from '../../server/tests/fake-dom.ts';
import type { Local, Status } from '../ui/connection.ts';

const doc = fakeDoc();
(globalThis as { document?: unknown }).document = doc;
const root = doc.getElementById('panel') as ReturnType<typeof fakeDoc>['getElementById'] extends never
  ? never
  : Record<string, unknown>;
// `naturalHeight` measures the panel to size the window. The fake has no layout, so it answers with
// a constant — the height is not what this file is about, and a missing method would throw inside
// every render.
root.getBoundingClientRect = () => ({ height: 200 });
// `panel.ts` only reaches for `addEventListener` — but this goes on the GLOBAL at module scope and
// is never taken down, so every other file in the run sees it. `fakeWindow()` is what stops a stub
// sized for one file from crashing another: three graph tests died on `removeEventListener` here.
(globalThis as { window?: unknown }).window = fakeWindow();

/** Every reading the panel is handed, in order — the tick channel Rust owns. */
let deliver: ((event: { payload: unknown }) => void) | undefined;
/** What the `tick` and `look_again` commands answer with, so a user action reads like the clock. */
let pending: unknown;

mock.module('@tauri-apps/api/core', () => ({
  invoke: async (name: string) => {
    if (name === 'tick' || name === 'look_again') return pending;
    if (name === 'resize') return 200;
    if (name === 'restart_pending') return false;
    if (name === 'connect') {
      if ('err' in connectAnswer) throw new Error(connectAnswer.err);
      return connectAnswer.ok;
    }
    return null;
  },
}));
mock.module('@tauri-apps/api/event', () => ({
  listen: async (_name: string, fn: (event: { payload: unknown }) => void) => {
    deliver = fn;
    return () => {};
  },
}));
mock.module('@tauri-apps/api/app', () => ({ getVersion: async () => '0.0.0-test' }));

await import('../ui/panel.ts');

/** What `connect` answers with, so both endings of a submitted URL can be driven. */
let connectAnswer: { ok: Status } | { err: string } = { err: 'not asked' };

const NOTHING_LOCAL: Local = { start: { kind: 'elsewhere' }, canStop: false };
/** seedeep found on this machine — the reading that changes the screen under an open field. */
const FOUND_LOCAL: Local = { start: { kind: 'ready' }, canStop: false };
const MISSING_LOCAL: Local = { start: { kind: 'notInstalled', dev: false }, canStop: false };
const OFFLINE: Status = { kind: 'offline', baseUrl: 'https://192.0.2.10:44842', detail: 'Connection refused.' };
const FP = '98:62:13:5E:75:38:6E:2A:45:7F:BE:92:65:45:50:A9:66:59:F9:C2:CA:D0:45:DE:7E:A2:7B:5D:DB:7B:A3:13';
const TRUST: Status = { kind: 'awaitingTrust', baseUrl: 'https://192.0.2.10:44842', fingerprint: FP };
const CONNECTED: Status = { kind: 'connected', baseUrl: 'https://192.0.2.10:44842', fingerprint: FP };

/** One reading of the server, as Rust pushes it. */
function reading(status: Status, open = true, local: Local = NOTHING_LOCAL) {
  return { entries: null, open, status, local };
}

/** Hand the panel a reading and let its promises settle, exactly as the poller does. */
async function tick(status: Status, open = true, local: Local = NOTHING_LOCAL): Promise<void> {
  assert.ok(deliver, 'the panel subscribed to the tick channel');
  pending = reading(status, open, local);
  deliver({ payload: pending });
  await settle();
}

/** Let the panel's own promises run out — a command answers over several microtasks. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

/**
 * Put the panel on `status` with nothing asked of it. The module is a singleton, as it is in the
 * app, so a test that just handed it a reading would inherit whatever surface the previous one left
 * up — and the reset is the app's own: a closed popover is a panel back on the sessions.
 */
async function atScreen(status: Status, local: Local = NOTHING_LOCAL): Promise<void> {
  await tick(status, false, local);
  await tick(status, true, local);
}

const find = (cls: string) => findByClass(root, cls);

/**
 * Click the way out of a screen whose other button says yes. Found by its TEXT: `Try again` is drawn
 * with the same class on the offline screen, and clicking that one would test nothing while looking
 * like it had.
 */
function pointElsewhere(): void {
  const alt = find('conn-alt').find((n) => textOf(n) === 'Use a different URL');
  assert.ok(alt, 'the screen offers `Use a different URL`');
  (alt as { onclick: () => void }).onclick();
}

// The bug: the panel changed its own status and drew the field, and the next reading — one second
// later, saying what it had always said, that the stored server is unreachable — put the old screen
// straight back. The field was on screen for less than a tick, which made a second server
// impossible to type in at all.
test('the URL field asked for by hand outlives the ticks that keep reporting the stored server', async () => {
  await atScreen(OFFLINE);
  assert.equal(find('conn-input').length, 0, 'the offline screen has no field of its own');

  pointElsewhere();
  assert.equal(find('conn-input').length, 1, 'the click puts the field up');

  await tick(OFFLINE);
  assert.equal(find('conn-input').length, 1, 'a tick took the field away again');
  await tick(OFFLINE);
  assert.equal(find('conn-input').length, 1, 'the field survives one tick but not the next');
});

// Same rule from the screen that asks a question, where the panel used to overwrite its OWN status
// with `needsUrl` — losing the fingerprint prompt as well as the field.
test('the field outlives the ticks that keep re-offering a certificate to trust', async () => {
  await atScreen(TRUST);
  pointElsewhere();
  assert.equal(find('conn-input').length, 1, 'the click puts the field up');

  await tick(TRUST);
  assert.equal(find('conn-input').length, 1, 'a tick replaced the field with the trust prompt');
});

// The way back, and the only one: while nobody is looking the panel is a mirror, so a field left
// half-typed is not what the next click on the icon shows. The same rule the settings view obeys.
test('closing the popover puts the stored server back', async () => {
  await atScreen(OFFLINE);
  pointElsewhere();
  assert.equal(find('conn-input').length, 1, 'the click puts the field up');

  await tick(OFFLINE, false);
  await tick(OFFLINE);
  assert.equal(find('conn-input').length, 0, 'the field survived the popover being closed');
  assert.equal(find('conn-alt').length, 1, 'the offline screen is back, with its way out');
});

// The redraw is withheld, not merely made a no-op by an unchanged key: a reading that finds seedeep
// on this machine changes the screen the field is drawn on, and rebuilding it would take the
// half-typed address with it — the very loss `putIfChanged` exists to prevent, arriving through the
// other half of the key.
test('a reading that changes what is offered locally does not rebuild the open field', async () => {
  await atScreen(OFFLINE);
  pointElsewhere();
  const [field] = find('conn-input');
  assert.ok(field, 'the click puts the field up');
  (field as { value: string }).value = 'https://192.0.2.77:44842/?token=abc';

  await tick(OFFLINE, true, FOUND_LOCAL);
  const [after] = find('conn-input');
  assert.equal(after, field, 'the field was rebuilt under the user');
  assert.equal((after as { value: string }).value, 'https://192.0.2.77:44842/?token=abc');
});

// The field is not a trap either: it ends the moment it has been answered, whatever the answer is.
// A URL that lands on a certificate to trust must show that question, not keep the form up over it.
test('a URL that connects ends the field', async () => {
  await atScreen(OFFLINE);
  pointElsewhere();
  connectAnswer = { ok: TRUST };
  const [form] = find('conn-form');
  (form as { onsubmit: (e: { preventDefault(): void }) => void }).onsubmit({ preventDefault() {} });
  await settle();

  assert.equal(find('conn-input').length, 0, 'the field outlived the answer it asked for');
  assert.equal(find('fp').length, 1, 'the certificate to trust is what the panel shows');
});

// The other ending: a refused URL leaves the field exactly where it is, with the reason under it.
// Anything else would ask the user to correct an address the panel had just taken away.
test('a URL that fails keeps the field, with the reason', async () => {
  await atScreen(OFFLINE);
  pointElsewhere();
  connectAnswer = { err: 'That is not a URL.' };
  const [form] = find('conn-form');
  (form as { onsubmit: (e: { preventDefault(): void }) => void }).onsubmit({ preventDefault() {} });
  await settle();

  assert.equal(find('conn-input').length, 1, 'the field was taken away by its own error');
  assert.equal(find('conn-error').length, 1, 'the reason is on the screen that has to be corrected');

  await tick(OFFLINE);
  assert.equal(find('conn-input').length, 1, 'a tick took the field away after the error');
});

// `Look again` is the user saying they have changed something HERE, so the reading they asked for is
// what they are waiting to see. Without an ending, the panel would sit on `Looking for seedeep…`
// for good: a tick cannot replace the field's view, and that waiting screen is drawn over it.
test('Look again from the field ends on a screen, never on the waiting one', async () => {
  // Entered from a screen that already knows nothing is installed here: a reading arriving LATER
  // cannot change the field's screen, which is the point of the view.
  await atScreen(OFFLINE, MISSING_LOCAL);
  pointElsewhere();

  const again = find('conn-alt').find((n) => textOf(n) === 'Look again');
  assert.ok(again, 'the field screen offers `Look again` when nothing is installed here');
  (again as { onclick: () => void }).onclick();
  await settle();

  assert.equal(find('conn-looking').length, 0, 'the panel is stuck on the waiting screen');
});

// The third ending, and the one the diff nearly shipped without: `Start seedeep` is offered ON the
// field's own screen when seedeep is installed here, and it answers with a server that is up. A
// panel still showing the form over a running server would be the click doing nothing.
test('starting the server from the field ends it', async () => {
  await atScreen(OFFLINE, FOUND_LOCAL);
  pointElsewhere();
  assert.equal(find('conn-input').length, 1, 'the click puts the field up');

  const go = find('conn-go').find((n) => textOf(n) === 'Start seedeep');
  assert.ok(go, 'the field screen leads with Start when seedeep is installed here');
  // What the reading after the start will say — the server announced itself.
  pending = reading(CONNECTED, true, FOUND_LOCAL);
  (go as { onclick: () => void }).onclick();
  await settle();

  assert.equal(find('conn-input').length, 0, 'the form is still over a server that is running');
});

// A DOM click exists only when the press and the release land on the same element, and the live view
// is redrawn unconditionally once a second. Roughly one press in ten therefore had its button
// swapped out underneath it and produced nothing — reported on the settings button, Windows 11,
// 2026-08-15. The reading is still taken while a pointer is down; only the drawing waits.
/** The node the panel currently has on screen — identity is the assertion, not its contents. */
function drawn(): unknown {
  return (root as { children: unknown[] }).children[0];
}

test('a tick does not rebuild the panel under a pointer that is pressed', async () => {
  await atScreen(CONNECTED);
  const before = drawn();
  assert.ok(before, 'the live view is up');

  doc._fire('pointerdown', {});
  await tick(CONNECTED);
  assert.equal(drawn(), before, 'the surface was replaced under a press');

  // The release does not draw either — that would race the click it exists to protect. The next
  // tick does, which is at most a second away on a surface whose whole cadence is a second.
  doc._fire('pointerup', {});
  assert.equal(drawn(), before, 'nothing is scheduled on the release');
  await tick(CONNECTED);
  assert.notEqual(drawn(), before, 'the tick after the release draws again');
});

// A press released outside the panel, or taken away by the OS, must not leave the panel frozen —
// that would be a worse bug than the one the hold fixes.
test('a cancelled press does not freeze the panel', async () => {
  await atScreen(CONNECTED);
  const before = drawn();
  doc._fire('pointerdown', {});
  await tick(CONNECTED);
  assert.equal(drawn(), before);
  doc._fire('pointercancel', {});
  await tick(CONNECTED);
  assert.notEqual(drawn(), before, 'a cancelled press releases the hold');
});
