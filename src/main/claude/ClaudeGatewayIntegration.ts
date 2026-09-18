import type { GatewayEndpoint } from '../gateway/GatewayModelClient';
import ClaudeNativeModelCatalog from '../models/ClaudeNativeModelCatalog';
import LocalModelBinding from '../models/LocalModelBinding';
import RouterBinding from '../router/RouterBinding';
import ClaudeConfigTakeover from './ClaudeConfigTakeover';
import ClaudeDesktopConfigLibrary, { type DesktopInferenceModel } from './ClaudeDesktopConfigLibrary';
import ClaudeDesktopHome from './ClaudeDesktopHome';
import ClaudeHome from './ClaudeHome';
import ClaudeMcpTakeover from './ClaudeMcpTakeover';
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
 * The router brings a tool server with it, and that is a third file again —
 * `~/.claude.json`, where user-scope MCP servers live — held by
 * {@link ClaudeMcpTakeover} for exactly as long as the router is up. Being a
 * user-scope server, it is never gated behind the approval prompt `.mcp.json`
 * servers face; what would still stop on every call is each tool call, so for
 * as long as that server is declared the settings file allows it too.
 *
 * A running local model is the second model offered, and it comes from
 * {@link LocalModelBinding} rather than the router's binding. It is independent
 * of the switch in both directions: the gateway serves its route, and the
 * router forwards a model name it does not recognize to that same gateway, so
 * the entry resolves at whichever endpoint `ANTHROPIC_BASE_URL` currently names.
 *
 * Desktop and Claude Code are offered the same two models, and never a plain
 * cloud route: a cloud model is reached through the router or not at all. Both
 * use the picker-qualified `anthropic.` alias, which satisfies Desktop's
 * managed-config validator without leaking a rival vendor's name into the model
 * id — the router's slug and the local model's are both fixed and carry no
 * vendor fragment to leak.
 */
export class ClaudeGatewayIntegration {
  private readonly gateway: GatewayEndpoint;
  private readonly routerBinding: RouterBinding;
  private readonly localBinding: LocalModelBinding;
  private readonly natives: ClaudeNativeModelCatalog;
  private readonly takeover: ClaudeConfigTakeover;
  private readonly mcp: ClaudeMcpTakeover;
  /** Null on non-macOS platforms, where Claude Desktop uses a different layout. */
  private readonly desktop: ClaudeDesktopConfigLibrary | null;

  constructor(options: {
    gateway: GatewayEndpoint;
    /** Omitted only by a caller with no Router page; Claude then stays on the gateway. */
    routerBinding?: RouterBinding;
    /** Omitted only by a caller with no local runtime; no local model is then offered. */
    localBinding?: LocalModelBinding;
    natives?: ClaudeNativeModelCatalog;
    takeover?: ClaudeConfigTakeover;
    mcp?: ClaudeMcpTakeover;
    desktop?: ClaudeDesktopConfigLibrary | null;
    homeDirectory?: string;
    claudeHome?: string;
  }) {
    const home = new ClaudeHome(options);
    this.gateway = options.gateway;
    this.routerBinding = options.routerBinding ?? new RouterBinding();
    this.localBinding = options.localBinding ?? new LocalModelBinding();
    this.natives = options.natives ?? new ClaudeNativeModelCatalog();
    this.takeover = options.takeover ?? new ClaudeConfigTakeover({ ...options, home });
    // Its own ledger: `ledgerPath` in `options` names the settings ledger, and
    // sharing one file would have each takeover's write erase the other's.
    this.mcp =
      options.mcp ??
      new ClaudeMcpTakeover({
        home,
        homeDirectory: options.homeDirectory,
        claudeHome: options.claudeHome
      });
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
    const mcpRecovered = this.mcp.recoverInterruptedSession();
    const desktopRecovered = this.desktop?.recoverInterruptedSession() ?? false;
    return codeRecovered || mcpRecovered || desktopRecovered;
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
    return this.takeover.activate(baseUrl, this.buildModelSelection(), this.syncMcp());
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
    return this.takeover.reapply(baseUrl, this.buildModelSelection(), this.syncMcp());
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
    this.mcp.restore();
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
   * Declares the router's tool server, refreshes it, or takes it back out —
   * whichever the router's presence now calls for.
   *
   * Same shape as {@link syncDesktop}, and for the same reason: this entry is
   * only ever borrowed while the router is up, so neither `activate` nor
   * `reapply` alone can carry it across a switch moving in both directions.
   *
   * @returns whether the tool server is now declared, which is what decides
   *   whether `settings.json` also allows its tools to be called without a
   *   prompt per call — an allow rule for a server that is not there would
   *   outlive the reason it was written
   */
  private syncMcp(): boolean {
    const mcpUrl = this.routerBinding.mcpUrl;
    if (mcpUrl === null) {
      this.mcp.restore();
      return false;
    }
    if (!this.mcp.reapply(mcpUrl)) {
      this.mcp.activate(mcpUrl);
    }
    return true;
  }

  /**
   * What Desktop should offer, in the picker-qualified shape it accepts. Empty
   * when neither the router nor a local model is serving, which `syncDesktop`
   * reads as "hand the configLibrary back."
   */
  private buildDesktopModels(): DesktopInferenceModel[] {
    return this.publishedSlugs().map((slug) => ({
      name: ClaudeModelAlias.forRoute(slug),
      labelOverride: slug
    }));
  }

  /**
   * The Tokkey route names to publish right now, router first.
   *
   * Router first so the routed pair heads the picker; the local model follows it
   * and both precede the Anthropic natives. Shared by the two surfaces because
   * they offer the same models and differ only in the shape each wants them in —
   * having each build its own list is how the two would drift apart.
   */
  private publishedSlugs(): string[] {
    const slugs: string[] = [];
    if (this.routerBinding.model !== null) {
      slugs.push(this.routerBinding.model.slug);
    }
    if (this.localBinding.model !== null) {
      slugs.push(this.localBinding.model.slug);
    }
    return slugs;
  }

  /**
   * The models to restrict Claude Code to, or null to leave its own choice.
   *
   * Both Tokkey models go in through `ClaudeModelAlias.forRoute`, the same alias
   * every other gateway route gets — the routed pair is no longer the one
   * exception to that scheme it used to be. The router used to decide a turn's
   * tier by parsing the model name it was sent. It now recognizes its
   * picker-qualified fixed slug and reads the pairing out of `router_profiles`
   * instead (see `RouterModel`), and forwards the local model's slug, which it
   * does not recognize, straight to the gateway that serves it.
   *
   * `model` itself stays null even so. Setting it would move every session onto
   * whichever model Tokkey picked the moment it started serving, silently
   * overriding what the user already had selected. Null here means "leave the
   * existing `model` key alone" (see `ClaudeSettingsDocument.setModelSelection`),
   * which offers both models in the picker without forcing either.
   *
   * The whole selection is null when neither is serving: the only thing left to
   * impose then would be Anthropic's own list, which is what Claude Code already
   * offers, and returning null is what takes the last Tokkey entry back out.
   */
  private buildModelSelection(): ClaudeModelSelection | null {
    const slugs = this.publishedSlugs();
    if (slugs.length === 0) {
      return null;
    }
    return {
      model: null,
      // Tokkey's own first, so they head the picker rather than trailing six
      // Anthropic entries the user would have to scroll past to find them.
      availableModels: [
        ...slugs.map((slug) => ClaudeModelAlias.forRoute(slug)),
        ...this.natives.list().map((native) => native.slug)
      ]
    };
  }
}

export default ClaudeGatewayIntegration;
