import { NAV_ICON_BASE_PATH as ICON_BASE_PATH } from '../navigation';

interface PopUpButtonProps {
  /** The current selection, e.g. "All providers". */
  label: string;
  testId?: string;
}

/**
 * The AppKit pop-up button (Figma "Pop-Up Button", node 121:12028): a 5% black
 * chip whose label is followed by the chevron.up.chevron.down glyph in its own
 * 24px box. Presentation only for now - it opens no menu.
 */
export function PopUpButton({ label, testId }: PopUpButtonProps) {
  return (
    <button
      type="button"
      className="flex h-[24px] shrink-0 items-center gap-2 overflow-hidden rounded-[6px] bg-black/5 pl-3 text-[10px] leading-[12px] font-medium text-black/85 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-text-primary"
      data-testid={testId}
    >
      <span className="truncate">{label}</span>
      <span className="flex size-[24px] shrink-0 items-center justify-center">
        <img
          className="block h-[12px] w-[8px] max-w-none"
          src={`${ICON_BASE_PATH}/main-chevron-up-down.svg`}
          alt=""
        />
      </span>
    </button>
  );
}
