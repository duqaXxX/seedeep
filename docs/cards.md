# Tracker cards per session

The Commits card answers *what did this session ship*. This one answers the other half: **which
tracker card was it working on** — and, from Search, which sessions worked on a given card. This
document states the CURRENT rules. Code: `apps/server/src/core/tracker-cards.ts` (pure),
`apps/server/src/server/transcript-scan.ts` (the one pass over a transcript),
`apps/server/src/server/session-cards.ts` (the join), `apps/server/src/client/cards-view.ts`
(card + drawer).

## The signal is an ACTION, never a mention

A tracker key typed in a prompt is the widest signal and the weakest evidence: most of what looks
like one names no tracker at all — `GPT-4`, `RSA-2048`, `UTF-8`, `CVE-…`, `ISO-8601`.

So no text is read. A card is attributed only when a **tool call named it**, and the id comes from
the call's own id FIELD (`input.id`, `input.issueId`), never from its body:

| Evidence | What it means | Where it comes from |
|---|---|---|
| `wrote` | the session CHANGED the card | `save_…`, `create_…`, `update_…`, `delete_…`, `add_…`, `remove_…`, `assign_…`, `move_…`, `archive_…`, `comment_…` MCP verbs; a `gh issue close/comment/edit/reopen/create/…`; a closing keyword in a commit message |
| `read` | it only looked | any tracker call that is not one of those write verbs (`get_…`, `list_…`, …); `gh issue view` |

Merged per card, a write anywhere wins: a session that edits a card also read it, and the edit is
what makes the link real.

Unlike a commit, the relation is **many-to-many** — one card can be touched by several sessions.
Nothing here claims exclusivity, and the card never says "the" session.

## Title and link come back for free, offline

Both are read out of the tool_result of the call that touched the card. A single call may carry
neither — a comment does not — but merged per card, the read or write beside it supplies both. A
card with no title renders as its bare id, which is a true row, not a broken one.

The MCP link is **never constructed**: it is the `url` the tracker itself returned, accepted only
when it names that same card (a description can hold any number of links). So no tracker host is
hardcoded anywhere, and a self-hosted tracker links correctly without a line of code.

No network call is made at read time — for the tracker or for the forge.

## Which trackers work

Recognition is by SHAPE, not by vendor: any MCP tool whose name carries `issue` or `comment`, and
whose id field looks like `ABC-12`, qualifies. Linear and Jira share that key shape, so both work;
so does a self-hosted tracker exposing the same verbs. The `mcp__` prefix keeps ordinary tools out.

**Without an MCP tracker, this card stays empty** unless the session uses `gh issue` or closing
keywords. That is deliberate: the commit-message signal alone (a bare key in free text) reopens
exactly the class of false positives the id-field rule removes.

## Forge issues (`gh issue`, `Closes #N`)

`gh issue close 42` is a `tool_use` naming its issue the way `git commit` names its repository, so
it needs nothing new: the repository comes from the session's cwd through the same `resolveRepo` +
`origin` path the commit link uses, and `#42` is keyed by repository (`host/owner/repo#42`) because
a number is unique only there. That identity has ONE definition (`repoSlug`), so an issue reached
both from the cwd and from `--repo` is one row, not two. `-R/--repo owner/repo` overrides the cwd —
most reads in a real corpus are OTHER projects' issues, read as documentation, and scoping them to
the session's own repo would key them wrongly and link to a page that does not exist.

A command counts only where a shell would really start one (line start, or after `;`, `&&`, `||`,
`|`, `$(`), only for a REAL subcommand, and its arguments stop at its line. Each rule keeps prose
out: a printed sentence naming `gh issue` is not a command, and a heredoc writing one as data does
not run it. A chained line (`gh issue comment 2 …; gh issue close 2`) is two touches, not one.

LIMIT: when `--repo` gives no host, the link assumes `github.com`, since the transcript does not
record `GH_HOST`. The key is right either way; only the link would point at the wrong forge.

The title of a forge issue is read from whatever the command printed, in four observed shapes:
`--json` output; `title:<tab>…` from `gh issue view` with no tty; `✓ Closed issue owner/repo#2 (The
title)`, gh's own confirmation — so an action that never asked for the title still yields one; and
`[open] Issue #2: The title`, the shape a wrapper that reformats gh's output prints. A shape none of
them matches costs the row only its title: the id, the link and the evidence come from the command
itself.

## What the user sees

The output row reads left to right as **Main tools · Commits · Cards** — what the session ran, what
it shipped, what it was working on — at a fixed **50 / 25 / 25**. Main tools leads because it is the
widest card and the one most read. All three are always
drawn: a widget that appears only once it has content cannot report that there is none,
and its absence is indistinguishable from seedeep not looking. Empty, this card says `No tracker
card in scope yet.` and hides its **Expand all**, which would open an empty drawer.

Each row: the id, a `read` chip when the session only looked, the title, and a click that opens the
card on its tracker. A row with no link says so instead of doing nothing. The card shows the newest
4 and defers the rest to the drawer, where every card is listed with how many calls named it
(`4 tool calls`) — spelled out, since a bare `×4` reads as a count of cards, and
named `tool calls` because everywhere else on the page a bare `calls` now means a call to the model.

## The inverse: search by card id

Typing `ABC-12` or `#42` in Search also returns the sessions that ACTED on that card — the sessions
the dialogue index cannot see, because the id lives in a tool call and often nowhere in what was
said. Same row shape as any other result, with zero hits, honestly (see `docs/search.md`).

The query test is permissive on purpose: `GPT-4` reaches the lookup and finds nothing, because the
answer comes from ids observed in tool calls, never from text.

The lookup is answered from an **index**, not by reading the corpus. The commit-hash inverse can
skip one: git is an index that already exists, so it asks which repository holds the object and
opens only the sessions bracketing it. Nothing indexes a tracker id, so reading every transcript on
every query is the only alternative — and a cache the query cannot use is not a cache.

`apps/server/src/server/cards-index.ts` is that index: same shape as session search's
(`search-index.ts`), its own file (`~/.seedeep/cards-index.jsonl`), a header plus one line per
session, a `(size, mtime)` staleness stamp, incremental refresh, atomic rename. It is refreshed only
when the query looks like a card id: a text search must not pay for an index it cannot use.

LIMIT: staleness is stamped from the PARENT transcript, so a subagent sidecar that grew without its
parent being written would not be re-indexed. In practice the parent carries both the spawn and the
result, so it moves too.

## Cost

Nothing new is read. `transcript-scan.ts` makes ONE pass per transcript, cached against its
size+mtime, and both the commits join and this one consume it — so a session that already rendered
its Commits card pays nothing to render its Cards card. Subagent sidecars are included: a
subagent's card is its parent session's card.

**Endpoint:** `GET /api/cards` — its full contract is in
[`api.md`](api.md#get-apicommits-get-apifiles-get-apicards).
