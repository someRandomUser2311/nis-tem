import { useMemo, useState } from "react";
import { inspectId, relativeTime, ulid, uuidv4, uuidv7 } from "../../lib/tools";
import { Icon, Toggle } from "../ui";
import { CopyButton, Editor, Section, Seg, UseInRequest, useToolField } from "./shared";

type Kind = "v4" | "v7" | "ulid";
const GEN: Record<Kind, () => string> = { v4: uuidv4, v7: () => uuidv7(), ulid: () => ulid() };

export function IdTool() {
  const [kind, setKind] = useToolField<Kind>("id.kind", "v4");
  const [count, setCount] = useToolField("id.count", 5);
  const [upper, setUpper] = useToolField("id.upper", false);
  const [seed, setSeed] = useState(0);
  const [probe, setProbe] = useToolField("id.probe", "");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const ids = useMemo(() => Array.from({ length: count }, GEN[kind]).map((s) => (upper ? s.toUpperCase() : s)), [kind, count, upper, seed]);
  const text = ids.join("\n");
  const info = probe.trim() ? inspectId(probe) : null;
  return (
    <>
      <div className="tool-controls">
        <Seg options={[{ id: "v4", label: "UUID v4" }, { id: "v7", label: "UUID v7" }, { id: "ulid", label: "ULID" }]} value={kind} onChange={setKind} />
        <label className="tool-inline">Count
          <input className="input input-sm mono" type="number" min={1} max={500} value={count}
            onChange={(e) => setCount(Math.min(500, Math.max(1, Number(e.target.value) || 1)))} style={{ width: 70 }} />
        </label>
        <Toggle checked={upper} onChange={setUpper} label="Uppercase" />
        <button className="btn btn-sm" onClick={() => setSeed(seed + 1)}><Icon name="bolt" size={12} /> Generate</button>
      </div>
      <p className="help">
        {kind === "v4" ? "Random (122 bits of randomness)." : kind === "v7" ? "Time-ordered: a millisecond timestamp followed by random bits — sorts by creation time (RFC 9562)." : "Time-ordered, 26 characters of Crockford Base32; sorts lexicographically by creation time."}
      </p>
      <Section title={`${ids.length} id${ids.length > 1 ? "s" : ""}`} right={<><CopyButton text={text} /><UseInRequest value={ids[0] ?? ""} header="X-Request-ID" /></>}>
        <Editor value={text} height={Math.min(260, 26 + ids.length * 19)} />
      </Section>
      <Section title="Inspect an id">
        <input className="input mono" value={probe} onChange={(e) => setProbe(e.target.value)} placeholder="Paste a UUID or ULID to see its version and timestamp" />
        {probe.trim() && (
          <div className="tool-badges">
            {info ? <>
              <span className="tool-badge">{info.kind}</span>
              {info.date && <span className="muted">Created {info.date.toISOString()} ({relativeTime(info.date)})</span>}
            </> : <span className="tool-badge bad">Not a UUID or ULID</span>}
          </div>
        )}
      </Section>
    </>
  );
}
