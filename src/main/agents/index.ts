import AgentDetector from './AgentDetector';
import AgentManager from './AgentManager';
import DesktopAppDetector from './DesktopAppDetector';
import InstalledAgentGate from './InstalledAgentGate';
import StreamingShellRunner from './StreamingShellRunner';
import { ShellRunner } from './ShellRunner';

export { AgentDetector, AgentManager, DesktopAppDetector, InstalledAgentGate, StreamingShellRunner, ShellRunner };
export { CATALOG_AGENTS } from './InstalledAgentGate';
export type { AgentDetectorOptions, DesktopAppLocating } from './AgentDetector';
export type { DesktopAppDetectorOptions } from './DesktopAppDetector';
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
