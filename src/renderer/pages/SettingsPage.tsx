import { useState, type ReactNode } from 'react';
import {
  APPEARANCE_DESCRIPTION,
  APPEARANCE_OPTIONS,
  APPEARANCE_TITLE,
  CHEVRON_ICON_FILE,
  CLIENT_ROW_TITLE,
  FEEDBACK_FAILED_MESSAGE,
  GENERAL_SECTION_TITLE,
  ICON_BASE_PATH,
  LAUNCH_AT_LOGIN_DESCRIPTION,
  LAUNCH_AT_LOGIN_TITLE,
  POWER_SECTION_TITLE,
  PREVENT_SLEEP_DESCRIPTION,
  PREVENT_SLEEP_TITLE,
  ROW_ICON_FILES,
  SEND_FEEDBACK_DESCRIPTION,
  SEND_FEEDBACK_TITLE,
  SETTINGS_LOADING_MESSAGE,
  SETTINGS_SUBTITLE,
  SETTINGS_TITLE,
  SUPPORT_SECTION_TITLE,
  UPDATES_SECTION_TITLE,
  appearanceLabel,
  clientVersionText
} from './settingsContent';
import { useSystemSettings } from '../hooks/useSystemSettings';
import { IconTile } from '../components/IconTile';
import { PageShell, PagePlaceholder } from '../components/PageShell';
import { PopUpButton } from '../components/PopUpButton';
import { PushButton } from '../components/PushButton';
import { Switch } from '../components/Switch';
import { TitleBlock } from '../components/TitleBlock';
import type { AppearancePreference } from '../../shared/types';
import AppUpdatePresentation from '../../shared/AppUpdatePresentation';

interface SettingsSectionProps {
  /** The small-caps strip at the top of the card, e.g. "General". */
  title: string;
  children: ReactNode;
  testId: string;
}

/**
 * One titled card of the page (Figma "Section", node 531:5381). Its rows are
 * separated by hairlines drawn on the rows themselves, so a section never has
 * to know how many it holds.
 */
function SettingsSection({ title, children, testId }: SettingsSectionProps) {
  return (
    <section
      className="flex w-full shrink-0 flex-col overflow-hidden rounded-[12px] border-[0.829px] border-surface-panel-border bg-white"
      data-testid={testId}
    >
      <h2 className="flex min-h-[34.83px] w-full items-center border-b-[0.415px] border-separator-hairline px-4 py-3 text-[10px] leading-[12px] font-bold text-label-eyebrow">
        {title}
      </h2>
      <div className="flex w-full flex-col">{children}</div>
    </section>
  );
}

interface SettingsRowProps {
  /** File name of the glyph inside the row's recessed tile. */
  iconFile: string;
  title: string;
  description: string;
  /** The control at the end of the row: a switch, a menu, a button, a chevron. */
  trailing: ReactNode;
  /** Makes the whole row the control, as the "Send Feedback" row is. */
  onClick?: () => void;
  testId: string;
}

/**
 * A single preference: tile, title and description, then its control. Rendered
 * as a button when the row itself is the control, so the whole strip is one
 * target rather than only the chevron at its end.
 */
function SettingsRow({ iconFile, title, description, trailing, onClick, testId }: SettingsRowProps) {
  const layout =
    'flex min-h-[49.76px] w-full items-center justify-between gap-4 border-t-[0.415px] border-separator-hairline px-4 py-3 first:border-t-0';
  const content = (
    <>
      <span className="flex min-w-0 items-center gap-2">
        <IconTile src={`${ICON_BASE_PATH}/${iconFile}`} />
        <TitleBlock title={title} subtitle={description} wrapSubtitle />
      </span>
      {trailing}
    </>
  );

  if (!onClick) {
    return (
      <div className={layout} data-testid={testId}>
        {content}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={`${layout} text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-text-primary`}
      data-testid={testId}
    >
      {content}
    </button>
  );
}

/**
 * System-level preferences (Figma node 531:5374): the installed version, the
 * two macOS integrations, and the feedback link.
 *
 * Every switch reports the state the main process settled on rather than the
 * one that was clicked, so a preference the OS refused never shows as applied.
 */
export function SettingsPage() {
  const { state, isSaving, updatePreferences, isUpdating, updateError, performUpdateAction } = useSystemSettings();
  // Set only when opening the mail client fails, which is otherwise silent.
  const [feedbackError, setFeedbackError] = useState<string | null>(null);

  const openFeedback = async () => {
    try {
      setFeedbackError(null);
      await window.tokkey.sendFeedback();
    } catch (error) {
      console.error('Opening the feedback mail client failed:', error);
      setFeedbackError(FEEDBACK_FAILED_MESSAGE);
    }
  };

  if (!state) {
    return (
      <PageShell title={SETTINGS_TITLE} subtitle={SETTINGS_SUBTITLE} testId="settings">
        <PagePlaceholder>{SETTINGS_LOADING_MESSAGE}</PagePlaceholder>
      </PageShell>
    );
  }

  const { preferences, client } = state;
  const updatePresentation = new AppUpdatePresentation(client);

  return (
    <PageShell title={SETTINGS_TITLE} subtitle={SETTINGS_SUBTITLE} testId="settings">
      <SettingsSection title={UPDATES_SECTION_TITLE} testId="settings-updates">
        <SettingsRow
          iconFile={ROW_ICON_FILES.client}
          title={CLIENT_ROW_TITLE}
          description={updateError ?? clientVersionText(client)}
          testId="settings-client-row"
          trailing={
            <PushButton
              testId="settings-update"
              disabled={isUpdating || updatePresentation.disabled}
              onClick={() => void performUpdateAction()}
            >
              {updatePresentation.buttonLabel}
            </PushButton>
          }
        />
      </SettingsSection>

      <SettingsSection title={GENERAL_SECTION_TITLE} testId="settings-general">
        <SettingsRow
          iconFile={ROW_ICON_FILES.launchAtLogin}
          title={LAUNCH_AT_LOGIN_TITLE}
          description={LAUNCH_AT_LOGIN_DESCRIPTION}
          testId="settings-launch-row"
          trailing={
            <Switch
              checked={preferences.launchAtLogin}
              onChange={(launchAtLogin) => void updatePreferences({ launchAtLogin })}
              label={LAUNCH_AT_LOGIN_TITLE}
              disabled={isSaving}
              testId="settings-launch-toggle"
            />
          }
        />
        <SettingsRow
          iconFile={ROW_ICON_FILES.appearance}
          title={APPEARANCE_TITLE}
          description={APPEARANCE_DESCRIPTION}
          testId="settings-appearance-row"
          trailing={
            <PopUpButton
              label={appearanceLabel(preferences.appearance)}
              options={APPEARANCE_OPTIONS}
              value={preferences.appearance}
              onChange={(appearance) =>
                void updatePreferences({ appearance: appearance as AppearancePreference })
              }
              testId="settings-appearance-menu"
            />
          }
        />
      </SettingsSection>

      <SettingsSection title={POWER_SECTION_TITLE} testId="settings-power">
        <SettingsRow
          iconFile={ROW_ICON_FILES.preventSleep}
          title={PREVENT_SLEEP_TITLE}
          description={PREVENT_SLEEP_DESCRIPTION}
          testId="settings-sleep-row"
          trailing={
            <Switch
              checked={preferences.preventSystemSleep}
              onChange={(preventSystemSleep) => void updatePreferences({ preventSystemSleep })}
              label={PREVENT_SLEEP_TITLE}
              disabled={isSaving}
              testId="settings-sleep-toggle"
            />
          }
        />
      </SettingsSection>

      <SettingsSection title={SUPPORT_SECTION_TITLE} testId="settings-support">
        <SettingsRow
          iconFile={ROW_ICON_FILES.feedback}
          title={SEND_FEEDBACK_TITLE}
          description={feedbackError ?? SEND_FEEDBACK_DESCRIPTION}
          onClick={() => void openFeedback()}
          testId="settings-feedback-row"
          trailing={
            <img
              className="block size-4 shrink-0 max-w-none"
              src={`${ICON_BASE_PATH}/${CHEVRON_ICON_FILE}`}
              alt=""
            />
          }
        />
      </SettingsSection>
    </PageShell>
  );
}
