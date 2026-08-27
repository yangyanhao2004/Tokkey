import { findNavItem, type NavItemId } from '../navigation';
import { PageShell, PagePlaceholder } from '../components/PageShell';

/** Stand-in for a nav row whose page has not been designed yet. */
export function UnbuiltPage({ navItemId }: { navItemId: NavItemId }) {
  const label = findNavItem(navItemId)?.label ?? navItemId;

  return (
    <PageShell title={label} subtitle="This section is coming soon." testId={navItemId}>
      <PagePlaceholder>{label} is not built yet.</PagePlaceholder>
    </PageShell>
  );
}
