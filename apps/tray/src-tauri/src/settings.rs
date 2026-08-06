//! What the user can turn off, and where it is remembered.
//!
//! Its own file, `<app config dir>/settings.json`, and NOT a field on [`crate::connection::Connection`]:
//! that struct is written by `connect`/`trust` and compared against the default local guess to decide
//! whether it is worth storing at all (`is_default_local`), so a preference living on it would make
//! "worth remembering a server" depend on a toggle that has nothing to do with servers.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::store;

/// Everything the tray can be told. The file is versionless on purpose: serde ignores fields it
/// does not know, so a settings file written by a later build still parses here — and every field
/// carries `#[serde(default)]` so a file written by an EARLIER one parses too, instead of failing
/// whole and quietly restoring a toggle the user had turned off.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// Whether a session entering a wait on the human sends an OS notification.
    ///
    /// The ICON is deliberately not covered by this: it is always-on peripheral information that
    /// costs the user nothing to ignore, whereas a notification interrupts. Turning the interruption
    /// off must not also blind the menu bar.
    #[serde(default = "yes")]
    pub notify: bool,
    /// Whether a session FINISHING a turn sends one too.
    ///
    /// A separate switch rather than a second reason for the one above, because the two are not the
    /// same bargain: a session stopped on you cannot continue until you act, while a session that
    /// finished is news you can read whenever you like. Somebody who wants the first and not the
    /// second must be able to say so — otherwise the way to stop the noise is to silence both, and
    /// the approvals are what the tray exists for.
    #[serde(default)]
    pub notify_finished: bool,
    /// Whether a session whose model call FAILED sends one too.
    ///
    /// ON by default, with the approvals rather than with the finished turns: this is the same
    /// bargain as a wait — the session has stopped and will not continue until the human does
    /// something — except nothing on screen asked for anything. Measured over 1830 real
    /// transcripts, 39 of 47 API errors were the last model line their session ever wrote, so the
    /// cost of not being told is the whole time until somebody looks.
    #[serde(default = "yes")]
    pub notify_failed: bool,
    /// Whether a newer seedeep on npm sends one too.
    ///
    /// The odd one out among these switches: the other three are about a SESSION, arrive on the
    /// transition, and can fire several times an hour. This one is about the tray itself, fires at
    /// most once per released version (`update::Notices`), and is the only one that can be true
    /// while nothing is connected to look at. ON by default because that is the whole point of the
    /// card that asked for it — a user who never runs `seedeep update` otherwise never learns.
    #[serde(default = "yes")]
    pub notify_update: bool,
}

/// serde needs a path, not a literal, for a default that is not the type's own.
fn yes() -> bool {
    true
}

impl Default for Settings {
    /// Approvals ON, finished turns OFF. The tray's whole reason to exist while nobody is looking at
    /// it is to say that a session stopped on a question; shipped off it would be a feature nobody
    /// discovers. A finished turn is the opposite case — it interrupts about something that needs no
    /// action, so it arrives only if it is asked for.
    fn default() -> Self {
        Self {
            notify: true,
            notify_finished: false,
            notify_failed: true,
            notify_update: true,
        }
    }
}

/// Where `settings.json` lives inside the app's config directory.
pub fn store_path(config_dir: &Path) -> PathBuf {
    config_dir.join("settings.json")
}

/// The settings as they stand, held in memory so the poll never touches the disk.
///
/// The poll asks on every reading — once a second with the panel open — and a preference read is a
/// file read only when the answer might have changed, which is when the user changes it.
pub struct Prefs {
    path: PathBuf,
    current: Mutex<Settings>,
}

impl Prefs {
    /// Load the stored settings, falling back to the defaults for an absent or unreadable file.
    pub fn load(path: PathBuf) -> Self {
        let current = store::read(&path).unwrap_or_default();
        Self {
            path,
            current: Mutex::new(current),
        }
    }

    /// What is in force right now.
    pub fn get(&self) -> Settings {
        *self.current.lock().unwrap()
    }

    /// Store whether a session stopping on the human notifies, and return the settings as they now
    /// stand.
    pub fn set_notify(&self, notify: bool) -> Result<Settings, String> {
        self.update(|s| s.notify = notify)
    }

    /// Store whether a session finishing a turn notifies, and return the settings as they now stand.
    pub fn set_notify_finished(&self, notify_finished: bool) -> Result<Settings, String> {
        self.update(|s| s.notify_finished = notify_finished)
    }

    /// Store whether a session whose call failed notifies, and return the settings as they now
    /// stand.
    pub fn set_notify_failed(&self, notify_failed: bool) -> Result<Settings, String> {
        self.update(|s| s.notify_failed = notify_failed)
    }

    /// Store whether a newer published version notifies, and return the settings as they now stand.
    pub fn set_notify_update(&self, notify_update: bool) -> Result<Settings, String> {
        self.update(|s| s.notify_update = notify_update)
    }

    /// Change one setting, leaving the others as they are, and return what is now in force.
    ///
    /// The disk is written FIRST and the in-memory copy only after it succeeds: a toggle that took
    /// effect for this run alone would be a setting the next start silently undoes, which is worse
    /// than a toggle that says it could not be saved.
    ///
    /// One writer for every setting, so a second toggle cannot be added as a second `Settings { .. }`
    /// literal — which is how the toggle written last would silently reset the ones it did not name.
    fn update(&self, change: impl FnOnce(&mut Settings)) -> Result<Settings, String> {
        let mut next = self.get();
        change(&mut next);
        store::write(&self.path, &next).map_err(|e| format!("Could not save the setting: {e}"))?;
        *self.current.lock().unwrap() = next;
        Ok(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn tmp_dir() -> PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "seedeep-tray-settings-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    // The default is the one thing a settings file cannot state, because the interesting case is
    // the user who has never opened Settings at all. The split is the point: the two interruptions
    // about a session that has STOPPED and cannot continue on its own are on, and the one about a
    // session that simply finished is off until it is asked for.
    #[test]
    fn a_tray_that_was_never_configured_announces_what_stopped_a_session() {
        let prefs = Prefs::load(store_path(&tmp_dir()));

        assert!(prefs.get().notify);
        assert!(prefs.get().notify_failed);
        assert!(!prefs.get().notify_finished);
    }

    #[test]
    fn what_is_turned_off_stays_off_across_a_restart() {
        let path = store_path(&tmp_dir());

        let prefs = Prefs::load(path.clone());
        assert!(!prefs.set_notify(false).unwrap().notify);
        assert!(!prefs.get().notify);

        assert!(!Prefs::load(path).get().notify, "the next start reads the file, not the default");
    }

    // Three settings in one file, and one writer for all of them. Written because the obvious way to
    // add the second — a fresh `Settings { .. }` literal per setter — silently resets whichever one
    // the setter does not name, and the user only finds out on the next session that fails to notify.
    #[test]
    fn changing_one_setting_leaves_the_others_where_they_were() {
        let path = store_path(&tmp_dir());
        let prefs = Prefs::load(path.clone());
        prefs.set_notify(false).unwrap();
        prefs.set_notify_failed(false).unwrap();
        prefs.set_notify_update(false).unwrap();

        let after = prefs.set_notify_finished(true).unwrap();

        assert_eq!(
            after,
            Settings {
                notify: false,
                notify_finished: true,
                notify_failed: false,
                notify_update: false,
            }
        );
        assert_eq!(Prefs::load(path).get(), after, "and the disk agrees");
    }

    // The file a build BEFORE this feature wrote has no `notifyFinished` at all. Parsing it whole-
    // or-nothing would fall back to the defaults and turn the approvals the user had silenced back
    // on — a settings file undoing a setting.
    #[test]
    fn a_file_from_an_older_build_keeps_what_it_does_say() {
        let path = store_path(&tmp_dir());
        fs::write(&path, r#"{"notify":false}"#).unwrap();

        let settings = Prefs::load(path).get();

        assert!(!settings.notify, "the field that IS there decides");
        assert!(!settings.notify_finished, "and the absent one takes the default");
        assert!(settings.notify_failed, "including a default that is ON");
    }

    // Same rule as the connection file: unusable reads as absent. The alternative is a tray that
    // will not run because of a file the user cannot fix.
    #[test]
    fn a_file_nobody_can_parse_falls_back_to_the_defaults() {
        let path = store_path(&tmp_dir());
        fs::write(&path, "{ not json").unwrap();

        assert!(Prefs::load(path).get().notify);
    }

    // The file is written with the same private mode as the connection — not because a preference is
    // a secret, but because both live in a directory whose mode is the token's protection.
    #[cfg(unix)]
    #[test]
    fn the_file_is_the_users_own() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tmp_dir();
        let path = store_path(&dir);

        Prefs::load(path.clone()).set_notify(false).unwrap();

        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let raw = fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"notify\""), "{raw}");
    }

    // A setting that could not be stored must not claim to be in force: the panel shows the
    // message and the toggle stays where the disk says it is.
    #[test]
    fn a_setting_that_cannot_be_written_does_not_take_effect() {
        // A path under a FILE, so `create_dir_all` fails — the one write failure that can be
        // provoked without touching permissions the test runner may hold anyway.
        let blocked = tmp_dir().join("wall");
        fs::write(&blocked, "not a directory").unwrap();
        let prefs = Prefs::load(store_path(&blocked));

        let err = prefs.set_notify(false).expect_err("the write cannot succeed");

        assert!(err.contains("Could not save the setting"), "{err}");
        assert!(prefs.get().notify, "the in-memory value must follow the disk");
    }
}
