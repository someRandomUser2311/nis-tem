//! The HTTP engine. Requests are executed natively (not from the webview), so
//! there are no CORS restrictions and we have full control over TLS, proxies,
//! redirects and cookies.

use std::time::{Duration, Instant};

use base64::Engine;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use reqwest::multipart;
use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::sync::oneshot;

use crate::storage::save_cookies;
use crate::AppState;

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct KeyValue {
    pub key: String,
    pub value: String,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FormField {
    key: String,
    value: String,
    /// "text" or "file" (value is then a local file path)
    kind: String,
    content_type: Option<String>,
}

#[derive(Deserialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Body {
    None,
    Text { content: String },
    UrlEncoded { fields: Vec<KeyValue> },
    FormData { fields: Vec<FormField> },
    Binary { path: String },
}

/// A client certificate (mTLS) as PEM files; the key must be unencrypted.
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ClientCert {
    cert_path: String,
    key_path: Option<String>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    timeout_ms: u64,
    follow_redirects: bool,
    max_redirects: usize,
    verify_ssl: bool,
    proxy: Option<String>,
    use_system_proxy: bool,
    pub(crate) use_cookies: bool,
    /// Picked by the UI from Settings → Certificates for this request's host.
    #[serde(default)]
    client_cert: Option<ClientCert>,
    /// Extra trusted CA certificates (PEM bundle), on top of the built-in roots.
    #[serde(default)]
    ca_path: Option<String>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequest {
    pub(crate) id: String,
    method: String,
    pub(crate) url: String,
    headers: Vec<KeyValue>,
    body: Body,
    pub(crate) options: Options,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponse {
    status: u16,
    status_text: String,
    http_version: String,
    url: String,
    remote_addr: Option<String>,
    headers: Vec<KeyValue>,
    request_headers: Vec<KeyValue>,
    body_text: String,
    body_base64: Option<String>,
    is_binary: bool,
    size: usize,
    headers_size: usize,
    time_ms: f64,
    ttfb_ms: f64,
}

fn header_pairs(map: &HeaderMap) -> Vec<KeyValue> {
    map.iter()
        .map(|(k, v)| KeyValue {
            key: k.as_str().to_string(),
            value: String::from_utf8_lossy(v.as_bytes()).into_owned(),
        })
        .collect()
}

fn looks_binary(content_type: &str) -> bool {
    let ct = content_type.to_ascii_lowercase();
    ct.starts_with("image/")
        || ct.starts_with("audio/")
        || ct.starts_with("video/")
        || ct.starts_with("font/")
        || ct.contains("application/pdf")
        || ct.contains("application/octet-stream")
        || ct.contains("application/zip")
        || ct.contains("protobuf")
}

pub fn build_client(state: &AppState, opts: &Options) -> Result<reqwest::Client, String> {
    let mut b = reqwest::Client::builder()
        .danger_accept_invalid_certs(!opts.verify_ssl)
        .user_agent(concat!("Localpost/", env!("CARGO_PKG_VERSION")))
        .redirect(if opts.follow_redirects {
            reqwest::redirect::Policy::limited(opts.max_redirects.max(1))
        } else {
            reqwest::redirect::Policy::none()
        });
    if opts.timeout_ms > 0 {
        b = b.timeout(Duration::from_millis(opts.timeout_ms));
    }
    if opts.use_cookies {
        b = b.cookie_provider(state.jar.clone());
    }
    if let Some(ca) = opts.ca_path.as_deref().filter(|p| !p.is_empty()) {
        let pem = std::fs::read(ca).map_err(|e| format!("Could not read CA certificates {ca}: {e}"))?;
        let certs = reqwest::Certificate::from_pem_bundle(&pem).map_err(|e| format!("Invalid CA certificate file {ca}: {e}"))?;
        if certs.is_empty() {
            return Err(format!("No certificates found in {ca}"));
        }
        for c in certs {
            b = b.add_root_certificate(c);
        }
    }
    if let Some(cc) = &opts.client_cert {
        let mut pem = std::fs::read(&cc.cert_path).map_err(|e| format!("Could not read client certificate {}: {e}", cc.cert_path))?;
        if let Some(key) = cc.key_path.as_deref().filter(|p| !p.is_empty()) {
            pem.push(b'\n');
            pem.extend(std::fs::read(key).map_err(|e| format!("Could not read client key {key}: {e}"))?);
        }
        let id = reqwest::Identity::from_pem(&pem).map_err(|e| {
            format!("Invalid client certificate/key (PEM, unencrypted key expected): {e}")
        })?;
        b = b.identity(id);
    }
    match opts.proxy.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) => b = b.proxy(reqwest::Proxy::all(p).map_err(|e| format!("Invalid proxy: {e}"))?),
        None if !opts.use_system_proxy => b = b.no_proxy(),
        None => {}
    }
    b.build().map_err(|e| e.to_string())
}

/// Build the client and the concrete request (headers, body read from disk, …).
async fn build(state: &AppState, req: HttpRequest) -> Result<(reqwest::Client, reqwest::Request, Vec<KeyValue>), String> {
    let client = build_client(state, &req.options)?;
    let (built, headers) = build_request(&client, req).await?;
    Ok((client, built, headers))
}

/// The concrete request for an existing client (load tests reuse one client and its pool).
pub async fn build_request(client: &reqwest::Client, req: HttpRequest) -> Result<(reqwest::Request, Vec<KeyValue>), String> {
    let method = reqwest::Method::from_bytes(req.method.trim().to_uppercase().as_bytes())
        .map_err(|_| format!("Invalid method: {}", req.method))?;

    let mut url = req.url.trim().to_string();
    if !url.contains("://") {
        url = format!("http://{url}");
    }

    let mut headers = HeaderMap::new();
    for h in &req.headers {
        if h.key.trim().is_empty() {
            continue;
        }
        let name = HeaderName::from_bytes(h.key.trim().as_bytes())
            .map_err(|_| format!("Invalid header name: {}", h.key))?;
        let value = HeaderValue::from_str(&h.value)
            .map_err(|_| format!("Invalid value for header {}", h.key))?;
        headers.append(name, value);
    }

    let mut builder = client.request(method, &url).headers(headers);
    builder = match req.body {
        Body::None => builder,
        Body::Text { content } => builder.body(content),
        Body::UrlEncoded { fields } => {
            let pairs: Vec<(String, String)> =
                fields.into_iter().map(|f| (f.key, f.value)).collect();
            builder.form(&pairs)
        }
        Body::FormData { fields } => {
            let mut form = multipart::Form::new();
            for f in fields {
                if f.kind == "file" {
                    let bytes = tokio::fs::read(&f.value)
                        .await
                        .map_err(|e| format!("Could not read file {}: {e}", f.value))?;
                    let file_name = std::path::Path::new(&f.value)
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_else(|| "file".into());
                    let mime = f.content_type.filter(|c| !c.is_empty()).unwrap_or_else(|| {
                        mime_guess::from_path(&f.value).first_or_octet_stream().to_string()
                    });
                    let part = multipart::Part::bytes(bytes)
                        .file_name(file_name)
                        .mime_str(&mime)
                        .map_err(|e| e.to_string())?;
                    form = form.part(f.key, part);
                } else {
                    let mut part = multipart::Part::text(f.value);
                    if let Some(ct) = f.content_type.filter(|c| !c.is_empty()) {
                        part = part.mime_str(&ct).map_err(|e| e.to_string())?;
                    }
                    form = form.part(f.key, part);
                }
            }
            builder.multipart(form)
        }
        Body::Binary { path } => {
            let bytes = tokio::fs::read(&path)
                .await
                .map_err(|e| format!("Could not read file {path}: {e}"))?;
            builder.body(bytes)
        }
    };

    let built = builder.build().map_err(|e| e.to_string())?;
    let request_headers = header_pairs(built.headers());
    Ok((built, request_headers))
}

async fn execute(state: &AppState, req: HttpRequest) -> Result<HttpResponse, String> {
    let use_cookies = req.options.use_cookies;
    let (client, built, request_headers) = build(state, req).await?;
    let start = Instant::now();
    let resp = client.execute(built).await.map_err(describe_error)?;
    let ttfb = start.elapsed();

    let status = resp.status();
    let http_version = format!("{:?}", resp.version());
    let final_url = resp.url().to_string();
    let remote_addr = resp.remote_addr().map(|a| a.to_string());
    let headers = header_pairs(resp.headers());
    let headers_size: usize = headers.iter().map(|h| h.key.len() + h.value.len() + 4).sum();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    let bytes = resp.bytes().await.map_err(describe_error)?;
    let total = start.elapsed();

    let utf8 = std::str::from_utf8(&bytes).is_ok();
    let is_binary = looks_binary(&content_type) || !utf8;
    let body_base64 = is_binary.then(|| base64::engine::general_purpose::STANDARD.encode(&bytes));
    let body_text = if is_binary && !utf8 {
        String::new()
    } else {
        String::from_utf8_lossy(&bytes).into_owned()
    };

    if use_cookies {
        save_cookies(state);
    }

    Ok(HttpResponse {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        http_version,
        url: final_url,
        remote_addr,
        headers,
        request_headers,
        body_text,
        body_base64,
        is_binary,
        size: bytes.len(),
        headers_size,
        time_ms: total.as_secs_f64() * 1000.0,
        ttfb_ms: ttfb.as_secs_f64() * 1000.0,
    })
}

fn describe_error(e: reqwest::Error) -> String {
    use std::error::Error;
    let mut msg = if e.is_timeout() {
        "Request timed out".to_string()
    } else if e.is_connect() {
        "Could not connect".to_string()
    } else if e.is_redirect() {
        "Too many redirects".to_string()
    } else {
        "Request failed".to_string()
    };
    let mut src = e.source();
    while let Some(s) = src {
        msg.push_str(": ");
        msg.push_str(&s.to_string());
        src = s.source();
    }
    msg
}

#[tauri::command]
pub async fn send_request(
    state: State<'_, AppState>,
    request: HttpRequest,
) -> Result<HttpResponse, String> {
    let id = request.id.clone();
    let (tx, rx) = oneshot::channel();
    state.pending.lock().unwrap().insert(id.clone(), tx);

    let result = tokio::select! {
        r = execute(&state, request) => r,
        _ = rx => Err("Request cancelled".to_string()),
    };
    state.pending.lock().unwrap().remove(&id);
    result
}

/// One piece of a streamed response (`lp://stream` event).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StreamEvent {
    pub id: String,
    /// "head" | "chunk" | "end" | "error"
    pub kind: &'static str,
    pub status: Option<u16>,
    pub status_text: Option<String>,
    pub headers: Vec<KeyValue>,
    pub data: String,
    pub elapsed_ms: f64,
}

/// Send a request and report the response as it arrives (for Server-Sent Events and other
/// long-lived streams) instead of buffering it. Resolves when the stream ends or is cancelled.
pub async fn stream(state: &AppState, req: HttpRequest, emit: &(dyn Fn(StreamEvent) + Send + Sync)) -> Result<(), String> {
    use futures_util::StreamExt;
    let id = req.id.clone();
    let use_cookies = req.options.use_cookies;
    // A total timeout would cut a healthy stream off; only the connection phase is bounded.
    let timeout_ms = req.options.timeout_ms;
    let mut req = req;
    req.options.timeout_ms = 0;
    let (client, built, _) = build(state, req).await?;
    let start = Instant::now();
    let send = client.execute(built);
    let resp = if timeout_ms > 0 {
        tokio::time::timeout(Duration::from_millis(timeout_ms), send).await.map_err(|_| "Request timed out".to_string())?
    } else {
        send.await
    }
    .map_err(describe_error)?;
    let ms = |s: &Instant| s.elapsed().as_secs_f64() * 1000.0;
    emit(StreamEvent {
        id: id.clone(), kind: "head", status: Some(resp.status().as_u16()),
        status_text: Some(resp.status().canonical_reason().unwrap_or("").to_string()),
        headers: header_pairs(resp.headers()), data: String::new(), elapsed_ms: ms(&start),
    });
    if use_cookies {
        save_cookies(state);
    }
    let mut body = resp.bytes_stream();
    // Keep partial UTF-8 sequences until the rest arrives.
    let mut pending: Vec<u8> = Vec::new();
    while let Some(chunk) = body.next().await {
        let chunk = chunk.map_err(describe_error)?;
        pending.extend_from_slice(&chunk);
        let valid = match std::str::from_utf8(&pending) {
            Ok(_) => pending.len(),
            Err(e) => e.valid_up_to(),
        };
        if valid == 0 && pending.len() < 4 {
            continue;
        }
        let take = if valid == 0 { pending.len() } else { valid };
        let text = String::from_utf8_lossy(&pending[..take]).into_owned();
        pending.drain(..take);
        emit(StreamEvent { id: id.clone(), kind: "chunk", status: None, status_text: None, headers: vec![], data: text, elapsed_ms: ms(&start) });
    }
    emit(StreamEvent { id, kind: "end", status: None, status_text: None, headers: vec![], data: String::new(), elapsed_ms: ms(&start) });
    Ok(())
}

#[tauri::command]
pub async fn stream_request(app: tauri::AppHandle, state: State<'_, AppState>, request: HttpRequest) -> Result<(), String> {
    use tauri::Emitter;
    let id = request.id.clone();
    let (tx, rx) = oneshot::channel();
    state.pending.lock().unwrap().insert(id.clone(), tx);
    let emit = move |ev: StreamEvent| {
        let _ = app.emit("lp://stream", ev);
    };
    let result = tokio::select! {
        r = stream(&state, request, &emit) => r,
        _ = rx => Err("Request cancelled".to_string()),
    };
    state.pending.lock().unwrap().remove(&id);
    result
}

#[tauri::command]
pub fn cancel_request(state: State<'_, AppState>, id: String) {
    if let Some(tx) = state.pending.lock().unwrap().remove(&id) {
        let _ = tx.send(());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::Mutex;

    /// Minimal HTTP/1.1 server that echoes the raw request back as the body.
    fn echo_server() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let mut s = stream.unwrap();
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                loop {
                    let n = s.read(&mut chunk).unwrap();
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&buf[..pos]).to_ascii_lowercase();
                        let len = head
                            .lines()
                            .find_map(|l| l.strip_prefix("content-length:"))
                            .map(|v| v.trim().parse::<usize>().unwrap())
                            .unwrap_or(0);
                        if buf.len() >= pos + 4 + len {
                            break;
                        }
                    }
                    if n == 0 {
                        break;
                    }
                }
                let status = if buf.starts_with(b"GET /missing") { "404 Not Found" } else { "200 OK" };
                let head = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: text/plain\r\nSet-Cookie: sid=42; Path=/\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    buf.len()
                );
                s.write_all(head.as_bytes()).unwrap();
                s.write_all(&buf).unwrap();
            }
        });
        format!("http://{addr}")
    }

    fn state() -> AppState {
        let dir = std::env::temp_dir().join(format!("localpost-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        AppState::new(dir.clone(), dir)
    }

    fn req(method: &str, url: String, headers: Vec<(&str, &str)>, body: Body) -> HttpRequest {
        HttpRequest {
            id: "t".into(),
            method: method.into(),
            url,
            headers: headers
                .into_iter()
                .map(|(k, v)| KeyValue { key: k.into(), value: v.into() })
                .collect(),
            body,
            options: Options {
                timeout_ms: 5000,
                follow_redirects: true,
                max_redirects: 5,
                verify_ssl: true,
                proxy: None,
                use_system_proxy: false,
                use_cookies: true,
                client_cert: None,
                ca_path: None,
            },
        }
    }

    #[test]
    fn sends_all_body_types_and_keeps_cookies() {
        let base = echo_server();
        let st = state();
        tauri::async_runtime::block_on(async {
            // GET + custom header + cookie capture
            let r = execute(&st, req("get", format!("{base}/a?x=1"), vec![("X-Test", "yes")], Body::None)).await.unwrap();
            assert_eq!(r.status, 200);
            assert!(r.body_text.starts_with("GET /a?x=1 HTTP/1.1"));
            assert!(r.body_text.to_lowercase().contains("x-test: yes"));
            assert!(r.headers.iter().any(|h| h.key == "set-cookie"));

            // Cookie from the previous response is sent back
            let r = execute(&st, req("GET", format!("{base}/b"), vec![], Body::None)).await.unwrap();
            assert!(r.body_text.contains("cookie: sid=42"), "{}", r.body_text);
            assert!(st.data_dir().join("cookies.json").exists());

            // Raw text body
            let r = execute(&st, req("POST", format!("{base}/c"), vec![("Content-Type", "application/json")], Body::Text { content: "{\"a\":1}".into() })).await.unwrap();
            assert!(r.body_text.ends_with("{\"a\":1}"));

            // urlencoded
            let r = execute(&st, req("POST", format!("{base}/d"), vec![], Body::UrlEncoded {
                fields: vec![KeyValue { key: "q".into(), value: "a b&c".into() }],
            })).await.unwrap();
            assert!(r.body_text.contains("application/x-www-form-urlencoded"));
            assert!(r.body_text.ends_with("q=a+b%26c"));

            // multipart with a file
            let file = st.data_dir().join("upload.txt");
            std::fs::write(&file, "FILE-CONTENTS").unwrap();
            let r = execute(&st, req("PUT", format!("{base}/e"), vec![], Body::FormData {
                fields: vec![
                    FormField { key: "name".into(), value: "ada".into(), kind: "text".into(), content_type: None },
                    FormField { key: "doc".into(), value: file.to_string_lossy().into(), kind: "file".into(), content_type: None },
                ],
            })).await.unwrap();
            assert!(r.body_text.contains("multipart/form-data; boundary="));
            assert!(r.body_text.contains("filename=\"upload.txt\""));
            assert!(r.body_text.contains("FILE-CONTENTS"));
            assert!(r.body_text.contains("name=\"name\""));

            // status passthrough, scheme defaulting
            let no_scheme = base.trim_start_matches("http://").to_string();
            let r = execute(&st, req("GET", format!("{no_scheme}/missing"), vec![], Body::None)).await.unwrap();
            assert_eq!(r.status, 404);
            assert_eq!(r.status_text, "Not Found");

            // connection errors are reported, not panics
            let err = execute(&st, req("GET", "http://127.0.0.1:1".into(), vec![], Body::None)).await.err().unwrap();
            assert!(err.starts_with("Could not connect"), "{err}");

            // invalid method name
            let err = execute(&st, req("BAD METHOD", format!("{base}/"), vec![], Body::None)).await.err().unwrap();
            assert!(err.starts_with("Invalid method"));
        });
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn streams_chunks_as_they_arrive() {
        use std::io::Write;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut buf = [0u8; 2048];
            let _ = std::io::Read::read(&mut s, &mut buf);
            s.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n").unwrap();
            for part in ["data: one\n\n", "data: tw\u{e9}\n\n"] {
                let bytes = part.as_bytes();
                // Split the multi-byte character across two chunks.
                for piece in [&bytes[..bytes.len() - 3], &bytes[bytes.len() - 3..]] {
                    write!(s, "{:x}\r\n", piece.len()).unwrap();
                    s.write_all(piece).unwrap();
                    s.write_all(b"\r\n").unwrap();
                    s.flush().unwrap();
                    std::thread::sleep(std::time::Duration::from_millis(30));
                }
            }
            s.write_all(b"0\r\n\r\n").unwrap();
        });
        let st = state();
        let events: Mutex<Vec<StreamEvent>> = Mutex::default();
        let emit = |e: StreamEvent| events.lock().unwrap().push(e);
        stream(&st, req("GET", format!("http://{addr}/sse"), vec![], Body::None), &emit).await.unwrap();
        let ev = events.into_inner().unwrap();
        assert_eq!(ev[0].kind, "head");
        assert_eq!(ev[0].status, Some(200));
        assert!(ev.len() > 3, "chunks should arrive separately");
        let text: String = ev.iter().filter(|e| e.kind == "chunk").map(|e| e.data.as_str()).collect();
        assert_eq!(text, "data: one\n\ndata: tw\u{e9}\n\n");
        assert_eq!(ev.last().unwrap().kind, "end");
    }

    #[test]
    fn client_certificates_and_ca_files() {
        let st = state();
        let opts = |cert: Option<(&str, Option<&str>)>, ca: Option<&str>| Options {
            timeout_ms: 1000, follow_redirects: true, max_redirects: 5, verify_ssl: true, proxy: None, use_system_proxy: false, use_cookies: false,
            client_cert: cert.map(|(c, k)| ClientCert { cert_path: c.into(), key_path: k.map(Into::into) }),
            ca_path: ca.map(Into::into),
        };
        let missing = build_client(&st, &opts(Some(("/nope/cert.pem", None)), None)).err().unwrap();
        assert!(missing.contains("Could not read client certificate"), "{missing}");
        let dir = std::env::temp_dir().join(format!("lp-certs-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let junk = dir.join("junk.pem");
        std::fs::write(&junk, "not a certificate").unwrap();
        let bad = build_client(&st, &opts(None, Some(junk.to_str().unwrap()))).err().unwrap();
        assert!(bad.contains("No certificates found") || bad.contains("Invalid CA"), "{bad}");

        // A real self-signed pair, if openssl is around.
        let (cert, key) = (dir.join("c.pem"), dir.join("k.pem"));
        let made = std::process::Command::new("openssl")
            .args(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localpost-test"])
            .arg("-keyout").arg(&key).arg("-out").arg(&cert)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if made {
            let (c, k) = (cert.to_str().unwrap(), key.to_str().unwrap());
            assert!(build_client(&st, &opts(Some((c, Some(k))), Some(c))).is_ok(), "separate cert + key, and the cert as a CA bundle");
            let combined = dir.join("both.pem");
            std::fs::write(&combined, [std::fs::read(&cert).unwrap(), std::fs::read(&key).unwrap()].concat()).unwrap();
            assert!(build_client(&st, &opts(Some((combined.to_str().unwrap(), None)), None)).is_ok(), "cert and key in one file");
            let wrong_key = build_client(&st, &opts(Some((c, Some(junk.to_str().unwrap()))), None)).err().unwrap();
            assert!(wrong_key.contains("Invalid client certificate"), "{wrong_key}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
