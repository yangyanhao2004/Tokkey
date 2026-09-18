import type { ModelProfile } from '../../shared/types';
import GatewayModelClient, { type GatewayEndpoint } from '../gateway/GatewayModelClient';
import LocalModel from './LocalModel';
import { SqliteModelProfileStore, type ModelProfileStoring } from './ModelProfileStore';

export interface RunningHubModel {
  deviceId: string;
  displayName: string;
  modelName: string;
  endpoint: string;
  apiKey: string;
}

export interface HubModelConnecting {
  connect(model: RunningHubModel): Promise<void>;
  /**
   * Removes the route the last `connect` created.
   *
   * Paired with `connect` rather than left to the gateway's own lifetime: the
   * route points at a llama-server port, and once that server is gone the route
   * answers nothing. Leaving it would keep offering a model that cannot reply.
   */
  disconnect(): Promise<void>;
}

/** Materializes one durable Hub profile after its authenticated server is ready. */
export class HubModelConnector implements HubModelConnecting {
  constructor(
    private readonly client: GatewayModelClient,
    private readonly store: ModelProfileStoring = new SqliteModelProfileStore()
  ) {}

  static forGateway(gateway: GatewayEndpoint): HubModelConnector {
    return new HubModelConnector(new GatewayModelClient({ gateway }));
  }

  async connect(model: RunningHubModel): Promise<void> {
    const profileId = `hub-${model.deviceId.toLowerCase()}`;
    // The route is named for what it serves, not for the Dongle serving it: this
    // name is also the Codex catalog slug and the body of Claude's picker alias,
    // so it has to be a name a picker can show. See `LocalModel`.
    const routeName = LocalModel.DISPLAY_NAME;
    const existing = await this.store.find(profileId);
    const routes = await this.client.listModels();
    const linkedRoute = existing?.litellmLinks.find((link) =>
      routes.some((route) => route.modelId === link.modelID)
    );
    const namedRoute = routes.find((route) => route.modelName === routeName);
    const route = linkedRoute
      ? { modelId: linkedRoute.modelID, modelName: linkedRoute.modelName }
      : namedRoute;
    const params = {
      model: model.modelName.toLowerCase().startsWith('openai/')
        ? model.modelName
        : `openai/${model.modelName}`,
      apiKey: model.apiKey,
      apiBase: model.endpoint
    };

    let modelId: string;
    if (route) {
      modelId = route.modelId;
      await this.client.updateModel(modelId, params);
    } else {
      modelId = await this.client.createModel({
        modelName: routeName,
        params,
        marker: {
          profileId,
          apiFormat: 'openai_responses',
          // The slug names no model, so the label the gateway serves on
          // `/v1/models` is the only place a caller learns which one is running.
          displayName: model.displayName,
          supportsNativeStreaming: true,
          supportsResponsesSsePassthrough: true
        }
      });
    }

    const profile: ModelProfile = {
      id: profileId,
      name: model.displayName,
      provider: 'Hub',
      apiUrl: model.endpoint,
      apiKey: model.apiKey,
      modelName: model.modelName,
      type: 'hub',
      supportedApiFormats: ['openai_responses'],
      litellmLinks: [{ apiFormat: 'openai_responses', modelName: routeName, modelID: modelId }],
      createdAt: existing?.createdAt ?? Date.now() / 1000
    };
    await this.store.save(profile);
  }

  /**
   * Deletes the local model's route, if the gateway still holds one.
   *
   * Resolved by name rather than from the stored profile, so this works for a
   * route whichever `connect` created it — including one left by a start this
   * instance never saw. The gateway holds routes in memory only, so finding
   * none is the ordinary outcome after a gateway restart, not a failure.
   *
   * The profile row is deliberately left on disk. Nothing reads it while no
   * model runs, the next `connect` overwrites it before anything could, and
   * `connect` already re-checks every stored link against the gateway's live
   * routes — so a stale link cannot resurrect a route that is gone.
   */
  async disconnect(): Promise<void> {
    const route = (await this.client.listModels()).find(
      (candidate) => candidate.modelName === LocalModel.DISPLAY_NAME
    );
    if (!route) return;
    await this.client.deleteModel(route.modelId);
  }
}

export default HubModelConnector;
