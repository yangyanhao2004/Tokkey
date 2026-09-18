import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseToml } from '@iarna/toml';
import CodexHome from '../codex/CodexHome';

/** The provider Codex uses when `config.toml` names none. */
const DEFAULT_PROVIDER_ID = 'openai';

/** The root key naming the catalog the user wants Codex to read. */
const MODEL_CATALOG_KEY = 'model_catalog_json';

/** One provider as `config.toml` describes it, reduced to what Tokkey routes on. */
export interface CodexProviderEndpoint {
  baseUrl: string;
  /**
   * The key held by the environment variable the provider names, when that
   * variable is set. Only a probe of the endpoint uses it — the gateway picks
   * the credential a real turn spends.
   */
  apiKey: string | null;
}

/**
 * Reads what Tokkey needs out of `~/.codex/config.toml`: which endpoint the
 * Codex CLI itself would call, and which catalog it would read.
 *
 * A Codex user who has pointed the CLI at a subscription relay or a self-hosted
 * proxy has already answered "where do these models come from" once, in the file
 * the CLI reads. A user who set `model_catalog_json` has likewise already
 * answered "which models". Tokkey serves the same models from the same place
 * rather than asking again, so what works in `codex` works here.
 *
 * Both facts come from one parse, memoized for the launch: they are read on the
 * same startup path, and the file is another program's.
 *
 * This reads the file and nothing more. Whether the endpoint it names is one
 * Tokkey should adopt is `CodexUpstreamEndpoint`'s decision, and whether the
 * catalog it names is one Tokkey should seed from is `CodexUserCatalog`'s,
 * because the file is writable by anything on this machine — including Tokkey
 * itself.
 *
 * Every failure path yields null, which means "not configured" and leaves the
 * caller on its own defaults. The file belongs to another program and may be
 * absent, unreadable, or written in a shape a future CLI introduced.
 */
export class CodexProviderConfig {
  private readonly filePath: string;
  /** Shared by every caller during one launch, so the file is read at most once. */
  private document: Promise<Record<string, unknown> | null> | null = null;
  private lookup: Promise<CodexProviderEndpoint | null> | null = null;
  private catalog: Promise<string | null> | null = null;

  constructor(options: { homeDirectory?: string; codexHome?: string; filePath?: string } = {}) {
    this.filePath = options.filePath ?? CodexProviderConfig.defaultPath(options);
  }

  /** Locates `config.toml` the way the Codex CLI does, honoring `CODEX_HOME`. */
  static defaultPath(options: { homeDirectory?: string; codexHome?: string } = {}): string {
    return new CodexHome(options).configPath;
  }

  /** The active provider, or null when the file names none Tokkey can use. */
  read(): Promise<CodexProviderEndpoint | null> {
    this.lookup ??= this.readProvider();
    return this.lookup;
  }

  /**
   * The catalog `model_catalog_json` names, as an absolute path, or null when
   * the file names none.
   *
   * It is a root key rather than a provider setting, so it cannot ride along on
   * `read()`: that returns null for the common default-`openai` case, where a
   * catalog may still be configured.
   */
  catalogPath(): Promise<string | null> {
    this.catalog ??= this.readCatalogPath();
    return this.catalog;
  }

  /** Resolves `model_provider` against the `model_providers` table. */
  private async readProvider(): Promise<CodexProviderEndpoint | null> {
    const document = await this.parsed();
    if (!document) return null;

    const providerId = this.stringOrNull(document.model_provider) ?? DEFAULT_PROVIDER_ID;
    const providers = document.model_providers;
    if (!this.isRecord(providers)) {
      // The built-in providers carry no table of their own; `openai` in
      // particular means OpenAI's public API, which the gateway already knows.
      return null;
    }
    const provider = providers[providerId];
    if (!this.isRecord(provider)) {
      console.error(`[CodexModels] config.toml names provider '${providerId}', which it does not define.`);
      return null;
    }
    const baseUrl = this.stringOrNull(provider.base_url);
    if (baseUrl === null) return null;
    return { baseUrl, apiKey: this.environmentKey(provider.env_key) };
  }

  /** Resolves `model_catalog_json` to an absolute path. */
  private async readCatalogPath(): Promise<string | null> {
    const document = await this.parsed();
    const configured = document ? this.stringOrNull(document[MODEL_CATALOG_KEY]) : null;
    // `~` is expanded here because the shell resolves it and Node does not, and
    // this value was hand-written into a file the shell never sees.
    return configured === null ? null : path.resolve(CodexHome.expandUser(configured));
  }

  /** The parsed file, read at most once per launch. */
  private parsed(): Promise<Record<string, unknown> | null> {
    this.document ??= this.readDocument();
    return this.document;
  }

  /** Reads the key from the environment variable the provider names, if any. */
  private environmentKey(envKey: unknown): string | null {
    const name = this.stringOrNull(envKey);
    return name === null ? null : this.stringOrNull(process.env[name]);
  }

  /** The parsed file, or null when it is absent or unparseable. */
  private async readDocument(): Promise<Record<string, unknown> | null> {
    let text: string;
    try {
      text = await readFile(this.filePath, 'utf8');
    } catch {
      // Codex is not configured on this machine, which is not an error here.
      return null;
    }
    try {
      const parsed = parseToml(text) as unknown;
      return this.isRecord(parsed) ? parsed : null;
    } catch (error: unknown) {
      console.error(`[CodexModels] Could not parse ${this.filePath}:`, error);
      return null;
    }
  }

  private stringOrNull(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}

export default CodexProviderConfig;
