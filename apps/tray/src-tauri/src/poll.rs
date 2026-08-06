//! The tray's clock, and the only thing that reads the server on its own initiative.
//!
//! It lives in Rust rather than in the panel for two reasons, and the second is the one that
//! decides it: the icon has to be right BEFORE anybody has ever clicked it, and a hidden window's
//! timers are throttled by the platform. (The hidden webview does RUN — measured 2026-07-30,
//! correcting an earlier claim in this file that macOS did not load it at all — so the argument is
//! not that the panel is asleep; it is that a clock the menu bar depends on must not be one the
//! platform is free to slow down.)
//!
//! So the loop runs whether or not there is a window, sets the icon from every reading, notifies on
//! the transitions worth interrupting for, and pushes the same reading to the panel when one is
//! open. One reading, one truth: the rows and the icon can never disagree about what the server
//! said.

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
    /// What the sessions were doing last time — who was waiting on the human, and who was at work —
    /// so a notification fires on the transition rather than on the state. See [`Watch`].
    watch: Mutex<Watch>,
    /// Which version the user has already been told about, and when the registry answer was last
    /// asked for. Separate from [`Watch`] because it is not about sessions at all.
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
            watch: Mutex::new(Watch::default()),
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
    pub fn spawn(self: Arc<Self>, app: AppHandle) {
        self.clone().spin(app.clone());
        tauri::async_runtime::spawn(async move {
            loop {
                let tick = self.tick().await;
                // From the reading, not from the tick: what the icon says cannot depend on whether
                // somebody has the panel open.
                self.paint(&app, state_of(&tick.reading));
                self.announce(&app, &tick.reading);
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

    /// Interrupt the user for every session that has just stopped on them, and — if they asked for
    /// it — for every session that has just finished a turn.
    ///
    /// The transitions are tracked WHATEVER the settings say, and a setting gates only the banner:
    /// otherwise turning notifications back on would announce every session that had been waiting
    /// all along, which is the exact lie the seed rule exists to prevent. A toggle silences the
    /// interruption, not the bookkeeping.
    fn announce(&self, app: &AppHandle, reading: &Reading) {
        let entering = self.watch.lock().unwrap().step(reading);
        let prefs = self.prefs.get();
        // Per announcement, not once for the batch: the two kinds are two separate switches, and a
        // reading can carry one of each.
        for announcement in entering.into_iter().filter(|a| match a.kind {
            Kind::Waiting => prefs.notify,
            Kind::Finished => prefs.notify_finished,
            Kind::Failed => prefs.notify_failed,
        }) {
            // Discarded on purpose, and it would be discarded even if it were checked: `show`
            // returns `Ok(())` in the case where nothing is delivered at all (measured — see
            // `docs/tray.md`), so there is no outcome here worth branching on. A tray cannot report
            // a failed notification through a notification.
            let _ = app
                .notification()
                .builder()
                .title(announcement.title)
                .body(announcement.body)
                .show();
        }
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

/// Which switch an announcement answers to — see [`Poller::announce`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// A session stopped on the human.
    Waiting,
    /// A session that was working has finished its turn.
    Finished,
    /// A session's model call failed, and nothing has recovered from it.
    Failed,
}

/// What one notification says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Announcement {
    pub kind: Kind,
    pub title: String,
    pub body: String,
}

/// What the sessions were doing last time we could see, so a notification fires on the TRANSITION
/// and not on every poll that finds the same session in the same state.
///
/// Sessions are remembered by id rather than counted: a count would stay at one while one session
/// was answered and another stopped in the same interval, which is precisely the event worth an
/// interruption.
#[derive(Debug, Default)]
pub struct Watch {
    /// `None` until the tray has actually SEEN a digest, and back to `None` after any reading it
    /// could not make. That is what makes the first sight a SEED rather than an announcement: a
    /// session already waiting when the tray connects — or when it reconnects after the server
    /// restarted — is not something that just happened, and saying so would misdate it.
    seen: Option<Seen>,
}

/// One reading's worth of memory: who was stopped on the human, and who was at work.
#[derive(Debug, Default)]
struct Seen {
    waiting: HashSet<String>,
    working: HashSet<String>,
    failed: HashSet<String>,
}

impl Watch {
    /// Fold one reading in, and return what the user should be told about.
    ///
    /// LIMIT: a session that enters a wait — or finishes — DURING a stretch the tray could not read
    /// is never announced; on the next reading it is part of the seed. That is the honest choice:
    /// the tray does not know when it happened, and a state with no time behind it is what the icon
    /// and the panel are for.
    pub fn step(&mut self, reading: &Reading) -> Vec<Announcement> {
        let Some(entries) = reading.entries.as_ref().and_then(Value::as_array) else {
            self.seen = None;
            return Vec::new();
        };
        // An entry with no id is skipped entirely rather than announced: it cannot be remembered,
        // so it would be new again on every single tick.
        let identified: Vec<(&str, &Value)> = entries
            .iter()
            .filter_map(|e| e["sessionId"].as_str().map(|id| (id, e)))
            .collect();
        let now = Seen {
            waiting: ids(&identified, needs_you),
            working: ids(&identified, is_working),
            failed: ids(&identified, has_failed),
        };
        let Some(before) = self.seen.replace(now) else {
            return Vec::new();
        };
        identified
            .iter()
            .filter_map(|(id, entry)| {
                // Read first, for the reason the icon reads it first: a session that just broke is
                // the more serious of the two, and one moment must not raise two banners. A failure
                // that persists announces ONCE — the set is what makes this a transition — and the
                // next one only after a successful call has cleared it.
                if has_failed(entry) && !before.failed.contains(*id) {
                    return Some(failed_announcement(entry));
                }
                if needs_you(entry) && !before.waiting.contains(*id) {
                    return Some(waiting_announcement(entry));
                }
                // A session that has STOPPED working, which is not the same as one that is no
                // longer busy: a session that went from busy to waiting is stopped on the user, and
                // the wait above is what that event is called. Reading it as "finished" too would
                // put two banners on one moment. `shell` is excluded for the same reason from the
                // other side — the turn is over but a command it launched is still running, and
                // announcing "Finished" there would be a banner for something still going.
                if entry["status"] == "idle" && before.working.contains(*id) {
                    return finished_announcement(entry);
                }
                None
            })
            .collect()
    }
}

/// The ids of the entries a predicate holds for.
fn ids(entries: &[(&str, &Value)], is: impl Fn(&Value) -> bool) -> HashSet<String> {
    entries
        .iter()
        .filter(|(_, e)| is(e))
        .map(|(id, _)| (*id).to_string())
        .collect()
}

/// Which session a banner is about: `project — subject`, or the project alone when the session has
/// no subject yet. The banner already carries the app's name, so the title is spent on the one
/// thing the user has to know first — which of their projects this is.
fn session_title(entry: &Value) -> String {
    let project = entry["project"].as_str().unwrap_or("A session");
    match entry["subject"].as_str().filter(|s| !s.is_empty()) {
        Some(subject) => format!("{project} — {subject}"),
        None => project.to_string(),
    }
}

/// The words one finished turn gets, or `None` when the turn is one the user ended themselves.
///
/// **An interrupted turn is not news**: pressing Esc is the user standing at that terminal, and
/// telling them what they just did is the definition of a banner that gets muted. What the body
/// carries is `turn.now.text` — literally the line the Idle band draws, from the server's one
/// `nowLine`, so the banner and the row it belongs to cannot word the same event differently. That
/// is normally the agent's own answer (measured over 13 settled sessions, present in 12) and, on the
/// one that worked after its last word, the count of what it did. A turn with nothing on record
/// still gets a banner, because the event is the session becoming yours again, not the text.
fn finished_announcement(entry: &Value) -> Option<Announcement> {
    if entry["turn"]["state"] == "interrupted" {
        return None;
    }
    let mut body = "Finished".to_string();
    // Its own line, and left to the OS to truncate — the server already caps it at `PROMPT_HEAD`.
    if let Some(said) = entry["turn"]["now"]["text"].as_str().filter(|r| !r.is_empty()) {
        body.push('\n');
        body.push_str(said);
    }
    Some(Announcement {
        kind: Kind::Finished,
        title: session_title(entry),
        body,
    })
}

/// The words one failed session gets.
///
/// The body is the message Claude Code showed the user, verbatim from the digest — "Not logged in ·
/// Please run /login", "You've hit your session limit", "API Error: 529 Overloaded". Naming the
/// error ourselves would mean inventing a taxonomy on top of one the CLI already wrote, and the
/// user has to recognise the same words they would see in the terminal. A subagent's failure says
/// so, because "a subagent failed" and "your session failed" call for different reactions.
fn failed_announcement(entry: &Value) -> Announcement {
    let error = &entry["error"];
    let mut body = if error["agentId"].is_null() {
        "The last API call failed".to_string()
    } else {
        "A subagent's API call failed".to_string()
    };
    // Its own line, and left to the OS to truncate: the message is the only thing that says whether
    // this needs a /login, a wait, or nothing at all. The server already caps it.
    if let Some(message) = error["message"].as_str().filter(|m| !m.is_empty()) {
        body.push('\n');
        body.push_str(message);
    }
    Announcement {
        kind: Kind::Failed,
        title: session_title(entry),
        body,
    }
}

/// The words one waiting session gets.
///
/// The phrasing is the portal's and the panel's — `Waiting for your approval` / `for your answer`,
/// `in the terminal` when the transcript has not named the call — because a notification that
/// describes the same event in different words from the panel it belongs to teaches the user to
/// trust neither.
fn waiting_announcement(entry: &Value) -> Announcement {
    let title = session_title(entry);
    let what = if entry["waitingFor"] == "input needed" {
        "Waiting for your answer"
    } else {
        "Waiting for your approval"
    };
    let tool = &entry["pendingTool"];
    let mut body = match tool["name"].as_str() {
        Some(name) => format!("{what} — {name}"),
        None => format!("{what} in the terminal"),
    };
    // Its own line, and left to the OS to truncate: this is the one thing that answers "do I say
    // yes", and a command elided by us is a command nobody can judge.
    if let Some(arg) = tool["arg"].as_str().filter(|a| !a.is_empty()) {
        body.push('\n');
        body.push_str(arg);
    }
    Announcement {
        kind: Kind::Waiting,
        title,
        body,
    }
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

    // The rule the card states outright: a session already stopped when the tray connects is not
    // something that just happened. Announcing it would put a banner on an event that may be hours
    // old — and would do it again on every restart of the tray.
    #[test]
    fn a_session_already_waiting_when_the_tray_connects_is_not_news() {
        let mut watch = Watch::default();

        assert!(watch.step(&reading(json!([waiting("a")]))).is_empty());
    }

    #[test]
    fn entering_a_wait_announces_once_and_not_again() {
        let mut watch = Watch::default();
        watch.step(&reading(json!([busy("a")])));

        let first = watch.step(&reading(json!([waiting("a")])));
        assert_eq!(first.len(), 1, "the transition is the event");

        assert!(
            watch.step(&reading(json!([waiting("a")]))).is_empty(),
            "still waiting is not entering a wait"
        );
    }

    // Answering one prompt and being asked another IS a second interruption — which is why the
    // watch remembers ids rather than a count.
    #[test]
    fn asked_again_after_being_answered_is_a_second_event() {
        let mut watch = Watch::default();
        watch.step(&reading(json!([waiting("a")])));
        watch.step(&reading(json!([busy("a")])));

        assert_eq!(watch.step(&reading(json!([waiting("a")]))).len(), 1);
    }

    // Two sessions, and only the one that moved. The count would say "still two" and stay silent.
    #[test]
    fn one_stopping_while_another_is_answered_is_announced() {
        let mut watch = Watch::default();
        watch.step(&reading(json!([waiting("a"), busy("b")])));

        let entering = watch.step(&reading(json!([busy("a"), waiting("b")])));

        assert_eq!(entering.len(), 1);
    }

    // A server that restarts, a machine that sleeps, a tray that has just started: after any of
    // them the first digest is a seed. Otherwise every reconnection would replay every open prompt.
    #[test]
    fn the_first_reading_after_a_blind_stretch_is_a_seed() {
        let mut watch = Watch::default();
        watch.step(&reading(json!([waiting("a")])));
        watch.step(&blind());

        assert!(
            watch.step(&reading(json!([waiting("a")]))).is_empty(),
            "nothing happened while we could not see"
        );
    }

    // The same rule as the icon's, through the same function: a dialog the user opened themselves
    // must not produce a banner. A notification that cries wolf is one the user turns off.
    #[test]
    fn only_a_wait_on_the_human_is_announced() {
        let mut watch = Watch::default();
        watch.step(&reading(json!([busy("a")])));

        let mut entry = waiting("a");
        entry["waitingFor"] = json!("dialog open");

        assert!(watch.step(&reading(json!([entry]))).is_empty());
    }

    // An entry the watch cannot identify would be "new" on every single tick, so it is not
    // announced at all — a schema change must not turn into a banner every second.
    #[test]
    fn a_session_without_an_id_is_never_announced() {
        let mut watch = Watch::default();
        watch.step(&reading(json!([busy("a")])));
        let anonymous = json!([session("waiting", Some("permission prompt"))]);

        assert!(watch.step(&reading(anonymous.clone())).is_empty());
        assert!(watch.step(&reading(anonymous)).is_empty(), "nor on the tick after");
    }

    // The second event the tray announces, and the one the card asked for: a session that was
    // working is yours again. Its body is the agent's own last words, which is what the Idle band
    // shows — a settled turn has a `result` and no activity.
    #[test]
    fn a_session_that_stops_working_says_so_and_says_what_it_said() {
        let mut watch = Watch::default();
        watch.step(&reading(json!([busy("a")])));

        let done = watch.step(&reading(json!([settled("a", "done", Some("Pushed 00cbf9b..35b1f46."))])));

        assert_eq!(done.len(), 1);
        assert_eq!(done[0].kind, Kind::Finished);
        assert_eq!(done[0].title, "atlas — add a retry to the uploader");
        assert_eq!(done[0].body, "Finished\nPushed 00cbf9b..35b1f46.");
        assert!(
            watch
                .step(&reading(json!([settled("a", "done", Some("Pushed 00cbf9b..35b1f46."))])))
                .is_empty(),
            "still idle is not finishing"
        );
    }

    // Esc is the user standing at that terminal. A banner telling them what they just did is the
    // definition of a notification that gets muted — and muting it takes the approvals with it.
    #[test]
    fn a_turn_the_user_interrupted_is_not_announced() {
        let mut watch = Watch::default();
        watch.step(&reading(json!([busy("a")])));

        assert!(watch.step(&reading(json!([settled("a", "interrupted", None)]))).is_empty());
    }

    // The event is the session becoming the user's again, not the text. A turn whose answer the
    // transcript has not recorded still finished.
    #[test]
    fn a_finished_turn_with_nothing_on_record_still_announces() {
        let mut watch = Watch::default();
        watch.step(&reading(json!([busy("a")])));

        let done = watch.step(&reading(json!([settled("a", "done", None)])));

        assert_eq!(done.len(), 1);
        assert_eq!(done[0].body, "Finished");
    }

    // busy → waiting is a session stopped ON the user, which already has a banner and a band. Read
    // as "finished" as well it would put two notifications on one moment, saying opposite things.
    #[test]
    fn stopping_on_an_approval_is_a_wait_and_not_a_finish() {
        let mut watch = Watch::default();
        watch.step(&reading(json!([busy("a")])));

        let entering = watch.step(&reading(json!([waiting("a")])));

        assert_eq!(entering.len(), 1);
        assert_eq!(entering[0].kind, Kind::Waiting);
    }

    // A session the tray has never seen working did not just finish: it was already idle when we
    // first looked. Same seed rule as the wait, and the same reason — the tray must not date an
    // event it did not witness.
    #[test]
    fn a_session_already_idle_when_the_tray_connects_is_not_news() {
        let mut watch = Watch::default();

        assert!(watch.step(&reading(json!([settled("a", "done", Some("done"))]))).is_empty());
        assert!(
            watch.step(&reading(json!([settled("a", "done", Some("done"))]))).is_empty(),
            "nor on the tick after"
        );
    }

    // A session that is CLOSED rather than finished simply leaves the digest. Nothing is announced:
    // the user closed it, and Davide's decision was that only a finished turn is news.
    #[test]
    fn a_session_that_disappears_announces_nothing() {
        let mut watch = Watch::default();
        watch.step(&reading(json!([busy("a"), busy("b")])));

        assert!(watch.step(&reading(json!([busy("b")]))).is_empty());
    }

    // The words are the panel's and the portal's, deliberately — the same event described twice in
    // different terms is how a user learns to distrust both surfaces.
    #[test]
    fn the_notification_says_which_session_and_what_it_asked() {
        let mut watch = Watch::default();
        watch.step(&reading(json!([busy("a")])));

        let entering = watch.step(&reading(json!([waiting("a")])));

        let it = &entering[0];
        assert_eq!(it.title, "atlas — add a retry to the uploader");
        assert_eq!(it.body, "Waiting for your approval — Bash\nbun run build --force");
    }

    #[test]
    fn a_question_is_not_called_an_approval() {
        let mut watch = Watch::default();
        watch.step(&reading(json!([busy("a")])));
        let mut entry = waiting("a");
        entry["subject"] = Value::Null;
        entry["waitingFor"] = json!("input needed");
        entry["pendingTool"] = Value::Null;

        let entering = watch.step(&reading(json!([entry])));

        assert_eq!(entering[0].title, "atlas", "no subject leaves the project alone");
        assert_eq!(
            entering[0].body, "Waiting for your answer in the terminal",
            "an unnamed call is still a wait the user has to go and answer"
        );
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

    // The banner says a session became yours again. A turn that ended while its background command
    // runs has NOT: announcing it there would put "Finished" on something still going, and would
    // then have nothing left to say when it really did finish.
    #[test]
    fn finishing_is_not_announced_while_a_background_command_runs() {
        let mut watch = Watch::default();
        watch.step(&reading(json!([busy("a")])));

        let during = watch.step(&reading(json!([session_id("a", "shell")])));
        assert!(during.is_empty(), "the turn ended but the command has not");

        let after = watch.step(&reading(json!([settled("a", "done", Some("Pushed it."))])));
        assert_eq!(after.len(), 1, "the real end is the one that is announced");
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

    // What the user is told, in Claude Code's own words. Inventing our own name for the error would
    // mean the banner and the terminal describe the same failure differently.
    #[test]
    fn the_failure_notification_carries_the_message_the_cli_showed() {
        let mut watch = Watch::default();
        watch.step(&reading(json!([busy("a")])));

        let entering = watch.step(&reading(json!([failing("a", "Not logged in \u{b7} Please run /login", None)])));

        assert_eq!(entering.len(), 1);
        assert_eq!(entering[0].kind, Kind::Failed);
        assert_eq!(entering[0].title, "atlas \u{2014} add a retry to the uploader");
        assert_eq!(
            entering[0].body,
            "The last API call failed\nNot logged in \u{b7} Please run /login"
        );
    }

    // A subagent's failure and the session's own call for different reactions, so the banner says
    // which it was.
    #[test]
    fn a_subagents_failure_says_so() {
        let mut watch = Watch::default();
        watch.step(&reading(json!([busy("a")])));

        let entering = watch.step(&reading(json!([failing("a", "API Error: 429 rate limit", Some("ag1"))])));

        assert!(
            entering[0].body.starts_with("A subagent's API call failed"),
            "got {:?}",
            entering[0].body
        );
    }

    // A failure that persists is not news on every tick — the same rule the wait obeys. And a
    // recovery re-arms it, so the NEXT failure is announced again.
    #[test]
    fn a_failure_announces_once_and_re_arms_after_a_recovery() {
        let mut watch = Watch::default();
        watch.step(&reading(json!([busy("a")])));
        assert_eq!(watch.step(&reading(json!([failing("a", "boom", None)]))).len(), 1);

        assert!(
            watch.step(&reading(json!([failing("a", "boom", None)]))).is_empty(),
            "still broken is not new"
        );

        watch.step(&reading(json!([busy("a")]))); // a call succeeded: the server cleared it
        assert_eq!(
            watch.step(&reading(json!([failing("a", "boom again", None)]))).len(),
            1,
            "the next failure is news again"
        );
    }

    // One moment, one banner: a session that fails while it was also stopped on the user must not
    // raise both. The failure is the more serious answer, and it is the one that fires.
    #[test]
    fn a_session_that_breaks_while_waiting_raises_one_banner() {
        let mut watch = Watch::default();
        watch.step(&reading(json!([busy("a")])));
        let mut entry = failing("a", "boom", None);
        entry["status"] = json!("waiting");
        entry["waitingFor"] = json!("permission prompt");

        let entering = watch.step(&reading(json!([entry])));

        assert_eq!(entering.len(), 1);
        assert_eq!(entering[0].kind, Kind::Failed);
    }
}
