// Mock server and webhook catcher tabs, plus the sidebar's "Servers" panel.
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useMemo, useState } from "react";
import type { ServerDef, ServerEvent, Tab } from "../types";
import { compileRoutes } from "../lib/mock";
import { formatBytes, getHeader, kv, methodColor, paramsFromUrl, statusColor, tryPrettyJson } from "../lib/utils";
import {
  clearServerLog, confirmDialog, createEnvironment, createServer, deleteServer, newRequestTab, openSpecialTab, restartServer,
  setActiveEnvironment, startServer, stopServer, updateServer, useStore, type ServerRuntime,
} from "../store";
import { CodeEditor } from "./CodeEditor";
import { KeyValueTable } from "./KeyValueTable";
import { EditableText, Empty, Icon, IconButton, menuFromEvent, Tabs, Toggle, type MenuItem } from "./ui";

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function serverUrl(rt: ServerRuntime | undefined, def: ServerDef) {
  return `http://127.0.0.1:${rt?.port ?? def.port}`;
}

/** Open (or create) the mock server for a collection. */
export function openMockFor(collectionId: string) {
  const existing = useStore.getState().servers.find((d) => d.kind === "mock" && d.collectionId === collectionId);
  const def = existing ?? createServer("mock", collectionId);
  useStore.setState({ sidebarView: "servers" });
  openSpecialTab("server", { serverId: def.id });
}

/** Open (or create) the live docs server for a collection. */
export function openDocsServerFor(collectionId: string) {
  const existing = useStore.getState().servers.find((d) => d.kind === "docs" && d.collectionId === collectionId);
  const def = existing ?? createServer("docs", collectionId);
  useStore.setState({ sidebarView: "servers" });
  openSpecialTab("server", { serverId: def.id });
}

export function newCatcher() {
  const def = createServer("catcher");
  useStore.setState({ sidebarView: "servers" });
  openSpecialTab("server", { serverId: def.id });
}

// ---------------------------------------------------------------- shared header

function ServerHeader({ def, rt }: { def: ServerDef; rt?: ServerRuntime }) {
  const running = !!rt?.running;
  const url = serverUrl(rt, def);
  const [copied, setCopied] = useState(false);
  return (
    <>
      <div className="container-header">
        <Icon name={def.kind === "mock" ? "server" : def.kind === "docs" ? "docs" : "inbox"} size={18} />
        <EditableText className="container-title" value={def.name} onChange={(name) => updateServer(def.id, { name })} />
        <span className={`server-state ${running ? "on" : ""}`}><span className="server-dot" />{running ? "Running" : rt?.starting ? "Starting…" : "Stopped"}</span>
        <div className="flex-1" />
        {running && (
          <button className="btn" onClick={() => { navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1200); }} title="Copy URL">
            <Icon name={copied ? "check" : "copy"} size={12} /> <span className="mono">{url}</span>
          </button>
        )}
        {running
          ? <button className="btn" onClick={() => stopServer(def.id)}><Icon name="stop" size={12} /> Stop</button>
          : <button className="btn btn-primary" disabled={rt?.starting || !inTauri} onClick={() => startServer(def.id)} title={inTauri ? "" : "Local servers need the desktop app"}><Icon name="play" size={12} /> Start</button>}
        <IconButton icon="dots" title="More" onClick={(e) => menuFromEvent(e, [
          { label: "Clear request log", onClick: () => clearServerLog(def.id) },
          { divider: true },
          { label: "Delete", danger: true, onClick: async () => { if (await confirmDialog("Delete server", `Delete "${def.name}"?`, { confirmText: "Delete", danger: true })) deleteServer(def.id); } },
        ])} />
      </div>
      {!inTauri && <div className="server-banner">Local servers run in the desktop app. This browser preview can edit their settings but not start them.</div>}
      {rt?.error && <div className="server-banner error"><Icon name="close" size={12} /> {rt.error}</div>}
      <ServerSettings def={def} running={running} />
    </>
  );
}

function ServerSettings({ def, running }: { def: ServerDef; running: boolean }) {
  const collections = useStore((s) => s.collections);
  const [port, setPort] = useState(String(def.port));
  const [delay, setDelay] = useState(String(def.delayMs));
  useEffect(() => { setPort(String(def.port)); setDelay(String(def.delayMs)); }, [def.port, def.delayMs]);
  const apply = (patch: Partial<ServerDef>) => { updateServer(def.id, patch); if (running) restartServer(def.id); };
  return (
    <div className="server-settings">
      {def.kind !== "catcher" && (
        <label className="server-field">
          <span>Collection</span>
          <select className="select" value={def.collectionId ?? ""} onChange={(e) => apply({ collectionId: e.target.value })}>
            {!def.collectionId && <option value="">Choose…</option>}
            {collections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
      )}
      <label className="server-field">
        <span>Port</span>
        <input className="input input-sm mono" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))}
          onBlur={() => { const p = Math.min(65535, Number(port) || 0); if (p !== def.port) apply({ port: p }); }}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} title="0 picks any free port" />
      </label>
      {def.kind !== "docs" && <label className="server-field">
        <span>Delay (ms)</span>
        <input className="input input-sm mono" value={delay} onChange={(e) => setDelay(e.target.value.replace(/\D/g, ""))}
          onBlur={() => { const d = Math.min(60000, Number(delay) || 0); if (d !== def.delayMs) apply({ delayMs: d }); }}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
      </label>}
      {def.kind !== "docs" && <Toggle checked={def.cors} onChange={(cors) => apply({ cors })} label="CORS headers" />}
      <Toggle checked={def.allowLan} onChange={(allowLan) => apply({ allowLan })} label="Allow other devices on my network" />
      {def.allowLan && <span className="server-lan-warning"><Icon name="lock" size={11} /> Reachable from your local network while running</span>}
    </div>
  );
}

// ---------------------------------------------------------------- request log

function EventList({ events, selected, onSelect, showMatch }: { events: ServerEvent[]; selected?: string; onSelect: (id: string) => void; showMatch?: boolean }) {
  if (!events.length) return <div className="muted pad">No requests yet.</div>;
  return (
    <div className="event-list">
      {events.map((e) => (
        <div key={e.id} className={`event-row ${selected === e.id ? "selected" : ""}`} onClick={() => onSelect(e.id)}>
          <span className="event-time">{new Date(e.time).toLocaleTimeString()}</span>
          <span className="method-badge" style={{ color: methodColor(e.method) }}>{e.method === "DELETE" ? "DEL" : e.method.slice(0, 6)}</span>
          <span className="event-path mono ellipsis">{e.path}{e.query ? `?${e.query}` : ""}</span>
          {showMatch && <span className="event-match ellipsis">{e.matched ?? <span className="muted">no match</span>}</span>}
          <span className="event-status" style={{ color: statusColor(e.status) }}>{e.status}</span>
        </div>
      ))}
    </div>
  );
}

function EventDetail({ ev, port }: { ev: ServerEvent; port: number }) {
  const [sub, setSub] = useState<"body" | "headers" | "query">("body");
  const pretty = tryPrettyJson(ev.body);
  const query = ev.query ? paramsFromUrl(`?${ev.query}`, []) : [];
  const ct = getHeader(ev.headers, "content-type") ?? "";
  const skip = /^(host|content-length|connection|accept-encoding)$/i;

  const openAsRequest = () => {
    const url = `http://127.0.0.1:${port}${ev.path}${ev.query ? `?${ev.query}` : ""}`;
    newRequestTab({
      name: `${ev.method} ${ev.path}`,
      method: ev.method,
      url,
      params: paramsFromUrl(url, []),
      headers: ev.headers.filter((h) => !skip.test(h.key)).map((h) => kv(h.key, h.value)),
      body: {
        mode: ev.body ? "raw" : "none", raw: ev.body,
        rawLanguage: ct.includes("json") ? "json" : ct.includes("xml") ? "xml" : ct.includes("html") ? "html" : "text",
        urlencoded: [], formdata: [], binaryPath: "", graphql: { query: "", variables: "" },
      },
    });
  };
  const curl = () => {
    const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    const parts = [`curl -X ${ev.method} ${sq(`http://127.0.0.1:${port}${ev.path}${ev.query ? `?${ev.query}` : ""}`)}`];
    for (const h of ev.headers) if (!skip.test(h.key)) parts.push(`-H ${sq(`${h.key}: ${h.value}`)}`);
    if (ev.body) parts.push(`--data-raw ${sq(ev.body)}`);
    navigator.clipboard.writeText(parts.join(" \\\n  "));
  };

  return (
    <div className="event-detail">
      <div className="event-detail-head">
        <span className="method-badge" style={{ color: methodColor(ev.method) }}>{ev.method}</span>
        <span className="mono ellipsis selectable">{ev.path}{ev.query ? `?${ev.query}` : ""}</span>
        <div className="flex-1" />
        <button className="btn btn-sm" onClick={curl}><Icon name="copy" size={11} /> cURL</button>
        <button className="btn btn-sm btn-primary" onClick={openAsRequest}><Icon name="plus" size={11} /> Open as request</button>
      </div>
      <div className="event-meta muted">
        {new Date(ev.time).toLocaleString()} · from {ev.remoteAddr || "unknown"} · {formatBytes(ev.size)}
        {ev.matched !== null && <> · answered with <b>{ev.matched}</b></>} · responded {ev.status}
      </div>
      <Tabs value={sub} onChange={setSub} tabs={[
        { id: "body", label: "Body" },
        { id: "headers", label: "Headers", badge: ev.headers.length },
        { id: "query", label: "Query", badge: query.length || undefined },
      ]} />
      <div className="event-detail-body">
        {sub === "body" && (ev.bodyBase64
          ? <Empty icon="file" title={`Binary body (${formatBytes(ev.size)})`} />
          : ev.body ? <CodeEditor value={pretty ?? ev.body} readOnly wrap language={pretty ? "json" : "text"} /> : <div className="muted pad">No body.</div>)}
        {sub === "headers" && (
          <table className="data-table"><tbody>{ev.headers.map((h, i) => <tr key={i}><td className="mono">{h.key}</td><td className="mono selectable">{h.value}</td></tr>)}</tbody></table>
        )}
        {sub === "query" && (query.length
          ? <table className="data-table"><tbody>{query.map((q) => <tr key={q.id}><td className="mono">{q.key}</td><td className="mono selectable">{decodeURIComponent(q.value)}</td></tr>)}</tbody></table>
          : <div className="muted pad">No query parameters.</div>)}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- tabs

export function ServerView({ tab }: { tab: Tab }) {
  const def = useStore((s) => s.servers.find((d) => d.id === tab.serverId));
  const rt = useStore((s) => (tab.serverId ? s.serverRuntime[tab.serverId] : undefined));
  if (!def) return <Empty icon="server" title="This server no longer exists" />;
  return def.kind === "mock" ? <MockView def={def} rt={rt} /> : def.kind === "docs" ? <DocsServerView def={def} rt={rt} /> : <CatcherView def={def} rt={rt} />;
}

/** Live docs: the collection's docs site served on 127.0.0.1, rebuilt as the collection changes. */
function DocsServerView({ def, rt }: { def: ServerDef; rt?: ServerRuntime }) {
  const collection = useStore((s) => s.collections.find((c) => c.id === def.collectionId));
  const [selected, setSelected] = useState<string>();
  const log = rt?.log ?? [];
  const ev = log.find((e) => e.id === selected) ?? log[0];
  const url = serverUrl(rt, def);
  return (
    <div className="container-editor server-view">
      <ServerHeader def={def} rt={rt} />
      <div className="container-content">
        <div className="docs-server-info">
          {rt?.running ? (
            <>
              <p>The docs for <b>{collection?.name ?? "this collection"}</b> are being served at</p>
              <div className="docs-server-url">
                <span className="mono">{url}</span>
                <button className="btn btn-primary btn-sm" onClick={() => openUrl(url).catch(() => {})}><Icon name="eye" size={12} /> Open in browser</button>
              </div>
              <p className="help">Edits to the collection show up when you refresh the page. Secret variables are never included; credential-like text is redacted.{def.allowLan ? " Other devices on your network can open it while this runs." : " Only this computer can open it."}</p>
            </>
          ) : (
            <p className="help">Start the server to preview the published docs site in your browser, or share it on your network with “Allow other devices on my network”.</p>
          )}
        </div>
        {log.length > 0 && (
          <div className="server-log">
            <EventList events={log} selected={ev?.id} onSelect={setSelected} />
            {ev && <EventDetail ev={ev} port={rt?.port ?? def.port} />}
          </div>
        )}
      </div>
    </div>
  );
}

function MockView({ def, rt }: { def: ServerDef; rt?: ServerRuntime }) {
  const collection = useStore((s) => s.collections.find((c) => c.id === def.collectionId));
  const routes = useMemo(() => (collection ? compileRoutes(collection) : []), [collection]);
  const [sub, setSub] = useState<"routes" | "log">("routes");
  const [selected, setSelected] = useState<string>();
  const log = rt?.log ?? [];
  const ev = log.find((e) => e.id === selected) ?? log[0];

  return (
    <div className="container-editor server-view">
      <ServerHeader def={def} rt={rt} />
      <Tabs value={sub} onChange={setSub} tabs={[
        { id: "routes", label: "Routes", badge: routes.length || undefined },
        { id: "log", label: "Request log", badge: log.length || undefined },
      ]} right={rt?.running && collection ? (
        <button className="btn btn-sm" onClick={() => {
          const env = createEnvironment(`${def.name}`, [kv("baseUrl", serverUrl(rt, def))]);
          setActiveEnvironment(env.id);
        }} title="Create and activate an environment with baseUrl pointing at this mock">
          <Icon name="env" size={12} /> Use as environment
        </button>
      ) : undefined} />
      <div className="container-content">
        {sub === "routes" && (routes.length === 0 ? (
          <Empty icon="example" title="No examples to serve yet">
            Send a request from {collection ? <b>{collection.name}</b> : "the collection"}, then choose <b>Save as example</b> in the response pane. Every example becomes a route here.
          </Empty>
        ) : (
          <>
            <p className="help pad">
              Requests are matched on method and path (<code>:id</code> and <code>{"{{var}}"}</code> segments match anything), then query parameters.
              When several examples match, send <code>x-mock-response-name</code> or <code>x-mock-response-code</code> to pick one.
            </p>
            <div className="response-scroll">
              <table className="data-table routes-table">
                <thead><tr><th>Method</th><th>Path</th><th>Status</th><th>Example</th><th>Request</th></tr></thead>
                <tbody>
                  {routes.map((r) => (
                    <tr key={r.exampleId} className="clickable" onClick={() => collection && openSpecialTab("example", { collectionId: collection.id, requestId: r.requestId, exampleId: r.exampleId })}>
                      <td><span className="method-badge" style={{ color: methodColor(r.method), textAlign: "left" }}>{r.method}</span></td>
                      <td className="mono">{r.path}{r.query.length ? `?${r.query.map((q) => `${q.key}=${q.value}`).join("&")}` : ""}</td>
                      <td style={{ color: statusColor(r.status) }}>{r.status}</td>
                      <td>{r.name}</td>
                      <td className="muted">{r.requestName}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ))}
        {sub === "log" && (
          <div className="server-log">
            <EventList events={log} selected={ev?.id} onSelect={setSelected} showMatch />
            {ev && <EventDetail ev={ev} port={rt?.port ?? def.port} />}
          </div>
        )}
      </div>
    </div>
  );
}

function CatcherView({ def, rt }: { def: ServerDef; rt?: ServerRuntime }) {
  const [sub, setSub] = useState<"requests" | "response">("requests");
  const [selected, setSelected] = useState<string>();
  const log = rt?.log ?? [];
  const ev = log.find((e) => e.id === selected) ?? log[0];
  const response = def.response ?? { status: 200, headers: [], body: "" };
  const setResponse = (patch: Partial<typeof response>) => updateServer(def.id, { response: { ...response, ...patch } });

  return (
    <div className="container-editor server-view">
      <ServerHeader def={def} rt={rt} />
      <Tabs value={sub} onChange={setSub} tabs={[
        { id: "requests", label: "Captured requests", badge: log.length || undefined },
        { id: "response", label: "Response" },
      ]} />
      <div className="container-content">
        {sub === "requests" && (log.length === 0 ? (
          <Empty icon="inbox" title={rt?.running ? "Waiting for requests…" : "Start the catcher to receive webhooks"}>
            Point a webhook or any HTTP client at <code>{serverUrl(rt, def)}/any/path</code>. Every request is recorded here, with its headers and body, entirely on this computer.
          </Empty>
        ) : (
          <div className="server-log">
            <EventList events={log} selected={ev?.id} onSelect={setSelected} />
            {ev && <EventDetail ev={ev} port={rt?.port ?? def.port} />}
          </div>
        ))}
        {sub === "response" && (
          <div className="catcher-response">
            <p className="help">Every request gets this response.{rt?.running && " Changes apply when you click Apply."}</p>
            <label className="server-field">
              <span>Status</span>
              <input className="input input-sm mono" type="number" min={100} max={599} value={response.status} onChange={(e) => setResponse({ status: Number(e.target.value) || 200 })} />
            </label>
            <KeyValueTable suggest="response-headers" rows={response.headers} onChange={(headers) => setResponse({ headers })} title="Headers" />
            <div className="catcher-body"><CodeEditor value={response.body} onChange={(body) => setResponse({ body })} language={tryPrettyJson(response.body) !== null ? "json" : "text"} /></div>
            {rt?.running && <button className="btn btn-primary" onClick={() => restartServer(def.id)}>Apply</button>}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- sidebar panel

export function ServersPanel() {
  const servers = useStore((s) => s.servers);
  const runtime = useStore((s) => s.serverRuntime);
  const collections = useStore((s) => s.collections);
  const activeServer = useStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.serverId);
  const mockMenu: MenuItem[] = collections.length
    ? collections.map((c) => ({ label: `Mock server for “${c.name}”`, onClick: () => openMockFor(c.id) }))
    : [{ label: "Create a collection to mock first", disabled: true }];
  const newMenu: MenuItem[] = [
    ...mockMenu,
    { divider: true },
    ...collections.map((c) => ({ label: `Docs server for “${c.name}”`, onClick: () => openDocsServerFor(c.id) })),
    { divider: true },
    { label: "Webhook catcher", onClick: newCatcher },
  ];
  const mocks = servers.filter((d) => d.kind === "mock");
  const docsServers = servers.filter((d) => d.kind === "docs");
  const catchers = servers.filter((d) => d.kind === "catcher");
  const row = (d: ServerDef) => {
    const rt = runtime[d.id];
    const menu: MenuItem[] = [
      rt?.running ? { label: "Stop", onClick: () => stopServer(d.id) } : { label: "Start", onClick: () => startServer(d.id), disabled: !inTauri },
      { divider: true },
      { label: "Delete", danger: true, onClick: async () => { if (await confirmDialog("Delete server", `Delete "${d.name}"?`, { confirmText: "Delete", danger: true })) deleteServer(d.id); } },
    ];
    return (
      <div key={d.id} className={`tree-row ${activeServer === d.id ? "selected" : ""}`} onClick={() => openSpecialTab("server", { serverId: d.id })} onContextMenu={(e) => menuFromEvent(e, menu)}>
        <span className={`server-dot ${rt?.running ? "on" : ""}`} />
        <span className="tree-label">{d.name}</span>
        <span className="muted mono server-port">:{rt?.port ?? d.port}</span>
        {(rt?.log.length ?? 0) > 0 && <span className="server-count">{rt!.log.length}</span>}
        <IconButton icon="dots" className="tree-more" onClick={(e) => menuFromEvent(e, menu)} />
      </div>
    );
  };
  return (
    <>
      <div className="panel-header">
        <span className="panel-title">Local servers</span>
        <div className="flex-1" />
        <IconButton icon="plus" title="New mock server or webhook catcher" onClick={(e) => menuFromEvent(e, newMenu)} />
      </div>
      <div className="tree">
        {servers.length === 0 && (
          <Empty icon="server" title="Run servers on this computer">
            <b>Mock servers</b> answer with a collection's saved examples. <b>Webhook catchers</b> record every request sent to them. Both listen on 127.0.0.1 only.
            <div className="empty-actions">
              <button className="btn btn-primary" onClick={(e) => menuFromEvent(e, mockMenu)} disabled={!collections.length}>New mock server</button>
              <button className="btn" onClick={newCatcher}>New webhook catcher</button>
            </div>
          </Empty>
        )}
        {mocks.length > 0 && <div className="tree-group">Mock servers</div>}
        {mocks.map(row)}
        {docsServers.length > 0 && <div className="tree-group">Docs servers</div>}
        {docsServers.map(row)}
        {catchers.length > 0 && <div className="tree-group">Webhook catchers</div>}
        {catchers.map(row)}
      </div>
    </>
  );
}
