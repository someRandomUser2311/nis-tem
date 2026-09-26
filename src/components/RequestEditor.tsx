import { useMemo, useRef, useState } from "react";
import { METHODS, type Protocol, type RequestItem, type Tab } from "../types";
import { effectiveAuth } from "../lib/engine";
import { importCurl, isCurl } from "../lib/importexport";
import {
  buildUrl, findPath, getHeader, methodColor, paramsFromUrl, parseQuery, syncPathVariables,
} from "../lib/utils";
import {
  applyExampleCapture, cancelTab, disconnectLive, fetchGraphqlSchema, openLoadTest, openModal, openSpecialTab, primaryAction, prompt, saveExample, saveTab, updateDraft, updateItem, useStore,
} from "../store";
import { AuthEditor, authLabel } from "./AuthEditor";
import { BodyEditor } from "./BodyEditor";
import { KeyValueTable } from "./KeyValueTable";
import { RequestDocs } from "./docs/RequestDocs";
import { ResponseViewer } from "./ResponseViewer";
import { ScriptEditor } from "./ScriptEditor";
import { EditableText, Icon, menuFromEvent, Splitter, Tabs } from "./ui";
import { VarInput } from "./VarInput";
import { defaultWs, LiveViewer, WsComposer } from "./LiveViews";

type SubTab = "message" | "params" | "auth" | "headers" | "body" | "scripts" | "docs" | "settings";

const PROTOCOLS: { id: Protocol; label: string }[] = [
  { id: "http", label: "HTTP" },
  { id: "ws", label: "WebSocket" },
  { id: "sse", label: "Server-Sent Events" },
];

export function RequestEditor({ tab }: { tab: Tab }) {
  const draft = tab.draft!;
  const protocol = draft.protocol ?? "http";
  const [sub, setSub] = useState<SubTab>(protocol === "ws" ? "message" : draft.body.mode !== "none" ? "body" : "params");
  const live = tab.live;
  const liveActive = !!live && live.status !== "closed";
  const [split, setSplit] = useState(() => Number(localStorage.getItem("lp.split") ?? 0.45));
  const containerRef = useRef<HTMLDivElement>(null);
  const splitStart = useRef(split);

  const collection = useStore((s) => s.collections.find((c) => c.id === tab.saved?.collectionId));
  const layout = useStore((s) => s.settings.layout ?? "vertical");
  const folders = useMemo(() => (collection && tab.saved ? findPath(collection.items, tab.saved.itemId) ?? [] : []), [collection, tab.saved]);

  const set = (patch: Partial<RequestItem>) => updateDraft(tab.id, patch);

  const onUrlChange = (url: string) => {
    set({ url, params: paramsFromUrl(url, draft.params), pathVariables: syncPathVariables(url, draft.pathVariables) });
  };
  const onParamsChange = (params: typeof draft.params) => {
    const { base, hash } = parseQuery(draft.url);
    set({ params, url: buildUrl(base, params, hash) });
  };
  const onPaste = (text: string) => {
    if (!isCurl(text)) return false;
    try {
      const r = importCurl(text);
      set({ method: r.method, url: r.url, params: r.params, headers: r.headers, body: r.body, auth: r.auth, pathVariables: syncPathVariables(r.url) });
      return true;
    } catch {
      return false;
    }
  };

  // Inherited auth description
  let inheritedFrom: string | undefined;
  if (draft.auth.type === "inherit" && collection) {
    const eff = effectiveAuth(draft, folders, collection);
    const owner = [...folders].reverse().find((f) => f.auth.type !== "inherit");
    inheritedFrom = `${authLabel(eff.type)} from ${owner ? `folder "${owner.name}"` : `collection "${collection.name}"`}`;
  }

  // Auto-generated headers (shown, read-only)
  const autoHeaders = useMemo(() => {
    const rows: { key: string; value: string; note?: string }[] = [
      { key: "User-Agent", value: "Localpost/0.1.0", note: "Added by Localpost" },
      { key: "Accept", value: "*/*", note: "Added by Localpost" },
      { key: "Accept-Encoding", value: "gzip, deflate, br, zstd", note: "Added by Localpost" },
      { key: "Host", value: "<calculated when request is sent>", note: "Added by Localpost" },
    ];
    const b = draft.body;
    const userCt = getHeader(draft.headers.filter((h) => h.enabled), "content-type");
    if (!userCt) {
      const ct = b.mode === "raw" ? { json: "application/json", text: "text/plain", xml: "application/xml", html: "text/html", javascript: "application/javascript" }[b.rawLanguage]
        : b.mode === "graphql" ? "application/json" : b.mode === "urlencoded" ? "application/x-www-form-urlencoded"
        : b.mode === "formdata" ? "multipart/form-data; boundary=<calculated when request is sent>" : undefined;
      if (ct) rows.push({ key: "Content-Type", value: ct, note: "Based on body type" });
    }
    if (b.mode !== "none") rows.push({ key: "Content-Length", value: "<calculated when request is sent>", note: "Added by Localpost" });
    const eff = effectiveAuth(draft, folders, collection);
    if (eff.type === "basic" || eff.type === "bearer") rows.push({ key: "Authorization", value: `${eff.type === "basic" ? "Basic" : eff.bearer.prefix || "Bearer"} <from auth>`, note: "From Authorization tab" });
    if (eff.type === "apikey" && eff.apikey.in === "header" && eff.apikey.key) rows.push({ key: eff.apikey.key, value: "<from auth>", note: "From Authorization tab" });
    if (eff.type === "oauth2" && eff.oauth2?.addTo !== "query") rows.push({ key: "Authorization", value: eff.oauth2?.token ? `${eff.oauth2.headerPrefix ?? "Bearer"} <access token>` : "<get a token first>", note: "OAuth 2.0" });
    if (eff.type === "digest") rows.push({ key: "Authorization", value: "Digest <computed after the server's challenge>", note: "Digest Auth" });
    if (eff.type === "awsv4") rows.push({ key: "Authorization", value: "AWS4-HMAC-SHA256 <signature>", note: "AWS Signature" }, { key: "X-Amz-Date", value: "<request time>", note: "AWS Signature" });
    if (eff.type === "hawk") rows.push({ key: "Authorization", value: "Hawk <mac>", note: "Hawk" });
    return rows;
  }, [draft, folders, collection]);

  const enabledCount = (l: { enabled: boolean; key: string }[]) => l.filter((x) => x.enabled && x.key).length;
  const scriptCount = (draft.preRequestScript.trim() ? 1 : 0) + (draft.testScript.trim() ? 1 : 0);
  const customMethod = !METHODS.includes(draft.method as any);

  const breadcrumb = (
    <div className="breadcrumb">
      {collection ? (
        <>
          <button className="crumb" onClick={() => openSpecialTab("collection", { collectionId: collection.id })}>{collection.name}</button>
          {folders.map((f) => (
            <span key={f.id} className="crumb-wrap">
              <span className="crumb-sep">/</span>
              <button className="crumb" onClick={() => openSpecialTab("folder", { collectionId: collection.id, folderId: f.id })}>{f.name}</button>
            </span>
          ))}
          <span className="crumb-sep">/</span>
        </>
      ) : null}
      <EditableText
        className="crumb-current"
        value={draft.name}
        onChange={(name) => {
          // Saved requests are renamed in place (and the tab synced) without marking the tab dirty.
          if (tab.saved) updateItem(tab.saved.collectionId, tab.saved.itemId, { name });
          else set({ name });
        }}
      />
    </div>
  );

  return (
    <div className="request-editor">
      <div className="request-top">
        {breadcrumb}
        <div className="flex-1" />
        <select
          className="select select-sm protocol-select"
          value={protocol}
          title="Protocol"
          disabled={liveActive}
          onChange={(e) => {
            const p = e.target.value as Protocol;
            set({ protocol: p, ...(p === "ws" && !draft.ws ? { ws: defaultWs() } : {}) });
            setSub(p === "ws" ? "message" : sub === "message" ? "params" : sub);
          }}
        >
          {PROTOCOLS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
        <div className="split-btn">
          <button className="btn" onClick={() => saveTab(tab.id)} title="Save (⌘S)">
            <Icon name="save" /> Save
          </button>
          <button
            className="btn split-caret"
            onClick={(e) => menuFromEvent(e, [
              { label: "Save As…", onClick: () => openModal({ kind: "save", tabId: tab.id }) },
              { divider: true },
              { label: "Load test this request…", disabled: protocol !== "http", onClick: () => openLoadTest(tab.id) },
            ])}
          >
            <Icon name="chevronDown" size={12} />
          </button>
        </div>
        <button className="btn" disabled={protocol === "ws"} onClick={() => openModal({ kind: "codegen", tabId: tab.id })} title={protocol === "ws" ? "Code snippets are available for HTTP requests" : "Generate code snippet"}>
          <Icon name="code" />
        </button>
      </div>

      <div className="url-bar">
        {protocol === "ws" ? <div className="method-select protocol-badge">WS</div> : (
        <div className="method-select" style={{ color: methodColor(draft.method) }}>
          <select
            value={customMethod ? "__custom" : draft.method}
            onChange={async (e) => {
              if (e.target.value === "__custom") {
                const m = await prompt("Custom HTTP method", customMethod ? draft.method : "PROPFIND", "Method");
                if (m?.trim()) set({ method: m.trim().toUpperCase() });
              } else set({ method: e.target.value });
            }}
            style={{ color: methodColor(draft.method) }}
          >
            {METHODS.map((m) => <option key={m} value={m} style={{ color: methodColor(m) }}>{m}</option>)}
            {customMethod && <option value="__custom">{draft.method}</option>}
            {!customMethod && <option value="__custom">Custom…</option>}
          </select>
          <Icon name="chevronDown" size={12} />
        </div>
        )}
        <div className="url-input">
          <VarInput
            value={draft.url}
            onChange={onUrlChange}
            placeholder={protocol === "ws" ? "wss://example.com/socket" : protocol === "sse" ? "https://example.com/events" : "Enter URL or paste cURL"}
            onEnter={() => primaryAction(tab.id)}
            onPasteText={protocol === "http" ? onPaste : undefined}
          />
        </div>
        {protocol !== "http" ? (
          liveActive
            ? <button className="btn btn-send cancel" onClick={() => disconnectLive(tab.id)}>{protocol === "ws" ? "Disconnect" : "Stop"}</button>
            : <button className="btn btn-send" onClick={() => primaryAction(tab.id)} title="Connect (⌘↵)">Connect</button>
        ) : tab.loading ? (
          <button className="btn btn-send cancel" onClick={() => cancelTab(tab.id)}>Cancel</button>
        ) : (
          <button className="btn btn-send" onClick={() => primaryAction(tab.id)} title="Send (⌘↵)">Send</button>
        )}
      </div>

      <div ref={containerRef} className={`req-res ${layout === "horizontal" ? "horizontal" : "vertical"}`}>
        <div className="req-pane" style={{ flexBasis: `${split * 100}%` }}>
          <Tabs
            value={sub}
            onChange={setSub}
            tabs={[
              ...(protocol === "ws" ? [{ id: "message" as const, label: "Message" }] : []),
              { id: "params", label: "Params", badge: enabledCount(draft.params) || undefined },
              { id: "auth", label: "Authorization", badge: draft.auth.type !== "inherit" && draft.auth.type !== "none" ? "●" : undefined },
              { id: "headers", label: "Headers", badge: enabledCount(draft.headers) || undefined },
              ...(protocol !== "ws" ? [{ id: "body" as const, label: "Body", badge: draft.body.mode !== "none" ? "●" : undefined }] : []),
              ...(protocol === "http" ? [{ id: "scripts" as const, label: "Scripts", badge: scriptCount || undefined }] : []),
              { id: "docs", label: "Docs", badge: draft.description.trim() || draft.docs?.bodySchema || draft.responseSchema?.trim() ? "●" : undefined },
              { id: "settings", label: "Settings" },
            ]}
          />
          <div className="req-content">
            {sub === "message" && protocol === "ws" && <WsComposer tab={tab} />}
            {sub === "params" && (
              <>
                <KeyValueTable title="Query Params" rows={draft.params} onChange={onParamsChange} docs />
                {(draft.pathVariables?.length ?? 0) > 0 && (
                  <KeyValueTable
                    title="Path Variables"
                    rows={draft.pathVariables!}
                    onChange={(pathVariables) => set({ pathVariables: pathVariables.filter((v) => draft.pathVariables!.some((o) => o.key === v.key)) })}
                    allowBulk={false}
                    docs
                  />
                )}
              </>
            )}
            {sub === "auth" && <AuthEditor auth={draft.auth} onChange={(auth) => set({ auth })} inheritedFrom={inheritedFrom} />}
            {sub === "headers" && <KeyValueTable title={protocol === "ws" ? "Handshake headers" : "Headers"} rows={draft.headers} onChange={(headers) => set({ headers })} readonlyRows={protocol === "http" ? autoHeaders : undefined} docs />}
            {sub === "body" && <BodyEditor body={draft.body} onChange={(body) => set({ body })} requestId={draft.id} onFetchSchema={() => fetchGraphqlSchema(tab.id)} />}
            {sub === "scripts" && <ScriptEditor pre={draft.preRequestScript} test={draft.testScript} onChange={set} />}
            {sub === "docs" && <RequestDocs tab={tab} draft={draft} onChange={set} />}
            {sub === "settings" && <RequestSettingsEditor draft={draft} onChange={set} protocol={protocol} />}
          </div>
        </div>
        <Splitter
          direction={layout === "horizontal" ? "horizontal" : "vertical"}
          onDrag={(d) => {
            const el = containerRef.current;
            if (!el) return;
            const size = layout === "horizontal" ? el.clientWidth : el.clientHeight;
            setSplit(Math.min(0.85, Math.max(0.15, splitStart.current + d / size)));
          }}
          onEnd={() => {
            splitStart.current = split;
            localStorage.setItem("lp.split", String(split));
          }}
        />
        <div className="res-pane">
          {protocol !== "http" ? <LiveViewer tab={tab} /> : <ResponseViewer
            result={tab.result} previous={tab.prevResult} loading={tab.loading} onCancel={() => cancelTab(tab.id)}
            onSaveExample={tab.saved ? async () => {
              const res = tab.result?.response;
              if (!res || !tab.saved) return;
              const name = await prompt("Save as example", `${res.status} ${res.statusText}`.trim(), "Example name", "Save");
              if (!name?.trim()) return;
              const ex = saveExample(tab.id, name.trim(), tab.result!);
              if (ex) openSpecialTab("example", { collectionId: tab.saved.collectionId, requestId: tab.saved.itemId, exampleId: ex.id });
            } : undefined}
            onUpdateExample={(() => {
              const res = tab.result?.response;
              const target = res && tab.saved ? (draft.examples ?? []).find((e) => e.status === res.status && e.default) ?? (draft.examples ?? []).find((e) => e.status === res.status) : undefined;
              if (!res || !target || !tab.saved || res.isBinary) return undefined;
              return {
                label: `Update example “${target.name}” with this response`,
                run: () => applyExampleCapture(tab.saved!.collectionId, [{ requestId: tab.saved!.itemId, status: res.status, statusText: res.statusText, headers: res.headers, body: res.bodyText }]),
              };
            })()}
          />}
        </div>
      </div>
    </div>
  );
}

function TriState({ value, onChange }: { value: boolean | undefined; onChange: (v: boolean | undefined) => void }) {
  return (
    <select className="select select-sm" value={value === undefined ? "default" : value ? "on" : "off"}
      onChange={(e) => onChange(e.target.value === "default" ? undefined : e.target.value === "on")}>
      <option value="default">Use global setting</option>
      <option value="on">On</option>
      <option value="off">Off</option>
    </select>
  );
}

function RequestSettingsEditor({ draft, onChange, protocol }: { draft: RequestItem; onChange: (p: Partial<RequestItem>) => void; protocol: Protocol }) {
  const s = draft.settings ?? {};
  const set = (patch: Partial<RequestItem["settings"]>) => onChange({ settings: { ...s, ...patch } });
  return (
    <div className="settings-list">
      {protocol === "ws" && (
        <div className="setting-row">
          <div><div className="setting-title">Subprotocols</div><div className="setting-desc">Sent as <code>Sec-WebSocket-Protocol</code>; comma-separated.</div></div>
          <input className="input" style={{ maxWidth: 280 }} value={draft.ws?.protocols ?? ""} placeholder="e.g. graphql-transport-ws"
            onChange={(e) => onChange({ ws: { ...(draft.ws ?? defaultWs()), protocols: e.target.value } })} />
        </div>
      )}
      {protocol !== "http" && <p className="help">Pre-request and test scripts don't run for {protocol === "ws" ? "WebSocket" : "streaming"} requests; variables and authorization are still applied.</p>}
      {protocol === "http" && (
      <div className="setting-row">
        <div><div className="setting-title">Automatically follow redirects</div><div className="setting-desc">Follow HTTP 3xx responses as redirects.</div></div>
        <TriState value={s.followRedirects} onChange={(v) => set({ followRedirects: v })} />
      </div>
      )}
      <div className="setting-row">
        <div><div className="setting-title">Enable SSL certificate verification</div><div className="setting-desc">Verify SSL certificates when sending a request.</div></div>
        <TriState value={s.verifySsl} onChange={(v) => set({ verifySsl: v })} />
      </div>
      <div className="setting-row">
        <div><div className="setting-title">Request timeout (ms)</div><div className="setting-desc">Leave empty to use the global setting. 0 = no timeout.</div></div>
        <input className="input input-sm" type="number" min={0} value={s.timeoutMs ?? ""} placeholder="global"
          onChange={(e) => set({ timeoutMs: e.target.value === "" ? undefined : Number(e.target.value) })} />
      </div>
      <p className="help">The description and the response schema (checked against every response) are on the <b>Docs</b> tab.</p>
    </div>
  );
}
