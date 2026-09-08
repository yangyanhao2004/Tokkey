import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AppearancePreference, SystemPreferences } from '../../shared/types';
import TokkeyHome from '../storage/TokkeyHome';

/** What a fresh install starts on: follow macOS, stay out of the way. */
export const DEFAULT_SYSTEM_PREFERENCES: SystemPreferences = {
  launchAtLogin: false,
  appearance: 'system',
  preventSystemSleep: false
};

const APPEARANCE_VALUES: readonly AppearancePreference[] = ['system', 'light', 'dark'];

export interface SystemPreferencesStoreOptions {
  /** Overridden by tests so a run never touches the real home directory. */
  homeDirectory?: string;
}

/**
 * Reads and writes the Settings page's preferences in
 * `~/.tokkey/settings.json`.
 *
 * A plain JSON file rather than a table in `tokkey.db`: these are three
 * scalars read once at boot and rewritten on a click, with nothing to query,
 * order, or join, so the database's schema and connection handling would buy
 * nothing. The file is also the only copy of "appearance" and "prevent sleep" —
 * macOS remembers the login item itself, but neither of those survives a quit.
 */
export class SystemPreferencesStore {
  private readonly filePath: string;

  constructor(options: SystemPreferencesStoreOptions = {}) {
    this.filePath = new TokkeyHome(options).pathFor('settings.json');
  }

  /**
   * The stored preferences, falling back to the defaults for anything missing.
   * A corrupt or unreadable file reads as "nothing stored" rather than
   * throwing: the app has to be able to open its Settings page regardless.
   */
  read(): SystemPreferences {
    try {
      const stored = JSON.parse(readFileSync(this.filePath, 'utf8')) as Record<string, unknown>;
      return {
        launchAtLogin: this.booleanValue(stored.launchAtLogin, DEFAULT_SYSTEM_PREFERENCES.launchAtLogin),
        appearance: this.appearanceValue(stored.appearance),
        preventSystemSleep: this.booleanValue(
          stored.preventSystemSleep,
          DEFAULT_SYSTEM_PREFERENCES.preventSystemSleep
        )
      };
    } catch {
      return { ...DEFAULT_SYSTEM_PREFERENCES };
    }
  }

  /** Overwrites the file with the full set, so a partial write can never half-apply. */
  write(preferences: SystemPreferences): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify(preferences, null, 2)}\n`, { mode: 0o600 });
  }

  private booleanValue(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback;
  }

  private appearanceValue(value: unknown): AppearancePreference {
    return APPEARANCE_VALUES.includes(value as AppearancePreference)
      ? (value as AppearancePreference)
      : DEFAULT_SYSTEM_PREFERENCES.appearance;
  }
}

export default SystemPreferencesStore;
