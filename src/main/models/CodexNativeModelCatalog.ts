import type { CatalogEntry } from '../codex/CodexCatalogFile';
import CodexNativeCatalogSource from '../codex/CodexNativeCatalogSource';
import type { ShellRunner as ShellRunnerContract } from '../agents/AgentTypes';
import type { CodexNativeModel } from '../../shared/types';

/**
 * Only models Codex itself offers in its picker.
 *
 * The bundled catalog also carries `hide` entries — retired versions, and
 * internal ones like `codex-auto-review` — which are not general chat models
 * and would only clutter the Router page.
 *
 * A row that names no visibility at all is listed. Every bundled row names one,
 * so this only decides for a hand-written catalog, where the field is optional
 * and a row nobody marked hidden is a row the author meant to use.
 */
const LISTED_VISIBILITY = 'list';

/**
 * The Codex models the Router page can offer, projected down to what it shows.
 *
 * The rows themselves come from `CodexNativeCatalogSource`, which owns the
 * choice between the user's own catalog and the one compiled into the CLI. This
 * class keeps only the handful of descriptive fields the UI and the route
 * registrar use — the full rows are ~40KB each, almost all of it per-model
 * instruction templates neither one has any use for.
 */
export class CodexNativeModelCatalog {
  private readonly source: CodexNativeCatalogSource;

  constructor(
    options: {
      source?: CodexNativeCatalogSource;
      runner?: ShellRunnerContract;
      homeDirectory?: string;
      codexHome?: string;
    } = {}
  ) {
    this.source = options.source ?? new CodexNativeCatalogSource(options);
  }

  /** The listed Codex models, in the order the source catalog names them. */
  async list(): Promise<CodexNativeModel[]> {
    const models = await this.source.list();
    return models
      .filter((entry) => entry.visibility === undefined || entry.visibility === LISTED_VISIBILITY)
      .map((entry) => this.toNativeModel(entry))
      .filter((model): model is CodexNativeModel => model !== null);
  }

  /** Projects one catalog row down to the fields this app displays and routes on. */
  private toNativeModel(entry: CatalogEntry): CodexNativeModel | null {
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
}

export default CodexNativeModelCatalog;
