import { PaneShell, PanePlaceholder } from './PaneShell';

/** The pane behind the "Agent Hub" nav row. Awaiting its design. */
export function AgentHubPane() {
  return (
    <PaneShell
      title="Agent Hub"
      subtitle="Install and manage the agents that run on this Mac."
      testId="agent-hub"
    >
      <PanePlaceholder>The agent hub is not built yet.</PanePlaceholder>
    </PaneShell>
  );
}
