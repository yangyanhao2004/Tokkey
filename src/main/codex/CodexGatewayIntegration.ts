import type { CloudModelCard } from '../../shared/types';
import GatewayModelClient, { type GatewayEndpoint } from '../gateway/GatewayModelClient';
import CloudModelCatalog from '../models/CloudModelCatalog';
import CloudModelConnector from '../models/CloudModelConnector';
import CodexBundledCatalog from './CodexBundledCatalog';
import CodexCatalogGenerator, { type CatalogModelInput } from './CodexCatalogGenerator';
import CodexConfigTakeover from './CodexConfigTakeover';
import CodexHome from './CodexHome';

/**
 * Makes the Codex CLI see everything the gateway serves, while Tokiie runs.
 *
 * Two files do the work together and neither is useful without the other. The
 * catalog lists the models — the ones Codex ships with, plus one row per route
 * Tokiie has registered — and `config.toml` points Codex at both the catalog
 * and the gateway that answers for it. So they are written as a pair, and the
 * catalog is written first: pointing Codex at a catalog that turned out empty
 * would cost the user their model picker, which is worse than not taking over
 * at all.
 *
 * Both are undone at quit by `CodexConfigTakeover`. The catalog file itself is
 * left on disk; with `model_catalog_json` gone from the restored config nothing
 * reads it, and keeping it means the next launch starts from the natives it
 * already holds instead of shelling out to the CLI again.
 */
export class CodexGatewayIntegration {
  private readonly gateway: GatewayEndpoint;
  private readonly client: GatewayModelClient;
  private readonly bundled: CodexBundledCatalog;
  private readonly generator: CodexCatalogGenerator;
  private readonly takeover: CodexConfigTakeover;
  private readonly cloudCatalog: CloudModelCatalog;

  constructor(options: {
    gateway: GatewayEndpoint;
    client?: GatewayModelClient;
    bundled?: CodexBundledCatalog;
    generator?: CodexCatalogGenerator;
    takeover?: CodexConfigTakeover;
    cloudCatalog?: CloudModelCatalog;
    homeDirectory?: string;
  }) {
    const home = new CodexHome(options);
    this.gateway = options.gateway;
    this.client = options.client ?? new GatewayModelClient({ gateway: options.gateway });
    this.bundled = options.bundled ?? new CodexBundledCatalog(options);
    this.generator =
      options.generator ??
      new CodexCatalogGenerator({
        catalogPath: home.catalogPath,
        nativeSource: () => this.bundled.readCached()
      });
    this.takeover = options.takeover ?? new CodexConfigTakeover({ ...options, home });
    this.cloudCatalog = options.cloudCatalog ?? new CloudModelCatalog();
  }

  /**
   * Undoes a takeover an interrupted run never undid. Call before anything
   * reads `config.toml`, so the file is the user's own again first.
   */
  recoverInterruptedSession(): boolean {
    return this.takeover.recoverInterruptedSession();
  }

  /**
   * Writes the catalog and points Codex at the gateway.
   *
   * Call only once the gateway is up and its routes have been registered: the
   * catalog is built from the routes that exist at this moment, and the
   * provider URL carries the port this launch actually bound.
   */
  async activate(): Promise<boolean> {
    const baseUrl = this.gateway.baseUrl();
    if (baseUrl === null) {
      console.error('[CodexConfig] The gateway is not running; Codex was left as configured.');
      return false;
    }
    // Refreshing the bundled catalog is what seeds the native rows, and it
    // shells out to the CLI, so it happens here rather than inside the writer.
    await this.bundled.list();
    const catalogPath = await this.writeCatalog();
    return this.takeover.activate(baseUrl, catalogPath);
  }

  /**
   * Rebuilds the catalog from the routes the gateway holds right now, which is
   * how a model connected mid-session becomes visible to Codex.
   */
  async syncCatalog(): Promise<void> {
    await this.writeCatalog();
  }

  /** Puts the user's own `config.toml` back. Synchronous, for `will-quit`. */
  deactivate(): boolean {
    return this.takeover.restore();
  }

  /** Writes the catalog and reports its path, or null when it holds no models. */
  private async writeCatalog(): Promise<string | null> {
    try {
      const result = this.generator.generate(await this.routedModels());
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
   * One catalog input per gateway route that Codex does not already know.
   *
   * Routes named after a native model are skipped: Codex ships a far richer row
   * for those than anything derived here, and the gateway registers them under
   * exactly that name, so the native row already routes correctly.
   */
  private async routedModels(): Promise<CatalogModelInput[]> {
    const natives = new Set((await this.bundled.list()).map((entry) => entry.slug));
    const cards = this.describeCards();
    return (await this.client.listModels())
      .filter((route) => !natives.has(route.modelName))
      .map((route) => cards.get(route.modelName) ?? { slug: route.modelName });
  }

  /** The cloud cards keyed by the route name each one is served under. */
  private describeCards(): Map<string, CatalogModelInput> {
    return new Map(
      this.cloudCatalog.list().map((card: CloudModelCard) => [
        CloudModelConnector.routeNameFor(card),
        {
          slug: CloudModelConnector.routeNameFor(card),
          // The picker shows what the user connected, not the route name that
          // keeps two connections of the same model apart.
          displayName: `${card.provider}/${card.modelName}`,
          ownedBy: card.provider
        }
      ])
    );
  }
}

export default CodexGatewayIntegration;
