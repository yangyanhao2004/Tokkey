/**
 * Sidebar navigation model, taken from the Figma node "Aside - Tokii
 * navigation" (194:3812). Kept apart from the components so the rows can be
 * reordered or extended without touching markup.
 */

/**
 * Every destination the sidebar can select. Spelling the ids out keeps the
 * page lookup honest: a page can only be registered for a row that exists.
 */
export type NavItemId =
  | 'tokiie'
  | 'router'
  | 'agent-hub'
  | 'memory'
  | 'pet'
  | 'chat'
  | 'dashboard'
  | 'settings';

/** The row selected when the window opens. */
export const DEFAULT_NAV_ITEM_ID: NavItemId = 'tokiie';

/** A single navigation row. */
export interface SidebarNavItem {
  readonly id: NavItemId;
  readonly label: string;
  readonly iconFile: string;
  /**
   * Size of the glyph inside its 16px box. Figma draws most nav icons as a
   * 13.333px leaf, but a few are exported at the full box size. Written as a
   * class because the renderer's CSP forbids inline style attributes.
   */
  readonly iconSizeClass: string;
  /** Trailing status word, e.g. the "Ready" on the Tokiie row (node 192:2727). */
  readonly badge?: string;
}

/** A titled group of navigation rows, e.g. "Core". */
export interface SidebarNavSection {
  readonly title: string;
  readonly items: readonly SidebarNavItem[];
}

export const NAV_ICON_BASE_PATH = './assets/icons';

const DEFAULT_ICON_SIZE_CLASS = 'size-[13.333px]';

export const NAV_SECTIONS: readonly SidebarNavSection[] = [
  {
    title: 'Core',
    items: [
      {
        id: 'tokiie',
        label: 'Tokiie',
        iconFile: 'nav-tokiie.svg',
        iconSizeClass: DEFAULT_ICON_SIZE_CLASS,
        badge: 'Ready'
      },
      {
        id: 'router',
        label: 'Router',
        iconFile: 'nav-router.svg',
        iconSizeClass: DEFAULT_ICON_SIZE_CLASS
      },
      {
        id: 'agent-hub',
        label: 'Agent Hub',
        iconFile: 'nav-agent-hub.svg',
        iconSizeClass: DEFAULT_ICON_SIZE_CLASS
      },
      {
        id: 'memory',
        label: 'Memory',
        iconFile: 'nav-memory.svg',
        iconSizeClass: DEFAULT_ICON_SIZE_CLASS
      },
      {
        id: 'pet',
        label: 'Pet',
        iconFile: 'nav-pet.svg',
        iconSizeClass: DEFAULT_ICON_SIZE_CLASS
      }
    ]
  },
  {
    title: 'Workspace',
    items: [
      {
        id: 'chat',
        label: 'Chat',
        iconFile: 'nav-chat.svg',
        iconSizeClass: DEFAULT_ICON_SIZE_CLASS
      }
    ]
  },
  {
    title: 'System',
    items: [
      {
        id: 'dashboard',
        label: 'Dashboard',
        iconFile: 'nav-dashboard.svg',
        // Exported as a full-bleed 16px symbol rather than an inset leaf.
        iconSizeClass: 'size-4'
      },
      {
        id: 'settings',
        label: 'Settings',
        iconFile: 'nav-settings.svg',
        iconSizeClass: DEFAULT_ICON_SIZE_CLASS
      }
    ]
  }
];

/** Looks a row up across sections, e.g. to title the page it opens. */
export function findNavItem(id: NavItemId): SidebarNavItem | undefined {
  return NAV_SECTIONS.flatMap((section) => section.items).find((item) => item.id === id);
}
