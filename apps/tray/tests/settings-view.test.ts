import assert from 'node:assert/strict';
import { after, test } from 'node:test';
// Borrowed, like the other two tray view tests: a TEST harness, never shipped code. A second
// faithful fake DOM would be a second one to keep true.
import { fakeDoc, findByClass, textOf } from '../../server/tests/fake-dom.ts';
import type { Local, Status } from '../ui/connection.ts';
import { renderSettings, type SettingsActions, type Versions } from '../ui/settings.ts';

const prevDoc = (globalThis as { document?: unknown }).document;
after(() => {
  (globalThis as { document?: unknown }).document = prevDoc;
});

/** All 32 bytes, which is the point of the block that shows it. */
const FINGERPRINT = '98:62:13:5E:75:38:6E:2A:45:7F:BE:92:65:45:50:A9:66:59:F9:C2:CA:D0:45:DE:7E:A2:7B:5D:DB:7B:A3:13';

const REMOTE = {
  kind: 'connected',
  baseUrl: 'https://box.local:44842',
  fingerprint: FINGERPRINT,
} satisfies Extract<Status, { kind: 'connected' }>;

const LOCAL = {
  kind: 'connected',
  baseUrl: 'http://127.0.0.1:44842',
  fingerprint: null,
} satisfies Extract<Status, { kind: 'connected' }>;

/** Render the view and record every call it makes back into the app. */
function mount(
  status: Extract<Status, { kind: 'connected' }>,
  note?: { text: string; bad?: boolean },
  versions: Versions = { tray: '0.1.1' },
  local: Local = { start: { kind: 'elsewhere' }, canStop: false },
) {
  (globalThis as { document?: unknown }).document = fakeDoc();
  const calls: string[] = [];
  const actions: SettingsActions = {
    back: () => calls.push('back'),
    connect: (url) => calls.push(`connect:${url}`),
    test: () => calls.push('test'),
    stop: () => calls.push('stop'),
  };
  return { node: renderSettings(status, actions, versions, local, note) as unknown, calls };
}

const find = (node: unknown, cls: string) => findByClass(node, cls);
const text = (node: unknown) => textOf(node);
const all = (node: unknown) => text(node);

// What this surface is for, asserted together because "the settings panel" is the claim — a view
// missing one of them is not a smaller version of it, it is a different screen. WHICH events notify
// is no longer among them: the server decides that, and its own panel configures both channels.
test('the things the panel is for are all on the surface', () => {
  const { node } = mount(REMOTE);

  assert.ok(find(node, 'set-host').length, 'the server it is talking to');
  assert.ok(find(node, 'fp-value').length, 'the certificate fingerprint');
  assert.ok(find(node, 'conn-input').length, 'the one field a remote server needs');
  assert.ok(find(node, 'set-test').length, 'the one honest check that notifications arrive at all');
  assert.equal(find(node, 'set-toggle').length, 0, 'and no switch: two places to answer one question');
});

// An abbreviated hash teaches the habit of comparing the first three groups, which is not a
// comparison. Same rule as the trust screen, and the same renderer — this is what proves it.
test('the fingerprint is shown whole, so it can be compared', () => {
  const { node } = mount(REMOTE);

  assert.equal(text(find(node, 'fp-value')[0]), FINGERPRINT);
});

// The three server cases are three different facts. A plaintext local server has no certificate,
// and an empty space where the fingerprint would be reads as "not checked yet" rather than as
// "there is nothing to check".
// The prose explaining WHY a default-local server needs no configuration is gone with the rest of
// the rationale (see `notificationSection`). What has to stay true is that nothing is drawn for a
// connection that has nothing to pin — and that the panel does not invent a warning for it either.
test('a server the tray found by itself shows nothing to configure', () => {
  const { node } = mount(LOCAL);

  assert.equal(find(node, 'fp-value').length, 0, 'no certificate, so nothing to pin');
  assert.doesNotMatch(all(node), /Plain HTTP/, 'the default local server is not a warning');
});

test('a plaintext server that is not the default says what is not verified', () => {
  const { node } = mount({ ...LOCAL, baseUrl: 'http://buildbox.lan:9999' });

  assert.match(all(node), /nothing here is verified/);
  assert.doesNotMatch(all(node), /Pinned certificate/, 'there is nothing to pin');
});
// The About section stays silent about updates until there IS one: a line saying an install is
// current would say nothing on every day but release day.
test('the available update is named only when one exists', () => {
  const current = mount(REMOTE, undefined, { tray: '0.9.0', server: '0.9.0' });
  assert.doesNotMatch(all(current.node), /available/);
});

// The marker goes on the line it is ABOUT. Naming the version once at the bottom left the reader to
// work out WHICH install it applied to — and the case that prompted this had a current tray and a
// stale server, so the answer was not the obvious one.
test('the behind install is the one marked, not both', () => {
  const staleServer = mount(REMOTE, undefined, {
    tray: '1.0.0',
    server: '0.9.0',
    latest: '1.0.0',
    trayBehind: false,
    serverBehind: true,
  });
  const text = all(staleServer.node);
  assert.match(text, /seedeep server 0\.9\.0 — 1\.0\.0 available/);
  assert.doesNotMatch(text, /seedeep tray 1\.0\.0 — /, 'a current tray is not marked');
  assert.match(text, /`seedeep restart`/, 'and the server needs a restart, not just an install');

  const staleTray = mount(REMOTE, undefined, {
    tray: '0.9.0',
    server: '1.0.0',
    latest: '1.0.0',
    trayBehind: true,
    serverBehind: false,
  });
  const trayText = all(staleTray.node);
  assert.match(trayText, /seedeep tray 0\.9\.0 — 1\.0\.0 available/);
  assert.doesNotMatch(trayText, /seedeep server 1\.0\.0 — /);
  assert.match(trayText, /Install the new release over this tray/);
});

// How to update is the PANEL's answer, and it depends on how that server was installed — which only
// the server knows. The third case is the one that was wrong on a real machine: a server too old to
// name its channel was handed the download sentence, so a bun install was told to go and replace an
// executable it does not have.
test('the panel says how to update the server, and never guesses when it was not told', () => {
  const behind = (extra: Partial<Versions>) =>
    all(
      mount(REMOTE, undefined, {
        tray: '1.0.0',
        server: '0.9.0',
        latest: '1.0.0',
        serverBehind: true,
        ...extra,
      }).node,
    );

  const bun = behind({ serverCommand: 'bun install -g seedeep --trust', serverChannel: 'bun' });
  assert.match(bun, /Run `bun install -g seedeep --trust`, then `seedeep restart`/);

  const downloaded = behind({ serverChannel: 'download' });
  assert.match(downloaded, /Replace the server executable with the new release/);

  // Neither a command nor a channel: say WHAT to do and stay silent on HOW.
  const unknown = behind({});
  assert.match(unknown, /Update the server, then `seedeep restart`/);
  assert.doesNotMatch(unknown, /Replace the server executable/, 'never the download sentence by default');
  assert.doesNotMatch(unknown, /Run `/, 'and never an invented command');
});
test('the field hands the pasted URL over, and the back button goes back', () => {
  const { node, calls } = mount(REMOTE);
  const form = find(node, 'conn-form')[0] as { onsubmit: (e: { preventDefault(): void }) => void };
  const input = find(node, 'conn-input')[0] as { value: string };
  input.value = 'https://other.local:44842/?token=abc';

  form.onsubmit({ preventDefault: () => {} });
  (find(node, 'set-back')[0] as { onclick: () => void }).onclick();

  assert.deepEqual(calls, ['connect:https://other.local:44842/?token=abc', 'back']);
});

// The only honest check that exists: the plugin's permission state is a constant on desktop and
// sending a notification reports success even when nothing is shown, so the surface has to offer a
// banner the user can look for — and say that looking is the proof.
test('a test notification can be sent, and the caveat is on the surface', () => {
  const { node, calls } = mount(REMOTE);
  const button = find(node, 'set-test')[0] as { onclick: () => void };

  button.onclick();

  assert.deepEqual(calls, ['test']);
  assert.match(all(node), /the only proof/);
});

// One slot, two tones: a receipt and a failure must not look alike, or "Sent." and "could not be
// saved" would read the same at a glance.
test('a receipt and a failure are told apart', () => {
  const sent = mount(REMOTE, { text: 'Sent.' });
  const failed = mount(REMOTE, { text: 'Could not be saved', bad: true });

  assert.ok(find(sent.node, 'set-said').length, 'a receipt is an ordinary line');
  assert.equal(find(sent.node, 'conn-error').length, 0);
  assert.ok(find(failed.node, 'conn-error').length, 'a failure is not');
  assert.equal(find(failed.node, 'set-said').length, 0);
});

// Above everything, not under the control that produced it: this surface is taller than the popover
// and every render starts it at the top, so a message at the end is one nobody sees.
test('a message is the first thing on the surface', () => {
  const { node } = mount(REMOTE, { text: 'Sent.' });
  const main = find(node, 'set-main')[0] as { children: Array<{ className: string } | undefined> };

  assert.equal(main.children[0]?.className, 'set-said');
});

// The icon is deliberately not covered by the toggle, and the surface has to say so: a user who
// turns notifications off and then sees an amber icon would otherwise think the setting failed.
// Trimming the panel's prose must not take this with it — it prevents a misreading, it does not
// justify a default.
test('the surface says the icon is not what is being turned off', () => {
  const { node } = mount(REMOTE);

  assert.match(all(node), /icon is never silenced/);
});

// A number is worth nothing unless it is clear whose it is: the tray and the server are two
// separate downloads that update apart, so a bare "0.1.1" here would be quoted as the server's often
// enough. Both lines name their own half, and a pair that differs is drawn as the ordinary state it
// is — no warning, because a tray that called a working pair "mismatched" would be inventing a
// problem out of a version string.
test('each version says whose it is, and a difference is not a verdict', () => {
  const { node } = mount(REMOTE, undefined, { tray: '2.4.0', server: '0.5.0' });

  assert.deepEqual(find(node, 'set-version').map(text), ['seedeep tray 2.4.0', 'seedeep server 0.5.0']);
  // The prose may explain that the two update separately — that is what makes a difference readable.
  // What it must not do is judge one of them.
  assert.doesNotMatch(all(node), /out of date|mismatch|should update|please upgrade|newer/i);
});

// Absent, never "unknown": the value comes from a request that a server too old to carry the field
// answers without it, and a placeholder line would be a fact the tray has not got.
test('a server that did not say its version gets no line', () => {
  const { node } = mount(REMOTE, undefined, { tray: '2.4.0' });

  assert.deepEqual(find(node, 'set-version').map(text), ['seedeep tray 2.4.0']);
});

// A heading over a blank line would state that the tray does not know what it is — worse than not
// asking. The version comes from a call that can fail, so this is the case that decides the rule.
test('no version means no About section at all', () => {
  const { node } = mount(REMOTE, undefined, { tray: '' });

  assert.equal(find(node, 'set-version').length, 0);
  assert.doesNotMatch(all(node), /About/);
});

// Stop is drawn from Rust's answer and from nothing else. The panel cannot work out whether a
// process can be named for this address — that takes the records on disk — so a screen that decided
// from `baseUrl` would offer a button for a server it cannot signal.
test('stopping is offered only when Rust can name the process', () => {
  const { node, calls } = mount(LOCAL, undefined, { tray: '0.1.1' }, { start: { kind: 'elsewhere' }, canStop: true });

  const stop = find(node, 'set-stop')[0] as { onclick: () => void };
  stop.onclick();
  assert.deepEqual(calls, ['stop']);

  const { node: remote } = mount(
    REMOTE,
    undefined,
    { tray: '0.1.1' },
    { start: { kind: 'elsewhere' }, canStop: false },
  );
  assert.equal(find(remote, 'set-stop').length, 0, 'a server on another machine is not the tray’s to stop');
});

// The two facts a user is entitled to before clicking: it ends the SERVER, not the tray's view of
// it, and quitting the tray does not do the same thing. Both were decided on the card, and a button
// that stated neither would be read as "hide this".
test('the stop says what it ends, and what quitting the tray does not', () => {
  const { node } = mount(LOCAL, undefined, { tray: '0.1.1' }, { start: { kind: 'elsewhere' }, canStop: true });

  assert.match(all(node), /Stops the server itself/);
  assert.match(all(node), /Quitting the tray does not/);
});
