import type RouterModel from './RouterModel';

/**
 * Where the CLIs are currently pointed, and at what model.
 *
 * Codex and Claude Code are configured by two integrations that know nothing
 * about each other, and both have to answer the same two questions on every
 * write: which address should the CLI call, and which Tokkey model may it ask
 * for. While the router is off the answers come from the gateway; while it is
 * on they come from the router. Holding that switch in one small object keeps
 * the two integrations from each growing their own copy of it, and makes
 * "the router is on" a single fact rather than two that can disagree.
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

  /** The routed pair to publish, or null when there is nothing to publish. */
  get model(): RouterModel | null {
    return this.routerModel;
  }
}

export default RouterBinding;
