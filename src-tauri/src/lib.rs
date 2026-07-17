mod error;
mod host;
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
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            // On Windows the deep-link URL arrives in argv of the second instance.
            let urls: Vec<String> = args
                .into_iter()
                .filter(|arg| arg.starts_with("juno://"))
                .collect();
            if !urls.is_empty() {
                let _ = app.emit(DEEP_LINK_EVENT, urls);
            }
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
                    let urls: Vec<String> =
                        event.urls().iter().map(|u| u.to_string()).collect();
                    let _ = handle.emit(DEEP_LINK_EVENT, urls);
                });
            }
            Ok(())
        })
        .manage(net::NetState::new())
        .invoke_handler(tauri::generate_handler![
            secrets::secret_set,
            secrets::secret_get,
            secrets::secret_delete,
            host::host_info,
            net::auth::auth_configure,
            net::auth::auth_exchange,
            net::auth::auth_has_session,
            net::auth::auth_sign_out,
            net::commands::api_request,
            net::stream::api_stream,
            net::stream::api_stream_cancel,
            net::upload::api_upload_path,
            net::upload::api_upload_bytes,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
