import type { AgentDetection, ShellAgent, ShellRunResult, ShellRunner } from './AgentTypes';
import DesktopAppDetector from './DesktopAppDetector';
import StreamingShellRunner from './StreamingShellRunner';

/** Only the lookup AgentDetector needs, so tests can stand in a plain object. */
export interface DesktopAppLocating {
  locate(agent: ShellAgent): string | null;
}

export interface AgentDetectorOptions {
  shellRunner?: ShellRunner;
  timeoutMs?: number;
  desktopApps?: DesktopAppLocating;
}

/**
 * Finds Codex and Claude on this machine, by CLI or by desktop app.
 *
 * An agent counts as installed when either surface is present: the CLI on PATH
 * or the desktop app bundle. Users commonly have only one of the two, and both
 * are equally usable, so requiring the CLI would grey out agents that are there.
 */
export class AgentDetector {
  private readonly shellRunner: ShellRunner;
  private readonly desktopApps: DesktopAppLocating;
  private readonly timeoutMs: number;
  private readonly cache = new Map<ShellAgent, AgentDetection>();
  /** Probes still running, so concurrent callers share one login shell each. */
  private readonly pendingProbes = new Map<ShellAgent, Promise<AgentDetection>>();

  constructor(shellRunner?: ShellRunner, timeoutMs?: number);
  constructor(options?: AgentDetectorOptions);
  constructor(shellRunnerOrOptions: ShellRunner | AgentDetectorOptions = {}, timeoutMs = 8000) {
    if ('run' in shellRunnerOrOptions) {
      this.shellRunner = shellRunnerOrOptions;
      this.desktopApps = new DesktopAppDetector();
      this.timeoutMs = timeoutMs;
      return;
    }
    this.shellRunner = shellRunnerOrOptions.shellRunner ?? new StreamingShellRunner();
    this.desktopApps = shellRunnerOrOptions.desktopApps ?? new DesktopAppDetector();
    this.timeoutMs = shellRunnerOrOptions.timeoutMs ?? timeoutMs;
  }

  /**
   * Detects one agent, caching the live result until invalidated.
   *
   * Callers that arrive while a probe is still running join it rather than
   * spawning a second login shell: the catalog scanners and the Agent Hub both
   * ask at startup, and a login shell is the most expensive thing this class does.
   */
  async detect(agent: ShellAgent): Promise<AgentDetection> {
    this.assertAgent(agent);
    const cached = this.cache.get(agent);
    if (cached) return { ...cached };
    const probe = this.pendingProbes.get(agent) ?? this.startProbe(agent);
    return { ...(await probe) };
  }

  /** Detects both supported agents in parallel because the probes are independent. */
  async detectAll(): Promise<Record<ShellAgent, AgentDetection>> {
    const [codex, claude] = await Promise.all([this.detect('codex'), this.detect('claude')]);
    return { codex, claude };
  }

  /** Clears one cached result or all of them so the next detect re-probes. */
  invalidate(agent?: ShellAgent): void {
    if (agent) this.cache.delete(agent);
    else this.cache.clear();
  }

  /** Runs one probe and registers it for the callers that join it. */
  private startProbe(agent: ShellAgent): Promise<AgentDetection> {
    const probe = this.shellRunner
      .run(`which ${agent}`, { shell: '/bin/bash', login: true, timeoutMs: this.timeoutMs })
      .then((result) => {
        const detection = this.toDetection(agent, result);
        this.cache.set(agent, detection);
        return detection;
      })
      .finally(() => this.pendingProbes.delete(agent));
    this.pendingProbes.set(agent, probe);
    return probe;
  }

  private toDetection(agent: ShellAgent, result: ShellRunResult): AgentDetection {
    const cliPath = this.toCliPath(result);
    const desktopAppPath = this.desktopApps.locate(agent);
    const installed = cliPath !== null || desktopAppPath !== null;
    return {
      agent,
      installed,
      executablePath: cliPath,
      desktopAppPath,
      error: installed ? null : this.failureMessage(agent, result)
    };
  }

  /** The CLI path `which` printed, or null when the probe found nothing. */
  private toCliPath(result: ShellRunResult): string | null {
    if (result.exitCode !== 0 || result.timedOut) return null;
    return result.output.map((line) => line.trim()).find((line) => line.length > 0) ?? null;
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
