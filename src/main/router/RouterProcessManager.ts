import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import type { RouterRuntimeState } from '../../shared/types';
import type { GatewayEndpoint } from '../gateway/GatewayModelClient';
import LocalPortResolver from '../process/LocalPortResolver';
import RouterHealthProbe from './RouterHealthProbe';
import RouterRuntimeLocator from './RouterRuntimeLocator';

export interface RouterProcessManagerOptions {
  /** Supplies the `--gateway-url` the router forwards model calls to. */
  gateway: GatewayEndpoint;
  projectRoot?: string;
  resourcesPath?: string;
  locator?: RouterRuntimeLocator;
  portResolver?: LocalPortResolver;
  healthProbe?: RouterHealthProbe;
  /** Seconds to wait for the router to answer before failing the start. */
  readinessTimeoutSeconds?: number;
  /** Injected so tests can supervise a stub instead of a real binary. */
  spawnProcess?: typeof spawn;
  /** Injected so tests do not sleep through the real readiness poll. */
  delay?: (milliseconds: number) => Promise<void>;
}

type RouterStateListener = (state: RouterRuntimeState) => void;

/**
 * Owns the router subprocess behind the Router page's switch.
 *
 * The switch is the whole lifecycle: `start()` on, `stop()` off, and the state
 * published here is what the switch draws, so it never claims to be on while
 * nothing is listening. That is the one real difference from
 * `GatewayProcessManager`, which supervises a service the user never asked for
 * directly and therefore restarts it on its own with backoff. A crashed router
 * is reported as an error and left off instead: relaunching a process the user
 * can see the state of, without being asked, would fight whoever turned it off.
 *
 * The router is a client of the gateway, not a peer — it forwards every model
 * call to `--gateway-url` — so starting it starts the gateway first and fails
 * loudly when that address cannot be resolved.
 */
export class RouterProcessManager {
  /** Where the router listens unless something else already holds the port. */
  static readonly DEFAULT_PORT = 5033;
  /**
   * The token the router presents to the gateway.
   *
   * The gateway runs on loopback with no `master_key` configured and so accepts
   * any bearer token; this is the router's own default, restated here so the
   * launch does not depend on a default baked into the binary.
   */
  static readonly GATEWAY_KEY = 'sk-123456';
  private static readonly OUTPUT_TAIL_LIMIT = 30;

  private readonly gateway: GatewayEndpoint;
  private readonly locator: RouterRuntimeLocator;
  private readonly portResolver: LocalPortResolver;
  private readonly healthProbe: RouterHealthProbe;
  private readonly readinessTimeoutSeconds: number;
  private readonly spawnProcess: typeof spawn;
  private readonly delay: (milliseconds: number) => Promise<void>;
  private readonly listeners = new Set<RouterStateListener>();

  private child: ChildProcess | null = null;
  private startup: Promise<RouterRuntimeState> | null = null;
  private outputTail: string[] = [];
  private outputBuffer = '';
  private state: RouterRuntimeState = RouterProcessManager.stoppedState();

  constructor(options: RouterProcessManagerOptions) {
    const projectRoot = options.projectRoot ?? path.resolve(__dirname, '../../..');
    this.gateway = options.gateway;
    this.locator =
      options.locator ??
      new RouterRuntimeLocator({ projectRoot, resourcesPath: options.resourcesPath });
    this.portResolver =
      options.portResolver ??
      new LocalPortResolver({
        preferredPort: RouterProcessManager.DEFAULT_PORT,
        logLabel: 'AmisRouter'
      });
    this.healthProbe = options.healthProbe ?? new RouterHealthProbe();
    this.readinessTimeoutSeconds = options.readinessTimeoutSeconds ?? 20;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.delay = options.delay ?? RouterProcessManager.sleep;
  }

  /** The state the renderer draws its switch from. */
  currentState(): RouterRuntimeState {
    return this.state;
  }

  /** Subscribes to every state change; returns the unsubscribe function. */
  subscribe(listener: RouterStateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Starts the router unless it is already up, and resolves with the state the
   * caller should render. A failed start resolves with the `error` state rather
   * than rejecting: the switch has to show *something*, and the reason belongs
   * on the page next to it.
   */
  async start(): Promise<RouterRuntimeState> {
    if (this.state.phase === 'running' && this.child !== null) {
      return this.state;
    }
    if (this.startup) {
      return this.startup;
    }
    const startup = this.performStart().finally(() => {
      this.startup = null;
    });
    this.startup = startup;
    return startup;
  }

  /** Stops the router and reports the resulting state. */
  stop(reason: string): RouterRuntimeState {
    const child = this.child;
    if (!child) {
      // An error left by a failed start clears here too: the switch is off now,
      // so a stale reason must not keep showing beside it.
      return this.publish(RouterProcessManager.stoppedState());
    }
    // Clearing the handle first makes the exit handler treat this as intentional.
    this.child = null;
    child.kill('SIGTERM');
    console.info(`[AmisRouter] Router stopped: ${reason}`);
    return this.publish(RouterProcessManager.stoppedState());
  }

  /**
   * Takes the router down and reports why, for a caller that got the process up
   * but could not finish the work that made it worth having.
   *
   * The switch has to end up off either way; this is what puts the reason on
   * the page beside it instead of leaving a silent, pointless router running.
   */
  fail(reason: string): RouterRuntimeState {
    this.stop(reason);
    return this.publish({ ...RouterProcessManager.stoppedState(), phase: 'error', error: reason });
  }

  private async performStart(): Promise<RouterRuntimeState> {
    this.publish({ ...RouterProcessManager.stoppedState(), phase: 'starting' });
    try {
      const gatewayUrl = await this.resolveGatewayUrl();
      const location = this.locator.locate();
      if (!location) {
        throw new Error(
          `No router runtime was found. Searched: ${this.locator.searchPath()}`
        );
      }
      const port = await this.portResolver.resolve(location.executablePath);
      this.launch(location.executablePath, port, gatewayUrl);

      for (let attempt = 0; attempt < this.readinessTimeoutSeconds; attempt += 1) {
        if (await this.healthProbe.isHealthy(port)) {
          console.info(
            `[AmisRouter] Router ready on port ${port} (${location.source} runtime, gateway ${gatewayUrl}).`
          );
          return this.publish({
            phase: 'running',
            port,
            baseUrl: `http://127.0.0.1:${port}`,
            dashboardUrl: `http://127.0.0.1:${port}/admin/dashboard`,
            error: null
          });
        }
        // A child that already exited will never answer, so stop polling it.
        if (this.child === null) break;
        await this.delay(1000);
      }
      throw new Error(
        `Router did not become ready within ${this.readinessTimeoutSeconds}s.\n${this.diagnostics()}`
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      console.error(`[AmisRouter] Router start failed: ${message}`);
      // Whatever got as far as spawning must not outlive the failed start.
      this.terminateChild();
      return this.publish({ ...RouterProcessManager.stoppedState(), phase: 'error', error: message });
    }
  }

  /**
   * The gateway address the router forwards to. The gateway is started on the
   * way past because the router is useless without it, and a user who turns the
   * switch on right after launch would otherwise race the gateway's own boot.
   */
  private async resolveGatewayUrl(): Promise<string> {
    await this.gateway.startIfNeeded();
    const baseUrl = this.gateway.baseUrl();
    if (!baseUrl) {
      throw new Error('The local gateway is not running, so the router has nothing to route to.');
    }
    return baseUrl;
  }

  /**
   * Runs the router binary. It always binds 127.0.0.1 itself, so the launch
   * contract is just the port and the gateway it forwards to.
   */
  private launch(executablePath: string, port: number, gatewayUrl: string): void {
    this.outputTail = [];
    this.outputBuffer = '';
    const child = this.spawnProcess(
      executablePath,
      [
        '--port',
        String(port),
        '--gateway-url',
        gatewayUrl,
        '--gateway-key',
        RouterProcessManager.GATEWAY_KEY
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    // The router logs its banner and errors to stdout, not just stderr, so both
    // streams feed the tail a failure report is built from.
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.consumeOutput(chunk));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => this.consumeOutput(chunk));
    child.on('exit', (code, signal) => this.handleExit(child, code, signal));
    this.child = child;
  }

  /** Keeps only the most recent output lines, which is all a failure report needs. */
  private consumeOutput(chunk: string): void {
    this.outputBuffer += chunk;
    const lines = this.outputBuffer.split('\n');
    this.outputBuffer = lines.pop() ?? '';
    const merged = [...this.outputTail, ...lines.filter((line) => line.length > 0)];
    this.outputTail = merged.slice(-RouterProcessManager.OUTPUT_TAIL_LIMIT);
  }

  private diagnostics(): string {
    return this.outputTail.length === 0 ? 'No output was captured.' : this.outputTail.join('\n');
  }

  /**
   * Handles an exit this manager did not ask for. An intentional `stop()` clears
   * the child handle before signalling, so the identity check below fails and
   * the state it already published stands.
   */
  private handleExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) {
      return;
    }
    this.child = null;
    const reason = `Router exited unexpectedly (code ${code}, signal ${signal}).`;
    console.error(`[AmisRouter] ${reason} Recent output:\n${this.diagnostics()}`);
    // A start still polling for readiness owns the state and reports the failure
    // itself; overwriting it here would race that.
    if (this.startup === null) {
      this.publish({ ...RouterProcessManager.stoppedState(), phase: 'error', error: reason });
    }
  }

  /** Kills a child left over from a start that could not finish. */
  private terminateChild(): void {
    const child = this.child;
    if (!child) return;
    this.child = null;
    child.kill('SIGTERM');
  }

  /** Records the new state and hands it to every subscriber. */
  private publish(state: RouterRuntimeState): RouterRuntimeState {
    this.state = state;
    this.listeners.forEach((listener) => listener(state));
    return state;
  }

  private static stoppedState(): RouterRuntimeState {
    return { phase: 'stopped', port: null, baseUrl: null, dashboardUrl: null, error: null };
  }

  private static sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}

export default RouterProcessManager;
