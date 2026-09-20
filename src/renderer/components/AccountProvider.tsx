import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from 'react';
import type {
  AccountOperationResult,
  AccountState
} from '../../shared/types';

interface AccountContextValue {
  state: AccountState;
  isRestoring: boolean;
  restoreError: string | null;
  requestEmailCode(email: string): Promise<AccountOperationResult<null>>;
  verifyEmail(email: string, code: string): Promise<AccountOperationResult<AccountState>>;
  signInWithGoogle(): Promise<AccountOperationResult<AccountState>>;
  cancelGoogleSignIn(): Promise<void>;
  signOut(): Promise<AccountOperationResult<AccountState>>;
  /** Re-reads the account and returns it, or null when the read itself failed. */
  refreshState(): Promise<AccountState | null>;
}

const SIGNED_OUT_STATE: AccountState = { status: 'signedOut', profile: null };
const AccountContext = createContext<AccountContextValue | null>(null);

/** Converts an unexpected IPC rejection to the same safe result as main-process failures. */
class AccountOperationFallback {
  static async run<T>(operation: () => Promise<AccountOperationResult<T>>): Promise<AccountOperationResult<T>> {
    try {
      return await operation();
    } catch {
      return {
        ok: false,
        error: {
          code: 'unavailable',
          message: 'Authentication is temporarily unavailable.'
        }
      };
    }
  }
}

/** Restores and owns the renderer-safe projection of the main-process account. */
export function AccountProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AccountState>(SIGNED_OUT_STATE);
  const [isRestoring, setIsRestoring] = useState(true);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  /**
   * Re-reads the main-process account. Main discards a credential whose access
   * token has expired, so this is also how a lapsed session becomes signedOut.
   */
  const refreshState = useCallback(async (): Promise<AccountState | null> => {
    const result = await AccountOperationFallback.run(() => window.tokkey.getAccountState());
    if (!result.ok) {
      setRestoreError(result.error.message);
      return null;
    }
    setState(result.value);
    setRestoreError(null);
    return result.value;
  }, []);

  useEffect(() => {
    void refreshState().finally(() => setIsRestoring(false));
  }, [refreshState]);

  const requestEmailCode = useCallback((email: string) => {
    return AccountOperationFallback.run(() => window.tokkey.requestEmailVerificationCode(email));
  }, []);

  const verifyEmail = useCallback(async (email: string, code: string) => {
    const result = await AccountOperationFallback.run(() => window.tokkey.verifyEmailSignIn(email, code));
    if (result.ok) {
      setState(result.value);
      setRestoreError(null);
    }
    return result;
  }, []);

  const signInWithGoogle = useCallback(async () => {
    const result = await AccountOperationFallback.run(() => window.tokkey.signInWithGoogle());
    if (result.ok) {
      setState(result.value);
      setRestoreError(null);
    }
    return result;
  }, []);

  const cancelGoogleSignIn = useCallback(async () => {
    await window.tokkey.cancelGoogleSignIn().catch(() => undefined);
  }, []);

  const signOut = useCallback(async () => {
    const result = await AccountOperationFallback.run(() => window.tokkey.signOutAccount());
    if (result.ok) {
      setState(result.value);
      setRestoreError(null);
    }
    return result;
  }, []);

  const value = useMemo<AccountContextValue>(() => ({
    state,
    isRestoring,
    restoreError,
    requestEmailCode,
    verifyEmail,
    signInWithGoogle,
    cancelGoogleSignIn,
    signOut,
    refreshState
  }), [
    cancelGoogleSignIn,
    isRestoring,
    refreshState,
    requestEmailCode,
    restoreError,
    signInWithGoogle,
    signOut,
    state,
    verifyEmail
  ]);

  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

/** Returns the unique renderer account projection shared by sidebar and page. */
export function useAccount(): AccountContextValue {
  const context = useContext(AccountContext);
  if (!context) throw new Error('useAccount must be used inside AccountProvider.');
  return context;
}
