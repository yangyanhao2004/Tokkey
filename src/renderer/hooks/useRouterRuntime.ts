import { useCallback, useEffect, useRef, useState } from 'react';
import type { RouterRuntimeState } from '../../shared/types';

const INITIAL_STATE: RouterRuntimeState = {
  phase: 'stopped',
  port: null,
  baseUrl: null,
  dashboardUrl: null,
  error: null
};

export interface RouterRuntime {
  state: RouterRuntimeState;
  /** Whether the switch should read as on, which includes the start in progress. */
  isOn: boolean;
  /** True while a start is still polling, so the switch can refuse a second click. */
  isBusy: boolean;
  error: string | null;
  toggle: (nextOn: boolean) => void;
}

/**
 * Drives the Router page's switch from the router subprocess itself.
 *
 * The switch reflects the process rather than a click: a start that fails, or a
 * router that exits on its own, arrives here as an event and flips the switch
 * back, so the page can never claim the router is on while nothing is serving.
 */
export function useRouterRuntime(): RouterRuntime {
  const [state, setState] = useState<RouterRuntimeState>(INITIAL_STATE);
  const isMountedRef = useRef(true);
  // Counts events so a snapshot that resolves after one has landed is discarded
  // rather than overwriting fresher state.
  const eventVersionRef = useRef(0);

  useEffect(() => {
    isMountedRef.current = true;
    const initialVersion = eventVersionRef.current;
    const unsubscribe = window.tokiie.onRouterRuntimeStateChanged((next) => {
      eventVersionRef.current += 1;
      if (isMountedRef.current) setState(next);
    });
    void window.tokiie
      .getRouterRuntimeState()
      .then((snapshot) => {
        if (!isMountedRef.current) return;
        if (eventVersionRef.current === initialVersion) setState(snapshot);
      })
      .catch(() => {
        // A snapshot that cannot be read leaves the switch off, which is honest:
        // nothing was started. Any later event still corrects it.
      });
    return () => {
      isMountedRef.current = false;
      unsubscribe();
    };
  }, []);

  const toggle = useCallback((nextOn: boolean) => {
    // Both calls resolve with the resulting state, and the same state also
    // arrives as an event; applying it here keeps the switch responsive when the
    // window was not focused enough to receive the broadcast first.
    const call = nextOn ? window.tokiie.startRouterRuntime() : window.tokiie.stopRouterRuntime();
    void Promise.resolve(call).then((next) => {
      if (isMountedRef.current) setState(next);
    });
  }, []);

  return {
    state,
    isOn: state.phase === 'running' || state.phase === 'starting',
    isBusy: state.phase === 'starting',
    error: state.error,
    toggle
  };
}

export default useRouterRuntime;
