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
```

`npm start` and `npm run dev` build the app automatically. TypeScript source is
compiled from `src/` into `dist/`, which is the directory Electron runs.

## Project structure

```
src/
├── main/                 # main process (Node side)
│   ├── main.ts           # entry point, boots TokiieApp
│   ├── TokiieApp.ts      # app lifecycle + main window
│   ├── IpcController.ts  # all IPC handlers exposed to the renderer
│   └── preload.ts        # context bridge, exposes window.tokiie
├── renderer/             # renderer process (UI side)
    ├── index.html        # entry page
    ├── RendererApp.ts    # UI logic
    ├── window.d.ts        # type declaration for the preload bridge
    └── styles.css        # styles
└── shared/               # contracts shared by both processes
    └── types.ts          # IPC data and bridge contracts
```

## Adding a renderer API

1. Add the handler to `IpcController.handlers` in `src/main/IpcController.ts`.
2. Expose it on `window.tokiie` in `src/main/preload.ts`.

Context isolation is on and node integration is off, so the renderer can only
reach the main process through the channels listed in those two files.

## Packaging

No packager is wired up yet. Add [electron-builder](https://www.electron.build/)
or [Electron Forge](https://www.electronforge.io/) when you need distributables.
