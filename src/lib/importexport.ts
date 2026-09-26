// Import / export: Postman Collection v2.0 / v2.1, Postman environments & globals,
// cURL commands, and full Localpost workspace backups.
import type { Auth, Body, Collection, Environment, Example, FolderItem, Item, KV, RawLanguage, RequestItem } from "../types";
import { defaultAuth, defaultBody, kv, newCollection, newRequest, parseQuery, uid } from "./utils";
import { parse as parseYaml } from "yaml";
import { importBruRequest, importHar, importHoppscotch, importInsomnia, importOpenApi } from "./importers";

const POSTMAN_SCHEMA = "https://schema.getpostman.com/json/collection/v2.1.0/collection.json";

// ============================================================== Postman → Localpost

const desc = (d: unknown): string => (typeof d === "string" ? d : (d as any)?.content ?? "");

function kvList(list: any[] | undefined, extra?: (x: any) => Partial<KV>): KV[] {
  return (list ?? []).map((x) => kv(String(x.key ?? ""), x.value == null ? "" : String(x.value), {
    enabled: !x.disabled, description: desc(x.description),
    ...(x["x-localpost"]?.doc && typeof x["x-localpost"].doc === "object" ? { doc: x["x-localpost"].doc } : {}),
    ...(extra?.(x) ?? {}),
  }));
}

function authParam(v: any, key: string): string {
  if (Array.isArray(v)) return String(v.find((p: any) => p.key === key)?.value ?? "");
  return String(v?.[key] ?? "");
}

function importAuth(a: any, fallback: Auth["type"] = "inherit"): Auth {
  const auth = defaultAuth(fallback);
  if (!a) return auth;
  switch (a.type) {
    case "noauth": auth.type = "none"; break;
    case "basic":
      auth.type = "basic";
      auth.basic = { username: authParam(a.basic, "username"), password: authParam(a.basic, "password") };
      break;
    case "bearer":
      auth.type = "bearer";
      auth.bearer.token = authParam(a.bearer, "token");
      break;
    case "apikey":
      auth.type = "apikey";
      auth.apikey = {
        key: authParam(a.apikey, "key"), value: authParam(a.apikey, "value"),
        in: authParam(a.apikey, "in") === "query" ? "query" : "header",
      };
      break;
    case "oauth2": {
      const p = (k: string) => authParam(a.oauth2, k);
      const grant = p("grant_type");
      const token = p("accessToken");
      auth.type = "oauth2";
      auth.oauth2 = {
        grantType: grant === "client_credentials" ? "client_credentials" : grant === "password_credentials" ? "password" : "authorization_code",
        usePkce: grant !== "authorization_code",
        authUrl: p("authUrl"), tokenUrl: p("accessTokenUrl"), clientId: p("clientId"), clientSecret: p("clientSecret"),
        scope: p("scope"), audience: p("audience"), username: p("username"), password: p("password"),
        ...(p("redirect_uri") ? { redirectUri: p("redirect_uri") } : {}),
        clientAuth: p("client_authentication") === "header" ? "header" : "body",
        headerPrefix: p("headerPrefix") || "Bearer",
        addTo: p("addTokenTo") === "queryParams" ? "query" : "header",
        ...(token ? { token: { accessToken: token, tokenType: "Bearer", refreshToken: p("refreshToken") || undefined, obtainedAt: Date.now() } } : {}),
      };
      break;
    }
    case "digest":
      auth.type = "digest";
      auth.digest = { username: authParam(a.digest, "username"), password: authParam(a.digest, "password") };
      break;
    case "awsv4":
      auth.type = "awsv4";
      auth.awsv4 = {
        accessKey: authParam(a.awsv4, "accessKey"), secretKey: authParam(a.awsv4, "secretKey"), sessionToken: authParam(a.awsv4, "sessionToken"),
        region: authParam(a.awsv4, "region") || "us-east-1", service: authParam(a.awsv4, "service") || "execute-api",
      };
      break;
    case "hawk":
      auth.type = "hawk";
      auth.hawk = {
        id: authParam(a.hawk, "authId"), key: authParam(a.hawk, "authKey"),
        algorithm: authParam(a.hawk, "algorithm") === "sha1" ? "sha1" : "sha256",
        ext: authParam(a.hawk, "ext"), includePayloadHash: authParam(a.hawk, "includePayloadHash") === "true",
      };
      break;
  }
  return auth;
}

function scripts(events: any[] | undefined) {
  const get = (listen: string) => {
    const ev = (events ?? []).find((e) => e.listen === listen);
    const exec = ev?.script?.exec;
    return Array.isArray(exec) ? exec.join("\n") : typeof exec === "string" ? exec : "";
  };
  return { preRequestScript: get("prerequest"), testScript: get("test") };
}

function importBody(b: any): Body {
  const body = defaultBody();
  if (!b || b.disabled) return body;
  switch (b.mode) {
    case "raw": {
      body.mode = "raw";
      body.raw = typeof b.raw === "string" ? b.raw : JSON.stringify(b.raw ?? "", null, 2);
      const lang = b.options?.raw?.language as RawLanguage | undefined;
      body.rawLanguage = lang && ["json", "text", "xml", "html", "javascript"].includes(lang) ? lang : body.raw.trim().match(/^[[{]/) ? "json" : "text";
      break;
    }
    case "urlencoded": body.mode = "urlencoded"; body.urlencoded = kvList(b.urlencoded); break;
    case "formdata":
      body.mode = "formdata";
      body.formdata = kvList(b.formdata, (x) => ({
        type: x.type === "file" ? "file" : "text",
        value: x.type === "file" ? (Array.isArray(x.src) ? x.src[0] ?? "" : x.src ?? "") : x.value == null ? "" : String(x.value),
      }));
      break;
    case "file": body.mode = "binary"; body.binaryPath = b.file?.src ?? ""; break;
    case "graphql":
      body.mode = "graphql";
      body.graphql = {
        query: b.graphql?.query ?? "",
        variables: typeof b.graphql?.variables === "string" ? b.graphql.variables : b.graphql?.variables ? JSON.stringify(b.graphql.variables, null, 2) : "",
      };
      break;
  }
  return body;
}

function importUrl(u: any): string {
  if (!u) return "";
  if (typeof u === "string") return u;
  if (u.raw) return u.raw;
  const host = Array.isArray(u.host) ? u.host.join(".") : u.host ?? "";
  const path = Array.isArray(u.path) ? u.path.join("/") : u.path ?? "";
  const q = (u.query ?? []).filter((x: any) => !x.disabled).map((x: any) => `${x.key}=${x.value ?? ""}`).join("&");
  return `${u.protocol ? u.protocol + "://" : ""}${host}${path ? "/" + path : ""}${q ? "?" + q : ""}`;
}

/** Postman `item.response[]` → saved examples. */
function importExamples(list: any[] | undefined, method: string, url: string): Example[] {
  if (!Array.isArray(list)) return [];
  return list.map((r) => {
    const orig = typeof r.originalRequest === "object" && r.originalRequest ? r.originalRequest : null;
    return {
      id: uid(),
      name: r.name ?? `${r.code ?? 200} ${r.status ?? ""}`.trim(),
      status: Number(r.code) || 200,
      statusText: r.status ?? "",
      headers: (Array.isArray(r.header) ? r.header : []).filter((h: any) => h && h.key).map((h: any) => ({ key: String(h.key), value: String(h.value ?? "") })),
      body: typeof r.body === "string" ? r.body : r.body == null ? "" : JSON.stringify(r.body, null, 2),
      request: { method: (orig?.method ?? method).toUpperCase(), url: orig ? importUrl(orig.url) || url : url },
      ...pickDocs(r["x-localpost"], ["description", "default", "schema"]),
    };
  });
}

function importItem(it: any): Item {
  if (Array.isArray(it.item)) {
    const folder: FolderItem = {
      id: uid(), type: "folder", name: it.name ?? "Folder", items: it.item.map(importItem),
      auth: importAuth(it.auth), description: desc(it.description), ...scripts(it.event),
      ...(it["x-localpost"]?.docs?.hidden ? { docs: { hidden: true } } : {}),
    };
    return folder;
  }
  const r = typeof it.request === "string" ? { url: it.request, method: "GET" } : it.request ?? {};
  const url = importUrl(r.url);
  const disabledParams = typeof r.url === "object" ? kvList((r.url?.query ?? []).filter((q: any) => q.disabled)) : [];
  // Descriptions (and docs details) of enabled params live on url.query; the values come from the raw URL.
  const queryMeta = typeof r.url === "object" ? kvList((r.url?.query ?? []).filter((q: any) => !q.disabled)) : [];
  const enabledParams = parseQuery(url).pairs.map(([k, v]) => {
    const meta = queryMeta.find((q) => q.key === k);
    return kv(k, v, meta ? { description: meta.description, ...(meta.doc ? { doc: meta.doc } : {}) } : {});
  });
  return newRequest({
    name: it.name ?? "Request",
    method: (r.method ?? "GET").toUpperCase(),
    url,
    params: [...enabledParams, ...disabledParams],
    pathVariables: typeof r.url === "object" ? kvList(r.url?.variable) : [],
    headers: kvList(Array.isArray(r.header) ? r.header : []),
    body: importBody(r.body),
    auth: importAuth(r.auth),
    description: desc(r.description),
    ...scripts(it.event),
    examples: importExamples(it.response, (r.method ?? "GET").toUpperCase(), url),
    // Localpost-only fields (WebSocket / SSE) survive a round trip through a Postman export.
    ...(it["x-localpost"]?.protocol === "ws" || it["x-localpost"]?.protocol === "sse" ? { protocol: it["x-localpost"].protocol } : {}),
    ...(it["x-localpost"]?.ws ? { ws: it["x-localpost"].ws } : {}),
    ...pickDocs(it["x-localpost"], ["docs", "responseSchema"]),
  });
}

/** Localpost-only docs fields kept under `x-localpost` in Postman files (Postman ignores them). */
function pickDocs(x: any, keys: string[]): Record<string, unknown> {
  if (!x || typeof x !== "object") return {};
  return Object.fromEntries(keys.filter((k) => x[k] !== undefined).map((k) => [k, x[k]]));
}

export function importPostmanCollection(json: any): Collection {
  const c = newCollection(json.info?.name ?? "Imported Collection");
  c.description = desc(json.info?.description);
  c.items = (json.item ?? []).map(importItem);
  c.auth = importAuth(json.auth, "none");
  c.variables = kvList(json.variable);
  Object.assign(c, scripts(json.event));
  const lp = json["x-localpost"];
  if (Array.isArray(lp?.pages)) c.pages = lp.pages.map((p: any) => ({ id: uid(), title: String(p.title ?? "Page"), body: String(p.body ?? "") }));
  if (lp?.docsConfig && typeof lp.docsConfig === "object") c.docsConfig = lp.docsConfig;
  return c;
}

export function importPostmanEnvironment(json: any): Environment {
  return {
    id: uid(),
    name: json.name ?? "Imported Environment",
    variables: (json.values ?? []).map((v: any) =>
      kv(String(v.key ?? ""), v.value == null ? "" : String(v.value), { enabled: v.enabled !== false, secret: v.type === "secret" })),
  };
}

// ============================================================== Localpost → Postman

function exportAuth(a: Auth): any {
  switch (a.type) {
    case "inherit": return undefined;
    case "none": return { type: "noauth" };
    case "basic": return { type: "basic", basic: [{ key: "username", value: a.basic.username, type: "string" }, { key: "password", value: a.basic.password, type: "string" }] };
    case "bearer": return { type: "bearer", bearer: [{ key: "token", value: a.bearer.token, type: "string" }] };
    case "apikey": return { type: "apikey", apikey: [{ key: "key", value: a.apikey.key }, { key: "value", value: a.apikey.value }, { key: "in", value: a.apikey.in }] };
    case "oauth2": {
      const c = a.oauth2 ?? {};
      const grant = c.grantType === "client_credentials" ? "client_credentials" : c.grantType === "password" ? "password_credentials"
        : c.usePkce === false ? "authorization_code" : "authorization_code_with_pkce";
      const kv = (key: string, value: unknown) => ({ key, value: value ?? "", type: "string" });
      return {
        type: "oauth2",
        oauth2: [
          kv("grant_type", grant), kv("authUrl", c.authUrl), kv("accessTokenUrl", c.tokenUrl), kv("clientId", c.clientId),
          kv("clientSecret", c.clientSecret), kv("scope", c.scope), kv("redirect_uri", c.redirectUri),
          kv("client_authentication", c.clientAuth === "header" ? "header" : "body"), kv("headerPrefix", c.headerPrefix ?? "Bearer"),
          kv("addTokenTo", c.addTo === "query" ? "queryParams" : "header"), kv("username", c.username), kv("password", c.password),
        ],
      };
    }
    case "digest": return { type: "digest", digest: [{ key: "username", value: a.digest?.username ?? "" }, { key: "password", value: a.digest?.password ?? "" }] };
    case "awsv4": {
      const x = a.awsv4;
      return { type: "awsv4", awsv4: ["accessKey", "secretKey", "region", "service", "sessionToken"].map((key) => ({ key, value: (x as any)?.[key] ?? "" })) };
    }
    case "hawk": {
      const h = a.hawk;
      return { type: "hawk", hawk: [
        { key: "authId", value: h?.id ?? "" }, { key: "authKey", value: h?.key ?? "" }, { key: "algorithm", value: h?.algorithm ?? "sha256" },
        { key: "ext", value: h?.ext ?? "" }, { key: "includePayloadHash", value: !!h?.includePayloadHash },
      ] };
    }
  }
}

function exportEvents(x: { preRequestScript: string; testScript: string }) {
  const ev = [];
  if (x.preRequestScript.trim()) ev.push({ listen: "prerequest", script: { type: "text/javascript", exec: x.preRequestScript.split("\n") } });
  if (x.testScript.trim()) ev.push({ listen: "test", script: { type: "text/javascript", exec: x.testScript.split("\n") } });
  return ev.length ? ev : undefined;
}

const exportKv = (l: KV[]) => l.map((x) => ({
  key: x.key, value: x.value, ...(x.enabled ? {} : { disabled: true }), ...(x.description ? { description: x.description } : {}),
  ...(x.doc && Object.keys(x.doc).length ? { "x-localpost": { doc: x.doc } } : {}),
}));

const compact = (o: Record<string, unknown>) => {
  const r = Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== "" && v !== false));
  return Object.keys(r).length ? r : undefined;
};

function exportBody(b: Body): any {
  switch (b.mode) {
    case "none": return undefined;
    case "raw": return { mode: "raw", raw: b.raw, options: { raw: { language: b.rawLanguage } } };
    case "urlencoded": return { mode: "urlencoded", urlencoded: exportKv(b.urlencoded) };
    case "formdata":
      return { mode: "formdata", formdata: b.formdata.map((f) => f.type === "file"
        ? { key: f.key, type: "file", src: f.value, ...(f.enabled ? {} : { disabled: true }) }
        : { key: f.key, value: f.value, type: "text", ...(f.enabled ? {} : { disabled: true }) }) };
    case "binary": return { mode: "file", file: { src: b.binaryPath } };
    case "graphql": return { mode: "graphql", graphql: { query: b.graphql.query, variables: b.graphql.variables } };
  }
}

function exportItem(i: Item): any {
  if (i.type === "folder") {
    return { name: i.name, description: i.description || undefined, item: i.items.map(exportItem), auth: exportAuth(i.auth), event: exportEvents(i),
      ...(i.docs?.hidden ? { "x-localpost": { docs: { hidden: true } } } : {}) };
  }
  const { base } = parseQuery(i.url);
  return {
    name: i.name,
    event: exportEvents(i),
    ...((lp) => (lp ? { "x-localpost": lp } : {}))(compact({
      protocol: i.protocol && i.protocol !== "http" ? i.protocol : undefined,
      ws: i.protocol && i.protocol !== "http" ? i.ws : undefined,
      docs: i.docs && Object.keys(i.docs).length ? i.docs : undefined,
      responseSchema: i.responseSchema?.trim() || undefined,
    })),
    request: {
      method: i.method,
      header: exportKv(i.headers),
      body: exportBody(i.body),
      auth: exportAuth(i.auth),
      description: i.description || undefined,
      url: {
        raw: i.url,
        ...splitHost(base),
        ...(i.params.length ? { query: exportKv(i.params) } : {}),
        ...(i.pathVariables?.length ? { variable: exportKv(i.pathVariables) } : {}),
      },
    },
    response: (i.examples ?? []).map((ex) => ({
      name: ex.name,
      originalRequest: { method: ex.request?.method ?? i.method, header: [], url: { raw: ex.request?.url ?? i.url, ...splitHost(parseQuery(ex.request?.url ?? i.url).base) } },
      status: ex.statusText ?? "",
      code: ex.status,
      header: ex.headers.filter((h) => h.enabled !== false).map(({ key, value }) => ({ key, value })),
      body: ex.body,
      _postman_previewlanguage: /json/i.test(ex.headers.find((h) => h.key.toLowerCase() === "content-type")?.value ?? "") ? "json" : "text",
      ...((lp) => (lp ? { "x-localpost": lp } : {}))(compact({ description: ex.description, default: ex.default, schema: ex.schema })),
    })),
  };
}

function splitHost(base: string) {
  const m = base.match(/^([a-z][a-z0-9+.-]*):\/\/([^/]*)(\/.*)?$/i);
  if (!m) return {};
  return { protocol: m[1], host: m[2].split("."), path: (m[3] ?? "").split("/").filter(Boolean) };
}

export function exportPostmanCollection(c: Collection): any {
  return {
    info: { _postman_id: c.id, name: c.name, description: c.description || undefined, schema: POSTMAN_SCHEMA },
    item: c.items.map(exportItem),
    auth: exportAuth(c.auth),
    event: exportEvents(c),
    variable: c.variables.map((v) => ({ key: v.key, value: v.value, ...(v.enabled ? {} : { disabled: true }) })),
    ...((lp) => (lp ? { "x-localpost": lp } : {}))(compact({
      pages: c.pages?.length ? c.pages.map(({ title, body }) => ({ title, body })) : undefined,
      docsConfig: c.docsConfig && Object.keys(c.docsConfig).length ? c.docsConfig : undefined,
    })),
  };
}

export function exportPostmanEnvironment(e: Environment, scope: "environment" | "globals" = "environment"): any {
  return {
    id: e.id,
    name: e.name,
    values: e.variables.map((v) => ({ key: v.key, value: v.value, type: v.secret ? "secret" : "default", enabled: v.enabled })),
    _postman_variable_scope: scope,
    _postman_exported_using: "Localpost",
  };
}

// ============================================================== cURL

function shellSplit(cmd: string): string[] {
  const out: string[] = [];
  let cur = "", i = 0, has = false;
  cmd = cmd.replace(/\\\r?\n/g, " ");
  while (i < cmd.length) {
    const ch = cmd[i];
    if (ch === "'" ) {
      const end = cmd.indexOf("'", i + 1);
      cur += cmd.slice(i + 1, end < 0 ? undefined : end); i = end < 0 ? cmd.length : end + 1; has = true;
    } else if (ch === "$" && cmd[i + 1] === "'") {
      let j = i + 2;
      while (j < cmd.length && cmd[j] !== "'") {
        if (cmd[j] === "\\" && j + 1 < cmd.length) {
          const n = cmd[j + 1];
          cur += n === "n" ? "\n" : n === "t" ? "\t" : n === "r" ? "\r" : n; j += 2;
        } else cur += cmd[j++];
      }
      i = j + 1; has = true;
    } else if (ch === '"') {
      let j = i + 1;
      while (j < cmd.length && cmd[j] !== '"') {
        if (cmd[j] === "\\" && j + 1 < cmd.length && '"\\$`'.includes(cmd[j + 1])) { cur += cmd[j + 1]; j += 2; }
        else cur += cmd[j++];
      }
      i = j + 1; has = true;
    } else if (ch === "\\" && i + 1 < cmd.length) {
      cur += cmd[i + 1]; i += 2; has = true;
    } else if (/\s/.test(ch)) {
      if (has) { out.push(cur); cur = ""; has = false; }
      i++;
    } else { cur += ch; i++; has = true; }
  }
  if (has) out.push(cur);
  return out;
}

export function isCurl(text: string) {
  return /^\s*curl(\.exe)?\s/i.test(text);
}

export function importCurl(cmd: string): RequestItem {
  const args = shellSplit(cmd.trim());
  if (args[0]?.toLowerCase().startsWith("curl")) args.shift();

  let method = "", url = "", forceGet = false;
  const headers: KV[] = [];
  const data: string[] = [];
  const urlencodeData: string[] = [];
  const form: KV[] = [];
  let user = "";

  const takesValue = new Set([
    "-X", "--request", "-H", "--header", "-d", "--data", "--data-raw", "--data-binary", "--data-ascii", "--data-urlencode",
    "-F", "--form", "--form-string", "-u", "--user", "-A", "--user-agent", "-b", "--cookie", "-e", "--referer", "--url",
    "-o", "--output", "-m", "--max-time", "--connect-timeout", "-x", "--proxy", "-w", "--write-out", "--retry", "-c", "--cookie-jar",
  ]);

  for (let i = 0; i < args.length; i++) {
    let a = args[i];
    let val: string | undefined;
    if (a.startsWith("--") && a.includes("=")) { val = a.slice(a.indexOf("=") + 1); a = a.slice(0, a.indexOf("=")); }
    else if (/^-[XHdFuAbe]./.test(a)) { val = a.slice(2); a = a.slice(0, 2); }
    const next = () => val ?? args[++i] ?? "";

    if (!a.startsWith("-")) { if (!url) url = a; continue; }
    switch (a) {
      case "-X": case "--request": method = next().toUpperCase(); break;
      case "-H": case "--header": {
        const h = next(); const idx = h.indexOf(":");
        if (idx > 0) headers.push(kv(h.slice(0, idx).trim(), h.slice(idx + 1).trim()));
        break;
      }
      case "-d": case "--data": case "--data-raw": case "--data-binary": case "--data-ascii": data.push(next()); break;
      case "--data-urlencode": urlencodeData.push(next()); break;
      case "-F": case "--form": case "--form-string": {
        const f = next(); const idx = f.indexOf("=");
        const k = f.slice(0, idx), v = f.slice(idx + 1);
        if (v.startsWith("@") && a !== "--form-string") form.push(kv(k, v.slice(1).replace(/;type=.*$/, ""), { type: "file" }));
        else form.push(kv(k, v, { type: "text" }));
        break;
      }
      case "-u": case "--user": user = next(); break;
      case "-A": case "--user-agent": headers.push(kv("User-Agent", next())); break;
      case "-b": case "--cookie": headers.push(kv("Cookie", next())); break;
      case "-e": case "--referer": headers.push(kv("Referer", next())); break;
      case "--url": url = next(); break;
      case "-G": case "--get": forceGet = true; break;
      case "-I": case "--head": method = "HEAD"; break;
      default: if (takesValue.has(a) && val === undefined) i++;
    }
  }

  const req = newRequest({ name: url || "Imported from cURL" });
  req.headers = headers;

  if (user) {
    const idx = user.indexOf(":");
    req.auth = defaultAuth("basic");
    req.auth.basic = { username: idx < 0 ? user : user.slice(0, idx), password: idx < 0 ? "" : user.slice(idx + 1) };
  }

  const ct = headers.find((h) => h.key.toLowerCase() === "content-type")?.value.toLowerCase() ?? "";
  if (forceGet && (data.length || urlencodeData.length)) {
    const qs = [...data, ...urlencodeData.map(encodeUrlencodeArg)].join("&");
    url += (url.includes("?") ? "&" : "?") + qs;
  } else if (form.length) {
    req.body.mode = "formdata";
    req.body.formdata = form;
  } else if (urlencodeData.length || (data.length && ct.includes("x-www-form-urlencoded"))) {
    req.body.mode = "urlencoded";
    const pairs = [...data.flatMap((d) => d.split("&")), ...urlencodeData.map(encodeUrlencodeArg)];
    req.body.urlencoded = pairs.map((p) => {
      const idx = p.indexOf("=");
      const dec = (s: string) => { try { return decodeURIComponent(s.replace(/\+/g, " ")); } catch { return s; } };
      return idx < 0 ? kv(dec(p), "") : kv(dec(p.slice(0, idx)), dec(p.slice(idx + 1)));
    });
    req.headers = req.headers.filter((h) => h.key.toLowerCase() !== "content-type");
  } else if (data.length) {
    req.body.mode = "raw";
    req.body.raw = data.join("&");
    const trimmed = req.body.raw.trim();
    req.body.rawLanguage = ct.includes("json") || /^[[{]/.test(trimmed) ? "json" : ct.includes("xml") ? "xml" : ct.includes("html") ? "html" : "text";
    if (req.body.rawLanguage === "json") {
      try { req.body.raw = JSON.stringify(JSON.parse(trimmed), null, 2); } catch { /* keep as-is */ }
    }
  }

  req.method = method || (!forceGet && (data.length || urlencodeData.length || form.length) ? "POST" : "GET");
  req.url = url;
  req.params = parseQuery(url).pairs.map(([k, v]) => kv(k, v));
  return req;
}

function encodeUrlencodeArg(a: string) {
  const idx = a.indexOf("=");
  if (idx < 0) return encodeURIComponent(a);
  return `${a.slice(0, idx)}=${encodeURIComponent(a.slice(idx + 1))}`;
}

// ============================================================== detection

export type Detected =
  | { kind: "collection"; collection: Collection }
  | { kind: "environment"; environment: Environment; scope: "environment" | "globals" }
  | { kind: "request"; request: RequestItem }
  | { kind: "workspace"; data: WorkspaceBackup }
  /** Several collections/environments from one file (Insomnia, Hoppscotch, a Bruno folder). */
  | { kind: "bundle"; label: string; collections: Collection[]; environments: Environment[] };

export interface WorkspaceBackup {
  localpost: 1;
  exportedAt: string;
  collections: Collection[];
  environments: Environment[];
  globals: KV[];
}

export const SUPPORTED_FORMATS =
  "Postman Collection v2.0/v2.1, Postman environment/globals, OpenAPI 3.x / Swagger 2 (JSON or YAML), HAR, Insomnia v4, Hoppscotch, Bruno (.bru file or collection folder), cURL, Localpost backup";

export function detectImport(text: string, fileName = ""): Detected {
  const t = text.trim();
  if (isCurl(t)) return { kind: "request", request: importCurl(t) };
  if (/\.bru$/i.test(fileName) || /^meta\s*\{/m.test(t) && /^(get|post|put|patch|delete|options|head)\s*\{/m.test(t)) {
    const r = importBruRequest(t);
    if (r) return { kind: "request", request: r.request };
  }
  let json: any;
  try {
    json = JSON.parse(t);
  } catch {
    try { json = parseYaml(t); } catch { json = undefined; }
    if (!json || typeof json !== "object") throw new Error(`Unrecognised format. Supported: ${SUPPORTED_FORMATS}.`);
  }
  if (json.localpost === 1) return { kind: "workspace", data: json };
  if (json.info && Array.isArray(json.item)) return { kind: "collection", collection: importPostmanCollection(json) };
  if (Array.isArray(json.values)) {
    return { kind: "environment", environment: importPostmanEnvironment(json), scope: json._postman_variable_scope === "globals" ? "globals" : "environment" };
  }
  if (typeof json.openapi === "string" || typeof json.swagger === "string") return { kind: "collection", collection: importOpenApi(json) };
  if (Array.isArray(json.log?.entries)) return { kind: "collection", collection: importHar(json) };
  if (json._type === "export" && Array.isArray(json.resources)) {
    const { collections, environments } = importInsomnia(json);
    return { kind: "bundle", label: "Insomnia export", collections, environments };
  }
  const hopp = Array.isArray(json) ? json : [json];
  if (hopp.length && hopp.every((c: any) => c && typeof c === "object" && (Array.isArray(c.requests) || Array.isArray(c.folders)) && "name" in c)) {
    return { kind: "bundle", label: "Hoppscotch", collections: importHoppscotch(json), environments: [] };
  }
  throw new Error(`Unrecognised format. Supported: ${SUPPORTED_FORMATS}.`);
}
