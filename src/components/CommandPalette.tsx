// ⌘K: jump to any request, folder, collection or environment, or run an action.
// ⌘⇧F (or Tab inside the palette): full-text search inside requests.
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { buildPaletteIndex, rank, searchContents, type PaletteEntry } from "../lib/search";
import { methodColor } from "../lib/utils";
import {
  closeModal, createCollection, createEnvironment, newRequestTab, openLoadTest, openModal, openRequest, openSpecialTab, setActiveEnvironment,
  setSidebarView, toggleConsole, updateSettings, useStore,
} from "../store";
import { THEMES } from "../themes";
import { Icon } from "./ui";
import { openTool, TOOLS } from "./tools";
import { openDocs } from "../store";
import { defaultWs } from "./LiveViews";

interface Action {
  id: string;
  title: string;
  subtitle?: string;
  shortcut?: string;
  run: () => void;
}

function useActions(): Action[] {
  const collections = useStore((s) => s.collections);
  const environments = useStore((s) => s.environments);
  const settings = useStore((s) => s.settings);
  return useMemo(() => {
    const a: Action[] = [
      { id: "new-request", title: "New request", shortcut: "⌘T", run: () => newRequestTab() },
      { id: "new-ws", title: "New WebSocket request", run: () => newRequestTab({ name: "WebSocket", protocol: "ws", ws: defaultWs() }) },
      { id: "new-sse", title: "New Server-Sent Events request", run: () => newRequestTab({ name: "Event stream", protocol: "sse" }) },
      { id: "new-collection", title: "New collection", run: () => { const c = createCollection(); setSidebarView("collections"); openSpecialTab("collection", { collectionId: c.id }); } },
      { id: "new-env", title: "New environment", run: () => { const e = createEnvironment(); setSidebarView("environments"); openSpecialTab("environment", { environmentId: e.id }); } },
      { id: "import", title: "Import…", shortcut: "⌘O", run: () => openModal({ kind: "import" }) },
      { id: "settings", title: "Open settings", shortcut: "⌘,", run: () => openModal({ kind: "settings" }) },
      { id: "globals", title: "Edit globals", run: () => openSpecialTab("globals") },
      { id: "console", title: "Toggle console", shortcut: "⌘⌥C", run: () => toggleConsole() },
      { id: "mode", title: `Switch to ${settings.mode === "dark" ? "light" : "dark"} mode`, run: () => updateSettings({ mode: settings.mode === "dark" ? "light" : "dark" }) },
      { id: "layout", title: settings.layout === "vertical" ? "Show response beside the request" : "Show response below the request", run: () => updateSettings({ layout: settings.layout === "vertical" ? "horizontal" : "vertical" }) },
      { id: "cookies", title: "Manage cookies", run: () => openModal({ kind: "cookies" }) },
      { id: "load", title: "Load test the current request", run: () => { const s = useStore.getState(); const t = s.tabs.find((x) => x.id === s.activeTabId); if (t?.kind === "request") openLoadTest(t.id); } },
      { id: "search", title: "Search inside requests…", shortcut: "⌘⇧F", run: () => openModal({ kind: "palette", mode: "search" }) },
      { id: "env-compare", title: "Compare environments", run: () => openModal({ kind: "envCompare" }) },
      ...TOOLS.map((t) => ({ id: `tool-${t.id}`, title: `Tool: ${t.name}`, subtitle: t.description, run: () => openTool(t.id) })),
      ...THEMES.filter((t) => t.id !== settings.theme).map((t) => ({ id: `theme-${t.id}`, title: `Theme: ${t.name}`, run: () => updateSettings({ theme: t.id }) })),
      { id: "env-none", title: "Environment: No environment", run: () => setActiveEnvironment(null) },
      ...environments.map((e) => ({ id: `env-${e.id}`, title: `Environment: ${e.name}`, subtitle: "Set as active", run: () => setActiveEnvironment(e.id) })),
      ...collections.flatMap((c) => [
        { id: `run-${c.id}`, title: `Run: ${c.name}`, subtitle: "Collection runner", run: () => openSpecialTab("runner", { collectionId: c.id }) },
        { id: `docs-${c.id}`, title: `Docs: ${c.name}`, subtitle: "View and edit API documentation", run: () => openDocs(c.id) },
        { id: `replace-${c.id}`, title: `Find & replace in: ${c.name}`, run: () => openModal({ kind: "replace", collectionId: c.id }) },
      ]),
    ];
    return a;
  }, [collections, environments, settings]);
}

type Row =
  | { type: "entry"; entry: PaletteEntry }
  | { type: "action"; action: Action }
  | { type: "content"; key: string; hit: ReturnType<typeof searchContents>[number] };

export function CommandPalette({ mode: initialMode, query: initialQuery = "" }: { mode: "go" | "search"; query?: string }) {
  const collections = useStore((s) => s.collections);
  const environments = useStore((s) => s.environments);
  const actions = useActions();
  const [mode, setMode] = useState(initialMode);
  const [query, setQuery] = useState(initialQuery);
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const index = useMemo(() => buildPaletteIndex(collections, environments), [collections, environments]);

  const rows: Row[] = useMemo(() => {
    if (mode === "search") {
      return searchContents(query, collections, 100).map((hit, i) => ({ type: "content", key: `${hit.itemId}-${hit.field}-${i}`, hit }));
    }
    // A leading ">" shows actions only, like editors do.
    if (query.startsWith(">")) return rank(query.slice(1), actions, 60).map((action) => ({ type: "action", action }));
    const entries = rank(query, index, 40).map((entry): Row => ({ type: "entry", entry }));
    const acts = rank(query, actions, query ? 8 : 6).map((action): Row => ({ type: "action", action }));
    return query ? [...entries, ...acts] : [...acts, ...entries];
  }, [mode, query, index, actions, collections]);

  useEffect(() => { setSel(0); }, [query, mode]);
  useEffect(() => {
    listRef.current?.querySelector(".palette-row.selected")?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const run = (row: Row | undefined) => {
    if (!row) return;
    closeModal();
    if (row.type === "action") return row.action.run();
    if (row.type === "content") return openRequest(row.hit.collectionId, row.hit.itemId);
    const t = row.entry.target;
    if (t.kind === "request") openRequest(t.collectionId, t.itemId);
    else if (t.kind === "folder") openSpecialTab("folder", { collectionId: t.collectionId, folderId: t.folderId });
    else if (t.kind === "collection") openSpecialTab("collection", { collectionId: t.collectionId });
    else openSpecialTab("environment", { environmentId: t.environmentId });
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((i) => Math.min(rows.length - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((i) => Math.max(0, i - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); run(rows[sel]); }
    else if (e.key === "Escape") { e.preventDefault(); closeModal(); }
    else if (e.key === "Tab") { e.preventDefault(); setMode((m) => (m === "go" ? "search" : "go")); }
    e.stopPropagation();
  };

  return createPortal(
    <div className="modal-backdrop palette-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) closeModal(); }}>
      <div className="palette" role="dialog" aria-label="Command palette">
        <div className="palette-input">
          <Icon name="search" size={14} />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            placeholder={mode === "go" ? "Go to request, folder, environment… (type > for actions)" : "Search inside URLs, headers, bodies and scripts"}
            spellCheck={false}
          />
          <div className="seg palette-modes">
            <button className={`seg-btn ${mode === "go" ? "active" : ""}`} onClick={() => setMode("go")}>Go to</button>
            <button className={`seg-btn ${mode === "search" ? "active" : ""}`} onClick={() => setMode("search")}>Search</button>
          </div>
        </div>
        <div className="palette-list" ref={listRef}>
          {rows.length === 0 && (
            <div className="palette-empty">
              {mode === "search" && query.length < 2 ? "Type at least 2 characters to search inside requests." : "No matches"}
            </div>
          )}
          {rows.map((row, i) => (
            <div
              key={row.type === "entry" ? row.entry.id : row.type === "action" ? row.action.id : row.key}
              className={`palette-row ${i === sel ? "selected" : ""}`}
              onMouseMove={() => { if (i !== sel) setSel(i); }}
              onClick={() => run(row)}
            >
              <PaletteRow row={row} />
            </div>
          ))}
        </div>
        <div className="palette-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>Tab</kbd> {mode === "go" ? "search inside requests" : "go to"}</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function PaletteRow({ row }: { row: Row }) {
  if (row.type === "action") {
    return (
      <>
        <span className="palette-icon"><Icon name="bolt" size={13} /></span>
        <span className="palette-text"><span className="palette-title">{row.action.title}</span>{row.action.subtitle && <span className="palette-sub">{row.action.subtitle}</span>}</span>
        {row.action.shortcut && <span className="palette-kbd">{row.action.shortcut}</span>}
      </>
    );
  }
  if (row.type === "content") {
    const h = row.hit;
    return (
      <>
        <span className="palette-icon method-badge" style={{ color: methodColor(h.method) }}>{h.method}</span>
        <span className="palette-text">
          <span className="palette-title">{h.name} <span className="palette-field">{h.field}</span></span>
          <span className="palette-sub mono">
            {h.snippet.slice(0, h.start)}<mark>{h.snippet.slice(h.start, h.end)}</mark>{h.snippet.slice(h.end)}
          </span>
        </span>
        <span className="palette-kbd ellipsis">{h.path}</span>
      </>
    );
  }
  const e = row.entry;
  const icon = e.target.kind === "collection" ? "collection" : e.target.kind === "folder" ? "folder" : e.target.kind === "environment" ? "env" : null;
  return (
    <>
      <span className="palette-icon">
        {e.target.kind === "request"
          ? <span className="method-badge" style={{ color: methodColor(e.target.method) }}>{e.target.method}</span>
          : <Icon name={icon!} size={13} />}
      </span>
      <span className="palette-text"><span className="palette-title">{e.title}</span><span className="palette-sub">{e.subtitle}</span></span>
    </>
  );
}
