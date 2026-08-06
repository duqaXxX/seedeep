// Session-derived text, made safe to leave the process. Shared by the parser (which folds
// text into events) and by the on-demand tool-output reader (which serves it to the GUI):
// both must anonymize the SAME way, or the same string would be safe on one path and leak a
// home path on the other.

/**
 * The rendered text of a `tool_result` / agent-output `content`: a string for most tools,
 * an array of `{type:"text",text}` for Agent/MCP/ToolSearch/some Read (verified on real
 * data). ALL text blocks are joined (a multi-block result would otherwise be under-measured
 * and shown truncated); non-text blocks are skipped. Anything else renders as ''.
 */
export function renderedText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts = content
      .map((b) => (b as { text?: unknown } | undefined)?.text)
      .filter((t): t is string => typeof t === 'string');
    if (texts.length) return texts.join('\n');
  }
  return '';
}

// What `anon` collapses a scratchpad root to: `anon` writes the token, `isScratchPath` is the only
// thing that classifies on it — the token, never the original path shape, which differs per
// platform and per how the same directory was named.
const SCRATCH_ROOT = '~scratch';

/**
 * True when an anonymized path names Claude Code's per-session scratchpad — the temp dir CC's own
 * system prompt (since 2.1.178) tells it to use for working files, so a write there is a
 * throwaway, not work on the project.
 *
 * THE single definition — the Changed files widget and the verdict's "shipped code" test both ask
 * it. A private path heuristic drifts from what `anon` actually produces: the word match this
 * replaced in `verdict.ts` also caught project code merely NAMED like a throwaway.
 */
export function isScratchPath(path: string): boolean {
  return path.startsWith(SCRATCH_ROOT);
}

/**
 * Anonymize + bound any session-derived string before it enters an event, a screenshot or a
 * versioned fixture: collapse scratchpad roots to `~scratch` (the token `isScratchPath` reads),
 * drop real home paths, strip control chars EXCEPT tab/newline/CR (meaningful in tool output),
 * cap at `cap` characters.
 */
export function anon(s: string, cap: number): string {
  return (
    s
      // Scratchpad root -> ~scratch. macOS resolves the dir as /private/tmp/claude-<uid>, but the
      // same dir is named without the /private prefix by 1358 of the local occurrences (measured
      // 2026-07-27) — matching only the long form left those unclassified. <uid> is `id -u`, NOT
      // the pid.
      .replace(/(?:\/private)?\/tmp\/claude-\d+/g, SCRATCH_ROOT)
      // The Windows root, %LOCALAPPDATA%\Temp\claude — the whole prefix goes, drive and user
      // included. LIMIT: folded from the shape reported in anthropics/claude-code#76562, never
      // observed here (no local Windows session to measure). The rules below are POSIX-only, so a
      // Windows home path outside a scratchpad is still unmasked.
      // The path between the drive and `Temp` is OPTIONAL: %LOCALAPPDATA% normally expands to
      // C:\Users\<name>\AppData\Local, but it is configurable, and requiring a segment there
      // silently skipped a root sitting directly under the drive.
      .replace(/[A-Za-z]:\\(?:.*?\\)?Temp\\claude(?=\\|$)/gi, SCRATCH_ROOT)
      // slug-encoded home in a project path: -Users-<name>- / -home-<name>-
      // LIMIT: the slug replaces every '/' with '-', so a username that itself contains a hyphen
      // (`mary-jane` → `-Users-mary-jane-`) is indistinguishable from `mary/jane`; only the first
      // segment is masked. Masking more would hide legitimate path segments in displayed output.
      .replace(/-(Users|home)-[^-/\s]+/g, '-$1-<x>')
      // real home paths (any user) -> ~
      .replace(/\/(?:Users|home)\/[^/\s]+/g, '~')
      // uuids (session/agent ids) -> <id>, EXCEPT the one in a published artifact's URL.
      //
      // The rule exists for session and agent ids; an artifact id lands in it only because it has
      // the same shape. Masked, the URL a publish reports (`https://claude.ai/code/artifact/<uuid>`)
      // becomes `…/artifact/<id>` — a link that goes nowhere and cannot even be copied by hand, so
      // the address of a page seedeep just watched being published was the one thing it could not
      // report. Davide's decision, taken with the exposure named: the id then shows in a live demo
      // or a screen-share of a REAL session (the page itself stays private and needs a login), and
      // never in the repo — nothing anon() touches is ever committed. Public screenshots are
      // covered by their own rule: they are taken on a synthetic session, which has none.
      //
      // Needs lookbehind (ES2018): every runtime seedeep targets has it — Bun on the server, and
      // Chrome/Firefox/Safari 16.4+ for the bundle.
      .replace(/(?<!\/code\/artifact\/)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
      // strip control chars but keep \t \n \r (meaningful in tool output)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
      .slice(0, cap)
  );
}
