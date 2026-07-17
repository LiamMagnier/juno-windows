mod code;
mod error;
mod host;
mod material;
mod net;
mod secrets;

use tauri::{Emitter, Manager};

/// Deep-link payloads (juno://auth/callback?...) are forwarded to the frontend
/// on this event. The single-instance plugin routes second-launch URLs here too.
pub const DEEP_LINK_EVENT: &str = "juno://deep-link";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // Single-instance must be registered first so a second launch (e.g. the
    // browser opening juno://auth/callback while the app runs) focuses the
    // existing window and forwards the URL instead of spawning a new process.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            // Second-launch deep-link URLs are forwarded by the plugin's
            // `deep-link` feature into on_open_url — re-emitting argv here
            // would double-deliver every auth callback.
        }));
    }

    builder = builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_window_state::Builder::default().build());

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .setup(|app| {
            #[cfg(any(windows, target_os = "linux"))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                // Register juno:// for dev builds too (installers register it
                // via the bundler on real installs).
                app.deep_link().register_all()?;
            }
            let handle = app.handle().clone();
            #[cfg(desktop)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                app.deep_link().on_open_url(move |event| {
                    let urls: Vec<String> = event.urls().iter().map(|u| u.to_string()).collect();
                    let _ = handle.emit(DEEP_LINK_EVENT, urls);
                });
            }
            // Paint a backdrop before the first frame. The window boots hidden
            // (dark by default, matching the pre-theme background) and the
            // frontend re-applies the resolved theme once it reads the setting.
            material::apply_startup(app.handle(), true);
            Ok(())
        })
        .manage(net::NetState::new())
        .manage(net::voice::VoiceState::default())
        .manage(code::workspace::WorkspaceState::default())
        .manage(code::terminal::TerminalState::default())
        .invoke_handler(tauri::generate_handler![
            secrets::secret_set,
            secrets::secret_get,
            secrets::secret_delete,
            host::host_info,
            material::set_window_material,
            net::auth::auth_configure,
            net::auth::auth_exchange,
            net::auth::auth_has_session,
            net::auth::auth_sign_out,
            net::commands::api_request,
            net::stream::api_stream,
            net::stream::api_stream_cancel,
            net::upload::api_upload_path,
            net::upload::api_upload_bytes,
            net::voice::voice_connect,
            net::voice::voice_send_text,
            net::voice::voice_send_audio,
            net::voice::voice_close,
            code::workspace::workspace_pick,
            code::workspace::workspace_list,
            code::workspace::workspace_set_mode,
            code::workspace::workspace_revoke,
            code::fs::ws_list,
            code::fs::ws_read,
            code::fs::ws_write,
            code::fs::ws_delete_file,
            code::search::ws_search,
            code::checkpoints::ws_snapshot,
            code::checkpoints::ws_restore_to_before,
            code::checkpoints::ws_changed_paths,
            code::terminal::pty_run,
            code::terminal::pty_write,
            code::terminal::pty_kill,
            code::terminal::pty_kill_session,
            code::git::git_status,
            code::git::git_diff,
            code::git::git_log,
            code::git::git_commit,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
