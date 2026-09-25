import { useEffect, useMemo, useState } from "react";
import { parseTime, timeFormats } from "../../lib/tools";
import { ErrorLine, OutputRow, Section, useToolField } from "./shared";

export function TimeTool() {
  const [input, setInput] = useToolField("time.input", "");
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const parsed = useMemo(() => {
    try { return { ...parseTime(input, now) }; } catch (e: any) { return { error: e.message as string }; }
  }, [input, now]);
  return (
    <>
      <Section title="Timestamp or date" right={<span className="muted mono">now: {Math.floor(now / 1000)}</span>}>
        <div className="tool-controls">
          <input className="input mono" value={input} onChange={(e) => setInput(e.target.value)} autoFocus
            placeholder="e.g. 1700000000, 1700000000000, 2024-05-01T12:00:00Z, Tue, 01 May 2024 12:00:00 GMT — empty = now" />
          <button className="btn btn-sm" onClick={() => setInput(String(Math.floor(Date.now() / 1000)))}>Now</button>
        </div>
        {"unit" in parsed && parsed.unit && <p className="help">Read as Unix time in {({ s: "seconds", ms: "milliseconds", "µs": "microseconds", ns: "nanoseconds" })[parsed.unit]}.</p>}
        <ErrorLine error={"error" in parsed ? parsed.error : undefined} />
      </Section>
      {"date" in parsed && parsed.date && (
        <Section title={`In ${Intl.DateTimeFormat().resolvedOptions().timeZone}`}>
          <div className="tool-output-list">
            {timeFormats(parsed.date, now).map((f) => <OutputRow key={f.label} label={f.label} value={f.value} header={f.label.startsWith("Unix") || f.label.startsWith("ISO") ? "" : undefined} mono={f.label !== "Local" && f.label !== "Relative"} />)}
          </div>
        </Section>
      )}
    </>
  );
}
