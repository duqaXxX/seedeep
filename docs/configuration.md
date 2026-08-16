# Configuration

Everything seedeep reads at startup and everything the Settings panel writes: one file, one
precedence chain, one security posture. What the endpoints that read and write it look like on the
wire is in [api.md](api.md); what a user types to change any of it is in [install.md](install.md).

seedeep reads its configuration from `~/.seedeep/config.json` (owned entirely by seedeep;
not a Claude Code file). The file is optional — a missing file means all built-in defaults
apply and the first run works without it. A malformed or unreadable file falls back silently
to the defaults without rewriting.

## Schema and defaults

```ts
interface SeedDeepConfig {
  port:   number;   // 44842
  host:   string;   // "127.0.0.1"
  open:   boolean;  // true
  auth: {
    token: string;  // 32-byte base64url, auto-generated on first run
  };
  notifications: {
    // Which events each channel announces.
    tray:    { needsYou: boolean; fails: boolean; finishes: boolean; updates: boolean };
             // true, true, false, true
    webhook: { needsYou: boolean; fails: boolean; finishes: boolean;
               url: string; headers: Record<string, string>; template: string };
             // same three defaults, and OFF until `url` is set — nothing leaves the
             // machine unasked
  };
  tls: {
    commonName?: string; // Required when host is not loopback; no built-in default
    cert: string;        // "~/.seedeep/cert.pem"
    key:  string;        // "~/.seedeep/key.pem"
  };
}
```

## Precedence

CLI flag `>` env var `>` config file `>` built-in default.

| Config field   | CLI flag    | Env var            |
|----------------|-------------|--------------------|
| `port`         | `--port`    | `SEEDEEP_PORT`     |
| `host`         | `--host`    | `SEEDEEP_HOST`     |
| `open`         | `--no-open` | `SEEDEEP_OPEN`     |
| `tls.commonName` | —         | `SEEDEEP_TLS_CN`   |

The `auth.token` is generated automatically (32 random bytes, base64url-encoded) on the
first run when the field is absent or empty, then written back to the config file. It
survives restarts.

## Security model

```text
host = 127.0.0.1 (loopback)  →  plain HTTP, no auth required
host ≠ loopback               →  HTTPS required (self-signed cert, see below)
                                  Authorization: Bearer <token> (or ?token= query param)
                                  on every /api/* request except GET /api/config
                                  401 for missing or wrong token
```

**`127.0.0.1`, `::1`, and `localhost`** are the three loopback values. `0.0.0.0` binds on
all interfaces and is treated as non-loopback (the server is reachable from the LAN).

The decision is made from the **configured host, never from the peer**: with remote access on,
a request arriving from `127.0.0.1` gets TLS and the token check like any other, because the
listener has one certificate and one policy. So "seedeep is on this machine" does not imply "no
credentials needed" — a client on the same machine configures itself exactly like a remote one
(`docs/tray.md`). The 401's body is `{"error":"unauthorized"}`, and that shape is part of the
contract: it is how a client tells a seedeep asking for a token apart from something unrelated
listening on the same port.

## TLS certificate

When `host` is not loopback, seedeep generates a self-signed RSA-2048 certificate with a
10-year validity (3650 days) via `openssl req -x509`. The cert and key are written to
`~/.seedeep/cert.pem` / `~/.seedeep/key.pem`.

`tls.commonName` is required for non-loopback operation. seedeep refuses to start with a
clear error if it is absent.

It must also be a name a certificate can carry — an RFC 1123 hostname or an IPv4 address
(`isValidCertName`, `core/cert-name.ts`). The name is interpolated into openssl's
`subjectAltName=` list, where **a comma starts another entry**: a name carrying one would
quietly produce a certificate covering something else. No shell is involved (`spawn` takes an
argv array, so there is no command injection) and the blast radius is the user's own
certificate — but a silent surprise is worse than a refusal. `POST /api/config` answers 400 and
stores nothing, and `ensureTlsCert` throws as well, because the value also arrives from
`config.json` and `SEEDEEP_TLS_CN`, which no request handler sees. The predicate lives in its own
import-free module because **the browser needs the same one**: a panel that accepts what the
server refuses is worse than no check at all. LIMIT: an IPv6 literal is refused — its colons
cannot be told from the SAN's own `TYPE:value` separator without a full parser.

Surrounding whitespace is refused, not trimmed: openssl trims it while writing the SAN, so a
padded name yields a certificate for the trimmed name while the coverage check asks about the
padded one — the certificate is then judged not to cover its own name and is regenerated on every
start. The invariant that guards it lives in `tls.test.ts`: whatever the predicate accepts, the
certificate generated for it must come back `reused`.

**Everything the server answers on goes in the SAN**, and the `commonName` is the first of
them:

| SAN entry | Why |
|---|---|
| `DNS:localhost`, `IP:127.0.0.1` | the server is still reachable from its own machine |
| the `commonName`, as `DNS:` or `IP:` depending on what it is | it is the address seedeep prints, copies into the Settings panel, and hands to a client |
| **every** non-internal IPv4 address of the machine | one is picked at random on any box with a VPN, Tailscale or Docker |

The `commonName` in the SAN is not a detail: browsers ignore the deprecated CN field, so a name
that is only in `/CN=` is certified by nothing — and **a self-signed certificate hides that**,
because the name error lands inside the trust warning the user has already accepted. IPv4 only: an
IPv6 host is covered by setting `tls.commonName` to the literal, whereas enumerating IPv6 would add
the machine's temporary privacy addresses, which the OS rotates.

#### When the certificate is replaced

A stored pair is **reused** whenever it certifies the current `commonName`, and **replaced**
when it does not — including a file the TLS stack cannot parse, which could not have served a
connection anyway. Coverage is asked of `X509Certificate.checkHost`/`checkIP`, so the answer
follows the same RFC 6125 rules a client applies rather than seedeep's reading of the SAN text.

**The name is the only trigger, never the address set.** Two consequences are the point of that
rule: the addresses change on their own — a VPN coming up is enough — and replacing the
certificate changes its fingerprint, so keying on them would give a pin that fires with the
weather; and a certificate the *user* supplied for their own domain covers its own name, so
seedeep leaves it alone even though it carries no `localhost`.

A replacement invalidates any pin already taken. That is a pin doing its job, not breaking, but
it is the one event a user cannot infer from a new fingerprint they have no old value to compare
against — so `startServer` reports `tlsCertOrigin` and the CLI says so in words, immediately
before printing the new value.

#### The fingerprint

The fingerprint is the SHA-256 of the served **leaf** certificate's DER bytes, formatted `AA:BB:…` —
the same digest and formatting `openssl x509 -in cert.pem -noout -fingerprint -sha256` prints, so it
can be checked with a tool that shares none of seedeep's code. It is RUNTIME state, never written to
`config.json`, and is `null` (the field absent) in loopback mode, where there is nothing to pin.

A browser gets past a self-signed certificate with a one-time click; a non-browser client has to
**pin** it instead, so the value is obtainable three ways:

- **stdout, on every start** in remote mode (`main.ts`), not only on the run that generated the
  file — a value readable once cannot be checked a week later, when the client is actually set up.
- **The Settings panel**, TLS Certificate → Fingerprint, with a Copy button. This is the
  out-of-band channel: read on the machine seedeep runs on, compared on the machine the client
  runs on.
- **`GET /api/config`**, as `tls.fingerprint`. Safe on an unauthenticated endpoint — the
  certificate itself is presented in the clear on every handshake — and a **convenience, not a
  channel of trust**: a fingerprint fetched over the very connection being verified proves nothing
  on its own, which is why the Settings panel exists.

The client-side behaviour — when to show it, what happens on a mismatch — belongs to the tray
(`docs/tray.md`), not here.

## Off-LAN access: seedeep ships no tunnel

Remote mode covers the local network. Reaching seedeep from outside it is deliberately not
seedeep's job — NAT and firewall traversal are solved problems, and re-solving them here would
add a second, weaker security surface next to the token. Two supported shapes:

- **SSH port-forward** — `ssh -L 44842:127.0.0.1:44842 user@host`, with `host` left on loopback.
  The tunnel is the authentication and no certificate is involved; nothing is exposed on any
  interface of the remote machine.
- **An existing VPN or overlay network** — run in remote mode and reach the machine over the
  private address the VPN assigns it. The Bearer token and TLS still apply.

## Browser auth flow

In remote mode, the server prints a startup URL that includes the token:

```text
seedeep watching — https://MacBook-Pro.local:44842/?token=<token>
```

`RunningServer` exposes two URLs: `url` (clean base URL, for programmatic callers and
tests) and `openUrl` (with `?token=` appended in non-loopback mode, used by `main.ts`
to open the browser on first launch).

Opening the URL triggers `initAuth()` (called once at page load in `app.ts`): the token
is extracted from the query string, stored in `localStorage` under `seedeep-token`, and
removed from the URL via `history.replaceState` — so it never appears in browser history
or `Referer` headers. The token persists across browser restarts with no expiry; to
revoke access, generate a new token via Settings → Regen and save.

**`?session=<id>` — the portal's one other URL parameter**, and the seam with the tray, which
hands a session over rather than replicating it (`docs/tray.md`). Applied at boot AFTER the saved
workspace and after the auto-open rule, and it ACTIVATES: it is the only thing on the page the user
did a moment ago, so it outranks both what they were last looking at and a session that happened to
start. Read by `requestedSession` (`client/sessions.ts`), which bounds the value because it reaches
the screen but does NOT check it against a UUID shape — the id format is Claude Code's to change.
An id no session answers to opens nothing, and the parameter is stripped either way, for the same
reason the token is: a reload must not yank the tab back to where one click sent it once. The two
parameters coexist — a tray URL carries both.

All subsequent API calls go through `authFetch`, which reads the token from `localStorage`
and adds `Authorization: Bearer <token>`. SSE connections (EventSource) cannot carry
custom headers, so `AuthEventSource` appends `?token=<token>` to the stream URL instead —
the server accepts the token from either the `Authorization` header or the `?token=` query
parameter on every `/api/*` route except `GET /api/config`.

When the user generates a new token via Regen, the server adopts it immediately, with no restart.
The save handler calls `setToken(pendingToken)` before clearing the pending value, so
`localStorage` stays in sync and subsequent `authFetch` calls continue to work.

## Settings panel

The settings drawer (gear icon in the header) lets the user change configuration without
editing `config.json` directly. It loads on open (`GET /api/config`) and POSTs each change as it is
made.

**It is an editor of the FILE, not a view of the process.** The fields show the configuration as a
start would resolve it right now — `config.json` under this process's flags and environment — and a
save merges the request onto the file **re-read at that moment**, so a save of one field cannot undo
an edit it never mentioned. What stays the process's own is what no edit can change: `version`, the
certificate fingerprint, and `restart_pending` — which is precisely the statement that the file and
the process have diverged.

A value pinned by a CLI flag or an environment variable is shown as the flag sets it, not as the
file says: that is what this server runs and what every restart will keep running. The field stays
editable and still writes — it is the configuration for the day this server starts without the
flag — and `overrides` on the same response names which fields are held and by what (`flag` or
`env`), which the panel prints under each one. Only fields whose override actually DIFFERS from the
file are reported: a flag repeating what the file says overrides nothing anyone can observe.

The `***` redactions (the auth token, the webhook URL and its headers) mean **"keep the stored
value"**, resolved against that same file — the source the panel read them from, so the mask can
only ever put back the value it stood for.

**A broken file is repaired, never overwritten — and a missing one is not a config either.** Reading
it has three outcomes, and `readConfigFile` separates them: `null` when it does not exist, a THROW
when it exists and cannot be parsed, the config otherwise. `readConfig` stays lenient on top of it
(a server must still start on a broken file) and `readConfigStrict` takes the defaults for a missing
one — but a caller that WRITES may take neither shortcut, or built-ins would land on top of the
user's token, port and certificate name on the first save made for any other reason. So `POST
/api/config` merges onto the file only when there IS one that parses, and onto the running config
otherwise. `resolveConfig` carries the same rule to startup: handed `fileIsUsable: false` it
generates a token for that run and writes nothing, so a stray comma costs a regenerated token until
its owner repairs the file, and never the file itself. Every entry point goes through one helper
(`readFileConfig` in `main.ts`), the subcommands included: a command that only reports must not
write.

**The panel has no Save button.** Every control writes as it changes: a toggle on the click, a text
field on `change` — leaving it or pressing Enter — and never on each keystroke, or typing `45999`
would post `4`, then `45`, then `459`. A port the server could not bind is omitted from the body
rather than sent, so an empty field cannot write `port: 0` on the way past.

| Field | Shown when | Behaviour |
|-------|------------|-----------|
| Port | Always | Requires restart |
| Host | Always | `127.0.0.1` = loopback (default), `0.0.0.0` = LAN; requires restart |
| Open browser on start | Always | Toggles `config.open` |
| Notifications — Tray | Always | The four events the menu-bar app may interrupt for. They live in `notifications.tray`, so the tray reads whichever server it is connected to rather than a file of its own |
| Notifications — Webhook | Behind **Send to a webhook…** | URL, headers and body template, plus its own three switches. Empty URL means the channel is off, which is how it ships — nothing leaves the machine unasked. The URL is redacted like the token: for Slack, Discord and ntfy it IS the credential |
| Auth token | Always | Always displayed as `***`; **Regen** generates a new token client-side, and warns that saving it locks out every other client |
| Access URL | Always | Computed live from the current form values; includes `?token=` in remote mode; **Copy** writes the full URL to the clipboard |
| Common name | Remote mode only | The name the certificate certifies; required in remote mode, and refused unless it is a hostname or an IPv4 address — while it is missing or unusable nothing in the panel is written at all. Changing a name that already produced a certificate warns that the certificate — and its fingerprint — will be replaced |
| Fingerprint | Remote mode only | Read-only SHA-256 of the certificate the server is presenting; **Copy** writes it to the clipboard. Server state, so nothing in the panel can change it — a new certificate needs a restart. Empty (placeholder) when the running server has no certificate, i.e. a remote host was typed into the form but not yet restarted into |
| Version (About) | Always | Read-only. The release the RUNNING server reports (`version` on `GET /api/config`), never the number this bundle was built from — a stale `build:client` would otherwise make the portal claim a version the server is not. A server that reports none leaves the dash: this is the one string a bug report quotes verbatim, so a guess here is worse than an admission |

The Access URL field derives its token from (in priority order): the `pendingToken` just
generated by Regen, then the token in `localStorage` (from a prior visit via the startup
URL). In loopback mode no `?token=` suffix is added.

**Two warnings, both conditional**, and no static help text beyond the field sub-labels: the Common
name note appears only when a name that already produced a certificate is being changed (never on
first setup, where nothing is replaced), and the token note only while a regenerated token is
pending. Those are the two actions that break a client on *another* machine, and a warning that
fires when it does not apply is one the user learns to ignore before it ever matters.

Validation is shared, not duplicated: the panel refuses a Common name with the same
`isValidCertName` the server uses, so the field can say why immediately instead of relaying a 400,
and a rejection from `POST /api/config` is reported as the failure it is.

**An invalid Common name reveals the TLS section even in loopback mode** — the only reason that
section is ever shown outside remote mode. The name is still on its way to `config.json`, so it
still blocks every write, and a refusal whose reason sits inside a hidden section is a dead end with
no way out of the panel.

## A restart the process itself knows is due

Three values are BOUND at startup and cannot be revisited by the process holding them: `port`,
`host`, and the certificate's common name. `auth.token` joins them: a save can rotate a token live,
but only one the PANEL generated, because a token edited straight into `config.json` is never in a
request — the panel reads it redacted and posts `***`. A restart is what applies that one.

`open` is in neither state: it is spent the moment the browser opened, so nothing can apply it, and
announcing it would teach the reader to ignore the announcement.

**Two states, because there are two cures.** `save_pending` holds the notification settings the
panel has IN CLEAR — every switch and the webhook's template — which is exactly what pressing
**Apply now** re-posts. Everything the panel is shown REDACTED goes to `restart_pending` instead:
the auth token, the webhook's address and its headers. The panel posts `***` for each and the merge
resolves that back to the value already there, so a state raised on one of them could not be cleared
by the button offering to clear it.

**Apply now reloads before it posts.** The banner can arrive from the background refresh with the
drawer already open, and that path leaves the form alone so it cannot wipe out half-typed input — so
posting the fields as they stand would write the user's own change back out. Reloading first is also
what the button means: apply what the file says.

**`restart_pending` compares two `applyPrecedence` results, never the file.** Configuration arrives
through a four-layer chain (CLI flags → env → file → defaults), and `POST /api/restart` respawns
with `process.argv.slice(2)` intact, so a server started with `--port 9000` goes on ignoring the
file's port after every restart — comparing against the file alone would light a permanent signal no
button could clear. The two sides are what this process resolved at startup and what a fresh start
would resolve to now: the same flags and the same environment, over `config.json` re-read at request
time. Both go through the one function, so they cannot drift apart.

- It is recomputed per request and never cached — a cached answer is how a file edited in an editor
  stays invisible.
- It rides `GET /api/config`, so every surface reads one verdict: the portal (a dot on the
  Settings button, a banner in the drawer, the `Restart now` button), the tray (a line above the
  bands, asked when the popover opens), and `seedeep status` (a line under `serving`). The dot is
  ONE mark for both states — it is the only thing visible with the drawer closed, and two dots on
  one button could not be told apart; which state it is belongs to the drawer, whose job the dot is
  to get opened.
- `POST /api/config` derives its answer from the same comparison, taken AFTER the write, never from
  a diff of the request. A save that puts a value back to what is already running reports nothing;
  a save landing on top of an earlier hand edit keeps the signal up.

A token generated in the panel takes effect immediately, with no restart.

## Config endpoints

| Method | Path | Auth required | Purpose |
|--------|------|---------------|---------|
| `GET`  | `/api/config` | Never | The configuration a start would resolve to now — `config.json` under this process's flags and environment, never the copy it is holding (token redacted as `"***"`, `tls.cert`/`tls.key` omitted, `tls.fingerprint` added in remote mode) — plus `version` and `restart_pending`, which are runtime state, not config: both describe the process answering and neither is written back to `config.json`. It rides this route because the version has to be readable before anything else is, which on a remote host means before a token exists. The exemption goes no further than that: `dev` is withheld from an unauthenticated caller (see *Which build is answering*) |
| `POST` | `/api/config` | On non-loopback | Partial merge onto `config.json` **re-read at that moment** + atomic write, so a save cannot undo an edit it never mentioned; the runtime copy takes the same merge for what applies without a restart. Returns the redacted config read back + `restart_pending`, never a diff of the request (see *A restart the process itself knows is due*) |

## Resetting

`rm -rf ~/.seedeep/` removes all seedeep-owned state: the config, the certificate and its key, the
aggregate cache, the two indexes (`search-index.jsonl`, `cards-index.jsonl`), the update-check
cache, the per-process records under `servers/`, and `server.log`. seedeep rebuilds everything from
scratch on the next run — every byte of it is derived from transcripts seedeep does not own.

## Moving it: `SEEDEEP_HOME`

Everything above lives under **one** directory, and `seedDeepDir()` is the only code that knows its
name — `SEEDEEP_HOME` moves everything under it together, not the config alone. That is the point:
half a relocation is worse than none, since a run whose config moved but whose caches did not still
rewrites the other copy's index, and the symptom (a corpus rebuilt on every start) names nothing. A
test enumerates the paths, and a second one fails if any other module ever spells `'.seedeep'`
itself.

It exists so a checkout can run beside an installed release — `bun run dev` sets it, and
CONTRIBUTING.md explains when that matters. The damage it prevents does not need the two to run at
once: a dev run that changes the port from the settings panel is what the installed server reads on
its next start. A relative value is resolved against the process's cwd, so a dev script can point it
inside the checkout. Unset for a user, which is every release.

**The tray answers to the same variable**, and to no other: it keeps its own two files in
`<SEEDEEP_HOME>/tray`, so one name selects a whole world — this server and the tray watching it. A
GUI app inherits no shell environment, which is what makes the installed tray the installed world
with nothing to configure ([`tray.md`](tray.md#running-it)).

## Which build is answering

`GET /api/config` carries **`dev`**: true when the server is a checkout, false when it is a released
executable. The portal reads it once at load and, when it is true, renames the tab to *seedeep dev*
and puts a chip beside the brand (`client/build-mark.ts`). A release shows nothing — a badge every
install carries is a badge nobody reads.

The same response carries **`version`**, and unlike the chip the brand states it on **every**
portal, in muted monospace right of the wordmark: it is not a badge but a fact, and it is the one
number a bug report quotes — the settings panel still holds it, but reading it there is a panel you
have to go open. On a checkout both marks show, version first — `seedeep 0.12.0 dev`. It is the
release the SERVER reported and never a constant compiled into the bundle: `public/lib/` is a build
artifact, so a stale `build:client` would otherwise print a version nothing is running. A server too
old to report one draws nothing at all — a dash beside the wordmark reads as a broken page, and this
is the value that must never be guessed.

It exists because the two seedeeps on a machine are **indistinguishable by their content**: the
sessions come from `~/.claude/projects`, which belongs to Claude Code, so a dev portal and an
installed one list exactly the same work. Everything else is separate — config, certificate, token,
caches, records — and none of that is on screen.

**Only to a caller that has authenticated.** `GET /api/config` answers without a token, but that
exemption was granted for one reason — the version has to be readable before a token exists — and
`dev` is not in that class: nothing needs it before authenticating, and it is the only field here
that tells a stranger something about the operator's machine they could not already know (host and
port are what they used to arrive). On loopback there is no token to present and nothing to prove,
so the mark is simply there; in remote mode the portal reads it through `authFetch` and the chip is
unaffected.

The signal is **`Bun.embeddedFiles.length === 0`** (`server/version.ts`). That is Bun's own answer to
"am I a standalone binary": every file compiled in with `with { type: 'file' }` is in it, and there
are none when the same code runs from source. Preferred over testing an asset path for `/$bunfs/`,
an internal spelling that differs on Windows and would make the answer a guess there. And
deliberately not `SEEDEEP_HOME`: moving your state is not declaring yourself a developer.
