// The request pipeline:
//   pre-request scripts (collection → folders → request)
//   → resolve variables + auth → send natively → test scripts (collection → folders → request)
import type { Auth, Collection, FolderItem, HttpResponse, RequestItem, RunResult, Settings, TestResult } from "../types";
import { api, type NativeRequest } from "./api";
import { runScript, ScriptRequest, type HeaderEntry } from "./scripting";
import { resolve, type Scopes } from "./vars";
import { applyPathVariables, getHeader, uid } from "./utils";
import { awsV4Headers, digestAuthorization, digestUri, hawkHeader, parseDigestChallenge } from "./authsign";
import { oauthConfig } from "./oauth";
import { validateSchema } from "./schema";

export interface Logger {
  (level: "log" | "info" | "warn" | "error" | "request", message: string, detail?: unknown): void;
}

export function effectiveAuth(req: { auth: Auth }, folders: FolderItem[], collection?: Collection): Auth {
  if (req.auth.type !== "inherit") return req.auth;
  for (let i = folders.length - 1; i >= 0; i--) {
    if (folders[i].auth.type !== "inherit") return folders[i].auth;
  }
  if (collection && collection.auth.type !== "inherit") return collection.auth;
  return { ...req.auth, type: "none" };
}

const RAW_CONTENT_TYPES: Record<string, string> = {
  json: "application/json",
  text: "text/plain",
  xml: "application/xml",
  html: "text/html",
  javascript: "application/javascript",
};

export interface PreparedRequest {
  method: string;
  url: string;
  headers: HeaderEntry[];
  body: NativeRequest["body"];
  /** Body as text, for code generation / console. */
  bodyPreview?: string;
}

/**
 * Turn an editor request into a concrete request: variables substituted, auth applied,
 * implicit Content-Type added. `urlOverride`/`headersOverride` come from pre-request scripts.
 */
export function prepareRequest(
  req: RequestItem,
  auth: Auth,
  scopes: Scopes,
  overrides?: { url?: string; method?: string; headers?: HeaderEntry[]; raw?: string },
): PreparedRequest {
  const r = (s: string) => resolve(s, scopes);
  let url = r(applyPathVariables(overrides?.url ?? req.url, req.pathVariables)).trim();
  const method = r(overrides?.method ?? req.method).toUpperCase();

  const source: HeaderEntry[] = overrides?.headers ?? req.headers.filter((h) => h.enabled && h.key.trim()).map((h) => ({ key: h.key, value: h.value }));
  const headers: HeaderEntry[] = source
    .filter((h) => !h.disabled && h.key.trim())
    .map((h) => ({ key: r(h.key), value: r(h.value) }));
  const hasHeader = (k: string) => headers.some((h) => h.key.toLowerCase() === k.toLowerCase());

  // Auth
  switch (auth.type) {
    case "basic": {
      const token = btoa(unescape(encodeURIComponent(`${r(auth.basic.username)}:${r(auth.basic.password)}`)));
      if (!hasHeader("authorization")) headers.push({ key: "Authorization", value: `Basic ${token}` });
      break;
    }
    case "bearer": {
      const prefix = auth.bearer.prefix?.trim() ?? "Bearer";
      if (!hasHeader("authorization")) headers.push({ key: "Authorization", value: `${prefix ? prefix + " " : ""}${r(auth.bearer.token)}` });
      break;
    }
    case "apikey": {
      const k = r(auth.apikey.key), v = r(auth.apikey.value);
      if (!k) break;
      if (auth.apikey.in === "query") {
        url += (url.includes("?") ? "&" : "?") + `${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
      } else if (!hasHeader(k)) headers.push({ key: k, value: v });
      break;
    }
    case "oauth2": {
      const c = oauthConfig(auth.oauth2);
      const token = c.token?.accessToken;
      if (!token) break;
      if (c.addTo === "query") url += (url.includes("?") ? "&" : "?") + `access_token=${encodeURIComponent(token)}`;
      else if (!hasHeader("authorization")) headers.push({ key: "Authorization", value: `${c.headerPrefix.trim() ? `${c.headerPrefix.trim()} ` : ""}${token}` });
      break;
    }
    // digest / awsv4 / hawk need the final URL and body, and async crypto: see signRequest().
  }

  // Body
  let body: NativeRequest["body"] = { type: "none" };
  let bodyPreview: string | undefined;
  const b = req.body;
  switch (b.mode) {
    case "raw": {
      const content = r(overrides?.raw ?? b.raw);
      body = { type: "text", content };
      bodyPreview = content;
      if (!hasHeader("content-type")) headers.push({ key: "Content-Type", value: RAW_CONTENT_TYPES[b.rawLanguage] ?? "text/plain" });
      break;
    }
    case "graphql": {
      let variables: unknown = undefined;
      const vs = r(b.graphql.variables).trim();
      if (vs) {
        try { variables = JSON.parse(vs); } catch { throw new Error("GraphQL variables are not valid JSON"); }
      }
      const content = JSON.stringify({ query: r(b.graphql.query), ...(variables ? { variables } : {}) });
      body = { type: "text", content };
      bodyPreview = content;
      if (!hasHeader("content-type")) headers.push({ key: "Content-Type", value: "application/json" });
      break;
    }
    case "urlencoded": {
      const fields = b.urlencoded.filter((f) => f.enabled && f.key).map((f) => ({ key: r(f.key), value: r(f.value) }));
      body = { type: "urlEncoded", fields };
      bodyPreview = fields.map((f) => `${encodeURIComponent(f.key)}=${encodeURIComponent(f.value)}`).join("&");
      break;
    }
    case "formdata": {
      const fields = b.formdata.filter((f) => f.enabled && f.key).map((f) => ({
        key: r(f.key),
        value: f.type === "file" ? f.value : r(f.value),
        kind: (f.type ?? "text") as "text" | "file",
      }));
      body = { type: "formData", fields };
      bodyPreview = fields.map((f) => `${f.key}: ${f.kind === "file" ? `@${f.value}` : f.value}`).join("\n");
      break;
    }
    case "binary":
      if (b.binaryPath) {
        body = { type: "binary", path: b.binaryPath };
        bodyPreview = `@${b.binaryPath}`;
      }
      break;
  }

  if (url && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !url.startsWith("{{")) url = `http://${url}`;
  return { method, url, headers, body, bodyPreview };
}

/** The client certificate configured for a URL's host (Settings → Certificates), if any. */
export function certificateFor(settings: Settings, url: string) {
  let host = "", port = "";
  try { const u = new URL(url); host = u.hostname.toLowerCase(); port = u.port || (u.protocol === "https:" || u.protocol === "wss:" ? "443" : "80"); } catch { return null; }
  const c = (settings.certificates ?? []).find((c) => {
    if (!c.enabled || !c.certPath || !c.host.trim()) return false;
    const [pHost, pPort] = c.host.trim().toLowerCase().replace(/^https?:\/\//, "").split(":");
    if (pPort && pPort !== port) return false;
    return pHost.startsWith("*.") ? host.endsWith(pHost.slice(1)) || host === pHost.slice(2) : host === pHost;
  });
  return c ? { certPath: c.certPath, keyPath: c.keyPath || undefined } : null;
}

export function nativeOptions(settings: Settings, req?: RequestItem, url?: string): NativeRequest["options"] {
  return {
    clientCert: url ? certificateFor(settings, url) : null,
    caPath: settings.caPath || null,
    timeoutMs: req?.settings.timeoutMs ?? settings.timeoutMs,
    followRedirects: req?.settings.followRedirects ?? settings.followRedirects,
    maxRedirects: settings.maxRedirects,
    verifySsl: req?.settings.verifySsl ?? settings.verifySsl,
    proxy: settings.proxy || null,
    useSystemProxy: settings.useSystemProxy,
    useCookies: settings.useCookies,
  };
}

/** pm.sendRequest(...) accepts a URL string or a Postman-style request object. */
function scriptRequestToNative(input: any, scopes: Scopes, settings: Settings): NativeRequest {
  const r = (s: string) => resolve(String(s ?? ""), scopes);
  if (typeof input === "string") {
    return { id: uid(), method: "GET", url: r(input), headers: [], body: { type: "none" }, options: nativeOptions(settings, undefined, r(input)) };
  }
  let headers: { key: string; value: string }[] = [];
  const h = input.header ?? input.headers;
  if (Array.isArray(h)) headers = h.map((x: any) => ({ key: r(x.key), value: r(x.value) }));
  else if (h && typeof h === "object") headers = Object.entries(h).map(([key, value]) => ({ key: r(key), value: r(String(value)) }));

  let body: NativeRequest["body"] = { type: "none" };
  const b = input.body;
  if (typeof b === "string") body = { type: "text", content: r(b) };
  else if (b?.mode === "raw") body = { type: "text", content: r(typeof b.raw === "string" ? b.raw : JSON.stringify(b.raw)) };
  else if (b?.mode === "urlencoded") body = { type: "urlEncoded", fields: (b.urlencoded ?? []).map((f: any) => ({ key: r(f.key), value: r(f.value) })) };
  else if (b?.mode === "formdata") body = { type: "formData", fields: (b.formdata ?? []).map((f: any) => ({ key: r(f.key), value: r(f.value), kind: "text" as const })) };

  const url = typeof input.url === "string" ? input.url : input.url?.raw ?? String(input.url ?? "");
  return { id: uid(), method: String(input.method ?? "GET").toUpperCase(), url: r(url), headers, body, options: nativeOptions(settings, undefined, r(url)) };
}

/** Auth schemes that sign the final request (AWS Signature V4, Hawk). Returns extra headers. */
export async function signRequest(prepared: PreparedRequest, auth: Auth, scopes: Scopes): Promise<HeaderEntry[]> {
  const r = (s: string) => resolve(s ?? "", scopes);
  const body = prepared.body.type === "text" ? prepared.body.content : prepared.body.type === "none" ? "" : prepared.bodyPreview;
  if (auth.type === "awsv4" && auth.awsv4) {
    const a = auth.awsv4;
    if (!r(a.accessKey) || !r(a.secretKey)) throw new Error("AWS Signature: enter an access key and secret key");
    return awsV4Headers(prepared.method, prepared.url, prepared.headers,
      prepared.body.type === "formData" || prepared.body.type === "binary" ? undefined : body,
      { accessKey: r(a.accessKey), secretKey: r(a.secretKey), sessionToken: r(a.sessionToken) || undefined, region: r(a.region) || "us-east-1", service: r(a.service) || "execute-api" });
  }
  if (auth.type === "hawk" && auth.hawk) {
    const h = auth.hawk;
    if (!r(h.id) || !r(h.key)) throw new Error("Hawk: enter the Hawk auth id and key");
    const value = await hawkHeader(prepared.method, prepared.url, { id: r(h.id), key: r(h.key), algorithm: h.algorithm, ext: r(h.ext) || undefined, includePayloadHash: h.includePayloadHash },
      { contentType: getHeader(prepared.headers, "content-type"), body });
    return [{ key: "Authorization", value }];
  }
  return [];
}

export interface ExecuteParams {
  request: RequestItem;
  collection?: Collection;
  folders: FolderItem[];
  scopes: Scopes;
  settings: Settings;
  log: Logger;
  /** Native request id — used for cancellation. */
  requestId: string;
  iteration?: number;
  iterationCount?: number;
}

export interface ExecuteOutcome {
  result: RunResult;
  nextRequest?: string | null;
}

const fmtArgs = (args: unknown[]) =>
  args.map((a) => (typeof a === "string" ? a : (() => { try { return JSON.stringify(a, null, 2); } catch { return String(a); } })())).join(" ");

export async function executeRequest(p: ExecuteParams): Promise<ExecuteOutcome> {
  const { request, collection, folders, scopes, settings, log } = p;
  const tests: TestResult[] = [];
  let nextRequest: string | null | undefined;

  const info = (eventName: "prerequest" | "test") => ({
    eventName, requestName: request.name, requestId: request.id,
    iteration: p.iteration ?? 0, iterationCount: p.iterationCount ?? 1,
  });

  const scriptReq = new ScriptRequest(
    request.url, request.method,
    request.headers.filter((h) => h.enabled && h.key.trim()).map((h) => ({ key: h.key, value: h.value })),
    { mode: request.body.mode, raw: request.body.raw },
    request.name, request.id,
  );

  const sendFromScript = (input: unknown) => {
    const native = scriptRequestToNative(input, scopes, settings);
    log("request", `${native.method} ${native.url} (pm.sendRequest)`);
    return api.send(native);
  };
  const scriptLog = (level: "log" | "info" | "warn" | "error", args: unknown[]) => log(level, fmtArgs(args));

  const scriptsOf = (kind: "preRequestScript" | "testScript") =>
    [
      collection ? { label: `collection "${collection.name}"`, code: collection[kind] } : null,
      ...folders.map((f) => ({ label: `folder "${f.name}"`, code: f[kind] })),
      { label: `request "${request.name}"`, code: request[kind] },
    ].filter((s): s is { label: string; code: string } => !!s && !!s.code?.trim());

  // ---- pre-request ----
  let skip = false;
  for (const s of scriptsOf("preRequestScript")) {
    const out = await runScript(s.code, { scopes, request: scriptReq, info: info("prerequest"), log: scriptLog, sendRequest: sendFromScript });
    tests.push(...out.tests);
    if (out.nextRequest !== undefined) nextRequest = out.nextRequest;
    if (out.skipRequest) skip = true;
    if (out.error) {
      log("error", `Pre-request script error in ${s.label}: ${out.error}`);
      return { result: { error: `Pre-request script error in ${s.label}: ${out.error}`, tests, resolvedUrl: request.url, resolvedMethod: request.method }, nextRequest };
    }
  }
  if (skip) {
    log("info", `Request "${request.name}" skipped by pre-request script`);
    return { result: { error: "Request skipped by pre-request script", tests, resolvedUrl: request.url, resolvedMethod: request.method }, nextRequest };
  }

  // ---- resolve + send ----
  let prepared: PreparedRequest;
  try {
    prepared = prepareRequest(request, effectiveAuth(request, folders, collection), scopes, {
      url: scriptReq.rawUrl, method: scriptReq.method, headers: scriptReq.headers.list,
      raw: typeof scriptReq.body?.raw === "string" ? scriptReq.body.raw : undefined,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { result: { error: msg, tests, resolvedUrl: request.url, resolvedMethod: request.method }, nextRequest };
  }
  if (!prepared.url) {
    return { result: { error: "Enter a URL to send the request", tests, resolvedUrl: "", resolvedMethod: prepared.method }, nextRequest };
  }

  const auth = effectiveAuth(request, folders, collection);
  let response: HttpResponse;
  try {
    const signed = await signRequest(prepared, auth, scopes);
    if (signed.length) {
      const names = new Set(signed.map((h) => h.key.toLowerCase()));
      prepared = { ...prepared, headers: [...prepared.headers.filter((h) => !names.has(h.key.toLowerCase())), ...signed] };
    }
    const native = {
      id: p.requestId,
      method: prepared.method,
      url: prepared.url,
      headers: prepared.headers,
      body: prepared.body,
      options: nativeOptions(settings, request, prepared.url),
    };
    response = await api.send(native);
    // HTTP Digest: answer the server's challenge once.
    if (auth.type === "digest" && response.status === 401) {
      const challenge = parseDigestChallenge(getHeader(response.headers, "www-authenticate") ?? "");
      if (challenge) {
        const d = auth.digest ?? { username: "", password: "" };
        const value = await digestAuthorization(challenge, { username: resolve(d.username, scopes), password: resolve(d.password, scopes) },
          prepared.method, digestUri(prepared.url), { body: prepared.body.type === "text" ? prepared.body.content : "" });
        prepared = { ...prepared, headers: [...prepared.headers.filter((h) => h.key.toLowerCase() !== "authorization"), { key: "Authorization", value }] };
        log("info", `Digest challenge from ${challenge.realm || "server"}; retrying with credentials`);
        response = await api.send({ ...native, id: p.requestId, headers: prepared.headers });
      }
    }
  } catch (e) {
    const msg = String(e);
    log(msg === "Request cancelled" ? "info" : "error", `${prepared.method} ${prepared.url} — ${msg}`, { request: prepared });
    return { result: { error: msg, tests, resolvedUrl: prepared.url, resolvedMethod: prepared.method }, nextRequest };
  }

  log("request", `${prepared.method} ${prepared.url} → ${response.status} ${response.statusText} (${Math.round(response.timeMs)} ms)`, {
    request: { method: prepared.method, url: prepared.url, headers: response.requestHeaders, body: prepared.bodyPreview },
    response: { status: response.status, headers: response.headers, body: response.isBinary ? "(binary)" : response.bodyText.slice(0, 20000) },
  });

  // ---- tests ----
  for (const s of scriptsOf("testScript")) {
    const out = await runScript(s.code, { scopes, request: scriptReq, response, info: info("test"), log: scriptLog, sendRequest: sendFromScript });
    tests.push(...out.tests);
    if (out.nextRequest !== undefined) nextRequest = out.nextRequest;
    if (out.error) {
      log("error", `Test script error in ${s.label}: ${out.error}`);
      tests.push({ name: `Script error in ${s.label}`, passed: false, error: out.error });
    }
  }

  if (request.responseSchema?.trim()) tests.push(schemaTest(request.responseSchema, response));

  return { result: { response, tests, resolvedUrl: prepared.url, resolvedMethod: prepared.method }, nextRequest };
}

function schemaTest(schemaText: string, response: HttpResponse): TestResult {
  const name = "Response matches the request's JSON schema";
  let schema: unknown, body: unknown;
  try { schema = JSON.parse(schemaText); } catch { return { name, passed: false, error: "The response schema (request Settings) isn't valid JSON" }; }
  try { body = JSON.parse(response.bodyText); } catch { return { name, passed: false, error: "The response body isn't JSON" }; }
  try {
    const r = validateSchema(body, schema);
    return r.valid ? { name, passed: true } : { name, passed: false, error: r.errors.slice(0, 5).join("; ") + (r.errors.length > 5 ? ` (+${r.errors.length - 5} more)` : "") };
  } catch (e) {
    return { name, passed: false, error: `Invalid schema: ${e instanceof Error ? e.message : e}` };
  }
}
