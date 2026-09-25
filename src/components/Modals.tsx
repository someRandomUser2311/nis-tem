import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useEffect, useMemo, useState } from "react";
import type { ClientCertificate, Collection, Item } from "../types";
import { api, type CookieInfo } from "../lib/api";
import { generate, LANGUAGES, type LanguageId } from "../lib/codegen";
import { effectiveAuth, prepareRequest } from "../lib/engine";
import { detectImport, SUPPORTED_FORMATS, type Detected } from "../lib/importexport";
import { importBrunoFolder } from "../lib/importers";
import { emptyScopes } from "../lib/vars";
import { clone, findPath, uid } from "../lib/utils";
import {
  addCollections, addEnvironments, buildScopes, clearHistory, closeModal, confirmDialog, createCollection, newRequestTab, openLinkedFolder, saveTabAs, setKeychainStorage,
  setGlobals, updateSettings, useStore, type Modal,
} from "../store";
import { CodeEditor } from "./CodeEditor";
import { Icon, ModalFrame, Toggle } from "./ui";
import { Logo } from "./Logo";
import { CommandPalette } from "./CommandPalette";
import { exportBackupFile } from "./exporting";
import { WorkspacesModal } from "./Workspaces";
import { DiffModal, EnvCompareModal, ReplaceModal } from "./WorkspaceModals";
import { resolveTheme, THEMES, userThemesDir } from "../themes";

export function ModalHost() {
  const modal = useStore((s) => s.modal);
  if (!modal) return null;
  switch (modal.kind) {
    case "save": return <SaveModal tabId={modal.tabId} />;
    case "import": return <ImportModal />;
    case "settings": return <SettingsModal />;
    case "cookies": return <CookiesModal />;
    case "codegen": return <CodegenModal tabId={modal.tabId} />;
    case "prompt": return <PromptModal modal={modal} />;
    case "confirm": return <ConfirmModal modal={modal} />;
    case "choice": return <ChoiceModal modal={modal} />;
    case "palette": return <CommandPalette mode={modal.mode} query={modal.query} />;
    case "replace": return <ReplaceModal collectionId={modal.collectionId} />;
    case "envCompare": return <EnvCompareModal a={modal.a} b={modal.b} />;
    case "diff": return <DiffModal modal={modal} />;
    case "workspaces": return <WorkspacesModal />;
  }
}

// ---------------------------------------------------------------- prompt / confirm

function PromptModal({ modal }: { modal: Extract<Modal, { kind: "prompt" }> }) {
  const [value, setValue] = useState(modal.value);
  const done = (v: string | null) => { closeModal(); modal.resolve(v); };
  return (
    <ModalFrame title={modal.title} onClose={() => done(null)} width={420}
      footer={<><button className="btn" onClick={() => done(null)}>Cancel</button><button className="btn btn-primary" onClick={() => done(value)}>{modal.confirmText ?? "OK"}</button></>}>
      {modal.label && <label className="field-label">{modal.label}</label>}
      <input className="input" autoFocus value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") done(value); }} onFocus={(e) => e.target.select()} />
    </ModalFrame>
  );
}

function ConfirmModal({ modal }: { modal: Extract<Modal, { kind: "confirm" }> }) {
  const done = (ok: boolean) => { closeModal(); modal.resolve(ok); };
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); done(true); } };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });
  return (
    <ModalFrame title={modal.title} onClose={() => done(false)} width={440}
      footer={<><button className="btn" onClick={() => done(false)}>Cancel</button><button className={`btn ${modal.danger ? "btn-danger" : "btn-primary"}`} onClick={() => done(true)}>{modal.confirmText ?? "OK"}</button></>}>
      <p className="confirm-msg">{modal.message}</p>
    </ModalFrame>
  );
}

function ChoiceModal({ modal }: { modal: Extract<Modal, { kind: "choice" }> }) {
  const done = (v: string | null) => { closeModal(); modal.resolve(v); };
  return (
    <ModalFrame title={modal.title} onClose={() => done(null)} width={460}
      footer={modal.choices.map((c, i) => (
        <span key={c.value} style={{ display: "contents" }}>
          {i === 1 && <div className="flex-1" />}
          <button className={`btn ${c.variant === "primary" ? "btn-primary" : c.variant === "danger" ? "btn-danger-outline" : ""}`} autoFocus={c.variant === "primary"} onClick={() => done(c.value)}>
            {c.label}
          </button>
        </span>
      ))}>
      <p className="confirm-msg">{modal.message}</p>
    </ModalFrame>
  );
}

// ---------------------------------------------------------------- save request

function SaveModal({ tabId }: { tabId: string }) {
  const tab = useStore((s) => s.tabs.find((t) => t.id === tabId));
  const collections = useStore((s) => s.collections);
  const [name, setName] = useState(tab?.draft?.name === "Untitled Request" ? "" : tab?.draft?.name ?? "");
  const [target, setTarget] = useState<{ collectionId: string; folderId: string | null } | null>(
    tab?.saved ? { collectionId: tab.saved.collectionId, folderId: null } : collections[0] ? { collectionId: collections[0].id, folderId: null } : null,
  );
  const [openIds, setOpenIds] = useState<Set<string>>(new Set(target ? [target.collectionId] : []));

  if (!tab?.draft) return null;

  const doSave = () => {
    if (!target) return;
    saveTabAs(tabId, target.collectionId, target.folderId, name.trim() || tab.draft!.url || "Untitled Request");
    closeModal();
  };

  const toggle = (id: string) => { const n = new Set(openIds); if (n.has(id)) n.delete(id); else n.add(id); setOpenIds(n); };

  const renderFolders = (c: Collection, items: Item[], depth: number): React.ReactNode =>
    items.filter((i) => i.type === "folder").map((f) => (
      <div key={f.id}>
        <div
          className={`picker-row ${target?.folderId === f.id ? "selected" : ""}`}
          style={{ paddingLeft: 10 + depth * 16 }}
          onClick={() => { setTarget({ collectionId: c.id, folderId: f.id }); toggle(f.id); }}
        >
          <Icon name={openIds.has(f.id) ? "folderOpen" : "folder"} /> {f.name}
        </div>
        {openIds.has(f.id) && f.type === "folder" && renderFolders(c, f.items, depth + 1)}
      </div>
    ));

  return (
    <ModalFrame title="Save request" onClose={closeModal} width={520}
      footer={<>
        <button className="btn" onClick={() => { const c = createCollection("New Collection"); setTarget({ collectionId: c.id, folderId: null }); }}>
          <Icon name="plus" /> New Collection
        </button>
        <div className="flex-1" />
        <button className="btn" onClick={closeModal}>Cancel</button>
        <button className="btn btn-primary" disabled={!target} onClick={doSave}>Save</button>
      </>}>
      <label className="field-label">Request name</label>
      <input className="input" autoFocus value={name} placeholder={tab.draft.url || "Request name"} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") doSave(); }} />
      <label className="field-label" style={{ marginTop: 14 }}>Save to</label>
      <div className="picker">
        {collections.length === 0 && <div className="muted pad">No collections yet — create one below.</div>}
        {collections.map((c) => (
          <div key={c.id}>
            <div
              className={`picker-row ${target?.collectionId === c.id && !target.folderId ? "selected" : ""}`}
              onClick={() => { setTarget({ collectionId: c.id, folderId: null }); toggle(c.id); }}
            >
              <Icon name={openIds.has(c.id) ? "chevronDown" : "chevronRight"} size={12} />
              <Icon name="collection" /> {c.name}
            </div>
            {openIds.has(c.id) && renderFolders(c, c.items, 1)}
          </div>
        ))}
      </div>
    </ModalFrame>
  );
}

// ---------------------------------------------------------------- import

function describe(d: Detected): string {
  switch (d.kind) {
    case "collection": return `Collection "${d.collection.name}"`;
    case "environment": return d.scope === "globals" ? "Globals" : `Environment "${d.environment.name}"`;
    case "request": return `Request ${d.request.method} ${d.request.url}`;
    case "workspace": return `Localpost backup (${d.data.collections.length} collections, ${d.data.environments.length} environments)`;
    case "bundle": return `${d.label}: ${d.collections.map((c) => `"${c.name}"`).join(", ") || "no collections"}${d.environments.length ? ` + ${d.environments.length} environment${d.environments.length === 1 ? "" : "s"}` : ""}`;
  }
}

function applyImport(items: Detected[]) {
  for (const d of items) {
    switch (d.kind) {
      case "collection": addCollections([d.collection]); break;
      case "environment":
        if (d.scope === "globals") setGlobals([...useStore.getState().globals, ...d.environment.variables]);
        else addEnvironments([d.environment]);
        break;
      case "request": newRequestTab(d.request); break;
      case "bundle":
        addCollections(d.collections);
        addEnvironments(d.environments);
        break;
      case "workspace":
        addCollections(d.data.collections);
        addEnvironments(d.data.environments);
        setGlobals([...useStore.getState().globals, ...(d.data.globals ?? [])]);
        break;
    }
  }
}

function ImportModal() {
  const [mode, setMode] = useState<"file" | "text">("file");
  const [text, setText] = useState("");
  const [found, setFound] = useState<{ source: string; item?: Detected; error?: string; info?: string }[]>([]);
  const [dragOver, setDragOver] = useState(false);

  const addSources = (sources: { name: string; content: string }[]) => {
    setFound((prev) => [...prev, ...sources.map((s) => {
      try { return { source: s.name, item: detectImport(s.content, s.name) }; } catch (e) { return { source: s.name, error: e instanceof Error ? e.message : String(e) }; }
    })]);
  };

  const pickFiles = async () => {
    const paths = await open({ multiple: true, filters: [{ name: "Collections, specs, HAR, cURL", extensions: ["json", "yaml", "yml", "har", "bru", "txt", "sh"] }, { name: "All files", extensions: ["*"] }] });
    if (!paths) return;
    const list = Array.isArray(paths) ? paths : [paths];
    addSources(await Promise.all(list.map(async (p) => ({ name: p.split(/[\\/]/).pop() ?? p, content: await api.readTextFile(p) }))));
  };

  const pickFolder = async () => {
    const dir = await open({ directory: true, multiple: false, title: "Choose a Bruno collection folder" });
    if (typeof dir !== "string") return;
    const name = dir.split(/[\\/]/).pop() ?? dir;
    try {
      const files = await api.readDirFiles(dir, ["bru", "json"]);
      if (files.some((f) => f.path === "collection.json")) {
        // A Localpost linked-collection folder: open it (stays linked).
        const c = await openLinkedFolder(dir);
        setFound((prev) => [...prev, { source: `${name}/`, info: `Opened linked collection “${c.name}”` }]);
        return;
      }
      if (!files.some((f) => f.path.endsWith(".bru"))) throw new Error("No collection.json (Localpost) or .bru files (Bruno) in this folder");
      const { collection, environments } = importBrunoFolder(files);
      setFound((prev) => [...prev, { source: `${name}/`, item: { kind: "bundle", label: "Bruno", collections: [collection], environments } }]);
    } catch (e) {
      setFound((prev) => [...prev, { source: `${name}/`, error: e instanceof Error ? e.message : String(e) }]);
    }
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = [...e.dataTransfer.files];
    addSources(await Promise.all(files.map(async (f) => ({ name: f.name, content: await f.text() }))));
  };

  const valid = found.filter((f) => f.item).map((f) => f.item!);

  return (
    <ModalFrame title="Import" onClose={closeModal} width={620}
      footer={<>
        <button className="btn" onClick={closeModal}>Cancel</button>
        <button className="btn btn-primary" disabled={!valid.length} onClick={() => { applyImport(valid); closeModal(); }}>
          Import{valid.length ? ` ${valid.length} item${valid.length > 1 ? "s" : ""}` : ""}
        </button>
      </>}>
      <p className="help">Supports {SUPPORTED_FORMATS}. Everything is imported locally.</p>
      <div className="seg" style={{ marginBottom: 12 }}>
        <button className={`seg-btn ${mode === "file" ? "active" : ""}`} onClick={() => setMode("file")}>File</button>
        <button className={`seg-btn ${mode === "text" ? "active" : ""}`} onClick={() => setMode("text")}>Paste raw text / cURL</button>
      </div>
      {mode === "file" ? (
        <div
          className={`dropzone ${dragOver ? "over" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        >
          <Icon name="import" size={28} />
          <div>Drop files here or</div>
          <div className="row gap">
            <button className="btn btn-primary" onClick={pickFiles}>Choose files</button>
            <button className="btn" onClick={pickFolder} title="A linked Localpost collection folder, or a Bruno collection folder">Choose folder…</button>
          </div>
        </div>
      ) : (
        <>
          <textarea className="textarea mono" rows={9} value={text} onChange={(e) => setText(e.target.value)}
            placeholder={"curl -X POST https://api.example.com/users -H 'Content-Type: application/json' -d '{\"name\":\"Ada\"}'\n\n…or paste Postman collection / environment JSON"} />
          <button className="btn" style={{ marginTop: 8 }} disabled={!text.trim()} onClick={() => { addSources([{ name: "Pasted text", content: text }]); setText(""); }}>
            Detect
          </button>
        </>
      )}
      {found.length > 0 && (
        <div className="import-list">
          {found.map((f, i) => (
            <div key={i} className={`import-row ${f.error ? "bad" : ""}`}>
              <Icon name={f.error ? "close" : "check"} />
              <span className="import-src">{f.source}</span>
              <span className="ellipsis">{f.item ? describe(f.item) : f.info ?? f.error}</span>
              <button className="icon-btn" onClick={() => setFound(found.filter((_, j) => j !== i))}><Icon name="trash" size={12} /></button>
            </div>
          ))}
        </div>
      )}
    </ModalFrame>
  );
}

// ---------------------------------------------------------------- settings

function SettingsModal() {
  const settings = useStore((s) => s.settings);
  const dataDir = useStore((s) => s.dataDir);
  const [section, setSection] = useState<"general" | "requests" | "proxy" | "certificates" | "data" | "about">("general");
  const [keychainError, setKeychainError] = useState<string | null>(null);

  const backup = exportBackupFile;

  return (
    <ModalFrame title="Settings" onClose={closeModal} width={760} className="settings-modal">
      <div className="settings">
        <div className="settings-nav">
          {(["general", "requests", "proxy", "certificates", "data", "about"] as const).map((s) => (
            <button key={s} className={`settings-nav-btn ${section === s ? "active" : ""}`} onClick={() => setSection(s)}>
              {s[0].toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
        <div className="settings-list">
          {section === "general" && (
            <>
              <div className="setting-row column">
                <div className="row">
                  <div className="flex-1"><div className="setting-title">Theme</div><div className="setting-desc">The overall look of the app. Each theme has a dark and a light mode. Drop a <code>&lt;name&gt;.css</code> into the themes folder to add your own (restart to load it).</div></div>
                  {userThemesDir && <button className="btn btn-sm" onClick={() => revealItemInDir(userThemesDir)}><Icon name="folder" size={12} /> Themes folder</button>}
                </div>
                <div className="theme-grid">
                  {THEMES.map((t) => {
                    const c = t.preview[settings.mode];
                    return (
                      <button key={t.id} className={`theme-card ${resolveTheme(settings.theme).id === t.id ? "active" : ""}`} onClick={() => updateSettings({ theme: t.id })}>
                        <span className="theme-swatch" style={{ background: c.frame }}>
                          <span className="theme-swatch-side" style={{ background: c.panel }} />
                          <span className="theme-swatch-main" style={{ background: c.panel }}>
                            <span style={{ background: c.text, opacity: 0.8 }} />
                            <span style={{ background: c.text, opacity: 0.35 }} />
                            <span className="theme-swatch-btn" style={{ background: c.accent }} />
                          </span>
                        </span>
                        <span className="theme-name">{t.name}{t.user && <span className="pill theme-user-pill">custom</span>}</span>
                        <span className="theme-desc">{t.description}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="setting-row">
                <div><div className="setting-title">Mode</div></div>
                <div className="seg">
                  {(["dark", "light"] as const).map((m) => (
                    <button key={m} className={`seg-btn ${settings.mode === m ? "active" : ""}`} onClick={() => updateSettings({ mode: m })}>
                      {m === "dark" ? "Dark" : "Light"}
                    </button>
                  ))}
                </div>
              </div>
              <div className="setting-row">
                <div><div className="setting-title">Editor font size</div></div>
                <input className="input input-sm" type="number" min={10} max={22} value={settings.fontSize} onChange={(e) => updateSettings({ fontSize: Number(e.target.value) || 13 })} />
              </div>
              <div className="setting-row">
                <div><div className="setting-title">Request / response layout</div><div className="setting-desc">Stack the response below the request, or place it side by side.</div></div>
                <select className="select" value={settings.layout} onChange={(e) => updateSettings({ layout: e.target.value as "vertical" | "horizontal" })}>
                  <option value="vertical">Stacked</option><option value="horizontal">Side by side</option>
                </select>
              </div>
            </>
          )}
          {section === "requests" && (
            <>
              <div className="setting-row">
                <div><div className="setting-title">Request timeout (ms)</div><div className="setting-desc">0 means never time out.</div></div>
                <input className="input input-sm" type="number" min={0} value={settings.timeoutMs} onChange={(e) => updateSettings({ timeoutMs: Math.max(0, Number(e.target.value) || 0) })} />
              </div>
              <div className="setting-row">
                <div><div className="setting-title">SSL certificate verification</div><div className="setting-desc">Turn off to allow self-signed certificates.</div></div>
                <Toggle checked={settings.verifySsl} onChange={(v) => updateSettings({ verifySsl: v })} />
              </div>
              <div className="setting-row">
                <div><div className="setting-title">Automatically follow redirects</div></div>
                <Toggle checked={settings.followRedirects} onChange={(v) => updateSettings({ followRedirects: v })} />
              </div>
              <div className="setting-row">
                <div><div className="setting-title">Maximum number of redirects</div></div>
                <input className="input input-sm" type="number" min={1} value={settings.maxRedirects} onChange={(e) => updateSettings({ maxRedirects: Math.max(1, Number(e.target.value) || 10) })} />
              </div>
              <div className="setting-row">
                <div><div className="setting-title">Cookie jar</div><div className="setting-desc">Store cookies from responses and send them with later requests (saved locally).</div></div>
                <Toggle checked={settings.useCookies} onChange={(v) => updateSettings({ useCookies: v })} />
              </div>
            </>
          )}
          {section === "proxy" && (
            <>
              <div className="setting-row">
                <div><div className="setting-title">Use system proxy</div><div className="setting-desc">Respect HTTP_PROXY / HTTPS_PROXY / NO_PROXY environment variables.</div></div>
                <Toggle checked={settings.useSystemProxy} onChange={(v) => updateSettings({ useSystemProxy: v })} />
              </div>
              <div className="setting-row column">
                <div><div className="setting-title">Custom proxy</div><div className="setting-desc">Overrides the system proxy. Supports http://, https://, socks5:// and socks5h:// (e.g. socks5h://127.0.0.1:1080).</div></div>
                <input className="input" value={settings.proxy} placeholder="http://user:pass@proxy.local:8080" onChange={(e) => updateSettings({ proxy: e.target.value })} />
              </div>
            </>
          )}
          {section === "certificates" && <CertificatesSection />}
          {section === "data" && (
            <>
              <div className="setting-row">
                <div>
                  <div className="setting-title">Store secret variables in the system keychain</div>
                  <div className="setting-desc">
                    Values of variables marked <b>secret</b> (environments, globals, collection variables) are kept in the {navigator.platform.startsWith("Mac") ? "macOS Keychain" : "OS credential store"} instead of the JSON files, so they don't end up in backups, syncs or git.
                    {keychainError && <span className="err-text"> {keychainError}</span>}
                  </div>
                </div>
                <Toggle checked={settings.useKeychain} onChange={async (on) => {
                  setKeychainError(null);
                  try { await setKeychainStorage(on); } catch (e) { setKeychainError(e instanceof Error ? e.message : String(e)); }
                }} />
              </div>
              <div className="setting-row column">
                <div><div className="setting-title">Data location</div><div className="setting-desc">All collections, environments, history, cookies and settings are plain JSON files in this folder. Nothing is ever uploaded.</div></div>
                <div className="row gap">
                  <code className="path">{dataDir}</code>
                  <button className="btn" onClick={() => revealItemInDir(dataDir + "/collections.json").catch(() => revealItemInDir(dataDir))}>Show in Finder</button>
                </div>
              </div>
              <div className="setting-row">
                <div><div className="setting-title">Back up workspace</div><div className="setting-desc">Export all collections, environments and globals to a single file. Import it from the Import dialog.</div></div>
                <button className="btn" onClick={backup}><Icon name="export" /> Export backup</button>
              </div>
              <div className="setting-row">
                <div><div className="setting-title">History limit</div><div className="setting-desc">Maximum number of requests kept in history.</div></div>
                <input className="input input-sm" type="number" min={0} value={settings.historyLimit} onChange={(e) => updateSettings({ historyLimit: Math.max(0, Number(e.target.value) || 0) })} />
              </div>
              <div className="setting-row">
                <div><div className="setting-title">Clear history</div></div>
                <button className="btn btn-danger" onClick={async () => { if (await confirmDialog("Clear history", "Delete all history entries?", { confirmText: "Clear", danger: true })) { clearHistory(); useStore.setState({ modal: { kind: "settings" } }); } }}>Clear</button>
              </div>
            </>
          )}
          {section === "about" && (
            <div className="about">
              <Logo size={56} className="about-logo" />
              <div className="about-title">Localpost 0.1.0</div>
              <p>A fully local API client. No accounts, no sign-in, no cloud sync, no telemetry, no analytics, no AI features.</p>
              <p>The app never contacts any server except the ones you send requests to.</p>
            </div>
          )}
        </div>
      </div>
    </ModalFrame>
  );
}

// ---------------------------------------------------------------- certificates

function CertificatesSection() {
  const settings = useStore((s) => s.settings);
  const certs = settings.certificates ?? [];
  const setCerts = (certificates: ClientCertificate[]) => updateSettings({ certificates });
  const patch = (id: string, p: Partial<ClientCertificate>) => setCerts(certs.map((c) => (c.id === id ? { ...c, ...p } : c)));
  const pick = async (title: string) => {
    const path = await open({ title, multiple: false, filters: [{ name: "PEM", extensions: ["pem", "crt", "cer", "key"] }, { name: "All files", extensions: ["*"] }] });
    return typeof path === "string" ? path : null;
  };
  return (
    <>
      <div className="setting-row column">
        <div>
          <div className="setting-title">CA certificates</div>
          <div className="setting-desc">Trust extra certificate authorities (a PEM file, may hold several), e.g. a company or local development CA. Used on top of the built-in roots.</div>
        </div>
        <div className="row gap">
          <code className="path">{settings.caPath || "None"}</code>
          <button className="btn" onClick={async () => { const p = await pick("Choose a CA certificate (PEM)"); if (p) updateSettings({ caPath: p }); }}>Choose…</button>
          {settings.caPath && <button className="btn" onClick={() => updateSettings({ caPath: "" })}>Remove</button>}
        </div>
      </div>
      <div className="setting-row column">
        <div>
          <div className="setting-title">Client certificates</div>
          <div className="setting-desc">
            Sent for mutual TLS when a request's host matches. Use <code>*.example.com</code> for subdomains and add <code>:port</code> to limit to one port.
            Certificates and keys must be PEM, with an unencrypted key (convert a .p12 with <code>openssl pkcs12 -in c.p12 -nodes -out c.pem</code>).
          </div>
        </div>
        {certs.length > 0 && (
          <table className="data-table cert-table">
            <thead><tr><th /><th>Host</th><th>Certificate</th><th>Key</th><th /></tr></thead>
            <tbody>
              {certs.map((c) => (
                <tr key={c.id}>
                  <td><input type="checkbox" checked={c.enabled} onChange={(e) => patch(c.id, { enabled: e.target.checked })} /></td>
                  <td><input className="input input-sm mono" style={{ width: "100%" }} value={c.host} placeholder="api.example.com" onChange={(e) => patch(c.id, { host: e.target.value })} /></td>
                  <td><button className="file-pick" title={c.certPath} onClick={async () => { const p = await pick("Client certificate (PEM)"); if (p) patch(c.id, { certPath: p }); }}>{c.certPath ? c.certPath.split(/[\\/]/).pop() : "Choose…"}</button></td>
                  <td><button className="file-pick" title={c.keyPath} onClick={async () => { const p = await pick("Private key (PEM)"); if (p) patch(c.id, { keyPath: p }); }}>{c.keyPath ? c.keyPath.split(/[\\/]/).pop() : "In cert file / choose…"}</button></td>
                  <td><button className="icon-btn" title="Remove" onClick={() => setCerts(certs.filter((x) => x.id !== c.id))}><Icon name="trash" size={12} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div><button className="btn" onClick={() => setCerts([...certs, { id: uid(), host: "", certPath: "", keyPath: "", enabled: true }])}><Icon name="plus" size={12} /> Add certificate</button></div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- cookies

function CookiesModal() {
  const [cookies, setCookies] = useState<CookieInfo[]>([]);
  const [filter, setFilter] = useState("");
  const refresh = () => api.listCookies().then(setCookies);
  useEffect(() => { refresh(); }, []);

  const byDomain = useMemo(() => {
    const m = new Map<string, CookieInfo[]>();
    for (const c of cookies) {
      if (filter && !c.domain.includes(filter) && !c.name.includes(filter)) continue;
      m.set(c.domain, [...(m.get(c.domain) ?? []), c]);
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [cookies, filter]);

  return (
    <ModalFrame title="Manage Cookies" onClose={closeModal} width={760}
      footer={<>
        <button className="btn btn-danger" disabled={!cookies.length} onClick={async () => {
          if (await confirmDialog("Clear cookies", "Delete all cookies from the local cookie jar?", { confirmText: "Clear all", danger: true })) {
            await api.clearCookies();
            useStore.setState({ modal: { kind: "cookies" } });
          }
        }}>Clear all</button>
        <div className="flex-1" />
        <button className="btn" onClick={closeModal}>Close</button>
      </>}>
      <div className="search-box inline" style={{ marginBottom: 10 }}>
        <Icon name="search" size={12} />
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by domain or name" />
      </div>
      {byDomain.length === 0 ? <div className="muted pad">No cookies stored.</div> : (
        <div className="cookie-list">
          {byDomain.map(([domain, list]) => (
            <div key={domain} className="cookie-domain">
              <div className="cookie-domain-name">{domain} <span className="muted">({list.length})</span></div>
              <table className="data-table">
                <thead><tr><th>Name</th><th>Value</th><th>Path</th><th>Expires</th><th>Flags</th><th /></tr></thead>
                <tbody>
                  {list.map((c) => (
                    <tr key={c.name + c.path}>
                      <td className="mono">{c.name}</td>
                      <td className="mono selectable ellipsis" style={{ maxWidth: 240 }} title={c.value}>{c.value}</td>
                      <td>{c.path}</td>
                      <td>{c.expires ?? "Session"}</td>
                      <td>{[c.secure && "Secure", c.httpOnly && "HttpOnly"].filter(Boolean).join(", ")}</td>
                      <td><button className="icon-btn" onClick={async () => { await api.deleteCookie(c); refresh(); }}><Icon name="trash" size={12} /></button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </ModalFrame>
  );
}

// ---------------------------------------------------------------- code generation

function CodegenModal({ tabId }: { tabId: string }) {
  const tab = useStore((s) => s.tabs.find((t) => t.id === tabId));
  const collections = useStore((s) => s.collections);
  const [lang, setLang] = useState<LanguageId>(() => (localStorage.getItem("lp.codegen") as LanguageId) ?? "curl");
  const [resolveVars, setResolveVars] = useState(true);
  const [copied, setCopied] = useState(false);

  const code = useMemo(() => {
    if (!tab?.draft) return "";
    try {
      const col = collections.find((c) => c.id === tab.saved?.collectionId);
      const folders = (col && tab.saved && findPath(col.items, tab.saved.itemId)) || [];
      const scopes = resolveVars ? buildScopes(col?.id) : emptyScopes();
      const prepared = prepareRequest(clone(tab.draft), effectiveAuth(tab.draft, folders, col), scopes);
      return generate(lang, prepared);
    } catch (e) {
      return `// ${e instanceof Error ? e.message : String(e)}`;
    }
  }, [tab, collections, lang, resolveVars]);

  if (!tab?.draft) return null;
  const meta = LANGUAGES.find((l) => l.id === lang)!;

  return (
    <ModalFrame title="Code snippet" onClose={closeModal} width={860} className="codegen-modal">
      <div className="codegen">
        <div className="codegen-langs">
          {LANGUAGES.map((l) => (
            <button key={l.id} className={`settings-nav-btn ${lang === l.id ? "active" : ""}`} onClick={() => { setLang(l.id); localStorage.setItem("lp.codegen", l.id); }}>
              {l.label}
            </button>
          ))}
        </div>
        <div className="codegen-code">
          <div className="codegen-toolbar">
            <Toggle checked={resolveVars} onChange={setResolveVars} label="Resolve variables" />
            <div className="flex-1" />
            <button className="btn" onClick={() => { navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>
              <Icon name={copied ? "check" : "copy"} /> {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <div className="codegen-editor">
            <CodeEditor value={code} readOnly wrap language={meta.cm === "javascript" ? "javascript" : "text"} />
          </div>
        </div>
      </div>
    </ModalFrame>
  );
}
