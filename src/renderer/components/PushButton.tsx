import type { ReactNode } from 'react';

interface PushButtonProps {
  children: ReactNode;
  /**
   * `filled` is the black primary button ("Add model", "Start", "Download");
   * `tinted` is the 5% black chip with a dark label used for secondary actions
   * on an opaque card ("Remove" on the Add Model page); `plain` carries no fill
   * and only a grey label ("Remove" on the Tokiie page); `plain-dark` is the
   * same unfilled button with a full-strength label, used where it has to hold
   * its own against a card's content ("Manage" on the Agent Hub page).
   */
  variant?: 'filled' | 'tinted' | 'plain' | 'plain-dark';
  onClick?: () => void;
  /** Dims the button while its action is still running. */
  disabled?: boolean;
  testId?: string;
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
  testId
}: PushButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex h-[24px] shrink-0 items-center justify-center rounded-[6px] px-2 text-[10px] leading-[16px] font-medium focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-text-primary disabled:opacity-40 ${VARIANT_CLASSES[variant]}`}
      data-testid={testId}
    >
      {children}
    </button>
  );
}
