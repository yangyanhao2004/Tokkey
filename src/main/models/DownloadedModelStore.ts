import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { InstalledLocalModel, LocalModelDescriptor } from '../../shared/types';

/** Written beside the artifact so an installed model can be described offline. */
const MANIFEST_FILE_NAME = 'model.json';
const GGUF_EXTENSION = '.gguf';
const DISCOVERED_MODEL_ID_PREFIX = 'local-file:';

interface MeasuredArtifact {
  filePath: string;
  sizeBytes: number;
  modifiedAt: number;
}

interface ModelTreeScan {
  artifactPaths: string[];
  manifestDirectories: string[];
}

interface LocatedManifest {
  directory: string;
  model: InstalledLocalModel;
}

/**
 * Owns `~/.amiswifi/models`: where a model's bytes land, whether they are all
 * there, and how to describe what is on disk without the remote catalog.
 *
 * The Tokkey page lists installed models on launch, long before — and often
 * without — a catalog fetch, so a completed download leaves a manifest next to
 * its artifact. Hand-placed GGUF files count too, wherever they are nested
 * under the models root.
 */
export class DownloadedModelStore {
  readonly root: string;

  constructor(options: { homeDirectory?: string } = {}) {
    this.root = path.join(options.homeDirectory ?? os.homedir(), '.amiswifi', 'models');
  }

  /** The folder one model owns; every file it downloads stays inside it. */
  directoryFor(modelId: string): string {
    return path.join(this.root, this.safeId(modelId));
  }

  /** Where a descriptor's artifact is saved, with its catalog file name sanitized. */
  fileFor(descriptor: LocalModelDescriptor): string {
    return path.join(this.directoryFor(descriptor.id), this.safeRelativePath(descriptor.fileName));
  }

  /** Creates the models root so free space can be probed on the right volume. */
  async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  /** True when the artifact is present and not empty. Says nothing about resume state. */
  async hasArtifact(descriptor: LocalModelDescriptor): Promise<boolean> {
    return (await this.artifactSize(descriptor)) !== null;
  }

  /** Records what was downloaded, so the model can be listed without the catalog. */
  async writeManifest(descriptor: LocalModelDescriptor): Promise<void> {
    const sizeBytes = await this.artifactSize(descriptor);
    if (sizeBytes === null) return;
    const manifest: InstalledLocalModel = {
      id: descriptor.id,
      name: descriptor.name,
      provider: descriptor.provider,
      series: descriptor.series,
      fileName: descriptor.fileName,
      sizeBytes,
      downloadedAt: Date.now(),
      filePath: this.fileFor(descriptor)
    };
    await mkdir(this.directoryFor(descriptor.id), { recursive: true });
    await writeFile(path.join(this.directoryFor(descriptor.id), MANIFEST_FILE_NAME), JSON.stringify(manifest), 'utf8');
  }

  /** Drops a downloaded folder, or just the hand-placed GGUF that was discovered. */
  async remove(modelId: string): Promise<void> {
    if (modelId.startsWith(DISCOVERED_MODEL_ID_PREFIX)) {
      const discoveredFilePath = this.filePathForDiscoveredId(modelId);
      if (discoveredFilePath) await rm(discoveredFilePath, { force: true });
      return;
    }
    await rm(this.directoryFor(modelId), { recursive: true, force: true });
  }

  /**
   * Every model whose artifact is still on disk, newest download first.
   *
   * Every non-empty GGUF under the root counts as installed, including files at
   * the root itself and files nested more than one directory deep. A matching
   * manifest supplies catalog metadata; otherwise the file describes itself.
   */
  async listInstalled(): Promise<InstalledLocalModel[]> {
    const scan = await this.scanModelTree(this.root);
    const [measuredArtifacts, manifests] = await Promise.all([
      Promise.all(scan.artifactPaths.map((filePath) => this.measure(filePath))),
      Promise.all(scan.manifestDirectories.map((directory) => this.readLocatedManifest(directory)))
    ]);
    const validManifests = manifests.filter((manifest): manifest is LocatedManifest => manifest !== null);

    return measuredArtifacts
      .filter((artifact): artifact is MeasuredArtifact => artifact !== null)
      .map((artifact) => this.describeArtifact(artifact, validManifests))
      .sort((left, right) => right.downloadedAt - left.downloadedAt || left.name.localeCompare(right.name));
  }

  private async scanModelTree(directory: string): Promise<ModelTreeScan> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      // A missing root or an unreadable nested directory contributes no models.
      return { artifactPaths: [], manifestDirectories: [] };
    }

    const childScans = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => this.scanModelTree(path.join(directory, entry.name)))
    );
    const artifactPaths = entries
      .filter((entry) => !entry.isDirectory() && path.extname(entry.name).toLowerCase() === GGUF_EXTENSION)
      .map((entry) => path.join(directory, entry.name));
    const hasManifest = entries.some((entry) => entry.isFile() && entry.name === MANIFEST_FILE_NAME);

    return {
      artifactPaths: [...artifactPaths, ...childScans.flatMap((scan) => scan.artifactPaths)],
      manifestDirectories: [
        ...(hasManifest ? [directory] : []),
        ...childScans.flatMap((scan) => scan.manifestDirectories)
      ]
    };
  }

  private async readLocatedManifest(directory: string): Promise<LocatedManifest | null> {
    try {
      const model = JSON.parse(await readFile(path.join(directory, MANIFEST_FILE_NAME), 'utf8')) as InstalledLocalModel;
      return typeof model?.id === 'string' && typeof model.name === 'string'
        ? { directory, model }
        : null;
    } catch {
      return null;
    }
  }

  private describeArtifact(artifact: MeasuredArtifact, manifests: LocatedManifest[]): InstalledLocalModel {
    const locatedManifest = manifests.find(({ directory, model }) => {
      if (typeof model.filePath !== 'string') return false;
      const manifestFilePath = path.isAbsolute(model.filePath)
        ? model.filePath
        : path.resolve(directory, model.filePath);
      return path.resolve(manifestFilePath) === path.resolve(artifact.filePath);
    });
    if (locatedManifest) {
      return {
        ...locatedManifest.model,
        filePath: artifact.filePath,
        sizeBytes: artifact.sizeBytes
      };
    }

    const fileName = path.basename(artifact.filePath);
    return {
      id: this.discoveredIdFor(artifact.filePath),
      name: fileName,
      provider: 'Local',
      series: '',
      fileName,
      sizeBytes: artifact.sizeBytes,
      downloadedAt: artifact.modifiedAt,
      filePath: artifact.filePath
    };
  }

  private async measure(filePath: string): Promise<MeasuredArtifact | null> {
    try {
      const metadata = await stat(filePath);
      return metadata.isFile() && metadata.size > 0
        ? { filePath, sizeBytes: metadata.size, modifiedAt: metadata.mtimeMs }
        : null;
    } catch {
      return null;
    }
  }

  private async artifactSize(descriptor: LocalModelDescriptor): Promise<number | null> {
    try {
      const metadata = await stat(this.fileFor(descriptor));
      return metadata.isFile() && metadata.size > 0 ? metadata.size : null;
    } catch {
      return null;
    }
  }

  /** Catalog ids carry colons and slashes; a folder name may not. */
  private safeId(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]+/g, '_');
  }

  /** Keeps a catalog file name from escaping the model's own directory. */
  private safeRelativePath(value: string): string {
    const parts = value.split(/[\\/]+/).filter((part) => part.length > 0 && part !== '.' && part !== '..');
    return parts.map((part) => part.replace(/[^a-zA-Z0-9._-]+/g, '_')).join(path.sep) || 'model.bin';
  }

  private discoveredIdFor(filePath: string): string {
    const relativePath = path.relative(this.root, filePath).split(path.sep).join('/');
    return `${DISCOVERED_MODEL_ID_PREFIX}${encodeURIComponent(relativePath)}`;
  }

  private filePathForDiscoveredId(modelId: string): string | null {
    try {
      const encodedRelativePath = modelId.slice(DISCOVERED_MODEL_ID_PREFIX.length);
      const relativePath = decodeURIComponent(encodedRelativePath).split('/').join(path.sep);
      const filePath = path.resolve(this.root, relativePath);
      const pathFromRoot = path.relative(this.root, filePath);
      const isInsideRoot = pathFromRoot.length > 0 && !pathFromRoot.startsWith(`..${path.sep}`) && !path.isAbsolute(pathFromRoot);
      return isInsideRoot && path.extname(filePath).toLowerCase() === GGUF_EXTENSION ? filePath : null;
    } catch {
      return null;
    }
  }
}

export default DownloadedModelStore;
