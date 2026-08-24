import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from '@iarna/toml';
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
    if (!this.support.isRecord(root) || !this.support.isRecord(root.mcpServers)) {
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
        configuration.name = this.support.normalizeName(name);
        servers.push(configuration);
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
    if (!this.support.isRecord(root) || !this.support.isRecord(root.mcp_servers)) {
      throw new Error('top-level mcp_servers must be a table');
    }
    const servers: McpServerConfiguration[] = [];
    const skipped = [];
    for (const name of Object.keys(root.mcp_servers).sort()) {
      try {
        const rawEntry = root.mcp_servers[name];
        if (!this.support.isRecord(rawEntry)) throw new Error('entry must be a table');
        const entry = { ...rawEntry };
        const environment = entry.env;
        delete entry.env;
        const configuration = this.parseEntry(entry, environment);
        configuration.name = this.support.normalizeName(name);
        servers.push(configuration);
      } catch (error) {
        skipped.push({ name, reason: this.describeError(error) });
      }
    }
    return { servers, skipped };
  }

  private parseEntry(entry: Record<string, unknown>, environment: unknown): McpServerConfiguration {
    const unsupported = Object.keys(entry).find((key) => !['command', 'args', 'url'].includes(key));
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

/** Encodes normalized definitions into the stable one-server MCP JSON envelope. */
export class CanonicalMcpCodec {
  encode(configuration: McpServerConfiguration): string {
    this.validate(configuration);
    return JSON.stringify(this.sortValue({
      mcpServers: {
        [configuration.name]: this.serverValue(configuration)
      }
    }), null, 2);
  }

  fingerprint(configuration: McpServerConfiguration): string {
    return createHash('sha256').update(this.encode(configuration)).digest('hex');
  }

  private validate(configuration: McpServerConfiguration): void {
    if (configuration.name.trim().length === 0 || /[\u0000-\u001f\u007f]/.test(configuration.name)) {
      throw new Error('server name is invalid');
    }
    if (configuration.connectionType === 'stdio') {
      if (typeof configuration.command !== 'string' || configuration.command.trim().length === 0) {
        throw new Error('stdio command is invalid');
      }
      if (configuration.url !== null || configuration.arguments.some((argument) => typeof argument !== 'string')) {
        throw new Error('stdio definition is invalid');
      }
    } else {
      if (configuration.connectionType !== 'sse' && configuration.connectionType !== 'streamable_http') {
        throw new Error('transport is invalid');
      }
      if (typeof configuration.url !== 'string') {
        throw new Error('remote URL is invalid');
      }
      const parsedUrl = new URL(configuration.url);
      if ((parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') || parsedUrl.hostname.length === 0) {
        throw new Error('remote URL is invalid');
      }
      if (configuration.command !== null || configuration.arguments.length > 0 || Object.keys(configuration.environment).length > 0) {
        throw new Error('remote definition is invalid');
      }
    }
    for (const key of Object.keys(configuration.environment)) {
      if (!/^[A-Za-z0-9_]+$/.test(key) || typeof configuration.environment[key] !== 'string') {
        throw new Error(`environment entry is invalid: ${key}`);
      }
    }
  }

  private serverValue(configuration: McpServerConfiguration): Record<string, unknown> {
    if (configuration.connectionType === 'stdio') {
      return {
        args: configuration.arguments,
        command: configuration.command,
        env: configuration.environment,
        type: 'stdio'
      };
    }
    return {
      type: configuration.connectionType,
      url: configuration.url
    };
  }

  private sortValue(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((entry) => this.sortValue(entry));
    }
    if (!value || typeof value !== 'object') {
      return value;
    }
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, entry]) => [key, this.sortValue(entry)])
    );
  }
}

/** Produces canonical JSON fingerprints and merges equivalent definitions. */
export class McpCatalogDeduplicator {
  private readonly codec: CanonicalMcpCodec;

  constructor(codec: CanonicalMcpCodec = new CanonicalMcpCodec()) {
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
          fingerprint = this.codec.fingerprint(entry.configuration);
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
    const shortName = primaryAgent === 'claudeCode' ? 'Claude' : 'Codex';
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

  constructor(options: {
    homeDirectory?: string;
    fileReader?: McpFileReader;
    adapters?: McpAgentConfigAdapter[];
    deduplicator?: McpCatalogDeduplicator;
  } = {}) {
    this.homeDirectory = options.homeDirectory ?? os.homedir();
    this.fileReader = options.fileReader ?? new McpConfigFileReader();
    this.adapters = options.adapters ?? [new ClaudeCodeMcpAdapter(), new CodexMcpAdapter()];
    this.deduplicator = options.deduplicator ?? new McpCatalogDeduplicator();
  }

  async scanInstalledMcps(): Promise<McpCatalogScan> {
    const discovered: DiscoveredMcp[] = [];
    const failures: McpCatalogFailure[] = [];
    for (const adapter of this.adapters) {
      const agent = adapter.agent();
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
}

export { ClaudeCodeMcpAdapter as ClaudeCodeMCPAdapter };
export { CodexMcpAdapter as CodexMCPAdapter };
export { LocalMcpCatalogScanner as LocalMCPCatalogScanner };
export default LocalMcpCatalogScanner;
