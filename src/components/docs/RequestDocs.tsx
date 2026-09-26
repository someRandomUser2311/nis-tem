// Request → Docs: description, status/tags/visibility, and body/response schemas.
import { useState } from "react";
import type { DocStatus, KV, RequestItem, Tab } from "../../types";
import { inferSchema, inferSchemaText, schemaRows } from "../../lib/docs/schema";
import { confirmDialog, openDocs } from "../../store";
import { CodeEditor } from "../CodeEditor";
import { MarkdownField } from "../Markdown";
import { Icon, Toggle } from "../ui";
import { SchemaTable } from "./DocsBlocks";

const STATUSES: { id: DocStatus | ""; label: string }[] = [
  { id: "", label: "—" }, { id: "stable", label: "Stable" }, { id: "beta", label: "Beta" }, { id: "deprecated", label: "Deprecated" },
];

/** Object schema for form fields, using their docs details. */
function formSchema(rows: KV[]) {
  const fields = rows.filter((r) => r.enabled && r.key);
  const properties = Object.fromEntries(fields.map((f) => [f.key, {
    type: f.type === "file" ? "string" : f.doc?.type ?? "string",
    ...(f.type === "file" ? { format: "binary" } : f.doc?.format ? { format: f.doc.format } : {}),
    ...(f.description ? { description: f.description } : {}),
    ...(f.doc?.enum?.length ? { enum: f.doc.enum } : {}),
  }]));
  const required = fields.filter((f) => f.doc?.required).map((f) => f.key);
  return JSON.stringify({ type: "object", properties, ...(required.length ? { required } : {}) }, null, 2);
}

function SchemaEditor({ title, help, value, onChange, generators }: {
  title: string; help: string; value: string; onChange: (v: string) => void; generators: { label: string; run: () => string | null; disabled?: boolean }[];
}) {
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  let rows: ReturnType<typeof schemaRows> = [];
  let invalid = false;
  if (value.trim()) { try { JSON.parse(value); rows = schemaRows(value); } catch { invalid = true; } }
  return (
    <section className="rdocs-section">
      <div className="rdocs-head">
        <div><div className="setting-title">{title}</div><div className="setting-desc">{help}</div></div>
        <div className="rdocs-actions">
          {generators.map((g) => (
            <button key={g.label} className="btn btn-sm" disabled={g.disabled} onClick={async () => {
              let out: string | null;
              try { out = g.run(); } catch (e: any) { setError(`Couldn't generate a schema: ${e?.message ?? e}`); return; }
              if (out === null) return;
              setError(null);
              if (value.trim() && value.trim() !== out.trim() && !(await confirmDialog("Replace schema", `Replace the current ${title.toLowerCase()} with the generated one?`, { confirmText: "Replace" }))) return;
              onChange(out);
            }}><Icon name="bolt" size={11} /> {g.label}</button>
          ))}
          <div className="seg">
            <button className={`seg-btn ${!preview ? "active" : ""}`} onClick={() => setPreview(false)}>JSON</button>
            <button className={`seg-btn ${preview ? "active" : ""}`} onClick={() => setPreview(true)} disabled={!rows.length}>Fields</button>
          </div>
        </div>
      </div>
      {error && <div className="err-text rdocs-error">{error}</div>}
      {invalid && <div className="err-text rdocs-error">Not valid JSON.</div>}
      {preview && rows.length ? <SchemaTable rows={rows} /> : (
        <div className="schema-editor">
          <CodeEditor value={value} onChange={onChange} language="json" placeholder={'{ "type": "object", "properties": { "id": { "type": "integer" } } }'} />
        </div>
      )}
    </section>
  );
}

export function RequestDocs({ tab, draft, onChange }: { tab: Tab; draft: RequestItem; onChange: (p: Partial<RequestItem>) => void }) {
  const docs = draft.docs ?? {};
  const setDocs = (patch: Partial<NonNullable<RequestItem["docs"]>>) => {
    const next = { ...docs, ...patch };
    for (const k of Object.keys(next) as (keyof typeof next)[]) if (next[k] === undefined || next[k] === "" || next[k] === false || (Array.isArray(next[k]) && !(next[k] as unknown[]).length)) delete next[k];
    onChange({ docs: Object.keys(next).length ? next : undefined });
  };
  const [tagText, setTagText] = useState((docs.tags ?? []).join(", "));
  const b = draft.body;
  const lastBody = tab.result?.response?.bodyText ?? "";
  const example = (draft.examples ?? []).find((e) => e.default) ?? draft.examples?.[0];
  const collectionId = tab.saved?.collectionId;

  return (
    <div className="rdocs">
      <section className="rdocs-section">
        <div className="rdocs-head">
          <div><div className="setting-title">Description</div><div className="setting-desc">Shown in the docs. Link to another request with <code>[text](#req:&lt;id&gt;)</code>.</div></div>
          <div className="rdocs-actions">
            {tab.saved && (
              <button className="btn btn-sm" title="Copy a Markdown link to this request" onClick={() => navigator.clipboard.writeText(`[${draft.name}](#req:${tab.saved!.itemId})`)}>
                <Icon name="copy" size={11} /> Copy link
              </button>
            )}
            {collectionId && <button className="btn btn-sm" onClick={() => openDocs(collectionId, tab.saved!.itemId)}><Icon name="docs" size={11} /> View in docs</button>}
          </div>
        </div>
        <MarkdownField value={draft.description} onChange={(description) => onChange({ description })} placeholder={"What this endpoint does, when to use it, error cases…\n\n> [!NOTE]\n> Callouts, tables, code blocks and ```mermaid diagrams are supported."} />
      </section>

      <section className="rdocs-section rdocs-meta">
        <label>Status
          <select className="select select-sm" value={docs.status ?? ""} onChange={(e) => setDocs({ status: (e.target.value || undefined) as DocStatus | undefined })}>
            {STATUSES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
        <label className="grow">Tags
          <input className="input input-sm" value={tagText} placeholder="Comma-separated, e.g. users, admin"
            onChange={(e) => { setTagText(e.target.value); setDocs({ tags: e.target.value.split(",").map((t) => t.trim()).filter(Boolean) }); }} />
        </label>
        <Toggle checked={!!docs.hidden} onChange={(hidden) => setDocs({ hidden })} label="Hide from docs" />
      </section>
      <p className="help">Document individual query params, path variables, headers and form fields with the <Icon name="docs" size={11} /> button on each row.</p>

      {(draft.protocol ?? "http") === "http" && (
        <>
          <SchemaEditor
            title="Request body schema"
            help="JSON Schema of the body; shown as a field table in the docs."
            value={docs.bodySchema ?? ""}
            onChange={(bodySchema) => setDocs({ bodySchema })}
            generators={[{
              label: "Generate from body",
              disabled: !((b.mode === "raw" && b.rawLanguage === "json" && b.raw.trim()) || b.mode === "urlencoded" || b.mode === "formdata" || (b.mode === "graphql" && b.graphql.variables.trim())),
              run: () => b.mode === "raw" ? inferSchemaText(b.raw)
                : b.mode === "urlencoded" ? formSchema(b.urlencoded)
                : b.mode === "formdata" ? formSchema(b.formdata)
                : JSON.stringify({ type: "object", properties: { query: { type: "string" }, variables: inferSchema(JSON.parse(b.graphql.variables)) }, required: ["query"] }, null, 2),
            }]}
          />
          <SchemaEditor
            title="Response schema"
            help="Shown in the docs and checked against every response (the result appears in Test Results and collection runs)."
            value={draft.responseSchema ?? ""}
            onChange={(responseSchema) => onChange({ responseSchema: responseSchema || undefined })}
            generators={[
              { label: "From last response", disabled: !lastBody.trim(), run: () => inferSchemaText(lastBody) },
              { label: "From example", disabled: !example?.body.trim(), run: () => inferSchemaText(example!.body) },
            ]}
          />
        </>
      )}
    </div>
  );
}
