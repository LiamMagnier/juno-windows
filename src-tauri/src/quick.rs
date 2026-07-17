//! Process-owned Juno Quick lifecycle.
//!
//! Shortcut registration, placement, tray behavior, launch-at-login, and
//! foreground restoration live here instead of in either webview. This keeps
//! Quick available while the main window is hidden and prevents two renderer
//! processes from racing over global OS state.

use crate::error::CommandError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{
    menu::MenuBuilder,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewWindow,
};
use tauri_plugin_autostart::ManagerExt as AutostartExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};

pub const QUICK_LABEL: &str = "quick";
pub const MAIN_LABEL: &str = "main";
pub const SETTINGS_CHANGED_EVENT: &str = "juno://quick-settings-changed";
pub const OPEN_CONVERSATION_EVENT: &str = "juno://open-conversation";
pub const OPEN_SETTINGS_EVENT: &str = "juno://open-settings";

const DEFAULT_SHORTCUT: &str = "Ctrl+Shift+Space";
const TRIGGER_DEBOUNCE: Duration = Duration::from_millis(240);
const COMPACT_HEIGHT: f64 = 188.0;
const EXPANDED_HEIGHT: f64 = 440.0;
const DRAFT_SERVICE: &str = "dev.liams.juno.windows.quick-draft";
const CURRENT_ACCOUNT_KEY: &str = "current-account";
// Windows Credential Manager has a small per-credential blob limit. Drafts
// are committed as versioned chunks and a final manifest pointer.
const DRAFT_CHUNK_BYTES: usize = 1_600;
const MAX_DRAFT_BYTES: usize = 220_000;
const MAX_DRAFT_CHUNKS: usize = 160;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct QuickSettings {
    pub enabled: bool,
    pub shortcut: String,
    pub launch_at_login: bool,
    pub dismiss_on_blur: bool,
}

impl Default for QuickSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            shortcut: DEFAULT_SHORTCUT.into(),
            launch_at_login: false,
            dismiss_on_blur: true,
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickSettingsPatch {
    pub enabled: Option<bool>,
    pub shortcut: Option<String>,
    pub launch_at_login: Option<bool>,
    pub dismiss_on_blur: Option<bool>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickSettingsSnapshot {
    #[serde(flatten)]
    pub settings: QuickSettings,
    pub shortcut_status: String,
    pub shortcut_error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MainStartup {
    pub show_main: bool,
    pub pending_conversation_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickDraft {
    pub text: String,
    pub model_id: Option<String>,
    pub project_id: Option<String>,
    #[serde(default)]
    pub client_request_id: Option<String>,
    #[serde(default)]
    pub client_message_id: Option<String>,
    #[serde(default)]
    pub attachment_ids: Vec<String>,
    #[serde(default)]
    pub attachment_names: Vec<String>,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    #[serde(default)]
    pub web_search: bool,
    #[serde(default)]
    pub connector_ids: Vec<String>,
    #[serde(default)]
    pub preflight_clarification: Option<serde_json::Value>,
    pub updated_at: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DraftManifest {
    version: String,
    chunks: usize,
    digest: String,
}

#[derive(Clone, Debug)]
struct RegistrationState {
    registered: Option<String>,
    status: String,
    error: Option<String>,
}

impl Default for RegistrationState {
    fn default() -> Self {
        Self {
            registered: None,
            status: "disabled".into(),
            error: None,
        }
    }
}

pub struct QuickState {
    settings: Mutex<QuickSettings>,
    registration: Mutex<RegistrationState>,
    last_trigger: Mutex<Option<Instant>>,
    previous_foreground: Mutex<Option<isize>>,
    pending_conversation: Mutex<Option<String>>,
    current_account: Mutex<Option<String>>,
    pub quitting: AtomicBool,
    interaction_busy: AtomicBool,
    composer_focused: AtomicBool,
    expanded: AtomicBool,
    startup_hidden: bool,
}

impl Default for QuickState {
    fn default() -> Self {
        Self {
            settings: Mutex::new(QuickSettings::default()),
            registration: Mutex::new(RegistrationState::default()),
            last_trigger: Mutex::new(None),
            previous_foreground: Mutex::new(None),
            pending_conversation: Mutex::new(None),
            current_account: Mutex::new(None),
            quitting: AtomicBool::new(false),
            interaction_busy: AtomicBool::new(false),
            composer_focused: AtomicBool::new(false),
            expanded: AtomicBool::new(false),
            startup_hidden: std::env::args().any(|arg| arg == "--juno-quick-background"),
        }
    }
}

impl QuickState {
    pub fn enabled(&self) -> bool {
        self.settings.lock().unwrap().enabled
    }

    fn snapshot(&self) -> QuickSettingsSnapshot {
        let settings = self.settings.lock().unwrap().clone();
        let registration = self.registration.lock().unwrap();
        QuickSettingsSnapshot {
            settings,
            shortcut_status: registration.status.clone(),
            shortcut_error: registration.error.clone(),
        }
    }
}

pub fn shortcut_plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, _shortcut: &Shortcut, event: ShortcutEvent| {
            if event.state == ShortcutState::Pressed {
                handle_shortcut(app);
            }
        })
        .build()
}

pub fn autostart_plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_autostart::init(
        tauri_plugin_autostart::MacosLauncher::LaunchAgent,
        Some(vec!["--juno-quick-background"]),
    )
}

fn settings_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, CommandError> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join("juno-quick.json"))
        .map_err(|_| CommandError::new("settings_unavailable", "Quick settings are unavailable."))
}

fn load_settings<R: Runtime>(app: &AppHandle<R>) -> QuickSettings {
    let Ok(path) = settings_path(app) else {
        return QuickSettings::default();
    };
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn save_settings<R: Runtime>(
    app: &AppHandle<R>,
    settings: &QuickSettings,
) -> Result<(), CommandError> {
    let path = settings_path(app)?;
    let parent = path.parent().ok_or_else(|| {
        CommandError::new("settings_unavailable", "Quick settings are unavailable.")
    })?;
    fs::create_dir_all(parent).map_err(|_| {
        CommandError::new(
            "settings_write_failed",
            "Quick settings could not be saved.",
        )
    })?;
    let bytes = serde_json::to_vec_pretty(settings).map_err(|_| {
        CommandError::new(
            "settings_write_failed",
            "Quick settings could not be saved.",
        )
    })?;
    // This document is tiny and bounded. A direct replacement is preferable
    // to rename-over-existing here because Windows rename does not replace an
    // existing destination.
    fs::write(&path, bytes).map_err(|_| {
        CommandError::new(
            "settings_write_failed",
            "Quick settings could not be saved.",
        )
    })
}

/// Called after every plugin has initialized, so registration and autostart
/// managers are available. Registration conflicts are surfaced as status and
/// never crash app startup.
pub fn initialize<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let state = app.state::<QuickState>();
    let loaded = load_settings(app);
    *state.settings.lock().unwrap() = loaded.clone();
    if crate::net::auth::read_refresh_token()
        .ok()
        .flatten()
        .is_some()
    {
        *state.current_account.lock().unwrap() = read_current_account();
    }

    if loaded.enabled {
        let _ = replace_shortcut(app, &loaded.shortcut);
    }
    // The OS is the authority. If its state drifted, reflect it in settings so
    // the UI does not claim startup is enabled when it is not.
    if let Ok(actual) = app.autolaunch().is_enabled() {
        state.settings.lock().unwrap().launch_at_login = actual;
    }

    build_tray(app)?;
    Ok(())
}

fn replace_shortcut<R: Runtime>(app: &AppHandle<R>, requested: &str) -> Result<(), CommandError> {
    let canonical = requested.trim();
    validated_shortcut(canonical)?;

    let state = app.state::<QuickState>();
    let old = state.registration.lock().unwrap().registered.clone();
    if old.as_deref() == Some(canonical) {
        let mut registration = state.registration.lock().unwrap();
        registration.status = "registered".into();
        registration.error = None;
        return Ok(());
    }

    // Register first: if another app owns this chord, the old working shortcut
    // remains active. Only unregister the old chord after the new one succeeds.
    if let Err(error) = app.global_shortcut().register(canonical) {
        let message = format!("{error}");
        let mut registration = state.registration.lock().unwrap();
        registration.status = "conflict".into();
        registration.error = Some(if old.is_some() {
            "That shortcut is already in use. Juno kept the previous shortcut active.".into()
        } else {
            "That shortcut is already in use. Choose another combination.".into()
        });
        return Err(CommandError::new(
            "shortcut_conflict",
            if message.is_empty() {
                "That shortcut is already in use."
            } else {
                "That shortcut could not be registered. It may already be in use."
            },
        ));
    }
    if let Some(old) = old.as_deref() {
        if app.global_shortcut().unregister(old).is_err() {
            // Preserve the one-active-registration invariant. If replacing the
            // old chord fails, unregister the newly acquired chord and keep the
            // prior settings/runtime state authoritative.
            let rollback = app.global_shortcut().unregister(canonical);
            let mut registration = state.registration.lock().unwrap();
            registration.status = if rollback.is_ok() {
                "registered".into()
            } else {
                "error".into()
            };
            registration.error = Some(if rollback.is_ok() {
                "The new shortcut was released; the previous shortcut remains active.".into()
            } else {
                "Windows could not release either shortcut. Restart Juno before changing it again."
                    .into()
            });
            return Err(CommandError::new(
                "shortcut_replace_failed",
                "The previous shortcut could not be released. Juno kept it active.",
            ));
        }
    }
    let mut registration = state.registration.lock().unwrap();
    registration.registered = Some(canonical.to_string());
    registration.status = "registered".into();
    registration.error = None;
    Ok(())
}

fn validated_shortcut(value: &str) -> Result<Shortcut, CommandError> {
    if value.is_empty() {
        return Err(CommandError::new(
            "invalid_shortcut",
            "Choose a shortcut with at least one modifier.",
        ));
    }
    let shortcut: Shortcut = value.parse().map_err(|_| {
        CommandError::new(
            "invalid_shortcut",
            "That key combination is not a valid global shortcut.",
        )
    })?;
    if shortcut.mods.is_empty() {
        return Err(CommandError::new(
            "invalid_shortcut",
            "Use at least one modifier: Ctrl, Shift, Alt, or Windows key.",
        ));
    }
    Ok(shortcut)
}

fn unregister_shortcut<R: Runtime>(app: &AppHandle<R>) -> Result<(), CommandError> {
    let state = app.state::<QuickState>();
    let old = state.registration.lock().unwrap().registered.clone();
    if let Some(shortcut) = old.as_deref() {
        app.global_shortcut().unregister(shortcut).map_err(|_| {
            let mut registration = state.registration.lock().unwrap();
            registration.status = "error".into();
            registration.error =
                Some("Windows could not release the active shortcut. It remains enabled.".into());
            CommandError::new(
                "shortcut_release_failed",
                "The active shortcut could not be released, so Juno Quick stayed enabled.",
            )
        })?;
    }
    let mut registration = state.registration.lock().unwrap();
    registration.registered = None;
    registration.status = "disabled".into();
    registration.error = None;
    Ok(())
}

fn handle_shortcut<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<QuickState>();
    if !state.enabled() {
        return;
    }
    let now = Instant::now();
    let mut last = state.last_trigger.lock().unwrap();
    if last.is_some_and(|then| now.duration_since(then) < TRIGGER_DEBOUNCE) {
        return;
    }
    *last = Some(now);
    drop(last);

    let visible = app
        .get_webview_window(QUICK_LABEL)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false);
    if visible {
        if let Some(window) = app.get_webview_window(QUICK_LABEL) {
            let focused = window.is_focused().unwrap_or(false);
            if state.interaction_busy.load(Ordering::SeqCst)
                || !focused
                || !state.composer_focused.load(Ordering::SeqCst)
            {
                if !focused {
                    *state.previous_foreground.lock().unwrap() = capture_foreground(&window);
                }
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
                activate_window(&window);
                let _ = window.emit("juno://quick-focus-composer", ());
            } else {
                hide_quick(app, true);
            }
        }
    } else {
        show_quick(app);
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct OverlayBounds {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

fn overlay_bounds(
    work_x: i32,
    work_y: i32,
    work_width: u32,
    work_height: u32,
    scale: f64,
    expanded: bool,
) -> OverlayBounds {
    let margin = (24.0 * scale).round().max(12.0) as u32;
    let desired_width = (680.0 * scale).round() as u32;
    let desired_height = ((if expanded {
        EXPANDED_HEIGHT
    } else {
        COMPACT_HEIGHT
    }) * scale)
        .round() as u32;
    let min_width = 320.min(work_width);
    let min_height = ((140.0 * scale).round() as u32).min(work_height);
    let usable_width = work_width.saturating_sub(margin.saturating_mul(2));
    let usable_height = work_height.saturating_sub(margin.saturating_mul(2));
    let width = desired_width
        .min(usable_width.max(min_width))
        .min(work_width);
    let height = desired_height
        .min(usable_height.max(min_height))
        .min(work_height);
    let top_margin = margin.min(work_height.saturating_sub(height) / 2);
    OverlayBounds {
        x: work_x + ((work_width.saturating_sub(width)) / 2) as i32,
        y: work_y + top_margin as i32,
        width,
        height,
    }
}

fn target_monitor<R: Runtime>(app: &AppHandle<R>) -> Option<tauri::window::Monitor> {
    // Cursor monitor is deterministic across foreground apps and naturally
    // follows the user's active display. Fall back to the foreground window's
    // center, then the primary monitor.
    app.cursor_position()
        .ok()
        .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
        .or_else(|| {
            foreground_center().and_then(|(x, y)| app.monitor_from_point(x, y).ok().flatten())
        })
        .or_else(|| app.primary_monitor().ok().flatten())
}

pub fn show_quick<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(QUICK_LABEL) else {
        return;
    };
    let state = app.state::<QuickState>();
    *state.previous_foreground.lock().unwrap() = capture_foreground(&window);

    if let Some(monitor) = target_monitor(app) {
        let work = monitor.work_area();
        let bounds = overlay_bounds(
            work.position.x,
            work.position.y,
            work.size.width,
            work.size.height,
            monitor.scale_factor(),
            state.expanded.load(Ordering::SeqCst),
        );
        let _ = window.set_size(PhysicalSize::new(bounds.width, bounds.height));
        let _ = window.set_position(PhysicalPosition::new(bounds.x, bounds.y));
    }
    let _ = window.set_always_on_top(true);
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
    activate_window(&window);
    let _ = window.emit("juno://quick-shown", ());
}

/// Resize only when the renderer crosses a compact/expanded content boundary.
/// The top edge stays fixed so the surface never appears to jump while a
/// response streams; the height is clipped to the monitor work area.
fn resize_quick<R: Runtime>(window: &WebviewWindow<R>, expanded: bool) {
    let Ok(Some(monitor)) = window.current_monitor() else {
        return;
    };
    let work = monitor.work_area();
    let Ok(current_position) = window.outer_position() else {
        return;
    };
    let Ok(current_size) = window.outer_size() else {
        return;
    };
    let work_bottom = i64::from(work.position.y) + i64::from(work.size.height);
    let y = current_position
        .y
        .max(work.position.y)
        .min((work_bottom - 1).clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32);
    let available_height = work_bottom
        .saturating_sub(i64::from(y))
        .max(1)
        .min(i64::from(u32::MAX)) as u32;
    let desired_height = ((if expanded {
        EXPANDED_HEIGHT
    } else {
        COMPACT_HEIGHT
    }) * monitor.scale_factor())
    .round() as u32;
    let height = desired_height.min(available_height).min(work.size.height);
    let max_x =
        i64::from(work.position.x) + i64::from(work.size.width.saturating_sub(current_size.width));
    let x = i64::from(current_position.x).clamp(
        i64::from(work.position.x),
        max_x.max(i64::from(work.position.x)),
    ) as i32;

    let _ = window.set_position(PhysicalPosition::new(x, y));
    let _ = window.set_size(PhysicalSize::new(
        current_size.width.min(work.size.width),
        height,
    ));
}

pub fn hide_quick<R: Runtime>(app: &AppHandle<R>, restore_focus: bool) {
    if let Some(window) = app.get_webview_window(QUICK_LABEL) {
        let _ = window.hide();
        let _ = window.emit("juno://quick-hidden", ());
    }
    if restore_focus {
        let previous = app
            .state::<QuickState>()
            .previous_foreground
            .lock()
            .unwrap()
            .take();
        restore_foreground(previous);
    }
}

fn show_main<R: Runtime>(app: &AppHandle<R>, conversation_id: Option<String>) {
    if let Some(id) = conversation_id {
        *app.state::<QuickState>()
            .pending_conversation
            .lock()
            .unwrap() = Some(id.clone());
        let _ = app.emit_to(MAIN_LABEL, OPEN_CONVERSATION_EVENT, id);
    }
    if let Some(window) = app.get_webview_window(MAIN_LABEL) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        activate_window(&window);
    }
}

fn build_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let menu = MenuBuilder::new(app)
        .text("quick", "Juno Quick")
        .text("open-main", "Open Juno")
        .text("settings", "Quick Settings…")
        .text("repair-shortcut", "Re-register Quick shortcut")
        .separator()
        .text("quit", "Quit Juno")
        .build()?;
    let mut tray = TrayIconBuilder::with_id("juno-quick-tray")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Juno Quick")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "quick" => handle_shortcut(app),
            "open-main" => show_main(app, None),
            "settings" => {
                show_main(app, None);
                let _ = app.emit_to(MAIN_LABEL, OPEN_SETTINGS_EVENT, "quick");
            }
            "repair-shortcut" => {
                let state = app.state::<QuickState>();
                if state.enabled() {
                    let shortcut = state.settings.lock().unwrap().shortcut.clone();
                    let result =
                        unregister_shortcut(app).and_then(|_| replace_shortcut(app, &shortcut));
                    if let Err(error) = result {
                        let mut registration = state.registration.lock().unwrap();
                        registration.status = "error".into();
                        registration.error = Some(error.message);
                    }
                    let _ = app.emit(SETTINGS_CHANGED_EVENT, state.snapshot());
                }
            }
            "quit" => quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                handle_shortcut(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon);
    }
    tray.build(app)?;
    Ok(())
}

pub fn quit<R: Runtime>(app: &AppHandle<R>) {
    app.state::<QuickState>()
        .quitting
        .store(true, Ordering::SeqCst);
    app.exit(0);
}

fn vault_entry(key: &str) -> Result<keyring::Entry, CommandError> {
    keyring::Entry::new(DRAFT_SERVICE, key).map_err(|_| {
        CommandError::new(
            "draft_vault_unavailable",
            "The protected draft store is unavailable.",
        )
    })
}

fn vault_read(key: &str) -> Result<Option<String>, CommandError> {
    match vault_entry(key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(CommandError::new(
            "draft_read_failed",
            "The protected Quick draft could not be read.",
        )),
    }
}

fn vault_write(key: &str, value: &str) -> Result<(), CommandError> {
    vault_entry(key)?.set_password(value).map_err(|_| {
        CommandError::new(
            "draft_write_failed",
            "The protected Quick draft could not be saved.",
        )
    })
}

fn vault_delete(key: &str) {
    if let Ok(entry) = vault_entry(key) {
        let _ = entry.delete_credential();
    }
}

fn account_hash(account_id: &str) -> String {
    let digest = Sha256::digest(account_id.as_bytes());
    hex::encode(digest)
}

fn manifest_key(account_hash: &str) -> String {
    format!("draft-{account_hash}-manifest")
}

fn chunk_key(account_hash: &str, version: &str, index: usize) -> String {
    format!("draft-{account_hash}-{version}-{index:03}")
}

fn read_current_account() -> Option<String> {
    vault_read(CURRENT_ACCOUNT_KEY).ok().flatten().filter(|id| {
        !id.is_empty()
            && id.len() <= 128
            && id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    })
}

/// Bound only from a successful authenticated `/v1/auth/session` response in
/// the Rust transport. The Quick renderer cannot choose another account's
/// draft namespace.
pub fn bind_authenticated_account<R: Runtime>(app: &AppHandle<R>, account_id: &str) {
    if account_id.is_empty()
        || account_id.len() > 128
        || !account_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return;
    }
    let state = app.state::<QuickState>();
    let departing = state
        .current_account
        .lock()
        .unwrap()
        .clone()
        .or_else(read_current_account);
    if let Some(departing) = departing.filter(|old| old != account_id) {
        clear_account_draft(&departing);
    }
    if vault_write(CURRENT_ACCOUNT_KEY, account_id).is_ok() {
        *state.current_account.lock().unwrap() = Some(account_id.to_string());
    }
}

fn current_account<R: Runtime>(app: &AppHandle<R>) -> Result<String, CommandError> {
    if crate::net::auth::read_refresh_token()?.is_none() {
        return Err(CommandError::new(
            "signed_out",
            "Sign in to restore a Quick draft.",
        ));
    }
    app.state::<QuickState>()
        .current_account
        .lock()
        .unwrap()
        .clone()
        .or_else(read_current_account)
        .ok_or_else(|| {
            CommandError::new(
                "account_unbound",
                "Open Juno once online before restoring a Quick draft.",
            )
        })
}

fn split_credential_chunks(value: &str) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current = String::new();
    for character in value.chars() {
        if !current.is_empty() && current.len() + character.len_utf8() > DRAFT_CHUNK_BYTES {
            chunks.push(std::mem::take(&mut current));
        }
        current.push(character);
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

fn read_manifest(account_hash: &str) -> Result<Option<DraftManifest>, CommandError> {
    let Some(raw) = vault_read(&manifest_key(account_hash))? else {
        return Ok(None);
    };
    let manifest: DraftManifest = serde_json::from_str(&raw).map_err(|_| {
        CommandError::new(
            "draft_corrupt",
            "The protected Quick draft is invalid and could not be restored.",
        )
    })?;
    if manifest.chunks == 0 || manifest.chunks > MAX_DRAFT_CHUNKS || manifest.version.len() > 64 {
        return Err(CommandError::new(
            "draft_corrupt",
            "The protected Quick draft is invalid and could not be restored.",
        ));
    }
    Ok(Some(manifest))
}

fn delete_manifest_chunks(account_hash: &str, manifest: &DraftManifest) {
    for index in 0..manifest.chunks.min(MAX_DRAFT_CHUNKS) {
        vault_delete(&chunk_key(account_hash, &manifest.version, index));
    }
}

fn clear_account_draft(account_id: &str) {
    let hash = account_hash(account_id);
    if let Ok(Some(manifest)) = read_manifest(&hash) {
        delete_manifest_chunks(&hash, &manifest);
    }
    vault_delete(&manifest_key(&hash));
}

pub fn clear_departing_draft<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<QuickState>();
    let account = state
        .current_account
        .lock()
        .unwrap()
        .take()
        .or_else(read_current_account);
    if let Some(account) = account {
        clear_account_draft(&account);
    }
    vault_delete(CURRENT_ACCOUNT_KEY);
}

#[tauri::command]
pub fn quick_draft_load<R: Runtime>(
    window: WebviewWindow<R>,
    app: AppHandle<R>,
) -> Result<Option<QuickDraft>, CommandError> {
    require_label(&window, &[QUICK_LABEL])?;
    let account = current_account(&app)?;
    let hash = account_hash(&account);
    let Some(manifest) = read_manifest(&hash)? else {
        return Ok(None);
    };
    let mut raw = String::new();
    for index in 0..manifest.chunks {
        let chunk = vault_read(&chunk_key(&hash, &manifest.version, index))?.ok_or_else(|| {
            CommandError::new(
                "draft_corrupt",
                "The protected Quick draft is incomplete and could not be restored.",
            )
        })?;
        raw.push_str(&chunk);
        if raw.len() > MAX_DRAFT_BYTES {
            return Err(CommandError::new(
                "draft_corrupt",
                "The protected Quick draft is too large to restore.",
            ));
        }
    }
    if hex::encode(Sha256::digest(raw.as_bytes())) != manifest.digest {
        return Err(CommandError::new(
            "draft_corrupt",
            "The protected Quick draft failed its integrity check.",
        ));
    }
    serde_json::from_str(&raw).map(Some).map_err(|_| {
        CommandError::new(
            "draft_corrupt",
            "The protected Quick draft is invalid and could not be restored.",
        )
    })
}

#[tauri::command]
pub fn quick_draft_save<R: Runtime>(
    window: WebviewWindow<R>,
    app: AppHandle<R>,
    draft: QuickDraft,
) -> Result<(), CommandError> {
    require_label(&window, &[QUICK_LABEL])?;
    let ids_paired = draft.client_request_id.is_some() == draft.client_message_id.is_some();
    let valid_client_id = |id: &str| {
        (8..=120).contains(&id.len())
            && id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    };
    let valid_connector_id = |id: &str| {
        !id.is_empty()
            && id.len() <= 160
            && id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'))
    };
    let valid_effort = |effort: &str| {
        matches!(
            effort,
            "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
        )
    };
    let clarification_too_large = draft
        .preflight_clarification
        .as_ref()
        .and_then(|value| serde_json::to_vec(value).ok())
        .is_some_and(|bytes| bytes.len() > 16 * 1024);
    if draft.text.chars().count() > 50_000
        || draft.model_id.as_ref().is_some_and(|id| id.len() > 200)
        || draft.project_id.as_ref().is_some_and(|id| id.len() > 200)
        || !ids_paired
        || draft
            .client_request_id
            .as_deref()
            .is_some_and(|id| !valid_client_id(id))
        || draft
            .client_message_id
            .as_deref()
            .is_some_and(|id| !valid_client_id(id))
        || draft.attachment_ids.len() > 10
        || draft.attachment_names.len() != draft.attachment_ids.len()
        || draft.attachment_ids.iter().any(|id| !valid_client_id(id))
        || draft.attachment_names.iter().any(|name| {
            name.is_empty()
                || name.len() > 160
                || name.contains(['/', '\\'])
                || name.chars().any(char::is_control)
        })
        || draft
            .reasoning_effort
            .as_deref()
            .is_some_and(|effort| !valid_effort(effort))
        || draft.connector_ids.len() > 5
        || draft.connector_ids.iter().any(|id| !valid_connector_id(id))
        || clarification_too_large
    {
        return Err(CommandError::new(
            "draft_too_large",
            "This draft is too large to save in Juno Quick.",
        ));
    }
    let account = current_account(&app)?;
    let hash = account_hash(&account);
    let raw = serde_json::to_string(&draft).map_err(|_| {
        CommandError::new("draft_write_failed", "The Quick draft could not be saved.")
    })?;
    if raw.len() > MAX_DRAFT_BYTES {
        return Err(CommandError::new(
            "draft_too_large",
            "This draft is too large to save in Juno Quick.",
        ));
    }
    let chunks = split_credential_chunks(&raw);
    if chunks.is_empty() || chunks.len() > MAX_DRAFT_CHUNKS {
        return Err(CommandError::new(
            "draft_too_large",
            "This draft is too large to save in Juno Quick.",
        ));
    }
    let previous = read_manifest(&hash)?;
    let version = uuid::Uuid::new_v4().simple().to_string();
    for (index, chunk) in chunks.iter().enumerate() {
        if let Err(error) = vault_write(&chunk_key(&hash, &version, index), chunk) {
            for rollback in 0..index {
                vault_delete(&chunk_key(&hash, &version, rollback));
            }
            return Err(error);
        }
    }
    let manifest = DraftManifest {
        version,
        chunks: chunks.len(),
        digest: hex::encode(Sha256::digest(raw.as_bytes())),
    };
    let manifest_raw = serde_json::to_string(&manifest).map_err(|_| {
        CommandError::new("draft_write_failed", "The Quick draft could not be saved.")
    })?;
    if let Err(error) = vault_write(&manifest_key(&hash), &manifest_raw) {
        delete_manifest_chunks(&hash, &manifest);
        return Err(error);
    }
    if let Some(previous) = previous {
        delete_manifest_chunks(&hash, &previous);
    }
    Ok(())
}

#[tauri::command]
pub fn quick_draft_clear<R: Runtime>(
    window: WebviewWindow<R>,
    app: AppHandle<R>,
) -> Result<(), CommandError> {
    require_label(&window, &[QUICK_LABEL])?;
    let account = current_account(&app)?;
    clear_account_draft(&account);
    Ok(())
}

#[tauri::command]
pub fn quick_set_runtime_state<R: Runtime>(
    window: WebviewWindow<R>,
    app: AppHandle<R>,
    state: tauri::State<'_, QuickState>,
    busy: bool,
    composer_focused: bool,
    expanded: bool,
) -> Result<(), CommandError> {
    require_label(&window, &[QUICK_LABEL])?;
    state.interaction_busy.store(busy, Ordering::SeqCst);
    state
        .composer_focused
        .store(composer_focused, Ordering::SeqCst);
    if state.expanded.swap(expanded, Ordering::SeqCst) != expanded {
        if let Some(quick) = app.get_webview_window(QUICK_LABEL) {
            resize_quick(&quick, expanded);
        }
    }
    Ok(())
}

pub fn handle_close_requested<R: Runtime>(window: &tauri::Window<R>) -> bool {
    let app = window.app_handle();
    let state = app.state::<QuickState>();
    if state.quitting.load(Ordering::SeqCst) {
        return false;
    }
    if window.label() == QUICK_LABEL || state.enabled() {
        if window.label() == QUICK_LABEL {
            hide_quick(app, true);
        } else {
            let _ = window.hide();
        }
        return true;
    }
    // With Quick disabled there is still a pre-created hidden Quick webview;
    // explicitly terminate when the user closes the main window.
    state.quitting.store(true, Ordering::SeqCst);
    app.exit(0);
    true
}

fn require_label<R: Runtime>(
    window: &WebviewWindow<R>,
    allowed: &[&str],
) -> Result<(), CommandError> {
    if allowed.contains(&window.label()) {
        Ok(())
    } else {
        Err(CommandError::new(
            "forbidden_window",
            "This action is not available from this window.",
        ))
    }
}

#[tauri::command]
pub fn quick_get_settings<R: Runtime>(
    window: WebviewWindow<R>,
    state: tauri::State<'_, QuickState>,
) -> Result<QuickSettingsSnapshot, CommandError> {
    require_label(&window, &[MAIN_LABEL, QUICK_LABEL])?;
    Ok(state.snapshot())
}

#[tauri::command]
pub fn quick_update_settings<R: Runtime>(
    window: WebviewWindow<R>,
    app: AppHandle<R>,
    patch: QuickSettingsPatch,
) -> Result<QuickSettingsSnapshot, CommandError> {
    require_label(&window, &[MAIN_LABEL])?;
    let state = app.state::<QuickState>();
    let previous = state.settings.lock().unwrap().clone();
    let mut next = previous.clone();
    if let Some(enabled) = patch.enabled {
        next.enabled = enabled;
    }
    if let Some(shortcut) = patch.shortcut {
        next.shortcut = shortcut.trim().to_string();
    }
    if let Some(launch_at_login) = patch.launch_at_login {
        next.launch_at_login = launch_at_login;
    }
    if let Some(dismiss_on_blur) = patch.dismiss_on_blur {
        next.dismiss_on_blur = dismiss_on_blur;
    }

    let autostart_changed = next.launch_at_login != previous.launch_at_login;
    if autostart_changed {
        let result = if next.launch_at_login {
            app.autolaunch().enable()
        } else {
            app.autolaunch().disable()
        };
        result.map_err(|_| {
            CommandError::new(
                "autostart_failed",
                "Windows could not update the launch-at-login setting.",
            )
        })?;
    }

    let shortcut_result = if next.enabled {
        replace_shortcut(&app, &next.shortcut)
    } else {
        unregister_shortcut(&app)
    };
    if let Err(error) = shortcut_result {
        if autostart_changed {
            let _ = if previous.launch_at_login {
                app.autolaunch().enable()
            } else {
                app.autolaunch().disable()
            };
        }
        return Err(error);
    }
    if let Err(error) = save_settings(&app, &next) {
        // Keep persisted/runtime/OS state aligned if disk persistence fails.
        if previous.enabled {
            let _ = replace_shortcut(&app, &previous.shortcut);
        } else {
            let _ = unregister_shortcut(&app);
        }
        if autostart_changed {
            let _ = if previous.launch_at_login {
                app.autolaunch().enable()
            } else {
                app.autolaunch().disable()
            };
        }
        return Err(error);
    }
    *state.settings.lock().unwrap() = next;
    if !state.enabled() {
        hide_quick(&app, false);
    }
    let snapshot = state.snapshot();
    let _ = app.emit(SETTINGS_CHANGED_EVENT, snapshot.clone());
    Ok(snapshot)
}

#[tauri::command]
pub fn quick_hide<R: Runtime>(
    window: WebviewWindow<R>,
    app: AppHandle<R>,
) -> Result<(), CommandError> {
    require_label(&window, &[QUICK_LABEL])?;
    hide_quick(&app, true);
    Ok(())
}

#[tauri::command]
pub fn quick_open_main<R: Runtime>(
    window: WebviewWindow<R>,
    app: AppHandle<R>,
    conversation_id: Option<String>,
) -> Result<(), CommandError> {
    require_label(&window, &[MAIN_LABEL, QUICK_LABEL])?;
    if conversation_id.as_deref().is_some_and(|id| {
        id.len() > 128 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    }) {
        return Err(CommandError::new(
            "invalid_conversation",
            "That conversation could not be opened.",
        ));
    }
    hide_quick(&app, false);
    show_main(&app, conversation_id);
    Ok(())
}

#[tauri::command]
pub fn quick_main_startup<R: Runtime>(
    window: WebviewWindow<R>,
    state: tauri::State<'_, QuickState>,
) -> Result<MainStartup, CommandError> {
    require_label(&window, &[MAIN_LABEL])?;
    Ok(MainStartup {
        show_main: !state.startup_hidden || !state.enabled(),
        pending_conversation_id: state.pending_conversation.lock().unwrap().take(),
    })
}

#[tauri::command]
pub fn quick_quit<R: Runtime>(
    window: WebviewWindow<R>,
    app: AppHandle<R>,
) -> Result<(), CommandError> {
    require_label(&window, &[MAIN_LABEL])?;
    quit(&app);
    Ok(())
}

#[cfg(windows)]
fn foreground_center() -> Option<(f64, f64)> {
    use windows_sys::Win32::{
        Foundation::RECT,
        UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowRect},
    };
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_null() {
            return None;
        }
        let mut rect: RECT = std::mem::zeroed();
        if GetWindowRect(hwnd, &mut rect) == 0 {
            return None;
        }
        Some((
            f64::from(rect.left + rect.right) / 2.0,
            f64::from(rect.top + rect.bottom) / 2.0,
        ))
    }
}

#[cfg(not(windows))]
fn foreground_center() -> Option<(f64, f64)> {
    None
}

#[cfg(windows)]
fn capture_foreground<R: Runtime>(quick_window: &WebviewWindow<R>) -> Option<isize> {
    use windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    let foreground = unsafe { GetForegroundWindow() };
    if foreground.is_null() {
        return None;
    }
    let quick = quick_window.hwnd().ok()?.0 as isize;
    let foreground = foreground as isize;
    (foreground != quick).then_some(foreground)
}

#[cfg(not(windows))]
fn capture_foreground<R: Runtime>(_quick_window: &WebviewWindow<R>) -> Option<isize> {
    None
}

#[cfg(windows)]
fn activate_window<R: Runtime>(window: &WebviewWindow<R>) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{SetForegroundWindow, ShowWindow, SW_SHOW};
    if let Ok(hwnd) = window.hwnd() {
        let raw = hwnd.0 as windows_sys::Win32::Foundation::HWND;
        unsafe {
            ShowWindow(raw, SW_SHOW);
            SetForegroundWindow(raw);
        }
    }
}

#[cfg(not(windows))]
fn activate_window<R: Runtime>(_window: &WebviewWindow<R>) {}

#[cfg(windows)]
fn restore_foreground(previous: Option<isize>) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        IsWindow, SetForegroundWindow, ShowWindow, SW_RESTORE,
    };
    let Some(previous) = previous else { return };
    let hwnd = previous as windows_sys::Win32::Foundation::HWND;
    unsafe {
        if IsWindow(hwnd) != 0 {
            ShowWindow(hwnd, SW_RESTORE);
            SetForegroundWindow(hwnd);
        }
    }
}

#[cfg(not(windows))]
fn restore_foreground(_previous: Option<isize>) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn centers_in_work_area_and_respects_taskbar_origin() {
        let bounds = overlay_bounds(1920, 40, 2560, 1400, 1.0, true);
        assert_eq!(bounds.width, 680);
        assert_eq!(bounds.height, 440);
        assert_eq!(bounds.x, 2860);
        assert_eq!(bounds.y, 64);
    }

    #[test]
    fn scales_for_mixed_dpi_and_clamps_to_small_work_area() {
        let scaled = overlay_bounds(-2560, 0, 2560, 1440, 1.5, true);
        assert_eq!(scaled.width, 1020);
        assert_eq!(scaled.height, 660);
        assert_eq!(scaled.x, -1790);
        assert_eq!(scaled.y, 36);

        let small = overlay_bounds(0, 0, 500, 260, 1.0, true);
        assert_eq!(small.width, 452);
        assert_eq!(small.height, 212);
        assert_eq!(small.x, 24);

        let tiny = overlay_bounds(0, 0, 180, 160, 2.0, true);
        assert_eq!(tiny.width, 180);
        assert_eq!(tiny.height, 160);
        assert_eq!(tiny.x, 0);
        assert_eq!(tiny.y, 0);
    }

    #[test]
    fn empty_overlay_uses_compact_height() {
        let compact = overlay_bounds(0, 0, 1920, 1040, 1.0, false);
        assert_eq!(compact.height, 188);
        assert_eq!(compact.y, 24);
    }

    #[test]
    fn draft_namespaces_are_account_isolated_and_chunks_are_bounded() {
        let first = account_hash("account-a");
        let second = account_hash("account-b");
        assert_ne!(first, second);
        assert!(!manifest_key(&first).contains("account-a"));
        let chunks = split_credential_chunks(&"é".repeat(2_000));
        assert!(chunks.len() > 1);
        assert!(chunks.iter().all(|chunk| chunk.len() <= DRAFT_CHUNK_BYTES));
        assert_eq!(chunks.concat(), "é".repeat(2_000));
    }

    #[test]
    fn stable_client_ids_are_log_safe() {
        let valid = |id: &str| {
            (8..=120).contains(&id.len())
                && id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        };
        assert!(valid("019f714c-5cc1-7491-8b8e-658e57b6ad13"));
        assert!(!valid("short"));
        assert!(!valid("unsafe/value"));
    }

    #[test]
    fn shortcut_validation_requires_a_modifier() {
        assert!(validated_shortcut("Ctrl+Shift+Space").is_ok());
        assert!(validated_shortcut("Space").is_err());
        assert!(validated_shortcut("").is_err());
    }
}
