import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import TokkeyHome from '../storage/TokkeyHome';
import { FALLBACK_MODEL_PRICES } from './modelPriceFallback';

/**
 * What one model charges, per token, for each of the four kinds of token a call can
 * spend. Field names are the published file's own, so a rate can be traced back to its
 * source without a translation table in between.
 */
export interface ModelPriceRates {
  readonly input_cost_per_token?: number;
  readonly output_cost_per_token?: number;
  readonly cache_creation_input_token_cost?: number;
  readonly cache_read_input_token_cost?: number;
}

/** Every priced model, keyed by the bare slug the router records in `usage_calls`. */
export type ModelPriceTable = Readonly<Record<string, ModelPriceRates>>;

const SOURCE_URL =
  'https://raw.githubusercontent.com/Wei-Shaw/model-price-repo/main/model_prices_and_context_window.json';

/** Rates move rarely; a week keeps the figures current without a fetch per launch. */
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Long enough for a slow link, short enough that a launch is never held up by it. */
const FETCH_TIMEOUT_MS = 10_000;

const CACHE_FILE_NAME = 'model_prices_cache.json';

/** The four fields a cost is computed from; everything else in the file is ignored. */
const RATE_FIELDS = [
  'input_cost_per_token',
  'output_cost_per_token',
  'cache_creation_input_token_cost',
  'cache_read_input_token_cost'
] as const;

/** The cache file's shape: the table, plus when it was read from the network. */
interface CachedPrices {
  fetchedAtEpochMs: number;
  prices: ModelPriceTable;
}

export interface ModelPriceCatalogOptions {
  homeDirectory?: string;
  cachePath?: string;
  /** Overridden by tests, which must never reach the network. */
  fetchJson?: (url: string) => Promise<unknown>;
  /** Overridden by tests to age a cache without waiting a week. */
  now?: () => number;
}

/**
 * Where the price of a model call comes from.
 *
 * Rates are published by a third party and change without warning, so they are neither
 * hardcoded nor fetched on every call. Four sources are tried in order, each a fallback
 * for the one before it:
 *
 * 1. A cache newer than a week, which is the common case and costs no network.
 * 2. The published file, fetched once and then cached.
 * 3. The cache again, however old, because a stale rate prices a call far better than
 *    no rate at all.
 * 4. The table committed to this repository, so a machine that has never been online
 *    still draws a figure instead of a blank.
 *
 * Resolution happens once per process and is then held in memory: pricing a page of
 * twenty queries must not mean twenty file reads.
 */
export class ModelPriceCatalog {
  private readonly cachePath: string;
  private readonly fetchJson: (url: string) => Promise<unknown>;
  private readonly now: () => number;

  /** Null until the first `load`, then the table every later lookup reads. */
  private prices: ModelPriceTable | null = null;
  /** Held so concurrent callers share one fetch rather than racing to start four. */
  private loading: Promise<ModelPriceTable> | null = null;

  constructor(options: ModelPriceCatalogOptions = {}) {
    const homeDirectory = options.homeDirectory ?? os.homedir();
    this.cachePath =
      options.cachePath ?? new TokkeyHome({ homeDirectory }).pathFor(CACHE_FILE_NAME);
    this.fetchJson = options.fetchJson ?? ModelPriceCatalog.fetchJsonOverHttp;
    this.now = options.now ?? Date.now;
  }

  /** Resolves the table once, then answers from memory. */
  async load(): Promise<ModelPriceTable> {
    if (this.prices) return this.prices;
    this.loading ??= this.resolve();
    this.prices = await this.loading;
    this.loading = null;
    return this.prices;
  }

  /**
   * What one model charges, or null when nothing prices it. A caller that cannot price a
   * call reports zero rather than guessing, so an unknown model reads as "no cost known"
   * instead of "free".
   */
  ratesFor(modelSlug: string): ModelPriceRates | null {
    return this.prices?.[modelSlug] ?? null;
  }

  /** The four sources in order, each tried only when the one before it produced nothing. */
  private async resolve(): Promise<ModelPriceTable> {
    const cached = this.readCache();
    if (cached && this.now() - cached.fetchedAtEpochMs < CACHE_MAX_AGE_MS) {
      return cached.prices;
    }

    const fetched = await this.fetchPrices();
    if (fetched) {
      this.writeCache(fetched);
      return fetched;
    }

    // The fetch failed. A cache too old to trust on its own still beats no rates.
    if (cached) {
      console.warn('[Usage] Using stale cached model prices; the price list was unreachable.');
      return cached.prices;
    }

    console.warn('[Usage] Using the bundled model price table; nothing newer is available.');
    return FALLBACK_MODEL_PRICES;
  }

  /** One fetch attempt, reporting failure rather than throwing into the caller's page. */
  private async fetchPrices(): Promise<ModelPriceTable | null> {
    try {
      const published = await this.fetchJson(SOURCE_URL);
      const table = ModelPriceCatalog.trim(published);
      // A file that parsed but priced nothing is a bad file, not an empty price list.
      return Object.keys(table).length > 0 ? table : null;
    } catch (error) {
      console.warn('[Usage] Could not fetch model prices:', error);
      return null;
    }
  }

  private readCache(): CachedPrices | null {
    try {
      const parsed = JSON.parse(readFileSync(this.cachePath, 'utf8')) as Partial<CachedPrices>;
      if (typeof parsed?.fetchedAtEpochMs !== 'number' || !parsed.prices) return null;
      return { fetchedAtEpochMs: parsed.fetchedAtEpochMs, prices: parsed.prices };
    } catch {
      // A missing or unreadable cache is the ordinary first-run state, not an error.
      return null;
    }
  }

  private writeCache(prices: ModelPriceTable): void {
    try {
      const cached: CachedPrices = { fetchedAtEpochMs: this.now(), prices };
      writeFileSync(this.cachePath, JSON.stringify(cached), 'utf8');
    } catch (error) {
      // A cache that cannot be written costs a fetch next launch and nothing else.
      console.warn('[Usage] Could not cache model prices:', error);
    }
  }

  /** Keeps only the rate fields, so a cache holds ~29 KB rather than ~257 KB. */
  private static trim(published: unknown): ModelPriceTable {
    if (!published || typeof published !== 'object') return {};
    const table: Record<string, ModelPriceRates> = {};

    for (const [slug, entry] of Object.entries(published as Record<string, unknown>)) {
      // `sample_spec` documents the file's own format and prices nothing.
      if (slug === 'sample_spec' || !entry || typeof entry !== 'object') continue;
      const source = entry as Record<string, unknown>;
      const rates: Record<string, number> = {};
      for (const field of RATE_FIELDS) {
        const value = source[field];
        if (typeof value === 'number' && Number.isFinite(value)) rates[field] = value;
      }
      if (Object.keys(rates).length > 0) table[slug] = rates;
    }

    return table;
  }

  private static async fetchJsonOverHttp(url: string): Promise<unknown> {
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return response.json();
  }
}

export default ModelPriceCatalog;
