/**
 * Content model for the Agent Hub page, taken from the Figma node "Main"
 * (192:1921). Kept apart from the components so copy and catalog entries can
 * change without touching markup.
 *
 * Neither catalog is fixed content: both are whatever the main process scanners
 * find installed. Nor is the agent list — detection decides that, and every
 * function here that takes an `AgentAvailability` reads it. OpenCode is
 * deliberately absent — Tokkey only manages Codex and Claude Code.
 */

import { SKILL_ROOT_DISPLAY_NAMES } from '../../shared/types';
import type {
  AgentInstallation,
  CodingAgent,
  InstalledMcp,
  InstalledSkill,
  McpAgent,
  McpAgentBadge,
  McpCatalogFailure,
  McpConfigurationDraft,
  McpConnectionType,
  SkillAgent,
  SkillAgentBadge,
  SkillUploadConflictChoice,
  SkillUploadResult
} from '../../shared/types';

/** Shared with the sidebar so every page resolves assets from one place. */
export { NAV_ICON_BASE_PATH as ICON_BASE_PATH } from '../navigation';

export const PAGE_TITLE = 'Agent Hub';
export const PAGE_SUBTITLE = 'See whether Codex and Claude Code are installed on this Mac.';

/** Every coding agent the hub can detect. */
export type AgentId = 'codex' | 'claude-code';

export interface HubAgent {
  readonly id: AgentId;
  readonly name: string;
  /** The line under the name, e.g. "OpenAI". */
  readonly vendor: string;
  /** The executable detection looks for, which is not always the agent's id. */
  readonly cli: CodingAgent;
  /** The name the skill and MCP scanners both badge this agent under. */
  readonly catalogAgent: CatalogAgent;
}

/** The agent name both scanners badge under, which they spell the same way. */
export type CatalogAgent = SkillAgent & McpAgent;

export const HUB_AGENTS: readonly HubAgent[] = [
  { id: 'codex', name: 'Codex', vendor: 'OpenAI', cli: 'codex', catalogAgent: 'codex' },
  { id: 'claude-code', name: 'Claude Code', vendor: 'Anthropic', cli: 'claude', catalogAgent: 'claudeCode' }
];

/** The hub agent one scanner badge belongs to, for copy that names it. */
export function findAgentByCatalogAgent(catalogAgent: SkillAgent | McpAgent): HubAgent | undefined {
  return HUB_AGENTS.find((agent) => agent.catalogAgent === catalogAgent);
}

export function findAgent(id: AgentId): HubAgent | undefined {
  return HUB_AGENTS.find((agent) => agent.id === id);
}

/**
 * Which agents are installed, or `null` while detection is still running.
 * Nothing is greyed out until an answer arrives, so the page never flashes a
 * state it is about to contradict.
 */
export type AgentAvailability = Readonly<Record<AgentId, boolean>> | null;

/** Turns one detection into the per-agent lookup the page draws from. */
export function readAgentAvailability(
  installations: readonly AgentInstallation[] | null
): AgentAvailability {
  if (!installations) {
    return null;
  }

  const installed = new Set(
    installations.filter((installation) => installation.installed).map((installation) => installation.agent)
  );
  return Object.fromEntries(
    HUB_AGENTS.map((agent) => [agent.id, installed.has(agent.cli)])
  ) as Record<AgentId, boolean>;
}

/** The read-only state shown by an agent card while detection settles. */
export type AgentStatus = 'checking' | 'installed' | 'notInstalled';

const AGENT_STATUS_LABELS: Readonly<Record<AgentStatus, string>> = {
  checking: 'Checking…',
  installed: 'Installed',
  notInstalled: 'Not installed'
};

/** Resolves detection without implying that Tokkey can change the installation. */
export function resolveAgentStatus(
  availability: AgentAvailability,
  agentId: AgentId
): AgentStatus {
  if (!availability) {
    return 'checking';
  }
  return availability[agentId] ? 'installed' : 'notInstalled';
}

/** Human-readable status for the agent card's non-interactive badge. */
export function describeAgentStatus(status: AgentStatus): string {
  return AGENT_STATUS_LABELS[status];
}

/**
 * What a catalog entry declares for one agent, independent of this machine:
 * `enabled` — turned on for that agent, so the chip carries the green check;
 * `available` — supported by that agent but not turned on;
 * `unsupported` — the agent cannot run this entry at all, which is what an SSE
 * MCP is to Codex.
 */
export type CatalogEnablement = 'enabled' | 'available' | 'unsupported';

/**
 * How the chip is actually drawn. `unavailable` is never declared by an entry;
 * detection adds it when the agent itself is missing from this machine.
 */
export type CompatibilityState = CatalogEnablement | 'unavailable';

export interface CompatibilityChip {
  readonly agentId: AgentId;
  readonly enablement: CatalogEnablement;
}

/** A missing agent overrides whatever the entry declares for it. */
export function resolveCompatibilityState(
  chip: CompatibilityChip,
  availability: AgentAvailability
): CompatibilityState {
  if (!availability) {
    return chip.enablement;
  }
  return availability[chip.agentId] ? chip.enablement : 'unavailable';
}

const COMPATIBILITY_DESCRIPTIONS: Record<CompatibilityState, string> = {
  enabled: 'enabled',
  available: 'installed, not enabled',
  unsupported: 'not supported by this agent',
  unavailable: 'agent not installed'
};

/** Titles a chip, since the mark alone says nothing out loud. */
export function describeCompatibility(agentId: AgentId, state: CompatibilityState): string {
  const name = findAgent(agentId)?.name ?? agentId;
  return `${name}: ${COMPATIBILITY_DESCRIPTIONS[state]}`;
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
  /**
   * Where the entry came from, e.g. "GitHub" or "skills.sh". Omitted by the
   * Discover Skills pane, whose whole tab already says where its cards are from.
   */
  readonly source?: string;
  /**
   * The line under the name. Omitted where an entry has nothing to say for
   * itself — an MCP is a command line or a URL, which the card's transport
   * label already covers.
   */
  readonly description?: string;
  readonly compatibility: readonly CompatibilityChip[];
  /**
   * What this one card's button says, for a grid whose cards do not all offer
   * the same thing — the skills.sh listing manages a skill already installed
   * and adds one that is not. Omitted where the whole grid agrees.
   */
  readonly actionLabel?: string;
}

/**
 * Where an installed skill lives, said in the words the page uses elsewhere.
 * The Amis root is Tokkey's own store, so it reads as the app rather than as a
 * directory nobody outside the code recognizes.
 */
/** Stands in for a skill whose SKILL.md carries no description. */
export const MISSING_SUMMARY_TEXT = 'No description in this skill’s SKILL.md.';

/** What one scanner badge says about the agent it names. */
const BADGE_ENABLEMENTS: Readonly<Record<McpAgentBadge['state'], CatalogEnablement>> = {
  checked: 'enabled',
  unchecked: 'available',
  disabled: 'unsupported'
};

/**
 * An entry's chips, read from the badges the main process scanners produce:
 * checked means that agent already loads it, which the card draws as the green
 * check. An agent the scan never badged is merely supported.
 *
 * Every card that shows a skill or an MCP goes through here — installed ones
 * and the ones only sitting in the repository cache — so the same badge means
 * the same chip wherever it is drawn.
 */
export function toCompatibilityChips(
  badges: readonly (SkillAgentBadge | McpAgentBadge)[]
): readonly CompatibilityChip[] {
  const badgeStates = new Map<SkillAgent | McpAgent, SkillAgentBadge['state'] | McpAgentBadge['state']>(
    badges.map((badge) => [badge.agent, badge.state])
  );
  return HUB_AGENTS.map((agent) => ({
    agentId: agent.id,
    enablement: BADGE_ENABLEMENTS[badgeStates.get(agent.catalogAgent) ?? 'unchecked']
  }));
}

/** Turns one filesystem scan into the cards the "Skills" tab draws. */
export function toSkillCatalogEntries(skills: readonly InstalledSkill[]): readonly CatalogEntry[] {
  return skills.map((skill) => ({
    id: skill.id,
    name: skill.name,
    source: SKILL_ROOT_DISPLAY_NAMES[skill.primaryInstallation.root],
    description: skill.summary ?? MISSING_SUMMARY_TEXT,
    compatibility: toCompatibilityChips(skill.agentBadges)
  }));
}

/**
 * How each transport is named on a card. An MCP has no vendor or registry to
 * cite, so the card's source slot says how the agent reaches it instead.
 */
const MCP_CONNECTION_LABELS: Readonly<Record<McpConnectionType, string>> = {
  stdio: 'stdio',
  sse: 'SSE',
  streamable_http: 'HTTP'
};

/**
 * The agents that cannot load an entry at all, which the Manage dialog locks:
 * for an MCP that is Codex opposite an SSE server, since Codex has no such
 * transport.
 */
export function readUnsupportedAgents(
  badges: readonly (SkillAgentBadge | McpAgentBadge)[]
): readonly CatalogAgent[] {
  return badges.filter((badge) => badge.state === 'disabled').map((badge) => badge.agent);
}

/**
 * The agents missing from this machine, which the Manage dialog locks for the
 * same reason the cards grey their chips: enabling an entry for a CLI that is
 * not here writes a configuration nothing will ever read.
 *
 * Detection still running locks nothing, so the dialog never refuses a choice
 * it is about to allow.
 */
export function readUnavailableAgents(availability: AgentAvailability): readonly CatalogAgent[] {
  if (!availability) {
    return [];
  }
  return HUB_AGENTS.filter((agent) => !availability[agent.id]).map((agent) => agent.catalogAgent);
}

/** Turns one MCP scan into the cards the "MCPs" tab draws. */
export function toMcpCatalogEntries(servers: readonly InstalledMcp[]): readonly CatalogEntry[] {
  return servers.map((mcp) => ({
    id: mcp.id,
    name: mcp.title,
    source: MCP_CONNECTION_LABELS[mcp.connectionType],
    compatibility: toCompatibilityChips(mcp.badges)
  }));
}

/**
 * The entries a tab shows, narrowed to those whose name, description, or source
 * matches what has been typed. Matching happens here rather than in the
 * component so the card only ever renders the rows it is handed.
 *
 * The source counts because the Repos tab draws one grid across every cloned
 * repository, so "anthropics/skills" is a search a user will type there.
 */
export function selectCatalogEntries(
  entries: readonly CatalogEntry[],
  query: string
): readonly CatalogEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return entries;
  }

  return entries.filter(
    (entry) =>
      entry.name.toLowerCase().includes(needle) ||
      (entry.description ?? '').toLowerCase().includes(needle) ||
      (entry.source ?? '').toLowerCase().includes(needle)
  );
}

/**
 * The Manage dialog (Figma 225:1301), which both catalogs open and which says
 * above the name which of them asked. OpenCode is drawn there too, but Tokkey
 * does not manage it, so the dialog lists `HUB_AGENTS` like the rest of the page.
 */
export const MANAGE_SKILL_DIALOG_EYEBROW = 'MANAGE SKILL';
export const SKILL_DETAILS_DIALOG_EYEBROW = 'Skill INFO';
export const SKILL_DETAILS_LOADING_TEXT = 'Reading SKILL.md…';
export const SKILL_DETAILS_EMPTY_TEXT = 'This SKILL.md has no content.';
export const CLOSE_LABEL = 'Close';
export const MANAGE_MCP_DIALOG_EYEBROW = 'MANAGE MCP';
export const MANAGE_DIALOG_ENABLE_HEADING = 'Enable for';
export const MANAGE_DIALOG_ENABLE_HINT = 'Choose one or more agents. You can change this later.';
export const MANAGE_DIALOG_COMPATIBLE_LABEL = 'Compatible';
export const MANAGE_DIALOG_UNSUPPORTED_LABEL = 'Not supported';
export const MANAGE_DIALOG_UNAVAILABLE_LABEL = 'Not installed';
export const MANAGE_DIALOG_LOADING_TEXT = 'Reading…';

/**
 * What one agent's toggle says about itself. A missing agent outranks whatever
 * the entry declares: "not supported" is a fact about the entry, and there is
 * no point stating it about a CLI that is not on this machine at all.
 */
export function describeAgentSupport(isUnsupported: boolean, isUnavailable: boolean): string {
  if (isUnavailable) {
    return MANAGE_DIALOG_UNAVAILABLE_LABEL;
  }
  if (isUnsupported) {
    return MANAGE_DIALOG_UNSUPPORTED_LABEL;
  }
  return MANAGE_DIALOG_COMPATIBLE_LABEL;
}
export const UNINSTALL_LABEL = 'Uninstall';
export const CANCEL_LABEL = 'Cancel';

/**
 * The confirmation in front of Uninstall (Figma 531:3986). Removing a skill
 * deletes its folder, which no dialog can put back, so it is the one action on
 * the page that asks twice — and says that asking again is all it costs.
 */
export const UNINSTALL_SKILL_CONFIRM_TITLE = 'Uninstall this skill?';
export const UNINSTALL_SKILL_CONFIRM_MESSAGE = 'You can install this later.';
export const SAVE_LABEL = 'Save changes';

/** The counter opposite the "Enable for" heading. */
export function describeSelectedAgentCount(count: number): string {
  return `${count} selected`;
}

/** Reports why a save or uninstall left the filesystem untouched. */
export function describeManageFailure(error: string): string {
  return `That did not work: ${error}`;
}

/** Reports a read failure inside the detail dialog without hiding what failed. */
export function describeSkillDetailsFailure(error: string): string {
  return `Could not read SKILL.md: ${error}`;
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

/**
 * The MCPs tab's one action (Figma 225:2416). MCPs are not uploaded from disk
 * or browsed from a registry the way skills are — an MCP is a configuration the
 * user writes — so the tab offers a single button rather than the skills tab's
 * Upload and Discover pair.
 */
export const ADD_MCP_LABEL = '+ Add MCP';

/**
 * The Add MCP dialog (Figma 531:2979 "Config Wizard", 531:3240 "Full JSON").
 * The same sheet in two modes: guided fields, or the raw one-server envelope.
 */
export const ADD_MCP_DIALOG_TITLE = 'Add MCP';
export const ADD_MCP_CONFIRM_LABEL = 'Add MCP';
export const ADD_MCP_BUSY_LABEL = 'Adding…';

/** Which editor the sheet is showing; the two halves of `McpConfigurationDraft`. */
export type McpEditorMode = McpConfigurationDraft['mode'];

export const ADD_MCP_MODE_LABEL = 'Describe this MCP with the wizard or with JSON';
export const ADD_MCP_MODES: readonly { value: McpEditorMode; label: string }[] = [
  { value: 'wizard', label: 'Config Wizard' },
  { value: 'json', label: 'Full JSON' }
];

export const MCP_NAME_FIELD_LABEL = 'Name';
export const MCP_NAME_PLACEHOLDER = 'e.g. GitHub MCP';
export const MCP_CONNECTION_FIELD_LABEL = 'Connection Type';

/**
 * How each transport is offered in the wizard. "Command" is what the design
 * calls stdio, since that is what the field under it asks for; the remote two
 * are named after the protocol because nothing else distinguishes them.
 */
export const MCP_CONNECTION_OPTIONS: readonly { value: McpConnectionType; label: string }[] = [
  { value: 'stdio', label: 'Command' },
  { value: 'streamable_http', label: 'Streamable HTTP' },
  { value: 'sse', label: 'SSE' }
];

export const MCP_COMMAND_FIELD_LABEL = 'Command';
export const MCP_COMMAND_PLACEHOLDER = 'npx -y @modelcontextprotocol/server-filesystem ~/Documents';
export const MCP_URL_FIELD_LABEL = 'Server URL';
export const MCP_URL_PLACEHOLDER = 'https://mcp.example.com/mcp';

/**
 * A stdio server receives its credentials as environment variables, so the
 * field the design labels "API Key / Token" collects `KEY=VALUE` pairs rather
 * than a bare secret — the placeholder says so, since the label cannot.
 */
export const MCP_ENVIRONMENT_FIELD_LABEL = 'API Key / Token (Optional)';
export const MCP_ENVIRONMENT_PLACEHOLDER = 'KEY=VALUE, e.g. GITHUB_TOKEN=ghp_…';

export const MCP_JSON_FIELD_LABEL = 'Full JSON Configuration';

/**
 * The design's sample is a bare server entry; the envelope the agents' own
 * files use wraps it in `mcpServers`, which is what this actually accepts.
 */
export const MCP_JSON_PLACEHOLDER = `{
  "mcpServers": {
    "fetch": {
      "type": "stdio",
      "command": "uvx",
      "args": ["mcp-server-fetch"]
    }
  }
}`;

export const MCP_FORMAT_LABEL = 'Format';
export const MCP_VALIDATE_LABEL = 'Validate';
export const MCP_JSON_VALID_TEXT = 'This configuration looks valid.';

/** The agent row's heading, which asks a different question than "Enable for". */
export const ADD_MCP_AVAILABLE_HEADING = 'Available to';

/** Reports why nothing was written, leaving the sheet open over the draft. */
export function describeMcpAddFailure(error: string): CatalogNotice {
  return { tone: 'error', message: `Could not add that MCP: ${error}` };
}

export const ADD_MCP_NO_AGENT_REASON = 'Choose at least one agent.';

/**
 * Why "Add MCP" cannot be confirmed yet, in the order the contract asks for:
 * a missing agent first, then whatever the configuration itself is still wrong
 * about, then an agent that cannot reach this transport. `null` means nothing
 * is blocking it.
 *
 * Only the first reason is reported. A draft early in the typing fails several
 * checks at once, and listing them all says less than naming the next one.
 */
export function describeMcpBlockingReason(
  hasSelectedAgent: boolean,
  configurationError: string | null,
  unsupportedSelectedAgents: readonly CatalogAgent[]
): string | null {
  if (!hasSelectedAgent) {
    return ADD_MCP_NO_AGENT_REASON;
  }
  if (configurationError) {
    return configurationError;
  }
  const [blockedAgent] = unsupportedSelectedAgents;
  if (blockedAgent) {
    const name = findAgentByCatalogAgent(blockedAgent)?.name ?? blockedAgent;
    return `${name} cannot load this connection type.`;
  }
  return null;
}

/** Held while the first filesystem scan is still running. */
export const SKILL_SCAN_LOADING_TEXT = 'Scanning installed skills…';
export const MCP_SCAN_LOADING_TEXT = 'Reading agent MCP configuration…';

/** Says why the grid is empty when the scan itself failed. */
export function describeSkillScanFailure(error: string): string {
  return `Could not read installed skills: ${error}`;
}

export function describeMcpScanFailure(error: string): string {
  return `Could not read installed MCPs: ${error}`;
}

/**
 * One agent's unreadable configuration file. The other agent's servers are
 * still listed, so this reports what is missing from the grid rather than
 * standing in for it.
 */
export function describeMcpAgentFailure(failure: McpCatalogFailure): string {
  const name = findAgentByCatalogAgent(failure.agent)?.name ?? failure.agent;
  return `Could not read ${name}’s MCP configuration: ${failure.message}`;
}

/** Shown on the upload button while the picker or the copy is still running. */
export const SKILL_UPLOAD_BUSY_TEXT = 'Uploading…';

/**
 * The prompt raised when `~/.amis/skills/<name>` is already taken by a folder
 * whose SKILL.md differs — which the duplicate check reads as an update the
 * user may well want, rather than as a re-upload to refuse.
 */
export const UPLOAD_CONFLICT_EYEBROW = 'SKILL ALREADY EXISTS';
export const UPLOAD_CONFLICT_HINT =
  'Replace overwrites the installed folder, Keep Both installs this one under a new name, and Skip leaves everything as it is.';
export const REPLACE_LABEL = 'Replace';
export const KEEP_BOTH_LABEL = 'Keep Both';
export const SKIP_LABEL = 'Skip';

/** The three answers, in the order the dialog offers them. */
export const UPLOAD_CONFLICT_CHOICES: readonly { value: SkillUploadConflictChoice; label: string }[] = [
  { value: 'replace', label: REPLACE_LABEL },
  { value: 'keepBoth', label: KEEP_BOTH_LABEL },
  { value: 'skip', label: SKIP_LABEL }
];

export function describeUploadConflict(folderName: string): string {
  return `A skill named “${folderName}” is already installed in Tokkey’s skills folder.`;
}

/** The last path segment, which is the name Keep Both actually settled on. */
function readFolderName(destinationPath: string | null, fallbackName: string | null): string {
  const segments = (destinationPath ?? '').split('/').filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? fallbackName ?? 'the skill';
}

/**
 * How a line a catalog tab prints reads. `error` is for something turned away —
 * a duplicate upload, a folder with no SKILL.md, a failed scan — which is the
 * one thing the user has to act on rather than simply read.
 */
export type CatalogMessageTone = 'neutral' | 'error';

export interface CatalogNotice {
  readonly tone: CatalogMessageTone;
  readonly message: string;
}

/**
 * What the section says after an upload settles. Cancelling and the conflict
 * prompt say nothing: one is not an outcome, and the other is still a question.
 */
export function describeSkillUploadOutcome(result: SkillUploadResult): CatalogNotice | null {
  const folderName = result.folderName ?? 'the skill';
  switch (result.status) {
    case 'installed':
      return { tone: 'neutral', message: `Uploaded “${folderName}”.` };
    case 'replaced':
      return { tone: 'neutral', message: `Replaced the installed “${folderName}”.` };
    case 'keptBoth':
      return {
        tone: 'neutral',
        message: `Uploaded “${folderName}” as “${readFolderName(result.destinationPath, folderName)}”.`
      };
    case 'skipped':
      return { tone: 'neutral', message: `Kept the installed “${folderName}”.` };
    case 'alreadyInstalled':
      return { tone: 'error', message: `“${folderName}” is already installed.` };
    case 'notASkillFolder':
      return { tone: 'error', message: `“${folderName}” is not a skill folder: it has no SKILL.md.` };
    default:
      return null;
  }
}

/** Reports why an upload left the skills folder untouched. */
export function describeSkillUploadFailure(error: string): CatalogNotice {
  return { tone: 'error', message: `Could not upload that folder: ${error}` };
}

/** Stands in for the grid when the search leaves nothing to draw. */
export function describeEmptyCatalog(tab: CatalogTab, query: string): string {
  const noun = describeTabNoun(tab).toLowerCase();
  if (query.trim().length > 0) {
    return `No ${noun} matches "${query.trim()}".`;
  }

  return `No ${noun} is installed yet.`;
}
