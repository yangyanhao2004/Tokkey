interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Names the control for assistive tech, e.g. "Router". */
  label: string;
  /** Refuses clicks while the setting behind the switch is still settling. */
  disabled?: boolean;
  testId?: string;
}

/**
 * The binary setting switch (Figma "Switch", node 227:3552). Figma draws it as
 * a 32x20 track inside a 44x32 box: the box is the desktop hit target, so the
 * track keeps its own dimensions rather than filling it.
 */
export function Switch({ checked, onChange, label, disabled = false, testId }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="flex h-[32px] w-[44px] shrink-0 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-text-primary disabled:cursor-default"
      data-testid={testId}
    >
      <span
        className={`flex h-[20px] w-[32px] items-center rounded-full p-[2px] transition-colors ${
          checked ? 'justify-end bg-selected-ink' : 'justify-start bg-switch-track-off'
        }`}
      >
        <span className="block size-[16px] rounded-full bg-white shadow-[0px_1px_2px_0px_rgba(0,0,0,0.2)]" />
      </span>
    </button>
  );
}
