import { join } from 'node:path';

// ACTIVE_WINDOW_MS moved to types.ts, beside `isLive` and SessionRecord: the browser has to
// recompute `isActive` when it rebuilds a roster row from the split payloads, and this module
// reaches for node:path — importing it would drag the filesystem into the client bundle.

/**
 * Claude Code's own directory: `~/.claude`, or `CLAUDE_CONFIG_DIR` when it is set.
 *
 * ONE home for this fact, because seedeep reads two different things out of that directory — the
 * transcripts and the `commands/` folder — and answering the question twice is how the two came to
 * disagree: the command file was written where the variable said while the transcripts were looked
 * for under `~/.claude` regardless, so `/seedeep report` would have found no session at all.
 *
 * The variable is absent from the settings and env-var reference pages but present in the shipped
 * CLI, where it governs where a session is WRITTEN ("Use CLAUDE_CONFIG_DIR=/tmp for ephemeral local
 * writes", measured 2026-08-05 on the installed binary). An empty value is not a directory: `||`
 * rather than `??`, because exporting an empty string is a common way to mean "unset" and taking it
 * literally resolves every path against the current working directory instead.
 */
export function claudeDir(home: string, env: Record<string, string | undefined> = process.env): string {
  return env['CLAUDE_CONFIG_DIR'] || join(home, '.claude');
}

export function cliRoot(home: string, env?: Record<string, string | undefined>): string {
  return join(claudeDir(home, env), 'projects');
}

export function slugToProject(slug: string): string {
  const tail = slug.replace(/-+$/, '').split('-').pop();
  return tail && tail.length > 0 ? tail : slug;
}
