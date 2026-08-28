import { useState } from 'react';
import { readAgentAvailability } from './agentHubContent';
import { PAGE_SUBTITLE, PAGE_TITLE, type DiscoverTab } from './discoverSkillsContent';
import { useAgentDetection } from '../hooks/useAgentDetection';
import { DiscoverReposTab } from '../components/DiscoverReposTab';
import { PageShell } from '../components/PageShell';
import { SkillsShTab } from '../components/SkillsShTab';

interface DiscoverSkillsPageProps {
  /** Returns to the Agent Hub; also drives the header's back button. */
  onBack: () => void;
}

/**
 * The pane behind the Agent Hub's "Discover Skill" button (Figma 198:9865):
 * skills Tokiie can install, from cloned repositories or from skills.sh.
 *
 * Only the open tab is mounted, so each one owns its own search box and its own
 * listing — and switching tabs leaves neither behind. One detection serves both,
 * so every card's chips agree on which agents this machine actually has.
 */
export function DiscoverSkillsPage({ onBack }: DiscoverSkillsPageProps) {
  const [tab, setTab] = useState<DiscoverTab>('repos');
  const availability = readAgentAvailability(useAgentDetection());

  return (
    <PageShell title={PAGE_TITLE} subtitle={PAGE_SUBTITLE} testId="discover-skills" onBack={onBack}>
      {tab === 'repos' ? (
        <DiscoverReposTab availability={availability} onTabChange={setTab} />
      ) : (
        <SkillsShTab availability={availability} onTabChange={setTab} />
      )}
    </PageShell>
  );
}
