import path from 'node:path';
import { app, BrowserWindow, shell } from 'electron';
import IpcController from './IpcController';

interface TokiieAppOptions {
  width?: number;
  height?: number;
}

/**
 * Owns the Electron application lifecycle and the main browser window.
 * All main-process wiring goes through this class so the entry point stays trivial.
 */
export default class TokiieApp {
  private readonly width: number;
  private readonly height: number;
  private readonly ipcController: IpcController;
  private readonly isDev: boolean;
  private mainWindow: BrowserWindow | null;

  /**
   * @param options initial window dimensions
   */
  constructor(options: TokiieAppOptions = {}) {
    this.width = options.width ?? 1200;
    this.height = options.height ?? 800;
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
  start(): void {
    // A second launch should focus the running window instead of starting a new app.
    if (!app.requestSingleInstanceLock()) {
      app.quit();
      return;
    }

    this.ipcController.register();
    this.bindLifecycleEvents();
  }

  /** Binds all Electron lifecycle events to their handlers. */
  bindLifecycleEvents(): void {
    app.on('second-instance', () => this.focusMainWindow());
    app.whenReady().then(() => this.onReady());
    app.on('activate', () => this.onActivate());
    app.on('window-all-closed', () => this.onWindowAllClosed());
  }

  /** Creates the first window once Electron has finished initialising. */
  onReady(): void {
    this.createMainWindow();
  }

  /** On macOS, clicking the dock icon re-opens a window when none is left. */
  onActivate(): void {
    if (BrowserWindow.getAllWindows().length === 0) {
      this.createMainWindow();
    }
  }

  /** On Windows/Linux the app exits with its last window; macOS keeps running. */
  onWindowAllClosed(): void {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  }

  /**
   * Creates the main window with a hardened renderer (context isolation on,
   * node integration off) and loads the renderer entry page.
   * @returns The newly created main window.
   */
  createMainWindow(): BrowserWindow {
    const mainWindow = new BrowserWindow({
      width: this.width,
      height: this.height,
      minWidth: 640,
      minHeight: 480,
      // Avoid a white flash: show the window only once the page has painted.
      show: false,
      backgroundColor: '#f5f6f8',
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    this.mainWindow = mainWindow;
    mainWindow.once('ready-to-show', () => mainWindow.show());
    mainWindow.on('closed', () => {
      this.mainWindow = null;
    });

    this.applyNavigationPolicy(mainWindow);
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

    if (this.isDev) {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }

    return mainWindow;
  }

  /**
   * Keeps the renderer inside the bundled app: external links open in the
   * system browser and in-app navigation away from local files is blocked.
   * @param window browser window whose navigation should be restricted
   */
  applyNavigationPolicy(window: BrowserWindow): void {
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
  focusMainWindow(): void {
    if (!this.mainWindow) {
      return;
    }
    if (this.mainWindow.isMinimized()) {
      this.mainWindow.restore();
    }
    this.mainWindow.focus();
  }
}
