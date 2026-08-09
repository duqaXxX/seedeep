/**
 * The settings view: the one surface of the tray that is not a session.
 *
 * A view inside the popover, not a window of its own. The popover dismisses on focus loss, which is
 * what makes it feel like a menu; a second window would either inherit that rule and vanish while
 * being used, or break it and leave the app with two competing surfaces. Reached from the footer's
 * gear, left with the header's back button.
 *
 * Free of Tauri, like the rest of `ui/`: settings in, DOM out, callbacks for what only the app can
 * do. That is what lets the states be rendered at real scale without a server to produce them.
 */
import { fingerprintBlock, type Local, type Status, urlForm } from './connection.ts';

/**
 * The two versions this build can name: the tray's own, and the server's when it answered with one.
 *
 * Two values and not one, because they are two downloads. They leave the repository under a single
 * tag, and they are updated apart — a tray installed today next to a `seedeep` from two months ago
 * is an ordinary state, and a single number would be quoted as though it described both.
 */
export interface Versions {
  tray: string;
  /** Absent when the server did not say — an older release, or a read that failed. Never guessed. */
  server?: string;
  /** npm's newest, when the server's check knows one. Absent is "nothing to report". */
  latest?: string;
  /** Whether the TRAY is older than `latest` — panel only; the notification is about the server. */
  trayBehind?: boolean;
  /** Whether the SERVER is older than `latest`, as the server itself judged. */
  serverBehind?: boolean;
  /** The command that updates the server, as the server reported it. */
  serverCommand?: string;
  /** How the server was installed, when it said — see {@link updateAdvice}. */
  serverChannel?: string;
}

/** What the app has stored — see `settings.rs`. */
export interface Prefs {
  notify: boolean;
  notifyFinished: boolean;
  notifyFailed: boolean;
  notifyUpdate: boolean;
}

/** The message the last action came back with. `bad` is a failure; anything else is a receipt. */
export interface Note {
  text: string;
  bad?: boolean;
}

/** What the settings view can ask the app to do. */
export interface SettingsActions {
  /** Back to the sessions. */
  back(): void;
  setNotify(on: boolean): void;
  setNotifyFinished(on: boolean): void;
  setNotifyFailed(on: boolean): void;
  setNotifyUpdate(on: boolean): void;
  /** Point the tray at another server — the same act as the connection screen's. */
  connect(url: string): void;
  /** Send one notification now. The only way to find out whether they arrive at all. */
  test(): void;
  /** Stop the server the tray is connected to. Offered only when {@link Local.canStop}. */
  stop(): void;
}

/** The address the tray tries by itself, and the one case where nothing was configured at all. */
const DEFAULT_LOCAL = 'http://127.0.0.1:44842';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function section(title: string): HTMLElement {
  const node = el('section', 'set-sec');
  node.append(el('h3', 'set-label', title));
  return node;
}

/**
 * A switch, as a button rather than a checkbox: `onclick` is this codebase's idiom and the one the
 * view-level tests invoke, and `aria-checked` is a state a test can read — a styled checkbox at this
 * size would be neither.
 */
function toggle(on: boolean, label: string, onChange: (on: boolean) => void): HTMLElement {
  const row = el('div', 'set-row');
  const button = el('button', `set-toggle${on ? ' set-toggle--on' : ''}`);
  button.type = 'button';
  button.setAttribute('role', 'switch');
  button.setAttribute('aria-checked', String(on));
  button.setAttribute('aria-label', label);
  button.append(el('i', 'set-knob'));
  button.onclick = () => onChange(!on);
  row.append(el('span', 'set-row-label', label), button);
  return row;
}

/**
 * What the server section says, which is three different facts and not one with holes in it.
 *
 * A pinned certificate is shown whole, for the same comparison the first connection asked for. A
 * plaintext server has none, and saying nothing there would let the absence read as "not checked
 * yet". And the default local address is the case where the user configured nothing at all — worth
 * stating, because a settings screen that lists no settings otherwise looks broken.
 */
function serverSection(
  status: Extract<Status, { kind: 'connected' }>,
  actions: SettingsActions,
  local: Local,
): HTMLElement {
  const node = section('Server');
  node.append(el('div', 'set-host', status.baseUrl));
  // The prose that used to sit under each of these is gone: it explained why the DEFAULT is what it
  // is, which is a design rationale (it lives in `docs/tray.md`) and not something a user needs on
  // every open. Measured before the cut: this view was 991px of content in a 514px viewport — two of
  // the four switches, and the whole About section, fell below the fold.
  if (status.fingerprint) {
    node.append(fingerprintBlock('Pinned certificate', status.fingerprint));
  } else if (status.baseUrl !== DEFAULT_LOCAL) {
    // The one case worth a word: no certificate at all is a property of the connection, not a
    // default anyone chose.
    node.append(el('p', 'set-note', 'Plain HTTP — nothing here is verified beyond the address.'));
  }
  // Here and not among the sessions: stopping a server is rare, it is the opposite of what the
  // panel's live surface is for, and a control that ends everything on screen does not belong in a
  // list the user is scanning. Drawn only when Rust can name a single process for this address —
  // which is never the case for a server on another machine.
  if (local.canStop) {
    const stop = el('button', 'set-stop', 'Stop seedeep');
    stop.type = 'button';
    stop.onclick = () => actions.stop();
    // Kept: it is the one control here that ends something the user can see, and "not just the tray"
    // is the part nobody would guess.
    node.append(
      stop,
      el('p', 'set-note', 'Stops the server itself — the portal stops too. Quitting the tray does not.'),
    );
  }
  node.append(
    el('h4', 'set-sub', 'Point the tray elsewhere'),
    urlForm((url) => actions.connect(url), 'Connect'),
  );
  return node;
}

/**
 * The notification section: four switches, the heading that completes their sentence, and ONE note.
 *
 * **The prose under each switch is gone** (Davide's call, 2026-08-05, from a prototype at the real
 * 392×560). It explained why each DEFAULT was chosen — a design rationale, which lives in
 * `docs/tray.md` and does not need re-reading every time the panel opens. Measured: this view was
 * 991px of content in a 514px viewport, so two of the four switches and the whole About section sat
 * below the fold; without it the view is 557px and effectively fits.
 *
 * The interruption rule is NOT on the label (Davide's call, 2026-08-06): a turn you stopped
 * yourself never notifies, and saying so out loud only made a reader wonder what the exception was
 * for. If you pressed Esc you already know. It stays in `docs/tray.md`, where a rule belongs.
 *
 * The heading is "Notify me when", so each row completes it and "Notify when a…" stops being
 * repeated four times.
 *
 * The single surviving note is the honest caveat: there is no way to ASK whether notifications will
 * arrive — the plugin's permission state is a hardcoded `Granted` on desktop and sending one returns
 * success even when nothing is shown (`docs/tray.md`) — so the only check that exists is to send one
 * and look.
 */
function notificationSection(prefs: Prefs, actions: SettingsActions): HTMLElement {
  const node = section('Notify me when');
  node.append(
    toggle(prefs.notify, 'A session needs you', (on) => actions.setNotify(on)),
    toggle(prefs.notifyFailed, 'A session fails', (on) => actions.setNotifyFailed(on)),
    toggle(prefs.notifyFinished, 'A session finishes', (on) => actions.setNotifyFinished(on)),
    toggle(prefs.notifyUpdate, 'A new server version is out', (on) => actions.setNotifyUpdate(on)),
  );
  // Not the accent button `Connect` uses: this is a diagnostic, and drawn as the primary action of
  // the surface it read as the thing the screen is FOR.
  const test = el('button', 'set-test', 'Send a test notification');
  test.type = 'button';
  test.onclick = () => actions.test();
  node.append(
    test,
    el(
      'p',
      'set-note',
      'A banner is the only proof — the system can hide them silently. The menu-bar icon is never silenced.',
    ),
  );
  return node;
}

/**
 * Which builds these are — the tray's, and the server's when it answered with one.
 *
 * Here rather than in the footer, for the reason the `pinned` chip was removed from it: a value that
 * never changes while the panel is open stops being read where the sessions are, and this surface is
 * already where the static, quotable facts live (the pinned fingerprint).
 *
 * Each line says WHOSE version it is. The two leave the repository under one tag and are updated
 * apart, so they can legitimately differ; no judgement is drawn from that here, because a tray that
 * called a working pair "mismatched" would be inventing a problem out of a version string.
 */
/**
 * How to update the SERVER — the panel's job, not the banner's: a notification is read once and
 * dismissed, while this can be read twice and carries a command to copy.
 *
 * Three cases, and telling the last two apart is the point. A server names its own channel
 * (`/api/update`), so `bun`/`npm` get their exact command and a downloaded executable is told it is
 * replaced by hand. A server too old to say ANYTHING gets neither — and must not be handed the
 * download sentence as a default, which is how a bun install came to be told to go and replace an
 * executable it does not have.
 */
function updateAdvice(versions: Versions): string {
  const restart = 'then `seedeep restart` — a running server keeps its old code until you do.';
  if (versions.serverCommand) return `Run \`${versions.serverCommand}\`, ${restart}`;
  if (versions.serverChannel === 'download') {
    return `Replace the server executable with the new release, ${restart}`;
  }
  // Says WHAT to do and stays silent on HOW, which is the honest answer when the server did not say.
  return `Update the server, ${restart}`;
}

function aboutSection(versions: Versions): HTMLElement {
  const node = section('About');
  // The marker goes on the line it is ABOUT. Naming the new version once at the bottom left the
  // reader to work out WHICH of the two installs it applied to — and on the day this was written the
  // answer was "the server", while the tray was already current.
  const line = (label: string, version: string, behind: boolean) =>
    el(
      'div',
      behind ? 'set-version set-version--update' : 'set-version',
      behind ? `${label} ${version} — ${versions.latest} available` : `${label} ${version}`,
    );
  node.append(line('seedeep tray', versions.tray, !!versions.trayBehind));
  // Absent rather than "unknown": a server too old to carry the field, or a read that failed, is
  // not a fact about the server worth a line of its own.
  if (versions.server) node.append(line('seedeep server', versions.server, !!versions.serverBehind));
  // "They are separate downloads and can differ" was a note explaining two lines that already show
  // two numbers. What earns a line here is only the case that asks something of the user.
  if (versions.serverBehind || versions.trayBehind) {
    node.append(
      el('p', 'set-note', versions.serverBehind ? updateAdvice(versions) : 'Install the new release over this tray.'),
    );
  }
  return node;
}

/**
 * Render the settings for a connected server.
 *
 * `connected` only, like `renderLive` in `bands.ts`: every setting here is either about the server
 * the tray is talking to or about notifications that only readings can trigger, so with nothing
 * connected there is nothing on this surface to change — and the connection screen already offers
 * the field that fixes it.
 *
 * An empty `versions.tray` draws no About section at all: the value comes from a call that can fail,
 * and a heading over a blank line would state that the tray does not know what it is.
 */
export function renderSettings(
  status: Extract<Status, { kind: 'connected' }>,
  prefs: Prefs,
  actions: SettingsActions,
  versions: Versions,
  local: Local,
  note?: Note,
): HTMLElement {
  const root = el('div', 'conn conn--settings');
  const head = el('header', 'set-head');
  const back = el('button', 'set-back', '‹ Sessions');
  back.type = 'button';
  back.onclick = () => actions.back();
  head.append(back, el('h2', 'set-title', 'Settings'));
  const body = el('div', 'set-main');
  // FIRST, and in one fixed place whatever produced it — the same rule as the bands' error. This
  // surface is taller than the popover and every render starts it scrolled to the top, so a message
  // appended at the end is a message about the click that just happened, below the fold. Next to the
  // control that produced it it would instead move everything under it on each action.
  if (note) body.append(el('p', note.bad ? 'conn-error' : 'set-said', note.text));
  body.append(serverSection(status, actions, local), notificationSection(prefs, actions));
  if (versions.tray) body.append(aboutSection(versions));
  root.append(head, body);
  return root;
}
