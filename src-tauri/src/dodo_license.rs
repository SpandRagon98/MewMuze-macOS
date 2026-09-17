//! Dodo Payments licence activation.
//!
//! Dodo's public licence endpoints need no seller API key, so no commercial
//! secret is ever shipped in MewMuze. The purchased key and its activation
//! instance are stored in the operating-system credential vault through the
//! `keyring` crate. Existing offline-signed MewMuze keys remain handled by
//! `license.rs` and continue to work forever.

use keyring::{Entry, Error as KeyringError};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

/// Serialises every licence operation.
///
/// The commands below are `async` so their blocking HTTP never runs on the
/// main thread, which means two of them can now genuinely overlap — a
/// background validation landing while the customer clicks Activate, say. Each
/// one is a read-modify-write of a single credential-vault record, so without
/// this they could interleave and persist a half-updated record. Holding it for
/// the whole operation keeps the old main-thread serialisation guarantee while
/// giving up the main-thread *blocking*.
fn license_lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    let mutex = LOCK.get_or_init(|| Mutex::new(()));
    // A poisoned lock only means some earlier call panicked mid-operation;
    // the next caller re-reads the record from the vault anyway, so recovering
    // is strictly better than propagating the panic to every later call.
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

// Paper: its own credential-vault namespace. Sharing "com.spandan.pixelcat" with
// Pro let the experiment read, refresh - and potentially deactivate - the
// production licence. Paper must never touch Pro's licence state.
const KEYRING_SERVICE: &str = "com.spandan.pixelcat.paper";
const KEYRING_ACCOUNT: &str = "dodo-license";
const KEYRING_KEY_ACCOUNT: &str = "dodo-license-key";
const PRODUCT_ID: &str = match option_env!("MEWMUZE_DODO_PRODUCT_ID") {
    Some(product_id) => product_id,
    None => "pdt_0NkWDKYYlGSBLf59iNa4q",
};
const DEVICE_LIMIT: u32 = 3;
const OFFLINE_GRACE_DAYS: i64 = 30;
const OFFLINE_GRACE_SECONDS: i64 = OFFLINE_GRACE_DAYS * 24 * 60 * 60;
const LOCAL_STATUS_ENDPOINT: &str = "https://mewmuze.com/api/license-status.php";

fn default_schema_version() -> u16 {
    1
}

fn default_device_limit() -> u32 {
    DEVICE_LIMIT
}

fn default_activation_status() -> String {
    "active".to_string()
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredDodoLicense {
    #[serde(default = "default_schema_version")]
    schema_version: u16,
    #[serde(default, skip_serializing)]
    license_key: String,
    instance_id: String,
    #[serde(default)]
    license_key_id: String,
    #[serde(default)]
    product_id: String,
    #[serde(default)]
    installation_id: String,
    #[serde(default = "default_activation_status")]
    activation_status: String,
    #[serde(default = "default_device_limit")]
    device_limit: u32,
    #[serde(default)]
    devices_used: Option<u32>,
    environment: String,
    activated_at_unix: i64,
    last_validated_unix: i64,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DodoLicenseStatus {
    pub valid: bool,
    pub name: String,
    pub order: String,
    pub error: String,
    pub source: String,
    pub offline_grace: bool,
    pub last_validated_unix: i64,
    pub environment: String,
    pub product_id: String,
    pub activation_status: String,
    pub devices_used: Option<u32>,
    pub device_limit: u32,
}

#[derive(Debug)]
enum ApiError {
    Rejected(String),
    Offline,
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn configured_environment() -> &'static str {
    match option_env!("MEWMUZE_DODO_ENV") {
        Some("live") | Some("live_mode") => "live_mode",
        Some("test") | Some("test_mode") => "test_mode",
        // Commercial builds use Dodo's live environment. Developers can still
        // opt into the sandbox explicitly for a test product build.
        _ => "live_mode",
    }
}

fn api_base(environment: &str) -> &'static str {
    if environment == "live_mode" {
        "https://live.dodopayments.com"
    } else {
        "https://test.dodopayments.com"
    }
}

fn credential_entry() -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|error| format!("The system credential vault is unavailable: {error}"))
}

fn credential_key_entry() -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, KEYRING_KEY_ACCOUNT)
        .map_err(|error| format!("The system credential vault is unavailable: {error}"))
}

fn load_record() -> Result<Option<StoredDodoLicense>, String> {
    let entry = credential_entry()?;
    match entry.get_password() {
        Ok(value) => {
            let mut record: StoredDodoLicense = serde_json::from_str(&value).map_err(|_| {
                "The saved licence record is damaged. Use licence recovery for help.".to_string()
            })?;
            // v1 stored the key inside the vault's metadata JSON. Split it into
            // a dedicated secret entry during migration so metadata is never a
            // plaintext JSON copy of the purchased key.
            let embedded_key = !record.license_key.is_empty();
            if !embedded_key {
                record.license_key = match credential_key_entry()?.get_password() {
                    Ok(key) if !key.trim().is_empty() => key,
                    Ok(_) | Err(KeyringError::NoEntry) => {
                        return Err(
                            "The saved licence key is missing. Use licence recovery for help."
                                .to_string(),
                        )
                    }
                    Err(error) => {
                        return Err(format!("Could not read the saved licence key: {error}"))
                    }
                };
            }
            let changed = migrate_record(&mut record) || embedded_key;
            if changed {
                save_record(&record)?;
            }
            Ok(Some(record))
        }
        Err(KeyringError::NoEntry) => Ok(None),
        Err(error) => Err(format!("Could not read the saved licence: {error}")),
    }
}

/// Add fields introduced after the first shipping Dodo build without changing
/// the credential-store service/account names or discarding a valid activation.
fn migrate_record(record: &mut StoredDodoLicense) -> bool {
    let mut changed = false;
    if record.schema_version < 2 {
        record.schema_version = 2;
        changed = true;
    }
    if record.installation_id.is_empty() {
        record.installation_id = Uuid::new_v4().to_string();
        changed = true;
    }
    if record.product_id.is_empty() {
        record.product_id = PRODUCT_ID.to_string();
        changed = true;
    }
    if record.activation_status.is_empty() {
        record.activation_status = "active".to_string();
        changed = true;
    }
    if record.device_limit == 0 {
        record.device_limit = DEVICE_LIMIT;
        changed = true;
    }
    changed
}

fn save_record(record: &StoredDodoLicense) -> Result<(), String> {
    if record.license_key.trim().is_empty() {
        return Err("MewMuze refused to save an empty licence key.".to_string());
    }
    let value = serde_json::to_string(record).map_err(|error| error.to_string())?;
    let key_entry = credential_key_entry()?;
    let previous_key = key_entry.get_password().ok();
    key_entry
        .set_password(&record.license_key)
        .map_err(|error| format!("Could not save the licence key securely: {error}"))?;
    if let Err(error) = credential_entry()?.set_password(&value) {
        if let Some(previous) = previous_key {
            let _ = key_entry.set_password(&previous);
        } else {
            let _ = key_entry.delete_credential();
        }
        return Err(format!("Could not save the licence securely: {error}"));
    }
    Ok(())
}

pub(crate) fn delete_saved_record() -> Result<(), String> {
    for entry in [credential_entry()?, credential_key_entry()?] {
        match entry.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => {}
            Err(error) => return Err(format!("Could not remove the saved licence: {error}")),
        }
    }
    Ok(())
}

fn message_from_body(body: &str, fallback: &str) -> String {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("message")
                .or_else(|| value.get("detail"))
                .or_else(|| value.get("error"))
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .filter(|message| !message.trim().is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

fn friendly_rejection(message: &str) -> String {
    let lower = message.to_ascii_lowercase();
    if (lower.contains("activation") || lower.contains("instance"))
        && (lower.contains("limit") || lower.contains("maximum") || lower.contains("max"))
    {
        return format!(
            "This licence is already active on {DEVICE_LIMIT} devices. Deactivate MewMuze on one of them, then try again."
        );
    }
    if lower.contains("disabled") || lower.contains("revoked") || lower.contains("refund") {
        return "This licence has been revoked or refunded. Open licence help if you think this is a mistake.".to_string();
    }
    message.to_string()
}

fn post_json(environment: &str, path: &str, body: Value) -> Result<Value, ApiError> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(5))
        .timeout_read(Duration::from_secs(8))
        .timeout_write(Duration::from_secs(8))
        .build();
    let url = format!("{}{}", api_base(environment), path);
    let body_text = body.to_string();

    match agent
        .post(&url)
        .set("Content-Type", "application/json")
        .set("Accept", "application/json")
        .send_string(&body_text)
    {
        Ok(response) => {
            let text = response.into_string().map_err(|_| ApiError::Offline)?;
            serde_json::from_str(&text).map_err(|_| {
                ApiError::Rejected("The licence service returned an unreadable response.".into())
            })
        }
        // 5xx and 429 are the service having a bad day, not a bad licence:
        // treat both as offline so a paying customer keeps their grace period.
        Err(ureq::Error::Status(status, response)) if status >= 500 || status == 429 => {
            let _ = response.into_string();
            Err(ApiError::Offline)
        }
        Err(ureq::Error::Status(_, response)) => {
            let text = response.into_string().unwrap_or_default();
            Err(ApiError::Rejected(friendly_rejection(&message_from_body(
                &text,
                "That licence could not be accepted.",
            ))))
        }
        Err(ureq::Error::Transport(_)) => Err(ApiError::Offline),
    }
}

fn device_label() -> String {
    let hostname = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "this computer".to_string());
    format!("MewMuze on {hostname}")
}

fn valid_status(record: &StoredDodoLicense, offline_grace: bool) -> DodoLicenseStatus {
    DodoLicenseStatus {
        valid: true,
        name: "MewMuze owner".to_string(),
        order: record.instance_id.clone(),
        source: "dodo".to_string(),
        offline_grace,
        last_validated_unix: record.last_validated_unix,
        environment: record.environment.clone(),
        product_id: record.product_id.clone(),
        activation_status: record.activation_status.clone(),
        devices_used: record.devices_used,
        device_limit: record.device_limit,
        ..Default::default()
    }
}

fn invalid_status(message: impl Into<String>, environment: &str) -> DodoLicenseStatus {
    DodoLicenseStatus {
        error: message.into(),
        source: "dodo".to_string(),
        environment: environment.to_string(),
        device_limit: DEVICE_LIMIT,
        ..Default::default()
    }
}

fn response_text(value: &Value, paths: &[&[&str]]) -> String {
    for path in paths {
        let mut current = value;
        let mut found = true;
        for key in *path {
            match current.get(*key) {
                Some(next) => current = next,
                None => {
                    found = false;
                    break;
                }
            }
        }
        if found {
            if let Some(text) = current.as_str() {
                if !text.trim().is_empty() {
                    return text.trim().to_string();
                }
            }
        }
    }
    String::new()
}

fn update_device_usage(record: &mut StoredDodoLicense) {
    if record.license_key_id.is_empty() {
        return;
    }
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(3))
        .timeout_read(Duration::from_secs(5))
        .timeout_write(Duration::from_secs(5))
        .build();
    let response = agent
        .post(LOCAL_STATUS_ENDPOINT)
        .set("Content-Type", "application/json")
        .set("Accept", "application/json")
        .send_string(
            &json!({
                "license_key": record.license_key,
                "license_key_id": record.license_key_id,
                "license_key_instance_id": record.instance_id,
                "environment": record.environment,
            })
            .to_string(),
        );
    let Ok(response) = response else {
        return;
    };
    let Ok(text) = response.into_string() else {
        return;
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return;
    };
    if value.get("ok").and_then(Value::as_bool) != Some(true) {
        return;
    }
    if let Some(count) = value.get("devices_used").and_then(Value::as_u64) {
        record.devices_used = Some(count.min(u32::MAX as u64) as u32);
    }
    if let Some(limit) = value.get("device_limit").and_then(Value::as_u64) {
        record.device_limit = (limit.min(u32::MAX as u64) as u32).max(1);
    }
}

fn validation_body(record: &StoredDodoLicense) -> Value {
    json!({
        "license_key": record.license_key,
        "license_key_instance_id": record.instance_id,
    })
}

fn is_validation_valid(value: &Value) -> bool {
    value.get("valid").and_then(Value::as_bool).unwrap_or(false)
}

/// The real activation, blocking. Runs on a worker thread; see the command.
fn activate_blocking(key: String) -> DodoLicenseStatus {
    let cleaned = key.trim();
    let environment = configured_environment();
    if cleaned.is_empty() {
        return invalid_status("Enter your licence key.", environment);
    }

    // Never consume a second slot for the same installation, and never release
    // a known-good key merely because a different key was mistyped. Customers
    // change keys through the explicit Deactivate flow in Settings.
    if let Ok(Some(previous)) = load_record() {
        let belongs_to_this_build =
            previous.product_id == PRODUCT_ID && previous.environment == environment;
        if belongs_to_this_build
            && previous.license_key == cleaned
            && previous.activation_status == "active"
        {
            // The blocking form: we are already inside the worker thread and
            // already holding the licence lock.
            return check_blocking();
        }
        if belongs_to_this_build
            && previous.license_key != cleaned
            && previous.activation_status == "active"
        {
            return invalid_status(
                "This computer already has an active MewMuze licence. Deactivate it in Settings before using a different key.",
                &previous.environment,
            );
        }
    }

    let response = match post_json(
        environment,
        "/licenses/activate",
        json!({ "license_key": cleaned, "name": device_label() }),
    ) {
        Ok(value) => value,
        Err(ApiError::Rejected(message)) => return invalid_status(message, environment),
        Err(ApiError::Offline) => {
            return invalid_status(
                "MewMuze could not reach the licence service. Check your internet connection and try again.",
                environment,
            )
        }
    };

    let instance_id = response
        .get("id")
        .or_else(|| response.get("license_key_instance_id"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if instance_id.is_empty() {
        return invalid_status(
            "The licence service did not return an activation. Please try again.",
            environment,
        );
    }

    let license_key_id = response_text(&response, &[&["license_key_id"], &["licenseKeyId"]]);
    let response_product_id = response_text(
        &response,
        &[
            &["product", "product_id"],
            &["product", "id"],
            &["product_id"],
        ],
    );
    if !response_product_id.is_empty() && response_product_id != PRODUCT_ID {
        let temporary = StoredDodoLicense {
            schema_version: 2,
            license_key: cleaned.to_string(),
            instance_id,
            license_key_id,
            product_id: response_product_id,
            installation_id: Uuid::new_v4().to_string(),
            activation_status: "wrong_product".to_string(),
            device_limit: DEVICE_LIMIT,
            devices_used: None,
            environment: environment.to_string(),
            activated_at_unix: now_unix(),
            last_validated_unix: now_unix(),
        };
        let _ = post_json(
            environment,
            "/licenses/deactivate",
            validation_body(&temporary),
        );
        return invalid_status(
            "That key is for a different product, not MewMuze.",
            environment,
        );
    }

    let now = now_unix();
    let mut record = StoredDodoLicense {
        schema_version: 2,
        license_key: cleaned.to_string(),
        instance_id,
        license_key_id,
        product_id: if response_product_id.is_empty() {
            PRODUCT_ID.to_string()
        } else {
            response_product_id
        },
        installation_id: Uuid::new_v4().to_string(),
        activation_status: "active".to_string(),
        device_limit: DEVICE_LIMIT,
        devices_used: None,
        environment: environment.to_string(),
        activated_at_unix: now,
        last_validated_unix: now,
    };
    update_device_usage(&mut record);
    if let Err(error) = save_record(&record) {
        // Do not leave an activation consumed if the local secure save failed.
        let _ = post_json(
            environment,
            "/licenses/deactivate",
            validation_body(&record),
        );
        return invalid_status(error, environment);
    }

    valid_status(&record, false)
}

/// Restore the locally protected activation without touching the network.
/// Startup and post-update launch use this first, then validate silently later.
/// The real restore, blocking. Runs on a worker thread; see the command.
fn restore_blocking() -> DodoLicenseStatus {
    let record = match load_record() {
        Ok(Some(record)) => record,
        Ok(None) => return DodoLicenseStatus::default(),
        Err(error) => return invalid_status(error, configured_environment()),
    };
    if record.product_id != PRODUCT_ID || record.environment != configured_environment() {
        return invalid_status(
            "This activation belongs to an earlier MewMuze test build. Enter your live purchase key to continue.",
            configured_environment(),
        );
    }
    if record.activation_status != "active" {
        return invalid_status(
            "This saved licence is no longer active. Enter a valid key or open licence help.",
            &record.environment,
        );
    }
    let age = now_unix().saturating_sub(record.last_validated_unix);
    valid_status(&record, age > 24 * 60 * 60)
}

/// The real validation, blocking. Runs on a worker thread; see the command.
fn check_blocking() -> DodoLicenseStatus {
    let record = match load_record() {
        Ok(Some(record)) => record,
        Ok(None) => return DodoLicenseStatus::default(),
        Err(error) => return invalid_status(error, configured_environment()),
    };
    if record.product_id != PRODUCT_ID || record.environment != configured_environment() {
        return invalid_status(
            "This activation belongs to an earlier MewMuze test build. Enter your live purchase key to continue.",
            configured_environment(),
        );
    }

    match post_json(
        &record.environment,
        "/licenses/validate",
        validation_body(&record),
    ) {
        Ok(value) if is_validation_valid(&value) => {
            let mut refreshed = record;
            refreshed.last_validated_unix = now_unix();
            refreshed.activation_status = "active".to_string();
            update_device_usage(&mut refreshed);
            if let Err(error) = save_record(&refreshed) {
                return invalid_status(error, &refreshed.environment);
            }
            valid_status(&refreshed, false)
        }
        Ok(_) | Err(ApiError::Rejected(_)) => {
            let mut invalid = record;
            invalid.activation_status = "revoked".to_string();
            let _ = save_record(&invalid);
            invalid_status(
                "This licence was revoked, refunded, or deactivated. Your settings are safe; open licence help if this is unexpected.",
                &invalid.environment,
            )
        }
        Err(ApiError::Offline) => {
            let within_grace =
                now_unix().saturating_sub(record.last_validated_unix) <= OFFLINE_GRACE_SECONDS;
            if within_grace {
                valid_status(&record, true)
            } else {
                invalid_status(
                    "MewMuze has been offline for more than 30 days. Connect once to revalidate your licence.",
                    &record.environment,
                )
            }
        }
    }
}

/// The real deactivation, blocking. Runs on a worker thread; see the command.
fn deactivate_blocking() -> DodoLicenseStatus {
    let record = match load_record() {
        Ok(Some(record)) => record,
        Ok(None) => return DodoLicenseStatus::default(),
        Err(error) => return invalid_status(error, configured_environment()),
    };

    match post_json(
        &record.environment,
        "/licenses/deactivate",
        validation_body(&record),
    ) {
        Ok(_) | Err(ApiError::Rejected(_)) => match delete_saved_record() {
            Ok(()) => DodoLicenseStatus::default(),
            Err(error) => invalid_status(error, &record.environment),
        },
        Err(ApiError::Offline) => invalid_status(
            "Connect to the internet before deactivating this computer.",
            &record.environment,
        ),
    }
}

// ---------------------------------------------------------------------------
// Commands.
//
// Every one of these is `async` + `spawn_blocking` for the same reason
// `gmail_fetch` is: they reach the network (5 s connect + 8 s read) and the
// credential vault, and Tauri runs a NON-async command on the main thread —
// which on Windows is an STA. A plain sync command here freezes the whole cat
// for as long as the request takes. This is the identical mistake that once
// wedged the app through `get_media_playing`; the rule is that anything which
// can block never runs as a bare sync command.
//
// `license_lock()` is taken inside the worker so the operations still happen
// one at a time, which the old main-thread execution used to guarantee for
// free. It is deliberately acquired INSIDE spawn_blocking rather than around
// it, so waiting for the lock also never blocks the caller's thread.
// ---------------------------------------------------------------------------

/// Redeem a purchased key and activate this computer.
#[tauri::command]
pub async fn activate_dodo_license(key: String) -> DodoLicenseStatus {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = license_lock();
        activate_blocking(key)
    })
    .await
    .unwrap_or_else(|_| {
        invalid_status(
            "The licence check could not run. Please try again.",
            configured_environment(),
        )
    })
}

/// Reload the locally stored activation without touching the network.
#[tauri::command]
pub async fn restore_dodo_license() -> DodoLicenseStatus {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = license_lock();
        restore_blocking()
    })
    .await
    .unwrap_or_else(|_| {
        invalid_status(
            "The saved licence could not be read. Please try again.",
            configured_environment(),
        )
    })
}

/// Revalidate the stored activation against Dodo.
#[tauri::command]
pub async fn check_dodo_license() -> DodoLicenseStatus {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = license_lock();
        check_blocking()
    })
    .await
    .unwrap_or_else(|_| {
        invalid_status(
            "The licence check could not run. Please try again.",
            configured_environment(),
        )
    })
}

/// Release this computer's activation slot.
#[tauri::command]
pub async fn deactivate_dodo_license() -> DodoLicenseStatus {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = license_lock();
        deactivate_blocking()
    })
    .await
    .unwrap_or_else(|_| {
        invalid_status(
            "The deactivation could not run. Please try again.",
            configured_environment(),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Licence operations are read-modify-write over one vault record, so they
    /// must never interleave. They used to be serialised for free by running on
    /// the main thread; now that they run on worker threads, `license_lock()`
    /// is the only thing holding that guarantee.
    #[test]
    fn licence_operations_cannot_interleave() {
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        use std::sync::Arc;

        let inside = Arc::new(AtomicBool::new(false));
        let overlaps = Arc::new(AtomicUsize::new(0));
        let mut handles = Vec::new();

        for _ in 0..8 {
            let inside = Arc::clone(&inside);
            let overlaps = Arc::clone(&overlaps);
            handles.push(std::thread::spawn(move || {
                for _ in 0..50 {
                    let _guard = license_lock();
                    // If anyone else is already in the critical section, the
                    // lock is not doing its job.
                    if inside.swap(true, Ordering::SeqCst) {
                        overlaps.fetch_add(1, Ordering::SeqCst);
                    }
                    std::thread::yield_now();
                    inside.store(false, Ordering::SeqCst);
                }
            }));
        }
        for h in handles {
            h.join().expect("worker panicked");
        }
        assert_eq!(overlaps.load(Ordering::SeqCst), 0, "licence operations overlapped");
    }

    /// A panic inside one operation must not wedge every later one.
    #[test]
    fn a_poisoned_licence_lock_still_serves_the_next_caller() {
        let poisoned = std::thread::spawn(|| {
            let _guard = license_lock();
            panic!("simulated failure mid-operation");
        })
        .join();
        assert!(poisoned.is_err(), "the test thread was supposed to panic");
        // Recovering rather than propagating is the whole point.
        let _guard = license_lock();
    }

    /// The licence must survive the app exiting.
    ///
    /// keyring 3 falls back to an in-memory *mock* store when no platform
    /// backend feature is enabled, and the mock keeps the password inside the
    /// `Entry` object alone — so a second `Entry` for the same key sees
    /// nothing. A real OS vault hands it back. That difference is the whole
    /// test: it fails loudly if the `windows-native` / `apple-native` feature
    /// is ever dropped from Cargo.toml, which would otherwise silently make
    /// every customer re-enter their key on every launch.
    #[test]
    fn credential_vault_persists_beyond_a_single_entry() {
        let account = format!("mewmuze-vault-probe-{}", std::process::id());
        let writer = match Entry::new(KEYRING_SERVICE, &account) {
            Ok(e) => e,
            // No usable vault on this machine (headless CI, locked-down box).
            // Skip rather than fail: this guards the build config, not the host.
            Err(_) => return,
        };
        if writer.set_password("probe").is_err() {
            return;
        }

        let reader = Entry::new(KEYRING_SERVICE, &account).expect("second entry");
        let seen = reader.get_password();
        let _ = writer.delete_credential();

        assert_eq!(
            seen.ok().as_deref(),
            Some("probe"),
            "a separately created Entry could not read the stored password: keyring is using \
             its non-persistent mock store. Enable the platform backend feature in Cargo.toml \
             (windows-native / apple-native) or licences will not survive a restart."
        );
    }

    #[test]
    fn chooses_test_and_live_api_hosts() {
        assert_eq!(api_base("test_mode"), "https://test.dodopayments.com");
        assert_eq!(api_base("live_mode"), "https://live.dodopayments.com");
    }

    #[test]
    fn production_defaults_use_the_live_dodo_product() {
        assert_eq!(PRODUCT_ID, "pdt_0NkWDKYYlGSBLf59iNa4q");
        assert_eq!(configured_environment(), "live_mode");
    }

    #[test]
    fn recognises_only_an_explicit_valid_response() {
        assert!(is_validation_valid(&json!({ "valid": true })));
        assert!(!is_validation_valid(&json!({ "valid": false })));
        assert!(!is_validation_valid(&json!({})));
    }

    #[test]
    fn validation_includes_the_activation_instance() {
        let record = StoredDodoLicense {
            schema_version: 2,
            license_key: "KEY".into(),
            instance_id: "inst_123".into(),
            license_key_id: "lic_123".into(),
            product_id: PRODUCT_ID.into(),
            installation_id: "install_123".into(),
            activation_status: "active".into(),
            device_limit: DEVICE_LIMIT,
            devices_used: Some(1),
            environment: "test_mode".into(),
            activated_at_unix: 1,
            last_validated_unix: 2,
        };
        let body = validation_body(&record);
        assert_eq!(body["license_key"], "KEY");
        assert_eq!(body["license_key_instance_id"], "inst_123");
    }

    #[test]
    fn migrates_the_original_vault_record_without_changing_activation() {
        let old = r#"{"licenseKey":"KEY","instanceId":"inst_old","environment":"test_mode","activatedAtUnix":1,"lastValidatedUnix":2}"#;
        let mut record: StoredDodoLicense = serde_json::from_str(old).expect("old record");
        assert!(migrate_record(&mut record));
        assert_eq!(record.license_key, "KEY");
        assert_eq!(record.instance_id, "inst_old");
        assert_eq!(record.product_id, PRODUCT_ID);
        assert_eq!(record.device_limit, 3);
        assert!(!record.installation_id.is_empty());
        let metadata = serde_json::to_string(&record).expect("metadata");
        assert!(
            !metadata.contains("KEY"),
            "raw key must not be serialized into JSON metadata"
        );
    }

    #[test]
    fn activation_limit_errors_are_friendly() {
        assert_eq!(
            friendly_rejection("Maximum activation instances limit reached"),
            "This licence is already active on 3 devices. Deactivate MewMuze on one of them, then try again."
        );
    }

    #[test]
    fn offline_grace_is_thirty_days() {
        assert_eq!(OFFLINE_GRACE_SECONDS, 30 * 24 * 60 * 60);
    }
}
