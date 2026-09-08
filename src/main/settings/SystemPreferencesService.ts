import { app, nativeTheme, powerSaveBlocker, shell } from 'electron';
import type {
  ClientVersionInfo,
  SystemPreferences,
  SystemPreferencesPatch,
  SystemSettingsState
} from '../../shared/types';
import SystemPreferencesStore, { DEFAULT_SYSTEM_PREFERENCES } from './SystemPreferencesStore';

/** Where the "Send Feedback" row points. */
export const FEEDBACK_MAILTO_URL = 'mailto:feedback@tokkey.app?subject=Tokkey%20feedback';

/**
 * The Electron surfaces the settings actually act on, named so tests can stand
 * in for them without an Electron runtime.
 */
export interface SystemPreferencesPlatform {
  /** True when macOS currently launches the app at sign-in. */
  isOpenAtLogin(): boolean;
  setOpenAtLogin(openAtLogin: boolean): void;
  setThemeSource(appearance: SystemPreferences['appearance']): void;
  /** Starts the "app suspension" blocker and returns its id. */
  startSleepBlocker(): number;
  stopSleepBlocker(blockerId: number): void;
  appVersion(): string;
  openExternalUrl(url: string): Promise<void>;
}

/** The real surfaces, used everywhere outside tests. */
const ELECTRON_PLATFORM: SystemPreferencesPlatform = {
  isOpenAtLogin: () => app.getLoginItemSettings().openAtLogin,
  setOpenAtLogin: (openAtLogin) => app.setLoginItemSettings({ openAtLogin }),
  setThemeSource: (appearance) => {
    nativeTheme.themeSource = appearance;
  },
  // "prevent-app-suspension" is the blocker that matches the row's promise:
  // the Mac stays awake and networked while the display is still free to sleep.
  startSleepBlocker: () => powerSaveBlocker.start('prevent-app-suspension'),
  stopSleepBlocker: (blockerId) => powerSaveBlocker.stop(blockerId),
  appVersion: () => app.getVersion(),
  openExternalUrl: (url) => shell.openExternal(url)
};

export interface SystemPreferencesServiceOptions {
  store?: SystemPreferencesStore;
  platform?: SystemPreferencesPlatform;
}

/**
 * Owns the Settings page's preferences: what is stored, and what each one does
 * to the running app.
 *
 * The stored file is the source of truth for appearance and sleep, and macOS is
 * the source of truth for the login item — the user can remove Tokkey from
 * Login Items in System Settings without the app running, so that one is read
 * back from the OS rather than trusted from disk.
 */
export class SystemPreferencesService {
  private readonly store: SystemPreferencesStore;
  private readonly platform: SystemPreferencesPlatform;
  private preferences: SystemPreferences;
  /** The live power blocker's id, or null whenever sleep is not being held off. */
  private sleepBlockerId: number | null = null;

  constructor(options: SystemPreferencesServiceOptions = {}) {
    this.store = options.store ?? new SystemPreferencesStore();
    this.platform = options.platform ?? ELECTRON_PLATFORM;
    this.preferences = { ...DEFAULT_SYSTEM_PREFERENCES };
  }

  /**
   * Re-applies the stored preferences to this session. Called once at startup,
   * because appearance and the sleep blocker are process state that dies with
   * the previous run.
   */
  restore(): SystemPreferences {
    const stored = this.store.read();
    this.preferences = { ...stored, launchAtLogin: this.readLoginItem(stored.launchAtLogin) };
    this.applyAppearance(this.preferences.appearance);
    this.applySleepBlocker(this.preferences.preventSystemSleep);
    return this.getPreferences();
  }

  /** Everything the Settings page renders in one reading. */
  getState(): SystemSettingsState {
    return {
      preferences: this.getPreferences(),
      client: this.getClientVersion()
    };
  }

  /**
   * Applies the changed settings and persists the result. Takes a patch rather
   * than the whole set so a row only ever speaks for its own switch.
   */
  update(patch: SystemPreferencesPatch): SystemSettingsState {
    const updated: SystemPreferences = { ...this.preferences, ...patch };

    if (updated.launchAtLogin !== this.preferences.launchAtLogin) {
      this.platform.setOpenAtLogin(updated.launchAtLogin);
    }
    if (updated.appearance !== this.preferences.appearance) {
      this.applyAppearance(updated.appearance);
    }
    if (updated.preventSystemSleep !== this.preferences.preventSystemSleep) {
      this.applySleepBlocker(updated.preventSystemSleep);
    }

    this.preferences = updated;
    this.store.write(updated);
    return this.getState();
  }

  /** Opens the user's mail client on the feedback address. */
  async sendFeedback(): Promise<void> {
    await this.platform.openExternalUrl(FEEDBACK_MAILTO_URL);
  }

  /** Releases the power blocker; call when the app is shutting down. */
  dispose(): void {
    this.applySleepBlocker(false);
  }

  private getPreferences(): SystemPreferences {
    return { ...this.preferences, launchAtLogin: this.readLoginItem(this.preferences.launchAtLogin) };
  }

  /**
   * The installed version and whatever newer one is known.
   *
   * `availableVersion` is always null today: Tokkey ships no update feed, so
   * claiming an update exists would be a lie the row cannot act on. It stays in
   * the shape because the design's "Version 0.9.5 is available." row is what
   * this field will fill in once there is a feed to read.
   */
  private getClientVersion(): ClientVersionInfo {
    return { installedVersion: this.platform.appVersion(), availableVersion: null };
  }

  /** The OS's answer, falling back to the stored one if it cannot be read. */
  private readLoginItem(fallback: boolean): boolean {
    try {
      return this.platform.isOpenAtLogin();
    } catch (error) {
      console.warn(`[SystemPreferences] Could not read the login item: ${String(error)}`);
      return fallback;
    }
  }

  private applyAppearance(appearance: SystemPreferences['appearance']): void {
    this.platform.setThemeSource(appearance);
  }

  /** Holds at most one blocker, so repeated calls cannot leak them. */
  private applySleepBlocker(preventSleep: boolean): void {
    if (preventSleep && this.sleepBlockerId === null) {
      this.sleepBlockerId = this.platform.startSleepBlocker();
      return;
    }
    if (!preventSleep && this.sleepBlockerId !== null) {
      this.platform.stopSleepBlocker(this.sleepBlockerId);
      this.sleepBlockerId = null;
    }
  }
}

export default SystemPreferencesService;
