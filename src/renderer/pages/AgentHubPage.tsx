import { useEffect, useState } from 'react';
import {
  CATALOG_TABS,
  HUB_AGENTS,
  PAGE_SUBTITLE,
  PAGE_TITLE,
  SECTION_HEADING,
  TAB_GROUP_LABEL,
  describeAgentStatus,
  resolveAgentStatus,
  type CatalogTab,
  type AgentStatus,
  type HubAgent
} from './agentHubContent';
import {
  useAgentAvailability,
  useAgentDetectionRefresh
} from '../components/AgentDetectionProvider';
import { AgentMarkTile } from '../components/AgentMark';
import { McpCatalogTab } from '../components/McpCatalogTab';
import { useNavigation } from '../components/NavigationProvider';
import { PageShell } from '../components/PageShell';
import { SegmentedControl } from '../components/SegmentedControl';
import { SkillsCatalogTab } from '../components/SkillsCatalogTab';
import { TitleBlock } from '../components/TitleBlock';

/** Read-only detection tones; installed matches Figma Push Button 531:2433. */
const AGENT_STATUS_CLASSES: Readonly<Record<AgentStatus, string>> = {
  checking: 'rounded-[6px] bg-fill-tile text-text-secondary',
  installed: 'rounded-[6px] text-label-tertiary',
  notInstalled: 'rounded-[6px] bg-status-idle-bg text-status-idle-text'
};

interface AgentCardProps {
  agent: HubAgent;
}

/** One detected coding agent: its glyph, identity, and read-only availability. */
function AgentCard({ agent }: AgentCardProps) {
  const availability = useAgentAvailability();
  const status = resolveAgentStatus(availability, agent.id);

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
        <span
          className={`flex h-[24px] shrink-0 items-center overflow-hidden px-2 text-[10px] leading-[16px] font-medium ${AGENT_STATUS_CLASSES[status]}`}
          role="status"
          aria-live="polite"
          data-testid={`agent-status-${agent.id}`}
        >
          {describeAgentStatus(status)}
        </span>
      </div>
    </article>
  );
}

/** The agents the hub detects, side by side across the top of the page. */
function AgentRow() {
  return (
    <section className="flex w-full shrink-0 items-start gap-2" data-testid="agent-row">
      {HUB_AGENTS.map((agent) => (
        <AgentCard key={agent.id} agent={agent} />
      ))}
    </section>
  );
}

interface CatalogSectionProps {
  /** Opens the Discover Skills pane, which only the "Skills" tab offers. */
  onDiscoverSkills: () => void;
}

/**
 * "Skills & MCPs": the heading and the tab picker, then whichever tab is open.
 *
 * Only the open tab is mounted, so each one owns its own search box, its own
 * data, and whatever it says about its last action — and switching tabs leaves
 * none of that behind.
 */
function CatalogSection({ onDiscoverSkills }: CatalogSectionProps) {
  const [tab, setTab] = useState<CatalogTab>('skills');

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

      {tab === 'skills' ? (
        <SkillsCatalogTab onDiscover={onDiscoverSkills} />
      ) : (
        <McpCatalogTab />
      )}
    </section>
  );
}

/**
 * The page behind the "Agent Hub" nav row: coding agents, then their extras.
 * The agent row and every catalog chip read the one shared detection, so they
 * agree on which agents this machine actually has.
 *
 * "Discover Skill" navigates to the Discover Skills pane, which the header's
 * Back button returns from like any other move.
 */
export function AgentHubPage() {
  const { navigate } = useNavigation();
  const refreshAgentDetection = useAgentDetectionRefresh();

  // Opening the hub re-probes PATH, so installing an agent from a terminal and
  // coming back here shows the new answer rather than the one from app start.
  useEffect(() => {
    refreshAgentDetection();
  }, [refreshAgentDetection]);

  return (
    <PageShell title={PAGE_TITLE} subtitle={PAGE_SUBTITLE} testId="agent-hub">
      <AgentRow />

      {/* Figma pads the rule beyond the section gap rather than boxing it. */}
      <div className="flex w-full shrink-0 flex-col py-3">
        <span className="h-px w-full bg-separator" />
      </div>

      <CatalogSection onDiscoverSkills={() => navigate('discover-skills')} />
    </PageShell>
  );
}
