// The docs model: one normalized, render-ready description of a collection's documentation.
// The in-app Docs view, the static site, the Markdown export, the live docs server and the CLI
// all render from this, so they can't disagree. Pure (no store, no DOM) and deterministic.
import type { Auth, Collection, DocStatus, Environment, Example, FolderItem, Item, KV, ParamDoc, RequestItem } from "../../types";
import { generate, LANGUAGES, type LanguageId } from "../codegen";
import { effectiveAuth, prepareRequest } from "../engine";
import { SENSITIVE_HEADER } from "../leaks";
import { slugify } from "../linked";
import { tryPrettyJson } from "../utils";
import { emptyScopes, resolve, VarScope, type Scopes } from "../vars";
import { schemaRows, type SchemaRow } from "./schema";

export const DEFAULT_LANGUAGES: LanguageId[] = ["curl", "fetch", "python", "go", "java", "csharp"];

export interface DocsParam extends ParamDoc {
  name: string;
  value: string;
  description: string;
}

export interface DocsExample {
  id: string;
  name: string;
  description: string;
  status: number;
  statusText: string;
  headers: { key: string; value: string }[];
  body: string;
  language: "json" | "xml" | "html" | "text";
  default: boolean;
  schemaRows: SchemaRow[];
}

export interface DocsBody {
  mode: RequestItem["body"]["mode"];
  /** Example payload (raw / GraphQL), pretty-printed when JSON. */
  example?: string;
  language?: string;
  contentType?: string;
  /** Form fields (urlencoded / form-data). */
  fields?: DocsParam[];
  schemaRows: SchemaRow[];
}

export interface DocsSample { lang: LanguageId; label: string; code: string }

export interface DocsEndpoint {
  kind: "endpoint";
  id: string;
  anchor: string;
  name: string;
  method: string;
  protocol: "http" | "ws" | "sse";
  /** URL as documented: non-secret variables filled in, the rest left as {{name}}. */
  url: string;
  description: string;
  status?: DocStatus;
  tags: string[];
  /** Human-readable auth requirement, or null when none. */
  auth: string | null;
  pathVariables: DocsParam[];
  query: DocsParam[];
  headers: DocsParam[];
  body: DocsBody | null;
  responseSchemaRows: SchemaRow[];
  examples: DocsExample[];
  samples: DocsSample[];
  /** Folder names from the collection root down to this endpoint. */
  trail: string[];
  depth: number;
}

export interface DocsFolder {
  kind: "folder";
  id: string;
  anchor: string;
  name: string;
  description: string;
  trail: string[];
  depth: number;
}

export interface DocsPage {
  kind: "page";
  id: string;
  anchor: string;
  title: string;
  body: string;
}

export type DocsSection = DocsFolder | DocsEndpoint;

export interface DocsModel {
  collectionId: string;
  title: string;
  description: string;
  version?: string;
  logo?: string;
  accent?: string;
  /** Collection-wide auth requirement. */
  auth: string | null;
  pages: DocsPage[];
  sections: DocsSection[];
  languages: DocsSample["lang"][];
  /** Request/page/folder id → anchor, for `#req:<id>` links. */
  anchors: Record<string, string>;
}

export interface DocsOptions {
  environment?: Environment;
  globals?: KV[];
  languages?: LanguageId[];
}

/** Variables for docs output: disabled and secret values never resolve (they stay `{{name}}`). */
function docsScopes(c: Collection, o: DocsOptions): Scopes {
  const safe = (vars: KV[] = []) => vars.filter((v) => v.enabled && v.key && !v.secret && !v.inKeychain);
  return { ...emptyScopes(), globals: new VarScope(safe(o.globals)), collection: new VarScope(safe(c.variables)), environment: new VarScope(safe(o.environment?.variables)), keepDynamic: true };
}

const AUTH_TEXT: Record<string, string> = {
  basic: "HTTP Basic authentication (`Authorization: Basic <credentials>`)",
  digest: "HTTP Digest authentication",
  awsv4: "AWS Signature Version 4",
  hawk: "Hawk authentication",
};

function authText(a: Auth): string | null {
  switch (a.type) {
    case "none":
    case "inherit": return null;
    case "bearer": return `Bearer token in the \`Authorization\` header${a.bearer.prefix && a.bearer.prefix !== "Bearer" ? ` (prefix \`${a.bearer.prefix}\`)` : ""}`;
    case "apikey": return `API key \`${a.apikey.key || "key"}\` in the ${a.apikey.in === "query" ? "query string" : "header"}`;
    case "oauth2": {
      const g = a.oauth2?.grantType;
      return `OAuth 2.0 access token${g ? ` (${({ authorization_code: "authorization code", client_credentials: "client credentials", password: "password" } as Record<string, string>)[g] ?? g} grant)` : ""}`;
    }
    default: return AUTH_TEXT[a.type] ?? a.type;
  }
}

/** The request as it should appear in samples: credentials replaced with placeholders. */
function placeholderAuth(a: Auth): { auth: Auth; header?: { key: string; value: string } } {
  const c: Auth = JSON.parse(JSON.stringify(a));
  switch (c.type) {
    case "bearer": c.bearer.token = "<token>"; return { auth: c };
    case "apikey": c.apikey.value = "<api-key>"; return { auth: c };
    case "basic": return { auth: { ...c, type: "none" }, header: { key: "Authorization", value: "Basic <credentials>" } };
    case "oauth2": return { auth: { ...c, type: "none" }, header: { key: "Authorization", value: `${c.oauth2?.headerPrefix?.trim() || "Bearer"} <access-token>` } };
    case "digest": return { auth: { ...c, type: "none" }, header: { key: "Authorization", value: "Digest <credentials>" } };
    case "awsv4": return { auth: { ...c, type: "none" }, header: { key: "Authorization", value: "AWS4-HMAC-SHA256 <signature>" } };
    case "hawk": return { auth: { ...c, type: "none" }, header: { key: "Authorization", value: "Hawk <mac>" } };
    default: return { auth: { ...c, type: "none" } };
  }
}

function param(kv: KV, resolveValue: (s: string) => string, sensitive = false): DocsParam {
  const value = sensitive && !/^\s*\{\{[^{}]+\}\}\s*$/.test(kv.value) && kv.value ? "<value>" : resolveValue(kv.value);
  return { ...(kv.doc ?? {}), name: kv.key, value, description: kv.description ?? "" };
}

function exampleLanguage(ex: Example): DocsExample["language"] {
  const ct = ex.headers.find((h) => h.key.toLowerCase() === "content-type")?.value ?? "";
  if (/json/i.test(ct) || tryPrettyJson(ex.body) !== null) return "json";
  if (/xml/i.test(ct)) return "xml";
  if (/html/i.test(ct)) return "html";
  return "text";
}

/** Unique, stable anchors derived from names (`get-users`, `get-users-2`…). */
function anchorMaker() {
  const used = new Set<string>();
  return (base: string) => {
    const s = slugify(base);
    let a = s, n = 2;
    while (used.has(a)) a = `${s}-${n++}`;
    used.add(a);
    return a;
  };
}

export function buildDocsModel(c: Collection, o: DocsOptions = {}): DocsModel {
  const scopes = docsScopes(c, o);
  const languages = (o.languages?.length ? o.languages : (c.docsConfig?.languages as LanguageId[] | undefined)?.length ? (c.docsConfig!.languages as LanguageId[]) : DEFAULT_LANGUAGES)
    .filter((l) => LANGUAGES.some((x) => x.id === l));
  const anchor = anchorMaker();
  const anchors: Record<string, string> = {};
  // Resolved with the docs scopes only: no dynamic values, no secrets.
  const res = (s: string) => resolve(s, scopes);

  const pages: DocsPage[] = (c.pages ?? []).map((p) => {
    const a = anchor(`page-${p.title || "page"}`);
    anchors[p.id] = a;
    return { kind: "page", id: p.id, anchor: a, title: p.title || "Untitled page", body: p.body };
  });

  const sections: DocsSection[] = [];
  const walk = (items: Item[], trail: FolderItem[]) => {
    for (const it of items) {
      if (it.type === "folder") {
        if (it.docs?.hidden) continue;
        const a = anchor(it.name);
        anchors[it.id] = a;
        sections.push({ kind: "folder", id: it.id, anchor: a, name: it.name, description: it.description, trail: trail.map((f) => f.name), depth: trail.length });
        walk(it.items, [...trail, it]);
        continue;
      }
      if (it.docs?.hidden) continue;
      sections.push(endpoint(it, trail));
    }
  };

  const endpoint = (r: RequestItem, trail: FolderItem[]): DocsEndpoint => {
    const protocol = r.protocol ?? "http";
    const method = protocol === "ws" ? "WS" : protocol === "sse" ? "SSE" : r.method.toUpperCase();
    const a = anchor(`${method} ${r.name}`);
    anchors[r.id] = a;
    const auth = effectiveAuth(r, trail, c);
    const resolveValue = (s: string) => (s.includes("{{") ? res(s) : s);

    const b = r.body;
    let body: DocsBody | null = null;
    const bodyRows = schemaRows(r.docs?.bodySchema ?? "");
    if (protocol === "http") {
      if (b.mode === "raw" && b.raw.trim()) {
        body = { mode: "raw", example: b.rawLanguage === "json" ? tryPrettyJson(resolveValue(b.raw)) ?? resolveValue(b.raw) : resolveValue(b.raw), language: b.rawLanguage, schemaRows: bodyRows };
      } else if (b.mode === "graphql" && b.graphql.query.trim()) {
        body = { mode: "graphql", example: b.graphql.query, language: "graphql", schemaRows: bodyRows };
      } else if (b.mode === "urlencoded" || b.mode === "formdata") {
        const rows = (b.mode === "urlencoded" ? b.urlencoded : b.formdata).filter((f) => f.enabled && f.key);
        body = { mode: b.mode, fields: rows.map((f) => ({ ...param(f, resolveValue), ...(f.type === "file" ? { type: "string" as const, format: "binary", value: "<file>" } : {}) })), schemaRows: bodyRows };
      } else if (b.mode === "binary") {
        body = { mode: "binary", schemaRows: [] };
      } else if (bodyRows.length) {
        body = { mode: "raw", schemaRows: bodyRows };
      }
    }

    const samples: DocsSample[] = [];
    if (protocol === "http") {
      const ph = placeholderAuth(auth);
      const req: RequestItem = {
        ...r,
        headers: [...r.headers.map((h) => (SENSITIVE_HEADER.test(h.key) && h.value && !/^\s*\{\{[^{}]+\}\}\s*$/.test(h.value) ? { ...h, value: "<value>" } : h)),
          ...(ph.header && !r.headers.some((h) => h.enabled && h.key.toLowerCase() === "authorization") ? [{ id: "auth", key: ph.header.key, value: ph.header.value, enabled: true }] : [])],
      };
      try {
        const prepared = prepareRequest(req, ph.auth, scopes);
        for (const lang of languages) samples.push({ lang, label: LANGUAGES.find((l) => l.id === lang)!.label, code: generate(lang, prepared) });
      } catch { /* e.g. invalid GraphQL variables: no samples */ }
    }

    const examples = [...(r.examples ?? [])].sort((x, y) => Number(!!y.default) - Number(!!x.default)).map((ex): DocsExample => {
      const language = exampleLanguage(ex);
      return {
        id: ex.id, name: ex.name, description: ex.description ?? "", status: ex.status, statusText: ex.statusText ?? "",
        headers: ex.headers.filter((h) => h.enabled !== false && h.key && !/^set-cookie$/i.test(h.key)).map((h) => ({ key: h.key, value: h.value })),
        body: language === "json" ? tryPrettyJson(ex.body) ?? ex.body : ex.body,
        language, default: !!ex.default, schemaRows: schemaRows(ex.schema ?? ""),
      };
    });

    return {
      kind: "endpoint", id: r.id, anchor: a, name: r.name, method, protocol,
      url: resolveValue(r.url), description: r.description, status: r.docs?.status, tags: r.docs?.tags ?? [],
      auth: authText(auth),
      pathVariables: (r.pathVariables ?? []).filter((p) => p.key).map((p) => ({ ...param(p, resolveValue), required: p.doc?.required ?? true })),
      query: r.params.filter((p) => p.key && (p.enabled || p.description || p.doc)).map((p) => param(p, resolveValue)),
      headers: r.headers.filter((h) => h.enabled && h.key).map((h) => param(h, resolveValue, SENSITIVE_HEADER.test(h.key))),
      body, responseSchemaRows: schemaRows(r.responseSchema ?? ""), examples, samples,
      trail: trail.map((f) => f.name), depth: trail.length,
    };
  };

  walk(c.items, []);
  return {
    collectionId: c.id,
    title: c.docsConfig?.title || c.name,
    description: c.description,
    version: c.docsConfig?.version || undefined,
    logo: c.docsConfig?.logo || undefined,
    accent: c.docsConfig?.accent || undefined,
    auth: authText(c.auth),
    pages, sections, languages, anchors,
  };
}

export const endpoints = (m: DocsModel) => m.sections.filter((s): s is DocsEndpoint => s.kind === "endpoint");
