/**
 * The connection screen: everything the panel can say when it has no data to show, plus the footer
 * that identifies the server once it has.
 *
 * Deliberately free of Tauri: it takes a status and a set of callbacks and returns DOM. That is what
 * lets the same code be rendered against fabricated statuses at real scale — the states that matter
 * here (a refused certificate, a stale token) are the ones a running server will not produce on
 * demand.
 */

/** The status Rust reports. One variant per state a user can be in — see `client.rs`. */
export type Status =
  | { kind: 'connected'; baseUrl: string; fingerprint: string | null }
  | { kind: 'awaitingTrust'; baseUrl: string; fingerprint: string }
  | { kind: 'pinMismatch'; baseUrl: string; pinned: string; presented: string }
  | { kind: 'unauthorized'; baseUrl: string }
  | { kind: 'offline'; baseUrl: string; detail: string }
  | { kind: 'needsUrl'; localRemote: boolean };

/**
 * What the tray may offer for a server on THIS machine — Rust's answer, never the panel's guess.
 *
 * Both are decided in `local.rs` from the status and from what is on disk: whether anything is
 * answering here, whether there is an executable to run, and whether exactly one process claims the
 * address the panel is showing. A screen that worked it out from `baseUrl` would be a second rule to
 * keep true.
 */
export interface Local {
  start: Start;
  canStop: boolean;
}

/**
 * Why a server can or cannot be started here — three states, because the two that are not `ready`
 * need different words. A boolean shipped first and produced a dead end: with nothing installed the
 * screen fell through to "open the portal on the machine running seedeep", which is advice about a
 * server somewhere else, given to somebody who had just switched off the one in front of them.
 */
export type Start = { kind: 'ready' } | { kind: 'notInstalled'; dev: boolean } | { kind: 'elsewhere' };

/** What the screen can ask the app to do. Every one of them ends in a new status. */
export interface Actions {
  connect(url: string): void;
  trust(): void;
  retry(): void;
  /** Start the server on this machine. Offered only where {@link Start} is `ready`. */
  start(): void;
  /**
   * Go back to asking for a URL. The only way out of the three states whose single button accepts
   * something — a fingerprint, a retry — because a decision with one button is not a decision, and
   * a panel with no exit is one the user has to quit the app to escape.
   */
  elsewhere(): void;
}

/**
 * Whether this screen has asked the user something and is waiting for the answer.
 *
 * It exists because the panel is repainted by a clock, and the clock's own view of a server that is
 * one click from being trusted is "nothing is stored, so paste a URL" — the very screen that erases
 * the question. The trust prompt used to appear for a fraction of a second and vanish, which made a
 * self-signed server impossible to accept. Same rule as the settings view: a surface being answered
 * is not a surface a tick may replace.
 */
export function asksAQuestion(status: Status): boolean {
  return status.kind === 'awaitingTrust' || status.kind === 'pinMismatch';
}

/** Scheme and port stripped: the panel is 392 px wide and the scheme is not what identifies a host. */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

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

/**
 * A fingerprint the user is meant to COMPARE, so all 32 bytes of it: an abbreviated hash teaches
 * the habit of checking the first three groups, which is no check at all. Monospace and wrapping,
 * because the alternative at this width is a horizontal scrollbar nobody scrolls.
 *
 * Shared with the settings view, which shows the pinned value for the same comparison against the
 * line the server prints — one renderer, so the two surfaces cannot abbreviate differently.
 */
export function fingerprintBlock(label: string, value: string, tone?: 'old' | 'new'): HTMLElement {
  const wrap = el('div', `fp${tone ? ` fp--${tone}` : ''}`);
  wrap.append(el('div', 'fp-label', label), el('code', 'fp-value', value));
  return wrap;
}

/** The way out of a state whose only other button says yes. */
function elsewhereLink(actions: Actions): HTMLElement {
  const alt = el('button', 'conn-alt', 'Use a different URL');
  alt.type = 'button';
  // `onclick`, not addEventListener, throughout this file: it is the codebase's client idiom and
  // the one the view-level tests can invoke, so every button here is exercised rather than assumed.
  alt.onclick = () => actions.elsewhere();
  return alt;
}

/**
 * The button that starts the server on this machine.
 *
 * The primary action wherever it appears, because where it appears nothing is running and every
 * other control on the screen is about reaching a server somewhere else. It is only ever drawn from
 * {@link Start}: an executable that was not found makes no button rather than a button that
 * fails, and a server on another machine makes none at all — its process is not the tray's to run.
 */
function startButton(actions: Actions): HTMLElement {
  const go = el('button', 'conn-go conn-go--wide', 'Start seedeep');
  go.type = 'button';
  go.onclick = () => actions.start();
  return go;
}

/**
 * What to say when nothing is answering here and nothing was found to run.
 *
 * Two texts, never one: a checkout's server is `bun run dev`, which the tray cannot exec, so telling
 * that user to install a release would send them away from the very thing they are working on. A
 * released tray has the opposite problem and the opposite instruction.
 */
function missingText(dev: boolean): string {
  return dev
    ? 'This tray is a development build, and the server it watches is your checkout — start it with `bun run dev`, then look again. The tray cannot run it for you.'
    : 'The server is not installed on this machine. Install it with `npm i -g seedeep`, then look again.';
}

/** A secondary control, for a screen whose primary one is already the Start. */
function altButton(label: string, onClick: () => void): HTMLElement {
  const alt = el('button', 'conn-alt', label);
  alt.type = 'button';
  alt.onclick = onClick;
  return alt;
}

/**
 * The paste field. One field, because the URL the portal copies already carries the token.
 *
 * Takes the callback rather than the whole action set: the settings view offers the same field for
 * pointing the tray at another server, and one form means the two cannot validate differently or
 * disagree about what a placeholder should say.
 */
export function urlForm(connect: (url: string) => void, label: string): HTMLElement {
  const form = el('form', 'conn-form');
  const input = el('input', 'conn-input');
  input.type = 'text';
  input.placeholder = 'https://…/?token=…';
  input.spellcheck = false;
  input.autocomplete = 'off';
  const go = el('button', 'conn-go', label);
  go.type = 'submit';
  form.append(input, go);
  form.onsubmit = (e) => {
    e.preventDefault();
    connect(input.value);
  };
  return form;
}

/**
 * Render `status` into a fresh element. Returns the whole panel body, so the caller swaps one node
 * and never has to reason about which parts of a previous state are still on screen.
 *
 * Every state EXCEPT `connected`, which is the one that has data to show: the bands own that
 * surface (`bands.ts`, {@link renderLive}). Excluded in the signature rather than left as an unused
 * case, so the two renderers cannot both claim it and the compiler says which one a caller wants.
 */
export function renderConnection(
  status: Exclude<Status, { kind: 'connected' }>,
  actions: Actions,
  local: Local,
): HTMLElement {
  const root = el('div', `conn conn--${status.kind}`);
  const body = el('div', 'conn-main');
  root.append(body);

  switch (status.kind) {
    case 'needsUrl': {
      // Two different screens, because the user is in two different situations. With seedeep on
      // this machine and nothing running, the answer is a button — and asking them to open a portal
      // that does not exist yet, on a server that is not up, is the first-run dead end this card is
      // about. Without it, the screen is unchanged: there is nothing here to start.
      //
      // `localRemote` never reaches this branch: a seedeep IS running here in that case, and
      // `local.rs` answers `Elsewhere` for it. Checked there and not here, so there is one
      // rule about what may be started rather than two that have to agree.
      if (local.start.kind === 'notInstalled') {
        body.append(
          el('h2', 'conn-title', 'seedeep is not running'),
          el('p', 'conn-body', missingText(local.start.dev)),
          // The control the text names. Without it the instruction pointed at a button that is only
          // on the OTHER screen, and the lookup's own 30-second retry is not an answer to somebody
          // who has just finished installing.
          altButton('Look again', () => actions.retry()),
          el('p', 'conn-body', 'Or connect to a seedeep running somewhere else:'),
          urlForm((url) => actions.connect(url), 'Connect'),
        );
        break;
      }
      if (local.start.kind === 'ready') {
        body.append(
          el('h2', 'conn-title', 'seedeep is not running'),
          el('p', 'conn-body', 'It is installed on this machine. Starting it opens the portal in your browser.'),
          startButton(actions),
          // `conn-body`, not `conn-note`: the note is the surface's amber, spent on the one thing
          // that needs to interrupt a reading (a seedeep already up in remote mode). A lead-in to
          // the alternative is not a warning, and a screen where everything shouts says nothing.
          el('p', 'conn-body', 'Or connect to a seedeep running somewhere else:'),
          urlForm((url) => actions.connect(url), 'Connect'),
        );
        break;
      }
      body.append(el('h2', 'conn-title', 'Connect to seedeep'));
      if (status.localRemote) {
        body.append(
          el(
            'p',
            'conn-note',
            'A seedeep is running on this machine with remote access on, so it asks for its URL and token like any other.',
          ),
        );
      }
      body.append(
        el(
          'p',
          'conn-body',
          'Open the portal on the machine running seedeep, then Settings → Remote access, and copy the URL.',
        ),
        urlForm((url) => actions.connect(url), 'Connect'),
      );
      break;
    }
    case 'awaitingTrust': {
      body.append(
        el('h2', 'conn-title', 'Is this its certificate?'),
        el(
          'p',
          'conn-body',
          `${hostOf(status.baseUrl)} identifies itself with this fingerprint. It is the line the server prints when it starts, and the one in Settings → TLS.`,
        ),
        fingerprintBlock('Presented', status.fingerprint),
      );
      const go = el('button', 'conn-go conn-go--wide', 'Trust and connect');
      go.onclick = () => actions.trust();
      body.append(go, elsewhereLink(actions));
      break;
    }
    case 'pinMismatch': {
      body.append(
        el('h2', 'conn-title conn-title--alert', 'The certificate changed'),
        el(
          'p',
          'conn-body',
          `${hostOf(status.baseUrl)} is not presenting the certificate it was pinned to. If you replaced it yourself, the new value is the one the server printed on its last start — check it. If you did not, something else is answering, and accepting it would end the protection.`,
        ),
        fingerprintBlock('Pinned', status.pinned, 'old'),
        fingerprintBlock('Now presenting', status.presented, 'new'),
      );
      const go = el('button', 'conn-go conn-go--wide conn-go--alert', 'Trust the new certificate');
      go.onclick = () => actions.trust();
      body.append(go, elsewhereLink(actions));
      break;
    }
    case 'unauthorized': {
      body.append(
        el('h2', 'conn-title', 'The token was refused'),
        el(
          'p',
          'conn-body',
          `${hostOf(status.baseUrl)} answered, but not to this token. Regenerating it in Settings invalidates the old one — copy the URL again.`,
        ),
        urlForm((url) => actions.connect(url), 'Connect'),
      );
      break;
    }
    case 'offline': {
      // No guess of the panel's own next to the reason. It used to add "It is most likely not
      // running", which is right for a refused connection and wrong for a silence — and silence is
      // what a sleeping machine produces. Rust knows which of the two happened; this does not.
      body.append(
        el('h2', 'conn-title', `${hostOf(status.baseUrl)} is not answering`),
        el('p', 'conn-body', status.detail),
      );
      // The stored server is on this machine and can be run: starting it is what the user came for,
      // and retrying an address nothing is listening on is what they would do first otherwise.
      // Retry stays, demoted — a server that is coming up on its own is still a real case.
      if (local.start.kind === 'notInstalled') {
        body.append(el('p', 'conn-body', missingText(local.start.dev)));
      }
      if (local.start.kind === 'ready') {
        body.append(
          startButton(actions),
          altButton('Try again', () => actions.retry()),
        );
      } else {
        const retry = el('button', 'conn-go conn-go--wide', 'Try again');
        retry.onclick = () => actions.retry();
        body.append(retry);
      }
      body.append(elsewhereLink(actions));
      break;
    }
  }
  return root;
}

/**
 * The server the panel is looking at — the one thing that stays on screen once data arrives — and
 * the way into the settings.
 *
 * The gear lives here because this is the only surface that is not a session: the bands are the
 * sessions, and a control among them would be one more row. `onSettings` is optional so the same
 * footer can be drawn by the settings view itself, which is already there.
 */
export function renderFooter(status: Extract<Status, { kind: 'connected' }>, onSettings?: () => void): HTMLElement {
  const foot = el('footer', 'conn-foot');
  foot.append(el('span', 'conn-host', hostOf(status.baseUrl)));
  // A `pinned` chip used to sit here whenever a certificate was pinned. Removed: it was jargon
  // nobody had asked for, and it was static — it said the same thing for as long as the connection
  // lasted, which is the definition of something that stops being read. The fact itself is not
  // lost: Settings shows the pinned fingerprint whole, which is where it can actually be COMPARED
  // with what the server printed, and a certificate that changes still stops the connection with
  // both values on screen. Nothing is claimed about a plaintext server either way.
  if (onSettings) {
    const gear = el('button', 'conn-gear', '⚙');
    gear.type = 'button';
    // Titled, because a lone glyph in a footer is a guess: the popover has no menu bar of its own
    // to name it.
    gear.title = 'Settings';
    gear.onclick = () => onSettings();
    foot.append(gear);
  }
  return foot;
}

/**
 * What the panel shows while it is finding out — the first open, and every action the user took.
 *
 * It exists because the answer is not instant and the alternative was a blank 392x560 rectangle: a
 * stored server that is asleep takes seconds to fail, and the first reading of a cold connection
 * costs a handshake. Deliberately not part of [`Status`]: Rust never reports it, and putting it in
 * that union would invite a state the two ends disagree about.
 *
 * No controls at all, so it can never be mistaken for a screen that is waiting on the user.
 */
export function renderLooking(message: string): HTMLElement {
  const root = el('div', 'conn conn--looking');
  const body = el('div', 'conn-main');
  body.append(el('p', 'conn-looking', message));
  root.append(body);
  return root;
}

/** The message an action came back with — shown in place, never in an alert. */
export function renderError(message: string): HTMLElement {
  return el('p', 'conn-error', message);
}
