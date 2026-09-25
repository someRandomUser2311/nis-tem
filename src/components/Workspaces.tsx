// Workspace switcher (header) and the "Manage workspaces" dialog.
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { closeModal, confirmDialog, openModal, prompt, switchWorkspace } from "../store";
import { Icon, menuFromEvent, ModalFrame } from "./ui";

type Registry = Awaited<ReturnType<typeof api.workspaceList>>;

function useRegistry() {
  const [reg, setReg] = useState<Registry | null>(null);
  const refresh = () => api.workspaceList().then(setReg).catch(() => setReg(null));
  useEffect(() => { refresh(); }, []);
  return [reg, refresh] as const;
}

async function newWorkspace() {
  const name = await prompt("New workspace", "", "Name", "Create");
  if (!name?.trim()) return;
  const w = await api.workspaceCreate(name.trim());
  await switchWorkspace(w.id);
}

async function openFolderWorkspace() {
  const dir = await open({ directory: true, multiple: false, title: "Open a folder as a workspace (e.g. a synced drive or a git repository)" });
  if (typeof dir !== "string") return;
  const w = await api.workspaceCreate(dir.split(/[\\/]/).pop() || "Workspace", dir);
  await switchWorkspace(w.id);
}

export function WorkspaceSwitcher() {
  const [reg] = useRegistry();
  if (!reg) return null;
  const active = reg.workspaces.find((w) => w.id === reg.active);
  return (
    <button
      className="btn btn-sm workspace-btn"
      title={active?.path}
      onClick={(e) => menuFromEvent(e, [
        ...reg.workspaces.map((w) => ({ label: w.name, checked: w.id === reg.active, onClick: () => { if (w.id !== reg.active) switchWorkspace(w.id); } })),
        { divider: true },
        { label: "New workspace…", onClick: newWorkspace },
        { label: "Open folder as workspace…", onClick: openFolderWorkspace },
        { label: "Manage workspaces…", onClick: () => openModal({ kind: "workspaces" }) },
      ])}
    >
      <Icon name="layout" size={12} />
      <span className="workspace-name">{active?.name ?? "Workspace"}</span>
      <Icon name="chevronDown" size={11} />
    </button>
  );
}

export function WorkspacesModal() {
  const [reg, refresh] = useRegistry();
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try { await fn(); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  return (
    <ModalFrame title="Workspaces" onClose={closeModal} width={680}
      footer={<>
        <button className="btn" onClick={() => run(newWorkspace)}><Icon name="plus" size={12} /> New workspace</button>
        <button className="btn" onClick={() => run(openFolderWorkspace)}><Icon name="folder" size={12} /> Open folder…</button>
        <div className="flex-1" />
        <button className="btn" onClick={closeModal}>Close</button>
      </>}>
      <p className="help">
        Each workspace is its own folder with separate collections, environments, history, cookies and settings.
        Open a folder inside a synced drive or a git repository to share a workspace without any cloud service.
      </p>
      {error && <p className="err-text">{error}</p>}
      <div className="picker">
        {reg?.workspaces.map((w) => (
          <div key={w.id} className={`picker-row workspace-row ${w.id === reg.active ? "selected" : ""}`}>
            <div className="flex-1" style={{ minWidth: 0 }}>
              <div><b>{w.name}</b>{w.id === reg.active && <span className="pill" style={{ marginLeft: 8 }}>Active</span>}</div>
              <div className="muted mono ellipsis" style={{ fontSize: 11.5 }} title={w.path}>{w.path}</div>
            </div>
            {w.id !== reg.active && <button className="btn btn-sm" onClick={() => switchWorkspace(w.id)}>Switch</button>}
            <button className="btn btn-sm" onClick={() => revealItemInDir(w.path).catch(() => {})}>Show</button>
            <button className="btn btn-sm" onClick={() => run(async () => {
              const name = await prompt("Rename workspace", w.name, "Name", "Rename");
              if (name?.trim()) await api.workspaceRename(w.id, name.trim());
              openModal({ kind: "workspaces" });
            })}>Rename</button>
            {w.id !== "default" && w.id !== reg.active && (
              <button className="btn btn-sm" onClick={() => run(async () => {
                if (await confirmDialog("Remove workspace", `Remove "${w.name}" from the list? Its files stay in ${w.path}.`, { confirmText: "Remove", danger: true })) await api.workspaceRemove(w.id);
                openModal({ kind: "workspaces" });
              })}>Remove</button>
            )}
          </div>
        ))}
      </div>
    </ModalFrame>
  );
}
