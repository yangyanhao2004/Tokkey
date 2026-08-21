import { lstatSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RepositoryCoordinate } from '../../shared/types';
import GitHubRepositoryCoordinate from './GitHubRepositoryCoordinate';
import GitCommandRunner, { GitCommandError, type GitCommandResult } from './GitCommandRunner';

/** Minimal Git contract used by the cache, making process execution replaceable in tests. */
export interface GitCommandExecutor {
  run(args: readonly string[], options?: { timeoutMs?: number; cwd?: string }): Promise<GitCommandResult>;
}

export interface RepositoryCloneCacheOptions {
  cacheRoot?: string;
  homeDirectory?: string;
  runner?: GitCommandExecutor;
  cloneTimeoutMs?: number;
  refreshTimeoutMs?: number;
  queryTimeoutMs?: number;
}

export interface RepositoryCheckoutResult {
  coordinate: RepositoryCoordinate;
  checkoutPath: string;
  commit: string;
  wasRefreshed: boolean;
}

/** Owns deterministic shallow Git checkouts used as the repository source cache. */
export class RepositoryCloneCache {
  private readonly cacheRoot: string;
  private readonly runner: GitCommandExecutor;
  private readonly cloneTimeoutMs: number;
  private readonly refreshTimeoutMs: number;
  private readonly queryTimeoutMs: number;

  constructor(options: RepositoryCloneCacheOptions = {}) {
    const homeDirectory = path.resolve(options.homeDirectory ?? os.homedir());
    this.cacheRoot = path.resolve(options.cacheRoot ?? path.join(homeDirectory, '.amis', 'cache', 'skill-repos'));
    this.runner = options.runner ?? new GitCommandRunner();
    this.cloneTimeoutMs = options.cloneTimeoutMs ?? 180_000;
    this.refreshTimeoutMs = options.refreshTimeoutMs ?? 90_000;
    this.queryTimeoutMs = options.queryTimeoutMs ?? 15_000;
  }

  /** Returns the cache root without creating it. */
  getCacheRoot(): string {
    return this.cacheRoot;
  }

  /** Builds a safe owner/repo cache path from a validated coordinate. */
  getCheckoutPath(coordinate: RepositoryCoordinate | GitHubRepositoryCoordinate | string): string {
    const parsedCoordinate = this.normalizeCoordinate(coordinate);
    const checkoutPath = path.resolve(this.cacheRoot, parsedCoordinate.owner, parsedCoordinate.name);
    const relativePath = path.relative(this.cacheRoot, checkoutPath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      throw new Error(`Repository checkout escapes cache root: ${checkoutPath}`);
    }
    return checkoutPath;
  }

  /** Clones a missing checkout or refreshes an existing one in place. */
  async synchronizeCheckout(
    coordinate: RepositoryCoordinate | GitHubRepositoryCoordinate | string,
    branch = ''
  ): Promise<RepositoryCheckoutResult> {
    const parsedCoordinate = this.normalizeCoordinate(coordinate);
    const normalizedBranch = this.normalizeBranch(branch);
    const checkoutPath = this.getCheckoutPath(parsedCoordinate);
    const hadDirectory = this.pathExists(checkoutPath);

    if (hadDirectory && !this.isCheckoutPathSafe(checkoutPath)) {
      this.removeCheckout(checkoutPath);
    }

    if (hadDirectory && (await this.isUsableCheckout(checkoutPath))) {
      try {
        await this.refreshCheckout(checkoutPath, normalizedBranch);
        const commit = await this.readCommit(checkoutPath);
        return { coordinate: parsedCoordinate, checkoutPath, commit, wasRefreshed: true };
      } catch {
        // A broken cache is disposable. Reclone it before surfacing an error.
        this.removeCheckout(checkoutPath);
      }
    } else if (hadDirectory) {
      this.removeCheckout(checkoutPath);
    }

    try {
      await this.cloneCheckout(parsedCoordinate, checkoutPath, normalizedBranch);
      const commit = await this.readCommit(checkoutPath);
      return { coordinate: parsedCoordinate, checkoutPath, commit, wasRefreshed: false };
    } catch (error) {
      this.removeCheckout(checkoutPath);
      throw this.toCacheError('clone', parsedCoordinate, checkoutPath, error);
    }
  }

  /** Compatibility alias for callers that describe synchronization as a cache operation. */
  synchronize(
    coordinate: RepositoryCoordinate | GitHubRepositoryCoordinate | string,
    branch = ''
  ): Promise<RepositoryCheckoutResult> {
    return this.synchronizeCheckout(coordinate, branch);
  }

  /** Verifies that a cached directory has both Git metadata and a resolvable HEAD. */
  async isUsableCheckout(checkoutPath: string): Promise<boolean> {
    if (!this.isCheckoutPathSafe(checkoutPath)) {
      return false;
    }
    if (!this.pathExists(path.join(checkoutPath, '.git'))) {
      return false;
    }
    try {
      await this.runner.run(['rev-parse', 'HEAD'], { cwd: checkoutPath, timeoutMs: this.queryTimeoutMs });
      return true;
    } catch {
      return false;
    }
  }

  /** Reads the current commit SHA for provenance and refresh comparisons. */
  async readCommit(checkoutPath: string): Promise<string> {
    const result = await this.runner.run(['rev-parse', 'HEAD'], {
      cwd: checkoutPath,
      timeoutMs: this.queryTimeoutMs
    });
    const commit = result.stdout.trim();
    if (commit.length === 0) {
      throw new Error(`Git returned an empty HEAD for ${checkoutPath}`);
    }
    return commit;
  }

  private async refreshCheckout(checkoutPath: string, branch: string): Promise<void> {
    await this.runner.run(['fetch', '--depth', '1', 'origin', branch || 'HEAD'], {
      cwd: checkoutPath,
      timeoutMs: this.refreshTimeoutMs
    });
    await this.runner.run(['reset', '--hard', 'FETCH_HEAD'], {
      cwd: checkoutPath,
      timeoutMs: this.refreshTimeoutMs
    });
    await this.readCommit(checkoutPath);
  }

  private async cloneCheckout(
    coordinate: GitHubRepositoryCoordinate,
    checkoutPath: string,
    branch: string
  ): Promise<void> {
    mkdirSync(path.dirname(checkoutPath), { recursive: true });
    const argumentsList = ['clone', '--depth', '1'];
    if (branch.length > 0) {
      argumentsList.push('--branch', branch);
    }
    argumentsList.push(coordinate.cloneUrl, checkoutPath);
    await this.runner.run(argumentsList, { timeoutMs: this.cloneTimeoutMs });
  }

  private normalizeBranch(branch: string): string {
    if (typeof branch !== 'string') {
      throw new TypeError('Git branch must be a string');
    }
    const normalizedBranch = branch.trim();
    if (normalizedBranch.includes('\u0000') || normalizedBranch.startsWith('-')) {
      throw new TypeError('Git branch contains an invalid option prefix');
    }
    return normalizedBranch;
  }

  private normalizeCoordinate(
    coordinate: RepositoryCoordinate | GitHubRepositoryCoordinate | string
  ): GitHubRepositoryCoordinate {
    if (coordinate instanceof GitHubRepositoryCoordinate) {
      return coordinate;
    }
    if (typeof coordinate === 'string') {
      return new GitHubRepositoryCoordinate(coordinate);
    }
    return new GitHubRepositoryCoordinate(coordinate.source);
  }

  private pathExists(candidatePath: string): boolean {
    try {
      lstatSync(candidatePath);
      return true;
    } catch {
      return false;
    }
  }

  /** Keeps an existing checkout from redirecting cache operations through a symlink. */
  private isCheckoutPathSafe(checkoutPath: string): boolean {
    const absolutePath = path.resolve(checkoutPath);
    const lexicalRelativePath = path.relative(this.cacheRoot, absolutePath);
    if (lexicalRelativePath.startsWith('..') || path.isAbsolute(lexicalRelativePath)) {
      return false;
    }
    if (!this.pathExists(absolutePath)) {
      return true;
    }
    try {
      const realRelativePath = path.relative(realpathSync(this.cacheRoot), realpathSync(absolutePath));
      return realRelativePath !== '' && !realRelativePath.startsWith('..') && !path.isAbsolute(realRelativePath);
    } catch {
      return false;
    }
  }

  private removeCheckout(checkoutPath: string): void {
    if (this.pathExists(checkoutPath)) {
      rmSync(checkoutPath, { recursive: true, force: true });
    }
  }

  private toCacheError(
    operation: string,
    coordinate: GitHubRepositoryCoordinate,
    checkoutPath: string,
    error: unknown
  ): Error {
    const detail = error instanceof GitCommandError
      ? `${error.message}${error.stderr.trim().length > 0 ? `; stderr: ${error.stderr.trim()}` : ''}`
      : error instanceof Error
        ? error.message
        : String(error);
    return new Error(`Repository ${operation} failed for ${coordinate.source} at ${checkoutPath}: ${detail}`);
  }
}

export default RepositoryCloneCache;
