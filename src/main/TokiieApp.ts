import path from 'node:path';
import { app, BrowserWindow, shell } from 'electron';
import IpcController from './IpcController';
import GatewayProcessManager from './gateway/GatewayProcessManager';
import CloudModelConnector from './models/CloudModelConnector';
import CodexNativeModelRegistrar from './models/CodexNativeModelRegistrar';
import ClaudeNativeModelRegistrar from './models/ClaudeNativeModelRegistrar';
import CodexGatewayIntegration from './codex/CodexGatewayIntegration';
import ClaudeGatewayIntegration from './claude/ClaudeGatewayIntegration';
import RouterProcessManager from './router/RouterProcessManager';
import RendererEvidenceCapture from './evidence/RendererEvidenceCapture';
import LocalChatTurnExecutor from './chat/LocalChatTurnExecutor';
import LocalModelManager from './models/LocalModelManager';
import HubModelConnector from './models/HubModelConnector';
import TokenHubRuntime from './models/tokenhub/TokenHubRuntime';
import TokenHubRuntimeLocator from './models/tokenhub/TokenHubRuntimeLocator';

interface TokiieAppOptions {
  width?: number;
  height?: number;
  outputDirectory?: string;
  evidenceMode?: boolean;
}

/**
 * Owns the Electron application lifecycle and the main browser window.
 * All main-process wiring goes through this class so the entry point stays trivial.
 */
export class TokiieApp {
  private readonly width: number;
  private readonly height: number;
  private readonly ipcController: IpcController;
  private readonly gatewayProcessManager: GatewayProcessManager;
  private readonly localModelManager: LocalModelManager;
  private readonly localChatTurnExecutor: LocalChatTurnExecutor;
  private readonly cloudModelConnector: CloudModelConnector;
  private readonly codexNativeModelRegistrar: CodexNativeModelRegistrar;
  private readonly claudeNativeModelRegistrar: ClaudeNativeModelRegistrar;
  private readonly codexGatewayIntegration: CodexGatewayIntegration;
  private readonly claudeGatewayIntegration: ClaudeGatewayIntegration;
  private readonly tokenHubRuntime: TokenHubRuntime;
  private readonly routerProcessManager: RouterProcessManager;
  private readonly isDev: boolean;
  private readonly evidenceMode: boolean;
  private readonly evidenceCapture: RendererEvidenceCapture | null;
  private mainWindow: BrowserWindow | null;

  /**
   * @param options initial window dimensions
   */
  constructor(options: TokiieAppOptions = {}) {
    // Defaults match the Figma frame "Tokiie" (192:2413) so a plain launch
    // reproduces the design's content size.
    this.width = options.width ?? 900;
    this.height = options.height ?? 690;
    this.evidenceMode = options.evidenceMode ?? false;
    this.evidenceCapture = this.evidenceMode
      ? new RendererEvidenceCapture(options.outputDirectory ?? '.artifacts/renderer', this.width, this.height)
      : null;
    // The single main window; null whenever no window is open (normal on macOS).
    this.mainWindow = null;
    // The local inference gateway subprocess; started after the window so a slow
    // Python boot never delays first paint. It is built first because the IPC
    // layer routes cloud model connections through it.
    this.gatewayProcessManager = new GatewayProcessManager({
      resourcesPath: app.isPackaged ? process.resourcesPath : undefined
    });
    this.cloudModelConnector = CloudModelConnector.forGateway(this.gatewayProcessManager);
    this.codexNativeModelRegistrar = CodexNativeModelRegistrar.forGateway(this.gatewayProcessManager);
    this.claudeNativeModelRegistrar = ClaudeNativeModelRegistrar.forGateway(this.gatewayProcessManager);
    this.codexGatewayIntegration = new CodexGatewayIntegration({
      gateway: this.gatewayProcessManager
    });
    this.claudeGatewayIntegration = new ClaudeGatewayIntegration({
      gateway: this.gatewayProcessManager
    });
    this.tokenHubRuntime = new TokenHubRuntime({
      runtimeLocator: new TokenHubRuntimeLocator({
        resourcesPath: app.isPackaged ? process.resourcesPath : undefined,
        appPath: app.getAppPath()
      }),
      profileConnector: HubModelConnector.forGateway(this.gatewayProcessManager)
    });
    this.localModelManager = new LocalModelManager({
      localRuntime: this.tokenHubRuntime
    });
    this.localChatTurnExecutor = new LocalChatTurnExecutor({
      runtime: this.tokenHubRuntime
    });
    // The router forwards to the gateway, so it takes the gateway as its endpoint
    // rather than being started here: the Router page's switch owns its lifecycle.
    this.routerProcessManager = new RouterProcessManager({
      gateway: this.gatewayProcessManager,
      resourcesPath: app.isPackaged ? process.resourcesPath : undefined
    });
    // Renderer-facing IPC handlers are registered once, before any window exists.
    this.ipcController = new IpcController({
      cloudModelConnector: this.cloudModelConnector,
      codexGatewayIntegration: this.codexGatewayIntegration,
      claudeGatewayIntegration: this.claudeGatewayIntegration,
      localModelManager: this.localModelManager,
      localChatTurnExecutor: this.localChatTurnExecutor,
      tokenHubRuntime: this.tokenHubRuntime,
      routerProcessManager: this.routerProcessManager
    });
    // `--dev` (npm run dev) opens DevTools and enables development-only behaviour.
    this.isDev = TokiieApp.shouldOpenDevTools(this.evidenceMode, process.argv);
  }

  /** Returns whether this launch explicitly requested the detached DevTools window. */
  static shouldOpenDevTools(evidenceMode: boolean, commandLineArguments: readonly string[]): boolean {
    return !evidenceMode && commandLineArguments.includes('--dev');
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
    app.on('will-quit', () => this.onWillQuit());
  }

  /** Creates the first window once Electron has finished initialising. */
  onReady(): void {
    this.ipcController.attachModelDownloadSession();
    this.tokenHubRuntime.startMonitoring();
    this.createMainWindow();
    if (!this.evidenceMode) {
      // Before anything reads Codex's config.toml or Claude's settings.json: a
      // run that was killed left Tokiie's own configuration in those files, and
      // every reader downstream — the upstream endpoint resolver above all —
      // must see the user's instead.
      this.codexGatewayIntegration.recoverInterruptedSession();
      this.claudeGatewayIntegration.recoverInterruptedSession();
      this.startGateway();
    }
  }

  /**
   * Hands Codex and Claude Code back their own configuration and stops the
   * gateway.
   *
   * All of it is synchronous because Electron does not wait for a promise here,
   * and the restores are the half that must not be skipped: the address they
   * remove stops answering the moment the gateway below it goes down.
   */
  onWillQuit(): void {
    this.ipcController.cancelAccountSignIn();
    this.tokenHubRuntime.shutdownNow();
    this.codexGatewayIntegration.deactivate();
    this.claudeGatewayIntegration.deactivate();
    // The router goes down before the gateway it forwards to, so it never spends
    // its last moments proxying to an address that has already stopped answering.
    this.routerProcessManager.stop('application quit');
    this.gatewayProcessManager.stop('application quit');
  }

  /**
   * Boots the local gateway without blocking window creation, then rebuilds the
   * routes it serves: the cloud models connected in an earlier run, whose
   * profiles are still in the database, the Codex CLI's own models, which are
   * derived fresh from its bundled catalog every launch, and Anthropic's models,
   * which a Claude Code client pointed at this gateway resolves against.
   *
   * The three restores run together because none depends on the others, and a
   * slow `codex` call should not delay a cloud route the user already connected.
   * Once all are in, the Codex CLI is pointed at the finished set.
   *
   * A failure here is reported and left recoverable: everything in the app that
   * does not need model routing keeps working, the gateway can be started again
   * later, and pressing Select on the Router page restores a route on its own.
   */
  startGateway(): void {
    this.gatewayProcessManager
      .startIfNeeded()
      .then(() =>
        Promise.all([
          this.cloudModelConnector.restoreConnected(),
          this.codexNativeModelRegistrar.registerAll(),
          this.claudeNativeModelRegistrar.registerAll()
        ])
      )
      .then(([restored, native, claude]) => {
        if (restored.length > 0) {
          console.info(`[AmisGateway] Restored ${restored.length} cloud model route(s).`);
        }
        if (native.length > 0) {
          console.info(`[AmisGateway] Registered ${native.length} Codex native model route(s).`);
        }
        if (claude.length > 0) {
          console.info(`[AmisGateway] Registered ${claude.length} Claude model route(s).`);
        }
        // Last, and only now: both CLIs are configured from the routes that
        // exist, and taking over config.toml any earlier would hide the user's
        // own upstream from the registrar that just read it. Claude's settings
        // are taken over in the same breath — its routes are in by this point,
        // and the base URL it gets carries the port this launch actually bound.
        return Promise.all([
          this.codexGatewayIntegration.activate(),
          this.claudeGatewayIntegration.activate()
        ]);
      })
      .catch((error: unknown) => {
        console.error('[AmisGateway] Gateway start or model restore failed:', error);
      });
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
      frame: !this.evidenceMode,
      useContentSize: this.evidenceMode,
      minWidth: this.evidenceMode ? 1 : 640,
      minHeight: this.evidenceMode ? 1 : 480,
      // Avoid a white flash: show the window only once the page has painted.
      // This relies on `ready-to-show`, so `paintWhenInitiallyHidden` must stay at
      // its default of true — setting it to false suppresses that event and the
      // window would never be shown.
      show: false,
      backgroundColor: '#f5f6f8',
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        offscreen: this.evidenceMode
      }
    });

    this.mainWindow = mainWindow;
    mainWindow.once('ready-to-show', () => {
      if (this.evidenceCapture) {
        void this.captureEvidence(mainWindow);
        return;
      }
      mainWindow.show();
    });
    mainWindow.on('closed', () => {
      this.ipcController.cancelAccountSignIn();
      this.mainWindow = null;
    });

    this.applyNavigationPolicy(mainWindow);
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

    if (this.isDev) {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }

    return mainWindow;
  }

  /** Captures evidence and terminates so CI cannot hang on an interactive window. */
  async captureEvidence(window: BrowserWindow): Promise<void> {
    if (!this.evidenceCapture) return;
    try {
      const evidence = await this.evidenceCapture.capture(window);
      console.log('[RendererEvidence] Captured:', JSON.stringify(evidence));
      app.exit(0);
    } catch (error) {
      console.error('[RendererEvidence] Capture failed:', error);
      await this.evidenceCapture.recordFailure(error);
      app.exit(1);
    }
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

export default TokiieApp;
