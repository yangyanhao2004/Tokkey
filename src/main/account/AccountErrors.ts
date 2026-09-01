import type { AccountErrorCode, AccountOperationError } from '../../shared/types';

const USER_MESSAGE_BY_CODE: Record<AccountErrorCode, string> = {
  invalidEmail: 'Enter a valid email address.',
  invalidCode: 'Enter the six-digit verification code.',
  rejected: 'The sign-in request was rejected.',
  unavailable: 'Authentication is temporarily unavailable.',
  invalidResponse: 'The authentication response was invalid.'
};

/** Internal typed error whose public projection never contains backend details. */
export default class AccountError extends Error {
  readonly code: AccountErrorCode;

  constructor(code: AccountErrorCode) {
    super(USER_MESSAGE_BY_CODE[code]);
    this.name = 'AccountError';
    this.code = code;
  }

  /** Converts an unknown internal failure to the stable renderer contract. */
  static publicError(error: unknown): AccountOperationError {
    const accountError = error instanceof AccountError ? error : new AccountError('unavailable');
    return {
      code: accountError.code,
      message: USER_MESSAGE_BY_CODE[accountError.code]
    };
  }
}
