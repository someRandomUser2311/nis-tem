import { useMemo } from "react";
import { CODECS, decode, encode, type Codec } from "../../lib/tools";
import { IconButton } from "../ui";
import { CopyButton, Editor, ErrorLine, Section, Seg, UseInRequest, useToolField } from "./shared";

export function EncodeTool() {
  const [codec, setCodec] = useToolField<Codec>("enc.codec", "base64");
  const [dir, setDir] = useToolField<"encode" | "decode">("enc.dir", "encode");
  const [input, setInput] = useToolField("enc.input", "");
  const out = useMemo(() => {
    if (!input) return { value: "" };
    try { return { value: dir === "encode" ? encode(codec, input) : decode(codec, input) }; } catch (e: any) { return { value: "", error: e.message as string }; }
  }, [codec, dir, input]);
  return (
    <>
      <div className="tool-controls">
        <select className="select select-sm" value={codec} onChange={(e) => setCodec(e.target.value as Codec)}>
          {CODECS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
        <Seg options={[{ id: "encode", label: "Encode" }, { id: "decode", label: "Decode" }]} value={dir} onChange={setDir} />
      </div>
      <Section title="Input">
        <Editor value={input} onChange={setInput} placeholder={dir === "encode" ? "Text to encode" : "Text to decode"} />
      </Section>
      <Section
        title="Output"
        right={<>
          <IconButton icon="compare" title="Swap: use the output as input" disabled={!out.value}
            onClick={() => { setInput(out.value); setDir(dir === "encode" ? "decode" : "encode"); }} />
          <CopyButton text={out.value} />
          <UseInRequest value={out.value} />
        </>}
      >
        <Editor value={out.value} />
        <ErrorLine error={out.error} />
      </Section>
    </>
  );
}
