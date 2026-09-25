//! Everything is stored as plain JSON files in the local app data directory.
//! Nothing ever leaves the machine.

use std::io::BufReader;
use std::path::{Path, PathBuf};

use base64::Engine;
use cookie_store::CookieStore;
use serde::Serialize;
use tauri::State;

use crate::AppState;

fn store_path(dir: &Path, name: &str) -> Result<PathBuf, String> {
    let valid = !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !valid {
        return Err(format!("invalid store name: {name}"));
    }
    Ok(dir.join(format!("{name}.json")))
}

/// Write via a temp file + rename so a crash never leaves a half-written file.
fn atomic_write(path: &Path, content: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, content).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn store_read(state: State<'_, AppState>, name: String) -> Result<Option<String>, String> {
    let path = store_path(&state.data_dir(), &name)?;
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn store_write(state: State<'_, AppState>, name: String, content: String) -> Result<(), String> {
    let path = store_path(&state.data_dir(), &name)?;
    atomic_write(&path, content.as_bytes())
}

#[tauri::command]
pub fn get_data_dir(state: State<'_, AppState>) -> String {
    state.data_dir().to_string_lossy().into_owned()
}

#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(path, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_base64_file(path: String, content: String) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(content)
        .map_err(|e| e.to_string())?;
    std::fs::write(path, bytes).map_err(|e| e.to_string())
}

// ---------- cookies ----------

pub fn cookies_path(dir: &Path) -> PathBuf {
    dir.join("cookies.json")
}

pub fn load_cookies(dir: &Path) -> CookieStore {
    std::fs::File::open(cookies_path(dir))
        .ok()
        .and_then(|f| cookie_store::serde::json::load(BufReader::new(f)).ok())
        .unwrap_or_default()
}

pub fn save_cookies(state: &AppState) {
    let mut buf = Vec::new();
    let saved = {
        let store = state.jar.lock().unwrap();
        cookie_store::serde::json::save(&store, &mut buf).is_ok()
    };
    if saved {
        let _ = atomic_write(&cookies_path(&state.data_dir()), &buf);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CookieInfo {
    domain: String,
    path: String,
    name: String,
    value: String,
    expires: Option<String>,
    secure: bool,
    http_only: bool,
}

#[tauri::command]
pub fn list_cookies(state: State<'_, AppState>) -> Vec<CookieInfo> {
    let store = state.jar.lock().unwrap();
    store
        .iter_unexpired()
        .map(|c| CookieInfo {
            domain: String::from(&c.domain),
            path: String::from(&c.path),
            name: c.name().to_string(),
            value: c.value().to_string(),
            expires: match &c.expires {
                cookie_store::CookieExpiration::AtUtc(t) => Some(t.to_string()),
                cookie_store::CookieExpiration::SessionEnd => None,
            },
            secure: c.secure().unwrap_or(false),
            http_only: c.http_only().unwrap_or(false),
        })
        .collect()
}

#[tauri::command]
pub fn delete_cookie(state: State<'_, AppState>, domain: String, path: String, name: String) {
    state.jar.lock().unwrap().remove(&domain, &path, &name);
    save_cookies(&state);
}

#[tauri::command]
pub fn clear_cookies(state: State<'_, AppState>) {
    state.jar.lock().unwrap().clear();
    save_cookies(&state);
}

// ---------- user themes ----------

#[derive(Serialize)]
pub struct UserTheme {
    id: String,
    css: String,
    /// Contents of `<id>.json` (name, description, preview colours), if present.
    meta: Option<String>,
}

#[derive(Serialize)]
pub struct UserThemes {
    dir: String,
    themes: Vec<UserTheme>,
}

/// Themes the user dropped into `<app data>/themes`: every `<id>.css`, plus an optional `<id>.json`.
#[tauri::command]
pub fn list_user_themes(state: State<'_, AppState>) -> Result<UserThemes, String> {
    let dir = state.app_dir.join("themes");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut themes = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("css") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()).map(str::to_string) else { continue };
        // Ids end up in a CSS attribute selector, so keep them simple.
        if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            continue;
        }
        if entry.metadata().map(|m| m.len() > 1_000_000).unwrap_or(true) {
            continue;
        }
        let Ok(css) = std::fs::read_to_string(&path) else { continue };
        let meta = std::fs::read_to_string(path.with_extension("json")).ok();
        themes.push(UserTheme { id, css, meta });
    }
    themes.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(UserThemes { dir: dir.to_string_lossy().into_owned(), themes })
}

// ---------- folders (Bruno import, linked collections) ----------

#[derive(Serialize)]
pub struct DirFile {
    /// Relative to the folder, with `/` separators.
    pub path: String,
    pub content: String,
}

const SKIP_DIRS: &[&str] = &[".git", "node_modules", ".DS_Store", "target", ".idea", ".vscode"];

/// Read the text files under `root` whose extension is in `extensions` (at most 5,000 files, 5 MB each).
pub fn read_dir_files_at(root: &Path, extensions: &[String]) -> Result<Vec<DirFile>, String> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = std::fs::read_dir(&dir).map_err(|e| format!("Could not read {}: {e}", dir.display()))?;
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                if !SKIP_DIRS.contains(&name.as_str()) {
                    stack.push(path);
                }
                continue;
            }
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
            if !extensions.iter().any(|x| x.eq_ignore_ascii_case(&ext)) || meta.len() > 5 * 1024 * 1024 {
                continue;
            }
            if out.len() >= 5000 {
                return Err("Too many files (more than 5,000)".into());
            }
            let Ok(content) = std::fs::read_to_string(&path) else { continue };
            let rel = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().replace('\\', "/");
            out.push(DirFile { path: rel, content });
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

#[tauri::command]
pub fn read_dir_files(path: String, extensions: Vec<String>) -> Result<Vec<DirFile>, String> {
    read_dir_files_at(Path::new(&path), &extensions)
}
