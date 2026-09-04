import type { RouterRuntimeState } from '../../shared/types';
import type ClaudeGatewayIntegration from '../claude/ClaudeGatewayIntegration';
import type CodexGatewayIntegration from '../codex/CodexGatewayIntegration';
import GatewayModelClient, { type GatewayEndpoint } from '../gateway/GatewayModelClient';
import CloudModelConnector from '../models/CloudModelConnector';
import RouterBinding from './RouterBinding';
import RouterModel, { type RouterModelTier } from './RouterModel';
import type RouterProcessManager from './RouterProcessManager';
import SqliteRouterProfileStore, { type RouterProfileStoring } from './RouterProfileStore';

/**
 * Turns the Router page's switch into everything that has to change with it.
 *
 * Starting the process is the small half. The switch only means anything once
 * Codex and Claude Code are calling the router instead of the gateway, offering
 * the routed pair instead of nothing, and the router itself can read that same
 * pairing back out of `router_profiles` — two CLIs, one table, and a cloud
 * route that has to exist before any of it. This class is where that sequence
 * lives, so the IPC handler stays one call and neither CLI integration has to
 * know a router exists beyond the binding it reads.
 *
 * Going off is not the mirror image of going on, because the router can also go
 * off on its own — a crash, a killed process, a start that never became ready.
 * Every one of those leaves the CLIs pointed at an address that has stopped
 * answering, which is worse than never having moved them. So nothing here
 * unbinds directly: the manager's own state is the trigger, and this class
 * subscribes to it. A deliberate switch-off and a crash then take exactly the
 * same path back.
 */
export class RouterAgentIntegration {
  private readonly router: RouterProcessManager;
  private readonly binding: RouterBinding;
  private readonly cloudModels: CloudModelConnector;
  private readonly client: GatewayModelClient;
  private readonly codex: CodexGatewayIntegration;
  private readonly claude: ClaudeGatewayIntegration;
  private readonly profiles: RouterProfileStoring;

  constructor(options: {
    router: RouterProcessManager;
    binding: RouterBinding;
    cloudModels: CloudModelConnector;
    codex: CodexGatewayIntegration;
    claude: ClaudeGatewayIntegration;
    /** The gateway behind the router, read to tell a connected card from a stale profile. */
    gateway: GatewayEndpoint;
    client?: GatewayModelClient;
    /** Where the active pairing is published for the router binary to read. */
    profiles?: RouterProfileStoring;
  }) {
    this.router = options.router;
    this.binding = options.binding;
    this.cloudModels = options.cloudModels;
    this.codex = options.codex;
    this.claude = options.claude;
    this.client = options.client ?? new GatewayModelClient({ gateway: options.gateway });
    this.profiles = options.profiles ?? new SqliteRouterProfileStore();
    this.router.subscribe((state) => this.onRouterStateChanged(state));
  }

  /** The state the Router page should render right now. */
  currentState(): RouterRuntimeState {
    return this.router.currentState();
  }

  /** Subscribes to every state change; returns the unsubscribe function. */
  subscribe(listener: (state: RouterRuntimeState) => void): () => void {
    return this.router.subscribe(listener);
  }

  /**
   * Starts the router and moves both CLIs onto it.
   *
   * The order is deliberate: the process first, because its port is half of
   * what gets written; the cloud route second, because a pair naming a route
   * the gateway does not serve is a pair the router rejects on the first turn;
   * `router_profiles` third, because the router has to be able to read the
   * pairing before anything sends it a turn; the binding fourth; and the CLIs
   * last, since they render the other four.
   *
   * A failure after the process is up takes the process down again. Leaving it
   * running would show the user a switch that is on while every turn still goes
   * to the gateway — the one state that lies about where their work is going.
   */
  async turnOn(): Promise<RouterRuntimeState> {
    const started = await this.router.start();
    if (started.phase !== 'running' || started.baseUrl === null) {
      return started;
    }
    try {
      const tier = await this.resolveCloudTier();
      const model = RouterModel.forSingleModel(tier);
      await this.profiles.setActive({ localModels: [tier.routeName], cloudModels: [tier.routeName] });
      this.binding.bind(started.baseUrl, model);
      await this.republish();
      console.info(
        `[AmisRouter] Codex and Claude Code now route through ${started.baseUrl} ` +
          `as ${RouterModel.DISPLAY_NAME} (${model.description}).`
      );
      return started;
    } catch (error: unknown) {
      // The subscription undoes the binding and repoints both CLIs; this only
      // has to bring the process down and say why.
      const reason = error instanceof Error ? error.message : String(error);
      return this.router.fail(`The router could not be wired up: ${reason}`);
    }
  }

  /**
   * Stops the router. The CLIs move back to the gateway through the
   * subscription, which is the same path an unexpected exit takes.
   */
  turnOff(): RouterRuntimeState {
    return this.router.stop('switched off from the Router page');
  }

  /**
   * Moves both CLIs back to the gateway the moment the router stops serving,
   * however it stopped.
   *
   * Ignores `starting` and `running`: a binding is made by `turnOn` once the
   * router is ready, not by the states it passes through on the way there.
   */
  private onRouterStateChanged(state: RouterRuntimeState): void {
    if (state.phase === 'starting' || state.phase === 'running') return;
    if (!this.binding.isBound) return;
    this.binding.release();
    // The `router_profiles` row is left as-is: nothing reads it while the
    // router is down, and the next `turnOn` overwrites it before anything
    // could read it anyway, so there is no reason to delete it in between.
    void this.republish().catch((error: unknown) => {
      // Both integrations already swallow their own failures; this catches only
      // a rejection neither expected, and losing it would leave the CLIs
      // pointed at a router that is gone with nothing said about it.
      console.error('[AmisRouter] Could not repoint the CLIs at the gateway:', error);
    });
  }

  /**
   * Rewrites both CLIs from whatever the binding now says. One call covers both
   * directions: the binding is the only thing that differs between them.
   */
  private async republish(): Promise<void> {
    await Promise.all([this.codex.sync(), this.claude.syncSettings()]);
  }

  /**
   * The cloud half of the pair, connecting a model first if none is connected.
   *
   * A route is what the router resolves, so "which cloud model" has to be
   * answered before the switch can finish going on. An already-connected card
   * is the answer when there is one; otherwise the first card in the catalog is
   * connected on the spot, which is the behaviour that lets the Router page work
   * on its own without a trip to the Models page first.
   */
  private async resolveCloudTier(): Promise<RouterModelTier> {
    const cards = this.cloudModels.listCards();
    if (cards.length === 0) {
      throw new Error('no cloud model is available to route to');
    }
    const routeNames = new Set((await this.client.listModels()).map((route) => route.modelName));
    const connected = cards.find((card) => routeNames.has(CloudModelConnector.routeNameFor(card)));
    const card = connected ?? cards[0];
    if (!connected) {
      console.info(`[AmisRouter] Connecting ${card.modelName} so the router has a cloud tier.`);
      await this.cloudModels.connect(card.id);
    }
    return { routeName: CloudModelConnector.routeNameFor(card), displayName: card.modelName };
  }
}

export default RouterAgentIntegration;
