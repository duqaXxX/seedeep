# What seedeep shows

The full tour of every surface, and the reasoning behind the ones whose rules are
not obvious. `seedeep` is under active development; everything on this page is in
the current release.

The README is the short version. The design behind these surfaces is in
[`architecture.md`](architecture.md); what changed when is in
[`CHANGELOG.md`](CHANGELOG.md).

> Every figure below is a **cropped still of a synthetic session** on a fictional
> project, cut by `bun run doc-shots`, never a screenshot somebody took. Most come
> from a real recorded session, replayed. The rest come from a written transcript
> (`apps/server/scripts/doc-scenes.ts`), because some states cannot be provoked on
> request: an API call does not fail when you ask it to, Claude Code refuses to
> compact a small session, and a retrospective is about a corpus rather than a
> session. Those transcripts are synthetic in content and faithful in shape (the
> same rule the test fixtures follow) and each is run through the real parser and
> reducer by a test that asserts the state its figure claims.
>
> Each figure is declared in `apps/server/data/doc-shots.json` with the source files
> that invalidate it, so `bun run doc-shots:check` can name the ones a change may
> have made false. Nothing else can: no test looks at a PNG. What it names are
> **candidates, not verdicts**: the map is per-file and `client/graph.ts` draws every
> widget, so a single edit there names most of them at once. Whether a figure really
> went false is the author's call (did what it *shows* change?), and
> `bun run doc-shots` re-cuts it: `--ids <shot>` for one figure, nothing for all.
> `--verify` settles it by re-cutting the suspects and **comparing the pixels**, but it
> costs minutes, so it belongs to a release rather than to every push.
>
> A release is not a reason to re-cut anything. The two Settings figures print the
> server's version, so a release does date them, but a figure documents the surface it
> photographs, not the version that happened to be running, and a stale number in it
> makes nothing it claims false. The only thing that invalidates a figure is a change to
> what it SHOWS.

## The workspace — one tab per session

seedeep is one page holding **a tab per session**, and the strip across the top is
where you find one at a glance. A session that starts gets a tab by itself,
**once**, so one you close stays closed, named `<project> · <first prompt>`, which
is what keeps two sessions of the same project apart. The open set, its order and
which tab is active all survive a refresh.

State is shown rather than spelled, because the words would eat the room the
subject needs: the dot **pulses** while the session is generating, turns **amber**
when it has stopped and is waiting for YOU, and **red** when its last call to the
model failed and nothing has succeeded since. A finished session goes quiet and its
whole tab dims, which is a property of the tab rather than a badge on it. The three states
share one dot: they answer the same question, and a second marker would
turn the strip into a dashboard. Hovering spells out what the classes say, and gives
a cut label its full text back.

To open one that has no tab, the **session picker**, a glass combobox at the end of
the header. Type to filter over the prompt, the model, the project or the id; every
row leads with the session's own first prompt, next to a model chip and how long ago
it ran. Sessions already open are pinned, and the roster splits **Human** from
**Automated**, each side carrying its live count: headless `sdk-*` runs are the bulk
of what a working machine accumulates, and unsplit they bury the handful of sessions
anyone actually picks.

The fixed surfaces (Home, Compare and Search) are not tabs, because a tab is a
session: they live in the header menu (☰), left of the wordmark.

## The live session view

A live-first cockpit: the **Context** card, a dial and a real token breakdown,
next to the live monitor (**Subagents · live**: the running subagents, each with its
context filling in real time and its current action), and the **Live activity** feed
filling the right: the two live signals at a glance. When what the session has
running is background commands rather than subagents, that card is titled
**Running · live** and monitors those instead: same place, same question, whichever
kind of work is in flight.

<img src="assets/shots/context-dial.png" width="459" alt="The context card: 263.1k of a 1.0M window, 26%, split by cache read, cache write and input">

*The number is the whole point, so it is the biggest thing on the card. The bar
below it is the same figure split by what it is made of, mostly context read back
from cache, which is billed too.*

### NOW — what it is doing, in one line

Between the **Live activity** header and the feed sits the panel that answers the
question you actually opened the tab for. Its label says which kind of answer it is:
`now` while something is happening, `output` once the turn's final answer has
landed, `intent` for the words a settled turn left behind, and **`waiting for you`**
when the session has stopped on you.

What it shows, in order of preference, is the agent's own words: the narration it
just wrote, or the turn's result, held long enough to be read and clamped to two
lines, with **more** opening the full text. When there are no words to quote it says
what is true instead of going blank: which tools are running and for how long, or
`Started — no output yet`, or that a subagent is running in the background, or that
one has returned and the turn is working on the result. It never says
"waiting" for any of those: that word is reserved for the opposite state, the one
where the session is stopped on you.

A turn that is neither running nor left any words behind has no *now* to report, and
the panel is simply not there.

### The activity feed, and every call to the model

The feed interleaves the **API calls** themselves with the tools each one
triggered, every call carrying its latency. Click a call to read its **input and
output** on demand: the model's text and tool args, plus the per-call token split
(cached context vs what was new) and the reasoning **effort** that call ran at,
where Claude Code recorded one.

![The activity feed: API calls with their latency, each followed by the tools it fired, subagent work tagged as such](assets/shots/activity-feed.png)

*Read it top to bottom: every `API call` carries the time it took, the tools it
fired sit under it, and anything a subagent did is tagged `SUBAGENT`. The panel at
the top is the model's own last words, the turn's output as it arrives.*

### Toasts — what just happened, without looking away

Two rails announce events as they fire, and they are split by what you do about
them. **Tools and verdicts** rise in a column on the right; **subagent spawns** run
along the bottom, where a fan-out reads as a row rather than as a stampede down one
side. Each rail holds five at most and evicts its oldest, so a burst is bounded by
construction.

They are timed by how much there is to take in: a tool toast is a **1.5s** glance, a
spawn stays **5s**, long enough to also name the **model** it runs on, filled in the
moment that becomes knowable, since three quarters of subagents run on a different
model than the session did, and a verdict announcement holds **8s**.

**Every tool toasts.** The single exception is `Agent`, and it is routing rather
than suppression: a spawn already has the richer toast on the bottom rail, so a bare
`Agent` up top would be the same event twice.

### How much work it took, before you look for it

The bar above the widgets answers the size of the session in one line, in **two
groups**: how much work (turns, API calls, tool calls) and how long: the current
turn, and every turn summed. The grouping is the readable part: five figures with
four different units, set side by side without separators, read as one number with
stray words in it. Selecting a turn re-scopes the bar to that turn, with the same
two counts scoped along. Each count is named for what it counts (`33 API calls`,
not `33 calls`) and hovering the group glosses them in the order they appear, which
is the only place that can say the number leaves the subagents out.

Both counts already existed, the calls under the token ledger and the tools under
four file paths in Main tools, and neither could be found, which is a placement
problem and not a missing figure. The breakdowns stay where they are: `Bash 255 ·
Edit 104 · Read 23` means something next to the tools that consumed the context,
and nothing at all in a summary line.

### Which model, and how full that makes it

Whatever scope you are looking at names the model it ran on, the banner and
the Session card both, because that model *is* the context window's denominator: a
session that switched shows the one in force now and what it was before, so a
changed window can never look like a full one. `/model` mid-session moves the bar,
because 1M and 200k are not the same bar.

<img src="assets/shots/subagent-windows.png" width="459" alt="Three running subagents on sonnet, haiku and opus, each with its own context bar: 2% of 1M, 8% of 200k, 1% of 1M">

*Three subagents of one turn, and three different denominators: the Haiku one is
measured against 200k while the other two run on 1M. 15.6k is the smallest of the
three figures and the fullest window on the card, which is why a percentage is
worth nothing until you know what it is a percentage of.*

While a turn is open its **elapsed counts up**, and the session states how long it
has **worked**: the sum of its turns, not the wall-clock span. The two differ by
3× in the median session.

### The stats strip

Three equal-height cards: **Session** (tokens by API category plus turn KPIs),
**Skills used** beside **Commands**, and **Changed files**.

In the Session card the **Output** row splits into reasoning and answer, so the figure is
no longer one number whose larger part is not the answer: over 22,995 calls measured on
2026-08-29 the reasoning is 39% of output on a median call, and above 80% on a tenth of them.
The same split is in the call drawer, where it is one call rather than a session's average.

In the Session card the main-thread categories are headed *main session*, and the
**Subagents** figure below them opens into a **by-model** bar, so the subagent tokens
split by which model actually burned them (charged per call, so a subagent that ran
on two models shows as two), never mixing in the main thread.

<img src="assets/shots/session-tokens.png" width="459" alt="The Session card: 2.9M tokens billed, 2.5M of them cache reads, and the subagents split across sonnet, haiku and opus">

*One turn billed **2.9M** tokens, and **2.5M** of them are context read back from
cache, the figure a session's own footer never shows you. Below it, the subagents'
~140.9k split by the model that actually burned it.*

**Commands** chips are clickable: each opens a drawer listing every turn the
command was typed in, with its per-turn count; clicking a turn scopes the whole
view to it. **Skills** chips open a drawer showing model invocations (times the
model called the Skill tool) and active turns, distinct from user-typed
`/commands`, which appear in Commands.

<img src="assets/shots/skills-commands.png" width="459" alt="The Skills and Commands card: the code-review skill, and the model, compact and code-review commands with their counts">

*Two different things, deliberately kept apart: a **skill** the model invoked, and the
**commands you typed**. Each chip opens a drawer listing the turns it appeared in.*

The **Changed files** widget answers *what did this touch*: a total plus a
proportional bar per file extension, counted from **git**: the files of the
commits that session produced, so the number is one you can reproduce with
`git show --stat`. Its description names the commits it counted, and a session that
has not committed says so rather than showing a figure nothing can back.

Counting Claude Code's own file-history ledger instead would under-report badly:
it records only what CC's own editing tools wrote, so a file rewritten by a shell
command or produced by a build is invisible to it. And which session made a shell
write is recorded nowhere at all, so it is never guessed. The ledger is still read for the one thing git cannot see, the
per-session scratchpad Claude Code uses for throwaway scripts, which lives outside
your repository and gets its own row instead of inflating the total. A page the
session published with the Artifact tool gets a row of the same kind: it is not a
file that changed, it is something put online, and the link is the only part of it
that outlasts the session. Expand the card for the complete list, project first
then scratchpad, narrowed by a path filter and by type, with the published pages
listed under it as links. Full rules: [`session-output.md`](session-output.md#changed-files).

<img src="assets/shots/changed-files.png" width="459" alt="The Changed files card: four files in two commits, split by extension, and a row saying one artifact was published">

*Four files, and the description names where the number came from: `Files in 2
commits`, which you can check with `git show --stat`. Under the bars, the page this
session published: not a file that changed, so never part of the count.*

### The output row — Main tools · Commits · Cards

At 50/25/25: what the session ran to get there, what it shipped, and what it was
working on. All three are always on the page, because a widget that appeared only once it
had content could not report that there is none, so Commits and Cards carry their
own empty state instead.

- **Main tools** shows the top output-size hogs at a glance; expand it to browse
  every tool call with a **live filter** (name or file path, instant) and a **sort
  toggle** (`size ↓` by output, `time ↓` by duration slowest-first). Every row
  shows the tool name, the turn it ran in, a proportional bar, and the value
  (chars or ms).

  The full list is **grouped by turn**, each group collapsed behind a header
  stating how many calls it holds and how much output they cost, so the question
  "which turn ate the window" is answered before you open anything. The size
  ranking lives INSIDE the group, which is what keeps the ranking and the
  chronology from having to fight over one list. Every row carries a `#N` fixed in
  the order the calls were made, so it does not move when you re-sort.

  ![Main tools: four Read calls of 23k characters each at the top, then the tool types as counts](assets/shots/main-tools.png)

  *Four reads of the same file, 23k characters each, are most of what filled the
  window in the figure above, which is the kind of thing you only argue about once
  you can see it.*
- **Commits:** the commits that session produced, each opening on GitHub or
  GitLab, or marked `local` when it is not pushed. Attributed from the commit's own
  hash in the call that made it, so two sessions working on one repo never claim
  each other's work. Full rules: [`session-output.md`](session-output.md#commits).

  <img src="assets/shots/session-commits.png" width="344" alt="The Commits card: two commits, both marked local, each with its short hash and subject">

  *Two commits, and neither has been pushed, so the card says `local` rather than
  offering a link that would 404. The hash is the proof: it is the one the session's
  own `git commit` printed.*
- **Cards:** the tracker cards the session touched, each opening on its tracker.
  Read from the calls that named them, never from a key typed in a prompt, where
  most key-shaped strings name no tracker at all (`GPT-4`, `UTF-8`). A row says
  whether the session **changed** the card or only **read** it. Full rules:
  [`session-output.md`](session-output.md#tracker-cards).

  <img src="assets/shots/tracker-cards.png" width="344" alt="The Cards card: two tracker cards with their titles, one badged read, the other changed by the session">

  *Two cards: one the session changed, one it only looked at. The `read` badge marks
  the second, and the description counts both.*

### The subagents grid

The full grid sits below, in launch order. Click a subagent to see its launch
prompt, the tools it called, and, the point of the card, **the verbatim output it returned to
the main session**.

![Six subagents in launch order, three done and three running, each with its model, volume, context and what it returned](assets/shots/subagents-grid.png)

*Six subagents of one turn: the three that finished carry what they returned, the
three still working carry `running`. Each names the model it actually ran on, and
each is measured against that model's own window.*

<img src="assets/shots/subagent-drawer.png" width="549" alt="A subagent's drawer: model, duration, tool calls, what it returned, its launch prompt, and the verbatim text it handed back">

*The drawer, scrolled: what the parent asked it to do (`LAUNCH PROMPT`), and under
it `RETURNED TO MAIN`: the text the main session actually received, verbatim. The parent's
own log holds only the tool call and its result, so this text is not in it.*

A subagent appears the instant it is **launched** (not when its transcript shows
up) and stays `running` for as long as it really works, since background subagents
included, which is now Claude Code's default. It ends as `done`, `failed` or
`killed`; `unknown` means seedeep never learned its fate rather than pretending to
know. A **workflow run** takes one aggregate row: fleet size, how many of its
subagents are still working, tokens, and the model breakdown, instead of flooding
the grid with the ~100 it spawns.

#### Background commands share that card

A session launches shell commands into the background as readily as it launches
subagents, and each one gets a catalogue row that outlives it, so a command that
**failed** is still there to be found, which is the one thing you needed to be told.

The card holds both lists behind two tabs, and it grows them only when both have
something in them: with commands and no subagents (or the reverse) it is simply
the one list, with no switch to press. The tab you land on is always Subagents, since a
default that moved on its own would leave you unsure what you were reading, and
the closed tab carries **its count and its failures on its own label**, so nothing
that needs attention is hidden behind an unmarked door.

![The bottom card on its Background commands tab: six commands in launch order (two done, two failed with their exit codes, one still running and one monitor carrying its event count) beside a Subagents tab carrying the count of the other list](assets/shots/background-commands.png)

*The same card, switched to its other catalogue. The tab you are not on carries its
own count, and its failures with it, so nothing is hidden by the tab that is closed.*

A command reaches the background three ways, and the rows say which when it is not
the obvious one: the agent asked for it, **the call's own timeout** promoted a
foreground command that was still running (two minutes by default, and the agent can
ask for up to ten), or **you** pressed `Ctrl+B` and took it away from the agent. The first is what a background command already means to a
reader, and it is much the commonest, so its rows stay bare; the other two carry a chip,
`auto-backgrounded` and `backgrounded by you`, on the live row, on the catalogue row
it becomes, and in the drawer both open. A command whose receipt is too old to say
which it was gets no chip, rather than a chip that might be wrong.

Each command is one line: what it was launched to do (Claude Code's own
`description`, the name it quotes back when the command ends), its state, the turn
that started it, its exit code, and **how long the command itself ran**, not the launch
instant to the notification that ended it, which for a killed build can be hours.
A command still running has no duration to state, so it states its **age** instead,
ticking, exactly as the live row above does: one command described two ways on one
screen was a discrepancy, not a nuance.
The row's duration is never the launch call's, which closes in milliseconds and
measures nothing, and never the SECOND copy of the notification either: Claude
Code writes it twice, and the later copy is written when its queue drains, long
after the command actually stopped.

A `Monitor` is one of these commands. It is Claude Code's watcher, a `tail -f`
on a build log or a poll of a CI run, and it behaves like any background command:
armed once, running for as long as it watches, ended by a notification.

What ends a monitor is not what ends a shell command. A background `Bash`
announces its own death twice over: a notification, and the moment it lets go of
its output file, which is what seedeep asks the machine when the notification never
comes. A monitor does neither: it holds no file open, and stopping it writes no
notification at all. What it does write is the `TaskStop` itself,
*"Successfully stopped task: …"*, naming the task,
and that sentence is what closes the row. Without it a monitor you stopped would go
on calling itself *still running* for the rest of the session.

A monitor also does something no other command does: it **reports while it runs**.
Every line its script emits is an event, and the row says how many have arrived and
shows the latest one under the title. Only the latest: a monitor's stream in the
activity feed would leave room for nothing else there. The count is what tells a
monitor that is working from one that has been silent since it was armed.

Its drawer adds the full command, the sentence Claude Code wrote when it ended (the
only place the exit code exists) and the **output file**, the path where the
command's output was written. The notification that ends a command carries it in a
tag of its own, and the launch receipt carries the same path in prose (`Output is
being written to: …`), which is what makes it readable for a command whose end is
never written at all.

A scheduled wakeup shares the band, and it is not a command. When a session paces
itself (a `/loop` with no interval), it arranges to wake itself up later, and nothing
runs in the meantime, nothing holds a file open, there is nothing to probe. It is a
commitment, so it gets a row of its own, amber rather than green, saying when it will
wake and how long that is from now.

The row stops being drawn the moment its instant passes, and that is deliberate:
Claude Code writes **nothing** when a wakeup fires: no line, no marker that tells it
from any other system message, so seedeep can say what the session is waiting for and
never that it happened. A countdown running into the negative would be claiming a wait
that is over; saying "fired" would be claiming knowledge that is not on disk.

A command whose end **Claude Code never wrote** is the one row seedeep cannot read
off the transcript: some launches get no notification ever, and the rule "launched,
nothing said" means *still running* for as long as the session stays open. seedeep
asks the machine instead, since nothing holding its output file open means the process
is gone, and the row reads **`unknown`** with its duration as a bound
(`≥ 4m 20s`, the last instant it was seen alive). Never `done`: the check learns
that something stopped, not what it stopped with. The mechanism is in
[`docs/architecture.md`](architecture.md#is-a-background-command-still-alive).

The cockpit above keeps its half of the job, and only that half: it draws **what is
still running**, and nothing else. A command that failed or was never reported is
*counted* there and never drawn: the line reads `2 commands failed below · 1 never
reported below`, the same way that card already points at a subagent that has
finished. A card headed LIVE must never list the dead. The count is what keeps the
failure from vanishing in silence; the catalogue below is where it is actually
stated.

Every entity (subagent, tool call, tool type, API call, skill) opens a **detail
drawer**; drill-down clicks (e.g. a tool inside a subagent's drawer) show a
**breadcrumb** so you can navigate back without losing context.

The view reconstructs identically live and in replay; an **ended** session drops
the live chrome: the monitor collapses to a one-line summary, and the LIVE badge
yields to a quiet "ended". That state is not final: `claude --resume` continues the
SAME session, so when its process comes back the tab you already have goes live
again by itself: the dim lifts, the badge returns, and the tab reads the lines
written while it was frozen. Nothing has to be reopened, and no refresh is needed.

## The turn as a lens

The **Timeline**, the strip across the top of the session, shows **everything you
sent**, typed prompts and slash commands alike, and colours each entry by what it
actually cost: a round of work (green
while it is burning tokens, red if you hit Esc), a context event (`/clear`,
`/compact`, a compaction), or a local command that cost nothing.

![The timeline: eight things sent, coloured by what each cost: a work turn, a grey local command, a red interrupted turn, a violet compaction](assets/shots/timeline-strip.png)

*One column per thing you sent, and the colour is the cost: green while a turn burns
tokens, **red** where Esc cut one off, **grey** for a local command that cost nothing,
**violet** for a `/compact`. The filter chips above count what is worth filtering to.*

Click one and **every widget re-scopes to it**: context, token usage, tools,
subagents, skills, commands, and the activity feed. Prompts and results open in
full, rendered as markdown. On an interrupted turn this shows
everything it consumed with no answer to show for it.

## A verdict on every turn, both faces

Seven deterministic checks (no LLM) score each turn for waste: a subagent that
returned a large output, a mid-turn compaction, a second Esc in a row, a **cold
resume**, a context window ≥70% full, an **exploration** that read many files and
changed nothing, or code **committed with no check** run anywhere in the session.

Every check quotes the public Claude Code documentation that justifies it,
including the one that says a *single* Esc is the recommended behaviour, not waste.
No check compares a turn to your other turns: how BIG a turn was is not the same
as waste.

The resume check is the one that separates *what a turn did* from *what it paid to
come back*: a turn re-opened long after the cache went cold re-creates its whole
prompt before doing anything, and that is charged to the resume, not to the work.

The verdict also names what a turn did RIGHT: ran a check before committing,
delegated the exploration to a subagent, had its work reviewed by one. A wasteful
turn raises a non-blocking toast the moment it closes; the timeline's **Verdict**
lens then dims every other column and lists, per turn, what went wrong, what it
cost, and what went well.

![The Verdict lens over the timeline: two flagged turns, one for reading nine files and changing nothing, one for a subagent that returned 7.8k characters](assets/shots/verdict-lens.png)

*The lens dims everything else and names what each flagged turn did: one read nine
files and changed nothing, the next pulled a **7.8k-character** subagent report into
the main context. Both are lower bounds: a check says only what it can prove.*

### One turn, as a card you can post

**⇪ Share**, on every row of the lens and on the banner of a turn you have scoped
into, renders that turn as a PNG: what it spent, that figure against the p50, p90
and p95 of its own bucket, every finding with its price, what it did right, and a
strip of what the turn actually DID (API calls, tool calls, subagents, tokens
re-read from cache, the model and its effort). A verdict with no activity behind it
is unreadable to anyone who was not in the session. With too few turns to have a
baseline, the card says exactly that instead of inventing a multiple.

<img src="assets/shots/share-card.png" width="620" alt="The share card of one turn: 2.7k tokens spent, one critical finding about a subagent that returned 7.8k characters, and a strip of turn, duration, API calls, tool calls, subagents, cache reads and model">

*The card of the turn the lens flagged, in the preview that opens first: **⬇ Download**
is a separate click, so a card you did not mean to make never reaches your disk. The
button belongs to the turn it sits on, never to whatever the view is scoped into,
the turn you are reading is always the turn the card describes.*

Nothing in the card can name your work, and it says so along its own foot: no
prompt, no file path, no project or session name. The only word that comes from
your setup is the *type* of a subagent a finding quotes (`general-purpose` above).
So it can be posted without reading it through first.

The page draws its own PNG, from the data it is already showing: no server, no second
browser, nothing sent anywhere, which is also why it works from the compiled
executable, where a headless Chrome could never be bundled.

## When a session is waiting for YOU

A session stopped at an approval dialog (or an `AskUserQuestion`) is normally
indistinguishable from an idle one, because nothing about it reaches the logs. seedeep
reads it from Claude Code's own live session state and shows it: the tab dot turns
**amber**, an amber toast announces it, and the Live activity's NOW panel says what
it is waiting to approve and for how long, clearing itself the moment you answer.
seedeep only *shows* it; it never answers for you.

A session whose host publishes no state of its own (the desktop app's
**Code** tab, a headless run) has this read off its transcript instead. That
reaches a question the model asked you, and not a tool waiting for your
approval: a call awaiting a yes and a call that is running are the same line,
so such a session reads as working rather than amber.

![The NOW panel in amber: waiting for your approval in the terminal, 5s ago](assets/shots/waiting-on-you.png)

*Amber means the session cannot move until you do, and the age keeps counting so a
minute lost is a minute you can see. This state is the one thing in seedeep that
comes from outside the transcript: it is in Claude Code's live session file, which
is why a stopped session looks exactly like a thinking one everywhere else.*

## When a session is BROKEN

An API call that fails (an expired login, a session limit, an overloaded server)
ends the turn and leaves the session sitting there. It is the quietest failure
there is: the error is the last line the transcript carries for that turn, and
nothing on screen says so.

seedeep makes it a state rather than a passing message: the tab dot turns **red**,
the menu-bar icon turns red above every other signal, the tray panel files the
session under **Broken** with the message Claude Code itself showed, and a
notification says which session broke. It clears itself on the next call that
succeeds, never on a timer.

![The feed of a broken session: the last API call carries the message Claude Code showed, and nothing follows it](assets/shots/broken-session.png)

*The last thing this session ever wrote. The message is Claude Code's own, verbatim,
seedeep never paraphrases what failed, because the wording is what tells you whether
to wait, log in again, or switch model.*

## Failures stand out

A tool that failed or an API call that errored (rate limit, auth, prompt too long)
carries a red badge wherever it appears (the Live activity feed, both Expand-all
lists, and the drawer) and reddens its Trace span, with a folded round/chapter
flagged red so a failure buried in a collapsed group is still visible. A tool the
*user* refused (an Esc on the permission prompt) is not a failure and is never
flagged.

![The feed with a failed Read carrying a red ERROR badge, and the calls around it succeeding](assets/shots/failed-tool.png)

*The badge sits on the row itself, so a failure is visible without opening anything,
and the call after it succeeded, which is why this is a badge and not a session state.*

## When something else has a warning for you

Hooks and plugins can attach text to a session, and it is text nobody generated for
your benefit twice: a security plugin objecting to what was just written to a file, a
background review reporting what it found. In the transcript it lands among the
bookkeeping every tool produces, where a real warning about a real file would
otherwise pass through a session and leave no mark on any surface.

seedeep shows it where it belongs, and *where* depends on what it is about:

- **A note about one call**, the common case, and the security plugin about a `Write`
  or an `Edit` is nearly all of it, marks that call. A ⚑ on its Trace block, a chip in
  its drawer, and the text itself in the drawer, verbatim, above the call's own
  arguments. It is a warning about what that call did, so it sits with the call and
  nowhere else.
- **A note about the session**, work that ran with no call of its own like the
  background security review, goes into the activity feed, because there is no row it
  could be attached to. Pinning it on whichever call happened to be open would be an
  invention. The feed is a glimpse, though: it holds thirteen rows per turn, and a
  finding you have to catch within ten activities is one you will miss. So the note is
  **also in Expand all**, the turn's complete history and the one list with no cap, in
  time order, which lands it right after the call that provoked it. It is the only row
  there that is not a call, so it is named in amber and carries no duration.

Either way the whole text is one click away: a row shows one ellipsized line, the
drawer behind it shows what was written, verbatim.

![The drawer of a Write the security plugin objected to: a flagged chip beside the tool call, and the warning verbatim above the file the call wrote](assets/shots/hook-note.png)

*The note sits above the call's own arguments, because it is about what that call did.
The chip in the eyebrow is what tells you there is something to read before you open it.*

Nothing here is modelled as "a security finding". What the transcript records is that
something had text to say, and the writer names itself in it: a plugin, a hook you
wrote yourself. A feature keyed on one plugin's name would go blind the day another one
speaks.

The marks are amber rather than red. A warning and a failure are separate states, and a
row can carry both.

## Nothing is hidden from you

The Live activity card streams the most recent events, but it can only hold
thirteen, which an ordinary turn already exceeds. **Expand all** opens the
complete list: every prompt, API call, tool, skill and spawn in the order it
happened, with each subagent's own work indented under
the spawn that launched it, filterable, and scoped to whatever turn you have
selected. Every row opens the same detail drawer as the rest of the app.

Across the whole session that list is thousands of rows, so it arrives **grouped
by turn**: one collapsible header per turn saying how much is inside, and only the
most recent one open. Nothing is hidden: a group builds its rows the moment you
open it, and typing in the filter opens every group that has a match. What you
opened stays open: following a row into its detail and coming back by the crumb
returns you to the list as you left it, and until you open one yourself the
newest turn is the one that greets you, however far the session has moved on.
Scoped to a single turn there is nothing to group by, and the list stays flat.

<img src="assets/shots/expand-all.png" width="549" alt="The complete activity list: 46 activities, 19 tool calls, 24 API calls over 3m32s, with each subagent's API calls and reads indented under the Agent spawn that launched them">

*Forty-six activities where the card itself holds twelve. The three `Agent` rows
are spawns, and what each subagent did sits indented underneath: its own API
calls and reads, tagged with the agent type, in the order they happened.*

## Trace — the whole session as one flow diagram

Opened from the Live activity card: a vertical spine of turns, each expanding in
place into the strip of what actually happened.

![One turn in the Trace: 41 steps, one failed, folded into two chapters, a spawn block for three parallel subagents, and the closing round](assets/shots/trace-chapters.png)

*One turn, 41 steps, and none of them hidden: the two grey blocks are chapters,
`R1–10` and `R11–18`, that expand in place, while the landmarks stay out where you
can see them. The teal block IS the spawn of three parallel subagents, the red edge
on the first chapter is the failed step inside it, and the row above says `1 failed
step` so a failure folded into a group is still visible from outside.*

Built to stay readable at real scale (a turn can hold hundreds of steps):
consecutive rounds of work fold into **chapters** you expand in place, while the landmarks,
spawns, skills and replies, always stay visible. Live, the newest block glows and the
view follows it; a spawn block IS its subagent (launch intent, tools, real
duration) and unfolds the child's own flow as a parallel lane below, filling
**while the agent runs**. Every block clicks through to the same drawer as the rest
of the app. The full rules live in [`trace.md`](trace.md).

## Checking the numbers yourself

Every figure seedeep draws comes from the session files Claude Code already wrote, so
any of them can be recomputed without seedeep. This is the one that decides how the
retrospective reads, and it takes ten lines:

```python
import json, glob, os, collections
tot, seen = collections.Counter(), set()
for f in glob.glob(os.path.expanduser('~/.claude/projects/*/**/*.jsonl'), recursive=True):
    for line in open(f, encoding='utf8'):
        if '"usage"' not in line: continue
        try: msg = json.loads(line).get('message') or {}
        except Exception: continue
        u, rid = msg.get('usage'), msg.get('id')
        if not isinstance(u, dict) or not rid or rid in seen: continue
        seen.add(rid)                      # one usage block per CALL, repeated on every line of it
        for k in ('input_tokens', 'output_tokens',
                  'cache_read_input_tokens', 'cache_creation_input_tokens'):
            tot[k] += u.get(k) or 0
T = sum(tot.values())
print(f'{len(seen):,} calls, {T:,} tokens')
for k, v in tot.most_common(): print(f'  {k:30} {v:>14,}  {100*v/T:5.1f}%')
```

The `seen` set is the part that matters: Claude Code writes one line per content block
and repeats the call's whole `usage` on every one of them, so summing per line
multiplies the total. seedeep guards the same way, with `newCall`.

On the machine seedeep is developed on, over 770 session files and 34,724 calls on
2026-08-25, that prints 98.4% cache reads and 0.3% output. Your own corpus will not
match those figures, and that is the point of running it.

## Home — your retrospective, from minute zero

First entry of the header menu (☰, left of the wordmark), never closable, and
filled before you run anything: it reads the sessions already on disk, so an empty
workspace never looks like a broken page.

With nothing to show it opens with the REASON, not with a pitch: *"seedeep
needs a Claude Code session. There is none on this machine yet."*, then what to do
(`claude`, in any project) and what is being watched (`~/.claude/projects`), with
the privacy claim attached to the directory that makes it checkable rather than
standing alone as a promise. That box has to be true in three different situations,
which is why it has three forms: a machine with no session, a session that exists
but has closed no turn (*"There are sessions here, none with a finished turn yet"*
and it says the session is watchable **now**, from the picker), and a
retrospective that has not arrived, where the claim about the machine is dropped
because nothing was read. Which form appears comes from the **roster**, never from
the retrospective: the latter counts only sessions that finished a turn, so a
transcript with none is absent there and present in the picker directly above the
box. No count is printed, because the number would be a third way of stating a figure the
page already gives twice.

It answers *how do I actually use this agent*: your median turn against its p95,
the tokens spent (the COMPLETE figure, cache reads included, because those are
billed too), API calls, how many turns wasted tokens, what you abandoned to Esc,
and the hours you spent working.

The hero is the **turn-size distribution**: the shape of how you spend new tokens,
with your p50 and p95 marked on it. Alongside, **activity** follows the time
filter: `7d` draws one bar per day ("6d ago → today"), `30d` one bar per calendar
week over the last ~30 days, and all-time the full weekly cadence, readable three
ways from tabs in the card: `tokens` (the volume of work), `turns` (split crit /
warn / clean), and `hours` (time actually worked).

Below: where the waste comes from, tokens split by the model that spent them
(**subagents counted under their own model**, so a Haiku explorer inside an Opus
session shows up as Haiku), tool calls by type, and the verdict split. A
`7d / 30d / all` filter switches window instantly, since all three ride in one response,
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
overwhelmingly cache re-reads, so an unweighted ranking just sorts by how long a
session stayed open.

A row is three stacked lines: the prompt, every fact about the session on one line
(project, the model its main thread ran on, when it ran, API calls, the complete token
count with cache reads included, the subagents' share), then the bar at full
width, and the bar carries two facts at once: its length is the session's weight,
its segments are the model mix, so *how heavy* and *why* are one object.

Sessions the weighting moved by 3 places or more say so (`▲N vs unweighted`), the
sessions below the cut are still summed rather than quietly dropped, and clicking
a row opens that session's own tab, so the leaderboard is the way in and not just
a report.

The weights per kind of token are Anthropic's own published burndown rates; the
ratio between models is derived from the price list and marked as ours, since
Anthropic publishes none. It is a **token count, never a cost in dollars**, and it
never invents an "equivalent" unit, and a permanent *how this is computed* block
explains the number instead of a label nobody could interpret.

![Compare: five sessions ranked by tokens weighted by model, each row carrying the prompt, the facts and a bar segmented by model mix](assets/shots/compare-leaderboard.png)

*Each bar says two things at once: its length is the session's weight, its segments are
the model mix, so the Haiku session's 106.6k tokens weigh less than the Sonnet one's
27.5k. The permanent *how this is computed* block spells out the
weighting, so the number can be checked rather than taken on trust.*

## Search — find the session that solved it

The menu's third surface: type the two or three words you remember and get the
sessions whose **dialogue** holds all of them: your prompts and Claude's answers,
never the raw transcript (injected instructions, system reminders and tool results
match twice as often and say nothing about what a session was for). Every word is
an AND term.

Rows are ranked by **density**, occurrences per 1k characters of dialogue,
because ranking by raw occurrences ranks session *length*: the longest session wins
a query it barely touched, while the short one that was entirely about it sits
fifth. `occurrences` and `recent` are one click away, and each order sorts by the
number the row prints.

Paste a **commit hash** instead and the search also asks git which session produced
it: the hash of a commit lives in the output of the command that made it, which
the dialogue index excludes, so the session that did the work is exactly the one
text search misses. Same rows, same order, only more of them.
A **tracker id** (`ABC-12`, `#42`) works the same way and for the same
reason: a session can work a card for an hour without ever typing its key, because
the id lives in the tool call. That one is answered from its own index, and a text
search never pays for it.

Each row shows the passages that matched, attributed to **you** or **claude** and
highlighted, and carries two ways out: **open the session in a tab**, or take its
**full session id**, spelled out on the row and one click to copy, for
`claude --resume`; the same chip makes the picker's id copyable too. Automated
`sdk-*` runs are kept aside behind a control that states its own count, never
dropped, and nothing is truncated. The index is seedeep's own file, incremental and
built on demand: ~20 MB of dialogue over a thousand sessions, tens of milliseconds
per query. Full rules: [`search.md`](search.md).

![Search: the sessions whose dialogue holds every word, each row showing the matched passages attributed to you or claude](assets/shots/search-results.png)

*Two words, and the SHORTEST session ranks first: it mentioned them once in very little
dialogue. Ranking by raw occurrences instead would have put the longest session on top,
which is a ranking of session length.*

## The menu-bar tray

The same signal where you are already looking. The icon turns while a session is
working, goes amber, and still, the moment one stops and needs you, and
**red when one of them breaks**. Motion means *running, nothing for you to do*, so
the thing you can act on is the thing that holds still, and a session whose call
failed outranks one merely waiting, because an approval resumes the instant you
answer it and a failed call does not resume at all.

A notification when either happens, and optionally one when a session finishes.
one title and one line, never the detail. A click opens a small panel of your live sessions
ordered by urgency (**Broken**, *Needs you*, *Working*, *Idle*): what each one is
asking for or what failed, what it says it is doing, its newest call, how full its
context is. Only the sessions a person is actually in, since headless `claude -p` runs
never appear.

It is a **pure HTTP client** of the same API the browser uses: it parses no
transcript and owns no reducer, so the meaning it shows is the server's, computed
once. What it does hold is a handful of presentation rules copied from it,
chiefly *what counts as waiting on you*, each pinned to the server's by a test,
because a client that links no code cannot import one.

![The tray panel on a live session: the sessions ordered by urgency, each with what it is doing and how full its context is](assets/tray.gif)

*The same session as everything above, from the menu bar, the one surface that is a
recording rather than a crop, because the tray is a native app and not a page.*

Packaged by CI from a tag into a universal DMG and a Windows `-setup.exe`,
**unsigned**. **Used daily on macOS, and in a VM on Windows**; see [Which platforms have
actually been run](../README.md#which-platforms-have-actually-been-run), because this project
does not call a thing measured when it has not been. Full rules:
[`tray.md`](tray.md).

## Local by default, remote on purpose

The server listens on `127.0.0.1` until you say otherwise. Name any other host and
the posture changes as a whole: HTTPS on a self-signed certificate whose
fingerprint is printed on every start and copyable from the settings panel, so a
client that cannot click through a browser warning can pin it, and a Bearer token
on every API route.

<img src="assets/shots/settings-panel.png" width="549" alt="The settings panel: port 45999, host 127.0.0.1, the auth token redacted behind a Regen button, the access URL, and the version of the server answering">

*The panel as every install starts: bound to `127.0.0.1`, so the token is inert
and there is no certificate to pin, so the TLS block appears only once you name
another host. **Version** is the server that answered this request, not the one
you installed.*

<img src="assets/shots/settings-remote.png" width="549" alt="The same panel on a server bound to a LAN address: a banner announcing remote access, the TLS block with its common name and the certificate's SHA-256 fingerprint, and an https access URL carrying the token">

*The same panel with the host named: the whole second posture in one picture. The
banner is the warning that the browser will meet a self-signed certificate; the
**Common name** is what that certificate is issued for; while it is missing or
unusable nothing in the panel is written at all, so a remote host cannot be
stored without one. The **Fingerprint** is what a client that cannot click a
warning away has to pin. It is the RUNNING server's certificate, so it fills in only
after the restart, and the access URL turns `https` and carries the token. Turning it
on: [`install.md`](install.md#remote-access).*

That version is beside the wordmark too, on every portal, because it is the number a bug
report quotes, and it says which of two seedeeps you are looking at. A portal served
from a **checkout** says so as well, with a `dev` chip and a browser tab reading
`seedeep dev`: both watch the same sessions (the transcripts belong to Claude Code,
not to seedeep), so a dev portal and an installed one show identical content, and the
tab you are about to change a setting in would otherwise be a coin toss. A released
build carries no chip: there is nothing there to tell apart.

Configuration lives in `~/.seedeep/config.json`, with CLI flag over environment
variable over file over default, and the settings panel edits it in place. No
tunnel ships with `seedeep`: an SSH port-forward or a VPN already solves that, and
re-solving it would only add a second, weaker way in. How to turn it on:
[`install.md`](install.md#remote-access).

A server keeps the port, host and certificate name it started with, so a config
changed since, in the panel or in an editor, is a file saying one thing and a
process doing another. An amber dot on the Settings button says so with the panel
closed, and the panel explains it with the button that ends it; the tray says it above
its sessions and `seedeep status` prints it. It is the SERVER's comparison, against
what a fresh start would resolve to rather than against the file alone: a port pinned
by `--port` is not pending, because a restart would go on ignoring the file there too.

## The engine underneath

- **Core engine:** read-only, runtime-agnostic watcher + parser: session
  discovery, incremental tailing, and a normalized per-session event stream
  (context fill, attribution, compaction, subagent tree).
- **Local server:** serves a page and streams live events to the browser over a
  single multiplexed SSE feed, plus a read-only session roster and a read-only
  replay stream for finished sessions.
- **GUI shell:** one tabbed page (the workspace above), with **replay** for
  finished sessions and a per-tab subscription over the shared feed, so a dozen
  open tabs still cost one connection and closing one leaks nothing.


## Notifications

seedeep tells you when a session **stops on you**, when one **breaks**, and, if
you ask for it, when one **hands the turn back**. The server decides all three:
it holds the transitions, the switches and the wording, so a banner and the panel
row it belongs to can never describe one event in two ways.

Each delivery channel has its own switches. The same moment can be worth a
banner on the machine you are sitting at and not worth a push somewhere else, and
one shared set cannot say that. Both sets are edited from the portal's Settings,
the tray's four under *Tray notifies you when*, the webhook's three beside its
URL, because the server is what holds them, and a second place to answer one
question is one place too many.

The **webhook** is off until it has a URL, and it is the only thing in seedeep
that sends session data off the machine (see `install.md`). It POSTs to any
address with your headers and your template (`{{title}}`, `{{body}}`,
`{{project}}`, `{{subject}}`, `{{kind}}`) so ntfy, Pushover, Telegram or a script
of your own all work without seedeep knowing any of them. A URL on its own is
already a working webhook: an empty template posts the body. It never retries: a
missed notification is better than one replayed minutes late.

A notification is one title and one line: which session, and what happened:
`atlas — add a retry to the uploader` / `Waiting for your approval — Bash`. Not the
command awaiting approval, not the error text, not what the turn did. You cannot act
on a banner anyway (approving still means going back to the terminal), a banner
truncates that second line first, and all of it is one click away in the panel. It
also bounds the webhook, the one channel whose payload leaves your machine: it sends
the same title and line, and nothing more.

A turn that ends says **`Turn finished`**, not "finished", because the session has not
ended, it has become yours again. A turn **you** interrupted is never announced:
if you pressed Esc you already know.

An **automated session never notifies at all**, on either channel. A notification asks you to
get up, and nobody is sitting at a `claude -p`: a git hook that runs one on every push would
otherwise announce a finished turn every time. The rule is the picker's own Human/Automated split
(`entrypoint` starting with `sdk`), so the same sessions the picker files under Automated are the
ones that stay silent. The desktop app's **Code** tab is not one of them, since somebody is
sitting at it; what it shares with a headless run is only how Claude Code is driven there.
