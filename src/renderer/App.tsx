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
import { PetPage } from './pages/PetPage';
import { TokkeyPage } from './pages/TokkeyPage';
import { ChatPage } from './pages/ChatPage';
import { UnbuiltPage } from './pages/UnbuiltPage';
import { SignInPage } from './pages/SignInPage';
import { AccountProvider, useAccount } from './components/AccountProvider';

/**
 * Pages that exist today. A nav row missing from here still navigates, it just
 * lands on the generic placeholder below, so rows and pages can land apart.
 */
const PAGE_BY_ROUTE: Partial<Record<RouteId, ComponentType>> = {
  tokkey: TokkeyPage,
  router: RouterPage,
  pet: PetPage,
  'agent-hub': AgentHubPage,
  chat: ChatPage,
  'add-model': AddModelPage,
  'discover-skills': DiscoverSkillsPage,
  'sign-in': SignInPage
};

/**
 * Sidebar plus whichever page the current route names. Selecting a row is a
 * navigation like any other, so it lands in the history the header walks.
 */
function AppFrame() {
  const { route, navigate } = useNavigation();
  const { state: accountState } = useAccount();
  const ActivePage = PAGE_BY_ROUTE[route];
  const isChatActive = route === 'chat';
  const isAccountPaneOpen = route === 'sign-in';

  return (
    <div
      className={isChatActive ? 'app-theme-chat contents' : 'app-theme-light contents'}
      data-theme={isChatActive ? 'chat' : 'light'}
    >
      <Sidebar
        activeItemId={isAccountPaneOpen ? undefined : navItemIdForRoute(route)}
        isDarkTheme={isChatActive}
        accountProfile={accountState.profile}
        onSelect={(id: NavItemId) => navigate(id)}
        onAccountSelect={() => navigate('sign-in')}
      />
      {ActivePage ? <ActivePage /> : <UnbuiltPage navItemId={navItemIdForRoute(route)} />}
    </div>
  );
}

/**
 * Application shell: one history and one agent detection, shared by every page
 * inside them.
 */
export function App() {
  return (
    <NavigationProvider>
      <AccountProvider>
        <AgentDetectionProvider>
          <AppFrame />
        </AgentDetectionProvider>
      </AccountProvider>
    </NavigationProvider>
  );
}
