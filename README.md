# Localpost

**A fully local API client — the Postman experience without the login.**

Localpost is a desktop app for building, testing and automating HTTP APIs. It looks and works like
Postman (collections, environments, scripts, tests, collection runner, code snippets, cookies,
console…) and adds tools Postman keeps behind a login or doesn't have at all:

- mock servers and webhook catchers
- WebSocket, Server-Sent Events and GraphQL
- OAuth 2.0, Digest, AWS SigV4 and Hawk auth, plus mTLS
- OpenAPI, HAR, Insomnia and Bruno import
- git-friendly linked folders and workspaces
- a CLI runner for CI, load testing, and a dev toolbox

It is **100 % local**:

- **No account, no sign-in, no cloud sync.** Open the app and start working.
- **No telemetry, analytics, crash reporting or update pings.** The app never contacts any server
  except the ones *you* send requests to.
- **No AI features.**
- **Your data is plain JSON on your disk** — easy to back up, diff, or put in git.

It is built with [Tauri 2](https://tauri.app) (Rust backend + system webview), React and TypeScript.
Installers are small (≈5 MB DMG on macOS, ≈15 MB installed) and the app starts in well under a second.

See [FEATURES.md](FEATURES.md) for the full feature list and [ARCHITECTURE.md](ARCHITECTURE.md) for
how it's put together.

---

## Table of contents

1. [Quick start](#quick-start)
2. [Prerequisites](#prerequisites)
3. [Building from source](#building-from-source)
4. [Development workflow](#development-workflow)
5. [Where is my data?](#where-is-my-data)
6. [Migrating from Postman](#migrating-from-postman)
7. [Keyboard shortcuts](#keyboard-shortcuts)
8. [Command-line runner](#command-line-runner)
9. [Troubleshooting](#troubleshooting)
10. [Project layout](#project-layout)

---

## Quick start

```bash
git clone <this repo> localpost && cd localpost
npm install
npm run tauri dev        # run the app in development mode
npm run tauri build      # produce a native installer
```

---

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| **Node.js** | 18+ (tested with 24) | Builds the frontend. npm ships with it. |
| **Rust** | 1.77+ (tested with 1.97) | Install with [rustup](https://rustup.rs): `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| **Platform toolchain** | see below | Needed by Tauri to compile and link the native app. |

### macOS

```bash
xcode-select --install          # Xcode Command Line Tools (clang, linker, SDK)
```

Full Xcode is **not** required.

### Windows

1. Install **Microsoft C++ Build Tools** (select “Desktop development with C++”).
2. **WebView2** is preinstalled on Windows 10 (1803+) and 11. If it's missing, install the
   Evergreen runtime from Microsoft.
3. Install Rust with the MSVC toolchain (`rustup default stable-msvc`).

### Linux (Debian/Ubuntu)

```bash
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev libdbus-1-dev pkg-config
```

(`libdbus-1-dev` is for the optional keychain storage of secrets, via the Secret Service API.)

For Fedora, Arch and others see the [Tauri prerequisites guide](https://tauri.app/start/prerequisites/).

---

## Building from source

### 1. Install JavaScript dependencies

```bash
npm install
```

### 2. (Optional) Pre-fetch Rust crates

`tauri dev`/`tauri build` download crates automatically, but you can fetch them up front:

```bash
cd src-tauri && cargo fetch && cd ..
```

> **Behind a proxy / firewall?** Cargo honours `CARGO_HTTP_PROXY` (and `HTTPS_PROXY`). SOCKS5 works
> too — use `socks5h://` so DNS is resolved through the proxy:
>
> ```bash
> export CARGO_HTTP_PROXY=socks5h://127.0.0.1:1081
> ```
>
> For npm: `npm config set proxy http://host:port` / `npm config set https-proxy http://host:port`.

### 3. Build the native app

```bash
npm run tauri build
```

This runs `npm run build` (type-check + Vite production build into `dist/`), then compiles the Rust
backend in release mode and packages it. Output:

| Platform | Output (under `src-tauri/target/release/bundle/`) |
|----------|---------------------------------------------------|
| macOS    | `macos/Localpost.app`, `dmg/Localpost_0.1.0_<arch>.dmg` |
| Windows  | `msi/Localpost_0.1.0_x64_en-US.msi`, `nsis/Localpost_0.1.0_x64-setup.exe` |
| Linux    | `deb/…deb`, `rpm/…rpm`, `appimage/…AppImage` |

The raw executable is at `src-tauri/target/release/localpost` (`localpost.exe` on Windows).

#### Build only one bundle type

```bash
npm run tauri build -- --bundles app        # macOS .app only (fastest)
npm run tauri build -- --bundles dmg
npm run tauri build -- --bundles deb,appimage
```

#### Debug build (faster compile, includes devtools)

```bash
npm run tauri build -- --debug
```

#### Universal macOS binary (Intel + Apple Silicon)

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run tauri build -- --target universal-apple-darwin
```

#### Code signing

Unsigned builds work fine on your own machine. On macOS, an unsigned app downloaded from elsewhere
must be opened once via right-click → **Open** (or `xattr -dr com.apple.quarantine Localpost.app`).
To sign/notarise for distribution, see Tauri's
[macOS](https://tauri.app/distribute/sign/macos/) and
[Windows](https://tauri.app/distribute/sign/windows/) signing guides.

### 4. Regenerating icons (optional)

The app icon source is `app-icon.svg`. After editing it:

```bash
npx tauri icon app-icon.svg -o src-tauri/icons
```

---

## Development workflow

```bash
npm run tauri dev
```

- Starts Vite on `http://localhost:1420` with hot-module reload for the UI.
- Compiles and launches the Rust app, which loads the dev server. Rust changes trigger a rebuild
  and restart automatically.
- Right-click → **Inspect Element** opens the webview devtools in dev builds.

Other scripts:

| Command | What it does |
|---------|--------------|
| `npm run dev` | Frontend only, in a normal browser. A dev-only shim (`src/lib/devShim.ts`) stores data in `localStorage` and sends requests with `fetch` (subject to CORS). Handy for UI work; never included in production builds. |
| `npm run build` | Type-check (`tsc --noEmit`) and build the frontend into `dist/`. |
| `npm test` | Run the headless logic tests (`tests/logic.test.ts`), the CLI end-to-end test (`tests/cli.test.ts`) and the Rust tests (`cargo test`). |
| `npm run build:cli` | Bundle the command-line runner into `dist-cli/localpost.mjs`. |
| `npm run test:js` | Only the TypeScript logic tests. |
| `cd src-tauri && cargo check` | Type-check the Rust backend. |
| `cd src-tauri && cargo clippy` | Lint the Rust backend. |

---

## Where is my data?

Everything lives in one folder of plain, pretty-printed JSON files:

| OS | Location |
|----|----------|
| macOS | `~/Library/Application Support/dev.localpost.app/data/` |
| Windows | `%APPDATA%\dev.localpost.app\data\` |
| Linux | `~/.local/share/dev.localpost.app/data/` |

| File | Contents |
|------|----------|
| `collections.json` | All collections, folders and requests (incl. scripts, auth, variables) |
| `environments.json` | Environments and their variables |
| `globals.json` | Global variables |
| `history.json` | Request history (limit configurable in Settings → Data) |
| `settings.json` | App settings |
| `session.json` | Open tabs and unsaved drafts, restored on next launch |
| `cookies.json` | The cookie jar |

**Settings → Data** shows the exact path with a “Show in Finder/Explorer” button and lets you export
a single-file **workspace backup** (collections + environments + globals) that can be re-imported.

Writes are atomic (temp file + rename), so a crash never leaves a half-written file. To start fresh,
quit the app and delete the folder. To sync between machines, put the folder in a synced drive or a
git repo of your choice — Localpost itself never syncs anything.

> Secrets: variable values (including ones marked *secret*, which are only masked on screen) are
> stored in plain text in these files, just like any other local config. Protect the folder the same
> way you would protect `~/.ssh` or `.env` files.

---

## Migrating from Postman

1. In Postman, export each collection (**… → Export → Collection v2.1**) and each environment
   (**Environments → … → Export**). Globals can be exported too.
2. In Localpost, click **Import** (⌘O / Ctrl+O), drop the files in (or choose them), and click
   **Import**. You can import many files at once.

Supported import formats: Postman Collection v2.0 & v2.1, Postman environment and globals files,
cURL commands (also by pasting directly into the URL bar), and Localpost workspace backups.

Collections exported from Localpost are Postman v2.1 files, so you can always go back.

---

## Keyboard shortcuts

(`⌘` on macOS, `Ctrl` on Windows/Linux)

| Shortcut | Action |
|----------|--------|
| `⌘ K` / `⌘ P` | Command palette (go to anything; type `>` for actions) |
| `⌘ ⇧ F` | Search inside requests |
| `⌘ Enter` | Send request |
| `⌘ S` | Save request |
| `⌘ T` | New request tab |
| `⌘ W` | Close tab |
| `⌘ ]` / `⌘ [` or `Ctrl Tab` / `Ctrl Shift Tab` | Next / previous tab |
| `⌘ O` | Import |
| `⌘ ,` | Settings |
| `⌘ ⌥ C` | Toggle console |
| `⌘ \` | Toggle sidebar |
| `⌘ F` (in an editor) | Find / replace |
| `Enter` in URL bar | Send request |
| Middle-click a tab | Close it |
| Double-click a sidebar item | Rename |

---

## Command-line runner

Run collections headlessly, for example in CI. The runner uses the same engine and `pm.*` scripting as the app.

```bash
npm run build:cli
```

```bash
node dist-cli/localpost.mjs run my-collection.json -e staging.postman_environment.json -r cli,junit
```

- Accepts a Postman collection, a Localpost backup, an OpenAPI / HAR / Insomnia / Hoppscotch file, or a linked-collection folder.
- Useful options:
  - `-d data.csv` and `-n 3` for data files and iterations
  - `--folder "Users"` to run one folder
  - `--env-var key=value` to set a variable
  - `--bail` to stop at the first failure
  - `-k` to skip SSL verification
- Reporters: `-r cli,json,junit,html`. Choose output paths with `--reporter-junit-export report.xml` (and the matching json/html flags).
- Exit code: `0` when every test passed, `1` when a test failed or a request errored, `2` for usage errors.
- `npm link` puts a `localpost` command on your PATH. Run `localpost --help` for the full list of options.

---

## Troubleshooting

**`failed to download` / timeouts while building** — you are probably behind a proxy; see the proxy
note in [Building from source](#2-optional-pre-fetch-rust-crates).

**macOS: DMG step fails with `AppleEvent timed out` / `Failed running AppleScript`** — the DMG
bundler scripts Finder to lay out the installer window, which needs *Automation* permission for your
terminal (System Settings → Privacy & Security → Automation). Grant it, or skip the cosmetic
layout step with `CI=true npm run tauri build`. The `.app` bundle is unaffected.

**Linux: `webkit2gtk-4.1` not found** — install the Linux prerequisites above (Ubuntu 22.04+ /
Debian 12+ ship webkit2gtk-4.1).

**macOS: “Localpost is damaged and can't be opened”** — the app is unsigned and quarantined; run
`xattr -dr com.apple.quarantine /Applications/Localpost.app`.

**Self-signed / internal TLS certificates fail** — turn off *SSL certificate verification* globally
(Settings → Requests) or per request (request → Settings tab).

**Requests should go through a corporate proxy** — Settings → Proxy: either rely on the system
proxy environment variables or set a custom `http://`, `https://`, `socks5://` or `socks5h://` proxy.

**Port 1420 already in use** during `tauri dev` — another dev server is running; stop it or change
the port in both `vite.config.ts` and `src-tauri/tauri.conf.json` (`build.devUrl`).

---

## Project layout

```
.
├── index.html                # Webview entry
├── src/                      # Frontend (React + TypeScript)
│   ├── main.tsx              # Bootstraps the store, mounts <App/>
│   ├── App.tsx               # Shell: header, sidebar, tabs, console, status bar, shortcuts
│   ├── store.ts              # Zustand store: state, actions, persistence, request sending
│   ├── types.ts              # Data model
│   ├── styles.css            # All base styles
│   ├── themes/               # Theme registry + one CSS file per theme (postman, spotify)
│   ├── lib/
│   │   ├── api.ts            # Typed wrappers around Rust commands
│   │   ├── engine.ts         # Request pipeline (scripts → resolve → send → tests)
│   │   ├── scripting.ts      # pm.* sandbox (Postman-compatible scripting API)
│   │   ├── vars.ts           # Variable scopes, {{resolution}}, dynamic variables
│   │   ├── runner.ts         # Collection runner + CSV/JSON data files
│   │   ├── importexport.ts   # Postman v2.x / cURL / backup import & export, format detection
│   │   ├── importers.ts      # OpenAPI, HAR, Insomnia, Hoppscotch, Bruno
│   │   ├── exporters.ts      # OpenAPI 3.1 and HTML docs export
│   │   ├── linked.ts         # Collection ⇄ git-friendly folder layout
│   │   ├── oauth.ts, authsign.ts  # OAuth 2.0; Digest / SigV4 / Hawk signing
│   │   ├── mock.ts, sse.ts, graphql.ts  # Mock routes, SSE parser, GraphQL introspection
│   │   ├── search.ts         # Command palette ranking, search, find & replace
│   │   ├── reports.ts        # JSON / JUnit / HTML run reports
│   │   ├── tools.ts          # Dev toolbox transforms (JWT, hashes, ids, cron…)
│   │   ├── events.ts         # Rust → UI event subscription
│   │   ├── codegen.ts        # Code snippet generators
│   │   ├── cm.ts             # CodeMirror theme, variable highlighting/completion
│   │   ├── utils.ts          # Tree helpers, URL/params sync, formatting
│   │   └── devShim.ts        # Browser-only dev fallback (not shipped)
│   └── components/           # UI components (tools/ = Dev toolbox)
├── cli/                      # Command-line runner (Node): localpost.ts + undici transport
├── src-tauri/                # Backend (Rust)
│   ├── src/lib.rs            # App setup, state, command registration
│   ├── src/http.rs           # Native HTTP engine (reqwest), streaming, client certificates
│   ├── src/storage.rs        # JSON file storage, cookie jar, user themes, folder reads
│   ├── src/servers.rs        # Mock servers + webhook catchers (axum)
│   ├── src/ws.rs             # WebSocket client
│   ├── src/oauth.rs          # OAuth loopback redirect listener
│   ├── src/secrets.rs        # OS keychain storage for secret variables
│   ├── src/workspaces.rs     # Workspace registry + switching
│   ├── src/linked.rs         # Linked-folder writes + file watching
│   ├── src/load.rs           # Load test generator
│   ├── tauri.conf.json       # Window, bundle and security (CSP) config
│   └── capabilities/         # Tauri permission set for the webview
├── tests/                    # logic.test.ts (headless unit tests), cli.test.ts (CLI end-to-end)
├── ARCHITECTURE.md
└── FEATURES.md
```

## License

MIT — do whatever you like with it.
