//! Optional OS keychain storage for secret variables (macOS Keychain, Windows Credential Manager,
//! Secret Service on Linux). All secrets of a workspace live in one keychain item as a JSON map,
//! so the OS prompts at most once.

use tauri::State;

use crate::AppState;

const SERVICE: &str = "Localpost";

fn entry(state: &AppState) -> Result<keyring::Entry, String> {
    // One item per data folder, so separate workspaces don't overwrite each other.
    let account = format!("secrets:{}", state.data_dir().to_string_lossy());
    keyring::Entry::new(SERVICE, &account).map_err(|e| e.to_string())
}

/// The stored JSON map (`{}` when nothing is stored yet).
#[tauri::command]
pub fn secrets_read(state: State<'_, AppState>) -> Result<String, String> {
    match entry(&state)?.get_password() {
        Ok(s) => Ok(s),
        Err(keyring::Error::NoEntry) => Ok("{}".into()),
        Err(e) => Err(format!("Keychain read failed: {e}")),
    }
}

#[tauri::command]
pub fn secrets_write(state: State<'_, AppState>, content: String) -> Result<(), String> {
    entry(&state)?.set_password(&content).map_err(|e| format!("Keychain write failed: {e}"))
}

#[tauri::command]
pub fn secrets_clear(state: State<'_, AppState>) -> Result<(), String> {
    match entry(&state)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Keychain delete failed: {e}")),
    }
}
