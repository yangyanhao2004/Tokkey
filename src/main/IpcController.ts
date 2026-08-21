import { app, ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { AppInfo } from '../shared/types';

type IpcHandler = (...args: unknown[]) => unknown;

/**
 * Central place for every main-process IPC handler exposed to the renderer.
 * Channel names live here and in preload.ts only, so the surface stays auditable.
 */
export default class IpcController {
  private readonly handlers: Record<string, IpcHandler>;

  constructor() {
    // Channel name -> handler function. Add new renderer-callable APIs here.
    this.handlers = {
      'app:get-info': () => this.getAppInfo()
    };
  }

  /** Registers every handler on ipcMain. Call once, before any window opens. */
  register(): void {
    Object.entries(this.handlers).forEach(([channel, handler]) => {
      ipcMain.handle(channel, (_event: IpcMainInvokeEvent, ...args: unknown[]) => handler(...args));
    });
  }

  /**
   * Runtime information about the app and its platform, used by the renderer.
   * @returns Runtime information about the current Electron process.
   */
  getAppInfo(): AppInfo {
    return {
      name: app.getName(),
      version: app.getVersion(),
      electron: process.versions.electron ?? 'unknown',
      chrome: process.versions.chrome ?? 'unknown',
      node: process.versions.node,
      platform: process.platform
    };
  }
}
