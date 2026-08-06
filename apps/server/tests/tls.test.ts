import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isValidCertName } from '../src/core/cert-name.ts';
import { certFingerprint, ensureTlsCert } from '../src/server/tls.ts';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'seedeep-tls-'));
}

/**
 * The certificate's Subject Alternative Name as `openssl` prints it — the independent oracle for
 * "what does this certificate actually certify?".
 *
 * Read from `-text` rather than `-ext subjectAltName`, which LibreSSL's `x509` does not have.
 * Note the spelling: an IP entry goes IN as `IP:` and comes back OUT as `IP Address:`.
 */
function opensslSan(certPath: string): string {
  const out = execFileSync('openssl', ['x509', '-in', certPath, '-noout', '-text'], { encoding: 'utf8' });
  const at = out.indexOf('Subject Alternative Name');
  assert.ok(at > 0, 'the certificate carries no subjectAltName at all');
  return out.slice(at).split('\n')[1]!.trim();
}

/**
 * What `openssl` itself says the fingerprint is — the independent oracle.
 *
 * The value is taken from after the `=`, not by stripping a literal `SHA256 Fingerprint=`:
 * the label's spelling belongs to whichever implementation is installed (this machine has
 * LibreSSL, a CI box has OpenSSL), and an oracle that fails because it did not recognise its
 * own tool's prefix would report a certFingerprint bug that does not exist.
 */
function opensslFingerprint(certPath: string): string {
  const out = execFileSync('openssl', ['x509', '-in', certPath, '-noout', '-fingerprint', '-sha256'], {
    encoding: 'utf8',
  });
  const at = out.indexOf('=');
  assert.ok(at > 0, `unexpected openssl output: ${out.trim()}`);
  return out.slice(at + 1).trim();
}

// The value a client pins must be the value the user can check with a tool that shares none of
// this code. Re-implementing the hash in the test would only prove the test agrees with itself.
test('ensureTlsCert: the reported fingerprint is the one openssl reports', async () => {
  const dir = tmp();
  const cert = join(dir, 'cert.pem');
  const key = join(dir, 'key.pem');

  const { fingerprint } = await ensureTlsCert('seedeep-test.local', cert, key);

  assert.equal(fingerprint, opensslFingerprint(cert));
  assert.match(fingerprint, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/, 'uppercase hex, colon separated');
});

// The defect this guards, found on a real two-machine install: the commonName went only into
// `-subj /CN=`, and browsers have ignored the CN since Chrome 58. So seedeep issued a
// certificate FOR a hostname it did not certify, and handed out an access URL no TLS stack can
// validate by name — hidden inside the trust warning the user had already accepted.
test('ensureTlsCert: the SAN certifies the commonName, not only the CN field', async () => {
  const dir = tmp();
  const cert = join(dir, 'cert.pem');
  const key = join(dir, 'key.pem');

  await ensureTlsCert('seedeep-test.local', cert, key);

  const san = opensslSan(cert);
  assert.match(san, /DNS:seedeep-test\.local(,|$)/, `commonName absent from the SAN: ${san}`);
  assert.match(san, /DNS:localhost(,|$)/, `localhost absent from the SAN: ${san}`);
  assert.match(san, /IP Address:127\.0\.0\.1(,|$)/, `127.0.0.1 absent from the SAN: ${san}`);
});

// A commonName can legitimately BE an address — it is what a user connects by when the machine
// has no name. `DNS:192.168.1.9` is a syntactically valid entry that matches nothing, so the
// entry has to be typed by what the name is.
test('ensureTlsCert: a commonName that is an IP becomes an IP entry, not a DNS one', async () => {
  const dir = tmp();
  const cert = join(dir, 'cert.pem');
  const key = join(dir, 'key.pem');

  // TEST-NET-2 (RFC 5737): an address that is unmistakably not anybody's.
  await ensureTlsCert('198.51.100.7', cert, key);

  const san = opensslSan(cert);
  assert.match(san, /IP Address:198\.51\.100\.7(,|$)/, san);
  assert.doesNotMatch(san, /DNS:198\.51\.100\.7/, san);
});

// The second defect: `getLanIp()` returned the FIRST non-internal IPv4, and on a real Mac that
// iteration yields Tailscale's `utun0` BEFORE `en1` — certifying an address the user never
// connects on and omitting the one they do. Any machine with a VPN, Tailscale or Docker has
// several, so picking one is picking at random.
//
// The expected set is computed here from the OS, not copied from the code, so the two can
// disagree. It is only a strong test on a multi-homed machine — which is exactly the machine
// that hit the bug.
test('ensureTlsCert: every address this machine answers on is in the SAN', async () => {
  const dir = tmp();
  const cert = join(dir, 'cert.pem');
  const key = join(dir, 'key.pem');

  const expected = Object.values(networkInterfaces())
    .flatMap((addrs) => addrs ?? [])
    .filter((a) => !a.internal && a.family === 'IPv4')
    .map((a) => a.address);

  await ensureTlsCert('seedeep-test.local', cert, key);

  const san = opensslSan(cert);
  for (const ip of expected) {
    assert.ok(san.includes(`IP Address:${ip}`), `${ip} absent from the SAN: ${san}`);
  }
});

// The regression this guards: the fingerprint used to exist only on the run that created the
// file, so a user setting up a pinning client a week later had nothing to compare against.
test('ensureTlsCert: reuse reports the same fingerprint without regenerating', async () => {
  const dir = tmp();
  const cert = join(dir, 'cert.pem');
  const key = join(dir, 'key.pem');

  const first = await ensureTlsCert('seedeep-test.local', cert, key);
  const pemAfterFirst = readFileSync(cert, 'utf8');

  const second = await ensureTlsCert('seedeep-test.local', cert, key);

  assert.equal(second.fingerprint, first.fingerprint);
  assert.equal(second.origin, 'reused');
  assert.equal(readFileSync(cert, 'utf8'), pemAfterFirst, 'the certificate was reused, not rewritten');
});

// A corrected SAN is inert for everyone who already has a certificate, because both files exist
// and the old code reused them unconditionally. The name is the trigger — not the address set,
// which changes on its own every time a VPN comes up, and a pin that changes with the weather is
// no pin at all.
test('ensureTlsCert: a stored certificate that does not cover the commonName is replaced', async () => {
  const dir = tmp();
  const cert = join(dir, 'cert.pem');
  const key = join(dir, 'key.pem');

  const stale = await ensureTlsCert('old-name.local', cert, key);
  const fresh = await ensureTlsCert('new-name.local', cert, key);

  assert.equal(fresh.origin, 'replaced');
  assert.notEqual(fresh.fingerprint, stale.fingerprint, 'a replacement the pin cannot see is not a replacement');
  assert.match(opensslSan(cert), /DNS:new-name\.local(,|$)/);
  assert.equal(await certFingerprint(cert), fresh.fingerprint, 'the reported value is the file on disk');
});

// A certificate the TLS stack cannot parse cannot serve TLS either, so "cannot vouch for it" and
// "does not cover the name" deserve the same answer. Without this the server would start, hand
// the garbage to Bun.serve, and fail at the first connection instead of at the check.
test('ensureTlsCert: an unparseable stored certificate is replaced, not served', async () => {
  const dir = tmp();
  const cert = join(dir, 'cert.pem');
  const key = join(dir, 'key.pem');
  writeFileSync(cert, '-----BEGIN CERTIFICATE-----\nnot base64 at all\n-----END CERTIFICATE-----\n');
  writeFileSync(key, 'not a key\n');

  const { origin, fingerprint } = await ensureTlsCert('seedeep-test.local', cert, key);

  assert.equal(origin, 'replaced');
  assert.equal(fingerprint, opensslFingerprint(cert));
});

// A pinning client verifies the LEAF, which a chain PEM puts first. Hashing the concatenated
// blocks would produce a value no certificate presented on the wire can ever match.
test('certFingerprint: a chain PEM hashes the leaf only', async () => {
  const dir = tmp();
  const cert = join(dir, 'cert.pem');
  const key = join(dir, 'key.pem');
  const { fingerprint } = await ensureTlsCert('seedeep-test.local', cert, key);

  const chain = join(dir, 'chain.pem');
  const leaf = readFileSync(cert, 'utf8');
  writeFileSync(chain, `${leaf}${leaf}`);

  assert.equal(await certFingerprint(chain), fingerprint);
});

/**
 * THE invariant that ties the two halves together: whatever `isValidCertName` accepts, the
 * certificate generated for it must cover it — asserted as "the second call reuses", because
 * `ensureTlsCert` replaces a pair that does not certify the current name.
 *
 * The bug this catches is silent and permanent: a padded `commonName` passed validation, openssl
 * trimmed it into the SAN, and the coverage check then asked about the PADDED name and got no —
 * so the certificate was judged not to cover its own name and was regenerated on every start,
 * with a new fingerprint each time, breaking any pin every time. Naming the padded case alone
 * would not have found the same shape in case-folding or in a future normalisation.
 */
test('ensureTlsCert: a name it accepts is a name its own certificate covers', async () => {
  // The candidates deliberately include shapes the predicate REFUSES, and the loop skips those.
  // That is what makes this able to fail: the day the predicate accepts one of them, this test
  // exercises it and reports that the certificate does not cover it — which is precisely how the
  // padded-name defect behaved.
  const candidates = [
    'seedeep-test.local',
    'Mixed.Case.Local', // DNS matching is case-insensitive; proven here, not assumed
    'box',
    '198.51.100.7',
    '  box.local  ', // refused today; accepted, it regenerates on every start
    'box.local\n',
    'box.local.',
  ];
  let exercised = 0;
  for (const name of candidates) {
    if (!isValidCertName(name)) continue;
    exercised++;
    const dir = tmp();
    const cert = join(dir, 'cert.pem');
    const key = join(dir, 'key.pem');

    const first = await ensureTlsCert(name, cert, key);
    const second = await ensureTlsCert(name, cert, key);

    assert.equal(first.origin, 'created', name);
    assert.equal(second.origin, 'reused', `${name}: regenerated on restart — it does not cover its own name`);
    assert.equal(second.fingerprint, first.fingerprint, `${name}: the fingerprint moved, so every pin broke`);
  }
  // Or a predicate that refuses everything would make the whole test vacuous.
  assert.ok(exercised >= 4, `only ${exercised} candidates were accepted — the predicate is too strict`);
});

// The guard has to be here and not only at the API boundary: `commonName` also arrives from
// config.json and SEEDEEP_TLS_CN, which no request handler ever sees.
test('ensureTlsCert: a commonName that is not a hostname throws, and writes nothing', async () => {
  const dir = tmp();
  const cert = join(dir, 'cert.pem');
  const key = join(dir, 'key.pem');

  await assert.rejects(
    () => ensureTlsCert('box.local,DNS:elsewhere.test', cert, key),
    /not a hostname or an IPv4 address/,
  );
  assert.equal(existsSync(cert), false, 'a refused name must not leave a certificate behind');
  assert.equal(existsSync(key), false, 'nor a private key');
});

test('certFingerprint: a file with no certificate block throws', async () => {
  const dir = tmp();
  const notACert = join(dir, 'notes.txt');
  writeFileSync(notACert, 'this is not a certificate\n');

  await assert.rejects(() => certFingerprint(notACert), /no certificate found/);
});
