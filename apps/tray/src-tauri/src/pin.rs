//! Certificate pinning — the one thing a webview `fetch` cannot express, and therefore the
//! reason the tray's whole data layer is Rust (`docs/tray.md`).
//!
//! The model is trust-on-first-use: the first handshake LEARNS the leaf certificate's SHA-256,
//! the user confirms it against the value the server prints on every start, and from then on that
//! hash is the server's identity. A different certificate is a refusal, never a silent re-pin.

use std::sync::{Arc, Mutex};

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, Error, SignatureScheme};
use sha2::{Digest, Sha256};

/// The leaf certificate's SHA-256 as a human compares it: uppercase hex, colon separated.
///
/// The format is not cosmetic. It is byte-for-byte what `openssl x509 -fingerprint -sha256`
/// prints, which is what the server prints on every start and shows in Settings → TLS — the
/// out-of-band check the whole TOFU flow rests on. Two spellings of the same hash would turn
/// that check into a transcription exercise, which is a check people stop doing.
pub fn fingerprint(leaf_der: &[u8]) -> String {
    let digest = Sha256::digest(leaf_der);
    let mut out = String::with_capacity(digest.len() * 3 - 1);
    for (i, byte) in digest.iter().enumerate() {
        if i > 0 {
            out.push(':');
        }
        out.push_str(&format!("{byte:02X}"));
    }
    out
}

/// The fingerprint the last handshake actually presented, filled in by the verifier.
///
/// Shared rather than returned because the verifier runs inside the TLS stack, mid-request: when
/// a pin refuses a connection, this slot holds the only copy of the value the panel has to show
/// next to the pinned one.
pub type Seen = Arc<Mutex<Option<String>>>;

/// A rustls config that pins one leaf certificate, plus the slot recording what was presented.
///
/// `expected: None` is the LEARNING mode — the first connect, which accepts whatever the server
/// offers and records it. That window is inherent to trust-on-first-use and is why the panel asks
/// the user to confirm the fingerprint instead of storing it silently.
pub fn pinned_tls(expected: Option<String>) -> Result<(ClientConfig, Seen), Error> {
    // Passed explicitly rather than relying on a process-wide default: `install_default` is a
    // one-shot global that a second caller cannot override, so a config built from it depends on
    // who ran first.
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let seen: Seen = Arc::new(Mutex::new(None));
    let verifier = Arc::new(PinnedVerifier {
        expected,
        seen: Arc::clone(&seen),
        provider: Arc::clone(&provider),
    });
    let config = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()?
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth();
    Ok((config, seen))
}

#[derive(Debug)]
struct PinnedVerifier {
    expected: Option<String>,
    seen: Seen,
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for PinnedVerifier {
    /// Accept only the pinned leaf — and nothing else about the certificate is checked, on
    /// purpose.
    ///
    /// A chain, a name and a validity window answer "did somebody I trust vouch for this host?".
    /// A pin answers a different and stricter question: "is this the exact certificate whose
    /// private key only that one server holds?". There is nobody to vouch for a self-signed
    /// certificate, so the chain check has no input; the name check would add nothing a pinned
    /// leaf does not already settle, while refusing the aliases a user legitimately reaches their
    /// own machine by; and expiry would one day break a tray whose server is unchanged — an
    /// outage with no security gain, since the identity being asserted is the key, not the date.
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, Error> {
        let presented = fingerprint(end_entity.as_ref());
        // Recorded even when the next line is about to refuse it: showing both values side by
        // side is the panel's entire job in that case, and this is the only place the presented
        // one exists. A failure to record must never change the verdict, hence `if let Ok`:
        // reporting is a courtesy, refusing is the security property.
        if let Ok(mut slot) = self.seen.lock() {
            *slot = Some(presented.clone());
        }
        match &self.expected {
            Some(pinned) if !pinned.eq_ignore_ascii_case(&presented) => Err(Error::General(
                format!("seedeep: the server presented {presented}, not the pinned {pinned}"),
            )),
            _ => Ok(ServerCertVerified::assertion()),
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// A synthetic self-signed certificate for `example.test`, in the DER form rustls hands the
    /// verifier. Generated once with `openssl req -x509 -newkey rsa:2048 -subj /CN=example.test`;
    /// it holds no key and names nothing real, so it is safe in a public repo.
    const LEAF: &[u8] = include_bytes!("../tests/fixtures/leaf.der");

    /// The oracle: what `openssl x509 -in leaf.pem -noout -fingerprint -sha256` printed for that
    /// file. A constant produced by another implementation is the only thing that can catch this
    /// module agreeing with itself — recomputing the hash in the test would prove nothing.
    const LEAF_SHA256: &str =
        "06:EB:C5:8D:72:53:3F:C3:15:26:9D:5A:66:1B:10:E7:26:CB:52:52:90:1E:4E:DF:FA:1B:11:93:E6:E0:70:A4";

    fn verify(expected: Option<&str>) -> (Result<ServerCertVerified, Error>, Option<String>) {
        let seen: Seen = Arc::new(Mutex::new(None));
        let verifier = PinnedVerifier {
            expected: expected.map(str::to_string),
            seen: Arc::clone(&seen),
            provider: Arc::new(rustls::crypto::aws_lc_rs::default_provider()),
        };
        let result = verifier.verify_server_cert(
            &CertificateDer::from(LEAF),
            &[],
            &ServerName::try_from("example.test").unwrap(),
            &[],
            UnixTime::since_unix_epoch(Duration::from_secs(1_800_000_000)),
        );
        let recorded = seen.lock().unwrap().clone();
        (result, recorded)
    }

    #[test]
    fn fingerprint_matches_openssl() {
        assert_eq!(fingerprint(LEAF), LEAF_SHA256);
    }

    #[test]
    fn nothing_pinned_learns_and_accepts() {
        let (result, seen) = verify(None);
        assert!(result.is_ok(), "the first connect must be able to happen");
        assert_eq!(seen.as_deref(), Some(LEAF_SHA256), "learned nothing to show");
    }

    #[test]
    fn the_pinned_certificate_is_accepted() {
        assert!(verify(Some(LEAF_SHA256)).0.is_ok());
    }

    // A stored fingerprint may have been round-tripped through a file or a copy-paste. Refusing
    // the right certificate over letter case would look exactly like an attack to the user.
    #[test]
    fn case_does_not_decide_identity() {
        assert!(verify(Some(&LEAF_SHA256.to_lowercase())).0.is_ok());
    }

    #[test]
    fn a_different_certificate_is_refused_and_both_values_survive() {
        let other = "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99";
        let (result, seen) = verify(Some(other));

        let err = result.expect_err("a certificate that is not the pinned one must not connect");
        let text = err.to_string();
        // Asserted on the verifier's OWN message naming BOTH values: "some TLS error happened"
        // would pass for a wrong protocol version too, and would not prove the pin did the
        // refusing. The panel shows both, so both have to be in hand.
        assert!(text.contains(LEAF_SHA256), "{text}");
        assert!(text.contains(other), "{text}");
        assert_eq!(seen.as_deref(), Some(LEAF_SHA256), "nothing left to show the user");
    }

    #[test]
    fn a_pinned_config_builds() {
        assert!(pinned_tls(Some(LEAF_SHA256.to_string())).is_ok());
        assert!(pinned_tls(None).is_ok());
    }
}
