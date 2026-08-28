import type { ReactNode } from 'react';
import {
  DISCOVER_TABS,
  SEARCH_PLACEHOLDER,
  TAB_GROUP_LABEL,
  type DiscoverTab
} from '../pages/discoverSkillsContent';
import { SearchField } from './SearchField';
import { SegmentedControl } from './SegmentedControl';

export interface DiscoverTabLayoutProps {
  /** The tab drawing this layout, which is the segment it marks as selected. */
  tab: DiscoverTab;
  onTabChange: (tab: DiscoverTab) => void;
  query: string;
  onQueryChange: (query: string) => void;
  /** Announced for the search box, whose label differs per tab. */
  searchLabel: string;
  /** The tab's own buttons, e.g. the Repos tab's "Add Repo". */
  actions?: ReactNode;
  /** The grid, plus whatever the tab draws in place of it. */
  children: ReactNode;
}

/**
 * The chrome both Discover Skills tabs repeat (Figma 198:9925 and 225:874): the
 * tab picker on the left, then the search box and the tab's actions together on
 * the right, and everything the tab draws below.
 *
 * This is the Agent Hub's `CatalogTabLayout` seen from the other side — there
 * the search leads the row and the picker sits above it — so the two stay apart
 * rather than growing a switch between two arrangements.
 *
 * It renders no wrapper of its own so the page it sits in keeps laying out these
 * rows directly, which is what holds the grid inside the window.
 */
export function DiscoverTabLayout({
  tab,
  onTabChange,
  query,
  onQueryChange,
  searchLabel,
  actions,
  children
}: DiscoverTabLayoutProps) {
  return (
    <>
      <div className="flex w-full shrink-0 items-center justify-between gap-2">
        <SegmentedControl
          options={DISCOVER_TABS}
          value={tab}
          onChange={onTabChange}
          label={TAB_GROUP_LABEL}
          testId="discover-tabs"
        />

        <div className="flex shrink-0 items-center gap-2">
          <div className="w-[120px] shrink-0">
            <SearchField
              value={query}
              onChange={onQueryChange}
              placeholder={SEARCH_PLACEHOLDER}
              label={searchLabel}
              testId="discover-search"
            />
          </div>

          {actions}
        </div>
      </div>

      {/* `min-h-0` keeps a listing of any length inside the page rather than
          pushing the window's content out of view. */}
      <div className="min-h-0 w-full flex-1 overflow-y-auto">{children}</div>
    </>
  );
}
