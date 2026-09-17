import type {
  LocalChatRuntimeState,
  InstalledLocalModel,
  LocalModelCatalogRequest,
  LocalModelCatalogScan,
  LocalModelDescriptor,
  LocalModelProvider,
  LocalModelRuntimeState
} from '../../shared/types';
import LocalModelCatalogService from './LocalModelCatalogService';
import NativeModelDownloadManager from './NativeModelDownloadManager';
import type { LocalModelRuntime } from './LocalModelRuntime';

/** Coordinates catalog freshness, target capability, and model lifecycle actions. */
export class LocalModelManager {
  private readonly catalog: LocalModelCatalogService;
  private readonly downloader: NativeModelDownloadManager;
  private readonly localRuntime: LocalModelRuntime;
  private descriptors: LocalModelDescriptor[] = [];
  private providers: string[] = [];
  /** The model the runtime last named while active, so its stop is recognizable. */
  private servedModelId: string | null = null;
  private runtimeOperation: Promise<void> = Promise.resolve();

  constructor(options: {
    catalog?: LocalModelCatalogService;
    downloader?: NativeModelDownloadManager;
    localRuntime?: LocalModelRuntime;
  } = {}) {
    this.catalog = options.catalog ?? new LocalModelCatalogService();
    this.downloader = options.downloader ?? new NativeModelDownloadManager();
    if (!options.localRuntime) {
      throw new Error('LocalModelManager requires the shared Hub local model runtime.');
    }
    this.localRuntime = options.localRuntime;
    this.localRuntime.subscribe((state) => this.trackRuntimeState(state));
  }

  /**
   * Keeps the catalog row of the served model in step with the server itself.
   *
   * The runtime is the one place every lifecycle change passes through — a
   * start or stop asked of this class, a server that exited, a Dongle pulled
   * out — so the rows follow the phase it publishes rather than the calls this
   * class happens to make.
   */
  private trackRuntimeState(state: LocalModelRuntimeState): void {
    if (state.phase === 'starting' && state.modelId) {
      this.servedModelId = state.modelId;
      return;
    }
    if (state.phase === 'running' && state.modelId && state.endpoint) {
      this.servedModelId = state.modelId;
      this.downloader.markDeploymentReady(state.modelId, new URL(state.endpoint).origin);
      return;
    }
    if (state.phase === 'stopping' && state.modelId) {
      this.servedModelId = state.modelId;
      this.downloader.markDeploymentStopping(state.modelId);
      return;
    }
    if (state.phase === 'failed' && state.modelId && state.error) {
      this.servedModelId = null;
      this.downloader.markDeploymentFailed(state.modelId, state.error);
      return;
    }
    // Idle: the runtime no longer names a model, so the one it last served is
    // the one whose deployment has just ended.
    if (state.phase === 'idle' && this.servedModelId) {
      this.downloader.markDeploymentStopped(this.servedModelId);
      this.servedModelId = null;
    }
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
      await this.stopRuntimeForModel(modelId);
      await this.downloader.deleteModel(modelId);
      return this.scan(request);
    });
  }

  async deployModel(modelId: string, request: LocalModelCatalogRequest = {}): Promise<LocalModelCatalogScan> {
    await this.ensureCatalog(request);
    return this.queueRuntimeOperation(async () => {
      const descriptor = this.requireDescriptor(modelId);
      if (await this.prepareRuntimeFor(modelId)) return this.scan(request);
      await this.downloader.deployModel(descriptor, async (model) => {
        await this.localRuntime.startModel({ ...model, fileName: descriptor.fileName });
        return new URL(this.localRuntime.chatCompletionsUrl(model.id)).origin;
      });
      return this.scan(request);
    });
  }

  /** The device and server lifecycle every Start/Stop button is drawn from. */
  getRuntimeState(): Promise<LocalModelRuntimeState> {
    return this.localRuntime.getState();
  }

  /**
   * Stops the one model the runtime is serving, whoever asked for it.
   *
   * Deliberately outside the queue: a stop has to be able to reach a start that
   * is still in flight, which the queue would make it wait out. The catalog row
   * follows the phases the runtime publishes while it tears the server down.
   */
  stopModel(): Promise<LocalModelRuntimeState> {
    return this.localRuntime.stopModel();
  }

  /**
   * What is on disk right now. Deliberately never touches the remote catalog:
   * the Tokkey page opens on launch and must list installed models offline.
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
      if (!(await this.prepareRuntimeFor(installedModel.id))) {
        await this.localRuntime.startModel({
          id: installedModel.id,
          label: installedModel.name,
          fileName: installedModel.fileName,
          filePath: installedModel.filePath
        });
      }
      return this.localRuntime.getLocalChatRuntimeState();
    });
  }

  /** Removes a downloaded model and answers with the remaining installed list. */
  removeInstalled(modelId: string): Promise<InstalledLocalModel[]> {
    return this.queueRuntimeOperation(async () => {
      await this.stopRuntimeForModel(modelId);
      return this.downloader.removeInstalled(modelId);
    });
  }

  private async ensureCatalog(request: LocalModelCatalogRequest): Promise<void> {
    if (this.descriptors.length > 0) return;
    await this.list(request);
  }

  /**
   * Clears the way for `modelId` to start, and reports whether it is already
   * running — in which case there is nothing left to start.
   *
   * This runtime serves one model at a time, so a different one has to be
   * stopped first. Only the phase is consulted: the catalog rows are the
   * subscription's business, not this call's.
   */
  private async prepareRuntimeFor(modelId: string): Promise<boolean> {
    const runtime = await this.localRuntime.getState();
    if (runtime.phase === 'running' && runtime.modelId === modelId) return true;
    if (runtime.modelId !== null && runtime.modelId !== modelId) {
      await this.localRuntime.stopModel();
    }
    return false;
  }

  /** Stops the server only if it is the one serving `modelId`. */
  private async stopRuntimeForModel(modelId: string): Promise<void> {
    if ((await this.localRuntime.getState()).modelId !== modelId) return;
    await this.localRuntime.stopModel();
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
