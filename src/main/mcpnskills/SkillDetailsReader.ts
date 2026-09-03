import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  SKILL_ROOT_DISPLAY_NAMES,
  type CachedRepositorySkill,
  type InstalledSkill,
  type SkillDetails,
  type SkillDetailsLocation
} from '../../shared/types';

const MANIFEST_FILE_NAME = 'SKILL.md';
const MAX_SKILL_DOCUMENT_BYTES = 1024 * 1024;

interface SkillDocumentSource {
  name: string;
  directoryPath: string;
  trustedDirectoryPaths: readonly string[];
  locations: SkillDetailsLocation[];
}

/** Reads catalog-verified skill documents without accepting renderer paths. */
export class SkillDetailsReader {
  /** Reads the primary installed copy and lists every equivalent installation. */
  readInstalledSkill(
    skill: InstalledSkill,
    installedCatalog: readonly InstalledSkill[] = [skill]
  ): Promise<SkillDetails> {
    return this.readDocument({
      name: skill.name,
      directoryPath: skill.sourcePath,
      // Shared skill collections can expose a command through a manifest link
      // whose target lives under another skill directory in the same catalog.
      trustedDirectoryPaths: installedCatalog.flatMap((catalogSkill) =>
        catalogSkill.installations.map((installation) => installation.resolvedPath)
      ),
      locations: skill.installations.map((installation) => ({
        label: SKILL_ROOT_DISPLAY_NAMES[installation.root],
        path: installation.absolutePath
      }))
    });
  }

  /** Reads a skill from a repository checkout that the cache catalog already admitted. */
  readRepositorySkill(skill: CachedRepositorySkill): Promise<SkillDetails> {
    return this.readDocument({
      name: skill.name,
      directoryPath: skill.absolutePath,
      trustedDirectoryPaths: [skill.absolutePath],
      locations: [{ label: skill.source, path: skill.absolutePath }]
    });
  }

  /** Resolves and bounds the manifest before decoding it as renderer-safe text. */
  private async readDocument(source: SkillDocumentSource): Promise<SkillDetails> {
    const resolvedDirectoryPath = await realpath(source.directoryPath);
    const manifestPath = path.join(resolvedDirectoryPath, MANIFEST_FILE_NAME);
    const resolvedManifestPath = await realpath(manifestPath);
    const trustedDirectoryPaths = await this.resolveExistingDirectories([
      resolvedDirectoryPath,
      ...source.trustedDirectoryPaths
    ]);
    if (
      !trustedDirectoryPaths.some((directoryPath) =>
        this.contains(directoryPath, resolvedManifestPath)
      )
    ) {
      throw new Error(`${MANIFEST_FILE_NAME} escapes the cataloged skill directories.`);
    }

    const manifestStats = await lstat(resolvedManifestPath);
    if (!manifestStats.isFile()) {
      throw new Error(`${MANIFEST_FILE_NAME} must resolve to a regular file.`);
    }
    if (manifestStats.size > MAX_SKILL_DOCUMENT_BYTES) {
      throw new Error(`${MANIFEST_FILE_NAME} is larger than 1 MB.`);
    }

    const rawContent = (await readFile(resolvedManifestPath, 'utf8')).replace(/^\uFEFF/, '');
    return {
      name: source.name,
      content: this.readDisplayContent(rawContent),
      locations: source.locations
    };
  }

  /** Ignores a catalog directory that disappeared after the scan completed. */
  private async resolveExistingDirectories(directoryPaths: readonly string[]): Promise<string[]> {
    const resolvedPaths = await Promise.all(
      directoryPaths.map(async (directoryPath) => {
        try {
          return await realpath(directoryPath);
        } catch {
          return null;
        }
      })
    );
    return resolvedPaths.filter((directoryPath): directoryPath is string => directoryPath !== null);
  }

  /** Checks a resolved child path against one resolved catalog directory. */
  private contains(directoryPath: string, candidatePath: string): boolean {
    const relativePath = path.relative(directoryPath, candidatePath);
    return (
      relativePath === '' ||
      (!relativePath.startsWith(`..${path.sep}`) && relativePath !== '..' && !path.isAbsolute(relativePath))
    );
  }

  /** Hides YAML metadata already represented by the dialog title and source rows. */
  private readDisplayContent(rawContent: string): string {
    const lines = rawContent.split(/\r?\n/);
    const openingIndex = lines.findIndex((line) => line.trim().length > 0);
    if (openingIndex < 0 || lines[openingIndex]?.trim() !== '---') {
      return rawContent.trim();
    }

    const relativeClosingIndex = lines
      .slice(openingIndex + 1)
      .findIndex((line) => line.trim() === '---' || line.trim() === '...');
    if (relativeClosingIndex < 0) {
      return rawContent.trim();
    }

    const closingIndex = openingIndex + relativeClosingIndex + 1;
    const body = lines.slice(closingIndex + 1).join('\n').trim();
    return body.length > 0 ? body : rawContent.trim();
  }
}

export default SkillDetailsReader;
