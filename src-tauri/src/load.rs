//! Load testing: N virtual users send the same (already prepared) request in a loop for a fixed
//! duration or request count. Latencies go into HDR histograms; every second an `lp://load`
//! event reports throughput, percentiles, errors and status codes.

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use hdrhistogram::Histogram;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::http::{build_client, build_request, HttpRequest};
use crate::AppState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadConfig {
    pub id: String,
    pub request: HttpRequest,
    /// Concurrent virtual users (1–1000).
    pub vus: u32,
    /// Test length in seconds (1–3600).
    pub duration_secs: u64,
    /// Virtual users start evenly spread over this many seconds.
    #[serde(default)]
    pub ramp_up_secs: u64,
    /// Stop after this many requests in total (0 = no limit).
    #[serde(default)]
    pub max_requests: u64,
    /// Pause per virtual user between requests.
    #[serde(default)]
    pub think_ms: u64,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Percentiles {
    pub p50: f64,
    pub p90: f64,
    pub p95: f64,
    pub p99: f64,
    pub max: f64,
    pub mean: f64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LoadEvent {
    pub id: String,
    /// "tick" (every second) or "done".
    pub kind: &'static str,
    pub elapsed_ms: u64,
    pub active_vus: u32,
    pub total: u64,
    pub errors: u64,
    /// Requests completed in the last interval, per second.
    pub rps: f64,
    /// Latency (ms) of requests completed in the last interval.
    pub interval: Percentiles,
    /// Latency (ms) of all requests so far.
    pub overall: Percentiles,
    /// Status code → count (cumulative); "error" for transport errors.
    pub statuses: BTreeMap<String, u64>,
    pub last_error: Option<String>,
}

struct Stats {
    interval: Histogram<u64>,
    overall: Histogram<u64>,
    interval_count: u64,
    statuses: BTreeMap<String, u64>,
    errors: u64,
    last_error: Option<String>,
}

fn percentiles(h: &Histogram<u64>) -> Percentiles {
    if h.is_empty() {
        return Percentiles::default();
    }
    let ms = |us: u64| us as f64 / 1000.0;
    Percentiles {
        p50: ms(h.value_at_quantile(0.50)),
        p90: ms(h.value_at_quantile(0.90)),
        p95: ms(h.value_at_quantile(0.95)),
        p99: ms(h.value_at_quantile(0.99)),
        max: ms(h.max()),
        mean: h.mean() / 1000.0,
    }
}

pub type Loads = Mutex<HashMap<String, Arc<AtomicBool>>>;
pub type Emit = Arc<dyn Fn(LoadEvent) + Send + Sync>;

pub async fn run(state: &AppState, mut cfg: LoadConfig, stop: Arc<AtomicBool>, emit: Emit) -> Result<LoadEvent, String> {
    let vus = cfg.vus.clamp(1, 1000);
    let duration = Duration::from_secs(cfg.duration_secs.clamp(1, 3600));
    let ramp = Duration::from_secs(cfg.ramp_up_secs.min(cfg.duration_secs));
    // Load tests don't touch the shared cookie jar.
    cfg.request.options.use_cookies = false;
    let client = build_client(state, &cfg.request.options)?;
    // Fail fast on a request that can't even be built.
    build_request(&client, cfg.request.clone()).await?;

    let new_hist = || Histogram::<u64>::new_with_bounds(1, 120_000_000, 3).expect("histogram bounds");
    let stats = Arc::new(Mutex::new(Stats { interval: new_hist(), overall: new_hist(), interval_count: 0, statuses: BTreeMap::new(), errors: 0, last_error: None }));
    let total = Arc::new(AtomicU64::new(0));
    let active = Arc::new(AtomicU64::new(0));
    let start = Instant::now();
    let deadline = start + duration;
    let max = cfg.max_requests;

    let mut workers = Vec::new();
    for i in 0..vus {
        let client = client.clone();
        let req = cfg.request.clone();
        let (stats, total, active, stop) = (stats.clone(), total.clone(), active.clone(), stop.clone());
        let delay = if vus > 1 { ramp.mul_f64(i as f64 / vus as f64) } else { Duration::ZERO };
        let think = Duration::from_millis(cfg.think_ms);
        workers.push(tauri::async_runtime::spawn(async move {
            tokio::time::sleep(delay).await;
            active.fetch_add(1, Ordering::Relaxed);
            while !stop.load(Ordering::Relaxed) && Instant::now() < deadline {
                if max > 0 && total.fetch_add(1, Ordering::Relaxed) >= max {
                    break;
                }
                let t0 = Instant::now();
                let outcome = match build_request(&client, req.clone()).await {
                    Ok((built, _)) => match tokio::time::timeout(deadline.saturating_duration_since(t0) + Duration::from_secs(30), client.execute(built)).await {
                        Ok(Ok(resp)) => {
                            let status = resp.status().as_u16();
                            match resp.bytes().await {
                                Ok(_) => Ok(status),
                                Err(e) => Err(e.to_string()),
                            }
                        }
                        Ok(Err(e)) => Err(e.to_string()),
                        Err(_) => Err("timed out".to_string()),
                    },
                    Err(e) => Err(e),
                };
                let us = t0.elapsed().as_micros().clamp(1, 120_000_000) as u64;
                if max == 0 {
                    total.fetch_add(1, Ordering::Relaxed);
                }
                {
                    let mut s = stats.lock().unwrap();
                    match outcome {
                        Ok(code) => {
                            let _ = s.interval.record(us);
                            let _ = s.overall.record(us);
                            s.interval_count += 1;
                            *s.statuses.entry(code.to_string()).or_insert(0) += 1;
                        }
                        Err(e) => {
                            s.errors += 1;
                            s.interval_count += 1;
                            *s.statuses.entry("error".into()).or_insert(0) += 1;
                            s.last_error = Some(e);
                        }
                    }
                }
                if !think.is_zero() {
                    tokio::time::sleep(think).await;
                }
            }
            active.fetch_sub(1, Ordering::Relaxed);
        }));
    }

    let snapshot = |kind: &'static str, interval_secs: f64| {
        let mut s = stats.lock().unwrap();
        let interval = percentiles(&s.interval);
        let rps = if interval_secs > 0.0 { s.interval_count as f64 / interval_secs } else { 0.0 };
        s.interval.reset();
        s.interval_count = 0;
        let done = total.load(Ordering::Relaxed);
        LoadEvent {
            id: cfg.id.clone(),
            kind,
            elapsed_ms: start.elapsed().as_millis() as u64,
            active_vus: active.load(Ordering::Relaxed) as u32,
            total: if max > 0 { done.min(max) } else { done },
            errors: s.errors,
            rps,
            interval,
            overall: percentiles(&s.overall),
            statuses: s.statuses.clone(),
            last_error: s.last_error.clone(),
        }
    };

    let mut last = Instant::now();
    let mut ticker = tokio::time::interval(Duration::from_secs(1));
    ticker.tick().await;
    loop {
        let finished = workers.iter().all(|w| w.inner().is_finished());
        if finished {
            break;
        }
        ticker.tick().await;
        let secs = last.elapsed().as_secs_f64();
        last = Instant::now();
        emit(snapshot("tick", secs));
    }
    for w in workers {
        let _ = w.await;
    }
    let done = snapshot("done", last.elapsed().as_secs_f64());
    emit(done.clone());
    Ok(done)
}

#[tauri::command]
pub async fn load_start(app: AppHandle, state: State<'_, AppState>, config: LoadConfig) -> Result<(), String> {
    let id = config.id.clone();
    let stop = Arc::new(AtomicBool::new(false));
    state.loads.lock().unwrap().insert(id.clone(), stop.clone());
    let emit: Emit = Arc::new(move |ev: LoadEvent| {
        let _ = app.emit("lp://load", ev);
    });
    let result = run(&state, config, stop, emit).await;
    state.loads.lock().unwrap().remove(&id);
    result.map(|_| ())
}

#[tauri::command]
pub fn load_stop(state: State<'_, AppState>, id: String) {
    if let Some(stop) = state.loads.lock().unwrap().get(&id) {
        stop.store(true, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[tokio::test(flavor = "multi_thread")]
    async fn runs_bounded_load_and_reports() {
        // Keep-alive HTTP server that answers 200 / 503 alternately.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let hits = Arc::new(AtomicU64::new(0));
        let h = hits.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let h = h.clone();
                std::thread::spawn(move || {
                    let mut s = stream;
                    let mut buf = [0u8; 4096];
                    while let Ok(n) = s.read(&mut buf) {
                        if n == 0 {
                            break;
                        }
                        let i = h.fetch_add(1, Ordering::Relaxed);
                        let status = if i % 2 == 0 { "200 OK" } else { "503 Service Unavailable" };
                        let _ = s.write_all(format!("HTTP/1.1 {status}\r\nContent-Length: 2\r\n\r\nok").as_bytes());
                    }
                });
            }
        });
        let request: HttpRequest = serde_json::from_value(serde_json::json!({
            "id": "l", "method": "GET", "url": format!("http://{addr}/"), "headers": [], "body": { "type": "none" },
            "options": { "timeoutMs": 5000, "followRedirects": true, "maxRedirects": 5, "verifySsl": true, "proxy": null, "useSystemProxy": false, "useCookies": true }
        }))
        .unwrap();
        let st = AppState::new(std::env::temp_dir(), std::env::temp_dir().join(format!("lp-load-{}", std::process::id())));
        let events: Arc<Mutex<Vec<LoadEvent>>> = Arc::default();
        let sink = events.clone();
        let cfg = LoadConfig { id: "l".into(), request, vus: 4, duration_secs: 10, ramp_up_secs: 0, max_requests: 40, think_ms: 0 };
        let done = run(&st, cfg, Arc::new(AtomicBool::new(false)), Arc::new(move |e| sink.lock().unwrap().push(e))).await.unwrap();
        assert_eq!(done.kind, "done");
        assert_eq!(done.total, 40);
        assert_eq!(hits.load(Ordering::Relaxed), 40, "max_requests is respected exactly");
        assert_eq!(done.statuses.get("200").copied().unwrap_or(0) + done.statuses.get("503").copied().unwrap_or(0), 40);
        assert!(done.overall.p50 > 0.0 && done.overall.p99 >= done.overall.p50);
        assert_eq!(events.lock().unwrap().last().unwrap().kind, "done");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn stop_flag_ends_the_test() {
        let request: HttpRequest = serde_json::from_value(serde_json::json!({
            "id": "s", "method": "GET", "url": "http://127.0.0.1:1/", "headers": [], "body": { "type": "none" },
            "options": { "timeoutMs": 1000, "followRedirects": true, "maxRedirects": 5, "verifySsl": true, "proxy": null, "useSystemProxy": false, "useCookies": false }
        }))
        .unwrap();
        let st = AppState::new(std::env::temp_dir(), std::env::temp_dir());
        let stop = Arc::new(AtomicBool::new(false));
        let s2 = stop.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            s2.store(true, Ordering::Relaxed);
        });
        let t0 = Instant::now();
        let done = run(&st, LoadConfig { id: "s".into(), request, vus: 2, duration_secs: 30, ramp_up_secs: 0, max_requests: 0, think_ms: 10 }, stop, Arc::new(|_| {})).await.unwrap();
        assert!(t0.elapsed() < Duration::from_secs(5), "stopping must not wait for the full duration");
        assert!(done.errors > 0 && done.statuses.contains_key("error"), "connection refused counts as errors");
    }
}
