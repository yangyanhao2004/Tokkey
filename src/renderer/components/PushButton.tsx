import type { ReactNode } from 'react';

interface PushButtonProps {
  children: ReactNode;
  /**
   * `filled` is the black primary button ("Add model", "Start"); `plain`
   * carries no fill and only a grey label ("Remove").
   */
  variant?: 'filled' | 'plain';
  onClick?: () => void;
  testId?: string;
}

/**
 * The small 24px push button used across the Main page (Figma "Push Button",
 * node 192:2819 and its instances).
 */
export function PushButton({
  children,
  variant = 'filled',
  onClick,
  testId
}: PushButtonProps) {
  const variantClasses =
    variant === 'filled' ? 'bg-black text-white' : 'text-label-tertiary';

  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-[24px] shrink-0 items-center justify-center rounded-[6px] px-2 text-[10px] leading-[16px] font-medium focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-text-primary ${variantClasses}`}
      data-testid={testId}
    >
      {children}
    </button>
  );
}
