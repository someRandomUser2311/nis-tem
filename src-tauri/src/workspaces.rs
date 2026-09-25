//! Workspaces: separate data folders (collections, environments, history, cookies, …) with a
//! switcher. The registry lives in `<app data>/workspaces.json`; the default workspace is
//! `<app data>/data`, and any folder (e.g. inside a synced drive or a git repo) can be opened.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::AppState;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub path: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Registry {
    pub active: String,
    pub workspaces: Vec<Workspace>,
}

fn registry_path(app_dir: &Path) -> PathBuf {
    app_dir.join("workspaces.json")
}

fn default_registry(app_dir: &Path) -> Registry {
    Registry {
        active: "default".into(),
        workspaces: vec![Workspace { id: "default".into(), name: "My Workspace".into(), path: app_dir.join("data").to_string_lossy().into_owned() }],
    }
}

pub fn load(app_dir: &Path) -> Registry {
    let mut r = std::fs::read_to_string(registry_path(app_dir))
        .ok()
        .and_then(|s| serde_json::from_str::<Registry>(&s).ok())
        .unwrap_or_else(|| default_registry(app_dir));
    if !r.workspaces.iter().any(|w| w.id == "default") {
        r.workspaces.insert(0, default_registry(app_dir).workspaces.remove(0));
    }
    if !r.workspaces.iter().any(|w| w.id == r.active) {
        r.active = "default".into();
    }
    r
}

fn save(app_dir: &Path, r: &Registry) -> Result<(), String> {
    std::fs::create_dir_all(app_dir).map_err(|e| e.to_string())?;
    let tmp = registry_path(app_dir).with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(r).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(tmp, registry_path(app_dir)).map_err(|e| e.to_string())
}

/// Folder of the active workspace (falls back to the default one if it went missing).
pub fn active_dir(app_dir: &Path) -> PathBuf {
    let r = load(app_dir);
    let w = r.workspaces.iter().find(|w| w.id == r.active).cloned().unwrap_or_else(|| default_registry(app_dir).workspaces.remove(0));
    let p = PathBuf::from(&w.path);
    if w.id != "default" && !p.is_dir() {
        return app_dir.join("data");
    }
    p
}

fn slug(name: &str) -> String {
    let s: String = name.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' }).collect();
    let s = s.trim_matches('-').to_string();
    if s.is_empty() { "workspace".into() } else { s }
}

#[tauri::command]
pub fn workspace_list(state: State<'_, AppState>) -> Registry {
    load(&state.app_dir)
}

/// Create a workspace. Without `path` it gets a fresh folder under the app data dir; with a path,
/// that folder (existing data or empty) becomes the workspace.
#[tauri::command]
pub fn workspace_create(state: State<'_, AppState>, name: String, path: Option<String>) -> Result<Workspace, String> {
    let mut r = load(&state.app_dir);
    let dir = match path.filter(|p| !p.trim().is_empty()) {
        Some(p) => PathBuf::from(p),
        None => {
            let base = state.app_dir.join("workspaces");
            let mut dir = base.join(slug(&name));
            let mut n = 2;
            while dir.exists() {
                dir = base.join(format!("{}-{n}", slug(&name)));
                n += 1;
            }
            dir
        }
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    let path = dir.to_string_lossy().into_owned();
    if let Some(existing) = r.workspaces.iter().find(|w| w.path == path) {
        return Ok(existing.clone());
    }
    let id = format!("ws-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0));
    let w = Workspace { id, name: if name.trim().is_empty() { "Workspace".into() } else { name.trim().into() }, path };
    r.workspaces.push(w.clone());
    save(&state.app_dir, &r)?;
    Ok(w)
}

/// Make `id` the active workspace. The UI reloads afterwards so every store is re-read.
#[tauri::command]
pub fn workspace_switch(state: State<'_, AppState>, id: String) -> Result<String, String> {
    let mut r = load(&state.app_dir);
    let w = r.workspaces.iter().find(|w| w.id == id).cloned().ok_or("Unknown workspace")?;
    let dir = PathBuf::from(&w.path);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Workspace folder is not available: {e}"))?;
    r.active = id;
    save(&state.app_dir, &r)?;
    state.set_data_dir(dir);
    Ok(w.path)
}

#[tauri::command]
pub fn workspace_rename(state: State<'_, AppState>, id: String, name: String) -> Result<(), String> {
    let mut r = load(&state.app_dir);
    let w = r.workspaces.iter_mut().find(|w| w.id == id).ok_or("Unknown workspace")?;
    w.name = name.trim().to_string();
    save(&state.app_dir, &r)
}

/// Remove a workspace from the list. Its files are left on disk.
#[tauri::command]
pub fn workspace_remove(state: State<'_, AppState>, id: String) -> Result<(), String> {
    if id == "default" {
        return Err("The default workspace can't be removed".into());
    }
    let mut r = load(&state.app_dir);
    if r.active == id {
        return Err("Switch to another workspace before removing this one".into());
    }
    r.workspaces.retain(|w| w.id != id);
    save(&state.app_dir, &r)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_defaults_and_recovery() {
        let dir = std::env::temp_dir().join(format!("lp-ws-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let r = load(&dir);
        assert_eq!(r.active, "default");
        assert_eq!(r.workspaces[0].path, dir.join("data").to_string_lossy());
        // An active workspace whose folder vanished falls back to the default folder.
        let gone = Registry { active: "x".into(), workspaces: vec![Workspace { id: "x".into(), name: "X".into(), path: dir.join("missing").to_string_lossy().into() }] };
        save(&dir, &gone).unwrap();
        let r = load(&dir);
        assert!(r.workspaces.iter().any(|w| w.id == "default"));
        assert_eq!(active_dir(&dir), dir.join("data"));
        assert!(!dir.join("missing").exists());
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(slug("My API: v2!"), "my-api--v2");
    }
}
