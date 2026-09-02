import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { GatewayEndpoint } from '../gateway/GatewayModelClient';
import GatewayPortResolver from '../gateway/GatewayPortResolver';
import CodexProviderConfig, { type CodexProviderEndpoint } from './CodexProviderConfig';

/** Spellings of "this machine" that a loopback URL may use. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

/** How long a probe of an unfamiliar endpoint may hold up the launch. */
const PROBE_TIMEOUT_MS = 5000;

/** Injected so tests do not reach the network. */
export type EndpointFetch = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Asks an OpenAI-compatible endpoint whether it serves the models Tokkey routes.
 *
 * A base URL alone proves nothing — anything can answer on a port. Listing the
 * models is the cheapest question whose answer distinguishes a real upstream
 * for `gpt-5.5` from a proxy, a captive portal, or another local tool.
 *
 * Both path shapes are tried because a Codex `base_url` may or may not already
 * carry `/v1`, and the CLI appends its own path either way.
 */
export class OpenAiModelsProbe {
  private static readonly PATHS = ['/models', '/v1/models'];

  private readonly fetcher: EndpointFetch;
  private readonly timeoutMs: number;

  constructor(options: { fetcher?: EndpointFetch; timeoutMs?: number } = {}) {
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  }

  /** Whether this endpoint lists at least one GPT model. */
  async servesGptModels(endpoint: CodexProviderEndpoint): Promise<boolean> {
    const base = endpoint.baseUrl.replace(/\/+$/, '');
    for (const suffix of OpenAiModelsProbe.PATHS) {
      const identifiers = await this.listModels(`${base}${suffix}`, endpoint.apiKey);
      if (identifiers.some((identifier) => /gpt/i.test(identifier))) {
        return true;
      }
    }
    return false;
  }

  /** The model identifiers one listing returns, empty when it cannot be read. */
  private async listModels(url: string, apiKey: string | null): Promise<string[]> {
    try {
      const response = await this.fetcher(url, {
        method: 'GET',
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(this.timeoutMs)
      });
      if (!response.ok) return [];
      return this.identifiersIn(await response.json());
    } catch (error: unknown) {
      console.error(`[CodexModels] Could not list models at ${url}:`, error);
      return [];
    }
  }

  /** Reads model ids out of either listing shape an endpoint may answer with. */
  private identifiersIn(payload: unknown): string[] {
    const entries = Array.isArray(payload)
      ? payload
      : (payload as { data?: unknown })?.data ?? (payload as { models?: unknown })?.models;
    if (!Array.isArray(entries)) return [];
    return entries
      .map((entry) => (typeof entry === 'string' ? entry : (entry as { id?: unknown })?.id))
      .filter((identifier): identifier is string => typeof identifier === 'string');
  }
}

/**
 * The endpoint Tokkey serves Codex native models from, remembered across launches.
 *
 * `config.toml` cannot be trusted to still name the user's own upstream, because
 * pointing the Codex CLI at Tokkey rewrites that file with this gateway's own
 * address. Reading it back on the next launch would register the gateway as its
 * own upstream — a loop that then feeds itself, since every later launch reads
 * what the previous one adopted.
 *
 * So the original endpoint is written down the first time it is seen, and that
 * record is what the routes are built from. The file is only ever replaced by a
 * candidate that clears both bars:
 *
 * 1. It is not the gateway's own address, which is the one endpoint that cannot
 *    answer for these models because it is the thing asking. Every other local
 *    address is a legitimate candidate — a relay a user runs on this machine is
 *    still a relay — and is judged the same way a remote one is.
 * 2. It answers a model listing containing GPT models, so a user who genuinely
 *    moved to a different relay is followed, and a stale or wrong address is not.
 *
 * A launch that cannot reach the candidate keeps the remembered endpoint, which
 * is why an offline start still routes exactly as the last online one did.
 */
export class CodexUpstreamEndpoint {
  private readonly config: CodexProviderConfig;
  private readonly probe: OpenAiModelsProbe;
  private readonly gateway: GatewayEndpoint | null;
  private readonly recordFilePath: string;
  /** Shared by every caller during one launch, so the probe runs at most once. */
  private resolution: Promise<string | null> | null = null;

  constructor(
    options: {
      config?: CodexProviderConfig;
      probe?: OpenAiModelsProbe;
      gateway?: GatewayEndpoint;
      homeDirectory?: string;
    } = {}
  ) {
    this.config = options.config ?? new CodexProviderConfig(options);
    this.probe = options.probe ?? new OpenAiModelsProbe();
    this.gateway = options.gateway ?? null;
    this.recordFilePath = path.join(
      options.homeDirectory ?? os.homedir(),
      '.amiswifi',
      'codex-upstream-endpoint.json'
    );
  }

  /** The endpoint to register routes with, or null when there is none to use. */
  resolve(): Promise<string | null> {
    this.resolution ??= this.decide();
    return this.resolution;
  }

  /** Compares what is remembered with what Codex is configured with now. */
  private async decide(): Promise<string | null> {
    const remembered = await this.readRecord();
    const candidate = await this.config.read();
    if (candidate === null || this.isGatewayItself(candidate.baseUrl)) {
      // Either Codex names no endpoint, or it names the gateway that is asking
      // — which is what pointing the Codex CLI at Tokkey writes into that file.
      return remembered;
    }

    const normalized = this.normalize(candidate.baseUrl);
    if (remembered === normalized) return remembered;
    if (remembered === null) {
      // Nothing was ever recorded, so this is the user's own configuration
      // rather than a change to it, and it is taken as the starting point.
      await this.writeRecord(normalized);
      return normalized;
    }
    if (await this.probe.servesGptModels(candidate)) {
      await this.writeRecord(normalized);
      return normalized;
    }
    console.error(
      `[CodexModels] Keeping ${remembered}: ${normalized} lists no GPT models to serve.`
    );
    return remembered;
  }

  /** The remembered endpoint, or null when nothing usable is on disk. */
  private async readRecord(): Promise<string | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.recordFilePath, 'utf8'));
      const { baseUrl } = parsed as Partial<CodexUpstreamEndpointRecord>;
      return typeof baseUrl === 'string' && baseUrl.trim().length > 0 ? baseUrl.trim() : null;
    } catch {
      // Absent or corrupt: the next usable candidate becomes the record.
      return null;
    }
  }

  /** Remembers one endpoint so a later rewrite of `config.toml` cannot lose it. */
  private async writeRecord(baseUrl: string): Promise<void> {
    const record: CodexUpstreamEndpointRecord = { baseUrl };
    try {
      await mkdir(path.dirname(this.recordFilePath), { recursive: true });
      await writeFile(this.recordFilePath, JSON.stringify(record, null, 2), 'utf8');
    } catch (error: unknown) {
      // This launch still routes correctly; only the next one pays for the
      // lost write, by re-deciding from whatever config.toml says then.
      console.error('[CodexModels] Could not record the Codex upstream endpoint:', error);
    }
  }

  /** Drops a trailing slash so two spellings of one endpoint compare equal. */
  private normalize(baseUrl: string): string {
    return baseUrl.trim().replace(/\/+$/, '');
  }

  /**
   * Whether a URL names this app's own gateway.
   *
   * Both the running port and the default one are refused. The running port is
   * the address a rewrite would be carrying right now; the default is the one
   * almost every rewrite carried, and a record seeded from a launch whose
   * gateway had moved to a fallback port would loop just as durably.
   *
   * An unparseable URL is not the gateway: the probe judges those, and guessing
   * here would drop a usable endpoint.
   */
  private isGatewayItself(baseUrl: string): boolean {
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      return false;
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
    if (!LOOPBACK_HOSTS.has(hostname)) return false;
    return this.gatewayPorts().has(url.port);
  }

  /** The ports this app's gateway listens on, or would listen on. */
  private gatewayPorts(): Set<string> {
    const ports = new Set([String(GatewayPortResolver.DEFAULT_PORT)]);
    const running = this.gateway?.baseUrl() ?? null;
    if (running === null) return ports;
    try {
      ports.add(new URL(running).port);
    } catch {
      // The supervisor builds this URL itself, so it is only ever well-formed.
    }
    return ports;
  }
}

/** What the record file holds. */
interface CodexUpstreamEndpointRecord {
  baseUrl: string;
}

export default CodexUpstreamEndpoint;
