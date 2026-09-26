//! Publishing API docs: write a generated site into a folder the user picked, and open a
//! print-ready page in the system browser (Save as PDF).
//!
//! A published folder carries `.localpost-docs.json`, the list of files Localpost wrote there.
//! Re-publishing only removes files from that list, so anything else in the folder is safe.

use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

const MANIFEST: &str = ".localpost-docs.json";

#[derive(Deserialize)]
pub struct DocFile {
    pub path: String,
    pub content: String,
}

#[derive(Serialize, Deserialize, Default)]
struct Manifest {
    files: BTreeSet<String>,
}

#[derive(Serialize, Default, Debug, PartialEq)]
pub struct PublishReport {
    pub written: usize,
    pub unchanged: usize,
    pub removed: usize,
}

fn safe_join(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let p = Path::new(rel);
    if rel.is_empty() || p.is_absolute() || p.components().any(|c| !matches!(c, Component::Normal(_))) || rel == MANIFEST {
        return Err(format!("Unsafe file name in docs output: {rel}"));
    }
    Ok(root.join(p))
}

/// Write `files` under `root`. Fails with `NOT_EMPTY` when the folder has other content and was
/// never published to, unless `force`.
pub fn write_site(root: &Path, files: &[DocFile], force: bool) -> Result<PublishReport, String> {
    std::fs::create_dir_all(root).map_err(|e| format!("Could not create {}: {e}", root.display()))?;
    let manifest_path = root.join(MANIFEST);
    let previous: Manifest = std::fs::read_to_string(&manifest_path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    let has_manifest = manifest_path.is_file();
    if !has_manifest && !force {
        let other = std::fs::read_dir(root).map_err(|e| e.to_string())?.flatten().any(|e| !e.file_name().to_string_lossy().starts_with('.'));
        if other {
            return Err("NOT_EMPTY".into());
        }
    }
    let mut report = PublishReport::default();
    let mut now = BTreeSet::new();
    for f in files {
        let path = safe_join(root, &f.path)?;
        now.insert(f.path.clone());
        if std::fs::read(&path).ok().as_deref() == Some(f.content.as_bytes()) {
            report.unchanged += 1;
            continue;
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let tmp = path.with_extension("lp-tmp");
        std::fs::write(&tmp, &f.content).map_err(|e| format!("Could not write {}: {e}", path.display()))?;
        std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
        report.written += 1;
    }
    for old in previous.files.difference(&now) {
        if let Ok(path) = safe_join(root, old) {
            if path.is_file() && std::fs::remove_file(&path).is_ok() {
                report.removed += 1;
                // Drop directories this left empty (never the root).
                let mut dir = path.parent().map(Path::to_path_buf);
                while let Some(d) = dir {
                    if d == root || std::fs::remove_dir(&d).is_err() {
                        break;
                    }
                    dir = d.parent().map(Path::to_path_buf);
                }
            }
        }
    }
    let json = serde_json::to_string_pretty(&Manifest { files: now }).map_err(|e| e.to_string())?;
    std::fs::write(&manifest_path, json).map_err(|e| e.to_string())?;
    Ok(report)
}

#[tauri::command]
pub fn docs_write(root: String, files: Vec<DocFile>, force: bool) -> Result<PublishReport, String> {
    write_site(Path::new(&root), &files, force)
}

/// Write a single HTML page to the temp folder and open it in the default browser.
#[tauri::command]
pub fn docs_open_page(app: AppHandle, name: String, content: String) -> Result<String, String> {
    let dir = std::env::temp_dir().join("localpost-docs");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let safe: String = name.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' }).collect();
    let path = dir.join(format!("{}.html", if safe.is_empty() { "docs".into() } else { safe }));
    std::fs::write(&path, content).map_err(|e| e.to_string())?;
    let p = path.to_string_lossy().into_owned();
    app.opener().open_path(p.clone(), None::<&str>).map_err(|e| format!("Could not open the browser: {e}"))?;
    Ok(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(path: &str, content: &str) -> DocFile {
        DocFile { path: path.into(), content: content.into() }
    }

    #[test]
    fn publishes_updates_and_never_touches_foreign_files() {
        let root = std::env::temp_dir().join(format!("lp-docs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("README.md"), "mine").unwrap();

        // A non-empty folder that was never published to needs confirmation.
        assert_eq!(write_site(&root, &[f("index.html", "a")], false).unwrap_err(), "NOT_EMPTY");
        let r = write_site(&root, &[f("index.html", "a"), f("assets/docs.css", "c"), f("assets/old.js", "x")], true).unwrap();
        assert_eq!(r, PublishReport { written: 3, unchanged: 0, removed: 0 });

        // Second publish: no confirmation, unchanged files skipped, stale ones removed.
        let r = write_site(&root, &[f("index.html", "b"), f("assets/docs.css", "c")], false).unwrap();
        assert_eq!(r, PublishReport { written: 1, unchanged: 1, removed: 1 });
        assert!(!root.join("assets/old.js").exists());
        assert_eq!(std::fs::read_to_string(root.join("README.md")).unwrap(), "mine");

        assert!(write_site(&root, &[f("../escape.html", "x")], false).is_err());
        assert!(write_site(&root, &[f(MANIFEST, "x")], false).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
}
