import type { AgentOperationResult, ShellAgent } from './AgentTypes';

/** Communication-layer contract implemented by shell-backed agent installers. */
export abstract class AgentInstaller {
  abstract install(agent: ShellAgent, onLine?: (line: string) => void): Promise<AgentOperationResult>;
  abstract uninstall(agent: ShellAgent, onLine?: (line: string) => void): Promise<AgentOperationResult>;
}

export type { AgentOperationResult, ShellAgent } from './AgentTypes';

export default AgentInstaller;
