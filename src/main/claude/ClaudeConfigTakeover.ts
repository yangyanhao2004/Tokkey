import os from 'node:os';
import path from 'node:path';
import BackedUpConfigFile from '../config/BackedUpConfigFile';
import ClaudeHome from './ClaudeHome';
import ClaudeSettingsDocument, { type ClaudeModelSelection } from './ClaudeSettingsDocument';

/** The setting Claude Code reads to decide which host serves its Messages calls. */
const BASE_URL_KEY = 'ANTHROPIC_BASE_URL';

/**
 * Points the Claude Code CLI at the local gateway for as long as Tokiie runs.
 *
 * The mechanism is `~/.claude/settings.json`, whose `env` block Claude applies
 * to every session it starts, and the one entry Tokiie sets there is
 * `ANTHROPIC_BASE_URL`. Nothing else is touched — no credential, in particular.
 * Claude Code carries its own login and sends it with the request, and the
 * gateway's Claude routes are registered keyless precisely so that credential
 * is the one that gets spent; writing a key here would supersede the user's
 * claude.ai subscription and bill an API account instead.
 *
 * The borrow-and-return contract, the crash recovery and the byte-for-byte
 * restore all live in {@link BackedUpConfigFile}, which `CodexConfigTakeover`
 * shares. Read that class for why the original is copied aside rather than
 * edited back out at quit.
 */
export class ClaudeConfigTakeover {
  private readonly file: BackedUpConfigFile;

  constructor(options: { home?: ClaudeHome; homeDirectory?: string; claudeHome?: string; backupPath?: string } = {}) {
    const home = options.home ?? new ClaudeHome(options);
    this.file = new BackedUpConfigFile({
      filePath: home.settingsPath,
      backupPath:
        options.backupPath ??
        path.join(options.homeDirectory ?? os.homedir(), '.amiswifi', 'claude-settings-backup.json'),
      label: 'ClaudeConfig'
    });
  }

  get configPath(): string {
    return this.file.configPath;
  }

  /** Where the user's own settings are held while the takeover is in force. */
  get backupFilePath(): string {
    return this.file.backupFilePath;
  }

  /**
   * Undoes a takeover a previous run never got to undo.
   *
   * @returns whether a leftover backup was found and restored
   */
  recoverInterruptedSession(): boolean {
    return this.file.recoverInterruptedSession();
  }

  /**
   * Backs up `settings.json` and rewrites it to send Claude to the gateway.
   *
   * @param gatewayBaseUrl the running gateway's base URL, e.g. `http://127.0.0.1:4033`
   * @param selection the models to restrict Claude Code to, or null to leave
   *   the user's own model choice in place
   * @returns whether the file was taken over
   */
  activate(gatewayBaseUrl: string, selection: ClaudeModelSelection | null = null): boolean {
    const baseUrl = ClaudeConfigTakeover.normalizeBaseUrl(gatewayBaseUrl);
    const taken = this.file.activate((original) => this.rewrite(original, baseUrl, selection));
    if (taken) {
      console.info(`[ClaudeConfig] Claude Code now routes through ${baseUrl}.`);
    }
    return taken;
  }

  /**
   * Rewrites the settings for a model set that changed after `activate` ran,
   * which is how a model connected mid-session reaches Claude Code's picker.
   *
   * Does nothing when no takeover is in force: taking the file over is
   * `activate`'s decision, and a connect should not make it for it.
   *
   * @returns whether the settings were rewritten
   */
  reapply(gatewayBaseUrl: string, selection: ClaudeModelSelection | null): boolean {
    const baseUrl = ClaudeConfigTakeover.normalizeBaseUrl(gatewayBaseUrl);
    return this.file.reapply((original) => this.rewrite(original, baseUrl, selection));
  }

  /** The settings Claude Code should see while Tokiie is running. */
  private rewrite(
    original: string,
    baseUrl: string,
    selection: ClaudeModelSelection | null
  ): string {
    const document = new ClaudeSettingsDocument(original).setEnvironmentVariable(
      BASE_URL_KEY,
      baseUrl
    );
    return (selection ? document.setModelSelection(selection) : document).toString();
  }

  /** Puts the user's own `settings.json` back. Synchronous, for `will-quit`. */
  restore(): boolean {
    return this.file.restore();
  }

  /**
   * The gateway address as Claude Code wants it: no trailing slash and no `/v1`
   * suffix, because Claude appends `/v1/messages` itself.
   */
  private static normalizeBaseUrl(gatewayBaseUrl: string): string {
    return gatewayBaseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  }
}

export default ClaudeConfigTakeover;
