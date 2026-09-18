import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * One region of a config file Tokkey owns, addressed by a stable id.
 *
 * A slot is scoped to exactly the key or table it edits — a root-level key, a
 * whole TOML table, a dotted JSON path — and never to anything else in the
 * file. That scoping is what lets Tokkey give back only what it changed,
 * whatever else the user does to the rest of the file in the meantime.
 */
export interface SlotEditor {
  readonly id: string;
  /** The slot's current value in `text`, or null if it is not set. */
  read(text: string): string | null;
  /** `text` with the slot set to `value`. */
  write(text: string, value: string): string;
  /** `text` with the slot removed entirely. */
  clear(text: string): string;
}

/** A slot together with the value this write wants it to hold. */
export interface SlotWrite extends SlotEditor {
  readonly value: string;
}

/** One slot's ledger entry: what it held before Tokkey ever touched it, and what Tokkey last wrote there. */
interface LedgerEntry {
  before: string | null;
  after: string | null;
}

type Ledger = Record<string, LedgerEntry>;

/**
 * Lends Tokkey a handful of specific keys inside a configuration file that
 * belongs to another tool, and gives back exactly those keys — never the
 * whole file.
 *
 * Both CLIs Tokkey points at its gateway — Codex and Claude Code — are
 * configured by a file that is the user's: hand-written, shared with every
 * other tool that configures that CLI, and liable to be edited by the user
 * while Tokkey is running. Earlier this class copied the whole file aside and
 * only restored it if the live file was still byte-for-byte identical to
 * Tokkey's last write — any other edit, anywhere in the file, aborted the
 * whole restore and left Tokkey's own keys stranded in the user's file for
 * good, since the next launch would then treat that stranded file as "the
 * original" to back up.
 *
 * This is a write-ahead log instead: every slot Tokkey writes records its own
 * `before` (captured once, the first time the slot is ever touched) and
 * `after` (Tokkey's most recent write). Restoring walks each owned slot
 * independently — if the live value still matches what Tokkey last wrote
 * there, it goes back to `before`; if the user changed that one slot, it is
 * left as they set it, and every other slot still reverts normally. A user
 * edit anywhere else in the file was never part of the loan and is untouched
 * either way.
 */
export class OwnedConfigFile {
  private readonly filePath: string;
  private readonly ledgerPath: string;
  private readonly label: string;
  /** True once this launch has written at least one slot and owes it a restore. */
  private active = false;

  /** Whether `text` holds nothing worth keeping a file for, once every owned slot is gone. */
  private readonly isEmpty: (text: string) => boolean;

  constructor(options: {
    filePath: string;
    ledgerPath: string;
    label: string;
    /** Format-specific "nothing left" check; defaults to whitespace-only text. */
    isEmpty?: (text: string) => boolean;
  }) {
    this.filePath = options.filePath;
    this.ledgerPath = options.ledgerPath;
    this.label = options.label;
    this.isEmpty = options.isEmpty ?? ((text) => text.trim().length === 0);
  }

  get configPath(): string {
    return this.filePath;
  }

  /** Where the ledger of owned slots is kept while the takeover is in force. */
  get ledgerFilePath(): string {
    return this.ledgerPath;
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
   * Tokkey's own keys to be mistaken for the user's.
   *
   * @returns whether a leftover ledger was found and reverted
   */
  recoverInterruptedSession(editors: readonly SlotEditor[]): boolean {
    if (this.active || !existsSync(this.ledgerPath)) {
      return false;
    }
    console.info(
      `[${this.label}] Restoring keys left in ${path.basename(this.filePath)} by an interrupted session.`
    );
    return this.performRestore(editors);
  }

  /**
   * Writes every slot in `writes`, recording each one's pre-takeover value the
   * first time it is touched.
   *
   * Taking over a file already taken over is a refresh: the ledger keeps the
   * `before` it already holds for a slot and only overwrites `after`, so a
   * mid-session refresh never loses track of what the very first write saw.
   *
   * @param writes the slots to set and the values to set them to
   * @param editors every slot this takeover might ever hold, used only to
   *   recover a session an earlier launch never got to restore
   * @returns whether the writes went through
   */
  activate(writes: readonly SlotWrite[], editors: readonly SlotEditor[]): boolean {
    if (this.active) {
      return this.applyWrites(writes, editors);
    }
    this.recoverInterruptedSession(editors);
    const applied = this.applyWrites(writes, editors);
    if (applied) {
      this.active = true;
    }
    return applied;
  }

  /**
   * Rewrites the slots in `writes` for state that changed mid-session, and
   * reverts every other owned slot back to its pre-takeover value.
   *
   * The revert of everything not in `writes` is what makes a refresh a true
   * "state changed" rewrite rather than an accumulating one: a slot that was
   * written by an earlier `reapply` (say, the router's model list) and is not
   * asked for this time has to disappear, not linger at its last value forever.
   *
   * A no-op when no takeover is in force: taking the file over is `activate`'s
   * decision, and a refresh should not make it for it.
   *
   * @param editors every slot this takeover might ever hold — a superset of
   *   `writes`'s ids, so anything dropped from `writes` can be found and undone
   * @returns whether the writes went through
   */
  reapply(writes: readonly SlotWrite[], editors: readonly SlotEditor[]): boolean {
    if (!this.active) {
      return false;
    }
    return this.applyWrites(writes, editors);
  }

  /**
   * Reverts every owned slot independently: back to `before` where the file
   * still holds what Tokkey last wrote, left alone where the user changed it
   * themselves. Synchronous on purpose: this runs from Electron's `will-quit`.
   *
   * @returns whether a restore was attempted
   */
  restore(editors: readonly SlotEditor[]): boolean {
    if (!this.active) {
      return false;
    }
    this.active = false;
    return this.performRestore(editors);
  }

  /**
   * Applies every write in `writes`, and reverts every other slot in `editors`
   * that an earlier call left set but this one no longer wants — the same
   * revert `restore` does for one slot, just mid-session instead of at quit.
   */
  private applyWrites(writes: readonly SlotWrite[], editors: readonly SlotEditor[]): boolean {
    try {
      let text = this.read();
      const ledger = this.loadLedger();
      const writesById = new Map(writes.map((write) => [write.id, write]));
      for (const editor of editors) {
        const write = writesById.get(editor.id);
        if (write) {
          const existing = ledger[write.id];
          const before = existing ? existing.before : write.read(text);
          text = write.write(text, write.value);
          ledger[write.id] = { before, after: write.value };
          continue;
        }
        // Not wanted this round. If an earlier call set it, undo exactly that;
        // if it was never touched, there is nothing to revert.
        const entry = ledger[editor.id];
        if (!entry) continue;
        text = entry.before === null ? editor.clear(text) : editor.write(text, entry.before);
        delete ledger[editor.id];
      }
      // The ledger goes down first, so this is a write-ahead log in fact and
      // not just in name: a crash between the two leaves a ledger describing a
      // takeover that never happened, and the restore that follows finds each
      // slot holding something other than `after` and leaves it alone. The
      // other order loses the user's own values outright.
      this.saveLedger(ledger);
      this.writeFile(text);
      return true;
    } catch (error: unknown) {
      // The CLI keeps working with whatever it already had; only the
      // convenience of routing through the gateway is lost.
      console.error(`[${this.label}] Could not write ${path.basename(this.filePath)}:`, error);
      return false;
    }
  }

  /**
   * Reverts every slot the ledger knows about, independently.
   *
   * A slot only goes back to `before` if the file still holds exactly what
   * Tokkey last wrote there (`after`) — proof nothing else has touched that
   * one key since. A slot the user changed is left as they set it and dropped
   * from the ledger for good: it is now theirs, not something to keep
   * retrying on every future restore.
   */
  private performRestore(editors: readonly SlotEditor[]): boolean {
    const ledger = this.loadLedger();
    if (Object.keys(ledger).length === 0) {
      return false;
    }
    try {
      let text = this.read();
      for (const editor of editors) {
        const entry = ledger[editor.id];
        if (!entry) continue;
        if (editor.read(text) !== entry.after) {
          console.warn(
            `[${this.label}] Left ${editor.id} in ${path.basename(this.filePath)} as it was changed while Tokkey was running.`
          );
          continue;
        }
        text = entry.before === null ? editor.clear(text) : editor.write(text, entry.before);
      }
      // Every owned slot removed and nothing else was ever in the file: the
      // file itself should go, not survive as an empty one nobody wrote.
      if (this.isEmpty(text)) {
        this.removeFile(this.filePath);
      } else {
        this.writeFile(text);
      }
      this.removeFile(this.ledgerPath);
      return true;
    } catch (error: unknown) {
      // The ledger is deliberately left in place: the next launch retries the
      // restore, which is the only path back to the user's own keys.
      console.error(`[${this.label}] Could not restore ${path.basename(this.filePath)}:`, error);
      return false;
    }
  }

  private writeFile(text: string): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, text, 'utf8');
  }

  private loadLedger(): Ledger {
    try {
      return JSON.parse(readFileSync(this.ledgerPath, 'utf8')) as Ledger;
    } catch {
      return {};
    }
  }

  private saveLedger(ledger: Ledger): void {
    mkdirSync(path.dirname(this.ledgerPath), { recursive: true });
    writeFileSync(this.ledgerPath, JSON.stringify(ledger), 'utf8');
  }

  private removeFile(filePath: string): void {
    try {
      unlinkSync(filePath);
    } catch {
      // Already gone, which is the state the caller was aiming for.
    }
  }
}

export default OwnedConfigFile;
