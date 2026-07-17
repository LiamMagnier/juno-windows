//! Workspace grants: the user explicitly picks folders; each grant carries a
//! device-local permission mode. Grants persist in the app's config dir and
//! never sync — raw local paths stay on this machine.

use crate::error::CommandError;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGrant {
    pub id: String,
    pub path: String,
    pub name: String,
    pub permission_mode: PermissionMode,
    pub granted_at: String,
    pub last_opened_at: String,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub enum PermissionMode {
    ReadOnly,
    Ask,
    WorkspaceWrite,
    Full,
}

impl PermissionMode {
    pub fn allows_writes(self) -> bool {
        !matches!(self, PermissionMode::ReadOnly)
    }
}

#[derive(Default)]
pub struct WorkspaceState {
    grants: RwLock<HashMap<String, WorkspaceGrant>>,
    loaded: RwLock<bool>,
}

fn grants_file(app: &tauri::AppHandle) -> Result<PathBuf, CommandError> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| CommandError::new("config_dir_unavailable", e.to_string()))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| CommandError::new("config_dir_unavailable", e.to_string()))?;
    Ok(dir.join("workspace-grants.json"))
}

fn load_grants(app: &tauri::AppHandle, state: &WorkspaceState) -> Result<(), CommandError> {
    if *state.loaded.read() {
        return Ok(());
    }
    let file = grants_file(app)?;
    let grants: Vec<WorkspaceGrant> = match std::fs::read_to_string(&file) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    let mut map = state.grants.write();
    for grant in grants {
        map.insert(grant.id.clone(), grant);
    }
    *state.loaded.write() = true;
    Ok(())
}

fn save_grants(app: &tauri::AppHandle, state: &WorkspaceState) -> Result<(), CommandError> {
    let file = grants_file(app)?;
    let grants: Vec<WorkspaceGrant> = state.grants.read().values().cloned().collect();
    let json = serde_json::to_string_pretty(&grants)
        .map_err(|e| CommandError::new("serialize_failed", e.to_string()))?;
    std::fs::write(&file, json)
        .map_err(|e| CommandError::new("write_failed", e.to_string()))?;
    Ok(())
}

fn now_iso() -> String {
    // RFC3339 seconds precision from unix time (no chrono dependency).
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format_unix_iso(secs)
}

fn format_unix_iso(secs: u64) -> String {
    let days = secs / 86_400;
    let rem = secs % 86_400;
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // civil_from_days
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mth = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mth <= 2 { y + 1 } else { y };
    format!("{y:04}-{mth:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

/// Resolve a grant or fail. Central chokepoint for every code command.
pub fn grant(
    app: &tauri::AppHandle,
    id: &str,
) -> Result<WorkspaceGrant, CommandError> {
    let state = app.state::<WorkspaceState>();
    load_grants(app, &state)?;
    let found = state.grants.read().get(id).cloned();
    found.ok_or_else(|| {
        CommandError::new("workspace_not_granted", "This folder hasn't been granted.")
    })
}

pub fn grant_root(app: &tauri::AppHandle, id: &str) -> Result<(PathBuf, WorkspaceGrant), CommandError> {
    let g = grant(app, id)?;
    let root = super::dunce_canonicalize(std::path::Path::new(&g.path))?;
    Ok((root, g))
}

/// Opens the OS folder picker and records a grant for the chosen folder.
#[tauri::command]
pub async fn workspace_pick(app: tauri::AppHandle) -> Result<Option<WorkspaceGrant>, CommandError> {
    let picked = app
        .dialog()
        .file()
        .blocking_pick_folder();
    let Some(folder) = picked else { return Ok(None) };
    let path = folder
        .into_path()
        .map_err(|e| CommandError::new("invalid_folder", e.to_string()))?;
    let canonical = super::dunce_canonicalize(&path)?;

    // Refuse obviously dangerous roots: filesystem root, home root, and
    // system directories make "workspace-bounded" meaningless.
    if canonical.parent().is_none() {
        return Err(CommandError::new("root_too_broad", "Pick a project folder, not a drive root."));
    }
    if let Some(home) = dirs::home_dir() {
        if canonical == home {
            return Err(CommandError::new(
                "root_too_broad",
                "Pick a project folder inside your user folder, not the whole thing.",
            ));
        }
    }

    let state = app.state::<WorkspaceState>();
    load_grants(&app, &state)?;

    // Re-opening an already granted folder refreshes it instead of duplicating.
    let existing = state
        .grants
        .read()
        .values()
        .find(|g| g.path == canonical.to_string_lossy())
        .cloned();
    if let Some(mut g) = existing {
        g.last_opened_at = now_iso();
        state.grants.write().insert(g.id.clone(), g.clone());
        save_grants(&app, &state)?;
        return Ok(Some(g));
    }

    let name = canonical
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "workspace".into());
    let grant = WorkspaceGrant {
        id: uuid::Uuid::new_v4().to_string(),
        path: canonical.to_string_lossy().to_string(),
        name,
        permission_mode: PermissionMode::Ask,
        granted_at: now_iso(),
        last_opened_at: now_iso(),
    };
    state.grants.write().insert(grant.id.clone(), grant.clone());
    save_grants(&app, &state)?;
    Ok(Some(grant))
}

#[tauri::command]
pub fn workspace_list(app: tauri::AppHandle) -> Result<Vec<WorkspaceGrant>, CommandError> {
    let state = app.state::<WorkspaceState>();
    load_grants(&app, &state)?;
    let mut grants: Vec<WorkspaceGrant> = state.grants.read().values().cloned().collect();
    grants.sort_by(|a, b| b.last_opened_at.cmp(&a.last_opened_at));
    Ok(grants)
}

#[tauri::command]
pub fn workspace_set_mode(
    app: tauri::AppHandle,
    id: String,
    mode: PermissionMode,
) -> Result<(), CommandError> {
    let state = app.state::<WorkspaceState>();
    load_grants(&app, &state)?;
    {
        let mut grants = state.grants.write();
        let grant = grants
            .get_mut(&id)
            .ok_or_else(|| CommandError::new("workspace_not_granted", "Unknown workspace."))?;
        grant.permission_mode = mode;
    }
    save_grants(&app, &state)
}

#[tauri::command]
pub fn workspace_revoke(app: tauri::AppHandle, id: String) -> Result<(), CommandError> {
    let state = app.state::<WorkspaceState>();
    load_grants(&app, &state)?;
    state.grants.write().remove(&id);
    save_grants(&app, &state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_formatting() {
        assert_eq!(format_unix_iso(0), "1970-01-01T00:00:00Z");
        assert_eq!(format_unix_iso(86_400), "1970-01-02T00:00:00Z");
        // 2026-07-17T00:00:00Z = 20651 days
        assert_eq!(format_unix_iso(20_651 * 86_400), "2026-07-17T00:00:00Z");
    }
}
