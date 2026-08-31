import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LocalModelCatalogScan, LocalModelRow } from '../../shared/types';
import { filterCatalogModels, type CatalogActionKind } from '../pages/addModelContent';

/**
 * Downloads run in the main process and report no events to the renderer, so
 * an active transfer is polled. One second is fast enough for a percentage to
 * look live and slow enough that it costs nothing between transfers, when no
 * polling happens at all.
 */
const DOWNLOAD_POLL_INTERVAL_MS = 1000;

/** The "no filter" sentinel the main process already understands. */
export const ALL_PROVIDERS = 'all';

export interface LocalModelCatalog {
  /** The last scan that arrived, or `null` before the first one. */
  scan: LocalModelCatalogScan | null;
  /** The scan's rows with the search applied — what the list should draw. */
  models: LocalModelRow[];
  /** True only while no scan has arrived yet; a refresh keeps the old rows up. */
  isLoading: boolean;
  error: string | null;
  /** The row whose action is still running, so its button can be disabled. */
  busyModelId: string | null;
  provider: string;
  selectProvider: (provider: string) => void;
  /** The current search term, as typed. */
  query: string;
  search: (query: string) => void;
  refresh: () => void;
  runAction: (modelId: string, kind: CatalogActionKind) => void;
}

/**
 * The Add Model catalog: the model list, the provider filter, the name search,
 * and the download lifecycle actions behind each row.
 *
 * Every main-process call answers with a complete scan, so each action's result
 * replaces the list outright and there is no local copy of lifecycle state to
 * drift. A failed call keeps the rows already on screen and reports the reason.
 *
 * The provider filter is applied by the main process, since it decides which
 * providers to fetch at all. The search is not: the whole scan is already in
 * memory, so narrowing it here keeps every keystroke instant and costs the
 * catalog no extra round trips.
 */
export function useLocalModelCatalog(): LocalModelCatalog {
  const [scan, setScan] = useState<LocalModelCatalogScan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [busyModelId, setBusyModelId] = useState<string | null>(null);
  const [provider, setProvider] = useState<string>(ALL_PROVIDERS);
  const [query, setQuery] = useState('');
  // Guards against a call that resolves after unmount setting state.
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const run = useCallback(
    async (call: () => Promise<LocalModelCatalogScan>, modelId: string | null = null) => {
      setBusyModelId(modelId);
      try {
        const next = await call();
        if (!isMountedRef.current) return;
        setScan(next);
        // Per-provider failures ride along with an otherwise usable scan.
        setError(next.failures[0] ?? null);
      } catch (cause) {
        if (!isMountedRef.current) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (isMountedRef.current) {
          setIsLoading(false);
          setBusyModelId(null);
        }
      }
    },
    []
  );

  // Loads on mount and reloads whenever the provider filter changes.
  useEffect(() => {
    void run(() => window.tokiie.listLocalModels({ provider }));
  }, [provider, run]);

  const isDownloading = scan?.models.some((model) => model.lifecycle === 'downloading') ?? false;

  useEffect(() => {
    if (!isDownloading) return;
    const timer = setInterval(() => {
      void run(() => window.tokiie.listLocalModels({ provider }));
    }, DOWNLOAD_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [isDownloading, provider, run]);

  const refresh = useCallback(() => {
    void run(() => window.tokiie.refreshLocalModels({ provider }));
  }, [provider, run]);

  const runAction = useCallback(
    (modelId: string, kind: CatalogActionKind) => {
      // The active filter travels with the action so the answering scan comes
      // back filtered the same way the visible list is.
      const request = { provider };
      const calls: Record<CatalogActionKind, () => Promise<LocalModelCatalogScan>> = {
        download: () => window.tokiie.startLocalModelDownload(modelId, request),
        cancel: () => window.tokiie.cancelLocalModelDownload(modelId, request),
        deploy: () => window.tokiie.deployLocalModel(modelId, request),
        remove: () => window.tokiie.deleteLocalModel(modelId, request)
      };
      void run(calls[kind], modelId);
    },
    [provider, run]
  );

  // Re-filtering thousands of rows on every keystroke is a single pass over an
  // array already in memory; the memo only spares the download poll from redoing
  // it while nothing has changed.
  const models = useMemo(() => filterCatalogModels(scan?.models ?? [], query), [scan, query]);

  return {
    scan,
    models,
    isLoading,
    error,
    busyModelId,
    provider,
    selectProvider: setProvider,
    query,
    search: setQuery,
    refresh,
    runAction
  };
}
