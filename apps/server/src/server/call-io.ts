import { readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { anon, renderedText } from '../core/text.ts';
import type { TokenCounts } from '../core/types.ts';
import { initTailState, readNewLines } from './tailer.ts';

// The full input and output of ONE API call, read back from the session's own jsonl ON DEMAND,
// and never kept in the browser (the reducer holds only the call's token totals + a short input
// hint). An API call is a message.id: it spans one line per content block, all repeating the
// same usage — the OUTPUT is those blocks' text/thinking/tool_use joined, the INPUT is the user
// content immediately before the call's first line (the prompt, or the tool_results fed back).
// The point is to see, per call, exactly what Claude Code sent and got.

/** One bounded, anonymized side of a call (input or output), plus its TRUE pre-cap length. */
export interface CallSide {
  text: string;
  len: number;
  truncated: boolean;
}

export interface CallIO {
  callId: string;
  model: string | null;
  usage: TokenCounts | null;
  input: CallSide;
  output: CallSide;
  /** True when the output contains a tool_use — the viewer renders it verbatim (code) not markdown. */
  outputHasTools: boolean;
  /**
   * The call's INTENT: its mid-turn text, i.e. the model saying what it is about to do. It is
   * already inside `output`, but there it is the first line of a verbatim dump that the
   * tool_use blocks force into plain rendering — the one thing in the drawer that is prose gets
   * read as code, and a long output can bury it. Split out so it can be shown as what it is.
   * Null when the call closed the turn (`stop_reason: 'end_turn'`): that text is the ANSWER,
   * which the turn's own final-answer drawer already owns.
   */
  narration: string | null;
  /**
   * Reasoning effort this call ran at, verbatim from the assistant line's root `effort`.
   * Null when the line does not carry it, which is NOT "no effort": Claude Code only began
   * writing the field in 2.1.212 (measured: 0 of 26,874 assistant lines before it), and
   * models without configurable effort — haiku — never write it. The viewer therefore omits
   * the row rather than showing a dash that would claim more than is known.
   */
  effort: string | null;
}

const CAP = 20000;

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
function side(raw: string, cap: number): CallSide {
  return { text: anon(raw, cap), len: raw.length, truncated: raw.length > cap };
}

// A user line's rendered text — the call's input delta. A prompt is a plain string; a
// tool_result batch is an array whose text lives under each block's `content` (NOT `.text`),
// so `renderedText` alone (it reads `.text`) would miss it — dig into tool_result.content here.
function userText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content as any[]) {
    if (b?.type === 'tool_result') parts.push(renderedText(b.content));
    else if (typeof b?.text === 'string') parts.push(b.text);
  }
  return parts.join('\n');
}

/**
 * Read one API call's input + output from the session's files: the main `.jsonl` first, then
 * each `subagents/agent-*.jsonl` child (a subagent's calls report in its own file). Returns
 * null when no assistant line carries that message.id. Read-only; both sides are anonymized
 * before they leave.
 *
 * LIMIT: the input is the inline rendered text of the preceding user line. When that line's
 * tool_result was spilled to a `tool-results/*.txt` reference (large outputs), only the
 * reference is inline, so the input reads sparse — the tool's own drawer still has the text.
 */
export async function readCallIO(path: string, callId: string, cap: number = CAP): Promise<CallIO | null> {
  const { lines } = await readNewLines(path, initTailState());
  const own = scanForCall(lines, callId, cap);
  if (own) return own;

  // Children live under a sibling dir named after the session uuid (same layout as tool-output).
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
    const hit = scanForCall(childLines, callId, cap);
    if (hit) return hit;
  }
  return null;
}

function scanForCall(lines: string[], callId: string, cap: number): CallIO | null {
  // Locate the call's own lines by a cheap substring pre-filter (no parse of the whole file, as
  // tool-output does with its toolUseId): only lines mentioning the id are parsed.
  const own: any[] = [];
  let firstIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.includes(callId)) continue;
    let d: any;
    try {
      d = JSON.parse(lines[i]!);
    } catch {
      continue;
    }
    if (d?.type === 'assistant' && d.message?.id === callId) {
      if (firstIdx < 0) firstIdx = i;
      own.push(d);
    }
  }
  if (!own.length) return null;

  // Output + model + usage from the call's own lines (one line per content block).
  const first = own[0];
  const model = typeof first.message?.model === 'string' ? first.message.model : null;
  // Root-level on the assistant line, not inside `message` — verified across 977 files.
  const effort = typeof first.effort === 'string' && first.effort.length > 0 ? first.effort : null;
  let usage: TokenCounts | null = null;
  const u = first.message?.usage;
  if (u && typeof u === 'object') {
    usage = {
      input: num(u.input_tokens),
      output: num(u.output_tokens),
      cacheRead: num(u.cache_read_input_tokens),
      cacheCreation: num(u.cache_creation_input_tokens),
    };
  }
  const outParts: string[] = [];
  // The intent is collected per LINE, because the stop_reason that tells an intent from the
  // turn's answer lives on the line, not on the block.
  const intentParts: string[] = [];
  let outputHasTools = false;
  for (const d of own) {
    const content = d.message?.content;
    if (!Array.isArray(content)) continue;
    const isAnswer = d.message?.stop_reason === 'end_turn';
    for (const b of content) {
      if (b?.type === 'text' && typeof b.text === 'string') {
        outParts.push(b.text);
        if (!isAnswer && b.text.trim()) intentParts.push(b.text);
      } else if (b?.type === 'thinking' && typeof b.thinking === 'string') outParts.push(b.thinking);
      else if (b?.type === 'tool_use' && typeof b.name === 'string') {
        outputHasTools = true;
        // The tool_use block IS the model's output for a tool call — its INPUT (the args it
        // wrote) is the substance, so include it, not just the name. Empty input adds nothing.
        const args =
          b.input && typeof b.input === 'object' && Object.keys(b.input).length ? ' ' + JSON.stringify(b.input) : '';
        outParts.push('→ ' + b.name + args);
      }
    }
  }

  // Input = the nearest preceding user line that is NOT Claude-injected (isMeta skill bodies are
  // not the trigger). Walk back from the call's first line, parsing only user lines.
  let input = '';
  for (let i = firstIdx - 1; i >= 0; i--) {
    if (!lines[i]!.includes('"type":"user"')) continue;
    let d: any;
    try {
      d = JSON.parse(lines[i]!);
    } catch {
      continue;
    }
    if (d?.type !== 'user' || d.isMeta) continue;
    input = userText(d.message?.content);
    break;
  }

  return {
    callId,
    model,
    effort,
    usage,
    input: side(input, cap),
    output: side(outParts.join('\n'), cap),
    outputHasTools,
    // Anonymized like every other side that leaves the process; capped at the same 2,000 chars
    // the parser gives a narration, since it is the same text.
    narration: intentParts.length ? anon(intentParts.join('\n'), 2000) : null,
  };
}
