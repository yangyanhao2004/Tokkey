import { PaneShell, PanePlaceholder } from './PaneShell';

/** The pane behind the "Router" nav row. Awaiting its design. */
export function RouterPane() {
  return (
    <PaneShell
      title="Router"
      subtitle="Choose which model answers each client request."
      testId="router"
    >
      <PanePlaceholder>Router settings are not built yet.</PanePlaceholder>
    </PaneShell>
  );
}
