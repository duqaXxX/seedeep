# Architecture

seedeep makes the invisible inside a Claude Code session visible: in real time
during a turn, how the **context window** fills and what the **subagents** are
doing, assembled live from the local session logs.

The design principle is **read-only**: seedeep only reads the session files Claude
Code already writes. It never writes, proxies, or intercepts anything Claude Code owns.

The one write it does make is to a file it **owns**: an aggregate cache under
`~/.seedeep/`, a distillation of the corpus it read (see
[the aggregate cache](#the-aggregate-cache)). It touches no session file, so the
read-only-of-Anthropic-data invariant holds; the cache exists only to make the launch-time
retrospective and the personal baseline fast.

## Repository layout

Every deliverable is an app under `apps/`, and none of them sits at the root, so a
second one arrives as a peer of the first instead of as an appendage to it:

```text
seedeep/
├── apps/
│   ├── server/          the watcher, the HTTP/SSE server and the browser client
│   │   ├── src/         three layers, one folder each: core/ server/ client/
│   │   ├── public/      the GUI's files, embedded in the binary; `lib/app.js` is BUILT
│   │   ├── tests/       the suite (`bun run test`)
│   │   ├── probe/       the schema probe: never shipped, runs out of `bun test`
│   │   ├── data/        checked-in reference data (known fields, context windows)
│   │   ├── npm/         the npm wrapper's own files: postinstall, placeholder, its README
│   │   └── scripts/     one-off maintenance scripts
│   └── tray/            the menu-bar client, see `docs/tray.md`
│       ├── ui/          the popover's HTML/CSS/TS, bundled by Bun
│       └── src-tauri/   the Rust shell: tray icon, window, notifications
├── docs/                this reference: it documents the PRODUCT, not one app
├── .github/
│   ├── workflows/       ci.yml on every push and PR; release.yml on a tag (`docs/tray.md`)
│   └── scripts/         checks CI runs: the sensitive-data scan, and its tests
└── package.json         one manifest, one version, scripts for every app
```

`src/` is three layers and each one is a folder, so the rule between them can be
stated about directories rather than recited as a list of filenames:

- **`core/`:** pure derivation, with no `node:` builtin and nothing from `server/` or `client/`.
  It is the half of seedeep that does not care where it runs, which is why both other
  layers may import it and why it is the easiest part to test.
- **`server/`:** everything that touches the machine: the watcher, discovery, the tailer,
  the HTTP/SSE server, TLS and config, the schema guard's command-line entry points.
- **`client/`:** the browser bundle's own modules, the only ones allowed to touch the DOM.

The split is by what a module *is*, not by who happens to call it: `core/span-store.ts` is
reached only from the client today and stays in `core/` because it is pure, while
`config.ts` and `tls.ts` sit in `server/` because they open files and sockets. Two tests
hold the line (`apps/server/tests/layering.test.ts`), both walking the import graph rather
than the directory listing.

`docs/` stays at the root: `architecture.md`, `api.md`, `configuration.md`,
`features.md`, `trace.md`, `search.md`, `session-output.md`, `claude-code-upgrades.md`,
`install.md` and `tray.md` describe the product, and a second app would otherwise bury half the
reference inside its own directory.

**The tray shares no code with the server**: it reaches it over HTTP only, through four
endpoints: `/api/digest`, `/api/stream`, `/api/config` and `/api/update` (`docs/tray.md`).
That is why it lives beside `apps/server/` rather than
inside it, and why a change to `core/` can never break it without changing an endpoint.

There is **one version for the whole repo**, so a tag ships every deliverable together
and two of them built from the same tag are compatible by construction, with no
compatibility matrix. It is not a convention anybody has to remember: the root
`package.json` holds the only version number, and `apps/tray/src-tauri/tauri.conf.json`
names that file as its `version` instead of carrying one of its own. Pushing a `v*` tag
is what turns that number into downloads: the tray's three installers and the server's six
executables, out of the same workflow and the same commit; see
[Shipping the server](#shipping-the-server).

CI runs on every pull request and on every push to `main`: three jobs, `scan`,
`check` and `tray` (`.github/workflows/ci.yml`), because a rule nothing enforces is a
rule that quietly stops being true, and a local run that never invokes the type-checker is
not evidence it is green. Between them they enforce:

- the suite and `tsc --noEmit`;
- **Biome** (`bun run lint`): format and lint check across all TypeScript sources. A PR
  that passes tests but has formatting violations is blocked here before review;
- a rebuild of `apps/server/public/lib/app.js`, which fails if the committed bundle no
  longer matches its source. That artifact is committed so a clone runs the GUI
  without a build step, and this is what keeps the two in step;
- the **layering** (`apps/server/tests/layering.test.ts`): nothing reachable from
  `apps/server/src/client/app.ts` may import a `node:` builtin, and nothing in `core/` may
  import one either, nor anything from `server/` or `client/`. Nothing else stops a
  client file from importing the watcher: `bun build --target browser` does not fail on a
  node builtin, it substitutes a polyfill that throws, so the mistake reaches the browser
  as a blank page. Both checks follow the import graph, so an indirect import three hops
  down fails too;
- the **tray's Rust suite** (`cargo test`, on a macOS and Windows matrix, after
  `bun run build:tray-ui`). `bun run test` does not reach it, so this job is the whole of
  CI's coverage for a change under `apps/tray/src-tauri/`;
- the **sensitive-data scan** (`.github/scripts/scan-sensitive-diff.sh`) over the added
  lines: real home paths, personal addresses, secret markers, private tracker
  references. It blocks rather than warns: this repo is public, and a leak committed once
  stays in the history forever. A fork inherits it, which is the whole point: a local
  git hook cannot be inherited, since `.git/` is not tracked.

Every command runs from the repo root (`bun run test`, `bun run start`,
`bun run build:client`, `bun run typecheck`); the scripts in `package.json` know where
each app lives. Use `bun run test` rather than a bare `bun test`: the runner skips
dot-directories when it scans for test files, so `bun test` alone never sees
`.github/scripts/`. The server has no dependency on the working directory: the GUI's files
reach it as imports (`assets.ts`), not as a path it resolves.

### Shipping the server

The server is a **standalone executable, one per platform**, with the Bun runtime inside it,
`bun run build:server:all` (`apps/server/scripts/build-binaries.ts`) writes all six into `dist/`,
cross-compiled from whichever machine runs it. Nothing has to be installed to run one, which is why
the GUI is embedded in the binary rather than served from a folder beside it.

Every asset is named after the app it is: `seedeep-server_<version>_<platform>` beside the
tray's `seedeep-tray_<version>_…`. A release page carries both, and two macOS files sharing a prefix
would say nothing about which one reads your sessions.

Three properties of the build are decisions, not detail:

- The compile rebuilds the client bundle itself. `assets.ts` embeds `public/lib/app.js` by path,
  so a compile that skipped the rebuild would ship a GUI from an older commit, and nothing
  downstream could tell.
- **Nothing is left external.** A dependency doing a COMPUTED `require` cannot be bundled, and Bun
  leaves it to runtime with the build machine's path frozen into it: a binary that works everywhere
  it was built and nowhere else.
- A binary may not contain the path of the machine that built it. `assertNoBuildPath` fails the
  build on any occurrence, because that is the one class of defect a test on the build machine
  cannot see.

The Linux binaries are dynamically linked against glibc, so a musl distribution (Alpine) is not a
target.

Every executable is started, run and driven through its whole lifecycle on a machine that did not
build it before anything publishes; how that is arranged is in
[`CONTRIBUTING.md`](../CONTRIBUTING.md#how-a-release-is-built).

#### The npm channel

The same six executables also ship as npm packages, which is what `npm i -g seedeep` installs.
Node is needed to install them, never to run one: the package carries the compiled binary, and
`bun run build:npm` (`apps/server/scripts/build-npm.ts`) only arranges files and never compiles, so
`bun run build:server:all` has to have run first, and in that order, since the compiler wipes
`dist/`.

The shape is a wrapper package whose `bin` points at a file inside itself, plus one
`optionalDependency` per platform carrying the real executable. npm resolves those against each
package's `os`/`cpu`, so a machine downloads one binary rather than six, and the wrapper's
postinstall (`apps/server/npm/install.cjs`) puts that binary over the placeholder the `bin` field
already names. Nothing is fetched by the script itself, and no Node process survives the install,
`seedeep` on PATH *is* the server.

Four decisions hold it up:

- The channel exists because of the quarantine flag. macOS sets `com.apple.quarantine` in the
  program that downloads a file, not in the file; installed through npm the binary never acquires
  it, so the first-launch refusal a plain download has to explain never happens here.
- The placeholder is named `seedeep.exe` on every platform and carries no shebang. npm generates
  the Windows `.cmd` shim from that file *before* the postinstall replaces it, and `cmd-shim` only
  emits a direct exec of the target when it finds no shebang to honour, and a `#!` line would make
  every Windows install hand a native executable to an interpreter.
- An unsupported platform is refused by npm itself. The wrapper declares the `os` and `cpu` it
  was built for, and npm reads them as a cross product: anything outside fails with `EBADPLATFORM`,
  naming both what was wanted and what the machine is. Every combination that cross product admits
  is a package that exists, which a test asserts; the postinstall still refuses a pair it finds no
  package for, because the two lists are independent and adding to one alone reopens the hole.
- The wrapper pins its binaries to its own exact version. One tag publishes both halves; a range
  would let npm pair a wrapper with an older executable.

The bare downloads stay on the release page, and are not a fallback: they are the channel for a
machine with no Node at all (a headless box reached over SSH), and requiring a runtime before
seedeep is the exact failure the distribution invariant exists to prevent. Which command installs
which, and the gesture each platform asks for, is in [`install.md`](install.md).

## Data source

Claude Code writes one JSON-lines file per session, appended once per **content
block**, not once per turn and not once per API call either: one response
becomes several lines (`thinking`, then `text`, then each `tool_use`), all
sharing a `requestId`. Each line carries an ISO-timestamped `message.usage`
block with `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, and
`cache_read_input_tokens`; the usage is the CALL's, so it is repeated verbatim on
every line of that call (measured: identical on 53 of 53 multi-line requests),
summing it per line would multiply the cost, which is what `newCall` guards
against.

A line is appended when its block CLOSES, so the console, which draws a block as
it streams, always leads the file. Measured on a live session (267 lines): the
gap between a line's own timestamp and the instant it becomes readable is p50
0.16s, p90 1.29s, p99 11.46s; the tail is `thinking`, whose whole streaming time
elapses before the line exists. For the blocks the live surfaces actually read it
is much tighter: `tool_use` is p50 0.23s / p90 0.29s. Tailing is therefore a
sub-second event stream for tool activity, and no faster than a block's own
duration for anything else.

Sessions live under one local root:

- **Claude Code (CLI):** `~/.claude/projects/<slug>/<sessionId>.jsonl`, or under `CLAUDE_CONFIG_DIR`
  when it is set, which moves Claude Code's whole directory and therefore the transcripts too
  (`claudeDir` in `roots.ts`). `<slug>` is the session's working directory with its separators
  turned into dashes: verified against all 16 project directories on this machine, each compared
  with the `cwd` its own transcript records.

Claude Chat and Cowork are deliberately NOT observed: the chat writes no
per-API-call log to disk (only editor drafts and UI state), and the current
Cowork runs the session remotely, leaving nothing local to read.
Subagents write their own separate files under a `subagents/` directory beside
the parent session. A **Workflow run** nests its own fleet one level deeper,
`subagents/workflows/wf_<runId>/`, same file names, plus a `journal.jsonl` recording each
of its subagents starting and returning. A run is shown as ONE aggregate row (a real
`deep-research` run spawns ~100 subagents), never expanded.

## The core engine

The core is an in-process, runtime-agnostic TypeScript library (standard
`node:*` and Web APIs only, so no runtime lock-in). It is organized as a layered
pipeline where each unit has a single responsibility and a defined interface:

```text
discovery ──▶ watcher ──▶ (EventEmitter: normalized events, tagged by sessionId)
   │            │  ▲                │
   │            │  └── parser       └──▶ core/     (pure: events → meaning)
   │            │      (pure: raw line → events)         session-tree, span-store,
   │            └───── tailer                            verdict, selectors, feed, …
   │                   (incremental byte-delta reader)
   └── roots    (root paths, exclusions, active-window)
```

The pipeline has two pure halves and the split matters: the left half turns bytes
into events, the right half turns events into meaning. Both are runtime-agnostic,
and neither knows who is asking. `apps/server/src/core/` holds the second half, the reducer and
everything derived from its snapshot, so it can run wherever the events arrive: in
the browser, which folds a live stream, and in the server process, which folds a file
per corpus entry to build `/api/retro` and `/api/baseline`. Two callers, one
derivation, no second source of truth.

### discovery

Enumerates Claude Code (CLI) sessions and returns a record per session:

```ts
interface SessionRecord {
  sessionId: string;
  project: string;
  model: string | null;
  lastActivity: number;      // epoch ms (file mtime)
  isActive: boolean;         // mtime within ACTIVE_WINDOW_MS (5 min, a fixed constant)
  isOpen: boolean | null;    // live ~/.claude/sessions/<PID>.json; null = no such dir at all
  status: 'busy' | 'idle' | 'waiting' | 'shell' | null;  // from that file; see below
  waitingFor: string | null; // while 'waiting': what it is blocked on, verbatim from CC
  waitingSince: number | null; // and when it stopped there (CC's statusUpdatedAt)
  subject: string | null;    // first real prompt, anonymized: the readable picker/tab label
  entrypoint: string | null; // 'cli' (interactive) vs 'sdk-cli'/'sdk-py' (headless)
  root: 'cli';
  path: string;
}
```

Files under `subagents/` and bookkeeping files are excluded from the top-level
session list.

**One definition of "live".** `isLive(record)` (in `types.ts`, beside the record) answers it
for every consumer: `isOpen ?? isActive`, so the running process decides and the mtime window
only gets a vote when there is no process signal to read (`isOpen: null`, i.e.
`~/.claude/sessions/` does not exist; it is an undocumented Claude Code internal that a
release may drop). The watcher tails a session while it is live, and the picker files it
under **Live**, from that same call. Split in two, they disagree exactly where it hurts: a
session waiting on a **background subagent** writes nothing to its own jsonl, so `isActive`
lapses while the process is alive and the child files are still growing, so gating on `isActive`
alone drops such a session, children included, until the main agent speaks again, freezing the
live feed for the whole subagent run. The other side of the same rule: a session whose process
has exited is NOT live, however recently its file was written.

One definition of "working", and it is not `status === 'busy'`. `isWorking(record)` (beside
`isLive`, same reason) reads `busy` OR **`shell`**, Claude Code's own word for a turn that is over
while a command it launched in the background is still running. A session with no status makes no
claim, so dropping an unrecognised word to `null` reads as idle on every surface and jumps back to
working when the command ends. The value is therefore carried raw and interpreted at the edges: the
browser's tab badge, the tray's band, and the tray's Rust icon, each pinned to this function by a
test. Everything still unknown becomes `null`: the vocabulary is Claude Code's, and it has
already grown once.

One reading of `isOpen` is not proof it closed. Claude Code REWRITES the PID file on every
status change, and `listOpenSessions` skips a file it catches mid-rewrite, so a running
session can be missing from exactly one poll. Anything COSTLY must therefore wait for a
second reading: `known` in `sessions.ts` is never pruned on a blink, and ending a tab (it
freezes the graph into its ended presentation) goes through
`end-guard.ts`, which re-reads the roster a full poll later and commits only if it still
agrees. Counting notifications cannot do this job: `onChange` fires on identity CHANGE, so a
session that really closed notifies once and then never again; the confirmation reads
`roster.current()`, which every poll refreshes whether or not it notified.

What makes it a SECOND reading is `roster.readings()`, not the wait. A poll whose fetch failed
keeps the last good rows, so `current()` can serve back the very snapshot that
opened the window, since one blink of the PID file plus one failed poll and a healthy session would
be ended on a single reading. The guard therefore requires that counter to have MOVED, and
when it has not it re-arms instead of giving up: dropping the question would leave a session
that really ended live for the life of the page, since `gone` is driven by an identity change
that has already happened.

Ending a tab is **reversible**, and has to be: `claude --resume` continues the SAME session id,
so a resumed session can never be handed a new tab, and nothing auto-opens it
(`sessionsToAutoOpen` excludes both `known` and the ids on screen) and picking it from the
dropdown only switches to it. So the poll that reports it live again calls `revive` (`app.ts`),
which undoes the freeze and asks the replay endpoint for the tail the tab missed. What makes
that possible is that the tab's READER outlives the session, since `end` does not stop it
(`stop()` means the tab is gone) and a tab subscribes to the live stream even when it opens
onto a session that is already dead, since a subscription cannot be added later without a
second reader double-counting the file. Reversibility does not soften the confirmation above:
the repair arrives seconds late, drops the live chrome in between, and spends a request on a
tail the tab never lost.

**A session blocked on the user.** Claude Code writes `status: "waiting"` into the PID
file the moment it raises a dialog, with a `waitingFor` label saying which one, and
clears it when the dialog is answered, so the state is self-healing and needs no
event. seedeep keeps the label raw here and decides with `pendingInput`
(`core/types.ts`, shared by the browser, the digest and the notification watcher so they
cannot disagree) which ones mean *the agent is stopped on you*:
`"permission prompt"` (a tool or plan approval) and `"input needed"`
(AskUserQuestion, MCP elicitation). Everything else, such as `"dialog open"` (a picker the
user opened), `"sandbox request"`, `"worker request"`, or an unknown label from a
newer release, is deliberately NOT claimed as a pending approval. Nothing about a
pending prompt reaches the transcript, which is why this is read from the PID file
and not from an event; the contract claim that guards it is C24 (`claude-code-upgrades.md`).

Each record also carries a **readable subject**: the session's first task-bearing
prompt (typed, a non-control slash command, or a headless SDK prompt), skipping
session-control commands like `/clear` and `/effort`. The head scan reads the first
64KB in one shot and only reads further (up to 1MB) when an anchor is still missing,
so a session whose head is one huge line still gets labelled. The picker is a custom
combobox (glass popover, searchable) split into **Human / Automated** tabs, at real
scale the ~1000 headless (`sdk-*`) docs-gate runs would otherwise bury the human
sessions, so they get their own tab and the picker opens on Human. Each row shows the
subject over a `model · date · id · N turns` meta line (turn count fetched from
`/api/session-stats` on every open, omitted silently when not yet cached), and rows whose
session already has a tab are pinned. The subject is also what names a tab (`<project> · <subject>`).

### tailer

Given a file path and the last byte offset, reads only the new bytes, splits
complete lines, and holds any trailing partial line until the next read (session
files are appended live, so the final line can be mid-write). It skips files
whose size and mtime are unchanged, and resets to the start if a file is
truncated or rewritten.

### parser

A **pure function**: one raw JSON line in, zero or more normalized events out.
It never performs I/O and never throws on malformed input (a half-written line
just yields no events). It uses an explicit whitelist: six line types produce
events (`assistant`, `user`, `system`, `attachment`, `queue-operation` and
`file-history-delta`); every other line type is ignored.

The parser is also the single **anonymization barrier**: every session-derived
string it puts on an event (a tool's argument, a subagent's launch prompt, the
verbatim output a subagent returned) passes through `anon()`, which strips real
home paths (`/Users|/home/<name>` → `~`, and the slug-encoded `-Users-<name>`
form), the scratchpad root (`/private/tmp/claude-<uid>` → `~scratch`), uuids
(→ `<id>`), and control characters, then caps the length. Because anonymization
happens at the source, so nothing downstream (the reducer, the SSE frames, a
screenshot) can leak the host or user.

**One exemption, and only one**: the uuid inside a published artifact's URL
(`https://claude.ai/code/artifact/<uuid>`) is kept. The rule exists for session and
agent ids; an artifact id falls under it only by having the same shape, and masked
it turned the address of a page seedeep had just watched being published into a link
that goes nowhere and cannot even be copied by hand. The same uuid one character
outside that path is still masked. Nothing `anon()` touches is ever committed, so
this changes nothing about the repository; the exposure it does carry is a live demo
or screen-share of a real session, and public screenshots are covered by their own
rule: they are taken on a synthetic session, which has published nothing.

### watcher

The only stateful unit. It runs a short poll loop, keeps a tailer per active
session (and per subagent child file), routes new lines through the parser, and
emits typed events via an `EventEmitter`, each tagged with its `sessionId`. It
tracks per-session context fill so consumers can render "how full is it now"
without re-deriving it.

#### How it finds the live set without scanning the corpus

The gate is `isLive`, meaning `isOpen ?? isActive`. What is not obvious is how the set is REACHED:
a tick must never run the complete discovery and filter afterwards, or a machine with a
thousand cold sessions pays a full corpus scan several times a second whether or not
anything is running.

Since `isLive()` is `isOpen ?? isActive`, whenever the open-session mechanism answers at all
the live set is EXACTLY the sessions holding a live process file, and `isActive` is unreachable
and the mtime window decides nothing. So a tick reads `~/.claude/sessions/` (one small file
per running process) and looks each id up in a `sessionId → path` index. A full discovery
still runs, but only to PLACE an id never seen before, which is what a new session is.

Two states would otherwise bring that whole-corpus cost straight back, and both are handled:

- An open window nobody has typed into. Claude Code writes the process file when the
  window opens but the transcript only when the conversation does, so the id is on no disk
  any scan can reach, and this is precisely the idle case. A failed placement is remembered
  and not retried for `RESCAN_MS` (1 s), which caps that state at one scan per second and
  delays a brand-new session's first line by at most the same.
- **No mechanism at all.** `~/.claude/sessions/` is an undocumented Claude Code internal a
  release may drop; `listOpenSessions` returns `null` rather than `[]` for exactly this. Then
  the mtime window is the only answer there is and the watcher degrades to a full scan per
  tick: degraded, not blind.

### What a subagent's state SAYS vs what the reducer SAW

The reducer reports what it saw: `running` means "launched, and no terminal signal has
arrived". Turning that into what a surface shows is `displayState`
(`apps/server/src/core/graph-derive.ts`), and it overrides `running` in three cases:

| Case | Reads | Why |
|---|---|---|
| The session has ENDED | `unknown` | The signal is never coming. Only the view knows the session is closed |
| A Workflow run silent past `WF_SILENT_MS` (5 min) | `unknown` | A killed run gets no terminal signal anywhere, so silence is the only evidence left |
| A subagent with no trace of itself (`!hasStarted`) | `unknown` | Nothing on record says an agent is at work |

A background COMMAND has the same problem and cannot be answered the same way; see
[Is a background command still alive?](#is-a-background-command-still-alive) below.

`hasStarted(a)` is true when the agent has **any one** sign: an `agentType` from its sidecar,
tokens billed to it, a tool it ran, or text it returned. A subagent that reaches the end of a
session still `running` has none of the four: it is a launch with nothing behind it, not an
agent whose ending was lost.

It is a fact, not a timeout. Nothing in it measures duration: a legitimate `Explore` can run
for minutes and a threshold would delete true state to hide missing state. It does not claim the
agent finished: it declines to claim it ever started. Like the workflow rule it is DERIVED and
never latched: one line from the agent and it is `running` again, so a false unknown heals
itself within a watcher tick.

Counting and showing are different questions, and `hasStarted` answers only the first. The
Graph LISTS the launch with an `unknown` badge, because seedeep sees a line in the transcript and must
not hide it, and a launch that never started is an anomaly worth noticing, while `/api/digest`,
whose `subagents.running` a status row prints as a number, does not count it. The Graph's own
active count uses `displayState` too, so the two never disagree about how many are working; only
the list differs, which is the point. A Workflow row is exempt from `hasStarted`: its node
carries no type or tools by construction, and the silence threshold judges it instead.

### Is a background command still alive?

A background command's only ending is its `<task-notification>`, and **some launches never get
one**. `background && !outcome` then reads "still running" for as long as the session stays open,
however long ago the command really stopped. A subagent's `unknown` cannot be borrowed
here: it is reached by the view knowing the session has CLOSED, and this is a session still open.

So seedeep asks the machine. `apps/server/src/server/command-liveness.ts` runs on its own 15 s
clock (never the watcher's 300 ms tick, since it spends a subprocess), for the commands of sessions a
tree is already held for, and it asks ONE question: does any process still hold this command's
output file open?

A `Monitor` is never asked. Its output file is named the same way, so the probe *would* answer
with the wrong answer. A background shell command keeps that file open through the whole chain
(the harness's `zsh`, the command's shell, the leaf), which is what this mechanism rests on; a
monitor's stream does not, so a monitor that is demonstrably alive answers exactly like one that
has gone. What ends a monitor instead is its `TaskStop`; see the `agent-end` row in the event
table.

- The file is found from the launch's task id, not from the path the transcript prints:
  `anon()` masks the session uuid inside that path before it can reach an event, so the parsed
  value cannot open anything. Two `readdir`s under `/tmp/claude-<uid>` and the id names the file.
- The whole chain holds the file open (the harness's `zsh` wrapper, the command's own shell, the
  leaf), `claude` itself does not, and a command that ends or is killed releases it while the file
  stays on disk. One `lsof -F pn` answers every command at once, which is why the probe spends one
  subprocess per tick and not one per command.
- Three other sources cannot answer this and must not be reached for: Claude Code keeps no
  registry of its background shells on disk (the task id appears nowhere in `~/.claude` outside
  the transcript); the output file's mtime or size says nothing, since a healthy waiter can sit
  ALIVE for tens of minutes having written 0 bytes; and matching `ps` on the command TEXT fails
  because the harness re-quotes what it runs, so the string seedeep holds is not the string `ps`
  prints.

The verdict is `unknown` and can never be anything else. The probe learns that something
stopped, never what it stopped WITH, so it emits a `command-vanished` event, out of band,
`seq: -1`, applied like `subagent-meta`, and the reducer refuses it outright if the command has
an `outcome`: Claude Code's own word is the authority and can still arrive afterwards. The row's
duration becomes the last instant it was SEEN, printed as a bound (`≥ 4m 20s`), never as a
measurement.

It fails towards saying nothing. Two consecutive empty probes before a row tips; no verdict at
all when the file cannot be found, has been deleted (the scratch root lives under `/tmp`, which
the OS cleans), or when `lsof` is absent or times out. A missing prober leaves every row exactly
as it is today. LIMIT: `lsof` only, so a Linux box without it gets no verdict rather than a
`/proc/<pid>/fd` sweep, which is thousands of `readlink`s per probe where this is one process, and
Windows is out of scope.

## Normalized event model

The parser flattens the raw log into a small set of events consumers care about:

| Event             | Source field(s)                                              | Meaning                          |
|-------------------|-------------------------------------------------------------|----------------------------------|
| `usage`           | `message.usage` + `message.model` + root `effort`           | context fill + per-call delta, and the model/effort THAT CALL ran on; for a line flagged `isApiErrorMessage` also `apiError` (status + the message shown to the user), meaning the call FAILED |
| `attribution`     | `attributionSkill` / `attributionMcpServer` / `attributionMcpTool` | what is filling the context (skill turns are counted from this) |
| `compaction`      | `compactMetadata` / `isCompactSummary`                     | a compaction (context deflate)   |
| `user-turn`       | a user line that is `origin.kind: 'human'`, **or** carries `<command-name>`, **or** is the plain text of a command (see below) | the user sent something, which opens a timeline entry; `prompt` is the text (a command's `<command-args>`, or its arguments), `command` the slash command that carried it, `promptId` the invocation the line belongs to |
| `command`         | the same three shapes as `user-turn`                       | a slash command was used         |
| `turn-narration`  | an assistant `text` block on a line whose `stop_reason` is anything but `end_turn`; main session only; never the auto-continue receipt (see `turn-interrupted`), whose text no model wrote | mid-turn narration, the model saying what it is about to do: `text` (anonymized, capped at 2000) and `callId` (`message.id`), which is also the call whose tools form the Trace's round. A subagent's narration has no consumer and is dropped |
| `turn-result`     | an assistant `text` block on a line whose `stop_reason` is `end_turn` | the turn's final answer: `outputFull` (anonymized, capped at 20k) and `outLen`. The same shape on a CHILD line becomes `subagent-output` instead |
| `turn-interrupted` | `interruptedMessageId` on the next user line after an Esc, **or** Claude Code's auto-continue receipt, a `<synthetic>` assistant line that is not an API error, which it writes when it re-enters a session whose last round never finished | the previous turn was interrupted. After an Esc it is emitted BEFORE that line's `user-turn`, so the reducer closes the old turn before opening the new one. The receipt is recognised by its TEXT, not by the `<synthetic>` marker: the marker says only that no model wrote the line, while "this round is over" is read off the one wording measured to mean it, since a future notice Claude Code writes the same way would otherwise close a turn that is still working. It is the ONLY record that a killed round is over: the `turn_duration` that would have closed it was owed by a process that died, and a transcript only appends, so without it the turn stays `live` for good, running a clock nobody is working under and counting it into the session's total. It carries `cutoff`, and a cutoff closes only a round that made a call: an Esc says the user stopped something, while a killed session says only that nothing more is coming, so a bare `/model` is left to the 0-call → done presentation rather than promoted to an interrupted work turn. `cutoff` rides on to `TurnNode`, because the distinction outlives the event: a cut round IS interrupted, but it is not an **Esc**, and every surface that reads an interruption as the user's CORRECTION (the retrospective's "abandoned to Esc", the verdict's "second correction in a row") must exclude it. A crash is not a correction |
| `turn-end`        | a `system` line with `subtype: 'turn_duration'`; main session only | the turn finished: `durationMs` and `messageCount`, both nullable. Claude Code's own measure, not one seedeep derives |
| `agent-launch`    | `<forked-skill-launch>` on a `system`/`local_command` line  | a forked skill (`/code-review`) started a background agent: `launchedAgentId`, `skillName`, `description`. It is NOT a `tool_use`: this line is the only record that the agent exists, when it started and which turn asked for it |
| `file-change`     | a `file-history-delta` line (`trackingPath`)               | Claude Code backed up one file it changed, in its own /rewind ledger. It records ONLY what CC's own file-writing tools wrote: a file written by `python3`, by `cat >>` or by the build produces no delta at all, and WHICH session made a shell write is recorded nowhere on disk. So the Changed files card does not count this event: its number comes from the session's own commits via `GET /api/files` (`docs/session-output.md`), reproducible with `git show --stat`. The ledger's one remaining job is the session scratchpad, which lives outside the repo where git cannot see it: `isScratchPath` (`apps/server/src/core/text.ts`) classifies on the `~scratch` token `anon` produces, so a path is anonymized BEFORE it is tested. `trackingPath` has TWO shapes, absolute or relative to the session's cwd, in which case `backup.realParentDir` names the directory, and `ledgerPath` resolves both. The reducer still attributes each delta to the open turn; the baseline `file-history-snapshot` stays ignored |
| `tool-start`      | a `tool_use` content block                                 | a tool call began: id, name, anonymized `arg`; for an `Agent`/`Task` block also the `launchPrompt` + `subagentType` + the launch `description` (which heads the subagent's row, see the GUI shell); for a Task-family block a `taskRef` instead of an `arg` (see below) |
| `tool-end`        | a `tool_result` content block                              | a tool call finished: `toolUseId`, `outputSize` (rendered char length); `error: true` when the result is a real FAILURE (a user refusal carries the same `is_error` flag but is NOT a failure, classified by `toolOutcome` in `apps/server/src/server/failure.ts`); for a foreground `Agent` result the inline `returned` payload; for a background one `launched` (a receipt: the subagent STARTED), for a `Workflow` also `workflow` (runId + name), and for a `TaskCreate` result `taskCreated` (the todo number it was given + its subject). A launch into the BACKGROUND carries `background` (taskId + who put it there), and it has two receipt shapes: a `Bash`'s `backgroundTaskId`, and a `Monitor`'s `taskId` **with** `timeoutMs`, the same kind of launch under a different field name. The second half of that gate is not decoration: a `TaskUpdate` receipt carries a todo's `taskId` and a `Workflow`'s carries a run's, and `taskId` alone would list both as running commands |
| `agent-end`       | a `queue-operation` line whose content is a `<task-notification>`, OR a `TaskStop` receipt (`Successfully stopped task: <id>`) | a background subagent really finished: `toolUseId` (the spawn, **nullable**), `taskId` (`<task-id>`, the child's agentId), `status` (completed/failed/killed/stopped). Fires on every stop, so a resumed agent produces several: last wins, never latched, except the instant a background COMMAND ended, which is first-wins. Claude Code writes each notification twice (`enqueue`, then `remove` when its queue drains) with an identical payload but not at the same time (minutes apart in the worst case) so last-wins would date the end to the DRAIN rather than to the stop. The status and the sentence stay last-wins, where a repeat really is inert. The event is gated on `toolUseId` OR `status`, never on the spawn name alone: the subject is an AGENT and the line names it TWICE, so requiring the spawn drops the only signal a subagent with no spawn ever gets, and a skill forked into the background has none by construction (its `meta.json` carries no `toolUseId`). What makes a notification TERMINAL is the `status`: the same line type is written for progress (`event` + `summary`, no status), and that ends nothing. The reducer enforces it where the difference is destructive: a background COMMAND is closed only by a notification carrying a status, since applying a progress summary as its outcome would mark it `done` minutes early and measure its duration to the wrong instant. A progress notification carries a `<task-id>` and never a `<tool-use-id>`, so none can reach a command through this event at all: they are reported as `background-event` instead, which counts them against the task and ends nothing. `toolUseId` is not always a spawn either: after a `SendMessage` resume Claude Code keys the notification on the resume call. So the reducer routes by `toolUseId`, then `taskId → spawn`, then, naming no spawn we hold, records the end against the agentId itself. The line is also written for things that are not subagents (a background `Bash`/`Monitor` task, a `Workflow` run, a nested spawn): those name no agent, so nothing ever looks them up. `<task-id>` carries a type prefix: `a…` an agent (always naming a child file), `b…` a background shell task, `w…` a workflow run. A `TaskStop` receipt is the other source of this event, and the only end a stopped `Monitor` ever gets: Claude Code writes no notification for it and the liveness probe cannot answer for a monitor either, so without this the row would call itself running for the rest of the session. It names the TASK and not the call, so the reducer resolves it through `bgByTaskId`; its status is `stopped`, Claude Code's own word, which every surface already reads as a clean end |
| `background-event` | a `queue-operation` line whose `<task-notification>` carries an `<event>` and NO `<status>` | a still-running background task reported something, today only a `Monitor`, whose stream is its whole output. `taskId` (the launch receipt's own id, the only link it carries, since there is no `<tool-use-id>`), `event` (anonymized: a watched log line can hold anything). **Only the `enqueue` copy** is emitted: Claude Code writes the identical payload again as `remove` when the queue drains, and counting the line would double every event that happened to be drained. The reducer counts these per task id and keeps the latest: the row shows a count and one line, and none of them reach the activity feed, whose ring is `FEED_CAP` rows deep and has other things to hold |
| `note` | an `attachment` line whose `hook_additional_context` comes from a TOOL hook (`hookEvent` `PreToolUse`/`PostToolUse`), OR a `<task-notification>` carrying nothing but a `<summary>` | something attached TEXT to the session that seedeep would never have derived: a hook warning about the file just written, a background review reporting findings. `toolUseId` (null when it is about the session and not a call), `hook`, `source` (the writer, when the text declares it as `[from <plugin> plugin]`), `text` (anonymized). `attachment` is otherwise dropped wholesale, since nearly all of them are the bookkeeping every tool produces, twice per call. The gate is the hook's EVENT, and NOT the presence of `toolUseID`: a SessionStart injection carries `toolUseID: "SessionStart"`, a non-empty string that anchors nothing, so an id-only gate emits all of them as notes about a call that does not exist. The field takes exactly two shapes: `PostToolUse` with a real `toolu_…`, and `SessionStart` with that literal. The `content` is an array of BARE STRINGS, not of `{type:'text'}` blocks, which is why `renderedText` returns nothing for it. An UNANCHORED note also carries WHEN it arrived and in which turn: the complete-history list (`Expand all`) folds it in among the calls in time order, being the only surface with no cap, and one appended at the end would sit beside work it has nothing to do with. It is not a span, and the Trace never draws one: `SpanType` carries a `note` member that only that list ever produces. Not modelled as "a security finding": a type keyed on one plugin goes blind the day another one speaks |
| `wakeup` | a `ScheduleWakeup` receipt (`toolUseResult.scheduledFor`) | the session arranged to wake itself up (a self-paced `/loop`): `toolUseId`, `at` (epoch ms, null when the receipt STOPPED the loop, with `scheduledFor: 0` and `stopped: true`). NOT a background task: nothing runs, nothing holds a file open, there is nothing for the liveness probe to ask about. Last-wins in the reducer, because a dynamic loop re-arms every turn and only the newest instant is what the session is waiting for. **The firing is invisible**: a wakeup that goes off produces no line of its own, no `origin` and no `promptSource` that tells it from any other system prompt, so every surface shows this while the instant is ahead and stops showing it after, and none of them ever says it fired |
| `command-vanished` | NO LINE; the server's liveness probe                     | nothing holds a background command's output file open any more, so its process is gone: `toolUseId`, `lastSeenAlive`. The only event with no source in the transcript, because the fact is not in it; see [Is a background command still alive?](#is-a-background-command-still-alive). It says a command STOPPED and never what it stopped with, so the reducer turns it into `unknown`, refuses it outright when an `outcome` is already there, and applies it idempotently (`seq: -1`, out of band, like `subagent-meta`) |
| `workflow-agent`  | a run's `subagents/workflows/wf_<runId>/` dir + its `journal.jsonl` | one subagent of a Workflow run: `runId`, `phase` (`seen`/`started`/`result`). `started` minus `result` is the only record of how many are still working |
| `subagent-meta`   | `agent-*.meta.json` sidecar + the child's model            | agentId → toolUseId link, type, model, and the sidecar's `description`, which is what the agent was launched to do, which for a forked skill is the ONLY name it has |
| `subagent-output` | a child assistant line with `stop_reason: "end_turn"`     | the verbatim text a subagent returned to the main session (its final answer) |

### The Task family takes references, not arguments

`TaskUpdate`, `TaskGet`, `TaskOutput` and `TaskStop` do not name what they act on: they point
at it, and at **two different task systems**, which the id field names apart: the task list
spells it `taskId` and numbers rows sequentially (`{taskId: "1", status}`), while background
tasks spell it `task_id` and carry a hex that **is a subagent's agentId**. Reading the wrong
field yields no label at all. So the parser emits a **`taskRef`** (`id` + `kind`:
`todo` or `agent`) rather than an `arg`, and the **reducer**, the only layer holding the
cross-event state, resolves it into a label:

- `todo` → the subject from the `TaskCreate` result that named that number (`#1 Fix the parser
  → in_progress`). The number exists ONLY in the result; the input has no id.
- `agent` → the subagent's type, via the same `agentId → spawn` map `SendMessage` uses
  (`docs-researcher`). Unresolved, it degrades to a short id, never a raw hex.

Both the snapshot and the live feed read that one resolved label (`EventContext.label`), so a
call can never read one way in the feed and another in the drawer. `TaskCreate` is labelled by
its `subject` directly, and `TaskList`, whose input is `{}` on every real call, keeps no
argument at all rather than being given an invented one.

Every event also carries an optional **`agentId`**: `null` for the main session,
the subagent id for events read from a `subagents/agent-*.jsonl` child file. Every reducer
must branch on `agentId` before touching main-session figures; a child's `usage`
applied to the main fill is the exact bug that shipped once.

A subagent is born at its SPAWN, not at its child file. The list of subagents is keyed
by the spawning `Agent` tool_use id and created the moment that block is seen; the child file
only enriches it (model, usage, output, real duration) and may arrive late or never. Keying
the list on the child instead makes a whole class of launches invisible: a `Workflow` run's
subagents have no spawn of their own in this session's log.

A launch receipt is not a completion. A `tool_result` for an `Agent` block means "this
subagent finished" only when the spawn was *foreground*. Since CC v2.1.198 subagents run in
the background by default, and a background result carries `status: "async_launched"` and
lands almost immediately after the spawn: it is a receipt saying the work *started*. Reading
it as a completion makes every background subagent be born `done`, so the live monitor never
shows one working. The real end arrives later, on its own line type
(`queue-operation` → `agent-end`). The parser flags the receipt (`launched`), and only a
foreground result ends a subagent.

Subagent returned output: the child jsonl is authoritative. A subagent's
final answer is read from its child file (the last `end_turn` assistant line),
not from the parent's `Agent` tool_result: a *background* (`isAsync`) subagent's
parent tool_result is only a launch acknowledgement and carries no output. The
inline parent `returned` payload is kept as a fallback for the synchronous case.
A subagent's real duration likewise comes from the span of its own child-line
timestamps, not the parent spawn↔result round-trip (which is ~0 for a background
subagent that returns immediately while it keeps working).

**Context fill** is the last absolute `input + cache_read + cache_creation` of a
`usage` line (how full the window is right now), while the delta between
consecutive usage lines drives the trend.

The denominator follows the calls, not the session head. The window comes from
`main.model`, which is the model of the LATEST main-session `usage`, never a value read
once when the tab opened. Two states make the difference visible, and neither announces
itself:

- a session opened right after `/clear` has written no assistant line yet, so discovery can
  only report `model: null` and the window falls back to 200k + `estimated`. Seeding the
  denominator once freezes that fallback until the page is reloaded;
- `/model` mid-session moves the real window (opus-4-8 is 1M, sonnet-4-6 is 200k), so the
  same 188k reads as 19% full or 94% full depending on which model is believed.

`main.model` is therefore the model in force NOW, and `main.models` every model the session
has run on in first-seen order, since a surface that shows only the last hides that anything
changed, and one that shows only the first is the bug itself. Each `TurnNode` carries the
same pair scoped to its own calls (`models`, `efforts`), which is what lets a scoped widget
name the model that turn actually ran on. `efforts` is empty on most turns: Claude Code only
writes `effort` when one is configured, so the absence is the normal case and no surface may
render a placeholder for it.

Two numbers, two questions, not to be conflated. A `usage` line is the whole
prompt of ONE API call, so the reducer keeps its tokens in two shapes:

- `main.breakdown` / `turn.breakdown`: the **last call**, absolute. It answers
  "what is the window made of right now", so it (and only it) drives the Context bar.
  The last call that reached a MODEL, which is not every `usage` line: Claude Code
  stamps `<synthetic>` on lines that called none (the "No response requested." it
  writes when a killed session is resumed, and API-error lines) and gives them a
  `usage` block all the same, structurally a call's and all zeros. Taken as last-call
  state it reports an empty window, so the reducer refuses a line that names no model
  AND reports no tokens (`reportsWindow`). Both conditions: a real call can arrive
  without a model on the line, and can never read zero, having at least its system
  prompt. The SUMS below are outside that guard, since an all-zero line adds nothing to them.
- `main.cacheTotals` + `main.inputTotal` + `main.outputTotal` (and the per-turn
  equivalents), **summed over every call in the scope**. They answer "how many tokens
  did this billing category cost", and they drive the **Session** card's ledger.

The **Session** card's ledger reports the four categories Anthropic names in the
`usage` block, using those names verbatim so nothing is ambiguous:

| Card label   | `usage` field                  |
|--------------|--------------------------------|
| Input        | `input_tokens`                 |
| Cache write  | `cache_creation_input_tokens`  |
| Cache read   | `cache_read_input_tokens`      |
| Output       | `output_tokens`                |

The four category rows are the **main thread's** consumption and are headed *main session*,
because they and the Subagents row measure different things, a category versus an actor, and
both add to the hero; unlabelled they read as one four-item list and the hero stops looking like
their sum. The card's hero is the whole-session **total** = the four categories summed, plus a
separate **Subagents** row. That row is the sum of each subagent's cumulative **volume**,
Σ its own per-call `input+output+cache`, read from the child jsonl the watcher tails and
folded once per `callId` exactly like the main sums. It is kept a separate row rather than
folded into the four categories because a subagent's tokens are billed under its OWN context
window, not the main one. It is the same metric on both sides, which is what makes the row and
the hero comparable: a subagent's *last* call is not its volume, and reading one for the other
understates a multi-call subagent by an order of magnitude. A **background** subagent writes no child jsonl, so its
per-call usage is unavailable: its volume falls back to the parent-reported `totalTokens`
(≈ its final context, not a true sum) and is flagged **estimated**, so the Subagents row shows a
leading `~` when the total blends any such approximation. The per-subagent card mirrors the
split: a **VOLUME** line (cumulative, no window frame, since a volume can exceed the window) and a
**CONTEXT** bar (the subagent's final `fill` over its window), with the four categories in the
drawer, drawn there as ONE stacked bar, because their meaning is the ratio between them and not
four separate figures. It is a VOLUME view rather than a cost one: the categories are additive tokens, deliberately
not price-weighted (cost is ccusage's lane, not seedeep's). Re-read (`cache_read`) dominates
every real session, the same window handed back on every call and the bulk of a subagent's
volume, which is exactly the invisible churn seedeep exists to show.

The Subagents row opens into a **by-model** bar: the row's total split by which model burned it,
one segment per model **family** (`opus`/`sonnet`/`haiku`/`fable`), biggest share first. It is
subagent tokens ONLY: the main thread never enters it, the two staying apart by the reducer's
`owner`, so the bar splits the figure directly above it and never the hero; it is absent when no
subagent ran, because the row it explains is absent then too. The split is charged per CALL, not
per agent: `subagent-meta` names one model per agent, but a subagent transcript can run on more
than one family, and charging the whole volume to the declared model misattributes every token it
spent elsewhere. An estimated volume, having no per-call detail, lands wholly on the agent's own
model, so the split always totals the row.

Summing per SCOPE, not per last call, is load-bearing: within a single call `cache_read`
is the entire conversation prefix while `cache_creation` is only the newest increment,
and a turn's LAST call is its cheapest (the final answer adds almost nothing), so a
last-call reading understates a turn that re-created hundreds of thousands of tokens.
A line is not an API call. Claude Code writes ONE LINE PER CONTENT BLOCK: thinking,
each `tool_use`, text, and every one of those lines repeats the SAME `usage` block.
Anything summed over calls therefore folds once per `message.id` (carried on the
event as `callId`, with the `seq` as fallback for `<synthetic>` lines that have no id):
`cacheTotals`, `inputTotal`, `outputTotal`, and `apiCalls`. Summing per LINE multiplies
each call by its block count. The same guard also absorbs the stream's high-water re-send after a reconnect
(`stream.ts` guards with `seq <`), which a SUM, unlike everything set-shaped in the
reducer, would otherwise double-count.
And not every `usage` line is a call at all. Claude Code's auto-continue receipt carries a full
usage block, all zeros, having reached no model. The parser marks it `noCall`, and the reducer
withholds `newCall` from it, not merely the counter, because `newCall` is the ONE signal that says
a fresh call happened and three surfaces read it: the header's count, the feed's row and the Trace's
`api` span (with `callMs`, a latency that would be measured to a line that never called anything).
Excluding it from the counter alone left the three disagreeing on screen. A FAILED call is not the
same thing and raises all three: it reached the API. The two are told apart by `isApiErrorMessage`,
never by the model: both are `<synthetic>`, and both report zero tokens.

Every file-tailed event also carries a **`seq`**: a per-file line number assigned
by whoever reads the lines (the watcher for the live tail, the replay reader for
history). It is a POSITION, not a counter, so it rises with the tail and restarts
with it: when a file shrinks, the tailer re-reads from offset 0 and the watcher
resets the number in the same step, a re-delivery from 0 which the guards below
already handle. (No Claude Code path produces that: compaction, `--resume` and
`/rewind` all append, the last forking the DAG by appending a branch. The reset
keeps the two ends of one fact together, and covers an edit from outside.)
One `seq` per source line, so a line yielding several events
(e.g. `usage` + `attribution` + `tool-start`) shares one `seq`. Out-of-band events
carry `seq < 0` (a `subagent-meta` read from `meta.json` has no line position),
and the reducer folds those idempotently.

That numbering is what makes a live stream and a replay safe to overlap. The marks
a client keeps, and the exact test each one applies, are the wire contract:
[api.md](api.md#deduplicating-live-against-replay).

## Consumers

The core makes no assumptions about transport or rendering. A consumer imports
the watcher, subscribes to its events, and renders them: a terminal UI, or a
locally-served web GUI. Keeping the transport out of the core is what lets the
same event feed drive every front-end.

Consumers fold the event stream with the **session-tree reducer**
(`apps/server/src/core/session-tree.ts`): the browser over a live stream, the corpus scanner
over one file at a time: it maintains the main fill + token breakdown,
each subagent (fill, model, state, launch prompt, returned output, tool calls,
real duration), main and per-subagent tool nodes (name, duration, argument,
output size), compaction nodes, and per-skill turn/invocation counts, and hands
callers an immutable `snapshot()`. It exposes `onChange(cb)` (a bare "something
changed" signal, for rendering) **and** `onEvent(cb, ctx)` (each applied event, for
per-event UI like toasts and the activity feed). `onChange` carries **no payload**: a
listener pulls `snapshot()` itself, when it is actually about to paint. Carrying one
per event makes folding a session O(n²), while `snapshot()` is O(turns + tools + agents), so
and the view, which coalesces its paints, would throw every one of them away. `ctx.turnIndex`
is the turn the event belongs to: the reducer is
the only layer that knows it (events carry no turn), and for a subagent's event it is
the turn that *spawned* the subagent, so an async subagent outliving its turn still
counts against the turn that asked for it.

The timeline holds everything the user sent, and each entry is classified by what it
COST, never by its name. A typed prompt and a slash command are indistinguishable in
intent (`/paste-image fix this` is a prompt with a helper attached) but not in the log: a
slash command carries no `origin`. Gating turns on `origin.kind: 'human'` therefore drops
every one of them: a `/paste-image` round gets no turn at all, so nothing is live while
Claude works and its `turn_duration` lands on the previous turn. The parser reports what was
sent and leaves the classification to the reducer, which decides from the
token count (`TurnKind`):
- **`work`:** it consumed tokens, meaning typed prompts and commands that run the model.
- **`local`:** a command that closed without burning a single token, without an Esc, and
  without launching an agent (`/model`, `/effort`). Cost through an agent is cost: a forked
  skill such as `/code-review` makes no call on this thread, so the token count alone would
  file it here. No list of local built-ins is kept anywhere: the token count is the proof,
  and it cannot go stale as Claude Code adds commands.
- **`context`:** `/clear` and `/compact`, the two commands whose job IS to move the context
  window. A closed, intrinsic pair; `/compact` costs real tokens, so cost cannot separate it
  from a work turn; only intent can, which is why these two names appear in the code.

Whose line it is is decided before what shape it has. A headless `claude -p` line carries no
`origin` either, so reading the shape first would file `claude -p "/review
this"` as a slash command, and turn detection keeps a command while it drops an sdk
prompt, so a headless run would grow a turn it never had. `promptSource` is therefore read ahead of
both shapes rather than guarded inside one: an sdk line stays an sdk line and still names its
session with the command's arguments.

A command is written in one of TWO shapes, and both are the user sending something. The
familiar one is the expansion: `<command-message>` / `<command-name>` / `<command-args>`. The other
is the command exactly as it was typed, in plain text (`/code-review del diff`), with no `origin`, no
`promptSource` and no tags. It is the rarer of the two, and reading only the tagged shape loses the
whole round: the command gets no turn at all and its work is credited to the previous one. The gate
for the plain shape is
`origin` **absent** (a task-notification is a `user` line with an origin of its own) and not
`isMeta`, and the line must be a command and nothing else, anchored at both ends.

One invocation can write BOTH shapes, and they share a `promptId`. The reducer folds them into
one turn, keyed by `promptId` **and the command name**: a prompt QUEUED while a command runs
inherits that command's `promptId`, so deduping on the id alone would swallow a human turn to save
a duplicate one.

`state: 'live'` means **working**, not merely open: an entry goes live only once it has
consumed a token, or while an agent it launched is still running. Otherwise a `/model`,
which opens an entry and is never closed by a
`turn_duration`, would pulse green forever. `turns` counts `work` entries only, so it keeps
meaning "rounds of work" even though the timeline shows more than those.

Skill and command counts exist twice: once for the session and once
inside each `TurnNode`. A widget scoped to a turn reads the turn's own counts, so it
can never show a session-wide number (`/clear ×3`) on a turn that used it once. Both
are built by the same helper, so their shape and ordering cannot drift.

**The live intent panel (V1)** answers "what is the agent trying to do right now" from a datum
the model already writes: a main-session `assistant` line that carries a **text block** but
is **not** the turn's end (`stop_reason !== "end_turn"`) is mid-turn **narration**. The parser emits it as a `turn-narration`
event (main session only, since a subagent's narration has no consumer); the reducer keeps the
latest per turn (`TurnNode.lastNarration`, last wins). The panel sits between the Live activity
header and the feed; it shows the current intent, or the turn's final output (`TurnNode.result`)
once the `end_turn` answer lands, and its age. The text is clamped to two lines; when it
overflows, a `more` (revealed by measuring overflow after layout) opens the full text, rendered,
in the output modal. No LLM: the extraction is pure, because the harness already makes the model
narrate in short phrases. The activity feed below trades rows for the panel so the card's height
barely moves: its visible cap drops as the panel grows, measured from the panel's line count after
layout, while the ring still retains `FEED_CAP` = 13 for the drawer, with the full history in
Expand all and the Trace.

What the agent DID since it last spoke outranks what it said, once its words have had their
moment. A narration alone leaves the panel stale, not empty: one narration can stand unchanged
for minutes while tool calls run under it. So the panel also carries an **activity group**: one
line counting the turn's calls since its last word (`TurnNode.activity`, `ActivityGroup`).

The handover is **not** immediate, and that is the whole difference between a live panel and an
unreadable one. A narration is frequently the newest thing that happened for only a second or two,
so giving the panel to the group on the turn's first call makes every narration flash past: the
words are there and nobody can finish them. The last word (via `TurnNode.lastWordTs`) therefore
holds the panel for as long as that particular word takes to read (`narrationHoldMs` in
`apps/server/src/core/activity-line.ts`) and only then does the group take over, for as long as
the silence lasts.

The hold is `chars / 17 per second`, floored at 3s and capped by what the panel can actually SHOW:
`.nowtext` is `-webkit-line-clamp: 2`, so past the two visible lines the text sits behind `more`
and no amount of holding reveals it. A flat hold is wrong in both directions: the short
narrations, which are the majority, are read long before it expires, and the long ones are cut off
mid-sentence, which is why the hold is derived from the text rather than fixed. It runs from the
word's **first sighting**, never from its timestamp: Claude Code stamps a text block when it starts
generating it but appends the line only once the block closes, so counting from the stamp spends
most of the hold before the panel has anything to show. Because no event announces the deadline
passing, the panel arms one entry on the shared 1s ticker that re-runs its own decision, and since
that makes it the one surface re-rendering OUTSIDE `render()` (which is what clears the counters),
its counters carry `owner: 'now'` and it reclaims them on each pass. Without that reclaim the
ticker list grows by an entry or two a second between events, each re-written on every tick.
Three rules define the group itself:

- **Derived, never accumulated.** The group is read off the tool ledger: a call counts when it
  started after the turn's `lastWordTs`, the later of its last narration and its final output,
  never tallied as events arrive, so a reconnect's re-sent line rewrites the same ledger entry
  instead of double-counting it. Because `snapshot()` runs on every event, the derivation is
  **memoised per turn** (`groupCache`) over a per-turn index of call ids (`toolIdsByTurn`), and a
  turn is recomputed only when something that feeds its group moved: one of its own calls started
  or ended, or the turn spoke (`dirtyGroups`). Walking the whole ledger on every snapshot instead
  costs a large session's replay a double-digit percentage of its time; memoised, the derivation is
  free. A cache like this can only be tested by asking
  for the snapshot after EVERY event, which is what the golden transcript does, and a test that
  snapshots once at the end cannot see a stale group.
- **The group empties itself.** Any word from the agent, a new narration or the turn's
  `end_turn` answer, moves the cutoff, so the panel hands itself straight back to the agent's
  voice, and a turn that ended normally has no group at all.
- **Main session only.** A subagent's calls carry no `turnIndex` by construction, so they stay in
  their own lane instead of inflating the main panel.

The words live apart from the panel in `apps/server/src/core/activity-line.ts` (pure, so the wording is
testable): one verb and an explicit plural per tool, MCP tools summed per **server** (`get_issue`
+ `list_comments` read as "2 linear calls", taking ONE slot), biggest count first with ties broken
by name so the line cannot jitter, and an unmapped tool named rather than given an invented verb.
The line names at most `MAX_FAMILIES` = 3 of them and trails off; a group touching more than three
is rare enough that the tail costs almost nothing. It is past tense only: what is running lives in
the age chip, so the text does not move with the clock and needs no ticker entry.

The **age chip times the running CALL**, not the group: it answers "is something still going, and
for how long", in the same unit as the feed rows below so the two read as one card. It shows the
oldest call open for at least `RUNNING_AFTER_MS` = 1s (a lower bar would flash and vanish: most
calls finish in a fraction of a second), and is otherwise ABSENT, since most of a group's life has no
call open that long, and the panel then shows the count with no number. A call crossing the
one-second mark is nobody's event, so that chip appears on the shared 1s ticker.

One limit worth knowing before reading the chip as "nothing is running": Claude Code writes a
call's `tool_use` line several seconds after the call starts, so a short call is never observed in
flight at all. The chip times the slow calls, which are the ones worth timing.

The line is seedeep counting, not the agent speaking, so it wears the same quote-less `.plain`
voice as the waiting panel. Capped at three families it stays inside the two-line clamp, but the
deferred overflow measure can still add `clamped` after the panel has rendered, which reveals
`more`, so `more` opens the line in full rather than being left inert.

The set of SSE event types the browser listens for lives in **one shared list**,
`apps/server/src/client/event-types.ts`, imported by both the live stream (`stream.ts`) and
the replay driver (`replay.ts`). A type present on the wire but absent from a
listener is silently dropped; keeping a single list is what prevents the two
paths from drifting (a new event type wired to one but not the other).

## The local server

The web GUI is served by a small local server that bridges the watcher to the
browser. It is a single process: the watcher tails the session files while the
server streams what it emits to the page. There is no daemon: it runs while you
watch and stops on Ctrl-C.

```text
watcher (EventEmitter) ──▶ server ──▶ browser
                            │  ├─ GET  /                  static page
                            │  ├─ GET  /api/sessions      roster CATALOGUE: every session, stable half (JSON)
                            │  ├─ GET  /api/live          roster LIVE half: running sessions (JSON, polled)
                            │  ├─ GET  /api/digest        live DERIVED state per live session (JSON, polled)
                            │  ├─ GET  /api/session-stats per-session turn count (JSON)
                            │  ├─ GET  /api/stream        live events (SSE)
                            │  ├─ GET  /api/replay        one session's history (SSE)
                            │  ├─ GET  /api/tool-output   what one tool returned (JSON)
                            │  ├─ GET  /api/call-io       one API call's input+output (JSON)
                            │  ├─ GET  /api/commits       the commits this session produced (JSON)
                            │  ├─ GET  /api/files         the files those commits delivered, plus scratchpad and artifacts (JSON)
                            │  ├─ GET  /api/cards         the tracker cards it worked on (JSON)
                            │  ├─ GET  /api/agent-prompt  one WORKFLOW member's opening prompt (JSON)
                            │  ├─ GET  /api/baseline      the user's per-turn token baseline (JSON)
                            │  ├─ GET  /api/retro         the minute-zero corpus retrospective (JSON)
                            │  ├─ GET  /api/compare       weight per session, by time window (JSON)
                            │  ├─ GET  /api/search        sessions whose dialogue holds every word (JSON)
                            │  ├─ GET  /api/update        which version is current, and how this install updates (JSON)
                            │  ├─ GET  /api/config        the redacted config (JSON)
                            │  ├─ POST /api/config        write the config file (JSON)
                            │  └─ POST /api/restart       hand the port over to a successor
```

Session data is one-directional: the server only ever pushes it to
the browser, and nothing seedeep reads is ever written back. The browser does
POST two things, `/api/config` and `/api/restart`, and both act on seedeep's OWN
state (its config file, its own process). The invariant is about the corpus, not
about the socket.

Every route, its parameters, its responses, its status codes and the SSE wire format
are in [api.md](api.md). What follows is only why the surface has the shape it does.

### The roster is served in two halves

Split by how fast each half changes. The catalogue carries only the fields that stop changing once
a session's file exists, so a client fetches it once at boot and revalidates with an ETag; the live
half carries the running sessions in full and is the only thing a client polls. That split is what
makes polling affordable: the catalogue grows with every session ever written, the live half stays
a handful of records, and every additional client would otherwise pay the whole corpus again every
few seconds.

`core/roster.ts` owns both projections and the merge that rebuilds the whole (`toCatalogue`,
`liveOf`, `mergeRoster`); the client reassembles inside `createRoster`, so every consumer above it
still receives one plain roster. `mergeRoster` recomputes `isActive` from `lastActivity` and
re-sorts by it, because both are derived: the split must not transport what it can derive, nor
freeze an order that keeps moving. The contract that keeps this safe is
`mergeRoster(catalogue, live) === roster`, asserted in `apps/server/tests/roster.test.ts` against
fixtures and against a real roster from the machine running the tests.

A catalogue record taken while its session was live is PROVISIONAL: its `subject` can predate
the first prompt, its `model` the first API call, and its `lastActivity` is `null` by construction.
So a client refetches the catalogue on either of two signals, not one: the count changed (a session
was born), **or** it holds a provisional record for a session the live payload has dropped (a
session ended). Size alone cannot see the second, because a finished session keeps its file.

`createRoster` serves fresh rows from every poll but notifies only when the identity key changes:
`current()` feeds the dropdown, so a row parked behind an unchanged key becomes a stale tab, while
`onChange` redraws the picker, so firing it on every moved mtime would redraw forever.

Every reading runs under a 10 s deadline, and the poll's own liveness depends on it. The next
poll is armed when the current one settles, and `fetch` has no timeout of its own: a request sent
down a half-open connection settles *never*, since the browser has nothing to retransmit and waits for
an answer that cannot come, and the picker, the busy dot, ended-detection and auto-open freeze
together until the page is reloaded by hand. On expiry the request is aborted (a poll every 3 s
would otherwise pile up sockets nobody will answer) and the reading fails into the existing "keep
the last good roster" path.

That deadline is also why `persist()` refuses to write while `readings()` is 0: a boot whose first
reading failed proceeds with no rows, and saving that empty tab set would overwrite the workspace
the user actually had.

### The digest exists for a client that does not own the reducer

`/api/stream` and `/api/replay` carry `NormalizedEvent`s, parsed lines rather than meaning, so a client
that wants to know what a session is DOING has to fold them itself. The digest is the answer for a
client that cannot: derived state, already cooked, one entry per live session. The tray is the
reason it exists.

Three rules make an entry trustworthy:

- An entry is a JOIN, not a second derivation. Every number in it comes from the same reducer
  the browser runs, so the two surfaces cannot disagree about the same session.
- `turn.now` is `nowLine`'s answer, not a second one (`apps/server/src/core/activity-line.ts`).
  The browser's NOW panel calls that same function on the same inputs, so the rule about what a
  session is doing exists ONCE for both surfaces. The digest's copy is markdown-stripped and cut,
  because it serves clients that render no markdown and have no modal to open the full text in.
- **`running` and `launched` answer different questions**, and the second outlives the first: once
  the last agent returns, `running` is 0, and a client reading only it would say the session used
  none.

There is no cap on anything in an entry: sixteen concurrent agents is a legitimate session, and a
client that draws fewer is making that choice itself.

### One stream, and the four things that keep it connected

Every event the watcher emits, across all sessions, is framed and pushed on **one** multiplexed SSE
connection, each frame carrying its `sessionId`. One stream, not one per session, means opening or
closing a view is pure client-side state and never leaks a connection.

The stream also carries the one event the watcher does not emit: **`notification`**, the server's
own verdict that something is worth interrupting the user for. The transition detector
(`notify-watch.ts`) folds each reading of the digest and the engine (`notify-engine.ts`) gates its
output per channel: the tray subscribes here, a configured webhook is POSTed to instead. The
switches filter that output and never the detector's input, so turning one back on announces what
happens next and not the backlog it slept through. Evaluation is skipped entirely when nobody is
subscribed and no webhook is configured, which is what keeps an unwatched process idle.

Staying connected is not free, and SSE does not give reconnection for free on its own. Four
mechanisms make it true, each covering a failure the others do not:

- **Heartbeat.** Every 15 s the server writes a `heartbeat` event to each client. A session can be
  silent for minutes (a background subagent writes only to its own file), and a connection carrying
  nothing looks exactly like one that has died. It is a named *event* and not an SSE comment, because a
  comment reaches the socket but never the page, and the client's watchdog has to be able to hear
  it, and it carries no `id:`, so it never shifts the numbering of the real events.
- A failed write closes the stream. Evicting a dead client from the registry is not enough: the
  browser is never told, so its `EventSource` stays `OPEN`, fires no error and never reconnects.
  `ClientRegistry` closes the controller, which ends the response, the only thing the browser can
  act on.
- The client owns its reconnect. `EventSource` retries by itself only while it is still
  `CONNECTING`; a fatal error leaves it `CLOSED` for good. `stream.ts` watches `readyState`,
  rebuilds the connection, and reports every transition through `onStatus`, so the header pill is the
  only thing on screen that speaks about the connection, since a card's `live` badge reports whether
  the SESSION is running.
- **A watchdog on the heartbeat**, so a connection that is `OPEN` but silent is treated as lost.

A client recovers what it missed with `/api/replay?from=`, not by asking the stream to rewind: there
is no backlog and no `Last-Event-ID` handling. The `seq` marks that make live and replay safe to
overlap are the wire contract, and they are specified in [api.md](api.md#the-sse-protocol).

The replay→live seam is the server's business only up to the frame: the browser's
driver (`client/replay.ts`) decides what to drop, because only it knows what it has already folded.

### Reading one thing back

`/api/tool-output`, `/api/call-io`, `/api/agent-prompt`, `/api/commits`, `/api/files` and
`/api/cards` all name a session and read it on demand rather than holding it in memory.

The path always comes from the roster, never from the query. A caller can only name a session
seedeep already discovered, so no path outside the corpus is reachable. This is the property that
makes the whole family safe to expose.

### The aggregate cache

The **minute-zero retrospective**: corpus-wide aggregates shown on the Home surface at launch,
without waiting for a live turn (`apps/server/src/server/aggregate-cache.ts`). It runs the real
parser, reducer and verdict per session, the same code the live path runs, so the cache's numbers
and the GUI's cannot diverge.

It reads each session's subagent transcripts too, through `streamReplay`. Reading the parent
alone leaves a large share of the corpus's billable tokens out of every aggregate, because a
subagent writes its own file. Invalidation therefore stamps the children as well
(`subagent-files.ts`, `subagentStamp`): a child can be written when the parent is not, and the
parent's `(size, mtime)` alone would serve a summary missing that child. Where those files live is
defined once, in `subagent-files.ts`, and both replay and the cache read it from there, including
the Workflow run ids, which come from the directory rather than from the transcripts inside it: a
run writes its `journal.jsonl`, the only record that a workflow subagent started or stopped, before
its agents' transcripts exist.

**Two token figures, on purpose.** `totalTokens` is the complete amount processed; the other counts
only what was new. Keeping both is what stops a cache re-read from reading as spend.

The cache lives at `~/.seedeep/aggregates.json` and is derived from transcripts seedeep does not
own: deleting it costs a rebuild and nothing else.

### Cross-session comparison

Same cache, a different question: the retrospective aggregates TURNS across the corpus, this one
ranks SESSIONS against each other in a time window.

The unit is a **weighted token count** (`apps/server/src/core/token-weight.ts`), never a cost in
currency. Every API call is weighted twice and summed over the session and its subagents:

- **Per token type:** `cache read ×0.1 · cache write ×2 · input ×1 · output ×5`. Anthropic
  publishes these, expressed in tokens, as the Priority Tier burndown rates
  ([Service tiers](https://platform.claude.com/docs/en/api/service-tiers)): *"These burndown rates
  reflect the relative pricing of each token type."* Cache writes take the **1-hour** rate (2.00,
  not the 5-minute 1.25) because the cache lifetime is an hour on a subscription.
- **Per model:** Haiku ×1 · Sonnet ×2–3 · Opus ×5 · Fable ×10, derived from the price list and
  **seedeep's own**: Anthropic publishes no cross-model token ratio, and structurally never needs
  one (it partitions budgets: a separate Opus limit, Priority Tier commitments per model version).
  The surface states this distinction rather than hiding it. An unrecognised model id weighs **0**,
  never an invented ratio; a merely NEWER id falls back to its family, so a future `claude-opus-9-9`
  is not silently free.

Weighting is applied **once per call**, inside the reducer's existing per-`callId` guard, because Claude
Code repeats a call's usage block on every content-block line, so weighing per line would multiply
a call by its block count. `main.weighted` and `weightedSubagents` are kept apart (the two sides of
the reducer's `owner === null` branch) and summed together.

A session's weight is whole-session, not Σ its turns. `SessionSummary.turns` holds only closed
WORK turns, right for a turn retrospective and wrong for a session total: an unclosed final turn, or
an sdk session (which never writes `turn_duration`), would contribute nothing.

## Post-turn verdict

At the end of every turn, seven **deterministic** detectors (zero LLM) run over data the snapshot
already holds (`apps/server/src/core/verdict.ts`): a **wasted subagent** (a large output returned to
main, a heuristic lower bound), **compaction** mid-turn, a second consecutive **Esc**, a cold
**resume**, a **context** fill ≥70% of the model's window, an **exploration** (≥8 files read into
main with nothing changed and nothing delegated), and an **unverified ship** (real code committed
with no check run anywhere earlier in the session). The worst finding sets the turn's severity
(`good | warn | crit`). What the two faces of it look like is in
[features.md](features.md#a-verdict-on-every-turn-both-faces).

Three rules constrain what may become a detector:

- Every detector cites a public source. A rule defensible only by one user's private
  conventions is a rule written for one user, and seedeep ships to other people; the quote lives
  next to the threshold in `verdict.ts`.
- No detector compares a turn to the user's other turns. A turn that spends more because it
  DID more is not waste, and a personal-baseline comparison reports size rather than waste.
- A rule looks only BACKWARD. Only the *second consecutive* interruption is a finding: a turn
  that turns out to be the first of a streak is a lone Esc at the moment it closes, and a
  forward-looking rule would make a finding appear retroactively on a turn already rendered. A lone
  Esc is prescribed practice, not a defect.

A finding costs nothing to compute: every detector reads the snapshot the reducer already
produced, in one pass, so the verdict cannot become a reason to keep data around.

## The GUI shell

One page, one process, tabbed. A live session gets a tab by itself; on top of that the workspace
you left is restored, and a dropdown offers **all** sessions (active and inactive, grouped) to
switch to or add, including replaying a finished one. It is built as small ES modules: pure logic
(`stream`, `replay`, `sessions`, `tab-store`) unit-tested without a browser, plus thin DOM glue
(`tab-bar`, `nav-menu`, `dropdown`, `view`, `home-view`, `app`). What each surface SHOWS is
[features.md](features.md); what follows is the shell's own rules.

**The fixed surfaces live in a header menu, not in the tab strip** (`nav-menu.ts`, mounted on
`#nav` left of the wordmark): **Home**, **Compare** and **Search**, each keyed by a reserved id
(`HOME_ID`, `COMPARE_ID`, `SEARCH_ID`) that is not a uuid, so it can never collide with a session.
None of them is a session: all live outside the `openTabs` map, and `switchTo` shows their panel
the same way it shows a session's. The strip is where you find a SESSION, and a label that never
changes spends the width the subjects need. The trigger **adopts the current surface's name**
(`✦ Home`) and drops it on a session, because no tab is active while a fixed surface is on screen
and Search's panel, an empty input, does not name itself; it is one menu idiom with the picker
(toggle, click-outside and Esc close, ↑/↓ over real buttons, `aria-current="page"`).

Four of their properties belong to the shell rather than to what they draw: **Search** fetches
nothing on switch, having no answer until there is a question; **Compare** fetches on tab switch
rather than at boot, so a launch landing on a session tab does not pay for a corpus refresh;
**Home** is never closable, so an empty workspace never reads as a broken page, and its classes are
all `rt-`-prefixed because the stylesheet has no CSS scoping; and a row opens the session it
describes through the picker's own `openFromDropdown`, so a row and a pick cannot open a session
two ways.

`apps/server/src/client/` is rendering and transport; the meaning it draws comes from
`apps/server/src/core/`. What lives under `client/` is the DOM (the shell, the bento, the Trace,
the widgets), the SSE plumbing (`stream.ts`, `replay.ts`, `event-types.ts`) and browser-local state
(`tab-store.ts`, `end-guard.ts`, the client half of the roster split). Everything that turns events
into meaning is core, and the test for which side a module belongs on is not "does it compile in a
browser": it is **whether it derives**. A module that reduces or selects goes in `core/`; a module
that paints, listens or remembers stays in `client/`. That is also the only rule for splitting one:
`graph.ts` is the client's largest module and stays one, because splitting it per widget would hand
the drawer alone **25** bindings out of `createGraph`'s closure, and a module taking 25 parameters
is the same closure with a form to fill in. What DID come out is `graph-derive.ts`, the pure
derivations, with session state (`ended`, the clock) as a parameter. Extract what becomes
*testable*, not what merely becomes *shorter*.

The client ships as one bundle. `index.html` loads a single module, so there is exactly one
entry point: `bun run build:client` bundles `apps/server/src/client/app.ts` into
`apps/server/public/lib/app.js` (committed, so the repo runs without a build step), and
`apps/server/public/` therefore holds only the page, its stylesheet (`public/css/`, one file per
sub-feature, `<link>`ed in cascade order) and that artifact. The rule the layout enforces: a
shared module is resolved once. Registering each module as its own entry point bundles it
independently: a module imported by two entries is inlined into both, so the page loads two copies
of the same reducer. Adding a module is free (import it; the bundler follows).

The tab rules:

- A session that starts gets a tab, once. One rule covers the first visit and every session
  started later: a live, interactive session not offered before opens a tab. "Offered" is
  remembered (`known`, persisted next to the tab set), which separates *offer it once* from *reopen
  what I closed*: a closed tab is gone from the tab set but stays in `known`, so it never returns,
  not on the next poll and not after a refresh; `known` is pruned to the live sessions, since one
  that has ended can never re-trigger. It opens in the **background** (the exception is an empty
  screen, where a tab nobody is looking at would leave the page blank), and **automated runs are
  excluded**, since a headless `claude -p` registers as an open session for the length of its run
  and would otherwise pop a content-less tab on every git push.
- The workspace survives a refresh. The open tabs, their order and the active one are saved to
  `localStorage` on every change and restored at boot, and the saved set decides which tabs
  **exist**, so a tab you closed stays closed. Storage is best-effort, guarded at the access rather than
  only at the call, because reading `localStorage` throws outright where storage is disabled, and
  a dead storage degrades to opening the live sessions, the first-visit behaviour.
- A tab says which session it is, and its state is never words. The label is
  `<project> · <subject>`, the subject cut to 30 chars, because the project alone cannot tell two
  sessions of one project apart; state rides on other channels (pulse, dimming) since `· ended`
  eats the room the subject needs, with the `title` spelling it out for assistive tech so a class
  is never the only channel.
- The picker pins what is already open, since picking such a session switches to its tab rather
  than opening a second. The pin is pushed by `app.js` on every open/close: the roster's identity
  key is built from the sessions themselves (id, liveness, status, subject), so it does not change
  when a tab opens and could never drive this.

And the connection rules:

- **One shared live connection.** The whole GUI opens a single `/api/stream` `EventSource`; a
  client-side router dispatches each event to the tab that subscribed to its `sessionId`. Opening
  or closing a tab only mutates a handler map and never opens or closes a connection, so tabs
  cannot leak feeds. Replay is separate and ephemeral: each replay opens its own `/api/replay`
  `EventSource` that self-closes at `replay-end`.
- **Active tab = replay then live.** An active tab first subscribes to the live feed but buffers
  it, replays its history from the start (so the view shows the real accumulated fill immediately),
  then flushes the buffered live events the replay did not already emit, deduped on
  `(sessionId, seq)`, and continues live, losing no event written during the replay and doubling
  none. Until the replay ends the tab shows a skeleton loader and the views paint **nothing**: the
  Graph absorbs every event but draws only at the handoff, in a single pass, because a large
  session's history is thousands of events and painting through that flood rebuilds the whole bento
  per coalesced tick. The loader cannot hang: `startReplay` fires the handoff exactly once, on
  `replay-end`, on a dead connection, or on `stop()`.
- A read that was CUT reopens itself, after a wait that doubles up to 30s, until one reaches
  `replay-end`, the only frame that says the history is all here. The loss a cut causes is not
  spread evenly: the server sends the parent transcript whole and only then each child, so a cut in
  the child phase costs every subagent and no main-session line. The reopen asks only past what each
  file holds **whole**, since a line is several events sharing one `seq`, so the line a read died on is
  never claimed, and requests whole any file the tab has never seen, which is what makes the
  children arrive complete. A tab whose session has ENDED needs this most: nothing else would ever
  ask again.
- Nothing the tab already holds is delivered twice. A re-read is sent a line from its top, so
  the tab counts how many of that line's events it holds and skips exactly that many, the same
  offset-into-a-line the live path keeps, on the side that had none. It matters because the
  consumers are not idempotent, which is what the reducer's own idempotence hides: the feed appends
  a second row and re-points its index (so the first row never gets its duration), the Trace opens a
  duplicate span stuck on `running`, and the toast rail, armed at the handoff, announces a tool
  that ran minutes ago. The record is of what is HELD, not a budget spent as it is used: a read that
  skips a line still holds it, and the read after that must skip it again.
- Until the history is complete, the live feed is HELD, not applied. Two reasons, and the second
  is the one that bites: a line from the file's tail applied before the middle would put the newest
  turn ahead of every turn that precedes it, and the resume mark reads the live frontier as proof
  that everything below it is held, so a tab holding lines 0–2 and a stray line 500 would resume
  from 499 and lose the middle for good, then reach `replay-end` and call itself complete. The
  reader keeps the loader a while longer, which is the truth. The handoff (`onLive`) waits for a read
  that COMPLETES; `stop()` releases it too, including between two attempts when no read is in
  flight at all, since a closing tab has no later read to wait for.
- The reopen gives up on futility, never on a count. A read that advances resets the counter, so
  a slow or flaky path is never penalised however many rounds it takes; three consecutive reopens
  that gain no ground end it, because that read is not coming back: a server-side throw on one
  line, a proxy cutting at a fixed byte count, a child file that will not open. It also gives up
  when the roster says the session is GONE: a deleted session answers 404 forever, and an
  `EventSource` cannot read a status, so it fires the same contentless `error` a dropped path does.
  Either way it hands off what the tab holds, since keeping the loader up for a history that is never
  coming is the same freeze this replaced, reached from the other side. A tab that gave up keeps a
  history with a hole in it, so the live frontier stays untrusted for good (see the previous rule):
  a later resync asks from what was actually read. Giving up is a verdict on the attempts, never on
  the tab: an ask from OUTSIDE (the live stream recovering, the session being resumed) is new
  information and starts its own budget, backoff and futility count both. Carrying the spent one
  made that recovery path a dead letter, abandoning the ask on its first cut with no retry at all.
- **A live roster.** The roster is re-fetched on a light timer: a newly-born session appears in
  the dropdown (never stealing focus by auto-opening a tab), and a session that ends re-labels its
  tab, closes its live subscription and freezes the view on the last state.

**One view per tab, one feed.** The tab mounts the **Graph** against the session-tree reducer: a
bento dashboard, a right-side drawer (per subagent / tool / API call / tool-type / skill / command)
that locks page scroll, a read-only modal above it, the **Trace** ([`trace.md`](./trace.md)), and
toasts armed only after the replay hands off to live, so history never floods them. Which cards
exist and what each shows is [features.md](features.md). Four of its rules are structural, not
visual:

- Every drawer is laid out the same way, and the order encodes rank: a header (kind chip,
  title, and an identity line carrying only what the entity IS (type, model, owner) and never a
  measurement), then 2–3 KPI tiles for the facts it actually raises, then bars for anything that
  is a proportion, then the content blocks, then a `Details` list for bookkeeping. A fact the
  snapshot does not carry is DROPPED, never rendered as a dash.
- **One drawer, one router.** A feed row, a Trace span and an `Expand all` row all open through
  `openBlock`, so one entity can never be presented two ways. A feed row keeps only the
  `tool_use_id` and resolves it against a freshly built snapshot at click time, so the feed holds
  no second, drifting copy of a tool's state; `core/span-store.ts`, fed by `onEvent`, is the sole
  source for the other two. A breadcrumb (`BackEntry`) appears only where the surface you came FROM
  was itself a drawer and got replaced: the Trace and a feed row stay visible behind it, the
  all-activity list does not.
- `Expand all` reads the span store, never the feed's ring, whose cap is about the size of a
  median turn and whose eviction is destructive. It is the card's list, longer, and never a different
  one: `ACTIVITY_TYPES` keeps only the span types the two `feed.push` sites emit (`api`, `tool`,
  `subspan`, `spawn`), since the store also holds each turn's `prompt` and `result`, which are turn
  STRUCTURE. Subagent spans live **only** inside `turn.spawns[].lanes[].spans`, never in
  `turn.spans`, so the flatten must merge both or omit everything a subagent did while still
  looking complete.
- A subagent toast names the model the spawn runs on and never WAITS for it: it fires with the
  model line reserved and `syncSubToastModels` fills it in place on the next render. Filling in is
  the normal case, since Claude Code writes the child's sidecar BEFORE the parent's assistant line, so
  the `subagent-meta` firing the toast usually precedes anything that could name the model; when
  the `Agent` tool-start (carrying `spawnModel`) wins instead, the lookup falls back to
  `state.snapshot()`.

Selecting a turn scopes EVERY widget, the feed included. Context, cache, skills, commands,
activity, main tools and subagents all read the turn-scoped snapshot; the Session card's footer and
the timeline strip stay session-wide because they are the navigator. The activity feed is the one
widget not driven by snapshots (it folds raw events), so it scopes itself: its ring retains the
last `FEED_CAP` activities **per turn**, not globally, because a session-wide cap would have already
evicted an older turn's events by the time you select it, leaving that turn permanently empty.

Two rules govern the text seedeep puts on screen. A pending prompt takes over the NOW panel
from the roster rather than from the transcript, ticking on CC's own `statusUpdatedAt` rather than
on the poll that noticed, and names the tool it is waiting to approve only WHEN THE TRANSCRIPT HAS
IT, while for a gated `Bash` it does not, which is why `pendingTool` is nullable. And **prompts and
results render as markdown** (`client/markdown.ts`) built with `createElement`/`textContent`,
**never `innerHTML`**: the content is arbitrary session text, so markup in a prompt must be text,
not structure, and a link with a non-`http(s)`/`mailto` scheme stays literal. The `user-turn` event
carries the **whole** prompt (same 20k cap and `anon()` pass as a turn's result) because a view can
shorten a prompt to a line but cannot recover what the parser dropped, so the banner shows a
derived one-liner (`promptLine()`) plus an **Input** button opening the original, offered when the
DATA was shortened, which is known outright, or when the LAYOUT ellipsized the line, which is
*measured* with a `ResizeObserver` (an inactive tab is `display:none`, where a one-shot measurement
would read zero).

### Startup

One command starts the watcher and the server and opens the browser at
`localhost:<port>` (suppressible with `--no-open`; the port is configurable with
`--port`). Download-and-run: no runtime to install first.

## Configuration and security

The config file and its schema, the precedence chain, the security model, the TLS certificate, the
browser auth flow, the Settings panel and `SEEDEEP_HOME` have a reference of their own:
[configuration.md](configuration.md).

## Running server records, and the console

A running server writes one record per process under `<seedeep home>/servers/<pid>.json`, and the
console verbs read it. Three rules make that safe:

- Liveness is never taken from the file. A record outlives a process that died without cleaning
  up, so a reader proves the process with `process.kill(pid, 0)` and treats the record as a claim
  rather than a fact.
- **One file per pid, never one shared file.** Two servers on one machine is a legitimate state (a
  checkout running beside an installed release) and a single shared file makes the second erase
  the first.
- The URL is rebuilt, never read back from the record. A record carries no token, so a verb
  that needs a reachable URL composes it from the configuration it has just read.

A detached start sends its output to `<seedeep home>/server.log`, created and kept `0600`: it holds
the startup banner, which in remote mode carries a token.

`--help` and `--version` win wherever they appear in the arguments, and an unknown argument is an
error rather than a silent default: a typo that starts a server on the wrong port is worse than one
that starts nothing.

The `/seedeep` command file is refreshed, never re-created. The file seedeep writes into Claude
Code's `commands/` directory ends with a marker naming the version and carrying a digest of the
body. On start seedeep rewrites it only while that digest still matches what it last wrote: a file
the user has edited becomes theirs and is left alone, and a file the user deleted is not put back,
deleting it is a choice.

Which verb does what, and what a user types to get it, is in [install.md](install.md).

## The update check

`update-check.ts` holds the only outbound request seedeep makes on its own, and the cache that keeps
it to one an hour.

The clock is the cache, not a timer. Nothing is scheduled: an answer older than an hour is
refetched by whoever asks next, so ten clients in that hour cost one request and a server nobody
talks to costs none. A timer would have to be created and cleared at shutdown, and would keep
fetching for a portal closed a week ago. A failed check has a cooldown of its own, 15 minutes,
shorter than the TTL, because a failure has no answer worth preserving.

Only `latest` is stored; the standing is derived at read time, so a cache written before an
upgrade cannot claim the new build is out of date.

The verbs a user TYPES pass `force`, skip the cache and ask npm, then leave the fresh answer in it
for the surfaces that only read, which is why four surfaces report the same version without four
requests. `GET /api/update` is the one endpoint all of them read ([api.md](api.md)).
