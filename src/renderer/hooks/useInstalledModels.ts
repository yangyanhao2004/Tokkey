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
      window.tokiie.getLocalModelRuntimeState()
    ]).then(([nextModels, nextRuntime]) => {
      if (!isMountedRef.current) return;
      setModels(nextModels);
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

  const refresh = useCallback(() => {
    void window.tokiie.listInstalledLocalModels().then((next) => {
      if (!isMountedRef.current) return;
      setModels(next);
      setScanError(null);
    }).catch((cause) => {
      if (isMountedRef.current) setScanError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => {
      if (isMountedRef.current) setIsLoading(false);
    });
  }, []);

  const start = useCallback((modelId: string) => {
    setRuntime((current) => ({
      ...current,
      phase: 'starting',
      modelId,
      endpoint: null,
      error: null
    }));
    void window.tokiie.startInstalledLocalModel(modelId).then((next) => {
      if (isMountedRef.current) setRuntime(next);
    }).catch(async (cause) => {
      if (!isMountedRef.current) return;
      try {
        setRuntime(await window.tokiie.getLocalModelRuntimeState());
      } catch {
        setRuntime((current) => ({
          ...current,
          phase: 'failed',
          modelId,
          endpoint: null,
          error: cause instanceof Error ? cause.message : String(cause)
        }));
      }
    });
  }, []);

  const remove = useCallback((modelId: string) => {
    setBusyModelId(modelId);
    void window.tokiie.removeInstalledLocalModel(modelId).then((next) => {
      if (!isMountedRef.current) return;
      setModels(next);
      setScanError(null);
    }).catch((cause) => {
      if (isMountedRef.current) setScanError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => {
      if (isMountedRef.current) setBusyModelId(null);
    });
  }, []);

  return {
    models,
    isLoading,
    error: scanError ?? runtime.error,
    busyModelId,
    runtime,
    refresh,
    start,
    remove
  };
}
