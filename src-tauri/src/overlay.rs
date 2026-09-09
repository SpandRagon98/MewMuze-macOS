//! Transparent, always-on-top, click-through overlay control.
//!
//! Click-through uses Tauri's cross-platform `set_ignore_cursor_events`, which
//! on Windows toggles `WS_EX_TRANSPARENT`. The frontend drives it from the
//! global cursor position: interactive only while the pointer is over the cat
//! (or during a drag), fully click-through everywhere else.
//!
//! The overlay normally spans the virtual screen. On the common single-monitor
//! layout with a bottom taskbar, its actual height stops at the work-area edge
//! so Windows does not classify the transparent overlay as a fullscreen app.

use std::sync::Mutex;
use tauri::{PhysicalPosition, PhysicalSize, State, WebviewWindow};

#[derive(Default)]
struct WindowModes {
    activation: bool,
    settings: bool,
}

#[derive(Default)]
pub struct WindowModeState(Mutex<WindowModes>);

#[cfg(windows)]
struct WorkAreaRegion {
    region: windows::Win32::Graphics::Gdi::HRGN,
    virtual_left: i32,
    virtual_top: i32,
    has_area: bool,
}

#[cfg(windows)]
unsafe extern "system" fn add_monitor_work_area(
    monitor: windows::Win32::Graphics::Gdi::HMONITOR,
    _hdc: windows::Win32::Graphics::Gdi::HDC,
    _monitor_rect: *mut windows::Win32::Foundation::RECT,
    data: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::BOOL {
    use std::mem::size_of;
    use windows::Win32::Foundation::TRUE;
    use windows::Win32::Graphics::Gdi::{
        CombineRgn, CreateRectRgn, DeleteObject, GetMonitorInfoW, HGDIOBJ, MONITORINFO, RGN_OR,
    };

    let out = &mut *(data.0 as *mut WorkAreaRegion);
    let mut info: MONITORINFO = std::mem::zeroed();
    info.cbSize = size_of::<MONITORINFO>() as u32;
    if !GetMonitorInfoW(monitor, &mut info).as_bool() {
        return TRUE;
    }

    let work = info.rcWork;
    let part = CreateRectRgn(
        work.left - out.virtual_left,
        work.top - out.virtual_top,
        work.right - out.virtual_left,
        work.bottom - out.virtual_top,
    );
    if !part.0.is_null() {
        let _ = CombineRgn(out.region, out.region, part, RGN_OR);
        let _ = DeleteObject(HGDIOBJ(part.0));
        out.has_area = true;
    }
    TRUE
}

/// Restrict the full-desktop overlay to each monitor's usable work area.
///
/// The taskbar is itself a normal shell window, while this overlay is topmost.
/// Leaving transparent overlay pixels over the taskbar therefore changes the
/// taskbar's composition/z-order appearance when focus moves. A native window
/// region removes those pixels completely without changing the canvas size or
/// any cat coordinates, including on multi-monitor desktops.
#[cfg(windows)]
unsafe fn exclude_taskbar_areas(win: &WebviewWindow, virtual_left: i32, virtual_top: i32) {
    use windows::Win32::Foundation::{HWND, LPARAM, TRUE};
    use windows::Win32::Graphics::Gdi::{
        CreateRectRgn, DeleteObject, EnumDisplayMonitors, SetWindowRgn, HDC, HGDIOBJ,
    };

    let Ok(raw_hwnd) = win.hwnd() else {
        return;
    };
    let hwnd = HWND(raw_hwnd.0);
    let region = CreateRectRgn(0, 0, 0, 0);
    if region.0.is_null() {
        return;
    }

    let mut work_areas = WorkAreaRegion {
        region,
        virtual_left,
        virtual_top,
        has_area: false,
    };
    let _ = EnumDisplayMonitors(
        HDC::default(),
        None,
        Some(add_monitor_work_area),
        LPARAM(&mut work_areas as *mut WorkAreaRegion as isize),
    );

    if !work_areas.has_area || SetWindowRgn(hwnd, work_areas.region, TRUE) == 0 {
        // On success SetWindowRgn owns the region. Otherwise we still do.
        let _ = DeleteObject(HGDIOBJ(work_areas.region.0));
    }
}

/// Remove every native non-client frame flag from the transparent overlay.
///
/// Tauri's `decorations: false` normally suppresses the frame, but the HWND can
/// retain caption/system-button style bits after a native resize. Windows then
/// paints a classic title bar the next time the click-through window activates.
/// Clearing the bits on the HWND itself makes the borderless state definitive.
#[cfg(windows)]
unsafe fn strip_native_frame(win: &WebviewWindow) {
    use std::mem::size_of;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMNCRENDERINGPOLICY, DWMNCRP_DISABLED, DWMWA_NCRENDERING_POLICY,
    };
    use windows::Win32::Graphics::Gdi::{
        RedrawWindow, HRGN, RDW_ALLCHILDREN, RDW_ERASE, RDW_FRAME, RDW_INVALIDATE, RDW_UPDATENOW,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongW, SetWindowLongW, SetWindowPos, GWL_STYLE, SWP_FRAMECHANGED, SWP_NOACTIVATE,
        SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, WS_CAPTION, WS_MAXIMIZEBOX, WS_MINIMIZEBOX,
        WS_SYSMENU, WS_THICKFRAME,
    };

    let Ok(raw_hwnd) = win.hwnd() else {
        return;
    };
    let hwnd = HWND(raw_hwnd.0);
    let style = GetWindowLongW(hwnd, GWL_STYLE);
    let frame_bits =
        WS_CAPTION.0 | WS_THICKFRAME.0 | WS_SYSMENU.0 | WS_MINIMIZEBOX.0 | WS_MAXIMIZEBOX.0;
    let borderless = (style as u32 & !frame_bits) as i32;
    if borderless != style {
        let _ = SetWindowLongW(hwnd, GWL_STYLE, borderless);
    }
    // Force Windows to recalculate the non-client area even when Tauri has
    // already restored the correct style bits. Activation can otherwise paint
    // one cached caption frame after the style itself is borderless.
    let _ = SetWindowPos(
        hwnd,
        HWND::default(),
        0,
        0,
        0,
        0,
        SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
    );

    // Suppress DWM's non-client painter too. Otherwise stale title-bar pixels
    // can remain visible even after the style bits have already been removed.
    let policy = DWMNCRP_DISABLED;
    let _ = DwmSetWindowAttribute(
        hwnd,
        DWMWA_NCRENDERING_POLICY,
        &policy as *const _ as *const core::ffi::c_void,
        size_of::<DWMNCRENDERINGPOLICY>() as u32,
    );
    let _ = RedrawWindow(
        hwnd,
        None,
        HRGN::default(),
        RDW_INVALIDATE | RDW_ERASE | RDW_FRAME | RDW_ALLCHILDREN | RDW_UPDATENOW,
    );
}

/// Permanently reject non-client caption styles and paints for the overlay.
///
/// Tauri can briefly reapply its cached window style while toggling mouse
/// passthrough. Filtering that native message is the only reliable way to stop
/// Windows from painting one activation frame before cleanup runs.
#[cfg(windows)]
unsafe extern "system" fn native_frame_guard(
    hwnd: windows::Win32::Foundation::HWND,
    message: u32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
    _subclass_id: usize,
    _reference_data: usize,
) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::Foundation::LRESULT;
    use windows::Win32::UI::Shell::DefSubclassProc;
    use windows::Win32::UI::WindowsAndMessaging::{
        GWL_STYLE, STYLESTRUCT, WM_NCACTIVATE, WM_NCPAINT, WM_STYLECHANGING, WS_CAPTION,
        WS_MAXIMIZEBOX, WS_MINIMIZEBOX, WS_SYSMENU, WS_THICKFRAME,
    };

    if message == WM_STYLECHANGING
        && wparam.0 as isize == GWL_STYLE.0 as isize
        && lparam.0 != 0
    {
        let styles = &mut *(lparam.0 as *mut STYLESTRUCT);
        let frame_bits =
            WS_CAPTION.0 | WS_THICKFRAME.0 | WS_SYSMENU.0 | WS_MINIMIZEBOX.0 | WS_MAXIMIZEBOX.0;
        styles.styleNew &= !frame_bits;
    }

    if message == WM_NCPAINT {
        return LRESULT(0);
    }
    if message == WM_NCACTIVATE {
        return LRESULT(1);
    }

    DefSubclassProc(hwnd, message, wparam, lparam)
}

#[cfg(windows)]
unsafe fn install_native_frame_guard(win: &WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Shell::SetWindowSubclass;

    let Ok(raw_hwnd) = win.hwnd() else {
        return;
    };
    let hwnd = HWND(raw_hwnd.0);
    const FRAME_GUARD_ID: usize = 0x5043_5846;
    let _ = SetWindowSubclass(hwnd, Some(native_frame_guard), FRAME_GUARD_ID, 0);
    strip_native_frame(win);
}

/// Queue frame cleanup behind Tauri's own window messages. Operations such as
/// `set_size` and `set_ignore_cursor_events` are dispatched asynchronously; an
/// immediate style edit is otherwise overwritten when those messages arrive.
#[cfg(windows)]
fn schedule_frame_cleanup(win: &WebviewWindow) {
    let target = win.clone();
    let _ = win.run_on_main_thread(move || unsafe {
        strip_native_frame(&target);
    });
}

/// Return a shorter outer-window height for a single monitor whose only
/// reserved work-area strip is a bottom taskbar.
///
/// A window region is not enough here: the Windows shell still sees the outer
/// 1920x1080 rectangle and changes the taskbar's inactive composition. Making
/// the HWND itself 1920x1032 prevents that fullscreen classification. More
/// complex multi-monitor/taskbar layouts keep the virtual-screen rectangle and
/// are clipped by `exclude_taskbar_areas` instead.
#[cfg(windows)]
fn single_monitor_work_height(
    virtual_left: i32,
    virtual_top: i32,
    virtual_width: i32,
    virtual_height: i32,
) -> Option<i32> {
    let monitors = crate::window_detection::get_monitors();
    let monitor = monitors.first()?;
    if monitors.len() != 1
        || monitor.left != virtual_left
        || monitor.top != virtual_top
        || monitor.right != virtual_left + virtual_width
        || monitor.bottom != virtual_top + virtual_height
        || monitor.work_left != monitor.left
        || monitor.work_top != monitor.top
        || monitor.work_right != monitor.right
        || monitor.work_bottom <= monitor.top
        || monitor.work_bottom >= monitor.bottom
    {
        return None;
    }
    Some(monitor.work_bottom - virtual_top)
}

pub fn init_overlay(win: &WebviewWindow) -> tauri::Result<()> {
    #[cfg(windows)]
    unsafe {
        install_native_frame_guard(win);
    }
    // Start fully click-through; the frontend enables interaction over the cat.
    let _ = win.set_ignore_cursor_events(true);
    position_window(win);
    #[cfg(target_os = "macos")]
    {
        // AppKit resets a window's level whenever it re-orders the window -
        // hiding and showing the app, changing Space, plugging in a display,
        // waking from sleep. Setting it once at startup is not enough: the
        // level quietly falls back to Tauri's floating 3, which is below the
        // Dock, and the cat sinks behind it. Re-asserting is a no-op when the
        // level is already right, so it can safely ride every window event.
        let target = win.clone();
        win.on_window_event(move |event| {
            if matches!(
                event,
                tauri::WindowEvent::Focused(_)
                    | tauri::WindowEvent::Moved(_)
                    | tauri::WindowEvent::Resized(_)
            ) {
                raise_above_dock(&target);
            }
        });
    }
    #[cfg(windows)]
    {
        // Mouse activation happens after click-through is disabled. Repaint the
        // frame on the resulting focus event so Windows cannot leave a stale
        // caption strip visible after the actual click.
        let target = win.clone();
        win.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Focused(true)) {
                // Queue this behind WM_ACTIVATE. Cleaning the frame directly
                // inside the focus callback runs before Windows performs its
                // final activation repaint and leaves a stale caption strip.
                schedule_frame_cleanup(&target);
            }
        });
    }
    Ok(())
}

fn position_window(win: &WebviewWindow) {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::UI::WindowsAndMessaging::{
            GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
            SM_YVIRTUALSCREEN,
        };
        let x = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let y = GetSystemMetrics(SM_YVIRTUALSCREEN);
        let w = GetSystemMetrics(SM_CXVIRTUALSCREEN).max(1);
        let h = GetSystemMetrics(SM_CYVIRTUALSCREEN).max(1);
        let outer_h = single_monitor_work_height(x, y, w, h).unwrap_or(h);
        let _ = win.set_position(PhysicalPosition::new(x, y));
        let _ = win.set_size(PhysicalSize::new(w as u32, outer_h as u32));
        // These must run after the queued Tauri position/size messages.
        let target = win.clone();
        let _ = win.run_on_main_thread(move || {
            strip_native_frame(&target);
            exclude_taskbar_areas(&target, x, y);
        });
    }
    #[cfg(target_os = "macos")]
    {
        // Span every display. Tauri's monitor list is already cross-platform
        // and Retina-aware, so no AppKit call is needed for the geometry: the
        // union of all monitor rects in PHYSICAL pixels is exactly what the
        // Windows virtual-screen metrics produce.
        let monitors = win.available_monitors().unwrap_or_default();
        if !monitors.is_empty() {
            let (mut l, mut t, mut r, mut b) = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
            for m in &monitors {
                let p = m.position();
                let s = m.size();
                l = l.min(p.x);
                t = t.min(p.y);
                r = r.max(p.x + s.width as i32);
                b = b.max(p.y + s.height as i32);
            }
            let _ = win.set_position(PhysicalPosition::new(l, t));
            let _ = win.set_size(PhysicalSize::new(
                (r - l).max(1) as u32,
                (b - t).max(1) as u32,
            ));
        }
        // Follow the user across Spaces and sit above full-screen apps. Both
        // are first-class Tauri APIs on macOS, so this needs no objc.
        let _ = win.set_visible_on_all_workspaces(true);
        let _ = win.set_always_on_top(true);
        // MUST come after set_always_on_top, which sets the level itself.
        raise_above_dock(win);
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = win;
    }
}

/// Put the overlay one level above the Dock.
///
/// Tauri's `set_always_on_top` maps to `NSFloatingWindowLevel` (3), which is
/// BELOW the Dock at level 20 — so the cat was drawn behind the Dock however
/// correct its position was. One level above the Dock puts it in front, and
/// still below the menu bar at 24, which a desktop pet must never cover.
///
/// This is the one Objective-C message in the port. `NSScreen.visibleFrame` is
/// still avoided (see window_detection.rs) because it returns an NSRect, and a
/// struct return goes through `objc_msgSend_stret` on x86_64 but registers on
/// arm64. `setLevel:` takes an integer and returns nothing, so it has none of
/// that risk and behaves identically on both architectures.
#[cfg(target_os = "macos")]
fn raise_above_dock(win: &WebviewWindow) {
    /// kCGDockWindowLevel. The menu bar is 24 and the status level 25; sitting
    /// one above the Dock clears it and every desktop widget while leaving the
    /// menu bar - which a desktop pet must never cover - alone.
    const DOCK_LEVEL: isize = 20;
    let Ok(ns_window) = win.ns_window() else {
        return;
    };
    let window = ns_window as *mut objc2::runtime::AnyObject;
    if window.is_null() {
        return;
    }
    unsafe {
        let _: () = objc2::msg_send![window, setLevel: DOCK_LEVEL + 1];
    }
}

#[tauri::command]
pub fn set_click_through(window: WebviewWindow, through: bool) -> tauri::Result<()> {
    let result = window.set_ignore_cursor_events(through);
    #[cfg(windows)]
    {
        // Reassert after Tauri applies its queued style update.
        schedule_frame_cleanup(&window);
    }
    result
}

#[tauri::command]
pub fn position_overlay(window: WebviewWindow) -> tauri::Result<()> {
    position_window(&window);
    Ok(())
}

/// Cat On/Off: hide the overlay entirely (background stays in the tray) or
/// show it again, repositioned across the virtual screen.
#[tauri::command]
pub fn set_cat_visible(window: WebviewWindow, visible: bool) -> tauri::Result<()> {
    if visible {
        window.show()?;
        let _ = window.set_ignore_cursor_events(true);
        position_window(&window);
        // show() re-orders the window, which is exactly when macOS drops the
        // level back below the Dock.
        #[cfg(target_os = "macos")]
        raise_above_dock(&window);
    } else {
        window.hide()?;
    }
    Ok(())
}

/// Activation is the one time MewMuze behaves like a conventional app window:
/// it needs a taskbar entry so the customer can minimise it while retrieving
/// the licence email. Leaving activation restores the normal companion mode.
fn set_window_mode(
    window: &WebviewWindow,
    modes: &State<'_, WindowModeState>,
    activation: Option<bool>,
    settings: Option<bool>,
) -> tauri::Result<()> {
    let visible = {
        let mut current = modes
            .0
            .lock()
            .map_err(|_| std::io::Error::other("window mode state is unavailable"))?;
        if let Some(active) = activation {
            current.activation = active;
        }
        if let Some(active) = settings {
            current.settings = active;
        }
        current.activation || current.settings
    };
    window.set_skip_taskbar(!visible)?;
    if visible {
        window.show()?;
    }
    Ok(())
}

#[tauri::command]
pub fn set_activation_window_mode(
    window: WebviewWindow,
    modes: State<'_, WindowModeState>,
    active: bool,
) -> tauri::Result<()> {
    set_window_mode(&window, &modes, Some(active), None)
}

/// Minimise without exiting or discarding the activation form.
#[tauri::command]
pub fn minimize_activation_window(window: WebviewWindow) -> tauri::Result<()> {
    window.minimize()
}

/// Settings remains reachable from the taskbar while open, even after focus
/// moves to the browser or another app. The panel itself hides on that focus
/// change in React; the cat overlay keeps running independently.
#[tauri::command]
pub fn set_settings_window_mode(
    window: WebviewWindow,
    modes: State<'_, WindowModeState>,
    active: bool,
) -> tauri::Result<()> {
    set_window_mode(&window, &modes, None, Some(active))
}

#[tauri::command]
pub fn minimize_settings_window(window: WebviewWindow) -> tauri::Result<()> {
    window.minimize()
}
