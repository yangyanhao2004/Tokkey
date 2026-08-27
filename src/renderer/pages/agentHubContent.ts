/**
 * Content model for the Agent Hub page, taken from the Figma node "Main"
 * (192:1921). Kept apart from the components so copy and catalog entries can
 * change without touching markup.
 *
 * Nothing on this page is live yet: the agent row and the skill/MCP catalog
 * render against the fixed content below while the install plumbing is built.
 * OpenCode is deliberately absent — Tokiie only manages Codex and Claude Code.
 */

/** Shared with the sidebar so every page resolves assets from one place. */
export { NAV_ICON_BASE_PATH as ICON_BASE_PATH } from '../navigation';

export const PAGE_TITLE = 'Agent Hub';
export const PAGE_SUBTITLE =
  'Install the coding agents you use while Tokii keeps local and cloud models available in the background.';

/** Every coding agent the hub can install. */
export type AgentId = 'codex' | 'claude-code';

export interface HubAgent {
  readonly id: AgentId;
  readonly name: string;
  /** The line under the name, e.g. "OpenAI". */
  readonly vendor: string;
  /** Decides the card's action: an installed agent offers "Uninstall". */
  readonly isInstalled: boolean;
}

export const HUB_AGENTS: readonly HubAgent[] = [
  { id: 'codex', name: 'Codex', vendor: 'OpenAI', isInstalled: true },
  { id: 'claude-code', name: 'Claude Code', vendor: 'Anthropic', isInstalled: false }
];

export function findAgent(id: AgentId): HubAgent | undefined {
  return HUB_AGENTS.find((agent) => agent.id === id);
}

export function describeAgentAction(agent: HubAgent): string {
  return agent.isInstalled ? 'Uninstall' : 'Install';
}

/**
 * How a catalog entry stands with one agent:
 * `enabled` — turned on for that agent, so the chip carries the green check;
 * `available` — the agent is installed but the entry is not turned on;
 * `unavailable` — the agent itself is not installed, so the chip greys out.
 */
export type CompatibilityState = 'enabled' | 'available' | 'unavailable';

export interface CompatibilityChip {
  readonly agentId: AgentId;
  readonly state: CompatibilityState;
}

const COMPATIBILITY_DESCRIPTIONS: Record<CompatibilityState, string> = {
  enabled: 'enabled',
  available: 'installed, not enabled',
  unavailable: 'agent not installed'
};

/** Titles a chip, since the two-letter glyph alone says nothing out loud. */
export function describeCompatibility(chip: CompatibilityChip): string {
  const name = findAgent(chip.agentId)?.name ?? chip.agentId;
  return `${name}: ${COMPATIBILITY_DESCRIPTIONS[chip.state]}`;
}

/** The two halves of the "Skills & MCPs" section. */
export type CatalogTab = 'skills' | 'mcps';

export interface CatalogTabOption {
  readonly value: CatalogTab;
  readonly label: string;
}

export const CATALOG_TABS: readonly CatalogTabOption[] = [
  { value: 'skills', label: 'Skills' },
  { value: 'mcps', label: 'MCPs' }
];

export interface CatalogEntry {
  readonly id: string;
  readonly name: string;
  /** Where the entry came from, e.g. "GitHub" or "skills.sh". */
  readonly source: string;
  readonly description: string;
  readonly compatibility: readonly CompatibilityChip[];
}

const SKILL_CATALOG: readonly CatalogEntry[] = [
  {
    id: 'video-generation',
    name: 'Video Generation',
    source: 'GitHub',
    description: 'Create short videos from prompts and supplied assets.',
    compatibility: [
      { agentId: 'claude-code', state: 'unavailable' },
      { agentId: 'codex', state: 'available' }
    ]
  },
  {
    id: 'ppt-generation',
    name: 'PPT Generation',
    source: 'GitHub',
    description: 'Create and refine presentation decks from a brief.',
    compatibility: [
      { agentId: 'claude-code', state: 'enabled' },
      { agentId: 'codex', state: 'enabled' }
    ]
  },
  {
    id: 'image-generation',
    name: 'Image Generation',
    source: 'GitHub',
    description: 'Generate or edit images through an image provider.',
    compatibility: [
      { agentId: 'claude-code', state: 'available' },
      { agentId: 'codex', state: 'enabled' }
    ]
  },
  {
    id: 'web-research',
    name: 'Web Research',
    source: 'skills.sh',
    description: 'Research websites and summarize useful sources.',
    compatibility: [
      { agentId: 'claude-code', state: 'enabled' },
      { agentId: 'codex', state: 'enabled' }
    ]
  }
];

const MCP_CATALOG: readonly CatalogEntry[] = [
  {
    id: 'filesystem',
    name: 'Filesystem',
    source: 'GitHub',
    description: 'Read and write files inside an allowed workspace folder.',
    compatibility: [
      { agentId: 'claude-code', state: 'enabled' },
      { agentId: 'codex', state: 'available' }
    ]
  },
  {
    id: 'playwright',
    name: 'Playwright',
    source: 'GitHub',
    description: 'Drive a real browser to test pages and read the result.',
    compatibility: [
      { agentId: 'claude-code', state: 'available' },
      { agentId: 'codex', state: 'unavailable' }
    ]
  }
];

const CATALOGS: Record<CatalogTab, readonly CatalogEntry[]> = {
  skills: SKILL_CATALOG,
  mcps: MCP_CATALOG
};

/**
 * The entries one tab shows, narrowed to those whose name or description
 * matches what has been typed. Matching happens here rather than in the
 * component so the card only ever renders the rows it is handed.
 */
export function selectCatalogEntries(tab: CatalogTab, query: string): readonly CatalogEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return CATALOGS[tab];
  }

  return CATALOGS[tab].filter(
    (entry) =>
      entry.name.toLowerCase().includes(needle) ||
      entry.description.toLowerCase().includes(needle)
  );
}

export const SECTION_HEADING = 'Skills & MCPs';
export const SEARCH_PLACEHOLDER = 'Search';
export const SEARCH_LABEL = 'Search skills and MCPs';
export const TAB_GROUP_LABEL = 'Show skills or MCPs';
export const WORKS_WITH_LABEL = 'Works with';
export const MANAGE_LABEL = 'Manage';

/** The section's own noun, so its button labels read for the open tab. */
function describeTabNoun(tab: CatalogTab): string {
  return tab === 'skills' ? 'Skill' : 'MCP';
}

export function describeUploadAction(tab: CatalogTab): string {
  return `Upload ${describeTabNoun(tab)}`;
}

export function describeDiscoverAction(tab: CatalogTab): string {
  return `Discover ${describeTabNoun(tab)}`;
}

/** Stands in for the grid when the search leaves nothing to draw. */
export function describeEmptyCatalog(tab: CatalogTab, query: string): string {
  const noun = describeTabNoun(tab).toLowerCase();
  if (query.trim().length > 0) {
    return `No ${noun} matches "${query.trim()}".`;
  }

  return `No ${noun} is installed yet.`;
}
