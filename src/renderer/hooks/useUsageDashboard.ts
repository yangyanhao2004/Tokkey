import { useCallback, useEffect, useRef, useState } from 'react';
import type { UsageCostTotals, UsageQueryRecord } from '../../shared/types';

/** What the Dashboard draws, and what it can do to the listing under it. */
export interface UsageDashboard {
  /** Every query read so far, newest first. Empty before the first batch. */
  queries: readonly UsageQueryRecord[];
  totals: UsageCostTotals | null;
  /** True only while no batch has arrived; loading more keeps the rows up. */
  isLoading: boolean;
  /** True while a further batch is in flight, which is what dims the button. */
  isLoadingMore: boolean;
  /** Whether history continues past the last row drawn. */
  hasMore: boolean;
  error: string | null;
  loadMore: () => void;
}

const READ_FAILED_MESSAGE = 'Usage history could not be read.';

/**
 * The Dashboard's reading of what the router has recorded: the recent queries,
 * plus the token totals over all of them.
 *
 * The listing grows for as long as the router runs, so it is read forward in
 * batches and appended to rather than drawn whole. Rows already on screen stay
 * there when the next batch arrives, so the list never blinks through an empty
 * state and never renumbers itself under the reader.
 */
export function useUsageDashboard(): UsageDashboard {
  const [queries, setQueries] = useState<readonly UsageQueryRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [totals, setTotals] = useState<UsageCostTotals | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // One read at a time: "Load more" pressed twice would otherwise ask for the
  // same cursor twice and append the same twenty rows.
  const isReading = useRef(false);
  // Set inside the effect rather than at declaration, so a remount restores it.
  const isMounted = useRef(true);

  const appendBatch = useCallback(async (cursor: string | null) => {
    if (isReading.current) return;
    isReading.current = true;
    if (cursor !== null) setIsLoadingMore(true);

    try {
      const batch = await window.tokkey.readUsageQueryWindow(cursor);
      if (!isMounted.current) return;
      // The first read replaces; every later one adds to what is already drawn.
      setQueries((drawn) => (cursor === null ? batch.queries : [...drawn, ...batch.queries]));
      setNextCursor(batch.nextCursor);
      setError(null);
    } catch (readError) {
      console.error('Usage history read failed:', readError);
      if (isMounted.current) setError(READ_FAILED_MESSAGE);
    } finally {
      isReading.current = false;
      if (isMounted.current) {
        setIsLoading(false);
        setIsLoadingMore(false);
      }
    }
  }, []);

  useEffect(() => {
    isMounted.current = true;
    void appendBatch(null);
    // Independent of the listing, so the totals do not wait on its join.
    window.tokkey.readUsageCostTotals().then(
      (tokenTotals) => {
        if (isMounted.current) setTotals(tokenTotals);
      },
      (readError) => console.error('Usage totals read failed:', readError)
    );

    return () => {
      isMounted.current = false;
    };
  }, [appendBatch]);

  const loadMore = useCallback(() => {
    if (nextCursor !== null) void appendBatch(nextCursor);
  }, [appendBatch, nextCursor]);

  return {
    queries,
    totals,
    isLoading,
    isLoadingMore,
    hasMore: nextCursor !== null,
    error,
    loadMore
  };
}
