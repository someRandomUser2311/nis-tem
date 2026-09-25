// Mock servers answer from saved examples. This turns a collection into the route table the
// Rust listener matches against (see src-tauri/src/servers.rs).
import type { Collection, Example, Item, RequestItem } from "../types";
import type { MockRoute } from "./api";
import { parseQuery } from "./utils";

/**
 * The path and query a request URL is served at. The scheme + host, or a leading `{{baseUrl}}`
 * style variable, are dropped: `{{baseUrl}}/users/:id?x=1` → `/users/:id`, `[x=1]`.
 */
export function mockPathOf(url: string): { path: string; query: { key: string; value: string }[] } {
  let rest = url.trim();
  const origin = rest.match(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i);
  if (origin) rest = rest.slice(origin[0].length);
  else if (rest.startsWith("{{")) {
    const end = rest.indexOf("}}");
    // `{{host}}/x` → `/x`; a lone `{{path}}` stays a single wildcard segment.
    if (end > 0 && rest[end + 2] === "/") rest = rest.slice(end + 2);
  } else if (!rest.startsWith("/")) {
    // `localhost:3000/x` or `api.example.com/x`
    const slash = rest.search(/[/?#]/);
    rest = slash < 0 ? "/" : rest.slice(slash);
  }
  const { base, pairs } = parseQuery(rest);
  const path = base.startsWith("/") ? base : `/${base}`;
  return { path: path.replace(/\/+/g, "/") || "/", query: pairs.map(([key, value]) => ({ key, value })) };
}

export interface CompiledRoute extends MockRoute {
  requestId: string;
  requestName: string;
  exampleId: string;
}

export function exampleRoute(req: RequestItem, ex: Example): CompiledRoute {
  const { path, query } = mockPathOf(ex.request?.url || req.url);
  return {
    method: (ex.request?.method || req.method || "GET").toUpperCase(),
    path,
    query,
    status: ex.status || 200,
    headers: ex.headers.filter((h) => h.enabled !== false && h.key).map(({ key, value }) => ({ key, value })),
    body: ex.bodyBase64 ? "" : ex.body,
    bodyBase64: ex.bodyBase64 ?? null,
    name: ex.name,
    requestId: req.id,
    requestName: req.name,
    exampleId: ex.id,
  };
}

export function compileRoutes(collection: Collection): CompiledRoute[] {
  const out: CompiledRoute[] = [];
  const walk = (items: Item[]) => {
    for (const it of items) {
      if (it.type === "folder") walk(it.items);
      else for (const ex of it.examples ?? []) out.push(exampleRoute(it, ex));
    }
  };
  walk(collection.items);
  return out;
}

/** Strip the UI-only fields before sending routes to the listener. */
export const nativeRoutes = (routes: CompiledRoute[]): MockRoute[] =>
  routes.map(({ method, path, query, status, headers, body, bodyBase64, name }) => ({ method, path, query, status, headers, body, bodyBase64, name }));
