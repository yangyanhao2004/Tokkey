import { useEffect, useState } from 'react';
import { PAGE_SUBTITLE, PAGE_TITLE, type DiscoverTab } from './discoverSkillsContent';
import { useAgentDetectionRefresh } from '../components/AgentDetectionProvider';
import { DiscoverReposTab } from '../components/DiscoverReposTab';
import { PageShell } from '../components/PageShell';
import { SkillsShTab } from '../components/SkillsShTab';

/**
 * The pane behind the Agent Hub's "Discover Skill" button (Figma 198:9865):
 * skills Tokkey can install, from cloned repositories or from skills.sh.
 *
 * Only the open tab is mounted, so each one owns its own search box and its own
 * listing — and switching tabs leaves neither behind. Every card's chips read
 * the shared detection, so they all agree on which agents this machine has.
 */
export function DiscoverSkillsPage() {
  const [tab, setTab] = useState<DiscoverTab>('repos');
  const refreshAgentDetection = useAgentDetectionRefresh();

  // Opening the pane re-probes PATH: an agent can be installed from a terminal
  // while the app is open, and the chips here are what would go stale.
  useEffect(() => {
    refreshAgentDetection();
  }, [refreshAgentDetection]);

  return (
    <PageShell title={PAGE_TITLE} subtitle={PAGE_SUBTITLE} testId="discover-skills">
      {tab === 'repos' ? (
        <DiscoverReposTab onTabChange={setTab} />
      ) : (
        <SkillsShTab onTabChange={setTab} />
      )}
    </PageShell>
  );
}
