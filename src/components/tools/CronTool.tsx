import { useMemo } from "react";
import { describeCron, nextRuns, parseCron, relativeTime } from "../../lib/tools";
import { ErrorLine, Section, useToolField } from "./shared";

const PRESETS = [
  ["*/5 * * * *", "Every 5 minutes"], ["0 * * * *", "Hourly"], ["0 9 * * 1-5", "Weekdays 09:00"],
  ["0 0 * * *", "Daily midnight"], ["0 0 * * 0", "Weekly"], ["0 0 1 * *", "Monthly"],
] as const;
const FIELD_NAMES = ["Minute", "Hour", "Day of month", "Month", "Day of week"];

export function CronTool() {
  const [expr, setExpr] = useToolField("cron.expr", "0 9 * * 1-5");
  const [count, setCount] = useToolField("cron.count", 5);
  const result = useMemo(() => {
    try {
      const c = parseCron(expr);
      return { c, text: describeCron(expr), runs: nextRuns(c, count) };
    } catch (e: any) { return { error: e.message as string }; }
  }, [expr, count]);
  return (
    <>
      <Section title="Expression">
        <input className="input mono tool-cron-input" value={expr} onChange={(e) => setExpr(e.target.value)} spellCheck={false} autoFocus
          placeholder="minute hour day-of-month month day-of-week" />
        <div className="tool-chips">
          {PRESETS.map(([e, label]) => <button key={e} className={`chip ${expr === e ? "active" : ""}`} onClick={() => setExpr(e)} title={e}>{label}</button>)}
        </div>
        <ErrorLine error={result.error} />
        {result.text && <div className="tool-cron-text">“{result.text}”</div>}
      </Section>
      {result.c && (
        <>
          <Section title="Fields">
            <table className="tool-table">
              <tbody>
                {result.c.source.map((src, i) => (
                  <tr key={i}>
                    <td style={{ width: 130 }}>{FIELD_NAMES[i]}</td>
                    <td className="mono" style={{ width: 110 }}>{src}</td>
                    <td className="mono muted ellipsis">{result.c.fields[i].join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
          <Section
            title={`Next ${count} runs (local time)`}
            right={<select className="select select-sm" value={count} onChange={(e) => setCount(Number(e.target.value))}>{[5, 10, 25].map((n) => <option key={n} value={n}>{n}</option>)}</select>}
          >
            {result.runs.length === 0 ? <div className="muted">Never fires in the next five years.</div> : (
              <ol className="tool-runs">
                {result.runs.map((d) => <li key={d.getTime()}><span className="mono">{d.toLocaleString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span> <span className="muted">{relativeTime(d)}</span></li>)}
              </ol>
            )}
          </Section>
          <p className="help">Standard 5-field cron. Supports <code>*</code>, lists <code>1,15</code>, ranges <code>1-5</code>, steps <code>*/10</code>, names (<code>MON</code>, <code>JAN</code>) and <code>@daily</code>-style macros. When both day fields are set, a run happens when either matches.</p>
        </>
      )}
    </>
  );
}
