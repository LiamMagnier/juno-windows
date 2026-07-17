//! Command execution inside a workspace over a real PTY (ConPTY on Windows),
//! streaming output to the frontend. Commands are always confined to the
//! workspace root as cwd; read-only workspaces cannot run commands at all.
//! Kill is immediate and is part of the emergency Stop path.

use super::workspace::grant_root;
use crate::error::CommandError;
use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::ipc::Channel;
use tauri::Manager;

const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum RunEvent {
    // `Error` is part of the wire union the frontend matches on; Rust only
    // constructs it from the reader loop today via the other arms.
    Output {
        data: String,
    },
    Exit {
        code: i32,
        truncated: bool,
    },
    #[allow(dead_code)]
    Error {
        message: String,
    },
}

struct RunningCommand {
    killer: Box<dyn portable_pty::ChildKiller + Send + Sync>,
    writer: Box<dyn Write + Send>,
    session_id: String,
}

#[derive(Default)]
pub struct TerminalState {
    running: Mutex<HashMap<u64, RunningCommand>>,
    next_id: AtomicU64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunHandle {
    pub run_id: u64,
}

/// Spawn `command` in the platform shell at the workspace root (or a
/// contained subdirectory). Output streams over the channel; the run stays
/// registered until exit or kill.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn pty_run(
    app: tauri::AppHandle,
    workspace_id: String,
    session_id: String,
    command: String,
    subdir: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    on_event: Channel<RunEvent>,
) -> Result<RunHandle, CommandError> {
    let (root, grant) = grant_root(&app, &workspace_id)?;
    if !grant.permission_mode.allows_writes() {
        return Err(CommandError::new(
            "workspace_read_only",
            "Commands can't run in a read-only workspace.",
        ));
    }
    let cwd = match subdir.as_deref() {
        Some(sub) if !sub.is_empty() => super::resolve_in_root(&root, sub)?,
        _ => root.clone(),
    };
    if command.trim().is_empty() {
        return Err(CommandError::new("empty_command", "No command given."));
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.unwrap_or(32),
            cols: cols.unwrap_or(120),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| CommandError::new("pty_failed", e.to_string()))?;

    let mut builder = if cfg!(windows) {
        let mut b = CommandBuilder::new("powershell.exe");
        b.args(["-NoLogo", "-NoProfile", "-Command", &command]);
        b
    } else {
        let mut b = CommandBuilder::new("/bin/zsh");
        b.args(["-lc", &command]);
        b
    };
    builder.cwd(&cwd);
    // A quiet, CI-like environment: no interactive pagers.
    builder.env("GIT_PAGER", "cat");
    builder.env("PAGER", "cat");
    builder.env("CLICOLOR_FORCE", "1");

    let child = pair
        .slave
        .spawn_command(builder)
        .map_err(|e| CommandError::new("spawn_failed", e.to_string()))?;
    drop(pair.slave);

    let killer = child.clone_killer();
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| CommandError::new("pty_failed", e.to_string()))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| CommandError::new("pty_failed", e.to_string()))?;

    let state = app.state::<TerminalState>();
    let run_id = state.next_id.fetch_add(1, Ordering::SeqCst) + 1;
    state.running.lock().insert(
        run_id,
        RunningCommand {
            killer,
            writer,
            session_id,
        },
    );

    let app_handle = app.clone();
    let channel = on_event.clone();
    // Reader thread: PTY reads are blocking; a dedicated thread streams
    // output until EOF (child exit or kill).
    std::thread::spawn(move || {
        let mut child = child;
        let mut total = 0usize;
        let mut truncated = false;
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    total += n;
                    if total <= MAX_OUTPUT_BYTES {
                        let data = String::from_utf8_lossy(&buf[..n]).to_string();
                        if channel.send(RunEvent::Output { data }).is_err() {
                            break;
                        }
                    } else if !truncated {
                        truncated = true;
                        let _ = channel.send(RunEvent::Output {
                            data: "\r\n[output truncated]\r\n".into(),
                        });
                    }
                }
                Err(_) => break,
            }
        }
        let code = child
            .wait()
            .map(|status| status.exit_code() as i32)
            .unwrap_or(-1);
        // The master must outlive reads; drop it now.
        drop(pair.master);
        let _ = channel.send(RunEvent::Exit { code, truncated });
        if let Some(state) = app_handle.try_state::<TerminalState>() {
            state.running.lock().remove(&run_id);
        }
    });

    Ok(RunHandle { run_id })
}

/// Write to a running command's stdin (interactive prompts).
#[tauri::command]
pub fn pty_write(app: tauri::AppHandle, run_id: u64, data: String) -> Result<(), CommandError> {
    let state = app.state::<TerminalState>();
    let mut running = state.running.lock();
    let run = running
        .get_mut(&run_id)
        .ok_or_else(|| CommandError::new("not_running", "That command is not running."))?;
    run.writer
        .write_all(data.as_bytes())
        .map_err(|e| CommandError::new("write_failed", e.to_string()))?;
    run.writer.flush().ok();
    Ok(())
}

#[tauri::command]
pub fn pty_kill(app: tauri::AppHandle, run_id: u64) -> Result<(), CommandError> {
    let state = app.state::<TerminalState>();
    let mut running = state.running.lock();
    if let Some(run) = running.get_mut(&run_id) {
        let _ = run.killer.kill();
        running.remove(&run_id);
    }
    Ok(())
}

/// Emergency stop: kill every command belonging to a session.
#[tauri::command]
pub fn pty_kill_session(app: tauri::AppHandle, session_id: String) -> Result<u32, CommandError> {
    let state = app.state::<TerminalState>();
    let mut running = state.running.lock();
    let ids: Vec<u64> = running
        .iter()
        .filter(|(_, run)| run.session_id == session_id)
        .map(|(id, _)| *id)
        .collect();
    let mut killed = 0;
    for id in ids {
        if let Some(run) = running.get_mut(&id) {
            let _ = run.killer.kill();
            running.remove(&id);
            killed += 1;
        }
    }
    Ok(killed)
}
