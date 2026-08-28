/**
 * Content model for the Discover Skills pane, taken from the Figma nodes "Main"
 * (198:9865) for the Repos tab and "Section" (225:868) for the skills.sh
 * tab. Kept apart from the components so copy and catalog entries can change
 * without touching markup.
 *
 * The Repos tab reads `listCachedRepositories`, so its cards are whatever sits
 * in `~/.amis/cache/skill-repos`. The skills.sh tab reads the live listing one
 * page at a time, so its cards are whatever the service published.
 */

import {
  SKILLS_SH_PAGE_SIZE,
  type CachedRepository,
  type CachedRepositorySkill,
  type RepositorySyncResult,
  type SkillInstallResult,
  type SkillsShCardState
} from '../../shared/types';
import {
  MANAGE_LABEL,
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
export type DiscoverTab = 'repos' | 'skillsSh';

export interface DiscoverTabOption {
  readonly value: DiscoverTab;
  readonly label: string;
}

export const DISCOVER_TABS: readonly DiscoverTabOption[] = [
  { value: 'repos', label: 'Repos' },
  { value: 'skillsSh', label: 'skills.sh' }
];

export const TAB_GROUP_LABEL = 'Browse repositories or skills.sh';
export const SEARCH_PLACEHOLDER = 'Search';
export const REPO_SEARCH_LABEL = 'Search repositories';
export const SKILLS_SH_SEARCH_LABEL = 'Search skills.sh';
export const ADD_REPO_LABEL = 'Add Repo';

/** The action on a skills.sh card, which installs rather than manages. */
export const ADD_SKILL_LABEL = '+ Add';

/** What the Manage dialog's confirming button says for a skill not installed yet. */
export const INSTALL_LABEL = 'Install';

/** Held while the first read of the repository cache is still running. */
export const REPO_SCAN_LOADING_TEXT = 'Reading downloaded repositories…';

/**
 * The Add Repository dialog (Figma 225:1711). The design draws an "Enable for"
 * agent row under the two fields, which this dialog leaves out: adding a
 * repository downloads it into the cache, and choosing which agents load a skill
 * is the Manage dialog's question, asked per skill rather than per repository.
 */
export const ADD_REPO_DIALOG_TITLE = 'Add SKILL repository';
export const REPO_URL_FIELD_LABEL = 'Repository URL';
export const REPO_URL_PLACEHOLDER = 'owner/name or https://github.com/owner/name';
export const BRANCH_FIELD_LABEL = 'Branch';
/** The branch left empty clones the repository's default, so this is a hint. */
export const BRANCH_PLACEHOLDER = 'main';
export const ADD_REPO_CONFIRM_LABEL = 'Add Repository';

/** Held on the confirming button while Git is still cloning or fetching. */
export const ADD_REPO_BUSY_LABEL = 'Downloading…';

/** Says why the grid is empty when the cache could not be read at all. */
export function describeRepositoryScanFailure(error: string): string {
  return `Could not read downloaded repositories: ${error}`;
}

/**
 * What the tab says after a download settles. The main process already words
 * the outcome — it is the only side that knows whether the checkout was cloned
 * or refreshed and how many skills that added — so this only gives it a tone.
 */
export function describeRepositoryAddOutcome(result: RepositorySyncResult): CatalogNotice {
  return { tone: 'neutral', message: result.notice };
}

/**
 * Reports why nothing was downloaded, e.g. a name GitHub has no repository for,
 * a branch that does not exist, or a machine that is offline. The dialog shows
 * this line while it holds itself open, and the tab repeats it once the dialog
 * is gone, so both say the same sentence.
 */
export function describeRepositoryAddFailure(error: string): string {
  return `Could not add that repository: ${error}`;
}

/** The same failure as the line the tab holds above its grid. */
export function toRepositoryAddFailureNotice(error: string): CatalogNotice {
  return { tone: 'error', message: describeRepositoryAddFailure(error) };
}

/**
 * The dialog installs a card that is not installed yet and re-deploys one that
 * already is, so its button says which of the two it is about to do.
 */
export function describeSkillInstallAction(isInstalled: boolean): string {
  return isInstalled ? SAVE_LABEL : INSTALL_LABEL;
}

/** The same question asked of a cached repository card. */
export function describeRepositorySkillAction(skill: CachedRepositorySkill): string {
  return describeSkillInstallAction(skill.isInstalled);
}

/** Names the agents an install was asked for, since the card cannot show none. */
function describeAgentCount(agentCount: number): string {
  if (agentCount === 0) {
    return 'no agent yet';
  }
  return agentCount === 1 ? '1 agent' : `${agentCount} agents`;
}

/**
 * What a tab says after the Manage dialog settles. A conflict is the one
 * outcome the user has to act on: a different skill already holds the name, and
 * only the upload flow can offer to replace it or keep both.
 *
 * Both tabs install through the same importer and deployer, so both report the
 * outcome in the same words — a skill from skills.sh lands exactly where a
 * skill from a cloned repository does.
 */
export function describeSkillInstallOutcome(
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
export function describeSkillInstallFailure(error: string): CatalogNotice {
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

/** Held while the first page of the listing is still on its way. */
export const SKILLS_SH_LOADING_TEXT = 'Loading skills from skills.sh…';

/** The shortest query the skills.sh search endpoint accepts. */
export const SEARCH_MIN_LENGTH = 3;

/** Said while fewer than three characters are typed, which searches nothing. */
export const SKILLS_SH_SEARCH_HINT = `Type at least ${SEARCH_MIN_LENGTH} characters to search skills.sh.`;

/** Says why the grid is empty when skills.sh could not be reached at all. */
export function describeSkillsShFetchFailure(error: string): string {
  return `Could not reach skills.sh: ${error}`;
}

/**
 * A listing carries no description — skills.sh answers with a name, a source,
 * and an install count — so the card's line says what the listing does know.
 * The count is what ranks the browse listing, which makes it the one number
 * worth reading before installing anything.
 */
function describeListing(cardState: SkillsShCardState): string {
  const { installs, isOfficial, sourceKind } = cardState.listing;
  const origin = sourceKind === 'site' ? 'Published site' : 'GitHub repository';
  const installCount = `${installs.toLocaleString()} install${installs === 1 ? '' : 's'}`;
  return isOfficial ? `Official · ${origin} · ${installCount}` : `${origin} · ${installCount}`;
}

/**
 * One page of the listing, as cards. A card whose skill is already installed
 * draws that installation's badges, so its chips agree with the Agent Hub's;
 * one that is not carries no check, since nothing on this machine loads it yet.
 *
 * That is also what its button says: a skill already here is managed, and one
 * that is not is added.
 */
export function toSkillsShEntries(
  cardStates: readonly SkillsShCardState[]
): readonly CatalogEntry[] {
  return cardStates.map((cardState) => ({
    id: cardState.listing.id,
    name: cardState.listing.name,
    source: cardState.listing.source,
    description: describeListing(cardState),
    compatibility: toCompatibilityChips(cardState.installedSkill?.agentBadges ?? []),
    actionLabel: cardState.installedSkill ? MANAGE_LABEL : ADD_SKILL_LABEL
  }));
}

export const PREVIOUS_PAGE_LABEL = 'Previous';
export const NEXT_PAGE_LABEL = 'Next';

/**
 * Which slice of a listing of thousands is on screen. Pages are zero-based in
 * the service and one-based here, because that is how they are counted out loud.
 */
export function describeSkillsShPage(page: number, shownCount: number, total: number): string {
  if (total === 0 || shownCount === 0) {
    return 'No results';
  }
  const firstShown = page * SKILLS_SH_PAGE_SIZE + 1;
  const lastShown = Math.min(firstShown + shownCount - 1, total);
  return `${firstShown}–${lastShown} of ${total.toLocaleString()}`;
}

/** How many pages a listing of `total` records fills, never fewer than one. */
export function countSkillsShPages(total: number): number {
  return Math.max(1, Math.ceil(total / SKILLS_SH_PAGE_SIZE));
}

/** What each tab calls the thing it lists, so its empty line reads for it. */
const TAB_NOUNS: Readonly<Record<DiscoverTab, string>> = {
  repos: 'skill',
  skillsSh: 'skill'
};

/**
 * What each tab says when it has nothing at all, which is a different sentence
 * from a search that matched nothing: the Repos tab is empty because no
 * repository has been downloaded, and saying so points at the way out.
 */
const TAB_NOTHING_YET: Readonly<Record<DiscoverTab, string>> = {
  repos: 'No repository has been downloaded yet.',
  skillsSh: 'skills.sh published no skills.'
};

/** Stands in for the grid when the search leaves nothing to draw. */
export function describeEmptyDiscoverCatalog(tab: DiscoverTab, query: string): string {
  const trimmedQuery = query.trim();
  if (trimmedQuery.length > 0) {
    return `No ${TAB_NOUNS[tab]} matches "${trimmedQuery}".`;
  }

  return TAB_NOTHING_YET[tab];
}
