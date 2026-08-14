# The tray client

A menu-bar app that shows, at a glance, which of your sessions need you. It is the third
frontend after the browser GUI, and it is **a pure HTTP client**: it links no seedeep code,
parses no session file, and reads one endpoint on its clock — `GET /api/digest`, where the server
has already done the reduction (see [`architecture.md`](architecture.md#live-digest--get-apidigest)).
Everything the tray knows, it was told. The one exception is a server on the SAME machine, whose
process it can start and stop — see [Starting and stopping the server](#starting-and-stopping-the-server).

That is the whole architectural rule, and it is what keeps a second frontend from becoming a
second implementation: a change to `apps/server/src/core/` cannot break the tray unless it
changes the endpoint.

> **State of the code.** The tray is feature-complete and packaged: it finds a server, pins its
> certificate, polls the digest, shows the three bands, drives its icon from what it reads, notifies
> when a session stops on you, has the settings surface that turns that off, and a tag builds its
> installers ([Packaging and releases](#packaging-and-releases)). The macOS and the Windows x64
> installers have been built by CI and inspected; the Windows arm64 leg is new and has never run.
>
> What has been checked on a real menu bar, not only by its tests: the icon renders and reads at
> menu-bar size, the popover opens anchored under it and inside the screen, and it closes. The
> panel's open/close behaviour depends on the order in which macOS delivers a click and a focus
> change, so it is exercised by hand — no unit test can settle that ordering. The notification is
> verified from the **bundled** app against Notification Center's own store, which is the only place
> that answer exists ([Notifications](#notifications)). **The bands and the settings view have been
> reviewed in a browser at the popover's exact size, driven by a fake Tauri bridge, and against a
> digest a live server produced — not yet in the popover on a menu bar.**

## Where it lives

```
apps/tray/
├── ui/                    the popover's HTML/CSS/TS — bundled by Bun into ui/dist/
│   ├── panel.ts           the entry point: render what Rust reports, send back what a user does
│   ├── bands.ts           the three bands, free of Tauri so it can be tested
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
    ├── icons/             the BUNDLE's icons (Finder, DMG, installer) — not the tray's
    └── capabilities/      what the webview is allowed to call
```

The two halves answer different questions. `ui/` is the panel a user looks at; `src-tauri/` is
everything the panel cannot do from a webview — owning a menu-bar item, sending an OS
notification, and speaking HTTPS to a pinned self-signed certificate, which the webview's `fetch`
cannot express at all.

## Building and running

The tray is the only part of seedeep that needs a second toolchain, and it needs it
**dev-side only** — what a user downloads is a native binary with no runtime to install.

| | Needs |
| -- | -- |
| Server + browser GUI | Bun |
| Tray | Bun **and** a Rust toolchain (≥ the `rust-version` in `apps/tray/src-tauri/Cargo.toml`, today 1.89), plus the platform SDK (Xcode Command Line Tools on macOS, MSVC Build Tools on Windows) |

```sh
bun run tray:dev     # build the panel, compile, run
bun run tray:build   # the release bundle (.app + DMG on macOS)
bun run test:tray    # the Rust tests — `bun test` does not run them
```

The two commands split by language, not by subject: `cargo test` covers the Rust half (the pin,
the connection file, the URL parsing), `bun test` covers the server, the browser client **and the
popover's own screen** (`apps/tray/tests/`), which is TypeScript. So **both have to pass** before
a change to `apps/tray/` is done.

Three Cargo tests are `#[ignore]`d because they need a server started by hand — the live probes
described in [Reaching the server](#reaching-the-server).

### Running it

`bun run tray:dev` builds the panel, compiles the Rust shell and runs it. The whole arrangement for
working on seedeep beside an installed one — the two commands, what is separate, what is not — is in
[`CONTRIBUTING.md`](../CONTRIBUTING.md#developing-beside-an-installed-seedeep) and is not repeated
here. What belongs to the tray is one rule:

**`SEEDEEP_HOME` puts the tray's two files in `<it>/tray`** instead of the app's config directory,
and that is the only thing that keeps a dev run from rewriting the INSTALLED tray's
`connection.json` — `tauri dev` and the installed `.app` resolve that directory from the SAME bundle
identifier, so without it the installed tray opens on a port nothing is listening on, shows
**Offline**, and says nothing about why. It does not take two trays running at once; alternating is
enough. A relative value is made absolute by the app, because `tauri dev` does not run from the
repository root. An empty value is treated as no value — a script that exported the name and forgot
the value would otherwise drop a file holding a token into whatever directory the process started in.

**It used to be a variable of the tray's own**, `SEEDEEP_TRAY_HOME`, always set together with
`SEEDEEP_HOME` and meaning the same thing — and that is precisely why the pair did not work:
`bun run tray:dev` moved the tray's files but left it watching the INSTALLED server, so pointing it
at the dev one meant pasting a URL by hand, and Stop never appeared at all because the records were
in the other world. Two names for one idea.

Two more variables exist for development and are never set for a user:

| Variable | Effect |
| -- | -- |
| `SEEDEEP_TRAY_NOTIFY_PROBE` | Sends one notification at startup and prints the outcome. It exists so the finding in [Notifications](#notifications) can be re-measured on a later OS. |
| `SEEDEEP_TRAY_SHOW_PANEL` | Shows the popover at startup, so the panel can be LOOKED at without a click on the menu bar — which is the one thing no test can perform. |

`SEEDEEP_TRAY_STATE`, which forced an icon state, is gone: the icon now comes from the digest, and
a flag that could make it claim something nothing had read would only be a way to be wrong.

**A correction, measured 2026-07-30.** `SEEDEEP_TRAY_SHOW_PANEL` was introduced with a second
justification — that macOS does not load a hidden window's webview, so nothing the panel does could
happen before a click. **That is not true here.** With the window never shown, the popover's webview
loads and runs `panel.ts` anyway: it called the `tick` command, which nothing else can call. So the
panel is alive before it is visible, and the flag buys a look at it, not its existence.

## One version for every deliverable

The root `package.json` holds **the only version number in the repo**, and
`apps/tray/src-tauri/tauri.conf.json` names that file as its `version` instead of carrying one
of its own. So a tag ships the server and the tray at the same version by construction — not
by anyone remembering to update two files.

The Rust crate's own `Cargo.toml` version is inert and stays at `0.0.0`; it is not what the
bundle reports. (Verified by building with the two deliberately different: the bundle took the
`package.json` value — and again at `0.1.0`, which came out as `seedeep_0.1.0_universal.dmg`.)

Cutting a version is therefore: edit that one field, commit, and push the matching `v<version>`
tag — see [Packaging and releases](#packaging-and-releases) for what the tag then does.

## The menu-bar icon

**The mark is a lens with no handle** — a thick ring of glass with a trace inside it: three spans
stepping to the right, the shape the Trace tab draws. It replaced an eye, which said surveillance
about a tool that only ever reads, and then a fingerprint, which turned out to be the **OpenVPN
padlock's skeleton** — an arc over a round body — in the very menu bar this icon lives in. That is
the check the print failed and this one had to pass: not "is it distinct from a system glyph" but
"is it distinct from the third-party icons sharing the bar".

Three things about it are load-bearing. **No handle**: it was the source of both objections to a
magnifier, being a diagonal that fought the unreachable slash and the stroke that makes the glyph
read as *search*, which seedeep already spends a tab of its own on. **One stroke weight**: the ring
and the bars are drawn at exactly the same thickness — the ring had been half again as heavy as the
trace it sits over, a mismatch with nothing behind it. And the spans **step right** rather than
lining up: three bars of equal start and length would be a list, and a list inside a circle reads as
a menu button.

**The tray's proportions are its own, and are not meant to match the browser's.** An icon 18 points
tall in a menu bar is an optical size, the same way the 16 px ICO is: here the glass and the bars
are 2 px, the rows sit 4 px apart, and the ends of the bars are SQUARE rather than round, because at
2 px a round cap is one faded corner and a faded corner is the softness this geometry exists to
remove.

How far the bars run from the glass was picked the same way. They first reached to within 0.4 px of
the ring at 18 pt, which reads as crowding rather than as a trace; they now leave about 1.7 px.

**The icon is never absent.** An icon that disappears is indistinguishable from an app that
crashed, so there is no state in which nothing is drawn — including "cannot reach the server",
which gets an icon of its own rather than silence.

| State | Icon |
| -- | -- |
| **Unreachable** — nothing answering at the configured address | Grey glass, struck through, empty — nothing to read |
| **Nothing live** | Grey glass over the trace, still |
| **Working, nobody waiting** | Blue glass with a **gap running round it**, a turn every two seconds. No count: a number that changes constantly is peripheral noise |
| **≥1 waiting for you** | Amber glass, the same trace drawn **heavier** — 3 px bars instead of 2, run out as far as the circle allows — and **still**, plus a badge dot **only above one** |
| **≥1 broken** | The plain mark **in red**, same badge rule — a session whose last model call FAILED. What keeps it off colour alone is that waiting thickens its bars and this does not |

The state comes from the same reading the panel draws (see [The poll](#the-poll)), and it is
repainted only when it changes. **Unreachable covers "nothing configured" as well as "configured and
silent"**: both are the tray unable to see anything, and an idle icon it could not vouch for would be
a guess. A digest that is not a list of sessions is Unreachable too — a schema change is this
client's one standing risk, and that state is the one that says so.

**Working is the only state that moves, and the stillness of the others is half the message.** A
turning gap means *something is running, there is nothing for you to do*; amber means *it is your
turn*. So an approval STOPS the motion: with three sessions working and one stopped on you, the icon
is amber and still, and the fact that the other two are working is in the panel, which shows every
session in its band. Waiting outranks working — the icon says the thing you can act on.

**Broken outranks all of it.** A session stopped on an approval is healthy and resumes the instant
it is answered; one whose API call failed has stopped and will not restart by itself. Measured over
1830 real transcripts: of 47 failed calls, **39 were the last model line their session ever wrote**,
and no recovery arrived within 10 s (median 5.7 min — a human noticing and retrying). So the red is
a STATE, not an event: it is set by a call flagged `isApiErrorMessage` and cleared only by the next
call that reaches a model, never by time. It cannot flicker — the closest two errors in any one
real transcript are 125 s apart, because Claude Code's own in-flight retries are never written; what
lands on disk is the final error the user was shown.

**The failure is not the tray's rule.** `is_working` and `needs_you` are copies of the server's
predicates (the tray links no seedeep code); this one is derived once by the reducer
(`TreeSnapshot.error`) and carried in the digest's `error` field, so the icon, the panel and the
portal's tab strip cannot disagree about whether a session is broken. A payload without the field
reads as healthy — an older server must not paint every session red.

Three facts fix the motion, and each was decided by rendering it at 18 pt rather than by taste:

- **What moves is the GLASS, and that is a reversal.** Every earlier version of this icon animated
  its middle and left the outline alone, because on the eye it replaced four candidates that moved
  the outline (a travelling iris, a breathing ring, a blink, an orbiting pupil) read as a wobble
  rather than as work. On the lens that rule ran out of room: the bars are the smallest thing in the
  mark, and moving them shifted about **4 px of ink at 18 pt** — a signal nobody can see. A gap
  running round the ring moves the largest shape the icon has, which is what a mark judged out of
  the corner of the eye needs. The maintainer's call, made on the render.
- **The size rule survived the reversal, by being measured differently.** With the gap travelling
  the ring, the frames where it passes the left of the glass really do leave those columns empty, so
  a per-frame equality would fail on a motion that is correct. `the_mark_is_the_same_size_in_every_state`
  now measures the UNION of the turn against the still mark: what must not change is the box the
  icon occupies, which still catches an animation that grows the mark while every frame looks
  plausible alone. `the_working_gap_moves_on_every_frame` keeps the turn from stalling.
- **24 frames at 12 fps: a 24th of the sweep a step, one pass every two seconds.** A spinner is read
  out of the corner of the eye, so it is judged on whether the motion is smooth. The frame COUNT is
  what buys that, not the rate: halving the frames to keep a one-second pass would double the step,
  which is where a moving mark starts to read as a stutter. The frames are rasterised ONCE at
  startup (24 × 2.6 KB) and cycled — a mark re-rendered on every frame forever would be work that never stops.
- **The rate is chosen by what it costs, and the cost is the platform's, not ours.** Every frame is
  a `set_icon`, which on macOS redraws the menu bar item. Measured on the bundled app with the panel
  closed, one session working, as 30 s samples of process CPU time: **24 fps → 10.9% of one core
  (one sample), 12 fps → 7.3% (7.3 / 7.3 / 7.7 over three), nothing working → 0.3%** — the idle
  figure being the tray's ordinary poll. 12 fps is the maintainer's call, made on those numbers, and the
  motion at 12 is the same 15° step. **Halving the rate did not halve the cost**: part of what a
  repaint costs is paid per second whatever the rate, so smoothness is cheaper to buy back than the
  first measurement implied, and a further cut has less to win.
- **The spin has its own loop, and it costs nothing while nothing is working.** The poll's cadence
  is how often the server is asked; this one is how smooth a spinner looks, and tying the window to
  the poll would give one step a second. While no session is working the task holds on a `Notify` —
  not a 24 Hz timer left ticking through an idle night. The two loops take turns with the icon under
  one lock, because the frame that matters is the one painted LAST: without it a session that stops
  working can leave a blue frame on top of the amber the poll has just painted, and the poll,
  believing it painted, never corrects it.

Three rules behind that table:

- **The states differ by SHAPE, not only by colour** — struck through, empty glass, a turning gap,
  heavier bars, plain. Colour alone would fail a colour-blind user and would vanish entirely under a macOS
  template image. **The one exception is working-vs-waiting**, blue against amber: the pair that
  survives the common colour-vision deficiencies best. Waiting-vs-broken was the second exception
  and was the weaker of the two, which is why it stopped being one — see
  [The broken mark is the plain one, in red](#the-broken-mark-is-the-plain-one-in-red).
- **The badge says THAT more than one is waiting, never how many.** A numeral was built first
  and then dropped, on the render rather than on taste: at 18 pt a digit is three pixels wide,
  a `3` comes out a smudge, and the only way to give it room is to shrink the mark until the
  primary signal is what suffers. The exact count is one click away in the panel — which is
  where the tray sends you for anything it cannot say at a glance.
- **The mark is the same size in every state.** The badge RIDES the glass at the upper right,
  inside the circle rather than beside it, so it costs the mark no size at all — with a moat, or it
  would weld itself to the ring and read as a lump rather than as a count. That placement is the
  point: when the mark was an eye, a badge given a corner of its own forced the eye to shrink when
  it appeared. A mark that resizes as it changes meaning reads as a glitch, so a test asserts the
  height is identical across every state.

### The broken mark is the plain one, in red

**Broken is the mark itself, in red — nothing is added to it.** That was not always so, and the
history is the argument. It began as *Needs you*'s geometry in red: the single pair a user had to
read by hue, on the state that matters most, and red-against-amber is the pair a red-green
deficiency handles worst. A **cross** was then drawn to give it a shape of its own, chosen at 18 pt
over three others — a broken outline and a fractured centre both read as a rendering fault rather
than as information, and an exclamation lost on MEANING rather than legibility, since *!* says *look
at me*, which is precisely what the amber already says.

The cross went when the mark became a lens: a trace of three spans is a busier field for one to sit
in than the eye's iris was, and the maintainer chose the plain mark in red looking at the pair at
18 pt.

**So this is now the weakest shape difference the icon carries, and that is a decision rather than
an oversight.** What separates broken from waiting is only that waiting draws its bars thicker —
**measured at 21% of the ink**. The test that guards it was retuned from a quarter to 15%: under
the fact, far above zero. A change leaving hue as the ONLY signal still fails it, which is the
property that actually matters here. The badge is the same rule it has always been, shared with
waiting: *more than one*, never how many.

**The test asserts the SHAPE and ignores the colour**
(`a_failed_icon_differs_from_a_waiting_one_by_its_shape`). The pairwise test that already existed
compares whole buffers, so two different colours were enough to satisfy it — which is exactly how a
shared geometry passed a suite that looked like it was checking for one. The new test compares alpha
only, and demands the difference be a large fraction of the ink rather than merely non-zero: a mark
differing in a handful of pixels differs on paper and nowhere a menu bar can show it.

### The development mark

A tray built from a checkout carries **a small dot on the glass, lower LEFT**, in every state. It
says which build you are looking at, and nothing about the sessions.

It rides the glass from the INSIDE, lower left — diagonally opposite the badge and deliberately
**smaller** than it, so at 18 pt the two are told apart by size as well as by place: the badge means
*more than one session is waiting* and changes while you watch, this one never changes at all. The
lens does not shrink to make room for it — the same rule the badge answers to. Inside rather than
outside for a second reason: unlike the badge it carries **no moat**, because it may only ADD ink
(see below), and anything crossing the ring's outer edge would push the ink box out.

That rule has a test of its own, and it had to: **`is_dev()` is `true` under `cargo test`**, so every
rendered icon carries the dot, and the dot sits in the very columns the mark's height is measured in.
The size rule above is therefore asserted on the RELEASED icon, and the mark answers to a stricter
one — every pixel outside its disc identical between the two builds, which no extent could catch.

**The signal is `tauri::is_dev()`**, which is `!cfg!(feature = "custom-protocol")` — a feature
`tauri build` turns on and `tauri dev` does not. So it is a fact about how the binary was produced,
decided at compile time and free at runtime. Deliberately NOT `SEEDEEP_HOME`: a user is entitled to
move their state without their tray calling itself a development build.

The portal has the same mark for the same reason, on its own signal
([`architecture.md`](architecture.md#which-build-is-answering)) — the two seedeeps on a machine watch
the *same* sessions, so nothing in the content ever tells them apart.

The icon is **drawn, not shipped as image files** (`src/icon.rs`). Exported assets would be one
file per state per size, re-cut by hand whenever the mark changes, and no test can say anything
about a PNG; one geometry gives a single source of truth and lets the states be asserted — that
every state paints something, that no two render identically, that the badge does not count,
that the mark never changes size, and that the buffer carries no wasted margin.

**The mark is drawn on an 18×18 PIXEL GRID and the buffer ships at 36×36** — set by the platform,
not by taste. macOS pins the tray image to **18 points tall** whatever the buffer contains, so:

- **On a 1× screen 18 points are 18 PIXELS — the whole icon.** That is the number the geometry is
  written in, and writing it in fractions of a unit square is what made the icon look blurred: every
  edge landed part-way across a pixel, macOS filled the difference with grey, and three bars whose
  gaps came out under a pixel merged into a smudge. On the grid the gaps are a pixel of daylight
  each. The glass leaves about 13 px inside itself, which is the entire budget the trace has.
- **36 is that grid at 2×, and it is the only buffer that suits both screens.** A retina screen gets
  one buffer pixel per screen pixel; a 1× screen halves it exactly, so whole-pixel edges stay whole.
  A buffer of 26 was tried first and was worse on both: enlarged 1.38× on retina, and divided by an
  awkward factor on 1×.
- **Height is the mark's entire size budget**, and every empty row spends it. A square buffer left
  the mark filling 55% of the height — drawn at ~10 pt in an 18 pt slot, visibly lighter than
  every neighbouring icon, which is what looking at a real menu bar showed.
- **Width is not chosen at all**: height is fitted and width follows the proportions, so an
  elongated mark simply takes more of the bar than its neighbours. The eye this mark replaced was
  1.77 wide for 1 tall (36×26), then 1.38 (27×26); a lens is a circle, so this is the first version
  that is **square** — 36×36, badge and slash included, because both are placed inside the ring
  rather than beside it.

Two consequences worth knowing before touching the geometry. The crop constants
(`COL_LEFT`/`COLS`/`BAND_TOP`/`BAND`) are DERIVED from those proportions and have to be
recomputed with them, or the mark grows transparent margins that make it both smaller and wider.
And the slash is expressed as a fraction of the glass rather than as fixed points, for a
sharper reason than symmetry: it carries the MOAT with it, including a disc of it around each tip,
and a longer slash pushes that disc into the only columns left to measure the mark's height in —
`the_mark_is_the_same_size_in_every_state` goes red with "no column is free of the slash".
`the_buffer_is_cropped_to_the_ink` is the test that objects to the margins.

The icons under `src-tauri/icons/` are a different thing — the BUNDLE's icon, shown by Finder,
the DMG and the installer. They are generated from the same lens mark the browser uses:

```sh
bunx tauri icon apps/server/public/favicon.svg -o apps/tray/src-tauri/icons
```

## The popover

**It is rounded, and that costs a private API.** A hard rectangle hanging off the menu bar reads as
a window that lost its frame, not as a menu, so `.panel` carries a 12 px radius and clips its
children — the footer's rule and the bands' rows reach both edges and would otherwise paint the
corners back square. For the radius to be real the window is `transparent` and `body` paints
nothing, which on macOS requires the `macos-private-api` feature (`app.macOSPrivateApi` in the
config, and the matching feature on the `tauri` crate — the build script refuses to compile if the
two disagree). **The documented consequence is that the app can never be accepted to the App
Store**, which seedeep does not ship through: the macOS deliverable is a DMG. The OS draws the
shadow around whatever is opaque, which is now the rounded panel.

**A tick never redraws a screen that has not changed** (`ui/surface.ts`). Every surface except the
bands IS its status — nothing on a connection screen moves on the server's clock — so rebuilding one
each second is not merely wasted work: it destroys what the DOM is holding for the user. It cost the
tray its URL field, where every keystroke was followed within a second by a fresh `<input>`, which
made a remote server impossible to type in at all. `Surface.put` draws unconditionally and forgets
the key; `Surface.putIfChanged` draws only on a different key. The forgetting is load-bearing:
"Connecting…" is drawn unkeyed, so without it a connect that failed back to the same status would be
skipped and the panel would sit on "Connecting…" for good.

Left-click **toggles** a chromeless window anchored **under the icon's actual rectangle**, which
the OS reports with the click. A menu bar reorders itself as other apps come and go, so a
remembered position would drift.

Centred on the icon, but **clamped to the work area of the monitor the icon is on**. The
right-hand end of the menu bar is exactly where a tray icon sits, so a panel merely centred on
it hangs off the edge of the screen.

It also closes when it loses focus. A window with no title bar has no close button, so clicking
anywhere else *is* the dismissal — the way a menu behaves.

**Both dismissals end the app's ACTIVATION, and the one from the icon has to do it by hand.**
Clicking elsewhere ends it by definition — the click activated something else. Clicking the icon
does not: an `Accessory` app owns no other window to fall back to, so hiding the popover leaves it
the active app with nothing on screen, and macOS draws no banner for the active app
([Notifications](#notifications)). Dismissing from the icon therefore hides the APP, not only the
window. Until it did (2026-08-13), the tray sat in that state for as long as the user did not click
on something else — and every REAL banner raised meanwhile, a session stopping on a question
included, was dropped in silence. The next click on the icon unhides it before showing the panel.

Right-click opens a one-item menu: **Quit seedeep**. That is not decoration. The app has no Dock tile
and no app-switcher entry (macOS `ActivationPolicy::Accessory`, which is also what stops it
stealing focus at launch), so without that menu it could not be quit except from Activity
Monitor.

### It is as tall as what it shows

The height is **not a setting — it is a fact about the content**, and only the webview can measure
it. The window was a fixed 392 × 560, which put the connect screen's ~200 pt of content in 360 pt of
void.

After every render the panel measures its own natural height and hands it to Rust's `resize`
(`main.rs`), which clamps it and answers with what it applied:

- Measuring needs the height **freed for one synchronous block** (`.panel--measure`). The panel is a
  flex column whose list fills whatever room it is given, so with the window's height in force it
  can only ever measure the window. Nothing is painted between the two writes, so the class is
  invisible.
- The measurement is the **rect, never `scrollHeight`**. That one answers in whole pixels, rounding
  a 136.28 pt surface down to 136 — so the window was handed a number smaller than its content and
  clipped the last row by a fraction of a pixel, every time. The rounding up on the way out was
  being given a value that had already been rounded down, which is what made it do nothing.
- The clamp is a **pure function** (`panel_height`, unit-tested) because neither of its failure modes
  can be seen from an SSH shell: a window taller than the screen puts the bottom of the list out of
  reach — a popover cannot be dragged — and a window of zero height cannot be clicked to recover.
  A webview that has not laid out yet reports `0`, which is why there is a floor.
- It grows **downward only**. The top edge stays anchored under the tray icon; a popover that
  re-centred itself as its content changed would walk across the menu bar.
- `min` then `max`, never `clamp` — an icon low enough that the margin eats the screen inverts the
  range, and `clamp` panics on an inverted one. A tray that panics is a tray that disappears.
- The window still scrolls when clamped: that is the flex layout doing what it already did whenever
  the window was shorter than the content.
- An unchanged height is not sent. A platform call a second to set the size it already has is the
  same waste the icon's painter guards against.

## The four bands

Everything the panel draws comes from one `/api/digest` payload. Nothing is derived from a
transcript, because the tray has no reducer — what it derives is presentation: which band a session
is in, and how long it has been there.

**Only interactive sessions, and the filter is not in the panel.** A headless run (`entrypoint`
`sdk-cli`/`sdk-py` — seedeep's own docs gate writes one on every push) is not a session anybody is
sitting at: as a row it is one nobody can act on, and as an icon it says somebody is working when
nobody is. The rule is the browser picker's (`client/sessions.ts`, `isAutomated`) and it is applied
**where the digest enters the tray** (`client.rs`, `only_interactive`), not per surface — so the
rows, the icon and the notifications all read the same list and cannot disagree about which
sessions exist. An entrypoint the tray does not recognise, and a missing one, are **kept**: the two
failure modes are not symmetric — one extra row is ignored, while a session hidden because a newer
Claude Code renamed its entrypoint is one the tray silently stops watching. A payload that is not a
list passes through untouched, so a schema change still lands in *Unreachable* rather than in "the
machine is idle". The browser portal is unchanged: it keeps its Human/Automated tabs.

**Four bands, in one order.** The shape was chosen by building four at the popover's real size and
looking at them:

| Band | What a session shows |
| -- | -- |
| **Broken** | whose call failed — the session's own or a subagent's — and **the message Claude Code showed**, verbatim and monospace (`Not logged in · Please run /login`), plus how long it has been quiet and the context block |
| **Needs you** | the request VERBATIM — `Waiting for your approval — Bash`, the command on its own line, monospace — and how long it has been stopped, to the second (the PANEL keeps the command; the banner does not — see *A banner is one title and one line*) |
| **Working** | project · subject, the turn's prompt quoted, **NOW** — the one thing to say about the turn — **how many background commands it has launched** and any **still running**, **how many subagents it has launched**, the agents at work, and the context block, which carries model · effort |
| **Idle** | the same, minus what a settled session does not have: project · subject · how long it has been quiet, **NOW**, **how many background commands it launched** and any **still running**, **how many subagents it launched**, and the context block |

`turn.state` carries the same liveness the panel draws (`turnIsWorking`): the LAST turn of a session
whose process reports `busy` (never `shell` — that names a turn already over) is `live` even while
its transcript says nothing — Claude Code
writes a thinking block only when it closes, and for a median 11s after a background agent returns
(max 4m 5s, measured) the file holds nothing at all. `interrupted` is never overwritten.

**NOW is one rule, computed once, drawn by both surfaces.** `turn.now` in the digest is
`nowLine`'s answer (`core/activity-line.ts`) — the SAME function the browser's NOW panel calls, on
the same inputs. Its precedence: a block on the user first, then what the turn has DONE since it
last spoke, then the agent's own words — and, when a running turn has none of that, `working`
(measured over 3064 real turns: 12.3% produce nothing but their final answer, and a round that
delegates to a forked skill can write nothing at all for 12 minutes). It reports which voice is
speaking, and the row draws accordingly:

| `kind` | Label | Whose voice |
| -- | -- | -- |
| `waiting` | `waiting for you` | seedeep — the session is stopped on you (the *Needs you* band draws its own richer row instead, see below) |
| `activity` | `now` | seedeep counting: *Read 12 files, ran 3 shell commands* |
| `intent` | `now` on a live turn, `intent` on one that was stopped | the agent's, mid-turn |
| `output` | `output` | the agent's, its final answer |
| `working` | `now` | seedeep — the turn is running with nothing of its own to quote: *`/code-review` is running in the background*, *`/code-review` returned — working on the result*, *Answering — no tools used, nothing said yet*, or *Started — no output yet* |

The agent's words are italic and seedeep's counting is not — the portal's `.nowtext.plain`
distinction, kept here. Everything is labelled because the line above is already a quote (the
prompt): two italic paragraphs with nothing between them read as one, which is what the rendered
candidates showed. The server sends the text **markdown-stripped and cut to 200 characters, in that
order** — the tray has no renderer and no modal, so a raw `**` reached the user as two asterisks
(it did, and the card that asked for the intent showed it).

**The word holds NOW for as long as it takes to READ it**, then the count takes over — measured on
that particular text, floored at 3 s and capped by the two-line clamp. The hold is counted from the
moment the server SAW the word (`live-trees.ts` stamps it), never from the line's own timestamp:
Claude Code stamps a text block when it starts generating it and flushes the line 7-9 s later, so a
hold counted from the stamp is half spent before there is anything to show.

**Only a word that ARRIVES while the server is watching has a sighting.** What the seed reads off
the file does not: it is already on disk and has already been on screen. That is not a nicety — with
the seed stamping it, every restart of the server handed the row back to a narration the reader had
finished with and the count had already replaced (reproduced live, twice). A word with no sighting
earns no hold, so the row shows what the turn has DONE — which is also why a session the tray has
only just discovered shows its work rather than replaying an old line as news. A word first seen
more than 60 s after it was written is treated the same way.

**The itemised call line is gone.** The tray used to draw the turn's newest call (`Bash · bun
test`), which the portal never had: it was a second, lower-resolution answer to the question NOW
already answers, and it was the one place the two surfaces disagreed about what "what it is doing"
means. What it kept is the age chip — now on the NOW line, timing whatever that state names (the
running call for an `activity`, the narration for a live `intent`), never on a settled turn.

**Model · effort ride on the CONTEXT line**, chosen by the maintainer from four candidates rendered through
the real stylesheet at the real 392 px: `Context 232.5k / 1.0M · Opus 5 · high · 23%` fits one line
with room to spare. The pair belongs there for a reason beyond the space — the window in the
denominator is the model's, so the model is what the figure is measured against.

**The *Needs you* band keeps its own row.** NOW reports the block (`kind: 'waiting'`) and that band
does not draw it: it shows the request VERBATIM, with the command on its own line in monospace,
because it is the one band whose purpose is to let the user answer without going to the terminal —
and *"a tool is waiting"* does not tell them whether to say yes.

Density **used to follow urgency** — one activity line for Working, a single pill for Idle — and does
not any more, changed after using it. A working row and an idle row are now the same shape, so a
session does not change form under the eye when it stops; what differs is which parts have anything
to say. Three findings decided the contents, each measured rather than assumed:

- **A bare `34%` never said what it measured.** The context block is now labelled and spells the
  figure out — `Context 343.0k / 1.0M 34%` — in the portal's own wording and units, so the two
  surfaces state one fact one way. What the portal's card also shows and this does not is the SPLIT
  of the fill: measured on a real session, cache-read is 99.9% of it, so a three-colour bar at 392 px
  is a monochrome bar plus a legend.
- **"Live activities" cannot mean "calls running right now."** Claude Code writes a call's line
  ~3.6 s after it starts, so a call shorter than about five seconds is never observable in flight at
  all, and nothing qualifies for 78.6% of a group's life. That is why the age chip is absent most of
  the time, and why its absence is the data rather than a gap.
- **An idle session usually has no activity line.** Measured over 13 real settled sessions, the last
  turn's `activity` is null in 12 — a turn's last word is always its answer, so nothing has happened
  *since*. That is why "where it stopped" is normally the agent's own words. On the 13th, where the
  turn did work after its last word, the row reads that count instead: one rule on every surface,
  the maintainer's call, taken with the number in hand. This **revokes** the *duration only, not where it
  stopped* rule locked earlier: the maintainer's own decision, revised by him after using it.
- **Effort is worth showing now.** Claude Code has written it on the assistant line's root since
  2.1.212, and it is there on 97–99% of assistant lines since (measured 2026-07-30 over 28 313, on
  the versions that carry it). Older code comments still saying "98% of turns carry no effort"
  describe transcripts written before that release. An empty list means *the transcript does not
  say*, which is never rendered as a dash.

**A background command gets a line of its own, in three of the four bands.** `● Start the dev server   4m 12s` —
monospace because it is a command, an **accent** dot because in this panel that colour means one
thing (at work: the Working row's own border is accent, so is the agent's `◇`, so is the context
bar), and the age on the right because between its launch and its notification that is the only
thing about it that changes.

The dot was **amber** until 2026-08-08, on the reasoning that the session is *waiting on* the
command rather than working on it. The reasoning was fine and the colour was not: amber is spent on
***Needs you*** in three other places — the band heading, the blocked row's left border, and
`Waiting for your approval` — and one hue cannot mean both *something is running* and *you are
blocked* on a surface read at the edge of vision. What tells a command from an agent is the SHAPE,
`●` against `◇`, which is the job that mark already had. It has no model and no context of its own, so it
carries none of what an agent's line does. It is named by what the launch called it (Claude Code's
own `description`), which is also the name Claude Code quotes back when the command ends — one
command must not have two names on two surfaces.

**A command that has ENDED gets no line at all — it gets counted.** `Commands  4 launched`, above
the running ones, in the same shape and the same two bands as the subagent total. What that command
did, what it exited with and how long it ran is the portal's, one click away on the row: the tray
says a version of the state, and a fate is a detail. The count is what makes the silence honest —
without it, a session that ran four commands and was told about all four would show nothing at all,
which is the disappearance this whole finding started from.

The maintainer's call, 2026-08-08, and it **revokes the rule that shipped that same morning** — the last
three failures drawn as rows, red dot and dimmed text. Two reasons it went: the tray had a second
rule for commands where it already had one for subagents, and a failed command was a line important
enough to draw while the ICON never left *Working* for it, which is a surface disagreeing with
itself. If a command's failure should ever reach the user without the portal, the place for it is
the icon state or a notification, not a row in the band.

It is drawn in the *Working* and *Idle* bands — the second is the case it exists for, a row that has
stopped talking and is still waiting on something it started — and on the ***Needs you*** row too,
the only line that band's deliberately spare layout has gained. **Not** on the *Broken* row, which
is about the model call that ended the session: a shell command is not what that row is answering,
and the failure it reports is a different one. The maintainer chose that from the two rendered at 392 px: it
costs 24 px on a row that only exists while you are blocked, against the browser's chip having no
such exception, so the two surfaces would contradict each other at the exact moment the user is
deciding something. It can also change the answer — someone about to refuse a command *because the
server must already be up* is reading the line that says whether it is.

What ends it is the command's **notification**
and nothing else — measured, 9 of 107 launches (8.4%) never report one, so a line can outlive the
command it names for as long as the session lives. The alternative is a timeout, which would be a
number invented by seedeep declaring finished something nothing declared finished.

A **Workflow run takes one line** however many agents it is running — the browser's Graph rule,
applied here for the same reason: ~100 member rows would be the whole panel. The count beside it says
how many are working without listing them.

**`Subagents 12 launched` — on *Working* and on *Idle*.** The agent lines above it are what is at
work THIS SECOND, so a session that fanned out twelve reviewers and got them all back showed nothing
at all: the tray's only trace of subagent use disappeared with the last return, and an idle row —
the state a session spends most of its life in — could never mention them. `launched` is the
session's whole history and survives the return, which is the whole reason the row exists on *Idle*.

Just the figure, the maintainer's call: what each one was, what it cost and how long it took is the
portal's, one click away on the row itself. The word `launched` is not decoration — on *Working*
this line sits directly above the running agents, and a bare `12` over three rows reads as *12
running*. A session that never spawned one gets no line at all: measured over 721 real transcripts,
84% never do, and a `Subagents 0` would spend a row telling almost every session what it is not.

The count is the server's (`subagents.launched`), never a length of the list beside it, and it obeys
the two rules the running figure does: a **Workflow run contributes its MEMBERS** — answering `1`
for a fan-out of a hundred would be false — and a **launch with no trace of itself is not counted**
(`hasStarted`, `docs/architecture.md`), while one that reached a terminal state is counted whatever
it left behind, or finished work would go missing.

**A row's state is a mark down its left edge, never a tinted fill.** One language for the whole
panel, three states: amber for a session stopped on you, accent for one at work, nothing for one at
rest. A tinted background for *Working* was built and rejected against the reason the amber bar
already existed for — it changed the text's contrast row by row (the muted Context line worst of
all), it was the first thing lost at the edge of vision, which is where a menu-bar panel is read,
and on a surface where every row is a button it read as *selected* rather than as *working*. Idle is
left unmarked and deliberately **not** dimmed: `opacity` already means `ended` here, and one signal
cannot carry two meanings.

Rules that are not preferences, each one a rejected layout:

- **The session list never moves.** Rows keep the order they were first seen in and new ones are
  appended; the digest's own order is the roster's, which re-sorts as sessions work. This is what an
  accordion broke — expanding one session pushed the others away — and it is also what makes a click
  land on the session the user was looking at rather than on the one that took its place.
- **No session is collapsed to nothing.** Every row in every band names its project. A fixed strip
  with a detail pane was built and rejected for exactly this: *"se le sessioni sono collassate non
  vedo nulla."*
- **No cap.** Every live session is drawn and the bands scroll. A cap sized on one machine's logs
  would hide sessions rather than bound a payload; the cost is bounded by the poll instead.
- **An empty band is not drawn.** Three headings over one row would spend a 560 px popover on labels.

**A session that ends while the panel is open stays**, dimmed and marked `ended`, until the panel
closes — the server drops it from the digest immediately, and the client is the side that knows
somebody is looking at it. It keeps its own last entry, so it also keeps its band: moving it to
*Idle* on the way out would be the list moving. Its durations freeze at the instant the tray noticed:
"stopped 6m 20s ago" about a process that no longer exists is the panel asserting what it cannot know.

**"While the panel is open" is Rust's answer, not the webview's**, and it rides on every reading as
`open`. The webview has no reliable one of its own — it keeps running while the window is hidden
(measured 2026-07-30) — so a rule built on a `blur` event would have kept a session that ended
overnight on screen, marked `ended`, for the next person to open the popover. **While nobody is
looking the panel is a mirror:** neither the retention nor the stable order means anything then, and
both start fresh from the server's list on the next open (`fold` in `bands.ts`).

### Into the portal

**Clicking a session opens it in the browser portal**, at `<portal>/?session=<id>`, which the portal
reads to open and activate that session's tab (`architecture.md`). The tray never replicates the
portal and never approves. The URL is built and opened in Rust, because it carries the token and Rust
is the only side that holds one.

**The portal ITSELF is one click away too**, at `<portal>/?token=…` — no session named, the home the
browser would land on. It is reachable from two places, and both call the same command:

- **The footer's address**, on every connected screen, the bands and the settings alike. It is here
  and not only in the empty state because an affordance offered while nothing is running and
  withdrawn the moment a session starts is the harder thing to explain, and because the address was
  already on that line, inert, naming exactly the thing a click opens — so the way in costs no
  height in a 392×560 popover. It is not link-coloured: the quietest row in the panel does not
  become the loudest. The hover underline is what answers *is this a button*.
- **A button in the empty state**, *Open seedeep in the browser*. The one screen with room for an
  invitation and nothing else to do on it: everything the panel is for is elsewhere until Claude
  Code starts something, while the sessions that already ran can still be read in the portal.
  Outlined, not the connect screen's filled Start — nothing is wrong here and nothing is being
  decided.

A query is only written when it has something to carry: a loopback server with no token opens at the
bare `<portal>/`, never `<portal>/?`.

### What a broken band is, exactly

The digest's `error` being non-null, and nothing else. The tray holds **no copy of this rule** — it
is the one band that reads an answer instead of re-deriving it, because the fact only exists
downstream of the parser and the tray has no reducer. The server sets it on any call flagged
`isApiErrorMessage` and clears it on the next call that reaches a model; `error.agentId` names a
subagent whose call failed, which the row says out loud because a fan-out that lost a worker and a
session that stopped call for different reactions (measured: 8 of 47 real errors were a child's,
7 of them rate limits).

It is read **first**, above the wait, and the panel's order is the icon's for a reason: a red icon
that sent you to a panel where the broken session was filed under *Idle* would be the two surfaces
disagreeing about what just happened.

### What a waiting band is, exactly

Not `status === 'waiting'`. Claude Code writes that for **every** open dialog, the model picker
included, so the raw status would file "the user opened a menu" under *Needs you* and turn the icon
amber with it. The rule is the server's own (`client/sessions.ts`, `pendingInput`): the two labels
`permission prompt` and `input needed`, and **an unrecognised label is deliberately not a wait** —
a band that cries wolf is ignored on the day it is right.

That rule exists in **three** copies — the server's, the panel's (`bands.ts`), and Rust's
(`poll.rs`, for the icon's count) — because the tray links no seedeep code and Rust cannot ask a
webview. Each copy is pinned to the server's by a test that enumerates every label Claude Code
writes. Adding a fourth reader means adding the fourth test.

### What a working band is, exactly

Not `status === 'busy'` either. Claude Code writes **`shell`** while a command the session launched
in the background is still running and the turn itself is over — measured by sampling its process
file every 2 s across a 240-second command: `busy`, then `shell` for the whole run, then `busy`
again when the notification landed.

seedeep did not know the word. The server's status chain dropped anything unrecognised to `null`,
and a session with no status is filed under *Idle* on purpose (a band is a claim). So a session
with work still running read as idle and jumped back to *Working* when it finished — the opposite
of what the band is for. The value now travels raw and `isWorking` (`core/types.ts`) is the rule,
in the same three copies and pinned by the same kind of test.

Two consequences worth stating: the icon stays lit for as long as the command runs, and the
**"Finished" notification no longer fires at the end of the turn** — it fires when the command
really ends, which is the moment the session becomes the user's again.

A value nobody has seen yet still becomes `null`. The vocabulary is Claude Code's and has already
grown once; the cost of that caution is one release reading a new state as "no claim", against the
cost of guessing it wrong.

### The poll

**1 s while the panel is open, 5 s while it is closed**, and the loop lives in **Rust**, not in the
panel. Two reasons, and the second is the one that decides it: the icon has to be right *before*
anyone opens the panel, and a hidden window's timers are throttled by the platform. So the clock runs
whether or not a window exists, sets the icon from every reading, and pushes the same reading to the
panel when one is listening — one reading, so the rows and the icon can never disagree.

Every read after the first is a **conditional GET**: the server tags every response
(`sendCacheable`), so an unchanged digest costs a 304 and no body. The discovery's own request cannot
be conditional — it has to see a digest to know it is talking to a seedeep.

One reading is one payload — `{ status, entries, open }` — produced in exactly one place
(`Poller::tick`), so the `tick` command and the pushed event cannot be different shapes of the same
fact, and the icon, the rows and the notification cannot disagree about what the server said. All
three come off the same reading in the same iteration of that loop.

Measured on a real run against a logging server: two unconditional requests at startup (the
discovery, then the first read), then one conditional request every **1.00 s** with the panel open
and every **5.00 s** with it closed. A digest request is ~12.5 ms of CPU over 912 sessions on disk —
about 1.2% of one core at the faster cadence.

### A server not honouring its own configuration

Above the bands, when the connected server is bound to a port, host or certificate name
`config.json` no longer asks for: *"This server started before config.json was last changed."* It is
the server's own verdict (`restart_pending` on `/api/config`) and never the tray's — the answer
depends on the flags and the environment that process was started with, which are not readable from
another process, let alone from another machine. A server too old to carry the field reads as
nothing pending, because the tray states what it was told and never what it inferred.

**Not a band, and not an icon state.** A band is a session and the icon summarises sessions; this is
a property of the process, and giving it either would have said "a session needs you" about
something no session is doing.

It is asked **once per popover opening** — on the edge, not on the poll. The value moves only when a
human edits that file or saves the portal's panel, so the click that opens the popover is both the
moment it can have changed and the moment it is read. One request per click, and nothing on the 1 s
clock.

## Reaching the server

Everything the tray knows arrives through one Rust module and one endpoint. **The webview never
fetches**, and that is not a style choice: Tauri's JS HTTP API can only *disable* certificate
verification (`acceptInvalidCerts`), never pin — and disabling it would void the reason the server
has TLS at all. So `src/client.rs` owns the client, `src/pin.rs` owns the verifier, and the panel
reaches all of it through commands: `tick` for a reading, `look_again` to re-run discovery, `connect`
and `trust` for the two answers only a user can give, `open_session` and `open_portal` to hand a
session or the portal to the browser, `server_version` / `restart_pending` / `update_view` /
`start_server` / `stop_server` for what the settings surface shows and does, and `test_notification`
for the one check that has to leave the app. No command reads or writes a notification switch: those
are the server's, and the panel that sets them is the portal's ([Notifications](#notifications)).

### The three cases, and the one that is not obvious

| Where the server is | What the tray needs |
| -- | -- |
| This machine, loopback mode, **any port** | **Nothing.** No TLS and no token, so there is nothing to paste, nothing to pin and nothing stored. |
| This machine, remote access ON | **Nothing either** — the credentials are read from the file the server wrote them in. See below. |
| Another machine | **One field** — the URL the portal's Settings → Remote access already computes and copies, token included. |

**A co-located server is never something to paste a URL for.** It used to be: the panel said *"open
the portal on the machine running seedeep, then Settings → Remote access, and copy the URL"* — advice
about another machine, given to somebody whose seedeep was the window behind it. That is the same
dead end the three-state Start exists to remove, in another costume.

The tray now reads `<seedeep home>/config.json` and connects itself, and three things make that
legitimate rather than convenient:

- **A live record has already proved the server is here.** Its pid is one this kernel knows. That is
  the same proof Stop relies on — and the tray trusts it enough to send that pid a SIGTERM, which is
  a great deal more than reading a file.
- **No privilege boundary is crossed.** `config.json` is `0600` and belongs to the user the tray runs
  as; anything learned there, that user's own shell can `cat`. The tray already keeps its own copy of
  a token at the same mode, for the same reason.
- **The fingerprint comes from the certificate FILE, not from the handshake.** Pinning exists so an
  identity presented over the wire is confirmed against something else, and here that something else
  is the file the server generated it in. It is the opposite of adopting a record because the network
  vouched for it — the rule two paragraphs down, which refuses exactly that.

Nothing is stored: the config is the source of truth and is re-read whenever nothing is in the store,
so persisting would only put a second copy of a secret on disk. When there is nothing to read — no
config, or a `SEEDEEP_HOME` the tray cannot see — the panel asks for the URL as before.

**"Any port" is the record's doing.** With nothing stored, the tray reads
`<seedeep home>/servers/*.json` — where every running server writes the address it answers on — and
tries those before falling back to guessing `44842`. Until it did, `seedeep --port 9000` (an option
the README documents) left the panel saying there was nothing to connect to, and the only way out
was to paste a URL for a server on the very same machine. It is also what pairs the two dev commands
([Running it](#running-it)).

Two rules keep that from being a lottery:

- **The default port wins, then the lowest.** `read_dir` has no order, so with two records under one
  home — `seedeep` beside `seedeep --port 9000` — which one the tray adopted depended on the
  filesystem and could differ between two launches. Sorting keeps the capability purely additive:
  the records decide only where the guess used to find nothing at all.
- **Only a plaintext record is adopted on sight.** Nothing is pinned when the tray tries an
  announced address, so an `https://` one would be trusted with no fingerprint — the confirmation
  the *paste a URL* path refuses to skip. A real seedeep never reaches that arm (TLS means a
  configured non-loopback host, which means a token, which answers 401), so the rule costs nothing
  and closes the door on a record no seedeep on this machine wrote.

That third row is the one worth stating, because the obvious guess is wrong: the server decides
TLS and the token check from the **host it was configured with, never from the peer**
(`architecture.md`). One listener has one certificate, so with remote access on, `127.0.0.1`
speaks HTTPS and demands the token too.

The tray tells that apart from an empty machine instead of shrugging: after the plaintext probe
finds nothing it tries `https://127.0.0.1:44842`, and seedeep's own
`401 {"error":"unauthorized"}` proves a seedeep is there. The panel then says so, rather than
implying there is nothing to connect to.

The token leaves the pasted URL immediately and travels as `Authorization: Bearer` from then on —
a `?token=` would land in the server's own request log and in shell history.

### Trust on first use, and what is deliberately not checked

The first handshake **learns** the leaf certificate's SHA-256 and stores nothing. The panel shows
it whole — all 32 bytes, because an abbreviated hash teaches the habit of comparing the first
three groups, which is not a comparison — and asks for it to be confirmed against the value the
server prints on every start and shows in Settings → TLS. Only then is it stored, and only then
does the tray call itself connected: `trust` re-connects with the pin in force, so "connected" is
never a claim inherited from the learning mode that produced the value.

Once pinned, that hash is the server's identity. **Nothing else about the certificate is
checked** — not the chain, not the hostname, not the expiry — and each omission is deliberate:

- a **chain** check has no input, since nobody vouches for a self-signed certificate;
- a **hostname** check adds nothing a pinned leaf has not already settled, while refusing the
  aliases a user legitimately reaches their own machine by;
- an **expiry** check would one day break a tray whose server never changed — an outage with no
  security gain, because what is being asserted is the key, not the date.

A pin is refused on the two values, not on the error text rustls happens to produce, so how that
message is worded cannot change what the tray concludes.

### What the panel says

| State | When |
| -- | -- |
| **Connected** | Reachable and authorised. The footer names the host, and the host is the way into the portal — a click opens seedeep in the browser (see [Into the portal](#into-the-portal)). It used to carry a `pinned` chip whenever a certificate was pinned; that was removed as jargon — and as something static, which is the definition of a label that stops being read. The fact is not lost: Settings shows the fingerprint whole, which is where it can be COMPARED with the line the server printed, and a certificate that changes still stops the connection with both values on screen. |
| **Needs a URL** | Nothing stored and nothing to adopt. Names the local-remote case when the 401 proved one. |
| **Is this its certificate?** | A fingerprint learned and not yet confirmed. Nothing is stored in this state. |
| **The certificate changed** | The pin refused. Shows **both** values, so the new one can be compared with what the server printed on its last start. |
| **The token was refused** | Reachable, wrong token — with the field on the same screen as the reason. |
| **Not answering** | A stored server that is down. The reason comes from Rust, which is the only side that knows whether the connection was REFUSED (nothing listening) or simply never answered (a machine asleep) — the panel adds no guess of its own. The connection is kept: forgetting it would ask for a URL the tray already has. |
| **Looking / Connecting** | While an answer is being waited for. Shown for an action the USER took — the first open, a pasted URL, a retry — and deliberately NOT for the automatic refresh, so a screen that already says something true does not blink every time the popover is reopened. It carries no controls at all, or it would read as a screen waiting on the user. |

Every state whose only control accepts something also offers **Use a different URL**. A decision
with one button is not a decision, and a panel with no exit is one a user has to quit the app to
escape.

**The field it opens is a VIEW, not a status** (`view === 'url'` in `ui/panel.ts`), for the one
reason that matters: a status is what the next tick overwrites. The panel used to answer the click
by setting its own status to `needsUrl`, and a second later the poller — still reporting the stored
server, because nothing had been forgotten — put the old screen straight back. The field was on
screen for less than a tick, so a second server could not be typed in at all. As a view it obeys the
same rule the settings screen does: readings keep arriving and are kept, only the redraw is
withheld, so what is behind the field is current the moment it ends. It ends on **closing the
popover** (the mirror rule — a half-typed address is not what the next click on the icon shows), or
on the user being ANSWERED: a URL that connects, a retry, a start. A URL that was refused keeps the
field up with the reason under it, because that address is what has to be corrected.

The waiting screen exists because the first open is the slow one: a stored server that is asleep
takes seconds to fail, and the first tick can be a whole poll interval away. Without it the panel's
first paint was a blank 392x560 rectangle. (It is NOT because the webview loads late — see
[Running it](#running-it): the hidden popover's webview runs before the window is ever shown. That
reason was given when this was added and a 2026-07-30 re-measurement withdrew it.)

### Re-pinning a certificate that legitimately changed

A replaced certificate is a normal event — the server regenerates one when its `commonName` no
longer matches (`architecture.md`), and `~/.seedeep` can be deleted. So the refusal is
recoverable in one confirmation: **Trust the new certificate**, next to the old value for
comparison. Never a silent re-pin, and never a dead end that requires editing a file by hand.

### Where the connection lives

The **app config dir** is `~/Library/Application Support/app.seedeep.tray` on macOS and
`%APPDATA%\app.seedeep.tray` on Windows. Tauri derives that path from the bundle identifier in
`tauri.conf.json`, which is `app.seedeep.tray` — reverse-DNS notation, as Tauri requires, reading as
the domain `seedeep.app`. The same string is the macOS bundle ID, so **changing it makes a different
application** to both operating systems: the old install stays alongside the new one and its stored
connection is abandoned, not migrated. It is an identity, not a setting.

**One file in it** — or in `<SEEDEEP_HOME>/tray` when a dev run sets that
([Running it](#running-it)) — mode **0600**, written and read by Rust only: `connection.json`
(below). It used to be two: `settings.json` held the notification switches until they moved to the
server's own config ([Notifications](#notifications)), and nothing replaced it, because the only
other thing the tray remembers — which releases it has announced — is deliberately kept in memory
for the life of the process. The write is still one function, `src/store.rs`: a token needs
atomicity, and a file nobody can parse reads as absent.

The connection is:

```json
{ "baseUrl": "https://box.local:44842", "fingerprint": "98:62:…", "token": "…" }
```

`fingerprint` and `token` are absent for a server that has neither. The file is written to a
temporary name whose mode is set **at creation** and then renamed, so the token never exists in a
world-readable file even for an instant, and a crash mid-write leaves the previous pin intact
rather than a truncated one.

**No keychain**, and the reason is that the two fields need different things. The fingerprint is
not a secret — it travels in the clear in every handshake — what it needs is INTEGRITY, and a file
only the user can write already gives that. The token *is* a secret, and it is what 0600 is for;
the server keeps the same token in plaintext at the same mode in `~/.seedeep/config.json`, so
storing it differently on the client would not make the pair safer, only inconsistent. On Windows
there are no POSIX modes, but the per-user AppData directory is ACL'd by default.

A malformed file reads as *no connection*: the panel asks for the URL again and the next
successful connect overwrites it, which is a recovery a user can perform.

### The live probes

Pinning is a claim about a real handshake, which nothing hermetic can make. Three Cargo tests
therefore need a server started by hand, and are `#[ignore]`d rather than left in a scratchpad —
a claim that cannot be re-run on a later rustls or Tauri release is a claim that quietly expires:

```sh
cd apps/tray/src-tauri
# a seedeep in DEFAULT loopback mode on 44842
SEEDEEP_TRAY_PROBE_LOCAL=1 cargo test -- --ignored --nocapture a_default_local_server
# a seedeep in REMOTE mode on 44842 (the local-remote case)
SEEDEEP_TRAY_PROBE_LOCAL_REMOTE=1 cargo test -- --ignored --nocapture a_local_server_in_remote_mode
# the whole remote flow against any server: learn, refuse to store, trust, restart, read the
# digest, re-paste without being asked again, then refuse a pin that does not match — by `status`
# AND by a paste — and re-pin it
SEEDEEP_TRAY_PROBE_URL='https://127.0.0.1:44842/?token=…' cargo test -- --ignored --nocapture a_real_server_is_reached
```

Each one is named on purpose: the three need different servers, and two of them the same port, so
`--ignored` with no filter runs all three and fails the ones whose server is not up. That noise is
deliberate — a probe that passes without having run is worse than one that says it could not.

The last one prints the fingerprint it learned, so it can be compared with the line the server
printed — the very out-of-band check the user is asked to perform.

## Starting and stopping the server

**The tray can start and stop a seedeep on the same machine, and only there.** A server on another
host is somebody else's process; the tray connects to it and offers nothing about its lifecycle.
Everything below is `src/local.rs`.

Two decisions frame it, and neither is an implementation detail:

- **The server survives the tray's quit.** It behaves like one started from a terminal — only an
  explicit Stop ends it. Quitting the tray must not close the portal open in a browser tab.
- **Start is an explicit button, never an auto-start**, and it exists only where there is something
  to run. No server found on this machine means no button, not a button that fails.

A server started from a terminal is stoppable from the tray just the same. There is no notion of
"the tray's server": the record on disk is what makes a process stoppable, and it says nothing about
who launched it.

**Co-located is decided by IDENTITY, never by spelling.** A server with remote access on announces
the name it was configured with, and reading only the host string left Start missing for a server
sitting on this very machine: `dev-mac.local` is not spelled `127.0.0.1`. It resolves to it, though —
macOS answers a machine's own `.local` name with `::1` and `127.0.0.1` beside its LAN address
(measured). So the spelling is tried first because it is free, and otherwise the name goes to the
resolver: **loopback is conclusive on its own**, and any other answer is put to a bind on port 0,
which the kernel refuses with `EADDRNOTAVAIL` for an address this machine does not hold. No crate
enumerates interfaces and nothing is asked of the network.

It is **not** a reachability test, which is what the old rule was written to avoid and still avoids:
a server elsewhere may answer faster than a local one, and "I can talk to it" has never meant "I can
signal it". Resolving a name to `127.0.0.1` is a fact about identity, not about reach.

The resolution never happens on the poll's thread. Measured: a `.local` name that still exists costs
**4.5 ms** cold and 0.6 ms warm, and one that has gone away costs **5.0 s to fail** — the same five
seconds the executable lookup was moved off this loop for, and `Offline` (when this is asked) is
exactly when a name is most likely to have gone. So an unseen name answers `false` once and starts a
look, and the answer is re-asked after the same 30 s in BOTH directions: a name is not an executable,
and a laptop that changes network changes what its own name resolves to.

**Start comes up on the address the screen names.** The button sits under a sentence saying that
address is not answering, so it passes `--port` from the stored URL — never `--host`, since locality
is already proven by the host and an explicit one risks tipping the server into its non-loopback
mode, where it demands TLS and a token. With nothing stored there is no address to honour and the
server's own `config.json` decides, which is what a user who configured a port expects. A bare spawn
did neither: with `http://127.0.0.1:9000` stored it came up on the configured port instead, the panel
stayed offline, and a second click launched a process that could not bind.

### Where the button is, and where it is not

Rust answers with one of **three** states, never a boolean, because the two that are not *ready*
need different words on screen:

| The panel says | Start state | What is drawn |
| -- | -- | -- |
| Nothing stored, nothing answering here, and a seedeep was found | `ready` | The **Start** button. The first-run case, and the one the tray exists to remove: asking a user to copy a URL out of a portal that is not up is a dead end. |
| A stored **loopback** server is silent, and a seedeep was found | `ready` | Start, with *Try again* demoted below it — a server coming up on its own is still real. |
| Nothing stored, and **nothing was found to run** | `notInstalled` | No Start. A sentence naming the case, and **Look again** — the control that sentence points at, on the one screen that has no other retry. |
| A stored server is silent, and **nothing was found to run** | `notInstalled` | No Start. The same sentence, above the **Try again** this screen already carries. Both buttons clear the lookup's throttle; the label differs because on this screen retrying the address is the other thing worth offering. |
| A seedeep is here with remote access on | `elsewhere` | Nothing about starting: it is already running, and what it wants is its URL. |
| A stored server **elsewhere** is silent | `elsewhere` | Nothing: starting one here would not make that address answer. |
| Anything answered at all — even a 401, even with the wrong certificate | `elsewhere` | Nothing: something is on that port, and a second server would fail on the bind. |

**`notInstalled` carries whether the tray is a development build, and the two instructions are
opposites.** A checkout's server is `bun run dev`, which is not something the tray can exec, so that
user is told to start it themselves; a released tray says `npm i -g seedeep`. Sending the first to
install a release would send them away from the very thing they are working on.

That state exists because a boolean produced a dead end, met in real use: with nothing installed the
screen fell through to *"open the portal on the machine running seedeep and copy the URL"* — advice
about a server somewhere else, given to somebody who had just pressed **Stop** on the one in front of
them. The same sentence therefore appears on the *not answering* screen too, or Stop is a one-way
door that never says why.

**Look again** is a control and not a wait: the words name it, and the lookup's own 30-second retry
is not an answer to somebody who has just finished installing. It **waits for the shell** — the one
gesture in the panel that does — because the alternative is what shipped first: clearing the cache
and then taking a reading could only ever answer *not installed*, since a reading starts the look in
the background and returns the same instant. The person who had just installed seedeep was told it
was not there, and the real answer arrived with the next automatic tick, up to five seconds later.

Stop lives in **Settings → Server**, under the address, and appears only when the tray is connected
and can name exactly one process for it. Not among the sessions: it is the opposite of what that
surface is for, and a control that ends everything on screen does not belong in a list being scanned.

### Finding the executable: ask the shell, never the PATH

A macOS GUI app inherits `PATH=/usr/bin:/bin:/usr/sbin:/sbin` — measured 2026-08-04 on a Finder
launch, and re-runnable (see below). Neither `seedeep` nor `npm` is on it, whichever channel
installed them, so `spawn("seedeep")` cannot work and `npm prefix -g` cannot be asked either.

The tray therefore runs the user's own shell — `$SHELL -l -i -c 'command -v seedeep'`, or `where.exe`
on Windows, where a GUI process does inherit the registry's PATH. **Both `-l` and `-i`**: `-l` alone
reads `.zprofile` (where Homebrew's installer writes) and not `.zshrc` (where bun's and nvm's do),
and on the machine this was measured on it missed `~/.bun/bin` entirely — one of the three channels
seedeep ships through. The lookup costs 0.02 s there, is capped at 5 s, and a result of *nothing* is
not asked again for 30 seconds; the panel's *Try again* clears that, which is how somebody who has
just installed seedeep tells the tray to look now.

**The 30 seconds throttle the poll, never a click.** A click is somebody saying they have changed
something, and answering it from a remembered *nothing* is answering the question the button was
pressed to re-ask. And a look that a click overtook cannot write its answer: each one carries the
generation it started in, so the cold shell still running from before the retry cannot land its
*nothing* on top of the path the warm one just found — which used to make the button disappear and
freeze the throttle for another thirty seconds.

**The lookup is not run where Start can never appear.** A tray pointed at another machine was
spawning a login shell every thirty seconds, for the whole life of the process, to answer a question
its screen would never ask.

**The poll never waits for it.** A reading takes what is already known and starts a look in the
background when one is due, because that loop is what paints the menu-bar icon and sends the
notifications — a user with a version manager in their `.zshrc`, the very reason the shell is
interactive, would otherwise have the icon freeze for up to five seconds every thirty. The cost is
that a newly installed seedeep appears one tick late, and it is paid where nobody is looking: the
first look happens on the tray's first reading, long before the panel is opened. Only a **start**
waits for the answer, because a start has to have one.

Only a line that is an existing absolute file counts. An interactive shell may print a banner, and
`command -v` for a shell *function* prints its body.

### A start is proven by the server, not by the spawn

What is on `PATH` may not be the server. npm's postinstall replaces a placeholder that prints
instructions and exits 1, and `bun install -g` without `--trust` leaves that placeholder in place —
so the tray never inspects the file, it runs it and waits for the server to **announce itself** in
`<seedeep home>/servers/<pid>.json` ([architecture.md](architecture.md), *Announcing a running
server*). A new record within 15 s is a start; the process exiting first is a failure, reported with
the first line it printed — which for the placeholder is the sentence that names the problem.

It is launched through `sh -c 'exec "$0" "$@"' <path> [--port <n>]`, and that is not a flourish. The
placeholder carries no shebang on purpose, so `execve` on it fails with `ENOEXEC` and the user would
be told *"Exec format error"* instead of the four lines the file exists to print; a shell takes its
ENOEXEC fallback and produces the real message. `exec` leaves no shell in between, so the pid is the
server's; `"$0"` carries the path as an argument and `"$@"` the flags, so neither a path with spaces
nor a port needs quoting rules of ours. `setsid` puts it in its own session — a terminal signalling
the tray's process group must not take the server with it.

**Its output goes to `<seedeep home>/server.log`**, truncated by each start, mode **0600**. A process
started from a menu bar has no terminal, and the first thing seedeep prints is the URL it serves —
which in remote mode carries the **token** — followed by the TLS fingerprint a pinned client is
asked to compare. Losing both, or leaving them in a world-readable file next to a config kept at
0600, were the two ways to get this wrong.

The tray passes **no flags**: the server reads the user's own config, so what starts from the menu
bar is what would have started from a terminal, browser tab included if that is what the config says.

### A stop is aimed at the connection

The tray stops the server it is **showing**: it looks for a live record naming the address it is
connected to. Co-location is proven by that record and never by the URL — a server with remote
access on announces the host it was configured with (`https://<machine>:44842`), so a rule that read
the address would refuse to stop a server running on this very machine.

"Naming the same address" is not string equality, and getting that wrong broke the default case
outright. A loopback server announces `http://localhost:<port>` (`server.ts`, `displayHost`) while
the tray's zero-configuration connection is `http://127.0.0.1:44842` — so the first version found no
record for the very server Start had just launched, and Stop never appeared at all. Scheme, port and
host are compared with every spelling of loopback collapsed into one, which is safe because a port
cannot be bound twice on a host; the one arrangement that could still produce two records for it —
one server on `127.0.0.1`, another on `::1` — is the ambiguity below, which is refused rather than
resolved.

`SIGTERM`, so the server runs its own shutdown and withdraws its record; the tray then waits for that
record to disappear, because a signal returning says only that it was delivered. **Two live records
claiming one address is refused, not resolved** — that is a crashed server's file plus a pid the OS
has given to something else, and picking either would be a signal sent to an unrelated process.

Known limits, none of them silent:

- **Windows is compiled but unverified.** `taskkill /F` is a hard stop — the server never runs its
  shutdown path, so its record is left for the next start's sweep. Marked `// LIMIT:` at both sites.
  The lookup there also has a rule this platform does not need: `npm i -g` installs three shims and
  `where.exe` lists the extensionless sh script first, so only a file `cmd` can actually start —
  `.exe`, `.cmd`, `.bat`, `.com` — counts as having found seedeep.
- A user who sets `SEEDEEP_HOME` in their shell profile gets a server whose records the tray cannot
  see: a GUI app inherits no shell environment, so the tray looks in `~/.seedeep`. Stop is then not
  offered, which is the honest outcome — nothing is stopped by guesswork.
- A name that has stopped resolving gets no Start for one tick. Co-location is decided by identity,
  not by spelling — see below — and a name the tray has not seen is answered `false` once while it
  goes and asks.

### Re-running the PATH measurement

The design rests on a claim about the OS, so it is re-runnable rather than written down once. Create
an empty file called `locate-probe` in [the tray's config directory](#where-the-connection-lives) —
the same folder that holds `connection.json` — start the tray **the way a user does** (Finder, Dock,
login item, never a terminal), and the file is overwritten with the `PATH` it inherited, its
`$SHELL`, and what the lookup found. Absent, it is never created and never read:

```sh
: > ~/Library/Application\ Support/app.seedeep.tray/locate-probe
# launch seedeep.app from Finder, then:
cat ~/Library/Application\ Support/app.seedeep.tray/locate-probe
```

A file, where the notification probe is an environment variable, because of the very thing being
measured: a Finder launch inherits neither the terminal's environment nor `launchctl setenv`
(measured — the variable was simply absent). A file is the only channel into a process nobody can
hand arguments to.

There is also a live probe for the whole round trip, which starts a real server and stops it again:

```sh
cd apps/tray/src-tauri
SEEDEEP_TRAY_PROBE_START=1 cargo test -- --ignored --nocapture a_real_server_starts_and_stops
```

## Notifications

**Four triggers, four switches — and three of the four are the SERVER's.** A session entering
`waiting`, a session whose API call FAILED, a session finishing a turn (off unless it is asked for)
— and a newer seedeep having been published. Nothing else notifies: not a subagent finishing, not a
tool error. A tray that notifies about everything is a tray you mute.

The first three are decided, worded and switched in the server (`notify-watch.ts`), which announces
them on its event stream; the tray subscribes and posts what arrives, composing no title and no
verdict (`stream_notifications` in `client.rs`, posted from `poll.rs`). The fourth is the tray's own,
because it is about the machine this tray is running on (`update.rs`). Posting is Rust's either way:
the webview never needs the permission, which is why the notification permission is absent from
`capabilities/default.json`.

**The switches are edited in the portal's Settings**, under *Tray notifies you when* — not on this
app's own surface, which carries none (see [Settings](#settings)). They live in
`notifications.tray` in `~/.seedeep/config.json`, beside a second set governing the webhook channel:
the same moment can be worth a banner on the machine you are sitting at and not worth a push
somewhere else, and one shared set cannot say that.

| Trigger | Setting | Default | What the banner says |
| -- | -- | -- | -- |
| A session stops on the human (`waiting`, and only the two labels below) | *A session needs you* | **on** | `project — subject` / `Waiting for your approval — Bash` |
| A session's model call fails (`error` becomes non-null) | *A session fails* | **on** | `project — subject` / `The last API call failed` — or `A subagent's API call failed` |
| A session that was `busy` becomes `idle`, having called the model at least once | *A session finishes a turn* | **off** | `project — subject` / `Turn finished` |
| The connected SERVER is behind npm (`standing`, from `/api/update`) | *A new server version is out* | **on** | `seedeep <latest> is available` / `The server is running <its version>.` |

**Why one switch per trigger, and not one reason for one switch.** The events are not the same bargain: a
session stopped on you — by a question, or by a call that failed — cannot go on until you act, while
a session that finished is news you can read whenever you like. With a single toggle the only way to
stop the last is to silence the others, which is what the tray exists for. The finished banner ships
OFF for that reason; the failure banner ships **ON**, with the approvals, because the session has
stopped and *nothing on screen said so* — 39 of 47 real failures were the last thing their session
ever wrote, so the cost of not being told is the whole time until somebody looks.

**The release banner is the odd one out, and its rules are its own** (`update.rs`). The other three
are about a SESSION, fire on a transition in the digest, and can arrive several times an hour. This
one is about the tray itself and can be true while nothing is connected to look at.

- **Once per released VERSION, per RUN of the tray.** A banner repeated on every check is the
  notification people silence first — but remembering it FOREVER is worse in the case that actually
  happens, measured here on 2026-08-05: the banner for 0.11.1 was sent, macOS did not show it
  (a freshly installed unsigned bundle has no notification permission yet), and the version was
  recorded as announced. It could never be shown again. A fresh start is the one moment worth a
  second chance, because it is when a reinstall has just happened — which is exactly when the
  permission was lost. The memory is therefore in MEMORY: no file, no cleanup, and the rule falls out
  of the process's own lifetime. The `update-notified.json` the previous rule kept is deleted at
  start, so nothing is left for a user to find and wonder about.
- **The banner is about the SERVER, not the tray** (the maintainer's call, 2026-08-05, replacing the
  opposite rule). The tray is a client; the thing that is run, and that a stale version actually
  affects, is the server — and the case that prompted the change had a tray already current beside a
  server two releases behind, with nothing saying so. The verdict is the SERVER's own `standing`
  from `/api/update`, the same answer the portal shows, so the tray never recomputes it.
- **The PANEL still names both**, and marks whichever line is behind (`update_view`). The tray's own
  comparison lives in Rust with the other one; its version comes from `PackageInfo` — i.e.
  `tauri.conf.json > version`, the same number `getVersion()` gives the panel — and **never** from
  `env!("CARGO_PKG_VERSION")`: `Cargo.toml` is deliberately `0.0.0`, so the cargo variable would have
  compared `0.0.0` against every release and told every user, forever, that an update was available.
  The two ship from one tag but are updated apart — a DMG and an npm package are replaced by
  different acts — so comparing the server's number would announce an update the user cannot perform
  and miss the one they can. Only `latest` is taken from `GET /api/update`; the `standing` in that
  response is the server's.
- **Asked every 15 minutes, and SPAWNED rather than awaited** (`UPDATE_EVERY`) — the poll's loop
  paints the icon and feeds the panel, and an unreachable server would otherwise hold it for the
  whole request timeout. Overlapping runs are impossible: the clock is claimed before the request.
  The server answers from a file it
  refreshes once an hour, and DELIBERATELY shorter than that hour: asking on the same period as the
  cache expires would land the request just before the refresh as often as just after, making the
  worst case two hours rather than one. It is a local call against a cached file, so the registry
  sees nothing of it. The first check runs on the first tick, so a tray started after a release does
  not wait to say so.
- **The switch silences the banner, not the bookkeeping** — the same rule as the other three. The
  version is recorded as announced whether or not the banner is shown, so turning the setting back on
  does not replay a release the user was already past.

**A failure announces once, and re-arms on recovery.** It is a state, so `Watch` keeps a third set:
still-broken is not news on the next tick, and only a successful call — which clears the server's
`error` — makes the next failure announceable again. A session that breaks while it was ALSO stopped
on the user raises **one** banner, the failure, for the same reason `busy → waiting` is not also a
finish: one moment, one banner, and this is the more serious of the two.

**The switch says *fails*, while the band says *Broken*, and that divergence is deliberate**
(the maintainer's call, 2026-08-10). The band names a STATE the session is in and sits next to a red icon
that disambiguates it; the switch is read on its own in a list of four, where *a session breaks* is
as easily read as a session taking a break — which is exactly how it was misread once the
explanatory prose under each switch was dropped for space. Do not harmonise the two.

**The banner carries Claude Code's own words**, not a name of ours — `Not logged in · Please run
/login`, `You've hit your session limit`, `API Error: 529 Overloaded`. A category invented on top of
the one the CLI already wrote would send the user to the terminal to find out what actually
happened.

**A turn the user interrupted is never announced.** Esc means the user is standing at that terminal,
and telling them what they just did is how a notification earns a mute. The digest says so directly
(`turn.state === 'interrupted'`). Two neighbouring transitions are deliberately not finishes either:
`busy → waiting` is a session stopped ON you, which is the other trigger and would otherwise put two
banners saying opposite things on one moment; and a session that simply LEAVES the digest was closed
by the user, who does not need to be told.

**It fires on the TRANSITION, never on the state.** The watch (`notify-watch.ts`, in the server)
remembers which sessions were stopped on the human, which were at work and which had broken, last
time it could see; it announces only what was not there before. Three rules follow, and each of them
is a way of not lying about when something happened:

- **A turn that never called the model did not finish.** Esc pressed BEFORE the first reply leaves
  nothing in the transcript — no marker, no `interruptedMessageId`, no assistant line — so the turn
  is never marked interrupted, and the finish used to be announced minutes later, when liveness read
  from the process finally said idle. Esc that Claude Code DOES record was already covered: the
  marker line carries `interruptedMessageId`, the parser turns it into `turn-interrupted` before the
  next turn opens, and an interrupted turn has never notified. Measured 2026-08-11 over 533 real
  sessions: 24 turns of 2526 (1.0%) are the silent shape. The other zero-call turns are local slash
  commands (264, 10.5%), which never make a session look busy, so no finish was ever in flight for
  them.
- **A session already waiting — or already idle — when the tray arrives is not an event.** The first
  digest SEEDS the sets and announces nothing, and the sets are forgotten again the moment the last
  listener leaves, so whoever subscribes next also starts from a seed. Without that, opening the tray
  would replay every open prompt as if it had just happened — including one raised half an hour ago.
- **The sets are per session, not counts.** One prompt answered and another raised in the same
  interval leaves the count at one, and that is exactly the moment worth an interruption.
- LIMIT: a session that enters a wait, or finishes, during a stretch that could not be read is
  **never** announced — the next reading seeds it. There is no way to know when it happened, and the
  icon and the panel are what say where it now stands.

**A banner is one title and one line, and never the detail** (decided 2026-08-11). The line names
the event — `Waiting for your approval — Bash`, `in the terminal` when the transcript has not named
the call, `The last API call failed`, `Turn finished` — and stops there. The command awaiting
approval, the CLI's error text and the turn's own last words used to follow on a second line, and
none of them belonged: you cannot act on a banner (approving still means going back to the
terminal), a banner truncates exactly that line first, and every one of them is one click away in
the panel, where it is not truncated. The webhook settled it — it is the one channel whose payload
leaves the machine, so those second lines were shipping the contents of a work session to a
third-party service to say what the first line already said. The two channels carry the identical
text, so there is one thing to reason about.

The wording is still the panel's and the portal's, and now trivially so: the body IS that one line.
A finished turn with nothing on record notifies the same as any other — the event is the session
becoming yours again, not the text. The title is the session (`project — subject`), because the
banner already carries the app's name.

**A switch silences its banner, not the bookkeeping.** The switches filter the OUTPUT of the watch
and never its input (`notify-engine.ts`), so with one off the transitions are still tracked and
turning it back on announces what happens next rather than the backlog. The menu-bar icon is not
covered by any of them: it is peripheral information that costs nothing to ignore, and a user who
silenced the interruption has not asked to be blinded.

**Why none of it is decided here.** The rules above are the tray's rules and it obeys every one of
them, but it implements none: two implementations of one rule are free to diverge, which is how a
phone and a menu bar end up disagreeing about one session. The server already held the state and the
words, so it kept them.

**Verified end to end from the bundled app** (2026-07-30, macOS 26.5.2, unsigned `.app`), because
`docs/tray.md`'s own rule says a dev run cannot confirm this feature. A stub digest was flipped from
`busy` to `waiting` under a tray polling at the closed cadence, and Notification Center's own store
holds the record: `titl` = `atlas — add a retry to the uploader`, `body` = `Waiting for your approval
— Bash` (the command followed it on a second line until 2026-08-11, when the body became one line —
what that run PROVED, a single record per transition, is unaffected). **One** record across five
consecutive waiting readings, which is the
transition rule proven rather than argued. Repeated with the switch off: the same flip, no record at
all — that run flipped it in the tray's own `settings.json`, which is where it lived at the time.

### What an unsigned build can actually deliver

seedeep ships **unsigned** — no Apple Developer ID, no notarization. Both platforms restrict
notifications for such builds, and the restriction is not the same on each.

**macOS** — measured 2026-07-29 on macOS 26.5.2 with Tauri CLI 2.11.4, by sending one
notification each way and then asking Notification Center what it received (its store lives at
`~/Library/Group Containers/group.com.apple.usernoted/db2/db`):

| Run | `show()` returns | Delivered |
| -- | -- | -- |
| Unbundled binary — what `tauri dev` runs | `Ok(())` | **No.** The app is never registered and no record exists |
| Bundled `.app`, unsigned | `Ok(())` | **Yes.** The app is registered and the exact title and body sent are stored |

Two things follow, and the second is the one that costs time if it is forgotten:

1. **Unsigned is not the obstacle on macOS; being unbundled is.** A `.app` carrying only the
   linker's ad-hoc signature notifies. Signing and notarization buy a clean install past
   Gatekeeper — they are not what makes a notification appear.
2. **`Ok(())` is not evidence.** The API returns success in the case where nothing is
   delivered, so a dev run can never confirm this feature. Verify notifications from the
   packaged artifact, or do not claim to have verified them.

**Windows** — Tauri documents that notifications work only for an INSTALLED application; in
development the PowerShell name and icon are shown instead. That is why the Windows deliverable
is an installer rather than a portable `.exe`.

Together: **on both platforms the notification only works from the packaged artifact.** Same
conclusion, different reasons.

## Settings

**A view inside the popover, not a window of its own** (`ui/settings.ts`), reached from the gear on
the footer and left by the header's back button. The popover dismisses on focus loss, which is what
makes it behave like a menu; a second window would either inherit that rule and vanish while being
used, or break it and leave the app with two competing surfaces.

**The panel states, it does not explain.** Every switch used to carry a paragraph saying why its
DEFAULT was chosen — a design rationale, which is what this document is for. Measured at the real
392×560 (2026-08-05): 991px of content in a 514px viewport, so two of the four switches and the
whole About section sat below the fold, and "the server is behind" was ~990px down. Cut to labels
only, the same view is 606px and effectively fits. The switches themselves left later, for the
server's own panel, and what stands here now is one line saying where they are. Two sentences
survived the cut because they
prevent a MISREADING rather than justify a default — the menu-bar icon is never silenced by a
toggle, and quitting the tray does not stop the server — and one because it is the only honest thing
that can be said about delivery: a banner is the only proof. The interruption rule stays OFF the
label: a turn you stopped yourself never notifies, and saying so only made a reader wonder what the
exception was for — if you pressed Esc, you know. The rule is documented here, which is where a rule
belongs.

Five things, which is the whole surface:

| | |
| -- | -- |
| **The server** | Its address, and what identifies it: the pinned certificate whole, all 32 bytes, through the same renderer the trust screen uses |
| **One field** | The URL the portal's Settings → Remote access copies — the same `connect` command as the connection screen, so a server changed from here goes through the same trust and mismatch screens |
| **Notifications** | No switch: one line saying they are configured in seedeep's settings, in the browser — the server owns them, and two places to answer one question is one place too many (see [Notifications](#notifications)). Under it, a test banner on demand: the panel closes as it sends, because macOS draws nothing for the app in front |
| **Stop seedeep** | Only when the server is on this machine and Rust can name exactly one process for it — see [A stop is aimed at the connection](#a-stop-is-aimed-at-the-connection) |
| **About** | Both builds — `seedeep tray <version>` from `getVersion()`, and `seedeep server <version>` from `GET /api/config`, read when this view opens and never on the poll. Whichever is behind npm carries `— <latest> available` **on its own line**, so which install needs updating is never left to the reader; nothing is added when neither is |

Rules that are not preferences:

- **A tick does not redraw this view.** Nothing on it moves on the server's clock, and re-rendering
  once a second would wipe a half-typed URL out of the field. The one thing that gets through is a
  status that has stopped being `connected`, which takes the panel back to the screen that can fix it
  — and does not leave the flag behind to spring back on the next tick.
- **Closing the popover leaves the settings behind.** *While nobody is looking the panel is a mirror*
  covers which SURFACE is up, not only the rows: the window is hidden and shown, never reloaded, so
  without this rule a settings screen left open yesterday is what the next click on the icon would
  show. Same flag (`open` on the reading), same rule as the ended row.
- **A message is the first thing on the surface**, whatever produced it — the same rule as the bands'
  error. This view is taller than the popover and every render starts it at the top, so a message
  appended at the end is one about a click that just happened, below the fold.
- **The settings exist only over a connected server**, so there is no gear on the connection screens.
  Every setting here is either about the server the tray is talking to or about notifications that
  only readings can trigger; with nothing connected the connection screen already offers the one
  field that helps.
- **Each version says whose it is** — `seedeep tray 0.1.1` and `seedeep server 0.1.1`, never a bare
  number. The two are separate downloads that update apart, so a bare version read here would be
  quoted in a bug report as the other's, and a pair that differs is drawn as the ordinary state it is:
  **no warning**, because calling a working pair "mismatched" would invent a problem out of a version
  string. A server that did not answer with one gets no line rather than an "unknown". It is on THIS surface
  rather than the footer for the reason the `pinned` chip left it: a value that never changes while
  the panel is open stops being read where the sessions are, and this is where the static, quotable
  facts already live. A version that could not be read draws no About section at all — a heading over
  a blank line would state that the tray does not know what it is.
- **The server section says three different things, not one with holes in it**: a pinned certificate,
  or "plain HTTP, so there is nothing to pin", or — for `http://127.0.0.1:44842` — "the tray found
  this one by itself". An empty space where a fingerprint would be reads as *not checked yet* rather
  than as *nothing to check*.
- **Nothing on this surface writes a setting**, which is why none of it can be left showing a value
  the disk does not hold. The four switches were here once, as `<button role="switch">` toggles that
  drew what the app answered rather than what the click intended; they left for the server's panel,
  and the rule left with them. What is here now either states a fact (the server, the versions) or
  performs an act (connect, test, stop) whose answer is the next screen.

**Why a test button exists at all.** There is no way to ASK whether notifications will arrive: the
plugin's `permission_state()` is a hardcoded `Granted` on desktop (verified in
tauri-plugin-notification 2.3.3, `desktop.rs`), and `show()` returns `Ok(())` even when nothing is
delivered. So the honest surfacing of that degradation is the only check that exists — send one and
look.

**The popover closes as it sends, and that is the test, not a courtesy.** macOS does not PRESENT a
notification posted by the app that is FRONTMOST — Apple says so on `shouldPresentNotification:`
("the Notification Center has decided not to present your notification, for example when your
application is front most", `NSUserNotification.h`) — and clicking this button is the one moment the
tray is frontmost, because the popover takes focus when it opens. So the button posted a banner
macOS was never going to draw, while every real one kept arriving: those are posted while the user
is somewhere else. The delegate callback Apple documents as the override is not implemented by
`mac-notification-sys`, so there is nothing of ours to answer YES with — the tray has to stop being
frontmost instead. `test_notification` therefore hides the panel, **hides the app**, waits out
`NOTIFY_SETTLE`, and only then sends.

**Hiding the WINDOW does not do it, and neither does asking to deactivate.** Both were shipped and
both failed, which is why the mechanism is written down here with what was measured rather than with
what it reads like. An `Accessory` app owns no other window to fall back to, so hiding its only one
leaves it the ACTIVE app with nothing on screen — the state that matters is activation, not
visibility. `NSApplication.deactivate` says exactly that intent and does nothing: sampled on a clock
(2026-08-13), `isActive` was still `true` at +0.3 s, +1 s and +3 s. Nothing was there to take the
activation, so the request had nowhere to hand it. `NSApp.hide:` — Tauri's `AppHandle::hide` — hands
it to the next app in line, and `isActive` is `false` by +0.3 s. That measurement is also where
`NOTIFY_SETTLE`'s 400 ms comes from.

**Its cost is the HIDDEN state, and `toggle_panel` is what pays it**: every window of a hidden app
stays down until something unhides it, so the click after a test would otherwise open nothing. It
calls `AppHandle::show` before showing the window, which is harmless in every other case. The branch
above it stays correct on its own: a window of a hidden app reports `is_visible() == false` (measured
in the same run), so the click takes the path that opens the panel rather than the one that dismisses
it. Whether `show` also ACTIVATES is left unstated here and in the code, because it cannot be
settled from the documentation — `AppHandle::show` is `NSApplication.unhide:`, whose Apple page says
"makes the receiver active" in the abstract and "invokes `unhideWithoutActivation`" in the
discussion. Nothing depends on it: `set_focus` decides the activation on the next line.

**There is no receipt, and there must not be**: the surface that would carry it is the one being put
away. The banner IS the answer — the same rule the stop follows, where the screen that comes next is
the receipt — and the caveat that a system can hide them silently sits on the button's own note,
read while deciding to click. The note also says the panel will close: a popover that vanishes
unannounced reads as a crash.

## Platforms

macOS and Windows. **Linux is not a target**, and not because nobody got to it: Tauri documents
that tray click events are not emitted on Linux — the icon appears and right-click still opens
a context menu, but the left-click that opens this panel never arrives. A Linux build would
silently be a different product, a context menu instead of a panel. If it ever ships it has to
be designed as that, deliberately.

### The one permission the tray asks for

macOS gates reaching the local network, and the tray reaches it for one reason: a server announces
the address it answers on, and with remote access configured that address is a hostname on the LAN
rather than loopback. Resolving it — the identity test above — and connecting to it are both on the
far side of that gate.

The reason is DECLARED, in `src-tauri/Info.plist`: `NSLocalNetworkUsageDescription`. Tauri looks for
that file beside `tauri.conf.json` and merges it into the generated one (verified in `tauri-utils`,
`MacConfig::info_plist`), so there is no config entry to keep in sync with it. Without the string the
system shows the request with no reason attached — the same *documented, not discovered* rule the
README applies to Gatekeeper, and the README carries the user-facing half of this one.

Refusing it is a supported state, not a broken one: the tray falls back to asking for the URL, and
Start stops being offered for a server that names itself by hostname. In the default loopback setup
the gate is never reached at all.

**Every update re-asks, and that is what unsigned costs.** Observed across 0.7.0 → 0.9.0 on one
machine: the same bundle identifier, an `allowed` row already in the TCC database, a new build — and
the dialog again, with the row re-decided at the moment it was answered. `codesign -d -r-` on the
installed app says *"code object is not signed at all"*, so there is no stable code identity for a
grant to attach to; a rebuild is a different object. Preferences and the stored connection survive
(those hang off the identifier), the permissions do not. It belongs beside the Gatekeeper warning in
the README as a second, recurring cost of shipping unsigned — the first is paid once, this one on
every release.

Which is also why the dialog naming the right app matters. Until 2026-08-04 it said *"seedeep"* for
both programs; it says **`seedeep-tray`** now, which is the honest answer to *"who is asking?"* — the
tray, on behalf of the server it started, since macOS attributes a child's request to the app
responsible for it.

The **server** trips a different one — `~/Documents`, when a session's repository lives there and the
Commits or Changed files card runs read-only git in it. That belongs to the server, not here; the
README documents both together because a user meets them together.

## Packaging and releases

`.github/workflows/release.yml` builds what a user downloads. **A tag is the only thing that
publishes**: pushing `v*` creates a **draft** release, both build jobs upload into it, and a last
job (`publish`) flips it. A manual run (`workflow_dispatch`) builds exactly the same artifacts and
leaves them on the workflow run: every step that writes to the repository is gated on
`github.ref_type == 'tag'`, so the pipeline can be proven without cutting a release, which is the
one step here that cannot be taken back.

**A release has two halves.** The `server` job builds the server's six executables
(`docs/architecture.md`, *Shipping the server*); this one builds the installers. They no longer wait
for each other: the draft is created by a job of its own (`gh release create --draft`) rather than
by `tauri-action`, which used to make the server queue behind a 14-minute Windows build for nothing
but the release's existence. That job **always runs** and only its writing step is conditional — a
job skipped for want of a tag would take both builds with it, since `needs` reads a skipped
dependency as a reason to skip.

**Every asset says which app it belongs to** — `seedeep-tray_<version>_universal.dmg`,
`seedeep-server_<version>_macos-arm64`. The bundler names its output after `productName`, which **is**
`seedeep-tray`, so nothing needs renaming on the way out. `tauri-action` is still run with
`tagName: ''` — build only, touching nothing — and a `bash` step (the Windows runner defaults to
PowerShell) copies the bundles into `dist/`, the same path the server's job uploads from. It **fails
when nothing matched**: a naming change in Tauri must stop the release, not quietly publish one with
no installers in it.

`productName` was `seedeep` until 2026-08-04, on the grounds that it is what the menu bar, Finder and
the About section show, and that only the download page needed disambiguating. That was wrong about
which surfaces matter. Two programs sharing one name made a **system permission dialog unreadable** —
macOS names an app by `CFBundleDisplayName`, which is `productName`, so the dialog said *"seedeep"*
whether it was asking for the tray or on behalf of the server — and it made `killall seedeep` reach
the server rather than the app the user meant. The bundle IDENTIFIER did not change
(`app.seedeep.tray`), so the permission already granted, the config directory and the Windows
uninstall key all survive the rename.

**Publishing is a separate job, and that is what makes it safe to automate.**
`needs: [tray, server, smoke]` will not start it unless EVERY matrix build, the server's own job and
the smoke run of all six executables succeeded (`docs/architecture.md`, *Shipping the server*), so a Windows failure
— or a server that would not compile — leaves a draft rather than putting half a download page in
front of people; and it runs once, where the build job runs per platform. Publishing from a build
job instead would put a release on the download page as soon as the FIRST runner finished — one
installer out of three, live, for the minutes the others take.

Leaving it a draft was the earlier rule, and it does not survive going public: a draft is invisible
to anyone without push access and is never `releases/latest` (GitHub's REST docs — *"Only users with
push access will receive listings for draft releases"*, and the latest release is *"the most recent
non-prerelease, non-draft release"*). The README links `releases/latest`, so an unpublished release
is a download link that leads nowhere. The tag itself stays public either way; only the installers
are out of reach.

**The release note is install instructions, not a disclaimer.** Both systems interrupt the first
launch, and a note that does not say so lets that interruption read as a broken download — so it
carries the gesture that gets past each one, in the words the system itself uses (*Open Anyway*,
*Run anyway*), and never a label about how the build was made. The absence of a signature is a fact
about the build; what the reader needs is the next click.

| Platform | Artifact | Why this shape |
| -- | -- | -- |
| macOS | ONE universal `.dmg` (`seedeep-tray_<version>_universal.dmg`, 6.6 MB for a 15 MB app) | `--target universal-apple-darwin`, so the download page never asks which processor the reader has — a question people get wrong, and the wrong answer is an app that will not start |
| Windows | TWO NSIS installers, `…_x64-setup.exe` (4.2 MB) and `…_arm64-setup.exe` | Its default `currentUser` install mode needs no Administrator rights. A UAC prompt for an unknown publisher is where an unsigned installer loses people, and `.msi` documents no per-user mode. Two files rather than one because Windows has no universal binary: the reader picks the processor, which is the question the macOS DMG exists to avoid |

The DMG and the x64 `-setup.exe` were built by a real run and inspected rather than trusted: the DMG
mounts to `seedeep.app`
beside the `Applications` symlink, `lipo` reports `x86_64 arm64`, and `CFBundleShortVersionString` is
the `package.json` number; the Windows artifact is a `PE32 executable (GUI) … Nullsoft Installer
self-extracting archive`. A cold runner with no Rust cache takes about 9 minutes on macOS and 14 on
Windows. **The arm64 leg has never run**, so nothing here is measured about it — not the build time,
not the artifact, not whether the runner's toolchain carries what Tauri needs. A
`workflow_dispatch` run is what would settle that before a tag depends on it.

Windows is why this is CI and not a script on a laptop: Tauri's own recipe uses one runner per
platform, and it documents building the Windows installer from a Mac as possible for NSIS only
*"with caveats"* and *"not tested as much"* — and impossible for `.msi`, since WiX runs on Windows.
The macOS half could be built locally; it is there so both halves of a version come out of the same
commit and the same recipe — the [one version](#one-version-for-every-deliverable) rule, applied.

**The arm64 installer is built natively on `windows-11-arm`, not cross-compiled**, though it could
have been: the `windows-latest` image carries `VC.Tools.ARM64`, so the x64 runner has everything
`--target aarch64-pc-windows-msvc` would need. What it does not have is a recipe Tauri documents —
the installer guide describes adding the ARM64 build tools to the machine that BUILDS, and says
nothing about a host-to-arm64 cross-build. The native leg differs from the x64 one by its runner
alone, with no flag to get subtly wrong, and the runner is GA and free on public repositories
(2025-08-07); its image already carries VS 2022, Rust and NSIS. **The installer itself stays x86**
either way — Tauri documents that it runs under emulation on the ARM machine, and only the app
inside it is native arm64.

**The workflow sets `TAURI_BUNDLER_DMG_IGNORE_CI: 'false'`, and that is not a formality.** The
bundler passes `--skip-jenkins` to `bundle_dmg.sh` — skipping the Finder-prettifying AppleScript —
only when `CI=true` AND that variable is not `"true"`; `tauri-action` sets it to `"true"` by
default, which turns the AppleScript back on. That step is exactly what failed when this DMG was
first built locally (`error running bundle_dmg.sh`, and the same build succeeded under `CI=true`),
it needs an automatable Finder to succeed, and it applies a window layout this app does not
configure. It can only cost a release, never improve one.

The asset name carries the version, so the README links the **releases page** rather than a fixed
filename: an installer sitting in a Downloads folder should be able to say which version it is.

### What is signed, and what that costs

Nothing. The bundle carries only the linker's ad-hoc signature, and both systems react:

- Measured on macOS 26.5.2, on the real universal bundle: `spctl -a --type exec` answers
  **`rejected — source=no usable signature`**, and Apple's own `syspolicy_check distribution` calls
  it *"not signed at all"* plus *"This app is adhoc signed. While it may run locally, adhoc signed
  apps are not suitable for distribution."* The DMG was quarantined by hand the way a browser stamps
  a download (`com.apple.quarantine`), and the flag propagated to the app copied out of it.
- **The first-launch dialog is real, and it was seen** — on a double-click, after downloading the
  DMG: *"Apple could not verify "seedeep.app" is free of malware that may harm your Mac or
  compromise your privacy."* The way through is Apple's documented one for macOS Tahoe 26 (System
  Settings → Privacy & Security → Security → *Open Anyway*, then the login password, with the button
  offered for about an hour after the refused attempt).
- **How that was nearly written down wrong.** Before anyone double-clicked it, the same quarantined
  app was launched twice from a shell — the second time with a fresh code identity, so no earlier
  assessment could be cached — and **it ran translocated with no prompt at all**. The launch path
  was `open` over an SSH session, which is not a gesture any user performs. Two conclusions, and the
  second is the reusable one: a shell over SSH cannot answer a question about a GUI decision, and
  *"I could not reproduce the block"* is not *"there is no block"*.
- **Nothing about Windows is measured**: no Windows desktop is used here, and neither installer has
  been opened on one. The SmartScreen wording in the README is Microsoft's documented behaviour, not
  an observation.

Signing and notarization stay out of scope until there is a release worth signing (EPIC 4).

### Uninstalling, and why only one platform has an uninstaller

**The two halves differ because the bundler does**, not because anyone chose it here. Tauri v2's
`BundleTarget` offers macOS exactly two formats — `app` and `dmg`
([Tauri config reference](https://v2.tauri.app/reference/config/)) — so there is no installer to
build for it, and nothing to run on the way out: the DMG is the drag, and the Trash is the reverse of
it. Windows gets `nsis`, which registers an uninstall entry, so there it is a program in both
directions. A macOS `.pkg` would have to be built outside Tauri, and unsigned it buys a worse
first-run than the DMG rather than a better one.

**What survives an uninstall is the app config dir, on purpose.**
[Where the connection lives](#where-the-connection-lives) is keyed on the bundle identifier, so a
reinstall of the same app finds its pinned server where it left it — the same
property that carried them through the `productName` rename. On macOS nothing removes it and the
README names the path. On Windows the NSIS uninstaller draws a **Delete app data** checkbox on its
confirm page, **created unchecked** — Tauri's `installer.nsi` creates the box and never sends it a
`BM_SETCHECK` — and ticking it is what runs `RmDir /r` over `%APPDATA%\app.seedeep.tray` and
`%LOCALAPPDATA%\app.seedeep.tray`. That is read from Tauri's template, not observed: no Windows
machine exists here, the same limit *What is signed* states above.
