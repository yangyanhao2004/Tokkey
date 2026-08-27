import { PageShell, PagePlaceholder } from '../components/PageShell';

/** The page behind the "Agent Hub" nav row. Awaiting its design. */
export function AgentHubPage() {
  return (
    <PageShell
      title="Agent Hub"
      subtitle="Install and manage the agents that run on this Mac."
      testId="agent-hub"
    >
      <PagePlaceholder>The agent hub is not built yet.</PagePlaceholder>
    </PageShell>
  );
}
