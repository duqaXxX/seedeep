# What seedeep shows

The full tour of every surface, and the reasoning behind the ones whose rules are
not obvious. `seedeep` is under active development; everything on this page is in
the current release.

The README is the short version. The design behind these surfaces is in
[`architecture.md`](architecture.md); what changed when is in
[`CHANGELOG.md`](CHANGELOG.md).

> Every figure below is a **cropped still of a synthetic session** on a fictional
> project, cut by `bun run doc-shots` — never a screenshot somebody took. Most come
> from a real recorded session, replayed. The rest come from a written transcript
> (`apps/server/scripts/doc-scenes.ts`), because some states cannot be provoked on
> request: an API call does not fail when you ask it to, Claude Code refuses to
> compact a small session, and a retrospective is about a corpus rather than a
> session. Those transcripts are synthetic in content and faithful in shape — the
> same rule the test fixtures follow — and each is run through the real parser and
> reducer by a test that asserts the state its figure claims.
>
> Each figure is declared in `apps/server/data/doc-shots.json` with the source files
> that invalidate it, so `bun run doc-shots:check` (and the pre-push hook) can name
> the ones a change just made false. Nothing else can: no test looks at a PNG.

## The live session view

A live-first cockpit: a context dial and a real token breakdown next to a **live
subagent monitor** (the running subagents, each with its context filling in real
time and its current action), and the live activity feed filling the right — the
two live signals at a glance.

<img src="assets/shots/context-dial.png" width="459" alt="The context card: 263.1k of a 1.0M window, 26%, split by cache read, cache write and input">

*The number is the whole point, so it is the biggest thing on the card. The bar
below it is the same figure split by what it is made of — mostly context read back
from cache, which is billed too.*

### The activity feed, and every call to the model

The feed interleaves the **API calls** themselves with the tools each one
triggered, every call carrying its latency. Click a call to read its **input and
output** on demand — the model's text and tool args, plus the per-call token split
(cached context vs what was new) and the reasoning **effort** that call ran at,
where Claude Code recorded one.

![The activity feed: API calls with their latency, each followed by the tools it fired, subagent work tagged as such](assets/shots/activity-feed.png)

*Read it top to bottom: every `API call` carries the time it took, the tools it
fired sit under it, and anything a subagent did is tagged `SUBAGENT`. The panel at
the top is the model's own last words — the turn's output as it arrives.*

Cyan toasts announce new tools and subagents as they fire — a spawn's toast also
names the **model** it runs on, filled in as soon as it is knowable, since three
quarters of subagents run on a different model than the session did.

### Which model, and how full that makes it

Whatever scope you are looking at **names the model it ran on** — the banner and
the Session card — because that model *is* the context window's denominator: a
session that switched shows the one in force now and what it was before, so a
changed window can never look like a full one. `/model` mid-session moves the bar,
because 1M and 200k are not the same bar.

<img src="assets/shots/subagent-windows.png" width="459" alt="Three running subagents on sonnet, haiku and opus, each with its own context bar: 2% of 1M, 8% of 200k, 1% of 1M">

*Three subagents of one turn, and three different denominators: the Haiku one is
measured against 200k while the other two run on 1M. 15.6k is the smallest of the
three figures and the fullest window on the card — which is why a percentage is
worth nothing until you know what it is a percentage of.*

While a turn is open its **elapsed counts up**, and the session states how long it
has **worked** — the sum of its turns, not the wall-clock span. The two differ by
3× in the median session.

### The stats strip

Three equal-height cards: **Session** (tokens by API category plus turn KPIs),
**Skills + Commands**, and **Changed files**.

In the Session card the main-thread categories are headed *main session*, and the
**Subagents** figure below them opens into a **by-model** bar — the subagent tokens
split by which model actually burned them (charged per call, so a subagent that ran
on two models shows as two), never mixing in the main thread.

<img src="assets/shots/session-tokens.png" width="459" alt="The Session card: 2.9M tokens billed, 2.5M of them cache reads, and the subagents split across sonnet, haiku and opus">

*One turn billed **2.9M** tokens, and **2.5M** of them are context read back from
cache — the figure a session's own footer never shows you. Below it, the subagents'
~140.9k split by the model that actually burned it.*

**Commands** chips are clickable: each opens a drawer listing every turn the
command was typed in, with its per-turn count; clicking a turn scopes the whole
view to it. **Skills** chips open a drawer showing model invocations (times the
model called the Skill tool) and active turns — distinct from user-typed
`/commands`, which appear in Commands.

<img src="assets/shots/skills-commands.png" width="459" alt="The Skills and Commands card: the code-review skill, and the model, compact and code-review commands with their counts">

*Two different things, deliberately kept apart: a **skill** the model invoked, and the
**commands you typed**. Each chip opens a drawer listing the turns it appeared in.*

The **Changed files** widget answers *what did this touch*: a total plus a
proportional bar per file extension, counted from **git** — the files of the
commits that session produced, so the number is one you can reproduce with
`git show --stat`. Its description names the commits it counted, and a session that
has not committed says so rather than showing a figure nothing can back.

Counting Claude Code's own file-history ledger instead would under-report by half:
it records only what CC's own editing tools wrote, so a file rewritten by a shell
command or produced by a build is invisible to it (measured on one commit: 8 of 16
files). And which session made a shell write is recorded nowhere at all, so it is
never guessed. The ledger is still read for the one thing git cannot see — the
per-session scratchpad Claude Code uses for throwaway scripts, which lives outside
your repository and gets its own row instead of inflating the total. Expand the
card for the complete list, project first then scratchpad, narrowed by a path
filter and by type. Full rules: [`changed-files.md`](changed-files.md).

### The output row — Main tools · Commits · Cards

At 50/25/25: what the session ran to get there, what it shipped, and what it was
working on. All three are always on the page — a widget that appeared only once it
had content could not report that there is none, so Commits and Cards carry their
own empty state instead.

- **Main tools** shows the top output-size hogs at a glance; expand it to browse
  every tool call with a **live filter** (name or file path, instant) and a **sort
  toggle** (`size ↓` by output, `time ↓` by duration slowest-first). Every row
  shows the tool name, the turn it ran in, a proportional bar, and the value
  (chars or ms).

  ![Main tools: four Read calls of 23k characters each at the top, then the tool types as counts](assets/shots/main-tools.png)

  *Four reads of the same file, 23k characters each, are most of what filled the
  window in the figure above — which is the kind of thing you only argue about once
  you can see it.*
- **Commits** — the commits that session produced, each opening on GitHub or
  GitLab, or marked `local` when it is not pushed. Attributed from the commit's own
  hash in the call that made it, so two sessions working on one repo never claim
  each other's work. Full rules: [`commits.md`](commits.md).
- **Cards** — the tracker cards the session touched, each opening on its tracker.
  Read from the calls that named them, never from a key typed in a prompt: of the
  36 key-shaped prefixes appearing in prompts across a real corpus, 27 name no
  tracker at all (`GPT-4`, `UTF-8`). A row says whether the session **changed** the
  card or only **read** it. Full rules: [`cards.md`](cards.md).

### The subagents grid

The full grid sits below, in launch order. Click a subagent to see its launch
prompt, the tools it called, and — the point — **the verbatim output it returned to
the main session**.

![Six subagents in launch order, three done and three running, each with its model, volume, context and what it returned](assets/shots/subagents-grid.png)

*Six subagents of one turn: the three that finished carry what they returned, the
three still working carry `running`. Each names the model it actually ran on, and
each is measured against that model's own window.*

<img src="assets/shots/subagent-drawer.png" width="549" alt="A subagent's drawer: model, duration, tool calls, what it returned, its launch prompt, and the verbatim text it handed back">

*The drawer, scrolled: what the parent asked it to do (`LAUNCH PROMPT`), and under
it `RETURNED TO MAIN` — the text the main session actually received, verbatim. This
is the one thing a transcript reader cannot reconstruct by eye, because the parent's
own log holds only the tool call and the result.*

A subagent appears the instant it is **launched** (not when its transcript shows
up) and stays `running` for as long as it really works — background subagents
included, which is now Claude Code's default. It ends as `done`, `failed` or
`killed`; `unknown` means seedeep never learned its fate rather than pretending to
know. A **workflow run** takes one aggregate row — fleet size, how many of its
subagents are still working, tokens, and the model breakdown — instead of flooding
the grid with the ~100 it spawns.

Every entity — subagent, tool call, tool type, API call, skill — opens a **detail
drawer**; drill-down clicks (e.g. a tool inside a subagent's drawer) show a
**breadcrumb** so you can navigate back without losing context.

The view reconstructs identically live and in replay; an **ended** session drops
the live chrome — the monitor collapses to a one-line summary, and the LIVE badge
yields to a quiet "ended".

## The turn as a lens

The timeline shows **everything you sent** — typed prompts and slash commands
alike — and colours each entry by what it actually cost: a round of work (green
while it is burning tokens, red if you hit Esc), a context event (`/clear`,
`/compact`, a compaction), or a local command that cost nothing.

![The timeline: eight things sent, coloured by what each cost — a work turn, a grey local command, a red interrupted turn, a violet compaction](assets/shots/timeline-strip.png)

*One column per thing you sent, and the colour is the cost: green while a turn burns
tokens, **red** where Esc cut one off, **grey** for a local command that cost nothing,
**violet** for a `/compact`. The filter chips above count what is worth filtering to.*

Click one and **every widget re-scopes to it**: context, token usage, tools,
subagents, skills, commands, and the activity feed. Prompts and results open in
full, rendered as markdown. An interrupted turn is the point of the whole view:
everything it consumed, and no answer to show for it.

## A verdict on every turn, both faces

Seven deterministic checks (no LLM) score each turn for waste — a subagent that
returned a large output, a mid-turn compaction, a second Esc in a row, a **cold
resume**, a context window ≥70% full, an **exploration** that read many files and
changed nothing, or code **committed with no check** run anywhere in the session.

Every check quotes the public Claude Code documentation that justifies it —
including the one that says a *single* Esc is the recommended behaviour, not waste.
No check compares a turn to your other turns: one did, and measuring showed it
reported how BIG a turn was, which is not the same as waste.

The resume check is the one that separates *what a turn did* from *what it paid to
come back*: a turn re-opened long after the cache went cold re-creates its whole
prompt before doing anything — measured on a real corpus, that is a quarter of
every token spent, and it used to be reported as if the turn had done the work.

The verdict also names what a turn did RIGHT: ran a check before committing,
delegated the exploration to a subagent, had its work reviewed by one. A wasteful
turn raises a non-blocking toast the moment it closes; the timeline's **Verdict**
lens then dims every other column and lists, per turn, what went wrong, what it
cost, and what went well.

![The Verdict lens over the timeline: two flagged turns, one for reading nine files and changing nothing, one for a subagent that returned 7.8k characters](assets/shots/verdict-lens.png)

*The lens dims everything else and names what each flagged turn did: one read nine
files and changed nothing, the next pulled a **7.8k-character** subagent report into
the main context. Both are lower bounds — a check says only what it can prove.*

## When a session is waiting for YOU

A session stopped at an approval dialog (or an `AskUserQuestion`) is normally
indistinguishable from an idle one — nothing about it reaches the logs. seedeep
reads it from Claude Code's own live session state and shows it: the tab dot turns
**amber**, an amber toast announces it, and the Live activity's NOW panel says what
it is waiting to approve and for how long — clearing itself the moment you answer.
seedeep only *shows* it; it never answers for you.

![The NOW panel in amber: waiting for your approval in the terminal, 5s ago](assets/shots/waiting-on-you.png)

*Amber means the session cannot move until you do, and the age keeps counting so a
minute lost is a minute you can see. This state is the one thing in seedeep that
comes from outside the transcript — it is in Claude Code's live session file, which
is why a stopped session looks exactly like a thinking one everywhere else.*

## When a session is BROKEN

An API call that fails — an expired login, a session limit, an overloaded server —
ends the turn and leaves the session sitting there. It is the quietest failure
there is: measured over 1830 real transcripts, 39 of 47 failed calls were the last
model line their session ever wrote, and nothing on screen says so.

seedeep makes it a state rather than a passing message: the tab dot turns **red**,
the menu-bar icon turns red above every other signal, the tray panel files the
session under **Broken** with the message Claude Code itself showed, and a
notification says which session broke. It clears itself on the next call that
succeeds — never on a timer.

![The feed of a broken session: the last API call carries the message Claude Code showed, and nothing follows it](assets/shots/broken-session.png)

*The last thing this session ever wrote. The message is Claude Code's own, verbatim —
seedeep never paraphrases what failed, because the wording is what tells you whether
to wait, log in again, or switch model.*

## Failures stand out

A tool that failed or an API call that errored (rate limit, auth, prompt too long)
carries a red badge wherever it appears — the Live activity feed, both Expand-all
lists, and the drawer — and reddens its Trace span, with a folded round/chapter
flagged red so a failure buried in a collapsed group is still visible. A tool the
*user* refused (an Esc on the permission prompt) is not a failure and is never
flagged.

![The feed with a failed Read carrying a red ERROR badge, and the calls around it succeeding](assets/shots/failed-tool.png)

*The badge sits on the row itself, so a failure is visible without opening anything —
and the call after it succeeded, which is why this is a badge and not a session state.*

## Nothing is hidden from you

The Live activity card streams the most recent events, but it can only hold a
dozen — and on real sessions that is the *median* turn, so about half of them have
more. **Expand all** opens the complete list: every prompt, API call, tool, skill
and spawn in the order it happened, with each subagent's own work indented under
the spawn that launched it, filterable, and scoped to whatever turn you have
selected. Every row opens the same detail drawer as the rest of the app.

## Trace — the whole session as one flow diagram

Opened from the Live activity card: a vertical spine of turns, each expanding in
place into the strip of what actually happened.

![One turn in the Trace: 41 steps, one failed, folded into two chapters, a spawn block for three parallel subagents, and the closing round](assets/shots/trace-chapters.png)

*One turn, 41 steps, and none of them hidden: the two grey blocks are chapters —
`R1–10` and `R11–18` — that expand in place, while the landmarks stay out where you
can see them. The teal block IS the spawn of three parallel subagents, the red edge
on the first chapter is the failed step inside it, and the row above says `1 failed
step` so a failure folded into a group is still visible from outside.*

Built to stay readable at real scale (a p99 turn has ~200 steps): consecutive
rounds of work fold into **chapters** you expand in place, while the landmarks —
spawns, skills, replies — always stay visible. Live, the newest block glows and the
view follows it; a spawn block IS its subagent (launch intent, tools, real
duration) and unfolds the child's own flow as a parallel lane below, filling
**while the agent runs**. Every block clicks through to the same drawer as the rest
of the app. The full rules live in [`trace.md`](trace.md).

## Home — your retrospective, from minute zero

First entry of the header menu (☰, left of the wordmark), never closable, and
filled before you run anything: it reads the sessions already on disk, so an empty
workspace never looks like a broken page.

It answers *how do I actually use this agent* — your median turn against its p95,
the tokens spent (the COMPLETE figure, cache reads included, because those are
billed too), API calls, how many turns wasted tokens, what you abandoned to Esc,
and the hours you spent working.

The hero is the **turn-size distribution**: the shape of how you spend new tokens,
with your p50 and p95 marked on it. Alongside, **activity** follows the time
filter: `7d` draws one bar per day ("6d ago → today"), `30d` one bar per calendar
week over the last ~30 days, and all-time the full weekly cadence — readable three
ways from tabs in the card: `tokens` (the volume of work), `turns` (split crit /
warn / clean), and `hours` (time actually worked).

Below: where the waste comes from, tokens split by the model that spent them
(**subagents counted under their own model**, so a Haiku explorer inside an Opus
session shows up as Haiku), tool calls by type, and the verdict split. A
`7d / 30d / all` filter switches window instantly — all three ride in one response,
nothing refetches. A persistent, incremental cache keeps the tab instant: a full
corpus scan takes seconds, which is too slow for a launch surface, so only what
changed on disk is ever re-read.

![Home: the turn-size distribution with p50 and p95 marked, activity by day, where the waste came from, and tokens by model](assets/shots/home-retrospective.png)

*Your own numbers, before you run anything: the shape of how you spend new tokens with
your median and p95 marked on it, and underneath, where the waste came from.*

## Compare — which session weighed the most

The menu's second surface ranks your sessions against each other over a time
window (`7d / 30d / all`), in tokens **weighted by model** rather than counted
flat: an Opus token and a Haiku token are not the same thing, and the raw total is
97% cache re-reads, so an unweighted ranking just sorts by how long a session
stayed open.

A row is three stacked lines — the prompt, every fact about the session on one line
(project, the model its main thread ran on, when it ran, calls, the complete token
count with cache reads included, the subagents' share), then the bar at full
width — and the bar carries two facts at once: its length is the session's weight,
its segments are the model mix, so *how heavy* and *why* are one object.

Sessions the weighting moved by 3 places or more say so (`▲N vs unweighted`), the
sessions below the cut are still summed rather than quietly dropped, and **clicking
a row opens that session's own tab**, so the leaderboard is the way in and not just
a report.

The weights per kind of token are Anthropic's own published burndown rates; the
ratio between models is derived from the price list and marked as ours, since
Anthropic publishes none. It is a **token count, never a cost in dollars**, and it
never invents an "equivalent" unit — a permanent *how this is computed* block
explains the number instead of a label nobody could interpret.

![Compare: five sessions ranked by tokens weighted by model, each row carrying the prompt, the facts and a bar segmented by model mix](assets/shots/compare-leaderboard.png)

*Each bar says two things at once: its length is the session's weight, its segments are
the model mix — so the Haiku session's 106.6k tokens weigh less than the Sonnet one's
27.5k. The permanent *how this is computed* block is there because a number nobody can
interpret is worse than no number.*

## Search — find the session that solved it

The menu's third surface: type the two or three words you remember and get the
sessions whose **dialogue** holds all of them — your prompts and Claude's answers,
never the raw transcript (injected instructions, system reminders and tool results
match twice as often and say nothing about what a session was for). Every word is
an AND term.

Rows are ranked by **density** — occurrences per 1k characters of dialogue —
because ranking by raw occurrences ranks session *length*: the longest session wins
a query it barely touched, while the short one that was entirely about it sits
fifth. `occurrences` and `recent` are one click away, and each order sorts by the
number the row prints.

Paste a **commit hash** instead and the search also asks git which session produced
it — the hash of a commit lives in the output of the command that made it, which
the dialogue index excludes, so the session that did the work is exactly the one
text search misses (measured: 29% of commits). Same rows, same order, only more of
them. A **tracker id** (`ABC-12`, `#42`) works the same way and for the same
reason: a session can work a card for an hour without ever typing its key, because
the id lives in the tool call. That one is answered from its own index — 68 ms over
716 sessions — and a text search never pays for it.

Each row shows the passages that matched, attributed to **you** or **claude** and
highlighted, and carries two ways out: **open the session in a tab**, or take its
**full session id** — spelled out on the row, one click to copy — for
`claude --resume`; the same chip makes the picker's id copyable too. Automated
`sdk-*` runs are kept aside behind a control that states its own count, never
dropped, and nothing is truncated. The index is seedeep's own file, incremental and
built on demand: ~20 MB of dialogue over a thousand sessions, tens of milliseconds
per query. Full rules: [`search.md`](search.md).

![Search: the sessions whose dialogue holds every word, each row showing the matched passages attributed to you or claude](assets/shots/search-results.png)

*Two words, and the ranking is the point: the SHORTEST session is first, because it
mentioned them once in very little dialogue. Ranking by raw occurrences would have put
the longest session on top, which is how a search comes to answer with the session you
were not looking for.*

## The menu-bar tray

The same signal where you are already looking. The icon **turns while a session is
working**, goes **amber, and still, the moment one stops and needs you**, and
**red when one of them breaks** — motion means *running, nothing for you to do*, so
the thing you can act on is the thing that holds still, and a session whose call
failed outranks one merely waiting, because an approval resumes the instant you
answer it and a failed call does not resume at all.

A notification when either happens, and optionally one when a session finishes,
with the agent's last words. A click opens a small panel of your live sessions
ordered by urgency — **Broken**, *Needs you*, *Working*, *Idle*: what each one is
asking for or what failed, what it says it is doing, its newest call, how full its
context is. Only the sessions a person is actually in — headless `claude -p` runs
never appear.

It is a **pure HTTP client** of the same API the browser uses: it parses no
transcript and owns no reducer, so the meaning it shows is the server's, computed
once. What it does hold is a handful of presentation rules copied deliberately —
chiefly *what counts as waiting on you* — each pinned to the server's by a test,
because a client that links no code cannot import one.

![The tray panel on a live session: the sessions ordered by urgency, each with what it is doing and how full its context is](assets/tray.gif)

*The same session as everything above, from the menu bar — the one surface that is a
recording rather than a crop, because the tray is a native app and not a page.*

Packaged by CI from a tag into a universal DMG and a Windows `-setup.exe`,
**unsigned**. **Verified on macOS only** — see [Which platforms have actually been
run](../README.md#which-platforms-have-actually-been-run), because this project
does not call a thing measured when it has not been. Full rules:
[`tray.md`](tray.md).

## Local by default, remote on purpose

The server listens on `127.0.0.1` until you say otherwise. Name any other host and
the posture changes as a whole: HTTPS on a self-signed certificate whose
fingerprint is printed on every start and copyable from the settings panel, so a
client that cannot click through a browser warning can pin it, and a Bearer token
on every API route.

Configuration lives in `~/.seedeep/config.json` — CLI flag over environment
variable over file over default — and the settings panel edits it in place. No
tunnel ships with `seedeep`: an SSH port-forward or a VPN already solves that, and
re-solving it would only add a second, weaker way in. How to turn it on:
[`install.md`](install.md#remote-access).

## The engine underneath

- **Core engine** — read-only, runtime-agnostic watcher + parser: session
  discovery, incremental tailing, and a normalized per-session event stream
  (context fill, attribution, compaction, subagent tree).
- **Local server** — serves a page and streams live events to the browser over a
  single multiplexed SSE feed, plus a read-only session roster and a read-only
  replay stream for finished sessions.
- **GUI shell** — one tabbed page, where the tabs are a workspace: a session that
  starts gets a tab by itself — **once**, so one you close stays closed — named
  `<project> · <first prompt>` so two sessions of the same project read apart, and
  the open set, its order and the active tab all survive a refresh. State is shown
  rather than spelled: the dot's pulse says a session is generating, it goes
  **amber when the session is stopped waiting for you** (an approval, or an
  answer), **red when its last API call failed**, and a finished tab goes quiet. A
  **searchable session picker** (a glass combobox) labels each session by its first
  prompt with a model chip and relative time, pins the ones already open, and
  splits **Human / Automated** so headless `sdk-*` runs stay out of the way — with
  replay for finished ones, and per-tab subscription over the shared feed with no
  connection leak.
