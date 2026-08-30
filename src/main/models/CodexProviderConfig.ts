import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from '@iarna/toml';

/** The provider Codex uses when `config.toml` names none. */
const DEFAULT_PROVIDER_ID = 'openai';

/**
 * Reads the endpoint the Codex CLI itself would call, from `~/.codex/config.toml`.
 *
 * A Codex user who has pointed the CLI at a subscription relay or a self-hosted
 * proxy has already answered "where do these models come from" once, in the file
 * the CLI reads. Tokiie serves the same models from the same place rather than
 * asking again, so a model that works in `codex` works here.
 *
 * Only the active provider's `base_url` is read. Everything else in that file —
 * credentials, wire protocol, retry policy — belongs to the CLI: the gateway
 * decides per request which credential a Codex native route spends, and reading
 * a second opinion from here would only let the two disagree.
 *
 * Every failure path yields null, which means "no endpoint configured" and
 * leaves the gateway on its own defaults. The file belongs to another program
 * and may be absent, unreadable, or written in a shape a future CLI introduced.
 */
export class CodexProviderConfig {
  private readonly filePath: string;
  /** Shared by every caller during one launch, so the file is read at most once. */
  private lookup: Promise<string | null> | null = null;

  constructor(options: { homeDirectory?: string; filePath?: string } = {}) {
    this.filePath = options.filePath ?? CodexProviderConfig.defaultPath(options.homeDirectory);
  }

  /** Locates `config.toml` the way the Codex CLI does, honoring `CODEX_HOME`. */
  static defaultPath(homeDirectory?: string): string {
    const codexHome = process.env.CODEX_HOME?.trim();
    if (codexHome) {
      return path.join(codexHome, 'config.toml');
    }
    return path.join(homeDirectory ?? os.homedir(), '.codex', 'config.toml');
  }

  /** The active provider's base URL, or null when the file names none. */
  baseUrl(): Promise<string | null> {
    this.lookup ??= this.readBaseUrl();
    return this.lookup;
  }

  /** Resolves `model_provider` against the `model_providers` table. */
  private async readBaseUrl(): Promise<string | null> {
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
    return this.stringOrNull(provider.base_url);
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
