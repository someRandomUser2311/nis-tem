import { useState } from "react";
import type { Auth, AuthType, OAuth2Config } from "../types";
import { cancelAuthorize, decodeJwt, oauthConfig, tokenExpired } from "../lib/oauth";
import { obtainOAuthToken, refreshOAuthToken } from "../store";
import { Icon, Toggle } from "./ui";
import { useVarCollectionId } from "./VarContext";
import { VarInput } from "./VarInput";

const LABELS: Record<AuthType, string> = {
  inherit: "Inherit auth from parent",
  none: "No Auth",
  basic: "Basic Auth",
  bearer: "Bearer Token",
  apikey: "API Key",
  oauth2: "OAuth 2.0",
  digest: "Digest Auth",
  awsv4: "AWS Signature",
  hawk: "Hawk Authentication",
};

const HELP: Record<AuthType, string> = {
  inherit: "Uses the authorization of the parent folder or collection.",
  none: "No authorization will be sent.",
  basic: "The username and password are Base64-encoded and sent in the Authorization header.",
  bearer: "The token is sent in the Authorization header as \"Bearer <token>\".",
  apikey: "The key/value pair is sent as a header or query parameter.",
  oauth2: "Get an access token from an OAuth 2.0 provider; it's sent with every request and refreshed automatically when it expires.",
  digest: "The first request receives the server's Digest challenge; Localpost answers it and resends automatically (MD5, SHA-256, -sess).",
  awsv4: "Signs the request with AWS Signature Version 4 (headers X-Amz-Date and Authorization).",
  hawk: "Signs the request with a Hawk MAC (id + key shared with the server).",
};

const defaults = {
  digest: () => ({ username: "", password: "" }),
  awsv4: () => ({ accessKey: "", secretKey: "", sessionToken: "", region: "us-east-1", service: "execute-api" }),
  hawk: () => ({ id: "", key: "", algorithm: "sha256" as const, ext: "", includePayloadHash: false }),
};

function Field({ label, value, onChange, placeholder, secret }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; secret?: boolean }) {
  return (
    <>
      <label>{label}</label>
      <div className={`input-box ${secret ? "secret-box" : ""}`}><VarInput value={value} onChange={onChange} placeholder={placeholder ?? label} /></div>
    </>
  );
}

export function AuthEditor({ auth, onChange, allowInherit = true, inheritedFrom, subject = "request" }: {
  auth: Auth;
  onChange: (a: Auth) => void;
  allowInherit?: boolean;
  /** e.g. `Bearer Token from collection "Foo"` */
  inheritedFrom?: string;
  subject?: "request" | "folder" | "collection";
}) {
  const types = (Object.keys(LABELS) as AuthType[]).filter((t) => allowInherit || t !== "inherit");
  const digest = { ...defaults.digest(), ...auth.digest };
  const aws = { ...defaults.awsv4(), ...auth.awsv4 };
  const hawk = { ...defaults.hawk(), ...auth.hawk };
  return (
    <div className="auth-editor">
      <div className="auth-left">
        <label className="field-label">Auth Type</label>
        <select className="select" value={auth.type} onChange={(e) => onChange({ ...auth, type: e.target.value as AuthType })}>
          {types.map((t) => <option key={t} value={t}>{LABELS[t]}</option>)}
        </select>
        <p className="help">{HELP[auth.type]}</p>
        {auth.type !== "none" && auth.type !== "inherit" && (
          <p className="help">Tip: use variables like <code>{"{{token}}"}</code> to keep secrets in an environment.</p>
        )}
      </div>
      <div className="auth-right">
        {auth.type === "inherit" && (
          <div className="auth-note">
            {inheritedFrom ? <>This {subject} is using <b>{inheritedFrom}</b>.</> : "Save this request to a collection to inherit authorization."}
          </div>
        )}
        {auth.type === "none" && <div className="auth-note">This {subject} does not use any authorization.</div>}
        {auth.type === "basic" && (
          <div className="form-grid">
            <Field label="Username" value={auth.basic.username} onChange={(v) => onChange({ ...auth, basic: { ...auth.basic, username: v } })} />
            <Field label="Password" value={auth.basic.password} onChange={(v) => onChange({ ...auth, basic: { ...auth.basic, password: v } })} />
          </div>
        )}
        {auth.type === "bearer" && (
          <div className="form-grid">
            <Field label="Token" value={auth.bearer.token} onChange={(v) => onChange({ ...auth, bearer: { ...auth.bearer, token: v } })} />
            <Field label="Prefix" value={auth.bearer.prefix ?? "Bearer"} placeholder="Bearer" onChange={(v) => onChange({ ...auth, bearer: { ...auth.bearer, prefix: v } })} />
          </div>
        )}
        {auth.type === "apikey" && (
          <div className="form-grid">
            <Field label="Key" value={auth.apikey.key} onChange={(v) => onChange({ ...auth, apikey: { ...auth.apikey, key: v } })} />
            <Field label="Value" value={auth.apikey.value} onChange={(v) => onChange({ ...auth, apikey: { ...auth.apikey, value: v } })} />
            <label>Add to</label>
            <select className="select" value={auth.apikey.in} onChange={(e) => onChange({ ...auth, apikey: { ...auth.apikey, in: e.target.value as "header" | "query" } })}>
              <option value="header">Header</option>
              <option value="query">Query Params</option>
            </select>
          </div>
        )}
        {auth.type === "digest" && (
          <div className="form-grid">
            <Field label="Username" value={digest.username} onChange={(v) => onChange({ ...auth, digest: { ...digest, username: v } })} />
            <Field label="Password" value={digest.password} onChange={(v) => onChange({ ...auth, digest: { ...digest, password: v } })} />
          </div>
        )}
        {auth.type === "awsv4" && (
          <div className="form-grid">
            <Field label="Access key" value={aws.accessKey} onChange={(v) => onChange({ ...auth, awsv4: { ...aws, accessKey: v } })} />
            <Field label="Secret key" value={aws.secretKey} onChange={(v) => onChange({ ...auth, awsv4: { ...aws, secretKey: v } })} />
            <Field label="Region" value={aws.region} placeholder="us-east-1" onChange={(v) => onChange({ ...auth, awsv4: { ...aws, region: v } })} />
            <Field label="Service" value={aws.service} placeholder="execute-api, s3, lambda…" onChange={(v) => onChange({ ...auth, awsv4: { ...aws, service: v } })} />
            <Field label="Session token" value={aws.sessionToken} placeholder="Optional (temporary credentials)" onChange={(v) => onChange({ ...auth, awsv4: { ...aws, sessionToken: v } })} />
          </div>
        )}
        {auth.type === "hawk" && (
          <div className="form-grid">
            <Field label="Hawk auth id" value={hawk.id} onChange={(v) => onChange({ ...auth, hawk: { ...hawk, id: v } })} />
            <Field label="Hawk auth key" value={hawk.key} onChange={(v) => onChange({ ...auth, hawk: { ...hawk, key: v } })} />
            <label>Algorithm</label>
            <select className="select" value={hawk.algorithm} onChange={(e) => onChange({ ...auth, hawk: { ...hawk, algorithm: e.target.value as "sha256" | "sha1" } })}>
              <option value="sha256">SHA-256</option>
              <option value="sha1">SHA-1</option>
            </select>
            <Field label="ext" value={hawk.ext} placeholder="Optional application data" onChange={(v) => onChange({ ...auth, hawk: { ...hawk, ext: v } })} />
            <label />
            <Toggle checked={hawk.includePayloadHash} onChange={(includePayloadHash) => onChange({ ...auth, hawk: { ...hawk, includePayloadHash } })} label="Include payload hash" />
          </div>
        )}
        {auth.type === "oauth2" && <OAuth2Editor auth={auth} onChange={onChange} />}
      </div>
    </div>
  );
}

function OAuth2Editor({ auth, onChange }: { auth: Auth; onChange: (a: Auth) => void }) {
  const c = oauthConfig(auth.oauth2);
  const collectionId = useVarCollectionId();
  const [busy, setBusy] = useState<"get" | "refresh" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showToken, setShowToken] = useState(false);
  const set = (patch: Partial<OAuth2Config>) => onChange({ ...auth, oauth2: { ...c, ...patch } });

  const run = async (kind: "get" | "refresh") => {
    setBusy(kind);
    setError(null);
    try {
      const token = kind === "get" ? await obtainOAuthToken(c, collectionId) : await refreshOAuthToken(c, collectionId);
      set({ token });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const t = c.token;
  const claims = t && showToken ? decodeJwt(t.accessToken) : null;
  const expired = tokenExpired(t, 0);

  return (
    <div className="oauth">
      <div className={`oauth-token ${t ? (expired ? "expired" : "ok") : ""}`}>
        {t ? (
          <>
            <div className="oauth-token-head">
              <Icon name={expired ? "close" : "check"} size={12} />
              <b>{expired ? "Token expired" : "Access token"}</b>
              <span className="muted">
                {t.tokenType} · obtained {new Date(t.obtainedAt).toLocaleString()}
                {t.expiresAt ? ` · ${expired ? "expired" : "expires"} ${new Date(t.expiresAt).toLocaleString()}` : " · no expiry given"}
                {t.refreshToken ? " · has refresh token" : ""}
              </span>
              <div className="flex-1" />
              <button className="link-btn" onClick={() => setShowToken(!showToken)}>{showToken ? "Hide" : "Show"}</button>
              <button className="link-btn" onClick={() => navigator.clipboard.writeText(t.accessToken)}>Copy</button>
              {t.refreshToken && <button className="link-btn" disabled={!!busy} onClick={() => run("refresh")}>{busy === "refresh" ? "Refreshing…" : "Refresh"}</button>}
              <button className="link-btn" onClick={() => set({ token: undefined })}>Clear</button>
            </div>
            <div className="mono oauth-token-value selectable">{showToken ? t.accessToken : `${t.accessToken.slice(0, 6)}${"•".repeat(24)}`}</div>
            {claims && <pre className="oauth-claims selectable">{JSON.stringify(claims, null, 2)}</pre>}
          </>
        ) : <span className="muted">No token yet. Configure the provider below, then get a new access token.</span>}
      </div>

      <div className="form-grid">
        <label>Grant type</label>
        <select className="select" value={c.grantType} onChange={(e) => set({ grantType: e.target.value as OAuth2Config["grantType"] })}>
          <option value="authorization_code">Authorization Code{c.usePkce ? " (with PKCE)" : ""}</option>
          <option value="client_credentials">Client Credentials</option>
          <option value="password">Password Credentials</option>
        </select>
        {c.grantType === "authorization_code" && (
          <>
            <Field label="Auth URL" value={c.authUrl} placeholder="https://provider.example.com/oauth/authorize" onChange={(authUrl) => set({ authUrl })} />
            <Field label="Callback URL" value={c.redirectUri} placeholder="http://127.0.0.1:7890/callback" onChange={(redirectUri) => set({ redirectUri })} />
          </>
        )}
        <Field label="Access token URL" value={c.tokenUrl} placeholder="https://provider.example.com/oauth/token" onChange={(tokenUrl) => set({ tokenUrl })} />
        <Field label="Client ID" value={c.clientId} onChange={(clientId) => set({ clientId })} />
        <Field label="Client secret" value={c.clientSecret} placeholder="Optional for public clients with PKCE" onChange={(clientSecret) => set({ clientSecret })} />
        {c.grantType === "password" && (
          <>
            <Field label="Username" value={c.username} onChange={(username) => set({ username })} />
            <Field label="Password" value={c.password} onChange={(password) => set({ password })} />
          </>
        )}
        <Field label="Scope" value={c.scope} placeholder="e.g. openid profile read:users" onChange={(scope) => set({ scope })} />
        <Field label="Audience" value={c.audience} placeholder="Optional" onChange={(audience) => set({ audience })} />
        <label>Client auth</label>
        <select className="select" value={c.clientAuth} onChange={(e) => set({ clientAuth: e.target.value as "body" | "header" })}>
          <option value="body">Send client credentials in body</option>
          <option value="header">Send as Basic Auth header</option>
        </select>
        <Field label="Header prefix" value={c.headerPrefix} placeholder="Bearer" onChange={(headerPrefix) => set({ headerPrefix })} />
        <label>Add token to</label>
        <select className="select" value={c.addTo} onChange={(e) => set({ addTo: e.target.value as "header" | "query" })}>
          <option value="header">Request headers</option>
          <option value="query">Query parameter (access_token)</option>
        </select>
        <label />
        <div className="oauth-toggles">
          {c.grantType === "authorization_code" && <Toggle checked={c.usePkce} onChange={(usePkce) => set({ usePkce })} label="PKCE (S256)" />}
          <Toggle checked={c.autoRefresh} onChange={(autoRefresh) => set({ autoRefresh })} label="Refresh expired tokens automatically" />
        </div>
      </div>

      {c.grantType === "authorization_code" && (
        <p className="help">
          Register <code>{c.redirectUri || "http://127.0.0.1:7890/callback"}</code> as a redirect URI with your provider. Localpost listens there only
          while you sign in, and your browser opens the provider's page.
        </p>
      )}
      <div className="oauth-actions">
        <button className="btn btn-primary" disabled={!!busy} onClick={() => run("get")}>
          {busy === "get" ? (c.grantType === "authorization_code" ? "Waiting for the browser…" : "Requesting…") : "Get New Access Token"}
        </button>
        {busy === "get" && c.grantType === "authorization_code" && <button className="btn" onClick={() => cancelAuthorize()}>Cancel</button>}
        {error && <span className="oauth-error"><Icon name="close" size={11} /> {error}</span>}
      </div>
    </div>
  );
}

export const authLabel = (t: AuthType) => LABELS[t];
