// Small crypto helpers for request signing. SHA/HMAC use WebCrypto (available in the webview and
// in Node ≥ 20 for the CLI/tests); MD5 — which WebCrypto lacks but HTTP Digest needs — is inline.

const enc = new TextEncoder();
const subtle = () => globalThis.crypto.subtle;
/** WebCrypto wants ArrayBuffer-backed views. */
const bytes = (x: string | Uint8Array) => (typeof x === "string" ? enc.encode(x) : x) as BufferSource;

export const toHex = (buf: ArrayBuffer | Uint8Array) =>
  Array.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export const base64url = (bytes: Uint8Array) => bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function sha256(data: string | Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest("SHA-256", bytes(data)));
}
export const sha256Hex = async (data: string | Uint8Array) => toHex(await sha256(data));

export async function hmac(alg: "SHA-256" | "SHA-1", key: string | Uint8Array, data: string): Promise<Uint8Array> {
  const k = await subtle().importKey("raw", bytes(key), { name: "HMAC", hash: alg }, false, ["sign"]);
  return new Uint8Array(await subtle().sign("HMAC", k, bytes(data)));
}

export function randomString(len = 32, alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

// ---------------------------------------------------------------- MD5 (RFC 1321)

export function md5(input: string | Uint8Array): string {
  const data = typeof input === "string" ? enc.encode(input) : input;
  const words = new Uint32Array((((data.length + 8) >>> 6) + 1) * 16);
  for (let i = 0; i < data.length; i++) words[i >> 2] |= data[i] << ((i % 4) * 8);
  words[data.length >> 2] |= 0x80 << ((data.length % 4) * 8);
  const bitLen = data.length * 8;
  words[words.length - 2] = bitLen >>> 0;
  words[words.length - 1] = Math.floor(bitLen / 0x100000000);

  const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let off = 0; off < words.length; off += 16) {
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number, g: number;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const tmp = d;
      d = c;
      c = b;
      const sum = (a + f + K[i] + words[off + g]) >>> 0;
      const s = S[(i >> 4) * 4 + (i % 4)];
      b = (b + ((sum << s) | (sum >>> (32 - s)))) >>> 0;
      a = tmp;
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
  }
  const out = new Uint8Array(16);
  [a0, b0, c0, d0].forEach((v, i) => { for (let j = 0; j < 4; j++) out[i * 4 + j] = (v >>> (j * 8)) & 0xff; });
  return toHex(out);
}
