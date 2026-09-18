import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import { ShellRunner } from '../agents/ShellRunner';
import type { ShellRunner as ShellRunnerContract } from '../agents/AgentTypes';
import CodexHome from './CodexHome';

/**
 * Where the Codex desktop app installs the CLI it ships with, relative to the
 * Codex home. `current` is a symlink the installer repoints on every upgrade.
 */
const STANDALONE_RELATIVE_PATH = path.join('packages', 'standalone', 'current', 'bin', 'codex');

/** Looking up a name on PATH is cheap; the login shell's rc files are not. */
const LOOKUP_TIMEOUT_MS = 10_000;

/**
 * Finds the Codex executable to shell out to.
 *
 * The app's own install is preferred over PATH, because it is the one install
 * that PATH may not know about: the desktop app drops its CLI under the Codex
 * home and does not link it into a bin directory, so a user who has only ever
 * installed the app has a working Codex that `which codex` cannot see. Asking
 * PATH first would report Codex as absent for exactly those users, and an
 * absent Codex costs them every native row in the picker.
 *
 * PATH is the fallback, for the standalone `npm`/`brew` installs that never
 * create the app's directory. Null means neither was found, which the callers
 * treat as "Codex is not installed" rather than as an error.
 */
export class CodexCliLocator {
  private readonly runner: ShellRunnerContract;
  private readonly standalonePath: string;
  /** Memoized for the launch: the answer cannot change while the app runs. */
  private resolution: Promise<string | null> | null = null;

  constructor(
    options: { runner?: ShellRunnerContract; homeDirectory?: string; codexHome?: string } = {}
  ) {
    this.runner = options.runner ?? new ShellRunner();
    this.standalonePath = path.join(new CodexHome(options).directory, STANDALONE_RELATIVE_PATH);
  }

  /** The executable to run, or null when Codex is not installed. */
  resolve(): Promise<string | null> {
    this.resolution ??= this.locate().catch((error: unknown) => {
      console.error('[CodexCli] Could not locate the Codex CLI:', error);
      return null;
    });
    return this.resolution;
  }

  /** Builds a shell command line for the resolved executable. */
  static commandFor(executable: string, args: string): string {
    return `${CodexCliLocator.quote(executable)} ${args}`;
  }

  /** The app's install when it is there, otherwise whatever PATH offers. */
  private async locate(): Promise<string | null> {
    if (CodexCliLocator.isExecutable(this.standalonePath)) {
      return this.standalonePath;
    }
    return this.fromPath();
  }

  /** The path `which codex` reports, or null when the name is not on PATH. */
  private async fromPath(): Promise<string | null> {
    try {
      const result = await this.runner.run('which codex', {
        shell: '/bin/zsh',
        login: true,
        timeoutMs: LOOKUP_TIMEOUT_MS
      });
      if (result.timedOut || result.exitCode !== 0) return null;
      // The runner interleaves stderr, so a shell warning can precede the path;
      // only an absolute path is an answer.
      return result.output.map((line) => line.trim()).find((line) => line.startsWith('/')) ?? null;
    } catch (error: unknown) {
      console.error('[CodexCli] `which codex` could not be run:', error);
      return null;
    }
  }

  /** Whether the path names a file this process may execute. */
  private static isExecutable(filePath: string): boolean {
    try {
      accessSync(filePath, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  /** Single-quotes a path so a space or a quote in it cannot split the command. */
  private static quote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
  }
}

export default CodexCliLocator;
