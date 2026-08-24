import { readdirSync, realpathSync, type Dirent } from 'node:fs';
import path from 'node:path';
import type {
  CachedRepositorySkill,
  SkillsShSourceKind,
  InstalledSkill,
  RepositoryCoordinate
} from '../../shared/types';
import GitHubRepositoryCoordinate from './GitHubRepositoryCoordinate';
import RepositoryCloneCache from './RepositoryCloneCache';
import RepositorySkillScanner, { type ScrapedRepository, type ScrapedSkill } from './RepositorySkillScanner';
import CachedInstalledSkillMatcher from './CachedInstalledSkillMatcher';
import LocalSkillCatalogScanner from './SkillCatalogScanner';

/** One source tree already available in the local skills.sh cache. */
export interface CachedSource {
  source: string;
  sourceKind: SkillsShSourceKind;
  rootPath: string;
  commit: string | null;
  skills: CachedSourceSkill[];
}

/** A cached source skill with its local path and installed comparison. */
export interface CachedSourceSkill extends CachedRepositorySkill {
  sourceKind: SkillsShSourceKind;
}

export interface CachedSourceCatalogOptions {
  cache?: RepositoryCloneCache;
  scanner?: RepositorySkillScanner;
  installedCatalog?: LocalSkillCatalogScanner;
  cachedInstalledMatcher?: CachedInstalledSkillMatcher;
  cacheRoot?: string;
  homeDirectory?: string;
}

/** Enumerates GitHub and site source trees without contacting the network. */
export class CachedSourceCatalog {
  private readonly cache: RepositoryCloneCache;
  private readonly scanner: RepositorySkillScanner;
  private readonly installedCatalog: LocalSkillCatalogScanner;
  private readonly cachedInstalledMatcher: CachedInstalledSkillMatcher;

  constructor(options: CachedSourceCatalogOptions = {}) {
    this.cache = options.cache ?? new RepositoryCloneCache({
      cacheRoot: options.cacheRoot,
      homeDirectory: options.homeDirectory
    });
    this.scanner = options.scanner ?? new RepositorySkillScanner();
    this.installedCatalog = options.installedCatalog ?? new LocalSkillCatalogScanner({
      homeDirectory: options.homeDirectory
    });
    this.cachedInstalledMatcher = options.cachedInstalledMatcher ?? new CachedInstalledSkillMatcher();
  }

  /** Scans every safe source directory and returns stable source ordering. */
  async scanCachedSources(existingInstalledSkills?: InstalledSkill[]): Promise<CachedSource[]> {
    const installedSkills = existingInstalledSkills ?? await this.installedCatalog.scanInstalledSkills();
    const scannedSources = this.findSourceDirectories()
      .map((sourceDirectory) => this.scanSourceDirectory(sourceDirectory))
      .filter((source): source is ScannedSource => source !== null);
    const matches = this.cachedInstalledMatcher.findMatches(
      scannedSources.flatMap((source) => source.repository.skills.map((skill) => skill.absolutePath)),
      installedSkills
    );
    return scannedSources
      .map((source) => this.toCachedSource(source.repository, source.sourceKind, matches))
      .sort((left, right) => left.source.localeCompare(right.source));
  }

  /** Compatibility alias for generic catalog callers. */
  scan(existingInstalledSkills?: InstalledSkill[]): Promise<CachedSource[]> {
    return this.scanCachedSources(existingInstalledSkills);
  }

  /** Finds one cached listing by source and skill folder name. */
  async findSkill(source: string, skillId: string): Promise<CachedSourceSkill | null> {
    const cachedSources = await this.scanCachedSources();
    return cachedSources
      .find((cachedSource) => cachedSource.source === source)
      ?.skills.find((skill) => skill.name === skillId) ?? null;
  }

  /** Returns the source cache root without creating it. */
  getCacheRoot(): string {
    return this.cache.getCacheRoot();
  }

  /** Scans one source path after a resolver has downloaded it. */
  async scanSource(source: string, rootPath: string, commit: string | null = null): Promise<CachedSource> {
    const installedSkills = await this.installedCatalog.scanInstalledSkills();
    const sourceKind = this.classifySource(source);
    const scanned = sourceKind === 'site'
      ? this.scanner.scanSite(rootPath, source)
      : this.scanner.scan(rootPath, new GitHubRepositoryCoordinate(source), commit);
    const matches = this.cachedInstalledMatcher.findMatches(
      scanned.skills.map((skill) => skill.absolutePath),
      installedSkills
    );
    return this.toCachedSource(scanned, sourceKind, matches);
  }

  private findSourceDirectories(): Array<{ source: string; sourceKind: SkillsShSourceKind; rootPath: string }> {
    const cacheRoot = this.cache.getCacheRoot();
    let owners: Dirent[];
    try {
      owners = readdirSync(cacheRoot, { withFileTypes: true });
    } catch {
      return [];
    }
    const sources: Array<{ source: string; sourceKind: SkillsShSourceKind; rootPath: string }> = [];
    for (const ownerEntry of owners.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!ownerEntry.isDirectory() || ownerEntry.name.startsWith('.')) {
        continue;
      }
      const ownerPath = path.join(cacheRoot, ownerEntry.name);
      if (!this.isInsideCache(ownerPath, cacheRoot)) {
        continue;
      }
      if (this.classifySource(ownerEntry.name) === 'site') {
        sources.push({ source: ownerEntry.name, sourceKind: 'site', rootPath: ownerPath });
        continue;
      }
      let repositories: Dirent[];
      try {
        repositories = readdirSync(ownerPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const repositoryEntry of repositories.sort((left, right) => left.name.localeCompare(right.name))) {
        if (!repositoryEntry.isDirectory() || repositoryEntry.name.startsWith('.')) {
          continue;
        }
        const source = `${ownerEntry.name}/${repositoryEntry.name}`;
        const coordinate = GitHubRepositoryCoordinate.tryParse(source);
        const rootPath = path.join(ownerPath, repositoryEntry.name);
        if (!coordinate || !this.isInsideCache(rootPath, cacheRoot)) {
          continue;
        }
        sources.push({ source, sourceKind: 'repository', rootPath });
      }
    }
    return sources;
  }

  private scanSourceDirectory(
    sourceDirectory: { source: string; sourceKind: SkillsShSourceKind; rootPath: string }
  ): ScannedSource | null {
    try {
      const scanned = sourceDirectory.sourceKind === 'site'
        ? this.scanner.scanSite(sourceDirectory.rootPath, sourceDirectory.source)
        : this.scanner.scan(sourceDirectory.rootPath, new GitHubRepositoryCoordinate(sourceDirectory.source));
      return { repository: scanned, sourceKind: sourceDirectory.sourceKind };
    } catch {
      return null;
    }
  }

  private toCachedSource(
    repository: ScrapedRepository,
    sourceKind: SkillsShSourceKind,
    matches: Map<string, InstalledSkill>
  ): CachedSource {
    return {
      source: repository.coordinate.source,
      sourceKind,
      rootPath: repository.checkoutPath,
      commit: repository.commit,
      skills: repository.skills.map((skill) => this.toCachedSkill(skill, sourceKind, matches))
    };
  }

  private toCachedSkill(
    skill: ScrapedSkill,
    sourceKind: SkillsShSourceKind,
    matches: Map<string, InstalledSkill>
  ): CachedSourceSkill {
    const matchingInstalledSkill = matches.get(path.resolve(skill.absolutePath));
    return {
      id: skill.id,
      name: skill.name,
      summary: skill.summary,
      description: skill.description,
      source: skill.source,
      relativePath: skill.relativePath,
      absolutePath: skill.absolutePath,
      isInstalled: matchingInstalledSkill !== undefined,
      installedSkillId: matchingInstalledSkill?.id ?? null,
      sourceKind
    };
  }

  private classifySource(source: string): SkillsShSourceKind {
    return source.includes('/') || !source.includes('.') ? 'repository' : 'site';
  }

  private isInsideCache(candidatePath: string, cacheRoot: string): boolean {
    try {
      const relativePath = path.relative(realpathSync(cacheRoot), realpathSync(candidatePath));
      return relativePath !== '' && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
    } catch {
      return false;
    }
  }
}

interface ScannedSource {
  repository: ScrapedRepository;
  sourceKind: SkillsShSourceKind;
}

/** Compatibility name for callers that use the source-oriented vocabulary. */
export class LocalCachedSourceCatalog extends CachedSourceCatalog {}

export default CachedSourceCatalog;
