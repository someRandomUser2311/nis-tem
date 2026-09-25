import { create } from "zustand";
import {
  DEFAULT_SETTINGS, migrateSettings, type Collection, type ConsoleEntry, type Environment, type Example, type FolderItem, type HistoryEntry,
  type Item, type KV, type LiveMessage, type LiveState, type LoadConfigInput, type LoadEvent, type OAuth2Config, type OAuth2Token, type RequestItem, type RunResult, type ServerDef, type ServerEvent, type Settings, type Tab, type TabKind,
} from "./types";
import { onEvent } from "./lib/events";
import { compileRoutes, nativeRoutes } from "./lib/mock";
import { api } from "./lib/api";
import { effectiveAuth, executeRequest, nativeOptions, prepareRequest, signRequest } from "./lib/engine";
import { SseParser } from "./lib/sse";
import { collectionToFiles, filesSignature, filesToCollection } from "./lib/linked";
import { getNewToken, oauthConfig, refreshToken, tokenExpired } from "./lib/oauth";
import { INTROSPECTION_QUERY, schemaFromResponse, setSchemaState, useSchemas } from "./lib/graphql";
import { resolve as resolveVars, VarScope, type Scopes } from "./lib/vars";
import {
  clone, cloneWithNewIds, containsId, findItem, findPath, newCollection, newFolder, newRequest, removeItem, uid,
} from "./lib/utils";

export type SidebarView = "collections" | "environments" | "history" | "servers" | "tools";

export interface ServerRuntime {
  running: boolean;
  starting?: boolean;
  port?: number;
  host?: string;
  error?: string;
  log: ServerEvent[];
}

export type Modal =
  | { kind: "save"; tabId: string }
  | { kind: "import" }
  | { kind: "settings" }
  | { kind: "cookies" }
  | { kind: "codegen"; tabId: string }
  | { kind: "prompt"; title: string; label?: string; value: string; confirmText?: string; resolve: (v: string | null) => void }
  | { kind: "confirm"; title: string; message: string; confirmText?: string; danger?: boolean; resolve: (ok: boolean) => void }
  | { kind: "palette"; mode: "go" | "search"; query?: string }
  | { kind: "workspaces" }
  | { kind: "replace"; collectionId: string }
  | { kind: "envCompare"; a?: string; b?: string }
  | { kind: "diff"; title: string; left: string; right: string; leftLabel: string; rightLabel: string; language?: string }
  | { kind: "choice"; title: string; message: string; choices: { label: string; value: string; variant?: "primary" | "danger" }[]; resolve: (v: string | null) => void };

interface State {
  loaded: boolean;
  dataDir: string;
  collections: Collection[];
  environments: Environment[];
  globals: KV[];
  activeEnvironmentId: string | null;
  history: HistoryEntry[];
  settings: Settings;
  tabs: Tab[];
  activeTabId: string | null;
  console: ConsoleEntry[];
  consoleOpen: boolean;
  sidebarView: SidebarView;
  modal: Modal | null;
  servers: ServerDef[];
  serverRuntime: Record<string, ServerRuntime>;
}

export const useStore = create<State>(() => ({
  loaded: false,
  dataDir: "",
  collections: [],
  environments: [],
  globals: [],
  activeEnvironmentId: null,
  history: [],
  settings: DEFAULT_SETTINGS,
  tabs: [],
  activeTabId: null,
  console: [],
  consoleOpen: false,
  sidebarView: "collections",
  modal: null,
  servers: [],
  serverRuntime: {},
}));

const set = useStore.setState;
const get = useStore.getState;

// ---------------------------------------------------------------- persistence

async function readJson<T>(name: string, fallback: T): Promise<T> {
  try {
    const s = await api.storeRead(name);
    return s ? (JSON.parse(s) as T) : fallback;
  } catch (e) {
    console.error(`failed to load ${name}`, e);
    return fallback;
  }
}

type Persisted = Pick<State, "collections" | "environments" | "globals" | "history" | "settings" | "servers"> & { session: unknown };

const persistTargets: { name: string; select: (s: State) => unknown }[] = [
  { name: "collections", select: (s) => s.collections },
  { name: "environments", select: (s) => s.environments },
  { name: "globals", select: (s) => s.globals },
  { name: "history", select: (s) => s.history },
  { name: "settings", select: (s) => s.settings },
  { name: "servers", select: (s) => s.servers },
  {
    name: "session",
    select: (s) => ({ tabs: s.tabs, activeTabId: s.activeTabId, activeEnvironmentId: s.activeEnvironmentId, sidebarView: s.sidebarView }),
  },
];

export async function initStore() {
  const [collections, environments, globals, history, settings, session, dataDir, servers] = await Promise.all([
    readJson<Persisted["collections"]>("collections", []),
    readJson<Persisted["environments"]>("environments", []),
    readJson<Persisted["globals"]>("globals", []),
    readJson<Persisted["history"]>("history", []),
    readJson<Partial<Settings> | null>("settings", null),
    readJson<any>("session", {}),
    api.dataDir().catch(() => ""),
    readJson<Persisted["servers"]>("servers", []),
  ]);
  const tabs: Tab[] = (session.tabs ?? []).map((t: Tab) => ({ ...t, loading: false, pendingId: undefined, result: undefined, prevResult: undefined, live: undefined }));
  set({
    loaded: true,
    dataDir,
    collections,
    environments,
    globals,
    history,
    settings: migrateSettings(settings),
    servers,
    tabs,
    activeTabId: tabs.some((t) => t.id === session.activeTabId) ? session.activeTabId : tabs[0]?.id ?? null,
    activeEnvironmentId: session.activeEnvironmentId ?? null,
    sidebarView: session.sidebarView ?? "collections",
  });
  // First launch: materialise the settings file so the data folder isn't empty.
  if (!settings) api.storeWrite("settings", JSON.stringify(DEFAULT_SETTINGS, null, 2)).catch(() => {});
  if (!tabs.length) newRequestTab();

  // WebSocket frames and streamed (SSE) responses.
  onEvent<WsEventPayload>("lp://ws", onWsEvent);
  onEvent<StreamEventPayload>("lp://stream", onStreamEvent);

  // Requests received by local servers.
  onEvent<ServerEvent>("lp://server", (ev) => {
    set((s) => {
      const rt = s.serverRuntime[ev.serverId];
      if (!rt) return {};
      return { serverRuntime: { ...s.serverRuntime, [ev.serverId]: { ...rt, log: [ev, ...rt.log].slice(0, 500) } } };
    });
  });
  // Running mocks follow edits to their collection's examples.
  useStore.subscribe((state, prev) => {
    if (state.collections === prev.collections) return;
    for (const def of state.servers) {
      if (def.kind !== "mock" || !state.serverRuntime[def.id]?.running) continue;
      const now = state.collections.find((c) => c.id === def.collectionId);
      const before = prev.collections.find((c) => c.id === def.collectionId);
      if (now && now !== before) api.serverUpdate(def.id, { kind: "mock", routes: nativeRoutes(compileRoutes(now)) }).catch(() => {});
    }
  });

  // Secret variables kept in the OS keychain: fill their values back in.
  if (hasKeychainRefs(get())) await loadKeychainSecrets();

  // Linked collections: the folder is the source of truth.
  onEvent<{ root: string }>("lp://fs-changed", (e) => scheduleLinkedReload(e.root));
  for (const c of get().collections) if (c.linkedPath) await reloadLinked(c.id, { initial: true });
  useStore.subscribe((state, prev) => {
    if (state.collections === prev.collections) return;
    for (const c of state.collections) {
      if (c.linkedPath && prev.collections.find((p) => p.id === c.id) !== c) scheduleLinkedWrite(c.id);
    }
  });

  // Debounced write-through: every slice is saved to its own JSON file when it changes.
  const last: Record<string, unknown> = {};
  for (const t of persistTargets) last[t.name] = t.select(get());
  useStore.subscribe((state) => {
    for (const t of persistTargets) {
      const v = t.select(state);
      const changed = t.name === "session" ? JSON.stringify(v) !== JSON.stringify(last[t.name]) : v !== last[t.name];
      if (!changed) continue;
      last[t.name] = v;
      schedulePersist(t.name);
    }
  });
}

const persistTimers: Record<string, number> = {};

function schedulePersist(name: string) {
  clearTimeout(persistTimers[name]);
  persistTimers[name] = window.setTimeout(() => { persistNow(name); }, 250);
}

const SECRET_STORES = new Set(["collections", "environments", "globals"]);

async function persistNow(name: string) {
  const t = persistTargets.find((x) => x.name === name);
  if (!t) return;
  let v = t.select(get());
  if (name === "session") {
    v = { ...(v as any), tabs: (v as any).tabs.map((tab: Tab) => ({ ...tab, result: undefined, prevResult: undefined, live: undefined, loading: false, pendingId: undefined })) };
  } else if (SECRET_STORES.has(name) && get().settings.useKeychain) {
    // Keychain first: only blank the values in the file once they're safely stored there.
    if (await syncKeychain()) v = stripSecretValues(name, v);
  }
  await api.storeWrite(name, JSON.stringify(v, null, 2)).catch((e) => console.error(`failed to save ${name}`, e));
}

// ---------------------------------------------------------------- keychain secrets

/** Every variable list in the workspace, labelled by the store file it lives in. */
function variableLists(s: Pick<State, "collections" | "environments" | "globals">): KV[][] {
  return [s.globals, ...s.environments.map((e) => e.variables), ...s.collections.map((c) => c.variables)];
}

const hasKeychainRefs = (s: State) => variableLists(s).some((l) => l.some((v) => v.inKeychain));

let lastKeychain = "";

/** Write all secret values (by variable id) to the keychain item. Returns false if that failed. */
async function syncKeychain(): Promise<boolean> {
  const map: Record<string, string> = {};
  for (const l of variableLists(get())) for (const v of l) if (v.secret && v.value) map[v.id] = v.value;
  const json = JSON.stringify(map);
  if (json === lastKeychain) return true;
  try {
    await api.secretsWrite(json);
    lastKeychain = json;
    return true;
  } catch (e) {
    log("error", `Could not save secrets to the keychain; they stay in the data files for now. ${e}`);
    return false;
  }
}

function stripSecretValues(name: string, v: unknown): unknown {
  const strip = (l: KV[]) => l.map((x) => (x.secret && x.value ? { ...x, value: "", inKeychain: true } : { ...x, inKeychain: undefined }));
  if (name === "globals") return strip(v as KV[]);
  if (name === "environments") return (v as Environment[]).map((e) => ({ ...e, variables: strip(e.variables) }));
  return (v as Collection[]).map((c) => ({ ...c, variables: strip(c.variables) }));
}

async function loadKeychainSecrets() {
  let map: Record<string, string> = {};
  try {
    map = JSON.parse(await api.secretsRead());
    lastKeychain = JSON.stringify(map);
  } catch (e) {
    log("error", `Could not read secrets from the keychain: ${e}`);
    return;
  }
  const fill = (l: KV[]) => l.map((x) => (x.inKeychain ? { ...x, value: map[x.id] ?? x.value, inKeychain: undefined } : x));
  set((s) => ({
    globals: fill(s.globals),
    environments: s.environments.map((e) => ({ ...e, variables: fill(e.variables) })),
    collections: s.collections.map((c) => ({ ...c, variables: fill(c.variables) })),
  }));
}

/** Turn keychain storage on/off and rewrite the files (and keychain) accordingly. */
export async function setKeychainStorage(enabled: boolean) {
  updateSettings({ useKeychain: enabled });
  if (enabled) {
    lastKeychain = "";
    if (!(await syncKeychain())) { updateSettings({ useKeychain: false }); throw new Error("The keychain isn't available"); }
  }
  await Promise.all([...SECRET_STORES].map((n) => persistNow(n)));
  if (!enabled) {
    await api.secretsClear().catch(() => {});
    lastKeychain = "";
  }
}

// ---------------------------------------------------------------- dialogs

export const prompt = (title: string, value = "", label?: string, confirmText?: string) =>
  new Promise<string | null>((resolve) => set({ modal: { kind: "prompt", title, value, label, confirmText, resolve } }));

export const confirmDialog = (title: string, message: string, opts: { confirmText?: string; danger?: boolean } = {}) =>
  new Promise<boolean>((resolve) => set({ modal: { kind: "confirm", title, message, ...opts, resolve } }));

export const choiceDialog = (title: string, message: string, choices: Extract<Modal, { kind: "choice" }>["choices"]) =>
  new Promise<string | null>((resolve) => set({ modal: { kind: "choice", title, message, choices, resolve } }));

export const openModal = (modal: Modal) => set({ modal });
export const closeModal = () => set({ modal: null });

// ---------------------------------------------------------------- console

export function log(level: ConsoleEntry["level"], message: string, detail?: unknown) {
  set((s) => ({ console: [...s.console.slice(-999), { id: uid(), time: Date.now(), level, message, detail }] }));
}
export const clearConsole = () => set({ console: [] });
export const toggleConsole = (open?: boolean) => set((s) => ({ consoleOpen: open ?? !s.consoleOpen }));

// ---------------------------------------------------------------- collections

function mutateCollection(id: string, fn: (c: Collection) => void) {
  set((s) => ({
    collections: s.collections.map((c) => {
      if (c.id !== id) return c;
      const copy = clone(c);
      fn(copy);
      return copy;
    }),
  }));
}

export function createCollection(name = "New Collection"): Collection {
  const c = newCollection(name);
  set((s) => ({ collections: [...s.collections, c] }));
  return c;
}

export function addCollections(cs: Collection[]) {
  set((s) => ({ collections: [...s.collections, ...cs] }));
}

export function updateCollection(id: string, patch: Partial<Collection>) {
  mutateCollection(id, (c) => Object.assign(c, patch));
}

export function deleteCollection(id: string) {
  const linked = get().collections.find((c) => c.id === id)?.linkedPath;
  if (linked) api.linkedUnwatch(linked).catch(() => {});
  set((s) => ({
    collections: s.collections.filter((c) => c.id !== id),
    tabs: s.tabs
      .filter((t) => !((t.kind === "collection" || t.kind === "folder" || t.kind === "runner") && t.collectionId === id))
      .map((t) => (t.saved?.collectionId === id ? { ...t, saved: undefined, dirty: true } : t)),
  }));
  fixActiveTab();
}

export function duplicateCollection(id: string) {
  const c = get().collections.find((x) => x.id === id);
  if (!c) return;
  const copy = clone(c);
  copy.id = uid();
  copy.name = `${c.name} Copy`;
  copy.items = copy.items.map((i) => cloneWithNewIds(i));
  set((s) => ({ collections: [...s.collections, copy] }));
}

export function addItem(collectionId: string, parentId: string | null, item: Item) {
  mutateCollection(collectionId, (c) => {
    const parent = parentId ? findItem(c.items, parentId) : null;
    if (parent && parent.type === "folder") parent.items.push(item);
    else c.items.push(item);
  });
}

export function addFolder(collectionId: string, parentId: string | null, name: string): FolderItem {
  const f = newFolder(name);
  addItem(collectionId, parentId, f);
  return f;
}

export function addRequestTo(collectionId: string, parentId: string | null): RequestItem {
  const r = newRequest();
  addItem(collectionId, parentId, r);
  openRequest(collectionId, r.id);
  return r;
}

export function updateItem(collectionId: string, itemId: string, patch: Partial<Item>) {
  mutateCollection(collectionId, (c) => {
    const it = findItem(c.items, itemId);
    if (it) Object.assign(it, patch);
  });
  if ("name" in patch) {
    // keep open, clean tabs in sync with renames
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.saved?.itemId === itemId && t.draft ? { ...t, draft: { ...t.draft, name: patch.name as string } } : t,
      ),
    }));
  }
}

/** Reload the drafts of clean (not edited) request tabs from the saved collection. */
export function refreshCleanTabs(collectionId: string) {
  const col = get().collections.find((c) => c.id === collectionId);
  if (!col) return;
  set((s) => ({
    tabs: s.tabs.map((t) => {
      if (t.kind !== "request" || t.dirty || t.saved?.collectionId !== collectionId) return t;
      const it = findItem(col.items, t.saved.itemId);
      return it?.type === "request" ? { ...t, draft: clone(it) } : t;
    }),
  }));
}

export function togglePinned(collectionId: string, itemId: string) {
  mutateCollection(collectionId, (c) => {
    const it = findItem(c.items, itemId);
    if (it?.type === "request") it.pinned = !it.pinned;
  });
}

export function deleteItem(collectionId: string, itemId: string) {
  const col = get().collections.find((c) => c.id === collectionId);
  const item = col && findItem(col.items, itemId);
  if (!item) return;
  mutateCollection(collectionId, (c) => { removeItem(c.items, itemId); });
  set((s) => ({
    tabs: s.tabs
      .filter((t) => !(t.kind === "folder" && t.folderId && containsId(item, t.folderId)))
      .map((t) => (t.saved && containsId(item, t.saved.itemId) ? { ...t, saved: undefined, dirty: true } : t)),
  }));
  fixActiveTab();
}

export function duplicateItem(collectionId: string, itemId: string) {
  mutateCollection(collectionId, (c) => {
    const path = findPath(c.items, itemId);
    const it = findItem(c.items, itemId);
    if (!it || !path) return;
    const parentItems = path.length ? path[path.length - 1].items : c.items;
    const copy = cloneWithNewIds(it);
    copy.name = `${it.name} Copy`;
    parentItems.splice(parentItems.indexOf(it) + 1, 0, copy);
  });
}

/**
 * Drag & drop. Moves `itemId` into `target`:
 *  - position "inside": into folder `targetId` (or collection root when targetId is null)
 *  - position "before"/"after": next to item `targetId`
 */
export function moveItem(
  fromCollectionId: string, itemId: string,
  toCollectionId: string, targetId: string | null, position: "inside" | "before" | "after",
) {
  const state = get();
  const from = state.collections.find((c) => c.id === fromCollectionId);
  const item = from && findItem(from.items, itemId);
  if (!item) return;
  if (targetId && containsId(item, targetId)) return; // can't drop into itself

  const cols = state.collections.map((c) => (c.id === fromCollectionId || c.id === toCollectionId ? clone(c) : c));
  const src = cols.find((c) => c.id === fromCollectionId)!;
  const dst = cols.find((c) => c.id === toCollectionId)!;
  const moved = removeItem(src.items, itemId)!;

  if (!targetId) dst.items.push(moved);
  else if (position === "inside") {
    const f = findItem(dst.items, targetId);
    if (f?.type === "folder") f.items.push(moved); else dst.items.push(moved);
  } else {
    const path = findPath(dst.items, targetId);
    const list = path && path.length ? path[path.length - 1].items : dst.items;
    const idx = list.findIndex((i) => i.id === targetId);
    list.splice(idx < 0 ? list.length : position === "before" ? idx : idx + 1, 0, moved);
  }
  set({
    collections: cols,
    tabs: state.tabs.map((t) =>
      t.saved && containsId(moved, t.saved.itemId) ? { ...t, saved: { ...t.saved, collectionId: toCollectionId } } : t,
    ),
  });
}

// ---------------------------------------------------------------- environments

export function createEnvironment(name = "New Environment", variables: KV[] = []): Environment {
  const env: Environment = { id: uid(), name, variables };
  set((s) => ({ environments: [...s.environments, env] }));
  return env;
}
export function addEnvironments(envs: Environment[]) {
  set((s) => ({ environments: [...s.environments, ...envs] }));
}
export function updateEnvironment(id: string, patch: Partial<Environment>) {
  set((s) => ({ environments: s.environments.map((e) => (e.id === id ? { ...e, ...patch } : e)) }));
}
export function deleteEnvironment(id: string) {
  set((s) => ({
    environments: s.environments.filter((e) => e.id !== id),
    activeEnvironmentId: s.activeEnvironmentId === id ? null : s.activeEnvironmentId,
    tabs: s.tabs.filter((t) => !(t.kind === "environment" && t.environmentId === id)),
  }));
  fixActiveTab();
}
export function duplicateEnvironment(id: string) {
  const e = get().environments.find((x) => x.id === id);
  if (e) createEnvironment(`${e.name} Copy`, clone(e.variables).map((v) => ({ ...v, id: uid() })));
}
export const setActiveEnvironment = (id: string | null) => set({ activeEnvironmentId: id });
export const setGlobals = (globals: KV[]) => set({ globals });

// ---------------------------------------------------------------- settings / history / ui

export const updateSettings = (patch: Partial<Settings>) => set((s) => ({ settings: { ...s.settings, ...patch } }));
export const setSidebarView = (v: SidebarView) => set({ sidebarView: v });
export const clearHistory = () => set({ history: [] });
export const deleteHistory = (id: string) => set((s) => ({ history: s.history.filter((h) => h.id !== id) }));

// ---------------------------------------------------------------- tabs

function fixActiveTab() {
  const { tabs, activeTabId } = get();
  if (!tabs.some((t) => t.id === activeTabId)) set({ activeTabId: tabs[tabs.length - 1]?.id ?? null });
}

export const setActiveTab = (id: string) => set({ activeTabId: id });

function openTab(tab: Tab, match: (t: Tab) => boolean) {
  const existing = get().tabs.find(match);
  if (existing) {
    set({ activeTabId: existing.id });
    return existing;
  }
  set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
  return tab;
}

export function newRequestTab(partial: Partial<RequestItem> = {}) {
  const tab: Tab = { id: uid(), kind: "request", draft: newRequest({ name: "Untitled Request", ...partial }), dirty: false };
  set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
  return tab;
}

export function openRequest(collectionId: string, itemId: string) {
  const col = get().collections.find((c) => c.id === collectionId);
  const item = col && findItem(col.items, itemId);
  if (!item || item.type !== "request") return;
  openTab(
    { id: uid(), kind: "request", draft: clone(item), saved: { collectionId, itemId }, dirty: false },
    (t) => t.kind === "request" && t.saved?.itemId === itemId,
  );
}

type SpecialIds = { collectionId?: string; folderId?: string; environmentId?: string; requestId?: string; exampleId?: string; serverId?: string; toolId?: string };

export function openSpecialTab(kind: Exclude<TabKind, "request">, ids: SpecialIds = {}) {
  const keys = ["collectionId", "folderId", "environmentId", "requestId", "exampleId", "serverId", "toolId"] as const;
  openTab({ id: uid(), kind, ...ids }, (t) => t.kind === kind && keys.every((k) => t[k] === ids[k]));
}

export function openHistoryEntry(h: HistoryEntry) {
  const r = clone(h.request);
  newRequestTab({ ...r, id: uid(), name: r.name && r.name !== "Untitled Request" ? r.name : r.url || "Untitled Request" });
}

export function closeTab(id: string) {
  const { tabs, activeTabId } = get();
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  const tab = tabs[idx];
  if (tab.pendingId) api.cancel(tab.pendingId);
  if (tab.kind === "loadtest") stopLoadTest(tab.id);
  if (tab.live && tab.live.status !== "closed") disconnectLive(tab.id);
  const next = tabs.filter((t) => t.id !== id);
  set({
    tabs: next,
    activeTabId: activeTabId === id ? next[Math.min(idx, next.length - 1)]?.id ?? null : activeTabId,
  });
}

export function closeOtherTabs(id: string) {
  set((s) => ({ tabs: s.tabs.filter((t) => t.id === id || t.dirty), activeTabId: id }));
}

export function updateTab(id: string, patch: Partial<Tab>) {
  set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));
}

export function updateDraft(tabId: string, patch: Partial<RequestItem>) {
  set((s) => ({
    tabs: s.tabs.map((t) => (t.id === tabId && t.draft ? { ...t, draft: { ...t.draft, ...patch }, dirty: true } : t)),
  }));
}

/** Save a request tab. Returns false if it needs a "Save As" destination. */
export function saveTab(tabId: string): boolean {
  const tab = get().tabs.find((t) => t.id === tabId);
  if (!tab?.draft) return true;
  if (!tab.saved) {
    openModal({ kind: "save", tabId });
    return false;
  }
  const col = get().collections.find((c) => c.id === tab.saved!.collectionId);
  if (!col || !findItem(col.items, tab.saved.itemId)) {
    openModal({ kind: "save", tabId });
    return false;
  }
  const draft = clone(tab.draft);
  mutateCollection(tab.saved.collectionId, (c) => {
    const it = findItem(c.items, tab.saved!.itemId);
    // Sidebar-owned fields (pin state) may have changed since the tab was opened.
    if (it && it.type === "request") Object.assign(it, { ...draft, id: it.id, pinned: it.pinned, examples: it.examples });
  });
  updateTab(tabId, { dirty: false });
  return true;
}

export function saveTabAs(tabId: string, collectionId: string, folderId: string | null, name: string) {
  const tab = get().tabs.find((t) => t.id === tabId);
  if (!tab?.draft) return;
  const item: RequestItem = { ...clone(tab.draft), id: uid(), name };
  addItem(collectionId, folderId, item);
  updateTab(tabId, { draft: clone(item), saved: { collectionId, itemId: item.id }, dirty: false });
}

// ---------------------------------------------------------------- variables

/** Build mutable variable scopes for a request in `collectionId`. */
export function buildScopes(collectionId?: string, data: Record<string, unknown> = {}): Scopes {
  const s = get();
  const env = s.environments.find((e) => e.id === s.activeEnvironmentId);
  const col = s.collections.find((c) => c.id === collectionId);
  const dataScope = new VarScope();
  for (const [k, v] of Object.entries(data)) dataScope.set(k, v);
  dataScope.changed = false;
  return {
    globals: new VarScope(s.globals),
    collection: new VarScope(col?.variables ?? []),
    environment: new VarScope(env?.variables ?? []),
    data: dataScope,
    local: new VarScope(),
  };
}

/** Persist variable changes made by scripts. */
export function commitScopes(scopes: Scopes, collectionId?: string) {
  const s = get();
  if (scopes.globals.changed) set({ globals: scopes.globals.toList() });
  if (scopes.environment.changed && s.activeEnvironmentId) updateEnvironment(s.activeEnvironmentId, { variables: scopes.environment.toList() });
  if (scopes.collection.changed && collectionId) updateCollection(collectionId, { variables: scopes.collection.toList() });
  for (const sc of Object.values(scopes)) sc.changed = false;
}

// ---------------------------------------------------------------- sending

export async function sendTab(tabId: string) {
  let tab = get().tabs.find((t) => t.id === tabId);
  if (!tab?.draft || tab.loading) return;
  updateTab(tabId, { loading: true });
  await refreshTokenIfExpired(tab.draft, tab.saved?.collectionId, tabId);
  tab = get().tabs.find((t) => t.id === tabId);
  if (!tab?.draft) return;
  const request = clone(tab.draft);
  const collectionId = tab.saved?.collectionId;
  const col = get().collections.find((c) => c.id === collectionId);
  const folders = (col && tab.saved && findPath(col.items, tab.saved.itemId)) || [];
  const pendingId = uid();
  updateTab(tabId, { loading: true, pendingId });

  const scopes = buildScopes(collectionId);
  const { result } = await executeRequest({
    request, collection: col, folders, scopes, settings: get().settings, log, requestId: pendingId,
  });
  commitScopes(scopes, collectionId);

  // Tab may have been closed while in flight.
  const current = get().tabs.find((t) => t.id === tabId);
  if (current) {
    updateTab(tabId, {
      loading: false, pendingId: undefined, result,
      prevResult: current.result?.response ? current.result : current.prevResult,
    });
  }

  const entry: HistoryEntry = {
    id: uid(), time: Date.now(), request,
    status: result.response?.status, timeMs: result.response?.timeMs, error: result.error,
  };
  set((s) => ({ history: [entry, ...s.history].slice(0, s.settings.historyLimit) }));
}

export function cancelTab(tabId: string) {
  const tab = get().tabs.find((t) => t.id === tabId);
  if (tab?.pendingId) api.cancel(tab.pendingId);
}

// ---------------------------------------------------------------- examples

/** Save a tab's current response as an example of its (saved) request. */
export function saveExample(tabId: string, name: string, result: RunResult): Example | null {
  const tab = get().tabs.find((t) => t.id === tabId);
  const res = result.response;
  if (!tab?.saved || !res) return null;
  const ex: Example = {
    id: uid(),
    name,
    status: res.status,
    statusText: res.statusText,
    headers: res.headers.filter((h) => !/^(content-length|transfer-encoding|content-encoding|connection|date)$/i.test(h.key)),
    body: res.isBinary ? "" : res.bodyText,
    bodyBase64: res.isBinary ? res.bodyBase64 : null,
    request: { method: tab.draft?.method ?? "GET", url: tab.draft?.url ?? "" },
  };
  const { collectionId, itemId } = tab.saved;
  mutateCollection(collectionId, (c) => {
    const it = findItem(c.items, itemId);
    if (it?.type === "request") it.examples = [...(it.examples ?? []), ex];
  });
  return ex;
}

export function updateExample(collectionId: string, requestId: string, exampleId: string, patch: Partial<Example>) {
  mutateCollection(collectionId, (c) => {
    const it = findItem(c.items, requestId);
    if (it?.type === "request") it.examples = (it.examples ?? []).map((e) => (e.id === exampleId ? { ...e, ...patch } : e));
  });
}

export function deleteExample(collectionId: string, requestId: string, exampleId: string) {
  mutateCollection(collectionId, (c) => {
    const it = findItem(c.items, requestId);
    if (it?.type === "request") it.examples = (it.examples ?? []).filter((e) => e.id !== exampleId);
  });
  set((s) => ({ tabs: s.tabs.filter((t) => !(t.kind === "example" && t.exampleId === exampleId)) }));
  fixActiveTab();
}

export function duplicateExample(collectionId: string, requestId: string, exampleId: string) {
  mutateCollection(collectionId, (c) => {
    const it = findItem(c.items, requestId);
    if (it?.type !== "request") return;
    const list = it.examples ?? [];
    const i = list.findIndex((e) => e.id === exampleId);
    if (i >= 0) list.splice(i + 1, 0, { ...clone(list[i]), id: uid(), name: `${list[i].name} Copy` });
    it.examples = list;
  });
}

// ---------------------------------------------------------------- local servers

const setRuntime = (id: string, patch: Partial<ServerRuntime>) =>
  set((s) => ({ serverRuntime: { ...s.serverRuntime, [id]: { ...(s.serverRuntime[id] ?? { log: [], running: false }), ...patch } } }));

export function createServer(kind: ServerDef["kind"], collectionId?: string): ServerDef {
  const s = get();
  const col = s.collections.find((c) => c.id === collectionId);
  const used = new Set(s.servers.map((d) => d.port));
  let port = kind === "mock" ? 3100 : 3200;
  while (used.has(port)) port++;
  const def: ServerDef = {
    id: uid(), kind, port, delayMs: 0, cors: true, allowLan: false,
    name: kind === "mock" ? `${col?.name ?? "Collection"} mock` : "Webhook catcher",
    collectionId: kind === "mock" ? collectionId : undefined,
    response: kind === "catcher"
      ? { status: 200, headers: [{ id: uid(), key: "Content-Type", value: "application/json", enabled: true }], body: '{ "ok": true }' }
      : undefined,
  };
  set((st) => ({ servers: [...st.servers, def] }));
  return def;
}

export function updateServer(id: string, patch: Partial<ServerDef>) {
  set((s) => ({ servers: s.servers.map((d) => (d.id === id ? { ...d, ...patch } : d)) }));
}

export async function deleteServer(id: string) {
  await stopServer(id);
  set((s) => {
    const { [id]: _, ...rest } = s.serverRuntime;
    return { servers: s.servers.filter((d) => d.id !== id), serverRuntime: rest, tabs: s.tabs.filter((t) => !(t.kind === "server" && t.serverId === id)) };
  });
  fixActiveTab();
}

export async function startServer(id: string) {
  const s = get();
  const def = s.servers.find((d) => d.id === id);
  if (!def) return;
  setRuntime(id, { starting: true, error: undefined });
  try {
    const base = { id, port: def.port, delayMs: def.delayMs, cors: def.cors, allowLan: def.allowLan };
    let info;
    if (def.kind === "mock") {
      const col = s.collections.find((c) => c.id === def.collectionId);
      if (!col) throw new Error("Pick a collection for this mock server first");
      info = await api.serverStart({ ...base, kind: "mock", routes: nativeRoutes(compileRoutes(col)) });
    } else {
      const r = def.response ?? { status: 200, headers: [], body: "" };
      info = await api.serverStart({
        ...base, kind: "catcher",
        response: { status: r.status, body: r.body, headers: r.headers.filter((h) => h.enabled && h.key).map(({ key, value }) => ({ key, value })) },
      });
    }
    setRuntime(id, { running: true, starting: false, port: info.port, host: info.host });
    log("info", `${def.kind === "mock" ? "Mock server" : "Webhook catcher"} "${def.name}" listening on http://${info.host === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1"}:${info.port}`);
  } catch (e) {
    setRuntime(id, { running: false, starting: false, error: e instanceof Error ? e.message : String(e) });
  }
}

export async function stopServer(id: string) {
  if (!get().serverRuntime[id]?.running) return;
  await api.serverStop(id).catch(() => {});
  setRuntime(id, { running: false });
}

/** Restart a running server so changed settings (port, delay, CORS, response) take effect. */
export async function restartServer(id: string) {
  if (get().serverRuntime[id]?.running) await startServer(id);
}

export const clearServerLog = (id: string) => setRuntime(id, { log: [] });

// ---------------------------------------------------------------- WebSocket & Server-Sent Events

interface WsEventPayload {
  id: string; kind: "open" | "message" | "sent" | "close" | "error"; time: number; data: string; binary: string | null;
  headers: { key: string; value: string }[]; status: number | null; code: number | null; elapsedMs: number | null;
}
interface StreamEventPayload {
  id: string; kind: "head" | "chunk" | "end" | "error"; status: number | null; statusText: string | null;
  headers: { key: string; value: string }[]; data: string; elapsedMs: number;
}

const MAX_LIVE_MESSAGES = 2000;
/** connection id → SSE parser (only for event-stream responses) */
const sseParsers = new Map<string, SseParser | null>();

function patchLive(connId: string, fn: (l: LiveState) => LiveState) {
  set((s) => ({ tabs: s.tabs.map((t) => (t.live?.connId === connId ? { ...t, live: fn(t.live) } : t)) }));
}

function pushLive(connId: string, ...msgs: Omit<LiveMessage, "id">[]) {
  if (!msgs.length) return;
  patchLive(connId, (l) => ({ ...l, messages: [...l.messages, ...msgs.map((m) => ({ ...m, id: uid() }))].slice(-MAX_LIVE_MESSAGES) }));
}

function onWsEvent(e: WsEventPayload) {
  switch (e.kind) {
    case "open":
      patchLive(e.id, (l) => ({ ...l, status: "open", head: { status: e.status ?? 101, headers: e.headers } }));
      pushLive(e.id, { time: e.time, dir: "info", data: `Connected to ${e.data}${e.elapsedMs ? ` in ${Math.round(e.elapsedMs)} ms` : ""}` });
      break;
    case "message": pushLive(e.id, { time: e.time, dir: "in", data: e.data, binary: e.binary }); break;
    case "sent": pushLive(e.id, { time: e.time, dir: "out", data: e.data, binary: e.binary }); break;
    case "error": pushLive(e.id, { time: e.time, dir: "error", data: e.data }); break;
    case "close":
      patchLive(e.id, (l) => ({ ...l, status: "closed" }));
      pushLive(e.id, { time: e.time, dir: "info", data: `Disconnected${e.code ? ` (${e.code}${e.data ? ` ${e.data}` : ""})` : e.data ? `: ${e.data}` : ""}` });
      break;
  }
}

function onStreamEvent(e: StreamEventPayload) {
  const now = Date.now();
  switch (e.kind) {
    case "head": {
      const ct = e.headers.find((h) => h.key.toLowerCase() === "content-type")?.value ?? "";
      sseParsers.set(e.id, /event-stream/i.test(ct) ? new SseParser() : null);
      patchLive(e.id, (l) => ({ ...l, status: "open", head: { status: e.status ?? 0, statusText: e.statusText ?? "", headers: e.headers } }));
      pushLive(e.id, { time: now, dir: "info", data: `${e.status} ${e.statusText ?? ""} · ${ct || "no content type"}${/event-stream/i.test(ct) ? "" : " (not an event stream; showing raw chunks)"}` });
      break;
    }
    case "chunk": {
      const parser = sseParsers.get(e.id);
      if (parser) pushLive(e.id, ...parser.feed(e.data).map((ev) => ({ time: now, dir: "in" as const, data: ev.data, event: ev.event, eventId: ev.id })));
      else pushLive(e.id, { time: now, dir: "in", data: e.data });
      break;
    }
    case "end":
      sseParsers.delete(e.id);
      patchLive(e.id, (l) => ({ ...l, status: "closed" }));
      pushLive(e.id, { time: now, dir: "info", data: `Stream ended after ${(e.elapsedMs / 1000).toFixed(1)} s` });
      break;
  }
}

/** Resolve variables and auth for a WebSocket/SSE request (scripts don't run for these). */
function prepareLive(tab: Tab) {
  const request = clone(tab.draft!);
  const col = get().collections.find((c) => c.id === tab.saved?.collectionId);
  const folders = (col && tab.saved && findPath(col.items, tab.saved.itemId)) || [];
  const scopes = buildScopes(col?.id);
  return { request, prepared: prepareRequest(request, effectiveAuth(request, folders, col), scopes) };
}

export async function connectLive(tabId: string) {
  const tab = get().tabs.find((t) => t.id === tabId);
  if (!tab?.draft) return;
  if (tab.live && tab.live.status !== "closed") return;
  const protocol = tab.draft.protocol ?? "http";
  const connId = uid();
  const settings = get().settings;
  let request: RequestItem, prepared: ReturnType<typeof prepareRequest>;
  try {
    ({ request, prepared } = prepareLive(tab));
  } catch (e) {
    updateTab(tabId, { live: { connId, status: "closed", startedAt: Date.now(), url: tab.draft.url, messages: [{ id: uid(), time: Date.now(), dir: "error", data: String(e instanceof Error ? e.message : e) }] } });
    return;
  }
  let url = prepared.url;
  if (protocol === "ws") url = url.replace(/^http(s?):\/\//i, "ws$1://");
  const keep = tab.live?.messages ?? [];
  updateTab(tabId, {
    live: { connId, status: "connecting", startedAt: Date.now(), url, messages: [...keep, { id: uid(), time: Date.now(), dir: "info" as const, data: `Connecting to ${url}…` }].slice(-MAX_LIVE_MESSAGES) },
  });
  const entry: HistoryEntry = { id: uid(), time: Date.now(), request };
  set((s) => ({ history: [entry, ...s.history].slice(0, s.settings.historyLimit) }));

  try {
    if (protocol === "ws") {
      const protocols = (request.ws?.protocols ?? "").split(",").map((p) => p.trim()).filter(Boolean);
      await api.wsConnect({ id: connId, url, headers: prepared.headers, protocols, verifySsl: request.settings.verifySsl ?? settings.verifySsl });
      log("request", `WebSocket ${url} connected`);
    } else {
      log("request", `${prepared.method} ${url} (event stream)`);
      await api.stream({ id: connId, method: prepared.method, url, headers: prepared.headers, body: prepared.body, options: nativeOptions(settings, request, url) });
    }
  } catch (e) {
    const msg = String(e);
    pushLive(connId, { time: Date.now(), dir: msg === "Request cancelled" ? "info" : "error", data: msg === "Request cancelled" ? "Stopped" : msg });
    patchLive(connId, (l) => ({ ...l, status: "closed" }));
    if (msg !== "Request cancelled") log("error", `${protocol === "ws" ? "WebSocket" : "Stream"} ${url} — ${msg}`);
  }
}

export function disconnectLive(tabId: string) {
  const tab = get().tabs.find((t) => t.id === tabId);
  const live = tab?.live;
  if (!live || live.status === "closed") return;
  if (tab.draft?.protocol === "ws") {
    api.wsClose(live.connId).catch(() => {});
    // If the socket never opened there will be no close event.
    if (live.status === "connecting") patchLive(live.connId, (l) => ({ ...l, status: "closed" }));
  } else api.cancel(live.connId);
}

export async function sendWsMessage(tabId: string, text: string) {
  const live = get().tabs.find((t) => t.id === tabId)?.live;
  if (!live || live.status !== "open") return;
  try {
    await api.wsSend(live.connId, { text });
  } catch (e) {
    pushLive(live.connId, { time: Date.now(), dir: "error", data: String(e) });
  }
}

export function clearLive(tabId: string) {
  set((s) => ({ tabs: s.tabs.map((t) => (t.id === tabId && t.live ? { ...t, live: { ...t.live, messages: [] } } : t)) }));
}

/** ⌘↵ / the URL-bar button: send (HTTP), connect or send the composed message (WebSocket), connect (SSE). */
export function primaryAction(tabId: string) {
  const tab = get().tabs.find((t) => t.id === tabId);
  if (!tab?.draft) return;
  const protocol = tab.draft.protocol ?? "http";
  if (protocol === "http") return sendTab(tabId);
  const open = tab.live && tab.live.status !== "closed";
  if (protocol === "ws" && tab.live?.status === "open") return sendWsMessage(tabId, resolveForSend(tab, tab.draft.ws?.message ?? ""));
  if (!open) return connectLive(tabId);
}

/** Resolve {{variables}} in an outgoing WebSocket message. */
export function resolveForSend(tab: Tab, text: string) {
  return resolveVars(text, buildScopes(tab.saved?.collectionId));
}

// ---------------------------------------------------------------- GraphQL schema

/** Fetch a GraphQL request's schema by sending the introspection query to its URL (no scripts run). */
export async function fetchGraphqlSchema(tabId: string) {
  const tab = get().tabs.find((t) => t.id === tabId);
  if (!tab?.draft) return;
  const key = tab.draft.id;
  setSchemaState(key, { ...useSchemas.getState()[key], loading: true, error: undefined });
  try {
    const draft = clone(tab.draft);
    draft.body = { ...draft.body, mode: "graphql", graphql: { query: INTROSPECTION_QUERY, variables: "" } };
    const col = get().collections.find((c) => c.id === tab.saved?.collectionId);
    const folders = (col && tab.saved && findPath(col.items, tab.saved.itemId)) || [];
    const prepared = prepareRequest(draft, effectiveAuth(draft, folders, col), buildScopes(col?.id));
    if (!prepared.url) throw new Error("Enter the GraphQL endpoint URL first");
    const res = await api.send({
      id: uid(), method: prepared.method === "GET" ? "POST" : prepared.method, url: prepared.url, headers: prepared.headers,
      body: prepared.body, options: nativeOptions(get().settings, draft, prepared.url),
    });
    if (res.status >= 400 && !res.bodyText.includes("__schema")) throw new Error(`${res.status} ${res.statusText}`);
    const schema = schemaFromResponse(res.bodyText);
    setSchemaState(key, { schema, fetchedAt: Date.now(), url: prepared.url });
    log("info", `GraphQL schema loaded from ${prepared.url} (${Object.keys(schema.getTypeMap()).filter((n) => !n.startsWith("__")).length} types)`);
  } catch (e) {
    setSchemaState(key, { ...useSchemas.getState()[key], loading: false, error: e instanceof Error ? e.message : String(e) });
  }
}

// ---------------------------------------------------------------- OAuth 2.0 tokens

function resolveOAuth(c: OAuth2Config, collectionId?: string): OAuth2Config {
  const scopes = buildScopes(collectionId);
  const out = { ...c };
  for (const k of Object.keys(out) as (keyof OAuth2Config)[]) {
    if (typeof out[k] === "string") (out as any)[k] = resolveVars(out[k] as string, scopes);
  }
  return out;
}

/** "Get new access token": run the configured grant with {{variables}} resolved. */
export async function obtainOAuthToken(config: Partial<OAuth2Config> | undefined, collectionId?: string): Promise<OAuth2Token> {
  const c = resolveOAuth(oauthConfig(config), collectionId);
  const token = await getNewToken(c, nativeOptions(get().settings, undefined, c.tokenUrl));
  log("info", `OAuth 2.0 token received (${c.grantType.replace(/_/g, " ")})${token.expiresAt ? `, expires ${new Date(token.expiresAt).toLocaleTimeString()}` : ""}`);
  return token;
}

export async function refreshOAuthToken(config: Partial<OAuth2Config> | undefined, collectionId?: string): Promise<OAuth2Token> {
  const c = resolveOAuth(oauthConfig(config), collectionId);
  if (!c.token) throw new Error("No token to refresh");
  const token = await refreshToken(c, c.token, nativeOptions(get().settings, undefined, c.tokenUrl));
  log("info", "OAuth 2.0 token refreshed");
  return token;
}

/**
 * Before sending: if the request's effective auth is OAuth 2.0 with an expired token and a
 * refresh token, refresh it and store the new token where the auth is defined (request, folder
 * or collection). Failures are logged and the request goes out with the old token.
 */
export async function refreshTokenIfExpired(request: RequestItem, collectionId: string | undefined, tabId?: string): Promise<void> {
  const col = get().collections.find((c) => c.id === collectionId);
  const folders = (col && findPath(col.items, request.id)) || [];
  const auth = effectiveAuth(request, folders, col);
  if (auth.type !== "oauth2") return;
  const c = oauthConfig(auth.oauth2);
  if (!c.autoRefresh || !c.token?.refreshToken || !tokenExpired(c.token)) return;
  let token: OAuth2Token;
  try {
    token = await refreshOAuthToken(c, collectionId);
  } catch (e) {
    log("warn", `OAuth 2.0 token refresh failed: ${e instanceof Error ? e.message : e}`);
    return;
  }
  const withToken = (a: typeof auth) => ({ ...a, oauth2: { ...a.oauth2, token } });
  if (request.auth.type === "oauth2") {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (tab?.draft) set((s) => ({ tabs: s.tabs.map((t) => (t.id === tabId && t.draft ? { ...t, draft: { ...t.draft, auth: withToken(t.draft.auth) } } : t)) }));
    if (col && findItem(col.items, request.id)) updateItem(col.id, request.id, { auth: withToken(request.auth) });
  } else if (col) {
    const owner = [...folders].reverse().find((f) => f.auth.type !== "inherit");
    if (owner) updateItem(col.id, owner.id, { auth: withToken(owner.auth) });
    else updateCollection(col.id, { auth: withToken(col.auth) });
  }
}

// ---------------------------------------------------------------- linked collections (folders / git)

/** Last file set written to (or read from) each linked folder, to ignore our own changes. */
const linkedSignature = new Map<string, string>();
const linkedTimers = new Map<string, number>();

function scheduleLinkedWrite(collectionId: string) {
  clearTimeout(linkedTimers.get(`w:${collectionId}`));
  linkedTimers.set(`w:${collectionId}`, window.setTimeout(() => { writeLinked(collectionId); }, 400));
}

async function writeLinked(collectionId: string) {
  const c = get().collections.find((x) => x.id === collectionId);
  if (!c?.linkedPath) return;
  const files = collectionToFiles(c);
  const sig = filesSignature(files);
  if (linkedSignature.get(c.linkedPath) === sig) return;
  linkedSignature.set(c.linkedPath, sig);
  try {
    await api.linkedWrite(c.linkedPath, files);
  } catch (e) {
    log("error", `Could not write "${c.name}" to ${c.linkedPath}: ${e}`);
  }
}

function scheduleLinkedReload(root: string) {
  clearTimeout(linkedTimers.get(`r:${root}`));
  linkedTimers.set(`r:${root}`, window.setTimeout(() => {
    const c = get().collections.find((x) => x.linkedPath === root);
    if (c) reloadLinked(c.id);
  }, 300));
}

/** Read a linked collection back from its folder (after outside edits, or at startup). */
export async function reloadLinked(collectionId: string, opts: { initial?: boolean } = {}) {
  const c = get().collections.find((x) => x.id === collectionId);
  if (!c?.linkedPath) return;
  const root = c.linkedPath;
  let files: { path: string; content: string }[];
  try {
    files = (await api.readDirFiles(root, ["json"])).filter((f) => /(^|\/)(collection|folder)\.json$|\.request\.json$/.test(f.path));
  } catch (e) {
    log("error", `Linked folder for "${c.name}" is not available (${root}): ${e}`);
    return;
  }
  if (!files.some((f) => f.path === "collection.json")) {
    // Empty folder (or first link): write ours.
    linkedSignature.delete(root);
    await writeLinked(collectionId);
  } else {
    const sig = filesSignature(files);
    if (linkedSignature.get(root) !== sig) {
      linkedSignature.set(root, sig);
      let loaded: Collection;
      try {
        loaded = filesToCollection(files, c);
      } catch (e) {
        log("error", `Could not read the linked collection in ${root}: ${e}`);
        return;
      }
      loaded.id = c.id;
      loaded.linkedPath = root;
      // Only the signature of what's on disk matters from here on.
      set((s) => ({ collections: s.collections.map((x) => (x.id === collectionId ? loaded : x)) }));
      linkedSignature.set(root, filesSignature(collectionToFiles(loaded)));
      refreshCleanTabs(collectionId);
      if (!opts.initial) {
        const dirty = get().tabs.filter((t) => t.dirty && t.saved?.collectionId === collectionId).length;
        log("info", `"${loaded.name}" reloaded from ${root}${dirty ? ` — ${dirty} tab${dirty === 1 ? " has" : "s have"} unsaved edits that were kept` : ""}`);
      }
    }
  }
  await api.linkedWatch(root).catch((e) => log("warn", `Can't watch ${root} for changes: ${e}`));
}

/**
 * Link a collection to a folder. If the folder already holds a Localpost collection, `mode`
 * decides whether to load it ("load") or overwrite it with this collection ("overwrite").
 */
export async function linkCollection(collectionId: string, root: string, mode: "load" | "overwrite") {
  updateCollection(collectionId, { linkedPath: root });
  linkedSignature.delete(root);
  if (mode === "overwrite") await writeLinked(collectionId);
  await reloadLinked(collectionId, { initial: true });
  log("info", `Collection linked to ${root}`);
}

export async function unlinkCollection(collectionId: string) {
  const c = get().collections.find((x) => x.id === collectionId);
  if (!c?.linkedPath) return;
  await api.linkedUnwatch(c.linkedPath).catch(() => {});
  linkedSignature.delete(c.linkedPath);
  set((s) => ({ collections: s.collections.map((x) => (x.id === collectionId ? { ...x, linkedPath: undefined } : x)) }));
}

/** Open a folder that already contains a linked collection as a new collection. */
export async function openLinkedFolder(root: string): Promise<Collection> {
  const files = (await api.readDirFiles(root, ["json"])).filter((f) => /(^|\/)(collection|folder)\.json$|\.request\.json$/.test(f.path));
  const loaded = filesToCollection(files);
  const existing = get().collections.find((c) => c.id === loaded.id || c.linkedPath === root);
  if (existing) {
    await linkCollection(existing.id, root, "load");
    return existing;
  }
  loaded.linkedPath = root;
  linkedSignature.set(root, filesSignature(files));
  set((s) => ({ collections: [...s.collections, loaded] }));
  await api.linkedWatch(root).catch(() => {});
  return loaded;
}

// ---------------------------------------------------------------- workspaces

/** Flush pending saves, switch the backend to another workspace folder, and reload the UI. */
export async function switchWorkspace(id: string) {
  for (const name of Object.keys(persistTimers)) clearTimeout(persistTimers[name]);
  await Promise.all(persistTargets.map((t) => persistNow(t.name)));
  await Promise.all(get().collections.filter((c) => c.linkedPath).map((c) => writeLinked(c.id)));
  await api.workspaceSwitch(id);
  window.location.reload();
}

// ---------------------------------------------------------------- load tests

export interface LoadRun {
  runId: string;
  running: boolean;
  config: LoadConfigInput;
  url: string;
  method: string;
  points: LoadEvent[];
  final?: LoadEvent;
  error?: string;
  startedAt: number;
}

/** Load-test runs by tab id (not persisted). */
export const useLoadRuns = create<Record<string, LoadRun>>(() => ({}));

/** Open a load-test tab for a request tab's current draft. */
export function openLoadTest(requestTabId: string) {
  const src = get().tabs.find((t) => t.id === requestTabId);
  if (!src?.draft) return;
  const tab: Tab = { id: uid(), kind: "loadtest", draft: clone(src.draft), saved: src.saved };
  set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
}

let loadListening = false;

export async function startLoadTest(tabId: string, config: LoadConfigInput) {
  const tab = get().tabs.find((t) => t.id === tabId);
  if (!tab?.draft) return;
  if (!loadListening) {
    loadListening = true;
    onEvent<LoadEvent>("lp://load", (ev) => {
      const runs = useLoadRuns.getState();
      const entry = Object.entries(runs).find(([, r]) => r.runId === ev.id);
      if (!entry) return;
      const [key, run] = entry;
      useLoadRuns.setState({ [key]: ev.kind === "done" ? { ...run, final: ev, running: false } : { ...run, points: [...run.points, ev].slice(-3600) } });
    });
  }
  const runId = uid();
  const col = get().collections.find((c) => c.id === tab.saved?.collectionId);
  const folders = (col && tab.saved && findPath(col.items, tab.saved.itemId)) || [];
  const scopes = buildScopes(col?.id);
  const request = clone(tab.draft);
  const auth = effectiveAuth(request, folders, col);
  let prepared: ReturnType<typeof prepareRequest>;
  try {
    prepared = prepareRequest(request, auth, scopes);
    if (!prepared.url) throw new Error("The request has no URL");
    const signed = await signRequest(prepared, auth, scopes);
    if (signed.length) prepared = { ...prepared, headers: [...prepared.headers, ...signed] };
  } catch (e) {
    useLoadRuns.setState({ [tabId]: { runId, running: false, config, url: tab.draft.url, method: tab.draft.method, points: [], error: String(e instanceof Error ? e.message : e), startedAt: Date.now() } });
    return;
  }
  useLoadRuns.setState({ [tabId]: { runId, running: true, config, url: prepared.url, method: prepared.method, points: [], startedAt: Date.now() } });
  log("info", `Load test: ${config.vus} virtual users × ${config.durationSecs}s → ${prepared.method} ${prepared.url}`);
  try {
    await api.loadStart({
      id: runId, ...config,
      request: { id: runId, method: prepared.method, url: prepared.url, headers: prepared.headers, body: prepared.body, options: nativeOptions(get().settings, request, prepared.url) },
    });
  } catch (e) {
    const run = useLoadRuns.getState()[tabId];
    if (run) useLoadRuns.setState({ [tabId]: { ...run, running: false, error: String(e) } });
  }
}

export function stopLoadTest(tabId: string) {
  const run = useLoadRuns.getState()[tabId];
  if (run?.running) api.loadStop(run.runId).catch(() => {});
}
