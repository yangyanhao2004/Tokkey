interface SegmentedControlOption<TValue extends string> {
  readonly value: TValue;
  readonly label: string;
}

interface SegmentedControlProps<TValue extends string> {
  options: readonly SegmentedControlOption<TValue>[];
  value: TValue;
  onChange: (value: TValue) => void;
  /** Announced to assistive tech, since the group carries no visible label. */
  label: string;
  testId?: string;
}

/**
 * The AppKit segmented control (Figma "Overlay", node 225:2262): a recessed
 * track with one raised segment marking the selection. Generic over its value
 * so the caller keeps its own union rather than passing strings around.
 */
export function SegmentedControl<TValue extends string>({
  options,
  value,
  onChange,
  label,
  testId
}: SegmentedControlProps<TValue>) {
  return (
    <div
      // `w-fit` so the track hugs its segments instead of stretching to the
      // width of whatever column it is dropped into.
      className="flex h-[24px] w-fit shrink-0 items-stretch rounded-[6px] bg-fill-tile"
      role="tablist"
      aria-label={label}
      data-testid={testId}
    >
      {options.map((option) => {
        const isSelected = option.value === value;

        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={isSelected}
            onClick={() => onChange(option.value)}
            className={`flex min-w-[43.213px] items-center justify-center rounded-[6px] px-3 py-1 text-[10px] leading-[12px] font-medium focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-text-primary ${
              isSelected
                ? 'bg-text-primary text-white drop-shadow-[0px_0.831px_1.247px_rgba(0,0,0,0.12)]'
                : 'text-text-secondary'
            }`}
            data-testid={testId ? `${testId}-${option.value}` : undefined}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
