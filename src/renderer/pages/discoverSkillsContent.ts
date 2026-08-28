/**
 * Content model for the Discover Skills pane, taken from the Figma nodes "Main"
 * (198:9865) for the Repos tab and "Section" (225:868) for the Skill Directory
 * tab. Kept apart from the components so copy and catalog entries can change
 * without touching markup.
 *
 * The Repos tab reads `listCachedRepositories`, so its cards are whatever sits
 * in `~/.amis/cache/skill-repos`. The Skill Directory catalog below is still
 * fixed content: `fetchSkillsPage` exists but nothing reads it yet.
 */

import type { CachedRepository, CachedRepositorySkill, SkillInstallResult } from '../../shared/types';
import {
  MISSING_SUMMARY_TEXT,
  SAVE_LABEL,
  toCompatibilityChips,
  type CatalogEntry,
  type CatalogNotice
} from './agentHubContent';

export const PAGE_TITLE = 'Discover skills';

/**
 * Verbatim from Figma, which repeats the Agent Hub's sentence on this pane.
 * It reads oddly here — this page installs skills, not agents — but the copy is
 * the designer's to change rather than ours.
 */
export const PAGE_SUBTITLE =
  'Install the coding agents you use while Tokiie keeps local and cloud models available in the background.';

/** The two halves of the pane: cloned GitHub repos, and the skills.sh listing. */
export type DiscoverTab = 'repos' | 'skillDirectory';

export interface DiscoverTabOption {
  readonly value: DiscoverTab;
  readonly label: string;
}

export const DISCOVER_TABS: readonly DiscoverTabOption[] = [
  { value: 'repos', label: 'Repos' },
  { value: 'skillDirectory', label: 'Skill Directory' }
];

export const TAB_GROUP_LABEL = 'Browse repositories or the skill directory';
export const SEARCH_PLACEHOLDER = 'Search';
export const REPO_SEARCH_LABEL = 'Search repositories';
export const DIRECTORY_SEARCH_LABEL = 'Search the skill directory';
export const ADD_REPO_LABEL = 'Add Repo';

/** The action on a Skill Directory card, which installs rather than manages. */
export const ADD_SKILL_LABEL = '+ Add';

/** What the Manage dialog's confirming button says for a skill not installed yet. */
export const INSTALL_LABEL = 'Install';

/** Held while the first read of the repository cache is still running. */
export const REPO_SCAN_LOADING_TEXT = 'Reading downloaded repositories…';

/** Says why the grid is empty when the cache could not be read at all. */
export function describeRepositoryScanFailure(error: string): string {
  return `Could not read downloaded repositories: ${error}`;
}

/**
 * The dialog installs a card that is not installed yet and re-deploys one that
 * already is, so its button says which of the two it is about to do.
 */
export function describeRepositorySkillAction(skill: CachedRepositorySkill): string {
  return skill.isInstalled ? SAVE_LABEL : INSTALL_LABEL;
}

/** Names the agents an install was asked for, since the card cannot show none. */
function describeAgentCount(agentCount: number): string {
  if (agentCount === 0) {
    return 'no agent yet';
  }
  return agentCount === 1 ? '1 agent' : `${agentCount} agents`;
}

/**
 * What the tab says after the Manage dialog settles. A conflict is the one
 * outcome the user has to act on: a different skill already holds the name, and
 * only the upload flow can offer to replace it or keep both.
 */
export function describeRepositorySkillInstallOutcome(
  result: SkillInstallResult,
  skillName: string,
  agentCount: number
): CatalogNotice {
  const agents = describeAgentCount(agentCount);
  switch (result.status) {
    case 'installed':
    case 'replaced':
    case 'keptBoth':
      return { tone: 'neutral', message: `Installed “${skillName}” for ${agents}.` };
    case 'reused':
    case 'alreadyInstalled':
      return { tone: 'neutral', message: `“${skillName}” is installed; it now loads for ${agents}.` };
    case 'skipped':
      return { tone: 'neutral', message: `Left the installed “${skillName}” as it is.` };
    case 'conflict':
      return {
        tone: 'error',
        message: `A different skill named “${skillName}” is already installed, so nothing was changed.`
      };
  }
}

/** Reports why the skills folder was left untouched. */
export function describeRepositorySkillInstallFailure(error: string): CatalogNotice {
  return { tone: 'error', message: `Could not install that skill: ${error}` };
}

/**
 * The skills published by the repositories already cloned into Tokiie's cache
 * (Figma 198:9936), flattened into one grid: a repository is how a skill got
 * here, not a heading the design draws, so each card names its own source.
 *
 * A card's chips come from the same badges the Agent Hub reads, which is what
 * makes an already-installed skill show the green check here too.
 */
export function toRepositorySkillEntries(
  repositories: readonly CachedRepository[]
): readonly CatalogEntry[] {
  return repositories.flatMap((repository) =>
    repository.skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      source: repository.coordinate.source,
      description: skill.summary ?? MISSING_SUMMARY_TEXT,
      compatibility: toCompatibilityChips(skill.agentBadges)
    }))
  );
}

/** The skills.sh listing (Figma 225:1771). */
export const SKILL_DIRECTORY_CATALOG: readonly CatalogEntry[] = [
  {
    id: 'find-skills',
    name: 'Find-skills',
    description: 'Discover and install skills from the open agent skills ecosystem.',
    compatibility: [
      { agentId: 'claude-code', enablement: 'available' },
      { agentId: 'codex', enablement: 'available' }
    ]
  },
  {
    id: 'frontend-design',
    name: 'Frontend Design',
    description: 'Distinctive, production-grade frontend interfaces.',
    compatibility: [
      { agentId: 'claude-code', enablement: 'enabled' },
      { agentId: 'codex', enablement: 'enabled' }
    ]
  },
  {
    id: 'grill-me',
    name: 'Grill-me',
    description: 'Stress-test plans through systematic questioning.',
    compatibility: [
      { agentId: 'claude-code', enablement: 'available' },
      { agentId: 'codex', enablement: 'enabled' }
    ]
  },
  {
    id: 'vercel-react-best-practices',
    name: 'Vercel React Best Practices',
    description: 'React and Next.js performance optimization.',
    compatibility: [
      { agentId: 'claude-code', enablement: 'enabled' },
      { agentId: 'codex', enablement: 'enabled' }
    ]
  }
];

/** What each tab calls the thing it lists, so its empty line reads for it. */
const TAB_NOUNS: Readonly<Record<DiscoverTab, string>> = {
  repos: 'skill',
  skillDirectory: 'skill'
};

/**
 * What each tab says when it has nothing at all, which is a different sentence
 * from a search that matched nothing: the Repos tab is empty because no
 * repository has been downloaded, and saying so points at the way out.
 */
const TAB_NOTHING_YET: Readonly<Record<DiscoverTab, string>> = {
  repos: 'No repository has been downloaded yet.',
  skillDirectory: 'No skill is available yet.'
};

/** Stands in for the grid when the search leaves nothing to draw. */
export function describeEmptyDiscoverCatalog(tab: DiscoverTab, query: string): string {
  const trimmedQuery = query.trim();
  if (trimmedQuery.length > 0) {
    return `No ${TAB_NOUNS[tab]} matches "${trimmedQuery}".`;
  }

  return TAB_NOTHING_YET[tab];
}
