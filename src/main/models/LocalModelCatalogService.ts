import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { LocalModelDescriptor } from '../../shared/types';

const MODEL_CATALOG_ROOT = 'https://cpilot.net/api/model-catalog';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const DETAIL_CONCURRENCY = 6;

type JsonRecord = Record<string, unknown>;
export type ModelCatalogFetch = (input: string) => Promise<Response>;

interface CatalogCache {
  savedAt: number;
  models: LocalModelDescriptor[];
  providers: string[];
}

/** Fetches, normalizes, and atomically caches the remote local-model catalog. */
export class LocalModelCatalogService {
  private readonly cachePath: string;
  private readonly fetcher: ModelCatalogFetch;
  private cache: CatalogCache | null = null;

  constructor(options: { homeDirectory?: string; fetcher?: ModelCatalogFetch } = {}) {
    const homeDirectory = options.homeDirectory ?? os.homedir();
    this.cachePath = path.join(homeDirectory, '.amiswifi', 'model_catalog_cache.json');
    this.fetcher = options.fetcher ?? ((input) => fetch(input));
  }

  /** Returns cached data immediately when it is still fresh, otherwise refreshes it. */
  async load(forceRefresh = false): Promise<{ models: LocalModelDescriptor[]; providers: string[]; fromCache: boolean }> {
    const cached = await this.readCache();
    if (!forceRefresh && cached && Date.now() - cached.savedAt < CACHE_TTL_MS) {
      return { models: [...cached.models], providers: [...cached.providers], fromCache: true };
    }
    try {
      const fresh = await this.fetchCatalog();
      this.cache = fresh;
      await this.writeCache(fresh);
      return { models: [...fresh.models], providers: [...fresh.providers], fromCache: false };
    } catch (error) {
      if (cached) {
        return { models: [...cached.models], providers: [...cached.providers], fromCache: true };
      }
      throw new Error(`Unable to load model catalog: ${this.describeError(error)}`);
    }
  }

  private async fetchCatalog(): Promise<CatalogCache> {
    const brandsPayload = await this.fetchJson(`${MODEL_CATALOG_ROOT}/brands/`);
    const brands = this.extractList(brandsPayload, ['brands', 'providers', 'data']);
    const providerNames = brands.map((brand) => this.displayValue(brand, ['name', 'title', 'slug', 'id'])).filter(Boolean);
    const models: LocalModelDescriptor[] = [];
    const providerResults = await this.mapWithConcurrency(brands, DETAIL_CONCURRENCY, async (brand) => {
      const providerSlug = this.slugValue(brand, ['slug', 'id', 'name']);
      if (!providerSlug) return [];
      try {
        return await this.fetchProvider(providerSlug, this.displayValue(brand, ['name', 'title', 'slug']) || providerSlug);
      } catch {
        return [];
      }
    });
    providerResults.forEach((result) => models.push(...result));
    return { savedAt: Date.now(), models: this.dedupeModels(models), providers: providerNames };
  }

  private async fetchProvider(providerSlug: string, providerName: string): Promise<LocalModelDescriptor[]> {
    const seriesPayload = await this.fetchJson(`${MODEL_CATALOG_ROOT}/brands/${encodeURIComponent(providerSlug)}/`);
    const seriesRecords = this.extractList(seriesPayload, ['series', 'models', 'data']);
    const nested = await this.mapWithConcurrency(seriesRecords, DETAIL_CONCURRENCY, async (series) => {
      const seriesSlug = this.slugValue(series, ['slug', 'id', 'name']);
      if (!seriesSlug) return this.artifactsFromRecord(series, providerName, '', providerSlug);
      try {
        const sizesPayload = await this.fetchJson(`${MODEL_CATALOG_ROOT}/series/${encodeURIComponent(seriesSlug)}/`);
        const sizes = this.extractList(sizesPayload, ['sizes', 'artifacts', 'models', 'data']);
        const artifacts: LocalModelDescriptor[] = [];
        for (const size of sizes) {
          const sizeSlug = this.slugValue(size, ['slug', 'id', 'name']) || seriesSlug;
          let sizeDetails = size;
          try {
            sizeDetails = await this.fetchJson(`${MODEL_CATALOG_ROOT}/sizes/${encodeURIComponent(sizeSlug)}/`);
          } catch {
            // The series payload can still provide a visible unsupported row.
          }
          const normalizedSize = this.unwrapRecord(sizeDetails) ?? this.asRecord(size) ?? size;
          const listedArtifacts = this.extractList(normalizedSize, ['artifacts', 'files', 'quantizations', 'data']);
          const defaultArtifact = this.asRecord(normalizedSize)?.defaultArtifact;
          const artifactRecords = listedArtifacts.length > 0
            ? listedArtifacts
            : defaultArtifact && typeof defaultArtifact === 'object' ? [defaultArtifact] : [];
          if (artifactRecords.length === 0) {
            artifacts.push(...this.artifactsFromRecord(normalizedSize, providerName, seriesSlug, providerSlug, sizeSlug));
            continue;
          }
          artifactRecords.forEach((artifact) => {
            artifacts.push(...this.artifactsFromRecord(
              artifact,
              providerName,
              seriesSlug,
              providerSlug,
              sizeSlug
            ));
          });
        }
        return artifacts;
      } catch {
        return this.artifactsFromRecord(series, providerName, seriesSlug, providerSlug);
      }
    });
    return nested.flat();
  }

  private artifactsFromRecord(
    value: unknown,
    providerName: string,
    seriesSlug: string,
    providerSlug: string,
    sizeSlug = ''
  ): LocalModelDescriptor[] {
    const record = this.asRecord(value);
    if (!record) return [];
    const fileName = this.displayValue(record, ['fileName', 'filename', 'file', 'name']) || `${sizeSlug || seriesSlug}.gguf`;
    const huggingFaceUrl = this.urlValue(record, ['huggingFaceUrl', 'huggingface', 'hugging_face', 'hfUrl', 'hf']);
    const modelScopeUrl = this.urlValue(record, ['modelScopeUrl', 'modelscope', 'model_scope', 'msUrl', 'ms']);
    const directUrl = this.urlValue(record, ['url', 'downloadUrl', 'download_url']);
    const finalHuggingFaceUrl = huggingFaceUrl ?? (directUrl?.includes('huggingface.co') ? directUrl : null);
    const finalModelScopeUrl = modelScopeUrl ?? (directUrl?.includes('modelscope.cn') ? directUrl : null);
    const downloadFlag = record.downloadable ?? record.isDownloadable;
    const downloadable = downloadFlag !== false && Boolean(finalHuggingFaceUrl || finalModelScopeUrl);
    const quantization = this.displayValue(record, ['quantization', 'quant', 'format', 'slug']) || fileName;
    const id = [providerSlug, seriesSlug || 'model', sizeSlug || 'size', quantization]
      .filter(Boolean)
      .join(':')
      .replace(/[^a-zA-Z0-9:_-]+/g, '-');
    return [{
      id,
      provider: providerName,
      series: this.displayValue(record, ['series', 'model', 'displayName']) || seriesSlug || providerName,
      name: this.displayValue(record, ['displayName', 'label', 'title', 'name']) || fileName,
      fileName,
      sizeBytes: this.byteValue(record, ['sizeBytes', 'size', 'diskSize', 'fileSize', 'downloadSizeGb']),
      requiredRamBytes: this.byteValue(record, ['requiredRamBytes', 'ram', 'memory', 'minRam', 'requiredMemoryGb', 'recommendedMemoryGb', 'minimumMemoryGb']),
      huggingFaceUrl: finalHuggingFaceUrl,
      modelScopeUrl: finalModelScopeUrl,
      downloadable,
      sourceError: downloadable ? null : 'No resolvable Hugging Face or ModelScope source.'
    }];
  }

  private async fetchJson(url: string): Promise<unknown> {
    const response = await this.fetcher(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  private async readCache(): Promise<CatalogCache | null> {
    if (this.cache) return this.cache;
    try {
      const parsed = JSON.parse(await readFile(this.cachePath, 'utf8')) as Partial<CatalogCache>;
      if (!Array.isArray(parsed.models) || !Array.isArray(parsed.providers) || typeof parsed.savedAt !== 'number') return null;
      this.cache = { savedAt: parsed.savedAt, models: parsed.models as LocalModelDescriptor[], providers: parsed.providers.map(String) };
      return this.cache;
    } catch {
      return null;
    }
  }

  private async writeCache(cache: CatalogCache): Promise<void> {
    await mkdir(path.dirname(this.cachePath), { recursive: true });
    const temporaryPath = `${this.cachePath}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(cache), 'utf8');
    await rename(temporaryPath, this.cachePath);
  }

  private extractList(value: unknown, keys: string[]): unknown[] {
    if (Array.isArray(value)) return value;
    const record = this.asRecord(value);
    if (!record) return [];
    for (const key of keys) {
      if (Array.isArray(record[key])) return record[key] as unknown[];
    }
    if (Array.isArray(record.results)) return record.results as unknown[];
    const nestedData = this.asRecord(record.data);
    if (nestedData) return this.extractList(nestedData, keys);
    return [];
  }

  private unwrapRecord(value: unknown): JsonRecord | null {
    const record = this.asRecord(value);
    if (!record) return null;
    return this.asRecord(record.data) ?? record;
  }

  private asRecord(value: unknown): JsonRecord | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
  }

  private displayValue(value: unknown, keys: string[]): string {
    const record = this.asRecord(value);
    if (!record) return typeof value === 'string' ? value.trim() : '';
    for (const key of keys) {
      const candidate = record[key];
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
    return '';
  }

  private slugValue(value: unknown, keys: string[]): string {
    return this.displayValue(value, keys).toLowerCase().replace(/\s+/g, '-');
  }

  private urlValue(value: unknown, keys: string[]): string | null {
    const record = this.asRecord(value);
    if (!record) return null;
    for (const key of keys) {
      const candidate = record[key];
      if (typeof candidate === 'string' && /^https?:\/\//i.test(candidate)) return candidate;
      const nested = this.asRecord(candidate);
      const nestedUrl = nested ? this.displayValue(nested, ['url', 'downloadUrl', 'download_url']) : '';
      if (nestedUrl && /^https?:\/\//i.test(nestedUrl)) return nestedUrl;
    }
    return null;
  }

  private byteValue(value: unknown, keys: string[]): number | null {
    const record = this.asRecord(value);
    if (!record) return null;
    for (const key of keys) {
      const candidate = record[key];
      if (typeof candidate === 'number' && Number.isFinite(candidate)) {
        return key.toLocaleLowerCase().includes('gb') ? Math.round(candidate * 1024 ** 3) : candidate;
      }
      if (typeof candidate === 'string') {
        const match = candidate.trim().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)?$/i);
        if (!match) continue;
        const unit = (match[2] ?? 'b').toLowerCase();
        const multiplier = unit === 'tb' ? 1024 ** 4 : unit === 'gb' ? 1024 ** 3 : unit === 'mb' ? 1024 ** 2 : unit === 'kb' ? 1024 : 1;
        return Math.round(Number(match[1]) * multiplier);
      }
    }
    return null;
  }

  private dedupeModels(models: LocalModelDescriptor[]): LocalModelDescriptor[] {
    return [...new Map(models.map((model) => [model.id, model])).values()];
  }

  private async mapWithConcurrency<T, R>(values: T[], concurrency: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
    const results: R[] = [];
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < values.length) {
        const index = cursor++;
        results[index] = await mapper(values[index]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
    return results;
  }

  private describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

export default LocalModelCatalogService;
