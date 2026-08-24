import { statSync } from 'node:fs';
import path from 'node:path';
import type {
  CachedRepositorySkill,
  InstallRepositorySkillRequest,
  InstalledSkill,
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
    const installedSkills = await this.installedCatalog.scanInstalledSkills();
    const duplicate = this.cachedInstalledMatcher.findMatch(sourceCard.absolutePath, installedSkills);
    if (duplicate && request.conflictStrategy === 'reportConflict') {
      const reconciledSkills = await this.deployer.applyAgentSelection(duplicate, request.enabledAgents);
      return {
        // Keep the repository-tab compatibility status while the directory flow uses alreadyInstalled.
        status: 'reused',
        destinationPath: duplicate.primaryInstallation.absolutePath,
        conflictPath: null,
        installedSkills: reconciledSkills
      };
    }

    const importResult = this.importer.importSkill(
      sourceCard.absolutePath,
      sourceCard.name,
      request.conflictStrategy
    );
    if (importResult.status === 'conflict' || importResult.status === 'skipped') {
      return {
        status: importResult.status,
        destinationPath: importResult.destinationPath,
        conflictPath: importResult.conflictPath,
        installedSkills: await this.installedCatalog.scanInstalledSkills()
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
      installedSkills: reconciledSkills
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
    const repositoryRoot = path.resolve(this.catalog.getCacheRoot(), coordinate.owner, coordinate.name);
    const sourcePath = path.resolve(repositoryRoot, normalizedRelativePath);
    const relativeToRepository = path.relative(repositoryRoot, sourcePath);
    if (
      relativeToRepository.startsWith('..') ||
      path.isAbsolute(relativeToRepository) ||
      path.resolve(card.absolutePath) !== sourcePath ||
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
