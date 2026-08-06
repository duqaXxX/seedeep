/**
 * Which tracker card a session worked on.
 *
 * The mirror of the commit link: that one says what the session SHIPPED, this one says what it was
 * working ON. The signal is the same shape — an ACTION, never a mention. A key typed in a prompt is
 * the widest signal and the weakest evidence: measured over the local corpus, 27 of the 36
 * `[A-Z]{2,6}-\d+` prefixes seen in prompts name no tracker at all (`GPT-4`, `RSA-2048`, `UTF-8`),
 * so text is not read here. A card is attributed only when a tool call named it:
 *
 *  - WROTE: the session changed the card (`save_…`, `create_…`, `update_…`, or a `gh issue close`).
 *  - READ: it only looked (`get_…`, `list_…`, `gh issue view`).
 *
 * Two things arrive for free, offline, in the call's own result: the card's TITLE and its URL.
 * Measured per call they cover 71%, but a card is rendered per session, and merging every call that
 * touched it lifts that to 99% (411 of 415 rows) — a comment carries neither, the read or write
 * that accompanies it carries both. The URL is never constructed for an MCP card: it is read back,
 * so the tracker's own layout is whatever it is, and no host is hardcoded here.
 *
 * Unlike a commit, the relation is many-to-many: 17% of cards were touched by several sessions.
 * Nothing in this module claims exclusivity.
 */

/** How strongly the session is tied to the card: it changed it, or it only looked. */
export type CardEvidence = 'wrote' | 'read';
/** Where the touch was seen — an MCP tracker tool, or the forge's CLI. */
export type CardSource = 'mcp' | 'cli';

/** One call's contribution to one card, already scoped by the caller. */
export interface CardTouch {
  /** Unique within a session. An MCP key is global (`ABC-12`); an issue number is not, so it is
   *  scoped by repository (`owner/repo#42`). */
  key: string;
  /** What the row shows: `ABC-12`, or `#42`. */
  id: string;
  title: string | null;
  url: string | null;
  evidence: CardEvidence;
  source: CardSource;
  /** When the call's result landed, ms since epoch. */
  at: number;
}

/** One card as the client receives it. */
export interface SessionCard {
  key: string;
  id: string;
  /** Null only when no call that touched it returned one — 1% of rows, measured. */
  title: string | null;
  /** The card's page on the tracker, or null when nothing gave one back. */
  url: string | null;
  /** `wrote` if ANY touch wrote: a session that edits a card also read it, and the edit is what
   *  makes the link real. */
  evidence: CardEvidence;
  source: CardSource;
  /** Last touch, ms since epoch. */
  at: number;
  /** How many calls named this card — the row's weight, not just its presence. */
  touches: number;
}

/** The payload of `GET /api/cards`. */
export interface SessionCards {
  cards: SessionCard[];
}

/** A tracker key: `ABC-12`. Deliberately the same shape Linear and Jira both use. */
const KEY_RE = /^[A-Z][A-Z0-9]{0,5}-\d{1,6}$/;

/**
 * Field names whose value is escaped or plain inside a tool_result. The result reaches the
 * transcript as text, and whether its JSON is escaped depends on how the client wrapped it — both
 * forms occur, so both are matched.
 */
const RESULT_ID = /\\?"id\\?"\s*:\s*\\?"([A-Z][A-Z0-9]{0,5}-\d{1,6})\\?"/;
const RESULT_TITLE = /\\?"title\\?"\s*:\s*\\?"([^"\\]{1,200})/;
const RESULT_URL = /\\?"url\\?"\s*:\s*\\?"(https?:\/\/[^"\\\s]{6,300})/g;

/** Verbs that CHANGE a card. Anything else is treated as a read — the conservative direction: a
 *  read miscalled a write would invent work the session never did. */
const WRITE_VERBS = /(?:^|_)(?:save|create|update|delete|add|remove|assign|move|archive|comment)_/;

/**
 * True when an MCP tool name is a tracker call on an issue or a comment.
 *
 * Named by SHAPE, not by server: any MCP tool whose name carries `issue` or `comment` qualifies, so
 * a Jira or a self-hosted tracker exposing the same verbs works without a line of code here. The
 * `mcp__` prefix keeps ordinary tools (a `Bash` call mentioning "issue") out.
 */
export function isTrackerTool(name: string): boolean {
  return name.startsWith('mcp__') && /issue|comment/i.test(name);
}

/** Whether a tracker tool changed the card or only read it. */
export function trackerEvidence(name: string): CardEvidence {
  return WRITE_VERBS.test(name) ? 'wrote' : 'read';
}

/**
 * The card id a call names in its own id FIELD, or null.
 *
 * Reading the id from the field rather than from the call's JSON body is the whole difference
 * between a card and a false positive: a first pass over this corpus that stringified the input put
 * `SHA-256` among the top four "cards".
 */
export function cardIdFromInput(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  for (const field of ['id', 'issueId'] as const) {
    const v = (input as Record<string, unknown>)[field];
    if (typeof v !== 'string') continue;
    const k = v.trim().toUpperCase();
    if (KEY_RE.test(k)) return k;
  }
  return null;
}

/**
 * Id, title and url as the result gives them back.
 *
 * The id matters on its own: a CREATION carries no id in its input — that is what it returns — so
 * an input-only scan misses it. Measured: 166 such calls locally, 122 of them naming the new card
 * in their result.
 *
 * The url is accepted only when it names the card it belongs to. A result body can hold any number
 * of links (a description full of them); requiring the id in the path is what makes the first match
 * the right one. Measured: all 614 urls found this way named their own card.
 */
export function cardFromResult(
  text: string,
  known?: string | null,
): { id: string | null; title: string | null; url: string | null } {
  const id = known ?? text.match(RESULT_ID)?.[1] ?? null;
  const title = text.match(RESULT_TITLE)?.[1]?.trim() || null;
  let url: string | null = null;
  if (id) {
    const needle = id.toLowerCase();
    for (const m of text.matchAll(RESULT_URL)) {
      const candidate = m[1];
      if (candidate && candidate.toLowerCase().includes(needle)) {
        url = candidate;
        break;
      }
    }
  }
  return { id, title, url };
}

/** Subcommands of `gh issue` that CHANGE the issue, per `gh issue --help`. */
const GH_WRITE = new Set([
  'close',
  'reopen',
  'comment',
  'edit',
  'create',
  'delete',
  'lock',
  'unlock',
  'pin',
  'unpin',
  'transfer',
  'develop',
]);
/** ...and the ones that only look. `list` and `status` name no single issue at all. */
const GH_READ = new Set(['view', 'list', 'status']);

/**
 * `gh issue <sub> …` anywhere in a shell command — `gh` may sit behind a `cd … &&`.
 *
 * The subcommand is matched against the real ones ONLY. Accepting any word was a live bug: a
 * command that merely printed the phrase "gh issue has 19 calls" was read as an invocation and put
 * issue #19 under a session that never touched one. Prose is not a command.
 */
const GH_ISSUE = new RegExp(
  // Two guards, both learned from real transcripts:
  //  - `gh` must sit where a shell would START a command (line start, or after `; && || |` or a
  //    `$(`). Without it, a heredoc WRITING a command as data — `expect(parse('gh issue comment
  //    7'))` — counted as running it.
  //  - `[^\S\n]` is a space that is not a newline: a command's arguments end with its LINE. Letting
  //    `\s` run past it read a comment ending in `gh issue view`, followed by a shell loop, as an
  //    invocation of issue 6235 — the loop's first number, on the next line.
  String.raw`(?:^|[\n;&|(])[^\S\n]*gh[^\S\n]+issue[^\S\n]+(${[...GH_WRITE, ...GH_READ].join('|')})\b((?:[^\S\n]+[^\s;&|]+)*)`,
  'g',
);

/** `-R owner/repo`, `--repo owner/repo`, `--repo=[host/]owner/repo`. */
const GH_REPO = /(?:-R|--repo)[= ]([^\s;&|]+)/;

/**
 * The GitHub issues a shell command acts on.
 *
 * `gh issue close 42` names its issue exactly the way `git commit` names its repo, so this needs
 * nothing the commit link does not already have — the repository comes from the session's cwd.
 * A creation names no number (it returns one), so it is reported with `number: null` and resolved
 * from the call's output.
 *
 * LIMIT: this corpus exercises only `view` and `list` (19 invocations, zero actions), so the write
 * path is unit-tested against synthetic commands and unverified against a real one.
 */
export function parseGhIssues(
  command: string,
): Array<{ number: number | null; evidence: CardEvidence; repo: string | null }> {
  const out: Array<{ number: number | null; evidence: CardEvidence; repo: string | null }> = [];
  for (const m of command.matchAll(GH_ISSUE)) {
    const sub = m[1] ?? '';
    const wrote = GH_WRITE.has(sub);
    // `list` and `status` ask for all of them: no issue is named, so none may be claimed.
    if (sub === 'list' || sub === 'status') continue;
    const args = m[2] ?? '';
    // The first bare number after the subcommand — `--json title` and `-R owner/repo` are not it.
    // gh also takes the issue as a url, which is how one is pasted from a browser.
    const asUrl = args.match(/(https?:\/\/)?([^\s;&|]+)\/issues\/(\d{1,7})\b/);
    const num = args.match(/(?:^|\s)(\d{1,7})(?=\s|$)/)?.[1] ?? asUrl?.[3];
    // The repository the issue belongs to, when the command says. Measured on the real corpus,
    // most `gh issue view` calls carry it: they read OTHER projects' issues as documentation.
    const repo = command.match(GH_REPO)?.[1] ?? asUrl?.[2] ?? null;
    if (num) out.push({ number: Number(num), evidence: wrote ? 'wrote' : 'read', repo });
    else if (sub === 'create') out.push({ number: null, evidence: 'wrote', repo });
  }
  return out;
}

/**
 * The issue a `gh issue create` (or view) reports back, from the url it prints.
 *
 * A creation names no number in its command — the forge assigns one — so the only place it exists
 * is the output. `gh` prints the new issue's url as its last line.
 */
export function ghIssueFromResult(text: string): { number: number; url: string } | null {
  const m = text.match(/(https?:\/\/[^\s"'\\]+\/issues\/(\d{1,7}))\b/);
  if (!m || !m[1] || !m[2]) return null;
  return { number: Number(m[2]), url: m[1] };
}

/**
 * The issue title a forge command printed, or null.
 *
 * Four shapes, all observed rather than assumed — a command's output is not a contract, and a title
 * that cannot be read costs the row only its title (the id, the link and the evidence come from the
 * command itself):
 *
 *  1. `--json title,…` — JSON.
 *  2. `gh issue view` with no tty: `title:<tab>…`, verified against gh 2.x.
 *  3. `gh issue close/reopen`: `✓ Closed issue owner/repo#2 (The title)` — gh's own confirmation,
 *     which means an action that never asked for the title still yields one.
 *  4. `[open] Issue #2: The title` — the shape a wrapper that reformats gh's output prints. Matched
 *     because a title is worth having however it arrived, not because any one wrapper is supported.
 */
export function ghTitleFromResult(text: string): string | null {
  const json = text.match(/\\?"title\\?"\s*:\s*\\?"([^"\\]{1,200})/);
  if (json?.[1]) return json[1].trim();
  const table = text.match(/^title:[^\S\n]*(.+)$/m);
  if (table?.[1]) return table[1].trim();
  const confirmed = text.match(/\b(?:Closed|Reopened) issue \S*#\d{1,7} \((.+?)\)\s*$/m);
  if (confirmed?.[1]) return confirmed[1].trim();
  const labelled = text.match(/^\s*(?:\[[^\]]*\]\s*)?Issue\s+#\d{1,7}:\s*(.+)$/m);
  return labelled?.[1]?.trim() || null;
}

/** `Closes #42`, `Fixes #7`, `Resolves #13` — the forge's own closing keywords, as GitHub defines
 *  them. A commit carrying one CHANGES the issue when it lands, so it counts as a write. */
const CLOSES = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d{1,7})\b/gi;

/** Issue numbers a commit message closes. */
export function closingRefs(command: string): number[] {
  return [...command.matchAll(CLOSES)].map((m) => Number(m[1]));
}

/**
 * Collapse every touch onto one row per card, newest first.
 *
 * A write anywhere makes the row a write. Title and url take the LAST non-null value, not the
 * first: a session that renames a card should show the name it left behind, not the one it found.
 */
export function mergeTouches(touches: readonly CardTouch[]): SessionCard[] {
  const byKey = new Map<string, SessionCard>();
  for (const t of [...touches].sort((a, b) => a.at - b.at)) {
    const prev = byKey.get(t.key);
    if (!prev) {
      byKey.set(t.key, { ...t, touches: 1 });
      continue;
    }
    prev.touches++;
    prev.at = Math.max(prev.at, t.at);
    if (t.title) prev.title = t.title;
    if (t.url) prev.url = t.url;
    if (t.evidence === 'wrote') prev.evidence = 'wrote';
  }
  return [...byKey.values()].sort((a, b) => b.at - a.at);
}

/**
 * True when a whole query is a tracker id — `ABC-12` or `#42`.
 *
 * Permissive on purpose, and safe because of where it is used: the query is matched against the
 * ids actually observed in tool calls, so `GPT-4` reaches the lookup and finds nothing. The cost of
 * a false trigger is one map lookup; the cost of being strict is missing a real tracker's prefix.
 */
export function looksLikeCardId(query: string): boolean {
  const q = query.trim().toUpperCase();
  return KEY_RE.test(q) || /^#\d{1,7}$/.test(q);
}
