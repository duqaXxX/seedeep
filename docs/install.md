# Installing, running and updating seedeep

`seedeep` runs a small local server that watches your sessions and streams them to
a page in your browser — one process, no daemon, stopped with Ctrl-C. Two channels
ship the same executable; a third runs it from a clone.

> **Neither the Windows nor the Linux build has ever been run on its own system** —
> they are built by CI and downloaded by you first. [Which platforms have actually
> been run](../README.md#which-platforms-have-actually-been-run) says exactly what
> that covers.

## From npm — Node or Bun

```sh
npm i -g seedeep                       # or: bun install -g seedeep --trust
seedeep                                # watch, serve, and open the browser
```

**A package manager is needed to install it, never to run it**: the package carries
the compiled executable — its own runtime and the whole browser GUI inside it — and
the install puts that file on your PATH. Installing this way also raises no
first-launch warning on macOS: the quarantine flag behind that dialog is set by the
browser that downloads a file, and never by a package manager.

`--trust` is not optional under Bun: it blocks a dependency's install script by
default, and that script is what puts the binary in place. Without it the install
reports success and `seedeep` prints the one command that finishes the job
(`bun pm -g trust seedeep`). npm runs it either way.

## The plain download — no runtime at all

Take the file for your platform from [the latest release](../../../releases/latest)
— `seedeep-server_<version>_macos-arm64`, `…_macos-x64`, `…_linux-x64`,
`…_linux-arm64`, `…_windows-x64.exe` — make it executable, and run it:

```sh
chmod +x seedeep-server_*            # macOS and Linux
./seedeep-server_*                   # watch, serve, and open the browser
```

**That file is not an installer — it is the program.** It installs nothing,
registers nothing, and puts nothing on your PATH: it carries its own runtime and the
whole GUI inside, so downloading it is the entire step. Running it leaves
`~/.seedeep/` behind for its own settings and caches, and nothing else.

Because nothing was put on your PATH, the command is the file's own path until you
move it yourself:

```sh
mv seedeep-server_* /usr/local/bin/seedeep   # now `seedeep` works anywhere
```

That step is optional for running it — and required for `/seedeep` inside Claude
Code, which calls `seedeep` by name. Installing from npm does it for you.

It is the same executable either way, and it is what a headless box reached over
SSH needs. macOS refuses an unsigned download on first launch: the way through is
**System Settings → Privacy & Security → Security → Open Anyway**, then your login
password — the same gesture the tray needs, described in
[`tray.md`](tray.md#what-is-signed-and-what-that-costs). The Linux builds need glibc
(Debian, Ubuntu, Fedora…), not musl.

## From a clone

```sh
bun start                 # watch, serve, and open the browser
bun start -- --port 9000  # serve on a specific port (default 44842)
bun start -- --no-open    # do not open the browser automatically
```

The flags are the same however it was installed (`seedeep --port 9000 --no-open`,
`./seedeep-server_… --no-open`), and `seedeep --help` lists every command and flag
in one place — `--version` prints the number alone, for a script to read.

With a server already running on a different port than your config's, `seedeep
open` prints what is running rather than picking one — `seedeep open --port <port>`
says which.

## `/seedeep` inside Claude Code

```sh
seedeep install-command   # once: writes ~/.claude/commands/seedeep.md
```

The command file it writes calls `seedeep` **by name**, so the binary has to be on
your PATH under that name. From npm it already is. From a downloaded file it is not
until you move it there (see above) — otherwise `install-command` succeeds and
`/seedeep` then fails with *command not found*.

After that, any Claude Code session has these:

| | |
|---|---|
| `/seedeep` or `/seedeep open` | opens the GUI, starting the server first if it is down |
| `/seedeep start` | starts the server without opening a browser — the counterpart of `stop` |
| `/seedeep stop` | ends the running server, the way Ctrl-C in its terminal would |
| `/seedeep restart` | replaces the running server with a fresh one |
| `/seedeep report` | what this session cost and where its tokens went; `report full` adds a line per turn |
| `/seedeep update` | says how *this* installation is updated — it prints the command, and never runs it |

The same words exist on the console — `seedeep open`, `seedeep start`,
`seedeep stop`, `seedeep restart`, `seedeep report`, `seedeep update`. A server
started this way keeps running when the session ends, because it is started
detached, exactly like one you launched yourself; `stop` is what ends it, and it
asks with SIGTERM rather than killing, so the server closes down properly.

### `seedeep report`

`report` needs no server at all — it reads the session's own transcript — and on the
console it needs no session id either: `seedeep report` takes the **newest session
of the directory you are in**, and says so before printing. Never one from another
project — that would be the one way to be wrong that the report's own first line
could not make obvious. `--session <id>` picks any other.

It is deliberately small: it is printed INTO the session it describes, so its two
standing blocks stay the same size whatever the session's length, and the last line
tells you what the report itself cost. Only `report full`, which prints a line per
turn, grows.

### Keeping the command file current

The command file records which seedeep wrote it, and after you have installed it
once, seedeep keeps it current on its own: **every server start refreshes it** when
it is older than the binary, and says so in one line. Nothing is created that way —
only a file you asked for, by running `install-command`, is ever touched — and a
file you edited becomes yours and is left alone for good (`--force` is the only way
back). If no server of yours ever starts, the next `/seedeep` you use tells you
instead. `seedeep install-command` does it by hand at any time.

Nothing is written anywhere unless you run `install-command` yourself: it is not
part of installing seedeep, and no upgrade does it behind your back.

## Updating seedeep

**Updating seedeep itself** is `seedeep update`. It asks npm which version is
current, reads where this executable actually lives — a package manager's
`node_modules`, or a file you downloaded — and prints the one command that updates
*that*. It never runs it: updating is yours to do, in a terminal where you can watch
it happen.

That version check is **the only outbound request seedeep ever makes**, and it
happens **at most once an hour**: the answer is cached, so the command, the portal's
Settings panel and the tray all read one check rather than three.
`seedeep update --offline` skips it entirely, and a registry that cannot be reached
never withholds the advice — you are still told how this install would update.

When a newer version exists you are told once per release: a notification from the
tray (switchable off in its Settings, with the other three), a line in the portal's
About section, and a line after `seedeep open` / `seedeep start`. Nothing is ever
installed for you: every one of them points at `seedeep update`, which prints the
command and lets you run it where you can watch it happen. Nothing updates by itself
either — npm documents no background or scheduled update, for global packages or any
other kind. If you want it automatic, that belongs in your own scheduler
(`npm update -g seedeep` on a cron), where you decided it.

A running server keeps the old code until you restart it, whichever way you updated.

## The macOS permission the server asks for

**"seedeep would like to access files in your Documents folder"** — asked by the
**server**, not the tray, and only if your projects live there (or in Desktop or
Downloads, which macOS gates the same way).

seedeep reads `~/.claude/projects` and nothing else, with one exception: it runs
**read-only git** in the working directory of a session — `rev-parse`, `log`,
`diff-tree`, `remote get-url`, `rev-list`, every one with `--no-optional-locks` so
that even a read cannot take `.git/index.lock` while you are committing. That is
what fills the **Commits** and **Changed files** cards, and it runs when you open a
session, not across your whole corpus. **Refuse and those two cards stay empty**;
nothing else changes.

Neither this prompt nor the tray's appears for the plain download, run from a
terminal in a directory you already have access to. The tray's own permission — the
local network — is in [`tray.md`](tray.md#the-one-permission-the-tray-asks-for).

## Data flow

Session data flows one way: the server pushes to the browser (Server-Sent Events)
and the browser never sends any of it back — nothing seedeep reads is ever written.
The browser does POST three things, and all three are seedeep's own state, never
yours: the settings and a restart. (The share card's PNG is drawn by the page
itself — it never leaves your browser.)

## Remote access

`seedeep` binds `127.0.0.1` and asks for nothing: on loopback there is no network to
authenticate against, so there is no auth in the way.

Naming any other host flips the entire posture in one switch:

```sh
SEEDEEP_TLS_CN=my-machine.local bun start -- --host 0.0.0.0
```

Beyond loopback, HTTPS is mandatory and every `/api/*` request needs
`Authorization: Bearer <token>` — a 32-byte token generated on first run and kept in
`~/.seedeep/config.json`. `seedeep` issues its own self-signed certificate, valid for
the machine's current LAN address; the certificate's common name is required, which
is what `SEEDEEP_TLS_CN` above provides. The startup URL carries the token, and the
page moves it into local storage and strips it from the address bar, so it never
reaches your browser history.

Its SHA-256 fingerprint is printed on **every** start, and shown in the settings
panel with a Copy button — a browser waves a self-signed certificate through with one
click, but anything else has to pin it, and can only do that if you can read the
value when you set that client up.

The settings panel (the sliders icon in the header) edits all of it — port, host,
token, the full access URL, and the certificate fingerprint, each with a Copy
button — so nothing has to be edited by hand.

**`seedeep` ships no tunnel.** Reaching it from outside the local network is
deliberately not its job: use an SSH port-forward
(`ssh -L 44842:127.0.0.1:44842 user@host`, which leaves the server on loopback and
makes the tunnel the authentication), or a VPN you already run. The security model in
full is in [`architecture.md`](architecture.md#security-model).

## Installing the tray

The menu-bar tray is a separate download, built by CI from a tag and attached to
[the latest release](../../../releases/latest) beside the server: one universal
`seedeep-tray_<version>_universal.dmg` for macOS — Apple Silicon and Intel in the
same file, so there is nothing to choose — and a `-setup.exe` for Windows. Until a
release is listed there, `bun run tray:build` produces the same bundle locally,
under the same name.

**The tray is called `seedeep-tray`, the server is called `seedeep`**, and they are
two programs. They used to share the one name, which made a system permission dialog
impossible to read: it said *"seedeep"* while asking on behalf of whichever of the
two it was, and `killall seedeep` reached the server rather than the app you meant.

It is optional, and it is a **client**: it connects to a server, on this machine or
on another one. The server is what has to run where Claude Code runs.

**Both are unsigned.** There is no Apple Developer ID and no Windows code-signing
certificate behind these builds; that is the state `seedeep` ships in today, and each
system says so in its own way:

- **macOS** — the first double-click says *"Apple could not verify
  "seedeep-tray.app" is free of malware…"*. The way through is **System Settings →
  Privacy & Security → Security → Open Anyway**, then your login password. Apple
  offers that button for about an hour after the attempt that was refused, so open
  the app first and go to Settings second.
- **Windows** — SmartScreen shows *"Windows protected your PC"*; the way through is
  **More info → Run anyway**. The installer installs for the current user only, so it
  never asks for Administrator rights.

Both warnings are the honest cost of an unsigned build, not a sign that something
went wrong. Signing becomes a real decision when there is a release worth signing.

**Every tray update asks for its permissions again**, and that is the price of an
unsigned build rather than a bug: macOS attaches a permission to a code IDENTITY, and
an unsigned app has none that survives a rebuild — `codesign -d -r-` on the installed
app answers *"code object is not signed at all"*. The bundle identifier does not
change, so your settings and stored connection carry over; the permission does not.
The one that bites is notifications: **a tray that notified last week can go quiet
after an upgrade**, and the fix is System Settings → Notifications → seedeep-tray.
What each banner says, and which ones ship on, is in
[`tray.md`](tray.md#notifications).

## Removing seedeep

The **server** is two deletions and no uninstaller: the executable itself
(`npm uninstall -g seedeep`, or the file you downloaded and wherever you moved it)
and `~/.seedeep/`, which holds its settings, its certificate and its caches. If you
ran `seedeep install-command`, there is a third: `~/.claude/commands/seedeep.md`.

The **tray** is a different program, and removing the server does not touch it:

- **macOS** — quit it from the menu bar, then drag **seedeep-tray** out of
  Applications. There is no uninstaller to run: the download is a `.dmg`, and a DMG
  *is* the drag, in both directions. What that leaves behind is one folder,
  `~/Library/Application Support/app.seedeep.tray/` — the server you connected to and
  the notification switches, nothing else. Delete it to leave nothing; keep it and a
  reinstall picks up where you left off.
- **Windows** — Settings → **Installed apps** → **seedeep-tray** → Uninstall. The
  uninstaller draws a **Delete app data** checkbox on the way, and it starts
  **unchecked**: leave it and `%APPDATA%\app.seedeep.tray` survives for the next
  install, tick it and it goes with the app.
