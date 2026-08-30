import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ShellRunner } from '../agents/ShellRunner';
import type { ShellRunner as ShellRunnerContract } from '../agents/AgentTypes';
import type { CodexNativeModel } from '../../shared/types';

/** The Codex CLI prints its bundled catalog as one JSON document on stdout. */
const CATALOG_COMMAND = 'codex debug models --bundled';
const VERSION_COMMAND = 'codex --version';

/** The catalog embeds every model's full prompt template, so it takes a moment. */
const COMMAND_TIMEOUT_MS = 30_000;

/**
 * Only models Codex itself offers in its picker.
 *
 * The bundled catalog also carries `hide` entries — retired versions, and
 * internal ones like `codex-auto-review` — which are not general chat models
 * and would only clutter the Router page.
 */
const LISTED_VISIBILITY = 'list';

/**
 * Discovers the models the Codex CLI can talk to, and remembers them.
 *
 * The catalog is read by shelling out to `codex debug models --bundled`, which
 * takes a moment and returns roughly 400KB — almost all of it the per-model
 * instruction templates, which this app has no use for. Only the handful of
 * descriptive fields are kept, so the cache is a couple of kilobytes.
 *
 * Every failure path degrades instead of throwing: Codex may not be installed,
 * and `debug` is an explicitly unstable command surface whose shape can change
 * between CLI versions. A cached list is preferred to no list, and no list is
 * preferred to a failed app launch — nothing here is on the critical path for a
 * user who never touches a Codex model.
 */
export class CodexNativeModelCatalog {
  private readonly runner: ShellRunnerContract;
  private readonly cacheFilePath: string;
  /** Shared by every caller during one launch, so the CLI runs at most once. */
  private discovery: Promise<CodexNativeModel[]> | null = null;

  constructor(options: { runner?: ShellRunnerContract; homeDirectory?: string } = {}) {
    this.runner = options.runner ?? new ShellRunner();
    this.cacheFilePath = path.join(
      options.homeDirectory ?? os.homedir(),
      '.amiswifi',
      'codex-native-models.json'
    );
  }

  /** The listed Codex models, from cache when it matches the installed CLI. */
  list(): Promise<CodexNativeModel[]> {
    this.discovery ??= this.discover().catch((error: unknown) => {
      console.error('[CodexModels] Native model discovery failed:', error);
      return [];
    });
    return this.discovery;
  }

  /**
   * Resolves the model list, preferring the cache written for this CLI version.
   *
   * The installed version is the cache key because the bundled catalog is
   * compiled into the binary: it cannot change while the version does not, and
   * it always changes when a user upgrades.
   */
  private async discover(): Promise<CodexNativeModel[]> {
    const cached = await this.readCache();
    const version = await this.installedVersion();
    if (!version) {
      // Codex is not installed or not on PATH. A previously cached list is still
      // the best answer available; it just cannot be refreshed right now.
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

  /** The listed models from the CLI, or null when the output was unusable. */
  private async readBundledCatalog(): Promise<CodexNativeModel[] | null> {
    const output = await this.runShell(CATALOG_COMMAND);
    if (output === null) return null;

    const document = this.parseCatalogDocument(output);
    if (!document) {
      console.error('[CodexModels] `codex debug models --bundled` returned no usable JSON.');
      return null;
    }
    return document
      .filter((entry) => entry.visibility === LISTED_VISIBILITY)
      .map((entry) => this.toNativeModel(entry))
      .filter((model): model is CodexNativeModel => model !== null);
  }

  /**
   * Finds the catalog JSON among the command's output lines.
   *
   * The runner interleaves stdout and stderr, so the document cannot simply be
   * the whole output: a shell warning on stderr would break a naive parse.
   */
  private parseCatalogDocument(output: string[]): Record<string, unknown>[] | null {
    for (const line of output) {
      if (!line.startsWith('{')) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        const models = (parsed as { models?: unknown }).models;
        if (Array.isArray(models)) {
          return models as Record<string, unknown>[];
        }
      } catch {
        // Not the catalog line; keep looking.
      }
    }
    return null;
  }

  /** Projects one catalog entry down to the fields this app displays and routes on. */
  private toNativeModel(entry: Record<string, unknown>): CodexNativeModel | null {
    const slug = entry.slug;
    if (typeof slug !== 'string' || slug.trim().length === 0) return null;
    return {
      slug,
      displayName: typeof entry.display_name === 'string' ? entry.display_name : slug,
      description: typeof entry.description === 'string' ? entry.description : '',
      contextWindow: typeof entry.context_window === 'number' ? entry.context_window : null,
      supportedInApi: entry.supported_in_api === true
    };
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
      console.error(`[CodexModels] \`${command}\` could not be run:`, error);
      return null;
    }
  }

  /** The remembered list, or null when nothing usable is on disk. */
  private async readCache(): Promise<CodexNativeModelCache | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.cacheFilePath, 'utf8'));
      const { codexVersion, models } = parsed as Partial<CodexNativeModelCache>;
      if (typeof codexVersion !== 'string' || !Array.isArray(models)) return null;
      return { codexVersion, models };
    } catch {
      // Absent or corrupt: discovery rebuilds it.
      return null;
    }
  }

  /** Remembers the list so the next launch does not pay for the CLI call. */
  private async writeCache(cache: CodexNativeModelCache): Promise<void> {
    try {
      await mkdir(path.dirname(this.cacheFilePath), { recursive: true });
      await writeFile(this.cacheFilePath, JSON.stringify(cache, null, 2), 'utf8');
    } catch (error: unknown) {
      // A cache that cannot be written only costs the next launch a CLI call.
      console.error('[CodexModels] Could not write the native model cache:', error);
    }
  }
}

/** What the cache file holds, keyed by the CLI version that produced it. */
interface CodexNativeModelCache {
  codexVersion: string;
  models: CodexNativeModel[];
}

export default CodexNativeModelCatalog;
