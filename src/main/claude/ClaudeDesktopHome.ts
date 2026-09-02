import os from 'node:os';
import path from 'node:path';

/**
 * Locates the files Claude Desktop reads in 3p (third-party) mode.
 *
 * Claude Desktop stores its third-party inference configuration in a separate
 * app-support directory (`Claude-3p`) so it never conflicts with the standard
 * `Claude` directory the official deployment uses. The `configLibrary`
 * subdirectory holds the active inference config as two JSON files: a meta
 * index that names the applied entry, and the entry itself.
 *
 * This directory only exists on macOS. Other platforms return null from every
 * path accessor so callers can skip Desktop integration without branching.
 */
export class ClaudeDesktopHome {
  private readonly homeDirectory: string;

  constructor(options: { homeDirectory?: string } = {}) {
    this.homeDirectory = options.homeDirectory ?? os.homedir();
  }

  /**
   * The `configLibrary` directory Claude Desktop reads in 3p mode, or null
   * when the platform does not use this layout.
   */
  get configLibraryDir(): string | null {
    if (process.platform !== 'darwin') {
      return null;
    }
    return path.join(this.homeDirectory, 'Library', 'Application Support', 'Claude-3p', 'configLibrary');
  }

  /** Where the `_meta.json` backup is kept while Tokkey's takeover is in force. */
  get metaBackupPath(): string {
    return path.join(this.homeDirectory, '.amiswifi', 'desktop-config-meta-backup.json');
  }
}

export default ClaudeDesktopHome;
