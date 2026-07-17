//! Code mode's privileged services: workspace grants, file access, search,
//! diffs, checkpoints, command execution, and git. Every command takes a
//! workspace id and is hard-bounded to that grant's root — the webview holds
//! ids, never ambient filesystem access.

pub mod checkpoints;
pub mod fs;
pub mod git;
pub mod search;
pub mod terminal;
pub mod workspace;

use crate::error::CommandError;
use std::path::{Component, Path, PathBuf};

/// Resolve `relative` inside `root`, refusing traversal and absolute paths.
/// The file may not exist yet (writes), so we canonicalize the nearest
/// existing ancestor and verify containment there — symlinked escape hatches
/// inside the tree resolve to their target and fail the check.
pub fn resolve_in_root(root: &Path, relative: &str) -> Result<PathBuf, CommandError> {
    let rel = Path::new(relative);
    if rel.is_absolute() {
        return Err(CommandError::new("path_escape", "Absolute paths are not allowed."));
    }
    for component in rel.components() {
        match component {
            Component::Normal(_) | Component::CurDir => {}
            _ => return Err(CommandError::new("path_escape", "Path traversal is not allowed.")),
        }
    }
    let joined = root.join(rel);

    // Find nearest existing ancestor to canonicalize.
    let mut probe: &Path = &joined;
    let mut suffix = PathBuf::new();
    let canonical_root = dunce_canonicalize(root)?;
    loop {
        match std::fs::canonicalize(probe) {
            Ok(canonical) => {
                let canonical = strip_verbatim(canonical);
                if !canonical.starts_with(&canonical_root) {
                    return Err(CommandError::new(
                        "path_escape",
                        "That path leaves the workspace.",
                    ));
                }
                let mut result = canonical;
                // Re-append the non-existent tail (already validated: normal
                // components only).
                for part in suffix.components().rev().collect::<Vec<_>>().into_iter().rev() {
                    result.push(part);
                }
                return Ok(result);
            }
            Err(_) => {
                let parent = probe.parent().ok_or_else(|| {
                    CommandError::new("path_escape", "That path leaves the workspace.")
                })?;
                let name = probe.file_name().ok_or_else(|| {
                    CommandError::new("path_escape", "Invalid path.")
                })?;
                suffix = Path::new(name).join(&suffix);
                probe = parent;
            }
        }
    }
}

/// Windows canonicalize returns \\?\ verbatim paths; strip for comparisons
/// and display.
pub fn strip_verbatim(path: PathBuf) -> PathBuf {
    let s = path.to_string_lossy();
    if let Some(stripped) = s.strip_prefix(r"\\?\") {
        PathBuf::from(stripped)
    } else {
        path
    }
}

pub fn dunce_canonicalize(path: &Path) -> Result<PathBuf, CommandError> {
    std::fs::canonicalize(path)
        .map(strip_verbatim)
        .map_err(|_| CommandError::new("not_found", "That folder no longer exists."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_inside_root() {
        let dir = std::env::temp_dir().join(format!("juno-test-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        let resolved = resolve_in_root(&dir, "sub/new-file.txt").unwrap();
        assert!(resolved.ends_with("sub/new-file.txt") || resolved.ends_with("sub\\new-file.txt"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_escapes() {
        let dir = std::env::temp_dir();
        assert!(resolve_in_root(&dir, "../outside").is_err());
        assert!(resolve_in_root(&dir, "/etc/passwd").is_err());
        assert!(resolve_in_root(&dir, "a/../../b").is_err());
        #[cfg(windows)]
        assert!(resolve_in_root(&dir, "C:\\Windows").is_err());
    }

    #[test]
    fn rejects_symlink_escape() {
        #[cfg(unix)]
        {
            let base = std::env::temp_dir().join(format!("juno-sym-{}", std::process::id()));
            let root = base.join("root");
            let outside = base.join("outside");
            std::fs::create_dir_all(&root).unwrap();
            std::fs::create_dir_all(&outside).unwrap();
            std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
            assert!(resolve_in_root(&root, "link/file.txt").is_err());
            std::fs::remove_dir_all(&base).ok();
        }
    }
}
