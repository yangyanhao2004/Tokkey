import {
  CatalogFileStore,
  CatalogSerializer,
  type CatalogDocument,
  type CatalogEntry
} from './CodexCatalogFile';

/** One model Tokkey wants Codex to offer, before it becomes a catalog row. */
export interface CatalogModelInput {
  /**
   * The name Codex sends upstream, which is also the row's slug. It must be a
   * name the gateway serves: the whole point of the catalog is that picking
   * this row in Codex reaches the matching gateway route.
   */
  slug: string;
  /** Picker label. Display only — routing is always by slug. */
  displayName?: string;
  /** Vendor named in the row description; falls back to the slug. */
  ownedBy?: string;
  /**
   * Only the compaction threshold is derived from this. The window itself is
   * never written — see `OMITTED_FIELDS`.
   */
  contextWindow?: number;
}

export interface CatalogGenerationResult {
  /** Absolute path of the catalog that was targeted. */
  path: string;
  /** How many routed rows this run produced. */
  routed: number;
  /** False when the rendered bytes matched what was already on disk. */
  written: boolean;
  /** The merged rows, for a caller that wants them without re-reading the file. */
  models: CatalogEntry[];
}

/**
 * Marks a row as one Tokkey wrote. Rows are identified by this prefix rather
 * than by the shape of their slug, because a Tokkey route name looks exactly
 * like a native one: it carries no provider prefix, since the slug has to be
 * the name the gateway registered the route under.
 */
const ROUTED_DESCRIPTION_PREFIX = 'Routed via Tokkey → ';

/** Codex's hardcoded GPT-5 identity sentence, which routed rows must not inherit. */
const CODEX_GPT5_IDENTITY_PATTERN =
  /You are Codex, (?:a coding agent|an agent) based on GPT-5(?:\.[0-9]+)*\./g;

/** Every routed row sorts below the native ones in the picker. */
const ROUTED_PRIORITY = 5;

/** The context window assumed for a model that declares none. */
const DEFAULT_CONTEXT_WINDOW = 128000;

/** Share of the window a turn may fill before Codex compacts the conversation. */
const COMPACTION_HEADROOM = 0.9;

/**
 * Fields stripped from every row before the catalog is written.
 *
 * Each one is a value Tokkey would be guessing at. A routed row is cloned from
 * a native model, so its window describes that model rather than the one the
 * gateway forwards to, and a guess that is wrong is worse than no answer: Codex
 * falls back to its own per-model metadata for an absent field, and that
 * metadata is right far more often than this file could be. `availability_nux`
 * is dropped for a different reason — it is a "now available" banner tied to one
 * model's release, and no row should replay another's.
 *
 * The reasoning ladder — `supported_reasoning_levels` and the
 * `default_reasoning_level` that indexes into it — is not here: it is rewritten
 * on Tokkey's own rows and left untouched on the native ones, whose ladder is
 * the model's own and correct as Codex wrote it. See `ensureStrictFields`.
 *
 * They are removed at the end, after the merge, so the rule holds for every row
 * in the file: the ones built here, the natives seeded from the CLI, and the
 * ones another tool left behind.
 */
const OMITTED_FIELDS: readonly string[] = [
  'context_window',
  'max_context_window',
  'availability_nux'
];

/**
 * Builds one routed catalog row, cloning a native row as its template.
 *
 * The clone is what makes a routed model behave like a first-class Codex model:
 * the native row carries the agent instructions, the tool contract, and the
 * dozens of capability flags Codex expects, none of which Tokkey could
 * reconstruct. Everything specific to the native model is then stripped, so the
 * clone inherits behaviour without inheriting identity.
 */
export class CatalogEntryFactory {
  /** The description doubles as the ownership marker the merge keys off. */
  static describe(model: CatalogModelInput): string {
    return `${ROUTED_DESCRIPTION_PREFIX}${model.ownedBy ?? model.slug}.`;
  }

  /** Whether Tokkey is the author of this row. */
  static isTokkeyAuthored(entry: CatalogEntry): boolean {
    return (
      typeof entry.description === 'string' &&
      entry.description.startsWith(ROUTED_DESCRIPTION_PREFIX)
    );
  }

  /**
   * The native row to clone: one that carries `base_instructions` and was not
   * written by Tokkey itself, since cloning our own clone would compound every
   * field the first pass stripped.
   */
  static findTemplate(document: CatalogDocument | null): CatalogEntry | null {
    return (
      document?.models?.find(
        (entry) =>
          typeof entry.slug === 'string' &&
          'base_instructions' in entry &&
          !CatalogEntryFactory.isTokkeyAuthored(entry)
      ) ?? null
    );
  }

  /** The routed row for one model. */
  build(template: CatalogEntry | null, model: CatalogModelInput): CatalogEntry {
    const entry = template ? this.fromTemplate(template, model) : this.fromScratch();
    entry.slug = model.slug;
    entry.description = CatalogEntryFactory.describe(model);
    entry.display_name = model.displayName ?? model.slug;
    entry.priority = ROUTED_PRIORITY;
    entry.visibility = 'list';
    if (model.ownedBy) {
      entry.owned_by = model.ownedBy;
    }
    if (typeof model.contextWindow === 'number' && model.contextWindow > 0) {
      entry.auto_compact_token_limit = Math.floor(model.contextWindow * COMPACTION_HEADROOM);
    }
    return CatalogEntryFactory.ensureStrictFields(entry, { routed: true });
  }

  /** A deep clone of the native row with everything native-specific removed. */
  private fromTemplate(template: CatalogEntry, model: CatalogModelInput): CatalogEntry {
    const entry = JSON.parse(JSON.stringify(template)) as CatalogEntry;
    if ('upgrade' in entry) entry.upgrade = null;
    // A routed model is not the native model, so its compaction threshold is
    // not the native one either. The caller's window, or the fallback in
    // `ensureStrictFields`, sets a fresh one.
    delete entry.auto_compact_token_limit;
    // The omitted fields are dropped here too, not only at the end. Leaving the
    // native's window on the clone would let it seed that fresh threshold, and
    // whether it is there at all depends on whether this run seeded the natives
    // — which would make the same model set render differently run to run.
    for (const field of OMITTED_FIELDS) {
      delete entry[field];
    }

    if (typeof entry.base_instructions === 'string') {
      entry.base_instructions = CatalogEntryFactory.identify(entry.base_instructions, model.slug);
    }
    return this.normalizeRouted(entry);
  }

  /** The minimum viable row, used when no native template could be found. */
  private fromScratch(): CatalogEntry {
    return this.normalizeRouted({
      shell_type: 'shell_command',
      supported_in_api: true,
      base_instructions: 'You are a helpful coding assistant.'
    });
  }

  /** Strips native-only capabilities a clone would otherwise leak. */
  private normalizeRouted(entry: CatalogEntry): CatalogEntry {
    for (const field of [
      'model_messages',
      'multi_agent_version',
      'use_responses_lite',
      'supports_websockets',
      'prefer_websockets',
      'additional_speed_tiers',
      'service_tier',
      'service_tiers',
      'default_service_tier',
      // OpenAI-only summary delivery; the strict fields put a value back.
      'supports_reasoning_summaries'
    ]) {
      delete entry[field];
    }
    entry.web_search_tool_type = 'text_and_image';
    entry.supports_search_tool = true;
    return entry;
  }

  /** Names the real model in the identity line instead of inheriting GPT-5's. */
  private static identify(instructions: string, slug: string): string {
    const identity = CatalogEntryFactory.safeIdentity(slug);
    const replacement = identity
      ? `You are a coding agent powered by the ${identity}. If asked which model you are, identify as ${identity}. Do not claim to be a different model or to have a different creator.`
      : 'You are a coding agent powered by the configured model. If asked which model you are, identify as configured model. Do not claim to be GPT-5 or made by OpenAI.';
    // A callback, so a `$&` in a future replacement is never re-substituted.
    return instructions.replace(CODEX_GPT5_IDENTITY_PATTERN, () => replacement);
  }

  /** Only a slug that cannot inject prose is interpolated into the prompt. */
  private static safeIdentity(slug: string): string | null {
    const trimmed = slug.trim();
    if (trimmed.length === 0 || trimmed.length > 128) return null;
    return /^[A-Za-z0-9._/@:+\-[\]~]+$/.test(trimmed) ? trimmed : null;
  }

  /**
   * Fills every field Codex's strict parser requires.
   *
   * This is the highest-stakes function in the file: Codex rejects the whole
   * catalog when a single row fails to parse, which costs the user every model
   * rather than the offending one. Every row goes through it, freshly built or
   * preserved from disk.
   *
   * `routed` marks a row Tokkey authored. Only those rows have their reasoning
   * ladder rewritten; every other field is normalized the same way for all rows.
   */
  static ensureStrictFields(
    entry: CatalogEntry,
    options: { routed?: boolean } = {}
  ): CatalogEntry {
    // Rewritten on a routed row only: it is a clone, so the ladder it inherited
    // describes the native model rather than the one the gateway forwards to,
    // and an absent field would let Codex fall back to a ladder of its own. An
    // empty list says plainly that this row offers none, and the default that
    // indexed into the old ladder goes with it. A native row's ladder is the
    // model's own and is left exactly as Codex wrote it, so the picker still
    // offers the reasoning levels those models really support.
    if (options.routed) {
      entry.supported_reasoning_levels = [];
      delete entry.default_reasoning_level;
    }
    if (typeof entry.supports_reasoning_summaries !== 'boolean') entry.supports_reasoning_summaries = false;
    if (typeof entry.default_reasoning_summary !== 'string') entry.default_reasoning_summary = 'none';
    if (typeof entry.support_verbosity !== 'boolean') entry.support_verbosity = true;
    if (typeof entry.default_verbosity !== 'string') entry.default_verbosity = 'low';
    if (typeof entry.apply_patch_tool_type !== 'string') entry.apply_patch_tool_type = 'freeform';
    if (typeof entry.supports_parallel_tool_calls !== 'boolean') entry.supports_parallel_tool_calls = true;
    if (typeof entry.supports_image_detail_original !== 'boolean') entry.supports_image_detail_original = false;
    if (!Array.isArray(entry.experimental_supported_tools)) entry.experimental_supported_tools = [];
    if (
      !entry.truncation_policy ||
      typeof entry.truncation_policy !== 'object' ||
      Array.isArray(entry.truncation_policy)
    ) {
      entry.truncation_policy = { mode: 'tokens', limit: 10000 };
    }

    // `input_modalities` is a closed enum upstream, and one out-of-enum value
    // makes the entire catalog unparseable, so it is normalized here — the one
    // point every row passes through.
    const modalities = Array.isArray(entry.input_modalities) ? entry.input_modalities : [];
    const accepted = modalities.filter(
      (value) => value === 'text' || value === 'image' || value === 'audio'
    );
    entry.input_modalities = accepted.length > 0 ? accepted : ['text'];

    if (typeof entry.effective_context_window_percent !== 'number') entry.effective_context_window_percent = 95;
    if (typeof entry.comp_hash !== 'string') entry.comp_hash = 'tokkey';
    if (typeof entry.auto_compact_token_limit !== 'number') {
      // The window itself is never written, so the row it was read from cannot
      // supply one either: the threshold falls back to the assumed window.
      const contextWindow =
        typeof entry.context_window === 'number' && entry.context_window > 0
          ? entry.context_window
          : DEFAULT_CONTEXT_WINDOW;
      entry.auto_compact_token_limit = Math.floor(contextWindow * COMPACTION_HEADROOM);
    }
    return entry;
  }
}

/**
 * Combines the rows built this run with whatever the catalog already holds.
 *
 * Rows Tokkey did not write are always kept: the native rows Codex ships carry
 * per-model state nothing here could rebuild, and a row another tool wrote is
 * that tool's business. Rows Tokkey did write are replaced by this run's set,
 * which is what makes a disconnected model disappear.
 */
export class CatalogMerger {
  merge(existing: readonly CatalogEntry[], routed: readonly CatalogEntry[]): CatalogEntry[] {
    const freshSlugs = new Set(
      routed.flatMap((entry) => (typeof entry.slug === 'string' ? [entry.slug] : []))
    );
    const preserved = existing.filter(
      (entry) =>
        !CatalogEntryFactory.isTokkeyAuthored(entry) &&
        !(typeof entry.slug === 'string' && freshSlugs.has(entry.slug))
    );
    // Preserved rows bypassed the factory, so the invariants they may predate
    // are re-applied here; a row Codex cannot parse takes down the whole file.
    // None of them is ours — the filter above dropped those — so they are
    // normalized as non-routed and keep their own reasoning ladder.
    return [
      ...preserved.map((entry) => CatalogEntryFactory.ensureStrictFields(entry)),
      ...routed
    ];
  }
}

/**
 * Writes the catalog Codex reads when `model_catalog_json` points at it.
 *
 * Codex builds a static model list from that file and never refreshes it, so
 * the file has to carry everything the user should see: the native models Codex
 * ships with, seeded once from its own bundled catalog, plus one row per model
 * Tokkey routes through the gateway.
 */
export class CodexCatalogGenerator {
  private readonly catalogPath: string;
  private readonly store = new CatalogFileStore();
  private readonly serializer = new CatalogSerializer();
  private readonly factory = new CatalogEntryFactory();
  private readonly merger = new CatalogMerger();
  private readonly nativeSource: () => CatalogDocument | null;

  constructor(options: {
    catalogPath: string;
    /**
     * The native rows to seed a catalog that has none, read synchronously.
     * Acquiring them costs a CLI call, so it is the caller's job to do that off
     * the critical path and hand over a cached result.
     */
    nativeSource?: () => CatalogDocument | null;
  }) {
    this.catalogPath = options.catalogPath;
    this.nativeSource = options.nativeSource ?? (() => null);
  }

  get path(): string {
    return this.catalogPath;
  }

  /** Builds, merges, and persists the catalog for `models`. */
  generate(models: readonly CatalogModelInput[]): CatalogGenerationResult {
    const existing = this.store.read(this.catalogPath);
    const existingModels = existing?.models ?? [];
    // The seed only fills a catalog that carries no rows but Tokkey's own. Rows
    // already on disk always win: they hold per-account state a bundled dump
    // cannot know about, and a catalog holding only our rows would leave the
    // user without the native models and without a template to clone.
    const natives = existingModels.some((entry) => !CatalogEntryFactory.isTokkeyAuthored(entry))
      ? []
      : this.readNatives();
    const available: CatalogDocument = { models: [...existingModels, ...natives] };

    const template = CatalogEntryFactory.findTemplate(available);
    const routed = models.map((model) => this.factory.build(template, model));
    const merged = this.merger
      .merge(available.models ?? [], routed)
      .map((entry) => CodexCatalogGenerator.omitDerivedFields(entry));

    // Unknown top-level keys are preserved: a Codex setting Tokkey does not
    // model must survive a rewrite of this file.
    const document: CatalogDocument = { ...(existing ?? {}), models: merged };
    const written = this.store.writeIfChanged(this.catalogPath, this.serializer.render(document));
    return { path: this.catalogPath, routed: routed.length, written, models: merged };
  }

  /** One row without the fields Codex should derive for itself. */
  private static omitDerivedFields(entry: CatalogEntry): CatalogEntry {
    const kept = Object.entries(entry).filter(([key]) => !OMITTED_FIELDS.includes(key));
    return Object.fromEntries(kept);
  }

  /** The seed rows, or none when the source is absent or unreadable. */
  private readNatives(): CatalogEntry[] {
    try {
      const models = this.nativeSource()?.models ?? [];
      return models.map((entry) => {
        const clone = JSON.parse(JSON.stringify(entry)) as CatalogEntry;
        // Codex hides a row whose `minimal_client_version` outranks the
        // installed binary, and the seed may outlive the CLI that produced it.
        delete clone.minimal_client_version;
        return clone;
      });
    } catch (error: unknown) {
      // A thinner catalog beats refusing to write one at all.
      console.error('[CodexCatalog] Could not read the native seed catalog:', error);
      return [];
    }
  }
}

export default CodexCatalogGenerator;
