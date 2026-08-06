import { readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { anon, renderedText } from '../core/text.ts';
import { initTailState, readNewLines } from './tailer.ts';

// What a tool actually returned is read back from the session's own jsonl, ON DEMAND, and
// never kept in the browser: the parser already measures every tool_result (`outputSize`),
// but holding each one verbatim would mean carrying a whole session's tool output — every
// Read, every Bash — in the client's memory. The file is the source of truth and we already
// read it; a click can afford to go back to it.

/** The verbatim text a tool returned, bounded and anonymized, plus its TRUE length. */
export interface ToolOutput {
  toolUseId: string;
  /** Anonymized text, at most `cap` chars (see {@link readToolOutput}). */
  text: string;
  /** Length of the output as it really was, BEFORE the cap — what the UI reports. */
  len: number;
  truncated: boolean;
}

// Same bound as a subagent's returned text: enough to read, small enough to send.
const CAP = 20000;

/**
 * Read back what one tool returned, from the session's own files: the main `.jsonl` first,
 * then each `subagents/agent-*.jsonl` child (a subagent's tools report in its own file).
 * Returns null when no `tool_result` with that id exists (unknown id, or a tool still
 * running — it has not reported yet). Read-only; the text is anonymized before it leaves.
 *
 * LIMIT: a linear scan of the session's lines per call — there is no index from
 * tool_use_id to line. A click pays it once (tens of ms on a large session); if that ever
 * stops being true, the seq of the tool-end event is the handle to seek with.
 */
export async function readToolOutput(path: string, toolUseId: string, cap: number = CAP): Promise<ToolOutput | null> {
  const { lines } = await readNewLines(path, initTailState());
  const own = findInLines(lines, toolUseId, cap);
  if (own) return own;

  // Children live under a sibling dir named after the session uuid, NOT next to the parent
  // jsonl: `<slug>/<uuid>.jsonl` + `<slug>/<uuid>/subagents/` (same layout streamReplay walks).
  const subDir = join(dirname(path), basename(path, '.jsonl'), 'subagents');
  let children: string[] = [];
  try {
    children = await readdir(subDir);
  } catch {
    return null;
  }
  for (const c of children) {
    if (!/^agent-.+\.jsonl$/.test(c)) continue;
    const { lines: childLines } = await readNewLines(join(subDir, c), initTailState());
    const hit = findInLines(childLines, toolUseId, cap);
    if (hit) return hit;
  }
  return null;
}

function findInLines(lines: string[], toolUseId: string, cap: number): ToolOutput | null {
  for (const line of lines) {
    // Substring test before JSON.parse: only two lines in a session mention a given
    // tool_use_id (the call and its result), so scanning for the id is far cheaper than
    // parsing every line to look inside it.
    if (!line.includes(toolUseId)) continue;
    // A malformed line is not an error here — the parser tolerates it too, and one bad line
    // must not deny the output of a tool recorded further down.
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d?.type !== 'user') continue;
    const content = d.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== 'tool_result' || block.tool_use_id !== toolUseId) continue;
      const raw = renderedText(block.content);
      return { toolUseId, text: anon(raw, cap), len: raw.length, truncated: raw.length > cap };
    }
  }
  return null;
}
