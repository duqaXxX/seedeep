# Changelog

All notable structural changes to seedeep are recorded here, newest first.

## Unreleased

**The tray's popover opened off the bottom of the screen on Windows, and collapsed while it did.**
The panel was anchored below the icon unconditionally — correct for a menu bar, which macOS always
draws as the top strip, and wrong for a taskbar, which sits on any edge and puts its icons in the
lower half on three of the four. The top edge landed below the taskbar, so the panel was off-screen;
the room below it was then a few pixels, so the height collapsed to the 90 pt floor and the content
scrolled inside. Two symptoms, one cause. The direction is now read off where the OS drew the icon
inside the work area, so nothing about the platform is assumed, and a test holds the macOS behaviour
still — which the rule guarantees by construction, since a menu-bar icon is always in the upper half.
The absent work area is its own branch rather than an infinite pair: infinities make the midpoint
`NaN`, every comparison with `NaN` is false, and the direction would have fallen back to downward on
exactly the machine whose window is off the screen.

**`restart` left the old server stopped and no replacement running, on Windows.** The handover
spawns the successor and exits, and a Windows child stays in its parent's job object: it was
terminated the moment the parent went, before writing a single line. `detached` is what breaks it
out, and it is now passed **on Windows only** — on POSIX that flag is `setsid()`, so passing it
everywhere would take the successor out of the terminal's session and leave a Ctrl-C reaching
nothing and a closed terminal leaking an orphan on the port. Nothing there needs it; `unref()` plus
adoption by init already outlives the parent. Measured on Windows 11 arm64, 2026-08-14, on the
machine where `seedeep start` — which always passed the flag — survived ten starts of ten. Three
surfaces, not one: `seedeep restart`, the portal's Restart button, and the restart after a
configuration change. The command line and the flags now come from one exported `selfSpawnPlan`,
because a test that injects `spawnSelf` can never see how the real one spawns, which is exactly
where the defect lived.

**Launching the tray on Windows opened a console window that stayed for the life of the app.** The
line Tauri's own template carries — `windows_subsystem = "windows"` — had never been added, so the
release binary was linked as a console subsystem application and Windows gave it a terminal.
Invisible on macOS and Linux, where rustc ignores the attribute, which is how it got this far.
Observed on Windows 11 arm64, 2026-08-14. The notification probe writes its outcome to a
`notify-probe` file as well as printing it, since without a console the print was the only record of
the one question Windows notifications still have open.

## 0.25.0 (2026-08-14)

**A publish to npm that dies halfway can now be re-run.** The step published seven packages in a
loop under `set -e`, and npm is immutable — *"once published, a package cannot change"* — so the
re-run failed on the FIRST package instead of finishing the rest, leaving the wrapper naming
binaries at a version nobody had published while the release page stayed green (the `npm` job is
not a dependency of `publish`). A version already on the registry is skipped now rather than
retried, which is the property `--clobber` gives the release half of the same tag. It takes a
dropped connection on a 40 MB tarball to need it, or a package added since whose trusted publisher
is not configured yet — the arm64 one was exactly that.

**Windows on arm64 was an install that could begin and never finish.** `npm i -g seedeep` on a
Snapdragon laptop — where the Node.js winget installs is the native arm64 build — died with
`seedeep: no build for win32 arm64`, on the command the README puts first, with nothing to say the
cause was the interpreter and not the package. The wrapper's `os` and `cpu` are two independent
lists and npm reads them as a cross product, so `win32` × `arm64` was a pair npm accepted and no
package carried. Bun documents a `bun-windows-arm64` target now (verified: compiled from a macOS
host it produces a `PE32+ … Aarch64` executable), so the sixth binary is cross-compiled beside the
other five on the same runner and `seedeep-windows-arm64` joins the npm channel. The smoke job
gains a `windows-11-arm` leg, since nothing else in the workflow would ever EXECUTE that file. The
tray gets an arm64 NSIS installer of its own, built natively on the same runner rather than
cross-compiled from the x64 one: Tauri documents adding the ARM64 build tools to the machine that
builds, never a host-to-arm64 cross-build, and the native leg differs by its runner alone. The test
that covered this ground asserted the HOLE — that `seedeep-windows-arm64` was absent — and so
passed happily while the channel was broken; it now walks the whole `os` × `cpu` cross product and
demands a package behind every pair.

## 0.24.0 (2026-08-14)

**No release publishes until every executable in it has actually been STARTED.** All five server
binaries are cross-compiled on one `ubuntu-latest` runner, so the Windows binary and both Linux ARM
binaries had never been executed on any machine, ever — the shape of the v0.6.0 failure, five green
artifacts dead at startup everywhere but where they were built, invisible from the workflow's own
checkmarks. `release.yml` now has a `smoke` job that downloads each asset onto a runner of its own OS
and runs `.github/scripts/smoke-server.sh`: `--version` must print the version being released (which
also catches a forgotten bump), `GET /api/config` must answer, and `/`, `/lib/app.js` and
`/css/chrome.css` must answer too — the browser GUI is embedded by `with { type: 'file' }` imports,
and the measured failure of a first compile was an API that answered while every static path 404'd.
It gates both exits: `publish` (a broken build stays a draft) and `npm` (which cannot be taken back
at all). On a tag the asset comes from the release, which also proves the upload happened; on a
manual run from the run's artifact, so the matrix is provable without cutting a release. Every step
is `shell: bash`, Windows included, because `"$TAG"` in PowerShell is an unassigned variable — the
reason v0.6.0 uploaded no Windows installer.

**One number wore two names on the same page.** The session banner said `33 calls`, the Session
card's footer said `33 API calls` about the same field, a turn's scope said `5 API`, and the Cards
drawer said `4 calls` about something else entirely — how many TOOL calls named that card. Nothing
on screen said which was which, and nothing said what the number leaves out. Every surface that
counts `apiCalls` now says **`API calls`** (banner, Compare row and its hover), the Cards drawer says
**`tool calls`**, and the banner's group carries a `title` glossing each count in the order it
appears — `rounds of work · model calls on the main thread, subagents excluded · tool uses`. The
gloss is built alongside the parts, so a count that is absent cannot leave the hover describing it.
The Compare row deliberately gets no tooltip of its own: that row's hover exists to show the text an
ellipsis cut off, and a span-level title would take it away exactly where the row is widest.

**The empty Home now opens with the reason it is empty, not with a pitch.** It said *"No finished
turns yet — run a Claude Code session and this fills in as it lands on disk"* — one sentence for
three different situations, true in one of them. It now states the requirement first (*"seedeep
needs a Claude Code session. There is none on this machine yet"*), then what to do and what is being
watched, with the privacy claim attached to `~/.claude/projects` rather than standing alone. A
session that exists without a finished turn gets its own wording and a pointer to the picker, where
it is already watchable; a retrospective that never arrived drops the claim about the machine
entirely, because nothing was read.

**`1 turns across 1 sessions`** — and not only in the title. The count-noun pairs on this page were
written with a fixed plural, so a corpus of one read wrong in four places at once: the title, the
`spent working` tile, the `verdict split` card and the re-entry line (`11 of 1 sessions over 10%`).
Worst exactly for a newcomer, who is the one reader with exactly one of each. A three-line local
`plural()` now spells all four — local because the two other spellings in the client (`turnsWord` in
graph.ts, `plural` in trace.ts) live in modules this one has no reason to import.

**Which wording appears comes from the roster, and that is the bug this found.**
`Retrospective.sessions` counts only sessions that closed a turn (`aggregate()` filters on
`turns.length > 0`), so a transcript with none is 0 there and 1 in the picker sitting directly above
the box — measured on a truncated transcript: roster 1, retro 0. Reading the retrospective here
would print "there is none on this machine" over a picker listing one. **And the box paints before
the first roster reading lands**, which no unit test could see: `HomeView.repaint()` (a redraw, no
corpus scan) is now called whenever the roster's length changes, outside the `booted` guard that
deliberately skips the first expensive re-scan.

## 0.23.1 (2026-08-14)

**Closing the panel from the menu-bar icon was dropping the REAL banners too**, and nothing had ever
noticed. It hid the window and stopped there, which for an `Accessory` app — no other window to fall
back to — leaves it the ACTIVE app with nothing on screen, the one state macOS draws no banner for.
So after opening and dismissing the panel from the icon, a session stopping on a question announced
itself to nobody until the user happened to click on something else. Dismissing by clicking
elsewhere never had the problem: that click is itself the activation ending. Both gestures now leave
the same state. Found while fixing the test notification below — same rule, other gesture, and the
one nobody was looking for.

**The test notification needed the app to stop being ACTIVE, not just to put its window away.** The
fix in 0.23.0 hid the popover and posted; the popover went away and the banner still landed in
Notification Center without ever being drawn, while real banners on the same machine and the same
build kept appearing. The missing half: an `Accessory` app owns no other window to fall back to, so
hiding its only one leaves it the frontmost app with nothing on screen — and frontmost is the state
macOS refuses to draw a banner for. `test_notification` now hides the APP after hiding the panel.

**`NSApplication.deactivate` was tried first and does nothing here**, which is worth recording
because it reads like the exact intent. Sampled on a clock, `isActive` was still `true` at +0.3 s,
+1 s and +3 s after the call: with no other window of ours to fall back to, nothing takes the
activation and the request has nowhere to hand it. `NSApp.hide:` hands it to the next app in line and
`isActive` is `false` by +0.3 s — the same measurement `NOTIFY_SETTLE`'s 400 ms now comes from. The
cost is the HIDDEN state, so the menu-bar click unhides the app before showing the panel; a window of
a hidden app reports itself invisible, so the toggle still takes the branch that opens it.

## 0.23.0 (2026-08-13)

**The tray's test notification sent a banner macOS was never going to draw.** Every real banner
arrived — a session stopping on a question, a call that failed — and the one the button posts never
did, which is the shape that made it look like a broken command. It was not: macOS refuses to
PRESENT a notification posted by the app that is frontmost (Apple's `NSUserNotification.h`, on
`shouldPresentNotification:`), and clicking that button is the one moment the tray is frontmost —
the popover takes focus when it opens. The real banners are posted while the user is somewhere
else, so they were never subject to the rule. The override Apple documents is a delegate callback
`mac-notification-sys` does not implement, so there was nothing of ours to answer YES with; the
receipt said "Sent." because `show()` returns `Ok(())` even when nothing is delivered, which is the
degradation the button was built to expose in the first place.

The test now reproduces the condition a real banner arrives in: `test_notification` puts the
popover away, waits for the window server to hand activation back, and posts. There is no receipt
any more — the banner IS the receipt, the same rule the stop already follows — and the caveat about
a system that hides them moved onto the button's own note, where it is read while deciding to
click rather than on a screen that has since closed. The note also says the panel will close, since
a popover that vanishes unannounced reads as a crash.

**`docs/tray.md` was describing a tray that had stopped existing.** The audit came out of the fix
above and covers everything it touched: the file map listed a `src/settings.rs` that is gone and
omitted `local.rs` and `update.rs`; the command list named four `read_settings` / `set_notify*`
commands the app does not register; the config directory was said to hold two files when the tray
writes one; the notification rules were credited to `Watch` in `poll.rs` two paragraphs after the
same page said they had moved to the server; and the settings surface was documented with four
switches it has not carried since they moved to the portal — including a rule about how their
toggles redraw. `docs/features.md` had two of its own: the tray's switches described as edited from
the tray, and a finish banner still carrying "the agent's last words", which it has not since the
body became one line.

**A session you came back to with `--resume` was tracked again only after a browser refresh, and
the tab was the reason.** When Claude Code exits, its PID file goes and the tab freezes into the
ended presentation — correct, and confirmed by a second reading (`end-guard.ts`). What was wrong is
that the freeze also RETIRED the tab's reader, and nothing could ever build it another: `--resume`
continues the SAME session id (0 of 519 local transcripts carry a foreign one), so the resumed
session can never be handed a new tab — nothing auto-opens it, and picking it from the dropdown
only switches to it. Two comments claimed otherwise ("it reappears in the dropdown for the user to
pick", "comes back as a NEW tab") and both described a path that could not run. The tab stayed dim
and frozen for the life of the page while the session worked on.

The freeze is now reversible. `graph.setLive` / `view.setLive` / `tabBar.clearEnded` undo it in the
order `end` applied it, and the poll that sees the session live again calls `revive`, which then
asks the replay endpoint for the TAIL the tab missed — the watcher tails LIVE sessions only, so
whatever was written in between never came down the stream. Two invariants make that possible: the
tab's reader now outlives the SESSION (`stop()` means the tab is gone, and the tab is still here —
a read still in flight also gets to finish its history, which the old `stop()` cut short), and a
tab subscribes to the live stream even when it opens onto a session that is already dead, because a
subscription cannot be added afterwards without a second reader double-counting the file.

Verified both ways, twice: the shell test drives roster → freeze → resume and asserts the resumed
session's events reach the strip, and it goes red with either half of the fix removed; and a live
check drives a real server and a real Chrome against a synthetic session store, where the turn
written after the resume appears with no reload — and times out without the fix.

## 0.22.2 (2026-08-13)

**The tray mark is drawn on a pixel grid now, and it is the reason it stopped looking blurred.** The
screen it was judged on is 1×, so 18 points are **18 pixels for the whole icon** — the glass leaves
about 13 inside itself, and three bars with their gaps want more than that. Written in fractions of
a unit square, every edge fell part-way across a pixel and macOS filled the difference with grey:
the gaps came out under a pixel and the bars merged into a smudge. `icon.rs` is now expressed in
whole pixels of an 18×18 grid — glass 2 px, bars 2 px, rows 4 px apart, square ends instead of
round — and the buffer still ships at 36 so retina gets 1:1 and 1× halves it exactly.

**The motion moved to the glass**, on the maintainer's call: a gap that runs round the ring, a turn
every two seconds. Every earlier version of this icon animated its middle and left the outline
alone, but the bars are the smallest thing the lens has and moving them shifted about 4 px of ink —
invisible at this size. That reversal cost one test its shape:
`the_mark_is_the_same_size_in_every_state` now measures the UNION of the turn rather than each
frame, since the frames where the gap passes the left of the ring legitimately leave those columns
empty.

Waiting draws its bars **heavier as well as longer** — 3 px instead of 2. Longer alone left only 7%
of the ink between it and broken, which is the pair a red-green deficiency reads worst; the two are
now about a fifth apart. The browser icons are untouched: the logo keeps its own proportions, and
this is an optical size, the same way the 16 px ICO already is.

## 0.22.1 (2026-08-13)

**The tray icon was soft, and the cause was its buffer rather than its drawing.** `tray-icon` pins
the image with `nsimage.setSize(18)` — a size in POINTS — so on a retina screen AppKit has 36
physical pixels to fill and the 26-pixel buffer was being enlarged 1.38× and interpolated. Every
stroke arrived blurred, which no amount of redrawing could have fixed. The buffer is now 36×36: one
buffer pixel per screen pixel on retina, an exact halving on a 1× screen. It costs 24 × 5.2 KB of
rasterised frames instead of 24 × 2.7 KB.

With the pixels landing true, the strokes were also taken up from 0.075 to 0.095, and the trace's
rows spread wider to keep waiting's thickened bars from welding together. **The browser mark keeps
0.075 and is not meant to match**: 18 points in a menu bar is an optical size, exactly as the 16 px
ICO already is.

## 0.22.0 (2026-08-13)

**The mark is a lens, not an eye.** The eye was drawn for the name — seedeep, *see* — and said the
wrong thing about a tool whose whole argument is that it only ever READS: an eye with a pupil and a
highlight is the iconography of spyware, and it sat permanently in a menu bar. What replaces it is
a **lens with no handle**: a ring of glass over a trace, three spans stepping right, which is the
shape the Trace tab draws. One geometry serves every surface (`icon.rs` for the tray,
`generate-favicon.ts` for the browser, the app icons and the social card generated from that SVG).

**A fingerprint was built first and thrown away, and the reason is worth keeping.** It was checked
against the system glyph it could be confused with — wifi — and cleared. It was not checked against
the third-party icons that share the menu bar, and an arc over a round body is the OpenVPN
padlock's skeleton. The test a mark has to pass is not "is it distinct from macOS" but "is it
distinct from what is actually in the bar next to it".

No handle, for the two reasons that made a magnifier look unusable earlier: the handle is a
diagonal that fights the unreachable slash, and it is the stroke that makes the glyph read as
*search*, which seedeep already spends a tab of its own on. Without it the objections go, and what
is left says what the tool does — glass over data.

Four things were settled by rendering them at 18 pt rather than by argument. The ring and the bars
are drawn at **one stroke weight**: the ring had been half again as heavy as the trace it sits
over, which is a mismatch with nothing behind it. The bars **leave the glass room** — they first
reached to within 0.4 px of it, which reads as crowding. The working state **breathes**, every span
running out together, because moving one of them shifted about 4 px of ink and at that size the
signal is how much ink moves. And the badge **rides the ring** at the upper right with a moat of
its own, inside the circle rather than beside it, so it costs the mark no size — the rule that made
the eye shrink when the badge was given a corner. The buffer is 26×26, the first square one this
icon has had.

**Broken lost its cross, and the guard rail was retuned rather than removed.** It is now the plain
mark in red — the maintainer's call, made looking at it beside waiting at 18 pt. That leaves only
waiting's thicker bars to tell the two apart, measured at 21% of the ink where the cross had
differed by most of it, so
`a_failed_icon_differs_from_a_waiting_one_by_its_shape` now demands 15% instead of 25%: under the
fact, far above zero. A change leaving hue as the only difference between them still fails, which
is what that test exists for — red against amber is the pair a red-green deficiency reads worst.

The 16 px ICO is **rasterised from the geometry** rather than plotted on a hand-written grid, with
an optical size of its own — the glass and two spans, because three leave under a pixel of gap
between them and merge into a block. The grid it replaced meant the small icon was a drawing of the
large one and could disagree with it silently.

**The intermittent CI failure had a cause, and it was in the other app.** Three graph tests died in
`trace.ts`'s `destroy()` on `window.removeEventListener`, green locally and red on CI on the same
commit. The installer was `apps/tray/tests/panel-tick.test.ts`, which put
`{ addEventListener }` on the GLOBAL at module scope — everything `panel.ts` needs, nothing anybody
else does — and never took it down. `bun test` shares one process and `node:test` interleaves files,
so whether that module was evaluated before or after another file's teardown decided the run. It was
never found by reading, over four rounds of it: the searches covered `apps/server`, and the two apps
share one suite. What found it was a **setter trap** — `defineProperty` on `globalThis.window`
printing the shape and the stack of whoever assigns it — which names the installer on every run
rather than only when the failure fires, and named this one on the first try. There is now one
definition of a fake window, `fakeWindow()` in `tests/fake-dom.ts`, carrying the whole contract and
used by both stubs, so a stub sized for one file can no longer crash another.

**harden-runner is out, one release after it went in.** It was adopted on the premise that watching
CI's egress costs nothing, and the premise was false: `setup-bun` died with `socket hang up` four
times in an hour, on Ubuntu and on Windows, at the toolchain download that follows the agent's
instrumentation — where the whole prior history has none. It left 0.21.0 a draft with six of its
seven assets and nothing published to npm. Causation is NOT proven, and StepSecurity's own telemetry
argues against a policy block: 36 destinations, all allowed, no detections. But the trade decided
itself — what it bought was visibility that had never once fired, and what it cost was half a
release. GitHub's own hardening guidance names four practices — pin actions to a full commit SHA,
keep `GITHUB_TOKEN` read-only by default, keep untrusted input out of scripts, vet third-party
actions — and this repository already had all four; a runtime agent on the runner is not among them,
and the fourth is an argument against one. Removing it is also the only way to test the hypothesis:
if the hang-ups stop, the correlation was real.

## 0.21.0 (2026-08-12)

**Three tests that were green on a pull request and red on `main` two minutes later.** A test file
installs a stub `window` on the GLOBAL and only restores it in `after()`, so for the whole length of
that file any other file's test that node:test happens to interleave sees it — and the stub carried
`open` alone, where `trace.ts`'s `destroy()` calls `window.removeEventListener`. The failure was
therefore a matter of scheduling, invisible locally and reproducible nowhere on demand: it took a CI
stack trace to name it. The stub now carries the whole four-member contract `src/client` actually
uses (`open`, `addEventListener`, `removeEventListener`, `location`), because the rule fixtures live
by — synthetic in content, faithful in SHAPE — is not suspended for a `window`.

**The network is a named capability now, and the linter is what names it.** seedeep's claim is that
session content does not leave the machine, and until now nothing checked it: a pull request adding
an outbound call would have passed every gate. The first attempt at a check was a bespoke test that
scanned the source for URLs — it was dropped, and the reason is worth keeping: run against the real
tree it reported **eighteen "hosts", of which one was real**, the rest being XML namespaces, doc
strings and fixtures, and it could not see the outbound call whose address comes from configuration.
Biome's own `noRestrictedGlobals` does the job properly, on the half of the codebase where it
matters (`src/server`, `src/core`), because the network here is an INJECTED dependency: the four
files that may name `fetch` are listed with the reason each is allowed — two hold the seam
(`update-check.ts`, `notify-webhook.ts`, each naming the global once as its own parameter's default)
and two dial seedeep's own server on loopback. A fifth entry in that list is the decision the rule
exists to make visible. It runs where the linter already runs, which is every push and every pull
request, blocking.

**CI records what it dials.** `step-security/harden-runner` in `audit` mode on the four jobs that
install, build or publish — never on the three that only call the GitHub API. It blocks nothing: a
dependency's install script can reach the network without appearing anywhere in this repository's
source, and a policy written before the real destinations are known is a gate that becomes noise.
On the tray's macOS and Windows runners audit is all StepSecurity supports, so there it could never
be more than a recording. **It reports the runner's egress to a third-party service** — CI
telemetry, never user data, but a project that advertises no outbound traffic should say so out
loud.

**Two documents were denying that the webhook exists.** The rule above found `notify-webhook.ts` in
its first run — a second outbound capability, opt-in and user-addressed, that no scan of URL
literals could ever see. `SECURITY.md` claimed the update check was the only outbound request, and
`docs/install.md` said the same at one line while describing the webhook correctly seventy lines
later, contradicting itself inside one file. Both now say **on its own** and point at the paragraph
that was already right.

**CodeQL now gates a merge.** `Analyze (actions)` and `Analyze (javascript-typescript)` joined the
two CI checks the `main` ruleset requires, so a pull request that introduces an alert cannot be
merged. Rust remains uncovered: default setup rejects it, and advanced setup would replace default
setup with a workflow that has to build the Tauri crate on a Linux runner — the thing `ci.yml`
already refuses to do, for a reason it states.

**The mark reaches GitHub.** It already existed — the eye is the browser favicon and the tray's app
icon — and was the one place the project looked anonymous: the card GitHub renders when the
repository is shared was its auto-generated default. `bun run social-card` draws the real one at
1280×640 (GitHub recommends exactly that, under 1 MB, and refuses more), reading the mark from
`public/favicon.svg` and the colours from the client's own stylesheets, so neither can drift from
the product it advertises. The bar along its foot is a context window filling, in the app's own
per-token colours. The README header carries the same mark, from the same file rather than a copy.
Uploading the card is manual: GitHub exposes no REST endpoint for the social preview.

**`main` is protected, and every change now arrives as a pull request.** Two rulesets: the default
branch refuses direct pushes, force-pushes and deletion, and needs both CI jobs green to merge; tags
matching `v*` cannot be deleted or moved. The tag rule is the one that did not exist a week ago — a
tag now anchors the release binaries' provenance attestation and the figure on the npm page, so
moving one would invalidate both silently. The maintainer goes through a pull request on the same
terms as anyone else, which is a deliberate choice rather than an oversight: it is what makes CI run
before a change is on `main` rather than after. `CONTRIBUTING.md` states the merge gate.

**The commit matcher no longer backtracks, and CodeQL is what found it.** `isGitCommit` tolerates
options between `git` and `commit`, and the group that did so let a run of flags be split into
groups of one or two in Fibonacci-many ways: a command that never reaches `commit` took **685ms at
40 flags**, and every four more multiplied that by three. Its input is the `command` field of a
transcript's Bash lines, which seedeep does not control. A flag's value may now not begin with `-`,
which makes the parse unique — and changes no verdict, since a `-`-leading token is read as the
next flag and still matches. The regression test asserts the rejection takes under 200ms where the
shipped regex took 676ms, a margin of four orders of magnitude, so it says nothing about how fast
the machine is. Found by CodeQL's default setup within a minute of enabling it (`js/redos`, high),
which is the argument for having enabled it.

**Every release asset is attested now.** The binaries are the project's main channel — download the
file and run it — and until now nothing tied one to the commit it came from: npm attaches provenance
to the packages by itself, the seven files on the release page had none. Both build jobs run
`actions/attest-build-provenance` on a tag, before the upload, so what is attested is what ships, and
`gh attestation verify <file> -R duqaXxX/seedeep` answers with the workflow and the commit. It does
not make the binaries signed — Gatekeeper asks a different question, and still warns — it makes them
attributable. The two jobs restate `contents: write` alongside the new `id-token`/`attestations`
permissions: a job-level block replaces the workflow's rather than adding to it, and dropping that
line would have cost the upload its permission.

**The npm page is a shop window again, now that the repository is public.** Its README carries the
hero figure, which had been impossible before: npm renders the file as GFM with no repository behind
it, so a relative path resolves against nothing, and an absolute one to a private repository is a
404 for everyone. It is served from GitHub by absolute URL, **pinned to the version's own tag** — a
page published once keeps showing what it showed, whatever `main` does to the file afterwards — so
the packager rewrites that README rather than copying it. `tests/npm-package.test.ts` holds both
halves of the contract: the file declares exactly the one token the packager substitutes, and every
figure in it is absolute and pinned. The wrapper's `description` drops the tagline it was repeating
two lines below itself and states what the tool reads instead, and its `keywords` are now the
repository's GitHub topics, the two lists being one project's two shop windows. Which terms those
are was measured rather than guessed: the package sits at **#16 of the 426 packages carrying
`context-window`** and past #50 of the 19160 carrying `claude-code`, so the list leads with the
narrow terms — a page short enough to be browsed to the end is the only one where being listed is
the same thing as being found.

## 0.20.0 (2026-08-12)

**`Use a different URL` now stays up.** The click was answered by setting the panel's own status to
`needsUrl`, which the next tick overwrote a second later with the stored server it was still
reporting — the field appeared and was gone, so a second server could not be typed in at all. It is
a view now, like the settings screen, and obeys the same rule against the clock: readings keep
arriving, only the redraw is withheld. It ends on closing the popover, or on the user being answered
— a URL that connects, a retry, a start; a refused URL keeps the field with the reason under it.
With it comes the first test that drives `panel.ts` itself (`tests/panel-tick.test.ts`): the module
talks to Rust at import time, so every rule of its had until now been tested on the renderers, which
cannot see a tick.

**The notification figure is a build output now, not a montage somebody assembled.**
`capture-demo.ts notif` runs the installed tray against a synthetic session inside its own
`SEEDEEP_HOME`, provokes the approval, the failure and the finish, films the screen and finds each
banner by subtracting an empty frame from a filmed one. The figure it replaces had been wrong since
before the release — two of its three bodies still ran to a second line, and one said `Finished`,
which no build has said for weeks. Two measurements came out of building it, both worth keeping:
**macOS draws no banner at all while a fullscreen app is frontmost** (the notification is delivered,
the tray's own probe returns `Ok(())`, and nothing appears), which is a fact about the product and
not only about the capture; and a banner's body differs from what is behind it by a step of three or
four against the lettering's hundred and eighty, so the edges have to be read at a threshold that
would be noise for text.

## 0.19.0 (2026-08-12)

**The session's two work counts moved into the summary bar.** `18 turns · 422 calls · 437 tools`,
beside the durations, at both scopes. The counts were already on the page — the API calls at the
bottom of the Session card under the token ledger, the tool total inside Main tools under four long
file paths — so nothing was missing and nothing needed expanding; they were simply in the tail of
two cards that answer other questions. The per-type breakdown stays in Main tools, where it has a
context.

**A turn that never called the model no longer announces a finish.** The report was a banner saying
only `Turn finished`, arriving long after the session had stopped: Esc pressed before the first
reply leaves NOTHING in the transcript — no marker, no `interruptedMessageId`, no assistant line —
so the turn was never marked interrupted, and the finish fired when liveness read from the process
finally said idle. Esc that Claude Code does record was already covered end to end. Measured over
533 real sessions: 24 turns of 2526 are the silent shape; the other zero-call turns are local slash
commands, which never make a session look busy in the first place.

**A notification is one title and one line.** The bodies carried a second line — the command
awaiting approval, Claude Code's error text, what the turn had done — and none of it belonged there:
you cannot act on a banner (approving still means going back to the terminal), a banner truncates
exactly that line first, and every one of them is one click away in the panel, untruncated. What
settled it is the webhook: it exists to reach a phone, it is the one channel whose payload LEAVES
the machine, and those second lines were shipping shell commands and error text to a third-party
service to say what the first line already said. Tray and webhook now carry identical text, so there
is one thing to reason about. The tool's NAME stays on an approval — `Waiting for your approval —
Bash` says whether something is about to run, which is how fast you get up; the command itself does
not.

**A stale process says so, on every surface and for as long as it is stale.** A server holds the
port, host and certificate name it started with; `config.json` can move underneath it, and until
now nothing said so — remote access was configured, the process kept answering on loopback, and the
diagnosis came from `lsof`. `GET /api/config` now carries `restart_pending`, and the portal shows an
amber dot on the Settings button with the panel closed, the panel explains it with the `Restart now`
button beside it, the tray prints a line above its sessions, and `seedeep status` prints one under
`serving`. The previous signal was the answer to a Save and lived only inside it: closing the drawer
lost it, and a file edited by hand never produced it at all.

**It compares what a restart would DO, not what the file says.** Configuration resolves through a
four-layer chain, and `POST /api/restart` respawns with the same argv — so a server started with
`--port 9000` goes on ignoring the file's port after every restart. Comparing against the file alone
would have lit a signal no button could clear. Both sides now run through one extracted function
(`applyPrecedence`, pure — no token, no write), recomputed per request so an editor's change is
never cached away.

**The settings panel is an editor of `config.json`, not a view of the process.** It showed the copy
the server was holding and wrote that copy back, so a file edited in an editor was invisible in the
fields and a save made for any other reason silently discarded the edit — measured: saving `open`
alone put `host` back. The fields now show what a start would resolve to (the file, under this
process's flags), and a save merges onto the file re-read at that moment, leaving every field it did
not mention alone. A value a CLI flag pins is still shown as the flag sets it — that is what runs,
and offering an edit to the file's number there would be offering one with no effect.

**Four data-loss paths found in review, all reproduced against a real server before being fixed.**
A `config.json` that could not be parsed was replaced by the built-in defaults plus a fresh token at
STARTUP — no request involved — and by `seedeep status`, a command that acts on nothing. A file that
had been DELETED under a running server was written back as `token: ""` with an empty webhook on the
next save. `Apply now`, pressed with the drawer already open, posted the form as it stood before the
edit and wrote the user's change away. And a hand-edited webhook URL raised a `save_pending` that no
button could ever clear, because the panel posts that field redacted. Reading the file now has three
outcomes rather than two — missing, unparseable, fine — and no writer takes the defaults for either
of the first two.

**A second state, for the changes a restart is the wrong cure for.** `save_pending` says
`config.json` carries notification settings this server has not taken up, with an **Apply now**
button — the panel has no Save button, so a state cured by saving needed an action of its own. The
token is deliberately not in it: the panel reads it redacted, so a save cannot carry one edited into
the file, and `restart_pending` covers it. Found by pressing the button, which left the state exactly
where it was.

**The panel says which fields a flag is holding.** `overrides` names each field a CLI flag or an
environment variable is overriding, and by which; the panel prints it under the field. The value
stays editable and still writes — it is the configuration for the day this server starts without the
flag — but an edit that silently snaps back on the next open now has its explanation on screen.

**`restart_required` is gone**, replaced by `restart_pending` on both `/api/config` verbs and
derived from that one comparison, taken after the write. A save that restores a running value
reports nothing; a save on top of an earlier hand edit keeps the signal up. One consequence: editing
`tls.cert` or `tls.key` no longer raises the signal — neither is reachable from the panel, and only
three fields are bound at startup.

## 0.18.0 (2026-08-11)

**Notifications are decided by the server, not by the tray.** The diffing between two readings —
the only part of notifying the tray still owned — moved into the server, which already held the
state and the wording. The tray subscribes to the event stream and shows what arrives; it composes
nothing. Two implementations of one rule were free to diverge, which is how a phone and a menu bar
end up disagreeing about the same session.

**The switches moved with it,** into `notifications` in `~/.seedeep/config.json`, and are now **per
channel**: the same event can be worth a banner where you are sitting and not worth a push
somewhere else, which one shared set cannot express. The tray's four keep their defaults exactly —
moving where a setting lives may not also change what it says.

**A notification webhook,** off until it has a URL. It POSTs the announcement to any address, with
your headers and your template (`{{title}}`, `{{body}}`, `{{project}}`, `{{subject}}`, `{{kind}}`),
so ntfy, Pushover, Telegram or a script of your own all work without seedeep knowing any of them.
It never retries and never throws: a broken address must not take down the banner that shares the
path. It is the one thing in seedeep that sends session data off the machine — see
`docs/install.md`.

**A finished turn now says `Turn finished`.** `Finished` claimed the session had ended; it had not —
the turn closed and the session became yours again. In the case where the turn left nothing on
record, that line is the whole notification.

## 0.17.0 (2026-08-10)

### A scene can build a repository, so three more cards have a figure (2026-08-11)

Commits, Cards and Changed files were the three surfaces with a reference of their own and no
picture beside it. Cards needed only a transcript; the other two could not be photographed at all,
because they do not read the session file for their content — they read GIT, and the capture had
never materialised a scene's working directory on disk.

A scene can now declare a `repo`: the commits it must contain, each with its files and its date.
The capture builds it at the scene's cwd before writing the transcript, hands the real short hashes
back through the `{{commit:N}}` tokens the transcript writes, and deletes it after the shot. The
identity and the dates are FIXED, which is what makes the hashes — printed inside the figure —
identical on every machine: verified byte for byte across two consecutive cuts.

The date is not decoration. Attribution proves a commit by "the call named its hash, and it was
authored after the previous call", so a fixture dated before the session is claimed by nobody and
the card photographs empty. That is what the first attempt did, and the test that now drives the
scene through `commitsForSession` — git included — is what caught it.

The new `shipping` scene ships two commits, a tracker card it moved and one it only read, and a
published page; its figures show a fictional tracker key and an artifact id that is plainly not a
real one. `The workspace` is the one section still without a figure, and it is listed as pending:
the tab strip is worth a picture only with several tabs in different states, which a capture that
opens one session cannot produce.

### The surfaces that are not cards get written down (2026-08-10)

An audit of `features.md` against `client/` found the tour complete for every widget that carries a
title, and thin or misfiled for everything else. Four things a reader sees on the same screen were
either absent or in the wrong chapter:

- **NOW had no section.** The panel between the Live activity header and the feed — the first thing
  the eye lands on during a turn — was named only inside "when a session is waiting for YOU", so its
  ordinary states had no home. It now has one: what each label means, what it says when the agent
  has left no words to quote, and why it never uses the word "waiting" for those.
- **The toasts had three passing mentions and no description.** Written down now: two rails split by
  what you do about them, five each, and the times they hold (1.5s a tool, 5s a spawn, 8s a
  verdict). The one exclusion — `Agent` — is named as the routing decision it is, since the spawn
  already has the richer toast on the other rail.
- **The workspace was filed under the engine.** The tab strip and the session picker are how you
  choose what you are looking at, not transport: they now open the tour as `## The workspace`, and
  the engine bullet keeps only what is actually engine (replay, one shared connection).
- **Four cards were never named the way their header names them.** `Context`, `Timeline`,
  `Skills used` and `Running · live` had zero literal occurrences, so a reader searching the doc for
  what was on screen found nothing. The content was there; the label now is too. `Running · live` —
  the live monitor when the session has background commands instead of subagents — was undescribed
  entirely.

No figures were added: the three cards with a reference of their own that still lack one (Changed
files, Commits, Cards) need a demo repository the capture harness does not create yet.

### Changed files carries the pages a session published (2026-08-10)

A prototype published with the `Artifact` tool was reachable in exactly one place: the drawer of
that one tool call, somewhere among the session's hundreds. Search does not reach it either — it
indexes prompts and assistant prose, not tool output, and measured over the local corpus 6 sessions
of 12 carry the URL ONLY in the result, with 2 pages of 12 named in no prose at all. Reopening an
old session, the link was effectively gone, while the page itself was not: 12 pages published, all
12 still reachable, the oldest 29 days.

The Changed-files card now carries a **`+N published artifacts` row** under the scratchpad one, and
the drawer lists each page as a link with a third KPI tile. Both secondary rows come from the
transcript, so a session outside a repository still shows them.

It counts **pages, not publishes** — a redeploy overwrites the page it names (20 of 33 local
publishes did, one page six times) — and a publish is recognised by its `file_path`: `action:
"list"` returns a result full of artifact URLs and must produce nothing. Hanging the URL on the
scratchpad file it came from was tried and rejected: only 11 of 33 publishes have that file in the
ledger, the rest being HTML a script wrote. See `docs/changed-files.md`.

One thing fixed on the way: with the answer in and the list empty, the drawer said `No files match
the filters.` with no filter set. It now names the state it is in — a page-only session made that
easy to reach.

### Both Expand-all lists are grouped by turn, and a tool call is numbered (2026-08-10)

The complete lists behind **Expand all** were flat, which stops working at the size real sessions
reach: measured on one, 4228 activities and 1849 tool calls in a single list. Both now arrive as
**collapsible per-turn groups** — a header saying which turn and how much is inside (calls and
total output for the tools list), with only the most recent turn open. A collapsed group builds no
rows at all, so the drawer's cost follows what is open rather than what the session did, and
typing in the filter opens every group that has a match. Scoped to a single turn there is nothing
to group by and the list stays flat, exactly where the old turn separators were suppressed.

Which groups are open is remembered from the first header you click, because opening a row REBUILDS
the drawer: taking the default again would have closed the group you had just opened, and on a
session with 78 of them that means finding it by hand. Until that first click there is nothing to
remember, so the default keeps being recomputed — the newest turn stays the open one as the session
grows, and opening the list while scoped to a turn (where no groups are drawn at all) cannot record
a choice nobody made. A group force-opened by the filter is not remembered either: collapsing it is
about the filtered list, not the one underneath.

Verified live — open, drill in, back by the crumb, still open — and each of the five rules has a
test that flips red when its rule is removed.

The tools list gained the `#N` the activity list already had: a dense number fixed in the order the
calls were made, so it stays put when the ranking is re-sorted by size or by time. It is
deliberately not the activity list's number, which counts API calls and spawns too — a ranking
reads better numbered 1..N.

### A note reaches the complete history, not just the feed (2026-08-10)

The feed keeps thirteen rows per turn, so a security review's findings — a row nobody can anchor to
a call — were gone after ten more activities, and invisible to anyone opening the session later.
They now also appear in **Expand all**, the turn's complete history and the only list with no cap,
folded in by timestamp so the note lands right after the call that provoked it rather than at the
end beside unrelated work. It is the one row there that is not a call: named in amber, no duration,
and a click opens the full text.

The same list was also the last surface still showing a warned call as an ordinary one — the ⚑ the
Trace block carries now travels with the row. The maintainer chose the destination from a prototype: the
three candidate surfaces, photographed on the real UI, with the proposed row injected into the real
list so the choice was made by looking rather than by reading a description.

### What ends a Monitor is its TaskStop, and a running command says how long it has been running (2026-08-10)

Marking a `Monitor` as a background command put it in front of the liveness probe, and the probe
answers one question: does any process still hold this command's output file open? A background
`Bash` holds it through the whole chain, which is what the mechanism was measured on. **A monitor
does not** — measured on one that was demonstrably alive, its `sleep` in the process table and its
output file already written: nothing held it. So a working monitor was reported gone two probes
after its first event. Monitors are no longer asked.

Which left the opposite hole: a monitor that IS stopped never says so. Claude Code writes no
`<task-notification>` for a stop (0 of the 49 lines naming two stopped monitors carries a
`<status>`), so the row went on calling itself running for the rest of the session — which is what
the maintainer saw. The end it does write is the `TaskStop` receipt, *"Successfully stopped task: …"*,
naming the task rather than the call. That sentence now closes the row, with `stopped` as its
status: Claude Code's own word, which every surface already reads as a clean end.

Two more things the same report caught. A command still RUNNING showed `—` where its duration
would go, while the live row above it had been showing its age all along — one command described
two ways on one screen; the catalogue now ticks the same age. And the note gate was wrong in a way
its own test could not see: every one of the 555 SessionStart injections carries
`toolUseID: "SessionStart"`, so an id-only gate emitted a 2 KB note per session about a call that
does not exist. The gate is now the hook's EVENT, and the fixture that "proved" otherwise — written
from belief, with the field omitted — was replaced with the shape real lines have.

### A hook's warning reaches the call it is about, and a scheduled wakeup is a visible wait (2026-08-10)

Two more things the parser used to drop, found by auditing everything it dropped besides `Monitor`.

**A hook's note.** Claude Code writes an `attachment` line when a hook has text to say — a security
plugin objecting to what was just written to a file, most often. seedeep dropped every `attachment`
wholesale, because nearly all of them are the bookkeeping each tool produces twice per call. What
separates a note from that noise is the `toolUseID` it carries, and the difference is not academic:
65 real warnings in 39 sessions (7.3% of the corpus) passed through and left no mark anywhere. A
note now marks the call it names — a ⚑ on its Trace block, a chip and the verbatim text in its
drawer — and a note that names no call (the background security review, which runs with no tool
call of its own) goes into the activity feed, where it can be seen without being pinned on whichever
call happened to be open. Amber, never red: a call somebody warned about is not a call that failed.

Deliberately not modelled as "a security finding". What the transcript records is that something
had text to say and the writer names itself in it; a type keyed on one plugin's name would go blind
the day another one speaks.

**A scheduled wakeup.** A self-paced `/loop` arranges to wake the session later, and the receipt
(`scheduledFor`) was another shape the parser did not know. It now shows as its own row in the band
that answers "what is this session still waiting on" — amber rather than green, because nothing is
running. The row disappears once its instant passes and never says the wakeup fired: measured over
the corpus, a wakeup that goes off produces no line of its own, so claiming otherwise would be an
invention, and a countdown running negative would claim a wait that is over.

### A Monitor is a background command, and its events are counted (2026-08-10)

A `Monitor` — Claude Code's watcher on a log or a CI run — was invisible: a 0.1s tool row and
nothing else. Not in the catalogue of background commands, not in the chip that says the session is
still waiting on something, not in the tray, while the console counted it in the status line. Two
gates in the parser, each looking for a name the tool does not use. The receipt names its task
`taskId` where a background `Bash` names it `backgroundTaskId`, so the launch was never marked; and
the notifications carrying what the monitor SAW have no `<tool-use-id>` and no `<status>`, so all 74
of them in one measured session produced nothing at all. Even its end was thrown away: recent Claude
Code writes a proper terminal notification (`Monitor "…" stream ended`), which the parser read and
the reducer then dropped, because the row it named had never been marked as having launched
anything.

A monitor now enters every surface a background command already reaches, and its **events are
counted on its own row** — the count beside `still running`, the latest event on the line below.
Only the latest, and none of them in the activity feed: a stream that forwards 74 events would
leave a 13-row feed holding nothing else. The gate that recognises the launch is `taskId` **and**
`timeoutMs`, never `taskId` alone — a `TaskUpdate` receipt carries a todo's `taskId` (218 locally)
and a `Workflow`'s carries a run's, and both would otherwise be listed as running commands.

The same audit checked everything else the parser drops. Two more real cases are filed and
deliberately not fixed here — the background security review, whose notification carries no ids at
all, and `ScheduleWakeup`, which is a commitment rather than a process. Three suspected losses were
measured and refuted: a subagent resumed through `SendMessage` is already resolved by task id, and
the 11 async agent notifications written *before* their launch all close correctly once the child
transcripts are replayed, as the watcher does.

### The broken tray icon is a cross, not waiting's eye in red (2026-08-10)

*Broken* had been *Needs you*'s geometry in a different colour since the state shipped — the one pair
in the menu bar a user had to tell apart by hue, on the state that matters most, and red-against-amber
is the pair a red-green deficiency handles worst. Every other state already differed by shape. It now
carries **a cross where the iris goes**. Four marks were drawn by the real renderer and looked at at
18 pt before this one was picked: a broken rim and a fractured iris both read as a rendering fault
rather than as information, and an exclamation — the most legible of the four — lost on meaning
rather than on render, because *!* says *look at me*, which is what the amber already says. The eye's
height, the outline and the badge rule are untouched. The test that used to assert the two states
shared a geometry now asserts they do not: it compares alpha only, so the colour cannot satisfy it,
and it demands the difference be a large fraction of the ink rather than merely non-zero.

## 0.16.0 (2026-08-10)

### A version check you typed asks npm, not the cache (2026-08-10)

`seedeep update` and `seedeep self-update` now force the registry check instead of reading the
hour-old cache. The cache is right for the surfaces that poll — the portal, the tray, the notice
after `open` — and wrong for a human who typed the command, because the reason to type it is usually
having just heard about a release. Measured the day it was written: 0.15.0 was published at 23:20Z,
the cache had answered `0.14.0` at 22:47Z, and `self-update` told its user they were current from a
reading taken before the release existed. `--offline` still wins over the force, and the fresh
answer replaces the cache, so nothing else on the machine re-asks after it.

## 0.15.0 (2026-08-10)

### The tray can open the portal itself, not only a session (2026-08-10)

Until now the only way from the tray into seedeep web was clicking a session row, so with nothing
running there was no way in at all. The portal's home is now one click away from two places, both
calling one new Rust command (`open_portal`, `Conn::portal_url(None)`): the footer's address, on
every connected screen, and a button in the empty state. The footer carries it so the way in does
not disappear the moment a session starts — the address was already on that line, inert, naming the
thing a click opens. A new test also pins the seam nothing was checking: every `invoke('…')` the
webview makes is a command `main.rs` registers, so a mistyped name fails the suite instead of
failing silently in the built app.

### The failure switch says *fails*, not *breaks* (2026-08-10)

The tray's second notification switch is now *A session fails*. It has always meant one thing — the
last model call failed — but on its own in a list of four, *a session breaks* reads just as easily
as a session taking a break, and it was misread that way in review as "a notification for when the
user stops a session". The prose that used to spell it out under each switch was dropped on
2026-08-05 to fit the 392×560 panel, which is what left the label carrying the whole meaning. The
*Broken* band keeps its name: it sits beside a red icon and names a state, not a preference.

## 0.14.0 (2026-08-10)

### A release is not a reason to re-cut a figure (2026-08-10)

Two docs said a release re-cuts every figure, since the Settings figures print the version. They now
say the opposite, which was the rule all along: a figure documents the surface it photographs, not
the version that was running, so a stale number in it makes nothing it claims false. Only a change
to what a figure SHOWS invalidates it — and `bun run doc-shots --ids <shot>` cuts one rather than all
twenty.

### A bun install is recognised by bun's layout, not by the prefix's name (2026-08-09)

The channel was read by looking for `.bun/` in the path of the running executable, so a global
install under a custom `BUN_INSTALL` fell through to npm and was handed npm's command. That was a
wrong sentence on screen until `self-update` made it the command seedeep RUNS — on a machine with
both managers, npm would install a second copy at its own prefix and which `seedeep` answers
afterwards would depend on PATH order.

Measured on bun 1.3.13, against the default prefix and a custom one: `bun install -g` writes to
`<prefix>/install/global/node_modules/<pkg>`. The layout is bun's and the prefix's name is the
user's, so the layout is what the test matches now (`.bun/` stays as a fallback for older
installs). npm cannot produce that segment — its own layout puts `lib/` in between. Asking bun for
its global root would have settled it too, at the price of a subprocess and of deciding the channel
on whether an unrelated tool happens to be on PATH; reading the path keeps the answer pure.

pnpm and yarn still read as npm, and Windows' bun layout is assumed rather than measured — both are
stated at the `// LIMIT:` on `detectChannel`.

### The three things the docs never said (2026-08-09)

An audit of the public docs against the code found three surfaces the reader had no way to reach,
and each is now written down where a reader would look for it.

- **The commands had no list.** `install.md` explained `report`, `update` and `self-update` in
  prose, mentioned four more in passing, and named `seedeep status` nowhere at all — the only
  complete account of the CLI was `--help`, which you have to already be running the program to
  read. `install.md` now carries the same two tables (`## The commands`), `status` has the paragraph
  its own subcommand deserves, and the `/seedeep` table gained the row it was missing. A test reads
  the section and asserts it against `SUBCOMMANDS`, in both directions: a subcommand the parser
  accepts and the docs omit fails, and so does a table row for a word the parser would reject.
- **The share card was undocumented.** `⇪ Share` renders a turn's verdict as a PNG in the page
  itself, and no doc mentioned it existed. `features.md` now shows the card, what it carries, and
  the reason it is safe to post: nothing in it can name your work, which the card states along its
  own foot.
- **Only half the settings panel had ever been photographed.** The figure showed the loopback
  posture and its caption pointed at a TLS block no figure contained. A shot can now declare the
  `server` posture it is photographed in — naming a host binds the capture's own throwaway server
  beyond loopback, which is the only way to picture a certificate and a fingerprint that come from
  the running process rather than from the form. The common name is synthetic and asserted to be,
  since it is what the panel prints in its access URL.

### `seedeep self-update` — the update runs where you asked for it (2026-08-09)

`seedeep update` printed a command and stopped, so updating meant leaving the session for a terminal.
The reason it stopped was sound but narrower than it looked: it argued against installing inside the
`/seedeep` slash command's `` !`…` `` block, which is **preprocessing** — it blocks the turn and pastes
its whole output into the session. It said nothing about a Bash call the agent makes normally, where
the output is a tool result and the progress is visible.

So the install becomes a seedeep verb rather than a package-manager command typed by an agent:
`seedeep self-update` runs the channel's own command, **checks that the executable on disk really
changed**, and only then restarts the running server. That check is the point — under bun an install
without `--trust` is blocked from placing the binary *and still exits 0*, so the exit code cannot be
the evidence. A failed install leaves the running server untouched, and no server is started where
none was running.

It refuses where a package manager is not the answer, each with the sentence that resolves it: a
downloaded executable, a checkout, Windows (a running `.exe` cannot be replaced — no detached helper
is written, so the platform is out of scope), and a version *ahead* of npm's, where "update" would
mean downgrading a build of your own.

`/seedeep self-update` is a word of its own, never a mode of `/seedeep update`: one says how, the
other does it, and a reporting command that installs because the moment looked right is not a report.
The slash command's preprocessing prints only what *would* happen, and the single command Claude then
runs is already covered by the command file's `Bash(seedeep:*)` — the package manager is never
invoked by the agent directly.

### A background command has three authors, and now the rows say which (2026-08-09)

Claude Code started writing `toolUseResult.backgroundedByUser`, and the radar reported it as a field
seedeep had never seen. Measured over the **221 background receipts** in 515 local sessions, it turns
out to name the missing third of a story seedeep already tells: a command reaches the background
because the **model** asked (`run_in_background` in the launch input, 194), because **the call's own
timeout** promoted it (`timedOutAfterMs`, 22 — and it is the CALL's timeout, 45s–600s locally,
matching what the model asked for, not the fixed 120s it is easy to assume), or because the **user**
pressed Ctrl+B (this field, 1).
The three signals are mutually exclusive — never two on one receipt — and only the last has no other
marker of its own, so inferring it from the absence of the other two mislabels every receipt written
before `timedOutAfterMs` existed (CC 2.1.211): a timeout then reads as a model choice.

So the receipt now derives `background.by` — from the receipt ALONE, since the launch input lives on
another line — and the three surfaces that draw a background command say who when it was not the
agent: the live row's chip, the same chip on the catalogue row it becomes, and the drawer both open
into. The agent's branch stays bare, which is what those rows already meant, and it is also the
fallback for a receipt too old to carry either marker — the worst case is a missing chip, never a
wrong one. Verified against the one real Ctrl+B receipt in the local corpus: 15 rows on screen,
exactly one labelled, and it is the command whose receipt carries the field.

A field with one sighting is exactly what the probe is for. New **scene 14** launches a command in
the foreground and takes it away with Ctrl+B, and claim **C27** requires the receipt to say so.
Its `provoked` reads the SHAPE, never the field under test: a foreground command that comes back with
a `backgroundTaskId` and no `timedOutAfterMs` — impossible for a 47s command anyway — can only have
been backgrounded by the keystroke the probe pressed. The scene runs after scene 13 on purpose,
since a `status: "shell"` it caused would otherwise satisfy scene 13's claim in place of that claim's
own command.

### Re-cutting a figure is a judgement, not an automatism (2026-08-09)

`doc-shots:check` said "may be stale" about figures that were fine. The map is per-FILE, and
`client/graph.ts` draws every widget there is, so a three-line change to the NOW panel named **15
figures of 20** — and re-cutting all of them produced **18 byte-identical files**. A warning that is
wrong nine times in ten is one you learn to scroll past, which is worse than no warning: it spends
minutes of browser runs to say nothing.

So the check names **candidates, not verdicts**, and says so. Whether a figure went false is the
author's call — did what it *shows* change? — and `bun run doc-shots` re-cuts it. The pre-push hook
no longer runs `--verify`: the pixel comparison is still the only true verdict, and it still exists,
but it costs minutes and belongs to a **release**, which re-cuts everything anyway — the Settings
figure prints the version, and it is the only figure that does.

### An answer made only of code showed as `""` (2026-08-09)

The NOW panel drew two quote marks around nothing. `stripMarkdown` replaced a fenced block with a
space — every other rule in that function removes the MARKERS and keeps the text, and this one
alone threw the block away — so an answer whose every character lives inside one fence stripped to
the empty string, and the panel's decorative `“`/`”` were the only thing left on screen.

Measured across 515 sessions and 11,362 assistant text blocks: 2 strip to nothing, and both are
answers made of a single fence. The raw rate says "rare" and is misleading — the `/seedeep` command
file asks for `status` and `report` to be pasted **as they are, already formatted**, which is one
fenced block. seedeep was blinding itself on its own command, reproducibly, and the shape it hid is
exactly the one a user pastes because it matters.

A fence now keeps its content (its info string, ```` ```ts ````, is a marker and still goes).
Length was never this function's problem: the panel clamps to two lines and `more` opens the real
markdown, rendered. The other two callers gain the same way — the digest's NOW line, which is what
the tray reads, and a Trace span's detail.

**Code is quoted verbatim, and that is the whole design**: the text is split on its fences first,
and only what lies OUTSIDE one goes through the marker rules. Running code through them (the first
attempt at this fix, caught in review) makes the glance lie — a `diff` block came out as
`const a = 1; + const b = 2;`, the `-` of the deleted line gone and the `+` of the added one kept,
so a removed line read as a present one; `**kwargs` was unwrapped as bold; a shell `# comment` lost
its hash. Two more consequences of splitting first: ```` ```x``` ```` on a single line is a code
span, not a fence, and unwraps to `x` instead of stripping to nothing; and an unclosed fence runs to
the end of the text, as CommonMark says. That last one also removed a quadratic scan — 100KB on one
unclosed line took 2.3 seconds, re-entered every second by the panel's own ticker, and now takes
0.4ms.

The stylesheet already had `.nowtext.empty`, which drops the quote marks when there is nothing to
quote. No code ever added that class; it does now, for what markers-only markdown still leaves
behind (an empty fence, a lone bullet) — and the panel then says `(no text)`, **the Trace's own
words for the same nothing**, rather than showing an empty box. The Trace reached that state by a
second route and drew a blank line: it tested the raw detail for emptiness, and markers-only
markdown is a detail that is not empty but leaves nothing to show. It now tests what it is about to
draw.

The unit test that covered fences asserted `'```\ncode\n```after'` → `'after'` — with prose after
the fence, so the case where nothing remains could never fail it.

## 0.13.0 (2026-08-09)

### A figure is the same picture every time it is cut (2026-08-09)

The pixel comparison behind `doc-shots:check --verify` promises an exact answer, and four figures
could never give one: two cuts of unchanged code differed, so the gate reported a change nobody had
made — the noise it exists to remove. Three sources, all in the capture, none in the product:

- **The scheduler's jitter was inside every duration.** A replayed line was stamped with the instant
  it was written, so an API call's latency and a subagent's runtime came out a few milliseconds
  different each run. Lines now carry the session's own interval, moved to the anchor — which makes
  the durations stable *and* exact.
- **The wall clock was inside two figures.** The subagent cards print an absolute launch time, so a
  session pinned to "now" put the hour of the run into the PNG. Stills are pinned to a constant
  instant instead; liveness comes from the open-session record, which still carries the real pid and
  the real clock, so the surfaces still read as working.
- **A screenshot caught whatever phase an animation was in** — the pulsing LIVE dot moves a handful
  of pixels nobody can see and every byte comparison can. Crops are taken with animations frozen at
  their first frame, which is also the more honest picture: the state, not a moment of it.

Verified by cutting twice and comparing: byte-identical, where the same two figures had never once
matched. No figure was marked `volatile` to get there — that would have changed the wording of the
warning, not removed it.

### The figures were photographing subagents the session never had (2026-08-09)

The demo bundle every recorded figure is cut from had been deleted by the OS, and re-making it
surfaced three faults that had been shipping quietly in the pictures themselves.

**A replayed subagent was an orphan.** The replay streams `.jsonl` and nothing else, but the file
that links a child transcript to the `Agent` tool_use that spawned it is a `.meta.json` beside it.
Without it the Trace read `3 subagents · no child data yet`, their tool calls counted 0, and
`Expand all` had nothing to indent — every figure of a fan-out showed a state the recorded session
never had. The meta is now placed just before its child's first line, scrubbed and leak-checked
like every replayed line.

**The stills replayed 20× too fast, so every duration on screen was 20× too small.** Each line's
timestamp is rewritten to the moment it is written, so compressing the pace compresses the
intervals: one `Agent` span read `1.0s` in the activity list and `26s` in the subagent drawer, two
figures of one session disagreeing by a factor of 26. Stills now replay at real time; the GIFs keep
their own pace, because nobody watches four minutes of a window filling.

**A `waitFor` that never came true passed in silence.** It is the field that states what a figure
must contain, and its failure was caught and discarded — four of the twenty were waiting on states
that never happened, including a live monitor that only ever looked live because the replay could
not tell the subagents had finished. An unmet `waitFor` now fails the run.

Two sections of `docs/features.md` gained the figure they were missing — the settings panel and
`Expand all` — and no section is now without one except *The engine underneath*, which has no
surface to crop. A shot can declare its own `viewportHeight`: a drawer is `height: 100%`, so the
settings panel was cropped with 45% of the figure empty under its last row.

The verdict rule behind `doc-shots:check --verify` moved next to the staleness rule it belongs
with, and is tested: `SAME` / `DIFFERS` / `UNCUT` / `VOLATILE`, and a group that cannot be re-cut no
longer takes the other groups down with it.

### The brand says which version is answering (2026-08-09)

The portal now prints the running server's version beside the wordmark, on every install:
`seedeep 0.12.0`, and `seedeep 0.12.0 dev` on a checkout — the development chip is unchanged and
still says nothing on a release. It was readable only by opening the settings panel, which is a
step nobody takes before quoting a version in a bug report.

It comes from `GET /api/config`, the same single request at load that the development chip already
used, so the header costs no extra round trip. **Never from a constant compiled into the bundle**:
`public/lib/` is a build artifact, and a stale `build:client` would print a number nothing is
running. A server too old to report a version draws nothing rather than a dash — this is the one
value a guess is worse than a silence about.

### The figure gate compares pictures, and the bundle it needs leaves `/tmp` (2026-08-09)

Two problems with the same root: the mechanism that keeps the documentation's figures honest was
warning when nothing was wrong, and could not do anything about it when something was.

**The warning was noise.** Every figure declares `client/graph.ts` among its sources, so ANY edit
to that file named all fourteen — measured on a change that could only have altered one of them. A
warning that fires when nothing is wrong is one you learn to scroll past, which is the same as not
having it. `doc-shots:check --verify` — what the pre-push hook runs now — **re-cuts the suspects
into a temp directory and compares the pixels**, and reports only three things: the picture
CHANGED, it could not be re-cut, or it carries something that moves on its own. On the change that
prompted this: 14 named, 5 re-cut byte-identical, 0 actually different.

The comparison is exact, with no tolerance. A figure that cannot be compared exactly is marked
`volatile` in the manifest — only `broken-session.png` is, because the NOW panel prints an age
against the clock and two cuts of the same code differ (`4444m ago` became `4775m ago`). A
threshold wide enough to absorb a ticking number is wide enough to hide a changed label.

**The bundle the recorded figures need lived in `/tmp`, and the OS deleted it.** That is how eight
of those fourteen became unverifiable and un-re-cuttable: the documented "free, no model calls"
re-cut needs a bundle whose only copy was somewhere the system is entitled to empty. It now lives
in `~/.seedeep/demo` — the real home, never `SEEDEEP_HOME`, which a dev run points inside the
repository, and a directory of recorded transcripts does not belong in a git tree even when it is
ignored.

Two bugs found by running it rather than reading it: an absolute temp path joined onto the cwd
wrote a directory of PNGs INTO the repository, and one missing bundle made the verifier give up on
the scene figures too — the same mistake `--only` was added to fix.

### A background command's duration was the queue's, not the command's (2026-08-09)

A `sleep 3` was shown as having run **22.6 s**. Claude Code writes a terminal notification TWICE —
`enqueue`, then `remove` when the queue is drained — and the reducer is last-wins, so the end
instant it kept was the DRAIN's. The repeat was believed inert because the payloads are identical;
the payloads are, the line timestamps are not.

Measured over every local transcript: **281 of 611 notifications are written more than once**, and
the spread between the first and the last copy is p50 **3.9 s**, p90 **30.9 s**, max **76 minutes**.
Every background command that got two copies has been showing an inflated duration — on the
catalogue row, in its drawer, and in the Trace. The end instant is now the FIRST time anything said
so; the status and the sentence stay last-wins, where a repeat is genuinely inert.

Two other things went with it, both from a review of the liveness probe:

- **What says a command ended is the `<status>`, never the sentence.** They travel together today
  (0 of 870 status notifications carry no summary), but a status with no summary would have left a
  cleanly finished command reading `running` — and then `unknown` once the probe answered, which is
  a command reported as never reported.
- **`lsof` failing is not an answer.** It exits 1 both when nobody holds a file — a real answer —
  and when the invocation is rejected; only stderr tells them apart (measured: 0 bytes against 573).
  Reading the failure as an answer marked every background command of every watched session as
  vanished, at once and in silence. Also fixed: the probe rounds can no longer overlap, a round that
  throws no longer takes the process down with it, and a session re-seeding no longer loses the
  verdicts already reached for it.

### A background command whose end is never written stops counting for ever (2026-08-08)

Seen live: the cockpit showed **2 commands running**, one for 40m 8s and one for 34m 29s, while
nothing of either was alive on the machine. Not a parsing bug — the terminal signal simply never
came. Measured across the whole local corpus: **23 of 198 background launches (11.6%), in 11
sessions**, never get a `<task-notification>` at all, and `background && !outcome` then means
"still running" for as long as the session stays open. The number sits on the busiest surface in
the product, and the kind of wrong it is erodes everything beside it: if *2 commands* is wrong,
nothing gives the reader a reason to believe *0 subagents*.

Nothing in the transcript will ever close those rows, so seedeep asks the machine — **does any
process still hold this command's output file open?** One `lsof` on a 15 s clock answers every
pending command at once (33–35 ms with 691 processes), for the sessions a tree is already held
for. Two sources were measured and refuted first: Claude Code keeps no registry of its background
shells on disk, and the output file's mtime or size says nothing at all — four healthy
`until … sleep 20` waiters had written 0 bytes after tens of minutes ALIVE, so a rule keyed on the
bytes would have declared all four dead within seconds. Matching `ps` on the command TEXT fails
too: the harness re-quotes what it runs, so the string seedeep holds is not the string `ps` prints.

**The verdict is `unknown` and can never be anything else** — the probe learns that something
stopped, never what it stopped with. The row keeps its place in the catalogue with its duration as
a bound (`≥ 4m 20s`, the last instant it was seen alive), the cockpit counts it (`1 never reported
below`) and never draws it, and the tray simply stops listing it as running. Everything about it
fails towards saying nothing: two consecutive empty probes before a row tips, and NO verdict when
the file cannot be found, has been deleted, or `lsof` is absent — which leaves every row exactly
as it was before.

Two bugs the tests caught while it was being built, both in the fatal direction (calling a LIVE
command dead): `lsof` prints the REAL path, so a file under `/tmp` came back as `/private/tmp` and
matched nothing; and a deleted output file — the scratch root is under `/tmp`, which the OS
cleans — read as "held by nobody" instead of as unanswerable.

### A running command's dot stops borrowing the colour of *Needs you* (2026-08-08)

The tray drew a background command's dot in **amber**, on the reasoning that the session is
*waiting on* the command rather than working on it. The reasoning was fine and the colour was not:
amber is spent on ***Needs you*** in three other places — the band heading, the blocked row's left
border, `Waiting for your approval` — so one hue meant both *something is running* and *you are
blocked*, in the same panel, on a surface read at the edge of vision.

The dot is now the **accent**, which in this panel means exactly one thing: at work. The Working
row's own left border is accent, so is the agent's `◇`, so is the context bar. What tells a command
from an agent is the SHAPE, `●` against `◇` — the job that mark already had.

Matching the portal's green instead was considered and rejected: green would be a fourth hue on one
dot inside an otherwise accent-marked panel, and making the tray consistent around it would mean
repainting the Working border and the context bar too — a whole-panel restyle to chase another
surface's palette.

### The tray counts the commands a session ran, and draws only the live ones (2026-08-08)

The tray kept the last three failed commands as rows, the deliberate asymmetry recorded in the entry
below: its band is the whole surface, with no catalogue to point at. Using it settled the question
the other way. **A command that has ended gets no line at all — it gets counted**, `Commands 4
launched`, in the same shape and the same two bands as the subagent total that was already there.

Two things decided it, both visible on the running panel. The tray had a **second rule for
commands** where it already had one for subagents — and the subagent rule's own words are the answer
here: *what each one was, what it cost and how long it took is the portal's, one click away on the
row*. And a failed command was a line important enough to draw while **the icon never left
*Working*** for it: a surface disagreeing with itself about whether the thing matters. If a failure
should ever reach the user without the portal, the place for it is the icon state or a notification,
not a row in the band.

The count is what keeps the silence honest: without it a session that ran four commands and was told
about all four would say nothing about any of them, which is the disappearance this whole finding
started from. `/api/digest` now sends the running commands and `backgroundLaunched`, and no longer
sends `state` or `ranMs` — the tray drops an ended command an older server still sends rather than
drawing it, because drawn it would wear the amber dot and tick a stopwatch on something dead.

### The live card lists only what is live (2026-08-08)

The background-command catalogue shipped with the last three failures riding along on the cockpit,
so a failure would be stated where you are already looking. Seen on a real session it was plainly
wrong: with every command ended, the card read **`BACKGROUND COMMANDS · LIVE`** over two corpses —
the same kind of lie as the disappearance the feature exists to fix.

A failed command is now **counted there and never drawn**: the card's line reads `2 commands failed
below`, exactly as it already points at a subagent that has finished, and the title never leaves
`Running · live` / `Subagents · live`. The failure still cannot vanish in silence — that was the
whole point — but it is stated in the catalogue, which is where the truth about ended things lives.

The tray is deliberately not the same: its band is the whole surface, with no catalogue to point at,
so the last three failed commands stay as rows there. The cap is on the rows a poll carries, never
on the count a browser shows.

### A refused token stops being reported as a lost connection (2026-08-08)

Opening a `seedeep` on a second port over the LAN showed `Live feed lost — reconnecting…`, for ever.
Nothing was lost and nothing would reconnect: the browser had no token for that ADDRESS — local
storage is partitioned by origin and the port is part of it — so every `/api/*` answered 401 while
the page kept promising a recovery that could not come.

The verdict now lives where it can actually be learned. An `EventSource` error carries no status, so
the stream itself can never tell a 401 from a dropped connection; `authFetch`, which every API call
passes through, can. It records `missing` (nothing stored for this address) or `refused` (stored and
not accepted) and clears itself on the next successful call, so fixing the token in the settings
panel heals the banner with nothing to reset by hand. A 200 from `GET /api/config` clears nothing —
it is the one endpoint served without a token, so it proves nothing about ours — and a network
failure clears nothing either: an unreachable server says nothing about the token, and reporting one
as the other is the confusion being undone.

The pill is red and does not pulse, unlike the amber one beside it: a refused token is settled, not
in progress. It names the cause in the header and carries the instructions in its tooltip, which is
where there is room for them.


### Background commands get the catalogue subagents always had — and a failure stops vanishing (2026-08-08)

A session launches shell commands into the background as readily as it launches subagents, and they
had no catalogue: only a list of the ones still RUNNING. Acquiring an outcome removed a command
from the one list there was, so a command that **failed** disappeared from every count the moment
it failed — measured on a real session, 7 failures, all seven invisible on the cockpit, the header
chip, the digest and the tray. Only the Trace was right, because its span store never evicts.

The bottom card now holds two catalogues behind two tabs: the subagents grid, and every background
command in launch order with its fate. The tab bar exists **only when both lists have something in
them** — a switch with an empty side is a control that does nothing, and that is ~87% of sessions —
and the default tab never moves off Subagents. What makes hiding one list safe is the label: the
closed tab carries its count AND its failures, so the design cannot hide the thing it was built to
reveal. One card rather than two stacked, because at real scale the second is unreachable: the
sessions carrying both have a p90 of 27 spawns (max 67), which puts a second card 1716px — 1.6
screens — below the fold.

A command's row states what Claude Code called it, its state, its turn, its exit code and **how
long the command itself ran** (launch → the notification that ended it, which for a killed build
can be hours) — never the launch call's milliseconds. Its drawer adds the full command, Claude
Code's own sentence, and the **output file**: the transcript names it in the notification, and
seedeep simply was not reading that field. The cockpit keeps the running commands and now also the
last few failures, drawn in the neutral ended shape — a dead command in the running colour is the
same lie as removing its row.

Three facts the reducer never carried are behind all of it: the notification's raw `<status>` (so
nothing has to classify a fate by parsing English), its timestamp (the command's real duration) and
its `<output-file>`. The launch's own `description` is read too — for a background command it is
the only human-readable name it ever gets, and it is what Claude Code quotes back when it ends.

**The tray was losing the same failures**, and for the same reason: the digest's `background` array
held only the running commands, so one that failed left it the instant it failed and the list just
got shorter. It now carries the running ones plus the last three failures, each with its `state` and
how long it ran — the same rule as the browser's cockpit, from the same derivation. On the row a
failed command goes red and dimmed, and the age on its right is how long it RAN, never a stopwatch
still counting on something that is dead. A command that finished cleanly is still never sent: it is
not news, and the poll is a signal, not a log.


### A security policy, so a finding arrives privately rather than as a public issue (2026-08-08)

The repository had no disclosure channel: no `SECURITY.md`, and nothing telling a reporter that an
issue is the wrong place. On a private repository that costs nothing — nobody can report anything —
but the moment it is public the absence decides between a private advisory and a public issue
carrying a live vulnerability.

`SECURITY.md` now names the private advisory form as the only channel, states what a reporter can
expect (one maintainer, no SLA, no bounty, latest release only), and — the part a template would
have missed — says what the interesting surface actually is: the server beyond loopback, the
certificate and the tray's leaf pinning, the tag-to-npm release pipeline, and session content
leaving the machine. It also says what is *not* one, so a crash on an unexpected session line or the
unsigned first-launch warning goes to the issue tracker instead. The README's Docs table points at
it in one line.

The other half of the channel — GitHub's private vulnerability reporting toggle, which puts the
"Report a vulnerability" button on the Security tab — exists only on a public repository and is
turned on at the flip.

### A figure for every surface, and synthetic transcripts for the states that cannot be provoked (2026-08-07)

Nine figures covered the surfaces the recorded session happens to exercise. The rest of
`docs/features.md` — the Verdict lens, the timeline, a broken session, a failed tool, Home, Compare,
Search — had none, and no recording could produce them: **an API call does not fail because a script
asked it to**, Claude Code refuses to compact a small session, and a retrospective is about a corpus
rather than a session.

So those states are now written rather than provoked. `apps/server/scripts/doc-scenes.ts` builds
three transcripts — `busy-day` (eight things sent, of five kinds, two of them wasteful), `broken` (a
session whose last call failed), `corpus` (five finished sessions on three models sharing one phrase)
— **synthetic in content and faithful in SHAPE**, the same rule the fixtures follow. Every field is
one the parser reads or one copied from a recorded line.

**What makes that safe to publish a figure from** is `tests/doc-scenes.test.ts`: each scene is driven
through the real `parseLine` and the real reducer, and asserted to produce the state its figure
claims — two flagged turns, a compaction of 191.4k → 42.8k, a failed tool, an error the session ends
on, five sessions of different weights. A wrong field name does not draw a wrong picture, it draws an
EMPTY one, and the only reader who could catch that is one who already knows what should have been
there. The test also pins the one line the parser legitimately ignores (a `local-command-stdout`
receipt), so "nothing was dropped" stays a real assertion.

**Eighteen figures now** — 17 cut stills plus the tray's own recording — covering every surface but
two, and those two are refusals rather than gaps:

- **The settings panel** was declared, cut, and thrown away: the drawer renders its frame before its
  content arrives, and the crop came back holding **1 character of text**. The size floor passed it
  without trouble — 500×1100 of empty panel is not small — which is why the guard now also fails a
  crop with under 24 characters of text, and a shot can declare a `waitFor` for something its own
  content renders. A figure can be exactly the right size and say nothing.
- **Expand all** is a list, the least visual thing in the document, and its crop was the one the
  capture never reached. Left out rather than shipped from a run that had to be interrupted.

Along the way:

- **The capture ran against the real `~/.seedeep/`.** It now sets `SEEDEEP_HOME` into the bundle, so
  a doc build cannot read or write the developer's own settings, token or certificate.
- **Each scene shot reloads the page first.** Escape was not enough: the timeline strip stays open,
  so the next shot's click on the same control TOGGLED it shut and its chips were reported "not on
  the page" — a skip that looked like a renamed widget. A shot must not depend on its position in
  the list.
- **The viewport is 1150 tall, not 900**: a crop can only contain what was rendered, and at 900 the
  Verdict lens cut off its `crit` row — the one the figure exists for.
- **A card's title is not always its direct child.** `.card:has(> .wtitle)` matched Context and
  Session and nothing else; the timeline does not live in a `.card` at all (`.tstrip`).
- The corpus sessions were each saying the same sentence, which read as generated rather than
  recorded. They now say the shared phrase their own way — and the figure shows the shortest session
  ranked first, which is the density rule the text claims.
- **The capture hung in teardown**, after writing every figure: the page holds an SSE stream open for
  as long as it is watching, and `context.close()` waited on it. Two runs looked crashed while their
  work was already on disk. Teardown is now bounded — 10s for the browser, 5s for the server — and
  says so instead of stopping. A slow goodbye must not be indistinguishable from a crash.
- **Isolating `SEEDEEP_HOME` broke the capture, and the fix was in the URL.** A fresh state directory
  means a server in DEFAULT loopback mode, which announces `http://localhost:PORT` with **no token** —
  there is no network to authenticate against. The capture only matched the `?token=` form (the shape
  it happened to see while running against a configured home), so it waited 30s for a URL that never
  comes and then died before the first crop. Both postures are now recognised, and the session
  parameter is appended with the right separator instead of an assumed `&`.
- **A shot must never inherit the previous shot's page** — the same lesson twice. The settings drawer
  stayed open past its own crop and the Trace button underneath it became "not visible", which the
  guard reported as a renamed widget. Every shot after the first now reloads first, in the recorded
  path as well as in the scenes.

### The docs' figures become a build output — `doc-shots` (2026-08-07)

`docs/features.md` carried the whole tour of every surface and **not one image** — a reference for a
visual tool with no figures. Adding them by hand was the obvious move and the wrong one: a screenshot
is a claim about the current UI that **nothing in this project can falsify**. No test looks at a PNG,
the pre-push docs gate reads text, and a release lands every ~2 days. Hand-taken figures would be N
silent lies with no mechanism to correct them.

So a figure is now declared, cut and checked:

- **`apps/server/data/doc-shots.json`** declares each shot: the cue in the replay, the element to
  crop, and — the part that matters — the **source files that invalidate it**.
- **`bun run doc-shots`** (a fourth command in `capture-demo.ts`) replays the same saved transcript
  `shoot` uses and cuts each crop with playwright. Free: the recording already happened, nothing
  calls the model. Re-cutting the whole set is one command.
- **`bun run doc-shots:check`** reports the shots whose sources changed while their own PNG did not.
  Deterministic, warn-only, and wired into the pre-push hook beside the CHANGELOG check — the LLM
  gate cannot see pixels, so this one is a fact rather than a judgement.

Three figures shipped: the live monitor during a fan-out (three subagents, three different
denominators — `2% of 1M`, `8% of 200k`, `1% of 1M`, which is the whole argument for the bar
following the model), the context card at 26% of 1M split by API category, and one turn in the Trace
with its rounds folded into chapters and its failed step flagged from outside the fold.

Two rules the code enforces rather than trusts: **a crop under 200×60 CSS px fails the run** (a
widget that rendered its empty state would otherwise become a figure of nothing, the one defect a
reader cannot detect), and **a selector that matches nothing fails too** — a figure that can no
longer be cut is a figure that had stopped being true. The failure path saves a full-page screenshot
into the private bundle, because counts alone cannot tell a renamed widget from a view that never
mounted.

A fourth shot, the Verdict lens, was declared and then removed: the synthetic session has no wasteful
turn (`Verdict 0`), and a lens over nothing is worse than no figure. It needs a recording that earns
a verdict.

### The README becomes the shop window again — `docs/features.md` and `docs/install.md` (2026-08-07)

The README had grown to 677 lines and **7,298 words** — more prose than any comparable README
measured (`bat` 4,655 at 60k stars, `gum` 1,719, `ccusage` 1,314, `opencode` 541), while seedeep has
not launched. Where those words went is the point: **72% of them were neither the pitch nor the
captures** — a 234-line Status list whose longest single bullet ran 61 lines, plus 253 lines of
install, update, permission and uninstall detail. A reader looking for "what is this and why would I
run it" had to read a specification to find out.

Nothing was deleted; the detail moved to the two documents whose subject it is, and both are now in
the doc map and in the pre-push docs gate:

- **`docs/features.md`** — the complete tour: every surface, and the rule behind the ones whose
  behaviour is not obvious, with the measured figures that justify them.
- **`docs/install.md`** — everything a user does around running it: the two channels and what the
  executable is (and is not), the `/seedeep` command file, `seedeep report`, the update check and its
  once-an-hour cache, the macOS permission the server asks for, remote access, and removing both
  programs. The unsigned first-launch warnings live here now — the gate's tray paragraph said the
  README carried them, and that sentence was corrected in the same pass.

**The opening then stopped describing the tool and started describing the turn** (same day). It
said *what seedeep shows*; the reader's question is *what am I losing without it*. The pitch is now
the spinner — prompt sent, nothing on screen, an answer minutes later with no account of its cost —
and each *Why* line leads with the thing the session never tells you before naming what seedeep does
about it. The hero's caption was measured against the artifact rather than the notes that produced
it, which corrected it twice: the GIF ends with **six** subagents, not three, and the turn it shows
bills 2.9M tokens of which 2.5M is the same context read again.

A second paragraph then states what is actually recorded, end to end — the prompt, every call to the
model with its latency and its own input and output, every tool and what came back, each subagent's
work folded under the spawn that launched it, down to the answer. The first version said only
"makes that turn visible", and its one concrete detail was the subagents, which read as though
watching them were all seedeep did.

That same pass removed a claim the product does not make: *"What is filling it — system,
conversation, tool results, skills, MCP"*. The context card splits by API token category — `Cache
read`, `Cache write`, `Input` (`graph.ts:833`) — and there is no semantic split anywhere in the
client. It had been in the README since before the captures existed.

The README keeps the hero, the five captures, a one-line-per-item *Why*, one install block, the
platform-honesty table, and the design principles — 214 lines, in the range of the READMEs above. It
also carries the three badges it never had (npm, licence, Claude Code). `bun build --compile` must
never be called by hand: that warning was README-only, and moved to `CONTRIBUTING.md` beside
`build:server` rather than being dropped with the section around it.

### The retrospective's by-model split counts subagents (2026-08-06)

Home's `TOKENS BY MODEL` charged every token to the turn's MAIN-thread model, so a session whose
subagents ran on Haiku and Sonnet still rendered as "Opus 5 · 100%". Not a regression — `git log -S`
shows the split has had one functional commit since it was added on 2026-07-21, and the per-model
subagent data arrived later, scoped to the Session card alone.

`TurnSummary` now carries `subagentTokensByModel` and `subagentNew`, filled from the agents whose
`turnIndex` names the turn — the same filter `scopeToTurn` uses for the Trace, so the 7- and 30-day
windows stay exact. The window totals grew to match, because bars that do not sum to the total
printed beside them are a card contradicting itself. Aggregate cache version 12 → 13.

### The banner announces, the panel instructs — and stops guessing how (2026-08-06)

Two corrections to the same feature, both from seeing it on a real machine.

- **The notification carried instructions that are not its job.** A banner is read in a second and
  dismissed; it now says *"seedeep 0.11.3 is available / The server is running 0.10.1."* and stops.
- **The panel was telling a bun install to replace an executable.** How to update depends on the
  channel, and a server older than the `command` field says nothing at all — which was being treated
  as "no command exists", i.e. the downloaded-file case. The two are now distinct: with a command it
  is named, a downloaded executable is told it is replaced by hand, and a server that did not say
  gets *"Update the server, then `seedeep restart`"* — what to do, silent on how.

### The update line names the command, instead of pointing at a terminal (2026-08-06)

The tray said *"Update the server in a terminal, then `seedeep restart`"* and stopped exactly where
the user needed it: **which** command? bun, npm and a downloaded executable each want a different
one, and no client can tell them apart — how a server was installed is readable only from where its
executable lives, which is the server itself.

- `GET /api/update` now carries `channel` and `command`. A checkout reports `git pull`; a downloaded
  executable reports none, because replacing a file by hand is not a command and the client says
  that in words.
- Both surfaces use it: the tray's About section and the portal's. The portal previously said "run
  `seedeep update`", which was a pointer to a command that would have printed this same line.

### The update banner gets a second chance, and one label stops explaining itself (2026-08-06)

Measured on a real machine: the banner for 0.11.1 **was sent** and macOS never showed it, because a
freshly installed unsigned bundle has no notification permission yet. The tray had already recorded
the version as announced, so it could never be shown again — the rule "once per version, ever" fails
exactly in the case that matters, the first notification after an install.

- It is now **once per version, per RUN**. A restart is a second chance, and a restart is precisely
  when a reinstall has just cost the permission. The memory moved from a file into memory, so the
  rule falls out of the process's lifetime instead of being enforced against it; the old
  `update-notified.json` is swept at start.
- The switch is *A session finishes*. It briefly said *— not one you stopped*, which only made a
  reader wonder what the exception was for: a turn you interrupted yourself never notifies, and if
  you pressed Esc you already know. The behaviour is unchanged; the rule lives in `docs/tray.md`.

### The tray's Settings panel states instead of explaining (2026-08-05)

Every switch carried a paragraph saying why its default was chosen. Measured at the real 392×560:
**991px of content in a 514px viewport** — two of the four switches and the whole About section
below the fold, with "the server is behind npm" some 990px down. Cut to labels only, the same view
is **606px** and effectively fits.

- The heading is *Notify me when*, so each row completes it and *Notify when a…* stops being
  repeated four times.
- What a label could carry went into the label: *A session finishes — not one you stopped*.
- Three sentences survived, each because it prevents a MISREADING rather than justifying a default:
  the menu-bar icon is never silenced by a toggle, quitting the tray does not stop the server, and a
  banner is the only proof that notifications are being delivered at all.
- The rationale itself did not disappear — it is what `docs/tray.md` is for.

### The tray's update banner is about the SERVER now (2026-08-05)

It compared the TRAY's version with npm, which turned out to answer the wrong question: on the
machine that found this, the tray was already current and the server was two releases behind, and
nothing said so. The tray is a client — the thing that is run, and that a stale version actually
affects, is the server.

- The banner reads the SERVER's own `standing` from `/api/update` — the same verdict the portal
  shows for that machine, so the tray never recomputes it. Its words changed to match: *"A new
  seedeep server is available / The server is 0.10.1; 0.11.0 has been published. Update it, then
  `seedeep restart`."*
- The switch is now *Notify when a new server version is released*.
- **The panel still names both**, and marks whichever line is behind rather than stating the new
  version once at the bottom: which install needs updating is exactly what the reader could not
  work out. A stale server is told to restart after updating; a stale tray, to install over itself.

### `seedeep status` — the question no other command answered (2026-08-05)

Every subcommand was an action; none said what state the machine was in. Two real failures on the
day it was written each needed a shell and a token to diagnose: a server still serving 0.9.0 after
the package had been updated to 0.10.0 (a running process keeps its code until it is restarted, and
nothing said so), and `/seedeep` missing because `install-command` had never been run. `status`
answers both in one screen — server, pid, mode, served version vs installed version, update
standing, and whether `/seedeep` exists and can actually run.

- **A server that is down is a state, not a failure**: exit 0 whatever it finds.
- **It never touches the registry** — the update line comes from the cache, read `offline`.
- **An installed command file and a working `/seedeep` are different facts.** The file calls
  `seedeep` by name, so a PATH that resolves elsewhere, or nowhere, is reported beside it.
- `own-server.ts` now holds how any command talks to a local server (token + the server's own
  certificate as CA) — shared with `restart`, which broke for exactly the want of it.

### `seedeep restart` could not restart a server in remote mode (2026-08-05)

It asks the server to replace itself over HTTP, and in remote mode seedeep serves its own
self-signed certificate — which `fetch` rejects (`DEPTH_ZERO_SELF_SIGNED_CERT`, measured against a
real server). The POST never left the process. Worse, `post` returned a bare number and a failure to
connect was `0`, the same value as a connection dropped mid-handover, which is this request's normal
ending — so the command carried on, spawned a replacement against a server that was still holding
the port, and reported `no replacement announced itself`. Every remote-mode user's `restart` was
broken; `stop` never was, because it signals a pid.

- The request now trusts the certificate **this machine generated and holds on disk**, passed as the
  only CA — never `rejectUnauthorized: false`, which would accept any certificate at all on the one
  request that can stop a server.
- `post` returns `answered | disconnected | unreachable`, so "never connected" and "connection
  dropped after the answer" can no longer be the same value. An unreachable server is now reported —
  naming the pid still running, and that `stop` + `start` needs no network — with nothing spawned.
- When no replacement appears, the message says WHICH half failed: an old server still holding its
  record is a different fault from a handover that started and never finished.
- Verified against the real remote server that produced the bug: pid 86549 → 88580.

### The update check became periodic, and four surfaces now share it (2026-08-05)

`seedeep update` was, for a few hours on the day it shipped, the only thing that ever asked npm
whether a newer version existed — which meant a user who never ran it never found out. The check is
now made once an hour and read by four surfaces: the command, a line after `seedeep open` / `start`,
the portal's About section, and a tray notification. This **supersedes** the same day's "never
automatically, always on command"; the outbound request itself is unchanged, and there is still
exactly one.

- **`update-check.ts` is the whole mechanism**: one request to npm's dist-tags, cached under
  `SEEDEEP_HOME` for an hour, with a shorter (15 min) cooldown after a failure. **The clock is the
  cache, not a timer** — nothing is scheduled, an expired answer is refetched by whoever asks next,
  so ten clients in that hour cost one request and a server nobody talks to costs none. The cadence
  costs 24 requests of 18 bytes a day and buys learning about a release within the hour; the tray
  stays quiet either way, because its banner fires once per released version.
- **Only `latest` is stored; the standing is derived on read.** The cache outlives the binary that
  wrote it, and a stored `behind` would keep saying it to an executable that has since been updated.
  A failed check keeps the last known version: an outage is not evidence that yesterday's answer was
  wrong.
- **`GET /api/update`** serves it to the portal and the tray. `open` and `start` read the cache
  `offline` and never refresh it — a first run would otherwise pay the check's timeout before
  printing the address the user actually ran the command for, and under `/seedeep` that blocks the
  turn. The **server warms the cache at its own start** instead, which is what makes those two lines
  reachable at all for someone who uses neither the portal nor the tray.
- **The tray notifies once per released version**, gated by a fourth switch (*Notify when a new
  seedeep is released*, on by default). It compares against the TRAY's own version, not the server's:
  the two are separate downloads and updated apart. The announced version is remembered on disk, so a
  login does not repeat it.
- Verified against the real registry: the endpoint answered `latest 0.9.0` on a cold cache, the
  second call was served from it (same `checkedAt`), and the portal's row appeared and disappeared
  under real clicks as the cached version changed.

### `seedeep report` no longer needs a session id (2026-08-05)

On the console there was no way to learn an id short of reading `~/.claude/projects` by hand, so
`report` now defaults to the newest session of the directory it is run from, and says so on stderr.
The default is safe here and is refused everywhere else in this CLI for a reason that is stated
rather than assumed: the report names its own subject on the first line, so a wrong pick is visible
and costs nothing — unlike opening the wrong server, which looks exactly like success. A directory
with no sessions is an error, never a session borrowed from another project.

The slug rule (the cwd with its separators turned into dashes) was verified against all 16 project
directories on this machine, each compared with the `cwd` its own transcript records.

### `seedeep --help` and `--version` (2026-08-05)

Eight subcommands and no way to discover them: `--help`, `-h`, `--version` and `-v` all answered
`unknown option "--help" for "serve"` — an error naming a subcommand the user never typed. Both are
recognised anywhere in `argv` and win over everything else, because asking what a program is must
never run it: `seedeep open --help` explains rather than starting a server. A test asserts the text
names every subcommand and flag the parser accepts, so one added without a line here fails the
suite.

### Review of the subcommand CLI (2026-08-05)

Fixed before any of it shipped, each verified by running the real thing:

- **`'constructor' in FLAGS` is true**, so an inherited key parsed as a subcommand and the dispatch's
  fallback then STARTED A SERVER — `seedeep toString` opened a browser, `seedeep toString --port`
  died with a leaked internal TypeError. `Object.hasOwn` now, with a test over five prototype keys.
- **The dispatch's tail made `open` the fallback for anything unmatched.** It is a `switch` with a
  `never` check now: a subcommand added to the union and forgotten no longer starts a server, it
  fails to compile.
- **`CLAUDE_CONFIG_DIR` was honoured for the command file and ignored for the transcripts**, so a
  user who set it would have had `install-command` succeed and every `report` answer "no transcript
  for that session". One `claudeDir` in `roots.ts` now answers for both. An empty value is treated
  as unset (`||`, not `??`) — otherwise it resolved every path against the working directory.
- **The command-file refresh ran inside `run()`, which the tests drive** — so `bun run test` could
  rewrite the developer's own `~/.claude/commands/seedeep.md`. It runs from `serve()` now, with a
  `.catch` to match the "never fatal" it claimed.
- **`/seedeep` accepted any first word as a session id.** With `${CLAUDE_SESSION_ID}` unsubstituted,
  `/seedeep report` arrived as `['report']` and opened the GUI instead of reporting. The id is
  shape-checked as a UUID, and the message names the cause.
- The spawn's log descriptor is closed in the parent after the child inherits it.

### `seedeep start`, and the command file keeps itself current (2026-08-05)

`start` is `open` without the browser — the counterpart of `stop`, sharing one `ensureRunning` with
`open`. A server already running is a success and says so, exactly as stopping an already-stopped
one is.

And the `/seedeep` command file is now refreshed by **every server start**, when it is older than
the binary. The rule it does not break: it never CREATES the file — running `install-command` once
is the permission — and it never touches a file whose digest says the user edited it. Before this,
the only warning was a line on the next `/seedeep`, which reached everyone except the person who had
stopped using it.

### `seedeep stop` (2026-08-05)

A fifth word for `/seedeep`, and a subcommand on the console: it ends the server on the configured
port. By SIGTERM through the pid in the server's own record, not by an endpoint — there is no
`/api/stop`, and a running server is already addressable that way. Never SIGKILL: a killed server
leaves behind the record its shutdown withdraws, and a recycled pid then inherits it. A server that
ignores the signal is reported rather than killed, and the stop is waited for, so "stopped" is
observed. Nothing running is a success, not an error.

### `seedeep update` says how this installation is updated (2026-08-05)

A fourth word for `/seedeep`, and a subcommand on the console. It reads the channel off the resolved
path of the running executable — bun's global `node_modules`, npm's, or a file the user downloaded —
and prints the one command that updates it.

It never runs that command: under `/seedeep` the shell runs inside Claude Code's preprocessing,
which blocks the turn and captures the output, so a global install would hang the turn and paste the
package manager's log into the session, with failure modes seedeep does not control (bun blocks the
postinstall without `--trust`).

It does ask npm which version is current — `…/-/package/seedeep/dist-tags`, 18 bytes — and that is
now **the only outbound request seedeep makes**: never on a start, never in the background, never
from the tray. One endpoint serves every channel, because the npm package and the release binaries
ship from the same tag. `--offline` skips it, and an unreachable registry is an outcome rather than
an error: the advice prints either way, because a machine with no network still deserves to be told
how it would update.

**Nothing said to one channel mentions another.** An npm install pointed at the release page ends up
with a standalone executable beside the one npm manages — two seedeeps, and the next `npm i -g`
moves only one. So `--trust` (bun's caveat) appears only under bun, the release link only for a
downloaded file, and "not on PATH" is answered per channel: `bun pm bin -g`, `npm prefix -g`/bin, or
`mv` for a file the user placed themselves. `npm bin -g` was NOT used — npm removed that command.
The tests assert the absences, not only the presences.

The PATH check shipped earlier the same day had a false alarm that would have hit every npm and bun
install: a package manager puts a SYMLINK on the PATH (`~/.bun/bin/seedeep` →
`~/.bun/install/global/node_modules/…`) while `process.execPath` is already the target, so comparing
the two spellings reported "that is a different executable" for the ordinary case. Both sides now
resolve through `realpath`.

### The `/seedeep` command file keeps itself current (2026-08-05)

The command file now ends with a marker: the version that wrote it, and a digest of everything
above. That is what separates an UPGRADE from an EDIT — previously both were only "the bytes
differ", so `install-command` refused both and every upgrade needed `--force`. A file whose digest
still matches is seedeep's and is updated in place; one that was edited becomes the user's and is
never touched.

Nothing hooks the upgrade, because no hook covers every channel — an npm `postinstall` reaches one
user in two, and a downloaded executable replaced by hand has no install step at all. The check
rides on `seedeep claude-code` instead, the one moment seedeep is certainly running: an installed
`/seedeep` older than the binary answering it says so, once, in one line.

`install-command` also warns when `seedeep` is not on PATH, or resolves to a different executable.
The command file calls `seedeep` by name, so on the downloaded binary — which installs nothing —
install-command used to report success while `/seedeep` was already guaranteed to fail with
*command not found*.

The README said none of this: it never stated that the downloaded file IS the program and installs
nothing, never gave the `mv … /usr/local/bin/seedeep` step it then assumed two paragraphs later, and
documented removing the tray but not the server. Its shell snippets also carried a hardcoded version
and architecture; they use a glob now, so a release does not date them.

### `/seedeep` gained report and restart (2026-08-05)

The slash command now carries three: `/seedeep open`, `/seedeep report [full]`, `/seedeep restart`,
with a bare `/seedeep` still opening. A command file is a template and cannot branch, so its shell
line stays fixed (`` !`seedeep claude-code ${CLAUDE_SESSION_ID} $ARGUMENTS` ``) and the branching
lives in the binary, where an unknown word is seedeep's own error instead of a shell's.

`report` says what a session cost and where its tokens went, from the same `summarizeTree` path the
aggregate cache and the GUI take — no server required, since the transcript is the source. It is
sized by the fact that it prints INTO the session it describes: the standing blocks do not grow with
the session, the per-turn prompts are behind `full`, and the last line states the report's own cost
(measured: 132 tokens on a real 31-turn session, 717 with `full`).

`restart` asks the server to replace itself and then waits for a record with a different pid, so it
cannot report a handover that never finished. Nothing running starts one, without opening a browser.

### The GUI opens from a console, and from inside Claude Code (2026-08-05)

`seedeep open` starts the server if it is down and opens the browser on it, or just opens the
browser when it is already up. `seedeep install-command` writes the `/seedeep` slash command into
Claude Code's own directory, so a session reaches the GUI without leaving the terminal. Both are
subcommands of the same executable — the only artifact every distribution channel delivers.

The start is detached (`setsid`), because a server started as a child of the shell Claude Code
opens would die with that session. Servers running but none on the configured port is reported
rather than resolved by guessing: opening the wrong one is indistinguishable from success.

Two things changed underneath, and both were found by running the compiled binary rather than the
dev entrypoint. **Unknown arguments are now an error**: the parser ignored them, so `seedeep open`
on a build without the subcommand started a server in the FOREGROUND, attached to the caller's
shell. And **respawning now goes through `selfInvocation`** — in a compiled binary `process.argv[1]`
is a path inside bunfs and `argv[0]` is the bare word `bun`, neither of which can be handed back to
a child; `POST /api/restart` shared that idiom and would have broken under the stricter parser.
See `docs/architecture.md`, *Opening the GUI from a console*.

### What has been run by hand, and on which system, is now stated (2026-08-05)

The README gained *Which platforms have actually been run*: a table saying that every claim in it
was checked on macOS only, that neither the Windows nor the Linux build has ever been launched on
its own system, and that the tray on Linux is not a target at all rather than an untested one. The
download instructions link to it, so the caveat reaches the person taking a `_windows-x64.exe`
rather than only the person already suspicious.

The distinction the section refuses to blur: on Linux the **suite** runs in CI on every push, so the
logic is exercised there — what has never happened is a human running the compiled binary. On
Windows neither has happened. Written as one sentence ("untested"), those are indistinguishable.

`CONTRIBUTING.md` gained *Running it on Windows*, the six claims a single Windows session would
settle — icon legibility at that platform's sizing being the likeliest defect, since the mark is
drawn against a macOS measurement. It turns the gap into something a contributor can close, which is
the only way it closes.

### Removing the tray is documented, and macOS has no uninstaller to document (2026-08-05)

The README gained a *Removing it* section and `docs/tray.md` the rule behind it: the word *uninstall*
appeared nowhere in either before. The asymmetry is the bundler's — Tauri v2's `BundleTarget` gives
macOS only `app` and `dmg`, so no installer exists to be undone there, while Windows' `nsis` registers
an uninstall entry. Nothing shipped changes; what changes is that the leftover config dir
(`app.seedeep.tray`, which survives on purpose so a reinstall keeps its pinned server) is now named
where a user looks, together with the NSIS **Delete app data** checkbox and the fact that it is
created unchecked.

### Every action pinned to a SHA, because OIDC moves the credential into the job (2026-08-05)

All 16 `uses:` references in `ci.yml` and `release.yml` now name a full commit SHA with the tag in a
same-line comment, and `npm install -g npm@11` became `npm@11.19.0`. The reason is the `npm` job:
trusted publishing stores no token, but it mints one inside the job, so any code running there can
publish — and a tag is a pointer its owner can move, which is exactly how `tj-actions/changed-files`
(CVE-2025-30066) put a credential-scraping commit into ~23,000 unchanged repositories in March 2025.

`dtolnay/rust-toolchain` needed one extra line: it reads the toolchain from an input whose only
value came from the `stable` branch's own default, which a SHA no longer names, so `toolchain:
stable` is now written where the build can be read.

Pinning freezes what it protects, and GitHub does not raise Dependabot alerts for SHA-pinned actions,
so `.github/dependabot.yml` was added — one grouped pull request a week, moving SHA and comment
together.

### Unsigned costs a permission on every update, not only a Gatekeeper dialog (2026-08-04)

Observed upgrading 0.7.0 → 0.9.0: same bundle identifier, an `allowed` row already in the TCC
database, a new build — and macOS asked for Documents again, re-deciding that row the moment it was
answered. `codesign -d -r-` on the installed app answers *"code object is not signed at all"*, so
there is no stable code identity for a grant to hang on and a rebuild is a different object.

Preferences and the stored connection survive, because those hang off the identifier, which did not
change. The permissions do not. Written down in the README beside the Gatekeeper warning and in
`docs/tray.md`: the Gatekeeper cost is paid once, this one on every release, and it was nowhere
because nobody had updated twice in a day before.

The dialog is at least legible now — it names `seedeep-tray`, which is the answer to *"who is
asking?"*: the tray, on behalf of the server it started.

### An empty card no longer means "nothing happened" (2026-08-04)

The Commits card said *"No commits in scope yet."* to a user whose repository seedeep had simply been
refused — for over an hour, with nothing on screen to say so. Every git failure collapses to `null`
inside `git.ts`, so "no commits" and "I was not allowed to look" arrived as the same answer, and only
one of them is the user's to act on.

They are told apart now, and by measurement rather than by guess: `access` answers **EACCES** for a
directory whose mode forbids entry and **ENOENT** for one that is not there, and `Bun.spawn` with
such a cwd throws EACCES — which is exactly how `git()` was failing. `EPERM`, which is what a macOS
privacy gate answers, counts the same; `ENOENT` deliberately does not, because telling somebody to
grant a permission is advice for a problem they do not have. Asked only where no repository was
found, so the ordinary path pays nothing.

### The tray and the server stop sharing a name (2026-08-04)

`productName` is **`seedeep-tray`**. It was `seedeep`, on the grounds that it is what the menu bar,
Finder and About show and that only the download page needed disambiguating. That was wrong about
which surfaces matter:

- macOS names an app in a permission dialog by `CFBundleDisplayName`, which is `productName`. With
  both programs called `seedeep`, the dialog said *"seedeep"* whether it was asking for the tray or
  on behalf of the server — and answering it wrote the grant under the tray, while the process that
  needed the folder was the server. Reading the TCC database was the only way to tell.
- `killall seedeep` reaches the **server**, whose executable is `seedeep`, not the app the user meant.

The bundle IDENTIFIER is unchanged (`app.seedeep.tray`), so the permission already granted, the
config directory and the Windows uninstall key all survive. The release workflow no longer renames
anything: the bundler now writes `seedeep-tray_<version>_…` itself, and its "fails when nothing
matched" guard moved with the glob. An existing `/Applications/seedeep.app` is NOT replaced by the
new `seedeep-tray.app` — the old one has to be dragged to the bin by hand.

### The two permissions macOS asks for are documented, not discovered (2026-08-04)

A user installing seedeep meets two system prompts and neither was written down anywhere, while the
Gatekeeper warning next to them has been in the README since the first tray release. Same rule,
applied to what it had missed.

**`~/Documents`** is the **server**, not the tray: seedeep reads `~/.claude/projects` and nothing
else, except `git.ts`, which runs read-only git in a session's own working directory to fill the
Commits and Changed files cards. If your projects live under Documents, macOS asks. Refusing leaves
those two cards empty and changes nothing else.

**Local network** is asked by both, and only with remote access configured: a server announces the
address it answers on, and that address is then a hostname on the LAN rather than loopback. The tray
now DECLARES why, in `NSLocalNetworkUsageDescription` — Tauri merges an `Info.plist` placed beside
`tauri.conf.json`, so no config entry has to be kept in sync with it. The server is a bare
executable with no bundle to carry a string, so for it the README is the only place this can live.

### A seedeep on this machine is never something to paste a URL for (2026-08-04)

Two rules, one complaint: with a server running right here in remote mode, the panel said *"open the
portal on the machine running seedeep, then Settings → Remote access, and copy the URL"* — advice
about another machine, given to somebody whose seedeep was the window behind it. And after a Stop,
Start never came back.

**The tray reads the co-located server's credentials.** Once a live record has proved a server is
here and its 401 says it wants a token, the tray reads `<seedeep home>/config.json` and connects
itself, pinned to the fingerprint of the certificate FILE. That is not a shortcut: the record's pid
is the same proof Stop already trusts enough to send a SIGTERM, the config is `0600` owned by the
user the tray runs as, and taking the fingerprint from the file is the opposite of adopting a record
because the network vouched for it. Nothing is stored — the config is the source of truth, re-read
whenever the store is empty, so persisting would only make a second copy of a secret.

**Co-location is decided by identity, not by spelling.** `dev-mac.local` is not spelled `127.0.0.1`,
but it resolves to it: macOS answers a machine's own `.local` name with `::1` and `127.0.0.1` beside
its LAN address. The old rule compared host strings and called that "never a reachability test" —
correct about reachability, and wrong to conflate it with identity. Loopback is now conclusive on its
own, and any other resolved address is put to a bind on port 0, which the kernel refuses for an
address this machine does not hold. Off the poll's thread and cached, because a `.local` name that
has gone away takes **5.0 s** to fail against 4.5 ms for one that has not — the same five seconds the
executable lookup was moved off that loop for.

Both were verified against a real remote-mode server on this machine, not only against fixtures:
`cargo test -- --ignored a_co_located_server` adopts it and prints the pin it took.

### A closed tab went on rendering (2026-08-04)

`destroy()` cancelled the tab's timers, and that was never enough: a request already in flight has
no timer to cancel, so its continuation runs whenever the network answers — after the tab was
closed, after the container was emptied. The three session-scoped cards (Commits, Cards, Changed
files) BUILD their content there, so an unguarded answer rendered a whole card into a host nothing
owned any more. It is not the harmless orphan-filling the drawer's fetches deliberately allow.

`destroy()` now sets a flag first, before anything is unwired, and those three continuations check
it: **after destroy, nothing renders**.

It had been red in CI since `8007d1b` and green on every developer machine — `app boot` failing on
`document.createElement` of undefined, because CI's file order let the answer land after the harness
had taken the document back. The test that pins it now counts elements CREATED after the tab closes,
since the container is already empty by then and could not tell the two outcomes apart.

### The review of the tray's start/stop work (2026-08-04)

Eleven findings against the nine commits above; the four that could be seen by a user:

- **Start comes up on the address the screen names.** It passes `--port` from the stored URL — never
  `--host`, which risks tipping the server into its non-loopback mode. A bare spawn came up on the
  configured port instead: with `http://127.0.0.1:9000` stored the panel stayed offline after a
  successful-looking start, and a second click launched a process that could not bind.
- **Look again can now report success.** It cleared the cache and then took a reading, but a reading
  starts the look in the background and returns the same instant — so the answer to that click was
  *not installed*, deterministically, and the real one arrived up to five seconds later. It waits for
  the shell now, the one gesture in the panel that does. The 30-second throttle was also answering
  clicks, and a look the user overtook could overwrite the path a later one had found; each look now
  carries the generation it started in.
- **Which announced server the tray adopts is a rule, not `read_dir`'s order** — the default port,
  then the lowest — and only a plaintext record is adopted on sight, since nothing is pinned when the
  tray tries an announced address. The lookup also stopped running where Start can never appear: a
  tray pointed at another machine was spawning a login shell every thirty seconds, forever.
- **`GET /api/config` withholds `dev` from an unauthenticated caller.** The route's exemption from
  auth was granted so the VERSION is readable before a token exists, and `dev` is the one field here
  that tells a stranger something about the operator's machine they could not already know.

And one that could not: **the icon's geometry was not under test.** `tauri::is_dev()` is `true` under
`cargo test`, so every rendered icon carried the development dot — and the dot sits in the very
columns the rule measures the eye in, which meant the test measured the dot in every state and could
no longer see the regression it was written for. Geometry is asserted on the released icon now, and
the dot has a rule of its own: every pixel outside its disc identical between the two builds. Both
were verified by injecting that regression and watching the old form pass and the new one fail.

### Developing beside an installed seedeep is written down once (2026-08-04)

The arrangement had been explained three times in three files, in three different wordings, all
written on the same day — README, `CONTRIBUTING.md` and `docs/tray.md`. That is how a document starts
to lie. **`CONTRIBUTING.md` owns it now**: the two commands, the one variable and what it moves, the
ports, what the two worlds share (the sessions, which is why each marks itself) and the one thing
that surprises people — a dev tray's Start launches whatever `seedeep` is on your `PATH`, not your
working copy. The README keeps three lines and a link; `docs/tray.md` and `docs/architecture.md` keep
the rule of their own half and drop the recipe. No new file: a second developer document is two to
keep true.

### A checkout says so, in the menu bar and in the tab (2026-08-04)

Two seedeeps on one machine are **indistinguishable by their content**: the sessions come from
`~/.claude/projects`, which belongs to Claude Code, so a dev portal and an installed one list exactly
the same work. Everything else about them is separate — config, certificate, token, caches, records,
the tray's stored connection — and none of that is on screen.

So each half now names itself, and only when it is the development one:

- **The tray** carries a small dot in the icon's upper LEFT, in every state. It is the corner the
  badge does not use and it is smaller than the badge, so the two are told apart by size as well as
  by side; the eye does not shrink to make room.
- **The portal** renames its tab to *seedeep dev* — which is what a tab strip shows when the page is
  off screen, i.e. exactly when the confusion happens — and puts a chip beside the brand.
  `GET /api/config` grew a `dev` field to say so.

Neither reads `SEEDEEP_HOME`: moving your state is not declaring yourself a developer. The tray asks
`tauri::is_dev()` (`!cfg!(feature = "custom-protocol")`, which `tauri build` turns on), and the
server asks `Bun.embeddedFiles.length` — Bun's own answer to "am I a standalone binary", measured at
0 from source against 1 compiled. Both are facts about how the binary was produced.

### One variable names a world, and the tray finds a server on any port (2026-08-04)

Developing seedeep on the machine you also run it on took two commands that did not point at each
other. `bun run dev` put the server on 9000 with a state directory of its own; `bun run tray:dev`
moved the tray's files but left it watching the INSTALLED server on 44842 — so the way to see your
own server was to paste its URL into the panel by hand, and Stop never appeared at all, its records
being in the other directory. Two variables, `SEEDEEP_HOME` and `SEEDEEP_TRAY_HOME`, always set
together and meaning the same thing.

Now there is one. **`SEEDEEP_HOME` names a world**: the server keeps its state there, the tray keeps
`connection.json` and `settings.json` in `<it>/tray`, and both dev scripts set it to `.seedeep-dev`.
A GUI app inherits no shell environment, which is what makes the installed tray the installed world
with nothing to remember. `SEEDEEP_TRAY_HOME` is gone. The dev server moved from 9000 to **44843**,
beside the installed one's 44842, so both pairs can be up at once.

What pairs them is a capability the tray gained rather than a rule it was told: **with nothing
stored, it reads `<seedeep home>/servers/*.json` — where every running server announces the address
it answers on — and tries those before falling back to guessing 44842.** That also closes a real gap
for users: `seedeep --port 9000` is documented in the README, and until now it left the panel saying
there was nothing to connect to, with no way out but pasting a URL for a server on the same machine.

### The tray starts and stops a local server, and its bundle identifier changed (2026-08-04)

A user with no terminal could install seedeep and still have no way to run it. The tray now starts
and stops a server on the same machine — and only there, since a server on another host is somebody
else's process. Start is an explicit button that appears only where nothing is answering here and
there is something to run; the server survives the tray's quit, so only Stop ends it. Full rules in
[`tray.md`](tray.md#starting-and-stopping-the-server).

Three mechanisms, each chosen against a measurement rather than an assumption. A macOS GUI app
inherits `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, so the executable is found by asking the user's own
shell (`-l` **and** `-i`: `-l` alone misses every PATH an installer writes into `.zshrc`). A start is
proven by the server announcing itself, never by the file existing — what is on `PATH` may be npm's
placeholder — and it is launched through `sh -c 'exec "$0"'` because that placeholder has no shebang
and `execve` would answer `ENOEXEC`. A stop is aimed at the connection and proven by a live record in
this machine's own directory, never by the URL: a server with remote access on announces the host it
was configured with, not loopback.

**The bundle identifier is now `app.seedeep.tray`** (was `dev.seedeep.tray`, which claimed a domain
nobody holds). It is the macOS bundle ID and the name of the config directory, so this makes a
different application to the OS: an existing install stays alongside and its stored connection is not
migrated. Done now precisely because it costs nothing — the tray installer had no downloads on either
release that carried the old one.

Settings gains the server's own version beside the tray's, with no verdict drawn from a difference:
the two are separate downloads that update apart. The browser portal already showed the server's, and
still shows only that one — there the client is served by the server, so they cannot legitimately
differ.

### The page draws its own share card (2026-08-04)

The card is no longer rendered by the server. Its markup goes into an `<svg><foreignObject>`, the
browser loads that SVG from a data URL into an `Image`, and the canvas exports the PNG —
`apps/server/src/core/share-card.ts` for the markup, `apps/server/src/client/share-card-png.ts` for
the pixels. `POST /api/share-card` is gone.

What it replaced was a second browser: the server spawned headless Chrome through playwright to draw
something the FIRST browser already had every field of — the client posted the whole payload and the
server added nothing to it. That round trip cost a 12 MB dependency that could not be bundled into
the executable at all, so the feature was absent from every download (500 on that one endpoint) and
required Chrome installed even from a clone. Now it works everywhere, offline, with no process to
spawn. `playwright-core` leaves the product and `chromium-bidi` goes with it: the compiled binary
has nothing left to declare `--external`.

Two details are load-bearing and both were measured before being written down. The SVG must come
from a **`data:` URL** — one from `URL.createObjectURL` counts as cross-origin and TAINTS the canvas,
so `toBlob` throws and no image comes out. And the markup may name only the five entities XML
defines: `&nbsp;` makes the image fail to load with nothing on the console, so the template writes
`&#160;`. Both have a red test.

### A tag now publishes to npm as well (2026-08-04)

The `npm` job is armed: the repository variable `SEEDEEP_NPM_PUBLISH` is set, the six packages carry
a trusted publisher on npmjs.com, and the job declares `environment: npm-publish` because that name
is part of the OIDC claim those publishers were configured to demand — one setting written in two
places, so renaming it here rejects every publish until the registry side matches.

What that moves is the point of no return: it used to be `npm publish` typed by hand, and it is now
`git push --tags`. A publish to npm cannot be withdrawn after 72 hours. The environment carries no
protection rule today, so it gates nothing; a required reviewer on it is what would put a human
click in front of each publish.

### The executable carried the path of the machine that built it (2026-08-03)

`playwright-core` does `require(path.join(packageRoot, 'package.json'))` — a COMPUTED require, which
no bundler resolves statically. Bun left it to runtime with the build machine's path frozen in, so
every server compiled by CI looked for the runner's own checkout,
`<ci-workspace>/node_modules`, on the USER's machine and died at startup. v0.6.0 shipped five of them; the assets were deleted rather than left as downloads
that cannot run.

It was invisible to whoever built it: on the build machine that path exists, which is why "the share
card renders from the finished binary" had been verified and was still wrong everywhere else. The
npm channel is what surfaced it — installing the packaged binary on this machine ran a file built
elsewhere, for the first time.

The server never needed playwright: it is a devDependency, and its one job is rendering the share
card's PNG through system Chrome. It is now external and imported lazily, so the executable starts
without it (61 MB instead of 67) and answers 500 on `/api/share-card` alone. From a clone the card
still renders. Putting it back in the binary means driving Chrome over raw CDP.

The guard is `assertNoBuildPath` in `build-binaries.ts`: a binary containing the builder's own path
fails the build, on any machine, since that is the one defect a build-machine test cannot see.
Measured two occurrences in the broken binary, zero in the repaired one, and the check was made to
fail on purpose before being kept.

### The server installs from npm, and that is the channel with no warning (2026-08-03)

`npm i -g seedeep` now installs the server. Not a JS module: a wrapper package whose
`optionalDependencies` carry the five executables built the day before, one per platform, resolved
by npm's `os`/`cpu` — so a machine downloads one binary and the wrapper's postinstall
(`apps/server/npm/install.cjs`) puts it over the file `bin` already points at. Node is needed to
install, never to run.

It buys three things the plain download cannot. A binary that arrives through a package manager is
never quarantined — macOS sets `com.apple.quarantine` in the browser that downloads, so the
first-launch refusal the README spends two paragraphs on does not happen on this channel, and
nothing had to be signed to get that. It lands on PATH at a fixed, discoverable place, which is what
lets a supervisor start it without being told where a file was left. And `npm update -g` becomes an
update story.

`bun run build:npm` (`apps/server/scripts/build-npm.ts`) assembles the packages from `dist/`, after
`build:server:all`; `apps/server/scripts/targets.ts` is now the one list of platforms both scripts
read. `release.yml` publishes them from the same tag that builds the binaries, by OIDC so no npm
token is stored here, and only while the repository variable `SEEDEEP_NPM_PUBLISH` is `true` — a
publish cannot be taken back, and the first one is manual because a trusted publisher can only be
configured on a package that already exists.

The bare downloads stay, and are not a fallback: they are the channel for a machine with no Node.

### The server is a download, not a checkout (2026-08-03)

`bun build --compile` now produces one standalone executable per platform — macOS arm64/x64, Linux
x64/arm64, Windows x64 — each carrying the Bun runtime and the whole browser GUI, so nothing has to
be installed before running one. `bun run build:server:all` builds them into `dist/`, and a `server`
job in `release.yml` attaches them to the same draft release as the tray's installers, which
`publish` now waits for (`needs: [tray, server]`): one tag carries both halves, which is what lets
the digest contract between them skip a compatibility matrix.

**The GUI's files are served from a map now, not from a directory** (`apps/server/src/server/assets.ts`).
`--compile` embeds a file only when something IMPORTS it, and nothing imports a stylesheet the
browser fetches over HTTP — measured on the first compile, which answered every `/api/*` call and
404'd every static path. Each file is imported with `with { type: 'file' }`, whose answer is a path
readable both on disk under `bun start` and as `/$bunfs/root/…` inside the executable, so dev and
release take the same code path. `publicDir` and its path-traversal guard are gone rather than
reimplemented: an escape is not a key. The list is hand-kept, and `assets.test.ts` walks `public/`
so a file added without a line there fails the suite instead of disappearing from a release.

Verified from the finished binary, not from the build succeeding: every static path served with the
right content type, `/api/sessions` answered, a share card rendered (2400×1256 PNG — so bundling
`playwright-core` with `chromium-bidi` left external really does work), `--no-open` opened nothing,
and the default run opened exactly the URL it printed. The five artifacts are ELF, Mach-O and PE32+
respectively; only the macOS one was executed here.

**Every asset now says which app it is**: `seedeep-server_<version>_<platform>` and
`seedeep-tray_<version>_<platform>`. Two macOS files sharing a `seedeep_<version>_` prefix said
nothing about which one reads your sessions. Tauri has no artifact-name override (checked against
its config reference), and `productName` stays `seedeep` because it is what the menu bar shows — so
the installers are renamed on the way to the release, which means `tauri-action` no longer uploads
them (`tagName: ''`, build only). The draft moved to a job of its own (`gh release create --draft`,
idempotent on a re-run), so the server's binaries no longer queue behind a 14-minute Windows build
for nothing but the release's existence. That job always runs and only its writing step is
conditional: `needs` reads a skipped dependency as a reason to skip, and a manual run has to keep
building. The rename step fails when nothing matched — a naming change in Tauri must stop a release,
not publish one with no installers in it.

### A checkout can run beside an installed seedeep (2026-08-03)

Both apps keep their state in ONE directory, resolved identically by a dev run and by a release:
`~/.seedeep/` for the server, the app config dir (from the bundle identifier) for the tray. So
developing rewrote what the installed copy reads — the port changed from a dev settings panel, or
the server a dev tray was pointed at, which the installed tray then meets as **Offline** with
nothing naming the cause. It never needed the two to run at once; alternating was enough.

`SEEDEEP_HOME` and `SEEDEEP_TRAY_HOME` move that state, and `bun run dev` / `bun run tray:dev` give
each app its own directory under `.seedeep-dev/` inside the checkout. One reading point per app (`seedDeepDir()`,
`config_root()`), so a relocation cannot be done by halves — the three caches that built
`join(home, '.seedeep', …)` themselves now go through `seedDeepDir`, and a test fails if any module
ever spells that name again. Relative values are made absolute, since neither app runs from the
directory the script was typed in; an empty value is no value. Verified: `bun run dev` wrote a fresh
config into `.seedeep-dev/server/` and left `~/.seedeep/config.json`'s mtime untouched.

### Changed files: the working tree is gone, and reading git can no longer write to it (2026-08-03)

Review of the rework found that the second source contradicted its own premise: `git status`
describes the repository now, not what one session did, so two live sessions in one repo would each
claim the whole dirty tree and pre-session changes would be credited to a session that never made
them — the same inference the feature refuses for commits. It is removed. The card counts the files
of the session's commits and nothing else, and a session that has not committed shows no number.

Fixed with it, all found by review:

- **`--no-optional-locks` on every git call.** Some porcelain refreshes the index and takes
  `.git/index.lock`: measured on git 2.50.1, `git status` rewrote `.git/index` while the same
  command under the flag left it byte-identical. seedeep polls the repo of a session that may be
  committing, and taking that lock can fail the user's own `git add`. The module promised "no index
  is taken" and, with `status`, was not keeping it.
- **`-z` on `diff-tree`.** `--name-only` C-quotes non-ASCII paths, so `src/café.ts` came back as
  `"src/caf\303\251.ts"` — counted as a second file and rendered as an escape blob.
- **The refresh debounce dies with the tab.** It was a raw `setTimeout`, unknown to `destroy()`; a
  tab closed inside the 1.5 s window left a timer that re-rendered a torn-down graph and restarted
  its 1 s ticker permanently. It also repaints through `scheduleRender` now, not a direct `render()`
  that bypassed the mid-replay guard.
- **git failing is no longer reported as "nothing committed".** `readCommitFiles` returns null on
  failure and `[]` for a commit with no files; the card says `The repository could not be read.`
- **The commit count comes from hashes, not timestamps** — author dates are whole seconds, so two
  commits in the same second collapsed into one.
- **Every repo root is sent to the client**, keyed by toplevel rather than common dir: a session
  moving between two repos showed one set of rows relative and the other absolute, and a linked
  worktree's files were prefixed with the wrong toplevel.
- **A commit's file list is memoised** per `(repo, hash)` — it is immutable, and the endpoint was
  spawning one git per commit on a 1.5 s cadence.
- **The drawer says it is waiting** instead of rendering an empty list under a filter box, which
  read as "your filter matched nothing".

### Changed files now counts what git can verify (2026-08-03)

The card read Claude Code's rewind ledger, which records only what CC's own file-writing tools
wrote. Measured on a real 16-file commit, 8 of those files had been written with a `python3`
heredoc, `cat >>` or the build, and the ledger knew nothing of them — the card said 8 while the
terminal said 16. Its hero also counted CC's own memory notes as project files, for the sole reason
that they were not scratchpad.

Recovering the missing half by inference is impossible: which session wrote a file by shell is
recorded nowhere on disk, so with two sessions on one repository nothing can tell them apart, and a
count that is a guess is worse than no count. The card therefore counts only sets git can produce —
the files of the commits the session made (`git show --stat`) plus, while it is live, what is still
uncommitted (`git status`) — and shows ONE number, captioned with the set it came from. A session
that never committed says `no commits` instead of a figure nothing can support.

- New `GET /api/files`, `src/core/file-attribution.ts` (pure), `src/server/session-files.ts`.
- `git.ts` gains `readCommitFiles` and `readWorktreeFiles`, read-only like every other git call.
- The ledger survives for the one thing git cannot see: the session scratchpad, which keeps its own
  row under the bars. `ledgerPath` resolves `trackingPath`, whose shape is not one — 1156 of 1765
  local deltas are relative to the cwd, with `backup.realParentDir` naming the directory on 1192 —
  and a path is anonymized BEFORE `isScratchPath` classifies it, which is what the `~scratch` token
  requires.
- Reference: `docs/changed-files.md`.


### 2026-08-03 — The Trace names the command, and calls nothing final while a turn runs

The NOW line for a round that has just started reads **`Started — no output yet`** (product call).
It said `Sent — waiting for the first response`, which collided with the opposite state: `waiting`
is what the panel says when the session is stopped ON THE USER. The wording also takes no position
on what the model is doing — seedeep does not read thinking blocks. `Answering — no tools used,
nothing said yet` stays as it is: that round HAS called the model, and the different words say so.

`/code-review del diff` read as `del diff` in the Trace: the row title was `prompt || command`, and
a command's arguments ARE its prompt, so the command itself — the only part that says what ran —
was dropped. The Graph's rows already had the rule; the Trace had its own. One `entryText`
(`core/tree-format.ts`) now serves both.

Four more from the review of the same series: a forked skill's child events arriving BEFORE its
launch line are no longer dropped (the agentId→spawn link is written only where a lane exists to
receive them, as on the ordinary spawn path); an interrupted turn is never "working" on any surface
(the guard moved into `turnIsWorking`, which the digest's `now` had bypassed); the parked-outcome
maps are drained by every call that closes, not only by a background one, so they cannot grow for
the session's life; and a delegated round's envelope now covers the work it handed off — the launch
and the return both move `turn.t1`, where a ten-minute `/code-review` used to measure one second.

A delegated round is labelled `work` in the Trace too, not `local`: the kind is guessed when the
turn opens (a `user-turn` carries only its command name) and answered at the launch — the same call
`kindOf` makes in the reducer, so one round cannot be labelled two ways on two surfaces.

`▲ FINAL RESULT` is omitted while any round is still working. The last answer on record belongs to
a previous round, and presenting it under that cap says the session has concluded when it has not.

### 2026-08-03 — A background command can report its end BEFORE its launch is written

seedeep showed `1 background command · 9m 7s · still running` for a command that had finished nine
minutes earlier and whose notification was on disk. Claude Code appends an assistant line when its
block CLOSES, so a command that finishes inside that block reports back BEFORE the `tool_use` that
launched it exists: verified on a real session, the notification is line 1853 and its launch is line
1857. Read in file order, the outcome had no call to attach to and was dropped — the row then said
"still running" for the rest of the session, on both the Running card and the Trace.

Both now PARK an outcome whose launching call is not on the ledger yet (`session-tree.ts`,
`span-store.ts`) and apply it when the launch receipt arrives. Same shape as the meta-before-spawn
parking already there — this is the second fact Claude Code writes out of order, and neither is a
race: it is how the file is built.

### 2026-08-03 — Liveness comes from the process, because the transcript goes quiet

A session whose background agent had just returned read as FINISHED — no NOW, no live counter —
while the terminal showed `Harmonizing… (50s · thinking)`. Claude Code flushes a thinking block only
when it closes, so the parent transcript holds nothing for a median 11s after an agent comes back
(p90 33.1s, max 4m 5s, measured over 321 real returns), and every turn is mute for a median 10.2s
before its first API call.

**`turnIsWorking` (`core/graph-derive.ts`) decides it, from the same `isWorking(rec)` the tab dot
already used**: the LAST turn of a session whose process says `busy`/`shell` is working whatever the
file says — the principle already set for the session, now applied to its turn. Seeded at tab open,
because the roster only notifies on CHANGE and a tab opened onto an already-working session changes
nothing. Every surface reads that one answer: the NOW panel, the strip's `lv` class, the banner's
live counter, and the digest's `turn.state` (which had been sending `done` beside a live NOW).

**`shell` is not a working turn.** Liveness reads `isModelBusy` (`status === 'busy'`), never
`isWorking`, which also counts `shell` — Claude Code's word for a turn that is already OVER while a
background command runs. Read as working, every background command marked the finished turn live and
took the session's Result button with it. The tab dot still reads `isWorking`: the SESSION is busy
then; the turn is not.

**NOW gained the window after a return**: `/code-review returned — working on the result`, aged from
the agent's own return (`returnedWork`). What the session does with the result is not on disk, so
seedeep says only what it knows.

### 2026-08-03 — A turn that is working is never mute

The NOW panel drew nothing at all for a turn that had said nothing and run no tool of its own —
`nowLine` returned null, and every surface reads null as "draw no NOW". Measured over 3064 real
turns, that is not an edge case: 12.3% of turns use no tool and narrate nothing, producing only
their final answer a median 22.1s (p90 46.9s) later, and a round that hands its work to a forked
skill (`/code-review`) writes ONE line into the parent transcript and then nothing for as long as
the skill runs — 9m53s on the session this was reported from, 12m33s worst measured.

**`nowLine` gained a `working` state**, below the existing ones: what is delegated (*`/code-review`
is running in the background*, timed from the agent's own launch) else that the model is answering.
Both surfaces get it from the same function, so the tray's row and the browser's panel say the same
sentence. Silence remains for the one turn with nothing happening — a local built-in that never
called the model (361 of those 3064, all closing in 0s).

**What is running is `delegatedWork` (`core/graph-derive.ts`), beside `displayState`** — the rule
the Subagents card already used. Computed in the reducer instead, the panel claimed
`/code-review is running` while the card read `0 running`: one screen asserting both, caught in
live verification, not by a test.

**An agent a turn launched is that turn working.** Liveness and `TurnKind` read the work the turn
CAUSED, not only this thread's API calls: on `apiCalls` alone a `/code-review` presented as a
closed local command — `kind: 'local'`, `state: 'done'`, missing from `snapshot.turns`, skipped by
the verdict — for exactly as long as its review ran. A `/model` still cannot qualify: it launches
nothing. **The Trace is NOT covered**: it derives its own `kind` from the event (`span-store.ts`,
`e.command != null ? 'local' : 'work'`, assigned once) and handles no `agent-launch`, so a
`/code-review` round was collapsed to one idle line there — **fixed in the same series**:
`span-store` now builds a spawn block from `agent-launch`, keyed by the agent id (a forked skill has
no `toolUseId`, and neither does its sidecar), and `isIdle` also requires that the round launched
nothing. `TurnNode.agentIds` now uses the same
`spawnTool?.turnIndex ?? a.turnIndex` fallback the agent node has, since a forked skill has no
spawning tool at all.

### 2026-08-02 — The session's final answer, in both scopes and at the end of the Trace

Two surfaces claimed to show a session and stopped short of what it concluded.

**The scope banner carries `Result` in whole session too.** It existed only when a turn was
selected. A scope selector promises that the same surface answers the same questions at every
scope, so an affordance present at one scope and absent at the other is a defect on its own —
independently of the NOW panel happening to draw the same text, which it stops doing the moment a
new turn starts talking. The button opens the LAST entry that produced an answer, not
`turnList.at(-1)`: measured over 106 real sessions, 4 end on an entry that answers nothing (a
`/clear`, a compaction) and their conclusion is the entry before it. 8 sessions hold no answer at
all — no button, the same guard the turn scope already applies.

**And no button at all while a turn is RUNNING** (same guard as the banner's live counter). The
newest answer then belongs to the previous turn, and a `Result` under a whole-session scope reads
as what the session concluded — a claim nothing can make mid-sentence. Naming the turn inside the
modal does not cover it: the button is read before the modal is opened.

**The Trace's `▲ FINAL RESULT` cap now labels a block.** It was the last node of the spine with
empty space under it, and since every row's title is its PROMPT, the answer appeared nowhere in
the document — it was the last block of an expanded turn's strip, three interactions away
(expand, scroll right, click). The cap is now followed by a full-width block: the turn id plus
the answer's first line stripped to plain, opening the same drawer as that turn's `done` block
through the span's existing `turn-text` handle — no second copy of the text. With no answer
anywhere it draws `No final answer yet` rather than vanishing, which would put the cap back to
naming nothing. Rules in `docs/trace.md`.

### 2026-08-02 — A round in the Trace is called by the intent that opened it

`#7 round` was a counter. A round is one API call plus its tools, and that same call often carries
a mid-turn text block — the model saying what it is about to do — so the round already had a name:
the join is `message.id`, carried onto the `turn-narration` event and attached to the round's `api`
span. Measured over 235 transcripts / 30,467 rounds, **40.2%** state an intent; the other 60% keep
the number, and a named round moves its number to the sub-line. The block shows two clamped lines
(measured on the real 172px block: one line = 21 chars of a p50 129-char first line, two = 41), and
`title` carries the whole text.

A chapter is never named by an intent — the first of ten would describe one round as if it
described all ten. It keeps its range and prints `3 intents`, dropping `steps` to make room, and
lists them in its `title`. Also rejected, with the numbers: letting an intent BREAK the chapter run
the way a landmark tool does. It reads beautifully on one turn and destroys the grouping on 2,220
real ones — top-level blocks p50 1 → 3, p90 4 → 13, max 30 → **240**, at a median of one round per
chapter.

The reducer still keeps only the latest narration (the live NOW panel's datum): the history the
Trace needs lives on the spans, so the two surfaces never compete. Verified live against a real
session — every named block clamped to two lines, none overflowing, each carrying its full text in
`title` and its number in the sub-line.

The whole text reads in the api block's drawer, as an `Intent` block above `Input`: `/api/call-io`
now returns `narration` beside `output`. It was already arriving — as the first line of `output` —
but a call with tools renders `output` verbatim, because its args are code, so the one part meant
to be read as prose was read as a dump. `null` on the call that closed the turn: that text is the
answer, which the turn's own drawer owns.

### 2026-08-02 — A background command, told the same way on the row and in the drawer

Measured how a background command reads in the Trace, over 120 real launches in 47 sessions plus a
live browser run: the strip was right and the drawer contradicted it. Clicking a red background
block opened a `FAILED` chip above the launch receipt — «Command running in background… you will
be notified» — with no exit code anywhere, and a `Duration` of 99ms for a command that had run for
eight seconds and died. Three fixes, one story:

- **The drawer states the fate.** A `background` chip beside the kind, an `Outcome` block carrying
  Claude Code's sentence (`still running` until the notification lands — 6 of 120 launches never
  got one), and the ms tile named `Launch`, because that is what it measures.
- **The block is marked `bg`.** A background launch was otherwise an ordinary 100ms `Bash`, and its
  sub-line switches identity when the outcome lands — the command is replaced by CC's sentence,
  which names it by its `description`. The chip is the part that holds in every state.
- **A launch with no `description` no longer loses its fate.** CC then names the command by its own
  text, multi-line and HTML-escaped; the summary regex was anchored `^…$` with a `[^"]*` name, so an
  embedded quote or newline defeated it and the fate fell past the column's clip. It now anchors on
  the FATE — generated, single-line, always last — and decodes CC's entities after the split. All 74
  non-clean summaries on the local corpus now lead with their fate; one did not before.

### 2026-08-02 — The places where a hung request took the whole surface with it

Three spots where the browser waited on an answer that could never come — found while fixing the
silent-partition freeze below, all older than it, all fixed the same way: a deadline, because
`fetch` and `EventSource` have none of their own.

Not *every* ungated request: a review counted eight more (`/api/retro`, tool output, commits,
cards, config, restart, search, compare). Each of those leaves one element empty and nothing else,
and none is memoised — so they degrade, they do not freeze. What these three had in common is that
a single hung request took a whole surface down and kept it down.

- **A stalled resync no longer freezes the tab.** `finish()` — the one thing that flushes the
  buffered live events and lets the feed through — was reachable only from `replay-end`, an
  `error`, or `stop()`, and a silently cut path produces none of them. Every live event then went
  into the buffer and none came out, while `resync()` became a permanent no-op. A read that has
  delivered nothing for 30s is now finished as if it had errored. The deadline is on SILENCE, not
  duration: a big session takes a long time but is never quiet — worst gap between two frames on
  the largest local session (30.8 MB, 446 chunks) was **6ms**, so the window is ~5000x the observed
  worst case.
- **A baseline that never answers no longer poisons every share card.** `ensureBaseline` memoised
  its request and guarded it with `if (!baselineFetch)`, so a promise that never settled was never
  retried: the scale bar was missing from every card for the life of the page, long after the
  network came back. The request now has a 10s deadline (~100x the 96ms measured cold), and a
  failure clears the memo so the next card asks again.

- **A share card that never came back locked its button for good.** The button is disabled for the
  length of the call, so a request that never answers never re-enables it. On a live session the
  next event re-renders the banner and the button is a fresh node; on an ENDED session nothing
  re-renders, and only a reload frees it.

`withDeadline` moved to `client/deadline.ts` — four callers now, and it is the only mechanism any
of them has against a request that never settles. One trap it documents, having been walked into
twice: `fetch` resolves on the response HEADERS, so reading the body *after* the deadline leaves
that read unguarded. Both the baseline JSON and the share card's PNG are now read INSIDE it.

### 2026-08-02 — A silently cut network is now a state the portal reports

A network path that drops without a FIN or an RST left the portal looking connected and being
nothing of the kind: it said nothing, showed nothing new, and did not recover when the network came
back — only a hard reload did. Reproduced against a real server behind a TCP proxy that freezes the
path: **90s of silence, six missed heartbeats, `EventSource.readyState` still `1` (OPEN), zero
`error` events**. The reason is TCP, not a bug in the browser — an SSE connection only ever
RECEIVES, so it has nothing to retransmit and never learns the peer is gone.

Two independent freezes, both fixed:

- **The stream now times its own silence.** Nothing for 45s (three missed heartbeats) and the
  connection is declared lost, closed and rebuilt — the recovery path that already existed and was
  simply never reached. The check is periodic, so the verdict lands between 45s and 60s. It covers a
  connection stuck in `CONNECTING` too: a handshake that completed and never got a response does not
  error either, and `EventSource` retries only after an error. The heartbeat became a named
  `heartbeat` **event** instead of a `: ping` comment, because a comment reaches the socket but never
  the page: the browser exposes no hook for one, so the client had nothing to measure. It still
  carries no `id:`, so the numbering of real events is unchanged.
- **The roster poll now runs each reading under a 10s deadline.** The next poll is armed when the
  current one settles, and a `fetch` on a half-open connection settles never: measured 12 readings
  started, 11 settled, no 13th ever — not during the outage, and not in the minute after the network
  returned. On expiry the request is aborted, so an outage cannot pile up sockets either. Boot no
  longer waits forever on that first reading — so `persist()` refuses to save a workspace while no
  reading has landed, or the first click after such a boot would overwrite the user's tabs with the
  empty set it failed to restore.

Verified live end to end: during the outage the pill reads *Live feed lost — reconnecting…* inside
the 45–60s window (observed at 48s and 57s, the spread being where the silence starts relative to
the check), the poll keeps running, and within 6s of the network returning the page resyncs on its
own. No reload.

### 2026-08-02 — Main tools leads the output row

Order only, at the maintainer's call: the row now reads **Main tools · Commits · Cards** at a fixed
50 / 25 / 25 rather than closing with Main tools. It is the widest card and the one with the most to
read — full shell commands and file paths — so it takes the position the eye reaches first, and the
two quarter-width cards follow. Verified in the browser: 718 / 359 / 359 px at a 1500 px viewport.

### 2026-08-02 — Commits and Cards are always on the page

Both widgets used to join the output row only once they had content. The reasoning was width — 680
of 783 local sessions produce no commit, so an empty card spends a quarter of the page saying
nothing. What it actually cost is the answer itself: a session with no commit showed no Commits
widget, and a missing widget cannot tell you that nothing was shipped — it is indistinguishable from
seedeep not having looked. The maintainer's call: show them.

The row is now a fixed 25 / 25 / 50, both cards carry the empty state their renderers already had
(`No commits in scope yet.` / `No tracker card in scope yet.`), and each hides its **Expand all**
while there is nothing to expand — the drawer is built from the rows, so on an empty card that
button was a control that did nothing. The `.paired` layout and the row's reshuffling logic are gone
with it.

### 2026-08-02 — A command written as plain text is a turn again, and a forked skill knows its own name

`/code-review del diff` produced **no turn at all**: the iteration was missing from the timeline and
its work was credited to the previous turn. The line Claude Code writes for it carries the command as
plain text — no `origin`, no `promptSource`, no `<command-name>` — which is every door the parser was
checking. Measured over 721 real transcripts, this shape is 19 lines (`/compact` ×17, `/code-review`
×2) across versions 2.1.200 → 2.1.220, with zero false hits: a `user` line with **no** `origin`, not
`isMeta`, that is a command and nothing else.

The trap the fix had to avoid: one invocation can write **both** shapes, sharing a `promptId`
(`/compact` does, on 15 of the 19). Counting both would invent a turn instead of restoring one — so
the reducer folds them, keyed by `promptId` **and** the command name. Not by the id alone: a prompt
queued while a command runs inherits that command's `promptId` (measured once, on a real `/compact`),
and deduping on the id would swallow a human turn.

A forked skill also has no `Agent` spawn anywhere, so its agent belonged to no turn and read
`general-purpose`. Two records fix that, both already on disk: the parent's `local_command` line
carries `<forked-skill-launch>` (the new `agent-launch` event — when it started, which turn asked for
it), and the agent's own sidecar carries `description`, which `subagent-meta` was throwing away.

Verified against the real session that reported it: the turn is back as entry #5 (`/code-review del
diff`), `code-review` reaches the Commands widget, and the agent reads `/code-review del diff` and
stays on screen when the view is scoped to that entry.

### 2026-08-02 — The tray says how many subagents a session launched

The tray drew subagents only while they were RUNNING, and only on *Working*: the moment the last one
returned, the rows vanished and the panel held no trace that the session had used any. On *Idle* —
the state a session spends most of its life in — there was nothing at all. The digest already had
the fact for its own purposes (`snap.subagents` is every launch, not just the live ones); what was
missing was the projection.

`/api/digest` now carries `subagents.launched` beside `running`, and both bands draw it as
`Subagents 12 launched`. The count follows the same two rules the running figure does: a Workflow
run contributes its MEMBERS (`1` for a fan-out of a hundred would be false), and a launch with no
trace of itself is not counted — while one that reached a terminal state is, whatever it left
behind. Verified against real transcripts through the real replay + reducer: on the session with the
most spawns the figure is 108, and on one with two Workflow runs it is 15 direct spawns + 9 members
= 24.

Just the number, the maintainer's call — what each agent was and what it cost is one click away in the
portal. No line at all when the count is 0: measured over 721 real transcripts, 84% of sessions
never spawn one.

### 2026-08-02 — A failed API call is a session state, on both surfaces

Claude Code writes a failed call as an assistant line flagged `isApiErrorMessage`, and seedeep parsed
it already — into the Feed's red row and the Trace's error span, per call, inside one open tab. What
did not exist was the session-level fact, so nothing said *this session is broken* where you would
see it: not the tab strip, not the menu bar.

The measurement decided the design. Over 1830 local transcripts there are 47 failed calls in 38
sessions across 15 distinct days of a month — and **39 of the 47 are the last model line their
session ever wrote**. Recovery, when it came, was never within 10 s (median 5.7 min: a human
noticing and retrying). Claude Code's own in-flight retries are never written; what lands on disk is
the final error the user was shown, and the closest two errors in any one transcript are 125 s
apart. So this is a STATE, not an event: set by any failed call, cleared only by the next call that
reaches a model, never by time — and a surface keyed on it cannot flicker.

One derivation carries it. `TreeSnapshot.error` is set by the reducer, which already runs on both
sides — server-side for `/api/digest`, client-side per open tab — so the digest's new `error` field,
the tray's red icon and *Broken* band, and the portal's red tab dot all read one answer instead of
three copies of a rule. A subagent's failure counts as the session's (8 of the 47 were a child's, 7
of them rate limits a fan-out hit while the main thread still looked healthy) and says so on every
surface, because a lost worker and a stopped session call for different reactions.

Red outranks amber everywhere: an approval resumes the instant it is answered, a failed call does
not resume at all. The tray gains a third notification — ON by default, with the approvals, since
the session has stopped and nothing on screen said so — and a third switch to turn it off.

### 2026-08-02 — A card-id search is answered from an index

The inverse lookup read every transcript on every query — 2.9 s cold and 2.2 s **warm** over 716
sessions, peaking near 1 GB of RSS. The parse had a `(size, mtime)` cache, but a substring gate in
front of it read the corpus first, so the cache never got a chance to help. A cache the query cannot
use is not a cache.

`cards-index.ts` is the same shape as the session-search index beside it: its own file
(`~/.seedeep/cards-index.jsonl`), header plus one line per session, staleness stamp, incremental
refresh, atomic rename, and a build-time check that fails compilation if a card field is added
without being listed — a renamed field would otherwise load as `undefined`, an index that looks
populated and matches nothing.

First build 1.4 s, refresh with nothing changed 7 ms, after a restart 6 ms, the query itself under a
millisecond, file 0.3 MB. End to end over HTTP a repeated card-id search went 2.2 s → 68 ms. It is
refreshed only when the query looks like an id, so a text search still pays nothing for it.

Why the commit-hash twin never needed this: git IS an index. It answers which repository holds the
object, so that lookup opens only the sessions bracketing the commit. Nothing plays that role for a
tracker id.

### 2026-08-02 — Which tracker card a session worked on

The mirror of the commits link: that one says what a session shipped, this says what it was working
ON. A new **Cards** card sits under Commits in the output column, and Search answers the inverse —
typing a card id returns the sessions that acted on it.

The signal is an ACTION, never a mention. A key typed in a prompt is the widest signal and the
weakest evidence: of the 36 key-shaped prefixes appearing in prompts across the local corpus, 27
name no tracker at all (`GPT-4`, `RSA-2048`, `UTF-8`), and an early pass that read ids out of a
call's JSON body put `SHA-256` among the top four "cards". So the id comes from the tool call's own
id FIELD, and the row says whether the session `wrote` the card or only `read` it.

Title and link arrive offline, from the result of the call that touched the card: 71% per call,
but 99% once merged per card (411 of 415 rows) — a comment carries neither, the read or write
beside it carries both. The tracker URL is never constructed, only read back, so no tracker host
appears in the source and a self-hosted tracker links correctly for free. Recognition is by shape
(any MCP tool named `…issue…`/`…comment…` with an `ABC-12` id field), so Linear and Jira both work.

Forge issues use the same mechanism: `gh issue close 42` names its issue the way `git commit` names
its repo. Three rules were added only after real data broke the naive ones — a command counts only
where a shell would start one, only for a real subcommand, and its arguments stop at its line;
before them, a printed sentence containing "gh issue has 19 calls" filed issue #19 under a session
that never touched one, and a heredoc writing a command as data ran it. `-R/--repo` is honoured,
because most reads in a real corpus are OTHER projects' issues.

The write path was then exercised against a real repository — create, view, comment, close — which
found two more defects: one repository keyed two ways (`owner/repo` from the cwd, `host/owner/repo`
from `--repo`) split a single issue into two rows, and a chained call counted as one touch because
only its first command was read. A repository's identity now has ONE definition, and every issue a
command names is a touch.

Cost is zero on top of Commits: `transcript-scan.ts` now makes ONE cached pass per transcript and
both joins consume it.

### 2026-08-02 — Searching a commit hash finds the session that made it

The search index holds the dialogue only, and a commit's hash lives in the output of the command
that created it — so the one session that did the work was the one text search could not find.
Measured over 90 commits from 30 sessions: the dialogue alone returned the producing session for
64 (71%), and the misses were not random, they were every commit nobody happened to mention out
loud. A query that IS a hash now asks git as well, using the attribution the Commits card already
computes, and merges those sessions into the same rows: 90/90, with 26 of them reachable no other
way. Same row shape, same ordering, no new section — only the set of sessions grows, and a text
query pays a single regex.

A session matched through git carries `hits: 0` and no snippet: it never said the hash, and
inventing an occurrence count would have been the easy lie. It reads 0 and sorts last.

### 2026-08-01 — A session now lists the commits it produced, and proves each one

The transcript says WHO committed, git says WHAT EXISTS; joining them is the whole feature
(`GET /api/commits`, `docs/commits.md`). The join is proof-first: the commit's hash in the output
of that session's own `git commit` call — the same tool_use/tool_result pair, so no time window
and no text matching, and two sessions committing to one repo cannot steal each other's work.
Measured on this repo's 425 commits: 378 proved (88.9%), 16 by testimony (the subject inside a
command within ±120s, exclusive across sessions), 0 collisions. Everything else stays
unattributed — a commit is never handed to the nearest session in time.

The card shows the four newest commits, hash in cyan; the rest is one click away in the drawer.

The forge link is built from `origin` alone, with no API call: `/commit/<hash>`, or
`/-/commit/<hash>` when the host says gitlab. That host test does not have to be exhaustive —
measured against gitlab.com, the plain path answers `301 → /-/commit/`, so a self-hosted GitLab on
any domain resolves too and the heuristic only saves a redirect. Bitbucket (`/commits/`, plural)
and Azure DevOps are documented as unsupported rather than guessed at.

Three things had to be learned from the data rather than assumed: `git -C <path> commit` does not
contain the string `git commit` (34 commits lost to that in a first pass); a repo's identity is
`--git-common-dir`, not the toplevel, or parallel worktrees read as different repos; and a call
that PRINTS older commits (`git commit && git log --oneline -5`) must not claim them.

The layout moved to make room: the stats strip is three EQUAL cards (Session, Skills+Commands,
Changed files) and a new output row holds Commits — as wide as one strip card, so the two rows
share a vertical — leading Main tools, which takes the rest. The cockpit's left column joined the
same vertical (it was 35%, a few pixels off), so Context, Subagents, Session and Commits now line
up down the page. The Commits card exists only when
the session owns commits — 680 of 783 local sessions produce none, and Main
tools then takes the whole row, where it finally stops truncating the paths it alone carries.

### 2026-08-01 — A truncated transcript restarts the numbering, because `seq` IS the offset

The tailer has always handled a file that shrinks: it resets to offset 0 and re-reads. The watcher
never reset the matching number, so the re-read went out numbered from where the old file stopped —
and `seq` stopped being a position. Both client guards drop what is at or below their high-water,
so those lines passed every one of them, and usage, which is SUMMED, inflated silently: no error,
no gap, just wrong numbers. The two are one fact and are now written as one: `readNewLines` reports
`restarted` for the call that started over, and the watcher sets `tracked.seq = 0` in the same step.
The fix belongs there and nowhere else — a consumer that cannot trust `seq` as a position has no way
to dedup at all.

Whether Claude Code ever produces the case was measured first, on 2013 local transcripts and on
driven sessions (2.1.220), because a fix for an imaginary case is worth as little as a missing one:

- **`/compact` appends** — 26 real `compactMetadata` boundaries, all with their history intact
  before them (median 336 conversational lines).
- **`--resume` appends**, same inode, including resume of a file truncated by hand; a resume of a
  DELETED file is refused outright and the file is not recreated.
- **`/rewind` → *Restore conversation* appends** — the screen says the conversation is *forked*, and
  the transcript agrees: the post-restore prompt carries the same `parentUuid` as the original one
  and the abandoned branch stays in the file. The docs cover only the summarize path ("the original
  messages stay in the session transcript"), so this one was measured in a pty.
- 2013 files polled every 2 s: zero spontaneous shrinks.

So the branch is defensive code for something Claude Code does not do — kept, and now coherent,
for the one case that remains reachable: an edit from outside Claude Code.

### 2026-08-01 — The schema guard learns that a VALUE can break seedeep too

Everything the guard did was about the shape of the logs: which fields exist, which are gone. The
`shell` finding was neither — it was a *value*, in `~/.claude/sessions/<PID>.json`, in a vocabulary
seedeep reads and Claude Code owns. Two blind spots overlapped exactly, and the radar's founding
sentence ("a new field cannot break seedeep") turned out not to extend to values: this one did, for
months, until a user reported it.

Two guards now cover it, neither of which fails the build:

- **C25**, a contract claim: the probe launches a background command, lets the turn end, and
  requires `status: "shell"` while it runs. Scene 13 exists to provoke exactly that state, and ends
  its turn on purpose — the state only exists when the turn is over and the command is not. It then
  waits 10 s doing nothing, because the run samples the PID file every 2 s and a state that passes
  between two samples is a state the probe cannot see. `provoked` reads `backgroundTaskId` from the
  transcript, never the field under test.
- **A one-shot runtime warning**: an unrecognised status is logged once per value, by the process
  that is actually watching sessions. A test-suite scan was considered and rejected in its place —
  the PID file exists only for sessions open at that instant, so the suite would see one session in
  whatever state it happened to be in, which is exactly how `shell` went unseen.

`docs/claude-code-upgrades.md` gains the vocabularies seedeep reads and what a new value costs in
each: the status, `waitingFor` (a new label for a real approval would stop the amber band),
`entrypoint`, and the `a…/b…/w…` task-id prefixes.

### 2026-08-01 — What the session is still waiting on, said on both surfaces

The band said *Working* and the icon stayed lit, but nothing anywhere named the thing that was
still running. The turn it belonged to was over, its launch row had scrolled away, and NOW was
taken by whatever the session did next.

A background command is a **session attribute**, not a NOW state, and that placement was decided by
a question rather than by taste: put on the NOW line, it vanishes the moment a new prompt arrives
and the turn takes NOW back — which is 21% of real launches (measured, one with 12 prompts during a
single command). It now has its own place on all three surfaces:

- **the browser's banner** — an amber chip, `1 background command · 4m 12s`, in BOTH scopes, because
  a command outlives the turn that launched it and the banner is the one line always on screen;
- **the browser's live card** — which becomes *Running · live* the moment it holds more than
  subagents, with the command first: a subagent reports its own context and current call, a command
  reports nothing at all until it ends;
- **the tray's row**, in every band — `● bun run dev --watch   4m 12s` — the *Needs you* row
  included, which is the only line that band's deliberately spare layout has gained. Review found it
  missing there while the browser's chip had no such exception; both alternatives were rendered at
  392 px, and the maintainer took the line: 24 px on a row that only exists while you are blocked, against
  two surfaces contradicting each other at the moment the user is deciding something.

One derivation feeds all of them (`runningBackground`), and the digest carries its result rather
than the ingredients. **Open = launched and no `outcome`**: the launch receipt closes in
milliseconds, so nothing about the call itself can answer whether the command still runs. What ends
one is its notification, and only that — 9 of 107 real launches (8.4%) never sent one, so a line can
outlive its command for as long as the session lives. A timeout would be a number seedeep invented
to declare finished something nothing declared finished.

Three candidate placements were rendered through the real stylesheet before any of this was built,
and the rendering did the deciding twice. One candidate lost its command entirely — `.subrow`'s grid
ate a child that was not one of its cells — and was dropped rather than propped up with inline
styles. Then the live check, with a command actually running, caught the chip reading `1m ago`:
`fmtAge` is the formatter for things that HAPPENED, and this one is still going. It reads `4m 12s`
now. No test could have caught that: they assert the structure, not the word.

### 2026-08-01 — A session running a background command is working, and Claude Code always said so

Reported from a real session: a turn ended with a background command still running, the tray filed
the session under *Idle*, and it jumped back to *Working* only when the command finished.

The cause was not what either end of the conversation assumed. Sampling Claude Code's own process
file every 2 s across a 240-second background command:

```
118s  cc[status=busy]   digest: status=busy   now=activity
120s  cc[status=shell]  digest: status=null   now=output     ← turn ends, the command runs on
 ...  (125 s of `shell`)
246s  cc[status=busy]   digest: status=busy   now=output     ← the command finishes, CC resumes
```

**Claude Code does not report `idle` there — it reports `shell`**, and seedeep did not know the
word. The status chain dropped anything unrecognised to `null`, and a session with no status is
filed under Idle on purpose, because a band is a claim. So seedeep demoted a session Claude Code
had never called idle.

`shell` now travels raw, and `isWorking` (`core/types.ts`, beside `isLive`) is the one rule that
reads it — for the browser's tab badge, the tray's band, and the tray's Rust icon, each pinned to it
by a test that enumerates the values. Two consequences beyond the band: the icon stays lit for the
command's whole run, and the **"Finished" notification no longer fires at the end of the turn** but
when the command really ends.

A value nobody has seen yet still becomes `null`. That caution is exactly what this taught: the test
for the status chain had already used `'shell'` as its example of "a status we have no meaning for",
and asserted it be dropped — the word had been seen and filed as meaningless by analogy, which is
the same mistake as a noise-list written from tool names. Only the measurement said what it was.

Placement was decided by a question rather than by taste. The first proposal put "1 background
command running" on the NOW line; the maintainer asked what happens when a new prompt arrives while the
command runs, and the answer is that the new turn takes NOW back by precedence and the background
disappears again. That belongs to a session-attribute surface, not to NOW, and is not in this
change.

### 2026-07-31 — A word already read does not come back when the server restarts

The maintainer saw it within minutes of the tray shipping: the first intent on screen, then a count, then
**the same first intent again**, twice more, before it settled. That cannot happen by the rule — a
hold is measured from when the word was seen, and without a new word it cannot start over.

It could happen by the implementation. The server's sighting was stamped wherever a line was
applied, the SEED included — and the seed replays what is already on disk. So every rebuild of a
session's tree re-stamped its last word as if it had just arrived, and the hold started again on a
narration the reader had finished with. A tree is rebuilt whenever the server starts, and whenever a
session drops out of one liveness reading. The 60-second `arrivedLive` guard covered none of it: the
word in question is seconds old, which is exactly the case that matters.

The sighting is now taken **only on the live path**. What the seed reads has no sighting, earns no
hold, and NOW says what the turn has DONE — which is what the browser has always done when it opens
a session mid-turn, so the two sides now reach that answer the same way. The visible consequence is
deliberate: a server restarted mid-turn shows the count rather than replaying the last thing said.

Reproduced before fixing and after: restart the server mid-turn and sample the digest twice a
second. Before, the row returned to the exact text it had already replaced (same hash). After, it
holds the count across the restart. The regression test asserts the two halves apart — history gets
no sighting, a live arrival gets one stamped when it arrives — and the digest test that covers the
intent path had to be rewritten to emit its narration through the watcher, because a word written to
the file before the tree is built is, correctly, no longer fresh.

### 2026-07-31 — A published artifact is a link, not a string to read off the screen

An `Artifact` call's result names the page it put online — `Published <file> at <url>` — and the
drawer showed it as what it is: text inside the raw output block. The drawer now inserts a
`Published at` block above that output, with the URL as a real anchor. Built as DOM nodes and never
`innerHTML`: a tool's output is arbitrary text a command printed, and the one safe way to put it on
a page is to never let it be parsed as markup.

The block is claimed for the TOOL as well as for the URL. Only an `Artifact` call published
anything, so a `Bash` that happens to print an artifact link gets no block, and neither does the
`action: "list"` form, whose result carries no URL at all. Both cases are tests, and both were
flipped off to confirm they go red.

**The prototype chose the shape and the live session corrected it — twice.** Three variants were
rendered through the real stylesheet at the real 500px: keeping it as text, a `Published at` block,
and linkifying the URL in place. Measured on the rendered DOM, the block costs +115px and shows the
URL twice (the raw output below repeats it verbatim), against +4px for the in-place link. The maintainer
chose the block. Then the live check — a real publish, a real click on the feed row — found what no
test could: **the URL never arrived intact**. `anon()` masks every uuid, and an artifact id is one,
so the drawer was being handed `…/artifact/<id>`. The tests passed because they fed the parser the
id themselves, which is precisely the failure mode the testing rules name.

So `anon()` gained its first and only exemption: the uuid inside a `claude.ai/code/artifact/` URL is
kept, and the same uuid one character outside that path is still masked. The rule exists for session
and agent ids; an artifact id fell under it by having the same shape, and masked it produced a link
that goes nowhere and cannot even be copied by hand. Nothing `anon()` touches is ever committed, so
the repository is unaffected; the exposure is a live demo or screen-share of a real session, and
public screenshots are covered by their own rule — synthetic sessions have published nothing.

The fake DOM grew `parentElement`, `insertBefore`, and a `replaceChildren` that DETACHES what it
replaces. The last one is not housekeeping: the drawer's staleness guard IS that null parent, and a
fake that kept the pointer would have let a test pass while a late response painted into a panel the
user had already replaced.

### 2026-07-31 — One NOW: the portal and the tray now compute it with the same function

The two surfaces answered "what is this session doing" from two different places. The portal's NOW
panel owned the whole rule inside `graph.ts` — a block on the user outranks everything, then what
the turn has DONE outranks what it SAID once the words have had their moment, then the words
themselves. The tray had never had the aggregate phrase at all: it drew the agent's words plus its
own itemised call line, decided in `bands.ts`. A change to the rule reached one surface and not the
other, which is exactly what happened when `Artifact` got its phrase earlier today.

The rule now lives once, in `core/activity-line.ts` as **`nowLine`**, and returns the state to draw:
a `kind` (`waiting` | `activity` | `intent` | `output`, which also says whose voice is speaking), the
label, the text, and `ageFrom` — the instant an age counts from, never a duration, which would
expire in flight. `graph.ts` calls it and keeps only the drawing; `digest.ts` calls it and ships
`turn.now`; the tray draws that field and nothing else. `turn.activity`, `turn.intent`,
`turn.result`, `turn.recent` and `turn.runningSince` are gone from the wire — five ways to say what
one field now says, four of which the tray was recombining by its own rules.

**The itemised call line is gone from the tray** (the maintainer's call): with NOW on the row it was a
second, lower-resolution answer to the same question, and it was the tray's alone. **An idle row can
now read a count instead of the agent's last words** — the case where a settled turn did something
after speaking, measured at 1 real session in 13. Also the maintainer's call, taken with that number in
hand: one rule everywhere is worth more than a band keeping its own.

The one thing a shared rule could not simply move is the hold's clock. It is counted from when the
word was SEEN, and the line's own timestamp cannot stand in for that — Claude Code stamps a text
block when it starts generating it and flushes the line 7-9 s later. So the sighting stays the
observer's: the browser keeps its own, and `live-trees.ts` now stamps the server's as lines are
applied. The seed stamps replayed history the same way, and the 60-second `arrivedLive` guard
correctly gives it no hold — a session the tray has just discovered shows what it is DOING rather
than replaying an old line as news.

`pendingInput` moved to `core/types.ts` beside `isLive`, for the same reason it was there: the
digest now needs the same answer as the picker. The tray's Rust notification reads `turn.now.text`,
so the banner and the row it belongs to cannot word one event differently.

### 2026-07-31 — The Artifact tool gets its own words, and a label that is not decided by luck

The schema radar reported one field seedeep had never seen — `toolUseResult → artifacts`, the list
returned by an `Artifact` call made with `action: "list"`. The field is not the work: nothing reads
it, and a field nobody reads cannot break anything. It is the reason to go and look at the tool
that produced it, and `Artifact` turned out to be in neither of the two tables that decide how a
call reads on screen.

`WORDS` (`activity-line.ts`) had no entry, so a turn that published something said **"1 Artifact
call"** — the generic phrase for a tool with no verb of its own, printed by the NOW panel and the
tray's *Working* band. It now reads **"published 2 artifacts"**. LIMIT, stated at the code site: a
phrase is chosen from a COUNT, never from the call's input, so the one non-publishing form is still
phrased as a publish. That is 1 of the 31 real calls.

`argOf` (`parser.ts`) had no entry either, and here the measured facts trimmed the finding. All 30
publishes carry `file_path`, which is already `argOf`'s default branch — those labels were never
order-dependent. Only the `list` form, which carries no file, fell to the first-string fallback:
today its sole string key is `action`, but `scope` arriving first would label the row `mine`
instead of `list`. The mapping is now explicit (`file_path ?? action`), so neither form depends on
the order the model happened to emit its keys in.

The artifacts list itself is NOT surfaced: one occurrence in the whole local corpus, and nothing
asks for it. The field was accepted into `known-fields.json` with the regenerated set diffed —
exactly one line added — so the radar stops reporting something that has now been looked at.

### 2026-07-31 — A background command's failure is no longer thrown away

seedeep parsed a background command's outcome and then dropped it. Claude Code states it only in
the `<task-notification>` on a `queue-operation` line; the parser turned that into `agent-end`, the
reducer found no spawn to hang it on (a background `Bash` has none), and it died there — the row
had already closed, clean, on a 74ms launch receipt. Measured across 868 local sessions: of the 94
background commands that reported a terminal status, **29 failed and 2 were killed — a third of
them, none of them visible.**

The notification is now routed to the tool call that launched the command, in all three surfaces
that show a Bash row (reducer `ToolNode.outcome`, span store, live feed ring). The gate is the
launch receipt's `backgroundTaskId`, never the notification's id shape: a `Monitor` call gets a
`b…`-prefixed notification too, and a resumed subagent's notification names its `SendMessage` call
— painting either row failed would state something about a tool that launched nothing.

A non-clean outcome reddens the row and replaces the command with Claude Code's own sentence — the
same substitution a failed API call already makes with its error message. A clean exit leaves the
row exactly as it was. Reporting CC's words rather than seedeep's own reading is deliberate: 28 of
the 29 real failures are exit 144, which is what a deliberately `pkill`-ed dev server gets, and
re-classifying that would mean inventing a distinction no field in the logs carries.

The words are CC's, the ORDER is not. Shown as CC writes it, the row read `Background command
"Start seedeep server…` — the column truncates on the right, and `failed with exit code 144` is
exactly what the ellipsis ate. `outcomeLine` puts the fate first; an unrecognised summary passes
through whole, so a future rewording degrades to showing everything rather than mangling it.

The span's DURATION is untouched: what that call did was launch the command, not run it.

### 2026-07-31 — Home, Compare and Search moved out of the tab strip into a header menu

Three permanent pills sat at the head of the strip. The strip is where you find a SESSION, and its
width is the only thing the subjects have — the pills were spending it on labels that never change.
They are now one ☰ button left of the wordmark (`nav-menu.ts`), and the strip holds sessions only:
`tabBar.addPinned` is gone, along with the `home-tab` class it created.

The trigger **adopts the name of the surface you are on** (`✦ Home`) and goes bare on a session.
Without it, switching to a fixed surface would leave no tab in the strip active, so "where am I"
would rest on one lit border — and Search's panel, an empty input, does not name itself either.
Both states were rendered through the real stylesheet before the choice was made.

The menu reuses the picker's idiom rather than inventing a second one: same glass popover, trigger
toggles, click-outside and Esc close, ↑/↓ walk the items — real focus on real buttons, so Enter and
Space come free — and the current entry carries `aria-current="page"`. `switchTo` is still the one
path a surface is reached by, so a restored workspace comes back naming its surface, which is what
the live check drove with real clicks: strip free of pills, exactly one panel shown, zero active
tabs on a fixed surface, and the name surviving a reload.

### 2026-07-31 — The tray row says what the agent is doing, in the agent's own words

The row carried what the session was ASKED and what it had just run, and nothing of what it says it
is doing. The digest now carries `turn.intent` — the latest mid-turn narration, the same datum the
browser's NOW panel reads — and the row draws it under the prompt, with the turn's final answer
taking over once it lands. The precedence AND the three labels are the portal's, in one function, so
the two surfaces cannot describe the same turn differently: `output` when the answer has landed,
`now` while the turn is live, `intent` when the user stopped it with Esc. That third label is the
one review caught missing — an interrupted turn has no result by design and keeps the narration it
had reached, so reading a missing result as "still working" put a live `now` on an Idle row.

Both fields are **markdown-stripped before being cut to 200 characters**. The tray has no renderer
and no modal, so `**Il job \`publish\`**` reached the user verbatim — visible in the screenshot that
asked for this — and stripping first spends the 200 characters on words rather than on markers.

Two changes pay for the height, both chosen from four candidates rendered through the real
stylesheet at the real 392 px: the row draws **one** call rather than two (with the agent's own
words above it, the second says the same thing at a lower resolution), and **model · effort move
onto the CONTEXT line**, where they also belong by meaning — the window in the denominator is the
model's. A working row plus an idle row went from 372 px to 342 px while gaining the intent.

### 2026-07-31 — The tray shows only the sessions a person is in, and says when one finishes

Three things the menu bar could not do. **Headless runs are gone from it**: seedeep's own docs gate
writes an `sdk-cli` session on every push, and it appeared as a row nobody could act on and as an
icon claiming somebody was working. The digest now carries `entrypoint` (the fact) and the tray
applies the browser picker's rule at the ONE point a payload enters it, so rows, icon and
notifications cannot disagree about which sessions exist; an entrypoint we do not recognise is
KEPT, because an extra row is ignored while a hidden session is one the tray silently stops
watching.

**The working icon turns** — the iris becomes a radar wedge, 24 frames of 15° at 12 fps, with the
outline fixed so the mark never changes size while it spins. Waiting still outranks working and is
still STILL: the motion means "running, nothing for you to do", so an approval stops it. Seven
candidates were rendered at 18 pt before this one; the rate is a measurement, not a taste — 24 fps
costs 10.9% of one core, 12 fps 7.3%, idle 0.3%, and halving the rate does not halve the cost.

**A finished turn can notify**, behind its own switch, off by default: `busy → idle` sends
`Finished` plus the agent's last words. A turn interrupted with Esc never notifies, and
`busy → waiting` stays an approval. Verified from the bundled app against Notification Center's own
store — including the silence of a headless run that finishes, which is the session filter proven
end to end.

### 2026-07-31 — One formatter, one linter, and a reason written at every rule that is off

Formatting was whatever each file had ended up with, and nothing looked for dead code. Biome now
does both — one binary, one dependency, no plugin tree — and CI reports it rather than rewriting
it, because a pipeline that edits the code under review hides the line between what an author
wrote and what a machine changed.

The style is the codebase's own, measured instead of chosen: 2-space indent, single quotes
(228 files to 3), semicolons, trailing commas, and a line width of 120 — the existing lines are
p90=95 and p99=131, so the formatter reflows the outliers rather than rewrapping code that was
already deliberate. Biome's own default of 80 would have rewritten most of the repo to no purpose.

**Ten recommended rules are off, and each one says why in `biome.jsonc`.** They are the rules that
contradict a choice this repo already made: `noNonNullAssertion` (722 hits) fights
`noUncheckedIndexedAccess` in the tsconfig, `noExplicitAny` sits at the parser's edges where the
input's shape belongs to Anthropic, `noControlCharactersInRegex` fires on the regexes that strip
ANSI escapes. `useOptionalChain` is off for a subtler reason: `a && a.b` is not `a?.b` when the
result is used as a value, so those 25 rewrites carry a real trap for a stylistic gain. A rule
turned off without its reason is one the next reader cannot re-evaluate.

What the linter did find was small and real, and is fixed here: four unused imports, a variable
written three times and never read, a function nothing called, and seven `let`s with an implicit
`any` that now name their type. The mass reformat is its own commit and is listed in
`.git-blame-ignore-revs`, so `git blame` keeps pointing at whoever wrote a line.

### 2026-07-31 — `src/` is three layers and now says so: core/, server/, client/

**The rule existed; the folders did not.** `client/` and `core/` were directories, while the
server's own modules and the shared ones sat flat in the root of `src/` together — `types.ts` next
to `watcher.ts`, `roster.ts` next to `discovery.ts`. So the one sentence worth enforcing, *core is
pure and the client may not reach the machine*, could only be written as a list of filenames, and
a list is what nobody updates.

Every module now lives in the layer it belongs to. `core/` is pure derivation — no `node:`
builtin, nothing from `server/` or `client/` — and gained the four shared modules that were loose
in the root (`types.ts`, `text.ts`, `roster.ts`, `context-windows.ts`). `server/` holds everything
that touches the machine, including `config.ts` and `tls.ts`, which were in `core/` while opening
files and sockets. `client/` is unchanged.

The split is by what a module **is**, not by who calls it: `core/span-store.ts` is reached only
from the client today and stays in `core/` because it is pure. That distinction is what keeps the
layer meaningful — sorting by caller would empty it out one file at a time.

The rule is now a test about directories rather than a habit: `core/` may import neither a node
builtin nor anything from the other two layers, checked through the import graph so an indirect
import three hops down fails too. Verified in both directions — made to fail by adding one
`node:fs` import to `core/text.ts`, which reported the whole chain from the client entry down.

Nothing changed but locations: the rebuilt browser bundle differs from the previous one by exactly
four lines, and all four are the path comments the bundler writes above a module.

### 2026-07-31 — Every push and pull request is checked, and the anti-leak gate finally reaches forks

**The repo asked contributors to keep the type-checker green and had no way to notice that it wasn't.**
`tsc --noEmit` was failing on `main` — one bad cast in the client's EventSource wrapper — while
every local test run reported 1040 passing tests, because the tests do not type-check and nothing
ran the type-checker automatically. The only workflow in the repo fired on a version tag. So the
rules lived in `CONTRIBUTING.md` and the enforcement lived nowhere.

`ci.yml` now runs on every push and pull request, in two jobs that are kept apart on purpose: a
leak and a broken test mean different things, and one must not hide the other. The checking job
runs the suite, the type-checker, and a rebuild of the committed client bundle that fails if those
bytes have drifted from their source. The scanning job re-reads the added lines for real home
paths, personal addresses, secret markers and private tracker references — until now that check
existed only as a local git hook, which a fork cannot inherit, since `.git/` is not tracked. It
blocks rather than warns: a leak committed once stays in the history forever.

Two things the same change closes. The client boundary is now a test rather than a habit: no
module reachable from the browser entry may import a `node:` builtin, followed through the import
graph so an indirect import three hops down fails too. That gap was real and invisible — importing
the session-discovery module into the client compiled cleanly, because `bun build --target
browser` answers a node builtin with a polyfill that throws rather than with an error, so the
mistake would have surfaced as a blank page. And the scan has its own tests, in both directions,
including one that feeds the script its own source: the patterns are written so the gate cannot
trip over the file that implements it, and that property is now asserted rather than remembered.

The tray's Rust tests are deliberately not in CI yet: building the Tauri crate on a Linux runner
needs system webkit packages, and a pipeline that is red for its own dependencies teaches people
to ignore red. `bun run test:tray` stays a local step on macOS.

`bun run test` replaces a bare `bun test` everywhere in the docs — the runner skips
dot-directories when it scans for test files, so `bun test` alone never sees the checks under
`.github/scripts/`.

### 2026-07-30 — The tray's rows say what a session is doing, the window fits them, and both apps name their build

**A row said the project and a bare percentage, which answered nothing worth opening the panel for.**
It now carries the same six-part shape whether the session is working or idle — identity, model and
effort, the agent's own words, what ran, which agents, how full — so a session does not change form
under the eye when it stops; what differs is which parts have anything to say. Three measurements
decided the contents rather than taste: a settled turn's `activity` is null in 12 real sessions out of
13 (a turn's last word IS its answer, so nothing happened *since*), which is why "where it stopped" is
`result` and not a summary; "live activities" cannot mean "calls running now", because Claude Code
writes a call's line ~3.6 s after it starts and nothing qualifies 78.6% of the time, so the rows
itemise the turn's LAST calls and age the oldest open one; and `effort` is now on 97–99% of assistant
lines, so it is worth a chip. The digest carries all of it (`GET /api/digest`), which no polled client
could see before. **The idle rule locked earlier — *duration only, not where it stopped* — is
revoked**, on the maintainer's own decision after using it.

**The popover is as tall as what it shows.** A fixed 560 pt left the connect screen (about 200 pt of
content) sitting in 360 pt of void. The webview measures its natural height by freeing the height for
one synchronous block — a flex column otherwise only ever measures the window — and Rust clamps that
to the screen. The clamp is a pure function with its own tests because neither failure mode is
visible from a shell: too tall and the list's bottom is unreachable (a popover cannot be dragged),
zero and it is unclickable. `min` then `max`, never `clamp`, whose inverted range panics — and a tray
that panics disappears.

**Both apps now say which build they are.** The portal's Settings gained an About row carrying the
version the RUNNING server reports (`version` on `GET /api/config`), never the number the bundle was
built from — a stale `build:client` would otherwise make the page claim a version the server is not.
The tray's settings gained the same section, saying `seedeep tray <version>` and that the server has
one of its own: two downloads that can be updated apart, so a bare number would be quoted in a bug
report as the wrong app's. One source for both — the repo's `package.json`, imported by the server
(`src/version.ts`, inlined by `bun build --compile`) and resolved for the tray by
`tauri.conf.json > version`, so one tag cannot produce two numbers.

### 2026-07-30 — The tray's URL field could not be typed into, and the popover was a rectangle

**A remote server could not be entered at all.** The panel repaints on every tick — once a second
while it is open — and for any status but `connected` that meant `replaceChildren`, i.e. a brand-new
`<input>`. Anything typed was gone within a second of typing it, which reads exactly as "it resets at
every character". The settings view had been guarded against this same hazard by name; the guard was
never applied to the screen that owns the only field that matters.

The fix is one rule rather than a second special case: **a tick carrying an unchanged status does not
touch the DOM** (`ui/surface.ts`). Every surface except the bands IS its status, so redrawing one
when nothing changed can only destroy state. `put` draws unconditionally and forgets the key, which
is load-bearing — "Connecting…" is drawn unkeyed, and without forgetting, a connect that failed back
to the same status would be skipped and leave the panel on "Connecting…" for good.

**The popover is rounded.** A hard rectangle under the menu bar reads as a window that lost its
frame. 12 px, clipped so the footer's rule and the bands' rows cannot square the corners back, over a
`transparent` window — which on macOS costs the `macos-private-api` feature and, with it, any
possibility of App Store distribution. seedeep ships a DMG, so that is a price and not a loss.

**The Gatekeeper dialog was finally seen**, on a double-click: *"Apple could not verify
"seedeep.app" is free of malware…"*. It was nearly written down as absent — the same quarantined app,
launched from a shell over SSH, ran translocated with no prompt. A shell over SSH cannot answer a
question about a GUI decision.

### 2026-07-30 — A tag makes the tray installable

**`.github/workflows/release.yml` is the repo's first CI**, and it builds what a user downloads: one
**universal** `.dmg` for macOS (Apple Silicon and Intel in the same file — 6.4 MB for a 15 MB app,
and `lipo` confirms both slices) and an **NSIS `-setup.exe`** for Windows, whose default `currentUser`
install mode asks for no Administrator rights. Windows is why this is CI rather than a script on a
laptop: Tauri documents one runner per platform and no macOS → Windows cross-compilation.

**A tag is the only thing that publishes, and it publishes a DRAFT.** Pushing `v*` builds both
platforms into a draft release for a person to publish; a manual run builds the same artifacts and
leaves them on the workflow run, because with neither a tag nor a release id `tauri-action` skips
every upload. So the pipeline can be proven without cutting a release — the one step here that
cannot be taken back. The version stays the single field in `package.json`: it produced
`seedeep_0.1.0_universal.dmg` without anything else being edited.

**One defect caught before the first run.** `tauri-action` defaults
`TAURI_BUNDLER_DMG_IGNORE_CI` to `"true"`, which makes the bundler run the Finder-prettifying
AppleScript even under CI — the step that failed when this DMG was first built locally, that needs
an automatable Finder, and that applies a window layout this app does not configure. The workflow
sets it to `'false'`, and the same build then succeeded.

**Proven by a build-only run**, not by reading the YAML: both artifacts were downloaded and
identified — a `PE32 … Nullsoft Installer self-extracting archive` (4.2 MB) and a DMG that mounts to
`seedeep.app` beside the `Applications` symlink, universal per `lipo`, reporting `0.1.0`. The run
published nothing, which is the build-only path working: no tag, no release id, no upload.

**What the unsigned warnings are, and what they are not.** Measured on macOS 26.5.2: `spctl` answers
`rejected — source=no usable signature`, and Apple's `syspolicy_check distribution` calls the bundle
*not signed at all* and *adhoc signed … not suitable for distribution*. The first-launch DIALOG is
NOT measured — twice, once with a fresh code identity so nothing could be cached, a quarantined copy
launched translocated with no prompt, but the only launch path available was `open` over SSH, which
is not a gesture a user performs. So the README states Apple's documented path for macOS Tahoe 26
(System Settings → Privacy & Security → Security → *Open Anyway*) as quoted, not as observed, and
`docs/tray.md` records the difference. Nothing about Windows is measured at all.

### 2026-07-30 — The tray says it out loud, and can be told not to

**A session stopping on you now sends an OS notification**, and it is the only thing the tray
interrupts for — not a turn completing, not a subagent finishing, not an error. It fires on the
TRANSITION: `Watch` in `poll.rs` remembers which sessions were stopped on the human last time it could
see, so a session already waiting when the tray connects is a SEED and not an event (otherwise every
restart would replay every open prompt as if it had just happened), and a stretch the tray could not
read re-seeds rather than announcing late. The set is per session, not a count, because one prompt
answered and another raised in the same interval is exactly the moment worth an interruption. The
words are the panel's and the portal's, deliberately.

**Verified from the bundled `.app`, not from a dev run** — which the tray's own docs say is the only
way this feature can be confirmed: a stub digest flipped from `busy` to `waiting` produced exactly one
record in Notification Center's own store, with the title and body sent, across five consecutive
waiting readings. Repeated with the toggle off: no record.

**The settings view** (`ui/settings.ts`) is the tray's fourth surface and the first that is not a
session: the server and its pinned certificate whole, the one field that points the tray elsewhere,
the notification toggle, and a test notification. A view inside the popover rather than a window,
because the popover dismisses on focus loss and a second window would either inherit that rule and
vanish while being used or break it. A tick deliberately does NOT redraw it — re-rendering once a
second would wipe a half-typed URL out of the field — and a status that stops being connected takes
the panel back to the screen that can fix it. **Closing the popover also leaves it behind**: *while
nobody is looking the panel is a mirror* covers which surface is up, not only the rows, or a settings
screen left open yesterday would be what the next click on the icon shows.

The toggle silences the banner, not the bookkeeping (turning it back on must not then announce
everything that was already waiting) and not the icon, which is peripheral information a user who
silenced an interruption did not ask to lose. It is stored in `settings.json` beside
`connection.json`, through one shared private atomic write (`src/store.rs`).

**Why there is a test button rather than a status line:** the notification plugin's
`permission_state()` is a hardcoded `Granted` on desktop and `show()` returns `Ok(())` even when
nothing is delivered, so nothing can be ASKED about whether notifications arrive. The only honest
surfacing of that is a banner the user looks for, and the receipt says *Sent*, never *delivered*.

Also corrected: two comments in `poll.rs` and `connection.ts` still asserted that a hidden popover's
webview does not load, which the previous entry's measurement had already withdrawn.

### 2026-07-30 — Review pass on the bands: an ended row outliving the panel, and a panic that would have taken the icon with it

Three fixes from reviewing the diff that had just been pushed.

**A session that ended was kept for the next person to open the popover.** The rule is "stays while
the panel is OPEN", and the panel decided that from a `blur` event — which was wrong the moment the
same review measured that a hidden window's webview keeps running: rows went on being marked `ended`
behind a closed panel and nothing cleared them. The flag now rides on every reading as `open`, from
Rust, which is the side that knows (it is the same flag that sets the cadence). While nobody is
looking the panel is a mirror: retention and stable order both start fresh from the server's list,
and the rule became a function of the reading (`fold`) instead of an event whose delivery nothing had
verified.

**`state::<Arc<Poller>>()` panics when the type is not managed yet**, and window events are not
ordered after `setup` — a focus change delivered to the popover before the poll is registered would
have taken the app down, which for a tray means the icon disappearing: the one thing this client must
never do. Now `try_state`; a cadence that stays put for one tick is not worth a crash.

Also: the portal's deep link reads the roster it already had rather than asking for it again.

### 2026-07-30 — The tray shows the three bands, and its icon stops guessing

The popover has contents. `apps/tray/ui/bands.ts` renders one `/api/digest` payload as three bands
whose density follows urgency — *Needs you* prints the request verbatim and how long it has been
stopped, *Working* gets an activity line, a subagent count and the context fill, *Idle* collapses to
a pill. No cap: every live session is drawn and the list scrolls. Rows keep the order they were
first seen in, because the digest's order is the roster's and a list that reshuffles makes a click
land on the wrong session. A session that ends while the panel is open stays, marked, until it
closes — the server drops it immediately, and the client is the side that knows somebody is looking.

**The clock moved to Rust** (`apps/tray/src-tauri/src/poll.rs`): 1 s while the panel is open, 5 s
while it is closed, measured at 1.00 s / 5.00 s against a logging server. It had to live there
rather than in the panel because the menu-bar icon has to be right *before* anyone opens the panel —
and the icon is now driven by that same reading, so `SEEDEEP_TRAY_STATE` (which forced a state) is
gone. One reading feeds both, so the rows and the icon cannot disagree.

Every read after the first is a **conditional GET**, so an unchanged digest costs a 304 and no body;
the discovery's own request stays unconditional, because it has to see a digest to know it is
talking to a seedeep. A 304 with nothing cached is reported as unreadable rather than as an empty
digest — "nothing is running" is a claim about the machine.

**The portal gained one URL parameter**, `?session=<id>`, so a click in the tray lands on the session
it names instead of on whichever tab was last active — right by luck with one live session, a coin
toss with five, which is the case the tray exists for. It is applied after the saved workspace and
after the auto-open rule, and it activates; the parameter is then stripped, so a reload does not yank
the tab back to where one click sent it. An id no session answers to opens nothing.

**A correction to the previous entry.** `SEEDEEP_TRAY_SHOW_PANEL` was justified partly by "macOS does
not load a hidden window's webview". Re-measured: it does. With the window never shown, the popover's
webview ran `panel.ts` and called the `tick` command, which nothing else can call. The flag stays —
looking at the panel still needs a click no test can perform — with the false half of its reason
removed.

### 2026-07-30 — The tray reaches a server, over a certificate it pins

The tray stopped being a shell with an empty popover: it now finds a seedeep, pins its
certificate, remembers it, and refuses a certificate that changed. The data layer is Rust
(`apps/tray/src-tauri/src/{client,pin,connection}.rs`) because a webview `fetch` cannot pin at
all — its only knob is "accept invalid certificates", which would void the reason the server has
TLS. `tauri-plugin-http` is therefore not a dependency; the tray declares `reqwest` + `rustls`
itself.

**One premise of the design was false, and measuring it is what corrected it.** "Loopback carries
no auth and no TLS by design" holds only while the server IS in loopback mode: the server decides
TLS and the token check from the configured host, never from the peer, so with remote access on a
request from `127.0.0.1` gets both. A seedeep on your own machine therefore configures like a
remote one. The tray now proves which case it is in — after the plaintext probe fails it tries
HTTPS on loopback, and seedeep's own `401 {"error":"unauthorized"}` says a seedeep is there — so
the panel names what it found instead of implying there is nothing to connect to. Verified against
a real remote-mode server.

Pinning accepts one leaf SHA-256 and checks nothing else — no chain (nobody vouches for a
self-signed certificate), no hostname (a pinned leaf already settled identity, and the check would
refuse the aliases a user reaches their own machine by), no expiry (an outage one day, with no
security gain, since the identity is the key and not the date). A refusal is decided on the two
values rather than on rustls' error text, and both are handed to the panel: a legitimately replaced
certificate is recoverable in one confirmation, never a silent re-pin and never a dead end.

The connection lives in ONE file, `<app config dir>/connection.json`, mode 0600, Rust-only. Its
mode is set at creation and the file is renamed into place, so the token never exists
world-readable and a crash leaves the previous pin intact. No keychain: the fingerprint needs
integrity (a file only the user can write), the token needs secrecy (0600) — and the server already
keeps the same token the same way.

A review pass on the diff produced four more fixes, the first of which was found by measuring
rather than reading. `short()` walked the error chain to its innermost cause, and reqwest's
innermost cause for a **connect timeout** is the phrase "deadline has elapsed" — so the panel
printed that for the single most likely remote failure there is, a machine that had gone to sleep.
The two cases that actually happen are now named, and the panel's own guess ("It is most likely not
running", right for a refusal and wrong for a silence) moved to Rust, which is the only side that
knows which of the two occurred: a guess belongs next to what it is a guess about. The other three:
each `save` gets its own temporary file (two racing on one name could interleave into a file that
was neither version), `WrongCertificate` carries BOTH fingerprints so the panel can never render an
empty one, and a long reason can no longer push the primary button out of a window nobody can
resize.

The same pass answered what the panel shows while it is looking, which used to be nothing at all —
the first open is the slow one, since the webview is not loaded until the popover is first shown and
a sleeping server takes seconds to fail. A waiting screen now covers every action the USER took and
deliberately not the automatic refresh, so a screen that already says something true never blinks.

Three `#[ignore]`d Cargo probes keep the claims re-runnable against a real server rather than
proven once in a scratchpad, including the one that makes the others mean anything: a pin that does
not match must refuse THIS server, and it does. Two smaller corrections came out of the same work —
the crate's declared `rust-version` was 1.77.2 while the locked graph has always needed 1.89
(derived now, not remembered), and `apps/tray/tests/` was added to the typecheck.

### 2026-07-30 — The certificate now certifies the name seedeep hands you

Remote mode issued a certificate **for** a hostname it did not certify. `tls.commonName` went
only into `openssl`'s `-subj /CN=`, and browsers have ignored the CN since Chrome 58 — so the
access URL the Settings panel computes and copies was one no TLS stack can validate by name.
Measured with the server's own certificate as the CA: `localhost` and `127.0.0.1` answered 200,
the configured `<host>.local` failed, and the machine's real LAN address failed too.

**Why it survived this long is the transferable part: a self-signed certificate hides its own
name mismatch.** The user is already clicking through a trust warning, so the name error lands
inside a warning they have accepted — and a permanent warning trains the click that TLS was
added to make unnecessary. The test suite could not see it either: every TLS test connected
with `rejectUnauthorized: false`, which is precisely the check that was broken.

Three changes. The SAN now carries the `commonName` — typed `IP:` or `DNS:` by what it actually
is, since `DNS:192.168.1.9` is valid syntax that matches nothing. It carries **every**
non-internal IPv4 address instead of the first one, which on a real Mac was Tailscale's `utun0`
ahead of `en1`: the certificate covered an address its owner never connects on and omitted the
one they do. And a stored pair that does not certify the current name is **replaced** rather
than reused, because a corrected SAN is otherwise inert for everyone who already has a
certificate.

The name is the only trigger for replacement, never the address set — those change whenever a
VPN comes up, and a pin that fires with the weather is no pin. Keying on the name also leaves a
user-supplied certificate for their own domain alone. A replacement does invalidate a pin
already taken; that is a pin working, so `startServer` reports `tlsCertOrigin` and the CLI says
it in words immediately before printing the new fingerprint.

**`tls.commonName` is now validated**, because it is interpolated into openssl's
`subjectAltName=` list where a comma starts another entry — a name carrying one quietly produced
a certificate covering something else. No shell is involved and the blast radius was the user's
own certificate, but a silent surprise is worse than a refusal. The predicate
(`core/cert-name.ts`) is import-free and shared with the browser: a panel that accepts what the
server refuses is worse than no check. An IPv6 literal is refused as a stated limit — its colons
cannot be told from the SAN's own separator without a full parser.

Surrounding whitespace is **refused rather than trimmed**, and the reason is a defect the review
caught before it shipped: openssl trims it while writing the SAN, so a padded name produced a
certificate for the *trimmed* name while the coverage check asked about the *padded* one — the
certificate was judged not to cover its own name and regenerated on **every start**, with a new
fingerprint each time, breaking any pin every time. One normalisation fewer is one divergence
fewer. The regression test is the invariant rather than the case: whatever `isValidCertName`
accepts, the certificate generated for it must come back `reused`. Its candidate list includes
shapes the predicate refuses and skips them, so the day one is accepted the test exercises it —
naming the padded case alone would not have caught the same shape in case-folding.

**And the Settings panel gained the two warnings it was missing.** The audit asked whether the
panel needs descriptions; it does not — the banner, the placeholders and the field sub-labels
already say what everything means. What it lacked was *consequence*: the two actions that break a
client on another machine said nothing about it. Changing a Common name that already produced a
certificate now warns that the certificate and its fingerprint will be replaced, and a
regenerated token warns that saving it locks out every other client. Both are conditional —
neither appears on first setup, where there is nothing to break. A warning that fires when it
does not apply is one the user learns to ignore before it ever matters.

Two defects surfaced while wiring that up. `POST /api/config` returning a 400 was parsed as a
config and announced as **"Saved"** — the panel said the opposite of what happened. And
`resolveFormState`/`buildSaveBody` were exported and unit-tested but never called by the panel,
which re-derived both inline: tests that passed while the real code did something else. The panel
now calls them, so those tests describe the shipped behaviour.

### 2026-07-30 — The tray icon fills the menu bar, because looking at it showed it did not

Seen on a real menu bar for the first time, the mark was visibly lighter than every icon beside
it. The cause is a platform fact the square buffer ignored: **macOS scales the tray image to 18
points TALL whatever it contains**, so the buffer's height is the mark's whole size budget. An
eye 1.7× wider than tall, framed in a square, filled 55% of that height — drawn at about 10 pt
in an 18 pt slot. The buffer is now 36×26, cropped to the band the ink occupies, and the eye
fills 73% with its geometry untouched.

Two knock-on decisions. The slash on the unreachable state is kept inside the eye's own vertical
extent, because a slash running past it made the band taller and so made the eye smaller. And
the badge moved from a corner of its own to just above the eye's upper-right, clear of the
outline: **the eye no longer changes size when the badge appears.** A mark that resizes as it
changes meaning reads as a glitch, and a test now asserts the eye's height is identical across
all five states — it fails on the previous geometry, which is the only reason to trust it.

### 2026-07-29 — A second app: the menu-bar tray exists, and unsigned notifications are answered

`apps/tray/` is the repo's second deliverable — a Tauri v2 menu-bar app that is a **pure HTTP
client** of `/api/digest` and links no seedeep code. This is the shell only: the app runs, owns
its icon, opens its popover and can notify. The HTTP client and the panel's contents are not
built. `docs/tray.md` is the reference and is born with it.

**The question this had to answer first: can an unsigned build notify at all?** Notifications
are a locked feature and there is no Apple Developer account, so the answer decides whether the
feature survives. Measured on macOS 26.5.2 by sending one notification each way and asking
Notification Center what it received, rather than trusting the API:

- an **unbundled** binary — what `tauri dev` runs — returns `Ok(())` and delivers **nothing**:
  the app is never registered and no record exists;
- the **bundled, unsigned `.app`** delivers: registered, with the exact title and body stored.

So unsigned is not the obstacle on macOS; being unbundled is. Signing and notarization buy a
clean install past Gatekeeper, not a working notification. And `Ok(())` is not evidence — it is
returned in the case where nothing arrives, which means notifications can never be verified
from a dev run. Windows already had the matching rule from Tauri's own docs (installed apps
only), so on **both** platforms the feature only works from the packaged artifact.

Three other decisions the code now carries. **The icon is drawn, not shipped as image files**:
exported assets would be one file per state per size that no test can say anything about,
whereas one geometry lets the states be asserted — every state paints something, no two render
identically, the badge does not count. The states differ by **shape** as well as colour, so they
survive a colour-blind user. **The badge says THAT more than one session is waiting, not how
many** — a numeral was built first and dropped on the render: at 18 pt a digit is three pixels
wide, a `3` comes out a smudge, and giving it room means shrinking the eye until the primary
signal suffers. The count is one click away in the panel. And **one version for both
deliverables is now enforced, not promised**: `tauri.conf.json` names the root `package.json`
as its version instead of carrying one, verified by building with the two deliberately
different.

### 2026-07-29 — The digest says how long a session has been quiet, and names what it is blocked on

Two fields a status client cannot do without, and could not derive: **`lastActivity`** (the
transcript's last write) and **`pendingTool`**. A quiet session has no activity phrase and no
running call — `lastActivity` is the only thing it has to show. And a blocked one could until now
only report that it was blocked: Claude Code's own label is `waitingFor: 'permission prompt'`, which
never names the tool.

The name comes from the transcript, where the `tool_use` line is written BEFORE the dialog is
raised. The reducer now exposes `snapshot().openCall` — the newest MAIN-session call with no result
yet, subagent calls excluded — and the digest joins it with the roster's `waitingFor`, so
`pendingTool` is non-null only while the session is really blocked. Outside a block the same call is
ordinary work that `turn.activity` already reports; null too when the wait has no call behind it (a
plan approval), where naming the last unrelated tool would be worse than naming none.

The browser keeps its own feed-based `pendingTool()` in `client/graph.ts` for now: unifying the two
would change what its NOW panel says in the cases where the feed is capped, and that is a visible
change, not a refactor.

### 2026-07-29 — A launch with nothing behind it stops claiming to be an agent at work

**The defect:** `running` means "launched, and no terminal signal has arrived". On a session that
has ENDED the view already reads that as `unknown`; on a LIVE one nothing did, so a subagent whose
end was never announced stayed "running" for as long as the session stayed open — counted, listed
and ageing. It was about to become a number a status row prints as fact.

**Measured before deciding anything.** Replaying 910 ended sessions through the real reducer: 3 of
1327 subagents (0.2%) end up in that state, not the ~4.5% three comments claimed — a figure written
eleven days before the end-routing rework, on a corpus half of which Claude Code has since deleted.
More useful than the rate is what the three cases ARE: no type, no tokens, no tool, no returned
text — launches with nothing behind them, not agents whose ending was lost, which is what 92.8% of
the ones that do end look like (they carry their own final text).

**The rule is a fact, not a timeout.** An agent that has given no sign of itself — `hasStarted` in
`core/graph-derive.ts`, one shared definition read by both the Graph and `/api/digest` — reads
`unknown` instead of `running`. It does not claim the agent finished; it declines to claim it ever
started. Nothing in it measures duration, which the card ruled out: a legitimate `Explore` can run
for minutes and a timeout would delete true state to hide missing state. Like the workflow-silence
rule beside it, it is DERIVED and never latched — one line from the agent and it is `running`
again, so a false unknown heals itself.

**Why it cannot brand a young agent.** Measured over 1171 real spawns, a subagent's first trace
lands 0.07s after its launch (p90 0.08s, max 0.30s, 100% under a second), so with a 300ms watcher
tick nothing real can sit traceless for more than about half a second. A Workflow run is exempt —
its own node carries no type or tools by construction, and the silence threshold judges it instead.

### 2026-07-29 — The watcher stops scanning the whole corpus to learn nothing

**Idle cost: 13.6% of one core → 0.38%**, measured at the real 300 ms cadence with 911 sessions
on disk. A tick ran the complete discovery and only then filtered for live sessions, so every
user paid a full corpus scan 3.3 times a second for the entire time seedeep was open — on a
laptop, battery spent on a set that was usually empty.

**The gate is unchanged.** `isLive` is still `isOpen ?? isActive`, which means that whenever the
open-session mechanism answers at all, the live set is exactly the sessions holding a live
process file — `isActive` is unreachable and the mtime window decides nothing. A tick now reads
`~/.claude/sessions/` and looks each id up in a `sessionId → path` index; a full discovery runs
only to place an id never seen before. Reference:
[`architecture.md`](./architecture.md#how-it-finds-the-live-set-without-scanning-the-corpus).

**Two states would have brought the cost back, and are handled.** An open window nobody has
typed into has a process file but no transcript, so no scan can place it — and that is the idle
case itself; a failed placement is not retried for a second. And when `~/.claude/sessions/` is
absent (an undocumented Claude Code internal a release may drop), the mtime window is the only
answer there is and the watcher degrades to what it did before rather than going blind.

### 2026-07-29 — The certificate fingerprint becomes a value you can actually read

**A pinnable certificate needs a readable fingerprint.** seedeep computed one, then printed it
once — on the single run that generated `~/.seedeep/cert.pem` — and stayed silent ever after. A
user wiring up a non-browser client a week later had nothing to compare against, which makes
trust-on-first-use unverifiable in practice: the client pins whatever it is handed and nobody can
tell. It is now obtainable in three places: **stdout on every start** in remote mode, the
**Settings panel** (TLS Certificate → Fingerprint, with Copy), and **`GET /api/config`** as
`tls.fingerprint`. Reference:
[`architecture.md`](./architecture.md#the-fingerprint-and-why-it-is-exposed-three-ways).

**The endpoint is a convenience, not a channel of trust.** A fingerprint fetched over the very
connection being verified proves nothing on its own — it saves the client from asking a user to
type 95 characters, and the Settings panel is what makes the value checkable out of band. It is
safe to expose unauthenticated because the certificate is already presented in the clear on every
handshake.

**It is runtime state, never config.** The field describes the certificate this process is
presenting: absent in loopback mode (nothing to pin), never written to `config.json`, and
unchanged by a Save — a new certificate requires a restart. `certFingerprint` now hashes the
**leaf only**, so a chain PEM yields the certificate a client actually verifies rather than a
digest of concatenated blocks that nothing can match.

### 2026-07-29 — `GET /api/digest`: live derived state for a client that does not own the reducer

**seedeep stops being a page host with a raw event stream.** `/api/stream` and `/api/replay`
carry parsed lines; anything that wants to know what a session is *doing* had to rebuild the
reducer to find out. The digest serves the cooked answer instead: one entry per live session,
carrying identity, liveness, context fill, token totals, the current turn's activity phrase and
the count of running subagents. `?sessionId=` adds that session's running-subagent list, for the
one a user opened. Reference:
[`architecture.md`](./architecture.md#live-digest--get-apidigest).

**An entry is a JOIN, not a second derivation.** The liveness fields are the roster record's,
everything else is read off the live tree — one source per fact, so nothing can be computed one
way for a thin client and another way for the browser. `/api/live` is untouched and stays the
browser's; the browser does not switch, because it re-derives per interaction and moving that
server-side would turn instant interactions into round-trips.

**The server now holds live trees.** One per live session, seeded from the file and advanced by
the watcher, built only when a consumer asks and dropped the moment the session stops being live
— no timer, no tombstone, nothing outliving the fact it describes. The contract is an equality:
a tree advanced live equals the tree the same session produces when replayed whole.

**No cap, on anything** — not on sessions, not on subagents. A Workflow run's still-running
members are counted and listed individually: the run takes one row in the browser because
expanding ~100 children would flood a list, but a count is not a list, and answering "16 agents
are working" with `1` would be false.

### 2026-07-29 — Repo layout: every deliverable is an app under `apps/`

**The server moved to `apps/server/`** — `src/`, `public/`, `tests/`, `probe/`, `data/` and
`scripts/` with it, as one subtree. Nothing else changed: no behaviour, no dependency, no
public path. A second deliverable now arrives as a peer of the server rather than as an
appendage beside its source tree, which is what a `tray/` next to `src/` would have implied.

**Commands are unchanged and still run from the repo root** (`bun test`, `bun run start`,
`bun run build:client`, `bun run typecheck`): one `package.json`, one version for the whole
repo, and its scripts know where each app lives. Only four script paths and the `tsconfig`
includes moved with the tree — no path is hardcoded in the TypeScript, and the server keeps
resolving `public/` from its own `import.meta.url`.

**The proof that the move is pure**: rebuilding the client bundle after the relocation
produces a file differing from the previous one on **35 lines, all of them `// src/…` banner
comments — zero added, zero removed, zero changed code**. The 915-test suite and the
type-checker agree.

Layout and rationale: [`architecture.md`](./architecture.md#repository-layout).

### 2026-07-29 — Session search (full-text over the dialogue) + copyable session id

**A new pinned tab: Search.** Type the words you remember, get the sessions whose dialogue holds
**all** of them, open one in a tab or copy its full id for `claude --resume`. Rules:
[`search.md`](./search.md).

**What is indexed is the dialogue** — your prompts (a slash command contributes its ARGUMENTS,
never its `<command-name>` wrapper) and Claude's text blocks — never the raw transcript. Measured
over 988 real sessions: searching the raw jsonl matches roughly twice as often and wrongly
(`subagent` 706 vs 350, `compaction` 282 vs 124), the surplus being injected instructions, system
reminders and tool results. Extraction runs through the real parser (`userLineIntent`), which also
keeps 453 `<task-notification>`s and 63 compaction preambles out — and loses no human prompt.

**Ordered by density, not by occurrences.** Ordering by raw occurrence count ranks session LENGTH:
on one real query the top row by occurrences was a 369k-character session at 0.42 hits per 1k,
while the session actually about it (9k chars, 2.60 per 1k) sat fifth. Each order sorts by the
number the row prints; `occurrences` and `recent` remain one click away.

**Automated runs are kept aside, never dropped.** The same `isAutomated` split the picker uses, with
a `+ N automated runs — show` control that states its own count. `span-store + lane + subagent`
matched 104 sessions, 91 of them automated docs-gate runs: the split is a stronger precision lever
than a third search term. No top-N cut anywhere.

**The index is its own file** — `~/.seedeep/search-index.jsonl`, incremental on `(size, mtime)`,
atomic, refreshed on demand — deliberately NOT a field on `aggregates.json`, which is rewritten
whole on every retrospective refresh and would carry 20 MB of prose it never reads. 19.5 MB of
dialogue over 988 sessions, ~0.8 s to build cold, 17–40 ms per query; scanning transcripts per
query instead costs a 2.0 s floor even when nothing matches.

**Ordering states itself.** The score box prints the quantity the list is actually sorted by —
`per 1k`, `times`, or the session's age under `last run` — from one table that holds the comparator
and the readout together, so a key cannot be added with one and not the other. The density
denominator counts the dialogue itself, not the separators the matcher joins utterances with: those
inflated the shortest sessions by up to 12.5% (measured over 895 sessions), which is exactly where
density decides.

**The session id is now copyable, and readable.** A shared chip (`id-chip.ts`) copies the FULL uuid
on click, in the Search row and in the picker row, where the id had been dead text. The Search row
DISPLAYS the whole uuid — the id you paste into `claude --resume` is worth reading without clicking
first — while the narrower picker row keeps the 8-character prefix. A refused copy leaves the chip
unchanged rather than claiming one.

### 2026-07-28 — Replay backpressure + config persistence fixes

**Replay backpressure.** `streamReplay` is now an `AsyncGenerator`; the
`/api/replay` `ReadableStream` uses `pull()` instead of `start()`. The parent transcript is read
lazily line by line via `readLinesLazy` (`node:readline` + `createReadStream`), so the full file is
never held in memory. The consumer controls the pace: the server reads the next line only when the
client has room for another SSE frame. `gen.return()` in `cancel()` closes the readline interface
immediately when the browser drops the connection.

**Config file no longer corrupted by tests.** `POST /api/config` called `writeConfig(currentConfig)`
without a path, which always wrote to `~/.seedeep/config.json` — including from tests. Three tests in
`server.test.ts` used `config: { ...defaultConfig(), auth: { token: '' } }` with no path isolation;
each test run overwrote the real config with `host: "127.0.0.1", open: false, token: ""`. Fixed by
adding `configPath?: string` to `ServerDeps`; the handler now passes it to `writeConfig`, and the
affected tests inject a temp path.

**Token persists when config file exists but carried no token.** `resolveConfig` guarded the
`writeConfig` call with `if (absent)` — it only wrote the generated token when the file was absent
(ENOENT). If the file existed with `token: ""` (as written by the test bug above), the token was
regenerated on every restart and never saved. Guard changed to `if (absent || !fileConfig.auth.token)`.

### 2026-07-28 — Remote access: loopback by default, Bearer auth and TLS beyond it

**The bind is now explicit.** `Bun.serve` was called without `hostname`, which makes Bun listen on
every interface — the socket was on `*` while `server.hostname` reported `"localhost"`. The server
now passes `hostname: host`, resolved from `--host` / `SEEDEEP_HOST` / `~/.seedeep/config.json` with
a built-in default of `127.0.0.1`. Nothing leaves the machine unless the user asks for it.

**One switch decides the whole security posture.** `127.0.0.1`, `::1` and `localhost` are loopback:
plain HTTP, no auth, as before. Any other host (including `0.0.0.0`) is remote mode: HTTPS is
mandatory and every `/api/*` route requires `Authorization: Bearer <token>`, the sole exception
being `GET /api/config`, which serves the config with the token redacted so a client can bootstrap.
Static files stay unauthenticated — they carry no session data. Wrong or missing token → 401.

**New config layer** (`src/core/config.ts`): `~/.seedeep/config.json`, owned by seedeep, optional,
with precedence CLI flag > env var > file > default. The token is 32 random bytes, base64url, and is
generated and written back on first run when absent or empty.

**TLS without a CA** (`src/core/tls.ts`): a self-signed RSA-2048 cert (10-year validity, SAN over
`localhost`, `127.0.0.1` and the current LAN IP) is generated once via `openssl req -x509` into
`~/.seedeep/cert.pem` / `key.pem` and reused afterwards. Its SHA-256 fingerprint is printed at
generation time so the certificate can be trusted out of band. `tls.commonName` is required in remote
mode and the server refuses to start without it; the display URL uses the CN rather than the bind
address, otherwise the browser sees a name mismatch on a cert that is in fact correct.

**Browser auth flow** (`src/client/auth.ts`): the startup URL carries `?token=`; `initAuth()` moves it
into `localStorage` and strips it from the address bar via `history.replaceState`, so it never reaches
history or a `Referer` header. `authFetch` adds the Bearer header to every API call; `AuthEventSource`
appends `?token=` instead, since EventSource cannot set headers — which is why the server accepts
both forms, header first.

**Settings panel** (`src/client/settings.ts`): port, host, open-on-start, token (displayed as `***`,
with Regen), the computed access URL with Copy, and the TLS common name in remote mode. `port` /
`host` / `tls` changes return `restart_required: true` and are applied through `POST /api/restart`;
a regenerated token is adopted live, with `setToken()` keeping `localStorage` in sync so the open
page keeps working.

**No tunnel ships with seedeep.** Off-LAN access is out of scope by design: use an SSH port-forward
(`ssh -L 44842:127.0.0.1:44842 user@host`, which keeps the server on loopback and makes the tunnel
the authentication) or an existing VPN.

### 2026-07-28 — Home: median turn on complete tokens; activity follows time filter

**Median turn KPI** (`RetroWindow.p50Complete` / `p95Complete`): the tile now shows the median of
`billable + cacheRead` per turn — the same "complete" scale as "tokens spent". The previous `p50`
/ `p95` (new-tokens only) are kept for the histogram markers, which bin by `t.billable` and must
stay aligned. Hint updated to `complete · p95 N`.

**Activity card** now respects the WINDOW filter. `7d` → 7 daily bars from the new `Retrospective.days`
array (index 0 = today, `Math.round` absorbs DST gaps, always 7 slots). `30d` → `weeks.slice(0, 5)`
calendar weeks. All-time → unchanged. Axis labels and legend hints follow the granularity
(`tokens / day` vs `tokens / week`). `weekChart` gains a `granularity: 'day' | 'week'` parameter
for bar tooltips.

### 2026-07-28 — Compare: which session weighed the most, in tokens weighted by model

A second pinned tab (`compare-view.ts`, `/api/compare`) ranks SESSIONS against each other over a
time window — the question Home raises but never answers, since the retrospective aggregates turns
across the corpus rather than comparing sessions.

The unit is a **weighted token count**, never a cost in dollars. Two factors, and the surface keeps
their provenance apart because it is not the same:

- **Per token type** — `cache read ×0.1 · cache write ×2 · input ×1 · output ×5` — is Anthropic's,
  published in tokens as the Priority Tier burndown rates and explicitly said to "reflect the
  relative pricing of each token type". The 1-hour cache-write rate (2.00), not the 5-minute one,
  because the cache lifetime is an hour on a subscription.
- **Per model** — Haiku ×1 · Sonnet ×2–3 · Opus ×5 · Fable ×10 — is **seedeep's own**, from the
  price list. Six Anthropic pages were read verbatim and none publishes a cross-model token ratio;
  the strongest official wording is qualitative ("Opus costs several times more per turn than
  Sonnet"). Structurally it cannot exist: Anthropic partitions budgets instead of converting models
  (a separate Opus limit; Priority Tier commitments per model version), so no surface needs the
  factor. An unknown model id weighs 0 rather than an invented ratio; a merely newer id falls back
  to its family, so a future `claude-opus-9-9` is not silently free.

Why the weighting is the feature and not a refinement, measured over 996 local sessions: the raw
token total is **97.3% cache_read**, so an unweighted ranking sorts by session *length*; and on
billable tokens the weighted order and the unweighted one share only **5 of the top 10** (14 of 20),
with one session moving 48 places. 13.5% of sessions run more than one model, so the weight is
applied **per call** — inside the reducer's existing per-`callId` guard, since Claude Code repeats a
call's usage block on every content-block line.

**The corpus aggregate now reads subagent transcripts.** It read the parent file only, leaving
**35.3%** of the corpus's billable tokens out of every per-session figure (p90 24.4% of one session,
max 91.9%). It now goes through `streamReplay`, the same event stream the live watcher produces, so
the cache and the GUI cannot diverge; invalidation stamps the children too (`subagent-files.ts`),
because a child can be written when the parent is not. Where those files live is now defined once
and read by both replay and the cache. Cold rebuild of 1054 sessions: 2.4s, warm 47ms. Cache
version → 11 (it moved four times as the per-session facts grew: `weighted*`, then
`tokensComplete`, then `mainModel`, then a whole-session `apiCalls`).

**A session's weight is whole-session, not Σ its turns**: `turns` holds only closed work turns, and
summing them left 751 of 996 sessions weighing zero (an unclosed final turn, or an sdk session,
which never writes `turn_duration`). A session likewise enters a window by its **last activity, and
enters it whole** — filtering its turns would show half a session as if it were all of it.

A row's bar carries two facts: its LENGTH is the weight, its SEGMENTS are the model mix. A row is
**three STACKED lines** — the prompt, then every chip (project · main model · when it ran · calls ·
complete unweighted tokens, cache reads included · subagent share · `▲N vs unweighted`), then the bar
at full width with the weight at its right end. Each line is **clipped with an ellipsis, never
wrapped**, because a row that wraps is taller than its neighbours and an uneven leaderboard reads as
if the tall rows meant something.

Stacking ended a fight the column layout kept losing. With the bar beside the text, the prompt and
the chips shared half the row and the ratio between them was rebalanced three times — each new field
cost ~70px before it silently clipped the chips at the end while still looking tidy — and the split
of the chips onto two lines was itself a workaround for that competition. Stacked, the prompt and the
chips each get the whole row (~1190px at 1440 against ~650px), nothing clips down to 1100px, and the
bar loses nothing by being full width: its job is to be comparable, not short, and a small bar is
easier to read on a longer track — the lightest row of a twenty-row window went from a stub on a
421px track to a readable segment on a 1106px one. The three lines are spaced 10px apart, enough that
they read as one object without the row losing its boundary against its neighbours.

There is **no unit label** — no "opus-equivalent", which was built as a toggle and then removed: the
open question was which label to use, and the answer was that the label should not exist. A permanent
*how this is computed* block explains the number instead, with each per-model factor shown in the
colour it has in the bars. Twenty sessions per window, and what the cut leaves out is always stated.

Refined the same day, on request: **the model the main thread ran on** (dominant by weight, subagents excluded,
`+N` when it used more than one — which needed a main-only per-model split in the reducer, since the
session-level one folds the subagents in), the window opening on **`all`** rather than a 7-day slice,
more vertical room per row, the row **stacked into three lines** with the bar on its own,
**no KPI tiles** (the leaderboard is the surface;
the window's totals stay in the response, feeding the legend, the scope line and the remainder), and
**a row opens the session it describes** — through the picker's own code path, as a real
`role="button"` that answers Enter and Space as well as the mouse.

A code-review pass over the finished change then found four more, all of them the same shape as the
first — a whole-session figure derived from the closed turns, or a set derived from what happened to
be on disk:

- **`rawRank` was measured against the wrong baseline.** The unweighted rank came from the cache's
  turns-only `totalTokens`, so the `▲N vs unweighted` chip mixed three variables while claiming one:
  75.4% of compared sessions were tied at 0 there, and 42% of the rest disagreed with the figure
  printed on the row by more than 5%. It now ranks on `tokensComplete` — the number on screen — which
  also deleted the `rawOrder` parameter, the path→sessionId join in the endpoint, and a `?? 0`
  fallback that declared a missing session FIRST.
- **The row's call count had the same defect**: `Σ turns[].apiCalls` counts closed work turns, so
  125 of 240 measured sessions (52.1%) would have rendered "0 calls" beside a non-zero weight. It is
  now `snap.apiCalls`.
- **A Workflow run with only a journal disappeared from replay.** The refactor derived the run list
  from the agent transcripts inside each run dir, but a run writes its journal — the only record that
  a workflow subagent started or stopped — before those exist. An equivalence test over four real
  workflow sessions passed because none of them was in that state; a fixture found it at once.
- **`scopeToTurn` did not scope the new weight fields**, so a turn-scoped snapshot reported the
  session's weight next to the turn's input tokens. Fixing it surfaced a second defect: a Workflow
  row stands in for its ~100 members, so a total summed from the nodes missed their weight entirely
  (2 of 284 sessions, one off by 27.6%). The run aggregate now carries their weight, as it already
  carried their volume, and the node sum equals the accumulator sum again.

Two display rules were also settled with the maintainer rather than left as my own judgement, which is what
the project's rule about "X is not worth showing" requires: the **subagent share now has no
threshold** (a 5% cut hid it on a quarter of the rows, and it is a fact about the session, not a
judgement), while the **`▲N` chip keeps its 3-place cut** — now justified by measurement instead of
feel: in the only window where the cut decides anything, ±1 shifts are 11 of the 14 rows that would
carry a chip. The three lines of a row also gained breathing room between them.

Two bugs the process caught while building, worth recording:

- The row's whole **meta line was never appended** — project, calls, subagent share and the
  `▲N vs unweighted` chip, all silently missing. 796 tests were green and the live invariants
  passed; only looking at the rendered page found it. It is now covered by tests that go red when
  the append is removed.
- The first version of the child-invalidation test **passed with the fix removed**. It restored the
  parent's mtime with `utimesSync`, which truncates to whole milliseconds and so re-parsed for the
  wrong reason. The parent is now simply left untouched, and the test asserts that it looks
  unchanged before drawing any conclusion.

### 2026-07-27 — the NOW panel holds a word for as long as it takes to read

The narration hold stops being one number for every narration. It was a flat 12s; it is now
`narrationHoldMs(text)` — `chars / 17` per second, floored at 3s and capped by the two lines the
panel can actually show (`-webkit-line-clamp: 2`, measured against the real CSS: ~120 characters a
line, so 240 visible ≈ 14.1s, past which the rest is behind `more` and holding longer reveals
nothing).

Measured over 9020 real narrations, the flat constant was wrong in both directions: **60% are read
in less than 12s** — a median of 6.1s during which the panel sat on a finished line while tool
calls were already running underneath it, which is the "NOW is behind the console" complaint — and
the other 40% were cut off mid-sentence. The floor binds on 8.3%, the two-line cap on 34.4%. The
earlier "median 186 characters" behind the 12s was close but measured small; on 9020 narrations
across 400 sessions the median is 161.

The rule moved to `src/core/activity-line.ts` (pure, testable), and the hold still runs from the
word's FIRST SIGHTING rather than its timestamp — unchanged, and the reason is unchanged too.
Because a single render always sees a zero-second-old word, the two tests that tell the new rule
from the old one drive the panel's own 1s ticker with the clock moved on; both go red if the hold
becomes a constant again.

Also corrected here: the session log is appended **once per content block**, not once per API call
(one response becomes several lines sharing a `requestId`), and `usage` is the CALL's, repeated
verbatim on every line of it.

### 2026-07-27 — the verdict stops judging a turn by its size

The **token anomaly detector is removed**. It compared a turn's work tokens to the personal
baseline's p90/p95, and measuring it over 2860 real turns showed it reported SIZE, not waste:
flagged turns spent ~13× the tokens because they did ~13× the actions (median 38 tool calls
against 3), their tokens-per-tool-call was ordinary (3.6k against 2.3k, both below the corpus
p75), only 2 of 283 hits had made no tool call at all, and 55% of a turn's token variance is
explained by its API-call count alone. It was also the only detector with no anchor in the public
docs and the only one with no remedy to offer. It fired on 9.9% of turns and in 71% of those it
was the ONLY finding, so 202 turns were being flagged for having been big.

`computeVerdict`/`computeVerdicts` no longer take a baseline — no detector reads one. The
baseline itself SURVIVES as descriptive context (`bucketFor`, `/api/baseline`): the share card
still places a turn against the user's own p50/p90/p95, which is information rather than a verdict.

Two detectors replace it, each anchored to a NAMED failure pattern in
`code.claude.com/docs/en/best-practices`:

- **exploration** (warn) — "*The infinite exploration.* You ask Claude to 'investigate' something
  without scoping it. Claude reads hundreds of files, filling the context. **Fix**: … use
  subagents so the exploration doesn't consume your main context." Fires on ≥8 Reads with **zero
  edits and zero subagents**. The no-edit condition is the whole rule: without it the same
  threshold caught turns with a median of 20 edits — heavy implementation reported as aimless
  reading. Fires on 13 of 2872 real turns. `subs` comes from the snapshot's subagents, which the
  parent's spawn alone supplies, rather than from `TurnNode.agentIds` — that one needs the child
  transcripts replayed before it is complete.
- **unverified-ship** (crit) — "*The trust-then-verify gap.* … **Fix**: Always provide
  verification. If you can't verify it, don't ship it." Fires when real code was committed and no
  check ran **anywhere earlier in the session**. The window is the session, not the turn, and that
  is measured: a per-turn window flagged 14 of 206 real ship events, and all 14 had run a check in
  an earlier turn (6 in the immediately preceding one). Running the suite and committing next turn
  is correct practice.

**How a detector is now justified.** The fire-rate on one corpus is not evidence of usefulness —
it measures the user, not the rule. The public anchor establishes that the problem exists; the
corpus can only prove that a rule fires correctly and stays silent on correct behaviour. Both
anti-patterns occur ZERO times locally, so correctness is proven by synthetic golden transcripts
that CONTAIN the anti-pattern (`tests/golden-transcript.test.ts`), each verified to go red when
its rule is flipped off. Corpus-wide the verdict now reads 5.6% crit / 10.6% warn / 83.8% good
(was 9.1% / 13.7% / 77.2%).

**The cache's second implementation of the worst-of rule is gone.** `severityOf` existed because
the severity depended on the *global* baseline and would have gone stale whenever any file
changed; removing the anomaly made every detector file-local, so `TurnSummary` now STORES the
severity `computeVerdicts` already decided, and the windows just sum it. Aggregate cache version
→ 7: `TurnSummary` gains `exploration`, `unverifiedShip` and `severity`, so an older summary
would keep a crit the verdict no longer gives, miss the two new flags, and carry no severity.

**The cache no longer trusts the version number alone.** Reusing version 6 for two different
shapes let a stale summary pass the guard, and a live `/api/retro` returned 0 crit / 0 warn — a
corpus that reads as clean. A version bump is a promise someone has to remember; a shape check is
not. Every cached turn is now validated against `TURN_KEYS` on load and its file re-parsed if a
field is missing, and `TURN_KEYS` is itself compile-checked against `TurnSummary` (`satisfies`
plus a `never` assertion), so adding a field without listing it fails the build. Both halves are
proven by tests verified to go red when disabled. The Home's "where the waste comes from" card swaps its
`anomaly` bar for `committed without tests` and `explored, changed nothing`.

### 2026-07-27 — the derivation stack is core, not client

Ten modules moved from `src/client/` to `src/core/`: `session-tree`, `span-store`,
`verdict`, `trace-group`, `selectors`, `tree-format`, `feed`, `graph-derive`,
`activity-line`, `activity-list` — 2,994 lines that turn events into meaning.

The layout was already contradicted by the code. `aggregate-cache.ts` and
`baseline.ts` run in the server and import `./client/session-tree.ts` and
`./client/verdict.ts`, folding a tree per corpus file to build `/api/retro` and
`/api/baseline`. So the reducer had two callers and lived in a directory named after
one of them. Anything that wants to serve derived state — a second frontend, or the
server itself answering "what is this session doing now" — starts from a boundary
that says what each side actually is.

The rule the split encodes: a module belongs to `core/` if it **derives**, and to
`client/` if it paints, listens or remembers. Not "does it compile in a browser" —
by that test `end-guard.ts` and `event-types.ts` would have moved too, and neither
derives anything.

Also removed: `src/client/context-windows.ts`, a re-export seam that existed to keep
a flat `public/lib/` layout back when every client module was its own build entry.
Its own comment had recorded that it was redundant.

Pure relocation, verified as such: the rebuilt `public/lib/app.js` differs from the
committed one only in the `// src/…` path comments the bundler emits, and 769 tests
pass unchanged.

Four test files followed their subject out of `client/`: `client-session-tree`,
`client-selectors`, `client-tree-format` and `client-feed` drop the prefix. What still
carries it — `client-replay`, `client-stream`, `client-sessions`, `client-end-guard`,
`client-tab-store` — now really does test `src/client/`.

**`bun run typecheck` is clean again**, having carried six errors. `E()` in `graph.ts`
returned a widened `HTMLElement` for every tag, so `btn.disabled` did not exist on a
button it had just created; it is now generic over the tag name and returns the real
element type. The other five were fixtures that had stopped matching the reducer:
`AgentNode.volumeByModel`, the workflow row's `tokensByModel`/`members`, and
`TreeSnapshot.subagentTokensByModel` were all absent from stubs whose own comments claim
to be full nodes. Both fixture files are now typed against the reducer's interfaces, so
the next field the reducer gains breaks them instead of drifting past. No emitted change:
the rebuilt bundle is byte-identical.

### 2026-07-27 — one definition of "scratchpad"

The verdict decided whether a turn shipped code with its own word match over the tool argument
(`scratch|prototypes?|/tmp/`), while the Changed files widget asked `isScratchPath`. Two
definitions of one concept, and the looser one also caught project code merely NAMED like a
throwaway — `src/prototypes/…` is a real directory in a real repo, and excluding it withheld the
"ran a check before committing" positive from turns that had earned it.

The verdict now asks `isScratchPath`, and `SCRATCH_RE` is gone. This was filed as a product
decision — when a positive fires is what the user sees — and measurement is what demoted it to a
refactor: of 4743 real `Write`/`Edit` calls on code files the word match excluded 289 and the
token match 263; the 26 that stop being excluded are all `prototypes/` paths (the `scratch` and
`/tmp/` branches flip nothing, since after `anon` a real scratchpad path is always `~scratch/…`);
and re-running the real pipeline over all 34 sessions touching such a path produced the same 43
`verified` positives over 588 turns. Zero visible change.

The scratchpad fixture in `tests/verdict.test.ts` used `/tmp/scratchpad/proto.ts` — a shape the
live pipeline never emits, so it asserted nothing about a real path. It now uses the shape `anon`
produces.

### 2026-07-27 — Changed files counts the project, not the scratchpad

The Changed files card was reporting temporary files as work on the project. Claude Code gives
every session a scratchpad directory — its own system prompt has told it to write throwaway
scripts and prototypes there since 2.1.178 — and those writes enter the same file-history
ledger the card reads. Measured over the local corpus: **250 of 1015 deltas (24.6%) point at a
scratchpad**, in **68.4%** of the sessions that changed anything at all, a median **27%** of a
card and a maximum of **100%** — one session whose "files changed" were, every one of them,
temporaries.

- **The hero and the bars are the project; the scratchpad gets one row.** Not a second set of
  bars: the card is the narrowest column of the stats row and shares its height with its
  siblings, so bars there would come out of the project ones — and "how much of this was
  throwaway?" is a single number. The zero case is deliberately not the empty state: a session
  whose only changes were temporaries did change something, and "no file changes" would hide
  precisely what the split exists to show.
- **The drawer lists both, grouped, project first** — it is where *what did it write, and
  where* is the question being asked. The group headings appear only when there is something to
  separate.
- **One definition, next to the code that creates the token it matches.** `isScratchPath`
  (`src/text.ts`) tests the `~scratch` root that `anon` rewrites every scratchpad path to; the
  flag rides on `changedFiles`, derived from the path rather than stored on the reducer's nodes,
  which is what keeps the two from disagreeing. `anon` now folds the bare `/tmp/claude-<uid>`
  form as well as the `/private`-prefixed one macOS resolves — the same directory under two
  names, 1358 local occurrences using the short form, 9 of them as a delta's `trackingPath`
  (those files would have counted as project work). The Windows root is folded from its
  reported shape, unobserved here.

Verified on a real session: hero 37, scratchpad row 14, drawer 51 rows in two groups — matching
the distinct `trackingPath`s in that session's transcript.

### 2026-07-27 — a subagent's end belongs to the agent, not to its spawn

A subagent sat in the portal pulsing `running` for as long as the page stayed open, minutes
after it had finished and answered.

Its only terminal signal is a `queue-operation` line carrying a `<task-notification>`, and that
line names its subject twice: `<tool-use-id>` (the spawn) and `<task-id>` (the child's
agentId). seedeep treated the first as the KEY rather than as one of two names, dropping the
whole event when it was absent — so an agent with **no spawn at all** could never be told to
stop. A skill forked into the background is exactly that: no spawning tool call, no
`toolUseId` in its `meta.json`, its whole existence being its own transcript plus that one
line.

- **The parser reports the fact; the reducer decides what it attaches to.** `agent-end` is now
  gated on the presence of a `<status>` — what makes a notification terminal — and carries
  `toolUseId: string | null`. The 72 progress notifications in the local corpus (`event` +
  `summary`, no status) still produce nothing.
- **The reducer resolves in three steps**: the spawn, then `taskId → spawn`, then, naming no
  spawn it holds, the agentId itself. That last record is a MAP, not a flag on the agent:
  replay reads the parent file whole before any child, so the end routinely arrives before
  that agent exists. (Written as a flag first; the ordering test caught it.)
- **Safe by construction**: the map is keyed by id and read only with an agent's own id, so
  the 111 notifications naming a background shell task or a workflow run are never looked up.
  The `task-id` prefix taxonomy is exact on 862 real terminal notifications — `a…` an agent
  (751, all naming a child file), `b…` a shell task (109), `w…` a workflow run (2).

Measured through the real parser and reducer over every local session: of the 39 subagents
whose terminal notification carried no `tool-use-id`, **18 stayed `running` for good; now 0**
(36 done, 2 failed, 1 killed). A 25-case control sample whose notifications do carry one is
unchanged but for one more agent that now also resolves.

Why it had never been seen before: `displayState` renders a `running` subagent as `unknown`
once its session has ended, so the historic cases never looked live — and the forked-skill
shape, the only one with no spawn whatsoever, had never occurred on that machine before.

Not touched, and deliberately: `span-store.ts` hangs its lanes off spawns, so a subagent
without one is ABSENT from the Trace rather than stuck in it. That is a separate gap.

### 2026-07-27 — the live feed survives losing its connection

The portal froze at random: the page kept its pulsing `live` badge, the session went on
working, and only a hard browser refresh brought the data back — for a while, then again.
A new session's tab would open and stay empty, all zeros, until that same refresh.

The root cause was **not** the network. `seq` is a line's POSITION in its file, and both
client guards drop anything below their high-water. `Watcher.start` scheduled `tick()` on a
300ms `setInterval` with no in-flight guard, so a slow tick — the first one reads every live
file whole — was joined by the next: two passes read from the same offset and each advanced
`tracked.seq` over the same lines. Measured on a real instance: **seq 1585 for an 808-line
file**, every line emitted twice. After that the number is no longer a position, and once
anything restarts the watcher the re-delivery (numbered from zero again) can never climb back
over the mark. Measured on the page: **45 events received, 0 applied**, frozen at 208.5k while
a page loaded at the same instant showed 214.4k — with `readyState` OPEN and no error anywhere.

Fixed at the source and then made survivable at every layer it passed through:

- **`tick()` is re-entrant-safe.** A second pass returns immediately; nothing is consumed, so
  the next tick reads exactly what the skipped one would have. `seq` is the line index again
  (verified on a fresh instance: drift 0, where the same conditions used to give +777).
- **The stream has a heartbeat** (`: ping`, 15s). An idle SSE connection is indistinguishable
  from a dead one, and silence is the normal state of a session whose subagent is working.
- **A failed write closes the stream.** Evicting the client was half the job: the browser kept
  a connection nobody wrote to, `OPEN` and silent, and never reconnected.
- **The client owns its reconnect.** `EventSource` retries only while `CONNECTING`; a fatal
  error leaves it `CLOSED` forever. `stream.ts` rebuilds it, clears the per-connection
  high-water on every open, and reports `open`/`lost`.
- **A reconnect asks for the tail.** Nothing re-sends what was missed, so each live tab calls
  `resync()`: it knows its position in every file (`seq` IS the line index) and fetches
  `/api/replay?…&from=<key:seq,…>`, folding what it lacks into the reducer it already has.
  Rebuilding the tab from scratch was tried first and was also correct — but it re-drew the
  dashboard, and one measured environment interrupts the stream every 2-3 minutes, which
  turned a correct repair into a page that appeared to reload on its own. Ended tabs are
  untouched. A file with no mark still arrives whole, so a subagent born during the outage is
  complete; an unreadable mark replays everything, because withholding history on a guess is
  the failure being repaired.
- **The header says when the feed is broken** and nothing at all when it is not. A card's
  `live` badge answers "is the session running", which stayed true throughout — it was never
  a statement about the connection.

Two more silent deaths of the same family, found while tracing this one, are fixed with it:

- **A tab no longer ends on one reading.** `isOpen` comes from a PID file Claude Code rewrites
  on every status change, and `listOpenSessions` skips a file caught mid-rewrite — so a
  running session can be absent from exactly one poll. Ending a tab is one-way (it drops the
  live subscription and freezes the graph), and it was spent on that single blink: a healthy
  session frozen into history until the page was reloaded. It now waits for a second,
  independent reading a full poll later (`end-guard.ts`). Counting notifications could not
  work — `onChange` fires on identity CHANGE, so a session that really closed notifies once
  and never again; the confirmation re-reads `roster.current()`, which every poll refreshes.
  Cost: a genuinely closed session's tab goes quiet ~4s later than before.
- **The roster poll cannot be killed by a listener.** It re-armed with `refresh().then(arm)`,
  and only the two fetches were guarded — a throwing listener rejected the promise, `arm`
  never ran, and the poll was dead for the life of the page: no picker updates, no busy dot,
  no ended-detection, no auto-open. Listeners are now isolated from each other and from the
  poll's liveness, and the timer re-arms on both settlements.

A review of the repair, before it shipped, found the same class of defect inside it — a state
that once wrong never repaired itself, and said nothing:

- **A replay delivered only the FIRST event of each line.** The dedup measured every event
  against a high-water it had just advanced to that line, so `attribution`, `tool-start` and
  `tool-end` read as "already in". Measured on a real 1362-line session: **849 of 2221 events
  dropped, 38%** — invisible on a live session, where the live path carries them, and total on
  history. A replay is now measured against a SNAPSHOT of the position taken when it opened.
- **The resync asked from a line it might hold only in half.** Each of a line's events is its
  own SSE frame, so a connection can die between two. Asking past that line lost its tail for
  good; asking before it re-applied a head already counted, and `usage` is summed. The client
  now tracks how far INTO the frontier line it got (`liveSeen`), asks from the last complete
  line and skips what it already has.
- **A resync raised during a read was dropped.** That read had reached the file's end *before*
  the outage, and nothing re-armed the request. It is now deferred to the read's end — and
  cancelled by `stop()`, so a closed tab cannot resurrect its feed.
- **A resync withheld out-of-band events from a caller it knew.** A mark speaks for LINES only:
  a subagent's meta arrives in two independent halves and a workflow `result` is the only
  record that an agent stopped, so any of them falling inside the outage was lost for good — a
  subagent permanently unlinked from its spawn, or running forever. They are re-sent now (the
  reducer folds them idempotently); a run's membership and `started`, which are immutable and
  already held, are not.
- **The end-guard could confirm the reading it was checking.** A failed poll keeps the last
  good rows, so the confirmation could re-read the very snapshot that opened the window. It now
  requires `roster.readings()` to have moved, and re-arms when it has not.
- **An empty seq in `from=` was read as a mark of 0**, withholding a file's first line on the
  strength of an empty string. Marks are plain digits only.

### 2026-07-27 — the roster is split by how fast it changes

The whole roster was polled every 3s: **548 KB, 1086 records, of which one record's one field
had moved** (measured by diffing two consecutive polls). That is **1.46 Mbps per open portal**,
paid again by every client — a second browser window, a device on the LAN — and growing with
every session ever written, since the payload carries one record per file on disk.

It is now two endpoints, split by cadence, not by subject:

- `GET /api/sessions` — the **catalogue**: every session, only the fields that stop changing
  once its file exists. Fetched at boot and when a session is born; byte-stable in between,
  so an ETag revalidates it.
- `GET /api/live` — the **volatile half**: the running sessions in full, the catalogue size,
  and whether the PID mechanism answered. The only thing polled. **485 bytes** measured.

`src/roster.ts` owns `toCatalogue`/`liveOf`/`mergeRoster`; the client reassembles inside
`createRoster`, so the picker, the tab strip and the auto-open rule are untouched — they still
receive one plain roster. Measured on a real portal: the 3s poll went from 548 KB to 485 B,
and after boot the only repeated request is `/api/live`.

**The split must not transport what it can derive, nor freeze what keeps moving.** Two defects
the contract test caught before they shipped: `isActive` is a pure function of the mtime and
the 5-minute window, and rebuilding a row with it hardcoded to `false` claimed "nothing written
for five minutes" about a file touched a second ago — it is recomputed (the constant moved from
`roots.ts`, which reaches for `node:path`, to `types.ts`, which the browser can import). And the
catalogue's ORDER is a snapshot of `lastActivity`, so the merge re-sorts by it, or the picker
ranks a session that stopped yesterday above one busy right now.

`isOpen` stays a tri-state across the split: `null` means "`~/.claude/sessions/` was not there
to ask", and absence from the live payload is not permission to answer for it — so the payload
carries `pidVisible` once per poll rather than letting the merge flatten the null to `false`.

The contract is `mergeRoster(catalogue, live) === roster`, asserted in `tests/roster.test.ts`
against fixtures AND against the real roster of the machine running the tests; the fixtures had
to be rebuilt around a fixed `now`, because a record claiming a fresh write with a 1970 mtime is
a shape discovery cannot produce.

**A catalogue record taken while its session was live is PROVISIONAL, and a review pass found
the split trusting it.** `subject` is null until the head scan finds the first prompt, `model`
until the first API call reports one — and the catalogue is fetched exactly when a session is
born, which is precisely when neither has been written. Nothing about the count changes when
that session later ends (its file stays on disk), so the birth snapshot was served for as long
as the page stayed open: the picker row reverted from the prompt text to the bare session id,
and the model chip emptied, permanently. It also contradicted an invariant this codebase had
already written down — *"`subject` … changes exactly once (null → first prompt text) … and
after that it is immutable"* — by making it go null → text → null.

The catalogue is therefore refetched on either of two signals: the count moved, **or** a
provisional record stopped being live. The refetch is awaited before the merge, so the row is
never wrong even for one poll, and the client-side memory the first cut needed (a `lastLive`
map plus a `?? 0` fallback that dated an unknown session to 1970) is gone.

`createRoster` now assigns fresh rows on every poll and keys only the NOTIFICATION on identity.
The two had been keyed together, which is why a repaired record stayed invisible: `current()`
feeds `openFromDropdown`, so a row parked behind an unchanged key becomes a stale tab.

### 2026-07-27 — every buffered response is revalidated and compressed

`sendCacheable` (`src/server.ts`) now serves every JSON endpoint and every static file with a
strong ETag over the exact bytes and `cache-control: no-cache` — *revalidate every time*, not
*do not store* — so a reload costs one `304` instead of the 230 KB bundle, while a rebuilt
`public/lib/app.js` can never be served stale. Statics were `no-store`, which re-sent
everything on every load. Bodies of at least one MTU are gzipped (`vary: accept-encoding`);
the catalogue compresses 453 KB → 60 KB, and the live poll sits deliberately under the
threshold, where a gzip header and trailer would eat the saving. The SSE streams are excluded:
they are unbounded by nature. The tag names the REPRESENTATION — a compressed body carries a
`-gz` suffix — so a strong validator is never shared between two different sets of bytes;
`vary: accept-encoding` alone would rely on every cache in the path honouring it.

### 2026-07-27 — the stylesheet leaves index.html

The single 1112-line `<style>` block moved into `public/css/`, one file per sub-feature
(`tokens`, `chrome`, `home`, `layout`, `changed-files`, `live-monitor`, `now-panel`, `feed`,
`context-dial`, `session-cards`, `drawer`, `toasts`, `timeline`, `picker`, `trace`,
`utilities`), `<link>`ed from the page. Pure move: every rule and every comment is byte-identical,
and the page is now 36 lines.

**The load order IS the cascade, and one rule depends on it.** `.hidden{display:none}` beat the
equally-specific `.live`/`.endbadge` (`display:inline-flex`) only by sitting later in the block —
filed under `layout.css` it would have stopped hiding the live/ended badge, silently. It lives in
`utilities.css`, loaded last, and the split was verified by rebuilding the rule multiset (857 units,
identical), then by replaying every multi-class literal the client writes (`class="endbadge hidden"`
and 133 others) to prove no declaration changed winner. That check was flipped off against a
`.hidden`-in-`layout.css` build first, and went red — a check that passes both ways is decoration.

`tests/trace-css-scope.test.ts` now reads `public/css/*.css` by directory listing rather than
parsing a `<style>` block, so a file added later cannot fall outside the scoping guard.

### 2026-07-27 — the Trace stops undoing what the user just did (review pass)

Six defects found reviewing the previous seven commits, five of them by driving the real
renderer in a browser rather than by reading it.

- **A sparkline bin's bands were not its proportions.** The error band's weight was
  subtracted from every type in turn instead of once — after the first band was pushed,
  the code re-read it as the error band. A gradient holds its last colour past its last
  stop, so the composition did not merely close early (77.8% for three types): the LAST
  type silently absorbed the remainder. Three equal types drew 33 / 22 / 44. Confirmed on a
  real session's first bin (`t-tool t-prompt t-api`, closing at 77.8%). The composition is
  now a pure function whose weights are asserted to total 1.
- **The failure jump released nothing and survived nothing.** Auto-follow stayed engaged,
  so ~1s later the next live event scrolled the failure off screen — measured: `scrollTop`
  0 → 454, marker gone. Jumping is navigation, as deliberate as a scroll, so it now
  releases follow; and the marker became controller STATE (`_hitSpanId`), re-derived by
  every path that redraws a block, instead of a class written once onto a node the next
  rebuild destroys.
- **A failure inside a `Workflow` lane was counted and unreachable.** A Workflow unfolds a
  grid of agent tiles, not a strip of blocks, so no block could carry that span: the badge
  counted it and the click did nothing at all. The tile now stands for its lane's spans and
  takes the marker.
- **An open strip lost its horizontal scroll on every live event.** The stage's `scrollTop`
  was restored, but each turn's strip is a separate scroller and was not — measured 8,974px
  of strip against 1,288px visible, so a reader was thrown back seven screens once a second.
- **A jump into one lane of a merged parallel block** unfolded that lane alone, leaving it
  under a block still reading `▸ expand flow` whose next click opened the run instead of
  closing it. A merged run is one block on screen, so it opens as one.
- **`_failCursor` outlived its session.** `open()` reset the expanded turns, lanes and pins
  but not the failure cursor, so the first badge click after a re-open started mid-cycle.

Guard widened with the same pass: `trace-css-scope` missed `classList?.add('hit')` (the
regex demanded `classList.`) and could not see classes built by concatenation (`'t-' +
type`), so it now also asserts that no global rule falls inside a runtime-built family.

### 2026-07-26 — each Trace control names its object, and a user's scroll is always heard

Asking what `follow` did and how `Compact` differed from `Collapse all` surfaced three
problems, one of them a real bug.

- **`Collapse all` → `Close turns`.** Every open turn already carries `expand`/`collapse`
  for its GROUPS: the same verb at two levels named two different objects. `Compact`, the
  only control whose name does not say what it acts on, now says it in a `title` — it
  redraws the blocks smaller and touches no turn, while `Close turns` shuts turns and
  touches no block. All three carry a `title`.
- **`follow` is hidden unless the session is working.** Auto-follow acts only through
  `update()`, which a finished session never calls — so there the button did nothing but
  jump to the last turn, which is `Last turn`'s job (and it also opens it). A control
  doing another control's job is worse than an absent one.
- **A user's scroll was being swallowed as the controller's own.** The guard was a boolean
  cleared on the next frame; on a busy live session `focusLastTurn` runs on every event, so
  the flag was up whenever the user happened to scroll. Their scroll did not release
  auto-follow, and the next event yanked them back to the bottom — precisely when following
  matters. The guard now compares POSITION: the controller records the `scrollTop` it set
  (read back, so the browser's clamping is included) and the listener ignores only an event
  landing within 2px of it. Verified with a real wheel gesture in a browser.

### 2026-07-26 — no successful step wears the colour of failure, and the row stops lying

Two colour defects, both reported from a screenshot and both confirmed by measurement.

**`--sp-tool` was 22° of hue from `--sp-error`.** The most frequent category in the whole
view — every tool call — was almost the colour of a failure. It is now `#99db76` (hue 99),
**108°** from the error and 56° from its nearest neighbour, which is the furthest a free
hue can sit from every other token. Every successful category is now at least 52° away,
and the frequent ones at least 96°. `--sp-api` and `--sp-spawn` stay 14° apart on purpose:
a spawn block is a different shape and the two never appear as adjacent bare dots.

**A sparkline bin now stacks its types instead of picking a winner.** On a real 179-step
turn the row was a wall of one colour: a majority vote gave api 30 bins out of 30 — every
round is one api plus its tools, so api tied or won nearly all of them — and the first fix,
ranking tool above api, simply turned the same wall green. One colour per bin cannot
describe a mixture. Each bin is now a proportional stack (89 api + 88 tool reads as
interleaved bands), so the collapsed row and the expanded strip finally say the same thing.
A failing bin's red band never scales below a third of the bin: one bad step among six must
still be visible.

### 2026-07-26 — the Trace's two end blocks open the turn's own text

The first block (the prompt) and the last (`done`) are the conversation itself, and they
were the only two blocks in the Trace where a click did nothing — so the initial prompt and
the final answer were the two things the view could not show. Both now carry a `turn-text`
handle and open the shared output drawer through `openBlock`, like any tool or API call.

The handle carries only `{turnIndex, which}`: the text lives on the reducer's `TurnNode`
(`prompt`, `result`) and the router reads it there at click time, so the span store keeps
no second copy of it.

A mid-turn `reply` stays inert. The reducer stores a turn's result as "last wins", so an
earlier answer's text no longer exists — opening it would show a later answer than the block
claims. Showing the wrong text is worse than showing none, so that one block keeps
`cursor:default` and no hover.

Turn rows also gained vertical padding (8px → 12px, idle rows 3px → 6px).

### 2026-07-26 — the failure badge takes you to the failures

The badge counted failed steps and then left the user to find them. Measured on a real
turn with 3 failures among 143 steps: reaching them by hand took **7 clicks** (open the
turn, then chapter → round, once per failure), and the `expand` alternative produced a
**33,048px strip — 22 screens** with the failures at x=1,860 / 8,322 / 30,098. A count the
user wants to click and cannot is a dead end, and it was one this branch introduced.

The badge is now a button. Clicking it resolves the failure's path through the group tree
(`groupPathToSpan`), writes it into `pinnedGroups` BEFORE the rebuild — that set is what
survives one — unfolds the child lane when the failure lives inside a subagent, rebuilds,
then scrolls the block into view and marks it. Repeated clicks cycle the turn's failures
and wrap around. Failures inside subagent lanes, the hardest to find by hand, are reached
the same way.

### 2026-07-26 — the Trace row says what it means

Follow-up on the row's own legibility, all four points reported from a screenshot.

- **`failed` → `N failed steps`.** A bare "failed" was read as *this turn failed*, when
  the turn carried on and n of its steps did not. The count is computed across the main
  strip and every child lane, and the badge's `title` states it outright.
- **The duration bar explains itself.** It had no axis, no label and no legend, so it now
  carries a `title` ("18m 14s — 24% of the longest turn in this session (76m 4s)"), and it
  is **neutral in colour**: the red tint repeated a signal the left rule, the badge and the
  sparkline already carry, and only asked "why is this bar red?".
- **The bars line up.** The duration number sits in a fixed-width cell — sized to its text
  ("60s" vs "76m 4s") every bar slid with it. Two defects were behind the same symptom: the
  variable cell, and `.hd` carrying `width:100%` with 28px of padding and no
  `box-sizing:border-box`, which made an OPEN row's header 28px wider than its own row and
  pushed every right-hand column with it. Only the second was visible in the browser; a
  fake-dom test computes no layout and asserted the alignment vacuously, so that assertion
  was removed rather than left as decoration.
- **`FINAL RESULT` has room above it** (`margin-top`, not `padding-top` — the padding moved
  the text inside an unchanged box).

### 2026-07-26 — the Trace row shows a turn's shape; parallel spawns are one block

Three changes on top of the document spine, plus the CSS collision behind them.

**A collapsed row carries a sparkline, not per-type counts.** `82 api  99 tool` says how
much a turn did and never what it looked like: a long tool burst and alternating api/tool
cycles read identically. The turn's steps are now binned in order into at most 30 slots,
each coloured by its dominant type (a spawn always wins its bin) with any bin holding a
failure in red; the total stays as a number. The cap matters — a turn is p50 11 steps but
p99 220, so one mark per step would make the bar unbounded.

**Spawns adjacent in the strip render as ONE block.** Eight `Finder` blocks in a row with
arrows between them asserted a sequence that never happened. Adjacency is the criterion
and it is the structural one: over 30 real sessions, 92 of 93 adjacent spawn pairs (98.9%)
have overlapping execution windows, while 45 pairs overlap WITHOUT being adjacent —
separate launches with work between them, which must not merge. Time is unusable: adjacent
spawns are written p50 4.4s apart (p90 11.3s, max 23s), because a `tool_use` line lands
only when the streaming response reaches it. The merged block aggregates like a fan-out and
carries one rule per subagent, so it still shows how many ran and which failed; one click
opens every lane of the run, each named by its launch intent.

**The tail marker was deforming its own block.** It carried the class `live`, which is also
the Live-activity badge's UNSCOPED global class — `display:inline-flex`,
`text-transform:uppercase`, `letter-spacing`. On every live turn the newest block's label
was uppercased and pushed 11px out of its box. Renamed to `tail`.
`tests/trace-css-scope.test.ts` now reads the stylesheet and the renderer as text and fails
on any Trace class a single-class global rule also targets — a fake-dom test cannot see
this, because it does no layout.

Also: the expanded body's vertical rhythm is symmetric (it opened 4px under the header and
closed 26px later), and the group controls read `expand` / `collapse` — the "all" was
redundant inside a single turn.

### 2026-07-26 — the Trace spine is a document, not a canvas

The Trace laid its turns out on a free 2D canvas navigated by drag-pan and wheel-zoom.
Measured against real sessions, the canvas took away more than it gave: the wheel was
bound to zoom, so a two-finger trackpad scroll zoomed (scale 1 → 1.12) and a horizontal
swipe zoomed *out* (`deltaY === 0` fell through to the shrink branch); there was no
scrollbar and no keyboard (`PageDown`/`Home`/`End` were dead) against a collapsed spine
measuring p50 2,244px, p90 7,132px and max 16,700px in a ~950px stage; `Fit` answered at
scale 0.54 on a 14-turn session and would reach ~0.13 at p90. All it bought was placing
a turn's strip to the RIGHT of its header, which then forced the connector to the next
turn into a ~1,400px diagonal across the canvas.

Each strip now renders BELOW its header, so the next row is always at x=0. That removes
the inter-turn edges by construction and lets the stage be an ordinary `overflow-y:auto`
container — scrollbar, wheel, keyboard and browser find, all native. The measured-arrow
layer (`.trace-edges`), the transform/pan/zoom state and the resize listener are gone;
`anchorLanes()` remains, and the strip and its lanes now share ONE horizontal scroller so
a lane cannot drift off its spawn. Zoom and `Fit` are replaced by **Compact**,
**Collapse all** and **Last turn**.

The turn row was rebuilt around that width, and carries what it never did:

- **A collapsed turn declares its failures.** `hasError` now walks the main spans AND
  every child lane, so a failure living only inside a subagent reaches the shut row —
  16.3% of 1,209 measured turns hold one, and 39 of 40 sessions do.
- **The left rule is the turn's state**, not a golden-ratio hue per index. That hue said
  nothing `T7` did not already say and landed on the error colour twice per cycle
  (`hsl(0)` and `hsl(348)` against `--sp-error` at `hsl(351)`).
- **Duration is a bar**: per turn against the longest turn, per block against the widest
  block in its strip. Every block used to be the same width whether it took 96ms or 5m.
- **The subject is the first turn that did work.** `turns[0].title` named 88% of sessions
  (53 of 60) after a control command, so the header read `/clear`.
- **A control command that ran nothing is one dim line** (7.9% of turns). A `work` turn
  with no calls was interrupted with Esc and keeps a full row.
- A live turn must also hold work: a finished session still reports `state === 'live'` on
  every turn it never closed (16 of 144 in one session), all of them empty.
- `--sp-api` moves from `#fb923c` to `#60a5fa` — 13° of hue from `--sp-result` made the
  two most frequent categories indistinguishable as 7px chips. The token is Trace-only.
- Step blocks get `cursor:pointer` and a hover (they open a drawer but showed the stage's
  `grab`), empty sub-lines and `· 0ms` on prompt/result are dropped, an api block no
  longer repeats its turn's title, and counts read `1 step`, not `1 steps`.

### 2026-07-26 — one view per tab: the second-view placeholder is gone

A tab carried a two-button toggle whose other half mounted a dashed "coming soon" box: a
WebGL view of the context window, planned as a second rendering of the same feed. It is
dropped, not deferred, for two reasons. Its own premise had no data behind it — it was to
colour the window by CONTENT type (system / conversation / tools / skills), but the jsonl
carries per-CALL totals split by CACHE provenance (`input` / `cache_read` /
`cache_creation`), and `regions` holds skill and MCP **names** with no sizes: the areas
would have had to be invented. And what it existed for — a screenshot worth sharing — is
covered by the verdict share card, which states a conclusion instead of re-rendering a bar.

The toggle, the placeholder and its CSS are removed, and with them `session-state.ts`: a
second flat reducer that every event of every open session was fed through, alongside the
session-tree reducer, to keep a stub in sync. `createView(container, treeState, opts)` now
takes one reducer, builds the Graph eagerly behind the loading skeleton, and holds no mode.
Net: −1 source file, −1 test file, one reducer per tab instead of two.

The NOW panel quoted the agent's latest narration and nothing else, so it went stale rather than
silent. Measured across 932 real working turns: only 0.2% never narrate, but a narration stands
unchanged for a median of **24s** (p90 100s) while a median of 8 tool calls run under it — and in
one real turn the panel stated the same superseded intent for **22 minutes** across 31 calls
(`Bash ×17`, `Write ×6`, `WebFetch ×5`, …). The panel was answering "what did it last say", while
the question is "what is it doing".

It now also carries an **activity group**: one line counting the turn's calls since its last
word — `Ran 17 shell commands, wrote 6 files, fetched 5 pages…` — in seedeep's own quote-less
voice. The individual calls are unchanged and stay in the feed below; the line only summarises
them, past tense, naming at most three tool families (only 1.7% of real groups touch more, and the
ellipsis keeps those short). Any word from the agent (a new narration, or the turn's `end_turn`
answer) empties the group and hands the panel back to its voice, so a finished turn still reads its
output.

The age chip times the **running call**, not the group: the oldest one open for at least a second,
and nothing at all when none is — which is 78.6% of a group's life, so most of the time the panel
is the count alone. Together those two choices put "something is still going, and for how long"
entirely in the chip rather than in the text.

The handover waits 12s (`NARRATION_HOLDS_MS`). The first cut of this handed the panel to the group
on the very next call, which made narrations unreadable: measured, a narration is the newest event
for a median of **2.6s** (42.9% under two seconds) while its text is a median **186 characters** —
about ten seconds of reading. The hold covers that and the p90 of the natural window (11.6s), so
the agent's words keep their moment and the group still owns the silence that follows (median 24s
of it). The hold is counted from when the word became VISIBLE, not from its timestamp: Claude Code
stamps a text block when it starts generating and flushes the line only once the whole message is
written, 7-9s later, so counting from the stamp left a narration 3 seconds of its 12 (seen live,
not in a test). A word first seen more than a minute after its stamp gets no hold at all — opening
seedeep on a session that has been silent for five minutes must show what is happening, not replay
an old line as news.

The deadline is nobody's event, so the panel arms one entry on the shared 1s ticker that re-runs
its own decision. That makes NOW the one surface rendering outside `render()`, which is what clears
the live counters — so its counters are tagged `owner: 'now'` and reclaimed on each pass. Review
caught the first cut of that: without the reclaim the list grew by one or two entries per second
between events (~840 across a 7-minute command), every one re-written on every tick. A call earns a present-tense tail (`· running 1 shell command…`) only
after a full second open, since 85% of real calls finish sooner; the shared 1s ticker re-renders
the line so that second arrives on time even when no new event does.

The group is **derived** from the tool ledger rather than accumulated, so a re-sent line cannot
double-count, and subagent calls — which carry no `turnIndex` — stay in their own lane. Since
`snapshot()` runs on every event, it is memoised per turn and recomputed only when one of that
turn's calls started or ended or the turn spoke: walking the whole ledger each time cost +35% on
the replay of the largest real session (3898 ms vs 2892 ms), memoised it is 2864 ms. The golden
transcript therefore also asks for the group after EVERY event — a cache cannot be proven by a
single snapshot at the end (verified by breaking the invalidation and watching that test go red).
One more thing the tests could not see: a group with many tool families overflows the panel's
two-line clamp, and the deferred measure re-adds `clamped` after render, revealing a `more` button
whose handler had been left a no-op; it now opens the line in full, the tail being precisely what
the clamp cuts. Words live in `src/client/activity-line.ts`, pure and unit
tested: explicit plurals, MCP tools summed per server, deterministic order. Verified live against
a real working session (the panel read `Ran 4 shell commands, edited 2 files, wrote 1 file ·
running 1 shell command…` while the log held exactly 4 Bash calls since the last narration).

### 2026-07-26 — `Expand all` shows the activities, and only those

The Live activity card draws one row per API call and one per tool start, main thread or
subagent — nothing else. Its `Expand all` was built from a different source (the span store,
so nothing is lost to the ring's cap) but with no shared definition of what counts, and the
store also holds each turn's `prompt` and its `result`. The list therefore showed rows the
card cannot have: a `done`, and the prompt of the turn just typed — activity that never
happened, in a list titled by what did.

- **One definition, `ACTIVITY_TYPES` in `activity-list.ts`** — `api`, `tool`, `subspan`,
  `spawn`, the span types the card's two `feed.push` sites emit. The store keeps `prompt`
  and `result`; the Trace, which draws the turn itself, still shows them.
- **The `Elapsed` KPI stops counting thinking time.** It is measured first row → last row,
  so with the next turn's prompt as the last row it read the gap between two prompts: on the
  reported session, ~35m of "elapsed" over ~7m of work.
- Turn boundaries are no longer implied by a prompt row in the session-wide scope, and no
  separator replaces them — a deliberate call, not an omission.

### 2026-07-25 — A session is live because its process is, not because its file moved

A session waiting on a **background subagent** writes nothing to its own jsonl — the child does,
to a separate file. seedeep read liveness from the parent's mtime, so after five minutes such a
session was declared idle by two independent places, and both were wrong: the picker filed it
under **Inactive** while its own tab still said LIVE, and the watcher's tick — gated on the same
`isActive` — **dropped the whole session, children included**. The live feed froze for as long as
the subagent worked, then caught up in a burst, which is exactly the opposite of live. Measured
on the local corpus: 21% of the sessions that spawn subagents hit that window, 6102 child lines
(9.2%) landed inside one, worst case 33 minutes of silent feed.

- **One definition of live, `isLive()` in `types.ts`** — `isOpen ?? isActive` — now used by the
  watcher's gate and the picker's grouping alike. It already existed, on the client only; the
  server answered the same question its own way.
- **`isOpen` is tri-state (`boolean | null`).** `listOpenSessions` returns `null`, not `[]`, when
  `~/.claude/sessions/` does not exist: "nothing is open" and "there is no way to ask" are
  different facts, and only the second one may hand the answer to the mtime window. Collapsed
  into `false`, the documented fallback was unreachable — and a Claude Code release dropping that
  undocumented dir would have left the watcher tailing **nothing at all**.
- **Consequence, by design:** a session whose process has exited leaves the **Live** group at
  once instead of lingering for up to five minutes. Liveness is the process; recency is the
  timestamp already on the row.

Verified live end-to-end on a synthetic open-but-cold session: with the fix, a line appended to
the child file reached `/api/stream` in ~1s (`usage` + `tool-start`, tagged `agentId`) while the
parent stayed 21 minutes cold; with the old gate restored, the same append produced **zero**
events. In a real browser, that session groups under **Live** and a fresh-but-closed one under
**Inactive**.

### 2026-07-25 — The verdict row is the unit: it scopes, and it shares itself

Share existed only in the scope banner, so the turn you were READING in the Verdict list and the
turn the card was built for could be two different turns: a row expanded on its own (`toggle
('open')`) without moving the scope. Reaching the button at all took five steps, and in
whole-session scope it was not on screen anywhere.

- **Every row carries its own `⇪ Share`**, bound to that row's turn. Both surfaces now build the
  card through one `shareButton(turn, snapshot, label)`, so the card can never describe a turn
  other than the one clicked. The banner keeps its button — the scoped turn is not always one you
  reached from the list.
- **A row IS the scope.** Clicking one selects that turn (banner, chart and every widget follow)
  and expands it; one row is open at a time, and clicking the scoped row again leaves the scope.
  This replaces the independent open/closed toggle, which is what allowed the list and the banner
  to disagree.

**Fixed — a clean row no longer reads as a broken filter.** Three things made five rows saying
`clean` unreadable: they carried the **crit** left stripe (only `.warn` overrode it, so `good`
was painted as the thing it is not); the headline was the word `clean`, which states nothing
even when the turn has a practice to show; and nothing said why a chip counting 2 sits above 8
rows. Now the stripe and the severity label follow the row's own tier, a clean row leads with the
practice it followed (or `nothing flagged`), and the list states what it holds — *"Every work
turn, judged: 2 flagged · 6 clean."* The `nothing flagged` placeholder also stopped wrapping one
word per line: its text was set on `.wfind` itself, landing in the 12px dot column.

**Expanding a row now reveals something.** With the practice moved into the headline, the body was
echoing the sentence above it — on a clean turn with one practice, and on every `nothing flagged`
row. The body holds only what the head does not already say; the lead finding reappears solely to
state its `cost`. A row with nothing left has no body and no chevron, and still scopes on click
(the chevron column keeps its width, so the rows stay aligned).

**Fixed — the share card is legible where it is actually read.** Three things stacked against its
text. It was rendered at one image pixel per CSS pixel (`deviceScaleFactor` defaults to 1), so
every surface that resamples it softened the type; it is now rendered at `CARD_DPR` = 2 (a
2400×1256 PNG of the same 1200×628 layout). Its smallest labels were also its lowest-contrast
ones — `#61748f` on `#05070c` is 4.2:1, under the 4.5:1 floor — and the type scale bottomed out
at 10px; nothing is below 12px now, and the greys moved to 7.8:1. And the preview box capped at
720px displayed the 1200px card at 57%, shrinking every label below the size it was designed for;
it now goes up to 1100px. Verified at the worst content case (three findings, full stat strip):
no overflow, no clipped cell.

### 2026-07-27 — Every detector now cites a public source, and the verdict has two faces

The verdict was re-derived from the Claude Code documentation index rather than from intuition:
a rule defensible only by one user's private CLAUDE.md is a rule written for one user. Each
detector in `src/client/verdict.ts` now carries the quote that justifies it, and applying that
metre changed what the tool says. Measured over 2798 closed work turns / 232 sessions.

**Removed — `reread`.** Same-file re-reads (≥3× in a turn) had no public anchor and 97.5%
measured false positives: the tool argument is only the `file_path`, so N paginated reads of
distinct sections of one long file are indistinguishable from going in circles. It was 202 turns
of `crit`.

**Fixed — a lone Esc is no longer waste.** The guide prescribes it ("course-correct early and
often"); the named anti-pattern is the streak ("after two failed corrections, `/clear`"). Only
the **second consecutive** interruption is a finding, and the rule looks only backward, so a
finding never appears retroactively on a turn already rendered. 127 of 176 interrupted turns are
lone — the old rule penalised correct usage on 72% of its own hits. Flagged interruptions: 176 → 29.

**New — `context`.** A turn ending with the window ≥70% full is `warn` ("the context window is
the most important resource to manage… performance degrades as it fills"). Skipped entirely when
the model is not in `data/context-windows.json`: a fallback denominator once printed "170% full"
on a session running at 1M. 162 turns (5.8%); 20 excluded as unmeasurable.

**New — `unverified-ship` is now visible from its positive side**, and `compaction` states its
cost: its own rebuild in the cost, and the one the next turn pays named in the text — median
49 577 + 28 121 against 119 on an ordinary turn. That tail is 2.2% of the corpus's billable
tokens and was previously attributed to nobody. It is reported, not subtracted from the next
turn's work.

**New — the second face.** Alongside findings, a turn now lists the documented practices it
followed: ran a check before committing (6.4%), delegated the exploration to a subagent (11.1%),
had its work reviewed by one (5.4%). Positives never change a severity.

**Surface — the Waste lens became the Verdict lens.** It lists one row per work turn, not only
the flagged ones; the chip's number still counts what to act on.

**Home** — the waste card swaps its `re-read` row for `context ≥70%`, counts *flagged*
interruptions rather than all of them, and states how many sessions spent **10% or more** of
their tokens re-entering themselves (59 of 232) — 10% being the share Claude Code's own `/usage`
flags at, not a number seedeep chose.

**Fixed — the share card stopped attributing tokens a turn never spent.** A finding's absolute
`cost` is now always a portion of that turn's billable; a context window's size, a subagent's own
volume, the whole abandoned turn, and a compaction's cross-turn tail all moved into the finding's
text. Measured over the 457 real flagged turns, the card printed "> 100% of the turn" on 247 of
them (54%, worst case 122 097%); now on none, maximum exactly 100%.

Corpus severity split: 14.5 / 12.3 / 73.3% crit/warn/good → **9.4 / 13.9 / 76.7%**. The aggregate
cache version bumps to 5 (the per-turn facts changed shape), so it rebuilds once on next launch.

### 2026-07-25 — Re-entry cost is not work: the verdict stops blaming a turn for its cold cache

Measured over the whole local corpus (2789 closed work turns / 231 sessions, through the real
parser + reducer): a turn's billable tokens are **78% cache_creation**, and 7% of turns open on a
call that re-creates ≥80% of the prompt it runs on — median **143k tokens before any work**. The
verdict counted that as work, so a turn whose entire content was *"commit, then create a branch"*
(2 tool calls, 62 seconds) was announced as `crit — 452k tokens, past your p95`.

- **The reducer states the fact.** `TurnNode` carries `firstCall { cacheCreation, fill }` — what
  the turn's first call had to re-create and the prompt it ran on — plus `rebuildExpected`, true
  when a rebuild is normal (the session's first call, or a compaction reset the window). Neither
  can be derived from existing fields: `cacheTotals.created` sums the whole turn and `breakdown`
  holds the last call. A call carrying neither context nor rebuild (an api-error `<synthetic>`
  line, all-zero usage) is skipped, or it would hide the real first call behind it.
- **A sixth detector: `resume`** (`warn`). Fires when the first call re-created ≥80% of its
  context and ≥50k tokens, and the rebuild was not expected. The thresholds are measured, not
  chosen: the first call's cache_creation is bimodal — median 168 tokens against 143 891 on the
  turns that rebuild. Fires on 4.9% of closed work turns and names 27% of all billable tokens.
- **The anomaly is judged on WORK tokens** (`turnWork` = billable − resume), and so is the
  personal baseline. The resume was inflating both sides: 43% of anomaly hits were resumes
  (median **6** tool calls, against 52 for the rest), and the p95 they lifted was the bar every
  other turn was measured against. Rebasing moved `unknown` p90 100 947 → 75 748 and p95
  189 483 → 114 934. The anomaly set keeps 167 turns, drops 110 cold resumes and newly flags 110
  turns that really did the work — the ones the inflated bar had been hiding.
- **Home names the session-level reading** a per-turn verdict cannot give: a `resumed cold` row in
  *where the waste comes from*, and the tokens spent re-entering in the card's hint.
- Aggregate cache → **v4** (`TurnSummary.resumeCost`; the baseline values changed for every
  cached file, so the shape bump alone would not have been enough).
- **`claude-opus-5` added to the context-window table** (1M, per the official model overview). It
  was missing, so it silently fell back to 200k: 18 real turns computed a fill above 100% of
  "their" window, up to 272%.

### 2026-07-25 — The post-turn verdict: one computation, reachable surfaces, a readable card

The verdict existed but was hard to reach and, in two places, wrong. Measured over 1950 real
turns (15.3% crit, 7.9% warn), the changes are:

- **One pass per render.** `computeVerdicts(snapshot, baseline)` indexes tools and subagents by
  turn once and returns every turn's verdict. Before, each surface re-derived its own, and every
  single-turn call re-scanned the whole `mainTools` array — O(turns × tools) on every event while
  the Timeline strip was open. Every surface now reads the same map.
- **The announce named the wrong turn.** It asked for the last non-live *work* turn, but a
  `/clear` (kind `context`) and a `/model` (kind `local`) write their own `system/turn_duration`
  — measured on the real corpus — so their turn-end re-announced the previous work turn. It now
  announces the turn that actually ended, only if it is a work turn, and at most once per index.
- **`warn` had no surface.** It was computed and discarded: the lens filtered on `crit` only, so
  one flagged turn in three was invisible. The Waste lens is now two-tiered — rose underline +
  row for crit, amber for warn — and each row states its tier.
- **The findings were undiscoverable.** They lived behind the Timeline strip's Waste chip and
  nowhere else; clicking a flagged turn said nothing. The scope banner of a flagged turn now
  carries a verdict chip that opens the lens on that turn, already expanded.
- **The share card was unreadable.** It printed `estimated waste ~48.2k estimated waste · 26%`
  (the label was in the template and inside the value), summed the anomaly's `3.4×` as 3.4
  tokens, pinned everything to the top leaving the lower half empty, and set its labels at a
  contrast that vanished on the background. It now leads with the token count (true with or
  without a baseline), places the turn on a p50/p90/p95 scale bar, and carries a stat strip —
  API calls, tool calls, subagents, cache reads, model · effort — so the card says what the turn
  DID, not only how it was judged.

### 2026-07-24 — A subagent spawn says which model it runs on

The subagent toast had been reduced to the agent type alone (2026-07-16), when the deferral that
waited for prompt + model was removed for costing latency. The model went with it, and it is the
one fact a type cannot replace: measured over ~1600 real subagents, **74.6% run on a different
model family than the session that spawned them**, so nothing else on screen implies it.

The toast now carries a model line, and it never waits for it:

- The toast fires immediately with the line reserved (`' '`), and `syncSubToastModels` fills
  it in place on the next render. Fixed `line-height` + `min-height` keep the toast the same
  size before and after, so the fill does not resize a toast the user is reading.
- **Filling in is the normal case.** Claude Code writes the child's sidecar BEFORE the
  parent's assistant line, so the `subagent-meta` that fires the toast usually arrives ahead
  of anything that could name the model. Measured on the live SSE stream over 6 real spawns:
  4 had the `Agent` tool-start (carrying `spawnModel`) arrive **0.6–2.7s later**, and the
  model appeared on screen 0.6–1.8s after the toast.
- When the tool-start does win the race (2 of 6), the model is in the reducer but not yet in
  the last PAINTED snapshot — the spawn is what is being announced. The lookup therefore falls
  back from `lastSnap` to `state.snapshot()`, and the line is filled at birth. One snapshot
  per spawn, only on the branch that needs it.
- For the **30.1% of spawns that declare no `model:`**, nothing can name it before the child
  writes its first assistant line — p50 3.2s, inside the toast's 5s life.
- A model that arrives after the toast is gone touches nothing: `dismiss()` drops the slot.

This is the case that prompted the change — a run of `fable` subagents that went unnoticed. Of the
28 fable subagents in the local corpus, **28 declared no model at spawn**: they are exactly the
inherited 30%, invisible at birth to any surface that reads only the spawn.

The sidecar `agent-*.meta.json` does carry a `model` on 143 of 1742 subagents, and it is
deliberately not read: it is always the family alias the spawn declared, so it repeats what
`spawnModel` already gives at the same moment.

### 2026-07-24 — Weekly activity: calendar weeks, read three ways (tokens / turns / hours)

The Home tab's activity chart answered one question — how many turns per week — and answered it
on a **rolling** 7-day bucket measured backwards from `now`. Two consequences: the bars shifted
under the reader between refreshes, and a Sunday turn shared a bucket with the next Monday's
whenever `now` sat midweek, so no two readings of the same corpus agreed.

The buckets are now **calendar weeks, Monday-anchored in local time**, and each one carries the
three ways to read the work it holds: `tokens` (COMPLETE, incl. cache reads), `turns` (with the
crit/warn/clean split it already had) and `workMs`. Metric tabs in the card's title switch
between them client-side, repainting from the loaded retrospective with no refetch. `turns`
keeps the severity stack; `tokens` and `hours` render single-colour, since a volume is not a
severity — the rule the histogram already follows.

`Retrospective.weeks[]` gains `tokens` and `workMs` (`src/types.ts`, `src/aggregate-cache.ts`);
the chart and its tabs live in `src/client/home-view.ts`, the `.rt-mtabs` / `.rt-wkcol` /
`.rt-wkv` rules in `public/index.html`.

### 2026-07-24 — Ended session: the subagent card fills the column instead of collapsing

On an ended session the live subagent monitor used to collapse to a one-line summary ("N ran this
session"), which left the left column short while the activity feed ran tall — the two columns lost
their symmetry. The card now fills the left column with the COMPLETE list of subagents that
ran, as compact one-line rows that scroll inside the cockpit. To keep both columns equal for any
subagent count, the ended cockpit is now fixed at the same height as the live case (`min-height` +
`max-height: 29rem` on the activity card), and the ended feed's `max-height: 196px` cap is removed so
the feed fills that height and shows ~the same number of activities as live, scrolling past it. The
now-dead `.sublivecard.collapsed` styles were removed.

### 2026-07-24 — A session that is waiting for YOU says so

A Claude Code session stopped at an approval dialog was, until now, indistinguishable from one
sitting idle: nothing about a pending prompt is ever written to the transcript. It IS written to
`~/.claude/sessions/<PID>.json` — `status: "waiting"` plus a `waitingFor` label — which seedeep
already read and threw away (anything that was not `busy`/`idle` became `null`). Measured on a
real driven session (CC 2.1.218): a tool approval writes `"permission prompt"`, an
AskUserQuestion or an MCP elicitation writes `"input needed"`, and both clear themselves the
moment the dialog is answered.

Three surfaces, one state:

- **The tab dot goes amber** for as long as the prompt is pending, on every open tab — the strip
  is the only surface that survives a tab switch. The state is spelled out in the tab's `title`
  too, so a class is never the only channel.
- **The NOW panel takes it over**: the panel that says what the agent is doing says, in amber,
  that it is doing nothing until you answer — naming the tool it is waiting to approve (the
  `tool_use` line lands BEFORE the dialog, so the pending tool is already in the feed) and
  ticking how long it has been stopped, from CC's own `statusUpdatedAt` rather than from the poll
  that noticed. A turn the user has selected is never hijacked.
- **One amber toast** announces the transition, for whoever is looking at that moment.

What counts as "blocked on the user" is decided in one place (`sessions.ts` `pendingInput`):
`"permission prompt"` and `"input needed"` only. A picker the user opened themselves
(`"dialog open"`), a sandbox/worker request, or an unknown label from a newer release is never
claimed as an approval — a badge that cries wolf is worse than one that stays dark.

seedeep still only reads: it shows that something is pending, it never answers it.

Guarded by contract claim **C24** (probe scene 12, which provokes a real prompt and declines it);
the refusal in the transcript is the ground truth, never the field under test.

### 2026-07-23 — Session card: which models the subagents ran on

The Session card's **Subagents** row now opens into a **by-model** bar — the row's total split by
which model burned it, one segment per model family, biggest first. Subagent tokens only (the main
thread stays out by the reducer's `owner` split), so the bar splits the row directly above it, not
the hero; absent when no subagent ran. The split is per CALL, not per agent: `subagent-meta` names
one model per agent, but ~2% of real subagent transcripts run on more than one family, and a
per-agent charge misattributes ~1% of subagent tokens overall (7% inside one real 130-subagent
session). The reducer gains `AgentAcc.volByModel`, `AgentNode.volumeByModel`, and
`TreeSnapshot.subagentTokensByModel` (with a shared `sumTokensByModel` used by both `snapshot()`
and `scopeToTurn`, so a scoped total and a session one can never be built differently). The card's
three category rows are now headed **main session**, naming the axis they share so the hero reads
as their sum plus the subagents. Verified end-to-end on a real 160-subagent session: hero 656.5M,
Subagents 168.3M, bar sonnet 81% / opus 13% / haiku 6%, split summing to the row exactly.

### 2026-07-23 — A resumed subagent stops again

A subagent's completion notification is not always keyed on the spawn that launched it: when the
agent was put back to work with `SendMessage`, Claude Code writes the **resume call's**
`tool-use-id`, which names no spawn — so the reducer terminated nothing and the agent stayed
`running` for the rest of the session (rendered `unknown` once the session closed). Measured over
all local logs: 26 of 655 notifications take that shape, and replaying the real spawn lifecycle,
**4 of 11 resumed background subagents never ended**. Both the reducer and the span store now fall
back to `<task-id>` — the child's agentId, present on 655/655 notifications — resolved through the
same `agentId → spawn` map the `SendMessage` resume path already trusts. It is a fallback, not a
change of key: the 474 notifications that name their spawn directly are routed exactly as before,
and the 155 that name no subagent at all (a background `Bash`/`Monitor` task, a `Workflow` run, a
spawn nested inside a child) still resolve to nothing. The link written back is the spawn's id, not
the event's, so a resume can never repoint a child at the tool call that resumed it.

### 2026-07-23 — "Changed files" widget

A fourth widget in the retrospective stats strip lists the files changed in scope, read from
Claude Code's own file-history ledger — a new `file-history-delta` line type the parser did not
read before (`type: 'file-change'`). The reducer collects them into `filesChanged` on the
snapshot (filtered by `scopeToTurn` like `mainTools`), attributing each to the open turn, and
`changedFiles` dedups by path. No per-file change-count exists to show: CC writes exactly one
delta per file per session (measured 642/642, `version` always 1), so it would be a constant ×1.

The widget body is a **hero total plus one proportional bar per file extension** (`51 files`, then
`ts 22`, `html 11`, `md 9` …), each bar scaled to the largest kind — measured, the top kind is a
median 72% of a session's files, so "one kind dominates" is the story, and a bar shows that ratio
where a bare number makes you compute it. Only the **top 4 kinds** get a bar (73% of real sessions
have ≤4 distinct extensions, and where the cap bites the top 4 still cover a median 100% of the
files, min 86%); a `+N more types — Expand all` row then appears, which is not decoration — without
it the bars would silently stop summing to the hero total. The complete list lives in the drawer behind `Expand
all`, which now narrows by **two filters ANDed together**: the existing path text box and a
single-select row of type chips. A raw file list was built first and dropped: at session scope it
truncated in 70% of real sessions (median 15 files changed), so five rows were a ~33% sample that
answered nothing. Bars live in their own `fchg` namespace (modelled on the Home tab's `.rt-brow`,
deliberately not sharing it). Extensions are tinted by kind
(code/doc/markup/data/style/shell → existing palette vars, via `.ft-*` classes declaring a single
`--ft` hue that each consumer claims with explicit specificity — never source order). Real
sessions carry a median of 4 distinct extensions (max 8), so the chips need no cap. The
stats-strip grid moved from three equal columns to four at **22/22/22/34**
(written as fr units so the numbers read as the percentages they are): Session, Skills+Commands and
Changed files are three equal summary cards, and Main tools — the only one showing full paths —
keeps the widest column. Changed files sits immediately
left of it. The strip folds to a 2×2 at ≤1100px. LIMIT: the ledger is NOT origin-agnostic —
measured by provoking it on 2.1.218, a file written only by a shell command (`sed -i`, a `>`
redirect, `cp`) produces no delta and never enters a snapshot's `trackedFileBackups` either, while
an Edit on a sibling file in the same session does. Files outside the tracked workspace are never
in it. So the list reflects what Claude Code's own file-writing tools touched, not every change on
disk — said in one line above the drawer's list, where the list itself is the question being asked,
and deliberately NOT under the card's hero total, which would carry the caveat in every session
including the ones with no shell write at all.

### 2026-07-21 — Fix a turn cut off mid-response freezing the live view

A turn that was cut off and auto-continued — Claude Code writes a synthetic "No response
requested." assistant line (`message.model: "<synthetic>"`, zero usage) with **no**
`turn_duration` and **no** Esc marker — stayed `live` forever in the reducer. Two live turns then
coexisted, and the intent panel (which shows the first live turn) froze on "No response
requested." while the model chip read `<synthetic> · was opus`, even as the session kept working.
Two fixes: a new prompt now closes a still-live previous turn (a turn that did real work becomes
`interrupted`; a no-call turn like `/model` is left for the 0-call → done rule), so there is never
more than one live turn; and `<synthetic>` — Anthropic's placeholder for lines that did not come
from a model call — is no longer read as a model, so it cannot poison the model chip, the
context-window denominator, or the by-model split. The aggregate cache version was bumped so a
cache built with the old parser (still holding `<synthetic>` as a by-model slice) self-heals on
next launch — a summarizer change that alters stored *values*, not just their shape, must
invalidate the cache too.

### 2026-07-21 — Retrospective: total tokens, by-model, API/tool calls, colour cleanup

Added to the Home dashboard: **total tokens spent** (the COMPLETE amount — input + output +
cache creation + cache **reads**, since cache reads are billed too; the per-turn and per-model
figures stay "new tokens" excluding cache reads, because a turn re-reads its whole context every
call and including it would swamp the distribution), **API calls**, a **tokens-by-model** split
(cool palette, deliberately not the severity colours), and **tool calls by type** (a call COUNT,
not a token attribution — tools don't spend tokens). The per-file summary now stores each turn's
`cacheRead`, `model`, `apiCalls` and the session's tool counts (cache version bumped).

Colour discipline: severity now means one thing everywhere (crit=red, warn=amber, clean=blue);
the histogram is single-colour (a distribution is not a severity — the old red "tail" read as
crit); the Activity chart gained its legend. Also fixed the "Pick a session" CTA, which opened
then instantly closed the picker (the opening click reached the picker's click-outside handler).

### 2026-07-21 — Retrospective dashboard: charts + time filter

Reworked the Home tab from a sparse tile grid into a full bento dashboard that fills the page:
KPI tiles (median turn, wasteful %, tokens to Esc, and a new **working-time** total from
`durationMs`), a **turn-size distribution** histogram (the hero, with p50/p95 markers), a
**weekly activity** chart split by severity, a **waste-by-cause** breakdown, and the verdict
split. A **time filter** (`7d / 30d / all`) recomputes the windowed numbers; all three windows
arrive in one `/api/retro` response, so switching is instant with no refetch. The per-file summary
now also stores each turn's `ts` and `durationMs` (cache version bumped); the anomaly split still
judges against the all-time baseline, and the weekly cadence is all-time and sized to the corpus's
real span. All dashboard classes are `rt-`-prefixed after a pre-existing global `.wrow` (red left
border) bled a marker onto every waste row — index.html has no CSS scoping, so the prefix is the
isolation mechanism.

### 2026-07-21 — Minute-zero retrospective (Home tab) + persistent incremental aggregate cache

A pinned **Home tab** (`src/client/home-view.ts`), always leftmost and one click from any
session, shows corpus-wide aggregates at launch — median turn, tokens abandoned to Esc,
wasteful turns, re-reads, large subagent outputs, mid-turn compactions, and the crit/warn/clean
split — so seedeep is useful before any live turn. Launch lands on a live session if one exists
(Home a click away), else on Home; Home replaces the old empty-hint (a fixed surface never reads
as a broken page). Served by `GET /api/retro`.

Behind it, a **persistent, incremental aggregate cache** (`src/aggregate-cache.ts`): a per-file
summary of each session's work turns (`billable`, `effort`, and the baseline-independent
`esc/reread/compaction/subWaste` flags), keyed by path and invalidated by `(size, mtime)`, so a
refresh re-parses only changed files and merges the rest in milliseconds. The anomaly/crit split
is recomputed at aggregation (it depends on the global baseline) sharing `anomalySeverity` with
the live detector, so it never drifts. The map is persisted atomically to the gitignored,
seedeep-owned `~/.claude/.cache/seedeep/aggregates.json` — a new, self-owned kind of write that
touches no session file, so the read-only-of-Anthropic-data invariant holds. This **supersedes**
the roster-length baseline cache: one scanner now serves both `/api/retro` and `/api/baseline`
(`= (/api/retro).baseline`), with no full rescan on every roster change and no stale entry when a
session grows.

### 2026-07-21 — Post-turn verdict + personal baseline

Two joined features. **Personal baseline** (`src/baseline.ts`, `GET /api/baseline`): the
user's own per-turn token distribution (p50/p90/p95, overall and **per-effort**) scanned
from the local corpus through the real reducer, cached and recomputed only when the roster
grows. **Post-turn verdict** (`src/client/verdict.ts`): five deterministic detectors —
re-reads (same file ≥3×), wasted subagent, mid-turn compaction, Esc, and a token anomaly
vs the baseline (per-effort p95 = crit, p90 = warn) — collapse to a worst-of severity per
turn. It reuses existing surfaces, no new widget: a crit turn pushes a non-blocking toast
on close (announce); the Timeline strip marks each flagged column with a severity dot on
top of its state colour and adds a **Waste** filter chip (history); clicking a flagged
column opens its findings under the chart (detail). Anomaly triggers on a **percentile**,
not a multiple of the median — measured, a "3× median" rule fires on ~30% of turns because
the distribution is heavy-tailed. Retrospective "minute-zero" surface deferred.

### 2026-07-21 — Live intent panel: what the agent is trying to do right now (V1)

A new panel between the Live activity header and the feed answers "what is the agent
trying to do right now" from a datum the model already writes: a main-session assistant
line with a text block that is not the turn's end (`stop_reason !== "end_turn"`, measured
`tool_use` on 79% of text-bearing lines) is mid-turn **narration**. The parser emits it as
a `turn-narration` event (main session only), the reducer keeps the latest per turn
(`TurnNode.lastNarration`). The panel shows the current intent — or, once the turn's `end_turn`
answer lands, its **final output** — and its age. No LLM: pure extraction. A stale comment in
`parser.ts` that claimed mid-stream text lines carry `stop_reason: null` was corrected.

With the intent panel carrying the live headline, the activity feed became the tail. It trades
rows for the panel so the card's height barely moves: it shows **12** rows when no intent/output
is present, **9** with a one-line intent, **8** with two (the ring still retains 12 for the
drawer). It never grows a scroll. The intent text is clamped to **two lines**; when it overflows,
a **more** affordance at the end of the second line opens the full text, rendered, in the output
modal. The full activity history stays in Expand all and the Trace.

### 2026-07-20 — A folded failure stays visible in the Trace

The error badge reddened a Trace step span, but the Trace folds non-landmark tools
(Bash, Edit, Read — exactly the ones that fail most) into rounds and chapters, so a
failure was invisible in the collapsed strip: you had to open the right group to find
it. `groupTurnSpans` now carries `hasError` up the group tree (a round/chapter has it
iff any leaf span failed), and the renderer gives a flagged group a red left rule plus
a red dot in its type-dot preview at the failing step's position — the failure reads
at a glance, no expansion needed.

Verified against a real 47-failure session rendered through the actual `createTrace`
path: collapsed, 38 group blocks carry the red flag and 31 preview dots go red; every
one of the 47 failed steps reddens when expanded. Tests: two in `trace-group.test.ts`
(propagation to round + chapter), one in `trace-render.test.ts` (both group faces +
the preview dot + the leaf), with a flip check.

### 2026-07-20 — Failures are visible: tool errors and API errors as pointed badges

A tool that **failed** and an API call Claude Code flagged now carry an error badge —
in the Live activity feed (red left rule + `error` tag), on the Trace span (red
border, main strip and subagent lanes alike), in the tool/call drawer (a red
`failed`/`error` chip), and in both Expand-all lists (Live activity's all-activity
list and Main tools' all-calls list — same red rule + `error` badge, so the same
failure reads identically wherever the row appears). No dedicated widget and no
aggregates: the badge sits on the thing that failed, where it is legible; latency was
measured and deliberately left out of scope.

The one judgement the feature makes lives in a new pure module `src/failure.ts`
(`toolOutcome`): a tool the **user refused** — Esc on the permission prompt, or a
deny rule — carries the same `is_error: true` flag as a real failure but is NOT one,
and is never badged. Measured over 3269 real sessions: 1888 `is_error` results split
1642 failures / 246 refusals; **56% of failures happen inside a subagent**, so the
Trace lane span is badged too, not only the main thread. The refusal is recognised by
`toolDenialKind` (authoritative, but only since CC 2.1.198 — 130/246) plus the
anchored refusal strings CC writes (the other 116); a loose `includes('permission')`
was rejected because it mis-reads real Bash failures whose OUTPUT mentions it.

`is_error` was previously read nowhere (`span-store.ts` forced every closed tool span
to `ok`, with a `// LIMIT:`); the parser now sets `ToolEndEvent.error` and
`UsageEvent.apiError`. API errors are keyed on `isApiErrorMessage`, not on
`apiErrorStatus` — 22 of 63 real error lines ("Not logged in", "Prompt is too long")
carry no status yet are the ones a user most needs.

Guarded by five `src/failure.ts` unit tests and five golden-transcript tests (raw
jsonl → real parser → reducer → span-store), plus a flip check (the fix off turns two
red). Verified live against real sessions: the pipeline flags exactly 47 failures / 12
refusals on one 3269-line session, and a real failed `Edit` shows its feed badge and
red drawer chip in the browser. `LIMIT` (in `failure.ts`): the refusal strings are
Anthropic's and no schema-guard layer covers value-level strings — a probe scene that
provokes a refusal is a follow-up.

### 2026-07-20 — The Live activity card can show everything it kept from you

The activity ring holds the last 12 activities per turn. Measured over 1281 real
sessions / 2571 turns, 12 is the **median** turn (p90 68, p99 284, max 856), so
**48.2% of turns had activity the card could never show** — and the eviction is
destructive, so nothing in the UI could recover it.

`Expand all`, beside `Trace`, now opens the complete chronological list in the
standard drawer, built the same way as Main tools' expand (header → KPI tiles →
filter → rows). It reads `span-store.ts`, not the ring, through a new pure module
`src/client/activity-list.ts`.

The trap that module exists to close: **subagent spans live only in
`turn.spawns[].lanes[].spans`**, never in `turn.spans`. A list built from a turn's
own spans omits everything a subagent did and still looks complete — five of the six
new unit tests go red when the lane merge is removed. Subagent rows are included
(indented, badged with their agent, model parenthetical stripped).

Rows open through the same `openBlock` router the Trace uses, so a row here and its
span in the Trace lead to the identical drawer. They keep a `t-<type>` class as a
hook but draw no type marker of their own — the name already says what the row is.

Real-data fix found while verifying live: every `prompt` and `result` row rendered
`running…`. Those spans close instantly (`t1 === t0`) with status `ok`, and the
renderer was reading "no duration" as "still running". They now render `—`; the
fixtures never caught it because they carried only tool spans.

### 2026-07-20 — Every drawer is ranked, not listed

The subagent drawer stated eleven facts as eleven identical bordered rows, so
`Spawned in turn` read exactly as loud as `Duration`, and ~460px of ledger stood
between the title and the launch prompt — the content that answers "what did it
do?". A proportion fared worst: `read 2.0M 96% | write 78.7k 4%` is a
four-value micro-table squeezed into two lines of text, in a tool whose whole
premise is making the invisible visible.

All six drawers (subagent, tool call, API call, tool type, skill, command) now
share one layout, and its order IS the ranking: header (kind chip, title,
identity line) → 2–3 KPI tiles → bars → content → `Details`. The identity line
carries only what the entity is — type, model, owner — so a measurement can
never dilute it; the API-call drawer, which learns its model only when the fetch
lands, rewrites that line in place instead of leaving it saying "loading…".

Two text rows became one stacked bar each: a subagent's four usage categories,
and an API call's input composition (which retires the `Raw usage` row — its
three figures are now that bar's legend). A zero-value category is dropped from
the bar but kept in the legend: a 0-width slice is a rendering artefact, while
"output 71" is a fact.

The sticky header also swallowed the drawer's close button: `.dhead` paints an
opaque background at `z-index:2` and `.drawer .close` had no stacking order at
all, so the ✕ was still in the DOM — and still clickable by a test driving
`onclick` — while being invisible on screen, leaving Escape and the scrim as the
only visible way out. The button now sits at `z-index:3` and the header reserves
room for it, so a long title cannot run underneath.

Live verification against a real session caught what the prototype could not:
`.chead`, `.clbl` and `.cval` were only ever declared UNDER `.crow`, so the
stacked bar's head — which has no `.crow` — rendered unstyled, label and figure
glued together at body size. The prototype had hidden it behind inline styles.
The fake DOM now RECORDS `style.width` instead of discarding it, because a
proportion bar encodes its meaning there: a fake that swallows it lets a bar
with wrong shares pass every test.

### 2026-07-20 — The context window follows the model the calls report

The model was read once, from the session head, and never revisited. That single
decision produced three separate symptoms, and none of them looked like the same bug:

- a session opened right after `/clear` has no assistant line yet, so discovery reports
  `model: null`, the window falls back to 200k + `estimated`, and it stayed there until the
  page was reloaded — reloading rebuilt the tab, which was the only thing that re-read it;
- `/model` mid-session never moved the window. opus-4-8 is 1M and sonnet-4-6 is 200k, so
  after a switch the same 188k reads as 19% full instead of 94%. Measured across the local
  logs: 1197 sessions carry a model, and 1 of them really does switch mid-way;
- neither the turn nor the session ever NAMED its model, so a wrong window was
  indistinguishable from a right one.

`message.model` now rides on the `usage` event, beside the `effort` that was already there.
`main.model` is the model of the latest main-session call (the window's denominator),
`main.models` every model the session has run on in order, and each `TurnNode` carries the
same pair for its own calls. The seed from discovery only covers the gap before the first
call.

On screen: the scope banner and the Session card title name the model of whatever scope
they show — the Session card's chip follows the scope, like the ledger under it, so a card
reading "Tokens billed this turn" cannot be labelled with the session's model. A scope that
changed model states the current one and what it was; showing only the last would hide the
change, and showing only the first was the bug. Effort renders only when the transcript has
one: measured over 2828 real turns, 98% carry none and 99.7% carry exactly one model.

The whole-session banner states how long the session has **worked** — the sum of its turns'
own `turn_duration` values, so the total is exactly the sum of the numbers each turn shows.
Deliberately not the wall-clock span: measured over 202 real sessions, working time is a
median 33% of wall (p10 8%), so a 22-hour session can hold 30 minutes of work and the two
readings answer different questions. An open turn has no duration yet, so its live elapsed
is added on top — otherwise the total would sit frozen for a whole turn and then jump.

`formatDuration` grew an hour scale (`1h 5m`) for this: it was written for subagents and
tools, and a session's working time reaches hours where `1080m` stops being readable. Every
scale below the hour is unchanged.

An open turn on a LIVE session now counts up in the banner instead of reading "running".
The counter exists only while the session is live and the turn is open — never on an ended
session or in replay, where a wall-clock counter would tick upward for days on a session
that died mid-turn. It counts from the turn's own `startedAt`; measured against 2828 real
`turn_duration` lines, that start agrees with the authoritative duration to a median of
157ms, so the number settles rather than jumping when the turn closes.

### 2026-07-19 — The whole browser client moved into the typed build

The client was split across two pipelines: `src/client/*.ts` (strict TypeScript,
typechecked, unit-tested, bundled) and `public/*.js` (3372 lines written by hand
and served raw). The two biggest, most complex modules of the repo — `graph.js`
(1538 lines) and `trace.js` (1064) — sat in the untypechecked half. `tsconfig`
covers `src` and `tests`, and `checkJs` is off, so nothing ever checked them.

All seven (`app`, `view`, `graph`, `trace`, `dropdown`, `tab-bar`, `markdown`) are
now `src/client/*.ts`, and `build:client` bundles from **one entry point**,
`src/client/app.ts` → `public/lib/app.js`. `public/` holds the page and that
artifact, nothing else.

One entry, not twelve, because bun bundles each entry point independently: with
`graph` registered as its own entry, the reducer, span store and feed it imports
would be inlined into its bundle *and* remain in the ones `app` already loads —
two copies of the same code in the page (verified, not assumed). `index.html`
loads a single module, so there was only ever one real entry.

The move was verbatim (outside the import lines, zero of the 3393 migrated lines
differ), and the annotations then landed module by module, leaf-first so each
caller met real types rather than `any`. **All seven now typecheck under strict —
no `@ts-nocheck`, no `any`, no `@ts-ignore` anywhere in `src/client/`.**

What the types found, which the 457 passing tests could not:

- **Test fixtures were building shapes the reducer never emits.** `graph-shell`'s
  base snapshot declared tools as `{name, ms, turnIndex}` — no `id`, `arg`, `ctx`
  — so every test that did not override it exercised a state that cannot occur.
  `view-shell`'s stub was missing `subagentsTotal`, `subagentsEstimated`,
  `inputTotal`, `outputTotal`. Both now carry the real shape. A fixture may be
  synthetic in content; it may not be synthetic in shape.
- **`setOpenTabs(ids: string[])` had never once been called with an array** — its
  only caller passes `openTabs.keys()`. Signature corrected to `Iterable<string>`,
  which is what the body (`new Set(ids)`) always accepted.
- **`createView` demanded the whole session-state reducer** while calling two of
  its methods. Narrowed to `Pick<…, 'snapshot' | 'onChange'>`: the view reads
  state, `app.ts` owns `apply`. The test's minimal double was right and the type
  was wrong.
- `GraphOpts` initially omitted `sessionId`, which is deliberately threaded
  through but not read yet. Typing only what is read would have broken every
  caller — a change to the callers dressed up as a type.

Kept deliberately unfixed, because they are the user's call, not a typing
decision: `markdown`'s link branch checks `href` inside the branch rather than in
its condition (hoisting it would drop the match's raw text instead of falling
through), and the three DOM roots in `app.ts` are asserted rather than guarded (a
guard would add a boot-time throw where there is none today).

Verified: typecheck clean, 457 tests pass, the emitted JS was diffed against the
pre-annotation revision to confirm no runtime change slipped in, and a live run
against a real session exercised the interactive paths (feed row → drawer, drawer
close, subagent card → drawer, timeline turn select, Trace modal) with no page
error and no failed request.

Also fixed: `tests/trace-group.test.ts` did not typecheck — `label = type` inferred
`SpanType` from the default value, so the test helper rejected the tool names
(`'Bash'`, `'Skill'`) every landmark test passes it. `bun run typecheck` was red on
a clean tree.

### 2026-07-19 — API calls and subagents report the effort they ran at

Claude Code began writing a root-level `effort` on assistant lines in **2.1.212**
— confirmed twice over: 0 of 26,874 assistant lines before that version carry it
against 362 of 388 after, and the upstream changelog says "Changed session
transcripts to record the reasoning effort level on each assistant message". It is
per-CALL, not per-turn: no `system`/`turn_duration` line carries it, so a turn that
changes effort mid-way has calls reporting different values. Subagents write it in
their own child transcript (provoked on a sonnet child), so a subagent can run at a
different effort from its parent. The only models that never write it are the ones
without configurable effort — haiku.

`/api/call-io` now returns it and the API-call drawer shows it under Model. The row
is rendered ONLY when the call reported one: a dash would assert "no effort", when
absence really means "written by a pre-2.1.212 release" or "haiku". Radar updated
(`known-fields.json`) — the scan also picked up `apiError`, unrelated and unread.

The subagent drawer reports it too, but it cannot borrow the call endpoint: that
drawer is fed by the reducer, so `effort` now rides on the `usage` event and the
tree collects the DISTINCT values a subagent's own calls reported. A set, not a
value — nothing proves a subagent keeps one effort for its whole life, and the
only sample that could settle it is a single provoked child file. If it reports
one, one is shown. Verified on real drawers: a sonnet child shows `high`, a haiku
child shows no row at all.

### 2026-07-19 — The catalog card drops the launch prompt

With the title now stating the intent, the card's two visible prompt lines showed
almost only the preamble every spawn shares (`Repo: …, read-only investigation…`),
so they cost height without telling the cards apart. The prompt is untouched in
the drawer, under `Launch prompt`, where the full text already lived. Measured on
a real 64-card catalog: 340px → 283px per card, about 1,200px of page.

### 2026-07-19 — The subagent drawer is headed by the work as well

Last surface still disagreeing: clicking a row (or card) titled "Review Task 5"
opened a panel headed `general-purpose`, breaking the thread exactly at the
click. The drawer now uses the same resolved `title` as the two surfaces that
open it. The type was the heading, so it does not vanish — it becomes the
drawer's first row, where it sits next to Model as the technical attribute it is.
Verified with real clicks on both paths: catalog card and live row each open a
drawer headed by the same text they show.

### 2026-07-19 — The subagent catalog is named by the work too

The cards at the bottom of the page still led with the agent TYPE while the live
panel and the Trace had moved to the launch intent — the same surface disagreeing
with itself. Measured on a real 63-card session: **2 distinct titles** (`Explore`,
`general-purpose`) across 63 cards, so the heading identified nothing and you had
to read the launch prompt to tell one card from another. The card now leads with
the same `title` the live row uses, and the type joins the model as a chip
underneath — both answer "what was it", while the title answers "what was it
doing". After: 63 distinct titles, card height unchanged at 340px, chips never
wrap. The card layout is otherwise untouched.

### 2026-07-19 — The Context card is as tall as its dial

The number, the breakdown bar and its legend were stacked UNDER the dial, so the
card ran to 197px while the dial itself is 66px — three bands of vertical space in
the cockpit's most valuable corner, for no added meaning. They now sit in the
column BESIDE the dial: measured in the real GUI, 197px → 154px (−43px), the bar
keeps its full width (390px), and the two cockpit columns still end on the same
pixel. Rejected on the way: putting dial | number | bar on one physical line, which
reads as the most literal form of the request but squeezes the bar to 92px — and
the length of its segments IS the information, with the 1.5% Input slice
collapsing to a single pixel.

### 2026-07-19 — The scrollbar is the only overflow affordance

The maintainer's call, and it reverses the fade + `N more running` footer added earlier
today: past three concurrent subagents the list simply scrolls, with nothing
announcing it. The footer is gone (with its css, its counter constant and its
test), and so is the bottom fade — which had a real defect anyway: it applied
whether or not the list overflowed, so the third row of a NON-overflowing panel
was drawn dissolving, reading as clipped.

The panel also carries +10px of deliberate slack over three measured rows. The
runtime measurement already sizes it correctly; the slack is belt-and-braces,
because an empty strip under the third row costs nothing while a scrollbar on
three rows is a bug. Measured with the production css over 5 widths × 5 content
shapes: no configuration scrolls at three rows.

### 2026-07-19 — The live monitor is actually scrollable, and sized from the real row

Three faults, one session of measuring. **The panel raised a scrollbar with three
rows**: its height came from a constant measured on one machine (`--subrow-h:73px`
against a 72.703125px row — 0.9px of headroom), so a browser that renders the row
a pixel taller overflows by a pixel or two. graph.js now sets `--subrow-h` from the
row's real rendered height (ceil), and the constant is only a fallback.
**The list would not stay scrolled**: the card is rebuilt on every render, so the
scrolled element was thrown away and the new one started at 0 — measured live, a
scroll to 78px snapped back within a second, which is what made the list feel
unscrollable and the `N more running` footer pointless. The offset is now carried
across rebuilds, and the footer jumps instantly rather than smoothly (a render
replaces the element mid-animation). **The rows touched the scrollbar**: the list
now keeps a `--subgap` gutter on the right.

Verified in the real GUI: 3 rows → no scrollbar at all; 4 rows → wheel scrolls,
footer click lands exactly at the bottom, and the offset holds for 7s of live
events.

### 2026-07-19 — The live monitor says how many running subagents it cannot show

Past three concurrent rows the panel scrolled, and a scrollbar states that there
is more without ever stating how much — with eight agents running, the number you
cannot see is the one that matters. The list now fades out at the bottom instead
of ending on a hard cut, carries a thin in-palette scrollbar rather than the
system one across the card's edge, and gains a footer (`N more running ↓`) that
counts the overflow and scrolls to it. The footer exists only while the list
overflows. LIMIT: it counts against the panel's row budget
(`LIVE_ROWS_VISIBLE`, which must track the `.sublist` height rule), not a
measurement, so a list mixing taller workflow rows can hide one more than stated.

Also fixed while verifying: `.sel` (the elapsed time) had neither `flex:none` nor
`nowrap`, so a long title pushed it onto a second line and took the row from
72.7px to 85.7px — three rows then needed 269px and scrolled inside the 231px
panel at EVERY width. Found by stressing the production css over 5 widths × 5
content shapes rather than the happy case, which is what the first pass measured.

### 2026-07-19 — A live subagent row is headed by what it was launched to do

The row led with the agent TYPE, which named nothing: measured over 400 real
sessions / 690 spawns, 455 read `general-purpose`. It now leads with the launch
intent — `description` → the prompt's first line → type → id, the same chain the
Trace already used — with the type demoted to its own line underneath. The intent
travels on the spawn itself (present on 99.4% of spawns), so it is known
immediately, whereas the type arrives with the child's sidecar; the type's line is
therefore rendered even while empty, so a row never grows a moment after appearing.
The context bar is now a fixed 132px instead of `flex:1`: it is a quantity compared
ACROSS rows, and as a flex item it shrank whenever the action text grew, drawing two
equal fills as different bars. The action absorbs the slack and truncates instead.
`AgentNode` gained `title` (resolved once in the reducer so every surface agrees)
and `ToolAcc` now keeps the spawn's `description`, which the parser already read.

The extra line made the row 72.7px, so the monitor's flat `height:200px` clipped the
third row by 30px. The height is now derived from the row — `calc(3 * --subrow-h + 2 *
--subgap)` = 231px — so three concurrent subagents are whole and the fourth starts the
scroll. Measured in the real GUI: 3 rows give `scrollHeight == clientHeight`, and the
Live activity card follows to the pixel (both columns 532px, bottom delta 0) because
the grid already stretches the row to the taller side.

### 2026-07-19 — Subagent rows: the same live event-ordering bug, now fixed in the reducer

The session tree had the ordering bug the span-store already fixed: `linkSpawn`
wrote the spawn side of the link only `if (sp)`, and `tool-start` then created
the `SpawnAcc` with a hardcoded `agentId: null`, never consulting the reverse
map. Live, where a child's `meta.json` lands before the parent's spawn line, the
link was therefore lost for good — and ONE subagent became TWO rows: a ghost
carrying the raw `tool_use` id as its label, stuck at `0 / 200k · 0%` and
`starting…`, plus the real (orphan) child row. That inflated the
"N running · M finished" counters, and a ghost whose spawn never reported
completion stayed `running…` with no elapsed time. Replay was immune (it reads
the parent to EOF before the children), so a browser refresh "repaired" the
panel — the reported symptom. `linkSpawn` now parks the link when its spawn does
not exist yet and `tool-start` adopts it at birth. Measured on a real session:
3 parallel foreground spawns produced 5 rows (2 ghosts) before, 3 after; live and
replay now agree.

### 2026-07-19 — Trace: live subagent lanes fixed (event-ordering), launch-intent labels

Live, the watcher reads a subagent's `meta.json` and child transcript as soon as
the agent starts writing, but the parent's assistant line (carrying the spawn
`tool_use`) is only written when the streaming response reaches it — so
`subagent-meta` and child events routinely arrive BEFORE the spawn exists. The
span-store silently dropped that meta and parked child events until `agent-end`:
every spawn block read "no child data yet" and every lane "no child events"
while agents visibly ran. The store now parks an early meta
until its spawn arrives, then applies it and flushes the parked child events —
lanes exist and fill WHILE the subagent runs (verified live mid-run). Spawn
blocks are now labelled with the launch `description` ("Finder A: line-by-line
scan") instead of the generic agent type, falling back to the prompt's first
line, then the type. Running lanes keep a raw, glowing tail like the main
strip. Cleanups: the adapter's lane field is `spans` + `toolCount` (the old
`tools` name held ALL child spans and invited overcounts); one DOM walker
serves every traversal in trace.js.

### 2026-07-19 — Trace strip grouped at real scale; spawn block merged with its subagent

Measured over 2,445 real work turns, the median turn (9 steps) already
overflowed the strip and the p99 (204 steps) produced a ~59,000px canvas. The
strip is now grouped by a hybrid rule (`src/client/trace-group.ts`): one
**round** = an API call plus the tools it triggered; runs of completed rounds
fold into **chapters** (capped at 10, broken early by landmarks); landmarks
(prompt, spawns, `Skill`/`AskUserQuestion`/`ReportFindings` tools, results)
always stay top-level. Groups expand **in place** (nested chapter → rounds →
steps) with per-turn expand/collapse-all; user-expanded groups survive live
re-renders; on a live turn the tail round always stays raw so the newest work is
visible as it happens.

The spawn block is now **merged with its subagent**: it shows the launch intent
plus the subagent's real facts (agent type, tool count, duration — never the
launch-receipt ms), clicking it unfolds the child's own flow as a parallel lane
anchored under the spawn (Workflow spawns unfold their bundle grid), and an ⓘ
affordance opens the drawer. The old fork/branch fan-out is deleted — including
a crash where `HTMLCollection.find` wiped every arrow on fan-out. Subagent
clicks never silently no-op anymore: when the agent is not in the snapshot yet,
the spawn TOOL drawer opens instead. Mid-turn results (the model closed and was
re-woken, e.g. by a background task notification) render as dashed **reply**
blocks — only the final one reads **done**. A **follow** button re-engages
live auto-follow after a manual pan.

### 2026-07-18 — Trace view: single continuous flow of a session

A near-fullscreen **Trace modal** opened from the Live activity header button shows
the session as a single continuous vertical spine — one node per turn (prompt →
API calls → tools → result), with parallel subagent lanes branching off spawns.
Scope-aware: clicking **Trace** with no turn selected shows the whole session;
clicking it while a turn is selected scopes the spine to that one turn. The modal
follows the newest turn live and auto-scrolls to it. Clicking any span node opens
the existing detail drawer (same drawer used throughout the Graph view — no
duplicate logic). The span data comes from the shared `createSpanStore`
(`src/client/span-store.ts`), which is fed by `onEvent` and is the single source
of truth for the Trace.

Fixed: `SVGElement.className` was being set via property assignment (read-only on
SVG elements) in `public/trace.js`; changed to `setAttribute('class', …)`.

### 2026-07-18 — API calls in the live feed, with an on-demand I/O drawer

Each API call (one `message.id`, folded across its per-content-block lines) now
renders as a row in the LIVE ACTIVITY feed — in timeline order **before the tools
that call decided**, tagged `SUBAGENT` for a subagent's calls, and carrying the
call's latency (response time − the tool-end/prompt that fed it). The reducer
flags a call's first line (`ctx.newCall`) and hands the row its input hint and
latency (`src/client/session-tree.ts`).

Clicking a row opens a drawer with the call's full **input and output**, read back
on demand via a new `GET /api/call-io` (`src/call-io.ts`) — never held in the
client, same read-only/anonymized path as tool output. Output is the model's text
plus the tools it called with their args, rendered as markdown for prose and
verbatim when it contains a tool call (so code is not garbled).

The raw `input_tokens` (~2/call, the uncached tail) no longer reads as "all my
input": the drawer shows `cached (re-read) + new this call` with a `Raw usage`
line, and the Session card merges cache-write + uncached into one **New input**
row. Feed polish alongside: leading dot removed, fixed-width name column so args
align.

### 2026-07-17 — Feed detail: explicit mapping for ReportFindings, ScheduleWakeup, Agent

The LIVE ACTIVITY feed shows a secondary detail string per tool, computed by
`argOf` (`src/parser.ts`). Only a handful of tools were mapped explicitly; the
rest fell to a generic "first string-valued field" fallback, which is blind to
key order and to non-string fields. Measured over 3095 real files / ~52k tool
calls, that produced wrong or empty labels for three tools now mapped explicitly:

- **ReportFindings** → `findings.length`, with `· <level>` appended when `level`
  is present (e.g. `3 · high`, `3`, `0 · low`). The count lives in an array, so
  the fallback could never reach it — it surfaced `level` by accident on 34/38
  calls and em-dash on the rest.
- **ScheduleWakeup** → `reason` (the field designed to be shown to the user), or
  `stop` for a `{stop:true}` call (which carries no reason/delay). The fallback
  showed `prompt`/`reason` interchangeably and em-dash on stop.
- **Agent** → `description`, deterministically. The fallback picked
  `subagent_type` on ~6% of calls (key-order dependent), showing the agent type
  instead of the task.

Detail strings stay anonymized via `anon`. Tools with genuinely empty input
(`TaskList`, `EnterPlanMode`, …) keep showing name only.

### 2026-07-17 — Session picker: Live/Inactive labels, and "self" removed

The picker's two section headers are now **Live** and **Inactive** (were "Active"
and "Inactive (replay)") — the grouping criterion is unchanged (`isActive`, the
mtime window); only the labels moved.

The **"self" concept is gone entirely** — the badge/style that marked "the session
that launched seedeep". As a long-lived daemon, seedeep learns its launching
session from `CLAUDE_CODE_SESSION_ID`, frozen at launch; once that session ends
and you work in another, the marker fossilises on a dead session, which read as a
second "selected" card in the picker. Since the picker already groups live
sessions and auto-open keys off `isLive` (never `isSelf`), the marker earned its
removal rather than a fix. Removed across the stack: `.pk-row.self` /
`.pk-badge.self` / `.tab.self` styling, the dropdown badge and tab `— this
session` title, and the backend that fed them — `resolveSelfId`, `pathRelated`,
the `isSelf` field on `SessionRecord`, and the now-unused `env`/`cwd`
`DiscoverOptions`. Auto-open and live/inactive grouping are unchanged.

### 2026-07-17 — A guard against Claude Code upgrades

seedeep reads logs it does not own, and their shape moves: measured over 3087 real
files / 26 releases, `slug` was removed between 2.1.208 and 2.1.211, and three
changes have already touched fields the parser reads. A new release lands every
~1.9 days. Two mechanisms now cover that, split by one fact — **presence is
conclusive, absence is not**. See `docs/claude-code-upgrades.md`.

- **Radar** (`src/schema-known-fields.ts`, `data/known-fields.json`): reports
  fields Claude Code ADDED, in the suite, ~106ms. Never fails the build — a new
  field cannot break seedeep. Accept one with
  `bun run src/schema-known-fields.ts --update`.
- **Probe** (`probe/`): drives a REAL session in a pty and PROVOKES each event,
  so a missing field is proof rather than a guess. Out of `bun test` (costs
  tokens); runs only on an uncertified release. Built on Bun's native pty — no
  native dependency.
- **Contract** (`src/schema-contract.ts`): 25 claims, each naming the site that
  reads it, so a failure says what BREAKS rather than what is missing.
- Three outcomes, never two: HOLDS / BROKEN / UNPROVEN. A release is certified
  only when every `gesture` claim HOLDS — "nothing broke" is not "I checked".
  Anything unproven is printed as an actionable manual checklist.
- **Evidence** (`src/schema-evidence.ts`): claims the probe cannot provoke close
  themselves from real sessions written by that same release. Attribution is
  strict: only lines carrying the target `version`, and a session spanning an
  upgrade is discarded rather than guessed (its subagent children carry no
  version of their own).
- The probe never ships: tmpdir-scoped fixtures, never the repo as cwd, excluded
  from the distributable.

- **A session that starts gets a tab — once (2026-07-17).**
  seedeep watched new sessions appear in the picker and did nothing about it; you had to go
  and pick the session you had just started. Now a live, interactive session that has not
  been offered before opens its own tab. The hard part is *once*: the tab set alone cannot
  express it, because a session whose tab you closed is still live and still in the roster,
  so the next 3s poll would reopen it forever. A second set — `known`, "already offered" —
  is persisted next to the tabs; closing a tab drops it from the tabs but never from
  `known`, so it never comes back, on any poll or refresh. `known` is pruned to the live
  sessions (an ended one can never re-trigger), so it stays a handful rather than growing
  with every session ever seen. The same rule subsumes the first visit — with `known` empty
  it opens exactly one tab per live session, as before — so there is one code path, not two.
  - **Background, not focus-stealing:** the tab appears and starts reading without pulling
    you off what you were reading. Only an empty screen activates the new tab, since a tab
    nobody looks at would leave the page blank.
  - **Automated runs excluded**, and this one was measured rather than assumed: a headless
    `claude -p` DOES register in `~/.claude/sessions/` for the length of its run, so it is
    an open session. Without the filter, every git push (the docs-freshness gate is a
    `claude -p`) would pop a tab — a content-less one at that. The comment claiming that
    directory was TUI-only has been corrected; it was wrong.

- **The busy dot is a pulse again, not a snapshot (2026-07-17).**
  `roster.onChange` fired only when `rosterKey` changed, and the key was `sessionId:isActive`
  — so `status` (which the tab's busy dot reads) and `isOpen` (which decides live-vs-replay)
  could change without anyone being told. The dot therefore showed whatever was true when its
  tab was created. Worse than frozen: when an unrelated session crossed the 60s `isActive`
  window the key changed, `onChange` fired and every dot silently corrected itself — right by
  accident, at random moments. Same cause, second effect: `rows` is reassigned only on a key
  change, so `roster.current()` served stale records to `openFromDropdown`. The key now
  includes `status` and `isOpen`; `lastActivity` stays out, since it moves on every write and
  would re-render the picker on every poll. Measured live: the dot now follows a real
  busy→idle transition within 1.0s, with no refresh. A closing session also reaches
  `setEnded` at once, instead of waiting up to 60s for `isActive` to lapse.

- **A tab's state is shown, not spelled (2026-07-17).**
  `(self)` and `· ended` were words in the label, competing for room with the subject — which
  is the thing that tells two tabs apart. State moved onto channels that cost no space: the
  dot's **colour** says who (blue = this session, grey = any other), its **pulse** says
  generating, and an ended tab **dims** — everything inside it is frozen history, which is a
  property of the whole tab rather than a badge on it. The dot is 8px, the picker's size:
  it now carries the tab's state, so it is sized as a signal rather than as a decoration. The colours are not new: the picker's
  `.pk-row.self .pk-dot` already said self-is-blue, and blue already beat live green there.
  Rejected along the way: green = self, red = ended. Green already means *generating* on that
  exact dot; red means broken, and an ended session is a first-class replay, not a failure —
  the very confusion that once cost a full debugging cycle; the two states are not even
  exclusive (a self session ends when you quit it while seedeep runs); and red/green alone is
  the one pair ~8% of men cannot separate. On that last point the new design owes a debt the
  words used to pay, so the tab's `title` spells the state out on hover and for assistive
  tech: colour is never the only channel.

- **The tab strip is readable, and it survives a refresh (2026-07-17).**
  Three changes to the workspace shell, one theme: a tab should say which session it is,
  and the set of them should still be there after F5.
  - **Tabs are named `<project> · <subject>`** (subject cut to 30 chars). The label was the
    project alone, so two sessions of one project were two identical tabs. A session with no
    subject (none typed in its head) falls back to `<project> · <short id>`, since two
    subject-less tabs of one project would otherwise collapse together again. One formatter,
    `tabLabel` in `tree-format.ts`, unit-tested without a DOM.
  - **The picker pins the sessions that already have a tab.** Picking one only switches to
    its tab; the pin says so before the click. It is driven by `dropdown.setOpenTabs(ids)`
    from `app.js` on every open/close — NOT by the roster, whose identity key (`rosterKey`)
    is the session set plus `isActive`, and so never changes when a tab opens.
  - **The empty page tells its three states apart**, since restoring an empty workspace is a
    new one: no sessions at all, no live session (first visit), or "no tabs open" — you
    closed them, and a session may well still be live, so the old line would have lied.
  - **The open tabs and the active one are restored after a refresh**, order included, via
    `localStorage` (`tab-store.ts`). The saved workspace WINS over auto-open: a tab you
    closed stays closed, and a session that started since is offered in the picker rather
    than forced into a tab. `load()` therefore separates "never saved" (null → first visit,
    auto-open the live sessions) from "saved, and empty" (`[]` → open nothing). Storage is
    best-effort: reading `localStorage` throws outright when storage is disabled, so both
    the access and every call are guarded, and a dead storage simply degrades to auto-open.

- **Discovery caches session head scans (2026-07-16).**
  The watcher re-discovers every ~300ms, and every discovery re-opened and re-parsed the
  head (up to 64KB, worst case 1MB) of EVERY session file under the roots — hundreds of
  file reads per second on a machine with a long session history, to extract anchors
  (sessionId, model, subject, cwd, entrypoint) that never change once written. Discovery
  now caches the parsed head per path: a completed scan (all anchors found, or the 1MB
  cap reached) is final and never re-read; an incomplete scan (a young session whose
  model/subject lines are not written yet) is retried only when the file changes size.
  Server endpoints (`/api/sessions`, `/api/replay`, `/api/tool-output`) share the same
  cache through `discoverSessions`. Per-tick discovery cost drops to readdir + stat.

- **Every tool toasts again, except the subagent spawn (2026-07-16).**
  `TOAST_NOISE` had grown to six bookkeeping tools, excluded as "high-frequency, fires in
  bursts". Measured against the real logs, that described exactly one of them — `TaskCreate`
  (58% of gaps under 2s, ~7 per session). `ToolSearch` and `TaskList` are ~1 call per session,
  `TaskGet` and `TodoWrite` are never called at all: the list had been written by name analogy,
  not from data. It also suppressed what is now the most legible line in the feed, since
  `TaskUpdate` reads `#1 <subject> → completed` rather than `1`. The set is back to what it
  always meant — **routing, not suppression**: `Agent` stays out because its spawn already gets
  the richer toast on the bottom rail; everything else toasts.

- **Task-family tools are labelled by resolved reference, not by raw id (2026-07-16).**
  A tool's label came from `argOf`, which took `file_path` or else *the first string in the
  input*. Measured over real sessions, that mislabelled 1183 calls: `TaskUpdate` (1119×) showed
  its row number `1`, `TaskOutput`/`TaskStop` (64×) an opaque hex, and `TaskCreate` (585×) was
  right only by key order — one real call already fell through to `description`. `TaskList` (7×)
  showed nothing at all, which is what surfaced the bug: its input is literally `{}`.
  These tools take **references**, so the parser now emits a `taskRef` and the reducer resolves
  it against state it already holds — `taskId` → the subject from the `TaskCreate` result
  (`#1 Fix the parser → in_progress`), `task_id` → the subagent it names, via the same map
  `SendMessage` uses (`docs-researcher`). The label is resolved once, in the reducer, and read
  by both the snapshot and the live feed (`EventContext.label`), so the two cannot drift.
  `TaskList` keeps no argument — an invented one would be fiction. The two task systems are
  kept apart deliberately: the task list spells its id `taskId` (`TaskUpdate`, `TaskGet`),
  background tasks spell it `task_id` (`TaskOutput`, `TaskStop`), and reading the wrong one
  yields no label at all.
  Also: the legacy **`Task` tool is an `Agent`** (its result reads "Async agent launched
  successfully"), but only the name `Agent` was special-cased, so the subagent it spawned never
  entered the tree. Both names now live in one shared `SPAWN_TOOL_NAMES`.

- **Subagent state comes from the spawn, not from the launch receipt (2026-07-16).**
  A subagent was marked `done` when the `tool_result` for its `Agent` spawn arrived. That is
  true for a *foreground* subagent (the result lands when the work is done, measured 148s),
  but a *background* one returns a receipt — `status: "async_launched"` — in **~0.07s**. So
  background subagents were born `done` and the live monitor, which renders only `running`
  ones, never showed a single one for its entire real life. Not a corner case: background is
  CC's default since v2.1.198, measured at **92% of launches** on v2.1.208.
  - The completion signal was in the log all along and unparsed: a `queue-operation` line
    carrying a `<task-notification>` with `<tool-use-id>` + `<status>`.
    It is now an **`agent-end`** event, and only a *foreground* `tool_result` ends a subagent
    (measured: 864/864 foreground results carry `status: "completed"` and never get a
    notification — so foreground behaviour is unchanged by construction).
  - The subagent list is now built from the **spawn** (the `Agent` tool_use), so a subagent
    appears the instant it is launched instead of whenever its child file shows up. The child
    file only enriches it.
  - **States are `running` / `done` / `failed` / `killed`**, plus **`unknown`** — resolved in
    the view, the only layer that knows the session is closed. ~4.5% of background launches
    (20/446) never get a notification; on an ended session they read `unknown` rather than
    freezing on a `running` that cannot be true. `done` is never latched: a `SendMessage`
    resume puts an agent back to `running` (50 real cases have several notifications).
  - **A Workflow run is now visible as one aggregate row.** Its subagents live in
    `subagents/workflows/wf_<runId>/`, which the watcher never descended into — a real
    `deep-research` run's **101 subagents were 100% invisible**. The row reports fleet size,
    how many are still running (from the run's `journal.jsonl`), tokens, and a **model
    breakdown** (a run mixes models per stage: 77 opus + 24 haiku on the measured run), never
    a single model. The fleet is deliberately not expanded into 101 rows. A run's tokens are a
    true per-call sum over its subagents' transcripts, so they count in the session's
    **Subagents** total like any other subagent's, and are never flagged estimated.
  - **A killed Workflow leaves no terminal signal at all** — verified on a real kill: no
    task-notification (a killed *subagent* gets `<status>killed</status>`, a run gets nothing),
    an empty task output file, and a journal frozen on its `started` lines. Silence is the only
    evidence left, so a run that has written nothing for **5 minutes** reads `unknown` on a live
    session. The threshold is measured, not guessed: the longest silence inside a live run is
    113s across 7 real runs (p99 gaps 2.7–16.7s). It is per-RUN on purpose — a single subagent
    can legitimately go quiet for 23min, but a run's agents write as one merged stream — and it
    is derived, never latched, so a run that writes again is `running` again.

- **Usability pass: Session card fusion, ended-session presentation, humanized durations
  (2026-07-16).** The Turns card duplicated the timeline strip (the same distribution twice
  on one screen) and existed mostly as the strip's entry point: it is gone, fused into a
  single **Session** card — the token ledger plus a footer with the whole-session turn KPIs
  (count, interruptions, API calls) and the Explore/Close toggle; the stats row goes 4 → 3
  columns (at ≤1100px Main tools takes the full second row so no orphan cell). An **ended**
  flag now travels app.js → view.js → graph.js (`setEnded()`): on an ended session the
  subagent monitor collapses from a ~215px permanent empty state to a **one-line summary**
  that scrolls to the grid on click (pointer affordance only when there is something to
  scroll to), the pulsing LIVE badge yields to a quiet **ended** badge, the scope banner
  stops claiming "● running" for a turn cut off mid-flight, a feed row with no tool-end
  reads **cut off** instead of a frozen "running…", and the feed is height-capped (it is
  history, not signal). Tool durations are humanized everywhere via a new
  `formatToolMs` (raw ms under 1s, one *truncated* decimal under a minute — never the
  impossible "60.0s" — `formatDuration` above): "18.1s", not "18138ms", one format across
  feed, drawer and tool lists. Terminology unifies on **turns** with singular handling
  ("1 turn"); the Context segbar gains a colour legend; the scope banner declares its
  click affordance ("Timeline ▾"); the subagents grid is titled for what the code does
  (**in launch order** — the old "sorted by output size" title contradicted
  `subagentsChronological`) and gains an empty state; `turnCostStats` slims to `escCount`
  (its other fields died with the Turns sparkline).

- **Session picker polish from code review (2026-07-16).** The keyboard highlight and
  scroll now survive a background roster refresh (they follow the session, not its index);
  ARIA roles added (trigger = combobox, tabs = tablist, list = listbox of options); the
  default tab falls back to Automated only when Human is empty (never an empty greeting);
  empty-state grammar fixed. The dead per-row `auto` class is gone, and the previously
  browser-only interactions (↑/↓, Enter, Esc, click-outside) now have committed fake-DOM
  tests via a synthetic-event dispatcher.

- **Session picker split into Human / Automated tabs (2026-07-16).** At real scale the
  ~1000 headless (`sdk-*`) docs-gate rows buried the ~190 human sessions. The picker now
  opens on a **Human** tab (the sessions you actually pick), with a peer **Automated** tab;
  each tab shows its live count and the search filters the active one. The per-row
  human/automated chip is dropped — the tab conveys the type — while `self` stays.

- **Readable session picker: a searchable glass combobox labelled by subject (2026-07-16).**
  The native `<select>` showed `project · id8` — a path fragment and a hex prefix,
  unrecognisable, and a native `<option>` can't be styled or made multi-line. It is replaced
  by a **custom glass combobox**: a trigger + a searchable popover of multi-line rows, each
  showing the session's **subject** over a `model · date · id` meta line. The subject is the
  session's first task-bearing prompt (typed, a non-control slash command, or a headless SDK
  prompt), skipping `/clear`, `/effort` and other session-control commands; `SessionRecord`
  gains `subject` and `entrypoint`. Headless (`sdk-*`) runs — e.g. the pre-push docs-freshness
  gate's `claude -p` — read as `🤖 automated` so they never masquerade as interactive sessions.
  The derivation reuses the parser's shared `userLineIntent` (so slash-command handling can't
  drift); the discovery head scan became incremental (first 64KB in one read, escalating to
  1MB only when an anchor is still missing) so a session whose head is one huge line still gets
  labelled. `dropdown.js` gains its first test, driven against the real module via the fake DOM.

- **Subagent toast simplified to type-only; fires immediately on spawn (2026-07-16).**
  The toast now shows only the agent type (e.g. "general-purpose") and fires the instant
  the sidecar meta event arrives — no more deferral waiting for prompt/model data that
  diagnostic logs confirmed never arrived in time. Falls back to `"agent"` if agentType
  is absent (e.g. sidecar meta.json missing), replacing the old FLUSH_MAX_TICKS guarantee.
  Dead CSS (`.tprompt`, `.tmodel`) and stale comments removed. Left column narrowed
  (440 px → 360 px min-width) to give more room to the activity feed. Static file responses
  now carry `cache-control: no-store` to prevent stale-bundle issues during development.

- **Graph redesigned as a live-first cockpit; live subagent monitor (2026-07-15).** The bento
  buried the two live signals — context filling and subagents working — among retrospective
  cards, with the subagents grid entirely below the fold. The top row is now a **cockpit**:
  Context (the main session's window) + a new **live subagent monitor** on the left, the live activity feed
  on the right. The monitor shows **only the running subagents**, each with its context filling
  live and its current action; finished ones are not repeated there (the complete, sorted catalog
  stays at the bottom of the page), and when nothing runs a centred placeholder keeps the panel
  from reading as broken. It is height-bounded (scrolls past ~4–5 concurrent) so many active
  subagents never stretch the page. The retrospective widgets drop to an equal-height **stats
  strip** (Token usage · Turns · Skills+Commands merged into one card · Main tools); the redundant
  **Activity** card (per-agent tool-call effort, already implied by the subagent footers and Main
  tools) and its `openMain` drawer are removed. The bottom subagents grid uses `auto-fit` so a few
  cards fill the row instead of leaving dead space. The loading skeleton mirrors the new grid so
  the layout never jumps on load. Running/done is the deterministic parent `Agent` tool-end
  (`endedToolUseIds`), so the monitor's live state is reliable; the active row's elapsed is
  data-driven (`durationMs`), never wall-clock, so a stale 'running' subagent can't tick upward on
  replay. Tests cover the monitor (running-only, placeholder, active-row content).

- **Subagent tokens made comparable to the main Token usage (2026-07-15).** A subagent card
  showed only its LAST API call's context (≈ `toolUseResult.totalTokens`), while the main card
  sums every call — so the two were an order of magnitude apart (a multi-call subagent was
  undercounted by up to ~20x, measured 168x in one real session). The reducer now accumulates
  each subagent's cumulative **volume** — Σ its own per-call `input+output+cache`, from the child
  jsonl, folded once per `callId` like the main sums. The subagent card splits the old single
  "tokens" bar into **VOLUME** (cumulative, no window frame — a volume can exceed the window) and
  **CONTEXT** (final `fill` / window %); the drawer breaks VOLUME into the four usage-block
  categories, paired as **Cache** (read/write) and **I/O** (output/input), with the share shown
  only where it rounds to ≥1%. A background subagent with no child usage falls back to the
  parent-reported total (≈ its final context) and is flagged **estimated** (`~`); the Token usage
  **Subagents** row marks the blend with a leading `~`. The now-dead `AgentNode.totalTokens` field
  is removed. Golden transcript asserts the volume sums every call (the repeated content-block
  line folded) and that `fill` stays the last call; tests cover both the true-sum and estimated
  paths.

- **Token usage card replaces Cache efficiency; token nomenclature standardized to Anthropic's
  (2026-07-15).** The dashboard had no whole-session (or per-turn) token total. A new **Token
  usage** card answers it: the four categories Anthropic names in the
  `usage` block, verbatim so nothing is ambiguous — **Input** (`input_tokens`), **Cache write**
  (`cache_creation_input_tokens`), **Cache read** (`cache_read_input_tokens`), **Output**
  (`output_tokens`) — with the whole-session **total** as the hero and a separate **Subagents**
  row (a background subagent reports one `totalTokens`, never a breakdown, so it cannot be folded
  into the four). It is a VOLUME view, deliberately not price-weighted: cost is ccusage's lane, not
  seedeep's. The reducer now sums `inputTotal`/`outputTotal` per scope (alongside the existing
  `cacheTotals`), folded once per `callId` like every other summed quantity; `scopeToTurn` projects
  them so a selected turn rescopes the card. The **Cache efficiency** card and its selector are
  removed — its raw components (Cache read / Cache write) are visible in the new card, and the
  ratio is derivable. Terminology was reconciled across the GUI to the same official names: the
  scope-banner `Input`/`Output` buttons (which open the prompt / result text, not token counts)
  became **Prompt**/**Result** to end the collision, and loose phrases (`re-read`, `created`,
  `fresh input`, `context hogs`, `context weight`, `burnt`, `consumed`) were retired. See
  `architecture.md` for the field→label mapping and why the totals sum per scope, not per last call.

- **A jsonl line is not an API call (2026-07-15).** Claude Code writes **one line per content
  block** — thinking, each `tool_use`, text — and every one of those lines repeats the **same**
  `usage` block (measured on a real session: 192 assistant lines carrying only 110 distinct
  `message.id`s, one id spanning 4 lines). The cache totals introduced below summed per LINE and
  were therefore inflated ~2x (`read 19,628k / created 264k` where the truth was
  `11,541k / 128k`); `apiCalls` had always counted lines, reporting 171 where 110 calls had been
  made. The parser now carries `callId` (`message.id`) on the usage event and the reducer folds
  every summed quantity — `cacheTotals`, `apiCalls`, a turn's output tokens — once per call,
  falling back to `seq` for `<synthetic>` lines that have no id. The percentage barely moved
  (both terms inflated together, 98.7% vs 98.9%), which is exactly why the first live check
  passed: it compared ratios, and its own expectation summed per line — the same mistake as the
  code under test. Re-verified against the real 25-entry session comparing **absolute tokens**,
  not just the ratio.

- **Cache efficiency is the whole scope, not its last API call (2026-07-14).** The widget read
  `breakdown` — the cache tokens of the LAST call — and called it the session's (or the turn's)
  efficiency. Within one call `cache_read` is the entire conversation prefix while
  `cache_creation` is only the newest increment, so that ratio is pinned near 100% by
  arithmetic: across real sessions 91% of calls sit above 90%, and a session at rest very often
  renders exactly `100.0%` (17.7% of session files end on a call that created no cache at all).
  On a selected turn it was worse than useless, because a turn's last call is its final answer —
  structurally its cheapest: turns that had re-created 600k+ tokens of cache were painted a green
  99%, and one healthy turn (92% over its 19 calls) was painted crit red at 4.5% because its last
  call took a miss. The reducer now keeps the two apart: `breakdown` stays the last call and
  drives the Context bar (the window's composition *right now*), while the new `cacheTotals`
  (`{read, created}`, per session AND per turn) is summed over every call in scope and drives the
  widget. Being a sum it is not idempotent, so it is folded once per `seq` — the stream re-sends
  the high-water line after a reconnect — which also fixes the same latent double-count in
  `apiCalls` and a turn's output tokens. Verified live against a real 25-entry session: every
  entry now matches the ratio recomputed straight from the jsonl; 18 of the 25 were wrong before.

- **The tool drawer shows what the tool RETURNED (2026-07-14).** It showed the output's size
  and not a character of the output itself — the payload that actually entered the context.
  Keeping every `tool_result` verbatim in the client was never an option (a session's tool
  outputs together are tens of MB), so the text is read back **on demand** from the session's
  own jsonl: `GET /api/tool-output?sessionId=&toolUseId=` (`src/tool-output.ts`), scanning the
  main file then its subagent children, anonymized through the same `anon` the parser uses
  (extracted to `src/text.ts`, shared by both) and capped at 20k chars while reporting the
  true length. The drawer previews the first 500 chars; "show full" opens it verbatim in a
  `<pre>` (tool output is a file/diff/log, not markdown — rendering it as markdown would eat
  its indentation). A tool that returned nothing costs no round trip.

- **Live-activity rows open the drawer (2026-07-14).** Every other widget could be opened;
  the feed's rows only *looked* clickable (they had a hover highlight and no handler). They
  now open the same drawer the rest of the dashboard uses — a spawn row opens the subagent it
  launched, any other row opens its tool. The row carries only the `tool_use_id`, so the
  snapshot now keeps it (`ToolNode.id`) along with a subagent's spawn id (`AgentNode.toolUseId`),
  and the click resolves against a **freshly built** snapshot: a tool that ended after the row
  was drawn opens with its real duration and output size, and the feed never keeps a second
  copy of tool state that could drift from the reducer's. A running tool now reads "running…"
  in the drawer instead of an ambiguous "—".

- **A tab loads behind a loader, then paints once (2026-07-14).** Opening a tab replays the
  session's whole jsonl through the reducer, with the view already subscribed — it mounts
  first. The reducer rebuilt a full `snapshot()` on every one of those events (O(turns +
  tools + agents) each, so folding a session was O(n²)) and the view painted through the
  flood: an 11k-line session (23k events, 144 turns, 160 subagents) took **9.3s** to settle,
  assembling itself card by card on every refresh. Three changes: `onChange` now signals
  without building a snapshot (the listener pulls it when it paints — it was throwing every
  one of them away); the Graph accepts `{ loading: true }` and paints nothing until
  `goLive()`, which draws the finished session in one pass and arms live toasts; the tab
  shows a skeleton loader meanwhile, dropped at the replay→live handoff (which `startReplay`
  guarantees to fire exactly once, so it cannot hang). Same session now: loader for 456ms,
  one paint at **583ms**, stable from there.

- **A command counts against its OWN entry; the two counters stop contradicting each other
  (2026-07-14).** Follow-ups to the timeline change. The parser emitted `command` *before*
  `user-turn`, so the reducer credited it to whatever turn was still open: scoping to a
  `/model` showed an empty Commands widget while the unrelated turn before it claimed to have
  run it — the turn opens first now. The strip read "Turns · 13" beside a widget reading 11
  (entries vs work turns): it now says "Timeline · N sent · M turns", so the difference is the
  information rather than a bug. The feed named the same selection differently from the banner
  ("Turn 2 activity" vs "Local command /model") — one shared helper names it once. And an
  entry with no API call showed `0.0%` cache in critical red; it reads `—` ("no API call in
  this scope"), because nothing was measured is not the same as measured catastrophic.

- **The timeline shows everything you sent — slash commands included (2026-07-14).** A
  `/paste-image …` round produced **no turn at all**: slash-command lines carry no `origin`,
  and the parser gated turns on `origin.kind: 'human'`, so it dropped them whole. Nothing was
  ever live while Claude worked, the round's `turn_duration` overwrote the previous turn's,
  and the Commands widget was empty in every real session. The parser now treats a user line
  as user-sent when it is human-origin **or** carries `<command-name>` (the args are the
  prompt), and the reducer classifies each entry by what it COST: `work` (consumed tokens),
  `local` (a command that burnt nothing — no list of built-ins to maintain, the token count
  is the proof), `context` (`/clear`, `/compact` — the two commands whose job is to move the
  window). `state: 'live'` now means *burning tokens*, not merely *open*, so a `/model` —
  which nothing ever closes — can no longer pulse green forever; `turns` still counts only
  rounds of work. Zero-cost entries get a stub bar so nothing you sent is silently omitted,
  and each kind has its own colour. New `tests/golden-transcript.test.ts` runs REAL-shaped
  jsonl lines through the real parser and reducer — the test class that was missing, and the
  only one that could have caught this: every other test fed the reducer hand-built events,
  encoding the same wrong belief as the code.

- **The full prompt actually exists now; "Whole session" closes the strip (2026-07-14).**
  The Input button never appeared on a truncated prompt, and the reason was upstream of the
  UI: the parser stored only the **first line, capped at 200 chars**, so nothing was
  overflowing (the CSS had nothing to cut) and the "open it in full" view had nothing to
  open. `user-turn` now carries the WHOLE prompt (same 20k cap and `anon()` pass as a turn's
  result); the GUI derives its one-liner with a shared `promptLine()` (banner, strip
  tooltips, filtered rows) and reveals **Input** whenever what you see is not what you typed
  — data shortened (known outright) or line ellipsized (measured). "Whole session" now also
  closes the turn strip, matching "Close": it is the way out of turn mode, and leaving the
  picker open left the view in a half-state.

- **Code-review fixes: toast machinery, flat reducer, dead event type (2026-07-14).**
  Three real defects, none of them cosmetic. (1) **Tab freeze**: forced toast eviction bailed
  out on a toast that was still fading (a dismissed node stays in the DOM for 320ms), so the
  eviction loop kept picking it, never removed it, and spun forever on the main thread —
  `dismiss(node, now)` now removes unconditionally when forced. (2) **Subagent toasts
  vanished past 5 concurrent spawns**: the bottom rail evicted `lastChild` — the toast just
  appended — because `row-reverse` was mistaken for DOM order; the oldest is `firstChild` in
  both rails. (3) **The flat session reducer showed a subagent's fill as the main session's**:
  `session-state.ts` applied `usage`/`attribution` without checking `agentId`, and in replay
  the child files are read last. Ownership is now decided there, and subagents are derived
  from `agentId` — which also let the **dead `subagent` event type** go: it had no producer,
  so `Snapshot.subagents` was always empty (it reported `subagents: 0` forever) and tests
  synthesized an event the wire never carries. Also: the deferred-toast loop is now bounded
  (a subagent whose model never arrives no longer spins it at 16 ticks/s for the tab's life),
  fired timers no longer accumulate, `flushPendingToasts` gets the full snapshot (a queued
  toast could not resolve while a turn was selected), and `render()` reuses the snapshot
  `onChange` already built instead of rebuilding it per event. The toast machinery had **zero
  tests**; it now has four, including the freeze and the eviction-order regressions.

- **Turn scope reaches every widget; prompts and results render as markdown
  (2026-07-14).** Selecting a turn left three widgets lying. The **activity feed**
  ignored the selection entirely (it folds raw events, never the snapshot): its ring now
  carries a `turnIndex` — handed to `onEvent(e, ctx)` by the reducer, the only layer that
  knows it, and for a subagent's event it is the turn that *spawned* it — and retains the
  last N activities **per turn** instead of globally, so any turn is scopable, not just the
  last. **Commands** and **skills** showed session-wide counts on a scoped turn (`/clear ×3`
  on a turn that used it once): `TurnNode` now carries its own `SkillNode[]`/`CommandNode[]`
  with turn-local counts, and `scopeToTurn` reads those instead of filtering the session's.
  Fixed: expanding the activity list via "+N more" dropped the selected turn's result block
  (the callback re-rendered without the full snapshot). New `public/markdown.js` renders
  prompts/results in the modal (headings, fenced code, lists, tables, quotes, inline
  code/bold/italic/links) building DOM nodes only — **never `innerHTML`**, since session
  text is untrusted; non-`http(s)`/`mailto` links stay literal text. The scope banner gains
  an **Input** button that opens the full prompt, revealed by a `ResizeObserver` only when
  the one-line banner actually truncates it.

- **Turn management — scope the GUI to a single turn (2026-07-13).** Turns are now a
  first-class navigable concept. The reducer tracks a `TurnNode` per user turn (prompt,
  state `done`/`interrupted`/`live`, `deltaFill`, `apiCalls`, tool and subagent IDs, skills,
  commands, result text). Parser gains four new events: `user-turn` (with `prompt` + `uuid`),
  `turn-end` (`system/turn_duration` line), `turn-interrupted` (next user row carries
  `interruptedMessageId`), and `turn-result` (main-session `end_turn` assistant text). All
  user-generated text (prompts, results) passes through `anon()` before storage. Two new
  selectors: `scopeToTurn(s, idx)` returns the same `TreeSnapshot` shape filtered to one
  turn (so all existing widget renderers work unchanged), and `turnCostStats(s)` summarises
  interrupted-turn overhead. The Graph view gains a sparkline navigator (bars coloured by
  state) and a turn-explorer strip with filter chips; clicking a turn scopes all widgets to
  that turn; a scope banner confirms the selected turn and offers a "Whole session" exit.
  Test coverage: 8 new parser tests, 5 reducer tests, 7 selector tests, and a synthetic
  6-turn fixture (`tests/fixtures/turns-sample.jsonl`) with one interrupted turn and one
  compaction.

- **Client data layer split out of the renderer (2026-07-12).** The derivations the
  Graph view was computing inline now live in two DOM-free modules: `client/selectors.ts`
  (cache efficiency, subagent ordering by weight and by launch time, context hogs, bar
  denominators, consumed tokens, skill share) and `client/feed.ts` (the live activity
  ring: timestamp ordering, capping, tool-start↔tool-end correlation). Both are pure and
  unit-tested (17 new tests); `graph.js` is now rendering only. Every surface reads these
  instead of recomputing — the drift below is what recomputation costs.
  Fixes two defects found in the process:
  - `graph.js` had reimplemented `formatDuration`/`formatLaunchTime` instead of importing
    them, and the copies diverged: a running subagent rendered `—` in the cards and drawer
    while the feed said `running…`, and a sub-second tool was labelled `0s`. The tested
    originals were dead code. The view now imports them; raw ms are kept in the feed, where
    that precision is the point.
  - `.toast.out` referenced a `@keyframes toastOut` that no longer existed (dropped when the
    horizontal rail introduced `toastOutRow`), so column-rail toasts sat still for their
    320ms removal delay and then vanished abruptly. The keyframe is restored.
- **Flat client bundle pinned with `--root src/client` (2026-07-12).** `bun build` infers a
  common root from the entry list; past nine entries it resolved to `src/` and silently
  emitted `public/lib/src/client/*.js`, breaking every `./lib/*.js` import in `public/`.
  The root is now explicit, so the layout no longer depends on how many client modules exist.

- **Drawer scroll-lock + symmetric launch-prompt modal (2026-07-12).** Opening the
  Graph drawer now locks page scroll (ref-counted across tabs, on `<html>`+`<body>`)
  so the page can't scroll behind it. The subagent launch prompt is handled like the
  returned output: truncated in the drawer with a "show full" button that opens the
  full text in the read-only modal — removing the nested scrollbar the long prompt
  used to grow.
- **Renamed plumb → seedeep (2026-07-12).** Project, npm package, and brand
  renamed. The tagline becomes *"See deep into your agent's context."* The
  read-only architecture and all behavior are unchanged; only names/strings moved.
- **Graph view redesigned as a live bento dashboard (2026-07-12).** The textual
  tree is replaced by the design-prototype bento layout, all driven live from the
  session logs: a context dial + real token breakdown, cache efficiency, a skills
  widget (turns driven + explicit invocations per skill — never a fabricated
  per-skill token figure), an activity/effort widget, collapsed main tools with
  the biggest context hogs first, a bounded live-activity feed, and a subagents
  grid. **The differentiator:** each subagent now surfaces the verbatim output it
  returned to the main session — read from the child jsonl's final `end_turn`
  message, which covers both synchronous and background (`isAsync`) subagents (the
  background parent tool_result carries no output) — plus its launch prompt, real
  duration (child first↔last timestamp), the tools it called (with args + output
  sizes), all in a right-side drawer with a read-only output modal above it.
  Cyan/purple toasts announce new tools/subagents live. Every session-derived
  string (paths, prompts, output) is anonymized before it enters an event, so
  screenshots are safe to publish. New normalized event `subagent-output`; the
  live-stream and replay drivers now share ONE `EVENT_TYPES` list
  (`event-types.ts`) so a new type can't be wired to one path but not the other
  (the same bug class that previously dropped tool/subagent events). Verified
  live == replay through the real server path and end-to-end in a headless browser.
- **Readable Graph tree — collapsed main tools + enriched subagents (2026-07-12).**
  The main session's tools are now a single collapsed, expandable summary (count +
  per-name breakdown, e.g. `476 tools · Bash×156 · Edit×116 · …`) instead of one
  row per tool, so a long session's tree stops burying the structure. Each
  subagent node now shows its `agentType`, model, absolute launch time, and
  duration (running subagents show `running…`, never a fake number); the opaque
  child-file id moves to a hover tooltip. Reducer (`session-tree.ts`) derives
  `startedAt`/`durationMs` from the spawning tool matched by `toolUseId`; a new
  DOM-free `tree-format.ts` holds the pure formatters. Also fixes replay:
  `startReplay`'s event-type list omitted `tool-start`/`tool-end`/`subagent-meta`,
  so replayed sessions had no tools and un-enriched subagents (same class of bug
  as the earlier live-stream fix, now kept in sync). Verified live and in replay
  on a real 476-tool / 8-subagent session.
- **Session openness & self-detection (2026-07-12).** "Which session is mine" and
  "is a session live" now come from `~/.claude/sessions/<PID>.json` (a file that
  exists only while a session is open), not from a fragile 60s mtime window or a
  cwd+recency guess. `resolveSelfId` trusts `CLAUDE_CODE_SESSION_ID` when present,
  else the single open session whose cwd is path-related to seedeep's, else marks no
  self (never guesses). `SessionRecord` gains `isOpen` + `status`; tabs open per
  open session, freeze when the session's process closes (not on a silence timer),
  and show a busy/idle dot. The mtime window survives only as a 5-min fallback.
- **Live SSE event delivery fix (2026-07-12).** The browser client only listened
  to `usage`/`attribution`/`compaction`/`subagent`, so the Graph view's
  `tool-start`/`tool-end`/`subagent-meta` events never arrived live (subagents
  stuck "running", no tool timings, no region chips). The per-session dedup was
  also wrong: subagents restart their `seq` per child file, and one transcript line
  emits several events sharing a `seq`. Dedup is now keyed by `(sessionId, agentId)`
  and drops only strictly-earlier lines, so live reconstructs the same tree as replay.
- **Graph view — DOM (2026-07-12).** The first real visual view replaces the
  Graph stub: a live session → subagent → tool tree with per-node timing, a
  context-fill bar (real token breakdown — cache-read / cache-creation / input —
  with output shown separately), skill/MCP chips, and compaction nodes with real
  `pre→post` numbers. The `%` denominator comes from a `data/context-windows.json`
  `model → window` map (deterministic from the model, so it works identically live
  and in replay). New normalized events (`tool-start`, `tool-end`, `subagent-meta`)
  and an `agentId` tag let the parser stay pure while a new client `session-tree`
  reducer correlates tool timing and derives subagent running/done. Fixes a latent
  bug where a subagent's usage overwrote the parent's context fill, and makes
  replay read subagent children so it reconstructs the same tree as live.
  See `docs/architecture.md`.
- **GUI shell (2026-07-11).** A tabbed single-process GUI: one tab per active
  session at launch, a dropdown of all sessions (active + inactive), per-tab
  subscription over the single multiplexed SSE feed (client-side demux, no
  connection leak), and replay of finished sessions via a read-only
  `GET /api/replay?sessionId=` SSE endpoint. Events now carry a per-file `seq`
  for exact replay↔live dedup. The per-tab view is a stub for now.
  See `docs/architecture.md`.
- **Local server (2026-07-11).** A single-process server bridges the watcher to
  the browser: a static page, a read-only session roster (`GET /api/sessions`),
  and a single multiplexed Server-Sent Events stream (`GET /api/stream`) tagged
  by `sessionId`. Server→browser only — the read-only invariant holds end to
  end. Auto-opens the browser on start (`--no-open` / `--port`). See
  `docs/architecture.md`.
- **Core engine.** Read-only, runtime-agnostic TypeScript watcher + parser:
  multi-root session discovery, deterministic self detection, incremental
  file tailing, and a normalized per-session event stream (context fill,
  attribution, compaction, subagent tree). See `docs/architecture.md`.
- **Documentation.** Initial `docs/` with the architecture overview and this
  changelog.
