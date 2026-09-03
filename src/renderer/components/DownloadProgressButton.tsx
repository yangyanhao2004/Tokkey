import type { ReactNode } from 'react';
import { NAV_ICON_BASE_PATH } from '../navigation';

interface DownloadProgressButtonProps {
  children: ReactNode;
  /** Share of the transfer already received, or `null` while no total is known. */
  progress: number | null;
  onClick?: () => void;
  disabled?: boolean;
  testId?: string;
}

/**
 * The push button a downloading row wears (Figma 531:1355): the button itself
 * is the progress track — a 5% black bed under a 15% black fill — behind an "×"
 * and the label. Fixed at the design's 104px so the fill measures the same
 * distance for every row and the label never shifts as the percentage grows.
 *
 * The "×" marks what a press does, but the whole button is the target: the
 * design's own bed spans it, and a 7px glyph is a poor thing to have to hit.
 */
export function DownloadProgressButton({
  children,
  progress,
  onClick,
  disabled = false,
  testId
}: DownloadProgressButtonProps) {
  // A class, not a style attribute: the renderer's CSP forbids inline styles,
  // so index.css emits `w-[0%]`-`w-[100%]` for this to pick from.
  const fillWidthClass = `w-[${Math.round(Math.min(1, Math.max(0, progress ?? 0)) * 100)}%]`;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="relative flex h-[24px] w-[104px] shrink-0 items-center justify-center gap-1 overflow-hidden rounded-[6px] bg-black/5 px-2 text-[10px] leading-[16px] font-medium text-text-primary focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-text-primary disabled:opacity-40"
      data-testid={testId}
    >
      <span
        className={`absolute inset-y-0 left-0 bg-black/15 ${fillWidthClass}`}
        data-testid={testId ? `${testId}-fill` : undefined}
      />
      <img
        className="relative block h-[16px] w-[11px] shrink-0 max-w-none"
        src={`${NAV_ICON_BASE_PATH}/main-download-cancel.svg`}
        alt=""
      />
      <span className="relative">{children}</span>
    </button>
  );
}
