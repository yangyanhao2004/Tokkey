import { useCallback, useEffect, useRef, useState } from 'react';
import type { LocalModelCatalogRequest, LocalModelCatalogScan, LocalModelRow } from '../../shared/types';
import { RECOMMENDED_LOCAL_MODEL } from '../pages/tokkeyContent';

/** Matches the catalog list's cadence, for the same reason: downloads run in
 *  the main process and report no events to the renderer. */
const DOWNLOAD_POLL_INTERVAL_MS = 1000;

/**
 * The badge needs one row, not the whole catalog, and the main process already
 * filters by name — so it projects a single artifact per scan instead of the
 * thousands the Add Model page asks for.
 */
const RECOMMENDED_REQUEST: LocalModelCatalogRequest = { query: RECOMMENDED_LOCAL_MODEL.catalogQuery };

/**
 * The two actions the catalog owns. Starting and removing act on the model's
 * copy on disk, which the installed list already manages by its own id, so those
 * go through `useInstalledModels` rather than a second path to the same files.
 */
export type RecommendedDownloadAction = 'download' | 'cancel';

export interface RecommendedModel {
  /** The catalog's view of the recommended artifact, or `null` before the first scan. */
  row: LocalModelRow | null;
  error: string | null;
  /** True while one of the badge's own actions is still running. */
  isBusy: boolean;
  refresh: () => void;
  runAction: (kind: RecommendedDownloadAction) => void;
}

/**
 * Catalog ids are derived from remote slugs, so a renamed series would stop
 * matching by id. The request already narrows the scan to this one model, so
 * its first row is a safe fallback and the badge outlives a rename.
 */
function selectRecommendedRow(scan: LocalModelCatalogScan): LocalModelRow | null {
  return scan.models.find((model) => model.id === RECOMMENDED_LOCAL_MODEL.id) ?? scan.models[0] ?? null;
}

/**
 * The recommended model's own slice of the catalog: its lifecycle, and the
 * download and cancel actions behind the badge's buttons.
 *
 * Every call answers with a complete scan, so each action's result replaces the
 * row outright and no local copy of lifecycle state can drift. The same model
 * also joins the installed list once its bytes land, which has no way to learn
 * that on its own — `onModelsChanged` is called whenever this hook changes what
 * is on disk, so the two views never disagree.
 */
export function useRecommendedModel(onModelsChanged: () => void): RecommendedModel {
  const [row, setRow] = useState<LocalModelRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  // Guards against a call that resolves after unmount setting state.
  const isMountedRef = useRef(true);
  // Held in a ref so an inline callback cannot restart the poll on every render.
  const onModelsChangedRef = useRef(onModelsChanged);

  useEffect(() => {
    onModelsChangedRef.current = onModelsChanged;
  }, [onModelsChanged]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const run = useCallback(async (call: () => Promise<LocalModelCatalogScan>, isMutation: boolean) => {
    if (isMutation) setIsBusy(true);
    try {
      const scan = await call();
      // Reported before the mount check, since what changed is the disk rather
      // than this badge's own state.
      if (isMutation) onModelsChangedRef.current();
      if (!isMountedRef.current) return;
      setRow(selectRecommendedRow(scan));
      // Per-provider failures ride along with an otherwise usable scan.
      setError(scan.failures[0] ?? null);
    } catch (cause) {
      if (!isMountedRef.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (isMountedRef.current && isMutation) setIsBusy(false);
    }
  }, []);

  const refresh = useCallback(() => {
    void run(() => window.tokkey.listLocalModels(RECOMMENDED_REQUEST), false);
  }, [run]);

  useEffect(refresh, [refresh]);

  const isDownloading = row?.lifecycle === 'downloading';

  useEffect(() => {
    if (!isDownloading) return;
    const timer = setInterval(refresh, DOWNLOAD_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [isDownloading, refresh]);

  // A transfer the poll saw finish put a new model on disk, which no action of
  // the list's own reported.
  const isDownloaded = row?.lifecycle === 'downloaded';

  useEffect(() => {
    if (isDownloaded) onModelsChangedRef.current();
  }, [isDownloaded]);

  const runAction = useCallback(
    (kind: RecommendedDownloadAction) => {
      const modelId = row?.id ?? RECOMMENDED_LOCAL_MODEL.id;
      const calls: Record<RecommendedDownloadAction, () => Promise<LocalModelCatalogScan>> = {
        download: () => window.tokkey.startLocalModelDownload(modelId, RECOMMENDED_REQUEST),
        cancel: () => window.tokkey.cancelLocalModelDownload(modelId, RECOMMENDED_REQUEST)
      };
      void run(calls[kind], true);
    },
    [row, run]
  );

  return { row, error, isBusy, refresh, runAction };
}
