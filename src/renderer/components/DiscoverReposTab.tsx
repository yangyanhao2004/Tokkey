import { useCallback, useMemo, useState } from 'react';
import type { SkillAgent } from '../../shared/types';
import {
  selectCatalogEntries,
  type AgentAvailability,
  type CatalogNotice
} from '../pages/agentHubContent';
import {
  ADD_REPO_LABEL,
  REPO_SCAN_LOADING_TEXT,
  REPO_SEARCH_LABEL,
  describeEmptyDiscoverCatalog,
  describeRepositoryScanFailure,
  describeRepositorySkillAction,
  describeRepositorySkillInstallFailure,
  describeRepositorySkillInstallOutcome,
  toRepositorySkillEntries,
  type DiscoverTab
} from '../pages/discoverSkillsContent';
import { useCachedRepositories } from '../hooks/useCachedRepositories';
import { CatalogGrid, CatalogMessage } from './CatalogTabLayout';
import { DiscoverTabLayout } from './DiscoverTabLayout';
import { ManageSkillDialog } from './ManageSkillDialog';
import { PushButton } from './PushButton';

export interface DiscoverReposTabProps {
  availability: AgentAvailability;
  onTabChange: (tab: DiscoverTab) => void;
}

/**
 * The "Repos" tab (Figma 198:9866): every skill published by the GitHub
 * repositories already cloned into Tokiie's cache, plus the button that adds
 * another.
 *
 * The cards are a reading of the cache rather than a list the page keeps, so a
 * chip carries the green check exactly when that agent can already load the
 * skill — the same badges the Agent Hub draws, since a skill installed from
 * here is the same skill there. "Manage" opens the Agent Hub's own dialog: for
 * a card nothing has installed yet, saving a selection is what installs it.
 *
 * Adding a repository is not wired yet, which is what leaves "Add Repo"
 * disabled. The tab is unmounted when the user switches away, which is also
 * what clears an install notice: it belongs to the tab that raised it.
 */
export function DiscoverReposTab({ availability, onTabChange }: DiscoverReposTabProps) {
  const [query, setQuery] = useState('');
  const [managedSkillId, setManagedSkillId] = useState<string | null>(null);
  const [notice, setNotice] = useState<CatalogNotice | null>(null);
  const { repositories, isLoading, error, installSkill } = useCachedRepositories();

  // Mapping a whole scan is wasted work on every keystroke of the search box.
  const skills = useMemo(
    () => (repositories ?? []).flatMap((repository) => repository.skills),
    [repositories]
  );
  const skillEntries = useMemo(() => toRepositorySkillEntries(repositories ?? []), [repositories]);
  const entries = selectCatalogEntries(skillEntries, query);
  // Held by id rather than by object so the dialog follows the rescanned card.
  const managedSkill = skills.find((skill) => skill.id === managedSkillId) ?? null;

  /**
   * Installs the managed card, then reports what the main process did. Only a
   * rejection is rethrown: the dialog holds itself open for a failure it caused,
   * while an outcome it cannot act on belongs to the tab behind it.
   */
  const applyAgentSelection = useCallback(
    async (selectedAgents: SkillAgent[]) => {
      if (!managedSkill) {
        return;
      }
      setNotice(null);
      try {
        const result = await installSkill(managedSkill, selectedAgents);
        setNotice(
          describeRepositorySkillInstallOutcome(result, managedSkill.name, selectedAgents.length)
        );
      } catch (cause) {
        setNotice(
          describeRepositorySkillInstallFailure(
            cause instanceof Error ? cause.message : String(cause)
          )
        );
        throw cause;
      }
    },
    [installSkill, managedSkill]
  );

  return (
    <>
      <DiscoverTabLayout
        tab="repos"
        onTabChange={onTabChange}
        query={query}
        onQueryChange={setQuery}
        searchLabel={REPO_SEARCH_LABEL}
        notice={notice}
        actions={
          <PushButton variant="tinted" testId="discover-add-repo">
            {ADD_REPO_LABEL}
          </PushButton>
        }
      >
        {isLoading && (
          <CatalogMessage testId="discover-loading">{REPO_SCAN_LOADING_TEXT}</CatalogMessage>
        )}

        {error && (
          <CatalogMessage tone="error" testId="discover-error">
            {describeRepositoryScanFailure(error)}
          </CatalogMessage>
        )}

        {!isLoading && !error && entries.length === 0 && (
          <CatalogMessage testId="discover-empty">
            {describeEmptyDiscoverCatalog('repos', query)}
          </CatalogMessage>
        )}

        <CatalogGrid entries={entries} availability={availability} onAction={setManagedSkillId} />
      </DiscoverTabLayout>

      {managedSkill && (
        <ManageSkillDialog
          name={managedSkill.name}
          // Null until this card is installed, which is what opens the dialog
          // on an empty selection rather than on a reading of nothing.
          installedSkillId={managedSkill.installedSkillId}
          applyLabel={describeRepositorySkillAction(managedSkill)}
          onApply={applyAgentSelection}
          onClose={() => setManagedSkillId(null)}
        />
      )}
    </>
  );
}
