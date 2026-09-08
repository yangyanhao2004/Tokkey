import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientVersionInfo, SystemPreferencesPatch, SystemSettingsState } from '../../shared/types';

export interface SystemSettingsController {
  /** Null until the first reading arrives, which is one IPC round trip. */
  state: SystemSettingsState | null;
  /** True while a change is in flight, so no row can be clicked twice into it. */
  isSaving: boolean;
  /** Changes one or more preferences and adopts whatever actually took effect. */
  updatePreferences: (patch: SystemPreferencesPatch) => Promise<void>;
  isUpdating: boolean;
  updateError: string | null;
  performUpdateAction: () => Promise<void>;
}

/**
 * Preferences refresh after changes; updater events keep download progress live.
 *
 * The main process answers each update with the full state rather than echoing
 * the patch, so a preference macOS refused — a login item the user has blocked,
 * say — shows its real value instead of the one that was clicked.
 */
export function useSystemSettings(): SystemSettingsController {
  const [state, setState] = useState<SystemSettingsState | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const latestClient = useRef<ClientVersionInfo | null>(null);
  const updatePending = useRef(false);

  useEffect(() => {
    // Guards against a reading that resolves after unmount setting state.
    let isMounted = true;
    // Subscribe before reading so a progress event cannot be lost during the IPC round trip.
    const unsubscribe = window.tokkey.onAppUpdateStateChanged((client) => {
      latestClient.current = client;
      if (isMounted) setState((current) => current ? { ...current, client } : current);
    });

    window.tokkey
      .getSystemSettings()
      .then((settled) => {
        if (isMounted) {
          setState({ ...settled, client: latestClient.current ?? settled.client });
        }
      })
      .catch((error: unknown) => console.error('Reading system settings failed:', error));

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, []);

  const updatePreferences = useCallback(async (patch: SystemPreferencesPatch) => {
    setIsSaving(true);
    try {
      const settled = await window.tokkey.updateSystemPreferences(patch);
      setState({ ...settled, client: latestClient.current ?? settled.client });
    } catch (error) {
      console.error('Updating system preferences failed:', error);
    } finally {
      setIsSaving(false);
    }
  }, []);

  const performUpdateAction = useCallback(async () => {
    if (!state || updatePending.current) return;
    updatePending.current = true;
    setIsUpdating(true);
    setUpdateError(null);
    try {
      let client: ClientVersionInfo;
      switch (state.client.status) {
        case 'available': client = await window.tokkey.downloadAppUpdate(); break;
        case 'downloaded': client = await window.tokkey.installAppUpdate(); break;
        default: client = await window.tokkey.checkForAppUpdates(); break;
      }
      setState((current) => current ? { ...current, client: latestClient.current ?? client } : current);
    } catch (error) {
      console.error('Requesting an app update failed:', error);
      setUpdateError('Could not request the update. Please try again.');
    } finally {
      updatePending.current = false;
      setIsUpdating(false);
    }
  }, [state]);

  return { state, isSaving, updatePreferences, isUpdating, updateError, performUpdateAction };
}
