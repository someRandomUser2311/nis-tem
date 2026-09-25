import { useMemo } from "react";
import { decodeJwtFull, relativeTime, signJwtHs, verifyJwt } from "../../lib/tools";
import { Toggle } from "../ui";
import { CopyButton, Editor, ErrorLine, Section, Seg, UseInRequest, useAsync, useToolField } from "./shared";

const SAMPLE = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

export function JwtTool() {
  const [mode, setMode] = useToolField<"decode" | "create">("jwt.mode", "decode");
  return (
    <>
      <Seg options={[{ id: "decode", label: "Decode & verify" }, { id: "create", label: "Create (HS)" }]} value={mode} onChange={setMode} />
      {mode === "decode" ? <Decode /> : <Create />}
    </>
  );
}

function Decode() {
  const [token, setToken] = useToolField("jwt.token", "");
  const [key, setKey] = useToolField("jwt.key", "");
  const [b64, setB64] = useToolField("jwt.b64", false);
  const decoded = useMemo(() => {
    if (!token.trim()) return {};
    try { return { d: decodeJwtFull(token) }; } catch (e: any) { return { error: e.message as string }; }
  }, [token]);
  const d = decoded.d;
  const verify = useAsync(async () => (d && key.trim() ? verifyJwt(token, key, { secretIsBase64: b64 }) : undefined), [token, key, b64]);
  const alg = String(d?.header.alg ?? "");
  return (
    <>
      <Section title="Token" right={!token && <button className="btn btn-sm" onClick={() => setToken(SAMPLE)}>Try a sample</button>}>
        <Editor value={token} onChange={setToken} height={96} placeholder="Paste a JWT (a leading “Bearer ” is ignored)" />
        <ErrorLine error={decoded.error} />
      </Section>
      {d && (
        <>
          <div className="tool-badges">
            <span className="tool-badge">{alg || "no alg"}</span>
            {d.expired && <span className="tool-badge bad">Expired</span>}
            {d.notYetValid && <span className="tool-badge bad">Not valid yet</span>}
            {!d.expired && !d.notYetValid && d.times.some((t) => t.claim === "exp") && <span className="tool-badge ok">Not expired</span>}
            {d.times.map((t) => (
              <span key={t.claim} className="muted tool-time" title={t.date.toISOString()}>
                <b>{t.claim}</b> {t.date.toLocaleString()} ({relativeTime(t.date)})
              </span>
            ))}
          </div>
          <div className="tool-grid-2">
            <Section title="Header" right={<CopyButton text={JSON.stringify(d.header, null, 2)} />}>
              <Editor value={JSON.stringify(d.header, null, 2)} language="json" height={130} />
            </Section>
            <Section title="Payload" right={<CopyButton text={JSON.stringify(d.payload, null, 2)} />}>
              <Editor value={typeof d.payload === "string" ? d.payload : JSON.stringify(d.payload, null, 2)} language="json" height={130} />
            </Section>
          </div>
          <Section
            title="Verify signature"
            right={alg.startsWith("HS") && <Toggle checked={b64} onChange={setB64} label="Secret is Base64" />}
          >
            <Editor value={key} onChange={setKey} height={alg.startsWith("HS") ? 56 : 120}
              placeholder={alg.startsWith("HS") ? "Shared secret" : "Public key: PEM (-----BEGIN PUBLIC KEY-----) or JWK / JWKS JSON"} />
            {verify.error && <ErrorLine error={verify.error} />}
            {verify.value && (
              <div className={`tool-verdict ${verify.value.valid ? "ok" : "bad"}`}>
                {verify.value.valid ? `✓ Signature verified (${verify.value.alg})` : "✗ Invalid signature"}
              </div>
            )}
          </Section>
          <div className="tool-actions"><UseInRequest value={token.trim().replace(/^Bearer\s+/i, "")} headerValue={`Bearer ${token.trim().replace(/^Bearer\s+/i, "")}`} bearer header="Authorization" /></div>
        </>
      )}
    </>
  );
}

function Create() {
  const now = Math.floor(Date.now() / 1000);
  const [payload, setPayload] = useToolField("jwt.newPayload", JSON.stringify({ sub: "user-1", name: "Ada", iat: now, exp: now + 3600 }, null, 2));
  const [secret, setSecret] = useToolField("jwt.newSecret", "");
  const [alg, setAlg] = useToolField<"HS256" | "HS384" | "HS512">("jwt.newAlg", "HS256");
  const out = useAsync(async () => (secret ? signJwtHs(JSON.parse(payload), secret, alg) : ""), [payload, secret, alg]);
  return (
    <>
      <p className="help">Sign a token with a shared secret to test your own APIs locally.</p>
      <Section title="Payload">
        <Editor value={payload} onChange={setPayload} language="json" height={150} />
      </Section>
      <Section title="Secret" right={<Seg options={["HS256", "HS384", "HS512"] as const} value={alg} onChange={setAlg} />}>
        <input className="input mono" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="Shared secret" />
      </Section>
      <ErrorLine error={out.error} />
      {out.value && (
        <Section title="Token" right={<><CopyButton text={out.value} /><UseInRequest value={out.value} headerValue={`Bearer ${out.value}`} bearer header="Authorization" /></>}>
          <Editor value={out.value} height={80} />
        </Section>
      )}
    </>
  );
}
