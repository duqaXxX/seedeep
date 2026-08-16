# Contributing to seedeep

Thanks for your interest in `seedeep`. This guide covers how to set up the project
locally and the conventions to follow when sending a change.

## Prerequisites

- [Bun](https://bun.sh) (the project is developed against Bun; a Node path
  exists via `tsx` but is not the primary target).

That is everything the server and the browser GUI need — no other runtime, no
global CLIs, no services.

The **tray app** (`apps/tray/`) additionally needs a [Rust
toolchain](https://rustup.rs) and the platform SDK (Xcode Command Line Tools on
macOS, MSVC Build Tools on Windows). You only need it if you are changing the
tray; nothing else in the repo does. See [`docs/tray.md`](docs/tray.md).

**`cargo` has to be on your `PATH`, and rustup does not always put it there** — it
writes `~/.cargo/env` but only edits your shell profile if you let it, so a shell
that never loads that file has a working Rust install it cannot see. Fix it for
this shell with `source $HOME/.cargo/env`, or for good by adding that line to your
profile. `bun run tray:dev`, `tray:build` and `test:tray` check first and say this,
rather than letting Tauri fail with *failed to run 'cargo metadata'*.

## Development setup

```sh
git clone https://github.com/<your-fork>/seedeep.git
cd seedeep
bun install
```

Common tasks:

```sh
bun start                 # watch sessions, serve the GUI, open the browser
bun start -- --port 9000  # serve on a specific port (default 44842)
bun start -- --no-open    # do not open the browser automatically

bun run test              # run the test suite
bun run typecheck         # tsc --noEmit (strict); run before every PR
bun run lint              # Biome: formatting + lint, reports only
bun run lint:fix          # the same, applying every safe fix
bun run build:client      # rebuild the browser client bundle into apps/server/public/lib/app.js
bun run build:server      # the standalone executable for this machine, into dist/
bun run build:server:all  # one executable per platform, cross-compiled from here

bun run dev               # a server on :44843 whose state cannot touch an installed one's
bun run tray:dev          # build the tray's panel, compile the Rust shell, run it
bun run test:tray         # the tray's Rust tests (needs the Rust toolchain)
```

`build:server` rebuilds the browser GUI and embeds it — never call `bun build
--compile` by hand, or the binary ships whatever bundle your checkout happened to
contain.

### Developing beside an installed seedeep

**Two commands, and nothing else to remember:**

```sh
bun run dev        # the server you are working on, on :44843
bun run tray:dev   # the tray you are working on — it finds that server by itself
```

An installed pair can stay running the whole time. This section is the only place the arrangement is
written down; `docs/tray.md` and `docs/architecture.md` state the rules of their own halves.

#### Why it needs saying at all

Each app resolves the SAME path a release does — `~/.seedeep/` for the server, the app's config
directory for the tray — so a checkout writing there reconfigures the installed copy: the port you
changed from a settings panel, or the server a dev tray was pointed at, is what the installed one
reads on its next start. It does not take two processes at once; alternating is enough, and the
symptom (a tray that says **Offline** for no visible reason) names nothing.

#### One variable names a world

`SEEDEEP_HOME` decides which seedeep a process belongs to, for **both** apps. Both dev scripts set it
to `.seedeep-dev` inside the checkout, which is gitignored.

| | Development | Installed |
| -- | -- | -- |
| Server: `config.json`, `cert.pem`, `key.pem`, caches, indexes, `servers/`, `server.log` | `.seedeep-dev/` | `~/.seedeep/` |
| Tray: `connection.json` | `.seedeep-dev/tray/` | the app's own config directory |
| Port | 44843 | 44842 |

Nothing is shared: token, certificate, port, caches — all doubled. Notification preferences are NOT in that list: they live in the server's `config.json`, so a dev server and an installed one each have their own, and the tray reads whichever it is connected to. The
installed apps never carry the variable, and the tray *cannot*: a GUI app inherits no shell
environment at all, which is what makes it the installed world without anyone choosing that.

It also works on its own, without the scripts:

```sh
SEEDEEP_HOME=~/.seedeep-dev bun start -- --port 44843
```

A relative value is resolved to an absolute path by each app, since neither runs from the directory
you typed it in. The suite deletes `SEEDEEP_HOME` before asserting the default layout, so exporting
it in your shell does not turn the tests red.

The dev tray finds the dev server with nothing pasted because a running server **announces its
address** in `<home>/servers/<pid>.json`, and the tray reads that before falling back to guessing a
port. That is also why `seedeep --port 9000` is found for an ordinary user.

#### What the two worlds DO share

The sessions. They come from `~/.claude/projects/`, which belongs to Claude Code and which seedeep
only reads — so a dev portal and an installed one list exactly the same work, and everything that
differs between them is off screen. Each half therefore marks itself, and only when it is the
development one:

- the **tray** draws a small dot in the icon's upper left, in every state;
- the **portal** renames its tab to *seedeep dev* and puts a chip beside the brand.

Neither reads `SEEDEEP_HOME` to decide that — moving your state is not declaring yourself a
developer. The tray asks `tauri::is_dev()`, the server asks `Bun.embeddedFiles.length`; both are
facts about how the binary was produced.

#### One thing that will surprise you

**A dev tray's Start button does not launch your working copy.** It resolves `seedeep` on your login
shell's `PATH`, so it starts whatever is installed there. To make it start what you just built:

```sh
bun run build:server
ln -sf "$PWD/dist/seedeep-server_<version>_<platform>" ~/.local/bin/seedeep
```

Remove that symlink before testing a real install, or you will be testing the link.

Use `bun run test`, not a bare `bun test`: the runner skips dot-directories when
it looks for test files, so `bun test` on its own misses the checks that live in
`.github/scripts/`. The script names both roots.

`bun run test` does **not** run the type-checker, so run `bun run typecheck`
separately before opening a PR. It runs the tray's TypeScript tests with
everything else, but nothing of its **Rust** side — a change under
`apps/tray/src-tauri/` needs `bun run test:tray` as well. That command compiles the blocks
your platform selects and no others, so a change inside `#[cfg(windows)]` on a Mac is
checked by CI and by nothing you can run; the reverse holds on Windows.

### Where the code lives

Each deliverable is an app under `apps/`: the server — watcher, HTTP/SSE API and browser
client — is `apps/server/`, and the menu-bar tray is `apps/tray/`, a pure HTTP client of
the server's API that links none of its code. **Run every command from the repo root**: there is one
`package.json` and one version for the whole repo, and its scripts know where each app
lives. Inside `apps/server/src/` there are three layers, one folder each: **`core/`** is pure
derivation (no `node:` builtin, nothing from the other two), **`server/`** is everything
that touches the machine, **`client/`** is the browser bundle. A test enforces it through
the import graph, so put a new module in the layer it belongs to by nature — not by who
calls it today. `bun run build:client` is the only command that writes into the tree
(`apps/server/public/lib/app.js`, a build artifact — rebuild it before verifying a client
change, or you will be verifying the previous bundle). The layout is described in
[`docs/architecture.md`](docs/architecture.md#repository-layout).

### Checking against a real session (optional)

`apps/server/scripts/live-check.ts` is a read-only smoke check that discovers your local
Claude Code sessions and prints a few live events:

```sh
bun run apps/server/scripts/live-check.ts
```

It only reads the session store — like `seedeep` itself, it never writes.

## How seedeep is architected

`seedeep` reads the JSONL session logs Claude Code already writes and reconstructs
a live view — **read-only, no proxy, no daemon.** Before making a non-trivial
change, read [`docs/architecture.md`](docs/architecture.md); it explains the data
sources, the event model, and the invariants the code relies on.

The one invariant worth stating up front: **`seedeep` never writes to, proxies, or
intercepts a session.** Any change that would break the read-only guarantee will
not be accepted.

## Coding conventions

- **Language:** English for all code, comments, docs, and commit messages.
- **TypeScript, strict.** The project builds under `strict` and
  `noUncheckedIndexedAccess`; keep it warning-free (`bun run typecheck`).
- **Formatting is not a discussion.** `bun run lint:fix` before you push, and CI
  checks it. The rules are in `biome.jsonc`, and every disabled rule carries the
  reason it is off — if one gets in your way, argue with the reason rather than
  adding a suppression. One commit in this repo is pure reformatting: run
  `git config blame.ignoreRevsFile .git-blame-ignore-revs` once and `git blame`
  will skip it.
- **Comment the *why*, not the *what*.** Explain a non-obvious decision or
  invariant; never narrate what the code plainly does. Match the density already
  in the codebase.
- **JSDoc on exported functions.** Public exported functions carry a one-line
  JSDoc stating the contract — what it returns, key invariants, and side effects.
  Trivial exports whose signature is already the contract don't need one.
- **Dependency injection for I/O.** Inject filesystem, time, and env so units
  stay testable without touching the real machine (see `DiscoverOptions`,
  `ServerDeps`). New I/O-bound code should follow the same shape.

## Tests

- A test earns its place only if a plausible bug could make it fail usefully.
  There is **no coverage quota** — delete a test that can't fail meaningfully.
- **Fix-on-touch:** when you change a source file that has tests, update those
  tests in the same commit.
- **Run before you push:** `bun run test` and `bun run typecheck` must pass — plus
  `bun run test:tray` if you touched `apps/tray/src-tauri/`, since `bun run test`
  does not reach the Rust side. CI runs all three on every push and pull request, so a
  failure here is a failure there. It runs the Rust ones on **macOS and Windows both**,
  which your machine cannot: `#[cfg(windows)]` is not merely untested off Windows, it is
  never handed to the compiler there, and `local.rs` carries five such blocks. So write a
  Rust test that can pass on either — build paths from `std::env::temp_dir()` rather than
  writing `/tmp/...` (which is not even absolute on Windows), create the files you assert
  on instead of borrowing `/usr/bin/true`, and encode JSON rather than formatting a path
  into a string literal, where a backslash is not an escape.
- Fixtures (`apps/server/tests/fixtures/*.jsonl`) must be **synthetic and anonymized** — no
  real paths, project names, or session content. The repo is public; never
  commit a real session log, real user data, or a screenshot of a real session.

## Running it on Windows

Three Windows sessions have happened, on a Windows 11 guest (2026-08-14, 2026-08-15 and
2026-08-16). Between them the server was installed from npm and its whole lifecycle driven, the
tray was installed and used, and six defects were found and fixed: the installer runs and needs no
Administrator rights, the tray icon reads in the notification area, the popover opens at full
height, notifications are delivered on both switches, and trust-on-first-use works against a
server reached over HTTPS on another machine. What that leaves is ordinary use rather than a list
of open questions — report what you see in an issue, since an "it all worked" is still worth
sending on a platform nobody here uses daily.

Where an observation goes: `docs/tray.md` holds the platform measurements in a table under *What
is signed, and what that costs*. Something broken is its own issue, not a footnote to that one.

## Documentation

- Permanent docs live in `docs/`. Keep them in sync with the code in the **same**
  change — a behavior change and its doc update belong together.
- Structural changes get a dated entry at the top of `docs/CHANGELOG.md`.
- **Never add a screenshot by hand.** The figures in `docs/features.md` are cut by
  `bun run doc-shots` — from a recorded session, or from a written transcript in
  `apps/server/scripts/doc-scenes.ts` for the states no recording can provoke (a
  failed API call, a compaction, a corpus). A scene is synthetic in content and
  faithful in SHAPE, and `apps/server/tests/doc-scenes.test.ts` runs each one through
  the real parser and reducer to assert the state its figure claims — add a scene and
  you add its assertions, or the figure can go empty with nothing to catch it. Each
  figure is declared in `apps/server/data/doc-shots.json` alongside the source files
  that invalidate it — plus, for the one figure that needs it, the `server` posture to
  photograph it in: naming a host binds the capture's own throwaway server beyond
  loopback, which is the only way to picture the TLS block and a fingerprint that come
  from the running process rather than from the form. The common name there is
  synthetic, and is what the panel then prints in its access URL —
  so `bun run doc-shots:check` can name the figures a change touched. Nothing else
  can: no test looks at a PNG. What it names are **candidates, not verdicts** — the
  map is per-file and `client/graph.ts` draws every widget, so a three-line change to
  one panel named 15 figures of 20, and re-cutting them produced 18 byte-identical
  files. The pre-push hook prints that list and stops there, WARN-only: deciding
  whether a figure went false is a judgement — did what it *shows* change? —
  not something a file-level map can make for you. `--verify` settles it by
  **re-cutting the suspects into a temp directory it then deletes, and comparing the
  pixels** — so it publishes nothing, and it costs minutes. Reach for it when what a
  figure SHOWS is genuinely in doubt, not on a schedule: a release in particular is not
  a reason to re-cut, nor to verify. The Settings figures print the server's version, but a
  figure documents the surface it photographs, not the version that was running, and a
  stale number there makes nothing it claims false. If you change a widget that a figure
  shows, say so in the PR — re-cutting needs the recorded bundle, which is not in the
  repo, so a maintainer does it.
- **The notification figure is cut too, by a different command.** `docs/assets/notifications.png`
  is three REAL macOS banners, so no headless browser can produce it — but it is not a
  screenshot somebody took either: `capture-demo.ts notif` drives the installed tray
  against a synthetic session, provokes the approval, the failure and the finish in
  turn, films the screen, and finds each banner by subtracting a frame of the screen
  from a frame with a banner on it. Two things it learned the hard way are worth
  knowing before touching it. The backdrop must be an ordinary window and never a
  fullscreen one — **macOS delivers a notification while a fullscreen app is frontmost
  and draws no banner at all**, which is a fact about the product as much as about the
  capture. And the banner's edges are read at a much lower threshold than its text: the
  body of a banner differs from what is behind it by a step of three or four, so a
  threshold tuned on the lettering cuts the figure through the middle of the second
  line. It needs the tray of the SAME version installed, notification permission
  granted, and the screen for about a minute.
- **A shot must declare `waitFor`** — a selector for something its own subject
  renders, and the run FAILS when it never appears. It is the only place a figure
  states what it must contain in a form the capture can check: while an unmet wait
  was merely ignored, four of twenty figures were photographing a state that never
  happened (subagents that had finished but rendered as running, a Trace with no
  child data, a list with nothing indented) and nothing in the suite could see it.
  A test enforces that every shot has one.
- A shot may declare `viewportHeight` when the widget takes its size from the
  window rather than from its content — a drawer is `height: 100%`, so at the run's
  shared height the settings panel was cropped with 45% of the figure empty under
  its last row. Everything that grows with its content leaves it out.

## Sending a change

1. Fork and branch from the default branch.
2. Make the change; keep it focused (avoid unrelated cleanup in the same commit).
3. Ensure `bun run test` and `bun run typecheck` pass (and `bun run test:tray` for a
   change under `apps/tray/src-tauri/`).
4. Open a pull request describing **what** changed and **why**.

Two CI jobs then run on the pull request, and **both must be green before it can be
merged** — `main` takes no direct pushes, from anyone, and cannot be force-pushed or
deleted. The maintainer goes through a pull request on the same terms:

- **Tests, types, client bundle** — the suite, the type-checker, and a rebuild of
  `apps/server/public/lib/app.js` that fails if the committed bundle no longer
  matches its source. Rebuild and commit it whenever you change client code.
- **Sensitive-data scan** — the added lines are checked for real home paths,
  personal email addresses, secret markers and private tracker references. This
  repo is public and a leak committed once stays in the history forever, so this
  job blocks the change rather than warning about it. The check is
  `.github/scripts/scan-sensitive-diff.sh`; you can run it yourself with
  `git diff main...HEAD | .github/scripts/scan-sensitive-diff.sh`.

## License

By contributing, you agree that your contributions are licensed under the
project's [MIT license](LICENSE).
