import CodexBundledCatalog from '../codex/CodexBundledCatalog';
import type { CatalogEntry } from '../codex/CodexCatalogFile';
import type { ShellRunner as ShellRunnerContract } from '../agents/AgentTypes';
import type { CodexNativeModel } from '../../shared/types';

/**
 * Only models Codex itself offers in its picker.
 *
 * The bundled catalog also carries `hide` entries — retired versions, and
 * internal ones like `codex-auto-review` — which are not general chat models
 * and would only clutter the Router page.
 */
const LISTED_VISIBILITY = 'list';

/**
 * The Codex models the Router page can offer, projected down to what it shows.
 *
 * The rows themselves come from `CodexBundledCatalog`, which owns the CLI call
 * and the cache. This class keeps only the handful of descriptive fields the UI
 * and the route registrar use — the full rows are ~40KB each, almost all of it
 * per-model instruction templates neither one has any use for.
 */
export class CodexNativeModelCatalog {
  private readonly bundled: CodexBundledCatalog;

  constructor(
    options: {
      bundled?: CodexBundledCatalog;
      runner?: ShellRunnerContract;
      homeDirectory?: string;
    } = {}
  ) {
    this.bundled = options.bundled ?? new CodexBundledCatalog(options);
  }

  /** The listed Codex models, in the order the bundled catalog names them. */
  async list(): Promise<CodexNativeModel[]> {
    const models = await this.bundled.list();
    return models
      .filter((entry) => entry.visibility === LISTED_VISIBILITY)
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
