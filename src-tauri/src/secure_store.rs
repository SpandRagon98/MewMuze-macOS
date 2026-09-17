//! Small encrypted blobs for Local Chat's memory, plus dictation's paste
//! (Paper build).
//!
//! Memory is encrypted with Windows DPAPI for the current user: the file on
//! disk is unreadable to other accounts and useless if copied to another PC.

use std::path::PathBuf;

fn store_dir() -> PathBuf {
    crate::modules::models_root().parent().map(|p| p.join("secure")).unwrap_or_else(std::env::temp_dir)
}

fn path_for(name: &str) -> Result<PathBuf, String> {
    if name.is_empty() || name.len() > 40 || !name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
        return Err("Bad store name.".into());
    }
    Ok(store_dir().join(format!("{name}.bin")))
}

#[cfg(windows)]
fn protect(data: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN};
    let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
    let mut out = CRYPT_INTEGER_BLOB::default();
    unsafe {
        if encrypt {
            CryptProtectData(&input, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out)
        } else {
            CryptUnprotectData(&input, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out)
        }
        .map_err(|e| e.to_string())?;
        let bytes = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        let _ = LocalFree(HLOCAL(out.pbData as *mut core::ffi::c_void));
        Ok(bytes)
    }
}

#[cfg(not(windows))]
fn protect(_data: &[u8], _encrypt: bool) -> Result<Vec<u8>, String> {
    Err("Encrypted storage is only available on Windows in this build.".into())
}

#[tauri::command]
pub fn secure_write(name: String, text: String) -> Result<(), String> {
    let path = path_for(&name)?;
    std::fs::create_dir_all(store_dir()).map_err(|e| e.to_string())?;
    std::fs::write(path, protect(text.as_bytes(), true)?).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn secure_read(name: String) -> Result<Option<String>, String> {
    let path = path_for(&name)?;
    let Ok(raw) = std::fs::read(&path) else { return Ok(None) };
    let plain = protect(&raw, false)?;
    Ok(Some(String::from_utf8_lossy(&plain).into_owned()))
}

#[tauri::command]
pub fn secure_delete(name: String) -> Result<(), String> {
    let path = path_for(&name)?;
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Paste into whatever app has the focus (Ctrl+V), after the text was put on
/// the clipboard. Used by dictation's "insert" mode.
#[cfg(windows)]
#[tauri::command]
pub fn dictation_paste() -> Result<(), String> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, VIRTUAL_KEY, VK_CONTROL,
    };
    let key = |vk: VIRTUAL_KEY, up: bool| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT { wVk: vk, wScan: 0, dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) }, time: 0, dwExtraInfo: 0 },
        },
    };
    let v = VIRTUAL_KEY(0x56);
    let inputs = [key(VK_CONTROL, false), key(v, false), key(v, true), key(VK_CONTROL, true)];
    let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent as usize == inputs.len() {
        Ok(())
    } else {
        Err("Could not paste; the text is on your clipboard.".into())
    }
}

#[cfg(not(windows))]
#[tauri::command]
pub fn dictation_paste() -> Result<(), String> {
    Err("Paste is only available on Windows in this build.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn store_names_are_strict() {
        assert!(path_for("chat-memory").is_ok());
        assert!(path_for("../x").is_err());
        assert!(path_for("A").is_err());
        assert!(path_for("").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn dpapi_round_trips_and_the_file_is_not_plain_text() {
        let secret = "call me Sandy; reply in Hinglish";
        let enc = protect(secret.as_bytes(), true).unwrap();
        assert!(!String::from_utf8_lossy(&enc).contains("Sandy"));
        assert_eq!(protect(&enc, false).unwrap(), secret.as_bytes());
    }
}
