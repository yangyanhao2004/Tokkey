import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { statfs } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { session, type DownloadItem, type Session } from 'electron';
import type {
  LocalModelCapability,
  LocalModelDescriptor,
  LocalModelLifecycle,
  LocalModelRow
} from '../../shared/types';

interface PersistedDownload {
  modelId: string;
  path: string;
  urlChain: string[];
  offset: number;
  length: number;
  lastModified: string;
  eTag: string;
  startTime: number;
}

interface RuntimeEntry {
  descriptor: LocalModelDescriptor;
  item: DownloadItem | null;
  sourceUrls: string[];
  sourceIndex: number;
  progress: number | null;
  state: LocalModelLifecycle;
  error: string | null;
  endpoint: string | null;
}

type ModelStateListener = () => void;

/** Owns Electron DownloadItems and projects them into model lifecycle rows. */
export class NativeModelDownloadManager {
  private readonly modelsRoot: string;
  private readonly persistencePath: string;
  private readonly entries = new Map<string, RuntimeEntry>();
  private readonly pendingUrls = new Map<string, string>();
  private readonly persisted = new Map<string, PersistedDownload>();
  private readonly persistenceReady: Promise<void>;
  private session: Session | null = null;
  private stateListener: ModelStateListener | null = null;

  constructor(options: { homeDirectory?: string; stateListener?: ModelStateListener } = {}) {
    const homeDirectory = options.homeDirectory ?? os.homedir();
    this.modelsRoot = path.join(homeDirectory, '.amiswifi', 'models');
    this.persistencePath = path.join(homeDirectory, '.amiswifi', 'model_downloads.json');
    this.stateListener = options.stateListener ?? null;
    this.persistenceReady = this.readPersistedDownloads();
  }

  /** Attaches the app session once Electron is ready. */
  attachDownloadSession(downloadSession: Session = session.defaultSession): void {
    if (this.session) return;
    this.session = downloadSession;
    this.session.on('will-download', (_event, item) => this.handleWillDownload(item));
  }

  /** Creates a native download; Chromium owns transfer, buffering, and resume. */
  async startDownload(descriptor: LocalModelDescriptor, capability: LocalModelCapability): Promise<void> {
    await this.persistenceReady;
    if (!this.session) throw new Error('Download session is not ready.');
    const existing = this.entries.get(descriptor.id);
    if (existing?.state === 'downloading') return;
    if (!descriptor.downloadable) throw new Error(descriptor.sourceError ?? 'Model has no download source.');
    if (descriptor.sizeBytes !== null && capability.freeDiskBytes !== null && descriptor.sizeBytes > capability.freeDiskBytes) {
      throw new Error('Not enough free disk space for this model.');
    }
    const persisted = this.persisted.get(descriptor.id);
    const sourceUrl = this.selectSource(descriptor);
    const sourceUrls = [descriptor.huggingFaceUrl, descriptor.modelScopeUrl].filter((url): url is string => Boolean(url));
    const entry: RuntimeEntry = {
      descriptor,
      item: null,
      sourceUrls,
      sourceIndex: Math.max(0, sourceUrls.indexOf(sourceUrl)),
      progress: 0,
      state: 'downloading',
      error: null,
      endpoint: null
    };
    this.entries.set(descriptor.id, entry);
    this.pendingUrls.set(sourceUrl, descriptor.id);
    if (persisted && persisted.urlChain.length > 0) {
      this.session.createInterruptedDownload({
        path: persisted.path,
        urlChain: persisted.urlChain,
        offset: persisted.offset,
        length: persisted.length,
        lastModified: persisted.lastModified,
        eTag: persisted.eTag,
        startTime: persisted.startTime
      });
      return;
    }
    this.session.downloadURL(sourceUrl);
  }

  /** Cancels a native item and removes its saved model directory. */
  async cancelDownload(modelId: string): Promise<void> {
    await this.persistenceReady;
    const entry = this.entries.get(modelId);
    entry?.item?.cancel();
    await rm(path.join(this.modelsRoot, this.safeId(modelId)), { recursive: true, force: true });
    this.persisted.delete(modelId);
    await this.writePersistedDownloads();
    if (entry) {
      entry.item = null;
      entry.progress = null;
      entry.state = 'downloadable';
      entry.error = null;
    }
    this.notify();
  }

  /** Deletes a downloaded model and removes its lifecycle entry. */
  async deleteModel(modelId: string): Promise<void> {
    await this.persistenceReady;
    const entry = this.entries.get(modelId);
    entry?.item?.cancel();
    await rm(path.join(this.modelsRoot, this.safeId(modelId)), { recursive: true, force: true });
    this.entries.delete(modelId);
    this.persisted.delete(modelId);
    await this.writePersistedDownloads();
    this.notify();
  }

  /** Projects all known descriptors into UI-ready lifecycle rows. */
  async projectRows(descriptors: LocalModelDescriptor[], capability: LocalModelCapability): Promise<LocalModelRow[]> {
    const rows = await Promise.all(descriptors.map(async (descriptor) => {
      const entry = this.entries.get(descriptor.id);
      const downloaded = await this.isDownloaded(descriptor);
      const isTargetSupported = descriptor.downloadable && (descriptor.sizeBytes === null || capability.freeDiskBytes === null || descriptor.sizeBytes <= capability.freeDiskBytes);
      let lifecycle: LocalModelLifecycle = entry?.state ?? 'downloadable';
      if (entry?.state !== 'downloading' && entry?.state !== 'downloadFailed' && entry?.state !== 'deployed' && entry?.state !== 'deployPreparing' && entry?.state !== 'deployStopping' && entry?.state !== 'deployFailed') {
        lifecycle = downloaded ? 'downloaded' : descriptor.downloadable ? (isTargetSupported ? 'downloadable' : 'unsupported') : 'unsupported';
      }
      return {
        ...descriptor,
        lifecycle,
        progress: entry?.progress ?? (downloaded ? 1 : null),
        error: entry?.error ?? descriptor.sourceError,
        endpoint: entry?.endpoint ?? null,
        isTargetSupported
      };
    }));
    return rows.sort((left, right) => Number(right.lifecycle !== 'unsupported') - Number(left.lifecycle !== 'unsupported') || left.name.localeCompare(right.name));
  }

  /** Marks a downloaded model as running without pretending to start a server. */
  async deployModel(descriptor: LocalModelDescriptor): Promise<void> {
    if (!(await this.isDownloaded(descriptor))) throw new Error('Download the model before deploying it.');
    const entry = this.entries.get(descriptor.id) ?? {
      descriptor,
      item: null,
      sourceUrls: [descriptor.huggingFaceUrl, descriptor.modelScopeUrl].filter((url): url is string => Boolean(url)),
      sourceIndex: 0,
      progress: 1,
      state: 'downloaded' as LocalModelLifecycle,
      error: null,
      endpoint: null
    };
    entry.state = 'deployPreparing';
    this.entries.set(descriptor.id, entry);
    this.notify();
    // Server integration is intentionally a separate target concern; keep the state explicit until it exists.
    entry.state = 'deployed';
    entry.endpoint = `local://${this.safeId(descriptor.id)}`;
    this.notify();
  }

  setStateListener(listener: ModelStateListener | null): void {
    this.stateListener = listener;
  }

  async capability(): Promise<LocalModelCapability> {
    let freeDiskBytes: number | null = null;
    try {
      await mkdir(this.modelsRoot, { recursive: true });
      const filesystem = await statfs(this.modelsRoot);
      freeDiskBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
    } catch {
      freeDiskBytes = null;
    }
    return { target: 'mac', freeDiskBytes, totalRamBytes: os.totalmem(), platform: process.platform };
  }

  private handleWillDownload(item: DownloadItem): void {
    const sourceUrl = item.getURL();
    const modelId = this.pendingUrls.get(sourceUrl) ?? [...this.pendingUrls.entries()].find(([url]) => sourceUrl.startsWith(url))?.[1];
    if (!modelId) return;
    this.pendingUrls.delete(sourceUrl);
    const entry = this.entries.get(modelId);
    if (!entry) return;
    const modelDirectory = path.join(this.modelsRoot, this.safeId(modelId));
    const destination = path.join(modelDirectory, this.safeRelativePath(entry.descriptor.fileName));
    item.setSavePath(destination);
    entry.item = item;
    item.on('updated', (_event, state) => {
      const total = item.getTotalBytes();
      entry.progress = total > 0 ? Math.min(1, item.getReceivedBytes() / total) : null;
      entry.state = state === 'interrupted' ? 'downloadFailed' : 'downloading';
      entry.error = state === 'interrupted' ? 'Download interrupted. Retry to resume.' : null;
      void this.persistItem(modelId, item);
      this.notify();
    });
    item.once('done', (_event, state) => {
      entry.item = null;
      if (state === 'completed') {
        entry.state = 'downloaded';
        entry.progress = 1;
        entry.error = null;
        this.persisted.delete(modelId);
      } else if (state === 'cancelled') {
        entry.state = 'downloadable';
        entry.progress = null;
      } else {
        const fallbackUrl = entry.sourceUrls[entry.sourceIndex + 1];
        if (fallbackUrl && this.session) {
          entry.sourceIndex += 1;
          entry.state = 'downloading';
          entry.error = 'Primary source interrupted; trying the alternate source.';
          this.pendingUrls.set(fallbackUrl, modelId);
          this.session.downloadURL(fallbackUrl);
        } else {
          entry.state = 'downloadFailed';
          entry.error = 'Download interrupted. Retry to resume.';
          void this.persistItem(modelId, item);
        }
      }
      void this.writePersistedDownloads();
      this.notify();
    });
    if (item.getState() === 'interrupted') item.resume();
    this.notify();
  }

  private async isDownloaded(descriptor: LocalModelDescriptor): Promise<boolean> {
    try {
      const metadata = await stat(path.join(this.modelsRoot, this.safeId(descriptor.id), this.safeRelativePath(descriptor.fileName)));
      return metadata.isFile() && (descriptor.sizeBytes === null || metadata.size === descriptor.sizeBytes);
    } catch {
      return false;
    }
  }

  private async persistItem(modelId: string, item: DownloadItem): Promise<void> {
    this.persisted.set(modelId, {
      modelId,
      path: item.getSavePath(),
      urlChain: item.getURLChain(),
      offset: item.getReceivedBytes(),
      length: item.getTotalBytes(),
      lastModified: item.getLastModifiedTime(),
      eTag: item.getETag(),
      startTime: item.getStartTime()
    });
    await this.writePersistedDownloads();
  }

  private async readPersistedDownloads(): Promise<void> {
    try {
      const values = JSON.parse(await readFile(this.persistencePath, 'utf8')) as PersistedDownload[];
      if (!Array.isArray(values)) return;
      values.forEach((value) => {
        if (value && typeof value.modelId === 'string' && Array.isArray(value.urlChain)) this.persisted.set(value.modelId, value);
      });
    } catch {
      // A missing persistence file is the normal first-launch state.
    }
  }

  private async writePersistedDownloads(): Promise<void> {
    await mkdir(path.dirname(this.persistencePath), { recursive: true });
    await writeFile(this.persistencePath, JSON.stringify([...this.persisted.values()]), 'utf8');
  }

  private selectSource(descriptor: LocalModelDescriptor): string {
    if (descriptor.huggingFaceUrl) return descriptor.huggingFaceUrl;
    if (descriptor.modelScopeUrl) return descriptor.modelScopeUrl;
    throw new Error('Model has no download source.');
  }

  private safeId(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]+/g, '_');
  }

  private safeRelativePath(value: string): string {
    const parts = value.split(/[\\/]+/).filter((part) => part.length > 0 && part !== '.' && part !== '..');
    return parts.map((part) => part.replace(/[^a-zA-Z0-9._-]+/g, '_')).join(path.sep) || 'model.bin';
  }

  private notify(): void {
    this.stateListener?.();
  }
}

export default NativeModelDownloadManager;
