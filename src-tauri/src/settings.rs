//! Local settings persistence to a small JSON file in the app config dir.
//!
//! The frontend owns the schema and validates on load (`sanitizeSettings`), so
//! here we simply read/write an opaque JSON value. Nothing about cursor history
//! or which applications the user opens is ever stored.

use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    let _ = fs::create_dir_all(&dir);
    Some(dir.join("settings.json"))
}

#[tauri::command]
pub fn load_settings(app: AppHandle) -> Option<serde_json::Value> {
    let path = settings_path(&app)?;
    let data = fs::read_to_string(path).ok()?;
    serde_json::from_str(&data).ok()
}

#[tauri::command]
pub fn save_settings(app: AppHandle, settings: serde_json::Value) -> Result<(), String> {
    let path = settings_path(&app).ok_or_else(|| "no config dir".to_string())?;
    let data = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(path, data).map_err(|e| e.to_string())
}

/// Explicit, user-confirmed complete removal. Normal uninstall/update paths do
/// not call this; it exists only for the Settings warning flow.
#[tauri::command]
pub fn clear_mewmuze_local_data(app: AppHandle) -> Result<bool, String> {
    crate::dodo_license::delete_saved_record()?;
    // The trial anchor goes too. It does mean this explicitly destructive flow
    // is also the one way to restart a trial from inside the app — but leaving
    // hidden state behind after the customer asked to remove everything would
    // be worse, and anyone determined enough to run "remove all local data"
    // could clear the same vault entry by hand regardless.
    crate::trial::clear_trial_anchor();
    let config = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Could not locate MewMuze settings: {e}"))?;
    let local = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Could not locate MewMuze local data: {e}"))?;

    for directory in [config, local] {
        if directory.exists() {
            fs::remove_dir_all(&directory)
                .map_err(|e| format!("Could not remove {}: {e}", directory.display()))?;
        }
    }
    app.exit(0);
    Ok(true)
}

/// Optional AI-agent integration: read a small user-configured JSON status
/// file (e.g. {"state":"thinking"}). Only runs when the user has explicitly
/// entered a path in settings; capped at 8 KB; must be a .json file. Nothing
/// else on disk is ever inspected.
#[tauri::command]
pub fn read_agent_status(path: String) -> Option<String> {
    if path.trim().is_empty() || !path.to_lowercase().ends_with(".json") {
        return None;
    }
    let meta = fs::metadata(&path).ok()?;
    if !meta.is_file() || meta.len() > 8192 {
        return None;
    }
    fs::read_to_string(&path).ok()
}
