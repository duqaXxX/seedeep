import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planClaudeCommand } from '../src/server/claude-command.ts';

const ID = '11111111-2222-3333-4444-555555555555';

test('no word opens — what bare /seedeep did before it took arguments', () => {
  assert.deepEqual(planClaudeCommand([ID]), { kind: 'open' });
  assert.deepEqual(planClaudeCommand([ID, 'open']), { kind: 'open' });
});

test('report carries the session id Claude Code substituted', () => {
  assert.deepEqual(planClaudeCommand([ID, 'report']), { kind: 'report', sessionId: ID, full: false });
  assert.deepEqual(planClaudeCommand([ID, 'report', 'full']), { kind: 'report', sessionId: ID, full: true });
});

test('restart, stop and update are their own plans', () => {
  assert.deepEqual(planClaudeCommand([ID, 'restart']), { kind: 'restart' });
  assert.deepEqual(planClaudeCommand([ID, 'stop']), { kind: 'stop' });
  assert.deepEqual(planClaudeCommand([ID, 'start']), { kind: 'start' });
  assert.deepEqual(planClaudeCommand([ID, 'update']), { kind: 'update' });
});

// The command file cannot validate anything — it is a template. Everything typed after /seedeep
// arrives here verbatim, so this is the only place a mistake can be caught.
test('an unknown word names the three that exist', () => {
  const plan = planClaudeCommand([ID, 'summary']);
  assert.equal(plan.kind, 'error');
  assert.match(plan.kind === 'error' ? plan.message : '', /open, start, stop, restart, report or update/);
});

test('a word after report that is not "full" is refused rather than ignored', () => {
  assert.equal(planClaudeCommand([ID, 'report', 'everything']).kind, 'error');
});

// The degradation path: an unsubstituted ${CLAUDE_SESSION_ID} expands to nothing, so `/seedeep
// report` arrives as ['report'] — which without a shape check reads as "session 'report', no word"
// and OPENS THE GUI instead of reporting.
test('a first argument that is not a session id is refused, never treated as one', () => {
  assert.equal(planClaudeCommand([]).kind, 'error');
  const plan = planClaudeCommand(['report']);
  assert.equal(plan.kind, 'error');
  assert.match(plan.kind === 'error' ? plan.message : '', /did not substitute/);
  assert.equal(planClaudeCommand(['not-a-uuid', 'open']).kind, 'error');
});
