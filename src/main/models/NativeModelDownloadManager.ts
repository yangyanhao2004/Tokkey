import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { session, type DownloadItem, type Session } from 'electron';
import type {
  InstalledLocalModel,
  LocalModelCapability,
  LocalModelDescriptor,
  LocalModelLifecycle,
  LocalModelRow
} from '../../shared/types';
import HostDiskProbe from '../host/HostDiskProbe';
import DownloadedModelStore from './DownloadedModelStore';

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
  private readonly store: DownloadedModelStore;
  private readonly persistencePath: string;
  private readonly entries = new Map<string, RuntimeEntry>();
  private readonly pendingUrls = new Map<string, string>();
  private readonly persisted = new Map<string, PersistedDownload>();
  private readonly persistenceReady: Promise<void>;
  private readonly diskProbe: HostDiskProbe;
  private session: Session | null = null;
  private stateListener: ModelStateListener | null = null;

  constructor(options: {
    homeDirectory?: string;
    stateListener?: ModelStateListener;
    diskProbe?: HostDiskProbe;
    store?: DownloadedModelStore;
  } = {}) {
    const homeDirectory = options.homeDirectory ?? os.homedir();
    this.store = options.store ?? new DownloadedModelStore({ homeDirectory });
    this.persistencePath = path.join(homeDirectory, '.amiswifi', 'model_downloads.json');
    this.stateListener = options.stateListener ?? null;
    this.diskProbe = options.diskProbe ?? new HostDiskProbe();
    this.persistenceReady = this.readPersistedDownloads();
  }

  /**
   * Everything already on disk, for the Tokiie page's installed list.
   *
   * A resumed transfer grows the artifact in place — `createInterruptedDownload`
   * is handed the final path — so a partial file can look exactly like a
   * finished one. A saved resume point is what tells the two apart, and a model
   * that still has one is left out.
   */
  async listInstalled(): Promise<InstalledLocalModel[]> {
    await this.persistenceReady;
    const unfinished = new Set([...this.persisted.keys()].map((modelId) => this.safeId(modelId)));
    const installed = await this.store.listInstalled();
    return installed.filter((model) => !unfinished.has(this.safeId(model.id)));
  }

  /** Deletes a downloaded model and answers with the list that survived it. */
  async removeInstalled(modelId: string): Promise<InstalledLocalModel[]> {
    await this.deleteModel(modelId);
    return this.listInstalled();
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
    await this.store.remove(modelId);
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
    await this.store.remove(modelId);
    this.entries.delete(modelId);
    this.persisted.delete(modelId);
    await this.writePersistedDownloads();
    this.notify();
  }

  /** Projects all known descriptors into UI-ready lifecycle rows. */
  async projectRows(descriptors: LocalModelDescriptor[], capability: LocalModelCapability): Promise<LocalModelRow[]> {
    // Saved resume points decide what counts as downloaded, so the first scan
    // after launch has to wait for them rather than read an empty map.
    await this.persistenceReady;
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
    return rows.sort((left, right) =>
      NativeModelDownloadManager.recommendationRank(left, capability) -
        NativeModelDownloadManager.recommendationRank(right, capability) ||
      left.name.localeCompare(right.name));
  }

  /**
   * "Recommended for this Mac" has to be true of the order, not just the
   * heading: models this machine has the memory to run come first, then the
   * ones it would have to swap for, then the ones it cannot fetch at all.
   */
  private static recommendationRank(row: LocalModelRow, capability: LocalModelCapability): number {
    if (row.lifecycle === 'unsupported') return 2;
    const fitsMemory =
      row.requiredRamBytes === null ||
      capability.totalRamBytes === null ||
      row.requiredRamBytes <= capability.totalRamBytes;
    return fitsMemory ? 0 : 1;
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

  /**
   * What this Mac can take. Free space comes from the same probe as the "This
   * Mac" card's disk gauge, so the page never quotes two different figures for
   * one volume: a bare `statfs` omits purgeable data — local snapshots and
   * evictable caches, tens of GB on a typical Mac — and gating a download on
   * that would refuse models the volume can really hold.
   */
  async capability(): Promise<LocalModelCapability> {
    let freeDiskBytes: number | null = null;
    try {
      // The models directory is on the boot data volume the probe reads.
      await this.store.ensureRoot();
      freeDiskBytes = (await this.diskProbe.read()).free;
    } catch (error) {
      console.error('[NativeModelDownloadManager] Free space read failed:', error);
    }
    return { target: 'mac', freeDiskBytes, totalRamBytes: os.totalmem(), platform: process.platform };
  }

  /**
   * Claims a session download for the model that requested it: pins the save
   * path under the models store, mirrors progress into the entry, and on an
   * interrupted transfer retries the next mirror in `sourceUrls`.
   */
  private handleWillDownload(item: DownloadItem): void {
    const claimed = this.claimPendingDownload(item);
    if (!claimed) return;
    const { modelId } = claimed;
    const entry = this.entries.get(modelId);
    if (!entry) return;
    item.setSavePath(this.store.fileFor(entry.descriptor));
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
        // The manifest is what lets the Tokiie page name this model offline.
        void this.store.writeManifest(entry.descriptor);
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

  /**
   * Matches a session download back to the model that asked for it.
   *
   * The whole redirect chain has to be searched, not `getURL()`: Hugging Face
   * and ModelScope both hand a GGUF off to a signed CDN URL on another host, and
   * by the time the item exists `getURL()` is that final URL, which shares
   * nothing with the catalog address the download was started from. The chain
   * still begins with the requested URL.
   *
   * A prefix match is accepted too, for a mirror that appends query parameters
   * of its own to the address it was given.
   */
  private claimPendingDownload(item: DownloadItem): { modelId: string } | null {
    const urlChain = [...item.getURLChain(), item.getURL()];
    const match = [...this.pendingUrls.entries()].find(([pendingUrl]) =>
      urlChain.some((url) => url === pendingUrl || url.startsWith(pendingUrl)));
    if (!match) return null;
    const [pendingUrl, modelId] = match;
    this.pendingUrls.delete(pendingUrl);
    return { modelId };
  }

  /**
   * A file on disk counts as downloaded unless a resume point is still saved
   * for it, which is exactly the state an unfinished transfer leaves behind.
   *
   * The catalog's declared size cannot be used for this: it arrives as a `*Gb`
   * figure rounded to two decimals, so a completed file almost never matches it
   * byte for byte and every downloaded model would offer "Download" again.
   */
  private async isDownloaded(descriptor: LocalModelDescriptor): Promise<boolean> {
    if (this.persisted.has(descriptor.id)) return false;
    return this.store.hasArtifact(descriptor);
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

  private notify(): void {
    this.stateListener?.();
  }
}

export default NativeModelDownloadManager;
