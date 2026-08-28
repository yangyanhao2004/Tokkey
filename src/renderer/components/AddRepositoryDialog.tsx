import { useCallback, useEffect, useState } from 'react';
import { CANCEL_LABEL } from '../pages/agentHubContent';
import {
  ADD_REPO_BUSY_LABEL,
  ADD_REPO_CONFIRM_LABEL,
  ADD_REPO_DIALOG_TITLE,
  BRANCH_FIELD_LABEL,
  BRANCH_PLACEHOLDER,
  REPO_URL_FIELD_LABEL,
  REPO_URL_PLACEHOLDER,
  describeRepositoryAddFailure
} from '../pages/discoverSkillsContent';
import { PushButton } from './PushButton';

interface DialogTextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  disabled: boolean;
  /** Only the field the dialog opens on takes focus. */
  autoFocus?: boolean;
  testId: string;
}

/**
 * One labelled field of the dialog: a filled box rather than the outlined one
 * the search chip uses, since it sits on the dialog's own white.
 */
function DialogTextField({
  label,
  value,
  onChange,
  placeholder,
  disabled,
  autoFocus = false,
  testId
}: DialogTextFieldProps) {
  return (
    <label className="flex w-full flex-col items-start gap-1">
      <span className="text-[10px] leading-[12px] font-bold text-text-primary">{label}</span>
      <input
        // `select-text` opts back in: the body disables selection app-wide.
        className="w-full select-text rounded-[8px] bg-field-bg p-2 text-[10px] leading-[12px] text-text-primary outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-text-primary disabled:opacity-40 placeholder:text-field-placeholder"
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        spellCheck={false}
        autoComplete="off"
        autoFocus={autoFocus}
        data-testid={testId}
      />
    </label>
  );
}

export interface AddRepositoryDialogProps {
  /**
   * Downloads the named repository into the cache; rejects when Git or the name
   * refuses, which is what holds the dialog open with the reason.
   */
  onAdd: (input: string, branch: string) => Promise<void>;
  onClose: () => void;
}

/**
 * The dialog behind the Repos tab's "Add Repo" button (Figma 225:1711): a GitHub
 * repository to download into `~/.amis/cache/skill-repos`, and the branch to
 * take it from.
 *
 * The Figma draws an "Enable for" agent row under the fields, which is left out
 * here: this downloads a repository, and which agents load a skill is asked per
 * skill by the Manage dialog once its cards appear in the grid.
 *
 * The name is not validated here. The main process parses every accepted form —
 * `owner/name`, an HTTPS URL, an SSH remote — and it is the side that has to
 * reject the rest anyway, so a rejection is reported rather than pre-empted.
 */
export function AddRepositoryDialog({ onAdd, onClose }: AddRepositoryDialogProps) {
  const [repositoryInput, setRepositoryInput] = useState('');
  const [branch, setBranch] = useState('');
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Escape closes, as every dialog on this platform does.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const canSubmit = repositoryInput.trim().length > 0 && !isBusy;

  /** Runs the download, keeping the dialog open when it fails. */
  const submit = useCallback(async () => {
    if (!canSubmit) {
      return;
    }
    setIsBusy(true);
    setError(null);
    try {
      await onAdd(repositoryInput.trim(), branch.trim());
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setIsBusy(false);
    }
  }, [branch, canSubmit, onAdd, onClose, repositoryInput]);

  return (
    // A full-window scrim: the dialog belongs to the app, not to the page under it.
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/20 p-6"
      onClick={onClose}
      data-testid="add-repository-backdrop"
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-label={ADD_REPO_DIALOG_TITLE}
        // The backdrop closes on click, so the dialog must not pass its own through.
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="flex w-[482px] max-w-full flex-col overflow-hidden rounded-[12px] border-[0.829px] border-dialog-border bg-white shadow-[0px_18.245px_58.053px_0px_rgba(18,18,17,0.16)]"
        data-testid="add-repository-dialog"
      >
        <div className="flex w-full items-center p-4">
          <h2 className="truncate text-[14px] leading-[17px] font-bold text-text-primary">
            {ADD_REPO_DIALOG_TITLE}
          </h2>
        </div>

        <span className="h-[0.415px] w-full shrink-0 bg-dialog-divider" />

        <div className="flex w-full flex-col gap-3 p-4">
          <DialogTextField
            label={REPO_URL_FIELD_LABEL}
            value={repositoryInput}
            onChange={setRepositoryInput}
            placeholder={REPO_URL_PLACEHOLDER}
            disabled={isBusy}
            autoFocus
            testId="add-repository-url"
          />

          <DialogTextField
            label={BRANCH_FIELD_LABEL}
            value={branch}
            onChange={setBranch}
            placeholder={BRANCH_PLACEHOLDER}
            disabled={isBusy}
            testId="add-repository-branch"
          />

          {error && (
            <p
              className="w-full text-[10px] leading-[12px] text-text-secondary"
              data-testid="add-repository-error"
            >
              {describeRepositoryAddFailure(error)}
            </p>
          )}
        </div>

        <div className="flex w-full items-center justify-end gap-2 border-t-[0.415px] border-separator-hairline bg-white p-4">
          <PushButton variant="tinted" disabled={isBusy} onClick={onClose} testId="add-repository-cancel">
            {CANCEL_LABEL}
          </PushButton>
          <PushButton
            disabled={!canSubmit}
            onClick={() => void submit()}
            testId="add-repository-confirm"
          >
            {isBusy ? ADD_REPO_BUSY_LABEL : ADD_REPO_CONFIRM_LABEL}
          </PushButton>
        </div>
      </form>
    </div>
  );
}
