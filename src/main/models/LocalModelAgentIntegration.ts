import type { LocalModelRuntimeState } from '../../shared/types';
import type ClaudeGatewayIntegration from '../claude/ClaudeGatewayIntegration';
import type CodexGatewayIntegration from '../codex/CodexGatewayIntegration';
import type { HubModelConnecting, RunningHubModel } from './HubModelConnector';
import LocalModel from './LocalModel';
import type LocalModelBinding from './LocalModelBinding';
import type { LocalModelRuntime } from './LocalModelRuntime';

/**
 * Turns a running local model into a row in both CLIs' model pickers.
 *
 * The counterpart of `RouterAgentIntegration`, and shaped the same way: one
 * class owns everything that has to change when a model starts serving or stops,
 * so neither CLI integration has to know a local runtime exists beyond the
 * binding it reads.
 *
 * It sits in the position the bare `HubModelConnector` used to occupy — it *is*
 * the runtime's `profileConnector` — and delegates the route work to that
 * connector before publishing. Wrapping rather than subscribing to the `running`
 * phase is deliberate: `TokenHubRuntime` publishes `running` *before* it awaits
 * its profile synchronization, so a row published off that phase would advertise
 * a model whose route does not exist yet. Wrapping also inherits the runtime's
 * existing contract for this call — a throw here is reported on the runtime's
 * state without tearing down a server that is up and answering.
 *
 * Going away is not the mirror image of arriving, because a local model can also
 * stop on its own — a crashed llama-server, a Dongle pulled out of the port. All
 * of those leave both pickers offering a row that resolves to nothing. So the
 * removal is not driven by whoever asked for the stop: the runtime's own state
 * is the trigger, exactly as in `RouterAgentIntegration`, and a deliberate Stop
 * and a yanked Dongle take one identical path back.
 */
export class LocalModelAgentIntegration implements HubModelConnecting {
  private readonly connector: HubModelConnecting;
  private readonly binding: LocalModelBinding;
  private readonly codex: CodexGatewayIntegration;
  private readonly claude: ClaudeGatewayIntegration;
  private unsubscribe: (() => void) | null = null;

  constructor(options: {
    /** Does the actual gateway route work; this class only decides when. */
    connector: HubModelConnecting;
    /** What both CLI integrations read to decide whether to publish the row. */
    binding: LocalModelBinding;
    codex: CodexGatewayIntegration;
    claude: ClaudeGatewayIntegration;
  }) {
    this.connector = options.connector;
    this.binding = options.binding;
    this.codex = options.codex;
    this.claude = options.claude;
  }

  /**
   * Starts watching the runtime for the model going away.
   *
   * Separate from the constructor because the runtime takes this object as its
   * profile connector: each needs the other, so the wrapping goes in at
   * construction and the subscription once both exist. Calling it twice
   * replaces the first subscription rather than adding a second.
   */
  observe(runtime: LocalModelRuntime): void {
    this.unsubscribe?.();
    this.unsubscribe = runtime.subscribe((state) => this.onRuntimeStateChanged(state));
  }

  /** Stops watching. For a caller tearing the wiring down, such as a test. */
  stopObserving(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /**
   * Routes the now-ready server through the gateway, then offers it in both
   * pickers.
   *
   * The order is the whole point: the route has to resolve before either CLI is
   * told the row exists, or the first turn sent to it is a 404. A failed route
   * leaves nothing published, since the throw skips everything below it.
   */
  async connect(model: RunningHubModel): Promise<void> {
    await this.connector.connect(model);
    this.binding.bind(new LocalModel(model.displayName));
    await this.republish();
    console.info(
      `[LocalModel] Codex and Claude Code now offer ${LocalModel.DISPLAY_NAME} (${model.displayName}).`
    );
  }

  /**
   * Removes the row and the route together. Safe to call with nothing bound.
   *
   * The reverse of `connect`'s order, and for the same reason. There the route
   * has to exist before anything advertises it; here the advertisement has to
   * go before the route does. A deletion that then fails costs an orphaned route
   * pointing at a dead port that nothing offers any more — where the other order
   * would leave both pickers offering a row whose route is already gone.
   */
  async disconnect(): Promise<void> {
    this.binding.release();
    await this.republish();
    await this.connector.disconnect();
  }

  /**
   * Takes the row back out the moment the runtime stops serving, however it
   * stopped.
   *
   * Ignores `starting` and `running`: the row is published by `connect` once the
   * route exists, not by the phases the runtime passes through on the way there.
   */
  private onRuntimeStateChanged(state: LocalModelRuntimeState): void {
    if (state.phase === 'starting' || state.phase === 'running') return;
    if (!this.binding.isBound) return;
    void this.disconnect().catch((error: unknown) => {
      // Both CLI integrations already swallow their own failures, so this only
      // catches a rejection neither expected — most likely the route deletion.
      // Losing it would leave a dead route behind with nothing said about it.
      console.error('[LocalModel] Could not withdraw the local model:', error);
    });
  }

  /**
   * Rewrites both CLIs from whatever the binding now says. One call covers
   * publishing and withdrawal alike: the binding is all that differs.
   */
  private async republish(): Promise<void> {
    await Promise.all([this.codex.sync(), this.claude.syncSettings()]);
  }
}

export default LocalModelAgentIntegration;
