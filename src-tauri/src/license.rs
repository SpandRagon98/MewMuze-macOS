//! Offline licence-key verification.
//!
//! A licence key is `base64url(payload) . base64url(ed25519_signature)`, where
//! the payload is small JSON: `{"n":"buyer","o":"order id","t":issued_unix}`.
//!
//! Only the PUBLIC key ships in the app, so keys cannot be forged without the
//! seller's private key (see `scripts/make-license.mjs`). Verification is fully
//! offline — the app still makes no network requests to check a licence, which
//! keeps the privacy promise intact and means licences keep working forever.
//!
//! Client-side licensing is inherently bypassable by a determined user; this is
//! the standard pragmatic trade-off for indie desktop software — it stops casual
//! sharing without punishing honest buyers with an always-online check.

use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::Serialize;

/// Seller's licence public key (32 bytes, base64). Replace together with the
/// private key in `.keys/license.key` if you ever rotate it.
const LICENSE_PUBLIC_KEY_B64: &str = "CncBEkoAdZ1v46k81+wlJHnow0D0j6C/TkksmL7QIUM=";

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct LicenseStatus {
    pub valid: bool,
    /// Buyer name/email embedded in the key (display only).
    pub name: String,
    pub order: String,
    /// Why an invalid key failed, for a helpful message in the UI.
    pub error: String,
}

fn b64url_decode(s: &str) -> Option<Vec<u8>> {
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(s.trim())
        .ok()
        .or_else(|| base64::engine::general_purpose::STANDARD.decode(s.trim()).ok())
}

/// Verify a licence key against the embedded public key.
#[tauri::command]
pub fn verify_license(key: String) -> LicenseStatus {
    let fail = |msg: &str| LicenseStatus {
        valid: false,
        error: msg.to_string(),
        ..Default::default()
    };

    // Normalise: users paste keys with stray whitespace/newlines from emails.
    let cleaned: String = key.chars().filter(|c| !c.is_whitespace()).collect();
    if cleaned.is_empty() {
        return fail("Enter your licence key.");
    }
    let (payload_b64, sig_b64) = match cleaned.split_once('.') {
        Some(parts) => parts,
        None => return fail("That doesn't look like a licence key."),
    };

    let payload = match b64url_decode(payload_b64) {
        Some(p) => p,
        None => return fail("That licence key is malformed."),
    };
    let sig_bytes = match b64url_decode(sig_b64) {
        Some(s) => s,
        None => return fail("That licence key is malformed."),
    };
    let sig_arr: [u8; 64] = match sig_bytes.try_into() {
        Ok(a) => a,
        Err(_) => return fail("That licence key is malformed."),
    };

    let pk_bytes = match base64::engine::general_purpose::STANDARD.decode(LICENSE_PUBLIC_KEY_B64) {
        Ok(b) => b,
        Err(_) => return fail("Licence checking is not configured in this build."),
    };
    let pk_arr: [u8; 32] = match pk_bytes.try_into() {
        Ok(a) => a,
        Err(_) => return fail("Licence checking is not configured in this build."),
    };
    let verifying_key = match VerifyingKey::from_bytes(&pk_arr) {
        Ok(k) => k,
        Err(_) => return fail("Licence checking is not configured in this build."),
    };

    if verifying_key
        .verify(&payload, &Signature::from_bytes(&sig_arr))
        .is_err()
    {
        return fail("That licence key isn't valid.");
    }

    // Signature is good — pull the display fields out of the payload.
    let parsed: serde_json::Value = serde_json::from_slice(&payload).unwrap_or_default();
    LicenseStatus {
        valid: true,
        name: parsed.get("n").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        order: parsed.get("o").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        error: String::new(),
    }
}
