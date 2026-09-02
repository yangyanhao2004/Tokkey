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

export interface InstalledModels {
  models: InstalledLocalModel[] | null;
  isLoading: boolean;
  error: string | null;
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
  const [isLoading, setIsLoading] = useState(true);
  const [busyModelId, setBusyModelId] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<LocalModelRuntimeState>(INITIAL_RUNTIME_STATE);
  const [runningModelId, setRunningModelId] = useState<string | null>(null);
  const isMountedRef = useRef(true);
  const runtimeEventVersionRef = useRef(0);

  useEffect(() => {
    isMountedRef.current = true;
    const initialRuntimeVersion = runtimeEventVersionRef.current;
    const unsubscribe = window.tokiie.onLocalModelRuntimeStateChanged((next) => {
      runtimeEventVersionRef.current += 1;
      setRuntime(next);
    });
    void Promise.all([
      window.tokiie.listInstalledLocalModels(),
      window.tokiie.getLocalChatRuntimeState(),
      window.tokiie.getLocalModelRuntimeState()
    ]).then(([nextModels, chatRuntime, nextRuntime]) => {
      if (!isMountedRef.current) return;
      setModels(nextModels);
      setRunningModelId(chatRuntime.status === 'ready' ? chatRuntime.model?.id ?? null : null);
      if (runtimeEventVersionRef.current === initialRuntimeVersion) setRuntime(nextRuntime);
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
      window.tokiie.listInstalledLocalModels(),
      window.tokiie.getLocalChatRuntimeState()
    ]);
    return {
      models: nextModels,
      runningModelId: runtimeState.status === 'ready' ? runtimeState.model?.id ?? null : null
    };
  }, []);

  const run = useCallback(
    async (call: () => Promise<unknown>, modelId: string | null = null) => {
      setBusyModelId(modelId);
      try {
        await call();
        const next = await loadSnapshot();
        if (!isMountedRef.current) return;
        setModels(next.models);
        setRunningModelId(next.runningModelId);
        setScanError(null);
      } catch (cause) {
        if (!isMountedRef.current) return;
        setScanError(cause instanceof Error ? cause.message : String(cause));
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
      void run(() => window.tokiie.startInstalledLocalModel(modelId), modelId);
    },
    [run]
  );

  const remove = useCallback(
    (modelId: string) => {
      void run(() => window.tokiie.removeInstalledLocalModel(modelId), modelId);
    },
    [run]
  );

  useEffect(refresh, [refresh]);

  return {
    models,
    isLoading,
    error: scanError ?? runtime.error,
    busyModelId,
    runtime,
    runningModelId,
    refresh,
    start,
    remove
  };
}
