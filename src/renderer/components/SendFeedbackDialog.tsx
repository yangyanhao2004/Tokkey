import { useCallback, useEffect, useState } from 'react';
import { CANCEL_LABEL } from '../pages/agentHubContent';
import {
  FEEDBACK_FAILED_MESSAGE,
  FEEDBACK_FIELD_LABEL,
  FEEDBACK_PLACEHOLDER,
  FEEDBACK_SEND_LABEL,
  FEEDBACK_SENDING_LABEL,
  SEND_FEEDBACK_TITLE
} from '../pages/settingsContent';
import { PushButton } from './PushButton';

export interface SendFeedbackDialogProps {
  /**
   * Hands the typed message on for delivery; rejecting holds the dialog open
   * with the reason, so nothing the user wrote is lost to a failed send.
   */
  onSend: (message: string, email?: string) => Promise<void>;
  onClose: () => void;
}

/**
 * The sheet behind the Settings page's "Send Feedback" row (Figma 531:5666):
 * one message, then Cancel or Send.
 *
 * The row used to open the mail client straight away, which gave the user an
 * empty draft and no idea what Tokkey wanted. Asking here means the message is
 * composed in the app and the mail client only has to carry it.
 */
export function SendFeedbackDialog({ onSend, onClose }: SendFeedbackDialogProps) {
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [hasFailed, setHasFailed] = useState(false);

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

  // An empty note is worth nothing to read, so Send waits for something to say.
  const canSubmit = message.trim().length > 0 && !isSending;

  const submit = useCallback(async () => {
    if (!canSubmit) {
      return;
    }
    setIsSending(true);
    setHasFailed(false);
    try {
      await onSend(message.trim(), email.trim() || undefined);
      onClose();
    } catch (cause) {
      console.error('Sending feedback failed:', cause);
      setHasFailed(true);
      setIsSending(false);
    }
  }, [canSubmit, email, message, onClose, onSend]);

  return (
    // A full-window scrim: the dialog belongs to the app, not to the page under it.
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/20 p-6"
      onClick={onClose}
      data-testid="send-feedback-backdrop"
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-label={SEND_FEEDBACK_TITLE}
        // The backdrop closes on click, so the dialog must not pass its own through.
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="flex w-[480px] max-w-full flex-col overflow-hidden rounded-[12px] border-[0.829px] border-dialog-border bg-white shadow-[0px_18.245px_58.053px_0px_rgba(18,18,17,0.16)]"
        data-testid="send-feedback-dialog"
      >
        <div className="flex w-full items-center p-4">
          <h2 className="truncate text-[14px] leading-[17px] font-bold text-text-primary">
            {SEND_FEEDBACK_TITLE}
          </h2>
        </div>

        <span className="h-[0.415px] w-full shrink-0 bg-dialog-divider" />

        <div className="flex w-full flex-col gap-1.5 p-4">
          <label className="flex w-full flex-col items-start gap-1.5">
            <span className="text-[10px] leading-[12px] font-bold text-text-primary">
              {FEEDBACK_FIELD_LABEL}
            </span>
            <textarea
              // `select-text` opts back in: the body disables selection app-wide.
              className="h-[90px] w-full select-text resize-none rounded-[8px] bg-field-bg p-2 text-[10px] leading-[12px] text-text-primary outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-text-primary disabled:opacity-40 placeholder:text-field-placeholder"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder={FEEDBACK_PLACEHOLDER}
              disabled={isSending}
              autoFocus
              data-testid="send-feedback-message"
            />
          </label>
          <label className="flex w-full flex-col items-start gap-1.5">
            <span className="text-[10px] leading-[12px] font-bold text-text-primary">Email (optional)</span>
            <input
              className="h-[30px] w-full select-text rounded-[8px] bg-field-bg px-2 text-[10px] leading-[12px] text-text-primary outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-text-primary disabled:opacity-40"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
              disabled={isSending}
              data-testid="send-feedback-email"
            />
          </label>

          {hasFailed && (
            <p
              className="w-full text-[10px] leading-[12px] text-text-secondary"
              data-testid="send-feedback-error"
            >
              {FEEDBACK_FAILED_MESSAGE}
            </p>
          )}
        </div>

        <div className="flex w-full items-center justify-end gap-2 border-t-[0.415px] border-separator-hairline bg-white p-4">
          <PushButton variant="tinted" disabled={isSending} onClick={onClose} testId="send-feedback-cancel">
            {CANCEL_LABEL}
          </PushButton>
          <PushButton disabled={!canSubmit} onClick={() => void submit()} testId="send-feedback-confirm">
            {isSending ? FEEDBACK_SENDING_LABEL : FEEDBACK_SEND_LABEL}
          </PushButton>
        </div>
      </form>
    </div>
  );
}
