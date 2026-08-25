import AgentDetector from './AgentDetector';
import ShellAgentInstaller from './ShellAgentInstaller';
import StreamingShellRunner from './StreamingShellRunner';
import type {
  AgentDetection,
  AgentManagerEvent,
  AgentOperationResult,
  AgentState,
  ShellAgent
} from './AgentTypes';
import type { AgentInstaller } from './AgentInstaller';

export interface AgentDetectorLike {
  detect(agent: ShellAgent): Promise<AgentDetection>;
  invalidate(agent?: ShellAgent): void;
}

export interface AgentManagerOptions {
  detector?: AgentDetectorLike;
  installer?: AgentInstaller;
  supportedAgents?: readonly ShellAgent[];
  onEvent?: (event: AgentManagerEvent) => void;
}

type AgentStateListener = (event: AgentManagerEvent) => void;

/** Owns detection cache, lifecycle transitions, concurrency, and progress events. */
export class AgentManager {
  private static readonly DEFAULT_AGENTS: readonly ShellAgent[] = ['codex', 'claude'];
  private readonly detector: AgentDetectorLike;
  private readonly installer: AgentInstaller;
  private readonly supportedAgents: readonly ShellAgent[];
  private readonly listeners = new Set<AgentStateListener>();
  private readonly states = new Map<ShellAgent, AgentState>();

  constructor(options?: AgentManagerOptions);
  constructor(detector: AgentDetectorLike, installer: AgentInstaller);
  constructor(optionsOrDetector: AgentManagerOptions | AgentDetectorLike = {}, installer?: AgentInstaller) {
    if (AgentManager.isDetector(optionsOrDetector)) {
      this.detector = optionsOrDetector;
      this.installer = installer ?? new ShellAgentInstaller(new StreamingShellRunner());
      this.supportedAgents = [...AgentManager.DEFAULT_AGENTS];
    } else {
      this.detector = optionsOrDetector.detector ?? new AgentDetector(new StreamingShellRunner());
      this.installer = optionsOrDetector.installer ?? new ShellAgentInstaller(new StreamingShellRunner());
      this.supportedAgents = [...(optionsOrDetector.supportedAgents ?? AgentManager.DEFAULT_AGENTS)];
      if (optionsOrDetector.onEvent) this.listeners.add(optionsOrDetector.onEvent);
    }
    this.supportedAgents.forEach((agent) => this.states.set(agent, this.defaultState(agent)));
  }

  /** Refreshes PATH truth and publishes installed/notInstalled transitions. */
  async refresh(agent?: ShellAgent): Promise<AgentState | Record<ShellAgent, AgentState>> {
    if (agent) return this.refreshOne(agent);
    const detections = await Promise.all(this.supportedAgents.map((supportedAgent) => this.detector.detect(supportedAgent)));
    const refreshed = {} as Record<ShellAgent, AgentState>;
    for (const detection of detections) {
      refreshed[detection.agent] = this.applyDetection(detection);
    }
    return refreshed;
  }

  /** Returns a defensive copy of the current state for one agent. */
  state(agent: ShellAgent): AgentState {
    this.assertSupported(agent);
    return { ...this.states.get(agent)! };
  }

  /** Returns all current state snapshots without exposing internal mutable maps. */
  statesSnapshot(): Record<ShellAgent, AgentState> {
    return Object.fromEntries(this.supportedAgents.map((agent) => [agent, this.state(agent)])) as Record<ShellAgent, AgentState>;
  }

  /** Subscribes a controller/service to state and progress events. */
  subscribe(listener: AgentStateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Installs only from notInstalled, then marks success based on process outcome. */
  async install(agent: ShellAgent, onLine?: (line: string) => void): Promise<AgentOperationResult> {
    this.assertSupported(agent);
    const current = this.states.get(agent)!;
    if (current.state !== 'notInstalled') {
      throw new Error(`${agent} installation is only allowed from notInstalled; current state is ${current.state}.`);
    }
    this.publishState({ ...current, state: 'installing', error: null });
    const result = await this.runOperation(() => this.installer.install(agent, (line) => {
      onLine?.(line);
      this.publish({ kind: 'progress', agent, line });
    }), agent);
    if (result.kind === 'success') {
      this.detector.invalidate(agent);
      this.publishState({
        ...current,
        state: 'installed',
        // Installation success is the immediate operation result; the next
        // explicit detector refresh remains the durable PATH truth.
        executablePath: current.executablePath,
        error: null
      });
      this.publish({ kind: 'availability-changed', agent, installed: true });
      return result;
    }
    this.publishState({ ...current, state: 'notInstalled', error: result.error });
    return result;
  }

  /** Removes only the executable and returns to notInstalled on success. */
  async uninstall(agent: ShellAgent, onLine?: (line: string) => void): Promise<AgentOperationResult> {
    this.assertSupported(agent);
    const current = this.states.get(agent)!;
    if (current.state === 'installing') {
      throw new Error(`Cannot uninstall ${agent} while installation is in progress.`);
    }
    const result = await this.runOperation(() => this.installer.uninstall(agent, (line) => {
      onLine?.(line);
      this.publish({ kind: 'progress', agent, line });
    }), agent);
    if (result.kind === 'success') {
      this.detector.invalidate(agent);
      this.publishState({ ...current, state: 'notInstalled', executablePath: null, error: null });
      this.publish({ kind: 'availability-changed', agent, installed: false });
    } else {
      this.publishState({ ...current, error: result.error });
    }
    return result;
  }

  private async refreshOne(agent: ShellAgent): Promise<AgentState> {
    this.assertSupported(agent);
    return this.applyDetection(await this.detector.detect(agent));
  }

  private applyDetection(detection: AgentDetection): AgentState {
    const current = this.states.get(detection.agent)!;
    const next: AgentState = {
      ...current,
      state: detection.installed ? 'installed' : 'notInstalled',
      executablePath: detection.executablePath,
      error: detection.installed ? null : detection.error
    };
    this.publishState(next);
    return { ...next };
  }

  private defaultState(agent: ShellAgent): AgentState {
    return { agent, state: 'notInstalled', supported: true, executablePath: null, error: null };
  }

  private assertSupported(agent: ShellAgent): void {
    if (!this.supportedAgents.includes(agent)) throw new Error(`Unsupported agent: ${agent}`);
  }

  private publishState(state: AgentState): void {
    this.states.set(state.agent, { ...state });
    this.publish({ kind: 'state', state: { ...state } });
  }

  private publish(event: AgentManagerEvent): void {
    this.listeners.forEach((listener) => listener(event));
  }

  /** Distinguishes the two supported constructor forms without unsafe casts. */
  private static isDetector(value: AgentManagerOptions | AgentDetectorLike): value is AgentDetectorLike {
    return 'detect' in value && typeof value.detect === 'function';
  }

  /** Normalizes unexpected process-boundary throws into the failure contract. */
  private async runOperation(
    operation: () => Promise<AgentOperationResult>,
    agent: ShellAgent
  ): Promise<AgentOperationResult> {
    try {
      return await operation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        kind: 'failure',
        agent,
        error: message,
        exitCode: null,
        timedOut: false,
        output: [],
        diagnosticTail: [message]
      };
    }
  }
}

export type {
  AgentDetection,
  AgentManagerEvent,
  AgentOperationResult,
  AgentState,
  AgentLifecycleState,
  ShellAgent,
  ShellRunOptions,
  ShellRunResult,
  ShellRunner
} from './AgentTypes';

export default AgentManager;
