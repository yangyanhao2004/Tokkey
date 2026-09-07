import type RouterModel from './RouterModel';
import RouterMcpServer from './RouterMcpServer';

/**
 * Where the CLIs are currently pointed, and at what model.
 *
 * Codex and Claude Code are configured by two integrations that know nothing
 * about each other, and both have to answer the same two questions on every
 * write: which address should the CLI call, and which Tokkey model may it ask
 * for. While the router is off the answers come from the gateway; while it is
 * on they come from the router, which also brings a tool server of its own —
 * `mcpUrl` — that exists only for as long as the router does. Holding that
 * switch in one small object keeps the two integrations from each growing their
 * own copy of it, and makes "the router is on" a single fact rather than
 * several that can disagree.
 *
 * Mutable on purpose, and deliberately the only mutable thing here: the toggle
 * changes it at most twice per session, and every reader wants the current
 * value rather than the value at the time it was constructed.
 */
export class RouterBinding {
  private routerBaseUrl: string | null = null;
  private routerModel: RouterModel | null = null;

  /** Points the CLIs at a running router serving `model`. */
  bind(baseUrl: string, model: RouterModel): void {
    this.routerBaseUrl = baseUrl;
    this.routerModel = model;
  }

  /** Points the CLIs back at the gateway, dropping the router model with it. */
  release(): void {
    this.routerBaseUrl = null;
    this.routerModel = null;
  }

  get isBound(): boolean {
    return this.routerBaseUrl !== null;
  }

  /** The router's base URL while it is on, or null to mean "use the gateway". */
  get baseUrl(): string | null {
    return this.routerBaseUrl;
  }

  /**
   * The router's MCP endpoint while it is on, or null while the CLIs are on the
   * gateway.
   *
   * Null is not "leave the tool server as it was": the endpoint only answers
   * while the router runs, so the same switch that repoints a CLI has to take
   * the entry back out of its configuration.
   */
  get mcpUrl(): string | null {
    return this.routerBaseUrl === null ? null : RouterMcpServer.urlFor(this.routerBaseUrl);
  }

  /** The routed pair to publish, or null when there is nothing to publish. */
  get model(): RouterModel | null {
    return this.routerModel;
  }
}

export default RouterBinding;
