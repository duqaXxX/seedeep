# Session search

**What it answers:** *"which session solved that problem?"*, when all you remember is a few words.
Type them, get the sessions whose dialogue contains **all** of them, open one in a tab or copy its
full id for `claude --resume`.

This is the reference for the CURRENT rules. Code: `apps/server/src/server/search-index.ts` (index + matching),
`apps/server/src/client/search-view.ts` (the tab), `apps/server/src/client/id-chip.ts` (the id chip),
`GET /api/search` in `apps/server/src/server/server.ts`.

## What is searched: the dialogue, not the transcript

The corpus is what was **said**:

- **your prompts** — typed text, and a slash command's **arguments** (never its `<command-name>`
  wrapper). Both shapes of a command count: the expanded one and the one Claude Code writes as the
  plain text you typed (`/code-review del diff`) — an argument-less command indexes as its own name
  (`/compact`), which is what the user sent;
- **Claude's text blocks** — its prose answers.

Everything else in a transcript is excluded: tool results, tool inputs, file contents, injected
instructions, system reminders, task notifications, compaction preambles.

That is not a simplification, it is the point. Searching the raw jsonl matches roughly **twice** as
often, and wrongly — the surplus is text the session never said. Measured over 988 real sessions
(2026-07-29):

| term | sessions matching the raw file | sessions matching the dialogue |
|---|---|---|
| `subagent` | 706 | 350 |
| `compaction` | 282 | 124 |
| `toast` | 168 | 90 |

Extraction goes through the REAL parser (`userLineIntent` + `CONTROL_COMMANDS` in `parser.ts`),
never a second reader of the same lines. A hand-rolled one produced two defects at once: it indexed
the command wrapper — so `clear` matched every session that ever ran `/clear` — and labelled every
such session `/clear`. That rule drops 13.9% of user lines (453 `<task-notification>`s, 63
compaction preambles, probe artefacts) and **not one human prompt**.

**LIMIT:** subagent transcripts are not indexed. They are a separate file per subagent
(`<uuid>/subagents/`), and their dialogue is machine-to-machine — an agent prompt written by Claude,
not by you.

## A commit hash also asks git

A query that is a single 7-40 character hex token is a commit hash, and the dialogue is the wrong
place to look for one: the hash of a commit normally appears only in the output of the command
that made it, which this index excludes by design. So a hash query ALSO asks git who produced that
commit, by the attribution in `docs/commits.md`, and merges those sessions into the same rows.

Nothing else changes: same row shape, same ordering, no extra section — only the set of sessions
grows. Measured over 90 commits from 30 sessions: text search alone returned the producing session
for 64 (71%), the merged answer returns it for 90 (100%), and 26 of those are sessions that never
wrote the hash anywhere in their dialogue. The slowest such query took 382 ms; a text query is
untouched (one regex decides, then nothing).

A session found this way carries **`hits: 0` and no snippet** — there is no passage to quote,
because it never said the hash. It therefore reads `0 per 1k` and sorts last under the default
density order. That is deliberate: the alternative was to invent an occurrence count the dialogue
does not contain.

An unknown hash adds nothing, and a hash in a repository seedeep cannot reach (renamed or moved
directory) is simply not found.

## A tracker id also asks the sessions' tool calls

The same reasoning, for the other identifier a user types into a search box. `ABC-12` or `#42` also
returns the sessions that ACTED on that card — read from their tool calls, by the rules in
`docs/cards.md`. The dialogue index cannot see those: the id lives in a call's id field, and a
session that worked a card for an hour may never have typed its key.

Same row shape, same ordering, same honest `hits: 0` as a hash match, and the same order of cost: a
hash is answered by git, a card id by its own persisted index (`cards-index.jsonl`, refreshed in
~7 ms over 716 sessions and queried in under a millisecond). That index is touched ONLY when the
query is shaped like a card id, so a text search pays nothing for it. See `docs/cards.md`. The shape test is deliberately
permissive — `GPT-4` and `UTF-8` pass it and simply match nothing, since the answer comes from ids
observed in tool calls, never from text.

## Matching: every word is an AND term

The query is lowercased and split on whitespace; a session must contain **every** term to be a
result. Adding a word can only narrow the set, never widen it.

One word is never enough on a real corpus — `toast` alone matched 90 of 988 sessions, `reducer` 130.
But AND is not enough either: `span-store + lane + subagent` still matched 104 sessions, of which
**91 were automated runs**. Which is why:

## The species split: your sessions, and the machine's

Rows are split with the same predicate the picker uses (`isAutomated`: `entrypoint` starting with
`sdk`). Your own sessions are listed; the automated runs (a docs gate, a `claude -p` script) sit
behind a `+ N automated runs … — show` control that **states its own count**. Nothing is dropped in
silence, and nothing is truncated: there is no top-N cut.

## Ordering: density by default

Three orders, selectable; each sorts by **the number the row prints** — a list ranked on something
else is a leaderboard nobody can check. The score box therefore changes with the key: it names the
quantity it is showing (`per 1k`, `times`, `last run`), and one table in `search-view.ts` holds the
comparator and the readout together, so a key cannot be added with one and not the other.

| order | key | shown as |
|---|---|---|
| **density** (default) | occurrences per 1k characters of dialogue | `2.6 per 1k` |
| occurrences | total occurrences of every term | `24 times` |
| recent | last activity | `16d` / `today` — *last run* |

Density is the default because **ordering by raw occurrences ranks session LENGTH**. Measured on
one real query: the top row by occurrences was a 369k-character session at 0.42 hits per 1k, while
the session actually about the query (9k characters, 24 hits, 2.60 per 1k) sat **fifth**.

The denominator is the dialogue **itself** — the characters that were said. The separators the
matcher joins utterances with are not part of it: charging them inflated the shortest sessions by up
to 12.5% (measured over 895 real sessions, 303 of them by more than 1%), which is precisely where
density decides anything.

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
with the rest of seedeep's state: `architecture.md`). One JSON line per
session (`path`, staleness stamp, dialogue segments) behind a version header; a missing, corrupt or
older-version file is treated as empty and rebuilt.

- **Incremental** on `(size, mtime)`, atomic on write (temp + rename), refreshes serialized.
- **Shape-checked on load.** An entry whose segments do not carry the current fields is discarded and
  the session re-read, and a field added to the segment type without being listed fails the BUILD —
  the same forcing function `aggregate-cache.ts` uses, for the reason recorded there: a version
  number nobody remembers to bump once shipped an aggregate reading zeros off a stale cache.
- **Refreshed on demand**, when a search runs: it costs nothing until you use the tab, and a session
  being written right now enters the results as of the query.
- **Its own file, deliberately.** `aggregates.json` (the retrospective/Compare cache) is rewritten
  whole on every refresh, and the dialogue is ~20 MB of prose that cache never reads. Sharing them
  would also mean bumping `CACHE_VERSION` — re-parsing the whole corpus — to add text the
  retrospective does not look at.

The lowercased text a query is matched against is **derived, never stored**, and it is keyed on the
ENTRY rather than on its path. That is the whole invalidation strategy: an entry's text cannot
change — a changed file becomes a new entry — so a stale derivation is unreachable. Keyed by path it
had to be invalidated by hand from inside the refresh loop, and a search landing in that window
re-derived the text being replaced: the session stayed findable by words it no longer contained,
until it changed again.

Measured on 988 sessions / 702 MB (2026-07-29): 19.5 MB of dialogue, ~0.8 s to build cold, 17–40 ms
per query, ~40 MB resident (the segments plus their lowercased twin). Scanning the transcripts per
query instead costs a **2.0 s floor** — even for a query that matches nothing, because the floor is
reading the corpus.

The query is a substring scan per term: ~300 ms at ten times this corpus. **Do not** add an inverted
or trigram index; nothing measured asks for one.

## Privacy

The index holds your own prompts verbatim, in your home directory, derived from transcripts already
on disk. `/api/search` is auth-gated like every other `/api/*` route — it is the endpoint where a
leak *is* the content. Any public screenshot of this tab must come from a **synthetic** corpus.
