import { useState, type ComponentType } from 'react';
import { DEFAULT_NAV_ITEM_ID, findNavItem, type NavItemId } from '../navigation';
import { AgentHubPane } from './AgentHubPane';
import { PaneShell, PanePlaceholder } from './PaneShell';
import { RouterPane } from './RouterPane';
import { Sidebar } from './Sidebar';
import { TokiiePane } from './TokiiePane';

/**
 * Panes that exist today. A row missing from here still navigates, it just
 * lands on the generic placeholder below, so rows and panes can land apart.
 */
const PANE_BY_NAV_ID: Partial<Record<NavItemId, ComponentType>> = {
  tokiie: TokiiePane,
  router: RouterPane,
  'agent-hub': AgentHubPane
};

/** Stand-in for a nav row whose pane has not been designed yet. */
function UnbuiltPane({ navItemId }: { navItemId: NavItemId }) {
  const label = findNavItem(navItemId)?.label ?? navItemId;

  return (
    <PaneShell title={label} subtitle="This section is coming soon." testId={navItemId}>
      <PanePlaceholder>{label} is not built yet.</PanePlaceholder>
    </PaneShell>
  );
}

/**
 * Application shell. Holds the one piece of state the whole window shares —
 * which nav row is selected — and renders that row's pane beside the sidebar.
 */
export function App() {
  const [activeNavItemId, setActiveNavItemId] = useState<NavItemId>(DEFAULT_NAV_ITEM_ID);
  const ActivePane = PANE_BY_NAV_ID[activeNavItemId];

  return (
    <>
      <Sidebar activeItemId={activeNavItemId} onSelect={setActiveNavItemId} />
      {ActivePane ? <ActivePane /> : <UnbuiltPane navItemId={activeNavItemId} />}
    </>
  );
}
