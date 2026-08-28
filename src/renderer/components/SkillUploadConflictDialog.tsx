import { useEffect } from 'react';
import type { SkillUploadConflictChoice } from '../../shared/types';
import {
  UPLOAD_CONFLICT_CHOICES,
  UPLOAD_CONFLICT_EYEBROW,
  UPLOAD_CONFLICT_HINT,
  describeUploadConflict
} from '../pages/agentHubContent';
import { PushButton } from './PushButton';

/** Replace overwrites installed content, so it is drawn as the quietest answer. */
const CHOICE_VARIANTS: Record<SkillUploadConflictChoice, 'filled' | 'tinted' | 'plain-dark'> = {
  replace: 'plain-dark',
  keepBoth: 'filled',
  skip: 'tinted'
};

export interface SkillUploadConflictDialogProps {
  /** The folder name already taken inside Tokiie's skills folder. */
  folderName: string;
  /** Re-runs the held upload with the chosen strategy. */
  onChoose: (choice: SkillUploadConflictChoice) => void;
}

/**
 * The prompt an upload raises when the destination name is already taken.
 *
 * It has no Cancel: Skip *is* the answer that leaves the installed skill alone,
 * and the main process is holding the folder until one of the three arrives, so
 * every way out of this dialog sends one.
 */
export function SkillUploadConflictDialog({ folderName, onChoose }: SkillUploadConflictDialogProps) {
  // Escape means "leave it as it is", which is exactly Skip.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onChoose('skip');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onChoose]);

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/20 p-6"
      onClick={() => onChoose('skip')}
      data-testid="skill-upload-conflict-backdrop"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={describeUploadConflict(folderName)}
        onClick={(event) => event.stopPropagation()}
        className="flex w-[482px] max-w-full flex-col overflow-hidden rounded-[12px] border-[0.829px] border-dialog-border bg-white shadow-[0px_18.245px_58.053px_0px_rgba(18,18,17,0.16)]"
        data-testid="skill-upload-conflict-dialog"
      >
        <div className="flex w-full items-center gap-2.5 p-4">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-[8px] bg-fill-tile text-[16px] leading-none text-label-eyebrow">
            ✦
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-[10px] leading-[12px] text-label-eyebrow">
              {UPLOAD_CONFLICT_EYEBROW}
            </span>
            <h2 className="truncate text-[14px] leading-[17px] font-bold text-text-primary">
              {folderName}
            </h2>
          </div>
        </div>

        <span className="h-[0.415px] w-full shrink-0 bg-dialog-divider" />

        <div className="flex w-full flex-col gap-1 p-4 text-[10px] leading-[12px] text-text-primary">
          <span className="font-bold">{describeUploadConflict(folderName)}</span>
          <span className="text-text-secondary">{UPLOAD_CONFLICT_HINT}</span>
        </div>

        <div className="flex w-full items-center justify-end gap-2 border-t-[0.415px] border-separator-hairline bg-white p-4">
          {UPLOAD_CONFLICT_CHOICES.map((choice) => (
            <PushButton
              key={choice.value}
              // Keep Both takes the fill: it is the only answer that both installs
              // the chosen folder and leaves the installed one intact.
              variant={CHOICE_VARIANTS[choice.value]}
              onClick={() => onChoose(choice.value)}
              testId={`skill-upload-${choice.value}`}
            >
              {choice.label}
            </PushButton>
          ))}
        </div>
      </div>
    </div>
  );
}
