# The Trace view

A near-fullscreen modal showing a session as **a scrolling document of turns**:
one full-width row per turn, each expandable in place into the horizontal strip
of what actually happened (API calls, tools, subagent spawns) down to any
single step's drawer. Opened from the **Trace** button on the Live activity
card; scope-aware (whole session, or only the selected turn).

This is the reference for its rules and invariants. Deltas live in
`CHANGELOG.md`; the data pipeline that feeds it is in `architecture.md`.

## Modules

| Piece | Where | Role |
|---|---|---|
| span store | `apps/server/src/core/span-store.ts` | ordered per-turn spans + subagent lanes, fed by the reducer's `onEvent` |
| grouping | `apps/server/src/core/trace-group.ts` | pure: spans → group tree (rounds, chapters, landmarks, live tail) |
| renderer | `apps/server/src/client/trace.ts` | modal, spine, strip, lanes, scroll/follow, lane anchoring |
| drawer routing | `apps/server/src/client/graph.ts` (`openBlock`) | block click → the existing drawer (tool / API call / subagent) |

## The spine

The spine is an `overflow-y:auto` document: one turn row per line, each open
turn's strip below its own header, so the scrollbar, the wheel, the keyboard and
the browser's own find all work natively.

`openBlock` is shared with the Live activity card's all-activity list, which passes it
a `BackEntry` so a drill-down leaves a breadcrumb. The Trace passes none,
its `onBlock` taking only a handle, because the modal stays open behind the drawer and
is still there to return to. A crumb here would offer to "go back" to something that
never went away.

Tests: `apps/server/tests/trace-group.test.ts` (rules), `apps/server/tests/span-store.test.ts` (store,
including live event ordering), `apps/server/tests/trace-render.test.ts` (fake-dom render),
`apps/server/tests/golden-transcript.test.ts` (raw jsonl → real parser → store).

## Why the strip is grouped

A turn can hold hundreds of steps, and at one 172px block each even an ordinary
turn overflows the stage, and zooming out cannot fix it, because text dies before
the strip fits. So the strip renders a **group tree** with in-place expansion
instead of one block per step.

## The grouping rule (hybrid)

- **Round:** one `api` span plus the tool spans it triggered (the literal
  transcript structure). Tools before any api form a leading, api-less round.
- **Landmark:** `prompt`, `spawn`, `result` spans, and tool spans named
  `Skill`, `AskUserQuestion`, `ReportFindings`. Landmarks always render
  top-level, never inside a group.
- **Chapter:** a run of consecutive completed rounds folds into one block,
  capped at **10 rounds** and broken early by any landmark. A run of exactly
  one round stays a lone round block (never wrapped).
- **Parallel spawns:** a run of spawn steps ADJACENT in the strip (nothing
  between them) collapses into one `parallel` item, because drawing them
  left-to-right with arrows asserts a sequence that never happened. Adjacency
  is the criterion, never time: spawns that overlap while work sits between
  them are separate launches and must not merge, and no threshold could tell the
  two apart anyway, since a `tool_use` line lands only when the streaming response
  reaches it, so spawns fired together are written seconds apart. A run of one
  stays a plain spawn block.
- Group ids are stable (`r<n>`, `ch<startRound>`): a live turn's trailing
  chapter grows without changing identity, so a user's expansion never snaps
  shut on update.

## What a group block is CALLED

A round's name is the **intent its own API call stated**: the mid-turn text block
of that call, i.e. the model saying what it is about to do. Round = api + its
tools, and the intent belongs to that same api, so the join is the call id
(`message.id`), never "the last api span": one response is written as several
jsonl lines (thinking, then text, then each `tool_use`), so a slow line would
otherwise name whatever round happened to be open. The api span is always there
when the intent arrives, because the call's FIRST line created it. That is the
intent's own line when the text block leads (a line emits `usage` before its
content blocks) and an earlier `thinking` line otherwise. No parking is needed.

- The number stays the fallback, and that is the common case. Most rounds
  state no intent at all and keep `#7 round`; a named round moves its number to
  the sub-line, where it weighs the same as `2 steps`.
- **Two clamped lines, not the sentence.** A 172px block shows a few dozen
  characters of an intent that runs to hundreds, so the block carries the opening
  and `title` carries the whole text. The clamp is a class (`gnamed`), so CSS
  decides how much shows, not the renderer.
- A chapter counts intents; it is never named by one. Naming a chapter after
  the first intent it folds describes one round out of up to ten as if it
  described all ten. It keeps its range (`R1–10`) and prints `3 intents` in the
  sub-line, dropping `steps` to make room (with all four facts the sub-line wraps
  and grows the block); its `title` lists them in order.
- An intent does NOT break a chapter run the way a landmark tool does: it would
  leave most chapters holding a single round, which is no grouping at all.
- The turn's final answer is never an intent: an `end_turn` text is the RESULT
  (its own span), and naming the last round with it would put the conclusion on
  the block that led to it.
- The reducer keeps only the LATEST narration (the live NOW panel's datum, by
  design). The Trace needs the history, so it lives on the spans, one intent per
  `api` span, and the two never compete.
- The whole text lives in the api block's drawer, as its own `Intent` block
  above `Input`, fetched with the rest of the call from `/api/call-io`, never
  inside `Output`, which a call with tools renders verbatim because its args are
  code. The block is hidden, not omitted, when the call said nothing.
- The span DOES hold the text, and that is deliberate, unlike the turn's own
  text, whose handle carries only an index. A round's label has to be drawn on
  every rebuild, including offline replay, so making it wait on a fetch would
  leave the strip unnamed until the network answered. What the span holds is the
  parser's already-capped narration (2,000 chars), and the drawer does NOT reuse
  it: it re-fetches with the rest of the call rather than keeping a second copy
  of its own.

Group blocks show label (`#7 round` / `R1–10` / the round's intent), counts +
duration, and a type-dot preview. Click expands **in place** (dashed frame, sideways fold cap);
nesting is chapter → rounds → steps. Each turn header carries
`expand` / `collapse` (expand iterates to a fixpoint, so one click opens every
level). They act on this turn's GROUPS; the header's `Close turns` acts on turns.
Expanded groups are **pinned** by namespaced key
(`<turn>:<ns><id>`, since the main strip and each subagent lane have distinct key
spaces) and survive live re-renders; `open()` resets them, together with the
failure cursor and the jump marker, which are keyed by MODEL index and so name
a different turn after a re-open (a scoped open makes index 0 some other turn).

## The turn row

One row per turn, with fixed-width slots that are emitted even when empty: on a
long session the metrics have to line up in columns, or comparing two rows means
re-reading both. Left to right: `T<n> · kind`, title, sparkline,
subagent count, failure badge, duration.

- The sparkline is the turn's SHAPE, not its volume: a count says how much a
  turn did and never what it looked like, so a long tool burst and alternating
  api/tool cycles would read identically. The turn's steps are binned in order
  into at most `SPARK_BINS` (30) slots, and the cap is what keeps the bar bounded on
  a turn of hundreds of steps. The total stays beside it as a number.
- A bin STACKS the types it holds, proportionally (order: `SPARK_RANK`), and
  never picks a winner: one colour per bin cannot describe a mixture, and every
  way of picking one paints a wall of the type that wins almost every bin. A
  failing bin's red band never scales below a third of the bin: one bad step
  among six must still be visible.
- The bands of a bin sum to 1, and that is a contract (`binComposition`, a pure
  function, asserted in `trace-render.test.ts`). A `linear-gradient` holds its last
  colour past its last stop, so a composition that closes early is not a shorter
  bar: it is the LAST type silently taking the remainder, on the row that exists
  to state the shape.

- The left rule is the turn's STATE, not its index: neutral, red when the
  turn holds a failure, amber while it is live. A per-turn hue would say nothing
  `T7` does not already say, and would land on the error colour.
- A row is named by the command AND its arguments, since a command's
  arguments ARE its prompt, and dropping them titles a `/code-review del diff` round
  `del diff`. One rule (`entryText`, `core/tree-format.ts`), shared with the
  Graph's `entryLabel`.
- Nothing is FINAL while a turn is live, unless the session is over. The
  `▲ FINAL RESULT` cap and its block are omitted whenever any round is still
  working AND the session is open (`open`/`update` take `ended`): the last answer
  on record then belongs to a PREVIOUS round, and showing it under that cap says
  the session has concluded when it has not. The second condition is what keeps a
  finished session from hiding its answer, since a round killed mid-flight keeps
  `state: 'live'` for good. It returns as soon as the live round produces its own
  answer.
- A round that DELEGATED is never an idle one-liner. Only a control command
  with nothing behind it (`/model`, `/clear`) collapses to a single line. A
  forked skill (`/code-review`) makes no API call and runs no tool on the main
  thread, so on those two counts alone it would collapse exactly like a `/model`
  while its agent runs for minutes. Its launch is a `system`/`local_command`
  line carrying `<forked-skill-launch>`, not an `Agent`
  tool_use, so `span-store` registers the spawn block from that event and keys it
  by the AGENT id (the only name the launch gives it); the sidecar, which carries
  no `toolUseId` either, resolves through the same key. The round's `kind` becomes
  `work` at that launch, because delegating IS running the model, the same call the
  reducer's `kindOf` makes, so the two surfaces cannot label one round two ways.
  The kind is a GUESS when the turn opens (a `user-turn` carries only its command
  name); the launch is the moment that guess is answered. `isIdle` also requires
  that the round launched nothing, and `isLive` counts a spawn as work in
  progress for the same reason. The round's envelope covers its delegated work:
  the launch and the agent's return both move `turn.t1`, so a ten-minute
  `/code-review` measures ten minutes on a duration bar that is a share of the
  longest turn.
  The spawn span carries `handle.toolUseId` set to that same agent id: the render
  links a span to its block through THAT field alone, so a handle without it
  draws the block with `no child events` while its lane sits in the store. Its
  span is closed by `agent-end`: a forked skill emits no `tool-end`, so nothing
  else can.
- A collapsed turn declares its failures, and says how many. The count is
  computed in `adaptSnapshot` over the main spans AND every child lane, so a
  failure that exists only inside a subagent still reaches the shut row. The
  badge reads `N failed steps`, never a bare "failed": the turn carried on and N
  of its steps did not. Its `title` says so outright.
- The badge is a BUTTON, and it goes there. A count the user wants to click
  and cannot is a dead end, and reaching a failure by hand means opening the turn
  and every group above it, once per failure. Clicking pins the containing groups
  (`groupPathToSpan`) BEFORE the rebuild, since `pinnedGroups` is what survives one,
  unfolds the lane when the failure is inside a subagent, rebuilds, then scrolls
  the block into view and marks it. Repeated clicks cycle the turn's failures
  and wrap. Four rules make the jump hold:
  - **It releases auto-follow.** Jumping is navigation, as deliberate as a
    scroll, and a scroll releases follow, or the next live event would scroll
    the failure straight off screen.
  - The marker is STATE (`_hitSpanId`), not a class written once. Every path
    that redraws a block re-derives it (`applyHit`, called from `renderLanes`), so
    a live rebuild, a turn re-opened by hand or a lane folded and unfolded all keep
    it.
  - It opens a merged parallel run whole, because the run is one block on
    screen: unfolding a single spawn of it would leave the lane under a block
    still reading `▸ expand flow`.
  - Inside a `Workflow` the lane draws a **tile**, not a strip, so the tile is what
    the jump lands on and marks: the spans of a Workflow lane have no block of
    their own.
- A live turn must also hold work. A finished session still reports
  `state === 'live'` on every turn it never closed, and those turns are empty, so
  the amber rule requires api or tool spans.
- Duration is a bar, not only a number: each turn against the longest turn,
  each block against the widest block in its strip (linear: a 96ms Skill beside
  a 5m chapter *should* read as nothing). The row's bar has no axis and no label,
  so it carries a `title` stating what it measures, and it stays **neutral in
  colour**: tinting it red would repeat a signal the left rule, the badge and the
  sparkline already carry. The duration number sits in a fixed-width cell so the
  bars line up down the session; sized to their text ("60s" vs "76m 4s") every
  bar slides.
- A control command that ran nothing is one dim line (`/clear`, `/model`). A
  `work` turn with no api/tool was interrupted with Esc and keeps a full row,
  that is information, not noise.
- The session subject is the first turn that did work. `turns[0].title` is
  usually a control command, which would head the view `/clear` while the picker
  shows the real subject.

## Live behavior

- On a turn with `state === 'live'`, the **tail round stays raw**, with open step
  blocks and never folded, and the newest block glows. Finished rounds fold as
  the next api arrives; chapters close at the cap or at a landmark.
- **Auto-follow** (whole-session open): the view tracks the newest work by
  scrolling the last turn's header ≈20% down the stage; a live turn also scrolls
  its own strip fully right, because the strip grows rightward. A manual scroll
  releases follow; the header's `follow` button re-engages it.
- Ours-or-theirs is decided by POSITION, not by a time window. The controller
  records the `scrollTop` it just set (`_expectedTop`, read back so the browser's
  clamping is included) and the listener ignores an event landing within 2px of
  it. A flag cleared on the next frame is not equivalent: on a busy live session
  `focusLastTurn` runs on every event, so it would be up whenever the user
  happened to scroll, and their scroll would be swallowed as ours.
- `follow` is hidden unless the session is WORKING. Auto-follow acts only
  through `update()`, which a finished session never calls, so there the button
  would merely jump to the last turn, which is `Last turn`'s job and also opens it. A
  control doing another control's job is worse than an absent one. Liveness needs
  real work, not just `state === 'live'` (see the turn-row rules above).
- `update()` restores `scrollTop` after the rebuild, so a live event cannot
  throw a user reading turn 12 back to the top, **and each open turn's strip
  `scrollLeft` with it**. The strip is a SEPARATE scroller: restoring only the
  stage sends a reader back to the strip's first block once a second. The live
  turn is the exception, because `focusLastTurn` scrolls it fully
  right afterwards.
- Blocks appear seconds after the console shows the same activity: a spawn's
  `tool_use` line is written to the jsonl only when the **streaming response
  reaches it**. seedeep reads the file, so this floor is inherent to the read-only
  architecture.

## Class scoping

Every class the renderer writes must be scoped under `.trace-modal`, or a global
rule reaches it: a single-class name like `live` is also the Live-activity
badge's, and it lands on every Trace node carrying it.
`apps/server/tests/trace-css-scope.test.ts` reads the stylesheet
and the renderer as TEXT and fails on any Trace class that a single-class global
rule also targets; a fake-dom test cannot catch this, because it does no layout.
`hidden` is the one allowed collision, a shared utility whose effect is wanted.

The guard only sees what it can extract: `classList?.add('hit')` is invisible to
a regex demanding `classList.`, and a name BUILT at runtime (`'t-' + type`, the
sparkline bins) never appears as a literal at all. Both are covered, the second
by asserting that no global rule falls inside a runtime-built prefix family.
Adding a new way to write a class name means teaching the extractor about it in
the same commit.

## Subagents

- The spawn block IS the subagent. Label = the launch intent
  (`description` → first line of the prompt → agent type); sub-line = agent
  type (model) · tool count · the lane's real duration, never the spawn-call
  ms, which is only a launch receipt. A fan-out spawn aggregates
  (`3 subagents · 12 tools · 5m`).
- **Click the block → the child's flow unfolds** as a parallel lane below,
  anchored under the spawn inside the SAME horizontal scroller as the strip, so it
  stays under its block at every scroll offset and an in-place expansion cannot
  orphan it (`anchorLanes()` re-derives the offset), grouped with the SAME rule
  as the main strip.
  Every lane of a multi-lane spawn renders, each named and clickable. A
  running lane keeps its own raw glowing tail. A Workflow spawn unfolds its
  bundle grid instead. A lane with no child events says so
  (background agents may write no child transcript).
- **ⓘ on the block → the drawer**: the subagent drawer when the agent is in
  the snapshot, else the spawn TOOL drawer (launch prompt, timing), so a click
  is never a silent no-op.
- **Live event ordering** (the invariant that makes lanes fill while agents
  run): the watcher reads a child's `meta.json` and transcript as soon as the
  agent starts writing, BEFORE the parent's assistant line exists. The span
  store parks an early `subagent-meta` until its spawn arrives, then applies
  it and flushes the child events buffered meanwhile. Covered by the
  live-ordering test in `apps/server/tests/span-store.test.ts`.
- A lane is anchored by its spawn, and a resumed agent still finds it. The
  completion notification normally carries the spawn's `tool-use-id`, but after
  a `SendMessage` resume Claude Code carries the RESUME call's id, which anchors
  no lane, so the store falls back to `<task-id>` (the child's agentId) through
  the same `agentId → spawn` map. Without it a resumed lane keeps its
  pre-resume status forever. The map is written back with the spawn's id, never
  the notification's.

## The turn's own text

The first and last block of a turn ARE the conversation: what was asked, and what
came back. Both carry a `turn-text` handle (`{turnIndex, which}`) and open the
shared output drawer through `openBlock`, exactly like a tool or an API call.

The handle carries **only the index**: the text lives on the reducer's `TurnNode`
(`prompt`, `result`), and the router reads it there at click time rather than the
span store keeping a second copy of it.

A mid-turn `reply` opens nothing. The reducer stores the turn's result as
"last wins", so an earlier answer's text is no longer available, and opening it would
show a *later* answer than the block claims. Rather than showing the wrong text,
that one block stays inert (`cursor:default`, no hover).

## The two ends of the document

The spine opens on `▼ INITIAL PROMPT` and closes on `▲ FINAL RESULT`, and both caps
name content that is really there: every row's title IS its prompt, and without
the end block the session's conclusion would live only at the far right of an
expanded turn's strip, past a horizontal scroll.

The end cap labels a **full-width final-result block**: the turn id, and the
answer's first line stripped to plain (like the NOW panel's inline line; this
block renders prose, not a step label, so raw `**` and backticks read as noise;
code inside a fence is quoted as it is, since there the markers are the code).
Clicking it opens the same drawer as that turn's `done` block. An answer that
strips to nothing at all, markers and no words, reads `(no text)`, the same
words the NOW panel uses for the same nothing.

- It reads the LAST `result` span of the last turn that holds one, and reuses
  that span's `turn-text` handle, so the block and the `done` block can never
  disagree, and no second copy of the text exists (see *The turn's own text*).
  That span is always the latest answer, which is exactly what the reducer's
  `TurnNode.result` holds, so the mid-`reply` hazard does not apply here.
- It names its turn (`T6`). On a live session the last turn may still be
  working while the answer on screen belongs to the one before it; unnamed, a
  block in that position would lie by position alone.
- **No answer yet → the empty state, not a missing block** (`No final answer yet`,
  inert): an interrupted session, or one still on its first turn. Removing the
  block would leave the cap naming nothing.
- Scope-aware by construction: scoped to one turn, the block is that turn's answer.

## reply vs done

A `result` span is the model closing its turn (`stop_reason: 'end_turn'`
text). A turn can hold several: the model closes, then is re-woken without a
new user prompt (e.g. a background task notification). A result with spans
AFTER it renders as a dashed, dimmed **reply**; only the last one is **done**.
Live, the tail result reads `done` and demotes itself automatically if more
work arrives: same rule, position-derived.

## Block colors

Steps carry their span-type color (`--sp-*`: prompt violet, api blue, tool
green, skill mint, result amber); spawn blocks are cyan with a gradient fill;
rounds are teal (`--sp-round`) and chapters indigo (`--sp-chapter`) so the
three families (steps, rounds, chapters) read apart at a glance.

No successful category may sit near the error hue. A step that worked must
never read as one that failed. The hues, and their distance from
`--sp-error` (351°):

| token | hue | → error |
|---|---|---|
| `--sp-tool` `#99db76` | 99 | 108° |
| `--sp-api` `#60a5fa` | 213 | 138° |
| `--sp-skill` `#6ee7b7` | 156 | 165° |
| `--sp-spawn` `#7dd3fc` | 199 | 152° |
| `--sp-prompt` `#a78bfa` | 255 | 96° |
| `--sp-result` `#fbbf24` | 43 | 52° |

`tool` is the most frequent category of all, so it takes hue 99, the furthest a
free hue can sit from every other token (56° from its nearest neighbour). `result`
stays amber at 52°: it appears once per turn and carries the word "done", and
frequency is what makes a collision dangerous. All these tokens are Trace-only.

`--sp-api` (213) and `--sp-spawn` (199) sit 14° apart. Left alone:
a spawn block is a different shape (cyan gradient fill, stacked edges when
merged) and the two never appear as adjacent bare dots.

A span whose `status === 'error'` (a tool that **failed**, or an API call
Claude Code flagged `isApiErrorMessage`) takes a red border (`--sp-error`),
in the main strip and inside subagent lanes alike, since most real failures happen
inside a subagent. A tool the **user refused** (Esc on the permission prompt,
or a deny rule) is not a failure and is never reddened; the parser draws that
line (`apps/server/src/server/failure.ts`, `toolOutcome`), not the Trace.

A background command fails LATER than its span. A `Bash` launched in the
background returns a receipt in ~100ms: the call's work was starting the
command, so the span closes there and its duration stays the launch's, never
the command's lifetime. (A foreground command *promoted* to the background when
it outlives its call's own timeout is the same case with a different number: its
span is the timeout it ran for, meaning the `timeout` the call asked for, two minutes
when it asked for none, so a promoted span is minutes long, not 100ms.) The
outcome arrives minutes or hours afterwards, on
a `queue-operation` line, and is the only place the exit code exists. The span
store keeps those spans and, when a non-clean status lands, reddens the span and
replaces its detail with Claude Code's own sentence. A clean exit changes nothing
on the row.

The gate is the RECEIPT, never the notification's id shape: a resumed subagent's
`SendMessage` is named by a `b…` notification too, and keying on that would redden
a call that launched nothing. Two receipt shapes pass it: a `Bash`'s
`backgroundTaskId`, and a `Monitor`'s `taskId` + `timeoutMs`, which is the same
kind of launch under a different field name. A `Monitor` therefore behaves here
exactly like a background `Bash`: a launch span that keeps its receipt's duration,
a `bg` chip, and an outcome that lands when its stream ends.

A ⚑ means a hook had something to say about this call. Claude Code writes a hook's
note as an `attachment` line naming the call's id, most often a security plugin objecting to what
was just written, and the block carries the mark while the drawer carries
the text. Only the mark: a note can be a paragraph, and a block is one line. Amber, not
red, and independent of the span's status: a call somebody warned about is not a call
that failed, and both can be true at once. The note arrives AFTER the call closed, so
the store looks the span up by handle (newest turn first) rather than keeping every
closed span to catch it, an index that would grow with the session to serve a handful
of notes.

The block says it was a background launch, in every state. A `bg` chip sits
beside the label, from the launch onwards: without it the row is an ordinary
100ms `Bash`, and its sub-line changes identity when the outcome lands (the
command is replaced by CC's sentence, which names the command by its
`description`). The chip is also what keeps the block's duration from being read
as the command's, and for a launch that is never notified at all it is the only
thing on the row that stays true.

The drawer states the fate, and the strip's numbers are named for what they
measure. Opening a background block shows a `background` chip beside the kind,
an `Outcome` block carrying CC's sentence (or `still running` before it lands),
and a `Launch` tile where every other tool has `Duration`, never the launch
receipt alone («Command running in background… you will be notified»), which
says less than the row it was opened from.

The words are CC's; only their ORDER is seedeep's. `outcomeLine`
(`core/activity-line.ts`) rewrites `Background command "Start seedeep server"
failed with exit code 144` into `failed with exit code 144 · Background command
"Start seedeep server"`, because the column truncates on the right and the fate
(the one thing the row cannot deduce, and the only place the exit code exists)
is the tail of CC's sentence. The regex anchors on the FATE, never on the
name: a launch with no `description` is named by CC after the command itself,
which brings its own quotes and newlines. CC also HTML-escapes what
it quotes (`&amp;&amp;`, `&lt;&lt;`), and these lines are printed as text, so
the entities are decoded after the split, never before, or a `&quot;` would
become a quote the split could land on. A summary that does not match the known
shape still passes through whole: CC owns this text and may reword it, and a
stale regex must degrade to showing everything, never to mangling it.

seedeep reports what Claude Code reported: exit 144 is what a deliberately
`pkill`-ed server gets, and re-classifying that would be seedeep inventing a
semantics the logs do not carry.

**A failure survives folding.** Because the tools that fail most (Bash, Edit,
Read) are non-landmark, they fold into rounds/chapters, so a red leaf alone
would be invisible in the collapsed strip. `groupTurnSpans` therefore carries
`hasError` up the group tree (a group has it iff any leaf failed), and a
flagged round/chapter block takes the red left rule while its type-dot preview
paints the failing leaves' dots red, so the failure is legible without opening
the block. Covered by `trace-group.test.ts` (propagation) and
`trace-render.test.ts` (both faces + the preview dot).

## Interaction map

| Click | Effect |
|---|---|
| turn header | expand/collapse the turn in place |
| `N failed steps` badge | jump to the next failed step: opens the turn, the groups hiding it and its lane (a merged run whole), releases auto-follow, then scrolls to it and marks it; the marker survives every later rebuild |
| group block / fold cap | expand/collapse the group in place (pinned) |
| step block (api/tool) | opens the existing drawer for that call/tool |
| first block (prompt) | opens the turn's prompt, rendered as markdown |
| last block (`done`) | opens the turn's final answer, rendered as markdown |
| mid-turn `reply` | nothing; see below |
| spawn block | unfolds/folds the child lane(s) below |
| parallel block (`N in parallel`) | unfolds/folds EVERY lane of the run at once: it is drawn as one block, so it opens as one; each lane is named by its launch intent |
| spawn ⓘ / lane name / workflow mini | drawer (subagent, or spawn tool as fallback) |
| wheel / scrollbar / `PageDown` `Home` `End` | scroll the spine (native) |
| wheel over an open strip | scroll that strip horizontally (native) |
| `Compact` (header) | denser blocks, sub-lines hidden |
| `Close turns` / `Last turn` (header) | shut every open turn / open + jump to the newest |
| `follow` (header) | re-engage live auto-follow after a manual scroll |
| Escape | close the drawer first, then the modal |
