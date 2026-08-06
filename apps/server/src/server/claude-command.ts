/**
 * The entry point the `/seedeep` slash command uses: `seedeep claude-code <sessionId> [word…]`.
 *
 * A command file under `~/.claude/commands/` is a TEMPLATE — it cannot branch. So its shell line
 * is fixed (`` !`seedeep claude-code ${CLAUDE_SESSION_ID} $ARGUMENTS` ``) and the branching lives
 * here, where it is testable and where an unknown word produces seedeep's own error rather than a
 * shell's.
 *
 * `${CLAUDE_SESSION_ID}` is Claude Code's documented substitution for the current session, which
 * is what makes `report` possible at all: nothing else on the machine knows which session the
 * person typing is IN.
 */

/** Claude Code's session ids are UUIDs — checked as a shape, never as a list. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the words after the session id asked for. */
export type ClaudePlan =
  | { kind: 'open' }
  | { kind: 'report'; sessionId: string; full: boolean }
  | { kind: 'restart' }
  | { kind: 'stop' }
  | { kind: 'start' }
  | { kind: 'status' }
  | { kind: 'update' }
  | { kind: 'error'; message: string };

/**
 * Read `<sessionId> [word…]` into a plan. Bare `/seedeep` (no word) opens — the most frequent of
 * the three, and what the command did before it took arguments.
 */
export function planClaudeCommand(rest: string[]): ClaudePlan {
  const [sessionId, word, ...tail] = rest;
  // Shape-checked, not merely non-empty. If `${CLAUDE_SESSION_ID}` were ever left unsubstituted —
  // an older Claude Code, the file reused somewhere else — the shell expands it to nothing, and
  // `/seedeep report` would arrive here as `['report']`: a session id of "report", no word, and the
  // no-word branch OPENS THE GUI. A silent wrong action becomes a sentence the user can act on.
  if (!sessionId || !UUID.test(sessionId)) {
    return {
      kind: 'error',
      message: `seedeep: "${sessionId ?? ''}" is not a session id — /seedeep passes it as \${CLAUDE_SESSION_ID}, which this Claude Code did not substitute.`,
    };
  }
  switch (word) {
    case undefined:
    case 'open':
      return { kind: 'open' };
    case 'restart':
      return { kind: 'restart' };
    case 'stop':
      return { kind: 'stop' };
    case 'start':
      return { kind: 'start' };
    case 'status':
      return { kind: 'status' };
    case 'update':
      return { kind: 'update' };
    case 'report':
      if (tail.length && tail[0] !== 'full') {
        return { kind: 'error', message: `seedeep: report takes "full" or nothing, not "${tail[0]}"` };
      }
      return { kind: 'report', sessionId, full: tail[0] === 'full' };
    default:
      return {
        kind: 'error',
        message: `seedeep: "${word}" is not a /seedeep command — try open, start, stop, restart, report or update`,
      };
  }
}
