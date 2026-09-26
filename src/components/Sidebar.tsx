import { useMemo, useState } from "react";
import type { Collection, HistoryEntry, Item } from "../types";
import { flattenRequests, formatMs, methodColor, requestBadge, statusColor } from "../lib/utils";
import {
  addFolder, addRequestTo, clearHistory, confirmDialog, createCollection, deleteExample, duplicateExample, updateExample, createEnvironment, deleteCollection, deleteEnvironment,
  deleteHistory, deleteItem, duplicateCollection, duplicateEnvironment, duplicateItem, moveItem, newRequestTab, openHistoryEntry, openModal,
  openDocs, openRequest, openSpecialTab, reloadLinked, setActiveEnvironment, setSidebarView, togglePinned, unlinkCollection, updateCollection, updateEnvironment, updateItem, useStore,
  type SidebarView,
} from "../store";
import { EditableText, Empty, Icon, IconButton, menuFromEvent, type MenuItem } from "./ui";
import { openMockFor, ServersPanel } from "./ServerViews";
import { ToolsPanel } from "./tools";
import { exportCollectionFile, exportDocsFile, exportEnvironmentFile, exportHistoryHar, exportOpenApiFile, linkToFolder } from "./exporting";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

// ---------------------------------------------------------------- expansion state (persisted per machine)

const EXP_KEY = "lp.expanded";
function loadExpanded(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(EXP_KEY) ?? "[]")); } catch { return new Set(); }
}

export function Sidebar({ width }: { width: number }) {
  const view = useStore((s) => s.sidebarView);
  const rail: { id: SidebarView; icon: string; label: string }[] = [
    { id: "collections", icon: "collection", label: "Collections" },
    { id: "environments", icon: "env", label: "Environments" },
    { id: "history", icon: "history", label: "History" },
    { id: "servers", icon: "server", label: "Servers" },
    { id: "tools", icon: "tools", label: "Tools" },
  ];
  return (
    <div className="sidebar" style={{ width }}>
      <div className="rail">
        {rail.map((r) => (
          <button key={r.id} className={`rail-btn ${view === r.id ? "active" : ""}`} onClick={() => setSidebarView(r.id)} title={r.label}>
            <Icon name={r.icon} size={18} />
            <span>{r.label}</span>
          </button>
        ))}
      </div>
      <div className="sidebar-panel">
        {view === "collections" && <CollectionsPanel />}
        {view === "environments" && <EnvironmentsPanel />}
        {view === "history" && <HistoryPanel />}
        {view === "servers" && <ServersPanel />}
        {view === "tools" && <ToolsPanel />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- collections

const exportCollection = exportCollectionFile;

let dragSrc: { collectionId: string; itemId: string } | null = null;

function matches(item: Item, q: string): boolean {
  if (item.name.toLowerCase().includes(q)) return true;
  if (item.type === "request" && item.url.toLowerCase().includes(q)) return true;
  return item.type === "folder" && item.items.some((c) => matches(c, q));
}

function CollectionsPanel() {
  const collections = useStore((s) => s.collections);
  const activeItemId = useStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.saved?.itemId);
  const activeExampleId = useStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.exampleId);
  const [expanded, setExpanded] = useState(loadExpanded);
  const [filter, setFilter] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{ id: string; pos: "before" | "after" | "inside" } | null>(null);

  const toggle = (id: string, force?: boolean) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (force ?? !next.has(id)) next.add(id); else next.delete(id);
      localStorage.setItem(EXP_KEY, JSON.stringify([...next]));
      return next;
    });
  };

  const q = filter.trim().toLowerCase();

  const collectionMenu = (c: Collection): MenuItem[] => [
    { label: "Add request", onClick: () => { toggle(c.id, true); addRequestTo(c.id, null); } },
    { label: "Add folder", onClick: () => { toggle(c.id, true); const f = addFolder(c.id, null, "New Folder"); setRenaming(f.id); } },
    { divider: true },
    { label: "Run collection", onClick: () => openSpecialTab("runner", { collectionId: c.id }) },
    { label: "View documentation", onClick: () => openDocs(c.id) },
    { label: "Mock server…", onClick: () => openMockFor(c.id) },
    { label: "Overview & settings", onClick: () => openSpecialTab("collection", { collectionId: c.id }) },
    { divider: true },
    { label: "Rename", onClick: () => setRenaming(c.id) },
    { label: "Duplicate", onClick: () => duplicateCollection(c.id) },
    { label: "Export (Postman v2.1)…", onClick: () => exportCollection(c) },
    { label: "Export as OpenAPI (YAML)…", onClick: () => exportOpenApiFile(c, "yaml") },
    { label: "Export as OpenAPI (JSON)…", onClick: () => exportOpenApiFile(c, "json") },
    { label: "Publish docs as HTML…", onClick: () => exportDocsFile(c) },
    { label: "Find & replace…", onClick: () => openModal({ kind: "replace", collectionId: c.id }) },
    { divider: true },
    ...(c.linkedPath ? [
      { label: "Show linked folder", onClick: () => revealItemInDir(`${c.linkedPath}/collection.json`).catch(() => {}) },
      { label: "Reload from folder", onClick: () => reloadLinked(c.id) },
      { label: "Unlink folder", onClick: () => unlinkCollection(c.id) },
    ] : [
      { label: "Link to folder (git)…", onClick: () => linkToFolder(c) },
    ]),
    { divider: true },
    {
      label: "Delete", danger: true,
      onClick: async () => { if (await confirmDialog("Delete collection", `Delete "${c.name}" and everything in it? This cannot be undone.`, { confirmText: "Delete", danger: true })) deleteCollection(c.id); },
    },
  ];

  const itemMenu = (c: Collection, it: Item): MenuItem[] => [
    ...(it.type === "folder" ? [
      { label: "Add request", onClick: () => { toggle(it.id, true); addRequestTo(c.id, it.id); } },
      { label: "Add folder", onClick: () => { toggle(it.id, true); const f = addFolder(c.id, it.id, "New Folder"); setRenaming(f.id); } },
      { divider: true },
      { label: "Run folder", onClick: () => openSpecialTab("runner", { collectionId: c.id, folderId: it.id }) },
      { label: "Overview & settings", onClick: () => openSpecialTab("folder", { collectionId: c.id, folderId: it.id }) },
      { divider: true },
    ] : [
      { label: "Open in tab", onClick: () => openRequest(c.id, it.id) },
      { label: it.pinned ? "Unpin" : "Pin to top", onClick: () => togglePinned(c.id, it.id) },
    ]),
    { label: "Rename", onClick: () => setRenaming(it.id) },
    { label: "Duplicate", onClick: () => duplicateItem(c.id, it.id) },
    { divider: true },
    {
      label: "Delete", danger: true,
      onClick: async () => { if (await confirmDialog(`Delete ${it.type}`, `Delete "${it.name}"?${it.type === "folder" ? " All requests inside will be deleted." : ""}`, { confirmText: "Delete", danger: true })) deleteItem(c.id, it.id); },
    },
  ];

  const dragProps = (collectionId: string, id: string, kind: "collection" | "folder" | "request") => ({
    draggable: kind !== "collection",
    onDragStart: (e: React.DragEvent) => {
      dragSrc = { collectionId, itemId: id };
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", id);
    },
    onDragEnd: () => { dragSrc = null; setDropHint(null); },
    onDragOver: (e: React.DragEvent) => {
      if (!dragSrc || dragSrc.itemId === id) return;
      e.preventDefault();
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const y = (e.clientY - r.top) / r.height;
      const pos = kind === "collection" ? "inside" : kind === "folder" ? (y < 0.25 ? "before" : y > 0.75 ? "after" : "inside") : y < 0.5 ? "before" : "after";
      if (dropHint?.id !== id || dropHint.pos !== pos) setDropHint({ id, pos });
    },
    onDragLeave: () => setDropHint((h) => (h?.id === id ? null : h)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      const src = dragSrc;
      const hint = dropHint;
      dragSrc = null;
      setDropHint(null);
      if (!src || !hint) return;
      moveItem(src.collectionId, src.itemId, collectionId, kind === "collection" ? null : id, hint.pos);
      if (hint.pos === "inside") toggle(id, true);
    },
  });

  const hintClass = (id: string) => (dropHint?.id === id ? `drop-${dropHint.pos}` : "");

  const pinned = useMemo(
    () => collections.flatMap((c) => flattenRequests(c.items).filter((r) => r.pinned).map((r) => ({ c, r }))),
    [collections],
  );

  const renderItems = (c: Collection, items: Item[], depth: number): React.ReactNode =>
    items.filter((it) => !q || matches(it, q)).map((it) => {
      const isOpen = !!q || expanded.has(it.id);
      if (it.type === "folder") {
        return (
          <div key={it.id}>
            <div
              className={`tree-row ${hintClass(it.id)}`}
              style={{ paddingLeft: 8 + depth * 14 }}
              onClick={() => toggle(it.id)}
              onContextMenu={(e) => menuFromEvent(e, itemMenu(c, it))}
              {...dragProps(c.id, it.id, "folder")}
            >
              <Icon name={isOpen ? "chevronDown" : "chevronRight"} size={12} className="tree-chevron" />
              <Icon name={isOpen ? "folderOpen" : "folder"} size={14} className="tree-icon" />
              <EditableText
                className="tree-label"
                value={it.name}
                editing={renaming === it.id ? true : undefined}
                onDone={() => setRenaming(null)}
                onChange={(name) => updateItem(c.id, it.id, { name })}
              />
              <IconButton icon="dots" className="tree-more" onClick={(e) => menuFromEvent(e, itemMenu(c, it))} />
            </div>
            {isOpen && (
              it.items.length ? renderItems(c, it.items, depth + 1)
                : <div className="tree-empty" style={{ paddingLeft: 30 + depth * 14 }}>This folder is empty. <button className="link-btn" onClick={() => addRequestTo(c.id, it.id)}>Add a request</button></div>
            )}
          </div>
        );
      }
      const examples = it.examples ?? [];
      const exOpen = expanded.has(`ex:${it.id}`);
      return (
        <div key={it.id}>
        <div
          className={`tree-row ${activeItemId === it.id ? "selected" : ""} ${hintClass(it.id)}`}
          style={{ paddingLeft: 8 + depth * 14 + (examples.length ? 0 : 14) }}
          onClick={() => openRequest(c.id, it.id)}
          onContextMenu={(e) => menuFromEvent(e, itemMenu(c, it))}
          {...dragProps(c.id, it.id, "request")}
        >
          {examples.length > 0 && (
            <span className="tree-chevron-btn" onClick={(e) => { e.stopPropagation(); toggle(`ex:${it.id}`); }} title={`${examples.length} example${examples.length === 1 ? "" : "s"}`}>
              <Icon name={exOpen ? "chevronDown" : "chevronRight"} size={12} className="tree-chevron" />
            </span>
          )}
          <span className="method-badge" style={{ color: methodColor(requestBadge(it)) }}>{requestBadge(it)}</span>
          {it.pinned && <Icon name="pin" size={10} className="tree-pin" />}
          <EditableText
            className="tree-label"
            value={it.name}
            editing={renaming === it.id ? true : undefined}
            onDone={() => setRenaming(null)}
            onChange={(name) => updateItem(c.id, it.id, { name })}
          />
          <IconButton icon="dots" className="tree-more" onClick={(e) => menuFromEvent(e, itemMenu(c, it))} />
        </div>
        {exOpen && examples.map((ex) => {
          const menu: MenuItem[] = [
            { label: "Open", onClick: () => openSpecialTab("example", { collectionId: c.id, requestId: it.id, exampleId: ex.id }) },
            { label: "Rename", onClick: () => setRenaming(ex.id) },
            { label: "Duplicate", onClick: () => duplicateExample(c.id, it.id, ex.id) },
            { divider: true },
            { label: "Delete", danger: true, onClick: async () => { if (await confirmDialog("Delete example", `Delete "${ex.name}"?`, { confirmText: "Delete", danger: true })) deleteExample(c.id, it.id, ex.id); } },
          ];
          return (
            <div
              key={ex.id}
              className={`tree-row example-row ${activeExampleId === ex.id ? "selected" : ""}`}
              style={{ paddingLeft: 8 + depth * 14 + 30 }}
              onClick={() => openSpecialTab("example", { collectionId: c.id, requestId: it.id, exampleId: ex.id })}
              onContextMenu={(e) => menuFromEvent(e, menu)}
            >
              <Icon name="example" size={12} className="tree-icon" />
              <EditableText className="tree-label" value={ex.name} editing={renaming === ex.id ? true : undefined} onDone={() => setRenaming(null)} onChange={(name) => updateExample(c.id, it.id, ex.id, { name })} />
              <span className="history-status" style={{ color: statusColor(ex.status) }}>{ex.status}</span>
              <IconButton icon="dots" className="tree-more" onClick={(e) => menuFromEvent(e, menu)} />
            </div>
          );
        })}
        </div>
      );
    });

  return (
    <>
      <div className="panel-header">
        <IconButton icon="plus" title="New collection" onClick={() => { const c = createCollection(); setRenaming(c.id); }} />
        <div className="search-box">
          <Icon name="search" size={12} />
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search collections" />
        </div>
        <IconButton icon="import" title="Import" onClick={() => openModal({ kind: "import" })} />
      </div>
      <div className="tree">
        {collections.length === 0 && (
          <Empty icon="collection" title="Create a collection for your requests">
            A collection lets you group related requests and easily set common authorization, scripts, and variables for all requests in it.
            <div className="empty-actions">
              <button className="btn btn-primary" onClick={() => { const c = createCollection(); setRenaming(c.id); }}>Create Collection</button>
              <button className="btn" onClick={() => openModal({ kind: "import" })}>Import</button>
            </div>
          </Empty>
        )}
        {!q && pinned.length > 0 && (
          <div className="tree-pinned">
            <div className="tree-group">Pinned</div>
            {pinned.map(({ c, r }) => (
              <div
                key={r.id}
                className={`tree-row ${activeItemId === r.id ? "selected" : ""}`}
                onClick={() => openRequest(c.id, r.id)}
                onContextMenu={(e) => menuFromEvent(e, itemMenu(c, r))}
                title={`${c.name} · ${r.url}`}
              >
                <span className="method-badge" style={{ color: methodColor(requestBadge(r)) }}>{requestBadge(r)}</span>
                <span className="tree-label">{r.name}</span>
                <IconButton icon="pin" className="tree-more" title="Unpin" onClick={(e) => { e.stopPropagation(); togglePinned(c.id, r.id); }} />
              </div>
            ))}
            <div className="tree-divider" />
          </div>
        )}
        {collections.filter((c) => !q || c.name.toLowerCase().includes(q) || c.items.some((i) => matches(i, q))).map((c) => {
          const isOpen = !!q || expanded.has(c.id);
          return (
            <div key={c.id} className="tree-collection">
              <div
                className={`tree-row collection-row ${hintClass(c.id)}`}
                onClick={() => toggle(c.id)}
                onContextMenu={(e) => menuFromEvent(e, collectionMenu(c))}
                {...dragProps(c.id, c.id, "collection")}
              >
                <Icon name={isOpen ? "chevronDown" : "chevronRight"} size={12} className="tree-chevron" />
                <EditableText
                  className="tree-label"
                  value={c.name}
                  editing={renaming === c.id ? true : undefined}
                  onDone={() => setRenaming(null)}
                  onChange={(name) => updateCollection(c.id, { name })}
                />
                {c.linkedPath && <span className="linked-badge" title={`Linked to ${c.linkedPath}`}><Icon name="folder" size={11} /></span>}
                <IconButton icon="play" className="tree-more" title="Run collection" onClick={(e) => { e.stopPropagation(); openSpecialTab("runner", { collectionId: c.id }); }} />
                <IconButton icon="dots" className="tree-more" onClick={(e) => menuFromEvent(e, collectionMenu(c))} />
              </div>
              {isOpen && (
                c.items.length ? renderItems(c, c.items, 1)
                  : <div className="tree-empty" style={{ paddingLeft: 30 }}>This collection is empty. <button className="link-btn" onClick={() => addRequestTo(c.id, null)}>Add a request</button></div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- environments

function EnvironmentsPanel() {
  const environments = useStore((s) => s.environments);
  const activeId = useStore((s) => s.activeEnvironmentId);
  const openTab = useStore((s) => s.tabs.find((t) => t.id === s.activeTabId));
  const [filter, setFilter] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const q = filter.trim().toLowerCase();

  return (
    <>
      <div className="panel-header">
        <IconButton icon="plus" title="New environment" onClick={() => { const e = createEnvironment(); openSpecialTab("environment", { environmentId: e.id }); setRenaming(e.id); }} />
        <div className="search-box">
          <Icon name="search" size={12} />
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search environments" />
        </div>
        <IconButton icon="compare" title="Compare environments" onClick={() => openModal({ kind: "envCompare" })} />
        <IconButton icon="import" title="Import" onClick={() => openModal({ kind: "import" })} />
      </div>
      <div className="tree">
        <div className={`tree-row ${openTab?.kind === "globals" ? "selected" : ""}`} onClick={() => openSpecialTab("globals")}>
          <Icon name="env" className="tree-icon" />
          <span className="tree-label">Globals</span>
        </div>
        <div className="tree-divider" />
        {environments.length === 0 && (
          <Empty icon="env" title="Create an environment">
            An environment is a set of variables that allows you to switch the context of your requests (e.g. dev, staging, production).
            <div className="empty-actions">
              <button className="btn btn-primary" onClick={() => { const e = createEnvironment(); openSpecialTab("environment", { environmentId: e.id }); }}>Create Environment</button>
            </div>
          </Empty>
        )}
        {environments.filter((e) => !q || e.name.toLowerCase().includes(q)).map((env) => {
          const menu: MenuItem[] = [
            { label: activeId === env.id ? "Deactivate" : "Set as active", onClick: () => setActiveEnvironment(activeId === env.id ? null : env.id) },
            { label: "Rename", onClick: () => setRenaming(env.id) },
            { label: "Duplicate", onClick: () => duplicateEnvironment(env.id) },
            { label: "Compare with…", onClick: () => openModal({ kind: "envCompare", a: env.id }) },
            {
              label: "Export…",
              onClick: () => exportEnvironmentFile(env),
            },
            { divider: true },
            { label: "Delete", danger: true, onClick: async () => { if (await confirmDialog("Delete environment", `Delete "${env.name}"?`, { confirmText: "Delete", danger: true })) deleteEnvironment(env.id); } },
          ];
          return (
            <div
              key={env.id}
              className={`tree-row ${openTab?.kind === "environment" && openTab.environmentId === env.id ? "selected" : ""}`}
              onClick={() => openSpecialTab("environment", { environmentId: env.id })}
              onContextMenu={(e) => menuFromEvent(e, menu)}
            >
              <button
                className={`env-check ${activeId === env.id ? "on" : ""}`}
                title={activeId === env.id ? "Active environment" : "Set active"}
                onClick={(e) => { e.stopPropagation(); setActiveEnvironment(activeId === env.id ? null : env.id); }}
              >
                <Icon name="check" size={12} />
              </button>
              <EditableText
                className="tree-label"
                value={env.name}
                editing={renaming === env.id ? true : undefined}
                onDone={() => setRenaming(null)}
                onChange={(name) => updateEnvironment(env.id, { name })}
              />
              <IconButton icon="dots" className="tree-more" onClick={(e) => menuFromEvent(e, menu)} />
            </div>
          );
        })}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- history

function dayLabel(t: number) {
  const d = new Date(t);
  const today = new Date();
  const y = new Date(); y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

function HistoryPanel() {
  const history = useStore((s) => s.history);
  const [filter, setFilter] = useState("");
  const q = filter.trim().toLowerCase();

  const groups = useMemo(() => {
    const g: { label: string; items: HistoryEntry[] }[] = [];
    for (const h of history) {
      if (q && !h.request.url.toLowerCase().includes(q) && !h.request.method.toLowerCase().includes(q)) continue;
      const label = dayLabel(h.time);
      const last = g[g.length - 1];
      if (last?.label === label) last.items.push(h); else g.push({ label, items: [h] });
    }
    return g;
  }, [history, q]);

  return (
    <>
      <div className="panel-header">
        <div className="search-box">
          <Icon name="search" size={12} />
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search history" />
        </div>
        <IconButton
          icon="dots"
          title="More"
          onClick={(e) => menuFromEvent(e, [
            { label: "Export history as HAR…", disabled: !history.length, onClick: () => exportHistoryHar(history) },
            { divider: true },
            {
              label: "Clear all history", danger: true,
              onClick: async () => { if (await confirmDialog("Clear history", "Delete all history entries?", { confirmText: "Clear", danger: true })) clearHistory(); },
            },
          ])}
        />
      </div>
      <div className="tree">
        {history.length === 0 && <Empty icon="history" title="You haven't sent any requests yet">Requests you send will appear here.</Empty>}
        {groups.map((g) => (
          <div key={g.label}>
            <div className="tree-group">{g.label}</div>
            {g.items.map((h) => (
              <div
                key={h.id}
                className="tree-row history-row"
                onClick={() => openHistoryEntry(h)}
                onContextMenu={(e) => menuFromEvent(e, [
                  { label: "Open in new tab", onClick: () => openHistoryEntry(h) },
                  { label: "Save to collection…", onClick: () => { const t = newRequestTab({ ...h.request, name: h.request.url || "Request" }); openModal({ kind: "save", tabId: t.id }); } },
                  { divider: true },
                  { label: "Delete", danger: true, onClick: () => deleteHistory(h.id) },
                ])}
                title={`${new Date(h.time).toLocaleTimeString()}${h.status ? ` · ${h.status}` : ""}${h.timeMs ? ` · ${formatMs(h.timeMs)}` : ""}${h.error ? ` · ${h.error}` : ""}`}
              >
                <span className="method-badge" style={{ color: methodColor(requestBadge(h.request)) }}>{requestBadge(h.request)}</span>
                <span className="tree-label">{h.request.url || "(no url)"}</span>
                {h.status ? <span className="history-status" style={{ color: statusColor(h.status) }}>{h.status}</span> : h.error ? <span className="history-status" style={{ color: "var(--err)" }}>ERR</span> : null}
                <IconButton icon="close" className="tree-more" title="Delete" onClick={(e) => { e.stopPropagation(); deleteHistory(h.id); }} />
              </div>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}
