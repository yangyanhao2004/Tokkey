import type { SkillAgent } from '../../shared/types';
import {
  MANAGE_SKILL_DIALOG_EYEBROW,
  UNINSTALL_SKILL_CONFIRM_MESSAGE,
  UNINSTALL_SKILL_CONFIRM_TITLE
} from '../pages/agentHubContent';
import { useSkillAgentSelection } from '../hooks/useSkillAgentSelection';
import { ManageAgentsDialog } from './ManageAgentsDialog';

export interface ManageSkillDialogProps {
  /** The skill's name, which is what the dialog is titled after. */
  name: string;
  /**
   * The installed skill whose deployment the boxes open on, or `null` for a
   * skill nothing has installed yet — a repository card, which opens empty.
   */
  installedSkillId: string | null;
  /** Deploys the skill to exactly these agents; rejects when the filesystem refuses. */
  onApply: (selectedAgents: SkillAgent[]) => Promise<void>;
  /** Omitted when there is nothing installed to remove, which hides the button. */
  onUninstall?: () => Promise<void>;
  onClose: () => void;
  /** What the confirming button says; installing from a repository says "Install". */
  applyLabel?: string;
}

/**
 * "Manage Skill": which agents load the skill, saved as one selection.
 *
 * The selection is read back from the filesystem rather than from the card's
 * badges, so what the boxes show is what the deployer will diff against. A
 * repository card has nothing installed to read, so it opens on an empty
 * selection and its Save becomes the install — one dialog either way, since
 * "which agents load this skill" is the same question both times.
 *
 * Uninstall deletes the skill's folder, so it is the one button here that asks
 * before it acts; the wording of that question is this dialog's to supply,
 * since the generic manage dialog does not know a skill from an MCP.
 */
export function ManageSkillDialog({
  name,
  installedSkillId,
  onApply,
  onUninstall,
  onClose,
  applyLabel
}: ManageSkillDialogProps) {
  const { selectedAgents, error } = useSkillAgentSelection(installedSkillId);

  return (
    <ManageAgentsDialog
      eyebrow={MANAGE_SKILL_DIALOG_EYEBROW}
      name={name}
      currentAgents={selectedAgents}
      readError={error}
      onApply={onApply}
      onUninstall={onUninstall}
      uninstallConfirm={{
        title: UNINSTALL_SKILL_CONFIRM_TITLE,
        message: UNINSTALL_SKILL_CONFIRM_MESSAGE
      }}
      onClose={onClose}
      applyLabel={applyLabel}
      testId="manage-skill"
    />
  );
}
