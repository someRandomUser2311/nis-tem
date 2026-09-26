import { useEffect, useRef, useState } from "react";
import type { Tab } from "./types";
import { newRequestTab, openModal, primaryAction, saveTab, toggleConsole, updateSettings, useStore } from "./store";
import { ConsolePanel } from "./components/ConsolePanel";
import { CollectionEditor, EnvironmentEditor, FolderEditor, GlobalsEditor } from "./components/ContainerEditor";
import { Header } from "./components/Header";
import { ModalHost } from "./components/Modals";
import { RequestEditor } from "./components/RequestEditor";
import { RunnerView } from "./components/RunnerView";
import { ExampleView } from "./components/ExampleView";
import { ServerView } from "./components/ServerViews";
import { LoadTestView } from "./components/LoadTestView";
import { ToolView } from "./components/tools";
import { DocsView } from "./components/docs/DocsView";
import { Sidebar } from "./components/Sidebar";
import { requestCloseTab, TabBar } from "./components/TabBar";
import { Empty, Icon, MenuHost, Splitter } from "./components/ui";
import { VarProvider } from "./components/VarContext";
import { applyTheme } from "./themes";

function TabContent({ tab }: { tab: Tab }) {
  switch (tab.kind) {
    case "request":
      return <VarProvider collectionId={tab.saved?.collectionId}><RequestEditor tab={tab} /></VarProvider>;
    case "collection": return <CollectionEditor tab={tab} />;
    case "folder": return <FolderEditor tab={tab} />;
    case "environment": return <EnvironmentEditor tab={tab} />;
    case "globals": return <GlobalsEditor />;
    case "runner": return <RunnerView tab={tab} />;
    case "example": return <ExampleView tab={tab} />;
    case "server": return <ServerView tab={tab} />;
    case "loadtest": return <VarProvider collectionId={tab.saved?.collectionId}><LoadTestView tab={tab} /></VarProvider>;
    case "tool": return <ToolView tab={tab} />;
    case "docs": return <DocsView tab={tab} />;
  }
}

export default function App() {
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const consoleOpen = useStore((s) => s.consoleOpen);
  const settings = useStore((s) => s.settings);
  const consoleErrors = useStore((s) => s.console.filter((c) => c.level === "error").length);
  const [sidebarW, setSidebarW] = useState(() => Number(localStorage.getItem("lp.sidebarW") ?? 320));
  const sidebarStart = useRef(sidebarW);

  useEffect(() => {
    applyTheme(settings.theme, settings.mode);
    document.documentElement.style.setProperty("--code-font-size", `${settings.fontSize}px`);
  }, [settings.theme, settings.mode, settings.fontSize]);

  // Global keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const s = useStore.getState();
      const tab = s.tabs.find((t) => t.id === s.activeTabId);
      const k = e.key.toLowerCase();
      if (k === "enter" && tab?.kind === "request") { e.preventDefault(); primaryAction(tab.id); }
      else if (k === "s" && tab?.kind === "request") { e.preventDefault(); saveTab(tab.id); }
      else if ((k === "k" || k === "p") && !e.shiftKey) { e.preventDefault(); openModal({ kind: "palette", mode: "go" }); }
      else if (k === "f" && e.shiftKey) { e.preventDefault(); openModal({ kind: "palette", mode: "search" }); }
      else if (k === "t" && !e.shiftKey) { e.preventDefault(); newRequestTab(); }
      else if (k === "w" && tab) { e.preventDefault(); requestCloseTab(tab); }
      else if (k === "o") { e.preventDefault(); openModal({ kind: "import" }); }
      else if (k === ",") { e.preventDefault(); openModal({ kind: "settings" }); }
      else if (e.code === "KeyC" && e.altKey) { e.preventDefault(); toggleConsole(); }
      else if (k === "\\") { e.preventDefault(); setSidebarW((w) => (w < 80 ? 320 : 0)); }
      else if ((k === "tab" || k === "]" || k === "[") && s.tabs.length > 1 && (k !== "tab" || e.ctrlKey)) {
        e.preventDefault();
        const idx = s.tabs.findIndex((t) => t.id === s.activeTabId);
        const dir = k === "[" || (k === "tab" && e.shiftKey) ? -1 : 1;
        useStore.setState({ activeTabId: s.tabs[(idx + dir + s.tabs.length) % s.tabs.length].id });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="app">
      <Header />
      <div className="main">
        {sidebarW > 0 && <Sidebar width={sidebarW} />}
        <Splitter
          direction="horizontal"
          onStart={() => { sidebarStart.current = sidebarW; }}
          onDrag={(d) => { const w = sidebarStart.current + d; setSidebarW(w < 180 ? 0 : Math.min(640, w)); }}
          onEnd={() => localStorage.setItem("lp.sidebarW", String(sidebarW || 320))}
        />
        <div className="workspace">
          <TabBar />
          <div className="tab-contents">
            {tabs.length === 0 && (
              <Empty icon="bolt" title="No open tabs">
                <button className="btn btn-primary" onClick={() => newRequestTab()}>New Request</button>
              </Empty>
            )}
            {/* Keep every tab mounted so editor state and running collection runs survive tab switches. */}
            {tabs.map((t) => (
              <div key={t.id} className="tab-content" style={{ display: t.id === activeTabId ? "flex" : "none" }}>
                <TabContent tab={t} />
              </div>
            ))}
          </div>
          {consoleOpen && <ConsolePanel />}
        </div>
      </div>
      <footer className="statusbar">
        <button className="status-btn" onClick={() => setSidebarW((w) => (w < 80 ? 320 : 0))} title="Toggle sidebar (⌘\)">
          <Icon name="layoutH" size={12} />
        </button>
        <button className={`status-btn ${consoleOpen ? "active" : ""}`} onClick={() => toggleConsole()} title="Console (⌘⌥C)">
          <Icon name="terminal" size={12} /> Console {consoleErrors > 0 && <span className="status-err">{consoleErrors}</span>}
        </button>
        <span className="status-note"><Icon name="lock" size={11} /> Offline-first · no account · no telemetry</span>
        <div className="flex-1" />
        <button className="status-btn" onClick={() => openModal({ kind: "cookies" })}><Icon name="cookie" size={12} /> Cookies</button>
        <button className="status-btn" onClick={() => updateSettings({ layout: settings.layout === "vertical" ? "horizontal" : "vertical" })} title="Toggle two-pane layout">
          <Icon name={settings.layout === "vertical" ? "layout" : "layoutH"} size={12} />
        </button>
        <button className="status-btn" onClick={() => updateSettings({ mode: settings.mode === "dark" ? "light" : "dark" })} title="Toggle dark / light mode">
          <Icon name={settings.mode === "dark" ? "sun" : "moon"} size={12} />
        </button>
      </footer>
      <ModalHost />
      <MenuHost />
    </div>
  );
}
