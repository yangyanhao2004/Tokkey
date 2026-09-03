import { useEffect } from 'react';
import { CANCEL_LABEL } from '../pages/agentHubContent';
import { PushButton } from './PushButton';

export interface ConfirmDialogProps {
  /** The question, said in one line (Figma 531:3989). */
  title: string;
  /** What happens after the answer, e.g. "You can install this later.". */
  message: string;
  /** What the confirming button says, e.g. "Uninstall". */
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** Distinguishes one confirmation's elements from another's. */
  testId: string;
}

/**
 * The small confirmation raised in front of an action that cannot be undone
 * by closing a dialog (Figma 531:3986).
 *
 * It is deliberately narrower than the dialogs it covers and carries no title
 * bar: it asks one question, and the two answers split its footer evenly so
 * neither reads as the default the pointer happens to be resting on.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  onConfirm,
  onCancel,
  testId
}: ConfirmDialogProps) {
  // Escape answers Cancel, which is the answer that changes nothing.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onCancel();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onCancel]);

  return (
    // Above the dialog that raised it, which sits at z-30.
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/20 p-6"
      // The dialog this covers closes on its own backdrop's clicks, so this one
      // must answer the question without also dismissing what raised it.
      onClick={(event) => {
        event.stopPropagation();
        onCancel();
      }}
      data-testid={`${testId}-backdrop`}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        // The backdrop cancels on click, so the dialog must not pass its own through.
        onClick={(event) => event.stopPropagation()}
        className="flex w-[240px] max-w-full flex-col overflow-hidden rounded-[16px] border-[0.829px] border-dialog-border bg-white shadow-[0px_18.245px_58.053px_0px_rgba(18,18,17,0.16)]"
        data-testid={`${testId}-dialog`}
      >
        <div className="flex w-full flex-col gap-1.5 px-4 pt-4">
          <h2 className="text-[14px] leading-[17px] font-bold text-text-primary">{title}</h2>
          <p className="text-[10px] leading-[12px] text-text-primary">{message}</p>
        </div>

        <div className="flex w-full items-center gap-2 p-4">
          <PushButton variant="tinted" stretch onClick={onCancel} testId={`${testId}-cancel`}>
            {CANCEL_LABEL}
          </PushButton>
          <PushButton stretch autoFocus onClick={onConfirm} testId={`${testId}-confirm`}>
            {confirmLabel}
          </PushButton>
        </div>
      </div>
    </div>
  );
}
