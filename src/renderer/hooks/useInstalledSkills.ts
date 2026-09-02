import { useCallback, useEffect, useRef, useState } from 'react';
import type { InstalledSkill, SkillAgent } from '../../shared/types';

export interface InstalledSkills {
  /** The last scan that arrived, or `null` before the first one. */
  skills: InstalledSkill[] | null;
  /** True only while no scan has arrived yet; a refresh keeps the old cards up. */
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
  /**
   * Deploys one skill to exactly `selectedAgents`, removing it from the rest.
   * Rejects when the filesystem refuses, so the caller that asked for the
   * change — the Manage dialog — is the one that reports the failure.
   */
  applyAgentSelection: (skillId: string, selectedAgents: SkillAgent[]) => Promise<void>;
  uninstall: (skillId: string) => Promise<void>;
  /**
   * Adopts a scan another action already paid for — an upload rescans before it
   * answers, so asking the filesystem a second time would only cost a walk.
   */
  applyScan: (scanned: InstalledSkill[]) => void;
}

/**
 * The skills the main process finds under the agent roots, as the Agent Hub's
 * "Skills" tab draws them.
 *
 * The scan runs once per mount rather than on a timer: it walks the filesystem,
 * and a skill appearing is a deliberate act — returning to the page re-scans.
 */
export function useInstalledSkills(): InstalledSkills {
  const [skills, setSkills] = useState<InstalledSkill[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // Guards against a scan that resolves after unmount setting state.
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(() => {
    void (async () => {
      try {
        const scanned = await window.tokkey.getInstalledSkills();
        if (!isMountedRef.current) return;
        setSkills(scanned);
        setError(null);
      } catch (cause) {
        if (!isMountedRef.current) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (isMountedRef.current) {
          setIsLoading(false);
        }
      }
    })();
  }, []);

  useEffect(refresh, [refresh]);

  /** Every mutation answers with the whole catalog, so nothing is patched locally. */
  const mutate = useCallback(async (call: () => Promise<InstalledSkill[]>) => {
    const next = await call();
    if (isMountedRef.current) {
      setSkills(next);
      setError(null);
    }
  }, []);

  const applyAgentSelection = useCallback(
    (skillId: string, selectedAgents: SkillAgent[]) =>
      mutate(() => window.tokkey.applySkillAgentSelection(skillId, selectedAgents)),
    [mutate]
  );

  const uninstall = useCallback(
    (skillId: string) => mutate(() => window.tokkey.uninstallSkill(skillId)),
    [mutate]
  );

  const applyScan = useCallback((scanned: InstalledSkill[]) => {
    if (isMountedRef.current) {
      setSkills(scanned);
      setError(null);
    }
  }, []);

  return { skills, isLoading, error, refresh, applyAgentSelection, uninstall, applyScan };
}
