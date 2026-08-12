# Security policy

## Reporting a vulnerability

Use GitHub's private form: **[Report a vulnerability](../../security/advisories/new)**,
also reachable from the Security tab of this repository. It opens a draft advisory that
only you and the maintainer can read, and it is where a fix and a CVE would be
coordinated from.

**Please don't open a public issue or a pull request for it.** An issue is readable by
everyone the moment it is filed — including for however long the fix takes. The
advisory form is the only private channel this project has; there is no security
mailing address.

Useful in a report: what an attacker gets, and the shortest way you got there. seedeep
runs on a developer's own machine, so *who* the attacker is matters — say whether they
are on the same network, holding a link the user clicks, or sending a pull request.

## What you can expect

seedeep is a personal project maintained by one person outside working hours. There is
**no SLA and no bounty**, and saying so is more honest than an unstated promise.
Realistically: an acknowledgement once I see the advisory, a fix when I understand it,
and credit in the published advisory unless you would rather not be named. If a report
sits untouched for a couple of weeks, a comment on the same advisory is welcome — it
means I missed it, not that I decided against it.

**Only the latest release is supported.** Everything — the server binaries, the six npm
packages, the tray installers — ships from one version tag, so a fix goes out as a new
release and there are no backports.

## In scope

The interesting surface is small, and specific:

- **The server beyond loopback.** On `127.0.0.1` there is no network to authenticate
  against and no auth in the way, by design. Naming any other host makes HTTPS mandatory
  and a bearer token required on every `/api/*` request. Anything that gets session data
  or configuration out of a remote-mode server without the token, that downgrades or
  bypasses the TLS requirement, or that makes the server listen beyond loopback without
  the operator having asked for it.
- **The certificate and the tray's pinning.** The server issues its own self-signed
  certificate and prints its SHA-256 fingerprint on every start; the tray pins one leaf
  certificate in Rust (`apps/tray/src-tauri/src/pin.rs`) because the alternative on that
  stack is disabling verification entirely. Anything that makes a different certificate
  acceptable to a pinned client, or that makes the printed fingerprint disagree with
  what is actually served.
- **The release pipeline.** A tag builds every artifact and publishes to npm through
  trusted publishing (OIDC, in the `npm-publish` environment). Anything that lets code
  which is not in the tagged commit end up inside a published artifact, or that lets a
  workflow be triggered into publishing by someone who cannot push a tag.
- **Your session files leaving the machine.** seedeep reads Claude Code's local session
  logs — your prompts, your file paths, your project names — and never writes them back.
  The only outbound request it makes **on its own** is the update check against
  `registry.npmjs.org`. The one exception is the notification webhook, which is off
  until you configure it and then POSTs to an address you chose yourself
  ([what it sends](docs/install.md#data-flow)) — so a report about it is about seedeep
  sending more than the banner says, or sending it somewhere you did not name. Anything
  that serves a path outside what an endpoint should reach, or that sends session
  content anywhere at all, is exactly the bug worth reporting.

## Not a vulnerability

- **A crash or a wrong number on an unexpected session line.** seedeep parses a log
  format Anthropic owns and changes often; a line it mishandles is a bug, and
  [an issue](../../issues) is the right place for it.
- **The unsigned first-launch warning** on macOS and Windows. The binaries and the tray
  installers are deliberately unsigned for now, and the README says so.
- **The browser's warning on the self-signed certificate.** That is what a self-signed
  certificate is; the fingerprint is printed on every start and shown in the settings
  panel so it can be checked rather than clicked through.
- **An attacker who is already the local user.** seedeep's state lives in `~/.seedeep/`
  and the session logs live in `~/.claude/`, both protected by nothing more than the
  account they belong to. Someone who is already that user can read the sessions
  directly, without seedeep.
