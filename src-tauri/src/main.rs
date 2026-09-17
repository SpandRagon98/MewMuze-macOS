// Hide the console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio;
mod calendar;
mod chat_providers;
mod clipboard;
mod companion_net;
mod companion_power;
mod context;
mod convert;
mod costume;
mod cursor;
mod diary;
mod dodo_license;
mod gmail;
mod input;
mod license;
mod local_ai;
mod mic;
mod modules;
mod overlay;
mod pdf_write;
mod photo;
mod preview;
mod secure_store;
mod settings;
mod sheets;
mod tasks;
mod tray;
mod trial;
mod window_detection;

use tauri::{AppHandle, Manager};

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

fn main() {
    // Ensure coordinates from Win32 are in physical pixels (per-monitor DPI v2).
    // Tauri also requests this via its manifest; calling again is harmless.
    #[cfg(windows)]
    unsafe {
        use windows::Win32::UI::HiDpi::{
            SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
        };
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }

    tauri::Builder::default()
        .manage(costume::CostumeRequestState::default())
        .manage(overlay::WindowModeState::default())
        // Only one cat may live on this desktop: a second launch just surfaces
        // the existing instance's overlay instead of starting another.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            costume::queue_launch_args(app, &args);
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None::<Vec<&str>>,
        ))
        // Silent in-app updates for paying users.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // Native open/save dialogs for the Quick Tools conversions.
        .plugin(tauri_plugin_dialog::init())
        // Paper: the dictation shortcut (registered only while Local Voice is installed).
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            let win = app
                .get_webview_window("main")
                .expect("main overlay window must exist");
            overlay::init_overlay(&win)?;
            let handle = app.handle().clone();
            modules::init(&handle);
            local_ai::reap_orphans();
            audio::sweep_temp();
            tray::build_tray(&handle)?;
            input::init_scroll_hook();
            clipboard::init_clipboard_listener(&handle)?;
            let args: Vec<String> = std::env::args().collect();
            costume::queue_launch_args(&handle, &args);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            cursor::get_cursor_position,
            window_detection::enumerate_windows,
            window_detection::get_monitors,
            window_detection::is_fullscreen_active,
            overlay::set_click_through,
            overlay::position_overlay,
            overlay::set_cat_visible,
            overlay::set_activation_window_mode,
            overlay::minimize_activation_window,
            overlay::set_settings_window_mode,
            preview::open_look_preview,
            overlay::minimize_settings_window,
            settings::load_settings,
            settings::save_settings,
            settings::clear_mewmuze_local_data,
            trial::trial_status,
            trial::trial_begin,
            settings::read_agent_status,
            input::get_keyboard_activity,
            input::get_user_idle_ms,
            input::get_scroll_delta,
            context::get_foreground_app,
            context::get_media_playing,
            mic::get_mic_active,
            tray::update_tray,
            license::verify_license,
            dodo_license::activate_dodo_license,
            dodo_license::restore_dodo_license,
            dodo_license::check_dodo_license,
            dodo_license::deactivate_dodo_license,
            convert::convert_support,
            convert::images_to_pdf,
            convert::pdf_to_images,
            convert::merge_pdfs,
            convert::split_pdf,
            sheets::sheet_info,
            sheets::sheet_preview,
            sheets::csv_to_xlsx,
            sheets::xlsx_to_csv,
            sheets::merge_sheets,
            sheets::split_workbook,
            sheets::cancel_sheet_op,
            gmail::gmail_fetch,
            calendar::calendar_fetch,
            companion_net::companion_http,
            companion_net::companion_net_set_paused,
            companion_net::companion_net_stats,
            companion_power::power_status,
            companion_power::approx_location,
            modules::module_status,
            modules::module_download,
            modules::module_pause,
            modules::module_remove,
            local_ai::voice_transcribe,
            local_ai::voice_cancel,
            local_ai::chat_load,
            local_ai::chat_unload,
            local_ai::chat_generate,
            local_ai::chat_cancel,
            local_ai::chat_json,
            local_ai::ai_status,
            audio::audio_start,
            audio::audio_level,
            audio::audio_stop,
            audio::audio_cancel,
            audio::audio_discard,
            audio::audio_save,
            secure_store::secure_write,
            secure_store::secure_read,
            secure_store::secure_delete,
            secure_store::dictation_paste,
            clipboard::clipboard_read_text,
            clipboard::clipboard_write_text,
            clipboard::clipboard_clear,
            clipboard::is_session_locked,
            clipboard::open_clipboard_link,
            costume::install_costume_package,
            costume::list_installed_costumes,
            costume::get_costume_visuals,
            costume::set_costume_enabled,
            costume::uninstall_costume,
            costume::get_pending_costume_request,
            costume::clear_pending_costume_request,
            costume::confirm_install_token,
            costume::open_mewmuze_store,
            photo::photo_save,
            photo::photo_copy_image,
            photo::photo_reveal,
            photo::photo_capture_screen,
            quit_app,
            tasks::tasks_load,
            tasks::tasks_save,
            tasks::tasks_quarantine,
            chat_providers::provider_key_set,
            chat_providers::provider_key_status,
            chat_providers::provider_key_remove,
            chat_providers::provider_request,
            diary::diary_dir,
            diary::diary_read,
            diary::diary_write,
            diary::diary_delete,
            diary::diary_clear,
        ])
        .run(tauri::generate_context!())
        .expect("error while running MewMuze");
}
