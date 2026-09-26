import type { Auth, Body, Collection, FolderItem, Item, KV, RequestItem } from "../types";

export const uid = () =>
  (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36));

export const kv = (key = "", value = "", extra: Partial<KV> = {}): KV => ({
  id: uid(), key, value, enabled: true, ...extra,
});

export const defaultAuth = (type: Auth["type"] = "inherit"): Auth => ({
  type,
  basic: { username: "", password: "" },
  bearer: { token: "", prefix: "Bearer" },
  apikey: { key: "", value: "", in: "header" },
});

export const defaultBody = (): Body => ({
  mode: "none",
  raw: "",
  rawLanguage: "json",
  urlencoded: [],
  formdata: [],
  binaryPath: "",
  graphql: { query: "", variables: "" },
});

export const newRequest = (partial: Partial<RequestItem> = {}): RequestItem => ({
  id: uid(),
  type: "request",
  name: "New Request",
  method: "GET",
  url: "",
  params: [],
  headers: [],
  body: defaultBody(),
  auth: defaultAuth(),
  preRequestScript: "",
  testScript: "",
  description: "",
  settings: {},
  ...partial,
});

export const newFolder = (name = "New Folder"): FolderItem => ({
  id: uid(), type: "folder", name, items: [], auth: defaultAuth(),
  preRequestScript: "", testScript: "", description: "",
});

export const newCollection = (name = "New Collection"): Collection => ({
  id: uid(), name, items: [], auth: defaultAuth("none"), variables: [],
  preRequestScript: "", testScript: "", description: "",
});

export const clone = <T,>(v: T): T => structuredClone(v);

/**
 * Deep-clone an item giving it (and all descendants) fresh ids. Docs links (`#req:<id>`) inside
 * the copy follow the new ids; pass `ids` to share the old → new map across several clones.
 */
export function cloneWithNewIds<T extends Item>(item: T, ids = new Map<string, string>()): T {
  const c = clone(item);
  const all: Item[] = [];
  const walk = (i: Item) => {
    const id = uid();
    ids.set(i.id, id);
    i.id = id;
    all.push(i);
    if (i.type === "folder") i.items.forEach(walk);
    else i.examples?.forEach((e) => { e.id = uid(); });
  };
  walk(c);
  for (const i of all) {
    i.description = remapRequestLinks(i.description, ids);
    if (i.type === "request") i.examples?.forEach((e) => { if (e.description) e.description = remapRequestLinks(e.description, ids); });
  }
  return c;
}

/** Point `#req:<old>` links at the new ids of copied requests. */
export const remapRequestLinks = (text: string, ids: Map<string, string>) =>
  text.includes("#req:") ? text.replace(/#req:([\w-]+)/g, (m, id: string) => (ids.has(id) ? `#req:${ids.get(id)}` : m)) : text;

// ---------- tree helpers ----------

export function findItem(items: Item[], id: string): Item | undefined {
  for (const i of items) {
    if (i.id === id) return i;
    if (i.type === "folder") {
      const f = findItem(i.items, id);
      if (f) return f;
    }
  }
}

/** Returns the chain of folders from the collection root down to (excluding) the item. */
export function findPath(items: Item[], id: string, trail: FolderItem[] = []): FolderItem[] | undefined {
  for (const i of items) {
    if (i.id === id) return trail;
    if (i.type === "folder") {
      const p = findPath(i.items, id, [...trail, i]);
      if (p) return p;
    }
  }
}

export function removeItem(items: Item[], id: string): Item | undefined {
  const idx = items.findIndex((i) => i.id === id);
  if (idx >= 0) return items.splice(idx, 1)[0];
  for (const i of items) {
    if (i.type === "folder") {
      const r = removeItem(i.items, id);
      if (r) return r;
    }
  }
}

export function containsId(item: Item, id: string): boolean {
  if (item.id === id) return true;
  return item.type === "folder" && item.items.some((c) => containsId(c, id));
}

export function flattenRequests(items: Item[]): RequestItem[] {
  return items.flatMap((i) => (i.type === "request" ? [i] : flattenRequests(i.items)));
}

// ---------- formatting ----------

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(2)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/** Short label for a request in tabs and the sidebar: its method, or WS / SSE. */
export function requestBadge(r: { method: string; protocol?: string }): string {
  if (r.protocol === "ws") return "WS";
  if (r.protocol === "sse") return "SSE";
  return r.method === "DELETE" ? "DEL" : r.method.length > 6 ? r.method.slice(0, 5) : r.method;
}

export function methodColor(m: string): string {
  if (m === "WS" || m === "SSE") return "var(--info)";
  switch (m.toUpperCase()) {
    case "GET": return "var(--m-get)";
    case "POST": return "var(--m-post)";
    case "PUT": return "var(--m-put)";
    case "PATCH": return "var(--m-patch)";
    case "DELETE": return "var(--m-delete)";
    default: return "var(--m-other)";
  }
}

export function statusColor(s: number): string {
  if (s >= 200 && s < 300) return "var(--ok)";
  if (s >= 300 && s < 400) return "var(--info)";
  if (s >= 400 && s < 500) return "var(--warn)";
  return "var(--err)";
}

export function getHeader(headers: { key: string; value: string }[], name: string): string | undefined {
  const n = name.toLowerCase();
  return headers.find((h) => h.key.toLowerCase() === n)?.value;
}

export function tryPrettyJson(text: string): string | null {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return null;
  }
}

// ---------- URL <-> params ----------

/** Split a URL into base and query-string pairs without touching {{variables}}. */
export function parseQuery(url: string): { base: string; pairs: [string, string][]; hash: string } {
  let hash = "";
  const hashIdx = url.indexOf("#");
  if (hashIdx >= 0) {
    hash = url.slice(hashIdx);
    url = url.slice(0, hashIdx);
  }
  const q = url.indexOf("?");
  if (q < 0) return { base: url, pairs: [], hash };
  const base = url.slice(0, q);
  const qs = url.slice(q + 1);
  const pairs: [string, string][] = qs
    ? qs.split("&").map((part) => {
        const eq = part.indexOf("=");
        return eq < 0 ? [part, ""] : [part.slice(0, eq), part.slice(eq + 1)];
      })
    : [];
  return { base, pairs, hash };
}

export function buildUrl(base: string, params: KV[], hash = ""): string {
  const enabled = params.filter((p) => p.enabled && (p.key || p.value));
  if (!enabled.length) return base + hash;
  return `${base}?${enabled.map((p) => (p.value === "" ? p.key : `${p.key}=${p.value}`)).join("&")}${hash}`;
}

/** When the URL changes, rebuild the enabled params from it; keep disabled rows. */
export function paramsFromUrl(url: string, old: KV[]): KV[] {
  const { pairs } = parseQuery(url);
  const enabledOld = old.filter((p) => p.enabled);
  const next: KV[] = pairs.map(([k, v], i) => {
    const prev = enabledOld[i];
    return prev ? { ...prev, key: k, value: v } : kv(k, v);
  });
  return [...next, ...old.filter((p) => !p.enabled)];
}

// ---------- path variables (/users/:id) ----------

const PATH_VAR_RE = /(^|\/):([A-Za-z_][\w-]*)/g;

function splitOrigin(url: string): [string, string] {
  const m = url.match(/^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)?(.*)$/i)!;
  return [m[1] ?? "", m[2] ?? ""];
}

export function pathVariableNames(url: string): string[] {
  const [, rest] = splitOrigin(url);
  const path = rest.split(/[?#]/)[0];
  return [...path.matchAll(PATH_VAR_RE)].map((m) => m[2]);
}

/** Keep the path-variable table in sync with `:name` segments of the URL. */
export function syncPathVariables(url: string, old: KV[] = []): KV[] {
  return pathVariableNames(url).map((name) => old.find((v) => v.key === name) ?? kv(name, ""));
}

export function applyPathVariables(url: string, vars: KV[] = []): string {
  if (!vars.length) return url;
  const [origin, rest] = splitOrigin(url);
  const qIdx = rest.search(/[?#]/);
  const path = qIdx < 0 ? rest : rest.slice(0, qIdx);
  const tail = qIdx < 0 ? "" : rest.slice(qIdx);
  const replaced = path.replace(PATH_VAR_RE, (m, sep: string, name: string) => {
    const v = vars.find((x) => x.key === name);
    return v && v.value !== "" ? `${sep}${v.value}` : m;
  });
  return origin + replaced + tail;
}
