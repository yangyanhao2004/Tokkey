import path from 'node:path';
import { SKILLS_SH_PAGE_SIZE } from '../../shared/types';
import type {
  SkillsShCardState,
  SkillsShInstallRequest,
  SkillsShInstallResult,
  SkillsShPage,
  SkillsShSkill,
  InstalledSkill,
  SkillAgent,
  SkillConflictStrategy
} from '../../shared/types';
import CachedSourceCatalog, { type CachedSource } from './CachedSourceCatalog';
import CachedRepositoryCatalog from './CachedRepositoryCatalog';
import SkillSourceResolver from './SkillSourceResolver';
import RepositoryCloneCache from './RepositoryCloneCache';
import SkillDeployer from './SkillDeployer';
import SkillInstaller from './SkillInstaller';
import CachedInstalledSkillMatcher from './CachedInstalledSkillMatcher';
import SkillFolderImporter from './SkillFolderImporter';
import LocalSkillCatalogScanner from './SkillCatalogScanner';
import SkillsShClient from './SkillsShClient';

const API_PAGE_SIZE = 200;
const UI_PAGE_SIZE = SKILLS_SH_PAGE_SIZE;

export interface DiscoverSkillsServiceOptions {
  skillsShClient?: SkillsShClient;
  cachedCatalog?: CachedSourceCatalog;
  installedCatalog?: LocalSkillCatalogScanner;
  cachedInstalledMatcher?: CachedInstalledSkillMatcher;
  skillSourceResolver?: SkillSourceResolver;
  importer?: SkillFolderImporter;
  deployer?: SkillDeployer;
  installer?: SkillInstaller;
  cache?: RepositoryCloneCache;
}

/** Coordinates skills.sh listings, local comparison indexes, and installation. */
export class DiscoverSkillsService {
  private readonly skillsShClient: SkillsShClient;
  private readonly cachedCatalog: CachedSourceCatalog;
  private readonly installedCatalog: LocalSkillCatalogScanner;
  private readonly cachedInstalledMatcher: CachedInstalledSkillMatcher;
  private readonly skillSourceResolver: SkillSourceResolver;
  private readonly installer: SkillInstaller;
  private readonly cachedApiPages = new Map<number, SkillsShPage>();
  private readonly searchResults = new Map<string, SkillsShSkill[]>();
  private readonly installedSkillsById = new Map<string, InstalledSkill>();
  private readonly cachedSkillPathsBySource = new Map<string, Map<string, string>>();
  private readonly installedByCachedPath = new Map<string, InstalledSkill>();
  private cachedSources: CachedSource[] = [];

  constructor(options: DiscoverSkillsServiceOptions = {}) {
    const installedCatalog = options.installedCatalog ?? new LocalSkillCatalogScanner();
    const cache = options.cache ?? new RepositoryCloneCache({
      cacheRoot: options.cachedCatalog?.getCacheRoot()
    });
    this.skillsShClient = options.skillsShClient ?? new SkillsShClient();
    this.installedCatalog = installedCatalog;
    this.cachedInstalledMatcher = options.cachedInstalledMatcher ?? new CachedInstalledSkillMatcher();
    this.cachedCatalog = options.cachedCatalog ?? new CachedSourceCatalog({
      cache,
      installedCatalog,
      cachedInstalledMatcher: this.cachedInstalledMatcher
    });
    this.skillSourceResolver = options.skillSourceResolver ?? new SkillSourceResolver({ cache });
    // Both discover tabs install through the one installer, so a skill from
    // skills.sh is published exactly as a skill from a cloned repository is.
    this.installer = options.installer ?? new SkillInstaller({
      catalog: new CachedRepositoryCatalog({ cache, installedCatalog }),
      installedCatalog,
      importer: options.importer ?? new SkillFolderImporter({ filesystem: installedCatalog.getFilesystem() }),
      deployer: options.deployer ?? new SkillDeployer({ scanner: installedCatalog }),
      cachedInstalledMatcher: this.cachedInstalledMatcher
    });
  }

  /** Fetches a raw API page, retaining it for all ten UI pages it backs. */
  fetchApiPage(apiPage: number): Promise<SkillsShPage> {
    this.validatePage(apiPage);
    const cachedPage = this.cachedApiPages.get(apiPage);
    if (cachedPage) {
      return Promise.resolve(cachedPage);
    }
    return this.skillsShClient.fetchPage(apiPage).then((page) => {
      this.cachedApiPages.set(apiPage, page);
      return page;
    });
  }

  /** Fetches one 20-record browse page using the 200/20 offset contract. */
  async fetchSkillsPage(uiPage: number): Promise<SkillsShPage> {
    this.validatePage(uiPage);
    const apiPage = Math.floor((uiPage * UI_PAGE_SIZE) / API_PAGE_SIZE);
    const apiResult = await this.fetchApiPage(apiPage);
    const offset = (uiPage * UI_PAGE_SIZE) % API_PAGE_SIZE;
    return {
      skills: apiResult.skills.slice(offset, offset + UI_PAGE_SIZE),
      total: apiResult.total,
      hasMore: (uiPage + 1) * UI_PAGE_SIZE < apiResult.total,
      page: uiPage
    };
  }

  /** Fetches the flat search result once per trimmed query. */
  async searchSkills(query: string): Promise<SkillsShSkill[]> {
    const normalizedQuery = this.normalizeQuery(query);
    const cachedResults = this.searchResults.get(normalizedQuery);
    if (cachedResults) {
      return [...cachedResults];
    }
    const results = await this.skillsShClient.search(normalizedQuery);
    this.searchResults.set(normalizedQuery, [...results]);
    return [...results];
  }

  /** Slices an in-memory search result without making another network request. */
  async fetchSearchPage(query: string, uiPage: number): Promise<SkillsShPage> {
    this.validatePage(uiPage);
    const skills = await this.searchSkills(query);
    const offset = uiPage * UI_PAGE_SIZE;
    return {
      skills: skills.slice(offset, offset + UI_PAGE_SIZE),
      total: skills.length,
      hasMore: offset + UI_PAGE_SIZE < skills.length,
      page: uiPage
    };
  }

  /** Rebuilds cached-source and installed indexes in one scan pass. */
  async refreshInstalledStatus(): Promise<void> {
    let installedSkills: InstalledSkill[] = [];
    try {
      installedSkills = await this.installedCatalog.scanInstalledSkills();
    } catch {
      installedSkills = [];
    }
    let cachedSources: CachedSource[] = [];
    try {
      cachedSources = await this.cachedCatalog.scanCachedSources(installedSkills);
    } catch {
      cachedSources = [];
    }
    const sessionOverlay = new Map(this.installedSkillsById);
    this.cachedSources = cachedSources;
    this.installedSkillsById.clear();
    this.cachedSkillPathsBySource.clear();
    this.installedByCachedPath.clear();
    for (const installedSkill of installedSkills) {
      this.installedSkillsById.set(installedSkill.id, installedSkill);
    }
    for (const [listingId, installedSkill] of sessionOverlay) {
      this.installedSkillsById.set(listingId, installedSkill);
    }
    const cachedPaths: string[] = [];
    for (const source of cachedSources) {
      const pathsBySkill = new Map<string, string>();
      for (const skill of source.skills) {
        pathsBySkill.set(skill.name, skill.absolutePath);
        cachedPaths.push(skill.absolutePath);
      }
      this.cachedSkillPathsBySource.set(source.source, pathsBySkill);
    }
    try {
      const matches = this.cachedInstalledMatcher.findMatches(cachedPaths, installedSkills);
      for (const [cachedPath, installedSkill] of matches) {
        this.installedByCachedPath.set(cachedPath, installedSkill);
      }
    } catch {
      // A failed hash pass means cards must conservatively offer Add.
    }
  }

  /** Resolves card status using the session overlay before filesystem indexes. */
  async getSkillCardState(listing: SkillsShSkill): Promise<SkillsShCardState> {
    const overlaySkill = this.installedSkillsById.get(listing.id);
    if (overlaySkill) {
      return { listing, installedSkill: overlaySkill };
    }
    if (!this.cachedSources.length) {
      await this.refreshInstalledStatus();
    }
    const cachedPath = this.cachedSkillPathsBySource.get(listing.source)?.get(listing.skillId);
    return {
      listing,
      installedSkill: cachedPath ? this.installedByCachedPath.get(path.resolve(cachedPath)) ?? null : null
    };
  }

  /**
   * Resolves card state for a whole page in one pass. The indexes are built at
   * most once here, so drawing twenty cards costs one scan rather than twenty.
   */
  async getSkillCardStates(listings: readonly SkillsShSkill[]): Promise<SkillsShCardState[]> {
    if (!this.cachedSources.length) {
      await this.refreshInstalledStatus();
    }
    const cardStates: SkillsShCardState[] = [];
    for (const listing of listings) {
      cardStates.push(await this.getSkillCardState(listing));
    }
    return cardStates;
  }

  /**
   * Installs a listing after resolving its local source folder: a repository
   * checkout for a GitHub source, a download for a published site. Publishing
   * and deployment are the installer's, so the only thing this adds is what the
   * listing knows — which card the result belongs to, and where it came from.
   */
  async installListing(
    listing: SkillsShSkill,
    enabledAgents: SkillAgent[],
    conflictStrategy: SkillConflictStrategy
  ): Promise<SkillsShInstallResult> {
    const resolved = await this.skillSourceResolver.resolveSkill(listing);
    const installation = await this.installer.installResolvedSkill({
      sourcePath: resolved.skillPath,
      skillName: path.basename(resolved.skillPath),
      enabledAgents,
      conflictStrategy,
      duplicateStatus: 'alreadyInstalled'
    });
    if (installation.installedSkill) {
      // A card is drawn from the listing's id, which no filesystem scan knows,
      // so what was just installed is remembered under it before rescanning.
      this.updateSessionOverlay(listing, installation.installedSkills, installation.installedSkill);
      await this.refreshInstalledStatus();
    }
    return {
      status: installation.status,
      destinationPath: installation.destinationPath,
      conflictPath: installation.conflictPath,
      installedSkills: installation.installedSkills,
      listing,
      resolvedPath: resolved.skillPath
    };
  }

  /** Accepts the renderer-shaped request object. */
  installSkill(request: SkillsShInstallRequest): Promise<SkillsShInstallResult> {
    return this.installListing(request.listing, request.enabledAgents, request.conflictStrategy);
  }

  /** Compatibility alias for generic install transaction callers. */
  install(request: SkillsShInstallRequest): Promise<SkillsShInstallResult> {
    return this.installSkill(request);
  }

  /** Returns cached source cards for callers that need to repaint the Repos tab. */
  getCachedSources(): CachedSource[] {
    return this.cachedSources.map((source) => ({ ...source, skills: [...source.skills] }));
  }

  private updateSessionOverlay(listing: SkillsShSkill, installedSkills: InstalledSkill[], fallback: InstalledSkill): void {
    const matchingSkill = installedSkills.find((skill) => skill.id === fallback.id || skill.name === fallback.name) ?? fallback;
    this.installedSkillsById.set(listing.id, matchingSkill);
  }

  private normalizeQuery(query: string): string {
    if (typeof query !== 'string' || query.trim().length < 3) {
      throw new TypeError('skills.sh search query must contain at least 3 characters');
    }
    return query.trim();
  }

  private validatePage(page: number): void {
    if (!Number.isInteger(page) || page < 0) {
      throw new RangeError('skills.sh page must be a non-negative integer');
    }
  }
}

export default DiscoverSkillsService;
