import type { CloudApiFormat } from '../../shared/types';

/**
 * The part of the gateway supervisor this client needs to reach it.
 *
 * No credential appears here: the gateway listens on loopback and authenticates
 * nobody, so its callers have nothing to send.
 */
export interface GatewayEndpoint {
  startIfNeeded(): Promise<void>;
  baseUrl(): string | null;
}

/** LiteLLM call parameters for one route, before wire serialization. */
export interface GatewayLitellmParams {
  /** Provider-qualified model, e.g. `openai/gpt-5.6-terra`. */
  model: string;
  /** Empty when the gateway resolves the credential itself, per request. */
  apiKey: string;
  apiBase: string | null;
}

/** The durable marker the gateway stores alongside a route. */
export interface GatewayModelMarker {
  /** Absent for routes with no model profile behind them, such as Codex natives. */
  profileId?: string;
  apiFormat: CloudApiFormat;
  supportsNativeStreaming: boolean;
  supportsResponsesSsePassthrough: boolean;
  /**
   * Marks a route whose upstream the gateway picks per request. Only
   * `codex_native` is understood today; an absent value means the route's own
   * endpoint and key are used, which is how every other route behaves.
   */
  upstream?: 'codex_native';
}

/** One route creation request. */
export interface GatewayModelRequest {
  modelName: string;
  params: GatewayLitellmParams;
  marker: GatewayModelMarker;
}

/** One route as the gateway currently holds it. */
export interface GatewayModelRoute {
  modelId: string;
  modelName: string;
}

/** Raised for any non-2xx management response, carrying the gateway's detail. */
export class GatewayRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'GatewayRequestError';
  }
}

export type GatewayFetch = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Talks to the local gateway's model-management API.
 *
 * Every call starts the gateway first, so a route can be created during a
 * session in which the supervisor has not been asked for the gateway yet, or
 * after a crash left it down.
 */
export class GatewayModelClient {
  private readonly gateway: GatewayEndpoint;
  private readonly fetcher: GatewayFetch;

  constructor(options: { gateway: GatewayEndpoint; fetcher?: GatewayFetch }) {
    this.gateway = options.gateway;
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
  }

  /** Creates one route and returns the gateway-generated model id. */
  async createModel(request: GatewayModelRequest): Promise<string> {
    const payload = await this.send('/model/new', {
      method: 'POST',
      body: JSON.stringify({
        model_name: request.modelName,
        litellm_params: {
          model: request.params.model,
          api_key: request.params.apiKey,
          api_base: request.params.apiBase
        },
        model_info: {
          created_by: 'amis-wifi',
          ...(request.marker.profileId ? { profile_id: request.marker.profileId } : {}),
          ...(request.marker.upstream ? { upstream: request.marker.upstream } : {}),
          api_format: request.marker.apiFormat,
          supports_native_streaming: request.marker.supportsNativeStreaming,
          supports_responses_sse_passthrough: request.marker.supportsResponsesSsePassthrough
        }
      })
    });
    const modelId = this.readModelId(payload);
    if (!modelId) {
      throw new GatewayRequestError('The gateway created a model without returning its id.', 502);
    }
    return modelId;
  }

  /** Lists the routes the gateway currently holds in memory. */
  async listModels(): Promise<GatewayModelRoute[]> {
    const payload = await this.send('/model/info', { method: 'GET' });
    const entries = (payload as { data?: unknown }).data;
    if (!Array.isArray(entries)) {
      return [];
    }
    return entries.flatMap((entry) => {
      const route = this.readRoute(entry);
      return route ? [route] : [];
    });
  }

  private async send(routePath: string, init: RequestInit): Promise<unknown> {
    const baseUrl = await this.resolveBaseUrl();
    const response = await this.fetcher(`${baseUrl}${routePath}`, {
      ...init,
      headers: { 'Content-Type': 'application/json' }
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      throw new GatewayRequestError(
        `Gateway ${routePath} failed: ${this.describeFailure(payload, response.status)}`,
        response.status
      );
    }
    return payload;
  }

  private async resolveBaseUrl(): Promise<string> {
    await this.gateway.startIfNeeded();
    const baseUrl = this.gateway.baseUrl();
    if (!baseUrl) {
      throw new GatewayRequestError('The local gateway is not running.', 503);
    }
    return baseUrl;
  }

  /** The gateway answers with `model_id`; `model_info.id` carries the same value. */
  private readModelId(payload: unknown): string {
    if (!payload || typeof payload !== 'object') return '';
    const body = payload as { model_id?: unknown; model_info?: unknown };
    if (typeof body.model_id === 'string' && body.model_id.length > 0) {
      return body.model_id;
    }
    const info = body.model_info;
    if (info && typeof info === 'object' && typeof (info as { id?: unknown }).id === 'string') {
      return (info as { id: string }).id;
    }
    return '';
  }

  private readRoute(entry: unknown): GatewayModelRoute | null {
    if (!entry || typeof entry !== 'object') return null;
    const route = entry as { model_name?: unknown; model_info?: unknown };
    const info = route.model_info;
    const modelId = info && typeof info === 'object' ? (info as { id?: unknown }).id : undefined;
    if (typeof route.model_name !== 'string' || typeof modelId !== 'string') return null;
    return { modelId, modelName: route.model_name };
  }

  private describeFailure(payload: unknown, status: number): string {
    if (payload && typeof payload === 'object') {
      const detail = (payload as { detail?: unknown }).detail;
      if (typeof detail === 'string' && detail.length > 0) return detail;
    }
    return `HTTP ${status}`;
  }
}

export default GatewayModelClient;
