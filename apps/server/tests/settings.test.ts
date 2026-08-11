import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildSaveBody,
  formatHeaders,
  isLoopback,
  parseHeaders,
  randomToken,
  resolveFormState,
} from '../src/client/settings.ts';

// ── isLoopback ───────────────────────────────────────────────────────────────

test('isLoopback: loopback addresses', () => {
  assert.equal(isLoopback('127.0.0.1'), true);
  assert.equal(isLoopback('::1'), true);
  assert.equal(isLoopback('localhost'), true);
});

test('isLoopback: empty / whitespace-only host', () => {
  assert.equal(isLoopback(''), true);
  assert.equal(isLoopback('   '), true);
});

test('isLoopback: non-loopback addresses', () => {
  assert.equal(isLoopback('192.168.1.10'), false);
  assert.equal(isLoopback('0.0.0.0'), false);
  assert.equal(isLoopback('example.com'), false);
  assert.equal(isLoopback('10.0.0.1'), false);
});

test('isLoopback: trims whitespace before checking', () => {
  assert.equal(isLoopback('  127.0.0.1  '), true);
  assert.equal(isLoopback('  192.168.1.1  '), false);
});

// ── randomToken ──────────────────────────────────────────────────────────────

test('randomToken: produces a base64url-safe string of expected length', () => {
  const t = randomToken();
  // 32 bytes base64url → 43 chars (no padding)
  assert.equal(t.length, 43);
  assert.match(t, /^[A-Za-z0-9\-_]+$/, 'only base64url chars');
});

test('randomToken: consecutive calls produce distinct tokens', () => {
  const tokens = new Set(Array.from({ length: 20 }, randomToken));
  assert.equal(tokens.size, 20, 'all 20 tokens must be unique');
});

// ── resolveFormState ─────────────────────────────────────────────────────────

test('resolveFormState: loopback host → not remote, can always save', () => {
  const r = resolveFormState('127.0.0.1', '');
  assert.equal(r.remote, false);
  assert.equal(r.canSave, true);
});

test('resolveFormState: remote host + no CN → cannot save', () => {
  const r = resolveFormState('192.168.1.10', '');
  assert.equal(r.remote, true);
  assert.equal(r.canSave, false);
});

test('resolveFormState: remote host + whitespace-only CN → cannot save', () => {
  const r = resolveFormState('192.168.1.10', '   ');
  assert.equal(r.canSave, false);
});

test('resolveFormState: remote host + CN provided → can save', () => {
  const r = resolveFormState('192.168.1.10', 'MacBook-Pro.local');
  assert.equal(r.remote, true);
  assert.equal(r.canSave, true);
});

test('resolveFormState: localhost alias counts as loopback', () => {
  assert.equal(resolveFormState('localhost', '').remote, false);
  assert.equal(resolveFormState('::1', '').remote, false);
});

// The panel has to refuse exactly what the server refuses. If it lets a name through, the user
// gets a rejection from the far side for something the field could have said immediately.
test('resolveFormState: a CN the server would refuse cannot be saved', () => {
  const r = resolveFormState('192.168.1.10', 'box.local,DNS:elsewhere.test');
  assert.equal(r.canSave, false);
  assert.match(r.cnError, /hostname|IPv4/);
});

// Not remote, but still on its way into a certificate the moment the host changes — and it is
// already being written to config.json.
test('resolveFormState: an invalid CN blocks the save even in loopback mode', () => {
  assert.equal(resolveFormState('127.0.0.1', 'bad name').canSave, false);
});

test('resolveFormState: a valid CN reports no error', () => {
  assert.equal(resolveFormState('192.168.1.10', 'MacBook-Pro.local').cnError, '');
  assert.equal(resolveFormState('192.168.1.10', '192.168.1.10').cnError, '');
});

// ── buildSaveBody ────────────────────────────────────────────────────────────

test('buildSaveBody: loopback mode — no tls or auth fields', () => {
  const body = buildSaveBody(44842, '127.0.0.1', true, '', '');
  assert.deepEqual(body, { port: 44842, host: '127.0.0.1', open: true });
});

test('buildSaveBody: remote mode with CN — includes tls block', () => {
  const body = buildSaveBody(44842, '192.168.1.5', true, 'my-box.local', '');
  assert.deepEqual(body, {
    port: 44842,
    host: '192.168.1.5',
    open: true,
    tls: { commonName: 'my-box.local' },
  });
});

test('buildSaveBody: pending token — includes auth block', () => {
  const body = buildSaveBody(44842, '127.0.0.1', false, '', 'newtoken123');
  assert.deepEqual(body, { port: 44842, host: '127.0.0.1', open: false, auth: { token: 'newtoken123' } });
});

test('buildSaveBody: CN is trimmed before inclusion', () => {
  const body = buildSaveBody(44842, '10.0.0.1', true, '  my-box.local  ', '');
  assert.deepEqual((body['tls'] as { commonName: string }).commonName, 'my-box.local');
});

test('buildSaveBody: whitespace-only CN is omitted', () => {
  const body = buildSaveBody(44842, '10.0.0.1', true, '   ', '');
  assert.equal('tls' in body, false, 'tls must not be included when CN is blank');
});

test('buildSaveBody: empty token is omitted', () => {
  const body = buildSaveBody(44842, '127.0.0.1', true, '', '');
  assert.equal('auth' in body, false);
});

test('buildSaveBody: both CN and token present', () => {
  const body = buildSaveBody(9000, '10.0.0.2', false, 'box.local', 'tok42');
  assert.deepEqual(body, {
    port: 9000,
    host: '10.0.0.2',
    open: false,
    tls: { commonName: 'box.local' },
    auth: { token: 'tok42' },
  });
});

// ── webhook headers ──────────────────────────────────────────────────────────

test('headers are one Name: value per line, and round-trip', () => {
  const parsed = parseHeaders('Authorization: Bearer t\nTitle: seedeep');
  assert.deepEqual(parsed, { Authorization: 'Bearer t', Title: 'seedeep' });
  assert.equal(formatHeaders(parsed), 'Authorization: Bearer t\nTitle: seedeep');
});

test('a value containing a colon survives, because URLs and times both have one', () => {
  assert.deepEqual(parseHeaders('X-Target: https://example.test:8443/x'), {
    'X-Target': 'https://example.test:8443/x',
  });
});

test('a line with no name is dropped rather than guessed at', () => {
  // A header with no name is not a header, and inventing one would send it to the user's service
  // without them having written it.
  assert.deepEqual(parseHeaders('nonsense\n: novalue\n\nTitle: ok'), { Title: 'ok' });
});

test('the save body carries the webhook with its headers parsed', () => {
  const body = buildSaveBody(4571, '127.0.0.1', true, '', '', {
    url: 'https://example.test/hook',
    headersText: 'Title: seedeep',
    template: '{{title}}',
    needsYou: true,
    fails: false,
    finishes: false,
    updates: false,
  });
  assert.deepEqual(body['notifications'], {
    webhook: {
      url: 'https://example.test/hook',
      headers: { Title: 'seedeep' },
      template: '{{title}}',
      needsYou: true,
      fails: false,
      finishes: false,
      updates: false,
    },
  });
});
