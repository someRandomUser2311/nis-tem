import { useState } from "react";
import {
  createCollection, createEnvironment, newRequestTab, openModal, openSpecialTab, setActiveEnvironment, setSidebarView, useStore,
} from "../store";
import { Icon, IconButton, menuFromEvent } from "./ui";
import { Logo } from "./Logo";
import { defaultWs } from "./LiveViews";
import { WorkspaceSwitcher } from "./Workspaces";
import { shortcutLabel } from "../lib/platform";

export function Header() {
  const environments = useStore((s) => s.environments);
  const activeId = useStore((s) => s.activeEnvironmentId);
  const [peek, setPeek] = useState(false);

  return (
    <header className="header">
      <div className="brand">
        <Logo size={28} className="brand-logo" />
        <span>Localpost</span>
      </div>
      <WorkspaceSwitcher />
      <button className="btn btn-sm" onClick={(e) => menuFromEvent(e, [
        { label: "HTTP Request", shortcut: shortcutLabel("⌘T"), onClick: () => newRequestTab() },
        { label: "WebSocket", onClick: () => newRequestTab({ name: "WebSocket", protocol: "ws", ws: defaultWs() }) },
        { label: "Server-Sent Events", onClick: () => newRequestTab({ name: "Event stream", protocol: "sse" }) },
        { label: "Collection", onClick: () => { const c = createCollection(); setSidebarView("collections"); openSpecialTab("collection", { collectionId: c.id }); } },
        { label: "Environment", onClick: () => { const e = createEnvironment(); setSidebarView("environments"); openSpecialTab("environment", { environmentId: e.id }); } },
      ])}>
        <Icon name="plus" size={12} /> New
      </button>
      <button className="btn btn-sm" onClick={() => openModal({ kind: "import" })} title={`Import (${shortcutLabel("⌘O")})`}>
        <Icon name="import" size={12} /> Import
      </button>
      <div className="local-badge" title="Everything is stored on this computer. No account, no sync, no telemetry.">
        <Icon name="lock" size={11} /> Local workspace
      </div>
      <div className="flex-1" />
      <button className="header-search" onClick={() => openModal({ kind: "palette", mode: "go" })} title={`Search and commands (${shortcutLabel("⌘K")})`}>
        <Icon name="search" size={13} />
        <span className="header-search-text">Search requests, environments, actions</span>
        <kbd>{shortcutLabel("⌘K")}</kbd>
      </button>
      <div className="flex-1" />
      <div className="env-select">
        <select value={activeId ?? ""} onChange={(e) => setActiveEnvironment(e.target.value || null)}>
          <option value="">No environment</option>
          {environments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
        <Icon name="chevronDown" size={12} />
      </div>
      <div className="peek-wrap">
        <IconButton icon="eye" title="Environment quick look" active={peek} onClick={() => setPeek(!peek)} />
        {peek && <EnvPeek onClose={() => setPeek(false)} />}
      </div>
      <IconButton icon="cookie" title="Cookies" onClick={() => openModal({ kind: "cookies" })} />
      <IconButton icon="gear" title={`Settings (${shortcutLabel("⌘,")})`} onClick={() => openModal({ kind: "settings" })} />
    </header>
  );
}

function EnvPeek({ onClose }: { onClose: () => void }) {
  const env = useStore((s) => s.environments.find((e) => e.id === s.activeEnvironmentId));
  const globals = useStore((s) => s.globals);
  const section = (title: string, vars: typeof globals, onEdit: () => void) => (
    <div className="peek-section">
      <div className="peek-head"><span>{title}</span><button className="link-btn" onClick={() => { onEdit(); onClose(); }}>Edit</button></div>
      {vars.filter((v) => v.key).length === 0 ? <div className="muted">No variables</div> : (
        <table className="peek-table">
          <tbody>
            {vars.filter((v) => v.key).map((v) => (
              <tr key={v.id} className={v.enabled ? "" : "disabled"}>
                <td className="mono">{v.key}</td>
                <td className="mono ellipsis">{v.secret ? "••••••" : v.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
  return (
    <>
      <div className="peek-backdrop" onClick={onClose} />
      <div className="peek">
        {env ? section(env.name, env.variables, () => openSpecialTab("environment", { environmentId: env.id })) : (
          <div className="peek-section"><div className="peek-head"><span>No active environment</span></div><div className="muted">Select an environment from the dropdown to use its variables.</div></div>
        )}
        {section("Globals", globals, () => openSpecialTab("globals"))}
      </div>
    </>
  );
}
