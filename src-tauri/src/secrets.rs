//! Device-secret storage backed by the OS credential vault.
//!
//! Windows: Credential Manager (wincred). macOS (dev builds): Keychain.
//! Secrets never transit the frontend except through these explicit commands,
//! and only for the fixed allowlist of keys below — the webview cannot read
//! arbitrary vault entries.

use crate::error::CommandError;

const SERVICE: &str = "dev.liams.juno.windows";

/// Only these keys may be stored. Keeping the list closed means a compromised
/// webview cannot use this surface as a general vault reader/writer.
const ALLOWED_KEYS: &[&str] = &[
    "refresh-token",
    "installation-id",
    "workspace-grants",
];

fn entry_for(key: &str) -> Result<keyring::Entry, CommandError> {
    if !ALLOWED_KEYS.contains(&key) {
        return Err(CommandError::new(
            "secret_key_not_allowed",
            format!("secret key '{key}' is not in the allowlist"),
        ));
    }
    keyring::Entry::new(SERVICE, key)
        .map_err(|e| CommandError::new("secret_backend_unavailable", e.to_string()))
}

#[tauri::command]
pub fn secret_set(key: String, value: String) -> Result<(), CommandError> {
    entry_for(&key)?
        .set_password(&value)
        .map_err(|e| CommandError::new("secret_write_failed", e.to_string()))
}

#[tauri::command]
pub fn secret_get(key: String) -> Result<Option<String>, CommandError> {
    match entry_for(&key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(CommandError::new("secret_read_failed", e.to_string())),
    }
}

#[tauri::command]
pub fn secret_delete(key: String) -> Result<(), CommandError> {
    match entry_for(&key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(CommandError::new("secret_delete_failed", e.to_string())),
    }
}
