import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react';
import type { AgentInstallation } from '../../shared/types';
import { readAgentAvailability, type AgentAvailability } from '../pages/agentHubContent';

interface AgentDetectionValue {
  availability: AgentAvailability;
  /** Re-probes PATH, for a page that is being opened again. */
  refresh: () => void;
}

/**
 * Null until a provider supplies the detection, which is what lets the hooks
 * below fail loudly rather than silently reporting every agent as missing.
 */
const AgentDetectionContext = createContext<AgentDetectionValue | null>(null);

/**
 * One agent detection for the whole window.
 *
 * Which agents are on PATH is read by the agent cards, every catalog chip, and
 * both Manage dialogs — four levels apart in three different pages — so it is
 * held here rather than threaded through all of them. Holding it in one place
 * is also what stops two pages from each probing PATH for their own copy.
 *
 * Detection spawns a login shell, so it runs on mount and then only when a page
 * asks: an agent appearing or disappearing is a rare, deliberate act.
 */
export function AgentDetectionProvider({ children }: { children: ReactNode }) {
  const [installations, setInstallations] = useState<AgentInstallation[] | null>(null);
  // Guards against a probe that resolves after unmount setting state.
  const isMountedRef = useRef(true);

  const detect = useCallback(async (): Promise<void> => {
    try {
      const detected = await window.tokiie.detectAgents();
      if (isMountedRef.current) {
        setInstallations(detected);
      }
    } catch (error) {
      console.error('Agent detection failed:', error);
    }
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    void detect();
    return () => {
      isMountedRef.current = false;
    };
  }, [detect]);

  const value = useMemo<AgentDetectionValue>(
    () => ({
      availability: readAgentAvailability(installations),
      refresh: () => void detect()
    }),
    [installations, detect]
  );

  return <AgentDetectionContext.Provider value={value}>{children}</AgentDetectionContext.Provider>;
}

/** Reads the context, naming the missing provider rather than failing later. */
function useAgentDetectionContext(): AgentDetectionValue {
  const value = useContext(AgentDetectionContext);
  if (!value) {
    throw new Error('Agent detection is only available inside an AgentDetectionProvider.');
  }
  return value;
}

/**
 * Which agents are installed, or `null` while detection is still running.
 * Callers should read `null` as "not detected yet" rather than "not installed".
 */
export function useAgentAvailability(): AgentAvailability {
  return useAgentDetectionContext().availability;
}

/**
 * Re-probes PATH. A page calls this when it opens, so an agent installed from
 * a terminal while the app was running shows up on the user's next visit.
 */
export function useAgentDetectionRefresh(): () => void {
  return useAgentDetectionContext().refresh;
}
