import { useCallback, useEffect, useState } from 'react';
import type { SystemPreferencesPatch, SystemSettingsState } from '../../shared/types';

export interface SystemSettingsController {
  /** Null until the first reading arrives, which is one IPC round trip. */
  state: SystemSettingsState | null;
  /** True while a change is in flight, so no row can be clicked twice into it. */
  isSaving: boolean;
  /** Changes one or more preferences and adopts whatever actually took effect. */
  updatePreferences: (patch: SystemPreferencesPatch) => Promise<void>;
}

/**
 * The Settings page's state: one reading on mount, then a settled reading after
 * every change.
 *
 * The main process answers each update with the full state rather than echoing
 * the patch, so a preference macOS refused — a login item the user has blocked,
 * say — shows its real value instead of the one that was clicked.
 */
export function useSystemSettings(): SystemSettingsController {
  const [state, setState] = useState<SystemSettingsState | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    // Guards against a reading that resolves after unmount setting state.
    let isMounted = true;

    window.tokkey
      .getSystemSettings()
      .then((settled) => {
        if (isMounted) {
          setState(settled);
        }
      })
      .catch((error: unknown) => console.error('Reading system settings failed:', error));

    return () => {
      isMounted = false;
    };
  }, []);

  const updatePreferences = useCallback(async (patch: SystemPreferencesPatch) => {
    setIsSaving(true);
    try {
      setState(await window.tokkey.updateSystemPreferences(patch));
    } catch (error) {
      console.error('Updating system preferences failed:', error);
    } finally {
      setIsSaving(false);
    }
  }, []);

  return { state, isSaving, updatePreferences };
}
