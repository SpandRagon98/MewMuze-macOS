//! Enumerate visible top-level windows and monitors, returning ONLY geometry.
//!
//! Windows APIs used (all read-only): `EnumWindows`, `IsWindowVisible`,
//! `IsIconic`, `GetWindowTextLengthW` / `GetWindowTextW` (title used solely to
//! filter — never stored or returned), `GetWindowLongW` (to skip tool windows),
//! `DwmGetWindowAttribute` (cloaked test + extended frame bounds),
//! `GetWindowRect`, `EnumDisplayMonitors`, `GetMonitorInfoW`, `GetDpiForMonitor`.
//!
//! The cat treats the TOP edge of each eligible window as a walkable ledge; the
//! actual title-bar height is intentionally approximated (spec §10).

use serde::Serialize;

/// Title of our own overlay window, so we can exclude it from enumeration.
///
/// Windows-only: the macOS enumerator skips our own windows by PID instead,
/// because reading window TITLES there would require Screen Recording.
#[cfg(windows)]
pub const OVERLAY_TITLE: &str = "MewMuze";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowRect {
    pub hwnd: i64,
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
    pub is_large: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfoOut {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
    pub work_left: i32,
    pub work_top: i32,
    pub work_right: i32,
    pub work_bottom: i32,
    pub scale: f64,
    pub is_primary: bool,
}

#[cfg(windows)]
mod imp {
    use super::{MonitorInfoOut, WindowRect, OVERLAY_TITLE};
    use std::mem::size_of;
    use windows::Win32::Foundation::{BOOL, HWND, LPARAM, RECT, TRUE};
    use windows::Win32::Graphics::Dwm::{
        DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS,
    };
    use windows::Win32::Graphics::Gdi::{
        EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFOEXW,
    };

    /// `MONITORINFOF_PRIMARY` flag value (not re-exported by this windows crate build).
    const MONITORINFOF_PRIMARY: u32 = 1;
    use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowLongW, GetWindowRect, GetWindowTextLengthW, GetWindowTextW, IsIconic,
        IsWindowVisible, GWL_EXSTYLE, WS_EX_TOOLWINDOW,
    };

    unsafe extern "system" fn enum_windows_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let out = &mut *(lparam.0 as *mut Vec<WindowRect>);

        if !IsWindowVisible(hwnd).as_bool() {
            return TRUE;
        }
        if IsIconic(hwnd).as_bool() {
            return TRUE;
        }

        // Skip DWM-cloaked windows (e.g. background UWP apps on other desktops).
        let mut cloaked: u32 = 0;
        let _ = DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            &mut cloaked as *mut u32 as *mut core::ffi::c_void,
            size_of::<u32>() as u32,
        );
        if cloaked != 0 {
            return TRUE;
        }

        // Skip windows with no title (most invisible/utility/shell surfaces).
        let len = GetWindowTextLengthW(hwnd);
        if len == 0 {
            return TRUE;
        }
        let mut buf = vec![0u16; (len + 1) as usize];
        let got = GetWindowTextW(hwnd, &mut buf);
        let title = String::from_utf16_lossy(&buf[..got as usize]);
        if title == OVERLAY_TITLE {
            return TRUE; // never treat our own overlay as a platform
        }

        // Skip tool windows (palettes, tooltips, etc.).
        let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
        if ex & WS_EX_TOOLWINDOW.0 != 0 {
            return TRUE;
        }

        // Prefer the DWM extended frame bounds; fall back to the raw rect.
        let mut rect = RECT::default();
        let hr = DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut rect as *mut RECT as *mut core::ffi::c_void,
            size_of::<RECT>() as u32,
        );
        if hr.is_err() {
            let _ = GetWindowRect(hwnd, &mut rect);
        }

        let w = rect.right - rect.left;
        let h = rect.bottom - rect.top;
        if w <= 0 || h <= 0 {
            return TRUE;
        }
        let is_large = w >= 120 && h >= 80;
        out.push(WindowRect {
            hwnd: hwnd.0 as isize as i64,
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            is_large,
        });
        TRUE
    }

    pub fn enumerate_windows() -> Vec<WindowRect> {
        let mut out: Vec<WindowRect> = Vec::new();
        unsafe {
            let _ = EnumWindows(
                Some(enum_windows_proc),
                LPARAM(&mut out as *mut Vec<WindowRect> as isize),
            );
        }
        out
    }

    unsafe extern "system" fn enum_monitor_proc(
        hmon: HMONITOR,
        _hdc: HDC,
        _rect: *mut RECT,
        lparam: LPARAM,
    ) -> BOOL {
        let out = &mut *(lparam.0 as *mut Vec<MonitorInfoOut>);
        let mut mi: MONITORINFOEXW = std::mem::zeroed();
        mi.monitorInfo.cbSize = size_of::<MONITORINFOEXW>() as u32;
        if GetMonitorInfoW(hmon, &mut mi.monitorInfo as *mut _).as_bool() {
            let mut dpi_x: u32 = 96;
            let mut dpi_y: u32 = 96;
            let _ = GetDpiForMonitor(hmon, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y);
            let rc = mi.monitorInfo.rcMonitor;
            let wk = mi.monitorInfo.rcWork;
            out.push(MonitorInfoOut {
                left: rc.left,
                top: rc.top,
                right: rc.right,
                bottom: rc.bottom,
                work_left: wk.left,
                work_top: wk.top,
                work_right: wk.right,
                work_bottom: wk.bottom,
                scale: dpi_x as f64 / 96.0,
                is_primary: mi.monitorInfo.dwFlags & MONITORINFOF_PRIMARY != 0,
            });
        }
        TRUE
    }

    pub fn get_monitors() -> Vec<MonitorInfoOut> {
        let mut out: Vec<MonitorInfoOut> = Vec::new();
        unsafe {
            let _ = EnumDisplayMonitors(
                HDC::default(),
                None,
                Some(enum_monitor_proc),
                LPARAM(&mut out as *mut Vec<MonitorInfoOut> as isize),
            );
        }
        out
    }
}

/// macOS equivalent of the Win32 enumeration: on-screen, non-desktop windows,
/// returned as geometry only. Uses the window list's own owner-PID field to
/// skip our own overlay, so no window TITLE is ever read — which also means
/// this needs no Screen Recording permission (titles would).
#[cfg(target_os = "macos")]
mod imp_mac {
    use super::WindowRect;
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::number::CFNumber;
    use core_foundation::string::CFString;
    use core_graphics::display::{
        kCGNullWindowID, kCGWindowListExcludeDesktopElements, kCGWindowListOptionOnScreenOnly,
        CGDisplay,
    };

    /// A nested dictionary value, viewed with the same typed wrapper used for
    /// the top-level entries.
    ///
    /// `CFType::downcast` cannot produce a `CFDictionary<CFString, CFType>`:
    /// core-foundation implements `ConcreteCFType` only for the untyped
    /// `CFDictionary<*const c_void, *const c_void>`. Checking the type id and
    /// re-wrapping is that same operation without the bound, and it still
    /// refuses anything that is not actually a dictionary.
    fn sub_dict(
        dict: &CFDictionary<CFString, CFType>,
        key: &str,
    ) -> Option<CFDictionary<CFString, CFType>> {
        let value = dict.find(&CFString::new(key))?;
        if value.type_of() != CFDictionary::<CFString, CFType>::type_id() {
            return None;
        }
        Some(unsafe { CFDictionary::wrap_under_get_rule(value.as_CFTypeRef() as _) })
    }

    fn num(dict: &CFDictionary<CFString, CFType>, key: &str) -> Option<f64> {
        dict.find(&CFString::new(key))
            .and_then(|v| v.downcast::<CFNumber>())
            .and_then(|n| n.to_f64())
    }

    pub fn enumerate_windows() -> Vec<WindowRect> {
        let own_pid = std::process::id() as f64;
        let mut out: Vec<WindowRect> = Vec::new();

        let Some(list) = CGDisplay::window_list_info(
            kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
            Some(kCGNullWindowID),
        ) else {
            return out;
        };

        for item in list.iter() {
            let dict: CFDictionary<CFString, CFType> =
                unsafe { CFDictionary::wrap_under_get_rule(*item as _) };

            // Skip our own overlay by PID rather than by title — reading titles
            // would require Screen Recording permission; geometry does not.
            if num(&dict, "kCGWindowOwnerPID") == Some(own_pid) {
                continue;
            }
            // Layer 0 == normal application windows. Anything else is shell
            // furniture (menu bar, Dock, notifications) and is not walkable.
            if num(&dict, "kCGWindowLayer").unwrap_or(1.0) != 0.0 {
                continue;
            }
            // Geometry lives in a NESTED kCGWindowBounds dictionary.
            let Some(bounds) = sub_dict(&dict, "kCGWindowBounds") else {
                continue;
            };
            let (Some(x), Some(y), Some(w), Some(h)) = (
                num(&bounds, "X"),
                num(&bounds, "Y"),
                num(&bounds, "Width"),
                num(&bounds, "Height"),
            ) else {
                continue;
            };
            if w <= 0.0 || h <= 0.0 {
                continue;
            }
            out.push(WindowRect {
                hwnd: num(&dict, "kCGWindowNumber").unwrap_or(0.0) as i64,
                left: x as i32,
                top: y as i32,
                right: (x + w) as i32,
                bottom: (y + h) as i32,
                is_large: w >= 120.0 && h >= 80.0,
            });
        }
        out
    }

    pub fn get_monitors() -> Vec<super::MonitorInfoOut> {
        let mut out = Vec::new();
        let Ok(ids) = CGDisplay::active_displays() else {
            return out;
        };
        let main_id = CGDisplay::main().id;
        // One window-list query for the whole loop; asking per display would
        // walk the same list N times for no benefit.
        let furniture = shell_furniture();
        for id in ids {
            let d = CGDisplay::new(id);
            let b = d.bounds();
            let (l, t) = (b.origin.x as i32, b.origin.y as i32);
            let (w, h) = (b.size.width as i32, b.size.height as i32);
            // Retina: backing pixels / points. CGDisplay reports bounds in
            // points, so this yields 2.0 on Retina and 1.0 otherwise —
            // exactly the shape the frontend expects from the Windows path.
            let scale = if b.size.width > 0.0 {
                d.pixels_wide() as f64 / b.size.width
            } else {
                1.0
            };
            let work = visible_frame(l, t, l + w, t + h, &furniture);
            out.push(super::MonitorInfoOut {
                left: l,
                top: t,
                right: l + w,
                bottom: t + h,
                work_left: work.0,
                work_top: work.1,
                work_right: work.2,
                work_bottom: work.3,
                scale,
                is_primary: id == main_id,
            });
        }
        out
    }

    /// A piece of system chrome that eats into a display's usable area.
    struct Furniture {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
        /// The Dock, as opposed to the menu bar. They need different rules:
        /// the menu bar spans the whole display, the Dock is only as wide as
        /// its icons.
        is_dock: bool,
    }

    /// The menu bar and the Dock, read from the window server.
    ///
    /// The canonical source for this is `NSScreen.visibleFrame`, which needs
    /// AppKit. Reaching AppKit from here would mean either a new objc2
    /// dependency or hand-rolled `objc_msgSend` declarations — and NSRect is
    /// returned through `objc_msgSend_stret` on x86_64 but in registers on
    /// arm64, so a hand-rolled bridge is exactly the kind of code that works on
    /// Apple Silicon and corrupts the stack on Intel.
    ///
    /// The window server already publishes both pieces of chrome as ordinary
    /// windows above layer 0, and this file is reading that list anyway. Owner
    /// name and bounds need no Screen Recording permission (only window TITLES
    /// do), so this is the same permission-free footprint as everything else
    /// here.
    fn shell_furniture() -> Vec<Furniture> {
        use core_graphics::display::{
            kCGNullWindowID, kCGWindowListOptionOnScreenOnly, CGDisplay,
        };

        let mut out = Vec::new();
        // Deliberately WITHOUT kCGWindowListExcludeDesktopElements: the menu
        // bar and the Dock are precisely the desktop elements that filter drops.
        let Some(list) =
            CGDisplay::window_list_info(kCGWindowListOptionOnScreenOnly, Some(kCGNullWindowID))
        else {
            return out;
        };

        for item in list.iter() {
            let dict: CFDictionary<CFString, CFType> =
                unsafe { CFDictionary::wrap_under_get_rule(*item as _) };
            // Layer 0 is ordinary application windows; chrome sits above it.
            if num(&dict, "kCGWindowLayer").unwrap_or(0.0) <= 0.0 {
                continue;
            }
            let owner = dict
                .find(&CFString::new("kCGWindowOwnerName"))
                .and_then(|v| v.downcast::<CFString>())
                .map(|s| s.to_string())
                .unwrap_or_default();
            // "Window Server" owns the menu bar; "Dock" owns the Dock. Every
            // other floating element (notifications, Spotlight, other apps'
            // panels) comes and goes and must NOT shrink the walkable area.
            if owner != "Dock" && owner != "Window Server" {
                continue;
            }
            let Some(bounds) = sub_dict(&dict, "kCGWindowBounds") else {
                continue;
            };
            let (Some(x), Some(y), Some(w), Some(h)) = (
                num(&bounds, "X"),
                num(&bounds, "Y"),
                num(&bounds, "Width"),
                num(&bounds, "Height"),
            ) else {
                continue;
            };
            if w <= 0.0 || h <= 0.0 {
                continue;
            }
            out.push(Furniture {
                left: x as i32,
                top: y as i32,
                right: (x + w) as i32,
                bottom: (y + h) as i32,
                is_dock: owner == "Dock",
            });
        }
        out
    }

    /// Shrink a display rect by whichever edges the chrome occupies.
    ///
    /// Chrome counts only when it is against an edge and thin relative to the
    /// display, so the Dock takes height off the bottom when it is at the
    /// bottom and width off a side when it is on a side. An auto-hidden Dock is
    /// a sliver or parked off-screen and takes essentially nothing. Anything
    /// unrecognised leaves the area alone, which degrades to the old behaviour
    /// rather than trapping the cat in a shrinking box.
    fn visible_frame(
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
        furniture: &[Furniture],
    ) -> (i32, i32, i32, i32) {
        let (mut wl, mut wt, mut wr, mut wb) = (left, top, right, bottom);
        let width = (right - left).max(1);
        let height = (bottom - top).max(1);

        for f in furniture {
            // Ignore chrome belonging to a different display.
            if f.right <= left || f.left >= right || f.bottom <= top || f.top >= bottom {
                continue;
            }
            let across_h = (f.right.min(right) - f.left.max(left)).max(0);
            let across_v = (f.bottom.min(bottom) - f.top.max(top)).max(0);
            let thickness_v = (f.bottom - f.top).max(0);
            let thickness_h = (f.right - f.left).max(0);

            // How much of an edge a strip must cover to count as chrome.
            //
            // The menu bar spans the whole display. The DOCK does not: it is
            // centred and only as wide as its icons, so on a 1440pt display a
            // six-icon Dock is under 500pt. Demanding half the edge from it
            // meant the Dock was never recognised, the work area stayed the
            // full display, and the cat walked to the bottom of the screen and
            // disappeared behind the Dock. A tenth of the edge still rejects
            // stray panels without rejecting a small Dock.
            let min_h = if f.is_dock { width / 10 } else { width / 2 };
            let min_v = if f.is_dock { height / 10 } else { height / 2 };

            // A strip is only an inset if it is thin relative to the display;
            // a full-screen-sized element is something else entirely.
            if across_h >= min_h && thickness_v * 3 < height {
                if f.top <= top + 2 {
                    wt = wt.max(f.bottom.min(bottom)); // menu bar
                    continue;
                }
                if f.bottom >= bottom - 2 {
                    wb = wb.min(f.top.max(top)); // Dock along the bottom
                    continue;
                }
            }
            if across_v >= min_v && thickness_h * 3 < width {
                if f.left <= left + 2 {
                    wl = wl.max(f.right.min(right)); // Dock on the left
                } else if f.right >= right - 2 {
                    wr = wr.min(f.left.max(left)); // Dock on the right
                }
            }
        }

        // Never hand back an inverted or empty rectangle, whatever the window
        // server reported: the cat's floor is derived from these numbers.
        if wr - wl < width / 4 || wb - wt < height / 4 {
            return (left, top, right, bottom);
        }
        (wl, wt, wr, wb)
    }


    #[cfg(test)]
    mod tests {
        use super::{visible_frame, Furniture};

        // A 1440x900 display at the origin, the shape of a MacBook screen in
        // points. The Dock and menu bar sizes below are the real defaults.
        const L: i32 = 0;
        const T: i32 = 0;
        const R: i32 = 1440;
        const B: i32 = 900;

        fn dock(left: i32, top: i32, right: i32, bottom: i32) -> Furniture {
            Furniture { left, top, right, bottom, is_dock: true }
        }
        fn chrome(left: i32, top: i32, right: i32, bottom: i32) -> Furniture {
            Furniture { left, top, right, bottom, is_dock: false }
        }
        fn menu_bar() -> Furniture {
            chrome(L, T, R, 25)
        }

        #[test]
        fn no_chrome_leaves_the_whole_display_walkable() {
            assert_eq!(visible_frame(L, T, R, B, &[]), (L, T, R, B));
        }

        #[test]
        fn the_menu_bar_lowers_the_ceiling() {
            let (_, wt, _, _) = visible_frame(L, T, R, B, &[menu_bar()]);
            assert_eq!(wt, 25);
        }

        #[test]
        fn a_small_dock_still_raises_the_floor() {
            // THE REGRESSION. A six-icon Dock is ~480pt wide on a 1440pt
            // display — barely a third of the edge. The first implementation
            // demanded half, so the Dock was never seen, the floor stayed at
            // the bottom of the screen, and the cat walked behind it.
            let d = dock(480, 820, 960, 900);
            let (_, _, _, wb) = visible_frame(L, T, R, B, &[d]);
            assert_eq!(wb, 820, "a narrow Dock must still raise the floor");
        }

        #[test]
        fn a_wide_dock_raises_the_floor_too() {
            let (_, _, _, wb) = visible_frame(L, T, R, B, &[dock(200, 810, 1240, 900)]);
            assert_eq!(wb, 810);
        }

        #[test]
        fn a_left_dock_narrows_the_width_not_the_height() {
            let (wl, wt, wr, wb) = visible_frame(L, T, R, B, &[dock(0, 250, 80, 650)]);
            assert_eq!(wl, 80);
            assert_eq!((wt, wr, wb), (T, R, B), "a side Dock must not touch the floor");
        }

        #[test]
        fn a_right_dock_narrows_the_width() {
            let (wl, _, wr, _) = visible_frame(L, T, R, B, &[dock(1360, 250, 1440, 650)]);
            assert_eq!(wr, 1360);
            assert_eq!(wl, L);
        }

        #[test]
        fn menu_bar_and_dock_together() {
            let (wl, wt, wr, wb) =
                visible_frame(L, T, R, B, &[menu_bar(), dock(480, 820, 960, 900)]);
            assert_eq!((wl, wt, wr, wb), (0, 25, 1440, 820));
        }

        #[test]
        fn an_auto_hidden_dock_costs_almost_nothing() {
            // Hidden, it is a 4pt sliver against the bottom edge.
            let (_, _, _, wb) = visible_frame(L, T, R, B, &[dock(480, 896, 960, 900)]);
            assert_eq!(wb, 896);
        }

        #[test]
        fn a_dock_parked_off_screen_is_ignored() {
            let (wl, wt, wr, wb) = visible_frame(L, T, R, B, &[dock(480, 900, 960, 980)]);
            assert_eq!((wl, wt, wr, wb), (L, T, R, B));
        }

        #[test]
        fn a_floating_panel_is_not_chrome() {
            // A notification banner: not against any edge, so it must not
            // shrink anything. Chrome is defined by touching an edge.
            let (wl, wt, wr, wb) = visible_frame(L, T, R, B, &[chrome(1000, 60, 1400, 180)]);
            assert_eq!((wl, wt, wr, wb), (L, T, R, B));
        }

        #[test]
        fn a_full_screen_element_is_not_a_thin_strip() {
            // Something covering the display (a wallpaper window, a transition)
            // must never be mistaken for an inset and blank the work area.
            let (wl, wt, wr, wb) = visible_frame(L, T, R, B, &[chrome(L, T, R, B)]);
            assert_eq!((wl, wt, wr, wb), (L, T, R, B));
        }

        #[test]
        fn chrome_on_another_display_is_ignored() {
            // A second display to the right owns its own Dock; it must not
            // shrink this one.
            let (wl, wt, wr, wb) = visible_frame(L, T, R, B, &[dock(1900, 820, 2400, 900)]);
            assert_eq!((wl, wt, wr, wb), (L, T, R, B));
        }

        #[test]
        fn a_second_display_gets_its_own_insets() {
            // Displays sit side by side in one global space, so the second one
            // is offset. Its Dock is at ITS bottom edge.
            let (l2, t2, r2, b2) = (1440, 0, 3360, 1080);
            let (wl, wt, wr, wb) =
                visible_frame(l2, t2, r2, b2, &[dock(2100, 990, 2700, 1080)]);
            assert_eq!((wl, wt, wr, wb), (1440, 0, 3360, 990));
        }

        #[test]
        fn absurd_chrome_never_collapses_the_work_area() {
            // Whatever the window server reports, the cat needs somewhere to
            // stand: an implausible result falls back to the full display.
            let (wl, wt, wr, wb) = visible_frame(L, T, R, B, &[dock(0, 100, 1440, 900)]);
            assert_eq!((wl, wt, wr, wb), (L, T, R, B));
        }

        #[test]
        fn the_result_is_never_inverted() {
            for f in [
                dock(0, 0, 1440, 900),
                dock(480, 0, 960, 900),
                chrome(0, 0, 1, 1),
            ] {
                let (wl, wt, wr, wb) = visible_frame(L, T, R, B, &[f]);
                assert!(wr > wl && wb > wt, "work area collapsed");
            }
        }
    }

    /// Frontmost normal window covering its whole display.
    pub fn is_fullscreen_active() -> bool {
        let wins = enumerate_windows();
        // The window list is front-to-back, so the first layer-0 window is the
        // frontmost one.
        let Some(front) = wins.first() else {
            return false;
        };
        for m in get_monitors() {
            if front.left <= m.left + 2
                && front.top <= m.top + 2
                && front.right >= m.right - 2
                && front.bottom >= m.bottom - 2
            {
                return true;
            }
        }
        false
    }
}

#[tauri::command]
pub fn enumerate_windows() -> Vec<WindowRect> {
    #[cfg(windows)]
    {
        return imp::enumerate_windows();
    }
    #[cfg(target_os = "macos")]
    {
        return imp_mac::enumerate_windows();
    }
    #[allow(unreachable_code)]
    Vec::new()
}

#[tauri::command]
pub fn get_monitors() -> Vec<MonitorInfoOut> {
    #[cfg(windows)]
    {
        return imp::get_monitors();
    }
    #[cfg(target_os = "macos")]
    {
        return imp_mac::get_monitors();
    }
    #[allow(unreachable_code)]
    Vec::new()
}

/// True when the foreground window covers its whole monitor (full-screen
/// video, game, or presentation) — used for Peek Mode. Only geometry and the
/// window class (to exclude the desktop shell itself) are inspected.
#[tauri::command]
pub fn is_fullscreen_active(window: tauri::WebviewWindow) -> bool {
    #[cfg(windows)]
    crate::overlay::keep_topmost(&window);
    #[cfg(not(windows))]
    let _ = window;
    #[cfg(target_os = "macos")]
    {
        return imp_mac::is_fullscreen_active();
    }
    #[cfg(windows)]
    unsafe {
        use windows::Win32::Foundation::RECT;
        use windows::Win32::Graphics::Gdi::{
            GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
        };
        use windows::Win32::UI::WindowsAndMessaging::{
            GetClassNameW, GetForegroundWindow, GetWindowRect,
        };

        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return false;
        }
        let mut class = [0u16; 64];
        let n = GetClassNameW(hwnd, &mut class);
        let class_name = String::from_utf16_lossy(&class[..n as usize]);
        if class_name == "Progman" || class_name == "WorkerW" || class_name == "Shell_TrayWnd" {
            return false; // the desktop / taskbar themselves
        }
        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_err() {
            return false;
        }
        let hmon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut mi = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(hmon, &mut mi).as_bool() {
            return false;
        }
        let m = mi.rcMonitor;
        return rect.left <= m.left + 2
            && rect.top <= m.top + 2
            && rect.right >= m.right - 2
            && rect.bottom >= m.bottom - 2;
    }
    #[allow(unreachable_code)]
    false
}
