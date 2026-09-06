//! Privacy-safe aggregate input activity.
//!
//! Keyboard: `get_keyboard_activity` returns ONLY the number of keys currently
//! held down (via `GetAsyncKeyState` high bits). Key identities never leave
//! this function — no values are stored, logged, or returned. The frontend
//! derives a typing *rate* from consecutive counts to animate paw-kneading.
//!
//! Scroll: a low-level mouse hook (`WH_MOUSE_LL`) accumulates ONLY the signed
//! wheel delta into an atomic counter; `get_scroll_delta` swaps it out. No
//! cursor path, window, or content information is touched.

use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::Once;

static SCROLL_ACCUM: AtomicI32 = AtomicI32::new(0);
static HOOK_INIT: Once = Once::new();

#[tauri::command]
pub fn get_keyboard_activity() -> u32 {
    #[cfg(windows)]
    {
        use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
        let mut down: u32 = 0;
        // Skip mouse buttons (0x01-0x06); count everything else pressed.
        for vk in 0x08..=0xFE_i32 {
            let state = unsafe { GetAsyncKeyState(vk) } as u16;
            if state & 0x8000 != 0 {
                down += 1;
            }
        }
        return down;
    }
    #[cfg(target_os = "macos")]
    {
        // macOS has no permission-free way to read which keys are held down
        // (that needs an Accessibility event tap). The system-wide keydown
        // COUNTER is permission-free and, since the frontend only ever derives
        // a typing *rate* from consecutive samples, a monotonic count feeds
        // TypingDetector exactly as well as a held-key count does.
        return mac_event_count(core_graphics::event::CGEventType::KeyDown);
    }
    #[allow(unreachable_code)]
    0
}

/// The two Quartz event-source queries this file needs.
///
/// The `core-graphics` crate wraps `CGEventSource` for *creating* sources but
/// binds neither counter query, so they are declared against the framework
/// directly — the same approach `mic.rs` already takes for CoreAudio. Both are
/// plain C functions taking and returning scalars, so unlike an ObjC
/// `objc_msgSend` bridge there is no struct-return ABI difference between
/// arm64 and x86_64 to get wrong.
#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    /// Number of events of one type since login. A count, never contents.
    fn CGEventSourceCounterForEventType(state: i32, event_type: u32) -> u32;
    /// Seconds since the last event of one type. A timestamp, never contents.
    fn CGEventSourceSecondsSinceLastEventType(state: i32, event_type: u32) -> f64;
}

/// kCGEventSourceStateHIDSystemState — the whole machine, all sessions.
#[cfg(target_os = "macos")]
const HID_SYSTEM_STATE: i32 = 1;

/// kCGAnyInputEventType — every input event, whatever the kind.
#[cfg(target_os = "macos")]
const ANY_INPUT_EVENT: u32 = u32::MAX;

/// System-wide count of one event type since login. Permission-free: it reads
/// aggregate counters only, never event contents. Returns 0 if unavailable.
#[cfg(target_os = "macos")]
fn mac_event_count(kind: core_graphics::event::CGEventType) -> u32 {
    unsafe { CGEventSourceCounterForEventType(HID_SYSTEM_STATE, kind as u32) }
}

/// Milliseconds since Windows last received mouse or keyboard input.
///
/// This is a privacy-safe aggregate timestamp: it contains no key identities,
/// typed text, cursor positions, focused windows, or input history.
#[tauri::command]
pub fn get_user_idle_ms() -> u64 {
    #[cfg(windows)]
    {
        use std::mem::size_of;
        use windows::Win32::System::SystemInformation::GetTickCount;
        use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

        let mut info = LASTINPUTINFO {
            cbSize: size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        if unsafe { GetLastInputInfo(&mut info) }.as_bool() {
            // Both values are wrapping 32-bit tick counts. wrapping_sub remains
            // correct when uptime crosses the approximately 49.7-day boundary.
            return unsafe { GetTickCount() }.wrapping_sub(info.dwTime) as u64;
        }
    }
    #[cfg(target_os = "macos")]
    {
        // kCGAnyInputEventType is Quartz's own "any input" bucket, so this is a
        // single query rather than a minimum over a hand-picked list of event
        // kinds — and it also covers the ones such a list forgets (drags,
        // modifier changes, tablet and trackpad gestures).
        //
        // Same privacy shape as GetLastInputInfo: a timestamp only, never what
        // was typed or where the pointer went.
        let idle = unsafe {
            CGEventSourceSecondsSinceLastEventType(HID_SYSTEM_STATE, ANY_INPUT_EVENT)
        };
        if idle.is_finite() && idle >= 0.0 {
            return (idle * 1000.0) as u64;
        }
    }
    0
}

#[cfg(windows)]
mod hook {
    use super::SCROLL_ACCUM;
    use std::sync::atomic::Ordering;
    use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetMessageW, SetWindowsHookExW, TranslateMessage, HHOOK,
        MSG, MSLLHOOKSTRUCT, WH_MOUSE_LL, WM_MOUSEWHEEL,
    };

    unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 && wparam.0 as u32 == WM_MOUSEWHEEL {
            let info = &*(lparam.0 as *const MSLLHOOKSTRUCT);
            // High word of mouseData = signed wheel delta (multiples of 120).
            let delta = ((info.mouseData >> 16) & 0xFFFF) as u16 as i16;
            SCROLL_ACCUM.fetch_add(delta as i32, Ordering::Relaxed);
        }
        CallNextHookEx(HHOOK::default(), code, wparam, lparam)
    }

    pub fn install() {
        std::thread::spawn(|| unsafe {
            if SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), None, 0).is_err() {
                return; // hook unavailable: scroll reactions simply stay off
            }
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        });
    }
}

/// Install the scroll hook once (called from setup).
pub fn init_scroll_hook() {
    HOOK_INIT.call_once(|| {
        #[cfg(windows)]
        hook::install();
    });
}

/// Returns and resets the accumulated signed wheel delta since the last call.
#[tauri::command]
pub fn get_scroll_delta() -> i32 {
    #[cfg(target_os = "macos")]
    {
        // ponytail: magnitude only, no direction. Quartz exposes a permission-
        // free scroll COUNTER but not the sign; reading the signed delta needs
        // an Accessibility-approved event tap. The cat still reacts to
        // scrolling (paper unrolls, it glances at the page) but always reads as
        // one direction. Upgrade path: add a CGEventTap once the app already
        // asks for Accessibility for some other feature.
        use std::sync::atomic::AtomicU32;
        static LAST: AtomicU32 = AtomicU32::new(0);
        let now = mac_event_count(core_graphics::event::CGEventType::ScrollWheel);
        let prev = LAST.swap(now, Ordering::Relaxed);
        // First call establishes the baseline instead of reporting a huge jump.
        if prev == 0 || now < prev {
            return 0;
        }
        // Match the Windows convention of ~120 units per wheel notch.
        return now.saturating_sub(prev).saturating_mul(120).min(i32::MAX as u32) as i32;
    }
    #[allow(unreachable_code)]
    SCROLL_ACCUM.swap(0, Ordering::Relaxed)
}
