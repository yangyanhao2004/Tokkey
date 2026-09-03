import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
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
 * That window is also the dangerous one. Between the crash and the next launch
 * the file looks like an ordinary config file, and the user has every reason to
 * edit it — it is theirs. Putting the original back byte for byte would erase
 * that edit with no way to get it back, so the restore is conditional: every
 * write records exactly what it wrote, and the original only goes back over a
 * file still byte for byte identical to that record. Anything else means
 * someone has taken the file back, and the loan ends there rather than in an
 * overwrite. See {@link orphanBackup} for what that costs.
 */
export class BackedUpConfigFile {
  private readonly filePath: string;
  private readonly backupPath: string;
  /** Where the exact bytes of Tokkey's last write are recorded. */
  private readonly takeoverRecordPath: string;
  /** Prefixes this file's log lines, e.g. `ClaudeConfig`. */
  private readonly label: string;
  /** True once this launch has rewritten the file and owes it a restore. */
  private active = false;

  constructor(options: { filePath: string; backupPath: string; label: string }) {
    this.filePath = options.filePath;
    this.backupPath = options.backupPath;
    this.takeoverRecordPath = `${options.backupPath}.written`;
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
    if (!this.holdsOurWrite()) {
      this.orphanBackup('was edited after a session that never restored it');
      return false;
    }
    console.info(`[${this.label}] Restoring ${path.basename(this.filePath)} left behind by an interrupted session.`);
    return this.restoreFromBackup();
  }

  /**
   * Backs the file up and replaces it with what `rewrite` makes of it.
   *
   * Taking over a file already taken over is a refresh, not a second takeover:
   * backing up again here would copy Tokkey's own output over the only record of
   * what the user had, and the restore would then hand them a file they never
   * wrote.
   *
   * @param rewrite receives the current text — empty when there is no file —
   *   and returns the document the CLI should see while Tokkey runs
   * @returns whether the file was taken over
   */
  activate(rewrite: (original: string) => string): boolean {
    if (this.active) {
      return this.reapply(rewrite);
    }
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
    const rewritten = rewrite(original);
    writeFileSync(this.filePath, rewritten, 'utf8');
    // Recorded on every write, and never skipped: each later decision to put the
    // original back rests on proving nothing else has written the file since.
    mkdirSync(path.dirname(this.takeoverRecordPath), { recursive: true });
    writeFileSync(this.takeoverRecordPath, rewritten, 'utf8');
  }

  /**
   * Whether the file on disk is still byte for byte what Tokkey last wrote.
   *
   * Byte equality rather than a per-format fingerprint: it needs to know nothing
   * about TOML or JSON, it cannot be fooled by an edit that happens to leave
   * Tokkey's own keys in place, and it answers the only question that decides
   * whether an overwrite is safe — has anyone else touched this file since.
   *
   * A missing or unreadable record answers "cannot tell", which counts as
   * touched. Overwriting a file whose provenance is unknown is the one outcome
   * with no way back.
   */
  private holdsOurWrite(): boolean {
    try {
      return readFileSync(this.filePath, 'utf8') === readFileSync(this.takeoverRecordPath, 'utf8');
    } catch {
      return false;
    }
  }

  /**
   * Ends the loan without collecting on it, for a file the user has taken back.
   *
   * The live file is left exactly as found — the user's edits intact, and with
   * them whatever Tokkey wrote that they did not remove, which can leave the CLI
   * pointed at a gateway that is gone. That is a visible, repairable state, and
   * the next launch rewrites those keys anyway. A silently discarded edit is
   * neither visible nor repairable, so it is the worse of the two.
   *
   * The backup is moved aside rather than dropped: it is the only copy of what
   * the file held before the takeover. Moving it also stops recovery retrying
   * this decision on every launch.
   */
  private orphanBackup(reason: string): void {
    const orphanPath = `${this.backupPath}.orphaned`;
    try {
      renameSync(this.backupPath, orphanPath);
      console.warn(
        `[${this.label}] ${path.basename(this.filePath)} ${reason}, so it was left as it is. ` +
          `The copy taken before the takeover is at ${orphanPath}.`
      );
    } catch (error: unknown) {
      console.error(`[${this.label}] Could not set the superseded backup aside:`, error);
    }
    this.discardRecord();
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
    // Cleared first: this may run from a signal handler as well as from
    // `will-quit`, and the loan is given up either way.
    this.active = false;
    if (!this.holdsOurWrite()) {
      this.orphanBackup('was edited while Tokkey was running');
      return false;
    }
    return this.restoreFromBackup();
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
    this.removeFile(this.filePath);
  }

  /** Drops the backup and the record together: neither outlives the takeover. */
  private discardBackup(): void {
    this.removeFile(this.backupPath);
    this.discardRecord();
  }

  private discardRecord(): void {
    this.removeFile(this.takeoverRecordPath);
  }

  private removeFile(filePath: string): void {
    try {
      unlinkSync(filePath);
    } catch {
      // Already gone, which is the state the caller was aiming for.
    }
  }
}

export default BackedUpConfigFile;
