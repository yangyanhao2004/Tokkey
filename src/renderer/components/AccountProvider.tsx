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

  useEffect(() => {
    let isCurrent = true;
    void window.tokkey.getAccountState()
      .then((result) => {
        if (!isCurrent) return;
        if (result.ok) {
          setState(result.value);
        } else {
          setRestoreError(result.error.message);
        }
      })
      .catch(() => {
        if (isCurrent) setRestoreError('Authentication is temporarily unavailable.');
      })
      .finally(() => {
        if (isCurrent) setIsRestoring(false);
      });
    return () => {
      isCurrent = false;
    };
  }, []);

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
    signOut
  }), [
    cancelGoogleSignIn,
    isRestoring,
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
