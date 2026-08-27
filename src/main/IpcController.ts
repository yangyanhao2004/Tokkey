import { app, ipcMain, type IpcMainInvokeEvent } from 'electron';
import type {
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
  InstalledSkill,
  McpAgent,
  RepositorySyncResult,
  SkillAgent,
  SkillAgentSelection,
  SkillInstallResult
} from '../shared/types';
import type { McpCatalogScan } from '../shared/types';
import type { LocalModelCatalogRequest } from '../shared/types';
import { McpConfigurationPreparer } from '../shared/McpConfiguration';
import { LocalSkillCatalogScanner } from './mcpnskills/SkillCatalogScanner';
import { SKILL_AGENT_ORDER, SkillDeployer } from './mcpnskills/SkillDeployer';
import CachedRepositoryCatalog from './mcpnskills/CachedRepositoryCatalog';
import DiscoverRepositories from './mcpnskills/DiscoverRepositories';
import RepositoryCloneCache from './mcpnskills/RepositoryCloneCache';
import RepositorySkillScanner from './mcpnskills/RepositorySkillScanner';
import SkillFolderImporter from './mcpnskills/SkillFolderImporter';
import SkillInstaller from './mcpnskills/SkillInstaller';
import DiscoverSkillsService from './mcpnskills/DiscoverSkillsService';
import LocalMcpCatalogScanner, { MCP_AGENT_ORDER } from './mcp/McpCatalogScanner';
import LocalMcpConfigurationApplier, {
  type McpConfigurationApplying
} from './mcp/McpConfigurationApplier';
import LocalModelManager from './models/LocalModelManager';
import CloudModelConnector from './models/CloudModelConnector';
import HostSnapshotService from './host/HostSnapshotService';

type IpcHandler = (...args: unknown[]) => unknown;

/** Collaborators the controller builds itself unless a caller supplies one. */
export interface IpcControllerOptions {
  skillCatalogScanner?: LocalSkillCatalogScanner;
  skillDeployer?: SkillDeployer;
  discoverRepositories?: DiscoverRepositories;
  discoverSkills?: DiscoverSkillsService;
  mcpCatalogScanner?: LocalMcpCatalogScanner;
  mcpConfigurationApplier?: McpConfigurationApplying;
  localModelManager?: LocalModelManager;
  hostSnapshotService?: HostSnapshotService;
  /** Owns the gateway subprocess, so only the app that supervises it can supply this. */
  cloudModelConnector?: CloudModelConnector;
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
  private readonly mcpCatalogScanner: LocalMcpCatalogScanner;
  private readonly mcpConfigurationApplier: McpConfigurationApplying;
  private readonly localModelManager: LocalModelManager;
  private readonly hostSnapshotService: HostSnapshotService;
  private readonly cloudModelConnector: CloudModelConnector | null;
  private readonly mcpConfigurationPreparer = new McpConfigurationPreparer();

  constructor(options: IpcControllerOptions = {}) {
    const skillCatalogScanner = options.skillCatalogScanner ?? new LocalSkillCatalogScanner();
    const skillDeployer =
      options.skillDeployer ?? new SkillDeployer({ scanner: skillCatalogScanner });
    this.skillCatalogScanner = skillCatalogScanner;
    this.skillDeployer = skillDeployer;
    this.discoverRepositories = options.discoverRepositories ?? this.createDiscoverRepositories();
    this.discoverSkills = options.discoverSkills ?? new DiscoverSkillsService({
      installedCatalog: skillCatalogScanner,
      deployer: skillDeployer
    });
    this.mcpCatalogScanner = options.mcpCatalogScanner ?? new LocalMcpCatalogScanner();
    this.mcpConfigurationApplier =
      options.mcpConfigurationApplier ?? new LocalMcpConfigurationApplier();
    this.localModelManager = options.localModelManager ?? new LocalModelManager();
    this.hostSnapshotService = options.hostSnapshotService ?? new HostSnapshotService();
    this.cloudModelConnector = options.cloudModelConnector ?? null;
    // Channel name -> handler function. Add new renderer-callable APIs here.
    this.handlers = {
      'app:get-info': () => this.getAppInfo(),
      'host:snapshot': () => this.getHostSnapshot(),
      'mcps:list-installed': () => this.scanInstalledMcps(),
      'mcps:apply-configuration': (request: unknown) =>
        this.applyMcpConfiguration(this.requireMcpApplyRequest(request)),
      'skills:list-installed': () => this.getInstalledSkills(),
      'skills:get-agent-selection': (skillId: unknown) =>
        this.getSkillAgentSelection(this.requireSkillId(skillId)),
      'skills:apply-agent-selection': (skillId: unknown, selectedAgents: unknown) =>
        this.applySkillAgentSelection(
          this.requireSkillId(skillId),
          this.requireSkillAgents(selectedAgents)
        ),
      'skills:uninstall': (skillId: unknown) => this.uninstallSkill(this.requireSkillId(skillId)),
      'discover-repos:list-cached': () => this.listCachedRepositories(),
      'discover-repos:add': (input: unknown, branch: unknown) =>
        this.addRepository(this.requireString(input, 'Repository input'), this.requireOptionalString(branch)),
      'discover-repos:install-skill': (request: unknown) =>
        this.installRepositorySkill(this.requireInstallRequest(request)),
      'discover-skills:fetch-page': (page: unknown) =>
        this.fetchSkillsPage(this.requirePage(page)),
      'discover-skills:search': (query: unknown) =>
        this.searchSkills(this.requireString(query, 'skills.sh search query')),
      'discover-skills:refresh-installed': () => this.refreshSkillsInstalledStatus(),
      'discover-skills:card-state': (listing: unknown) =>
        this.getSkillCardState(this.requireSkillsShSkill(listing)),
      'discover-skills:install': (request: unknown) =>
        this.installSkill(this.requireSkillsShInstallRequest(request)),
      'models:list': (request: unknown) => this.listLocalModels(this.requireModelRequest(request)),
      'models:refresh': (request: unknown) => this.refreshLocalModels(this.requireModelRequest(request)),
      'models:start-download': (modelId: unknown) => this.startLocalModelDownload(this.requireModelId(modelId)),
      'models:cancel-download': (modelId: unknown) => this.cancelLocalModelDownload(this.requireModelId(modelId)),
      'models:delete': (modelId: unknown) => this.deleteLocalModel(this.requireModelId(modelId)),
      'models:deploy': (modelId: unknown) => this.deployLocalModel(this.requireModelId(modelId)),
      'models:cloud-cards': () => this.listCloudModelCards(),
      'models:connect-cloud': (cardId: unknown) =>
        this.connectCloudModel(this.requireString(cardId, 'Cloud model card ID'))
    };
  }

  /** Connects native Electron downloads after app.whenReady(). */
  attachModelDownloadSession(): void {
    this.localModelManager.attachDownloadSession();
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

  /** Lists cached or freshly fetched local model rows and their target capability. */
  listLocalModels(request: LocalModelCatalogRequest = {}) {
    return this.localModelManager.list(request);
  }

  /** Forces a provider refresh while preserving the selected renderer filters. */
  refreshLocalModels(request: LocalModelCatalogRequest = {}) {
    return this.localModelManager.refresh(request);
  }

  /** Starts a model transfer through Electron's native DownloadItem pipeline. */
  startLocalModelDownload(modelId: string) {
    return this.localModelManager.startDownload(modelId);
  }

  /** Cancels the active native download and removes its local files. */
  cancelLocalModelDownload(modelId: string) {
    return this.localModelManager.cancelDownload(modelId);
  }

  /** Removes the downloaded model and all local lifecycle state. */
  deleteLocalModel(modelId: string) {
    return this.localModelManager.deleteModel(modelId);
  }

  /** Marks a downloaded model as deployed for the local target. */
  deployLocalModel(modelId: string) {
    return this.localModelManager.deployModel(modelId);
  }

  /** Lists the hardcoded cloud model cards the renderer can connect to. */
  async listCloudModelCards(): Promise<CloudModelCard[]> {
    return this.requireCloudModelConnector().listCards();
  }

  /** Creates the gateway route for one card and persists its model profile. */
  connectCloudModel(cardId: string): Promise<CloudModelConnection> {
    return this.requireCloudModelConnector().connect(cardId);
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

  /** Uninstalls the app-managed copy while preserving external real directories. */
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

  /** Rebuilds installed comparison indexes for both directory tabs. */
  refreshSkillsInstalledStatus(): Promise<void> {
    return this.discoverSkills.refreshInstalledStatus();
  }

  /** Returns the session-aware installed state for one directory listing. */
  getSkillCardState(listing: SkillsShSkill): Promise<SkillsShCardState> {
    return this.discoverSkills.getSkillCardState(listing);
  }

  /** Resolves, imports, and deploys one skills.sh listing. */
  installSkill(request: SkillsShInstallRequest): Promise<SkillsShInstallResult> {
    return this.discoverSkills.installSkill(request);
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
