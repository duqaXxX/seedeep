// What a failed tool call MEANS. Claude Code marks two different things with the same
// `is_error: true` flag: a tool that genuinely failed, and a tool the user refused to run
// (Esc on the permission prompt, or a deny rule). They are not the same event — one is the
// agent hitting a wall, the other is the user steering — and seedeep only badges the first.
//
// Measured over 3269 real session files: 1888 `is_error: true` results, of which 246 are
// refusals and 1642 real failures (2.9% of all 56_562 tool_results).

/** A `tool_result`'s verdict: it succeeded, it failed, or the user refused to run it. */
export type ToolOutcome = 'ok' | 'failed' | 'denied';

// The refusal texts Claude Code writes itself, matched ANCHORED at the start of the result.
// A loose `includes('permission')` mis-reads real Bash failures whose OUTPUT happens to
// mention it (measured false positives: pytest output, `df`, `gh` errors) — those are
// failures the user should see, so the match must be on the verdict CC wrote, not on the
// body it wrapped.
// LIMIT: these markers are Claude Code's own strings, not a field — the schema radar
// (field-names only) and the probe (no scene provokes a refusal) both miss a change to them.
// If CC rewores the refusal wording, a refusal would silently re-count as a failure until a
// contributor notices. Guarding them needs a probe scene that provokes a rejected tool +
// a denied one; tracked as a follow-up.
const REJECT_PREFIX = "the user doesn't want to proceed with this tool use";
const PERMISSION_PREFIXES = ['permission to use ', 'tool permission request failed'];
// The one refusal that is not a prefix: CC states it inside a <tool_use_error> wrapper.
// Bounded to the head of the text so a tool that PRINTS this sentence cannot fake it.
const PERMISSION_DIR_MARKER = 'is in a directory that is denied by your permission settings';
const MARKER_SCAN_CHARS = 200;

/**
 * Classify a `tool_result` block. `isError` is the block's own `is_error`; `text` is its
 * rendered content; `denialKind` is the LINE's `toolDenialKind`.
 *
 * `denialKind` is authoritative but young — Claude Code only began writing it in 2.1.198,
 * and it covers 130 of 246 real refusals — so the text markers cover every session written
 * before it, plus directory denials, which never carry the field. Those markers are
 * Anthropic's strings, not ours: they can move on any release, which is why they live here
 * rather than inline, and why the schema guard claims them.
 */
export function toolOutcome(isError: unknown, text: string, denialKind: unknown): ToolOutcome {
  if (isError !== true) return 'ok';
  if (typeof denialKind === 'string' && denialKind.length > 0) return 'denied';
  const head = text
    .trimStart()
    .replace(/^<tool_use_error>/, '')
    .trimStart()
    .toLowerCase();
  if (head.startsWith(REJECT_PREFIX)) return 'denied';
  for (const p of PERMISSION_PREFIXES) if (head.startsWith(p)) return 'denied';
  if (head.slice(0, MARKER_SCAN_CHARS).includes(PERMISSION_DIR_MARKER)) return 'denied';
  return 'failed';
}
