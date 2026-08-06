# The Trace view

A near-fullscreen modal showing a session as **a scrolling document of turns**:
one full-width row per turn, each expandable in place into the horizontal strip
of what actually happened — API calls, tools, subagent spawns — down to any
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

## Why the spine is a document, not a canvas

The spine used to be a free 2D canvas: turn cards in a 214px column on the left,
each open turn's strip laid out to its RIGHT, navigated by drag-pan and
wheel-zoom. Measured, that cost more than it bought:

- **No scrolling of any kind.** The wheel was bound to zoom, so a two-finger
  trackpad scroll zoomed (scale 1 → 1.12) and a horizontal swipe zoomed *out*
  (`deltaY === 0` fell through to the shrink branch). No scrollbar, and
  `PageDown`/`Home`/`End` were dead — while the collapsed spine measured p50
  2,244px, p90 7,132px and max 16,700px against a ~950px stage.
- **`Fit` could not help.** It scaled the whole canvas to 0.54 on a 14-turn
  session (≈7px text) and would reach ~0.13 at p90.
- **Giant diagonals.** With a strip 2,836px wide, the connector from its tail
  back to the next turn's header was a ~1,400px diagonal crossing the canvas.

Putting each strip **below** its header removes all four by construction: the
next row is always at x=0, so there is no inter-turn edge left to draw, and the
stage becomes an ordinary `overflow-y:auto` container that gets the scrollbar,
the wheel, the keyboard and the browser's own find for free. Zoom and `Fit` are
gone; **Compact** (density), **Close turns** and **Last turn** replace them. Each
names the object it acts on: `Compact` redraws the blocks smaller and touches no
turn; `Close turns` shuts open turns and touches no block. `Close turns` is not
called "Collapse all" because every open turn already carries `expand`/`collapse`
for its GROUPS — one verb at two levels naming two different objects.

Consequence for the renderer: the measured-arrow layer (`.trace-edges`), the
transform/pan/zoom state and the resize listener no longer exist. What remains
is `anchorLanes()`, which keeps each open lane under its spawn.

`openBlock` is shared with the Live activity card's all-activity list, which passes it
a `BackEntry` so a drill-down leaves a breadcrumb. The Trace deliberately passes none —
its `onBlock` takes only a handle — because the modal stays open behind the drawer and
is still there to return to. A crumb here would offer to "go back" to something that
never went away.

Tests: `apps/server/tests/trace-group.test.ts` (rules), `apps/server/tests/span-store.test.ts` (store,
including live event ordering), `apps/server/tests/trace-render.test.ts` (fake-dom render),
`apps/server/tests/golden-transcript.test.ts` (raw jsonl → real parser → store).

## Why the strip is grouped

Measured over 2,445 real work turns: steps per turn p50=9, p90=46, p99=204,
max=497. At the strip's ~204px per step, the MEDIAN turn already overflows a
1920px stage and a p99 turn is a ~59,000px strip — zooming out can't fix it,
because text dies before the strip fits. So the strip renders a **group tree**
with in-place expansion instead of one block per step.

## The grouping rule (hybrid)

- **Round** — one `api` span plus the tool spans it triggered (the literal
  transcript structure). Tools before any api form a leading, api-less round.
- **Landmark** — `prompt`, `spawn`, `result` spans, and tool spans named
  `Skill`, `AskUserQuestion`, `ReportFindings`. Landmarks always render
  top-level, never inside a group.
- **Chapter** — a run of consecutive completed rounds folds into one block,
  capped at **10 rounds** and broken early by any landmark. A run of exactly
  one round stays a lone round block (never wrapped).
- **Parallel spawns** — a run of spawn steps ADJACENT in the strip (nothing
  between them) collapses into one `parallel` item. Drawing them left-to-right
  with arrows asserts a sequence that never happened: measured over 30 real
  sessions, **92 of 93 adjacent spawn pairs (98.9%) have overlapping execution
  windows**, while **45 pairs overlap without being adjacent** — separate
  launches with work between them, which must NOT merge. Time cannot be the
  criterion: adjacent spawns are written p50 4.4s apart (p90 11.3s, max 23s),
  because a `tool_use` line lands only when the streaming response reaches it.
  A run of one stays a plain spawn block.
- Group ids are stable (`r<n>`, `ch<startRound>`): a live turn's trailing
  chapter grows without changing identity, so a user's expansion never snaps
  shut on update.

## What a group block is CALLED

A round's name is the **intent its own API call stated** — the mid-turn text block
of that call, i.e. the model saying what it is about to do. Round = api + its
tools, and the intent belongs to that same api, so the join is the call id
(`message.id`), never "the last api span": one response is written as several
jsonl lines (thinking, then text, then each `tool_use`), so a slow line would
otherwise name whatever round happened to be open. The api span is always there
when the intent arrives, because the call's FIRST line created it — that is the
intent's own line when the text block leads (a line emits `usage` before its
content blocks) and an earlier `thinking` line otherwise. No parking is needed.

- **The number stays the fallback, and that is the common case.** Measured over
  235 transcripts / 30,467 rounds: **40.2%** carry an intent. The other 60% keep
  `#7 round`; a named round moves its number to the sub-line, where it weighs the
  same as `2 steps`.
- **Two clamped lines, not the sentence.** The block is 172px wide and a first
  line is p50 129 / p90 302 chars. Measured on the real block: one line shows 21
  chars, two show 41 — no geometry shows the sentence, so the block carries the
  opening and `title` carries the whole text. The clamp is a class (`gnamed`), so
  CSS decides how much shows, not the renderer.
- **A chapter counts intents; it is never named by one.** Naming a chapter after
  the first intent it folds describes one round out of up to ten as if it
  described all ten. It keeps its range (`R1–10`) and prints `3 intents` in the
  sub-line, dropping `steps` to make room (with all four facts the sub-line wraps
  and grows the block); its `title` lists them in order.
- **Rejected: an intent breaking the chapter run** the way a landmark tool does.
  Structurally tempting — every chapter would then be "the work done under one
  stated intent", true by construction. Measured over 2,220 real turns it
  destroys the grouping: top-level blocks go from p50 1 / p90 4 / max 30 to
  **p50 3 / p90 13 / max 240**, at a median of **1 round per chapter**.
- The turn's final answer is never an intent: an `end_turn` text is the RESULT
  (its own span), and naming the last round with it would put the conclusion on
  the block that led to it.
- The reducer keeps only the LATEST narration (the live NOW panel's datum, by
  design). The Trace needs the history, so it lives on the spans — one intent per
  `api` span — and the two never compete.
- **The whole text lives in the api block's drawer**, as its own `Intent` block
  above `Input`, fetched with the rest of the call from `/api/call-io`. It was
  already reaching the drawer inside `Output`, but a call with tools renders
  `Output` verbatim, because its args are code: the one thing there meant to be
  read as prose was read as a dump. The block is hidden, not omitted, when the
  call said nothing.
- **The span DOES hold the text, and that is deliberate** — unlike the turn's own
  text, whose handle carries only an index. A round's label has to be drawn on
  every rebuild, including offline replay, so making it wait on a fetch would
  leave the strip unnamed until the network answered. What the span holds is the
  parser's already-capped narration (2,000 chars), and the drawer does NOT reuse
  it: it re-fetches with the rest of the call rather than keeping a second copy
  of its own.

Group blocks show label (`#7 round` / `R1–10` / the round's intent), counts +
duration, and a type-dot preview. Click expands **in place** (dashed frame, sideways fold cap);
nesting is chapter → rounds → steps. Each turn header carries
`expand` / `collapse` (expand iterates to a fixpoint — one click opens every
level). They act on this turn's GROUPS; the header's `Close turns` acts on turns.
Expanded groups are **pinned** by namespaced key
(`<turn>:<ns><id>` — the main strip and each subagent lane have distinct key
spaces) and survive live re-renders; `open()` resets them, together with the
failure cursor and the jump marker — those are keyed by MODEL index, which names
a different turn after a re-open (a scoped open makes index 0 some other turn).

## The turn row

One row per turn, with fixed-width slots that are emitted even when empty — on a
144-turn session the metrics have to line up in columns, or comparing two rows
means re-reading both. Left to right: `T<n> · kind`, title, sparkline,
subagent count, failure badge, duration.

- **The sparkline is the turn's SHAPE**, and it replaced the per-type counts.
  `82 api  99 tool` says how much a turn did and never what it looked like, so a
  long tool burst and alternating api/tool cycles read identically. The turn's
  steps are binned in order into at most `SPARK_BINS` (30) slots. The cap matters:
  a turn is p50 11 steps but p99 220, so one mark per step would leave the bar
  unbounded. The total stays beside it as a number.
- **A bin STACKS the types it holds, proportionally** (order: `SPARK_RANK`), and
  never picks a winner. One colour per bin cannot describe a mixture, and the two
  ways of picking one both produced a wall: a majority vote painted **30 bins of
  30 blue** on a real 179-step turn — every round is one api plus its tools, so
  api tied or won nearly all of them — and ranking tool above api turned the same
  wall green. Stacked, that turn reads as what it is (api and tool interleaved)
  and the row agrees with the strip beneath it. A failing bin's red band never
  scales below a third of the bin: one bad step among six must still be visible.
- **The bands of a bin sum to 1, and that is a contract** (`binComposition`, a pure
  function, asserted in `trace-render.test.ts`). A `linear-gradient` holds its last
  colour past its last stop, so a composition that closes early is not a shorter
  bar — it is the LAST type silently taking the remainder. Subtracting the error
  band from each type in turn rather than once did exactly that: three equal types
  drew 33 / 22 / 44 and closed at 77.8%, on the row that exists to state the shape.

- **The left rule is the turn's STATE**, not its index: neutral, red when the
  turn holds a failure, amber while it is live. It used to cycle a golden-ratio
  hue per turn, which said nothing `T7` did not already say and landed on the
  error colour twice per cycle (`thColor(0)` = hsl(0), `thColor(13)` = hsl(348)
  against `--sp-error` at hsl(351)).
- **A row is named by the command AND its arguments.** A command's arguments ARE
  its prompt, so `prompt || command` titled a `/code-review del diff` round
  `del diff` — dropping the only part that says what ran. One rule now
  (`entryText`, `core/tree-format.ts`), shared with the Graph's `entryLabel`,
  which already had it.
- **Nothing is FINAL while a turn is live — unless the session is over.** The
  `▲ FINAL RESULT` cap and its block are omitted whenever any round is still
  working AND the session is open (`open`/`update` take `ended`): a round killed
  mid-flight keeps `state: 'live'` for good, and without that second condition a
  finished session showed no final answer at all. Otherwise: the last answer on
  record belongs to a PREVIOUS round, and showing it under that cap says the
  session has concluded when it has not. It returns as soon as the live round
  produces its own answer.
- **A round that DELEGATED is never an idle one-liner.** Only a control command
  with nothing behind it (`/model`, `/clear`) collapses to a single line. A
  forked skill (`/code-review`) makes no API call and runs no tool on the main
  thread, so on those two counts alone it collapsed exactly like a `/model` —
  for as long as its agent ran (9m53s on the reported session). Its launch is a
  `system`/`local_command` line carrying `<forked-skill-launch>`, not an `Agent`
  tool_use, so `span-store` registers the spawn block from that event and keys it
  by the AGENT id (the only name the launch gives it); the sidecar, which carries
  no `toolUseId` either, resolves through the same key. The round's `kind` becomes
  `work` at that launch — delegating IS running the model, the same call the
  reducer's `kindOf` makes, so the two surfaces cannot label one round two ways.
  The kind is a GUESS when the turn opens (a `user-turn` carries only its command
  name); the launch is the moment that guess is answered. `isIdle` also requires
  that the round launched nothing, and `isLive` counts a spawn as work in
  progress for the same reason. The round's envelope covers its delegated work:
  the launch and the agent's return both move `turn.t1`, so a ten-minute
  `/code-review` no longer measures a second on a duration bar that is a share of
  the longest turn.
  The spawn span carries `handle.toolUseId` set to that same agent id: the render
  links a span to its block through THAT field alone, so a handle without it drew
  the block with `no child events` while the lane sat in the store. Its span is
  closed by `agent-end` — a forked skill emits no `tool-end`, so nothing else can.
- **A collapsed turn declares its failures, and says how many.** The count is
  computed in `adaptSnapshot` over the main spans AND every child lane, so a
  failure that exists only inside a subagent still reaches the shut row —
  measured on 16.3% of 1,209 real turns, with 39 of 40 sessions holding at least
  one. The badge reads `N failed steps`: a bare "failed" was read as *the turn
  failed*, when the turn carried on and N of its steps did not. Its `title`
  says so outright.
- **The badge is a BUTTON, and it goes there.** A count the user wants to click
  and cannot is a dead end: reaching a failure by hand measured **7 clicks** on a
  real turn (open the turn, then chapter → round, once per failure), and the
  `expand` alternative left a **33,048px strip — 22 screens** with the three
  failures at x=1,860 / 8,322 / 30,098. Clicking pins the containing groups
  (`groupPathToSpan`) BEFORE the rebuild — `pinnedGroups` is what survives one —
  unfolds the lane when the failure is inside a subagent, rebuilds, then scrolls
  the block into view and marks it. Repeated clicks cycle the turn's failures
  and wrap. Three rules make the jump hold:
  - **It releases auto-follow.** Jumping is navigation, as deliberate as a
    scroll, and a scroll releases follow. While it did not, the next live event
    scrolled the failure straight off screen — measured `scrollTop` 0 → 454, about
    a second after the click.
  - **The marker is STATE (`_hitSpanId`), not a class written once.** Every path
    that redraws a block re-derives it (`applyHit`, called from `renderLanes`), so
    a live rebuild, a turn re-opened by hand or a lane folded and unfolded all keep
    it. Applied once to the node, it vanished at the next event.
  - **It opens a merged parallel run whole**, because the run is one block on
    screen: unfolding a single spawn of it left the lane under a block still
    reading `▸ expand flow`, whose next click then opened the run instead of
    closing it.
  - Inside a `Workflow` the lane draws a **tile**, not a strip, so the tile is what
    the jump lands on and marks — the spans of a Workflow lane have no block of
    their own, and the badge counted a failure the click could never reach.
- **A live turn must also hold work.** A finished session still reports
  `state === 'live'` on every turn it never closed (16 of 144 in one measured
  session, all of them empty), so the amber rule requires api or tool spans.
- **Duration is a bar, not only a number** — each turn against the longest turn,
  each block against the widest block in its strip (linear: a 96ms Skill beside
  a 5m chapter *should* read as nothing). The row's bar has no axis and no label,
  so it carries a `title` stating what it measures, and it stays **neutral in
  colour**: tinting it red repeated a signal the left rule, the badge and the
  sparkline already carry, and only raised the question "why is this bar red?".
  The duration number sits in a fixed-width cell so the bars line up down the
  session; sized to their text ("60s" vs "76m 4s") every bar slid.
- **A control command that ran nothing is one dim line** (7.9% of turns:
  `/clear`, `/model`). A `work` turn with no api/tool was interrupted with Esc
  and keeps a full row — that is information, not noise.
- **The session subject is the first turn that did work.** `turns[0].title`
  named 88% of sessions (53 of 60 measured) after a control command, so the
  header read `/clear` while the picker showed the real subject.

## Live behavior

- On a turn with `state === 'live'`, the **tail round stays raw** — open step
  blocks, never folded — and the newest block glows. Finished rounds fold as
  the next api arrives; chapters close at the cap or at a landmark.
- **Auto-follow** (whole-session open): the view tracks the newest work by
  scrolling the last turn's header ≈20% down the stage; a live turn also scrolls
  its own strip fully right, because the strip grows rightward. A manual scroll
  releases follow; the header's `follow` button re-engages it.
- **Ours-or-theirs is decided by POSITION, not by a time window.** The controller
  records the `scrollTop` it just set (`_expectedTop`, read back so the browser's
  clamping is included) and the listener ignores an event landing within 2px of
  it. A boolean cleared on the next frame looked equivalent and was not: on a busy
  live session `focusLastTurn` runs on every event, so the flag was up whenever
  the user happened to scroll — their scroll was swallowed as ours, follow stayed
  engaged, and the next event yanked them back.
- **`follow` is hidden unless the session is WORKING.** Auto-follow acts only
  through `update()`, which a finished session never calls, so there the button
  merely jumped to the last turn — `Last turn`'s job, which also opens it. A
  control doing another control's job is worse than an absent one. Liveness needs
  real work, not just `state === 'live'` (see the turn-row rules above).
- `update()` restores `scrollTop` after the rebuild, so a live event cannot
  throw a user reading turn 12 back to the top — **and each open turn's strip
  `scrollLeft` with it**. The strip is a SEPARATE scroller: restoring only the
  stage sent a reader back to the strip's first block once a second (measured
  8,974px of strip against 1,288px visible). The live turn is the exception,
  because `focusLastTurn` deliberately scrolls it fully right afterwards.
- Blocks appear seconds after the console shows the same activity: a spawn's
  `tool_use` line is written to the jsonl only when the **streaming response
  reaches it** (measured ~8s apart for eight spawns in one response). seedeep
  reads the file — this floor is inherent to the read-only architecture.

## Class scoping (a rule with a scar)

Every class the renderer writes must be scoped under `.trace-modal`, or a global
rule reaches it. The tail marker escaped: it was `live`, which is ALSO the
Live-activity badge's unscoped class (`display:inline-flex`,
`text-transform:uppercase`, `letter-spacing`). It landed on the newest block of
every live turn — uppercasing its label and pushing the text **11px out of its
own box**. It is now `tail`. `apps/server/tests/trace-css-scope.test.ts` reads the stylesheet
and the renderer as TEXT and fails on any Trace class that a single-class global
rule also targets; a fake-dom test cannot catch this, because it does no layout.
`hidden` is the one allowed collision — a shared utility whose effect is wanted.

The guard only sees what it can extract, which is a defect it has already had
twice: `classList?.add('hit')` was invisible to a regex demanding `classList.`,
and a name BUILT at runtime (`'t-' + type`, the sparkline bins) never appears as a
literal at all. Both are covered now — the second by asserting that no global rule
falls inside a runtime-built prefix family. Adding a new way to write a class name
means teaching the extractor about it in the same commit.

## Subagents

- **The spawn block IS the subagent.** Label = the launch intent
  (`description` → first line of the prompt → agent type); sub-line = agent
  type (model) · tool count · the lane's real duration — never the spawn-call
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
  the snapshot, else the spawn TOOL drawer (launch prompt, timing) — a click
  is never a silent no-op.
- **Live event ordering** (the invariant that makes lanes fill while agents
  run): the watcher reads a child's `meta.json` and transcript as soon as the
  agent starts writing — BEFORE the parent's assistant line exists. The span
  store parks an early `subagent-meta` until its spawn arrives, then applies
  it and flushes the child events buffered meanwhile. Covered by the
  live-ordering test in `apps/server/tests/span-store.test.ts`.
- **A lane is anchored by its spawn, and a resumed agent still finds it.** The
  completion notification normally carries the spawn's `tool-use-id`, but after
  a `SendMessage` resume Claude Code carries the RESUME call's id, which anchors
  no lane — so the store falls back to `<task-id>` (the child's agentId) through
  the same `agentId → spawn` map. Without it a resumed lane keeps its
  pre-resume status forever. The map is written back with the spawn's id, never
  the notification's.

## The turn's own text

The first and last block of a turn ARE the conversation — what was asked, and what
came back — and they were the only two blocks in the Trace a click did nothing on.
Both now carry a `turn-text` handle (`{turnIndex, which}`) and open the shared
output drawer through `openBlock`, exactly like a tool or an API call.

The handle carries **only the index**: the text lives on the reducer's `TurnNode`
(`prompt`, `result`), and the router reads it there at click time rather than the
span store keeping a second copy of it.

**A mid-turn `reply` opens nothing.** The reducer stores the turn's result as
"last wins", so an earlier answer's text is no longer available — opening it would
show a *later* answer than the block claims. Rather than showing the wrong text,
that one block stays inert (`cursor:default`, no hover).

## The two ends of the document

The spine opens on `▼ INITIAL PROMPT` and closes on `▲ FINAL RESULT`. The first cap
names content that is really there — every row's title IS its prompt — and the
second named nothing at all: it used to be the last node of the spine, with empty
space under it. Nothing else in the document carried an answer either, so the
session's conclusion lived only at the far right of an expanded turn's strip, past
a horizontal scroll.

The end cap now labels a **full-width final-result block**: the turn id, and the
answer's first line stripped to plain (like the NOW panel's inline line — this
block renders prose, not a step label, so raw `**` and backticks read as noise).
Clicking it opens the same drawer as that turn's `done` block.

- **It reads the LAST `result` span of the last turn that holds one**, and reuses
  that span's `turn-text` handle — so the block and the `done` block can never
  disagree, and no second copy of the text exists (see *The turn's own text*).
  That span is always the latest answer, which is exactly what the reducer's
  `TurnNode.result` holds, so the mid-`reply` hazard does not apply here.
- **It names its turn (`T6`).** On a live session the last turn may still be
  working while the answer on screen belongs to the one before it; unnamed, a
  block in that position would lie by position alone.
- **No answer yet → the empty state, not a missing block** (`No final answer yet`,
  inert): an interrupted session, or one still on its first turn. Removing the
  block would put the cap back to naming nothing.
- Scope-aware by construction: scoped to one turn, the block is that turn's answer.

## reply vs done

A `result` span is the model closing its turn (`stop_reason: 'end_turn'`
text). A turn can hold several: the model closes, then is re-woken without a
new user prompt (e.g. a background task notification). A result with spans
AFTER it renders as a dashed, dimmed **reply**; only the last one is **done**.
Live, the tail result reads `done` and demotes itself automatically if more
work arrives — same rule, position-derived.

## Block colors

Steps carry their span-type color (`--sp-*`: prompt violet, api blue, tool
pink, skill green, result amber); spawn blocks are cyan with a gradient fill;
**rounds are teal (`--sp-round`) and chapters indigo (`--sp-chapter`)** so the
three families — steps, rounds, chapters — read apart at a glance.

**No successful category may sit near the error hue.** A step that worked must
never read as one that failed. Measured hues and their distance from
`--sp-error` (351°):

| token | hue | → error |
|---|---|---|
| `--sp-tool` `#99db76` | 99 | 108° |
| `--sp-api` `#60a5fa` | 213 | 138° |
| `--sp-skill` `#6ee7b7` | 156 | 165° |
| `--sp-spawn` `#7dd3fc` | 199 | 152° |
| `--sp-prompt` `#a78bfa` | 255 | 96° |
| `--sp-result` `#fbbf24` | 43 | 52° |

Two were wrong. `api` was orange (`#fb923c`), 13° from `--sp-result`. `tool` was
pink (`#f472b6`) at **22° from the error colour** — and `tool` is the most
frequent category of all, so the most common successful step in the whole view
was almost the colour of failure. Hue 99 is the furthest a free hue can sit from
every other token (56° from its nearest neighbour). `result` stays amber at 52°:
it appears once per turn, carries the word "done", and amber against pink-red is
not the confusion pink-against-pink-red was — frequency is what makes a collision
dangerous. All these tokens are Trace-only.

`--sp-api` (213) and `--sp-spawn` (199) sit 14° apart. Left alone deliberately:
a spawn block is a different shape — cyan gradient fill, stacked edges when
merged — and the two never appear as adjacent bare dots.

A span whose `status === 'error'` (a tool that **failed**, or an API call
Claude Code flagged `isApiErrorMessage`) takes a red border (`--sp-error`),
in the main strip and inside subagent lanes alike — most real failures happen
inside a subagent. A tool the **user refused** (Esc on the permission prompt,
or a deny rule) is not a failure and is never reddened; the parser draws that
line (`apps/server/src/server/failure.ts`, `toolOutcome`), not the Trace.

**A background command fails LATER than its span.** A `Bash` launched in the
background returns a receipt in ~100ms — the call's work was starting the
command, so the span closes there and its duration stays the launch's, never
the command's lifetime. (A foreground command *promoted* to the background by
the 120s timeout is the same case with a different number: its span is the
timeout it ran for — 18 of 114 measured spans are minutes long, not 100ms.) The
outcome arrives minutes or hours afterwards (p50 2.9m, p90 32m, max 8.8h,
measured 2026-08-02 over 731 local transcripts: 120 launches, 114 notified), on
a `queue-operation` line, and is the only place the exit code exists. The span store keeps those spans (and only those: the gate is the
receipt's `backgroundTaskId`, so a `Monitor` call or a resumed subagent's
`SendMessage` — both named by `b…` notifications — are never touched) and, when
a non-clean status lands, reddens the span and replaces its detail with Claude
Code's own sentence. A clean exit changes nothing on the row.

**The block says it was a background launch, in every state.** A `bg` chip sits
beside the label, from the launch onwards: without it the row is an ordinary
100ms `Bash`, and its sub-line changes identity when the outcome lands (the
command is replaced by CC's sentence, which names the command by its
`description`). The chip is also what keeps the block's duration from being read
as the command's. 6 of 120 real launches were never notified at all — for those
the chip is the only thing on the row that is true.

**The drawer states the fate, and the strip's numbers are named for what they
measure.** Opening a background block shows a `background` chip beside the kind,
an `Outcome` block carrying CC's sentence (or `still running` before it lands),
and a `Launch` tile where every other tool has `Duration`. Before this the
drawer showed the launch receipt alone — «Command running in background… you
will be notified» — under a `FAILED` chip, so the surface you open to learn why
said less, and something contradictory, versus the row you opened it from.

The words are CC's; only their ORDER is seedeep's. `outcomeLine`
(`core/activity-line.ts`) rewrites `Background command "Start seedeep server"
failed with exit code 144` into `failed with exit code 144 · Background command
"Start seedeep server"`, because the column truncates on the right and the fate
— the one thing the row cannot deduce, and the only place the exit code exists
— is the tail of CC's sentence. The regex anchors on the FATE, never on the
name: a launch with no `description` is named by CC after the command itself
(4 of 120), which brings its own quotes and newlines. CC also HTML-escapes what
it quotes (`&amp;&amp;`, `&lt;&lt;`), and these lines are printed as text, so
the entities are decoded after the split — never before, or a `&quot;` would
become a quote the split could land on. A summary that does not match the known
shape still passes through whole: CC owns this text and may reword it, and a
stale regex must degrade to showing everything, never to mangling it.

seedeep reports what Claude Code reported: exit 144 is what a deliberately
`pkill`-ed server gets (28 of 29 real failures), and re-classifying that would
be seedeep inventing a semantics the logs do not carry.

**A failure survives folding.** Because the tools that fail most (Bash, Edit,
Read) are non-landmark, they fold into rounds/chapters — so a red leaf alone
would be invisible in the collapsed strip. `groupTurnSpans` therefore carries
`hasError` up the group tree (a group has it iff any leaf failed), and a
flagged round/chapter block takes the red left rule while its type-dot preview
paints the failing leaves' dots red — the failure is legible without opening
the block. Covered by `trace-group.test.ts` (propagation) and
`trace-render.test.ts` (both faces + the preview dot).

## Interaction map

| Click | Effect |
|---|---|
| turn header | expand/collapse the turn in place |
| `N failed steps` badge | jump to the next failed step: opens the turn, the groups hiding it and its lane (a merged run whole), releases auto-follow, then scrolls to it and marks it — the marker survives every later rebuild |
| group block / fold cap | expand/collapse the group in place (pinned) |
| step block (api/tool) | opens the existing drawer for that call/tool |
| first block (prompt) | opens the turn's prompt, rendered as markdown |
| last block (`done`) | opens the turn's final answer, rendered as markdown |
| mid-turn `reply` | nothing — see below |
| spawn block | unfolds/folds the child lane(s) below |
| parallel block (`N in parallel`) | unfolds/folds EVERY lane of the run at once — it is drawn as one block, so it opens as one; each lane is named by its launch intent |
| spawn ⓘ / lane name / workflow mini | drawer (subagent, or spawn tool as fallback) |
| wheel / scrollbar / `PageDown` `Home` `End` | scroll the spine (native) |
| wheel over an open strip | scroll that strip horizontally (native) |
| `Compact` (header) | denser blocks, sub-lines hidden |
| `Close turns` / `Last turn` (header) | shut every open turn / open + jump to the newest |
| `follow` (header) | re-engage live auto-follow after a manual scroll |
| Escape | close the drawer first, then the modal |
