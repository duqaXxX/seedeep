import { anon } from '../core/text.ts';
import type { NormalizedEvent, TokenCounts } from '../core/types.ts';
import { SPAWN_TOOL_NAMES } from '../core/types.ts';
import { argPreview, eventBase, isoTs, num, type ParseCtx, parseJson, textContent } from './parse-util.ts';

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function codexDelta(u: Record<string, unknown>): { delta: TokenCounts; thinking: number; fill: number } {
  const inputTotal = num(u.input_tokens);
  const cacheRead = num(u.cached_input_tokens);
  const cacheCreation = num(u.cache_write_input_tokens);
  return {
    delta: {
      input: Math.max(0, inputTotal - cacheRead),
      output: num(u.output_tokens),
      cacheRead,
      cacheCreation,
    },
    thinking: num(u.reasoning_output_tokens),
    fill: inputTotal + cacheCreation,
  };
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const d = JSON.parse(raw);
      return d && typeof d === 'object' ? (d as Record<string, unknown>) : { value: raw };
    } catch {
      return { value: raw };
    }
  }
  return {};
}

/** One Codex `rollout-*.jsonl` line → normalized events. Never throws. */
export function parseCodexLine(line: string, ctx: ParseCtx): NormalizedEvent[] {
  const d = parseJson(line);
  if (!d) return [];
  const timestamp = isoTs(d.timestamp);
  const base = eventBase(ctx, timestamp);
  const payload = asObj(d.payload);
  const outer = d.type;

  if (outer === 'token_usage_record') {
    const usage = asObj(payload.usage);
    const { delta, thinking, fill } = codexDelta(usage);
    const callId = typeof payload.response_id === 'string' ? payload.response_id : `codex-${ctx.seq}`;
    return [{ type: 'usage', ...base, delta, thinking, fill, callId, model: null }];
  }

  if (outer === 'event_msg') {
    const pt = payload.type;
    if (pt === 'token_count') {
      // Prefer token_usage_record when both exist; this is a coarser duplicate.
      return [];
    }
    if (pt === 'item_completed') {
      const item = asObj(payload.item);
      if (item.type === 'UserMessage') {
        const prompt = anon(textContent(item.content), 2000);
        if (!prompt) return [];
        return [{ type: 'user-turn', ...base, prompt, command: null }];
      }
    }
    if (pt === 'task_complete') {
      const out: NormalizedEvent[] = [
        { type: 'turn-end', ...base, durationMs: num(payload.duration_ms) || null, messageCount: null },
      ];
      const text = typeof payload.last_agent_message === 'string' ? payload.last_agent_message : '';
      if (text)
        out.push({ type: 'turn-result', ...base, outputFull: anon(text, 20000), outLen: Math.min(text.length, 20000) });
      return out;
    }
    return [];
  }

  if (outer === 'response_item') {
    const pt = payload.type;
    if (pt === 'function_call' || pt === 'custom_tool_call') {
      const id =
        typeof payload.call_id === 'string' ? payload.call_id : typeof payload.id === 'string' ? payload.id : '';
      if (!id) return [];
      const name = typeof payload.name === 'string' ? payload.name : 'tool';
      const ev: NormalizedEvent = { type: 'tool-start', ...base, id, name };
      const input = pt === 'custom_tool_call' ? payload.input : parseArgs(payload.arguments);
      const arg = argPreview(input) ?? (typeof payload.input === 'string' ? anon(payload.input, 200) : undefined);
      if (arg) ev.arg = arg;
      if (SPAWN_TOOL_NAMES.has(name) || name === 'spawn_agent') {
        const obj =
          typeof input === 'object' && input ? (input as Record<string, unknown>) : parseArgs(payload.arguments);
        if (typeof obj.message === 'string') ev.launchPrompt = anon(obj.message, 8000);
        if (typeof obj.task_name === 'string') ev.description = anon(obj.task_name, 200);
        ev.subagentType = typeof obj.task_name === 'string' ? obj.task_name : name;
      }
      return [ev];
    }
    if (pt === 'function_call_output' || pt === 'custom_tool_call_output') {
      const id = typeof payload.call_id === 'string' ? payload.call_id : '';
      if (!id) return [];
      const out = typeof payload.output === 'string' ? payload.output : textContent(payload.output);
      const ev: NormalizedEvent = { type: 'tool-end', ...base, toolUseId: id, outputSize: out.length };
      if (out) ev.outputPreview = anon(out, 300);
      const parsed = parseArgs(payload.output);
      if (typeof parsed.task_name === 'string') ev.launched = { agentId: parsed.task_name };
      return [ev];
    }
    if (pt === 'agent_message') {
      const text = anon(textContent(payload.content), 2000);
      if (!text) return [];
      const agentId = typeof payload.author === 'string' ? payload.author : (base.agentId ?? null);
      return [{ type: 'subagent-output', ...base, agentId, outputFull: text, outLen: text.length }];
    }
    return [];
  }

  if (outer === 'compacted') {
    return [{ type: 'compaction', ...base, isSummary: true, preTokens: null, postTokens: null, durationMs: null }];
  }

  return [];
}
