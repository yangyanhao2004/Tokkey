import { lstatSync, readFileSync, readdirSync, realpathSync, statSync, type Dirent } from 'node:fs';
import path from 'node:path';
import type { RepositoryCoordinate, SkillManifest } from '../../shared/types';
import { SkillManifestParser } from './SkillCatalogScanner';
import GitHubRepositoryCoordinate from './GitHubRepositoryCoordinate';

const MANIFEST_FILE_NAME = 'SKILL.md';
const MAX_REPOSITORY_DEPTH = 5;
const SKILL_DIRECTORY_NAME = 'skills';
const IGNORED_DIRECTORY_NAMES = new Set([
  'node_modules',
  'dist',
  'build',
  'target',
  'vendor',
  'Pods',
  '.git',
  '.venv',
  'venv',
  '.tox',
  '.mypy_cache',
  '__pycache__',
  'coverage',
  'out',
  'pycache',
  'tmp'
]);

/** One skill folder found in a repository checkout. */
export interface ScrapedSkill {
  id: string;
  name: string;
  summary: string | null;
  description: string | null;
  manifest: SkillManifest;
  source: string;
  relativePath: string;
  repositoryRelativePath: string;
  absolutePath: string;
}

/** The complete result of scanning one repository checkout. */
export interface ScrapedRepository {
  coordinate: RepositoryCoordinate;
  checkoutPath: string;
  commit: string | null;
  skills: ScrapedSkill[];
}

export interface RepositorySkillScannerOptions {
  manifestParser?: SkillManifestParser;
  logger?: (message: string) => void;
}

/** Given a local checkout path, it walks the tree and returns every skill folder it finds */
export class RepositorySkillScanner {
  private readonly manifestParser: SkillManifestParser;
  private readonly logger: (message: string) => void;

  constructor(options: RepositorySkillScannerOptions = {}) {
    this.manifestParser = options.manifestParser ?? new SkillManifestParser();
    this.logger = options.logger ?? (() => undefined);
  }

  /** Scans a checkout without contacting GitHub or following arbitrary files. */
  scan(
    checkoutPath: string,
    coordinate?: RepositoryCoordinate | string,
    commit: string | null = null
  ): ScrapedRepository {
    const resolvedCheckoutPath = path.resolve(checkoutPath);
    if (this.isSymlink(resolvedCheckoutPath) || !this.isDirectory(resolvedCheckoutPath)) {
      throw new Error(`Repository checkout does not exist: ${resolvedCheckoutPath}`);
    }

    const resolvedCoordinate = typeof coordinate === 'string'
      ? new GitHubRepositoryCoordinate(coordinate)
      : coordinate ?? this.coordinateFromCheckoutPath(resolvedCheckoutPath);
    const rootManifestPath = path.join(resolvedCheckoutPath, MANIFEST_FILE_NAME);
    const skillDirectories = this.hasFile(rootManifestPath)
      ? [resolvedCheckoutPath]
      : this.findScanRoots(resolvedCheckoutPath)
        .filter((scanRoot) => !this.isSymlink(scanRoot) && this.isInsideCheckout(scanRoot, resolvedCheckoutPath))
        .flatMap((scanRoot) => this.collectSkillDirectories(scanRoot, 0, resolvedCheckoutPath));

    const skills = skillDirectories
      .map((skillDirectoryPath) => this.makeSkill(skillDirectoryPath, resolvedCheckoutPath, resolvedCoordinate))
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath));

    return {
      coordinate: resolvedCoordinate,
      checkoutPath: resolvedCheckoutPath,
      commit,
      skills
    };
  }

  /** Compatibility alias matching the repository-oriented service vocabulary. */
  scanRepository(
    checkoutPath: string,
    coordinate?: RepositoryCoordinate | string,
    commit: string | null = null
  ): ScrapedRepository {
    return this.scan(checkoutPath, coordinate, commit);
  }

  /** Scans a skills.sh site cache where each direct child is one published skill. */
  scanSite(siteRootPath: string, source: string): ScrapedRepository {
    const resolvedSiteRoot = path.resolve(siteRootPath);
    if (this.isSymlink(resolvedSiteRoot) || !this.isDirectory(resolvedSiteRoot)) {
      throw new Error(`Site cache does not exist: ${resolvedSiteRoot}`);
    }
    const skills: ScrapedSkill[] = [];
    let entries: Dirent[];
    try {
      entries = readdirSync(resolvedSiteRoot, { withFileTypes: true }).sort((left, right) =>
        left.name.localeCompare(right.name)
      );
    } catch (error) {
      throw new Error(`Unable to scan site cache ${resolvedSiteRoot}: ${this.describeError(error)}`);
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue;
      }
      const skillPath = path.join(resolvedSiteRoot, entry.name);
      if (this.isSymlink(skillPath) || !this.isDirectory(skillPath) || !this.hasFile(path.join(skillPath, MANIFEST_FILE_NAME))) {
        continue;
      }
      skills.push(this.makeSkill(skillPath, resolvedSiteRoot, {
        owner: source,
        name: source,
        source,
        cloneUrl: `https://${source}`
      }));
    }
    return {
      coordinate: { owner: source, name: source, source, cloneUrl: `https://${source}` },
      checkoutPath: resolvedSiteRoot,
      commit: null,
      skills: skills.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
    };
  }

  /** Infers owner/repo for direct scanner callers that already have a cache path. */
  private coordinateFromCheckoutPath(checkoutPath: string): RepositoryCoordinate {
    const repositoryName = path.basename(checkoutPath);
    const ownerName = path.basename(path.dirname(checkoutPath));
    return new GitHubRepositoryCoordinate(`${ownerName}/${repositoryName}`);
  }

  /** Finds the authoritative scan root, preferring a top-level skills folder. */
  private findScanRoots(checkoutPath: string): string[] {
    const skillsPath = path.join(checkoutPath, SKILL_DIRECTORY_NAME);
    return this.isDirectory(skillsPath) ? [skillsPath] : [checkoutPath];
  }

  /** Recurses through namespace folders but stops at a manifest-bearing folder. */
  private collectSkillDirectories(directoryPath: string, depth: number, checkoutPath: string): string[] {
    if (depth > MAX_REPOSITORY_DEPTH) {
      return [];
    }

    let entries: Dirent[];
    try {
      entries = readdirSync(directoryPath, { withFileTypes: true }).sort((left, right) =>
        left.name.localeCompare(right.name)
      );
    } catch (error) {
      this.logger(`Unable to scan ${directoryPath}: ${this.describeError(error)}`);
      return [];
    }

    const discovered: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.') || this.shouldIgnoreDirectory(entry.name)) {
        continue;
      }
      const entryPath = path.join(directoryPath, entry.name);
      if (this.isSymlink(entryPath) || !this.isDirectory(entryPath) || !this.isInsideCheckout(entryPath, checkoutPath)) {
        continue;
      }
      if (this.hasFile(path.join(entryPath, MANIFEST_FILE_NAME))) {
        discovered.push(entryPath);
        continue;
      }
      discovered.push(...this.collectSkillDirectories(entryPath, depth + 1, checkoutPath));
    }
    return discovered;
  }

  /** Converts a folder into the stable card shape used by the catalog. */
  private makeSkill(
    skillDirectoryPath: string,
    checkoutPath: string,
    coordinate: RepositoryCoordinate
  ): ScrapedSkill {
    const relativePath = path.relative(checkoutPath, skillDirectoryPath).split(path.sep).join('/');
    const name = relativePath.length > 0 ? path.basename(skillDirectoryPath) : path.basename(checkoutPath);
    let manifest: SkillManifest;
    try {
      manifest = this.manifestParser.parseManifest(skillDirectoryPath);
      const manifestContents = readFileSync(path.join(skillDirectoryPath, MANIFEST_FILE_NAME), 'utf8').replace(/^\uFEFF/, '');
      if (!this.hasValidFrontmatter(manifestContents)) {
        this.logger(`Malformed YAML frontmatter in ${path.join(skillDirectoryPath, MANIFEST_FILE_NAME)}`);
      }
    } catch (error) {
      this.logger(`Unable to parse ${path.join(skillDirectoryPath, MANIFEST_FILE_NAME)}: ${this.describeError(error)}`);
      manifest = { skillName: null, skillDescription: null };
    }
    return {
      id: `${coordinate.source}:${relativePath || name}`,
      name,
      summary: manifest.skillDescription,
      description: manifest.skillDescription,
      manifest,
      source: coordinate.source,
      relativePath: relativePath || name,
      repositoryRelativePath: relativePath || name,
      absolutePath: path.normalize(skillDirectoryPath)
    };
  }

  private hasFile(filePath: string): boolean {
    try {
      return statSync(filePath).isFile();
    } catch {
      return false;
    }
  }

  private shouldIgnoreDirectory(name: string): boolean {
    return IGNORED_DIRECTORY_NAMES.has(name) ||
      name.endsWith('.egg-info') ||
      name.endsWith('.xcodeproj') ||
      name.endsWith('.xcworkspace') ||
      name.startsWith('cmake-build-');
  }

  private isDirectory(directoryPath: string): boolean {
    try {
      return statSync(directoryPath).isDirectory();
    } catch {
      return false;
    }
  }

  private isSymlink(candidatePath: string): boolean {
    try {
      return lstatSync(candidatePath).isSymbolicLink();
    } catch {
      return false;
    }
  }

  /** Prevents a repository symlink from exposing files outside the checkout. */
  private isInsideCheckout(candidatePath: string, checkoutPath: string): boolean {
    try {
      const resolvedCandidate = realpathSync(candidatePath);
      const resolvedCheckout = realpathSync(checkoutPath);
      const relativePath = path.relative(resolvedCheckout, resolvedCandidate);
      return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
    } catch {
      return false;
    }
  }

  /** Checks the delimiters that the lightweight manifest parser supports. */
  private hasValidFrontmatter(contents: string): boolean {
    const lines = contents.split(/\r?\n/);
    const firstContentLine = lines.findIndex((line) => line.trim().length > 0);
    if (firstContentLine < 0 || lines[firstContentLine].trim() !== '---') {
      return false;
    }
    return lines.slice(firstContentLine + 1).some((line) => {
      const delimiter = line.trim();
      return delimiter === '---' || delimiter === '...';
    });
  }

  private describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

export default RepositorySkillScanner;
