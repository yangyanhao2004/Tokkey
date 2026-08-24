import type {
  SkillsShPage,
  SkillsShSearchResult,
  SkillsShSkill,
  SkillsShSourceKind
} from '../../shared/types';

const DEFAULT_BASE_URL = 'https://www.skills.sh';
const API_PAGE_SIZE = 200;
const MAX_ATTEMPTS = 4;
const RETRY_BASE_MS = 500;
const RETRY_CAP_MS = 8_000;
const RETRY_JITTER_FRACTION = 0.3;
const REQUEST_TIMEOUT_MS = 30_000;

export type SkillsShFetch = (input: string, init?: RequestInit) => Promise<Response>;
export type SkillsShSleep = (delayMs: number) => Promise<void>;

/** Error raised when a skills.sh response cannot be safely decoded or accepted. */
export class SkillsShError extends Error {
  readonly requestName: string;
  readonly attempts: number;
  readonly retryable: boolean;

  constructor(requestName: string, attempts: number, message: string, retryable = false) {
    super(`${requestName} failed after ${attempts} attempt${attempts === 1 ? '' : 's'}: ${message}`);
    this.name = 'SkillsShError';
    this.requestName = requestName;
    this.attempts = attempts;
    this.retryable = retryable;
  }
}

export interface SkillsShClientOptions {
  baseUrl?: string;
  fetcher?: SkillsShFetch;
  sleep?: SkillsShSleep;
  random?: () => number;
  maxAttempts?: number;
  requestTimeoutMs?: number;
}

/** Performs skills.sh browse/search requests with one shared retry policy. */
export class SkillsShClient {
  private readonly baseUrl: string;
  private readonly fetcher: SkillsShFetch;
  private readonly sleep: SkillsShSleep;
  private readonly random: () => number;
  private readonly maxAttempts: number;
  private readonly requestTimeoutMs: number;

  constructor(options: SkillsShClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
    this.sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    this.random = options.random ?? Math.random;
    this.maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1) {
      throw new RangeError('Maximum attempts must be a positive integer');
    }
  }

  /** Fetches one zero-based, 200-record browse page. */
  async fetchPage(page: number): Promise<SkillsShPage> {
    this.validatePage(page);
    const payload = await this.getJson(`/api/skills/all-time/${page}`, `page ${page}`);
    return this.decodeBrowsePayload(payload, page);
  }

  /** Searches the server-capped result set; the endpoint requires three characters. */
  async search(query: string): Promise<SkillsShSkill[]> {
    const normalizedQuery = this.normalizeQuery(query);
    const payload = await this.getJson(
      `/api/search?q=${encodeURIComponent(normalizedQuery)}`,
      `search "${normalizedQuery}"`
    );
    return this.decodeSearchPayload(payload).skills;
  }

  /** Exposes the response count for callers that need search metadata. */
  async searchResult(query: string): Promise<SkillsShSearchResult> {
    const normalizedQuery = this.normalizeQuery(query);
    const payload = await this.getJson(
      `/api/search?q=${encodeURIComponent(normalizedQuery)}`,
      `search "${normalizedQuery}"`
    );
    return this.decodeSearchPayload(payload);
  }

  /** Fetches a JSON document for a cooperating downloader using the same retry policy. */
  fetchJson(relativePath: string, requestName: string): Promise<unknown> {
    return this.getJson(relativePath, requestName);
  }

  /** Fetches raw bytes for a cooperating downloader using the same retry policy. */
  async fetchBytes(relativePath: string, requestName: string, timeoutMs = this.requestTimeoutMs): Promise<Uint8Array> {
    const url = `${this.baseUrl}${relativePath}`;
    let lastError: unknown = new Error('request did not start');
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const response = await this.fetchWithTimeout(url, timeoutMs);
        if (!response.ok) {
          const message = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
          if (!this.isRetryableStatus(response.status)) {
            throw new SkillsShError(requestName, attempt, `${message}; rejected - retrying will not help`);
          }
          throw new RetryableSkillsShError(message);
        }
        return new Uint8Array(await response.arrayBuffer());
      } catch (error) {
        lastError = error;
        if (error instanceof SkillsShError) {
          throw error;
        }
        if (attempt >= this.maxAttempts || !this.isRetryableError(error)) {
          throw new SkillsShError(requestName, attempt, this.describeError(error));
        }
        await this.sleep(this.retryDelay(attempt));
      }
    }
    throw new SkillsShError(requestName, this.maxAttempts, this.describeError(lastError));
  }

  /** Classifies a source using the slash-first rule from skills.sh. */
  static classifySource(source: string): SkillsShSourceKind {
    return source.includes('/') || !source.includes('.') ? 'repository' : 'site';
  }

  private async getJson(relativePath: string, requestName: string): Promise<unknown> {
    const url = `${this.baseUrl}${relativePath}`;
    let lastError: unknown = new Error('request did not start');
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const response = await this.fetchWithTimeout(url);
        if (!response.ok) {
          const message = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
          if (!this.isRetryableStatus(response.status)) {
            throw new SkillsShError(requestName, attempt, `${message}; rejected - retrying will not help`);
          }
          throw new RetryableSkillsShError(message);
        }
        try {
          return await response.json() as unknown;
        } catch (error) {
          throw new SkillsShError(requestName, attempt, `invalid JSON: ${this.describeError(error)}`);
        }
      } catch (error) {
        lastError = error;
        if (error instanceof SkillsShError) {
          throw error;
        }
        if (attempt >= this.maxAttempts || !this.isRetryableError(error)) {
          throw new SkillsShError(requestName, attempt, this.describeError(error), attempt < this.maxAttempts);
        }
        await this.sleep(this.retryDelay(attempt));
      }
    }
    throw new SkillsShError(requestName, this.maxAttempts, this.describeError(lastError));
  }

  private async fetchWithTimeout(url: string, timeoutMs = this.requestTimeoutMs): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.fetcher(url, { method: 'GET', signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  private decodeBrowsePayload(payload: unknown, requestedPage: number): SkillsShPage {
    if (!this.isRecord(payload) || !Array.isArray(payload.skills)) {
      throw new SkillsShError(`page ${requestedPage}`, 1, 'invalid browse payload');
    }
    const total = this.optionalNonNegativeInteger(payload.total, 'total');
    const page = this.optionalNonNegativeInteger(payload.page, 'page') ?? requestedPage;
    const skills = payload.skills.map((record, index) => this.decodeSkill(record, `page ${requestedPage} skill ${index}`));
    const hasMore = typeof payload.hasMore === 'boolean'
      ? payload.hasMore
      : (page + 1) * API_PAGE_SIZE < (total ?? skills.length);
    return { skills, total: total ?? skills.length, hasMore, page };
  }

  private decodeSearchPayload(payload: unknown): SkillsShSearchResult {
    if (!this.isRecord(payload) || !Array.isArray(payload.skills)) {
      throw new SkillsShError('search', 1, 'invalid search payload');
    }
    const skills = payload.skills.map((record, index) => this.decodeSkill(record, `search skill ${index}`));
    const count = this.optionalNonNegativeInteger(payload.count, 'count') ?? skills.length;
    return { skills, count };
  }

  private decodeSkill(payload: unknown, context: string): SkillsShSkill {
    if (!this.isRecord(payload)) {
      throw new SkillsShError(context, 1, 'skill record is not an object');
    }
    const source = this.requiredString(payload.source, `${context} source`);
    const skillId = this.requiredString(payload.skillId, `${context} skillId`);
    const name = this.requiredString(payload.name, `${context} name`);
    const installs = this.optionalNonNegativeInteger(payload.installs, `${context} installs`) ?? 0;
    const isOfficial = payload.isOfficial === undefined ? false : this.requiredBoolean(payload.isOfficial, `${context} isOfficial`);
    const sourceKind = SkillsShClient.classifySource(source);
    return {
      id: `${source}/${skillId}`,
      source,
      skillId,
      name,
      installs,
      isOfficial,
      sourceKind,
      url: this.makeSkillUrl(source, skillId, sourceKind)
    };
  }

  private makeSkillUrl(source: string, skillId: string, sourceKind: SkillsShSourceKind): string {
    const encodedSkillId = encodeURIComponent(skillId);
    return sourceKind === 'repository'
      ? `${this.baseUrl}/${source.split('/').map((segment) => encodeURIComponent(segment)).join('/')}/${encodedSkillId}`
      : `${this.baseUrl}/site/${encodeURIComponent(source)}/${encodedSkillId}`;
  }

  private normalizeQuery(query: string): string {
    if (typeof query !== 'string') {
      throw new TypeError('skills.sh search query must be a string');
    }
    const normalizedQuery = query.trim();
    if (normalizedQuery.length < 3) {
      throw new TypeError('skills.sh search query must contain at least 3 characters');
    }
    return normalizedQuery;
  }

  private validatePage(page: number): void {
    if (!Number.isInteger(page) || page < 0) {
      throw new RangeError('skills.sh page must be a non-negative integer');
    }
  }

  private optionalNonNegativeInteger(value: unknown, label: string): number | null {
    if (value === undefined || value === null) {
      return null;
    }
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new SkillsShError(label, 1, `${label} must be a non-negative integer`);
    }
    return value;
  }

  private requiredString(value: unknown, label: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new SkillsShError(label, 1, `${label} must be a non-empty string`);
    }
    return value.trim();
  }

  private requiredBoolean(value: unknown, label: string): boolean {
    if (typeof value !== 'boolean') {
      throw new SkillsShError(label, 1, `${label} must be a boolean`);
    }
    return value;
  }

  private isRetryableStatus(status: number): boolean {
    return status === 429 || status >= 500;
  }

  private isRetryableError(error: unknown): boolean {
    return error instanceof RetryableSkillsShError || error instanceof TypeError || error instanceof Error;
  }

  private retryDelay(attempt: number): number {
    const exponentialDelay = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * (2 ** (attempt - 1)));
    const jitter = (this.random() * 2 - 1) * RETRY_JITTER_FRACTION;
    return Math.max(0, Math.round(exponentialDelay * (1 + jitter)));
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  private describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

class RetryableSkillsShError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableSkillsShError';
  }
}

export { API_PAGE_SIZE, MAX_ATTEMPTS, RETRY_BASE_MS, RETRY_CAP_MS, RETRY_JITTER_FRACTION };
export default SkillsShClient;
