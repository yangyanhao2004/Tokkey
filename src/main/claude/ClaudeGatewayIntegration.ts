import GatewayModelClient, { type GatewayEndpoint } from '../gateway/GatewayModelClient';
import ClaudeNativeModelCatalog from '../models/ClaudeNativeModelCatalog';
import CloudModelCatalog from '../models/CloudModelCatalog';
import CloudModelConnector from '../models/CloudModelConnector';
import ClaudeConfigTakeover from './ClaudeConfigTakeover';
import ClaudeHome from './ClaudeHome';
import type { ClaudeModelSelection } from './ClaudeSettingsDocument';

/**
 * Makes the Claude Code CLI see everything the gateway serves, while Tokiie
 * runs.
 *
 * One file does the work — `~/.claude/settings.json` — and it carries two
 * decisions that belong together. `env.ANTHROPIC_BASE_URL` sends Claude Code to
 * the gateway; `model` / `availableModels` / `enforceAvailableModels` decide
 * what it may ask that gateway for. Sending it to the gateway without the second
 * half would leave its picker offering Anthropic ids the gateway holds no route
 * for, so the picker is narrowed to exactly the routes that exist: Anthropic's
 * own models, plus the cloud models the user has connected — which is the whole
 * reason to route Claude Code through Tokiie at all, so one of them is what the
 * session starts on.
 *
 * This is the Claude-side counterpart of `CodexGatewayIntegration`, and reads
 * the same two sources it does: the gateway's live route list, and the cloud
 * catalog that names the card behind each route.
 */
export class ClaudeGatewayIntegration {
  private readonly gateway: GatewayEndpoint;
  private readonly client: GatewayModelClient;
  private readonly natives: ClaudeNativeModelCatalog;
  private readonly cloudCatalog: CloudModelCatalog;
  private readonly takeover: ClaudeConfigTakeover;

  constructor(options: {
    gateway: GatewayEndpoint;
    client?: GatewayModelClient;
    natives?: ClaudeNativeModelCatalog;
    cloudCatalog?: CloudModelCatalog;
    takeover?: ClaudeConfigTakeover;
    homeDirectory?: string;
    claudeHome?: string;
  }) {
    const home = new ClaudeHome(options);
    this.gateway = options.gateway;
    this.client = options.client ?? new GatewayModelClient({ gateway: options.gateway });
    this.natives = options.natives ?? new ClaudeNativeModelCatalog();
    this.cloudCatalog = options.cloudCatalog ?? new CloudModelCatalog();
    this.takeover = options.takeover ?? new ClaudeConfigTakeover({ ...options, home });
  }

  /**
   * Undoes a takeover an interrupted run never undid. Call before anything
   * reads `settings.json`, so the file is the user's own again first.
   */
  recoverInterruptedSession(): boolean {
    return this.takeover.recoverInterruptedSession();
  }

  /**
   * Points Claude Code at this launch's gateway and at the models it serves.
   *
   * Call only once the gateway is up and its routes have been registered: the
   * model list is built from the routes that exist at this moment, and the base
   * URL carries the port this launch actually bound.
   *
   * A gateway that never came up leaves the file alone. An `ANTHROPIC_BASE_URL`
   * pointing at nothing would break Claude Code outright, which is far worse
   * than not routing it through Tokiie at all.
   */
  async activate(): Promise<boolean> {
    const baseUrl = this.gateway.baseUrl();
    if (baseUrl === null) {
      console.error('[ClaudeConfig] The gateway is not running; Claude Code was left as configured.');
      return false;
    }
    return this.takeover.activate(baseUrl, await this.modelSelection());
  }

  /**
   * Rewrites the settings from the routes the gateway holds right now, which is
   * how a model connected mid-session reaches Claude Code's picker.
   *
   * @returns whether the settings were rewritten; false when no takeover is in
   *   force, which is the normal state when the gateway never started
   */
  async syncSettings(): Promise<boolean> {
    const baseUrl = this.gateway.baseUrl();
    if (baseUrl === null) {
      return false;
    }
    return this.takeover.reapply(baseUrl, await this.modelSelection());
  }

  /** Puts the user's own `settings.json` back. Synchronous, for `will-quit`. */
  deactivate(): boolean {
    return this.takeover.restore();
  }

  /**
   * The models to restrict Claude Code to, or null to leave its own choice.
   *
   * Null when no cloud model is connected: the only thing to impose then would
   * be Anthropic's own list, which is what Claude Code already offers, and
   * pinning `model` to one of them would silently move the user off the model
   * they chose for no gain.
   */
  private async modelSelection(): Promise<ClaudeModelSelection | null> {
    const connected = await this.connectedCloudModels();
    if (connected.length === 0) {
      return null;
    }
    return {
      // The most recently registered route is the one the user just connected.
      model: connected[connected.length - 1],
      // Cloud first: it is the model this session starts on, so the picker
      // should not open on a scroll past six Anthropic entries to reach it.
      availableModels: [...connected, ...this.natives.list().map((model) => model.slug)]
    };
  }

  /**
   * The route names of the connected cloud cards, in the gateway's own order.
   *
   * A card is "connected" exactly when the gateway holds a route under the name
   * its card derives, so the live route list is the authority here rather than
   * the profile database: a profile whose route failed to register would name a
   * model Claude Code could select and never reach.
   */
  private async connectedCloudModels(): Promise<string[]> {
    const cloudRouteNames = new Set(
      this.cloudCatalog.list().map((card) => CloudModelConnector.routeNameFor(card))
    );
    return (await this.client.listModels())
      .map((route) => route.modelName)
      .filter((modelName) => cloudRouteNames.has(modelName));
  }
}

export default ClaudeGatewayIntegration;
