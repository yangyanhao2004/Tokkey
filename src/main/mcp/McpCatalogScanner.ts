import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from '@iarna/toml';
import { McpConfigurationCodec } from '../../shared/McpConfiguration';
import type {
  InstalledMcp,
  McpAgent,
  McpAgentConfigurationReadout,
  McpAgentBadge,
  McpCatalogFailure,
  McpCatalogScan,
  McpConnectionType,
  McpServerConfiguration
} from '../../shared/types';
import type { InstalledAgentGating } from '../agents/InstalledAgentGate';

/** Stable order used by the catalog cards and their agent badges. */
export const MCP_AGENT_ORDER: readonly McpAgent[] = ['claudeCode', 'codex'];

/** Adapter contract for one agent's user-scope MCP configuration file. */
export interface McpAgentConfigAdapter {
  agent(): McpAgent;
  filePath(homeDirectory: string): string;
  parse(text: string): McpAgentConfigurationReadout;
}

/** File-reader seam used by isolated tests and the local scanner. */
export interface McpFileReader {
  readUtf8OrEmpty(filePath: string): string | Promise<string>;
}

/** Reads UTF-8 configuration while treating a missing user file as empty. */
export class McpConfigFileReader implements McpFileReader {
  readUtf8OrEmpty(filePath: string): string {
    if (!existsSync(filePath)) {
      return '';
    }
    // Fatal decoding keeps malformed files visible as agent failures instead of silently replacing bytes.
    return new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(filePath));
  }
}

/** Shared validation and normalization rules for all MCP adapters. */
class McpAdapterSupport {
  isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  normalizeName(value: string): string {
    const name = value.trim();
    if (name.length === 0 || /[\u0000-\u001f\u007f]/.test(name)) {
      throw new Error('server name must be non-empty and contain no control characters');
    }
    return name;
  }

  normalizeCommand(value: unknown): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error('stdio command must be a non-empty string');
    }
    return value.trim();
  }

  normalizeArguments(value: unknown): string[] {
    if (value === undefined) {
      return [];
    }
    if (!Array.isArray(value) || value.some((argument) => typeof argument !== 'string')) {
      throw new Error('arguments must be an array of strings');
    }
    return value.map((argument) => argument);
  }

  normalizeEnvironment(value: unknown): Record<string, string> {
    if (value === undefined) {
      return {};
    }
    if (!this.isRecord(value)) {
      throw new Error('environment must be a string map');
    }
    const environment: Record<string, string> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (!/^[A-Za-z0-9_]+$/.test(key) || typeof entry !== 'string') {
        throw new Error(`invalid environment entry: ${key}`);
      }
      environment[key] = entry;
    }
    return environment;
  }

  normalizeUrl(value: unknown): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error('remote URL must be a non-empty string');
    }
    const url = value.trim();
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('remote URL is invalid');
    }
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.hostname.length === 0) {
      throw new Error('remote URL must use HTTP or HTTPS and include a host');
    }
    return url;
  }

  makeStdio(command: unknown, args: unknown, env: unknown): McpServerConfiguration {
    return {
      name: '',
      connectionType: 'stdio',
      command: this.normalizeCommand(command),
      arguments: this.normalizeArguments(args),
      environment: this.normalizeEnvironment(env),
      url: null
    };
  }

  makeRemote(connectionType: McpConnectionType, url: unknown): McpServerConfiguration {
    if (connectionType === 'stdio') {
      throw new Error('stdio cannot be remote');
    }
    return {
      name: '',
      connectionType,
      command: null,
      arguments: [],
      environment: {},
      url: this.normalizeUrl(url)
    };
  }
}

/** Parses Claude Code's top-level ~/.claude.json MCP object. */
export class ClaudeCodeMcpAdapter implements McpAgentConfigAdapter {
  private readonly support = new McpAdapterSupport();

  agent(): McpAgent {
    return 'claudeCode';
  }

  filePath(homeDirectory: string): string {
    return path.join(homeDirectory, '.claude.json');
  }

  parse(text: string): McpAgentConfigurationReadout {
    if (text.trim().length === 0) {
      return { servers: [], skipped: [] };
    }
    const root = JSON.parse(text) as unknown;
    if (!this.support.isRecord(root)) {
      throw new Error('Claude configuration must be an object');
    }
    if (root.mcpServers === undefined) {
      return { servers: [], skipped: [] };
    }
    if (!this.support.isRecord(root.mcpServers)) {
      throw new Error('top-level mcpServers must be an object');
    }
    const servers: McpServerConfiguration[] = [];
    const skipped = [];
    for (const name of Object.keys(root.mcpServers).sort()) {
      try {
        const entry = root.mcpServers[name];
        if (!this.support.isRecord(entry)) {
          throw new Error('entry must be an object');
        }
        const configuration = this.parseEntry(entry);
        servers.push({ ...configuration, name: this.support.normalizeName(name) });
      } catch (error) {
        skipped.push({ name, reason: this.describeError(error) });
      }
    }
    return { servers, skipped };
  }

  private parseEntry(entry: Record<string, unknown>): McpServerConfiguration {
    const type = entry.type;
    const hasCommand = entry.command !== undefined;
    const hasUrl = entry.url !== undefined;
    const connectionType = type === undefined
      ? hasCommand ? 'stdio' : hasUrl ? 'streamable_http' : null
      : type === 'http' ? 'streamable_http' : type;
    if (connectionType !== 'stdio' && connectionType !== 'sse' && connectionType !== 'streamable_http') {
      throw new Error('unsupported transport');
    }
    const allowedFields = connectionType === 'stdio'
      ? ['type', 'command', 'args', 'env']
      : ['type', 'url'];
    this.assertAllowedFields(entry, allowedFields);
    if (connectionType === 'stdio') {
      if (hasUrl) throw new Error('stdio entry cannot include url');
      return this.support.makeStdio(entry.command, entry.args, entry.env);
    }
    if (hasCommand) throw new Error('remote entry cannot include command');
    return this.support.makeRemote(connectionType, entry.url);
  }

  private assertAllowedFields(entry: Record<string, unknown>, allowedFields: string[]): void {
    const unsupported = Object.keys(entry).find((key) => !allowedFields.includes(key));
    if (unsupported) throw new Error(`unsupported field: ${unsupported}`);
  }

  private describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Parses Codex's [mcp_servers.<name>] TOML tables. */
export class CodexMcpAdapter implements McpAgentConfigAdapter {
  /**
   * Codex options that tune how a server runs rather than what it is. They are
   * read past instead of skipping the server, so a real Codex configuration
   * still lists; nothing is lost by ignoring them, because the applier only
   * ever appends new tables and never rewrites an existing one.
   */
  private static readonly RUNTIME_ONLY_FIELDS = ['enabled', 'cwd', 'startup_timeout_sec', 'tool_timeout_sec'];

  private readonly support = new McpAdapterSupport();

  agent(): McpAgent {
    return 'codex';
  }

  filePath(homeDirectory: string): string {
    return path.join(homeDirectory, '.codex', 'config.toml');
  }

  parse(text: string): McpAgentConfigurationReadout {
    if (text.trim().length === 0) {
      return { servers: [], skipped: [] };
    }
    const root = parseToml(text) as unknown as Record<string, unknown>;
    if (!this.support.isRecord(root)) {
      throw new Error('Codex configuration must be a table');
    }
    if (root.mcp_servers === undefined) {
      return { servers: [], skipped: [] };
    }
    if (!this.support.isRecord(root.mcp_servers)) {
      throw new Error('top-level mcp_servers must be a table');
    }
    const servers: McpServerConfiguration[] = [];
    const skipped = [];
    for (const name of Object.keys(root.mcp_servers).sort()) {
      try {
        const rawEntry = root.mcp_servers[name];
        if (!this.support.isRecord(rawEntry)) throw new Error('entry must be a table');
        // Codex itself ignores a disabled server, so it is not installed here either.
        if (rawEntry.enabled === false) continue;
        const { env: environment, ...entry } = rawEntry;
        const configuration = this.parseEntry(entry, environment);
        servers.push({ ...configuration, name: this.support.normalizeName(name) });
      } catch (error) {
        skipped.push({ name, reason: this.describeError(error) });
      }
    }
    return { servers, skipped };
  }

  private parseEntry(entry: Record<string, unknown>, environment: unknown): McpServerConfiguration {
    const supportedFields = ['command', 'args', 'url', ...CodexMcpAdapter.RUNTIME_ONLY_FIELDS];
    const unsupported = Object.keys(entry).find((key) => !supportedFields.includes(key));
    if (unsupported) throw new Error(`unsupported field: ${unsupported}`);
    if (entry.command !== undefined && entry.url !== undefined) {
      throw new Error('server cannot include both command and url');
    }
    if (entry.command !== undefined) {
      return this.support.makeStdio(entry.command, entry.args, environment);
    }
    if (entry.args !== undefined || environment !== undefined) {
      throw new Error('stdio fields require command');
    }
    return this.support.makeRemote('streamable_http', entry.url);
  }

  private describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

export interface DiscoveredMcp {
  agent: McpAgent;
  configuration: McpServerConfiguration;
}

/** Produces canonical JSON fingerprints and merges equivalent definitions. */
export class McpCatalogDeduplicator {
  private readonly codec: McpConfigurationCodec;

  constructor(codec: McpConfigurationCodec = new McpConfigurationCodec()) {
    this.codec = codec;
  }

  deduplicate(discovered: DiscoveredMcp[]): InstalledMcp[] {
    const groups = new Map<string, DiscoveredMcp[]>();
    for (const item of discovered) {
      const key = item.configuration.name;
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }

    const cards: InstalledMcp[] = [];
    for (const [name, entries] of groups) {
      const clusters = new Map<string, DiscoveredMcp[]>();
      for (const entry of entries) {
        let fingerprint: string;
        try {
          fingerprint = createHash('sha256').update(this.codec.encode(entry.configuration)).digest('hex');
        } catch {
          continue;
        }
        clusters.set(fingerprint, [...(clusters.get(fingerprint) ?? []), entry]);
      }
      const hasNameCollision = clusters.size > 1;
      for (const [fingerprint, cluster] of clusters) {
        const configuration = cluster[0].configuration;
        const id = hasNameCollision ? `${name}#${fingerprint.slice(0, 12)}` : name;
        const agents = MCP_AGENT_ORDER.filter((agent) => cluster.some((entry) => entry.agent === agent));
        cards.push(this.toInstalledMcp(configuration, id, hasNameCollision, agents));
      }
    }
    return cards.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  }

  private toInstalledMcp(
    configuration: McpServerConfiguration,
    id: string,
    hasNameCollision: boolean,
    agents: McpAgent[]
  ): InstalledMcp {
    const primaryAgent = agents[0] ?? 'claudeCode';
    const shortNames: Record<McpAgent, string> = {
      claudeCode: 'Claude',
      codex: 'Codex'
    };
    const shortName = shortNames[primaryAgent];
    const title = hasNameCollision ? `${configuration.name} (${shortName})` : configuration.name;
    const badges: McpAgentBadge[] = MCP_AGENT_ORDER.map((agent) => ({
      agent,
      state: agents.includes(agent)
        ? 'checked'
        : configuration.connectionType === 'sse' && agent === 'codex' ? 'disabled' : 'unchecked'
    }));
    return {
      id,
      name: configuration.name,
      title,
      connectionType: configuration.connectionType,
      command: configuration.command,
      arguments: [...configuration.arguments],
      environment: { ...configuration.environment },
      url: configuration.url,
      agents,
      badges,
      hasNameCollision,
      definition: this.codec.encode(configuration)
    };
  }
}

/** Scans all supported user-scope MCP files without making network or CLI calls. */
export class LocalMcpCatalogScanner {
  private readonly homeDirectory: string;
  private readonly fileReader: McpFileReader;
  private readonly adapters: McpAgentConfigAdapter[];
  private readonly deduplicator: McpCatalogDeduplicator;
  private readonly agentGate: InstalledAgentGating | null;

  constructor(options: {
    homeDirectory?: string;
    fileReader?: McpFileReader;
    adapters?: McpAgentConfigAdapter[];
    deduplicator?: McpCatalogDeduplicator;
    /** Omitted to read every agent's file, which is what an isolated scan wants. */
    agentGate?: InstalledAgentGating;
  } = {}) {
    this.homeDirectory = options.homeDirectory ?? os.homedir();
    this.fileReader = options.fileReader ?? new McpConfigFileReader();
    this.adapters = options.adapters ?? [
      new ClaudeCodeMcpAdapter(),
      new CodexMcpAdapter()
    ];
    this.deduplicator = options.deduplicator ?? new McpCatalogDeduplicator();
    this.agentGate = options.agentGate ?? null;
  }

  async scanInstalledMcps(): Promise<McpCatalogScan> {
    const discovered: DiscoveredMcp[] = [];
    const failures: McpCatalogFailure[] = [];
    const installedAgents = await this.readInstalledAgents();
    for (const adapter of this.adapters) {
      const agent = adapter.agent();
      // An uninstalled CLI leaves its configuration file behind; reading it
      // would list servers nothing on this machine can start.
      if (!installedAgents.includes(agent)) continue;
      try {
        const text = await this.fileReader.readUtf8OrEmpty(adapter.filePath(this.homeDirectory));
        if (text.trim().length === 0) continue;
        const readout = adapter.parse(text);
        for (const skipped of readout.skipped) {
          console.warn(`Skipped ${agent} MCP ${skipped.name}: ${skipped.reason}`);
        }
        discovered.push(...readout.servers.map((configuration) => ({ agent, configuration })));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Unable to read ${agent} MCP configuration: ${message}`);
        failures.push({ agent, message });
      }
    }
    return { servers: this.deduplicator.deduplicate(discovered), failures };
  }

  /** Preserves the acronym spelling used by the product specification. */
  scanInstalledMCPs(): Promise<McpCatalogScan> {
    return this.scanInstalledMcps();
  }

  /**
   * Which agents this machine has, or all of them when nothing can say.
   *
   * A failed detection must not blank the catalog: an unreadable probe is not
   * evidence that an agent is gone, and hiding configured servers is the more
   * destructive of the two mistakes.
   */
  private async readInstalledAgents(): Promise<readonly McpAgent[]> {
    if (!this.agentGate) {
      return MCP_AGENT_ORDER;
    }
    try {
      return await this.agentGate.installedAgents();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`MCP scan could not detect installed agents, reading every file: ${message}`);
      return MCP_AGENT_ORDER;
    }
  }
}

export { ClaudeCodeMcpAdapter as ClaudeCodeMCPAdapter };
export { CodexMcpAdapter as CodexMCPAdapter };
export { LocalMcpCatalogScanner as LocalMCPCatalogScanner };
export { McpConfigurationCodec as CanonicalMcpCodec };
export default LocalMcpCatalogScanner;
