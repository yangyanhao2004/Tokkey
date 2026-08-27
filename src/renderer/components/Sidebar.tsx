import {
  NAV_ICON_BASE_PATH,
  NAV_SECTIONS,
  type NavItemId,
  type SidebarNavSection
} from '../navigation';
import { NavItem } from './NavItem';

/**
 * Figma draws the traffic lights, but the window runs with `hiddenInset`, so
 * macOS already paints real ones in this corner. Reserve the height the design
 * allots them (31.2px) and let the native controls show through.
 *
 * This strip stands in for the title bar the window does not have, so it is
 * also where the window is dragged from.
 */
function WindowControlsSpacer() {
  return <div className="app-drag h-[31.2px] w-full shrink-0" data-testid="window-controls" />;
}

function SidebarBrand() {
  // The logo asset is 49px square because it carries the drop shadow around the
  // 28px mark, so it is inset negatively rather than scaled down.
  return (
    // Nothing here is clickable, so the wordmark drags the window like the
    // strip above it rather than being a dead patch between two drag handles.
    <div className="app-drag flex items-center gap-2 px-2 pb-5" data-testid="sidebar-brand">
      <div className="relative size-7 shrink-0">
        <div className="absolute inset-[-25%_-37.5%_-50%_-37.5%]">
          <img
            className="block size-full max-w-none"
            src={`${NAV_ICON_BASE_PATH}/brand-tokii.svg`}
            alt=""
          />
        </div>
      </div>
      {/* The wordmark is "Tokiie" (node 227:3801); only the nav row and the
          account block spell the product "Tokiie". */}
      <span className="text-[16px] leading-[19px] font-bold tracking-[-0.2992px] text-text-primary">
        Tokiie
      </span>
    </div>
  );
}

interface SidebarSectionProps {
  section: SidebarNavSection;
  /** The first heading sits under the brand block, which already carries the space. */
  isFirst: boolean;
  activeItemId: NavItemId;
  onSelect: (id: NavItemId) => void;
}

function SidebarSection({ section, isFirst, activeItemId, onSelect }: SidebarSectionProps) {
  const spacing = isFirst ? 'pb-1' : 'pt-3 pb-1.5';

  return (
    <>
      <h2
        className={`${spacing} px-2 text-[8px] leading-[10px] font-black tracking-[0.7479px] text-text-secondary uppercase`}
      >
        {section.title}
      </h2>
      {section.items.map((item) => (
        <NavItem
          key={item.id}
          item={item}
          isActive={item.id === activeItemId}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}

function SidebarAccount() {
  return (
    <div className="mt-auto pt-8">
      <button
        type="button"
        className="flex min-h-[38px] w-full items-center gap-2 rounded-[10px] p-2 hover:bg-vibrant-tertiary/60 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-text-primary"
        data-testid="account-button"
      >
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full border-[0.714px] border-black/14 bg-white/72 text-[7.143px] leading-none font-black tracking-[0.0857px] text-black">
          IN
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-[0.831px] text-left">
          <span className="text-[12px] leading-[14px] font-bold text-text-primary">
            Tokiie Account
          </span>
          <span className="text-[10px] leading-[12px] tracking-[0.0997px] text-text-secondary">
            Sign In
          </span>
        </span>
      </button>
    </div>
  );
}

interface SidebarProps {
  activeItemId: NavItemId;
  onSelect: (id: NavItemId) => void;
}

/** The left navigation panel. Owns no state: the app decides what is selected. */
export function Sidebar({ activeItemId, onSelect }: SidebarProps) {
  return (
    <aside
      className="flex h-full w-[216px] shrink-0 flex-col gap-6 rounded-[20px] bg-vibrant-quinary p-3 backdrop-blur-[16px]"
      aria-label="Tokiie navigation"
      data-testid="sidebar"
    >
      <WindowControlsSpacer />
      <div className="flex min-h-px flex-1 flex-col">
        <SidebarBrand />
        <nav className="flex flex-col gap-1.5 overflow-auto">
          {NAV_SECTIONS.map((section, index) => (
            <SidebarSection
              key={section.title}
              section={section}
              isFirst={index === 0}
              activeItemId={activeItemId}
              onSelect={onSelect}
            />
          ))}
        </nav>
        <SidebarAccount />
      </div>
    </aside>
  );
}
