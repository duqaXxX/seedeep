/**
 * What a `tls.commonName` may be — ONE definition, because both the server and the browser need
 * it and two copies drift into a panel that accepts what the server refuses.
 *
 * Deliberately import-free: this module is bundled into the browser client, so it cannot reach
 * `node:net`. That is also why IPv4 needs no special case — a dotted-quad is already a valid
 * hostname shape (digits are legal label characters), and the SAN entry's `DNS:`-vs-`IP:` typing
 * is a separate question answered server-side by `node:net`'s `isIP`.
 */

// RFC 1123: dot-separated labels of letters, digits and hyphens; no leading or trailing hyphen;
// 1–63 characters each. The total length bound is checked separately — a regex that also counted
// would be unreadable for no gain.
const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/**
 * Whether `name` can be put in a certificate as the name seedeep is reached by.
 *
 * Strict on purpose: the name is interpolated into openssl's `subjectAltName=` list, where a
 * comma starts another entry. The blast radius is only the user's own certificate — no shell is
 * involved, `spawn` takes an argv array — but a name that silently produces a certificate for
 * something else is worse than a refusal.
 *
 * Surrounding whitespace is REFUSED rather than trimmed, and that is not pedantry: openssl trims
 * it while writing the SAN, so a padded name produced a certificate for the trimmed name and then
 * failed the coverage check against the padded one — judged not to cover its own name and
 * regenerated on every single start, with a new fingerprint each time. One normalisation fewer is
 * one divergence fewer. The panel trims before it ever asks.
 *
 * LIMIT: an IPv6 literal is refused, because its colons cannot be told from the SAN's own
 * `TYPE:value` separator by anything short of a full IPv6 parser. seedeep's certificates never
 * enumerate IPv6 either (`lanIps` is IPv4-only), so remote mode needs a name or an IPv4 address.
 */
export function isValidCertName(name: string): boolean {
  if (!name || name.length > 253) return false;
  return name.split('.').every((label) => LABEL.test(label));
}
