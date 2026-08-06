# Changed files

seedeep shows, on a session, the files that session delivered. This document states the CURRENT
rules. Code: `src/core/file-attribution.ts` (pure), `src/server/git.ts` (the git reads),
`src/server/transcript-scan.ts` (one cached pass over a transcript, shared with commits and cards),
`src/server/session-files.ts` (the join), `renderFiles`/`openAllFiles` in `src/client/graph.ts`,
`GET /api/files`.

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

## Scope

Session scope shows everything. With a turn selected, files are filtered by TIME: a file falls in
the turn whose `[start, next start)` contains the instant of the commit that delivered it. The
description follows the selection, counting the commits actually on screen.

## Refresh

`GET /api/files`, on the same 60 s beat as Commits, plus a debounced refetch (1.5 s) whenever the
ledger grows — a delta is the only on-transcript signal that files are moving; a commit announces
nothing. The debounce is registered through `later()`, so it dies with the tab: a stray timer would
re-render a torn-down graph and restart its 1 s ticker forever. The answer repaints through
`scheduleRender`, never a direct `render()`, which would bypass the `live` guard and draw the whole
bento mid-replay.

Until the first answer lands the card shows no number and says `Reading the repository…`; the drawer
says the same instead of rendering an empty list under a filter box, which reads as "your filter
matched nothing".

## Limits

- A **merge commit** lists no files (git would need `-m`, which reports each file once per parent).
- A session that has **not committed** shows no number, however much it wrote — including every live
  session before its first commit. Measured: 76 of 151 local sessions that changed something carry a
  commit of their own; much of the rest is delivered by a later session, whose card then shows it.
- A session **outside a repo** has no count at all.
- The card says what was **delivered**, not who typed it (see the note on shared commits above).
