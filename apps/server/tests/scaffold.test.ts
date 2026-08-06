import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NormalizedEvent } from '../src/core/types.ts';

test('types module is importable and toolchain runs', () => {
  const ev: NormalizedEvent = {
    type: 'compaction',
    sessionId: 's1',
    root: 'cli',
    timestamp: '2026-07-11T00:00:00.000Z',
    seq: 0,
    isSummary: false,
    preTokens: null,
    postTokens: null,
    durationMs: null,
  };
  assert.equal(ev.type, 'compaction');
});
