'use strict';

const path = require('node:path');
const { app, BrowserWindow, shell } = require('electron');
const IpcController = require('./IpcController');

/**
 * Owns the Electron application lifecycle and the main browser window.
 * All main-process wiring goes through this class so the entry point stays trivial.
 */
class TokieApp {
  /**
   * @param {object} options
   * @param {number} [options.width]  initial window width in pixels
   * @param {number} [options.height] initial window height in pixels
   */
  constructor(options = {}) {
    this.width = options.width || 1200;
    this.height = options.height || 800;
    // The single main window; null whenever no window is open (normal on macOS).
    this.mainWindow = null;
    // Renderer-facing IPC handlers are registered once, before any window exists.
    this.ipcController = new IpcController();
    // `--dev` (npm run dev) opens DevTools and enables development-only behaviour.
    this.isDev = process.argv.includes('--dev') || !app.isPackaged;
  }

  /**
   * Boots the application: enforces a single instance, registers IPC handlers
   * and binds every lifecycle event the app cares about.
   */
  start() {
    // A second launch should focus the running window instead of starting a new app.
    if (!app.requestSingleInstanceLock()) {
      app.quit();
      return;
    }

    this.ipcController.register();
    this.bindLifecycleEvents();
  }

  /** Binds all Electron lifecycle events to their handlers. */
  bindLifecycleEvents() {
    app.on('second-instance', () => this.focusMainWindow());
    app.whenReady().then(() => this.onReady());
    app.on('activate', () => this.onActivate());
    app.on('window-all-closed', () => this.onWindowAllClosed());
  }

  /** Creates the first window once Electron has finished initialising. */
  onReady() {
    this.createMainWindow();
  }

  /** On macOS, clicking the dock icon re-opens a window when none is left. */
  onActivate() {
    if (BrowserWindow.getAllWindows().length === 0) {
      this.createMainWindow();
    }
  }

  /** On Windows/Linux the app exits with its last window; macOS keeps running. */
  onWindowAllClosed() {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  }

  /**
   * Creates the main window with a hardened renderer (context isolation on,
   * node integration off) and loads the renderer entry page.
   * @returns {BrowserWindow}
   */
  createMainWindow() {
    this.mainWindow = new BrowserWindow({
      width: this.width,
      height: this.height,
      minWidth: 640,
      minHeight: 480,
      // Avoid a white flash: show the window only once the page has painted.
      show: false,
      backgroundColor: '#1e1e28',
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    this.mainWindow.once('ready-to-show', () => this.mainWindow.show());
    this.mainWindow.on('closed', () => {
      this.mainWindow = null;
    });

    this.applyNavigationPolicy(this.mainWindow);
    this.mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

    if (this.isDev) {
      this.mainWindow.webContents.openDevTools({ mode: 'detach' });
    }

    return this.mainWindow;
  }

  /**
   * Keeps the renderer inside the bundled app: external links open in the
   * system browser and in-app navigation away from local files is blocked.
   * @param {BrowserWindow} window
   */
  applyNavigationPolicy(window) {
    window.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: 'deny' };
    });

    window.webContents.on('will-navigate', (event, url) => {
      if (!url.startsWith('file://')) {
        event.preventDefault();
        shell.openExternal(url);
      }
    });
  }

  /** Restores and focuses the main window, used when a second instance starts. */
  focusMainWindow() {
    if (!this.mainWindow) {
      return;
    }
    if (this.mainWindow.isMinimized()) {
      this.mainWindow.restore();
    }
    this.mainWindow.focus();
  }
}

module.exports = TokieApp;
