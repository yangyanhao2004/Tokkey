/**
 * Where the window can be. Sidebar rows are routes, and so are the panes a page
 * opens on top of itself ("Add model", "Discover Skill"), because the header's
 * Back and Forward buttons have to treat both the same way.
 */

import { DEFAULT_NAV_ITEM_ID, type NavItemId } from './navigation';

/** A sub-page: reachable from a nav page, but with no sidebar row of its own. */
export type SubRouteId = 'add-model' | 'discover-skills';

export type RouteId = NavItemId | SubRouteId;

/**
 * The row that stays highlighted while a sub-page is open, so opening "Add
 * model" from Tokiie still reads as being inside Tokiie.
 */
const NAV_ITEM_BY_SUB_ROUTE: Record<SubRouteId, NavItemId> = {
  'add-model': 'tokiie',
  'discover-skills': 'agent-hub'
};

/** The sidebar row a route belongs to. Nav routes are their own row. */
export function navItemIdForRoute(route: RouteId): NavItemId {
  return route in NAV_ITEM_BY_SUB_ROUTE
    ? NAV_ITEM_BY_SUB_ROUTE[route as SubRouteId]
    : (route as NavItemId);
}

/** The route the window opens on. */
export const DEFAULT_ROUTE: RouteId = DEFAULT_NAV_ITEM_ID;

/**
 * A browser-style history: visited routes plus a cursor into them.
 *
 * Immutable — every move returns a new history — so it can be held in React
 * state and compared by identity. Kept out of the components because "what
 * Forward does after you navigate from the middle of the stack" is a rule
 * about history, not about markup.
 */
export class NavigationHistory {
  private constructor(
    private readonly entries: readonly RouteId[],
    private readonly index: number
  ) {}

  /** A history holding a single route, with nowhere to go back or forward to. */
  static of(route: RouteId): NavigationHistory {
    return new NavigationHistory([route], 0);
  }

  get current(): RouteId {
    return this.entries[this.index];
  }

  get canGoBack(): boolean {
    return this.index > 0;
  }

  get canGoForward(): boolean {
    return this.index < this.entries.length - 1;
  }

  /**
   * Visits a route. Like a browser, a new visit drops whatever was ahead of the
   * cursor; re-selecting the current route is a no-op rather than a duplicate
   * entry, so clicking the open nav row does not stack up Back steps.
   */
  push(route: RouteId): NavigationHistory {
    if (route === this.current) {
      return this;
    }
    return new NavigationHistory([...this.entries.slice(0, this.index + 1), route], this.index + 1);
  }

  back(): NavigationHistory {
    return this.canGoBack ? new NavigationHistory(this.entries, this.index - 1) : this;
  }

  forward(): NavigationHistory {
    return this.canGoForward ? new NavigationHistory(this.entries, this.index + 1) : this;
  }
}
