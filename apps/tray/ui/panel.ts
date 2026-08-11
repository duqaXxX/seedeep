/**
 * The popover's entry point: render what Rust reports, and send back the answers a user can give —
 * a URL, a fingerprint they accept, a session they want to see.
 *
 * The webview never fetches and never polls. Every one of these calls crosses into Rust, which owns
 * the pinned client (a webview `fetch` cannot pin a certificate at all — `docs/tray.md`) and owns
 * the clock: it polls whether or not this window exists, because the menu-bar icon has to be right
 * before anybody opens the panel.
 */
import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { type BandActions, fold, type Reading, type Row, renderLive } from './bands.ts';
import {
  type Actions,
  asksAQuestion,
  type Local,
  renderConnection,
  renderError,
  renderLooking,
  type Status,
} from './connection.ts';
import { type Note, renderSettings, type SettingsActions } from './settings.ts';
import { Surface } from './surface.ts';

/**
 * What Rust pushes and what the `tick` command returns: a reading of the server (`entries` is null
 * for every status but `connected` — rows the tray can no longer vouch for are not rows it keeps
 * showing), whether the popover is on screen, which only Rust knows, and what may be offered for a
 * server on this machine.
 */
type Tick = Reading & { status: Status; local: Local };

const root = document.getElementById('panel');

/**
 * The one thing that writes to the panel. It exists so a tick that says nothing new cannot rebuild
 * a screen the user is in the middle of using — see `surface.ts`.
 */
const surface = root ? new Surface(root) : null;

/** What is on screen, so a failed command can put it back instead of blanking the panel. */
let status: Status = { kind: 'needsUrl', localRemote: false };

/** What Rust says may be done to a server on this machine. False until a reading says otherwise. */
let local: Local = { start: { kind: 'elsewhere' }, canStop: false };

/**
 * Set while a command the user started is in flight, and the reason the panel does not fight its own
 * clock.
 *
 * Every one of those commands puts a waiting screen up and then awaits — and a tick arriving in the
 * meantime would redraw the status underneath it, wiping the message. Connecting took two seconds
 * and got away with it; a start waits up to fifteen for a server to announce itself, and without
 * this the panel would flick back to "seedeep is not running" a second after the click on Start.
 *
 * Ticks are dropped outright rather than recorded, because every one of these paths ends in a fresh
 * reading: keeping a status the user is not being shown would only be a chance to draw a stale one.
 */
let busy = false;

/**
 * The height last asked of Rust. Kept so an unchanged panel does not cross into Rust once a second
 * to set the size it already has — the same guard the icon's painter applies, for the same reason:
 * a platform call per tick for an identical value.
 */
let sentHeight = 0;

/** The sessions being shown, in the order they were first seen — see `retain`. */
let rows: Row[] = [];

/** Which of the two surfaces is up. `settings` exists only over a connected server — see {@link show}. */
let view: 'live' | 'settings' = 'live';

/** What the app has stored, read when the settings view opens so it is never a stale copy. */

/**
 * The connected server's own release, read when the settings view opens.
 *
 * Cleared on every open rather than kept: the tray can be pointed at another server between two
 * opens, and a number left over from the previous one would be attributed to this one.
 */
let serverVersion: string | undefined;

/**
 * npm's newest and which install is behind it, read when the settings open. Both comparisons are
 * Rust's (`update_view`), so this panel, the portal and the banner cannot disagree about the same
 * machine.
 */
let updateView: {
  latest?: string;
  trayBehind?: boolean;
  serverBehind?: boolean;
  serverCommand?: string;
  serverChannel?: string;
} = {};

/** The settings view's own message slot, cleared whenever that view is entered or left. */
let note: Note | undefined;

/**
 * What this build of the tray is, for the settings view's About section.
 *
 * Read once at startup and kept: it is fixed for the life of the process, and the value is the one
 * `tauri.conf.json` takes from the repo's `package.json` — the same manifest the server's `VERSION`
 * is imported from, so the two apps of one tag can never disagree.
 *
 * Empty until the call answers, and left empty if it never does: the settings view draws no About
 * section without a version, which is better than a heading over nothing.
 */
let version = '';

/**
 * The panel's NATURAL height — what it would be if the window did not constrain it.
 *
 * Measured by freeing the height for one synchronous block: the panel is a flex column whose list
 * fills whatever room it is given, so with the window's height in force it always measures the
 * window. Nothing is painted between the two writes (the browser lays out on read and paints at the
 * end of the frame), so the class is invisible.
 *
 * One forced reflow per render, on a 392 pt surface, at most once a second — measured against the
 * alternative, which is a second layout kept in sync by hand for each of the three surfaces.
 */
function naturalHeight(): number {
  if (!root) return 0;
  root.classList.add('panel--measure');
  // The RECT, not `scrollHeight`: that one answers in whole pixels, rounding a 136.28 pt surface
  // down to 136 — so the window was told a number smaller than its content and clipped the last
  // row by a fraction of a pixel, every time. `fit` already rounds up; it was being handed a value
  // that had been rounded down first, which is what made the ceiling do nothing.
  const h = root.getBoundingClientRect().height;
  root.classList.remove('panel--measure');
  return h;
}

/**
 * Fit the window to what the panel is showing. Rust clamps to the screen and answers with
 * what it applied; a clamped panel keeps its own scrolling list, which is what the flex layout does
 * whenever the window is shorter than the content — so nothing here has to handle that case.
 *
 * Failures are swallowed on purpose: a window that could not be resized still shows the right
 * thing, and an error banner over a correct panel would be the worse outcome.
 */
function fit(): void {
  const h = Math.ceil(naturalHeight());
  if (h === 0 || h === sentHeight) return;
  sentHeight = h;
  void invoke<number>('resize', { height: h }).catch(() => {
    // Forget it, so the next render tries again rather than trusting a size that never took.
    sentHeight = 0;
  });
}

/**
 * Replace the whole surface, then fit the window to it. One node in, one node out — no leftovers
 * from the previous state.
 *
 * The fit is here rather than at each of `draw`'s three exits: every one of them changes what is on
 * screen, so every one of them changes how tall the panel should be, and a path that forgot to say
 * so would leave the window sized for the screen before it.
 */
function show(error?: string): void {
  draw(error);
  fit();
}

/** The render itself — see {@link show}, which is what everything else calls. */
function draw(error?: string): void {
  if (!root || !surface) return;
  // Settings is a view over a CONNECTED server: nothing on it can be configured without one, and
  // the connection screen is what can do something about that. Normalised here rather than at every
  // call site, so the flag is never left behind to spring back on a later tick.
  if (view === 'settings' && status.kind !== 'connected') view = 'live';
  if (view === 'settings' && status.kind === 'connected') {
    // An error from any path wins the slot: it explains an action that did not happen, and dropping
    // it would leave a click looking like it did nothing.
    surface.put(
      renderSettings(
        status,
        settings,
        { tray: version, server: serverVersion, ...updateView },
        local,
        error ? { text: error, bad: true } : note,
      ),
    );
    return;
  }
  // Read before the swap and restored after: the bands are an uncapped scrolling list re-rendered
  // every second, and a list that jumps back to the top each tick cannot be read at all.
  const scrolled = root.querySelector('.bands')?.scrollTop ?? 0;
  if (status.kind === 'connected') {
    // The error goes THROUGH the renderer, not appended after it: the two surfaces put a message in
    // different places (above the bands, below the form) and only the renderer knows where its own is.
    surface.put(renderLive(rows, status, bands, error));
    const list = root.querySelector('.bands');
    if (list) list.scrollTop = scrolled;
    return;
  }
  // Every remaining screen IS its status — nothing on one moves on the server's clock — so an
  // identical reading must leave the DOM exactly where it is. Redrawing it once a second is not
  // just wasted work: it replaced the URL field mid-sentence, which made a remote server
  // impossible to type in at all.
  // Captured before the closure: `status` is module state, so inside a callback the compiler can no
  // longer see that the `connected` case returned above — and it is right to doubt it.
  const current = status;
  const offered = local;
  // `local` is part of the key: the same status draws a different screen once seedeep is found on
  // this machine, and a surface that only watched the status would keep showing the one without the
  // button until something else changed.
  surface.putIfChanged(JSON.stringify([current, offered, error ?? null]), () => {
    const node = renderConnection(current, actions, offered);
    if (error) {
      // Appended to the rendered state rather than replacing it: the message explains why the state
      // did NOT change, so the field the user has to correct has to still be there.
      node.querySelector('.conn-main')?.append(renderError(error));
    }
    return node;
  });
}

/** Take a reading and draw it. The one path that changes what the panel shows. */
function apply(tick: Tick): void {
  // A command the user started owns the screen until it answers — see {@link busy}.
  if (busy) return;
  // A question the user is looking at outlives the clock that would answer it for them. Rust reports
  // what it can REACH, and an unconfirmed fingerprint is not stored — so every second the poll says
  // "nothing is stored, paste a URL", which is exactly the screen that erases the prompt. It made a
  // self-signed server impossible to accept: the trust screen appeared for a fraction of a second
  // and was gone. Only while the popover is open: closed, the mirror rule wins and a question nobody
  // is answering does not survive to the next opening.
  if (tick.open && asksAQuestion(status)) return;
  status = tick.status;
  local = tick.local;
  rows = fold(rows, tick);
  // While nobody is looking, the panel is a mirror — and WHICH SURFACE is up is part of what it
  // mirrors. The popover is hidden and shown, never reloaded, so without this a settings screen left
  // open yesterday is what the next click on the icon shows. That is the ended-row bug in another
  // costume, and it is the same flag that fixed it.
  if (!tick.open) {
    view = 'live';
    note = undefined;
  }
  // A tick must NOT redraw the settings view. Nothing on that surface moves on the server's clock,
  // and re-rendering it once a second would wipe a half-typed URL out of the field. The one case
  // that has to get through is a status that has stopped being connected, which `show` turns back
  // into the live path — everything else waits for the user to come back to the sessions.
  if (view === 'settings' && status.kind === 'connected') return;
  show();
}

/**
 * Ask for a fresh reading. `waiting` is passed for an action the USER took and withheld for the
 * automatic refresh: a screen that already says something true must not blink every second, but a
 * click that produces nothing for several seconds reads as a dead panel.
 */
async function refresh(waiting?: string, command: 'tick' | 'look_again' = 'tick'): Promise<void> {
  if (waiting) {
    surface?.put(renderLooking(waiting));
    fit();
    busy = true;
  }
  let tick: Tick | undefined;
  let failure: string | undefined;
  try {
    tick = await invoke<Tick>(command);
  } catch (e) {
    failure = String(e);
  }
  // Cleared before the draw, not after: `apply` is the thing `busy` suppresses, and this reading is
  // the one the user asked for.
  busy = false;
  if (tick) apply(tick);
  else show(failure);
}

/**
 * Run a command that answers with a status. A failure is a message, never a lost screen.
 *
 * A command that lands on `connected` is followed by a reading rather than drawn on its own: the
 * status alone carries no sessions, and painting "nothing is running" for the second before the
 * first tick would be the panel stating something it has not checked.
 */
async function run(command: 'connect' | 'trust', args?: Record<string, unknown>, waiting?: string): Promise<void> {
  const previous = status;
  // Not through `show`: this is not a status, so it must not become the one a failure restores.
  // Fitted all the same — "Connecting…" can hold the panel for seconds, and a two-line screen left
  // in a window sized for a list of sessions is the void the fitted window exists to remove.
  if (waiting) {
    surface?.put(renderLooking(waiting));
    fit();
    busy = true;
  }
  try {
    const next = await invoke<Status>(command, args);
    busy = false;
    // Recorded BEFORE anything else can look at it. A command is the user answering, and their
    // answer always outranks the clock: leaving `status` on the question here would make the
    // reading that follows be discarded as "a tick during a question" — the guard in `apply`
    // turning against the very click that resolved it.
    status = next;
    if (next.kind === 'connected') {
      await refresh();
      // Explicit, because `apply` deliberately does not redraw the settings view — and this command
      // can be sent from it, where "Connecting…" would otherwise stay on screen for good.
      show();
      return;
    }
    show();
  } catch (e) {
    busy = false;
    status = previous;
    show(String(e));
  }
}

/**
 * Start the server on this machine, and say what came of it.
 *
 * The wait is Rust's: the command answers when the server has announced itself or when it has died
 * trying, so there is nothing here that polls or guesses. A failure is shown on the screen the click
 * came from — for the commonest one, an npm install whose postinstall never ran, that message is the
 * placeholder's own sentence and it names the gesture that fixes it.
 */
async function startServer(): Promise<void> {
  surface?.put(renderLooking('Starting seedeep…'));
  fit();
  busy = true;
  try {
    await invoke('start_server');
    // The reading is the proof, not the command returning: it is what puts the sessions on screen
    // and what the icon is painted from.
    await refresh();
    show();
  } catch (e) {
    busy = false;
    show(String(e));
  }
}

/**
 * Stop the server the panel is connected to.
 *
 * Sent from the settings view, and the screen that follows is the connection one: the reading after
 * a successful stop has no server in it, which `draw` turns back into the live path. That IS the
 * receipt — a note saying "stopped" over a panel that still showed a server would be the weaker
 * claim. A failure keeps the settings up, with the reason in its own slot.
 */
async function stopServer(): Promise<void> {
  surface?.put(renderLooking('Stopping seedeep…'));
  fit();
  busy = true;
  try {
    await invoke('stop_server');
    note = undefined;
  } catch (e) {
    note = { text: String(e), bad: true };
  }
  busy = false;
  await refresh();
  show();
}

const actions: Actions = {
  connect: (url) => void run('connect', { url }, 'Connecting…'),
  trust: () => void run('trust', undefined, 'Connecting…'),
  // `look_again`, not `tick`: this is the user saying they have changed something, and the only way
  // somebody who just installed seedeep can tell the tray to look for it again.
  retry: () => void refresh('Looking for seedeep…', 'look_again'),
  start: () => void startServer(),
  // Answered here, not in Rust: nothing is being forgotten, the panel is simply asking again. A
  // command that deleted the stored connection would throw away a working pin to show a form.
  elsewhere: () => {
    status = { kind: 'needsUrl', localRemote: false };
    show();
  },
};

/**
 * Open the settings, reading what is stored as it goes. Fetched on the way in rather than kept from
 * a previous open: the file is the truth, the call is a mutex read, and a copy held across opens is
 * a copy that can be wrong.
 */
async function openSettings(): Promise<void> {
  note = undefined;
  try {
    // Asked here and not on the poll: a version cannot change while a process lives, and the About
    // section is the only thing that reads it. A failure leaves it absent — the section then draws
    // one line instead of two, which is honest, where the tray's own number under the server's
    // heading would not be.
    serverVersion = (await invoke<string | null>('server_version').catch(() => null)) ?? undefined;
    // Asked on the same open, and failing to nothing for the same reason: an About section that
    // could not reach the server says one fewer line rather than a wrong one.
    updateView = (await invoke<typeof updateView>('update_view').catch(() => ({}))) ?? {};
    view = 'settings';
    show();
  } catch (e) {
    // Still on the sessions: a settings screen that could not read the settings has nothing to show.
    show(String(e));
  }
}


/**
 * Send one notification. The receipt says SENT, never delivered: the platform reports success even
 * when it shows nothing (`docs/tray.md`), so the only proof is the banner the user is looking for.
 */
async function sendTest(): Promise<void> {
  try {
    await invoke('test_notification');
    note = { text: 'Sent. If no banner appeared, the system is hiding them.' };
  } catch (e) {
    note = { text: String(e), bad: true };
  }
  show();
}

const settings: SettingsActions = {
  back: () => {
    view = 'live';
    note = undefined;
    show();
  },
  // The same command the connection screen sends, so a server changed from here goes through the
  // same trust and mismatch screens rather than a second, laxer path.
  connect: (url) => void run('connect', { url }, 'Connecting…'),
  test: () => void sendTest(),
  stop: () => void stopServer(),
};

const bands: BandActions = {
  // The portal is where everything the tray cannot say at a glance lives, so a click hands the
  // session over rather than expanding in place — the panel is 392px wide and never approves.
  //
  // The failure is shown, not swallowed: this can fail for a real reason (the connection dropped
  // between the render and the click), and a row that does nothing when clicked is the panel
  // looking broken.
  open: (sessionId) => void invoke('open_session', { sessionId }).catch((e: unknown) => show(String(e))),
  // Same channel, same reason it is Rust that opens it: the URL carries the token and the webview
  // never holds one.
  portal: () => void invoke('open_portal').catch((e: unknown) => show(String(e))),
  settings: () => void openSettings(),
};

void refresh('Looking for seedeep…');

// Asked once, here: the answer cannot change while the process lives, and nothing waits for it —
// the popover is hidden at startup and the settings are two clicks further, so it is long since
// stored by the time anything draws it. A failure leaves it empty on purpose (see `renderSettings`).
void getVersion()
  .then((v) => {
    version = v;
  })
  .catch(() => {
    /* no About section rather than a wrong one */
  });

// Rust polls on its own clock and pushes; this is the only channel that updates the panel while it
// sits open, so nothing here sets a timer.
void listen<Tick>('tick', (event) => apply(event.payload));

// The popover is hidden and shown, never reloaded, so without this it would keep showing whatever it
// was opened with until the next tick — and after a long close that first tick is up to five seconds
// away. Belt only: Rust changes the cadence on the way in, so a tick is coming either way. Nothing
// here depends on this event being delivered, which is why the ended-row rule is `fold`'s and not a
// `blur` handler's.
//
// Skipped while a command is in flight. `refresh` clears {@link busy} whether or not it was the one
// to raise it, so this handler could end a wait it knows nothing about — and it fires exactly when
// that happens: Start opens the portal in the browser, the tray gets the focus back, and "Starting
// seedeep…" was replaced by "seedeep is not running" for the seconds the start still had to run.
window.addEventListener('focus', () => {
  if (!busy) void refresh();
});
