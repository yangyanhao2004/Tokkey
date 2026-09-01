import type {
  CloudModelCard,
  CloudModelConnection,
  LiteLlmModelLink,
  ModelProfile
} from '../../shared/types';
import GatewayModelClient, {
  type GatewayEndpoint,
  type GatewayModelRoute
} from '../gateway/GatewayModelClient';
import CloudModelCatalog from './CloudModelCatalog';
import { SqliteModelProfileStore, type ModelProfileStoring } from './ModelProfileStore';

/** The only API format a card-backed cloud route uses. */
const CLOUD_CARD_API_FORMAT = 'AMIS_GATEWAY_MANAGED';

/** How many characters of the profile id disambiguate the gateway route name. */
const ROUTE_NAME_ID_LENGTH = 6;

/**
 * Connects a hardcoded cloud model card to the local gateway and records it as
 * a durable model profile.
 *
 * One connect does three things in order: build the profile row in memory,
 * create the gateway route that will serve it, then persist the row with that
 * route's id in `litellm_links`. Persisting last is what keeps the database
 * free of profiles pointing at routes that were never created.
 *
 * The card's id is the profile's id, so connecting the same card twice resolves
 * the existing profile by primary key: a second click can neither duplicate the
 * profile nor duplicate its route.
 */
export class CloudModelConnector {
  private readonly catalog: CloudModelCatalog;
  private readonly store: ModelProfileStoring;
  private readonly client: GatewayModelClient;
  /**
   * The connect still running for a card, shared by every later caller.
   *
   * Two connects for the same card would both find no route and both try to
   * create one, and the gateway rejects the second as a duplicate name. Since
   * a startup restore and a click on the card can overlap, the second caller
   * waits on the first instead of racing it.
   */
  private readonly connectsInFlight = new Map<string, Promise<CloudModelConnection>>();

  constructor(options: {
    catalog?: CloudModelCatalog;
    store?: ModelProfileStoring;
    client: GatewayModelClient;
  }) {
    this.catalog = options.catalog ?? new CloudModelCatalog();
    this.store = options.store ?? new SqliteModelProfileStore();
    this.client = options.client;
  }

  /** Builds the default wiring around one gateway supervisor. */
  static forGateway(gateway: GatewayEndpoint): CloudModelConnector {
    return new CloudModelConnector({ client: new GatewayModelClient({ gateway }) });
  }

  /** Every card the renderer can offer a connect button for. */
  listCards(): CloudModelCard[] {
    return this.catalog.list();
  }

  /**
   * Re-creates the gateway routes for the cards connected in an earlier run.
   *
   * The gateway holds its routes only in memory, so every restart comes up with
   * none of them while the profiles survive in the database. Restoring puts the
   * two back in step without waiting for the user to press Select again. Cards
   * with no saved profile were never connected and are left alone.
   *
   * One card is restored at a time: the gateway is being asked to create routes,
   * and a serial walk keeps that work in a predictable order.
   */
  async restoreConnected(): Promise<CloudModelConnection[]> {
    const restored: CloudModelConnection[] = [];
    for (const card of this.catalog.list()) {
      if (!(await this.store.find(card.id))) continue;
      restored.push(await this.connect(card.id));
    }
    return restored;
  }

  /** Connects one card, reusing the existing profile and route when they survive. */
  connect(cardId: string): Promise<CloudModelConnection> {
    const running = this.connectsInFlight.get(cardId);
    if (running) return running;

    const attempt = this.runConnect(cardId).finally(() => {
      this.connectsInFlight.delete(cardId);
    });
    this.connectsInFlight.set(cardId, attempt);
    return attempt;
  }

  /** The connect itself, run once per card at a time. */
  private async runConnect(cardId: string): Promise<CloudModelConnection> {
    const card = this.catalog.require(cardId);
    const savedProfile = await this.store.find(card.id);
    const profile = savedProfile ?? this.buildProfile(card);
    const routeName = CloudModelConnector.routeNameFor(card);
    const routes = await this.client.listModels();

    if (this.findLiveLink(profile, routes)) {
      return { card, profile, status: 'alreadyConnected' };
    }

    const modelId = await this.resolveRoute(card, profile, routeName, routes);
    const connected: ModelProfile = {
      ...profile,
      litellmLinks: [{ modelID: modelId, apiFormat: CLOUD_CARD_API_FORMAT, modelName: routeName }]
    };
    await this.store.save(connected);
    return { card, profile: connected, status: savedProfile ? 'reconnected' : 'connected' };
  }

  /** The unsaved row described by the card, before any route exists for it. */
  private buildProfile(card: CloudModelCard): ModelProfile {
    return {
      id: card.id,
      // The card carries no label; naming a cloud profile is a later, user-facing step.
      name: '',
      provider: card.provider,
      apiUrl: card.url,
      apiKey: card.apiKey,
      modelName: card.modelName,
      type: 'cloud',
      supportedApiFormats: [CLOUD_CARD_API_FORMAT],
      // Seconds remain the model-layer contract; the SQLite store converts this to local time.
      createdAt: Date.now() / 1000,
      litellmLinks: []
    };
  }

  /** The stored link whose route the gateway still holds, if any. */
  private findLiveLink(profile: ModelProfile, routes: GatewayModelRoute[]): LiteLlmModelLink | null {
    const link = profile.litellmLinks.find((entry) => entry.apiFormat === CLOUD_CARD_API_FORMAT);
    if (!link) return null;
    return routes.some((route) => route.modelId === link.modelID) ? link : null;
  }

  /**
   * The id of the route serving this profile.
   *
   * A route already registered under this name is adopted rather than
   * recreated: the gateway rejects duplicate names, and that route is the one
   * this profile would have created anyway. This is what recovers a profile
   * whose stored link went stale while its route survived.
   */
  private async resolveRoute(
    card: CloudModelCard,
    profile: ModelProfile,
    routeName: string,
    routes: GatewayModelRoute[]
  ): Promise<string> {
    const registered = routes.find((route) => route.modelName === routeName);
    if (registered) {
      return registered.modelId;
    }
    return this.client.createModel({
      modelName: routeName,
      params: {
        model: this.qualifiedModelName(card),
        apiKey: card.apiKey,
        // The card's own endpoint, so the route reaches the Amis cloud gateway
        // instead of the provider that owns the `openai/` prefix.
        apiBase: card.url
      },
      marker: {
        profileId: profile.id,
        apiFormat: CLOUD_CARD_API_FORMAT,
        supportsNativeStreaming: true,
        // A hosted endpoint's SSE contract is not ours to guarantee, so the
        // gateway keeps translating Responses streams instead of forwarding bytes.
        supportsResponsesSsePassthrough: false
      }
    });
  }

  /**
   * `<provider>-<model_name>-<prefix>-<first six characters of the card id>`.
   *
   * Static because the route name is a pure function of the card: a profile
   * always carries its card's id, so anything holding the card can work out
   * which gateway route serves it without going through the database. The
   * Codex catalog is built from exactly that.
   */
  static routeNameFor(card: CloudModelCard): string {
    const suffix = card.id.slice(0, ROUTE_NAME_ID_LENGTH).toLocaleLowerCase();
    return `${card.provider}-${card.modelName}-${card.prefix}-${suffix}`;
  }

  /** Applies the LiteLLM provider prefix exactly once, however the card spells it. */
  private qualifiedModelName(card: CloudModelCard): string {
    const modelName = card.modelName.trim();
    const expectedPrefix = `${card.prefix}/`;
    return modelName.toLocaleLowerCase().startsWith(expectedPrefix.toLocaleLowerCase())
      ? modelName
      : `${expectedPrefix}${modelName}`;
  }
}

export default CloudModelConnector;
