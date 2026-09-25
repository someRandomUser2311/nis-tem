// Dev toolbox: pure transforms behind the Tools tabs (JWT, encoders, hashes, ids, time, format
// conversion, JSON diff, regex, cron). Everything runs locally; WebCrypto works in the webview and
// in Node ≥ 20, so all of this is unit-tested headlessly.
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { bytesToBase64, md5, toHex } from "./crypto";
import { parseCsv } from "./runner";
import { tableToCsv, toTable } from "./search";

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });
const bytes = (x: string | Uint8Array) => (typeof x === "string" ? enc.encode(x) : x) as BufferSource;
const subtle = () => globalThis.crypto.subtle;

// ---------------------------------------------------------------- encoding

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.trim().replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new Error("Not valid Base64");
  const bin = atob(clean.padEnd(Math.ceil(clean.length / 4) * 4, "="));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export type Codec = "base64" | "base64url" | "url" | "urlFull" | "html" | "hex" | "unicode";

export const CODECS: { id: Codec; label: string }[] = [
  { id: "base64", label: "Base64" },
  { id: "base64url", label: "Base64URL" },
  { id: "url", label: "URL component" },
  { id: "urlFull", label: "Full URL" },
  { id: "html", label: "HTML entities" },
  { id: "hex", label: "Hex" },
  { id: "unicode", label: "Unicode escapes" },
];

const HTML_NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®", trade: "™", hellip: "…", mdash: "—", ndash: "–", euro: "€" };

export function encode(codec: Codec, text: string): string {
  switch (codec) {
    case "base64": return bytesToBase64(enc.encode(text));
    case "base64url": return bytesToBase64(enc.encode(text)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    case "url": return encodeURIComponent(text);
    case "urlFull": return encodeURI(text);
    case "html": return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
    case "hex": return toHex(enc.encode(text));
    case "unicode": return Array.from(text, (ch) => {
      const cp = ch.codePointAt(0)!;
      if (cp >= 0x20 && cp < 0x7f) return ch;
      return cp > 0xffff ? `\\u{${cp.toString(16)}}` : `\\u${cp.toString(16).padStart(4, "0")}`;
    }).join("");
  }
}

export function decode(codec: Codec, text: string): string {
  switch (codec) {
    case "base64":
    case "base64url": {
      const b = base64ToBytes(text);
      try { return dec.decode(b); } catch { throw new Error("Decoded bytes aren't UTF-8 text"); }
    }
    case "url": return decodeURIComponent(text.replace(/\+/g, " "));
    case "urlFull": return decodeURI(text);
    case "html": return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
      return HTML_NAMED[e.toLowerCase()] ?? m;
    });
    case "hex": {
      const clean = text.replace(/^0x/i, "").replace(/[\s:-]/g, "");
      if (!/^([0-9a-f]{2})*$/i.test(clean)) throw new Error("Not valid hex (needs pairs of 0-9a-f)");
      const b = Uint8Array.from(clean.match(/../g) ?? [], (h) => parseInt(h, 16));
      try { return dec.decode(b); } catch { throw new Error("Decoded bytes aren't UTF-8 text"); }
    }
    case "unicode": return text
      .replace(/\\u\{([0-9a-f]+)\}/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }
}

// ---------------------------------------------------------------- hashes

export type HashAlg = "MD5" | "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512";
export const HASH_ALGS: HashAlg[] = ["MD5", "SHA-1", "SHA-256", "SHA-384", "SHA-512"];

export async function digest(alg: HashAlg, text: string): Promise<Uint8Array> {
  if (alg === "MD5") return Uint8Array.from(md5(text).match(/../g)!, (h) => parseInt(h, 16));
  return new Uint8Array(await subtle().digest(alg, bytes(text)));
}

/** HMAC for any of the algorithms (HMAC-MD5 per RFC 2104, the rest via WebCrypto). */
export async function hmacDigest(alg: HashAlg, key: string, text: string): Promise<Uint8Array> {
  if (alg !== "MD5") {
    const k = await subtle().importKey("raw", bytes(key), { name: "HMAC", hash: alg }, false, ["sign"]);
    return new Uint8Array(await subtle().sign("HMAC", k, bytes(text)));
  }
  const md5b = (b: Uint8Array) => Uint8Array.from(md5(b).match(/../g)!, (h) => parseInt(h, 16));
  let k = enc.encode(key);
  if (k.length > 64) k = md5b(k);
  const pad = (v: number) => Uint8Array.from({ length: 64 }, (_, i) => (k[i] ?? 0) ^ v);
  const inner = md5b(concat(pad(0x36), enc.encode(text)));
  return md5b(concat(pad(0x5c), inner));
}

const concat = (a: Uint8Array, b: Uint8Array) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };

// ---------------------------------------------------------------- JWT

export interface DecodedJwt {
  header: Record<string, unknown>;
  payload: unknown;
  signature: string;
  signingInput: string;
  /** iat / nbf / exp as dates, when present. */
  times: { claim: "iat" | "nbf" | "exp"; date: Date }[];
  expired: boolean;
  notYetValid: boolean;
}

const b64urlJson = (part: string, what: string) => {
  try { return JSON.parse(dec.decode(base64ToBytes(part))); } catch { throw new Error(`The ${what} isn't Base64URL-encoded JSON`); }
};

export function decodeJwtFull(token: string, now = Date.now()): DecodedJwt {
  const t = token.trim().replace(/^Bearer\s+/i, "");
  const parts = t.split(".");
  if (parts.length !== 3) throw new Error(`A JWT has 3 parts separated by dots (found ${parts.length})`);
  const header = b64urlJson(parts[0], "header");
  let payload: unknown;
  try { payload = b64urlJson(parts[1], "payload"); } catch { payload = decode("base64url", parts[1]); }
  const times: DecodedJwt["times"] = [];
  const p = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  for (const claim of ["iat", "nbf", "exp"] as const) if (typeof p[claim] === "number") times.push({ claim, date: new Date((p[claim] as number) * 1000) });
  return {
    header, payload, signature: parts[2], signingInput: `${parts[0]}.${parts[1]}`, times,
    expired: typeof p.exp === "number" && p.exp * 1000 < now,
    notYetValid: typeof p.nbf === "number" && p.nbf * 1000 > now,
  };
}

const JWT_HASH: Record<string, string> = { "256": "SHA-256", "384": "SHA-384", "512": "SHA-512" };

function pemToDer(pem: string): { der: Uint8Array; label: string } {
  const m = pem.match(/-----BEGIN ([A-Z ]+)-----([\s\S]+?)-----END \1-----/);
  if (!m) throw new Error("Expected a PEM public key (-----BEGIN PUBLIC KEY-----)");
  return { label: m[1], der: base64ToBytes(m[2]) };
}

async function importVerifyKey(alg: string, key: string): Promise<CryptoKey> {
  const hash = JWT_HASH[alg.slice(2)];
  const family = alg.slice(0, 2);
  const params: RsaHashedImportParams | EcKeyImportParams =
    family === "RS" ? { name: "RSASSA-PKCS1-v1_5", hash }
    : family === "PS" ? { name: "RSA-PSS", hash }
    : { name: "ECDSA", namedCurve: ({ "256": "P-256", "384": "P-384", "512": "P-521" } as Record<string, string>)[alg.slice(2)] };
  const k = key.trim();
  if (k.startsWith("{")) {
    const jwk = JSON.parse(k);
    const use = Array.isArray(jwk.keys) ? jwk.keys[0] : jwk;
    return subtle().importKey("jwk", use, params, false, ["verify"]);
  }
  const { der, label } = pemToDer(k);
  if (label !== "PUBLIC KEY") throw new Error(`Use the public key in SPKI form (-----BEGIN PUBLIC KEY-----), not ${label}`);
  return subtle().importKey("spki", der as BufferSource, params, false, ["verify"]);
}

/**
 * Verify a JWT signature. HS* takes the shared secret (text, or Base64 with `secretIsBase64`);
 * RS*, PS* and ES* take a PEM public key or a JWK (a JWKS uses its first key).
 */
export async function verifyJwt(token: string, key: string, opts: { secretIsBase64?: boolean } = {}): Promise<{ valid: boolean; alg: string }> {
  const d = decodeJwtFull(token);
  const alg = String(d.header.alg ?? "");
  if (alg === "none") throw new Error('alg "none" — the token is unsigned');
  if (!/^(HS|RS|PS|ES)(256|384|512)$/.test(alg)) throw new Error(`Unsupported algorithm ${alg || "(missing)"}`);
  const sig = base64ToBytes(d.signature) as BufferSource;
  const data = bytes(d.signingInput);
  if (alg.startsWith("HS")) {
    const secret = opts.secretIsBase64 ? base64ToBytes(key) : enc.encode(key);
    const k = await subtle().importKey("raw", secret as BufferSource, { name: "HMAC", hash: JWT_HASH[alg.slice(2)] }, false, ["verify"]);
    return { valid: await subtle().verify("HMAC", k, sig, data), alg };
  }
  const k = await importVerifyKey(alg, key);
  const hash = JWT_HASH[alg.slice(2)];
  const params = alg.startsWith("PS") ? { name: "RSA-PSS", saltLength: Number(alg.slice(2)) / 8 }
    : alg.startsWith("ES") ? { name: "ECDSA", hash }
    : { name: "RSASSA-PKCS1-v1_5" };
  return { valid: await subtle().verify(params, k, sig, data), alg };
}

/** Create an HS-signed JWT (handy for testing APIs locally). */
export async function signJwtHs(payload: unknown, secret: string, alg: "HS256" | "HS384" | "HS512" = "HS256"): Promise<string> {
  const b64u = (s: string) => encode("base64url", s);
  const input = `${b64u(JSON.stringify({ alg, typ: "JWT" }))}.${b64u(JSON.stringify(payload))}`;
  const k = await subtle().importKey("raw", bytes(secret), { name: "HMAC", hash: JWT_HASH[alg.slice(2)] }, false, ["sign"]);
  const sig = new Uint8Array(await subtle().sign("HMAC", k, bytes(input)));
  return `${input}.${bytesToBase64(sig).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

// ---------------------------------------------------------------- ids

const rand = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const uuidFormat = (b: Uint8Array) => {
  const h = toHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

export function uuidv4(): string {
  const b = rand(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  return uuidFormat(b);
}

/** RFC 9562 UUIDv7: 48-bit Unix-ms timestamp, then random bits — sortable by creation time. */
export function uuidv7(now = Date.now()): string {
  const b = rand(16);
  let t = now;
  for (let i = 5; i >= 0; i--) { b[i] = t % 256; t = Math.floor(t / 256); }
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  return uuidFormat(b);
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** ULID: 10 chars of Crockford base32 time (ms) + 16 chars of randomness. */
export function ulid(now = Date.now()): string {
  let t = now, time = "";
  for (let i = 0; i < 10; i++) { time = CROCKFORD[t % 32] + time; t = Math.floor(t / 32); }
  const r = rand(16);
  return time + Array.from({ length: 16 }, (_, i) => CROCKFORD[r[i] % 32]).join("");
}

/** What an id is, and when it was made (for UUIDv1/v6/v7 and ULID). */
export function inspectId(id: string): { kind: string; date?: Date } | null {
  const s = id.trim();
  const u = s.match(/^[0-9a-f]{8}-?[0-9a-f]{4}-?([0-9a-f])[0-9a-f]{3}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i);
  if (u) {
    const hex = s.replace(/-/g, "");
    const v = Number.parseInt(u[1], 16);
    if (/^0+$/.test(hex)) return { kind: "Nil UUID" };
    if (v === 7) return { kind: "UUID v7", date: new Date(Number.parseInt(hex.slice(0, 12), 16)) };
    if (v === 1 || v === 6) {
      const ts = v === 1 ? hex.slice(13, 16) + hex.slice(8, 12) + hex.slice(0, 8) : hex.slice(0, 12) + hex.slice(13, 16);
      // 100-ns intervals since 1582-10-15
      return { kind: `UUID v${v}`, date: new Date(Number((BigInt("0x" + ts) - 122192928000000000n) / 10000n)) };
    }
    return { kind: `UUID v${v}` };
  }
  if (/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(s)) {
    const t = s.slice(0, 10).toUpperCase().split("").reduce((n, c) => n * 32 + CROCKFORD.indexOf(c), 0);
    return { kind: "ULID", date: new Date(t) };
  }
  return null;
}

// ---------------------------------------------------------------- time

/**
 * Parse a timestamp: "now", Unix seconds / milliseconds / microseconds / nanoseconds (picked by
 * magnitude), or any date string the JS Date parser accepts (ISO 8601, RFC 2822 …).
 */
export function parseTime(input: string, now = Date.now()): { date: Date; unit?: "s" | "ms" | "µs" | "ns" } {
  const s = input.trim();
  if (!s || s.toLowerCase() === "now") return { date: new Date(now) };
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    const abs = Math.abs(n);
    const [div, unit] = abs < 1e11 ? [1e-3, "s"] as const : abs < 1e14 ? [1, "ms"] as const : abs < 1e17 ? [1e3, "µs"] as const : [1e6, "ns"] as const;
    return { date: new Date(n / div), unit };
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error("Not a timestamp or a date I can read");
  return { date: d };
}

export function relativeTime(d: Date, now = Date.now()): string {
  const diff = d.getTime() - now;
  const abs = Math.abs(diff);
  const units: [number, string][] = [[31536e6, "year"], [2592e6, "month"], [864e5, "day"], [36e5, "hour"], [6e4, "minute"], [1e3, "second"]];
  for (const [ms, name] of units) {
    if (abs >= ms) {
      const n = Math.floor(abs / ms);
      return diff < 0 ? `${n} ${name}${n > 1 ? "s" : ""} ago` : `in ${n} ${name}${n > 1 ? "s" : ""}`;
    }
  }
  return "just now";
}

export function timeFormats(d: Date, now = Date.now()): { label: string; value: string }[] {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const off = -d.getTimezoneOffset();
  const local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}${off >= 0 ? "+" : "-"}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
  return [
    { label: "Unix (seconds)", value: String(Math.floor(d.getTime() / 1000)) },
    { label: "Unix (milliseconds)", value: String(d.getTime()) },
    { label: "ISO 8601 (UTC)", value: d.toISOString() },
    { label: "ISO 8601 (local)", value: local },
    { label: "RFC 7231 (HTTP date)", value: d.toUTCString() },
    { label: "Local", value: d.toLocaleString(undefined, { dateStyle: "full", timeStyle: "long" }) },
    { label: "Relative", value: relativeTime(d, now) },
  ];
}

// ---------------------------------------------------------------- JSON ⇄ YAML ⇄ CSV

export type DataFormat = "json" | "yaml" | "csv";

export function parseData(text: string, from: DataFormat): unknown {
  if (from === "json") return JSON.parse(text);
  if (from === "yaml") return parseYaml(text);
  return parseCsv(text);
}

export function formatData(value: unknown, to: DataFormat, indent = 2): string {
  if (to === "json") return JSON.stringify(value, null, indent);
  if (to === "yaml") return stringifyYaml(value, { indent });
  const t = toTable(value);
  if (!t) throw new Error("CSV needs an array (of objects or values)");
  return tableToCsv(t);
}

export const convertData = (text: string, from: DataFormat, to: DataFormat) => formatData(parseData(text, from), to);

// ---------------------------------------------------------------- JSON diff

export interface JsonChange {
  path: string;
  kind: "added" | "removed" | "changed";
  before?: unknown;
  after?: unknown;
}

const pathKey = (base: string, k: string | number) =>
  typeof k === "number" ? `${base}[${k}]` : /^[A-Za-z_$][\w$]*$/.test(k) ? `${base}.${k}` : `${base}[${JSON.stringify(k)}]`;

/** Structural differences between two JSON values, as JSONPath-like paths. */
export function diffJson(a: unknown, b: unknown, path = "$"): JsonChange[] {
  if (Object.is(a, b)) return [];
  const isObj = (v: unknown) => v !== null && typeof v === "object";
  if (Array.isArray(a) && Array.isArray(b)) {
    const out: JsonChange[] = [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (i >= a.length) out.push({ path: pathKey(path, i), kind: "added", after: b[i] });
      else if (i >= b.length) out.push({ path: pathKey(path, i), kind: "removed", before: a[i] });
      else out.push(...diffJson(a[i], b[i], pathKey(path, i)));
    }
    return out;
  }
  if (isObj(a) && isObj(b) && !Array.isArray(a) && !Array.isArray(b)) {
    const ao = a as Record<string, unknown>, bo = b as Record<string, unknown>;
    const out: JsonChange[] = [];
    for (const k of Object.keys(ao)) {
      if (!(k in bo)) out.push({ path: pathKey(path, k), kind: "removed", before: ao[k] });
      else out.push(...diffJson(ao[k], bo[k], pathKey(path, k)));
    }
    for (const k of Object.keys(bo)) if (!(k in ao)) out.push({ path: pathKey(path, k), kind: "added", after: bo[k] });
    return out;
  }
  return [{ path, kind: "changed", before: a, after: b }];
}

// ---------------------------------------------------------------- regex

export interface RegexMatch {
  index: number;
  end: number;
  text: string;
  groups: (string | undefined)[];
  named?: Record<string, string | undefined>;
}

export function runRegex(pattern: string, flags: string, text: string, limit = 1000): RegexMatch[] {
  const f = flags.includes("g") ? flags : flags + "g";
  const re = new RegExp(pattern, f);
  const out: RegexMatch[] = [];
  for (const m of text.matchAll(re)) {
    out.push({ index: m.index!, end: m.index! + m[0].length, text: m[0], groups: m.slice(1), named: m.groups ? { ...m.groups } : undefined });
    if (out.length >= limit) break;
  }
  return out;
}

/** Split text into plain and matched segments, for highlighting. */
export function regexSegments(text: string, matches: RegexMatch[]): { text: string; match?: number }[] {
  const out: { text: string; match?: number }[] = [];
  let pos = 0;
  matches.forEach((m, i) => {
    if (m.index > pos) out.push({ text: text.slice(pos, m.index) });
    if (m.end > m.index) out.push({ text: text.slice(m.index, m.end), match: i });
    pos = Math.max(pos, m.end);
  });
  if (pos < text.length) out.push({ text: text.slice(pos) });
  return out;
}

// ---------------------------------------------------------------- cron

interface CronField { name: string; min: number; max: number; names?: string[] }
const FIELDS: CronField[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"] },
  { name: "day of week", min: 0, max: 6, names: ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] },
];
const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *", "@annually": "0 0 1 1 *", "@monthly": "0 0 1 * *", "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *", "@midnight": "0 0 * * *", "@hourly": "0 * * * *",
};
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export interface Cron {
  fields: number[][];
  /** Whether day-of-month / day-of-week were restricted (standard cron ORs them when both are). */
  domStar: boolean;
  dowStar: boolean;
  source: string[];
}

function parseField(src: string, f: CronField): number[] {
  const val = (s: string) => {
    const up = s.toUpperCase();
    const named = f.names?.indexOf(up.slice(0, 3)) ?? -1;
    const n = named >= 0 && /^[A-Z]{3}$/.test(up) ? named + f.min : /^\d+$/.test(s) ? Number(s) : NaN;
    const v = f.name === "day of week" && n === 7 ? 0 : n;
    if (!Number.isInteger(v) || v < f.min || v > f.max) throw new Error(`"${s}" isn't a valid ${f.name} (${f.min}–${f.max})`);
    return v;
  };
  const set = new Set<number>();
  for (const part of src.split(",")) {
    const [range, stepS] = part.split("/");
    const step = stepS === undefined ? 1 : Number(stepS);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Bad step "${stepS}" in ${f.name}`);
    let lo: number, hi: number;
    if (range === "*" || range === "?") { lo = f.min; hi = f.max; }
    else if (range.includes("-")) {
      const [a, b] = range.split("-");
      lo = val(a); hi = val(b);
      if (f.name === "day of week" && b === "7") hi = 6 + 1; // SUN as 7 at the end of a range
    } else { lo = val(range); hi = stepS === undefined ? lo : f.max; }
    if (lo > hi) throw new Error(`Range ${range} in ${f.name} goes backwards`);
    for (let v = lo; v <= hi; v += step) set.add(f.name === "day of week" ? v % 7 : v);
  }
  return [...set].sort((a, b) => a - b);
}

export function parseCron(expr: string): Cron {
  const e = MACROS[expr.trim().toLowerCase()] ?? expr.trim();
  const parts = e.split(/\s+/);
  if (parts.length !== 5) throw new Error(`Expected 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}`);
  return {
    fields: parts.map((p, i) => parseField(p, FIELDS[i])),
    domStar: parts[2] === "*" || parts[2] === "?",
    dowStar: parts[4] === "*" || parts[4] === "?",
    source: parts,
  };
}

function cronDayMatches(c: Cron, d: Date): boolean {
  const dom = c.fields[2].includes(d.getDate());
  const dow = c.fields[4].includes(d.getDay());
  if (c.domStar && c.dowStar) return true;
  if (c.domStar) return dow;
  if (c.dowStar) return dom;
  return dom || dow;
}

/** The next `count` times (local time) the expression fires, strictly after `from`. */
export function nextRuns(expr: string | Cron, count = 5, from = new Date()): Date[] {
  const c = typeof expr === "string" ? parseCron(expr) : expr;
  const [mins, hours, , months] = c.fields;
  const out: Date[] = [];
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = new Date(from.getTime() + 5 * 366 * 864e5);
  while (out.length < count && d < limit) {
    if (!months.includes(d.getMonth() + 1)) { d.setMonth(d.getMonth() + 1, 1); d.setHours(0, 0, 0, 0); continue; }
    if (!cronDayMatches(c, d)) { d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); continue; }
    if (!hours.includes(d.getHours())) { d.setHours(d.getHours() + 1, 0, 0, 0); continue; }
    if (!mins.includes(d.getMinutes())) { d.setMinutes(d.getMinutes() + 1, 0, 0); continue; }
    out.push(new Date(d.getTime()));
    d.setMinutes(d.getMinutes() + 1, 0, 0);
  }
  return out;
}

const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
const listText = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** A plain-English description, e.g. "At 09:30, Monday through Friday". */
export function describeCron(expr: string): string {
  const c = parseCron(expr);
  const [mS, hS, domS, monS, dowS] = c.source;
  const [mins, hours, doms, months, dows] = c.fields;
  const pad = (n: number) => String(n).padStart(2, "0");
  const stepOf = (s: string) => s.match(/^(\*|\d+)\/(\d+)$/);
  let time: string;
  if (mS === "*" && hS === "*") time = "Every minute";
  else if (stepOf(mS) && hS === "*") time = `Every ${stepOf(mS)![2]} minutes`;
  else if (hS === "*") time = `At minute ${listText(mins.map(String))} past every hour`;
  else if (mS === "*") time = `Every minute during hour ${listText(hours.map(String))}`;
  else if (mins.length * hours.length <= 6) time = `At ${listText(hours.flatMap((h) => mins.map((m) => `${pad(h)}:${pad(m)}`)))}`;
  else time = `At minute ${listText(mins.map(String))} past hour ${listText(hours.map(String))}`;
  if (stepOf(hS) && mins.length === 1) time = `At minute ${mins[0]} past every ${stepOf(hS)![2]} hours`;
  const parts = [time];
  const range = (xs: number[], names: string[], offset: number) => {
    if (xs.length > 2 && xs.every((v, i) => i === 0 || v === xs[i - 1] + 1)) return `${names[xs[0] - offset]} through ${names[xs[xs.length - 1] - offset]}`;
    return listText(xs.map((v) => names[v - offset]));
  };
  const domText = domS !== "*" && domS !== "?" ? `on the ${listText(doms.map(ordinal))} of the month` : "";
  const dowText = dowS !== "*" && dowS !== "?" ? range(dows, DAYS, 0) : "";
  if (domText && dowText) parts.push(`${domText} or on ${dowText}`);
  else if (domText) parts.push(domText);
  else if (dowText) parts.push(dowText);
  if (monS !== "*") parts.push(`in ${range(months, MONTHS, 1)}`);
  return parts.join(", ");
}
