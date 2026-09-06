//! Global cursor position via Win32 `GetCursorPos`.
//!
//! Returns only the current physical-pixel position. No history, no logging,
//! nothing persisted — the frontend derives speed from consecutive samples and
//! keeps none of it.

use serde::Serialize;

#[derive(Serialize)]
pub struct CursorPos {
    pub x: i32,
    pub y: i32,
}

#[tauri::command]
pub fn get_cursor_position() -> CursorPos {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::POINT;
        use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
        let mut p = POINT::default();
        unsafe {
            let _ = GetCursorPos(&mut p);
        }
        return CursorPos { x: p.x, y: p.y };
    }
    #[cfg(target_os = "macos")]
    {
        use core_graphics::event::CGEvent;
        use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

        // CGEvent's location is already in the top-left-origin global space that
        // the rest of the app assumes, unlike NSEvent::mouseLocation which is
        // bottom-left. No flip needed, and no Accessibility permission either.
        if let Ok(src) = CGEventSource::new(CGEventSourceStateID::HIDSystemState) {
            if let Ok(ev) = CGEvent::new(src) {
                let p = ev.location();
                return CursorPos {
                    x: p.x as i32,
                    y: p.y as i32,
                };
            }
        }
        return CursorPos { x: 0, y: 0 };
    }
    #[allow(unreachable_code)]
    CursorPos { x: 0, y: 0 }
}
