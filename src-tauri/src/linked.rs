//! Linked collections: a collection mirrored to a folder as one readable JSON file per request,
//! so it can live in git. The frontend decides the file layout (src/lib/linked.ts); this module
//! writes the tree — only files that changed, removing stale ones it owns — and watches the
//! folder so edits made outside Localpost (git pull, an editor) flow back in.

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use notify::{RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::AppState;

#[derive(Deserialize)]
pub struct TreeFile {
    /// Relative, `/`-separated.
    pub path: String,
    pub content: String,
}

/// Files Localpost manages inside a linked folder; anything else (README, .git, …) is left alone.
fn is_managed(rel: &str) -> bool {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    name == "collection.json" || name == "folder.json" || name.ends_with(".request.json")
}

/// Reject absolute paths and `..` so a crafted collection can't write outside the folder.
fn safe_join(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let p = Path::new(rel);
    if p.is_absolute() || p.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(format!("Unsafe path in linked collection: {rel}"));
    }
    Ok(root.join(p))
}

#[derive(Serialize, Default, Debug)]
pub struct WriteReport {
    pub written: usize,
    pub removed: usize,
}

pub fn write_tree(root: &Path, files: &[TreeFile]) -> Result<WriteReport, String> {
    std::fs::create_dir_all(root).map_err(|e| format!("Could not create {}: {e}", root.display()))?;
    let mut report = WriteReport::default();
    let mut keep = HashSet::new();
    for f in files {
        if !is_managed(&f.path) {
            return Err(format!("Unexpected file name in linked collection: {}", f.path));
        }
        let path = safe_join(root, &f.path)?;
        keep.insert(path.clone());
        if std::fs::read_to_string(&path).ok().as_deref() == Some(f.content.as_str()) {
            continue;
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, &f.content).map_err(|e| format!("Could not write {}: {e}", path.display()))?;
        std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
        report.written += 1;
    }
    // Remove managed files that are no longer part of the collection, then empty folders.
    let existing = crate::storage::read_dir_files_at(root, &["json".to_string()])?;
    for f in existing {
        let path = root.join(&f.path);
        if is_managed(&f.path) && !keep.contains(&path) {
            std::fs::remove_file(&path).map_err(|e| e.to_string())?;
            report.removed += 1;
        }
    }
    prune_empty_dirs(root, root);
    Ok(report)
}

fn prune_empty_dirs(root: &Path, dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() && !p.file_name().is_some_and(|n| n.to_string_lossy().starts_with('.')) {
            prune_empty_dirs(root, &p);
            if p != root && std::fs::read_dir(&p).map(|mut d| d.next().is_none()).unwrap_or(false) {
                let _ = std::fs::remove_dir(&p);
            }
        }
    }
}

#[tauri::command]
pub fn linked_write(root: String, files: Vec<TreeFile>) -> Result<WriteReport, String> {
    write_tree(Path::new(&root), &files)
}

#[derive(Serialize, Clone)]
pub struct FsChanged {
    pub root: String,
}

/// Watch a linked folder; changes to managed files emit `lp://fs-changed` (the UI debounces and
/// reloads, ignoring changes that match what it wrote itself).
#[tauri::command]
pub fn linked_watch(app: AppHandle, state: State<'_, AppState>, root: String) -> Result<(), String> {
    let mut watchers = state.watchers.lock().unwrap();
    if watchers.contains_key(&root) {
        return Ok(());
    }
    let r = root.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            let relevant = ev.paths.iter().any(|p| {
                let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                name == "collection.json" || name == "folder.json" || name.ends_with(".request.json") || p.is_dir()
            });
            if relevant {
                let _ = app.emit("lp://fs-changed", FsChanged { root: r.clone() });
            }
        }
    })
    .map_err(|e| e.to_string())?;
    watcher.watch(Path::new(&root), RecursiveMode::Recursive).map_err(|e| format!("Could not watch {root}: {e}"))?;
    watchers.insert(root, watcher);
    Ok(())
}

#[tauri::command]
pub fn linked_unwatch(state: State<'_, AppState>, root: String) {
    state.watchers.lock().unwrap().remove(&root);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_only_changes_and_removes_stale_managed_files() {
        let root = std::env::temp_dir().join(format!("lp-linked-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let f = |p: &str, c: &str| TreeFile { path: p.into(), content: c.into() };
        let r = write_tree(&root, &[f("collection.json", "{}"), f("users/folder.json", "{}"), f("users/get.request.json", "1"), f("a.request.json", "a")]).unwrap();
        assert_eq!((r.written, r.removed), (4, 0));
        std::fs::write(root.join("README.md"), "mine").unwrap();
        let r = write_tree(&root, &[f("collection.json", "{}"), f("a.request.json", "a2")]).unwrap();
        assert_eq!((r.written, r.removed), (1, 2));
        assert!(!root.join("users").exists(), "emptied folders are pruned");
        assert_eq!(std::fs::read_to_string(root.join("README.md")).unwrap(), "mine", "unmanaged files are left alone");
        assert!(write_tree(&root, &[f("../evil.request.json", "x")]).is_err());
        assert!(write_tree(&root, &[f("notes.txt", "x")]).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
}
