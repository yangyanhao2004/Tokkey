# Tokie

Desktop application built with [Electron](https://www.electronjs.org/).

## Requirements

- Node.js 20+
- npm 10+

## Getting started

```bash
npm install   # install dependencies
npm start     # run the app
npm run dev   # run with DevTools open
```

## Project structure

```
src/
├── main/                 # main process (Node side)
│   ├── main.js           # entry point, boots TokieApp
│   ├── TokieApp.js       # app lifecycle + main window
│   ├── IpcController.js  # all IPC handlers exposed to the renderer
│   └── preload.js        # context bridge, exposes window.tokie
└── renderer/             # renderer process (UI side)
    ├── index.html        # entry page
    ├── RendererApp.js    # UI logic
    └── styles.css        # styles
```

## Adding a renderer API

1. Add the handler to `IpcController.handlers` in `src/main/IpcController.js`.
2. Expose it on `window.tokie` in `src/main/preload.js`.

Context isolation is on and node integration is off, so the renderer can only
reach the main process through the channels listed in those two files.

## Packaging

No packager is wired up yet. Add [electron-builder](https://www.electron.build/)
or [Electron Forge](https://www.electronforge.io/) when you need distributables.
