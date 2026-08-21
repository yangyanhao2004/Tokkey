import {
  cpSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync
} from 'node:fs';
import path from 'node:path';
import type { InstalledSkill, SkillAgent } from '../../shared/types';
import LocalSkillCatalogScanner from './SkillCatalogScanner';
import { SkillFilesystemLayout, type SkillFilesystemLayoutOptions } from './SkillFilesystem';

/** Stable ordering used by selection responses and filesystem transitions. */
export const SKILL_AGENT_ORDER: readonly SkillAgent[] = ['hermes', 'claudeCode', 'codex'];

/** Error carrying the path and requested selection that failed. */
export class SkillDeploymentError extends Error {
  readonly operation: string;
  readonly targetPath: string;
  readonly selectedAgents: SkillAgent[];

  constructor(operation: string, targetPath: string, cause: unknown, selectedAgents: SkillAgent[] = []) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`${operation} failed for ${targetPath}: ${reason}`);
    this.name = 'SkillDeploymentError';
    this.operation = operation;
    this.targetPath = targetPath;
    this.selectedAgents = [...selectedAgents];
  }
}

export interface SkillDeployerOptions extends SkillFilesystemLayoutOptions {
  filesystem?: SkillFilesystemLayout;
  scanner?: LocalSkillCatalogScanner;
}

/** Applies the complete desired agent set while keeping canonical skill content safe. */
export class SkillDeployer {
  private readonly filesystem: SkillFilesystemLayout;
  private readonly scanner: LocalSkillCatalogScanner;

  constructor(options: SkillDeployerOptions = {}) {
    this.filesystem = options.filesystem ?? options.scanner?.getFilesystem() ?? new SkillFilesystemLayout(options);
    this.scanner = options.scanner ?? new LocalSkillCatalogScanner({ filesystem: this.filesystem });
  }

  /** Derives enabled agents directly from the skill's current filesystem locations. */
  getEnabledAgents(skill: InstalledSkill): Set<SkillAgent> {
    const relativePath = this.getSkillRelativePath(skill);
    const canonicalPath = this.filesystem.getCanonicalSkillPath(relativePath);
    const enabledAgents = new Set<SkillAgent>();
    for (const agent of SKILL_AGENT_ORDER) {
      if (
        this.getAgentPaths(agent, relativePath).some(
          (candidatePath) =>
            this.pathExists(candidatePath) && this.isSkillPath(skill, candidatePath, canonicalPath)
        )
      ) {
        enabledAgents.add(agent);
      }
    }
    return enabledAgents;
  }

  /** Applies the complete desired selection and returns the rescanned catalog. */
  async applyAgentSelection(
    skill: InstalledSkill,
    selectedAgents: Iterable<SkillAgent>
  ): Promise<InstalledSkill[]> {
    const normalizedSelection = this.normalizeSelectedAgents(selectedAgents);
    const currentSelection = this.getEnabledAgents(skill);
    if (this.areSelectionsEqual(currentSelection, normalizedSelection)) {
      return this.scanner.scanInstalledSkills();
    }

    const relativePath = this.getSkillRelativePath(skill);
    const canonicalPath = this.filesystem.getCanonicalSkillPath(relativePath);
    try {
      this.validateNoConflicts(skill, relativePath, canonicalPath);
      // Copy before removing an agent-owned source so disabling the last agent cannot lose content.
      this.ensureCanonicalCopy(skill, canonicalPath);
      this.removeDisabledAgentEntries(skill, relativePath, canonicalPath, normalizedSelection);
      this.ensureSelectedAgentLinks(skill, relativePath, canonicalPath, normalizedSelection);
      return await this.scanner.scanInstalledSkills();
    } catch (error) {
      await this.rescanAfterFailure();
      throw this.toDeploymentError('Applying agent selection', canonicalPath, error, normalizedSelection);
    }
  }

  /** Removes app-managed links and canonical content while preserving real external directories. */
  async uninstallSkill(skill: InstalledSkill): Promise<InstalledSkill[]> {
    const relativePath = this.getSkillRelativePath(skill);
    const canonicalPath = this.filesystem.getCanonicalSkillPath(relativePath);
    try {
      for (const agent of SKILL_AGENT_ORDER) {
        for (const agentPath of this.getAgentPaths(agent, relativePath)) {
          if (
            this.pathExists(agentPath) &&
            this.isSymlink(agentPath) &&
            this.isSkillPath(skill, agentPath, canonicalPath)
          ) {
            this.removePath(agentPath);
          }
        }
      }
      if (this.pathExists(canonicalPath)) {
        if (!this.isSkillPath(skill, canonicalPath, canonicalPath)) {
          throw new Error(`Canonical path is occupied by another skill: ${canonicalPath}`);
        }
        this.removePath(canonicalPath);
      }
      return await this.scanner.scanInstalledSkills();
    } catch (error) {
      await this.rescanAfterFailure();
      throw this.toDeploymentError('Uninstalling skill', canonicalPath, error);
    }
  }

  /** Returns the stable relative path used across every skill root. */
  private getSkillRelativePath(skill: InstalledSkill): string {
    const relativePath = skill.primaryInstallation.relativePath || skill.name;
    if (relativePath.trim().length === 0) {
      throw new Error('Skill has no filesystem path');
    }
    return relativePath;
  }

  /** Finds a real source directory from the catalog before canonicalizing it. */
  private findSourcePath(skill: InstalledSkill): string {
    const candidates = [
      skill.sourcePath,
      skill.primaryInstallation.resolvedPath,
      ...skill.installations.map((installation) => installation.resolvedPath),
      ...skill.installations.map((installation) => installation.absolutePath)
    ];
    for (const candidate of candidates) {
      if (!this.isDirectory(candidate)) {
        continue;
      }
      try {
        return realpathSync(candidate);
      } catch {
        continue;
      }
    }
    throw new Error(`No readable source directory exists for skill ${skill.id}`);
  }

  /** Creates or refreshes a real canonical copy without linking through another symlink. */
  private ensureCanonicalCopy(skill: InstalledSkill, canonicalPath: string): void {
    const sourcePath = this.findSourcePath(skill);
    if (this.pathExists(canonicalPath) && !this.isSkillPath(skill, canonicalPath, canonicalPath)) {
      throw new Error(`Canonical path is occupied by another skill: ${canonicalPath}`);
    }
    if (!this.pathExists(canonicalPath) || this.resolvePath(canonicalPath) !== sourcePath || this.isSymlink(canonicalPath)) {
      this.copyDirectory(sourcePath, canonicalPath);
    }
  }

  /** Fails before mutation when a same-name installation belongs to another catalog card. */
  private validateNoConflicts(skill: InstalledSkill, relativePath: string, canonicalPath: string): void {
    const candidatePaths = [
      canonicalPath,
      ...SKILL_AGENT_ORDER.flatMap((agent) => this.getAgentPaths(agent, relativePath))
    ];
    for (const candidatePath of candidatePaths) {
      if (this.pathExists(candidatePath) && !this.isSkillPath(skill, candidatePath, canonicalPath)) {
        throw new Error(`Skill path is occupied by another skill: ${candidatePath}`);
      }
    }
  }

  /** Removes all locations belonging to agents that are no longer selected. */
  private removeDisabledAgentEntries(
    skill: InstalledSkill,
    relativePath: string,
    canonicalPath: string,
    selectedAgents: SkillAgent[]
  ): void {
    const selected = new Set(selectedAgents);
    for (const agent of SKILL_AGENT_ORDER) {
      if (selected.has(agent)) {
        continue;
      }
      for (const candidatePath of this.getAgentPaths(agent, relativePath)) {
        if (this.pathExists(candidatePath)) {
          const installation = skill.installations.find(
            (entry) => path.resolve(entry.absolutePath) === path.resolve(candidatePath)
          );
          // Remove links owned by the app, and migrate a sole agent-owned source to canonical storage.
          const isPrimaryAgentSource = installation !== undefined &&
            installation === skill.primaryInstallation &&
            installation.root !== 'amis';
          if (
            this.isSkillPath(skill, candidatePath, canonicalPath) &&
            (installation?.isSymlink === true || isPrimaryAgentSource)
          ) {
            this.removePath(candidatePath);
          }
        }
      }
    }
  }

  /** Links selected agents directly to canonical storage and normalizes Codex's two roots. */
  private ensureSelectedAgentLinks(
    skill: InstalledSkill,
    relativePath: string,
    canonicalPath: string,
    selectedAgents: SkillAgent[]
  ): void {
    for (const agent of selectedAgents) {
      const candidatePaths = this.getAgentPaths(agent, relativePath);
      const fallbackPath = agent === 'codex' ? candidatePaths[candidatePaths.length - 1] : candidatePaths[0];
      const targetPath = candidatePaths.find((candidatePath) => this.pathExists(candidatePath)) ?? fallbackPath;
      if (!targetPath) {
        throw new Error(`No target path is configured for ${agent}`);
      }
      for (const candidatePath of candidatePaths) {
        if (candidatePath !== targetPath && this.pathExists(candidatePath)) {
          if (!this.isSkillPath(skill, candidatePath, canonicalPath)) {
            throw new Error(`Agent path is occupied by another skill: ${candidatePath}`);
          }
          this.removePath(candidatePath);
        }
      }
      if (this.pathExists(targetPath) && !this.isSkillPath(skill, targetPath, canonicalPath)) {
        throw new Error(`Agent path is occupied by another skill: ${targetPath}`);
      }
      this.ensureSymlink(targetPath, canonicalPath);
    }
  }

  private getAgentPaths(agent: SkillAgent, relativePath: string): string[] {
    return this.filesystem.getAgentSkillPaths(agent, relativePath);
  }

  /** Copies through a temporary sibling so a failed copy leaves the previous canonical tree intact. */
  private copyDirectory(sourcePath: string, destinationPath: string): void {
    const parentPath = path.dirname(destinationPath);
    const temporaryPath = path.join(
      parentPath,
      `.${path.basename(destinationPath)}.tokiie-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    mkdirSync(parentPath, { recursive: true });
    try {
      cpSync(sourcePath, temporaryPath, { recursive: true, errorOnExist: true, force: false });
      if (this.pathExists(destinationPath)) {
        this.removePath(destinationPath);
      }
      renameSync(temporaryPath, destinationPath);
    } catch (error) {
      if (this.pathExists(temporaryPath)) {
        rmSync(temporaryPath, { recursive: true, force: true });
      }
      throw error;
    }
  }

  /** Creates a direct symlink after removing a stale link or agent-owned directory. */
  private ensureSymlink(linkPath: string, canonicalPath: string): void {
    if (this.pathExists(linkPath)) {
      if (this.isSymlink(linkPath) && this.resolvePath(linkPath) === canonicalPath) {
        return;
      }
      this.removePath(linkPath);
    }
    mkdirSync(path.dirname(linkPath), { recursive: true });
    symlinkSync(canonicalPath, linkPath, 'dir');
  }

  private normalizeSelectedAgents(selectedAgents: Iterable<SkillAgent>): SkillAgent[] {
    const selected = new Set<SkillAgent>();
    for (const agent of selectedAgents) {
      if (!SKILL_AGENT_ORDER.includes(agent)) {
        throw new Error(`Unsupported skill agent: ${agent}`);
      }
      selected.add(agent);
    }
    return SKILL_AGENT_ORDER.filter((agent) => selected.has(agent));
  }

  private areSelectionsEqual(current: Set<SkillAgent>, requested: SkillAgent[]): boolean {
    return current.size === requested.length && requested.every((agent) => current.has(agent));
  }

  /** Uses lstat so broken links remain visible as enabled entries and removable targets. */
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
      return lstatSync(candidatePath).isDirectory();
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

  private resolvePath(candidatePath: string): string | null {
    try {
      return realpathSync(candidatePath);
    } catch {
      return null;
    }
  }

  private removePath(candidatePath: string): void {
    rmSync(candidatePath, { recursive: true, force: false });
  }

  /** Recognizes only paths represented by the selected card or linked to its source. */
  private isSkillPath(skill: InstalledSkill, candidatePath: string, canonicalPath: string): boolean {
    const absoluteCandidatePath = path.resolve(candidatePath);
    if (skill.installations.some((installation) => path.resolve(installation.absolutePath) === absoluteCandidatePath)) {
      return true;
    }
    const resolvedCandidatePath = this.resolvePath(candidatePath);
    if (!resolvedCandidatePath) {
      return false;
    }
    return (
      resolvedCandidatePath === canonicalPath ||
      skill.installations.some((installation) => installation.resolvedPath === resolvedCandidatePath)
    );
  }

  /** A failed rescan must never hide the original filesystem error from the caller. */
  private async rescanAfterFailure(): Promise<void> {
    try {
      await this.scanner.scanInstalledSkills();
    } catch {
      // Preserve the original path-specific deployment error when rescanning also fails.
    }
  }

  private toDeploymentError(
    operation: string,
    targetPath: string,
    error: unknown,
    selectedAgents: SkillAgent[] = []
  ): SkillDeploymentError {
    return error instanceof SkillDeploymentError
      ? error
      : new SkillDeploymentError(operation, targetPath, error, selectedAgents);
  }
}

export default SkillDeployer;
