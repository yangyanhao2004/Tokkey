import { PageShell, PagePlaceholder } from '../components/PageShell';

/** The page behind the "Router" nav row. Awaiting its design. */
export function RouterPage() {
  return (
    <PageShell
      title="Router"
      subtitle="Choose which model answers each client request."
      testId="router"
    >
      <PagePlaceholder>Router settings are not built yet.</PagePlaceholder>
    </PageShell>
  );
}
