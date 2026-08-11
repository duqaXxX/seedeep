# Architecture

seedeep makes the invisible inside a Claude Code session visible: in real time
during a turn, how the **context window** fills and what the **subagents** are
doing — assembled live from the local session logs.

The design principle is **read-only**: seedeep only reads the session files Claude
Code already writes. It never writes, proxies, or intercepts anything Claude Code owns.

The one write it does make is to a file it **owns**: a gitignored aggregate cache under
`~/.seedeep/`, a distillation of the corpus it read (see
[the aggregate cache](#aggregate-cache--get-apiretro)). It touches no session file, so the
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

**The tray shares no code with the server** — it is an HTTP client of `/api/digest` and
nothing else (`docs/tray.md`). That is why it lives beside `apps/server/` rather than
inside it, and why a change to `core/` can never break it without changing an endpoint.

There is **one version for the whole repo**, so a tag ships every deliverable together
and two of them built from the same tag are compatible by construction — no
compatibility matrix. It is not a convention anybody has to remember: the root
`package.json` holds the only version number, and `apps/tray/src-tauri/tauri.conf.json`
names that file as its `version` instead of carrying one of its own. Pushing a `v*` tag
is what turns that number into downloads: the tray's two installers and the server's five
executables, out of the same workflow and the same commit — see
[Shipping the server](#shipping-the-server).

**Five gates run on every push and pull request** (`.github/workflows/ci.yml`), because a
rule nothing enforces is a rule that quietly stops being true — the type-checker was red
on `main` while every local test run stayed green:

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
`bun run build:server:all` (`apps/server/scripts/build-binaries.ts`) writes all five into `dist/`,
cross-compiled from whichever machine runs it, which is why CI builds them on one runner where the
tray needs a matrix. Nothing has to be installed to run one: that is CLAUDE.md's distribution
invariant, and it is why the GUI is embedded rather than served from a folder next to the binary.

**Every asset is named after the app it is** — `seedeep-server_<version>_<platform>` beside the
tray's `seedeep-tray_<version>_…`. A release page carries both, and two macOS files sharing a
shared prefix would say nothing about which one reads your sessions. Nothing is renamed on the way
out any more: the tray's `productName` **is** `seedeep-tray`, so its bundler already writes that
(`docs/tray.md`, *Packaging and releases*). The two products are named apart, not just their
downloads — which is what lets a system permission dialog name the one that is actually asking.

Three things about that script are decisions, not detail:

- **It rebuilds the client bundle itself.** `assets.ts` embeds `public/lib/app.js` by path, so a
  compile that skipped the rebuild would ship a GUI from an older commit — and nothing downstream
  could tell.
- **Nothing is left external any more, and that is the point.** `playwright-core` used to be, because
  it does `require(path.join(packageRoot, 'package.json'))` — a COMPUTED require no bundler can
  resolve, which Bun left to runtime with the build machine's path frozen into it. A binary compiled
  in CI looked for the runner's own checkout, `<ci-workspace>/node_modules`, on the USER's machine
  and died at startup; v0.6.0 shipped five of them, and the defect was invisible to whoever built it,
  because on the build machine that path exists. The card is now drawn by the browser (*Share card*,
  below), so playwright left the product entirely and `chromium-bidi` — its BiDi transport, never
  installed — went with it.
- **A binary may not contain the path of the machine that built it.** `assertNoBuildPath` fails the
  build on any occurrence, because that is the one class of defect a build-machine test cannot see.
  Measured: two occurrences in the broken binary, zero in the repaired one.
- **No Windows arm64.** Bun documents no such `--compile` target.

The Linux binaries are dynamically linked against glibc, so a musl distribution (Alpine) is not a
target either.

#### The npm channel

The same five executables also ship as npm packages, which is what `npm i -g seedeep` installs.
**Node is needed to install them, never to run one**: the package carries the compiled binary, and
`bun run build:npm` (`apps/server/scripts/build-npm.ts`) only arranges files — it never compiles, so
`bun run build:server:all` has to have run first, and in that order, since the compiler wipes
`dist/`.

It is the shape Claude Code itself ships with (verified on the registry, 2.1.220): a wrapper package
whose `bin` points at a file inside itself, plus one `optionalDependency` per platform carrying the
real executable. npm resolves those against each package's `os`/`cpu`, so a machine downloads one
binary rather than five, and the wrapper's postinstall (`apps/server/npm/install.cjs`) puts that
binary over the placeholder the `bin` field already names. Nothing is fetched by the script itself,
and no Node process survives the install — `seedeep` on PATH *is* the server.

Four decisions hold it up:

- **The reason the channel exists is the quarantine flag.** macOS sets `com.apple.quarantine` in the
  program that downloads a file, not in the file; installed through npm the binary carries only
  `com.apple.provenance` (measured), so the first-launch refusal that the plain download has to
  explain simply never happens here. Nothing had to be signed to get that.
- **The placeholder is named `seedeep.exe` on every platform and carries no shebang.** npm generates
  the Windows `.cmd` shim from that file *before* the postinstall replaces it, and `cmd-shim` only
  emits a direct exec of the target when it finds no shebang to honour — a `#!` line would make
  every Windows install hand the native executable to an interpreter.
- **An unsupported platform is refused by npm itself.** The wrapper declares the `os` and `cpu` it
  was built for, and npm reads them as a cross product: anything outside fails with `EBADPLATFORM`,
  naming both what was wanted and what the machine is. The cross product admits one combination
  seedeep does not build — Windows on arm64, for which Bun has no target — and the postinstall is
  what refuses that one, by name.
- **The wrapper pins its binaries to its own exact version.** One tag publishes both halves; a range
  would let npm pair a wrapper with an older executable.

**Both package managers install it, but not by the same command.** `bun install -g seedeep` BLOCKS
the postinstall by default — it prints `Blocked 1 postinstall`, reports success, and leaves the
placeholder as the command (measured on bun 1.3.13). `bun install -g seedeep --trust` does the whole
thing in one step, and `bun pm -g trust seedeep` finishes an install that already happened; both were
verified end to end, and the trust persists across later installs. That is not an edge case to note
in passing: seedeep is built with bun, so its own audience installs that way. npm runs the script
either way. The placeholder names the bun gesture first for that reason — and bun runs the script
with its own `node` shim, so the fallback works on a machine that has no Node at all.

The bare downloads stay on the release page, and are not a fallback: they are the channel for a
machine with no Node — a headless box reached over SSH — and requiring a runtime before seedeep
would be the exact failure this project's distribution invariant exists to prevent.

Publishing is a separate, deliberate act. `release.yml`'s `npm` job runs only on a tag AND only when
the repository variable `SEEDEEP_NPM_PUBLISH` is `true`, because a publish cannot be taken back
(unpublish is restricted after 72 hours) and the first one has to be manual anyway — a trusted
publisher can only be configured on a package that already exists. Once it is, the job authenticates
by OIDC, so no npm token is stored in this repository.

Which is why every action in both workflows is pinned to a full commit SHA, with the tag kept in a
comment on the same line. OIDC removes the token, but it does not remove the credential — it moves
it inside the job, where it is minted on demand. Anything running in that job is therefore already
in a position to publish, and a tag like `@v2` is a pointer its owner can move at any time: the
`tj-actions/changed-files` compromise (CVE-2025-30066, March 2025) rewrote every tag from `v1` to
`v45.0.7` onto a malicious commit, and ~23,000 repositories ran it without changing a line. A SHA is
the content, so what runs is what was reviewed. `npm install -g npm@11.19.0` carries an exact version
for the same reason, being the one dependency in that job with no SHA to carry.

The cost is that a pinned action never updates itself, and GitHub's docs state that Dependabot "will
not create alerts for actions pinned to SHA values" — so security alerts do not reach them either.
`.github/dependabot.yml` is what closes that: one grouped pull request a week that moves the SHAs and
the comments together.

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
  isActive: boolean;         // mtime within the active window (default 5 min)
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
session can be missing from exactly one poll. Anything IRREVERSIBLE must therefore wait for a
second reading: `known` in `sessions.ts` is never pruned on a blink, and ending a tab (one-way:
it drops the live subscription and freezes the graph into its ended presentation) goes through
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

**A session blocked on the user.** Claude Code writes `status: "waiting"` into the PID
file the moment it raises a dialog, with a `waitingFor` label saying which one, and
clears it when the dialog is answered — so the state is self-healing and needs no
event. seedeep keeps the label raw here and decides in the client
(`sessions.ts` `pendingInput`) which ones mean *the agent is stopped on you*:
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
just yields no events). It uses an explicit whitelist — only assistant lines
produce events; setup and bookkeeping line types are ignored.

The parser is also the single **anonymization barrier**: every session-derived
string it puts on an event (a tool's argument, a subagent's launch prompt, the
verbatim output a subagent returned) passes through `anon()`, which strips real
home paths (`/Users|/home/<name>` → `~`, and the slug-encoded `-Users-<name>`
form), the scratchpad root (`/private/tmp/claude-<pid>` → `~scratch`), uuids
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

Since `isOpen` is `isOpen ?? isActive`, whenever the open-session mechanism answers at all
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
(e.g. `usage` + `attribution` + `tool-start`) shares one `seq`. The client dedups
the live/replay overlap **per `(sessionId, agentId)`** — one position per file,
since the parent and each subagent child restart `seq` at 0. Because a line is
several events, that position is not one number (`apps/server/src/client/replay.ts`):
`covered` is the last line a replay delivered ENTIRE, so a live event at or below
it is a re-delivery (`seq <=`); `liveMax` is the live frontier, a line possibly
delivered only in PART, so live drops only what is strictly earlier (`seq <`) and
all events of the newest line pass; `liveSeen` counts how many events of that
frontier line did arrive. A replay in flight is measured against a SNAPSHOT of
that position taken when it opened — measuring against a mark the same replay is
advancing drops every event of a line after its first. Out-of-band events with
`seq < 0` (a `subagent-meta` read from `meta.json`, which has no line position)
are exempt from the dedup; the reducer folds them idempotently (see *Replay* and
*The GUI shell*).

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
- **`local`** — a command that closed without burning a single token and without an Esc
  (`/model`, `/effort`). No list of local built-ins is kept anywhere: the token count is the
  proof, and it cannot go stale as Claude Code adds commands.
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
consumed a token. Otherwise a `/model` — which opens an entry and is never closed by a
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

```
watcher (EventEmitter) ──▶ server ──▶ browser
                            │  ├─ GET /                static page
                            │  ├─ GET /api/sessions      roster CATALOGUE — every session, stable half (JSON)
                            │  ├─ GET /api/live          roster LIVE half — running sessions (JSON, polled)
                            │  ├─ GET /api/digest        live DERIVED state per live session (JSON, polled)
                            │  ├─ GET /api/session-stats per-session turn count (JSON)
                            │  ├─ GET /api/stream        live events (SSE)
                            │  ├─ GET /api/replay        one session's history (SSE)
                            │  ├─ GET /api/tool-output   what one tool returned (JSON)
                            │  ├─ GET /api/call-io       one API call's input+output (JSON)
                            │  ├─ GET /api/commits      the commits this session produced (JSON)
                            │  ├─ GET /api/files        the files touched by those commits (JSON)
                            │  ├─ GET /api/cards        the tracker cards it worked on (JSON)
                            │  ├─ GET /api/agent-prompt  one subagent's opening prompt (JSON)
                            │  ├─ GET /api/baseline      the user's per-turn token baseline (JSON)
                            │  ├─ GET /api/retro         the minute-zero corpus retrospective (JSON)
                            │  ├─ GET /api/compare       weight per session, by time window (JSON)
                            │  └─ GET /api/search        sessions whose dialogue holds every word (JSON)
```

Session data is deliberately one-directional: the server only ever pushes it to
the browser, and nothing seedeep reads is ever written back. The browser does
POST two things — `/api/config` and `/api/restart` — and both
act on seedeep's OWN state (its config file, its own process). The invariant is about the corpus, not about the socket.

### Session roster — `GET /api/sessions` + `GET /api/live`

The roster is served in **two halves, split by how fast each one changes**. Both
are plain reads, not commands, so neither breaks the one-directional rule.

- **`GET /api/sessions` — the catalogue.** Every discovered session, but only the
  fields that stop changing once its file exists: `sessionId`, `project`, `model`,
  `subject`, `entrypoint`, `root`, `path`, and `lastActivity` *only when the
  session is not live* (`null` while it is). It changes when a session is born, so
  the client fetches it once at boot and revalidates it with an ETag.
- **`GET /api/live` — the volatile half.** `{ total, sessions, pidVisible }`: the
  live sessions as complete `SessionRecord`s, the size of the catalogue, and
  whether `~/.claude/sessions/` answered this scan. This is the **only thing the
  browser polls** (every 3s).

`apps/server/src/core/roster.ts` owns both projections and the merge that rebuilds the whole
(`toCatalogue`, `liveOf`, `mergeRoster`); the client reassembles inside
`createRoster`, so every consumer above it still receives one plain roster.
`mergeRoster` recomputes `isActive` from `lastActivity` and re-sorts by it,
because both are derived — the split must not transport what it can derive, nor
freeze an order that keeps moving.

**A catalogue record taken while its session was live is PROVISIONAL.** Its
`subject` can predate the first prompt, its `model` the first API call, and its
`lastActivity` is `null` by construction. So the client refetches the catalogue
on either of two signals, not one: the count changed (a session was born), **or**
it holds a provisional record for a session the live payload no longer lists (a
session ended). Size alone cannot see the second — a finished session keeps its
file — and keying on it served the birth snapshot for as long as the page stayed
open, reverting a picker row from the prompt text to the bare session id the
moment its session finished.

`createRoster` serves fresh rows from every poll but notifies only when the
identity key changes: `current()` feeds `openFromDropdown`, so a row parked
behind an unchanged key becomes a stale tab, while `onChange` redraws the picker,
so firing it on every moved mtime would redraw forever.

**Every reading runs under a deadline (10s), and it is the poll's own liveness
that depends on it.** The next poll is armed when the current one settles, and
`fetch` has no timeout of its own: a request sent down a half-open connection
settles *never* — the browser has nothing to retransmit, so it waits for an
answer that cannot come. Measured on a silently cut path: 12 readings started,
11 settled, and no 13th ever, neither during the outage nor in the minute after
the network returned — the picker, the busy dot, ended-detection and auto-open
all frozen with it, until the page was reloaded by hand. On expiry the request
is aborted (a poll every 3s would otherwise pile up sockets nobody will answer)
and the reading fails into the existing "keep the last good roster" path. 10s is
~270x the slowest reading measured on a real corpus (37ms, a cold catalogue of
1200+ sessions), so it cannot fire on a machine that is merely busy.

The deadline changes what a failed FIRST reading means, and the workspace
depends on it: boot used to wait forever, and now it proceeds with no rows — so
nothing restores. `persist()` therefore refuses to write while `readings()` is
0. Without that, the first click after such a boot would save the empty tab set
over the workspace the user actually had, permanently rather than for that load.

**Why split at all.** Measured on a real machine (1086 sessions, 2 live): the
whole roster was 548 KB and was polled every 3s — **1.46 Mbps per open portal,
15 GB/day**, growing with every session ever written, to deliver a payload where
one record of 1086 had changed one field. The live half is ~1 KB. Each additional
client (a second browser, a device on the LAN) paid the full price again.

The contract that keeps this safe is `mergeRoster(catalogue, live) === roster`,
asserted in `apps/server/tests/roster.test.ts` against both fixtures and a **real** roster
from the machine running the tests.

### Live digest — `GET /api/digest`

Everything above the browser needs it to own the reducer: `/api/stream` and `/api/replay`
carry `NormalizedEvent`s — parsed lines, not meaning — so a client that wants to know what
a session is DOING has to fold them itself. The digest is the answer for a client that
cannot: **derived state, already cooked, one entry per live session.**

**One endpoint, two scopes — and one entry shape.**

- `GET /api/digest` → an array, one entry per live session.
- `GET /api/digest?sessionId=<id>` → the same entry, for one session. 404 when that session
  is unknown or has ended.

An entry carries identity (including `entrypoint`, so a client can tell an interactive session
from a headless `sdk-*` run — the tray shows only the first), liveness, main-agent
fill/window/pct **and model**, token totals, the current turn, whether the session is BROKEN
(`error`), and the subagents — `running` with the rows to draw them, plus **`launched`**, how many
the session has started over its whole life. The two answer different questions and the second
outlives the first: once the last agent returns, `running` is 0 and a client reading only it says
the session used none. A Workflow run contributes its MEMBERS to `launched`, not the one row it
takes in the browser, and a launch **still running** with no trace of itself is not counted — the
`hasStarted` rule above, which `launched` applies only to that case: an agent that reached a
terminal state is counted whatever it left behind, because its outcome is the record that it ran and
demanding a second one would undercount finished work. The turn
carries state, prompt head, the **efforts** its calls reported, and **`now`** — the one thing to say
about it. Two fields serve the sessions that are NOT working: `lastActivity` (the transcript's last
write — what a quiet session has instead of a NOW) and `pendingTool`.

**`turn.now` is `nowLine`'s answer, not a second one** (`apps/server/src/core/activity-line.ts`).
The browser's NOW panel calls that same function on the same inputs, so the rule about what a
session is doing exists ONCE for both surfaces. It reports `kind` (`waiting` | `activity` |
`intent` | `output` | `working` — which also says whose voice it is), the portal's own `label`, the `text`
**markdown-stripped and then cut** to the prompt's head cap (the digest exists for clients that
render no markdown and have no modal to open the full text in), and `ageFrom`: the instant an age
counts from — the running call, the narration, or the block — never a duration, which would expire
in flight.

**A working turn is never mute.** The precedence is: the block on the user, then what the turn has
DONE (once its last word has had its reading time), then that word — and, when there is none of
that, `working`: seedeep's own voice on a turn that is running while saying nothing. It covers two
real shapes, measured over 3064 turns: a round that hands everything to a background agent (a
forked skill like `/code-review` writes ONE line into the parent transcript and then nothing for as
long as its review runs — 12m 33s, worst measured), and the 12.3% of turns that use no tool and
narrate nothing, producing only their final answer a median 22.1s later. What is delegated is
answered by `delegatedWork` (`core/graph-derive.ts`), which lives beside `displayState` so the
panel and the Subagents card cannot disagree about what is running. Silence remains for the one
turn that has nothing happening: a local built-in (`/clear`, `/model`) that never called the model.

**And "right now" is answered by the PROCESS, not by the file** (`turnIsWorking`,
`core/graph-derive.ts`). Claude Code flushes a thinking block only when it CLOSES, so the parent
transcript is silent for exactly as long as the model thinks: measured over 321 real background-agent
returns, the file says nothing for a median 11s after one comes back (p90 33.1s, max 4m 5s), and
every turn is mute for a median 10.2s before its first API call. Read from the transcript alone,
seedeep called a session finished while the terminal showed it thinking. So the LAST turn of a
session whose `status` is `busy` (`isModelBusy` — NEVER `shell`, which Claude Code writes for a turn
that is already over while a command it launched runs; the tab dot reads `isWorking`, which does
count it, because the SESSION is busy then. Seeded at tab open, since the roster only notifies on
CHANGE) is working, whatever the file says — the same
principle already established for the session's own liveness. Only the last turn: an older entry is
history whatever the process does. Every surface that shows liveness reads that one function — the
panel, the timeline strip's `lv` class, the banner's live counter, and the digest's `turn.state`.

In that window NOW says what is true and no more: the agent is back, the turn has not spoken yet
(`/code-review returned — working on the result`, aged from its return). What the session is doing
with the result is not on disk, so seedeep does not claim to know it.

An agent a turn launched also counts as that turn WORKING: liveness and `kind` read the work the
turn caused, not only this thread's calls — otherwise a `/code-review` reads as a closed local
command, uncounted in `turns` and unjudged by the verdict, for exactly as long as its review runs.
A `/model` still cannot qualify: it launches nothing. "Running" means the same thing on both sides
of that split — the reducer's own check carries `hasStarted`, so a launch with no trace of itself
is not work in progress for the reducer while being `unknown` to the view. The Trace does NOT read
`TurnKind`: it infers its own from the event and knows nothing of `agent-launch`, so a delegated
round still collapses to one idle line there.

The one input the endpoint supplies itself is **when the server SAW the turn's last word**
(`live-trees.ts` stamps it, and **only for a line that arrives live** — what the seed replays is
already on disk and has already been read, so it earns no hold; stamping it made a restart hand the
line back to a narration the count had replaced). It cannot be read off the line: Claude Code
stamps a text block with the moment it started generating it and flushes the line 7-9 s later, so a
hold counted from the stamp is half spent before there is anything to show. Each observer therefore
passes its own sighting into the shared rule — the browser its own, the digest the server's — and
history replayed at startup, stamped `now` against timestamps hours old, correctly earns no hold.

**`error` — the session's last model call FAILED.** Non-null while that holds, carrying the failure's
`status` (often absent: only 18 of 47 real errors have `apiErrorStatus`, which is why the parser keys
on the `isApiErrorMessage` flag instead), the `message` Claude Code showed the user, the instant `at`,
and `agentId` when it was a subagent's call rather than the main thread's. One derivation
(`TreeSnapshot.error`) feeds this field, the tray's red icon and *Broken* band, and the portal's tab
LED — so no surface can decide on its own that a session is healthy.

**It is a STATE, cleared by the next call that reaches a model — never by time.** That is what the
logs say, not a policy: over 1830 real transcripts, 39 of 47 failed calls were the last model line
their session ever wrote, and no recovery came within 10 s (median 5.7 min, i.e. a human retried).
Claude Code's in-flight retries are never written; what lands on disk is the final error the user
saw, and the closest two in any one transcript are 125 s apart — so a client keyed on this field
cannot flicker. Another `<synthetic>` line does not clear it (an auto-continue writes
`"No response requested."` with no model at all), and a subagent's failure sets it for the reason it
matters: 8 of those 47 were a child's, 7 of them rate limits a fan-out hit while the main thread
still looked healthy.

**`background` — what the session is still waiting on that is not the turn, and what went wrong.**
Every command it launched in the background and has not been told the fate of, PLUS the last three
that **failed**: the launch call's id, the name the launch gave it, the instant it started (the age
is the client's to compute, like `now.ageFrom`), its `state` — only ever `running` or `failed` — and
`ranMs`, how long the command itself ran, null while it still is. One derivation
(`backgroundCommands`, `core/selectors.ts`) feeds this field and every browser surface, so nothing
can disagree about what is still running.

**The failures are where the two clients differ, deliberately.** The browser's live card draws none
of them — it lists only what is live — and counts them all in one line that points at its catalogue.
The tray has no catalogue to point at: its band is the whole surface, so the last three failed
commands ride along as rows, red and not amber, with the time they RAN rather than a ticking age.
The cap is on the ROWS a poll carries, never on the count a browser shows. **Open means launched and without an `outcome`** — the launch receipt closes in milliseconds,
so nothing about the call itself can answer it. What ends one is its notification; 9 of 107 real
launches (8.4%) never sent one, so an entry can outlive its command for as long as the session
lives, which is deliberate: a timeout would be a number seedeep invented to declare something
finished that nothing declared finished.

A command that finished CLEANLY is never here: it is not news, and a field carrying it would be a
log rather than a signal — the whole session's commands are the browser's catalogue, not the poll's.
Until 2026-08-08 the failures were not here either, and that was the bug: a command that failed
LEFT this array the instant it failed, so the tray's list simply got shorter and nothing said why.

The subagent list used to be gated behind `?sessionId=`, to keep the polled array bounded.
It is not any more: the **tray draws the agents themselves and polls only the array form**,
so gating it there meant the fact did not exist for the client that needed it. Boundedness
comes from the work instead — the list holds only agents that are RUNNING, which is none of
them for most of a session's life. `running` always equals `list.length`, so a count and its rows
can never disagree.

**An entry is a JOIN, not a second derivation** (`apps/server/src/server/digest.ts`). The liveness
fields (`status`, `waitingFor`, `waitingSince`, `subject`, `project`) are the roster
record's; everything else is read off the live tree's snapshot. Each fact has exactly one
source, so no field can be computed one way here and another way in the browser — if one
ever is, this endpoint has gone wrong.

**`pendingTool` — naming what a session is stopped on.** Claude Code's own label for a block
is generic: the process file writes `waitingFor: 'permission prompt'` and says nothing about
which tool raised it. What can name it is the transcript. The reducer exposes
`snapshot().openCall` (the newest MAIN-session call with no result yet; subagent calls are
excluded, they are their own lane's business), and the digest joins it with the roster's
`waitingFor`: **`pendingTool` is non-null only while the session is actually blocked.** Outside
a block the same open call is ordinary work, which `turn.now` already counts — a field
that filled up whenever anything ran would make an amber "needs you" band fire on every Bash.

**Whether the call is on disk during its own approval is NOT DETERMINISTIC — do not depend on
it.** This section used to claim CC "writes the `tool_use` line BEFORE raising the dialog, so
the call is already on record and pointing at it is a fact, not a guess." Three measurements on
2026-07-30, sampling real `Bash` approvals at 5 Hz and reading the file directly, disagree with
that and with each other:

| Approval | What the disk held |
| -- | -- |
| 31.2 s wait | began with **zero** open calls; the `tool_use` line appeared **0.2 s in** |
| 46.5 s wait | began with zero, and the line **never appeared at all** before it was answered |
| a third | line still missing **2.9 s after its own timestamp** |

Every wait began with nothing on disk, and only sometimes did the call show up. `Write` has been
observed to name its call reliably, but on a handful of trials — not enough to make it a rule.

The consequence is what matters and it does not depend on which row you read: **the transcript
cannot be depended on to name a call that is being approved**, so `pendingTool` is null for part
or all of many waits, the browser and the tray fail identically, and neither is at fault. Naming
it reliably needs a source that is not the transcript — a `PreToolUse` hook, which the official
docs state fires *before* the permission dialog and carries `tool_name`, `tool_input` (`command`
for Bash) and `tool_use_id`. Not built yet.

`pendingTool` is also null when the wait has no call behind it at all (a plan approval).

`pendingTool` is also null when the wait has no call behind it at all (a plan approval): a
client then says only that the session is waiting, and is never handed the last unrelated tool
that happened to be open.

**The trees it serves.** `apps/server/src/server/live-trees.ts` holds one session tree per live
session: seeded by `streamReplay` from the file, then advanced by the watcher's events, and
**dropped the moment `isLive` goes false**. Nothing polls — a tree is built when the first
consumer asks and evicted from the live set that same request already computed, so an idle
process gains no cost. The contract is an equality: *a tree advanced live equals the tree
the same session produces when replayed whole*.

The replay→live seam is deliberately NOT the browser's (`src/client/replay.ts`). Its three
marks exist for one fact of the SSE transport — each event is its own frame, so a connection
can die inside a line. In-process a line arrives whole, because the watcher emits all of its
events in one synchronous loop. What remains is a single mark frozen at the handoff: a
file's history can be re-delivered exactly once (the watcher's first pump of a file starts at
offset 0, which happens when a session goes live between the last discovery and the seed),
and everything the seed read sits at or below that mark. Because the mark never advances, a
line beyond it never loses its sibling events.

**No cap, on anything.** Not on sessions, not on subagents. Claude Code's Workflow caps
concurrent agents at `min(16, cores - 2)`, so 16 genuinely running subagents is a legitimate
case, and a limit taken from one machine's logs would hide a defect rather than bound a
payload. A Workflow run's still-running members are counted and listed individually: the run
takes one row in the browser because expanding ~100 children would flood a list, but a COUNT
is not a list, and answering "16 agents are working" with `1` would be false.

**A closed session leaves immediately** — no grace period, no tombstone entry, no `endedAt`
to age out. A client that wants to keep showing a session that ended while its panel was
open holds the last entry it polled: the server derives, the client remembers.

**Nothing is served that the browser needs.** `/api/live` is unchanged and stays the
browser's, and the browser does NOT switch to the digest: it re-derives per interaction
(`spanStore.snapshot(scopeTurn)` scopes the Trace locally), and moving that server-side would
turn instant interactions into round-trips.

### Session stats — `GET /api/session-stats`

Per-session **turn count** from the aggregate cache, returned as a JSON object keyed by
`sessionId`: `{ [sessionId]: { turns: number; totalTokens: number } }`. Used by the
session picker to annotate each row with `· N turns`. The endpoint triggers an incremental
cache refresh (same as `/api/retro`) so the data is always current, then joins the results
with the roster to map file paths to session ids. Sessions not yet in the cache are absent
from the response; the picker renders them without the count until the cache warms up.

**Why only turns and not tokens in the picker.** The aggregate cache processes one file at a
time (the main session file), so `totalTokens` is main-session only — it does not include
subagent tokens. The Session card hero, however, shows main + subagents combined. The two
figures never agree on sessions that ran subagents, so the picker shows only the turn count,
which is unambiguous.

### Live events — `GET /api/stream`

It also carries the one event the watcher does NOT emit: **`notification`**, the
server's own verdict that something is worth interrupting the user for. The
transition detector (`notify-watch.ts`) folds each reading of the digest and the
engine (`notify-engine.ts`) gates its output per channel — the tray subscribes
here, a configured webhook is POSTed to instead. The switches filter that output
and never the detector's input, so turning one back on announces what happens
next and not the backlog it slept through. Evaluation is skipped entirely when
nobody is subscribed and no webhook is configured, which is what keeps a process
nobody is watching idle.

A **single multiplexed** Server-Sent Events stream. Every event the watcher
emits, across all active sessions, is framed and pushed on this one connection,
each frame carrying its `sessionId`; the browser demultiplexes by session. One
stream — not one per session — means opening or closing a view is pure
client-side state and never leaks a connection. The stream opens with a comment
line so the browser's `EventSource` connects immediately rather than blocking on
the first real event.

**Staying connected is not free** — the earlier claim that "SSE gives automatic
reconnect for free" was measured and does not hold on its own. Four mechanisms
make it true, and each covers a failure the others do not:

- **Heartbeat.** Every 15s the server writes a `heartbeat` event to each client.
  A session can be silent for minutes (a background subagent writes only to its
  own file), and a connection carrying nothing looks exactly like one that has
  died — so the page would wait forever on a stream nobody is writing to. It is
  a named *event* and not an SSE comment: a comment reaches the socket but never
  the page, and the client's watchdog below has to be able to hear it. It
  carries no `id:` line, so it never shifts the numbering of the real events.
- **A failed write closes the stream.** Evicting the dead client from the
  registry was not enough: the browser was never told, so its `EventSource`
  stayed `OPEN`, fired no error and never reconnected. `ClientRegistry` now
  closes the controller, which ends the response — the only thing the browser
  can act on.
- **The client owns its reconnect.** `EventSource` retries by itself only while
  it is still `CONNECTING`; a fatal error leaves it `CLOSED` for good.
  `stream.ts` watches `readyState` and rebuilds the connection, and reports
  every transition through `onStatus` (`open` / `lost`) — the header pill is the
  only thing on screen that speaks about the connection, since a card's `live`
  badge reports whether the SESSION is running.
- **Silence is a verdict the client reaches on its own.** The three above all
  assume something *fails*. When the network path drops without a FIN or an RST
  — a host that goes away — nothing fails: an SSE connection only ever RECEIVES,
  so its TCP has nothing to retransmit and never learns the peer is gone.
  Measured on a silently cut path: 90s, six missed heartbeats, `readyState`
  still `1` (OPEN), zero `error` events, and no recovery even after the network
  came back. So `stream.ts` times the silence itself: once nothing has arrived
  for `staleMs` (45s — three missed heartbeats) the connection is declared lost,
  closed and rebuilt. The check is periodic (`staleMs / 3`), not an alarm set on
  the last frame, so the verdict lands **between 45s and 60s** — measured ~57s.
  It covers a connection that is merely `CONNECTING` too: a socket whose
  handshake completed and whose response never came does not error either (its
  request was acknowledged, so TCP has nothing to retransmit) and `EventSource`
  retries only *after* an error. While the path stays down the window restarts
  on each attempt, so the retry is one per window, not one per tick. A
  backgrounded tab throttles the check to about once a minute and freezes it
  after a few minutes, which delays the verdict but cannot change it — the test
  is against the clock, not against a number of ticks — and returning to the tab
  re-asks immediately (`visibilitychange`).

**A reconnect leaves a hole, and the client closes it by asking for the tail.**
Nothing re-sends what was emitted while the connection was down (`Last-Event-ID`
is not honoured; frames are numbered, but the server keeps no backlog). A tab
that kept its reducer would therefore keep painting, silently short of the
truth. So on a reconnect every LIVE tab calls `resync()`: it knows its own
position in each file — `seq` IS the line index — and asks
`/api/replay?…&from=<key:seq,…>` for only what it is missing, folding the tail
into the reducer it already has. No teardown, no re-read of the session, nothing
to look at. Ended tabs are left alone; the stream cannot change their history.

What it asks from is the last line it holds COMPLETE, not the last it has seen:
each of a line's events is its own SSE frame, so a connection can die between
two of them. Asking past a half-received line loses its tail for good; asking
before it re-delivers the head already applied, and `usage` is SUMMED — a
doubled head is a corrupted total. So the resync asks from the line before the
frontier and skips the `liveSeen` events of it that already landed. A resync
raised while a read is still in flight is DEFERRED, never dropped: that read
reached the file's end when it was *requested*, i.e. before the outage, and
nothing else re-arms it (`app.ts` clears `feedWasLost` before the loop).

Rebuilding the tab instead (destroy the reducer, replay from scratch) was also
correct and was tried first — but it visibly re-drew the dashboard, and one
measured environment interrupts the stream every 2-3 minutes, which turned a
correct repair into a page that appeared to reload on its own.

**A read that goes quiet is handed off too, for the same reason the live stream
is.** `finish()` — the one thing that flushes the buffer and lets live through —
was reachable only from `replay-end`, an `error`, or `stop()`, and a silently cut
path produces none of them. Left alone, every live event went into `buffer` and
none came out, while `resync()` became a permanent no-op (a read was still "in
flight"), so the tab froze behind a healthy-looking stream. A read that has
delivered nothing for 30s is therefore finished as if it had errored. The
deadline is on SILENCE, never on duration: a big session takes a long time but is
never quiet — the endpoint is pull-based, one frame per `pull()`, and the worst
gap measured on the largest local session (30.8 MB, 446 chunks) was 6ms. Handing
off early can leave the history short, which is the cheaper wrong: the next
resync asks from the mark that read did reach, while buffering forever has no
exit at all.

Per-file `seq` is what both dedup guards compare against, and it is a line's
POSITION in its file, not a counter — see the watcher's `tick()` for the
in-flight guard that keeps it so, and why a drifted `seq` froze the page for
good.

### Replay — `GET /api/replay?sessionId=<id>`

A read-only SSE stream that replays one session's history. It reads that
session's `.jsonl` from the start to end-of-file, emits the same normalized
events as the live stream (each with its per-file `seq`), then a final
`replay-end` frame, and closes. Unknown session ids get a `404`; a file that
vanishes mid-read still ends cleanly with `replay-end`. Like the roster and the
live stream it is a plain read — no browser→server channel is introduced.

**`&from=<key:seq,…>` turns it into a resync**: the caller states how much of
each file it already holds (`key` is a subagent's `agentId`, empty for the
parent) and gets only what comes after. Three rules make it safe:

- **A skipped line still consumes its index.** `seq` is a position, so a tail
  numbered any other way would corrupt the high-water it is answering.
- **A file with no mark is replayed WHOLE** — that is how a subagent born during
  the outage arrives complete.
- **A mark filters LINES, never the out-of-band events.** `subagent-meta` and
  `workflow-agent` carry no `seq`, so no high-water can speak for them, and the
  live path emits them from sources a line mark knows nothing about: a
  subagent's meta goes out in two independent halves (the sidecar link, retried
  until the file exists; the model, the first tick one appears), and a workflow
  `result` is the only record that an agent stopped working. Any of those can
  fall inside the outage and would then never be re-sent — a subagent left
  unlinked from its spawn, or running forever. They are re-sent to a marked
  caller too; the reducer merges metas non-destructively and keeps run phases in
  Sets, so a re-send changes nothing. The two exceptions are the immutable
  facts a marked caller was necessarily already told: a run's membership
  (`phase: 'seen'`) and its `started`.
- **An unreadable `from` replays everything.** Withholding history on a guess is
  the failure this endpoint exists to repair — so a mark is read only as plain
  digits: `Number('')` is `0`, and a mark of 0 would withhold a file's first
  line on the strength of an empty string.

### Tool output — `GET /api/tool-output?sessionId=<id>&toolUseId=<id>`

What one tool actually returned, read back **on demand** from the session's own
files (the main `.jsonl`, then its `subagents/agent-*.jsonl` children, where a
subagent's tools report). The client keeps only each tool's output *size*: a
session's tool outputs together — every `Read`, every `Bash` — are far too large
to carry in the browser, so the drawer fetches the one output it is about to show.
The text is anonymized (`apps/server/src/core/text.ts`, the same function the parser applies) and
capped at 20k chars, while `len` reports the output's true size, so the UI can say
"41k chars (first 20k shown)" rather than implying it has all of it. The path
comes from the roster, never from the query: an unknown session, an unknown tool,
or a tool that has not reported a result yet all get a `404`.

**One thing the drawer derives from that text**: an `Artifact` call's result names the page it put
online (`Published <file> at <url>`), and the drawer inserts a `Published at` block above the raw
output with that URL as a real link — built as DOM nodes, never `innerHTML`, because a tool's output
is arbitrary text a command printed. It is claimed for the tool as well as the URL: only an
`Artifact` call published anything, so a `Bash` that happens to print an artifact link gets no
block, and neither does the `action: "list"` form, whose result carries no URL.

### API call I/O — `GET /api/call-io?sessionId=<id>&callId=<id>`

One API call's full **input and output**, read back **on demand** from the same
files as tool output (`apps/server/src/server/call-io.ts`). An API call is a `message.id`: its output
is that message's text/thinking blocks plus the tools it called (name + args); its
input is the delta that triggered it — the nearest non-injected (`isMeta`) user
line before the call, a prompt or the tool results just returned. Both sides are
anonymized and capped at 20k chars (`len` reports the true size), and the response
also flags `outputHasTools` so the viewer renders a tool-call output verbatim
rather than as markdown. The client holds only each call's token totals and a
short input hint, so the drawer fetches the full I/O just for the call it is about
to show. It also returns `narration` — the call's mid-turn text, i.e. what the
model said it was about to do (`null` on the call that closed the turn, whose text
is the ANSWER, not a plan). That text is inside `output` too, but a call with tools
forces `output` into verbatim rendering, so the one part meant to be read as prose
was read as a dump; split out, the drawer gives it its own block and renders it as
markdown. It is the same string the Trace names the round with (`docs/trace.md`). Same guarding as tool output: the path comes from the roster, and an
unknown session or call id gets a `404`.

### Session commits — `GET /api/commits?sessionId=<id>`

The commits that session produced, newest first, each with the URL of its page on the forge
(`apps/server/src/server/session-commits.ts`). Together with `/api/cards` — which resolves the
repository of a forge issue the same way — these are the only endpoints that touch the user's
repository, and they read only: `rev-parse`, `log`, `remote get-url`, `rev-list`. A session that
never ran `git commit` returns `{commits: [], remote: null}` without touching a repo at all —
639 of 783 local sessions.

Attribution is proof-first: the commit's hash in the output of that session's own `git commit`
call, falling back to the subject inside a command within ±120 s, and exclusive across every
session sharing the repo and the window. The full rules, and the measurements behind them, are in
`docs/commits.md` — keep the two in sync. Same guarding as the other read-back endpoints: the
session comes from the roster, an unknown id gets a `404`.

### Session tracker cards — `GET /api/cards?sessionId=<id>`

The tracker cards that session worked on, newest touch first, each with the title and the URL its
own tool call returned (`apps/server/src/server/session-cards.ts`). Transcript-only for an MCP
tracker — no network call, and no tracker host hardcoded anywhere; a forge issue additionally
resolves the session's repository, the same way the commits endpoint does, unless the command named
one with `-R/--repo`.

The evidence is an ACTION: `wrote` when the session changed the card, `read` when it only looked. A
key typed in a prompt is never enough — 27 of the 36 key-shaped prefixes in this corpus name no
tracker. Unlike commits, the relation is many-to-many: the same card may be returned for several
sessions. The full rules and measurements are in `docs/cards.md` — keep the two in sync. Same
guarding as the other read-back endpoints: unknown id gets a `404`.

Both this and `/api/commits` consume ONE cached pass over the transcript
(`apps/server/src/server/transcript-scan.ts`), so whichever runs second reads nothing.

The inverse (`/api/search` with a card id) is answered from `apps/server/src/server/cards-index.ts`,
a persisted id index built from this same endpoint's function — same shape and same lifecycle rules
as the session-search index next to it, and refreshed only when the query looks like an id.

### Personal baseline — `GET /api/baseline`

The user's own per-turn token distribution — the p50/p90/p95 **overall and per-effort**
(`byEffort`), so a `high`-effort turn is judged against other `high` turns, not the
98%-`unknown` mass. The figure is a turn's **work** tokens: `input + output + cache_creation`
(the NEW tokens, excluding cheap cache re-reads) **minus what the turn spent re-entering its own
context** (see the resume detector below). Leaving the resume in inflated the bar every other turn
was measured against — measured, `unknown` p90 100 947 → 75 748 and p95 189 483 → 114 934 once it
was taken out. It is the `baseline` field of the corpus
retrospective below — one scanner serves both — so this endpoint is just
`(/api/retro).baseline`. **Descriptive only**: no detector reads it (see the verdict below) —
the share card uses it to place a turn against the user's own history.

### Aggregate cache — `GET /api/retro`

The **minute-zero retrospective**: corpus-wide aggregates shown on the Home surface at launch,
without waiting for a live turn — median turn, total tokens spent, API calls, tokens abandoned
to Esc, wasteful turns, turns that ended with the context ≥70% full, large subagent outputs,
mid-turn compactions, **cold resumes and the tokens they re-created** — plus how many sessions
spent **10% or more** of their tokens re-entering themselves, the share Claude Code's own
`/usage` flags at — working time, the turn-size distribution, tokens by model, tool
calls by type, the crit/warn/clean split, and a weekly activity cadence
(`apps/server/src/server/aggregate-cache.ts`). It runs the real parser + reducer + verdict per session, exactly like
the baseline.

**It reads each session's subagent transcripts too**, through `streamReplay` — the same event
stream the live watcher produces, so the cache's numbers and the GUI's cannot diverge. Reading the
parent alone left **35.3%** of the corpus's billable tokens out of every aggregate (p90 24.4% of a
single session, max 91.9%), because a subagent writes its own file. Invalidation therefore stamps
the children as well (`apps/server/src/server/subagent-files.ts`, `subagentStamp`): a child can be written when the
parent is not, and the parent's `(size, mtime)` alone would serve a summary missing that child.
Where those files live is defined once, in `subagent-files.ts`, and both replay and the cache read
it from there — including the Workflow run ids, which come from the directory rather than from the
transcripts found inside it: a run writes its `journal.jsonl`, the only record that a workflow
subagent started or stopped, before its agents' transcripts exist. Cold rebuild of the whole local corpus (1054 sessions): **2.4s**; warm: **47ms**.

The resume aggregate is the one reading a per-turn verdict cannot give: re-entry cost is a
function of the gap between turns and of how big the session's context grew, so it only means
something summed. Measured over the local corpus it is **27% of every billable token**, and the
median session spends 10% of its budget re-entering itself (p90: 49%). Home shows it in *where
the waste comes from* — a `resumed cold` row, and the token figure in the card's hint.

**Two token figures, on purpose.** `totalTokens` is the COMPLETE amount processed —
`input + output + cache_creation + cache_read` — the honest "tokens spent" (cache reads are
billed too, just discounted). Everything per-turn or per-model uses `newTokens`
(`input + output + cache_creation`, excluding cache reads) instead: a turn re-reads its whole
context every call, so including cache reads would swamp every turn with millions of identical
re-read tokens and destroy the size distribution. The UI labels the per-turn metric "new tokens",
never "billable". `tools` is all-time tool-call counts by
name (tools do not spend tokens — their outputs feed the next call — so a call COUNT is the
honest metric, not a token attribution).

`byModel` is **COMPLETE tokens per model** (new + cache reads — the figure the card prints beside
the bars), and it counts **subagents under their own model**, not under the thread that spawned
them: a Haiku explorer inside an Opus session is Haiku tokens. Until then the split read the turn's
main-thread model only, so a session whose subagents ran on Haiku and Sonnet still rendered as
"Opus · 100%" — the data was already there (`AgentNode.turnIndex`, `sumTokensByModel`), it was
simply never read at this level. Two consequences, both deliberate:

- **The window totals include subagent tokens too.** The bars have to sum to the total printed
  next to them, so `totalTokens` grew to match; `newTokens` grows by `TurnSummary.subagentNew`
  (input + output + cache_creation) rather than by the whole volume, or every subagent token would
  silently file itself as a cache read.
- **Charged to the turn that spawned them.** An agent carries the `turnIndex` it was launched from
  and `scopeToTurn` already narrows the Trace that way, so the 7- and 30-day windows stay exact.
  This is a weaker claim than the one `TurnSummary.weighted` still refuses to make: an unweighted
  token count, not an attribution of cost to a model's price.

The response carries **three time windows** — all-time, last 30 days, last 7 days — so the Home
dashboard's window filter switches instantly with no refetch. Each window has its own percentiles
(the KPI + histogram markers) and its own histogram. The weekly cadence is all-time (a window would defeat a
"your rhythm" chart) and sized to the corpus's real span. It returns the shared `baseline` too, so
`/api/baseline` is exactly `(/api/retro).baseline`.

**The weekly cadence uses CALENDAR weeks, Monday-anchored in local time** — index 0 is the week
containing `now`, back to the corpus start (capped at 26). Not rolling 7-day windows: those are
measured from `now`, so their boundaries slide between two refreshes and the same corpus draws
different bars minute to minute — and a Sunday turn shares a bucket with the following Monday's
whenever `now` sits midweek. Each week carries the three readings of the work done: the
`crit`/`warn`/`good` turn split, `tokens` (COMPLETE — incl. cache reads, matching `totalTokens`)
and `workMs`. The week index is computed by rounding the gap between Monday openings, because a
DST shift makes that gap 167 or 169 hours, never exactly 7 days.

A full corpus scan is seconds, unacceptable for a launch surface, so it is backed by a
**persistent, incremental** cache:

- **Per file, a small summary** — each closed *work* turn's baseline-INDEPENDENT facts
  (`billable`, `resumeCost`, `cacheRead`, `effort`, `model`, `apiCalls`, the `esc / escStreak /
  context / compaction / subWaste` flags, plus its `ts` and `durationMs` for the time windows and
  working-time total),
  and the session's tool-call counts by name. Keyed by path, invalidated by `(size, mtime)`; the
  cache version bumps when this shape changes, so an older cache is rebuilt.
- **The severity is STORED, not re-derived.** It was recomputed at aggregation for as long as one
  detector compared a turn to the *global* baseline — a stored value would have gone stale
  whenever any file changed — and that cost a second implementation of the worst-of rule inside
  the cache. Since the anomaly detector was removed (2026-07-27) every detector is file-local, so
  a turn's severity is a fact about its own file: `computeVerdicts` decides it once at summarize
  time and the windows just SUM it. One rule, one place.
- **A cached entry must carry the CURRENT shape, not just the current version number.** The
  version is a promise a human has to remember to bump, and forgetting it once shipped a
  retrospective of 0 crit / 0 warn read off a stale cache. So every cached turn is checked against
  `TURN_KEYS` on load and a file holding a turn of the wrong shape is re-parsed — and `TURN_KEYS`
  itself is compile-checked (`satisfies` + a `never` assertion), so adding a field to
  `TurnSummary` without listing it fails the build.
- **On refresh** the cache `stat`s every path, re-parses only those whose `(size, mtime)`
  changed, drops vanished ones, persists atomically (temp + rename), and aggregates — so even a
  cold start is milliseconds. The map is persisted to the gitignored, seedeep-owned
  `~/.seedeep/aggregates.json` (never a session file). This **supersedes** the old
  roster-length baseline cache: one scanner, no full rescan on every roster change, no stale
  entry when a session grows.

Still a plain read from the browser's side — no browser→server channel.

### Cross-session comparison — `GET /api/compare`

**Which session weighed the most** in a time window. Same cache as `/api/retro`, a different
question: the retrospective aggregates TURNS across the corpus, this one ranks SESSIONS against
each other.

The unit is a **weighted token count** (`apps/server/src/core/token-weight.ts`), never a cost in dollars.
Every API call is weighted twice and summed over the session and its subagents:

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

**A session's weight is whole-session, not Σ its turns.** `SessionSummary.turns` holds only CLOSED
WORK turns — right for a turn retrospective, wrong for a session total: an unclosed final turn, or
an sdk session (which never writes `turn_duration`), would contribute nothing. Measured
2026-07-28: summing the turns left **751 of 996** local sessions weighing zero.

**A session enters a window by its LAST ACTIVITY, and enters it whole** (`apps/server/src/server/compare.ts`). Not by
filtering its turns: the row compares sessions, and half a session shown as if it were the whole
one is a wrong number, not a partial one. 93% of local sessions span under an hour and 5 of 996
exceed a day, so the two rules disagree about a handful — and only this one can count a subagent's
weight at all, since that is a per-file total with no turn to attribute it to.

Each row also names the model its **main thread** ran on — the one holding the largest share of
`weightedMain`, subagents deliberately excluded (a Haiku explorer does not make an Opus session a
Haiku one), with a `+N` when the main thread used more than one, so the dominant model is never
presented as the whole truth. Dominance, not first-seen: a session that opens on one model and does
its work on another ran on the second.

Alongside the weight each row carries the session's **complete unweighted token total** —
`input + output + cache_creation + cache_read`, every model, subagents included — next to its API
call count. Two numbers in the same unit, one raw and one weighted, so the raw one names itself on
hover; cache reads are ~97% of it, which is exactly why the ranking cannot use it.

Each of the three windows (all / 30d / 7d) carries its totals, its by-model split, and its
**heaviest `COMPARE_TOP_N` sessions** (20); what the cut leaves out is returned as an aggregate
(`restSessions`, `restWeight`) and rendered, because a truncated leaderboard that says nothing
reads as "this is all of it". Every row carries **both** its rank by weight and its rank by
unweighted tokens, computed over the whole window before the cut — that pair is what lets a row
state how far the weighting moved it.

The unweighted rank is by `tokensComplete`, the very figure the row prints, and by nothing else. It
was briefly taken from the cache's turns-only `totalTokens`, which made the chip measure three
things while claiming one — the weighting, whether subagents counted, and whether the last turn had
closed — with 75.4% of compared sessions tied at 0 there. `apiCalls` had the same defect and is now
the whole-session count (`snap.apiCalls`): derived from the closed turns it read 0 for 52.1% of
sessions.

### Session search — `GET /api/search`

**Which session talked about these words.** Every whitespace-separated word is an AND term; the
response carries every match, with no top-N cut. Full rules, including what is indexed and why:
[`search.md`](./search.md).

What the corpus is, is the whole design: the **dialogue** — the user's prompts (a slash command
contributes its ARGUMENTS, never its `<command-name>` wrapper) and the assistant's text blocks —
never the raw transcript. Searching the raw jsonl matches roughly twice as often and wrongly: the
surplus is injected instructions, system reminders and tool results, text the session never said
(measured 2026-07-29 over 988 sessions: `subagent` 706 raw vs 350 in dialogue).

The index (`apps/server/src/server/search-index.ts`) is **its own file**, `~/.seedeep/search-index.jsonl`, incremental
on `(size, mtime)` and persisted atomically — the same contract as the aggregate cache, deliberately
NOT the same file: `aggregates.json` is rewritten whole on every retrospective refresh, and the
dialogue is ~20 MB of prose the retrospective never reads. It is refreshed on demand, when a search
runs, so it costs nothing until used. Measured: 19.5 MB of dialogue over 988 sessions, ~0.8s to
build cold, 17–40 ms per query. Scanning the transcripts per query instead costs a **2.0s floor**,
even for a query that matches nothing.

The endpoint returns rows, not a verdict: the index knows how WELL a session matches, only the
roster knows WHO it is, and `buildSearchRows` joins them — the same division `compare.ts` makes.
The Human/Automated split and the ordering are the client's, so switching either costs no request.

### Post-turn verdict

At the end of every turn, seven **deterministic** detectors (zero LLM) run over data the
snapshot already holds (`apps/server/src/core/verdict.ts`): a **wasted subagent** (a large output returned
to main — a heuristic lower bound), **compaction** mid-turn, a second consecutive **Esc**,
a cold **resume**, a **context** fill ≥70% of the model's window, an **exploration** (≥8 files
read into main with nothing changed and nothing delegated), and an **unverified ship** (real code
committed with no check run anywhere earlier in the session). The worst finding sets the turn's
severity (`good | warn | crit`). Measured over 2864 real turns: 5.6% crit, 10.6% warn, 83.8% good.

**No detector compares a turn to the user's other turns.** One did — a token anomaly against the
personal baseline's p90/p95 — and it was removed on 2026-07-27 because it reported SIZE, not
waste: flagged turns spent ~13× the tokens because they did ~13× the actions (median 38 tool calls
against 3), their tokens-per-tool-call was ordinary, and 55% of a turn's token variance is
explained by its API-call count alone. It was also the only detector with no anchor in the public
docs, and it had no remedy to offer the reader.

**Every detector cites a public source.** A rule defensible only by one user's private CLAUDE.md
is a rule written for one user, and seedeep ships to other people; the quote lives next to the
threshold in `verdict.ts`. Two consequences of applying that metre are worth stating here because
they are behaviour, not documentation:

- **A lone Esc is not waste.** `code.claude.com/docs/en/best-practices` prescribes it
  ("course-correct early and often"); the named anti-pattern is the streak ("after two failed
  corrections, `/clear`"). Only the **second consecutive** interruption is a finding, and the rule
  looks only BACKWARD — a turn that turns out to be the first of a streak IS a lone Esc at the
  moment it closes, and a forward-looking rule would make a finding appear retroactively on a turn
  already rendered. Measured: 127 of 176 interrupted turns are lone, so the old rule penalised
  correct usage on 72% of its own hits.
- **Same-file re-reads were removed.** The rule had no public anchor and 97.5% measured false
  positives (the tool arg is only the `file_path`, so N paginated reads of distinct sections of one
  long file look identical to going in circles).

**The context finding never guesses its denominator.** `turnFillShare` returns `null` when the
turn's model is not in `apps/server/data/context-windows.json`, and the detector is then skipped entirely — a
fallback 200k denominator once printed "170% full" on a session actually running at 1M.

**A compaction is charged what it really cost.** `compactionCost` = the tokens re-created inside
the compaction turn PLUS the rebuild the **next** work turn pays on its first call, because
compaction "invalidates the conversation layer" and the next request no longer shares a prefix.
Measured over 61 real compaction turns: median 49 577 in the turn and 28 121 on the next turn's
first call, against 119 on an ordinary turn — 36% of the total, previously attributed to nobody.
The tail is *reported*, not subtracted from the next turn's `turnWork`: unlike a resume, it stays
in that turn's basis (a product decision, 2026-07-27).

**A finding's `cost`, when absolute, is a PORTION of what THIS turn spent.** The share card sums
the absolute costs and divides by the turn's own billable, so anything else prints a nonsense
percentage. Four detectors broke the rule in four different ways and were fixed at the source, all
by moving the figure into the finding's TEXT: `context` carried the window's SIZE (a fill is
state, not spend), `wasted-subagent` carried the SUBAGENT's own volume (billed to its window, not
this one), `esc` carried the whole turn (not a portion of it — added to any other cost it
double-counts), and `compaction` carried its cross-turn tail (`compactionTail` exists for exactly
that split). Measured across the corpus: 54% of flagged turns printed over 100%, up to 122 097%;
after the fixes, **0%**, and the maximum is exactly 100. A single test asserts the invariant over
a turn built to trip every detector at once, so a new finding cannot reintroduce it.

**The verdict has a second face.** Alongside the findings, `TurnVerdict.positives` lists the
documented practices the turn followed — ran a check before committing, delegated the exploration
to a subagent, had its work reviewed by one. They never change a severity. The `reviewed` rule is
the ONE language-matched signal in the file (it matches the subagent's resolved title) and is
deliberately confined to a positive: the structural alternatives have no coverage (`agentType` is
null on every spawn measured), and a ~10% over-credit on a positive is cheap where the same
fuzziness on a penalty would not be. Measured fire rates: 6.4% / 11.1% / 5.4% of closed work turns.
"Shipped code" — the `verified` positive's precondition — excludes writes to the session
scratchpad, and asks `isScratchPath` (`apps/server/src/core/text.ts`) to decide, the same predicate the Changed
files widget uses. It used to be a word match over the tool arg (`scratch|prototypes?|/tmp/`),
which also caught project code merely NAMED like a throwaway (`src/prototypes/`).

**A turn's tokens are split before they are judged.** `turnResumeCost` is the first call's
`cache_creation` when that call re-created ≥80% of the prompt it ran on and the rebuild was ≥50k
tokens — the turn paying to re-enter a context it had already built, before doing anything.
`turnWork` is the rest, and it is what the baseline is built from. The thresholds are
measured, not chosen: over the corpus the first call's `cache_creation` is bimodal — median 168
tokens against 143 891 on the turns that rebuild — so the SHARE separates the populations and the
token floor only keeps a tiny rebuild out. The reducer supplies both facts (`TurnNode.firstCall`
and `rebuildExpected`), because neither can be derived downstream: `cacheTotals.created` sums the
whole turn, `breakdown` holds the last call, and only the reducer knows a rebuild was expected
(the session's first call, or a compaction). `resume` is `warn`. Keeping the two apart is what
stops a resume — median 6 tool calls — from reading as a turn that did enormous work.

**One computation per render.** `computeVerdicts(snapshot)` indexes the snapshot's
tools and subagents by turn in a single pass and returns every turn's verdict keyed by index.
`render()` calls it once and every surface reads that map, so two surfaces cannot disagree about
a turn's severity — and the per-turn `mainTools` scan (O(turns × tools) on every event while the
strip was open) is gone. `computeVerdict` remains for the single-turn case (the announce).

It surfaces in three places, all reusing existing surfaces — no new widget:

- **Announce** — a crit verdict pushes a non-blocking top-rail toast when the turn closes
  (`turn-end`, live only). warn stays silent in the toast; good is silent. The announced turn is
  the last **non-live** one, whatever its kind, and only if that turn is `work`: a `/clear` or a
  `/model` writes its own `system/turn_duration`, so keying on "the last non-live *work* turn"
  made those turn-ends re-announce the previous work turn. An index is announced at most once.
- **History** — the **Verdict** chip in the Timeline strip (`renderTurnExplorer` in `graph.ts`) is
  a LENS: it dims every unflagged column, attaches an underline to each flagged one (rose = crit,
  amber = warn) and lists one row per **work** turn. The headline is the worst finding, or — when
  there is none — the practice the turn followed, falling back to "nothing flagged". The body
  holds only what the headline does not already say: the remaining findings and practices, plus
  the lead finding itself when it carries a `cost` (the one thing the headline has no room for).
  A row with nothing left shows no chevron — it still scopes, and the chevron column keeps its
  width so the rows stay aligned. Severity is carried by the row's left stripe AND its label, both
  following the row's own tier, so a clean row is never painted as a crit one. The chip's number
  counts the FLAGGED turns (what to act on) while the list covers all of them, so the list states
  the split above itself ("Every work turn, judged: N flagged · M clean") — the jump from the
  chip's count to the row count otherwise read as a broken filter. Local (`/model`) and context
  (`/clear`) entries are skipped: they run no model, so there is no turn to judge. The chart
  carries no verdict decoration in any other view — the bars keep their single meaning (context
  moved), by state colour.
- **A row IS the scope.** Clicking a verdict row selects that turn — banner, chart and every
  widget follow it — and expands it; exactly one row is open at a time, and clicking the scoped
  row again returns to whole-session. The row therefore cannot show one turn while another is
  scoped, which is what made a per-row Share possible (see below).
- **Detail** — the scope banner of a flagged turn carries a **verdict chip** (severity dot + worst
  finding); clicking it opens the Verdict lens with that turn's row already expanded. Scoping into
  a flagged turn from anywhere else expands its row the same way.

**Share card** (`apps/server/src/core/share-card.ts` for the markup, `apps/server/src/client/share-card-png.ts`
for the pixels — a 1200×628 layout at `CARD_DPR` = 2, so the PNG is 2400×1256). **The page draws its
own card**: the markup goes into an `<svg><foreignObject>`, a data URL of that SVG is loaded into an
`Image`, and the canvas exports the PNG. There is no endpoint and no browser to install. It used to
be `POST /api/share-card`, rendered by a headless Chrome the server spawned through playwright —
a SECOND browser, launched to draw something the first one already had every field of, since the
client posted the whole payload and the server added nothing to it. Two details of the current path
are load-bearing and both were measured: the SVG must come from a **`data:` URL**, because one from
`URL.createObjectURL` counts as cross-origin and TAINTS the canvas (`toBlob` then throws and no
image is produced); and the markup may name only the five entities XML defines, so `&nbsp;` has to
be written `&#160;` or the image silently fails to load. The card is always read scaled — in the
preview box, in a timeline, on a HiDPI screen — so the resolution is part of the content: at 1×
every resample softened the text. For the same reason nothing on it is set below 12px and its
greys clear 4.5:1 contrast on the card background (`#61748f` did not, at 4.2:1); both are asserted
in `apps/server/tests/share-card.test.ts`, since either regresses without any visible error. Two surfaces offer it — every verdict row and the scope banner — and both build
it through the same `shareButton(turn, snapshot, label)`, which is bound to ONE turn: the card
describes the turn whose button was clicked, never the scope. The button stops the click from
propagating, so sharing never navigates (the row would scope, the banner would toggle the strip). The hero is the turn's token count — true with or without a baseline — with the
`×`-vs-median as its subtitle and a scale bar placing the turn against the personal p50/p90/p95
(drawn only when the bucket really has them). The findings list carries per-finding costs; the
total under it counts only findings whose cost is an ABSOLUTE amount, never a relative one
(a `3.4×` summed as 3.4 tokens was silent nonsense). A stat strip states what the turn DID (turn ordinal, duration, API calls, tool calls,
subagents, cache reads, model · effort) — none of which can identify the project, which is the
condition for the card being shareable at all.

**The GUI's files are served from a map, not from a directory** (`apps/server/src/server/assets.ts`).
Each one is imported with `with { type: 'file' }`, which answers with a path readable in both
worlds — the real file on disk under `bun start`, `/$bunfs/root/…` inside a compiled executable —
so there is one static-serving path rather than a dev one beside a shipped one. It is also what
puts them in the binary at all: `bun build --compile` embeds a file only when something IMPORTS it,
and nothing imports the GUI's assets (the browser fetches them over HTTP), so a first compile
answered every `/api/*` call and 404'd every stylesheet. The path-traversal guard this replaced is
gone rather than reimplemented: `/../etc/passwd` is simply not a key. The cost is a hand-kept list,
and `apps/server/tests/assets.test.ts` walks `public/` so a file added without a line there fails
the suite instead of vanishing from a release.

### Caching and compression

Every **buffered** response — JSON endpoints and static files alike — goes out
through `sendCacheable` (`apps/server/src/server/server.ts`). The SSE streams are the exception:
they are unbounded by nature, so they are neither hashed nor compressed.

- **ETag + `cache-control: no-cache`.** A strong ETag is hashed from the exact
  bytes, and a matching `if-none-match` gets a `304` with no body. `no-cache`
  means *revalidate every time*, not *do not store*: a reload costs one 304
  instead of the whole 230 KB bundle, and a rebuilt `apps/server/public/lib/app.js` can never
  be served stale, because the ETag moves with the bytes. (It was `no-store`,
  which re-sent everything on every load.) The tag names the **representation**:
  a compressed body carries a `-gz` suffix, so a strong validator is never shared
  between two different sets of bytes — `vary` alone would rely on every cache in
  the path honouring it.
- **gzip above ~1 KB.** Bodies of at least one MTU (1400 B) are gzipped when the
  client accepts it, and the response carries `vary: accept-encoding`. The
  catalogue compresses ~8.7×; the live poll is deliberately below the threshold,
  where a gzip header and trailer would eat the saving.

## The GUI shell

One page, one process, tabbed. A live session gets a tab by itself; on top of that
the workspace you left is restored (see below). It offers a dropdown of **all**
sessions (active and inactive, grouped) to switch to or add — including replaying
a finished one. It is built as small ES modules: pure logic
(`session-state`, `stream`, `replay`, `sessions`, `tab-store`) that is unit-tested
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
ran · calls · complete tokens · subagent share · a `▲N vs unweighted` chip when the weighting moved
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

**Why `graph.ts` is one large module and stays that way.** It is ~1500 lines, and the
obvious answer — split it per widget — was measured rather than assumed. Each candidate
block was scored by what it would have to receive from `createGraph`'s closure, because
the extraction interface is what decides whether a split helps: the drawer needs **25**
closure bindings, the turn explorer 15, the subagent rail 14. A module taking 25
parameters is the same closure with a form to fill in — it moves the coupling behind an
interface instead of removing it, and makes the next diff unreadable for no gain. 54% of
the file (830 lines across 15 functions) sits at 8+ bindings, so per-widget splitting was
rejected on the numbers.

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
  standard drawer. It exists because the ring's cap (12) is, measured over real logs,
  the *median* turn — so roughly half of all turns have activity the card can never
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

## Configuration

seedeep reads its configuration from `~/.seedeep/config.json` (owned entirely by seedeep;
not a Claude Code file). The file is optional — a missing file means all built-in defaults
apply and the first run works without it. A malformed or unreadable file falls back silently
to the defaults without rewriting.

### Schema and defaults

```ts
interface SeedDeepConfig {
  port:   number;   // 44842
  host:   string;   // "127.0.0.1"
  open:   boolean;  // true
  auth: {
    token: string;  // 32-byte base64url, auto-generated on first run
  };
  tls: {
    commonName?: string; // Required when host is not loopback; no built-in default
    cert: string;        // "~/.seedeep/cert.pem"
    key:  string;        // "~/.seedeep/key.pem"
  };
}
```

### Precedence

CLI flag `>` env var `>` config file `>` built-in default.

| Config field   | CLI flag    | Env var            |
|----------------|-------------|--------------------|
| `port`         | `--port`    | `SEEDEEP_PORT`     |
| `host`         | `--host`    | `SEEDEEP_HOST`     |
| `open`         | `--no-open` | `SEEDEEP_OPEN`     |
| `tls.commonName` | —         | `SEEDEEP_TLS_CN`   |

The `auth.token` is generated automatically (32 random bytes, base64url-encoded) on the
first run when the field is absent or empty, then written back to the config file. It
survives restarts.

### Security model

```
host = 127.0.0.1 (loopback)  →  plain HTTP, no auth required
host ≠ loopback               →  HTTPS required (self-signed cert, see below)
                                  Authorization: Bearer <token> (or ?token= query param)
                                  on every /api/* request except GET /api/config
                                  401 for missing or wrong token
```

**`127.0.0.1`, `::1`, and `localhost`** are the three loopback values. `0.0.0.0` binds on
all interfaces and is treated as non-loopback (the server is reachable from the LAN).

The decision is made from the **configured host, never from the peer**: with remote access on,
a request arriving from `127.0.0.1` gets TLS and the token check like any other, because the
listener has one certificate and one policy. So "seedeep is on this machine" does not imply "no
credentials needed" — a client on the same machine configures itself exactly like a remote one
(`docs/tray.md`). The 401's body is `{"error":"unauthorized"}`, and that shape is part of the
contract: it is how a client tells a seedeep asking for a token apart from something unrelated
listening on the same port.

### TLS certificate

When `host` is not loopback, seedeep generates a self-signed RSA-2048 certificate with a
10-year validity via `openssl req -x509`. The cert and key are written to
`~/.seedeep/cert.pem` / `~/.seedeep/key.pem`.

`tls.commonName` is required for non-loopback operation. seedeep refuses to start with a
clear error if it is absent.

It must also be a name a certificate can carry — an RFC 1123 hostname or an IPv4 address
(`isValidCertName`, `core/cert-name.ts`). The name is interpolated into openssl's
`subjectAltName=` list, where **a comma starts another entry**: a name carrying one would
quietly produce a certificate covering something else. No shell is involved (`spawn` takes an
argv array, so there is no command injection) and the blast radius is the user's own
certificate — but a silent surprise is worse than a refusal. `POST /api/config` answers 400 and
stores nothing, and `ensureTlsCert` throws as well, because the value also arrives from
`config.json` and `SEEDEEP_TLS_CN`, which no request handler sees. The predicate lives in its own
import-free module because **the browser needs the same one**: a panel that accepts what the
server refuses is worse than no check at all. LIMIT: an IPv6 literal is refused — its colons
cannot be told from the SAN's own `TYPE:value` separator without a full parser.

Surrounding whitespace is refused, not trimmed: openssl trims it while writing the SAN, so a
padded name yields a certificate for the trimmed name while the coverage check asks about the
padded one — the certificate is then judged not to cover its own name and is regenerated on every
start. The invariant that guards it lives in `tls.test.ts`: whatever the predicate accepts, the
certificate generated for it must come back `reused`.

**Everything the server answers on goes in the SAN**, and the `commonName` is the first of
them:

| SAN entry | Why |
|---|---|
| `DNS:localhost`, `IP:127.0.0.1` | the server is still reachable from its own machine |
| the `commonName`, as `DNS:` or `IP:` depending on what it is | it is the address seedeep prints, copies into the Settings panel, and hands to a client |
| **every** non-internal IPv4 address of the machine | one is picked at random on any box with a VPN, Tailscale or Docker |

The `commonName` in the SAN is not a detail: browsers have ignored the deprecated CN field
since Chrome 58, so a name that is only in `/CN=` is certified by nothing. Until 2026-07-30
seedeep put it there and nowhere else — it issued a certificate *for* a hostname it did not
certify, and **a self-signed certificate hides that**, because the name error lands inside the
trust warning the user has already accepted. IPv4 only: an IPv6 host is covered by setting
`tls.commonName` to the literal, whereas enumerating IPv6 would add the machine's temporary
privacy addresses, which the OS rotates.

#### When the certificate is replaced

A stored pair is **reused** whenever it certifies the current `commonName`, and **replaced**
when it does not — including a file the TLS stack cannot parse, which could not have served a
connection anyway. Coverage is asked of `X509Certificate.checkHost`/`checkIP`, so the answer
follows the same RFC 6125 rules a client applies rather than seedeep's reading of the SAN text.

**The name is the only trigger, never the address set.** Two consequences are the point of that
rule: the addresses change on their own — a VPN coming up is enough — and replacing the
certificate changes its fingerprint, so keying on them would give a pin that fires with the
weather; and a certificate the *user* supplied for their own domain covers its own name, so
seedeep leaves it alone even though it carries no `localhost`.

A replacement invalidates any pin already taken. That is a pin doing its job, not breaking, but
it is the one event a user cannot infer from a new fingerprint they have no old value to compare
against — so `startServer` reports `tlsCertOrigin` and the CLI says so in words, immediately
before printing the new value.

#### The fingerprint, and why it is exposed three ways

A browser gets past a self-signed certificate with a one-time click on an interstitial. A
non-browser client cannot: it either skips verification — which voids the reason TLS is here,
since remote mode exists for shared networks where a MITM is trivial — or it **pins** the
certificate, trust on first use, and refuses any later change. Pinning needs the value, so
seedeep makes it obtainable in the three places a user might look:

- **stdout, on every start** in remote mode (`main.ts`), not only on the run that generated
  the file. `ensureTlsCert` computes it on reuse too — a value readable only once is a value
  that cannot be checked a week later, when the client is actually set up.
- **The Settings panel**, TLS Certificate → Fingerprint, with a Copy button. This is the
  out-of-band channel: read on the machine seedeep runs on, compared on the machine the
  client runs on.
- **`GET /api/config`**, as `tls.fingerprint`, so a client can bootstrap without asking the
  user to type 95 characters. Safe on an unauthenticated endpoint — the certificate itself is
  presented in the clear on every handshake. It is a **convenience, not a channel of trust**:
  a fingerprint fetched over the very connection being verified proves nothing on its own,
  which is why the Settings panel exists.

The value is the SHA-256 of the leaf certificate's DER bytes, formatted `AA:BB:…` — the same
digest and formatting `openssl x509 -in cert.pem -noout -fingerprint -sha256` prints, so it can
be checked with a tool that shares none of seedeep's code. It is RUNTIME state, never written
to `config.json`: it describes the certificate this process is presenting, and is `null`
(the field absent) in loopback mode, where there is nothing to pin.

The client-side behaviour — when to show it, what happens on a mismatch — belongs to the tray
(`docs/tray.md`), not here.

### Off-LAN access: seedeep ships no tunnel

Remote mode covers the local network. Reaching seedeep from outside it is deliberately not
seedeep's job — NAT and firewall traversal are solved problems, and re-solving them here would
add a second, weaker security surface next to the token. Two supported shapes:

- **SSH port-forward** — `ssh -L 44842:127.0.0.1:44842 user@host`, with `host` left on loopback.
  The tunnel is the authentication and no certificate is involved; nothing is exposed on any
  interface of the remote machine.
- **An existing VPN or overlay network** — run in remote mode and reach the machine over the
  private address the VPN assigns it. The Bearer token and TLS still apply.

### Browser auth flow

In remote mode, the server prints a startup URL that includes the token:

```
seedeep watching — https://MacBook-Pro.local:44842/?token=<token>
```

`RunningServer` exposes two URLs: `url` (clean base URL, for programmatic callers and
tests) and `openUrl` (with `?token=` appended in non-loopback mode, used by `main.ts`
to open the browser on first launch).

Opening the URL triggers `initAuth()` (called once at page load in `app.ts`): the token
is extracted from the query string, stored in `localStorage` under `seedeep-token`, and
removed from the URL via `history.replaceState` — so it never appears in browser history
or `Referer` headers. The token persists across browser restarts with no expiry; to
revoke access, generate a new token via Settings → Regen and save.

**`?session=<id>` — the portal's one other URL parameter**, and the seam with the tray, which
hands a session over rather than replicating it (`docs/tray.md`). Applied at boot AFTER the saved
workspace and after the auto-open rule, and it ACTIVATES: it is the only thing on the page the user
did a moment ago, so it outranks both what they were last looking at and a session that happened to
start. Read by `requestedSession` (`client/sessions.ts`), which bounds the value because it reaches
the screen but does NOT check it against a UUID shape — the id format is Claude Code's to change.
An id no session answers to opens nothing, and the parameter is stripped either way, for the same
reason the token is: a reload must not yank the tab back to where one click sent it once. The two
parameters coexist — a tray URL carries both.

All subsequent API calls go through `authFetch`, which reads the token from `localStorage`
and adds `Authorization: Bearer <token>`. SSE connections (EventSource) cannot carry
custom headers, so `AuthEventSource` appends `?token=<token>` to the stream URL instead —
the server accepts the token from either the `Authorization` header or the `?token=` query
parameter on every `/api/*` route except `GET /api/config`.

When the user generates a new token via Regen, the server adopts it immediately
(no restart required). The save handler calls `setToken(pendingToken)` before clearing the
pending value so `localStorage` stays in sync and subsequent `authFetch` calls continue to
work.

### Settings panel

The settings drawer (gear icon in the header) lets the user change configuration without
editing `config.json` directly. It loads on open (`GET /api/config`) and POSTs changes on save.

**It is an editor of the FILE, not a view of the process.** The fields show the configuration as a
start would resolve it right now — `config.json` under this process's flags and environment — and a
save merges the request onto the file re-read at that moment. Both halves matter and both were
wrong: the panel used to show the copy the process was holding, so a `config.json` edited in an
editor was invisible in the fields, and the save wrote that whole copy back — measured, a save of
`open` alone put `host` back to what the process was bound to, silently discarding the edit. What
stays the process's own is what no edit can change: `version`, the certificate fingerprint, and
`restart_pending`, which is precisely the statement that the two have diverged.

A value pinned by a CLI flag or an environment variable is shown as the flag sets it, not as the
file says: that is what this server runs and what every restart will keep running, so offering an
edit to the file's number would be offering one with no effect.

The `***` redactions (the auth token, the webhook URL and its headers) mean "keep what you have",
resolved against that same file — the source the panel read them from, so the mask can only ever put
back the value it stood for.

**A file that cannot be understood is not a config.** `readConfig` is deliberately lenient — a
malformed `config.json` becomes the defaults so a server still starts — and that is exactly wrong
for a caller that WRITES: merging onto the defaults put built-ins over the user's token, port and
certificate name on the first save they made for any other reason. Both paths here use
`readConfigStrict`, which throws on a file that exists and cannot be parsed (a MISSING file is still
the defaults — absent legitimately means "every default"). On that throw the panel shows what is
running and reports nothing pending, and a save merges onto the running config, which repairs the
file rather than emptying it.

**The panel has no Save button.** Every control writes as it changes: a toggle on the click, a text
field on `change` — leaving it or pressing Enter — and never on each keystroke, or typing `45999`
would post `4`, then `45`, then `459`. A switch reads as done the moment it moves, and one that had
to be confirmed elsewhere was lying: it looked flipped, the reload showed it back, and nothing had
been posted. A port the server could not bind is omitted from the body rather than sent, so an empty
field cannot write `port: 0` on the way past.

| Field | Shown when | Behaviour |
|-------|------------|-----------|
| Port | Always | Requires restart |
| Host | Always | `127.0.0.1` = loopback (default), `0.0.0.0` = LAN; requires restart |
| Open browser on start | Always | Toggles `config.open` |
| Notifications — Tray | Always | The four events the menu-bar app may interrupt for. They live in `notifications.tray`, so the tray reads whichever server it is connected to rather than a file of its own |
| Notifications — Webhook | Behind **Send to a webhook…** | URL, headers and body template, plus its own three switches. Empty URL means the channel is off, which is how it ships — nothing leaves the machine unasked. The URL is redacted like the token: for Slack, Discord and ntfy it IS the credential |
| Auth token | Always | Always displayed as `***`; **Regen** generates a new token client-side, and warns that saving it locks out every other client |
| Access URL | Always | Computed live from the current form values; includes `?token=` in remote mode; **Copy** writes the full URL to the clipboard |
| Common name | Remote mode only | The name the certificate certifies; required in remote mode, and refused unless it is a hostname or an IPv4 address — while it is missing or unusable nothing in the panel is written at all. Changing a name that already produced a certificate warns that the certificate — and its fingerprint — will be replaced |
| Fingerprint | Remote mode only | Read-only SHA-256 of the certificate the server is presenting; **Copy** writes it to the clipboard. Server state, so nothing in the panel can change it — a new certificate needs a restart. Empty (placeholder) when the running server has no certificate, i.e. a remote host was typed into the form but not yet restarted into |
| Version (About) | Always | Read-only. The release the RUNNING server reports (`version` on `GET /api/config`), never the number this bundle was built from — a stale `build:client` would otherwise make the portal claim a version the server is not. A server that reports none leaves the dash: this is the one string a bug report quotes verbatim, so a guess here is worse than an admission |

The Access URL field derives its token from (in priority order): the `pendingToken` just
generated by Regen, then the token in `localStorage` (from a prior visit via the startup
URL). In loopback mode no `?token=` suffix is added.

**Two warnings, both conditional, and the panel has no static help text beyond the field
sub-labels.** The banner, the placeholders and those sub-labels already say what each field
means; what the panel was missing is not description but consequence — the two actions that break
a client on *another* machine. So the Common name note appears only when a name that already
produced a certificate is being changed (never on first setup, where nothing is replaced), and
the token note only while a regenerated token is pending. A warning that fires when it does not
apply is one the user learns to ignore before it ever matters.

Validation is shared, not duplicated: the panel refuses a Common name with the same
`isValidCertName` the server uses, so the field can say why immediately instead of relaying a 400.
And a rejection from `POST /api/config` is now reported as the failure it is — it used to be
parsed as a config and announced as "Saved".

One consequence of validating the name is worth stating, because it is the only reason the TLS
section is ever shown outside remote mode: **an invalid Common name reveals the section even in
loopback mode.** The name is still on its way to `config.json`, so it still blocks every write, and
a refusal whose reason sits inside a hidden section is a dead end with no way out of the
panel.

### A restart the process itself knows is due

Three values are BOUND at startup and cannot be revisited by the process holding them: `port`,
`host`, and the certificate's common name. `open` is spent the moment the browser opened and a
token is adopted live, so neither counts — announcing them would teach the reader to ignore the
announcement.

The server is the only party that can say whether a restart is due, because the answer is not
"does `config.json` differ from what I am running". Configuration arrives through a four-layer
chain (CLI flags → env → file → defaults, `applyPrecedence`), and `POST /api/restart` respawns
with `process.argv.slice(2)` intact — so a server started with `--port 9000` goes on ignoring the
file's port after every restart. Comparing against the file alone would light a permanent signal
that no button could clear.

So `restart_pending` compares **what this process resolved at startup** against **what a fresh
start would resolve to now**: the same flags and the same environment, over `config.json` re-read
at request time. Both sides go through one function, so the two can never drift apart.

- It is recomputed per request and never cached — a cached answer is exactly how a file edited in
  an editor stays invisible.
- It rides `GET /api/config`, so every surface reads one verdict: the portal (a dot on the
  Settings button, a banner in the drawer, the `Restart now` button), the tray (a line above the
  bands, asked when the popover opens), and `seedeep status` (a line under `serving`).
- `POST /api/config` derives its answer from the same comparison, taken AFTER the write. A save
  that puts a value back to what is already running reports nothing; a save landing on top of an
  earlier hand edit keeps the signal up. The old diff-on-save could only describe the last
  keystroke, and vanished with the response that carried it.

Token changes still take effect immediately, with no restart.

### Config endpoints

| Method | Path | Auth required | Purpose |
|--------|------|---------------|---------|
| `GET`  | `/api/config` | Never | The configuration a start would resolve to now — `config.json` under this process's flags and environment, never the copy it is holding (token redacted as `"***"`, `tls.cert`/`tls.key` omitted, `tls.fingerprint` added in remote mode) — plus `version` and `restart_pending`, which are runtime state, not config: both describe the process answering and neither is written back to `config.json`. It rides this route because the version has to be readable before anything else is, which on a remote host means before a token exists. The exemption goes no further than that: `dev` is withheld from an unauthenticated caller (see *Which build is answering*) |
| `POST` | `/api/config` | On non-loopback | Partial merge onto `config.json` **re-read at that moment** + atomic write, so a save cannot undo an edit it never mentioned; the runtime copy takes the same merge for what applies without a restart. Returns the redacted config read back + `restart_pending`, never a diff of the request (see *A restart the process itself knows is due*) |

### Resetting

`rm -rf ~/.seedeep/` removes all seedeep-owned state: config, certs, the aggregate cache, and the
two indexes (`search-index.jsonl`, `cards-index.jsonl`). seedeep rebuilds everything from scratch on
the next run — every byte of it is derived from transcripts seedeep does not own.

### Moving it: `SEEDEEP_HOME`

Everything above lives under **one** directory, and `seedDeepDir()` is the only code that knows its
name — `SEEDEEP_HOME` moves all six files together. That is the point: half a relocation is worse
than none, since a run whose config moved but whose caches did not still rewrites the other copy's
index, and the symptom (a corpus rebuilt on every start) names nothing. A test enumerates the paths,
and a second one fails if any other module ever spells `'.seedeep'` itself.

It exists so a checkout can run beside an installed release — `bun run dev` sets it, and
CONTRIBUTING.md explains when that matters. The damage it prevents does not need the two to run at
once: a dev run that changes the port from the settings panel is what the installed server reads on
its next start. A relative value is resolved against the process's cwd, so a dev script can point it
inside the checkout. Unset for a user, which is every release.

**The tray answers to the same variable**, and to no other: it keeps its own two files in
`<SEEDEEP_HOME>/tray`, so one name selects a whole world — this server and the tray watching it.
It had a variable of its own until 2026-08-04; the two were always set together and meant the same
thing, and the only thing the second one achieved was a dev tray that moved its files and went on
watching the INSTALLED server. A GUI app inherits no shell environment, which is what makes the
installed tray the installed world with nothing to configure ([`tray.md`](tray.md#running-it)).

### Which build is answering

`GET /api/config` carries **`dev`**: true when the server is a checkout, false when it is a released
executable. The portal reads it once at load and, when it is true, renames the tab to *seedeep dev*
and puts a chip beside the brand (`client/build-mark.ts`). A release shows nothing — a badge every
install carries is a badge nobody reads.

The same response carries **`version`**, and unlike the chip the brand states it on **every**
portal, in muted monospace right of the wordmark: it is not a badge but a fact, and it is the one
number a bug report quotes — the settings panel still holds it, but reading it there is a panel you
have to go open. On a checkout both marks show, version first — `seedeep 0.12.0 dev`. It is the
release the SERVER reported and never a constant compiled into the bundle: `public/lib/` is a build
artifact, so a stale `build:client` would otherwise print a version nothing is running. A server too
old to report one draws nothing at all — a dash beside the wordmark reads as a broken page, and this
is the value that must never be guessed.

It exists because the two seedeeps on a machine are **indistinguishable by their content**: the
sessions come from `~/.claude/projects`, which belongs to Claude Code, so a dev portal and an
installed one list exactly the same work. Everything else is separate — config, certificate, token,
caches, records — and none of that is on screen.

**Only to a caller that has authenticated.** `GET /api/config` answers without a token, but that
exemption was granted for one reason — the version has to be readable before a token exists — and
`dev` is not in that class: nothing needs it before authenticating, and it is the only field here
that tells a stranger something about the operator's machine they could not already know (host and
port are what they used to arrive). On loopback there is no token to present and nothing to prove,
so the mark is simply there; in remote mode the portal reads it through `authFetch` and the chip is
unaffected.

The signal is **`Bun.embeddedFiles.length === 0`** (`server/version.ts`). That is Bun's own answer to
"am I a standalone binary": every file compiled in with `with { type: 'file' }` is in it, and there
are none from source — measured on bun 1.3.13, 0 from `bun run` against 1 from `bun build --compile`.
Preferred over testing an asset path for `/$bunfs/`, an internal spelling that differs on Windows and
would make the answer a guess there. And deliberately not `SEEDEEP_HOME`: moving your state is not
declaring yourself a developer.

### Announcing a running server

A running server writes a small record of itself — `<seedDeepDir>/servers/<pid>.json`, holding its
pid and the address it answers on — and takes it back when it exits
(`apps/server/src/server/run-state.ts`). It is written after the bind, so it can only name an
address that exists, and removed **synchronously** on the way out, because the shutdown path is
`stop()` then `process.exit(0)` and an awaited unlink would lose that race.

It exists for the tray, which has to answer two questions no HTTP request can: whether a server is
RUNNING here — as opposed to "nothing answered", which a wedged process and an unconfigured port
produce alike — and which process it is, so it can be stopped. The browser never reads it.

Two shapes were possible and only one is safe:

- **One file per process, named after its pid**, the way Claude Code registers its own open sessions
  in `~/.claude/sessions/<pid>.json` — which `open-sessions.ts` already reads. A second server on
  another port (`--port 9000`, which the README documents) gets a record of its own.
- One shared file would be **overwritten** by that second server, and a reader would then hand out
  one server's address with another's pid: a stop that kills the wrong process. The shape rules that
  out rather than documenting it.

**Liveness is never taken from the file.** A crash or a SIGKILL leaves a record behind, so
`process.kill(pid, 0)` is what says whether anything is still there, and a record whose pid does not
match its own filename is ignored — that is what a pid the OS has recycled looks like. Stale records
are swept by the next server to START, not by the read: a read that deletes is a surprise for its
caller, and a start is where the cost is already paid.

The tray reads these records for three things: to FIND a server at all — with nothing stored it
tries the announced addresses before guessing `44842`, which is the only way a server on any other
port is reached without the user pasting a URL for their own machine — and to offer Start and Stop.
It applies the same rules in Rust (`apps/tray/src-tauri/src/local.rs`) — including one this side does not need: **two live records
claiming one address are refused rather than resolved**, because that is a crashed server's file
plus a recycled pid, and a stop would signal an unrelated process. A server the tray starts writes
its output to `<seedDeepDir>/server.log` at mode 0600 — it has no terminal, and its first line
carries the token in remote mode. The full rules are in [`tray.md`](tray.md#starting-and-stopping-the-server).

### Opening the GUI from a console

`seedeep open` reaches the GUI from anywhere without asking the user to know whether a server is
already up: a record on the configured port means open the browser on it, no record at all means
start one first (`apps/server/src/server/open-cmd.ts`). It is the whole of what the `/seedeep`
slash command does inside Claude Code.

Three of its rules are decisions rather than detail:

- **The start is DETACHED**, and that is the reason the subcommand exists at all rather than a line
  of shell in the command file. A server started as a child of the shell Claude Code opens dies
  when that session ends, so the GUI would close under the user with nothing on screen explaining
  it. `detached: true` is `setsid` on POSIX (measured: the child's ppid becomes 1 and it gets its
  own process group), and its output goes to `<seedDeepDir>/server.log` at mode 0600 — the same
  file, and the same reason, as a server the tray starts. A pipe would be worse than untidy here:
  the caller may be Claude Code's `` !`seedeep open` `` preprocessing, which reads its output to
  completion, and a pipe held open by a server that never exits would hang it.
- **Servers running but none on the configured port is reported, never resolved by guessing.** With
  two servers up, opening the wrong one is indistinguishable from success — the GUI appears,
  sessions are listed, and nothing says it is the other process. Matching is by PORT alone: the
  config's `host` is a bind address (`0.0.0.0` binds everything) while a record carries a connect
  address, so comparing the two would reject the right server.
- **The URL is rebuilt here, not read from the record.** A record deliberately carries no token, so
  for a non-loopback server the secret comes from the config file — something only a process on
  that machine, as that user, can read. That is why this logic is in the binary and not in a
  Markdown file.

**`--help` and `--version` are recognised ANYWHERE in `argv` and win over everything else**
(`help.ts`), because asking what a program is must never run it: `seedeep open --help` explains and
does not start a server on the way. The text is the only place the CLI's surface is written down in
one piece, so a test asserts it names every subcommand and flag the parser accepts — `claude-code`
excepted, which exists for the command file rather than for a person.

**Every other unknown argument is an error** (`args.ts`). The parser used to ignore them, which meant
`seedeep open` on a build without the subcommand quietly started a SERVER in the foreground —
attached to the caller's shell, which is exactly the process this feature exists to avoid. Bare
`seedeep`, with or without flags, still serves.

### The `/seedeep` command, and what it can ask for

One command file, three things: `/seedeep` (or `/seedeep open`), `/seedeep report [full]`, and
`/seedeep restart`. A file under `commands/` is a TEMPLATE and cannot branch, so its shell line is
fixed — `` !`seedeep claude-code ${CLAUDE_SESSION_ID} $ARGUMENTS` `` — and the branching lives in
`claude-command.ts`, where it is testable and where an unknown word produces seedeep's own error
instead of a shell's. `${CLAUDE_SESSION_ID}` is Claude Code's documented substitution for the
current session, and it is what makes `report` possible at all: nothing else on the machine knows
which session the person typing is in.

`$ARGUMENTS` reaches the shell by TEXTUAL substitution, so no quoting inside the file can make it
safe. It is acceptable because the person typing it is the one whose shell it is, and because
`disable-model-invocation` keeps Claude from invoking the command on its own — not because the
substitution is harmless.

**`seedeep report`** answers what a session cost and where its tokens went (`report.ts`). Without
`--session` it takes the newest session of the directory it was run from, and says so on stderr so
the report stays the only thing on stdout. A default is safe HERE and nowhere else in this CLI,
because the report NAMES ITS OWN SUBJECT on the first line — a wrong pick is visible immediately,
and reading a transcript changes nothing; that is exactly what `open` lacks, where opening the wrong
server looks like success. It is never a session from another project: that is the one way to be
wrong the first line could not make obvious, since the id means nothing to the reader either way. It
computes nothing of its own: `summarizeTree` over the real parser + reducer + verdict is the path
the aggregate cache and the GUI already take, so a number here cannot disagree with the same number
in the browser. `launchedCount` is imported from the digest for the same reason — how many agents a
session started has rules (a Workflow run counts its members), and two implementations would be two
answers. No server needs to be running: the transcript on disk is the source.

Its SHAPE is fixed by what it costs, because this output lands in the context of the session it
describes — a tool that exists to show the context filling must not fill it in silence. The two
standing blocks are constant-size whatever the session's length (the flagged behaviours appear only
when they happened; the costliest turns and the tool list are capped), the per-turn prompts are
opt-in behind `full`, and the last line states the report's own size. Measured on a real 31-turn
session: 132 tokens, or 717 with `full`.

`TurnSummary` carries no id, so the turn numbers come from a list of entries paired with it BY
POSITION, filtered exactly as `summarizeTree` filters. A test asserts the two lengths agree over
real jsonl rather than trusting that they still do.

**`seedeep restart`** asks the server to replace itself (`POST /api/restart`) instead of killing a
pid and spawning: the server already knows how to hand over, and a second implementation of that
would be a second thing to keep true. It then WAITS for a record carrying a different pid — the
replacement gets a new one, so returning on the POST's answer would report a restart that may never
have completed. A server that ANSWERS and refuses (401, a token that does not match) is a failure; a
lost connection is not, because this request asks a process to exit and the record is what says
whether it worked.

**A connection that was never ESTABLISHED is a third outcome, and conflating it with the second
broke the command in remote mode.** In remote mode seedeep serves its own self-signed certificate,
which `fetch` rejects (`DEPTH_ZERO_SELF_SIGNED_CERT`, measured 2026-08-05) — so the POST never left
the process, the server never heard it, and the command went on to spawn a replacement against a
server still holding the port, then blamed the replacement for not coming up. The request now trusts
THAT certificate, the one this machine generated and holds on disk, passed as the only CA; not
`rejectUnauthorized: false`, which would accept any certificate at all on the one request that can
stop a server. `post` returns `answered | disconnected | unreachable` rather than a number, so the
two cannot be the same value again, and an unreachable server is reported without anything being
spawned. Which half failed is also named: an old server still holding its record is a different
fault from a handover that started and never finished. Nothing running is not an error either: it starts one, and does NOT open a
browser — this subcommand is about the process.

**`seedeep start` is `open` without the browser** — the counterpart of `stop`, sharing one
`ensureRunning` with `open` so the two can never disagree about what "running" means. A server
already up is a success and says so, for the same reason `stop` succeeds on a server already
stopped: asking for a state that already holds is not a failure.

**`seedeep stop` signals; it does not ask an endpoint** (`stop-cmd.ts`). There is no `/api/stop`, and
the reason not to add one is that a running server is already addressable by pid through its own
record. **SIGTERM, never SIGKILL**: the server's handler stops the watcher, closes the listener and
withdraws its record synchronously, while a killed one leaves that record behind for a recycled pid
to inherit — the single failure the record's design exists to prevent. A server that ignores the
signal is reported rather than escalated to a kill, for that same reason. The stop is then WAITED
for, so "stopped" is observed rather than assumed, and nothing running at all is a success, not an
error: asking for a state that already holds is not a failure.

**`seedeep status` asks, and changes nothing** (`status-cmd.ts`). Every other subcommand is an
ACTION; this is the only one that answers "what state is this machine in?", and it exists because two
real failures took a shell and a token to diagnose: a server still SERVING the previous version after
the package had been updated (a process keeps the code it started with, and nothing said so), and
`/seedeep` missing because `install-command` had never been run.

- **A server that is down is a STATE** (Davide's call, 2026-08-05): the exit code is 0 whatever it
  finds, exactly as `stop` succeeds against a server already stopped. Asking a question is not
  demanding an answer you like.
- **It never touches the registry** — the update line reads the cache with `offline`, so `status` is
  instant and works with no network. It DOES talk to the local server, which is what makes the
  served version knowable, through `own-server.ts`.
- **The served version is compared with the installed one**, and only when they differ is `restart`
  named. A version it could not obtain is reported as unknown, never as the installed one.
- **An installed command file and a WORKING `/seedeep` are two different facts**: the file calls
  `seedeep` by name, so `pathState` is reported next to it — an install missing from the PATH under
  that name fails with *command not found*, and nothing else would say why.
- Rendering is a pure function of gathered facts (`statusReport`), so every combination is tested
  without a process, a port or a network.

**`own-server.ts` is how any command talks to a seedeep on this machine** — the token when the
address is not loopback, and the server's own certificate as the only CA when it is https. Both exist
because of remote mode, and a caller that forgets either gets a failure that looks like the server
being down; that is exactly how `restart` broke.

**`seedeep update` tells, and does not do** (`update-cmd.ts`). It reads the channel off the RESOLVED
path of the running executable — a package manager installs into `node_modules/seedeep/`, and bun's
global root is under `.bun/` (measured: `~/.bun/install/global/node_modules/seedeep/bin/seedeep.exe`,
reached through a symlink at `~/.bun/bin/seedeep`); anything else is a file the user put where it is,
which is what a downloaded release asset is. Then it prints the one command for that case.

Two things it must not do, and the reasons are not the same:

- **It does not run the install.** Under `/seedeep` the shell runs inside Claude Code's
  preprocessing, which blocks the turn and captures the output: a global install of a ~60 MB package
  would hang the turn for tens of seconds with no sign of progress and paste the package manager's
  whole log into the session. The failure modes are ones seedeep does not control either — bun
  blocks the postinstall without `--trust`, npm may ask to allow scripts — and they would arrive as
  that same wall of text, after the fact, with `seedeep` possibly half-replaced.
- **It does not ask the registry itself** — it reads `updateStatus` (`update-check.ts`), the one
  cached check every surface shares. `--offline` skips it, and an unreachable registry is an outcome
  rather than an error: the advice still prints, since a machine with no network still deserves to
  be told how it would update. Nothing updates on its own either: npm documents no background or
  scheduled update, for global packages or any other kind, so "automatic" can only live in the
  user's own scheduler.

`seedeep install-command` writes the `/seedeep` command file into Claude Code's own directory
(`~/.claude/commands/seedeep.md`, or `CLAUDE_CONFIG_DIR` when set — resolved by `claudeDir` in
`roots.ts`, the ONE home for that fact, because the transcripts live under the same variable and
answering it twice is how the command file and `report` came to look in different places). The binary does it because it
is the only artifact every distribution channel delivers, and because the command file and the
`seedeep open` it calls then always ship as one version. It is never run automatically at first
start, since writing into another tool's directory unasked is not seedeep's to do.

**The file says who wrote it.** Its last line names the version and carries a digest of everything
above it, so an UPGRADE and an EDIT stop looking identical — without that they are both just "the
bytes differ", and the first version of this refused both, making every upgrade need `--force`. A
file whose digest still matches is seedeep's and is updated in place; one whose digest disagrees, or
which has no marker at all, is the user's and is left alone. The marker lives IN the file rather
than in a record beside it so the answer survives a deleted `~/.seedeep`, a dotfile copied to
another machine, or a binary replaced by hand. It costs ~25 tokens of prompt on every `/seedeep` —
the honest price of a file that can describe itself.

**Every server start refreshes the command file** it already owns (`refreshOwnedCommandFile`), and
this does not weaken the rule above: it never CREATES the file — running `install-command` once is
the permission, and this only keeps that result current — and it touches nothing whose marker and
digest do not still say seedeep wrote it. Not awaited and never fatal: serving must not wait on, or
be stopped by, another tool's directory.

**The staleness check rides on the invocation** as well, and the two are complementary rather than
redundant: the refresh covers the user who restarts a server, the notice covers a machine where no
server of theirs ever runs — `report` needs none. No install hook covers every channel: an
npm `postinstall` would reach one user in two and would write into `~/.claude` unasked, and a
downloaded executable the user replaced by hand has no install step to hook at all. `seedeep
claude-code` is the one moment seedeep is certainly running in every channel, so that is where it
reads the installed file and says, in one line, that it predates the binary answering it. A file
that is the user's says nothing: they own it.

`install-command` also checks that `seedeep` resolves on PATH to the executable running it, because
the failure it prevents is silent and misleading: the command file calls `seedeep` BY NAME, so on
the downloaded binary — which installs nothing and puts nothing on PATH — `install-command` reports
success and `/seedeep` then dies with *command not found*. Running from a checkout is reported as
what it is instead of being dressed up as that failure.

**No message ever crosses channels**, and this is a rule rather than a nicety. An npm install told
to fetch the release binary ends up with a standalone executable sitting beside the one npm still
manages — two seedeeps, and the next `npm i -g` moves only one of them. So the "not on PATH" advice
is answered per channel (`bun pm bin -g`, `npm prefix -g`/bin, or `mv` for a file the user placed
themselves), and `--trust` — bun's caveat, not npm's — appears only under bun. Tests assert the
absence, not just the presence: the npm advice must NOT contain the release link, and the download
advice must NOT contain a package-manager command.

### The update check: one request an hour, four surfaces

`update-check.ts` holds the ONLY outbound request seedeep makes, and the cache that keeps it to once
an hour (Davide's call, 2026-08-05, superseding the same day's "only when you type it"). Four surfaces
read it and none of them asks npm: `seedeep update`, the lines after `open` and `start`, the portal's
About section, and the tray's notification.

**The clock is the cache, not a timer.** Nothing is scheduled: an answer older than an hour is
refetched by whoever asks next, so ten clients in that hour cost one request and a server nobody
talks to costs none. A timer would have to be created and cleared at shutdown, and would keep
fetching for a portal closed a week ago. A FAILED check has a cooldown of its own — 15 minutes,
deliberately shorter than the TTL, because a failure has no answer worth preserving and the only
thing waiting costs is how long a laptop back on wifi keeps reporting nothing. Without a cooldown at
all an offline machine would go to the network on every call, since a cache holding nothing has
nothing to expire.

The whole cost of the hourly cadence is 24 requests of 18 bytes a day instead of one; what it buys is
learning about a release within the hour. It does not make the tray noisier — that banner fires once
per released version however often the check runs.

**Only `latest` and its timestamp are stored; the standing is derived on every read.** The cache
outlives the binary that wrote it, so a stored `behind` would still say it to an executable that has
since been updated — and one cache can serve a tray and a server on different versions, which in
remote mode they are. A failure keeps the last known version: an unreachable registry is not evidence
that yesterday's answer was wrong.

`https://registry.npmjs.org/-/package/seedeep/dist-tags` answers in 18 bytes, and one endpoint serves
every channel because the npm package and the release binaries ship from the SAME tag: what npm calls
latest is also the newest downloadable executable.

**`GET /api/update`** serves that status to anything that is not the CLI — `{ current, latest,
standing, checkedAt, reason, channel, command }`, where `current` is the answering SERVER's version.
A client on another machine compares `latest` against its own; the tray does exactly that
(`docs/tray.md`).

`command` is the half no client could work out for itself: **how a server was installed is readable
only from where its executable lives**, so a tray or a portal saying "update it in a terminal" left
the user choosing between bun, npm and a downloaded file. It is `Channel.command` with one
substitution — a checkout reports `git pull`, where the `Channel` type carries null because the CLI
writes a sentence there instead. `download` keeps null on purpose: replacing a file by hand is not a
command, and a client says so in words.

**The tray asks every 15 minutes**, deliberately shorter than the TTL: asking on the same period as
the cache expires would land the request just before the refresh as often as just after, making the
worst case two hours rather than one. It is a local HTTP call against a cached file, so the registry
sees nothing of it whatever the cadence.

**`open` and `start` read the cache with `offline: true`** and never refresh it. A first run with an
empty cache would otherwise pay the check's timeout before printing the address the user ran the
command for — and under `/seedeep` that wait blocks Claude Code's turn.

**So the server warms the cache at its own start** (`serve()` in `main.ts`, not awaited). Without it
those two lines were unreachable for the user they exist for: the only other things that refresh the
cache are `/api/update` — which the portal calls when the Settings drawer opens, and the tray on its
own clock — and `seedeep update` itself, so somebody who uses only the CLI would keep an empty cache
forever and never see the line. It sits in `serve()` rather than `run()` for the reason the command-
file refresh does: `run()` is what the tests drive, and a fetch there would put `bun run test` on the
network.

### Aggregate cache migration

The aggregate cache previously lived at `~/.claude/.cache/seedeep/aggregates.json`.
At startup, seedeep checks for the old path and, if found and the new path
(`~/.seedeep/aggregates.json`) is absent, copies and deletes it automatically. The migration
is non-fatal: a failure just triggers a cache rebuild on the next refresh.
