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
    app: tauri::AppHandle,
    state: tauri::State<'_, NetState>,
    path: String,
    conversation_id: Option<String>,
    project_id: Option<String>,
) -> Result<UploadResponse, CommandError> {
    let path_buf = std::path::PathBuf::from(&path);
    let metadata = tokio::fs::metadata(&path_buf)
        .await
        .map_err(|_| CommandError::new("file_not_found", "That file could not be read."))?;
    if !metadata.is_file() {
        return Err(CommandError::new("not_a_file", "Only files can be uploaded."));
    }
    if metadata.len() > MAX_UPLOAD_BYTES {
        return Err(CommandError::new("file_too_large", "That file is too large."));
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
    do_upload(&app, &state, file_name, mime_type, bytes, conversation_id, project_id).await
}

#[tauri::command]
pub async fn api_upload_bytes(
    app: tauri::AppHandle,
    state: tauri::State<'_, NetState>,
    file_name: String,
    mime_type: String,
    bytes: Vec<u8>,
    conversation_id: Option<String>,
    project_id: Option<String>,
) -> Result<UploadResponse, CommandError> {
    if bytes.len() as u64 > MAX_UPLOAD_BYTES {
        return Err(CommandError::new("file_too_large", "That file is too large."));
    }
    do_upload(&app, &state, file_name, mime_type, bytes, conversation_id, project_id).await
}
