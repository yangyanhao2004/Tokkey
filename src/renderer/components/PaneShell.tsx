import type { ReactNode } from 'react';
import { NAV_ICON_BASE_PATH as ICON_BASE_PATH } from '../navigation';

/**
 * Back/forward pair plus the connection pill. Chrome that every pane carries,
 * so it lives with the shell rather than with one pane's content.
 */
function PaneHeader() {
  return (
    <header
      className="flex shrink-0 items-center justify-between px-6 py-3 backdrop-blur-[11.634px]"
      data-testid="pane-header"
    >
      <div className="flex h-[28px] items-center overflow-hidden rounded-full border border-black/8 bg-white/50 shadow-[0px_2.493px_9.972px_0px_rgba(0,0,0,0.05)]">
        <button
          type="button"
          className="flex h-[28px] w-[30px] items-center justify-center focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-text-primary"
          aria-label="Go back"
          title="Back"
          data-testid="nav-back"
        >
          <img
            className="block size-[14.958px] max-w-none"
            src={`${ICON_BASE_PATH}/main-nav-back.svg`}
            alt=""
          />
        </button>
        <button
          type="button"
          className="flex h-[28px] w-[30px] items-center justify-center border-l-[0.831px] border-separator focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-text-primary"
          aria-label="Go forward"
          title="Forward"
          data-testid="nav-forward"
        >
          <img
            className="block size-[14.958px] max-w-none"
            src={`${ICON_BASE_PATH}/main-nav-forward.svg`}
            alt=""
          />
        </button>
      </div>

      <span
        className="flex items-center justify-center gap-1.5 rounded-full border-[0.829px] border-pill-border bg-pill-bg px-2 py-1"
        data-testid="connection-pill"
      >
        <span className="size-[6px] shrink-0 rounded-[3px] bg-status-live" />
        <span className="text-[11px] leading-[13px] font-bold text-pill-text">Tokiie connected</span>
      </span>
    </header>
  );
}

interface PaneShellProps {
  /** Pane heading, e.g. "Tokiie". */
  title: string;
  /** Sentence under the heading. */
  subtitle: string;
  /** Identifies the pane in tests, e.g. `tokiie` renders `pane-tokiie`. */
  testId: string;
  children: ReactNode;
}

/**
 * The right-hand content pane: header, heading block, then the pane's own
 * sections. Every pane renders through this so they share one frame.
 */
export function PaneShell({ title, subtitle, testId, children }: PaneShellProps) {
  return (
    <main
      // `overflow-hidden` is load-bearing: the header's backdrop-filter is
      // promoted to its own layer, which a bare border-radius does not clip, so
      // without it the blur paints square over the pane's rounded top corners.
      className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-[20px] bg-white"
      data-testid={`pane-${testId}`}
    >
      <PaneHeader />
      <div className="flex min-h-0 flex-1 flex-col gap-4 p-6">
        <div className="flex flex-col gap-1">
          <h1 className="text-[20px] leading-[24px] font-bold text-text-primary">{title}</h1>
          <span className="text-[12px] leading-[14px] text-text-secondary">{subtitle}</span>
        </div>
        {children}
      </div>
    </main>
  );
}

/**
 * Body for panes that are navigable but not designed yet, so selecting their
 * nav row lands somewhere honest instead of on an empty frame.
 */
export function PanePlaceholder({ children }: { children: ReactNode }) {
  return (
    <p
      className="flex w-full items-center justify-center rounded-[12px] border border-surface-card-border bg-surface-card p-6 text-[12px] leading-[14px] text-text-secondary"
      data-testid="pane-placeholder"
    >
      {children}
    </p>
  );
}
