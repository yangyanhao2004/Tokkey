import { useState, type ComponentType } from 'react';
import { DEFAULT_NAV_ITEM_ID, type NavItemId } from './navigation';
import { AgentDetectionProvider } from './components/AgentDetectionProvider';
import { Sidebar } from './components/Sidebar';
import { AgentHubPage } from './pages/AgentHubPage';
import { RouterPage } from './pages/RouterPage';
import { TokiiePage } from './pages/TokiiePage';
import { UnbuiltPage } from './pages/UnbuiltPage';

/**
 * Pages that exist today. A row missing from here still navigates, it just
 * lands on the generic placeholder below, so rows and pages can land apart.
 */
const PAGE_BY_NAV_ID: Partial<Record<NavItemId, ComponentType>> = {
  tokiie: TokiiePage,
  router: RouterPage,
  'agent-hub': AgentHubPage
};

/**
 * Application shell. Holds which nav row is selected and renders that row's
 * page beside the sidebar, under the one agent detection every page reads.
 */
export function App() {
  const [activeNavItemId, setActiveNavItemId] = useState<NavItemId>(DEFAULT_NAV_ITEM_ID);
  const ActivePage = PAGE_BY_NAV_ID[activeNavItemId];

  return (
    <AgentDetectionProvider>
      <Sidebar activeItemId={activeNavItemId} onSelect={setActiveNavItemId} />
      {ActivePage ? <ActivePage /> : <UnbuiltPage navItemId={activeNavItemId} />}
    </AgentDetectionProvider>
  );
}
