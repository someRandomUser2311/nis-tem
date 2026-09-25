import type { Tab } from "../types";
import { findItem, methodColor, requestBadge } from "../lib/utils";
import { useEffect } from "react";
import { choiceDialog, closeOtherTabs, closeTab, newRequestTab, saveTab, setActiveTab, useStore } from "../store";
import { toolById } from "./tools";
import { Icon, IconButton, menuFromEvent } from "./ui";

export function useTabTitle(tab: Tab): { title: string; icon?: string; method?: string } {
  const collections = useStore((s) => s.collections);
  const environments = useStore((s) => s.environments);
  const servers = useStore((s) => s.servers);
  switch (tab.kind) {
    case "request": return { title: tab.draft?.name ?? "Request", method: tab.draft ? requestBadge(tab.draft) : undefined };
    case "collection": return { title: collections.find((c) => c.id === tab.collectionId)?.name ?? "Collection", icon: "collection" };
    case "folder": {
      const c = collections.find((x) => x.id === tab.collectionId);
      const f = c && tab.folderId ? findItem(c.items, tab.folderId) : undefined;
      return { title: f?.name ?? "Folder", icon: "folder" };
    }
    case "runner": {
      const c = collections.find((x) => x.id === tab.collectionId);
      const f = c && tab.folderId ? findItem(c.items, tab.folderId) : undefined;
      return { title: `Runner · ${f?.name ?? c?.name ?? ""}`, icon: "play" };
    }
    case "environment": return { title: environments.find((e) => e.id === tab.environmentId)?.name ?? "Environment", icon: "env" };
    case "globals": return { title: "Globals", icon: "env" };
    case "example": {
      const c = collections.find((x) => x.id === tab.collectionId);
      const r = c && tab.requestId ? findItem(c.items, tab.requestId) : undefined;
      const ex = r?.type === "request" ? r.examples?.find((e) => e.id === tab.exampleId) : undefined;
      return { title: ex?.name ?? "Example", icon: "example" };
    }
    case "loadtest": return { title: `Load · ${tab.draft?.name ?? "request"}`, icon: "gauge" };
    case "tool": { const t = toolById(tab.toolId); return { title: t?.name ?? "Tool", icon: t?.icon ?? "tools" }; }
    case "server": {
      const d = servers.find((x) => x.id === tab.serverId);
      return { title: d?.name ?? "Server", icon: d?.kind === "catcher" ? "inbox" : "server" };
    }
  }
}

/** Close a tab, asking to save first when it has unsaved changes. */
export async function requestCloseTab(tab: Tab) {
  if (tab.kind === "request" && tab.dirty) {
    const choice = await choiceDialog("Unsaved changes", `Do you want to save the changes you made to "${tab.draft?.name}"?`, [
      { label: "Don't save", value: "discard", variant: "danger" },
      { label: "Cancel", value: "cancel" },
      { label: "Save changes", value: "save", variant: "primary" },
    ]);
    if (choice === "discard") closeTab(tab.id);
    // Unsaved-anywhere requests open "Save As" instead; the tab then stays open.
    else if (choice === "save" && saveTab(tab.id)) closeTab(tab.id);
    return;
  }
  closeTab(tab.id);
}

function TabItem({ tab, active }: { tab: Tab; active: boolean }) {
  const { title, icon, method } = useTabTitle(tab);
  return (
    <div
      className={`tab ${active ? "active" : ""} ${tab.dirty ? "dirty" : ""}`}
      onClick={() => setActiveTab(tab.id)}
      onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); requestCloseTab(tab); } }}
      onContextMenu={(e) => menuFromEvent(e, [
        ...(tab.kind === "request" ? [{ label: "Save", onClick: () => saveTab(tab.id) }, { divider: true }] : []),
        { label: "Duplicate tab", disabled: tab.kind !== "request", onClick: () => tab.draft && newRequestTab({ ...tab.draft, name: `${tab.draft.name} Copy` }) },
        { label: "Close tab", onClick: () => requestCloseTab(tab) },
        { label: "Close other tabs", onClick: () => closeOtherTabs(tab.id) },
      ])}
      title={title}
    >
      {method ? <span className="tab-method" style={{ color: methodColor(method) }}>{method}</span> : icon ? <Icon name={icon} size={12} /> : null}
      <span className="tab-title">{title}</span>
      <span className="tab-close-wrap">
        {tab.dirty && <span className="tab-dirty" />}
        <button className="tab-close" onClick={(e) => { e.stopPropagation(); requestCloseTab(tab); }} title="Close (⌘W)">
          <Icon name="close" size={10} />
        </button>
      </span>
    </div>
  );
}

export function TabBar() {
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  useEffect(() => {
    document.querySelector(".tabs-scroll .tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTabId, tabs.length]);
  return (
    <div className="tabbar">
      <div className="tabs-scroll" onWheel={(e) => { (e.currentTarget as HTMLElement).scrollLeft += e.deltaY; }}>
        {tabs.map((t) => <TabItem key={t.id} tab={t} active={t.id === activeTabId} />)}
      </div>
      <IconButton icon="plus" title="New request (⌘T)" onClick={() => newRequestTab()} className="tab-new" />
    </div>
  );
}
