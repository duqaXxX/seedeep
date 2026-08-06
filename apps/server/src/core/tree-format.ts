import type { ToolNode } from './session-tree.ts';

/**
 * One-line summary of a (possibly multi-line) prompt, for a row/tooltip/banner that has
 * room for exactly one line: whitespace collapsed, cut at `max` with an ellipsis. The
 * event carries the WHOLE prompt — shortening is the view's job, so the modal can still
 * show the original in full. Returns '' for an empty prompt.
 */
export function promptLine(prompt: string | null | undefined, max = 200): string {
  const flat = (prompt ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max).trimEnd() + '…' : flat;
}

/**
 * How an ENTRY names itself: its prompt, prefixed by the command that carried it.
 *
 * A command's arguments ARE its prompt, and on their own they are cryptic — a round titled
 * `del diff` names nothing, `/code-review del diff` names everything. Shared by the Graph's
 * `entryLabel` and the Trace's turn title, which had its own rule (`prompt || command`) and so
 * dropped the command from every round that carried arguments.
 */
export function entryText(prompt: string | null | undefined, command: string | null, max = 200): string {
  const line = promptLine(prompt, max);
  if (!command) return line;
  return line && !line.startsWith('/') ? '/' + command + ' ' + line : line || '/' + command;
}

/**
 * A tab's label: the project, then the session's subject cut to `max` chars
 * ('seedeep · fix the login redirect'). The project ALONE was the label, so two
 * sessions of one project were two identical tabs and the strip could not be read.
 * With no subject (a session with no human prompt in its head) the short session id
 * stands in — otherwise two subject-less tabs of one project collapse together again,
 * which is the very bug this fixes.
 */
export function tabLabel(s: { project: string; subject: string | null; sessionId: string }, max = 30): string {
  return `${s.project} · ${promptLine(s.subject, max) || s.sessionId.slice(0, 8)}`;
}

/**
 * Model id → its family name in lowercase ('claude-opus-4-8' → 'opus'), or null when
 * the id matches no known family (each surface picks its own fallback and casing).
 * One detector so the dropdown and the graph can never disagree on the family list.
 */
export function modelFamily(model: string | null | undefined): string | null {
  if (!model) return null;
  const m = model.toLowerCase();
  for (const fam of ['opus', 'sonnet', 'haiku', 'fable']) if (m.includes(fam)) return fam;
  return null;
}

/**
 * Human duration: null → 'running…', '<1s', 'Ns', 'Xm Ys', or 'Xh Ym' past an hour
 * (the smaller unit is omitted when zero). Each scale drops the one below it, because
 * seconds inside an 18-hour total are noise — and a session's working time really does
 * reach hours, where 'Xm' alone ('1080m') stops being a number you can read.
 */
export function formatDuration(ms: number | null): string {
  if (ms === null) return 'running…';
  if (ms < 1000) return '<1s';
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) {
    const s = totalSec % 60;
    return s === 0 ? `${totalMin}m` : `${totalMin}m ${s}s`;
  }
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/**
 * Duration of a single tool call, precision-preserving: null/undefined → 'running…',
 * sub-second keeps raw ms ('134ms' — the useful precision for one tool), sub-minute
 * keeps one decimal ('18.1s'), longer falls back to formatDuration ('2m 14s'). One
 * formatter so the feed, the drawer, and the tool lists can never disagree
 * ('32888ms' vs '2m 14s'). The decimal is TRUNCATED, not rounded: rounding would
 * show '60.0s' for 59950-59999ms, an impossible value under this scale.
 */
export function formatToolMs(ms: number | null | undefined): string {
  if (ms == null) return formatDuration(null);
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(Math.floor(ms / 100) / 10).toFixed(1)}s`;
  return formatDuration(ms);
}

/**
 * Offset from a list's first row, for orienting inside a long chronological list:
 * '+0s', '+42s', '+6m12'. Deliberately coarser than formatToolMs — this answers
 * "how far into the turn", where millisecond precision would be noise. Negative
 * input (a row before the anchor) clamps to '+0s'.
 */
export function formatOffset(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return '+0s';
  if (ms < 60_000) return `+${Math.floor(ms / 1000)}s`;
  return `+${Math.floor(ms / 60_000)}m${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}`;
}

const LAUNCH_FMT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/** Absolute launch time 'MMM DD HH:MM:SS' in local tz; null/invalid → ''. No relative time, no timers. */
export function formatLaunchTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  // Assemble from parts, not from format(): ICU inserts a locale-dependent separator
  // between date and time ("Jul 12, …" or "Jul 12 at …"), so composing from the
  // typed parts is the only stable way to get exactly "MMM DD HH:MM:SS".
  const p: Record<string, string> = {};
  for (const part of LAUNCH_FMT.formatToParts(d)) p[part.type] = part.value;
  return `${p.month} ${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/**
 * Strip the inline markdown the model writes (bold, inline/fenced code, links, leading
 * heading/list/quote markers) down to plain text, and collapse whitespace to single spaces —
 * for a glance surface (the intent panel) that renders text, not markdown, so raw `**` and
 * backticks would read as literal characters. Deliberately conservative: only the unambiguous
 * `**bold**` is unwrapped (not `_`/single-`*` emphasis) so `snake_case`, `a*b`, and file globs
 * survive untouched. The full markdown stays available, rendered, in the output modal.
 */
export function stripMarkdown(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, ' ') // fenced code block → space
    .replace(/`([^`]+)`/g, '$1') // inline code
    .replace(/\*\*([^*]+?)\*\*/g, '$1') // bold
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links → their text
    .replace(/^\s{0,3}#{1,6}\s+/gm, '') // headings
    .replace(/^\s{0,3}[-*>]\s+/gm, '') // list / quote markers
    .replace(/\s+/g, ' ') // collapse newlines + runs of space
    .trim();
}

/** Aggregate main tools into a count + per-name breakdown, sorted by frequency desc then name asc. */
export function summarizeTools(tools: Array<Pick<ToolNode, 'name'>>): {
  count: number;
  breakdown: Array<{ name: string; n: number }>;
} {
  const counts = new Map<string, number>();
  for (const t of tools) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
  const breakdown = [...counts.entries()]
    .map(([name, n]) => ({ name, n }))
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  return { count: tools.length, breakdown };
}
