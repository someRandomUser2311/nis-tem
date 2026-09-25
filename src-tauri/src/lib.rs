mod http;
mod linked;
mod load;
mod oauth;
mod workspaces;
mod secrets;
mod servers;
mod ws;
mod storage;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use reqwest_cookie_store::CookieStoreMutex;
use tauri::Manager;
use tokio::sync::oneshot;

pub struct AppState {
    /// App-wide folder (holds `data/` and user `themes/`).
    pub app_dir: PathBuf,
    /// The active workspace's folder; switched by `workspace_switch`.
    data_dir: std::sync::RwLock<PathBuf>,
    pub jar: Arc<CookieStoreMutex>,
    pub pending: Mutex<HashMap<String, oneshot::Sender<()>>>,
    /// Running mock servers and webhook catchers, by id.
    pub servers: servers::Servers,
    /// Open WebSocket connections, by id.
    pub ws: ws::Connections,
    /// Running load tests (their stop flags), by id.
    pub loads: load::Loads,
    /// Folder watchers for linked collections, by folder path.
    pub watchers: Mutex<HashMap<String, notify::RecommendedWatcher>>,
}

impl AppState {
    pub fn new(app_dir: PathBuf, data_dir: PathBuf) -> Self {
        let jar = Arc::new(CookieStoreMutex::new(storage::load_cookies(&data_dir)));
        AppState {
            app_dir,
            data_dir: std::sync::RwLock::new(data_dir),
            jar,
            pending: Mutex::new(HashMap::new()),
            servers: Default::default(),
            ws: Default::default(),
            watchers: Default::default(),
            loads: Default::default(),
        }
    }

    pub fn data_dir(&self) -> PathBuf {
        self.data_dir.read().unwrap().clone()
    }

    /// Point the app at another workspace folder: stop listeners and sockets, swap the cookie jar.
    pub fn set_data_dir(&self, dir: PathBuf) {
        self.servers.lock().unwrap().clear();
        self.ws.lock().unwrap().clear();
        self.watchers.lock().unwrap().clear();
        *self.jar.lock().unwrap() = storage::load_cookies(&dir);
        *self.data_dir.write().unwrap() = dir;
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_dir = app
                .path()
                .app_data_dir()
                .expect("could not resolve app data directory");
            let data_dir = workspaces::active_dir(&app_dir);
            std::fs::create_dir_all(&data_dir)?;
            app.manage(AppState::new(app_dir, data_dir));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            http::send_request,
            http::cancel_request,
            http::stream_request,
            ws::ws_connect,
            ws::ws_send,
            ws::ws_close,
            oauth::oauth_authorize,
            secrets::secrets_read,
            secrets::secrets_write,
            secrets::secrets_clear,
            storage::store_read,
            storage::store_write,
            storage::get_data_dir,
            storage::read_text_file,
            storage::write_text_file,
            storage::write_base64_file,
            storage::list_cookies,
            storage::delete_cookie,
            storage::clear_cookies,
            storage::list_user_themes,
            storage::read_dir_files,
            workspaces::workspace_list,
            workspaces::workspace_create,
            workspaces::workspace_switch,
            workspaces::workspace_rename,
            workspaces::workspace_remove,
            linked::linked_write,
            load::load_start,
            load::load_stop,
            linked::linked_watch,
            linked::linked_unwatch,
            servers::server_start,
            servers::server_stop,
            servers::server_update,
            servers::server_list,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Localpost");
}
