import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ShellRunner } from '../agents/ShellRunner';
import type { ShellRunner as ShellRunnerContract } from '../agents/AgentTypes';
import TokkeyHome from '../storage/TokkeyHome';
import type { CatalogDocument, CatalogEntry } from './CodexCatalogFile';

/** The Codex CLI prints its bundled catalog as one JSON document on stdout. */
const CATALOG_COMMAND = 'codex debug models --bundled';
const VERSION_COMMAND = 'codex --version';

/** The catalog embeds every model's full prompt template, so it takes a moment. */
const COMMAND_TIMEOUT_MS = 30_000;

/** What the cache file holds, keyed by the CLI version that produced it. */
export interface BundledCatalogCache {
  codexVersion: string;
  models: CatalogEntry[];
}

/**
 * The model catalog compiled into the installed Codex CLI, cached on disk.
 *
 * Two very different callers need it. The Router page needs a handful of
 * descriptive fields per model, and the catalog Tokkey writes for Codex needs
 * the rows in full — the agent instructions, the tool contract, and the dozens
 * of capability flags that make a model behave like a first-class Codex model.
 * Both are served from one cache so the 30-second CLI call happens once.
 *
 * The installed version is the cache key because the catalog is compiled into
 * the binary: it cannot change while the version does not, and it always
 * changes when the user upgrades.
 *
 * Every failure path degrades instead of throwing. Codex may not be installed,
 * and `debug` is an explicitly unstable command surface whose shape can change
 * between releases; a cached catalog beats no catalog, and no catalog beats a
 * failed launch for a user who never touches a Codex model.
 */
export class CodexBundledCatalog {
  private readonly runner: ShellRunnerContract;
  private readonly cacheFilePath: string;
  /** Shared by every caller during one launch, so the CLI runs at most once. */
  private discovery: Promise<CatalogEntry[]> | null = null;

  constructor(options: { runner?: ShellRunnerContract; homeDirectory?: string } = {}) {
    this.runner = options.runner ?? new ShellRunner();
    this.cacheFilePath = new TokkeyHome(options).pathFor('codex-bundled-catalog.json');
  }

  /** Every native row, from the cache when it matches the installed CLI. */
  list(): Promise<CatalogEntry[]> {
    this.discovery ??= this.discover().catch((error: unknown) => {
      console.error('[CodexCatalog] Bundled catalog discovery failed:', error);
      return [];
    });
    return this.discovery;
  }

  /**
   * The cached rows, read synchronously and without consulting the CLI.
   *
   * This is what seeds the generated catalog. It is deliberately cheap: the
   * generator has to stay callable on the main thread, so refreshing the cache
   * is `list()`'s job and this only reports what that has already found.
   */
  readCached(): CatalogDocument | null {
    const cache = this.readCache();
    return cache ? { models: cache.models } : null;
  }

  /** Resolves the rows, preferring the cache written for this CLI version. */
  private async discover(): Promise<CatalogEntry[]> {
    const cached = this.readCache();
    const version = await this.installedVersion();
    if (!version) {
      // Codex is not installed or not on PATH. A cached catalog is still the
      // best answer available; it just cannot be refreshed right now.
      return cached?.models ?? [];
    }
    if (cached?.codexVersion === version) {
      return cached.models;
    }

    const models = await this.readBundledCatalog();
    if (!models) {
      return cached?.models ?? [];
    }
    await this.writeCache({ codexVersion: version, models });
    return models;
  }

  /** The installed CLI version, or an empty string when Codex cannot be run. */
  private async installedVersion(): Promise<string> {
    const result = await this.runShell(VERSION_COMMAND);
    if (result === null) return '';
    return result.find((line) => line.trim().length > 0)?.trim() ?? '';
  }

  /** The rows the CLI reports, or null when its output was unusable. */
  private async readBundledCatalog(): Promise<CatalogEntry[] | null> {
    const output = await this.runShell(CATALOG_COMMAND);
    if (output === null) return null;

    const models = this.parseCatalogDocument(output);
    if (!models) {
      console.error('[CodexCatalog] `codex debug models --bundled` returned no usable JSON.');
      return null;
    }
    return models;
  }

  /**
   * Finds the catalog JSON among the command's output lines.
   *
   * The runner interleaves stdout and stderr, so the document cannot simply be
   * the whole output: a shell warning on stderr would break a naive parse.
   */
  private parseCatalogDocument(output: string[]): CatalogEntry[] | null {
    for (const line of output) {
      if (!line.startsWith('{')) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        const models = (parsed as CatalogDocument).models;
        if (Array.isArray(models)) {
          return models;
        }
      } catch {
        // Not the catalog line; keep looking.
      }
    }
    return null;
  }

  /** Runs one command, returning its output lines or null when it failed. */
  private async runShell(command: string): Promise<string[] | null> {
    try {
      const result = await this.runner.run(command, {
        shell: '/bin/zsh',
        login: true,
        timeoutMs: COMMAND_TIMEOUT_MS
      });
      if (result.timedOut || result.exitCode !== 0) return null;
      return result.output;
    } catch (error: unknown) {
      console.error(`[CodexCatalog] \`${command}\` could not be run:`, error);
      return null;
    }
  }

  /** The cached catalog, or null when nothing usable is on disk. */
  private readCache(): BundledCatalogCache | null {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.cacheFilePath, 'utf8'));
      const { codexVersion, models } = parsed as Partial<BundledCatalogCache>;
      if (typeof codexVersion !== 'string' || !Array.isArray(models)) return null;
      return { codexVersion, models };
    } catch {
      // Absent or corrupt: discovery rebuilds it.
      return null;
    }
  }

  /** Remembers the catalog so the next launch does not pay for the CLI call. */
  private async writeCache(cache: BundledCatalogCache): Promise<void> {
    try {
      await mkdir(path.dirname(this.cacheFilePath), { recursive: true });
      await writeFile(this.cacheFilePath, JSON.stringify(cache), 'utf8');
    } catch (error: unknown) {
      // A cache that cannot be written only costs the next launch a CLI call.
      console.error('[CodexCatalog] Could not write the bundled catalog cache:', error);
    }
  }
}

export default CodexBundledCatalog;
