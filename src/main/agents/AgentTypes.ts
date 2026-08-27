/** Supported shell agents managed by the Electron main process. */
export type ShellAgent = 'codex' | 'claude';

/** Result returned by a shell command, including the diagnostic tail. */
export interface ShellRunResult {
  exitCode: number | null;
  timedOut: boolean;
  output: string[];
  /** Optional for lightweight test doubles; real runners always provide it. */
  diagnosticTail?: string[];
}

/** Options accepted by the reusable shell process boundary. */
export interface ShellRunOptions {
  shell: '/bin/bash' | '/bin/zsh';
  login: boolean;
  interactive?: boolean;
  timeoutMs: number;
  onLine?: (line: string) => void;
  signal?: AbortSignal;
}

/** Process abstraction used by detection so it remains testable. */
export interface ShellRunner {
  run(command: string, options: ShellRunOptions): Promise<ShellRunResult>;
}

/** Durable detector output used by AgentManager. */
export interface AgentDetection {
  agent: ShellAgent;
  installed: boolean;
  executablePath: string | null;
  error: string | null;
}

/** Lifecycle states exposed by AgentManager; the app only observes, never installs. */
export type AgentLifecycleState = 'notInstalled' | 'installed';

/** Current state for one managed agent. */
export interface AgentState {
  agent: ShellAgent;
  state: AgentLifecycleState;
  supported: boolean;
  executablePath: string | null;
  error: string | null;
}

/** Events delivered to non-UI consumers of AgentManager. */
export type AgentManagerEvent =
  | { kind: 'state'; state: AgentState }
  | { kind: 'availability-changed'; agent: ShellAgent; installed: boolean };
