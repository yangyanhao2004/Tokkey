import OwnedConfigFile, { type SlotEditor, type SlotWrite } from '../config/OwnedConfigFile';
import RouterMcpServer from '../router/RouterMcpServer';
import TokkeyHome from '../storage/TokkeyHome';
import ClaudeHome from './ClaudeHome';
import ClaudeUserConfigDocument from './ClaudeUserConfigDocument';

/** Where a user-scope MCP server is declared for the Claude Code CLI. */
const MCP_SERVER_PATH = ['mcpServers', RouterMcpServer.NAME] as const;

/**
 * Lends Tokkey one entry in `~/.claude.json` for as long as the router runs.
 *
 * A second file, and so a second takeover, because Claude Code splits its
 * configuration in two: `settings.json` holds the endpoint and the model list
 * that `ClaudeConfigTakeover` owns, while user-scope MCP servers live in
 * `~/.claude.json` beside it. The two are borrowed on different schedules —
 * the settings for the whole session, this entry only while the switch is on —
 * which is the other reason they are not one takeover: reapplying one must not
 * mean rewriting the other.
 *
 * Exactly one slot, `mcpServers.tokkey-router`, is owned. The rest of that file
 * is the CLI's own state — onboarding, per-project history, the user's other
 * MCP servers — and is never read for meaning, only carried through.
 */
export class ClaudeMcpTakeover {
  private readonly file: OwnedConfigFile;

  constructor(options: { home?: ClaudeHome; homeDirectory?: string; claudeHome?: string; ledgerPath?: string } = {}) {
    const home = options.home ?? new ClaudeHome(options);
    this.file = new OwnedConfigFile({
      filePath: home.userConfigPath,
      ledgerPath: options.ledgerPath ?? new TokkeyHome(options).pathFor('claude-mcp-ledger.json'),
      label: 'ClaudeMcp',
      // Same reason as the settings takeover: a JSON document with the owned
      // key gone still serializes to `{}`, never to whitespace.
      isEmpty: (text) => new ClaudeUserConfigDocument(text).isEmpty()
    });
  }

  get configPath(): string {
    return this.file.configPath;
  }

  /** Where the ledger of Tokkey's owned entry is kept while the takeover is in force. */
  get ledgerFilePath(): string {
    return this.file.ledgerFilePath;
  }

  /**
   * Removes an entry a previous run never got to remove.
   *
   * Worth doing on every launch even though the endpoint is long dead: a stale
   * entry makes Claude Code try to reach a router that is not there, and report
   * the failure, on every session start.
   *
   * @returns whether a leftover ledger was found and reverted
   */
  recoverInterruptedSession(): boolean {
    return this.file.recoverInterruptedSession(this.allEditors());
  }

  /**
   * Declares the router's tool server at `mcpUrl`, recording whatever the name
   * held before the first time it is touched.
   *
   * @param mcpUrl the running router's MCP endpoint
   * @returns whether the file was taken over
   */
  activate(mcpUrl: string): boolean {
    const taken = this.file.activate(this.writesFor(mcpUrl), this.allEditors());
    if (taken) {
      console.info(`[ClaudeMcp] Claude Code can now reach the router's tools at ${mcpUrl}.`);
    }
    return taken;
  }

  /**
   * Rewrites the entry for a router that came back on a different port, which
   * is the only thing that can change it mid-session.
   *
   * @returns whether the entry was rewritten; false when no takeover is in force
   */
  reapply(mcpUrl: string): boolean {
    return this.file.reapply(this.writesFor(mcpUrl), this.allEditors());
  }

  /**
   * Takes the entry back out — unless the user edited it themselves, in which
   * case it is now theirs. Synchronous, for `will-quit`.
   */
  restore(): boolean {
    return this.file.restore(this.allEditors());
  }

  /** The single slot this takeover writes, in the shape Claude Code reads. */
  private writesFor(mcpUrl: string): SlotWrite[] {
    return [
      {
        ...this.serverEditor(),
        value: JSON.stringify({ type: 'http', url: mcpUrl })
      }
    ];
  }

  /** Every slot this takeover might ever hold, for recovery and restore. */
  private allEditors(): SlotEditor[] {
    return [this.serverEditor()];
  }

  private serverEditor(): SlotEditor {
    return {
      id: MCP_SERVER_PATH.join('.'),
      read: (text) => new ClaudeUserConfigDocument(text).getPath(MCP_SERVER_PATH),
      write: (text, value) => new ClaudeUserConfigDocument(text).setPath(MCP_SERVER_PATH, value).toString(),
      clear: (text) => new ClaudeUserConfigDocument(text).deletePath(MCP_SERVER_PATH).toString()
    };
  }
}

export default ClaudeMcpTakeover;
