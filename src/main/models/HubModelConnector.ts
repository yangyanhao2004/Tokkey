import type { ModelProfile } from '../../shared/types';
import GatewayModelClient, { type GatewayEndpoint } from '../gateway/GatewayModelClient';
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
    const routeName = `${profileId}-openai_responses`;
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
}

export default HubModelConnector;
