# Changelog

All notable changes to seedeep, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Everything released before `0.20.0` — including the pre-publication development diary that the
`0.13.0` heading holds — is kept unedited in [`CHANGELOG-archive.md`](CHANGELOG-archive.md).

## Unreleased

### Fixed

- Custom slash commands are read as commands again. Claude Code 2.1.237 began writing
  `origin: {kind:"human"}` on a command defined by a `.md` file (measured over 1046 session files:
  0 of 97 such lines up to 2.1.234, then 25 of 25; built-in commands like `/clear` still carry
  none), and `userLineIntent` decided what a line was from its owner before its shape. Every custom
  command was therefore filed as an ordinary typed prompt: no row in the Commands card, no per-turn
  command count, and a prompt shown as the raw `<command-message>` markup. The shape is now read
  first, which is what the function's contract already stated. `/code-review`, which writes only the
  untagged shape, is recovered by the same change. Re-reading the whole corpus, 32 lines change
  classification and 39,346 do not: older sessions parse exactly as before.
- The schema probe could not start. The folder-trust gate opens with "No, exit" selected, and the
  driver confirmed whatever was highlighted, so every run quit Claude Code and then failed on
  `the TUI never became ready`. It now reads the selection, walks to the trusting option only if
  that is not already where it sits, and confirms nothing until the screen shows it landed. This is
  why the regression above went 39 releases without being caught.
- The probe's Ctrl+B scene could no longer happen, so the claim about `backgroundedByUser` came
  back unproven on a version where nothing was wrong. Claude Code blocks a long foreground `sleep`
  and answers the tool call with prose telling the model to pass `run_in_background: true`, which
  it does, so the command was already in the background before the probe could take it there. The
  scene now holds `perl -e 'sleep 47'` in the foreground, pre-approved by a `settings.local.json`
  the probe writes into its own throwaway directory, since `sleep` was auto-approved and `perl` is
  not. Driven on 2.1.251, the receipt carries `backgroundedByUser: true` beside `backgroundTaskId`,
  the shape the claim asserts. The scene and the claim both find the command by the `perl -e ` prefix
  rather than by the whole string, since the model retypes it and may quote it either way.
- The README's two loudest figures could not be reproduced by a reader. "39 of 47 failed calls were
  the last line their session ever wrote", measured once over 1830 transcripts, comes back as 3 of 8
  on a 770-file corpus, and "a quarter of every token spent" carried neither a date nor a corpus.
  The failed-call bullet now states the mechanism, which is what a reader can check, and the token
  figure is replaced by one that names its date, its corpus and its method.
- `docs/features.md` gains *Checking the numbers yourself*: the ten lines that recompute the token
  split straight from the session files, including the deduplication that a naive sum gets wrong.

### Added

- Contract claim **C28** holds Claude Code to the two values `origin.kind` takes on a `user` line,
  `human` and `task-notification`, and to writing the field at all. The untagged command shape is
  admitted on exactly those two plus no origin, so a third kind makes one command read as a prompt,
  and an `origin` that went away makes every task notification read as a command — neither with
  anything anywhere reporting it. `docs/claude-code-upgrades.md` gains the same row in its
  closed-vocabulary table.

## 0.31.2 (2026-08-25)

### Changed

- Every public document rewritten to read as a reference rather than as a pitch. The prose carried
  the register readers associate with generated text, and the count that made it measurable was
  1094 em dashes across 16 files. Removed, along with 20 paragraphs closing on an aphorism, 436
  bold spans wrapping a whole sentence, and 29 of the 54 "deliberately / on purpose" that defended
  a choice the following clause already explained. No figure, table or admission was touched: the
  pass took out voice, not evidence, and the corpus lost 11% of its words.
- `README.md` leads with the install command, which sat at line 149 of 257 and is now in the first
  screen.
- The explanation of why the installed tray cannot read `SEEDEEP_HOME` lived in both
  `CONTRIBUTING.md` and `configuration.md`. It now lives in `configuration.md`, which owns the
  variable, and `CONTRIBUTING.md` links to it.

### Added

- `apps/server/tests/docs.test.ts` gains `no em dash in a public doc's prose`, blocking, over every
  tracked markdown but the changelogs. It reads the file rather than the diff, which is what lets it
  exempt headings, fenced blocks and backtick spans: an em dash inside backticks is a literal
  seedeep prints (`Waiting for your approval — Bash`) and rewriting it would make the doc false.

## 0.31.1 (2026-08-21)

### Changed

- Dependency maintenance only — nothing here reaches a running seedeep. `@biomejs/biome` moves
  2.5.7 → 2.5.9; it is a development dependency, so the distributed binary never carried it. The
  `Swatinem/rust-cache` action that caches the tray's Rust build in CI and in the release workflow
  is re-pinned to a newer commit, which changes how those two jobs cache and nothing that ships.

## 0.31.0 (2026-08-19)

### Added

- Sessions hosted outside the terminal — the desktop app's **Code** tab, and headless runs — now
  carry a live state. Those hosts drive Claude Code over its stream-json interface rather than the
  terminal REPL, and that path publishes no session state at all, so every live surface had nothing
  to say about them: no working band, no tray notification, no sign that one had stopped on you.
  The state is now read off the transcript, for those sessions alone — a session that publishes its
  own is never second-guessed, even when the value is one seedeep does not recognise. A session
  reads the same on screen whichever host it runs under, because the claim is the same claim. It
  reaches *working*, *idle*, and a question the model asked you; a tool waiting for your approval
  stays invisible, because a call awaiting a yes and a call that is running are the same line, and
  that limit is documented rather than drawn.

### Fixed

- A turn now closes on the model's own end of turn when its host writes no end-of-turn marker.
  Sessions from the desktop app and from headless runs never write one, so each of their finished
  turns was superseded while still open and filed as *interrupted* — the mark that says you pressed
  Esc — and none carried a duration. The close is provisional: work arriving afterwards reopens the
  turn, and Claude Code's own marker still overrides it with the real duration when it comes.

## 0.30.1 (2026-08-17)

### Changed

- The landing copy states what is missing rather than complaining about it. The README opened on
  *"A Claude Code turn tells you nothing while it runs"*, which is refutable in one reply — the
  terminal does show the tools it runs and the text it writes. What it does not show is the work:
  how many calls, how much of the context is being read again, what each subagent is spending. The
  opening is now **"A Claude Code turn shows you its output, not its work."**, and the paragraph
  under it no longer claims there is "no account of what it cost", since `/cost` gives one.
- The npm page said seedeep makes visible what a session **hides**, which reads as an accusation of
  intent. It says `does not show you` — the same fact, with nothing attributed to anyone.

## 0.30.0 (2026-08-17)

### Added

- `capture-demo.ts social` — the launch clip: one continuous shot of a session's last turn running,
  the page scrolled through what the turns before it produced, and the Trace. A verb of its own
  rather than another cut inside `shoot`, so a change made for a clip cannot re-frame the five
  published README figures; the recorded bundle and the replay are shared.
- `docs/assets/launch-poster.png` — the clip's poster, cut by the same run at the one moment every
  live surface is on screen at once: the window climbing, the subagents running with their own
  windows and models, a background command still going. A real screenshot rather than a frame pulled
  out of the video, which carries the recording's compression.
- `apps/server/scripts/demo-tracker-mcp.ts` — a tracker that does not exist, three invented issues
  served over stdio, so the Cards surface can be captured from a synthetic session. Registered at
  user scope in the capture's throwaway profile: Claude Code asks for approval before using a
  project-scoped `.mcp.json`, and an unattended recording has nobody to answer.

### Changed

- The tagline is now **"See deep into what Claude Code is doing."**, in the README, on the npm page
  and in `seedeep --help`. It replaces *"See deep into your agent's context"*, and both halves of
  that are deliberate. *Context* went because the context window is one surface of the tool rather
  than its perimeter — what the tool shows is what Claude Code is doing at each moment, and the
  window filling is a consequence of that. *Your agent* went because seedeep reads Claude Code's own
  session files and works with nothing else, so the wider word promised more than it does.

### Fixed

- The privacy claim is now exact on the three surfaces a newcomer meets first. The README, the npm
  page and the repository description each said that nothing is sent anywhere, while seedeep does
  make one outbound request on its own — the update check against `registry.npmjs.org`. What never
  leaves the machine is the session content, which is what the claim was about; the check, and the
  `seedeep update --offline` that skips it, are now named beside it. `SECURITY.md` and
  `docs/install.md` already stated it precisely, and their wording is what the three borrow.
- A recorded scene now waits for the marker of its OWN prompt. A background task finishing injects a
  `<task-notification>` user line, which is a turn carrying its own `turn_duration`, and a wait
  keyed on the next marker was satisfied by it — so a scene was declared finished while it was still
  working, the following prompt landed in a busy session, and one prompt disappeared entirely with
  its steps drawn inside the turn before it.
- `Scene` was used in `capture-demo.ts` and never imported — a type error carried unseen because
  `apps/server/scripts` is not in the tsconfig `include`.

## 0.29.0 (2026-08-17)

### Added

- `docs/api.md` — the HTTP reference: every route with its parameters, response type, status
  codes and error shapes, the auth model, the caching rules and the SSE wire format. The endpoint
  list was prose inside the architecture document before, which is how two routes came to be
  documented by a single wrong line each and `GET /api/search`'s required `q` was never named at all.
- `docs/configuration.md` — the config file and its schema, the precedence chain, the security
  model, the TLS certificate, the browser auth flow, the Settings panel and `SEEDEEP_HOME`, split
  out of the architecture document.
- `docs/session-output.md` — one reference for what a session produced: its commits, the files
  those commits delivered, and the tracker cards it worked on. It replaces `commits.md`,
  `changed-files.md` and `cards.md`, which documented three cards of one row, fed by one pass over
  the transcript, in three files: the git posture was stated twice, the repository-identity rule
  could only be understood with two files open, and a change to `transcript-scan.ts` obliged a
  reader to check all three.
- `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1) and GitHub issue forms for bug reports and
  feature requests. The bug form asks the reporter to redact real paths, project names and prompt
  content before attaching anything.

### Changed

- **The public documentation was audited file by file against the code, and about forty factual
  errors were corrected.** Among them: the documented config schema omitted the whole
  `notifications` subtree; `/seedeep` was described as three commands when it has eight;
  `seedeep update` was documented as never contacting the registry when it always does; the parser
  was said to read only assistant lines when it reads six line types; the normalized-event table
  was missing four of the twenty-one events; the tray was described as reading one endpoint when it
  reads four; and the CI description named two jobs where three run.
- The changelog now follows Keep a Changelog. Everything before `0.20.0` — including the
  pre-publication development diary that had accumulated under the `0.13.0` heading — moved
  unedited to `docs/CHANGELOG-archive.md`.
- The documentation states current behaviour rather than narrating how it got there: the history of
  superseded designs, the internal decision dates and the one-machine measurements that justified
  choices already made are gone from the references and remain in git and the changelog.
- Windows is documented as one platform rather than two architectures. The x64 server and the x64
  tray installer have now been driven through the same lifecycle the arm64 ones had already
  answered, so the platform table carries a single Windows column, *Running it on Windows* stops
  asking for a contribution nobody could make, and the tray's known limits no longer name an
  untouched build.
- The animated tray icon's CPU cost is no longer documented anywhere, macOS measurements included,
  and the Windows first-launch warnings in `docs/install.md` describe the way through without
  quoting each dialog verbatim.

### Fixed

- **A round cut off by a killed session now closes where it was cut.** Claude Code writes no
  `turn_duration` for a round whose process died, and a transcript only appends, so that record
  will never exist: the turn stayed `live` for good, running a clock nobody was working under and
  counting it into the session's total — over an hour of "work" on a session that had been idle
  since the kill. On re-entry Claude Code injects "Continue from where you left off." and answers
  "No response requested.", and that receipt is the only record the round is over; it now closes
  the turn, exactly as an Esc does. Its text is no longer taken for the model's stated intent (the
  INTENT panel quoted it back at the reader for as long as the session stayed idle), and its
  all-zero usage block raises no API call on any surface — not the header's count, not the feed's
  row, not the Trace's span, which had been left disagreeing with each other. A round that called
  nothing is left alone: closing a bare `/model` would have promoted it to an interrupted work turn.
  A call that FAILED is not the same thing and is still counted, still speaks, and still leaves its
  turn open to a retry. A cut-off round is `interrupted` like one stopped with Esc — both ended
  before finishing — but it is no longer counted AS an Esc: the retrospective's "abandoned to Esc"
  and the verdict's "interrupted again — second correction in a row" are claims about how the user
  works, and a session that died corrected nothing. The aggregate cache version is bumped with it,
  since both the turn's presence and its Esc flag are values a cached summary already holds.
- **A replay that was cut now finishes its own history instead of leaving the tab short in
  silence.** The server sends the parent transcript whole and only then each subagent child, so a
  connection cut anywhere in the child phase delivered all of the main session and none of the
  subagents: rows with no duration and no volume, no subagent activity in the feed, and a session
  token total short by everything the children spent — with nothing on screen saying the history
  was partial. Recovery existed but had to come from outside (a live-stream reconnect, or the
  session being resumed), and a tab whose session had ended was offered neither, so the gap lasted
  for the life of the page. A read that ends any way other than `replay-end` now reopens itself
  after a wait that doubles up to 30s, asking only past what each file it holds is complete on —
  never past the line it died on, since a line is several events and the read can stop between two
  of them. Until the history is complete the live feed is held rather than applied: applied, it
  would put the newest turn ahead of every turn preceding it, and its frontier would be read as
  proof the tab holds everything below it — so a tab holding three lines and a stray tail line
  resumed past the whole middle and then called itself complete. The reopen gives up only when the
  roster says the session no longer exists (a deleted session answers 404 forever, and an
  `EventSource` cannot read a status) or when three consecutive attempts gain no ground — futility,
  never a count, so a slow or flaky path is never penalised however many rounds it takes. Either
  way it releases what it holds rather than keeping the loader up for a history that is never
  coming, and a tab that gave up keeps its live frontier untrusted so a later resync cannot ask
  past the middle it never read. An ask from outside — the live stream recovering, the session
  being resumed — starts its own budget rather than inheriting the spent one. Nothing the tab
  already holds is applied twice: a re-read arrives from the top of a line, and the tab skips
  exactly the events it holds of it. The reducer would have survived the duplicates; the feed, the
  Trace and the toast rail would not — a second row whose first never gets its duration, a span
  stuck on `running`, and a toast for a tool that ran minutes ago.
- **The Context card no longer empties itself on a line that never called a model.** Claude Code
  stamps `<synthetic>` on lines that reached none — the "No response requested." it writes when a
  killed session is resumed, and API-error lines — and gives them a `usage` block all the same,
  structurally a call's and all zeros. The reducer took it as the window's newest state, so the
  card read `0 / 1.0M · 0%` with the model chip and the denominator intact, until the next real
  call arrived; on a session resumed and then left idle, that is until the user types again. A
  subagent's own context bar had the same hole on its own branch. Both now refuse a usage line
  that names no model AND reports no tokens.

## 0.28.1 (2026-08-16)

### Fixed

- 0.28.0 was tagged and never published: its release run went red on a faulty assertion in the
  release gate, not on a defect in the product. This is the version that ships what 0.28.0 carried.
- Windows arm64: the `0xC0000005` crashes seen when running the x64 server binary belong to Prism,
  Microsoft's emulation layer — 7 survivals in 10 under emulation against 10 in 10 on x64 silicon,
  same timing signature as the crashes measured by hand. The x64 binary is cleared on the hardware
  it ships for.

### Changed

- Release pipeline hardening: the full build and every release gate now rehearse on the pull
  request that bumps the version, publishing nothing, and a single `Release rehearsal` check must
  be green before that pull request can merge.

https://github.com/duqaXxX/seedeep/releases/tag/v0.28.1

## 0.28.0 (2026-08-16)

### Added

- Every released binary is now run, not merely started, before a release can publish: CI drives
  each asset through repeated starts with an idle window — catching a binary that passes a startup
  check and dies ten seconds later — and through the full detached start/stop/restart lifecycle.
  The Windows x64 binary additionally runs on two runners, native and emulated, so a crash can be
  attributed rather than assumed.

### Changed

- Windows on arm64 is a platform that has been used rather than only reasoned about. Five of the
  six open questions are answered: the tray installer runs, the icon reads at notification-area
  size, the popover opens upward at full height against a taskbar at the bottom, trust-on-first-use
  works, and notifications are delivered. What is still open is SmartScreen's exact wording — and
  every x64 build of either app is still started by CI and used by nobody.

### Fixed

- The README, `docs/install.md` and `docs/tray.md` said the Windows fixes "await a build somebody
  can run" and that the tray "got no further than the popover". Both had been untrue since 0.27.1.

https://github.com/duqaXxX/seedeep/releases/tag/v0.28.0

## 0.27.2 (2026-08-15)

### Fixed

- Windows: refreshing the portal flashed console windows across the screen when seedeep had been
  started detached, by `seedeep start` or by a restart. All eight places the server spawns a
  subprocess — git, the liveness prober, openssl, both halves of `self-update`, the browser opener,
  the detached server and a restart's successor — now suppress the window; `git.ts` runs one git
  per commit, which is why a single refresh produced a burst of them.

https://github.com/duqaXxX/seedeep/releases/tag/v0.27.2

## 0.27.1 (2026-08-15)

### Fixed

- `seedeep restart` could end with the old server stopped and no replacement running at all. The
  guard 0.27.0 described was never actually in the shipped code, so a shutdown that failed took the
  process down where it stood. The handover now survives a shutdown that rejects, gives up at a
  deadline on one that never settles — this server holds SSE streams open with no idle timeout —
  and waits for one that succeeds, so the port is free when the successor asks for it.

https://github.com/duqaXxX/seedeep/releases/tag/v0.27.1

## 0.27.0 (2026-08-15)

### Fixed

- Windows: `seedeep restart` left the old server stopped and no replacement running. The successor
  was spawned while this process still held the socket and lost the race, reporting
  `Failed to start server. Is port … in use?`. The listener and the connections held open on it are
  now closed before the successor is spawned, and the shutdown is awaited rather than raced.
- Windows: the tray flashed a console window when it started and when it stopped the server. All
  three processes it launches now suppress it.
- Windows: `seedeep status > file` left the console's own error lines as mojibake and
  `seedeep serve 2> file` wrote a degraded file — the encoding was chosen for both streams from
  stdout alone, and is decided per stream now. A pipe on a Windows console is still not covered,
  and is written down as a limit rather than left to be discovered.
- Windows: the console encoder also wrapped the server's redirect into `server.log`, a UTF-8 file
  no code page touches. It applies to a terminal only now.
- Windows: an empty host in a stored server record resolves to *this machine* there, so the tray
  accepted a malformed record that macOS rejected. An empty host is now refused before either
  resolver is consulted.
- A button in the tray's panel did nothing about one click in ten. The live view is replaced
  wholesale once a second, and a press lasts about a tenth of that, so the button could be swapped
  out between press and release — no action, no error, nothing to notice. A redraw arriving while a
  pointer is down now takes its reading and withholds only the drawing.
- The tray's popover kept a height it had been clamped to once by a short screen, on every later
  opening — including the trust and certificate-mismatch screens, where a prompt then scrolled
  inside a panel that had room to grow.
- `seedeep status` printed the half of the path that says nothing: npm, bun and a moved download
  all showed `…/bin/seedeep.exe`. It now elides the part every installation shares and shows what
  differs (`~/.bun/install/global/…/seedeep.exe`), prints a download the user placed whole, and
  abbreviates the home directory to `~`. Windows paths were previously not shortened at all.
- `seedeep status` abbreviated the home directory on a bare string prefix, so a sibling whose name
  merely starts with the home's — `carolyn` beside `carol` — came out as `~yn/…`. It matches on a
  path segment now.

### Changed

- Release pipeline hardening: the tray's Rust is compiled and tested on Windows as well as macOS —
  the `#[cfg(windows)]` half had never been handed to a compiler outside a release build — and two
  tests that made `main` go red at random were fixed.
- `docs/tray.md` and the CI workflow's own header were left describing behaviour that had just
  changed, and `docs/tray.md` never carried the rule that every process the tray starts on Windows
  suppresses its console.

Superseded by 0.27.1: the guard described here never landed.

https://github.com/duqaXxX/seedeep/releases/tag/v0.27.0

## 0.26.0 (2026-08-15)

### Fixed

- Windows: what the CLI prints came out as mojibake in a console, which runs a legacy code page
  unless something changes it. The five characters that reach a console are spelled in ASCII there
  now — `—` → `-`, `…` → `...`, `·` → `-`, `→` → `->`, `≥` → `>=`. macOS and Linux keep the
  typography they render correctly.
- Windows: the tray's popover opened off the bottom of the screen and collapsed to a scrolling
  sliver. It was anchored below the icon unconditionally — right for a menu bar, wrong for a
  taskbar, which sits on any edge and puts its icons in the lower half on three of the four. It now
  opens away from whichever edge the OS actually drew the icon on.
- Windows: every `npm i -g seedeep` install was warned that its own launcher was a different
  seedeep, by `seedeep status` and by the `/seedeep` command installer alike — Windows has no
  symlink for the check to resolve. npm's `.cmd` shim layout is recognised now, while a downloaded
  executable run from elsewhere still reports honestly. Bun's layout on Windows is not covered, and
  the code says so rather than guessing.
- Windows: `seedeep restart` left the old server stopped and no replacement running — a Windows
  child stays in its parent's job object and was terminated the moment the parent went. It is
  started detached on Windows only now, on all three surfaces that restart: the `restart` command,
  the portal's Restart button, and a restart after a configuration change.
- Windows: launching the tray opened a console window that stayed for the life of the app.

https://github.com/duqaXxX/seedeep/releases/tag/v0.26.0

## 0.25.0 (2026-08-14)

### Added

- A Windows arm64 build of both apps: a `seedeep-windows-arm64` server binary on the release page
  and on npm, and an arm64 tray installer built natively.

### Fixed

- `npm i -g seedeep` on Windows arm64 died with `seedeep: no build for win32 arm64` — the command
  the README puts first, with nothing to say the cause was the interpreter. The wrapper's `os` and
  `cpu` lists are read as a cross product, and that pair had no package behind it. Every pair does
  now.

### Changed

- Release pipeline hardening: a publish to npm that dies part-way through its seven packages can be
  re-run, skipping what is already on the registry instead of failing on the first package.

https://github.com/duqaXxX/seedeep/releases/tag/v0.25.0

## 0.24.0 (2026-08-14)

### Changed

- No release publishes until every executable in it has been downloaded onto a machine of its own
  OS and started: `--version` must print the version being released, the API must answer, and the
  browser GUI's own static files must answer too. It gates both exits — a broken build stays a
  draft, and npm, which cannot be taken back at all, is never reached.
- Every count on screen now says which count it is. `API calls` wherever API calls are shown (the
  session banner, the Compare row and its hover), `tool calls` in the Cards drawer, and the
  banner's group carries a tooltip glossing each number in the order it appears.
- The empty Home opens with the reason it is empty rather than a pitch, and says what is being
  watched. A session that exists without a finished turn gets its own wording and a pointer to the
  picker; a retrospective that never arrived drops the claim about the machine entirely.

### Fixed

- Home read `1 turns across 1 sessions` — a fixed plural in four places at once (the title, the
  `spent working` tile, the verdict-split card and the re-entry line), wrong for exactly the reader
  with one of each.
- Home could state there is no session on this machine while the picker directly above it listed
  one, and could paint before the first reading of the session list had landed.

https://github.com/duqaXxX/seedeep/releases/tag/v0.24.0

## 0.23.1 (2026-08-14)

### Fixed

- macOS: after opening and dismissing the tray's panel from the menu-bar icon, real notifications
  stopped being drawn — a session stopping on a question announced itself to nobody until the user
  happened to click something else. An accessory app with its only window hidden stays the active
  app, and macOS draws no banner for the active app. Both ways of dismissing the panel now leave
  the same state.
- macOS: the tray's test-notification button still posted a banner that was never drawn. It now
  hides the app, not only the popover, so the test reproduces the condition a real banner arrives
  in.

https://github.com/duqaXxX/seedeep/releases/tag/v0.23.1

## 0.23.0 (2026-08-13)

### Fixed

- A session resumed with `claude --resume` was tracked again only after a browser refresh. The tab
  froze into its ended presentation when Claude Code exited and nothing could ever revive it, since
  `--resume` continues the same session id and no new tab is ever opened for it. The freeze is
  reversible now: the tab comes back by itself and fetches the part of the transcript written while
  it was away.
- macOS: the tray's test-notification button reported "Sent." while macOS silently refused to
  present the banner, because the app posting it was frontmost — the one moment the tray always is.
  It puts the popover away and waits for activation to go elsewhere before posting; the banner
  itself is the receipt, so there is no separate confirmation any more.
- `docs/tray.md` and `docs/features.md` were describing a tray that had stopped existing: a source
  file that is gone, four commands the app does not register, a config directory said to hold two
  files where one is written, notification rules credited to the layer they had moved off, and four
  settings switches that live in the portal now.

### Changed

- The tray's test-notification button warns, before the click, that the panel will close and that a
  system configured to hide banners will show nothing — read while deciding to click, rather than
  on a screen that has since closed.

https://github.com/duqaXxX/seedeep/releases/tag/v0.23.0

## 0.22.2 (2026-08-13)

### Fixed

- The tray icon was a smudge at its real size. Written in fractions of a unit square, every edge
  fell part-way across a pixel and macOS filled the difference with grey, so the gaps came out
  under a pixel and the bars merged. It is drawn on a whole-pixel 18×18 grid now, still shipped at
  36 so retina gets 1:1 and a 1× screen an exact halving.

### Changed

- The tray icon's working animation moved to the glass — a gap running round the ring, one turn
  every two seconds. Animating the bars shifted about 4 px of ink, which is invisible at this size.
- The waiting state's bars are heavier as well as longer, so waiting and broken differ by about a
  fifth of their ink rather than 7% — red against amber is the pair a red-green deficiency reads
  worst.

https://github.com/duqaXxX/seedeep/releases/tag/v0.22.2

## 0.22.1 (2026-08-13)

### Fixed

- The tray icon was blurred on a retina screen: the image is pinned at 18 *points*, so AppKit had
  36 physical pixels to fill and the 26-pixel buffer was enlarged 1.38× and interpolated. The
  buffer is 36×36 now — one buffer pixel per screen pixel on retina, an exact halving on a 1×
  screen.

### Changed

- The tray icon's strokes are heavier and its trace rows further apart, so the waiting state's
  thickened bars no longer weld together. The browser mark is deliberately left alone: 18 points in
  a menu bar is an optical size of its own, as the 16 px ICO already is.

https://github.com/duqaXxX/seedeep/releases/tag/v0.22.1

## 0.22.0 (2026-08-13)

### Changed

- seedeep has a new mark: a **lens** — a ring of glass with no handle, over a trace of three spans
  stepping right, which is the shape the Trace tab draws. It replaces the eye, which said the wrong
  thing about a tool whose whole argument is that it only ever reads: an eye with a pupil and a
  highlight is the iconography of spyware, and it sat permanently in a menu bar. One geometry now
  serves every surface — the tray icon, the browser favicon, the app icons and the social card.
- The broken state is the plain mark in red rather than a mark with a cross through it. Waiting is
  told apart by its heavier bars, and a change that left hue as the only difference between the two
  still fails its test.
- The 16 px Windows icon is rasterised from the same geometry, with an optical size of its own —
  the glass and two spans, three leaving under a pixel of gap between them — instead of being
  plotted by hand on a separate grid that could disagree with the large one silently.
- Release pipeline hardening: an intermittent CI failure was traced to one app's test stub leaking
  onto the shared global and crashing the other app's teardown.

### Removed

- `harden-runner` is out of CI, one release after it went in. It was adopted on the premise that
  watching CI's egress costs nothing, and the premise was false: the toolchain download that
  follows its instrumentation died with `socket hang up` four times in an hour, on Ubuntu and on
  Windows, and left 0.21.0 a draft with six of its seven assets and nothing published to npm.
  Causation is not proven, but what it bought was visibility that had never once fired.

https://github.com/duqaXxX/seedeep/releases/tag/v0.22.0

## 0.21.0 (2026-08-12)

### Security

- A crafted `git commit` line in a transcript could hang the parser. The commit matcher backtracked
  exponentially — 685 ms at 40 flags, tripling every four more — on input seedeep does not control.
  The parse is unique now and no verdict changed. Found by CodeQL within a minute of enabling it.
- seedeep's claim that session content never leaves the machine is enforced by the linter, on the
  half of the codebase where it matters. The four files that may name `fetch` are listed with the
  reason each is allowed; a fifth entry in that list is the decision the rule exists to make
  visible. It runs on every push and every pull request, blocking.
- CodeQL must be green before a change can be merged, `main` refuses direct pushes, force-pushes
  and deletion, and release tags cannot be moved or deleted. Every change, the maintainer's
  included, arrives as a pull request. Rust remains uncovered.

### Added

- Every release asset carries a build-provenance attestation, so
  `gh attestation verify <file> -R duqaXxX/seedeep` answers with the workflow and the commit it was
  built from. It does not make the binaries signed — Gatekeeper asks a different question and still
  warns — it makes them attributable.
- The repository has a real social card, drawn by `bun run social-card` at the 1280×640 GitHub
  asks for, reading the mark from the favicon and the colours from the client's own stylesheets so
  neither can drift from the product it advertises. The bar along its foot is a context window
  filling, in the app's own per-token colours.

### Fixed

- `SECURITY.md` and `docs/install.md` both claimed the update check was seedeep's only outbound
  request, which the opt-in notification webhook makes untrue — and `docs/install.md` contradicted
  itself inside one file, describing the webhook correctly seventy lines later. Both now say **on
  its own** and point at the paragraph that was already right.

### Changed

- The npm page carries the hero figure, now that the repository is public, served by absolute URL
  and pinned to the version's own tag so a page published once keeps showing what it showed. The
  package description states what the tool reads instead of repeating the tagline two lines below
  itself, and its keywords are the repository's GitHub topics.
- CI records the network destinations its install, build and publish jobs dial, to a third-party
  service — CI telemetry, never user data, but a project that advertises no outbound traffic should
  say so out loud. It blocks nothing. (Removed again in 0.22.0.)

https://github.com/duqaXxX/seedeep/releases/tag/v0.21.0

## 0.20.0 (2026-08-12)

### Fixed

- The tray's `Use a different URL` field appeared and was gone a second later, overwritten by the
  next poll, so a second server could not be typed in at all. It is a screen of its own now and
  stays until the user is answered — a URL that connects, a retry, a start — or the popover closes;
  a refused URL keeps the field with the reason under it.

### Changed

- The notification figure in the docs is generated from a real run of the installed tray against a
  synthetic session, rather than assembled by hand: the one it replaces had been wrong since before
  its own release. Recorded alongside it, because it is a fact about the product and not only about
  the capture: macOS draws no banner at all while a fullscreen app is frontmost, though the
  notification is still delivered.

https://github.com/duqaXxX/seedeep/releases/tag/v0.20.0

---

Releases `0.19.0` and earlier are in [`CHANGELOG-archive.md`](CHANGELOG-archive.md).
