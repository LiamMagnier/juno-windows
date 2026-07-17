//! Attachment uploads: multipart POST /api/upload from the Rust side.
//! Path-based uploads stream from disk without loading whole files in memory.

use super::auth::access_token;
use super::NetState;
use crate::error::CommandError;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadResponse {
    pub status: u16,
    pub body: String,
}

const MAX_UPLOAD_BYTES: u64 = 1024 * 1024 * 1024; // matches the server's largest plan cap
const MAX_QUICK_UPLOAD_BYTES: u64 = 25 * 1024 * 1024;

fn validate_upload_target(value: Option<&str>) -> Result<(), CommandError> {
    if value.is_some_and(|id| {
        id.is_empty()
            || id.len() > 128
            || !id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
    }) {
        Err(CommandError::new(
            "invalid_upload_target",
            "That upload target is invalid.",
        ))
    } else {
        Ok(())
    }
}

async fn do_upload(
    app: &tauri::AppHandle,
    state: &NetState,
    file_name: String,
    mime_type: String,
    bytes: Vec<u8>,
    conversation_id: Option<String>,
    project_id: Option<String>,
) -> Result<UploadResponse, CommandError> {
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(file_name)
        .mime_str(&mime_type)
        .map_err(|e| CommandError::new("invalid_mime", e.to_string()))?;
    let mut form = reqwest::multipart::Form::new().part("file", part);
    if let Some(id) = conversation_id {
        form = form.text("conversationId", id);
    }
    if let Some(id) = project_id {
        form = form.text("projectId", id);
    }

    let token = access_token(app, state, false).await?;
    let res = state
        .client
        .post(state.api_url("/upload"))
        .bearer_auth(token)
        .multipart(form)
        .timeout(std::time::Duration::from_secs(120))
        .send()
        .await
        .map_err(|e| CommandError::new("network_error", e.without_url().to_string()))?;
    let status = res.status().as_u16();
    let body = res
        .text()
        .await
        .map_err(|e| CommandError::new("network_error", e.without_url().to_string()))?;
    Ok(UploadResponse { status, body })
}

#[tauri::command]
pub async fn api_upload_path(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, NetState>,
    path: String,
    conversation_id: Option<String>,
    project_id: Option<String>,
) -> Result<UploadResponse, CommandError> {
    validate_upload_target(conversation_id.as_deref())?;
    validate_upload_target(project_id.as_deref())?;
    if window.label() != "main" {
        return Err(CommandError::new(
            "forbidden_path_upload",
            "Juno Quick cannot read files by local path.",
        ));
    }
    let path_buf = std::path::PathBuf::from(&path);
    let metadata = tokio::fs::metadata(&path_buf)
        .await
        .map_err(|_| CommandError::new("file_not_found", "That file could not be read."))?;
    if !metadata.is_file() {
        return Err(CommandError::new(
            "not_a_file",
            "Only files can be uploaded.",
        ));
    }
    if metadata.len() > MAX_UPLOAD_BYTES {
        return Err(CommandError::new(
            "file_too_large",
            "That file is too large.",
        ));
    }
    let file_name = path_buf
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    let mime_type = mime_guess::from_path(&path_buf)
        .first_or_octet_stream()
        .essence_str()
        .to_string();
    let bytes = tokio::fs::read(&path_buf)
        .await
        .map_err(|_| CommandError::new("file_read_failed", "That file could not be read."))?;
    do_upload(
        &app,
        &state,
        file_name,
        mime_type,
        bytes,
        conversation_id,
        project_id,
    )
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri IPC commands require a flat argument signature.
pub async fn api_upload_bytes(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, NetState>,
    file_name: String,
    mime_type: String,
    bytes: Vec<u8>,
    conversation_id: Option<String>,
    project_id: Option<String>,
) -> Result<UploadResponse, CommandError> {
    validate_upload_target(conversation_id.as_deref())?;
    validate_upload_target(project_id.as_deref())?;
    if window.label() != "main" && window.label() != "quick" {
        return Err(CommandError::new(
            "forbidden_window",
            "Uploads are not available from this window.",
        ));
    }
    if window.label() == "quick" && bytes.len() as u64 > MAX_QUICK_UPLOAD_BYTES {
        return Err(CommandError::new(
            "file_too_large",
            "Quick uploads are limited to 25 MB. Open Juno for larger files.",
        ));
    }
    if window.label() == "quick" {
        if file_name.is_empty()
            || file_name.len() > 160
            || file_name.contains(['/', '\\'])
            || file_name.chars().any(char::is_control)
        {
            return Err(CommandError::new(
                "invalid_file_name",
                "That attachment has an invalid file name.",
            ));
        }
        if mime_type.is_empty()
            || mime_type.len() > 100
            || mime_type.chars().any(char::is_control)
            || !quick_mime_allowed(&mime_type)
        {
            return Err(CommandError::new(
                "unsupported_file_type",
                "Juno Quick supports images, PDF, text, and code files.",
            ));
        }
    }
    if bytes.len() as u64 > MAX_UPLOAD_BYTES {
        return Err(CommandError::new(
            "file_too_large",
            "That file is too large.",
        ));
    }
    do_upload(
        &app,
        &state,
        file_name,
        mime_type,
        bytes,
        conversation_id,
        project_id,
    )
    .await
}

fn quick_mime_allowed(mime: &str) -> bool {
    matches!(
        mime,
        "image/png"
            | "image/jpeg"
            | "image/webp"
            | "image/gif"
            | "application/pdf"
            | "application/json"
            | "application/javascript"
            | "application/xml"
            | "application/x-yaml"
    ) || (mime.starts_with("text/")
        && !matches!(mime, "text/html" | "text/xml-external-parsed-entity"))
}

#[cfg(test)]
mod tests {
    use super::{quick_mime_allowed, validate_upload_target};

    #[test]
    fn quick_upload_mime_allowlist_blocks_active_content() {
        assert!(quick_mime_allowed("image/png"));
        assert!(quick_mime_allowed("application/pdf"));
        assert!(quick_mime_allowed("text/markdown"));
        assert!(!quick_mime_allowed("text/html"));
        assert!(!quick_mime_allowed("image/svg+xml"));
        assert!(!quick_mime_allowed("application/octet-stream"));
    }

    #[test]
    fn upload_targets_are_bounded_and_log_safe() {
        assert!(validate_upload_target(Some("clx-123_abc")).is_ok());
        assert!(validate_upload_target(None).is_ok());
        assert!(validate_upload_target(Some("../other-account")).is_err());
        assert!(validate_upload_target(Some(&"x".repeat(129))).is_err());
    }
}
