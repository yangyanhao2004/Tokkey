import type { GatewayEndpoint } from '../gateway/GatewayModelClient';
import RouterBinding from '../router/RouterBinding';
import RouterModel from '../router/RouterModel';
import CodexBundledCatalog from './CodexBundledCatalog';
import CodexCatalogGenerator, { type CatalogModelInput } from './CodexCatalogGenerator';
import CodexConfigTakeover from './CodexConfigTakeover';
import CodexHome from './CodexHome';

/**
 * Makes the Codex CLI see what Tokkey serves, while Tokkey runs.
 *
 * Two files do the work together and neither is useful without the other. The
 * catalog lists the models — the ones Codex ships with, plus the Tokkey model —
 * and `config.toml` points Codex at both the catalog and the endpoint that
 * answers for it. So they are written as a pair, and the catalog is written
 * first: pointing Codex at a catalog that turned out empty would cost the user
 * their model picker, which is worse than not taking over at all.
 *
 * Which endpoint that is depends on the Router page's switch, and which model
 * is offered depends on it too — the router is the only thing that can serve a
 * routed pair, and it is the pair that is worth offering. So both come from
 * {@link RouterBinding}, and both change together on every toggle.
 *
 * Both files are undone at quit by `CodexConfigTakeover`. The catalog file
 * itself is left on disk; with `model_catalog_json` gone from the restored
 * config nothing reads it, and keeping it means the next launch starts from the
 * natives it already holds instead of shelling out to the CLI again.
 */
export class CodexGatewayIntegration {
  private readonly gateway: GatewayEndpoint;
  private readonly routerBinding: RouterBinding;
  private readonly bundled: CodexBundledCatalog;
  private readonly generator: CodexCatalogGenerator;
  private readonly takeover: CodexConfigTakeover;

  constructor(options: {
    gateway: GatewayEndpoint;
    /** Omitted only by a caller with no Router page; the CLI then stays on the gateway. */
    routerBinding?: RouterBinding;
    bundled?: CodexBundledCatalog;
    generator?: CodexCatalogGenerator;
    takeover?: CodexConfigTakeover;
    homeDirectory?: string;
  }) {
    const home = new CodexHome(options);
    this.gateway = options.gateway;
    this.routerBinding = options.routerBinding ?? new RouterBinding();
    this.bundled = options.bundled ?? new CodexBundledCatalog(options);
    this.generator =
      options.generator ??
      new CodexCatalogGenerator({
        catalogPath: home.catalogPath,
        nativeSource: () => this.bundled.readCached()
      });
    this.takeover = options.takeover ?? new CodexConfigTakeover({ ...options, home });
  }

  /**
   * Undoes a takeover an interrupted run never undid. Call before anything
   * reads `config.toml`, so the file is the user's own again first.
   */
  recoverInterruptedSession(): boolean {
    return this.takeover.recoverInterruptedSession();
  }

  /**
   * Writes the catalog and points Codex at whatever is currently serving.
   *
   * Call only once the gateway is up: the provider URL carries the port this
   * launch actually bound.
   */
  async activate(): Promise<boolean> {
    const baseUrl = this.targetBaseUrl();
    if (baseUrl === null) {
      console.error('[CodexConfig] Nothing is serving; Codex was left as configured.');
      return false;
    }
    // Refreshing the bundled catalog is what seeds the native rows, and it
    // shells out to the CLI, so it happens here rather than inside the writer.
    await this.bundled.list();
    const catalogPath = await this.writeCatalog();
    return this.takeover.activate(baseUrl, catalogPath, this.routerBinding.mcpUrl);
  }

  /**
   * Rewrites both files from the state that holds right now, which is how the
   * Router page's switch reaches Codex: the catalog gains or loses the routed
   * row, and `config.toml` moves between the router and the gateway with it,
   * taking the router's own MCP server with it in both directions.
   *
   * Both halves have to move together — a routed row only resolves at the
   * router, and the router only serves routed rows — so the config write is not
   * skipped even when the catalog could not be written.
   */
  async sync(): Promise<void> {
    const baseUrl = this.targetBaseUrl();
    const catalogPath = await this.writeCatalog();
    if (baseUrl !== null) {
      this.takeover.reapply(baseUrl, catalogPath, this.routerBinding.mcpUrl);
    }
  }

  /** Puts the user's own `config.toml` back. Synchronous, for `will-quit`. */
  deactivate(): boolean {
    return this.takeover.restore();
  }

  /**
   * Where Codex should send a turn: the router while it is on, the gateway
   * otherwise, and null when neither is up.
   */
  private targetBaseUrl(): string | null {
    return this.routerBinding.baseUrl ?? this.gateway.baseUrl();
  }

  /** Writes the catalog and reports its path, or null when it holds no models. */
  private async writeCatalog(): Promise<string | null> {
    try {
      const result = this.generator.generate(this.tokkeyModels());
      if (result.models.length === 0) {
        console.error('[CodexCatalog] No models could be catalogued for Codex.');
        return null;
      }
      console.info(
        `[CodexCatalog] ${result.models.length} model(s) in ${result.path}` +
          `${result.written ? '' : ' (unchanged)'}.`
      );
      return result.path;
    } catch (error: unknown) {
      console.error('[CodexCatalog] Could not write the Codex catalog:', error);
      return null;
    }
  }

  /**
   * The rows Tokkey contributes to the catalog: the routed pair while the
   * router is on, and nothing at all while it is off.
   *
   * Nothing at all is the point of the empty case. The merge replaces every row
   * Tokkey authored with this run's set, so returning none is what removes the
   * routed row when the switch goes off — the same call that repoints Codex
   * back at the gateway also takes away the model only the router could serve.
   *
   * A cloud model on its own is deliberately not offered. It is reachable
   * through the gateway, but a turn sent to it is a turn the router never sees,
   * which is the one thing the Router page exists to prevent.
   */
  private tokkeyModels(): CatalogModelInput[] {
    const model = this.routerBinding.model;
    if (model === null) {
      return [];
    }
    return [
      {
        slug: model.slug,
        displayName: RouterModel.DISPLAY_NAME,
        // The slug carries route names, which say nothing about which models
        // are paired; the description is where the picker can read them.
        describedAs: model.description
      }
    ];
  }
}

export default CodexGatewayIntegration;
