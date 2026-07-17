//! Backend transport. All HTTP to the Juno backend leaves from this process:
//! the backend's middleware rejects browser Origins it doesn't know, and a
//! native client is expected to send no Origin header at all. Routing HTTP
//! through Rust also keeps the refresh token out of the webview entirely.

pub mod auth;
pub mod commands;
pub mod stream;
pub mod upload;
pub mod voice;

use parking_lot::RwLock;
use std::collections::HashMap;
use std::sync::Mutex as StdMutex;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

pub const DEFAULT_BASE_URL: &str = "https://chat.liams.dev";

#[derive(Clone, Debug)]
pub struct AccessToken {
    pub token: String,
    /// Unix millis.
    pub expires_at: i64,
}

pub struct NetState {
    pub client: reqwest::Client,
    pub base_url: RwLock<String>,
    pub access: RwLock<Option<AccessToken>>,
    /// Held across a refresh so concurrent rotations are impossible —
    /// the server treats refresh-token reuse as theft and revokes the device.
    pub refresh_lock: Mutex<()>,
    pub streams: StdMutex<HashMap<u64, CancellationToken>>,
    pub next_stream_id: StdMutex<u64>,
}

impl NetState {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::builder()
                .user_agent(format!("JunoWindows/{}", env!("CARGO_PKG_VERSION")))
                .connect_timeout(std::time::Duration::from_secs(15))
                .build()
                .expect("reqwest client"),
            base_url: RwLock::new(DEFAULT_BASE_URL.to_string()),
            access: RwLock::new(None),
            refresh_lock: Mutex::new(()),
            streams: StdMutex::new(HashMap::new()),
            next_stream_id: StdMutex::new(1),
        }
    }

    pub fn api_url(&self, path: &str) -> String {
        let base = self.base_url.read();
        let sep = if path.starts_with('/') { "" } else { "/" };
        format!("{}/api{}{}", base.trim_end_matches('/'), sep, path)
    }
}

/// Base URLs are restricted to https, or plain http strictly on loopback —
/// the webview cannot point this client at arbitrary schemes or downgrade
/// production traffic.
pub fn validate_base_url(url: &str) -> Result<String, String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| e.to_string())?;
    match parsed.scheme() {
        "https" => {}
        "http" => {
            let host = parsed.host_str().unwrap_or("");
            if host != "localhost" && host != "127.0.0.1" {
                return Err("http is only allowed for localhost".into());
            }
        }
        other => return Err(format!("unsupported scheme: {other}")),
    }
    if !parsed.path().trim_end_matches('/').is_empty() {
        return Err("base URL must not include a path".into());
    }
    Ok(format!(
        "{}://{}{}",
        parsed.scheme(),
        parsed.host_str().unwrap_or(""),
        parsed.port().map(|p| format!(":{p}")).unwrap_or_default()
    ))
}

/// API paths must be absolute ("/chat", "/v1/bootstrap") with no scheme,
/// host, traversal, or query smuggling beyond normal characters.
pub fn validate_api_path(path: &str) -> Result<(), String> {
    if !path.starts_with('/') {
        return Err("path must start with /".into());
    }
    if path.contains("..") || path.contains("://") || path.starts_with("//") {
        return Err("invalid path".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_https_and_loopback_http() {
        assert!(validate_base_url("https://chat.liams.dev").is_ok());
        assert!(validate_base_url("http://localhost:3000").is_ok());
        assert!(validate_base_url("http://127.0.0.1:3000").is_ok());
    }

    #[test]
    fn rejects_remote_http_and_paths_and_schemes() {
        assert!(validate_base_url("http://evil.example").is_err());
        assert!(validate_base_url("https://chat.liams.dev/steal").is_err());
        assert!(validate_base_url("file:///etc/passwd").is_err());
    }

    #[test]
    fn path_validation() {
        assert!(validate_api_path("/chat").is_ok());
        assert!(validate_api_path("/v1/changes?after=0&limit=500").is_ok());
        assert!(validate_api_path("chat").is_err());
        assert!(validate_api_path("//evil.example/x").is_err());
        assert!(validate_api_path("/../secrets").is_err());
    }
}
