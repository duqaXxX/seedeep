# HTTP API

The local server exposes 21 routes: the static page and 20 under `/api/`, across 19 paths, since
only `/api/config` answers to two methods. This document is the
reference for every route, its parameters, its response and its failure modes. The reasoning behind
the design (why the roster is split, why the digest exists, how the watcher feeds any of it) is in
[architecture.md](architecture.md).

## Who this is for, and what is stable

Four endpoints are a **cross-application contract**: the tray is a separate binary that links no
seedeep code and reads only these.

| Endpoint | Read by |
|---|---|
| `GET /api/config` | tray |
| `GET /api/digest` | tray |
| `GET /api/stream` | tray |
| `GET /api/update` | tray |

The other sixteen are consumed by the browser GUI shipped in the same executable. They are
documented here because they are reachable and useful, **not** because they are frozen: treat them
as internal to the GUI and expect them to change with it. There is no `/v1` prefix, no version
negotiation and no deprecation window. The server's version is in `GET /api/config`, and every
deliverable ships from one tag.

## Base URL

`http://127.0.0.1:44842` by default. Naming any other host makes HTTPS mandatory and a token
required, as described in [install.md → remote access](install.md#remote-access).

## Authentication

On loopback there is no authentication: there is no network to authenticate against.

Beyond loopback, every `/api/*` route except `GET /api/config` requires the token, either as a
header or as a query parameter:

```http
Authorization: Bearer <token>
```

```
GET /api/digest?token=<token>
```

The header wins when both are present. The query form exists because `EventSource` cannot set
headers, so `/api/stream` and `/api/replay` have no other way to carry it.

`GET /api/config` is exempt so a client can read the server's version and TLS fingerprint before it
holds a token. It redacts everything that is a credential (see its entry below).

Static files are not protected: they carry no session data.

Missing or wrong token:

```http
401 Unauthorized
content-type: application/json;charset=utf-8

{"error":"unauthorized"}
```

## Errors

The API answers with **two different error shapes**, and which one you get depends on the status:

| Status | Body | When |
|---|---|---|
| `400` | JSON: `{"error":"invalid JSON"}`, `{"error":"port must be a number"}`, `{"error":"host must be a string"}`, and the host/TLS validation messages | a malformed `POST /api/config` body |
| `401` | JSON: `{"error":"unauthorized"}` | no valid token, beyond loopback |
| `404` | **plain text**: `unknown session`, `unknown or ended session`, `no output for that tool`, `no such API call`, `no prompt found`, `not found` | the named session, call or asset does not exist |
| `405` | **plain text**: `method not allowed` | any method other than `GET`, outside the two documented `POST`s |
| `415` | JSON: `{"error":"Content-Type must be application/json"}` | `POST /api/config` without the JSON content type |

A missing required query parameter is not a `400`: the route looks up the empty string, finds
nothing and answers `404`. `GET /api/search` is the exception, where an absent `q` is an empty
query rather than a bad request, and it answers `200` with no rows.

## Caching

Every JSON response and every static asset goes through one path:

- `cache-control: no-cache`, which means revalidate every time and does **not** mean "do not store".
- A strong `etag`. A matching `if-none-match` gets `304` with no body.
- Bodies of **1400 bytes or more** are gzipped when the request accepts it. A compressed body's
  ETag carries a `-gz` suffix, so a strong validator is never shared between two different sets of
  bytes.

## CORS

There are no CORS headers, deliberately: a page on another origin must not be able to read a
session. A browser-based client has to be served by seedeep itself.

## Route index

| Method | Path | Required parameters | Answers |
|---|---|---|---|
| `GET` | `/` | none | the GUI page (any other path serves its asset, else `404`) |
| `GET` | `/api/config` | none | redacted config + server state; **the only route needing no token** |
| `POST` | `/api/config` | JSON body | writes the config file, answers as `GET` does |
| `POST` | `/api/restart` | none | `{"ok":true}`, then hands the port to a successor |
| `GET` | `/api/update` | none | which version is current, and how this install updates |
| `GET` | `/api/sessions` | none | `CatalogueRecord[]`, the roster's stable half |
| `GET` | `/api/live` | none | `LivePayload`, the running sessions |
| `GET` | `/api/digest` | none (`sessionId` optional) | `DigestEntry[]`, or one `DigestEntry` |
| `GET` | `/api/session-stats` | none | turns and tokens per session |
| `GET` | `/api/baseline` | none | `Baseline`, the user's per-turn token baseline |
| `GET` | `/api/retro` | none | `Retrospective`, the corpus retrospective |
| `GET` | `/api/compare` | none | `Comparison`, session weight by time window |
| `GET` | `/api/search` | none (`q` carries the query) | `SearchResponse` |
| `GET` | `/api/stream` | none | SSE, every session, live |
| `GET` | `/api/replay` | `sessionId` | SSE, one session's history |
| `GET` | `/api/tool-output` | `sessionId`, `toolUseId` | `ToolOutput` |
| `GET` | `/api/call-io` | `sessionId`, `callId` | `CallIO` |
| `GET` | `/api/commits` | `sessionId` | `SessionCommits` |
| `GET` | `/api/files` | `sessionId` | `SessionFiles` |
| `GET` | `/api/cards` | `sessionId` | `SessionCards` |
| `GET` | `/api/agent-prompt` | `sessionId`, `agentId` | one workflow member's opening prompt |

Every response shape is an exported TypeScript interface; the table names it where one exists.

---

## The roster

### `GET /api/sessions`

Every discovered session, but only the fields that stop changing once its file exists. Stable, so a
client fetches it once and revalidates with an ETag instead of pulling the whole corpus.

Returns `CatalogueRecord[]` (`core/roster.ts`).

### `GET /api/live`

The handful of sessions actually running, in full. This is the only thing a client polls, about
1 KB against the catalogue's hundreds.

Returns `LivePayload` (`core/roster.ts`): `{ total, sessions, pidVisible }`.

The two halves rejoin client-side: `mergeRoster(catalogue, live)` is the same roster the server
would have produced whole.

Both roster endpoints answer `500` when a session ROOT exists but cannot be read. A `200` listing
zero sessions therefore means the machine has none, never that the scan failed; a client must treat
the `500` as a reading that did not land and keep the rows it already has, since the alternative is
reporting every running session as gone.

One project directory that cannot be read is the case in between, and `LivePayload.complete` is
where it is stated. The reading still lands, and the sessions it lists are correct; what it cannot
support is the opposite reading, that a session it does NOT list is over. `false` therefore means
absence from `sessions` proves nothing. It is not folded into the `500` because an `EACCES` on one
project directory is usually permanent, and refusing the whole roster for as long as those
permissions stand would hide more than it protects.

### `GET /api/session-stats`

Turn count and token total per session, from the aggregate cache.

Returns `Record<sessionId, { turns: number; totalTokens: number }>`. A session the cache has not
folded yet is simply absent, and the object is not padded with zeroes.

---

## One live session

### `GET /api/digest`

The endpoint for a client that does not own the reducer. The server has already reduced: an
entry is derived state, not events to fold.

| Parameter | Required | Meaning |
|---|---|---|
| `sessionId` | no | one session instead of all of them |

- Without it: `DigestEntry[]`, one per live session.
- With it: a single `DigestEntry`, or **`404 unknown or ended session`**. A session that ends leaves
  immediately, and there is no tombstone entry.

Returns `DigestEntry` (`server/digest.ts`): the project and subject, the context block, the model
and effort, the turn's state (`done` | `interrupted` | `live`) and what it is doing now, the
background commands, the subagents, an `error` block when the last call failed, and `waiting` when
the session is stopped on the user.

There is no cap on anything in it: sixteen concurrent agents is a legitimate session, and a client
that draws fewer is making that choice itself.

### `GET /api/stream`

Server-sent events for **every** session, multiplexed. See [the SSE protocol](#the-sse-protocol).

### `GET /api/replay`

One session's history as SSE, then `replay-end`.

| Parameter | Required | Meaning |
|---|---|---|
| `sessionId` | yes | `404 unknown session` if not in the roster |
| `from` | no | resume marks, so as to deliver only what a client has not already seen |

---

## Reading back one thing

These four take a session id and one more identifier. The file path always comes from the roster,
never from the query: a caller can only name a session seedeep already discovered, so no path
outside the corpus is reachable.

### `GET /api/tool-output`

`sessionId` and `toolUseId`, both required.

Returns `ToolOutput` (`server/tool-output.ts`): `{ toolUseId, text, len, truncated }`, the text
capped at 20 000 characters. `404 no output for that tool` when the id names nothing.

### `GET /api/call-io`

`sessionId` and `callId`, both required.

Returns `CallIO` (`server/call-io.ts`): the call's input and output, whether the output carried
tools, its narration, its length, and the model, usage and effort that call ran on. Same 20 000
cap. `404 no such API call`.

### `GET /api/agent-prompt`

`sessionId` and `agentId`, both required.

Returns `{ text, truncated }`, capped at **1000** characters.

It serves workflow members only. The prompt is read from
`<sessionDir>/subagents/workflows/<runId>/agent-<agentId>.jsonl`; an ordinary subagent has no such
file and gets `404 no prompt found`.

### `GET /api/commits`, `GET /api/files`, `GET /api/cards`

Each takes `sessionId`, each answers `404 unknown session`.

- **`/api/commits`** → `SessionCommits` (`core/commit-attribution.ts`): the commits this session
  produced and the forge to link them to. Rules in [session-output.md](session-output.md#commits).
- **`/api/files`** → `SessionFiles` (`core/file-attribution.ts`): the repo files those commits
  delivered, plus the scratchpad files and the artifacts it published, the repo roots they sit
  under, and where the answer came from. Rules in [session-output.md](session-output.md#changed-files).
- **`/api/cards`** → `SessionCards` (`core/tracker-cards.ts`): `{ cards }`, the tracker cards it
  touched, newest touch first. Rules in [session-output.md](session-output.md#tracker-cards).

---

## The corpus

### `GET /api/retro`, `GET /api/baseline`

`Retrospective` and `Baseline` (`core/types.ts`), both folded from the aggregate cache. `/api/baseline`
is exactly the `baseline` that rides along inside `/api/retro`; the small route exists so a client
needing only the baseline does not fetch the retrospective.

### `GET /api/compare`

`Comparison` (`core/types.ts`): session weight per time window, where weight is a token count
weighted by the kind of token and the model that spent it, never a cost in currency.

### `GET /api/search`

| Parameter | Required | Meaning |
|---|---|---|
| `q` | no, in effect | the words; every word narrows. Absent or empty answers `200` with no rows rather than an error |

Returns `SearchResponse` (`core/types.ts`): `{ terms, rows, ms }`. An empty or absent `q` is not an
error, and answers `{"terms":[],"rows":[],"ms":0}`.

What is indexed and how rows are ordered: [search.md](search.md).

---

## seedeep's own state

### `GET /api/config`

The only route that answers without a token, so a client can learn the version and the certificate
fingerprint before it has one.

Returns the configuration with every credential redacted, plus:

| Field | Meaning |
|---|---|
| `version` | the server's version |
| `dev` | present only when authorised: this server runs from source |
| `auth.token` | always `***` |
| `tls.fingerprint` | the SHA-256 of the served leaf certificate; `cert` and `key` paths are not returned |
| `notifications.webhook.url` | `""` when unset, otherwise redacted, since the URL is a credential rather than an address |
| `notifications.webhook.headers` | keys only; every value redacted |
| `restart_pending` | a bound-at-startup setting was changed and needs a restart to take effect |
| `save_pending` | the file on disk differs from what this process is running |
| `overrides` | which fields a CLI flag or an environment variable is overriding, and which |

### `POST /api/config`

Writes the configuration file. Requires `content-type: application/json` (else `415`), a valid JSON
object (else `400`), and values of the right type (else `400` naming the field).

A `***` value means *keep what is stored*, so a client can post back what it read without ever
holding the secret. Answers exactly as `GET` does, so a caller sees the new `restart_pending` and
`save_pending` in the same round trip.

### `POST /api/restart`

Answers `{"ok":true}` and hands the port over to a successor process. A token applies without a
restart; the bound-at-startup settings are the ones `restart_pending` names.

### `GET /api/update`

What npm says is current, from a cache that refreshes once an hour. It is how a REMOTE client, the
tray or the portal in a browser, learns the version of the server it is pointed at. The local CLI
does not use it: `seedeep update` reads the same cache directly, and forces a fetch.

Returns `UpdateStatus` (`server/update-check.ts`) plus:

| Field | Meaning |
|---|---|
| `current` | **this server's** version; a client on another machine compares `latest` against its own |
| `channel` | how this server was installed (`npm`, `download`, `checkout`, …) |
| `command` | what to tell the user to run, or `null` when replacing a file by hand is the answer |

---

## The SSE protocol

`/api/stream` and `/api/replay` both answer `content-type: text/event-stream` with frames of the
same shape:

```
id: <n>
event: <event type>
data: <JSON>

```

The event type is the normalized event's own `type` (see
[architecture.md → normalized event model](architecture.md#normalized-event-model)), plus two the
server adds:

| Event | Meaning |
|---|---|
| `heartbeat` | sent every 15 s on `/api/stream`, because a quiet transcript is indistinguishable from a dead connection. It consumes no `id`, so it never shifts the numbering of the real events |
| `replay-end` | the replay has delivered everything; carries `{ sessionId }` |

There is no `Last-Event-ID` handling and no backlog: a client that reconnects recovers with
`/api/replay?from=`, not by asking the stream to rewind.

### Deduplicating live against replay

Every file-tailed event carries a **`seq`**: a per-file line number, a POSITION rather than a
counter. One `seq` per source line, so a line yielding several events (`usage` + `attribution` +
`tool-start`) shares one.

A client that opens a replay while the live stream is running dedups **per `(sessionId, agentId)`**,
since the parent and each subagent child restart `seq` at 0. Because one line is several events,
that position is three numbers, not one:

| Mark | Meaning | Test |
|---|---|---|
| `covered` | the last line a replay delivered ENTIRE | a live event at or below it is a re-delivery (`seq <=`) |
| `liveMax` | the live frontier, a line possibly delivered only in PART | live drops only what is strictly earlier (`seq <`), so every event of the newest line passes |
| `liveSeen` | how many events of that frontier line arrived | |

A replay in flight is measured against a **snapshot** of that position taken when it opened.
Measuring against a mark the same replay is advancing drops every event of a line after its first.

Events with `seq < 0` are out of band, since a `subagent-meta` read from a sidecar has no line
position, and are exempt from the dedup; the reducer folds them idempotently.

When the tailer re-reads a file from offset 0 (it shrank), `seq` restarts with it. That is a
re-delivery from 0, which the rules above already absorb.
