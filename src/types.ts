export type HttpMethod =
  | "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

export const METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

export interface KV {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
  description?: string;
  /** Only used for form-data rows. */
  type?: "text" | "file";
  /** Only used for variables. */
  secret?: boolean;
  /** On disk only: the value lives in the OS keychain (see Settings → Data). */
  inKeychain?: boolean;
}

export type AuthType = "inherit" | "none" | "basic" | "bearer" | "apikey" | "oauth2" | "digest" | "awsv4" | "hawk";

export interface OAuth2Token {
  accessToken: string;
  tokenType: string;
  refreshToken?: string;
  idToken?: string;
  scope?: string;
  /** Epoch ms; undefined when the server didn't say. */
  expiresAt?: number;
  obtainedAt: number;
}

export interface OAuth2Config {
  grantType: "authorization_code" | "client_credentials" | "password";
  authUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  audience: string;
  /** Loopback URL registered with the provider, e.g. http://127.0.0.1:7890/callback */
  redirectUri: string;
  usePkce: boolean;
  /** Send client credentials in the body or as HTTP Basic. */
  clientAuth: "body" | "header";
  username: string;
  password: string;
  headerPrefix: string;
  addTo: "header" | "query";
  autoRefresh: boolean;
  token?: OAuth2Token;
}

export interface Auth {
  type: AuthType;
  basic: { username: string; password: string };
  bearer: { token: string; prefix: string };
  apikey: { key: string; value: string; in: "header" | "query" };
  /** The fields below are optional so auths saved by older versions still load. */
  oauth2?: Partial<OAuth2Config>;
  digest?: { username: string; password: string };
  awsv4?: { accessKey: string; secretKey: string; sessionToken: string; region: string; service: string };
  hawk?: { id: string; key: string; algorithm: "sha256" | "sha1"; ext: string; includePayloadHash: boolean };
}

export type BodyMode = "none" | "raw" | "urlencoded" | "formdata" | "binary" | "graphql";
export type RawLanguage = "json" | "text" | "xml" | "html" | "javascript";

export interface Body {
  mode: BodyMode;
  raw: string;
  rawLanguage: RawLanguage;
  urlencoded: KV[];
  formdata: KV[];
  binaryPath: string;
  graphql: { query: string; variables: string };
}

export interface RequestSettings {
  followRedirects?: boolean;
  verifySsl?: boolean;
  timeoutMs?: number;
}

/** A saved response ("example"), shown under its request and served by mock servers. */
export interface Example {
  id: string;
  name: string;
  status: number;
  statusText?: string;
  /** `id` / `enabled` are set once the headers have been edited in the example view. */
  headers: { key: string; value: string; id?: string; enabled?: boolean }[];
  body: string;
  /** Set instead of `body` for binary responses. */
  bodyBase64?: string | null;
  /** The request that produced it; the mock server matches on this method and URL. */
  request?: { method: string; url: string };
}

export type Protocol = "http" | "ws" | "sse";

/** WebSocket-specific request data. */
export interface WsConfig {
  /** Message in the composer. */
  message: string;
  messageLanguage: "json" | "text";
  /** Comma-separated `Sec-WebSocket-Protocol` values. */
  protocols: string;
  /** Saved messages, one click to load into the composer. */
  saved: { id: string; name: string; body: string }[];
}

export interface RequestItem {
  id: string;
  type: "request";
  name: string;
  method: string;
  url: string;
  params: KV[];
  /** Values for `:name` segments in the URL path. */
  pathVariables?: KV[];
  headers: KV[];
  body: Body;
  auth: Auth;
  preRequestScript: string;
  testScript: string;
  description: string;
  settings: RequestSettings;
  /** Shown in the sidebar's "Pinned" group. */
  pinned?: boolean;
  examples?: Example[];
  /** Defaults to "http". */
  protocol?: Protocol;
  /** JSON Schema every response is checked against (shown in Test Results). */
  responseSchema?: string;
  ws?: WsConfig;
}

export interface FolderItem {
  id: string;
  type: "folder";
  name: string;
  items: Item[];
  auth: Auth;
  preRequestScript: string;
  testScript: string;
  description: string;
}

export type Item = RequestItem | FolderItem;

export interface Collection {
  id: string;
  name: string;
  /** Mirrored to this folder as one file per request (see src/lib/linked.ts). */
  linkedPath?: string;
  items: Item[];
  auth: Auth;
  variables: KV[];
  preRequestScript: string;
  testScript: string;
  description: string;
}

export interface Environment {
  id: string;
  name: string;
  variables: KV[];
}

export interface HttpResponse {
  status: number;
  statusText: string;
  httpVersion: string;
  url: string;
  remoteAddr: string | null;
  headers: { key: string; value: string }[];
  requestHeaders: { key: string; value: string }[];
  bodyText: string;
  bodyBase64: string | null;
  isBinary: boolean;
  size: number;
  headersSize: number;
  timeMs: number;
  ttfbMs: number;
}

export interface TestResult {
  name: string;
  passed: boolean;
  skipped?: boolean;
  error?: string;
}

export interface ConsoleEntry {
  id: string;
  time: number;
  level: "log" | "info" | "warn" | "error" | "request";
  message: string;
  detail?: unknown;
}

export interface RunResult {
  response?: HttpResponse;
  error?: string;
  tests: TestResult[];
  resolvedUrl: string;
  resolvedMethod: string;
}

export interface HistoryEntry {
  id: string;
  time: number;
  request: RequestItem;
  status?: number;
  timeMs?: number;
  error?: string;
}

/** Where a tab's request is saved. Undefined for unsaved scratch requests. */
export interface SavedRef {
  collectionId: string;
  itemId: string;
}

export type TabKind = "request" | "collection" | "folder" | "environment" | "runner" | "globals" | "example" | "server" | "loadtest" | "tool";

export interface Tab {
  id: string;
  kind: TabKind;
  /** For request tabs. */
  draft?: RequestItem;
  saved?: SavedRef;
  dirty?: boolean;
  loading?: boolean;
  /** Native id of the in-flight request, for cancellation. */
  pendingId?: string;
  result?: RunResult;
  /** The result before `result`, for "compare with previous response". Not persisted. */
  prevResult?: RunResult;
  /** WebSocket / SSE connection. Not persisted. */
  live?: LiveState;
  /** For collection / folder / runner tabs. */
  collectionId?: string;
  folderId?: string;
  /** For environment tabs. */
  environmentId?: string;
  /** For example tabs (with `collectionId`). */
  requestId?: string;
  exampleId?: string;
  /** For tool tabs (Dev toolbox). */
  toolId?: string;
  /** For mock server / webhook catcher tabs. */
  serverId?: string;
}

export interface LiveMessage {
  id: string;
  time: number;
  dir: "in" | "out" | "info" | "error";
  data: string;
  /** Base64 for binary WebSocket frames. */
  binary?: string | null;
  /** SSE `event:` and `id:` fields. */
  event?: string;
  eventId?: string;
}

export interface LiveState {
  connId: string;
  status: "connecting" | "open" | "closed";
  startedAt: number;
  head?: { status: number; statusText?: string; headers: { key: string; value: string }[] };
  messages: LiveMessage[];
  /** Resolved URL that was connected to. */
  url: string;
}

/** A mock server or webhook catcher definition (persisted; whether it's running is not). */
export interface ServerDef {
  id: string;
  kind: "mock" | "catcher";
  name: string;
  /** Mock: the collection whose examples it serves. */
  collectionId?: string;
  port: number;
  delayMs: number;
  cors: boolean;
  allowLan: boolean;
  /** Catcher: what every incoming request gets back. */
  response?: { status: number; headers: KV[]; body: string };
}

export interface LoadPercentiles { p50: number; p90: number; p95: number; p99: number; max: number; mean: number }

/** Per-second load-test progress (the `lp://load` event). */
export interface LoadEvent {
  id: string;
  kind: "tick" | "done";
  elapsedMs: number;
  activeVus: number;
  total: number;
  errors: number;
  rps: number;
  interval: LoadPercentiles;
  overall: LoadPercentiles;
  statuses: Record<string, number>;
  lastError: string | null;
}

export interface LoadConfigInput {
  vus: number;
  durationSecs: number;
  rampUpSecs: number;
  maxRequests: number;
  thinkMs: number;
}

/** One request received by a local server (the `lp://server` event). */
export interface ServerEvent {
  serverId: string;
  id: string;
  time: number;
  method: string;
  path: string;
  query: string;
  headers: { key: string; value: string }[];
  body: string;
  bodyBase64: string | null;
  size: number;
  status: number;
  matched: string | null;
  remoteAddr: string;
}

export interface Settings {
  /** Theme id from src/themes (e.g. "postman", "spotify"). */
  theme: string;
  mode: "dark" | "light";
  timeoutMs: number;
  followRedirects: boolean;
  maxRedirects: number;
  verifySsl: boolean;
  proxy: string;
  useSystemProxy: boolean;
  useCookies: boolean;
  historyLimit: number;
  fontSize: number;
  /** Request/response split: stacked or side by side. */
  layout: "vertical" | "horizontal";
  /** Extra trusted CA certificates (PEM bundle path). */
  caPath: string;
  /** Client certificates (mTLS), chosen by host. */
  certificates: ClientCertificate[];
  /** Keep secret variable values in the OS keychain instead of the JSON files. */
  useKeychain: boolean;
}

export interface ClientCertificate {
  id: string;
  /** `api.example.com`, `*.example.com`, optionally with `:port`. */
  host: string;
  certPath: string;
  keyPath: string;
  enabled: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "spotify",
  mode: "dark",
  timeoutMs: 30000,
  followRedirects: true,
  maxRedirects: 10,
  verifySsl: true,
  proxy: "",
  useSystemProxy: true,
  useCookies: true,
  historyLimit: 300,
  fontSize: 13,
  layout: "vertical",
  caPath: "",
  certificates: [],
  useKeychain: false,
};


/** Fill in defaults, and upgrade files from before themes existed (when `theme` held the mode). */
export function migrateSettings(saved: Partial<Settings> | null): Settings {
  const out = { ...DEFAULT_SETTINGS, ...(saved ?? {}) };
  if (saved && (saved.theme === "dark" || saved.theme === "light") && !saved.mode) {
    out.mode = saved.theme;
    out.theme = DEFAULT_SETTINGS.theme;
  }
  return out;
}
