//! Privacy-safe context signals for companion reactions.
//!
//! `get_foreground_app` returns ONLY the lowercase executable basename of the
//! foreground window's process (e.g. "winword.exe"). No window titles, no
//! document names, no command lines — just enough to pick an animation theme
//! (writing / coding / music / other). Nothing is stored or transmitted.
//!
//! `get_media_playing` asks the Windows media-session API (the same source as
//! the system volume flyout) whether any session is currently playing. Only
//! the boolean playback state is read — never track names, artists, or audio.

#[tauri::command]
pub fn get_foreground_app() -> Option<String> {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{
            OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
            PROCESS_QUERY_LIMITED_INFORMATION,
        };
        use windows::Win32::UI::WindowsAndMessaging::{
            GetForegroundWindow, GetWindowThreadProcessId,
        };

        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return None;
        }
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return None;
        }
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 512];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(buf.as_mut_ptr()),
            &mut len,
        );
        let _ = CloseHandle(handle);
        ok.ok()?;
        let full = String::from_utf16_lossy(&buf[..len as usize]);
        // Basename only, lowercased; the path itself is discarded immediately.
        let name = full.rsplit(['\\', '/']).next().unwrap_or("").to_lowercase();
        if name.is_empty() {
            return None;
        }
        return Some(name);
    }
    #[cfg(target_os = "macos")]
    {
        // Owner NAME of the frontmost normal window. This is the application
        // name (e.g. "code"), not a document or window title, matching the
        // Windows path's privacy shape: enough to pick an animation theme,
        // nothing about what the user is actually doing.
        use core_foundation::base::{CFType, TCFType};
        use core_foundation::dictionary::CFDictionary;
        use core_foundation::number::CFNumber;
        use core_foundation::string::CFString;
        use core_graphics::display::{
            kCGNullWindowID, kCGWindowListExcludeDesktopElements,
            kCGWindowListOptionOnScreenOnly, CGDisplay,
        };

        let own_pid = std::process::id() as f64;
        // core-graphics takes Option<CGWindowID> for the "relative to" window.
        // kCGNullWindowID is the C API's "no reference window" sentinel.
        let list = CGDisplay::window_list_info(
            kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
            Some(kCGNullWindowID),
        )?;
        for item in list.iter() {
            let dict: CFDictionary<CFString, CFType> =
                unsafe { CFDictionary::wrap_under_get_rule(*item as _) };
            let num = |k: &str| {
                dict.find(&CFString::new(k))
                    .and_then(|v| v.downcast::<CFNumber>())
                    .and_then(|n| n.to_f64())
            };
            if num("kCGWindowOwnerPID") == Some(own_pid) {
                continue;
            }
            if num("kCGWindowLayer").unwrap_or(1.0) != 0.0 {
                continue;
            }
            let name = dict
                .find(&CFString::new("kCGWindowOwnerName"))
                .and_then(|v| v.downcast::<CFString>())
                .map(|s| s.to_string().to_lowercase());
            return name.filter(|n| !n.is_empty());
        }
        return None;
    }
    #[allow(unreachable_code)]
    None
}

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

/// Latest known playback state, refreshed by a background thread.
static MEDIA_PLAYING: AtomicBool = AtomicBool::new(false);
/// Ensures the refresher thread is started exactly once.
static MEDIA_WATCHER: OnceLock<()> = OnceLock::new();

/// The actual media-session query. BLOCKS: `RequestAsync().get()` waits for a
/// WinRT async operation to complete, so this must never run on the UI thread.
#[cfg(windows)]
fn media_playing_blocking() -> bool {
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSessionManager as Manager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
    };
    let playing = (|| -> windows::core::Result<bool> {
        let manager = Manager::RequestAsync()?.get()?;
        let sessions = manager.GetSessions()?;
        for i in 0..sessions.Size()? {
            let session = sessions.GetAt(i)?;
            if let Ok(info) = session.GetPlaybackInfo() {
                if info.PlaybackStatus()? == Status::Playing {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    })();
    playing.unwrap_or(false)
}

/// Whether any system media session is playing.
///
/// This used to call the media-session API directly. Because Tauri runs a
/// synchronous command on the **main UI thread** — which is an STA — and
/// `RequestAsync().get()` blocks waiting for a completion that must be
/// delivered to that same thread, it could deadlock the entire app a couple of
/// seconds after launch: the window stopped responding, the cat froze, tray
/// menu clicks did nothing, and settings never got persisted.
///
/// Now the blocking work lives on a dedicated background thread (MTA, so the
/// wait is safe) and the command is a non-blocking read of the cached value.
/// A wedged media session can no longer take the app down with it.
#[tauri::command]
pub fn get_media_playing() -> bool {
    #[cfg(target_os = "macos")]
    {
        // macOS has no public per-session playback API (MediaRemote is
        // private and would fail review/notarisation). Closest safe native
        // equivalent: the default OUTPUT device is actively running, i.e.
        // something is playing. Cheap and non-blocking, so no watcher thread.
        // ponytail: true for any audio, not just music — a video call or a
        // notification chime also counts. Narrowing needs private API.
        return crate::mic::coreaudio::output_running();
    }
    #[cfg(windows)]
    #[allow(unreachable_code)]
    MEDIA_WATCHER.get_or_init(|| {
        std::thread::Builder::new()
            .name("media-session-poll".into())
            .spawn(|| {
                unsafe {
                    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
                    // Multi-threaded apartment: blocking waits here are safe.
                    let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
                }
                loop {
                    MEDIA_PLAYING.store(media_playing_blocking(), Ordering::Relaxed);
                    std::thread::sleep(std::time::Duration::from_millis(2000));
                }
            })
            .ok();
    });
    MEDIA_PLAYING.load(Ordering::Relaxed)
}
