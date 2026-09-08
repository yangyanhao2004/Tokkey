import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_PET_SETTINGS,
  type PetSettings,
  type PetSettingsPatch
} from '../../shared/types';

interface PetSettingsController {
  settings: PetSettings;
  isLoading: boolean;
  isSaving: boolean;
  error: string | null;
  updateSettings: (patch: PetSettingsPatch) => Promise<void>;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'Pet settings could not be updated.';
}

/** Owns renderer loading state while the main process owns persisted settings. */
export function usePetSettings(): PetSettingsController {
  const [settings, setSettings] = useState<PetSettings>(() => ({ ...DEFAULT_PET_SETTINGS }));
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;
    void window.tokkey.getPetSettings()
      .then((nextSettings) => {
        if (!isMounted) return;
        setSettings(nextSettings);
        setError(null);
      })
      .catch((loadError: unknown) => {
        if (!isMounted) return;
        setError(describeError(loadError));
      })
      .finally(() => {
        if (isMounted) setIsLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, []);

  const updateSettings = useCallback(async (patch: PetSettingsPatch) => {
    setIsSaving(true);
    setError(null);
    try {
      const nextSettings = await window.tokkey.updatePetSettings(patch);
      setSettings(nextSettings);
    } catch (updateError: unknown) {
      setError(describeError(updateError));
    } finally {
      setIsSaving(false);
    }
  }, []);

  return { settings, isLoading, isSaving, error, updateSettings };
}
