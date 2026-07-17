//! Workspace file access: gitignore-aware listing, capped reads, atomic
//! writes. Writes are refused at this layer when the grant is read-only —
//! defense in depth under the TS permission engine.

use super::resolve_in_root;
use super::workspace::grant_root;
use crate::error::CommandError;
use serde::Serialize;
use std::io::Write;
use std::path::Path;

const MAX_READ_BYTES: u64 = 2 * 1024 * 1024;
const MAX_LIST_ENTRIES: usize = 5_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    pub path: String, // workspace-relative, forward slashes
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub path: String,
    pub content: String,
    pub truncated: bool,
    pub binary: bool,
    pub size: u64,
}

fn relative_display(root: &Path, absolute: &Path) -> String {
    absolute
        .strip_prefix(root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| absolute.to_string_lossy().to_string())
}

/// Paths whose contents execute automatically (git hooks/config, workspace
/// permission rules). Writes here would let a no-prompt file edit become
/// arbitrary command execution, so they are refused at the Rust boundary —
/// no permission mode and no TS-layer bug can reach them.
fn is_protected_path(root: &Path, absolute: &Path) -> bool {
    let Ok(rel) = absolute.strip_prefix(root) else {
        return true;
    };
    let mut components = rel.components();
    match components
        .next()
        .map(|c| c.as_os_str().to_string_lossy().to_lowercase())
    {
        Some(first) => first == ".git" || first == ".juno",
        None => false,
    }
}

/// Recursive gitignore-aware listing (depth-capped by entry count).
#[tauri::command]
pub fn ws_list(
    app: tauri::AppHandle,
    workspace_id: String,
    subpath: Option<String>,
    max_depth: Option<usize>,
) -> Result<Vec<FsEntry>, CommandError> {
    let (root, _) = grant_root(&app, &workspace_id)?;
    let base = match subpath.as_deref() {
        Some(sub) if !sub.is_empty() => resolve_in_root(&root, sub)?,
        _ => root.clone(),
    };
    let mut walker = ignore::WalkBuilder::new(&base);
    walker
        .hidden(false)
        .git_ignore(true)
        .git_exclude(true)
        .git_global(false)
        .filter_entry(|entry| entry.file_name() != ".git");
    if let Some(depth) = max_depth {
        walker.max_depth(Some(depth));
    }
    let mut entries = Vec::new();
    for result in walker.build() {
        let Ok(entry) = result else { continue };
        if entry.depth() == 0 {
            continue;
        }
        let meta = entry.metadata().ok();
        entries.push(FsEntry {
            path: relative_display(&root, entry.path()),
            name: entry.file_name().to_string_lossy().to_string(),
            is_dir: entry.file_type().map(|t| t.is_dir()).unwrap_or(false),
            size: meta.map(|m| m.len()).unwrap_or(0),
        });
        if entries.len() >= MAX_LIST_ENTRIES {
            break;
        }
    }
    entries.sort_by(|a, b| {
        (b.is_dir, a.path.to_lowercase())
            .cmp(&(a.is_dir, b.path.to_lowercase()))
            .reverse()
    });
    Ok(entries)
}

#[tauri::command]
pub fn ws_read(
    app: tauri::AppHandle,
    workspace_id: String,
    path: String,
) -> Result<FileContent, CommandError> {
    let (root, _) = grant_root(&app, &workspace_id)?;
    let absolute = resolve_in_root(&root, &path)?;
    let meta = std::fs::metadata(&absolute)
        .map_err(|_| CommandError::new("not_found", format!("File not found: {path}")))?;
    if meta.is_dir() {
        return Err(CommandError::new(
            "is_directory",
            format!("{path} is a directory."),
        ));
    }
    let size = meta.len();
    let bytes = if size > MAX_READ_BYTES {
        let mut buf = vec![0u8; MAX_READ_BYTES as usize];
        use std::io::Read;
        let mut file = std::fs::File::open(&absolute)
            .map_err(|e| CommandError::new("read_failed", e.to_string()))?;
        let n = file
            .read(&mut buf)
            .map_err(|e| CommandError::new("read_failed", e.to_string()))?;
        buf.truncate(n);
        buf
    } else {
        std::fs::read(&absolute).map_err(|e| CommandError::new("read_failed", e.to_string()))?
    };
    let binary = bytes.iter().take(8_000).any(|&b| b == 0);
    let content = if binary {
        String::new()
    } else {
        String::from_utf8_lossy(&bytes).to_string()
    };
    Ok(FileContent {
        path,
        content,
        truncated: size > MAX_READ_BYTES,
        binary,
        size,
    })
}

/// Atomic write (temp file + rename). Creates parent directories.
#[tauri::command]
pub fn ws_write(
    app: tauri::AppHandle,
    workspace_id: String,
    path: String,
    content: String,
) -> Result<(), CommandError> {
    let (root, grant) = grant_root(&app, &workspace_id)?;
    if !grant.permission_mode.allows_writes() {
        return Err(CommandError::new(
            "workspace_read_only",
            "This workspace is read-only.",
        ));
    }
    let absolute = resolve_in_root(&root, &path)?;
    if is_protected_path(&root, &absolute) {
        return Err(CommandError::new(
            "path_protected",
            "Files under .git/ and .juno/ can't be modified by the agent.",
        ));
    }
    if let Some(parent) = absolute.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| CommandError::new("write_failed", e.to_string()))?;
    }
    let tmp = absolute.with_extension(format!(
        "{}.juno-tmp",
        absolute
            .extension()
            .map(|e| e.to_string_lossy().to_string())
            .unwrap_or_default()
    ));
    {
        let mut file = std::fs::File::create(&tmp)
            .map_err(|e| CommandError::new("write_failed", e.to_string()))?;
        file.write_all(content.as_bytes())
            .map_err(|e| CommandError::new("write_failed", e.to_string()))?;
        file.flush().ok();
    }
    std::fs::rename(&tmp, &absolute).map_err(|e| {
        std::fs::remove_file(&tmp).ok();
        CommandError::new("write_failed", e.to_string())
    })?;
    Ok(())
}

#[tauri::command]
pub fn ws_delete_file(
    app: tauri::AppHandle,
    workspace_id: String,
    path: String,
) -> Result<(), CommandError> {
    let (root, grant) = grant_root(&app, &workspace_id)?;
    if !grant.permission_mode.allows_writes() {
        return Err(CommandError::new(
            "workspace_read_only",
            "This workspace is read-only.",
        ));
    }
    let absolute = resolve_in_root(&root, &path)?;
    if is_protected_path(&root, &absolute) {
        return Err(CommandError::new(
            "path_protected",
            "Files under .git/ and .juno/ can't be modified by the agent.",
        ));
    }
    let meta = std::fs::metadata(&absolute)
        .map_err(|_| CommandError::new("not_found", format!("File not found: {path}")))?;
    if meta.is_dir() {
        return Err(CommandError::new(
            "is_directory",
            "Directories can't be deleted through this command.",
        ));
    }
    std::fs::remove_file(&absolute).map_err(|e| CommandError::new("delete_failed", e.to_string()))
}
