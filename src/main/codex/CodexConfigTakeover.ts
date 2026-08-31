import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import CodexHome from './CodexHome';
import CodexTomlDocument from './CodexTomlDocument';

/** The provider table Tokiie owns. Everything else in the file belongs to the user. */
const TOKIIE_PROVIDER_ID = 'tokiie';

/** Root keys the takeover writes, and the restore therefore has to account for. */
const MODEL_PROVIDER_KEY = 'model_provider';
const MODEL_CATALOG_KEY = 'model_catalog_json';

/**
 * Points the Codex CLI at the local gateway for as long as Tokiie is running.
 *
 * Codex reads one file, `~/.codex/config.toml`, and that file is the user's:
 * hand-written, full of comments, and shared with every other tool that
 * configures Codex. So the takeover is a loan, not a migration. The original is
 * copied aside before the first edit and copied back when the app quits, which
 * makes "Tokiie is running" the only window in which Codex talks to the
 * gateway, and leaves a machine where Tokiie has never run indistinguishable
 * from one where it has.
 *
 * A crash is the case the backup really exists for. Nothing runs at quit time
 * when the process is killed, so the backup outlives the session, and the next
 * launch restores it before anything else reads the file. That ordering matters
 * beyond tidiness: `CodexUpstreamEndpoint` learns the user's real upstream from
 * this same file, and reading it while Tokiie's own address is still in there
 * would teach it that the gateway is its own upstream.
 *
 * Caveat, by design: the restore puts the file back byte for byte, so an edit
 * made to `config.toml` by anything else during the session — including
 * Tokiie's own MCP writer — is discarded at quit.
 */
export class CodexConfigTakeover {
  private readonly home: CodexHome;
  private readonly backupPath: string;
  /** True once this launch has rewritten the file and owes it a restore. */
  private isActive = false;

  constructor(options: { home?: CodexHome; homeDirectory?: string; backupPath?: string } = {}) {
    this.home = options.home ?? new CodexHome(options);
    this.backupPath =
      options.backupPath ??
      path.join(options.homeDirectory ?? os.homedir(), '.amiswifi', 'codex-config-backup.toml');
  }

  get configPath(): string {
    return this.home.configPath;
  }

  /** Where the user's own file is held while the takeover is in force. */
  get backupFilePath(): string {
    return this.backupPath;
  }

  /**
   * Undoes a takeover a previous run never got to undo.
   *
   * Called before anything reads `config.toml`, so a crashed session cannot
   * leave Tokiie's own configuration to be mistaken for the user's.
   *
   * @returns whether a leftover backup was found and restored
   */
  recoverInterruptedSession(): boolean {
    if (this.isActive || !existsSync(this.backupPath)) {
      return false;
    }
    console.info('[CodexConfig] Restoring config.toml left behind by an interrupted session.');
    return this.restoreFromBackup();
  }

  /**
   * Backs up `config.toml` and rewrites it to serve models from the gateway.
   *
   * @param gatewayBaseUrl the running gateway's base URL, e.g. `http://127.0.0.1:4000`
   * @param catalogPath the generated catalog to point Codex at, or null to
   *   leave whatever catalog the user had configured in place
   * @returns whether the file was taken over
   */
  activate(gatewayBaseUrl: string, catalogPath: string | null): boolean {
    this.recoverInterruptedSession();
    try {
      const original = this.readConfig();
      this.writeBackup(original);
      writeFileSync(this.configPath, this.rewrite(original, gatewayBaseUrl, catalogPath), 'utf8');
      this.isActive = true;
      console.info(`[CodexConfig] Codex now routes through ${this.providerBaseUrl(gatewayBaseUrl)}.`);
      return true;
    } catch (error: unknown) {
      // Codex keeps working with the user's own configuration; only the
      // convenience of routing through the gateway is lost.
      console.error('[CodexConfig] Could not point Codex at the gateway:', error);
      this.discardBackup();
      return false;
    }
  }

  /**
   * Puts the user's own `config.toml` back. Synchronous on purpose: this runs
   * from Electron's `will-quit`, which does not wait for a promise.
   *
   * @returns whether a restore happened
   */
  restore(): boolean {
    if (!this.isActive) {
      return false;
    }
    const restored = this.restoreFromBackup();
    this.isActive = false;
    return restored;
  }

  /** The document Codex should see while Tokiie is running. */
  private rewrite(original: string, gatewayBaseUrl: string, catalogPath: string | null): string {
    let document = new CodexTomlDocument(original)
      // Removed first so a table left by an interrupted session is replaced
      // rather than declared twice, which Codex rejects outright.
      .removeTable(['model_providers', TOKIIE_PROVIDER_ID])
      .setRootKey(MODEL_PROVIDER_KEY, TOKIIE_PROVIDER_ID);
    if (catalogPath !== null) {
      document = document.setRootKey(MODEL_CATALOG_KEY, catalogPath);
    }
    return document
      .appendTable(
        ['model_providers', TOKIIE_PROVIDER_ID],
        [
          ['name', 'Tokiie'],
          ['base_url', this.providerBaseUrl(gatewayBaseUrl)],
          // The gateway speaks the Responses wire, which is what lets a Codex
          // turn reach it unchanged.
          ['wire_api', 'responses'],
          // Codex sends its own login with the request; the gateway decides per
          // request whether that credential or a route's own key is spent.
          ['requires_openai_auth', true]
        ]
      )
      .toString();
  }

  /** The gateway's OpenAI-compatible prefix, which is what Codex appends paths to. */
  private providerBaseUrl(gatewayBaseUrl: string): string {
    return `${gatewayBaseUrl.replace(/\/+$/, '')}/v1`;
  }

  /** The current file, or an empty document when Codex has never written one. */
  private readConfig(): string {
    try {
      return readFileSync(this.configPath, 'utf8');
    } catch {
      return '';
    }
  }

  private writeBackup(original: string): void {
    mkdirSync(path.dirname(this.backupPath), { recursive: true });
    writeFileSync(this.backupPath, original, 'utf8');
  }

  /**
   * Copies the backup over `config.toml` and drops it.
   *
   * An empty backup means there was no `config.toml` before the takeover, so
   * the file is removed rather than left behind as an empty one — Codex reads a
   * missing file and an empty file the same way, but only one of them is the
   * state the user actually had.
   */
  private restoreFromBackup(): boolean {
    try {
      if (statSync(this.backupPath).size === 0) {
        this.removeConfig();
      } else {
        copyFileSync(this.backupPath, this.configPath);
      }
      this.discardBackup();
      return true;
    } catch (error: unknown) {
      // The backup is deliberately left in place: the next launch retries the
      // restore, which is the only path back to the user's own configuration.
      console.error('[CodexConfig] Could not restore the original config.toml:', error);
      return false;
    }
  }

  private removeConfig(): void {
    try {
      unlinkSync(this.configPath);
    } catch {
      // Already gone, which is the state the restore was aiming for.
    }
  }

  private discardBackup(): void {
    try {
      unlinkSync(this.backupPath);
    } catch {
      // Nothing to discard.
    }
  }
}

export default CodexConfigTakeover;
