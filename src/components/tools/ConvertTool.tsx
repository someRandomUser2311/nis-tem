import { useMemo } from "react";
import { convertData, type DataFormat } from "../../lib/tools";
import { IconButton } from "../ui";
import { CopyButton, Editor, ErrorLine, Section, Seg, UseInRequest, useToolField } from "./shared";

const FORMATS = [{ id: "json", label: "JSON" }, { id: "yaml", label: "YAML" }, { id: "csv", label: "CSV" }] as const;

export function ConvertTool() {
  const [from, setFrom] = useToolField<DataFormat>("conv.from", "json");
  const [to, setTo] = useToolField<DataFormat>("conv.to", "yaml");
  const [input, setInput] = useToolField("conv.input", "");
  const out = useMemo(() => {
    if (!input.trim()) return { value: "" };
    try { return { value: convertData(input, from, to) }; } catch (e: any) { return { value: "", error: e.message as string }; }
  }, [input, from, to]);
  return (
    <>
      <div className="tool-controls">
        <span className="muted">From</span>
        <Seg options={FORMATS} value={from} onChange={setFrom} />
        <IconButton icon="compare" title="Swap" onClick={() => { setFrom(to); setTo(from); if (out.value) setInput(out.value); }} />
        <span className="muted">to</span>
        <Seg options={FORMATS} value={to} onChange={setTo} />
      </div>
      <div className="tool-grid-2">
        <Section title={from.toUpperCase()}>
          <Editor value={input} onChange={setInput} language={from === "json" ? "json" : "text"} height={340}
            placeholder={from === "csv" ? "name,age\nAda,36" : from === "yaml" ? "name: Ada\nage: 36" : '[{ "name": "Ada", "age": 36 }]'} />
        </Section>
        <Section title={to.toUpperCase()} right={<><CopyButton text={out.value} /><UseInRequest value={out.value} language={to === "json" ? "json" : "text"} /></>}>
          <Editor value={out.value} language={to === "json" ? "json" : "text"} height={340} />
        </Section>
      </div>
      <ErrorLine error={out.error} />
      {to === "csv" && <p className="help">CSV needs an array — of objects (keys become columns) or of plain values. Nested values are written as JSON.</p>}
    </>
  );
}
