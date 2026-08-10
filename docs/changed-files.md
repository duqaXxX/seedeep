# Changed files

seedeep shows, on a session, the files that session delivered. This document states the CURRENT
rules. Code: `src/core/file-attribution.ts` (pure), `src/core/session-artifacts.ts` (pure),
`src/server/git.ts` (the git reads), `src/server/transcript-scan.ts` (one cached pass over a
transcript, shared with commits and cards), `src/server/session-files.ts` (the join),
`renderFiles`/`openAllFiles` in `src/client/graph.ts`, `GET /api/files`.

## The count is the session's commits, and nothing else

Claude Code's rewind ledger (`file-history-delta`) records only what CC's own file-writing tools
wrote. Measured on a real 16-file commit: **8** of those files had been written with a `python3`
heredoc, `cat >>` or the build, and the ledger knew nothing of them. A card fed by the ledger
therefore showed 8 while the terminal said 16.

The missing half cannot be recovered by inference either. **Which session wrote a file by shell is
recorded nowhere on disk** — with two sessions working the same repository no source tells them
apart, and any rule based on timing is a guess. A count that is a guess is worse than no count.

So the card counts the files of the commits attributed to the session (`docs/commits.md`), which is
both complete — a commit carries what changed, not how it was written — and provably that session's.
The number is reproducible: `git show --stat <hash>` for each commit the drawer names.

**The working tree was tried as a second source, and REMOVED.** `git status` describes the
repository now, not what one session did: two live sessions in one repo would each claim the whole
dirty tree, and changes made before a session started would be credited to it. That is the same
inference this feature refuses everywhere else. The cost is stated plainly: while a session is
working and has not committed, the card has nothing to show and says so.

A path delivered by several commits counts ONCE, keeping the latest — the commit a reader would open
to see its current state — so the hero can never exceed the distinct files the commits carry.

## One number, and a description that names its source

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
first time they fail to add up the card reads as broken — which is exactly what "10 files changed,
16 in the commit" did. At session scope the commit count is the server's; with a turn selected it is
the distinct commits among the rows on screen, counted by HASH — deriving it from timestamps would
merge two commits made in the same second, since git author dates are whole seconds.

A session that committed work started by earlier sessions shows all of that commit's files. That is
true and verifiable ("this session delivered 23 files"), and it is not the same claim as "this
session wrote 23 files" — which no source can support.

## The scratchpad row

Claude Code's per-session scratchpad lives outside the repository, so no commit can carry it. This
is the one thing the ledger alone knows, and the only reason it is still read: scratchpad paths get
their own row under the bars (`+N scratchpad files`), never the hero. Everything else the ledger
holds — including CC's own memory notes — is dropped: it is not work on the project, and counting it
as such is what once made a hero of 8 repo files read 10.

`isScratchPath` classifies on the `~scratch` token `anon` produces, so a ledger path is anonymized
BEFORE it is tested — the scratchpad root is spelled three ways across platforms, and testing the
raw path classified every temporary as a repo file.

**`trackingPath` has two shapes.** Measured over every local delta (2026-08-03): 609 of 1765 are
absolute, 1156 relative to the session's cwd, and `backup.realParentDir` carries the real directory
on 1192. `ledgerPath` resolves relative → absolute (realParentDir first, then the last cwd seen in
the file). With neither, the path is left exactly as CC wrote it — never guessed.

## Reading the repository must never write to it

Every git call goes through `git()` with `--no-optional-locks`. Some porcelain refreshes the index
as a side effect and takes `.git/index.lock` to do it: measured on git 2.50.1, `git status` rewrote
`.git/index` while the same command under this flag left it byte-identical. seedeep polls the
repository of a session that is actively committing, and taking that lock — even for a millisecond —
can fail the user's own `git add`/`commit`.

`readCommitFiles` passes `-z`: `--name-only` C-quotes any path outside ASCII (`core.quotePath`
defaults to true), so `src/café.ts` would come back as a `"src/caf\303\251.ts"` literal — a string
that matches no other spelling of the file, defeats the root-prefix strip, and shows a reader an
escape blob. A commit's file list never changes, so it is memoised per `(repo, hash)`.

Repos are keyed by TOPLEVEL here, not by `--git-common-dir` as in `docs/commits.md`: linked
worktrees share a history but not a path, and a file of a commit made in worktree B lives under B's
toplevel. Every root a session touched is sent to the client, and a row is shortened against the
longest one that matches — a session moving between two repos would otherwise show one set of rows
relative and the other absolute.

## The published-artifacts row

A page published with the `Artifact` tool is the one thing a session delivers that does not live on
this machine at all: the HTML behind it is a scratchpad temporary, while the page stays online.
Measured 2026-08-10 over the local corpus — 12 distinct pages, all 12 still reachable, the oldest 29
days — so the URL is what survives the session, and losing it loses the work.

It gets its own row under the bars (`+N published artifacts`), never the hero, for the same reason
the scratchpad row does: a page put online is not a file this session changed. The drawer then lists
each page as a real link, under its own heading, with a third KPI tile.

**The row counts PAGES, not publishes.** A redeploy passes the page's own `url` and overwrites it —
measured, 20 of 33 local publishes did, and one session republished a single page six times. `33`
would be a number the reader cannot find anywhere; the last publish to a URL wins, so the label is
the description that matches what is online now. Same rule as a path delivered by several commits.

**A publish is recognised by its `file_path`, not by the URL in its output.** The reading form
(`action: "list"`) returns a result FULL of artifact URLs — one per page the user owns — and matching
on the URL alone turned one listing into a dozen rows claiming this session had published them all.
A publish whose result names no page (it failed) leaves no row: only the server can say a page
exists.

**Attaching the URL to the scratchpad row it came from was tried and REJECTED.** The join key is
there (`Published <file> at <url>`), but only 11 of 33 local publishes have their file in the same
session's ledger: the other 22 are HTML written by a script, which Claude Code's own file-writing
tools never saw — the same missing half documented above. Two prototypes in three would have
vanished.

Both this row and the scratchpad one come from the transcript, so a session **outside a repository
still shows them**: git having nothing to say is not the same as the session having delivered
nothing.

## Scope

Session scope shows everything. With a turn selected, files are filtered by TIME: a file falls in
the turn whose `[start, next start)` contains the instant of the commit that delivered it. A
published page follows the same rule, on the instant of its publish — a row that ignored the turn
would contradict its neighbours. The description follows the selection, counting the commits
actually on screen.

## Refresh

`GET /api/files`, on the same 60 s beat as Commits, plus a debounced refetch (1.5 s) whenever the
ledger grows — a delta is the only on-transcript signal that files are moving; a commit announces
nothing. The debounce is registered through `later()`, so it dies with the tab: a stray timer would
re-render a torn-down graph and restart its 1 s ticker forever. The answer repaints through
`scheduleRender`, never a direct `render()`, which would bypass the `live` guard and draw the whole
bento mid-replay.

Until the first answer lands the card shows no number and says `Reading the repository…`; the drawer
says the same instead of rendering an empty list under a filter box, which reads as "your filter
matched nothing". Once the answer HAS landed and the list is still empty, the drawer names the state
it is actually in (`Nothing committed in this session.`, or whichever line the card carries) and
says `No files match the filters.` only when a filter really is set — the same defect, one step
later, and easy to reach now that a published page opens this drawer on sessions with no files at
all.

## Limits

- A **merge commit** lists no files (git would need `-m`, which reports each file once per parent).
- A session that has **not committed** shows no number, however much it wrote — including every live
  session before its first commit. Measured: 76 of 151 local sessions that changed something carry a
  commit of their own; much of the rest is delivered by a later session, whose card then shows it.
- A session **outside a repo** has no count at all (it can still carry the two secondary rows).
- The card says what was **delivered**, not who typed it (see the note on shared commits above).
- A published page is listed from the transcript, so seedeep says it EXISTED, never that it is still
  online — nothing here asks claude.ai anything, and a page the owner deleted would still be listed.
