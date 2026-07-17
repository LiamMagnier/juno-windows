//! JSON request proxying. Bodies are passed as pre-serialized strings so
//! retried mutations stay byte-identical (the server's idempotency hash
//! covers the exact body).

use super::auth::access_token;
use super::NetState;
use crate::error::CommandError;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiResponse {
    pub status: u16,
    pub body: String,
}

fn method_from(name: &str) -> Result<reqwest::Method, CommandError> {
    match name {
        "GET" => Ok(reqwest::Method::GET),
        "POST" => Ok(reqwest::Method::POST),
        "PATCH" => Ok(reqwest::Method::PATCH),
        "PUT" => Ok(reqwest::Method::PUT),
        "DELETE" => Ok(reqwest::Method::DELETE),
        other => Err(CommandError::new(
            "invalid_method",
            format!("unsupported method {other}"),
        )),
    }
}

async fn send_once(
    app: &tauri::AppHandle,
    state: &NetState,
    method: &reqwest::Method,
    path: &str,
    body_json: Option<&str>,
    force_refresh: bool,
    timeout_ms: u64,
) -> Result<reqwest::Response, CommandError> {
    let token = access_token(app, state, force_refresh).await?;
    let mut req = state
        .client
        .request(method.clone(), state.api_url(path))
        .bearer_auth(token)
        .timeout(std::time::Duration::from_millis(timeout_ms));
    if let Some(body) = body_json {
        req = req
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body.to_string());
    }
    req.send().await.map_err(|e| {
        if e.is_timeout() {
            CommandError::new("timeout", "The request timed out.")
        } else {
            CommandError::new("network_error", e.without_url().to_string())
        }
    })
}

/// Proxy a JSON API call. Returns status + raw body; the frontend owns
/// interpretation (including error envelopes). 401 gets one forced token
/// rotation + retry.
#[tauri::command]
pub async fn api_request(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, NetState>,
    method: String,
    path: String,
    body_json: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<ApiResponse, CommandError> {
    super::validate_api_path(&path).map_err(|e| CommandError::new("invalid_path", e))?;
    super::validate_quick_api_access(window.label(), &method, &path)
        .map_err(|e| CommandError::new("forbidden_api", e))?;
    if window.label() == "quick" && method == "GET" && body_json.is_some() {
        return Err(CommandError::new(
            "invalid_request_body",
            "Juno Quick GET requests cannot include a body.",
        ));
    }
    if window.label() == "quick"
        && body_json
            .as_ref()
            .is_some_and(|body| body.len() > 256 * 1024)
    {
        return Err(CommandError::new(
            "request_too_large",
            "That Juno Quick request is too large.",
        ));
    }
    let method = method_from(&method)?;
    let timeout = timeout_ms.unwrap_or(30_000).min(300_000);

    let mut res = send_once(
        &app,
        &state,
        &method,
        &path,
        body_json.as_deref(),
        false,
        timeout,
    )
    .await?;
    if res.status() == reqwest::StatusCode::UNAUTHORIZED {
        res = send_once(
            &app,
            &state,
            &method,
            &path,
            body_json.as_deref(),
            true,
            timeout,
        )
        .await?;
    }
    let status = res.status().as_u16();
    let body = res
        .text()
        .await
        .map_err(|e| CommandError::new("network_error", e.without_url().to_string()))?;
    if (200..300).contains(&status) && path == "/v1/auth/session" {
        if let Some(account_id) = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|value| {
                value
                    .get("profile")?
                    .get("id")?
                    .as_str()
                    .map(str::to_string)
            })
        {
            crate::quick::bind_authenticated_account(&app, &account_id);
        }
    }
    Ok(ApiResponse { status, body })
}
