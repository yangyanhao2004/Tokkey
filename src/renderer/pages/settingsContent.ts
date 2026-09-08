/**
 * Copy and layout model for the Settings page (Figma node 531:5374). Kept
 * apart from the markup so a row can be reworded, moved between sections, or
 * added without touching the components that draw it.
 */

import type { AppearancePreference, ClientVersionInfo } from '../../shared/types';
import AppUpdatePresentation from '../../shared/AppUpdatePresentation';
import { NAV_ICON_BASE_PATH } from '../navigation';

export const ICON_BASE_PATH = NAV_ICON_BASE_PATH;

export const SETTINGS_TITLE = 'Settings';
export const SETTINGS_SUBTITLE = 'System-level preferences for your local AI workspace.';

/** Section headers, in the order the design stacks their cards. */
export const UPDATES_SECTION_TITLE = 'Updates';
export const GENERAL_SECTION_TITLE = 'General';
export const POWER_SECTION_TITLE = 'Power';
export const SUPPORT_SECTION_TITLE = 'Support';

export const CLIENT_ROW_TITLE = 'Tokkey Client';

export const LAUNCH_AT_LOGIN_TITLE = 'Launch at login';
export const LAUNCH_AT_LOGIN_DESCRIPTION = 'Start Tokkey when you sign in to macOS.';

export const APPEARANCE_TITLE = 'Appearance';
export const APPEARANCE_DESCRIPTION = 'Match macOS system appearance.';

export const PREVENT_SLEEP_TITLE = 'Prevent System Sleep';
export const PREVENT_SLEEP_DESCRIPTION =
  'Keep your Mac awake and connected to the internet while allowing the display to sleep.';

export const SEND_FEEDBACK_TITLE = 'Send Feedback';
export const SEND_FEEDBACK_DESCRIPTION = 'Tell us what you think about Tokkey.';

export const SETTINGS_LOADING_MESSAGE = 'Reading your preferences…';
export const FEEDBACK_FAILED_MESSAGE = 'Could not open your mail client.';

/** The icon fronting each row, keyed the way the row is named. */
export const ROW_ICON_FILES = {
  client: 'settings-update.svg',
  launchAtLogin: 'settings-launch.svg',
  appearance: 'settings-appearance.svg',
  preventSleep: 'settings-launch.svg',
  feedback: 'settings-feedback.svg'
} as const;

export const CHEVRON_ICON_FILE = 'settings-chevron-right.svg';

/** The appearance menu, in the order macOS lists the same three choices. */
export const APPEARANCE_OPTIONS: readonly { value: AppearancePreference; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' }
];

/** The menu label for the current choice, falling back to the stored value. */
export function appearanceLabel(appearance: AppearancePreference): string {
  return APPEARANCE_OPTIONS.find((option) => option.value === appearance)?.label ?? appearance;
}

/** The installed version and the updater's actual state. */
export function clientVersionText(client: ClientVersionInfo): string {
  return new AppUpdatePresentation(client).description;
}
