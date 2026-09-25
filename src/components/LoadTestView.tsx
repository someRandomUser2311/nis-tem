// Load testing: configure virtual users and duration, watch throughput and latency live.
import { useMemo, useState } from "react";
import type { LoadConfigInput, LoadEvent, Tab } from "../types";
import { methodColor, statusColor } from "../lib/utils";
import { startLoadTest, stopLoadTest, useLoadRuns } from "../store";
import { Empty, Icon } from "./ui";

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const DEFAULTS: LoadConfigInput = { vus: 10, durationSecs: 30, rampUpSecs: 5, maxRequests: 0, thinkMs: 0 };

function NumberField({ label, value, onChange, min, max, suffix, hint }: {
  label: string; value: number; onChange: (v: number) => void; min: number; max: number; suffix?: string; hint?: string;
}) {
  return (
    <label className="load-field" title={hint}>
      <span>{label}</span>
      <div className="load-input">
        <input className="input input-sm mono" type="number" min={min} max={max} value={value} onChange={(e) => onChange(Math.min(max, Math.max(min, Number(e.target.value) || 0)))} />
        {suffix && <span className="muted">{suffix}</span>}
      </div>
    </label>
  );
}

interface Series { name: string; color: string; values: number[] }

/** Minimal responsive SVG line chart (x = seconds). */
function LineChart({ series, height = 150 }: { series: Series[]; height?: number }) {
  const n = Math.max(...series.map((s) => s.values.length), 2);
  const maxV = Math.max(1, ...series.flatMap((s) => s.values)) * 1.1;
  const W = 600, H = height, padL = 44, padB = 18, padT = 8;
  const x = (i: number) => padL + (i / (n - 1)) * (W - padL - 8);
  const y = (v: number) => padT + (1 - v / maxV) * (H - padT - padB);
  const ticks = [0, 0.5, 1].map((f) => maxV * f);
  const fmt = (v: number) => (v >= 100 ? Math.round(v).toString() : v.toFixed(1));
  return (
    <svg className="load-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img">
      {ticks.map((t, i) => (
        <g key={i}>
          <line x1={padL} x2={W - 8} y1={y(t)} y2={y(t)} className="load-grid" />
          <text x={padL - 6} y={y(t) + 3} className="load-axis" textAnchor="end">{fmt(t)}</text>
        </g>
      ))}
      <text x={padL} y={H - 4} className="load-axis">0s</text>
      <text x={W - 8} y={H - 4} className="load-axis" textAnchor="end">{n - 1}s</text>
      {series.map((s) => (
        <polyline key={s.name} fill="none" stroke={s.color} strokeWidth={2} vectorEffect="non-scaling-stroke"
          points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(" ")} />
      ))}
    </svg>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "ok" | "bad" }) {
  return <div className="stat"><div className={`stat-value ${tone ?? ""}`}>{value}</div><div className="stat-label">{label}</div></div>;
}

export function LoadTestView({ tab }: { tab: Tab }) {
  const run = useLoadRuns((s) => s[tab.id]);
  const [cfg, setCfg] = useState<LoadConfigInput>(() => run?.config ?? DEFAULTS);
  const set = (p: Partial<LoadConfigInput>) => setCfg((c) => ({ ...c, ...p }));
  const draft = tab.draft;
  const points = run?.points ?? [];
  const last: LoadEvent | undefined = run?.final ?? points[points.length - 1];

  const series = useMemo(() => ({
    rps: [{ name: "Requests/s", color: "var(--accent)", values: points.map((p) => p.rps) }],
    latency: [
      { name: "p50", color: "var(--info)", values: points.map((p) => p.interval.p50) },
      { name: "p95", color: "var(--warn)", values: points.map((p) => p.interval.p95) },
      { name: "p99", color: "var(--err)", values: points.map((p) => p.interval.p99) },
    ],
  }), [points]);

  if (!draft) return <Empty icon="gauge" title="Nothing to load test" />;
  const running = !!run?.running;
  const errorRate = last && last.total ? (last.errors / last.total) * 100 : 0;
  const statuses = last ? Object.entries(last.statuses).sort(([a], [b]) => a.localeCompare(b)) : [];
  const totalStatuses = statuses.reduce((n, [, c]) => n + c, 0) || 1;
  const avgRps = last && last.elapsedMs ? last.total / (last.elapsedMs / 1000) : 0;

  return (
    <div className="container-editor load-view">
      <div className="container-header">
        <Icon name="gauge" size={18} />
        <span className="container-title">Load test</span>
        <span className="method-badge" style={{ color: methodColor(draft.method), width: "auto" }}>{draft.method}</span>
        <span className="mono ellipsis muted" style={{ flex: 1, minWidth: 0 }} title={run?.url ?? draft.url}>{run?.url ?? draft.url}</span>
        {running
          ? <button className="btn" onClick={() => stopLoadTest(tab.id)}><Icon name="stop" size={12} /> Stop</button>
          : <button className="btn btn-primary" disabled={!inTauri && !import.meta.env?.DEV} onClick={() => startLoadTest(tab.id, cfg)}><Icon name="play" size={12} /> {run ? "Run again" : "Start"}</button>}
      </div>
      <div className="load-config">
        <NumberField label="Virtual users" value={cfg.vus} min={1} max={1000} onChange={(vus) => set({ vus })} hint="Concurrent connections sending requests in a loop" />
        <NumberField label="Duration" value={cfg.durationSecs} min={1} max={3600} suffix="s" onChange={(durationSecs) => set({ durationSecs })} />
        <NumberField label="Ramp-up" value={cfg.rampUpSecs} min={0} max={3600} suffix="s" onChange={(rampUpSecs) => set({ rampUpSecs })} hint="Virtual users start evenly over this time" />
        <NumberField label="Max requests" value={cfg.maxRequests} min={0} max={10_000_000} onChange={(maxRequests) => set({ maxRequests })} hint="0 = no limit" />
        <NumberField label="Think time" value={cfg.thinkMs} min={0} max={60_000} suffix="ms" onChange={(thinkMs) => set({ thinkMs })} hint="Pause per user between requests" />
      </div>
      <p className="help pad load-warning">
        <Icon name="lock" size={11} /> Only load test servers you own or have permission to test. The request is resolved once (variables, auth); scripts don't run.
      </p>
      {run?.error && <div className="server-banner error"><Icon name="close" size={12} /> {run.error}</div>}
      <div className="container-content">
        {!run ? (
          <Empty icon="gauge" title="Configure and start">Throughput, latency percentiles and status codes will appear here every second.</Empty>
        ) : (
          <div className="load-results">
            <div className="stat-row">
              <Stat label={running ? "Requests/s (now)" : "Requests/s (avg)"} value={(running ? points[points.length - 1]?.rps ?? 0 : avgRps).toFixed(1)} />
              <Stat label="Requests" value={String(last?.total ?? 0)} />
              <Stat label="p50" value={`${(last?.overall.p50 ?? 0).toFixed(1)} ms`} />
              <Stat label="p95" value={`${(last?.overall.p95 ?? 0).toFixed(1)} ms`} />
              <Stat label="p99" value={`${(last?.overall.p99 ?? 0).toFixed(1)} ms`} />
              <Stat label="Errors" value={`${errorRate.toFixed(1)}%`} tone={errorRate > 0 ? "bad" : "ok"} />
              <Stat label={running ? "Active users" : "Elapsed"} value={running ? String(last?.activeVus ?? 0) : `${((last?.elapsedMs ?? 0) / 1000).toFixed(1)} s`} />
            </div>
            <div className="load-charts">
              <div className="load-chart-card">
                <div className="load-chart-title">Throughput <span className="muted">req/s</span></div>
                <LineChart series={series.rps} />
              </div>
              <div className="load-chart-card">
                <div className="load-chart-title">Latency <span className="muted">ms</span> <span className="load-legend">{series.latency.map((s) => <span key={s.name}><i style={{ background: s.color }} />{s.name}</span>)}</span></div>
                <LineChart series={series.latency} />
              </div>
            </div>
            <div className="load-chart-card">
              <div className="load-chart-title">Status codes</div>
              {statuses.length === 0 ? <div className="muted">No responses yet.</div> : statuses.map(([code, count]) => (
                <div key={code} className="load-status">
                  <span className="mono" style={{ color: code === "error" ? "var(--err)" : statusColor(Number(code)) }}>{code}</span>
                  <div className="load-bar"><div style={{ width: `${(count / totalStatuses) * 100}%`, background: code === "error" ? "var(--err)" : statusColor(Number(code)) }} /></div>
                  <span className="muted mono">{count} ({((count / totalStatuses) * 100).toFixed(1)}%)</span>
                </div>
              ))}
              {last?.lastError && <div className="err-text mono load-last-error">Last error: {last.lastError}</div>}
              {run.final && (
                <div className="muted load-summary">
                  Finished: {run.final.total} requests in {(run.final.elapsedMs / 1000).toFixed(1)} s · mean {run.final.overall.mean.toFixed(1)} ms · max {run.final.overall.max.toFixed(1)} ms
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
