// WebSocket / Server-Sent Events: the message log (response pane) and the message composer.
import { useEffect, useMemo, useRef, useState } from "react";
import type { LiveMessage, Tab, WsConfig } from "../types";
import { tryPrettyJson, uid } from "../lib/utils";
import { clearLive, prompt, resolveForSend, sendWsMessage, updateDraft } from "../store";
import { CodeEditor } from "./CodeEditor";
import { Empty, Icon, IconButton, Toggle } from "./ui";
import { shortcutLabel } from "../lib/platform";

export const defaultWs = (): WsConfig => ({ message: "", messageLanguage: "json", protocols: "", saved: [] });

function fmtTime(t: number) {
  const d = new Date(t);
  return `${d.toLocaleTimeString(undefined, { hour12: false })}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

function MessageRow({ m, open, onToggle }: { m: LiveMessage; open: boolean; onToggle: () => void }) {
  const text = m.binary ? `‹binary ${Math.floor((m.binary.length * 3) / 4)} bytes› ${m.binary.slice(0, 60)}${m.binary.length > 60 ? "…" : ""}` : m.data;
  const pretty = open && !m.binary ? tryPrettyJson(m.data) : null;
  const icon = m.dir === "out" ? "↑" : m.dir === "in" ? "↓" : m.dir === "error" ? "!" : "•";
  return (
    <div className={`live-row dir-${m.dir} ${open ? "open" : ""}`}>
      <div className="live-row-head" onClick={onToggle}>
        <span className="live-dir">{icon}</span>
        <span className="live-time">{fmtTime(m.time)}</span>
        {m.event && m.event !== "message" && <span className="live-event">{m.event}</span>}
        {m.eventId && <span className="live-event-id" title="Event id">#{m.eventId}</span>}
        <span className="live-text mono">{text.length > 400 ? `${text.slice(0, 400)}…` : text}</span>
        {(m.dir === "in" || m.dir === "out") && (
          <IconButton icon="copy" className="live-copy" title="Copy" onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(m.binary ?? m.data); }} />
        )}
      </div>
      {open && (m.dir === "in" || m.dir === "out") && <pre className="live-body selectable">{pretty ?? (m.binary ? m.binary : m.data)}</pre>}
    </div>
  );
}

export function LiveViewer({ tab }: { tab: Tab }) {
  const live = tab.live;
  const protocol = tab.draft?.protocol ?? "http";
  const [filter, setFilter] = useState("");
  const [dirs, setDirs] = useState<"all" | "in" | "out">("all");
  const [follow, setFollow] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const messages = live?.messages ?? [];

  const shown = useMemo(() => {
    const q = filter.toLowerCase();
    return messages.filter((m) =>
      (dirs === "all" || m.dir === dirs || m.dir === "info" || m.dir === "error") &&
      (!q || m.data.toLowerCase().includes(q) || m.event?.toLowerCase().includes(q)));
  }, [messages, filter, dirs]);

  useEffect(() => {
    if (follow && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [shown.length, follow]);

  const counts = useMemo(() => ({
    in: messages.filter((m) => m.dir === "in").length,
    out: messages.filter((m) => m.dir === "out").length,
  }), [messages]);

  const state = live?.status ?? "closed";
  return (
    <div className="response live-viewer">
      <div className="response-header live-header">
        <span className={`live-state ${state}`}><span className="server-dot" />{state === "open" ? (protocol === "ws" ? "Connected" : "Streaming") : state === "connecting" ? "Connecting…" : "Disconnected"}</span>
        {live?.head && <span className="muted live-head" title={live.head.headers.map((h) => `${h.key}: ${h.value}`).join("\n")}>{live.head.status} {live.head.statusText ?? ""}</span>}
        <span className="muted">↓ {counts.in}{protocol === "ws" && <> · ↑ {counts.out}</>}</span>
        <div className="flex-1" />
        {protocol === "ws" && (
          <div className="seg">
            {(["all", "in", "out"] as const).map((d) => (
              <button key={d} className={`seg-btn ${dirs === d ? "active" : ""}`} onClick={() => setDirs(d)}>{d === "all" ? "All" : d === "in" ? "Received" : "Sent"}</button>
            ))}
          </div>
        )}
        <div className="search-box inline live-filter">
          <Icon name="search" size={12} />
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter messages" />
        </div>
        <Toggle checked={follow} onChange={setFollow} label="Follow" />
        <IconButton icon="trash" title="Clear messages" onClick={() => clearLive(tab.id)} />
      </div>
      {messages.length === 0 ? (
        <Empty icon="bolt" title={protocol === "ws" ? "Connect to start exchanging messages" : "Connect to start receiving events"}>
          {protocol === "ws" ? "Messages you send and receive appear here, newest at the bottom." : "Each Server-Sent Event is shown as it arrives."}
        </Empty>
      ) : (
        <div className="live-list" ref={listRef} onScroll={(e) => {
          const el = e.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          if (atBottom !== follow) setFollow(atBottom);
        }}>
          {shown.map((m) => <MessageRow key={m.id} m={m} open={openId === m.id} onToggle={() => setOpenId(openId === m.id ? null : m.id)} />)}
        </div>
      )}
    </div>
  );
}

export function WsComposer({ tab }: { tab: Tab }) {
  const draft = tab.draft!;
  const ws = draft.ws ?? defaultWs();
  const set = (patch: Partial<WsConfig>) => updateDraft(tab.id, { ws: { ...ws, ...patch } });
  const connected = tab.live?.status === "open";
  const send = () => { if (connected && ws.message) sendWsMessage(tab.id, resolveForSend(tab, ws.message)); };
  return (
    <div className="ws-composer">
      <div className="ws-editor">
        <div className="body-toolbar">
          <div className="seg">
            {(["json", "text"] as const).map((l) => (
              <button key={l} className={`seg-btn ${ws.messageLanguage === l ? "active" : ""}`} onClick={() => set({ messageLanguage: l })}>{l === "json" ? "JSON" : "Text"}</button>
            ))}
          </div>
          {ws.messageLanguage === "json" && (
            <button className="link-btn" disabled={tryPrettyJson(ws.message) === null} onClick={() => set({ message: tryPrettyJson(ws.message) ?? ws.message })}>Beautify</button>
          )}
          <div className="flex-1" />
          <button className="btn btn-sm" disabled={!ws.message.trim()} onClick={async () => {
            const name = await prompt("Save message", ws.message.trim().slice(0, 40), "Name");
            if (name?.trim()) set({ saved: [...ws.saved, { id: uid(), name: name.trim(), body: ws.message }] });
          }}><Icon name="save" size={11} /> Save</button>
          <button className="btn btn-sm btn-primary" disabled={!connected || !ws.message} onClick={send} title={connected ? `Send (${shortcutLabel("⌘↵")})` : "Connect first"}>Send</button>
        </div>
        <div className="ws-editor-code">
          <CodeEditor value={ws.message} onChange={(message) => set({ message })} language={ws.messageLanguage === "json" ? "json" : "text"} variables placeholder="Message to send — {{variables}} are resolved" />
        </div>
      </div>
      <div className="ws-saved">
        <div className="snippets-title">Saved messages</div>
        {ws.saved.length === 0 && <div className="muted ws-saved-empty">Save messages you send often; click one to load it.</div>}
        {ws.saved.map((m) => (
          <div key={m.id} className="ws-saved-row" onClick={() => set({ message: m.body })} title={m.body}>
            <span className="ellipsis">{m.name}</span>
            <IconButton icon="close" className="tree-more" title="Delete" onClick={(e) => { e.stopPropagation(); set({ saved: ws.saved.filter((x) => x.id !== m.id) }); }} />
          </div>
        ))}
      </div>
    </div>
  );
}
