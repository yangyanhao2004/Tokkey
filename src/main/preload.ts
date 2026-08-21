import { contextBridge, ipcRenderer } from 'electron';
import type { TokieApi } from '../shared/types';

/**
 * The only bridge between renderer and main process. It exposes a small,
 * explicit API on `window.tokie` instead of handing the renderer ipcRenderer,
 * which keeps context isolation meaningful.
 */
class PreloadBridge {
  /** Exposes the API object on the isolated renderer window. */
  expose(): void {
    const api: TokieApi = {
      getAppInfo: () => ipcRenderer.invoke('app:get-info')
    };
    contextBridge.exposeInMainWorld('tokie', api);
  }
}

new PreloadBridge().expose();
