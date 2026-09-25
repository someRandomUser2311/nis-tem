// A saved example response: editable status, headers and body. Mock servers serve these.
import { useMemo, useState } from "react";
import type { KV, Tab } from "../types";
import { exampleRoute } from "../lib/mock";
import { findItem, getHeader, methodColor, statusColor, tryPrettyJson } from "../lib/utils";
import { confirmDialog, deleteExample, duplicateExample, openRequest, updateExample, useStore } from "../store";
import { CodeEditor, type CodeLang } from "./CodeEditor";
import { KeyValueTable } from "./KeyValueTable";
import { EditableText, Empty, Icon, IconButton, menuFromEvent, Tabs } from "./ui";

function langFor(contentType: string, body: string): CodeLang {
  const ct = contentType.toLowerCase();
  if (ct.includes("json") || tryPrettyJson(body) !== null) return "json";
  if (ct.includes("html")) return "html";
  if (ct.includes("xml")) return "xml";
  return "text";
}

export function ExampleView({ tab }: { tab: Tab }) {
  const collection = useStore((s) => s.collections.find((c) => c.id === tab.collectionId));
  const req = collection && tab.requestId ? findItem(collection.items, tab.requestId) : undefined;
  const ex = req?.type === "request" ? req.examples?.find((e) => e.id === tab.exampleId) : undefined;
  const [sub, setSub] = useState<"body" | "headers">("body");

  const headerRows: KV[] = useMemo(
    () => (ex?.headers ?? []).map((h, i) => ({ id: h.id ?? `${ex!.id}-h${i}`, key: h.key, value: h.value, enabled: h.enabled ?? true })),
    [ex],
  );
  if (!collection || !req || req.type !== "request" || !ex) return <Empty icon="example" title="This example no longer exists" />;
  const set = (patch: Parameters<typeof updateExample>[3]) => updateExample(collection.id, req.id, ex.id, patch);
  const route = exampleRoute(req, ex);
  const ct = getHeader(ex.headers, "content-type") ?? "";
  const method = ex.request?.method ?? req.method;

  return (
    <div className="container-editor example-view">
      <div className="container-header">
        <Icon name="example" size={18} />
        <button className="crumb" onClick={() => openRequest(collection.id, req.id)} title="Open the request">{req.name}</button>
        <span className="crumb-sep">/</span>
        <EditableText className="container-title" value={ex.name} onChange={(name) => set({ name })} />
        <div className="flex-1" />
        <IconButton
          icon="dots"
          title="More"
          onClick={(e) => menuFromEvent(e, [
            { label: "Duplicate", onClick: () => duplicateExample(collection.id, req.id, ex.id) },
            { divider: true },
            { label: "Delete", danger: true, onClick: async () => { if (await confirmDialog("Delete example", `Delete "${ex.name}"?`, { confirmText: "Delete", danger: true })) deleteExample(collection.id, req.id, ex.id); } },
          ])}
        />
      </div>
      <div className="example-request">
        <select className="select method-mini" value={method} style={{ color: methodColor(method) }} onChange={(e) => set({ request: { method: e.target.value, url: ex.request?.url ?? req.url } })}>
          {["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <input className="input mono" value={ex.request?.url ?? req.url} onChange={(e) => set({ request: { method, url: e.target.value } })} placeholder="Request URL this example answers" />
        <label className="example-status">
          <span className="muted">Status</span>
          <input className="input input-sm mono" type="number" min={100} max={599} value={ex.status} style={{ color: statusColor(ex.status) }} onChange={(e) => set({ status: Number(e.target.value) || 200 })} />
        </label>
      </div>
      <div className="example-mock-hint muted">
        Served by mock servers at <code>{route.method} {route.path}{route.query.length ? `?${route.query.map((q) => `${q.key}=${q.value}`).join("&")}` : ""}</code>
        {" "}· choose it explicitly with the header <code>x-mock-response-name: {ex.name}</code>
      </div>
      <Tabs value={sub} onChange={setSub} tabs={[{ id: "body", label: "Body" }, { id: "headers", label: "Headers", badge: ex.headers.length || undefined }]} />
      <div className="container-content">
        {sub === "body" && (
          ex.bodyBase64
            ? <Empty icon="file" title="Binary example">Mock servers return the saved bytes as they are.</Empty>
            : (
              <div className="example-body">
                <div className="body-toolbar">
                  <button className="link-btn" disabled={tryPrettyJson(ex.body) === null} onClick={() => set({ body: tryPrettyJson(ex.body) ?? ex.body })}>Beautify</button>
                </div>
                <CodeEditor value={ex.body} onChange={(body) => set({ body })} language={langFor(ct, ex.body)} wrap />
              </div>
            )
        )}
        {sub === "headers" && (
          <KeyValueTable rows={headerRows} onChange={(rows) => set({ headers: rows.map(({ id, key, value, enabled }) => ({ id, key, value, enabled })) })} />
        )}
      </div>
    </div>
  );
}
