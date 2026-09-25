import { open, save } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Collection, FolderItem, Tab } from "../types";
import { api } from "../lib/api";
import { parseDataFile, startRun, type RunEntry, type RunHandle } from "../lib/runner";
import { findItem, flattenRequests, formatBytes, formatMs, methodColor, statusColor } from "../lib/utils";
import { openRequest, useStore } from "../store";
import { Empty, Icon, menuFromEvent, Toggle } from "./ui";
import { toHtmlReport, toJsonReport, toJUnit } from "../lib/reports";

export function RunnerView({ tab }: { tab: Tab }) {
  const collection = useStore((s) => s.collections.find((c) => c.id === tab.collectionId));
  if (!collection) return <Empty icon="play" title="This collection no longer exists" />;
  return <Runner collection={collection} folderId={tab.folderId} />;
}

function Runner({ collection, folderId }: { collection: Collection; folderId?: string }) {
  const folder = folderId ? (findItem(collection.items, folderId) as FolderItem | undefined) : undefined;
  const all = useMemo(() => flattenRequests(folder ? folder.items : collection.items), [collection, folder]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(all.map((r) => r.id)));
  const [iterations, setIterations] = useState(1);
  const [delayMs, setDelayMs] = useState(0);
  const [data, setData] = useState<{ name: string; rows: Record<string, unknown>[] } | null>(null);
  const [dataError, setDataError] = useState("");
  const [persist, setPersist] = useState(true);
  const [stopOnError, setStopOnError] = useState(false);

  const [entries, setEntries] = useState<RunEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ iteration: number; index: number } | null>(null);
  const [started, setStarted] = useState<number | null>(null);
  const [finishedAt, setFinishedAt] = useState<number | null>(null);
  const [filter, setFilter] = useState<"all" | "passed" | "failed">("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const handle = useRef<RunHandle | null>(null);
  const knownIds = useRef(new Set(all.map((r) => r.id)));

  // Newly added requests are selected by default.
  useEffect(() => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const r of all) if (!prev.has(r.id) && !knownIds.current.has(r.id)) next.add(r.id);
      return next;
    });
    for (const r of all) knownIds.current.add(r.id);
  }, [all]);

  useEffect(() => () => handle.current?.cancel(), []);

  const run = () => {
    const requests = all.filter((r) => selected.has(r.id));
    if (!requests.length) return;
    setEntries([]);
    setExpanded(new Set());
    setRunning(true);
    setStarted(Date.now());
    setFinishedAt(null);
    const h = startRun(
      { collection, requests, iterations, delayMs, data: data?.rows ?? [], persistVariables: persist, stopOnError },
      (e) => setEntries((prev) => [...prev, e]),
      (iteration, index) => setProgress({ iteration, index }),
    );
    handle.current = h;
    h.done.finally(() => { setRunning(false); setProgress(null); setFinishedAt(Date.now()); handle.current = null; });
  };

  const loadData = async () => {
    const path = await open({ multiple: false, filters: [{ name: "Data", extensions: ["csv", "json"] }] });
    if (typeof path !== "string") return;
    try {
      const rows = parseDataFile(path, await api.readTextFile(path));
      setData({ name: path.split(/[\\/]/).pop() ?? path, rows });
      setIterations(rows.length || 1);
      setDataError("");
    } catch (e) {
      setDataError(String(e));
    }
  };

  const allTests = entries.flatMap((e) => e.tests);
  const passedTests = allTests.filter((t) => t.passed && !t.skipped).length;
  const failedTests = allTests.filter((t) => !t.passed).length;
  const errors = entries.filter((e) => e.error).length;
  const avgTime = entries.filter((e) => e.timeMs).reduce((a, e) => a + (e.timeMs ?? 0), 0) / Math.max(1, entries.filter((e) => e.timeMs).length);
  const isFailed = (e: RunEntry) => !!e.error || e.tests.some((t) => !t.passed);
  const shown = entries.filter((e) => filter === "all" || (filter === "failed" ? isFailed(e) : !isFailed(e)));
  const totalIterations = Math.max(1, data?.rows.length && iterations <= 1 ? data.rows.length : iterations);

  const exportResults = async (format: "json" | "junit" | "html") => {
    const report = { collection: collection.name, startedAt: started ?? Date.now(), finishedAt: finishedAt ?? Date.now(), entries };
    const base = collection.name.replace(/[^\w.-]+/g, "_");
    const [ext, text, name] = format === "json" ? ["json", toJsonReport(report), "JSON"] : format === "junit" ? ["xml", toJUnit(report), "JUnit XML"] : ["html", toHtmlReport(report), "HTML"];
    const path = await save({ defaultPath: `${base}.run.${format === "junit" ? "junit.xml" : ext}`, filters: [{ name, extensions: [ext] }] });
    if (path) await api.writeTextFile(path, text);
  };

  return (
    <div className="runner">
      <div className="runner-config">
        <div className="runner-title">
          <Icon name="play" /> Runner · {folder ? `${collection.name} / ${folder.name}` : collection.name}
        </div>

        <div className="runner-section">
          <div className="runner-section-head">
            <span>Run order</span>
            <div className="flex-1" />
            <button className="link-btn" onClick={() => setSelected(new Set(all.map((r) => r.id)))}>Select all</button>
            <button className="link-btn" onClick={() => setSelected(new Set())}>Deselect all</button>
          </div>
          <div className="runner-requests">
            {all.length === 0 && <div className="muted pad">No requests to run.</div>}
            {all.map((r) => (
              <label key={r.id} className="runner-req">
                <input type="checkbox" checked={selected.has(r.id)} onChange={(e) => {
                  const next = new Set(selected);
                  if (e.target.checked) next.add(r.id); else next.delete(r.id);
                  setSelected(next);
                }} />
                <span className="method-badge" style={{ color: methodColor(r.method) }}>{r.method}</span>
                <span className="ellipsis">{r.name}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="runner-section">
          <div className="form-grid">
            <label>Iterations</label>
            <input className="input" type="number" min={1} value={iterations} onChange={(e) => setIterations(Math.max(1, Number(e.target.value) || 1))} />
            <label>Delay (ms)</label>
            <input className="input" type="number" min={0} value={delayMs} onChange={(e) => setDelayMs(Math.max(0, Number(e.target.value) || 0))} />
            <label>Data file</label>
            <div className="row gap">
              <button className="btn" onClick={loadData}><Icon name="file" /> {data ? "Change" : "Select file"}</button>
              {data && <span className="muted ellipsis">{data.name} · {data.rows.length} rows</span>}
              {data && <button className="link-btn" onClick={() => setData(null)}>Remove</button>}
            </div>
          </div>
          {dataError && <div className="error-text">{dataError}</div>}
          {data && data.rows.length > 0 && (
            <div className="data-preview">
              <table className="data-table">
                <thead><tr>{Object.keys(data.rows[0]).map((k) => <th key={k}>{k}</th>)}</tr></thead>
                <tbody>{data.rows.slice(0, 5).map((r, i) => <tr key={i}>{Object.keys(data.rows[0]).map((k) => <td key={k}>{String(r[k] ?? "")}</td>)}</tr>)}</tbody>
              </table>
              {data.rows.length > 5 && <div className="muted">…and {data.rows.length - 5} more rows</div>}
            </div>
          )}
          <div className="runner-toggles">
            <Toggle checked={persist} onChange={setPersist} label="Persist variable changes after the run" />
            <Toggle checked={stopOnError} onChange={setStopOnError} label="Stop run if an error occurs or a test fails" />
          </div>
        </div>

        {running ? (
          <button className="btn btn-danger btn-block" onClick={() => handle.current?.cancel()}>Stop Run</button>
        ) : (
          <button className="btn btn-primary btn-block" onClick={run} disabled={!selected.size}>
            Run {folder?.name ?? collection.name}
          </button>
        )}
      </div>

      <div className="runner-results">
        {!started ? (
          <Empty icon="play" title="Run your collection">Choose requests and options on the left, then click Run. Results and test outcomes will show up here.</Empty>
        ) : (
          <>
            <div className="run-summary">
              <div className="stat"><div className="stat-value">{entries.length}</div><div className="stat-label">Requests</div></div>
              <div className="stat"><div className="stat-value ok">{passedTests}</div><div className="stat-label">Passed tests</div></div>
              <div className="stat"><div className="stat-value bad">{failedTests}</div><div className="stat-label">Failed tests</div></div>
              <div className="stat"><div className="stat-value bad">{errors}</div><div className="stat-label">Errors</div></div>
              <div className="stat"><div className="stat-value">{formatMs(avgTime || 0)}</div><div className="stat-label">Avg. resp. time</div></div>
              <div className="stat"><div className="stat-value">{formatMs((finishedAt ?? Date.now()) - started)}</div><div className="stat-label">Duration</div></div>
            </div>
            <div className="run-toolbar">
              <div className="seg">
                {(["all", "passed", "failed"] as const).map((f) => (
                  <button key={f} className={`seg-btn ${filter === f ? "active" : ""}`} onClick={() => setFilter(f)}>{f[0].toUpperCase() + f.slice(1)}</button>
                ))}
              </div>
              {running && progress && (
                <span className="muted">
                  <span className="spinner small" /> Iteration {progress.iteration + 1}/{totalIterations}
                </span>
              )}
              <div className="flex-1" />
              <button className="btn" disabled={!entries.length} onClick={(e) => menuFromEvent(e, [
                { label: "HTML report…", onClick: () => exportResults("html") },
                { label: "JUnit XML (CI)…", onClick: () => exportResults("junit") },
                { label: "JSON…", onClick: () => exportResults("json") },
              ])}><Icon name="export" /> Export report <Icon name="chevronDown" size={11} /></button>
            </div>
            <div className="run-list">
              {shown.map((e, idx) => {
                const showIter = idx === 0 || shown[idx - 1].iteration !== e.iteration;
                const open = expanded.has(e.id);
                return (
                  <div key={e.id}>
                    {showIter && totalIterations > 1 && <div className="run-iter">Iteration {e.iteration + 1}</div>}
                    <div className={`run-row ${isFailed(e) ? "failed" : ""}`} onClick={() => {
                      const n = new Set(expanded);
                      if (open) n.delete(e.id); else n.add(e.id);
                      setExpanded(n);
                    }}>
                      <Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
                      <span className="method-badge" style={{ color: methodColor(e.method) }}>{e.method}</span>
                      <button className="link-btn run-name" onClick={(ev) => { ev.stopPropagation(); openRequest(collection.id, e.requestId); }}>{e.name}</button>
                      <span className="muted ellipsis run-url">{e.url}</span>
                      <div className="flex-1" />
                      {e.error ? <span className="err-text">{e.error.length > 60 ? e.error.slice(0, 60) + "…" : e.error}</span> : (
                        <>
                          <span style={{ color: statusColor(e.status ?? 0) }}>{e.status} {e.statusText}</span>
                          <span className="muted">{formatMs(e.timeMs ?? 0)}</span>
                          <span className="muted">{formatBytes(e.size ?? 0)}</span>
                        </>
                      )}
                      {e.tests.length > 0 && (
                        <span className={`test-count ${e.tests.some((t) => !t.passed) ? "bad" : "ok"}`}>
                          {e.tests.filter((t) => t.passed).length}/{e.tests.length}
                        </span>
                      )}
                    </div>
                    {open && (
                      <div className="run-detail">
                        {e.error && <pre className="response-error-msg">{e.error}</pre>}
                        {e.tests.length === 0 && !e.error && <div className="muted">No tests</div>}
                        {e.tests.map((t, i) => (
                          <div key={i} className="test-row">
                            <span className={`test-badge ${t.skipped ? "skip" : t.passed ? "pass" : "fail"}`}>{t.skipped ? "SKIPPED" : t.passed ? "PASS" : "FAIL"}</span>
                            <span className="test-name">{t.name}</span>
                            {t.error && <span className="test-error">| {t.error}</span>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
