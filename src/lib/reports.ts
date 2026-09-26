// Collection-run reports: JSON, JUnit XML (for CI) and a self-contained HTML page.
// Used by the runner view's "Export report" and by the CLI's reporters.
import type { RunEntry } from "./runner";

export interface RunReport {
  collection: string;
  startedAt: number;
  finishedAt: number;
  entries: RunEntry[];
}

export function summarize(r: RunReport) {
  const tests = r.entries.flatMap((e) => e.tests);
  const timed = r.entries.filter((e) => e.timeMs !== undefined);
  return {
    requests: r.entries.length,
    failedRequests: r.entries.filter((e) => e.error).length,
    tests: tests.length,
    passed: tests.filter((t) => t.passed && !t.skipped).length,
    failed: tests.filter((t) => !t.passed).length,
    skipped: tests.filter((t) => t.skipped).length,
    avgResponseTimeMs: timed.length ? Math.round(timed.reduce((a, e) => a + (e.timeMs ?? 0), 0) / timed.length) : 0,
    durationMs: r.finishedAt - r.startedAt,
  };
}

export const reportFailed = (r: RunReport) => { const s = summarize(r); return s.failed > 0 || s.failedRequests > 0; };

export function toJsonReport(r: RunReport): string {
  return JSON.stringify({
    collection: r.collection,
    startedAt: new Date(r.startedAt).toISOString(),
    finishedAt: new Date(r.finishedAt).toISOString(),
    totals: summarize(r),
    results: r.entries.map(({ response: _response, ...e }) => e),
  }, null, 2);
}

const xml = (s: string) => s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!)
  // Control characters aren't allowed in XML 1.0.
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");

/** One <testsuite> per request execution; a request error is a failing test of its own. */
export function toJUnit(r: RunReport): string {
  const s = summarize(r);
  const suites = r.entries.map((e, i) => {
    const cases = e.tests.map((t) => {
      const body = t.skipped ? "<skipped/>" : t.passed ? "" : `<failure type="AssertionFailure" message="${xml(t.error ?? "failed")}">${xml(t.error ?? "")}</failure>`;
      return `      <testcase name="${xml(t.name)}" classname="${xml(e.name)}" time="0">${body}</testcase>`;
    });
    if (e.error) cases.push(`      <testcase name="Request" classname="${xml(e.name)}" time="${((e.timeMs ?? 0) / 1000).toFixed(3)}"><error type="RequestError" message="${xml(e.error)}">${xml(e.error)}</error></testcase>`);
    const failures = e.tests.filter((t) => !t.passed).length;
    return `    <testsuite name="${xml(e.name)}${e.iteration ? ` (iteration ${e.iteration + 1})` : ""}" id="${i}" tests="${cases.length}" failures="${failures}" errors="${e.error ? 1 : 0}" skipped="${e.tests.filter((t) => t.skipped).length}" time="${((e.timeMs ?? 0) / 1000).toFixed(3)}" timestamp="${new Date(r.startedAt).toISOString()}">
      <properties><property name="method" value="${xml(e.method)}"/><property name="url" value="${xml(e.url)}"/>${e.status ? `<property name="status" value="${e.status}"/>` : ""}</properties>
${cases.join("\n")}
    </testsuite>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="${xml(r.collection)}" tests="${s.tests + s.failedRequests}" failures="${s.failed}" errors="${s.failedRequests}" time="${(s.durationMs / 1000).toFixed(3)}">
${suites.join("\n")}
</testsuites>
`;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function toHtmlReport(r: RunReport): string {
  const s = summarize(r);
  const rows = r.entries.map((e) => {
    const failed = !!e.error || e.tests.some((t) => !t.passed);
    const tests = e.tests.map((t) => `<li class="${t.skipped ? "skip" : t.passed ? "pass" : "fail"}">${t.skipped ? "○" : t.passed ? "✓" : "✗"} ${esc(t.name)}${t.error ? ` <span class="err">${esc(t.error)}</span>` : ""}</li>`).join("");
    return `<tr class="${failed ? "failed" : ""}"><td>${e.iteration + 1}</td><td><b>${esc(e.name)}</b><div class="url">${esc(e.method)} ${esc(e.url)}</div>${tests ? `<ul>${tests}</ul>` : ""}${e.error ? `<div class="err">${esc(e.error)}</div>` : ""}</td><td class="num">${e.status ?? "—"}</td><td class="num">${e.timeMs !== undefined ? Math.round(e.timeMs) + " ms" : "—"}</td></tr>`;
  }).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(r.collection)} — run report</title>
<style>
:root{--bg:#fff;--fg:#1d1d1f;--muted:#6b6b6b;--line:#e5e5e5;--ok:#0f8a45;--bad:#c0212f;--card:#f6f6f7}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#eee;--muted:#999;--line:#2a2a2a;--ok:#3fbf74;--bad:#f05252;--card:#1d1d1d}}
body{margin:0;padding:32px;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;background:var(--bg);color:var(--fg)}
h1{margin:0 0 4px}.muted{color:var(--muted)}.cards{display:flex;gap:12px;flex-wrap:wrap;margin:20px 0}
.card{background:var(--card);border-radius:10px;padding:12px 18px;min-width:120px}.card b{display:block;font-size:22px}
.ok{color:var(--ok)}.bad{color:var(--bad)}table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600}.num{text-align:right;white-space:nowrap}.url{font:12px ui-monospace,Menlo,monospace;color:var(--muted);word-break:break-all}
ul{margin:6px 0 0;padding-left:0;list-style:none}li.pass{color:var(--ok)}li.fail{color:var(--bad)}li.skip{color:var(--muted)}
.err{color:var(--bad);font:12px ui-monospace,Menlo,monospace}tr.failed td:first-child{box-shadow:inset 3px 0 var(--bad)}
</style></head><body>
<h1>${esc(r.collection)}</h1>
<div class="muted">Run ${new Date(r.startedAt).toLocaleString()} · ${(s.durationMs / 1000).toFixed(1)} s · generated by Localpost</div>
<div class="cards">
<div class="card"><b>${s.requests}</b>requests</div>
<div class="card"><b class="${s.failed ? "bad" : "ok"}">${s.passed}/${s.tests - s.skipped}</b>tests passed</div>
<div class="card"><b class="${s.failed ? "bad" : ""}">${s.failed}</b>failed</div>
<div class="card"><b class="${s.failedRequests ? "bad" : ""}">${s.failedRequests}</b>request errors</div>
<div class="card"><b>${s.avgResponseTimeMs} ms</b>avg response</div>
</div>
<table><thead><tr><th>#</th><th>Request</th><th class="num">Status</th><th class="num">Time</th></tr></thead><tbody>
${rows}
</tbody></table></body></html>`;
}
