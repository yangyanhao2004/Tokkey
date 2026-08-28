import { useCallback, useMemo, useState } from 'react';
import type { SkillAgent } from '../../shared/types';
import type { AgentAvailability, CatalogNotice } from '../pages/agentHubContent';
import {
  SKILLS_SH_LOADING_TEXT,
  SKILLS_SH_SEARCH_HINT,
  SKILLS_SH_SEARCH_LABEL,
  NEXT_PAGE_LABEL,
  PREVIOUS_PAGE_LABEL,
  countSkillsShPages,
  describeSkillsShFetchFailure,
  describeSkillsShPage,
  describeEmptyDiscoverCatalog,
  describeSkillInstallAction,
  describeSkillInstallFailure,
  describeSkillInstallOutcome,
  toSkillsShEntries,
  type DiscoverTab
} from '../pages/discoverSkillsContent';
import { useSkillsSh } from '../hooks/useSkillsSh';
import { CatalogGrid, CatalogMessage } from './CatalogTabLayout';
import { DiscoverTabLayout } from './DiscoverTabLayout';
import { ManageSkillDialog } from './ManageSkillDialog';
import { PaginationBar } from './PaginationBar';

export interface SkillsShTabProps {
  availability: AgentAvailability;
  onTabChange: (tab: DiscoverTab) => void;
}

/**
 * The "skills.sh" tab (Figma 225:868): the live skills.sh listing, twenty cards
 * at a time.
 *
 * The listing runs to thousands of skills, so the page under the grid is how it
 * is read rather than one long scroll, and the search box searches the whole
 * listing server-side rather than filtering the twenty cards on screen. Both
 * go through the main process, which owns the browse and search contracts.
 *
 * A card's button opens the same Manage dialog the rest of the app uses:
 * saving a selection downloads the skill, installs it, and deploys it to
 * exactly the agents chosen — and for a skill already installed, only the
 * deployment changes. The tab is unmounted when the user switches away, which
 * is what clears its search box and its notice: both belong to this listing.
 */
export function SkillsShTab({ availability, onTabChange }: SkillsShTabProps) {
  const [query, setQuery] = useState('');
  const [managedListingId, setManagedListingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<CatalogNotice | null>(null);
  const { cardStates, page, total, isLoading, isFetching, error, isQueryTooShort, goToPage, install } =
    useSkillsSh(query);

  // Mapping a whole page is wasted work on every re-render of the tab.
  const entries = useMemo(() => toSkillsShEntries(cardStates ?? []), [cardStates]);
  // Held by id rather than by object so the dialog follows the re-read card.
  const managedCard = cardStates?.find((card) => card.listing.id === managedListingId) ?? null;
  const pageCount = countSkillsShPages(total);

  /**
   * Installs the managed listing, then reports what the main process did. Only
   * a rejection is rethrown: the dialog holds itself open for a failure it
   * caused, while an outcome it cannot act on belongs to the tab behind it.
   */
  const applyAgentSelection = useCallback(
    async (selectedAgents: SkillAgent[]) => {
      if (!managedCard) {
        return;
      }
      setNotice(null);
      try {
        const result = await install(managedCard.listing, selectedAgents);
        setNotice(
          describeSkillInstallOutcome(result, managedCard.listing.name, selectedAgents.length)
        );
      } catch (cause) {
        setNotice(
          describeSkillInstallFailure(cause instanceof Error ? cause.message : String(cause))
        );
        throw cause;
      }
    },
    [install, managedCard]
  );

  return (
    <>
      <DiscoverTabLayout
        tab="skillsSh"
        onTabChange={onTabChange}
        query={query}
        onQueryChange={setQuery}
        searchLabel={SKILLS_SH_SEARCH_LABEL}
        notice={notice}
        footer={
          !isLoading && !error && entries.length > 0 ? (
            <PaginationBar
              page={page}
              pageCount={pageCount}
              summary={describeSkillsShPage(page, entries.length, total)}
              previousLabel={PREVIOUS_PAGE_LABEL}
              nextLabel={NEXT_PAGE_LABEL}
              // A page still on its way is not one to step off of.
              disabled={isFetching}
              onPageChange={goToPage}
            />
          ) : null
        }
      >
        {isLoading && (
          <CatalogMessage testId="discover-loading">{SKILLS_SH_LOADING_TEXT}</CatalogMessage>
        )}

        {error && (
          <CatalogMessage tone="error" testId="discover-error">
            {describeSkillsShFetchFailure(error)}
          </CatalogMessage>
        )}

        {/* The endpoint refuses a shorter query, so the browse listing stays up
            and this says what is missing rather than showing an error. */}
        {isQueryTooShort && (
          <CatalogMessage testId="discover-search-hint">{SKILLS_SH_SEARCH_HINT}</CatalogMessage>
        )}

        {!isLoading && !error && entries.length === 0 && (
          <CatalogMessage testId="discover-empty">
            {describeEmptyDiscoverCatalog('skillsSh', query)}
          </CatalogMessage>
        )}

        <CatalogGrid entries={entries} availability={availability} onAction={setManagedListingId} />
      </DiscoverTabLayout>

      {managedCard && (
        <ManageSkillDialog
          name={managedCard.listing.name}
          // Null until this listing is installed, which is what opens the
          // dialog on an empty selection rather than on a reading of nothing.
          installedSkillId={managedCard.installedSkill?.id ?? null}
          applyLabel={describeSkillInstallAction(managedCard.installedSkill !== null)}
          onApply={applyAgentSelection}
          onClose={() => setManagedListingId(null)}
        />
      )}
    </>
  );
}
