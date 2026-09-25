# Localpost architecture

Localpost is a [Tauri 2](https://tauri.app) desktop application: a small **Rust** process hosts the
operating system's **webview**, which runs a **React + TypeScript** single-page app. The two halves
talk over Tauri's IPC bridge: the UI calls Rust with `invoke`, and Rust pushes live data (stream
chunks, WebSocket frames, server logs, load-test stats) back as events. There is no server
component and no network traffic other than what the user starts.

```
┌─────────────────────────────────── Localpost process ─────────────────────────────────────┐
│                                                                                            │
│  Webview (React + TypeScript)                        Rust core (tauri, tokio)               │
│  ┌──────────────────────────────────────┐   invoke   ┌────────────────────────────────┐    │
│  │ components/ (sidebar, tabs, editors,  │ ─────────► │ http.rs      send / stream     │──────► APIs you call
│  │  response viewer, runner, servers,    │            │ ws.rs        WebSocket client  │──────►
│  │  load test, tools/ …)                 │            │ load.rs      load generator    │──────►
│  │            │           ▲              │            │ servers.rs   mock + catcher    │◄────── 127.0.0.1
│  │            ▼           │              │   events   │ oauth.rs     loopback callback │◄────── 127.0.0.1
│  │ store.ts (Zustand) ── state/actions   │ ◄───────── │ storage.rs   JSON store, files │──────► app data dir
│  │ lib/engine.ts → scripting · vars      │  lp://…    │ workspaces.rs · linked.rs      │──────► linked folders
│  │ lib/ importers · exporters · codegen  │            │ secrets.rs   OS keychain       │──────► Keychain
│  │      runner · reports · tools …       │            └────────────────────────────────┘    │
│  └──────────────────────────────────────┘                                                   │
└────────────────────────────────────────────────────────────────────────────────────────────┘
        cli/ (Node): the same lib/ engine + runner, with an undici transport instead of Rust
```

## Design principles

1. **Local only.** No accounts, sync, telemetry or remote assets (fonts, icons and libraries are
   all bundled). The webview's Content-Security-Policy only allows the app's own resources and IPC,
   so even a bug in the UI cannot make it phone home. Only the Rust core opens connections (HTTP,
   streams, WebSockets, load tests), and only when the user sends, connects or starts something.
   Local listeners (mock servers, webhook catchers, the OAuth callback) bind to `127.0.0.1` unless
   the user explicitly allows the LAN.
2. **Postman-compatible model.** The data model, variable scoping, script API (`pm.*`) and
   import/export follow Postman's semantics so existing collections and scripts keep working.
3. **Native HTTP.** Requests are made from Rust, not from the webview's `fetch`, so there is no
   CORS, and TLS verification, proxies, redirects, cookies and multipart uploads are fully under the app's control.
4. **Plain files.** State is persisted as pretty-printed JSON that humans (and git) can read.

## Frontend

### State: `src/store.ts`

A single [Zustand](https://github.com/pmndrs/zustand) store holds everything:

| Slice | Persisted to | Notes |
|-------|--------------|-------|
| `collections` | `collections.json` | Tree of collections → folders → requests |
| `environments`, `activeEnvironmentId` | `environments.json`, `session.json` | |
| `globals` | `globals.json` | |
| `history` | `history.json` | Snapshot of each sent request + status/time |
| `settings` | `settings.json` | Theme and mode, timeouts, SSL, proxy, cookies, layout, certificates, keychain… |
| `servers` | `servers.json` | Mock server and webhook catcher definitions (not their running state) |
| `tabs`, `activeTabId`, `sidebarView` | `session.json` | Includes unsaved drafts; responses are *not* persisted |
| `console`, `modal`, `consoleOpen`, `serverRuntime` | — | Ephemeral UI state |

Some state lives in small side stores so hot updates don't re-render the whole app: `useLoadRuns`
(load-test samples), `useSchemas` (GraphQL schemas, `lib/graphql.ts`) and the Dev toolbox inputs
(`components/tools/shared.tsx`, memory only).

When **keychain storage** is on, secret variable values are written to the OS keychain first
(`secrets.rs`) and then blanked in the JSON files (`inKeychain: true`), and they are merged back in
at load time. A **linked collection** is also mirrored to its folder (`writeLinked` → `linked_write`),
and outside edits come back through the `lp://fs-changed` watcher.

`initStore()` loads every file through the `store_read` command, then subscribes to the store. When a
slice changes (reference inequality), a 250 ms debounced write sends it to `store_write`, which
writes atomically (temp file + rename). Actions are plain exported functions (`createCollection`,
`moveItem`, `saveTab`, `sendTab`, …) that call `setState` with immutable updates. Tree mutations
deep-clone the affected collection.

### Tabs and drafts

A request tab owns a **draft** (`RequestItem` clone) plus an optional `saved` reference
`{collectionId, itemId}`. Editing marks the tab dirty. **Save** copies the draft back into the
collection tree; tabs without a saved ref open the *Save As* dialog. All tabs stay mounted (hidden
with `display:none`), so editor state, scroll positions and collection runs survive tab switches.

### The request pipeline: `src/lib/engine.ts`

```
executeRequest()
 ├─ build ScriptRequest (mutable pm.request)
 ├─ pre-request scripts: collection → each parent folder → request
 │    (may mutate pm.request, set variables, call pm.sendRequest, skip the request)
 ├─ prepareRequest()
 │    ├─ apply :path variables
 │    ├─ resolve {{variables}} (local > data > environment > collection > globals, recursive)
 │    ├─ effectiveAuth(): request → nearest folder → collection ("inherit" walks up)
 │    ├─ add auth header / query param, implicit Content-Type for raw/GraphQL bodies
 │    └─ serialise body (raw, urlencoded, multipart form-data, binary file, GraphQL)
 ├─ api.send()  ──►  Rust send_request
 ├─ test scripts: collection → folders → request (with pm.response)
 └─ return RunResult {response | error, tests[], resolvedUrl}
```

The caller builds the variable **scopes** from the store (`buildScopes`), and afterwards writes back
any variables changed by scripts (`commitScopes`). The collection runner keeps a single scope set
for the whole run, so values set by one request are visible to the next.

### Scripting sandbox: `src/lib/scripting.ts`

User scripts are compiled with `new AsyncFunction(...)` and receive a Postman-compatible API:

- `pm.test`, `pm.test.skip`, `pm.expect` ([Chai](https://www.chaijs.com)), BDD response assertions
  (`pm.response.to.have.status(…)`, `.to.be.ok`, `.to.have.header`, `.to.have.jsonBody`, …)
- `pm.environment`, `pm.globals`, `pm.collectionVariables`, `pm.variables`, `pm.iterationData`
- `pm.request` (mutable URL/headers/method/body), `pm.response` (`code`, `status`, `json()`,
  `text()`, `headers`, `cookies`, `responseTime`, `responseSize`)
- `pm.sendRequest(urlOrRequest, callback?)` (returns a promise, awaited before the script finishes)
- `pm.info`, `pm.execution.setNextRequest` / `postman.setNextRequest`, `pm.execution.skipRequest`
- Legacy globals: `tests[...]`, `responseBody`, `responseCode`, `responseHeaders`, `responseTime`,
  `postman.setEnvironmentVariable` etc.
- `console.log/info/warn/error` routed to the in-app console

Async tests and `sendRequest` callbacks are tracked, and the runner waits until the pending set is
empty. Scripts are code the user wrote, run on the user's own machine. The only network access
they get is `pm.sendRequest`, which goes through the same Rust engine.

### Variables: `src/lib/vars.ts`

`VarScope` wraps a list of `KV` rows and records whether it was modified. `resolve()` replaces
`{{name}}` recursively (up to 8 levels) and supports ~30 dynamic variables such as `{{$guid}}`,
`{{$timestamp}}`, `{{$isoTimestamp}}`, `{{$randomInt}}` and `{{$randomEmail}}`.

### Editors: CodeMirror 6

- `VarInput`: a single-line CodeMirror used for the URL bar and every key/value cell. It
  highlights variables green (resolved) or red (unresolved), shows hover tooltips with the value and
  its scope, autocompletes after `{{`, and detects pasted cURL commands.
- `CodeEditor`: a multi-line editor for bodies, scripts and responses, with JSON/JS/XML/HTML
  modes, folding, search, and optional variable highlighting.
- `VarProvider` (React context) provides the variable lookup through a stable ref, so extensions are
  never rebuilt, plus a version value that makes editors repaint when variables change.

### Other modules

| Module | Responsibility |
|--------|----------------|
| `importexport.ts` | Postman Collection v2.0/v2.1 ⇄ internal model (folders, auth, scripts, variables, path vars, disabled rows, form-data files, GraphQL), Postman environments/globals, a shell-aware cURL parser, workspace backups, and format auto-detection |
| `codegen.ts` | Snippets for cURL, raw HTTP, JS fetch, Node axios, Python requests, Go net/http and PowerShell from a prepared request |
| `runner.ts` | Sequential collection/folder runs with iterations, delay, CSV/JSON data rows, `setNextRequest`, stop-on-failure and cancellation |
| `utils.ts` | Tree helpers (find/remove/move/clone), URL ⇄ query-params sync that preserves `{{vars}}` and disabled rows, `:path` variable handling, formatting |
| `importers.ts` | OpenAPI 3 / Swagger 2 (with example bodies from schemas), HAR, Insomnia v4, Hoppscotch and Bruno (`.bru`) importers; HAR export of history |
| `exporters.ts` | Collection → OpenAPI 3.1, and a self-contained HTML documentation page |
| `linked.ts` | Collection ⇄ git-friendly folder layout (`collection.json`, `folder.json`, `*.request.json`, multi-line strings as line arrays, secrets never written) |
| `search.ts` | Fuzzy ranking for the command palette, full-text search, find & replace, JSON → table/CSV, environment compare |
| `mock.ts` | Compiles saved examples into mock routes (`:id` and `{{var}}` segments become wildcards) |
| `sse.ts`, `graphql.ts` | Server-Sent Events parser; GraphQL introspection and schema cache |
| `oauth.ts`, `authsign.ts`, `crypto.ts` | OAuth 2.0 grants (code + PKCE, client credentials, password, refresh); Digest, AWS SigV4 and Hawk signing; WebCrypto helpers and MD5 |
| `leaks.ts` | Secret-leak scan run before exports and backups |
| `schema.ts` | JSON Schema validation (Ajv) for `pm.response.to.have.jsonSchema` and the per-request response schema |
| `reports.ts` | Run reports as JSON, JUnit XML and HTML (runner view and CLI) |
| `tools.ts` | Dev toolbox transforms: JWT decode/verify/sign, encoders, hashes/HMAC, UUID v4/v7/ULID, time parsing, JSON ⇄ YAML ⇄ CSV, JSON diff, regex, cron |
| `events.ts` | `onEvent(topic, handler)`: Tauri `listen()` in the app, a `window` event in the browser preview |
| `devShim.ts` | Browser-only fallback for `npm run dev` (localStorage, `fetch`, browser WebSocket/streams, simulated load tests); dead-code-eliminated from production |

### Dev toolbox: `src/components/tools/`

`index.tsx` holds the `TOOLS` registry (id, name, icon, description, component), the sidebar list
and the tab host (`TabKind` `tool` with a `toolId`). Each tool is one component that keeps its
inputs in the shared in-memory tool store, so they survive tab switches but are never written
to disk. "Use in request" (`sendToRequest`) writes a value into the request tab the user was last
on: as the body, a header, or a Bearer token. To add a tool, write the logic in `lib/tools.ts`
(with tests), then add a component and a `TOOLS` entry.

### Command-line runner: `cli/`

`localpost.ts` parses Newman-style flags, loads any supported file (or a linked folder), and runs it
with the same `runner.ts`, `engine.ts` and `scripting.ts` as the app. It swaps the backend with
`api.setInvoke(nodeInvoke())`. `transport.ts` implements `send_request` with undici: cookies via
tough-cookie, manual redirects, proxy, client certificates and custom CA. `scripts/build-cli.mjs`
bundles it with esbuild into `dist-cli/localpost.mjs`.

## Backend (Rust): `src-tauri/src`

### `lib.rs`

Sets up the app: dialog and opener plugins, resolves the active workspace's data folder, loads the
persistent cookie jar, and registers the commands. The shared `AppState` holds:

- the app dir, and the data dir behind an `RwLock` (`data_dir()` / `set_data_dir()`)
- the cookie jar
- the in-flight cancellation channels
- the running servers, WebSocket connections, folder watchers and load tests

Live data reaches the UI as events: `lp://stream`, `lp://ws`, `lp://server`, `lp://load` and
`lp://fs-changed`.

### `http.rs`: the HTTP engine

`send_request(request)`:

1. Builds a `reqwest::Client` from the per-request options: timeout, redirect policy
   (follow/limit/none), `danger_accept_invalid_certs` for disabled SSL verification, cookie
   provider, and a proxy (custom `http/https/socks5/socks5h`, system env proxies, or none).
2. Builds the request: headers in order (duplicates preserved), and the body: text,
   `application/x-www-form-urlencoded`, multipart (text parts and files read from disk with a guessed
   MIME type), or a binary file.
3. Records the actual request headers, then measures time-to-first-byte and total time.
4. Returns status, reason, HTTP version, final URL (after redirects), remote address, response
   headers, body as text, plus base64 for binary types such as images and PDFs (used for previews
   and "save to file"), sizes and timings.
5. Persists the cookie jar after each request when cookies are enabled.

Each request races against a `oneshot` channel in `tokio::select!`; `cancel_request(id)` fires it,
which drops the in-flight future and aborts the connection.

TLS uses **rustls** with bundled roots, so it doesn't depend on OpenSSL. Response decompression
(gzip, deflate, brotli, zstd) and HTTP/2 are enabled. A client certificate (PEM certificate + key) is
attached when its host pattern matches, and an extra CA bundle can be trusted. `stream_request`
sends the same request but emits the body as `lp://stream` chunks (used for Server-Sent Events).

### Other Rust modules

| Module | Responsibility |
|--------|----------------|
| `ws.rs` | WebSocket client (tokio-tungstenite, rustls): `ws_connect` / `ws_send` / `ws_close`, frames as `lp://ws` events |
| `servers.rs` | Mock servers and webhook catchers on axum. Route matching (method, path, query, `x-mock-response-name` / `-code`) happens here, and every hit is sent as an `lp://server` event |
| `oauth.rs` | One-shot loopback listener for the OAuth authorization-code redirect; opens the system browser |
| `secrets.rs` | Keychain storage (keyring crate): one item per workspace holding a JSON map of secret values |
| `workspaces.rs` | Workspace registry (`<app data>/workspaces.json`) and switching the data dir |
| `linked.rs` | Writes a linked collection's files (only the ones that changed) and watches the folder (notify) |
| `load.rs` | Load generator: N workers with ramp-up, think time and a duration or request limit; HDR histograms; `lp://load` stats every second |

### `storage.rs`

- `store_read(name)` / `store_write(name, content)`: whitelisted store names
  (`[A-Za-z0-9_-]+`) mapped to `<data>/<name>.json`, written atomically.
- `read_text_file`, `write_text_file`, `write_base64_file`: used for import/export and "save
  response". The path always comes from a native file dialog the user interacted with.
- `read_dir_files`: reads a folder the user picked (Bruno or linked-collection import).
- `list_user_themes`: the `*.css` (+ optional `.json`) files in `<app data>/themes`.
- Cookie jar persistence (`cookie_store` JSON) and `list_cookies` / `delete_cookie` / `clear_cookies`
  for the cookie manager.

## Security model

- **CSP**: `default-src 'self'`, with IPC-only `connect-src`, and inline styles plus `eval` allowed
  (the script sandbox needs them). No remote origins are allowed for scripts, styles, fonts or
  images, so the UI cannot load anything from the internet.
- **Capabilities**: the webview only gets `core:default`, `dialog:default` and `opener:default`
  (reveal the data folder). There is no generic filesystem or shell plugin. File access goes through
  the small set of Rust commands above.
- **HTML preview**: rendered in a fully sandboxed `<iframe sandbox srcdoc>`, so there is no script
  execution and no access to the app.
- **Secrets**: by default stored locally in plain JSON (like `.env` files), with *secret*
  variables masked in the UI. With Settings → Data → *Store secret variables in the system keychain*,
  secret values leave the JSON files entirely. Exports and backups run a leak scan first and
  offer to strip secrets.
- **Listeners**: mock servers, catchers and the OAuth callback bind to `127.0.0.1` by default;
  LAN binding is a per-server opt-in.

## Data model (abridged)

```ts
Collection { id, name, items: Item[], auth, variables: KV[], preRequestScript, testScript, description, linkedPath? }
Item = FolderItem | RequestItem
FolderItem { id, type: "folder", name, items: Item[], auth, preRequestScript, testScript, description }
RequestItem {
  id, type: "request", name, method, url,
  params: KV[], pathVariables?: KV[], headers: KV[],
  body: { mode: none|raw|urlencoded|formdata|binary|graphql, raw, rawLanguage, urlencoded, formdata, binaryPath, graphql },
  auth: { type: inherit|none|basic|bearer|apikey|oauth2|digest|awsv4|hawk, … },
  protocol?: http|ws|sse, ws?: { protocols, messages },
  examples?: Example[], pinned?, responseSchema?,
  preRequestScript, testScript, description,
  settings: { followRedirects?, verifySsl?, timeoutMs? }   // per-request overrides
}
Example { id, name, status, statusText, headers, body, request? }
KV { id, key, value, enabled, description?, type?: text|file, secret?, inKeychain? }
Environment { id, name, variables: KV[] }
```

### Themes: `src/themes/`

Two attributes on `<html>` drive the look: `data-theme` names the theme and `data-mode` is
`dark` or `light`. Both come from `settings.theme` and `settings.mode`, and `applyTheme()` sets
them. `index.ts` is the registry that the picker in Settings → General lists.

| File | Role |
|------|------|
| `postman.css` | The **base** theme. Its tokens sit on plain `:root` (and `:root[data-mode="light"]`), so they are the fallback for every token another theme leaves out. The structural rules in `styles.css` are written for this look. |
| `spotify.css` | Overrides the colour tokens and adds its own layout rules (rounded panels, pills, chip tabs). Every selector is scoped to `:root[data-theme="spotify"]`. It also pulls in the bundled Figtree font. |
| `index.ts` | `THEMES` (id, name, description, preview colours), `resolveTheme()` (unknown ids fall back to the default) and `applyTheme()`. |

Tokens are CSS custom properties: `--bg-0…4`, `--text…3`, `--accent`, `--primary`,
`--on-primary`, method colours `--m-*`, syntax colours `--syn-*`, variable highlights `--var-*`,
the logo's `--logo-bg`/`--logo-fg`, `--sans`, `--radius` and others. `postman.css` is the
complete list.

#### Adding a theme

1. Create `src/themes/<id>.css`. Override only the tokens you want to change:
   ```css
   :root[data-theme="<id>"]:not([data-mode="light"]) { --accent: #8b5cf6; --bg-1: #17131f; /* … */ }
   :root[data-theme="<id>"][data-mode="light"]       { --accent: #7c3aed; /* … */ }
   ```
   Optionally, add structural rules scoped to `:root[data-theme="<id>"] .selector` (see
   `spotify.css`). Scoping keeps them from leaking into other themes, and the extra
   specificity beats the base rules without `!important`.
2. Import the file in `src/themes/index.ts` and add a `ThemeDef` to `THEMES`.

Users can also add themes without rebuilding: put `<id>.css` (and optionally `<id>.json` with
`{ "name", "description", "preview": { "dark": {…}, "light": {…} } }`) in `<app data>/themes`. `loadUserThemes()` injects
each file as a `<style>` tag and adds it to the picker.

Fonts must be bundled (for example via `@fontsource/*`); the CSP blocks remote assets.

## Extending

- **New auth type**: add it to `AuthType` in `types.ts`, the editor in `AuthEditor.tsx`, the
  application logic in `prepareRequest()` (`engine.ts`), and import/export mapping in
  `importexport.ts`.
- **New theme**: see [Adding a theme](#adding-a-theme).
- **New code snippet language**: add an entry to `LANGUAGES` and a generator in `codegen.ts`.
- **New tool**: see [Dev toolbox](#dev-toolbox-srccomponentstools).
- **New importer**: add a parser in `importers.ts` and a detection branch in `detectImport()`
  (`importexport.ts`). The CLI and the Import dialog pick it up automatically.
- **New Rust command**: implement it in a module under `src-tauri/src`, register it in
  `generate_handler!` in `lib.rs`, and add a typed wrapper in `src/lib/api.ts`.
