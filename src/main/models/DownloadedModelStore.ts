import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { InstalledLocalModel, LocalModelDescriptor } from '../../shared/types';

/** Written beside the artifact so an installed model can be described offline. */
const MANIFEST_FILE_NAME = 'model.json';

/**
 * Owns `~/.amiswifi/models`: where a model's bytes land, whether they are all
 * there, and how to describe what is on disk without the remote catalog.
 *
 * The Tokiie page lists installed models on launch, long before — and often
 * without — a catalog fetch, so a completed download leaves a manifest next to
 * its artifact. The directory is then the whole truth: a model exists here
 * exactly when its folder holds both the manifest and a non-empty file.
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

  /** Drops a model's folder, manifest and artifact together. */
  async remove(modelId: string): Promise<void> {
    await rm(this.directoryFor(modelId), { recursive: true, force: true });
  }

  /**
   * Every model whose artifact is still on disk, newest download first.
   *
   * A folder holding a non-empty file counts as installed even when its
   * manifest is missing, so models fetched before manifests existed — or
   * dropped in by hand — are still listed. A folder whose artifact was deleted
   * from Finder is skipped: the list has to match what can actually be started.
   */
  async listInstalled(): Promise<InstalledLocalModel[]> {
    const described = await Promise.all(
      (await this.readModelDirectories()).map((directory) => this.describeDirectory(directory))
    );
    return described
      .filter((model): model is InstalledLocalModel => model !== null)
      .sort((left, right) => right.downloadedAt - left.downloadedAt || left.name.localeCompare(right.name));
  }

  private async readModelDirectories(): Promise<string[]> {
    try {
      const entries = await readdir(this.root, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(this.root, entry.name));
    } catch {
      // No models root yet is the normal state before the first download.
      return [];
    }
  }

  private async describeDirectory(directory: string): Promise<InstalledLocalModel | null> {
    const manifest = await this.readManifest(directory);
    const artifact = await this.findArtifact(directory, manifest?.filePath);
    if (!artifact) return null;
    if (manifest) return { ...manifest, filePath: artifact.filePath, sizeBytes: artifact.sizeBytes };
    return {
      id: path.basename(directory),
      name: path.basename(artifact.filePath),
      provider: 'Local',
      series: '',
      fileName: path.basename(artifact.filePath),
      sizeBytes: artifact.sizeBytes,
      downloadedAt: artifact.modifiedAt,
      filePath: artifact.filePath
    };
  }

  private async readManifest(directory: string): Promise<InstalledLocalModel | null> {
    try {
      const manifest = JSON.parse(await readFile(path.join(directory, MANIFEST_FILE_NAME), 'utf8')) as InstalledLocalModel;
      return typeof manifest?.id === 'string' && typeof manifest.name === 'string' ? manifest : null;
    } catch {
      return null;
    }
  }

  /**
   * The manifest's own path when it still resolves, otherwise the largest file
   * in the folder — the artifact, next to whatever small sidecars sit with it.
   */
  private async findArtifact(
    directory: string,
    manifestPath?: string
  ): Promise<{ filePath: string; sizeBytes: number; modifiedAt: number } | null> {
    const candidates = manifestPath ? [manifestPath] : [];
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      entries
        .filter((entry) => entry.isFile() && entry.name !== MANIFEST_FILE_NAME)
        .forEach((entry) => candidates.push(path.join(directory, entry.name)));
    } catch {
      return null;
    }
    const measured = await Promise.all(candidates.map((filePath) => this.measure(filePath)));
    return measured
      .filter((file): file is { filePath: string; sizeBytes: number; modifiedAt: number } => file !== null)
      .sort((left, right) => right.sizeBytes - left.sizeBytes)[0] ?? null;
  }

  private async measure(filePath: string): Promise<{ filePath: string; sizeBytes: number; modifiedAt: number } | null> {
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
}

export default DownloadedModelStore;
