import StreamingShellRunner from './StreamingShellRunner';

/** Runtime alias for consumers that prefer the contract name as a constructor. */
export class ShellRunner extends StreamingShellRunner {}

/** Public communication-layer implementation name for the shell process boundary. */
export { StreamingShellRunner };
export type { ShellRunOptions, ShellRunResult, ShellRunner as ShellRunnerContract } from './AgentTypes';
