import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import type {
  AgentInstallation,
  AppInfo,
  ApplyMcpConfigurationRequest,
  CachedRepository,
  CachedRepositorySkill,
  CloudModelCard,
  CloudModelConnection,
  FeedbackResult,
  HostSnapshot,
  LocalChatEvent,
  McpConfigurationDraft,
  McpConfigurationPreparation,
  LocalChatRuntimeState,
  LocalChatTurnRequest,
  LocalChatTurnStarted,
  LocalChatWorkspace,
  PetInteraction,
  PetSettings,
  PetSettingsPatch,
  PetRuntimeState,
  SkillsShCardState,
  SkillsShInstallRequest,
  SkillsShInstallResult,
  SkillsShPage,
  SkillsShSkill,
  InstallRepositorySkillRequest,
  InstalledMcp,
  InstalledSkill,
  McpAgent,
  RepositorySyncResult,
  RouterRuntimeState,
  SkillAgent,
  SkillAgentSelection,
  SkillDetails,
  SkillDetailsRequest,
  SkillInstallResult,
  SkillUploadConflictChoice,
  SkillUploadResult,
  SystemPreferencesPatch,
  SystemSettingsState
} from '../shared/types';
import type { McpCatalogScan } from '../shared/types';
import type { InstalledLocalModel, LocalModelCatalogRequest } from '../shared/types';
import { McpConfigurationPreparer } from '../shared/McpConfiguration';
import { LocalSkillCatalogScanner } from './mcpnskills/SkillCatalogScanner';
import { SKILL_AGENT_ORDER, SkillDeployer } from './mcpnskills/SkillDeployer';
import CachedRepositoryCatalog from './mcpnskills/CachedRepositoryCatalog';
import DiscoverRepositories from './mcpnskills/DiscoverRepositories';
import RepositoryCloneCache from './mcpnskills/RepositoryCloneCache';
import RepositorySkillScanner from './mcpnskills/RepositorySkillScanner';
import SkillFolderImporter from './mcpnskills/SkillFolderImporter';
import SkillInstaller from './mcpnskills/SkillInstaller';
import SkillDetailsReader from './mcpnskills/SkillDetailsReader';
import SkillUploadService from './mcpnskills/SkillUploadService';
import DiscoverSkillsService from './mcpnskills/DiscoverSkillsService';
import LocalMcpCatalogScanner, { MCP_AGENT_ORDER } from './mcp/McpCatalogScanner';
import LocalMcpConfigurationApplier, {
  type McpConfigurationApplying
} from './mcp/McpConfigurationApplier';
import AgentManager, { type AgentState } from './agents/AgentManager';
import InstalledAgentGate from './agents/InstalledAgentGate';
import LocalChatTurnExecutor from './chat/LocalChatTurnExecutor';
import ChatSessionStore from './chat/ChatSessionStore';
import {
  validateLocalChatSessionId,
  validateLocalChatTurnId,
  validateLocalChatTurnRequest
} from './chat/LocalChatTurnRequestValidator';
import LocalModelManager from './models/LocalModelManager';
import CloudModelConnector from './models/CloudModelConnector';
import CodexGatewayIntegration from './codex/CodexGatewayIntegration';
import ClaudeGatewayIntegration from './claude/ClaudeGatewayIntegration';
import HostSnapshotService from './host/HostSnapshotService';
import RouterAgentIntegration from './router/RouterAgentIntegration';
import { PetSettingsStore, assertPetSettings, type PetSettingsStoring } from './pet/PetSettingsStore';
import type { PetRuntimeCoordinating } from './pet/PetRuntimeCoordinator';
import type { PetCompanionSignal } from './pet/PetCompanionStatus';
import TokenHubRuntime from './models/tokenhub/TokenHubRuntime';
import AccountRuntime from './account/AccountRuntime';
import SystemPreferencesService from './settings/SystemPreferencesService';
import AppUpdateService from './updates/AppUpdateService';
import AccountService from './account/AccountService';

type IpcHandler = (...args: unknown[]) => unknown;

/** Collaborators the controller builds itself unless a caller supplies one. */
export interface IpcControllerOptions {
  accountService?: AccountService;
  skillCatalogScanner?: LocalSkillCatalogScanner;
  skillDeployer?: SkillDeployer;
  skillDetailsReader?: SkillDetailsReader;
  discoverRepositories?: DiscoverRepositories;
  discoverSkills?: DiscoverSkillsService;
  skillUploadService?: SkillUploadService;
  mcpCatalogScanner?: LocalMcpCatalogScanner;
  mcpConfigurationApplier?: McpConfigurationApplying;
  localModelManager?: LocalModelManager;
  tokenHubRuntime?: TokenHubRuntime;
  localChatTurnExecutor?: LocalChatTurnExecutor;
  chatSessionStore?: ChatSessionStore;
  hostSnapshotService?: HostSnapshotService;
  /** Owns the Settings page's preferences and what each one does to the app. */
  systemPreferencesService?: SystemPreferencesService;
  appUpdateService?: AppUpdateService;
  agentManager?: AgentManager;
  /** Owns the gateway subprocess, so only the app that supervises it can supply this. */
  cloudModelConnector?: CloudModelConnector;
  /** Keeps the Codex CLI's model catalog in step with the gateway's routes. */
  codexGatewayIntegration?: CodexGatewayIntegration;
  /** Keeps Claude Code's model settings in step with the gateway's routes. */
  claudeGatewayIntegration?: ClaudeGatewayIntegration;
  /** Owns the router subprocess the Router page's switch turns on and off. */
  routerAgentIntegration?: RouterAgentIntegration;
  /** Persists Pet settings; injected in tests, user-data-backed in production. */
  petSettingsStore?: PetSettingsStoring;
  /** Runs the independent desktop Pet window when settings enable it. */
  petRuntimeCoordinator?: PetRuntimeCoordinating;
}

/**
 * Central place for every main-process IPC handler exposed to the renderer.
 * Channel names live here and in preload.ts only, so the surface stays auditable.
 */
export default class IpcController {
  /** What the Router page shows when the app was built without a router manager. */
  private static readonly ROUTER_UNAVAILABLE_STATE: RouterRuntimeState = {
    phase: 'error',
    port: null,
    baseUrl: null,
    dashboardUrl: null,
    error: 'The router runtime is not available in this build.'
  };

  private readonly handlers: Record<string, IpcHandler>;
  private readonly skillCatalogScanner: LocalSkillCatalogScanner;
  private readonly skillDeployer: SkillDeployer;
  private readonly skillDetailsReader: SkillDetailsReader;
  private readonly discoverRepositories: DiscoverRepositories;
  private readonly discoverSkills: DiscoverSkillsService;
  private readonly skillUploadService: SkillUploadService;
  private readonly mcpCatalogScanner: LocalMcpCatalogScanner;
  private readonly mcpConfigurationApplier: McpConfigurationApplying;
  private readonly localModelManager: LocalModelManager;
  private readonly tokenHubRuntime: TokenHubRuntime;
  private readonly localChatTurnExecutor: LocalChatTurnExecutor;
  private readonly chatSessionStore: ChatSessionStore;
  private readonly hostSnapshotService: HostSnapshotService;
  private readonly systemPreferencesService: SystemPreferencesService;
  private readonly agentManager: AgentManager;
  private readonly accountService: AccountService;
  private readonly cloudModelConnector: CloudModelConnector | null;
  private readonly codexGatewayIntegration: CodexGatewayIntegration | null;
  private readonly claudeGatewayIntegration: ClaudeGatewayIntegration | null;
  private readonly routerAgentIntegration: RouterAgentIntegration | null;
  private readonly petSettingsStore: PetSettingsStoring;
  private readonly petRuntimeCoordinator: PetRuntimeCoordinating | null;
  private petSettings: PetSettings | null = null;
  private petSettingsRead: Promise<PetSettings> | null = null;
  private petSettingsWriteQueue: Promise<void> = Promise.resolve();
  private readonly mcpConfigurationPreparer = new McpConfigurationPreparer();

  constructor(options: IpcControllerOptions = {}) {
    this.accountService = options.accountService ?? AccountRuntime.create();
    this.agentManager = options.agentManager ?? new AgentManager();
    // One gate for both catalogs, so a departed agent disappears from each the
    // same way and the Agent Hub's greyed chips agree with what was scanned.
    const agentGate = new InstalledAgentGate({ agentManager: this.agentManager });
    const skillCatalogScanner =
      options.skillCatalogScanner ?? new LocalSkillCatalogScanner({ agentGate });
    const skillDeployer =
      options.skillDeployer ?? new SkillDeployer({ scanner: skillCatalogScanner });
    this.skillCatalogScanner = skillCatalogScanner;
    this.skillDeployer = skillDeployer;
    this.skillDetailsReader = options.skillDetailsReader ?? new SkillDetailsReader();
    this.discoverRepositories = options.discoverRepositories ?? this.createDiscoverRepositories();
    this.discoverSkills = options.discoverSkills ?? new DiscoverSkillsService({
      installedCatalog: skillCatalogScanner,
      deployer: skillDeployer
    });
    this.skillUploadService = options.skillUploadService ?? new SkillUploadService({
      installedCatalog: skillCatalogScanner
    });
    this.mcpCatalogScanner = options.mcpCatalogScanner ?? new LocalMcpCatalogScanner({ agentGate });
    this.mcpConfigurationApplier =
      options.mcpConfigurationApplier ?? new LocalMcpConfigurationApplier();
    this.tokenHubRuntime = options.tokenHubRuntime ?? new TokenHubRuntime();
    this.localModelManager = options.localModelManager ?? new LocalModelManager({
      localRuntime: this.tokenHubRuntime
    });
    this.localChatTurnExecutor = options.localChatTurnExecutor ?? new LocalChatTurnExecutor({
      runtime: this.tokenHubRuntime
    });
    this.tokenHubRuntime.subscribe((state) =>
      this.broadcast('models:runtime-state-changed', state)
    );
    this.chatSessionStore = options.chatSessionStore ?? new ChatSessionStore();
    this.hostSnapshotService = options.hostSnapshotService ?? new HostSnapshotService();
    this.systemPreferencesService =
      options.systemPreferencesService ?? new SystemPreferencesService();
    this.cloudModelConnector = options.cloudModelConnector ?? null;
    this.codexGatewayIntegration = options.codexGatewayIntegration ?? null;
    this.claudeGatewayIntegration = options.claudeGatewayIntegration ?? null;
    this.routerAgentIntegration = options.routerAgentIntegration ?? null;
    this.petSettingsStore = options.petSettingsStore ?? new PetSettingsStore(
      () => path.join(app.getPath('userData'), 'pet-settings.json')
    );
    this.petRuntimeCoordinator = options.petRuntimeCoordinator ?? null;
    // The router can also stop on its own — a crash, or a start that timed out —
    // so the switch is driven by these events rather than by the click alone.
    this.routerAgentIntegration?.subscribe((state) =>
      this.broadcast('router:state-changed', state)
    );
    this.petRuntimeCoordinator?.subscribe((state) =>
      this.broadcast('pet:runtime-state-changed', state)
    );
    options.appUpdateService?.subscribe((state) => this.broadcast('updates:state-changed', state));
    // Channel name -> handler function. Add new renderer-callable APIs here.
    this.handlers = {
      'app:get-info': () => this.getAppInfo(),
      'account:get-state': () => this.accountService.getState(),
      'account:request-email-code': (email: unknown) =>
        this.accountService.requestEmailCode(this.requireString(email, 'Email address')),
      'account:verify-email': (email: unknown, code: unknown) =>
        this.accountService.verifyEmail(
          this.requireString(email, 'Email address'),
          this.requireString(code, 'Verification code')
        ),
      'account:sign-in-google': () => this.accountService.signInWithGoogle(),
      'account:cancel-google': () => this.accountService.cancelGoogleSignIn(),
      'account:sign-out': () => this.accountService.signOut(),
      'host:snapshot': () => this.getHostSnapshot(),
      'pet:get-settings': () => this.getPetSettings(),
      'pet:update-settings': (patch: unknown) =>
        this.updatePetSettings(this.requirePetSettingsPatch(patch)),
      'pet:get-runtime-state': () => this.getPetRuntimeState(),
      'pet:set-paused': (isPaused: unknown) => this.setPetPaused(this.requireBoolean(isPaused, 'Pet paused state')),
      'settings:get-state': () => this.getSystemSettings(),
      'updates:check': () => options.appUpdateService?.checkForUpdates() ?? this.getSystemSettings().client,
      'updates:download': () => options.appUpdateService?.downloadUpdate() ?? this.getSystemSettings().client,
      'updates:install': () => options.appUpdateService?.installUpdate() ?? this.getSystemSettings().client,
      'settings:update-preferences': (patch: unknown) =>
        this.updateSystemPreferences(this.requireSystemPreferencesPatch(patch)),
      'settings:send-feedback': (feedback: unknown, email: unknown) =>
        this.sendFeedback(
          this.requireString(feedback, 'Feedback message'),
          this.requireEmail(email)
        ),
      'agents:detect': () => this.detectAgents(),
      'mcps:list-installed': () => this.scanInstalledMcps(),
      'mcps:apply-configuration': (request: unknown) =>
        this.applyMcpConfiguration(this.requireMcpApplyRequest(request)),
      'mcps:apply-agent-selection': (mcpId: unknown, selectedAgents: unknown) =>
        this.applyMcpAgentSelection(
          this.requireString(mcpId, 'MCP ID'),
          this.requireMcpAgents(selectedAgents)
        ),
      'skills:list-installed': () => this.getInstalledSkills(),
      'skills:get-agent-selection': (skillId: unknown) =>
        this.getSkillAgentSelection(this.requireSkillId(skillId)),
      'skills:apply-agent-selection': (skillId: unknown, selectedAgents: unknown) =>
        this.applySkillAgentSelection(
          this.requireSkillId(skillId),
          this.requireSkillAgents(selectedAgents)
        ),
      'skills:uninstall': (skillId: unknown) => this.uninstallSkill(this.requireSkillId(skillId)),
      'skills:get-details': (request: unknown) =>
        this.getSkillDetails(this.requireSkillDetailsRequest(request)),
      'skills:upload-folder': () => this.uploadSkillFolder(),
      'skills:resolve-upload-conflict': (pendingUploadId: unknown, choice: unknown) =>
        this.resolveSkillUploadConflict(
          this.requireString(pendingUploadId, 'Pending upload ID'),
          this.requireUploadConflictChoice(choice)
        ),
      'discover-repos:list-cached': () => this.listCachedRepositories(),
      'discover-repos:add': (input: unknown, branch: unknown) =>
        this.addRepository(this.requireString(input, 'Repository input'), this.requireOptionalString(branch)),
      'discover-repos:install-skill': (request: unknown) =>
        this.installRepositorySkill(this.requireInstallRequest(request)),
      'discover-skills:fetch-page': (page: unknown) =>
        this.fetchSkillsPage(this.requirePage(page)),
      'discover-skills:search': (query: unknown) =>
        this.searchSkills(this.requireString(query, 'skills.sh search query')),
      'discover-skills:search-page': (query: unknown, page: unknown) =>
        this.searchSkillsPage(
          this.requireString(query, 'skills.sh search query'),
          this.requirePage(page)
        ),
      'discover-skills:refresh-installed': () => this.refreshSkillsInstalledStatus(),
      'discover-skills:card-state': (listing: unknown) =>
        this.getSkillCardState(this.requireSkillsShSkill(listing)),
      'discover-skills:card-states': (listings: unknown) =>
        this.getSkillCardStates(this.requireSkillsShSkills(listings)),
      'discover-skills:install': (request: unknown) =>
        this.installSkill(this.requireSkillsShInstallRequest(request)),
      'models:list': (request: unknown) => this.listLocalModels(this.requireModelRequest(request)),
      'models:refresh': (request: unknown) => this.refreshLocalModels(this.requireModelRequest(request)),
      'models:start-download': (modelId: unknown, request: unknown) =>
        this.startLocalModelDownload(this.requireModelId(modelId), this.requireModelRequest(request)),
      'models:cancel-download': (modelId: unknown, request: unknown) =>
        this.cancelLocalModelDownload(this.requireModelId(modelId), this.requireModelRequest(request)),
      'models:delete': (modelId: unknown, request: unknown) =>
        this.deleteLocalModel(this.requireModelId(modelId), this.requireModelRequest(request)),
      'models:deploy': (modelId: unknown, request: unknown) =>
        this.deployLocalModel(this.requireModelId(modelId), this.requireModelRequest(request)),
      'models:list-installed': () => this.listInstalledLocalModels(),
      'models:start-installed': (modelId: unknown) =>
        this.startInstalledLocalModel(this.requireModelId(modelId)),
      'models:remove-installed': (modelId: unknown) =>
        this.removeInstalledLocalModel(this.requireModelId(modelId)),
      'models:runtime-state': () => this.getLocalModelRuntimeState(),
      'models:stop-runtime': () => this.stopLocalModelRuntime(),
      'chat:load-workspace': () => this.loadLocalChatWorkspace(),
      'chat:create-session': () => this.createLocalChatSession(),
      'chat:open-session': (sessionId: unknown) =>
        this.openLocalChatSession(validateLocalChatSessionId(sessionId)),
      'chat:close-session': (sessionId: unknown) =>
        this.closeLocalChatSession(validateLocalChatSessionId(sessionId)),
      'chat:get-runtime-state': () => this.getLocalChatRuntimeState(),
      'models:cloud-cards': () => this.listCloudModelCards(),
      'models:restore-cloud': () => this.restoreCloudModels(),
      'models:connect-cloud': (cardId: unknown) =>
        this.connectCloudModel(this.requireString(cardId, 'Cloud model card ID')),
      'router:get-state': () => this.getRouterRuntimeState(),
      'router:start': () => this.startRouterRuntime(),
      'router:stop': () => this.stopRouterRuntime()
    };
  }

  /** Sends one payload to every live window, for main-process-driven state. */
  private broadcast(channel: string, payload: unknown): void {
    BrowserWindow.getAllWindows().forEach((window) => {
      if (!window.isDestroyed()) window.webContents.send(channel, payload);
    });
  }

  /** The router's current phase, which the Router page's switch draws itself from. */
  private getRouterRuntimeState(): RouterRuntimeState {
    return this.routerAgentIntegration?.currentState() ?? IpcController.ROUTER_UNAVAILABLE_STATE;
  }

  /**
   * Turns the router on, which also moves Codex and Claude Code onto it.
   * Resolves with the failure state rather than throwing.
   */
  private startRouterRuntime(): Promise<RouterRuntimeState> {
    if (!this.routerAgentIntegration) {
      return Promise.resolve(IpcController.ROUTER_UNAVAILABLE_STATE);
    }
    return this.routerAgentIntegration.turnOn();
  }

  /** Turns the router off at the user's request, moving both CLIs back. */
  private stopRouterRuntime(): RouterRuntimeState {
    return this.routerAgentIntegration?.turnOff() ?? IpcController.ROUTER_UNAVAILABLE_STATE;
  }

  /** Reads the shared Pet settings snapshot, caching it for this app run. */
  getPetSettings(): Promise<PetSettings> {
    if (this.petSettings) {
      return Promise.resolve({ ...this.petSettings });
    }
    if (this.petSettingsRead) {
      return this.petSettingsRead.then((settings) => ({ ...settings }));
    }

    this.petSettingsRead = this.petSettingsStore.load().then((settings) => {
      assertPetSettings(settings);
      this.petSettings = { ...settings };
      return settings;
    });
    return this.petSettingsRead
      .then((settings) => ({ ...settings }))
      .finally(() => {
        this.petSettingsRead = null;
      });
  }

  /** Serializes writes so rapid setting changes cannot overwrite one another. */
  updatePetSettings(patch: PetSettingsPatch): Promise<PetSettings> {
    const update = this.petSettingsWriteQueue.then(async () => {
      const current = await this.getPetSettings();
      const next = { ...current, ...patch };
      assertPetSettings(next);
      await this.petSettingsStore.save(next);
      this.petSettings = { ...next };
      await this.petRuntimeCoordinator?.applySettings(next);
      return { ...next };
    });
    this.petSettingsWriteQueue = update.then(() => undefined, () => undefined);
    return update;
  }

  /** Returns the current Pet window lifecycle snapshot to a renderer. */
  getPetRuntimeState(): Promise<PetRuntimeState> {
    return Promise.resolve(
      this.petRuntimeCoordinator?.getState() ?? {
        phase: 'hidden',
        position: null,
        direction: 'right',
        size: 72,
        message: null,
        error: null,
        isPaused: false
      }
    );
  }

  /** Pauses or resumes movement without changing the persisted Pet setting. */
  setPetPaused(isPaused: boolean): Promise<PetRuntimeState> {
    this.petRuntimeCoordinator?.setPaused(isPaused);
    return this.getPetRuntimeState();
  }

  /** Connects native Electron downloads after app.whenReady(). */
  attachModelDownloadSession(): void {
    this.localModelManager.attachDownloadSession();
  }

  /** Closes any temporary OAuth listener when its owning window/app disappears. */
  cancelAccountSignIn(): void {
    this.accountService.cancelGoogleSignIn();
  }

  /** Registers every handler on ipcMain. Call once, before any window opens. */
  register(): void {
    Object.entries(this.handlers).forEach(([channel, handler]) => {
      ipcMain.handle(channel, (_event: IpcMainInvokeEvent, ...args: unknown[]) => handler(...args));
    });
    // Live validation is synchronous and CPU-only so fields can update without UI races.
    ipcMain.on('mcps:prepare-configuration', (event, draft: unknown) => {
      event.returnValue = this.prepareMcpConfiguration(draft as McpConfigurationDraft);
    });
    ipcMain.handle('chat:start-turn', (event: IpcMainInvokeEvent, request: unknown) =>
      this.startLocalChatTurn(event, validateLocalChatTurnRequest(request))
    );
    ipcMain.handle('chat:cancel-turn', (_event: IpcMainInvokeEvent, turnId: unknown) =>
      this.cancelLocalChatTurn(validateLocalChatTurnId(turnId))
    );
    ipcMain.on('pet:interaction', (_event, interaction: unknown) => {
      try {
        this.petRuntimeCoordinator?.interact(this.requirePetInteraction(interaction));
      } catch (error) {
        console.error('[Pet] Rejected interaction:', error);
      }
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

  /**
   * One reading of the "This Mac" card: static machine description plus the
   * live memory and disk gauges. Polled by the Add Model page every few seconds.
   */
  getHostSnapshot(): Promise<HostSnapshot> {
    return this.hostSnapshotService.snapshot();
  }

  /** Everything the Settings page renders: the three preferences and this build's version. */
  getSystemSettings(): SystemSettingsState {
    return this.systemPreferencesService.getState();
  }

  /**
   * Applies one or more changed preferences and reports the settled state, so
   * the page renders what actually took effect rather than what was clicked.
   */
  updateSystemPreferences(patch: SystemPreferencesPatch): SystemSettingsState {
    return this.systemPreferencesService.update(patch);
  }

  /** Posts the typed message and its reply address to the feedback endpoint. */
  sendFeedback(feedback: string, email: string): Promise<FeedbackResult> {
    return this.systemPreferencesService.sendFeedback(feedback, email);
  }

  /**
   * Whether each supported coding agent is on this machine right now, counting
   * both its CLI on PATH and its desktop app.
   *
   * The cached detection is dropped first: an agent can be installed or removed
   * while the app is open, and the Agent Hub greys out whatever is missing, so
   * a stale "installed" would be worse than the extra probe.
   */
  async detectAgents(): Promise<AgentInstallation[]> {
    this.agentManager.invalidate();
    await this.agentManager.refresh();
    return Object.values(this.agentManager.statesSnapshot()).map((state) =>
      this.toAgentInstallation(state)
    );
  }

  /** Narrows the manager's lifecycle state to the renderer's install contract. */
  private toAgentInstallation(state: AgentState): AgentInstallation {
    return {
      agent: state.agent,
      installed: state.state === 'installed',
      executablePath: state.executablePath,
      desktopAppPath: state.desktopAppPath,
      error: state.error
    };
  }

  /** Lists local skills for the future skills page without exposing filesystem APIs to it. */
  async getInstalledSkills(): Promise<InstalledSkill[]> {
    return this.skillCatalogScanner.scanInstalledSkills();
  }

  /** Reads and normalizes the configured MCP servers for all supported agents. */
  scanInstalledMcps(): Promise<McpCatalogScan> {
    return this.mcpCatalogScanner.scanInstalledMcps();
  }

  /** Alias used by the renderer-facing catalog API. */
  getInstalledMcps(): Promise<McpCatalogScan> {
    return this.scanInstalledMcps();
  }

  /** Converts either editor draft through the same codec used during final apply. */
  prepareMcpConfiguration(draft: McpConfigurationDraft): McpConfigurationPreparation {
    return this.mcpConfigurationPreparer.prepare(draft);
  }

  /** Applies one canonical MCP document and returns a freshly scanned catalog. */
  async applyMcpConfiguration(request: ApplyMcpConfigurationRequest): Promise<McpCatalogScan> {
    await this.mcpConfigurationApplier.apply(request.configurationJson, request.selectedAgents);
    return this.scanInstalledMcps();
  }

  /**
   * Writes one installed MCP into exactly `selectedAgents`, removing it from
   * the agents left out — an empty selection removes it everywhere. The
   * difference is taken here against a fresh scan rather than trusted from the
   * renderer, so a file edited outside the app is still what the save is
   * measured against.
   */
  async applyMcpAgentSelection(
    mcpId: string,
    selectedAgents: McpAgent[]
  ): Promise<McpCatalogScan> {
    const mcp = await this.findMcp(mcpId);
    const addAgents = selectedAgents.filter((agent) => !mcp.agents.includes(agent));
    const removeAgents = mcp.agents.filter((agent) => !selectedAgents.includes(agent));
    await this.mcpConfigurationApplier.applySelection(mcp.definition, addAgents, removeAgents);
    return this.scanInstalledMcps();
  }

  private async findMcp(mcpId: string): Promise<InstalledMcp> {
    const mcp = (await this.scanInstalledMcps()).servers.find((candidate) => candidate.id === mcpId);
    if (!mcp) {
      throw new Error(`MCP not found: ${mcpId}`);
    }
    return mcp;
  }

  /** Lists cached or freshly fetched local model rows and their target capability. */
  listLocalModels(request: LocalModelCatalogRequest = {}) {
    return this.localModelManager.list(request);
  }

  /** Forces a provider refresh while preserving the selected renderer filters. */
  refreshLocalModels(request: LocalModelCatalogRequest = {}) {
    return this.localModelManager.refresh(request);
  }

  /**
   * Starts a model transfer through Electron's native DownloadItem pipeline.
   * Every lifecycle action echoes back a scan built with the caller's own
   * filters, so acting on a row never silently resets the visible list.
   */
  startLocalModelDownload(modelId: string, request: LocalModelCatalogRequest = {}) {
    return this.localModelManager.startDownload(modelId, request);
  }

  /** Cancels the active native download and removes its local files. */
  cancelLocalModelDownload(modelId: string, request: LocalModelCatalogRequest = {}) {
    return this.localModelManager.cancelDownload(modelId, request);
  }

  /** Removes the downloaded model and all local lifecycle state. */
  deleteLocalModel(modelId: string, request: LocalModelCatalogRequest = {}) {
    return this.localModelManager.deleteModel(modelId, request);
  }

  /** Marks a downloaded model as deployed for the local target. */
  deployLocalModel(modelId: string, request: LocalModelCatalogRequest = {}) {
    return this.localModelManager.deployModel(modelId, request);
  }

  /** Returns only renderer-safe availability for the app-owned local model. */
  getLocalChatRuntimeState(): LocalChatRuntimeState {
    return this.tokenHubRuntime.getLocalChatRuntimeState();
  }

  /** Restores persisted local Chat history, tabs, and the current session. */
  loadLocalChatWorkspace(): LocalChatWorkspace {
    return this.chatSessionStore.loadWorkspace();
  }

  /** Creates and focuses a durable blank local Chat session. */
  createLocalChatSession(): LocalChatWorkspace {
    return this.chatSessionStore.createSession();
  }

  /** Opens a historical session as a tab and records it as the current session. */
  openLocalChatSession(sessionId: string): LocalChatWorkspace {
    return this.chatSessionStore.openSession(sessionId);
  }

  /** Removes a tab without deleting the session from local Chat history. */
  closeLocalChatSession(sessionId: string): LocalChatWorkspace {
    return this.chatSessionStore.closeSession(sessionId);
  }

  /** Starts one local-only SSE turn and returns stream events to its caller alone. */
  startLocalChatTurn(event: IpcMainInvokeEvent, request: LocalChatTurnRequest): LocalChatTurnStarted {
    const runtimeState = this.tokenHubRuntime.getLocalChatRuntimeState();
    if (runtimeState.status !== 'ready' || runtimeState.model?.id !== request.modelId) {
      throw new Error('The selected local model is not running.');
    }
    this.chatSessionStore.beginTurn({
      request,
      modelLabel: runtimeState.model.label,
      contextWindowTokens: runtimeState.contextWindowTokens
    });
    this.signalPetCompanion({
      source: 'chat',
      phase: 'sending',
      turnId: request.turnId
    });
    try {
      return this.localChatTurnExecutor.startTurn(request, (streamEvent) => {
        this.chatSessionStore.handleStreamEvent(streamEvent);
        this.signalPetForChatEvent(streamEvent);
        if (!event.sender.isDestroyed()) {
          event.sender.send('chat:event', streamEvent);
        }
      });
    } catch (error) {
      this.chatSessionStore.failTurnStart(
        request.turnId,
        error instanceof Error ? error.message : 'The local model request failed.'
      );
      this.signalPetCompanion({
        source: 'chat',
        phase: 'error',
        turnId: request.turnId
      });
      throw error;
    }
  }

  private signalPetForChatEvent(event: LocalChatEvent): void {
    if (event.type === 'completed' || event.type === 'cancelled' || event.type === 'error') {
      this.signalPetCompanion({
        source: 'chat',
        phase: event.type,
        turnId: event.turnId
      });
      return;
    }
    if (event.type === 'watchdogTerminated') {
      this.signalPetCompanion({
        source: 'chat',
        phase: 'error',
        turnId: event.turnId
      });
    }
  }

  /** Pet feedback is best effort and must never interrupt Chat persistence or delivery. */
  private signalPetCompanion(signal: PetCompanionSignal): void {
    try {
      this.petRuntimeCoordinator?.signalCompanion(signal);
    } catch (error) {
      console.error('[Pet] Companion signal failed:', error);
    }
  }

  /** Stops a local stream by its accepted opaque turn ID. */
  cancelLocalChatTurn(turnId: string): void {
    this.localChatTurnExecutor.cancelTurn(turnId);
  }

  /** Lists the models already stored under ~/.tokkey/models. */
  listInstalledLocalModels(): Promise<InstalledLocalModel[]> {
    return this.localModelManager.listInstalled();
  }

  /** Starts an already-downloaded GGUF file for the local Chat runtime. */
  startInstalledLocalModel(modelId: string): Promise<LocalChatRuntimeState> {
    return this.localModelManager.startInstalledModel(modelId);
  }

  /** Deletes one downloaded model and returns the installed list that remains. */
  async removeInstalledLocalModel(modelId: string): Promise<InstalledLocalModel[]> {
    const runtime = await this.tokenHubRuntime.getState();
    if (
      runtime.modelId === modelId &&
      (runtime.phase === 'starting' || runtime.phase === 'running')
    ) {
      throw new Error('Stop the running local model before removing it.');
    }
    return this.localModelManager.removeInstalled(modelId);
  }

  /** Current USB presence and the one guarded local-server lifecycle. */
  getLocalModelRuntimeState() {
    return this.tokenHubRuntime.getState();
  }

  /** Stops the single Dongle-guarded local model process. */
  stopLocalModelRuntime() {
    return this.tokenHubRuntime.stopModel();
  }

  /** Lists the hardcoded cloud model cards the renderer can connect to. */
  async listCloudModelCards(): Promise<CloudModelCard[]> {
    return this.requireCloudModelConnector().listCards();
  }

  /**
   * Creates the gateway route for one card, persists its model profile, and
   * republishes both CLIs' model configuration so the model appears in their
   * pickers.
   */
  async connectCloudModel(cardId: string): Promise<CloudModelConnection> {
    const connection = await this.requireCloudModelConnector().connect(cardId);
    await this.syncAgentModels();
    return connection;
  }

  /** Rebuilds the gateway routes for the cards saved by an earlier run. */
  async restoreCloudModels(): Promise<CloudModelConnection[]> {
    const restored = await this.requireCloudModelConnector().restoreConnected();
    await this.syncAgentModels();
    return restored;
  }

  /**
   * Republishes the Codex catalog and Claude Code's settings, best effort.
   *
   * A connect that reached the gateway succeeded, whatever the CLIs on this
   * machine do or do not do with it, so a failure on either side is reported
   * and swallowed rather than turned into a failed connection. They are
   * independent files, so one failing must not cost the other its update.
   */
  private async syncAgentModels(): Promise<void> {
    await Promise.all([
      this.syncQuietly('CodexCatalog', () => this.codexGatewayIntegration?.sync()),
      this.syncQuietly('ClaudeConfig', () => this.claudeGatewayIntegration?.syncSettings())
    ]);
  }

  /** Runs one republish, reporting a failure instead of raising it. */
  private async syncQuietly(label: string, sync: () => Promise<unknown> | undefined): Promise<void> {
    try {
      await sync();
    } catch (error: unknown) {
      console.error(`[${label}] Could not republish after a connect:`, error);
    }
  }

  /**
   * The connector needs the gateway supervisor, which only the application
   * owns; a controller built without one reports that instead of silently
   * failing to reach a gateway.
   */
  private requireCloudModelConnector(): CloudModelConnector {
    if (!this.cloudModelConnector) {
      throw new Error('Cloud models are unavailable: no gateway was attached to this controller.');
    }
    return this.cloudModelConnector;
  }

  /** Returns the current selection derived from the skill's filesystem locations. */
  async getSkillAgentSelection(skillId: string): Promise<SkillAgentSelection> {
    const skill = await this.findSkill(skillId);
    const enabledAgents = this.skillDeployer.getEnabledAgents(skill);
    return {
      skill,
      selectedAgents: SKILL_AGENT_ORDER.filter((agent) => enabledAgents.has(agent))
    };
  }

  /** Applies the complete requested set and returns the post-operation catalog. */
  async applySkillAgentSelection(
    skillId: string,
    selectedAgents: SkillAgent[]
  ): Promise<InstalledSkill[]> {
    const skill = await this.findSkill(skillId);
    return this.skillDeployer.applyAgentSelection(skill, selectedAgents);
  }

  /** Removes the skill from every root it occupies and returns the rescanned catalog. */
  async uninstallSkill(skillId: string): Promise<InstalledSkill[]> {
    const skill = await this.findSkill(skillId);
    return this.skillDeployer.uninstallSkill(skill);
  }

  /** Resolves a catalog identifier before allowing the document reader near disk. */
  async getSkillDetails(request: SkillDetailsRequest): Promise<SkillDetails> {
    if (request.kind === 'installed') {
      const installedCatalog = await this.getInstalledSkills();
      const skill = this.findSkillInCatalog(installedCatalog, request.skillId);
      return this.skillDetailsReader.readInstalledSkill(skill, installedCatalog);
    }

    const skill = await this.findRepositorySkill(request.source, request.relativePath);
    return this.skillDetailsReader.readRepositorySkill(skill);
  }

  /** Lists repository cards from the local cache without running Git. */
  listCachedRepositories(): Promise<CachedRepository[]> {
    return this.discoverRepositories.listCached();
  }

  /** Downloads or refreshes one GitHub checkout and returns its rebuilt cards. */
  addRepository(input: string, branch = ''): Promise<RepositorySyncResult> {
    return this.discoverRepositories.addRepository(input, branch);
  }

  /** Installs one cached card through the main-process repository service. */
  installRepositorySkill(request: InstallRepositorySkillRequest): Promise<SkillInstallResult> {
    return this.discoverRepositories.installSkill(request);
  }

  /** Fetches one UI-sized skills.sh page through the main process. */
  fetchSkillsPage(page: number): Promise<SkillsShPage> {
    return this.discoverSkills.fetchSkillsPage(page);
  }

  /** Searches skills.sh only after the renderer submits a trimmed query. */
  searchSkills(query: string): Promise<SkillsShSkill[]> {
    return this.discoverSkills.searchSkills(query);
  }

  /** Slices one UI-sized page out of a search the service already holds. */
  searchSkillsPage(query: string, page: number): Promise<SkillsShPage> {
    return this.discoverSkills.fetchSearchPage(query, page);
  }

  /** Rebuilds installed comparison indexes for both discover tabs. */
  refreshSkillsInstalledStatus(): Promise<void> {
    return this.discoverSkills.refreshInstalledStatus();
  }

  /** Returns the session-aware installed state for one skills.sh listing. */
  getSkillCardState(listing: SkillsShSkill): Promise<SkillsShCardState> {
    return this.discoverSkills.getSkillCardState(listing);
  }

  /** Returns the installed state for a whole page of listings in one pass. */
  getSkillCardStates(listings: SkillsShSkill[]): Promise<SkillsShCardState[]> {
    return this.discoverSkills.getSkillCardStates(listings);
  }

  /** Resolves, imports, and deploys one skills.sh listing. */
  installSkill(request: SkillsShInstallRequest): Promise<SkillsShInstallResult> {
    return this.discoverSkills.installSkill(request);
  }

  /** Opens the folder picker and imports whatever the user chose. */
  uploadSkillFolder(): Promise<SkillUploadResult> {
    return this.skillUploadService.uploadSkillFolder();
  }

  /** Finishes an upload the conflict prompt was holding. */
  resolveSkillUploadConflict(
    pendingUploadId: string,
    choice: SkillUploadConflictChoice
  ): Promise<SkillUploadResult> {
    return this.skillUploadService.resolveConflict(pendingUploadId, choice);
  }

  private async findSkill(skillId: string): Promise<InstalledSkill> {
    return this.findSkillInCatalog(await this.getInstalledSkills(), skillId);
  }

  /** Finds one skill without forcing callers that already scanned to scan again. */
  private findSkillInCatalog(skills: readonly InstalledSkill[], skillId: string): InstalledSkill {
    const skill = skills.find((candidate) => candidate.id === skillId);
    if (!skill) {
      throw new Error(`Skill not found: ${skillId}`);
    }
    return skill;
  }

  /** Finds one cached card by the stable source and relative path sent to the grid. */
  private async findRepositorySkill(
    source: string,
    relativePath: string
  ): Promise<CachedRepositorySkill> {
    const repositories = await this.listCachedRepositories();
    const skill = repositories
      .find((repository) => repository.coordinate.source === source)
      ?.skills.find((candidate) => candidate.relativePath === relativePath);
    if (!skill) {
      throw new Error(`Repository skill not found: ${source}/${relativePath}`);
    }
    return skill;
  }

  private requireSkillId(value: unknown): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new TypeError('Skill ID must be a non-empty string');
    }
    return value;
  }

  /** Accepts catalog identifiers only; renderer-provided filesystem paths are never valid. */
  private requireSkillDetailsRequest(value: unknown): SkillDetailsRequest {
    if (!value || typeof value !== 'object') {
      throw new TypeError('Skill details request must be an object');
    }
    const request = value as Record<string, unknown>;
    if (request.kind === 'installed') {
      return {
        kind: 'installed',
        skillId: this.requireSkillId(request.skillId)
      };
    }
    if (request.kind === 'repository') {
      return {
        kind: 'repository',
        source: this.requireString(request.source, 'Repository source'),
        relativePath: this.requireString(request.relativePath, 'Repository skill path')
      };
    }
    throw new TypeError(`Unsupported skill details request: ${String(request.kind)}`);
  }

  /** `reportConflict` is the flow's own opening move, never a user's answer. */
  private requireUploadConflictChoice(value: unknown): SkillUploadConflictChoice {
    if (value !== 'replace' && value !== 'keepBoth' && value !== 'skip') {
      throw new TypeError(`Unsupported skill upload choice: ${String(value)}`);
    }
    return value;
  }

  private requireMcpApplyRequest(value: unknown): ApplyMcpConfigurationRequest {
    if (!value || typeof value !== 'object') {
      throw new TypeError('MCP apply request must be an object.');
    }
    const request = value as Record<string, unknown>;
    if (typeof request.configurationJson !== 'string' || request.configurationJson.trim().length === 0) {
      throw new TypeError('MCP configuration JSON must be a non-empty string.');
    }
    return {
      configurationJson: request.configurationJson,
      selectedAgents: this.requireMcpAgents(request.selectedAgents)
    };
  }

  /** Accepts only known Pet fields and the finite values used by the UI. */
  private requirePetSettingsPatch(value: unknown): PetSettingsPatch {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('Pet settings patch must be an object.');
    }
    const source = value as Record<string, unknown>;
    const patch: PetSettingsPatch = {};
    if ('isEnabled' in source) {
      if (typeof source.isEnabled !== 'boolean') {
        throw new TypeError('Pet setting isEnabled must be a boolean.');
      }
      patch.isEnabled = source.isEnabled;
    }
    if ('size' in source) {
      patch.size = this.requirePetScale(source.size, 'size');
    }
    if ('speed' in source) {
      patch.speed = this.requirePetScale(source.speed, 'speed');
    }
    if ('movementRange' in source) {
      patch.movementRange = this.requirePetScale(source.movementRange, 'movementRange');
    }
    if (Object.keys(patch).length === 0) {
      throw new TypeError('Pet settings patch must contain a supported field.');
    }
    return patch;
  }

  /** Validates pointer intent before it reaches the main-process Pet runtime. */
  private requirePetInteraction(value: unknown): PetInteraction {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('Pet interaction must be an object.');
    }
    const interaction = value as Record<string, unknown>;
    if (
      interaction.type === 'mouseEnter' ||
      interaction.type === 'mouseLeave' ||
      interaction.type === 'contextMenu' ||
      interaction.type === 'click' ||
      interaction.type === 'dragEnd'
    ) {
      return { type: interaction.type };
    }
    if (interaction.type === 'dragStart' || interaction.type === 'dragMove') {
      if (!interaction.point || typeof interaction.point !== 'object' || Array.isArray(interaction.point)) {
        throw new TypeError('Pet drag interaction must include a point.');
      }
      const point = interaction.point as Record<string, unknown>;
      if (
        typeof point.x !== 'number' || !Number.isFinite(point.x) ||
        typeof point.y !== 'number' || !Number.isFinite(point.y)
      ) {
        throw new TypeError('Pet drag point must contain finite coordinates.');
      }
      return { type: interaction.type, point: { x: point.x, y: point.y } };
    }
    throw new TypeError(`Unsupported Pet interaction: ${String(interaction.type)}.`);
  }

  private requirePetScale(value: unknown, field: string): PetSettings['size'] {
    if (value !== 'small' && value !== 'mid' && value !== 'large') {
      throw new TypeError(`Unsupported Pet ${field}: ${String(value)}.`);
    }
    return value;
  }

  private requireBoolean(value: unknown, field: string): boolean {
    if (typeof value !== 'boolean') {
      throw new TypeError(`${field} must be a boolean.`);
    }
    return value;
  }

  private requireMcpAgents(value: unknown): McpAgent[] {
    if (!Array.isArray(value)) {
      throw new TypeError('Selected MCP agents must be an array.');
    }
    return [...new Set(value.map((agent) => {
      if (typeof agent !== 'string' || !MCP_AGENT_ORDER.includes(agent as McpAgent)) {
        throw new TypeError(`Unsupported MCP agent: ${String(agent)}.`);
      }
      return agent as McpAgent;
    }))];
  }

  private requireSkillAgents(value: unknown): SkillAgent[] {
    if (!Array.isArray(value)) {
      throw new TypeError('Selected agents must be an array');
    }
    const selectedAgents = value.map((agent) => {
      if (typeof agent !== 'string' || !SKILL_AGENT_ORDER.includes(agent as SkillAgent)) {
        throw new TypeError(`Unsupported skill agent: ${String(agent)}`);
      }
      return agent as SkillAgent;
    });
    return [...new Set(selectedAgents)];
  }

  private requireInstallRequest(value: unknown): InstallRepositorySkillRequest {
    if (!value || typeof value !== 'object') {
      throw new TypeError('Repository skill request must be an object');
    }
    const request = value as Record<string, unknown>;
    const conflictStrategy = request.conflictStrategy;
    if (
      conflictStrategy !== 'replace' &&
      conflictStrategy !== 'keepBoth' &&
      conflictStrategy !== 'skip' &&
      conflictStrategy !== 'reportConflict'
    ) {
      throw new TypeError(`Unsupported skill conflict strategy: ${String(conflictStrategy)}`);
    }
    return {
      source: this.requireString(request.source, 'Repository source'),
      relativePath: this.requireString(request.relativePath, 'Repository skill path'),
      enabledAgents: this.requireSkillAgents(request.enabledAgents),
      conflictStrategy
    };
  }

  /**
   * Narrows a renderer-sent preferences patch. Each key is optional, but an
   * a non-boolean switch is rejected rather than coerced: these values are
   * written to disk and pushed into macOS.
   */
  private requireSystemPreferencesPatch(value: unknown): SystemPreferencesPatch {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('System preferences patch must be an object');
    }
    const patch = value as Record<string, unknown>;
    const narrowed: SystemPreferencesPatch = {};

    if (patch.launchAtLogin !== undefined) {
      narrowed.launchAtLogin = this.requireBoolean(patch.launchAtLogin, 'Launch at Login');
    }
    if (patch.preventSystemSleep !== undefined) {
      narrowed.preventSystemSleep = this.requireBoolean(patch.preventSystemSleep, 'Prevent system sleep');
    }
    return narrowed;
  }

  private requireString(value: unknown, label: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new TypeError(`${label} must be a non-empty string`);
    }
    return value;
  }

  /** The feedback endpoint rejects a blank email, so a valid one is required. */
  private requireEmail(value: unknown): string {
    if (typeof value !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) {
      throw new TypeError('Reply email must be a valid email address');
    }
    return value.trim();
  }

  private requireOptionalString(value: unknown): string {
    if (value === undefined || value === null) {
      return '';
    }
    if (typeof value !== 'string') {
      throw new TypeError('Git branch must be a string');
    }
    return value;
  }

  private requirePage(value: unknown): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new TypeError('skills.sh page must be a non-negative integer');
    }
    return value;
  }

  private requireSkillsShSkill(value: unknown): SkillsShSkill {
    if (!value || typeof value !== 'object') {
      throw new TypeError('skills.sh skill must be an object');
    }
    const listing = value as Record<string, unknown>;
    const source = this.requireString(listing.source, 'skills.sh source');
    const skillId = this.requireString(listing.skillId, 'skills.sh skill ID');
    const name = this.requireString(listing.name, 'skills.sh skill name');
    const sourceKind = listing.sourceKind;
    if (sourceKind !== 'repository' && sourceKind !== 'site') {
      throw new TypeError(`Unsupported skills.sh source kind: ${String(sourceKind)}`);
    }
    return {
      id: this.requireString(listing.id, 'skills.sh listing ID'),
      source,
      skillId,
      name,
      installs: typeof listing.installs === 'number' ? listing.installs : 0,
      isOfficial: listing.isOfficial === true,
      sourceKind,
      url: this.requireString(listing.url, 'skills.sh listing URL')
    };
  }

  private requireSkillsShSkills(value: unknown): SkillsShSkill[] {
    if (!Array.isArray(value)) {
      throw new TypeError('skills.sh listings must be an array');
    }
    return value.map((listing) => this.requireSkillsShSkill(listing));
  }

  private requireSkillsShInstallRequest(value: unknown): SkillsShInstallRequest {
    if (!value || typeof value !== 'object') {
      throw new TypeError('skills.sh install request must be an object');
    }
    const request = value as Record<string, unknown>;
    const conflictStrategy = request.conflictStrategy;
    if (
      conflictStrategy !== 'replace' &&
      conflictStrategy !== 'keepBoth' &&
      conflictStrategy !== 'skip' &&
      conflictStrategy !== 'reportConflict'
    ) {
      throw new TypeError(`Unsupported skill conflict strategy: ${String(conflictStrategy)}`);
    }
    return {
      listing: this.requireSkillsShSkill(request.listing),
      enabledAgents: this.requireSkillAgents(request.enabledAgents),
      conflictStrategy
    };
  }

  private requireModelRequest(value: unknown): LocalModelCatalogRequest {
    if (value === undefined || value === null) return {};
    if (!value || typeof value !== 'object') throw new TypeError('Model catalog request must be an object');
    const request = value as Record<string, unknown>;
    const provider = request.provider;
    if (provider !== undefined && (typeof provider !== 'string' || provider.trim().length === 0)) {
      throw new TypeError(`Unsupported model provider: ${String(provider)}`);
    }
    // An empty search box means "no filter", so it is absent rather than invalid.
    const query = request.query;
    if (query !== undefined && typeof query !== 'string') {
      throw new TypeError('Model query must be a string');
    }
    return {
      provider: provider as LocalModelCatalogRequest['provider'],
      query: query === undefined || query.trim().length === 0 ? undefined : query
    };
  }

  private requireModelId(value: unknown): string {
    return this.requireString(value, 'Model ID');
  }

  private createDiscoverRepositories(): DiscoverRepositories {
    const cache = new RepositoryCloneCache();
    const repositoryScanner = new RepositorySkillScanner();
    const catalog = new CachedRepositoryCatalog({
      cache,
      scanner: repositoryScanner,
      installedCatalog: this.skillCatalogScanner
    });
    const importer = new SkillFolderImporter({ filesystem: this.skillCatalogScanner.getFilesystem() });
    const installer = new SkillInstaller({
      catalog,
      installedCatalog: this.skillCatalogScanner,
      importer,
      deployer: this.skillDeployer
    });
    return new DiscoverRepositories({ cache, catalog, installer });
  }
}
