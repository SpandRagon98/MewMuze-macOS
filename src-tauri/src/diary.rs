//! The Diary's files (Paper build): one readable Markdown file per
//! conversation plus a small index.json, in `<app-local-data>/diary/`.
//!
//! Deliberately plain files, separate from chat memory (encrypted, under
//! `secure/`) and settings.json: the Diary is the user's own record, readable
//! with any editor, and clearing chat memory never touches it. The frontend
//! owns the format; this module only guards the names and writes atomically.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const INDEX: &str = "index.json";
const MAX_BYTES: usize = 512 * 1024;

fn dir(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("diary");
    fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

/// `index.json`, or `<letters digits _ - .>.md` - never a path.
fn name_ok(name: &str) -> bool {
    name == INDEX
        || (name.len() <= 120
            && name.ends_with(".md")
            && !name.starts_with('.')
            && !name.contains("..")
            && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.'))
}

fn checked(dir: &Path, name: &str) -> Result<PathBuf, String> {
    if name_ok(name) { Ok(dir.join(name)) } else { Err("Bad diary file name.".into()) }
}

fn write_atomic(dir: &Path, name: &str, text: &str) -> Result<(), String> {
    if text.len() > MAX_BYTES {
        return Err("Diary entry too large.".into());
    }
    let path = checked(dir, name)?;
    let temp = dir.join(format!("{name}.tmp"));
    {
        let mut f = fs::File::create(&temp).map_err(|e| e.to_string())?;
        f.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    fs::rename(&temp, &path).map_err(|e| e.to_string())
}

/// Every diary file; anything else a user dropped in the folder stays.
fn clear_in(dir: &Path) -> Result<(), String> {
    for e in fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if name_ok(&name) {
            fs::remove_file(e.path()).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn diary_dir(app: AppHandle) -> Result<String, String> {
    Ok(dir(&app)?.display().to_string())
}

#[tauri::command]
pub fn diary_read(app: AppHandle, name: String) -> Result<Option<String>, String> {
    Ok(fs::read_to_string(checked(&dir(&app)?, &name)?).ok())
}

#[tauri::command]
pub fn diary_write(app: AppHandle, name: String, text: String) -> Result<(), String> {
    write_atomic(&dir(&app)?, &name, &text)
}

#[tauri::command]
pub fn diary_delete(app: AppHandle, name: String) -> Result<(), String> {
    let path = checked(&dir(&app)?, &name)?;
    match fs::remove_file(path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

#[tauri::command]
pub fn diary_clear(app: AppHandle) -> Result<(), String> {
    clear_in(&dir(&app)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_plain_files_in_the_diary() {
        assert!(name_ok("index.json"));
        assert!(name_ok("2026-09-14_21-35_conv-abc123.md"));
        for bad in ["../x.md", "a/b.md", "a\\b.md", "x.txt", ".md", "settings.json", "C:x.md", "a..b.md"] {
            assert!(!name_ok(bad), "{bad}");
        }
    }

    #[test]
    fn writes_atomically_and_clears_only_diary_files() {
        let d = std::env::temp_dir().join(format!("mewmuze-diary-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        write_atomic(&d, "2026-09-14_21-35_a.md", "# Hello").unwrap();
        write_atomic(&d, INDEX, "[]").unwrap();
        fs::write(d.join("my-notes.txt"), "mine").unwrap();
        assert_eq!(fs::read_to_string(d.join("2026-09-14_21-35_a.md")).unwrap(), "# Hello");
        assert!(!d.join("2026-09-14_21-35_a.md.tmp").exists());
        assert!(write_atomic(&d, "../escape.md", "x").is_err());
        clear_in(&d).unwrap();
        assert!(!d.join(INDEX).exists() && !d.join("2026-09-14_21-35_a.md").exists());
        assert!(d.join("my-notes.txt").exists());
        let _ = fs::remove_dir_all(&d);
    }
}
