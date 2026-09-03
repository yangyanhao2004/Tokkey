import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { SkillDetails, SkillDetailsRequest } from '../../shared/types';
import {
  CLOSE_LABEL,
  SKILL_DETAILS_DIALOG_EYEBROW,
  SKILL_DETAILS_EMPTY_TEXT,
  SKILL_DETAILS_LOADING_TEXT,
  describeSkillDetailsFailure
} from '../pages/agentHubContent';
import { PushButton } from './PushButton';
import { SkillMarkdown } from './SkillMarkdown';

export interface SkillDetailsDialogProps {
  name: string;
  request: SkillDetailsRequest;
  onClose: () => void;
}

/** Figma 531:4688: a read-only view of one catalog-verified SKILL.md. */
export function SkillDetailsDialog({ name, request, onClose }: SkillDetailsDialogProps) {
  const [details, setDetails] = useState<SkillDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const openerRef = useRef(
    document.activeElement instanceof HTMLElement ? document.activeElement : null
  );
  // Primitive identifiers prevent equivalent request objects from re-reading the file.
  const installedSkillId = request.kind === 'installed' ? request.skillId : null;
  const repositorySource = request.kind === 'repository' ? request.source : null;
  const repositoryRelativePath = request.kind === 'repository' ? request.relativePath : null;

  useEffect(() => {
    let isCurrent = true;
    setDetails(null);
    setError(null);
    const stableRequest: SkillDetailsRequest = installedSkillId
      ? { kind: 'installed', skillId: installedSkillId }
      : {
          kind: 'repository',
          source: repositorySource ?? '',
          relativePath: repositoryRelativePath ?? ''
        };
    void window.tokkey.getSkillDetails(stableRequest).then(
      (nextDetails) => {
        if (isCurrent) {
          setDetails(nextDetails);
        }
      },
      (cause: unknown) => {
        if (isCurrent) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    );
    return () => {
      isCurrent = false;
    };
  }, [installedSkillId, repositoryRelativePath, repositorySource]);

  // Escape matches the other renderer dialogs and returns focus to normal flow.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Modal focus returns to the card surface regardless of how the dialog closes.
  useEffect(() => {
    const opener = openerRef.current;
    return () => opener?.focus();
  }, []);

  /** The Close button is the dialog's only control, so Tab remains on it. */
  const keepFocusInside = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Tab') {
      event.preventDefault();
    }
  };

  const content = details?.content || SKILL_DETAILS_EMPTY_TEXT;

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/20 p-6"
      onClick={onClose}
      data-testid="skill-details-backdrop"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${name} skill details`}
        // The backdrop closes on click, so the dialog must contain its own events.
        onClick={(event) => event.stopPropagation()}
        onKeyDown={keepFocusInside}
        className="flex max-h-[calc(100vh-48px)] w-[482px] max-w-full flex-col overflow-hidden rounded-[12px] border-[0.829px] border-dialog-border bg-white shadow-[0px_18.245px_58.053px_0px_rgba(18,18,17,0.16)]"
        data-testid="skill-details-dialog"
      >
        <div className="flex w-full shrink-0 items-center gap-2.5 p-4">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-[8px] bg-fill-tile text-[16px] leading-none text-label-eyebrow">
            ✦
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-[10px] leading-[12px] text-label-eyebrow">
              {SKILL_DETAILS_DIALOG_EYEBROW}
            </span>
            <h2 className="truncate text-[14px] leading-[17px] font-bold text-text-primary">
              {name}
            </h2>
          </div>
        </div>

        <span className="h-[0.415px] w-full shrink-0 bg-dialog-divider" />

        <div className="flex min-h-0 w-full flex-col gap-3 overflow-y-auto p-4">
          {!details && !error && (
            <p
              className="text-[12px] leading-[18px] text-text-secondary"
              role="status"
              data-testid="skill-details-loading"
            >
              {SKILL_DETAILS_LOADING_TEXT}
            </p>
          )}

          {error && (
            <p
              className="text-[12px] leading-[18px] text-status-error-text"
              role="alert"
              data-testid="skill-details-error"
            >
              {describeSkillDetailsFailure(error)}
            </p>
          )}

          {details && (
            <>
              <SkillMarkdown content={content} />

              <div className="flex w-full flex-col gap-2">
                {details.locations.map((location) => (
                  <div
                    key={`${location.label}:${location.path}`}
                    className="flex min-w-0 items-start gap-2"
                    data-testid="skill-details-location"
                  >
                    <span className="shrink-0 rounded-full bg-black/11 px-1.5 py-0.5 text-[8px] leading-[10px] font-medium text-black tracking-[0.1px]">
                      {location.label}
                    </span>
                    <span
                      className="min-w-0 truncate text-[10px] leading-[12px] text-field-placeholder"
                      title={location.path}
                    >
                      {location.path}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="flex w-full shrink-0 items-center justify-end border-t-[0.415px] border-separator-hairline bg-white p-4">
          <PushButton variant="tinted" onClick={onClose} testId="skill-details-close" autoFocus>
            {CLOSE_LABEL}
          </PushButton>
        </div>
      </div>
    </div>
  );
}
