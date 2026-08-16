# What a session produced

Three cards sit in one row and answer the same question from three angles: **the commits** a session
produced, **the files** those commits delivered, and **the tracker cards** it worked on. They share
one reading of the transcript and one posture toward the repository, which is why they share a
document.

Code: `apps/server/src/server/transcript-scan.ts` (the single pass every join consumes),
`apps/server/src/server/git.ts` (every git read), `apps/server/src/core/commit-attribution.ts`,
`apps/server/src/core/file-attribution.ts`, `apps/server/src/core/session-artifacts.ts` and
`apps/server/src/core/tracker-cards.ts` (pure), `apps/server/src/server/session-commits.ts`,
`session-files.ts`, `session-cards.ts` and `cards-index.ts` (the joins), and
`apps/server/src/client/commits-view.ts`, `cards-view.ts` and `renderFiles`/`openAllFiles` in
`graph.ts`.

## What the three have in common

**One pass over the transcript, cached.** `transcript-scan.ts` reads a session once, keyed on its
size and mtime, and all three joins consume that reading — so a session that has already rendered
its Commits card pays nothing to render the other two. Subagent sidecars are included: a subagent's
commit, file or card is its parent session's.

**The repository is only ever read**, through `rev-parse`, `log`, `remote get-url`, `rev-list` and
`diff-tree`. No index is taken, and that is enforced rather than assumed: every call carries
`--no-optional-locks`. Some porcelain refreshes the index as a side effect and takes
`.git/index.lock` to do it, and seedeep polls the repository of a session that may be committing
right now — taking that lock even for a millisecond can fail the user's own `git add`.

**A repository is identified differently by the two features that need one, on purpose.** Commits
key it by `git rev-parse --git-common-dir`: two worktrees report different toplevels and the same
common dir, and `git log --all` from either sees both their commits, so parallel worktree sessions
collapse to one reader. Files key it by TOPLEVEL instead: there the path matters as much as the
history, because a file of a commit made in worktree B lives under B's toplevel.

**Nothing here asks a network anything** — not a forge, not a tracker. Every link is built offline
from what the transcript and the repository already hold.

## Commits

### Where the data comes from

Two sources answer two different questions, and neither can answer the other's:

| Source | Answers |
|---|---|
| The session transcript (`~/.claude/projects/**.jsonl`) | **who** ran a commit, and what its command printed |
| The repository, read with `git` | **what exists**: the surviving hash, its real subject, date and branch |

There is **no forge API call** — see *The forge link* below.

### The forge link

Built offline from `origin`, in three steps (`remoteBase` + `commitUrl` in `apps/server/src/server/git.ts`):

1. `git remote get-url origin`.
2. Normalise to https — git stores three shapes: the scp one (`…@host:owner/repo.git`, the user
   being `git`), `ssh://…@host/owner/repo.git`, and `https://host/owner/repo.git`. The `.git`
   suffix and any trailing slashes go.
3. Append `/commit/<hash>`, or `/-/commit/<hash>` when the host contains `gitlab.`.

| Remote | Link |
|---|---|
| scp form on `github.com`, `owner/repo` | `https://github.com/owner/repo/commit/<sha>` |
| scp form on `gitlab.com`, `group/subgroup/repo` | `…/group/subgroup/repo/-/commit/<sha>` — GitLab subgroups work, the path is copied whole |
| `https://gitlab.example.com/group/repo.git` | `…/-/commit/<sha>` |
| scp form on a self-hosted GitLab (`git.company.it`) | `…/commit/<sha>` — no `/-/`, and still correct: see below |

**A self-hosted GitLab on an arbitrary domain still works.** The host test is a heuristic and it
misses `git.company.it`, so that repo gets the plain path — which GitLab redirects to
`/-/commit/<sha>`. The heuristic only saves a redirect; it is not what makes GitLab work. GitHub,
Gitea and Codeberg take the plain path natively.

LIMIT: **Bitbucket** serves commits at `/commits/<hash>` (plural). seedeep produces `/commit/`,
and whether Bitbucket redirects it has NOT been verified — treat Bitbucket as unsupported until
someone measures it.

LIMIT: **Azure DevOps** uses a different shape entirely (`…/_git/<repo>/commit/<hash>`), and a
remote of the form `https://<user>@dev.azure.com/…` keeps its userinfo in the generated link.

Covering either properly means an explicit per-forge map with a declared fallback, not another
hostname heuristic.

### Attribution: proof first, testimony second, otherwise nothing

| Level | Rule |
|---|---|
| **Proof** | The commit's hash appears in the output of that session's own `git commit` call — the same `tool_use`/`tool_result` pair. No text matching. The only bounds are ordering ones: the commit must be authored after that session's previous commit call and no later than this one (plus a 120 s tolerance, since the call's timestamp is when it returned). |
| **Testimony** | No hash came back (`-q`, or a proxy that swallowed the output). The commit's subject must then appear in a `git commit` command run within ±120 s — its first 32 characters, which is long enough to be unique and short enough to survive a message the shell reflowed — and exactly ONE session of the repo may claim it. |
| **Unattributed** | Anything else, including two claimants. The commit is simply not listed. |

A commit is **never** handed to the nearest session in time. With two sessions on one repo that
would be a guess, and a wrong commit under a session is worse than a missing one.

Rules that follow from how the data really behaves:

- **A call proves only what it made, not what it printed.** `git commit && git log --oneline -5`
  names four older commits, possibly another session's. A named hash counts only when the commit
  was authored after that session's previous commit call.
- **The repo's identity is `git rev-parse --git-common-dir`, not the toplevel.** Two worktrees
  report different toplevels and the same common dir, and `git log --all` from either sees both
  their commits — so parallel worktree sessions collapse to one reader.
- **`git -C <path> commit` does not contain the string `git commit`.** The command test tolerates
  options between the two words — a flag may carry a value, and that value may not itself begin with
  `-`. The restriction is what keeps the match linear on a command that never reaches `commit`, and
  it costs nothing: a `-`-leading token is read as the next flag and still matches.
- **Subagents commit too.** Their sidecar transcripts (`<slug>/<uuid>/subagents/agent-*.jsonl`) are
  scanned with the parent's, and their commits are the parent session's.
- **Attribution is exclusive across sessions**, computed once per repo over every session whose
  window overlaps. Computing it per session in isolation would put one commit in several lists.
- **Author date, not committer date.** A rebase moves the committer date; `--since/--until` filter
  on it, so the range asked of git is padded by a day and the author date is filtered in memory.

### Finding the repository

From the session's `cwd` (present on every transcript line), walking up via `rev-parse`. When the
cwd is not inside a repo — a session run one directory above its workspace — the repo is taken
from the paths the commands name: `git -C <path>` and `cd <path>`, absolute or relative to that
line's cwd.

LIMIT: if the project directory has since been renamed or moved, the path the session recorded no
longer resolves and the session lists no commits. seedeep cannot know where the directory went.

**A directory that cannot be ENTERED is not a directory without commits**, and the answer says
which. When no repository is found for a session that did run `git commit`, each of its `cwd`s is
put to one `access` check (`whyNoRepo`, `apps/server/src/server/git.ts`) and `SessionCommits` comes back with
**`denied: true`** if any of them exists but refuses entry. Only then — the ordinary path, where a
repository resolved, costs nothing.

The codes: `EACCES` for a directory whose mode forbids entry, `ENOENT` for one that is not
there. `EPERM` counts as denied too, because that is what a macOS privacy gate
answers. `ENOENT` deliberately does NOT: a moved project is the LIMIT above, and telling that user
to grant a permission is advice for a problem they do not have.

LIMIT: a sibling session is considered when its `lastActivity` falls within a day of this
session's span. A session left open for a week after committing inside the window is missed, and
its commit could be claimed here by testimony (never by proof).

### What the Commits card shows

- **The Commits card** sits in the output row behind Main tools, which leads it (the maintainer's call —
  the widest card and the one with the most to read takes the position the eye reaches first).
  Commits is a quarter of the row, Cards the last quarter. It carries the count, the four newest commits (short hash + subject) and
  `+ N more →` into the drawer. At that width a typical subject fits whole.
- **The short hash is cyan** (`--agent`).
- **The card is ALWAYS there, empty or not** (the maintainer's call): a missing widget cannot
  distinguish "this session shipped nothing" from "seedeep did not look". Empty, it says
  `No commits in scope yet.` and its **Expand all is hidden** — the drawer is built from the rows,
  so on an empty card that button would do nothing.
- **Unless it was REFUSED the folder**, in which case it says so instead: *"Cannot read this
  session's folder, so its commits are unknown"*, with the gesture that fixes it. Same distinction
  as the bullet above, one level deeper — only one of the two states is the user's to act on. On
  macOS the second is ordinary rather than exotic: `~/Documents`, `~/Desktop` and `~/Downloads` are
  gated, and a session working in one of them is invisible until a system dialog is answered.
- **The drawer** lists every commit, oldest first, with subjects wrapped rather than clipped.
- **A row without a link** is a commit that is not pushed (or a repo with no `origin`). It carries
  a `local` chip, its hash goes quiet and it does not open anything — a link would 404. The chip
  is on the row, not only in a tooltip: a row that does nothing when clicked otherwise reads as
  broken.
- **The description states what the card can do.** With something pushed it invites the click;
  with everything local it says so instead — a card that promises an action it cannot perform is
  the card lying about itself.
- **Freshness**: fetched once when the replay hands off, then every 60 s while the session is live,
  and once more when it ends.

## Changed files

### The count is the session's commits, and nothing else

Claude Code's rewind ledger (`file-history-delta`) records only what CC's own file-writing tools
wrote. A file written by a `python3` heredoc, a `cat >>` or the build leaves no delta at all, so a
card fed by the ledger undercounts what the commit actually carried.

The missing half cannot be recovered by inference either. **Which session wrote a file by shell is
recorded nowhere on disk** — with two sessions working the same repository no source tells them
apart, and any rule based on timing is a guess. A count that is a guess is worse than no count.

So the card counts the files of the commits attributed to the session (*Commits*, above), which is
both complete — a commit carries what changed, not how it was written — and provably that session's.
The number is reproducible: `git show --stat <hash>` for each commit the drawer names.

**The working tree is NOT a second source.** `git status` describes the repository now, not what one
session did: two live sessions in one repo would each claim the whole dirty tree, and changes made
before a session started would be credited to it. That is the same
inference this feature refuses everywhere else. The cost is stated plainly: while a session is
working and has not committed, the card has nothing to show and says so.

A path delivered by several commits counts ONCE, keeping the latest — the commit a reader would open
to see its current state — so the hero can never exceed the distinct files the commits carry.

### One number, and a description that names its source

The hero is the file count. The card's DESCRIPTION doubles as its caption, so the widget needs no
trailing line for it — one line, rewritten per render:

| State | Description |
|---|---|
| the session committed | `Files in 2 commits.` |
| it committed nothing | `Nothing committed in this session.` (`…in this turn.` when one is selected) |
| git could not answer | `The repository could not be read.` |
| outside a repo | `This session is not inside a git repository.` |
| the answer has not arrived | `Reading the repository…` |

`The repository could not be read.` is NOT the same state as "nothing committed": `readCommitFiles`
returns null when git fails (missing binary, unreadable repo, the 5 s timeout) and an empty array
when a commit genuinely lists no files. Reporting a failed read as "nothing committed" would be the
card asserting something it never learned.

The description carries **no second count**: two numbers on one card invite a subtraction, and the
first time they fail to add up the card reads as broken. At session scope the commit count is the
server's; with a turn selected it is the distinct commits among the rows on screen, counted by
HASH — deriving it from timestamps would
merge two commits made in the same second, since git author dates are whole seconds.

A session that committed work started by earlier sessions shows all of that commit's files. That is
true and verifiable ("this session delivered 23 files"), and it is not the same claim as "this
session wrote 23 files" — which no source can support.

### The scratchpad row

Claude Code's per-session scratchpad lives outside the repository, so no commit can carry it. This
is the one thing the ledger alone knows, and the only reason it is still read: scratchpad paths get
their own row under the bars (`+N scratchpad files`), never the hero. Everything else the ledger
holds — including CC's own memory notes — is dropped: it is not work on the project.

`isScratchPath` classifies on the `~scratch` token `anon` produces, so a ledger path is anonymized
BEFORE it is tested — the scratchpad root is spelled three ways across platforms, and the raw path
does not identify it.

**`trackingPath` has two shapes**: absolute, or relative to the session's cwd. `ledgerPath` resolves
relative → absolute (`backup.realParentDir` first, then the last cwd seen in the file). With
neither, the path is left exactly as CC wrote it — never guessed.

### Reading a commit's file list

`readCommitFiles` passes `-z`: `--name-only` C-quotes any path outside ASCII (`core.quotePath`
defaults to true), so `src/café.ts` would come back as a `"src/caf\303\251.ts"` literal — a string
that matches no other spelling of the file, defeats the root-prefix strip, and shows a reader an
escape blob. A commit's file list never changes, so it is memoised per `(repo, hash)`.

Every repo root a session touched is sent to the client, and a row is shortened against the longest
one that matches — a session moving between two repos would otherwise show one set of rows relative
and the other absolute.

### The published-artifacts row

A page published with the `Artifact` tool is the one thing a session delivers that does not live on
this machine at all: the HTML behind it is a scratchpad temporary, while the page stays online. The
URL is what survives the session, and losing it loses the work.

It gets its own row under the bars (`+N published artifacts`), never the hero, for the same reason
the scratchpad row does: a page put online is not a file this session changed. The drawer then lists
each page as a real link, under its own heading, with a third KPI tile.

**The row counts PAGES, not publishes.** A redeploy passes the page's own `url` and overwrites it, so
a count of publishes would be a number the reader can find nowhere. The last publish to a URL wins,
so the label is the description that matches what is online now. Same rule as a path delivered by
several commits.

**A publish is recognised by its `file_path` first, and only then by the URL its result names.** The
reading form (`action: "list"`) returns a result FULL of artifact URLs — one per page the user owns —
so the URL alone would turn one listing into a dozen rows claiming this session had published them
all. A publish whose result names no page (it failed) leaves no row: only the server can say a page
exists.

Both this row and the scratchpad one come from the transcript, so a session **outside a repository
still shows them**: git having nothing to say is not the same as the session having delivered
nothing.

### Scope

Session scope shows everything. With a turn selected, files are filtered by TIME: a file falls in
the turn whose `[start, next start)` contains the instant of the commit that delivered it. A
published page follows the same rule, on the instant of its publish — a row that ignored the turn
would contradict its neighbours. The description follows the selection, counting the commits
actually on screen.

### Refresh

`GET /api/files`, on the same 60 s beat as Commits, plus a debounced refetch (1.5 s) whenever the
ledger grows — a delta is the only on-transcript signal that files are moving; a commit announces
nothing. The debounce is registered through `later()`, so it dies with the tab: a stray timer would
re-render a torn-down graph and restart its 1 s ticker forever. The answer repaints through
`scheduleRender`, never a direct `render()`, which would bypass the `live` guard and draw the whole
bento mid-replay.

Until the first answer lands the card shows no number and says `Reading the repository…`; the drawer
says so too, instead of rendering an empty list under a filter box, which reads as "your filter
matched nothing". Once the answer HAS landed and the list is still empty, the drawer names the state
it is actually in (`Nothing committed in this session.`, or whichever line the card carries) and
says `No files match the filters.` only when a filter really is set.

### Limits

- A **merge commit** lists no files (git would need `-m`, which reports each file once per parent).
- A session that has **not committed** shows no number, however much it wrote — including every live
  session before its first commit. Work a later session commits appears on that session's card.
- A session **outside a repo** has no count at all (it can still carry the two secondary rows).
- The card says what was **delivered**, not who typed it (see the note on shared commits above).
- A published page is listed from the transcript, so seedeep says it EXISTED, never that it is still
  online — nothing here asks claude.ai anything, and a page the owner deleted would still be listed.

## Tracker cards

### The signal is an ACTION, never a mention

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

### Title and link come back for free, offline

Both are read out of the tool_result of the call that touched the card. A single call may carry
neither — a comment does not — but merged per card, the read or write beside it supplies both. A
card with no title renders as its bare id, which is a true row, not a broken one.

The MCP link is **never constructed**: it is the `url` the tracker itself returned, accepted only
when it names that same card (a description can hold any number of links). So no tracker host is
hardcoded anywhere, and a self-hosted tracker links correctly without a line of code.

No network call is made at read time — for the tracker or for the forge.

### Which trackers work

Recognition is by SHAPE, not by vendor: any MCP tool whose name carries `issue` or `comment`, and
whose id field looks like `ABC-12`, qualifies. Linear and Jira share that key shape, so both work;
so does a self-hosted tracker exposing the same verbs. The `mcp__` prefix keeps ordinary tools out.

**Without an MCP tracker, this card stays empty** unless the session uses `gh issue` or closing
keywords. That is deliberate: the commit-message signal alone (a bare key in free text) reopens
exactly the class of false positives the id-field rule removes.

### Forge issues (`gh issue`, `Closes #N`)

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

### What the Cards card shows

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

## The inverse: finding the session from what it produced

Search answers the other direction too, for the two identifiers a user actually types
([`search.md`](search.md)). Both arrive with no session attached, and both return ordinary result
rows with zero hits — there is no passage to quote, because the session never said the identifier.

- **A commit hash** asks git which session produced it. The hash carries no repository, so every
  repo the corpus knows is asked whether it holds that object, and only the sessions whose activity
  brackets the commit are then read.
- **A tracker id** (`ABC-12`, `#42`) returns the sessions that ACTED on that card — the ones the
  dialogue index cannot see, because the id lives in a tool call and often nowhere in what was said.
  The query test is permissive on purpose: `GPT-4` reaches the lookup and finds nothing, since the
  answer comes from ids observed in tool calls, never from text.

## Endpoints

`GET /api/commits`, `GET /api/files` and `GET /api/cards` each take a `sessionId`. Their full
contract is in [`api.md`](api.md#get-apicommits-get-apifiles-get-apicards).
