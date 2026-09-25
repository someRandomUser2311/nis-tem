// Git-friendly layout for linked collections:
//
//   collection.json               name, auth, variables, scripts, and the order of its children
//   users/folder.json             a folder (same idea)
//   users/get-user.request.json   one request per file
//
// Keys are written in a fixed order and long text (scripts, bodies, descriptions) as arrays of
// lines, so diffs stay small and readable. Secret variable values are never written.
import type { Collection, Example, FolderItem, Item, KV, RequestItem } from "../types";
import { newCollection, newFolder, newRequest } from "./utils";

export const LINKED_FORMAT = "localpost-collection/1";

/** Multi-line strings as arrays of lines (single-line strings stay strings). */
const lines = (s: string | undefined) => (s && s.includes("\n") ? s.split("\n") : s ?? "");
const text = (v: unknown): string => (Array.isArray(v) ? v.join("\n") : typeof v === "string" ? v : "");

export function slugify(name: string): string {
  const s = name.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return s || "untitled";
}

const kvOut = (rows: KV[]) => rows.map(({ key, value, enabled, description, type, secret }) => ({
  key, value: secret ? "" : value, ...(enabled ? {} : { enabled: false }), ...(description ? { description } : {}), ...(type && type !== "text" ? { type } : {}), ...(secret ? { secret: true } : {}),
}));
const kvIn = (rows: any, ids = false): KV[] => (Array.isArray(rows) ? rows : []).map((r: any, i: number) => ({
  id: ids && r.id ? r.id : `kv-${i}-${Math.random().toString(36).slice(2, 8)}`,
  key: String(r.key ?? ""), value: String(r.value ?? ""), enabled: r.enabled !== false,
  ...(r.description ? { description: String(r.description) } : {}), ...(r.type ? { type: r.type } : {}), ...(r.secret ? { secret: true } : {}),
}));

function requestOut(r: RequestItem) {
  const b = r.body;
  return {
    id: r.id,
    name: r.name,
    ...(r.protocol && r.protocol !== "http" ? { protocol: r.protocol } : {}),
    method: r.method,
    url: r.url,
    ...(r.params.length ? { params: kvOut(r.params) } : {}),
    ...(r.pathVariables?.length ? { pathVariables: kvOut(r.pathVariables) } : {}),
    ...(r.headers.length ? { headers: kvOut(r.headers) } : {}),
    body: {
      mode: b.mode,
      ...(b.mode === "raw" ? { language: b.rawLanguage, raw: lines(b.raw) } : {}),
      ...(b.mode === "urlencoded" ? { urlencoded: kvOut(b.urlencoded) } : {}),
      ...(b.mode === "formdata" ? { formdata: kvOut(b.formdata) } : {}),
      ...(b.mode === "binary" ? { file: b.binaryPath } : {}),
      ...(b.mode === "graphql" ? { query: lines(b.graphql.query), variables: lines(b.graphql.variables) } : {}),
    },
    auth: r.auth,
    ...(r.preRequestScript ? { preRequestScript: lines(r.preRequestScript) } : {}),
    ...(r.testScript ? { testScript: lines(r.testScript) } : {}),
    ...(r.description ? { description: lines(r.description) } : {}),
    ...(Object.keys(r.settings ?? {}).length ? { settings: r.settings } : {}),
    ...(r.ws ? { ws: r.ws } : {}),
    ...(r.examples?.length ? { examples: r.examples.map((e) => ({ ...e, body: lines(e.body) })) } : {}),
  };
}

function requestIn(j: any): RequestItem {
  const b = j.body ?? {};
  const r = newRequest({
    id: j.id,
    name: String(j.name ?? "Request"),
    method: String(j.method ?? "GET"),
    url: String(j.url ?? ""),
    params: kvIn(j.params),
    pathVariables: kvIn(j.pathVariables),
    headers: kvIn(j.headers),
    preRequestScript: text(j.preRequestScript),
    testScript: text(j.testScript),
    description: text(j.description),
    settings: j.settings ?? {},
  });
  if (j.auth) r.auth = j.auth;
  if (j.protocol === "ws" || j.protocol === "sse") r.protocol = j.protocol;
  if (j.ws) r.ws = j.ws;
  if (Array.isArray(j.examples)) r.examples = j.examples.map((e: any): Example => ({ ...e, body: text(e.body) }));
  r.body = {
    ...r.body,
    mode: b.mode ?? "none",
    raw: text(b.raw),
    rawLanguage: b.language ?? "json",
    urlencoded: kvIn(b.urlencoded),
    formdata: kvIn(b.formdata),
    binaryPath: b.file ?? "",
    graphql: { query: text(b.query), variables: text(b.variables) },
  };
  return r;
}

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

/** The files for a collection (paths relative to the linked folder). */
export function collectionToFiles(c: Collection): { path: string; content: string }[] {
  const files: { path: string; content: string }[] = [];
  const children = (items: Item[], dir: string): string[] => {
    const used = new Set<string>();
    const unique = (base: string, ext: string) => {
      let name = `${base}${ext}`;
      for (let n = 2; used.has(name); n++) name = `${base}-${n}${ext}`;
      used.add(name);
      return name;
    };
    return items.map((it) => {
      if (it.type === "folder") {
        const name = unique(slugify(it.name), "");
        const sub = dir ? `${dir}/${name}` : name;
        const order = children(it.items, sub);
        files.push({ path: `${sub}/folder.json`, content: json({
          id: it.id, name: it.name, auth: it.auth,
          ...(it.description ? { description: lines(it.description) } : {}),
          ...(it.preRequestScript ? { preRequestScript: lines(it.preRequestScript) } : {}),
          ...(it.testScript ? { testScript: lines(it.testScript) } : {}),
          order,
        }) });
        return name;
      }
      const name = unique(slugify(it.name), ".request.json");
      files.push({ path: dir ? `${dir}/${name}` : name, content: json(requestOut(it)) });
      return name;
    });
  };
  const order = children(c.items, "");
  files.unshift({ path: "collection.json", content: json({
    $format: LINKED_FORMAT,
    id: c.id,
    name: c.name,
    ...(c.description ? { description: lines(c.description) } : {}),
    auth: c.auth,
    ...(c.variables.length ? { variables: kvOut(c.variables) } : {}),
    ...(c.preRequestScript ? { preRequestScript: lines(c.preRequestScript) } : {}),
    ...(c.testScript ? { testScript: lines(c.testScript) } : {}),
    order,
  }) });
  return files;
}

/**
 * Rebuild a collection from its folder. Children follow each `order` list; files that aren't
 * listed (added by hand or by a merge) come after, alphabetically. Secret variable values, which
 * are never written to the folder, are taken from `previous` when it has them.
 */
export function filesToCollection(files: { path: string; content: string }[], previous?: Collection): Collection {
  const byPath = new Map(files.map((f) => [f.path.replace(/\\/g, "/"), f.content]));
  const parse = (p: string) => { try { return JSON.parse(byPath.get(p) ?? "null"); } catch (e) { throw new Error(`${p}: ${e instanceof Error ? e.message : e}`); } };
  const root = parse("collection.json");
  if (!root) throw new Error("This folder has no collection.json");
  const col = newCollection(String(root.name ?? "Collection"));
  if (root.id) col.id = root.id;
  col.description = text(root.description);
  if (root.auth) col.auth = root.auth;
  col.variables = kvIn(root.variables);
  col.preRequestScript = text(root.preRequestScript);
  col.testScript = text(root.testScript);
  for (const v of col.variables) {
    const old = previous?.variables.find((x) => x.key === v.key);
    if (v.secret && !v.value && old?.value) v.value = old.value;
    if (old) v.id = old.id;
  }

  const load = (dir: string, order: unknown): Item[] => {
    const prefix = dir ? `${dir}/` : "";
    const direct = new Set<string>();
    for (const p of byPath.keys()) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const first = rest.split("/")[0];
      if (rest.endsWith(".request.json") && !rest.includes("/")) direct.add(first);
      else if (rest.includes("/") && byPath.has(`${prefix}${first}/folder.json`)) direct.add(first);
    }
    const listed = (Array.isArray(order) ? order : []).map(String).filter((n) => direct.has(n));
    const rest = [...direct].filter((n) => !listed.includes(n)).sort();
    return [...listed, ...rest].map((name): Item => {
      if (name.endsWith(".request.json")) return requestIn(parse(`${prefix}${name}`));
      const meta = parse(`${prefix}${name}/folder.json`) ?? {};
      const f: FolderItem = newFolder(String(meta.name ?? name));
      if (meta.id) f.id = meta.id;
      if (meta.auth) f.auth = meta.auth;
      f.description = text(meta.description);
      f.preRequestScript = text(meta.preRequestScript);
      f.testScript = text(meta.testScript);
      f.items = load(`${prefix}${name}`, meta.order);
      return f;
    });
  };
  col.items = load("", root.order);
  return col;
}

/** Stable signature of a file set, to recognise our own writes coming back from the watcher. */
export const filesSignature = (files: { path: string; content: string }[]) =>
  JSON.stringify([...files].sort((a, b) => a.path.localeCompare(b.path)).map((f) => [f.path, f.content]));
