//! WebSocket client. Each connection runs in its own task; the UI sends frames with `ws_send`
//! and receives everything (open, messages, close, errors) as `lp://ws` events.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{HeaderName, HeaderValue};
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::Connector;

use crate::http::KeyValue;
use crate::AppState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WsConnect {
    pub id: String,
    pub url: String,
    #[serde(default)]
    pub headers: Vec<KeyValue>,
    /// Values for `Sec-WebSocket-Protocol`.
    #[serde(default)]
    pub protocols: Vec<String>,
    #[serde(default = "yes")]
    pub verify_ssl: bool,
}

fn yes() -> bool {
    true
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WsEvent {
    pub id: String,
    /// "open" | "message" | "sent" | "close" | "error"
    pub kind: &'static str,
    pub time: u64,
    /// Text payload, close reason or error message.
    pub data: String,
    /// Binary payloads, base64-encoded.
    pub binary: Option<String>,
    /// Handshake response headers (open) or close code (close).
    pub headers: Vec<KeyValue>,
    pub status: Option<u16>,
    pub code: Option<u16>,
    pub elapsed_ms: Option<f64>,
}

pub enum Outgoing {
    Text(String),
    Binary(Vec<u8>),
    Close(u16, String),
}

pub type Connections = Mutex<HashMap<String, mpsc::UnboundedSender<Outgoing>>>;
pub type Emit = Arc<dyn Fn(WsEvent) + Send + Sync>;

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn event(id: &str, kind: &'static str, data: impl Into<String>) -> WsEvent {
    WsEvent { id: id.to_string(), kind, time: now_ms(), data: data.into(), binary: None, headers: vec![], status: None, code: None, elapsed_ms: None }
}

/// Accept any certificate (the "SSL certificate verification" setting is off).
#[derive(Debug)]
struct NoVerify(Arc<rustls::crypto::CryptoProvider>);

impl rustls::client::danger::ServerCertVerifier for NoVerify {
    fn verify_server_cert(
        &self, _: &rustls::pki_types::CertificateDer<'_>, _: &[rustls::pki_types::CertificateDer<'_>], _: &rustls::pki_types::ServerName<'_>,
        _: &[u8], _: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self, m: &[u8], c: &rustls::pki_types::CertificateDer<'_>, d: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(m, c, d, &self.0.signature_verification_algorithms)
    }
    fn verify_tls13_signature(
        &self, m: &[u8], c: &rustls::pki_types::CertificateDer<'_>, d: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(m, c, d, &self.0.signature_verification_algorithms)
    }
    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

fn tls_connector(verify: bool) -> Result<Connector, String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let builder = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?;
    let config = if verify {
        let mut roots = rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        builder.with_root_certificates(roots).with_no_client_auth()
    } else {
        builder.dangerous().with_custom_certificate_verifier(Arc::new(NoVerify(provider))).with_no_client_auth()
    };
    Ok(Connector::Rustls(Arc::new(config)))
}

/// Open a connection and pump it until either side closes. Returns the sender for outgoing frames
/// once the handshake succeeded.
pub async fn connect(cfg: WsConnect, emit: Emit) -> Result<mpsc::UnboundedSender<Outgoing>, String> {
    let id = cfg.id.clone();
    let mut url = cfg.url.trim().to_string();
    if !url.contains("://") {
        url = format!("ws://{url}");
    }
    let mut request = url.as_str().into_client_request().map_err(|e| format!("Invalid WebSocket URL: {e}"))?;
    for h in &cfg.headers {
        if h.key.trim().is_empty() {
            continue;
        }
        let name = HeaderName::from_bytes(h.key.trim().as_bytes()).map_err(|_| format!("Invalid header name: {}", h.key))?;
        let value = HeaderValue::from_str(&h.value).map_err(|_| format!("Invalid value for header {}", h.key))?;
        request.headers_mut().append(name, value);
    }
    if !cfg.protocols.is_empty() {
        let v = HeaderValue::from_str(&cfg.protocols.join(", ")).map_err(|e| e.to_string())?;
        request.headers_mut().insert("sec-websocket-protocol", v);
    }
    let connector = if url.starts_with("wss://") { Some(tls_connector(cfg.verify_ssl)?) } else { None };

    let started = Instant::now();
    let (stream, response) = tokio_tungstenite::connect_async_tls_with_config(request, None, false, connector)
        .await
        .map_err(|e| format!("Could not connect: {e}"))?;
    let mut open = event(&id, "open", url.clone());
    open.status = Some(response.status().as_u16());
    open.headers = response
        .headers()
        .iter()
        .map(|(k, v)| KeyValue { key: k.as_str().to_string(), value: String::from_utf8_lossy(v.as_bytes()).into_owned() })
        .collect();
    open.elapsed_ms = Some(started.elapsed().as_secs_f64() * 1000.0);
    emit(open);

    let (mut sink, mut source) = stream.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Outgoing>();
    let task_id = id.clone();
    tauri::async_runtime::spawn(async move {
        let id = task_id;
        loop {
            tokio::select! {
                out = rx.recv() => {
                    let Some(out) = out else {
                        // UI dropped the connection (tab closed): close politely.
                        let _ = sink.send(Message::Close(None)).await;
                        break;
                    };
                    let (msg, echo) = match out {
                        Outgoing::Text(t) => (Message::Text(t.clone().into()), Some((t, None))),
                        Outgoing::Binary(b) => {
                            let b64 = base64::engine::general_purpose::STANDARD.encode(&b);
                            (Message::Binary(b.into()), Some((String::new(), Some(b64))))
                        }
                        Outgoing::Close(code, reason) => (
                            Message::Close(Some(CloseFrame { code: CloseCode::from(code), reason: reason.into() })),
                            None,
                        ),
                    };
                    if let Err(e) = sink.send(msg).await {
                        emit(event(&id, "error", format!("Send failed: {e}")));
                        break;
                    }
                    if let Some((data, binary)) = echo {
                        let mut ev = event(&id, "sent", data);
                        ev.binary = binary;
                        emit(ev);
                    }
                }
                incoming = source.next() => {
                    match incoming {
                        Some(Ok(Message::Text(t))) => emit(event(&id, "message", t.to_string())),
                        Some(Ok(Message::Binary(b))) => {
                            let mut ev = event(&id, "message", String::new());
                            ev.binary = Some(base64::engine::general_purpose::STANDARD.encode(&b));
                            emit(ev);
                        }
                        Some(Ok(Message::Close(frame))) => {
                            let mut ev = event(&id, "close", frame.as_ref().map(|f| f.reason.to_string()).unwrap_or_default());
                            ev.code = frame.map(|f| u16::from(f.code));
                            emit(ev);
                            break;
                        }
                        Some(Ok(_)) => {} // ping/pong are handled by tungstenite
                        Some(Err(e)) => {
                            emit(event(&id, "error", e.to_string()));
                            let mut ev = event(&id, "close", "Connection lost");
                            ev.code = Some(1006);
                            emit(ev);
                            break;
                        }
                        None => {
                            let mut ev = event(&id, "close", "Connection closed");
                            ev.code = Some(1006);
                            emit(ev);
                            break;
                        }
                    }
                }
            }
        }
    });
    Ok(tx)
}

#[tauri::command]
pub async fn ws_connect(app: AppHandle, state: State<'_, AppState>, config: WsConnect) -> Result<(), String> {
    let id = config.id.clone();
    let emit: Emit = Arc::new(move |ev: WsEvent| {
        let _ = app.emit("lp://ws", ev);
    });
    let tx = connect(config, emit).await?;
    state.ws.lock().unwrap().insert(id, tx);
    Ok(())
}

#[tauri::command]
pub fn ws_send(state: State<'_, AppState>, id: String, text: Option<String>, base64: Option<String>) -> Result<(), String> {
    let conns = state.ws.lock().unwrap();
    let tx = conns.get(&id).ok_or("Not connected")?;
    let msg = match (text, base64) {
        (_, Some(b)) => Outgoing::Binary(base64::engine::general_purpose::STANDARD.decode(b).map_err(|e| format!("Invalid base64: {e}"))?),
        (Some(t), None) => Outgoing::Text(t),
        (None, None) => Outgoing::Text(String::new()),
    };
    tx.send(msg).map_err(|_| "Connection is closed".to_string())
}

#[tauri::command]
pub fn ws_close(state: State<'_, AppState>, id: String, code: Option<u16>, reason: Option<String>) {
    if let Some(tx) = state.ws.lock().unwrap().remove(&id) {
        let _ = tx.send(Outgoing::Close(code.unwrap_or(1000), reason.unwrap_or_default()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test(flavor = "multi_thread")]
    async fn echo_round_trip() {
        // A tiny echo server built from the same crate.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (sock, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_hdr_async(sock, |req: &tokio_tungstenite::tungstenite::handshake::server::Request, res| {
                assert_eq!(req.headers().get("x-token").unwrap(), "t1");
                Ok(res)
            })
            .await
            .unwrap();
            while let Some(Ok(m)) = ws.next().await {
                match m {
                    Message::Text(t) => ws.send(Message::Text(format!("echo:{t}").into())).await.unwrap(),
                    Message::Binary(b) => ws.send(Message::Binary(b)).await.unwrap(),
                    Message::Close(_) => break,
                    _ => {}
                }
            }
        });

        let seen: Arc<Mutex<Vec<WsEvent>>> = Arc::default();
        let sink = seen.clone();
        let emit: Emit = Arc::new(move |e| sink.lock().unwrap().push(e));
        let tx = connect(
            WsConnect {
                id: "w".into(),
                url: format!("ws://127.0.0.1:{port}/chat"),
                headers: vec![KeyValue { key: "X-Token".into(), value: "t1".into() }],
                protocols: vec![],
                verify_ssl: true,
            },
            emit,
        )
        .await
        .unwrap();
        tx.send(Outgoing::Text("hi".into())).unwrap();
        tx.send(Outgoing::Binary(vec![1, 2, 3])).unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        tx.send(Outgoing::Close(1000, "bye".into())).unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;

        let ev = seen.lock().unwrap();
        let kinds: Vec<&str> = ev.iter().map(|e| e.kind).collect();
        assert_eq!(kinds.first(), Some(&"open"));
        assert_eq!(ev[0].status, Some(101));
        assert!(ev.iter().any(|e| e.kind == "sent" && e.data == "hi"));
        assert!(ev.iter().any(|e| e.kind == "message" && e.data == "echo:hi"));
        assert!(ev.iter().any(|e| e.kind == "message" && e.binary.as_deref() == Some("AQID")));
        assert_eq!(kinds.last(), Some(&"close"));
    }

    #[tokio::test]
    async fn bad_url_and_refused_connection_fail_cleanly() {
        let emit: Emit = Arc::new(|_| {});
        let cfg = |url: &str| WsConnect { id: "x".into(), url: url.into(), headers: vec![], protocols: vec![], verify_ssl: true };
        assert!(connect(cfg("http://[::1"), emit.clone()).await.unwrap_err().contains("Invalid"));
        assert!(connect(cfg("ws://127.0.0.1:1/"), emit).await.unwrap_err().starts_with("Could not connect"));
    }
}
