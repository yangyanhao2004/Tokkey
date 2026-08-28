import { useState } from 'react';
import { selectCatalogEntries, type AgentAvailability } from '../pages/agentHubContent';
import {
  ADD_REPO_LABEL,
  ADD_SKILL_LABEL,
  REPO_CATALOG,
  REPO_SEARCH_LABEL,
  describeEmptyDiscoverCatalog,
  type DiscoverTab
} from '../pages/discoverSkillsContent';
import { CatalogGrid, CatalogMessage } from './CatalogTabLayout';
import { DiscoverTabLayout } from './DiscoverTabLayout';
import { PushButton } from './PushButton';

export interface DiscoverReposTabProps {
  availability: AgentAvailability;
  onTabChange: (tab: DiscoverTab) => void;
}

/**
 * The "Repos" tab (Figma 198:9866): the skills published by the GitHub
 * repositories cloned into Tokiie's cache, plus the button that adds another.
 *
 * Its entries are still fixed content, so nothing here clones or installs: the
 * buttons are drawn for the layout the design asks for and do nothing until the
 * main process's repository catalog backs them. The tab is unmounted when the
 * user switches away, which is what clears its search box — that belongs to the
 * listing it filters.
 */
export function DiscoverReposTab({ availability, onTabChange }: DiscoverReposTabProps) {
  const [query, setQuery] = useState('');
  const entries = selectCatalogEntries(REPO_CATALOG, query);

  return (
    <DiscoverTabLayout
      tab="repos"
      onTabChange={onTabChange}
      query={query}
      onQueryChange={setQuery}
      searchLabel={REPO_SEARCH_LABEL}
      actions={
        <PushButton variant="tinted" testId="discover-add-repo">
          {ADD_REPO_LABEL}
        </PushButton>
      }
    >
      {entries.length === 0 && (
        <CatalogMessage testId="discover-empty">
          {describeEmptyDiscoverCatalog('repos', query)}
        </CatalogMessage>
      )}

      {/* No `onAction`: installing from a repository is not wired yet, which is
          what leaves every "+ Add" button disabled. */}
      <CatalogGrid entries={entries} availability={availability} actionLabel={ADD_SKILL_LABEL} />
    </DiscoverTabLayout>
  );
}
