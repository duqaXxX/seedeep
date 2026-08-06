//! What the tray remembers about the server it talks to, and how a pasted URL becomes that.
//!
//! ONE file, `<app config dir>/connection.json`, mode 0600, written and read by Rust only. The
//! split between what needs secrecy and what needs integrity is the reason there is no keychain
//! here: the fingerprint is not a secret — it travels in cleartext in every handshake — but
//! anything that can rewrite it voids the pin, and a file only the user can write already gives
//! that. The token IS a secret, and it is what 0600 is for; the server keeps the same token in
//! plaintext at the same mode in `~/.seedeep/config.json`, so storing it differently on the client
//! would not make the pair safer, only inconsistent.

use std::io;
use std::path::{Path, PathBuf};

use reqwest::Url;
use serde::{Deserialize, Serialize};

use crate::store;

/// The port the server listens on unless told otherwise — the only address the tray guesses.
pub const DEFAULT_PORT: u16 = 44842;

/// A server the tray can reach: where it is, which certificate is its identity, how it authorises.
///
/// `fingerprint` is `None` for a plaintext server (a loopback-mode seedeep has no certificate at
/// all, so an absent value says "nothing to pin", never "not yet known"). `token` is `None` when
/// the server does not ask for one, which is the same case.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    /// Scheme, host and port only — no path, no query. A stored `?token=` would put the secret
    /// into every request line the server logs, which is the thing `Authorization` exists to avoid.
    pub base_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
}

impl Connection {
    /// The zero-configuration guess: a seedeep in its default loopback mode, which has neither
    /// TLS nor a token.
    pub fn local_plaintext() -> Self {
        Self {
            base_url: format!("http://127.0.0.1:{DEFAULT_PORT}"),
            fingerprint: None,
            token: None,
        }
    }

    /// The same machine, but with remote access configured — where the server speaks HTTPS and
    /// demands the token even on loopback, because it gates on the CONFIGURED host and not on the
    /// peer. Used only to tell "no server here" apart from "a server here I need the URL for":
    /// nothing is pinned and nothing is stored from this probe.
    pub fn local_tls() -> Self {
        Self {
            base_url: format!("https://127.0.0.1:{DEFAULT_PORT}"),
            fingerprint: None,
            token: None,
        }
    }

    /// Whether the default probe would find this server again on its own — the test for "worth
    /// remembering". Storing the default would only add a file that says what the code guesses.
    pub fn is_default_local(&self) -> bool {
        *self == Self::local_plaintext()
    }
}

/// Split the URL the portal's Settings panel copies into what the tray stores.
///
/// The pasted string is `https://<name>:44842/?token=<token>`; the token moves out of the URL and
/// into an `Authorization` header for every later request, so it never reaches a server log or a
/// shell history. Returns a message written for the panel — an error here is something the user
/// typed, so it has to say what to do instead of naming a parser.
pub fn parse_pasted(input: &str) -> Result<Connection, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("Paste the URL from the portal's Settings → Remote access.".into());
    }
    let url = Url::parse(trimmed)
        .map_err(|_| "That is not a URL. Paste the whole thing, including https://".to_string())?;
    match url.scheme() {
        "http" | "https" => {}
        other => {
            return Err(format!(
                "{other}:// is not something seedeep speaks — expected https://, or http:// for a local server."
            ))
        }
    }
    if url.host_str().is_none() {
        return Err("That URL names no host.".into());
    }
    let token = url
        .query_pairs()
        .find(|(k, _)| k == "token")
        .map(|(_, v)| v.into_owned())
        .filter(|t| !t.is_empty());
    Ok(Connection {
        // `origin` drops the path, the query and any credentials, and keeps the port whenever it
        // is not the scheme's default — exactly the base every request is built from.
        base_url: url.origin().ascii_serialization(),
        fingerprint: None,
        token,
    })
}

/// Where `connection.json` lives inside the app's config directory.
pub fn store_path(config_dir: &Path) -> PathBuf {
    config_dir.join("connection.json")
}

/// The stored connection, or `None` when there is none to be had.
///
/// A malformed file reads as absent rather than as an error: the panel then asks for the URL
/// again and the next successful connect overwrites it, which is a recovery the user can perform.
/// Refusing to start over a file nobody can edit by hand would not be.
pub fn load(path: &Path) -> Option<Connection> {
    store::read(path)
}

/// Write the connection, replacing any previous one, readable only by this user.
///
/// The atomicity and the 0600 are [`store::write`]'s, shared with the settings file; what belongs
/// here is WHY this file needs them — it holds the token, and it holds the pin that a half-written
/// file would void.
pub fn save(path: &Path, connection: &Connection) -> io::Result<()> {
    store::write(path, connection)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU32, Ordering};

    // No `tempfile` dependency for four tests: a per-process, per-call directory under the
    // system temp dir is enough, and it keeps the dependency graph the binary ships as small as
    // the one it is tested with.
    fn tmp_dir() -> PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "seedeep-tray-test-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_pasted_url_splits_into_base_and_token() {
        let c = parse_pasted("https://box.local:44842/?token=abc123").unwrap();
        assert_eq!(c.base_url, "https://box.local:44842");
        assert_eq!(c.token.as_deref(), Some("abc123"));
        assert_eq!(c.fingerprint, None, "a fingerprint is learned, never pasted");
    }

    // The base is what every later request is built from, so anything that is not scheme-host-port
    // has to be gone: a stored path would prefix `/api/digest` and a stored query would put the
    // token back on the wire.
    #[test]
    fn the_path_and_the_query_do_not_survive() {
        let c = parse_pasted("https://box.local:44842/graph?token=t&tab=2").unwrap();
        assert_eq!(c.base_url, "https://box.local:44842");
        assert_eq!(c.token.as_deref(), Some("t"));
    }

    #[test]
    fn a_local_server_needs_no_token() {
        let c = parse_pasted("  http://127.0.0.1:9999  ").unwrap();
        assert_eq!(c.base_url, "http://127.0.0.1:9999");
        assert_eq!(c.token, None);
        assert!(!c.is_default_local(), "a non-default port is worth remembering");
    }

    #[test]
    fn an_empty_token_is_no_token() {
        assert_eq!(parse_pasted("https://box.local:44842/?token=").unwrap().token, None);
    }

    #[test]
    fn what_cannot_be_a_server_is_refused_with_something_to_do() {
        for input in ["", "   ", "box.local:44842", "ftp://box.local", "not a url"] {
            let err = parse_pasted(input).expect_err(input);
            assert!(
                err.contains("Paste") || err.contains("expected") || err.contains("URL"),
                "{input}: {err}"
            );
        }
    }

    #[test]
    fn what_is_stored_is_what_comes_back() {
        let path = store_path(&tmp_dir());
        let c = Connection {
            base_url: "https://box.local:44842".into(),
            fingerprint: Some("AA:BB".into()),
            token: Some("secret".into()),
        };

        save(&path, &c).unwrap();

        assert_eq!(load(&path).as_ref(), Some(&c));
    }

    // The token is the reason this file has a mode at all. Asserted on the bits, because "we
    // called chmod" is not the same claim as "the file on disk is unreadable to anyone else".
    #[cfg(unix)]
    #[test]
    fn the_stored_token_is_readable_only_by_its_owner() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tmp_dir();
        let path = store_path(&dir);

        save(&path, &Connection::local_plaintext()).unwrap();
        // Twice: an overwrite must not inherit the mode of whatever was there before.
        save(&path, &Connection::local_plaintext()).unwrap();

        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "connection.json holds a token");
        let dir_mode = fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
        assert_eq!(dir_mode, 0o700, "a directory anyone can list is a token anyone can find");
    }

    #[test]
    fn a_file_nobody_can_parse_reads_as_no_connection() {
        let path = store_path(&tmp_dir());
        fs::write(&path, "{ this is not json").unwrap();

        assert_eq!(load(&path), None);
        assert_eq!(load(&store_path(&tmp_dir())), None, "nor does an absent one fail");
    }

    // Serialised with the same names the panel and the card use, so the file a human opens says
    // what it holds.
    #[test]
    fn the_file_is_the_shape_the_card_describes() {
        let path = store_path(&tmp_dir());
        save(
            &path,
            &Connection {
                base_url: "https://box.local:44842".into(),
                fingerprint: Some("AA:BB".into()),
                token: Some("secret".into()),
            },
        )
        .unwrap();

        let raw = fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"baseUrl\""), "{raw}");
        assert!(raw.contains("\"fingerprint\""), "{raw}");
        assert!(raw.contains("\"token\""), "{raw}");
    }

    // An absent fingerprint means "this server has no certificate", which a null would blur into
    // "not yet learned" for anything reading the file.
    #[test]
    fn a_plaintext_connection_writes_no_empty_fields() {
        let path = store_path(&tmp_dir());
        save(&path, &Connection::local_plaintext()).unwrap();

        let raw = fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("fingerprint"), "{raw}");
        assert!(!raw.contains("token"), "{raw}");
    }
}
