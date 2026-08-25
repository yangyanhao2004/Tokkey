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

/** Process abstraction used by installers and detection so they remain testable. */
export interface ShellRunner {
  run(command: string, options: ShellRunOptions): Promise<ShellRunResult>;
}

/** Result of one installation or uninstall operation. */
export interface AgentOperationResult extends ShellRunResult {
  kind: 'success' | 'failure';
  agent: ShellAgent;
  error: string | null;
}

/** Durable detector output used by AgentManager. */
export interface AgentDetection {
  agent: ShellAgent;
  installed: boolean;
  executablePath: string | null;
  error: string | null;
}

/** Lifecycle states exposed by AgentManager. */
export type AgentLifecycleState = 'notInstalled' | 'installing' | 'installed';

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
  | { kind: 'progress'; agent: ShellAgent; line: string }
  | { kind: 'availability-changed'; agent: ShellAgent; installed: boolean };
