import { useState, type ComponentType } from 'react';
import { DEFAULT_NAV_ITEM_ID, type NavItemId } from './navigation';
import { Sidebar } from './components/Sidebar';
import { AgentHubPage } from './pages/AgentHubPage';
import { RouterPage } from './pages/RouterPage';
import { TokiiePage } from './pages/TokiiePage';
import { ChatPage } from './pages/ChatPage';
import { UnbuiltPage } from './pages/UnbuiltPage';

/**
 * Pages that exist today. A row missing from here still navigates, it just
 * lands on the generic placeholder below, so rows and pages can land apart.
 */
const PAGE_BY_NAV_ID: Partial<Record<NavItemId, ComponentType>> = {
  tokiie: TokiiePage,
  router: RouterPage,
  'agent-hub': AgentHubPage,
  chat: ChatPage
};

/**
 * Application shell. Holds the one piece of state the whole window shares —
 * which nav row is selected — and renders that row's page beside the sidebar.
 */
export function App() {
  const [activeNavItemId, setActiveNavItemId] = useState<NavItemId>(DEFAULT_NAV_ITEM_ID);
  const ActivePage = PAGE_BY_NAV_ID[activeNavItemId];

  return (
    <>
      <Sidebar activeItemId={activeNavItemId} onSelect={setActiveNavItemId} />
      {ActivePage ? <ActivePage /> : <UnbuiltPage navItemId={activeNavItemId} />}
    </>
  );
}
