//! Optional OS keychain storage for secret variables (macOS Keychain, Windows Credential Manager,
//! Secret Service on Linux). All secrets of a workspace live in one keychain item as a JSON map,
//! so the OS prompts at most once.

use tauri::State;

use crate::AppState;

const SERVICE: &str = "Localpost";

fn entry_for(dir: &std::path::Path) -> Result<keyring::Entry, String> {
    // One item per data folder, so separate workspaces don't overwrite each other.
    let account = format!("secrets:{}", dir.to_string_lossy());
    keyring::Entry::new(SERVICE, &account).map_err(|e| e.to_string())
}

fn entry(state: &AppState) -> Result<keyring::Entry, String> {
    entry_for(&state.data_dir())
}

/// Re-key a workspace's secrets after its folder moved (see migrate.rs). Best effort: when there
/// is nothing stored, or the keychain is unavailable, this does nothing.
pub fn move_entry(old: &std::path::Path, new: &std::path::Path) {
    let (Ok(from), Ok(to)) = (entry_for(old), entry_for(new)) else { return };
    let Ok(value) = from.get_password() else { return };
    if matches!(to.get_password(), Err(keyring::Error::NoEntry)) && to.set_password(&value).is_ok() {
        let _ = from.delete_credential();
    }
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
