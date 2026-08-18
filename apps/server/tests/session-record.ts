import type { SessionRecord } from '../src/core/types.ts';

/**
 * A complete synthetic SessionRecord with sane defaults, overridable per test. One
 * factory so a field added to SessionRecord is fixed here once, not per test file.
 */
export const rec = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  sessionId: 'aaaaaaaa-1111-2222-3333-444444444444',
  project: 'proj',
  model: 'claude-opus-4-8',
  lastActivity: Date.now(),
  isActive: false,
  isOpen: false,
  status: null,
  waitingFor: null,
  waitingSince: null,
  subject: 'do the thing',
  entrypoint: 'cli',
  root: 'cli',
  path: '/x.jsonl',
  ...over,
});
