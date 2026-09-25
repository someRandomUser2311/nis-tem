// OAuth 2.0 client: authorization code (+ PKCE) through a loopback redirect, client credentials,
// password, and refresh. Token requests go through the native engine (no CORS), and the
// browser step is handled by the `oauth_authorize` Rust command.
import type { OAuth2Config, OAuth2Token } from "../types";
import { api, type NativeRequest } from "./api";
import { base64url, randomString, sha256 } from "./crypto";
import { uid } from "./utils";

export const defaultOAuth2 = (): OAuth2Config => ({
  grantType: "authorization_code",
  authUrl: "",
  tokenUrl: "",
  clientId: "",
  clientSecret: "",
  scope: "",
  audience: "",
  redirectUri: "http://127.0.0.1:7890/callback",
  usePkce: true,
  clientAuth: "body",
  username: "",
  password: "",
  headerPrefix: "Bearer",
  addTo: "header",
  autoRefresh: true,
});

/** Current config merged over defaults (older saved auths don't have every field). */
export const oauthConfig = (c?: Partial<OAuth2Config>): OAuth2Config => ({ ...defaultOAuth2(), ...(c ?? {}) });

export function tokenExpired(t: OAuth2Token | undefined, skewMs = 30_000): boolean {
  return !!t?.expiresAt && Date.now() + skewMs >= t.expiresAt;
}

export async function pkcePair() {
  const verifier = randomString(64);
  const challenge = base64url(await sha256(verifier));
  return { verifier, challenge };
}

export function buildAuthorizeUrl(c: OAuth2Config, state: string, challenge?: string): string {
  const u = new URL(c.authUrl);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", c.clientId);
  u.searchParams.set("redirect_uri", c.redirectUri);
  if (c.scope) u.searchParams.set("scope", c.scope);
  if (c.audience) u.searchParams.set("audience", c.audience);
  u.searchParams.set("state", state);
  if (challenge) {
    u.searchParams.set("code_challenge", challenge);
    u.searchParams.set("code_challenge_method", "S256");
  }
  return u.toString();
}

/** Parse a token endpoint response (JSON, or form-encoded like GitHub's). */
export function parseTokenResponse(status: number, body: string): OAuth2Token {
  let data: Record<string, any>;
  try {
    data = JSON.parse(body);
  } catch {
    data = Object.fromEntries(new URLSearchParams(body));
  }
  if (status >= 400 || data.error) {
    const msg = [data.error, data.error_description].filter(Boolean).join(": ") || `Token endpoint returned ${status}`;
    throw new Error(msg);
  }
  if (!data.access_token) throw new Error("The token response has no access_token");
  const expiresIn = Number(data.expires_in);
  return {
    accessToken: String(data.access_token),
    tokenType: data.token_type ? String(data.token_type) : "Bearer",
    refreshToken: data.refresh_token ? String(data.refresh_token) : undefined,
    idToken: data.id_token ? String(data.id_token) : undefined,
    scope: data.scope ? String(data.scope) : undefined,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : undefined,
    obtainedAt: Date.now(),
  };
}

type Options = NativeRequest["options"];

async function tokenRequest(c: OAuth2Config, fields: Record<string, string>, options: Options): Promise<OAuth2Token> {
  if (!c.tokenUrl) throw new Error("Enter the access token URL");
  const headers = [{ key: "Accept", value: "application/json" }];
  const form = { ...fields };
  if (c.clientAuth === "header" && c.clientId) {
    const basic = btoa(unescape(encodeURIComponent(`${encodeURIComponent(c.clientId)}:${encodeURIComponent(c.clientSecret)}`)));
    headers.push({ key: "Authorization", value: `Basic ${basic}` });
  } else {
    if (c.clientId) form.client_id = c.clientId;
    if (c.clientSecret) form.client_secret = c.clientSecret;
  }
  const res = await api.send({
    id: uid(), method: "POST", url: c.tokenUrl, headers,
    body: { type: "urlEncoded", fields: Object.entries(form).filter(([, v]) => v !== "").map(([key, value]) => ({ key, value })) },
    options,
  });
  return parseTokenResponse(res.status, res.bodyText);
}

/**
 * Run the configured grant and return a fresh token. `c` must already have variables resolved.
 * `authorize` opens the browser and resolves with the callback's query string.
 */
export async function getNewToken(
  c: OAuth2Config, options: Options,
  authorize: (url: string, redirectUri: string, id: string) => Promise<string> = defaultAuthorize,
): Promise<OAuth2Token> {
  const extra: Record<string, string> = {};
  if (c.scope) extra.scope = c.scope;
  if (c.audience) extra.audience = c.audience;
  switch (c.grantType) {
    case "client_credentials":
      return tokenRequest(c, { grant_type: "client_credentials", ...extra }, options);
    case "password":
      return tokenRequest(c, { grant_type: "password", username: c.username, password: c.password, ...extra }, options);
    case "authorization_code": {
      if (!c.authUrl) throw new Error("Enter the authorization URL");
      const state = randomString(24);
      const pkce = c.usePkce ? await pkcePair() : undefined;
      const query = await authorize(buildAuthorizeUrl(c, state, pkce?.challenge), c.redirectUri, uid());
      const params = new URLSearchParams(query);
      if (params.get("error")) throw new Error([params.get("error"), params.get("error_description")].filter(Boolean).join(": "));
      if (params.get("state") !== state) throw new Error("The authorization response's state doesn't match (possible CSRF); try again");
      const code = params.get("code");
      if (!code) throw new Error("The authorization response has no code");
      return tokenRequest(c, {
        grant_type: "authorization_code", code, redirect_uri: c.redirectUri,
        ...(pkce ? { code_verifier: pkce.verifier } : {}),
      }, options);
    }
  }
}

export async function refreshToken(c: OAuth2Config, token: OAuth2Token, options: Options): Promise<OAuth2Token> {
  if (!token.refreshToken) throw new Error("No refresh token");
  const t = await tokenRequest(c, { grant_type: "refresh_token", refresh_token: token.refreshToken, ...(c.scope ? { scope: c.scope } : {}) }, options);
  // Providers may omit the refresh token on refresh; keep using the old one.
  return { ...t, refreshToken: t.refreshToken ?? token.refreshToken };
}

let pendingAuthorizeId: string | null = null;

async function defaultAuthorize(authorizeUrl: string, redirectUri: string, id: string) {
  pendingAuthorizeId = id;
  try {
    return await api.oauthAuthorize({ id, authorizeUrl, redirectUri, timeoutSecs: 300 });
  } finally {
    pendingAuthorizeId = null;
  }
}

/** Stop waiting for the browser (the user closed it or wants to retry). */
export function cancelAuthorize() {
  if (pendingAuthorizeId) api.cancel(pendingAuthorizeId);
}

/** Decode a JWT's payload for display (no signature check). */
export function decodeJwt(token: string): Record<string, unknown> | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "="));
    return JSON.parse(decodeURIComponent(escape(json)));
  } catch {
    return null;
  }
}
