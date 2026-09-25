// JSON Schema validation (draft-07 / 2019-09 / 2020-12 keywords that Ajv supports), used by
// pm.response.to.have.jsonSchema(), chai's .jsonSchema(), tv4.validate() and a request's
// "Response schema" setting.
import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: true });
addFormats(ajv);

const cache = new Map<string, ValidateFunction>();

function compile(schema: unknown): ValidateFunction {
  const key = JSON.stringify(schema);
  let fn = cache.get(key);
  if (!fn) {
    const s = schema && typeof schema === "object" ? { ...(schema as object) } : schema;
    // Ajv's default meta-schema rejects some $schema URLs; validation doesn't need them.
    if (s && typeof s === "object") delete (s as Record<string, unknown>).$schema;
    fn = ajv.compile(s as object);
    if (cache.size > 200) cache.clear();
    cache.set(key, fn);
  }
  return fn;
}

const describe = (e: ErrorObject) => `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}${e.params && "allowedValues" in e.params ? ` (${(e.params.allowedValues as unknown[]).join(", ")})` : ""}`;

export function validateSchema(data: unknown, schema: unknown): { valid: boolean; errors: string[] } {
  const fn = compile(schema);
  const valid = fn(data) as boolean;
  return { valid, errors: valid ? [] : (fn.errors ?? []).map(describe) };
}
