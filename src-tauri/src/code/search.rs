//! Regex content search over a workspace (ripgrep's engine: gitignore-aware,
//! capped results).

use super::workspace::grant_root;
use super::resolve_in_root;
use crate::error::CommandError;
use grep_regex::RegexMatcherBuilder;
use grep_searcher::sinks::UTF8;
use grep_searcher::{BinaryDetection, SearcherBuilder};
use serde::Serialize;

const MAX_MATCHES: usize = 500;
const MAX_LINE_CHARS: usize = 400;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub path: String,
    pub line: u64,
    pub text: String,
}

#[tauri::command]
pub fn ws_search(
    app: tauri::AppHandle,
    workspace_id: String,
    pattern: String,
    subpath: Option<String>,
    case_sensitive: Option<bool>,
    fixed_string: Option<bool>,
) -> Result<Vec<SearchMatch>, CommandError> {
    let (root, _) = grant_root(&app, &workspace_id)?;
    let base = match subpath.as_deref() {
        Some(sub) if !sub.is_empty() => resolve_in_root(&root, sub)?,
        _ => root.clone(),
    };

    let escaped;
    let pattern_ref = if fixed_string.unwrap_or(false) {
        escaped = regex_escape(&pattern);
        escaped.as_str()
    } else {
        pattern.as_str()
    };
    let matcher = RegexMatcherBuilder::new()
        .case_insensitive(!case_sensitive.unwrap_or(false))
        .line_terminator(Some(b'\n'))
        .build(pattern_ref)
        .map_err(|e| CommandError::new("invalid_pattern", e.to_string()))?;

    let mut searcher = SearcherBuilder::new()
        .binary_detection(BinaryDetection::quit(0))
        .line_number(true)
        .build();

    let mut matches: Vec<SearchMatch> = Vec::new();
    let walker = ignore::WalkBuilder::new(&base)
        .hidden(false)
        .git_ignore(true)
        .git_exclude(true)
        .git_global(false)
        .filter_entry(|entry| entry.file_name() != ".git")
        .build();

    'outer: for result in walker {
        let Ok(entry) = result else { continue };
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let path_display = entry
            .path()
            .strip_prefix(&root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| entry.path().to_string_lossy().to_string());
        let mut file_matches: Vec<SearchMatch> = Vec::new();
        let _ = searcher.search_path(
            &matcher,
            entry.path(),
            UTF8(|line_number, line| {
                let mut text = line.trim_end().to_string();
                if text.chars().count() > MAX_LINE_CHARS {
                    text = text.chars().take(MAX_LINE_CHARS).collect::<String>() + "…";
                }
                file_matches.push(SearchMatch {
                    path: path_display.clone(),
                    line: line_number,
                    text,
                });
                Ok(file_matches.len() < 50)
            }),
        );
        for m in file_matches {
            matches.push(m);
            if matches.len() >= MAX_MATCHES {
                break 'outer;
            }
        }
    }
    Ok(matches)
}

fn regex_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len() * 2);
    for c in text.chars() {
        if "\\.+*?()|[]{}^$#&-~".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}
