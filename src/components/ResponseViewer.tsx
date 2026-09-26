import { save } from "@tauri-apps/plugin-dialog";
import { JSONPath } from "jsonpath-plus";
import { useMemo, useState } from "react";
import type { RunResult } from "../types";
import { api } from "../lib/api";
import { cellText, tableToCsv, toTable, type TableData } from "../lib/search";
import { formatBytes, formatMs, getHeader, statusColor, tryPrettyJson } from "../lib/utils";
import { openDiff } from "./WorkspaceModals";
import { CodeEditor, type CodeLang } from "./CodeEditor";
import { formatXml } from "./BodyEditor";
import { Empty, Icon, IconButton, menuFromEvent, Tabs } from "./ui";

type RTab = "body" | "cookies" | "headers" | "tests";
type View = "pretty" | "raw" | "preview" | "table";

function detectLang(contentType: string, body: string): CodeLang {
  const ct = contentType.toLowerCase();
  if (ct.includes("json")) return "json";
  if (ct.includes("html")) return "html";
  if (ct.includes("xml")) return "xml";
  if (ct.includes("javascript")) return "javascript";
  const t = body.trimStart();
  if (t.startsWith("{") || t.startsWith("[")) return "json";
  if (t.startsWith("<")) return t.toLowerCase().startsWith("<!doctype html") || t.toLowerCase().startsWith("<html") ? "html" : "xml";
  return "text";
}

function parseSetCookie(v: string) {
  const [pair, ...attrs] = v.split(";").map((s) => s.trim());
  const eq = pair.indexOf("=");
  const c: Record<string, string> = { name: pair.slice(0, eq), value: pair.slice(eq + 1) };
  const flags: string[] = [];
  for (const a of attrs) {
    const i = a.indexOf("=");
    if (i < 0) flags.push(a.toLowerCase());
    else c[a.slice(0, i).toLowerCase()] = a.slice(i + 1);
  }
  return { ...c, httpOnly: flags.includes("httponly"), secure: flags.includes("secure") };
}

/** Evaluate a JSONPath expression; returns the pretty-printed result or an error message. */
function applyJsonPath(body: string, path: string): { text: string; error?: string } {
  try {
    const data = JSON.parse(body);
    const out = JSONPath({ path, json: data, wrap: true });
    return { text: JSON.stringify(Array.isArray(out) && out.length === 1 ? out[0] : out, null, 2) };
  } catch (e) {
    return { text: "", error: e instanceof Error ? e.message : String(e) };
  }
}

export function ResponseViewer({ result, previous, loading, onCancel, onSaveExample, onUpdateExample }: {
  result?: RunResult; previous?: RunResult; loading?: boolean; onCancel: () => void;
  /** Undefined when the request isn't saved in a collection yet. */
  onSaveExample?: () => void;
  /** Refresh the saved example for this status with the response (label says which). */
  onUpdateExample?: { label: string; run: () => void };
}) {
  const [tab, setTab] = useState<RTab>("body");
  const [view, setView] = useState<View>("pretty");
  const [langOverride, setLangOverride] = useState<CodeLang | "auto">("auto");
  const [wrap, setWrap] = useState(true);
  const [testFilter, setTestFilter] = useState<"all" | "passed" | "failed" | "skipped">("all");
  const [filterOpen, setFilterOpen] = useState(false);
  const [jsonPath, setJsonPath] = useState("");

  const res = result?.response;
  const contentType = res ? getHeader(res.headers, "content-type") ?? "" : "";
  const detected = res ? detectLang(contentType, res.bodyText) : "text";
  const lang = langOverride === "auto" ? detected : langOverride;

  const pretty = useMemo(() => {
    if (!res || res.isBinary) return "";
    if (res.bodyText.length > 20_000_000) return res.bodyText;
    if (lang === "json") return tryPrettyJson(res.bodyText) ?? res.bodyText;
    if (lang === "xml") return formatXml(res.bodyText);
    return res.bodyText;
  }, [res, lang]);

  const isJson = !!res && !res.isBinary && lang === "json";
  const filtered = useMemo(
    () => (isJson && filterOpen && jsonPath.trim() ? applyJsonPath(res!.bodyText, jsonPath.trim()) : null),
    [isJson, filterOpen, jsonPath, res],
  );
  const shownText = filtered && !filtered.error ? filtered.text : pretty;
  const table = useMemo<TableData | null>(() => {
    if (!isJson) return null;
    try { return toTable(filtered && !filtered.error ? JSON.parse(filtered.text) : JSON.parse(res!.bodyText)); } catch { return null; }
  }, [isJson, filtered, res]);

  const cookies = useMemo(
    () => (res ? res.headers.filter((h) => h.key.toLowerCase() === "set-cookie").map((h) => parseSetCookie(h.value)) : []),
    [res],
  );

  const tests = result?.tests ?? [];
  const passed = tests.filter((t) => t.passed && !t.skipped).length;
  const failed = tests.filter((t) => !t.passed).length;

  if (loading) {
    return (
      <div className="response response-loading">
        <div className="spinner" />
        <div>Sending request…</div>
        <button className="btn" onClick={onCancel}>Cancel</button>
      </div>
    );
  }

  if (!result) {
    return (
      <div className="response">
        <div className="response-header"><span className="response-title">Response</span></div>
        <Empty icon="bolt" title="Enter the URL and click Send to get a response" />
      </div>
    );
  }

  if (!res) {
    return (
      <div className="response">
        <div className="response-header"><span className="response-title">Response</span></div>
        <div className={`response-error ${result.error === "Request cancelled" ? "neutral" : ""}`}>
          <Icon name="close" size={28} />
          <div className="response-error-title">{result.error === "Request cancelled" ? "Request cancelled" : "Could not send request"}</div>
          {result.error !== "Request cancelled" && <pre className="response-error-msg">{result.error}</pre>}
          {tests.length > 0 && <div className="muted">{passed}/{tests.length} tests passed</div>}
        </div>
      </div>
    );
  }

  const imageSrc = res.isBinary && contentType.startsWith("image/") && res.bodyBase64 ? `data:${contentType.split(";")[0]};base64,${res.bodyBase64}` : null;
  const pdfSrc = res.isBinary && contentType.includes("pdf") && res.bodyBase64 ? `data:application/pdf;base64,${res.bodyBase64}` : null;

  const compareWithPrevious = () => {
    const prev = previous?.response;
    if (!prev) return;
    openDiff(
      "Compare responses",
      { label: `Previous · ${prev.status} ${prev.statusText} · ${formatMs(prev.timeMs)}`, text: prev.bodyText },
      { label: `Latest · ${res.status} ${res.statusText} · ${formatMs(res.timeMs)}`, text: res.bodyText },
    );
  };

  const saveToFile = async () => {
    const ext = res.isBinary ? contentType.split("/")[1]?.split(";")[0] ?? "bin" : lang === "text" ? "txt" : lang === "javascript" ? "js" : lang;
    const path = await save({ defaultPath: `response.${ext}` });
    if (!path) return;
    if (res.isBinary && res.bodyBase64) await api.writeBase64File(path, res.bodyBase64);
    else await api.writeTextFile(path, view === "pretty" ? pretty : res.bodyText);
  };

  const meta = (
    <div className="response-meta">
      <span className="meta-item status-pill" style={{ color: statusColor(res.status) }} title={res.statusText}>
        {res.status} {res.statusText}
      </span>
      <span className="meta-item hover-card">
        <span className="meta-value">{formatMs(res.timeMs)}</span>
        <div className="hover-card-body">
          <div className="hc-title">Response Time</div>
          <div className="hc-row"><span>Waiting (TTFB)</span><span>{formatMs(res.ttfbMs)}</span></div>
          <div className="hc-row"><span>Download</span><span>{formatMs(Math.max(0, res.timeMs - res.ttfbMs))}</span></div>
          <div className="hc-row total"><span>Total</span><span>{formatMs(res.timeMs)}</span></div>
        </div>
      </span>
      <span className="meta-item hover-card">
        <span className="meta-value">{formatBytes(res.size + res.headersSize)}</span>
        <div className="hover-card-body">
          <div className="hc-title">Response Size</div>
          <div className="hc-row"><span>Headers</span><span>{formatBytes(res.headersSize)}</span></div>
          <div className="hc-row"><span>Body</span><span>{formatBytes(res.size)}</span></div>
          <div className="hc-title" style={{ marginTop: 8 }}>Connection</div>
          <div className="hc-row"><span>HTTP Version</span><span>{res.httpVersion}</span></div>
          {res.remoteAddr && <div className="hc-row"><span>Remote Address</span><span>{res.remoteAddr}</span></div>}
          <div className="hc-row"><span>Final URL</span><span className="hc-url">{res.url}</span></div>
        </div>
      </span>
      <IconButton
        icon="dots"
        title="More"
        onClick={(e) => menuFromEvent(e, [
          { label: onSaveExample ? "Save as example…" : "Save as example (save the request first)", onClick: onSaveExample, disabled: !onSaveExample },
          ...(onUpdateExample ? [{ label: onUpdateExample.label, onClick: onUpdateExample.run }] : []),
          { label: "Save response to file…", onClick: saveToFile },
          { label: "Copy response body", onClick: () => navigator.clipboard.writeText(res.bodyText) },
          { label: "Copy response headers", onClick: () => navigator.clipboard.writeText(res.headers.map((h) => `${h.key}: ${h.value}`).join("\n")) },
          { divider: true },
          { label: "Compare with previous response", disabled: !previous?.response, onClick: compareWithPrevious },
        ])}
      />
    </div>
  );

  return (
    <div className="response">
      <Tabs
        className="response-tabs"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "body", label: "Body" },
          { id: "cookies", label: "Cookies", badge: cookies.length || undefined },
          { id: "headers", label: "Headers", badge: res.headers.length },
          { id: "tests", label: "Test Results", badge: tests.length ? `${passed}/${tests.length}` : undefined },
        ]}
        right={meta}
      />

      {tab === "body" && (
        <div className="response-body">
          <div className="body-toolbar">
            <div className="seg">
              {(["pretty", "raw", "preview", ...(table ? ["table"] : [])] as View[]).map((v) => (
                <button key={v} className={`seg-btn ${view === v ? "active" : ""}`} onClick={() => setView(v)}>{v[0].toUpperCase() + v.slice(1)}</button>
              ))}
            </div>
            {view === "pretty" && !res.isBinary && (
              <select className="select select-sm" value={langOverride} onChange={(e) => setLangOverride(e.target.value as CodeLang | "auto")}>
                <option value="auto">Auto ({detected.toUpperCase()})</option>
                <option value="json">JSON</option>
                <option value="xml">XML</option>
                <option value="html">HTML</option>
                <option value="javascript">JavaScript</option>
                <option value="text">Text</option>
              </select>
            )}
            {isJson && filterOpen && (view === "pretty" || view === "table") && (
              <div className={`search-box jsonpath-box ${filtered?.error ? "invalid" : ""}`} title={filtered?.error ?? "JSONPath, e.g. $.items[*].name or $..id"}>
                <Icon name="filter" size={12} />
                <input autoFocus value={jsonPath} onChange={(e) => setJsonPath(e.target.value)} placeholder="$.data[*].id" spellCheck={false} />
              </div>
            )}
            <div className="flex-1" />
            {isJson && <IconButton icon="filter" title="Filter with JSONPath" active={filterOpen} onClick={() => setFilterOpen(!filterOpen)} />}
            {previous?.response && <IconButton icon="diff" title="Compare with previous response" onClick={compareWithPrevious} />}
            <IconButton icon="example" title={onSaveExample ? "Save as example (mock servers serve examples)" : "Save the request to a collection to keep examples"} disabled={!onSaveExample} onClick={onSaveExample} />
            <IconButton icon="wrap" title="Toggle line wrap" active={wrap} onClick={() => setWrap(!wrap)} />
            <IconButton icon="copy" title={view === "table" ? "Copy as CSV" : "Copy body"} onClick={() => navigator.clipboard.writeText(view === "table" && table ? tableToCsv(table) : view === "pretty" ? shownText : res.bodyText)} />
            <IconButton icon="save" title="Save response to file" onClick={saveToFile} />
          </div>
          <div className="body-view">
            {view === "preview" ? (
              imageSrc ? <div className="img-preview"><img src={imageSrc} alt="response" /></div>
                : pdfSrc ? <iframe className="preview-frame" src={pdfSrc} title="preview" />
                : <iframe className="preview-frame" sandbox="" srcDoc={res.bodyText} title="preview" />
            ) : res.isBinary ? (
              imageSrc ? <div className="img-preview"><img src={imageSrc} alt="response" /></div>
                : <Empty icon="file" title={`Binary response (${formatBytes(res.size)})`}>Use “Save response to file” to download it.</Empty>
            ) : view === "table" && table ? (
              <JsonTable data={table} />
            ) : view === "raw" ? (
              <CodeEditor value={res.bodyText} readOnly wrap={wrap} language="text" />
            ) : (
              <CodeEditor value={shownText} readOnly wrap={wrap} language={lang} />
            )}
          </div>
        </div>
      )}

      {tab === "headers" && (
        <div className="response-scroll">
          <table className="data-table">
            <thead><tr><th>Key</th><th>Value</th></tr></thead>
            <tbody>
              {res.headers.map((h, i) => <tr key={i}><td className="mono">{h.key}</td><td className="mono selectable">{h.value}</td></tr>)}
            </tbody>
          </table>
        </div>
      )}

      {tab === "cookies" && (
        <div className="response-scroll">
          {cookies.length === 0 ? <Empty icon="cookie" title="No cookies received from the server" /> : (
            <table className="data-table">
              <thead><tr><th>Name</th><th>Value</th><th>Domain</th><th>Path</th><th>Expires</th><th>HttpOnly</th><th>Secure</th></tr></thead>
              <tbody>
                {cookies.map((c: any, i) => (
                  <tr key={i}>
                    <td className="mono">{c.name}</td><td className="mono selectable">{c.value}</td><td>{c.domain ?? ""}</td><td>{c.path ?? ""}</td>
                    <td>{c.expires ?? (c["max-age"] ? `max-age=${c["max-age"]}` : "Session")}</td><td>{String(c.httpOnly)}</td><td>{String(c.secure)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === "tests" && (
        <div className="response-scroll">
          {tests.length === 0 ? (
            <Empty icon="check" title="No tests for this request">Write tests in the Scripts → Post-response tab using <code>pm.test()</code>.</Empty>
          ) : (
            <>
              <div className="seg test-filter">
                {(["all", "passed", "skipped", "failed"] as const).map((f) => (
                  <button key={f} className={`seg-btn ${testFilter === f ? "active" : ""}`} onClick={() => setTestFilter(f)}>
                    {f[0].toUpperCase() + f.slice(1)}
                  </button>
                ))}
                <span className="muted" style={{ marginLeft: 12 }}>{passed} passed, {failed} failed</span>
              </div>
              <div className="test-list">
                {tests
                  .filter((t) => testFilter === "all" || (testFilter === "passed" ? t.passed && !t.skipped : testFilter === "failed" ? !t.passed : t.skipped))
                  .map((t, i) => (
                    <div key={i} className="test-row">
                      <span className={`test-badge ${t.skipped ? "skip" : t.passed ? "pass" : "fail"}`}>{t.skipped ? "SKIPPED" : t.passed ? "PASS" : "FAIL"}</span>
                      <span className="test-name">{t.name}</span>
                      {t.error && <span className="test-error">| {t.error}</span>}
                    </div>
                  ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function JsonTable({ data }: { data: TableData }) {
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null);
  const rows = useMemo(() => {
    if (!sort) return data.rows;
    const cmp = (a: unknown, b: unknown) =>
      typeof a === "number" && typeof b === "number" ? a - b : cellText(a).localeCompare(cellText(b), undefined, { numeric: true });
    return [...data.rows].sort((x, y) => cmp(x[sort.col], y[sort.col]) * sort.dir);
  }, [data, sort]);
  const shown = rows.slice(0, 2000);
  return (
    <div className="json-table-wrap">
      <table className="data-table json-table">
        <thead>
          <tr>
            <th className="json-table-idx">#</th>
            {data.columns.map((c, i) => (
              <th key={c} onClick={() => setSort((s) => (s?.col === i ? (s.dir === 1 ? { col: i, dir: -1 } : null) : { col: i, dir: 1 }))}>
                {c}{sort?.col === i ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((r, i) => (
            <tr key={i}>
              <td className="json-table-idx">{i + 1}</td>
              {r.map((v, j) => <td key={j} className={`mono selectable json-cell-${v === null ? "null" : typeof v}`}>{cellText(v)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > shown.length && <div className="muted pad">Showing the first {shown.length} of {rows.length} rows. Copy as CSV to get all of them.</div>}
    </div>
  );
}
