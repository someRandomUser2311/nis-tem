//! One-time move of the app data folder from the old bundle identifier (`dev.localpost.app`,
//! changed because identifiers ending in `.app` clash with macOS bundle names) to the current one.

use std::path::{Path, PathBuf};

use crate::workspaces::Registry;

pub const OLD_IDENTIFIER: &str = "dev.localpost.app";

/// If the current app folder doesn't exist yet but the old one does, rename it into place and
/// rewrite workspace paths that pointed inside it. Returns the (old, new) data folders that moved,
/// so keychain entries (keyed by folder) can follow. On failure the old folder is left untouched.
pub fn migrate_app_dir(app_dir: &Path) -> Vec<(PathBuf, PathBuf)> {
    let Some(parent) = app_dir.parent() else { return vec![] };
    let old = parent.join(OLD_IDENTIFIER);
    if old == app_dir || app_dir.exists() || !old.is_dir() {
        return vec![];
    }
    if let Err(e) = std::fs::rename(&old, app_dir) {
        eprintln!("Localpost: could not move {} to {}: {e}", old.display(), app_dir.display());
        return vec![];
    }

    let mut moved = vec![(old.join("data"), app_dir.join("data"))];
    let reg_path = app_dir.join("workspaces.json");
    if let Some(mut reg) = std::fs::read_to_string(&reg_path).ok().and_then(|s| serde_json::from_str::<Registry>(&s).ok()) {
        for w in &mut reg.workspaces {
            let p = PathBuf::from(&w.path);
            if let Ok(rest) = p.strip_prefix(&old) {
                let new = app_dir.join(rest);
                if !moved.iter().any(|(o, _)| *o == p) {
                    moved.push((p.clone(), new.clone()));
                }
                w.path = new.to_string_lossy().into_owned();
            }
        }
        if let Ok(json) = serde_json::to_string_pretty(&reg) {
            let _ = std::fs::write(&reg_path, json);
        }
    }
    moved
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moves_old_folder_and_rewrites_workspace_paths() {
        let root = std::env::temp_dir().join(format!("lp-migrate-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let old = root.join(OLD_IDENTIFIER);
        let new = root.join("dev.localpost.desktop");
        std::fs::create_dir_all(old.join("data")).unwrap();
        std::fs::create_dir_all(old.join("workspaces/work")).unwrap();
        std::fs::write(old.join("data/collections.json"), "[]").unwrap();
        let reg = format!(
            r#"{{"active":"w","workspaces":[{{"id":"default","name":"My Workspace","path":{:?}}},{{"id":"w","name":"Work","path":{:?}}},{{"id":"x","name":"Repo","path":"/elsewhere/api"}}]}}"#,
            old.join("data").to_string_lossy(), old.join("workspaces/work").to_string_lossy(),
        );
        std::fs::write(old.join("workspaces.json"), reg).unwrap();

        let moved = migrate_app_dir(&new);
        assert!(!old.exists() && new.join("data/collections.json").is_file());
        assert_eq!(moved, vec![(old.join("data"), new.join("data")), (old.join("workspaces/work"), new.join("workspaces/work"))]);
        let r: Registry = serde_json::from_str(&std::fs::read_to_string(new.join("workspaces.json")).unwrap()).unwrap();
        assert_eq!(r.workspaces[1].path, new.join("workspaces/work").to_string_lossy());
        assert_eq!(r.workspaces[2].path, "/elsewhere/api");

        // Runs only once: the new folder exists now.
        std::fs::create_dir_all(&old).unwrap();
        assert!(migrate_app_dir(&new).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }
}
