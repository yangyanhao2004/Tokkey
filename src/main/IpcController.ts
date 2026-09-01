import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import type {
  AgentInstallation,
  AppInfo,
  ApplyMcpConfigurationRequest,
  CachedRepository,
  CloudModelCard,
  CloudModelConnection,
  HostSnapshot,
  McpConfigurationDraft,
  McpConfigurationPreparation,
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
  SkillAgent,
  SkillAgentSelection,
  SkillInstallResult,
  SkillUploadConflictChoice,
  SkillUploadResult
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
import SkillUploadService from './mcpnskills/SkillUploadService';
import DiscoverSkillsService from './mcpnskills/DiscoverSkillsService';
import LocalMcpCatalogScanner, { MCP_AGENT_ORDER } from './mcp/McpCatalogScanner';
import LocalMcpConfigurationApplier, {
  type McpConfigurationApplying
} from './mcp/McpConfigurationApplier';
import AgentManager, { type AgentState } from './agents/AgentManager';
import InstalledAgentGate from './agents/InstalledAgentGate';
import LocalModelManager from './models/LocalModelManager';
import CloudModelConnector from './models/CloudModelConnector';
import CodexGatewayIntegration from './codex/CodexGatewayIntegration';
import ClaudeGatewayIntegration from './claude/ClaudeGatewayIntegration';
import HostSnapshotService from './host/HostSnapshotService';
import TokenHubRuntime from './models/tokenhub/TokenHubRuntime';
import AccountRuntime from './account/AccountRuntime';
import AccountService from './account/AccountService';

type IpcHandler = (...args: unknown[]) => unknown;

/** Collaborators the controller builds itself unless a caller supplies one. */
export interface IpcControllerOptions {
  accountService?: AccountService;
  skillCatalogScanner?: LocalSkillCatalogScanner;
  skillDeployer?: SkillDeployer;
  discoverRepositories?: DiscoverRepositories;
  discoverSkills?: DiscoverSkillsService;
  skillUploadService?: SkillUploadService;
  mcpCatalogScanner?: LocalMcpCatalogScanner;
  mcpConfigurationApplier?: McpConfigurationApplying;
  localModelManager?: LocalModelManager;
  tokenHubRuntime?: TokenHubRuntime;
  hostSnapshotService?: HostSnapshotService;
  agentManager?: AgentManager;
  /** Owns the gateway subprocess, so only the app that supervises it can supply this. */
  cloudModelConnector?: CloudModelConnector;
  /** Keeps the Codex CLI's model catalog in step with the gateway's routes. */
  codexGatewayIntegration?: CodexGatewayIntegration;
  /** Keeps Claude Code's model settings in step with the gateway's routes. */
  claudeGatewayIntegration?: ClaudeGatewayIntegration;
}

/**
 * Central place for every main-process IPC handler exposed to the renderer.
 * Channel names live here and in preload.ts only, so the surface stays auditable.
 */
export default class IpcController {
  private readonly handlers: Record<string, IpcHandler>;
  private readonly skillCatalogScanner: LocalSkillCatalogScanner;
  private readonly skillDeployer: SkillDeployer;
  private readonly discoverRepositories: DiscoverRepositories;
  private readonly discoverSkills: DiscoverSkillsService;
  private readonly skillUploadService: SkillUploadService;
  private readonly mcpCatalogScanner: LocalMcpCatalogScanner;
  private readonly mcpConfigurationApplier: McpConfigurationApplying;
  private readonly localModelManager: LocalModelManager;
  private readonly tokenHubRuntime: TokenHubRuntime;
  private readonly hostSnapshotService: HostSnapshotService;
  private readonly agentManager: AgentManager;
  private readonly accountService: AccountService;
  private readonly cloudModelConnector: CloudModelConnector | null;
  private readonly codexGatewayIntegration: CodexGatewayIntegration | null;
  private readonly claudeGatewayIntegration: ClaudeGatewayIntegration | null;
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
    this.localModelManager = options.localModelManager ?? new LocalModelManager();
    this.tokenHubRuntime = options.tokenHubRuntime ?? new TokenHubRuntime();
    this.tokenHubRuntime.subscribe((state) => {
      BrowserWindow.getAllWindows().forEach((window) => {
        if (!window.isDestroyed()) window.webContents.send('models:runtime-state-changed', state);
      });
    });
    this.hostSnapshotService = options.hostSnapshotService ?? new HostSnapshotService();
    this.cloudModelConnector = options.cloudModelConnector ?? null;
    this.codexGatewayIntegration = options.codexGatewayIntegration ?? null;
    this.claudeGatewayIntegration = options.claudeGatewayIntegration ?? null;
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
      'models:remove-installed': (modelId: unknown) =>
        this.removeInstalledLocalModel(this.requireModelId(modelId)),
      'models:runtime-state': () => this.getLocalModelRuntimeState(),
      'models:start-installed': (modelId: unknown) =>
        this.startInstalledLocalModel(this.requireModelId(modelId)),
      'models:stop-runtime': () => this.stopLocalModelRuntime(),
      'models:cloud-cards': () => this.listCloudModelCards(),
      'models:restore-cloud': () => this.restoreCloudModels(),
      'models:connect-cloud': (cardId: unknown) =>
        this.connectCloudModel(this.requireString(cardId, 'Cloud model card ID'))
    };
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

  /**
   * Whether each supported coding agent is on PATH right now.
   *
   * The cached detection is dropped first: an agent can be installed or removed
   * from a terminal while the app is open, and the Agent Hub greys out whatever
   * is missing, so a stale "installed" would be worse than the extra probe.
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

  /** Lists the models already stored under ~/.amiswifi/models. */
  listInstalledLocalModels(): Promise<InstalledLocalModel[]> {
    return this.localModelManager.listInstalled();
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

  /** Starts the exact recursively-discovered GGUF selected on the Tokiie page. */
  async startInstalledLocalModel(modelId: string) {
    const model = (await this.localModelManager.listInstalled()).find(
      (candidate) => candidate.id === modelId
    );
    if (!model) throw new Error(`Installed local model not found: ${modelId}`);
    const state = await this.tokenHubRuntime.startModel(model);
    await this.syncAgentModels();
    return state;
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
      this.syncQuietly('CodexCatalog', () => this.codexGatewayIntegration?.syncCatalog()),
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
    const skill = (await this.getInstalledSkills()).find((candidate) => candidate.id === skillId);
    if (!skill) {
      throw new Error(`Skill not found: ${skillId}`);
    }
    return skill;
  }

  private requireSkillId(value: unknown): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new TypeError('Skill ID must be a non-empty string');
    }
    return value;
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

  private requireString(value: unknown, label: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new TypeError(`${label} must be a non-empty string`);
    }
    return value;
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
