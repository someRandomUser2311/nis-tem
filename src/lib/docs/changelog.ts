// API changes between two versions of a collection (a docs snapshot, another export, a git
// checkout…): endpoints added and removed, and what changed in the ones that stayed.
import type { Collection, KV, RequestItem } from "../../types";
import { splitServer } from "../exporters";
import { diffJson } from "../tools";
import { flattenRequests } from "../utils";

export interface EndpointRef { method: string; path: string; name: string }

export interface ChangedEndpoint extends EndpointRef {
  changes: string[];
  /** True when a change can break existing clients. */
  breaking: boolean;
}

export interface CollectionDiff {
  added: EndpointRef[];
  removed: EndpointRef[];
  changed: ChangedEndpoint[];
}

/** Endpoints are matched on method + path, with variable names ignored (`/users/{id}` = `/users/:userId`). */
const keyOf = (r: RequestItem) => {
  const { path } = splitServer(r.url);
  return `${r.method.toUpperCase()} ${path.split("?")[0].replace(/\{[^}]+\}/g, "{}").replace(/\/+$/, "") || "/"}`;
};

function endpointsOf(c: Collection): Map<string, RequestItem> {
  const m = new Map<string, RequestItem>();
  const visible = (items: Collection["items"]): RequestItem[] => items.flatMap((i) => (i.docs?.hidden ? [] : i.type === "folder" ? visible(i.items) : [i]));
  for (const r of visible(c.items)) if ((r.protocol ?? "http") === "http") m.set(keyOf(r), r);
  return m;
}

const ref = (r: RequestItem): EndpointRef => ({ method: r.method.toUpperCase(), path: splitServer(r.url).path.split("?")[0], name: r.name });

function paramChanges(kind: string, before: KV[], after: KV[], out: string[], breaking: { v: boolean }) {
  const on = (l: KV[]) => new Map(l.filter((p) => p.key && (p.enabled || p.doc)).map((p) => [p.key.toLowerCase(), p]));
  const a = on(before), b = on(after);
  for (const [k, p] of b) {
    const old = a.get(k);
    if (!old) {
      out.push(`New ${kind} \`${p.key}\`${p.doc?.required ? " (required)" : ""}`);
      if (p.doc?.required) breaking.v = true;
      continue;
    }
    if (p.doc?.required && !old.doc?.required) { out.push(`${cap(kind)} \`${p.key}\` is now required`); breaking.v = true; }
    if (!p.doc?.required && old.doc?.required) out.push(`${cap(kind)} \`${p.key}\` is now optional`);
    if ((p.doc?.type ?? "string") !== (old.doc?.type ?? "string")) { out.push(`${cap(kind)} \`${p.key}\` type: ${old.doc?.type ?? "string"} → ${p.doc?.type ?? "string"}`); breaking.v = true; }
    if (p.doc?.deprecated && !old.doc?.deprecated) out.push(`${cap(kind)} \`${p.key}\` is deprecated`);
    const ea = (old.doc?.enum ?? []).join("|"), eb = (p.doc?.enum ?? []).join("|");
    if (ea !== eb) {
      const removed = (old.doc?.enum ?? []).filter((v) => !(p.doc?.enum ?? []).includes(v));
      out.push(`${cap(kind)} \`${p.key}\` allowed values changed${removed.length ? ` (removed ${removed.map((v) => `\`${v}\``).join(", ")})` : ""}`);
      if (removed.length && p.doc?.enum?.length) breaking.v = true;
    }
  }
  for (const [k, p] of a) if (!b.has(k)) out.push(`Removed ${kind} \`${p.key}\``);
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
const parse = (s: string | undefined) => { try { return s?.trim() ? JSON.parse(s) : undefined; } catch { return undefined; } };

function schemaChanges(label: string, before: string | undefined, after: string | undefined, out: string[], breaking: { v: boolean }) {
  const a = parse(before), b = parse(after);
  if (a === undefined && b === undefined) return;
  if (a === undefined) { out.push(`${label} schema documented`); return; }
  if (b === undefined) { out.push(`${label} schema removed`); return; }
  const changes = diffJson(a, b).filter((c) => !/\.(description|title|examples?)$/.test(c.path));
  if (!changes.length) return;
  const props = (p: string) => p.replace(/^\$\./, "").replace(/\.properties\./g, ".").replace(/^properties\./, "").replace(/\.items/g, "[]");
  const lines = changes.slice(0, 6).map((c) => {
    const where = props(c.path);
    if (c.kind === "added") return /\brequired\[\d+\]$/.test(c.path) ? `now requires \`${String(c.after)}\`` : `added \`${where}\``;
    if (c.kind === "removed") return /\brequired\[\d+\]$/.test(c.path) ? `no longer requires \`${String(c.before)}\`` : `removed \`${where}\``;
    return `\`${where}\`: ${JSON.stringify(c.before)} → ${JSON.stringify(c.after)}`;
  });
  out.push(`${label} schema: ${lines.join("; ")}${changes.length > 6 ? `; …${changes.length - 6} more` : ""}`);
  const isRequest = label === "Request body";
  // Clients break when a request needs something new, or a response loses / retypes a field.
  if (changes.some((c) => (isRequest ? c.kind === "added" && /required/.test(c.path) : c.kind === "removed" && !/required/.test(c.path)) || (c.kind === "changed" && /\.type$/.test(c.path)))) breaking.v = true;
}

export function diffCollections(before: Collection, after: Collection): CollectionDiff {
  const a = endpointsOf(before), b = endpointsOf(after);
  const diff: CollectionDiff = { added: [], removed: [], changed: [] };
  for (const [k, r] of b) if (!a.has(k)) diff.added.push(ref(r));
  for (const [k, r] of a) if (!b.has(k)) diff.removed.push(ref(r));
  for (const [k, now] of b) {
    const old = a.get(k);
    if (!old) continue;
    const changes: string[] = [];
    const breaking = { v: false };
    if (now.docs?.status !== old.docs?.status) {
      changes.push(now.docs?.status === "deprecated" ? "Deprecated" : `Status: ${old.docs?.status ?? "stable"} → ${now.docs?.status ?? "stable"}`);
    }
    paramChanges("path variable", old.pathVariables ?? [], now.pathVariables ?? [], changes, breaking);
    paramChanges("query parameter", old.params, now.params, changes, breaking);
    paramChanges("header", old.headers, now.headers, changes, breaking);
    if (old.body.mode !== now.body.mode) changes.push(`Request body: ${old.body.mode} → ${now.body.mode}`);
    schemaChanges("Request body", old.docs?.bodySchema, now.docs?.bodySchema, changes, breaking);
    schemaChanges("Response", old.responseSchema, now.responseSchema, changes, breaking);
    const sa = new Set((old.examples ?? []).map((e) => e.status)), sb = new Set((now.examples ?? []).map((e) => e.status));
    const newStatuses = [...sb].filter((s) => !sa.has(s)).sort(), goneStatuses = [...sa].filter((s) => !sb.has(s)).sort();
    if (newStatuses.length) changes.push(`New documented response${newStatuses.length > 1 ? "s" : ""}: ${newStatuses.join(", ")}`);
    if (goneStatuses.length) changes.push(`Response${goneStatuses.length > 1 ? "s" : ""} no longer documented: ${goneStatuses.join(", ")}`);
    if (changes.length) diff.changed.push({ ...ref(now), changes, breaking: breaking.v });
  }
  const byPath = (x: EndpointRef, y: EndpointRef) => x.path.localeCompare(y.path) || x.method.localeCompare(y.method);
  diff.added.sort(byPath); diff.removed.sort(byPath); diff.changed.sort(byPath);
  return diff;
}

export const isEmptyDiff = (d: CollectionDiff) => !d.added.length && !d.removed.length && !d.changed.length;

/** The diff as a Markdown page ("API changes"). */
export function changelogMarkdown(d: CollectionDiff, from: string, to: string): string {
  const ep = (e: EndpointRef) => `\`${e.method} ${e.path}\` — ${e.name}`;
  const breaking = [...d.removed.map((e) => ({ ...e, changes: ["Removed"] })), ...d.changed.filter((c) => c.breaking)];
  const parts = [`Changes from **${from}** to **${to}**.`, ""];
  if (isEmptyDiff(d)) return [...parts, "No API changes."].join("\n");
  if (breaking.length) {
    parts.push("> [!WARNING]", `> ${breaking.length} change${breaking.length === 1 ? " may break" : "s may break"} existing clients.`, "");
  }
  if (d.added.length) parts.push("### Added", "", ...d.added.map((e) => `- ${ep(e)}`), "");
  if (d.removed.length) parts.push("### Removed", "", ...d.removed.map((e) => `- ${ep(e)}`), "");
  if (d.changed.length) {
    parts.push("### Changed", "");
    for (const c of d.changed) {
      parts.push(`- ${ep(c)}${c.breaking ? " **(breaking)**" : ""}`, ...c.changes.map((x) => `  - ${x}`));
    }
    parts.push("");
  }
  return parts.join("\n").trimEnd();
}

/** For picking a baseline from another file: every request in it, visible or not. */
export const requestCount = (c: Collection) => flattenRequests(c.items).length;
