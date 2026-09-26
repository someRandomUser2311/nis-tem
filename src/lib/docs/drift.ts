// Docs drift: does a live response still match what the docs say? Reported as ordinary test
// results ("Docs: …"), so the runner, the CLI and the JUnit/HTML reports show them unchanged.
import type { Example, HttpResponse, RequestItem, TestResult } from "../../types";
import { validateSchema } from "../schema";
import { inferSchema } from "./schema";

type S = Record<string, any>;

/** An inferred schema checks types and structure only: no required keys, formats or nullability guesses. */
function relax(s: S): S {
  if (!s || typeof s !== "object") return s;
  const { required: _r, format: _f, ...rest } = s;
  const out: S = { ...rest };
  if (out.properties) out.properties = Object.fromEntries(Object.entries(out.properties).map(([k, v]) => [k, relax(v as S)]));
  if (out.items) out.items = relax(out.items);
  if (out.anyOf) out.anyOf = out.anyOf.map(relax);
  // A null in the example says little about the real type.
  if (out.type === "null") return {};
  return out;
}

const parse = (s: string | undefined): unknown => { try { return s?.trim() ? JSON.parse(s) : undefined; } catch { return undefined; } };

/** The schema the docs promise for a status, and where it came from. */
export function documentedSchema(req: RequestItem, status: number): { schema: unknown; source: string } | null {
  const examples = req.examples ?? [];
  const same = examples.filter((e) => e.status === status);
  const withSchema = same.find((e) => parse(e.schema) !== undefined);
  if (withSchema) return { schema: parse(withSchema.schema), source: `example “${withSchema.name}”` };
  const success = status >= 200 && status < 300;
  const rs = parse(req.responseSchema);
  if (success && rs !== undefined) return { schema: rs, source: "response schema" };
  const ex: Example | undefined = same.find((e) => e.default) ?? same[0];
  const body = parse(ex?.body);
  if (ex && body !== undefined) return { schema: relax(inferSchema(body)), source: `example “${ex.name}” (inferred)` };
  return null;
}

/** Drift checks for one response. Requests without any docs (no examples, no schema) get none. */
export function docsDrift(req: RequestItem, res: Pick<HttpResponse, "status" | "bodyText" | "headers">): TestResult[] {
  const documented = (req.examples?.length ?? 0) > 0 || !!req.responseSchema?.trim();
  if (!documented) return [];
  const statuses = [...new Set((req.examples ?? []).map((e) => e.status))];
  const out: TestResult[] = [];
  if (statuses.length && !statuses.includes(res.status) && !(req.responseSchema?.trim() && res.status >= 200 && res.status < 300)) {
    out.push({ name: `Docs: status ${res.status} is documented`, passed: false, error: `Documented statuses: ${statuses.sort().join(", ")}` });
    return out;
  }
  const doc = documentedSchema(req, res.status);
  if (!doc) return out;
  const ct = res.headers.find((h) => h.key.toLowerCase() === "content-type")?.value ?? "";
  const body = parse(res.bodyText);
  const name = `Docs: ${res.status} response matches the ${doc.source}`;
  if (body === undefined) {
    if (/json/i.test(ct) || res.bodyText.trim()) out.push({ name, passed: false, error: "The response body isn't JSON" });
    return out;
  }
  try {
    const r = validateSchema(body, doc.schema);
    out.push(r.valid ? { name, passed: true } : { name, passed: false, error: r.errors.slice(0, 5).join("; ") });
  } catch (e) {
    out.push({ name, passed: false, error: `The documented schema is invalid: ${e instanceof Error ? e.message : e}` });
  }
  return out;
}
