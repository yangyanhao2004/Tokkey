import { useEffect, useState } from 'react';
import type { AgentInstallation } from '../../shared/types';

/**
 * Which coding agents are installed on this machine, as the main process finds
 * them on PATH.
 *
 * Detection runs once per mount rather than on a timer: it spawns a login
 * shell, and an agent appearing or disappearing is a rare, deliberate act —
 * returning to the page re-checks. `null` means nothing is known yet, which
 * callers should read as "not detected yet" rather than "not installed".
 */
export function useAgentDetection(): AgentInstallation[] | null {
  const [installations, setInstallations] = useState<AgentInstallation[] | null>(null);

  useEffect(() => {
    // Guards against a probe that resolves after unmount setting state.
    let isMounted = true;

    void (async () => {
      try {
        const detected = await window.tokiie.detectAgents();
        if (isMounted) {
          setInstallations(detected);
        }
      } catch (error) {
        console.error('Agent detection failed:', error);
      }
    })();

    return () => {
      isMounted = false;
    };
  }, []);

  return installations;
}
