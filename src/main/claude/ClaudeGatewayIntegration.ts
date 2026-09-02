import GatewayModelClient, { type GatewayEndpoint } from '../gateway/GatewayModelClient';
import ClaudeNativeModelCatalog from '../models/ClaudeNativeModelCatalog';
import CloudModelCatalog from '../models/CloudModelCatalog';
import CloudModelConnector from '../models/CloudModelConnector';
import ClaudeConfigTakeover from './ClaudeConfigTakeover';
import ClaudeDesktopConfigLibrary, { type DesktopInferenceModel } from './ClaudeDesktopConfigLibrary';
import ClaudeDesktopHome from './ClaudeDesktopHome';
import ClaudeHome from './ClaudeHome';
import ClaudeModelAlias from './ClaudeModelAlias';
import type { ClaudeModelSelection } from './ClaudeSettingsDocument';

/**
 * Makes the Claude Code CLI see everything the gateway serves, while Tokkey
 * runs.
 *
 * One file does the work — `~/.claude/settings.json` — and it carries two
 * decisions that belong together. `env.ANTHROPIC_BASE_URL` sends Claude Code to
 * the gateway; `model` / `availableModels` / `enforceAvailableModels` decide
 * what it may ask that gateway for. Sending it to the gateway without the second
 * half would leave its picker offering Anthropic ids the gateway holds no route
 * for, so the picker is narrowed to exactly the routes that exist: Anthropic's
 * own models, plus the cloud models the user has connected — which is the whole
 * reason to route Claude Code through Tokkey at all, so one of them is what the
 * session starts on.
 *
 * This is the Claude-side counterpart of `CodexGatewayIntegration`, and reads
 * the same two sources it does: the gateway's live route list, and the cloud
 * catalog that names the card behind each route.
 *
 * In addition to `settings.json` for Claude Code (terminal), this class also
 * manages the Claude Desktop `configLibrary` on macOS, so both surfaces reach
 * the gateway at the same time. The two get different model lists on purpose:
 * Claude Code brings its own Anthropic credential and can use the native Claude
 * routes, and Desktop brings only the static gateway token and cannot. See
 * `buildDesktopModels`.
 */
export class ClaudeGatewayIntegration {
  private readonly gateway: GatewayEndpoint;
  private readonly client: GatewayModelClient;
  private readonly natives: ClaudeNativeModelCatalog;
  private readonly cloudCatalog: CloudModelCatalog;
  private readonly takeover: ClaudeConfigTakeover;
  /** null on non-macOS platforms where Claude Desktop uses a different layout. */
  private readonly desktop: ClaudeDesktopConfigLibrary | null;

  constructor(options: {
    gateway: GatewayEndpoint;
    client?: GatewayModelClient;
    natives?: ClaudeNativeModelCatalog;
    cloudCatalog?: CloudModelCatalog;
    takeover?: ClaudeConfigTakeover;
    desktop?: ClaudeDesktopConfigLibrary | null;
    homeDirectory?: string;
    claudeHome?: string;
  }) {
    const home = new ClaudeHome(options);
    this.gateway = options.gateway;
    this.client = options.client ?? new GatewayModelClient({ gateway: options.gateway });
    this.natives = options.natives ?? new ClaudeNativeModelCatalog();
    this.cloudCatalog = options.cloudCatalog ?? new CloudModelCatalog();
    this.takeover = options.takeover ?? new ClaudeConfigTakeover({ ...options, home });
    if ('desktop' in options) {
      this.desktop = options.desktop ?? null;
    } else {
      const desktopHome = new ClaudeDesktopHome(options);
      const configLibraryDir = desktopHome.configLibraryDir;
      this.desktop = configLibraryDir
        ? new ClaudeDesktopConfigLibrary({
            configLibraryDir,
            metaBackupPath: desktopHome.metaBackupPath
          })
        : null;
    }
  }

  /**
   * Undoes a takeover an interrupted run never undid. Call before anything
   * reads `settings.json` or the Desktop configLibrary.
   */
  recoverInterruptedSession(): boolean {
    const codeRecovered = this.takeover.recoverInterruptedSession();
    const desktopRecovered = this.desktop?.recoverInterruptedSession() ?? false;
    return codeRecovered || desktopRecovered;
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
   * than not routing it through Tokkey at all.
   */
  async activate(): Promise<boolean> {
    const baseUrl = this.gateway.baseUrl();
    if (baseUrl === null) {
      console.error('[ClaudeConfig] The gateway is not running; Claude Code was left as configured.');
      return false;
    }
    const connected = await this.connectedCloudModels();
    const [codeActivated] = await Promise.all([
      this.takeover.activate(baseUrl, this.buildModelSelection(connected)),
      this.desktop?.activate(baseUrl, this.buildDesktopModels(connected)) ?? Promise.resolve(false)
    ]);
    return codeActivated;
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
    const connected = await this.connectedCloudModels();
    const [codeReapplied] = await Promise.all([
      this.takeover.reapply(baseUrl, this.buildModelSelection(connected)),
      this.desktop?.reapply(baseUrl, this.buildDesktopModels(connected)) ?? Promise.resolve(false)
    ]);
    return codeReapplied;
  }

  /** Puts the user's own `settings.json` and Desktop configLibrary back. Synchronous, for `will-quit`. */
  deactivate(): boolean {
    const codeRestored = this.takeover.restore();
    this.desktop?.restore();
    return codeRestored;
  }

  /**
   * The model list for Claude Desktop's inference picker: the connected cloud
   * models, and only those.
   *
   * The native Claude routes are deliberately left out, unlike on the Claude
   * Code side. Those routes carry no key — the caller is expected to bring one,
   * which Claude Code does and Desktop cannot: Desktop authenticates with the
   * single static token this integration configures, and the gateway would
   * forward that token to Anthropic, which answers 401. Desktop reads that as
   * the gateway rejecting its credential and refuses to sign in at all, so one
   * unusable entry costs the user the whole connection rather than one model.
   * Listing only routes the gateway holds a key for keeps sign-in honest.
   *
   * Each entry is named for its route's id suffix and labelled with the model
   * it actually serves; see `ClaudeModelAlias.forDesktop` for why the name
   * cannot carry the model's own name.
   */
  private buildDesktopModels(connected: string[]): DesktopInferenceModel[] {
    const labelsByRoute = new Map(
      this.cloudCatalog
        .list()
        .map((card) => [CloudModelConnector.routeNameFor(card), card.modelName])
    );
    return connected.map((routeName, index) => ({
      name: ClaudeModelAlias.forDesktop(routeName),
      labelOverride: labelsByRoute.get(routeName) ?? routeName,
      // The first entry is Desktop's default model, and pinning it to the top
      // tier is what points Desktop's own bare `opus` alias at a model this
      // gateway can serve. Left unpinned it would resolve to an Anthropic id
      // the gateway holds no key for.
      ...(index === 0 ? { anthropicFamilyTier: 'opus' as const } : {})
    }));
  }

  /**
   * The models to restrict Claude Code to, or null to leave its own choice.
   *
   * Cloud routes go in under their `ClaudeModelAlias` for the same reason they
   * do on the Desktop side: Claude Code's picker builds no row for a bare route
   * name, so an unprefixed entry here is an entry the user can never select.
   * `model` carries the alias too — it has to name something `availableModels`
   * offers, or `enforceAvailableModels` rejects the session's own start model.
   *
   * Null when no cloud model is connected: the only thing to impose then would
   * be Anthropic's own list, which is what Claude Code already offers, and
   * pinning `model` to one of them would silently move the user off the model
   * they chose for no gain.
   */
  private buildModelSelection(connected: string[]): ClaudeModelSelection | null {
    if (connected.length === 0) {
      return null;
    }
    const cloudAliases = connected.map((routeName) => ClaudeModelAlias.forRoute(routeName));
    return {
      // The most recently registered route is the one the user just connected.
      model: cloudAliases[cloudAliases.length - 1],
      // Cloud first: it is the model this session starts on, so the picker
      // should not open on a scroll past six Anthropic entries to reach it.
      availableModels: [...cloudAliases, ...this.natives.list().map((model) => model.slug)]
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
