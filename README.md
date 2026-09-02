# Tokkey

Desktop application built with [Electron](https://www.electronjs.org/).

## Requirements

- Node.js 20+
- npm 10+

## Getting started

```bash
npm install   # install dependencies
npm run build # compile TypeScript and copy renderer assets
npm start     # run the app
npm run dev   # run with DevTools open
npm run evidence -- --width 1200 --height 800 --output .artifacts/renderer
```

`npm start` and `npm run dev` build the app automatically. TypeScript source is
compiled from `src/` into `dist/`, which is the directory Electron runs.

`npm run evidence` builds a hidden, deterministic renderer window at the
specified Figma content size, captures `renderer.png`, and retains
`renderer-evidence.json` plus `manifest.json` with viewport and semantic element
geometry. Failed captures retain `manifest.json` and `error.txt`. The PNG is
diagnostic evidence; it is not an automatic Figma pixel-diff assertion.

## Project structure

```
src/
├── main/                 # main process (Node side)
│   ├── main.ts           # entry point, boots TokkeyApp
│   ├── TokkeyApp.ts      # app lifecycle + main window
│   ├── IpcController.ts  # all IPC handlers exposed to the renderer
│   ├── preload.ts        # context bridge, exposes window.tokkey
│   ├── gateway/          # local inference gateway subprocess supervisor
│   ├── mcp/              # MCP catalog scanning and configuration
│   ├── mcpnskills/       # skill discovery, install, and deployment
│   └── models/           # local model catalog and download lifecycle
├── renderer/             # renderer process (UI side)
│   ├── index.html        # entry page — currently an empty shell
│   └── window.d.ts       # type declaration for the preload bridge
└── shared/               # contracts shared by both processes
    └── types.ts          # IPC data and bridge contracts
```

> The renderer has no UI right now. `index.html` is an empty shell so the app
> still opens a window; every main-process capability below is still registered
> and reachable over IPC, waiting for a new front end. When you add one, restore
> the stylesheet copy step in the `build` script.

## Local inference gateway

The app runs a loopback-only HTTP gateway as a Python subprocess. It is backed
by the LiteLLM **SDK** (not the LiteLLM proxy CLI) and exposes chat completions,
Responses, and Anthropic Messages over `127.0.0.1`, plus a small management API
for model routes. It was migrated from the Amis-Wifi repository; the OpenSquilla
router difficulty classifier was dropped in the process, which removed
scikit-learn, onnxruntime, lightgbm, scipy, and numpy from the runtime.

```
runtime/amis-gateway/       # Python package, pyproject.toml, uv.lock, tests
src/main/gateway/            # main-process supervisor
├── GatewayProcessManager.ts # spawn, readiness, crash restart, shutdown
├── GatewayRuntimeLocator.ts # finds the frozen executable to run
├── GatewayPortResolver.ts   # picks the port, reclaims it from stale helpers
└── GatewayHealthProbe.ts    # verifies a listener belongs to this app launch
```

### Development setup

```bash
brew install uv                # or https://docs.astral.sh/uv/
npm run gateway:sync           # create runtime/amis-gateway/.venv
npm run gateway:test           # run the Python test suite
```

The virtualenv is for editing and testing the Python source; the app never runs
it. `npm run dev`, `start`, and `evidence` each re-run `gateway:freeze` first,
so a change under `runtime/amis-gateway/src` reaches the app on the next launch
without a separate command. `AMIS_GATEWAY_EXECUTABLE=/path/to/amis-gateway`
overrides the bundle for one run.

`npm test` deliberately does *not* freeze: the gateway tests drive the
supervisor against fakes, so making the JavaScript suite depend on uv and
PyInstaller would buy nothing.

### How the supervisor behaves

- The gateway starts after the main window, so its boot never delays first
  paint, and a startup failure leaves the rest of the app usable.
- The gateway itself is unauthenticated: it listens on loopback only, so a key
  checked at its door would guard nothing the operating system does not already
  guard. Credentials are a per-model concern instead — a local model server is
  called with none, a route with a stored key uses that key, and a route without
  one forwards whatever the calling agent sent.
- Each launch generates an instance id. A listener is adopted
  only if `/health/liveness` reports that same instance id and a matching
  `runtime_protocol_version`, so an orphan from a previous launch is never
  mistaken for the current gateway.
- Port 4033 is preferred. An orphan left by a previous launch of *this* app is
  terminated and the port reclaimed; a port held by any other process is left
  alone and a free port is used instead. Ownership is matched on the executable
  path, because the Amis-Wifi desktop app ships this same gateway and must never
  be killed by this app.
- An unexpected exit is relaunched with exponential backoff, capped at five
  consecutive attempts. Quitting the app stops the gateway.

### The frozen runtime

`npm run gateway:freeze` runs PyInstaller against
`runtime/amis-gateway/packaging/amis-gateway.spec` and writes a self-contained
bundle to `resources/GatewayRuntime/<arch>/amis-gateway/`. The executable there
carries its own CPython and every dependency in a sibling `_internal/`
directory, so no user PATH, Homebrew package, or system Python is involved at
runtime — the supervisor spawns it with nothing but `--host` and `--port`.

A freeze takes ~17s and is not incremental in any useful sense: PyInstaller
re-runs its dependency analysis and rewrites the whole 99MB `COLLECT` tree every
time. `--clean` is left off so the `runtime/amis-gateway/build/` cache is reused,
but that only saves ~2s of the 17 — use `npm run gateway:freeze:clean` after
changing dependencies or the spec, when a stale cache is the likelier suspect.

Rebuilds are not byte-reproducible: `_internal/base_library.zip` (1.3MB) embeds
timestamps and so differs on every run. Because the bundle is committed, every
app launch leaves that one file modified in `git status`. Nothing else in the
tree changes.

PyInstaller cannot cross-compile: the bundle always matches the machine that
built it. The committed tree is arm64 macOS, which is the only target the app
supports today (`TokenHubRuntimeLocator` already refuses anything else). An
Intel or Linux build must be produced on that host and land in its own `<arch>`
folder — `process.arch` names the folder verbatim, so Intel macOS is `x64/`.

## Adding a renderer API

1. Add the handler to `IpcController.handlers` in `src/main/IpcController.ts`.
2. Expose it on `window.tokkey` in `src/main/preload.ts`.

Context isolation is on and node integration is off, so the renderer can only
reach the main process through the channels listed in those two files.

## Packaging

No packager is wired up yet. Add [electron-builder](https://www.electron.build/)
or [Electron Forge](https://www.electronforge.io/) when you need distributables.
