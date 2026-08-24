import type {
  McpAgent,
  McpConfigurationDraft,
  McpConfigurationPreparation,
  McpConnectionType,
  McpServerConfiguration
} from './types';

/** Shared runtime checks used by the canonical codec and editor parsers. */
class McpConfigurationSupport {
  isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  normalizeName(value: unknown): string {
    if (typeof value !== 'string') {
      throw new Error('Server name must be a string.');
    }
    const name = value.trim();
    if (name.length === 0) {
      throw new Error('Server name is required.');
    }
    if (/[\u0000-\u001f\u007f]/.test(name)) {
      throw new Error('Server name cannot contain control characters or line breaks.');
    }
    return name;
  }

  normalizeCommand(value: unknown): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error('Stdio command is required.');
    }
    return value.trim();
  }

  normalizeArguments(value: unknown): string[] {
    if (value === undefined) {
      return [];
    }
    if (!Array.isArray(value) || value.some((argument) => typeof argument !== 'string')) {
      throw new Error('Stdio args must be an array of strings.');
    }
    return value.map((argument) => argument);
  }

  normalizeEnvironment(value: unknown): Record<string, string> {
    if (value === undefined) {
      return {};
    }
    if (!this.isRecord(value)) {
      throw new Error('Stdio env must be an object of string values.');
    }
    return Object.entries(value).reduce<Record<string, string>>((environment, [name, entry]) => {
      if (!/^[A-Za-z0-9_]+$/.test(name) || typeof entry !== 'string') {
        throw new Error(`Invalid environment entry: ${name}.`);
      }
      return { ...environment, [name]: entry };
    }, {});
  }

  normalizeUrl(value: unknown): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error('Remote URL is required.');
    }
    const url = value.trim();
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new Error('Remote URL must be a valid HTTP or HTTPS URL.');
    }
    if ((parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') || parsedUrl.hostname.length === 0) {
      throw new Error('Remote URL must use HTTP or HTTPS and include a host.');
    }
    return url;
  }

  assertAllowedFields(entry: Record<string, unknown>, allowedFields: readonly string[]): void {
    const unsupportedField = Object.keys(entry).find((field) => !allowedFields.includes(field));
    if (unsupportedField) {
      throw new Error(`Unsupported server field: ${unsupportedField}.`);
    }
  }
}

/** Parses a command line into argv without invoking or emulating a shell. */
export class McpCommandLineParser {
  parse(commandLine: string): string[] {
    const tokens: string[] = [];
    let currentToken = '';
    let activeQuote: "'" | '"' | null = null;
    let isEscaping = false;
    let tokenStarted = false;

    for (const character of commandLine) {
      if (isEscaping) {
        currentToken += character;
        isEscaping = false;
        tokenStarted = true;
        continue;
      }
      if (activeQuote === "'") {
        if (character === "'") {
          activeQuote = null;
        } else {
          currentToken += character;
        }
        tokenStarted = true;
        continue;
      }
      if (activeQuote === '"') {
        if (character === '"') {
          activeQuote = null;
        } else if (character === '\\') {
          isEscaping = true;
        } else {
          currentToken += character;
        }
        tokenStarted = true;
        continue;
      }
      if (character === "'" || character === '"') {
        activeQuote = character;
        tokenStarted = true;
        continue;
      }
      if (character === '\\') {
        isEscaping = true;
        tokenStarted = true;
        continue;
      }
      if (/\s/.test(character)) {
        if (tokenStarted) {
          tokens.push(currentToken);
          currentToken = '';
          tokenStarted = false;
        }
        continue;
      }
      currentToken += character;
      tokenStarted = true;
    }

    if (isEscaping) {
      throw new Error('Command cannot end with an unfinished escape.');
    }
    if (activeQuote) {
      throw new Error('Command contains an unterminated quote.');
    }
    if (tokenStarted) {
      tokens.push(currentToken);
    }
    if (tokens.length === 0 || tokens[0].trim().length === 0) {
      throw new Error('Stdio command is required.');
    }
    return tokens;
  }
}

/** Parses the wizard's comma-separated KEY=VALUE environment format. */
export class McpEnvironmentParser {
  parse(environmentText: string): Record<string, string> {
    if (environmentText.trim().length === 0) {
      return {};
    }
    return environmentText.split(',').reduce<Record<string, string>>((environment, rawEntry) => {
      const entry = rawEntry.trim();
      const separatorIndex = entry.indexOf('=');
      if (separatorIndex < 1) {
        throw new Error(`Environment entry must use KEY=VALUE: ${entry || '(empty)'}.`);
      }
      const name = entry.slice(0, separatorIndex).trim();
      const value = entry.slice(separatorIndex + 1);
      if (!/^[A-Za-z0-9_]+$/.test(name)) {
        throw new Error(`Invalid environment variable name: ${name}.`);
      }
      return { ...environment, [name]: value };
    }, {});
  }
}

/** Encodes and decodes the strict one-server MCP JSON envelope. */
export class McpConfigurationCodec {
  private readonly support = new McpConfigurationSupport();

  decode(configurationJson: string): McpServerConfiguration {
    let root: unknown;
    try {
      root = JSON.parse(configurationJson) as unknown;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Full JSON is malformed: ${detail}`);
    }
    if (!this.support.isRecord(root)) {
      throw new Error('Full JSON root must be an object.');
    }
    const rootFields = Object.keys(root);
    if (rootFields.length !== 1 || rootFields[0] !== 'mcpServers') {
      throw new Error('Full JSON root must contain only mcpServers.');
    }
    if (!this.support.isRecord(root.mcpServers)) {
      throw new Error('mcpServers must be an object.');
    }
    const serverNames = Object.keys(root.mcpServers);
    if (serverNames.length !== 1) {
      throw new Error('mcpServers must contain exactly one server.');
    }
    const name = this.support.normalizeName(serverNames[0]);
    const rawServer = root.mcpServers[serverNames[0]];
    if (!this.support.isRecord(rawServer)) {
      throw new Error(`mcpServers.${serverNames[0]} must be an object.`);
    }
    return this.decodeServer(name, rawServer);
  }

  encode(configuration: McpServerConfiguration): string {
    const normalized = this.normalize(configuration);
    return JSON.stringify(this.sortValue({
      mcpServers: {
        [normalized.name]: this.encodeServer(normalized)
      }
    }), null, 2);
  }

  normalize(configuration: McpServerConfiguration): McpServerConfiguration {
    const name = this.support.normalizeName(configuration.name);
    if (configuration.connectionType === 'stdio') {
      if (configuration.url !== null) {
        throw new Error('Stdio configuration cannot include a URL.');
      }
      return {
        name,
        connectionType: 'stdio',
        command: this.support.normalizeCommand(configuration.command),
        arguments: this.support.normalizeArguments(configuration.arguments),
        environment: this.support.normalizeEnvironment(configuration.environment),
        url: null
      };
    }
    if (configuration.connectionType !== 'streamable_http' && configuration.connectionType !== 'sse') {
      throw new Error('Server type must be stdio, streamable_http, or sse.');
    }
    if (configuration.command !== null || configuration.arguments.length > 0 || Object.keys(configuration.environment).length > 0) {
      throw new Error('Remote configuration cannot include stdio fields.');
    }
    return {
      name,
      connectionType: configuration.connectionType,
      command: null,
      arguments: [],
      environment: {},
      url: this.support.normalizeUrl(configuration.url)
    };
  }

  private decodeServer(name: string, server: Record<string, unknown>): McpServerConfiguration {
    const connectionType = server.type;
    if (connectionType === 'stdio') {
      this.support.assertAllowedFields(server, ['type', 'command', 'args', 'env']);
      return this.normalize({
        name,
        connectionType,
        command: this.support.normalizeCommand(server.command),
        arguments: this.support.normalizeArguments(server.args),
        environment: this.support.normalizeEnvironment(server.env),
        url: null
      });
    }
    if (connectionType === 'streamable_http' || connectionType === 'sse') {
      this.support.assertAllowedFields(server, ['type', 'url']);
      return this.normalize({
        name,
        connectionType,
        command: null,
        arguments: [],
        environment: {},
        url: this.support.normalizeUrl(server.url)
      });
    }
    throw new Error('Server type must be stdio, streamable_http, or sse.');
  }

  private encodeServer(configuration: McpServerConfiguration): Record<string, unknown> {
    if (configuration.connectionType === 'stdio') {
      return {
        command: configuration.command,
        ...(configuration.arguments.length > 0 ? { args: [...configuration.arguments] } : {}),
        ...(Object.keys(configuration.environment).length > 0
          ? { env: { ...configuration.environment } }
          : {}),
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
    if (!this.support.isRecord(value)) {
      return value;
    }
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, this.sortValue(entry)])
    );
  }
}

/** Converts either editor mode to the same canonical configuration document. */
export class McpConfigurationPreparer {
  private readonly codec: McpConfigurationCodec;
  private readonly commandLineParser: McpCommandLineParser;
  private readonly environmentParser: McpEnvironmentParser;

  constructor(options: {
    codec?: McpConfigurationCodec;
    commandLineParser?: McpCommandLineParser;
    environmentParser?: McpEnvironmentParser;
  } = {}) {
    this.codec = options.codec ?? new McpConfigurationCodec();
    this.commandLineParser = options.commandLineParser ?? new McpCommandLineParser();
    this.environmentParser = options.environmentParser ?? new McpEnvironmentParser();
  }

  prepare(draft: McpConfigurationDraft): McpConfigurationPreparation {
    try {
      const configuration = draft.mode === 'wizard'
        ? this.prepareWizard(
          draft.name,
          draft.connectionType,
          draft.commandLine,
          draft.environmentText,
          draft.url
        )
        : this.codec.decode(draft.jsonText);
      return {
        isValid: true,
        canonicalJson: this.codec.encode(configuration),
        configuration,
        error: null
      };
    } catch (error) {
      return {
        isValid: false,
        canonicalJson: null,
        configuration: null,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private prepareWizard(
    name: string,
    connectionType: McpConnectionType,
    commandLine: string,
    environmentText: string,
    url: string
  ): McpServerConfiguration {
    if (connectionType === 'stdio') {
      const commandParts = this.commandLineParser.parse(commandLine);
      return this.codec.normalize({
        name,
        connectionType,
        command: commandParts[0],
        arguments: commandParts.slice(1),
        environment: this.environmentParser.parse(environmentText),
        url: null
      });
    }
    return this.codec.normalize({
      name,
      connectionType,
      command: null,
      arguments: [],
      environment: {},
      url
    });
  }
}

/** Central compatibility policy shared by the UI and main-process applier. */
export class McpAgentCompatibility {
  supports(agent: McpAgent, connectionType: McpConnectionType): boolean {
    return !(agent === 'codex' && connectionType === 'sse');
  }

  requireSupported(agent: McpAgent, connectionType: McpConnectionType): void {
    if (!this.supports(agent, connectionType)) {
      throw new Error('Codex does not support SSE MCP servers.');
    }
  }
}
