//! Microphone ACTIVITY detection — never microphone audio.
//!
//! We only ever answer one question: "is some other application capturing from
//! the microphone right now?" No audio is opened, recorded, transcribed,
//! analysed or stored, and no app names are returned to the frontend.
//!
//! Windows records per-app capture state under the CapabilityAccessManager
//! consent store. Each app subkey carries `LastUsedTimeStop`; while that app is
//! actively capturing the value is 0 (it gets a real timestamp when capture
//! ends). So "any subkey with LastUsedTimeStop == 0" == "the mic is live".
//!
//! The registry walk runs on its own thread and publishes into an atomic, so
//! the Tauri command is a non-blocking read. A synchronous command that did the
//! walk inline would sit on the UI thread — the same mistake that deadlocked
//! the app via the media-session API.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

static MIC_ACTIVE: AtomicBool = AtomicBool::new(false);
static WATCHER: OnceLock<()> = OnceLock::new();

#[cfg(windows)]
const CONSENT_ROOT: &str =
    r"SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";

#[cfg(windows)]
fn any_app_capturing() -> bool {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let Ok(root) = hkcu.open_subkey_with_flags(CONSENT_ROOT, KEY_READ) else {
        return false;
    };

    // An app is live when LastUsedTimeStop is still 0.
    fn key_is_live(key: &winreg::RegKey) -> bool {
        matches!(key.get_value::<u64, _>("LastUsedTimeStop"), Ok(0))
    }

    for name in root.enum_keys().flatten() {
        let Ok(app) = root.open_subkey_with_flags(&name, KEY_READ) else {
            continue;
        };
        // Desktop (non-store) apps are nested one level deeper.
        if name.eq_ignore_ascii_case("NonPackaged") {
            for sub in app.enum_keys().flatten() {
                if let Ok(k) = app.open_subkey_with_flags(&sub, KEY_READ) {
                    if key_is_live(&k) {
                        return true;
                    }
                }
            }
        } else if key_is_live(&app) {
            return true;
        }
    }
    false
}

/// Minimal CoreAudio binding: "is the default device for this scope currently
/// running?" — the same signal the macOS menu-bar mic indicator uses. Reads one
/// boolean property; never opens a stream, so no microphone permission prompt
/// and no access to audio.
#[cfg(target_os = "macos")]
pub mod coreaudio {
    #[repr(C)]
    struct PropertyAddress {
        selector: u32,
        scope: u32,
        element: u32,
    }

    #[link(name = "CoreAudio", kind = "framework")]
    extern "C" {
        fn AudioObjectGetPropertyData(
            object: u32,
            address: *const PropertyAddress,
            qualifier_size: u32,
            qualifier: *const std::ffi::c_void,
            data_size: *mut u32,
            data: *mut std::ffi::c_void,
        ) -> i32;
    }

    const SYSTEM_OBJECT: u32 = 1;
    const SCOPE_GLOBAL: u32 = u32::from_be_bytes(*b"glob");
    const DEFAULT_INPUT: u32 = u32::from_be_bytes(*b"dIn ");
    const DEFAULT_OUTPUT: u32 = u32::from_be_bytes(*b"dOut");
    const IS_RUNNING_SOMEWHERE: u32 = u32::from_be_bytes(*b"gone");

    fn get_u32(object: u32, selector: u32) -> Option<u32> {
        let addr = PropertyAddress {
            selector,
            scope: SCOPE_GLOBAL,
            element: 0,
        };
        let mut value: u32 = 0;
        let mut size = std::mem::size_of::<u32>() as u32;
        let status = unsafe {
            AudioObjectGetPropertyData(
                object,
                &addr,
                0,
                std::ptr::null(),
                &mut size,
                &mut value as *mut u32 as *mut std::ffi::c_void,
            )
        };
        (status == 0).then_some(value)
    }

    fn device_running(default_selector: u32) -> bool {
        let Some(device) = get_u32(SYSTEM_OBJECT, default_selector) else {
            return false;
        };
        if device == 0 {
            return false;
        }
        get_u32(device, IS_RUNNING_SOMEWHERE).unwrap_or(0) != 0
    }

    /// Some app is capturing from the default input device.
    pub fn input_running() -> bool {
        device_running(DEFAULT_INPUT)
    }

    /// Audio is playing through the default output device.
    pub fn output_running() -> bool {
        device_running(DEFAULT_OUTPUT)
    }
}

#[cfg(target_os = "macos")]
fn any_app_capturing() -> bool {
    coreaudio::input_running()
}

#[cfg(not(any(windows, target_os = "macos")))]
fn any_app_capturing() -> bool {
    false
}

/// Whether another application is currently using the microphone.
///
/// O(1): returns the last value published by the background poller.
#[tauri::command]
pub fn get_mic_active() -> bool {
    WATCHER.get_or_init(|| {
        std::thread::Builder::new()
            .name("mic-activity-poll".into())
            .spawn(|| loop {
                MIC_ACTIVE.store(any_app_capturing(), Ordering::Relaxed);
                std::thread::sleep(std::time::Duration::from_millis(1200));
            })
            .ok();
    });
    MIC_ACTIVE.load(Ordering::Relaxed)
}
