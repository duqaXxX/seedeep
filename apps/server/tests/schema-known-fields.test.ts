import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import known from '../data/known-fields.json' with { type: 'json' };
import type { ObservedSchema } from '../src/server/schema-known-fields.ts';
import { DEFAULT_MAX_FILES, observeSchema, unknownFields } from '../src/server/schema-known-fields.ts';

function observed(types: Record<string, string[]>, containers: Record<string, string[]> = {}): ObservedSchema {
  return {
    types: new Map(Object.entries(types).map(([t, ks]) => [t, new Set(ks)])),
    containers: new Map(Object.entries(containers).map(([p, ks]) => [p, new Set(ks)])),
    filesScanned: 1,
    linesScanned: 1,
  };
}

// A set standing in for the real one, so these stay deterministic.
const SET = {
  _note: '',
  types: { user: ['type', 'origin'], assistant: ['type', 'message'] },
  containers: { 'message.usage': ['input_tokens'], toolUseResult: ['stdout', 'stderr', 'interrupted'] },
};

test('a key CC started writing is reported', () => {
  const found = unknownFields(observed({ user: ['type', 'origin', 'queuePriority'] }), SET as typeof known);
  assert.deepEqual(found, [{ where: 'type:user', key: 'queuePriority', version: null }]);
});

test('a whole new line type is reported — this is how queue-operation arrived', () => {
  const found = unknownFields(observed({ 'queue-operation': ['type', 'content'] }), SET as typeof known);
  assert.deepEqual(found, [{ where: 'type:queue-operation', key: '(new line type)', version: null }]);
});

test('a new message.usage key is reported (Anthropic adds cache tiers there)', () => {
  const found = unknownFields(
    observed({}, { 'message.usage': ['input_tokens', 'cache_creation_5m_input_tokens'] }),
    SET as typeof known,
  );
  assert.deepEqual(found, [{ where: 'message.usage', key: 'cache_creation_5m_input_tokens', version: null }]);
});

// The hole this closes: for years the radar recorded `toolUseResult` as ONE top-level
// key and never looked inside, so `backgroundTaskId` — today the only reliable way to
// tell a Bash ran in the background — arrived without a word. Starts from a raw jsonl
// line (shape copied from a real launch receipt, content synthetic), not from a
// hand-built ObservedSchema: a fixture built on the old belief could not have failed.
test('the radar looks INSIDE toolUseResult, the container the parser reads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'seedeep-radar-'));
  const line = {
    type: 'user',
    timestamp: '2026-07-20T10:00:00.000Z',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'Command running in background' }],
    },
    toolUseResult: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1234abcd' },
  };
  await writeFile(join(dir, 'session.jsonl'), JSON.stringify(line) + '\n');

  const seen = await observeSchema(dir, 10);
  assert.equal(seen.linesScanned, 1);
  assert.ok(seen.containers.get('toolUseResult')?.has('backgroundTaskId'));

  // …and an unrecorded key inside it is REPORTED, under the container's own path.
  const found = unknownFields(seen, SET as typeof known).filter((f) => f.where === 'toolUseResult');
  assert.deepEqual(found, [{ where: 'toolUseResult', key: 'backgroundTaskId', version: null }]);
});

test('a known key is NOT reported, and a MISSING known key raises nothing', () => {
  // The absence side must stay silent: most fields are conditional, so "not seen"
  // is not evidence. Reporting it is what would make this test flaky.
  assert.deepEqual(unknownFields(observed({ user: ['type'] }), SET as typeof known), []);
});

// RADAR, not a guard — it never fails the build.
//
// The distinction is the whole point: a field CC ADDS cannot break seedeep, it can
// only be an opportunity ("should we read this?"). What breaks seedeep is a field
// it reads going away, and that is unanswerable by observation — absence proves
// nothing without a provoked event. The probe answers it; this does not.
//
// Nor would this have caught the background-subagent bug: `queue-operation` existed from 2026-05-27,
// before seedeep did, so it was "known" from day one and the radar would have said
// nothing. It sees only what arrives from now on.
test('radar: report what Claude Code started writing (never fails the build)', async () => {
  const seen = await observeSchema(undefined, DEFAULT_MAX_FILES);
  if (seen.filesScanned === 0) return; // no local sessions (CI, fresh clone)
  const found = unknownFields(seen);
  if (found.length === 0) return;
  const report =
    `\n── seedeep radar ─────────────────────────────────────────────\n` +
    `Claude Code is writing ${found.length} field(s) seedeep has never seen:\n` +
    found.map((f) => `  ${f.where} → ${f.key}`).join('\n') +
    `\n\nThis does NOT mean seedeep is broken — a new field breaks nothing.\n` +
    `Decide whether seedeep should read it, then accept it with:\n` +
    `  bun run src/schema-known-fields.ts --update\n` +
    `──────────────────────────────────────────────────────────────\n`;
  console.warn(report);
});
