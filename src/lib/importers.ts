// Importers for formats other than Postman: OpenAPI 3.x / Swagger 2, HAR, Insomnia v4, Hoppscotch
// and Bruno. Each returns the internal model; detection lives in importexport.ts.
import type { Auth, Body, Collection, Environment, Example, FolderItem, Item, KV, ParamDoc, RawLanguage, RequestItem } from "../types";
import { defaultBody, defaultAuth, kv, newCollection, newFolder, newRequest, parseQuery, uid } from "./utils";
import { defaultOAuth2 } from "./oauth";

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

function rawLanguageFor(mime: string | undefined): RawLanguage {
  const m = (mime ?? "").toLowerCase();
  if (m.includes("json")) return "json";
  if (m.includes("xml")) return "xml";
  if (m.includes("html")) return "html";
  if (m.includes("javascript")) return "javascript";
  return "text";
}

// ================================================================ OpenAPI / Swagger

type Doc = Record<string, any>;

/** Follow local `$ref`s (`#/components/schemas/X`); unresolvable refs become `{}`. */
function deref(doc: Doc, node: any, seen = new Set<string>()): any {
  if (!node || typeof node !== "object" || typeof node.$ref !== "string") return node;
  const ref: string = node.$ref;
  if (!ref.startsWith("#/") || seen.has(ref)) return {};
  seen.add(ref);
  let cur: any = doc;
  for (const part of ref.slice(2).split("/")) cur = cur?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  return deref(doc, cur ?? {}, seen);
}

/** A plausible example value for a JSON schema. */
export function exampleFromSchema(doc: Doc, schema: any, depth = 0, seen = new Set<string>()): unknown {
  if (!schema || depth > 8) return null;
  if (schema.$ref) {
    if (seen.has(schema.$ref)) return {};
    const next = new Set(seen).add(schema.$ref);
    return exampleFromSchema(doc, deref(doc, schema), depth + 1, next);
  }
  if (schema.example !== undefined) return schema.example;
  if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (schema.const !== undefined) return schema.const;
  if (schema.allOf) return Object.assign({}, ...schema.allOf.map((s: any) => exampleFromSchema(doc, s, depth + 1, seen) ?? {}));
  if (schema.oneOf || schema.anyOf) return exampleFromSchema(doc, (schema.oneOf ?? schema.anyOf)[0], depth + 1, seen);
  const type = Array.isArray(schema.type) ? schema.type.find((t: string) => t !== "null") : schema.type;
  if (type === "object" || schema.properties) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema.properties ?? {})) out[k] = exampleFromSchema(doc, v, depth + 1, seen);
    return out;
  }
  if (type === "array") return [exampleFromSchema(doc, schema.items, depth + 1, seen)];
  if (type === "integer" || type === "number") return schema.minimum ?? 0;
  if (type === "boolean") return true;
  if (type === "string") {
    switch (schema.format) {
      case "date-time": return "2024-01-01T00:00:00Z";
      case "date": return "2024-01-01";
      case "email": return "user@example.com";
      case "uuid": return "00000000-0000-0000-0000-000000000000";
      case "uri": case "url": return "https://example.com";
      default: return "string";
    }
  }
  return null;
}

const openapiVar = (s: string) => s.replace(/\{([^}]+)\}/g, ":$1");

function openapiAuth(doc: Doc, security: any[] | undefined, vars: KV[]): Auth | null {
  const schemes = doc.components?.securitySchemes ?? doc.securityDefinitions ?? {};
  const first = security?.find((s) => s && Object.keys(s).length);
  const name = first ? Object.keys(first)[0] : undefined;
  const scheme = name ? deref(doc, schemes[name]) : undefined;
  if (!scheme) return null;
  const auth = defaultAuth("none");
  const addVar = (k: string) => { if (!vars.some((v) => v.key === k)) vars.push(kv(k, "")); return `{{${k}}}`; };
  const type = String(scheme.type ?? "").toLowerCase();
  if ((type === "http" && scheme.scheme?.toLowerCase() === "bearer") || type === "openidconnect") {
    auth.type = "bearer"; auth.bearer.token = addVar("bearerToken");
  } else if ((type === "http" && scheme.scheme?.toLowerCase() === "basic") || type === "basic") {
    auth.type = "basic"; auth.basic = { username: addVar("username"), password: addVar("password") };
  } else if (type === "apikey") {
    auth.type = "apikey"; auth.apikey = { key: scheme.name ?? "X-API-Key", value: addVar("apiKey"), in: scheme.in === "query" ? "query" : "header" };
  } else if (type === "oauth2") {
    const flows = scheme.flows ?? {};
    const code = flows.authorizationCode ?? (scheme.flow === "accessCode" ? scheme : undefined);
    const cc = flows.clientCredentials ?? (scheme.flow === "application" ? scheme : undefined);
    const f = code ?? cc ?? flows.password ?? scheme;
    auth.type = "oauth2";
    auth.oauth2 = {
      ...defaultOAuth2(),
      grantType: code ? "authorization_code" : cc ? "client_credentials" : "password",
      authUrl: f.authorizationUrl ?? "", tokenUrl: f.tokenUrl ?? "",
      clientId: addVar("clientId"), clientSecret: addVar("clientSecret"),
      scope: Object.keys(f.scopes ?? {}).join(" "),
    };
  } else return null;
  return auth;
}

/**
 * A standalone copy of a schema with `$ref`s resolved against the document (recursive refs are
 * left as `$ref` once seen), so it can be stored on a request and rendered on its own.
 */
export function inlineSchema(doc: Doc, schema: any, seen = new Set<string>(), depth = 0): any {
  if (!schema || typeof schema !== "object" || depth > 20) return schema;
  if (Array.isArray(schema)) return schema.map((s) => inlineSchema(doc, s, seen, depth + 1));
  if (typeof schema.$ref === "string") {
    if (seen.has(schema.$ref)) return { $ref: schema.$ref };
    const target = deref(doc, schema);
    return target === schema ? schema : inlineSchema(doc, target, new Set(seen).add(schema.$ref), depth + 1);
  }
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "example" || k === "examples" || k === "xml") continue;
    out[k] = k === "properties" && v && typeof v === "object"
      ? Object.fromEntries(Object.entries(v as Record<string, any>).map(([pk, pv]) => [pk, inlineSchema(doc, pv, seen, depth + 1)]))
      : typeof v === "object" ? inlineSchema(doc, v, seen, depth + 1) : v;
  }
  return out;
}

const schemaText = (doc: Doc, schema: any) => (schema && typeof schema === "object" ? JSON.stringify(inlineSchema(doc, schema), null, 2) : undefined);

/** OpenAPI parameter → docs details (required, type, format, enum, default, deprecated). */
function paramDoc(p: any): ParamDoc | undefined {
  const sch = p.schema ?? p;
  const type = Array.isArray(sch.type) ? sch.type.find((t: string) => t !== "null") : sch.type;
  const d: ParamDoc = {
    ...(p.required && p.in !== "path" ? { required: true } : {}),
    ...(["string", "integer", "number", "boolean", "array", "object"].includes(type) ? { type } : {}),
    ...(sch.format ? { format: String(sch.format) } : {}),
    ...(Array.isArray(sch.enum) ? { enum: sch.enum.map(String) } : {}),
    ...(sch.default !== undefined ? { default: String(sch.default) } : {}),
    ...(p.deprecated ? { deprecated: true } : {}),
  };
  return Object.keys(d).length ? d : undefined;
}

export function importOpenApi(doc: Doc): Collection {
  const isSwagger = typeof doc.swagger === "string";
  const col = newCollection(doc.info?.title ?? "Imported API");
  col.description = doc.info?.description ?? "";
  if (doc.info?.version) col.docsConfig = { version: String(doc.info.version) };
  let baseUrl = "";
  if (isSwagger) {
    const scheme = doc.schemes?.[0] ?? "https";
    baseUrl = doc.host ? `${scheme}://${doc.host}${doc.basePath ?? ""}` : doc.basePath ?? "";
  } else if (doc.servers?.[0]?.url) {
    const s = doc.servers[0];
    baseUrl = String(s.url).replace(/\{([^}]+)\}/g, (_m: string, v: string) => s.variables?.[v]?.default ?? `{{${v}}}`);
  }
  col.variables = [kv("baseUrl", baseUrl.replace(/\/$/, ""))];
  col.auth = openapiAuth(doc, doc.security, col.variables) ?? defaultAuth("none");

  const folders = new Map<string, FolderItem>();
  const folderFor = (tag: string | undefined) => {
    if (!tag) return col.items;
    let f = folders.get(tag);
    if (!f) {
      f = newFolder(tag);
      f.description = doc.tags?.find((t: any) => t.name === tag)?.description ?? "";
      folders.set(tag, f);
      col.items.push(f);
    }
    return f.items;
  };

  for (const [path, pathItemRaw] of Object.entries<any>(doc.paths ?? {})) {
    const pathItem = deref(doc, pathItemRaw);
    for (const method of HTTP_METHODS) {
      const op = pathItem?.[method];
      if (!op) continue;
      const params: any[] = [...(pathItem.parameters ?? []), ...(op.parameters ?? [])].map((p) => deref(doc, p));
      const paramExample = (p: any) => {
        const v = p.example ?? p.schema?.example ?? p.default ?? p.schema?.default ?? (p.schema?.enum ?? p.enum)?.[0];
        return v === undefined ? "" : String(v);
      };
      const withDoc = (p: any, extra: Partial<KV> = {}) => { const d = paramDoc(p); return kv(p.name, paramExample(p), { description: p.description ?? "", ...(d ? { doc: d } : {}), ...extra }); };
      const query = params.filter((p) => p.in === "query").map((p) => withDoc(p, { enabled: !!p.required }));
      const headers = params.filter((p) => p.in === "header").map((p) => withDoc(p));
      const pathVars = params.filter((p) => p.in === "path").map((p) => withDoc(p));

      const body: Body = defaultBody();
      const mediaTypes: Record<string, any> = isSwagger
        ? (() => {
            const bodyParam = params.find((p) => p.in === "body");
            const form = params.filter((p) => p.in === "formData");
            const consumes: string[] = op.consumes ?? doc.consumes ?? ["application/json"];
            if (bodyParam) return { [consumes[0]]: { schema: bodyParam.schema } };
            if (form.length) return { [consumes.includes("multipart/form-data") ? "multipart/form-data" : "application/x-www-form-urlencoded"]: { schema: { properties: Object.fromEntries(form.map((f) => [f.name, f])) } } };
            return {};
          })()
        : deref(doc, op.requestBody)?.content ?? {};
      const [mime, media] = Object.entries<any>(mediaTypes)[0] ?? [];
      if (mime) {
        const example = media?.example ?? (media?.examples ? deref(doc, Object.values<any>(media.examples)[0])?.value : undefined) ?? exampleFromSchema(doc, media?.schema);
        if (/x-www-form-urlencoded|multipart/.test(mime)) {
          const schema = deref(doc, media?.schema) ?? {};
          const required = new Set<string>(Array.isArray(schema.required) ? schema.required : []);
          const rows = Object.entries<any>(schema.properties ?? {}).map(([k, raw]) => {
            const s = deref(doc, raw) ?? {};
            const d = paramDoc({ ...s, schema: s, required: required.has(k) || s.required === true });
            return kv(k, String(exampleFromSchema(doc, s) ?? ""), {
              type: s.format === "binary" || s.type === "file" ? "file" : "text",
              description: s.description ?? "",
              ...(d ? { doc: d } : {}),
            });
          });
          if (mime.includes("multipart")) { body.mode = "formdata"; body.formdata = rows; } else { body.mode = "urlencoded"; body.urlencoded = rows; }
        } else {
          body.mode = "raw";
          body.rawLanguage = rawLanguageFor(mime);
          body.raw = typeof example === "string" ? example : example === undefined || example === null ? "" : JSON.stringify(example, null, 2);
          if (body.rawLanguage === "text" && mime !== "text/plain") headers.push(kv("Content-Type", mime));
        }
      }

      const url = `{{baseUrl}}${openapiVar(path)}${query.filter((q) => q.enabled).length ? `?${query.filter((q) => q.enabled).map((q) => `${q.key}=${q.value}`).join("&")}` : ""}`;
      const req = newRequest({
        name: op.summary || op.operationId || `${method.toUpperCase()} ${path}`,
        method: method.toUpperCase(),
        url,
        params: query,
        headers,
        pathVariables: pathVars,
        body,
        description: op.description ?? "",
      });
      const bodySchema = mime && !/x-www-form-urlencoded|multipart/.test(mime) ? schemaText(doc, media?.schema) : undefined;
      const docs = {
        ...(op.deprecated ? { status: "deprecated" as const } : {}),
        ...((op.tags?.length ?? 0) > 1 ? { tags: op.tags.slice(1).map(String) } : {}),
        ...(bodySchema ? { bodySchema } : {}),
      };
      if (Object.keys(docs).length) req.docs = docs;
      if (op.security) {
        const a = op.security.length === 0 ? defaultAuth("none") : openapiAuth(doc, op.security, col.variables);
        if (a) req.auth = a;
      }

      // Documented responses with a body become saved examples (and so mock-server routes).
      const examples: Example[] = [];
      for (const [code, respRaw] of Object.entries<any>(op.responses ?? {})) {
        const resp = deref(doc, respRaw);
        const status = code === "default" ? 200 : Number(code);
        if (!Number.isFinite(status)) continue;
        const content = isSwagger ? (resp.schema || resp.examples ? { [(op.produces ?? doc.produces ?? ["application/json"])[0]]: { schema: resp.schema, example: resp.examples ? Object.values(resp.examples)[0] : undefined } } : {}) : resp.content ?? {};
        const [rmime, rmedia] = Object.entries<any>(content)[0] ?? [];
        const value = rmedia ? rmedia.example ?? (rmedia.examples ? deref(doc, Object.values<any>(rmedia.examples)[0])?.value : undefined) ?? exampleFromSchema(doc, rmedia.schema) : undefined;
        const schema = schemaText(doc, rmedia?.schema);
        if (schema && status >= 200 && status < 300 && !req.responseSchema) req.responseSchema = schema;
        if (value === undefined && !resp.description) continue;
        examples.push({
          id: uid(), name: resp.description ? `${status} ${resp.description}`.slice(0, 80) : String(status), status,
          headers: rmime ? [{ key: "Content-Type", value: rmime }] : [],
          body: value === undefined || value === null ? "" : typeof value === "string" ? value : JSON.stringify(value, null, 2),
          request: { method: req.method, url: req.url },
          ...(resp.description && resp.description.length > 80 ? { description: resp.description } : {}),
          // Schemas that differ from the success schema (e.g. error bodies) stay on the example.
          ...(schema && schema !== req.responseSchema ? { schema } : {}),
        });
      }
      if (examples.length) req.examples = examples;
      folderFor(op.tags?.[0]).push(req);
    }
  }
  return col;
}

// ================================================================ HAR

export function importHar(har: Doc): Collection {
  const entries: any[] = har.log?.entries ?? [];
  const col = newCollection(`HAR import${har.log?.creator?.name ? ` (${har.log.creator.name})` : ""}`);
  const folders = new Map<string, FolderItem>();
  for (const e of entries) {
    const r = e.request;
    if (!r?.url) continue;
    let host = "requests";
    try { host = new URL(r.url).host; } catch { /* keep default */ }
    let f = folders.get(host);
    if (!f) { f = newFolder(host); folders.set(host, f); col.items.push(f); }
    const headers = (r.headers ?? []).filter((h: any) => h.name && !h.name.startsWith(":") && !/^(content-length|host|connection)$/i.test(h.name)).map((h: any) => kv(h.name, h.value ?? ""));
    const body = defaultBody();
    const pd = r.postData;
    if (pd) {
      if (Array.isArray(pd.params) && pd.params.length && /form/.test(pd.mimeType ?? "")) {
        const rows = pd.params.map((p: any) => kv(p.name, p.value ?? p.fileName ?? "", { type: p.fileName ? "file" : "text" }));
        if ((pd.mimeType ?? "").includes("multipart")) { body.mode = "formdata"; body.formdata = rows; } else { body.mode = "urlencoded"; body.urlencoded = rows; }
      } else if (pd.text) {
        body.mode = "raw"; body.raw = pd.text; body.rawLanguage = rawLanguageFor(pd.mimeType);
      }
    }
    let path = r.url;
    try { const u = new URL(r.url); path = u.pathname; } catch { /* ignore */ }
    const req = newRequest({
      name: `${r.method ?? "GET"} ${path}`.slice(0, 120),
      method: (r.method ?? "GET").toUpperCase(),
      url: r.url,
      params: parseQuery(r.url).pairs.map(([k, v]) => kv(k, v)),
      headers,
      body,
    });
    const res = e.response;
    if (res && res.status) {
      const text = res.content?.encoding === "base64" ? "" : res.content?.text ?? "";
      req.examples = [{
        id: uid(), name: `${res.status} ${res.statusText ?? ""}`.trim(), status: res.status, statusText: res.statusText,
        headers: (res.headers ?? []).filter((h: any) => h.name && !/^(content-length|content-encoding|transfer-encoding)$/i.test(h.name)).map((h: any) => ({ key: h.name, value: h.value ?? "" })),
        body: text, bodyBase64: res.content?.encoding === "base64" ? res.content.text : null,
        request: { method: req.method, url: req.url },
      }];
    }
    f.items.push(req);
  }
  return col;
}

/** History entries → HAR 1.2 (requests only; history doesn't keep response bodies). */
export function exportHar(entries: { time: number; request: RequestItem; status?: number; timeMs?: number }[]): Doc {
  return {
    log: {
      version: "1.2",
      creator: { name: "Localpost", version: "0.1.0" },
      entries: entries.map((h) => {
        const r = h.request;
        const text = r.body.mode === "raw" ? r.body.raw : r.body.mode === "graphql" ? JSON.stringify({ query: r.body.graphql.query }) : undefined;
        return {
          startedDateTime: new Date(h.time).toISOString(),
          time: h.timeMs ?? 0,
          request: {
            method: r.method, url: r.url, httpVersion: "HTTP/1.1", cookies: [],
            headers: r.headers.filter((x) => x.enabled && x.key).map((x) => ({ name: x.key, value: x.value })),
            queryString: r.params.filter((x) => x.enabled && x.key).map((x) => ({ name: x.key, value: x.value })),
            ...(text !== undefined ? { postData: { mimeType: r.body.rawLanguage === "json" || r.body.mode === "graphql" ? "application/json" : "text/plain", text } } : {}),
            headersSize: -1, bodySize: text?.length ?? 0,
          },
          response: { status: h.status ?? 0, statusText: "", httpVersion: "HTTP/1.1", cookies: [], headers: [], content: { size: 0, mimeType: "" }, redirectURL: "", headersSize: -1, bodySize: -1 },
          cache: {}, timings: { send: 0, wait: h.timeMs ?? 0, receive: 0 },
        };
      }),
    },
  };
}

// ================================================================ Insomnia v4

const fromInsomniaVars = (s: string) => String(s ?? "").replace(/\{\{\s*_\.([\w.-]+)\s*\}\}/g, "{{$1}}");

function insomniaAuth(a: any): Auth {
  const auth = defaultAuth("inherit");
  if (!a || !a.type) return auth;
  if (a.disabled) { auth.type = "none"; return auth; }
  switch (a.type) {
    case "basic": auth.type = "basic"; auth.basic = { username: fromInsomniaVars(a.username), password: fromInsomniaVars(a.password) }; break;
    case "bearer": auth.type = "bearer"; auth.bearer = { token: fromInsomniaVars(a.token), prefix: a.prefix || "Bearer" }; break;
    case "apikey": auth.type = "apikey"; auth.apikey = { key: fromInsomniaVars(a.key), value: fromInsomniaVars(a.value), in: a.addTo === "queryParams" ? "query" : "header" }; break;
    case "digest": auth.type = "digest"; auth.digest = { username: fromInsomniaVars(a.username), password: fromInsomniaVars(a.password) }; break;
    case "oauth2":
      auth.type = "oauth2";
      auth.oauth2 = {
        ...defaultOAuth2(),
        grantType: a.grantType === "client_credentials" ? "client_credentials" : a.grantType === "password" ? "password" : "authorization_code",
        authUrl: fromInsomniaVars(a.authorizationUrl), tokenUrl: fromInsomniaVars(a.accessTokenUrl), clientId: fromInsomniaVars(a.clientId),
        clientSecret: fromInsomniaVars(a.clientSecret), scope: fromInsomniaVars(a.scope), usePkce: !!a.usePkce,
      };
      break;
    default: auth.type = "none";
  }
  return auth;
}

export function importInsomnia(json: Doc): { collections: Collection[]; environments: Environment[] } {
  const res: any[] = json.resources ?? [];
  const workspaces = res.filter((r) => r._type === "workspace");
  const byParent = (id: string) => res.filter((r) => r.parentId === id).sort((a, b) => (a.metaSortKey ?? 0) - (b.metaSortKey ?? 0));
  const build = (parentId: string): Item[] =>
    byParent(parentId).flatMap((r): Item[] => {
      if (r._type === "request_group") {
        const f = newFolder(r.name ?? "Folder");
        f.items = build(r._id);
        f.description = r.description ?? "";
        f.auth = insomniaAuth(r.authentication);
        return [f];
      }
      if (r._type !== "request") return [];
      const body = defaultBody();
      const b = r.body ?? {};
      if (b.mimeType === "application/x-www-form-urlencoded") {
        body.mode = "urlencoded"; body.urlencoded = (b.params ?? []).map((p: any) => kv(fromInsomniaVars(p.name), fromInsomniaVars(p.value), { enabled: !p.disabled }));
      } else if (b.mimeType === "multipart/form-data") {
        body.mode = "formdata";
        body.formdata = (b.params ?? []).map((p: any) => kv(fromInsomniaVars(p.name), p.type === "file" ? p.fileName ?? "" : fromInsomniaVars(p.value), { enabled: !p.disabled, type: p.type === "file" ? "file" : "text" }));
      } else if (b.mimeType === "application/graphql") {
        body.mode = "graphql";
        try { const g = JSON.parse(b.text ?? "{}"); body.graphql = { query: g.query ?? "", variables: g.variables ? JSON.stringify(g.variables, null, 2) : "" }; } catch { body.graphql.query = b.text ?? ""; }
      } else if (b.text !== undefined) {
        body.mode = "raw"; body.raw = fromInsomniaVars(b.text); body.rawLanguage = rawLanguageFor(b.mimeType);
      } else if (b.fileName) {
        body.mode = "binary"; body.binaryPath = b.fileName;
      }
      const url = fromInsomniaVars(r.url ?? "");
      const params = (r.parameters ?? []).map((p: any) => kv(fromInsomniaVars(p.name), fromInsomniaVars(p.value), { enabled: !p.disabled }));
      const enabled = params.filter((p: KV) => p.enabled && p.key);
      return [newRequest({
        name: r.name ?? "Request",
        method: (r.method ?? "GET").toUpperCase(),
        url: enabled.length && !url.includes("?") ? `${url}?${enabled.map((p: KV) => `${p.key}=${p.value}`).join("&")}` : url,
        params: [...parseQuery(url).pairs.map(([k, v]) => kv(k, v)), ...params.filter((p: KV) => !url.includes("?") ? true : !p.enabled)],
        headers: (r.headers ?? []).map((h: any) => kv(fromInsomniaVars(h.name), fromInsomniaVars(h.value), { enabled: !h.disabled })),
        body,
        auth: insomniaAuth(r.authentication),
        description: r.description ?? "",
      })];
    });

  const collections = workspaces.map((w) => {
    const c = newCollection(w.name ?? "Insomnia workspace");
    c.description = w.description ?? "";
    c.items = build(w._id);
    // The base environment becomes collection variables.
    const base = res.find((r) => r._type === "environment" && r.parentId === w._id);
    if (base?.data) c.variables = Object.entries(base.data).map(([k, v]) => kv(k, typeof v === "string" ? fromInsomniaVars(v) : JSON.stringify(v)));
    return c;
  });
  const bases = new Set(res.filter((r) => r._type === "environment" && workspaces.some((w) => w._id === r.parentId)).map((r) => r._id));
  const environments = res
    .filter((r) => r._type === "environment" && bases.has(r.parentId))
    .map((e) => ({ id: uid(), name: e.name ?? "Environment", variables: Object.entries(e.data ?? {}).map(([k, v]) => kv(k, typeof v === "string" ? fromInsomniaVars(v) : JSON.stringify(v))) }));
  return { collections, environments };
}

// ================================================================ Hoppscotch

const fromHoppVars = (s: unknown) => String(s ?? "").replace(/<<\s*([\w.-]+)\s*>>/g, "{{$1}}");

function hoppAuth(a: any): Auth {
  const auth = defaultAuth("inherit");
  if (!a) return auth;
  if (a.authActive === false || a.authType === "none") { auth.type = "none"; return auth; }
  switch (a.authType) {
    case "inherit": return auth;
    case "basic": auth.type = "basic"; auth.basic = { username: fromHoppVars(a.username), password: fromHoppVars(a.password) }; break;
    case "bearer": auth.type = "bearer"; auth.bearer = { token: fromHoppVars(a.token), prefix: "Bearer" }; break;
    case "api-key": auth.type = "apikey"; auth.apikey = { key: fromHoppVars(a.key), value: fromHoppVars(a.value), in: a.addTo === "QUERY_PARAMS" || a.addTo === "Query params" ? "query" : "header" }; break;
    default: auth.type = "none";
  }
  return auth;
}

export function importHoppscotch(json: any): Collection[] {
  const list: any[] = Array.isArray(json) ? json : [json];
  const req = (r: any): RequestItem => {
    const body = defaultBody();
    const ct: string | null = r.body?.contentType ?? null;
    if (ct && r.body?.body !== undefined && r.body?.body !== null) {
      if (Array.isArray(r.body.body)) {
        const rows = r.body.body.map((f: any) => kv(fromHoppVars(f.key), fromHoppVars(f.value), { enabled: f.active !== false, type: f.isFile ? "file" : "text" }));
        if (ct.includes("multipart")) { body.mode = "formdata"; body.formdata = rows; } else { body.mode = "urlencoded"; body.urlencoded = rows; }
      } else if (ct.includes("x-www-form-urlencoded")) {
        body.mode = "urlencoded";
        body.urlencoded = String(r.body.body).split("\n").filter((l) => l.trim()).map((l) => { const i = l.indexOf(":"); return kv(fromHoppVars(l.slice(0, i).trim()), fromHoppVars(l.slice(i + 1).trim())); });
      } else { body.mode = "raw"; body.raw = fromHoppVars(r.body.body); body.rawLanguage = rawLanguageFor(ct); }
    }
    const url = fromHoppVars(r.endpoint ?? r.url ?? "");
    const params = (r.params ?? []).map((p: any) => kv(fromHoppVars(p.key), fromHoppVars(p.value), { enabled: p.active !== false }));
    const enabled = params.filter((p: KV) => p.enabled && p.key);
    return newRequest({
      name: r.name ?? "Request",
      method: (r.method ?? "GET").toUpperCase(),
      url: enabled.length ? `${url}?${enabled.map((p: KV) => `${p.key}=${p.value}`).join("&")}` : url,
      params,
      headers: (r.headers ?? []).map((h: any) => kv(fromHoppVars(h.key), fromHoppVars(h.value), { enabled: h.active !== false })),
      body,
      auth: hoppAuth(r.auth),
      preRequestScript: r.preRequestScript ?? "",
      testScript: r.testScript ?? "",
    });
  };
  const folder = (f: any): FolderItem => {
    const out = newFolder(f.name ?? "Folder");
    out.items = [...(f.folders ?? []).map(folder), ...(f.requests ?? []).map(req)];
    out.auth = hoppAuth(f.auth);
    return out;
  };
  return list.map((c) => {
    const col = newCollection(c.name ?? "Hoppscotch collection");
    col.items = [...(c.folders ?? []).map(folder), ...(c.requests ?? []).map(req)];
    const a = hoppAuth(c.auth);
    col.auth = a.type === "inherit" ? defaultAuth("none") : a;
    col.variables = (c.variables ?? []).map((v: any) => kv(v.key, fromHoppVars(v.value ?? v.initialValue ?? "")));
    return col;
  });
}

// ================================================================ Bruno (.bru)

interface BruBlock { name: string; body: string }

/** Split a .bru file into its top-level `name { … }` blocks. */
export function parseBruBlocks(text: string): BruBlock[] {
  const out: BruBlock[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([a-z][\w:-]*)\s*([{[])\s*$/i);
    if (!m) continue;
    const close = m[2] === "{" ? "}" : "]";
    const body: string[] = [];
    for (i++; i < lines.length && lines[i] !== close; i++) body.push(lines[i]);
    // Block content is indented by two spaces.
    out.push({ name: m[1], body: body.map((l) => (l.startsWith("  ") ? l.slice(2) : l)).join("\n") });
  }
  return out;
}

const bruPairs = (body: string): KV[] =>
  body.split("\n").filter((l) => l.trim()).map((l) => {
    const disabled = l.startsWith("~");
    const line = disabled ? l.slice(1) : l;
    const i = line.indexOf(":");
    return kv(line.slice(0, i < 0 ? undefined : i).trim(), i < 0 ? "" : line.slice(i + 1).trim(), { enabled: !disabled });
  });

const pairValue = (pairs: KV[], key: string) => pairs.find((p) => p.key === key)?.value ?? "";

function bruAuth(blocks: BruBlock[], mode: string | undefined): Auth {
  const auth = defaultAuth(mode === "inherit" || !mode ? "inherit" : "none");
  const b = (n: string) => bruPairs(blocks.find((x) => x.name === n)?.body ?? "");
  switch (mode) {
    case "basic": auth.type = "basic"; auth.basic = { username: pairValue(b("auth:basic"), "username"), password: pairValue(b("auth:basic"), "password") }; break;
    case "bearer": auth.type = "bearer"; auth.bearer = { token: pairValue(b("auth:bearer"), "token"), prefix: "Bearer" }; break;
    case "apikey": {
      const p = b("auth:apikey");
      auth.type = "apikey"; auth.apikey = { key: pairValue(p, "key"), value: pairValue(p, "value"), in: pairValue(p, "placement") === "queryparams" ? "query" : "header" };
      break;
    }
    case "digest": auth.type = "digest"; auth.digest = { username: pairValue(b("auth:digest"), "username"), password: pairValue(b("auth:digest"), "password") }; break;
    case "awsv4": {
      const p = b("auth:awsv4");
      auth.type = "awsv4";
      auth.awsv4 = { accessKey: pairValue(p, "accessKeyId"), secretKey: pairValue(p, "secretAccessKey"), sessionToken: pairValue(p, "sessionToken"), region: pairValue(p, "region"), service: pairValue(p, "service") };
      break;
    }
    case "none": auth.type = "none"; break;
  }
  return auth;
}

/** One .bru request file → a request (null for folder.bru / collection.bru / environment files). */
export function importBruRequest(text: string): { request: RequestItem; seq: number } | null {
  const blocks = parseBruBlocks(text);
  const meta = bruPairs(blocks.find((b) => b.name === "meta")?.body ?? "");
  const verb = blocks.find((b) => ["get", "post", "put", "patch", "delete", "options", "head", "connect", "trace"].includes(b.name));
  if (!verb) return null;
  const spec = bruPairs(verb.body);
  const bodyMode = pairValue(spec, "body");
  const body = defaultBody();
  const blk = (n: string) => blocks.find((b) => b.name === n)?.body;
  if (bodyMode === "json" || bodyMode === "text" || bodyMode === "xml") {
    body.mode = "raw"; body.raw = blk(`body:${bodyMode}`) ?? ""; body.rawLanguage = bodyMode === "xml" ? "xml" : bodyMode === "json" ? "json" : "text";
  } else if (bodyMode === "formUrlEncoded" || bodyMode === "form-urlencoded") {
    body.mode = "urlencoded"; body.urlencoded = bruPairs(blk("body:form-urlencoded") ?? "");
  } else if (bodyMode === "multipartForm" || bodyMode === "multipart-form") {
    body.mode = "formdata"; body.formdata = bruPairs(blk("body:multipart-form") ?? "").map((p) => (p.value.startsWith("@file(") ? { ...p, type: "file" as const, value: p.value.slice(6, -1) } : p));
  } else if (bodyMode === "graphql") {
    body.mode = "graphql"; body.graphql = { query: blk("body:graphql") ?? "", variables: blk("body:graphql:vars") ?? "" };
  }
  const url = pairValue(spec, "url");
  const request = newRequest({
    name: pairValue(meta, "name") || "Request",
    method: verb.name.toUpperCase(),
    url,
    params: [...bruPairs(blk("params:query") ?? blk("query") ?? "")],
    pathVariables: bruPairs(blk("params:path") ?? ""),
    headers: bruPairs(blk("headers") ?? ""),
    body,
    auth: bruAuth(blocks, pairValue(spec, "auth")),
    preRequestScript: blk("script:pre-request") ?? "",
    testScript: [blk("script:post-response"), blk("tests")].filter(Boolean).join("\n\n"),
    description: blk("docs") ?? "",
  });
  return { request, seq: Number(pairValue(meta, "seq")) || 0 };
}

/** A Bruno collection folder (files with paths relative to it) → a collection plus its environments. */
export function importBrunoFolder(files: { path: string; content: string }[]): { collection: Collection; environments: Environment[] } {
  const rel = (p: string) => p.replace(/\\/g, "/").replace(/^\.?\//, "");
  const manifest = files.find((f) => rel(f.path) === "bruno.json");
  let name = "Bruno collection";
  try { if (manifest) name = JSON.parse(manifest.content).name ?? name; } catch { /* ignore */ }
  const col = newCollection(name);
  const colBru = files.find((f) => rel(f.path) === "collection.bru");
  if (colBru) {
    const blocks = parseBruBlocks(colBru.content);
    col.auth = bruAuth(blocks, bruPairs(blocks.find((b) => b.name === "auth")?.body ?? "").find((p) => p.key === "mode")?.value ?? "none");
    col.preRequestScript = blocks.find((b) => b.name === "script:pre-request")?.body ?? "";
    col.testScript = blocks.find((b) => b.name === "tests")?.body ?? "";
    col.description = blocks.find((b) => b.name === "docs")?.body ?? "";
  }
  const folders = new Map<string, FolderItem>();
  const folderFor = (dir: string): Item[] => {
    if (!dir) return col.items;
    let f = folders.get(dir);
    if (!f) {
      const parts = dir.split("/");
      f = newFolder(parts[parts.length - 1]);
      const meta = files.find((x) => rel(x.path) === `${dir}/folder.bru`);
      if (meta) {
        const n = bruPairs(parseBruBlocks(meta.content).find((b) => b.name === "meta")?.body ?? "");
        f.name = pairValue(n, "name") || f.name;
      }
      folders.set(dir, f);
      folderFor(parts.slice(0, -1).join("/")).push(f);
    }
    return f.items;
  };
  const requests: { dir: string; seq: number; request: RequestItem }[] = [];
  const environments: Environment[] = [];
  for (const f of files) {
    const p = rel(f.path);
    if (!p.endsWith(".bru") || p === "collection.bru" || p.endsWith("/folder.bru") || p === "folder.bru") continue;
    if (p.startsWith("environments/")) {
      const blocks = parseBruBlocks(f.content);
      const vars = bruPairs(blocks.find((b) => b.name === "vars")?.body ?? "");
      const secrets = (blocks.find((b) => b.name === "vars:secret")?.body ?? "").split(/[\n,]/).map((s) => s.trim().replace(/^~/, "")).filter(Boolean);
      environments.push({ id: uid(), name: p.slice(13, -4), variables: [...vars, ...secrets.map((k) => kv(k, "", { secret: true }))] });
      continue;
    }
    const r = importBruRequest(f.content);
    if (r) requests.push({ dir: p.split("/").slice(0, -1).join("/"), ...r });
  }
  requests.sort((a, b) => a.dir.localeCompare(b.dir) || a.seq - b.seq);
  for (const r of requests) folderFor(r.dir).push(r.request);
  return { collection: col, environments };
}
