import os from 'node:os';
import {
  McpAgentCompatibility,
  McpConfigurationCodec
} from '../../shared/McpConfiguration';
import type { McpAgent, McpServerConfiguration } from '../../shared/types';
import {
  McpAgentConfigurationAdapterRegistry,
  type McpAgentConfigurationAdapter
} from './McpAgentConfigurationAdapters';
import {
  McpConfigurationFileWriter,
  type McpConfigurationFileChange,
  type McpConfigurationFileRead
} from './McpConfigurationFileWriter';

/** Reusable contract for persisting one canonical MCP document to selected agents. */
export interface McpConfigurationApplying {
  apply(configurationJson: string, selectedAgents: readonly McpAgent[]): Promise<void>;
}

/** Stages every selected agent file, then commits the changes transactionally. */
export class LocalMcpConfigurationApplier implements McpConfigurationApplying {
  private readonly homeDirectory: string;
  private readonly registry: McpAgentConfigurationAdapterRegistry;
  private readonly writer: McpConfigurationFileWriter;
  private readonly codec: McpConfigurationCodec;
  private readonly compatibility: McpAgentCompatibility;

  constructor(options: {
    homeDirectory?: string;
    registry?: McpAgentConfigurationAdapterRegistry;
    writer?: McpConfigurationFileWriter;
    codec?: McpConfigurationCodec;
    compatibility?: McpAgentCompatibility;
  } = {}) {
    this.homeDirectory = options.homeDirectory ?? os.homedir();
    this.registry = options.registry ?? new McpAgentConfigurationAdapterRegistry();
    this.writer = options.writer ?? new McpConfigurationFileWriter();
    this.codec = options.codec ?? new McpConfigurationCodec();
    this.compatibility = options.compatibility ?? new McpAgentCompatibility();
  }

  async apply(configurationJson: string, selectedAgents: readonly McpAgent[]): Promise<void> {
    const uniqueAgents = [...new Set(selectedAgents)];
    if (uniqueAgents.length === 0) {
      throw new Error('Select at least one agent.');
    }
    const selectedAdapters = this.registry.selected(uniqueAgents);
    if (selectedAdapters.length !== uniqueAgents.length) {
      const supportedAgents = new Set(this.registry.adapters.map((adapter) => adapter.agent()));
      const unsupportedAgent = uniqueAgents.find((agent) => !supportedAgents.has(agent));
      throw new Error(`Unsupported MCP agent: ${String(unsupportedAgent)}.`);
    }

    const configuration = this.codec.decode(configurationJson);
    uniqueAgents.forEach((agent) => this.compatibility.requireSupported(agent, configuration.connectionType));

    // All reads and renders finish before commit so adapter failures cannot cause partial writes.
    const fileReads = await Promise.all(selectedAdapters.map((adapter) =>
      this.writer.read(adapter.filePath(this.homeDirectory))
    ));
    const changes = selectedAdapters
      .map((adapter, index) => this.stageChange(adapter, fileReads[index], configuration))
      .filter((change): change is McpConfigurationFileChange => change !== null);
    await this.writer.commit(changes);
  }

  private stageChange(
    adapter: McpAgentConfigurationAdapter,
    fileRead: McpConfigurationFileRead,
    configuration: McpServerConfiguration
  ): McpConfigurationFileChange | null {
    let replacementText: string;
    try {
      replacementText = adapter.render(fileRead.text, configuration);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to prepare ${adapter.agent()} configuration at ${fileRead.filePath}: ${detail}`);
    }
    const replacementBytes = new TextEncoder().encode(replacementText);
    if (fileRead.originalBytes !== null && this.bytesEqual(fileRead.originalBytes, replacementBytes)) {
      return null;
    }
    return { ...fileRead, replacementBytes };
  }

  private bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }
}

export default LocalMcpConfigurationApplier;
