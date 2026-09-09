import type { FeedbackErrorCode, FeedbackOperationError } from '../../shared/types';

/**
 * What the user is told for each failure. The backend's own message is never
 * shown: it is written for the API's callers, not for the person who just
 * typed a note into a dialog.
 */
const USER_MESSAGE_BY_CODE: Record<FeedbackErrorCode, string> = {
  invalidInput: 'Check your email address and message, then try again.',
  rateLimited: 'You have sent several messages recently. Please try again later.',
  undeliverable: 'Your feedback could not be delivered right now. Please try again shortly.',
  unavailable: 'Could not reach Tokkey. Check your connection and try again.'
};

/** Internal typed error whose public projection never carries backend details. */
export default class FeedbackError extends Error {
  readonly code: FeedbackErrorCode;

  constructor(code: FeedbackErrorCode, detail?: string) {
    super(detail ?? USER_MESSAGE_BY_CODE[code]);
    this.name = 'FeedbackError';
    this.code = code;
  }

  /**
   * Maps one HTTP status to the reason the user sees.
   *
   * The backend reports every feedback failure as a non-2xx status
   * (VALIDATION_FAILED 400, FEEDBACK_RATE_LIMITED 429,
   * FEEDBACK_DELIVERY_FAILED 503, INTERNAL_ERROR 500), so the status alone
   * decides the message.
   */
  static forStatus(status: number): FeedbackError {
    if (status === 400 || status === 422) return new FeedbackError('invalidInput');
    if (status === 429) return new FeedbackError('rateLimited');
    if (status === 503) return new FeedbackError('undeliverable');
    return new FeedbackError('unavailable');
  }

  /** Converts an unknown internal failure to the stable renderer contract. */
  static publicError(error: unknown): FeedbackOperationError {
    const code = error instanceof FeedbackError ? error.code : 'unavailable';
    return { code, message: USER_MESSAGE_BY_CODE[code] };
  }
}
