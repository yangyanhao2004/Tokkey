import path from 'node:path';
import { parse as parseToml } from '@iarna/toml';
import { Document, parseDocument } from 'yaml';
import type { McpAgent, McpServerConfiguration } from '../../shared/types';

/** Renders one canonical server into an agent's existing user configuration. */
export interface McpAgentConfigurationAdapter {
  agent(): McpAgent;
  filePath(homeDirectory: string): string;
  render(existingText: string, configuration: McpServerConfiguration): string;
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
}

/** Adds one MCP entry while preserving Hermes YAML comments and settings. */
export class HermesMcpConfigurationAdapter implements McpAgentConfigurationAdapter {
  private readonly support = new McpRenderingSupport();

  agent(): McpAgent {
    return 'hermes';
  }

  filePath(homeDirectory: string): string {
    return path.join(homeDirectory, '.hermes', 'config.yaml');
  }

  render(existingText: string, configuration: McpServerConfiguration): string {
    const document = existingText.trim().length === 0
      ? new Document({})
      : parseDocument(existingText);
    if (document.errors.length > 0) {
      throw new Error(`Hermes configuration is invalid YAML: ${document.errors[0].message}`);
    }
    const root = document.toJS() as unknown;
    if (!this.support.isRecord(root)) {
      throw new Error('Hermes configuration must be a YAML object.');
    }
    const rawServers = root.mcp_servers;
    if (rawServers !== undefined && !this.support.isRecord(rawServers)) {
      throw new Error('Hermes mcp_servers must be a YAML object.');
    }
    this.support.assertAvailable(rawServers ?? {}, configuration.name, 'Hermes');
    const entry = configuration.connectionType === 'stdio'
      ? this.support.stdioEntry(configuration, false)
      : {
        ...this.support.remoteEntry(configuration, null),
        ...(configuration.connectionType === 'sse' ? { transport: 'sse' } : {})
      };
    document.setIn(['mcp_servers', configuration.name], entry);
    return document.toString();
  }
}

/** Appends one official mcp_servers table without rewriting unrelated Codex TOML. */
export class CodexMcpConfigurationAdapter implements McpAgentConfigurationAdapter {
  private readonly support = new McpRenderingSupport();

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
    new HermesMcpConfigurationAdapter(),
    new CodexMcpConfigurationAdapter()
  ]) {
    this.adapters = [...adapters];
  }

  selected(selectedAgents: readonly McpAgent[]): McpAgentConfigurationAdapter[] {
    return this.adapters.filter((adapter) => selectedAgents.includes(adapter.agent()));
  }
}
