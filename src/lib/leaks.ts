// Secret-leak guard: find credentials in data about to be exported, and strip them on request.
import type { Auth, Collection, Environment, Item, KV } from "../types";
import { clone } from "./utils";

export interface Finding {
  where: string;
  what: string;
}

/** A value that is only a `{{variable}}` reference isn't a secret itself. */
const literal = (v: string | undefined) => !!v && !/^\s*\{\{[^{}]+\}\}\s*$/.test(v);
const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|x-api-key|api-key|x-auth-token)$|token|secret|password|session/i;

type Field = [string, () => string | undefined, (v: string) => void];

/** Credential fields of an auth object, as [label, get, set]. */
function authFields(a: Auth): Field[] {
  const f: Field[] = [];
  switch (a.type) {
    case "basic": f.push(["Basic password", () => a.basic.password, (v) => { a.basic.password = v; }]); break;
    case "bearer": f.push(["Bearer token", () => a.bearer.token, (v) => { a.bearer.token = v; }]); break;
    case "apikey": f.push(["API key value", () => a.apikey.value, (v) => { a.apikey.value = v; }]); break;
    case "digest": f.push(["Digest password", () => a.digest?.password, (v) => { if (a.digest) a.digest.password = v; }]); break;
    case "awsv4":
      f.push(["AWS secret key", () => a.awsv4?.secretKey, (v) => { if (a.awsv4) a.awsv4.secretKey = v; }]);
      f.push(["AWS session token", () => a.awsv4?.sessionToken, (v) => { if (a.awsv4) a.awsv4.sessionToken = v; }]);
      break;
    case "hawk": f.push(["Hawk key", () => a.hawk?.key, (v) => { if (a.hawk) a.hawk.key = v; }]); break;
    case "oauth2":
      f.push(["OAuth client secret", () => a.oauth2?.clientSecret, (v) => { if (a.oauth2) a.oauth2.clientSecret = v; }]);
      f.push(["OAuth password", () => a.oauth2?.password, (v) => { if (a.oauth2) a.oauth2.password = v; }]);
      f.push(["OAuth access token", () => a.oauth2?.token?.accessToken, () => { if (a.oauth2) a.oauth2.token = undefined; }]);
      break;
  }
  return f;
}

function scanVars(vars: KV[], where: string, out: Finding[], strip: boolean) {
  for (const v of vars) {
    if (v.secret && v.value) {
      out.push({ where, what: `secret variable “${v.key}”` });
      if (strip) v.value = "";
    }
  }
}

function scanAuth(a: Auth, where: string, out: Finding[], strip: boolean) {
  for (const [label, get, put] of authFields(a)) {
    if (literal(get())) {
      out.push({ where, what: label });
      if (strip) put("");
    }
  }
}

function scanItems(items: Item[], trail: string, out: Finding[], strip: boolean) {
  for (const it of items) {
    const where = `${trail} / ${it.name}`;
    scanAuth(it.auth, where, out, strip);
    if (it.type === "folder") { scanItems(it.items, where, out, strip); continue; }
    for (const h of it.headers) {
      if (h.enabled && SENSITIVE_HEADER.test(h.key) && literal(h.value)) {
        out.push({ where, what: `header ${h.key}` });
        if (strip) h.value = "";
      }
    }
    if (it.examples?.length && strip) {
      for (const ex of it.examples) ex.headers = ex.headers.filter((h) => !/^set-cookie$/i.test(h.key));
    }
  }
}

/** Scan (and, with `strip`, clean a copy of) a collection. */
export function scanCollection(c: Collection, strip = false): { findings: Finding[]; cleaned: Collection } {
  const copy = clone(c);
  const out: Finding[] = [];
  scanVars(copy.variables, c.name, out, strip);
  scanAuth(copy.auth, c.name, out, strip);
  scanItems(copy.items, c.name, out, strip);
  return { findings: out, cleaned: copy };
}

export function scanEnvironment(e: Environment, strip = false): { findings: Finding[]; cleaned: Environment } {
  const copy = clone(e);
  const out: Finding[] = [];
  scanVars(copy.variables, e.name, out, strip);
  return { findings: out, cleaned: copy };
}

export function summarize(findings: Finding[], max = 6): string {
  const lines = findings.slice(0, max).map((f) => `• ${f.what} (${f.where})`);
  if (findings.length > max) lines.push(`• …and ${findings.length - max} more`);
  return lines.join("\n");
}
