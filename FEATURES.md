# Localpost features

Everything below runs on your machine. There is **no login, no cloud, no telemetry and no AI**.

Legend: ✅ supported · 🟡 partial · ❌ not supported (yet)

## Workspace & privacy

| Feature | Status | Notes |
|---|---|---|
| Use without an account / sign-in | ✅ | There is no account concept at all |
| All data stored locally as JSON | ✅ | See README → *Where is my data?* |
| No telemetry, analytics or crash reporting | ✅ | Enforced by a strict Content-Security-Policy |
| Workspace backup & restore (single file) | ✅ | Settings → Data → Export backup; restore via Import |
| Session restore (open tabs, unsaved drafts) | ✅ | |
| Multiple workspaces | ✅ | Header switcher: separate folders for collections, environments, history, cookies and settings; open any folder (a synced drive, a git repo) as a workspace |
| Git-friendly linked collections | ✅ | Collection menu → *Link to folder (git)…*: one readable JSON file per request, scripts and bodies as line arrays, secrets never written; outside changes (git pull, an editor) are picked up live |
| Themes | ✅ | Postman (classic) and Spotify (black frame, rounded panels, green accent, pills); pick in Settings → General. New themes plug into `src/themes/` |
| Dark and light modes | ✅ | Every theme has both; toggle from the status bar |
| Stacked or side-by-side request/response layout | ✅ | Settings → General, or the status-bar toggle |
| Resizable sidebar, panes and console | ✅ | |
| Custom themes | ✅ | Drop `<id>.css` (+ optional `<id>.json` metadata) into the themes folder; Settings → General → *Themes folder* |

## Productivity

| Feature | Status | Notes |
|---|---|---|
| Command palette | ✅ | ⌘K / ⌘P or the header search box: jump to any request, folder, collection or environment; type `>` for actions (new request, switch theme/mode/environment, run a collection, …) |
| Search inside requests | ✅ | ⌘⇧F, or Tab in the palette: URLs, headers, params, bodies, scripts and descriptions, with the match highlighted |
| Find & replace across a collection | ✅ | Collection menu → *Find & replace…*; plain text or regex (`$1` groups), match case, pick fields (URLs, params, headers, bodies, auth values); preview before applying |
| Pinned requests | ✅ | Request menu → *Pin to top*; shown in a *Pinned* group above the collections |
| Compare environments | ✅ | Missing and different keys side by side (globals included); secrets stay masked |

## Requests

| Feature | Status | Notes |
|---|---|---|
| Methods GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS | ✅ | |
| Custom methods (PROPFIND, PURGE, …) | ✅ | Method dropdown → *Custom…* |
| Query params editor, two-way synced with the URL | ✅ | Disabled params are kept |
| Path variables (`/users/:id`) | ✅ | Auto-detected table under Params |
| Headers editor with descriptions, enable/disable | ✅ | Shows auto-generated headers too |
| Bulk edit for params / headers / form fields | ✅ | `key:value` lines, `//` to disable |
| Body: none | ✅ | |
| Body: raw (JSON, Text, JavaScript, HTML, XML) with Beautify | ✅ | Implicit `Content-Type` |
| Body: `x-www-form-urlencoded` | ✅ | |
| Body: `form-data` with text **and file** fields | ✅ | Files are read from disk by the native engine |
| Body: binary (file) | ✅ | |
| Body: GraphQL (query + variables) | ✅ | |
| Paste a cURL command into the URL bar | ✅ | Converted into a full request |
| Per-request settings: redirects, SSL verification, timeout | ✅ | Otherwise the global settings apply |
| Request description / docs | ✅ | Request → Settings → Description |
| Cancel an in-flight request | ✅ | |
| Multiple tabs, unsaved-changes indicator, keyboard tab switching | ✅ | Drag-to-reorder tabs ❌ |
| Save / Save As to any collection or folder | ✅ | |
| No CORS restrictions | ✅ | Requests are sent from Rust, not the webview |
| HTTP/2 | ✅ | Negotiated automatically via ALPN |
| Automatic gzip / deflate / brotli / zstd decompression | ✅ | |
| WebSocket requests | ✅ | New → *WebSocket* (or the protocol picker on any request). Handshake headers, auth and `{{variables}}`, subprotocols, JSON/text composer with saved messages, live log of sent/received frames with filter and pretty JSON; `wss://` honours the SSL-verification setting |
| Server-Sent Events | ✅ | New → *Server-Sent Events*: streams `text/event-stream` responses live, showing each event's name, id and data; non-SSE responses are shown as raw chunks |
| GraphQL schema introspection | ✅ | Body → GraphQL → *Fetch schema*: schema-aware autocomplete and linting in the query editor, plus a Docs explorer |
| Socket.IO, gRPC, MQTT requests | ❌ | |

## Authorization

| Type | Status |
|---|---|
| Inherit auth from parent (folder → collection) | ✅ |
| No Auth | ✅ |
| Basic Auth | ✅ |
| Bearer Token (custom prefix) | ✅ |
| API Key (header or query param) | ✅ |
| OAuth 2.0: Authorization Code (+ PKCE), Client Credentials, Password | ✅ Loopback redirect (`http://127.0.0.1:<port>/callback`) with your system browser; token shown with expiry and JWT claims; refreshed automatically before a request when expired; Postman OAuth settings are imported |
| Digest Auth (MD5, SHA-256, `-sess`, `qop=auth/auth-int`) | ✅ Challenge answered and the request re-sent automatically |
| AWS Signature V4 | ✅ Incl. session tokens and S3 payload hashing |
| Hawk | ✅ SHA-256 / SHA-1, `ext`, optional payload hash |
| NTLM, Akamai EdgeGrid | ❌ |

## Variables & environments

| Feature | Status | Notes |
|---|---|---|
| Environments (create, rename, duplicate, delete, export) | ✅ | |
| Active environment selector | ✅ | Header dropdown |
| Environment quick look (👁) | ✅ | Active env + globals at a glance |
| Global variables | ✅ | |
| Collection variables | ✅ | |
| Local variables (`pm.variables.set`) and iteration data variables | ✅ | |
| Postman scope precedence | ✅ | local > data > environment > collection > global |
| Nested variables (`{{base_{{env}}}}`-style chains) | ✅ | Resolved recursively |
| Secret variables (masked on screen) | ✅ | Stored locally, optionally in the OS keychain |
| `{{variable}}` highlighting (green = resolved, red = missing) | ✅ | Everywhere: URL, params, headers, auth, bodies |
| Hover tooltip showing value and scope | ✅ | |
| `{{` autocomplete | ✅ | Includes dynamic variables |
| Dynamic variables | ✅ | `$guid`, `$randomUUID`, `$timestamp`, `$isoTimestamp`, `$randomInt`, `$randomEmail`, `$randomFirstName`, `$randomFullName`, `$randomUserName`, `$randomPassword`, `$randomPhoneNumber`, `$randomCity`, `$randomCountry`, `$randomColor`, `$randomHexColor`, `$randomIP`, `$randomUrl`, `$randomDomainName`, `$randomWord(s)`, `$randomLoremSentence`, `$randomPrice`, `$randomBoolean`, `$randomDatePast/Future/Recent`, `$randomCompanyName`, `$randomJobTitle`, … |

## Collections

| Feature | Status | Notes |
|---|---|---|
| Collections with nested folders | ✅ | |
| Drag & drop to reorder / move between folders and collections | ✅ | |
| Rename (double-click), duplicate, delete | ✅ | |
| Collection & folder level auth | ✅ | |
| Collection & folder level pre-request and test scripts | ✅ | Run in order collection → folder → request |
| Collection overview with description and stats | ✅ | Descriptions support Markdown (preview / edit) |
| Search / filter the sidebar | ✅ | Matches names and URLs |
| Context menus (right-click) everywhere | ✅ | |
| Saved example responses | ✅ | Response pane → *Save as example*; shown under the request in the sidebar; editable status, headers, body and matched URL; Postman `response[]` imported/exported |
| Forking, pull requests, comments, workspaces sharing | ❌ | Deliberately out of scope (cloud features) |

## Local servers

Everything listens on `127.0.0.1` only, unless you switch on *Allow other devices on my network* for that server.

| Feature | Status | Notes |
|---|---|---|
| Mock server from a collection's examples | ✅ | Collection menu → *Mock server…*, or the *Servers* rail. Matches method + path (`:id` / `{{var}}` segments are wildcards), then query params; `x-mock-response-name` / `x-mock-response-code` pick between examples |
| Live route updates | ✅ | Editing or adding examples updates a running mock without a restart |
| Response delay, CORS headers, port choice | ✅ | |
| "Use as environment" | ✅ | Creates and activates an environment with `baseUrl` pointing at the mock |
| Mock request log | ✅ | Which example answered each request, with full request details |
| Webhook catcher | ✅ | Records every request (method, path, query, headers, body); configurable response; *Open as request* and *Copy as cURL* |

## Scripts & tests

| Feature | Status |
|---|---|
| Pre-request scripts | ✅ |
| Post-response (test) scripts | ✅ |
| `pm.test`, `pm.test.skip`, async tests | ✅ |
| `pm.expect` (full Chai BDD) | ✅ |
| `pm.response.to.have.status / header / body / jsonBody`, `to.be.ok / success / clientError / serverError / notFound / json …`, `to.not.have.status` | ✅ |
| `pm.response.json() / text() / code / status / headers / cookies / responseTime / responseSize` | ✅ |
| `pm.request` mutation (URL, headers, method, raw body) | ✅ |
| `pm.environment / globals / collectionVariables / variables / iterationData` | ✅ |
| `pm.sendRequest` (callback or promise) | ✅ |
| `pm.info`, `pm.execution.setNextRequest`, `pm.execution.skipRequest` | ✅ |
| Legacy API: `tests[]`, `responseBody`, `responseCode`, `postman.setEnvironmentVariable` … | ✅ |
| `console.log/info/warn/error` → Console | ✅ |
| Snippets panel (one-click common scripts) | ✅ |
| JSON Schema validation: `pm.response.to.have.jsonSchema(s)`, `pm.expect(x).to.be.jsonSchema(s)`, `tv4.validate` | ✅ |
| Per-request **Response schema** (Settings tab), checked after every send and shown in Test Results | ✅ |
| `require()` of libraries (lodash, moment, crypto-js …) | ❌ |
| `pm.visualizer` | ❌ |

## Responses

| Feature | Status | Notes |
|---|---|---|
| Pretty view with syntax highlighting (JSON, XML, HTML, JS, text) | ✅ | Auto-detected or chosen manually |
| Raw view | ✅ | |
| Preview: HTML (sandboxed, remote resources blocked), images, PDF | ✅ | |
| Code folding, search (⌘F), line wrap toggle | ✅ | |
| Status, time and size with a detailed breakdown on hover | ✅ | TTFB/download, header/body size, HTTP version, remote address, final URL |
| Response headers | ✅ | |
| Response cookies | ✅ | Parsed `Set-Cookie` headers |
| Test results with Passed / Failed / Skipped filters | ✅ | |
| Copy body / headers, save response to file (text or binary) | ✅ | |
| Table view for JSON arrays | ✅ | Sortable columns, copy as CSV; also for `{ "data": [...] }`-style bodies |
| JSONPath filter | ✅ | e.g. `$.data[?(@.active)].name`; applies to Pretty and Table views |
| Compare with the previous response | ✅ | Side-by-side diff, JSON normalised first, unchanged lines collapsed |

## Collection runner

| Feature | Status |
|---|---|
| Run a whole collection or a single folder | ✅ |
| Choose which requests to run | ✅ |
| Iterations and delay between requests | ✅ |
| Data files (CSV and JSON) → `{{column}}` and `pm.iterationData` | ✅ |
| Persist variable changes after the run (toggle) | ✅ |
| Stop on first error or failed test (toggle) | ✅ |
| `setNextRequest` flow control (and `null` to stop) | ✅ |
| Live results: status, time, size, tests per request; summary stats | ✅ |
| Filter results (All / Passed / Failed), expand to see each test | ✅ |
| Export run report as JSON, JUnit XML or a self-contained HTML page | ✅ |
| Stop a running run | ✅ |
| Scheduled runs / monitors | ❌ (cloud feature) |

## Command-line runner (CI)

| Feature | Status | Notes |
|---|---|---|
| `localpost run <collection>` | ✅ | Same engine, scripting and runner as the app; Newman-style flags |
| Inputs | ✅ | Postman collection, Localpost backup, OpenAPI / HAR / Insomnia / Hoppscotch file, or a linked folder |
| Environment, globals, `--env-var`, data files, iterations, `--folder`, `--bail`, delay, timeout, `-k` | ✅ | |
| Reporters: `cli`, `json`, `junit`, `html` | ✅ | Exit code 0 / 1 (failure) / 2 (usage) |
| Cookies and redirects between requests | ✅ | |

## Load testing

| Feature | Status | Notes |
|---|---|---|
| Load test any HTTP request (Save ▾ → *Load test this request…*, or ⌘K) | ✅ | Runs natively in Rust |
| Virtual users, duration, ramp-up, max requests, think time | ✅ | Up to 1000 users |
| Live stats every second: req/s, p50/p95/p99, errors, active users | ✅ | HDR histogram |
| Throughput and latency charts, status-code breakdown | ✅ | |
| Stop at any time | ✅ | |

## Import / export

| Format | Import | Export |
|---|---|---|
| Postman Collection v2.1 | ✅ | ✅ |
| Postman Collection v2.0 | ✅ | — |
| OpenAPI 3.x / Swagger 2 (JSON or YAML) | ✅ Folders by tag, `{{baseUrl}}` from servers, path/query/header params, example bodies generated from schemas, documented responses become examples, security schemes become auth | ✅ OpenAPI 3.1 (YAML or JSON) |
| HAR (browser dev tools) | ✅ One folder per host; responses become examples | ✅ History → *Export history as HAR* |
| Insomnia v4 export | ✅ Workspaces, folders, environments, auth; `{{ _.var }}` converted | — |
| Hoppscotch collection | ✅ `<<var>>` converted | — |
| Bruno (`.bru` file or collection folder) | ✅ Folders, `seq` order, auth, scripts/tests, environments | — |
| Static HTML documentation | — | ✅ Collection → *Publish docs as HTML* (one self-contained file) |
| Postman environment | ✅ | ✅ |
| Postman globals | ✅ | ✅ |
| cURL command | ✅ (Import dialog or paste in URL bar) | ✅ (code snippet) |
| Localpost workspace backup | ✅ | ✅ |
| Drag & drop files into the Import dialog | ✅ | |

## Dev toolbox

Open **Tools** in the left rail (or ⌘K → "Tool: …"). Everything runs locally; nothing you paste is saved to disk.

| Tool | What it does |
|---|---|
| JWT decoder | Header, payload, `iat`/`nbf`/`exp` as dates and an expiry badge. Verifies HS256/384/512 (text or Base64 secret) and RS/PS/ES signatures (PEM public key or JWK/JWKS). Can also sign HS test tokens |
| Encode / decode | Base64, Base64URL, URL component, full URL, HTML entities, hex, Unicode escapes; swap output → input |
| Hash & HMAC | MD5, SHA-1, SHA-256, SHA-384, SHA-512 (and their HMACs) as hex or Base64 |
| UUID & ULID | Generate UUID v4, UUID v7 or ULIDs in bulk; inspect a UUID (v1/v6/v7) or ULID to read its timestamp |
| Timestamp converter | Unix seconds/ms/µs/ns (detected by size) or any date string → Unix, ISO 8601 (UTC and local), HTTP date, local and relative time |
| JSON ⇄ YAML ⇄ CSV | Convert between formats (CSV from arrays of objects) |
| JSON diff | Changed, added and removed paths between two documents, plus a side-by-side view |
| Regex tester | Live match highlighting, numbered and named groups, flags, replace preview |
| Cron explainer | Plain-English description, field breakdown and the next 5–25 run times |

**Use in request** puts a tool's output into the request you last worked on: as the body, a header (e.g. `Authorization: Bearer …`, `X-Request-ID`) or the Bearer token.

## Code snippets

cURL · raw HTTP · JavaScript fetch · Node.js axios · Python requests · Go net/http · PowerShell
`Invoke-RestMethod` · HTTPie · wget · Java HttpClient · C# HttpClient · PHP cURL · Ruby Net::HTTP ·
Rust reqwest · Swift URLSession, with an option to resolve variables or keep `{{placeholders}}`.

## Cookies

| Feature | Status |
|---|---|
| Persistent cookie jar (sent automatically on later requests) | ✅ |
| Cookie manager: browse by domain, delete one, clear all | ✅ |
| Enable/disable the jar | ✅ |
| Manually add or edit cookies | ❌ (set a `Cookie` header instead) |

## Network settings

| Feature | Status |
|---|---|
| Global request timeout | ✅ |
| SSL certificate verification on/off | ✅ |
| Follow redirects on/off, max redirects | ✅ |
| System proxy (HTTP_PROXY / HTTPS_PROXY / NO_PROXY) | ✅ |
| Custom proxy: `http://`, `https://`, `socks5://`, `socks5h://` with auth | ✅ |
| Client certificates (mTLS) | ✅ Settings → Certificates: PEM certificate + unencrypted key, matched by host (`*.example.com`, optional `:port`) |
| Custom CA certificates | ✅ A PEM bundle trusted in addition to the built-in roots |

## Security

| Feature | Status | Notes |
|---|---|---|
| Secret variables in the OS keychain | ✅ | Settings → Data (opt-in). Values of variables marked *secret* move to the macOS Keychain / Windows Credential Manager / Secret Service; the JSON files keep only a placeholder. If the keychain is unavailable the values stay in the files and a warning is logged |
| Secret-leak guard on export | ✅ | Exports and backups are scanned for secret variables, literal credentials in auth settings and sensitive headers; you can strip them from the exported copy |

## Console & history

| Feature | Status |
|---|---|
| Console with every request (method, URL, status, time), expandable request/response details | ✅ |
| Script `console.*` output, script errors | ✅ |
| Filter by level, search, clear | ✅ |
| History grouped by day, searchable | ✅ |
| Re-open a history entry, save it to a collection, delete, clear all | ✅ |
| Configurable history limit | ✅ |

## Deliberately not included

- Sign-in, teams, workspaces sharing, cloud sync, public API network
- Cloud-hosted mock servers and monitors, API design / governance (local mock servers are included)
- Any AI assistant or AI-generated tests/docs
- Telemetry, usage analytics, crash reporting, auto-update pings
