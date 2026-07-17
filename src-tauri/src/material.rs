//! Window backdrop material — Windows 11 Mica, macOS vibrancy (dev).
//!
//! The frontend owns the app theme, so it tells us which variant to paint and
//! we re-apply on every theme change. The command reports whether a *native*
//! backdrop was actually installed: when true the frontend lets the window
//! material show through its translucent chrome; when false it keeps an opaque
//! in-app material so the app is never see-through on an OS/theme that can't do
//! Mica. That guarantee is why `transparent: true` is safe here.

use tauri::{Manager, Runtime, WebviewWindow};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterialResult {
    /// A real OS backdrop (Mica/vibrancy) is installed behind the webview.
    pub native: bool,
}

#[allow(unused_variables)]
fn apply(window: &WebviewWindow<impl Runtime>, dark: bool) -> bool {
    #[cfg(target_os = "windows")]
    {
        use window_vibrancy::apply_mica;
        // Mica follows the wallpaper; the bool only tints the overlay warm/cool.
        return apply_mica(window, Some(dark)).is_ok();
    }
    #[cfg(target_os = "macos")]
    {
        use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
        // "Sidebar" is the closest macOS analogue to Mica for dev-time parity.
        return apply_vibrancy(
            window,
            NSVisualEffectMaterial::Sidebar,
            Some(NSVisualEffectState::Active),
            None,
        )
        .is_ok();
    }
    #[allow(unreachable_code)]
    false
}

#[cfg(target_os = "windows")]
fn clear(window: &WebviewWindow<impl Runtime>) {
    let _ = window_vibrancy::clear_mica(window);
}

#[cfg(not(target_os = "windows"))]
fn clear<R: Runtime>(_window: &WebviewWindow<R>) {}

/// Install/refresh the window material for the given theme, or clear it when
/// `enabled` is false (the user turned transparency off, or the OS asked for
/// reduced transparency). Re-applying on Windows requires clearing first, or a
/// light→dark switch stacks tints.
#[tauri::command]
pub fn set_window_material<R: Runtime>(
    window: WebviewWindow<R>,
    dark: bool,
    enabled: bool,
) -> MaterialResult {
    if window.label() != "main" && window.label() != "quick" {
        return MaterialResult { native: false };
    }
    clear(&window);
    if !enabled {
        return MaterialResult { native: false };
    }
    MaterialResult {
        native: apply(&window, dark),
    }
}

/// Best-effort material at launch so the first paint already has a backdrop.
pub fn apply_startup<R: Runtime>(app: &tauri::AppHandle<R>, dark: bool) {
    for label in ["main", "quick"] {
        if let Some(window) = app.get_webview_window(label) {
            apply(&window, dark);
        }
    }
}
