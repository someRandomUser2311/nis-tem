// Request-signing auth schemes: HTTP Digest (RFC 7616), AWS Signature V4 and Hawk.
import type { HeaderEntry } from "./scripting";
import { bytesToBase64, hmac, md5, randomString, sha256, sha256Hex, toHex } from "./crypto";

// ---------------------------------------------------------------- Digest

export interface DigestChallenge {
  realm: string;
  nonce: string;
  qop?: string;
  opaque?: string;
  algorithm: string;
}

/** Parse `WWW-Authenticate: Digest realm="…", nonce="…", …` (null if it isn't a Digest challenge). */
export function parseDigestChallenge(header: string): DigestChallenge | null {
  const m = header.match(/^\s*Digest\s+(.*)$/is);
  if (!m) return null;
  const params: Record<string, string> = {};
  for (const p of m[1].matchAll(/([a-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]*))/gi)) {
    params[p[1].toLowerCase()] = (p[2] ?? p[3] ?? "").replace(/\\(.)/g, "$1");
  }
  if (!params.nonce) return null;
  return { realm: params.realm ?? "", nonce: params.nonce, qop: params.qop, opaque: params.opaque, algorithm: params.algorithm ?? "MD5" };
}

export async function digestAuthorization(
  ch: DigestChallenge, creds: { username: string; password: string }, method: string, uri: string,
  opts: { cnonce?: string; nc?: number; body?: string } = {},
): Promise<string> {
  const alg = ch.algorithm.toUpperCase();
  const sha = alg.startsWith("SHA-256");
  const H = (s: string) => (sha ? sha256Hex(s) : Promise.resolve(md5(s)));
  const cnonce = opts.cnonce ?? randomString(16, "0123456789abcdef");
  const nc = (opts.nc ?? 1).toString(16).padStart(8, "0");
  const qops = (ch.qop ?? "").split(",").map((q) => q.trim()).filter(Boolean);
  const qop = qops.includes("auth") ? "auth" : qops.includes("auth-int") ? "auth-int" : undefined;

  let ha1 = await H(`${creds.username}:${ch.realm}:${creds.password}`);
  if (alg.endsWith("-SESS")) ha1 = await H(`${ha1}:${ch.nonce}:${cnonce}`);
  const ha2 = await H(qop === "auth-int" ? `${method}:${uri}:${await H(opts.body ?? "")}` : `${method}:${uri}`);
  const response = await H(qop ? `${ha1}:${ch.nonce}:${nc}:${cnonce}:${qop}:${ha2}` : `${ha1}:${ch.nonce}:${ha2}`);

  const q = (s: string) => `"${s.replace(/(["\\])/g, "\\$1")}"`;
  const parts = [
    `username=${q(creds.username)}`, `realm=${q(ch.realm)}`, `nonce=${q(ch.nonce)}`, `uri=${q(uri)}`,
    `algorithm=${ch.algorithm}`, `response=${q(response)}`,
  ];
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce=${q(cnonce)}`);
  if (ch.opaque !== undefined) parts.push(`opaque=${q(ch.opaque)}`);
  return `Digest ${parts.join(", ")}`;
}

/** The request-target Digest signs: path + query. */
export function digestUri(url: string): string {
  try { const u = new URL(url); return u.pathname + u.search; } catch { return url; }
}

// ---------------------------------------------------------------- AWS Signature V4

export interface AwsConfig {
  accessKey: string;
  secretKey: string;
  sessionToken?: string;
  region: string;
  service: string;
}

/** RFC 3986 encoding as AWS wants it (unreserved: A-Z a-z 0-9 - _ . ~). */
const awsEncode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const safeDecode = (s: string) => { try { return decodeURIComponent(s.replace(/\+/g, " ")); } catch { return s; } };

/** Returns the headers to add (Authorization, X-Amz-Date, …). */
export async function awsV4Headers(
  method: string, url: string, headers: HeaderEntry[], body: string | undefined, cfg: AwsConfig, now = new Date(),
): Promise<HeaderEntry[]> {
  const u = new URL(url);
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = body === undefined ? "UNSIGNED-PAYLOAD" : await sha256Hex(body);
  const add: HeaderEntry[] = [{ key: "X-Amz-Date", value: amzDate }];
  if (cfg.sessionToken) add.push({ key: "X-Amz-Security-Token", value: cfg.sessionToken });
  if (cfg.service === "s3") add.push({ key: "X-Amz-Content-Sha256", value: payloadHash });

  const all = [...headers.filter((h) => !/^(authorization|x-amz-date|x-amz-security-token|x-amz-content-sha256)$/i.test(h.key)), ...add];
  const signMap = new Map<string, string[]>();
  signMap.set("host", [u.host]);
  for (const h of all) {
    const k = h.key.toLowerCase();
    if (k === "host" || !(k.startsWith("x-amz-") || k === "content-type")) continue;
    signMap.set(k, [...(signMap.get(k) ?? []), h.value.trim().replace(/\s+/g, " ")]);
  }
  const names = [...signMap.keys()].sort();
  const canonicalHeaders = names.map((n) => `${n}:${signMap.get(n)!.join(",")}\n`).join("");
  const signedHeaders = names.join(";");

  const path = u.pathname.split("/").map((seg) => awsEncode(safeDecode(seg))).join("/") || "/";
  const query = [...u.searchParams.entries()]
    .map(([k, v]) => [awsEncode(k), awsEncode(v)])
    .sort(([a, b], [c, d]) => (a < c ? -1 : a > c ? 1 : b < d ? -1 : b > d ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`).join("&");

  const canonicalRequest = [method.toUpperCase(), path, query, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${dateStamp}/${cfg.region}/${cfg.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");
  const kDate = await hmac("SHA-256", `AWS4${cfg.secretKey}`, dateStamp);
  const kRegion = await hmac("SHA-256", kDate, cfg.region);
  const kService = await hmac("SHA-256", kRegion, cfg.service);
  const kSigning = await hmac("SHA-256", kService, "aws4_request");
  const signature = toHex(await hmac("SHA-256", kSigning, stringToSign));
  add.push({ key: "Authorization", value: `AWS4-HMAC-SHA256 Credential=${cfg.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` });
  return add;
}

// ---------------------------------------------------------------- Hawk

export interface HawkConfig {
  id: string;
  key: string;
  algorithm: "sha256" | "sha1";
  ext?: string;
  /** Include a payload hash (the server must then verify it). */
  includePayloadHash?: boolean;
}

export async function hawkHeader(
  method: string, url: string, cfg: HawkConfig,
  opts: { ts?: number; nonce?: string; contentType?: string; body?: string } = {},
): Promise<string> {
  const u = new URL(url);
  const ts = opts.ts ?? Math.floor(Date.now() / 1000);
  const nonce = opts.nonce ?? randomString(6, "abcdefghijklmnopqrstuvwxyz0123456789");
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  const alg = cfg.algorithm === "sha1" ? "SHA-1" : "SHA-256";
  let hash = "";
  if (cfg.includePayloadHash) {
    const payload = `hawk.1.payload\n${(opts.contentType ?? "").split(";")[0].trim().toLowerCase()}\n${opts.body ?? ""}\n`;
    const digest = alg === "SHA-256" ? await sha256(payload) : new Uint8Array(await globalThis.crypto.subtle.digest("SHA-1", new TextEncoder().encode(payload)));
    hash = bytesToBase64(digest);
  }
  const ext = cfg.ext ?? "";
  const normalized = `hawk.1.header\n${ts}\n${nonce}\n${method.toUpperCase()}\n${u.pathname}${u.search}\n${u.hostname.toLowerCase()}\n${port}\n${hash}\n${ext.replace(/\\/g, "\\\\").replace(/\n/g, "\\n")}\n`;
  const mac = bytesToBase64(await hmac(alg, cfg.key, normalized));
  const parts = [`id="${cfg.id}"`, `ts="${ts}"`, `nonce="${nonce}"`];
  if (hash) parts.push(`hash="${hash}"`);
  if (ext) parts.push(`ext="${ext.replace(/"/g, '\\"')}"`);
  parts.push(`mac="${mac}"`);
  return `Hawk ${parts.join(", ")}`;
}
