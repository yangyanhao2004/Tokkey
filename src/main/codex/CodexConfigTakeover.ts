import OwnedConfigFile, { type SlotEditor, type SlotWrite } from '../config/OwnedConfigFile';
import RouterMcpServer from '../router/RouterMcpServer';
import TokkeyHome from '../storage/TokkeyHome';
import CodexHome from './CodexHome';
import CodexTomlDocument from './CodexTomlDocument';

/** The provider table Tokkey owns. Everything else in the file belongs to the user. */
const TOKKEY_PROVIDER_ID = 'tokkey';

/** Root keys the takeover writes, and the restore therefore has to account for. */
const MODEL_PROVIDER_KEY = 'model_provider';
const MODEL_CATALOG_KEY = 'model_catalog_json';

/** The table Tokkey's provider lives in, addressed the way `CodexTomlDocument` wants it. */
const TOKKEY_TABLE_PATH = ['model_providers', TOKKEY_PROVIDER_ID] as const;

/** The table the router's own MCP server is declared in, while there is one. */
const MCP_TABLE_PATH = ['mcp_servers', RouterMcpServer.NAME] as const;

/**
 * Points the Codex CLI at the local gateway for as long as Tokkey is running.
 *
 * Codex reads one file, `~/.codex/config.toml`, and that file is the user's:
 * hand-written, full of comments, and shared with every other tool that
 * configures Codex. Tokkey only ever touches four things in it — the
 * `model_provider` and `model_catalog_json` root keys, the
 * `[model_providers.tokkey]` table, and, while the router is on, the
 * `[mcp_servers.tokkey-router]` table — and gives back exactly those, never the
 * rest of the file, whatever else the user does to it while Tokkey runs. That
 * per-key loan-and-return contract lives in {@link OwnedConfigFile}, which
 * `ClaudeConfigTakeover` shares.
 *
 * Restoring before anything reads the file matters here beyond tidiness:
 * `CodexUpstreamEndpoint` learns the user's real upstream from this same file,
 * and reading it while Tokkey's own address is still in there would teach it
 * that the gateway is its own upstream.
 */
export class CodexConfigTakeover {
  private readonly file: OwnedConfigFile;

  constructor(options: { home?: CodexHome; homeDirectory?: string; ledgerPath?: string } = {}) {
    const home = options.home ?? new CodexHome(options);
    this.file = new OwnedConfigFile({
      filePath: home.configPath,
      ledgerPath:
        options.ledgerPath ??
        new TokkeyHome(options).pathFor('codex-config-ledger.json'),
      label: 'CodexConfig'
    });
  }

  get configPath(): string {
    return this.file.configPath;
  }

  /** Where the ledger of Tokkey's owned keys is kept while the takeover is in force. */
  get ledgerFilePath(): string {
    return this.file.ledgerFilePath;
  }

  /**
   * Undoes a takeover a previous run never got to undo.
   *
   * Called before anything reads `config.toml`, so a crashed session cannot
   * leave Tokkey's own keys to be mistaken for the user's.
   *
   * @returns whether a leftover ledger was found and reverted
   */
  recoverInterruptedSession(): boolean {
    return this.file.recoverInterruptedSession(this.allEditors());
  }

  /**
   * Writes `model_provider`, `[model_providers.tokkey]`, and — when given —
   * `model_catalog_json` and the router's MCP server, recording each one's
   * pre-takeover value the first time it is touched.
   *
   * @param baseUrl the endpoint Codex should call, e.g. `http://127.0.0.1:4033`
   * @param catalogPath the generated catalog to point Codex at, or null to
   *   leave whatever catalog the user had configured in place
   * @param mcpUrl the router's MCP endpoint, or null while nothing serves one
   * @returns whether the file was taken over
   */
  activate(baseUrl: string, catalogPath: string | null, mcpUrl: string | null = null): boolean {
    const taken = this.file.activate(this.writesFor(baseUrl, catalogPath, mcpUrl), this.allEditors());
    if (taken) {
      console.info(`[CodexConfig] Codex now routes through ${this.providerBaseUrl(baseUrl)}.`);
    }
    return taken;
  }

  /**
   * Rewrites the same three slots for an endpoint that changed mid-session.
   *
   * This is what moves Codex between the gateway and the router: only the
   * keys Tokkey owns are touched, so anything the user changed elsewhere in
   * the file — or even in one of Tokkey's own slots — survives untouched. A
   * no-op when no takeover is in force, since there is then nothing to refresh.
   *
   * @param baseUrl the endpoint Codex should call, e.g. a running router's
   * @param catalogPath the generated catalog, or null to leave the user's own
   * @param mcpUrl the router's MCP endpoint, or null to take the entry back out
   * @returns whether the slots were rewritten
   */
  reapply(baseUrl: string, catalogPath: string | null, mcpUrl: string | null = null): boolean {
    const rewritten = this.file.reapply(this.writesFor(baseUrl, catalogPath, mcpUrl), this.allEditors());
    if (rewritten) {
      console.info(`[CodexConfig] Codex now routes through ${this.providerBaseUrl(baseUrl)}.`);
    }
    return rewritten;
  }

  /**
   * Puts every owned slot back to what it held before the takeover — except a
   * slot the user changed while Tokkey was running, which is left as they set
   * it. Synchronous on purpose: this runs from Electron's `will-quit`, which
   * does not wait for a promise.
   *
   * @returns whether a restore was attempted
   */
  restore(): boolean {
    return this.file.restore(this.allEditors());
  }

  /** The slots this takeover writes for a given endpoint, catalog and tool server. */
  private writesFor(baseUrl: string, catalogPath: string | null, mcpUrl: string | null): SlotWrite[] {
    const writes: SlotWrite[] = [
      this.rootKeySlot(MODEL_PROVIDER_KEY, TOKKEY_PROVIDER_ID),
      this.tableSlot(TOKKEY_TABLE_PATH, [
        ['name', 'Tokkey'],
        ['base_url', this.providerBaseUrl(baseUrl)],
        // The gateway speaks the Responses wire, which is what lets a Codex
        // turn reach it unchanged.
        ['wire_api', 'responses'],
        // Codex sends its own login with the request; the gateway decides per
        // request whether that credential or a route's own key is spent.
        ['requires_openai_auth', true]
      ])
    ];
    if (catalogPath !== null) {
      writes.push(this.rootKeySlot(MODEL_CATALOG_KEY, catalogPath));
    }
    if (mcpUrl !== null) {
      // Streamable HTTP, which is all a bare `url` means to Codex — the same
      // shape the Manage MCP dialog writes for a remote server.
      writes.push(this.tableSlot(MCP_TABLE_PATH, [['url', mcpUrl]]));
    }
    return writes;
  }

  /** Every slot this takeover might ever hold, for recovery and restore. */
  private allEditors(): SlotEditor[] {
    return [
      this.rootKeyEditor(MODEL_PROVIDER_KEY),
      this.rootKeyEditor(MODEL_CATALOG_KEY),
      this.tableEditor(TOKKEY_TABLE_PATH),
      this.tableEditor(MCP_TABLE_PATH)
    ];
  }

  private rootKeyEditor(key: string): SlotEditor {
    return {
      id: `root:${key}`,
      read: (text) => new CodexTomlDocument(text).getRootKey(key),
      write: (text, value) => new CodexTomlDocument(text).setRootKeyRaw(key, value).toString(),
      clear: (text) => new CodexTomlDocument(text).removeRootKey(key).toString()
    };
  }

  private rootKeySlot(key: string, value: string): SlotWrite {
    return { ...this.rootKeyEditor(key), value: JSON.stringify(value) };
  }

  private tableEditor(tablePath: readonly string[]): SlotEditor {
    return {
      id: `table:${tablePath.join('.')}`,
      read: (text) => new CodexTomlDocument(text).getTable(tablePath),
      write: (text, value) => new CodexTomlDocument(text).setTable(tablePath, value).toString(),
      clear: (text) => new CodexTomlDocument(text).setTable(tablePath, null).toString()
    };
  }

  private tableSlot(
    tablePath: readonly string[],
    entries: ReadonlyArray<[string, string | boolean]>
  ): SlotWrite {
    return { ...this.tableEditor(tablePath), value: CodexTomlDocument.renderTable(tablePath, entries) };
  }

  /**
   * The endpoint's OpenAI-compatible prefix, which is what Codex appends paths
   * to. The router serves the same prefix as the gateway, so one form covers
   * both.
   */
  private providerBaseUrl(baseUrl: string): string {
    return `${baseUrl.replace(/\/+$/, '')}/v1`;
  }
}

export default CodexConfigTakeover;
