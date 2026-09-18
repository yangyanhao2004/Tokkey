import CodexProviderConfig from '../models/CodexProviderConfig';
import { CatalogFileStore, type CatalogEntry } from './CodexCatalogFile';
import { CatalogEntryFactory } from './CodexCatalogGenerator';
import CodexHome from './CodexHome';

/**
 * The model catalog the user pointed Codex at, when they pointed it at one.
 *
 * `model_catalog_json` is how a Codex user curates their own model list, and
 * that list is the answer to "which models should Tokkey serve" for anyone who
 * set it: they already decided, in the file the CLI reads. Taking it over with
 * OpenAI's bundled models would cost them every model they configured, for as
 * long as Tokkey runs.
 *
 * Every refusal below yields an empty list, which the caller reads as "there is
 * no user catalog" and answers with the bundled one. That is the safe direction:
 * a Codex that shows OpenAI's models is worse than one that shows the user's,
 * but a Codex that shows none at all is worse than both.
 *
 * The refusal that matters most is the self-reference: `CodexConfigTakeover`
 * writes this very key, pointing it at the catalog Tokkey generates. Reading
 * that back would seed Tokkey's own output into Tokkey's own input, so the
 * generated path is refused by path, and rows Tokkey authored are dropped
 * whatever file they arrive in.
 */
export class CodexUserCatalog {
  private readonly config: CodexProviderConfig;
  private readonly generatedCatalogPath: string;
  private readonly store = new CatalogFileStore();
  /** Shared by every caller during one launch, so the file is read at most once. */
  private discovery: Promise<CatalogEntry[]> | null = null;

  constructor(
    options: {
      config?: CodexProviderConfig;
      home?: CodexHome;
      homeDirectory?: string;
      codexHome?: string;
    } = {}
  ) {
    this.config = options.config ?? new CodexProviderConfig(options);
    this.generatedCatalogPath = (options.home ?? new CodexHome(options)).catalogPath;
  }

  /** The user's own rows, or none when there is no catalog Tokkey should use. */
  list(): Promise<CatalogEntry[]> {
    this.discovery ??= this.discover().catch((error: unknown) => {
      console.error('[CodexCatalog] Could not read the configured catalog:', error);
      return [];
    });
    return this.discovery;
  }

  /** Resolves the configured path and reads what it points at. */
  private async discover(): Promise<CatalogEntry[]> {
    const filePath = await this.config.catalogPath();
    if (filePath === null) return [];
    if (filePath === this.generatedCatalogPath) {
      // Tokkey's own output. A live takeover puts it here, and so does a stale
      // one a previous run never undid.
      return [];
    }

    // The store already answers null for absent, unreadable, and shapeless.
    const document = this.store.read(filePath);
    if (document === null) {
      console.error(`[CodexCatalog] ${filePath} holds no usable catalog; using the bundled models.`);
      return [];
    }
    const models = (document.models ?? []).filter(
      (entry) => !CatalogEntryFactory.isTokkeyAuthored(entry)
    );
    if (models.length > 0) {
      console.info(`[CodexCatalog] Using the ${models.length} model(s) configured in ${filePath}.`);
    }
    return models;
  }
}

export default CodexUserCatalog;
