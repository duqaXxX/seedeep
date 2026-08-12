# Commits per session

seedeep shows, on a session, the commits that session produced — each one linking to its page on
GitHub or GitLab. This document states the CURRENT rules. Code:
`src/core/commit-attribution.ts` (pure), `src/server/git.ts` (the git reads),
`src/server/transcript-scan.ts` (one cached pass over a transcript, shared with the tracker-cards
feature — see `docs/cards.md`), `src/server/session-commits.ts` (the join),
`src/client/commits-view.ts` (card + drawer),
`GET /api/commits`.

## Where the data comes from

Two sources answer two different questions, and neither can answer the other's:

| Source | Answers |
|---|---|
| The session transcript (`~/.claude/projects/**.jsonl`) | **who** ran a commit, and what its command printed |
| The repository, read with `git` | **what exists**: the surviving hash, its real subject, date and branch |

This reads the user's repository, and it only ever reads: `rev-parse`, `log`, `remote get-url`,
`rev-list`. No index is taken, and that is now enforced rather than assumed — every call carries
`--no-optional-locks`, so no read can take `.git/index.lock` and fail a session's own `git add`
(see `docs/changed-files.md`). The Changed files card reads the repository too, through this same
module and with the same posture (`diff-tree`); nothing else in seedeep touches it.

There is **no forge API call** — see *The forge link* below.

## The forge link

Built offline from `origin`, in three steps (`remoteBase` + `commitUrl` in `src/server/git.ts`):

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
misses `git.company.it`, so that repo gets the plain path — which GitLab accepts. Measured against
a public gitlab.com repository on 2026-08-01:

```
/-/commit/<sha>   → 200
/commit/<sha>     → 301 → /-/commit/<sha> → 200
```

So the heuristic only saves a redirect; it is not what makes GitLab work. GitHub, Gitea and
Codeberg take the plain path natively.

LIMIT: **Bitbucket** serves commits at `/commits/<hash>` (plural). seedeep produces `/commit/`,
and whether Bitbucket redirects it has NOT been verified — treat Bitbucket as unsupported until
someone measures it.

LIMIT: **Azure DevOps** uses a different shape entirely (`…/_git/<repo>/commit/<hash>`), and a
remote of the form `https://<user>@dev.azure.com/…` keeps its userinfo in the generated link.

Covering either properly means an explicit per-forge map with a declared fallback, not another
hostname heuristic.

## Attribution: proof first, testimony second, otherwise nothing

| Level | Rule |
|---|---|
| **Proof** | The commit's hash appears in the output of that session's own `git commit` call — the same `tool_use`/`tool_result` pair. No time window, no text matching. |
| **Testimony** | No hash came back (`-q`, or a proxy that swallowed the output). The commit's subject must then appear in a `git commit` command run within ±120 s — its first 32 characters, which is long enough to be unique and short enough to survive a message the shell reflowed — and exactly ONE session of the repo may claim it. |
| **Unattributed** | Anything else, including two claimants. The commit is simply not listed. |

Measured on this repo's 425 commits: 378 proved (88.9 %), 16 by testimony, 0 collisions.

A commit is **never** handed to the nearest session in time. With two sessions on one repo that
would be a guess, and a wrong commit under a session is worse than a missing one.

Rules that follow from how the data really behaves — each was learned by getting it wrong:

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

## Finding the repository

From the session's `cwd` (present on every transcript line), walking up via `rev-parse`. When the
cwd is not inside a repo — a session run one directory above its workspace — the repo is taken
from the paths the commands name: `git -C <path>` and `cd <path>`, absolute or relative to that
line's cwd.

LIMIT: if the project directory has since been renamed or moved, the path the session recorded no
longer resolves and the session lists no commits. seedeep cannot know where the directory went.

**A directory that cannot be ENTERED is not a directory without commits**, and the answer says
which. When no repository is found for a session that did run `git commit`, each of its `cwd`s is
put to one `access` check (`whyNoRepo`, `src/server/git.ts`) and `SessionCommits` comes back with
**`denied: true`** if any of them exists but refuses entry. Only then — the ordinary path, where a
repository resolved, costs nothing.

The codes are measured, not assumed: `EACCES` for a directory whose mode forbids entry, `ENOENT` for
one that is not there, and `Bun.spawn` with such a cwd throws `EACCES` — which is exactly how every
git call was already failing, silently, into `null`. `EPERM` counts the same, because that is what a
macOS privacy gate answers. `ENOENT` deliberately does NOT: a moved project is the LIMIT above, and
telling that user to grant a permission is advice for a problem they do not have.

LIMIT: a sibling session is considered when its `lastActivity` falls within a day of this
session's span. A session left open for a week after committing inside the window is missed, and
its commit could be claimed here by testimony (never by proof).

## The inverse: search by hash

`GET /api/search` with a query that is a bare hash also asks git which session produced it, and
merges those sessions into the ordinary result rows (`docs/search.md`). The hash arrives with no
repo attached, so every repo the corpus knows is asked whether it holds that object — measured, 3
distinct repos over 713 sessions and 37 ms to ask them all — and only the sessions whose activity
brackets the commit are then read.

## What the user sees

- **The Commits card** sits in the output row behind Main tools, which leads it (the maintainer's call —
  the widest card and the one with the most to read takes the position the eye reaches first).
  Commits is a quarter of the row, Cards the last quarter. It carries the count, the four newest commits (short hash + subject) and
  `+ N more →` into the drawer. At that width a typical subject fits whole.
- **The short hash is cyan** (`--agent`).
- **The card is ALWAYS there, empty or not** (the maintainer's call). It used to join the row only
  once it owned a commit, which meant the 680 of 783 local sessions that produce none showed no such
  widget at all — and a missing widget cannot distinguish "this session shipped nothing" from
  "seedeep did not look". Empty, it says `No commits in scope yet.` and its **Expand all is hidden**:
  the drawer is built from the rows, so on an empty card that button would do nothing.
- **Unless it was REFUSED the folder**, in which case it says so instead: *"Cannot read this
  session's folder, so its commits are unknown"*, with the gesture that fixes it. Same distinction
  as the bullet above, one level deeper — "no commits" and "I was not allowed to look" had been
  arriving as the same empty card, and only one of them is the user's to act on. On macOS the second
  is ordinary rather than exotic: `~/Documents`, `~/Desktop` and `~/Downloads` are gated, and a
  session working in one of them is invisible until a system dialog is answered.
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
