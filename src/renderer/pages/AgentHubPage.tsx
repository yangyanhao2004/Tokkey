import { useMemo, useState } from 'react';
import {
  CATALOG_TABS,
  HUB_AGENTS,
  ICON_BASE_PATH,
  MANAGE_LABEL,
  MCP_CATALOG,
  PAGE_SUBTITLE,
  PAGE_TITLE,
  SEARCH_LABEL,
  SEARCH_PLACEHOLDER,
  SECTION_HEADING,
  SKILL_SCAN_LOADING_TEXT,
  TAB_GROUP_LABEL,
  WORKS_WITH_LABEL,
  describeAgentAction,
  describeCompatibility,
  describeDiscoverAction,
  describeEmptyCatalog,
  describeSkillScanFailure,
  describeUploadAction,
  findAgent,
  isAgentInstalled,
  readAgentAvailability,
  resolveCompatibilityState,
  selectCatalogEntries,
  toSkillCatalogEntries,
  type AgentAvailability,
  type CatalogEntry,
  type CatalogTab,
  type CompatibilityChip,
  type CompatibilityState,
  type HubAgent
} from './agentHubContent';
import { useAgentDetection } from '../hooks/useAgentDetection';
import { useInstalledSkills } from '../hooks/useInstalledSkills';
import { AGENT_ARTWORK, AgentMarkTile } from '../components/AgentMark';
import { ManageSkillDialog } from '../components/ManageSkillDialog';
import { PageShell } from '../components/PageShell';
import { PushButton } from '../components/PushButton';
import { SearchField } from '../components/SearchField';
import { SegmentedControl } from '../components/SegmentedControl';
import { TitleBlock } from '../components/TitleBlock';

interface AgentCardProps {
  agent: HubAgent;
  availability: AgentAvailability;
}

/** One installable coding agent: its glyph, name, vendor, and single action. */
function AgentCard({ agent, availability }: AgentCardProps) {
  const isInstalled = isAgentInstalled(availability, agent.id);

  return (
    <article
      className="flex min-w-0 flex-1 flex-col gap-4 rounded-[12px] border border-vibrant-tertiary bg-surface-card p-3"
      data-testid={`agent-card-${agent.id}`}
    >
      <div className="flex w-full items-center gap-2">
        <AgentMarkTile agentId={agent.id} />
        <TitleBlock title={agent.name} subtitle={agent.vendor} as="h3" />
      </div>

      <div className="flex w-full items-center justify-end">
        <PushButton
          variant={isInstalled ? 'plain' : 'filled'}
          // Nothing to offer until detection says which action this even is.
          disabled={availability === null}
          testId={`agent-action-${agent.id}`}
        >
          {describeAgentAction(availability, agent.id)}
        </PushButton>
      </div>
    </article>
  );
}

interface AgentRowProps {
  availability: AgentAvailability;
}

/** The agents the hub manages, side by side across the top of the page. */
function AgentRow({ availability }: AgentRowProps) {
  return (
    <section className="flex w-full shrink-0 items-start gap-2" data-testid="agent-row">
      {HUB_AGENTS.map((agent) => (
        <AgentCard key={agent.id} agent={agent} availability={availability} />
      ))}
    </section>
  );
}

/**
 * Only the enabled chip is drawn in the design (Figma 1051:3869 and 1051:3881),
 * which rings it in pale green. The other two states carry the same avatar and
 * say the rest with the ring: a hairline where the agent could run the entry,
 * and a drained mark where the agent is not installed at all.
 */
const CHIP_STATE_CLASSES: Record<CompatibilityState, string> = {
  enabled: 'ring-1 ring-chip-enabled-ring',
  available: 'ring-1 ring-black/8',
  unavailable: 'opacity-40 grayscale'
};

interface CompatibilityChipProps {
  chip: CompatibilityChip;
  availability: AgentAvailability;
}

/**
 * One agent's standing with a catalog entry, drawn as the agent's round mark.
 * An enabled entry adds the green check that overhangs the mark's bottom-right
 * corner, so neither this box nor the row it sits in may clip.
 */
function CompatibilityChipMark({ chip, availability }: CompatibilityChipProps) {
  const agent = findAgent(chip.agentId);
  if (!agent) {
    return null;
  }

  const artwork = AGENT_ARTWORK[chip.agentId];
  // Detection has the last word: an agent that is not on this machine greys out
  // however the entry describes itself.
  const state = resolveCompatibilityState(chip, availability);

  return (
    <span
      className="relative flex size-[20px] shrink-0"
      title={describeCompatibility(chip.agentId, state)}
      data-testid={`compat-chip-${chip.agentId}`}
    >
      <span
        className={`flex size-full items-center justify-center overflow-hidden rounded-full ${artwork.avatarClass} ${CHIP_STATE_CLASSES[state]}`}
      >
        <img
          className={`block max-w-none ${artwork.avatarMarkClass}`}
          src={`${ICON_BASE_PATH}/${artwork.avatarFile}`}
          alt=""
        />
      </span>

      {state === 'enabled' && (
        <span
          className="absolute right-[-4px] bottom-[-3px] flex size-[12px] items-center justify-center rounded-full bg-status-live text-[8px] leading-[10px] font-black text-white"
          aria-hidden
        >
          ✓
        </span>
      )}
    </span>
  );
}

interface CatalogCardProps {
  entry: CatalogEntry;
  availability: AgentAvailability;
  /** Omitted for entries with nothing to manage yet, which disables the button. */
  onManage?: () => void;
}

/**
 * One skill or MCP: what it is on top, which agents it works with underneath.
 * The card is at least as tall as the design's fixed 148px but grows rather
 * than clipping, since a longer description would otherwise spill out.
 */
function CatalogCard({ entry, availability, onManage }: CatalogCardProps) {
  return (
    <article
      className="flex min-h-[148px] flex-col justify-between gap-4 rounded-[12px] border border-vibrant-tertiary p-4"
      data-testid={`catalog-entry-${entry.id}`}
    >
      <div className="flex w-full flex-col gap-1.5">
        <div className="flex w-full items-start justify-between gap-2">
          <h3 className="min-w-0 truncate text-[12px] leading-[14px] font-bold text-text-primary">
            {entry.name}
          </h3>
          <span className="shrink-0 text-[8px] leading-[10px] text-text-secondary">
            {entry.source}
          </span>
        </div>
        {/* Skill descriptions are written for agents and run long; clamping them
            keeps every card the height the design draws. */}
        <p className="line-clamp-3 w-full text-[10px] leading-[12px] text-text-secondary" title={entry.description}>
          {entry.description}
        </p>
      </div>

      <div className="flex w-full flex-col gap-2">
        <span className="text-[8px] leading-[10px] font-bold uppercase text-label-section">
          {WORKS_WITH_LABEL}
        </span>

        <div className="flex w-full items-center justify-between gap-2">
          {/* Wider than Figma's 4px: the check badge overhangs its own chip,
              so a tighter gap would sit it on top of the next one. */}
          <div className="flex items-center gap-2">
            {entry.compatibility.map((chip) => (
              <CompatibilityChipMark key={chip.agentId} chip={chip} availability={availability} />
            ))}
          </div>

          <PushButton
            variant="plain-dark"
            onClick={onManage}
            disabled={onManage === undefined}
            testId={`catalog-manage-${entry.id}`}
          >
            {MANAGE_LABEL}
          </PushButton>
        </div>
      </div>
    </article>
  );
}

interface CatalogSectionProps {
  availability: AgentAvailability;
}

/**
 * "Skills & MCPs": the tab picker, the search and add actions, then the grid
 * of whatever the open tab holds. The tab and query are the section's own
 * state; agent availability is the page's, since the agent row reads it too.
 *
 * The skill cards come from the main process scan of the agent skill roots, so
 * a chip is checked exactly when that agent can already load the skill. MCPs
 * are still fixed content.
 */
function CatalogSection({ availability }: CatalogSectionProps) {
  const [tab, setTab] = useState<CatalogTab>('skills');
  const [query, setQuery] = useState('');
  const [managedSkillId, setManagedSkillId] = useState<string | null>(null);
  const { skills, isLoading, error, applyAgentSelection, uninstall } = useInstalledSkills();

  // Mapping a whole scan is wasted work on every keystroke of the search box.
  const skillEntries = useMemo(() => toSkillCatalogEntries(skills ?? []), [skills]);
  const entries = selectCatalogEntries(tab === 'skills' ? skillEntries : MCP_CATALOG, query);
  // Only the skills tab is backed by a scan, so only it can be loading or failed.
  const isScanning = tab === 'skills' && isLoading;
  const scanError = tab === 'skills' ? error : null;
  // Held by id rather than by object so the dialog follows the rescanned card.
  const managedSkill = skills?.find((skill) => skill.id === managedSkillId) ?? null;

  return (
    <section className="flex min-h-0 w-full flex-1 flex-col gap-3" data-testid="catalog-section">
      <h2 className="text-[14px] leading-[17px] font-bold text-text-secondary">
        {SECTION_HEADING}
      </h2>

      <SegmentedControl
        options={CATALOG_TABS}
        value={tab}
        onChange={setTab}
        label={TAB_GROUP_LABEL}
        testId="catalog-tabs"
      />

      <div className="flex w-full shrink-0 items-center justify-between gap-2">
        <div className="w-[180px] shrink-0">
          <SearchField
            value={query}
            onChange={setQuery}
            placeholder={SEARCH_PLACEHOLDER}
            label={SEARCH_LABEL}
            testId="catalog-search"
          />
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <PushButton variant="tinted" testId="catalog-upload">
            {describeUploadAction(tab)}
          </PushButton>
          <PushButton testId="catalog-discover">{describeDiscoverAction(tab)}</PushButton>
        </div>
      </div>

      {/* `min-h-0` keeps a catalog of any length inside the page rather than
          pushing the window's content out of view. */}
      <div className="min-h-0 w-full flex-1 overflow-y-auto">
        {isScanning && (
          <p
            className="w-full py-2 text-[10px] leading-[12px] text-text-secondary"
            data-testid="catalog-loading"
          >
            {SKILL_SCAN_LOADING_TEXT}
          </p>
        )}

        {scanError && (
          <p
            className="w-full py-2 text-[10px] leading-[12px] text-text-secondary"
            data-testid="catalog-error"
          >
            {describeSkillScanFailure(scanError)}
          </p>
        )}

        {!isScanning && !scanError && entries.length === 0 && (
          <p
            className="w-full py-2 text-[10px] leading-[12px] text-text-secondary"
            data-testid="catalog-empty"
          >
            {describeEmptyCatalog(tab, query)}
          </p>
        )}

        <div className="grid w-full grid-cols-2 gap-3">
          {entries.map((entry) => (
            <CatalogCard
              key={entry.id}
              entry={entry}
              availability={availability}
              // A catalog entry's id is its skill's id, so only skills manage.
              onManage={tab === 'skills' ? () => setManagedSkillId(entry.id) : undefined}
            />
          ))}
        </div>
      </div>

      {managedSkill && (
        <ManageSkillDialog
          skill={managedSkill}
          onApply={(selectedAgents) => applyAgentSelection(managedSkill.id, selectedAgents)}
          onUninstall={() => uninstall(managedSkill.id)}
          onClose={() => setManagedSkillId(null)}
        />
      )}
    </section>
  );
}

/**
 * The page behind the "Agent Hub" nav row: coding agents, then their extras.
 * One detection serves the whole page, so the agent row and every catalog chip
 * agree on which agents this machine actually has.
 */
export function AgentHubPage() {
  const installations = useAgentDetection();
  const availability = readAgentAvailability(installations);

  return (
    <PageShell title={PAGE_TITLE} subtitle={PAGE_SUBTITLE} testId="agent-hub">
      <AgentRow availability={availability} />

      {/* Figma pads the rule beyond the section gap rather than boxing it. */}
      <div className="flex w-full shrink-0 flex-col py-3">
        <span className="h-px w-full bg-separator" />
      </div>

      <CatalogSection availability={availability} />
    </PageShell>
  );
}
