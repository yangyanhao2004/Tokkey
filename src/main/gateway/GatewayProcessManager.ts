import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import GatewayHealthProbe from './GatewayHealthProbe';
import GatewayPortResolver from './GatewayPortResolver';
import GatewayRuntimeLocator from './GatewayRuntimeLocator';

/** Contract version the gateway must report; mirrors `GATEWAY_RUNTIME_PROTOCOL_VERSION`. */
export const GATEWAY_RUNTIME_PROTOCOL_VERSION = 1;

export interface GatewayProcessManagerOptions {
  projectRoot?: string;
  resourcesPath?: string;
  locator?: GatewayRuntimeLocator;
  portResolver?: GatewayPortResolver;
  /** Built from the launch identity once the manager knows its master key. */
  healthProbe?: GatewayHealthProbe;
  /** Seconds to wait for the gateway to answer before failing the launch. */
  readinessTimeoutSeconds?: number;
  /** Injected so tests can supervise a stub instead of a real interpreter. */
  spawnProcess?: typeof spawn;
  /** Injected so tests do not sleep through the real restart backoff. */
  delay?: (milliseconds: number) => Promise<void>;
}

export interface GatewayRuntimeState {
  phase: 'stopped' | 'starting' | 'running' | 'error';
  error: string | null;
}

type GatewayStateListener = (state: GatewayRuntimeState) => void;

/** Raised when the gateway cannot be started, carrying launch diagnostics. */
export class GatewayStartupError extends Error {
  constructor(message: string, readonly diagnostics: string) {
    super(diagnostics ? `${message}\n${diagnostics}` : message);
    this.name = 'GatewayStartupError';
  }
}

/**
 * Owns the single local gateway subprocess for this app launch.
 *
 * A per-launch identity means a healthy listener is adopted only when it is
 * this launch's own helper, never an orphan left by a previous run. An
 * unexpected exit is relaunched with exponential backoff so a mid-session crash
 * does not leave the app without model routing until someone restarts it, while
 * an explicit `stop()` keeps the gateway down until it is asked for again.
 */
export class GatewayProcessManager {
  private static readonly STDERR_TAIL_LIMIT = 30;
  /**
   * Read/write deadline LiteLLM applies to every upstream call, in seconds.
   *
   * Without `REQUEST_TIMEOUT` in the environment LiteLLM falls back to 600s for
   * chat completions, which a long reasoning or tool-using turn can outrun and
   * surface to the client as a 408. Thirty minutes covers those turns while
   * still bounding a genuinely hung upstream.
   */
  private static readonly UPSTREAM_REQUEST_TIMEOUT_SECONDS = 1800;
  private static readonly MAX_RESTART_ATTEMPTS = 5;
  private static readonly RESTART_BASE_SECONDS = 2;
  private static readonly RESTART_CAP_SECONDS = 60;

  // The launch identity stays random: it is what tells this launch's helper
  // apart from an orphan left behind by a previous one.
  private readonly instanceId = randomUUID();
  private readonly locator: GatewayRuntimeLocator;
  private readonly portResolver: GatewayPortResolver;
  private readonly healthProbe: GatewayHealthProbe;
  private readonly readinessTimeoutSeconds: number;
  private readonly spawnProcess: typeof spawn;
  private readonly delay: (milliseconds: number) => Promise<void>;

  private child: ChildProcess | null = null;
  private startup: Promise<void> | null = null;
  private stderrTail: string[] = [];
  private stderrBuffer = '';
  private port: number | null = null;
  private restartAttempts = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private state: GatewayRuntimeState = { phase: 'stopped', error: null };
  private readonly listeners = new Set<GatewayStateListener>();

  constructor(options: GatewayProcessManagerOptions = {}) {
    const projectRoot = options.projectRoot ?? path.resolve(__dirname, '../../..');
    this.locator =
      options.locator ??
      new GatewayRuntimeLocator({ projectRoot, resourcesPath: options.resourcesPath });
    this.portResolver = options.portResolver ?? new GatewayPortResolver();
    this.healthProbe =
      options.healthProbe ??
      new GatewayHealthProbe({
        instanceId: this.instanceId,
        protocolVersion: GATEWAY_RUNTIME_PROTOCOL_VERSION
      });
    this.readinessTimeoutSeconds = options.readinessTimeoutSeconds ?? 90;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.delay = options.delay ?? GatewayProcessManager.sleep;
  }

  /** Base URL clients should call, available only once the gateway is running. */
  baseUrl(): string | null {
    return this.port === null ? null : `http://127.0.0.1:${this.port}`;
  }

  currentState(): GatewayRuntimeState {
    return { ...this.state };
  }

  subscribe(listener: GatewayStateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Starts the gateway unless this launch already owns a healthy instance. */
  async startIfNeeded(): Promise<void> {
    this.stopped = false;
    if (this.port !== null && (await this.healthProbe.isHealthy(this.port))) {
      this.restartAttempts = 0;
      return;
    }
    if (this.startup) {
      return this.startup;
    }
    const startup = this.performStartup().finally(() => {
      this.startup = null;
    });
    this.startup = startup;
    return startup;
  }

  /** Stops the owned process and cancels any pending crash restart. */
  stop(reason: string): void {
    this.stopped = true;
    this.clearRestartTimer();
    const child = this.child;
    if (!child) {
      this.publish({ phase: 'stopped', error: null });
      return;
    }
    // Clearing the handle first makes the exit handler treat this as intentional.
    this.child = null;
    this.port = null;
    child.kill('SIGTERM');
    this.publish({ phase: 'stopped', error: null });
    console.info(`[AmisGateway] Gateway stopped: ${reason}`);
  }

  private async performStartup(): Promise<void> {
    this.publish({ phase: 'starting', error: null });
    try {
      await this.launchAndWaitForReadiness();
    } catch (error) {
      this.publish({
        phase: 'error',
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  private async launchAndWaitForReadiness(): Promise<void> {
    const location = this.locator.locate();
    if (!location) {
      throw new GatewayStartupError(
        'No gateway runtime was found.',
        `Searched: ${this.locator.searchPath()}\n` +
          'Run `npm run gateway:freeze` to build it, or set AMIS_GATEWAY_EXECUTABLE.'
      );
    }
    const port = await this.portResolver.resolve(location.executablePath);
    this.launch(location.executablePath, port);

    for (let attempt = 0; attempt < this.readinessTimeoutSeconds; attempt += 1) {
      if (await this.healthProbe.isHealthy(port)) {
        this.port = port;
        this.restartAttempts = 0;
        this.publish({ phase: 'running', error: null });
        console.info(`[AmisGateway] Gateway ready on port ${port} (${location.source} runtime).`);
        return;
      }
      await this.delay(1000);
    }

    const diagnostics = this.diagnostics();
    this.stop('readiness timeout');
    throw new GatewayStartupError(
      `Gateway did not become ready within ${this.readinessTimeoutSeconds}s.`,
      diagnostics
    );
  }

  /**
   * Runs the frozen gateway executable, so no user PATH, Homebrew package, or
   * globally installed Python is involved. The bundle carries its own
   * interpreter, so the launch contract is just the host and port.
   */
  private launch(executablePath: string, port: number): void {
    this.stderrTail = [];
    this.stderrBuffer = '';
    const child = this.spawnProcess(
      executablePath,
      ['--host', '127.0.0.1', '--port', String(port)],
      {
        env: this.gatewayEnvironment(),
        stdio: ['ignore', 'ignore', 'pipe']
      }
    );
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => this.consumeStderr(chunk));
    child.on('exit', (code, signal) => this.handleExit(child, code, signal));
    this.child = child;
  }

  /**
   * Environment for the gateway subprocess.
   *
   * `LITELLM_LOCAL_MODEL_COST_MAP` forces LiteLLM to read the cost and context
   * map bundled inside its own package instead of fetching it from GitHub at
   * startup: this is an offline-first loopback service, and that fetch would
   * otherwise stall boot whenever the network or a configured proxy is slow.
   * `REQUEST_TIMEOUT` raises LiteLLM's upstream deadline off its 600s default,
   * and an inherited value wins so an operator can still tune it from the
   * launching shell.
   *
   * `PYTHONDONTWRITEBYTECODE` used to be set here to keep the interpreter from
   * writing `__pycache__` into a signed, read-only app bundle. The frozen
   * bundle ships no `.py` files — modules are loaded from the archive inside
   * the executable — so there is nothing left to byte-compile.
   */
  private gatewayEnvironment(): NodeJS.ProcessEnv {
    return {
      REQUEST_TIMEOUT: String(GatewayProcessManager.UPSTREAM_REQUEST_TIMEOUT_SECONDS),
      ...process.env,
      LITELLM_LOCAL_MODEL_COST_MAP: 'True',
      AMIS_GATEWAY_INSTANCE_ID: this.instanceId
    };
  }

  /** Keeps only the most recent stderr lines, which is all a failure report needs. */
  private consumeStderr(chunk: string): void {
    this.stderrBuffer += chunk;
    const lines = this.stderrBuffer.split('\n');
    this.stderrBuffer = lines.pop() ?? '';
    const merged = [...this.stderrTail, ...lines.filter((line) => line.length > 0)];
    this.stderrTail = merged.slice(-GatewayProcessManager.STDERR_TAIL_LIMIT);
  }

  private diagnostics(): string {
    return this.stderrTail.length === 0 ? 'No stderr was captured.' : this.stderrTail.join('\n');
  }

  /**
   * Handles an exit that this manager did not ask for. An intentional `stop()`
   * clears the child handle before signalling, so the identity check below
   * fails and no restart is scheduled.
   */
  private handleExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) {
      return;
    }
    this.child = null;
    this.port = null;
    this.publish({
      phase: 'error',
      error: `Gateway exited unexpectedly (code ${code}, signal ${signal}).`
    });
    console.error(
      `[AmisGateway] Gateway exited unexpectedly (code ${code}, signal ${signal}). ` +
        `Recent stderr:\n${this.diagnostics()}`
    );
    this.scheduleRestart();
  }

  /**
   * Queues one delayed relaunch. The attempt cap only halts a genuine crash
   * loop: the counter resets on every successful start, and an explicit
   * `startIfNeeded()` still works after the supervisor has given up.
   */
  private scheduleRestart(): void {
    if (this.stopped || this.restartTimer !== null) {
      return;
    }
    if (this.restartAttempts >= GatewayProcessManager.MAX_RESTART_ATTEMPTS) {
      console.error(
        `[AmisGateway] Gateway crashed ${this.restartAttempts} times in a row; ` +
          'automatic restarts are paused until the next explicit start.'
      );
      this.restartAttempts = 0;
      return;
    }
    this.restartAttempts += 1;
    const delaySeconds = this.restartDelaySeconds(this.restartAttempts);
    console.info(
      `[AmisGateway] Restarting gateway in ${delaySeconds.toFixed(1)}s (attempt ${this.restartAttempts}).`
    );
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.startIfNeeded().catch((error: unknown) => {
        console.error('[AmisGateway] Automatic gateway restart failed:', error);
        this.scheduleRestart();
      });
    }, delaySeconds * 1000);
    this.restartTimer.unref?.();
  }

  /** Exponential backoff with jitter, so repeated crashes do not busy-loop. */
  private restartDelaySeconds(attempt: number): number {
    const exponential = Math.min(
      GatewayProcessManager.RESTART_BASE_SECONDS ** attempt,
      GatewayProcessManager.RESTART_CAP_SECONDS
    );
    return exponential * (1 + (Math.random() - 0.5) * 0.4);
  }

  private clearRestartTimer(): void {
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  private publish(state: GatewayRuntimeState): void {
    this.state = { ...state };
    const snapshot = this.currentState();
    this.listeners.forEach((listener) => listener(snapshot));
  }

  private static sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}

export default GatewayProcessManager;
