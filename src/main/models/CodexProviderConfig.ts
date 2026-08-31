import { readFile } from 'node:fs/promises';
import { parse as parseToml } from '@iarna/toml';
import CodexHome from '../codex/CodexHome';

/** The provider Codex uses when `config.toml` names none. */
const DEFAULT_PROVIDER_ID = 'openai';

/** One provider as `config.toml` describes it, reduced to what Tokiie routes on. */
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
 * Reads the endpoint the Codex CLI itself would call, from `~/.codex/config.toml`.
 *
 * A Codex user who has pointed the CLI at a subscription relay or a self-hosted
 * proxy has already answered "where do these models come from" once, in the file
 * the CLI reads. Tokiie serves the same models from the same place rather than
 * asking again, so a model that works in `codex` works here.
 *
 * This reads the file and nothing more: whether the endpoint it names is one
 * Tokiie should adopt is `CodexUpstreamEndpoint`'s decision, because the file
 * is writable by anything on this machine — including Tokiie itself.
 *
 * Every failure path yields null, which means "no endpoint configured" and
 * leaves the gateway on its own defaults. The file belongs to another program
 * and may be absent, unreadable, or written in a shape a future CLI introduced.
 */
export class CodexProviderConfig {
  private readonly filePath: string;
  /** Shared by every caller during one launch, so the file is read at most once. */
  private lookup: Promise<CodexProviderEndpoint | null> | null = null;

  constructor(options: { homeDirectory?: string; filePath?: string } = {}) {
    this.filePath = options.filePath ?? CodexProviderConfig.defaultPath(options.homeDirectory);
  }

  /** Locates `config.toml` the way the Codex CLI does, honoring `CODEX_HOME`. */
  static defaultPath(homeDirectory?: string): string {
    return new CodexHome({ homeDirectory }).configPath;
  }

  /** The active provider, or null when the file names none Tokiie can use. */
  read(): Promise<CodexProviderEndpoint | null> {
    this.lookup ??= this.readProvider();
    return this.lookup;
  }

  /** Resolves `model_provider` against the `model_providers` table. */
  private async readProvider(): Promise<CodexProviderEndpoint | null> {
    const document = await this.readDocument();
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
