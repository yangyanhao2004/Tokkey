import { useEffect, useState } from 'react';
import type { PetRuntimeState } from '../../shared/types';

const INITIAL_PET_RUNTIME_STATE: PetRuntimeState = {
  phase: 'hidden',
  position: null,
  direction: 'right',
  size: 72,
  message: null,
  error: null,
  isPaused: false
};

/** Subscribes to the main-process Pet window without owning runtime state. */
export function usePetRuntimeState(): PetRuntimeState {
  const [runtimeState, setRuntimeState] = useState<PetRuntimeState>(INITIAL_PET_RUNTIME_STATE);

  useEffect(() => {
    let isMounted = true;
    const unsubscribe = window.tokkey.onPetRuntimeStateChanged((nextState) => {
      if (isMounted) setRuntimeState(nextState);
    });
    void window.tokkey.getPetRuntimeState()
      .then((nextState) => {
        if (isMounted) setRuntimeState(nextState);
      })
      .catch((error: unknown) => {
        // The settings page can still operate when the optional runtime snapshot
        // is unavailable; the main process reports start failures separately.
        console.error('[Pet] Could not read runtime state:', error);
      });

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, []);

  return runtimeState;
}
