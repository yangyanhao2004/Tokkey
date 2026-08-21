'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The only bridge between renderer and main process. It exposes a small,
 * explicit API on `window.tokie` instead of handing the renderer ipcRenderer,
 * which keeps context isolation meaningful.
 */
class PreloadBridge {
  /** Exposes the API object on the isolated renderer window. */
  expose() {
    contextBridge.exposeInMainWorld('tokie', {
      getAppInfo: () => ipcRenderer.invoke('app:get-info')
    });
  }
}

new PreloadBridge().expose();
