// Thin typed wrappers around the Rust commands.
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { HttpResponse } from "../types";

export interface MockRoute {
  method: string;
  path: string;
  query: { key: string; value: string }[];
  status: number;
  headers: { key: string; value: string }[];
  body: string;
  bodyBase64?: string | null;
  name: string;
}

export type ServerMode =
  | { kind: "mock"; routes: MockRoute[] }
  | { kind: "catcher"; response: { status: number; headers: { key: string; value: string }[]; body: string } };

export interface ServerInfo { id: string; port: number; host: string }

// Outside Tauri (plain browser, dev only) fall back to a small shim so the UI can be worked on.
// (`import.meta.env` is undefined when this module is loaded by the Node test runner.)
const DEV = import.meta.env ? import.meta.env.DEV : false;
const defaultInvoke: typeof tauriInvoke =
  DEV && !("__TAURI_INTERNALS__" in window)
    ? (async (cmd: string, args?: any) => (await import("./devShim")).devInvoke(cmd, args)) as typeof tauriInvoke
    : tauriInvoke;

let override: ((cmd: string, args?: any) => Promise<unknown>) | null = null;
/** Replace the backend (the CLI runs the same engine under Node with its own transport). */
export function setInvoke(fn: (cmd: string, args?: any) => Promise<unknown>) { override = fn; }
const invoke = ((cmd: string, args?: any) => (override ? override(cmd, args) : defaultInvoke(cmd, args))) as typeof tauriInvoke;

export interface NativeRequest {
  id: string;
  method: string;
  url: string;
  headers: { key: string; value: string }[];
  body:
    | { type: "none" }
    | { type: "text"; content: string }
    | { type: "urlEncoded"; fields: { key: string; value: string }[] }
    | { type: "formData"; fields: { key: string; value: string; kind: "text" | "file"; contentType?: string }[] }
    | { type: "binary"; path: string };
  options: {
    timeoutMs: number;
    followRedirects: boolean;
    maxRedirects: number;
    verifySsl: boolean;
    proxy: string | null;
    useSystemProxy: boolean;
    useCookies: boolean;
    clientCert?: { certPath: string; keyPath?: string } | null;
    caPath?: string | null;
  };
}

export interface CookieInfo {
  domain: string;
  path: string;
  name: string;
  value: string;
  expires: string | null;
  secure: boolean;
  httpOnly: boolean;
}

export const api = {
  send: (request: NativeRequest) => invoke<HttpResponse>("send_request", { request }),
  cancel: (id: string) => invoke<void>("cancel_request", { id }),
  storeRead: (name: string) => invoke<string | null>("store_read", { name }),
  storeWrite: (name: string, content: string) => invoke<void>("store_write", { name, content }),
  dataDir: () => invoke<string>("get_data_dir"),
  readTextFile: (path: string) => invoke<string>("read_text_file", { path }),
  writeTextFile: (path: string, content: string) => invoke<void>("write_text_file", { path, content }),
  writeBase64File: (path: string, content: string) => invoke<void>("write_base64_file", { path, content }),
  listCookies: () => invoke<CookieInfo[]>("list_cookies"),
  deleteCookie: (c: Pick<CookieInfo, "domain" | "path" | "name">) =>
    invoke<void>("delete_cookie", { domain: c.domain, path: c.path, name: c.name }),
  clearCookies: () => invoke<void>("clear_cookies"),
  stream: (request: NativeRequest) => invoke<void>("stream_request", { request }),
  wsConnect: (config: { id: string; url: string; headers: { key: string; value: string }[]; protocols: string[]; verifySsl: boolean }) =>
    invoke<void>("ws_connect", { config }),
  wsSend: (id: string, message: { text?: string; base64?: string }) => invoke<void>("ws_send", { id, ...message }),
  wsClose: (id: string, code?: number, reason?: string) => invoke<void>("ws_close", { id, code, reason }),
  oauthAuthorize: (request: { id: string; authorizeUrl: string; redirectUri: string; timeoutSecs?: number }) =>
    invoke<string>("oauth_authorize", { request }),
  secretsRead: () => invoke<string>("secrets_read"),
  secretsWrite: (content: string) => invoke<void>("secrets_write", { content }),
  secretsClear: () => invoke<void>("secrets_clear"),
  loadStart: (config: { id: string; request: NativeRequest; vus: number; durationSecs: number; rampUpSecs: number; maxRequests: number; thinkMs: number }) =>
    invoke<void>("load_start", { config }),
  loadStop: (id: string) => invoke<void>("load_stop", { id }),
  serverStart: (config: { id: string; port: number; delayMs: number; cors: boolean; allowLan: boolean } & ServerMode) =>
    invoke<ServerInfo>("server_start", { config }),
  serverStop: (id: string) => invoke<void>("server_stop", { id }),
  serverUpdate: (id: string, mode: ServerMode) => invoke<void>("server_update", { id, mode }),
  readDirFiles: (path: string, extensions: string[]) => invoke<{ path: string; content: string }[]>("read_dir_files", { path, extensions }),
  linkedWrite: (root: string, files: { path: string; content: string }[]) => invoke<{ written: number; removed: number }>("linked_write", { root, files }),
  linkedWatch: (root: string) => invoke<void>("linked_watch", { root }),
  linkedUnwatch: (root: string) => invoke<void>("linked_unwatch", { root }),
  workspaceList: () => invoke<{ active: string; workspaces: { id: string; name: string; path: string }[] }>("workspace_list"),
  workspaceCreate: (name: string, path?: string) => invoke<{ id: string; name: string; path: string }>("workspace_create", { name, path }),
  workspaceSwitch: (id: string) => invoke<string>("workspace_switch", { id }),
  workspaceRename: (id: string, name: string) => invoke<void>("workspace_rename", { id, name }),
  workspaceRemove: (id: string) => invoke<void>("workspace_remove", { id }),
  listUserThemes: () => invoke<{ dir: string; themes: { id: string; css: string; meta: string | null }[] }>("list_user_themes"),
};
