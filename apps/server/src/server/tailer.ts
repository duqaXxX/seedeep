import type { Stats } from 'node:fs';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';

/**
 * Yield every non-blank line from `path`, reading lazily line by line without loading
 * the whole file into memory. Intended for the replay path (always a full read from
 * offset 0). Unlike `readNewLines`, carries no incremental tail state.
 * Never throws — a missing or unreadable file yields nothing.
 */
export async function* readLinesLazy(path: string): AsyncGenerator<string> {
  try {
    const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if (line.length > 0) yield line;
      }
    } finally {
      rl.close();
    }
  } catch {
    // missing or unreadable file — yield nothing
  }
}

export interface TailState {
  offset: number;
  size: number;
  mtimeMs: number;
  carry: string;
}

export function initTailState(): TailState {
  return { offset: 0, size: 0, mtimeMs: 0, carry: '' };
}

/**
 * Read the bytes appended to `path` since the last call, split into complete
 * lines. Stateless across processes: pass the returned `state` back on the next
 * call to resume from where this one stopped. A partial trailing line is held in
 * `state.carry` and prepended next time, so a line split across two reads is
 * never emitted twice or dropped. Detects truncation/rewrite (file shrank) and
 * restarts from offset 0, reporting it as `restarted: true` for exactly that call —
 * a caller numbering the lines by position must reset that number in the same step,
 * or its numbering stops being a position. Never throws — a missing file yields
 * `{ lines: [], restarted: false }`.
 */
export async function readNewLines(
  path: string,
  state: TailState,
): Promise<{ lines: string[]; state: TailState; restarted: boolean }> {
  let st: Stats;
  try {
    st = await stat(path);
  } catch {
    return { lines: [], state, restarted: false };
  }

  // Truncated/rewritten: start over.
  let offset = state.offset;
  let carry = state.carry;
  const restarted = st.size < offset;
  if (restarted) {
    offset = 0;
    carry = '';
  }

  // Nothing new. Carries the RESTARTED offset, not the stale one: a file emptied to
  // zero bytes takes this branch, and leaving the old offset in the state would keep
  // re-reporting the restart on every later tick.
  if (st.size === offset) {
    return { lines: [], state: { offset, size: st.size, mtimeMs: st.mtimeMs, carry }, restarted };
  }

  const length = st.size - offset;
  const buf = Buffer.alloc(length);
  const fh = await open(path, 'r');
  try {
    await fh.read(buf, 0, length, offset);
  } finally {
    await fh.close();
  }

  const text = carry + buf.toString('utf8');
  const parts = text.split('\n');
  const nextCarry = parts.pop() ?? ''; // trailing partial (or '' if ended in \n)
  const lines = parts.filter((l) => l.length > 0);

  return {
    lines,
    state: { offset: st.size, size: st.size, mtimeMs: st.mtimeMs, carry: nextCarry },
    restarted,
  };
}
