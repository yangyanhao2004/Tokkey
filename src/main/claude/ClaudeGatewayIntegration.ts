import type { GatewayEndpoint } from '../gateway/GatewayModelClient';
import ClaudeNativeModelCatalog from '../models/ClaudeNativeModelCatalog';
import RouterBinding from '../router/RouterBinding';
import ClaudeConfigTakeover from './ClaudeConfigTakeover';
import ClaudeDesktopConfigLibrary, { type DesktopInferenceModel } from './ClaudeDesktopConfigLibrary';
import ClaudeDesktopHome from './ClaudeDesktopHome';
import ClaudeHome from './ClaudeHome';
import ClaudeModelAlias from './ClaudeModelAlias';
import type { ClaudeModelSelection } from './ClaudeSettingsDocument';

/**
 * Makes the Claude Code CLI see what Tokkey serves, while Tokkey runs.
 *
 * One file does the work — `~/.claude/settings.json` — and it carries two
 * decisions that belong together. `env.ANTHROPIC_BASE_URL` sends Claude Code to
 * an endpoint; `model` / `availableModels` / `enforceAvailableModels` decide
 * what it may ask that endpoint for. Sending it somewhere without the second
 * half would leave its picker offering Anthropic ids that endpoint holds no
 * route for, so the picker is narrowed to exactly what can be served.
 *
 * Which endpoint, and which model, both come from {@link RouterBinding}: the
 * router while the Router page's switch is on, the gateway otherwise. The two
 * move together, because the routed pair the router serves is a model the
 * gateway would reject, and the addresses differ.
 *
 * This is the Claude-side counterpart of `CodexGatewayIntegration`.
 *
 * Claude Desktop only ever gets the routed pair, never a plain gateway route:
 * a cloud model is reached through the router or not at all, and while the
 * router is off there is nothing for Desktop's configLibrary to point at. The
 * pair uses the same picker-qualified router slug as Claude Code. The
 * `anthropic.` prefix satisfies Desktop's managed-config validator without
 * leaking a rival vendor's name from the cloud route into the model id.
 */
export class ClaudeGatewayIntegration {
  private readonly gateway: GatewayEndpoint;
  private readonly routerBinding: RouterBinding;
  private readonly natives: ClaudeNativeModelCatalog;
  private readonly takeover: ClaudeConfigTakeover;
  /** Null on non-macOS platforms, where Claude Desktop uses a different layout. */
  private readonly desktop: ClaudeDesktopConfigLibrary | null;

  constructor(options: {
    gateway: GatewayEndpoint;
    /** Omitted only by a caller with no Router page; Claude then stays on the gateway. */
    routerBinding?: RouterBinding;
    natives?: ClaudeNativeModelCatalog;
    takeover?: ClaudeConfigTakeover;
    desktop?: ClaudeDesktopConfigLibrary | null;
    homeDirectory?: string;
    claudeHome?: string;
  }) {
    const home = new ClaudeHome(options);
    this.gateway = options.gateway;
    this.routerBinding = options.routerBinding ?? new RouterBinding();
    this.natives = options.natives ?? new ClaudeNativeModelCatalog();
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
   * Points Claude Code at this launch's endpoint and at the models it serves.
   *
   * Call only once the gateway is up: the base URL written here carries the
   * port this launch actually bound.
   *
   * A gateway that never came up leaves the file alone. An `ANTHROPIC_BASE_URL`
   * pointing at nothing would break Claude Code outright, which is far worse
   * than not routing it through Tokkey at all.
   */
  async activate(): Promise<boolean> {
    const gatewayBaseUrl = this.gateway.baseUrl();
    if (gatewayBaseUrl === null) {
      console.error('[ClaudeConfig] The gateway is not running; Claude Code was left as configured.');
      return false;
    }
    const baseUrl = this.codeBaseUrl(gatewayBaseUrl);
    this.syncDesktop(baseUrl);
    return this.takeover.activate(baseUrl, this.buildModelSelection());
  }

  /**
   * Rewrites the settings from the state that holds right now, which is how the
   * Router page's switch reaches Claude Code: the picker gains or loses the
   * routed model, and `ANTHROPIC_BASE_URL` moves with it.
   *
   * @returns whether the settings were rewritten; false when no takeover is in
   *   force, which is the normal state when the gateway never started
   */
  async syncSettings(): Promise<boolean> {
    const gatewayBaseUrl = this.gateway.baseUrl();
    if (gatewayBaseUrl === null) {
      return false;
    }
    const baseUrl = this.codeBaseUrl(gatewayBaseUrl);
    this.syncDesktop(baseUrl);
    return this.takeover.reapply(baseUrl, this.buildModelSelection());
  }

  /**
   * Where Claude Code should send a turn: the router while it is on, and the
   * gateway otherwise.
   */
  private codeBaseUrl(gatewayBaseUrl: string): string {
    return this.routerBinding.baseUrl ?? gatewayBaseUrl;
  }

  /**
   * Puts the user's own `settings.json` back, and the Desktop configLibrary
   * with it on the off chance this session recovered one. Synchronous, for
   * `will-quit`.
   */
  deactivate(): boolean {
    const codeRestored = this.takeover.restore();
    this.desktop?.restore();
    return codeRestored;
  }

  /**
   * Takes Desktop's configLibrary over, refreshes it, or hands it back —
   * whichever the routed pair's presence now calls for.
   *
   * Unlike Claude Code's `settings.json`, Desktop's configLibrary is only ever
   * taken over for the routed pair: `activate` is a no-op with no models to
   * offer, and `reapply` only rewrites an already-active entry, so neither
   * alone can carry Desktop across a switch turning on or off. This tries
   * `reapply` first — the common case once the router is already on — and
   * falls back to `activate` the one time it returns false because nothing was
   * taken over yet.
   */
  private syncDesktop(baseUrl: string): void {
    if (!this.desktop) return;
    const models = this.buildDesktopModels();
    if (models.length === 0) {
      this.desktop.restore();
      return;
    }
    if (!this.desktop.reapply(baseUrl, models)) {
      this.desktop.activate(baseUrl, models);
    }
  }

  /**
   * The routed pair in the picker-qualified shape Desktop accepts. Empty while
   * the router is off, which `syncDesktop` reads as "hand the configLibrary
   * back."
   */
  private buildDesktopModels(): DesktopInferenceModel[] {
    const model = this.routerBinding.model;
    if (model === null) {
      return [];
    }
    return [{ name: ClaudeModelAlias.forRoute(model.slug), labelOverride: model.slug }];
  }

  /**
   * The models to restrict Claude Code to, or null to leave its own choice.
   *
   * The routed pair goes in through `ClaudeModelAlias.forRoute`, the same alias
   * every other gateway route gets — no longer the one exception to that scheme
   * it used to be. The router used to decide a turn's tier by parsing the model
   * name it was sent. It now recognizes this picker-qualified fixed slug and
   * reads the pairing out of `router_profiles` instead (see `RouterModel`).
   *
   * `model` itself stays null even so. Setting it to the routed pair would move
   * every session onto it the moment the switch goes on, silently overriding
   * whatever the user already had selected — for no gain, since every request
   * reaches the router regardless of which name Claude Code happens to send
   * while it is bound. Null here means "leave the existing `model` key alone"
   * (see `ClaudeSettingsDocument.setModelSelection`), which offers the routed
   * model in the picker without forcing it.
   *
   * The whole selection is null while the router is off: the only thing left to
   * impose then would be Anthropic's own list, which is what Claude Code
   * already offers, and returning null here is what takes the routed model away
   * again when the switch goes off.
   */
  private buildModelSelection(): ClaudeModelSelection | null {
    const model = this.routerBinding.model;
    if (model === null) {
      return null;
    }
    return {
      model: null,
      // The pair first, so it heads the picker rather than trailing six
      // Anthropic entries the user would have to scroll past to find it.
      availableModels: [
        ClaudeModelAlias.forRoute(model.slug),
        ...this.natives.list().map((native) => native.slug)
      ]
    };
  }
}

export default ClaudeGatewayIntegration;
