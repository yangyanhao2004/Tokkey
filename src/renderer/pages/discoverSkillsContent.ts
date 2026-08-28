/**
 * Content model for the Discover Skills pane, taken from the Figma nodes "Main"
 * (198:9865) for the Repos tab and "Section" (225:868) for the Skill Directory
 * tab. Kept apart from the components so copy and catalog entries can change
 * without touching markup.
 *
 * Both catalogs below are still fixed content. The main process already exposes
 * `listCachedRepositories` and `fetchSkillsPage`, but this pane is UI only, so
 * nothing here reads them yet; the entries are shaped like every other catalog
 * entry so wiring them later replaces the constants and nothing else.
 */

import type { CatalogEntry } from './agentHubContent';

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

/** The action on every discover card, which installs rather than manages. */
export const ADD_SKILL_LABEL = '+ Add';

/**
 * The skills published by the repositories already cloned into Tokiie's cache
 * (Figma 198:9936).
 */
export const REPO_CATALOG: readonly CatalogEntry[] = [
  {
    id: '21risk-automation',
    name: '-21risk-automation',
    description: 'Turn product descriptions into structured Figma screens.',
    compatibility: [
      { agentId: 'claude-code', enablement: 'available' },
      { agentId: 'codex', enablement: 'enabled' }
    ]
  },
  {
    id: '2chat-automation',
    name: '-2chat-automation',
    description: 'Turn commit history into clear, customer-ready release notes.',
    compatibility: [
      { agentId: 'claude-code', enablement: 'enabled' },
      { agentId: 'codex', enablement: 'enabled' }
    ]
  },
  {
    id: 'ably-automation',
    name: 'ably-automation',
    description: 'Summarize customer context into a support-ready brief.',
    compatibility: [
      { agentId: 'claude-code', enablement: 'available' },
      { agentId: 'codex', enablement: 'enabled' }
    ]
  },
  {
    id: 'abstract-automation',
    name: 'abstract-automation',
    description: 'Check environment, tests, and dependencies before release.',
    compatibility: [
      { agentId: 'claude-code', enablement: 'enabled' },
      { agentId: 'codex', enablement: 'enabled' }
    ]
  }
];

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
  repos: 'repository',
  skillDirectory: 'skill'
};

/** Stands in for the grid when the search leaves nothing to draw. */
export function describeEmptyDiscoverCatalog(tab: DiscoverTab, query: string): string {
  const noun = TAB_NOUNS[tab];
  const trimmedQuery = query.trim();
  if (trimmedQuery.length > 0) {
    return `No ${noun} matches "${trimmedQuery}".`;
  }

  return `No ${noun} is available yet.`;
}
