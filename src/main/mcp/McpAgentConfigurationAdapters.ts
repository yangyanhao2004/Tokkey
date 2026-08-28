import path from 'node:path';
import { parse as parseToml } from '@iarna/toml';
import type { McpAgent, McpServerConfiguration } from '../../shared/types';

/** Renders one canonical server into an agent's existing user configuration. */
export interface McpAgentConfigurationAdapter {
  agent(): McpAgent;
  filePath(homeDirectory: string): string;
  render(existingText: string, configuration: McpServerConfiguration): string;
  /**
   * Drops one server from the agent's configuration. A name the file does not
   * carry returns the text unchanged, so removing twice is not an error.
   */
  remove(existingText: string, serverName: string): string;
}

/** Shared structural checks for configuration renderers. */
class McpRenderingSupport {
  isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  assertAvailable(servers: Record<string, unknown>, name: string, agentLabel: string): void {
    if (Object.prototype.hasOwnProperty.call(servers, name)) {
      throw new Error(`${agentLabel} already has an MCP server named "${name}".`);
    }
  }

  stdioEntry(configuration: McpServerConfiguration, includeType: boolean): Record<string, unknown> {
    if (configuration.command === null) {
      throw new Error('Stdio configuration is missing its command.');
    }
    return {
      ...(includeType ? { type: 'stdio' } : {}),
      command: configuration.command,
      ...(configuration.arguments.length > 0 ? { args: [...configuration.arguments] } : {}),
      ...(Object.keys(configuration.environment).length > 0
        ? { env: { ...configuration.environment } }
        : {})
    };
  }

  remoteEntry(configuration: McpServerConfiguration, type: string | null): Record<string, unknown> {
    if (configuration.url === null) {
      throw new Error('Remote configuration is missing its URL.');
    }
    return {
      ...(type ? { type } : {}),
      url: configuration.url
    };
  }
}

/** Adds one MCP entry to Claude Code's top-level JSON mapping. */
export class ClaudeCodeMcpConfigurationAdapter implements McpAgentConfigurationAdapter {
  private readonly support = new McpRenderingSupport();
  // Claude owns these built-in MCP names and rejects user-scoped replacements.
  private readonly reservedNames = new Set([
    'workspace',
    'claude-in-chrome',
    'computer-use',
    'Claude Preview',
    'Claude Browser'
  ]);

  agent(): McpAgent {
    return 'claudeCode';
  }

  filePath(homeDirectory: string): string {
    return path.join(homeDirectory, '.claude.json');
  }

  render(existingText: string, configuration: McpServerConfiguration): string {
    const root = existingText.trim().length === 0
      ? {}
      : JSON.parse(existingText) as unknown;
    if (!this.support.isRecord(root)) {
      throw new Error('Claude configuration must be a JSON object.');
    }
    if (this.reservedNames.has(configuration.name)) {
      throw new Error(`Claude Code reserves the MCP server name "${configuration.name}".`);
    }
    const rawServers = root.mcpServers;
    if (rawServers !== undefined && !this.support.isRecord(rawServers)) {
      throw new Error('Claude mcpServers must be a JSON object.');
    }
    const servers = rawServers ?? {};
    this.support.assertAvailable(servers, configuration.name, 'Claude Code');
    const entry = configuration.connectionType === 'stdio'
      ? this.support.stdioEntry(configuration, true)
      : this.support.remoteEntry(
        configuration,
        configuration.connectionType === 'streamable_http' ? 'http' : 'sse'
      );
    const updatedRoot = {
      ...root,
      mcpServers: {
        ...servers,
        [configuration.name]: entry
      }
    };
    return `${JSON.stringify(updatedRoot, null, 2)}\n`;
  }

  remove(existingText: string, serverName: string): string {
    if (existingText.trim().length === 0) {
      return existingText;
    }
    const root = JSON.parse(existingText) as unknown;
    if (!this.support.isRecord(root)) {
      throw new Error('Claude configuration must be a JSON object.');
    }
    const servers = root.mcpServers;
    if (servers === undefined) {
      return existingText;
    }
    if (!this.support.isRecord(servers)) {
      throw new Error('Claude mcpServers must be a JSON object.');
    }
    if (!Object.prototype.hasOwnProperty.call(servers, serverName)) {
      return existingText;
    }
    const { [serverName]: _removed, ...remainingServers } = servers;
    return `${JSON.stringify({ ...root, mcpServers: remainingServers }, null, 2)}\n`;
  }
}

/**
 * Deletes one `[mcp_servers.<name>]` table, and any subtable of it, from Codex
 * TOML text.
 *
 * The whole file is never re-serialized: Codex's config.toml is hand-written
 * and holds settings and comments Tokiie knows nothing about, so lines are
 * dropped rather than the document being rebuilt. A table runs from its header
 * to the next header, which is what makes that safe to do line by line.
 */
class CodexTomlTableRemover {
  remove(existingText: string, serverName: string): string {
    let isDroppingTable = false;
    const keptLines = existingText.split('\n').filter((line) => {
      const headerPath = this.readHeaderPath(line);
      if (headerPath) {
        isDroppingTable = this.belongsToServer(headerPath, serverName);
      }
      return !isDroppingTable;
    });
    // Dropping the last table leaves the blank lines that separated it behind.
    const remainingText = keptLines.join('\n').replace(/\s+$/, '');
    return remainingText.length === 0 ? '' : `${remainingText}\n`;
  }

  /** Whether a header names the server's own table or one nested under it. */
  private belongsToServer(headerPath: readonly string[], serverName: string): boolean {
    return headerPath.length >= 2 && headerPath[0] === 'mcp_servers' && headerPath[1] === serverName;
  }

  /** The dotted key a `[table]` or `[[table]]` line opens, or null for any other line. */
  private readHeaderPath(line: string): string[] | null {
    const trimmed = line.trim();
    if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
      return null;
    }
    const inner = trimmed.startsWith('[[') && trimmed.endsWith(']]')
      ? trimmed.slice(2, -2)
      : trimmed.slice(1, -1);
    return this.splitKeyPath(inner);
  }

  /** Splits a dotted key into segments, so a quoted name may hold dots itself. */
  private splitKeyPath(inner: string): string[] | null {
    let segments: string[] = [];
    let current = '';
    let openQuote: '"' | '\'' | null = null;
    for (let index = 0; index < inner.length; index += 1) {
      const character = inner[index];
      if (openQuote === null && (character === '"' || character === '\'')) {
        openQuote = character;
      } else if (openQuote !== null && character === openQuote) {
        openQuote = null;
      } else if (openQuote === '"' && character === '\\') {
        // Only the following character is consumed; escapes stay as written,
        // which is enough to compare a name against the scanner's reading.
        current += inner[index + 1] ?? '';
        index += 1;
      } else if (openQuote === null && character === '.') {
        segments = [...segments, current.trim()];
        current = '';
      } else {
        current += character;
      }
    }
    if (openQuote !== null) {
      return null;
    }
    segments = [...segments, current.trim()];
    return segments.every((segment) => segment.length > 0) ? segments : null;
  }
}

/** Appends one official mcp_servers table without rewriting unrelated Codex TOML. */
export class CodexMcpConfigurationAdapter implements McpAgentConfigurationAdapter {
  private readonly support = new McpRenderingSupport();
  private readonly remover = new CodexTomlTableRemover();

  agent(): McpAgent {
    return 'codex';
  }

  filePath(homeDirectory: string): string {
    return path.join(homeDirectory, '.codex', 'config.toml');
  }

  render(existingText: string, configuration: McpServerConfiguration): string {
    if (configuration.connectionType === 'sse') {
      throw new Error('Codex does not support SSE MCP servers.');
    }
    const root = existingText.trim().length === 0
      ? {}
      : parseToml(existingText) as unknown;
    if (!this.support.isRecord(root)) {
      throw new Error('Codex configuration must be a TOML table.');
    }
    const rawServers = root.mcp_servers;
    if (rawServers !== undefined && !this.support.isRecord(rawServers)) {
      throw new Error('Codex mcp_servers must be a TOML table.');
    }
    this.support.assertAvailable(rawServers ?? {}, configuration.name, 'Codex');
    const renderedTable = configuration.connectionType === 'stdio'
      ? this.renderStdioTable(configuration)
      : this.renderRemoteTable(configuration);
    const separator = existingText.length === 0
      ? ''
      : existingText.endsWith('\n\n') ? '' : existingText.endsWith('\n') ? '\n' : '\n\n';
    return `${existingText}${separator}${renderedTable}`;
  }

  remove(existingText: string, serverName: string): string {
    return this.remover.remove(existingText, serverName);
  }

  private renderStdioTable(configuration: McpServerConfiguration): string {
    if (configuration.command === null) {
      throw new Error('Stdio configuration is missing its command.');
    }
    const tableName = this.tableName(configuration.name);
    const argumentsList = configuration.arguments.map((argument) => JSON.stringify(argument)).join(', ');
    const tableLines = [
      `[${tableName}]`,
      `command = ${JSON.stringify(configuration.command)}`,
      ...(configuration.arguments.length > 0 ? [`args = [${argumentsList}]`] : [])
    ];
    const environmentEntries = Object.entries(configuration.environment).sort(([left], [right]) => left.localeCompare(right));
    if (environmentEntries.length > 0) {
      tableLines.push(
        '',
        `[${tableName}.env]`,
        ...environmentEntries.map(([name, value]) => `${name} = ${JSON.stringify(value)}`)
      );
    }
    return `${tableLines.join('\n')}\n`;
  }

  private renderRemoteTable(configuration: McpServerConfiguration): string {
    if (configuration.url === null) {
      throw new Error('Remote configuration is missing its URL.');
    }
    return `[${this.tableName(configuration.name)}]\nurl = ${JSON.stringify(configuration.url)}\n`;
  }

  private tableName(serverName: string): string {
    return `mcp_servers.${JSON.stringify(serverName)}`;
  }
}

/** Supplies the stable adapter order used for staging and committing changes. */
export class McpAgentConfigurationAdapterRegistry {
  readonly adapters: readonly McpAgentConfigurationAdapter[];

  constructor(adapters: readonly McpAgentConfigurationAdapter[] = [
    new ClaudeCodeMcpConfigurationAdapter(),
    new CodexMcpConfigurationAdapter()
  ]) {
    this.adapters = [...adapters];
  }

  selected(selectedAgents: readonly McpAgent[]): McpAgentConfigurationAdapter[] {
    return this.adapters.filter((adapter) => selectedAgents.includes(adapter.agent()));
  }
}
