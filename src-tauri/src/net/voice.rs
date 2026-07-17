//! Realtime voice relay transport. One WebSocket per session, opened from
//! Rust so no browser Origin header is sent (the relay rejects unknown
//! Origins but accepts none at all). Text frames are the JSON control
//! protocol; binary frames are PCM16 audio (16 kHz up, 24 kHz down),
//! crossing the IPC as base64.

use crate::error::CommandError;
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::ipc::Channel;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

#[derive(Clone, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum VoiceEvent {
    Open,
    Text { data: String },
    Audio { base64: String },
    Closed { reason: String },
    Error { message: String },
}

enum Outbound {
    Text(String),
    Audio(Vec<u8>),
    Close,
}

#[derive(Default)]
pub struct VoiceState {
    connections: Mutex<HashMap<u64, mpsc::UnboundedSender<Outbound>>>,
    next_id: AtomicU64,
}

fn validate_relay_url(url: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| e.to_string())?;
    match parsed.scheme() {
        "wss" => Ok(()),
        "ws" => {
            let host = parsed.host_str().unwrap_or("");
            if host == "localhost" || host == "127.0.0.1" {
                Ok(())
            } else {
                Err("ws:// is only allowed for localhost".into())
            }
        }
        other => Err(format!("unsupported scheme: {other}")),
    }
}

#[tauri::command]
pub async fn voice_connect(
    state: tauri::State<'_, VoiceState>,
    url: String,
    on_event: Channel<VoiceEvent>,
) -> Result<u64, CommandError> {
    validate_relay_url(&url).map_err(|e| CommandError::new("invalid_relay_url", e))?;

    let (ws, _) = tokio_tungstenite::connect_async(&url)
        .await
        .map_err(|e| CommandError::new("relay_connect_failed", e.to_string()))?;
    let (mut sink, mut source) = ws.split();

    let conn_id = state.next_id.fetch_add(1, Ordering::SeqCst) + 1;
    let (tx, mut rx) = mpsc::unbounded_channel::<Outbound>();
    state.connections.lock().insert(conn_id, tx);
    let _ = on_event.send(VoiceEvent::Open);

    // Writer task
    tauri::async_runtime::spawn(async move {
        while let Some(msg) = rx.recv().await {
            let result = match msg {
                Outbound::Text(text) => sink.send(Message::text(text)).await,
                Outbound::Audio(bytes) => sink.send(Message::binary(bytes)).await,
                Outbound::Close => {
                    let _ = sink.send(Message::Close(None)).await;
                    break;
                }
            };
            if result.is_err() {
                break;
            }
        }
    });

    // Reader task
    let channel = on_event.clone();
    tauri::async_runtime::spawn(async move {
        let engine = base64::engine::general_purpose::STANDARD;
        while let Some(frame) = source.next().await {
            match frame {
                Ok(Message::Text(text)) => {
                    if channel
                        .send(VoiceEvent::Text {
                            data: text.to_string(),
                        })
                        .is_err()
                    {
                        break;
                    }
                }
                Ok(Message::Binary(bytes)) => {
                    let base64 = engine.encode(&bytes);
                    if channel.send(VoiceEvent::Audio { base64 }).is_err() {
                        break;
                    }
                }
                Ok(Message::Close(close)) => {
                    let reason = close.map(|c| c.reason.to_string()).unwrap_or_default();
                    let _ = channel.send(VoiceEvent::Closed { reason });
                    break;
                }
                Ok(_) => {}
                Err(e) => {
                    let _ = channel.send(VoiceEvent::Error {
                        message: e.to_string(),
                    });
                    break;
                }
            }
        }
        let _ = channel.send(VoiceEvent::Closed {
            reason: "eof".into(),
        });
    });

    Ok(conn_id)
}

#[tauri::command]
pub fn voice_send_text(
    state: tauri::State<'_, VoiceState>,
    conn_id: u64,
    data: String,
) -> Result<(), CommandError> {
    let connections = state.connections.lock();
    let tx = connections
        .get(&conn_id)
        .ok_or_else(|| CommandError::new("not_connected", "Voice session is not connected."))?;
    tx.send(Outbound::Text(data))
        .map_err(|_| CommandError::new("send_failed", "Voice session closed."))
}

#[tauri::command]
pub fn voice_send_audio(
    state: tauri::State<'_, VoiceState>,
    conn_id: u64,
    base64_data: String,
) -> Result<(), CommandError> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_data.as_bytes())
        .map_err(|_| CommandError::new("invalid_audio", "Bad audio payload."))?;
    let connections = state.connections.lock();
    let tx = connections
        .get(&conn_id)
        .ok_or_else(|| CommandError::new("not_connected", "Voice session is not connected."))?;
    tx.send(Outbound::Audio(bytes))
        .map_err(|_| CommandError::new("send_failed", "Voice session closed."))
}

#[tauri::command]
pub fn voice_close(state: tauri::State<'_, VoiceState>, conn_id: u64) {
    let mut connections = state.connections.lock();
    if let Some(tx) = connections.remove(&conn_id) {
        let _ = tx.send(Outbound::Close);
    }
}
