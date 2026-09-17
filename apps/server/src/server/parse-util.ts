import { anon } from '../core/text.ts';
import type { NormalizedEvent, Root } from '../core/types.ts';

export type ParseCtx = { sessionId: string; root: Root; seq: number; agentId?: string | null };

export function parseJson(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const d = JSON.parse(trimmed);
    return d && typeof d === 'object' ? (d as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function isoTs(v: unknown): string {
  if (typeof v === 'string' && v.length > 0) return v;
  if (typeof v === 'number' && Number.isFinite(v)) {
    const ms = v > 1e12 ? v : v * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString();
  }
  return '';
}

export function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export function eventBase(ctx: ParseCtx, timestamp: string) {
  return {
    sessionId: ctx.sessionId,
    root: ctx.root,
    timestamp,
    seq: ctx.seq,
    agentId: ctx.agentId ?? null,
  };
}

/** Flatten a content field that may be a string, `{text}`, or an array of those. */
export function textContent(v: unknown): string {
  if (typeof v === 'string') return v;
  if (!v) return '';
  if (Array.isArray(v)) return v.map(textContent).filter(Boolean).join('\n');
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.text === 'string') return o.text;
    if (typeof o.content === 'string') return o.content;
    if (o.content !== undefined) return textContent(o.content);
    if (Array.isArray(o.parts)) return textContent(o.parts);
  }
  return '';
}

const ARG_KEYS = [
  'command',
  'cmd',
  'target_file',
  'path',
  'file_path',
  'query',
  'pattern',
  'url',
  'prompt',
  'description',
];

export function argPreview(input: unknown): string | undefined {
  if (typeof input === 'string' && input.trim()) return anon(input, 200);
  if (!input || typeof input !== 'object') return undefined;
  const o = input as Record<string, unknown>;
  for (const k of ARG_KEYS) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return anon(v, 200);
  }
  return undefined;
}

export type { NormalizedEvent };
