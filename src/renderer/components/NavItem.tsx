import { NAV_ICON_BASE_PATH, type SidebarNavItem } from '../navigation';

interface NavItemProps {
  item: SidebarNavItem;
}

/**
 * One sidebar row: a 16px icon box followed by its label. Presentation only —
 * the row is a real button so it is keyboard reachable once it does something.
 */
export function NavItem({ item }: NavItemProps) {
  // Figma specifies only the default and active fills; hover is added here so
  // the rows respond to the pointer, and sits below active in weight.
  const stateClasses = item.isActive
    ? 'bg-vibrant-tertiary'
    : 'hover:bg-vibrant-tertiary/60';

  return (
    <button
      type="button"
      className={`flex w-full items-center gap-1.5 rounded-[10px] px-2 py-1.5 ${stateClasses} focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-text-primary`}
      aria-current={item.isActive ? 'page' : undefined}
      data-testid={`nav-item-${item.id}`}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        <img
          className={`block max-w-none ${item.iconSizeClass}`}
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
      <span className="w-[106.172px] truncate text-left text-[12px] leading-[14px] font-medium text-black">
        {item.label}
      </span>
      {item.badge && (
        <span className="shrink-0 text-[10px] leading-[12px] font-semibold text-black">
          {item.badge}
        </span>
      )}
    </button>
  );
}
