//! OAuth 2.0 authorization-code helper: listen on a loopback redirect URI, open the system
//! browser at the provider's authorize URL, and hand the callback's query string back to the UI.
//! Token exchange itself happens in the frontend through the normal request engine.

use std::time::Duration;

use serde::Deserialize;
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

use crate::AppState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizeRequest {
    /// Used to cancel a waiting flow (via `cancel_request`).
    pub id: String,
    /// The provider's authorize URL, with `redirect_uri` already filled in.
    pub authorize_url: String,
    /// Must be `http://127.0.0.1:<port>/<path>` or `http://localhost:<port>/<path>`.
    pub redirect_uri: String,
    #[serde(default = "default_timeout")]
    pub timeout_secs: u64,
}

fn default_timeout() -> u64 {
    300
}

/// Split a loopback redirect URI into (port, path).
pub fn loopback_target(redirect_uri: &str) -> Result<(u16, String), String> {
    let rest = redirect_uri
        .strip_prefix("http://")
        .ok_or("The callback URL must start with http:// (a local loopback address)")?;
    let (host_port, path) = match rest.find('/') {
        Some(i) => (&rest[..i], rest[i..].to_string()),
        None => (rest, "/".to_string()),
    };
    let (host, port) = host_port.rsplit_once(':').ok_or("The callback URL needs an explicit port, e.g. http://127.0.0.1:7890/callback")?;
    if host != "127.0.0.1" && host != "localhost" {
        return Err("The callback URL must point at 127.0.0.1 or localhost".into());
    }
    let port: u16 = port.parse().map_err(|_| "Invalid port in the callback URL")?;
    if port == 0 {
        return Err("The callback URL needs a fixed port".into());
    }
    let path = path.split('?').next().unwrap_or("/").to_string();
    Ok((port, path))
}

const DONE_PAGE: &str = "<!doctype html><meta charset=utf-8><title>Localpost</title>\
<body style=\"font:15px -apple-system,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:90vh;color:#333\">\
<div style=text-align:center><h2>Authorization received</h2><p>You can close this tab and return to Localpost.</p></div>";

/// Accept connections until one hits `path`; answer it with a "you can close this tab" page and
/// return its query string. Other paths (favicon, …) get a 404.
pub async fn wait_for_callback(listener: TcpListener, path: &str) -> Result<String, String> {
    loop {
        let (mut sock, _) = listener.accept().await.map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; 16 * 1024];
        let mut len = 0;
        // Read just the request head.
        while len < buf.len() {
            let n = sock.read(&mut buf[len..]).await.map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            len += n;
            if buf[..len].windows(4).any(|w| w == b"\r\n\r\n") {
                break;
            }
        }
        let head = String::from_utf8_lossy(&buf[..len]).into_owned();
        let target = head.lines().next().and_then(|l| l.split_whitespace().nth(1)).unwrap_or("/");
        let (p, q) = target.split_once('?').unwrap_or((target, ""));
        if p == path {
            let body = DONE_PAGE.as_bytes();
            let resp = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
            let _ = sock.write_all(resp.as_bytes()).await;
            let _ = sock.write_all(body).await;
            let _ = sock.shutdown().await;
            return Ok(q.to_string());
        }
        let _ = sock.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
    }
}

#[tauri::command]
pub async fn oauth_authorize(app: AppHandle, state: State<'_, AppState>, request: AuthorizeRequest) -> Result<String, String> {
    let (port, path) = loopback_target(&request.redirect_uri)?;
    let listener = TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|e| format!("Could not listen on port {port} for the OAuth callback: {e}"))?;
    app.opener()
        .open_url(request.authorize_url.clone(), None::<&str>)
        .map_err(|e| format!("Could not open the browser: {e}"))?;

    let (tx, rx) = oneshot::channel();
    state.pending.lock().unwrap().insert(request.id.clone(), tx);
    let result = tokio::select! {
        r = wait_for_callback(listener, &path) => r,
        _ = rx => Err("Authorization cancelled".to_string()),
        _ = tokio::time::sleep(Duration::from_secs(request.timeout_secs.clamp(10, 1800))) => Err("Timed out waiting for the browser to return".to_string()),
    };
    state.pending.lock().unwrap().remove(&request.id);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_loopback_redirects() {
        assert_eq!(loopback_target("http://127.0.0.1:7890/callback").unwrap(), (7890, "/callback".into()));
        assert_eq!(loopback_target("http://localhost:3000").unwrap(), (3000, "/".into()));
        assert!(loopback_target("https://example.com/cb").is_err());
        assert!(loopback_target("http://example.com:80/cb").is_err());
        assert!(loopback_target("http://127.0.0.1/cb").is_err());
    }

    #[tokio::test]
    async fn returns_the_callback_query() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let waiter = tokio::spawn(async move { wait_for_callback(listener, "/callback").await });
        let get = |path: &'static str| async move {
            let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            s.write_all(format!("GET {path} HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes()).await.unwrap();
            let mut out = String::new();
            s.read_to_string(&mut out).await.unwrap();
            out
        };
        assert!(get("/favicon.ico").await.starts_with("HTTP/1.1 404"));
        let page = get("/callback?code=abc&state=xyz").await;
        assert!(page.starts_with("HTTP/1.1 200") && page.contains("Authorization received"));
        assert_eq!(waiter.await.unwrap().unwrap(), "code=abc&state=xyz");
    }
}
