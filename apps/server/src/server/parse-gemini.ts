import { anon } from '../core/text.ts';
import type { NormalizedEvent } from '../core/types.ts';
import { argPreview, eventBase, isoTs, num, type ParseCtx, parseJson, textContent } from './parse-util.ts';

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

/** Gemini CLI or Antigravity transcript jsonl line → normalized events. Never throws. */
export function parseGeminiLine(line: string, ctx: ParseCtx): NormalizedEvent[] {
  const d = parseJson(line);
  if (!d) return [];
  if ('$set' in d || d.kind === 'main') return [];
  const timestamp = isoTs(d.timestamp) || isoTs(d.startTime);
  const base = eventBase(ctx, timestamp);
  const type = d.type;

  if (type === 'user') {
    const prompt = anon(textContent(d.content), 2000);
    if (!prompt) return [];
    return [{ type: 'user-turn', ...base, prompt, command: null }];
  }

  if (type === 'gemini' || type === 'model' || type === 'assistant') {
    const out: NormalizedEvent[] = [];
    const tokens = asObj(d.tokens);
    const model = typeof d.model === 'string' ? d.model : null;
    if (Object.keys(tokens).length > 0) {
      const input = num(tokens.input);
      const cacheRead = num(tokens.cached);
      out.push({
        type: 'usage',
        ...base,
        delta: {
          input,
          output: num(tokens.output),
          cacheRead,
          cacheCreation: 0,
        },
        thinking: tokens.thoughts !== undefined ? num(tokens.thoughts) : null,
        fill: input + cacheRead,
        callId: typeof d.id === 'string' ? d.id : `gemini-${ctx.seq}`,
        model,
      });
    }
    const tools = Array.isArray(d.toolCalls) ? d.toolCalls : Array.isArray(d.tool_calls) ? d.tool_calls : [];
    for (const raw of tools) {
      const t = asObj(raw);
      const id = typeof t.id === 'string' ? t.id : `${ctx.seq}-${typeof t.name === 'string' ? t.name : 'tool'}`;
      const name = typeof t.name === 'string' ? t.name : typeof t.displayName === 'string' ? t.displayName : 'tool';
      const start: NormalizedEvent = { type: 'tool-start', ...base, id, name };
      const arg = argPreview(t.args) ?? argPreview(t.arguments);
      if (arg) start.arg = arg;
      out.push(start);
      const result = t.result ?? t.resultDisplay;
      const resultText = typeof result === 'string' ? result : textContent(result);
      const end: NormalizedEvent = { type: 'tool-end', ...base, toolUseId: id, outputSize: resultText.length };
      if (resultText) end.outputPreview = anon(resultText, 300);
      if (t.status === 'error' || t.status === 'failed') end.error = true;
      out.push(end);
    }
    const text = anon(textContent(d.content), 20000);
    if (text) out.push({ type: 'turn-result', ...base, outputFull: text, outLen: text.length });
    return out;
  }

  return [];
}
