//! Git operations via the git CLI (porcelain formats), always at the
//! workspace root. Read operations work in any mode; commit requires a
//! writable grant. History rewrites are deliberately NOT exposed here.

use super::workspace::grant_root;
use crate::error::CommandError;
use serde::Serialize;
use std::path::Path;
use std::process::Command;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileStatus {
    pub path: String,
    pub staged: String,   // porcelain XY: X
    pub unstaged: String, // porcelain XY: Y
    pub renamed_from: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub available: bool,
    pub is_repo: bool,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<GitFileStatus>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLogEntry {
    pub hash: String,
    pub subject: String,
    pub author: String,
    pub date: String,
}

fn run_git(root: &Path, args: &[&str]) -> Result<(bool, String), CommandError> {
    let mut cmd = Command::new("git");
    cmd.current_dir(root)
        .args(args)
        .env("GIT_PAGER", "cat")
        .env("GIT_TERMINAL_PROMPT", "0");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let output = cmd.output().map_err(|_| {
        CommandError::new("git_unavailable", "Git isn't installed or isn't on PATH.")
    })?;
    let text = if output.status.success() {
        String::from_utf8_lossy(&output.stdout).to_string()
    } else {
        String::from_utf8_lossy(&output.stderr).to_string()
    };
    Ok((output.status.success(), text))
}

#[tauri::command]
pub fn git_status(app: tauri::AppHandle, workspace_id: String) -> Result<GitStatus, CommandError> {
    let (root, _) = grant_root(&app, &workspace_id)?;
    let probe = match run_git(&root, &["rev-parse", "--is-inside-work-tree"]) {
        Ok((ok, out)) => ok && out.trim() == "true",
        Err(_) => {
            return Ok(GitStatus {
                available: false,
                is_repo: false,
                branch: None,
                upstream: None,
                ahead: 0,
                behind: 0,
                files: vec![],
            })
        }
    };
    if !probe {
        return Ok(GitStatus {
            available: true,
            is_repo: false,
            branch: None,
            upstream: None,
            ahead: 0,
            behind: 0,
            files: vec![],
        });
    }
    let (_, out) = run_git(&root, &["status", "--porcelain=v2", "--branch"])?;
    let mut status = GitStatus {
        available: true,
        is_repo: true,
        branch: None,
        upstream: None,
        ahead: 0,
        behind: 0,
        files: vec![],
    };
    for line in out.lines() {
        if let Some(rest) = line.strip_prefix("# branch.head ") {
            status.branch = Some(rest.trim().to_string());
        } else if let Some(rest) = line.strip_prefix("# branch.upstream ") {
            status.upstream = Some(rest.trim().to_string());
        } else if let Some(rest) = line.strip_prefix("# branch.ab ") {
            for part in rest.split_whitespace() {
                if let Some(n) = part.strip_prefix('+') {
                    status.ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = part.strip_prefix('-') {
                    status.behind = n.parse().unwrap_or(0);
                }
            }
        } else if line.starts_with("1 ") || line.starts_with("2 ") {
            let fields: Vec<&str> = line.splitn(9, ' ').collect();
            if fields.len() >= 9 {
                let xy = fields[1];
                let path_field = fields[8];
                let (path, renamed_from) = if line.starts_with("2 ") {
                    let mut parts = path_field.split('\t');
                    let new = parts.next().unwrap_or(path_field).to_string();
                    let old = parts.next().map(String::from);
                    (new, old)
                } else {
                    (path_field.to_string(), None)
                };
                status.files.push(GitFileStatus {
                    path,
                    staged: xy.chars().next().unwrap_or('.').to_string(),
                    unstaged: xy.chars().nth(1).unwrap_or('.').to_string(),
                    renamed_from,
                });
            }
        } else if let Some(rest) = line.strip_prefix("? ") {
            status.files.push(GitFileStatus {
                path: rest.to_string(),
                staged: "?".into(),
                unstaged: "?".into(),
                renamed_from: None,
            });
        }
    }
    Ok(status)
}

/// Unified diff. `path` limits to one file; `staged` diffs the index.
#[tauri::command]
pub fn git_diff(
    app: tauri::AppHandle,
    workspace_id: String,
    path: Option<String>,
    staged: Option<bool>,
) -> Result<String, CommandError> {
    let (root, _) = grant_root(&app, &workspace_id)?;
    let mut args: Vec<&str> = vec!["diff", "--no-color"];
    if staged.unwrap_or(false) {
        args.push("--cached");
    }
    let validated;
    if let Some(p) = path.as_deref() {
        super::resolve_in_root(&root, p)?;
        validated = p.to_string();
        args.push("--");
        args.push(&validated);
    }
    let (_, out) = run_git(&root, &args)?;
    Ok(out.chars().take(400_000).collect())
}

#[tauri::command]
pub fn git_log(
    app: tauri::AppHandle,
    workspace_id: String,
    limit: Option<u32>,
) -> Result<Vec<GitLogEntry>, CommandError> {
    let (root, _) = grant_root(&app, &workspace_id)?;
    let n = limit.unwrap_or(20).min(100).to_string();
    let (ok, out) = run_git(
        &root,
        &[
            "log",
            &format!("-{n}"),
            "--pretty=format:%h%x1f%s%x1f%an%x1f%aI",
        ],
    )?;
    if !ok {
        return Ok(vec![]);
    }
    Ok(out
        .lines()
        .filter_map(|line| {
            let mut parts = line.split('\u{1f}');
            Some(GitLogEntry {
                hash: parts.next()?.to_string(),
                subject: parts.next()?.to_string(),
                author: parts.next()?.to_string(),
                date: parts.next()?.to_string(),
            })
        })
        .collect())
}

/// Stage the given paths (or everything) and commit. No push, no rewrite.
#[tauri::command]
pub fn git_commit(
    app: tauri::AppHandle,
    workspace_id: String,
    message: String,
    paths: Option<Vec<String>>,
) -> Result<String, CommandError> {
    let (root, grant) = grant_root(&app, &workspace_id)?;
    if !grant.permission_mode.allows_writes() {
        return Err(CommandError::new(
            "workspace_read_only",
            "This workspace is read-only.",
        ));
    }
    let message = message.trim();
    if message.is_empty() || message.len() > 5_000 {
        return Err(CommandError::new(
            "invalid_message",
            "Provide a commit message.",
        ));
    }
    match paths {
        Some(list) if !list.is_empty() => {
            let mut args: Vec<String> = vec!["add".into(), "--".into()];
            for p in &list {
                super::resolve_in_root(&root, p)?;
                args.push(p.clone());
            }
            let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
            let (ok, out) = run_git(&root, &arg_refs)?;
            if !ok {
                return Err(CommandError::new(
                    "git_add_failed",
                    out.chars().take(500).collect::<String>(),
                ));
            }
        }
        _ => {
            let (ok, out) = run_git(&root, &["add", "-A"])?;
            if !ok {
                return Err(CommandError::new(
                    "git_add_failed",
                    out.chars().take(500).collect::<String>(),
                ));
            }
        }
    }
    let (ok, out) = run_git(&root, &["commit", "-m", message])?;
    if !ok {
        return Err(CommandError::new(
            "git_commit_failed",
            out.chars().take(500).collect::<String>(),
        ));
    }
    Ok(out)
}
