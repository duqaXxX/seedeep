import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isValidCertName } from '../src/core/cert-name.ts';

// What must pass, because it is what people actually type. An IPv4 literal is deliberately in
// this list and not in a branch of its own: a dotted quad already satisfies the hostname shape,
// and the `IP:`-vs-`DNS:` decision belongs to the SAN builder, not here.
test('isValidCertName: accepts the names remote mode is reached by', () => {
  for (const name of [
    'MacBook-Pro.local',
    'mac-mini.local',
    'box', // a single label is a legal hostname
    'a.b.c.d.example.test',
    '192.168.1.9',
    'Mixed.Case.Local', // DNS matching is case-insensitive
    'x'.repeat(63) + '.local', // the longest legal label
  ]) {
    assert.equal(isValidCertName(name), true, `${name} should be accepted`);
  }
});

// The one that matters: `,` separates SAN entries, so a name carrying one would add entries to a
// certificate the user believes covers a single name. No shell is involved, so this is not command
// injection — but a certificate quietly issued for something else is worse than a refusal.
test('isValidCertName: refuses a name that would inject another SAN entry', () => {
  assert.equal(isValidCertName('box.local,DNS:elsewhere.test'), false);
  assert.equal(isValidCertName('box.local,IP:10.0.0.1'), false);
});

// Refused, not trimmed. openssl trims it while writing the SAN, so a padded name produced a
// certificate for the TRIMMED name and then failed the coverage check against the padded one —
// judged not to cover its own name, and regenerated on every start with a new fingerprint. The
// invariant that catches this class is in tls.test.ts: a name accepted here must come back
// `reused`.
test('isValidCertName: refuses surrounding whitespace', () => {
  assert.equal(isValidCertName('  box.local  '), false);
  assert.equal(isValidCertName('box.local\n'), false);
  assert.equal(isValidCertName('\tbox.local'), false);
});

test('isValidCertName: refuses what is not a hostname', () => {
  for (const name of [
    '',
    '   ',
    'has space.local',
    '-leading.local', // a label may not start with a hyphen
    'trailing-.local', // …nor end with one
    'double..dot', // an empty label
    '.leading-dot',
    'trailing-dot.',
    'sla/sh.local',
    'under_score.local', // legal in DNS data, not in a hostname
    'quo"te.local',
    'new\nline.local',
    'x'.repeat(64) + '.local', // one over the label limit
    'a'.repeat(254), // one over the total limit
  ]) {
    assert.equal(isValidCertName(name), false, `${name} should be refused`);
  }
});

// Refused on purpose, and documented as a limit rather than left to fail later: the colons in an
// IPv6 literal cannot be told from the SAN's own `TYPE:value` separator without a full parser,
// and seedeep's certificates never enumerate IPv6 addresses either.
test('isValidCertName: refuses an IPv6 literal, which is a stated limit', () => {
  assert.equal(isValidCertName('fe80::1'), false);
  assert.equal(isValidCertName('::1'), false);
});
