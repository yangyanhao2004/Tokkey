import { randomUUID } from 'node:crypto';
import { cpSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, type Dirent } from 'node:fs';
import path from 'node:path';
import type { SkillConflictStrategy } from '../../shared/types';
import { SkillFilesystemLayout, type SkillFilesystemLayoutOptions } from './SkillFilesystem';

export interface SkillFolderImporterOptions extends SkillFilesystemLayoutOptions {
  filesystem?: SkillFilesystemLayout;
  canonicalRoot?: string;
}

export interface SkillFolderImportResult {
  status: 'installed' | 'replaced' | 'keptBoth' | 'skipped' | 'conflict';
  destinationPath: string | null;
  conflictPath: string | null;
}

/** Copies one cached skill into canonical app storage using an explicit conflict policy. */
export class SkillFolderImporter {
  private readonly filesystem: SkillFilesystemLayout;

  constructor(options: SkillFolderImporterOptions = {}) {
    this.filesystem = options.filesystem ?? new SkillFilesystemLayout({
      ...options,
      rootOverrides: options.canonicalRoot
        ? { ...options.rootOverrides, amis: options.canonicalRoot }
        : options.rootOverrides
    });
  }

  /** Stages the copy beside the destination before publishing it. */
  importSkill(
    sourcePath: string,
    skillName: string,
    conflictStrategy: SkillConflictStrategy
  ): SkillFolderImportResult {
    this.validateConflictStrategy(conflictStrategy);
    const normalizedName = this.validateSkillName(skillName);
    const normalizedSourcePath = path.resolve(sourcePath);
    if (!this.isDirectory(normalizedSourcePath)) {
      throw new Error(`Skill source directory does not exist: ${normalizedSourcePath}`);
    }
    if (this.isSymlink(normalizedSourcePath)) {
      throw new Error(`Skill source directory cannot be a symbolic link: ${normalizedSourcePath}`);
    }
    this.rejectSymlinks(normalizedSourcePath);

    const canonicalRoot = this.filesystem.getRootPath('amis');
    const requestedDestinationPath = this.filesystem.getCanonicalSkillPath(normalizedName);
    if (this.pathExists(requestedDestinationPath)) {
      if (conflictStrategy === 'reportConflict') {
        return {
          status: 'conflict',
          destinationPath: null,
          conflictPath: requestedDestinationPath
        };
      }
      if (conflictStrategy === 'skip') {
        return {
          status: 'skipped',
          destinationPath: requestedDestinationPath,
          conflictPath: requestedDestinationPath
        };
      }
    }

    const destinationPath = conflictStrategy === 'keepBoth'
      ? this.findAvailableDestination(normalizedName)
      : requestedDestinationPath;
    const status = this.pathExists(requestedDestinationPath)
      ? conflictStrategy === 'replace' ? 'replaced' : 'keptBoth'
      : 'installed';
    const temporaryPath = path.join(canonicalRoot, `.amis-skill-import-${randomUUID()}`);
    mkdirSync(canonicalRoot, { recursive: true });
    try {
      cpSync(normalizedSourcePath, temporaryPath, {
        recursive: true,
        errorOnExist: true,
        force: false
      });
      if (this.pathExists(destinationPath)) {
        if (conflictStrategy !== 'replace') {
          throw new Error(`Skill destination became occupied during import: ${destinationPath}`);
        }
        this.removePath(destinationPath);
      }
      renameSync(temporaryPath, destinationPath);
      return { status, destinationPath, conflictPath: null };
    } catch (error) {
      if (this.pathExists(temporaryPath)) {
        this.removePath(temporaryPath);
      }
      throw new Error(`Importing skill ${normalizedName} failed at ${destinationPath}: ${this.describeError(error)}`);
    }
  }

  /** Compatibility alias for service callers that use a shorter verb. */
  import(
    sourcePath: string,
    skillName: string,
    conflictStrategy: SkillConflictStrategy
  ): SkillFolderImportResult {
    return this.importSkill(sourcePath, skillName, conflictStrategy);
  }

  /** Returns the app-owned root used for imported skill content. */
  getCanonicalRoot(): string {
    return this.filesystem.getRootPath('amis');
  }

  /** Resolves only a single safe skill directory name. */
  private validateSkillName(skillName: string): string {
    const normalizedName = skillName.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(normalizedName) || normalizedName === '.' || normalizedName === '..') {
      throw new Error(`Invalid skill name: ${skillName}`);
    }
    return normalizedName;
  }

  private validateConflictStrategy(strategy: SkillConflictStrategy): void {
    if (strategy !== 'replace' && strategy !== 'keepBoth' && strategy !== 'skip' && strategy !== 'reportConflict') {
      throw new Error(`Unsupported skill conflict strategy: ${String(strategy)}`);
    }
  }

  private findAvailableDestination(skillName: string): string {
    let suffix = 2;
    let candidatePath = this.filesystem.getCanonicalSkillPath(skillName);
    while (this.pathExists(candidatePath)) {
      candidatePath = this.filesystem.getCanonicalSkillPath(`${skillName}-${suffix}`);
      suffix += 1;
    }
    return candidatePath;
  }

  private pathExists(candidatePath: string): boolean {
    try {
      lstatSync(candidatePath);
      return true;
    } catch {
      return false;
    }
  }

  private isDirectory(candidatePath: string): boolean {
    try {
      return statSync(candidatePath).isDirectory();
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

  /** Keeps imported canonical content independent from arbitrary external symlink targets. */
  private rejectSymlinks(directoryPath: string): void {
    let entries: Dirent[];
    try {
      entries = readdirSync(directoryPath, { withFileTypes: true });
    } catch (error) {
      throw new Error(`Unable to inspect skill source ${directoryPath}: ${this.describeError(error)}`);
    }
    for (const entry of entries) {
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Skill source contains a symbolic link: ${entryPath}`);
      }
      if (entry.isDirectory()) {
        this.rejectSymlinks(entryPath);
      }
    }
  }

  private removePath(candidatePath: string): void {
    rmSync(candidatePath, { recursive: true, force: false });
  }

  private describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

export default SkillFolderImporter;
