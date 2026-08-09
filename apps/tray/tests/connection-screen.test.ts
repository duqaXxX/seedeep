import assert from 'node:assert/strict';
import { after, test } from 'node:test';
// The one thing the tray borrows from the server, and it is a TEST harness, never shipped code:
// duplicating a faithful fake DOM would give the tray a second one to keep true.
import { fakeDoc, findByClass, textOf } from '../../server/tests/fake-dom.ts';
import {
  type Actions,
  asksAQuestion,
  type Local,
  renderConnection,
  renderFooter,
  renderLooking,
  type Status,
} from '../ui/connection.ts';

const prevDoc = (globalThis as { document?: unknown }).document;
after(() => {
  (globalThis as { document?: unknown }).document = prevDoc;
});

const FP = '98:62:13:5E:75:38:6E:2A:45:7F:BE:92:65:45:50:A9:66:59:F9:C2:CA:D0:45:DE:7E:A2:7B:5D:DB:7B:A3:13';
const OTHER = '4A:F1:0C:9B:22:7E:31:D4:88:65:AA:12:FE:03:5C:77:90:B6:E8:41:2D:59:CF:70:1B:A3:64:E9:37:82:D0:15';

/** Nothing to start and nothing to stop — the state every screen but the two local ones is in. */
const NOTHING_LOCAL: Local = { start: { kind: 'elsewhere' }, canStop: false };

/** Render a status and record every action it fired, so a button is exercised and not assumed. */
function mount(status: Exclude<Status, { kind: 'connected' }>, local: Local = NOTHING_LOCAL) {
  (globalThis as { document?: unknown }).document = fakeDoc();
  const calls: string[] = [];
  const actions: Actions = {
    connect: (url) => calls.push(`connect:${url}`),
    trust: () => calls.push('trust'),
    retry: () => calls.push('retry'),
    start: () => calls.push('start'),
    elsewhere: () => calls.push('elsewhere'),
  };
  return { node: renderConnection(status, actions, local) as unknown as Record<string, unknown>, calls };
}

const find = (node: unknown, cls: string) => findByClass(node, cls);
const text = (node: unknown) => textOf(node);

// The whole hash, every time. An abbreviated fingerprint teaches the habit of comparing the first
// three groups, which is not a comparison — and the out-of-band check against the line the server
// prints is the only thing standing between trust-on-first-use and trusting whoever answered.
test('a fingerprint is shown in full, or it cannot be compared', () => {
  for (const status of [
    { kind: 'awaitingTrust', baseUrl: 'https://box.local:44842', fingerprint: FP },
    { kind: 'pinMismatch', baseUrl: 'https://box.local:44842', pinned: OTHER, presented: FP },
  ] satisfies Status[]) {
    const { node } = mount(status);
    const shown = find(node, 'fp-value').map(text);
    assert.ok(shown.includes(FP), `${status.kind}: the presented fingerprint was not shown whole`);
  }
});

// Both values, labelled. A panel that showed only the new one would be asking the user to accept a
// change they cannot see, and the comparison is the entire decision.
test('a changed certificate shows what was pinned next to what is offered', () => {
  const { node } = mount({
    kind: 'pinMismatch',
    baseUrl: 'https://box.local:44842',
    pinned: OTHER,
    presented: FP,
  });

  const shown = find(node, 'fp-value').map(text);
  assert.deepEqual(shown, [OTHER, FP], 'pinned first, then what is being offered');
  const labels = find(node, 'fp-label').map(text);
  assert.equal(labels.length, 2, 'an unlabelled pair of hashes is a puzzle');
  assert.ok(find(node, 'fp--old').length === 1 && find(node, 'fp--new').length === 1);
});

// The dead end this prevents: a state whose only control accepts something. Refusing a certificate
// left the user with the panel and no way past it — quitting the app was the only exit.
test('every state with one accepting button also offers a way out', () => {
  for (const status of [
    { kind: 'awaitingTrust', baseUrl: 'https://box.local:44842', fingerprint: FP },
    { kind: 'pinMismatch', baseUrl: 'https://box.local:44842', pinned: OTHER, presented: FP },
    { kind: 'offline', baseUrl: 'https://box.local:44842', detail: 'timed out' },
  ] satisfies Status[]) {
    const { node, calls } = mount(status);
    const [alt] = find(node, 'conn-alt');
    assert.ok(alt, `${status.kind}: no way out`);
    (alt as { onclick: () => void }).onclick();
    assert.deepEqual(calls, ['elsewhere'], `${status.kind}: the way out did nothing`);
  }
});

test('the pasted URL is what gets sent, verbatim', () => {
  const { node, calls } = mount({ kind: 'needsUrl', localRemote: false });
  const [input] = find(node, 'conn-input');
  const [form] = find(node, 'conn-form');
  (input as { value: string }).value = '  https://box.local:44842/?token=abc  ';

  (form as { onsubmit: (e: { preventDefault(): void }) => void }).onsubmit({ preventDefault() {} });

  // Untouched, whitespace included: trimming belongs to the parser in Rust, which is also what the
  // stored value goes through. Two normalisations are two chances to disagree.
  assert.deepEqual(calls, ['connect:  https://box.local:44842/?token=abc  ']);
});

test('accepting a fingerprint asks Rust to trust it', () => {
  const { node, calls } = mount({
    kind: 'awaitingTrust',
    baseUrl: 'https://box.local:44842',
    fingerprint: FP,
  });

  const [go] = find(node, 'conn-go');
  (go as { onclick: () => void }).onclick();

  assert.deepEqual(calls, ['trust']);
});

// A warning that fires when it does not apply is one the user learns to ignore before it matters.
// The note exists for exactly one case: a seedeep on this machine that still needs its URL.
test('the local-remote note appears only when there is a local server to explain', () => {
  assert.equal(find(mount({ kind: 'needsUrl', localRemote: true }).node, 'conn-note').length, 1);
  assert.equal(find(mount({ kind: 'needsUrl', localRemote: false }).node, 'conn-note').length, 0);
});

// The footer names the server and says nothing about the certificate. A `pinned` chip used to sit
// there and was removed: jargon, and static for as long as the connection lasted. What matters is
// that the removal did not weaken the claim — the footer must not have gained a badge on the
// plaintext side either, and the address must still be the whole of what it states. Rendered on its
// own — the connected surface itself belongs to the bands (`bands.ts`), which put this under them.
test('the footer names the server and claims nothing about the certificate', () => {
  (globalThis as { document?: unknown }).document = fakeDoc();
  const pinned = renderFooter({
    kind: 'connected',
    baseUrl: 'https://box.local:44842',
    fingerprint: FP,
  });
  assert.equal(text(find(pinned, 'conn-host')[0]), 'box.local:44842');
  // The fingerprint is not on this surface in any form — not as a chip, and not smuggled into the
  // text. It lives in Settings, where it can be COMPARED with what the server printed.
  assert.ok(!text(pinned).includes(FP), 'the footer is not where a fingerprint is read');
  // No actions here, so no gear either — and the address is inert rather than a button that would
  // call nothing: the address is the whole of this footer.
  assert.equal(text(pinned).trim(), 'box.local:44842');
  assert.ok(!(find(pinned, 'conn-host')[0] as { onclick?: unknown }).onclick, 'nothing to click');

  const plain = renderFooter({
    kind: 'connected',
    baseUrl: 'http://127.0.0.1:44842',
    fingerprint: null,
  });
  assert.equal(text(find(plain, 'conn-host')[0]), '127.0.0.1:44842');
  // The two footers differ ONLY by the address: a plaintext server has no certificate, and the
  // panel must not imply one by drawing anything the pinned case does not also draw.
  assert.equal(text(plain).trim(), '127.0.0.1:44842');
});

// A refused token is recoverable in place: the field has to be on the same screen as the reason,
// or the panel states a problem and offers nothing to do about it.
test('a refused token asks again on the spot', () => {
  const { node } = mount({ kind: 'unauthorized', baseUrl: 'https://box.local:44842' });

  assert.equal(find(node, 'conn-form').length, 1);
  assert.match(text(find(node, 'conn-body')[0]), /copy the URL again/i);
});

// The reason a server is silent is Rust's to state — it is the only side that knows whether the
// connection was refused or simply never answered. The panel used to add "It is most likely not
// running" next to it, which is right for the first and wrong for the second.
test('the panel adds no guess of its own to a silence', () => {
  const { node } = mount({
    kind: 'offline',
    baseUrl: 'https://box.local:44842',
    detail: 'No answer within 2 seconds — the machine may be asleep or off this network.',
  });

  const prose = find(node, 'conn-body').map(text);
  assert.deepEqual(prose, ['No answer within 2 seconds — the machine may be asleep or off this network.']);
});

// A waiting screen with a button is a screen the user thinks is waiting for THEM.
test('the waiting screen says one thing and offers nothing', () => {
  (globalThis as { document?: unknown }).document = fakeDoc();
  const node = renderLooking('Looking for seedeep…') as unknown as Record<string, unknown>;

  assert.equal(text(find(node, 'conn-looking')[0]), 'Looking for seedeep…');
  for (const cls of ['conn-go', 'conn-alt', 'conn-form', 'conn-input']) {
    assert.equal(find(node, cls).length, 0, `the waiting screen offered a ${cls}`);
  }
});

// The clock must not answer for the user. Rust reports what it can REACH, and a fingerprint waiting
// to be confirmed is not stored — so the poll's honest answer is "nothing is stored, paste a URL",
// which is the screen that erases the prompt. The trust screen used to appear for a fraction of a
// second and vanish, and a self-signed server could not be accepted at all.
//
// Asserted against the RENDER rather than against a list of names: a screen that shows a fingerprint
// is one asking the user to accept an identity, so a third one added later fails this until it is
// registered — which is the only way a rule like this stays true.
test('every screen that asks the user to accept an identity is one a tick may not replace', () => {
  const every = [
    { kind: 'needsUrl', localRemote: false },
    { kind: 'needsUrl', localRemote: true },
    { kind: 'awaitingTrust', baseUrl: 'https://box.local:44842', fingerprint: FP },
    { kind: 'pinMismatch', baseUrl: 'https://box.local:44842', pinned: OTHER, presented: FP },
    { kind: 'unauthorized', baseUrl: 'https://box.local:44842' },
    { kind: 'offline', baseUrl: 'https://box.local:44842', detail: 'Connection refused' },
  ] satisfies Exclude<Status, { kind: 'connected' }>[];

  for (const status of every) {
    const { node } = mount(status);
    const decides = find(node, 'fp').length > 0;
    assert.equal(
      asksAQuestion(status),
      decides,
      `${status.kind}: the screen and the rule disagree about whether it is being answered`,
    );
  }
});

// A connected server is not a question either — its surface is the bands, which DO change every
// tick and must keep being redrawn.
test('a connected server is never treated as a pending question', () => {
  assert.equal(asksAQuestion({ kind: 'connected', baseUrl: 'http://127.0.0.1:44842', fingerprint: null }), false);
});

const CAN_START: Local = { start: { kind: 'ready' }, canStop: false };

// The first-run dead end this card exists to remove: seedeep installed, nothing running, and a
// screen whose only instruction is to open a portal that is not up on a server that does not exist.
// With something to run, the button IS the answer and the paste field is the alternative.
test('with seedeep on this machine and nothing running, the screen leads with Start', () => {
  const { node, calls } = mount({ kind: 'needsUrl', localRemote: false }, CAN_START);

  const [go] = find(node, 'conn-go');
  assert.equal(text(go), 'Start seedeep');
  (go as { onclick: () => void }).onclick();
  assert.deepEqual(calls, ['start']);
  // Not INSTEAD of the remote case: a machine that can run one may still want to watch another.
  assert.equal(find(node, 'conn-form').length, 1);
});

// The dead end this replaced: with nothing installed, the screen fell through to "open the portal
// on the machine running seedeep and copy the URL" — advice about a server somewhere else, given to
// somebody who had just switched off the one in front of them. It now says which case it is in, and
// the two cases need different instructions.
test('nothing installed says so, and says the right thing for the build it is', () => {
  const release = mount(
    { kind: 'needsUrl', localRemote: false },
    {
      start: { kind: 'notInstalled', dev: false },
      canStop: false,
    },
  );
  assert.match(text(release.node), /not installed on this machine/);
  assert.match(text(release.node), /npm i -g seedeep/);
  assert.equal(find(release.node, 'conn-go--wide').length, 0, 'nothing to start means no button');
  assert.equal(find(release.node, 'conn-form').length, 1, 'the remote way out stays');
  // The text names a control, so the control has to be on THIS screen: 'Try again' is only on the
  // one that says a server is not answering, and the 30-second retry is not an answer to somebody
  // who has just finished installing.
  const [look] = find(release.node, 'conn-alt');
  assert.equal(text(look), 'Look again');
  (look as { onclick: () => void }).onclick();
  assert.deepEqual(release.calls, ['retry']);

  // A checkout's server is `bun run dev`, which the tray cannot exec — telling this user to install
  // a release would send them away from the thing they are working on.
  const dev = mount(
    { kind: 'needsUrl', localRemote: false },
    {
      start: { kind: 'notInstalled', dev: true },
      canStop: false,
    },
  );
  assert.match(text(dev.node), /bun run dev/);
  assert.doesNotMatch(text(dev.node), /npm i -g/);
});

// A stored local server that is silent, with nothing installed: the reason has to be on THAT screen
// too, or Stop is a one-way door with no explanation.
test('a silent local server with nothing installed explains itself', () => {
  const { node } = mount(
    { kind: 'offline', baseUrl: 'http://127.0.0.1:44842', detail: 'Connection refused' },
    { start: { kind: 'notInstalled', dev: true }, canStop: false },
  );

  assert.match(text(node), /bun run dev/);
  assert.equal(find(node, 'conn-alt').length, 1, 'Use a different URL is still the way out');
});

test('nothing to run means no Start anywhere', () => {
  for (const status of [
    { kind: 'needsUrl', localRemote: false },
    { kind: 'needsUrl', localRemote: true },
    { kind: 'offline', baseUrl: 'http://127.0.0.1:44842', detail: 'Connection refused' },
    { kind: 'unauthorized', baseUrl: 'http://127.0.0.1:44842' },
  ] satisfies Exclude<Status, { kind: 'connected' }>[]) {
    const { node } = mount(status);
    assert.ok(!text(node).includes('Start seedeep'), `${status.kind}: a button that has nothing to run`);
  }
});

// A stored local server that is silent is the second place Start belongs — and Try again has to
// survive it, demoted: a server coming up on its own is a real case, and losing the retry would
// leave the only recovery being to start a second one.
test('a silent local server offers Start, and keeps every way out it had', () => {
  const { node, calls } = mount(
    { kind: 'offline', baseUrl: 'http://127.0.0.1:44842', detail: 'Connection refused' },
    CAN_START,
  );

  const [go] = find(node, 'conn-go');
  assert.equal(text(go), 'Start seedeep', 'the primary action is the one that fixes it');
  (go as { onclick: () => void }).onclick();

  const alts = find(node, 'conn-alt');
  assert.deepEqual(alts.map(text), ['Try again', 'Use a different URL']);
  for (const alt of alts) (alt as { onclick: () => void }).onclick();

  assert.deepEqual(calls, ['start', 'retry', 'elsewhere']);
});
