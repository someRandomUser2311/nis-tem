// Collection → OpenAPI 3.1 (HTML / Markdown docs are built from the docs model in lib/docs/).
import type { Auth, Collection, FolderItem, Item, KV } from "../types";
import { SENSITIVE_HEADER } from "./leaks";
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

/** A stored JSON Schema text as an object (undefined when empty or invalid). */
function schemaOf(text: string | undefined): Record<string, any> | undefined {
  if (!text?.trim()) return undefined;
  try { const s = JSON.parse(text); return s && typeof s === "object" ? s : undefined; } catch { return undefined; }
}

function paramSchema(kv: KV): Record<string, any> {
  const d = kv.doc;
  return {
    type: d?.type ?? "string",
    ...(d?.format ? { format: d.format } : {}),
    ...(d?.enum?.length ? { enum: d.enum } : {}),
    ...(d?.default ? { default: d.default } : {}),
  };
}

function parameter(name: string, where: "path" | "query" | "header", kv: KV | undefined, required = false): Record<string, any> {
  const example = kv?.doc?.example || kv?.value;
  return {
    name, in: where,
    required: required || !!kv?.doc?.required,
    schema: kv ? paramSchema(kv) : { type: "string" },
    ...(example ? { example } : {}),
    ...(kv?.description ? { description: kv.description } : {}),
    ...(kv?.doc?.deprecated ? { deprecated: true } : {}),
  };
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
      if (it.type === "folder") { if (!it.docs?.hidden) walk(it.items, tag ?? it.name); continue; }
      if (it.protocol === "ws" || it.docs?.hidden) continue;
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
        parameters.push(parameter(name, "path", pv, true));
      }
      for (const q of it.params.filter((p) => p.key)) parameters.push(parameter(q.key, "query", q));
      for (const h of it.headers.filter((h) => h.enabled && h.key && !/^(content-type|authorization|accept)$/i.test(h.key))) {
        parameters.push(parameter(h.key, "header", { ...h, value: SENSITIVE_HEADER.test(h.key) && !/^\s*\{\{[^{}]+\}\}\s*$/.test(h.value) ? "" : h.value }));
      }
      const op: Record<string, any> = { operationId: id, summary: it.name };
      if (it.description) op.description = it.description;
      const tags = [...(tag ? [tag] : []), ...(it.docs?.tags ?? [])];
      if (tags.length) op.tags = tags;
      if (it.docs?.status === "deprecated") op.deprecated = true;
      if (parameters.length) op.parameters = parameters;
      const b = it.body;
      if (b.mode === "raw" && b.raw.trim()) {
        const mime = { json: "application/json", xml: "application/xml", html: "text/html", javascript: "application/javascript", text: "text/plain" }[b.rawLanguage];
        op.requestBody = { content: { [mime]: { ...(schemaOf(it.docs?.bodySchema) ? { schema: schemaOf(it.docs?.bodySchema) } : {}), example: b.rawLanguage === "json" ? exampleValue(b.raw) : b.raw } } };
      } else if (b.mode === "urlencoded" || b.mode === "formdata") {
        const rows = (b.mode === "urlencoded" ? b.urlencoded : b.formdata).filter((r) => r.key);
        op.requestBody = { content: { [b.mode === "urlencoded" ? "application/x-www-form-urlencoded" : "multipart/form-data"]: {
          schema: schemaOf(it.docs?.bodySchema) ?? {
            type: "object",
            properties: Object.fromEntries(rows.map((r) => [r.key, r.type === "file" ? { type: "string", format: "binary", ...(r.description ? { description: r.description } : {}) } : { ...paramSchema(r), example: r.value, ...(r.description ? { description: r.description } : {}) }])),
            ...(rows.some((r) => r.doc?.required) ? { required: rows.filter((r) => r.doc?.required).map((r) => r.key) } : {}),
          },
        } } };
      } else if (b.mode === "graphql") {
        op.requestBody = { content: { "application/json": { example: { query: b.graphql.query, ...(b.graphql.variables.trim() ? { variables: exampleValue(b.graphql.variables) } : {}) } } } };
      }
      const responses: Record<string, any> = {};
      const successSchema = schemaOf(it.responseSchema);
      for (const ex of it.examples ?? []) {
        const code = String(ex.status || 200);
        const ct = ex.headers.find((h) => h.key.toLowerCase() === "content-type")?.value.split(";")[0] ?? "application/json";
        const r = (responses[code] ??= { description: ex.description || ex.name || ex.statusText || code });
        const schema = schemaOf(ex.schema) ?? (ex.status >= 200 && ex.status < 300 ? successSchema : undefined);
        if (ex.body || schema) {
          r.content ??= {};
          r.content[ct] ??= {};
          if (schema && !r.content[ct].schema) r.content[ct].schema = schema;
          if (ex.body) {
            r.content[ct].examples ??= {};
            r.content[ct].examples[slug(ex.name) || `example${Object.keys(r.content[ct].examples).length + 1}`] = {
              summary: ex.name, ...(ex.description ? { description: ex.description } : {}), value: /json/.test(ct) ? exampleValue(ex.body) : ex.body,
            };
          }
        }
      }
      if (!Object.keys(responses).length) responses["200"] = { description: "OK", ...(successSchema ? { content: { "application/json": { schema: successSchema } } } : {}) };
      op.responses = responses;
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
    info: {
      title: c.docsConfig?.title || c.name,
      version: c.docsConfig?.version || "1.0.0",
      ...(c.description || c.pages?.length ? { description: [c.description, ...(c.pages ?? []).map((p) => `## ${p.title}\n\n${p.body}`)].filter((x) => x?.trim()).join("\n\n") } : {}),
    },
    servers: serverList.length ? serverList.map(toServer) : [{ url: "/" }],
    paths,
  };
  const topTags = c.items.filter((i): i is FolderItem => i.type === "folder");
  if (topTags.length) doc.tags = topTags.map((f) => ({ name: f.name, ...(f.description ? { description: f.description } : {}) }));
  if (Object.keys(schemes).length) doc.components = { securitySchemes: schemes };
  if (collectionSecurity?.length) doc.security = collectionSecurity;
  return doc;
}
