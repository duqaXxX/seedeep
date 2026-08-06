import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canCertify, evaluate, isBroken, manualChecklist, report } from '../probe/verify.ts';
import type { Claim, ClaimContext } from '../src/server/schema-contract.ts';
import { CLAIMS, claimsForScene, SCENE1_MARKER } from '../src/server/schema-contract.ts';

/**
 * The scene-1 lines a real driven session produces. The SHAPE is not invented:
 * it is what the 2026-07-17 probe run actually wrote on CC 2.1.212 (verified
 * `origin.kind=human`, `promptSource=typed`, `system/turn_duration`,
 * `message.usage`, `entrypoint=cli`). Content is synthetic; shape is a fact.
 */
const REAL_SHAPE_LINES = [
  {
    type: 'user',
    sessionId: 'probe-1',
    cwd: '/home/dev/probe',
    entrypoint: 'cli',
    version: '2.1.212',
    origin: { kind: 'human' },
    promptSource: 'typed',
    message: { role: 'user', content: `${SCENE1_MARKER}, nothing else` },
    uuid: 'u-1',
  },
  {
    type: 'assistant',
    sessionId: 'probe-1',
    cwd: '/home/dev/probe',
    entrypoint: 'cli',
    version: '2.1.212',
    message: {
      id: 'msg_01probe',
      role: 'assistant',
      model: 'claude-haiku-4-5-20251001',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 4, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 },
    },
    uuid: 'a-1',
  },
  {
    type: 'system',
    subtype: 'turn_duration',
    sessionId: 'probe-1',
    version: '2.1.212',
    durationMs: 2000,
    messageCount: 2,
    uuid: 's-1',
  },
];

function ctxOf(lines: any[], extra: Partial<ClaimContext> = {}): ClaimContext {
  return {
    lines,
    raw: lines.map((l) => JSON.stringify(l)).join('\n'),
    children: [],
    openSessions: [{ pid: 1, sessionId: 'probe-1', cwd: '/home/dev/probe', status: 'idle' }],
    ...extra,
  };
}

const fake = (over: Partial<Claim>): Claim => ({
  id: 'CX',
  scene: 99,
  describe: 'a test claim',
  reader: 'parser.ts:1',
  investigate: 'look here',
  kind: 'gesture',
  provoked: () => true,
  holds: () => true,
  ...over,
});

test('every claim has a unique id, a reader site and an instruction', () => {
  const ids = CLAIMS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate claim id');
  for (const c of CLAIMS) {
    assert.match(c.reader, /\.ts:\d+|\.ts$/, `${c.id} must name the site that reads it`);
    assert.ok(c.investigate.length > 20, `${c.id} must say what to verify`);
  }
});

test('a GESTURE claim whose field is missing is BROKEN — the probe caused the event', () => {
  const r = evaluate([fake({ kind: 'gesture', holds: () => false })], ctxOf(REAL_SHAPE_LINES));
  assert.equal(r[0]!.outcome, 'BROKEN');
  assert.ok(isBroken(r));
});

test('a MODEL claim whose field is missing is UNPROVEN, NEVER broken', () => {
  // The load-bearing rule: the model may simply have routed differently, and that
  // cannot be told apart from a schema change. Calling it BROKEN would cry wolf
  // ~15 times a month and get the probe switched off.
  const r = evaluate([fake({ kind: 'model', holds: () => false })], ctxOf(REAL_SHAPE_LINES));
  assert.equal(r[0]!.outcome, 'UNPROVEN');
  assert.ok(!isBroken(r));
});

test('an unprovoked claim is UNPROVEN even if it is a gesture — nothing was learned', () => {
  const r = evaluate([fake({ provoked: () => false, holds: () => false })], ctxOf([]));
  assert.equal(r[0]!.outcome, 'UNPROVEN');
});

test('a claim that throws is UNPROVEN, not a crashed run', () => {
  const r = evaluate(
    [
      fake({
        holds: () => {
          throw new Error('boom');
        },
      }),
    ],
    ctxOf(REAL_SHAPE_LINES),
  );
  assert.equal(r[0]!.outcome, 'UNPROVEN');
  assert.match(r[0]!.reason, /threw/);
});

test('scene 1 claims all HOLD against a real-shaped transcript', () => {
  const r = evaluate(claimsForScene(1), ctxOf(REAL_SHAPE_LINES));
  const bad = r.filter((x) => x.outcome !== 'HOLDS');
  assert.deepEqual(
    bad.map((b) => `${b.claim.id}: ${b.outcome} (${b.reason})`),
    [],
    'a claim that cannot recognise a real turn is a broken claim, not a finding',
  );
});

test('removing origin.kind from a real turn makes C1 BROKEN — the guard bites', () => {
  const lines = structuredClone(REAL_SHAPE_LINES);
  delete (lines[0] as any).origin;
  const r = evaluate(claimsForScene(1), ctxOf(lines));
  const c1 = r.find((x) => x.claim.id === 'C1')!;
  assert.equal(c1.outcome, 'BROKEN');
  assert.ok(isBroken(r));
});

test('removing turn_duration makes C4 BROKEN', () => {
  const lines = REAL_SHAPE_LINES.filter((l) => l.subtype !== 'turn_duration');
  const c4 = evaluate(claimsForScene(1), ctxOf(lines)).find((x) => x.claim.id === 'C4')!;
  assert.equal(c4.outcome, 'BROKEN');
});

test('the report names the reader site and the next action, not just the field', () => {
  const lines = structuredClone(REAL_SHAPE_LINES);
  delete (lines[0] as any).origin;
  const text = report(evaluate(claimsForScene(1), ctxOf(lines)), '2.1.213');
  assert.match(text, /IS BROKEN on 2\.1\.213/);
  assert.match(text, /parser\.ts:110/);
  assert.match(text, /Verify:/);
});

test('an all-holding run says seedeep is OK and certifies nothing broken', () => {
  const text = report(evaluate(claimsForScene(1), ctxOf(REAL_SHAPE_LINES)), '2.1.212');
  assert.match(text, /seedeep is OK on 2\.1\.212/);
});

test('a run that proved NOTHING must not certify — "nothing broke" is not "I checked"', () => {
  // The regression that signed off 2.1.212 having proven 13 claims of 25: the old
  // rule was `!isBroken`, and a run that provokes nothing breaks nothing.
  const r = evaluate([fake({ kind: 'gesture', provoked: () => false })], ctxOf([]));
  assert.ok(!isBroken(r), 'nothing is broken…');
  assert.ok(!canCertify(r), '…but it must NOT certify');
});

test('an unproven MODEL claim does not block certification — the model may always route elsewhere', () => {
  const r = evaluate(
    [fake({ id: 'G', kind: 'gesture' }), fake({ id: 'M', kind: 'model', holds: () => false })],
    ctxOf(REAL_SHAPE_LINES),
  );
  assert.ok(canCertify(r));
});

test('certification requires every gesture claim, not merely the absence of breakage', () => {
  const r = evaluate(
    [fake({ id: 'G1', kind: 'gesture' }), fake({ id: 'G2', kind: 'gesture', provoked: () => false })],
    ctxOf(REAL_SHAPE_LINES),
  );
  assert.ok(!isBroken(r));
  assert.ok(!canCertify(r), 'a gesture the probe failed to provoke means the probe did not do its job');
});

test('everything the probe could not prove becomes an actionable manual checklist', () => {
  const r = evaluate(
    [fake({ id: 'M', kind: 'model', holds: () => false, manual: 'open a session and click the subagent' })],
    ctxOf(REAL_SHAPE_LINES),
  );
  const text = manualChecklist(r);
  assert.match(text, /TEST THESE BY HAND/);
  assert.match(text, /open a session and click the subagent/);
  assert.match(text, /parser\.ts:1/);
});

test('a fully-proven run has an empty manual checklist', () => {
  assert.equal(manualChecklist(evaluate(claimsForScene(1), ctxOf(REAL_SHAPE_LINES))), '');
});

test('every model claim carries a manual instruction — it WILL land on the checklist', () => {
  // A model claim is unprovable by design, so it must always say what to do by
  // hand; otherwise the checklist prints a problem with no next step.
  const missing = CLAIMS.filter((c) => c.kind === 'model' && !c.manual).map((c) => c.id);
  assert.deepEqual(missing, []);
});
