import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AccountState, LocalModelRuntimeState } from '../../shared/types';
import { useAccount } from '../components/AccountProvider';

/**
 * A requirement the router needs before it will start, named by what is
 * missing. Checked in this order, which is the order the user has to satisfy
 * them in: the account, then the hub key, then the model that key unlocks.
 */
export type RouterStartBlockReason = 'signedOut' | 'deviceMissing' | 'modelNotRunning';

export interface RouterStartGate {
  /** The unmet requirement from the last attempt, or null while none is. */
  blockedBy: RouterStartBlockReason | null;
  /** True while the requirements are being read, which no click may cut into. */
  isChecking: boolean;
  /** Reads every requirement and reports the first unmet one. */
  check: () => Promise<RouterStartBlockReason | null>;
  /** Drops the last block, e.g. when the switch is turned back off. */
  clear: () => void;
}

/** Reads the account fresh, since main only drops a lapsed token when asked. */
type AccountRefresh = () => Promise<AccountState | null>;

/**
 * The first requirement the router cannot meet, or null when it can start.
 *
 * Every reading is taken at the click rather than from what the page already
 * holds: the account re-read is what catches an access token that expired while
 * the window sat open, and the device can be unplugged - taking the model with
 * it - at any moment.
 */
async function readUnmetRequirement(
  refreshAccount: AccountRefresh
): Promise<RouterStartBlockReason | null> {
  // An account that cannot be read is not a session we can route with, and
  // signing in again is the one move that resolves either case.
  const account = await refreshAccount();
  if (account === null || account.status !== 'authenticated') return 'signedOut';

  // One reading answers both of the remaining requirements, since the runtime
  // that serves the local model is the one holding the device open.
  const runtime = await readLocalModelRuntime();
  if (runtime === null || runtime.device === null) return 'deviceMissing';
  // Only `running` will serve a request: a model still starting, or one that
  // failed, has nothing for the router to route to yet.
  if (runtime.phase !== 'running') return 'modelNotRunning';

  return null;
}

/** The local model runtime, or null when it cannot be asked at all. */
async function readLocalModelRuntime(): Promise<LocalModelRuntimeState | null> {
  try {
    return await window.tokkey.getLocalModelRuntimeState();
  } catch {
    // A runtime that cannot be asked cannot vouch for the device either.
    return null;
  }
}

/**
 * The checks that stand between a click on the Router switch and the router
 * actually being started: a live signed-in session, a connected Tokkey, and a
 * local model running on it.
 *
 * The page asks this before calling the runtime, so a click that cannot succeed
 * is answered with the missing requirement instead of a failed subprocess.
 */
export function useRouterStartGate(): RouterStartGate {
  const { refreshState } = useAccount();
  const [blockedBy, setBlockedBy] = useState<RouterStartBlockReason | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const check = useCallback(async () => {
    setIsChecking(true);
    try {
      const reason = await readUnmetRequirement(refreshState);
      if (isMountedRef.current) setBlockedBy(reason);
      return reason;
    } finally {
      if (isMountedRef.current) setIsChecking(false);
    }
  }, [refreshState]);

  const clear = useCallback(() => setBlockedBy(null), []);

  return useMemo(
    () => ({ blockedBy, isChecking, check, clear }),
    [blockedBy, check, clear, isChecking]
  );
}

export default useRouterStartGate;
