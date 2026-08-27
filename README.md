# Tokiie

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
│   ├── main.ts           # entry point, boots TokiieApp
│   ├── TokiieApp.ts      # app lifecycle + main window
│   ├── IpcController.ts  # all IPC handlers exposed to the renderer
│   ├── preload.ts        # context bridge, exposes window.tokiie
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
├── GatewayRuntimeLocator.ts # finds the interpreter to run
├── GatewayPortResolver.ts   # picks the port, reclaims it from stale helpers
└── GatewayHealthProbe.ts    # verifies a listener belongs to this app launch
```

### Development setup

```bash
brew install uv                # or https://docs.astral.sh/uv/
npm run gateway:sync           # create runtime/amis-gateway/.venv
npm run gateway:test           # run the Python test suite
```

`npm run dev` then starts the gateway automatically against that virtualenv.
`AMIS_GATEWAY_PYTHON=/path/to/python3` overrides the interpreter for one run.

### How the supervisor behaves

- The gateway starts after the main window, so a slow Python boot never delays
  first paint, and a startup failure leaves the rest of the app usable.
- Each launch generates a master key and an instance id. A listener is adopted
  only if `/health/liveness` reports that same instance id and a matching
  `runtime_protocol_version`, so an orphan from a previous launch is never
  mistaken for the current gateway.
- Port 4000 is preferred. An orphan left by a previous launch of *this* app is
  terminated and the port reclaimed; a port held by any other process is left
  alone and a free port is used instead. Ownership is matched on the interpreter
  path, because the Amis-Wifi desktop app runs the same `amis_gateway.main`
  module on the same default port and must never be killed by this app.
- An unexpected exit is relaunched with exponential backoff, capped at five
  consecutive attempts. Quitting the app stops the gateway.

### Packaging (not wired up yet)

Production expects a relocatable CPython tree at
`resources/GatewayRuntime/<arch>/python/bin/python3`. Building and signing that
tree still needs to be ported from Amis-Wifi's `Scripts/build-litellm-runtime.py`
— see the note in `TODO.md`.

## Adding a renderer API

1. Add the handler to `IpcController.handlers` in `src/main/IpcController.ts`.
2. Expose it on `window.tokiie` in `src/main/preload.ts`.

Context isolation is on and node integration is off, so the renderer can only
reach the main process through the channels listed in those two files.

## Packaging

No packager is wired up yet. Add [electron-builder](https://www.electron.build/)
or [Electron Forge](https://www.electronforge.io/) when you need distributables.
