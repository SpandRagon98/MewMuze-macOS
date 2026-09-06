//! Event-driven, privacy-safe Windows clipboard bridge.
//!
//! The listener sleeps inside the Win32 message loop and wakes only for
//! `WM_CLIPBOARDUPDATE`; copied text is emitted to the webview and never stored
//! on disk or logged. Files, images and unsupported formats are ignored.

use serde::Serialize;
use tauri::{AppHandle, Emitter};

const NATIVE_TEXT_LIMIT: usize = 1_000_000;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClipboardTextEvent {
    text: String,
    source_app: Option<String>,
    sequence: u32,
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::{
        GlobalFree, BOOL, HANDLE, HGLOBAL, HINSTANCE, HWND, LPARAM, LRESULT, WPARAM,
    };
    use windows::Win32::System::DataExchange::{
        AddClipboardFormatListener, CloseClipboard, EmptyClipboard, GetClipboardData,
        GetClipboardSequenceNumber, IsClipboardFormatAvailable, OpenClipboard, SetClipboardData,
    };
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Memory::{
        GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE,
    };
    use windows::Win32::System::StationsAndDesktops::{
        CloseDesktop, OpenInputDesktop, DESKTOP_CONTROL_FLAGS, DESKTOP_READOBJECTS,
    };
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassW,
        TranslateMessage, HMENU, HWND_MESSAGE, MSG, SHOW_WINDOW_CMD, SW_SHOWNORMAL,
        WINDOW_EX_STYLE, WINDOW_STYLE, WM_CLIPBOARDUPDATE, WNDCLASSW,
    };

    static APP: OnceLock<AppHandle> = OnceLock::new();
    static STATE: OnceLock<Mutex<ListenerState>> = OnceLock::new();
    const CF_UNICODETEXT_ID: u32 = 13;
    const CF_HDROP_ID: u32 = 15;

    #[derive(Default)]
    struct ListenerState {
        last_sequence: u32,
        last_text: String,
        own_write: Option<(String, Instant)>,
    }

    struct ClipboardGuard;
    impl Drop for ClipboardGuard {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseClipboard();
            }
        }
    }

    struct GlobalAllocation(Option<HGLOBAL>);
    impl Drop for GlobalAllocation {
        fn drop(&mut self) {
            if let Some(handle) = self.0.take() {
                unsafe {
                    let _ = GlobalFree(handle);
                }
            }
        }
    }

    fn open_clipboard_retry() -> Result<ClipboardGuard, String> {
        for attempt in 0..5 {
            if unsafe { OpenClipboard(None) }.is_ok() {
                return Ok(ClipboardGuard);
            }
            if attempt < 4 {
                std::thread::sleep(Duration::from_millis(8));
            }
        }
        Err("The clipboard is temporarily busy. Please try again.".into())
    }

    fn read_open_clipboard() -> Result<Option<String>, String> {
        if unsafe { IsClipboardFormatAvailable(CF_HDROP_ID) }.is_ok() {
            return Ok(None);
        }
        if unsafe { IsClipboardFormatAvailable(CF_UNICODETEXT_ID) }.is_err() {
            return Ok(None);
        }
        let handle = unsafe { GetClipboardData(CF_UNICODETEXT_ID) }
            .map_err(|_| "The copied text could not be read.".to_string())?;
        let global = HGLOBAL(handle.0);
        let byte_len = unsafe { GlobalSize(global) };
        if byte_len == 0 || byte_len > (NATIVE_TEXT_LIMIT + 1) * 2 {
            return Ok(None);
        }
        let ptr = unsafe { GlobalLock(global) } as *const u16;
        if ptr.is_null() {
            return Err("The copied text could not be read.".into());
        }
        let max_units = byte_len / 2;
        let units = unsafe { std::slice::from_raw_parts(ptr, max_units) };
        let end = units
            .iter()
            .position(|unit| *unit == 0)
            .unwrap_or(max_units);
        let text = String::from_utf16_lossy(&units[..end]);
        unsafe {
            let _ = GlobalUnlock(global);
        }
        Ok((!text.is_empty()).then_some(text))
    }

    pub fn read_text() -> Result<Option<String>, String> {
        let _guard = open_clipboard_retry()?;
        read_open_clipboard()
    }

    pub fn write_text(text: String) -> Result<(), String> {
        if text.len() > NATIVE_TEXT_LIMIT {
            return Err("The text is too large for the clipboard assistant.".into());
        }
        let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
        let bytes = wide.len() * std::mem::size_of::<u16>();
        let global = unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes) }
            .map_err(|_| "Not enough memory to update the clipboard.".to_string())?;
        let mut allocation = GlobalAllocation(Some(global));
        let ptr = unsafe { GlobalLock(global) } as *mut u16;
        if ptr.is_null() {
            return Err("The clipboard memory could not be prepared.".into());
        }
        unsafe {
            std::ptr::copy_nonoverlapping(wide.as_ptr(), ptr, wide.len());
            let _ = GlobalUnlock(global);
        }

        let _guard = open_clipboard_retry()?;
        unsafe { EmptyClipboard() }
            .map_err(|_| "The clipboard could not be cleared.".to_string())?;
        if unsafe { SetClipboardData(CF_UNICODETEXT_ID, HANDLE(global.0)) }.is_err() {
            return Err("The clipboard could not be updated.".into());
        }
        // SetClipboardData owns the memory after success.
        allocation.0 = None;
        STATE
            .get_or_init(|| Mutex::new(ListenerState::default()))
            .lock()
            .map_err(|_| "Clipboard listener state is unavailable.".to_string())?
            .own_write = Some((text, Instant::now()));
        Ok(())
    }

    pub fn clear() -> Result<(), String> {
        let _guard = open_clipboard_retry()?;
        unsafe { EmptyClipboard() }.map_err(|_| "The clipboard could not be cleared.".to_string())
    }

    fn on_clipboard_update() {
        let sequence = unsafe { GetClipboardSequenceNumber() };
        {
            let state = STATE.get_or_init(|| Mutex::new(ListenerState::default()));
            if let Ok(locked) = state.lock() {
                if sequence != 0 && locked.last_sequence == sequence {
                    return;
                }
            }
        }
        let text = match read_text() {
            Ok(Some(text)) => text,
            _ => return,
        };
        let state = STATE.get_or_init(|| Mutex::new(ListenerState::default()));
        if let Ok(mut state) = state.lock() {
            state.last_sequence = sequence;
            if state.last_text == text {
                return;
            }
            if let Some((own, written_at)) = &state.own_write {
                if written_at.elapsed() < Duration::from_secs(2) && own == &text {
                    state.last_text = text;
                    state.own_write = None;
                    return;
                }
            }
            state.own_write = None;
            state.last_text = text.clone();
        } else {
            return;
        }

        if let Some(app) = APP.get() {
            let _ = app.emit(
                "clipboard-text",
                ClipboardTextEvent {
                    text,
                    source_app: crate::context::get_foreground_app(),
                    sequence,
                },
            );
        }
    }

    unsafe extern "system" fn clipboard_wnd_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if message == WM_CLIPBOARDUPDATE {
            on_clipboard_update();
            return LRESULT(0);
        }
        unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
    }

    pub fn init(app: &AppHandle) -> tauri::Result<()> {
        let _ = APP.set(app.clone());
        std::thread::Builder::new()
            .name("clipboard-events".into())
            .spawn(|| unsafe {
                let module = match GetModuleHandleW(None) {
                    Ok(module) => module,
                    Err(_) => return,
                };
                let instance = HINSTANCE(module.0);
                let class = w!("MewMuzeClipboardListener");
                let window_class = WNDCLASSW {
                    lpfnWndProc: Some(clipboard_wnd_proc),
                    hInstance: instance,
                    lpszClassName: class,
                    ..Default::default()
                };
                if RegisterClassW(&window_class) == 0 {
                    return;
                }
                let window = match CreateWindowExW(
                    WINDOW_EX_STYLE(0),
                    class,
                    w!(""),
                    WINDOW_STYLE(0),
                    0,
                    0,
                    0,
                    0,
                    HWND_MESSAGE,
                    HMENU(std::ptr::null_mut()),
                    instance,
                    None,
                ) {
                    Ok(window) => window,
                    Err(_) => return,
                };
                if AddClipboardFormatListener(window).is_err() {
                    return;
                }
                let mut message = MSG::default();
                while GetMessageW(&mut message, None, 0, 0).as_bool() {
                    let _ = TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
            })
            .map_err(tauri::Error::Io)?;
        Ok(())
    }

    pub fn locked() -> bool {
        unsafe {
            match OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), BOOL(0), DESKTOP_READOBJECTS) {
                Ok(desktop) => {
                    let _ = CloseDesktop(desktop);
                    false
                }
                Err(_) => true,
            }
        }
    }

    pub fn open_link(link: &str) -> Result<(), String> {
        let lower = link.to_ascii_lowercase();
        if !(lower.starts_with("https://") || lower.starts_with("http://"))
            || link.chars().any(char::is_whitespace)
        {
            return Err("Only complete http:// or https:// links can be opened.".into());
        }
        let wide: Vec<u16> = link.encode_utf16().chain(std::iter::once(0)).collect();
        let result = unsafe {
            ShellExecuteW(
                None,
                w!("open"),
                PCWSTR(wide.as_ptr()),
                None,
                None,
                SHOW_WINDOW_CMD(SW_SHOWNORMAL.0),
            )
        };
        if result.0 as isize <= 32 {
            Err("Windows could not open this link.".into())
        } else {
            Ok(())
        }
    }
}

/// macOS clipboard bridge.
///
/// Deliberately uses `pbcopy`/`pbpaste`/`open` rather than NSPasteboard
/// bindings: they ship on every Mac, need no extra crate, no FFI and no
/// permission prompt, and they keep the same privacy shape as the Windows path
/// (text is passed straight through to the webview, never stored or logged).
#[cfg(target_os = "macos")]
mod platform_mac {
    use super::*;
    use std::io::Write;
    use std::process::{Command, Stdio};
    use std::sync::{Mutex, OnceLock};

    static APP: OnceLock<AppHandle> = OnceLock::new();
    /// Text this app itself wrote, so the poller doesn't echo it back.
    static OWN_WRITE: Mutex<Option<String>> = Mutex::new(None);

    pub fn read_text() -> Result<Option<String>, String> {
        let out = Command::new("pbpaste")
            .output()
            .map_err(|e| format!("MewMuze could not read the clipboard: {e}"))?;
        if !out.status.success() {
            return Ok(None);
        }
        let text = String::from_utf8_lossy(&out.stdout).to_string();
        if text.is_empty() || text.len() > NATIVE_TEXT_LIMIT {
            return Ok(None);
        }
        Ok(Some(text))
    }

    pub fn write_text(text: String) -> Result<(), String> {
        if let Ok(mut own) = OWN_WRITE.lock() {
            *own = Some(text.clone());
        }
        let mut child = Command::new("pbcopy")
            .stdin(Stdio::piped())
            .spawn()
            .map_err(|e| format!("MewMuze could not update the clipboard: {e}"))?;
        child
            .stdin
            .as_mut()
            .ok_or_else(|| "MewMuze could not update the clipboard.".to_string())?
            .write_all(text.as_bytes())
            .map_err(|e| format!("MewMuze could not update the clipboard: {e}"))?;
        child
            .wait()
            .map_err(|e| format!("MewMuze could not update the clipboard: {e}"))?;
        Ok(())
    }

    pub fn clear() -> Result<(), String> {
        write_text(String::new())
    }

    /// ponytail: always false. The lock state lives behind
    /// CGSessionCopyCurrentDictionary; while the screen IS locked no app can
    /// copy anything, so the poller simply re-reads unchanged text and emits
    /// nothing. Upgrade path: read kCGSSessionScreenIsLocked if a real case
    /// for it appears.
    pub fn locked() -> bool {
        false
    }

    pub fn open_link(link: &str) -> Result<(), String> {
        let ok = Command::new("open")
            .arg(link)
            .status()
            .map_err(|e| format!("macOS could not open this link: {e}"))?;
        if ok.success() {
            Ok(())
        } else {
            Err("macOS could not open this link.".into())
        }
    }

    pub fn init(app: &AppHandle) -> tauri::Result<()> {
        let _ = APP.set(app.clone());
        // ponytail: 700 ms poll instead of the Windows path's event-driven
        // WM_CLIPBOARDUPDATE. macOS only exposes NSPasteboard.changeCount,
        // which still requires polling, so a subprocess poll costs one cheap
        // exec per interval. Upgrade path: read changeCount via objc2-app-kit
        // to skip the exec when nothing changed.
        std::thread::Builder::new()
            .name("clipboard-poll".into())
            .spawn(|| {
                let mut last = read_text().ok().flatten().unwrap_or_default();
                let mut sequence: u32 = 0;
                loop {
                    std::thread::sleep(std::time::Duration::from_millis(700));
                    let Ok(Some(text)) = read_text() else { continue };
                    if text == last || text.is_empty() {
                        continue;
                    }
                    last = text.clone();
                    // Skip the echo of our own write.
                    if let Ok(mut own) = OWN_WRITE.lock() {
                        if own.as_deref() == Some(text.as_str()) {
                            *own = None;
                            continue;
                        }
                    }
                    sequence = sequence.wrapping_add(1);
                    if let Some(app) = APP.get() {
                        let _ = app.emit(
                            "clipboard-text",
                            ClipboardTextEvent {
                                text,
                                source_app: crate::context::get_foreground_app(),
                                sequence,
                            },
                        );
                    }
                }
            })
            .ok();
        Ok(())
    }
}

pub fn init_clipboard_listener(app: &AppHandle) -> tauri::Result<()> {
    #[cfg(windows)]
    {
        return platform::init(app);
    }
    #[cfg(target_os = "macos")]
    {
        return platform_mac::init(app);
    }
    #[allow(unreachable_code)]
    Ok(())
}

#[tauri::command]
pub fn clipboard_read_text() -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        return platform::read_text();
    }
    #[cfg(target_os = "macos")]
    {
        return platform_mac::read_text();
    }
    #[allow(unreachable_code)]
    Ok(None)
}

#[tauri::command]
pub fn clipboard_write_text(text: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        return platform::write_text(text);
    }
    #[cfg(target_os = "macos")]
    {
        return platform_mac::write_text(text);
    }
    #[allow(unreachable_code)]
    Err("Clipboard Assistant is available on Windows.".into())
}

#[tauri::command]
pub fn clipboard_clear() -> Result<(), String> {
    #[cfg(windows)]
    {
        return platform::clear();
    }
    #[cfg(target_os = "macos")]
    {
        return platform_mac::clear();
    }
    #[allow(unreachable_code)]
    Err("Clipboard Assistant is available on Windows.".into())
}

#[tauri::command]
pub fn is_session_locked() -> bool {
    #[cfg(windows)]
    {
        return platform::locked();
    }
    #[cfg(target_os = "macos")]
    {
        return platform_mac::locked();
    }
    #[allow(unreachable_code)]
    false
}

#[tauri::command]
pub fn open_clipboard_link(link: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        return platform::open_link(&link);
    }
    #[cfg(target_os = "macos")]
    {
        return platform_mac::open_link(&link);
    }
    #[allow(unreachable_code)]
    Err("Clipboard Assistant is available on Windows.".into())
}
