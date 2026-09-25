// Editors for collections, folders, environments and globals.
import { useState } from "react";
import type { Collection, FolderItem, Tab } from "../types";
import { exportCollectionFile, exportDocsFile, exportEnvironmentFile, exportOpenApiFile } from "./exporting";
import { findItem, findPath, flattenRequests } from "../lib/utils";
import {
  addFolder, addRequestTo, openSpecialTab, setActiveEnvironment, setGlobals, updateCollection, updateEnvironment, updateItem, useStore,
} from "../store";
import { AuthEditor, authLabel } from "./AuthEditor";
import { effectiveAuth } from "../lib/engine";
import { KeyValueTable } from "./KeyValueTable";
import { MarkdownField } from "./Markdown";
import { ScriptEditor } from "./ScriptEditor";
import { EditableText, Empty, Icon, menuFromEvent, Tabs } from "./ui";
import { VarProvider } from "./VarContext";

type CTab = "overview" | "auth" | "scripts" | "variables";

export function CollectionEditor({ tab }: { tab: Tab }) {
  const collection = useStore((s) => s.collections.find((c) => c.id === tab.collectionId));
  const [sub, setSub] = useState<CTab>("overview");
  if (!collection) return <Empty icon="collection" title="This collection no longer exists" />;
  const set = (patch: Partial<Collection>) => updateCollection(collection.id, patch);
  const requests = flattenRequests(collection.items);

  const exportIt = () => exportCollectionFile(collection);

  return (
    <VarProvider collectionId={collection.id}>
      <div className="container-editor">
        <div className="container-header">
          <Icon name="collection" size={18} />
          <EditableText className="container-title" value={collection.name} onChange={(name) => set({ name })} />
          <div className="flex-1" />
          <button className="btn" onClick={() => addRequestTo(collection.id, null)}><Icon name="plus" /> Add request</button>
          <button className="btn" onClick={() => addFolder(collection.id, null, "New Folder")}><Icon name="folder" /> Add folder</button>
          <button className="btn" onClick={(e) => menuFromEvent(e, [
            { label: "Postman Collection v2.1…", onClick: exportIt },
            { label: "OpenAPI 3.1 (YAML)…", onClick: () => exportOpenApiFile(collection, "yaml") },
            { label: "OpenAPI 3.1 (JSON)…", onClick: () => exportOpenApiFile(collection, "json") },
            { divider: true },
            { label: "HTML documentation…", onClick: () => exportDocsFile(collection) },
          ])}><Icon name="export" /> Export <Icon name="chevronDown" size={11} /></button>
          <button className="btn btn-primary" onClick={() => openSpecialTab("runner", { collectionId: collection.id })}><Icon name="play" /> Run</button>
        </div>
        <Tabs
          value={sub}
          onChange={setSub}
          tabs={[
            { id: "overview", label: "Overview" },
            { id: "auth", label: "Authorization" },
            { id: "scripts", label: "Scripts" },
            { id: "variables", label: "Variables", badge: collection.variables.filter((v) => v.enabled && v.key).length || undefined },
          ]}
        />
        <div className="container-content">
          {sub === "overview" && (
            <div className="overview">
              <div className="stat-row">
                <div className="stat"><div className="stat-value">{requests.length}</div><div className="stat-label">Requests</div></div>
                <div className="stat"><div className="stat-value">{countFolders(collection.items)}</div><div className="stat-label">Folders</div></div>
                <div className="stat"><div className="stat-value">{collection.variables.length}</div><div className="stat-label">Variables</div></div>
                <div className="stat"><div className="stat-value">{authLabel(collection.auth.type)}</div><div className="stat-label">Authorization</div></div>
              </div>
              <label className="field-label">Description</label>
              <MarkdownField value={collection.description} placeholder="Add a description to document this collection… (Markdown)" onChange={(description) => set({ description })} />
            </div>
          )}
          {sub === "auth" && (
            <>
              <p className="help pad">This authorization method will be used for every request in this collection unless a request or folder overrides it.</p>
              <AuthEditor auth={collection.auth} onChange={(auth) => set({ auth })} allowInherit={false} subject="collection" />
            </>
          )}
          {sub === "scripts" && (
            <ScriptEditor pre={collection.preRequestScript} test={collection.testScript} onChange={(p) => set(p)} />
          )}
          {sub === "variables" && (
            <>
              <p className="help pad">Collection variables are available to every request in this collection. Use them with <code>{"{{variable}}"}</code>.</p>
              <KeyValueTable rows={collection.variables} onChange={(variables) => set({ variables })} variant="variables" />
            </>
          )}
        </div>
      </div>
    </VarProvider>
  );
}

function countFolders(items: Collection["items"]): number {
  return items.reduce((n, i) => (i.type === "folder" ? n + 1 + countFolders(i.items) : n), 0);
}

export function FolderEditor({ tab }: { tab: Tab }) {
  const collection = useStore((s) => s.collections.find((c) => c.id === tab.collectionId));
  const [sub, setSub] = useState<Exclude<CTab, "variables">>("overview");
  const folder = collection && tab.folderId ? (findItem(collection.items, tab.folderId) as FolderItem | undefined) : undefined;
  if (!collection || !folder) return <Empty icon="folder" title="This folder no longer exists" />;
  const set = (patch: Partial<FolderItem>) => updateItem(collection.id, folder.id, patch);
  const path = findPath(collection.items, folder.id) ?? [];
  const eff = effectiveAuth(folder, path, collection);

  return (
    <VarProvider collectionId={collection.id}>
      <div className="container-editor">
        <div className="container-header">
          <Icon name="folder" size={18} />
          <span className="muted">{collection.name} /</span>
          <EditableText className="container-title" value={folder.name} onChange={(name) => set({ name })} />
          <div className="flex-1" />
          <button className="btn" onClick={() => addRequestTo(collection.id, folder.id)}><Icon name="plus" /> Add request</button>
          <button className="btn" onClick={() => addFolder(collection.id, folder.id, "New Folder")}><Icon name="folder" /> Add folder</button>
          <button className="btn btn-primary" onClick={() => openSpecialTab("runner", { collectionId: collection.id, folderId: folder.id })}><Icon name="play" /> Run</button>
        </div>
        <Tabs value={sub} onChange={setSub} tabs={[{ id: "overview", label: "Overview" }, { id: "auth", label: "Authorization" }, { id: "scripts", label: "Scripts" }]} />
        <div className="container-content">
          {sub === "overview" && (
            <div className="overview">
              <div className="stat-row">
                <div className="stat"><div className="stat-value">{flattenRequests(folder.items).length}</div><div className="stat-label">Requests</div></div>
                <div className="stat"><div className="stat-value">{authLabel(folder.auth.type === "inherit" ? eff.type : folder.auth.type)}</div><div className="stat-label">Authorization{folder.auth.type === "inherit" ? " (inherited)" : ""}</div></div>
              </div>
              <label className="field-label">Description</label>
              <MarkdownField value={folder.description} placeholder="Add a description to document this folder… (Markdown)" onChange={(description) => set({ description })} />
            </div>
          )}
          {sub === "auth" && (
            <AuthEditor
              auth={folder.auth}
              onChange={(auth) => set({ auth })}
              subject="folder"
              inheritedFrom={`${authLabel(eff.type)} from ${[...path].reverse().find((f) => f.auth.type !== "inherit") ? "a parent folder" : `collection "${collection.name}"`}`}
            />
          )}
          {sub === "scripts" && <ScriptEditor pre={folder.preRequestScript} test={folder.testScript} onChange={(p) => set(p)} />}
        </div>
      </div>
    </VarProvider>
  );
}

export function EnvironmentEditor({ tab }: { tab: Tab }) {
  const env = useStore((s) => s.environments.find((e) => e.id === tab.environmentId));
  const activeId = useStore((s) => s.activeEnvironmentId);
  const [filter, setFilter] = useState("");
  if (!env) return <Empty icon="env" title="This environment no longer exists" />;
  const isActive = activeId === env.id;
  const exportIt = () => exportEnvironmentFile(env);
  const q = filter.toLowerCase();
  const shown = q ? env.variables.filter((v) => v.key.toLowerCase().includes(q)) : env.variables;
  return (
    <VarProvider>
      <div className="container-editor">
        <div className="container-header">
          <Icon name="env" size={18} />
          <EditableText className="container-title" value={env.name} onChange={(name) => updateEnvironment(env.id, { name })} />
          {isActive && <span className="pill">Active</span>}
          <div className="flex-1" />
          <div className="search-box inline">
            <Icon name="search" size={12} />
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter variables" />
          </div>
          <button className="btn" onClick={exportIt}><Icon name="export" /> Export</button>
          <button className={`btn ${isActive ? "" : "btn-primary"}`} onClick={() => setActiveEnvironment(isActive ? null : env.id)}>
            {isActive ? "Deactivate" : "Set active"}
          </button>
        </div>
        <div className="container-content">
          <p className="help pad">Variables are stored only on this computer. Mark sensitive values as <b>secret</b> to mask them on screen.</p>
          <KeyValueTable
            rows={shown}
            onChange={(rows) => updateEnvironment(env.id, { variables: q ? mergeFiltered(env.variables, shown, rows) : rows })}
            variant="variables"
          />
        </div>
      </div>
    </VarProvider>
  );
}

export function GlobalsEditor() {
  const globals = useStore((s) => s.globals);
  const exportIt = () => exportEnvironmentFile({ id: "globals", name: "Globals", variables: globals }, "globals");
  return (
    <VarProvider>
      <div className="container-editor">
        <div className="container-header">
          <Icon name="env" size={18} />
          <span className="container-title">Globals</span>
          <div className="flex-1" />
          <button className="btn" onClick={exportIt}><Icon name="export" /> Export</button>
        </div>
        <div className="container-content">
          <p className="help pad">Global variables are available in every request, regardless of the active environment.</p>
          <KeyValueTable rows={globals} onChange={setGlobals} variant="variables" />
        </div>
      </div>
    </VarProvider>
  );
}

/** Apply edits made to a filtered subset back onto the full list. */
function mergeFiltered<T extends { id: string }>(all: T[], shown: T[], edited: T[]): T[] {
  const shownIds = new Set(shown.map((s) => s.id));
  const editedById = new Map(edited.map((e) => [e.id, e]));
  const out = all.filter((a) => !shownIds.has(a.id) || editedById.has(a.id)).map((a) => editedById.get(a.id) ?? a);
  for (const e of edited) if (!all.some((a) => a.id === e.id)) out.push(e);
  return out;
}
