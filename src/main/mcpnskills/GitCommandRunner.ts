import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';

/** Result of one non-interactive Git invocation. */
export interface GitCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Error that preserves the command details needed for a useful UI message. */
export class GitCommandError extends Error {
  readonly args: string[];
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly timedOut: boolean;

  constructor(
    message: string,
    args: string[],
    exitCode: number | null,
    stderr: string,
    timedOut = false
  ) {
    super(message);
    this.name = 'GitCommandError';
    this.args = [...args];
    this.exitCode = exitCode;
    this.stderr = stderr;
    this.timedOut = timedOut;
  }
}

export interface GitCommandRunnerOptions {
  executable?: string;
  spawnProcess?: typeof spawn;
}

export interface GitCommandRunOptions {
  timeoutMs?: number;
  cwd?: string;
}

/** Runs Git with argument arrays, prompt suppression, stderr capture, and a timeout. */
export class GitCommandRunner {
  private readonly executable: string;
  private readonly spawnProcess: typeof spawn;

  constructor(options: GitCommandRunnerOptions = {}) {
    this.executable = options.executable ?? this.resolveGitExecutable();
    this.spawnProcess = options.spawnProcess ?? spawn;
  }

  /** Executes Git without invoking a shell or allowing hidden credential prompts. */
  run(args: readonly string[], options: GitCommandRunOptions = {}): Promise<GitCommandResult> {
    const commandArguments = [...args];
    if (commandArguments.some((argument) => argument.includes('\u0000'))) {
      return Promise.reject(new GitCommandError('Git arguments cannot contain NUL bytes', commandArguments, null, ''));
    }

    const timeoutMs = options.timeoutMs ?? 90_000;
    return new Promise<GitCommandResult>((resolve, reject) => {
      let childProcess: ChildProcessByStdio<null, Readable, Readable>;
      try {
        childProcess = this.spawnProcess(this.executable, commandArguments, {
          cwd: options.cwd,
          shell: false,
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: '0',
            GIT_ASKPASS: 'true',
            GIT_EDITOR: 'true',
            GIT_HTTP_LOW_SPEED_LIMIT: '1000',
            GIT_HTTP_LOW_SPEED_TIME: '30'
          },
          stdio: ['ignore', 'pipe', 'pipe']
        }) as ChildProcessByStdio<null, Readable, Readable>;
      } catch (error) {
        reject(new GitCommandError(`Unable to start git: ${this.describeError(error)}`, commandArguments, null, ''));
        return;
      }

      let stdout = '';
      let stderr = '';
      let settled = false;
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        childProcess.kill('SIGTERM');
        setTimeout(() => {
          if (!settled) {
            childProcess.kill('SIGKILL');
          }
        }, 1_000);
      }, timeoutMs);

      childProcess.stdout.on('data', (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });
      childProcess.stderr.on('data', (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });
      childProcess.once('error', (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        reject(new GitCommandError(`Unable to run git: ${this.describeError(error)}`, commandArguments, null, stderr));
      });
      childProcess.once('close', (exitCode) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        if (timedOut) {
          reject(
            new GitCommandError(
              `Git timed out after ${timeoutMs}ms`,
              commandArguments,
              exitCode,
              stderr,
              true
            )
          );
          return;
        }
        const normalizedExitCode = exitCode ?? 1;
        if (normalizedExitCode !== 0) {
          reject(
            new GitCommandError(
              `Git exited with status ${normalizedExitCode}: ${stderr.trim() || 'no stderr output'}`,
              commandArguments,
              normalizedExitCode,
              stderr
            )
          );
          return;
        }
        resolve({ stdout, stderr, exitCode: normalizedExitCode });
      });
    });
  }

  /** Alias used by callers that prefer process-oriented terminology. */
  execute(args: readonly string[], options: GitCommandRunOptions = {}): Promise<GitCommandResult> {
    return this.run(args, options);
  }

  private describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  /** GUI-launched apps often have a short PATH, so prefer a concrete executable path. */
  private resolveGitExecutable(): string {
    const configuredExecutable = process.env.TOKIIE_GIT_EXECUTABLE;
    if (configuredExecutable && existsSync(configuredExecutable)) {
      return configuredExecutable;
    }
    const pathCandidates = (process.env.PATH ?? '')
      .split(path.delimiter)
      .filter((directory) => directory.length > 0)
      .map((directory) => path.join(directory, 'git'));
    const platformCandidates = process.platform === 'darwin'
      ? ['/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git']
      : ['/usr/bin/git', '/usr/local/bin/git'];
    return [...pathCandidates, ...platformCandidates].find((candidate) => existsSync(candidate)) ?? 'git';
  }
}

export default GitCommandRunner;
