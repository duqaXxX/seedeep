import assert from 'node:assert/strict';
import { test } from 'node:test';
import { windowFor } from '../src/core/context-windows.ts';

test('known 1M model returns its window, not estimated', () => {
  assert.deepEqual(windowFor('claude-opus-4-8'), { window: 1_000_000, estimated: false });
});

// Was missing until 2026-07-25 and silently answered 200k for the model the corpus was
// actually running on, which put 18 real turns above 100% of "their" window (max 272%).
test('claude-opus-5 is 1M, not the fallback', () => {
  assert.deepEqual(windowFor('claude-opus-5'), { window: 1_000_000, estimated: false });
});

test('haiku is 200k', () => {
  assert.deepEqual(windowFor('claude-haiku-4-5'), { window: 200_000, estimated: false });
});

test('sonnet-4-6 is pinned to 200k (subscription; API conflict documented)', () => {
  assert.deepEqual(windowFor('claude-sonnet-4-6'), { window: 200_000, estimated: false });
});

test('unknown or null model falls back to 200k and is flagged estimated', () => {
  assert.deepEqual(windowFor('claude-future-9'), { window: 200_000, estimated: true });
  assert.deepEqual(windowFor(null), { window: 200_000, estimated: true });
});

test('a dated model id matches by prefix (claude-haiku-4-5-20251001)', () => {
  assert.deepEqual(windowFor('claude-haiku-4-5-20251001'), { window: 200_000, estimated: false });
});
