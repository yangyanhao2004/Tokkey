import { useState } from 'react';
import { selectCatalogEntries, type AgentAvailability } from '../pages/agentHubContent';
import {
  ADD_SKILL_LABEL,
  DIRECTORY_SEARCH_LABEL,
  SKILL_DIRECTORY_CATALOG,
  describeEmptyDiscoverCatalog,
  type DiscoverTab
} from '../pages/discoverSkillsContent';
import { CatalogGrid, CatalogMessage } from './CatalogTabLayout';
import { DiscoverTabLayout } from './DiscoverTabLayout';

export interface SkillDirectoryTabProps {
  availability: AgentAvailability;
  onTabChange: (tab: DiscoverTab) => void;
}

/**
 * The "Skill Directory" tab (Figma 225:868): the skills.sh listing. It carries
 * no action of its own beside the search box — a listing is browsed rather than
 * added to, so the only thing to press is a card's own "+ Add".
 *
 * Its entries are still fixed content, so nothing here downloads or installs.
 * The tab is unmounted when the user switches away, which is what clears its
 * search box: that belongs to the listing it filters.
 */
export function SkillDirectoryTab({ availability, onTabChange }: SkillDirectoryTabProps) {
  const [query, setQuery] = useState('');
  const entries = selectCatalogEntries(SKILL_DIRECTORY_CATALOG, query);

  return (
    <DiscoverTabLayout
      tab="skillDirectory"
      onTabChange={onTabChange}
      query={query}
      onQueryChange={setQuery}
      searchLabel={DIRECTORY_SEARCH_LABEL}
    >
      {entries.length === 0 && (
        <CatalogMessage testId="discover-empty">
          {describeEmptyDiscoverCatalog('skillDirectory', query)}
        </CatalogMessage>
      )}

      {/* No `onAction`: installing from skills.sh is not wired yet, which is
          what leaves every "+ Add" button disabled. */}
      <CatalogGrid entries={entries} availability={availability} actionLabel={ADD_SKILL_LABEL} />
    </DiscoverTabLayout>
  );
}
