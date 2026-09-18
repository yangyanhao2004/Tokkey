import type { ShellRunner as ShellRunnerContract } from '../agents/AgentTypes';
import CodexBundledCatalog from './CodexBundledCatalog';
import type { CatalogDocument, CatalogEntry } from './CodexCatalogFile';
import CodexUserCatalog from './CodexUserCatalog';

/**
 * Where Codex's non-Tokkey models come from, decided once per launch.
 *
 * Two callers ask, and they must get the same answer: the registrar turns these
 * rows into gateway routes, and the generated catalog seeds its picker from
 * them. A disagreement would show the user a model they cannot reach, or route
 * one they cannot see.
 *
 * The user's own catalog wins when there is one, because they curated it; the
 * models compiled into the CLI are the answer for everyone else. Sharing one
 * instance between the callers is what makes that a single decision rather than
 * two that happen to agree — and it keeps the CLI call and the config read to
 * one each.
 *
 * The bundled catalog is refreshed either way. It costs a version check once the
 * cache is warm, and it is the only way to know which rows a previous launch
 * seeded — see {@link retiredSlugs}.
 */
export class CodexNativeCatalogSource {
  private readonly bundled: CodexBundledCatalog;
  private readonly user: CodexUserCatalog;
  /** Shared by every caller during one launch, so the decision is made once. */
  private discovery: Promise<CatalogEntry[]> | null = null;
  /** What that decision settled on, for the synchronous readers. */
  private decided: CatalogEntry[] | null = null;
  /** The bundled slugs, kept whether or not the bundled rows won. */
  private bundledSlugs: string[] = [];

  constructor(
    options: {
      bundled?: CodexBundledCatalog;
      user?: CodexUserCatalog;
      runner?: ShellRunnerContract;
      homeDirectory?: string;
      codexHome?: string;
    } = {}
  ) {
    this.bundled = options.bundled ?? new CodexBundledCatalog(options);
    this.user = options.user ?? new CodexUserCatalog(options);
  }

  /** The rows to route and to seed the picker with. */
  list(): Promise<CatalogEntry[]> {
    this.discovery ??= this.decide();
    return this.discovery;
  }

  /**
   * The decided rows, read synchronously and without consulting anything.
   *
   * The generator runs on the main thread and cannot await, so it reads what
   * {@link list} already settled on. Before that has resolved — only possible
   * for a caller that skipped it — the bundled cache stands in.
   */
  readCached(): CatalogDocument | null {
    if (this.decided !== null) return { models: this.decided };
    return this.bundled.readCached();
  }

  /**
   * Slugs a previous launch may have seeded from the bundled catalog that this
   * one is not seeding.
   *
   * Without this they would outlive the decision. The generated catalog keeps
   * every row it did not write, so a bundled row already on disk would survive
   * the switch to a user catalog and go on offering a model the user removed —
   * which is the whole thing this source exists to prevent. Empty whenever the
   * bundled rows won, since then nothing was dropped.
   */
  retiredSlugs(): string[] {
    const seeded = new Set(CodexNativeCatalogSource.slugsOf(this.decided ?? []));
    return this.bundledSlugs.filter((slug) => !seeded.has(slug));
  }

  /** Reads both sources and prefers the user's. */
  private async decide(): Promise<CatalogEntry[]> {
    const [bundled, user] = await Promise.all([this.bundled.list(), this.user.list()]);
    this.bundledSlugs = CodexNativeCatalogSource.slugsOf(bundled);
    this.decided = user.length > 0 ? user : bundled;
    return this.decided;
  }

  /** The slugs among these rows, skipping any row that names none. */
  private static slugsOf(entries: readonly CatalogEntry[]): string[] {
    return entries.flatMap((entry) => (typeof entry.slug === 'string' ? [entry.slug] : []));
  }
}

export default CodexNativeCatalogSource;
