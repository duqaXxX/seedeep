import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canCertify, closeWithEvidence, evaluate, isBroken, manualChecklist, report } from '../probe/verify.ts';
import type { Claim, ClaimContext } from '../src/server/schema-contract.ts';
import { CLAIMS, CTRLB_COMMAND, claimsForScene, SCENE1_MARKER } from '../src/server/schema-contract.ts';

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
    // A path under apps/server/src/, optionally `:symbol`, and NEVER a line number — the reader
    // used to be `parser.ts:194` and every sampled one had rotted into a `}` or a comment.
    // `schema-contract-readers.test.ts` checks that the paths and symbols actually resolve.
    assert.match(
      c.reader,
      /^[\w-]+\/[\w-]+\.ts(:[A-Za-z_]\w*)?(, [\w-]+\/[\w-]+\.ts(:[A-Za-z_]\w*)?)*$/,
      `${c.id} must name the site that reads it`,
    );
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
  assert.match(text, /server\/parser\.ts/);
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

/**
 * Scene 14's two lines. The SHAPE is the one real Ctrl+B receipt in the local corpus
 * (2026-08-09, CC 2.1.225): a Bash `tool_use` with no `run_in_background`, answered by a
 * `toolUseResult` carrying `backgroundTaskId` and `backgroundedByUser` and no `timedOutAfterMs`.
 * Content is synthetic; shape is a fact.
 */
const ctrlbLines = (over: Record<string, unknown> = {}) => [
  {
    type: 'assistant',
    sessionId: 'probe-1',
    version: '2.1.225',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_ctrlb', name: 'Bash', input: { command: CTRLB_COMMAND } }],
    },
    uuid: 'a-14',
  },
  {
    type: 'user',
    sessionId: 'probe-1',
    version: '2.1.225',
    message: { role: 'user', content: [{ tool_use_id: 'toolu_ctrlb', type: 'tool_result', content: 'ok' }] },
    toolUseResult: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bprobe1', ...over },
    uuid: 'u-14',
  },
];

test('scene 14 HOLDS when the Ctrl+B receipt names the user', () => {
  const r = evaluate(claimsForScene(14), ctxOf(ctrlbLines({ backgroundedByUser: true })));
  assert.deepEqual(
    r.map((x) => x.outcome),
    ['HOLDS'],
  );
});

test('scene 14 is BROKEN when the field goes but the gesture landed', () => {
  // The flip-off of the fix: same transcript, field removed. A claim that passed both ways
  // would be decoration.
  const r = evaluate(claimsForScene(14), ctxOf(ctrlbLines()));
  assert.equal(r[0]!.outcome, 'BROKEN');
});

test('scene 14 is UNPROVEN when the model backgrounded the command itself', () => {
  // Ground truth, not the field: with `run_in_background` in the input the receipt says nothing
  // about Ctrl+B, so the run must learn NOTHING rather than report a break.
  const lines = ctrlbLines();
  (lines[0]!.message.content as any)[0].input.run_in_background = true;
  assert.equal(evaluate(claimsForScene(14), ctxOf(lines))[0]!.outcome, 'UNPROVEN');
});

test('scene 14 is UNPROVEN when the call’s timeout backgrounded the command', () => {
  const r = evaluate(claimsForScene(14), ctxOf(ctrlbLines({ timedOutAfterMs: 120_000 })));
  assert.equal(r[0]!.outcome, 'UNPROVEN');
});

test('C27 can be closed by EVIDENCE — a real session runs anything but the scene’s command', () => {
  // `closeWithEvidence` re-runs `holds` against real transcripts, where nothing ever runs the
  // probe's `sleep 47`. A `holds` anchored to that command could never close this claim from a
  // real sighting, and a Ctrl+B the probe failed to land would keep the version uncertifiable
  // with the proof sitting on disk.
  const lines = ctrlbLines({ backgroundedByUser: true });
  (lines[0]!.message.content as any)[0].input.command = 'tail -f /home/dev/logs/publish.log';
  const unproven = evaluate([{ ...claimsForScene(14)[0]!, provoked: () => false }], ctxOf([]));
  assert.equal(unproven[0]!.outcome, 'UNPROVEN');
  const closed = closeWithEvidence(unproven, [ctxOf(lines)], '2.1.225');
  assert.equal(closed[0]!.outcome, 'HOLDS');
});

test('every model claim carries a manual instruction — it WILL land on the checklist', () => {
  // A model claim is unprovable by design, so it must always say what to do by
  // hand; otherwise the checklist prints a problem with no next step.
  const missing = CLAIMS.filter((c) => c.kind === 'model' && !c.manual).map((c) => c.id);
  assert.deepEqual(missing, []);
});
