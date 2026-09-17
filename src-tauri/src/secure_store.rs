//! Small encrypted blobs for Local Chat's memory, plus dictation's paste
//! (Paper build).
//!
//! Memory is encrypted for the current user: with Windows DPAPI, or on macOS
//! with AES-256-GCM under a random key kept in the login Keychain. Either way
//! the file on disk is unreadable to other accounts and useless if copied to
//! another computer.

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

/// Format: "MMK1" | 12-byte nonce | ciphertext + 16-byte tag.
#[cfg(target_os = "macos")]
const MAGIC: &[u8; 4] = b"MMK1";

/// The per-install key: 32 random bytes in the login Keychain, made on first use.
#[cfg(target_os = "macos")]
fn memory_key() -> Result<ring::aead::LessSafeKey, String> {
    use ring::aead::{LessSafeKey, UnboundKey, AES_256_GCM};
    use ring::rand::{SecureRandom, SystemRandom};
    let entry = keyring::Entry::new("com.spandan.pixelcat.paper", "local-memory-key")
        .map_err(|e| format!("The Keychain is unavailable: {e}"))?;
    let hex = match entry.get_password() {
        Ok(h) => h,
        Err(keyring::Error::NoEntry) => {
            let mut k = [0u8; 32];
            SystemRandom::new().fill(&mut k).map_err(|_| "No secure random source.".to_string())?;
            let h: String = k.iter().map(|b| format!("{b:02x}")).collect();
            entry.set_password(&h).map_err(|e| format!("The Keychain refused the key: {e}"))?;
            h
        }
        Err(e) => return Err(format!("The Keychain is unavailable: {e}")),
    };
    let bytes: Vec<u8> = (0..hex.len())
        .step_by(2)
        .filter_map(|i| hex.get(i..i + 2).and_then(|b| u8::from_str_radix(b, 16).ok()))
        .collect();
    let key = UnboundKey::new(&AES_256_GCM, &bytes).map_err(|_| "The stored key is damaged.".to_string())?;
    Ok(LessSafeKey::new(key))
}

#[cfg(target_os = "macos")]
fn protect(data: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
    use ring::aead::{Aad, Nonce, NONCE_LEN};
    use ring::rand::{SecureRandom, SystemRandom};
    let key = memory_key()?;
    if encrypt {
        let mut nonce = [0u8; NONCE_LEN];
        SystemRandom::new().fill(&mut nonce).map_err(|_| "No secure random source.".to_string())?;
        let mut sealed = data.to_vec();
        key.seal_in_place_append_tag(Nonce::assume_unique_for_key(nonce), Aad::empty(), &mut sealed)
            .map_err(|_| "Could not encrypt.".to_string())?;
        let mut out = Vec::with_capacity(MAGIC.len() + NONCE_LEN + sealed.len());
        out.extend_from_slice(MAGIC);
        out.extend_from_slice(&nonce);
        out.extend_from_slice(&sealed);
        Ok(out)
    } else {
        if data.len() < MAGIC.len() + NONCE_LEN || &data[..MAGIC.len()] != MAGIC {
            return Err("The stored memory is damaged.".into());
        }
        let mut nonce = [0u8; NONCE_LEN];
        nonce.copy_from_slice(&data[MAGIC.len()..MAGIC.len() + NONCE_LEN]);
        let mut body = data[MAGIC.len() + NONCE_LEN..].to_vec();
        let plain = key
            .open_in_place(Nonce::assume_unique_for_key(nonce), Aad::empty(), &mut body)
            .map_err(|_| "The stored memory is damaged or belongs to another account.".to_string())?;
        Ok(plain.to_vec())
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
fn protect(_data: &[u8], _encrypt: bool) -> Result<Vec<u8>, String> {
    Err("Encrypted storage is not available on this platform.".into())
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

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrustedWithOptions(options: core_foundation::dictionary::CFDictionaryRef) -> bool;
}

/// Paste (Cmd+V) into the focused app. macOS only delivers synthetic keys from
/// an app the user has allowed under Accessibility; without that the keys
/// would vanish silently, so ask for it (macOS shows its own prompt once) and
/// say so.
#[cfg(target_os = "macos")]
#[tauri::command]
pub fn dictation_paste() -> Result<(), String> {
    use core_foundation::base::TCFType;
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::CFString;
    use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation};
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

    let options = CFDictionary::from_CFType_pairs(&[(CFString::new("AXTrustedCheckOptionPrompt"), CFBoolean::true_value())]);
    if !unsafe { AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef()) } {
        return Err(
            "To type into other apps, allow MewMuze Paper in System Settings → Privacy & Security → Accessibility. The text is on your clipboard."
                .into(),
        );
    }
    const KEY_V: u16 = 9; // kVK_ANSI_V
    let fail = || "Could not paste; the text is on your clipboard.".to_string();
    let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState).map_err(|_| fail())?;
    for down in [true, false] {
        let event = CGEvent::new_keyboard_event(source.clone(), KEY_V, down).map_err(|_| fail())?;
        event.set_flags(CGEventFlags::CGEventFlagCommand);
        event.post(CGEventTapLocation::HID);
    }
    Ok(())
}

#[cfg(not(any(windows, target_os = "macos")))]
#[tauri::command]
pub fn dictation_paste() -> Result<(), String> {
    Err("Paste is not available on this platform.".into())
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

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn encryption_round_trips_and_the_file_is_not_plain_text() {
        let secret = "call me Sandy; reply in Hinglish";
        let enc = match protect(secret.as_bytes(), true) {
            Ok(e) => e,
            // No usable Keychain on this machine (a headless CI runner): nothing to check.
            Err(e) if cfg!(target_os = "macos") && e.contains("Keychain") => return,
            Err(e) => panic!("{e}"),
        };
        assert!(!String::from_utf8_lossy(&enc).contains("Sandy"));
        assert_eq!(protect(&enc, false).unwrap(), secret.as_bytes());
    }
}
