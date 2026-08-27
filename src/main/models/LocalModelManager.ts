import type {
  InstalledLocalModel,
  LocalModelCatalogRequest,
  LocalModelCatalogScan,
  LocalModelDescriptor,
  LocalModelProvider
} from '../../shared/types';
import LocalModelCatalogService from './LocalModelCatalogService';
import NativeModelDownloadManager from './NativeModelDownloadManager';

/** Coordinates catalog freshness, target capability, and model lifecycle actions. */
export class LocalModelManager {
  private readonly catalog: LocalModelCatalogService;
  private readonly downloader: NativeModelDownloadManager;
  private descriptors: LocalModelDescriptor[] = [];
  private providers: string[] = [];

  constructor(options: {
    catalog?: LocalModelCatalogService;
    downloader?: NativeModelDownloadManager;
  } = {}) {
    this.catalog = options.catalog ?? new LocalModelCatalogService();
    this.downloader = options.downloader ?? new NativeModelDownloadManager();
  }

  /** Hooks Electron's native download event; call after app readiness. */
  attachDownloadSession(): void {
    this.downloader.attachDownloadSession();
  }

  async list(request: LocalModelCatalogRequest = {}, forceRefresh = false): Promise<LocalModelCatalogScan> {
    const loaded = await this.catalog.load(forceRefresh);
    this.descriptors = loaded.models;
    this.providers = loaded.providers;
    return this.scan(request);
  }

  async refresh(request: LocalModelCatalogRequest = {}): Promise<LocalModelCatalogScan> {
    return this.list(request, true);
  }

  async startDownload(modelId: string, request: LocalModelCatalogRequest = {}): Promise<LocalModelCatalogScan> {
    await this.ensureCatalog(request);
    const descriptor = this.requireDescriptor(modelId);
    await this.downloader.startDownload(descriptor, await this.downloader.capability());
    return this.scan(request);
  }

  async cancelDownload(modelId: string, request: LocalModelCatalogRequest = {}): Promise<LocalModelCatalogScan> {
    await this.ensureCatalog(request);
    await this.downloader.cancelDownload(modelId);
    return this.scan(request);
  }

  async deleteModel(modelId: string, request: LocalModelCatalogRequest = {}): Promise<LocalModelCatalogScan> {
    await this.ensureCatalog(request);
    await this.downloader.deleteModel(modelId);
    return this.scan(request);
  }

  async deployModel(modelId: string, request: LocalModelCatalogRequest = {}): Promise<LocalModelCatalogScan> {
    await this.ensureCatalog(request);
    await this.downloader.deployModel(this.requireDescriptor(modelId));
    return this.scan(request);
  }

  /**
   * What is on disk right now. Deliberately never touches the remote catalog:
   * the Tokiie page opens on launch and must list installed models offline.
   */
  listInstalled(): Promise<InstalledLocalModel[]> {
    return this.downloader.listInstalled();
  }

  /** Removes a downloaded model and answers with the remaining installed list. */
  removeInstalled(modelId: string): Promise<InstalledLocalModel[]> {
    return this.downloader.removeInstalled(modelId);
  }

  private async ensureCatalog(request: LocalModelCatalogRequest): Promise<void> {
    if (this.descriptors.length > 0) return;
    await this.list(request);
  }

  private async scan(request: LocalModelCatalogRequest): Promise<LocalModelCatalogScan> {
    const capability = await this.downloader.capability();
    const provider = request.provider ?? 'all';
    const query = request.query?.trim().toLocaleLowerCase() ?? '';
    const filtered = this.descriptors.filter((descriptor) => {
      const providerMatches = provider === 'all' || this.providerMatches(descriptor, provider);
      const queryMatches = query.length === 0 || `${descriptor.name} ${descriptor.series} ${descriptor.provider} ${descriptor.fileName}`.toLocaleLowerCase().includes(query);
      return providerMatches && queryMatches;
    });
    let failures: string[] = [];
    try {
      return {
        providers: [...this.providers],
        selectedProvider: provider,
        models: await this.downloader.projectRows(filtered, capability),
        capability,
        failures
      };
    } catch (error) {
      failures = [error instanceof Error ? error.message : String(error)];
      return { providers: [...this.providers], selectedProvider: provider, models: [], capability, failures };
    }
  }

  private providerMatches(descriptor: LocalModelDescriptor, provider: Exclude<LocalModelProvider, 'all'>): boolean {
    const normalized = descriptor.provider.toLocaleLowerCase();
    return normalized === provider.toLocaleLowerCase();
  }

  private requireDescriptor(modelId: string): LocalModelDescriptor {
    const descriptor = this.descriptors.find((candidate) => candidate.id === modelId);
    if (!descriptor) throw new Error(`Local model not found: ${modelId}`);
    return descriptor;
  }
}

export default LocalModelManager;
