# The tray client

A menu-bar app that shows, at a glance, which of your sessions need you. It is the second
frontend after the browser GUI, and it is **a pure HTTP client**: it links no seedeep code,
parses no session file, and reads one endpoint on its clock: `GET /api/digest`, where the server
has already done the reduction (see [`api.md`](api.md#get-apidigest)).
Everything the tray knows, it was told. The one exception is a server on the SAME machine, whose
process it can start and stop; see [Starting and stopping the server](#starting-and-stopping-the-server).

That is the whole architectural rule: a change to `apps/server/src/core/` cannot break the tray
unless it changes the endpoint.

Downloading and installing it, the first-launch warnings, and removing it again are in
[`install.md`](install.md#installing-the-tray).

## Where it lives

```text
apps/tray/
├── ui/                    the popover's HTML/CSS/TS, bundled by Bun into ui/dist/
│   ├── panel.ts           the entry point: render what Rust reports, send back what a user does
│   ├── bands.ts           the four bands, free of Tauri so it can be tested
│   ├── settings.ts        the settings view, same rule
│   ├── connection.ts      the connection screen, same rule
│   └── surface.ts         what is on screen, so an unchanged reading leaves it alone
├── tests/                 the panel's own tests (TypeScript, run by `bun test`)
└── src-tauri/             the Rust shell
    ├── src/main.rs        app lifecycle, tray icon, popover, notifications, commands
    ├── src/icon.rs        the menu-bar icon, drawn rather than shipped
    ├── src/client.rs      the one HTTP client: which server, and what state it is in
    ├── src/poll.rs        the clock: 1s open / 5s closed, the icon's state, the notification
    ├── src/pin.rs         the rustls verifier that pins one leaf certificate
    ├── src/connection.rs  what is remembered, and how a pasted URL becomes it
    ├── src/local.rs       the server on THIS machine: finding it, starting it, stopping it
    ├── src/update.rs      the release banner, and which versions this run has announced
    ├── src/store.rs       the private, atomic write
    ├── tests/fixtures/    a synthetic certificate, for hashing without a network
    ├── icons/             the BUNDLE's icons (Finder, DMG, installer), not the tray's
    └── capabilities/      what the webview is allowed to call
```

The two halves answer different questions. `ui/` is the panel a user looks at; `src-tauri/` is
everything the panel cannot do from a webview: owning a menu-bar item, sending an OS
notification, and speaking HTTPS to a pinned self-signed certificate, which the webview's `fetch`
cannot express at all.

## Running it

Building the tray from a checkout, its commands, its development environment variables and its
live probes are contributor matters:
[`CONTRIBUTING.md`](../CONTRIBUTING.md#developing-beside-an-installed-seedeep).

## One version for every deliverable

The root `package.json` holds **the only version number in the repo**, and
`apps/tray/src-tauri/tauri.conf.json` names that file as its `version` instead of carrying one
of its own. So a tag ships the server and the tray at the same version by construction, not
by anyone remembering to update two files.

The Rust crate's own `Cargo.toml` version is inert and stays at `0.0.0`; it is not what the
bundle reports.

## The menu-bar icon

The mark is a lens with no handle, a thick ring of glass with a trace inside it: three spans
stepping to the right, the shape the Trace tab draws. It is **drawn, not shipped as image files**
(`src/icon.rs`), because no test can say anything about a PNG. The geometry and the reasoning behind
every constant live in that file, next to the code that has to obey them.

The icon is never absent. An icon that disappears is indistinguishable from an app that
crashed, so there is no state in which nothing is drawn, including "cannot reach the server",
which gets an icon of its own rather than silence.

| State | Icon |
| -- | -- |
| **Unreachable**, nothing answering at the configured address | Grey glass, struck through, empty: nothing to read |
| **Nothing live** | Grey glass over the trace, still |
| **Working, nobody waiting** | Blue glass with a **gap running round it**, a turn every two seconds. No count: a number that changes constantly is peripheral noise |
| **≥1 waiting for you** | Amber glass, the same trace drawn **heavier** (3 px bars instead of 2, run out as far as the circle allows) and **still**, plus a badge dot **only above one** |
| **≥1 broken** | The plain mark **in red**, same badge rule: a session whose last model call FAILED. What keeps it off colour alone is that waiting thickens its bars and this does not |

The state comes from the same reading the panel draws (see [The poll](#the-poll)), and it is
repainted only when it changes. **Unreachable covers "nothing configured" as well as "configured and
silent"**: both are the tray unable to see anything, and an idle icon it could not vouch for would be
a guess. A digest that is not a list of sessions is Unreachable too, since a schema change is this
client's one standing risk, and that state is the one that says so.

Working is the only state that moves, and the stillness of the others is half the message. A
turning gap means *something is running, there is nothing for you to do*; amber means *it is your
turn*. So an approval STOPS the motion: with three sessions working and one stopped on you, the icon
is amber and still, and that the other two are working is in the panel. Waiting outranks working,
the icon says the thing you can act on.

**Broken outranks all of it**, because a session stopped on an approval resumes the instant it is
answered while one whose API call failed will not restart by itself. The red is a STATE, not an
event: set by a call flagged `isApiErrorMessage` and cleared only by the next call that reaches a
model, never by time. `is_working` and `needs_you` are copies of the server's predicates, while this
one is derived once by the reducer and carried in the digest's `error` field, so the icon, the panel
and the portal's tab strip cannot disagree about whether a session is broken. A payload without the
field reads as healthy: an older server must not paint every session red.

The turn is 24 frames at 12 fps, one pass every two seconds. A spinner is read out of the corner
of the eye, so it is judged on whether the motion is smooth, and the frame COUNT is what buys that
rather than the rate. The frames are rasterised ONCE at startup and cycled. The spin has its own
loop (the poll's cadence is how often the server is asked, this one is how smooth a spinner looks)
and while no session is working that task holds on a `Notify` rather than leaving a 24 Hz timer
ticking through an idle night. The two loops take turns with the icon under one lock, because the
frame that matters is the one painted LAST.

Three rules behind that table:

- **The states differ by SHAPE, not only by colour**: struck through, empty glass, a turning gap,
  heavier bars, plain. Colour alone would fail a colour-blind user and would vanish entirely
  under a macOS template image. The one exception is working-vs-waiting, blue against amber: the
  pair that survives the common colour-vision deficiencies best. Waiting-vs-broken is the weakest
  shape difference the icon carries, and the test that guards it asserts the SHAPE and ignores the
  colour, demanding the difference be a large fraction of the ink rather than merely non-zero.
- The badge says THAT more than one is waiting, never how many. The only way to give a numeral
  room at this size is to shrink the mark until the primary signal is what suffers, and the exact
  count is one click away in the panel, where the tray sends you for anything it cannot say at a
  glance.
- The mark is the same size in every state. The badge RIDES the glass at the upper right, inside
  the circle rather than beside it, so it costs the mark no size at all; a mark that resizes as it
  changes meaning reads as a glitch, and a test asserts the height is identical across every state.

### The development mark

A tray built from a checkout carries **a small dot on the glass, lower LEFT**, in every state. It
says which build you are looking at, and nothing about the sessions. It rides the glass from the
INSIDE, diagonally opposite the badge and **smaller** than it, so the two are told
apart by size as well as by place: the badge changes while you watch, this one never changes at all.

**The signal is `tauri::is_dev()`**, which is `!cfg!(feature = "custom-protocol")`, a feature
`tauri build` turns on and `tauri dev` does not, so it is a fact about how the binary was produced,
decided at compile time and free at runtime. Deliberately NOT `SEEDEEP_HOME`: a user is entitled to
move their state without their tray calling itself a development build.

The portal has the same mark for the same reason, on its own signal
([`configuration.md`](configuration.md#which-build-is-answering)): the two seedeeps on a machine
watch the *same* sessions, so nothing in the content ever tells them apart.

## The popover

It is rounded, and that costs a private API. A hard rectangle hanging off the menu bar reads as
a window that lost its frame, not as a menu, so `.panel` carries a 12 px radius and clips its
children. For the radius to be real the window is `transparent` and `body` paints nothing, which on
macOS requires the `macos-private-api` feature (`app.macOSPrivateApi` in the config, and the matching
feature on the `tauri` crate, and the build script refuses to compile if the two disagree). The
documented consequence is that the app can never be accepted to the App Store, which seedeep does
not ship through: the macOS deliverable is a DMG.

A tick never redraws a screen that has not changed (`ui/surface.ts`). Every surface except the
bands IS its status, and nothing on a connection screen moves on the server's clock, so rebuilding one
each second is not merely wasted work: it destroys what the DOM is holding for the user, a half-typed
URL included. `Surface.put` draws unconditionally and forgets the key; `Surface.putIfChanged` draws
only on a different key. The forgetting is load-bearing: "Connecting…" is drawn unkeyed, so without
it a connect that failed back to the same status would be skipped and the panel would sit on
"Connecting…" for good.

Left-click **toggles** a chromeless window anchored on **the icon's actual rectangle**, which the
OS reports with the click. A menu bar reorders itself as other apps come and go, so a remembered
position would drift. It is centred on the icon, but clamped to the work area of the monitor the
icon is on: the right-hand end of the menu bar is exactly where a tray icon sits, so a panel merely
centred on it hangs off the edge of the screen.

Which way it opens is read off the icon, never off the platform. If the icon's centre falls in
the lower half of that work area the panel grows **upward**, with its BOTTOM edge flush above the
icon; otherwise it grows downward from just below it. A macOS menu bar is always the top strip, so
the icon is always in the upper half and the direction there cannot change; on Windows the icon can
sit in the lower half, where anchoring below it puts the panel off-screen and collapses it to the
`PANEL_MIN_H` floor with the content scrolling inside.

Two consequences worth naming. The anchored edge is the icon's, not the window's: growing downward
the top never moves, while growing upward the panel has to move as well as grow. And the monitor is
looked up from the ICON's point, never the window's, since the window may be off the screen, which is the
state this repairs. `panel_geometry` is pure and carries the tests, including the two that hold the
inverted range in each direction: `clamp` panics on one, and a tray that panics is a tray that
disappears.

It also closes when it loses focus. A window with no title bar has no close button, so clicking
anywhere else *is* the dismissal, the way a menu behaves. Both dismissals end the app's
ACTIVATION, and the one from the icon has to do it by hand. Clicking elsewhere ends it by
definition. Clicking the icon does not: an `Accessory` app owns no other window to fall back to, so
hiding the popover leaves it the active app with nothing on screen, and macOS draws no banner for the
active app ([Notifications](#notifications)), so every real banner raised meanwhile would be dropped
in silence. Dismissing from the icon therefore hides the APP, not only the window, and the next click
on the icon unhides it before showing the panel.

Right-click opens a one-item menu: **Quit seedeep**. That is not decoration. The app has no Dock tile
and no app-switcher entry (macOS `ActivationPolicy::Accessory`, which is also what stops it stealing
focus at launch), so without that menu it could not be quit except from Activity Monitor.

### It is as tall as what it shows

The height is **a fact about the content, not a setting**, and only the webview can measure
it. After every render the panel measures its own natural height and hands it to Rust's `resize`
(`main.rs`), which clamps it and answers with what it applied:

- Measuring needs the height **freed for one synchronous block** (`.panel--measure`). The panel is a
  flex column whose list fills whatever room it is given, so with the window's height in force it can
  only ever measure the window. Nothing is painted between the two writes, so the class is invisible.
- The measurement is the **rect, never `scrollHeight`**, which answers in whole pixels and rounds a
  fractional surface down, since a number smaller than the content clips the last row.
- The clamp is a **pure function** (`panel_geometry`/`fitted_height` in `main.rs`, unit-tested) because neither of its failure modes
  can be seen from an SSH shell: a window taller than the screen puts the bottom of the list out of
  reach (a popover cannot be dragged) and a window of zero height cannot be clicked to recover.
  A webview that has not laid out yet reports `0`, which is why there is a floor.
- It grows **downward only**. The top edge stays anchored under the tray icon; a popover that
  re-centred itself as its content changed would walk across the menu bar.
- `min` then `max`, never `clamp`: an icon low enough that the margin eats the screen inverts the
  range, and `clamp` panics on an inverted one.
- The window still scrolls when clamped, and an unchanged height is not sent: a platform call a
  second to set the size it already has is the same waste the icon's painter guards against.

## The four bands

Everything the panel draws comes from one `/api/digest` payload. Nothing is derived from a
transcript, because the tray has no reducer. What it derives is presentation: which band a session
is in, and how long it has been there.

Only interactive sessions, and the filter is not in the panel. A headless run (`entrypoint`
`sdk-cli`/`sdk-py`) is not a session anybody is sitting at. The rule is the browser picker's
(`client/sessions.ts`, `isAutomated`), applied **where the digest enters the tray** (`client.rs`,
`only_interactive`), so the rows, the icon and the notifications read one list. An unrecognised
entrypoint, and a missing one, are **kept**, since a newer Claude Code renaming one must not make the tray
silently stop watching, and a payload that is not a list passes through untouched, landing in
*Unreachable* rather than in "the machine is idle".

**Four bands, in one order** (`ui/bands.ts`), urgency descending. A working row and an idle row are
the same shape, so a session does not change form under the eye when it stops; what differs is which
parts have anything to say.

| Band | What a session shows |
| -- | -- |
| **Broken** | whose call failed, the session's own or a subagent's, and **the message Claude Code showed**, verbatim and monospace (`Not logged in · Please run /login`), plus how long it has been quiet and the context block |
| **Needs you** | the request VERBATIM, as in `Waiting for your approval — Bash`, the command on its own line, monospace, and how long it has been stopped, to the second (the PANEL keeps the command; the banner does not; see *A banner is one title and one line*) |
| **Working** | project · subject, the turn's prompt quoted, **NOW** (the one thing to say about the turn), **how many background commands it has launched** and any **still running**, **how many subagents it has launched**, the agents at work, and the context block, which carries model · effort |
| **Idle** | the same, minus what a settled session does not have: project · subject · how long it has been quiet, **NOW**, **how many background commands it launched** and any **still running**, **how many subagents it launched**, and the context block |

NOW is one rule, computed once, drawn by both surfaces. `turn.now` in the digest is `nowLine`'s
answer (`core/activity-line.ts`), the SAME function the browser's NOW panel calls on the same inputs:
a block on the user first, then what the turn has DONE since it last spoke, then the agent's own
words, and, when a running turn has none of that, `working`. It reports which voice is speaking:

| `kind` | Label | Whose voice |
| -- | -- | -- |
| `waiting` | `waiting for you` | seedeep: the session is stopped on you (the *Needs you* band draws its own richer row instead) |
| `activity` | `now` | seedeep counting: *Read 12 files, ran 3 shell commands* |
| `intent` | `now` on a live turn, `intent` on one that was stopped | the agent's, mid-turn |
| `output` | `output` | the agent's, its final answer |
| `working` | `now` | seedeep: the turn is running with nothing of its own to quote: *`/code-review` is running in the background*, `Answering — no tools used, nothing said yet`, or `Started — no output yet` |

The agent's words are italic and seedeep's counting is not; both are labelled, because the line above
is already a quote. The server sends the text **markdown-stripped and cut to 200 characters, in that
order**, because the tray has no renderer and a raw `**` would reach the user as two asterisks.

A word holds NOW for as long as it takes to READ it, floored at 3 s and capped by the two-line
clamp, and then the count takes over. The hold runs from the moment the server SAW the word
(`live-trees.ts` stamps it), never from the line's own timestamp, and only a word that ARRIVES
while the server is watching has a sighting, so one first seen more than 60 s later earns no hold, and
a row the tray has just discovered shows what the turn has DONE instead of replaying an old line.

The rest of a row, in the order it is drawn:

- The context line carries model · effort: `Context 232.5k / 1.0M · Opus 5 · high · 23%`, spelled
  out in the portal's own wording and units, where a bare `34%` never said what it measured.
- **The *Needs you* band keeps its own row.** NOW reports the block (`kind: 'waiting'`) and that band
  draws the request instead: it is the one band whose purpose is to let the user answer without going
  to the terminal, and *"a tool is waiting"* does not tell them whether to say yes.
- A background command gets a line of its own, `● Start the dev server   4m 12s`, monospace
  because it is a command, an **accent** dot because in this panel that colour means *at work*, and
  the age on the right because between its launch and its notification that is the only thing about
  it that changes. What tells a command from an agent is the SHAPE, `●` against `◇`, amber being
  spent on ***Needs you***. It is named by what the launch called it (Claude Code's own
  `description`), the same name Claude Code quotes back when the command ends.
- **In three of the four bands**: *Working*; *Idle*, the case it exists for, a row that has stopped
  talking and is still waiting on something it started; and the ***Needs you*** row, where it can
  change the answer, since someone about to refuse a command *because the server must already be up*
  is reading the line that says whether it is. **Not** on *Broken*, which is about the model call that
  ended the session. What ends such a line is the command's **notification** and nothing else, so it
  can outlive the command it names for as long as the session lives.
- A command that has ENDED gets no line at all; it gets counted. `Commands  4 launched`, above
  the running ones, in the same shape and the same two bands as the subagent total; what it did and
  what it exited with is the portal's, one click away on the row.
- **`Subagents 12 launched`, on *Working* and on *Idle*. The lines above it are what is at work
  THIS SECOND, so `launched`, the session's whole history, is what lets an idle row mention subagents
  at all; a session that never spawned one gets no line. The count is the server's
  (`subagents.launched`), never a length of the list beside it: a Workflow run contributes its
  MEMBERS** and takes **one line however many agents it runs, and a launch with no trace of
  itself is not counted** (`hasStarted`, [`architecture.md`](architecture.md)).
- **A row's state is a mark down its left edge, never a tinted fill: amber for a session stopped on
  you, accent for one at work, nothing for one at rest. Idle is deliberately not dimmed, since
  `opacity` already means `ended` here.

Rules that are not preferences:

- The session list never moves. Rows keep the order they were first seen in and new ones are
  appended; the digest's own order is the roster's, which re-sorts as sessions work. That is what
  makes a click land on the session the user was looking at rather than on the one that took its
  place.
- No session is collapsed to nothing. Every row in every band names its project.
- No cap. Every live session is drawn and the bands scroll; the cost is bounded by the poll.
- An empty band is not drawn. Three headings over one row would spend a 560 px popover on labels.
- A session that ends while the panel is open stays**, dimmed and marked `ended`, until the panel
  closes: the server drops it from the digest immediately, and the client is the side that knows
  somebody is looking at it. It keeps its own last entry, so it keeps its band: moving it to *Idle*
  on the way out would be the list moving. Its durations freeze at the instant the tray noticed,
  because "stopped 6m 20s ago" about a process that no longer exists asserts what it cannot know.
- "While the panel is open" is Rust's answer, not the webview's, and it rides on every reading as
  `open`; the webview keeps running while the window is hidden, so a rule built on a `blur` event
  would keep a session that ended overnight on screen for the next person to open the popover.
  While nobody is looking the panel is a mirror: neither the retention nor the stable order means
  anything then, and both start fresh on the next open (`fold` in `bands.ts`).

**A server not honouring its own configuration** gets a line above the bands: *"This server started
before config.json was last changed."* It is the server's own verdict (`restart_pending` on
`/api/config`) and never the tray's, since the flags a process was started with are not readable from
another one, and a server too old to carry the field reads as nothing pending. It is neither a band
nor an icon state (both are about sessions, this is about the process) and it is asked **once per
popover opening**, the value moving only when a human edits that file.

### Into the portal

Clicking a session opens it in the browser portal, at `<portal>/?session=<id>`, which the portal
reads to open and activate that session's tab ([`architecture.md`](architecture.md)). The tray never
replicates the portal and never approves. The URL is built and opened in Rust, because it carries the
token. The portal ITSELF is one click away too, at `<portal>/?token=…`, from two places calling
that same command: the footer's address on every connected screen, and a button in the empty state.
A query is only written when it has something to carry: a loopback server with no token opens at the
bare `<portal>/`, never `<portal>/?`.

### What each band is, exactly

- Broken is the digest's `error` being non-null, and nothing else, the one band that reads an
  answer instead of re-deriving it, because the fact exists only downstream of the parser. The server
  sets it on any call flagged `isApiErrorMessage` and clears it on the next call that reaches a
  model; `error.agentId` names a subagent whose call failed, which the row says out loud because a
  fan-out that lost a worker and a session that stopped call for different reactions. It is read
  **first**, above the wait, so a red icon never sends you to a panel where that session sits under
  *Idle*.
- Needs you is not `status === 'waiting'`. Claude Code writes that for **every** open dialog, the
  model picker included, so the raw status would file "the user opened a menu" under *Needs you*. The
  rule is the server's own (`client/sessions.ts`, `pendingInput`): the two labels `permission prompt`
  and `input needed`, and an unrecognised label is deliberately not a wait, since a band that cries
  wolf is ignored on the day it is right.
- Working is not `status === 'busy'` either. Claude Code writes **`shell`** while a command the
  session launched in the background is still running and the turn itself is over, so the value
  travels raw and `isWorking` (`core/types.ts`) is the rule: the icon stays lit for as long as the
  command runs, and the "Finished" notification fires when the command really ends. A value nobody
  has seen yet still becomes `null`, and a session with no status is filed under *Idle* on purpose,
  because a band is a claim.

The last two exist in **three** copies (the server's, the panel's `bands.ts` and Rust's
`poll.rs`, for the icon's count) because the tray links no seedeep code and Rust cannot ask a
webview. Each is pinned to the server's by a test enumerating every label Claude Code writes; a
fourth reader means a fourth test.

### The poll

1 s while the panel is open, 5 s while it is closed (`OPEN` and `CLOSED` in `poll.rs`), and the
loop lives in **Rust**, not in the panel: the icon has to be right *before* anyone opens the panel,
and a hidden window's timers are throttled by the platform. The clock runs whether or not a window
exists, sets the icon from every reading, and pushes the same reading to the panel when one is
listening: one reading, so the rows and the icon can never disagree. That payload is
`{ status, entries, open }`, produced in exactly one place (`Poller::tick`). Every read after the
first is a **conditional GET** (`sendCacheable`), so an unchanged digest costs a 304 and no body,
while the discovery's own request cannot be conditional, since it has to see a digest to know it is
talking to a seedeep.

## Reaching the server

Everything the tray knows arrives through one Rust module, over four endpoints. **The webview never
fetches**, and that is not a style choice: Tauri's JS HTTP API can only *disable* certificate
verification (`acceptInvalidCerts`), never pin, and disabling it would void the reason the server has
TLS at all. So `src/client.rs` owns the client, `src/pin.rs` owns the verifier, and the panel reaches
all of it through commands: `tick` for a reading, `look_again` to re-run discovery, `connect` and
`trust` for the two answers only a user can give, `open_session` and `open_portal` to hand a session
or the portal to the browser, `server_version` / `restart_pending` / `update_view` / `start_server` /
`stop_server` for what the settings surface shows and does, and `test_notification` for the one check
that has to leave the app. No command reads or writes a notification switch: those are the server's,
set from the portal ([Notifications](#notifications)).

### The three cases, and the one that is not obvious

| Where the server is | What the tray needs |
| -- | -- |
| This machine, loopback mode, **any port** | **Nothing.** No TLS and no token, so there is nothing to paste, nothing to pin and nothing stored. |
| This machine, remote access ON | **Nothing either**: the credentials are read from the file the server wrote them in. See below. |
| Another machine | **One field**: the URL the portal's Settings → Remote access already computes and copies, token included. |

A co-located server is never something to paste a URL for. The tray reads
`<seedeep home>/config.json` and connects itself, and three things make that legitimate rather than
convenient:

- A live record has already proved the server is here, with a pid this kernel knows, the same
  proof Stop relies on when it sends that pid a SIGTERM, which is a great deal more than reading a
  file.
- No privilege boundary is crossed. `config.json` is `0600` and belongs to the user the tray runs
  as; anything learned there, that user's own shell can `cat`.
- The fingerprint comes from the certificate FILE, not from the handshake, so the identity
  presented over the wire is still confirmed against something else.

Nothing is stored: the config is the source of truth and is re-read whenever nothing is in the store,
so persisting would only put a second copy of a secret on disk. When there is nothing to read, meaning no
config or a `SEEDEEP_HOME` the tray cannot see, the panel asks for the URL.

"Any port" is the record's doing. With nothing stored, the tray reads
`<seedeep home>/servers/*.json`, where every running server writes the address it answers on, and
tries those before falling back to guessing `44842`, which is what makes `seedeep --port 9000`
reachable with nothing to paste. Two rules keep that from being a lottery:

- The default port wins, then the lowest. `read_dir` has no order, so without sorting, which of
  two records under one home the tray adopts is the filesystem's choice.
- Only a plaintext record is adopted on sight. Nothing is pinned when the tray tries an announced
  address, so an `https://` one would be trusted with no fingerprint, the confirmation the *paste a
  URL* path refuses to skip.

That third row of the table is the one worth stating, because the obvious guess is wrong: the server
decides TLS and the token check from the host it was configured with, never from the peer
([`architecture.md`](architecture.md)). One listener has one certificate, so with remote access on,
`127.0.0.1` speaks HTTPS and demands the token too. The tray tells that apart from an empty machine
instead of shrugging: after the plaintext probe finds nothing it tries `https://127.0.0.1:44842`, and
seedeep's own `401 {"error":"unauthorized"}` proves a seedeep is there.

The token leaves the pasted URL immediately and travels as `Authorization: Bearer` from then on,
a `?token=` would land in the server's own request log and in shell history.

### Trust on first use, and what is deliberately not checked

The first handshake **learns** the leaf certificate's SHA-256 and stores nothing. The panel shows it
whole, all 32 bytes, because an abbreviated hash teaches the habit of comparing the first three
groups and is not a comparison, and asks for it to be confirmed against the value the server
prints on every start and shows in Settings → TLS. Only then is it stored, and only then does the
tray call itself connected: `trust` re-connects with the pin in force, so "connected" is never a
claim inherited from the learning mode.

Once pinned, that hash is the server's identity. Nothing else about the certificate is
checked: not the chain, not the hostname, not the expiry. Each omission is deliberate:

- a **chain** check has no input, since nobody vouches for a self-signed certificate;
- a **hostname** check adds nothing a pinned leaf has not already settled, while refusing the
  aliases a user legitimately reaches their own machine by;
- an **expiry** check would one day break a tray whose server never changed, an outage with no
  security gain, because what is being asserted is the key, not the date.

A pin is refused on the two values, not on the error text rustls happens to produce, so how that
message is worded cannot change what the tray concludes. A replaced certificate is a normal event, since the server regenerates one when its `commonName` no longer
matches and `~/.seedeep` can be deleted, so the refusal is recoverable in one confirmation: **Trust
the new certificate**, next to the old value for comparison. Never a silent re-pin, and never a dead
end that requires editing a file by hand.

### What the panel says

| State | When |
| -- | -- |
| **Connected** | Reachable and authorised. The footer names the host, and the host is the way into the portal: a click opens seedeep in the browser (see [Into the portal](#into-the-portal)). Settings shows the fingerprint whole, which is where it can be COMPARED with the line the server printed. |
| **Needs a URL** | Nothing stored and nothing to adopt. Names the local-remote case when the 401 proved one. |
| **Is this its certificate?** | A fingerprint learned and not yet confirmed. Nothing is stored in this state. |
| **The certificate changed** | The pin refused. Shows **both** values, so the new one can be compared with what the server printed on its last start. |
| **The token was refused** | Reachable, wrong token, with the field on the same screen as the reason. |
| **Not answering** | A stored server that is down. The reason comes from Rust, which is the only side that knows whether the connection was REFUSED (nothing listening) or simply never answered (a machine asleep). The panel adds no guess of its own. The connection is kept: forgetting it would ask for a URL the tray already has. |
| **Looking / Connecting** | While an answer is being waited for. Shown for an action the USER took (the first open, a pasted URL, a retry) and deliberately NOT for the automatic refresh, so a screen that already says something true does not blink every time the popover is reopened. It carries no controls at all, or it would read as a screen waiting on the user. |

Every state whose only control accepts something also offers **Use a different URL**: a decision with
one button is not a decision, and a panel with no exit is one a user has to quit the app to escape.
The waiting screen exists because the first open is the slow one: a stored server that is asleep
takes seconds to fail, and the first tick can be a whole poll interval away, so without it the
panel's first paint is a blank rectangle.

The field it opens is a VIEW, not a status (`view === 'url'` in `ui/panel.ts`), because a status
is what the next tick overwrites. As a view it obeys the same rule the settings screen does,
readings keep arriving and are kept, only the redraw is withheld, so what is behind the field is
current the moment it ends. It ends on **closing the popover** (the mirror rule: a half-typed
address is not what the next click on the icon shows), or on the user being ANSWERED: a URL that
connects, a retry, a start. A URL that was refused keeps the field up with the reason under it,
because that address is what has to be corrected.

### Where the connection lives

The **app config dir** is `~/Library/Application Support/app.seedeep.tray` on macOS and
`%APPDATA%\app.seedeep.tray` on Windows, and Tauri derives it from the bundle identifier in
`tauri.conf.json`, which is also the macOS bundle ID. Changing that string makes a different
application to both operating systems: the old install stays alongside the new one and its stored
connection is abandoned, not migrated. It is an identity, not a setting.

**One file in it**, or in `<SEEDEEP_HOME>/tray` when a dev run sets that, mode **0600**, written
and read by Rust only: `connection.json`.

```json
{ "baseUrl": "https://box.local:44842", "fingerprint": "98:62:…", "token": "…" }
```

`fingerprint` and `token` are absent for a server that has neither. The file is written to a
temporary name whose mode is set **at creation** and then renamed (`src/store.rs`), so the token
never exists in a world-readable file even for an instant, and a crash mid-write leaves the previous
pin intact rather than a truncated one.

**No keychain**, because the two fields need different things. The fingerprint is not a secret, since it
travels in the clear in every handshake. What it needs is INTEGRITY, which a file only the user can
write already gives. The token *is* a secret, and it is what 0600 is for; the server keeps the same
token in plaintext at the same mode in `~/.seedeep/config.json`, so storing it differently on the
client would not make the pair safer, only inconsistent. On Windows there are no POSIX modes, but the
per-user AppData directory is ACL'd by default.

A malformed file reads as *no connection*: the panel asks for the URL again and the next
successful connect overwrites it, which is a recovery a user can perform.

## Starting and stopping the server

The tray can start and stop a seedeep on the same machine, and only there. A server on another
host is somebody else's process; the tray connects to it and offers nothing about its lifecycle.
Everything below is `src/local.rs`.

Two decisions frame it, and neither is an implementation detail:

- The server survives the tray's quit. It behaves like one started from a terminal: only an
  explicit Stop ends it. Quitting the tray must not close the portal open in a browser tab.
- Start is an explicit button, never an auto-start, and it exists only where there is something
  to run. No server found on this machine means no button, not a button that fails.

There is no notion of "the tray's server": the record on disk is what makes a process stoppable and
says nothing about who launched it, so one started from a terminal is stoppable from the tray too.

Co-located is decided by IDENTITY, never by spelling. A server with remote access on announces
the name it was configured with, and `dev-mac.local` is not spelled `127.0.0.1`; it resolves to it.
So the spelling is tried first because it is free, and otherwise the name goes to the resolver:
loopback is conclusive on its own, and any other answer is put to a bind on port 0, which the
kernel refuses with `EADDRNOTAVAIL` for an address this machine does not hold. No crate enumerates
interfaces and nothing is asked of the network. It is **not** a reachability test: a server elsewhere
may answer faster than a local one, and "I can talk to it" has never meant "I can signal it".

The resolution never happens on the poll's thread, because a name that has gone away costs seconds to fail,
and *Offline* is exactly when a name is most likely to have gone. So an unseen name answers `false`
once and starts a look, and the answer is re-asked after `LOOKUP_RETRY` (30 s) in BOTH directions: a
laptop that changes network changes what its own name resolves to.

Start comes up on the address the screen names. The button sits under a sentence saying that
address is not answering, so it passes `--port` from the stored URL, never `--host`, since locality
is already proven by the host and an explicit one risks tipping the server into its non-loopback
mode, where it demands TLS and a token. With nothing stored there is no address to honour and the
server's own `config.json` decides, which is what a user who configured a port expects.

### Where the button is, and where it is not

Rust answers with one of **three** states, never a boolean, because the two that are not *ready*
need different words on screen:

| The panel says | Start state | What is drawn |
| -- | -- | -- |
| Nothing stored, nothing answering here, and a seedeep was found | `ready` | The **Start** button. The first-run case, and the one the tray exists to remove: asking a user to copy a URL out of a portal that is not up is a dead end. |
| A stored **loopback** server is silent, and a seedeep was found | `ready` | Start, with *Try again* demoted below it, since a server coming up on its own is still real. |
| Nothing stored, and nothing was found to run | `notInstalled` | No Start. A sentence naming the case, and **Look again**, the control that sentence points at, on the one screen that has no other retry. |
| A stored server is silent, and nothing was found to run | `notInstalled` | No Start. The same sentence, above the **Try again** this screen already carries. Both buttons clear the lookup's throttle; the label differs because on this screen retrying the address is the other thing worth offering. |
| A seedeep is here with remote access on | `elsewhere` | Nothing about starting: it is already running, and what it wants is its URL. |
| A stored server **elsewhere** is silent | `elsewhere` | Nothing: starting one here would not make that address answer. |
| Anything answered at all, even a 401, even with the wrong certificate | `elsewhere` | Nothing: something is on that port, and a second server would fail on the bind. |

`notInstalled` carries whether the tray is a development build, and the two instructions are
opposites. A checkout's server is `bun run dev`, which is not something the tray can exec, so that
user is told to start it themselves; a released tray says `npm i -g seedeep`. Sending the first to
install a release would send them away from the very thing they are working on.

**Look again** is a control and not a wait: the lookup's own 30-second retry is not an answer to
somebody who has just finished installing. It **waits for the shell**, the one gesture in the panel
that does, because a reading starts the look in the background and returns the same instant, so
clearing the cache and then taking one could only ever answer *not installed*.

Stop lives in **Settings → Server**, under the address, and appears only when the tray is connected
and can name exactly one process for it. Not among the sessions: it is the opposite of what that
surface is for, and a control that ends everything on screen does not belong in a list being scanned.

### Finding the executable: ask the shell, never the PATH

A macOS GUI app inherits `PATH=/usr/bin:/bin:/usr/sbin:/sbin`. Neither `seedeep` nor `npm` is on it,
whichever channel installed them, so `spawn("seedeep")` cannot work and `npm prefix -g` cannot be
asked either. The tray therefore runs the user's own shell: `$SHELL -l -i -c 'command -v seedeep'`, or `where.exe`
on Windows, where a GUI process does inherit the registry's PATH. **Both `-l` and `-i`**: `-l` alone
reads `.zprofile` (where Homebrew's installer writes) and not `.zshrc` (where bun's and nvm's do), so
it can miss `~/.bun/bin` entirely, one of the three channels seedeep ships through. The lookup is
capped at `LOOKUP_TIMEOUT` (5 s), and a result of *nothing* is not asked again for `LOOKUP_RETRY`
(30 s); the panel's *Try again* clears that, which is how somebody who has just installed seedeep
tells the tray to look now.

The 30 seconds throttle the poll, never a click. A click is somebody saying they have changed
something, and answering it from a remembered *nothing* is answering the question the button was
pressed to re-ask. A look that a click overtook cannot write its answer either: each one carries the
generation it started in, so a cold shell still running from before the retry cannot land its
*nothing* on top of the path the warm one just found.

The lookup is not run where Start can never appear, and the poll never waits for it. A
reading takes what is already known and starts a look in the background when one is due, because that
loop is what paints the menu-bar icon and sends the notifications, and a user with a version manager in
their `.zshrc`, the very reason the shell is interactive, would otherwise have the icon freeze for up
to five seconds every thirty. The cost is that a newly installed seedeep appears one tick late. Only
a **start** waits for the answer, because a start has to have one.

Only a line that is an existing absolute file counts. An interactive shell may print a banner, and
`command -v` for a shell *function* prints its body.

### A start is proven by the server, not by the spawn

What is on `PATH` may not be the server. npm's postinstall replaces a placeholder that prints
instructions and exits 1, and `bun install -g` without `--trust` leaves that placeholder in place,
so the tray never inspects the file, it runs it and waits for the server to **announce itself** in
`<seedeep home>/servers/<pid>.json` ([`architecture.md`](architecture.md), *Announcing a running
server*). A new record within `START_TIMEOUT` (15 s) is a start; the process exiting first is a
failure, reported with the first line it printed, which for the placeholder is the sentence that
names the problem.

It is launched through `sh -c 'exec "$0" "$@"' <path> [--port <n>]`, and that is not a flourish. The
placeholder carries no shebang, so `execve` on it fails with `ENOEXEC` and reports *"Exec
format error"* instead of the four lines the file exists to print; a shell takes its ENOEXEC fallback
and produces the real message. `exec` leaves no shell in between, so the pid is the server's; `"$0"`
carries the path as an argument and `"$@"` the flags, so neither a path with spaces nor a port needs
quoting rules of ours. `setsid` puts it in its own session, so a terminal signalling the tray's process
group must not take the server with it.

Its output goes to `<seedeep home>/server.log`, truncated by each start, mode **0600**. A process
started from a menu bar has no terminal, and the first thing seedeep prints is the URL it serves,
which in remote mode carries the **token**, followed by the TLS fingerprint a pinned client is asked
to compare: neither may be lost, and neither may sit in a world-readable file next to a config kept
at 0600.

The tray passes **no flags**: the server reads the user's own config, so what starts from the menu
bar is what would have started from a terminal, browser tab included if that is what the config says.

### A stop is aimed at the connection

The tray stops the server it is **showing**: it looks for a live record naming the address it is
connected to. Co-location is proven by that record and never by the URL, since a server with remote access
on announces the host it was configured with (`https://<machine>:44842`), so a rule reading the
address would refuse to stop a server running on this very machine.

"Naming the same address" is not string equality. A loopback server announces
`http://localhost:<port>` (`server.ts`, `displayHost`) while the tray's zero-configuration connection
is `http://127.0.0.1:44842`. Scheme, port and host are compared with every spelling of loopback
collapsed into one, which is safe because a port cannot be bound twice on a host.

`SIGTERM`, so the server runs its own shutdown and withdraws its record; the tray then waits for that
record to disappear, because a signal returning says only that it was delivered. Two live records
claiming one address is refused, not resolved: that is a crashed server's file plus a pid the OS
has given to something else, and picking either would be a signal sent to an unrelated process.

Known limits, none of them silent:

- `taskkill /F` on Windows is a hard stop: the server never runs its shutdown path, so its record is
  left for the next start's sweep. Marked `// LIMIT:` at both sites. The lookup there also has a rule
  this platform does not need: `npm i -g` installs three shims and `where.exe` lists the
  extensionless sh script first, so only a file `cmd` can actually start (`.exe`, `.cmd`, `.bat`,
  `.com`) counts as having found seedeep.
- Every process the tray starts on Windows passes `CREATE_NO_WINDOW`, and that is a rule rather than
  a detail: a GUI application has no console, so Windows gives one to each console child it spawns
  and the user sees it flash. It is one shared constant in `local.rs` and not three literals, because a
  fourth spawn site cannot be added without meeting it.
- A user who sets `SEEDEEP_HOME` in their shell profile gets a server whose records the tray cannot
  see: a GUI app inherits no shell environment, so the tray looks in `~/.seedeep`. Stop is then not
  offered, which is the honest outcome: nothing is stopped by guesswork.
- A name that has stopped resolving gets no Start for one tick, because a name the tray has not seen
  is answered `false` once while it goes and asks.

## Notifications

Four triggers, four switches, and three of the four are the SERVER's. A session entering
`waiting`, a session whose API call FAILED, a session finishing a turn (off unless it is asked for).
and a newer seedeep having been published. Nothing else notifies: not a subagent finishing, not a
tool error. A tray that notifies about everything is a tray you mute.

The first three are decided, worded and switched in the server (`notify-watch.ts`), which announces
them on its event stream; the tray subscribes and posts what arrives, composing no title and no
verdict (`stream_notifications` in `client.rs`, posted from `poll.rs`). It obeys every rule below and
implements none of them, because two implementations of one rule are free to diverge. The fourth is
the tray's own, being about the machine this tray runs on (`update.rs`). Posting is Rust's either
way, so the webview never needs the permission, which is why it is absent from
`capabilities/default.json`.

The switches are edited in the portal's Settings, under *Tray notifies you when*, not on this
app's own surface, which carries none (see [Settings](#settings)), and live in `notifications.tray`
in `~/.seedeep/config.json`, beside a second set governing the webhook channel: the same moment can
be worth a banner on the machine you are sitting at and not worth a push somewhere else.

| Trigger | Setting | Default | What the banner says |
| -- | -- | -- | -- |
| A session stops on the human (`waiting`, and only the two labels above) | *A session needs you* | **on** | `project — subject` / `Waiting for your approval — Bash` |
| A session's model call fails (`error` becomes non-null) | *A session fails* | **on** | `project — subject` / `The last API call failed`, or `A subagent's API call failed` |
| A session that was `busy` becomes `idle`, having called the model at least once | *A session finishes a turn* | **off** | `project — subject` / `Turn finished` |
| The connected SERVER is behind npm (`standing`, from `/api/update`) | *A new server version is out* | **on** | `seedeep <latest> is available` / `The server is running <its version>.` |

**One switch per trigger, not one for one reason.** A session stopped on you cannot go on until you
act, while a session that finished is news you can read whenever you like; with a single toggle the
only way to stop the last is to silence the others. The failure banner ships **ON**, with the
approvals, because the session has stopped and *nothing on screen said so*. **The switch says *fails*
while the band says *Broken***: the switch is read on its own in a list of four, where
*a session breaks* is as easily read as a session taking a break. The banner carries Claude Code's
own words (`Not logged in · Please run /login`) because a category invented on top of the CLI's
would send the user to the terminal to find out what happened.

It fires on the TRANSITION, never on the state. The watch (`notify-watch.ts`, in the server)
remembers which sessions were stopped on the human, which were at work and which had broken, last
time it could see, and announces only what was not there before, per session and never as counts, so
one prompt answered and another raised in the same interval still interrupts. Each rule that follows
is a way of not lying about when something happened:

- A failure announces once, and re-arms on recovery. Still-broken is not news on the next tick,
  and only a successful call, which clears the server's `error`, makes the next failure
  announceable. A session that breaks while it was ALSO stopped on the user raises **one** banner,
  the failure, being the more serious of the two.
- A turn the user interrupted is never announced (`turn.state === 'interrupted'`). Esc means the
  user is standing at that terminal, and telling them what they just did is how a notification earns
  a mute. Nor did a turn that never called the model *finish*, Esc before the first reply leaving
  nothing in the transcript to mark; nor is `busy → waiting` a finish, being the other trigger; nor
  is a session that simply LEAVES the digest, which the user closed.
- A session already waiting, or already idle, when the tray arrives is not an event. The first
  digest SEEDS the sets and announces nothing, and the sets are forgotten the moment the last
  listener leaves, so whoever subscribes next also starts from a seed. Without that, opening the tray
  would replay every open prompt as if it had just happened.
- LIMIT: a session that enters a wait, or finishes, during a stretch that could not be read is
  **never** announced, and the next reading seeds it. There is no way to know when it happened, and the
  icon and the panel are what say where it now stands.

A banner is one title and one line, and never the detail. The line names the event: `Waiting for your approval — Bash`,
`in the terminal` when the transcript has not named the call, `The last API
call failed`, `Turn finished`, and stops there. The command awaiting approval, the CLI's error text
and the turn's own last words do not follow on a second line: a banner truncates exactly that line
first, every one of them is one click away in the panel, and the webhook, the one channel whose
payload leaves the machine, would be shipping the contents of a work session to a third-party
service to say what the first line already said. Both channels carry identical text. The title is the
session (`project — subject`), because the banner already carries the app's name.

A switch silences its banner, not the bookkeeping. The switches filter the OUTPUT of the watch
and never its input (`notify-engine.ts`), so turning one back on announces what happens next rather
than the backlog. The menu-bar icon is covered by none of them: it is peripheral information that
costs nothing to ignore, and a user who silenced the interruption has not asked to be blinded.

### The release banner is the odd one out

Its rules are its own (`update.rs`): the other three are about a SESSION and fire on a transition in
the digest, while this one is about the tray itself and can be true while nothing is connected.

- **Once per released VERSION, per RUN of the tray.** A banner repeated on every check is the
  notification people silence first, and remembering it forever is worse: a freshly installed
  unsigned bundle has no notification permission yet, so a banner can be sent, never shown, and
  recorded as announced. The memory is therefore in MEMORY, with no file and no cleanup, and a fresh start
  is the second chance, which is when a reinstall has just happened.
- The banner is about the SERVER, not the tray, which is the thing that is run and that a stale
  version affects. The verdict is the SERVER's own `standing` from `/api/update`, so the tray never
  recomputes it, and only `latest` is taken from that response. The PANEL still names both builds and
  marks whichever is behind (`update_view`); the tray's own version comes from `PackageInfo`, i.e.
  `tauri.conf.json > version`, and **never** from `env!("CARGO_PKG_VERSION")`, which is the
  deliberately inert `0.0.0`.
- **Asked every 15 minutes** (`UPDATE_EVERY`), SPAWNED rather than awaited so an unreachable server
  cannot hold the loop that paints the icon, and never overlapping, since the clock is claimed before
  the request. The server answers from a file it refreshes once an hour and the tray's period is
  shorter, because asking on the cache's own period would make the worst case two hours.
  The first check runs on the first tick.
- **The switch silences the banner, not the bookkeeping**, the same rule as the other three.

### What an unsigned build can actually deliver

seedeep ships **unsigned**, with no Apple Developer ID and no notarization, and both platforms restrict
notifications for such builds, differently.

**macOS**, measured by sending one notification each way and then asking Notification Center what it
received (its store lives at `~/Library/Group Containers/group.com.apple.usernoted/db2/db`):

| Run | `show()` returns | Delivered |
| -- | -- | -- |
| Unbundled binary, what `tauri dev` runs | `Ok(())` | **No.** The app is never registered and no record exists |
| Bundled `.app`, unsigned | `Ok(())` | **Yes.** The app is registered and the exact title and body sent are stored |

So unsigned is not the obstacle on macOS; being unbundled is: a `.app` carrying only the
linker's ad-hoc signature notifies, and signing buys a clean install past Gatekeeper rather than a
banner. And **`Ok(())` is not evidence**: the API returns success in the case where nothing is
delivered, so a dev run can never confirm this feature. Verify notifications from the packaged
artifact, or do not claim to have verified them.

**Windows**: Tauri documents that notifications work only for an INSTALLED application; in
development the PowerShell name and icon are shown instead, which is why the Windows deliverable is
an installer. Together: on both platforms the notification only works from the packaged
artifact, for different reasons.

## Settings

**A view inside the popover, not a window of its own** (`ui/settings.ts`), reached from the gear on
the footer and left by the header's back button. The popover dismisses on focus loss, which is what
makes it behave like a menu; a second window would either inherit that rule and vanish while being
used, or break it and leave the app with two competing surfaces.

The panel states, it does not explain, since a design rationale is what this document is for. Three
sentences survive on the surface itself: the menu-bar icon is never silenced by a toggle, quitting
the tray does not stop the server, and a banner is the only proof that a notification was delivered.
The first two prevent a MISREADING rather than justify a default; the third is the only honest thing
that can be said about delivery.

Five things, which is the whole surface:

| | |
| -- | -- |
| **The server** | Its address, and what identifies it: the pinned certificate whole, all 32 bytes, through the same renderer the trust screen uses |
| **One field** | The URL the portal's Settings → Remote access copies, the same `connect` command as the connection screen, so a server changed from here goes through the same trust and mismatch screens |
| **Notifications** | No switch: one line saying they are configured in seedeep's settings, in the browser, because the server owns them and two places to answer one question is one place too many (see [Notifications](#notifications)). Under it, a test banner on demand: the panel closes as it sends, because macOS draws nothing for the app in front |
| **Stop seedeep** | Only when the server is on this machine and Rust can name exactly one process for it; see [A stop is aimed at the connection](#a-stop-is-aimed-at-the-connection) |
| **About** | Both builds: `seedeep tray <version>` from `getVersion()`, and `seedeep server <version>` from `GET /api/config`, read when this view opens and never on the poll. Whichever is behind npm carries `— <latest> available` **on its own line**, so which install needs updating is never left to the reader; nothing is added when neither is |

Rules that are not preferences:

- A tick does not redraw this view, since nothing on it moves on the server's clock and
  re-rendering once a second would wipe a half-typed URL out of the field. The one thing that gets
  through is a status that has stopped being `connected`, which takes the panel back to the screen
  that can fix it, and does not leave the flag behind to spring back on the next tick.
- Closing the popover leaves the settings behind. *While nobody is looking the panel is a mirror*
  covers which SURFACE is up, not only the rows: the window is hidden and shown, never reloaded, so
  without this rule a settings screen left open yesterday is what the next click on the icon would
  show. Same flag (`open` on the reading), same rule as the ended row.
- A message is the first thing on the surface, whatever produced it, the same rule as the bands'
  error. This view is taller than the popover and every render starts it at the top, so a message
  appended at the end is one about a click that just happened, below the fold.
- **The settings exist only over a connected server**, so there is no gear on the connection screens.
- Each version says whose it is: `seedeep tray 0.1.1` and `seedeep server 0.1.1`, never a bare
  number, since the two are separate downloads that update apart and a bare version would be quoted
  in a bug report as the other's. A pair that differs is the ordinary state and draws **no warning**;
  a server that did not answer with one gets no line rather than an "unknown", and a version that
  could not be read draws no About section at all.
- The server section says three different things, not one with holes in it: a pinned certificate,
  or "plain HTTP, so there is nothing to pin", or, for `http://127.0.0.1:44842`, "the tray found
  this one by itself". An empty space where a fingerprint would be reads as *not checked yet* rather
  than as *nothing to check*.
- Nothing on this surface writes a setting, which is why none of it can be left showing a value
  the disk does not hold. What is here either states a fact (the server, the versions) or performs an
  act (connect, test, stop) whose answer is the next screen.

Why a test button exists at all. There is no way to ASK whether notifications will arrive: the
plugin's `permission_state()` is a hardcoded `Granted` on desktop (verified in
tauri-plugin-notification 2.3.3, `desktop.rs`), and `show()` returns `Ok(())` even when nothing is
delivered. So the honest surfacing of that degradation is the only check that exists: send one and
look.

The popover closes as it sends, and that is the test, not a courtesy. macOS does not PRESENT a
notification posted by the app that is FRONTMOST (Apple says so on `shouldPresentNotification:`
("the Notification Center has decided not to present your notification, for example when your
application is front most", `NSUserNotification.h`) and clicking this button is the one moment the
tray is frontmost, because the popover takes focus when it opens. The delegate callback Apple
documents as the override is not implemented by `mac-notification-sys`, so there is nothing of ours
to answer YES with, so the tray has to stop being frontmost instead. `test_notification` therefore
hides the panel, **hides the app**, waits out `NOTIFY_SETTLE` (400 ms), and only then sends.

Hiding the WINDOW does not do it, and neither does asking to deactivate. An `Accessory` app owns
no other window to fall back to, so hiding its only one leaves it the ACTIVE app with nothing on
screen, since the state that matters is activation rather than visibility. `NSApplication.deactivate` says
exactly that intent and does nothing, because nothing is there to take the activation; `NSApp.hide:`
(Tauri's `AppHandle::hide`) hands it to the next app in line.

Its cost is the HIDDEN state, and `toggle_panel` is what pays it: every window of a hidden app
stays down until something unhides it, so the click after a test would otherwise open nothing. It
calls `AppHandle::show` before showing the window, which is harmless in every other case, and the
branch above it stays correct on its own: a window of a hidden app reports `is_visible() == false`,
so the click takes the path that opens the panel rather than the one that dismisses it. Whether
`show` also ACTIVATES is left unstated here and in the code, because the documentation cannot settle
it; nothing depends on it, since `set_focus` decides the activation on the next line.

There is no receipt, and there must not be: the surface that would carry it is the one being put
away. The banner IS the answer, the same rule the stop follows, and the caveat that a system can
hide them silently sits on the button's own note, read while deciding to click. The note also says
the panel will close: a popover that vanishes unannounced reads as a crash.

## Platforms

macOS and Windows. Linux is not a target, and not because nobody got to it: Tauri documents
that tray click events are not emitted on Linux: the icon appears and right-click still opens
a context menu, but the left-click that opens this panel never arrives. A Linux build would
silently be a different product, a context menu instead of a panel. If it ever ships it has to
be designed as that from the start.

### The one permission the tray asks for

macOS gates reaching the local network, and the tray reaches it for one reason: a server announces
the address it answers on, and with remote access configured that address is a hostname on the LAN
rather than loopback. Resolving it (the identity test above) and connecting to it are both on the
far side of that gate.

The reason is DECLARED, in `src-tauri/Info.plist`: `NSLocalNetworkUsageDescription`. Tauri looks for
that file beside `tauri.conf.json` and merges it into the generated one (verified in `tauri-utils`,
`MacConfig::info_plist`), so there is no config entry to keep in sync with it. Without the string the
system shows the request with no reason attached.

Refusing it is a supported state, not a broken one: the tray falls back to asking for the URL, and
Start stops being offered for a server that names itself by hostname. In the default loopback setup
the gate is never reached at all.

Every update re-asks, and that is what unsigned costs. macOS attaches a permission to a code
IDENTITY, and an unsigned app has none that survives a rebuild: `codesign -d -r-` on the installed
app says *"code object is not signed at all"*, so a rebuild is a different object. Preferences and the
stored connection survive (those hang off the bundle identifier), the permissions do not. The
user-facing half of that, notifications included, is in
[`install.md`](install.md#installing-the-tray).

Which is also why the dialog naming the right app matters. It says **`seedeep-tray`**, which is the
honest answer to *"who is asking?"*: the tray, on behalf of the server it started, since macOS
attributes a child's request to the app responsible for it.

The **server** trips a different one, `~/Documents`, when a session's repository lives there and the
Commits or Changed files card runs read-only git in it. That belongs to the server, not here:
[`install.md`](install.md#the-macos-permission-the-server-asks-for).

## Packaging and releases

`.github/workflows/release.yml` builds what a user downloads. A tag is the only thing that
publishes: pushing `v*` creates a **draft** release, the build jobs upload into it, and a last job
flips it, only after every one of them succeeded, so a Windows failure leaves a draft rather than
putting half a download page in front of people. A manual run (`workflow_dispatch`) builds exactly
the same artifacts and leaves them on the workflow run: every step that writes to the repository is
gated on `github.ref_type == 'tag'`. How the workflow is wired is in
[`CONTRIBUTING.md`](../CONTRIBUTING.md#how-a-release-is-built); what a user downloads and installs is
in [`install.md`](install.md#installing-the-tray).

Every asset says which app it belongs to: `seedeep-tray_<version>_universal.dmg`,
`seedeep-server_<version>_macos-arm64`. The bundler names its output after `productName`, which **is**
`seedeep-tray`, so nothing needs renaming on the way out. The two programs are named apart because
sharing one name made a **system permission dialog unreadable**, since macOS names an app by
`CFBundleDisplayName`, which is `productName`, so the dialog said *"seedeep"* whether it was asking
for the tray or on behalf of the server, and made `killall seedeep` reach the server rather than the
app the user meant. The bundle IDENTIFIER is unchanged (`app.seedeep.tray`), so the permission already
granted, the config directory and the Windows uninstall key all survive that naming.

The release note is install instructions, not a disclaimer. Both systems interrupt the first
launch, and a note that does not say so lets that interruption read as a broken download, so it
carries the gesture that gets past each one, in the words the system itself uses (*Open Anyway*,
*Run anyway*), and never a label about how the build was made.

Nothing is signed, and everything is attested. The bundle carries only the linker's ad-hoc
signature: `spctl -a --type exec` answers `rejected — source=no usable signature`, and Apple's
`syspolicy_check distribution` calls it *"not signed at all"*, so macOS refuses the first launch and
SmartScreen stops the Windows installer. Signing and notarization stay out of scope until there is a
release worth signing. What does exist is a **build-provenance attestation on every release asset**,
generated by the release workflow and checkable by anyone:

```sh
gh attestation verify seedeep-tray_<version>_universal.dmg -R duqaXxX/seedeep
```

That answers a different question from Gatekeeper's: it says where the bytes came from, not who
signed them, and it is the only one of the two seedeep can answer today.
