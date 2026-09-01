import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import path from 'node:path';

/** One model entry in the Desktop inference model picker. */
export interface DesktopInferenceModel {
  /**
   * The model name Claude Desktop sends to the gateway.
   *
   * Claude Desktop's managed config drops any name its Anthropic-model check
   * refuses, so the caller publishes cloud routes under a `ClaudeModelAlias`;
   * the gateway resolves that alias back to the real route.
   */
  name: string;
  /**
   * The name shown in the picker, which the model check never inspects.
   *
   * This is where the real model name goes: `name` has to survive a validator
   * that refuses every rival vendor by name, so it cannot carry one.
   */
  labelOverride?: string;
  /**
   * Which Claude tier this model stands in for, pinning the bare alias Desktop
   * resolves internally (`opus`, `sonnet`, …) to this model.
   */
  anthropicFamilyTier?: 'opus' | 'sonnet' | 'haiku' | 'fable' | 'mythos';
}

/**
 * The bearer token Claude Desktop sends to the local gateway.
 *
 * LiteLLM with no `master_key` configured accepts any bearer token, so the
 * value is arbitrary. It is kept constant across launches so no gateway
 * restart or credential sync is needed.
 */
const GATEWAY_TOKEN = 'tokie-local';

/**
 * The UUID Tokiie uses for its configLibrary entry.
 *
 * Chosen to be one step above cc-switch's `...157210` so they never collide
 * if both tools are installed on the same machine.
 */
const TOKIIE_ENTRY_ID = '00000000-0000-4000-8000-000000157211';
const TOKIIE_ENTRY_NAME = 'Tokiie';

/** JSON indent width — matches what Claude Desktop itself writes. */
const INDENT_WIDTH = 2;

/**
 * Manages the two-file `configLibrary` that Claude Desktop reads in 3p mode.
 *
 * The configLibrary is a pair of JSON files in
 * `~/Library/Application Support/Claude-3p/configLibrary/`:
 *
 * - `_meta.json` — an index that names the currently applied entry via
 *   `appliedId`. It may already point at a cc-switch entry when the user has
 *   that tool installed; Tokiie backs it up before overwriting it and restores
 *   it on quit.
 * - `<TOKIIE_ENTRY_ID>.json` — Tokiie's own inference config: the gateway URL
 *   and the model list. This file is purely Tokiie's and is deleted on restore
 *   rather than reverted, since there is no "original" state to return to.
 *
 * The backup/restore contract mirrors {@link BackedUpConfigFile}: the original
 * `_meta.json` is kept at a stable path outside the configLibrary, and the
 * next launch restores it before anything reads the directory, so a crash
 * cannot leave Tokiie's configuration in place indefinitely.
 */
export class ClaudeDesktopConfigLibrary {
  private readonly configLibraryDir: string;
  private readonly metaBackupPath: string;
  /** True once this launch has taken the configLibrary and owes it a restore. */
  private active = false;

  constructor(options: { configLibraryDir: string; metaBackupPath: string }) {
    this.configLibraryDir = options.configLibraryDir;
    this.metaBackupPath = options.metaBackupPath;
  }

  /**
   * Undoes a takeover an interrupted run never undid.
   *
   * Call before anything reads the configLibrary directory so a crashed session
   * cannot leave Tokiie's own configuration in the user's Claude Desktop.
   *
   * @returns whether a leftover backup was found and restored
   */
  recoverInterruptedSession(): boolean {
    if (this.active || !existsSync(this.metaBackupPath)) {
      return false;
    }
    console.info('[ClaudeDesktop] Restoring configLibrary left behind by an interrupted session.');
    return this.restoreInternal();
  }

  /**
   * Backs up `_meta.json`, writes Tokiie's entry, and points the meta index at it.
   *
   * An empty model list is left alone rather than written. Desktop signs in by
   * running one inference call against a model from this list, so an entry with
   * no models cannot be signed into — and taking the configLibrary over to
   * produce that failure is worse than leaving Desktop as the user had it.
   *
   * @param gatewayBaseUrl the running gateway's base URL, e.g. `http://127.0.0.1:4000`
   * @param models the models to offer in the Desktop picker, default first
   * @returns whether the configLibrary was taken over
   */
  activate(gatewayBaseUrl: string, models: DesktopInferenceModel[]): boolean {
    if (models.length === 0) {
      return false;
    }
    this.recoverInterruptedSession();
    try {
      mkdirSync(this.configLibraryDir, { recursive: true });
      this.backupMeta();
      this.writeEntry(gatewayBaseUrl, models);
      this.writeMeta();
      this.active = true;
      console.info(`[ClaudeDesktop] configLibrary now routes through ${gatewayBaseUrl}.`);
      return true;
    } catch (error: unknown) {
      console.error('[ClaudeDesktop] Could not write configLibrary:', error);
      this.discardBackup();
      return false;
    }
  }

  /**
   * Rewrites the entry for a model set that changed after `activate` ran.
   *
   * Does nothing when no takeover is in force.
   *
   * @returns whether the entry was rewritten
   */
  reapply(gatewayBaseUrl: string, models: DesktopInferenceModel[]): boolean {
    if (!this.active || models.length === 0) {
      return false;
    }
    try {
      this.writeEntry(gatewayBaseUrl, models);
      return true;
    } catch (error: unknown) {
      console.error('[ClaudeDesktop] Could not refresh configLibrary entry:', error);
      return false;
    }
  }

  /**
   * Deletes Tokiie's entry and puts the original `_meta.json` back.
   * Synchronous, for Electron's `will-quit`.
   *
   * @returns whether a restore happened
   */
  restore(): boolean {
    if (!this.active) {
      return false;
    }
    const restored = this.restoreInternal();
    this.active = false;
    return restored;
  }

  /** Builds the inference config object Tokiie writes to its entry file. */
  private buildEntryConfig(
    gatewayBaseUrl: string,
    models: DesktopInferenceModel[]
  ): Record<string, unknown> {
    return {
      disableDeploymentModeChooser: true,
      coworkEgressAllowedHosts: ['*'],
      inferenceProvider: 'gateway',
      // One of Desktop's five credential kinds: `static` names the plain key in
      // `inferenceGatewayApiKey`, sent as the Bearer token below. Anything
      // outside that enum leaves the entry with no credential at all.
      inferenceCredentialKind: 'static',
      inferenceGatewayApiKey: GATEWAY_TOKEN,
      inferenceGatewayAuthScheme: 'bearer',
      inferenceGatewayBaseUrl: gatewayBaseUrl,
      // Spread rather than rebuilt field by field: an entry carries only the
      // keys the caller set, and Desktop reads an absent key differently from
      // an explicit undefined.
      inferenceModels: models.map((model) => ({ ...model }))
    };
  }

  private writeEntry(gatewayBaseUrl: string, models: DesktopInferenceModel[]): void {
    const entryPath = path.join(this.configLibraryDir, `${TOKIIE_ENTRY_ID}.json`);
    const content = JSON.stringify(this.buildEntryConfig(gatewayBaseUrl, models), null, INDENT_WIDTH);
    writeFileSync(entryPath, `${content}\n`, 'utf8');
  }

  /**
   * Points the meta index at Tokiie's entry, keeping every entry already there.
   *
   * The index is a shared file: a user running cc-switch has their own entries
   * listed in it, and their config files stay on disk beside Tokiie's. Listing
   * only Tokiie's would unlist configs whose files still exist — and Desktop
   * rewrites this file itself, so a restore is not guaranteed to be what puts
   * them back.
   */
  private writeMeta(): void {
    const metaPath = path.join(this.configLibraryDir, '_meta.json');
    const existing = this.readMetaEntries(metaPath).filter((entry) => entry.id !== TOKIIE_ENTRY_ID);
    const meta = {
      appliedId: TOKIIE_ENTRY_ID,
      entries: [...existing, { id: TOKIIE_ENTRY_ID, name: TOKIIE_ENTRY_NAME }]
    };
    writeFileSync(metaPath, `${JSON.stringify(meta, null, INDENT_WIDTH)}\n`, 'utf8');
  }

  /** The entries already listed in the meta index, or none if it is unreadable. */
  private readMetaEntries(metaPath: string): { id: string; name?: string }[] {
    try {
      const meta: unknown = JSON.parse(readFileSync(metaPath, 'utf8'));
      const entries = (meta as { entries?: unknown })?.entries;
      // A malformed index is treated as empty rather than repaired: the backup
      // holds the original, and restore puts that file back verbatim.
      return Array.isArray(entries)
        ? entries.filter((entry): entry is { id: string } => typeof entry?.id === 'string')
        : [];
    } catch {
      return [];
    }
  }

  private backupMeta(): void {
    const metaPath = path.join(this.configLibraryDir, '_meta.json');
    mkdirSync(path.dirname(this.metaBackupPath), { recursive: true });
    // Write empty sentinel when there is no existing _meta.json, so restore
    // knows to delete rather than write back a stale file.
    const content = existsSync(metaPath) ? readFileSync(metaPath, 'utf8') : '';
    writeFileSync(this.metaBackupPath, content, 'utf8');
  }

  private restoreInternal(): boolean {
    try {
      this.deleteEntry();
      const metaPath = path.join(this.configLibraryDir, '_meta.json');
      if (statSync(this.metaBackupPath).size === 0) {
        // No _meta.json existed before the takeover — remove what we wrote.
        this.deleteFile(metaPath);
      } else {
        mkdirSync(this.configLibraryDir, { recursive: true });
        copyFileSync(this.metaBackupPath, metaPath);
      }
      this.discardBackup();
      return true;
    } catch (error: unknown) {
      // Leave the backup in place so the next launch retries.
      console.error('[ClaudeDesktop] Could not restore configLibrary:', error);
      return false;
    }
  }

  private deleteEntry(): void {
    this.deleteFile(path.join(this.configLibraryDir, `${TOKIIE_ENTRY_ID}.json`));
  }

  private deleteFile(filePath: string): void {
    try {
      unlinkSync(filePath);
    } catch {
      // Already gone — the target state is achieved either way.
    }
  }

  private discardBackup(): void {
    this.deleteFile(this.metaBackupPath);
  }
}

export default ClaudeDesktopConfigLibrary;
