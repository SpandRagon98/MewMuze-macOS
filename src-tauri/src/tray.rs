//! System-tray icon + menu.
//!
//! Menu clicks are forwarded to the frontend via a `tray-command` event (except
//! Quit/About, handled here). The frontend holds the authoritative settings and
//! calls the `update_tray` command to rebuild the menu with fresh check-marks.

use serde::Deserialize;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Runtime};

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TrayState {
    pub paused: bool,
    pub cursor_chasing: bool,
    pub sound_enabled: bool,
    pub activity_level: String,
    pub cat_size: String,
    pub start_with_windows: bool,
    #[serde(default)]
    pub cat_off: bool,
    #[serde(default = "default_true")]
    pub clipboard_enabled: bool,
}

fn default_true() -> bool {
    true
}

impl Default for TrayState {
    fn default() -> Self {
        Self {
            paused: false,
            cursor_chasing: true,
            sound_enabled: false,
            activity_level: "balanced".to_string(),
            cat_size: "medium".to_string(),
            start_with_windows: false,
            cat_off: false,
            clipboard_enabled: true,
        }
    }
}

fn build_menu<R: Runtime>(app: &AppHandle<R>, s: &TrayState) -> tauri::Result<Menu<R>> {
    let none: Option<&str> = None;

    let pause = MenuItem::with_id(
        app,
        if s.paused { "resume" } else { "pause" },
        if s.paused { "Resume cat" } else { "Pause cat" },
        true,
        none,
    )?;
    let pet = MenuItem::with_id(app, "pet", "Pet cat", true, none)?;
    let call = MenuItem::with_id(app, "call", "Call cat to cursor", true, none)?;
    let sleep = MenuItem::with_id(app, "sleep", "Put cat to sleep", true, none)?;

    let chase = CheckMenuItem::with_id(app, "toggle-chase", "Chase cursor", true, s.cursor_chasing, none)?;
    let sound = CheckMenuItem::with_id(app, "toggle-sound", "Sounds", true, s.sound_enabled, none)?;

    let a_calm = CheckMenuItem::with_id(app, "activity-calm", "Calm", true, s.activity_level == "calm", none)?;
    let a_bal = CheckMenuItem::with_id(app, "activity-balanced", "Balanced", true, s.activity_level == "balanced", none)?;
    let a_play = CheckMenuItem::with_id(app, "activity-playful", "Playful", true, s.activity_level == "playful", none)?;
    let activity = Submenu::with_items(app, "Activity level", true, &[&a_calm, &a_bal, &a_play])?;

    let sz_small = CheckMenuItem::with_id(app, "size-small", "Small", true, s.cat_size == "small", none)?;
    let sz_med = CheckMenuItem::with_id(app, "size-medium", "Medium", true, s.cat_size == "medium", none)?;
    let sz_large = CheckMenuItem::with_id(app, "size-large", "Large", true, s.cat_size == "large", none)?;
    let size = Submenu::with_items(app, "Cat size", true, &[&sz_small, &sz_med, &sz_large])?;

    let quick_tools = MenuItem::with_id(app, "work-mode", "Work mode", true, none)?;
    let clipboard = MenuItem::with_id(app, "clipboard-assistant", "Clipboard Assistant", true, none)?;

    let cat_off = MenuItem::with_id(app, "cat-off", "Cat Off", true, none)?;
    let cat_on = MenuItem::with_id(app, "cat-on", "Cat On", true, none)?;
    let settings_item = MenuItem::with_id(app, "settings", "Settings…", true, none)?;
    let startup = CheckMenuItem::with_id(app, "toggle-startup", "Start with Windows", true, s.start_with_windows, none)?;
    let reset = MenuItem::with_id(app, "reset", "Reset cat position", true, none)?;
    let about = MenuItem::with_id(app, "about", "About", true, none)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, none)?;

    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let sep3 = PredefinedMenuItem::separator(app)?;

    if s.cat_off {
        // Minimal menu while the cat is off: Cat On / Settings / Quit.
        return Menu::with_items(app, &[&cat_on, &sep1, &settings_item, &sep2, &quit]);
    }
    if s.clipboard_enabled {
        Menu::with_items(
            app,
            &[
                &cat_off, &pause, &pet, &call, &sleep, &sep1, &quick_tools, &clipboard, &chase, &sound, &activity,
                &size, &sep2, &startup, &settings_item, &reset, &sep3, &about, &quit,
            ],
        )
    } else {
        Menu::with_items(
            app,
            &[
                &cat_off, &pause, &pet, &call, &sleep, &sep1, &quick_tools, &chase, &sound, &activity,
                &size, &sep2, &startup, &settings_item, &reset, &sep3, &about, &quit,
            ],
        )
    }
}

pub fn build_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let menu = build_menu(app, &TrayState::default())?;
    let icon = app
        .default_window_icon()
        .cloned()
        .expect("a default window icon is configured");

    TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .tooltip("MewMuze")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let id = event.id.as_ref();
            match id {
                "quit" => {
                    // The page saves anything still pending (Tasks) on this
                    // event; the exit follows shortly whether or not it answers.
                    let _ = app.emit("app-quitting", ());
                    let app = app.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(700));
                        app.exit(0);
                    });
                }
                other => {
                    let _ = app.emit("tray-command", other.to_string());
                }
            }
        })
        .build(app)?;
    Ok(())
}

#[tauri::command]
pub fn update_tray(app: AppHandle, state: TrayState) -> Result<(), String> {
    let menu = build_menu(&app, &state).map_err(|e| e.to_string())?;
    if let Some(tray) = app.tray_by_id("main-tray") {
        tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    }
    Ok(())
}
