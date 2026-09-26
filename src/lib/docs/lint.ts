// Docs checks: what's missing or wrong in a collection's documentation. Shown in the Docs view's
// Checks panel and used by `localpost docs --check` (errors fail the build).
import type { Collection, FolderItem, Item, KV, RequestItem } from "../../types";
import { scanDocsText } from "../leaks";
import { pathVariableNames } from "../utils";
import { validateSchema } from "../schema";
import { requestLinks } from "./markdown";
import type { DocsModel } from "./model";

export type Severity = "error" | "warning" | "info";

export interface DocsIssue {
  severity: Severity;
  rule: string;
  message: string;
  /** What to open to fix it: a request, folder, page, or the collection itself. */
  target: { kind: "request" | "folder" | "page" | "collection"; id: string; name: string };
}

export const RULES: Record<string, { severity: Severity; title: string }> = {
  "collection-description": { severity: "warning", title: "Collection has no description" },
  "endpoint-description": { severity: "warning", title: "Endpoint has no description" },
  "no-example": { severity: "warning", title: "Endpoint has no example response" },
  "no-default-example": { severity: "info", title: "Several examples but none is the default" },
  "undocumented-param": { severity: "info", title: "Parameter has no description" },
  "undocumented-path-variable": { severity: "warning", title: "Path variable has no description" },
  "invalid-schema": { severity: "error", title: "Schema isn't valid JSON" },
  "stale-example": { severity: "error", title: "Example doesn't match its schema" },
  "secret-in-docs": { severity: "error", title: "Credential-like text in the docs" },
  "broken-link": { severity: "error", title: "Link to a request that doesn't exist" },
  "empty-page": { severity: "warning", title: "Guide page is empty" },
};

/** Headers every client sends; not worth a description each. */
const STANDARD_HEADERS = /^(accept|accept-encoding|accept-language|content-type|content-length|user-agent|cache-control|connection|host|authorization)$/i;

const parse = (s: string | undefined): { ok: true; value: unknown } | { ok: false } | null => {
  if (!s?.trim()) return null;
  try { return { ok: true, value: JSON.parse(s) }; } catch { return { ok: false }; }
};

export function lintDocs(c: Collection, model?: DocsModel): DocsIssue[] {
  const out: DocsIssue[] = [];
  const add = (rule: string, message: string, target: DocsIssue["target"]) => out.push({ severity: RULES[rule].severity, rule, message, target });
  const colTarget = { kind: "collection" as const, id: c.id, name: c.name };
  const ids = new Set<string>();
  const hidden = new Set<string>();

  if (!c.description.trim()) add("collection-description", "Introduce the API: what it's for, base URLs, authentication.", colTarget);

  const texts: { text: string; target: DocsIssue["target"] }[] = [{ text: c.description, target: colTarget }];
  const walk = (items: Item[], parentHidden: boolean) => {
    for (const it of items) {
      ids.add(it.id);
      const isHidden = parentHidden || !!it.docs?.hidden;
      if (isHidden) hidden.add(it.id);
      if (it.type === "folder") {
        texts.push({ text: it.description, target: { kind: "folder", id: it.id, name: it.name } });
        walk((it as FolderItem).items, isHidden);
      } else if (!isHidden) {
        request(it);
      }
    }
  };

  const request = (r: RequestItem) => {
    const t = { kind: "request" as const, id: r.id, name: r.name };
    texts.push({ text: r.description, target: t });
    const http = (r.protocol ?? "http") === "http";
    if (!r.description.trim()) add("endpoint-description", `Describe what “${r.name}” does.`, t);
    const examples = r.examples ?? [];
    if (http && !examples.length) add("no-example", `Send the request and choose “Save as example”.`, t);
    if (examples.length > 1 && !examples.some((e) => e.default)) add("no-default-example", `Mark the example the docs should show first.`, t);
    for (const e of examples) if (e.description) texts.push({ text: e.description, target: t });

    const paramRule = (rows: KV[], where: string, skip?: (k: KV) => boolean) => {
      for (const p of rows) if (p.enabled && p.key && !p.description?.trim() && !skip?.(p)) add("undocumented-param", `${where} “${p.key}” has no description.`, t);
    };
    paramRule(r.params, "Query parameter");
    paramRule(r.headers, "Header", (h) => STANDARD_HEADERS.test(h.key));
    if (r.body.mode === "urlencoded") paramRule(r.body.urlencoded, "Form field");
    if (r.body.mode === "formdata") paramRule(r.body.formdata, "Form field");
    for (const name of pathVariableNames(r.url)) {
      const pv = r.pathVariables?.find((v) => v.key === name);
      if (!pv?.description?.trim()) add("undocumented-path-variable", `Path variable “:${name}” has no description.`, t);
    }

    // Schemas must parse, and examples must match them.
    const body = parse(r.docs?.bodySchema), resp = parse(r.responseSchema);
    if (body && !body.ok) add("invalid-schema", "The request body schema isn't valid JSON.", t);
    if (resp && !resp.ok) add("invalid-schema", "The response schema isn't valid JSON.", t);
    if (body?.ok && r.body.mode === "raw" && r.body.rawLanguage === "json") {
      const b = parse(r.body.raw);
      if (b?.ok) {
        try {
          const v = validateSchema(b.value, body.value);
          if (!v.valid) add("stale-example", `The request body doesn't match its schema: ${v.errors[0]}`, t);
        } catch { add("invalid-schema", "The request body schema can't be compiled.", t); }
      }
    }
    for (const e of examples) {
      const own = parse(e.schema);
      if (own && !own.ok) { add("invalid-schema", `The schema of example “${e.name}” isn't valid JSON.`, t); continue; }
      const schema = own?.ok ? own.value : e.status >= 200 && e.status < 300 && resp?.ok ? resp.value : undefined;
      const b = parse(e.body);
      if (schema === undefined || !b?.ok) continue;
      try {
        const v = validateSchema(b.value, schema);
        if (!v.valid) add("stale-example", `Example “${e.name}” doesn't match ${own?.ok ? "its schema" : "the response schema"}: ${v.errors[0]}`, t);
      } catch { add("invalid-schema", `A schema used by example “${e.name}” can't be compiled.`, t); }
    }
  };

  walk(c.items, false);
  for (const p of c.pages ?? []) {
    const t = { kind: "page" as const, id: p.id, name: p.title };
    if (!p.body.trim()) add("empty-page", `“${p.title}” has no content.`, t);
    texts.push({ text: p.body, target: t });
  }

  for (const { text, target } of texts) {
    for (const id of requestLinks(text)) {
      if (!ids.has(id)) add("broken-link", `A link in “${target.name}” points to a request that no longer exists.`, target);
      else if (hidden.has(id)) add("broken-link", `A link in “${target.name}” points to a request hidden from the docs.`, target);
    }
  }

  if (model) {
    for (const f of scanDocsText(model).findings) add("secret-in-docs", `${f.what} in ${f.where.replace(/^Docs \/ /, "")}.`, colTarget);
  }

  const order: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}

export const issueCounts = (issues: DocsIssue[]) => ({
  error: issues.filter((i) => i.severity === "error").length,
  warning: issues.filter((i) => i.severity === "warning").length,
  info: issues.filter((i) => i.severity === "info").length,
});
