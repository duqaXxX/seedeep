import type { NormalizedEvent } from '../core/types.ts';

// The single source of truth for the SSE event types the browser listens to.
// BOTH the live stream (stream.ts) and the replay driver (replay.ts) must attach a
// listener per type — a type present in the wire but absent here is silently
// dropped (no listener). Keeping ONE list prevents the two from drifting apart,
// which is exactly how tool timing and subagent enrichment were lost before
// (a type added to one file but not the other). Add a new NormalizedEvent type
// here and both paths pick it up. `session-added`/`replay-end` are control frames
// handled directly, not data events, so they are not listed here.
// Exhaustive BY CONSTRUCTION: keying a Record on `NormalizedEvent['type']` means a new event
// type fails to COMPILE until it is listed here, instead of being silently dropped at runtime
// with no listener. The comment above has warned about this drift twice; a warning is not a
// mechanism, and the drift happened again (`agent-end` reached the wire and the browser threw
// it away, so background subagents never finished in the live view while replay was fine).
const LISTENED: Record<NormalizedEvent['type'], true> = {
  usage: true,
  attribution: true,
  compaction: true,
  'tool-start': true,
  'tool-end': true,
  'agent-end': true,
  'agent-launch': true,
  'background-event': true,
  // Not parsed from any line — the server's liveness probe emits it. The browser listens for the
  // same reason it listens to the rest: it owns its own reducer, and a verdict only the server
  // heard would leave the two disagreeing about what is still running.
  'command-vanished': true,
  'workflow-agent': true,
  'subagent-meta': true,
  'subagent-output': true,
  'user-turn': true,
  command: true,
  'turn-end': true,
  'turn-interrupted': true,
  'turn-result': true,
  'turn-narration': true,
  'file-change': true,
};
export const EVENT_TYPES: readonly NormalizedEvent['type'][] = Object.keys(LISTENED) as NormalizedEvent['type'][];
