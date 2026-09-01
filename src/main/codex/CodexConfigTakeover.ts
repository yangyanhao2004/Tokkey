import os from 'node:os';
import path from 'node:path';
import BackedUpConfigFile from '../config/BackedUpConfigFile';
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
 * configures Codex. The borrow-and-return contract that makes editing it
 * acceptable — backup, crash recovery, byte-for-byte restore — lives in
 * {@link BackedUpConfigFile}, which `ClaudeConfigTakeover` shares.
 *
 * Restoring before anything reads the file matters here beyond tidiness:
 * `CodexUpstreamEndpoint` learns the user's real upstream from this same file,
 * and reading it while Tokiie's own address is still in there would teach it
 * that the gateway is its own upstream.
 */
export class CodexConfigTakeover {
  private readonly file: BackedUpConfigFile;

  constructor(options: { home?: CodexHome; homeDirectory?: string; backupPath?: string } = {}) {
    const home = options.home ?? new CodexHome(options);
    this.file = new BackedUpConfigFile({
      filePath: home.configPath,
      backupPath:
        options.backupPath ??
        path.join(options.homeDirectory ?? os.homedir(), '.amiswifi', 'codex-config-backup.toml'),
      label: 'CodexConfig'
    });
  }

  get configPath(): string {
    return this.file.configPath;
  }

  /** Where the user's own file is held while the takeover is in force. */
  get backupFilePath(): string {
    return this.file.backupFilePath;
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
    return this.file.recoverInterruptedSession();
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
    const taken = this.file.activate((original) =>
      this.rewrite(original, gatewayBaseUrl, catalogPath)
    );
    if (taken) {
      console.info(`[CodexConfig] Codex now routes through ${this.providerBaseUrl(gatewayBaseUrl)}.`);
    }
    return taken;
  }

  /**
   * Puts the user's own `config.toml` back. Synchronous on purpose: this runs
   * from Electron's `will-quit`, which does not wait for a promise.
   *
   * @returns whether a restore happened
   */
  restore(): boolean {
    return this.file.restore();
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
}

export default CodexConfigTakeover;
