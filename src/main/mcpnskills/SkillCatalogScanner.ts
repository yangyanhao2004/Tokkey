import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  type Dirent,
  type Stats
} from 'node:fs';
import path from 'node:path';
import type {
  InstalledSkill,
  SkillManifest,
  SkillRoot
} from '../../shared/types';
import {
  SkillDeduplicator,
  SKILL_ROOTS
} from './SkillDeduplicator';
import type { SkillContentHashing as SkillContentHashingType } from './SkillContentHasher';
import { SkillFilesystemLayout, type SkillFilesystemLayoutOptions } from './SkillFilesystem';

export { SkillDeduplicator, SKILL_ROOTS } from './SkillDeduplicator';
export { FileSkillContentHasher } from './SkillContentHasher';
export type { SkillContentHashing } from './SkillContentHasher';

/** Maximum namespace depth below a skill root. */
const MAX_SCAN_DEPTH = 3;
const MANIFEST_FILE_NAME = 'SKILL.md';

/** A filesystem identity after symlink resolution. */
export type SkillFileId = string;

/** One skill directory before same-name copies are deduplicated. */
export interface DiscoveredSkill {
  root: SkillRoot;
  pathComponents: string[];
  absolutePath: string;
  resolvedPath: string;
  isSymlink: boolean;
  fileId: SkillFileId | null;
  manifest: SkillManifest;
  name: string;
  relativePath: string;
}

/** Reads the small subset of SKILL.md frontmatter shown by the catalog. */
export class SkillManifestParser {
  static readonly manifestFileName = MANIFEST_FILE_NAME;

  /** Parses a skill folder, degrading unreadable or malformed manifests to empty data. */
  parseManifest(skillDirectoryPath: string): SkillManifest {
    const manifestPath = path.join(skillDirectoryPath, MANIFEST_FILE_NAME);
    try {
      return this.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
      return this.emptyManifest();
    }
  }

  /** Parses frontmatter without allowing a malformed manifest to hide a skill. */
  parse(manifestContents: string): SkillManifest {
    const normalizedContents = manifestContents.startsWith('\uFEFF')
      ? manifestContents.slice(1)
      : manifestContents;
    const lines = normalizedContents.split(/\r?\n/);
    const openingIndex = lines.findIndex((line) => line.trim().length > 0);
    if (openingIndex < 0 || lines[openingIndex].trim() !== '---') {
      return this.emptyManifest();
    }

    const closingIndex = lines.slice(openingIndex + 1).findIndex((line) => {
      const delimiter = line.trim();
      return delimiter === '---' || delimiter === '...';
    });
    if (closingIndex < 0) {
      return this.emptyManifest();
    }

    const frontmatterLines = lines.slice(openingIndex + 1, openingIndex + 1 + closingIndex);
    return this.parseFields(frontmatterLines);
  }

  /** Extracts name and description scalars while ignoring unrelated YAML fields. */
  private parseFields(lines: string[]): SkillManifest {
    let skillName: string | null = null;
    let skillDescription: string | null = null;
    let activeField: 'name' | 'description' | null = null;
    let blockValue: string[] = [];
    // Only a `|` or `>` description continues onto the following lines. Without
    // this, the indented values of any later key are read as more description.
    let isReadingBlockScalar = false;

    const flushBlockValue = (): void => {
      if (activeField === 'description' && blockValue.length > 0) {
        skillDescription = this.normalizeScalar(blockValue.join('\n'));
      }
      blockValue = [];
      isReadingBlockScalar = false;
    };

    for (const line of lines) {
      const fieldMatch = /^(name|description)\s*:\s*(.*)$/.exec(line);
      if (!fieldMatch) {
        if (isReadingBlockScalar && (line.trim().length === 0 || /^\s/.test(line))) {
          blockValue.push(line.trim());
          continue;
        }
        // Any other key at the top level ends the field being read.
        if (/^\S/.test(line)) {
          flushBlockValue();
          activeField = null;
        }
        continue;
      }

      flushBlockValue();
      activeField = fieldMatch[1] as 'name' | 'description';
      const rawValue = fieldMatch[2].trim();
      if (activeField === 'name') {
        skillName = rawValue === '|' || rawValue === '>' ? null : this.normalizeScalar(rawValue);
      } else if (rawValue === '|' || rawValue === '>') {
        blockValue = [];
        isReadingBlockScalar = true;
      } else {
        skillDescription = this.normalizeScalar(rawValue);
      }
    }
    flushBlockValue();
    return { skillName, skillDescription };
  }

  /** Normalizes quoted and scalar values into the strings the UI expects. */
  private normalizeScalar(rawValue: string): string | null {
    const trimmedValue = rawValue.trim();
    if (trimmedValue.length === 0) {
      return null;
    }

    const quote = trimmedValue[0];
    if (quote === '"' || quote === "'") {
      const closingQuoteIndex = this.findClosingQuote(trimmedValue, quote);
      if (closingQuoteIndex < 0) {
        return null;
      }
      const quotedValue = trimmedValue.slice(1, closingQuoteIndex).trim();
      // A quoted scalar escapes its own delimiter; the UI wants the plain text.
      return quotedValue.replace(/\\(["'\\])/g, '$1') || null;
    }

    const withoutComment = trimmedValue.replace(/\s+#.*$/, '').trim();
    return withoutComment || null;
  }

  /** Finds a quoted scalar's closing delimiter without treating escaped quotes as terminators. */
  private findClosingQuote(value: string, quote: '"' | "'"): number {
    for (let index = 1; index < value.length; index += 1) {
      if (value[index] !== quote || value[index - 1] === '\\') {
        continue;
      }
      return index;
    }
    return -1;
  }

  private emptyManifest(): SkillManifest {
    return { skillName: null, skillDescription: null };
  }
}

/** Walks one root and discovers manifest-bearing skill directories. */
export class SkillRootWalker {
  private readonly manifestParser: SkillManifestParser;

  constructor(manifestParser: SkillManifestParser = new SkillManifestParser()) {
    this.manifestParser = manifestParser;
  }

  /** Missing roots and unreadable entries are skipped so one agent cannot blank the catalog. */
  walk(root: SkillRoot, rootPath: string): DiscoveredSkill[] {
    if (!this.isDirectory(rootPath)) {
      return [];
    }
    return this.collectSkills(root, rootPath, [], 1);
  }

  /** Applies the namespace, dot-entry, and depth rules to one directory. */
  private collectSkills(
    root: SkillRoot,
    directoryPath: string,
    pathComponents: string[],
    depth: number
  ): DiscoveredSkill[] {
    if (depth > MAX_SCAN_DEPTH) {
      return [];
    }

    let entries: Dirent[];
    try {
      entries = readdirSync(directoryPath, { withFileTypes: true }).sort((left, right) =>
        left.name.localeCompare(right.name)
      );
    } catch {
      return [];
    }

    const discovered: DiscoveredSkill[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue;
      }

      const entryPath = path.join(directoryPath, entry.name);
      if (!this.isDirectory(entryPath)) {
        continue;
      }

      const childComponents = [...pathComponents, entry.name];
      if (!this.hasManifest(entryPath)) {
        discovered.push(...this.collectSkills(root, entryPath, childComponents, depth + 1));
        continue;
      }

      discovered.push(this.makeDiscoveredSkill(root, entryPath, childComponents));
    }
    return discovered;
  }

  /** Builds the complete serializable discovery record for one folder. */
  private makeDiscoveredSkill(
    root: SkillRoot,
    absolutePath: string,
    pathComponents: string[]
  ): DiscoveredSkill {
    const resolvedPath = this.resolvePath(absolutePath);
    return {
      root,
      pathComponents,
      absolutePath: path.normalize(absolutePath),
      resolvedPath,
      isSymlink: this.isSymlink(absolutePath),
      fileId: this.fileId(resolvedPath),
      manifest: this.manifestParser.parseManifest(absolutePath),
      name: pathComponents[pathComponents.length - 1] ?? '',
      // Catalog paths are stable identifiers, so keep their separator platform-neutral.
      relativePath: pathComponents.join('/')
    };
  }

  /** A manifest marker follows symlinks, matching the Swift scanner's rule. */
  private hasManifest(directoryPath: string): boolean {
    try {
      return statSync(path.join(directoryPath, MANIFEST_FILE_NAME)).isFile();
    } catch {
      return false;
    }
  }

  /** Directory checks follow links so linked skill folders and roots are included. */
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

  /** Resolves links before statting, collapsing linked roots and folders together. */
  private resolvePath(candidatePath: string): string {
    try {
      return realpathSync(candidatePath);
    } catch {
      return path.resolve(candidatePath);
    }
  }

  /** Returns a device/inode key, or null when a target cannot be statted. */
  private fileId(resolvedPath: string): SkillFileId | null {
    try {
      const stats: Stats = statSync(resolvedPath);
      return `${stats.dev}:${stats.ino}`;
    } catch {
      return null;
    }
  }
}

export interface LocalSkillCatalogScannerOptions {
  homeDirectory?: SkillFilesystemLayoutOptions['homeDirectory'];
  rootOverrides?: SkillFilesystemLayoutOptions['rootOverrides'];
  filesystem?: SkillFilesystemLayout;
  walker?: SkillRootWalker;
  contentHasher?: SkillContentHashingType;
}

/** Filesystem-backed scanner used by the main process to list installed skills. */
export class LocalSkillCatalogScanner {
  private readonly filesystem: SkillFilesystemLayout;
  private readonly walker: SkillRootWalker;
  private readonly deduplicator: SkillDeduplicator;

  constructor(options: LocalSkillCatalogScannerOptions = {}) {
    this.filesystem = options.filesystem ?? new SkillFilesystemLayout(options);
    this.walker = options.walker ?? new SkillRootWalker();
    this.deduplicator = new SkillDeduplicator(options.contentHasher);
  }

  /** Scans all roots in priority order and returns one object per deduplicated skill. */
  async scanInstalledSkills(): Promise<InstalledSkill[]> {
    const discovered = SKILL_ROOTS.flatMap((root) =>
      this.walker.walk(root, this.filesystem.getRootPath(root))
    );
    return this.deduplicator.deduplicate(discovered);
  }

  /** Exposes the shared path layout to filesystem-backed skill operations. */
  getFilesystem(): SkillFilesystemLayout {
    return this.filesystem;
  }
}

/** Compatibility name matching the directory workflow vocabulary. */
export class InstalledSkillCatalog extends LocalSkillCatalogScanner {}

export default LocalSkillCatalogScanner;
