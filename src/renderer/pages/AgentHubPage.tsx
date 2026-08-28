import { useState } from 'react';
import {
  CATALOG_TABS,
  HUB_AGENTS,
  PAGE_SUBTITLE,
  PAGE_TITLE,
  SECTION_HEADING,
  TAB_GROUP_LABEL,
  describeAgentAction,
  isAgentInstalled,
  readAgentAvailability,
  type AgentAvailability,
  type CatalogTab,
  type HubAgent
} from './agentHubContent';
import { DiscoverSkillsPage } from './DiscoverSkillsPage';
import { useAgentDetection } from '../hooks/useAgentDetection';
import { AgentMarkTile } from '../components/AgentMark';
import { McpCatalogTab } from '../components/McpCatalogTab';
import { PageShell } from '../components/PageShell';
import { PushButton } from '../components/PushButton';
import { SegmentedControl } from '../components/SegmentedControl';
import { SkillsCatalogTab } from '../components/SkillsCatalogTab';
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

interface CatalogSectionProps {
  availability: AgentAvailability;
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
function CatalogSection({ availability, onDiscoverSkills }: CatalogSectionProps) {
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
        <SkillsCatalogTab availability={availability} onDiscover={onDiscoverSkills} />
      ) : (
        <McpCatalogTab availability={availability} />
      )}
    </section>
  );
}

/**
 * The page behind the "Agent Hub" nav row: coding agents, then their extras.
 * One detection serves the whole page, so the agent row and every catalog chip
 * agree on which agents this machine actually has.
 *
 * "Discover Skill" swaps the whole page for the Discover Skills pane, which
 * returns here through the header's Back button.
 */
export function AgentHubPage() {
  const [isDiscoveringSkills, setIsDiscoveringSkills] = useState(false);
  const installations = useAgentDetection();
  const availability = readAgentAvailability(installations);

  if (isDiscoveringSkills) {
    return <DiscoverSkillsPage onBack={() => setIsDiscoveringSkills(false)} />;
  }

  return (
    <PageShell title={PAGE_TITLE} subtitle={PAGE_SUBTITLE} testId="agent-hub">
      <AgentRow availability={availability} />

      {/* Figma pads the rule beyond the section gap rather than boxing it. */}
      <div className="flex w-full shrink-0 flex-col py-3">
        <span className="h-px w-full bg-separator" />
      </div>

      <CatalogSection
        availability={availability}
        onDiscoverSkills={() => setIsDiscoveringSkills(true)}
      />
    </PageShell>
  );
}
