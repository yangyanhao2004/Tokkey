import OwnedConfigFile, { type SlotEditor, type SlotWrite } from '../config/OwnedConfigFile';
import TokkeyHome from '../storage/TokkeyHome';
import ClaudeHome from './ClaudeHome';
import ClaudeSettingsDocument, { type ClaudeModelSelection } from './ClaudeSettingsDocument';

/** The setting Claude Code reads to decide which host serves its Messages calls. */
const BASE_URL_KEY = 'ANTHROPIC_BASE_URL';
const ENV_PATH = ['env', BASE_URL_KEY] as const;
const MODEL_PATH = ['model'] as const;
const AVAILABLE_MODELS_PATH = ['availableModels'] as const;
const ENFORCE_AVAILABLE_MODELS_PATH = ['enforceAvailableModels'] as const;

/**
 * Points the Claude Code CLI at the local gateway for as long as Tokkey runs.
 *
 * The mechanism is `~/.claude/settings.json`, whose `env` block Claude applies
 * to every session it starts, and the one entry Tokkey sets there is
 * `ANTHROPIC_BASE_URL`. When a model selection is in force it also owns
 * `model`, `availableModels` and `enforceAvailableModels` — never anything
 * else. Nothing else is touched — no credential, in particular. Claude Code
 * carries its own login and sends it with the request, and the gateway's
 * Claude routes are registered keyless precisely so that credential is the
 * one that gets spent; writing a key here would supersede the user's
 * claude.ai subscription and bill an API account instead.
 *
 * The per-key loan-and-return contract, the crash recovery and the
 * independent-slot restore all live in {@link OwnedConfigFile}, which
 * `CodexConfigTakeover` shares. Read that class for why each slot is given
 * back on its own instead of the whole file being restored as one unit.
 */
export class ClaudeConfigTakeover {
  private readonly file: OwnedConfigFile;

  constructor(options: { home?: ClaudeHome; homeDirectory?: string; claudeHome?: string; ledgerPath?: string } = {}) {
    const home = options.home ?? new ClaudeHome(options);
    this.file = new OwnedConfigFile({
      filePath: home.settingsPath,
      ledgerPath:
        options.ledgerPath ??
        new TokkeyHome(options).pathFor('claude-settings-ledger.json'),
      label: 'ClaudeConfig',
      // A JSON document with every owned key gone still serializes to `{}`,
      // never to whitespace, so emptiness has to be asked of the parsed form.
      isEmpty: (text) => new ClaudeSettingsDocument(text).isEmpty()
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
   * @returns whether a leftover ledger was found and reverted
   */
  recoverInterruptedSession(): boolean {
    return this.file.recoverInterruptedSession(this.allEditors());
  }

  /**
   * Writes `env.ANTHROPIC_BASE_URL` and — when given — the model selection,
   * recording each slot's pre-takeover value the first time it is touched.
   *
   * @param gatewayBaseUrl the running gateway's base URL, e.g. `http://127.0.0.1:4033`
   * @param selection the models to restrict Claude Code to, or null to leave
   *   the user's own model choice in place
   * @returns whether the file was taken over
   */
  activate(gatewayBaseUrl: string, selection: ClaudeModelSelection | null = null): boolean {
    const baseUrl = ClaudeConfigTakeover.normalizeBaseUrl(gatewayBaseUrl);
    const taken = this.file.activate(this.writesFor(baseUrl, selection), this.allEditors());
    if (taken) {
      console.info(`[ClaudeConfig] Claude Code now routes through ${baseUrl}.`);
    }
    return taken;
  }

  /**
   * Rewrites the same slots for a model set that changed after `activate` ran,
   * which is how a model connected mid-session reaches Claude Code's picker.
   *
   * Only the keys Tokkey owns are touched, so anything the user changed
   * elsewhere in `settings.json` — permissions, hooks, their own model choice
   * when no selection is given — survives untouched. Does nothing when no
   * takeover is in force: taking the file over is `activate`'s decision, and a
   * refresh should not make it for it.
   *
   * @returns whether the settings were rewritten
   */
  reapply(gatewayBaseUrl: string, selection: ClaudeModelSelection | null): boolean {
    const baseUrl = ClaudeConfigTakeover.normalizeBaseUrl(gatewayBaseUrl);
    return this.file.reapply(this.writesFor(baseUrl, selection), this.allEditors());
  }

  /**
   * Puts every owned slot back to what it held before the takeover — except a
   * slot the user changed while Tokkey was running, which is left as they set
   * it. Synchronous, for `will-quit`.
   */
  restore(): boolean {
    return this.file.restore(this.allEditors());
  }

  /** The slots this takeover writes for a given gateway address and selection. */
  private writesFor(baseUrl: string, selection: ClaudeModelSelection | null): SlotWrite[] {
    const writes: SlotWrite[] = [this.pathSlot(ENV_PATH, JSON.stringify(baseUrl))];
    if (selection) {
      if (selection.model !== null) {
        writes.push(this.pathSlot(MODEL_PATH, JSON.stringify(selection.model)));
      }
      writes.push(this.pathSlot(AVAILABLE_MODELS_PATH, JSON.stringify([...selection.availableModels])));
      writes.push(this.pathSlot(ENFORCE_AVAILABLE_MODELS_PATH, JSON.stringify(true)));
    }
    return writes;
  }

  /** Every slot this takeover might ever hold, for recovery and restore. */
  private allEditors(): SlotEditor[] {
    return [
      this.pathEditor(ENV_PATH),
      this.pathEditor(MODEL_PATH),
      this.pathEditor(AVAILABLE_MODELS_PATH),
      this.pathEditor(ENFORCE_AVAILABLE_MODELS_PATH)
    ];
  }

  private pathEditor(pathSegments: readonly string[]): SlotEditor {
    return {
      id: pathSegments.join('.'),
      read: (text) => new ClaudeSettingsDocument(text).getPath(pathSegments),
      write: (text, value) => new ClaudeSettingsDocument(text).setPath(pathSegments, value).toString(),
      clear: (text) => new ClaudeSettingsDocument(text).deletePath(pathSegments).toString()
    };
  }

  private pathSlot(pathSegments: readonly string[], jsonValue: string): SlotWrite {
    return { ...this.pathEditor(pathSegments), value: jsonValue };
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
