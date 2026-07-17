//! Per-session file checkpoints: snapshot before mutation, restore by turn.
//! Port of juno-app/core/src/checkpoints.ts onto the app-data directory.

use super::resolve_in_root;
use super::workspace::grant_root;
use crate::error::CommandError;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Manager;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SnapshotMeta {
    turn: u32,
    path: String, // workspace-relative
    file: String, // snapshot content file name; empty when the file did not exist
    existed: bool,
}

fn session_dir(app: &tauri::AppHandle, session_id: &str) -> Result<PathBuf, CommandError> {
    if session_id.is_empty()
        || !session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err(CommandError::new("invalid_session", "Invalid session id."));
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| CommandError::new("data_dir_unavailable", e.to_string()))?
        .join("checkpoints")
        .join(session_id);
    std::fs::create_dir_all(&dir)
        .map_err(|e| CommandError::new("data_dir_unavailable", e.to_string()))?;
    Ok(dir)
}

fn load_index(dir: &std::path::Path) -> Vec<SnapshotMeta> {
    std::fs::read_to_string(dir.join("index.json"))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_index(dir: &std::path::Path, index: &[SnapshotMeta]) -> Result<(), CommandError> {
    let json = serde_json::to_string(index)
        .map_err(|e| CommandError::new("serialize_failed", e.to_string()))?;
    std::fs::write(dir.join("index.json"), json)
        .map_err(|e| CommandError::new("write_failed", e.to_string()))
}

/// Snapshot a file before the agent mutates it. First snapshot per
/// (turn, path) wins — later writes in the same turn keep the original.
#[tauri::command]
pub fn ws_snapshot(
    app: tauri::AppHandle,
    workspace_id: String,
    session_id: String,
    turn: u32,
    path: String,
) -> Result<(), CommandError> {
    let (root, _) = grant_root(&app, &workspace_id)?;
    let absolute = resolve_in_root(&root, &path)?;
    let dir = session_dir(&app, &session_id)?;
    let mut index = load_index(&dir);
    if index.iter().any(|s| s.turn == turn && s.path == path) {
        return Ok(());
    }
    let existed = absolute.exists();
    let file = if existed {
        let name = format!("{}-{}", turn, index.len());
        std::fs::copy(&absolute, dir.join(&name))
            .map_err(|e| CommandError::new("snapshot_failed", e.to_string()))?;
        name
    } else {
        String::new()
    };
    index.push(SnapshotMeta {
        turn,
        path,
        file,
        existed,
    });
    save_index(&dir, &index)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    pub restored: Vec<String>,
}

/// Restore every file to its state BEFORE the given turn (inclusive of later
/// turns). Returns restored workspace-relative paths.
#[tauri::command]
pub fn ws_restore_to_before(
    app: tauri::AppHandle,
    workspace_id: String,
    session_id: String,
    turn: u32,
) -> Result<RestoreResult, CommandError> {
    let (root, grant) = grant_root(&app, &workspace_id)?;
    if !grant.permission_mode.allows_writes() {
        return Err(CommandError::new(
            "workspace_read_only",
            "This workspace is read-only.",
        ));
    }
    let dir = session_dir(&app, &session_id)?;
    let mut index = load_index(&dir);
    let mut restored = Vec::new();
    // Earliest snapshot per path is authoritative for "before turn N".
    let mut earliest: std::collections::HashMap<String, SnapshotMeta> = Default::default();
    for snap in index.iter().filter(|s| s.turn >= turn) {
        earliest
            .entry(snap.path.clone())
            .and_modify(|e| {
                if snap.turn < e.turn {
                    *e = snap.clone();
                }
            })
            .or_insert_with(|| snap.clone());
    }
    for (path, snap) in earliest {
        let absolute = resolve_in_root(&root, &path)?;
        if snap.existed {
            std::fs::copy(dir.join(&snap.file), &absolute)
                .map_err(|e| CommandError::new("restore_failed", e.to_string()))?;
        } else {
            std::fs::remove_file(&absolute).ok();
        }
        restored.push(path);
    }
    index.retain(|s| s.turn < turn);
    save_index(&dir, &index)?;
    Ok(RestoreResult { restored })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedPaths {
    pub turns: Vec<u32>,
    pub paths_by_turn: std::collections::HashMap<u32, Vec<String>>,
}

#[tauri::command]
pub fn ws_changed_paths(
    app: tauri::AppHandle,
    session_id: String,
) -> Result<ChangedPaths, CommandError> {
    let dir = session_dir(&app, &session_id)?;
    let index = load_index(&dir);
    let mut paths_by_turn: std::collections::HashMap<u32, Vec<String>> = Default::default();
    for snap in &index {
        paths_by_turn
            .entry(snap.turn)
            .or_default()
            .push(snap.path.clone());
    }
    let mut turns: Vec<u32> = paths_by_turn.keys().copied().collect();
    turns.sort_unstable();
    Ok(ChangedPaths {
        turns,
        paths_by_turn,
    })
}
