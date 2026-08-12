/**
 * Which session produced which commit.
 *
 * The transcript says WHO, git says WHAT EXISTS — neither answers the other's question, so this
 * module takes both and joins them. Two levels of evidence, and they are not equal:
 *
 *  - PROOF: the commit's hash appears in the output of that session's own `git commit` call —
 *    the same tool_use/tool_result pair. Measured on this repo's 425 commits: 378 (88.9%). It
 *    needs no time window and no text matching, so two sessions committing to one repo at the
 *    same moment cannot steal each other's commits.
 *  - TESTIMONY: no hash came back (the command was `-q`, or a proxy swallowed the output). Then
 *    the commit's subject must appear verbatim in a `git commit` command run within WINDOW_MS,
 *    and EXACTLY ONE session of that repo may claim it. Measured: 16 of 425, 0 collisions.
 *
 * Anything else stays unattributed. A commit is never handed to the nearest session in time:
 * with several sessions on one repo that would be a guess, and a wrong commit under a session
 * is worse than a missing one.
 */

/** A commit as git reports it — the authority on what exists. */
export interface RepoCommit {
  hash: string;
  /** Author date, ms since epoch (author, not committer: a rebase moves the committer date). */
  authoredAt: number;
  subject: string;
}

/** One `git commit` invocation seen in a transcript, with whatever its output gave back. */
export interface CommitCall {
  /** When the call's result landed, ms since epoch. */
  at: number;
  /** The shell command verbatim, as the tool_use carried it. */
  command: string;
  /** Hash-shaped tokens found in the call's own tool_result (any length, lowercase hex). */
  outputHashes: readonly string[];
}

/** The commit-relevant slice of one session's transcript. */
export interface SessionCalls {
  sessionId: string;
  calls: readonly CommitCall[];
}

export type Evidence = 'proof' | 'testimony';

export interface Attribution {
  hash: string;
  sessionId: string;
  evidence: Evidence;
}

/** One attributed commit as the client receives it. */
export interface SessionCommit {
  hash: string;
  short: string;
  subject: string;
  /** Author date, ms since epoch. */
  at: number;
  /** How it was attributed — `proof` is the hash in this session's own call output. */
  evidence: Evidence;
  /** The commit's page on the forge, or null when there is no origin or it is not pushed yet. */
  url: string | null;
}

/** The payload of `GET /api/commits`. */
export interface SessionCommits {
  commits: SessionCommit[];
  /** Browsable base of `origin`, or null — lets the client say "no remote" instead of guessing. */
  remote: string | null;
  /**
   * Set when the session's own directory could not be entered, so an empty list means REFUSED
   * rather than "no commits". Without it the card states the second while the first is true — which
   * is what a macOS privacy gate on `~/Documents` produces, silently, for as long as it stands.
   */
  denied?: boolean;
}

/** Commits within ±this of a `git commit` call may be claimed by testimony. */
export const WINDOW_MS = 120_000;
/** Subject prefix compared against the command — long enough to be unique, short enough to
 *  survive a message the shell reflowed. */
const SUBJECT_KEY = 32;

/** A call's output names this commit (prefix match, git abbreviates to 7+ chars). */
function outputNames(call: CommitCall, hash: string): boolean {
  return call.outputHashes.some((t) => t.length >= 7 && hash.startsWith(t));
}

/**
 * A call may only prove commits made BY it, not commits it merely printed. `git commit && git
 * log --oneline -5` names four older commits — possibly another session's. So a named hash
 * counts only when the commit was authored after the session's previous commit call.
 */
function provenBy(calls: readonly CommitCall[], index: number, commit: RepoCommit): boolean {
  const call = calls[index];
  if (!call || !outputNames(call, commit.hash)) return false;
  const prev = calls[index - 1]?.at ?? -Infinity;
  return commit.authoredAt > prev && commit.authoredAt <= call.at + WINDOW_MS;
}

/**
 * Attribute each commit to at most one session.
 *
 * `sessions` must hold EVERY session of the repo whose window overlaps the commits — exclusivity
 * is computed across them at once. Attributing per session in isolation would put the same commit
 * in several lists, which is exactly what the two-sessions-one-repo case produces.
 *
 * Returns one entry per attributed commit; commits with no evidence, or with more than one
 * claimant, are simply absent.
 */
export function attributeCommits(commits: readonly RepoCommit[], sessions: readonly SessionCalls[]): Attribution[] {
  const out: Attribution[] = [];
  for (const commit of commits) {
    const proof = new Set<string>();
    const testimony = new Set<string>();
    for (const s of sessions) {
      for (let i = 0; i < s.calls.length; i++) {
        const call = s.calls[i];
        if (!call) continue;
        if (provenBy(s.calls, i, commit)) proof.add(s.sessionId);
        if (Math.abs(call.at - commit.authoredAt) > WINDOW_MS) continue;
        if (commit.subject.length && call.command.includes(commit.subject.slice(0, SUBJECT_KEY))) {
          testimony.add(s.sessionId);
        }
      }
    }
    // Proof outranks testimony outright: it is the only evidence that survives concurrency.
    const claimants = proof.size ? proof : testimony;
    const only = claimants.size === 1 ? [...claimants][0] : undefined;
    if (!only) continue;
    out.push({ hash: commit.hash, sessionId: only, evidence: proof.size ? 'proof' : 'testimony' });
  }
  return out;
}

/** Hash-shaped tokens in a tool_result, for `CommitCall.outputHashes`. */
export function harvestHashes(output: string): string[] {
  return output.match(/\b[0-9a-f]{7,40}\b/g) ?? [];
}

/**
 * True when a whole query is a commit hash — 7 to 40 hex characters, the range git itself
 * abbreviates to and stores. Used to decide whether a search should ALSO ask git who made it;
 * every other query pays nothing but this test.
 *
 * Deliberately strict: a single token, no spaces. A 7-hex word can occur in prose, and looking it
 * up costs three subprocesses — but the lookup either resolves to a real commit or returns
 * nothing, so a false trigger changes no result.
 */
export function looksLikeCommitHash(query: string): boolean {
  return /^[0-9a-f]{7,40}$/.test(query.trim().toLowerCase());
}

/** True when a shell command runs `git commit` — `git -C <path> commit` and `git -c k=v commit`
 *  included, which a bare `includes('git commit')` misses (measured: 34 commits lost that way). */
export function isGitCommit(command: string): boolean {
  // A flag's VALUE may not itself start with `-`, and that restriction is what keeps this regex
  // linear rather than merely correct. With `\S+` there, a run of `-a -a -a …` could be split into
  // groups of one or two in Fibonacci-many ways, all of which are explored before a command that
  // never reaches `commit` is rejected: measured 685ms at 40 flags, and every four more multiply it
  // by three. Nothing is lost by the restriction — a `-`-leading token still matches, as the flag
  // of the next iteration. The input is the `command` field of a transcript's Bash lines, which
  // seedeep does not control.
  return /\bgit\b(?:\s+-\S+(?:\s+[^-\s]\S*)?)*\s+commit\b/.test(command);
}
