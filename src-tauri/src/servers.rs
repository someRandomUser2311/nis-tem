//! Local HTTP listeners: mock servers (answer from saved examples) and webhook catchers
//! (record whatever arrives). Both bind to 127.0.0.1 unless the user opts into the LAN, and
//! every request they see is reported to the UI as an `lp://server` event.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::body::{to_bytes, Body};
use axum::extract::{Request, State as AxState};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, Response, StatusCode};
use axum::Router;
use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::oneshot;

use crate::http::KeyValue;
use crate::AppState;

const MAX_CAPTURE: usize = 10 * 1024 * 1024;

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MockRoute {
    /// Upper-case method, or "*" for any.
    pub method: String,
    /// Path pattern; segments like `:id`, `{{id}}` or `*` match anything.
    pub path: String,
    /// Query parameters the request must carry (value "" = any value).
    #[serde(default)]
    pub query: Vec<KeyValue>,
    pub status: u16,
    #[serde(default)]
    pub headers: Vec<KeyValue>,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub body_base64: Option<String>,
    /// Example name, for `x-mock-response-name` and the request log.
    pub name: String,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FixedResponse {
    pub status: u16,
    #[serde(default)]
    pub headers: Vec<KeyValue>,
    #[serde(default)]
    pub body: String,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Mode {
    Mock { routes: Vec<MockRoute> },
    Catcher { response: FixedResponse },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfig {
    pub id: String,
    /// 0 picks a free port.
    pub port: u16,
    #[serde(default)]
    pub delay_ms: u64,
    #[serde(default = "yes")]
    pub cors: bool,
    /// Bind to 0.0.0.0 instead of 127.0.0.1.
    #[serde(default)]
    pub allow_lan: bool,
    #[serde(flatten)]
    pub mode: Mode,
}

fn yes() -> bool {
    true
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub id: String,
    pub port: u16,
    pub host: String,
}

/// One request seen by a listener.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ServerEvent {
    pub server_id: String,
    pub id: String,
    /// Milliseconds since the Unix epoch.
    pub time: u64,
    pub method: String,
    pub path: String,
    pub query: String,
    pub headers: Vec<KeyValue>,
    pub body: String,
    pub body_base64: Option<String>,
    pub size: usize,
    pub status: u16,
    /// Mock only: name of the example that answered.
    pub matched: Option<String>,
    pub remote_addr: String,
}

pub type Emit = Arc<dyn Fn(ServerEvent) + Send + Sync>;

struct Ctx {
    id: String,
    mode: RwLock<Mode>,
    delay: Duration,
    cors: bool,
    emit: Emit,
    counter: std::sync::atomic::AtomicU64,
}

pub struct Running {
    shutdown: Option<oneshot::Sender<()>>,
    ctx: Arc<Ctx>,
    pub info: ServerInfo,
}

impl Drop for Running {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
    }
}

// ---------------------------------------------------------------- matching

fn is_wild(seg: &str) -> bool {
    seg == "*" || seg.starts_with(':') || (seg.starts_with("{{") && seg.ends_with("}}"))
}

fn segments(path: &str) -> Vec<&str> {
    path.split('/').filter(|s| !s.is_empty()).collect()
}

fn parse_query(q: &str) -> Vec<(String, String)> {
    q.split('&')
        .filter(|p| !p.is_empty())
        .map(|p| {
            let (k, v) = p.split_once('=').unwrap_or((p, ""));
            (decode(k), decode(v))
        })
        .collect()
}

/// Percent-decode (and `+` → space); malformed escapes are kept as they are.
fn decode(s: &str) -> String {
    let hex = |b: u8| (b as char).to_digit(16).map(|d| d as u8);
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => match (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                (Some(h), Some(l)) => {
                    out.push(h * 16 + l);
                    i += 3;
                    continue;
                }
                _ => out.push(b'%'),
            },
            b'+' => out.push(b' '),
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Pick the route answering `method path?query`. Literal segments beat wildcards, matching
/// query params beat none, and `x-mock-response-name` / `x-mock-response-code` choose between
/// several examples of the same request (as in Postman).
pub fn match_route<'a>(routes: &'a [MockRoute], method: &str, path: &str, query: &str, headers: &HeaderMap) -> Option<&'a MockRoute> {
    let want = segments(path);
    let q = parse_query(query);
    let pick_name = headers.get("x-mock-response-name").and_then(|v| v.to_str().ok());
    let pick_code = headers.get("x-mock-response-code").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u16>().ok());

    let mut best: Option<(i64, &MockRoute)> = None;
    for r in routes {
        if r.method != "*" && !r.method.eq_ignore_ascii_case(method) {
            continue;
        }
        let pat = segments(&r.path);
        if pat.len() != want.len() {
            continue;
        }
        let mut score: i64 = 0;
        let mut ok = true;
        for (p, w) in pat.iter().zip(&want) {
            if is_wild(p) {
                score += 1;
            } else if p.eq_ignore_ascii_case(w) || decode(p) == decode(w) {
                score += 10;
            } else {
                ok = false;
                break;
            }
        }
        if !ok {
            continue;
        }
        let mut query_ok = true;
        for kv in &r.query {
            match q.iter().find(|(k, _)| *k == kv.key) {
                Some((_, v)) if kv.value.is_empty() || is_wild(&kv.value) || *v == kv.value => score += 3,
                _ => query_ok = false,
            }
        }
        if !query_ok {
            continue;
        }
        if r.method != "*" {
            score += 2;
        }
        if pick_name.is_some_and(|n| n == r.name) {
            score += 1000;
        }
        if pick_code.is_some_and(|c| c == r.status) {
            score += 500;
        }
        if best.map_or(true, |(s, _)| score > s) {
            best = Some((score, r));
        }
    }
    best.map(|(_, r)| r)
}

// ---------------------------------------------------------------- handler

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn looks_text(headers: &HeaderMap, bytes: &[u8]) -> bool {
    let ct = headers.get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_ascii_lowercase();
    if ct.starts_with("image/") || ct.starts_with("audio/") || ct.starts_with("video/") || ct.contains("octet-stream") || ct.contains("pdf") || ct.contains("zip") {
        return false;
    }
    std::str::from_utf8(bytes).is_ok()
}

fn apply_cors(h: &mut HeaderMap) {
    h.insert("access-control-allow-origin", HeaderValue::from_static("*"));
    h.insert("access-control-allow-methods", HeaderValue::from_static("*"));
    h.insert("access-control-allow-headers", HeaderValue::from_static("*"));
    h.insert("access-control-expose-headers", HeaderValue::from_static("*"));
}

/// Headers copied from a saved response that must not be replayed: the body is stored decoded,
/// and the server sets framing itself.
fn skip_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "content-length" | "transfer-encoding" | "content-encoding" | "connection" | "keep-alive" | "date" | "server"
    )
}

fn build_response(status: u16, headers: &[KeyValue], body: Vec<u8>, cors: bool) -> Response<Body> {
    let mut res = Response::new(Body::from(body));
    *res.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::OK);
    let h = res.headers_mut();
    for kv in headers {
        if skip_header(&kv.key) {
            continue;
        }
        if let (Ok(k), Ok(v)) = (HeaderName::from_bytes(kv.key.as_bytes()), HeaderValue::from_str(&kv.value)) {
            h.append(k, v);
        }
    }
    h.insert("x-powered-by", HeaderValue::from_static("Localpost"));
    if cors {
        apply_cors(h);
    }
    res
}

async fn handle(AxState(ctx): AxState<Arc<Ctx>>, axum::extract::ConnectInfo(remote): axum::extract::ConnectInfo<SocketAddr>, req: Request) -> Response<Body> {
    let started = Instant::now();
    let (parts, body) = req.into_parts();
    let bytes = to_bytes(body, MAX_CAPTURE).await.unwrap_or_default();
    let method = parts.method.as_str().to_string();
    let path = parts.uri.path().to_string();
    let query = parts.uri.query().unwrap_or("").to_string();

    let (status, matched, response) = if ctx.cors && parts.method == Method::OPTIONS && parts.headers.contains_key("access-control-request-method") {
        (204, None, build_response(204, &[], Vec::new(), true))
    } else {
        let mode = ctx.mode.read().unwrap().clone();
        match mode {
            Mode::Mock { routes } => match match_route(&routes, &method, &path, &query, &parts.headers) {
                Some(r) => {
                    let body = match &r.body_base64 {
                        Some(b64) => base64::engine::general_purpose::STANDARD.decode(b64).unwrap_or_default(),
                        None => r.body.clone().into_bytes(),
                    };
                    (r.status, Some(r.name.clone()), build_response(r.status, &r.headers, body, ctx.cors))
                }
                None => {
                    let msg = serde_json::json!({
                        "error": "No matching example",
                        "detail": "Save an example for this method and path in Localpost, or check the mock server's route list.",
                        "method": method,
                        "path": path,
                    });
                    let hs = [KeyValue { key: "content-type".into(), value: "application/json".into() }];
                    (404, None, build_response(404, &hs, serde_json::to_vec_pretty(&msg).unwrap_or_default(), ctx.cors))
                }
            },
            Mode::Catcher { response } => (
                response.status,
                None,
                build_response(response.status, &response.headers, response.body.into_bytes(), ctx.cors),
            ),
        }
    };

    if !ctx.delay.is_zero() {
        tokio::time::sleep(ctx.delay.saturating_sub(started.elapsed())).await;
    }

    let text = looks_text(&parts.headers, &bytes);
    let n = ctx.counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    (ctx.emit)(ServerEvent {
        server_id: ctx.id.clone(),
        id: format!("{}-{n}", ctx.id),
        time: now_ms(),
        method,
        path,
        query,
        headers: parts
            .headers
            .iter()
            .map(|(k, v)| KeyValue { key: k.as_str().to_string(), value: String::from_utf8_lossy(v.as_bytes()).into_owned() })
            .collect(),
        body: if text { String::from_utf8_lossy(&bytes).into_owned() } else { String::new() },
        body_base64: if text || bytes.is_empty() { None } else { Some(base64::engine::general_purpose::STANDARD.encode(&bytes)) },
        size: bytes.len(),
        status,
        matched,
        remote_addr: remote.to_string(),
    });
    response
}

/// Bind and serve. Returns once the socket is listening.
pub async fn start(config: ServerConfig, emit: Emit) -> Result<Running, String> {
    let host = if config.allow_lan { "0.0.0.0" } else { "127.0.0.1" };
    let listener = tokio::net::TcpListener::bind((host, config.port))
        .await
        .map_err(|e| if e.kind() == std::io::ErrorKind::AddrInUse { format!("Port {} is already in use", config.port) } else { e.to_string() })?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let ctx = Arc::new(Ctx {
        id: config.id.clone(),
        mode: RwLock::new(config.mode),
        delay: Duration::from_millis(config.delay_ms.min(60_000)),
        cors: config.cors,
        emit,
        counter: Default::default(),
    });
    let app = Router::new().fallback(handle).with_state(ctx.clone());
    let (tx, rx) = oneshot::channel::<()>();
    tauri::async_runtime::spawn(async move {
        let _ = axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await;
    });
    Ok(Running { shutdown: Some(tx), ctx, info: ServerInfo { id: config.id, port, host: host.to_string() } })
}

// ---------------------------------------------------------------- commands

pub type Servers = std::sync::Mutex<HashMap<String, Running>>;

#[tauri::command]
pub async fn server_start(app: AppHandle, state: State<'_, AppState>, config: ServerConfig) -> Result<ServerInfo, String> {
    let id = config.id.clone();
    // Restarting an id replaces the old listener.
    state.servers.lock().unwrap().remove(&id);
    let emit: Emit = Arc::new(move |ev: ServerEvent| {
        let _ = app.emit("lp://server", ev);
    });
    let running = start(config, emit).await?;
    let info = running.info.clone();
    state.servers.lock().unwrap().insert(id, running);
    Ok(info)
}

#[tauri::command]
pub fn server_stop(state: State<'_, AppState>, id: String) {
    state.servers.lock().unwrap().remove(&id);
}

/// Swap a running mock's routes (examples edited) without restarting it.
#[tauri::command]
pub fn server_update(state: State<'_, AppState>, id: String, mode: Mode) -> Result<(), String> {
    let servers = state.servers.lock().unwrap();
    let s = servers.get(&id).ok_or("Server is not running")?;
    *s.ctx.mode.write().unwrap() = mode;
    Ok(())
}

#[tauri::command]
pub fn server_list(state: State<'_, AppState>) -> Vec<ServerInfo> {
    state.servers.lock().unwrap().values().map(|r| r.info.clone()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn route(method: &str, path: &str, name: &str, status: u16) -> MockRoute {
        MockRoute { method: method.into(), path: path.into(), query: vec![], status, headers: vec![], body: name.into(), body_base64: None, name: name.into() }
    }

    #[test]
    fn matching_prefers_literals_query_and_named_examples() {
        let mut with_query = route("GET", "/users", "active users", 200);
        with_query.query = vec![KeyValue { key: "active".into(), value: "true".into() }];
        let routes = vec![
            route("GET", "/users/:id", "one user", 200),
            route("GET", "/users/me", "me", 200),
            route("GET", "/users", "all users", 200),
            with_query,
            route("POST", "/users", "created", 201),
            route("POST", "/users", "invalid", 422),
            route("*", "/health", "health", 200),
        ];
        let h = HeaderMap::new();
        let m = |method, path, q| match_route(&routes, method, path, q, &h).map(|r| r.name.as_str());
        assert_eq!(m("GET", "/users/42", ""), Some("one user"));
        assert_eq!(m("GET", "/users/me", ""), Some("me"));
        assert_eq!(m("GET", "/users/", ""), Some("all users"));
        assert_eq!(m("GET", "/users", "active=true"), Some("active users"));
        assert_eq!(m("GET", "/users", "active=false"), Some("all users"));
        assert_eq!(m("DELETE", "/health", ""), Some("health"));
        assert_eq!(m("GET", "/nope", ""), None);
        assert_eq!(m("POST", "/users", ""), Some("created"));
        let mut named = HeaderMap::new();
        named.insert("x-mock-response-name", HeaderValue::from_static("invalid"));
        assert_eq!(match_route(&routes, "POST", "/users", "", &named).map(|r| r.status), Some(422));
        let mut code = HeaderMap::new();
        code.insert("x-mock-response-code", HeaderValue::from_static("422"));
        assert_eq!(match_route(&routes, "POST", "/users", "", &code).map(|r| r.name.as_str()), Some("invalid"));
    }

    /// The exact JSON shapes `api.serverStart` / `api.serverUpdate` send from the frontend.
    #[test]
    fn config_json_from_frontend() {
        let mock: ServerConfig = serde_json::from_str(
            r#"{"id":"s1","port":3100,"delayMs":250,"cors":true,"allowLan":false,"kind":"mock",
                "routes":[{"method":"GET","path":"/users/:id","query":[{"key":"a","value":"1"}],"status":200,
                           "headers":[{"key":"Content-Type","value":"application/json"}],"body":"{}","bodyBase64":null,"name":"ok"}]}"#,
        )
        .unwrap();
        assert_eq!((mock.port, mock.delay_ms, mock.cors, mock.allow_lan), (3100, 250, true, false));
        assert!(matches!(&mock.mode, Mode::Mock { routes } if routes[0].path == "/users/:id" && routes[0].query[0].key == "a"));
        let catcher: ServerConfig = serde_json::from_str(
            r#"{"id":"s2","port":0,"delayMs":0,"cors":false,"allowLan":true,"kind":"catcher",
                "response":{"status":202,"headers":[],"body":"ok"}}"#,
        )
        .unwrap();
        assert!(catcher.allow_lan && matches!(catcher.mode, Mode::Catcher { response } if response.status == 202));
        let update: Mode = serde_json::from_str(r#"{"kind":"mock","routes":[]}"#).unwrap();
        assert!(matches!(update, Mode::Mock { routes } if routes.is_empty()));
        let ev = serde_json::to_value(ServerEvent {
            server_id: "s".into(), id: "1".into(), time: 1, method: "GET".into(), path: "/".into(), query: "".into(), headers: vec![],
            body: "".into(), body_base64: None, size: 0, status: 200, matched: None, remote_addr: "".into(),
        })
        .unwrap();
        assert!(ev.get("serverId").is_some() && ev.get("bodyBase64").is_some() && ev.get("remoteAddr").is_some());
    }

    #[test]
    fn percent_decoding() {
        assert_eq!(decode("a%20b+c"), "a b c");
        assert_eq!(decode("100%"), "100%");
        assert_eq!(decode("%e2%9c%93"), "✓");
    }

    fn raw_request(port: u16, req: &str) -> String {
        use std::io::{Read, Write};
        let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        s.write_all(req.as_bytes()).unwrap();
        let mut out = String::new();
        let _ = s.read_to_string(&mut out);
        out
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn mock_and_catcher_serve_and_report() {
        let seen: Arc<Mutex<Vec<ServerEvent>>> = Arc::default();
        let sink = seen.clone();
        let emit: Emit = Arc::new(move |e| sink.lock().unwrap().push(e));

        let mut r = route("GET", "/users/:id", "user", 200);
        r.body = r#"{"id":1}"#.into();
        r.headers = vec![
            KeyValue { key: "Content-Type".into(), value: "application/json".into() },
            KeyValue { key: "Content-Encoding".into(), value: "gzip".into() },
        ];
        let mock = start(
            ServerConfig { id: "m".into(), port: 0, delay_ms: 0, cors: true, allow_lan: false, mode: Mode::Mock { routes: vec![r] } },
            emit.clone(),
        )
        .await
        .unwrap();
        let port = mock.info.port;
        let out = tokio::task::spawn_blocking(move || raw_request(port, "GET /users/7?x=1 HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n")).await.unwrap();
        assert!(out.starts_with("HTTP/1.1 200"), "{out}");
        assert!(out.to_ascii_lowercase().contains("content-type: application/json"));
        assert!(!out.to_ascii_lowercase().contains("content-encoding"), "decoded body must not claim gzip");
        assert!(out.to_ascii_lowercase().contains("access-control-allow-origin: *"));
        assert!(out.ends_with(r#"{"id":1}"#));
        let out = tokio::task::spawn_blocking(move || raw_request(port, "GET /other HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n")).await.unwrap();
        assert!(out.starts_with("HTTP/1.1 404") && out.contains("No matching example"));

        // Routes can be swapped live.
        *mock.ctx.mode.write().unwrap() = Mode::Mock { routes: vec![route("GET", "/other", "other", 202)] };
        let out = tokio::task::spawn_blocking(move || raw_request(port, "GET /other HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n")).await.unwrap();
        assert!(out.starts_with("HTTP/1.1 202"));

        let catcher = start(
            ServerConfig {
                id: "c".into(), port: 0, delay_ms: 0, cors: false, allow_lan: false,
                mode: Mode::Catcher { response: FixedResponse { status: 201, headers: vec![], body: "thanks".into() } },
            },
            emit,
        )
        .await
        .unwrap();
        let cport = catcher.info.port;
        let out = tokio::task::spawn_blocking(move || {
            raw_request(cport, "POST /hook?src=gh HTTP/1.1\r\nHost: a\r\nX-Sig: abc\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}")
        })
        .await
        .unwrap();
        assert!(out.starts_with("HTTP/1.1 201") && out.ends_with("thanks"));

        drop(mock);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(std::net::TcpStream::connect(("127.0.0.1", port)).is_err(), "stopped server must release its port");

        let events = seen.lock().unwrap();
        assert_eq!(events.len(), 4);
        assert_eq!(events[0].matched.as_deref(), Some("user"));
        assert_eq!((events[0].path.as_str(), events[0].query.as_str()), ("/users/7", "x=1"));
        assert_eq!(events[1].status, 404);
        let hook = &events[3];
        assert_eq!((hook.server_id.as_str(), hook.method.as_str(), hook.body.as_str()), ("c", "POST", "{\"ok\":true}"));
        assert!(hook.headers.iter().any(|h| h.key == "x-sig" && h.value == "abc"));
    }
}
