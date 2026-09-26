// JSON Schema helpers for API docs: flatten a schema into field rows for tables, and infer a
// schema from an example value ("Generate from example").

export interface SchemaRow {
  /** Dotted path, `[]` for array items: `user.tags[]`. */
  path: string;
  /** Last path segment, for display next to the indent. */
  name: string;
  depth: number;
  type: string;
  required: boolean;
  description?: string;
  format?: string;
  enum?: unknown[];
  deprecated?: boolean;
  /** Set on rows that start a oneOf/anyOf alternative. */
  variant?: string;
}

type S = Record<string, any>;

const MAX_DEPTH = 12;

function deref(s: S | undefined, root: S, seen: Set<string>): S | undefined {
  if (!s || typeof s !== "object") return undefined;
  if (typeof s.$ref === "string") {
    const ref: string = s.$ref;
    if (!ref.startsWith("#/") || seen.has(ref)) return { type: "object", description: `(${ref.split("/").pop()})` };
    const target = ref.slice(2).split("/").reduce<any>((o, k) => o?.[k.replace(/~1/g, "/").replace(/~0/g, "~")], root);
    return deref(target, root, new Set([...seen, ref]));
  }
  if (Array.isArray(s.allOf)) {
    const parts = s.allOf.map((p: S) => deref(p, root, seen)).filter(Boolean) as S[];
    const merged: S = { ...s, allOf: undefined, type: s.type ?? parts.find((p) => p.type)?.type ?? "object", properties: { ...s.properties }, required: [...(s.required ?? [])] };
    for (const p of parts) {
      Object.assign(merged.properties, p.properties ?? {});
      merged.required.push(...(p.required ?? []));
      merged.description ??= p.description;
    }
    return merged;
  }
  return s;
}

function typeLabel(s: S): string {
  const t = Array.isArray(s.type) ? s.type.join(" | ") : s.type;
  if (t === "array" || (!t && s.items)) {
    const items = s.items && typeof s.items === "object" ? s.items : undefined;
    return `array<${items ? typeLabel(items) : "any"}>`;
  }
  if (t) return t;
  if (s.oneOf || s.anyOf) return "one of";
  if (s.properties) return "object";
  if (s.enum) return typeof s.enum[0];
  if ("const" in s) return typeof s.const;
  return "any";
}

/** Rows for a field table. The root object itself is not a row; its properties are. */
export function schemaRows(schema: unknown): SchemaRow[] {
  const root = (typeof schema === "string" ? safeParse(schema) : schema) as S | undefined;
  if (!root || typeof root !== "object") return [];
  const out: SchemaRow[] = [];
  const walk = (raw: S | undefined, path: string, name: string, depth: number, required: boolean, seen: Set<string>, variant?: string) => {
    const s = deref(raw, root, seen);
    if (!s || depth > MAX_DEPTH) return;
    const nextSeen = typeof raw?.$ref === "string" ? new Set([...seen, raw.$ref]) : seen;
    if (path) {
      out.push({
        path, name, depth, type: typeLabel(s), required,
        ...(s.description ? { description: String(s.description) } : {}),
        ...(s.format ? { format: String(s.format) } : {}),
        ...(Array.isArray(s.enum) ? { enum: s.enum } : "const" in s ? { enum: [s.const] } : {}),
        ...(s.deprecated ? { deprecated: true } : {}),
        ...(variant ? { variant } : {}),
      });
    }
    const childDepth = path ? depth + 1 : depth;
    if (s.properties && typeof s.properties === "object") {
      const req = new Set<string>(Array.isArray(s.required) ? s.required : []);
      for (const [k, v] of Object.entries(s.properties)) walk(v as S, path ? `${path}.${k}` : k, k, childDepth, req.has(k), nextSeen);
    }
    const items = s.items && typeof s.items === "object" && !Array.isArray(s.items) ? (s.items as S) : undefined;
    if (items) {
      const it = deref(items, root, nextSeen);
      if (it?.properties || it?.allOf || it?.oneOf || it?.anyOf) walk(items, `${path}[]`, `${name || "items"}[]`, path ? depth + 1 : depth, true, nextSeen);
    }
    const alts = (s.oneOf ?? s.anyOf) as S[] | undefined;
    if (Array.isArray(alts)) {
      alts.forEach((alt, i) => {
        const a = deref(alt, root, nextSeen);
        const label = a?.title ?? (typeof alt?.$ref === "string" ? alt.$ref.split("/").pop() : `Option ${i + 1}`);
        const before = out.length;
        walk(alt, path, name, depth, required, nextSeen);
        // The alternative's own row (if any) duplicates `path`; mark the first new row instead.
        if (path && out[before]?.path === path) out.splice(before, 1);
        if (out[before]) out[before].variant = label;
        else if (a) out.push({ path: path || label, name: label, depth: childDepth, type: typeLabel(a), required: false, variant: label });
      });
    }
  };
  walk(root, "", "", 0, false, new Set());
  return out;
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return undefined; }
}

const FORMATS: [RegExp, string][] = [
  [/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/, "date-time"],
  [/^\d{4}-\d{2}-\d{2}$/, "date"],
  [/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "uuid"],
  [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "email"],
  [/^https?:\/\/\S+$/, "uri"],
];

/**
 * A JSON Schema describing `value`. Object properties present in every sample are required;
 * array items are merged across elements so optional fields and mixed types show up.
 */
export function inferSchema(value: unknown): S {
  return infer([value]);
}

function infer(samples: unknown[]): S {
  const kinds = new Set(samples.map(kindOf));
  if (kinds.has("integer") && kinds.has("number")) kinds.delete("integer");
  if (kinds.size > 1) {
    const nonNull = samples.filter((v) => v !== null);
    if (kinds.size === 2 && kinds.has("null")) {
      const inner = infer(nonNull);
      return { ...inner, type: withNull(inner.type) };
    }
    return { anyOf: [...kinds].map((k) => infer(samples.filter((v) => kindOf(v) === k || (k === "number" && kindOf(v) === "integer")))) };
  }
  const kind = [...kinds][0] ?? "null";
  if (kind === "object") {
    const objs = samples as Record<string, unknown>[];
    const keys: string[] = [];
    for (const o of objs) for (const k of Object.keys(o)) if (!keys.includes(k)) keys.push(k);
    const properties: S = {};
    for (const k of keys) properties[k] = infer(objs.filter((o) => k in o).map((o) => o[k]));
    const required = keys.filter((k) => objs.every((o) => k in o));
    return { type: "object", properties, ...(required.length ? { required } : {}) };
  }
  if (kind === "array") {
    const all = (samples as unknown[][]).flat();
    return { type: "array", items: all.length ? infer(all) : {} };
  }
  if (kind === "string") {
    const strs = samples as string[];
    const fmt = FORMATS.find(([re]) => strs.every((s) => re.test(s)))?.[1];
    return { type: "string", ...(fmt ? { format: fmt } : {}) };
  }
  return { type: kind };
}

const withNull = (t: unknown) => (Array.isArray(t) ? [...t, "null"] : [t, "null"]);

function kindOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v === "object" ? "object" : typeof v;
}

/** Schema from a JSON text, pretty-printed (for the "Generate" buttons). */
export function inferSchemaText(json: string): string {
  return JSON.stringify(inferSchema(JSON.parse(json)), null, 2);
}
