import { statSync } from 'node:fs';
import path from 'node:path';
import type {
  CachedRepositorySkill,
  InstallRepositorySkillRequest,
  InstalledSkill,
  SkillConflictStrategy,
  SkillInstallResult,
  SkillAgent
} from '../../shared/types';
import GitHubRepositoryCoordinate from './GitHubRepositoryCoordinate';
import CachedRepositoryCatalog from './CachedRepositoryCatalog';
import { SkillDeployer } from './SkillDeployer';
import SkillFolderImporter from './SkillFolderImporter';
import LocalSkillCatalogScanner from './SkillCatalogScanner';
import CachedInstalledSkillMatcher from './CachedInstalledSkillMatcher';

export interface SkillInstallerOptions {
  catalog: CachedRepositoryCatalog;
  installedCatalog: LocalSkillCatalogScanner;
  importer: SkillFolderImporter;
  deployer: SkillDeployer;
  cachedInstalledMatcher?: CachedInstalledSkillMatcher;
}

/**
 * One install whose source folder has already been resolved on disk, whether by
 * a repository checkout or by a download from a published site.
 */
export interface ResolvedSkillInstallRequest {
  sourcePath: string;
  /** The name the folder is published under in Tokiie's skills folder. */
  skillName: string;
  enabledAgents: SkillAgent[];
  conflictStrategy: SkillConflictStrategy;
  /**
   * What reusing an identical installed folder is called. The repository tab
   * has always reported `reused`; the skills.sh tab says `alreadyInstalled`.
   */
  duplicateStatus?: 'reused' | 'alreadyInstalled';
}

/** A finished install, plus the catalog entry it actually landed on. */
export interface ResolvedSkillInstallation extends SkillInstallResult {
  /** Null when nothing was installed, i.e. a conflict or a skipped import. */
  installedSkill: InstalledSkill | null;
}

/** Installs a cached repository card and then applies its complete agent selection. */
export class SkillInstaller {
  private readonly catalog: CachedRepositoryCatalog;
  private readonly installedCatalog: LocalSkillCatalogScanner;
  private readonly importer: SkillFolderImporter;
  private readonly deployer: SkillDeployer;
  private readonly cachedInstalledMatcher: CachedInstalledSkillMatcher;

  constructor(options: SkillInstallerOptions) {
    this.catalog = options.catalog;
    this.installedCatalog = options.installedCatalog;
    this.importer = options.importer;
    this.deployer = options.deployer;
    this.cachedInstalledMatcher = options.cachedInstalledMatcher ?? new CachedInstalledSkillMatcher();
  }

  /** Resolves the source from cache state so renderer paths are never trusted. */
  async install(request: InstallRepositorySkillRequest): Promise<SkillInstallResult> {
    const sourceCard = await this.findSourceCard(request.source, request.relativePath);
    const installation = await this.installResolvedSkill({
      sourcePath: sourceCard.absolutePath,
      skillName: sourceCard.name,
      enabledAgents: request.enabledAgents,
      conflictStrategy: request.conflictStrategy,
      // Keep the repository-tab compatibility status while the skills.sh flow uses alreadyInstalled.
      duplicateStatus: 'reused'
    });
    return {
      status: installation.status,
      destinationPath: installation.destinationPath,
      conflictPath: installation.conflictPath,
      installedSkills: installation.installedSkills
    };
  }

  /**
   * Publishes one already-resolved folder into Tokiie's skills folder and then
   * applies its complete agent selection.
   *
   * Every install ends here — a repository card, and a skills.sh listing once
   * its source has been cloned or downloaded — so a skill lands the same way
   * whichever tab asked for it: an identical folder already installed is reused
   * rather than copied again, and only its deployment changes.
   */
  async installResolvedSkill(request: ResolvedSkillInstallRequest): Promise<ResolvedSkillInstallation> {
    if (request.conflictStrategy === 'reportConflict') {
      const duplicate = await this.findDuplicate(request.sourcePath);
      if (duplicate) {
        const reconciledSkills = await this.deployer.applyAgentSelection(duplicate, request.enabledAgents);
        return {
          status: request.duplicateStatus ?? 'reused',
          destinationPath: duplicate.primaryInstallation.absolutePath,
          conflictPath: null,
          installedSkills: reconciledSkills,
          installedSkill: duplicate
        };
      }
    }

    const importResult = this.importer.importSkill(
      request.sourcePath,
      request.skillName,
      request.conflictStrategy
    );
    if (importResult.status === 'conflict' || importResult.status === 'skipped') {
      return {
        status: importResult.status,
        destinationPath: importResult.destinationPath,
        conflictPath: importResult.conflictPath,
        installedSkills: await this.installedCatalog.scanInstalledSkills(),
        installedSkill: null
      };
    }

    const refreshedSkills = await this.installedCatalog.scanInstalledSkills();
    const importedSkill = this.findImportedSkill(refreshedSkills, importResult.destinationPath);
    if (!importedSkill) {
      throw new Error(`Imported skill was not found after publishing: ${importResult.destinationPath}`);
    }
    const reconciledSkills = await this.deployer.applyAgentSelection(importedSkill, request.enabledAgents);
    return {
      status: importResult.status,
      destinationPath: importResult.destinationPath,
      conflictPath: null,
      installedSkills: reconciledSkills,
      installedSkill: importedSkill
    };
  }

  /** Accepts a card object for callers that already scanned the cache. */
  async installCard(
    sourceCard: CachedRepositorySkill,
    enabledAgents: SkillAgent[],
    conflictStrategy: InstallRepositorySkillRequest['conflictStrategy']
  ): Promise<SkillInstallResult> {
    return this.install({
      source: sourceCard.source,
      relativePath: sourceCard.relativePath,
      enabledAgents,
      conflictStrategy
    });
  }

  /**
   * The installed skill this exact folder was already published as, if any. A
   * failed hash pass reads as "no duplicate" rather than as a failure: the
   * importer still refuses a name a different skill holds, so the worst case is
   * a conflict reported instead of a folder quietly reused.
   */
  private async findDuplicate(sourcePath: string): Promise<InstalledSkill | null> {
    try {
      const installedSkills = await this.installedCatalog.scanInstalledSkills();
      return this.cachedInstalledMatcher.findMatch(sourcePath, installedSkills);
    } catch {
      return null;
    }
  }

  private async findSourceCard(source: string, relativePath: string): Promise<CachedRepositorySkill> {
    const coordinate = new GitHubRepositoryCoordinate(source);
    const normalizedRelativePath = this.normalizeRelativePath(relativePath);
    const cards = await this.catalog.listSkillCards();
    const card = cards.find(
      (candidate) => candidate.source === coordinate.source && candidate.relativePath === normalizedRelativePath
    );
    if (!card) {
      throw new Error(`Cached repository skill was not found: ${coordinate.source}/${normalizedRelativePath}`);
    }
    // The path installed from is the scanner's, never the caller's: the request
    // only picks a card out of a freshly scanned cache. What still has to hold
    // is that the card sits inside its own checkout.
    const repositoryRoot = path.resolve(this.catalog.getCacheRoot(), coordinate.owner, coordinate.name);
    const sourcePath = path.resolve(card.absolutePath);
    const relativeToRepository = path.relative(repositoryRoot, sourcePath);
    if (
      relativeToRepository.startsWith('..') ||
      path.isAbsolute(relativeToRepository) ||
      !this.isDirectory(sourcePath)
    ) {
      throw new Error(`Cached skill path is outside its repository checkout: ${relativePath}`);
    }
    return card;
  }

  private findImportedSkill(skills: InstalledSkill[], destinationPath: string | null): InstalledSkill | null {
    if (!destinationPath) {
      return null;
    }
    const normalizedDestination = path.resolve(destinationPath);
    return skills.find((skill) =>
      skill.installations.some((installation) => path.resolve(installation.absolutePath) === normalizedDestination)
    ) ?? null;
  }

  private normalizeRelativePath(relativePath: string): string {
    if (typeof relativePath !== 'string' || relativePath.trim().length === 0 || path.isAbsolute(relativePath)) {
      throw new TypeError('Repository skill path must be relative');
    }
    const normalizedRelativePath = path.posix.normalize(relativePath.replaceAll('\\', '/'));
    if (normalizedRelativePath === '.' || normalizedRelativePath.startsWith('../') || normalizedRelativePath.includes('/../')) {
      throw new TypeError(`Repository skill path escapes checkout: ${relativePath}`);
    }
    return normalizedRelativePath;
  }

  private isDirectory(candidatePath: string): boolean {
    try {
      return statSync(candidatePath).isDirectory();
    } catch {
      return false;
    }
  }
}

/** Compatibility alias for callers that use the repository-specific name. */
export class RepositorySkillInstaller extends SkillInstaller {}

export default SkillInstaller;
