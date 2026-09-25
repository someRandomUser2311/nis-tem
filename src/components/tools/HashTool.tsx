import { bytesToBase64, toHex } from "../../lib/crypto";
import { digest, HASH_ALGS, hmacDigest } from "../../lib/tools";
import { Editor, ErrorLine, OutputRow, Section, Seg, useAsync, useToolField } from "./shared";

export function HashTool() {
  const [input, setInput] = useToolField("hash.input", "");
  const [mode, setMode] = useToolField<"hash" | "hmac">("hash.mode", "hash");
  const [key, setKey] = useToolField("hash.key", "");
  const [format, setFormat] = useToolField<"hex" | "base64">("hash.format", "hex");
  const out = useAsync(
    () => Promise.all(HASH_ALGS.map(async (alg) => {
      const b = mode === "hmac" ? await hmacDigest(alg, key, input) : await digest(alg, input);
      return { alg, value: format === "hex" ? toHex(b) : bytesToBase64(b) };
    })),
    [input, mode, key, format],
  );
  return (
    <>
      <div className="tool-controls">
        <Seg options={[{ id: "hash", label: "Hash" }, { id: "hmac", label: "HMAC" }]} value={mode} onChange={setMode} />
        <Seg options={[{ id: "hex", label: "Hex" }, { id: "base64", label: "Base64" }]} value={format} onChange={setFormat} />
      </div>
      <Section title="Input (UTF-8 text)">
        <Editor value={input} onChange={setInput} height={120} placeholder="Text to hash" />
      </Section>
      {mode === "hmac" && (
        <Section title="Key">
          <input className="input mono" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Secret key" />
        </Section>
      )}
      <Section title={mode === "hmac" ? "HMAC" : "Digest"}>
        <div className="tool-output-list">
          {(out.value ?? []).map((r) => <OutputRow key={r.alg} label={mode === "hmac" ? `HMAC-${r.alg}` : r.alg} value={r.value} header="" />)}
        </div>
        <ErrorLine error={out.error} />
      </Section>
    </>
  );
}
