'use strict';

const { app, ipcMain } = require('electron');

/**
 * Central place for every main-process IPC handler exposed to the renderer.
 * Channel names live here and in preload.js only, so the surface stays auditable.
 */
class IpcController {
  constructor() {
    // Channel name -> handler function. Add new renderer-callable APIs here.
    this.handlers = {
      'app:get-info': () => this.getAppInfo()
    };
  }

  /** Registers every handler on ipcMain. Call once, before any window opens. */
  register() {
    Object.entries(this.handlers).forEach(([channel, handler]) => {
      ipcMain.handle(channel, (event, ...args) => handler(...args));
    });
  }

  /**
   * Runtime information about the app and its platform, used by the renderer.
   * @returns {{name: string, version: string, electron: string, chrome: string, node: string, platform: string}}
   */
  getAppInfo() {
    return {
      name: app.getName(),
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform
    };
  }
}

module.exports = IpcController;
