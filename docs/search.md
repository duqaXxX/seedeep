# Session search

**What it answers:** *"which session solved that problem?"*, when all you remember is a few words.
Type them, get the sessions whose dialogue contains **all** of them, open one in a tab or copy its
full id for `claude --resume`.

This is the reference for the CURRENT rules. Code: `apps/server/src/server/search-index.ts` (index + matching),
`apps/server/src/client/search-view.ts` (the tab), `apps/server/src/client/id-chip.ts` (the id chip),
the route in `apps/server/src/server/server.ts`.

## What is searched: the dialogue, not the transcript

The corpus is what was **said**:

- **your prompts** — typed text, and a slash command's **arguments** (never its `<command-name>`
  wrapper). Both shapes of a command count: the expanded one and the one Claude Code writes as the
  plain text you typed (`/code-review del diff`) — an argument-less command indexes as its own name
  (`/compact`), which is what the user sent;
- **Claude's text blocks** — its prose answers.

Everything else in a transcript is excluded: tool results, tool inputs, file contents, injected
instructions, system reminders, task notifications, compaction preambles. That is not a
simplification, it is the point — the surplus a raw-jsonl scan matches is text the session never
said.

Extraction goes through the REAL parser (`userLineIntent` + `CONTROL_COMMANDS` in `parser.ts`),
never a second reader of the same lines. What that rule drops is `<task-notification>` lines,
compaction preambles and probe artefacts — **not one human prompt**.

**LIMIT:** subagent transcripts are not indexed. They are a separate file per subagent
(`<uuid>/subagents/`), and their dialogue is machine-to-machine — an agent prompt written by Claude,
not by you.

## A commit hash also asks git

A query that is a single 7-40 character hex token is a commit hash, and the dialogue is the wrong
place to look for one: the hash of a commit normally appears only in the output of the command
that made it, which this index excludes by design. So a hash query ALSO asks git who produced that
commit, by the attribution in [`session-output.md`](session-output.md#attribution-proof-first-testimony-second-otherwise-nothing), and merges those sessions into the same rows.

Nothing else changes: same row shape, same ordering, no extra section — only the set of sessions
grows. A text query is untouched: one regex decides, and a query that is not a hash never asks git.

A session found this way carries **`hits: 0` and no snippet** — there is no passage to quote,
because it never said the hash. It therefore reads `0 per 1k` and sorts last under the default
density order. That is deliberate: the alternative was to invent an occurrence count the dialogue
does not contain.

An unknown hash adds nothing, and a hash in a repository seedeep cannot reach (renamed or moved
directory) is simply not found.

## A tracker id also asks the sessions' tool calls

The same reasoning, for the other identifier a user types into a search box. `ABC-12` or `#42` also
returns the sessions that ACTED on that card — read from their tool calls, by the rules in
[`session-output.md`](session-output.md#tracker-cards). The dialogue index cannot see those: the id lives in a call's id field, and a
session that worked a card for an hour may never have typed its key.

Same row shape, same ordering, same honest `hits: 0` as a hash match: a hash is answered by git, a
card id by its own persisted index (`cards-index.jsonl`). That index is touched ONLY when the query
is shaped like a card id, so a text search pays nothing for it. See [`session-output.md`](session-output.md#tracker-cards). The shape test
is deliberately permissive — `GPT-4` and `UTF-8` pass it and simply match nothing, since the answer
comes from ids observed in tool calls, never from text.

## Matching: every word is an AND term

The query is lowercased and split on whitespace; a session must contain **every** term to be a
result. Adding a word can only narrow the set, never widen it.

## The species split: your sessions, and the machine's

Rows are split with the same predicate the picker uses (`isAutomated`: `entrypoint` starting with
`sdk`). Your own sessions are listed; the automated runs (a docs gate, a `claude -p` script) sit
behind a `+ N automated runs … — show` control that **states its own count**. Nothing is dropped in
silence, and nothing is truncated: there is no top-N cut.

## Ordering: density by default

Three orders, selectable; each sorts by **the number the row prints** — a list ranked on something
else is a leaderboard nobody can check. The score box therefore changes with the key: it names the
quantity it is showing (`per 1k`, `times`, `last run`), and the readout table in `search-view.ts`
(`SCORE`) is keyed by the sort key itself, so a key added without its readout does not compile.

| order | key | shown as |
|---|---|---|
| **density** (default) | occurrences per 1k characters of dialogue | `2.6 per 1k` |
| occurrences | total occurrences of every term | `24 times` |
| recent | last activity | `16d` / `today` — *last run* |

Density is the default because **ordering by raw occurrences ranks session LENGTH**.

The denominator is the dialogue **itself** — the characters that were said. The separators the
matcher joins utterances with are not part of it: charging them would inflate exactly the shortest
sessions, which is precisely where density decides anything.

**LIMIT:** a very short session that mentions a term once can top the density order on that one
mention. The row prints its own numbers (`1× · 0k`), so the order stays explainable, and no
arbitrary minimum-length constant is invented to hide it.

## Snippets

Up to two passages per session: for each utterance, the window where the **most distinct terms**
cluster; the best two, most-terms-first. Distinct terms, not occurrences — a passage carrying both
words you typed is the one that proves the session is the right one; a passage repeating the first
one ten times is not.

Where two terms match at the same spot because one contains the other (`toast` and `toasting`), the
**longer** one is highlighted: the word that brought the session up has to read as a match, not be
cut short by its own prefix.

Every snippet is attributed (**you** / **claude**) and the terms are highlighted with `<mark>`
element nodes built from indices. Never an HTML string: the text is a real prompt, and markup inside
it must be impossible to execute.

## The session id

The id chip copies the **full uuid** on click. What it DISPLAYS depends on the room the surface has:

- **Search row** — the whole uuid, on the meta line. This is the surface you reach for when the next
  thing you do is `claude --resume <id>`, and a prefix you must click to complete is not that. It
  sits on the meta line (mono, ~230px available) rather than in the actions column, which would take
  that width from the snippets.
- **Picker row** — the 8-character prefix seedeep has always printed: the row is narrow, and there
  the id only has to tell two sessions apart.

It is the same component in both (`id-chip.ts`), so the id is never a copy button on one surface and
dead text on another. A copy the browser refuses (no permission, no secure context) leaves the chip
unchanged rather than claiming one.

## The index

`~/.seedeep/search-index.jsonl` — seedeep's own file, never a session file (`SEEDEEP_HOME` moves it
with the rest of seedeep's state: [`configuration.md`](configuration.md#moving-it-seedeep_home)).
One JSON line per
session (`path`, staleness stamp, dialogue segments) behind a version header; a missing, corrupt or
older-version file is treated as empty and rebuilt.

- **Incremental** on `(size, mtime)`, atomic on write (temp + rename), refreshes serialized.
- **Shape-checked on load.** An entry whose segments do not carry the current fields is discarded and
  the session re-read, and a field added to the segment type without being listed fails the BUILD —
  the same forcing function `aggregate-cache.ts` uses.
- **Refreshed on demand**, when a search runs: it costs nothing until you use the tab, and a session
  being written right now enters the results as of the query.
- **Its own file, deliberately.** `aggregates.json` (the retrospective/Compare cache) is rewritten
  whole on every refresh, and the dialogue is bulk prose that cache never reads. Sharing them
  would also mean bumping `CACHE_VERSION` — re-parsing the whole corpus — to add text the
  retrospective does not look at.

The lowercased text a query is matched against is **derived, never stored**, and it is keyed on the
ENTRY rather than on its path. That is the whole invalidation strategy: an entry's text cannot
change — a changed file becomes a new entry — so a stale derivation is unreachable, and nothing has
to be invalidated by hand from inside the refresh loop.

The query is a substring scan per term. **Do not** add an inverted or trigram index: nothing
measured asks for one, and the measurement that says so is kept next to the code it constrains
(`search-index.ts`, above `createSearchIndex`) — where a change to the index has to read it.

## Privacy

The index holds your own prompts verbatim, in your home directory, derived from transcripts already
on disk. `/api/search` is auth-gated like every other `/api/*` route — it is the endpoint where a
leak *is* the content. Any public screenshot of this tab must come from a **synthetic** corpus.

**Endpoint:** `GET /api/search` — its full contract is in [`api.md`](api.md#get-apisearch).
