//! Battery state and the one-off approximate location (Paper build).
//!
//! `power_status` is a single cheap Win32 call (no polling thread): the
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
    /// Windows battery saver is on.
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

#[cfg(not(windows))]
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

#[cfg(not(windows))]
fn locate() -> Result<(f64, f64), String> {
    Err("Automatic location is not available on this platform.".into())
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
