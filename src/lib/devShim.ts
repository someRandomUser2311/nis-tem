// Development-only stand-in for the Rust backend, used when the Vite dev server is
// opened in a plain browser (outside Tauri) for UI work. Stripped from production builds.
import type { HttpResponse } from "../types";
import type { NativeRequest } from "./api";

const controllers = new Map<string, AbortController>();

export async function devInvoke<T>(cmd: string, args: any = {}): Promise<T> {
  switch (cmd) {
    case "store_read": return (localStorage.getItem(`lp.store.${args.name}`) ?? null) as T;
    case "store_write": localStorage.setItem(`lp.store.${args.name}`, args.content); return undefined as T;
    case "get_data_dir": return "(browser preview — localStorage)" as T;
    case "list_cookies": return [] as T;
    case "list_user_themes": return { dir: "", themes: [] } as T;
    case "secrets_read": return (localStorage.getItem("lp.dev.keychain") ?? "{}") as T;
    case "secrets_write": localStorage.setItem("lp.dev.keychain", args.content); return undefined as T;
    case "secrets_clear": localStorage.removeItem("lp.dev.keychain"); return undefined as T;
    case "clear_cookies": case "delete_cookie": return undefined as T;
    case "cancel_request": controllers.get(args.id)?.abort(); return undefined as T;
    case "send_request": return (await send(args.request)) as T;
    case "stream_request": return (await stream(args.request)) as T;
    case "ws_connect": return (await wsConnect(args.config)) as T;
    case "ws_send": {
      const ws = sockets.get(args.id);
      if (!ws || ws.readyState !== WebSocket.OPEN) throw "Connection is closed";
      ws.send(args.text ?? "");
      emit("lp://ws", wsEv(args.id, "sent", args.text ?? ""));
      return undefined as T;
    }
    case "load_start": return (await devLoad(args.config)) as T;
    case "docs_open_page": {
      // Browser preview: show the generated page in a new tab instead of the system browser.
      const url = URL.createObjectURL(new Blob([args.content], { type: "text/html" }));
      window.open(url, "_blank");
      return url as T;
    }
    case "load_stop": loadStops.add(args.id); return undefined as T;
    case "ws_close": sockets.get(args.id)?.close(args.code ?? 1000, args.reason ?? ""); return undefined as T;
    default: throw new Error(`${cmd} is not available in browser preview`);
  }
}

async function send(r: NativeRequest): Promise<HttpResponse> {
  const ctrl = new AbortController();
  controllers.set(r.id, ctrl);
  const headers = new Headers();
  for (const h of r.headers) headers.append(h.key, h.value);
  let body: BodyInit | undefined;
  if (r.body.type === "text") body = r.body.content;
  if (r.body.type === "urlEncoded") body = new URLSearchParams(r.body.fields.map((f) => [f.key, f.value]));
  if (r.body.type === "formData") { const fd = new FormData(); r.body.fields.forEach((f) => fd.append(f.key, f.value)); body = fd; }
  const start = performance.now();
  try {
    const res = await fetch(r.url, { method: r.method, headers, body, signal: ctrl.signal, redirect: r.options.followRedirects ? "follow" : "manual" });
    const ttfb = performance.now() - start;
    const buf = new Uint8Array(await res.arrayBuffer());
    const text = new TextDecoder().decode(buf);
    const hs = [...res.headers.entries()].map(([key, value]) => ({ key, value }));
    const ct = res.headers.get("content-type") ?? "";
    const isBinary = /^(image|audio|video|font)\/|pdf|octet-stream|zip/.test(ct);
    const bodyBase64 = isBinary ? btoa(Array.from(buf, (b) => String.fromCharCode(b)).join("")) : null;
    return {
      status: res.status, statusText: res.statusText, httpVersion: "HTTP/1.1", url: res.url, remoteAddr: null,
      headers: hs, requestHeaders: r.headers, bodyText: isBinary ? "" : text, bodyBase64, isBinary,
      size: buf.length, headersSize: hs.reduce((a, h) => a + h.key.length + h.value.length + 4, 0),
      timeMs: performance.now() - start, ttfbMs: ttfb,
    };
  } catch (e) {
    throw ctrl.signal.aborted ? "Request cancelled" : `Request failed: ${e}`;
  } finally {
    controllers.delete(r.id);
  }
}

// ---- streaming + WebSocket, via the browser's own APIs (headers can't be set on a browser WebSocket)

const emit = (topic: string, payload: unknown) => window.dispatchEvent(new CustomEvent("lp-dev-event", { detail: { topic, payload } }));
const sockets = new Map<string, WebSocket>();
const wsEv = (id: string, kind: string, data = "", extra: Record<string, unknown> = {}) =>
  ({ id, kind, time: Date.now(), data, binary: null, headers: [], status: null, code: null, elapsedMs: null, ...extra });

function wsConnect(cfg: { id: string; url: string; protocols: string[] }) {
  return new Promise<void>((resolve, reject) => {
    const start = performance.now();
    let ws: WebSocket;
    try { ws = new WebSocket(cfg.url, cfg.protocols.length ? cfg.protocols : undefined); } catch (e) { return reject(`Invalid WebSocket URL: ${e}`); }
    sockets.set(cfg.id, ws);
    let opened = false;
    ws.onopen = () => { opened = true; emit("lp://ws", wsEv(cfg.id, "open", cfg.url, { status: 101, elapsedMs: performance.now() - start })); resolve(); };
    ws.onmessage = (m) => emit("lp://ws", wsEv(cfg.id, "message", typeof m.data === "string" ? m.data : "(binary)"));
    ws.onclose = (c) => {
      sockets.delete(cfg.id);
      if (!opened) reject("Could not connect");
      else emit("lp://ws", wsEv(cfg.id, "close", c.reason, { code: c.code }));
    };
  });
}

async function stream(r: NativeRequest) {
  const ctrl = new AbortController();
  controllers.set(r.id, ctrl);
  const start = performance.now();
  const ev = (kind: string, extra: Record<string, unknown> = {}) =>
    emit("lp://stream", { id: r.id, kind, status: null, statusText: null, headers: [], data: "", elapsedMs: performance.now() - start, ...extra });
  try {
    const headers = new Headers();
    for (const h of r.headers) headers.append(h.key, h.value);
    const res = await fetch(r.url, { method: r.method, headers, body: r.body.type === "text" ? r.body.content : undefined, signal: ctrl.signal });
    ev("head", { status: res.status, statusText: res.statusText, headers: [...res.headers.entries()].map(([key, value]) => ({ key, value })) });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      ev("chunk", { data: dec.decode(value, { stream: true }) });
    }
    ev("end");
  } catch (e) {
    throw ctrl.signal.aborted ? "Request cancelled" : `Request failed: ${e}`;
  } finally {
    controllers.delete(r.id);
  }
}

// ---- load test simulation (browser preview only; the desktop app does this in Rust)

const loadStops = new Set<string>();

async function devLoad(c: { id: string; request: NativeRequest; vus: number; durationSecs: number; rampUpSecs: number; maxRequests: number; thinkMs: number }) {
  const start = performance.now();
  const end = start + c.durationSecs * 1000;
  const all: number[] = [];
  let interval: number[] = [];
  const statuses: Record<string, number> = {};
  let errors = 0, total = 0, active = 0, lastError: string | null = null;
  const pct = (xs: number[]) => {
    if (!xs.length) return { p50: 0, p90: 0, p95: 0, p99: 0, max: 0, mean: 0 };
    const s = [...xs].sort((a, b) => a - b);
    const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    return { p50: q(0.5), p90: q(0.9), p95: q(0.95), p99: q(0.99), max: s[s.length - 1], mean: s.reduce((a, b) => a + b, 0) / s.length };
  };
  const snap = (kind: string, secs: number) => {
    const ev = { id: c.id, kind, elapsedMs: Math.round(performance.now() - start), activeVus: active, total, errors, rps: interval.length / Math.max(secs, 0.001), interval: pct(interval), overall: pct(all), statuses: { ...statuses }, lastError };
    interval = [];
    emit("lp://load", ev);
  };
  const worker = async (i: number) => {
    await new Promise((r) => setTimeout(r, (c.rampUpSecs * 1000 * i) / Math.max(1, c.vus)));
    active++;
    while (performance.now() < end && !loadStops.has(c.id) && (!c.maxRequests || total < c.maxRequests)) {
      total++;
      const t0 = performance.now();
      try {
        const res = await fetch(c.request.url, { method: c.request.method, headers: c.request.headers.map((h) => [h.key, h.value] as [string, string]), body: c.request.body.type === "text" ? c.request.body.content : undefined });
        await res.arrayBuffer();
        statuses[res.status] = (statuses[res.status] ?? 0) + 1;
        const ms = performance.now() - t0;
        all.push(ms); interval.push(ms);
      } catch (e) {
        errors++; statuses.error = (statuses.error ?? 0) + 1; lastError = String(e); interval.push(performance.now() - t0);
      }
      if (c.thinkMs) await new Promise((r) => setTimeout(r, c.thinkMs));
    }
    active--;
  };
  let last = performance.now();
  const timer = setInterval(() => { const now = performance.now(); snap("tick", (now - last) / 1000); last = now; }, 1000);
  await Promise.all(Array.from({ length: Math.min(c.vus, 50) }, (_, i) => worker(i)));
  clearInterval(timer);
  loadStops.delete(c.id);
  snap("done", (performance.now() - last) / 1000);
}
