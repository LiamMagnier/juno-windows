//! Device-token lifecycle, fully in Rust: the rotating refresh token lives in
//! the OS vault and never crosses into the webview. Access tokens are held in
//! memory and injected into every proxied request.

use super::NetState;
use crate::error::CommandError;
use serde::{Deserialize, Serialize};
use tauri::Emitter;

const VAULT_SERVICE: &str = "dev.liams.juno.windows";
const VAULT_REFRESH_KEY: &str = "refresh-token";
/// Refresh this many ms before the server-declared expiry.
const SKEW_MS: i64 = 60_000;

pub const AUTH_REVOKED_EVENT: &str = "juno://auth-revoked";

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn vault_entry() -> Result<keyring::Entry, CommandError> {
    keyring::Entry::new(VAULT_SERVICE, VAULT_REFRESH_KEY)
        .map_err(|e| CommandError::new("secret_backend_unavailable", e.to_string()))
}

pub fn read_refresh_token() -> Result<Option<String>, CommandError> {
    match vault_entry()?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(CommandError::new("secret_read_failed", e.to_string())),
    }
}

fn write_refresh_token(value: &str) -> Result<(), CommandError> {
    vault_entry()?
        .set_password(value)
        .map_err(|e| CommandError::new("secret_write_failed", e.to_string()))
}

fn delete_refresh_token() {
    if let Ok(entry) = vault_entry() {
        let _ = entry.delete_credential();
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TokenPayload {
    access_token: String,
    access_token_expires_at: String,
    refresh_token: String,
    #[allow(dead_code)]
    #[serde(default)]
    refresh_token_expires_at: Option<String>,
    #[serde(default)]
    device_session: Option<serde_json::Value>,
}

fn parse_iso_ms(iso: &str) -> i64 {
    // Minimal ISO-8601 parse via chrono-free arithmetic: delegate to the
    // webview-independent approach of using the `time` in reqwest? Keep it
    // simple: fall back to now + 8 minutes when parsing fails.
    match iso.parse::<i64>() {
        Ok(ms) => ms,
        Err(_) => match parse_rfc3339_ms(iso) {
            Some(ms) => ms,
            None => now_ms() + 8 * 60 * 1000,
        },
    }
}

/// Parses "2026-07-17T12:34:56.789Z" (and offset-less variants) to unix ms.
fn parse_rfc3339_ms(s: &str) -> Option<i64> {
    let s = s.trim();
    let date = s.get(0..10)?;
    let mut parts = date.split('-');
    let year: i64 = parts.next()?.parse().ok()?;
    let month: i64 = parts.next()?.parse().ok()?;
    let day: i64 = parts.next()?.parse().ok()?;
    let time = s.get(11..19)?;
    let mut tparts = time.split(':');
    let hour: i64 = tparts.next()?.parse().ok()?;
    let minute: i64 = tparts.next()?.parse().ok()?;
    let second: i64 = tparts.next()?.parse().ok()?;
    let millis: i64 = s.get(20..23).and_then(|m| m.parse().ok()).unwrap_or(0);

    // Days since epoch (civil-from-days algorithm, Howard Hinnant).
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some((((days * 24 + hour) * 60 + minute) * 60 + second) * 1000 + millis)
}

async fn post_json(
    state: &NetState,
    path: &str,
    body: serde_json::Value,
) -> Result<(u16, String), CommandError> {
    let url = state.api_url(path);
    let res = state
        .client
        .post(url)
        .json(&body)
        .send()
        .await
        .map_err(|e| CommandError::new("network_error", redact(&e.to_string())))?;
    let status = res.status().as_u16();
    let text = res
        .text()
        .await
        .map_err(|e| CommandError::new("network_error", redact(&e.to_string())))?;
    Ok((status, text))
}

/// Error strings from reqwest can embed full URLs; tokens never appear in
/// URLs in this app, but keep messages terse anyway.
fn redact(message: &str) -> String {
    message.chars().take(300).collect()
}

fn adopt(state: &NetState, payload: &TokenPayload) -> Result<(), CommandError> {
    // Persist the rotated refresh token BEFORE exposing the new access token:
    // a crash between the two must never leave us with a spent token on disk.
    write_refresh_token(&payload.refresh_token)?;
    *state.access.write() = Some(super::AccessToken {
        token: payload.access_token.clone(),
        expires_at: parse_iso_ms(&payload.access_token_expires_at),
    });
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExchangeResult {
    pub device_session: Option<serde_json::Value>,
}

#[tauri::command]
pub async fn auth_configure(
    state: tauri::State<'_, NetState>,
    base_url: String,
) -> Result<(), CommandError> {
    let normalized = super::validate_base_url(&base_url)
        .map_err(|e| CommandError::new("invalid_base_url", e))?;
    *state.base_url.write() = normalized;
    // Environment switch invalidates any cached access token.
    *state.access.write() = None;
    Ok(())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn auth_exchange(
    state: tauri::State<'_, NetState>,
    code: String,
    code_verifier: String,
    redirect_uri: String,
    installation_id: String,
    device_name: String,
    platform: String,
    app_version: String,
) -> Result<ExchangeResult, CommandError> {
    let _guard = state.refresh_lock.lock().await;
    let (status, text) = post_json(
        &state,
        "/v1/auth/token",
        serde_json::json!({
            "code": code,
            "codeVerifier": code_verifier,
            "redirectUri": redirect_uri,
            "installationId": installation_id,
            "deviceName": device_name,
            "platform": platform,
            "appVersion": app_version,
        }),
    )
    .await?;
    if status != 200 {
        return Err(CommandError::new(
            "invalid_grant",
            extract_error_message(&text, "Sign-in was rejected by the server."),
        ));
    }
    let payload: TokenPayload = serde_json::from_str(&text)
        .map_err(|_| CommandError::new("invalid_response", "Malformed token response."))?;
    adopt(&state, &payload)?;
    Ok(ExchangeResult {
        device_session: payload.device_session,
    })
}

pub fn extract_error_message(body: &str, fallback: &str) -> String {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| {
            v.get("error").and_then(|e| {
                e.as_str()
                    .map(String::from)
                    .or_else(|| e.get("message").and_then(|m| m.as_str()).map(String::from))
            })
        })
        .unwrap_or_else(|| fallback.to_string())
}

/// Returns a valid access token, rotating the refresh token when needed.
/// Single-flight: the refresh_lock serializes rotations process-wide.
pub async fn access_token(
    app: &tauri::AppHandle,
    state: &NetState,
    force: bool,
) -> Result<String, CommandError> {
    if !force {
        if let Some(access) = state.access.read().as_ref() {
            if access.expires_at - now_ms() > SKEW_MS {
                return Ok(access.token.clone());
            }
        }
    }
    let _guard = state.refresh_lock.lock().await;
    // Re-check under the lock: another caller may have refreshed already.
    if !force {
        if let Some(access) = state.access.read().as_ref() {
            if access.expires_at - now_ms() > SKEW_MS {
                return Ok(access.token.clone());
            }
        }
    }
    let refresh_token = read_refresh_token()?
        .ok_or_else(|| CommandError::new("no_device_session", "Not signed in on this device."))?;
    let (status, text) = post_json(
        state,
        "/v1/auth/refresh",
        serde_json::json!({ "refreshToken": refresh_token }),
    )
    .await?;
    if status == 400 || status == 401 {
        // Invalid, expired, reused, or revoked: the device session is dead.
        delete_refresh_token();
        *state.access.write() = None;
        let _ = app.emit(AUTH_REVOKED_EVENT, ());
        return Err(CommandError::new(
            "device_revoked",
            "This device was signed out. Sign in again.",
        ));
    }
    if status != 200 {
        return Err(CommandError::new(
            "refresh_failed",
            extract_error_message(&text, "Couldn't refresh the session."),
        ));
    }
    let payload: TokenPayload = serde_json::from_str(&text)
        .map_err(|_| CommandError::new("invalid_response", "Malformed refresh response."))?;
    adopt(state, &payload)?;
    Ok(payload.access_token)
}

#[tauri::command]
pub fn auth_has_session() -> Result<bool, CommandError> {
    Ok(read_refresh_token()?.is_some())
}

#[tauri::command]
pub async fn auth_sign_out(
    app: tauri::AppHandle,
    state: tauri::State<'_, NetState>,
) -> Result<(), CommandError> {
    // Best-effort server-side revocation with whatever token we still have.
    if let Ok(token) = access_token(&app, &state, false).await {
        let url = state.api_url("/v1/auth/logout");
        let _ = state.client.post(url).bearer_auth(token).send().await;
    }
    delete_refresh_token();
    *state.access.write() = None;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_rfc3339() {
        assert_eq!(parse_rfc3339_ms("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(parse_rfc3339_ms("1970-01-02T00:00:00Z"), Some(86_400_000));
        // 2026-07-17T00:00:00Z
        // A known date: 2026-07-17 is 20651 days after the epoch.
        let ms = parse_rfc3339_ms("2026-07-17T00:00:00.000Z").unwrap();
        assert_eq!(ms, 20_651_i64 * 86_400_000);
    }

    #[test]
    fn extracts_error_messages() {
        assert_eq!(
            extract_error_message(r#"{"error":"Unauthorized"}"#, "x"),
            "Unauthorized"
        );
        assert_eq!(
            extract_error_message(
                r#"{"error":{"code":"invalid_grant","message":"Bad."}}"#,
                "x"
            ),
            "Bad."
        );
        assert_eq!(extract_error_message("not json", "fallback"), "fallback");
    }
}
