import AgentDetector from './AgentDetector';
import StreamingShellRunner from './StreamingShellRunner';
import type {
  AgentDetection,
  AgentManagerEvent,
  AgentState,
  ShellAgent
} from './AgentTypes';

export interface AgentDetectorLike {
  detect(agent: ShellAgent): Promise<AgentDetection>;
  invalidate(agent?: ShellAgent): void;
}

export interface AgentManagerOptions {
  detector?: AgentDetectorLike;
  supportedAgents?: readonly ShellAgent[];
  onEvent?: (event: AgentManagerEvent) => void;
}

type AgentStateListener = (event: AgentManagerEvent) => void;

/** Owns the detection cache and publishes installed/notInstalled state for each agent. */
export class AgentManager {
  private static readonly DEFAULT_AGENTS: readonly ShellAgent[] = ['codex', 'claude'];
  private readonly detector: AgentDetectorLike;
  private readonly supportedAgents: readonly ShellAgent[];
  private readonly listeners = new Set<AgentStateListener>();
  private readonly states = new Map<ShellAgent, AgentState>();

  constructor(options: AgentManagerOptions = {}) {
    this.detector = options.detector ?? new AgentDetector(new StreamingShellRunner());
    this.supportedAgents = [...(options.supportedAgents ?? AgentManager.DEFAULT_AGENTS)];
    if (options.onEvent) this.listeners.add(options.onEvent);
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

  /** Drops cached detections so the next refresh re-probes PATH. */
  invalidate(agent?: ShellAgent): void {
    this.detector.invalidate(agent);
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

  /** Subscribes a controller/service to state events. */
  subscribe(listener: AgentStateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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
    const availabilityChanged = current.state !== next.state;
    this.publishState(next);
    if (availabilityChanged) {
      this.publish({ kind: 'availability-changed', agent: next.agent, installed: detection.installed });
    }
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
}

export type {
  AgentDetection,
  AgentManagerEvent,
  AgentState,
  AgentLifecycleState,
  ShellAgent,
  ShellRunOptions,
  ShellRunResult,
  ShellRunner
} from './AgentTypes';

export default AgentManager;
