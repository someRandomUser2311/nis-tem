// Search over the workspace: the command palette's fuzzy matcher, full-text search inside
// requests, and collection-wide find & replace. Pure functions, no store access.
import type { Collection, Environment, FolderItem, Item, KV, RequestItem } from "../types";
import { requestBadge } from "./utils";

// ---------------------------------------------------------------- fuzzy matching

/**
 * Score how well `query` matches `text` as an in-order subsequence (case-insensitive).
 * Returns -1 for no match. Contiguous runs, word starts and early matches score higher.
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return 0;
  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) return 1000 - direct * 2 - (t.length - q.length) * 0.1 + (isWordStart(t, direct) ? 50 : 0);
  let score = 0, ti = 0, run = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    run = found === ti ? run + 1 : 0;
    score += 10 + run * 5 + (isWordStart(t, found) ? 8 : 0) - Math.min(found - ti, 10);
    ti = found + 1;
  }
  return score;
}

function isWordStart(t: string, i: number) {
  return i === 0 || /[\s/_.\-:{]/.test(t[i - 1]);
}

// ---------------------------------------------------------------- palette index

export type PaletteTarget =
  | { kind: "request"; collectionId: string; itemId: string; method: string }
  | { kind: "folder"; collectionId: string; folderId: string }
  | { kind: "collection"; collectionId: string }
  | { kind: "environment"; environmentId: string };

export interface PaletteEntry {
  id: string;
  title: string;
  /** Breadcrumb or URL shown under the title; also searched. */
  subtitle: string;
  target: PaletteTarget;
}

export function buildPaletteIndex(collections: Collection[], environments: Environment[]): PaletteEntry[] {
  const out: PaletteEntry[] = [];
  for (const c of collections) {
    out.push({ id: c.id, title: c.name, subtitle: "Collection", target: { kind: "collection", collectionId: c.id } });
    const walk = (items: Item[], trail: string[]) => {
      for (const it of items) {
        if (it.type === "folder") {
          out.push({ id: it.id, title: it.name, subtitle: [c.name, ...trail].join(" / "), target: { kind: "folder", collectionId: c.id, folderId: it.id } });
          walk(it.items, [...trail, it.name]);
        } else {
          out.push({
            id: it.id, title: it.name, subtitle: `${[c.name, ...trail].join(" / ")} · ${it.url}`,
            target: { kind: "request", collectionId: c.id, itemId: it.id, method: requestBadge(it) },
          });
        }
      }
    };
    walk(c.items, []);
  }
  for (const e of environments) out.push({ id: e.id, title: e.name, subtitle: "Environment", target: { kind: "environment", environmentId: e.id } });
  return out;
}

/** Rank entries (or anything with a title/subtitle); title matches beat subtitle matches. */
export function rank<T extends { title: string; subtitle?: string }>(query: string, entries: T[], limit = 50): T[] {
  if (!query.trim()) return entries.slice(0, limit);
  return entries
    .map((e) => {
      const a = fuzzyScore(query, e.title);
      const b = e.subtitle ? fuzzyScore(query, e.subtitle) : -1;
      return { e, s: Math.max(a >= 0 ? a + 200 : -1, b) };
    })
    .filter((x) => x.s >= 0)
    .sort((x, y) => y.s - x.s)
    .slice(0, limit)
    .map((x) => x.e);
}

// ---------------------------------------------------------------- full-text search

export type SearchField = "name" | "url" | "headers" | "params" | "body" | "scripts" | "description";

export interface ContentMatch {
  collectionId: string;
  itemId: string;
  name: string;
  method: string;
  path: string;
  field: SearchField;
  /** Text around the match; `[start, end)` marks the match inside it. */
  snippet: string;
  start: number;
  end: number;
}

const kvText = (rows: KV[]) => rows.map((r) => `${r.key}: ${r.value}`).join("\n");

function requestFields(r: RequestItem): [SearchField, string][] {
  const body = r.body.mode === "raw" ? r.body.raw
    : r.body.mode === "graphql" ? `${r.body.graphql.query}\n${r.body.graphql.variables}`
    : r.body.mode === "urlencoded" ? kvText(r.body.urlencoded)
    : r.body.mode === "formdata" ? kvText(r.body.formdata) : "";
  return [
    ["name", r.name], ["url", r.url], ["headers", kvText(r.headers)], ["params", kvText(r.params)],
    ["body", body], ["scripts", `${r.preRequestScript}\n${r.testScript}`], ["description", r.description],
  ];
}

function snippetAround(text: string, idx: number, len: number) {
  const lineStart = text.lastIndexOf("\n", idx) + 1;
  const lineEndRaw = text.indexOf("\n", idx + len);
  const lineEnd = lineEndRaw < 0 ? text.length : lineEndRaw;
  const from = Math.max(lineStart, idx - 40);
  const to = Math.min(lineEnd, idx + len + 60);
  const prefix = from > lineStart ? "…" : "";
  const snippet = prefix + text.slice(from, to).replace(/\t/g, " ") + (to < lineEnd ? "…" : "");
  return { snippet, start: prefix.length + idx - from, end: prefix.length + idx - from + len };
}

/** Case-insensitive substring search in every request of every collection (first hit per field). */
export function searchContents(query: string, collections: Collection[], limit = 200): ContentMatch[] {
  const q = query.toLowerCase();
  if (q.length < 2) return [];
  const out: ContentMatch[] = [];
  for (const c of collections) {
    const walk = (items: Item[], trail: string[]) => {
      for (const it of items) {
        if (out.length >= limit) return;
        if (it.type === "folder") { walk(it.items, [...trail, it.name]); continue; }
        for (const [field, text] of requestFields(it)) {
          const idx = text.toLowerCase().indexOf(q);
          if (idx < 0) continue;
          out.push({
            collectionId: c.id, itemId: it.id, name: it.name, method: requestBadge(it), path: [c.name, ...trail].join(" / "),
            field, ...snippetAround(text, idx, q.length),
          });
        }
      }
    };
    walk(c.items, []);
  }
  return out;
}

// ---------------------------------------------------------------- find & replace

export type ReplaceField = "url" | "headers" | "params" | "body" | "auth";

export interface ReplaceOptions {
  regex?: boolean;
  caseSensitive?: boolean;
  fields: ReplaceField[];
}

export interface ReplacePreview {
  itemId: string;
  name: string;
  field: ReplaceField;
  before: string;
  after: string;
  count: number;
}

export function makeMatcher(find: string, opts: Pick<ReplaceOptions, "regex" | "caseSensitive">): RegExp | null {
  if (!find) return null;
  try {
    return new RegExp(opts.regex ? find : find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), opts.caseSensitive ? "g" : "gi");
  } catch {
    return null;
  }
}

function replaceIn(s: string, re: RegExp, repl: string, refs: boolean): [string, number] {
  let n = 0;
  const out = s.replace(re, (...args) => {
    n++;
    // Regex mode supports $1-style group references; literal mode inserts the text as is.
    return refs ? repl.replace(/\$(\d)/g, (_, d) => args[Number(d)] ?? "") : repl;
  });
  return [out, n];
}

/**
 * Apply find & replace to every request in `items` (mutates a clone the caller provides).
 * Returns what changed, one entry per request field.
 */
export function replaceInItems(items: Item[], find: string, repl: string, opts: ReplaceOptions): ReplacePreview[] {
  const re = makeMatcher(find, opts);
  if (!re) return [];
  const rep = (s: string) => replaceIn(s, re, repl, !!opts.regex);
  const changes: ReplacePreview[] = [];
  const has = (f: ReplaceField) => opts.fields.includes(f);
  const kvs = (rows: KV[], it: RequestItem, field: ReplaceField) => {
    let total = 0;
    const before = kvText(rows);
    for (const r of rows) {
      const [k, a] = rep(r.key);
      const [v, b] = rep(r.value);
      r.key = k; r.value = v; total += a + b;
    }
    if (total) changes.push({ itemId: it.id, name: it.name, field, before, after: kvText(rows), count: total });
  };
  const str = (it: RequestItem, field: ReplaceField, get: () => string, put: (v: string) => void) => {
    const before = get();
    const [after, n] = rep(before);
    if (n) { put(after); changes.push({ itemId: it.id, name: it.name, field, before, after, count: n }); }
  };
  const walk = (list: Item[]) => {
    for (const it of list) {
      if (it.type === "folder") { walk((it as FolderItem).items); continue; }
      if (has("url")) str(it, "url", () => it.url, (v) => { it.url = v; });
      if (has("params")) kvs(it.params, it, "params");
      if (has("headers")) kvs(it.headers, it, "headers");
      if (has("body")) {
        const b = it.body;
        if (b.mode === "raw") str(it, "body", () => b.raw, (v) => { b.raw = v; });
        else if (b.mode === "graphql") str(it, "body", () => b.graphql.query, (v) => { b.graphql.query = v; });
        else if (b.mode === "urlencoded") kvs(b.urlencoded, it, "body");
        else if (b.mode === "formdata") kvs(b.formdata, it, "body");
      }
      if (has("auth")) {
        const a = it.auth;
        if (a.type === "bearer") str(it, "auth", () => a.bearer.token, (v) => { a.bearer.token = v; });
        if (a.type === "basic") str(it, "auth", () => a.basic.username, (v) => { a.basic.username = v; });
        if (a.type === "apikey") str(it, "auth", () => a.apikey.value, (v) => { a.apikey.value = v; });
      }
    }
  };
  walk(items);
  return changes;
}

// ---------------------------------------------------------------- JSON → table

export interface TableData {
  columns: string[];
  rows: unknown[][];
}

/**
 * A JSON value shown as a table: an array of objects (union of keys as columns), an array of
 * primitives (one "value" column), or an object whose single array property is such a list
 * (e.g. `{ "data": [...] }`). Returns null when the value isn't tabular.
 */
export function toTable(value: unknown): TableData | null {
  let arr: unknown[] | null = Array.isArray(value) ? value : null;
  if (!arr && value && typeof value === "object") {
    const arrays = Object.values(value as Record<string, unknown>).filter(Array.isArray);
    if (arrays.length === 1) arr = arrays[0] as unknown[];
  }
  if (!arr || !arr.length) return null;
  if (arr.every((r) => r && typeof r === "object" && !Array.isArray(r))) {
    const cols: string[] = [];
    for (const r of arr) for (const k of Object.keys(r as object)) if (!cols.includes(k)) cols.push(k);
    return { columns: cols, rows: arr.map((r) => cols.map((c) => (r as Record<string, unknown>)[c])) };
  }
  return { columns: ["value"], rows: arr.map((v) => [v]) };
}

export function cellText(v: unknown): string {
  if (v === undefined) return "";
  if (v === null) return "null";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

export function tableToCsv(t: TableData): string {
  const esc = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return [t.columns.map(esc).join(","), ...t.rows.map((r) => r.map((c) => esc(cellText(c))).join(","))].join("\n");
}

// ---------------------------------------------------------------- environments

export interface EnvDiffRow {
  key: string;
  a?: string;
  b?: string;
  status: "same" | "different" | "onlyA" | "onlyB";
}

export function diffEnvironments(a: KV[], b: KV[]): EnvDiffRow[] {
  const keys: string[] = [];
  for (const v of [...a, ...b]) if (v.key && !keys.includes(v.key)) keys.push(v.key);
  return keys.map((key) => {
    const x = a.find((v) => v.key === key)?.value;
    const y = b.find((v) => v.key === key)?.value;
    const status = x === undefined ? "onlyB" : y === undefined ? "onlyA" : x === y ? "same" : "different";
    return { key, a: x, b: y, status };
  });
}
