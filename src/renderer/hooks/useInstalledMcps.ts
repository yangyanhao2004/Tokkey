import { useCallback, useEffect, useRef, useState } from 'react';
import type { InstalledMcp, McpAgent, McpCatalogFailure, McpCatalogScan } from '../../shared/types';

export interface InstalledMcps {
  /** The servers the last scan found, or `null` before the first one. */
  servers: InstalledMcp[] | null;
  /**
   * The agent files that could not be read. A failure is per file, so a scan
   * can carry both servers and failures: one agent's configuration being
   * malformed does not hide the other's.
   */
  failures: McpCatalogFailure[];
  /** True only while no scan has arrived yet; a refresh keeps the old cards up. */
  isLoading: boolean;
  /** Set only when the scan itself never answered, which leaves no cards at all. */
  error: string | null;
  refresh: () => void;
  /**
   * Writes one server into exactly `selectedAgents`, removing it from the rest
   * — an empty selection therefore removes it everywhere. Rejects when a
   * configuration file refuses the change, so the caller that asked for it —
   * the Manage dialog — is the one that reports the failure.
   */
  applyAgentSelection: (mcpId: string, selectedAgents: McpAgent[]) => Promise<void>;
}

/**
 * The MCP servers the main process finds in the agent configuration files, as
 * the Agent Hub's "MCPs" tab draws them.
 *
 * Like the skills scan this runs once per mount rather than on a timer: the
 * files change when a user edits them, and returning to the tab re-reads them.
 */
export function useInstalledMcps(): InstalledMcps {
  const [servers, setServers] = useState<InstalledMcp[] | null>(null);
  const [failures, setFailures] = useState<McpCatalogFailure[]>([]);
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
        const scan = await window.tokkey.scanInstalledMcps();
        if (!isMountedRef.current) return;
        setServers(scan.servers);
        setFailures(scan.failures);
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
  const mutate = useCallback(async (call: () => Promise<McpCatalogScan>) => {
    const scan = await call();
    if (isMountedRef.current) {
      setServers(scan.servers);
      setFailures(scan.failures);
      setError(null);
    }
  }, []);

  const applyAgentSelection = useCallback(
    (mcpId: string, selectedAgents: McpAgent[]) =>
      mutate(() => window.tokkey.applyMcpAgentSelection(mcpId, selectedAgents)),
    [mutate]
  );

  return { servers, failures, isLoading, error, refresh, applyAgentSelection };
}
