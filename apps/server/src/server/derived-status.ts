import { open } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';

/**
 * What the transcript alone can say about a session's state.
 *
 * `waiting` reaches only ONE of the two ways a session stops on a human. An unanswered
 * `AskUserQuestion` is definitionally a question to the person — measured 2026-08-18 on a real
 * desktop session held at a dialog: its `tool_use` sits in the transcript with no `tool_result`
 * for as long as the dialog is open, while the session file stays empty of `status`. A pending
 * tool APPROVAL cannot be reached the same way: a `Bash` waiting for a yes and a `Bash` that is
 * running are the same two lines, and guessing between them would put a badge on a session that
 * is merely slow.
 */
export interface DerivedState {
  status: 'busy' | 'idle' | 'waiting';
  /** Claude Code's own vocabulary, so every surface reads it as it reads a published one. */
  waitingFor: 'input needed' | null;
  /** When the question was asked (epoch ms) — the honest age, from the line's own timestamp. */
  waitingSince: number | null;
}

const BUSY: DerivedState = { status: 'busy', waitingFor: null, waitingSince: null };
const IDLE: DerivedState = { status: 'idle', waitingFor: null, waitingSince: null };

// One read covers the tail in the common case. A single line CAN be larger (a tool result is
// capped at 1 MB), and then this window holds no complete line and the answer is null — the same
// "no claim" a session without the mechanism gets, never a guess.
const TAIL_CHUNK = 65536;

// Keyed by path: the tail can only change when the file grows, so a size that has not moved
// answers from here instead of re-reading. The watcher re-discovers every ~300ms, and without
// this every tick re-read the tail of every open session that publishes no status.
const cache = new Map<string, { size: number; state: DerivedState | null }>();
const CACHE_MAX = 128; // bounded rather than swept: sessions come and go, and a stale entry costs a read

/**
 * What the transcript says the session is doing, for a host that publishes no status of its own.
 *
 * Reads the LAST decisive line rather than a clock: an mtime window cannot answer this, because a
 * session waiting on a subagent or inside a long thinking block writes nothing for minutes while
 * being very much at work — the same trap `isLive` documents.
 *
 * The rule comes from the shape of a call, measured over 15,070 calls in 250 local sessions
 * (2026-08-18): every line of a call repeats the call's own `stop_reason`, and the call's LAST
 * line is `tool_use` when it stopped for a tool (13,942 of them) and a `text` block when it
 * stopped for the user (1,128). So a `thinking` line already carrying `end_turn` is a call whose
 * final text is still streaming — work, not silence.
 *
 * Returns null when the tail says nothing either way, which every surface reads as "no claim".
 * `size` is the caller's stat, so the cache can tell a grown file from an untouched one.
 */
export async function deriveStatus(path: string, size: number): Promise<DerivedState | null> {
  const hit = cache.get(path);
  if (hit && hit.size === size) return hit.state;
  const state = await readTailStatus(path, size);
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(path, { size, state });
  return state;
}

async function readTailStatus(path: string, size: number): Promise<DerivedState | null> {
  if (size <= 0) return null;
  const want = Math.min(size, TAIL_CHUNK);
  let text: string;
  try {
    const fh = await open(path, 'r');
    try {
      const buf = Buffer.allocUnsafe(want);
      const { bytesRead } = await fh.read(buf, 0, want, size - want);
      // The window starts mid-line, and may start mid-codepoint with it; the decoder holds the
      // broken head back and the first (partial) line is dropped below either way.
      text = new StringDecoder('utf8').write(buf.subarray(0, bytesRead));
    } finally {
      await fh.close();
    }
  } catch {
    return null; // unreadable: the same "no claim" as a session with no mechanism at all
  }
  const lines = text.split('\n');
  // Drop the head only when the window really is a slice: a file read whole starts at a boundary.
  if (want < size) lines.shift();
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue; // a truncated tail line, or one this reader has no business understanding
    }
    // A subagent's line says what the CHILD is doing. Children write their own files, but the
    // flag exists on the parent's lines too and a wrong reading here would be invisible.
    if (d?.isSidechain) continue;
    if (d?.type === 'assistant') {
      const m = d.message ?? {};
      const reason = m.stop_reason;
      const blocks = Array.isArray(m.content) ? m.content : [];
      const last = blocks.length > 0 ? blocks[blocks.length - 1] : null;
      if (reason === 'tool_use') {
        // Nothing follows this line, so the call it asked for has no result yet. For every tool
        // that means work in progress — except the one whose whole purpose is to stop and ask.
        if (last?.type === 'tool_use' && last?.name === 'AskUserQuestion') {
          const asked = Date.parse(d.timestamp ?? '');
          return { status: 'waiting', waitingFor: 'input needed', waitingSince: Number.isNaN(asked) ? null : asked };
        }
        // LIMIT: a tool awaiting APPROVAL is indistinguishable from one that is running — the
        // same `tool_use` line, no result either way — so a session stopped at a permission prompt
        // reads as working here. Claude Code publishes that state itself (`status: "waiting"` +
        // `waitingFor: "permission prompt"`); only a host that publishes nothing reaches this
        // branch, and guessing from elapsed time would badge a session that is merely slow.
        return BUSY;
      }
      // Esc: the round is over and nothing more is coming until the user speaks again.
      if (reason === null || reason === undefined) return IDLE;
      return last?.type === 'text' ? IDLE : BUSY;
    }
    if (d?.type === 'user') {
      // A prompt or a tool result — an answered question included: either way the model owes a
      // reply. The exception is the row an Esc writes, which carries the id of what it stopped.
      return d.interruptedMessageId ? IDLE : BUSY;
    }
    // Everything else says nothing about who is working: the desktop app alone writes
    // `attachment`, `queue-operation`, `last-prompt`, `custom-title` and `mode` lines around a
    // turn, and a `system` line can land on either side of one.
  }
  return null;
}
