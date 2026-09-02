import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Lends Tokkey one configuration file belonging to another tool, and gives it
 * back.
 *
 * Both CLIs Tokkey points at its gateway — Codex and Claude Code — are
 * configured by a file that is the user's: hand-written, shared with every
 * other tool that configures that CLI, and expected to be exactly as they left
 * it. So the takeover is a loan, not a migration. The original is copied aside
 * before the first edit and copied back when the app quits, which makes "Tokkey
 * is running" the only window in which the CLI talks to the gateway, and leaves
 * a machine where Tokkey has never run indistinguishable from one where it has.
 *
 * A crash is the case the backup really exists for. Nothing runs at quit time
 * when the process is killed, so the backup outlives the session, and the next
 * launch restores it before anything else reads the file.
 *
 * Caveat, by design: the restore puts the file back byte for byte, so an edit
 * made by anything else during the session is discarded at quit.
 */
export class BackedUpConfigFile {
  private readonly filePath: string;
  private readonly backupPath: string;
  /** Prefixes this file's log lines, e.g. `ClaudeConfig`. */
  private readonly label: string;
  /** True once this launch has rewritten the file and owes it a restore. */
  private active = false;

  constructor(options: { filePath: string; backupPath: string; label: string }) {
    this.filePath = options.filePath;
    this.backupPath = options.backupPath;
    this.label = options.label;
  }

  get configPath(): string {
    return this.filePath;
  }

  /** Where the user's own file is held while the takeover is in force. */
  get backupFilePath(): string {
    return this.backupPath;
  }

  get isActive(): boolean {
    return this.active;
  }

  /** The current file, or an empty document when the tool never wrote one. */
  read(): string {
    try {
      return readFileSync(this.filePath, 'utf8');
    } catch {
      return '';
    }
  }

  /**
   * Undoes a takeover a previous run never got to undo.
   *
   * Call before anything reads the file, so a crashed session cannot leave
   * Tokkey's own configuration to be mistaken for the user's.
   *
   * @returns whether a leftover backup was found and restored
   */
  recoverInterruptedSession(): boolean {
    if (this.active || !existsSync(this.backupPath)) {
      return false;
    }
    console.info(`[${this.label}] Restoring ${path.basename(this.filePath)} left behind by an interrupted session.`);
    return this.restoreFromBackup();
  }

  /**
   * Backs the file up and replaces it with what `rewrite` makes of it.
   *
   * @param rewrite receives the current text — empty when there is no file —
   *   and returns the document the CLI should see while Tokkey runs
   * @returns whether the file was taken over
   */
  activate(rewrite: (original: string) => string): boolean {
    this.recoverInterruptedSession();
    try {
      const original = this.read();
      this.writeBackup(original);
      this.writeRewritten(original, rewrite);
      this.active = true;
      return true;
    } catch (error: unknown) {
      // The CLI keeps working with the user's own configuration; only the
      // convenience of routing through the gateway is lost.
      console.error(`[${this.label}] Could not point the CLI at the gateway:`, error);
      this.discardBackup();
      return false;
    }
  }

  /**
   * Rewrites a file already taken over, for state that changed mid-session.
   *
   * The rewrite is applied to the *backed up* original rather than to what is
   * on disk, so every run produces the same document as the first one would
   * have: nothing Tokkey wrote earlier can accumulate, and nothing the user
   * owns is read back out of a file Tokkey is currently holding.
   *
   * A no-op when no takeover is in force — without a backup there is no
   * original to rewrite, and taking the file over is `activate`'s decision.
   *
   * @returns whether the file was rewritten
   */
  reapply(rewrite: (original: string) => string): boolean {
    if (!this.active) {
      return false;
    }
    try {
      this.writeRewritten(readFileSync(this.backupPath, 'utf8'), rewrite);
      return true;
    } catch (error: unknown) {
      // The takeover from `activate` stands; only this refresh is lost.
      console.error(`[${this.label}] Could not refresh ${path.basename(this.filePath)}:`, error);
      return false;
    }
  }

  /** Puts `rewrite`'s document where the CLI reads it. */
  private writeRewritten(original: string, rewrite: (original: string) => string): void {
    // The CLI's home may not exist yet: Tokkey can be the first thing on this
    // machine to configure it.
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, rewrite(original), 'utf8');
  }

  /**
   * Puts the user's own file back. Synchronous on purpose: this runs from
   * Electron's `will-quit`, which does not wait for a promise.
   *
   * @returns whether a restore happened
   */
  restore(): boolean {
    if (!this.active) {
      return false;
    }
    const restored = this.restoreFromBackup();
    this.active = false;
    return restored;
  }

  private writeBackup(original: string): void {
    mkdirSync(path.dirname(this.backupPath), { recursive: true });
    writeFileSync(this.backupPath, original, 'utf8');
  }

  /**
   * Copies the backup over the live file and drops it.
   *
   * An empty backup means there was no file before the takeover, so it is
   * removed rather than left behind as an empty one — a CLI reads a missing
   * file and an empty file the same way, but only one of them is the state the
   * user actually had.
   */
  private restoreFromBackup(): boolean {
    try {
      if (statSync(this.backupPath).size === 0) {
        this.removeConfig();
      } else {
        mkdirSync(path.dirname(this.filePath), { recursive: true });
        copyFileSync(this.backupPath, this.filePath);
      }
      this.discardBackup();
      return true;
    } catch (error: unknown) {
      // The backup is deliberately left in place: the next launch retries the
      // restore, which is the only path back to the user's own configuration.
      console.error(`[${this.label}] Could not restore the original ${path.basename(this.filePath)}:`, error);
      return false;
    }
  }

  private removeConfig(): void {
    try {
      unlinkSync(this.filePath);
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

export default BackedUpConfigFile;
