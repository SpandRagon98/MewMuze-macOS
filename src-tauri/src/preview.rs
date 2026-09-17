//! The Look Preview window (Paper): a small, separate window that shows a
//! costume on the user's cat running through real animations.
//!
//! It is its own webview with its own copy of the renderer, so nothing it
//! draws can touch the live desktop cat: the costume the user actually wears
//! changes only through "Wear", which the preview asks the main window to do.

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

const LABEL: &str = "look-preview";

/// Costume ids are short slugs; anything else never reaches the URL.
fn valid_look(look: &str) -> bool {
    !look.is_empty() && look.len() <= 64 && look.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

/// Open the preview on `look`, or point the open one at it.
///
/// async on purpose: creating a window from a synchronous command deadlocks
/// on Windows (the new webview never navigates and stays about:blank).
#[tauri::command]
pub async fn open_look_preview(app: AppHandle, look: String) -> Result<(), String> {
    if !valid_look(&look) {
        return Err("Unknown look.".into());
    }
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return app.emit_to(LABEL, "preview-look", look).map_err(|e| e.to_string());
    }
    // The same page as the overlay; which app it runs is decided before any
    // of its scripts do. (A query string on an app URL left the window blank.)
    WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("index.html".into()))
        .initialization_script(format!("window.__MEWMUZE_VIEW__ = {{ view: \"preview\", look: \"{look}\" }};"))
        .title("MewMuze · Look preview")
        .inner_size(540.0, 660.0)
        .min_inner_size(420.0, 560.0)
        .decorations(false)
        .resizable(true)
        .center()
        .focused(true)
        // The page paints the same ground before its first frame: no white flash.
        .background_color(tauri::window::Color(11, 12, 16, 255))
        .build()
        .map(|_| ())
        .map_err(|e| format!("The preview could not open: {e}"))
}

#[cfg(test)]
mod tests {
    use super::valid_look;

    #[test]
    fn only_plain_costume_ids_reach_the_window_url() {
        assert!(valid_look("mewmuze.corporate-cat"));
        assert!(valid_look("batcat_v2"));
        assert!(!valid_look(""));
        assert!(!valid_look("x&view=main"));
        assert!(!valid_look("../../etc"));
        assert!(!valid_look("a b"));
        assert!(!valid_look(&"a".repeat(65)));
    }
}
