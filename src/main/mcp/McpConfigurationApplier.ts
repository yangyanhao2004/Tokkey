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
  /**
   * Moves one already-configured server onto exactly `addAgents` and off
   * `removeAgents` in a single transaction, which is what the Manage dialog
   * saves. Both files change together or neither does.
   */
  applySelection(
    configurationJson: string,
    addAgents: readonly McpAgent[],
    removeAgents: readonly McpAgent[]
  ): Promise<void>;
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
    const addAgents = [...new Set(selectedAgents)];
    if (addAgents.length === 0) {
      throw new Error('Select at least one agent.');
    }
    await this.applySelection(configurationJson, addAgents, []);
  }

  async applySelection(
    configurationJson: string,
    addAgents: readonly McpAgent[],
    removeAgents: readonly McpAgent[]
  ): Promise<void> {
    const uniqueAddAgents = [...new Set(addAgents)];
    // An agent being added to is never also removed from, whatever the caller said.
    const uniqueRemoveAgents = [...new Set(removeAgents)].filter(
      (agent) => !uniqueAddAgents.includes(agent)
    );
    this.requireKnownAgents([...uniqueAddAgents, ...uniqueRemoveAgents]);

    const configuration = this.codec.decode(configurationJson);
    uniqueAddAgents.forEach((agent) =>
      this.compatibility.requireSupported(agent, configuration.connectionType)
    );

    // All reads and renders finish before commit so adapter failures cannot cause partial writes.
    const stagings = [
      ...this.registry.selected(uniqueAddAgents).map((adapter) => ({
        adapter,
        write: (text: string) => adapter.render(text, configuration)
      })),
      ...this.registry.selected(uniqueRemoveAgents).map((adapter) => ({
        adapter,
        write: (text: string) => adapter.remove(text, configuration.name)
      }))
    ];
    const fileReads = await Promise.all(stagings.map((staging) =>
      this.writer.read(staging.adapter.filePath(this.homeDirectory))
    ));
    const changes = stagings
      .map((staging, index) => this.stageChange(staging.adapter, fileReads[index], staging.write))
      .filter((change): change is McpConfigurationFileChange => change !== null);
    await this.writer.commit(changes);
  }

  /** Rejects an agent no adapter owns before any file is read. */
  private requireKnownAgents(agents: readonly McpAgent[]): void {
    const supportedAgents = new Set(this.registry.adapters.map((adapter) => adapter.agent()));
    const unsupportedAgent = agents.find((agent) => !supportedAgents.has(agent));
    if (unsupportedAgent !== undefined) {
      throw new Error(`Unsupported MCP agent: ${String(unsupportedAgent)}.`);
    }
  }

  private stageChange(
    adapter: McpAgentConfigurationAdapter,
    fileRead: McpConfigurationFileRead,
    write: (existingText: string) => string
  ): McpConfigurationFileChange | null {
    let replacementText: string;
    try {
      replacementText = write(fileRead.text);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to prepare ${adapter.agent()} configuration at ${fileRead.filePath}: ${detail}`);
    }
    const replacementBytes = new TextEncoder().encode(replacementText);
    if (fileRead.originalBytes !== null && this.bytesEqual(fileRead.originalBytes, replacementBytes)) {
      return null;
    }
    // Removing from an agent that has no file yet must not create an empty one.
    if (fileRead.originalBytes === null && replacementBytes.length === 0) {
      return null;
    }
    return { ...fileRead, replacementBytes };
  }

  private bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }
}

export default LocalMcpConfigurationApplier;
