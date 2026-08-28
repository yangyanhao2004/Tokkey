import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  SkillAgent,
  SkillsShCardState,
  SkillsShInstallResult,
  SkillsShSkill
} from '../../shared/types';
import { SEARCH_MIN_LENGTH } from '../pages/discoverSkillsContent';

/**
 * How an install answers a name already taken in Tokiie's skills folder, the
 * same way the Repos tab answers it: an identical folder is reused and only its
 * agent selection is applied, and a different folder under the same name comes
 * back as a conflict for the tab to report.
 */
const INSTALL_CONFLICT_STRATEGY = 'reportConflict';

/** How long typing settles before a query is sent to skills.sh. */
const SEARCH_DEBOUNCE_MS = 350;

/** One reading of the listing: which query, at which zero-based page. */
interface SkillsShRequest {
  query: string;
  page: number;
}

export interface SkillsShListing {
  /** The page currently drawn, or `null` before the first one arrives. */
  cardStates: SkillsShCardState[] | null;
  /** Zero-based, as the service counts pages. */
  page: number;
  /** Every record the listing holds, which is what the page count is cut from. */
  total: number;
  /** True only while no page has arrived; paging keeps the old cards up. */
  isLoading: boolean;
  /** True while any page is in flight, which is what holds the pager still. */
  isFetching: boolean;
  error: string | null;
  /** True while the query is too short to search, which keeps browsing. */
  isQueryTooShort: boolean;
  goToPage: (page: number) => void;
  /**
   * Downloads the listing's source, installs it, and deploys it to exactly
   * `enabledAgents`, then re-reads the page so the cards show the result.
   * Rejects when the main process refuses, so the dialog that asked reports it.
   */
  install: (listing: SkillsShSkill, enabledAgents: SkillAgent[]) => Promise<SkillsShInstallResult>;
}

/**
 * One page of the skills.sh listing, plus what this machine already has of it.
 *
 * skills.sh holds thousands of skills, so nothing here loads the listing whole:
 * the main process fetches 200 records at a time and hands back the 20 this
 * page draws, and turning a page asks for the next slice rather than filtering
 * one long list. A query of three characters or more searches the whole
 * listing server-side; anything shorter keeps the browse listing up, since
 * the endpoint would refuse it.
 *
 * The cards' installed state is read per page rather than kept, which is what
 * makes an install visible: it re-reads the page it changed.
 */
export function useSkillsSh(query: string): SkillsShListing {
  // The query and the page it is read at move together, so committing a search
  // cannot leave a request for the page the previous listing was on.
  const [request, setRequest] = useState<SkillsShRequest>({ query: '', page: 0 });
  const [cardStates, setCardStates] = useState<SkillsShCardState[] | null>(null);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [isFetching, setIsFetching] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Bumped by an install so the page it changed is read again.
  const [reloadToken, setReloadToken] = useState(0);
  // Only the newest request may set state; an older page must not overwrite it.
  const requestIdRef = useRef(0);

  const trimmedQuery = query.trim();
  const isQueryTooShort = trimmedQuery.length > 0 && trimmedQuery.length < SEARCH_MIN_LENGTH;

  // Typing settles before anything is sent, so a query costs one request rather
  // than one per keystroke, and a new listing is read from its first page.
  useEffect(() => {
    const searchableQuery = trimmedQuery.length >= SEARCH_MIN_LENGTH ? trimmedQuery : '';
    const timer = setTimeout(() => {
      setRequest((current) =>
        current.query === searchableQuery ? current : { query: searchableQuery, page: 0 }
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [trimmedQuery]);

  useEffect(() => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setIsFetching(true);

    void (async () => {
      try {
        const result = request.query.length > 0
          ? await window.tokiie.searchSkillsPage(request.query, request.page)
          : await window.tokiie.fetchSkillsPage(request.page);
        // The listing says nothing about this machine, so what a card draws is
        // read separately — once for the whole page rather than once per card.
        const states = await window.tokiie.getSkillCardStates(result.skills);
        if (requestIdRef.current !== requestId) return;
        setCardStates(states);
        setTotal(result.total);
        setError(null);
      } catch (cause) {
        if (requestIdRef.current !== requestId) return;
        setCardStates([]);
        setTotal(0);
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (requestIdRef.current === requestId) {
          setIsLoading(false);
          setIsFetching(false);
        }
      }
    })();
  }, [request, reloadToken]);

  const goToPage = useCallback((nextPage: number) => {
    setRequest((current) => ({ ...current, page: Math.max(0, nextPage) }));
  }, []);

  const install = useCallback(
    async (listing: SkillsShSkill, enabledAgents: SkillAgent[]) => {
      const result = await window.tokiie.installSkill({
        listing,
        enabledAgents,
        conflictStrategy: INSTALL_CONFLICT_STRATEGY
      });
      // The install answers with the installed catalog, not with the listing, so
      // the page is read again rather than patched from the result.
      setReloadToken((current) => current + 1);
      return result;
    },
    []
  );

  return {
    cardStates,
    page: request.page,
    total,
    isLoading,
    isFetching,
    error,
    isQueryTooShort,
    goToPage,
    install
  };
}
