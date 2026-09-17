//! Tasks storage: one small JSON file in the app's local data directory,
//! separate from settings. The frontend owns the schema (src/tasks/taskModel.ts,
//! versioned) and repairs what it reads; this side only keeps the file safe:
//!
//! * saves are atomic: write a temp file, flush it to disk, keep the previous
//!   good file as `tasks.bak.json`, then rename the new one into place - a
//!   crash mid-save leaves either the old file or the new one, never half;
//! * a file the frontend could not read is copied aside (`tasks.corrupt-*.json`)
//!   before anything is written over it, so nothing is ever silently lost;
//! * nothing leaves the machine.

use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const MAIN: &str = "tasks.json";
const BACKUP: &str = "tasks.bak.json";
const TEMP: &str = "tasks.json.tmp";
/// Far beyond any real task list; refuses a runaway write.
const MAX_BYTES: usize = 8 * 1024 * 1024;

#[derive(Serialize, Debug, PartialEq)]
pub struct TaskFiles {
    pub main: Option<String>,
    pub backup: Option<String>,
}

fn dir(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

fn read_opt(p: &Path) -> Option<String> {
    fs::read_to_string(p).ok()
}

pub fn read_files(dir: &Path) -> TaskFiles {
    TaskFiles { main: read_opt(&dir.join(MAIN)), backup: read_opt(&dir.join(BACKUP)) }
}

pub fn write_atomic(dir: &Path, json: &str) -> Result<(), String> {
    if json.len() > MAX_BYTES {
        return Err("task list too large".into());
    }
    let temp = dir.join(TEMP);
    {
        let mut f = fs::File::create(&temp).map_err(|e| e.to_string())?;
        f.write_all(json.as_bytes()).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    let main = dir.join(MAIN);
    // Copy, not rename: there is never a moment without a tasks.json. Only a
    // file that still parses becomes the backup, so a damaged one can never
    // replace the last good copy.
    let parses = read_opt(&main).is_some_and(|s| serde_json::from_str::<serde_json::Value>(&s).is_ok());
    if parses {
        fs::copy(&main, dir.join(BACKUP)).map_err(|e| e.to_string())?;
    }
    fs::rename(&temp, &main).map_err(|e| e.to_string())
}

/// Keep an unreadable tasks.json aside under a new name. Returns that name.
pub fn quarantine(dir: &Path, stamp: u64) -> Result<Option<String>, String> {
    let main = dir.join(MAIN);
    if !main.exists() {
        return Ok(None);
    }
    let name = format!("tasks.corrupt-{stamp}.json");
    fs::copy(&main, dir.join(&name)).map_err(|e| e.to_string())?;
    Ok(Some(name))
}

#[tauri::command]
pub fn tasks_load(app: AppHandle) -> Result<TaskFiles, String> {
    Ok(read_files(&dir(&app)?))
}

#[tauri::command]
pub fn tasks_save(app: AppHandle, json: String) -> Result<(), String> {
    write_atomic(&dir(&app)?, &json)
}

#[tauri::command]
pub fn tasks_quarantine(app: AppHandle) -> Result<Option<String>, String> {
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    quarantine(&dir(&app)?, stamp)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("mewmuze-tasks-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn first_save_then_load() {
        let d = temp_dir("first");
        assert_eq!(read_files(&d), TaskFiles { main: None, backup: None });
        write_atomic(&d, r#"{"version":1,"tasks":[]}"#).unwrap();
        let f = read_files(&d);
        assert_eq!(f.main.as_deref(), Some(r#"{"version":1,"tasks":[]}"#));
        assert_eq!(f.backup, None);
        assert!(!d.join(TEMP).exists());
    }

    #[test]
    fn each_save_keeps_the_previous_file_as_backup() {
        let d = temp_dir("backup");
        write_atomic(&d, r#"{"n":1}"#).unwrap();
        write_atomic(&d, r#"{"n":2}"#).unwrap();
        let f = read_files(&d);
        assert_eq!(f.main.as_deref(), Some(r#"{"n":2}"#));
        assert_eq!(f.backup.as_deref(), Some(r#"{"n":1}"#));
    }

    #[test]
    fn a_damaged_file_never_replaces_the_good_backup() {
        let d = temp_dir("keepbak");
        fs::write(d.join(BACKUP), r#"{"good":true}"#).unwrap();
        fs::write(d.join(MAIN), "{ half writ").unwrap();
        write_atomic(&d, r#"{"fresh":true}"#).unwrap();
        let f = read_files(&d);
        assert_eq!(f.main.as_deref(), Some(r#"{"fresh":true}"#));
        assert_eq!(f.backup.as_deref(), Some(r#"{"good":true}"#));
    }

    #[test]
    fn a_damaged_file_is_copied_aside_not_lost() {
        let d = temp_dir("corrupt");
        fs::write(d.join(MAIN), "{ not json").unwrap();
        let name = quarantine(&d, 42).unwrap().unwrap();
        assert_eq!(fs::read_to_string(d.join(&name)).unwrap(), "{ not json");
        write_atomic(&d, "fresh").unwrap();
        assert_eq!(fs::read_to_string(d.join(&name)).unwrap(), "{ not json");
        assert_eq!(quarantine(&temp_dir("none"), 1).unwrap(), None);
    }

    #[test]
    fn refuses_a_runaway_write() {
        let d = temp_dir("big");
        assert!(write_atomic(&d, &"x".repeat(MAX_BYTES + 1)).is_err());
        assert_eq!(read_files(&d).main, None);
    }
}
