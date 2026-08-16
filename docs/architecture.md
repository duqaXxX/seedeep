# Architecture

seedeep makes the invisible inside a Claude Code session visible: in real time
during a turn, how the **context window** fills and what the **subagents** are
doing — assembled live from the local session logs.

The design principle is **read-only**: seedeep only reads the session files Claude
Code already writes. It never writes, proxies, or intercepts anything Claude Code owns.

The one write it does make is to a file it **owns**: an aggregate cache under
`~/.seedeep/`, a distillation of the corpus it read (see
[the aggregate cache](#the-aggregate-cache)). It touches no session file, so the
read-only-of-Anthropic-data invariant holds; the cache exists only to make the launch-time
retrospective and the personal baseline fast.

## Repository layout

**Every deliverable is an app under `apps/`, and none of them sits at the root** — so a
second one arrives as a peer of the first instead of as an appendage to it:

```
seedeep/
├── apps/
│   ├── server/          the watcher, the HTTP/SSE server and the browser client
│   │   ├── src/         three layers, one folder each: core/ server/ client/
│   │   ├── public/      the GUI's files, embedded in the binary; `lib/app.js` is BUILT
│   │   ├── tests/       the suite (`bun run test`)
│   │   ├── probe/       the schema probe — never shipped, runs out of `bun test`
│   │   ├── data/        checked-in reference data (known fields, context windows)
│   │   ├── npm/         the npm wrapper's own files: postinstall, placeholder, its README
│   │   └── scripts/     one-off maintenance scripts
│   └── tray/            the menu-bar client — see `docs/tray.md`
│       ├── ui/          the popover's HTML/CSS/TS, bundled by Bun
│       └── src-tauri/   the Rust shell: tray icon, window, notifications
├── docs/                this reference — it documents the PRODUCT, not one app
├── .github/
│   ├── workflows/       ci.yml on every push and PR; release.yml on a tag (`docs/tray.md`)
│   └── scripts/         checks CI runs — the sensitive-data scan, and its tests
└── package.json         one manifest, one version, scripts for every app
```

**`src/` is three layers and each one is a folder**, so the rule between them can be
stated about directories rather than recited as a list of filenames:

- **`core/`** — pure derivation: no `node:` builtin, nothing from `server/` or `client/`.
  It is the half of seedeep that does not care where it runs, which is why both other
  layers may import it and why it is the easiest part to test.
- **`server/`** — everything that touches the machine: the watcher, discovery, the tailer,
  the HTTP/SSE server, TLS and config, the schema guard's command-line entry points.
- **`client/`** — the browser bundle's own modules, the only ones allowed to touch the DOM.

The split is by what a module *is*, not by who happens to call it: `core/span-store.ts` is
reached only from the client today and stays in `core/` because it is pure, while
`config.ts` and `tls.ts` sit in `server/` because they open files and sockets. Two tests
hold the line (`apps/server/tests/layering.test.ts`), both walking the import graph rather
than the directory listing.

`docs/` stays at the root deliberately: `architecture.md`, `trace.md`,
`claude-code-upgrades.md`, `search.md` and `tray.md` describe the product, and a second
app would otherwise bury half the reference inside its own directory.

**The tray shares no code with the server** — it reaches it over HTTP only, through four
endpoints: `/api/digest`, `/api/stream`, `/api/config` and `/api/update` (`docs/tray.md`).
That is why it lives beside `apps/server/` rather than
inside it, and why a change to `core/` can never break it without changing an endpoint.

There is **one version for the whole repo**, so a tag ships every deliverable together
and two of them built from the same tag are compatible by construction — no
compatibility matrix. It is not a convention anybody has to remember: the root
`package.json` holds the only version number, and `apps/tray/src-tauri/tauri.conf.json`
names that file as its `version` instead of carrying one of its own. Pushing a `v*` tag
is what turns that number into downloads: the tray's three installers and the server's six
executables, out of the same workflow and the same commit — see
[Shipping the server](#shipping-the-server).

**CI runs on every pull request and on every push to `main`** — three jobs, `scan`,
`check` and `tray` (`.github/workflows/ci.yml`) — because a rule nothing enforces is a
rule that quietly stops being true; the type-checker was red on `main` while every local
test run stayed green. Between them they enforce:

- the suite and `tsc --noEmit`;
- **Biome** (`bun run lint`): format and lint check across all TypeScript sources. A PR
  that passes tests but has formatting violations is blocked here before review;
- a rebuild of `apps/server/public/lib/app.js`, which fails if the committed bundle no
  longer matches its source. That artifact is committed on purpose — a clone runs the GUI
  without a build step — and this is what keeps the two in step;
- the **layering** (`apps/server/tests/layering.test.ts`): nothing reachable from
  `apps/server/src/client/app.ts` may import a `node:` builtin, and nothing in `core/` may
  import one either — nor anything from `server/` or `client/`. Nothing else stops a
  client file from importing the watcher: `bun build --target browser` does not fail on a
  node builtin, it substitutes a polyfill that throws, so the mistake reaches the browser
  as a blank page. Both checks follow the import graph, so an indirect import three hops
  down fails too;
- the **tray's Rust suite** (`cargo test`, on a macOS and Windows matrix, after
  `bun run build:tray-ui`). `bun run test` does not reach it, so this job is the whole of
  CI's coverage for a change under `apps/tray/src-tauri/`;
- the **sensitive-data scan** (`.github/scripts/scan-sensitive-diff.sh`) over the added
  lines — real home paths, personal addresses, secret markers, private tracker
  references. It blocks rather than warns: this repo is public, and a leak committed once
  stays in the history forever. A fork inherits it, which is the whole point — a local
  git hook cannot be inherited, since `.git/` is not tracked.

Every command runs from the repo root (`bun run test`, `bun run start`,
`bun run build:client`, `bun run typecheck`); the scripts in `package.json` know where
each app lives. Use `bun run test` rather than a bare `bun test`: the runner skips
dot-directories when it scans for test files, so `bun test` alone never sees
`.github/scripts/`. The server has no dependency on the working directory: the GUI's files
reach it as imports (`assets.ts`), not as a path it resolves.

### Shipping the server

The server is a **standalone executable, one per platform**, with the Bun runtime inside it —
`bun run build:server:all` (`apps/server/scripts/build-binaries.ts`) writes all six into `dist/`,
cross-compiled from whichever machine runs it. Nothing has to be installed to run one, which is why
the GUI is embedded in the binary rather than served from a folder beside it.

**Every asset is named after the app it is** — `seedeep-server_<version>_<platform>` beside the
tray's `seedeep-tray_<version>_…`. A release page carries both, and two macOS files sharing a prefix
would say nothing about which one reads your sessions.

Three properties of the build are decisions, not detail:

- **The compile rebuilds the client bundle itself.** `assets.ts` embeds `public/lib/app.js` by path,
  so a compile that skipped the rebuild would ship a GUI from an older commit — and nothing
  downstream could tell.
- **Nothing is left external.** A dependency doing a COMPUTED `require` cannot be bundled, and Bun
  leaves it to runtime with the build machine's path frozen into it: a binary that works everywhere
  it was built and nowhere else.
- **A binary may not contain the path of the machine that built it.** `assertNoBuildPath` fails the
  build on any occurrence, because that is the one class of defect a test on the build machine
  cannot see.

The Linux binaries are dynamically linked against glibc, so a musl distribution (Alpine) is not a
target.

Every executable is started, run and driven through its whole lifecycle on a machine that did not
build it before anything publishes — how that is arranged is in
[`CONTRIBUTING.md`](../CONTRIBUTING.md#how-a-release-is-built).

#### The npm channel

The same six executables also ship as npm packages, which is what `npm i -g seedeep` installs.
**Node is needed to install them, never to run one**: the package carries the compiled binary, and
`bun run build:npm` (`apps/server/scripts/build-npm.ts`) only arranges files — it never compiles, so
`bun run build:server:all` has to have run first, and in that order, since the compiler wipes
`dist/`.

The shape is a wrapper package whose `bin` points at a file inside itself, plus one
`optionalDependency` per platform carrying the real executable. npm resolves those against each
package's `os`/`cpu`, so a machine downloads one binary rather than six, and the wrapper's
postinstall (`apps/server/npm/install.cjs`) puts that binary over the placeholder the `bin` field
already names. Nothing is fetched by the script itself, and no Node process survives the install —
`seedeep` on PATH *is* the server.

Four decisions hold it up:

- **The channel exists because of the quarantine flag.** macOS sets `com.apple.quarantine` in the
  program that downloads a file, not in the file; installed through npm the binary never acquires
  it, so the first-launch refusal a plain download has to explain never happens here.
- **The placeholder is named `seedeep.exe` on every platform and carries no shebang.** npm generates
  the Windows `.cmd` shim from that file *before* the postinstall replaces it, and `cmd-shim` only
  emits a direct exec of the target when it finds no shebang to honour — a `#!` line would make
  every Windows install hand a native executable to an interpreter.
- **An unsupported platform is refused by npm itself.** The wrapper declares the `os` and `cpu` it
  was built for, and npm reads them as a cross product: anything outside fails with `EBADPLATFORM`,
  naming both what was wanted and what the machine is. Every combination that cross product admits
  is a package that exists, which a test asserts; the postinstall still refuses a pair it finds no
  package for, because the two lists are independent and adding to one alone reopens the hole.
- **The wrapper pins its binaries to its own exact version.** One tag publishes both halves; a range
  would let npm pair a wrapper with an older executable.

The bare downloads stay on the release page, and are not a fallback: they are the channel for a
machine with no Node at all — a headless box reached over SSH — and requiring a runtime before
seedeep is the exact failure the distribution invariant exists to prevent. Which command installs
which, and the gesture each platform asks for, is in [`install.md`](install.md).

## Data source

Claude Code writes one JSON-lines file per session, appended once per **content
block** — not once per turn, and not once per API call either: one response
becomes several lines (`thinking`, then `text`, then each `tool_use`), all
sharing a `requestId`. Each line carries an ISO-timestamped `message.usage`
block with `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, and
`cache_read_input_tokens`; the usage is the CALL's, so it is repeated verbatim on
every line of that call (measured: identical on 53 of 53 multi-line requests) —
summing it per line would multiply the cost, which is what `newCall` guards
against.

A line is appended when its block CLOSES, so the console — which draws a block as
it streams — always leads the file. Measured on a live session (267 lines): the
gap between a line's own timestamp and the instant it becomes readable is p50
0.16s, p90 1.29s, p99 11.46s; the tail is `thinking`, whose whole streaming time
elapses before the line exists. For the blocks the live surfaces actually read it
is much tighter — `tool_use` is p50 0.23s / p90 0.29s. Tailing is therefore a
sub-second event stream for tool activity, and no faster than a block's own
duration for anything else.

Sessions live under one local root:

- **Claude Code (CLI):** `~/.claude/projects/<slug>/<sessionId>.jsonl` — or under `CLAUDE_CONFIG_DIR`
  when it is set, which moves Claude Code's whole directory and therefore the transcripts too
  (`claudeDir` in `roots.ts`). `<slug>` is the session's working directory with its separators
  turned into dashes: verified against all 16 project directories on this machine, each compared
  with the `cwd` its own transcript records.

Claude Chat and Cowork are deliberately NOT observed: the chat writes no
per-API-call log to disk (only editor drafts and UI state), and the current
Cowork runs the session remotely, leaving nothing local to read.
Subagents write their own separate files under a `subagents/` directory beside
the parent session. A **Workflow run** nests its own fleet one level deeper —
`subagents/workflows/wf_<runId>/`, same file names, plus a `journal.jsonl` recording each
of its subagents starting and returning. A run is shown as ONE aggregate row (a real
`deep-research` run spawns ~100 subagents), never expanded.

## The core engine

The core is an in-process, runtime-agnostic TypeScript library (standard
`node:*` and Web APIs only — no runtime lock-in). It is organized as a layered
pipeline where each unit has a single responsibility and a defined interface:

```
discovery ──▶ watcher ──▶ (EventEmitter: normalized events, tagged by sessionId)
   │            │  ▲                │
   │            │  └── parser       └──▶ core/     (pure: events → meaning)
   │            │      (pure: raw line → events)         session-tree, span-store,
   │            └───── tailer                            verdict, selectors, feed, …
   │                   (incremental byte-delta reader)
   └── roots    (root paths, exclusions, active-window)
```

The pipeline has two pure halves and the split matters: **the left half turns bytes
into events, the right half turns events into meaning.** Both are runtime-agnostic,
and neither knows who is asking. `apps/server/src/core/` holds the second half — the reducer and
everything derived from its snapshot — so it can run wherever the events arrive: in
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
  subject: string | null;    // first real prompt, anonymized — the readable picker/tab label
  entrypoint: string | null; // 'cli' (interactive) vs 'sdk-cli'/'sdk-py' (headless)
  root: 'cli';
  path: string;
}
```

Files under `subagents/` and bookkeeping files are excluded from the top-level
session list.

**One definition of "live".** `isLive(record)` (in `types.ts`, beside the record) answers it
for every consumer: `isOpen ?? isActive` — the running process decides, and the mtime window
only gets a vote when there is no process signal to read (`isOpen: null`, i.e.
`~/.claude/sessions/` does not exist; it is an undocumented Claude Code internal that a
release may drop). The watcher tails a session while it is live, and the picker files it
under **Live**, from that same call — split in two, they disagree exactly where it hurts: a
session waiting on a **background subagent** writes nothing to its own jsonl, so `isActive`
lapses while the process is alive and the child files are still growing. The watcher used to
gate on `isActive` alone and dropped such a session — children included — until the main
agent spoke again, freezing the live feed for the whole subagent run (measured on real logs:
21% of the sessions with subagents, up to 33 minutes). The other side of the same rule: a
session whose process has exited is NOT live, however recently its file was written.

**One definition of "working", and it is not `status === 'busy'`.** `isWorking(record)` (beside
`isLive`, same reason) reads `busy` OR **`shell`** — Claude Code's own word for a turn that is over
while a command it launched in the background is still running. Measured by sampling the process
file every 2 s across a 240-second command: `busy`, `shell` for the whole run, `busy` again when the
notification landed. The status chain used to drop anything unrecognised to `null`, and a session
with no status makes no claim, so such a session read as idle on every surface and jumped back to
working when the command ended. The value is now carried raw and interpreted at the edges — the
browser's tab badge, the tray's band, and the tray's Rust icon, each pinned to this function by a
test. Everything still unknown keeps becoming `null`: the vocabulary is Claude Code's, and it has
already grown once.

**One reading of `isOpen` is not proof it closed.** Claude Code REWRITES the PID file on every
status change, and `listOpenSessions` skips a file it catches mid-rewrite — so a running
session can be missing from exactly one poll. Anything COSTLY must therefore wait for a
second reading: `known` in `sessions.ts` is never pruned on a blink, and ending a tab (it
freezes the graph into its ended presentation) goes through
`end-guard.ts`, which re-reads the roster a full poll later and commits only if it still
agrees. Counting notifications cannot do this job — `onChange` fires on identity CHANGE, so a
session that really closed notifies once and then never again; the confirmation reads
`roster.current()`, which every poll refreshes whether or not it notified.

What makes it a SECOND reading is `roster.readings()`, not the wait. A poll whose fetch failed
keeps the last good rows on purpose, so `current()` can serve back the very snapshot that
opened the window — one blink of the PID file plus one failed poll and a healthy session would
be ended on a single reading. The guard therefore requires that counter to have MOVED, and
when it has not it re-arms instead of giving up: dropping the question would leave a session
that really ended live for the life of the page, since `gone` is driven by an identity change
that has already happened.

Ending a tab is **reversible**, and has to be: `claude --resume` continues the SAME session id,
so a resumed session can never be handed a new tab — nothing auto-opens it
(`sessionsToAutoOpen` excludes both `known` and the ids on screen) and picking it from the
dropdown only switches to it. So the poll that reports it live again calls `revive` (`app.ts`),
which undoes the freeze and asks the replay endpoint for the tail the tab missed. What makes
that possible is that the tab's READER outlives the session: `end` no longer stops it —
`stop()` means the tab is gone — and a tab subscribes to the live stream even when it opens
onto a session that is already dead, since a subscription cannot be added later without a
second reader double-counting the file. Reversibility does not soften the confirmation above:
the repair arrives seconds late, drops the live chrome in between, and spends a request on a
tail the tab never lost.

**A session blocked on the user.** Claude Code writes `status: "waiting"` into the PID
file the moment it raises a dialog, with a `waitingFor` label saying which one, and
clears it when the dialog is answered — so the state is self-healing and needs no
event. seedeep keeps the label raw here and decides with `pendingInput`
(`core/types.ts`, shared by the browser, the digest and the notification watcher so they
cannot disagree) which ones mean *the agent is stopped on you*:
`"permission prompt"` (a tool or plan approval) and `"input needed"`
(AskUserQuestion, MCP elicitation). Everything else — `"dialog open"` (a picker the
user opened), `"sandbox request"`, `"worker request"`, or an unknown label from a
newer release — is deliberately NOT claimed as a pending approval. Nothing about a
pending prompt reaches the transcript, which is why this is read from the PID file
and not from an event; the contract claim that guards it is C24 (`claude-code-upgrades.md`).

Each record also carries a **readable subject** — the session's first task-bearing
prompt (typed, a non-control slash command, or a headless SDK prompt), skipping
session-control commands like `/clear` and `/effort`. The head scan reads the first
64KB in one shot and only reads further (up to 1MB) when an anchor is still missing,
so a session whose head is one huge line still gets labelled. The picker is a custom
combobox (glass popover, searchable) split into **Human / Automated** tabs — at real
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
just yields no events). It uses an explicit whitelist — six line types produce
events (`assistant`, `user`, `system`, `attachment`, `queue-operation` and
`file-history-delta`); every other line type is ignored.

The parser is also the single **anonymization barrier**: every session-derived
string it puts on an event (a tool's argument, a subagent's launch prompt, the
verbatim output a subagent returned) passes through `anon()`, which strips real
home paths (`/Users|/home/<name>` → `~`, and the slug-encoded `-Users-<name>`
form), the scratchpad root (`/private/tmp/claude-<uid>` → `~scratch`), uuids
(→ `<id>`), and control characters, then caps the length. Because anonymization
happens at the source, nothing downstream — the reducer, the SSE frames, a
screenshot — can leak the host or user.

**One exemption, and only one**: the uuid inside a published artifact's URL
(`https://claude.ai/code/artifact/<uuid>`) is kept. The rule exists for session and
agent ids; an artifact id falls under it only by having the same shape, and masked
it turned the address of a page seedeep had just watched being published into a link
that goes nowhere and cannot even be copied by hand. The same uuid one character
outside that path is still masked. Nothing `anon()` touches is ever committed, so
this changes nothing about the repository; the exposure it does carry is a live demo
or screen-share of a real session, and public screenshots are covered by their own
rule — they are taken on a synthetic session, which has published nothing.

### watcher

The only stateful unit. It runs a short poll loop, keeps a tailer per active
session (and per subagent child file), routes new lines through the parser, and
emits typed events via an `EventEmitter`, each tagged with its `sessionId`. It
tracks per-session context fill so consumers can render "how full is it now"
without re-deriving it.

#### How it finds the live set without scanning the corpus

The gate is `isLive` — `isOpen ?? isActive` — and it has not changed. What changed is
how the set is REACHED. A tick used to run the complete discovery and filter afterwards,
so a machine with a thousand cold sessions paid a full scan 3.3 times a second whether or
not anything was running: measured, **13.6% of one core, permanently**, for a window in
which the watcher emitted nothing at all.

Since `isLive()` is `isOpen ?? isActive`, whenever the open-session mechanism answers at all
the live set is EXACTLY the sessions holding a live process file — `isActive` is unreachable
and the mtime window decides nothing. So a tick reads `~/.claude/sessions/` (one small file
per running process) and looks each id up in a `sessionId → path` index. A full discovery
still runs, but only to PLACE an id never seen before, which is what a new session is.

Two states would otherwise bring the old cost straight back, and both are handled:

- **An open window nobody has typed into.** Claude Code writes the process file when the
  window opens but the transcript only when the conversation does, so the id is on no disk
  any scan can reach — and this is precisely the idle case. A failed placement is remembered
  and not retried for `RESCAN_MS` (1 s), which caps that state at one scan per second and
  delays a brand-new session's first line by at most the same (against 300 ms before).
- **No mechanism at all.** `~/.claude/sessions/` is an undocumented Claude Code internal a
  release may drop; `listOpenSessions` returns `null` rather than `[]` for exactly this. Then
  the mtime window is the only answer there is and the watcher degrades to a full scan per
  tick — what it did before, not blindness.

Measured after: **0.38%** of one core with 911 sessions on disk and nothing running.

### What a subagent's state SAYS vs what the reducer SAW

The reducer reports what it saw: `running` means "launched, and no terminal signal has
arrived". Turning that into what a surface shows is `displayState`
(`apps/server/src/core/graph-derive.ts`), and it overrides `running` in three cases:

| Case | Reads | Why |
|---|---|---|
| The session has ENDED | `unknown` | The signal is never coming. Only the view knows the session is closed |
| A Workflow run silent past `WF_SILENT_MS` (5 min) | `unknown` | A killed run gets no terminal signal anywhere, so silence is the only evidence left |
| A subagent with no trace of itself (`!hasStarted`) | `unknown` | Nothing on record says an agent is at work |

A background COMMAND has the same problem and cannot be answered the same way — see
[Is a background command still alive?](#is-a-background-command-still-alive) below.

`hasStarted(a)` is true when the agent has **any one** sign: an `agentType` from its sidecar,
tokens billed to it, a tool it ran, or text it returned. Measured 2026-07-29 by replaying 910
ended sessions through the reducer, 3 of 1327 subagents (0.2%) reach the end still `running` —
and all three have none of the four, while 92.8% of the ones that do end carry their own final
text. They are launches with nothing behind them, not agents whose ending was lost.

**It is a fact, not a timeout.** Nothing in it measures duration: a legitimate `Explore` can run
for minutes and a threshold would delete true state to hide missing state. It does not claim the
agent finished — it declines to claim it ever started. Like the workflow rule it is DERIVED and
never latched: one line from the agent and it is `running` again, so a false unknown heals
itself. Measured over 1171 real spawns, a subagent's first trace lands 0.07 s after its launch
(p90 0.08 s, max 0.30 s), so with a 300 ms watcher tick nothing real sits traceless for more than
about half a second.

**Counting and showing are different questions**, and `hasStarted` answers only the first. The
Graph LISTS the launch with an `unknown` badge — seedeep sees a line in the transcript and must
not hide it, and a launch that never started is an anomaly worth noticing — while `/api/digest`,
whose `subagents.running` a status row prints as a number, does not count it. The Graph's own
active count uses `displayState` too, so the two never disagree about how many are working; only
the list differs, which is the point. A Workflow row is exempt from `hasStarted`: its node
carries no type or tools by construction, and the silence threshold judges it instead.

### Is a background command still alive?

A background command's only ending is its `<task-notification>`, and **some launches never get
one**: 23 of 198 in the local corpus (11.6%), across 11 sessions. `background && !outcome` then
reads "still running" for as long as the session stays open — seen live as two rows counting past
40 minutes with nothing of either alive on the machine. A subagent's `unknown` cannot be borrowed
here: it is reached by the view knowing the session has CLOSED, and this is a session still open.

So seedeep asks the machine. `apps/server/src/server/command-liveness.ts` runs on its own 15 s
clock (never the watcher's 300 ms tick — it spends a subprocess), for the commands of sessions a
tree is already held for, and it asks ONE question: **does any process still hold this command's
output file open?**

**A `Monitor` is never asked.** Its output file is named the same way, so the probe *would* answer
— with the wrong answer. Measured 2026-08-10 on a monitor that was demonstrably alive (its `sleep`
in the process table, its output file already written): **nothing held the file open**. A
background shell command keeps it open through the whole chain (the harness's `zsh`, the command's
shell, the leaf) and that is what this mechanism was measured on; a monitor's stream does not.
Asking anyway reported a working monitor as gone two probes after its first event. What ends a
monitor instead is its `TaskStop` — see the `agent-end` row in the event table.

- The file is found from the launch's task id, not from the path the transcript prints:
  `anon()` masks the session uuid inside that path before it can reach an event, so the parsed
  value cannot open anything. Two `readdir`s under `/tmp/claude-<uid>` and the id names the file.
- Measured 2026-08-08 on real launches: the whole chain holds it (the harness's `zsh` wrapper, the
  command's own shell, the leaf), `claude` itself does not, and a command that ends or is killed
  releases it while the file stays on disk. One `lsof -F pn` answers every command at once in
  33–35 ms with 691 processes on the box.
- Two other sources were **measured and refuted** first: Claude Code keeps no registry of its
  background shells on disk (the task id appears nowhere in `~/.claude` outside the transcript),
  and the output file's mtime or size says nothing — four healthy `until … sleep 20` waiters had
  written 0 bytes after tens of minutes ALIVE. Matching `ps` on the command TEXT fails too: the
  harness re-quotes what it runs, so the string seedeep holds is not the string `ps` prints.

**The verdict is `unknown` and can never be anything else.** The probe learns that something
stopped, never what it stopped WITH, so it emits a `command-vanished` event — out of band,
`seq: -1`, applied like `subagent-meta` — and the reducer refuses it outright if the command has
an `outcome`: Claude Code's own word is the authority and can still arrive afterwards. The row's
duration becomes the last instant it was SEEN, printed as a bound (`≥ 4m 20s`), never as a
measurement.

**It fails towards saying nothing.** Two consecutive empty probes before a row tips; no verdict at
all when the file cannot be found, has been deleted (the scratch root lives under `/tmp`, which
the OS cleans), or when `lsof` is absent or times out. A missing prober leaves every row exactly
as it is today. LIMIT: `lsof` only — a Linux box without it gets no verdict rather than a
`/proc/<pid>/fd` sweep, which is thousands of `readlink`s per probe where this is one process, and
Windows is out of scope.

## Normalized event model

The parser flattens the raw log into a small set of events consumers care about:

| Event             | Source field(s)                                              | Meaning                          |
|-------------------|-------------------------------------------------------------|----------------------------------|
| `usage`           | `message.usage` + `message.model` + root `effort`           | context fill + per-call delta, and the model/effort THAT CALL ran on; for a line flagged `isApiErrorMessage` also `apiError` (status + the message shown to the user) — the call FAILED |
| `attribution`     | `attributionSkill` / `attributionMcpServer` / `attributionMcpTool` | what is filling the context (skill turns are counted from this) |
| `compaction`      | `compactMetadata` / `isCompactSummary`                     | a compaction (context deflate)   |
| `user-turn`       | a user line that is `origin.kind: 'human'`, **or** carries `<command-name>`, **or** is the plain text of a command (see below) | the user sent something — opens a timeline entry; `prompt` is the text (a command's `<command-args>`, or its arguments), `command` the slash command that carried it, `promptId` the invocation the line belongs to |
| `command`         | the same three shapes as `user-turn`                       | a slash command was used         |
| `turn-narration`  | an assistant `text` block on a line whose `stop_reason` is anything but `end_turn`; main session only | mid-turn narration — the model saying what it is about to do: `text` (anonymized, capped at 2000) and `callId` (`message.id`), which is also the call whose tools form the Trace's round. A subagent's narration has no consumer and is dropped |
| `turn-result`     | an assistant `text` block on a line whose `stop_reason` is `end_turn` | the turn's final answer — `outputFull` (anonymized, capped at 20k) and `outLen`. The same shape on a CHILD line becomes `subagent-output` instead |
| `turn-interrupted` | `interruptedMessageId` on the next user line after an Esc | the previous turn was interrupted. Emitted BEFORE that line's `user-turn`, so the reducer closes the old turn before opening the new one |
| `turn-end`        | a `system` line with `subtype: 'turn_duration'`; main session only | the turn finished — `durationMs` and `messageCount`, both nullable. Claude Code's own measure, not one seedeep derives |
| `agent-launch`    | `<forked-skill-launch>` on a `system`/`local_command` line  | a forked skill (`/code-review`) started a background agent — `launchedAgentId`, `skillName`, `description`. It is NOT a `tool_use`: this line is the only record that the agent exists, when it started and which turn asked for it |
| `file-change`     | a `file-history-delta` line (`trackingPath`)               | Claude Code backed up one file it changed — its own /rewind ledger. It records ONLY what CC's own file-writing tools wrote: measured on a real 16-file commit, 8 of them came from `python3`/`cat >>`/the build and produced no delta at all, and WHICH session made a shell write is recorded nowhere on disk. So the Changed files card does not count this event — its number comes from the session's own commits via `GET /api/files` (`docs/changed-files.md`), reproducible with `git show --stat`. The ledger's one remaining job is the session scratchpad, which lives outside the repo where git cannot see it: `isScratchPath` (`apps/server/src/core/text.ts`) classifies on the `~scratch` token `anon` produces, so a path is anonymized BEFORE it is tested. `trackingPath` has TWO shapes — measured 2026-08-03, 609 of 1765 absolute and 1156 relative to the cwd, `backup.realParentDir` present on 1192 — and `ledgerPath` resolves both. The reducer still attributes each delta to the open turn; the baseline `file-history-snapshot` stays ignored |
| `tool-start`      | a `tool_use` content block                                 | a tool call began — id, name, anonymized `arg`; for an `Agent`/`Task` block also the `launchPrompt` + `subagentType` + the launch `description` (which heads the subagent's row — see the GUI shell); for a Task-family block a `taskRef` instead of an `arg` (see below) |
| `tool-end`        | a `tool_result` content block                              | a tool call finished — `toolUseId`, `outputSize` (rendered char length); `error: true` when the result is a real FAILURE (a user refusal carries the same `is_error` flag but is NOT a failure — classified by `toolOutcome` in `apps/server/src/server/failure.ts`); for a foreground `Agent` result the inline `returned` payload; for a background one `launched` (a receipt: the subagent STARTED), for a `Workflow` also `workflow` (runId + name), and for a `TaskCreate` result `taskCreated` (the todo number it was given + its subject). A launch into the BACKGROUND carries `background` (taskId + who put it there), and it has two receipt shapes: a `Bash`'s `backgroundTaskId`, and a `Monitor`'s `taskId` **with** `timeoutMs` — the same kind of launch under a different field name. The second half of that gate is not decoration: a `TaskUpdate` receipt carries a todo's `taskId` (218 locally) and a `Workflow`'s carries a run's, and `taskId` alone would list both as running commands |
| `agent-end`       | a `queue-operation` line whose content is a `<task-notification>`, OR a `TaskStop` receipt (`Successfully stopped task: <id>`) | a background subagent really finished — `toolUseId` (the spawn, **nullable**), `taskId` (`<task-id>`, the child's agentId), `status` (completed/failed/killed/stopped). Fires on every stop, so a resumed agent produces several: last wins, never latched — **except the instant a background COMMAND ended, which is first-wins**. Claude Code writes each notification twice (`enqueue`, then `remove` when its queue drains) with an identical payload but not at the same time, so last-wins was dating the end to the DRAIN: measured 2026-08-09, 281 of 611 notifications repeat, first-to-last p50 3.9 s / p90 30.9 s / max 76 min, and a `sleep 3` was shown as having run 22.6 s. The status and the sentence stay last-wins, where a repeat really is inert. **The event is gated on `toolUseId` OR `status`**, never on the spawn name alone — requiring it dropped the only signal a subagent with no spawn ever gets. What makes a notification TERMINAL is the `status`: the same line type is written for progress (`event` + `summary`, no status — 54 in the local corpus, re-measured 2026-08-08), and that ends nothing. The reducer enforces it where the difference is destructive: a background COMMAND is closed only by a notification carrying a status, since applying a progress summary as its outcome would mark it `done` minutes early and measure its duration to the wrong instant. All 54 progress notifications carry a `<task-id>` and NONE a `<tool-use-id>`, so none can reach a command through this event at all — they are reported as `background-event` instead, which counts them against the task and ends nothing. The subject is an AGENT, and the line names it TWICE — requiring the spawn name dropped the only signal a subagent with no spawn ever gets, and a skill forked into the background has none by construction (its `meta.json` carries no `toolUseId`). **`toolUseId` is not always a spawn either**: after a `SendMessage` resume Claude Code keys the notification on the resume call (26 of 655 real notifications). So the reducer routes by `toolUseId`, then `taskId → spawn`, then — naming no spawn we hold — records the end against the agentId itself. The line is also written for things that are not subagents (a background `Bash`/`Monitor` task, a `Workflow` run, a nested spawn): those name no agent, so nothing ever looks them up. `<task-id>` carries a type prefix, exact on 862 real terminal notifications — `a…` an agent (751, all naming a child file), `b…` a background shell task (109), `w…` a workflow run (2). **A `TaskStop` receipt is the other source of this event**, and the only end a stopped `Monitor` ever gets: Claude Code writes no notification for it (0 of the 49 lines naming two stopped monitors carries a `<status>`) and the liveness probe cannot answer for a monitor either, so without this the row would call itself running for the rest of the session. It names the TASK and not the call, so the reducer resolves it through `bgByTaskId`; its status is `stopped`, Claude Code's own word, which every surface already reads as a clean end |
| `background-event` | a `queue-operation` line whose `<task-notification>` carries an `<event>` and NO `<status>` | a still-running background task reported something — today only a `Monitor`, whose stream is its whole output. `taskId` (the launch receipt's own id, the only link it carries — there is no `<tool-use-id>`), `event` (anonymized: a watched log line can hold anything). **Only the `enqueue` copy** is emitted: Claude Code writes the identical payload again as `remove` when the queue drains (42 enqueue / 6 remove locally, every remove repeating an enqueue), and counting the line would double every event that happened to be drained. The reducer counts these per task id and keeps the latest — the row shows a count and one line, and none of them reach the activity feed: one measured session forwarded 74, which a 13-row ring cannot hold alongside anything else |
| `note` | an `attachment` line whose `hook_additional_context` comes from a TOOL hook (`hookEvent` `PreToolUse`/`PostToolUse`), OR a `<task-notification>` carrying nothing but a `<summary>` | something attached TEXT to the session that seedeep would never have derived — a hook warning about the file just written, a background review reporting findings. `toolUseId` (null when it is about the session and not a call), `hook`, `source` (the writer, when the text declares it as `[from <plugin> plugin]`), `text` (anonymized). **`attachment` is otherwise dropped wholesale** — nearly all of them are the bookkeeping every tool produces, twice per call. The gate is the hook's EVENT, and NOT the presence of `toolUseID`: every one of the 555 SessionStart injections carries `toolUseID: "SessionStart"`, a non-empty string that anchors nothing, so an id-only gate emitted all of them as notes about a call that does not exist. Measured 2026-08-10 over 533 sessions, the field takes exactly two shapes — `PostToolUse` with a real `toolu_…` (73), and `SessionStart` with that literal (555). The `content` is an array of BARE STRINGS, not of `{type:'text'}` blocks, which is why `renderedText` returns nothing for it. Measured 2026-08-10 over 533 sessions: 73 anchored notes in 39 of them, 2 unanchored. An UNANCHORED note also carries WHEN it arrived and in which turn: the complete-history list (`Expand all`) folds it in among the calls in time order, being the only surface with no cap, and one appended at the end would sit beside work it has nothing to do with. It is not a span, and the Trace never draws one — `SpanType` carries a `note` member that only that list ever produces. Deliberately not modelled as "a security finding": a type keyed on one plugin goes blind the day another one speaks |
| `wakeup` | a `ScheduleWakeup` receipt (`toolUseResult.scheduledFor`) | the session arranged to wake itself up (a self-paced `/loop`): `toolUseId`, `at` (epoch ms, null when the receipt STOPPED the loop — `scheduledFor: 0` with `stopped: true`). NOT a background task: nothing runs, nothing holds a file open, there is nothing for the liveness probe to ask about. Last-wins in the reducer, because a dynamic loop re-arms every turn and only the newest instant is what the session is waiting for. **The firing is invisible** — a wakeup that goes off produces no line of its own, no `origin` and no `promptSource` that tells it from any other system prompt — so every surface shows this while the instant is ahead and stops showing it after, and none of them ever says it fired. 18 receipts locally (14 arm, 4 stop) |
| `command-vanished` | NO LINE — the server's liveness probe                     | nothing holds a background command's output file open any more, so its process is gone: `toolUseId`, `lastSeenAlive`. The only event with no source in the transcript, because the fact is not in it — see [Is a background command still alive?](#is-a-background-command-still-alive). It says a command STOPPED and never what it stopped with, so the reducer turns it into `unknown`, refuses it outright when an `outcome` is already there, and applies it idempotently (`seq: -1`, out of band, like `subagent-meta`) |
| `workflow-agent`  | a run's `subagents/workflows/wf_<runId>/` dir + its `journal.jsonl` | one subagent of a Workflow run — `runId`, `phase` (`seen`/`started`/`result`). `started` minus `result` is the only record of how many are still working |
| `subagent-meta`   | `agent-*.meta.json` sidecar + the child's model            | agentId → toolUseId link, type, model, and the sidecar's `description` — what the agent was launched to do, which for a forked skill is the ONLY name it has |
| `subagent-output` | a child assistant line with `stop_reason: "end_turn"`     | the verbatim text a subagent returned to the main session (its final answer) |

### The Task family takes references, not arguments

`TaskUpdate`, `TaskGet`, `TaskOutput` and `TaskStop` do not name what they act on: they point
at it — and at **two different task systems**, which the id field names apart: the task list
spells it `taskId` and numbers rows sequentially (`{taskId: "1", status}`), while background
tasks spell it `task_id` and carry a hex that **is a subagent's agentId**. Reading the wrong
field yields no label at all. So the parser emits a **`taskRef`** (`id` + `kind`:
`todo` or `agent`) rather than an `arg`, and the **reducer** — the only layer holding the
cross-event state — resolves it into a label:

- `todo` → the subject from the `TaskCreate` result that named that number (`#1 Fix the parser
  → in_progress`). The number exists ONLY in the result; the input has no id.
- `agent` → the subagent's type, via the same `agentId → spawn` map `SendMessage` uses
  (`docs-researcher`). Unresolved, it degrades to a short id — never a raw hex.

Both the snapshot and the live feed read that one resolved label (`EventContext.label`), so a
call can never read one way in the feed and another in the drawer. `TaskCreate` is labelled by
its `subject` directly, and `TaskList` — whose input is `{}` on every real call — keeps no
argument at all rather than being given an invented one.

Every event also carries an optional **`agentId`**: `null` for the main session,
the subagent id for events read from a `subagents/agent-*.jsonl` child file. Every reducer
must branch on `agentId` before touching main-session figures; a child's `usage`
applied to the main fill is the exact bug that shipped once.

**A subagent is born at its SPAWN, not at its child file.** The list of subagents is keyed
by the spawning `Agent` tool_use id and created the moment that block is seen; the child file
only enriches it (model, usage, output, real duration) and may arrive late or never. Keying
the list on the child instead — the earlier design — made a whole class of launches
invisible: a `Workflow` run's subagents have no spawn of their own in this session's log, and
were never listed at all.

**A launch receipt is not a completion.** A `tool_result` for an `Agent` block means "this
subagent finished" only when the spawn was *foreground*. Since CC v2.1.198 subagents run in
the background by default (measured: 92% of launches on v2.1.208), and a background result
carries `status: "async_launched"` and lands ~0.07s after the spawn — it is a receipt saying
the work *started*. Reading it as completion made every background subagent be born `done`,
so the live monitor never showed one. The real end arrives later, on its own line type
(`queue-operation` → `agent-end`). The parser flags the receipt (`launched`), and only a
foreground result ends a subagent.

**Subagent returned output — the child jsonl is authoritative.** A subagent's
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

**The denominator follows the calls, not the session head.** The window comes from
`main.model`, which is the model of the LATEST main-session `usage` — never a value read
once when the tab opened. Two real failures forced this, and both were invisible:

- a session opened right after `/clear` has written no assistant line yet, so discovery can
  only report `model: null` and the window falls back to 200k + `estimated`. Seeding it once
  froze that fallback until the page was reloaded;
- `/model` mid-session moves the real window (opus-4-8 is 1M, sonnet-4-6 is 200k), so the
  same 188k reads as 19% full or 94% full depending on which model is believed. Measured: 1
  real session in 1197 does switch.

`main.model` is therefore the model in force NOW, and `main.models` every model the session
has run on in first-seen order — a surface that shows only the last hides that anything
changed, and one that shows only the first is the bug itself. Each `TurnNode` carries the
same pair scoped to its own calls (`models`, `efforts`), which is what lets a scoped widget
name the model that turn actually ran on. `efforts` is empty on ~98% of real turns: Claude
Code only writes `effort` when one is configured, so the absence is the normal case and no
surface may render a placeholder for it.

**Two numbers, two questions — do not conflate them.** A `usage` line is the whole
prompt of ONE API call, so the reducer keeps its tokens in two shapes:

- `main.breakdown` / `turn.breakdown` — the **last call**, absolute. It answers
  "what is the window made of right now", so it (and only it) drives the Context bar.
- `main.cacheTotals` + `main.inputTotal` + `main.outputTotal` (and the per-turn
  equivalents) — **summed over every call in the scope**. They answer "how many tokens
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
because they and the Subagents row measure different things — a category versus an actor — that
both add to the hero; unlabelled they read as one four-item list and the hero stops looking like
their sum. The card's hero is the whole-session **total** = the four categories summed, plus a
separate **Subagents** row. That row is the sum of each subagent's cumulative **volume** —
Σ its own per-call `input+output+cache`, read from the child jsonl the watcher tails and
folded once per `callId` exactly like the main sums. It is kept a separate row rather than
folded into the four categories because a subagent's tokens are billed under its OWN context
window, not the main one. This is the same metric on both sides, so the two are comparable —
which they were not while the row showed only each subagent's *last* call (it undercounted a
multi-call subagent by up to ~20x). A **background** subagent writes no child jsonl, so its
per-call usage is unavailable: its volume falls back to the parent-reported `totalTokens`
(≈ its final context, not a true sum) and is flagged **estimated** — the Subagents row shows a
leading `~` when the total blends any such approximation. The per-subagent card mirrors the
split: a **VOLUME** line (cumulative, no window frame — a volume can exceed the window) and a
**CONTEXT** bar (the subagent's final `fill` over its window), with the four categories in the
drawer — drawn there as ONE stacked bar, because their meaning is the ratio between them, not
four separate figures. It is a VOLUME view, not a cost one — the categories are additive tokens, deliberately
not price-weighted (cost is ccusage's lane, not seedeep's). Re-read (`cache_read`) dominates
every real session — the same window handed back on every call, ~95% of a subagent's volume —
which is exactly the invisible churn seedeep exists to show.

The Subagents row opens into a **by-model** bar: the row's total split by which model burned it,
one segment per model **family** (`opus`/`sonnet`/`haiku`/`fable`), biggest share first. It is
subagent tokens ONLY — the main thread never enters it, the two staying apart by the reducer's
`owner` — so the bar splits the figure directly above it, never the hero; it is absent when no
subagent ran, because the row it explains is absent then too. The split is charged per CALL, not
per agent: `subagent-meta` names one model per agent, but ~2% of real subagent transcripts run
on more than one family, and charging the whole volume to the declared model misattributes ~1% of
subagent tokens overall (7% inside one real 130-subagent session). An estimated volume, having no
per-call detail, lands wholly on the agent's own model — the split always totals the row.

Summing per SCOPE, not per last call, is load-bearing: within a single call `cache_read`
is the entire conversation prefix while `cache_creation` is only the newest increment,
and a turn's LAST call is its cheapest (the final answer adds almost nothing), so a
last-call reading understates a turn that re-created hundreds of thousands of tokens.
**A line is not an API call.** Claude Code writes ONE LINE PER CONTENT BLOCK — thinking,
each `tool_use`, text — and every one of those lines repeats the SAME `usage` block
(measured: 192 assistant lines carrying 110 distinct `message.id`s, one id spanning 4
lines). Anything summed over calls therefore folds once per `message.id` (carried on the
event as `callId`, with the `seq` as fallback for `<synthetic>` lines that have no id):
`cacheTotals`, `inputTotal`, `outputTotal`, and `apiCalls`. Summing per LINE inflates
them ~2x. The same guard also absorbs the stream's high-water re-send after a reconnect
(`stream.ts` guards with `seq <`), which a SUM — unlike everything set-shaped in the
reducer — would otherwise double-count.

Every file-tailed event also carries a **`seq`**: a per-file line number assigned
by whoever reads the lines (the watcher for the live tail, the replay reader for
history). It is a POSITION, not a counter, so it rises with the tail and restarts
with it: when a file shrinks, the tailer re-reads from offset 0 and the watcher
resets the number in the same step — a re-delivery from 0, which the guards below
already handle. (No Claude Code path produces that: compaction, `--resume` and
`/rewind` all append, the last forking the DAG by appending a branch. The reset
keeps the two ends of one fact together, and covers an edit from outside.)
One `seq` per source line — a line yielding several events
(e.g. `usage` + `attribution` + `tool-start`) shares one `seq`. Out-of-band events
carry `seq < 0` (a `subagent-meta` read from `meta.json` has no line position),
and the reducer folds those idempotently.

That numbering is what makes a live stream and a replay safe to overlap. The marks
a client keeps, and the exact test each one applies, are the wire contract:
[api.md](api.md#deduplicating-live-against-replay).

## Consumers

The core makes no assumptions about transport or rendering. A consumer imports
the watcher, subscribes to its events, and renders them — a terminal UI, or a
locally-served web GUI. Keeping the transport out of the core is what lets the
same event feed drive every front-end.

Consumers fold the event stream with the **session-tree reducer**
(`apps/server/src/core/session-tree.ts`) — the browser over a live stream, the corpus scanner
over one file at a time: it maintains the main fill + token breakdown,
each subagent (fill, model, state, launch prompt, returned output, tool calls,
real duration), main and per-subagent tool nodes (name, duration, argument,
output size), compaction nodes, and per-skill turn/invocation counts, and hands
callers an immutable `snapshot()`. It exposes `onChange(cb)` (a bare "something
changed" signal, for rendering) **and** `onEvent(cb, ctx)` (each applied event, for
per-event UI like toasts and the activity feed). `onChange` carries **no payload**: a
listener pulls `snapshot()` itself, when it is actually about to paint. Building one
per event made folding a session O(n²) — `snapshot()` is O(turns + tools + agents) —
and the view, which coalesces its paints, threw every one of them away. `ctx.turnIndex`
is the turn the event belongs to: the reducer is
the only layer that knows it (events carry no turn), and for a subagent's event it is
the turn that *spawned* the subagent, so an async subagent outliving its turn still
counts against the turn that asked for it.

**The timeline holds everything the user sent, and each entry is classified by what it
COST — never by its name.** A typed prompt and a slash command are indistinguishable in
intent (`/paste-image fix this` is a prompt with a helper attached) but not in the log: a
slash command carries no `origin`. Gating turns on `origin.kind: 'human'` therefore dropped
every one of them — a `/paste-image` round produced no turn at all, so nothing was ever live
while Claude worked, and its `turn_duration` landed on the previous turn. The parser now
reports what was sent and leaves the classification to the reducer, which decides from the
token count (`TurnKind`):
- **`work`** — it consumed tokens: typed prompts, and commands that run the model.
- **`local`** — a command that closed without burning a single token, without an Esc, and
  without launching an agent (`/model`, `/effort`). Cost through an agent is cost: a forked
  skill such as `/code-review` makes no call on this thread, so the token count alone would
  file it here. No list of local built-ins is kept anywhere: the token count is the proof,
  and it cannot go stale as Claude Code adds commands.
- **`context`** — `/clear` and `/compact`, the two commands whose job IS to move the context
  window. A closed, intrinsic pair; `/compact` costs real tokens, so cost cannot separate it
  from a work turn — only intent can, which is why these two names appear in the code.

**Whose line it is is decided before what shape it has.** A headless `claude -p` line carries no
`origin` either (0 of 5586 measured), so reading the shape first would file `claude -p "/review
this"` as a slash command — and turn detection keeps a command while it deliberately drops an sdk
prompt, so a headless run would grow a turn it never had. `promptSource` is therefore read ahead of
both shapes rather than guarded inside one: an sdk line stays an sdk line and still names its
session with the command's arguments.

**A command is written in one of TWO shapes, and both are the user sending something.** The
familiar one is the expansion — `<command-message>` / `<command-name>` / `<command-args>`. The other
is the command exactly as it was typed, in plain text (`/code-review del diff`), with no `origin`, no
`promptSource` and no tags: measured 2026-08-02 over 721 real transcripts, 19 lines, all real
commands (`/compact` ×17, `/code-review` ×2), on versions 2.1.200 → 2.1.220, with zero false hits.
Reading only the tagged shape lost the whole round again — a `/code-review` iteration had no turn at
all and its work was credited to the previous one. The gate for the plain shape is
`origin` **absent** (a task-notification is a `user` line with an origin of its own) and not
`isMeta`, and the line must be a command and nothing else, anchored at both ends.

**One invocation can write BOTH shapes, and they share a `promptId`** — `/compact` does, on 15 of
those 19 lines. The reducer folds them into one turn, keyed by `promptId` **and the command name**:
a prompt QUEUED while a command runs inherits that command's `promptId` (measured once, on a real
`/compact`), so deduping on the id alone would swallow a human turn to save a duplicate one.

`state: 'live'` means **working**, not merely open: an entry goes live only once it has
consumed a token, or while an agent it launched is still running. Otherwise a `/model` —
which opens an entry and is never closed by a
`turn_duration` — would pulse green forever. `turns` counts `work` entries only, so it keeps
meaning "rounds of work" even though the timeline shows more than those.

Skill and command counts exist twice, and deliberately: once for the session and once
inside each `TurnNode`. A widget scoped to a turn reads the turn's own counts, so it
can never show a session-wide number (`/clear ×3`) on a turn that used it once. Both
are built by the same helper, so their shape and ordering cannot drift.

**The live intent panel (V1)** answers "what is the agent trying to do right now" from a datum
the model already writes: a main-session `assistant` line that carries a **text block** but
is **not** the turn's end (`stop_reason !== "end_turn"`, measured `tool_use` on 79% of
text-bearing lines) is mid-turn **narration**. The parser emits it as a `turn-narration`
event (main session only — a subagent's narration has no consumer); the reducer keeps the
latest per turn (`TurnNode.lastNarration`, last wins). The panel sits between the Live activity
header and the feed; it shows the current intent — or the turn's final output (`TurnNode.result`)
once the `end_turn` answer lands — and its age. The text is clamped to two lines; when it
overflows, a `more` (revealed by measuring overflow after layout) opens the full text, rendered,
in the output modal. No LLM: the extraction is pure, because the harness already makes the model
narrate in short phrases. The activity feed below trades rows for the panel so the card's height
barely moves — 13 events when the panel is absent, 11 with a one-line intent, 10 with two (measured
from the panel's line count after layout; the ring still retains `FEED_CAP` = 13 for the drawer),
with the full history in Expand all and the Trace.

**What the agent DID since it last spoke outranks what it said — once its words have had their
moment.** A narration alone leaves the panel stale, not empty: measured on real sessions, one
narration stands unchanged for a median of 24s (p90 100s, worst observed 22 minutes) while ~8 tool
calls run under it. So the panel also carries an **activity group** — one line counting the turn's
calls since its last word (`TurnNode.activity`, `ActivityGroup`).

The handover is **not** immediate, and that is the whole difference between a live panel and an
unreadable one. A narration is the newest thing that happened for a median of just **2.6s** (42.9%
under two seconds, p90 11.6s), so giving the panel to the group on the turn's first call made every
narration flash past: the words were there and nobody could finish them. The last word (via
`TurnNode.lastWordTs`) therefore holds the panel — for **as long as that particular word takes to
read**, `narrationHoldMs` in `apps/server/src/core/activity-line.ts`, and only then does the group take over,
for as long as the silence lasts.

The hold is `chars / 17 per second`, floored at 3s and capped by what the panel can actually SHOW.
`.nowtext` is `-webkit-line-clamp: 2`; measured against the real CSS in Chrome at a 1440px
viewport, that is 828px of 14.72px type at ~6.89px per character of prose — ~120 characters a line,
so **240 visible**, ~14.1s of reading. Past that the text is behind `more` and no amount of holding
reveals it. This replaced a flat 12s, which the corpus (9020 real narrations, p10 55 chars, p50
**161**, p90 700) showed was wrong in both directions: **60% of narrations are read in less** — a
median of 6.1s in which the panel sat on a line already finished while work was under way — and the
other 40% were cut off mid-sentence. The floor binds on 8.3% of them, the two-line cap on 34.4%.
The hold runs from the word's **first sighting**, never from its timestamp: Claude Code stamps a
text block when it starts generating it but appends the line only once the block closes, so
counting from the stamp spent most of the hold before the panel had anything to show. Because no event announces the deadline passing, the panel arms one
entry on the shared 1s ticker that re-runs its own decision — and since that makes it the one
surface re-rendering OUTSIDE `render()` (which is what clears the counters), its counters carry
`owner: 'now'` and it reclaims them on each pass. Skipping that reclaim grew the list by one or two
entries a second between events, ~840 across a 7-minute command, each re-written on every tick.
Three rules define the group itself:

- **Derived, never accumulated.** The group is read off the tool ledger — a call counts when it
  started after the turn's `lastWordTs`, the later of its last narration and its final output —
  never tallied as events arrive, so a reconnect's re-sent line rewrites the same ledger entry
  instead of double-counting it. Because `snapshot()` runs on every event, the derivation is
  **memoised per turn** (`groupCache`) over a per-turn index of call ids (`toolIdsByTurn`), and a
  turn is recomputed only when something that feeds its group moved: one of its own calls started
  or ended, or the turn spoke (`dirtyGroups`). Walking the whole ledger on every snapshot instead
  measured +35% on the replay of the largest real session (1521 calls × 11.6k snapshots: 3898 ms
  vs 2892 ms); memoised it is 2864 ms, i.e. free. A cache like this can only be tested by asking
  for the snapshot after EVERY event, which is what the golden transcript does — a test that
  snapshots once at the end cannot see a stale group.
- **The group empties itself.** Any word from the agent — a new narration, or the turn's
  `end_turn` answer — moves the cutoff, so the panel hands itself straight back to the agent's
  voice, and a turn that ended normally has no group at all.
- **Main session only.** A subagent's calls carry no `turnIndex` by construction, so they stay in
  their own lane instead of inflating the main panel.

The words live apart from the panel in `apps/server/src/core/activity-line.ts` (pure, so the wording is
testable): one verb and an explicit plural per tool, MCP tools summed per **server** (`get_issue`
+ `list_comments` read as "2 linear calls", taking ONE slot), biggest count first with ties broken
by name so the line cannot jitter, and an unmapped tool named rather than given an invented verb.
The line names at most `MAX_FAMILIES` = 3 of them and trails off — measured, only 1.7% of real
groups touch more than three. It is past tense only: what is running lives in the age chip, so the
text does not move with the clock and needs no ticker entry.

The **age chip times the running CALL**, not the group: it answers "is something still going, and
for how long", in the same unit as the feed rows below so the two read as one card. It shows the
oldest call open for at least `RUNNING_AFTER_MS` = 1s (a lower bar would flash and vanish: the
median real call is 157ms), and is otherwise ABSENT — measured, 78.6% of a group's life has no
call open that long, and the panel then shows the count with no number. A call crossing the
one-second mark is nobody's event, so that chip appears on the shared 1s ticker.

One limit worth knowing before reading the chip as "nothing is running": Claude Code writes a
call's `tool_use` line about **3.6s after the call starts** (measured from inside a running call),
so anything shorter than roughly five seconds is never observed in flight at all. The chip times
the slow calls, which are the ones worth timing. Verified live from inside a 24s command: 17.8s at
t+18s, 23.8s at t+24s.

The line is seedeep counting, not the agent speaking, so it wears the same quote-less `.plain`
voice as the waiting panel. Capped at three families it stays inside the two-line clamp in every
measured case (the longest full line was 125 characters and two lines hold at least 140), but the
deferred overflow measure can still add `clamped` after the panel has rendered, which reveals
`more` — so `more` opens the line in full rather than being left inert.

The set of SSE event types the browser listens for lives in **one shared list**,
`apps/server/src/client/event-types.ts`, imported by both the live stream (`stream.ts`) and
the replay driver (`replay.ts`). A type present on the wire but absent from a
listener is silently dropped; keeping a single list is what prevents the two
paths from drifting (a new event type wired to one but not the other).

## The local server

The web GUI is served by a small local server that bridges the watcher to the
browser. It is a single process: the watcher tails the session files while the
server streams what it emits to the page. There is no daemon — it runs while you
watch and stops on Ctrl-C.

```text
watcher (EventEmitter) ──▶ server ──▶ browser
                            │  ├─ GET  /                  static page
                            │  ├─ GET  /api/sessions      roster CATALOGUE — every session, stable half (JSON)
                            │  ├─ GET  /api/live          roster LIVE half — running sessions (JSON, polled)
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

Session data is deliberately one-directional: the server only ever pushes it to
the browser, and nothing seedeep reads is ever written back. The browser does
POST two things — `/api/config` and `/api/restart` — and both act on seedeep's OWN
state (its config file, its own process). The invariant is about the corpus, not
about the socket.

**Every route, its parameters, its responses, its status codes and the SSE wire format
are in [api.md](api.md).** What follows is only why the surface has the shape it does.

### The roster is served in two halves

Split by how fast each half changes. The catalogue carries only the fields that stop changing once
a session's file exists, so a client fetches it once at boot and revalidates with an ETag; the live
half carries the running sessions in full and is the only thing a client polls. That split is what
makes polling affordable — the catalogue grows with every session ever written, the live half stays
a handful of records, and every additional client would otherwise pay the whole corpus again every
few seconds.

`core/roster.ts` owns both projections and the merge that rebuilds the whole (`toCatalogue`,
`liveOf`, `mergeRoster`); the client reassembles inside `createRoster`, so every consumer above it
still receives one plain roster. `mergeRoster` recomputes `isActive` from `lastActivity` and
re-sorts by it, because both are derived — the split must not transport what it can derive, nor
freeze an order that keeps moving. The contract that keeps this safe is
`mergeRoster(catalogue, live) === roster`, asserted in `apps/server/tests/roster.test.ts` against
fixtures and against a real roster from the machine running the tests.

**A catalogue record taken while its session was live is PROVISIONAL**: its `subject` can predate
the first prompt, its `model` the first API call, and its `lastActivity` is `null` by construction.
So a client refetches the catalogue on either of two signals, not one — the count changed (a session
was born), **or** it holds a provisional record for a session the live payload no longer lists (a
session ended). Size alone cannot see the second, because a finished session keeps its file.

`createRoster` serves fresh rows from every poll but notifies only when the identity key changes:
`current()` feeds the dropdown, so a row parked behind an unchanged key becomes a stale tab, while
`onChange` redraws the picker, so firing it on every moved mtime would redraw forever.

**Every reading runs under a 10 s deadline, and the poll's own liveness depends on it.** The next
poll is armed when the current one settles, and `fetch` has no timeout of its own: a request sent
down a half-open connection settles *never* — the browser has nothing to retransmit, so it waits for
an answer that cannot come, and the picker, the busy dot, ended-detection and auto-open freeze
together until the page is reloaded by hand. On expiry the request is aborted (a poll every 3 s
would otherwise pile up sockets nobody will answer) and the reading fails into the existing "keep
the last good roster" path.

That deadline is also why `persist()` refuses to write while `readings()` is 0: a boot whose first
reading failed proceeds with no rows, and saving that empty tab set would overwrite the workspace
the user actually had.

### The digest exists for a client that does not own the reducer

`/api/stream` and `/api/replay` carry `NormalizedEvent`s — parsed lines, not meaning — so a client
that wants to know what a session is DOING has to fold them itself. The digest is the answer for a
client that cannot: derived state, already cooked, one entry per live session. The tray is the
reason it exists.

Three rules make an entry trustworthy:

- **An entry is a JOIN, not a second derivation.** Every number in it comes from the same reducer
  the browser runs, so the two surfaces cannot disagree about the same session.
- **`turn.now` is `nowLine`'s answer, not a second one** (`apps/server/src/core/activity-line.ts`).
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
connection, each frame carrying its `sessionId`. One stream — not one per session — means opening or
closing a view is pure client-side state and never leaks a connection.

The stream also carries the one event the watcher does not emit: **`notification`**, the server's
own verdict that something is worth interrupting the user for. The transition detector
(`notify-watch.ts`) folds each reading of the digest and the engine (`notify-engine.ts`) gates its
output per channel — the tray subscribes here, a configured webhook is POSTed to instead. The
switches filter that output and never the detector's input, so turning one back on announces what
happens next and not the backlog it slept through. Evaluation is skipped entirely when nobody is
subscribed and no webhook is configured, which is what keeps an unwatched process idle.

**Staying connected is not free**, and SSE does not give reconnection for free on its own. Four
mechanisms make it true, each covering a failure the others do not:

- **Heartbeat.** Every 15 s the server writes a `heartbeat` event to each client. A session can be
  silent for minutes (a background subagent writes only to its own file), and a connection carrying
  nothing looks exactly like one that has died. It is a named *event* and not an SSE comment — a
  comment reaches the socket but never the page, and the client's watchdog has to be able to hear
  it — and it carries no `id:`, so it never shifts the numbering of the real events.
- **A failed write closes the stream.** Evicting a dead client from the registry is not enough: the
  browser is never told, so its `EventSource` stays `OPEN`, fires no error and never reconnects.
  `ClientRegistry` closes the controller, which ends the response — the only thing the browser can
  act on.
- **The client owns its reconnect.** `EventSource` retries by itself only while it is still
  `CONNECTING`; a fatal error leaves it `CLOSED` for good. `stream.ts` watches `readyState`,
  rebuilds the connection, and reports every transition through `onStatus` — the header pill is the
  only thing on screen that speaks about the connection, since a card's `live` badge reports whether
  the SESSION is running.
- **A watchdog on the heartbeat**, so a connection that is `OPEN` but silent is treated as lost.

A client recovers what it missed with `/api/replay?from=`, not by asking the stream to rewind: there
is no backlog and no `Last-Event-ID` handling. The `seq` marks that make live and replay safe to
overlap are the wire contract, and they are specified in [api.md](api.md#the-sse-protocol).

The replay→live seam is deliberately the server's business only up to the frame: the browser's
driver (`client/replay.ts`) decides what to drop, because only it knows what it has already folded.

### Reading one thing back

`/api/tool-output`, `/api/call-io`, `/api/agent-prompt`, `/api/commits`, `/api/files` and
`/api/cards` all name a session and read it on demand rather than holding it in memory.

**The path always comes from the roster, never from the query.** A caller can only name a session
seedeep already discovered, so no path outside the corpus is reachable — this is the property that
makes the whole family safe to expose.

### The aggregate cache

The **minute-zero retrospective**: corpus-wide aggregates shown on the Home surface at launch,
without waiting for a live turn (`apps/server/src/server/aggregate-cache.ts`). It runs the real
parser, reducer and verdict per session — the same code the live path runs, so the cache's numbers
and the GUI's cannot diverge.

**It reads each session's subagent transcripts too**, through `streamReplay`. Reading the parent
alone leaves a large share of the corpus's billable tokens out of every aggregate, because a
subagent writes its own file. Invalidation therefore stamps the children as well
(`subagent-files.ts`, `subagentStamp`): a child can be written when the parent is not, and the
parent's `(size, mtime)` alone would serve a summary missing that child. Where those files live is
defined once, in `subagent-files.ts`, and both replay and the cache read it from there — including
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

- **Per token type** — `cache read ×0.1 · cache write ×2 · input ×1 · output ×5`. Anthropic
  publishes these, expressed in tokens, as the Priority Tier burndown rates
  ([Service tiers](https://platform.claude.com/docs/en/api/service-tiers)): *"These burndown rates
  reflect the relative pricing of each token type."* Cache writes take the **1-hour** rate (2.00,
  not the 5-minute 1.25) because the cache lifetime is an hour on a subscription.
- **Per model** — Haiku ×1 · Sonnet ×2–3 · Opus ×5 · Fable ×10, derived from the price list and
  **seedeep's own**: Anthropic publishes no cross-model token ratio, and structurally never needs
  one (it partitions budgets — a separate Opus limit, Priority Tier commitments per model version).
  The surface states this distinction rather than hiding it. An unrecognised model id weighs **0**,
  never an invented ratio; a merely NEWER id falls back to its family, so a future `claude-opus-9-9`
  is not silently free.

Weighting is applied **once per call**, inside the reducer's existing per-`callId` guard — Claude
Code repeats a call's usage block on every content-block line, so weighing per line would multiply
a call by its block count. `main.weighted` and `weightedSubagents` are kept apart (the two sides of
the reducer's `owner === null` branch) and summed deliberately.

**A session's weight is whole-session, not Σ its turns.** `SessionSummary.turns` holds only closed
WORK turns — right for a turn retrospective, wrong for a session total: an unclosed final turn, or
an sdk session (which never writes `turn_duration`), would contribute nothing.

## Post-turn verdict

At the end of every turn, seven **deterministic** detectors (zero LLM) run over data the snapshot
already holds (`apps/server/src/core/verdict.ts`): a **wasted subagent** (a large output returned to
main — a heuristic lower bound), **compaction** mid-turn, a second consecutive **Esc**, a cold
**resume**, a **context** fill ≥70% of the model's window, an **exploration** (≥8 files read into
main with nothing changed and nothing delegated), and an **unverified ship** (real code committed
with no check run anywhere earlier in the session). The worst finding sets the turn's severity
(`good | warn | crit`). What the two faces of it look like is in
[features.md](features.md#a-verdict-on-every-turn-both-faces).

Three rules constrain what may become a detector:

- **Every detector cites a public source.** A rule defensible only by one user's private
  conventions is a rule written for one user, and seedeep ships to other people; the quote lives
  next to the threshold in `verdict.ts`.
- **No detector compares a turn to the user's other turns.** A turn that spends more because it
  DID more is not waste, and a personal-baseline comparison reports size rather than waste.
- **A rule looks only BACKWARD.** Only the *second consecutive* interruption is a finding: a turn
  that turns out to be the first of a streak is a lone Esc at the moment it closes, and a
  forward-looking rule would make a finding appear retroactively on a turn already rendered. A lone
  Esc is prescribed practice, not a defect.

**A finding costs nothing to compute**: every detector reads the snapshot the reducer already
produced, in one pass, so the verdict cannot become a reason to keep data around.

## The GUI shell

One page, one process, tabbed. A live session gets a tab by itself; on top of that
the workspace you left is restored (see below). It offers a dropdown of **all**
sessions (active and inactive, grouped) to switch to or add — including replaying
a finished one. It is built as small ES modules: pure logic
(`stream`, `replay`, `sessions`, `tab-store`) that is unit-tested
without a browser, plus thin DOM glue (`tab-bar`, `nav-menu`, `dropdown`, `view`, `home-view`,
`app`).

**The fixed surfaces live in a header menu, not in the tab strip** (`nav-menu.ts`, mounted on
`#nav` left of the wordmark): **Home**, **Compare** and **Search**, each keyed by a reserved id
(`HOME_ID`, `COMPARE_ID`, `SEARCH_ID`) that is not a uuid, so it can never collide with a session.
They were three permanent pills at the head of the strip, and the strip is where you find a
SESSION — labels that never change were spending the width the subjects need. None is a session:
all live outside the `openTabs` map, and `switchTo` shows their panel the same way it shows a
session's.

The trigger **adopts the current surface's name** (`✦ Home`) and drops it on a session. That is
not decoration: with the pills gone, no tab in the strip is active while a fixed surface is on
screen, so the trigger is the only thing left that says where you are — and Search's panel, an
empty input, does not name itself. Interactions match the picker's, one menu idiom in the header:
the trigger toggles, click-outside and Esc close, ↑/↓ walk the items (real focus on real buttons,
so Enter and Space come free), and the current surface is marked with `aria-current="page"`.
`tabBar.setActive` is still called with the reserved id and simply lights nothing.

**Search** (`search-view.ts`, reserved id `SEARCH_ID`) renders `/api/search`. It fetches nothing on
switch — it has no answer until there is a question — and takes the caret instead, so switching to
it and typing is one gesture. A row states how well it matches (the number it is ORDERED by), which
session it is, and the passages that matched, each attributed to *you* or *claude* and highlighted
with `<mark>` ELEMENT nodes built from indices — never an HTML string, since the text is a real
prompt. The row's meta line carries the session's WHOLE uuid as a click-to-copy chip — the id you
paste into `claude --resume` — and the actions column on the right holds one button, opening the
session in a tab (the same path the picker and the Compare row take). Ordering, the Human/Automated
split and whether the automated runs are shown are all client-side over one response. Rules:
[`search.md`](./search.md).

**The id chip** (`id-chip.ts`) is shared by the Search row and the picker row: it shows the first 8
characters of the session id — what seedeep already printed — and copies the FULL uuid on click,
which is what `claude --resume` and a grep of the transcripts need. A copy the browser refuses
leaves the chip unchanged rather than claiming one.

**Compare** (`compare-view.ts`, reserved id `COMPARE_ID`) renders `/api/compare`: a header and one
row per session. It carries **no KPI tiles** — they were removed on request (2026-07-28): the
leaderboard is the surface, and a tile restating the window's total said nothing a row did not.
The window's totals are still in the response and still used — for the model legend, the scope
line and the remainder's share. A row's bar is **two facts in one object** — its LENGTH is the
session's weight, its SEGMENTS are the model mix — so "how heavy" and "why" need no second column.
A row is **three STACKED lines**: the prompt, then every chip (project · main model · when it last
ran · API calls · complete tokens · subagent share · a `▲N vs unweighted` chip when the weighting moved
it by 3 places or more), then the **bar, full width**, with the weight at its right end. Each line is
clipped with an ellipsis, never wrapped — a row that wraps is taller than its neighbours, and an
uneven leaderboard reads as if the tall rows meant something — with the full text on hover.

Stacking is what ended a fight the column layout kept losing. With the bar beside the text, the chips
and the prompt shared roughly half the row and the ratio between them had to be rebalanced three
times, each new field costing ~70px before it silently clipped the chips at the end (model, subagent
share, `▲N`) while still looking tidy. Stacked, the prompt and the chips each get the whole row —
~1190px at 1440px against ~650px before, and 0 clipped chip lines down to 1100px — and the bar loses
nothing by being full width, since its job is to be comparable, not short: a small bar is in fact
easier to read on a longer track.

The subagent share carries **no threshold**: it is a fact about the session, not a judgement about
what deserves the space, and "2% subagents" is as true as 24% — a 5% cut used to hide it on a
quarter of the rows. The `▲N` chip does carry one, at 3 places, and it is measured rather than felt:
in the only window where it decides anything (7d, where nearly every session ran the same model so
the weighting multiplies them all alike) shifts of ±1 are 11 of the 14 rows that would carry a chip
— two sessions of near-identical weight trading places, which says nothing about the weighting. At
30d and all, 12–13 rows clear 3 regardless.

**A row opens the session it describes** — same path as the picker (`openFromDropdown`), so a row
and a pick cannot open a session two different ways. It is a real button: `role="button"`,
tab-reachable, and Enter/Space do what the click does, because a `div` that only answers the mouse
is a control nobody can reach from the keyboard.

The window filter switches client-side (all three windows arrive in one response) and **opens on
`all`**: the question is which session weighed the most, and landing on a 7-day slice hides the
sessions that actually did. The fetch happens on **tab switch**, not at boot, so a launch that lands on a session tab does not pay for a
corpus refresh. There is **no unit label** — no "opus-equivalent": a permanent *how this is
computed* block carries the explanation instead, with the per-model factors shown in the same
colours as the bars, and the one factor Anthropic does not publish marked as seedeep's own.

**Home.** The first menu entry (`home-view.ts`, reserved id `HOME_ID`) renders the minute-zero
retrospective from `/api/retro` as a compact
dashboard: KPI tiles, the turn-size distribution (the hero), weekly activity, a waste-by-cause
breakdown, the verdict split, and a `7d / 30d / all` window filter that switches client-side (all
three windows arrive in one response). The **activity card carries its own metric tabs** —
`tokens` (default) / `turns` / `hours` — so one bar per calendar week can be read three ways;
they repaint from the loaded retrospective, never refetch. `turns` keeps the severity stack;
`tokens` and `hours` are single-colour, because a volume is not a severity (the same rule the
histogram follows). It is never closable and is not a session, so it lives outside the `openTabs`
map. Its dashboard classes are
all `rt-`-prefixed: the stylesheet has no CSS scoping, and a generic name (a pre-existing `.wrow` with
a red left border) once bled onto every waste row — the prefix is the isolation mechanism.
**Launch rule:** if a live session auto-opens (or a saved tab is restored active) you land there
and Home is one menu click away; otherwise Home is the landing surface. Either way Home always exists,
so an empty workspace never reads as a broken page — it replaces the old empty-hint.

**Why `graph.ts` is one large module and stays that way.** It is the client's largest
module (~4900 lines), and the
obvious answer — split it per widget — was measured rather than assumed. Each candidate
block was scored by what it would have to receive from `createGraph`'s closure, because
the extraction interface is what decides whether a split helps: the drawer needs **25**
closure bindings, the turn explorer 15, the subagent rail 14. A module taking 25
parameters is the same closure with a form to fill in — it moves the coupling behind an
interface instead of removing it, and makes the next diff unreadable for no gain. 830
lines across 15 functions sit at 8+ bindings, so per-widget splitting was rejected on the
numbers.

What DID come out is `graph-derive.ts`: the functions that derive a value from a snapshot
and touch neither the DOM nor the closure. Session state they used to read from the
closure (`ended`, the clock) is a parameter there, which is what makes the rules testable
without mounting the bento or waiting five minutes — turn numbering (the "Turn 13 / 11"
class of bug), the workflow silence threshold, and what "running" means on a session that
has ended. The rule for anything else: extract what becomes *testable*, not what merely
becomes *shorter*.

**`apps/server/src/client/` is rendering and transport; the meaning it draws comes from
`apps/server/src/core/`.** What lives under `client/` is the DOM (the shell, the bento, the
Trace, the widgets), the SSE plumbing (`stream.ts`, `replay.ts`, `event-types.ts`)
and browser-local state (`tab-store.ts`, `end-guard.ts`, the client half of the
roster split). Everything that turns events into meaning is core, and the test for
which side a module belongs on is not "does it compile in a browser" — it is
**whether it derives**. A module that reduces or selects goes in `core/`; a module
that paints, listens or remembers stays in `client/`.

**The client ships as one bundle.** `index.html` loads a single module, so there is
exactly one entry point: `bun run build:client` bundles `apps/server/src/client/app.ts` into
`apps/server/public/lib/app.js` (committed, so the repo runs without a build step). `apps/server/public/` therefore holds only the page, its stylesheet
(`apps/server/public/css/`, one file per sub-feature, `<link>`ed in cascade order) and that
artifact.
The rule the layout enforces: a shared module is resolved once. Registering each
module as its own entry point bundles it independently — a module imported by two
entries is inlined into both, so the page loads two copies of the same reducer.
Adding a module is now free (import it; the bundler follows), which is what keeps
splitting a large view into smaller ones from touching the build at all.

- **A session that starts gets a tab — once.** One rule covers the first visit and
  every session started later: a live, interactive session that has not been
  offered before opens a tab. "Offered" is remembered (`known`, persisted next to
  the tab set), which is what separates *offer it once* from *reopen what I
  closed*: a closed tab is gone from the tab set but stays in `known`, so it never
  returns — not on the next poll, not after a refresh. `known` is pruned to the
  live sessions, since one that has ended can never re-trigger.
  - It opens in the **background**. The tab appears and starts reading, but does
    not pull you onto it — anything else would yank you off what you are reading
    every time a session starts. The exception is an empty screen, where a tab
    nobody is looking at would leave the page blank.
  - **Automated runs are excluded.** A headless `claude -p` registers as an open
    session for the length of its run (measured), so without this every git push
    would pop a tab — and a content-less one at that.

- **A tab says which session it is.** The label is `<project> · <subject>` — the
  subject (the session's first human prompt, anonymized at parse time) cut to 30
  chars, falling back to a short session id when there is none. The project alone
  made two sessions of one project indistinguishable.
- **A tab's state is never words.** The label is the label; state rides on other
  channels, because `· ended` ate the room the subject needs:
  - dot **pulse** = generating right now (green);
  - the **tab dims** when its session ends, since everything inside it is then
    frozen history — a property of the whole tab, not a badge on it. The active
    tab dims less: being quiet must not mean being unreadable.
  - the `title` spells all of it out on hover and for assistive tech, so a class is
    never the only channel — the words used to carry that, and dropping them
    without a replacement would have traded space for accessibility.
- **The workspace survives a refresh.** The open tabs, their order and the active
  one are saved to `localStorage` on every change and restored at boot. The saved
  set decides which tabs **exist**, so a tab you closed stays closed; only a
  genuinely new session adds one, per the rule above. Storage is best-effort — it
  is guarded at the access, not only at the call, because reading `localStorage`
  throws outright where storage is disabled — and a dead storage degrades to
  opening the live sessions, which is also the first-visit behaviour.
- **The picker pins what is already open.** Sessions with a tab are marked, since
  picking one switches to its tab instead of opening a second. The pin is pushed by
  `app.js` on every open/close: the roster's identity key is built from the sessions
  themselves (id, liveness, status, subject), so it does not change when a tab opens
  and could never drive this.

- **One shared live connection.** The whole GUI opens a single `/api/stream`
  `EventSource`; a client-side router dispatches each event to the tab that
  subscribed to its `sessionId`. Opening or closing a tab only mutates a handler
  map — it never opens or closes a connection, so tabs cannot leak feeds.
- **Replay is a separate, ephemeral connection.** Each replay opens its own
  `/api/replay` `EventSource` that self-closes at `replay-end`.
- **A tab loads before it paints.** Until the replay ends, the tab shows a skeleton
  loader (on the bento's own grid, so the layout does not jump) and the views paint
  **nothing** — the Graph still absorbs every event (its activity feed keeps filling its
  ring) but draws only at the replay→live handoff, in a single pass. A large session's
  history is thousands of events: painting through that flood rebuilt the whole bento per
  coalesced tick, and the user watched the dashboard assemble itself for seconds on every
  refresh. The loader cannot hang, because `startReplay` fires the handoff exactly once —
  on `replay-end`, on a dead connection, or on `stop()`.
- **Active tab = replay then live.** An active tab first subscribes to the live
  feed but buffers it, replays its history from the start (so the view shows the
  real accumulated fill immediately), then flushes the buffered live events the
  replay did not already emit — deduped on `(sessionId, seq)` — and continues
  live. This handoff loses no event written during the replay and doubles none.
- **A live roster.** The roster is re-fetched on a light timer: a newly-born
  session appears in the dropdown (never steals focus by auto-opening a tab), and
  an active session that expires re-labels its tab "ended" and closes its live
  subscription, freezing the view on the last state.
- **One view per tab, one feed.** The tab mounts the **Graph** against the
  session-tree reducer: a live bento dashboard on ONE left vertical — the cockpit's left column,
  the stats strip's first card and the output row's first card are all one strip card wide
  (`calc((100% - 2rem) / 3)`), so Context, Subagents, Session and Commits share an edge — with a context dial +
  token breakdown (with a colour legend), a Session card (the token ledger plus the
  turn KPIs and the timeline entry point — the turn DISTRIBUTION lives only in the
  timeline strip), a skills+commands widget and a Changed files widget — the three share the
  stats strip in EQUAL thirds — the last carrying a total plus a
  proportional bar per file extension, counted from GIT (`GET /api/files`, see
  `docs/changed-files.md`): the files of the commits attributed to the session, so a shell write and
  a build are included where the `file-change` ledger above cannot see them — and a session that has
  not committed shows no number rather than one nothing can verify. Its DESCRIPTION doubles as the caption naming that set, which is why
  the card has no trailing line; the session scratchpad — the one thing git cannot see — is
  tallied in one row below the bars. The complete list lives in its drawer, grouped
  project-then-scratchpad and narrowed by a path filter and a type filter.
  Below the strip sits an output row of its own: the Commits card — as wide as one stats-strip
  card, so the two rows share a vertical, and present only when the session owns commits (see
  `docs/commits.md`) — leading collapsed main tools ordered by output size, which takes the rest;
  with no commits, Main tools takes the whole row and stops truncating its paths.
  Then a bounded activity feed, and a subagents grid in launch order. When the session ran subagents the Session card's by-model
  bar makes it taller and `align-items:stretch` hands its two capped neighbours the same height, so
  Changed files shows a 5th file-extension bar (cap 4→5) and Main tools a 4th hog (3→4) — gated on
  the same `subagentsTotal > 0` as the bar, spending the height on real data (96% of subagent
  sessions have a 4th tool, 43% a 5th file type) rather than blank space. The Skills+Commands card
  splits its own height 50/50 between the two (in CSS, independent of subagents), so its slack is
  shared evenly instead of pooling under Commands. With a right-side drawer (per subagent / tool / API call /
  tool-type / skill / command) that locks page scroll while open, and a read-only modal above it for a
  subagent's full launch prompt or returned text (both truncated in the drawer with
  a "show full" affordance). An activity-feed row opens the same drawer: it keeps
  only the `tool_use_id`, and resolves it against a freshly built snapshot at click
  time (a spawn row → the subagent it launched), so the feed never holds a second,
  drifting copy of a tool's state. Every drawer is laid out the same way, and the
  order encodes rank: a header (kind chip, title, and an identity line carrying only
  what the entity IS — type, model, owner — never a measurement), then 2–3 KPI tiles
  for the facts the entity actually raises, then bars for anything that is a
  proportion, then the content blocks, then a `Details` list for bookkeeping. A fact
  the snapshot does not carry is DROPPED, never rendered as a dash: an empty row in a
  demoted list is pure noise. Plus cyan/purple toasts for new tools and subagents
  (armed only after the initial
  replay hands off to live, so history never floods them).
- **A subagent toast names the model the spawn runs on.** Not inferable from the
  session: measured over ~1600 real subagents, 74.6% run on a different family than
  their parent. The toast never WAITS for it (deferring it was tried in 2026-07 and cost
  real latency): it fires at once with the model line reserved, and
  `syncSubToastModels` fills that line in place on the next render. **Filling in is the
  normal case, not the exception** — Claude Code writes the child's sidecar BEFORE the
  parent's assistant line, so the `subagent-meta` that fires the toast usually arrives
  ahead of everything that could name the model: measured on the live stream, 4 of 6
  spawns had the `Agent` tool-start (which carries `spawnModel`) land 0.6–2.7s LATER,
  and the model appeared on screen 0.6–1.8s after the toast. When the tool-start does
  win the race, the model is in the reducer but not yet in the last painted snapshot, so
  the lookup falls back to `state.snapshot()` and the line is filled at birth. For the
  30.1% of spawns that declare no `model:`, nothing can name it before the child writes
  its first assistant line — p50 3.2s, inside the toast's 5s life. A model landing after
  the toast is gone touches nothing: `dismiss()` drops the slot.
- **A pending prompt takes over the NOW panel, and the tab dot goes amber.** When the
  roster reports the session blocked on the user, the panel that says what the agent is
  doing says instead that it is doing nothing until you answer — amber, naming the tool
  it is waiting to approve WHEN THE TRANSCRIPT HAS IT (read from the newest unfinished
  feed row; for a gated `Bash` it does not — see `pendingTool` above, measured
  2026-07-30) and ticking how long it has been
  stopped, from CC's own `statusUpdatedAt` rather than from the poll that noticed. An
  amber toast announces the transition ONCE, for whoever is looking; the panel and the
  tab dot keep saying it until it is answered, which is what a tab switch needs (a toast
  in a hidden panel is born and dies unseen). A turn the user has SELECTED is never
  hijacked — the tab badge still carries the state. Latency is the roster poll (≤3s),
  which the wait itself dwarfs. A **Trace** button in the
  Live activity header opens a near-fullscreen modal that shows the session as a
  single continuous flow diagram — a vertical spine of turns, each expanding in
  place into its grouped strip of steps, with subagent lanes unfolding under their
  spawns. Scope-aware, follows the newest work live. Its rules (grouping, live
  semantics, subagent lanes, reply-vs-done) have their own reference: `trace.md`.
  Clicking any span opens the existing detail drawer (no separate state).
  `apps/server/src/core/span-store.ts` is the sole data source, fed by `onEvent`.
- **Selecting a turn scopes EVERY widget, the feed included.** Context, cache,
  skills, commands, activity, main tools and subagents all read the turn-scoped
  snapshot; the Session card's footer and the timeline strip stay session-wide
  because they are the navigator. The activity feed is the one widget not driven by snapshots (it folds
  raw events), so it scopes itself: its ring retains the last N activities **per
  turn**, not globally — a session-wide cap would have already evicted an older
  turn's events by the time you select it, leaving that turn permanently empty. Its
  header follows the scope, and the "live" badge only survives on a turn still running.
- **`Expand all` on the Live activity card opens the COMPLETE activity list** in the
  standard drawer. It exists because the ring's cap (13) is, measured over real logs,
  about the *median* turn — so roughly half of all turns have activity the card can never
  show, and the ring's eviction is destructive (the rows are gone from memory, not
  merely hidden). The list therefore does NOT read the ring: `activity-list.ts`
  flattens `span-store.ts`, which keeps everything, into one chronological sequence.
  **It is the card's list, longer — never a different list**: the span store also holds
  each turn's `prompt` and its `result` (`done`), which are turn STRUCTURE and never reach
  the feed, so `ACTIVITY_TYPES` keeps only the span types the two `feed.push` sites emit —
  `api`, `tool`, `subspan`, `spawn`. Without that filter the list showed rows the card
  cannot have (the next turn's prompt among them) and its `Elapsed` KPI, measured
  first-row → last-row, spanned prompt-to-prompt, counting the user's thinking time as
  activity. The Trace, which draws the turn itself, still shows both.
  Subagent spans live **only** inside `turn.spawns[].lanes[].spans` — never in
  `turn.spans` — so a list built from a turn's own spans would silently omit
  everything a subagent did while still looking complete; the flatten merges both and
  ties on `t0` put the main thread first, keeping a spawn above the children it
  created. Rows carry the span's `DrawerHandle` and open through the same `openBlock`
  router the Trace uses, so a row and its span lead to the identical drawer — but the list
  passes a `BackEntry` and the Trace does not, and that asymmetry is the rule: a breadcrumb
  appears when the surface you came FROM was itself a drawer and got replaced. The Trace
  modal and a feed row stay visible behind the drawer, so they are still there to return to
  and add no crumb; the all-activity list is replaced, so without a crumb a drill-down would
  strand you. Rows keep a
  `t-<type>` class as a semantic hook but draw no type marker: the name already says what
  the row is. Scope-aware like every other widget. A span that closed within the millisecond
  it opened has no duration and renders `—`: `running…` is reserved for spans that actually
  are.
- **Prompts and results render as markdown** (`apps/server/src/client/markdown.ts`) in the modal —
  headings, fenced code, lists, tables, quotes, inline code/bold/italic/links. It
  builds DOM nodes with `createElement`/`textContent` and **never touches
  `innerHTML`**: the content is arbitrary session text, so markup in a prompt must be
  text, not structure. A link with a non-`http(s)`/`mailto` scheme is left as literal
  text rather than becoming an anchor. The `user-turn` event carries the **whole** prompt
  (same 20k cap and `anon()` pass as a turn's result): a view can always shorten a prompt
  to a line, but it cannot recover what the parser dropped. The banner therefore shows a
  derived one-liner (`promptLine()`, shared with the strip's tooltips and rows) and offers
  an **Input** button that opens the original. The button appears when what you see is not
  what you typed — either the DATA was shortened (lines collapsed or cut), which is known
  outright, or the LAYOUT ellipsized the line, which is *measured* with a `ResizeObserver`
  (truncation depends on the viewport, and an inactive tab is `display:none`, where a
  one-shot measurement would read zero).

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

- **Liveness is never taken from the file.** A record outlives a process that died without cleaning
  up, so a reader proves the process with `process.kill(pid, 0)` and treats the record as a claim
  rather than a fact.
- **One file per pid, never one shared file.** Two servers on one machine is a legitimate state — a
  checkout running beside an installed release — and a single shared file makes the second erase
  the first.
- **The URL is rebuilt, never read back from the record.** A record carries no token, so a verb
  that needs a reachable URL composes it from the configuration it has just read.

A detached start sends its output to `<seedeep home>/server.log`, created and kept `0600`: it holds
the startup banner, which in remote mode carries a token.

`--help` and `--version` win wherever they appear in the arguments, and an unknown argument is an
error rather than a silent default — a typo that starts a server on the wrong port is worse than one
that starts nothing.

**The `/seedeep` command file is refreshed, never re-created.** The file seedeep writes into Claude
Code's `commands/` directory ends with a marker naming the version and carrying a digest of the
body. On start seedeep rewrites it only while that digest still matches what it last wrote: a file
the user has edited becomes theirs and is left alone, and a file the user deleted is not put back —
deleting it is a choice.

Which verb does what, and what a user types to get it, is in [install.md](install.md).

## The update check

`update-check.ts` holds the only outbound request seedeep makes on its own, and the cache that keeps
it to one an hour.

**The clock is the cache, not a timer.** Nothing is scheduled: an answer older than an hour is
refetched by whoever asks next, so ten clients in that hour cost one request and a server nobody
talks to costs none. A timer would have to be created and cleared at shutdown, and would keep
fetching for a portal closed a week ago. A failed check has a cooldown of its own — 15 minutes,
deliberately shorter than the TTL, because a failure has no answer worth preserving.

**Only `latest` is stored; the standing is derived** at read time, so a cache written before an
upgrade cannot claim the new build is out of date.

The verbs a user TYPES pass `force`, skip the cache and ask npm, then leave the fresh answer in it
for the surfaces that only read — which is why four surfaces report the same version without four
requests. `GET /api/update` is the one endpoint all of them read ([api.md](api.md)).
