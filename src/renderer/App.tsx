import type { ComponentType } from 'react';
import { type NavItemId } from './navigation';
import { navItemIdForRoute, type RouteId } from './routing';
import { AgentDetectionProvider } from './components/AgentDetectionProvider';
import { NavigationProvider, useNavigation } from './components/NavigationProvider';
import { Sidebar } from './components/Sidebar';
import { AddModelPage } from './pages/AddModelPage';
import { AgentHubPage } from './pages/AgentHubPage';
import { DiscoverSkillsPage } from './pages/DiscoverSkillsPage';
import { RouterPage } from './pages/RouterPage';
import { TokiiePage } from './pages/TokiiePage';
import { UnbuiltPage } from './pages/UnbuiltPage';

/**
 * Pages that exist today. A nav row missing from here still navigates, it just
 * lands on the generic placeholder below, so rows and pages can land apart.
 */
const PAGE_BY_ROUTE: Partial<Record<RouteId, ComponentType>> = {
  tokiie: TokiiePage,
  router: RouterPage,
  'agent-hub': AgentHubPage,
  'add-model': AddModelPage,
  'discover-skills': DiscoverSkillsPage
};

/**
 * Sidebar plus whichever page the current route names. Selecting a row is a
 * navigation like any other, so it lands in the history the header walks.
 */
function AppFrame() {
  const { route, navigate } = useNavigation();
  const ActivePage = PAGE_BY_ROUTE[route];

  return (
    <>
      <Sidebar
        activeItemId={navItemIdForRoute(route)}
        onSelect={(id: NavItemId) => navigate(id)}
      />
      {ActivePage ? <ActivePage /> : <UnbuiltPage navItemId={navItemIdForRoute(route)} />}
    </>
  );
}

/**
 * Application shell: one history and one agent detection, shared by every page
 * inside them.
 */
export function App() {
  return (
    <NavigationProvider>
      <AgentDetectionProvider>
        <AppFrame />
      </AgentDetectionProvider>
    </NavigationProvider>
  );
}
