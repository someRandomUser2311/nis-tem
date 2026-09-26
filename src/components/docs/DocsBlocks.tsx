// React renderers for the docs model (lib/docs/model.ts): Markdown with Mermaid, schema and
// parameter tables, and one endpoint's documentation.
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DocsEndpoint, DocsExample, DocsParam } from "../../lib/docs/model";
import { renderDocsMarkdown } from "../../lib/docs/markdown";
import type { SchemaRow } from "../../lib/docs/schema";
import { methodColor, statusColor } from "../../lib/utils";
import { useStore } from "../../store";
import { Icon, IconButton } from "../ui";

let mermaidSeq = 0;
/** Render `<pre class="mermaid">` blocks inside `root` (Mermaid is loaded on first use). */
async function renderMermaid(root: HTMLElement, dark: boolean) {
  const blocks = [...root.querySelectorAll<HTMLElement>("pre.mermaid:not([data-done])")];
  if (!blocks.length) return;
  const { default: mermaid } = await import("mermaid");
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "default", fontFamily: "inherit" });
  for (const el of blocks) {
    const src = el.textContent ?? "";
    el.dataset.done = "1";
    try {
      const { svg } = await mermaid.render(`lp-mermaid-${++mermaidSeq}`, src);
      const div = document.createElement("div");
      div.className = "mermaid-diagram";
      div.innerHTML = svg;
      el.replaceWith(div);
    } catch (e: any) {
      el.classList.add("mermaid-error");
      el.title = `Diagram error: ${e?.message ?? e}`;
    }
  }
}

export function DocsMarkdown({ source, anchors, onNavigate, className = "" }: {
  source: string; anchors?: Record<string, string>; onNavigate?: (anchor: string) => void; className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const dark = useStore((s) => s.settings.mode) !== "light";
  const html = useMemo(() => renderDocsMarkdown(source, anchors ? { resolveRequest: (id) => anchors[id] } : {}), [source, anchors]);
  useEffect(() => { if (ref.current && html.includes('class="mermaid"')) renderMermaid(ref.current, dark); }, [html, dark]);
  if (!html) return null;
  return (
    <div
      ref={ref}
      className={`markdown-body docs-md selectable ${className}`}
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest("a");
        if (!a) return;
        e.preventDefault();
        const href = a.getAttribute("href") ?? "";
        if (href.startsWith("#") && onNavigate) onNavigate(href.slice(1));
        else if (/^(https?:|mailto:)/i.test(href)) openUrl(href).catch(() => {});
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export function SchemaTable({ rows }: { rows: SchemaRow[] }) {
  if (!rows.length) return null;
  return (
    <table className="docs-table">
      <thead><tr><th>Field</th><th>Type</th><th>Description</th></tr></thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={`${r.path}-${i}`} className={r.deprecated ? "deprecated" : ""}>
            <td>
              <span className="docs-field" style={{ paddingLeft: r.depth * 14 }}>
                {r.variant && <span className="docs-variant">{r.variant}</span>}
                <code>{r.name}</code>{r.required && <span className="docs-req" title="Required">*</span>}
              </span>
            </td>
            <td><span className="docs-type">{r.type}{r.format ? ` · ${r.format}` : ""}</span></td>
            <td>
              {r.description}
              {r.enum && <div className="docs-enum">One of: {r.enum.map((v, j) => <code key={j}>{JSON.stringify(v)}</code>)}</div>}
              {r.deprecated && <span className="docs-badge deprecated">deprecated</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ParamTable({ title, params }: { title: string; params: DocsParam[] }) {
  if (!params.length) return null;
  return (
    <div className="docs-block">
      {title && <h4>{title}</h4>}
      <table className="docs-table">
        <thead><tr><th>Name</th><th>Type</th><th>Description</th></tr></thead>
        <tbody>
          {params.map((p, i) => (
            <tr key={`${p.name}-${i}`} className={p.deprecated ? "deprecated" : ""}>
              <td><code>{p.name}</code>{p.required && <span className="docs-req" title="Required">*</span>}</td>
              <td><span className="docs-type">{p.type ?? "string"}{p.format ? ` · ${p.format}` : ""}</span></td>
              <td>
                {p.description}
                {p.enum?.length ? <div className="docs-enum">One of: {p.enum.map((v) => <code key={v}>{v}</code>)}</div> : null}
                {(p.default || p.example || p.value) && (
                  <div className="docs-enum">
                    {p.default ? <>Default <code>{p.default}</code> </> : null}
                    {p.example || p.value ? <>Example <code>{p.example || p.value}</code></> : null}
                  </div>
                )}
                {p.deprecated && <span className="docs-badge deprecated">deprecated</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function MethodPill({ method }: { method: string }) {
  return <span className="docs-method" style={{ color: methodColor(method), borderColor: methodColor(method) }}>{method}</span>;
}

function Examples({ examples }: { examples: DocsExample[] }) {
  const [i, setI] = useState(0);
  const ex = examples[Math.min(i, examples.length - 1)];
  if (!ex) return null;
  return (
    <div className="docs-examples">
      <div className="docs-example-tabs">
        {examples.map((e, j) => (
          <button key={e.id} className={`docs-example-tab ${j === i ? "active" : ""}`} onClick={() => setI(j)} title={e.name}>
            <span style={{ color: statusColor(e.status) }}>{e.status}</span> {e.name}
          </button>
        ))}
      </div>
      {ex.description && <DocsMarkdown source={ex.description} className="docs-example-desc" />}
      {ex.body ? <pre className="docs-code">{ex.body}</pre> : <div className="muted docs-empty">No body</div>}
      {ex.schemaRows.length > 0 && <SchemaTable rows={ex.schemaRows} />}
    </div>
  );
}

export function CodeSamples({ ep, lang, onLang }: { ep: DocsEndpoint; lang: string; onLang: (l: string) => void }) {
  const sample = ep.samples.find((s) => s.lang === lang) ?? ep.samples[0];
  if (!sample) return <div className="docs-samples muted">{ep.protocol === "http" ? "No code samples." : `Connect with a ${ep.protocol === "ws" ? "WebSocket" : "Server-Sent Events"} client to the URL above.`}</div>;
  return (
    <div className="docs-samples">
      <div className="docs-samples-head">
        <select className="select select-sm" value={sample.lang} onChange={(e) => onLang(e.target.value)}>
          {ep.samples.map((s) => <option key={s.lang} value={s.lang}>{s.label}</option>)}
        </select>
        <IconButton icon="copy" size={12} title="Copy" onClick={() => navigator.clipboard.writeText(sample.code)} />
      </div>
      <pre className="docs-code">{sample.code}</pre>
    </div>
  );
}

/** One endpoint: documentation on the left, code samples on the right. */
export function EndpointDoc({ ep, anchors, lang, onLang, onNavigate, description, actions }: {
  ep: DocsEndpoint; anchors: Record<string, string>; lang: string; onLang: (l: string) => void; onNavigate: (a: string) => void;
  /** Replaces the rendered description (the Docs view passes an editor in edit mode). */
  description?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  const b = ep.body;
  return (
    <section id={ep.anchor} data-anchor={ep.anchor} className={`docs-endpoint ${ep.status === "deprecated" ? "is-deprecated" : ""}`}>
      <div className="docs-endpoint-main">
        <div className="docs-endpoint-head">
          <MethodPill method={ep.method} />
          <h3>{ep.name}</h3>
          {ep.status && ep.status !== "stable" && <span className={`docs-badge ${ep.status}`}>{ep.status}</span>}
          {ep.tags.map((t) => <span key={t} className="docs-tag">{t}</span>)}
          <div className="flex-1" />
          {actions}
        </div>
        <div className="docs-url mono">{ep.url}</div>
        {description ?? (ep.description ? <DocsMarkdown source={ep.description} anchors={anchors} onNavigate={onNavigate} /> : null)}
        {ep.auth && <div className="docs-auth"><Icon name="lock" size={11} /> {ep.auth.replace(/`/g, "")}</div>}
        <ParamTable title="Path variables" params={ep.pathVariables} />
        <ParamTable title="Query parameters" params={ep.query} />
        <ParamTable title="Headers" params={ep.headers} />
        {b && (
          <div className="docs-block">
            <h4>Request body {b.mode !== "raw" && <span className="muted">({b.mode === "formdata" ? "multipart/form-data" : b.mode === "urlencoded" ? "x-www-form-urlencoded" : b.mode})</span>}</h4>
            {b.fields && <ParamTable title="" params={b.fields} />}
            <SchemaTable rows={b.schemaRows} />
            {b.example && <pre className="docs-code">{b.example}</pre>}
          </div>
        )}
        {(ep.responseSchemaRows.length > 0 || ep.examples.length > 0) && (
          <div className="docs-block">
            <h4>Responses</h4>
            <SchemaTable rows={ep.responseSchemaRows} />
            <Examples examples={ep.examples} />
          </div>
        )}
      </div>
      <aside className="docs-endpoint-side"><CodeSamples ep={ep} lang={lang} onLang={onLang} /></aside>
    </section>
  );
}
