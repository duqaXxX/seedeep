import { spawn } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { access, chmod, mkdir, readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { dirname } from 'node:path';
import { isValidCertName } from '../core/cert-name.ts';

/**
 * Every non-internal IPv4 address this machine answers on.
 *
 * All of them, deliberately: this used to return the first one, and on a real Mac the iteration
 * yields Tailscale's `utun0` before `en1` — certifying an address the user never connects on and
 * omitting the one they do. A machine with a VPN, Tailscale or Docker has several, so picking
 * one is picking at random.
 *
 * LIMIT: IPv4 only — enumerating IPv6 would add the machine's temporary privacy addresses, which
 * the OS rotates, dating the certificate within a day. Remote mode therefore needs a hostname or
 * an IPv4 address; `isValidCertName` refuses an IPv6 `commonName` for its own reason.
 */
function lanIps(): string[] {
  return Object.values(networkInterfaces())
    .flatMap((addrs) => addrs ?? [])
    .filter((addr) => !addr.internal && addr.family === 'IPv4')
    .map((addr) => addr.address);
}

/** A SAN entry typed by what the name IS: `DNS:192.168.1.9` is valid syntax that matches nothing. */
function sanEntry(name: string): string {
  return isIP(name) ? `IP:${name}` : `DNS:${name}`;
}

/**
 * Whether the certificate in `pem` certifies `name`.
 *
 * Asked of the TLS stack rather than by reading the SAN as text, so the answer follows the same
 * RFC 6125 rules a client applies — in particular that a certificate carrying a SAN has its CN
 * ignored, which is the exact trap this guards against.
 */
function certCovers(pem: string, name: string): boolean {
  try {
    const cert = new X509Certificate(pem);
    return (isIP(name) ? cert.checkIP(name) : cert.checkHost(name)) !== undefined;
  } catch {
    // A certificate the stack cannot parse cannot serve TLS either, so "cannot vouch for it" and
    // "does not cover this name" get the same answer, and the same repair.
    return false;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Run a command and resolve when it exits 0, reject otherwise. */
function runCmd(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let errOut = '';
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr?.on('data', (d: Buffer) => {
      errOut += d.toString();
    });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}: ${errOut.trim()}`));
    });
    child.on('error', (err) => reject(new Error(`${cmd} not found: ${err.message}`)));
  });
}

/**
 * SHA-256 fingerprint of the certificate in `certPath`, formatted `AA:BB:CC:…` — the same
 * digest and the same formatting `openssl x509 -fingerprint -sha256` prints, so a user can
 * check the value out of band with a tool that shares none of this code.
 *
 * Only the FIRST certificate in the file is hashed. A pinning client verifies the leaf, which
 * is what a chain PEM puts first; concatenating a chain's blocks would hash bytes no
 * certificate ever had and pin a value nothing can match.
 */
export async function certFingerprint(certPath: string): Promise<string> {
  const pem = await readFile(certPath, 'utf8');
  const block = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/.exec(pem);
  if (!block) throw new Error(`seedeep TLS: no certificate found in ${certPath}`);
  const der = Buffer.from(block[1]!.replace(/\s+/g, ''), 'base64');
  return createHash('sha256').update(der).digest('hex').match(/.{2}/g)!.join(':').toUpperCase();
}

/** Where the certificate being served came from on this call. */
export type CertOrigin = 'reused' | 'created' | 'replaced';

/**
 * Ensure a TLS cert at `certPath` and `keyPath` that actually certifies `commonName`.
 *
 * A stored pair is reused whenever it covers `commonName`, and REPLACED when it does not —
 * including a pair that cannot be parsed. Otherwise a new RSA-2048 cert is generated via
 * `openssl req -x509` with a 10-year validity and a SAN covering `localhost`, `127.0.0.1`,
 * `commonName`, and every non-internal IPv4 address of this machine.
 *
 * **The name is the only trigger for replacement, never the address set.** The addresses change
 * on their own — a VPN coming up is enough — and replacing the certificate changes its
 * fingerprint, so keying on them would give a pin that fires with the weather. Keying on the
 * name also leaves a user-supplied certificate alone: a real one for `box.example.com` covers
 * that name, so seedeep never overwrites it, even though it has no `localhost` in its SAN.
 *
 * `origin` says which of the three happened, so a caller can tell the user that a pinned
 * fingerprint has just been invalidated. The returned `fingerprint` is computed on EVERY call:
 * it is what a non-browser client pins (TOFU), and a value the user can only read on the run
 * that created the file is a value they cannot check. Reporting either is the caller's job —
 * this module derives, it does not decide what a user sees.
 *
 * Throws if `commonName` is empty or not a name a certificate can carry, or if `openssl` is not
 * available. The name check is here and not only at the API boundary because the value also
 * arrives from `config.json` and `SEEDEEP_TLS_CN`, which no request handler sees.
 */
export async function ensureTlsCert(
  commonName: string,
  certPath: string,
  keyPath: string,
): Promise<{ cert: string; key: string; fingerprint: string; origin: CertOrigin }> {
  if (!commonName) throw new Error('seedeep TLS: commonName must not be empty');
  if (!isValidCertName(commonName)) {
    throw new Error(
      `seedeep TLS: commonName ${JSON.stringify(commonName)} is not a hostname or an IPv4 address. ` +
        'Use letters, digits, hyphens and dots.',
    );
  }

  let origin: CertOrigin = 'created';
  if ((await fileExists(certPath)) && (await fileExists(keyPath))) {
    if (certCovers(await readFile(certPath, 'utf8'), commonName)) {
      return { cert: certPath, key: keyPath, fingerprint: await certFingerprint(certPath), origin: 'reused' };
    }
    // Serving it would present a certificate no client can validate by the name seedeep itself
    // hands out — and a self-signed certificate hides that mismatch inside the trust warning the
    // user has already accepted, so nobody would ever find out.
    origin = 'replaced';
  }

  // 0o700: only the owner can list this directory — the private key must never be
  // reachable by other users on the same machine even before the chmod below.
  await mkdir(dirname(certPath), { recursive: true, mode: 0o700 });

  // A Set because `commonName` is usually already one of these, and a repeated entry is noise in
  // a certificate a human is going to read.
  const san = [
    ...new Set(['DNS:localhost', 'IP:127.0.0.1', sanEntry(commonName), ...lanIps().map((ip) => `IP:${ip}`)]),
  ].join(',');
  await runCmd('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-out',
    certPath,
    '-keyout',
    keyPath,
    '-days',
    '3650',
    '-subj',
    `/CN=${commonName}`,
    '-addext',
    `subjectAltName=${san}`,
  ]);

  // openssl writes with the process umask; tighten immediately to close the exposure window.
  await chmod(keyPath, 0o600); // private key: owner-read-only
  await chmod(certPath, 0o644); // cert is public by nature, but not writable by others

  return { cert: certPath, key: keyPath, fingerprint: await certFingerprint(certPath), origin };
}
