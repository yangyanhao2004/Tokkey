import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  InstalledLocalModel,
  LocalModelRuntimeState
} from '../../shared/types';

const INITIAL_RUNTIME_STATE: LocalModelRuntimeState = {
  phase: 'idle',
  modelId: null,
  endpoint: null,
  error: null,
  device: null
};

/**
 * A start or remove that failed, kept beside the model it was asked of rather
 * than folded into the list-wide error: the page reports it under that one row,
 * where the button that caused it is.
 */
export interface ModelActionError {
  readonly modelId: string;
  readonly message: string;
}

export interface InstalledModels {
  models: InstalledLocalModel[] | null;
  isLoading: boolean;
  error: string | null;
  /** The last failed per-model action, or `null` once one succeeds. */
  actionError: ModelActionError | null;
  busyModelId: string | null;
  runtime: LocalModelRuntimeState;
  /** The model currently loaded in the shared local inference runtime. */
  runningModelId: string | null;
  refresh: () => void;
  start: (modelId: string) => void;
  remove: (modelId: string) => void;
}

/** Installed GGUF rows plus the single event-driven Dongle runtime state. */
export function useInstalledModels(): InstalledModels {
  const [models, setModels] = useState<InstalledLocalModel[] | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<ModelActionError | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [busyModelId, setBusyModelId] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<LocalModelRuntimeState>(INITIAL_RUNTIME_STATE);
  const [runningModelId, setRunningModelId] = useState<string | null>(null);
  const isMountedRef = useRef(true);
  const runtimeEventVersionRef = useRef(0);

  useEffect(() => {
    isMountedRef.current = true;
    const initialRuntimeVersion = runtimeEventVersionRef.current;
    const unsubscribe = window.tokkey.onLocalModelRuntimeStateChanged((next) => {
      runtimeEventVersionRef.current += 1;
      setRuntime(next);
      setRunningModelId(next.phase === 'running' ? next.modelId : null);
    });
    void Promise.all([
      window.tokkey.listInstalledLocalModels(),
      window.tokkey.getLocalModelRuntimeState()
    ]).then(([nextModels, nextRuntime]) => {
      if (!isMountedRef.current) return;
      setModels(nextModels);
      if (runtimeEventVersionRef.current === initialRuntimeVersion) {
        setRuntime(nextRuntime);
        setRunningModelId(nextRuntime.phase === 'running' ? nextRuntime.modelId : null);
      }
      setScanError(null);
    }).catch((cause) => {
      if (isMountedRef.current) {
        setScanError(cause instanceof Error ? cause.message : String(cause));
      }
    }).finally(() => {
      if (isMountedRef.current) setIsLoading(false);
    });
    return () => {
      isMountedRef.current = false;
      unsubscribe();
    };
  }, []);

  const loadSnapshot = useCallback(async () => {
    const [nextModels, runtimeState] = await Promise.all([
      window.tokkey.listInstalledLocalModels(),
      window.tokkey.getLocalChatRuntimeState()
    ]);
    return {
      models: nextModels,
      runningModelId: runtimeState.status === 'ready' ? runtimeState.model?.id ?? null : null
    };
  }, []);

  const run = useCallback(
    async (call: () => Promise<unknown>, modelId: string | null = null) => {
      setBusyModelId(modelId);
      // A fresh attempt drops whatever the last one left behind, so a retry
      // never reads as still failing.
      setActionError(null);
      try {
        await call();
        const next = await loadSnapshot();
        if (!isMountedRef.current) return;
        setModels(next.models);
        setRunningModelId(next.runningModelId);
        setScanError(null);
      } catch (cause) {
        if (!isMountedRef.current) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        // Something asked of one model is reported under it; only a failure with
        // no model behind it belongs to the list as a whole.
        if (modelId === null) setScanError(message);
        else setActionError({ modelId, message });
      } finally {
        if (isMountedRef.current) {
          setIsLoading(false);
          setBusyModelId(null);
        }
      }
    },
    [loadSnapshot]
  );

  const refresh = useCallback(() => {
    void run(async () => undefined);
  }, [run]);

  const start = useCallback(
    (modelId: string) => {
      void run(() => window.tokkey.startInstalledLocalModel(modelId), modelId);
    },
    [run]
  );

  const remove = useCallback(
    (modelId: string) => {
      void run(() => window.tokkey.removeInstalledLocalModel(modelId), modelId);
    },
    [run]
  );

  useEffect(refresh, [refresh]);

  return {
    models,
    isLoading,
    error: scanError ?? runtime.error,
    actionError,
    busyModelId,
    runtime,
    runningModelId,
    refresh,
    start,
    remove
  };
}
