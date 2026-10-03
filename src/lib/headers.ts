// Common HTTP header names and values, suggested as you type in header tables.
import type { Completion, CompletionContext, CompletionResult, CompletionSource } from "@codemirror/autocomplete";

export interface HeaderInfo { name: string; description: string }

export const REQUEST_HEADERS: HeaderInfo[] = [
  { name: "Accept", description: "Media types the client can handle" },
  { name: "Accept-Charset", description: "Character sets the client accepts" },
  { name: "Accept-Encoding", description: "Compression the client accepts" },
  { name: "Accept-Language", description: "Preferred languages" },
  { name: "Authorization", description: "Credentials for the server" },
  { name: "Cache-Control", description: "Caching directives" },
  { name: "Connection", description: "Keep the connection open or close it" },
  { name: "Content-Disposition", description: "How the body should be handled" },
  { name: "Content-Encoding", description: "Compression applied to the body" },
  { name: "Content-Length", description: "Body size in bytes" },
  { name: "Content-Type", description: "Media type of the body" },
  { name: "Cookie", description: "Cookies for the server" },
  { name: "DNT", description: "Do Not Track preference" },
  { name: "Expect", description: "Expectations, e.g. 100-continue" },
  { name: "Forwarded", description: "Proxy information about the client" },
  { name: "From", description: "Email of the user making the request" },
  { name: "Host", description: "Host and port of the server" },
  { name: "Idempotency-Key", description: "Makes retries of a request safe" },
  { name: "If-Match", description: "Only if the ETag matches" },
  { name: "If-Modified-Since", description: "Only if changed since a date" },
  { name: "If-None-Match", description: "Only if the ETag doesn't match" },
  { name: "If-Range", description: "Range request condition" },
  { name: "If-Unmodified-Since", description: "Only if unchanged since a date" },
  { name: "Max-Forwards", description: "Limit on proxy hops" },
  { name: "Origin", description: "Origin of the request (CORS)" },
  { name: "Pragma", description: "Legacy caching directives" },
  { name: "Prefer", description: "Preferred server behaviour" },
  { name: "Proxy-Authorization", description: "Credentials for a proxy" },
  { name: "Range", description: "Request part of a resource" },
  { name: "Referer", description: "Page that linked to this request" },
  { name: "TE", description: "Transfer encodings the client accepts" },
  { name: "Upgrade", description: "Switch to another protocol" },
  { name: "User-Agent", description: "Client software" },
  { name: "Via", description: "Proxies the request went through" },
  { name: "X-API-Key", description: "API key (common convention)" },
  { name: "X-Correlation-ID", description: "Id to trace a request across services" },
  { name: "X-Forwarded-For", description: "Original client IP behind a proxy" },
  { name: "X-Forwarded-Host", description: "Original host behind a proxy" },
  { name: "X-Forwarded-Proto", description: "Original protocol behind a proxy" },
  { name: "X-HTTP-Method-Override", description: "Tunnel another method through POST" },
  { name: "X-Request-ID", description: "Unique id for this request" },
  { name: "X-Requested-With", description: "Marks AJAX requests" },
];

export const RESPONSE_HEADERS: HeaderInfo[] = [
  { name: "Access-Control-Allow-Credentials", description: "CORS: allow cookies" },
  { name: "Access-Control-Allow-Headers", description: "CORS: allowed request headers" },
  { name: "Access-Control-Allow-Methods", description: "CORS: allowed methods" },
  { name: "Access-Control-Allow-Origin", description: "CORS: allowed origins" },
  { name: "Access-Control-Expose-Headers", description: "CORS: headers readable by scripts" },
  { name: "Access-Control-Max-Age", description: "CORS: preflight cache time" },
  { name: "Cache-Control", description: "Caching directives" },
  { name: "Content-Disposition", description: "Inline or attachment (download)" },
  { name: "Content-Encoding", description: "Compression applied to the body" },
  { name: "Content-Length", description: "Body size in bytes" },
  { name: "Content-Type", description: "Media type of the body" },
  { name: "ETag", description: "Version identifier of the resource" },
  { name: "Expires", description: "When the response becomes stale" },
  { name: "Last-Modified", description: "When the resource last changed" },
  { name: "Location", description: "Redirect target or created resource" },
  { name: "Retry-After", description: "When to retry" },
  { name: "Set-Cookie", description: "Store a cookie" },
  { name: "Vary", description: "Request headers the response depends on" },
  { name: "WWW-Authenticate", description: "How to authenticate" },
  { name: "X-RateLimit-Limit", description: "Requests allowed per window" },
  { name: "X-RateLimit-Remaining", description: "Requests left in the window" },
  { name: "X-RateLimit-Reset", description: "When the window resets" },
];

const MEDIA_TYPES = [
  "application/json", "application/xml", "text/plain", "text/html", "application/x-www-form-urlencoded",
  "multipart/form-data", "application/octet-stream", "*/*",
];

/** Suggested values, by lower-case header name. */
export const HEADER_VALUES: Record<string, string[]> = {
  "accept": MEDIA_TYPES,
  "content-type": MEDIA_TYPES,
  "accept-encoding": ["gzip, deflate, br", "gzip", "identity"],
  "accept-language": ["en-US,en;q=0.9", "en"],
  "cache-control": ["no-cache", "no-store", "max-age=0", "public, max-age=3600", "private"],
  "connection": ["keep-alive", "close"],
  "authorization": ["Bearer {{token}}", "Basic "],
  "x-requested-with": ["XMLHttpRequest"],
  "prefer": ["return=representation", "return=minimal", "respond-async"],
  "content-disposition": ["inline", "attachment; filename=\"file\""],
  "access-control-allow-origin": ["*"],
  "access-control-allow-methods": ["GET, POST, PUT, PATCH, DELETE, OPTIONS"],
  "access-control-allow-headers": ["Content-Type, Authorization"],
  "access-control-allow-credentials": ["true"],
  "expect": ["100-continue"],
  "dnt": ["1"],
};

/** Inside `{{…` the variable completion takes over. */
const inVariable = (ctx: CompletionContext) => /\{\{[^}]*$/.test(ctx.state.sliceDoc(0, ctx.pos));

/** Header names matching what's typed in a key cell. */
export function headerNameCompletion(list: HeaderInfo[]): CompletionSource {
  const options: Completion[] = list.map((h) => ({ label: h.name, detail: h.description, type: "property" }));
  return (ctx): CompletionResult | null => {
    if (inVariable(ctx)) return null;
    const word = ctx.matchBefore(/[\w-]*/);
    if (!word || (word.from === word.to && !ctx.explicit)) return null;
    return { from: 0, to: ctx.state.doc.length, options, validFor: /^[\w-]*$/ };
  };
}

/** Values for the header named in the same row (`getKey` reads it when the dropdown opens). */
export function headerValueCompletion(getKey: () => string): CompletionSource {
  return (ctx): CompletionResult | null => {
    if (inVariable(ctx)) return null;
    const values = HEADER_VALUES[getKey().trim().toLowerCase()];
    if (!values) return null;
    if (!ctx.explicit && !ctx.matchBefore(/\S+$/)) return null;
    return { from: 0, to: ctx.state.doc.length, options: values.map((v) => ({ label: v, type: "constant" })) };
  };
}
