import { anon } from '../core/text.ts';
import type { NormalizedEvent, TokenCounts } from '../core/types.ts';
import { SPAWN_TOOL_NAMES } from '../core/types.ts';
import { argPreview, eventBase, isoTs, num, type ParseCtx, parseJson, textContent } from './parse-util.ts';

const SPAWN = 'spawn_subagent';

function grokDelta(u: Record<string, unknown>): { delta: TokenCounts; thinking: number; fill: number } {
  const inputTotal = num(u.inputTokens);
  const cacheRead = num(u.cachedReadTokens);
  const cacheCreation = num(u.cacheCreationTokens);
  return {
    delta: {
      input: Math.max(0, inputTotal - cacheRead),
      output: num(u.outputTokens),
      cacheRead,
      cacheCreation,
    },
    thinking: num(u.reasoningTokens),
    fill: inputTotal + cacheCreation,
  };
}

function toolName(u: Record<string, unknown>): string {
  const meta = u._meta;
  if (meta && typeof meta === 'object') {
    const tool = (meta as Record<string, unknown>)['x.ai/tool'];
    if (tool && typeof tool === 'object') {
      const name = (tool as Record<string, unknown>).name;
      if (typeof name === 'string' && name) return name;
    }
  }
  return typeof u.title === 'string' && u.title ? u.title : 'tool';
}

function parseUpdate(u: Record<string, unknown>, ctx: ParseCtx, timestamp: string): NormalizedEvent[] {
  const base = eventBase(ctx, timestamp);
  const kind = u.sessionUpdate;
  if (kind === 'user_message_chunk') {
    const prompt = anon(textContent(u.content), 2000);
    if (!prompt) return [];
    return [{ type: 'user-turn', ...base, prompt, command: null }];
  }
  if (kind === 'agent_message_chunk') {
    const text = anon(textContent(u.content), 2000);
    if (!text) return [];
    return [{ type: 'turn-narration', ...base, text, callId: null }];
  }
  if (kind === 'tool_call') {
    const id = typeof u.toolCallId === 'string' ? u.toolCallId : '';
    if (!id) return [];
    const name = toolName(u);
    const ev: NormalizedEvent = { type: 'tool-start', ...base, id, name };
    const arg = argPreview(u.rawInput);
    if (arg) ev.arg = arg;
    if (SPAWN_TOOL_NAMES.has(name) || name === SPAWN) {
      const input = u.rawInput && typeof u.rawInput === 'object' ? (u.rawInput as Record<string, unknown>) : {};
      if (typeof input.prompt === 'string') ev.launchPrompt = anon(input.prompt, 8000);
      if (typeof input.description === 'string') ev.description = anon(input.description, 200);
      if (typeof input.subagent_type === 'string') ev.subagentType = input.subagent_type;
      else ev.subagentType = name;
    }
    return [ev];
  }
  if (kind === 'tool_call_update') {
    const status = u.status;
    if (status !== 'completed' && status !== 'failed' && status !== 'error') return [];
    const id = typeof u.toolCallId === 'string' ? u.toolCallId : '';
    if (!id) return [];
    const name = toolName(u);
    const out = typeof u.rawOutput === 'string' ? u.rawOutput : textContent(u.content);
    const ev: NormalizedEvent = { type: 'tool-end', ...base, toolUseId: id, outputSize: out.length };
    if (out) ev.outputPreview = anon(out, 300);
    if (status === 'failed' || status === 'error') ev.error = true;
    if (SPAWN_TOOL_NAMES.has(name) || name === SPAWN) ev.launched = { agentId: null };
    return [ev];
  }
  if (kind === 'turn_completed') {
    const usage = u.usage && typeof u.usage === 'object' ? (u.usage as Record<string, unknown>) : {};
    const { delta, thinking, fill } = grokDelta(usage);
    const modelUsage = usage.modelUsage;
    let model: string | null = null;
    if (modelUsage && typeof modelUsage === 'object') {
      const first = Object.keys(modelUsage as Record<string, unknown>)[0];
      if (first) model = first;
    }
    const callId = typeof u.prompt_id === 'string' ? u.prompt_id : `grok-turn-${ctx.seq}`;
    const out: NormalizedEvent[] = [
      {
        type: 'usage',
        ...base,
        delta,
        thinking,
        fill,
        callId,
        model,
      },
    ];
    const durationMs = num(u.elapsed_ms) || num(usage.apiDurationMs);
    out.push({ type: 'turn-end', ...base, durationMs: durationMs || null, messageCount: null });
    return out;
  }
  return [];
}

function parseEvent(d: Record<string, unknown>, ctx: ParseCtx): NormalizedEvent[] {
  const timestamp = isoTs(d.ts);
  const base = eventBase(ctx, timestamp);
  const type = d.type;
  if (type === 'tool_completed') {
    const id = typeof d.tool_call_id === 'string' ? d.tool_call_id : '';
    if (!id) return [];
    const name = typeof d.tool_name === 'string' ? d.tool_name : 'tool';
    const ev: NormalizedEvent = { type: 'tool-end', ...base, toolUseId: id };
    if (d.outcome === 'error' || d.outcome === 'failed') ev.error = true;
    if (name === SPAWN || SPAWN_TOOL_NAMES.has(name)) ev.launched = { agentId: null };
    return [ev];
  }
  return [];
}

/** One Grok `updates.jsonl` or `events.jsonl` line → normalized events. Never throws. */
export function parseGrokLine(line: string, ctx: ParseCtx): NormalizedEvent[] {
  const d = parseJson(line);
  if (!d) return [];
  const method = d.method;
  if (typeof method === 'string' && method.endsWith('session/update')) {
    const params = d.params && typeof d.params === 'object' ? (d.params as Record<string, unknown>) : {};
    const update = params.update && typeof params.update === 'object' ? (params.update as Record<string, unknown>) : {};
    return parseUpdate(update, ctx, isoTs(d.timestamp));
  }
  if (typeof d.type === 'string') return parseEvent(d, ctx);
  return [];
}

/** Whole `usage.json` (pretty-printed, not jsonl). Used when updates.jsonl has no turn_completed. */
export function parseGrokUsageFile(raw: string, ctx: ParseCtx): NormalizedEvent[] {
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return [];
  }
  const session = d.session && typeof d.session === 'object' ? (d.session as Record<string, unknown>) : d;
  const turns = Array.isArray(d.turns) ? d.turns : [session];
  const out: NormalizedEvent[] = [];
  turns.forEach((t, i) => {
    if (!t || typeof t !== 'object') return;
    const rec = t as Record<string, unknown>;
    const { delta, thinking, fill } = grokDelta(rec);
    if (fill === 0 && delta.output === 0) return;
    const model =
      typeof rec.primaryModelId === 'string'
        ? rec.primaryModelId
        : typeof session.primaryModelId === 'string'
          ? session.primaryModelId
          : null;
    const n = num(rec.turnNumber) || i + 1;
    out.push({
      type: 'usage',
      ...eventBase(ctx, isoTs(rec.endedAt) || isoTs(d.updatedAt)),
      delta,
      thinking,
      fill,
      callId: `grok-usage-turn-${n}`,
      model,
    });
  });
  return out;
}
