// The CLI's backend: the same commands the desktop app's Rust side provides, implemented with
// Node's HTTP stack (undici) so the unchanged engine, scripting and runner can run headless.
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { CookieJar } from "tough-cookie";
import { Agent, FormData, ProxyAgent, fetch, type Dispatcher } from "undici";
import type { NativeRequest } from "../src/lib/api";
import type { HttpResponse } from "../src/types";

const BINARY = /^(image|audio|video|font)\/|application\/(pdf|octet-stream|zip)|protobuf/i;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export function nodeInvoke() {
  const jar = new CookieJar();
  const controllers = new Map<string, AbortController>();
  const agents = new Map<string, Dispatcher>();

  async function dispatcher(o: NativeRequest["options"]): Promise<Dispatcher> {
    const key = JSON.stringify([o.proxy, o.verifySsl, o.clientCert, o.caPath]);
    let d = agents.get(key);
    if (!d) {
      const tls: Record<string, unknown> = { rejectUnauthorized: o.verifySsl };
      if (o.caPath) tls.ca = await readFile(o.caPath);
      if (o.clientCert) {
        tls.cert = await readFile(o.clientCert.certPath);
        tls.key = await readFile(o.clientCert.keyPath || o.clientCert.certPath);
      }
      d = o.proxy ? new ProxyAgent({ uri: o.proxy, requestTls: tls }) : new Agent({ connect: tls });
      agents.set(key, d);
    }
    return d;
  }

  async function buildBody(b: NativeRequest["body"]) {
    switch (b.type) {
      case "text": return b.content;
      case "urlEncoded": return new URLSearchParams(b.fields.map((f) => [f.key, f.value]));
      case "formData": {
        const fd = new FormData();
        for (const f of b.fields) {
          if (f.kind === "file") fd.append(f.key, new Blob([await readFile(f.value)], f.contentType ? { type: f.contentType } : {}), basename(f.value));
          else fd.append(f.key, f.value);
        }
        return fd;
      }
      case "binary": return await readFile(b.path);
      default: return undefined;
    }
  }

  async function send(r: NativeRequest): Promise<HttpResponse> {
    const ctrl = new AbortController();
    controllers.set(r.id, ctrl);
    const timeout = r.options.timeoutMs > 0 ? AbortSignal.timeout(r.options.timeoutMs) : undefined;
    const signal = timeout ? AbortSignal.any([ctrl.signal, timeout]) : ctrl.signal;
    const start = performance.now();
    try {
      let url = /^[a-z][a-z0-9+.-]*:\/\//i.test(r.url) ? r.url : `http://${r.url}`;
      let method = r.method;
      let body = await buildBody(r.body);
      const baseHeaders = r.headers.filter((h) => h.key.trim());
      const hasUa = baseHeaders.some((h) => h.key.toLowerCase() === "user-agent");
      let res;
      let sent: { key: string; value: string }[] = [];
      for (let hop = 0; ; hop++) {
        const headers: [string, string][] = baseHeaders.map((h) => [h.key, h.value]);
        if (!hasUa) headers.push(["User-Agent", "Localpost-CLI/0.1.0"]);
        if (r.options.useCookies) {
          const cookie = await jar.getCookieString(url);
          if (cookie && !headers.some(([k]) => k.toLowerCase() === "cookie")) headers.push(["Cookie", cookie]);
        }
        sent = headers.map(([key, value]) => ({ key, value }));
        res = await fetch(url, { method, headers, body: body as any, redirect: "manual", signal, dispatcher: await dispatcher(r.options) });
        if (r.options.useCookies) for (const c of res.headers.getSetCookie()) await jar.setCookie(c, url, { ignoreError: true });
        const location = res.headers.get("location");
        if (!r.options.followRedirects || !REDIRECTS.has(res.status) || !location) break;
        if (hop + 1 >= Math.max(1, r.options.maxRedirects)) throw new Error("Too many redirects");
        await res.arrayBuffer();
        url = new URL(location, url).toString();
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) { method = "GET"; body = undefined; }
      }
      const ttfb = performance.now() - start;
      const buf = new Uint8Array(await res.arrayBuffer());
      const headers: { key: string; value: string }[] = [];
      res.headers.forEach((value, key) => { if (key !== "set-cookie") headers.push({ key, value }); });
      for (const c of res.headers.getSetCookie()) headers.push({ key: "set-cookie", value: c });
      const ct = res.headers.get("content-type") ?? "";
      let text = "";
      let utf8 = true;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { utf8 = false; }
      const isBinary = BINARY.test(ct) || !utf8;
      return {
        status: res.status, statusText: res.statusText, httpVersion: "HTTP/1.1", url, remoteAddr: null,
        headers, requestHeaders: sent,
        bodyText: isBinary && !utf8 ? "" : text,
        bodyBase64: isBinary ? Buffer.from(buf).toString("base64") : null,
        isBinary, size: buf.length, headersSize: headers.reduce((n, h) => n + h.key.length + h.value.length + 4, 0),
        timeMs: performance.now() - start, ttfbMs: ttfb,
      };
    } catch (e: any) {
      if (ctrl.signal.aborted) throw "Request cancelled";
      if (timeout?.aborted) throw "Request timed out";
      const cause = e?.cause?.message ?? e?.cause?.code;
      throw `Could not send request: ${e?.message ?? e}${cause ? `: ${cause}` : ""}`;
    } finally {
      controllers.delete(r.id);
    }
  }

  return async (cmd: string, args: any = {}): Promise<unknown> => {
    switch (cmd) {
      case "send_request": return send(args.request);
      case "cancel_request": controllers.get(args.id)?.abort(); return;
      case "read_text_file": return readFile(args.path, "utf8");
      case "get_data_dir": return process.cwd();
      default: throw new Error(`${cmd} is not available in the CLI`);
    }
  };
}
