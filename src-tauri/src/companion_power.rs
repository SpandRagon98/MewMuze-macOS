//! Battery state and the one-off approximate location (Paper build).
//!
//! `power_status` is a single cheap platform call - Win32 on Windows, IOKit's
//! power-source snapshot on macOS - with no polling thread: the
//! companion's scheduler asks every few minutes and stretches its internet
//! refresh while unplugged. `approx_location` runs only when the user presses
//! "Use my approximate location", goes through Windows' own location
//! permission, and rounds to two decimals (~1 km) before anything leaves Rust.

use serde::Serialize;

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PowerStatus {
    pub on_battery: bool,
    pub percent: Option<u8>,
    /// Windows battery saver / macOS Low Power Mode is on.
    pub os_saver: bool,
    /// The platform answered.
    pub known: bool,
}

#[cfg(windows)]
#[tauri::command]
pub fn power_status() -> PowerStatus {
    use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    let mut s = SYSTEM_POWER_STATUS::default();
    if unsafe { GetSystemPowerStatus(&mut s) }.is_err() {
        return PowerStatus::default();
    }
    let no_battery = s.BatteryFlag == 128 || s.BatteryFlag == 255;
    PowerStatus {
        // 0 = offline (on battery), 1 = on AC, 255 = unknown.
        on_battery: s.ACLineStatus == 0 && !no_battery,
        percent: (s.BatteryLifePercent <= 100 && !no_battery).then_some(s.BatteryLifePercent),
        os_saver: s.SystemStatusFlag == 1,
        known: s.ACLineStatus != 255,
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use core_foundation::array::{CFArray, CFArrayRef};
    use core_foundation::base::{CFType, CFTypeRef, TCFType};
    use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
    use core_foundation::number::CFNumber;
    use core_foundation::string::{CFString, CFStringRef};

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOPSCopyPowerSourcesInfo() -> CFTypeRef;
        fn IOPSCopyPowerSourcesList(blob: CFTypeRef) -> CFArrayRef;
        fn IOPSGetPowerSourceDescription(blob: CFTypeRef, source: CFTypeRef) -> CFDictionaryRef;
        fn IOPSGetProvidingPowerSourceType(snapshot: CFTypeRef) -> CFStringRef;
    }

    /// (on battery, battery percent) from one IOKit snapshot; None if it is unavailable.
    pub fn battery() -> Option<(bool, Option<u8>)> {
        unsafe {
            let raw = IOPSCopyPowerSourcesInfo();
            if raw.is_null() {
                return None;
            }
            let blob = CFType::wrap_under_create_rule(raw);
            let providing = IOPSGetProvidingPowerSourceType(blob.as_CFTypeRef());
            let on_battery = !providing.is_null() && CFString::wrap_under_get_rule(providing) == "Battery Power";
            let list_ref = IOPSCopyPowerSourcesList(blob.as_CFTypeRef());
            if list_ref.is_null() {
                return Some((on_battery, None));
            }
            let list: CFArray<CFType> = CFArray::wrap_under_create_rule(list_ref);
            for source in list.iter() {
                let d = IOPSGetPowerSourceDescription(blob.as_CFTypeRef(), source.as_CFTypeRef());
                if d.is_null() {
                    continue;
                }
                let desc: CFDictionary<CFString, CFType> = CFDictionary::wrap_under_get_rule(d);
                let num = |k: &str| desc.find(CFString::new(k)).and_then(|v| v.downcast::<CFNumber>()).and_then(|n| n.to_i64());
                let is_internal = desc
                    .find(CFString::new("Type"))
                    .and_then(|v| v.downcast::<CFString>())
                    .map(|t| t == "InternalBattery")
                    .unwrap_or(false);
                if !is_internal {
                    continue;
                }
                let pct = match (num("Current Capacity"), num("Max Capacity")) {
                    (Some(c), Some(m)) if m > 0 => Some(((c * 100) / m).clamp(0, 100) as u8),
                    _ => None,
                };
                return Some((on_battery, pct));
            }
            // A desktop Mac: no internal battery, always on AC.
            Some((false, None))
        }
    }

    /// Low Power Mode (macOS 12+; older systems simply do not have it).
    pub fn low_power_mode() -> bool {
        use objc2::runtime::{AnyClass, AnyObject, Bool};
        use objc2::{msg_send, sel};
        let Some(cls) = AnyClass::get(c"NSProcessInfo") else { return false };
        unsafe {
            let info: *mut AnyObject = msg_send![cls, processInfo];
            if info.is_null() {
                return false;
            }
            let has: Bool = msg_send![info, respondsToSelector: sel!(isLowPowerModeEnabled)];
            if !has.as_bool() {
                return false;
            }
            let on: Bool = msg_send![info, isLowPowerModeEnabled];
            on.as_bool()
        }
    }
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn power_status() -> PowerStatus {
    let Some((on_battery, percent)) = mac::battery() else { return PowerStatus::default() };
    PowerStatus { on_battery, percent, os_saver: mac::low_power_mode(), known: true }
}

#[cfg(not(any(windows, target_os = "macos")))]
#[tauri::command]
pub fn power_status() -> PowerStatus {
    PowerStatus::default()
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ApproxLocation {
    pub ok: bool,
    pub lat: f64,
    pub lon: f64,
    pub error: Option<String>,
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

#[cfg(windows)]
fn locate() -> Result<(f64, f64), String> {
    use windows::Devices::Geolocation::{GeolocationAccessStatus, Geolocator, PositionAccuracy};
    use windows::Foundation::TimeSpan;
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

    // A fresh worker thread: join the multithreaded apartment before WinRT.
    let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    let access = Geolocator::RequestAccessAsync()
        .and_then(|op| op.get())
        .map_err(|e| format!("Location unavailable: {e}"))?;
    if access != GeolocationAccessStatus::Allowed {
        return Err("Location is off for desktop apps in Windows Settings → Privacy → Location.".into());
    }
    let g = Geolocator::new().map_err(|e| e.to_string())?;
    // Default accuracy: Wi-Fi / IP level, never asks for GPS precision.
    g.SetDesiredAccuracy(PositionAccuracy::Default).map_err(|e| e.to_string())?;
    let hour = TimeSpan { Duration: 36_000_000_000 };
    let ten_s = TimeSpan { Duration: 100_000_000 };
    let pos = g
        .GetGeopositionAsyncWithAgeAndTimeout(hour, ten_s)
        .and_then(|op| op.get())
        .map_err(|e| format!("Could not get a position: {e}"))?;
    let p = pos
        .Coordinate()
        .and_then(|c| c.Point())
        .and_then(|pt| pt.Position())
        .map_err(|e| e.to_string())?;
    Ok((p.Latitude, p.Longitude))
}

// ponytail: macOS would need CoreLocation (a delegate, a run loop and a new
// permission prompt); the city picker covers it until someone asks.
#[cfg(not(windows))]
fn locate() -> Result<(f64, f64), String> {
    Err("Automatic location isn't available on this computer yet. Choose your city instead.".into())
}

#[tauri::command]
pub async fn approx_location() -> ApproxLocation {
    let r = tauri::async_runtime::spawn_blocking(locate).await.unwrap_or_else(|_| Err("Location lookup failed.".into()));
    match r {
        Ok((lat, lon)) if lat.is_finite() && lon.is_finite() => ApproxLocation { ok: true, lat: round2(lat), lon: round2(lon), error: None },
        Ok(_) => ApproxLocation { error: Some("No position.".into()), ..Default::default() },
        Err(e) => ApproxLocation { error: Some(e), ..Default::default() },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coordinates_are_rounded_to_about_a_kilometre() {
        assert_eq!(round2(12.971_599), 12.97);
        assert_eq!(round2(-77.594_6), -77.59);
    }

    #[test]
    fn power_status_answers_without_panicking() {
        let s = power_status();
        if let Some(p) = s.percent {
            assert!(p <= 100);
        }
    }
}
