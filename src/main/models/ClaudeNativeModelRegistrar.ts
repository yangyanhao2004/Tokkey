import GatewayModelClient, {
  type GatewayEndpoint,
  type GatewayModelRoute
} from '../gateway/GatewayModelClient';
import ClaudeNativeModelCatalog, { type ClaudeNativeModel } from './ClaudeNativeModelCatalog';

/** Claude models speak the Anthropic Messages wire. */
const CLAUDE_NATIVE_API_FORMAT = 'anthropic';

/** The LiteLLM provider prefix that selects Anthropic's own endpoint. */
const ANTHROPIC_PREFIX = 'anthropic';

/**
 * Registers Anthropic's models as gateway routes, so Claude Code can be pointed
 * at this gateway and still find every model its picker offers.
 *
 * The route carries no endpoint and no key. Both omissions are load-bearing:
 *
 * - No endpoint, so LiteLLM calls `api.anthropic.com`, which is the only place
 *   the caller's credential is worth anything.
 * - No key, so `UpstreamTargetPolicy` falls through to the caller's own header.
 *   That is the whole point of these routes. Claude Code holds a claude.ai
 *   subscription login and sends it as a bearer token; LiteLLM recognizes the
 *   `sk-ant-oat` prefix and moves it to `Authorization`, and the gateway
 *   forwards the `anthropic-beta` header carrying the OAuth capability that
 *   Anthropic requires alongside it. Storing a key here would win over that
 *   token and bill an API account for a request the subscription already covers.
 *
 * The consequence is that these routes serve a caller who brings a credential
 * and nobody else: Tokiie's own chat UI sends none, so it gets a 401 naming the
 * missing key rather than a silent charge. Giving Tokiie itself access to Claude
 * models is a separate decision requiring its own Anthropic login.
 */
export class ClaudeNativeModelRegistrar {
  private readonly catalog: ClaudeNativeModelCatalog;
  private readonly client: GatewayModelClient;

  constructor(options: { catalog?: ClaudeNativeModelCatalog; client: GatewayModelClient }) {
    this.catalog = options.catalog ?? new ClaudeNativeModelCatalog();
    this.client = options.client;
  }

  /** Builds the default wiring around one gateway supervisor. */
  static forGateway(gateway: GatewayEndpoint): ClaudeNativeModelRegistrar {
    return new ClaudeNativeModelRegistrar({ client: new GatewayModelClient({ gateway }) });
  }

  /**
   * Creates a route for every Claude model the gateway does not already have.
   *
   * Returns the models now routable, whether this call created them or found
   * them already there — the caller wants the resulting state, not a diff.
   *
   * One model failing does not stop the rest, matching the Codex registrar: the
   * routes are independent, and a single rejection should not cost the user the
   * other five.
   */
  async registerAll(): Promise<ClaudeNativeModel[]> {
    const models = this.catalog.list();
    if (models.length === 0) return [];

    const existing = await this.client.listModels();
    const registered: ClaudeNativeModel[] = [];
    for (const model of models) {
      if (await this.register(model, existing)) {
        registered.push(model);
      }
    }
    return registered;
  }

  /** Ensures one model has a route, reporting whether it is now routable. */
  private async register(
    model: ClaudeNativeModel,
    existing: GatewayModelRoute[]
  ): Promise<boolean> {
    if (existing.some((route) => route.modelName === model.slug)) {
      return true;
    }
    try {
      await this.client.createModel({
        modelName: model.slug,
        params: {
          model: `${ANTHROPIC_PREFIX}/${model.slug}`,
          // Both empty on purpose; see the class comment.
          apiKey: '',
          apiBase: null
        },
        marker: {
          apiFormat: CLAUDE_NATIVE_API_FORMAT,
          displayName: model.displayName,
          // The Anthropic Messages path streams through LiteLLM's own iterator,
          // not the raw Responses passthrough these flags select.
          supportsNativeStreaming: false,
          supportsResponsesSsePassthrough: false
        }
      });
      return true;
    } catch (error: unknown) {
      console.error(`[ClaudeModels] Could not register route for ${model.slug}:`, error);
      return false;
    }
  }
}

export default ClaudeNativeModelRegistrar;
