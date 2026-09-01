import type {
  LocalChatRuntimeState,
  InstalledLocalModel,
  LocalModelCatalogRequest,
  LocalModelCatalogScan,
  LocalModelDescriptor,
  LocalModelProvider
} from '../../shared/types';
import LocalInferenceProcessManager from '../local-inference/LocalInferenceProcessManager';
import LocalModelCatalogService from './LocalModelCatalogService';
import NativeModelDownloadManager from './NativeModelDownloadManager';

/** Coordinates catalog freshness, target capability, and model lifecycle actions. */
export class LocalModelManager {
  private readonly catalog: LocalModelCatalogService;
  private readonly downloader: NativeModelDownloadManager;
  private readonly localInference: LocalInferenceProcessManager;
  private descriptors: LocalModelDescriptor[] = [];
  private providers: string[] = [];
  private runtimeOperation: Promise<void> = Promise.resolve();

  constructor(options: {
    catalog?: LocalModelCatalogService;
    downloader?: NativeModelDownloadManager;
    localInference?: LocalInferenceProcessManager;
  } = {}) {
    this.catalog = options.catalog ?? new LocalModelCatalogService();
    this.downloader = options.downloader ?? new NativeModelDownloadManager();
    this.localInference = options.localInference ?? new LocalInferenceProcessManager();
    this.localInference.setStateListener((state) => {
      if (state.status === 'ready' && state.model) {
        const endpoint = new URL(this.localInference.chatCompletionsUrl(state.model.id)).origin;
        this.downloader.markDeploymentReady(state.model.id, endpoint);
        return;
      }
      if (state.status === 'error' && state.model && state.error) {
        this.downloader.markDeploymentFailed(state.model.id, state.error);
      }
    });
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
    return this.queueRuntimeOperation(async () => {
      await this.localInference.stopModel(modelId, 'removing local model');
      await this.downloader.deleteModel(modelId);
      return this.scan(request);
    });
  }

  async deployModel(modelId: string, request: LocalModelCatalogRequest = {}): Promise<LocalModelCatalogScan> {
    await this.ensureCatalog(request);
    return this.queueRuntimeOperation(async () => {
      const previousModelId = this.localInference.getState().model?.id;
      if (previousModelId && previousModelId !== modelId) {
        this.downloader.markDeploymentStopped(previousModelId);
      }
      await this.downloader.deployModel(this.requireDescriptor(modelId), async (model) => {
        await this.localInference.start(model);
        return new URL(this.localInference.chatCompletionsUrl(model.id)).origin;
      });
      return this.scan(request);
    });
  }

  /**
   * What is on disk right now. Deliberately never touches the remote catalog:
   * the Tokiie page opens on launch and must list installed models offline.
   */
  listInstalled(): Promise<InstalledLocalModel[]> {
    return this.downloader.listInstalled();
  }

  /** Starts one discovered GGUF file without requiring a matching catalog row. */
  startInstalledModel(modelId: string): Promise<LocalChatRuntimeState> {
    return this.queueRuntimeOperation(async () => {
      const installedModel = (await this.downloader.listInstalled())
        .find((candidate) => candidate.id === modelId);
      if (!installedModel) {
        throw new Error(`Installed local model not found: ${modelId}`);
      }

      const previousModelId = this.localInference.getState().model?.id;
      if (previousModelId && previousModelId !== installedModel.id) {
        this.downloader.markDeploymentStopped(previousModelId);
      }
      return this.localInference.start({
        id: installedModel.id,
        label: installedModel.name,
        filePath: installedModel.filePath
      });
    });
  }

  /** Removes a downloaded model and answers with the remaining installed list. */
  removeInstalled(modelId: string): Promise<InstalledLocalModel[]> {
    return this.queueRuntimeOperation(async () => {
      await this.localInference.stopModel(modelId, 'removing installed local model');
      return this.downloader.removeInstalled(modelId);
    });
  }

  private async ensureCatalog(request: LocalModelCatalogRequest): Promise<void> {
    if (this.descriptors.length > 0) return;
    await this.list(request);
  }

  /** Keeps catalog rows and the single in-memory runtime in the same order. */
  private queueRuntimeOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.runtimeOperation.then(operation, operation);
    this.runtimeOperation = result.then(
      () => undefined,
      () => undefined
    );
    return result;
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
