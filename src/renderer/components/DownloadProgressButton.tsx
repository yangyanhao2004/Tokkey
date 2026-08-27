import type { ReactNode } from 'react';

interface DownloadProgressButtonProps {
  children: ReactNode;
  /** Share of the transfer already received, or `null` while no total is known. */
  progress: number | null;
  onClick?: () => void;
  disabled?: boolean;
  testId?: string;
}

/**
 * The push button a downloading row wears: the button itself is the progress
 * track (Figma "BG", node 227:4690 — a 5% black bed with a 15% black fill).
 * Fixed at the design's 89px so the fill measures the same distance for every
 * row and the label never shifts as the percentage grows.
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
      className="relative flex h-[24px] w-[89px] shrink-0 items-center justify-center overflow-hidden rounded-[6px] bg-black/5 text-[10px] leading-[16px] font-medium text-text-primary focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-text-primary disabled:opacity-40"
      data-testid={testId}
    >
      <span
        className={`absolute inset-y-0 left-0 bg-black/15 ${fillWidthClass}`}
        data-testid={testId ? `${testId}-fill` : undefined}
      />
      <span className="relative">{children}</span>
    </button>
  );
}
