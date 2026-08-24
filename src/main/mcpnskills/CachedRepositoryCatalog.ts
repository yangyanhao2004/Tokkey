import { readdirSync, realpathSync, type Dirent } from 'node:fs';
import path from 'node:path';
import type {
  CachedRepository,
  CachedRepositorySkill,
  InstalledSkill,
  RepositoryCoordinate
} from '../../shared/types';
import LocalSkillCatalogScanner from './SkillCatalogScanner';
import GitHubRepositoryCoordinate from './GitHubRepositoryCoordinate';
import RepositoryCloneCache from './RepositoryCloneCache';
import RepositorySkillScanner, { type ScrapedRepository, type ScrapedSkill } from './RepositorySkillScanner';
import CachedInstalledSkillMatcher from './CachedInstalledSkillMatcher';

export interface CachedRepositoryCatalogOptions {
  cache?: RepositoryCloneCache;
  scanner?: RepositorySkillScanner;
  installedCatalog?: LocalSkillCatalogScanner;
  cacheRoot?: string;
  homeDirectory?: string;
  cachedInstalledMatcher?: CachedInstalledSkillMatcher;
}

/** Read-only index of GitHub checkouts already present in the local cache. */
/** It answers "what skills are available from repos I've
  already downloaded, and which of them are already installed?" without touching Git or the network */
export class CachedRepositoryCatalog {
  private readonly cache: RepositoryCloneCache;
  private readonly repositoryScanner: RepositorySkillScanner;
  private readonly installedCatalog: LocalSkillCatalogScanner | null;
  private readonly cachedInstalledMatcher: CachedInstalledSkillMatcher;

  constructor(options: CachedRepositoryCatalogOptions = {}) {
    this.cache = options.cache ?? new RepositoryCloneCache({
      cacheRoot: options.cacheRoot,
      homeDirectory: options.homeDirectory
    });
    this.repositoryScanner = options.scanner ?? new RepositorySkillScanner();
    this.installedCatalog = options.installedCatalog ?? null;
    this.cachedInstalledMatcher = options.cachedInstalledMatcher ?? new CachedInstalledSkillMatcher();
  }

  /** Enumerates owner/repo directories without invoking Git or the network. */
  async scanCachedRepositories(): Promise<CachedRepository[]> {
    const cachedRepositories = this.findRepositoryDirectories()
      .map(({ owner, repositoryPath }) => {
        try {
          const coordinate = new GitHubRepositoryCoordinate(`${owner}/${path.basename(repositoryPath)}`);
          return this.repositoryScanner.scan(repositoryPath, coordinate);
        } catch {
          return null;
        }
      })
      .filter((repository): repository is ScrapedRepository => repository !== null);

    const installedSkills = this.installedCatalog
      ? await this.installedCatalog.scanInstalledSkills()
      : [];
    return cachedRepositories
      .map((repository) => this.toCachedRepository(repository, installedSkills))
      .sort((left, right) => left.coordinate.source.localeCompare(right.coordinate.source));
  }

  /** Returns a flat card list for renderer stores that do not group by repository. */
  async listSkillCards(): Promise<CachedRepositorySkill[]> {
    const repositories = await this.scanCachedRepositories();
    return repositories.flatMap((repository) => repository.skills);
  }

  /** Reindexes one checkout after a clone or refresh operation. */
  async scanRepository(
    coordinate: RepositoryCoordinate,
    checkoutPath: string,
    commit: string | null = null
  ): Promise<CachedRepository> {
    const repository = this.repositoryScanner.scan(checkoutPath, coordinate, commit);
    const installedSkills = this.installedCatalog
      ? await this.installedCatalog.scanInstalledSkills()
      : [];
    return this.toCachedRepository(repository, installedSkills);
  }

  /** Exposes the cache root for validating install requests. */
  getCacheRoot(): string {
    return this.cache.getCacheRoot();
  }

  private findRepositoryDirectories(): Array<{ owner: string; repositoryPath: string }> {
    const cacheRoot = this.cache.getCacheRoot();
    let owners: Dirent[];
    try {
      owners = readdirSync(cacheRoot, { withFileTypes: true });
    } catch {
      return [];
    }

    const repositories: Array<{ owner: string; repositoryPath: string }> = [];
    for (const ownerEntry of owners.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!ownerEntry.isDirectory() || ownerEntry.name.startsWith('.')) {
        continue;
      }
      const ownerPath = path.join(cacheRoot, ownerEntry.name);
      if (!this.isInsideCache(ownerPath, cacheRoot)) {
        continue;
      }
      let repositoryEntries: Dirent[];
      try {
        repositoryEntries = readdirSync(ownerPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const repositoryEntry of repositoryEntries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (!repositoryEntry.isDirectory() || repositoryEntry.name.startsWith('.')) {
          continue;
        }
        const repositoryPath = path.join(ownerPath, repositoryEntry.name);
        if (!this.isInsideCache(repositoryPath, cacheRoot)) {
          continue;
        }
        repositories.push({
          owner: ownerEntry.name,
          repositoryPath
        });
      }
    }
    return repositories;
  }

  private toCachedRepository(repository: ScrapedRepository, installedSkills: InstalledSkill[]): CachedRepository {
    return {
      coordinate: repository.coordinate,
      checkoutPath: repository.checkoutPath,
      commit: repository.commit,
      skills: repository.skills.map((skill) => this.toCachedSkill(skill, installedSkills))
    };
  }

  private toCachedSkill(skill: ScrapedSkill, installedSkills: InstalledSkill[]): CachedRepositorySkill {
    const matchingInstalledSkill = this.cachedInstalledMatcher.findMatch(skill.absolutePath, installedSkills);
    return {
      id: skill.id,
      name: skill.name,
      summary: skill.summary,
      description: skill.description,
      source: skill.source,
      relativePath: skill.relativePath,
      absolutePath: skill.absolutePath,
      isInstalled: matchingInstalledSkill !== undefined,
      installedSkillId: matchingInstalledSkill?.id ?? null
    };
  }

  /** Prevents cache symlinks from making the catalog read outside its root. */
  private isInsideCache(candidatePath: string, cacheRoot: string): boolean {
    try {
      const relativePath = path.relative(realpathSync(cacheRoot), realpathSync(candidatePath));
      return relativePath !== '' && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
    } catch {
      return false;
    }
  }
}

/** Compatibility name matching the Swift implementation described by the spec. */
export class LocalCachedRepositoryCatalog extends CachedRepositoryCatalog {}

export default CachedRepositoryCatalog;
