import path from 'node:path';
import { app, BrowserWindow, Menu, nativeImage, shell, Tray } from 'electron';
import IpcController from './IpcController';
import GatewayProcessManager from './gateway/GatewayProcessManager';
import CloudModelConnector from './models/CloudModelConnector';
import CodexNativeModelRegistrar from './models/CodexNativeModelRegistrar';
import ClaudeNativeModelRegistrar from './models/ClaudeNativeModelRegistrar';
import CodexGatewayIntegration from './codex/CodexGatewayIntegration';
import CodexNativeCatalogSource from './codex/CodexNativeCatalogSource';
import ClaudeGatewayIntegration from './claude/ClaudeGatewayIntegration';
import RouterProcessManager from './router/RouterProcessManager';
import RouterAgentIntegration from './router/RouterAgentIntegration';
import RouterBinding from './router/RouterBinding';
import RendererEvidenceCapture from './evidence/RendererEvidenceCapture';
import LocalChatTurnExecutor from './chat/LocalChatTurnExecutor';
import LocalModelManager from './models/LocalModelManager';
import HubModelConnector from './models/HubModelConnector';
import LocalModelAgentIntegration from './models/LocalModelAgentIntegration';
import LocalModelBinding from './models/LocalModelBinding';
import TokenHubRuntime from './models/tokenhub/TokenHubRuntime';
import TokenHubRuntimeLocator from './models/tokenhub/TokenHubRuntimeLocator';
import PetRuntimeCoordinator from './pet/PetRuntimeCoordinator';
import { PetPositionStore } from './pet/PetPositionStore';
import type { PetCompanionSignal } from './pet/PetCompanionStatus';
import SystemPreferencesService from './settings/SystemPreferencesService';
import AppUpdateRuntime from './updates/AppUpdateRuntime';

// The controls sit 22px inside the Figma sidebar, which itself starts after
// the renderer's 11px outer inset.
const MAIN_WINDOW_TRAFFIC_LIGHT_POSITION = { x: 33, y: 33 };

interface TokkeyAppOptions {
  width?: number;
  height?: number;
  outputDirectory?: string;
  evidenceMode?: boolean;
}

/**
 * Owns the Electron application lifecycle and the main browser window.
 * All main-process wiring goes through this class so the entry point stays trivial.
 */
export class TokkeyApp {
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
  private readonly routerBinding: RouterBinding;
  private readonly localModelBinding: LocalModelBinding;
  private readonly localModelAgentIntegration: LocalModelAgentIntegration;
  private readonly routerProcessManager: RouterProcessManager;
  private readonly petRuntimeCoordinator: PetRuntimeCoordinator;
  private readonly routerAgentIntegration: RouterAgentIntegration;
  private readonly systemPreferencesService: SystemPreferencesService;
  private readonly isDev: boolean;
  private readonly evidenceMode: boolean;
  private readonly evidenceCapture: RendererEvidenceCapture | null;
  private mainWindow: BrowserWindow | null;
  private tray: Tray | null = null;
  /** True once the borrowed config files have been handed back this session. */
  private configsReleased = false;

  /**
   * @param options initial window dimensions
   */
  constructor(options: TokkeyAppOptions = {}) {
    // Defaults match the Figma frame "Tokkey" (192:2413) so a plain launch
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
    // One decision about where Codex's models come from — the user's own
    // catalog, or the CLI's bundled one — shared by the two things that act on
    // it: the registrar that routes them and the integration that lists them.
    const codexCatalogSource = new CodexNativeCatalogSource();
    this.codexNativeModelRegistrar = CodexNativeModelRegistrar.forGateway(
      this.gatewayProcessManager,
      { source: codexCatalogSource }
    );
    this.claudeNativeModelRegistrar = ClaudeNativeModelRegistrar.forGateway(this.gatewayProcessManager);
    // Read by both CLI integrations on every write, and by nothing else: it is
    // the single answer to "is the router on", so the two can never disagree
    // about which endpoint and which model they are configuring.
    this.routerBinding = new RouterBinding();
    // The same single-fact role the router's binding plays, for the other thing
    // both CLIs have to be told about: whether a local model is being served.
    this.localModelBinding = new LocalModelBinding();
    this.codexGatewayIntegration = new CodexGatewayIntegration({
      gateway: this.gatewayProcessManager,
      routerBinding: this.routerBinding,
      localBinding: this.localModelBinding,
      source: codexCatalogSource
    });
    this.claudeGatewayIntegration = new ClaudeGatewayIntegration({
      gateway: this.gatewayProcessManager,
      routerBinding: this.routerBinding,
      localBinding: this.localModelBinding
    });
    // Wraps the connector rather than sitting beside it: the runtime already
    // calls its profile connector at exactly the moment the route becomes real,
    // which is the moment both pickers may be told the model exists.
    this.localModelAgentIntegration = new LocalModelAgentIntegration({
      connector: HubModelConnector.forGateway(this.gatewayProcessManager),
      binding: this.localModelBinding,
      codex: this.codexGatewayIntegration,
      claude: this.claudeGatewayIntegration
    });
    this.tokenHubRuntime = new TokenHubRuntime({
      runtimeLocator: new TokenHubRuntimeLocator({
        resourcesPath: app.isPackaged ? process.resourcesPath : undefined,
        appPath: app.getAppPath()
      }),
      profileConnector: this.localModelAgentIntegration
    });
    // Subscribed only now, because the integration and the runtime each need the
    // other: the wrapping goes in above, the watch for the model going away here.
    this.localModelAgentIntegration.observe(this.tokenHubRuntime);
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
    this.petRuntimeCoordinator = new PetRuntimeCoordinator({
      onOpenChat: () => this.presentChatFromPet(),
      onContextMenu: (window) => this.showPetMenu(window),
      positionStore: new PetPositionStore(
        () => path.join(app.getPath('userData'), 'pet-position.json')
      )
    });
    // Everything the switch has to do beyond starting a process: pick the cloud
    // tier, set the binding, and rewrite both CLIs from it.
    this.routerAgentIntegration = new RouterAgentIntegration({
      router: this.routerProcessManager,
      binding: this.routerBinding,
      cloudModels: this.cloudModelConnector,
      codex: this.codexGatewayIntegration,
      claude: this.claudeGatewayIntegration,
      gateway: this.gatewayProcessManager
    });
    this.gatewayProcessManager.subscribe((state) => {
      this.signalPetCompanion({ source: 'gateway', phase: state.phase });
    });
    this.routerAgentIntegration.subscribe((state) => {
      this.signalPetCompanion({ source: 'router', phase: state.phase });
    });
    this.tokenHubRuntime.subscribe((state) => {
      this.signalPetCompanion({ source: 'model', phase: state.phase });
    });
    // Built here rather than left to the IPC controller because its
    // session-scoped effect — the power blocker — is owned by the app
    // lifecycle below: applied on ready, released on quit.
    const appUpdateService = AppUpdateRuntime.create();
    this.systemPreferencesService = new SystemPreferencesService({
      clientVersion: () => appUpdateService.getState()
    });
    // Renderer-facing IPC handlers are registered once, before any window exists.
    this.ipcController = new IpcController({
      cloudModelConnector: this.cloudModelConnector,
      codexGatewayIntegration: this.codexGatewayIntegration,
      claudeGatewayIntegration: this.claudeGatewayIntegration,
      localModelManager: this.localModelManager,
      localChatTurnExecutor: this.localChatTurnExecutor,
      tokenHubRuntime: this.tokenHubRuntime,
      routerAgentIntegration: this.routerAgentIntegration,
      petRuntimeCoordinator: this.petRuntimeCoordinator,
      systemPreferencesService: this.systemPreferencesService,
      appUpdateService
    });
    // `--dev` (npm run dev) opens DevTools and enables development-only behaviour.
    this.isDev = TokkeyApp.shouldOpenDevTools(this.evidenceMode, process.argv);
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
    this.bindCrashHandler();
  }

  /**
   * Hands the borrowed config files back when the main process throws its way
   * out, which is the one exit `will-quit` does not cover.
   *
   * There is deliberately no signal handler beside it. `process.on('SIGINT')`
   * and its siblings never fire in an Electron main process: Chromium installs
   * its own POSIX handlers before libuv can watch for anything, and turns a
   * signal into an ordinary `before-quit`/`will-quit` shutdown instead. So a
   * signal already reaches `onWillQuit` — as long as only one arrives. A second
   * one during that shutdown kills the process outright, which is what
   * `scripts/electron-dev.js` exists to prevent, and why it does that out in the
   * launcher rather than with a handler here that would never run.
   *
   * None of this makes the restore something to rely on. `SIGKILL`, a native
   * crash and a power cut stay unobservable by construction, which is why
   * `OwnedConfigFile` recovers an interrupted session on the next launch.
   */
  private bindCrashHandler(): void {
    process.on('uncaughtException', (error: unknown) => {
      console.error('[Tokkey] Uncaught exception in the main process:', error);
      this.releaseBorrowedConfigs();
      this.tokenHubRuntime.shutdownNow();
      // `app.exit` rather than `app.quit`: the process is in an unknown state,
      // and a graceful quit could stall on the very thing that just threw.
      app.exit(1);
    });
  }

  /**
   * Returns Codex's and Claude's own configuration to them, once per session.
   *
   * Guarded because more than one exit can reach it — `will-quit` on the way
   * out, or the crash handler before it — and because the second call would
   * find the file already restored and no takeover in force.
   */
  private releaseBorrowedConfigs(): void {
    if (this.configsReleased) {
      return;
    }
    this.configsReleased = true;
    this.codexGatewayIntegration.deactivate();
    this.claudeGatewayIntegration.deactivate();
  }

  /** Creates the first window once Electron has finished initialising. */
  onReady(): void {
    this.ipcController.attachModelDownloadSession();
    // The sleep blocker is process state, so the stored preferences have to be
    // re-applied to every session. Only now: the Electron module behind it
    // needs the app to be ready.
    this.systemPreferencesService.restore();
    this.tokenHubRuntime.startMonitoring();
    this.createTray();
    this.createMainWindow();
    if (!this.evidenceMode) {
      void this.startPetRuntime();
      // Before anything reads Codex's config.toml or Claude's settings.json: a
      // run that was killed left Tokkey's own configuration in those files, and
      // every reader downstream — the upstream endpoint resolver above all —
      // must see the user's instead.
      this.codexGatewayIntegration.recoverInterruptedSession();
      // Kept while the Claude takeover is disabled: an earlier run may still
      // have left Tokkey's settings in ~/.claude/settings.json, and this is what
      // hands the user's own file back.
      this.claudeGatewayIntegration.recoverInterruptedSession();
      this.startGateway();
    }
  }

  /** Applies persisted Pet settings after Electron is ready to create windows. */
  private async startPetRuntime(): Promise<void> {
    try {
      await this.petRuntimeCoordinator.applySettings(await this.ipcController.getPetSettings());
    } catch (error) {
      console.error('[Pet] Could not restore Pet runtime:', error);
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
    // First, and before anything that could throw: this is the only irreversible
    // half of the shutdown, and the user's own files stay borrowed if a failure
    // above it skips the call.
    this.releaseBorrowedConfigs();
    this.ipcController.cancelAccountSignIn();
    this.tokenHubRuntime.shutdownNow();
    this.petRuntimeCoordinator.stop('application quit');
    this.tray?.destroy();
    this.tray = null;
    // The router goes down before the gateway it forwards to, so it never spends
    // its last moments proxying to an address that has already stopped answering.
    // Releases the power blocker, so quitting always hands sleep back to macOS.
    this.systemPreferencesService.dispose();
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
        // Last, and only now: the CLI is configured from the routes that exist,
        // and taking over config.toml any earlier would hide the user's own
        // upstream from the registrar that just read it.
        //
        // TEMPORARILY DISABLED: the Claude takeover of ~/.claude/settings.json
        // is switched off, so Claude Code keeps whatever the user configured.
        // Nothing else needs changing — with no takeover in force, deactivate()
        // and syncSettings() are both no-ops.
        return Promise.all([
          this.codexGatewayIntegration.activate(),
          this.claudeGatewayIntegration.activate()
        ]);
        // return this.codexGatewayIntegration.activate();
      })
      .catch((error: unknown) => {
        console.error('[AmisGateway] Gateway start or model restore failed:', error);
      });
  }

  /** On macOS, clicking the dock icon re-opens a window when none is left. */
  onActivate(): void {
    // The floating Pet window can remain alive after the main window closes, so
    // checking only the global window count would leave the Dock click inert.
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      this.createMainWindow();
    }
  }

  /** Shows the main window and tells its renderer to select the Chat route. */
  private presentChatFromPet(): void {
    this.presentRendererIntentFromPet('pet:open-chat');
  }

  private presentRendererIntentFromPet(channel: 'pet:open-chat' | 'pet:open-settings'): void {
    const mainWindow = this.mainWindow;
    if (!mainWindow || mainWindow.isDestroyed()) {
      const createdWindow = this.createMainWindow();
      createdWindow.webContents.once('did-finish-load', () => {
        if (!createdWindow.isDestroyed()) createdWindow.webContents.send(channel);
      });
      return;
    }

    this.focusMainWindow();
    if (mainWindow.webContents.isLoading()) {
      mainWindow.webContents.once('did-finish-load', () => {
        if (!mainWindow.isDestroyed()) mainWindow.webContents.send(channel);
      });
      return;
    }
    mainWindow.webContents.send(channel);
  }

  /** Pet status is observational and must not alter service lifecycle outcomes. */
  private signalPetCompanion(signal: PetCompanionSignal): void {
    try {
      this.petRuntimeCoordinator.signalCompanion(signal);
    } catch (error) {
      console.error('[Pet] Companion signal failed:', error);
    }
  }

  /** On Windows/Linux the app exits with its last window; macOS keeps running. */
  onWindowAllClosed(): void {
    if (!this.tray && process.platform !== 'darwin') {
      app.quit();
    }
  }

  /** Creates the persistent desktop entry point used when the main window is closed. */
  private createTray(): void {
    if (this.evidenceMode || this.tray) return;
    const iconPath = path.join(__dirname, '../renderer/assets/pet/pet-idle-yawn.png');
    const icon = nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 });
    this.tray = new Tray(icon);
    this.tray.setToolTip('Tokkey');
    this.tray.on('click', () => this.showPetMenu());
    this.tray.on('right-click', () => this.showPetMenu());
  }

  /** Builds the Pet controls from current runtime state every time the menu opens. */
  private showPetMenu(sourceWindow: BrowserWindow | null = null): void {
    const runtimeState = this.petRuntimeCoordinator.getState();
    const petCanPause = runtimeState.phase !== 'hidden' && runtimeState.phase !== 'error';
    const menu = Menu.buildFromTemplate([
      {
        label: 'Open Chat',
        click: () => this.presentChatFromPet()
      },
      {
        label: runtimeState.isPaused ? 'Resume Movement' : 'Pause Movement',
        enabled: petCanPause,
        click: () => {
          this.petRuntimeCoordinator.setPaused(!runtimeState.isPaused);
        }
      },
      { type: 'separator' },
      {
        label: 'Pet Settings',
        click: () => this.presentPetSettings()
      },
      { type: 'separator' },
      {
        label: 'Quit Tokkey',
        click: () => app.quit()
      }
    ]);
    menu.popup({ window: sourceWindow ?? undefined });
  }

  /** Shows the Pet settings route without coupling the Pet renderer to navigation. */
  private presentPetSettings(): void {
    this.presentRendererIntentFromPet('pet:open-settings');
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
      trafficLightPosition: process.platform === 'darwin'
        ? MAIN_WINDOW_TRAFFIC_LIGHT_POSITION
        : undefined,
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
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      this.createMainWindow();
      return;
    }
    if (this.mainWindow.isMinimized()) {
      this.mainWindow.restore();
    }
    this.mainWindow.focus();
  }
}

export default TokkeyApp;
