import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ShellRunOptions, ShellRunResult, ShellRunner } from './AgentTypes';

export interface StreamingShellRunnerOptions {
  /** Injected process factory keeps timeout and stream handling unit-testable. */
  spawnProcess?: typeof spawn;
  /** Extra milliseconds allowed between timeout signals. */
  signalGraceMs?: number;
  /** Maximum retained diagnostic lines from either stream. */
  diagnosticTailLimit?: number;
  /** Environment used as the base for GUI-launched shell commands. */
  environment?: NodeJS.ProcessEnv;
}

/**
 * Runs login-shell commands while framing both output streams into lines.
 *
 * Electron applications do not inherit the same PATH as an interactive
 * terminal, so the runner adds common package-manager locations before launch.
 * Timeout handling escalates gently before using SIGKILL and never owns UI
 * objects; callers receive plain events and a serializable result.
 */
export class StreamingShellRunner implements ShellRunner {
  private static readonly DEFAULT_SIGNAL_GRACE_MS = 1000;
  private static readonly DEFAULT_DIAGNOSTIC_TAIL_LIMIT = 30;
  private static readonly COMMON_PATHS = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin'
  ];

  private readonly spawnProcess: typeof spawn;
  private readonly signalGraceMs: number;
  private readonly diagnosticTailLimit: number;
  private readonly environment: NodeJS.ProcessEnv;

  constructor(options: StreamingShellRunnerOptions = {}) {
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.signalGraceMs = options.signalGraceMs ?? StreamingShellRunner.DEFAULT_SIGNAL_GRACE_MS;
    this.diagnosticTailLimit = options.diagnosticTailLimit ?? StreamingShellRunner.DEFAULT_DIAGNOSTIC_TAIL_LIMIT;
    this.environment = options.environment ?? process.env;
  }

  /** Launches one shell command and resolves after its child process closes. */
  run(command: string, options: ShellRunOptions): Promise<ShellRunResult> {
    const shellArguments = this.buildShellArguments(command, options);
    const child = this.spawnProcess(options.shell, shellArguments, {
      env: this.buildEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe']
    }) as unknown as ChildProcessWithoutNullStreams;

    return new Promise<ShellRunResult>((resolve) => {
      let settled = false;
      let timedOut = false;
      let timeoutTimer: NodeJS.Timeout | null = null;
      let escalationTimer: NodeJS.Timeout | null = null;
      let stdoutBuffer = '';
      let stderrBuffer = '';
      const output: string[] = [];
      const diagnosticTail: string[] = [];

      const clearTimers = (): void => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (escalationTimer) clearTimeout(escalationTimer);
      };

      const emitLine = (line: string): void => {
        output.push(line);
        diagnosticTail.push(line);
        while (diagnosticTail.length > this.diagnosticTailLimit) {
          diagnosticTail.shift();
        }
        options.onLine?.(line);
      };

      const consumeChunk = (chunk: string, stream: 'stdout' | 'stderr'): void => {
        const nextBuffer = stream === 'stdout' ? stdoutBuffer + chunk : stderrBuffer + chunk;
        const lines = nextBuffer.split(/\r?\n/);
        const remainder = lines.pop() ?? '';
        if (stream === 'stdout') stdoutBuffer = remainder;
        else stderrBuffer = remainder;
        lines.forEach(emitLine);
      };

      const flushBuffers = (): void => {
        if (stdoutBuffer.length > 0) emitLine(stdoutBuffer);
        if (stderrBuffer.length > 0) emitLine(stderrBuffer);
        stdoutBuffer = '';
        stderrBuffer = '';
      };

      const finish = (exitCode: number | null): void => {
        if (settled) return;
        settled = true;
        clearTimers();
        flushBuffers();
        resolve({ exitCode, timedOut, output: [...output], diagnosticTail: [...diagnosticTail] });
      };

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => consumeChunk(chunk, 'stdout'));
      child.stderr.on('data', (chunk: string) => consumeChunk(chunk, 'stderr'));
      child.once('error', () => finish(null));
      child.once('close', (exitCode: number | null) => finish(exitCode));

      const terminate = (signal: NodeJS.Signals): void => {
        if (!settled) child.kill(signal);
      };

      timeoutTimer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        terminate('SIGINT');
        escalationTimer = setTimeout(() => {
          if (settled) return;
          terminate('SIGTERM');
          escalationTimer = setTimeout(() => terminate('SIGKILL'), this.signalGraceMs);
        }, this.signalGraceMs);
      }, options.timeoutMs);

      if (options.signal) {
        if (options.signal.aborted) terminate('SIGINT');
        else options.signal.addEventListener('abort', () => terminate('SIGINT'), { once: true });
      }
    });
  }

  /** Builds `bash -lc`/`zsh -lc` arguments while supporting interactive shells. */
  private buildShellArguments(command: string, options: ShellRunOptions): string[] {
    const mode = `${options.login ? 'l' : ''}${options.interactive ? 'i' : ''}c`;
    return [`-${mode}`, command];
  }

  /** Adds standard CLI locations without discarding the user's configured PATH. */
  private buildEnvironment(): NodeJS.ProcessEnv {
    const configuredPath = this.environment.PATH ?? '';
    const pathEntries = [...new Set([...StreamingShellRunner.COMMON_PATHS, ...configuredPath.split(':').filter(Boolean)])];
    return { ...this.environment, PATH: pathEntries.join(':') };
  }
}

export default StreamingShellRunner;
