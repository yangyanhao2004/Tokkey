import type { AgentDetection, ShellAgent, ShellRunResult, ShellRunner } from './AgentTypes';
import StreamingShellRunner from './StreamingShellRunner';

export interface AgentDetectorOptions {
  shellRunner?: ShellRunner;
  timeoutMs?: number;
}

/** Finds Codex and Claude executables through the same shell boundary as installs. */
export class AgentDetector {
  private readonly shellRunner: ShellRunner;
  private readonly timeoutMs: number;
  private readonly cache = new Map<ShellAgent, AgentDetection>();

  constructor(shellRunner?: ShellRunner, timeoutMs?: number);
  constructor(options?: AgentDetectorOptions);
  constructor(shellRunnerOrOptions: ShellRunner | AgentDetectorOptions = {}, timeoutMs = 8000) {
    if ('run' in shellRunnerOrOptions) {
      this.shellRunner = shellRunnerOrOptions;
      this.timeoutMs = timeoutMs;
      return;
    }
    this.shellRunner = shellRunnerOrOptions.shellRunner ?? new StreamingShellRunner();
    this.timeoutMs = shellRunnerOrOptions.timeoutMs ?? timeoutMs;
  }

  /** Detects one agent, caching the live PATH result until invalidated. */
  async detect(agent: ShellAgent): Promise<AgentDetection> {
    this.assertAgent(agent);
    const cached = this.cache.get(agent);
    if (cached) return { ...cached };
    const result = await this.shellRunner.run(`which ${agent}`, {
      shell: '/bin/bash',
      login: true,
      timeoutMs: this.timeoutMs
    });
    const detection = this.toDetection(agent, result);
    this.cache.set(agent, detection);
    return { ...detection };
  }

  /** Detects both supported agents in parallel because the probes are independent. */
  async detectAll(): Promise<Record<ShellAgent, AgentDetection>> {
    const [codex, claude] = await Promise.all([this.detect('codex'), this.detect('claude')]);
    return { codex, claude };
  }

  /** Clears one cached result or all cached results after installation/removal. */
  invalidate(agent?: ShellAgent): void {
    if (agent) this.cache.delete(agent);
    else this.cache.clear();
  }

  private toDetection(agent: ShellAgent, result: ShellRunResult): AgentDetection {
    const executablePath = result.output.map((line) => line.trim()).find((line) => line.length > 0) ?? null;
    const installed = result.exitCode === 0 && !result.timedOut && executablePath !== null;
    return {
      agent,
      installed,
      executablePath: installed ? executablePath : null,
      error: installed ? null : this.failureMessage(agent, result)
    };
  }

  private failureMessage(agent: ShellAgent, result: ShellRunResult): string {
    if (result.timedOut) return `Timed out while detecting ${agent}.`;
    return result.diagnosticTail?.join('\n') || `${agent} is not installed.`;
  }

  /** Keeps JavaScript callers from probing arbitrary shell commands. */
  private assertAgent(agent: ShellAgent): void {
    if (agent !== 'codex' && agent !== 'claude') throw new TypeError(`Unsupported agent: ${String(agent)}`);
  }
}

export default AgentDetector;
