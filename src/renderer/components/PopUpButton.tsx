import { NAV_ICON_BASE_PATH as ICON_BASE_PATH } from '../navigation';

/** One entry of the menu; `value` is what `onChange` reports back. */
export interface PopUpOption {
  readonly value: string;
  readonly label: string;
}

interface PopUpButtonProps {
  /** The current selection, e.g. "All providers". */
  label: string;
  options: readonly PopUpOption[];
  /** The selected option's value; must be one of `options`. */
  value: string;
  onChange: (value: string) => void;
  testId?: string;
}

/**
 * The AppKit pop-up button (Figma "Pop-Up Button", node 121:12028): a 5% black
 * chip whose label is followed by the chevron.up.chevron.down glyph in its own
 * 24px box.
 *
 * A transparent native `<select>` covers the chip, so the menu, its keyboard
 * handling, and its accessibility all come from the platform while the chip
 * keeps the design's appearance.
 */
export function PopUpButton({ label, options, value, onChange, testId }: PopUpButtonProps) {
  return (
    <div className="relative flex h-[24px] shrink-0 items-center gap-2 overflow-hidden rounded-[6px] bg-black/5 pl-3 text-[10px] leading-[12px] font-medium text-black/85 focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-text-primary">
      <span className="truncate">{label}</span>
      <span className="flex size-[24px] shrink-0 items-center justify-center">
        <img
          className="block h-[12px] w-[8px] max-w-none"
          src={`${ICON_BASE_PATH}/main-chevron-up-down.svg`}
          alt=""
        />
      </span>

      <select
        className="absolute inset-0 size-full cursor-default appearance-none opacity-0 outline-none"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={label}
        data-testid={testId}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
