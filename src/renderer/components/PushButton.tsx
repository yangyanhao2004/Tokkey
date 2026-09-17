import type { ReactNode } from 'react';

interface PushButtonProps {
  children: ReactNode;
  /**
   * `filled` is the black primary button ("Add model", "Start", "Download");
   * `tinted` is the 5% black chip with a dark label used for secondary actions
   * on an opaque card ("Remove" on the Add Model page); `plain` carries no fill
   * and only a grey label ("Remove" on the Tokkey page); `plain-dark` is the
   * same unfilled button with a full-strength label, used where it has to hold
   * its own against a card's content ("Manage" on the Agent Hub page).
   */
  variant?: 'filled' | 'tinted' | 'plain' | 'plain-dark';
  onClick?: () => void;
  /** Dims the button while its action is still running. */
  disabled?: boolean;
  /**
   * Draws the button as its own progress track rather than a flat chip: a 5%
   * black bed under a 15% black fill, with the label at full strength over
   * both. This is the shape the design gives a button whose action is still
   * running — Figma 531:817 "Starting…", the same construction as the
   * downloading state at 531:1355 — so it replaces `variant`, and the button
   * is not dimmed on top of it: the bed already reads as unpressable.
   *
   * A share between 0 and 1. A start reports no measurable progress, so it
   * passes the fixed share the design draws rather than a measurement.
   */
  progress?: number | null;
  testId?: string;
  /** Moves keyboard focus to the primary dialog exit when it opens. */
  autoFocus?: boolean;
  /** Lets the button share a row's width evenly instead of hugging its label. */
  stretch?: boolean;
}

const VARIANT_CLASSES = {
  filled: 'bg-black text-white',
  tinted: 'bg-black/5 text-text-primary',
  plain: 'text-label-tertiary',
  'plain-dark': 'text-text-primary'
} as const;

/**
 * The small 24px push button used across the Main page (Figma "Push Button",
 * node 192:2819 and its instances).
 */
export function PushButton({
  children,
  variant = 'filled',
  onClick,
  disabled = false,
  testId,
  autoFocus = false,
  stretch = false,
  progress = null
}: PushButtonProps) {
  const isTrack = progress !== null;
  // A class, not a style attribute: the renderer's CSP forbids inline styles,
  // so index.css emits `w-[0%]`-`w-[100%]` for this to pick from.
  const fillWidthClass = `w-[${Math.round(Math.min(1, Math.max(0, progress ?? 0)) * 100)}%]`;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      autoFocus={autoFocus}
      className={`flex h-[24px] ${stretch ? 'flex-1' : 'shrink-0'} items-center justify-center rounded-[6px] px-2 text-[10px] leading-[16px] font-medium focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-text-primary ${
        isTrack
          ? 'relative overflow-hidden bg-black/5 text-text-primary'
          : `disabled:opacity-40 ${VARIANT_CLASSES[variant]}`
      }`}
      data-testid={testId}
    >
      {isTrack && (
        <span
          className={`absolute inset-y-0 left-0 bg-black/15 ${fillWidthClass}`}
          data-testid={testId ? `${testId}-fill` : undefined}
        />
      )}
      {/* Above the fill, which is painted out of flow beneath it. */}
      <span className="relative">{children}</span>
    </button>
  );
}
