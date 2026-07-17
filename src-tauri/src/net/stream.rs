//! Streaming (SSE) proxying over a Tauri channel. The frontend receives raw
//! text chunks and reassembles frames; cancellation is explicit by id and
//! aborts the underlying connection immediately (the emergency Stop path).

use super::auth::access_token;
use super::NetState;
use crate::error::CommandError;
use futures_util::StreamExt;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::Manager;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum StreamEvent {
    /// HTTP status + whether body streaming begins (non-2xx bodies are
    /// delivered whole in `error.body`).
    Started {
        status: u16,
    },
    Chunk {
        data: String,
    },
    End,
    Error {
        message: String,
        status: u16,
        body: String,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamHandle {
    pub stream_id: u64,
}

#[tauri::command]
pub async fn api_stream(
    app: tauri::AppHandle,
    state: tauri::State<'_, NetState>,
    path: String,
    body_json: String,
    on_event: Channel<StreamEvent>,
) -> Result<StreamHandle, CommandError> {
    super::validate_api_path(&path).map_err(|e| CommandError::new("invalid_path", e))?;

    let stream_id = {
        let mut next = state.next_stream_id.lock().unwrap();
        let id = *next;
        *next += 1;
        id
    };
    let cancel = CancellationToken::new();
    state
        .streams
        .lock()
        .unwrap()
        .insert(stream_id, cancel.clone());

    let url = state.api_url(&path);
    let client = state.client.clone();

    // Resolve the bearer before spawning so auth failures surface as a
    // command error rather than a channel event.
    let token = match access_token(&app, &state, false).await {
        Ok(t) => t,
        Err(e) => {
            state.streams.lock().unwrap().remove(&stream_id);
            return Err(e);
        }
    };

    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = run_stream(client, url, token, body_json, on_event.clone(), cancel).await;
        if let Err(message) = result {
            let _ = on_event.send(StreamEvent::Error {
                message,
                status: 0,
                body: String::new(),
            });
        }
        // Drop the registry entry when finished.
        if let Some(state) = app_handle.try_state::<NetState>() {
            state.streams.lock().unwrap().remove(&stream_id);
        }
    });

    Ok(StreamHandle { stream_id })
}

async fn run_stream(
    client: reqwest::Client,
    url: String,
    token: String,
    body_json: String,
    on_event: Channel<StreamEvent>,
    cancel: CancellationToken,
) -> Result<(), String> {
    let request = client
        .post(&url)
        .bearer_auth(token)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::ACCEPT, "text/event-stream")
        // Generous overall timeout; the server pings every 15s.
        .timeout(std::time::Duration::from_secs(60 * 60))
        .body(body_json);

    let response = tokio::select! {
        r = request.send() => r.map_err(|e| e.without_url().to_string())?,
        _ = cancel.cancelled() => return Ok(()),
    };

    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        let body = response.text().await.unwrap_or_default();
        let _ = on_event.send(StreamEvent::Error {
            message: format!("HTTP {status}"),
            status,
            body: body.chars().take(4096).collect(),
        });
        return Ok(());
    }
    let _ = on_event.send(StreamEvent::Started { status });

    let mut stream = response.bytes_stream();
    // Network chunks can split multi-byte UTF-8 sequences; carry the
    // incomplete tail into the next chunk instead of lossy-replacing it.
    let mut pending: Vec<u8> = Vec::new();
    loop {
        tokio::select! {
            item = stream.next() => match item {
                Some(Ok(bytes)) => {
                    pending.extend_from_slice(&bytes);
                    let valid_len = match std::str::from_utf8(&pending) {
                        Ok(_) => pending.len(),
                        Err(e) => e.valid_up_to(),
                    };
                    if valid_len > 0 {
                        let data = String::from_utf8_lossy(&pending[..valid_len]).to_string();
                        pending.drain(..valid_len);
                        if on_event.send(StreamEvent::Chunk { data }).is_err() {
                            return Ok(()); // channel gone: frontend went away
                        }
                    }
                }
                Some(Err(e)) => return Err(e.without_url().to_string()),
                None => break,
            },
            _ = cancel.cancelled() => return Ok(()),
        }
    }
    if !pending.is_empty() {
        let data = String::from_utf8_lossy(&pending).to_string();
        let _ = on_event.send(StreamEvent::Chunk { data });
    }
    let _ = on_event.send(StreamEvent::End);
    Ok(())
}

/// Abort an in-flight stream. Dropping the connection also tells the server
/// nothing (generation is detached server-side) — callers pair this with
/// POST /api/chat/cancel.
#[tauri::command]
pub fn api_stream_cancel(state: tauri::State<'_, NetState>, stream_id: u64) {
    if let Some(token) = state.streams.lock().unwrap().remove(&stream_id) {
        token.cancel();
    }
}
