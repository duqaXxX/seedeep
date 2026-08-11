//! The tray's clock, and the only thing that reads the server on its own initiative.
//!
//! It lives in Rust rather than in the panel for two reasons, and the second is the one that
//! decides it: the icon has to be right BEFORE anybody has ever clicked it, and a hidden window's
//! timers are throttled by the platform. (The hidden webview does RUN — measured 2026-07-30,
//! correcting an earlier claim in this file that macOS did not load it at all — so the argument is
//! not that the panel is asleep; it is that a clock the menu bar depends on must not be one the
//! platform is free to slow down.)
//!
//! So the loop runs whether or not there is a window, sets the icon from every reading, and pushes
//! the same reading to the panel when one is open. One reading, one truth: the rows and the icon can
//! never disagree about what the server said.
//!
//! It no longer decides what is worth a NOTIFICATION. The server owns that — it holds the
//! transitions, the switches and the wording — and the tray subscribes to its stream and shows what
//! arrives. Two implementations of one rule were free to diverge, which is how a phone and a menu
//! bar end up disagreeing about the same session.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;
use tokio::sync::Notify;
use tokio::time::timeout;

use crate::client::{Conn, Reading};
use crate::icon::{self, TrayState};
use crate::local::{Local, LocalServer};
use crate::settings::Prefs;
use crate::update;

/// While the panel is open. A session stopping on a question has to appear as it happens, and the
/// cost is measured rather than assumed: one digest request is ~12.5 ms of CPU over 912 sessions on
/// disk — about 1.2% of one core at this cadence, and an unchanged digest is answered with a 304.
const OPEN: Duration = Duration::from_secs(1);

/// While it is closed. The only consumer then is the icon, and an icon a few seconds behind is not
/// wrong in a way anyone can see — whereas a second-by-second poll behind a closed panel is battery
/// spent on nobody.
const CLOSED: Duration = Duration::from_secs(5);

/// How long one frame of the working wedge stays up — see `icon::SPIN_FPS`. Nothing to do with the
/// poll: this is how smooth a spinner looks, not how fresh a reading is.
const FRAME: Duration = Duration::from_nanos(1_000_000_000 / icon::SPIN_FPS as u64);

/// The event the panel listens on, carrying exactly what the `tick` command returns.
const TICK: &str = "tick";

/// How often the update endpoint is asked.
///
/// SHORTER than the hour the server keeps its npm answer for, and that is the point: asking on the
/// same period as the cache expires would put the tray's request just before the refresh as often as
/// just after, making the worst case two hours rather than one. This is a local HTTP call against a
/// cached file — it costs the registry nothing, whatever the cadence — so the server's TTL stays the
/// only thing that decides how fresh the answer is. The first check runs on the first tick, so a
/// tray started after a release does not wait to say so.
const UPDATE_EVERY: Duration = Duration::from_secs(15 * 60);

/// What the panel gets: a reading of the server, plus whether anybody is looking at it.
///
/// `open` is here rather than left to the webview because Rust is the side that KNOWS — it is the
/// same flag that sets the cadence, so the two can never disagree. The panel needs it for one rule:
/// a session that ends is kept on screen only while the popover is open, and the webview cannot
/// answer that for itself. (It runs while the window is hidden — measured 2026-07-30 — so "I am
/// executing" is not "I am visible", and a `blur` event that may or may not be delivered is not a
/// fact to build a rule on.)
#[derive(Debug, Clone, Serialize)]
pub struct Tick {
    #[serde(flatten)]
    pub reading: Reading,
    pub open: bool,
    /// What may be offered for a server on this machine — see [`crate::local`]. Travels with the
    /// reading for the reason `entries` does: both are answers about the same instant, and a panel
    /// that took them from two calls could draw a Start button under a server that has just come up.
    pub local: Local,
}

/// The poll: a cadence, the connection it reads through, the last icon it painted, and who it has
/// already interrupted the user about.
pub struct Poller {
    conn: Arc<Conn>,
    prefs: Arc<Prefs>,
    /// The local server layer, asked on every reading what the panel may offer. Shared with the
    /// commands, so a click and the tick that follows it are looking at one cache.
    local: Arc<LocalServer>,
    open: AtomicBool,
    /// Woken when the panel opens or closes, so the cadence changes then rather than up to five
    /// seconds later — which would otherwise be the delay before the first fresh row.
    wake: Notify,
    /// The still state currently on the menu bar, or `None` while the wedge is turning — which also
    /// makes this the lock the poll and the spin take turns with the icon under.
    ///
    /// Painted only on a change: `set_icon` on every tick is a platform call a second for a mark
    /// that is identical, and on macOS a redraw of the menu bar item.
    painted: Mutex<Option<TrayState>>,
    /// Whether something is working, i.e. whether the wedge should be turning.
    spinning: AtomicBool,
    /// Woken when it starts, so the first frame lands with the reading rather than up to a poll
    /// later. Nothing wakes it to STOP — the spin re-reads `spinning` before every frame.
    spin_wake: Notify,
    /// Which version the user has already been told about, and when the registry answer was last
    /// asked for. The one thing the tray still decides for itself: it is not about sessions, so the
    /// server has no view of it.
    notices: Arc<update::Notices>,
    /// When the update endpoint was last read, or `None` when it never has been.
    checked_at: Mutex<Option<Instant>>,
}

impl Poller {
    pub fn new(
        conn: Arc<Conn>,
        prefs: Arc<Prefs>,
        local: Arc<LocalServer>,
        notices: Arc<update::Notices>,
    ) -> Arc<Self> {
        Arc::new(Self {
            conn,
            prefs,
            local,
            notices,
            checked_at: Mutex::new(None),
            open: AtomicBool::new(false),
            wake: Notify::new(),
            painted: Mutex::new(None),
            spinning: AtomicBool::new(false),
            spin_wake: Notify::new(),
        })
    }

    /// Tell the poll whether the panel is on screen. Called from both places that know — the icon's
    /// toggle and the focus-loss handler that dismisses the popover.
    pub fn set_open(&self, open: bool) {
        // Woken only on a CHANGE. Measured on a real run: macOS delivers a focus event to the
        // popover while it is still hidden at startup, and notifying on every call spent a whole
        // extra read on a cadence that had not moved.
        if self.open.swap(open, Ordering::Relaxed) != open {
            self.wake.notify_one();
        }
    }

    /// One reading, stamped with whether the panel is open. The only way a `Tick` is made, so the
    /// loop and the panel's own call cannot produce two different shapes of the same fact.
    pub async fn tick(&self) -> Tick {
        let reading = self.conn.read().await;
        // After the reading and from it: what may be started depends on what is answering, and
        // deciding from the previous tick's status would offer a Start for a server that is up.
        // It does not await — this loop paints the icon, and a shell it waited on would freeze that.
        let local = self.local.survey(&reading.status);
        Tick {
            reading,
            open: self.open.load(Ordering::Relaxed),
            local,
        }
    }

    /// Start the loop, and the spin that runs beside it. Never returns; ends with the process.
    /// Show a banner for every notification the server sends, reconnecting when the stream drops.
    ///
    /// The tray decides nothing here: which events exist, which switch they answer to and what they
    /// say are all the server's, so a banner and the panel row it belongs to cannot disagree. A
    /// reconnect replays nothing — the server re-seeds when a subscriber arrives.
    fn subscribe(self: Arc<Self>, app: AppHandle) {
        tauri::async_runtime::spawn(async move {
            loop {
                let app_for_banner = app.clone();
                // Discarded on purpose, and it would be discarded even if it were checked: `show`
                // returns Ok(()) in the case where nothing is delivered at all (measured — see
                // `docs/tray.md`). A tray cannot report a failed notification through a notification.
                let _ = self
                    .conn
                    .stream_notifications(move |a| {
                        let _ = app_for_banner
                            .notification()
                            .builder()
                            .title(a.title)
                            .body(a.body)
                            .show();
                    })
                    .await;
                // The stream ended or never started. The poll's own closed cadence is the right
                // wait: it is what the tray already spends looking for a server that is not there.
                tokio::time::sleep(CLOSED).await;
            }
        });
    }

    pub fn spawn(self: Arc<Self>, app: AppHandle) {
        self.clone().spin(app.clone());
        self.clone().subscribe(app.clone());
        tauri::async_runtime::spawn(async move {
            loop {
                let tick = self.tick().await;
                // From the reading, not from the tick: what the icon says cannot depend on whether
                // somebody has the panel open.
                self.paint(&app, state_of(&tick.reading));
                // SPAWNED, never awaited, for the same reason `local.survey` does not await: this
                // loop paints the icon and feeds the panel. An unreachable server makes the update
                // request sit for the whole REQUEST_TIMEOUT, which on this path would delay the
                // repaint and the tick by 5s every time the check comes round. Overlapping runs are
                // impossible anyway — `checked_at` is claimed synchronously before the request.
                {
                    let me = Arc::clone(&self);
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move { me.announce_update(&app).await });
                }
                // Fails only when there is no window to receive it, which is most of the time.
                let _ = app.emit(TICK, &tick);
                let delay = if tick.open { OPEN } else { CLOSED };
                let _ = timeout(delay, self.wake.notified()).await;
            }
        });
    }

    /// Turn the working wedge, and only while something is working.
    ///
    /// A loop of its own because the two clocks answer to different things: the poll's cadence is
    /// how often the SERVER is asked, and this one is how smooth a spinner looks. Tying the wedge to
    /// the poll would mean one step a second — a stutter, not a spin.
    ///
    /// While nothing is working this task holds on a `Notify` and costs nothing at all: a timer left
    /// running through an idle night is a wakeup `SPIN_FPS` times a second for a mark that is not
    /// moving, which is the kind of thing that shows up in a battery report as seedeep.
    fn spin(self: Arc<Self>, app: AppHandle) {
        tauri::async_runtime::spawn(async move {
            // Rasterised once — see `icon::spin`.
            let frames = icon::spin();
            let mut at = 0usize;
            loop {
                if !self.spinning.load(Ordering::Relaxed) {
                    self.spin_wake.notified().await;
                    // From the top of the turn, so a session that starts working always begins the
                    // spin at the same place rather than wherever the last one left it.
                    at = 0;
                    continue;
                }
                {
                    // The SAME lock the poll paints under, and the flag is re-read while holding it.
                    // Otherwise a session that stops working between the check above and the call
                    // below leaves this frame painted on top of the still icon the poll has just
                    // put there. The next tick does correct it (this loop clears `painted`), so the
                    // cost is up to a whole poll interval — five seconds, with the panel closed —
                    // of a blue eye sitting over an amber approval, which is the worst thing this
                    // icon can say.
                    let mut painted = self.painted.lock().unwrap();
                    if !self.spinning.load(Ordering::Relaxed) {
                        continue;
                    }
                    if let Some(tray) = app.tray_by_id(icon::TRAY_ID) {
                        // A failure here is a tray icon that no longer exists (shutdown): stopping
                        // is right, and it is what the poll does with the same error.
                        if tray.set_icon(Some(frames[at % frames.len()].clone())).is_err() {
                            return;
                        }
                    }
                    // No still state is on screen any more.
                    *painted = None;
                    at += 1;
                }
                tokio::time::sleep(FRAME).await;
            }
        });
    }

    /// Say, at most once per released version, that a newer seedeep exists.
    ///
    /// On the poll's loop but not on its clock: the endpoint is asked at most every
    /// [`UPDATE_EVERY`], because the server answers it from a check it refreshes once an hour.
    ///
    /// The setting gates the BANNER only, exactly as it does for the session notifications — but
    /// here the bookkeeping it must not gate is [`update::Notices`], so switching the setting back
    /// on does not replay a version the user was already told about while it was off. The clock is
    /// therefore advanced, and the endpoint read, whatever the setting says.
    async fn announce_update(&self, app: &AppHandle) {
        {
            let mut checked = self.checked_at.lock().unwrap();
            if checked.is_some_and(|at| at.elapsed() < UPDATE_EVERY) {
                return;
            }
            *checked = Some(Instant::now());
        }
        let Some(status) = self.conn.update_status().await else {
            return;
        };
        // The SERVER is what this banner is about (Davide's call, 2026-08-05): it is the thing you
        // actually run, and a tray that announced its own version left a stale server unmentioned —
        // which is the case that had just happened. `standing` is the server's own verdict; the tray
        // does not recompute it.
        let (Some(latest), true) = (status.latest.clone(), status.server_behind) else {
            return;
        };
        // Asked FIRST and unconditionally, so the setting silences the banner without also making
        // this version announceable again the moment it is switched back on.
        let unseen = self.notices.should_announce(&latest);
        if !unseen || !self.prefs.get().notify_update {
            return;
        }
        let running = status.server.unwrap_or_else(|| "an older one".to_string());
        // ANNOUNCES, and stops there (Davide's call, 2026-08-06). A banner is read in a second and
        // dismissed; how to update depends on how that server was installed, and the panel is where
        // that answer can be given properly — with the command, and with room to be read twice.
        // Discarded for the same reason every other notification here discards it: `show` returns
        // `Ok(())` even when nothing is delivered.
        let _ = app
            .notification()
            .builder()
            .title(format!("seedeep {latest} is available"))
            .body(format!("The server is running {running}."))
            .show();
    }

    /// Put a reading's state on the menu bar — by painting it, or by handing it to the spin.
    ///
    /// Working is the one state this does not paint: it is 24 images, and the frame on screen is
    /// the spin's business. What this does is arm and disarm it, which is why `painted` is cleared
    /// on the way in — the still icon under the spin is gone, so the next still state has to be
    /// painted even if it is the one that was there before the session started working.
    fn paint(&self, app: &AppHandle, state: TrayState) {
        // Taken FIRST and held across the flag: this lock is what makes the poll and the spin take
        // turns with the icon (see `spin`).
        let mut painted = self.painted.lock().unwrap();
        let working = state == TrayState::Working;
        if self.spinning.swap(working, Ordering::Relaxed) != working && working {
            *painted = None;
            // Wakes the spin even if it has not reached `notified()` yet — `Notify` stores the
            // permit — so the FIRST reading of a working machine starts the wedge.
            self.spin_wake.notify_one();
        }
        if working {
            return;
        }
        if *painted == Some(state) {
            return;
        }
        // Looked up rather than held: the tray icon belongs to the app, and a handle kept here would
        // outlive it during shutdown.
        if let Some(tray) = app.tray_by_id(icon::TRAY_ID) {
            if tray.set_icon(Some(icon::image(state))).is_err() {
                return;
            }
        }
        *painted = Some(state);
    }
}

/// What the icon says about a reading.
///
/// Unreachable covers "nothing configured" as well as "configured and silent": both are the tray
/// unable to see anything, and an idle icon it cannot vouch for would be the tray guessing. The
/// waiting count is the number of sessions stopped on the HUMAN — see [`needs_you`].
///
/// Failed is read FIRST, above the wait: an approval resumes the moment you answer it, a failed
/// call does not resume at all. Unlike the two rules below it, this one is not duplicated here —
/// the server derives it (`TreeSnapshot.error`) and the digest carries the answer, so the tray and
/// the browser's tab strip cannot disagree about whether a session is broken.
pub fn state_of(reading: &Reading) -> TrayState {
    let Some(entries) = reading.entries.as_ref().and_then(Value::as_array) else {
        return TrayState::Unreachable;
    };
    let failed = entries.iter().filter(|e| has_failed(e)).count();
    if failed > 0 {
        return TrayState::Failed { count: failed };
    }
    let count = entries.iter().filter(|e| needs_you(e)).count();
    if count > 0 {
        return TrayState::Waiting { count };
    }
    if entries.iter().any(is_working) {
        return TrayState::Working;
    }
    TrayState::Idle
}

/// Whether a digest entry is a session that is DOING something.
///
/// Not `status == "busy"` alone: Claude Code writes `shell` while a command the session launched in
/// the background is still running and the turn is over. Read as "not busy", such a session went
/// Idle on the panel and the icon went quiet, then both jumped back when the command finished —
/// reported from a real session, then reproduced by sampling CC's process file every 2 s across a
/// 240-second command.
///
/// The server's `isWorking` (`core/types.ts`) and the panel's `bandOf` are the same rule; this copy
/// exists because the tray links no seedeep code, and a test pins it to the server's own function.
fn is_working(entry: &Value) -> bool {
    entry["status"] == "busy" || entry["status"] == "shell"
}

/// Whether a digest entry is a session waiting on its user.
///
/// Not `status == "waiting"`: Claude Code writes that for EVERY open dialog, the model picker
/// included, so the raw status would turn the icon amber because somebody opened a menu. The two
/// labels below are the server's own rule (`client/sessions.ts`, `pendingInput`), and an
/// unrecognised one is deliberately not treated as a wait — an icon that cries wolf gets ignored
/// on the day it is right.
///
/// The same rule is in the panel (`bands.ts`, `bandOf`) because the tray links no seedeep code and
/// Rust cannot ask a webview. Both copies are pinned to the server's by tests that enumerate every
/// label Claude Code writes.
/// Whether a digest entry is a session whose last model call FAILED.
///
/// A FIELD, not a rule: `is_working` and `needs_you` are duplicated from the server because the
/// tray links no seedeep code, but this one is derived once by the reducer and shipped in the
/// payload, so there is nothing here to keep in sync. A missing key reads as healthy — an older
/// server that does not send the field must not paint every session red.
fn has_failed(entry: &Value) -> bool {
    !entry["error"].is_null()
}

fn needs_you(entry: &Value) -> bool {
    entry["status"] == "waiting"
        && (entry["waitingFor"] == "permission prompt" || entry["waitingFor"] == "input needed")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::Status;
    use serde_json::json;

    fn reading(entries: Value) -> Reading {
        Reading {
            status: Status::Connected {
                base_url: "http://127.0.0.1:44842".into(),
                fingerprint: None,
            },
            entries: Some(entries),
        }
    }

    fn session(status: &str, waiting_for: Option<&str>) -> Value {
        json!({ "status": status, "waitingFor": waiting_for })
    }

    /// A digest entry the [`Watch`] can identify, which the bare [`session`] deliberately cannot.
    fn waiting(id: &str) -> Value {
        json!({
            "sessionId": id,
            "project": "atlas",
            "subject": "add a retry to the uploader",
            "status": "waiting",
            "waitingFor": "permission prompt",
            "pendingTool": { "name": "Bash", "arg": "bun run build --force" },
        })
    }

    fn busy(id: &str) -> Value {
        json!({ "sessionId": id, "project": "atlas", "status": "busy", "waitingFor": null })
    }

    /// The same, at whatever status the case is about — `shell` is the one Claude Code writes while
    /// a background command runs on past the end of the turn.
    fn session_id(id: &str, status: &str) -> Value {
        json!({ "sessionId": id, "project": "atlas", "status": status, "waitingFor": null })
    }

    /// A session that has stopped working, with the last thing NOW said about it — what a finished
    /// turn looks like in the digest (`turn.state` + `turn.now`).
    fn settled(id: &str, state: &str, said: Option<&str>) -> Value {
        json!({
            "sessionId": id,
            "project": "atlas",
            "subject": "add a retry to the uploader",
            "status": "idle",
            "waitingFor": null,
            "turn": {
                "state": state,
                "now": said.map(|text| json!({ "kind": "output", "label": "output", "text": text, "ageFrom": null })),
            },
        })
    }

    /// A session whose last model call failed: the digest's `error`, as the server sends it.
    fn failing(id: &str, message: &str, agent: Option<&str>) -> Value {
        json!({
            "sessionId": id,
            "project": "atlas",
            "subject": "add a retry to the uploader",
            "status": "idle",
            "waitingFor": null,
            "error": { "at": 1_700_000_000_000_i64, "status": "429", "message": message, "agentId": agent },
        })
    }

    /// Every reading the tray could not make, which are all the same as far as the watch is
    /// concerned: it knows nothing, so the next digest it sees is a seed.
    fn blind() -> Reading {
        Reading {
            status: Status::Offline {
                base_url: "https://box.local:44842".into(),
                detail: "not answering".into(),
            },
            entries: None,
        }
    }
    // The whole set of labels Claude Code writes, from `open-sessions.ts`. Only two of them mean a
    // human is being waited on, and the icon must not go amber for the other three — that is the
    // difference between a signal and a colour that is on most of the time.
    #[test]
    fn only_a_wait_on_the_human_turns_the_icon_amber() {
        for label in ["permission prompt", "input needed"] {
            assert_eq!(
                state_of(&reading(json!([session("waiting", Some(label))]))),
                TrayState::Waiting { count: 1 },
                "{label} is a wait on the user"
            );
        }
        for label in ["dialog open", "sandbox request", "worker request"] {
            assert_eq!(
                state_of(&reading(json!([session("waiting", Some(label))]))),
                TrayState::Idle,
                "{label} is a dialog the user opened themselves"
            );
        }
    }

    #[test]
    fn the_count_is_the_sessions_stopped_on_you() {
        let state = state_of(&reading(json!([
            session("waiting", Some("permission prompt")),
            session("busy", None),
            session("waiting", Some("input needed")),
            session("idle", None),
        ])));

        assert_eq!(state, TrayState::Waiting { count: 2 });
    }

    // Waiting outranks working: with both on screen the icon has to say the one the user can act on.
    #[test]
    fn working_is_what_is_left_when_nobody_is_waiting() {
        assert_eq!(
            state_of(&reading(json!([session("idle", None), session("busy", None)]))),
            TrayState::Working
        );
        assert_eq!(state_of(&reading(json!([session("idle", None)]))), TrayState::Idle);
        assert_eq!(state_of(&reading(json!([]))), TrayState::Idle);
    }

    // A session running a command it launched in the background is working, and Claude Code says so
    // with a word of its own. Read as "not busy", the icon went quiet while the command ran and lit
    // up again when it ended — the opposite of what the icon is for.
    #[test]
    fn a_background_command_keeps_the_icon_working() {
        assert_eq!(
            state_of(&reading(json!([session("shell", None)]))),
            TrayState::Working
        );
        // And it does not outrank a session stopped on the user, like every other kind of work.
        assert_eq!(
            state_of(&reading(json!([
                session("shell", None),
                session("waiting", Some("permission prompt"))
            ]))),
            TrayState::Waiting { count: 1 }
        );
    }

    // The distinction the icon exists to make: a server that says nothing is running, versus a tray
    // that cannot see one. The second must never look like the first.
    #[test]
    fn nothing_to_read_is_never_drawn_as_nothing_running() {
        let unreadable = Reading {
            status: Status::Offline {
                base_url: "https://box.local:44842".into(),
                detail: "not answering".into(),
            },
            entries: None,
        };

        assert_eq!(state_of(&unreadable), TrayState::Unreachable);
    }

    // A digest whose entries are not the shape we expect must not be read as an empty machine: a
    // schema change is the tray's one recurring risk, and Unreachable is the state that says so.
    #[test]
    fn a_digest_that_is_not_a_list_is_unreachable() {
        let odd = Reading {
            status: Status::Connected {
                base_url: "http://127.0.0.1:44842".into(),
                fingerprint: None,
            },
            entries: Some(json!({ "sessions": [] })),
        };

        assert_eq!(state_of(&odd), TrayState::Unreachable);
    }

    // The icon's precedence, and the reason for it: an approval resumes the instant it is answered,
    // a failed call does not resume at all. A tray that showed the amber while a session was broken
    // would be pointing at the less urgent of the two.
    #[test]
    fn a_failed_session_outranks_one_waiting_on_you() {
        assert_eq!(
            state_of(&reading(json!([failing("a", "API Error: 429 rate limit", None)]))),
            TrayState::Failed { count: 1 }
        );
        assert_eq!(
            state_of(&reading(json!([
                waiting("a"),
                failing("b", "API Error: 429 rate limit", None),
                session("busy", None),
            ]))),
            TrayState::Failed { count: 1 },
            "one broken session decides the icon, whatever else is going on"
        );
    }

    // The field is the server's answer, and its ABSENCE must read as healthy: an older server that
    // does not send it would otherwise paint every session on the machine red.
    #[test]
    fn a_payload_without_the_field_is_not_a_failure() {
        assert_eq!(state_of(&reading(json!([session("idle", None)]))), TrayState::Idle);
        assert_eq!(
            state_of(&reading(json!([{ "status": "idle", "waitingFor": null, "error": null }]))),
            TrayState::Idle,
            "an explicit null is the healthy case, not a missing one"
        );
    }

}
