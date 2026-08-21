import type {
  CachedRepository,
  InstallRepositorySkillRequest,
  RepositorySyncResult,
  SkillInstallResult
} from '../../shared/types';
import GitHubRepositoryCoordinate from './GitHubRepositoryCoordinate';
import CachedRepositoryCatalog from './CachedRepositoryCatalog';
import RepositoryCloneCache from './RepositoryCloneCache';
import SkillInstaller from './SkillInstaller';

export interface DiscoverRepositoriesOptions {
  cache: RepositoryCloneCache;
  catalog: CachedRepositoryCatalog;
  installer: SkillInstaller;
}

/** Coordinates the main-process repository download, cache indexing, and install flows. */
export class DiscoverRepositories {
  private readonly cache: RepositoryCloneCache;
  private readonly catalog: CachedRepositoryCatalog;
  private readonly installer: SkillInstaller;

  constructor(options: DiscoverRepositoriesOptions) {
    this.cache = options.cache;
    this.catalog = options.catalog;
    this.installer = options.installer;
  }

  /** Rebuilds repository cards from disk without contacting GitHub. */
  listCached(): Promise<CachedRepository[]> {
    return this.catalog.scanCachedRepositories();
  }

  /** Normalizes input, synchronizes one checkout, and rebuilds its cards. */
  async addRepository(input: string, branch = ''): Promise<RepositorySyncResult> {
    const coordinate = new GitHubRepositoryCoordinate(input);
    const previousRepositories = await this.catalog.scanCachedRepositories();
    const previousRepository = previousRepositories.find(
      (repository) => repository.coordinate.source === coordinate.source
    );
    const previousSkillNames = new Set(previousRepository?.skills.map((skill) => skill.name) ?? []);
    const checkout = await this.cache.synchronizeCheckout(coordinate, branch);
    const repository = await this.catalog.scanRepository(coordinate, checkout.checkoutPath, checkout.commit);
    const newSkillCount = repository.skills.filter((skill) => !previousSkillNames.has(skill.name)).length;
    return {
      repository,
      wasRefreshed: checkout.wasRefreshed,
      newSkillCount,
      notice: this.makeNotice(coordinate.source, checkout.wasRefreshed, newSkillCount, repository.skills.length)
    };
  }

  /** Compatibility alias for the shorter Add Repo action name. */
  addRepo(input: string, branch = ''): Promise<RepositorySyncResult> {
    return this.addRepository(input, branch);
  }

  /** Installs a skill from the already-local cache; no Git command runs here. */
  installSkill(request: InstallRepositorySkillRequest): Promise<SkillInstallResult> {
    return this.installer.install(request);
  }

  private makeNotice(
    source: string,
    wasRefreshed: boolean,
    newSkillCount: number,
    skillCount: number
  ): string {
    if (!wasRefreshed) {
      return skillCount === 0
        ? `${source} downloaded, but it publishes no skills.`
        : `${source} downloaded - ${skillCount} skills added below.`;
    }
    if (newSkillCount > 0) {
      return `${source} refreshed - ${newSkillCount} new skill${newSkillCount === 1 ? '' : 's'} added below.`;
    }
    return `${source} was already downloaded. Refreshed it - no new skills.`;
  }
}

export default DiscoverRepositories;
