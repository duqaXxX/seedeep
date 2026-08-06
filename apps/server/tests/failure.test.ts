import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toolOutcome } from '../src/server/failure.ts';

// The shapes below are REAL: measured over 3269 session files (1888 `is_error: true`
// tool_results). What is asserted here is the ONE judgement seedeep makes about them —
// a tool that failed is not the same thing as a tool the user refused to run.

test('a tool_result without is_error is ok, whatever it says', () => {
  assert.equal(toolOutcome(undefined, 'Exit code 0', undefined), 'ok');
  assert.equal(
    toolOutcome(false, 'permission denied everywhere', 'user-rejected'),
    'ok',
    'is_error is the gate: no flag, no verdict — the other signals never promote a success',
  );
});

test('toolDenialKind is authoritative when present', () => {
  assert.equal(toolOutcome(true, 'anything at all', 'user-rejected'), 'denied');
  assert.equal(toolOutcome(true, 'anything at all', 'permission-rule'), 'denied');
});

// toolDenialKind only appeared in Claude Code 2.1.198 and covers 130 of 246 real denials.
// Every session written before it — and every directory denial, which never carries the
// field at all — is recognised by the text Claude Code itself emits.
test('a denial in a session too old to carry toolDenialKind is still a denial', () => {
  assert.equal(
    toolOutcome(true, "The user doesn't want to proceed with this tool use. The tool use was rejected.", undefined),
    'denied',
  );
  assert.equal(
    toolOutcome(true, 'Permission to use Bash with command rm -rf build has been denied.', undefined),
    'denied',
  );
  assert.equal(toolOutcome(true, 'Tool permission request failed: Error: Stream closed', undefined), 'denied');
  assert.equal(
    toolOutcome(
      true,
      '<tool_use_error>File is in a directory that is denied by your permission settings</tool_use_error>',
      undefined,
    ),
    'denied',
  );
});

// THE regression this module exists for. Matching "permission" or "denied" anywhere in the
// text mis-reads real Bash failures as refusals — measured false positives included test
// output, `df` output and `gh` errors. The match is anchored; a body mention is not a denial.
test('a real failure that merely MENTIONS permission stays a failure', () => {
  assert.equal(
    toolOutcome(
      true,
      'Exit code 1\nrsync: send_files failed to open "/home/dev/app/x": Permission denied (13)',
      undefined,
    ),
    'failed',
    'the word appears in the OUTPUT, not as the verdict Claude Code wrote',
  );
  assert.equal(
    toolOutcome(true, 'Exit code 1\n=== test session starts ===\ntest_permission_denied_path FAILED', undefined),
    'failed',
  );
});

test('the ordinary failures are failures', () => {
  assert.equal(
    toolOutcome(
      true,
      '<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>',
      undefined,
    ),
    'failed',
  );
  assert.equal(toolOutcome(true, 'File does not exist.', undefined), 'failed');
  assert.equal(toolOutcome(true, 'Exit code 127\ncommand not found: rtk', undefined), 'failed');
  assert.equal(toolOutcome(true, '', undefined), 'failed', 'an empty error body is still an error');
});
