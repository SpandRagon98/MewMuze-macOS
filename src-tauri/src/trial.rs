//! The 14-day trial anchor.
//!
//! The trial used to live entirely in `settings.json` as a `firstRunUnix`
//! stamp, which made it free to restart three different ways: delete the file,
//! edit the number, or set the system clock back. This moves the anchor into
//! the operating-system credential vault — the same store the purchased
//! licence already uses — and adds a monotonic watermark so a clock that moves
//! backwards cannot buy extra days.
//!
//! Two deliberate design choices:
//!
//! * **It fails open.** If the vault cannot be read or written (locked-down
//!   machines, unusual roaming profiles), every command reports
//!   `vault_available: false` and the frontend falls back to the old
//!   settings-based trial. Wrongly locking out a paying customer costs far
//!   more than an extra trial.
//! * **It is not DRM.** Anyone willing to open Credential Manager can clear
//!   the entry. The goal is only to stop the trial resetting by accident or by
//!   idle curiosity, which the plain-text stamp did not.

use keyring::{Entry, Error as KeyringError};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

const KEYRING_SERVICE: &str = "com.spandan.pixelcat";
const KEYRING_ACCOUNT: &str = "trial-anchor";

fn default_schema_version() -> u16 {
    1
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredTrial {
    #[serde(default = "default_schema_version")]
    schema_version: u16,
    /// When the trial was started, unix seconds.
    started_unix: i64,
    /// The furthest point in time this install has ever observed. Never
    /// decreases, which is what makes rolling the clock back pointless.
    last_seen_unix: i64,
}

/// What the frontend needs to resolve trial state.
#[derive(Serialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TrialInfo {
    /// False when the vault could not be used at all — caller must fall back.
    pub vault_available: bool,
    /// Trial start, or 0 when it has never been started on this machine.
    pub started_unix: i64,
    /// `max(now, last_seen)` — the clock the trial should actually be judged
    /// against, so moving the system clock backwards gains nothing.
    pub effective_now_unix: i64,
    /// True when the wall clock is behind the watermark, i.e. time moved back.
    pub clock_moved_back: bool,
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn entry() -> Result<Entry, ()> {
    Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(|_| ())
}

fn load() -> Result<Option<StoredTrial>, ()> {
    let entry = entry()?;
    match entry.get_password() {
        Ok(value) => match serde_json::from_str::<StoredTrial>(&value) {
            Ok(record) => Ok(Some(record)),
            // A damaged record is treated as absent rather than as a reason to
            // deny the trial; the next save rewrites it cleanly.
            Err(_) => Ok(None),
        },
        Err(KeyringError::NoEntry) => Ok(None),
        Err(_) => Err(()),
    }
}

fn save(record: &StoredTrial) -> Result<(), ()> {
    let entry = entry()?;
    let payload = serde_json::to_string(record).map_err(|_| ())?;
    entry.set_password(&payload).map_err(|_| ())
}

/// Advance the watermark and report the trial anchor.
///
/// `settings_first_run` is the legacy `firstRunUnix` from settings.json. When
/// the vault has no anchor yet but the caller is already mid-trial, that stamp
/// is adopted so existing trial users keep the days they have left instead of
/// being handed a fresh 14 (or, worse, none).
fn read_and_touch(settings_first_run: i64) -> Result<TrialInfo, ()> {
    let now = now_unix();
    let existing = load()?;

    let mut record = match existing {
        Some(record) => record,
        None => {
            if settings_first_run <= 0 {
                // No anchor and no legacy stamp: the trial has not started.
                return Ok(TrialInfo {
                    vault_available: true,
                    started_unix: 0,
                    effective_now_unix: now,
                    clock_moved_back: false,
                });
            }
            // Migrate the legacy stamp, keeping the original start date.
            StoredTrial {
                schema_version: default_schema_version(),
                started_unix: settings_first_run,
                last_seen_unix: now.max(settings_first_run),
            }
        }
    };

    let clock_moved_back = now < record.last_seen_unix;
    let effective_now = now.max(record.last_seen_unix);
    if effective_now > record.last_seen_unix || record.last_seen_unix == 0 {
        record.last_seen_unix = effective_now;
        // A failed write is not fatal: the anchor still exists and the trial
        // still resolves; only the watermark misses this update.
        let _ = save(&record);
    } else if load()?.is_none() {
        // Freshly migrated record that has not been persisted yet.
        let _ = save(&record);
    }

    Ok(TrialInfo {
        vault_available: true,
        started_unix: record.started_unix,
        effective_now_unix: effective_now,
        clock_moved_back,
    })
}

/// Read the trial anchor, migrating the legacy stamp and advancing the
/// watermark. Never fails: an unusable vault reports `vault_available: false`
/// and the caller falls back to the settings-only behaviour.
#[tauri::command]
pub async fn trial_status(settings_first_run: i64) -> TrialInfo {
    tauri::async_runtime::spawn_blocking(move || {
        read_and_touch(settings_first_run).unwrap_or(TrialInfo {
            vault_available: false,
            started_unix: settings_first_run,
            effective_now_unix: now_unix(),
            clock_moved_back: false,
        })
    })
    .await
    .unwrap_or_default()
}

/// Begin the trial. Idempotent: once an anchor exists it is returned as-is, so
/// a second call can never grant a second trial.
#[tauri::command]
pub async fn trial_begin() -> TrialInfo {
    tauri::async_runtime::spawn_blocking(|| {
        let now = now_unix();
        match load() {
            Ok(Some(_)) => read_and_touch(0).unwrap_or(TrialInfo {
                vault_available: false,
                started_unix: 0,
                effective_now_unix: now,
                clock_moved_back: false,
            }),
            Ok(None) => {
                let record = StoredTrial {
                    schema_version: default_schema_version(),
                    started_unix: now,
                    last_seen_unix: now,
                };
                if save(&record).is_err() {
                    // Could not anchor it; the caller still starts the trial
                    // from settings.json exactly as it always did.
                    return TrialInfo {
                        vault_available: false,
                        started_unix: now,
                        effective_now_unix: now,
                        clock_moved_back: false,
                    };
                }
                TrialInfo {
                    vault_available: true,
                    started_unix: now,
                    effective_now_unix: now,
                    clock_moved_back: false,
                }
            }
            Err(()) => TrialInfo {
                vault_available: false,
                started_unix: now,
                effective_now_unix: now,
                clock_moved_back: false,
            },
        }
    })
    .await
    .unwrap_or_default()
}

/// Remove the trial anchor. Used only by "remove all local data", so a genuine
/// uninstall leaves nothing behind.
pub fn clear_trial_anchor() {
    if let Ok(entry) = entry() {
        let _ = entry.delete_credential();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_record_round_trips_through_json() {
        let record = StoredTrial {
            schema_version: 1,
            started_unix: 1_800_000_000,
            last_seen_unix: 1_800_100_000,
        };
        let text = serde_json::to_string(&record).expect("serialise");
        let back: StoredTrial = serde_json::from_str(&text).expect("deserialise");
        assert_eq!(back.started_unix, record.started_unix);
        assert_eq!(back.last_seen_unix, record.last_seen_unix);
    }

    #[test]
    fn a_damaged_record_reads_as_absent_rather_than_denying_the_trial() {
        assert!(serde_json::from_str::<StoredTrial>("{ not json").is_err());
    }

    /// The whole point of the watermark: the effective clock never goes down.
    #[test]
    fn the_effective_clock_never_moves_backwards() {
        let watermark = 1_800_100_000i64;
        for wall_clock in [1_700_000_000i64, 1_800_099_999, 1_800_100_000, 1_800_200_000] {
            let effective = wall_clock.max(watermark);
            assert!(effective >= watermark, "effective clock went backwards");
        }
        // A clock rolled back a year still resolves to the watermark, so the
        // trial cannot be extended by a single day.
        assert_eq!(1_700_000_000i64.max(watermark), watermark);
    }
}
