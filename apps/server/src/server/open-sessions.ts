import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { claudeDir } from './roots.ts';

export interface OpenSession {
  pid: number;
  sessionId: string;
  cwd: string;
  /**
   * Claude Code's own word for what the session is doing. `shell` is the one that is not obvious:
   * CC writes it while a command it launched in the background is still running and the turn is
   * over — measured by sampling this file every 2 s across a 240-second background command, which
   * read `busy`, then `shell` for its whole run, then `busy` again when the notification landed.
   *
   * Kept RAW, and mapped to a band by each surface, for the same reason `waitingFor` is: which
   * state deserves which claim on screen is a product rule. Anything unrecognised stays `null`,
   * which every surface reads as "no claim to make".
   */
  status: 'busy' | 'idle' | 'waiting' | 'shell' | null;
  // What the session is blocked on, verbatim from Claude Code, and only while it IS
  // blocked: 'permission prompt' (a tool/plan approval), 'input needed' (AskUserQuestion
  // or an MCP elicitation), 'dialog open', 'sandbox request', 'worker request'. Kept raw —
  // which of these deserves the user's attention is a product rule, decided in the client.
  waitingFor: string | null;
  /** When it started waiting (Claude Code's `statusUpdatedAt`, epoch ms); null otherwise. */
  waitingSince: number | null;
  /**
   * The file carried a `status` field at all — which is NOT the same fact as `status !== null`:
   * an unrecognised value also reduces to null, and the two must not be confused. A session that
   * publishes one owns its state even when seedeep does not know the word; a session that
   * publishes none is the only one whose state may be derived from its transcript.
   *
   * Only the interactive terminal REPL publishes it. A host driving Claude Code over stream-json
   * — the desktop app's Code tab, `claude -p`, the Agent SDK — registers a file here with no
   * status, which is why this is a property of the SESSION and not of the mechanism.
   */
  publishesStatus: boolean;
}

/** Every status seedeep recognises. A value outside this list becomes `null` rather than a guess:
 * Claude Code owns this vocabulary and has already grown it once. */
const STATUSES = ['busy', 'idle', 'waiting', 'shell'] as const;

/**
 * Say it, ONCE per value, when Claude Code writes a status seedeep does not know.
 *
 * This is the only guard that covers a VALUE. The schema radar watches field NAMES, in transcripts,
 * and these values live in the PID file — two blind spots that overlapped exactly once and cost a
 * release: `shell` was written for months, dropped to null, and a session running a background
 * command was filed under Idle until a user reported it.
 *
 * A log line and not a failure, deliberately: an unknown status is not a crash — the session simply
 * makes no claim — and a guard that stops the server over Claude Code's vocabulary would be worse
 * than the bug. A test-suite scan was considered and rejected instead of this: the file exists only
 * for sessions open at that instant, so the suite would see one session in whatever state it
 * happened to be, while THIS runs on the machine that watches sessions pass through every state
 * they have.
 */
const reportedStatuses = new Set<string>();
function noteUnknownStatus(value: unknown): void {
  if (typeof value !== 'string' || value === '' || reportedStatuses.has(value)) return;
  reportedStatuses.add(value);
  console.warn(
    `seedeep: Claude Code wrote an unknown session status ${JSON.stringify(value)} — seedeep reads it as "no claim", ` +
      `so this session may read as Idle. Add it to STATUSES in open-sessions.ts once you know what it means.`,
  );
}

/**
 * True if a process with `pid` currently exists. `process.kill(pid, 0)` sends no
 * signal; it throws ESRCH when the process is gone. EPERM means the process
 * exists but isn't ours — still alive for our purposes.
 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM';
  }
}

/**
 * Enumerate the currently OPEN Claude Code sessions from `~/.claude/sessions/*.json`
 * (one file per running process, deleted on exit). This is NOT TUI-only, as this comment
 * once claimed: measured 2026-07-17, a headless `claude -p` registers a file for the length
 * of its run too. Anything keying off "is open" must therefore filter by `entrypoint` if it
 * means interactive — a git hook's docs-gate run is, briefly, an open session. Keeps only
 * entries whose PID
 * is alive, so a file left by a crash is ignored. Never throws: a malformed file yields
 * fewer results, not an error. `isAlive` is injectable for tests.
 *
 * Returns **null when the mechanism itself is unavailable** (`~/.claude/sessions/` absent or
 * unreadable) — which is NOT the same fact as "nothing is open" (`[]`), and the difference
 * decides whether a caller may trust `isOpen` at all. `~/.claude/sessions/` is an UNDOCUMENTED
 * Claude Code internal, so callers must tolerate it vanishing in a future release and fall
 * back to the mtime window; collapsing the two into `[]` made that fallback unreachable.
 */
export async function listOpenSessions(
  opts: { home?: string; isAlive?: (pid: number) => boolean } = {},
): Promise<OpenSession[] | null> {
  const home = opts.home ?? homedir();
  const alive = opts.isAlive ?? isAlive;
  // claudeDir, not `home/.claude`: CLAUDE_CONFIG_DIR moves this directory with everything else.
  // Hardcoding it made seedeep read TRANSCRIPTS from the configured profile while asking the
  // DEFAULT one which sessions are open — so every session in a configured profile was reported
  // closed, `isLive` never fell back to the mtime window, and a session being written right then
  // rendered as ENDED. This is the second head of the bug roots.ts was created to kill.
  const dir = join(claudeDir(home), 'sessions');
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return null;
  }
  const out: OpenSession[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    let d: any;
    try {
      d = JSON.parse(await readFile(join(dir, f), 'utf8'));
    } catch {
      continue;
    }
    const pid = typeof d?.pid === 'number' ? d.pid : Number.parseInt(f, 10);
    const sessionId = typeof d?.sessionId === 'string' ? d.sessionId : '';
    const cwd = typeof d?.cwd === 'string' ? d.cwd : '';
    if (!Number.isFinite(pid) || !sessionId || !cwd || !alive(pid)) continue;
    const publishesStatus = typeof d?.status === 'string' && d.status !== '';
    const status = STATUSES.find((s) => s === d?.status) ?? null;
    if (status === null) noteUnknownStatus(d?.status);
    // Only meaningful while waiting: Claude Code clears it on the way out, but a file read
    // mid-rewrite (or a future release that stops clearing it) must not leave a session
    // flagged as blocked forever.
    const waitingFor = status === 'waiting' && typeof d?.waitingFor === 'string' ? d.waitingFor : null;
    const waitingSince = waitingFor !== null && typeof d?.statusUpdatedAt === 'number' ? d.statusUpdatedAt : null;
    out.push({ pid, sessionId, cwd, status, waitingFor, waitingSince, publishesStatus });
  }
  return out;
}
