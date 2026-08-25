import AgentDetector from './AgentDetector';
import AgentManager from './AgentManager';
import ShellAgentInstaller from './ShellAgentInstaller';
import StreamingShellRunner from './StreamingShellRunner';
import { ShellRunner } from './ShellRunner';
import AgentInstaller from './AgentInstaller';

export { AgentDetector, AgentManager, ShellAgentInstaller, StreamingShellRunner, ShellRunner, AgentInstaller };
export type { AgentDetectorOptions } from './AgentDetector';
export type { AgentDetectorLike, AgentManagerOptions } from './AgentManager';
export type { ShellAgentInstallerOptions } from './ShellAgentInstaller';
export type { StreamingShellRunnerOptions } from './StreamingShellRunner';
export type {
  AgentDetection,
  AgentLifecycleState,
  AgentManagerEvent,
  AgentOperationResult,
  AgentState,
  ShellAgent,
  ShellRunOptions,
  ShellRunResult,
  ShellRunner as ShellRunnerContract
} from './AgentTypes';
