/**
 * Copy and layout model for the Settings page (Figma node 531:5374). Kept
 * apart from the markup so a row can be reworded, moved between sections, or
 * added without touching the components that draw it.
 */

import type { ClientVersionInfo } from '../../shared/types';
import AppUpdatePresentation from '../../shared/AppUpdatePresentation';
import { NAV_ICON_BASE_PATH } from '../navigation';

export const ICON_BASE_PATH = NAV_ICON_BASE_PATH;

export const SETTINGS_TITLE = 'Settings';
export const SETTINGS_SUBTITLE = 'System-level preferences for your local AI workspace.';

/** Section headers, in the order the design stacks their cards. */
export const UPDATES_SECTION_TITLE = 'Updates';
export const GENERAL_SECTION_TITLE = 'General';
export const POWER_SECTION_TITLE = 'Power';
export const PRIVACY_SECTION_TITLE = 'Privacy';
export const SUPPORT_SECTION_TITLE = 'Support';

export const CLIENT_ROW_TITLE = 'Tokkey Client';

export const LAUNCH_AT_LOGIN_TITLE = 'Launch at Login';
export const LAUNCH_AT_LOGIN_DESCRIPTION = 'Start Tokkey when you sign in to macOS.';

export const PREVENT_SLEEP_TITLE = 'Prevent System Sleep';
export const PREVENT_SLEEP_DESCRIPTION =
  'Keep your Mac awake and connected to the internet while allowing the display to sleep.';

export const PRIVACY_GATE_TITLE = 'Privacy Gate';
export const PRIVACY_GATE_DESCRIPTION =
  'Privacy Gate helps protect your private data by giving you greater control over what information is shared.';

export const SEND_FEEDBACK_TITLE = 'Send Feedback';
export const SEND_FEEDBACK_DESCRIPTION = 'Tell us what support do you need from Tokkey.';

export const SETTINGS_LOADING_MESSAGE = 'Reading your preferences…';

/** The "Send Feedback" dialog (Figma 531:5666). */
export const FEEDBACK_FIELD_LABEL = 'Feedback';
export const FEEDBACK_PLACEHOLDER = 'Share a suggestion or report an issue...';
export const FEEDBACK_EMAIL_LABEL = 'Email';
export const FEEDBACK_EMAIL_PLACEHOLDER = 'you@example.com';
export const FEEDBACK_SEND_LABEL = 'Send';
export const FEEDBACK_SENDING_LABEL = 'Sending…';
/** Shown when the send failed without the backend naming a reason. */
export const FEEDBACK_FAILED_MESSAGE = 'Could not send your feedback. Please try again.';
export const FEEDBACK_SENT_TITLE = 'Thanks for the feedback';
export const FEEDBACK_SENT_MESSAGE =
  "We're glad to hear from you. If we need more detail, we'll reply to the address you gave us.";
export const FEEDBACK_DONE_LABEL = 'Done';

/** The icon fronting each row, keyed the way the row is named. */
export const ROW_ICON_FILES = {
  client: 'settings-update.svg',
  launchAtLogin: 'settings-launch.svg',
  preventSleep: 'settings-sleep.svg',
  privacyGate: 'settings-privacy.svg',
  feedback: 'settings-feedback.svg'
} as const;

export const CHEVRON_ICON_FILE = 'settings-chevron-right.svg';

/** The installed version and the updater's actual state. */
export function clientVersionText(client: ClientVersionInfo): string {
  return new AppUpdatePresentation(client).description;
}
