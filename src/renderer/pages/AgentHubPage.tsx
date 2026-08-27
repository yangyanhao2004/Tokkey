import { useState } from 'react';
import {
  CATALOG_TABS,
  HUB_AGENTS,
  ICON_BASE_PATH,
  MANAGE_LABEL,
  PAGE_SUBTITLE,
  PAGE_TITLE,
  SEARCH_LABEL,
  SEARCH_PLACEHOLDER,
  SECTION_HEADING,
  TAB_GROUP_LABEL,
  WORKS_WITH_LABEL,
  describeAgentAction,
  describeCompatibility,
  describeDiscoverAction,
  describeEmptyCatalog,
  describeUploadAction,
  findAgent,
  selectCatalogEntries,
  type AgentId,
  type CatalogEntry,
  type CatalogTab,
  type CompatibilityChip,
  type CompatibilityState,
  type HubAgent
} from './agentHubContent';
import { PageShell } from '../components/PageShell';
import { PushButton } from '../components/PushButton';
import { SearchField } from '../components/SearchField';
import { SegmentedControl } from '../components/SegmentedControl';
import { TitleBlock } from '../components/TitleBlock';

interface AgentArtwork {
  /** Mark for the agent row's tile, drawn over `tileClass`. */
  readonly markFile: string;
  readonly tileClass: string;
  readonly markClass: string;
  /** Round mark for a compatibility chip, drawn over `avatarClass`. */
  readonly avatarFile: string;
  readonly avatarClass: string;
  readonly avatarMarkClass: string;
}

/**
 * Each agent's own artwork, from the Amis PC library: the row tile (Claude
 * 426:910, Codex 426:923) and the chip avatar (Claude 1051:3869, Codex
 * 1051:3881). Both designs size the mark as a fraction of the box it sits in,
 * so every dimension here stays explicit rather than being filled.
 *
 * These are classes rather than style attributes because the renderer's CSP
 * forbids inline styles, and they live beside the components that draw them
 * rather than in the content module, which owns copy instead of appearance.
 */
const AGENT_ARTWORK: Record<AgentId, AgentArtwork> = {
  'claude-code': {
    markFile: 'agent-claude-mark.svg',
    // A flat brand fill lit by the white top-down wash Figma lays over it.
    tileClass: 'bg-agent-claude bg-linear-to-b from-white/20 to-transparent',
    // Figma insets the mark 10% on every side of the tile.
    markClass: 'size-[22.4px]',
    // The chip avatar ships its own tinted disc, so the box behind it is bare.
    avatarFile: 'agent-claude-avatar.svg',
    avatarClass: '',
    avatarMarkClass: 'size-[20px]'
  },
  codex: {
    markFile: 'agent-codex-mark.png',
    // Figma's tile is plain white; the hairline keeps it off the white card.
    tileClass: 'bg-white ring-1 ring-tile-border',
    // Inset 5% top and bottom, and near enough square to letterbox itself.
    markClass: 'size-[25.2px] object-contain',
    avatarFile: 'agent-codex-mark.png',
    avatarClass: 'bg-agent-codex/10',
    avatarMarkClass: 'size-[14px] object-contain'
  }
};

interface AgentMarkTileProps {
  agentId: AgentId;
}

/**
 * The 28px tile fronting an agent card. Each agent brings its own background
 * and mark, so unlike the shared `IconTile` this one carries no recess of its
 * own — the artwork is the tile.
 */
function AgentMarkTile({ agentId }: AgentMarkTileProps) {
  const artwork = AGENT_ARTWORK[agentId];

  return (
    <span
      className={`flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-[5.385px] ${artwork.tileClass}`}
    >
      <img
        className={`block max-w-none ${artwork.markClass}`}
        src={`${ICON_BASE_PATH}/${artwork.markFile}`}
        alt=""
      />
    </span>
  );
}

interface AgentCardProps {
  agent: HubAgent;
}

/** One installable coding agent: its glyph, name, vendor, and single action. */
function AgentCard({ agent }: AgentCardProps) {
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
          variant={agent.isInstalled ? 'plain' : 'filled'}
          testId={`agent-action-${agent.id}`}
        >
          {describeAgentAction(agent)}
        </PushButton>
      </div>
    </article>
  );
}

/** The agents the hub manages, side by side across the top of the page. */
function AgentRow() {
  return (
    <section className="flex w-full shrink-0 items-start gap-2" data-testid="agent-row">
      {HUB_AGENTS.map((agent) => (
        <AgentCard key={agent.id} agent={agent} />
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
}

/**
 * One agent's standing with a catalog entry, drawn as the agent's round mark.
 * An enabled entry adds the green check that overhangs the mark's bottom-right
 * corner, so neither this box nor the row it sits in may clip.
 */
function CompatibilityChipMark({ chip }: CompatibilityChipProps) {
  const agent = findAgent(chip.agentId);
  if (!agent) {
    return null;
  }

  const artwork = AGENT_ARTWORK[chip.agentId];

  return (
    <span
      className="relative flex size-[20px] shrink-0"
      title={describeCompatibility(chip)}
      data-testid={`compat-chip-${chip.agentId}`}
    >
      <span
        className={`flex size-full items-center justify-center overflow-hidden rounded-full ${artwork.avatarClass} ${CHIP_STATE_CLASSES[chip.state]}`}
      >
        <img
          className={`block max-w-none ${artwork.avatarMarkClass}`}
          src={`${ICON_BASE_PATH}/${artwork.avatarFile}`}
          alt=""
        />
      </span>

      {chip.state === 'enabled' && (
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
}

/**
 * One skill or MCP: what it is on top, which agents it works with underneath.
 * The card is at least as tall as the design's fixed 148px but grows rather
 * than clipping, since a longer description would otherwise spill out.
 */
function CatalogCard({ entry }: CatalogCardProps) {
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
        <p className="w-full text-[10px] leading-[12px] text-text-secondary">{entry.description}</p>
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
              <CompatibilityChipMark key={chip.agentId} chip={chip} />
            ))}
          </div>

          <PushButton variant="plain-dark" testId={`catalog-manage-${entry.id}`}>
            {MANAGE_LABEL}
          </PushButton>
        </div>
      </div>
    </article>
  );
}

/**
 * "Skills & MCPs": the tab picker, the search and add actions, then the grid
 * of whatever the open tab holds. The tab and query are the section's own
 * state — nothing here reaches the main process yet.
 */
function CatalogSection() {
  const [tab, setTab] = useState<CatalogTab>('skills');
  const [query, setQuery] = useState('');
  const entries = selectCatalogEntries(tab, query);

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
        {entries.length === 0 && (
          <p
            className="w-full py-2 text-[10px] leading-[12px] text-text-secondary"
            data-testid="catalog-empty"
          >
            {describeEmptyCatalog(tab, query)}
          </p>
        )}

        <div className="grid w-full grid-cols-2 gap-3">
          {entries.map((entry) => (
            <CatalogCard key={entry.id} entry={entry} />
          ))}
        </div>
      </div>
    </section>
  );
}

/** The page behind the "Agent Hub" nav row: coding agents, then their extras. */
export function AgentHubPage() {
  return (
    <PageShell title={PAGE_TITLE} subtitle={PAGE_SUBTITLE} testId="agent-hub">
      <AgentRow />

      {/* Figma pads the rule beyond the section gap rather than boxing it. */}
      <div className="flex w-full shrink-0 flex-col py-3">
        <span className="h-px w-full bg-separator" />
      </div>

      <CatalogSection />
    </PageShell>
  );
}
