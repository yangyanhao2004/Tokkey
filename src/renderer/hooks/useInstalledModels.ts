import { useCallback, useEffect, useRef, useState } from 'react';
import type { InstalledLocalModel } from '../../shared/types';

export interface InstalledModels {
  /** The last list that arrived, or `null` before the first one. */
  models: InstalledLocalModel[] | null;
  /** True only while no list has arrived yet; a refresh keeps the old rows up. */
  isLoading: boolean;
  error: string | null;
  /** The row whose removal is still running, so its buttons can be disabled. */
  busyModelId: string | null;
  refresh: () => void;
  remove: (modelId: string) => void;
}

/**
 * The models stored under `~/.amiswifi/models`, as the Tokiie page's "Installed"
 * list draws them.
 *
 * The main process answers every call with the complete list, so a removal's
 * result replaces the rows outright and there is no local copy to drift. The
 * list reloads on mount, which is also what returning from the Add Model page
 * does — that is how a finished download appears here.
 */
export function useInstalledModels(): InstalledModels {
  const [models, setModels] = useState<InstalledLocalModel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [busyModelId, setBusyModelId] = useState<string | null>(null);
  // Guards against a call that resolves after unmount setting state.
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const run = useCallback(
    async (call: () => Promise<InstalledLocalModel[]>, modelId: string | null = null) => {
      setBusyModelId(modelId);
      try {
        const next = await call();
        if (!isMountedRef.current) return;
        setModels(next);
        setError(null);
      } catch (cause) {
        if (!isMountedRef.current) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (isMountedRef.current) {
          setIsLoading(false);
          setBusyModelId(null);
        }
      }
    },
    []
  );

  const refresh = useCallback(() => {
    void run(() => window.tokiie.listInstalledLocalModels());
  }, [run]);

  const remove = useCallback(
    (modelId: string) => {
      void run(() => window.tokiie.removeInstalledLocalModel(modelId), modelId);
    },
    [run]
  );

  useEffect(refresh, [refresh]);

  return { models, isLoading, error, busyModelId, refresh, remove };
}
