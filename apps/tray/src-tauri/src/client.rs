//! The tray's only way of learning anything: one endpoint, one pinned certificate, one stored
//! connection.
//!
//! Three cases have to work, and the third is the one the card originally got wrong. A server in
//! its default loopback mode needs no configuration at all. A server on another machine needs the
//! URL the portal's Settings panel copies. And a server on THIS machine with remote access
//! configured behaves like the second case, not the first — `startServer` decides TLS and auth
//! from the host it was configured with, never from the peer, so `127.0.0.1` speaks HTTPS and
//! demands the token too. The tray tells that apart from "no server here" by the 401 it gets back,
//! so the panel can name what it found instead of shrugging.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use reqwest::header::{ETAG, IF_NONE_MATCH};
use reqwest::{Client, StatusCode};
use tokio::time::timeout;
use serde::Serialize;
use serde_json::Value;

use crate::connection::{self, Connection, DEFAULT_PORT};
use crate::local::{self, LocalServer};
use crate::pin::pinned_tls;

/// The one endpoint the tray reads on its clock. Everything it shows, the server already reduced
/// (`docs/tray.md`).
const DIGEST_PATH: &str = "/api/digest";

/// The server's event stream. The tray subscribes to it for notifications ONLY — the bands still
/// come from the digest poll, which is a snapshot and not a sequence of events.
const STREAM_PATH: &str = "/api/stream";

/// How much of a partial SSE frame is held before giving up on the stream. A frame is a line of
/// JSON; anything approaching this is a server that stopped writing blank lines, and growing the
/// buffer for it would trade a dropped stream for unbounded memory.
const SSE_BUFFER_MAX: usize = 1 << 20;

/// How long the notification stream may say nothing before it is treated as dead.
///
/// The server writes a keepalive every 15s (`HEARTBEAT_MS`), so this is two of them plus room for a
/// slow one. Shorter would reconnect over an ordinary hiccup; longer would leave the tray silent
/// through a sleep, which is the failure this exists to bound.
const STREAM_SILENCE: Duration = Duration::from_secs(35);

/// The endpoint that names the server's own release and whether it is honouring the configuration
/// on disk. Read when the settings view is opened, and once more each time the popover is — never
/// on the poll: the version cannot change while a process lives, and the pending state moves only
/// when a human edits `config.json` or saves the panel, so a request a second would buy nothing.
const CONFIG_PATH: &str = "/api/config";

/// The version npm calls latest, as the server cached it. Read on its own slow clock (`poll.rs`),
/// never with the digest: the server answers it from a file that changes once an hour, so asking it
/// at the digest's cadence would be a request a second for a value that moves daily.
const UPDATE_PATH: &str = "/api/update";

/// A whole request, handshake included. Long enough for a busy server to answer, short enough that
/// a panel does not look frozen while a probe finds nothing.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

/// Just the connect. A closed port refuses instantly; this bounds the case that does not — an
/// address that is routed but silent, which is what a machine that went to sleep looks like.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);

/// What the panel has to render. One variant per state a user can actually be in, because a
/// boolean "connected" would leave the three failures that need different words looking alike.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Status {
    /// Reachable and authorised. `fingerprint` is null for a plaintext server, which has none.
    Connected {
        base_url: String,
        fingerprint: Option<String>,
    },
    /// A certificate was learned and is waiting for the user to confirm it against the value the
    /// server prints. Not stored yet: trust-on-first-use without the confirmation is trust in
    /// whoever answered first.
    AwaitingTrust {
        base_url: String,
        fingerprint: String,
    },
    /// The server presented a different certificate than the pinned one. Both values, so the user
    /// can compare the new one with what the server prints on start — the check that tells a
    /// certificate the user replaced apart from one somebody else is offering.
    PinMismatch {
        base_url: String,
        pinned: String,
        presented: String,
    },
    /// Reachable, and it refused the token we hold.
    Unauthorized { base_url: String },
    /// A stored server that is not answering — almost always one that is simply not running.
    Offline { base_url: String, detail: String },
    /// Nothing stored and nothing to adopt. `local_remote` distinguishes the case where a seedeep
    /// IS running here but with remote access on, so the panel can say so instead of implying
    /// there is nothing to connect to.
    NeedsUrl { local_remote: bool },
}

/// One reading of the server, for the panel and for the icon: where the connection stands, and the
/// digest if it could be read.
///
/// The two travel together because they are one fact — a panel that took them from two calls could
/// draw sessions under a footer naming a server it had just lost, and the icon would be deciding
/// from a different reading than the rows.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reading {
    pub status: Status,
    /// The digest as the tray sees it — every interactive session, the headless runs already
    /// filtered out (see [`only_interactive`]) — or null: every status but [`Status::Connected`]
    /// has nothing to show, and an empty list is a claim about the machine — "nothing is running" —
    /// that a tray which could not read must not make.
    pub entries: Option<Value>,
}

/// What `/api/update` says: the SERVER's own version, npm's newest, and the server's own verdict
/// on whether it is behind. Only `server_behind` is a comparison, and the server made it.
#[derive(Debug, Clone)]
pub struct UpdateStatus {
    /// The version the connected server is running, or `None` when it did not say.
    pub server: Option<String>,
    /// npm's newest, or `None` when the registry has never been reached.
    pub latest: Option<String>,
    /// Whether the SERVER is behind npm — computed by the server, about itself.
    pub server_behind: bool,
    /// The one command that updates THAT server, as it reported it. `None` for a channel with no
    /// single command (a downloaded file) or a server too old to say.
    pub command: Option<String>,
    /// How that server was installed, when it said — the only way to tell those two `None`s apart.
    pub channel: Option<String>,
}

/// How far one attempt got. Separate from [`Status`] because an attempt is about one target, while
/// a status is about the tray.
#[derive(Debug)]
enum Reached {
    /// The digest came back, and it was a digest.
    Ok,
    /// seedeep's own 401 — a server that wants a token we do not have, or have wrong.
    Unauthorized,
    /// The handshake was refused by the pin. Carries BOTH values: the panel's whole job in this
    /// case is to show them side by side, and a variant holding only one would have to invent the
    /// other.
    WrongCertificate { pinned: String, presented: String },
    /// No listener, no answer in time, or an answer that was not seedeep's.
    Unreachable(String),
}

struct Attempt {
    client: Client,
    /// The fingerprint the handshake saw — `None` for a plaintext target, which has no certificate.
    presented: Option<String>,
    reached: Reached,
}

/// The tray's connection: what is stored, what is currently working, and what is one confirmation
/// away from being stored.
pub struct Conn {
    store: PathBuf,
    /// The servers running on THIS machine, which announce the address they answer on. Read only
    /// when nothing is stored — see {@link Conn::status}.
    local: Arc<LocalServer>,
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    /// The target that answered, with the client that reached it — kept so a 1 s poll reuses one
    /// connection pool instead of completing a handshake per tick.
    active: Option<(Connection, Client)>,
    /// A fingerprint the user has been shown and has not yet accepted. Held in Rust, not handed to
    /// the webview and back, so the panel can only confirm what was actually presented to it.
    pending: Option<Connection>,
    /// The last digest and the validator it came with, so an unchanged one costs a 304 and no body.
    /// Belongs to `active` and is dropped with it: a value kept across servers would be answered
    /// from the wrong machine if two ever tagged a response the same way.
    cached: Option<(String, Value)>,
}

/// Where an announced record sits in the order the tray tries them: the DEFAULT port first, then
/// ascending.
///
/// A rule and not `read_dir`'s order, which has none — two records under one home is `seedeep`
/// beside `seedeep --port 9000` (README), and which of them the tray adopted depended on the
/// filesystem and could differ between two launches. The default first keeps reading the records
/// purely additive: they decide only where the plaintext guess used to find nothing at all.
fn adoption_order(base_url: &str) -> (bool, Option<u16>) {
    let port = local::port_of(base_url);
    (port != Some(DEFAULT_PORT), port)
}

impl Conn {
    /// A connection layer that stores itself at `store` (`<app config dir>/connection.json`), and
    /// asks `local` where the servers on this machine are before guessing a port.
    pub fn new(store: PathBuf, local: Arc<LocalServer>) -> Self {
        Self {
            store,
            local,
            inner: Mutex::new(Inner::default()),
        }
    }

    /// Find the server and say what state the panel is in. Cheap enough to call on every open: one
    /// request when a connection is stored, at most two when the tray is looking for a local one.
    pub async fn status(&self) -> Status {
        if let Some(stored) = connection::load(&self.store) {
            return self.judge(stored).await;
        }
        // Nothing stored, so ASK the machine before guessing at it. A server running here has
        // already said where it answers — the record it keeps while it runs (`local.rs`) — and that
        // is the only way one on any address but the default is ever found without the user pasting
        // a URL. `seedeep --port 9000` is in the README, and until this it left the panel saying
        // there was nothing to connect to.
        let mut local_remote = false;
        let mut records = self.local.running();
        // Ordered, because `read_dir` is not: two records under one home is `seedeep` beside
        // `seedeep --port 9000` (README), and which of them the tray adopted depended on the
        // filesystem and could differ between two launches. The default port first keeps this
        // purely additive — the records decide only where the plaintext guess below used to find
        // nothing at all.
        records.sort_by_key(|r| adoption_order(&r.base_url));
        for record in records {
            let target = Connection {
                base_url: record.base_url,
                fingerprint: None,
                token: None,
            };
            match attempt(&target).await {
                // Adopted only when the record is PLAINTEXT. Nothing is pinned here
                // (`fingerprint: None` is learning mode, `pin.rs`), so an `https://` record would
                // be trusted on sight — the confirmation `connect` exists to refuse to skip. A real
                // seedeep never reaches this arm (TLS means a configured non-loopback host, which
                // means a token, which answers 401), so the guard costs nothing and closes the door
                // on a record no seedeep on this machine wrote.
                Ok(Attempt {
                    client,
                    reached: Reached::Ok,
                    ..
                }) if local::is_plaintext(&target.base_url) => return self.activate(target, client),
                // Answering, and refusing us: a seedeep here with remote access on. Its credentials
                // are in the file it wrote them in, and a live record has just proved it is this
                // machine's — so they are asked for rather than asked OF THE USER, who would
                // otherwise be sent to copy a URL from a portal on "the machine running seedeep",
                // which is this one. See `LocalServer::credentials` for why that is legitimate.
                //
                // Not stored: the config is the source of truth and is re-read whenever nothing is
                // stored, so persisting would only put a second copy of a secret on disk — the same
                // reasoning that keeps the default loopback connection out of the store.
                Ok(Attempt {
                    reached: Reached::Unauthorized,
                    ..
                }) => {
                    local_remote = true;
                    if let Some(known) = self.local.credentials() {
                        let owned = Connection {
                            base_url: target.base_url.clone(),
                            fingerprint: known.fingerprint,
                            token: known.token,
                        };
                        if let Ok(Attempt {
                            client,
                            reached: Reached::Ok,
                            ..
                        }) = attempt(&owned).await
                        {
                            return self.activate(owned, client);
                        }
                    }
                }
                _ => {}
            }
        }
        // Zero configuration, the common case: a seedeep in its default loopback mode, which has
        // neither TLS nor a token. Still tried after the records, for the server whose announcement
        // never landed — the write is a courtesy that never fails a start.
        let local = Connection::local_plaintext();
        if let Some(status) = self.judge_if_ok(&local).await {
            return status;
        }
        // Nothing plaintext. Before saying "nowhere to connect", ask whether the silence is a
        // seedeep with remote access on: it answers its own 401 on loopback too. Skipped when a
        // record already told us so, which also covers the one on a non-default port.
        if !local_remote {
            local_remote = matches!(
                attempt(&Connection::local_tls()).await,
                Ok(Attempt {
                    reached: Reached::Unauthorized,
                    ..
                })
            );
        }
        Status::NeedsUrl { local_remote }
    }

    /// Try the URL the user pasted. A server with a certificate comes back as
    /// [`Status::AwaitingTrust`] and is NOT stored until [`Conn::trust`] — the fingerprint has to
    /// be confirmed against the one the server prints before it becomes an identity.
    pub async fn connect(&self, pasted: &str) -> Result<Status, String> {
        let mut target = connection::parse_pasted(pasted)?;
        // A pin belongs to the SERVER, not to the act of pasting. Without this, re-pasting a URL —
        // which is exactly what a rotated token asks the user to do — would drop back into learning
        // mode, and a certificate that had CHANGED would be offered as a first sighting instead of
        // as the mismatch it is. The one screen that shows both values would be bypassed by the
        // one flow most likely to be used while under attack.
        if let Some(stored) = connection::load(&self.store) {
            if stored.base_url == target.base_url {
                target.fingerprint = stored.fingerprint;
            }
        }
        let Attempt {
            client,
            presented,
            reached,
        } = attempt(&target).await?;
        match reached {
            Reached::Ok => match (&presented, &target.fingerprint) {
                // Already pinned, and it held: there is nothing new to confirm. The token may well
                // be new, so it is still worth storing.
                (Some(_), Some(_)) => {
                    connection::save(&self.store, &target)
                        .map_err(|e| format!("Could not store the connection: {e}"))?;
                    Ok(self.activate(target, client))
                }
                (Some(fingerprint), None) => {
                    let fingerprint = fingerprint.clone();
                    self.inner.lock().unwrap().pending = Some(Connection {
                        fingerprint: Some(fingerprint.clone()),
                        ..target.clone()
                    });
                    Ok(Status::AwaitingTrust {
                        base_url: target.base_url,
                        fingerprint,
                    })
                }
                // A plaintext server has no certificate, so there is nothing to confirm and
                // nothing to pin — but a non-default address is still worth remembering, or the
                // next start would go back to guessing 44842.
                (None, _) => {
                    if !target.is_default_local() {
                        connection::save(&self.store, &target)
                            .map_err(|e| format!("Could not store the connection: {e}"))?;
                    }
                    Ok(self.activate(target, client))
                }
            },
            Reached::Unauthorized => Err(
                "That server refused the token in the URL. Copy the URL again from the portal's Settings → Remote access."
                    .into(),
            ),
            // Reachable only for an already-pinned server, and then it is news the user has to see
            // in full rather than a one-line error: the same screen `status` would have shown.
            Reached::WrongCertificate { pinned, presented } => {
                Ok(self.stage_mismatch(target, pinned, presented))
            }
            Reached::Unreachable(detail) => {
                Err(format!("Could not reach {}: {detail}", target.base_url))
            }
        }
    }

    /// Accept the fingerprint the panel last showed — a first connect or a replaced certificate,
    /// which are the same act: the user confirming a value they can read off the server.
    ///
    /// Stores it, then connects AGAIN with the pin in force, so "Connected" is a claim proven
    /// under the pin rather than under the learning mode that produced the value.
    pub async fn trust(&self) -> Result<Status, String> {
        let pending = self
            .inner
            .lock()
            .unwrap()
            .pending
            .clone()
            .ok_or("There is no certificate waiting to be trusted.")?;
        connection::save(&self.store, &pending)
            .map_err(|e| format!("Could not store the connection: {e}"))?;
        // Cleared only now: taking it first would mean a failed write left the panel showing a
        // fingerprint whose button had quietly stopped working.
        self.inner.lock().unwrap().pending = None;
        Ok(self.judge(pending).await)
    }

    /// One reading for the panel and the icon: the connection's state and the digest, together.
    ///
    /// Called on a clock, so the shape of it is about a server that comes and goes rather than about
    /// the happy path: an active connection costs one request, and a connection that has stopped
    /// answering is dropped and the whole discovery re-run, which is what makes a restarted server
    /// heal on the next tick instead of on the next time somebody reopens the panel.
    /// Subscribe to the server's event stream and hand every notification to `on`.
    ///
    /// Returns when the stream ends or the connection drops — reconnecting is the caller's, on the
    /// backoff the poll already has. A reconnect replays nothing: the server RE-SEEDS when a
    /// subscriber arrives, exactly as the tray used to re-seed on its own first reading.
    ///
    /// Its own client, because the polling one is built with a 5 s request timeout that would cut a
    /// stream every five seconds. Same pin, same `no_proxy`, same redirect policy: a stream is the
    /// one long-lived connection this tray keeps, and it must be as narrowly scoped as the others.
    pub async fn stream_notifications(&self, mut on: impl FnMut(Announcement)) -> Result<(), String> {
        let Some((target, _)) = self.active() else {
            return Err("no active connection".to_string());
        };
        let (tls, _seen) = pinned_tls(target.fingerprint.clone()).map_err(|e| format!("TLS: {e}"))?;
        let client = Client::builder()
            .tls_backend_preconfigured(tls)
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(CONNECT_TIMEOUT)
            .build()
            .map_err(|e| format!("client: {e}"))?;
        let mut req = client.get(format!("{}{STREAM_PATH}", target.base_url));
        if let Some(token) = &target.token {
            req = req.bearer_auth(token);
        }
        let mut res = req.send().await.map_err(|e| describe(&e))?;
        if !res.status().is_success() {
            return Err(format!("stream refused: HTTP {}", res.status()));
        }
        // Frames arrive split across chunks at arbitrary boundaries, so the tail of a partial frame
        // has to survive into the next read. Bounded by SSE_BUFFER_MAX: a server that never sends a
        // blank line must not grow this without limit.
        let mut buf = String::new();
        // Bounded, because a half-open connection never errors: a laptop that slept, a Wi-Fi that
        // changed, a NAT that dropped the flow without a FIN all leave `chunk()` waiting until the
        // OS gives up — minutes or hours — while the icon keeps updating from the separate poll, so
        // nothing looks wrong and no banner ever appears again. The server writes a keepalive every
        // 15s, so silence past two of them is a stream that is gone; returning lets `subscribe`
        // reconnect, and the server re-seeds rather than replaying.
        loop {
            let next = timeout(STREAM_SILENCE, res.chunk())
                .await
                .map_err(|_| "stream went silent".to_string())?
                .map_err(|e| describe(&e))?;
            let Some(chunk) = next else { break };
            buf.push_str(&String::from_utf8_lossy(&chunk));
            if buf.len() > SSE_BUFFER_MAX {
                return Err("stream frame exceeded the buffer".to_string());
            }
            while let Some(end) = buf.find("\n\n") {
                let frame = buf[..end].to_string();
                buf.drain(..end + 2);
                if let Some(a) = parse_notification(&frame) {
                    on(a);
                }
            }
        }
        Ok(())
    }

    pub async fn read(&self) -> Reading {
        if let Some((target, client)) = self.active() {
            match self.fetch(&client, &target).await {
                Ok(entries) => {
                    return Reading {
                        status: connected(&target),
                        entries: Some(entries),
                    }
                }
                Err(_) => self.deactivate(),
            }
        }
        // Whatever is stopping us — and it may be nothing at all, if the server has just come back.
        let status = self.status().await;
        let Some((target, client)) = self.active() else {
            return Reading { status, entries: None };
        };
        match self.fetch(&client, &target).await {
            Ok(entries) => Reading {
                status,
                entries: Some(entries),
            },
            // It answered the discovery and not the read, one request apart. Reported as
            // unreadable rather than as connected-with-nothing-live: an empty digest is a claim
            // about the machine, and this is not one we can make.
            Err(detail) => {
                self.deactivate();
                Reading {
                    status: Status::Offline {
                        base_url: target.base_url,
                        detail,
                    },
                    entries: None,
                }
            }
        }
    }

    /// One conditional GET of the digest, and the only place a digest is read.
    ///
    /// The validator is the point: this client asks the same URL every second forever, and the
    /// server already tags every response (`sendCacheable`), so an unchanged digest comes back as a
    /// 304 with no body at all. On a LAN that is the difference between polling and streaming a
    /// payload nobody needed.
    async fn fetch(&self, client: &Client, target: &Connection) -> Result<Value, String> {
        let cached = self.inner.lock().unwrap().cached.clone();
        let res = request(client, target, cached.as_ref().map(|(tag, _)| tag.as_str()))
            .await
            .map_err(|e| describe(&e))?;
        if res.status() == StatusCode::NOT_MODIFIED {
            // Only reachable when a validator was sent, so there is a value to answer with. A 304
            // without one is a server we do not understand, and saying so beats inventing a digest.
            return cached
                .map(|(_, value)| value)
                .ok_or_else(|| "The server answered 304 with nothing cached.".to_string());
        }
        if !res.status().is_success() {
            return Err(format!("The server answered {}.", res.status()));
        }
        let etag = res
            .headers()
            .get(ETAG)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let value = only_interactive(
            res.json::<Value>()
                .await
                .map_err(|e| format!("The digest was not JSON: {e}"))?,
        );
        if let Some(etag) = etag {
            self.inner.lock().unwrap().cached = Some((etag, value.clone()));
        }
        Ok(value)
    }

    /// Which release the connected server is, or `None` when there is nothing to ask or it did not
    /// say.
    ///
    /// The tray and the server leave one tag together and are updated apart, so the two numbers can
    /// legitimately differ and the settings view shows both rather than implying one. `None` is a
    /// section that draws nothing, never a guess: a server too old to carry the field would
    /// otherwise be reported as the tray's own version.
    pub async fn server_version(&self) -> Option<String> {
        let (target, client) = self.active()?;
        // The endpoint needs no token even on a remote server, but the header costs nothing and
        // keeps every request this client makes look the same to a server's log.
        let mut req = client.get(format!("{}{CONFIG_PATH}", target.base_url));
        if let Some(token) = &target.token {
            req = req.bearer_auth(token);
        }
        let body = req.send().await.ok()?.json::<Value>().await.ok()?;
        body.get("version")
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
            .map(str::to_string)
    }

    /// Whether the connected server is bound to a port, host or certificate name that `config.json`
    /// no longer asks for — the server's own comparison, never the tray's.
    ///
    /// The tray cannot compute this: the answer depends on the flags and the environment that
    /// server was started with, which are not readable from another process, let alone from another
    /// machine. `false` for a server too old to carry the field, which is the same thing it says
    /// about a server with nothing pending — the tray states a problem it was told about, and
    /// never one it inferred.
    pub async fn restart_pending(&self) -> bool {
        let Some((target, client)) = self.active() else {
            return false;
        };
        let mut req = client.get(format!("{}{CONFIG_PATH}", target.base_url));
        if let Some(token) = &target.token {
            req = req.bearer_auth(token);
        }
        let Ok(res) = req.send().await else { return false };
        let Ok(body) = res.json::<Value>().await else {
            return false;
        };
        body.get("restart_pending")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }

    /// What the connected server's update check found — about ITSELF and about npm.
    ///
    /// `standing` is the server comparing its own version with npm's, which is exactly the question
    /// the tray needs answered (the maintainer's call, 2026-08-05: the notification is about the SERVER, the
    /// thing you actually run, not about the tray). `None` when nothing is connected or the server
    /// is too old to answer.
    pub async fn update_status(&self) -> Option<UpdateStatus> {
        let (target, client) = self.active()?;
        let mut req = client.get(format!("{}{UPDATE_PATH}", target.base_url));
        if let Some(token) = &target.token {
            req = req.bearer_auth(token);
        }
        let body = req.send().await.ok()?.json::<Value>().await.ok()?;
        let str_of = |k: &str| {
            body.get(k)
                .and_then(Value::as_str)
                .filter(|v| !v.is_empty())
                .map(str::to_string)
        };
        Some(UpdateStatus {
            command: str_of("command"),
            channel: str_of("channel"),
            // The SERVER's own comparison, made by the server about itself. The tray does not redo
            // it: `standing` is the one place that answer is computed, and a second implementation
            // here could disagree with what the portal shows for the same machine.
            server_behind: body.get("standing").and_then(Value::as_str) == Some("behind"),
            server: str_of("current"),
            latest: str_of("latest"),
        })
    }

    /// The address the tray is connected to, or `None` when it is not.
    ///
    /// Used to aim a stop at a process: the local layer matches it against the records on disk, so
    /// what is stopped is always the server the panel is showing.
    pub fn base_url(&self) -> Option<String> {
        self.active().map(|(target, _)| target.base_url)
    }

    /// The port a Start has to come up on: the one the stored address names, or `None` when nothing
    /// is stored and the server's own config decides.
    ///
    /// Read from the STORE rather than from the active connection, because Start is offered exactly
    /// when nothing is answering — there is no active connection to ask. `None` is never the default
    /// port by accident: a default-local connection is not stored at all
    /// ({@link Connection::is_default_local}), so "nothing stored" and "the default" are the same
    /// case and both mean "let the config decide".
    pub fn start_port(&self) -> Option<u16> {
        local::port_of(&connection::load(&self.store)?.base_url)
    }

    /// The portal's URL for one session — where a click on a row goes — or the portal's own home
    /// when `session_id` is `None`, which is where the footer's address and the empty state go.
    /// `None` when nothing is connected, which is also when neither can be on screen to click.
    ///
    /// The token rides in the query because that is the form the portal's own Settings panel hands
    /// out and the form its `auth.ts` consumes; a plaintext loopback server has none. Nothing is
    /// percent-encoded because nothing here needs it: a session id is a UUID and the token is 32
    /// bytes of base64url (`core/config.ts`), both entirely within the unreserved set.
    pub fn portal_url(&self, session_id: Option<&str>) -> Option<String> {
        let (target, _) = self.active()?;
        let mut query: Vec<String> = Vec::new();
        if let Some(id) = session_id {
            query.push(format!("session={id}"));
        }
        if let Some(token) = target.token.as_ref() {
            query.push(format!("token={token}"));
        }
        let query = if query.is_empty() {
            String::new()
        } else {
            format!("?{}", query.join("&"))
        };
        Some(format!("{}/{query}", target.base_url))
    }

    /// One attempt at a known target, turned into what the panel shows.
    async fn judge(&self, target: Connection) -> Status {
        match attempt(&target).await {
            Err(detail) => Status::Offline {
                base_url: target.base_url,
                detail,
            },
            Ok(Attempt {
                client, reached, ..
            }) => match reached {
                Reached::Ok => self.activate(target, client),
                Reached::Unauthorized => Status::Unauthorized {
                    base_url: target.base_url,
                },
                Reached::WrongCertificate { pinned, presented } => {
                    self.stage_mismatch(target, pinned, presented)
                }
                Reached::Unreachable(detail) => Status::Offline {
                    base_url: target.base_url,
                    detail,
                },
            },
        }
    }

    /// Report a refused certificate, and stage the new one so accepting it is the same single
    /// confirmation as accepting a first one. Never stored here: a mismatch is a question.
    fn stage_mismatch(&self, target: Connection, pinned: String, presented: String) -> Status {
        self.inner.lock().unwrap().pending = Some(Connection {
            fingerprint: Some(presented.clone()),
            ..target.clone()
        });
        Status::PinMismatch {
            base_url: target.base_url,
            pinned,
            presented,
        }
    }

    /// `Some` only when the target answered — used for the probes, where a failure is not news.
    async fn judge_if_ok(&self, target: &Connection) -> Option<Status> {
        match attempt(target).await {
            Ok(Attempt {
                client,
                reached: Reached::Ok,
                ..
            }) => Some(self.activate(target.clone(), client)),
            _ => None,
        }
    }

    fn activate(&self, target: Connection, client: Client) -> Status {
        let status = connected(&target);
        let mut inner = self.inner.lock().unwrap();
        inner.active = Some((target, client));
        // The cache belongs to the connection being replaced, not to this one.
        inner.cached = None;
        status
    }

    fn active(&self) -> Option<(Connection, Client)> {
        self.inner.lock().unwrap().active.clone()
    }

    fn deactivate(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.active = None;
        inner.cached = None;
    }
}

/// The digest, less the sessions nobody is sitting at.
///
/// `sdk-cli`/`sdk-py` are headless runs — seedeep's own docs gate writes one on every push — and a
/// menu bar is for the sessions a person is in: an automated run appearing there is a row the user
/// cannot act on and an icon that says somebody is working when nobody is. The rule is the browser
/// picker's (`client/sessions.ts`, `isAutomated`), applied at the ONE point a digest enters the
/// tray, so the rows, the icon and the notifications cannot disagree about which sessions exist.
///
/// A payload that is not an array comes back untouched: `state_of` reads that as Unreachable, which
/// is where a schema change has to land — never as "nothing is running".
fn only_interactive(digest: Value) -> Value {
    let Value::Array(entries) = digest else {
        return digest;
    };
    Value::Array(entries.into_iter().filter(|e| !is_automated(e)).collect())
}

/// Whether one entry is a headless run.
///
/// An entrypoint the tray does not recognise — and a missing one — is NOT automated. The failure
/// modes are not symmetric: showing one session too many is a row the user ignores, while hiding
/// one because a newer Claude Code renamed its entrypoint is a session the tray silently stops
/// watching, notifications included.
fn is_automated(entry: &Value) -> bool {
    entry["entrypoint"]
        .as_str()
        .is_some_and(|e| e.starts_with("sdk"))
}

/// What a target that is answering looks like to the panel.
fn connected(target: &Connection) -> Status {
    Status::Connected {
        base_url: target.base_url.clone(),
        fingerprint: target.fingerprint.clone(),
    }
}

/// Build a client for `target` and ask it for the digest once.
///
/// `Err` is reserved for a client that could not be BUILT — a TLS setup problem, which is a bug
/// here and not a network condition. Everything a server or a network can do to us is a [`Reached`].
async fn attempt(target: &Connection) -> Result<Attempt, String> {
    let (tls, seen) = pinned_tls(target.fingerprint.clone())
        .map_err(|e| format!("seedeep: could not set up TLS: {e}"))?;
    let client = Client::builder()
        .tls_backend_preconfigured(tls)
        // A proxy would terminate TLS somewhere else, which is precisely what the pin exists to
        // notice — and the server is on this machine or this LAN, where no proxy belongs.
        .no_proxy()
        // The API never redirects, and following one would move the request off the host whose
        // certificate was pinned.
        .redirect(reqwest::redirect::Policy::none())
        .timeout(REQUEST_TIMEOUT)
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .map_err(|e| format!("seedeep: could not build the HTTP client: {e}"))?;

    // Unconditional: an attempt has to see the digest to know it is talking to a seedeep, and a 304
    // proves only that nothing changed since a read this connection has not made.
    let result = request(&client, target, None).await;
    let presented = seen.lock().ok().and_then(|s| s.clone());

    let reached = match result {
        Ok(res) if res.status() == StatusCode::UNAUTHORIZED => {
            // The body, not just the code: a bare 401 could come from anything, and the panel
            // uses this to tell the user a seedeep is running on their own machine.
            let body = res.json::<Value>().await.ok();
            let seedeep = body
                .as_ref()
                .and_then(|b| b.get("error"))
                .and_then(Value::as_str)
                == Some("unauthorized");
            if seedeep {
                Reached::Unauthorized
            } else {
                Reached::Unreachable("something else is listening on that address".into())
            }
        }
        Ok(res) if res.status().is_success() => match res.json::<Value>().await {
            // The digest is a JSON array of live sessions, empty when nothing is running. Checked
            // so that "connected" means a seedeep answered, not that something returned 200.
            Ok(Value::Array(_)) => Reached::Ok,
            _ => Reached::Unreachable("that address answered, but not with a seedeep digest".into()),
        },
        Ok(res) => Reached::Unreachable(format!("the server answered {}", res.status())),
        Err(e) => match (&presented, &target.fingerprint) {
            // A transport error while holding a pin, having seen a DIFFERENT certificate, is the
            // pin doing its job. Decided on the two values rather than on the error text, so the
            // classification does not depend on how rustls words a message.
            (Some(seen), Some(pinned)) if !seen.eq_ignore_ascii_case(pinned) => {
                Reached::WrongCertificate {
                    pinned: pinned.clone(),
                    presented: seen.clone(),
                }
            }
            _ => Reached::Unreachable(describe(&e)),
        },
    };
    Ok(Attempt {
        client,
        presented,
        reached,
    })
}

/// One GET of the digest, with the token as a header — never as `?token=`, which would land in
/// the server's own logs and in shell history.
///
/// `etag` makes it conditional. Absent on the first read of a connection and on every probe, where
/// there is nothing to revalidate against.
async fn request(
    client: &Client,
    target: &Connection,
    etag: Option<&str>,
) -> Result<reqwest::Response, reqwest::Error> {
    let mut req = client.get(format!("{}{DIGEST_PATH}", target.base_url));
    if let Some(token) = &target.token {
        req = req.bearer_auth(token);
    }
    if let Some(etag) = etag {
        req = req.header(IF_NONE_MATCH, etag);
    }
    req.send().await
}

/// One line a human can act on, for the panel to show under "… is not answering".
///
/// reqwest nests the whole chain, and its innermost cause is sometimes an internal phrase that says
/// nothing to anybody — MEASURED on 0.13.4: a refused connection ends in "Connection refused (os
/// error 61)", but a connect timeout ends in "deadline has elapsed", which is what the panel used
/// to print for the single most likely remote failure, a machine that went to sleep.
///
/// The two cases are named here rather than in the panel because this is where the evidence is: the
/// panel used to add "It is most likely not running", which is right for a refusal and WRONG for a
/// silence. A guess belongs next to what it is a guess about.
fn describe(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        // Both predicates hold for a connect timeout, so the order matters and the number comes
        // from the constant that actually elapsed rather than from a literal that can drift.
        let waited = if e.is_connect() { CONNECT_TIMEOUT } else { REQUEST_TIMEOUT };
        return format!(
            "No answer within {} seconds — the machine may be asleep or off this network.",
            waited.as_secs(),
        );
    }
    let mut source: &dyn std::error::Error = e;
    while let Some(next) = source.source() {
        source = next;
    }
    let inner = source.to_string();
    if e.is_connect() {
        return format!("Nothing is listening on that address, so the server is probably not running. {inner}.");
    }
    inner
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    /// Which announced server the tray adopts is a RULE, and it is the maintainer's: the default port wins,
    /// then the lowest. Pinned because `read_dir` has no order of its own, so the previous
    /// behaviour was reproducible on one machine and a coin toss on the next.
    #[test]
    fn the_default_port_is_adopted_before_any_other() {
        let mut announced = vec![
            "http://localhost:9000".to_string(),
            "http://127.0.0.1:44842".to_string(),
            "http://localhost:8080".to_string(),
        ];
        announced.sort_by_key(|u| adoption_order(u));
        assert_eq!(
            announced,
            ["http://127.0.0.1:44842", "http://localhost:8080", "http://localhost:9000"]
        );

        // With no default announced, the order is still fixed rather than the filesystem's.
        let mut without = vec!["http://localhost:9000".to_string(), "http://localhost:8080".to_string()];
        without.sort_by_key(|u| adoption_order(u));
        assert_eq!(without, ["http://localhost:8080", "http://localhost:9000"]);
    }

    // The one failure this cannot survive: reqwest's rustls and ours resolving to different
    // versions makes the config an `Any` reqwest does not recognise, and the whole data layer is
    // built on it. reqwest's own docs call the coupling brittle, so it is asserted rather than
    // assumed.
    #[test]
    fn reqwest_accepts_the_pinned_tls_config() {
        let (tls, _) = pinned_tls(None).expect("a config must build");
        assert!(
            Client::builder().tls_backend_preconfigured(tls).build().is_ok(),
            "reqwest did not recognise our rustls ClientConfig — the two rustls versions differ"
        );
    }

    #[test]
    fn a_status_names_its_kind_for_the_panel() {
        let json = serde_json::to_value(Status::PinMismatch {
            base_url: "https://box.local:44842".into(),
            pinned: "AA:BB".into(),
            presented: "CC:DD".into(),
        })
        .unwrap();
        assert_eq!(json["kind"], "pinMismatch");
        assert_eq!(json["baseUrl"], "https://box.local:44842");
        assert_eq!(json["presented"], "CC:DD");
    }

    #[test]
    fn a_plaintext_connection_reports_no_fingerprint() {
        let json = serde_json::to_value(Status::Connected {
            base_url: "http://127.0.0.1:44842".into(),
            fingerprint: None,
        })
        .unwrap();
        assert_eq!(json["kind"], "connected");
        assert!(json["fingerprint"].is_null());
    }

    // Nothing to trust must not be storable: `trust()` is the one call that turns a value the user
    // was shown into an identity, so it can only ever confirm something that was actually shown.
    #[tokio::test]
    async fn trusting_nothing_stores_nothing() {
        let dir = std::env::temp_dir().join(format!("seedeep-tray-trust-{}", std::process::id()));
        let store = connection::store_path(&dir);
        let conn = Conn::new(store.clone(), no_local());

        let err = conn.trust().await.expect_err("nothing was pending");

        assert!(err.contains("no certificate"), "{err}");
        assert_eq!(connection::load(&store), None);
    }

    /// A one-shot HTTP server that answers the digest and honours `if-none-match`, on a port the OS
    /// picks. Hand-written because the alternative is a mocking crate in the shipped dependency
    /// graph, and what has to be observed here is the request BYTES — whether the validator was
    /// sent at all — which a mock at the reqwest layer would not show.
    ///
    /// Returns the base URL and a handle to the requests it saw, in order.
    fn etag_server(body: &'static str, etag: &'static str) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("a port");
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            use std::io::{Read, Write};
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let mut buf = [0u8; 2048];
                let read = stream.read(&mut buf).unwrap_or(0);
                let head = String::from_utf8_lossy(&buf[..read]).to_string();
                let conditional = head.to_ascii_lowercase().contains(&format!("if-none-match: {etag}").to_ascii_lowercase());
                log.lock().unwrap().push(head);
                let res = if conditional {
                    format!("HTTP/1.1 304 Not Modified\r\netag: {etag}\r\ncontent-length: 0\r\n\r\n")
                } else {
                    format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\netag: {etag}\r\ncontent-length: {}\r\n\r\n{body}",
                        body.len()
                    )
                };
                let _ = stream.write_all(res.as_bytes());
            }
        });
        (base, seen)
    }

    // The poll asks the same URL every second forever, so it revalidates instead of refetching: the
    // server already tags every response, and an unchanged digest has to cost a 304 and no body.
    // What makes this worth a test is the failure mode on the other side of it — a 304 answered from
    // an empty cache would hand the panel "nothing is running", which is a claim about the machine.
    #[tokio::test]
    async fn an_unchanged_digest_is_revalidated_and_not_refetched() {
        let (base, seen) = etag_server("[{\"sessionId\":\"s-1\",\"status\":\"busy\"}]", "\"abc123\"");
        let dir = std::env::temp_dir().join(format!("seedeep-tray-etag-{}", std::process::id()));
        let store = connection::store_path(&dir);
        connection::save(
            &store,
            &Connection { base_url: base, fingerprint: None, token: None },
        )
        .unwrap();
        let conn = Conn::new(store, no_local());

        let first = conn.read().await;
        let second = conn.read().await;

        assert!(matches!(first.status, Status::Connected { .. }), "{:?}", first.status);
        assert_eq!(first.entries, second.entries, "a revalidated digest is the same digest");
        assert!(second.entries.as_ref().is_some_and(Value::is_array));
        let requests = seen.lock().unwrap().clone();
        // The discovery's own GET cannot be conditional — it has to SEE a digest to know it is
        // talking to a seedeep — so the validator appears once the connection is up, and then always.
        let conditional = requests.iter().filter(|r| r.to_ascii_lowercase().contains("if-none-match")).count();
        assert_eq!(
            conditional,
            requests.len() - 2,
            "every read after the first must revalidate ({} requests)",
            requests.len()
        );
        assert!(conditional >= 1, "nothing revalidated");
    }

    // The filter is asserted through `read()`, not on the pure function alone: what the card asks
    // for is that the tray never SHOWS an automated run, and a filter that exists but sits outside
    // the path a reading takes would pass a unit test and change nothing on screen.
    #[tokio::test]
    async fn a_headless_run_never_reaches_the_tray() {
        let (base, _) = etag_server(
            "[{\"sessionId\":\"s-1\",\"entrypoint\":\"cli\",\"status\":\"busy\"},\
              {\"sessionId\":\"gate\",\"entrypoint\":\"sdk-cli\",\"status\":\"busy\"}]",
            "\"one-of-each\"",
        );
        let dir = std::env::temp_dir().join(format!("seedeep-tray-human-{}", std::process::id()));
        let store = connection::store_path(&dir);
        connection::save(
            &store,
            &Connection { base_url: base, fingerprint: None, token: None },
        )
        .unwrap();

        let entries = Conn::new(store, no_local()).read().await.entries.expect("a digest");

        let ids: Vec<&str> = entries
            .as_array()
            .expect("an array")
            .iter()
            .filter_map(|e| e["sessionId"].as_str())
            .collect();
        assert_eq!(ids, ["s-1"], "the sdk run is not a session anybody is sitting at");
    }

    // Which way the unknown case falls is the whole decision: a Claude Code that renames its
    // entrypoint must cost the user an extra row, never a session the tray stops watching.
    #[test]
    fn an_entrypoint_the_tray_does_not_know_is_kept() {
        let digest = serde_json::json!([
            { "sessionId": "known", "entrypoint": "cli" },
            { "sessionId": "future", "entrypoint": "vscode" },
            { "sessionId": "silent", "entrypoint": Value::Null },
            { "sessionId": "absent" },
            { "sessionId": "headless", "entrypoint": "sdk-py" },
        ]);

        let kept: Vec<String> = only_interactive(digest)
            .as_array()
            .expect("an array")
            .iter()
            .map(|e| e["sessionId"].as_str().unwrap_or_default().to_string())
            .collect();

        assert_eq!(kept, ["known", "future", "silent", "absent"]);
    }

    // A digest that is not a list must stay not-a-list: `state_of` turns that into Unreachable,
    // which is how a schema change announces itself. Filtering it into an empty array would
    // announce it as a machine with nothing running — the one lie the icon must never tell.
    #[test]
    fn a_payload_that_is_not_a_list_is_left_alone() {
        let odd = serde_json::json!({ "sessions": [] });

        assert_eq!(only_interactive(odd.clone()), odd);
    }

    // A 304 the client cannot answer is a server we do not understand, and saying so is the only
    // honest option: inventing an empty digest would report an idle machine.
    #[tokio::test]
    async fn a_304_with_nothing_cached_is_an_error_not_an_empty_digest() {
        // Answers 304 unconditionally, which no correct server does — the case exists because the
        // consequence of guessing here is the tray asserting something it never read.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("a port");
        let base = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            use std::io::Write;
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let _ = stream.write_all(b"HTTP/1.1 304 Not Modified\r\ncontent-length: 0\r\n\r\n");
            }
        });
        let dir = std::env::temp_dir().join(format!("seedeep-tray-304-{}", std::process::id()));
        let store = connection::store_path(&dir);
        connection::save(
            &store,
            &Connection { base_url: base.clone(), fingerprint: None, token: None },
        )
        .unwrap();

        let tick = Conn::new(store, no_local()).read().await;

        assert!(tick.entries.is_none(), "a 304 must not become an empty digest");
        assert!(
            matches!(tick.status, Status::Offline { .. }) || matches!(tick.status, Status::NeedsUrl { .. }),
            "{:?}",
            tick.status
        );
    }

    /// The whole remote flow against a REAL server, and the only test that can prove any of it:
    /// pinning is a claim about a handshake with an actual self-signed certificate, which nothing
    /// hermetic can make. Out of the default run for the same reason the server's schema probe is
    /// out of `bun test` — it needs something started by hand — and committed rather than left in a
    /// scratchpad so the claim can be RE-RUN on a later rustls or Tauri release instead of quietly
    /// expiring. See `docs/tray.md`.
    ///
    /// ```sh
    /// SEEDEEP_TRAY_PROBE_URL='https://127.0.0.1:44842/?token=<token>' \
    ///   cargo test -- --ignored --nocapture a_real_server_is_reached
    /// ```
    #[tokio::test]
    #[ignore = "needs a running seedeep in remote mode: set SEEDEEP_TRAY_PROBE_URL"]
    async fn a_real_server_is_reached_pinned_and_remembered() {
        let url = std::env::var("SEEDEEP_TRAY_PROBE_URL")
            .expect("SEEDEEP_TRAY_PROBE_URL must hold the URL the portal's Settings panel copies");
        let store = connection::store_path(&probe_dir("remote"));
        let conn = Conn::new(store.clone(), no_local());

        // A first connect LEARNS the fingerprint and stores NOTHING: unconfirmed trust-on-first-use
        // is trust in whoever answered first.
        let learned = match conn.connect(&url).await.expect("the paste should be accepted") {
            Status::AwaitingTrust { fingerprint, .. } => fingerprint,
            other => panic!("expected AwaitingTrust, got {other:?}"),
        };
        assert_eq!(connection::load(&store), None, "an unconfirmed fingerprint was stored");
        // Printed so the run can be compared with the line the server prints on start — the very
        // out-of-band check the user is being asked to perform. A fingerprint is not a secret.
        println!("learned fingerprint: {learned}");

        // Confirming stores it and re-verifies with the pin IN FORCE, so Connected is not a claim
        // inherited from the learning mode that produced the value.
        match conn.trust().await.expect("trusting the learned certificate") {
            Status::Connected { fingerprint, .. } => {
                assert_eq!(fingerprint.as_deref(), Some(learned.as_str()));
            }
            other => panic!("expected Connected, got {other:?}"),
        }
        let stored = connection::load(&store).expect("nothing was stored");
        assert_eq!(stored.fingerprint.as_deref(), Some(learned.as_str()));
        assert!(stored.token.is_some(), "the token did not move out of the URL");
        assert!(!stored.base_url.contains("token"), "the token stayed in the URL: {}", stored.base_url);

        // "Survives a restart without asking anything again" — a fresh Conn over the same file.
        let restarted = Conn::new(store.clone(), no_local());
        match restarted.status().await {
            Status::Connected { .. } => {}
            other => panic!("a restart should ask nothing, got {other:?}"),
        }
        let tick = restarted.read().await;
        assert!(
            matches!(tick.status, Status::Connected { .. }),
            "a reading over the pin: {:?}",
            tick.status
        );
        assert!(
            tick.entries.as_ref().is_some_and(Value::is_array),
            "the digest is a list of live sessions"
        );
        // The second reading is the one the poll actually makes — over the same connection, with the
        // validator the first one stored. It must answer with the digest, not with the 304.
        assert!(
            restarted.read().await.entries.as_ref().is_some_and(Value::is_array),
            "a conditional read must still produce a digest"
        );

        // Re-pasting the URL is what a rotated token asks for, and it must NOT ask about the
        // certificate again: the pin belongs to the server, so a matching one is not news.
        match restarted.connect(&url).await.expect("re-pasting the same URL") {
            Status::Connected { fingerprint, .. } => {
                assert_eq!(fingerprint.as_deref(), Some(learned.as_str()));
            }
            other => panic!("a pinned server must not be re-learned: {other:?}"),
        }

        // The half that makes the other half mean something: a DIFFERENT pin must refuse this very
        // same server, and hand back both values for the panel to show.
        let wrong = "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99";
        connection::save(
            &store,
            &Connection {
                fingerprint: Some(wrong.to_string()),
                ..stored.clone()
            },
        )
        .unwrap();
        let refusing = Conn::new(store.clone(), no_local());
        match refusing.status().await {
            Status::PinMismatch { pinned, presented, .. } => {
                assert_eq!(pinned, wrong);
                assert_eq!(presented, learned, "the presented certificate is the real one");
            }
            other => panic!("a certificate that is not the pinned one must not connect: {other:?}"),
        }
        assert!(
            refusing.read().await.entries.is_none(),
            "a refused connection must read nothing"
        );
        // And the paste path cannot be used to walk around the refusal: pasting the URL of a server
        // whose certificate no longer matches must report the MISMATCH, with both values, not
        // present the new certificate as a first sighting.
        match refusing.connect(&url).await.expect("pasting a URL for a pinned server") {
            Status::PinMismatch { pinned, presented, .. } => {
                assert_eq!(pinned, wrong);
                assert_eq!(presented, learned);
            }
            other => panic!("a paste must not re-enter learning mode: {other:?}"),
        }

        // And the refusal is recoverable in one confirmation, which is what makes a legitimately
        // replaced certificate a message instead of a dead end.
        match refusing.trust().await.expect("re-pinning what was just shown") {
            Status::Connected { fingerprint, .. } => {
                assert_eq!(fingerprint.as_deref(), Some(learned.as_str()));
            }
            other => panic!("expected Connected after re-pinning, got {other:?}"),
        }
    }

    /// The zero-configuration case, against a real seedeep in its DEFAULT loopback mode: no paste,
    /// no pin, no file. Separate from the remote probe because the two need the same port and
    /// therefore cannot both be up.
    ///
    /// ```sh
    /// SEEDEEP_TRAY_PROBE_LOCAL=1 cargo test -- --ignored --nocapture a_default_local_server
    /// ```
    #[tokio::test]
    #[ignore = "needs a running seedeep in default loopback mode: set SEEDEEP_TRAY_PROBE_LOCAL=1"]
    async fn a_default_local_server_needs_no_configuration() {
        assert!(
            std::env::var_os("SEEDEEP_TRAY_PROBE_LOCAL").is_some(),
            "set SEEDEEP_TRAY_PROBE_LOCAL=1 to say a loopback-mode server is up"
        );
        let store = connection::store_path(&probe_dir("local"));
        let conn = Conn::new(store.clone(), no_local());

        match conn.status().await {
            Status::Connected { base_url, fingerprint } => {
                assert_eq!(base_url, "http://127.0.0.1:44842");
                assert_eq!(fingerprint, None, "a loopback server has no certificate to pin");
            }
            other => panic!("expected Connected, got {other:?}"),
        }
        assert_eq!(connection::load(&store), None, "zero configuration means no file");
        let tick = conn.read().await;
        assert!(tick.entries.as_ref().is_some_and(Value::is_array), "the digest");
        // The click a row makes, on the connection that was found without being configured.
        assert_eq!(
            conn.portal_url(Some("s-1")).as_deref(),
            Some("http://127.0.0.1:44842/?session=s-1"),
            "a loopback server takes no token in the portal URL"
        );
        // And the click the footer's address makes: no session, and here no token either, so the
        // query has nothing to carry and must not be written as a bare `?`.
        assert_eq!(
            conn.portal_url(None).as_deref(),
            Some("http://127.0.0.1:44842/"),
            "the portal's home on a loopback server is the bare address"
        );
    }

    /// The case the card had wrong: a seedeep on THIS machine with remote access configured. It is
    /// not the zero-configuration case — loopback speaks HTTPS and demands the token — and the
    /// panel has to say that rather than imply there is nothing here.
    ///
    /// ```sh
    /// SEEDEEP_TRAY_PROBE_LOCAL_REMOTE=1 cargo test -- --ignored --nocapture a_local_server_in_remote_mode
    /// ```
    #[tokio::test]
    #[ignore = "needs a seedeep in remote mode on port 44842: set SEEDEEP_TRAY_PROBE_LOCAL_REMOTE=1"]
    async fn a_local_server_in_remote_mode_is_recognised_as_one() {
        assert!(
            std::env::var_os("SEEDEEP_TRAY_PROBE_LOCAL_REMOTE").is_some(),
            "set SEEDEEP_TRAY_PROBE_LOCAL_REMOTE=1 to say a remote-mode server is up on 44842"
        );
        let store = connection::store_path(&probe_dir("local-remote"));

        match Conn::new(store, no_local()).status().await {
            Status::NeedsUrl { local_remote } => {
                assert!(local_remote, "the 401 over TLS on loopback was not recognised");
            }
            other => panic!("expected NeedsUrl, got {other:?}"),
        }
    }

    /// The same machine, but with the REAL home — so the record and the config are both there, and
    /// this exercises the path the probe above deliberately cannot: a live record proves the server
    /// is here, its 401 says it wants credentials, and those are in the file it wrote them in.
    ///
    /// The probe above keeps its own assertion because it is about a DIFFERENT setup (nothing on
    /// disk to read), and both have to stay true: with nothing to read the panel must still ask.
    ///
    /// ```sh
    /// SEEDEEP_TRAY_PROBE_LOCAL_ADOPT=1 cargo test -- --ignored --nocapture a_co_located_server
    /// ```
    #[tokio::test]
    #[ignore = "needs a seedeep in remote mode on THIS machine: set SEEDEEP_TRAY_PROBE_LOCAL_ADOPT=1"]
    async fn a_co_located_server_in_remote_mode_is_adopted() {
        assert!(
            std::env::var_os("SEEDEEP_TRAY_PROBE_LOCAL_ADOPT").is_some(),
            "set SEEDEEP_TRAY_PROBE_LOCAL_ADOPT=1 to say a remote-mode server is running here"
        );
        let home = local::seedeep_home(
            std::path::PathBuf::from(std::env::var("HOME").unwrap()),
            std::env::var_os("SEEDEEP_HOME"),
        );
        let conn = Conn::new(
            connection::store_path(&probe_dir("local-adopt")),
            Arc::new(LocalServer::new(home)),
        );

        match conn.status().await {
            Status::Connected { base_url, fingerprint } => {
                println!("adopted {base_url} pinned to {}", fingerprint.as_deref().unwrap_or("nothing"));
                assert!(fingerprint.is_some(), "a TLS server must be pinned, and to the file's value");
            }
            other => panic!("expected Connected, got {other:?}"),
        }
    }

    /// A local layer that knows of no server, so a test exercises the probes and not this machine.
    /// Its directory is fresh per call and never written to: `running()` on a missing `servers/` is
    /// an empty list.
    /// Both URLs the panel can open, on a server that DOES demand a token — the case the probe
    /// tests cannot cover without a running remote server, and the one where the query is built
    /// rather than fixed. A home URL that dropped the token would land the browser on a 401.
    #[test]
    fn the_portal_url_carries_the_token_with_or_without_a_session() {
        let conn = Conn::new(probe_dir("portal-url").join("connection.json"), no_local());
        conn.inner.lock().unwrap().active = Some((
            Connection {
                base_url: "https://box.local:44842".to_string(),
                fingerprint: None,
                token: Some("t0ken".to_string()),
            },
            Client::new(),
        ));

        assert_eq!(
            conn.portal_url(Some("s-1")).as_deref(),
            Some("https://box.local:44842/?session=s-1&token=t0ken")
        );
        assert_eq!(
            conn.portal_url(None).as_deref(),
            Some("https://box.local:44842/?token=t0ken")
        );
    }

    /// Nothing connected is nothing to open — the panel must get an error it can show, never a URL
    /// pointing at a server it is not talking to.
    #[test]
    fn there_is_no_portal_url_without_a_connection() {
        let conn = Conn::new(probe_dir("portal-url-none").join("connection.json"), no_local());
        assert_eq!(conn.portal_url(None), None);
    }

    fn no_local() -> Arc<LocalServer> {
        static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        Arc::new(LocalServer::new(std::env::temp_dir().join(format!(
            "seedeep-tray-nolocal-{}-{}",
            std::process::id(),
            N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ))))
    }

    /// A directory of this probe's own, so a run never reads or writes the real tray's connection.
    fn probe_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("seedeep-tray-probe-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    // A server nobody is running is Offline, not "no server configured": the difference is whether
    // the panel asks for a URL it already has.
    #[tokio::test]
    async fn a_stored_server_that_is_down_stays_stored() {
        let dir = std::env::temp_dir().join(format!("seedeep-tray-down-{}", std::process::id()));
        let store = connection::store_path(&dir);
        // Port 1 needs no listener to be certain: it is reserved and privileged, and no ephemeral
        // allocation can ever land on it. Asking the OS for a free port and releasing it looked
        // safer and is not — it leaves a window in which anything on a busy runner can take the
        // number, and this test's own client draws from that same range. What was wrong here was
        // never the port; it was asserting WHICH sentence a closed one produces.
        let port = 1;
        let target = Connection {
            base_url: format!("http://127.0.0.1:{port}"),
            fingerprint: None,
            token: Some("t".into()),
        };
        connection::save(&store, &target).unwrap();

        let status = Conn::new(store.clone(), no_local()).status().await;

        match status {
            Status::Offline { base_url, detail } => {
                assert_eq!(base_url, format!("http://127.0.0.1:{port}"));
                // The panel prints this verbatim, so it is asserted as PROSE. The regression it
                // guards: the innermost cause of a reqwest timeout is the phrase "deadline has
                // elapsed" (measured on 0.13.4), which the panel used to show for the most likely
                // remote failure of all — a machine that had gone to sleep. THAT is the assertion,
                // and it holds whichever way the connection ends.
                assert!(!detail.contains("deadline"), "{detail}");
                // Which of the two sentences appears is the kernel's answer, not seedeep's: macOS
                // REFUSES on a closed port and the connect branch fires, while Windows drops the
                // packets and the same port runs into the timeout instead — the reason this test
                // passed on one machine and failed on the next until it stopped asserting an OS's
                // manners. Both sentences are seedeep's, and neither leaks a library's phrasing.
                assert!(
                    detail.contains("probably not running") || detail.contains("may be asleep"),
                    "{detail}"
                );
            }
            other => panic!("expected Offline, got {other:?}"),
        }
        assert_eq!(connection::load(&store).as_ref(), Some(&target), "a failure must not forget");
    }
}

/// What one notification says, exactly as the server renders it.
///
/// The tray composes none of this any more: the wording lives beside the panel's own, server-side,
/// so a banner and the row it belongs to cannot word the same event differently.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
pub struct Announcement {
    /// `needsYou`, `fails` or `finishes` — which switch this answers to. The SERVER has already
    /// applied that switch; this rides along so a log can say what was shown and why.
    pub kind: String,
    pub title: String,
    pub body: String,
}

/// Pull one `notification` out of an SSE frame, or `None` for every other event.
///
/// Deliberately tolerant of field order and of the comment lines the heartbeat writes: this parses
/// what the wire carries, not what we would have written.
fn parse_notification(frame: &str) -> Option<Announcement> {
    let mut is_notification = false;
    let mut data: Option<&str> = None;
    for line in frame.lines() {
        if let Some(rest) = line.strip_prefix("event:") {
            is_notification = rest.trim() == "notification";
        } else if let Some(rest) = line.strip_prefix("data:") {
            data = Some(rest.trim());
        }
    }
    if !is_notification {
        return None;
    }
    serde_json::from_str(data?).ok()
}


#[cfg(test)]
mod stream_tests {
    use super::*;

    #[test]
    fn reads_a_notification_frame() {
        let a = parse_notification("event: notification\ndata: {\"kind\":\"needsYou\",\"title\":\"atlas — a subject\",\"body\":\"Waiting for your approval — Bash\"}").unwrap();
        assert_eq!(a.kind, "needsYou");
        assert_eq!(a.title, "atlas — a subject");
        assert_eq!(a.body, "Waiting for your approval — Bash");
    }

    #[test]
    fn ignores_every_other_event() {
        // The stream carries the whole reducer's traffic; a tray that showed a banner per frame
        // would notify on every line the transcript grows by.
        assert!(parse_notification("event: tool-start\ndata: {\"name\":\"Bash\"}").is_none());
        assert!(parse_notification("id: 7\ndata: {\"kind\":\"needsYou\"}").is_none());
    }

    #[test]
    fn survives_a_heartbeat_comment_and_field_order() {
        assert!(parse_notification(": keepalive").is_none());
        let a = parse_notification("id: 3\ndata: {\"kind\":\"finishes\",\"title\":\"t\",\"body\":\"Turn finished\"}\nevent: notification");
        assert_eq!(a.unwrap().body, "Turn finished");
    }

    #[test]
    fn a_frame_that_is_not_json_is_dropped_rather_than_panicking() {
        assert!(parse_notification("event: notification\ndata: not json").is_none());
        assert!(parse_notification("event: notification").is_none());
    }
}

impl Conn {
    /// Whether the server says a new-release banner is wanted — `notifications.tray.updates`.
    ///
    /// Read from the server and not from a file here, for the reason every other switch moved: the
    /// panel that sets it is the server's, and a tray deciding from its own copy would silently
    /// ignore what the user just changed. Asked on the update clock (every 15 minutes), never on the
    /// poll, so it costs one request against a value that moves when a human moves it.
    ///
    /// Defaults to TRUE when it cannot be read: this gate only runs after `/api/update` has already
    /// answered, so an unreadable config is a shape seedeep did not recognise rather than a server
    /// that is gone — and losing the one banner that says the user is running an old release is the
    /// worse of the two failures.
    pub async fn wants_update_banner(&self) -> bool {
        let Some((target, client)) = self.active() else {
            return true;
        };
        let mut req = client.get(format!("{}{CONFIG_PATH}", target.base_url));
        if let Some(token) = &target.token {
            req = req.bearer_auth(token);
        }
        let Ok(res) = req.send().await else { return true };
        let Ok(body) = res.json::<Value>().await else {
            return true;
        };
        body["notifications"]["tray"]["updates"].as_bool().unwrap_or(true)
    }
}
