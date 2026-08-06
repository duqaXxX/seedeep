import assert from 'node:assert/strict';
import { test } from 'node:test';
import { windowFor } from '../src/core/context-windows.ts';
import { createSessionTree } from '../src/core/session-tree.ts';
import type { NormalizedEvent } from '../src/core/types.ts';
import { parseLine } from '../src/server/parser.ts';

// Opening a tab replays the session's whole jsonl through the reducer, with the view
// already subscribed (it mounts first). The reducer used to build a FULL snapshot on every one
// of those events — snapshot() is O(turns + tools + agents), so folding a session became
// O(n²): a real 11k-line session (23k events, 144 turns, 160 subagents) took 14.4 SECONDS
// here, which is the freeze the user saw on every refresh. The listener threw every one of
// those snapshots away: it coalesces its paints and pulls the state itself.
//
// The budget below is ~100× the post-fix cost (a few ms), so it cannot flake on a slow box —
// but any return of per-event snapshot building blows straight through it.
const BUDGET_MS = 500;

const ctx = { sessionId: 's1', root: 'cli' as const, agentId: null };

// Line shapes copied from real sessions (see golden-transcript.test.ts); content synthetic.
const typed = (uuid: string, text: string) =>
  JSON.stringify({
    type: 'user',
    uuid,
    timestamp: '2026-07-14T10:00:00.000Z',
    origin: { kind: 'human' },
    promptSource: 'typed',
    message: { role: 'user', content: text },
  });
const toolUse = (uuid: string, id: string, name: string) =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: '2026-07-14T10:00:02.000Z',
    message: {
      role: 'assistant',
      model: 'claude-opus-4-8',
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id, name, input: { file_path: '/home/dev/project/src/x.ts' } }],
      usage: { input_tokens: 10, output_tokens: 80, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 0 },
    },
  });
const toolResult = (uuid: string, id: string) =>
  JSON.stringify({
    type: 'user',
    uuid,
    timestamp: '2026-07-14T10:00:03.000Z',
    origin: { kind: 'tool_use_result' },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
  });
const spawn = (uuid: string, id: string) =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: '2026-07-14T10:00:04.000Z',
    message: {
      role: 'assistant',
      model: 'claude-opus-4-8',
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id,
          name: 'Agent',
          input: { subagent_type: 'general-purpose', prompt: 'do the thing', model: 'claude-sonnet-5' },
        },
      ],
      usage: { input_tokens: 10, output_tokens: 80, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 0 },
    },
  });
const turnDuration = (uuid: string) =>
  JSON.stringify({
    type: 'system',
    subtype: 'turn_duration',
    uuid,
    timestamp: '2026-07-14T10:00:09.000Z',
    durationMs: 9000,
    messageCount: 3,
  });

/** A session the size of a real long one: 150 turns, each with tools and a spawned subagent. */
function bigTranscript(): string[] {
  const lines: string[] = [];
  for (let t = 0; t < 150; t++) {
    lines.push(typed(`u${t}`, `task number ${t}`));
    for (let i = 0; i < 30; i++) {
      lines.push(toolUse(`a${t}-${i}`, `toolu_${t}_${i}`, 'Read'));
      lines.push(toolResult(`r${t}-${i}`, `toolu_${t}_${i}`));
    }
    lines.push(spawn(`s${t}`, `toolu_ag_${t}`));
    lines.push(turnDuration(`d${t}`));
  }
  return lines; // ~9.5k lines
}

test('folding a large session with the view subscribed stays linear (no snapshot per event)', () => {
  const lines = bigTranscript();
  const events: NormalizedEvent[] = [];
  let seq = 0;
  for (const l of lines) for (const e of parseLine(l, { ...ctx, seq: seq++ })) events.push(e);

  const tree = createSessionTree({ windowFor, mainModel: 'claude-opus-4-8' });
  tree.onChange(() => {}); // the view subscribes BEFORE the replay — this is the real shape

  const t0 = performance.now();
  for (const e of events) tree.apply(e);
  const ms = performance.now() - t0;

  const snap = tree.snapshot();
  assert.equal(snap.turnList.length, 150, 'the whole session was folded');
  assert.ok(events.length > 9_000, `a realistic event count (${events.length})`);
  assert.ok(ms < BUDGET_MS, `replaying ${events.length} events took ${ms.toFixed(0)}ms (budget ${BUDGET_MS}ms)`);
});
