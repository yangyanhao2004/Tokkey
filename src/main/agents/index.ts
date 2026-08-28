import AgentDetector from './AgentDetector';
import AgentManager from './AgentManager';
import InstalledAgentGate from './InstalledAgentGate';
import StreamingShellRunner from './StreamingShellRunner';
import { ShellRunner } from './ShellRunner';

export { AgentDetector, AgentManager, InstalledAgentGate, StreamingShellRunner, ShellRunner };
export { CATALOG_AGENTS } from './InstalledAgentGate';
export type { AgentDetectorOptions } from './AgentDetector';
export type {
  CatalogAgent,
  InstalledAgentGateOptions,
  InstalledAgentGating
} from './InstalledAgentGate';
export type { AgentDetectorLike, AgentManagerOptions } from './AgentManager';
export type { StreamingShellRunnerOptions } from './StreamingShellRunner';
export type {
  AgentDetection,
  AgentLifecycleState,
  AgentManagerEvent,
  AgentState,
  ShellAgent,
  ShellRunOptions,
  ShellRunResult,
  ShellRunner as ShellRunnerContract
} from './AgentTypes';
