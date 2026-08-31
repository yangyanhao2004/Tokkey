import { NAV_ICON_BASE_PATH, type NavItemId, type SidebarNavItem } from '../navigation';

interface NavItemProps {
  item: SidebarNavItem;
  isActive: boolean;
  isDarkTheme: boolean;
  onSelect: (id: NavItemId) => void;
}

/**
 * One sidebar row: a 16px icon box followed by its label. Selecting it is what
 * swaps the page on the right, so the row is a real button.
 */
export function NavItem({ item, isActive, isDarkTheme, onSelect }: NavItemProps) {
  // Figma specifies only the default and active fills; hover is added here so
  // the rows respond to the pointer, and sits below active in weight.
  const stateClasses = isActive
    ? 'bg-vibrant-tertiary'
    : isDarkTheme ? 'hover:bg-white/10' : 'hover:bg-vibrant-tertiary/60';
  const textClasses = isActive ? 'text-black' : isDarkTheme ? 'text-white' : 'text-black';

  return (
    <button
      type="button"
      className={`flex w-full items-center gap-1.5 rounded-[10px] px-2 py-1.5 ${stateClasses} focus-visible:outline-2 focus-visible:outline-offset-1 ${isDarkTheme ? 'focus-visible:outline-white' : 'focus-visible:outline-text-primary'}`}
      aria-current={isActive ? 'page' : undefined}
      onClick={() => onSelect(item.id)}
      data-testid={`nav-item-${item.id}`}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        <img
          className={`block max-w-none ${item.iconSizeClass} ${isActive || !isDarkTheme ? '' : 'brightness-0 invert'}`}
          src={`${NAV_ICON_BASE_PATH}/${item.iconFile}`}
          alt=""
        />
      </span>
      {/*
        Figma gives the label a fixed 106.172px box rather than letting it size
        to its text, which is what pushes the badge to a consistent x=142.17
        across rows. Keep the width so a longer label truncates instead of
        shifting the badge.
      */}
      <span className={`w-[106.172px] truncate text-left text-[12px] leading-[14px] font-medium ${textClasses}`}>
        {item.label}
      </span>
      {item.badge && (
        <span className={`shrink-0 text-[10px] leading-[12px] font-semibold ${textClasses}`}>
          {item.badge}
        </span>
      )}
    </button>
  );
}
