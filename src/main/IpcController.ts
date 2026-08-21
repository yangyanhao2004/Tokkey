import { app, ipcMain, type IpcMainInvokeEvent } from 'electron';
import type {
  AppInfo,
  CachedRepository,
  InstallRepositorySkillRequest,
  InstalledSkill,
  RepositorySyncResult,
  SkillAgent,
  SkillAgentSelection,
  SkillInstallResult
} from '../shared/types';
import { LocalSkillCatalogScanner } from './mcpnskills/SkillCatalogScanner';
import { SKILL_AGENT_ORDER, SkillDeployer } from './mcpnskills/SkillDeployer';
import CachedRepositoryCatalog from './mcpnskills/CachedRepositoryCatalog';
import DiscoverRepositories from './mcpnskills/DiscoverRepositories';
import RepositoryCloneCache from './mcpnskills/RepositoryCloneCache';
import RepositorySkillScanner from './mcpnskills/RepositorySkillScanner';
import SkillFolderImporter from './mcpnskills/SkillFolderImporter';
import SkillInstaller from './mcpnskills/SkillInstaller';

type IpcHandler = (...args: unknown[]) => unknown;

/**
 * Central place for every main-process IPC handler exposed to the renderer.
 * Channel names live here and in preload.ts only, so the surface stays auditable.
 */
export default class IpcController {
  private readonly handlers: Record<string, IpcHandler>;
  private readonly skillCatalogScanner: LocalSkillCatalogScanner;
  private readonly skillDeployer: SkillDeployer;
  private readonly discoverRepositories: DiscoverRepositories;

  constructor(
    skillCatalogScanner: LocalSkillCatalogScanner = new LocalSkillCatalogScanner(),
    skillDeployer: SkillDeployer = new SkillDeployer({ scanner: skillCatalogScanner }),
    discoverRepositories: DiscoverRepositories | null = null
  ) {
    this.skillCatalogScanner = skillCatalogScanner;
    this.skillDeployer = skillDeployer;
    this.discoverRepositories = discoverRepositories ?? this.createDiscoverRepositories();
    // Channel name -> handler function. Add new renderer-callable APIs here.
    this.handlers = {
      'app:get-info': () => this.getAppInfo(),
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
        this.installRepositorySkill(this.requireInstallRequest(request))
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

  /** Lists local skills for the future skills page without exposing filesystem APIs to it. */
  async getInstalledSkills(): Promise<InstalledSkill[]> {
    return this.skillCatalogScanner.scanInstalledSkills();
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
