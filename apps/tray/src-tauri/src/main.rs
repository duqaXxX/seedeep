mod client;
mod connection;
mod icon;
mod local;
mod pin;
mod poll;
mod store;
mod update;

use std::sync::Arc;
use std::time::Duration;

use client::{Conn, Status};
use local::LocalServer;
use poll::{Poller, Tick};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, PhysicalPosition, Rect, State, WindowEvent};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

/// Env flag that sends one notification at startup and prints the outcome, then keeps running.
/// Not a feature and never set for a user: it is how the unsigned-macOS check recorded in
/// `docs/tray.md` is REPRODUCED on a later OS or Tauri release. A claim about an OS's behaviour
/// that cannot be re-run is a claim that quietly expires.
///
/// Deliberately NOT gated on the notification setting: it probes the platform, not the feature, and
/// a probe that silently does nothing because of a preference would be worse than no probe.
const NOTIFY_PROBE: &str = "SEEDEEP_TRAY_NOTIFY_PROBE";

/// Env flag that shows the popover at startup. Never set for a user: it exists because opening the
/// popover needs a click on the menu bar, which is the one thing no test can perform, and LOOKING at
/// the panel is how a layout is reviewed.
///
/// It does NOT exist to make the webview run. That was the reason given when it was added, and a
/// re-measurement on 2026-07-30 withdrew it: with the window never shown, the hidden popover's
/// webview loads and executes `panel.ts` anyway — it called `tick` with the panel closed, which is
/// the only path to that command. So the panel is alive before it is visible, and what the flag buys
/// is a look at it.
const SHOW_PANEL: &str = "SEEDEEP_TRAY_SHOW_PANEL";

/// A file in the tray's config directory that, when it exists, is OVERWRITTEN at startup with the
/// environment the tray was launched into and what it found: create it empty to ask, read it to see.
///
/// It is how the claim `local.rs` is built on — that a GUI app inherits
/// `/usr/bin:/bin:/usr/sbin:/sbin`, so neither `seedeep` nor `npm` is on it — is RE-RUN on a later
/// macOS or Tauri release. A claim about an OS's behaviour that cannot be re-run quietly expires.
///
/// A FILE, where {@link NOTIFY_PROBE} is an env var, and the reason is the very thing under test:
/// the launch that matters is the one a user performs, and a Finder launch inherits neither the
/// terminal's environment nor `launchctl setenv` (measured 2026-08-04 — the variable was simply
/// absent). A file is the only channel into a process nobody can hand arguments to.
const LOCATE_PROBE: &str = "locate-probe";

/// The ONE variable that decides which seedeep this process belongs to.
///
/// Set, it is a development world: the server keeps its state there (`bun run dev`) and the tray
/// keeps `connection.json` in `<it>/tray`. Unset, it is the installed world —
/// `~/.seedeep` and the app's own config directory.
///
/// One variable and not two, which is what it was. The tray had a `SEEDEEP_TRAY_HOME` of its own,
/// and the two were always set together and only ever meant the same thing — so a dev run moved the
/// tray's files but left it watching the INSTALLED server, and pointing it at the dev one was a URL
/// pasted by hand. Two names for one idea is the thing that made the setup hard to explain.
///
/// A GUI app inherits no shell environment (measured: a Finder launch sees neither the terminal's
/// variables nor `launchctl setenv`), and that is what guarantees the installed tray is always the
/// installed world without anyone having to remember it.
const SEEDEEP_HOME: &str = "SEEDEEP_HOME";

/// The popover's window label. Named once because two places have to agree on it: the lookup
/// that shows it, and the focus-loss handler that decides whether a window is dismissable.
const PANEL: &str = "panel";

/// Gap kept between the popover and the edge of the screen, in points.
const PANEL_MARGIN: f64 = 6.0;

/// Floor on the popover's height, in points. Not a layout choice — a backstop: a webview that
/// reports 0 (measured before it has laid anything out, or during a reload) would otherwise
/// collapse the window to nothing, and a popover with no height cannot be clicked to recover.
const PANEL_MIN_H: f64 = 90.0;

/// The beat between the popover going away and the test banner being posted.
///
/// macOS does not PRESENT a notification posted by the frontmost app — Apple's own
/// `NSUserNotification.h` says so on `shouldPresentNotification:` ("the Notification Center has
/// decided not to present your notification, for example when your application is front most"), and
/// that callback is the only way to override it. `mac-notification-sys` does not implement it, so
/// there is nothing of ours to answer YES with: the tray has to stop being frontmost instead.
///
/// Hiding the popover is what does that, and the activation it hands back is the window server's to
/// perform — it lands on a later turn of the run loop than the click that asked for it. Posting in
/// the same breath posts while the rule still applies, which is the whole bug. Generous on purpose:
/// nobody is waiting on a banner they asked to see with the panel out of the way.
const NOTIFY_SETTLE: Duration = Duration::from_millis(400);

/// The height the popover should take to show `content`, given where its top edge is and how much
/// screen there is below it.
///
/// Pure, and tested: the two failure modes are a window taller than the screen (the bottom of the
/// list unreachable, since a popover cannot be dragged) and a window collapsed to nothing. Both are
/// arithmetic, and neither is observable from an SSH shell — which is the whole reason this is a
/// function and not three lines inside a command.
///
/// `top` and `available_bottom` are in the same units as `content` (points). A screen with no room
/// at all still yields {@link PANEL_MIN_H}: better a panel that overhangs than one that vanishes.
fn panel_height(content: f64, top: f64, available_bottom: f64) -> f64 {
    let room = available_bottom - top - PANEL_MARGIN;
    // `min` then `max`, never `clamp`: with less room than the floor the range inverts, and
    // `clamp` panics on an inverted range (the same trap the x position already documents).
    content.min(room).max(PANEL_MIN_H)
}

/// Where the tray keeps `connection.json`: under {@link SEEDEEP_HOME} when that is set to something,
/// the app's own config directory otherwise.
///
/// A `tray` subdirectory rather than the home itself, so one variable names one world and the two
/// apps inside it do not write over each other's files.
///
/// Made absolute, because a dev script points it INSIDE the checkout and `tauri dev` does not run
/// from the repository root — a relative value read literally would leave the state wherever the
/// process happened to start. An empty value is no value: `SEEDEEP_HOME=` in a script that forgot to
/// fill it in would otherwise put both files in the process's cwd.
fn config_root(from_env: Option<std::ffi::OsString>, fallback: std::path::PathBuf) -> std::path::PathBuf {
    match from_env.map(std::path::PathBuf::from).filter(|p| !p.as_os_str().is_empty()) {
        Some(dir) => std::path::absolute(&dir).unwrap_or(dir).join("tray"),
        None => fallback,
    }
}

/// Tell the poll the panel's visibility, if there is a poll yet.
///
/// `try_state`, never `state`: the latter PANICS when the type has not been managed (documented on
/// `Manager`), and window events are not ordered after `setup` — a focus change delivered to the
/// popover before the poll is managed would take the whole app down, which for a tray means the icon
/// disappearing, the one thing `docs/tray.md` says must never happen. A cadence that stays where it
/// was for one tick is not worth a crash.
fn set_panel_open(app: &AppHandle, open: bool) {
    if let Some(poller) = app.try_state::<Arc<Poller>>() {
        poller.set_open(open);
    }
}

/// Show the panel under the tray icon, or hide it if it is already up.
///
/// `rect` is where the OS actually drew the icon — the only reliable anchor, since a menu bar
/// reorders itself as other apps come and go and a remembered position would drift.
fn toggle_panel(app: &AppHandle, rect: Rect) {
    let Some(win) = app.get_webview_window(PANEL) else { return };
    if win.is_visible().unwrap_or(false) {
        let _ = win.hide();
        set_panel_open(app, false);
        return;
    }
    // Before the window is shown, so the faster cadence covers the reading the panel is about to
    // ask for rather than starting one tick behind it.
    set_panel_open(app, true);
    if let (Ok(scale), Ok(size)) = (win.scale_factor(), win.outer_size()) {
        let anchor = rect.position.to_physical::<f64>(scale);
        let icon = rect.size.to_physical::<f64>(scale);
        let centred = anchor.x + icon.width / 2.0 - size.width as f64 / 2.0;
        // Merely centring hangs the panel off the screen: the menu bar's right-hand end is
        // where the icon usually sits, and a 392 pt panel centred there loses everything past
        // the edge. Clamp to the work area of the monitor UNDER THE ICON — `current_monitor`
        // would answer for a window that is still hidden and has no position worth trusting.
        let x = match win.monitor_from_point(anchor.x, anchor.y) {
            Ok(Some(mon)) => {
                let area = mon.work_area();
                let margin = PANEL_MARGIN * scale;
                let left = f64::from(area.position.x) + margin;
                let right = f64::from(area.position.x + area.size.width as i32)
                    - size.width as f64
                    - margin;
                // `min` before `max`, not `clamp`: a panel wider than the screen would make
                // `right < left`, and `clamp` panics on an inverted range.
                centred.min(right).max(left)
            }
            _ => centred,
        };
        let _ = win.set_position(PhysicalPosition::new(x, anchor.y + icon.height));
    }
    let _ = win.show();
    let _ = win.set_focus();
}

/// One reading: where the connection stands, and the digest when it can be read. The panel's first
/// call, and the only one it needs — after this the poll pushes the same shape on its own clock.
/// Through the poll, not the connection: the reading has to be stamped with whether the panel is
/// open, and the poll is what knows. Two producers of the same payload would be two chances to
/// disagree.
///
/// `Result` because Tauri requires one of any async command taking a borrowed input; a reading
/// itself cannot fail — a server that cannot be read is a `Status`, which is half of what it returns.
#[tauri::command]
async fn tick(poller: State<'_, Arc<Poller>>) -> Result<Tick, ()> {
    Ok(poller.tick().await)
}

/// The panel's "try again": look for seedeep again, then read.
///
/// A command of its own rather than a second `tick` because the two gestures differ in one way that
/// matters — this one is the user saying "I have changed something", and the throttle on the lookup
/// has to be cleared for it. Somebody who installs seedeep with the panel open has no other way to
/// say so, and quitting the tray is not an answer.
///
/// The look is AWAITED, and that is the whole command. `tick` reaches the lookup through
/// `look_soon`, which starts a shell in the background and returns `None` the same instant — so
/// forgetting and then ticking could only ever answer "not installed", deterministically, to the
/// very gesture that means "look again". The person who had just installed seedeep was told it was
/// not there, and the real answer arrived up to five seconds later with the next automatic tick.
#[tauri::command]
async fn look_again(poller: State<'_, Arc<Poller>>, local: State<'_, Arc<LocalServer>>) -> Result<Tick, ()> {
    local.forget();
    local.executable().await;
    Ok(poller.tick().await)
}

/// Start the server on this machine and wait until it says it is up.
///
/// Answers when the outcome is known, not when the process was spawned: what is on `PATH` may be
/// npm's placeholder, and the only proof of a start is the server announcing itself. The panel shows
/// the failure verbatim, which for that case is the sentence the placeholder exists to print.
///
/// Aimed at the address the panel NAMES, the same way a stop is: the button sits under a screen
/// saying that address is not answering, so a server started anywhere else would not be the one it
/// offered — see {@link Conn::start_port}.
#[tauri::command]
async fn start_server(conn: State<'_, Arc<Conn>>, local: State<'_, Arc<LocalServer>>) -> Result<(), String> {
    local.start(conn.start_port()).await
}

/// Stop the server the panel is connected to.
///
/// Aimed at the connection rather than at "the local server": the tray stops what it is showing, and
/// a machine running two seedeeps has two records to tell apart. Refuses rather than guesses when
/// they cannot be told apart — see `LocalServer::stop`.
#[tauri::command]
async fn stop_server(conn: State<'_, Arc<Conn>>, local: State<'_, Arc<LocalServer>>) -> Result<(), String> {
    let base_url = conn.base_url().ok_or("There is no connection to stop.")?;
    local.stop(&base_url).await
}

/// Which release the connected server is. Read when the settings view opens, never on the poll.
///
/// `Ok(None)` is a server that did not say, and the section then draws nothing: the tray's own
/// version is not an answer to what the server's is, and the two are updated apart.
#[tauri::command]
async fn server_version(conn: State<'_, Arc<Conn>>) -> Result<Option<String>, ()> {
    Ok(conn.server_version().await)
}

/// Whether the connected server is running a configuration `config.json` no longer describes.
///
/// Asked when the popover opens rather than on the poll — the value moves only when a human edits
/// the file or saves the panel, and the moment the icon is clicked is the moment it is read.
#[tauri::command]
async fn restart_pending(conn: State<'_, Arc<Conn>>) -> Result<bool, ()> {
    Ok(conn.restart_pending().await)
}

/// What the About section needs to mark a version as behind: npm's newest, and which of the two
/// installs is older than it.
///
/// Both comparisons happen in Rust so they exist once — a second implementation in TypeScript could
/// disagree with the banner about the same machine. The SERVER's verdict is the server's own
/// (`standing`), which is also what the portal shows; the TRAY's is computed here, because nothing
/// else knows this build's version.
///
/// Only the panel uses `tray_behind`: the NOTIFICATION is about the server alone (the maintainer's call,
/// 2026-08-05), since that is the thing being run and the one a stale version actually affects.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateView {
    latest: Option<String>,
    tray_behind: bool,
    server_behind: bool,
    /// The command that updates the SERVER, straight from the server — the tray cannot know how a
    /// machine installed it, and telling a user to "update it in a terminal" without naming the
    /// command leaves them guessing between bun, npm and a downloaded file.
    server_command: Option<String>,
    /// How that server was installed, when it said. Distinguishes "no command exists for this
    /// channel" (a downloaded file, which is replaced by hand) from "this server is too old to
    /// tell" — which look identical in `server_command` and must not read the same on screen.
    server_channel: Option<String>,
}

#[tauri::command]
async fn update_view(app: AppHandle, conn: State<'_, Arc<Conn>>) -> Result<UpdateView, ()> {
    let Some(status) = conn.update_status().await else {
        return Ok(UpdateView {
            latest: None,
            tray_behind: false,
            server_behind: false,
            server_command: None,
            server_channel: None,
        });
    };
    let mine = update::tray_version(&app);
    let tray_behind = status
        .latest
        .as_deref()
        .is_some_and(|latest| update::is_behind(&mine, latest));
    Ok(UpdateView {
        latest: status.latest,
        tray_behind,
        server_behind: status.server_behind,
        server_command: status.command,
        server_channel: status.channel,
    })
}

/// Try the URL the user pasted. A server with a certificate is not stored by this call — the
/// fingerprint it returns has to come back through `trust`.
#[tauri::command]
async fn connect(url: String, conn: State<'_, Arc<Conn>>) -> Result<Status, String> {
    conn.connect(&url).await
}

/// Accept the fingerprint the panel last showed, and store the connection.
#[tauri::command]
async fn trust(conn: State<'_, Arc<Conn>>) -> Result<Status, String> {
    conn.trust().await
}

/// Hand a session to the browser portal, which is where everything the tray cannot say at a glance
/// lives. Opened from Rust, not from the webview: the URL carries the token, and Rust is the only
/// side that holds it.
#[tauri::command]
async fn open_session(session_id: String, app: AppHandle, conn: State<'_, Arc<Conn>>) -> Result<(), String> {
    let url = conn
        .portal_url(Some(&session_id))
        .ok_or("There is no connection to open that session on.")?;
    hand_to_browser(&app, url)
}

/// Hand the portal ITSELF to the browser — the same connection, no session named.
///
/// Its own command rather than `open_session` with an empty id: the two are different requests, and
/// a blank session id is the kind of argument that silently becomes `/?session=` one refactor later.
#[tauri::command]
async fn open_portal(app: AppHandle, conn: State<'_, Arc<Conn>>) -> Result<(), String> {
    let url = conn
        .portal_url(None)
        .ok_or("There is no connection to open the portal on.")?;
    hand_to_browser(&app, url)
}

fn hand_to_browser(app: &AppHandle, url: String) -> Result<(), String> {
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| format!("Could not open the portal: {e}"))
}

/// Fit the popover to what it is showing.
///
/// The window is chromeless and cannot be resized by hand, so its height is not a preference — it
/// is a fact about the content, and only the webview can measure that. A fixed 560 pt meant the
/// connect screen (about 200 pt of content) sat in 360 pt of void.
///
/// Answers with the height actually applied, which is not always the one asked for: the panel needs
/// to know when it was clamped, because that is exactly when its list has to scroll.
///
/// Growing DOWNWARD only — the top edge is anchored under the tray icon and is never moved here. A
/// popover that re-centred itself as its content changed would walk across the menu bar.
#[tauri::command]
fn resize(height: f64, app: AppHandle) -> Result<f64, String> {
    let win = app.get_webview_window(PANEL).ok_or("no panel window")?;
    let scale = win.scale_factor().map_err(|e| e.to_string())?;
    let size = win.inner_size().map_err(|e| e.to_string())?.to_logical::<f64>(scale);
    let top = win.outer_position().map_err(|e| e.to_string())?.to_logical::<f64>(scale).y;
    // The monitor under the popover's own top edge, not `primary_monitor`: a menu bar exists on
    // every screen and the icon may well be on the second one.
    let bottom = match win.monitor_from_point(top * scale, top * scale) {
        Ok(Some(mon)) => {
            let area = mon.work_area();
            f64::from(area.position.y + area.size.height as i32) / scale
        }
        // No monitor to ask: honour the content rather than invent a ceiling for it.
        _ => f64::INFINITY,
    };
    let fitted = panel_height(height, top, bottom);
    win.set_size(tauri::LogicalSize::new(size.width, fitted))
        .map_err(|e| e.to_string())?;
    Ok(fitted)
}

/// Put the popover away, then post one notification.
///
/// This is the ONLY honest way to surface the platform's own silence. The plugin's
/// `permission_state()` is a hardcoded `Granted` on desktop (verified in
/// tauri-plugin-notification 2.3.3, `desktop.rs`), and `show()` returns `Ok(())` even when nothing
/// is delivered — so neither can tell the user whether notifications reach them. A banner they look
/// for can.
///
/// **The popover closing is not a courtesy, it is the test.** Clicking this button is the one moment
/// the tray is the frontmost app — the panel took focus when it opened (`toggle_panel`) — and that
/// is precisely the case macOS refuses to draw a banner for ({@link NOTIFY_SETTLE}). Real banners
/// arrive while the user is somewhere else, so the check has to reproduce that condition rather than
/// report a delivery the window server dropped on the floor.
///
/// Nothing is returned, and nothing could be: the post happens after this call has already answered,
/// and `show()` cannot tell delivered from dropped anyway. The banner is the receipt — the same rule
/// the stop already follows, where the screen that comes next IS the answer.
#[tauri::command]
fn test_notification(app: AppHandle) {
    if let Some(win) = app.get_webview_window(PANEL) {
        let _ = win.hide();
        // Not left to the focus-loss handler: hiding a window that is not key raises no focus event,
        // and the poll would keep the open cadence for a panel nobody is looking at.
        set_panel_open(&app, false);
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(NOTIFY_SETTLE).await;
        // Discarded like every other send here, and for the reason `poll.rs` gives: `show` returns
        // Ok(()) in the case where nothing is delivered at all. By now there is no surface left to
        // report on either — the panel is the thing that just went away.
        let _ = app
            .notification()
            .builder()
            .title("Notifications are working")
            .body("This is what a session stopping on a question looks like.")
            .show();
    });
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            tick,
            look_again,
            connect,
            trust,
            open_session,
            open_portal,
            start_server,
            stop_server,
            server_version,
            restart_pending,
            update_view,
            test_notification,
            resize
        ])
        .setup(|app| {
            // ONE variable decides the world, and both directories come out of it — so a dev run
            // moves the tray's files AND points it at the dev server, which is the pairing that was
            // missing when these were two variables.
            let home = std::env::var_os(SEEDEEP_HOME);
            let config_dir = config_root(home.clone(), app.path().app_config_dir()?);
            // First, because the connection asks it where the servers on this machine are before
            // guessing at a port.
            let local = Arc::new(LocalServer::new(local::seedeep_home(app.path().home_dir()?, home)));
            app.manage(local.clone());
            // The connection is the app's, not a window's: it outlives the popover, which is
            // created and hidden repeatedly, and a per-window client would re-handshake on every
            // open. Shared with the poll, which reads through the same one so a tick and a click
            // cannot be looking at two different servers.
            let conn = Arc::new(Conn::new(connection::store_path(&config_dir), local.clone()));
            app.manage(conn.clone());
            // Which versions THIS RUN has announced — held in memory, so a restart is a second
            // chance at a banner the system may never have shown (`update.rs`).
            let notices = Arc::new(update::Notices::new(&config_dir));
            let poller = Poller::new(conn, local.clone(), notices);
            app.manage(poller.clone());

            // A menu-bar app owns no Dock tile and no app-switcher entry: `Accessory` is what
            // makes the tray icon the app's entire presence. Without it macOS also focuses the
            // app on launch, stealing the front window from whatever the user was doing.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // Without a Dock tile and without this menu the app cannot be quit at all except
            // from Activity Monitor. The right-click menu is the only exit there is.
            let quit = MenuItem::with_id(app, "quit", "Quit seedeep", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&quit])?;

            TrayIconBuilder::with_id(icon::TRAY_ID)
                // Unreachable until the first reading says otherwise — which is the truth for the
                // fraction of a second before it arrives, and never a state the tray has not checked.
                .icon(icon::image(icon::TrayState::Unreachable))
                // NOT a template image: macOS would strip the colour, and amber is what the
                // waiting state says. The states are told apart by shape as well, so nothing
                // depends on colour alone.
                .icon_as_template(false)
                .menu(&menu)
                // Left-click belongs to the panel; the menu is the right-click affordance.
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    if event.id() == "quit" {
                        app.exit(0);
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        rect,
                        ..
                    } = event
                    {
                        toggle_panel(tray.app_handle(), rect);
                    }
                })
                .build(app)?;

            if std::env::var_os(SHOW_PANEL).is_some() {
                if let Some(win) = app.get_webview_window(PANEL) {
                    let _ = win.show();
                    poller.set_open(true);
                }
            }

            // Started after the tray exists, or the first reading would have no icon to paint —
            // and after the flag above, so a panel shown at startup is read at the open cadence.
            poller.spawn(app.handle().clone());

            let probe_file = config_dir.join(LOCATE_PROBE);
            if probe_file.exists() {
                let probe = local.clone();
                let out = probe_file;
                tauri::async_runtime::spawn(async move {
                    let found = probe.executable().await;
                    let _ = std::fs::write(
                        out,
                        format!(
                            "PATH={}\nSHELL={}\nfound={found:?}\nrunning={:?}\n",
                            std::env::var("PATH").unwrap_or_default(),
                            std::env::var("SHELL").unwrap_or_default(),
                            probe.running(),
                        ),
                    );
                });
            }

            if std::env::var_os(NOTIFY_PROBE).is_some() {
                let outcome = app
                    .notification()
                    .builder()
                    .title("seedeep")
                    .body("Notification probe — this build is unsigned.")
                    .show();
                println!("NOTIFY_PROBE: {outcome:?}");
            }
            Ok(())
        })
        .on_window_event(|win, event| {
            // A chromeless popover has no close button, so losing focus IS the dismissal —
            // clicking anywhere else must put it away, the way a menu does. Scoped to the
            // panel by label: this handler is called for EVERY window, and the next one added
            // (settings, about) would otherwise vanish the moment it was clicked away from.
            if win.label() == PANEL && matches!(event, WindowEvent::Focused(false)) {
                let _ = win.hide();
                set_panel_open(win.app_handle(), false);
            }
        })
        .run(tauri::generate_context!())
        .expect("seedeep tray failed to start");
}

#[cfg(test)]
mod tests {
    use super::{config_root, panel_height, PANEL_MARGIN, PANEL_MIN_H};
    use std::path::PathBuf;

    // The default, and the only one a user ever takes: the app's own directory, untouched.
    #[test]
    fn without_the_variable_the_app_decides_where_its_files_live() {
        assert_eq!(config_root(None, PathBuf::from("/app/config")), PathBuf::from("/app/config"));
    }

    // Under the home, not the home itself: one variable names one world, and the server keeps its
    // own state in the same directory — two apps writing over each other's files is what the
    // subdirectory rules out.
    #[test]
    fn the_variable_wins_and_the_tray_gets_its_own_corner() {
        assert_eq!(
            config_root(Some("/tmp/dev-state".into()), PathBuf::from("/app/config")),
            PathBuf::from("/tmp/dev-state/tray")
        );
    }

    // A script that exported the name and forgot the value would otherwise scatter a token file
    // into whatever directory the process started in.
    #[test]
    fn an_empty_value_is_no_value() {
        assert_eq!(config_root(Some("".into()), PathBuf::from("/app/config")), PathBuf::from("/app/config"));
    }

    // `tauri dev` runs from `apps/tray`, not from the repository root, so a relative value has to be
    // resolved rather than trusted.
    #[test]
    fn a_relative_value_becomes_absolute() {
        let resolved = config_root(Some(".seedeep-dev".into()), PathBuf::from("/app/config"));
        assert!(resolved.is_absolute(), "{resolved:?}");
        assert!(resolved.ends_with(".seedeep-dev/tray"), "{resolved:?}");
    }

    // The ordinary case, and the whole point of the clamp: a short screen gets a short window rather
    // than 360 pt of void under it.
    #[test]
    fn a_short_panel_is_as_tall_as_its_content() {
        assert_eq!(panel_height(200.0, 40.0, 1000.0), 200.0);
    }

    // A menu-bar popover cannot be dragged, so anything past the bottom of the screen is not merely
    // ugly — it is unreachable. The list scrolls instead, which is why the applied height is
    // returned to the panel.
    #[test]
    fn a_tall_panel_stops_at_the_bottom_of_the_screen() {
        assert_eq!(panel_height(2000.0, 40.0, 1000.0), 1000.0 - 40.0 - PANEL_MARGIN);
    }

    // A webview that has not laid out yet reports 0. Collapsing the window to nothing would leave
    // no way to click the panel back, so the floor wins over an honest reading of an empty page.
    #[test]
    fn a_panel_never_collapses_to_nothing() {
        assert_eq!(panel_height(0.0, 40.0, 1000.0), PANEL_MIN_H);
    }

    // An icon low enough that the margin eats the whole screen inverts the range. `clamp` panics
    // there; a tray that panics is a tray that disappears.
    #[test]
    fn no_room_at_all_overhangs_rather_than_panicking() {
        assert_eq!(panel_height(300.0, 990.0, 1000.0), PANEL_MIN_H);
    }
}
