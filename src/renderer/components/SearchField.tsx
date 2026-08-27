import { NAV_ICON_BASE_PATH as ICON_BASE_PATH } from '../navigation';

interface SearchFieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  /** Announced to assistive tech, since the field carries no visible label. */
  label: string;
  testId?: string;
}

/**
 * The AppKit search field (Figma "Search Field"): an unfilled box outlined in
 * the card's own hairline, with the magnifier glyph on the left and a clear
 * button that appears only once something has been typed. It carries no fill so
 * it reads as a field to type into rather than as a chip to press.
 *
 * The input is transparent and unstyled so the chip owns the appearance, while
 * typing, selection and the Escape-to-clear reflex stay the platform's.
 */
export function SearchField({ value, onChange, placeholder, label, testId }: SearchFieldProps) {
  return (
    <div className="flex h-[24px] w-full items-center gap-1.5 overflow-hidden rounded-[6px] border border-surface-panel-border bg-transparent px-2 focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-text-primary">
      <img
        className="block size-[12px] shrink-0 max-w-none"
        src={`${ICON_BASE_PATH}/main-search.svg`}
        alt=""
      />

      <input
        // `select-text` opts back in: the body disables selection app-wide.
        className="min-w-0 flex-1 select-text bg-transparent text-[10px] leading-[12px] font-medium text-black/85 outline-none placeholder:font-normal placeholder:text-text-secondary"
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => event.key === 'Escape' && onChange('')}
        placeholder={placeholder}
        aria-label={label}
        spellCheck={false}
        autoComplete="off"
        data-testid={testId}
      />

      {value.length > 0 && (
        <button
          className="flex size-[12px] shrink-0 items-center justify-center"
          type="button"
          onClick={() => onChange('')}
          aria-label={`Clear ${label.toLowerCase()}`}
          data-testid={testId ? `${testId}-clear` : undefined}
        >
          <img
            className="block size-[12px] max-w-none"
            src={`${ICON_BASE_PATH}/main-search-clear.svg`}
            alt=""
          />
        </button>
      )}
    </div>
  );
}
