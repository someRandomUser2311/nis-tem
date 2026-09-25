// Collection → OpenAPI 3.1, and collection → a self-contained HTML documentation page.
import type { Auth, Collection, Example, FolderItem, Item, RequestItem } from "../types";
import { parseQuery } from "./utils";

// ================================================================ OpenAPI

/** Split a request URL into (server, path): `{{baseUrl}}/a/:id` → ("{{baseUrl}}", "/a/{id}"). */
export function splitServer(url: string): { server: string; path: string } {
  const { base } = parseQuery(url.trim());
  let server = "", rest = base;
  const origin = base.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i);
  if (origin) { server = origin[0]; rest = base.slice(server.length); }
  else if (base.startsWith("{{")) {
    const end = base.indexOf("}}");
    if (end > 0) { server = base.slice(0, end + 2); rest = base.slice(end + 2); }
  }
  const path = ("/" + rest.replace(/^\/+/, ""))
    .split("/")
    .map((seg) => seg.replace(/^:([\w-]+)$/, "{$1}").replace(/^\{\{([\w.-]+)\}\}$/, "{$1}"))
    .join("/");
  return { server, path: path === "" ? "/" : path };
}

const slug = (s: string) => s.replace(/[^\w]+/g, "_").replace(/^_+|_+$/g, "").replace(/_(\w)/g, (_, c: string) => c.toUpperCase()) || "operation";

function exampleValue(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}

function securityScheme(a: Auth): [string, Record<string, unknown>] | null {
  switch (a.type) {
    case "bearer": return ["bearerAuth", { type: "http", scheme: "bearer" }];
    case "basic": return ["basicAuth", { type: "http", scheme: "basic" }];
    case "digest": return ["digestAuth", { type: "http", scheme: "digest" }];
    case "apikey": return ["apiKeyAuth", { type: "apiKey", name: a.apikey.key || "X-API-Key", in: a.apikey.in === "query" ? "query" : "header" }];
    case "oauth2": {
      const o = a.oauth2 ?? {};
      const scopes = Object.fromEntries((o.scope ?? "").split(/\s+/).filter(Boolean).map((s) => [s, s]));
      const flow = o.grantType === "client_credentials" ? { clientCredentials: { tokenUrl: o.tokenUrl ?? "", scopes } }
        : o.grantType === "password" ? { password: { tokenUrl: o.tokenUrl ?? "", scopes } }
        : { authorizationCode: { authorizationUrl: o.authUrl ?? "", tokenUrl: o.tokenUrl ?? "", scopes } };
      return ["oauth2", { type: "oauth2", flows: flow }];
    }
    default: return null;
  }
}

export function exportOpenApi(c: Collection): Record<string, any> {
  const paths: Record<string, Record<string, any>> = {};
  const servers = new Map<string, number>();
  const schemes: Record<string, any> = {};
  const usedIds = new Set<string>();
  const baseVar = c.variables.find((v) => v.key === "baseUrl" && v.enabled);

  const opSecurity = (a: Auth) => {
    if (a.type === "inherit") return undefined;
    if (a.type === "none") return [];
    const s = securityScheme(a);
    if (!s) return undefined;
    schemes[s[0]] = s[1];
    return [{ [s[0]]: [] }];
  };
  const collectionSecurity = opSecurity(c.auth);

  const walk = (items: Item[], tag?: string) => {
    for (const it of items) {
      if (it.type === "folder") { walk(it.items, tag ?? it.name); continue; }
      if (it.protocol === "ws") continue;
      const { server, path } = splitServer(it.url);
      if (server) servers.set(server, (servers.get(server) ?? 0) + 1);
      const method = it.method.toLowerCase();
      if (!["get", "put", "post", "delete", "options", "head", "patch", "trace"].includes(method)) continue;
      let id = slug(it.name);
      while (usedIds.has(id)) id += "_";
      usedIds.add(id);
      const parameters: any[] = [];
      for (const name of [...path.matchAll(/\{([\w.-]+)\}/g)].map((m) => m[1])) {
        const pv = it.pathVariables?.find((v) => v.key === name);
        parameters.push({ name, in: "path", required: true, schema: { type: "string" }, ...(pv?.value ? { example: pv.value } : {}), ...(pv?.description ? { description: pv.description } : {}) });
      }
      for (const q of it.params.filter((p) => p.key)) {
        parameters.push({ name: q.key, in: "query", required: false, schema: { type: "string" }, ...(q.value ? { example: q.value } : {}), ...(q.description ? { description: q.description } : {}) });
      }
      for (const h of it.headers.filter((h) => h.enabled && h.key && !/^(content-type|authorization|accept)$/i.test(h.key))) {
        parameters.push({ name: h.key, in: "header", schema: { type: "string" }, ...(h.value ? { example: h.value } : {}) });
      }
      const op: Record<string, any> = { operationId: id, summary: it.name };
      if (it.description) op.description = it.description;
      if (tag) op.tags = [tag];
      if (parameters.length) op.parameters = parameters;
      const b = it.body;
      if (b.mode === "raw" && b.raw.trim()) {
        const mime = { json: "application/json", xml: "application/xml", html: "text/html", javascript: "application/javascript", text: "text/plain" }[b.rawLanguage];
        op.requestBody = { content: { [mime]: { example: b.rawLanguage === "json" ? exampleValue(b.raw) : b.raw } } };
      } else if (b.mode === "urlencoded" || b.mode === "formdata") {
        const rows = (b.mode === "urlencoded" ? b.urlencoded : b.formdata).filter((r) => r.key);
        op.requestBody = { content: { [b.mode === "urlencoded" ? "application/x-www-form-urlencoded" : "multipart/form-data"]: {
          schema: { type: "object", properties: Object.fromEntries(rows.map((r) => [r.key, r.type === "file" ? { type: "string", format: "binary" } : { type: "string", example: r.value }])) },
        } } };
      } else if (b.mode === "graphql") {
        op.requestBody = { content: { "application/json": { example: { query: b.graphql.query, ...(b.graphql.variables.trim() ? { variables: exampleValue(b.graphql.variables) } : {}) } } } };
      }
      const responses: Record<string, any> = {};
      for (const ex of it.examples ?? []) {
        const code = String(ex.status || 200);
        const ct = ex.headers.find((h) => h.key.toLowerCase() === "content-type")?.value.split(";")[0] ?? "application/json";
        const r = (responses[code] ??= { description: ex.name || ex.statusText || code });
        if (ex.body) {
          r.content ??= {};
          r.content[ct] ??= { examples: {} };
          r.content[ct].examples[slug(ex.name) || `example${Object.keys(r.content[ct].examples).length + 1}`] = { summary: ex.name, value: /json/.test(ct) ? exampleValue(ex.body) : ex.body };
        }
      }
      op.responses = Object.keys(responses).length ? responses : { "200": { description: "OK" } };
      const sec = opSecurity(it.auth);
      if (sec) op.security = sec;
      (paths[path] ??= {})[method] = op;
    }
  };
  walk(c.items);

  const serverList = [...servers.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s);
  const toServer = (s: string) => {
    if (s === "{{baseUrl}}" && baseVar) return { url: baseVar.value || "/" };
    const m = s.match(/^\{\{([\w.-]+)\}\}$/);
    if (m) return { url: `{${m[1]}}`, variables: { [m[1]]: { default: c.variables.find((v) => v.key === m[1])?.value ?? "" } } };
    return { url: s };
  };
  const doc: Record<string, any> = {
    openapi: "3.1.0",
    info: { title: c.name, version: "1.0.0", ...(c.description ? { description: c.description } : {}) },
    servers: serverList.length ? serverList.map(toServer) : [{ url: "/" }],
    paths,
  };
  const topTags = c.items.filter((i): i is FolderItem => i.type === "folder");
  if (topTags.length) doc.tags = topTags.map((f) => ({ name: f.name, ...(f.description ? { description: f.description } : {}) }));
  if (Object.keys(schemes).length) doc.components = { securitySchemes: schemes };
  if (collectionSecurity?.length) doc.security = collectionSecurity;
  return doc;
}

// ================================================================ HTML docs

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const METHOD_COLORS: Record<string, string> = { GET: "#0f8a45", POST: "#a97400", PUT: "#1a5fc0", PATCH: "#6b39b0", DELETE: "#c0212f" };

function pretty(text: string): string {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

/**
 * A single static HTML page documenting a collection. `markdown` renders descriptions (the
 * caller passes a sanitising renderer); everything else is escaped.
 */
export function exportHtmlDocs(c: Collection, markdown: (md: string) => string): string {
  let n = 0;
  const toc: string[] = [];
  const body: string[] = [];
  const anchor = () => `r${++n}`;
  const table = (title: string, rows: { key: string; value: string; description?: string }[]) =>
    rows.length ? `<h4>${esc(title)}</h4><table><tr><th>Key</th><th>Value</th><th>Description</th></tr>${rows.map((r) => `<tr><td><code>${esc(r.key)}</code></td><td><code>${esc(r.value)}</code></td><td>${esc(r.description ?? "")}</td></tr>`).join("")}</table>` : "";
  const example = (ex: Example) =>
    `<details><summary><span class="status s${String(ex.status)[0]}">${ex.status}</span> ${esc(ex.name)}</summary>${ex.body ? `<pre>${esc(pretty(ex.body))}</pre>` : "<p class=muted>No body</p>"}</details>`;

  const request = (r: RequestItem, depth: number) => {
    const id = anchor();
    const m = r.protocol === "ws" ? "WS" : r.protocol === "sse" ? "SSE" : r.method.toUpperCase();
    toc.push(`<a class="d${depth}" href="#${id}"><span class="m" style="color:${METHOD_COLORS[m] ?? "#666"}">${esc(m)}</span>${esc(r.name)}</a>`);
    const b = r.body;
    const bodyHtml = b.mode === "raw" && b.raw.trim() ? `<h4>Body</h4><pre>${esc(b.rawLanguage === "json" ? pretty(b.raw) : b.raw)}</pre>`
      : b.mode === "graphql" ? `<h4>GraphQL</h4><pre>${esc(b.graphql.query)}</pre>${b.graphql.variables.trim() ? `<pre>${esc(pretty(b.graphql.variables))}</pre>` : ""}`
      : b.mode === "urlencoded" ? table("Form (urlencoded)", b.urlencoded.filter((x) => x.enabled))
      : b.mode === "formdata" ? table("Form data", b.formdata.filter((x) => x.enabled).map((x) => ({ ...x, value: x.type === "file" ? `<file> ${x.value}` : x.value })))
      : "";
    body.push(`<section id="${id}">
<h3><span class="m" style="background:${METHOD_COLORS[m] ?? "#666"}">${esc(m)}</span> ${esc(r.name)}</h3>
<pre class="url">${esc(r.url)}</pre>
${r.description ? `<div class="md">${markdown(r.description)}</div>` : ""}
${table("Path variables", r.pathVariables ?? [])}
${table("Query parameters", r.params.filter((p) => p.enabled && p.key))}
${table("Headers", r.headers.filter((h) => h.enabled && h.key))}
${r.auth.type !== "inherit" && r.auth.type !== "none" ? `<p class="muted">Authorization: ${esc(r.auth.type)}</p>` : ""}
${bodyHtml}
${r.examples?.length ? `<h4>Example responses</h4>${r.examples.map(example).join("")}` : ""}
</section>`);
  };
  const folder = (f: FolderItem, depth: number) => {
    const id = anchor();
    toc.push(`<a class="d${depth} folder" href="#${id}">${esc(f.name)}</a>`);
    body.push(`<section id="${id}" class="folder"><h2>${esc(f.name)}</h2>${f.description ? `<div class="md">${markdown(f.description)}</div>` : ""}</section>`);
    items(f.items, depth + 1);
  };
  const items = (list: Item[], depth: number) => list.forEach((it) => (it.type === "folder" ? folder(it, depth) : request(it, depth)));
  items(c.items, 0);

  const vars = c.variables.filter((v) => v.enabled && v.key);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(c.name)} — API docs</title>
<meta name="generator" content="Localpost">
<style>
:root{--bg:#fff;--fg:#1d1d1f;--muted:#6b6b6b;--line:#e5e5e5;--code:#f5f5f7;--side:#fafafa}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#eee;--muted:#999;--line:#2a2a2a;--code:#1e1e1e;--side:#181818}}
*{box-sizing:border-box}body{margin:0;font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;background:var(--bg);color:var(--fg);display:flex}
nav{position:sticky;top:0;height:100vh;overflow:auto;width:290px;flex-shrink:0;background:var(--side);border-right:1px solid var(--line);padding:20px 12px}
nav h1{font-size:17px;margin:0 8px 14px}nav a{display:flex;gap:8px;padding:4px 8px;border-radius:6px;color:inherit;text-decoration:none;font-size:13.5px}
nav a:hover{background:var(--code)}nav a.folder{font-weight:600;margin-top:8px}.d1{padding-left:20px!important}.d2{padding-left:32px!important}.d3{padding-left:44px!important}
nav .m{font:700 10.5px/2 ui-monospace,Menlo,monospace;min-width:34px}
main{flex:1;min-width:0;max-width:980px;padding:32px 44px 80px}
h2{margin-top:40px;padding-top:12px;border-top:1px solid var(--line)}h3{margin:36px 0 8px;display:flex;align-items:center;gap:10px}
h3 .m{color:#fff;font:700 11px/1 ui-monospace,Menlo,monospace;padding:5px 7px;border-radius:5px}
h4{margin:18px 0 6px;font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
pre,code{font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}pre{background:var(--code);padding:10px 12px;border-radius:8px;overflow:auto}
pre.url{white-space:pre-wrap;word-break:break-all}code{background:var(--code);padding:1px 5px;border-radius:4px}
table{border-collapse:collapse;width:100%;font-size:13.5px}th,td{text-align:left;border-bottom:1px solid var(--line);padding:6px 8px;vertical-align:top}th{color:var(--muted);font-weight:600}
details{border:1px solid var(--line);border-radius:8px;margin:6px 0;padding:6px 10px}summary{cursor:pointer}
.status{font:700 12px ui-monospace,Menlo,monospace;margin-right:6px}.s2{color:#0f8a45}.s3{color:#1a6ed8}.s4{color:#b86e00}.s5{color:#c0212f}
.muted{color:var(--muted)}.md img{max-width:100%}footer{margin-top:60px;color:var(--muted);font-size:12.5px}
@media (max-width:760px){body{display:block}nav{position:static;width:auto;height:auto;border-right:0;border-bottom:1px solid var(--line)}main{padding:20px 16px}}
</style></head>
<body>
<nav><h1>${esc(c.name)}</h1>${toc.join("\n")}</nav>
<main>
<h1>${esc(c.name)}</h1>
${c.description ? `<div class="md">${markdown(c.description)}</div>` : ""}
${vars.length ? table("Collection variables", vars.map((v) => ({ key: v.key, value: v.secret ? "••••••" : v.value, description: v.description }))) : ""}
${body.join("\n")}
<footer>Generated by Localpost on ${new Date().toISOString().slice(0, 10)}.</footer>
</main></body></html>`;
}
