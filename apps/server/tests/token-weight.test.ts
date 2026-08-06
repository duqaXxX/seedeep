import assert from 'node:assert/strict';
import test from 'node:test';
import { callWeight, MODEL_WEIGHT, modelWeight, TOKEN_TYPE_WEIGHT } from '../src/core/token-weight.ts';

// The weight is the whole point of the Compare surface, and both of its factors are claims about
// the outside world: the per-token-type rates are Anthropic's published burndown, the per-model
// ratios are ours from the price list. These tests pin the ARITHMETIC and the degradation rules —
// they cannot tell you the price list moved (only re-reading the docs can), which is why the card
// says to re-verify at implementation time.

test('per-token-type weights are the published burndown rates (1 h cache TTL)', () => {
  assert.deepEqual(TOKEN_TYPE_WEIGHT, { input: 1, cacheWrite: 2.0, cacheRead: 0.1, output: 5 });
});

test('callWeight scales each kind of token, then the whole call by its model', () => {
  const t = { input: 100, cacheCreation: 1000, cacheRead: 10_000, output: 200 };
  // per-type: 100 + 2000 + 1000 + 1000 = 4100
  assert.equal(callWeight('claude-haiku-4-5-20251001', t), 4100);
  assert.equal(callWeight('claude-sonnet-4-6', t), 4100 * 3);
  assert.equal(callWeight('claude-opus-4-8', t), 4100 * 5);
  assert.equal(callWeight('claude-fable-5', t), 4100 * 10);
});

test('cache reads are the cheap kind: 10k of them weigh a tenth of 10k fresh input', () => {
  const read = callWeight('claude-opus-4-8', { input: 0, cacheCreation: 0, cacheRead: 10_000, output: 0 });
  const fresh = callWeight('claude-opus-4-8', { input: 10_000, cacheCreation: 0, cacheRead: 0, output: 0 });
  assert.equal(read * 10, fresh);
});

test('an unknown model weighs 0 — never an invented ratio', () => {
  // `<synthetic>` is Claude Code's api-error placeholder, and it carries an all-zero usage block:
  // giving it a weight would put a failure on the leaderboard.
  assert.equal(modelWeight('<synthetic>'), 0);
  assert.equal(modelWeight(null), 0);
  assert.equal(modelWeight(''), 0);
  assert.equal(callWeight('some-other-vendor-model', { input: 1e6, cacheCreation: 0, cacheRead: 0, output: 0 }), 0);
});

test('a model id newer than the table falls back to its FAMILY, not to zero', () => {
  // The point of the fallback: Claude Code ships a release every ~1.9 days and model ids move.
  // A future `claude-opus-9-9` must not silently weigh nothing (that would understate the
  // heaviest sessions), nor weigh the same as Haiku.
  assert.equal(modelWeight('claude-opus-9-9'), 5);
  assert.equal(modelWeight('claude-haiku-9-9'), 1);
  assert.equal(modelWeight('claude-fable-9'), 10);
  assert.equal(modelWeight('claude-sonnet-9-9'), 3);
});

test('every id in the table resolves to its own value, not to the family fallback', () => {
  // Sonnet 5 is 2 and Sonnet 4.6 is 3; if the exact lookup ever stopped winning, Sonnet 5 would
  // silently become 3 and no other test here would notice.
  assert.equal(modelWeight('claude-sonnet-5'), 2);
  for (const [id, w] of Object.entries(MODEL_WEIGHT)) assert.equal(modelWeight(id), w, id);
});
