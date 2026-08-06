//! Whether a newer seedeep exists, and whether the user has already been told.
//!
//! The tray asks no registry of its own: the SERVER holds the cached npm check (`GET /api/update`,
//! refreshed at most once an hour) and judges its OWN standing, which is what the banner reports.
//! `is_behind` here serves the panel, which also marks a tray older than the published release —
//! the two ship from one tag but are replaced by different acts (a DMG, an npm package), so each
//! line names its own half.
//!
//! **Once per version, per RUN of the tray** (Davide's call, 2026-08-06, replacing "once per
//! version, ever"). A banner repeated on every check is the notification people silence first; one
//! that is remembered forever is worse in the case that actually happens — measured on this machine:
//! the banner for 0.11.1 was sent, macOS did not show it because a freshly installed unsigned bundle
//! has no permission yet, and the version was recorded as announced. It could never be shown again.
//!
//! A fresh start is the one moment worth a second chance: it is when a reinstall has just happened,
//! which is exactly when the permission was lost. So the memory is IN MEMORY — no file, no cleanup,
//! and the rule falls out of the process's own lifetime rather than being enforced against it.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::AppHandle;

/// The tray's own release — the number a user would be updating FROM.
///
/// **Never `env!("CARGO_PKG_VERSION")`.** `Cargo.toml` says `0.0.0` on purpose: the real number
/// comes from `tauri.conf.json > version`, which points at the repo's `package.json` so one tag
/// cannot produce two versions, and tauri bakes it into `PackageInfo` while leaving the cargo
/// variable alone. Reading the cargo one made every install compare `0.0.0` against the published
/// release — a permanent "an update is available" for a user who was already current, at every
/// release, forever. This is also the value `getVersion()` gives the panel, so the About section
/// and the banner cannot disagree.
pub fn tray_version(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Compare two versions by their numeric parts, mirroring the server's `compareVersions`: anything
/// after a `-` is dropped, and a missing part counts as zero, so `1.2` and `1.2.0` are one version.
fn parts(v: &str) -> Vec<u64> {
    v.split('-')
        .next()
        .unwrap_or("")
        .split('.')
        .map(|n| n.parse::<u64>().unwrap_or(0))
        .collect()
}

/// Whether `current` is older than `latest`. False whenever they are equal, `current` is newer (a
/// build of one's own), or either is unparseable — nothing here is worth interrupting a user over
/// on a guess.
pub fn is_behind(current: &str, latest: &str) -> bool {
    let (a, b) = (parts(current), parts(latest));
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (a.get(i).copied().unwrap_or(0), b.get(i).copied().unwrap_or(0));
        if x != y {
            return x < y;
        }
    }
    false
}

/// Where the pre-0.11.3 build kept its "already announced" record. Deleted on start rather than
/// read: the rule it enforced is gone, and a file nobody writes is one a user finds and wonders
/// about.
fn legacy_store(config_dir: &Path) -> PathBuf {
    config_dir.join("update-notified.json")
}

/// Remembers which versions this RUN of the tray has already announced.
#[derive(Default)]
pub struct Notices {
    announced: Mutex<HashSet<String>>,
}

impl Notices {
    /// A fresh set for this run, and a sweep of the file the old rule used to keep.
    pub fn new(config_dir: &Path) -> Self {
        let _ = std::fs::remove_file(legacy_store(config_dir));
        Self::default()
    }

    /// Whether `latest` is worth a banner right now — true once per version for as long as this
    /// process lives.
    ///
    /// Records it BEFORE the caller shows anything, and that has not changed: a notification that
    /// could not be delivered is indistinguishable from one that was (the plugin returns `Ok(())`
    /// either way, measured — `docs/tray.md`), so there is no outcome to record afterwards. What
    /// changed is the SCOPE of the memory — the next start gets to try again.
    pub fn should_announce(&self, latest: &str) -> bool {
        self.announced.lock().unwrap().insert(latest.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// A directory of its own per test, so the legacy sweep has something real to sweep.
    fn temp_dir() -> PathBuf {
        static SEQ: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "seedeep-tray-update-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn behind_only_when_genuinely_older() {
        assert!(is_behind("0.9.0", "0.10.0"), "0.10 is ten, not one");
        assert!(is_behind("1.0.0", "1.0.1"));
        assert!(!is_behind("1.0.0", "1.0.0"));
        assert!(!is_behind("1.2", "1.2.0"), "a missing part is a zero");
        assert!(!is_behind("1.1.0", "1.0.0"), "a build of one's own is not behind");
        assert!(!is_behind("1.0.0-rc1", "1.0.0"), "a prerelease suffix orders nothing");
        // An unparseable part counts as zero, exactly as the server's `compareVersions` does. The
        // case cannot arise — `current` is always CARGO_PKG_VERSION — and inventing a rule the two
        // sides do not share would be worse than matching on a value neither will see.
        assert!(is_behind("not a version", "1.0.0"));
    }

    // The trap this module was built wrong on once. `Cargo.toml` is deliberately `0.0.0` — the real
    // version comes from `tauri.conf.json` — so a comparison against the cargo variable told every
    // user they were behind, at every release, forever. No test could see it: `is_behind` is pure and
    // the panel's version comes from a different call. This one at least fails the moment somebody
    // "fixes" Cargo.toml, which is the other way the two could silently start disagreeing.
    #[test]
    fn the_crate_version_is_not_the_app_version() {
        assert_eq!(
            env!("CARGO_PKG_VERSION"),
            "0.0.0",
            "Cargo.toml must stay 0.0.0: tauri.conf.json > version is the one source, and \
             `tray_version` reads it through PackageInfo. If this changed, check nothing went back \
             to env!(CARGO_PKG_VERSION)."
        );
    }

    #[test]
    fn a_version_is_announced_once_per_run() {
        let dir = temp_dir();
        let notices = Notices::new(&dir);
        assert!(notices.should_announce("1.2.0"));
        assert!(!notices.should_announce("1.2.0"), "the same version is not news twice in one run");
        assert!(notices.should_announce("1.3.0"), "a NEWER version is news again");

        // A fresh start is a second chance, deliberately: the banner that was never SHOWN — because
        // a reinstalled unsigned bundle had no permission yet — would otherwise be lost for good.
        let next_run = Notices::new(&dir);
        assert!(next_run.should_announce("1.3.0"), "a new run may announce it again");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // The old rule's file must not be left behind for a user to find and wonder about.
    #[test]
    fn starting_up_sweeps_the_file_the_old_rule_kept() {
        let dir = temp_dir();
        let legacy = legacy_store(&dir);
        std::fs::write(&legacy, r#"{"version":"0.11.1"}"#).unwrap();
        assert!(legacy.exists());

        let _ = Notices::new(&dir);
        assert!(!legacy.exists(), "the record of a rule that no longer exists is swept");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
