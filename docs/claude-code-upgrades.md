# Surviving a Claude Code upgrade

seedeep reads session logs it does not own. Anthropic changes their shape between
releases, without notice, and seedeep would keep parsing, quietly producing
nothing where it used to produce a turn, a subagent, a token count.

This is not hypothetical. Measured across 3087 real session files (~264k lines,
26 releases):

- Fields appeared: `promptSource` (2.1.177), `attributionMcpServer` +
  `attributionMcpTool` (2.1.195), `session_id` (2.1.200).
- A field was removed: `slug` was on ~12% of assistant lines through 2.1.208 and
  on **0 of 2887** in 2.1.211.
- Three of those changes touched fields the parser reads.
- A new release lands roughly every **1.9 days**.

## The one idea

Presence is conclusive; absence is not.

Seeing a field once proves it exists, with no sample size needed. NOT seeing it
proves nothing, because most fields are conditional: `compactMetadata` exists only
if you compacted, `interruptedMessageId` only if you pressed Esc. Measured: at a
*fixed* release, two halves of the same logs differ by 4 fields. A checker that
called those "changes" would be red today with nothing changed, and you would
switch it off within a week.

Everything below follows from that asymmetry.

## Three mechanisms, three different jobs

The radar and the probe are below; the third, **evidence**, needs nobody to run it and is
described in [The rest closes itself](#the-rest-closes-itself).

### The radar — `bun test`

Reports fields Claude Code has **added** that seedeep has never seen. Runs in the
suite over the newest sessions (~106ms), and never fails the build: a new
field cannot break seedeep, it is at most an opportunity.

That sentence is about FIELDS, and it does not extend to VALUES. See
[When a value changes](#when-a-value-changes-and-why-the-radar-cannot-see-it), which is a
different failure with a different guard.

When it reports something, decide whether seedeep should read it, then accept it:

```
bun run apps/server/src/server/schema-known-fields.ts --update
```

The known set (`apps/server/data/known-fields.json`) only ever grows, so it can never become
a source of flaky failures.

**What it looks at:** the top-level keys of every line type, plus the keys inside
the nested containers seedeep's parser actually dereferences,
`OBSERVED_CONTAINERS` in `apps/server/src/server/schema-known-fields.ts`: `message`,
`message.usage`, `toolUseResult`, `compactMetadata`, `origin`. A container is on
that list because seedeep reads it; when the parser starts reading a new one, add
its dotted path there and re-run `--update`.

The list is explicit rather than a recursive walk. `message.content[]`
carries each tool's `input`, whose keys are defined by the tool or the MCP server,
not by Claude Code, and walking down blindly would bury the report in fields that say
nothing about the schema.

Honest limit: the radar sees only what arrives from now on. A field that already
existed when the set was generated is "known" and stays silent, and a container
absent from `OBSERVED_CONTAINERS` is invisible entirely. That is how
`toolUseResult.backgroundTaskId` (today the only reliable sign that a `Bash` ran
in the background) went unreported: `toolUseResult` was recorded as one key, and
nothing looked inside it.

### The probe — `bun run apps/server/probe/run.ts`

Answers the question the radar cannot: is a field seedeep reads gone?

It drives a real Claude Code session in a pseudo-terminal, *provokes* each event
(a typed prompt, a slash command, Esc, a tool call, a subagent), and then checks
that the field appeared. Absence is conclusive here only because the probe caused
the event itself.

It costs real tokens and needs a live login, so it is **not** part of `bun test`.
It runs only when the installed release is not yet certified:

```
bun run apps/server/probe/run.ts            # runs if this release is uncertified
bun run apps/server/probe/run.ts --force    # run anyway
```

A headless session (`claude -p`) cannot stand in for this. Measured over 527 files
/ 5586 lines of `entrypoint: sdk-cli`: they never carry `origin`,
`system/turn_duration`, `compactMetadata` or `interruptedMessageId`. A probe built
on `-p` would verify those vacuously and report green on a dead parser.

## When a value changes, and why the radar cannot see it

Everything above is about the shape of the logs. seedeep also reads several **closed
vocabularies**, small sets of strings whose meaning is Claude Code's to define, and a change
there fails differently. There is no missing field: a value falls through to "unknown"
and quietly downgrades what the user sees.

It has already happened once, and it is worth stating plainly because nothing in the guard reported
it. Claude Code writes `status: "shell"` in `~/.claude/sessions/<PID>.json` while a command the
session launched in the background is still running and the turn is over. seedeep did not know the
word, dropped it to `null`, and a session with no status is filed under *Idle*, so a
session with work still running read as idle for months. A user reported it; no test could
have. Two blind spots overlapped: the radar watches field NAMES, and it watches TRANSCRIPTS,
while this is a VALUE in the PID file.

The vocabularies seedeep reads today, all of them exposed the same way:

| where | values | what a new one costs |
|---|---|---|
| `sessions/<PID>.json` `status` | `busy` `idle` `waiting` `shell` | the session is filed under Idle |
| `sessions/<PID>.json` `waitingFor` | `permission prompt` `input needed` (others deliberately ignored) | a real approval stops raising the amber band |
| `entrypoint` | `cli` `sdk-cli` `sdk-py` | the tray's interactive-only filter mis-sorts a species |
| `<task-id>` prefix | `a…` agent · `b…` background · `w…` workflow | a notification is routed to the wrong subject |

Two guards cover the first, and they differ from the two above:

- **A claim in the contract (C25).** The probe launches a background command, lets the turn end,
  and requires `status: "shell"` while it runs. This is the only mechanism that can hold Claude
  Code to a *value*: provoke it, and absence becomes proof, exactly as for a field.
- **A one-shot warning at runtime** (`open-sessions.ts`). An unrecognised status is logged once per
  value, on the machine that is actually watching sessions pass through every state they have. A
  test-suite scan was considered and rejected in its place: the PID file exists only for sessions
  open at that instant, so the suite would see one session in whatever state it happened to be in,
  which is precisely how `shell` went unseen.

Neither fails the build. An unknown value is not a crash: the session simply makes no claim. Stopping the
server over a word Claude Code changed would cost more than the missing claim does.

A third kind of thing the radar cannot see: a PATH LAYOUT (C26). seedeep finds a background
command's output file at `<tmp>/claude-<uid>/<slug>/<session>/tasks/<taskId>.output`, because that
file is what gets asked whether the command's process still exists, which is the only way a command
whose end Claude Code never writes can stop counting. The parsed path cannot be used for it
(`anon()` masks the session uuid inside it before it reaches an event), so the SHAPE is the
mechanism. The same probe run that provokes `shell` checks the receipt names that shape. If it ever
moves, the resolution simply returns nothing and every probe answers "no verdict": a feature that
has gone quiet is indistinguishable from one with nothing to report, which is why it needs a claim
rather than a runtime warning.

A field whose only proof is a keystroke (C27). A background command has three possible authors,
and the receipt names each with a different field: the model asked (`run_in_background` in the launch
input), the call's own timeout promoted it (`timedOutAfterMs`, the CALL's timeout and not a constant:
45s–600s across 22 local promotions, matching the `timeout` the model asked for), or the user pressed
Ctrl+B (`backgroundedByUser`). Measured over 221 background receipts in 515 sessions on 2026-08-09, the
three are mutually exclusive, and the last is the only one with no fallback: read as "neither of the
other two", a receipt written before `timedOutAfterMs` existed turns a timeout into a model choice.
The radar cannot hold a field it has merely seen once, and no amount of real sessions can either,
because the gesture is a keystroke nobody presses on purpose. So scene 14 presses it: a command
launched in the FOREGROUND, then Ctrl+B, and a receipt that must say who did it. `provoked` reads the
shape of that receipt (a foreground launch that came back with a task id and no timeout) and never
the field under test.

## Three outcomes, never two

| | meaning |
|---|---|
| **HOLDS** | the event was provoked and the field is there |
| **BROKEN** | the event was provoked and the field did NOT appear, so seedeep is broken on this release. **Gesture claims only**: a model claim in this state is UNPROVEN, never BROKEN (see below) |
| **UNPROVEN** | the probe could not make the event happen, so it learned *nothing* |

UNPROVEN is an honest "I don't know" rather than a soft failure. Calling it a pass
would be the one lie that makes the whole guard worthless.

Claims split by what the probe can guarantee:

- **gesture:** the probe performs the act itself (typing, pressing Esc). Absence
  is proof.
- **model:** someone else decides. Claude may route differently, an MCP server
  may be absent, Claude Code may refuse to compact a small session. Absence proves
  nothing, so these are never reported as broken.

## What "certified" means

A release is added to `apps/server/data/certified-versions.json` only when every gesture
claim HOLDS. "Nothing broke" is not "I checked": a run that provokes nothing
breaks nothing, and an earlier version of this guard signed off a release having
proven 13 claims of 25.

Certification never covers what the probe could not prove. Those claims are
printed as a checklist instead.

## The rest closes itself

The probe cannot make Claude delegate or pick a skill. But ordinary use produces
subagents, skills and MCP calls on the new release within days, and presence is
conclusive, so a field found in a real session written by that release **proves**
it is alive. On each run the probe scans real sessions and closes what it finds,
with nobody doing anything.

Two rules keep that sound, and both have tests:

1. Only lines whose `version` **is** the target count. Confirming a new release
   with an old release's data is the exact failure this guard exists to prevent.
2. Subagent transcripts carry no `version`, so it is inherited from the parent,
   and only when that parent has exactly **one** version. A session that spans an
   upgrade cannot attribute its children, so it is discarded rather than guessed.

Evidence never overrides a BROKEN: the probe caused that event and watched the
field fail, and another session writing the field elsewhere does not resurrect the
case that failed.

## When something stays open

The run prints a checklist that says what to do, not what is missing:

```
TEST THESE BY HAND — the probe could not prove them:

  [ ] the child's end_turn text = the subagent's RETURNED OUTPUT
      how: click that subagent and confirm seedeep shows the text it RETURNED.
           This is the differentiator — check it first.
      if it is wrong, the break is at server/parser.ts
```

A claim names the file that reads the field, and a symbol inside it where one exists, never a
line number. `schema-contract-readers.test.ts` fails when a path or a symbol named there stops
existing, which is the check a line number could never carry.

Work an item by doing it in a real session; the next probe run will find the
evidence and close the claim on its own.

## Facts worth knowing before touching any of this

- `version` is on only **4 of 16 line types** (`assistant`, `user`, `system`,
  `attachment`). Bookkeeping lines (`queue-operation`, `result`, `started`, …)
  have none.
- A `claude` launched from inside a Claude Code session inherits
  `CLAUDE_CODE_SESSION_ID` and writes into the **caller's** transcript. Any tool
  that spawns the CLI must scrub `CLAUDE*` from the environment first.
- `attributionSkill` records **model** invocation only. Typing `/skill` runs the
  skill and attributes nothing.
- The TUI emits no spaces between words (it repositions with escape sequences), so
  screen patterns must be matched with whitespace stripped.
- On macOS the temp dir resolves through a symlink; Claude Code slugifies the
  **resolved** path, so a probe must use the realpath or it looks for a project
  directory that never exists.
- Some state never reaches the transcript at all. A **pending approval** lives only
  in `~/.claude/sessions/<PID>.json` (`status: "waiting"` + `waitingFor`), so scene 12
  is checked from samples of that file taken WHILE the session is alive, and every
  distinct state is kept, because a state the session passes through is invisible to a
  probe that records only the first sighting. Its ground truth is the refusal the
  transcript records once the prompt is declined (`C24`), never the field under test.
- A Bash command run inside the working directory is auto-approved by the sandbox and
  raises no dialog. Provoking a permission prompt needs a command that has to escape it
  (network access, a write outside the cwd). The first attempt used `touch` and proved
  nothing at all.
