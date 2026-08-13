//! The tray's file on disk, written so that nothing can read half of it.
//!
//! `connection.json` is per-user state in the app's config directory. It shared this module with a
//! `settings.json` until the notification switches moved to the server's config, and the write stays
//! a function of its own because the two properties it needs are not obvious: the mode is set **at
//! creation** rather than after the bytes are there (the file holds a token, which must never exist
//! in a world-readable file even for an instant), and the file is renamed into place, so a crash
//! mid-write leaves the previous version rather than a truncated one.
//!
//! A file nobody can parse reads as ABSENT. Refusing to start over a file the user cannot edit by
//! hand would not be a recovery; asking for the URL again is one.

use std::fs;
use std::io::{self, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};

use serde::de::DeserializeOwned;
use serde::Serialize;

/// What is stored at `path`, or `None` when there is nothing usable there.
pub fn read<T: DeserializeOwned>(path: &Path) -> Option<T> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Write `value` as JSON, replacing whatever was there, readable only by this user.
pub fn write<T: Serialize>(path: &Path, value: &T) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
        }
    }
    let body = serde_json::to_string_pretty(value).map_err(io::Error::other)?;
    // A temporary name of its own per call. Two saves racing on ONE name write into the same inode
    // through separate descriptors, and the interleaving can leave a file that is neither version —
    // recoverable (a malformed file reads as absent) but a corruption nothing had to risk.
    static SEQ: AtomicU32 = AtomicU32::new(0);
    let tmp = path.with_extension(format!(
        "tmp.{}.{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let published = (|| -> io::Result<()> {
        let mut file = opts.open(&tmp)?;
        file.write_all(body.as_bytes())?;
        // The rename must not outlive the bytes it publishes.
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, path)
    })();
    if published.is_err() {
        // Or a failed write would leave its scratch file in the user's config directory for good.
        let _ = fs::remove_file(&tmp);
    }
    published
}
