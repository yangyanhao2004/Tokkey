import type { CodexNativeModel } from '../../shared/types';
import GatewayModelClient, {
  type GatewayEndpoint,
  type GatewayModelRoute
} from '../gateway/GatewayModelClient';
import CodexNativeModelCatalog from './CodexNativeModelCatalog';
import CodexProviderConfig from './CodexProviderConfig';

/** Codex models speak the OpenAI Responses wire, which the gateway forwards natively. */
const CODEX_NATIVE_API_FORMAT = 'openai_responses';

/** The LiteLLM provider prefix every OpenAI-compatible route carries. */
const OPENAI_PREFIX = 'openai';

/**
 * Registers the Codex CLI's own models as gateway routes.
 *
 * Unlike a cloud card, these have nothing to persist: the route is derived
 * entirely from the CLI's own configuration — the bundled catalog for the
 * models, `config.toml` for the endpoint — and the gateway holds it in memory,
 * so every launch simply rebuilds the same set.
 *
 * The route carries the endpoint Codex itself would call and no key at all.
 * That split is deliberate: the endpoint is a durable fact about this machine,
 * while the credential is a per-request decision only the gateway can make. It
 * serves the route from that endpoint when the caller brought an OpenAI-shaped
 * key, and from the ChatGPT backend on the user's `codex login` when it did not.
 *
 * The route name is the model slug, so an agent asks for `gpt-5.5` and gets it.
 * That is only unambiguous because the gateway rejects duplicate names, which
 * is also what makes re-registering an existing route a no-op rather than an
 * error.
 */
export class CodexNativeModelRegistrar {
  private readonly catalog: CodexNativeModelCatalog;
  private readonly providerConfig: CodexProviderConfig;
  private readonly client: GatewayModelClient;

  constructor(options: {
    catalog?: CodexNativeModelCatalog;
    providerConfig?: CodexProviderConfig;
    client: GatewayModelClient;
  }) {
    this.catalog = options.catalog ?? new CodexNativeModelCatalog();
    this.providerConfig = options.providerConfig ?? new CodexProviderConfig();
    this.client = options.client;
  }

  /** Builds the default wiring around one gateway supervisor. */
  static forGateway(gateway: GatewayEndpoint): CodexNativeModelRegistrar {
    return new CodexNativeModelRegistrar({ client: new GatewayModelClient({ gateway }) });
  }

  /**
   * Creates a route for every listed Codex model the gateway does not have.
   *
   * Returns the models now routable, whether this call created them or found
   * them already there — the caller wants the resulting state, not a diff.
   *
   * One model failing does not stop the rest: the models are independent, and a
   * single rejected route should not cost the user the other four.
   */
  async registerAll(): Promise<CodexNativeModel[]> {
    const models = await this.catalog.list();
    if (models.length === 0) return [];

    const [existing, apiBase] = await Promise.all([
      this.client.listModels(),
      this.providerConfig.baseUrl()
    ]);
    const registered: CodexNativeModel[] = [];
    for (const model of models) {
      if (await this.register(model, existing, apiBase)) {
        registered.push(model);
      }
    }
    return registered;
  }

  /** Ensures one model has a route, reporting whether it is now routable. */
  private async register(
    model: CodexNativeModel,
    existing: GatewayModelRoute[],
    apiBase: string | null
  ): Promise<boolean> {
    if (existing.some((route) => route.modelName === model.slug)) {
      return true;
    }
    try {
      await this.client.createModel({
        modelName: model.slug,
        params: {
          model: `${OPENAI_PREFIX}/${model.slug}`,
          // Empty on purpose: the gateway picks the credential per request, and
          // whichever it picks also decides whether this endpoint is the one
          // used or the ChatGPT backend is.
          apiKey: '',
          apiBase
        },
        marker: {
          apiFormat: CODEX_NATIVE_API_FORMAT,
          upstream: 'codex_native',
          supportsNativeStreaming: true,
          // Both backends are OpenAI's own Responses implementation, so their
          // SSE bytes are forwarded to the agent untouched.
          supportsResponsesSsePassthrough: true
        }
      });
      return true;
    } catch (error: unknown) {
      console.error(`[CodexModels] Could not register route for ${model.slug}:`, error);
      return false;
    }
  }
}

export default CodexNativeModelRegistrar;
