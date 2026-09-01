import {
  NAV_ICON_BASE_PATH,
  NAV_SECTIONS,
  type NavItemId,
  type SidebarNavSection
} from '../navigation';
import { NavItem } from './NavItem';
import type { AccountProfile } from '../../shared/types';

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

function SidebarBrand({ isDarkTheme }: { isDarkTheme: boolean }) {
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
      <span className={`text-[16px] leading-[19px] font-bold tracking-[-0.2992px] ${isDarkTheme ? 'text-white' : 'text-text-primary'}`}>
        Tokiie
      </span>
    </div>
  );
}

interface SidebarSectionProps {
  section: SidebarNavSection;
  /** The first heading sits under the brand block, which already carries the space. */
  isFirst: boolean;
  isDarkTheme: boolean;
  activeItemId?: NavItemId;
  onSelect: (id: NavItemId) => void;
}

function SidebarSection({ section, isFirst, isDarkTheme, activeItemId, onSelect }: SidebarSectionProps) {
  const spacing = isFirst ? 'pb-1' : 'pt-3 pb-1.5';

  return (
    <>
      <h2
        className={`${spacing} px-2 text-[8px] leading-[10px] font-black tracking-[0.7479px] uppercase ${isDarkTheme ? 'text-white/50' : 'text-text-secondary'}`}
      >
        {section.title}
      </h2>
      {section.items.map((item) => (
        <NavItem
          key={item.id}
          item={item}
          isActive={item.id === activeItemId}
          isDarkTheme={isDarkTheme}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}

interface SidebarAccountProps {
  isDarkTheme: boolean;
  profile: AccountProfile | null;
  onSelect: () => void;
}

/** Opens the account pane and projects only the renderer-safe public profile. */
function SidebarAccount({ isDarkTheme, profile, onSelect }: SidebarAccountProps) {
  const accountTextClasses = isDarkTheme ? 'text-white' : 'text-text-primary';
  const accountSecondaryClasses = isDarkTheme ? 'text-white/60' : 'text-text-secondary';
  const displayName = profile?.displayName?.trim() || 'Tokiie Account';
  const secondaryText = profile?.email ?? 'Sign In';
  const initial = profile ? displayName.charAt(0).toUpperCase() : 'IN';

  return (
    <div className="mt-auto pt-8">
      <button
        type="button"
        onClick={onSelect}
        className={`flex min-h-[38px] w-full items-center gap-2 rounded-[10px] p-2 focus-visible:outline-2 focus-visible:outline-offset-1 ${isDarkTheme ? 'hover:bg-white/10 focus-visible:outline-white' : 'hover:bg-vibrant-tertiary/60 focus-visible:outline-text-primary'}`}
        data-testid="account-button"
      >
        <span className={`flex size-5 shrink-0 items-center justify-center rounded-full text-[7.143px] leading-none font-black tracking-[0.0857px] ${isDarkTheme ? 'border-[0.714px] border-white/20 bg-white/10 text-white' : 'border-[0.714px] border-black/14 bg-white/72 text-black'}`}>
          {initial}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-[0.831px] text-left">
          <span className={`truncate text-[12px] leading-[14px] font-bold ${accountTextClasses}`}>
            {displayName}
          </span>
          <span className={`truncate text-[10px] leading-[12px] tracking-[0.0997px] ${accountSecondaryClasses}`}>
            {secondaryText}
          </span>
        </span>
      </button>
    </div>
  );
}

interface SidebarProps {
  activeItemId?: NavItemId;
  isDarkTheme: boolean;
  accountProfile: AccountProfile | null;
  onSelect: (id: NavItemId) => void;
  onAccountSelect: () => void;
}

/** The left navigation panel. Owns no state: the app decides what is selected. */
export function Sidebar({
  activeItemId,
  isDarkTheme,
  accountProfile,
  onSelect,
  onAccountSelect
}: SidebarProps) {
  const surfaceClasses = isDarkTheme ? 'bg-chat-sidebar' : 'bg-vibrant-quinary';

  return (
    <aside
      className={`flex h-full w-[216px] shrink-0 flex-col gap-6 rounded-[20px] p-3 backdrop-blur-[16px] ${surfaceClasses}`}
      aria-label="Tokiie navigation"
      data-testid="sidebar"
    >
      <WindowControlsSpacer />
      <div className="flex min-h-px flex-1 flex-col">
        <SidebarBrand isDarkTheme={isDarkTheme} />
        <nav className="flex flex-col gap-1.5 overflow-auto">
          {NAV_SECTIONS.map((section, index) => (
            <SidebarSection
              key={section.title}
              section={section}
              isFirst={index === 0}
              isDarkTheme={isDarkTheme}
              activeItemId={activeItemId}
              onSelect={onSelect}
            />
          ))}
        </nav>
        <SidebarAccount
          isDarkTheme={isDarkTheme}
          profile={accountProfile}
          onSelect={onAccountSelect}
        />
      </div>
    </aside>
  );
}
